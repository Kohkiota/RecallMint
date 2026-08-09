import 'server-only'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import Stripe from 'stripe'
import { getNonTenantDb, type DB } from '@/lib/db'
import { withTenantTx, setTenantContext } from '@/lib/db/tenant-tx'
import {
  users,
  exams,
  studyDays,
  contactMessages,
  aiUsageUsers,
  uploadRecords,
  userSettings,
  studySessions,
  tombstones,
  entityMutations,
  tagCategories,
  assets,
} from '@/lib/db/schema'
import { stripe, cancelWithRetry } from '@/lib/stripe/client'
import { notifyOps } from '@/lib/ops'
import {
  recordIntegrationFailure,
  type IntegrationFailureKey,
} from '@/lib/integration-failures'
import { syncClerkPublicMetadata } from '@/lib/auth/clerk-metadata'
import { runtimeEnv } from '@/lib/env/runtime-env'
import { logger } from '@/lib/logger'
// 既定 timeout は写さず import する — 写すと r2.ts 側が変わったときに silent に
// 誤る (min の相手が古い値になる) し、LIST / DELETE の片方だけ変わった場合に気付けない。
import {
  listObjectsBounded,
  deleteObject,
  LIST_TIMEOUT_MS,
  DELETE_TIMEOUT_MS,
} from '@/lib/storage/r2'
import { type ClerkWebhookEvent } from '@/lib/validation/clerk-webhook'

// cancel 対象 status。canceled / incomplete* / unpaid / paused は skip。
const CANCEL_TARGETS = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
])

// ②-4b §2 (spec 2026-08-09 §3.2): 退会時の `src/{userId}/` prefix purge の予算。
//
// 予算は「守るべき境界と同じ原点」から測る。守る対象は route 全体の maxDuration: 60
// (vercel.json) なので原点は POST() 冒頭 = handlerStart 引数で伝播する。purge 開始
// からの相対予算では先行処理 (Svix 検証 / dedup INSERT / Stripe ループ / DB tx) が
// 何秒使ったかを考慮できず「全体を圧迫しない」を保証できない。
const HANDLER_BUDGET_MS = 50_000 // route の maxDuration: 60 に 10s の余裕
const SRC_PURGE_BUDGET_MS = 20_000 // purge 単体の上限 (handler 予算との min を取る)
const SRC_PURGE_MAX_LIST_PAGES = 2 // 1 page ≈ 最大 1000 key。実運用の staging 数本を桁で上回る
const SRC_PURGE_DELETE_CHUNK = 20 // chunk 並列。chunk ごとに deadline を確認して打ち切れる粒度
const SRC_PURGE_MIN_SLICE_MS = 2_000 // floor。残予算がこれ未満なら I/O を開始しない
const SRC_PURGE_TAIL_RESERVE_MS = 4_000 // 最終 incomplete 行を書くための先取り分
const SRC_PURGE_MAX_FAILURE_ROWS = 20 // 台帳の暴走防止 (§3.3)

// incomplete 行の phase (§3.3)。複数該当時は「より早い段階で諦めた事実」を残すため
// この配列順 (= 優先順位) で高い方を採る。行は 1 本に統合する。
const SRC_PURGE_PHASES = ['list', 'no_budget', 'list_truncated', 'deadline'] as const
type SrcPurgePhase = (typeof SRC_PURGE_PHASES)[number]

// 1 件 = 1 object の DELETE 失敗。status: null は fetch throw / timeout
// (deleteObject は never-throw ゆえ例外オブジェクトが無い = errorMessage も無い。
// この行に errorMessage を付けると status===null の意味が壊れる・§3.3)。
// `reason` は DELETE を試行**していない**行の discriminator — 集計/alert が
// errorMessage の free text を parse せずに除外できるよう構造化して持たせる。
type SrcPurgeFailure = {
  objectKey: string
  status: number | null
  reason?: 'prefix_mismatch'
}

export async function handleEvent(
  evt: ClerkWebhookEvent,
  handlerStart: number,
): Promise<void> {
  if (evt.type === 'user.created') {
    const data = evt.data
    const email = data.email_addresses?.[0]?.email_address ?? 'unknown@example.com'
    // RLS-P2 (spec §2.5): 事前採番 UUID を id に固定し、単一 withTenantTx (context=新 uuid)
    // 内で存在チェック → 不在なら INSERT。RETURNING / onConflictDoNothing は使わない
    // (RLS-on 後は RETURNING が policy と干渉しうるため、新規判定を bootstrap 関数の
    // 存在チェックに委ねる)。bootstrap 関数は SECURITY DEFINER (RLS 迂回) ゆえ context
    // 非依存に clerk_id で既存を検出する。
    //
    // 新規判定 = 存在チェックが 0 行。既存 (webhook re-fire 等で users 行が先に存在) は
    // INSERT せず metadata sync も skip — 既存 metadata の plan 値を 'free' に上書きする
    // race を防ぐ。同 clerk_id の並行 created (存在チェックすり抜け) は clerk_id UNIQUE
    // 制約が INSERT で throw → webhook route の outer catch が 200 + 通知で吸収 (spec §2.5)。
    // 復旧経路: skip path で metadata が欠落した user は (a) 次の user 由来 webhook で
    // publicMetadata.plan が補填、 (b) getAuthContext() の getCurrentUser() fallback、
    // の 2 段で degraded mode を吸収する。
    const newUserId = randomUUID()
    const created = await withTenantTx(newUserId, async (tx) => {
      const existing = await tx.execute<{ id: string }>(
        sql`SELECT id FROM public.app_bootstrap_user_from_clerk(${data.id})`,
      )
      if (existing[0]) return false // 既存 → INSERT / sync skip
      await tx.insert(users).values({ id: newUserId, clerkId: data.id, email })
      return true
    })
    // metadata sync は外部 I/O (Clerk API) ゆえ tx 外。新規作成時のみ (既存 gate 条件と同値)。
    if (created) {
      await syncClerkPublicMetadata({
        clerkId: data.id,
        dbUserId: newUserId,
        plan: 'free',
      })
    }
    return
  }
  if (evt.type === 'user.deleted') {
    await handleUserDeleted(evt.data.id, handlerStart)
    return
  }
  // 上の if 群で全 discriminated variant を扱い切る。 schema 拡張時はここに到達せず
  // narrow が cover する (型 exhaustive)。
}

async function handleUserDeleted(
  clerkUserId: string,
  handlerStart: number,
): Promise<void> {
  // RLS-P3 (Task 1): pre-tenant bootstrap resolve — app_bootstrap_user_from_clerk
  // (SECURITY DEFINER) は内部 user id を context 確立前に解決するため非 tenant handle
  // を使う (以降 runTransactionWithRetry 内で setTenantContext が tenant context を張る)。
  const db = getNonTenantDb()

  // §6 / RLS-P2 (spec §2.6): resolve internal id + Stripe customer via the
  // SECURITY DEFINER bootstrap 関数 (clerk_id で 1 行・scrub 済みは clerk_id NULL ゆえ
  // 0 行)。SELECT-first のまま (UPDATE-RETURNING でなく) なので Stripe cancel を DB
  // transaction 前に走らせられ、resolve 不能 (0 行) を effect なしで検出できる。
  // 手マッピングは snake_case 2 列のみ (stripe_customer_id キー名に注意)。
  const rows = await db.execute<{ id: string; stripe_customer_id: string | null }>(
    sql`SELECT id, stripe_customer_id FROM public.app_bootstrap_user_from_clerk(${clerkUserId})`,
  )
  const internalUserId = rows[0]?.id
  const customerId = rows[0]?.stripe_customer_id ?? null

  // F-5 fix-up (review M-1) / RLS-P2 §2.6: bootstrap 0 行 = internalUserId 未解決。
  // 原因は user.created 未到達の順序逆転、または既に scrub 済 (clerk_id NULL 化) の
  // 2 通りがあり、データ上は判別できない (両者とも clerk_id で引けない) ため文言を
  // 中立化する。silent skip させず notifyOps で観測性を確保し、OT が異常を検知できる
  // ようにする点は不変。
  if (!internalUserId) {
    await notifyOps(
      'user.deleted received but users row not found (not-synced or already-deleted)',
      {
        clerkUserId,
        environment: runtimeEnv(),
        timestamp: new Date().toISOString(),
      },
    )
    return
  }

  // ②-4b §2 (spec §3.1): 退会 prefix purge (D) の到達保証を **構造** で作る。
  // B / C はいずれも throw しうる — recordFailure → recordIntegrationFailure が
  // notifyOps の production fail-fast throw を意図的に伝播させる契約のため
  // (lib/integration-failures.ts)。「C の後ろに置けば必ず走る」は現物で不成立で、
  // 後置は「今この瞬間 throw する site が無い」ことに依存し、record site が増える
  // たびに全 site を監査し続ける保証になる (単一点主張が無言で偽になる型)。
  try {
    // §6: customerId があれば Stripe sub cancel ループを実行する
    // (transaction 外。Stripe 失敗が記録されても DB transaction は forward-only で実行)。
    // customerId なし = Free プラン user → Stripe ループを skip して transaction へ進む。
    if (customerId) {
      // canceledIds と offset を function スコープで保持し、list 失敗時の
      // error_message に詰める (admin が Stripe Dashboard で残 sub を grep するため)
      const canceledIds: string[] = []
      let offset = 0
      try {
        for await (const sub of stripe.subscriptions.list({
          customer: customerId,
          status: 'all',
        })) {
          offset++
          if (!CANCEL_TARGETS.has(sub.status)) continue
          try {
            await cancelWithRetry(sub.id)
            canceledIds.push(sub.id)
          } catch (err) {
            await recordFailure({
              internalUserId,
              clerkUserId,
              subId: sub.id,
              kind: 'cancel',
              errorMessage: String(err),
            })
          }
        }
      } catch (err) {
        const kind = isCustomerMissing(err) ? 'customer_missing' : 'list'
        const errorMessage =
          kind === 'list'
            ? `page fetch failed at offset ${offset}: ${String(err)}. Canceled before failure: [${canceledIds.join(', ')}]`
            : String(err)
        await recordFailure({
          internalUserId,
          clerkUserId,
          subId: null,
          kind,
          errorMessage,
        })
      }
    }

    // §6 / T3: DB transaction — users の soft delete + GDPR PII scrub + ユーザー
    // 紐付き子テーブルの物理削除 (10 件) + assets の soft-delete (deleting UPDATE, 1 件)。
    //
    // 削除設計の集約コメント (なぜここに Group I 11 テーブルを明示処理するか):
    // - users は soft delete (deleted_at set + email/clerk_id scrub) で物理削除しない
    //   ため、 users.id への FK ON DELETE CASCADE は発火しない。
    // - **Group I (handler 明示処理必須、 = 本ブロックの 11 件)**: direct user_id FK で
    //   users に cascade するテーブルのうち、 親 cascade chain がないもの。 うち 10 件は
    //   物理 DELETE、 assets のみ soft-delete (deleting UPDATE = 唯一の例外・下記)。
    //     exams / study_days / contact_messages / ai_usage_users / upload_records /
    //     user_settings / study_sessions / tombstones / entity_mutations / tag_categories /
    //     assets
    //   (study_sessions は exam_id が set null = 非経路、 user_id のみが削除 path)
    //   (assets は Group I だが唯一の soft-delete 例外 = 物理 DELETE せず status='deleting'
    //    へ UPDATE する。 理由 = R2 object への手掛かり (object_key) を保全し、 GC reconciler
    //    の優先 sweep (deletion 由来 = grace 非適用) に R2 実体 + 行の物理回収を委ねるため
    //    (spec §4.8)。 取得権限は deleting 遷移の瞬間に失効する (resolve/handleImages の
    //    ready-gate = allowsNewReference は ready のみ許可)。 同 tx の exams DELETE cascade で
    //    子 cards→card_asset_refs が消えるため、 これらの asset は「参照ゼロ + deleting」となり
    //    reconciler collect が回収する。 row と object の物理削除は別レイヤー (decouple 規律))
    //   (entity_mutations は S-sync-1 で entity_id FK を撤廃したため、 旧 card_mutations の
    //    時にあった cards cascade chain がなくなり、 Group I に昇格)
    //   (tag_categories は Tag-1 で新設、 試験横断 master のため親 chain なし → Group I)
    // - **Group II (明示 DELETE しない、 親 cascade chain で連鎖)**: cards / source_documents
    //   は exam_id cascade で exams DELETE 時に連鎖、 reviews / answer_events は cards
    //   cascade (= exams chain) で連鎖、 tag_options は category_id cascade で tag_categories
    //   経由で連鎖、 card_tags は card_id / option_id の双方 cascade で連鎖。 ここに二重に書かない。
    // - 網羅性は invariant test (route.test.ts の「Group I − soft-delete 例外 (assets) が
    //   handler の明示 DELETE 集合と一致」 検証) が保証。 schema に user_id direct FK の
    //   新テーブルを追加すると invariant test が落ちて気づける (assets 以外は依然明示
    //   DELETE 必須 = soft-delete は assets のみの例外)。
    //
    // GDPR PII scrub: users 行は audit / correlation のため残置するが、 PII 列
    // (email, clerk_id) を NULL に上書きする。 stripe_customer_id は cus_xxx 単体で
    // 個人特定不能なため correlation key として保持。 NULL 上書きは値レベルで冪等、
    // webhook 再送は上位の clerk_events.event_id dedup で 1 回に絞られる。
    //
    // T3: transient DB error (deadlock / serialization / connection 切断) に対し最大 3 retry。
    // permanent error (整合性違反等) は即中断。両者とも最終失敗時は recordFailure(data_deletion)。
    //
    // 削除順序: Group I は互いに FK 依存なし (全 table が direct user_id FK のみ) なので
    // 任意。 Group II は exams DELETE 時点で同 transaction 内 cascade chain により連鎖
    // 削除される (実行順序は PG が constraint check に従って決定、 ここでの記述順は
    // パフォーマンス heuristic のみ、 正当性に依存しない)。
    await runTransactionWithRetry(
      db,
      async (tx) => {
        // RLS-P2: 冒頭で tenant context を張る。app_scrub_deleted_user の自衛検査が
        // app.user_id と p_user_id の一致を要求するため必須・かつ RLS-on 後は Group I
        // DELETE の owner scope をこの GUC が担う。retry の各試行で再実行される
        // (SET LOCAL は前 tx の ROLLBACK で消えるため、試行ごとの再設定が正しい)。
        await setTenantContext(tx, internalUserId)
        // GDPR PII scrub (deleted_at=now(), email/clerk_id NULL) は現行 inline UPDATE を
        // app_scrub_deleted_user (SECURITY DEFINER・context 自衛検査付き) へ移植したもの。
        // stripe_customer_id は関数側で保持 (correlation key)。値レベル冪等 + 0 行 no-op ゆえ
        // retry / 再送安全。
        await tx.execute(sql`SELECT public.app_scrub_deleted_user(${internalUserId})`)
        await tx.delete(exams).where(eq(exams.userId, internalUserId))
        await tx.delete(studyDays).where(eq(studyDays.userId, internalUserId))
        await tx.delete(contactMessages).where(eq(contactMessages.userId, internalUserId))
        await tx.delete(aiUsageUsers).where(eq(aiUsageUsers.userId, internalUserId))
        await tx.delete(uploadRecords).where(eq(uploadRecords.userId, internalUserId))
        await tx.delete(userSettings).where(eq(userSettings.userId, internalUserId))
        await tx.delete(studySessions).where(eq(studySessions.userId, internalUserId))
        await tx.delete(tombstones).where(eq(tombstones.userId, internalUserId))
        await tx.delete(entityMutations).where(eq(entityMutations.userId, internalUserId))
        await tx.delete(tagCategories).where(eq(tagCategories.userId, internalUserId))
        // assets は物理 DELETE でなく 'deleting' へ soft-delete (Group I 唯一の例外・spec §4.8)。
        // 'deleting' は G2 asset-state (lib/media/domain/asset-state.ts) の AssetStatus 語彙。
        // R2 object への手掛かり (object_key) を保全し、 GC reconciler の優先 sweep lane に
        // R2 実体 + 行の物理回収を委ねる。 取得権限は deleting で失効 (ready-gate)。
        // self-heal (deleting → ready 戻し) は起き得ない: 参照発生源 (この user の cards) が
        // 同 tx の exams DELETE cascade で全滅 + 認証も失効するため refs が再出現しない。
        // owner-scope (eq(userId)) 維持。
        await tx
          .update(assets)
          .set({ status: 'deleting' })
          .where(eq(assets.userId, internalUserId))
      },
      async (errorMessage) => {
        await recordFailure({
          internalUserId,
          clerkUserId,
          subId: null,
          kind: 'data_deletion',
          errorMessage,
        })
      },
    )
  } finally {
    // D: R2 `src/{internalUserId}/` の即時 purge。台帳 (source_assets 表) が無く
    // key 規約でしか辿れない source は、その場で消すか lifecycle に頼るかしかない
    // ため即時性が要る (assets レーンとの非対称の理由 = spec §7.1)。
    const purgeStart = Date.now()
    await purgeSourcePrefix(
      internalUserId,
      Math.min(purgeStart + SRC_PURGE_BUDGET_MS, handlerStart + HANDLER_BUDGET_MS),
    )
  }
}

/**
 * ②-4b §2 (spec §3.2): 退会時に R2 の `src/{internalUserId}/` prefix を一括削除する。
 *
 * **この関数は throw しない契約** (不変条件 1)。外周 finally から呼ぶため、ここで
 * throw すると B / C の元例外を握り潰して route の outer catch を汚す。大域 try/catch
 * に加えて**各記帳呼出も個別に try/catch** する (不変条件 7 — 観測の失敗が削除の
 * forward progress を止めない)。
 *
 * `clerkUserId` は受け取らない: 台帳 context は Discord へもそのまま出るため PII を
 * 最小化する (§3.3)。`now` は時刻注入 — 実 sleep なしで打ち切りを test するため。
 *
 * 成功が意味するのは「prefix が空になった」ではなく「**列挙済み key への削除要求が
 * 完了した**」まで (readback しない・§7)。
 */
export async function purgeSourcePrefix(
  internalUserId: string,
  purgeDeadline: number,
  now: () => number = Date.now,
): Promise<void> {
  // 末尾スラッシュ必須 — `src/{uid}` だと別 uuid の前方一致を拾いうる (§3.2)。
  const prefix = `src/${internalUserId}/`
  // 打ち切りの事実そのもの (incomplete 行) を書けない事態を避けるため、作業 deadline
  // は tail reserve を先取りする。
  const workDeadline = purgeDeadline - SRC_PURGE_TAIL_RESERVE_MS
  const slice = () => workDeadline - now()
  // in-flight I/O には min(既定 timeout, 残予算) を渡す (§3.2)。「残予算 ≥ 最大所要の
  // ときだけ開始する」gate 方式は最大 10s 分の予算を未使用で捨てるため採らない。
  // DELETE は 1 回の呼出ごとに再計算するので多重化しない。
  const budgetedTimeoutMs = (defaultMs: number) => Math.min(defaultMs, slice())
  // listing だけは **1 page あたりの取り分**へ割る: listObjectsBounded の timeoutMs は
  // page ごとに AbortSignal.timeout へ適用される (listing 全体の上限ではない) ため、
  // 残予算をそのまま渡すと最悪 maxPages 倍かかり workDeadline を超える — tail reserve
  // ごと食い潰して打ち切りの incomplete 行すら書けなくなる。maxPages × 取り分 ≤ 残予算
  // で全体の最悪値が閉じる。
  const listPageTimeoutMs = () =>
    Math.min(LIST_TIMEOUT_MS, Math.floor(slice() / SRC_PURGE_MAX_LIST_PAGES))

  let phase: SrcPurgePhase | null = null
  let listErrorMessage: string | undefined
  let deleteRequested = 0
  let remaining = 0
  let writtenRows = 0
  let suppressedFailures = 0
  // 20 件目の失敗行は「21 件目が来るか」が確定するまで保持する: 21 件以上なら個別行は
  // 19 行までで、20 行目の枠は incomplete 行が使う (§3.3)。
  let heldFailure: SrcPurgeFailure | null = null

  const writeDeleteRow = async (failure: SrcPurgeFailure) => {
    await recordSrcPurgeRow({
      key: 'r2_deletion_src_delete',
      subject: 'user deletion: source PDF delete failed',
      userId: internalUserId,
      context: {
        userId: internalUserId,
        objectKey: failure.objectKey,
        status: failure.status,
        ...(failure.reason ? { reason: failure.reason } : {}),
      },
    })
    // 記帳が失敗しても在庫枠は消費した扱いにする (recordSrcPurgeRow は never-throw)。
    writtenRows++
  }

  try {
    if (slice() < SRC_PURGE_MIN_SLICE_MS) {
      phase = 'no_budget'
    } else {
      let keys: string[] = []
      try {
        const listed = await listObjectsBounded(prefix, SRC_PURGE_MAX_LIST_PAGES, {
          timeoutMs: listPageTimeoutMs(),
        })
        keys = listed.keys
        if (listed.truncated) phase = higherPriorityPhase(phase, 'list_truncated')
      } catch (err) {
        // listing の throw は 1 行にして飲む (listObjectsBounded は never-throw ではない)。
        // 文言が `listObjects: …` と呼んでいない関数名を名乗るのは、bounded 切り出し
        // (Task 1) が既存 throw 文言を byte 一致で保持したため (既存 test が regex で pin)。
        phase = higherPriorityPhase(phase, 'list')
        listErrorMessage = String(err)
      }

      remaining = keys.length
      for (let i = 0; i < keys.length; i += SRC_PURGE_DELETE_CHUNK) {
        if (slice() < SRC_PURGE_MIN_SLICE_MS) {
          phase = higherPriorityPhase(phase, 'deadline')
          break
        }
        const chunk = keys.slice(i, i + SRC_PURGE_DELETE_CHUNK)
        const timeoutMs = budgetedTimeoutMs(DELETE_TIMEOUT_MS)
        const failures = await Promise.all(
          chunk.map(async (objectKey): Promise<SrcPurgeFailure | null> => {
            // 破壊境界の二重関門 (不変条件 8): listing 応答を全面的には信用せず、DELETE
            // 直前に prefix を再検証する。不一致 key は**削除せず**記録だけする
            // (先例 = scripts/gc-src-prefix.ts の SRC_KEY_PATTERN 照合)。
            if (!objectKey.startsWith(prefix)) {
              return { objectKey, status: null, reason: 'prefix_mismatch' }
            }
            deleteRequested++
            const res = await deleteObject(objectKey, { timeoutMs })
            return res.ok ? null : { objectKey, status: res.status }
          }),
        )
        remaining -= chunk.length
        for (const failure of failures) {
          if (!failure) continue
          if (writtenRows >= SRC_PURGE_MAX_FAILURE_ROWS - 1) {
            if (heldFailure === null) heldFailure = failure
            else suppressedFailures++
            continue
          }
          if (slice() < SRC_PURGE_MIN_SLICE_MS) {
            // 残予算が尽きたら個別行の書き込みを止め、書けなかった件数を counter に足す。
            phase = higherPriorityPhase(phase, 'deadline')
            suppressedFailures++
            continue
          }
          await writeDeleteRow(failure)
        }
      }
    }

    if (heldFailure) {
      if (phase === null && suppressedFailures === 0) {
        // incomplete 行を書かない = 20 行目の枠が空く → 保持した 20 件目を個別行で書く。
        await writeDeleteRow(heldFailure)
      } else {
        suppressedFailures++
      }
    }

    // incomplete 行は 1 回の退会につき最大 1 行 (§3.3)。phase が複数該当しても
    // 優先順位で 1 本に統合し、suppressedFailures もこの行に載せる — ゆえに
    // list_truncated も含め**最後に**書く (途中で書くと後続の deadline を統合できない)。
    if (phase !== null || suppressedFailures > 0) {
      await recordSrcPurgeRow({
        key: 'r2_deletion_src_incomplete',
        subject: 'user deletion: source prefix purge incomplete',
        userId: internalUserId,
        context: {
          userId: internalUserId,
          ...(phase !== null ? { phase } : {}),
          deleteRequested,
          remaining,
          ...(suppressedFailures > 0 ? { suppressedFailures } : {}),
        },
        errorMessage: listErrorMessage,
      })
    }
  } catch (err) {
    logger.error({ event: 'clerk.user_deleted.src_purge_failed', err })
  }
}

// 「より早い段階で諦めた事実を残す」= 配列の前にあるものを優先する (§3.3)。
function higherPriorityPhase(
  current: SrcPurgePhase | null,
  next: SrcPurgePhase,
): SrcPurgePhase {
  if (current === null) return next
  return SRC_PURGE_PHASES.indexOf(next) < SRC_PURGE_PHASES.indexOf(current)
    ? next
    : current
}

// 記帳 1 本ごとに独立の try/catch (不変条件 7)。recordIntegrationFailure は notifyOps の
// production fail-fast throw を伝播するため、大域 catch だけだと 1 本の記帳失敗が以降の
// 削除まで巻き込む。deleteSourceKeys (upload-pipeline.ts) と同じ idiom。
async function recordSrcPurgeRow(args: {
  key: Extract<IntegrationFailureKey, `r2_deletion_src_${string}`>
  subject: string
  userId: string
  context: Record<string, unknown>
  errorMessage?: string
}): Promise<void> {
  try {
    await recordIntegrationFailure({
      key: args.key,
      userId: args.userId,
      subject: args.subject,
      context: args.context,
      errorMessage: args.errorMessage,
    })
  } catch (err) {
    logger.error({
      event: 'clerk.user_deleted.src_purge_record_failed',
      key: args.key,
      err,
    })
  }
}

// Sprint 2 §6 site 4: 削除フローの失敗を integration_failures 台帳 (真実) に記録し
// つつ Discord へ通知する。旧 recordFailure (廃止した専用 audit table への直書き) を
// recordIntegrationFailure helper 呼び出しに置換した。
//
// 旧 kind → catalog key の写像 (§5): cancel→deletion_cancel / list→deletion_list /
// customer_missing→deletion_customer_missing / data_deletion→deletion_data。
// 4 軸値は catalog から引かれる (呼び出し側は 4 軸を自由文字列で渡さない)。
//
// Discord は byte 不変: subject 2 分岐 (data_deletion → 'user data deletion failure' /
// それ以外 → 'stripe sub cancel failure during deletion') と context (旧 kind 文字列を
// 含む) を verbatim で helper に渡す。context の kind は catalog key ではなく旧 kind 値
// を保持し、既存 Discord payload を一切変えない。
const KIND_TO_KEY: Record<
  'list' | 'cancel' | 'customer_missing' | 'data_deletion',
  IntegrationFailureKey
> = {
  cancel: 'deletion_cancel',
  list: 'deletion_list',
  customer_missing: 'deletion_customer_missing',
  data_deletion: 'deletion_data',
}

async function recordFailure(args: {
  internalUserId: string
  clerkUserId: string
  subId: string | null
  kind: 'list' | 'cancel' | 'customer_missing' | 'data_deletion'
  errorMessage: string
}): Promise<void> {
  // Phase 1 E-3 spec: subject が webhook error と異なる (削除フロー専用) ため
  // notifyWebhookError には乗せず、environment + timestamp を inline 注入して
  // payload baseline を揃える (byte 不変)。
  const subject =
    args.kind === 'data_deletion'
      ? 'user data deletion failure'
      : 'stripe sub cancel failure during deletion'
  await recordIntegrationFailure({
    key: KIND_TO_KEY[args.kind],
    userId: args.internalUserId,
    clerkId: args.clerkUserId,
    stripeSubscriptionId: args.subId ?? undefined,
    errorMessage: args.errorMessage,
    subject,
    context: {
      userId: args.internalUserId,
      clerkId: args.clerkUserId,
      subId: args.subId,
      kind: args.kind,
      error: args.errorMessage,
      environment: runtimeEnv(),
      timestamp: new Date().toISOString(),
    },
  })
}

// customer 削除済み判定。Stripe SDK の error code で narrow。
function isCustomerMissing(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeInvalidRequestError &&
    err.code === 'resource_missing'
  )
}

// §6 / T3: transient DB error 判定 (postgres-js / pg SQLSTATE ベース)。
// transient = 再試行で回復しうるエラー (deadlock / serialization / connection 切断など)。
// permanent = 整合性違反 (23xxx 等) は retry しても無意味なので即中断。
// lib/ai/ocr.ts の isTransientError と同じ「local 非 export 関数」思想で実装。
function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (!code) {
    // code を持たない error = connection 切断系とみなして transient 扱い。
    // pg driver が code を付けない場合があるため、code 不在 = transient が安全側。
    return true
  }
  return (
    code === '40001' || // serialization failure
    code === '40P01' || // deadlock detected
    code.startsWith('08') || // connection exception class
    code === '57P01' || // admin shutdown
    code === '57P02' || // crash shutdown
    code === '57P03'   // cannot connect now
  )
}

// §6 / T3: DB transaction を最大 3 retry (= 合計 4 試行) でラップする local 関数。
// transient error (isTransientDbError=true) のときのみ retry、permanent は即中断。
// backoff: retry1 前 500ms / retry2 前 1000ms / retry3 前 2000ms (ocr.ts callWithRetry と同値構造)。
// transaction は idempotent (setTenantContext の SET LOCAL 再設定 + app_scrub_deleted_user
// (deleted_at/email/clerk_id を値レベル冪等に上書き・0 行 no-op) / DELETE WHERE は再実行安全)
// なので retry 安全。
// Stripe cancel ループと recordFailure 本体はこの wrap 対象外。
const MAX_DB_RETRIES = 3 // 初回 + 3 retries = 合計 4 試行

async function runTransactionWithRetry(
  db: DB,
  fn: Parameters<DB['transaction']>[0],
  onFailure: (errorMessage: string) => Promise<void>,
): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_DB_RETRIES; attempt++) {
    try {
      await db.transaction(fn)
      return // 成功
    } catch (err) {
      lastErr = err
      const isTransient = isTransientDbError(err)
      if (!isTransient || attempt === MAX_DB_RETRIES) {
        // permanent error または retry 上限到達 → failure を記録して終了
        const totalAttempts = attempt + 1
        const code = (err as { code?: string } | null)?.code
        const diagnosis = code
          ? `pg error code ${code}: ${String(err)}`
          : String(err)
        await onFailure(
          `data deletion failed after ${totalAttempts} attempt${totalAttempts === 1 ? '' : 's'} (${attempt} ${attempt === 1 ? 'retry' : 'retries'}): ${diagnosis}`,
        )
        return
      }
      const backoffMs = 500 * Math.pow(2, attempt) // 500 / 1000 / 2000
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  // ここには到達しないが TypeScript の exhaustiveness 対応
  throw lastErr
}
