import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'

import { assets } from '@/lib/db/schema'
import { withTenantTx } from '@/lib/db/tenant-tx'
import {
  recordIntegrationFailure,
  type IntegrationFailureKey,
} from '@/lib/integration-failures'
import { logger } from '@/lib/logger'
import { hasLiveUploadOperationForSweep } from './live-upload-check'
// 既定 timeout は写さず import する — 写すと r2.ts 側が変わったときに silent に
// 誤る(min の相手が古い値になる)。src-sweep.ts と同根拠。
import {
  listObjectsWithMetaBounded,
  deleteObject,
  LIST_TIMEOUT_MS,
  DELETE_TIMEOUT_MS,
  type R2ObjectMeta,
} from './r2'

// asset レーン整合 sprint `asset_orphan_scan` lane(spec §4:
// docs/superpowers/specs/2026-08-10-asset-lane-gc-design.md)。`users/` prefix
// listing → 三重条件(key 規約 + age + live)+ 行不在確認 → DELETE。
//
// src-sweep.ts(`src/` age-based sweeper)と構造は同型(前半 = 選定 pure 関数 / 後半 =
// lane orchestration)だが判定原理が逆転する(spec §4.1): `src/` は全 object が
// 消してよい前提(ephemeral・age だけが判定材料)なのに対し、asset prefix は
// 「**行が正の判定材料**」— 行がある object は参照中でありうる正当データで絶対に
// 触らない。長命レーンゆえ回収を急ぐ理由が無く、判定はすべて保守側に倒す(cutoff
// 7 日 = src の 6h の ~28 倍)。overdue alert(src の ALERT_AGE_MS 相当)は本 lane に
// 無い(spec §4 に記載なし・§11 の「期限・滞留の検知」は本 lane 自身の rowless 発見が
// 担う)。

// 候補化する age 閾値(spec §4.2): crop PUT→INSERT の実測窓(≤720s)/ lease TTL(15分)の
// ~670 倍。長命レーンで急ぐ理由が無く、crash した prepare の残骸は待っても失うものが
// 無い garbage のため大きく取る。
export const ORPHAN_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000

// 行不在確認の batch size(spec §4.2 B-5): SQL parameter 上限 / statement size を
// 超えないための分割単位。
export const ORPHAN_ROW_CHECK_BATCH = 500

// 削除候補の key 規約(spec §4.2): `users/{uuid}/{uuid}.(webp|png|jpg)`。uuid 2
// セグメントは z.uuid({version:'v4'}) で判定する(src-sweep.ts の matchSrcKeyUserId
// と同じ判断・local 定義踏襲 — 共有 util 化は 2 箇所目で rule of three 未満のため
// scope 外)。拡張子と `users/` prefix は生成側が固定文字列で埋め込む(server 生成・
// 大文字化されない)ため case-sensitive のまま(`.WEBP` は不一致)。uuid セグメントは
// client 供給の uuid 由来で大文字を含みうるため case-insensitive。
const uuidV4Schema = z.uuid({ version: 'v4' })
const ORPHAN_KEY_PATTERN = /^users\/([^/]+)\/([^/]+)\.(webp|png|jpg)$/

/**
 * key が `users/{uuid}/{uuid}.(webp|png|jpg)` 規約に一致するか判定し、一致すれば
 * userId(1 セグメント目)を返す。不一致は null。
 */
function matchOrphanKeyUserId(key: string): string | null {
  const match = ORPHAN_KEY_PATTERN.exec(key)
  if (!match) return null
  const [, userId, assetId] = match
  if (!uuidV4Schema.safeParse(userId).success || !uuidV4Schema.safeParse(assetId).success) {
    return null
  }
  return userId
}

export type OrphanSelection = {
  // oldest 昇順(deadline 打ち切り時に最古候補を優先・src-sweep と同じ理由)
  candidates: { userId: string; keys: string[]; oldestMs: number }[]
  patternMismatch: string[] // age > cutoff だが key 規約非一致(削除しない・記録のみ)
}

/**
 * listing snapshot から選定を計算する pure 関数(spec §4.2)。
 *
 * - candidates: age > ORPHAN_CUTOFF_MS かつ key 規約一致の object を userId で
 *   グルーピング(行不在確認は行わない — lane orchestration 側の責務)
 * - patternMismatch: age > ORPHAN_CUTOFF_MS だが key 規約不一致(削除しない・
 *   記録のみ・`gc-src-prefix.ts` 等の領分)
 */
export function selectOrphanCandidates(
  entries: R2ObjectMeta[],
  nowMs: number,
): OrphanSelection {
  const candidatesByUser = new Map<string, { keys: string[]; oldestMs: number }>()
  const patternMismatch: string[] = []

  for (const entry of entries) {
    const age = nowMs - entry.lastModifiedMs
    if (age <= ORPHAN_CUTOFF_MS) continue // ちょうど cutoff は候補外(`>` 比較)

    const userId = matchOrphanKeyUserId(entry.key)
    if (userId === null) {
      patternMismatch.push(entry.key)
      continue
    }

    const bucket = candidatesByUser.get(userId)
    if (bucket) {
      bucket.keys.push(entry.key)
      bucket.oldestMs = Math.min(bucket.oldestMs, entry.lastModifiedMs)
    } else {
      candidatesByUser.set(userId, { keys: [entry.key], oldestMs: entry.lastModifiedMs })
    }
  }

  const candidates = Array.from(candidatesByUser.entries())
    .map(([userId, { keys, oldestMs }]) => ({ userId, keys, oldestMs }))
    .sort((a, b) => a.oldestMs - b.oldestMs)

  return { candidates, patternMismatch }
}

// ---------------------------------------------------------------------------
// lane orchestration(spec §4.2/§4.3)
// ---------------------------------------------------------------------------

// lane 予算(独立定義。値・phase 語彙が他 lane と同じでも意味は別 — lane ごとに
// 定数を独立定義する規律により import 共有しない。cron 内の絶対 deadline 割当
// (offset)は cron runner の領分でここには無い)。
const ORPHAN_TAIL_RESERVE_MS = 10_000 // 最終 incomplete 行を書くための先取り分
const ORPHAN_MIN_SLICE_MS = 2_000 // floor。残予算がこれ未満なら次 user/chunk を起動しない
const ORPHAN_DELETE_CHUNK = 20 // chunk 並列。chunk ごとに deadline を確認して打ち切れる粒度
const ORPHAN_MAX_LIST_PAGES = 10 // 1 page ≈ 最大 1000 key
// per-run 削除上限(final review I-1(a)・2026-08-10 追加)。ORPHAN_DELETE_CHUNK は
// 並列度であって上限ではなく、証拠(assets 行)を持つ asset_gc が 20/user/run に
// bound されているのに対し、証拠の無い object を消すこの lane は無制限だった —
// 唯一の安全弁(下記「行不在確認」のコメント参照)が fail-open な以上、1 run の
// 削除量そのものに上限を設ける。実測 row-less は 0 件のため、この上限に当たる run
// 自体が初日から異常(黙って大量削除するより、上限到達を Discord に出す方が安全)。
// chunk 境界での check(ORPHAN_DELETE_CHUNK=20 粒度)ゆえ実削除数は上限をチャンク
// 1 個分(最大 19)超えうるが、桁を守る安全弁としては十分 — byte-exact な cap は
// 過大実装(簡潔性規律)。
const ORPHAN_MAX_DELETE_PER_RUN = 50
// 台帳の暴走防止(src-sweep と同規律): 種別ごとに独立(mismatch の洪水が実削除失敗を
// 抑圧しない)。
const ORPHAN_MAX_DELETE_FAILURE_ROWS = 20
const ORPHAN_MAX_MISMATCH_ROWS = 5

const USERS_PREFIX = 'users/'

// incomplete 行の phase(spec §4.3 + canonical review Important #1 で `row_check`
// を追加 + final review I-1(a) で `max_delete` を追加)。配列順 = 優先順位(より
// 早く諦めた事実を残す)。`row_check` は `live_check` の直後に置く — どちらも
// 「1 candidate の DB 読出しが transient に失敗し、その candidate だけ skip して
// 続行する」という同じ severity の失敗様式のため。`max_delete`(per-run 削除上限
// 到達)は `list_truncated` の後・`deadline` の前に置く — 意図的な安全弁の作動
// であって観測の穴(list_truncated)ほど深刻ではないが、単なる時間切れ(deadline)
// より明確な signal(想定外の削除量)であるため。
const ORPHAN_PHASES = [
  'list',
  'live_check',
  'row_check',
  'list_truncated',
  'max_delete',
  'deadline',
] as const
type OrphanPhase = (typeof ORPHAN_PHASES)[number]

// 単位が field ごとに違う(object 数 / user 数)。src-sweep の SrcSweepSummary と
// 同じ規律。
export type OrphanScanSummary = {
  lane: 'asset_orphan_scan'
  listed: number // object 数(listing で見えた entry 全部)
  candidates: number // object 数(age 超過 かつ key 規約一致・**行確認前**)
  rowSkipped: number // object 数(assets 行が実在したため除外 — 正当データ・触らない)
  rowless: number // object 数(行不在確認を通過した実 orphan = DELETE 対象)
  deleted: number
  failed: number
  // **user 数**(他 field と単位が違う)。live だった user と live 判定自体が失敗した
  // user の合算(src-sweep の skippedLiveUsers と同じ規律)。
  skippedLiveUsers: number
  patternMismatch: number // object 数
  truncated: boolean
  phase: string | null
  recordErrors: number
  error?: string
}

/**
 * `users/` prefix の row-less orphan scan を 1 回実行する(spec §4.2〜§4.3)。
 *
 * **この関数は throw しない契約**: 大域 catch → `summary.error` + `logger.error`。
 * cron runner は summary をそのまま readback に載せる。
 *
 * 判定順は不変条件 3: live check(その user の DELETE batch 直前)→ 行不在確認
 * (DELETE に最近接)→ chunk DELETE。行がある object は絶対に触らない — 行確認は
 * listing 時点の判定を信用しないため DELETE の直前で行う(TOCTOU 窓の最小化)。
 *
 * `now` は時刻注入 — 実 sleep なしで打ち切りを test するため(src-sweep と同じ idiom)。
 */
export async function runOrphanScanLane(args: {
  deadlineAt: Date
  now?: () => number
}): Promise<OrphanScanSummary> {
  const now = args.now ?? Date.now
  const workDeadline = args.deadlineAt.getTime() - ORPHAN_TAIL_RESERVE_MS
  const slice = () => workDeadline - now()

  let phase: OrphanPhase | null = null
  let listErrorMessage: string | undefined
  let listed = 0
  let candidateKeys = 0
  let rowSkipped = 0
  let rowless = 0
  let deleted = 0
  let failed = 0
  let skippedLiveUsers = 0
  let patternMismatch = 0
  let truncated = false
  let recordErrors = 0
  let deleteRequested = 0
  let deleteFailureRows = 0
  let mismatchRows = 0
  let suppressedFailures = 0
  let error: string | undefined

  // 記帳 1 本ごとに独立の try/catch(不変条件・src-sweep writeRow と同型)。
  // recordIntegrationFailure は notifyOps の production fail-fast throw を伝播するため、
  // 大域 catch だけだと 1 本の記帳失敗が以降の削除まで巻き込む。
  const writeRow = async (row: {
    key: Extract<IntegrationFailureKey, `r2_orphan_${string}`>
    subject: string
    userId?: string
    context: Record<string, unknown>
    errorMessage?: string
  }): Promise<void> => {
    try {
      await recordIntegrationFailure({
        key: row.key,
        userId: row.userId,
        subject: row.subject,
        context: row.context,
        errorMessage: row.errorMessage,
      })
    } catch (err) {
      recordErrors++
      logger.error({ event: 'orphan_scan.record_failed', key: row.key, err })
    }
  }

  try {
    let entries: R2ObjectMeta[] = []
    try {
      // listObjectsWithMetaBounded の timeoutMs は **1 page ごと**に適用される
      // (listing 全体の上限ではない)。残予算をそのまま渡すと最悪 maxPages 倍かかる
      // (src-sweep §2 の実障害と同根拠)。page 数で割った 1 page ぶんを渡す。
      const page = await listObjectsWithMetaBounded(USERS_PREFIX, ORPHAN_MAX_LIST_PAGES, {
        timeoutMs: Math.min(LIST_TIMEOUT_MS, Math.floor(slice() / ORPHAN_MAX_LIST_PAGES)),
      })
      entries = page.entries
      truncated = page.truncated
      if (truncated) phase = higherPriorityPhase(phase, 'list_truncated')
    } catch (err) {
      // listing は never-throw ではない(fail-closed = age が読めない page は失敗扱い)。
      // 1 行に畳んで飲み、この run は削除なしで終える。
      phase = higherPriorityPhase(phase, 'list')
      listErrorMessage = String(err)
    }
    listed = entries.length

    const selection = selectOrphanCandidates(entries, now())
    candidateKeys = selection.candidates.reduce((sum, c) => sum + c.keys.length, 0)
    patternMismatch = selection.patternMismatch.length

    // pattern 不一致は **DELETE を試行しないまま** 1 件 1 行記帳して他機構(手動 script
    // 等)に委ねる(spec §4.3・src-sweep と同型)。
    for (const objectKey of selection.patternMismatch) {
      if (mismatchRows >= ORPHAN_MAX_MISMATCH_ROWS) {
        suppressedFailures++
        continue
      }
      mismatchRows++
      await writeRow({
        key: 'r2_orphan_delete',
        subject: 'orphan scan: object delete skipped (pattern mismatch)',
        context: { objectKey, status: null, reason: 'pattern_mismatch' },
      })
    }

    // candidates は oldest 昇順(selectOrphanCandidates)— 打ち切り時に最古 garbage を
    // 優先し、毎回同じ後半 user が starve する形にしない。
    for (const candidate of selection.candidates) {
      if (slice() < ORPHAN_MIN_SLICE_MS) {
        phase = higherPriorityPhase(phase, 'deadline')
        break
      }

      // 不変条件 3: live-op 除外は **その user の DELETE batch 直前**に評価する
      // (listing 時点で評価すると判定と DELETE の間が listing 全体ぶん開く)。
      let live: boolean
      try {
        live = await hasLiveUploadOperationForSweep(candidate.userId)
      } catch (err) {
        // 判定不能は skip に倒す(fail-safe)。live を false と読んで削除する方向へ
        // 倒すと、処理中 invocation の対象 object を消しうる。
        phase = higherPriorityPhase(phase, 'live_check')
        skippedLiveUsers++
        logger.warn({ event: 'orphan_scan.live_check_failed', userId: candidate.userId, err })
        continue
      }
      if (live) {
        skippedLiveUsers++
        continue
      }

      // 行不在確認(不変条件 3: DELETE に最近接。B-5: ORPHAN_ROW_CHECK_BATCH 件ずつ
      // 分割 — SQL parameter 上限 / statement size)。行のある key は正当データ
      // ゆえ候補から外す(それは asset_gc の領分・絶対に触らない)。
      //
      // **この lane の唯一の安全弁**(final review I-1(b)・過大な主張をしない: この
      // 判定 1 つが「行がある object を消さない」不変条件の全体を担う): live-upload-
      // check.ts の docstring と同じ極性の危険がここにも当てはまる — fail-safe が
      // 覆うのは **throw** であって「無言で 0 行」ではない。RLS の tenant context が
      // 意図と違う値で張られる等で読み取りが静かに空になると、全 key が rowless
      // (削除対象)に見えてしまう。この極性を backstop する機構(asset_gc の
      // `checkRefsPopulated` pre-sweep guard に相当するもの)はここには無い — cutoff
      // 7 日は「新しすぎる正当データ」を守るだけで、この「行が読めていないのに読めた
      // つもりになる」経路は防がない。緩和は per-run 削除上限(`ORPHAN_MAX_DELETE_PER_RUN`)
      // のみ — 誤って大量 rowless と判定されても、1 run で削除される量に天井を作る。
      //
      // この lane で唯一 catch されていなかった I/O(canonical review Important #1)。
      // live check と同じ fail-safe 判断: throw(transient DB error)は「行の有無が
      // 分からない」ことを意味し、false と読んで削除側へ倒すと正当データを消しうる。
      // **candidate 全体を all-or-nothing で今回 skip**する — batch 途中まで成功して
      // いてもその部分結果(rowSkipped/rowlessKeys)は採用しない(次 run に再導出を
      // 委ねる)。local 変数に溜めてから catch を抜けた場合だけ外側 counter へ反映する
      // ことで、途中で throw した候補が rowSkipped/rowless に半端に計上されるのを防ぐ。
      // これにより例外が候補 loop 全体を貫いて大域 catch へ抜けることも防ぐ(live check
      // の throw がその user だけ skip して続行するのと対称 — 抜けると残り全 candidate
      // の処理が止まり、`r2_orphan_incomplete` すら書かれず Discord 通知も飛ばない)。
      let rowlessKeys: string[]
      try {
        const localRowlessKeys: string[] = []
        let localRowSkipped = 0
        // batch loop 先頭の deadline check(round 5・class ①: 新しい 次 batch I/O を
        // 始めない)。**単純な inner break は不可**: batch loop を抜けただけでは
        // 直下の反映行(`rowSkipped += localRowSkipped` 等)に到達してしまい、確認
        // できていない batch を残したまま「途中までの部分結果」が採用される —
        // 「行を確認できていない key を含む candidate を DELETE 対象にしうる」という
        // この lane の最重要不変条件の違反になる。`deadlineHit` flag で inner break
        // の直後に反映行そのものへ到達する前に候補 loop ごと抜けることで、部分結果を
        // 一切反映しないことを構造で保証する(放棄した candidate は今回 DELETE
        // 対象にしない)。
        //
        // 閉じる範囲の限定(過大な主張をしない): この guard が閉じるのは**次 batch を
        // 開始しない**ことだけ。`withTenantTx` に query timeout が無いため、実行中の
        // 単一 DB query が延々ブロックする経路(hard timeout)は残る — 既知の限界と
        // して受容する(修理は本 fix の範囲外)。
        let deadlineHit = false
        for (let i = 0; i < candidate.keys.length; i += ORPHAN_ROW_CHECK_BATCH) {
          if (slice() < ORPHAN_MIN_SLICE_MS) {
            deadlineHit = true
            break
          }
          const batch = candidate.keys.slice(i, i + ORPHAN_ROW_CHECK_BATCH)
          // RLS 下でも user_id 条件は query 側にも明示する(CLAUDE.md 絶対ルール)。
          const existingRows = await withTenantTx(candidate.userId, (tx) =>
            tx
              .select({ objectKey: assets.objectKey })
              .from(assets)
              .where(and(eq(assets.userId, candidate.userId), inArray(assets.objectKey, batch))),
          )
          const existingKeys = new Set(existingRows.map((r) => r.objectKey))
          for (const key of batch) {
            if (existingKeys.has(key)) {
              localRowSkipped++
            } else {
              localRowlessKeys.push(key)
            }
          }
        }
        if (deadlineHit) {
          phase = higherPriorityPhase(phase, 'deadline')
          // candidate loop を抜ける。直下の反映行には到達させない — 部分結果は
          // 一切採用しない(all-or-nothing を deadline 経路でも維持する)。
          break
        }
        rowSkipped += localRowSkipped
        rowlessKeys = localRowlessKeys
      } catch (err) {
        phase = higherPriorityPhase(phase, 'row_check')
        logger.warn({ event: 'orphan_scan.row_check_failed', userId: candidate.userId, err })
        continue
      }
      rowless += rowlessKeys.length

      // row-check 完了後の recheck(Codex P2 対応)。delete loop 内の chunk ごとの
      // check だけでは足りない: `rowlessKeys` が空(= candidate の全 key に行があった)
      // だと `for (let i = 0; i < rowlessKeys.length; …)` の body が一度も実行されず、
      // chunk 側の check が発火しない。最後の candidate でこれが起きると、次の
      // candidate も無いため候補 loop 先頭の check も走らず、row-check で残予算を
      // 使い切って実際には deadline 超過しているのに `phase` が null のまま「完走」
      // として報告される(= 予算に張り付き始めた早期警告が失われる)。`rowlessKeys`
      // の中身に関わらず無条件に評価する。
      // 棲み分け(round 4): これは「新しい仕事(delete loop)を始めない」側の guard。
      // 「超過した事実を報告する」側は候補 loop を抜けた後の post-loop check(下記)が
      // 一様に担うため、両方要る(役割が違う)。
      if (slice() < ORPHAN_MIN_SLICE_MS) {
        phase = higherPriorityPhase(phase, 'deadline')
        break
      }

      let deadlineReached = false
      let maxDeleteReached = false
      for (let i = 0; i < rowlessKeys.length; i += ORPHAN_DELETE_CHUNK) {
        if (slice() < ORPHAN_MIN_SLICE_MS) {
          phase = higherPriorityPhase(phase, 'deadline')
          deadlineReached = true
          break
        }
        // per-run 削除上限(final review I-1(a)。ORPHAN_MAX_DELETE_PER_RUN の doc
        // comment 参照)。以降のこの candidate の rowlessKeys(および後続 candidate
        // 全部)を今回は削除しない — 打ち切り分は suppressedFailures に計上する
        // (実失敗ではないが r2_orphan_incomplete の「今回消せなかった量」に載せる
        // 既存慣習に合わせる)。
        if (deleteRequested >= ORPHAN_MAX_DELETE_PER_RUN) {
          phase = higherPriorityPhase(phase, 'max_delete')
          suppressedFailures += rowlessKeys.length - i
          maxDeleteReached = true
          break
        }
        const chunk = rowlessKeys.slice(i, i + ORPHAN_DELETE_CHUNK)
        // clamp 不要(asset-gc-lane.ts との非対称・意図的): 直上の
        // `slice() < ORPHAN_MIN_SLICE_MS` check と本行は同一 tick(間に await 無し)で
        // 評価されるため、ここに到達した時点で `slice() >= ORPHAN_MIN_SLICE_MS > 0` が
        // 構造的に保証される — 負の timeoutMs は発生しえない(src-sweep.ts と同形)。
        // asset-gc-lane.ts が `Math.max(0, …)` clamp を持つのは、あちらの timeout
        // closure が core(runReconciler)の collect loop **内部**で per-item recheck
        // 無しに評価され、実際に負 slice へ到達しうるため(AbortSignal.timeout() は
        // 負値で RangeError を同期 throw する・Node 24 実測)。本 lane は自前の chunk
        // loop で毎回 deadline を見ているため同じ穴が無い — 将来「片方だけ clamp が
        // 無い」と見て安易に足さないこと(足すなら to-reach な分岐を作ってしまう変更が
        // 先にあるはず)。
        const timeoutMs = Math.min(DELETE_TIMEOUT_MS, slice())
        const results = await Promise.all(
          chunk.map(async (objectKey) => ({
            objectKey,
            result: await deleteObject(objectKey, { timeoutMs }),
          })),
        )
        deleteRequested += chunk.length
        for (const { objectKey, result } of results) {
          // deleteObject は never-throw で 2xx / 404 を ok:true(成功系)に正規化する。
          if (result.ok) {
            deleted++
            continue
          }
          failed++
          if (deleteFailureRows >= ORPHAN_MAX_DELETE_FAILURE_ROWS) {
            suppressedFailures++
            continue
          }
          // 残予算が尽きたら個別行の書き込みを止め、書けなかった件数を counter に足す
          // (src-sweep.ts と同じ guard)。
          if (slice() < ORPHAN_MIN_SLICE_MS) {
            phase = higherPriorityPhase(phase, 'deadline')
            suppressedFailures++
            continue
          }
          deleteFailureRows++
          await writeRow({
            key: 'r2_orphan_delete',
            subject: 'orphan scan: object delete failed',
            userId: candidate.userId,
            context: { objectKey, status: result.status },
          })
        }
      }
      if (deadlineReached || maxDeleteReached) break
    }

    // 終端 path の一様な overrun 検知(Codex 2 周目・round 4 で構造修正)。
    //
    // round 3 までは「予算を消費しうる I/O の後ろ」に個別 check を足す方式だったが、
    // 同じ失敗様式(予算を使い切ったまま loop が自然終了し `phase` が null のまま
    // 「完走」と報告される)が 3 回連続で別々の path から見つかった(row-check 後に
    // rowlessKeys が空 / 最終 delete chunk が成功して予算を使い切る / 最終 candidate の
    // live 判定が予算を使い切って true を返す)。個別 path への撒き方は、新しい終端
    // path が増えるたびに漏れる構造的な脆さを持つため、責務を 2 つに分離する:
    // ① 「新しい仕事を始めない」= 上記の in-loop check(candidate loop 先頭 /
    //    row-check 後 / delete chunk ごと)がそのまま担う(予算が無いのに DELETE を
    //    撃たないための guard・**自然終了した場合には走らない**)。
    // ② 「超過した事実を報告する」= **ここ(loop を抜けた直後)の 1 箇所だけ**が担う。
    //    in-loop の break/continue 経路・自然終了経路のどちらを通っても必ずここへ来る
    //    ため、新しい終端 path が増えても漏れない。
    // `break` はしない(既に loop の外)— `phase` を立てるだけ。higherPriorityPhase
    // 経由なので、より早く諦めた事実(list / live_check / row_check / list_truncated)
    // が既にあればそちらが優先され、この post-loop check で上書きされることはない。
    if (slice() < ORPHAN_MIN_SLICE_MS) {
      phase = higherPriorityPhase(phase, 'deadline')
    }

    // incomplete 行は 1 run 最大 1 行(spec §4.3)。phase が複数該当しても優先順位で
    // 1 本に統合し、suppressedFailures もこの行に載せる。
    if (phase !== null || suppressedFailures > 0) {
      await writeRow({
        key: 'r2_orphan_incomplete',
        subject: 'orphan scan: run incomplete',
        context: {
          ...(phase !== null ? { phase } : {}),
          listed,
          deleteRequested,
          // **src-sweep の remaining とは意図的に異なる式**(canonical review
          // Important #2): src-sweep の `candidates` は全部が実削除候補(garbage)
          // なので `candidates - deleteRequested` で「良性の除外(live skip)」と
          // 「未処理の残り(deadline)」を混ぜても両方 transient で実害が薄い。この
          // lane の `candidateKeys` は**行確認より前**(age + key 規約のみ)の数で、
          // 7 日超過なだけの正当な参照中 asset(rowSkipped)を毎 run 恒久的に含む —
          // それを実 backlog と同じ数値に混ぜると、incomplete/alert が出た run(人が
          // 最も注意して読む場面)で桁が構造的に誤解を招く。`rowless - deleted -
          // failed` は「行不在確認**済み**(= 真の orphan)なのに deadline 等で
          // 未削除のもの」だけを表す — rowSkipped(正当な除外)や live skip した
          // user の key(rowless に一度も入らない)は定義上含まれない。
          remaining: rowless - deleted - failed,
          ...(suppressedFailures > 0 ? { suppressedFailures } : {}),
        },
        errorMessage: listErrorMessage,
      })
    }
  } catch (err) {
    error = String(err)
    logger.error({ event: 'orphan_scan.failed', err })
  }

  return {
    lane: 'asset_orphan_scan',
    listed,
    candidates: candidateKeys,
    rowSkipped,
    rowless,
    deleted,
    failed,
    skippedLiveUsers,
    patternMismatch,
    truncated,
    phase,
    recordErrors,
    ...(error !== undefined ? { error } : {}),
  }
}

// 「より早い段階で諦めた事実を残す」= 配列の前にあるものを優先する(src-sweep と
// 同型)。
function higherPriorityPhase(current: OrphanPhase | null, next: OrphanPhase): OrphanPhase {
  if (current === null) return next
  return ORPHAN_PHASES.indexOf(next) < ORPHAN_PHASES.indexOf(current) ? next : current
}
