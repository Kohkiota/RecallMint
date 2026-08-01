import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  runBackfill,
  projectCardRefs,
  parseUserFlag,
  ASSET_LOOKUP_BATCH_SIZE,
  type AssetInfo,
  type BackfillDeps,
  type BackfillCardRow,
} from './backfill-card-asset-refs'

const UUID_1 = '11111111-1111-4111-8111-111111111111'
const UUID_2 = '22222222-2222-4222-8222-222222222222'
const UUID_3 = '33333333-3333-4333-8333-333333333333'
const UUID_MISSING = '99999999-9999-4999-8999-999999999999'
const CARD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function mkCard(
  overrides: Partial<BackfillCardRow> = {},
): BackfillCardRow {
  return {
    id: CARD_ID,
    userId: USER_ID,
    images: [],
    ...overrides,
  }
}

// AssetInfo map builder: [id, status, ownerUserId?] タプル配列から作る
// (ownerUserId 省略時は USER_ID 所有とみなす)。
function infoMap(
  entries: [id: string, status: string, ownerUserId?: string][],
): Map<string, AssetInfo> {
  return new Map(
    entries.map(([id, status, ownerUserId]) => [
      id,
      { status, userId: ownerUserId ?? USER_ID },
    ]),
  )
}

function makeDeps(
  overrides: Partial<BackfillDeps> = {},
): BackfillDeps & {
  fetchCardsMock: ReturnType<typeof vi.fn>
  fetchAssetInfosMock: ReturnType<typeof vi.fn>
  replaceCardRefsMock: ReturnType<typeof vi.fn>
  logMock: ReturnType<typeof vi.fn>
} {
  const fetchCardsMock = vi.fn().mockResolvedValue([])
  const fetchAssetInfosMock = vi.fn().mockResolvedValue(new Map())
  const replaceCardRefsMock = vi.fn().mockResolvedValue(undefined)
  const logMock = vi.fn()
  return {
    fetchCards: fetchCardsMock,
    fetchAssetInfos: fetchAssetInfosMock,
    replaceCardRefs: replaceCardRefsMock,
    log: logMock,
    fetchCardsMock,
    fetchAssetInfosMock,
    replaceCardRefsMock,
    logMock,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// pure projection
// ---------------------------------------------------------------------------
describe('projectCardRefs', () => {
  it('単一 target 複数画像: ordinal が 0,1,2 で採番される', () => {
    const card = mkCard({
      images: [
        { key: UUID_1, target: 'question_text', alt: '' },
        { key: UUID_2, target: 'question_text', alt: '' },
        { key: UUID_3, target: 'question_text', alt: '' },
      ],
    })
    const infos = infoMap([
      [UUID_1, 'ready'],
      [UUID_2, 'ready'],
      [UUID_3, 'ready'],
    ])
    const result = projectCardRefs(card, infos)
    expect(result.refs).toEqual([
      {
        cardId: CARD_ID,
        assetId: UUID_1,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 0,
      },
      {
        cardId: CARD_ID,
        assetId: UUID_2,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 1,
      },
      {
        cardId: CARD_ID,
        assetId: UUID_3,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 2,
      },
    ])
    expect(result.missingAssetIds).toEqual([])
    expect(result.nonReadyAssetIds).toEqual([])
  })

  it('複数 target 混在: question_text と option:x で各々 0-based 採番される', () => {
    const card = mkCard({
      images: [
        { key: UUID_1, target: 'question_text', alt: '' },
        { key: UUID_2, target: 'option:opt-1', alt: '' },
        { key: UUID_3, target: 'question_text', alt: '' },
      ],
    })
    const infos = infoMap([
      [UUID_1, 'ready'],
      [UUID_2, 'ready'],
      [UUID_3, 'ready'],
    ])
    const result = projectCardRefs(card, infos)
    expect(result.refs).toEqual([
      {
        cardId: CARD_ID,
        assetId: UUID_1,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 0,
      },
      {
        cardId: CARD_ID,
        assetId: UUID_2,
        userId: USER_ID,
        fieldKey: 'option:opt-1',
        ordinal: 0,
      },
      {
        cardId: CARD_ID,
        assetId: UUID_3,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 1,
      },
    ])
  })

  it('legacy 非 UUID key は refs に入らず、除外分類にも入らない', () => {
    const card = mkCard({
      images: [
        { key: 'img-legacy-1', target: 'question_text', alt: '' },
        { key: UUID_1, target: 'question_text', alt: '' },
      ],
    })
    const infos = infoMap([[UUID_1, 'ready']])
    const result = projectCardRefs(card, infos)
    expect(result.refs).toEqual([
      {
        cardId: CARD_ID,
        assetId: UUID_1,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 0,
      },
    ])
    expect(result.missingAssetIds).toEqual([])
    expect(result.nonReadyAssetIds).toEqual([])
  })

  it('missing (asset map に無い = 実在しない asset): missingAssetIds へ、ref 行なし', () => {
    const card = mkCard({
      images: [{ key: UUID_MISSING, target: 'question_text', alt: '' }],
    })
    const result = projectCardRefs(card, infoMap([]))
    expect(result.refs).toEqual([])
    expect(result.missingAssetIds).toEqual([UUID_MISSING])
    expect(result.nonReadyAssetIds).toEqual([])
  })

  it('nonReady (実在・同一 user 所有だが status != ready): nonReadyAssetIds へ、ref 行なし', () => {
    const card = mkCard({
      images: [{ key: UUID_1, target: 'question_text', alt: '' }],
    })
    const result = projectCardRefs(card, infoMap([[UUID_1, 'reserved']]))
    expect(result.refs).toEqual([])
    expect(result.missingAssetIds).toEqual([])
    expect(result.nonReadyAssetIds).toEqual([UUID_1])
  })

  // FIX 3 (owner-scope): 実在・status='ready' でも、asset が他 user 所有なら
  // ready-ref 化してはならない (card owner の userId で他 user の asset を指す ref を
  // 書くと owner-scope invariant 違反)。missing 扱い = ref 行なし。
  it('他 user 所有 (status=ready でも): ref 化せず missingAssetIds へ', () => {
    const card = mkCard({
      images: [{ key: UUID_1, target: 'question_text', alt: '' }],
    })
    // UUID_1 は ready だが OTHER_USER_ID 所有 (card owner = USER_ID)
    const result = projectCardRefs(card, infoMap([[UUID_1, 'ready', OTHER_USER_ID]]))
    expect(result.refs).toEqual([])
    expect(result.missingAssetIds).toEqual([UUID_1])
    expect(result.nonReadyAssetIds).toEqual([])
  })

  it('images 空配列: 全て空の結果を返す', () => {
    const card = mkCard({ images: [] })
    const result = projectCardRefs(card, infoMap([]))
    expect(result).toEqual({ refs: [], missingAssetIds: [], nonReadyAssetIds: [] })
  })

  // Task 11 fix round 1 (Important #1): ordinal は「全 UUID entry (ready/owned
  // 問わず) を対象に projectCardAssetRefs で先に採番 → 後段で ready/owned だけを
  // filter する」契約 (旧実装と同一)。同一 target 内で真ん中の entry が
  // nonReady/missing の場合、生き残った ref の ordinal は 0-based 詰め直し
  // (compact) されず、元の出現順の ordinal がそのまま欠番として残ることを
  // pin する。これが崩れる (= 先に card.images を filter してから
  // projectCardAssetRefs を呼ぶ実装に変わる) と ordinal が 0,1 に詰まってしまい、
  // 他 test (別 target に分離済み・missing/nonReady が末尾のみ) では検出できない
  // drift になる。
  it('ordinal gap 保存: 同一 target 内で中間 entry が nonReady でも、生き残る ref の ordinal は詰め直されない', () => {
    const card = mkCard({
      images: [
        { key: UUID_1, target: 'question_text', alt: '' }, // ready → ordinal 0 で残る
        { key: UUID_2, target: 'question_text', alt: '' }, // nonReady → 除外 (ordinal 1 を消費)
        { key: UUID_3, target: 'question_text', alt: '' }, // ready → ordinal 2 で残る (詰め直しなら 1 になってしまう)
      ],
    })
    const infos = infoMap([
      [UUID_1, 'ready'],
      [UUID_2, 'reserved'],
      [UUID_3, 'ready'],
    ])
    const result = projectCardRefs(card, infos)
    expect(result.refs).toEqual([
      {
        cardId: CARD_ID,
        assetId: UUID_1,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 0,
      },
      {
        cardId: CARD_ID,
        assetId: UUID_3,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 2,
      },
    ])
    expect(result.nonReadyAssetIds).toEqual([UUID_2])
    expect(result.missingAssetIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// DI core
// ---------------------------------------------------------------------------
describe('runBackfill', () => {
  it('card 0 件: replaceCardRefs 呼出ゼロ + summary 全 0', async () => {
    const deps = makeDeps()
    const summary = await runBackfill({ dryRun: false }, deps)
    expect(summary).toEqual({
      scannedCards: 0,
      cardsWithUuidKeys: 0,
      refsInserted: 0,
      missingAssetIds: 0,
      nonReadyAssetIds: 0,
      fieldKeyDistribution: { questionText: 0, option: 0 },
    })
    expect(deps.replaceCardRefsMock).not.toHaveBeenCalled()
    expect(deps.fetchAssetInfosMock).not.toHaveBeenCalled()
  })

  it('本実行: 全 card で replaceCardRefs を owner-scope 付きで呼ぶ (legacy-only card も空 refs で DELETE 発火)', async () => {
    const card1 = mkCard({
      id: 'card-1',
      images: [{ key: UUID_1, target: 'question_text', alt: '' }],
    })
    const card2 = mkCard({
      id: 'card-2',
      images: [{ key: 'legacy-key', target: 'question_text', alt: '' }],
    })
    const deps = makeDeps()
    deps.fetchCardsMock.mockResolvedValueOnce([card1, card2])
    deps.fetchAssetInfosMock.mockResolvedValueOnce(infoMap([[UUID_1, 'ready']]))

    const summary = await runBackfill({ dryRun: false }, deps)

    // 全 card を必ず処理する。card2 は UUID key を持たない (生成 refs 空) が、前 run
    // の stale ref を DELETE で落とすため空 refs で必ず呼ぶ (再実行安全)。
    expect(deps.replaceCardRefsMock).toHaveBeenCalledTimes(2)
    expect(deps.replaceCardRefsMock).toHaveBeenCalledWith('card-1', USER_ID, [
      {
        cardId: 'card-1',
        assetId: UUID_1,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 0,
      },
    ])
    expect(deps.replaceCardRefsMock).toHaveBeenCalledWith('card-2', USER_ID, [])
    expect(summary.scannedCards).toBe(2)
    expect(summary.cardsWithUuidKeys).toBe(1)
    expect(summary.refsInserted).toBe(1)
    expect(summary.fieldKeyDistribution).toEqual({ questionText: 1, option: 0 })
  })

  it('dry-run: replaceCardRefs は一切呼ばれないが summary は本実行と同じ集計になる', async () => {
    const card1 = mkCard({
      id: 'card-1',
      images: [{ key: UUID_1, target: 'question_text', alt: '' }],
    })
    const deps = makeDeps()
    deps.fetchCardsMock.mockResolvedValueOnce([card1])
    deps.fetchAssetInfosMock.mockResolvedValueOnce(infoMap([[UUID_1, 'ready']]))

    const summary = await runBackfill({ dryRun: true }, deps)

    expect(deps.replaceCardRefsMock).not.toHaveBeenCalled()
    expect(summary.refsInserted).toBe(1)
    expect(summary.cardsWithUuidKeys).toBe(1)
  })

  it('missing/nonReady 混在: summary に正しく集計され、どちらも ref 化されない', async () => {
    const card1 = mkCard({
      id: 'card-1',
      images: [
        { key: UUID_1, target: 'question_text', alt: '' }, // ready
        { key: UUID_2, target: 'question_text', alt: '' }, // nonReady
        { key: UUID_MISSING, target: 'option:opt-1', alt: '' }, // missing
      ],
    })
    const deps = makeDeps()
    deps.fetchCardsMock.mockResolvedValueOnce([card1])
    deps.fetchAssetInfosMock.mockResolvedValueOnce(
      infoMap([
        [UUID_1, 'ready'],
        [UUID_2, 'reserved'],
      ]),
    )

    const summary = await runBackfill({ dryRun: false }, deps)

    expect(summary.refsInserted).toBe(1)
    expect(summary.nonReadyAssetIds).toBe(1)
    expect(summary.missingAssetIds).toBe(1)
    expect(deps.replaceCardRefsMock).toHaveBeenCalledWith('card-1', USER_ID, [
      {
        cardId: 'card-1',
        assetId: UUID_1,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 0,
      },
    ])
  })

  it('field_key(target) 分布: question_text と option:* の件数を summary に集計する', async () => {
    const card1 = mkCard({
      id: 'card-1',
      images: [
        { key: UUID_1, target: 'question_text', alt: '' },
        { key: UUID_2, target: 'option:opt-1', alt: '' },
        { key: UUID_3, target: 'option:opt-2', alt: '' },
      ],
    })
    const deps = makeDeps()
    deps.fetchCardsMock.mockResolvedValueOnce([card1])
    deps.fetchAssetInfosMock.mockResolvedValueOnce(
      infoMap([
        [UUID_1, 'ready'],
        [UUID_2, 'ready'],
        [UUID_3, 'ready'],
      ]),
    )

    const summary = await runBackfill({ dryRun: false }, deps)
    expect(summary.fieldKeyDistribution).toEqual({ questionText: 1, option: 2 })
  })

  it('--user filter: 指定 userId の card のみ対象になり、他 user card は処理されない', async () => {
    const cardA = mkCard({ id: 'card-a', userId: 'user-a', images: [] })
    const cardB = mkCard({ id: 'card-b', userId: 'user-b', images: [] })
    const deps = makeDeps()
    // 本番 fetchCards は WHERE user_id を query に押し込むが、DI core も defense-in-depth
    // で filter する。ここでは fetchCards が両 user を返しても user-a のみ対象化される
    // ことを検証 (core 側 filter の担保)。
    deps.fetchCardsMock.mockResolvedValueOnce([cardA, cardB])

    const summary = await runBackfill({ dryRun: false, userId: 'user-a' }, deps)
    expect(summary.scannedCards).toBe(1)
    // card-b (他 user) は replaceCardRefs されない。card-a のみ処理される。
    expect(deps.replaceCardRefsMock).toHaveBeenCalledTimes(1)
    expect(deps.replaceCardRefsMock).toHaveBeenCalledWith('card-a', 'user-a', [])
  })

  // 再実行安全性: card 単位で refs を「全置換」するため、直前 run で生成された
  // stale ref (今回の images に無くなったもの) が消えることを実 mock で検証する。
  // replaceCardRefs はプロダクション実装では DELETE→INSERT を行うが、ここでは
  // 呼出し引数 (=次に残るべき refs の全量) を検証することで「全置換」契約を担保する。
  it('再実行安全性: 2 回目 run で images から消えた画像の ref が渡す refs から欠落する (= 全置換で消える)', async () => {
    // 1 回目: UUID_1, UUID_2 の 2 枚
    const cardV1 = mkCard({
      id: 'card-1',
      images: [
        { key: UUID_1, target: 'question_text', alt: '' },
        { key: UUID_2, target: 'question_text', alt: '' },
      ],
    })
    const deps1 = makeDeps()
    deps1.fetchCardsMock.mockResolvedValueOnce([cardV1])
    deps1.fetchAssetInfosMock.mockResolvedValueOnce(
      infoMap([
        [UUID_1, 'ready'],
        [UUID_2, 'ready'],
      ]),
    )
    await runBackfill({ dryRun: false }, deps1)
    expect(deps1.replaceCardRefsMock).toHaveBeenCalledWith('card-1', USER_ID, [
      expect.objectContaining({ assetId: UUID_1 }),
      expect.objectContaining({ assetId: UUID_2 }),
    ])

    // 2 回目: UUID_2 の画像が images から削除された (UUID_1 のみ残る)。
    // 全置換なので replaceCardRefs に渡す refs には UUID_2 が含まれてはならない
    // (= 呼び出し先で行われる DELETE が UUID_2 の stale ref を実際に落とす契約)。
    const cardV2 = mkCard({
      id: 'card-1',
      images: [{ key: UUID_1, target: 'question_text', alt: '' }],
    })
    const deps2 = makeDeps()
    deps2.fetchCardsMock.mockResolvedValueOnce([cardV2])
    deps2.fetchAssetInfosMock.mockResolvedValueOnce(infoMap([[UUID_1, 'ready']]))
    await runBackfill({ dryRun: false }, deps2)
    expect(deps2.replaceCardRefsMock).toHaveBeenCalledTimes(1)
    const [, , refsArg] = deps2.replaceCardRefsMock.mock.calls[0]!
    expect(refsArg).toHaveLength(1)
    expect(refsArg.some((r: { assetId: string }) => r.assetId === UUID_2)).toBe(
      false,
    )
  })

  // 実 DELETE→INSERT の全置換契約そのもの (mock がクエリを本当に実行することの
  // 検証) は in-memory な擬似 store を deps に仕込み、2 回目呼出しで実際に
  // stale ref が消えることをアサートする。
  it('再実行安全性(実 store 検証): replaceCardRefs を in-memory store でエミュレートし、2 回目 run で stale ref が実際に消える', async () => {
    type StoredRef = {
      userId: string
      assetId: string
      fieldKey: string
      ordinal: number
    }
    const store = new Map<string, StoredRef[]>()
    const replaceCardRefs = vi.fn(
      async (cardId: string, userId: string, refs: StoredRef[]) => {
        // owner-scope DELETE (WHERE card_id AND user_id) then INSERT を模す。
        const remaining = (store.get(cardId) ?? []).filter(
          (r) => r.userId !== userId,
        )
        const next = [...remaining, ...refs]
        if (next.length > 0) store.set(cardId, next)
        else store.delete(cardId)
      },
    )

    // 1 回目 run: UUID_1, UUID_2 の 2 枚が refs として書き込まれる
    const deps1 = makeDeps({ replaceCardRefs })
    deps1.fetchCardsMock.mockResolvedValueOnce([
      mkCard({
        id: 'card-1',
        images: [
          { key: UUID_1, target: 'question_text', alt: '' },
          { key: UUID_2, target: 'question_text', alt: '' },
        ],
      }),
    ])
    deps1.fetchAssetInfosMock.mockResolvedValueOnce(
      infoMap([
        [UUID_1, 'ready'],
        [UUID_2, 'ready'],
      ]),
    )
    await runBackfill({ dryRun: false }, deps1)
    expect(store.get('card-1')).toHaveLength(2)

    // 2 回目 run: images から UUID_2 が消えた状態で再実行 → store から UUID_2 が消える
    const deps2 = makeDeps({ replaceCardRefs })
    deps2.fetchCardsMock.mockResolvedValueOnce([
      mkCard({
        id: 'card-1',
        images: [{ key: UUID_1, target: 'question_text', alt: '' }],
      }),
    ])
    deps2.fetchAssetInfosMock.mockResolvedValueOnce(infoMap([[UUID_1, 'ready']]))
    await runBackfill({ dryRun: false }, deps2)

    const finalRefs = store.get('card-1')
    expect(finalRefs).toHaveLength(1)
    expect(finalRefs?.[0]?.assetId).toBe(UUID_1)
    expect(finalRefs?.some((r) => r.assetId === UUID_2)).toBe(false)
  })

  // FIX 1 (spec §4.10「消えた refs も消える」): card が UUID 画像ありから「UUID
  // 画像ゼロ」に変わった場合、前 run の ref が DELETE で完全に消え、card の ref が
  // 0 件になること。UUID key ゼロの card を skip すると stale ref が残り、GC が
  // orphan を参照中と誤認する (回収漏れ) ため、全 card を必ず処理する。
  it('再実行安全性(UUID→ゼロ): card が UUID 画像を全て失った場合、前 run の ref が全消えする', async () => {
    type StoredRef = { userId: string; assetId: string }
    const store = new Map<string, StoredRef[]>()
    const replaceCardRefs = vi.fn(
      async (cardId: string, userId: string, refs: StoredRef[]) => {
        const remaining = (store.get(cardId) ?? []).filter(
          (r) => r.userId !== userId,
        )
        const next = [...remaining, ...refs]
        if (next.length > 0) store.set(cardId, next)
        else store.delete(cardId)
      },
    )

    // 1 回目 run: UUID_1 を持つ card → ref 1 件
    const deps1 = makeDeps({ replaceCardRefs })
    deps1.fetchCardsMock.mockResolvedValueOnce([
      mkCard({
        id: 'card-1',
        images: [{ key: UUID_1, target: 'question_text', alt: '' }],
      }),
    ])
    deps1.fetchAssetInfosMock.mockResolvedValueOnce(infoMap([[UUID_1, 'ready']]))
    await runBackfill({ dryRun: false }, deps1)
    expect(store.get('card-1')).toHaveLength(1)

    // 2 回目 run: 同 card が images 空 (全画像削除) で再取得される。UUID key ゼロでも
    // skip せず replaceCardRefs を空 refs で呼び、DELETE で stale ref を落とす。
    const deps2 = makeDeps({ replaceCardRefs })
    deps2.fetchCardsMock.mockResolvedValueOnce([
      mkCard({ id: 'card-1', images: [] }),
    ])
    await runBackfill({ dryRun: false }, deps2)

    // 空 refs でも DELETE は必ず発火する (呼出しは行われる。deps に注入した
    // replaceCardRefs 自体を検証 — makeDeps override 時は内部 mock でなく本体が走る)。
    expect(replaceCardRefs).toHaveBeenLastCalledWith('card-1', USER_ID, [])
    // UUID 画像ゼロなので asset 問い合わせは走らない。
    expect(deps2.fetchAssetInfosMock).not.toHaveBeenCalled()
    // store から card-1 の ref が完全に消える (0 件)。
    expect(store.has('card-1')).toBe(false)
  })

  // FIX 6 (bounded IN): candidate 数が batch size を超えると fetchAssetInfos を
  // 複数回に分割して呼び、Map を merge する (Postgres bind 上限 65535 の巨大 IN 回避)。
  it('bounded IN: candidate が batch size を超えたら fetchAssetInfos が分割呼出しされ、全 candidate が解決される', async () => {
    // batch size + 1 件の distinct UUID asset を持つ 1 card を作る (1 batch 目 full +
    // 2 batch 目 1 件)。全て ready。
    const total = ASSET_LOOKUP_BATCH_SIZE + 1
    const ids = Array.from(
      { length: total },
      // 決定的な UUIDv4 形式 (isAssetKey が通る version=4 / variant=8): 連番を末尾に埋める
      (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
    )
    const card = mkCard({
      id: 'card-big',
      images: ids.map((key, i) => ({
        key,
        target: `option:opt-${i}`,
        alt: '',
      })),
    })

    const deps = makeDeps()
    deps.fetchCardsMock.mockResolvedValueOnce([card])
    // batch ごとに、渡された id 集合を ready として返す (実 query の per-batch 挙動を模す)。
    deps.fetchAssetInfosMock.mockImplementation(async (batch: string[]) =>
      infoMap(batch.map((id) => [id, 'ready'] as [string, string])),
    )

    const summary = await runBackfill({ dryRun: false }, deps)

    // 2 回に分割呼出しされる (batch size 件 + 残 1 件)。
    expect(deps.fetchAssetInfosMock).toHaveBeenCalledTimes(2)
    expect(deps.fetchAssetInfosMock.mock.calls[0]![0]).toHaveLength(
      ASSET_LOOKUP_BATCH_SIZE,
    )
    expect(deps.fetchAssetInfosMock.mock.calls[1]![0]).toHaveLength(1)
    // batch 境界に跨っても全 candidate が解決され ref 化される (欠損なし)。
    expect(summary.refsInserted).toBe(total)
    expect(summary.missingAssetIds).toBe(0)
  })
})

describe('parseUserFlag', () => {
  it('--user 無し: undefined (全 user backfill・意図的)', () => {
    expect(parseUserFlag(['node', 'script.ts'])).toBeUndefined()
    expect(parseUserFlag(['node', 'script.ts', '--dry-run'])).toBeUndefined()
  })

  it('--user <値>: 値を返す', () => {
    expect(parseUserFlag(['node', 'script.ts', '--user', 'user-123'])).toBe(
      'user-123',
    )
    // 他 flag と混在しても直後の値を取る
    expect(
      parseUserFlag(['node', 'script.ts', '--dry-run', '--user', 'user-123']),
    ).toBe('user-123')
  })

  it('--user 値なし (末尾): fail-fast で throw (全 user 誤爆防止)', () => {
    expect(() => parseUserFlag(['node', 'script.ts', '--user'])).toThrow(
      /--user requires a userId value/,
    )
  })

  it('--user の直後が別 flag: fail-fast で throw', () => {
    expect(() =>
      parseUserFlag(['node', 'script.ts', '--user', '--dry-run']),
    ).toThrow(/--user requires a userId value/)
  })
})
