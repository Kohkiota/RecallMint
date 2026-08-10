import { z } from 'zod'

import {
  recordIntegrationFailure,
  type IntegrationFailureKey,
} from '@/lib/integration-failures'
import { logger } from '@/lib/logger'
import { hasLiveUploadOperationForSweep } from './live-upload-check'
// 既定 timeout は写さず import する — 写すと r2.ts 側が変わったときに silent に
// 誤る(min の相手が古い値になる)。§2(退会 purge)と同根拠。
import {
  listObjectsWithMetaBounded,
  deleteObject,
  LIST_TIMEOUT_MS,
  DELETE_TIMEOUT_MS,
  type R2ObjectMeta,
} from './r2'

// `src/` prefix age-based sweeper(②-4b spec §3.2〜§3.6:
// docs/superpowers/specs/2026-08-09-ocr-2-4b-s3-src-sweeper-design.md)。
// 前半 = 選定 pure 関数(I/O なし)/ 後半 = lane orchestration(listing → 選定 →
// overdue 記帳 → live-op 除外 → 予算付き DELETE → 台帳)。cron 入口・auth・
// override 検証は route(Task 5)の領分でここには無い。domain aggregate ではなく
// infra 層の GC ロジックのため `lib/<context>/domain/` でなく `lib/storage/` に
// 置く(spec §12)。

// 候補化する age 閾値(既定 cutoff・cron 発火時はこの値。手動 GET の
// `?cutoffMinutes=` override はこの定数を差し替えて呼び出す側 — lane 層の責務)。
export const SWEEP_CUTOFF_MS = 6 * 60 * 60 * 1000

// overdue alert の閾値。**cutoffMs パラメータから独立**(OT 裁定・spec §3.6):
// override で cutoff を縮めても、この値は動かない。selectSweepTargets が
// cutoffMs でなくこの定数を直接参照することで機械的に保証する。
export const ALERT_AGE_MS = 72 * 60 * 60 * 1000

// 削除候補の key 規約(spec §3.2): `src/{userId}/{uploadSessionId}/{fileId}.pdf`
// (`lib/media/source-object-key.ts` `sourcePdfObjectKey` の生成規則と一致)。
// uuid 3 セグメントは z.uuid({version:'v4'}) で判定する — 既存慣習と同一判定域
// (`lib/validation/card.ts` isAssetKey / `lib/ocr/prepared-schema.ts`
// uuidV4Schema / `lib/media/source-object-key.ts` と同じ、file ごとに local 定義
// する既存パターンを踏襲。共有 util 化は対象 3 箇所目でも rule of three の範囲外
// = このpin用途だけの新規4本目を追加する判断は本 task の scope 外)。
// z.uuid は大文字 hex を通す(A6 OT 裁定): client 供給の uploadSessionId/fileId
// 由来で大文字を含む正規 key が存在しうるため、uuid セグメントの照合は
// case-insensitive でなければならない。拡張子 `.pdf` と prefix `src/` は生成側が
// 常に固定文字列で埋め込む(サーバー生成・大文字化されない)ため、こちらは
// 意図的に case-sensitive のまま(`.PDF` は不一致として扱う)。
const uuidV4Schema = z.uuid({ version: 'v4' })
// この regex が保証するのは「/」区切りでちょうど 3 セグメントに割れること(境界)
// だけで、各セグメントが uuid の形をしているかは見ていない — 実際の内容 gate は
// 下の z.uuid() 側であり、2 段は冗長ではない。ただし境界の厳格さ自体
// (`[^/]+` を `.+` に緩めても)は zod 側が embedded `/` や不正な形を弾くため
// 現行 test では検出できない(mutation red 検証で確認済み・test は増やさない)。
const SRC_KEY_SEGMENTS_PATTERN = /^src\/([^/]+)\/([^/]+)\/([^/]+)\.pdf$/

/**
 * key が `src/{uuid}/{uuid}/{uuid}.pdf` 規約に一致するか判定し、一致すれば
 * userId(1 セグメント目)を返す。不一致は null。
 */
function matchSrcKeyUserId(key: string): string | null {
  const match = SRC_KEY_SEGMENTS_PATTERN.exec(key)
  if (!match) return null
  const [, userId, uploadSessionId, fileId] = match
  if (
    !uuidV4Schema.safeParse(userId).success ||
    !uuidV4Schema.safeParse(uploadSessionId).success ||
    !uuidV4Schema.safeParse(fileId).success
  ) {
    return null
  }
  return userId
}

export type SweepSelection = {
  // oldest 昇順(最古候補を持つ user が先)— deadline 打ち切り時に最古 garbage を優先し、
  // 毎回同じ後半 user が打ち切られる形にしない(Codex 論点採用)
  candidates: { userId: string; keys: string[]; oldestMs: number }[]
  patternMismatch: string[] // age > cutoff だが key 規約非一致(削除しない・記録のみ)
  overdue: { count: number; oldestKey: string; oldestAgeHours: number } | null
}

/**
 * listing snapshot(spec §3.6「DELETE 実行前の snapshot」)から選定を計算する
 * pure 関数。
 *
 * - candidates: age > cutoffMs かつ key 規約一致の object を userId でグルーピング
 * - patternMismatch: age > cutoffMs だが key 規約不一致(削除しない・記録のみ。
 *   spec §3.2「lifecycle に委ねる」)
 * - overdue: **entries 全体**(pattern 一致/不一致を問わない)に対して
 *   age > ALERT_AGE_MS を評価する。cutoff 未満で候補化されない object も含む
 *   — overdue は「候補選定」でなく「lifecycle 全体が回収し損ねているか」の
 *   独立した監視軸のため(spec §3.6「listing snapshot に対して」)。
 */
export function selectSweepTargets(
  entries: R2ObjectMeta[],
  nowMs: number,
  cutoffMs: number,
): SweepSelection {
  const candidatesByUser = new Map<string, { keys: string[]; oldestMs: number }>()
  const patternMismatch: string[] = []

  for (const entry of entries) {
    const age = nowMs - entry.lastModifiedMs
    if (age <= cutoffMs) continue // ちょうど cutoff は候補外(`>` 比較・spec §3.2)

    const userId = matchSrcKeyUserId(entry.key)
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

  let overdueCount = 0
  let oldestOverdueMs: number | null = null
  let oldestOverdueKey = ''
  for (const entry of entries) {
    if (nowMs - entry.lastModifiedMs <= ALERT_AGE_MS) continue // `>` 比較(candidates と同じ規約)
    overdueCount += 1
    if (oldestOverdueMs === null || entry.lastModifiedMs < oldestOverdueMs) {
      oldestOverdueMs = entry.lastModifiedMs
      oldestOverdueKey = entry.key
    }
  }
  const overdue =
    overdueCount === 0 || oldestOverdueMs === null
      ? null
      : {
          count: overdueCount,
          oldestKey: oldestOverdueKey,
          // 整数時間へ丸める(alert 表示・Discord 通知用の値 — 分オーダーの精度は
          // operator の判断に寄与しないため丸める。厳密な ms は必要なら
          // context.objectKey の lastModified を別途読める)。
          oldestAgeHours: Math.round((nowMs - oldestOverdueMs) / (60 * 60 * 1000)),
        }

  return { candidates, patternMismatch, overdue }
}

// ---------------------------------------------------------------------------
// lane orchestration(spec §3.3/§3.4/§3.5)
// ---------------------------------------------------------------------------

// lane 予算(spec §3.4)。§2(退会 purge)と同じ idiom だが値・phase 語彙・quota 方式は
// sweeper 側で独立に定義する(2 箇所目で rule of three 未満・意味も別)。
// 本 lane は `deadlineAt` を受け取る側(cron runner が配る・asset レーン整合 sprint
// spec §2.1)なので、lane 単体の想定予算を表す定数はここには置かない — cron 全体の
// per-lane offset(runner 側)と maxDuration の関係式は route.test.ts が pin する
// (旧 `SWEEP_BUDGET_MS` pin の後継。dead export 化に伴い削除・2026-08-10)。
const SWEEP_TAIL_RESERVE_MS = 10_000 // 最終 incomplete 行を書くための先取り分
const SWEEP_MIN_SLICE_MS = 2_000 // floor。残予算がこれ未満なら次の chunk を開始しない
const SWEEP_DELETE_CHUNK = 20 // chunk 並列。chunk ごとに deadline を確認して打ち切れる粒度
const SWEEP_MAX_LIST_PAGES = 10 // 1 page ≈ 最大 1000 key
// 台帳の暴走防止(§3.5)。**種別ごとに独立**にするのは、mismatch の洪水が実削除失敗を
// 抑圧しないため(共有枠だと listing 先頭の mismatch だけで枠が尽きる)。
const SWEEP_MAX_DELETE_FAILURE_ROWS = 20
const SWEEP_MAX_MISMATCH_ROWS = 5

const SRC_PREFIX = 'src/'

// incomplete 行の phase(§3.5)。複数該当時は「より早い段階で諦めた事実」を残すため
// この配列順(= 優先順位)で高い方を採る。行は 1 run 1 本に統合する。
const SWEEP_PHASES = ['list', 'live_check', 'list_truncated', 'deadline'] as const
type SweepPhase = (typeof SWEEP_PHASES)[number]

// 単位が field ごとに違う(object 数 / user 数)。読み手が取り違えると
// 「候補 3 件のうち 1 user を skip」のような比較不能な引き算をしてしまうため、
// 各 field に単位を明記する。
export type SrcSweepSummary = {
  lane: 'src_sweep'
  listed: number // object 数(listing で見えた entry 全部)
  candidates: number // object 数(age 超過 かつ key 規約一致の削除候補 key)
  deleted: number // object 数
  failed: number // object 数
  // **user 数**(他 field と単位が違う)。「live だった user」と「live 判定自体が
  // 失敗した user」の合算 — どちらも帰結が同じ(今回は触らず翌日再考)ため分けない。
  // 内訳が要るときは phase で区別する(判定失敗の時だけ 'live_check' が立つ)。
  skippedLiveUsers: number
  patternMismatch: number // object 数
  overdueCount: number // object 数
  truncated: boolean
  phase: string | null
  // 記帳(recordIntegrationFailure)自体の失敗数。台帳 + Discord がこの lane の唯一の
  // 観測点である以上、その経路が壊れた事実は別経路(summary / logger)で見えなければ
  // ならない(§3.5)。
  recordErrors: number
  cutoffOverrideMinutes?: number
  error?: string
}

/**
 * `src/` prefix の age-based sweep を 1 回実行する(spec §3.3〜§3.6)。
 *
 * **この関数は throw しない契約**(不変条件 5): 大域 catch → `summary.error` +
 * `logger.error`。cron runner は summary をそのまま readback に載せる。
 * `summary.error` は `String(err)` のみ(R2 応答 body / URL を載せない)。
 *
 * `cutoffMs` を引数で受けるのは手動 GET の `?cutoffMinutes=` override のため
 * (受理・下限・prod 拒否の検証は route の領分)。overdue 判定は `selectSweepTargets`
 * が `ALERT_AGE_MS` を直接参照するので override の影響を受けない。
 * **`cutoffMs` の下限検証は route の責務**であり、ここでは検証しない(起きえない分岐を
 * 握らない方針)。`0` / 負 / `NaN` を渡すと `src/` の全 object が候補化する(`NaN` は
 * 比較が常に false になるため特に危険)。2 本目の lane や別 caller を足すときは、
 * この不変条件の担い手が route 1 箇所であることを引き継ぐこと。
 *
 * `now` は時刻注入 — 実 sleep なしで打ち切りを test するため(§2 と同じ idiom)。
 *
 * 成功が意味するのは「`src/` が空になった」ではなく「**列挙済み候補への削除要求が
 * 完了した**」まで(readback しない・§3.7)。
 */
export async function runSrcSweepLane(args: {
  deadlineAt: Date
  cutoffMs: number
  cutoffOverrideMinutes?: number
  now?: () => number
}): Promise<SrcSweepSummary> {
  const now = args.now ?? Date.now
  // 打ち切りの事実そのもの(incomplete 行)を書けない事態を避けるため、作業 deadline は
  // tail reserve を先取りする。
  const workDeadline = args.deadlineAt.getTime() - SWEEP_TAIL_RESERVE_MS
  const slice = () => workDeadline - now()

  let phase: SweepPhase | null = null
  let listErrorMessage: string | undefined
  let listed = 0
  let candidateKeys = 0
  let deleted = 0
  let failed = 0
  let skippedLiveUsers = 0
  let patternMismatch = 0
  let overdueCount = 0
  let truncated = false
  let recordErrors = 0
  let deleteRequested = 0
  let deleteFailureRows = 0
  let mismatchRows = 0
  let suppressedFailures = 0
  let error: string | undefined

  // 記帳 1 本ごとに独立の try/catch(不変条件 6)。recordIntegrationFailure は notifyOps の
  // production fail-fast throw を伝播するため、大域 catch だけだと 1 本の記帳失敗が以降の
  // 削除まで巻き込む。§2 の recordSrcPurgeRow と同形だが、失敗を silent にしないため
  // recordErrors を加算する。
  const writeRow = async (row: {
    key: Extract<IntegrationFailureKey, `r2_sweep_${string}`>
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
      logger.error({ event: 'src_sweep.record_failed', key: row.key, err })
    }
  }

  try {
    let entries: R2ObjectMeta[] = []
    try {
      // listObjectsWithMetaBounded の timeoutMs は **1 page ごと**に適用される(listing
      // 全体の上限ではない)。残予算をそのまま渡すと最悪 maxPages 倍かかり workDeadline を
      // 超え、tail reserve ごと食い潰して打ち切りの incomplete 行すら書けなくなる
      // (②-4b §2 の実障害)。page 数で割った 1 page ぶんを渡すと最悪値が閉じる。
      const page = await listObjectsWithMetaBounded(SRC_PREFIX, SWEEP_MAX_LIST_PAGES, {
        timeoutMs: Math.min(LIST_TIMEOUT_MS, Math.floor(slice() / SWEEP_MAX_LIST_PAGES)),
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

    const selection = selectSweepTargets(entries, now(), args.cutoffMs)
    candidateKeys = selection.candidates.reduce((sum, c) => sum + c.keys.length, 0)
    patternMismatch = selection.patternMismatch.length
    overdueCount = selection.overdue?.count ?? 0

    // 不変条件 4: overdue は **DELETE 開始前**に記帳する。今回の DELETE が成功しても
    // 「72h 生き延びた = どの機構も回収しなかった」事実は消えないため。
    if (selection.overdue) {
      await writeRow({
        key: 'r2_sweep_overdue',
        subject: 'src sweep: source object overdue beyond alert age',
        context: {
          count: selection.overdue.count,
          oldestKey: selection.overdue.oldestKey,
          oldestAgeHours: selection.overdue.oldestAgeHours,
          // listing 上限で全域を見ていない run であることの明示(§3.6 A3)—
          // 「全域で 0 件」と「見た範囲で 0 件」を混同させない。
          partial: truncated,
        },
      })
    }

    // pattern 不一致は **DELETE を試行しないまま** 1 件 1 行記帳して lifecycle に委ねる
    // (§3.2 / 不変条件 2)。DELETE より前に書くのは、実削除の打ち切り(deadline)で
    // 観測が落ちないようにするため(≤5 行で bounded・§3.5 の独立 quota)。
    for (const objectKey of selection.patternMismatch) {
      if (mismatchRows >= SWEEP_MAX_MISMATCH_ROWS) {
        suppressedFailures++
        continue
      }
      mismatchRows++
      await writeRow({
        key: 'r2_sweep_delete',
        subject: 'src sweep: source PDF delete skipped (pattern mismatch)',
        context: { objectKey, status: null, reason: 'pattern_mismatch' },
      })
    }

    // candidates は oldest 昇順(Task 3)— 打ち切り時に最古 garbage を優先し、毎回同じ
    // 後半 user が starve する形にしない。
    for (const candidate of selection.candidates) {
      if (slice() < SWEEP_MIN_SLICE_MS) {
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
        // 倒すと、処理中 invocation の source を消しうる。
        phase = higherPriorityPhase(phase, 'live_check')
        skippedLiveUsers++
        logger.warn({ event: 'src_sweep.live_check_failed', userId: candidate.userId, err })
        continue
      }
      // live user の候補は全て今回 skip し翌日再考する。これは正常な繰延なので phase は
      // 立てない(incomplete 行 = Discord 通知を日次の正常 run で鳴らさない・§3.1)。
      if (live) {
        skippedLiveUsers++
        continue
      }

      let deadlineReached = false
      for (let i = 0; i < candidate.keys.length; i += SWEEP_DELETE_CHUNK) {
        if (slice() < SWEEP_MIN_SLICE_MS) {
          phase = higherPriorityPhase(phase, 'deadline')
          deadlineReached = true
          break
        }
        const chunk = candidate.keys.slice(i, i + SWEEP_DELETE_CHUNK)
        // in-flight I/O には min(既定 timeout, 残予算)を渡す。chunk ごとに再計算する
        // ので listing と違い多重化しない。
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
          if (deleteFailureRows >= SWEEP_MAX_DELETE_FAILURE_ROWS) {
            suppressedFailures++
            continue
          }
          // 残予算が尽きたら個別行の書き込みを止め、書けなかった件数を counter に足す
          // (§2 purgeSourcePrefix と同じ guard)。chunk 境界の check だけでは足りない:
          // 記帳は 1 本ずつ notifyOps の fetch(3s abort)を待つため、chunk 内で最大
          // 20 本 ≈ 60s を無防備に費やしうる。tail reserve が守るべき当の行
          // (incomplete)を書く前に platform に殺される事態を防ぐ。
          if (slice() < SWEEP_MIN_SLICE_MS) {
            phase = higherPriorityPhase(phase, 'deadline')
            suppressedFailures++
            continue
          }
          deleteFailureRows++
          await writeRow({
            key: 'r2_sweep_delete',
            subject: 'src sweep: source PDF delete failed',
            userId: candidate.userId,
            context: { objectKey, status: result.status },
          })
        }
      }
      if (deadlineReached) break
    }

    // incomplete 行は 1 run 最大 1 行(§3.5)。phase が複数該当しても優先順位で 1 本に
    // 統合し、suppressedFailures もこの行に載せる — ゆえに list_truncated も含め
    // **最後に**書く(途中で書くと後続の deadline を統合できない)。
    if (phase !== null || suppressedFailures > 0) {
      await writeRow({
        key: 'r2_sweep_incomplete',
        subject: 'src sweep: run incomplete',
        context: {
          ...(phase !== null ? { phase } : {}),
          listed,
          deleteRequested,
          // 候補のうち DELETE を要求しなかった数(live skip / 打ち切りの残り)。
          remaining: candidateKeys - deleteRequested,
          ...(suppressedFailures > 0 ? { suppressedFailures } : {}),
        },
        errorMessage: listErrorMessage,
      })
    }
  } catch (err) {
    error = String(err)
    logger.error({ event: 'src_sweep.failed', err })
  }

  return {
    lane: 'src_sweep',
    listed,
    candidates: candidateKeys,
    deleted,
    failed,
    skippedLiveUsers,
    patternMismatch,
    overdueCount,
    truncated,
    phase,
    recordErrors,
    ...(args.cutoffOverrideMinutes !== undefined
      ? { cutoffOverrideMinutes: args.cutoffOverrideMinutes }
      : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

// 「より早い段階で諦めた事実を残す」= 配列の前にあるものを優先する(§3.5)。
function higherPriorityPhase(
  current: SweepPhase | null,
  next: SweepPhase,
): SweepPhase {
  if (current === null) return next
  return SWEEP_PHASES.indexOf(next) < SWEEP_PHASES.indexOf(current) ? next : current
}
