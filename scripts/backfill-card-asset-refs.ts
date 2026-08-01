// 既存 cards.images 配列 → card_asset_refs への一括射影 backfill (one-shot script)。
// 画像 GC v2 Task G1 で新設した card_asset_refs table (GC 権威) を、既存 card データ
// から埋める。reconciler (Task G5、後続) の運用開始前提 (backfill 完了が前提条件、
// spec §4.11-5)。
//
// 実行 (`--conditions=react-server` は必須フラグ: 本 script は getAdminDb() 経由で
//  `import 'server-only'` を持つ module を読むため、付与しないと runtime guard で
//  throw する。seed-perf-exam.ts と同前例):
//   pnpm tsx --conditions=react-server scripts/backfill-card-asset-refs.ts --dry-run       # 確認 (write ゼロ)
//   pnpm tsx --conditions=react-server scripts/backfill-card-asset-refs.ts                 # 全 user 本実行
//   pnpm tsx --conditions=react-server scripts/backfill-card-asset-refs.ts --user <userId> # 対象 user のみ
//   (--user は値必須。値なし / 別 flag が続くと fail-fast で exit 1 — 全 user 誤爆防止)
//
// 動作:
// - 対象 card 全行を SELECT (--user 指定時は WHERE user_id を query に押し込む)
// - images 配列内の UUIDv4 key (= asset 参照。isAssetKey で判別、legacy 非 UUID
//   entry は対象外) を集約し、実在する asset の id -> {status,userId} を 1 回で
//   問い合わせる (Map に無い id = 存在しない asset)
// - 全 card を対象に projectCardRefs (純粋関数) で refs 行 + missing/nonReady 分類
//   を算出し、card_asset_refs を「全置換」(owner-scope で既存 refs を DELETE →
//   新 refs を INSERT) する。UUID key を持たない (= 生成 refs 空) card も skip せず、
//   DELETE で前 run の stale refs を必ず落とす (spec §4.10「消えた refs も消える」=
//   再実行安全)。
// - ready-ref 化は「asset が実在・status='ready'・かつ card と同一 user 所有」の時
//   のみ (handleImages の owner-scope 検証 card-field-handlers.ts:181 に一致)。
//   実在しない / 他 user 所有 → missing、同一 user 所有だが非 ready → nonReady に
//   分類し、いずれも ref 行を生成しない (RESTRICT FK で本実行が落ちる前に検出 —
//   spec §4.1)。
//
// 実行順序 (spec §4.10): migration (card_asset_refs 作成) → 本 backfill →
// reconciler 運用開始。reconciler は本 backfill 完了後の環境でのみ走らせる。
//
// 安全性:
// - dry-run は write を一切行わず、would-insert 件数と分布を集計・出力するのみ。
// - production 実行は OT が手動 (env を対象環境用に切替えた上で本 script を実行)。

import { and, eq, inArray } from 'drizzle-orm'
import { getAdminDb } from '@/lib/db'
import { cards, assets, cardAssetRefs } from '@/lib/db/schema'
import type { CardImage, NewCardAssetRef } from '@/lib/db/schema'
import { isAssetKey } from '@/lib/validation/card'
import { projectCardAssetRefs } from '@/lib/cards/domain/card-asset-refs'

export type BackfillCardRow = {
  id: string
  userId: string
  images: CardImage[]
}

// 実在する asset の owner-scope 判定に必要な最小情報 (status + userId)。
export type AssetInfo = { status: string; userId: string }

export type BackfillDeps = {
  fetchCards: () => Promise<BackfillCardRow[]>
  // 与えられた候補 assetId 集合について、実在するものだけ id -> {status,userId} を
  // 返す (Map に無い id = 存在しない asset)。missing / nonReady / 他 user 所有の
  // 判別に必要。他 user 所有 asset を ready-ref 化しないため userId も返す
  // (handleImages の owner-scope 検証 card-field-handlers.ts:181 に倣う)。
  fetchAssetInfos: (candidateIds: string[]) => Promise<Map<string, AssetInfo>>
  // card 単位の refs 全置換 (DELETE 既存 → INSERT 新規)。dry-run では呼ばれない。
  // userId で owner-scope する (CLAUDE.md Clerk-3「query は必ず WHERE user_id」・
  // card_tags whole-set replace 前例に倣う)。refs が空でも DELETE は必ず走らせ、
  // 前 run の stale ref を消す (再実行安全 — spec §4.10「消えた refs も消える」)。
  replaceCardRefs: (
    cardId: string,
    userId: string,
    refs: NewCardAssetRef[],
  ) => Promise<void>
  log: (msg: string) => void
}

export type BackfillOptions = {
  dryRun: boolean
  userId?: string
}

// ---------------------------------------------------------------------------
// pure projection: 1 枚の card の images 配列 → refs 行 + 除外分類
// ---------------------------------------------------------------------------
export type ProjectionResult = {
  refs: NewCardAssetRef[]
  missingAssetIds: string[]
  nonReadyAssetIds: string[]
}

/**
 * card 1 件の images 配列を card_asset_refs 行に射影する。
 * - UUIDv4 key (isAssetKey) のみ対象。legacy 非 UUID key は対象外 (refs に入らない)。
 * - ordinal は同一 field_key (= target) 内で配列順に 0-based で採番する (Task 11:
 *   採番自体は共有 pure 関数 projectCardAssetRefs に委譲。 handleImages と同一定義)。
 * - ready-ref 化する条件は「asset が実在し status='ready' かつ card と同一 user 所有」
 *   (handleImages の owner-scope 検証に一致)。分類:
 *   - 実在せず / 他 user 所有 → missingAssetIds (どちらも「自 user の有効な asset で
 *     ない」= 参照不可。他 user asset に card owner の userId で ref を書くと
 *     owner-scope invariant を破るため ref 化しない)。
 *   - 実在・同一 user 所有だが非 ready → nonReadyAssetIds。
 *   いずれの分類でも ref 行は生成しない (skip = RESTRICT FK 事故の事前検出)。
 *
 * 注意 (旧実装と挙動一致): projectCardAssetRefs は「全 UUID key が ready 前提」で
 * ordinal を採番する (missing/nonReady も採番対象に含む)。本関数はその候補 refs を
 * assetInfos で後段フィルタするだけなので、ready-ref の ordinal には missing/nonReady
 * 分だけ欠番が生じ得る (旧実装も同じ — ordinalByField の increment は分類前に行われて
 * いた)。
 */
export function projectCardRefs(
  card: BackfillCardRow,
  assetInfos: ReadonlyMap<string, AssetInfo>,
): ProjectionResult {
  const refs: NewCardAssetRef[] = []
  const missingAssetIds: string[] = []
  const nonReadyAssetIds: string[] = []

  const candidateRefs = projectCardAssetRefs(card.id, card.userId, card.images)
  for (const candidate of candidateRefs) {
    const info = assetInfos.get(candidate.assetId)
    const ownedBySameUser = info?.userId === card.userId

    if (info && ownedBySameUser && info.status === 'ready') {
      refs.push(candidate)
    } else if (info && ownedBySameUser) {
      // 実在・同一 user 所有だが status != 'ready'
      nonReadyAssetIds.push(candidate.assetId)
    } else {
      // 実在しない / 他 user 所有 → 参照不可 (missing 扱い)
      missingAssetIds.push(candidate.assetId)
    }
  }

  return { refs, missingAssetIds, nonReadyAssetIds }
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
export type BackfillSummary = {
  scannedCards: number
  cardsWithUuidKeys: number
  refsInserted: number // dry-run では「挿入されたであろう」件数
  missingAssetIds: number
  nonReadyAssetIds: number
  fieldKeyDistribution: {
    questionText: number
    option: number
  }
}

const EMPTY_SUMMARY: BackfillSummary = {
  scannedCards: 0,
  cardsWithUuidKeys: 0,
  refsInserted: 0,
  missingAssetIds: 0,
  nonReadyAssetIds: 0,
  fieldKeyDistribution: { questionText: 0, option: 0 },
}

function mergeSummary(
  acc: BackfillSummary,
  card: BackfillCardRow,
  result: ProjectionResult,
): BackfillSummary {
  const hasUuidKeys = card.images.some((entry) => isAssetKey(entry.key))
  const fieldKeyDelta = { questionText: 0, option: 0 }
  for (const ref of result.refs) {
    if (ref.fieldKey === 'question_text') fieldKeyDelta.questionText++
    else fieldKeyDelta.option++
  }
  return {
    scannedCards: acc.scannedCards + 1,
    cardsWithUuidKeys: acc.cardsWithUuidKeys + (hasUuidKeys ? 1 : 0),
    refsInserted: acc.refsInserted + result.refs.length,
    missingAssetIds: acc.missingAssetIds + result.missingAssetIds.length,
    nonReadyAssetIds: acc.nonReadyAssetIds + result.nonReadyAssetIds.length,
    fieldKeyDistribution: {
      questionText:
        acc.fieldKeyDistribution.questionText + fieldKeyDelta.questionText,
      option: acc.fieldKeyDistribution.option + fieldKeyDelta.option,
    },
  }
}

// ---------------------------------------------------------------------------
// DI core
// ---------------------------------------------------------------------------
// asset-info 問い合わせの 1 batch あたり candidate 上限。Postgres の bind パラメータ
// 上限 (65535) を大きく下回る値にし、全 user backfill の巨大 IN を分割する。
export const ASSET_LOOKUP_BATCH_SIZE = 1000

export async function runBackfill(
  opts: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillSummary> {
  const allCards = await deps.fetchCards()
  const targetCards = opts.userId
    ? allCards.filter((c) => c.userId === opts.userId)
    : allCards
  deps.log(
    `target: ${targetCards.length} cards (dryRun=${opts.dryRun}, userId=${opts.userId ?? 'all'})`,
  )

  // 全 card 横断で候補 assetId (UUIDv4 key) を集約し、1 回の問い合わせで
  // 「実在する asset の {status,userId}」を得る (Map に無い id = 存在しない asset)。
  // ready-ref / nonReady / missing の判別 (owner-scope 含む) は projectCardRefs 側で
  // card ごとに行う (asset の所有者と card の所有者を突き合わせる必要があるため)。
  const candidateIds = [
    ...new Set(
      targetCards.flatMap((c) =>
        c.images.map((i) => i.key).filter((k) => isAssetKey(k)),
      ),
    ),
  ]
  // 全 user backfill で candidate 数が Postgres の bind パラメータ上限 (65535) を
  // 超えると単一 IN query が失敗する。ASSET_LOOKUP_BATCH_SIZE 件ずつ分割問い合わせ
  // して Map を merge する (codebase の bounded-IN 規律 = deck-download の
  // resolveAssetUrls 50 件 batch / handleImages ≤10/card に倣う)。
  const assetInfos = new Map<string, AssetInfo>()
  for (let i = 0; i < candidateIds.length; i += ASSET_LOOKUP_BATCH_SIZE) {
    const batch = candidateIds.slice(i, i + ASSET_LOOKUP_BATCH_SIZE)
    const batchInfos = await deps.fetchAssetInfos(batch)
    for (const [id, info] of batchInfos) assetInfos.set(id, info)
  }

  let summary = EMPTY_SUMMARY

  for (const card of targetCards) {
    const result = projectCardRefs(card, assetInfos)
    summary = mergeSummary(summary, card, result)

    // 全 card を必ず処理する。UUID key が無い (= 生成 refs 空) card も skip せず
    // replaceCardRefs を呼ぶ: 前 run で付いた ref が今 run で消えた場合、DELETE で
    // stale ref を必ず落とす必要がある (spec §4.10「消えた refs も消える」= 再実行
    // 安全。skip すると GC が回収漏れの orphan を参照中と誤認する)。
    if (!opts.dryRun) {
      await deps.replaceCardRefs(card.id, card.userId, result.refs)
    }
  }

  deps.log(
    `done. scanned=${summary.scannedCards} withUuidKeys=${summary.cardsWithUuidKeys} refsInserted=${summary.refsInserted} missing=${summary.missingAssetIds} nonReady=${summary.nonReadyAssetIds} (dryRun=${opts.dryRun})`,
  )

  return summary
}

// ---------------------------------------------------------------------------
// CLI arg parsing (pure・testable)
// ---------------------------------------------------------------------------
/**
 * `--user` は必ず非 flag の値を伴わなければならない (footgun 防止): `--user` の
 * 直後が欠落 / 別 flag (`-` 始まり) の場合、undefined に落とすと「全 user backfill」と
 * 区別できず、mistype した targeted 実行が全 card の refs を全置換してしまう。
 * そのため fail-fast で Error を投げる (呼び出し側 = main が process.exit(1) に変換)。
 * `--user` 無し = 全 user backfill (意図的、許容)。
 */
export function parseUserFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf('--user')
  if (idx === -1) return undefined
  const next = argv[idx + 1]
  if (!next || next.startsWith('-')) {
    throw new Error('--user requires a userId value (e.g. --user <userId>)')
  }
  return next
}

// ---------------------------------------------------------------------------
// CLI entry: production deps を bind して runBackfill を呼ぶ。 import 経路では
// 実行しないよう process.argv[1] guard (mirror 元 backfill-clerk-metadata.ts 踏襲)。
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const argv = process.argv
  const dryRun = argv.includes('--dry-run')
  const userId = parseUserFlag(argv)

  const db = getAdminDb()
  await runBackfill(
    { dryRun, userId },
    {
      fetchCards: async () => {
        // --user 指定時は WHERE user_id を query に押し込む (owner-scope query
        // discipline + scale: 単一 user 対象の backfill で全 card scan を避ける)。
        // 無指定時のみ full-scan。
        const base = db
          .select({
            id: cards.id,
            userId: cards.userId,
            images: cards.images,
          })
          .from(cards)
        const rows = userId
          ? await base.where(eq(cards.userId, userId))
          : await base
        return rows as BackfillCardRow[]
      },
      fetchAssetInfos: async (candidateIds) => {
        const rows = await db
          .select({
            id: assets.id,
            status: assets.status,
            userId: assets.userId,
          })
          .from(assets)
          .where(inArray(assets.id, candidateIds))
        return new Map(rows.map((r) => [r.id, { status: r.status, userId: r.userId }]))
      },
      replaceCardRefs: async (cardId, userId, refs) => {
        await db.transaction(async (tx) => {
          // owner-scope DELETE (CLAUDE.md Clerk-3・card_tags whole-set replace 前例)。
          await tx
            .delete(cardAssetRefs)
            .where(
              and(
                eq(cardAssetRefs.cardId, cardId),
                eq(cardAssetRefs.userId, userId),
              ),
            )
          if (refs.length > 0) {
            await tx.insert(cardAssetRefs).values(refs)
          }
        })
      },
      log: (msg) => console.log(`[backfill-card-asset-refs] ${msg}`),
    },
  )
}

// process.argv[1] が本 file のとき = CLI 起動。test import 時は走らない。
if (process.argv[1]?.endsWith('backfill-card-asset-refs.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[backfill-card-asset-refs] fatal:', err)
      process.exit(1)
    })
}
