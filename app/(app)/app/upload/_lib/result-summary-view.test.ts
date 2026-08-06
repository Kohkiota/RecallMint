// ②-4a T16-a: `upload_operations.result_summary` → 画面表示用 view への畳み込みの pin。
//
// 何を保証するか:
//   ① 7 つの figure 除外理由がどの束(取り込めなかった / 上限で省いた)に入るかを
//      1 件ずつ固定する。束の割り当てが変われば必ず fail する。
//   ② 出すものが何も無い summary(除外 0 + 図版 0)は null(= 表示しない)。
//   ③ jsonb の中身が契約どおりでない場合も null(= 黙る。throw しない)。
//   ④ **producer と読み手の理由キー集合の drift pin**(最後の describe)。
// 何を保証しないか: 文言(constants.ts 側)と、どの line をどう並べるか(page 側)。

import { describe, expect, it } from 'vitest'

import { figureExclusionTalliesSchema } from '@/lib/ocr/prepared-schema'
import type { FigureExclusionTallies, PreparedPayloadV1 } from '@/lib/ocr/prepared-schema'

import { buildResultSummary, planPublish } from './publish-prepared-plan'
import { buildUploadResultSummaryView } from './result-summary-view'

// producer(`publish-prepared-plan.ts` の `buildResultSummary`)が書く形を**手で**
// 書き写した fixture。 この helper だけは意図的に producer を呼ばない — 読み手側の契約
// (どのキーがどの束に入るか / 何を出さないか)を producer の実装と独立に固定するため、
// producer が変わっても この helper の期待値は変わらない。
//
// **file 全体としては producer を import している**(最後の describe = drift pin)。
// そちらは逆に producer の実物からキー集合を取り、読み手との一致を機械強制する役割で、
// 独立固定(この helper)と drift 検出(drift pin)の 2 本立てになっている。
function summary(over: {
  cards?: Partial<{ cardsExtracted: number; cardsTotal: number; cardsExcluded: number }>
  figuresAttached?: number
  figuresExcluded?: Partial<Record<string, number>>
} = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operationId: 'op-1',
    examId: 'exam-1',
    sourceDocumentId: 'doc-1',
    cardsExtracted: 3,
    cardsTotal: 3,
    cardsExcluded: 0,
    ...over.cards,
    figuresAttached: over.figuresAttached ?? 0,
    figuresExcluded: {
      coordinate_null: 0,
      source_id_invalid: 0,
      malformed: 0,
      asset_id_invalid: 0,
      crop_failed: 0,
      image_limit_exceeded: 0,
      deadline_excluded: 0,
      orientation_unsupported: 0,
      ...over.figuresExcluded,
    },
    cardsPreview: [],
  }
}

const FAILED_REASONS = [
  'coordinate_null',
  'source_id_invalid',
  'malformed',
  'asset_id_invalid',
  'crop_failed',
  // T16-b: EXIF≠1(向き未対応)。 回転は入力側の性質だが、「上限のため」は嘘になる —
  // こちらが上限を決めて打ち切ったのではなく**扱えなかった**から(OT 決定)。
  'orientation_unsupported',
] as const

const CAPPED_REASONS = ['image_limit_exceeded', 'deadline_excluded'] as const

describe('buildUploadResultSummaryView — 3 束への畳み込み', () => {
  it.each(FAILED_REASONS)(
    '%s は「取り込めなかった」束に入る(上限束には入らない)',
    (reason) => {
      const view = buildUploadResultSummaryView(
        summary({ figuresExcluded: { [reason]: 1 } }),
      )
      expect(view).not.toBeNull()
      expect(view!.figuresFailed).toBe(1)
      expect(view!.figuresCapped).toBe(0)
    },
  )

  it.each(CAPPED_REASONS)(
    '%s は「上限で省いた」束に入る(失敗束には入らない)',
    (reason) => {
      const view = buildUploadResultSummaryView(
        summary({ figuresExcluded: { [reason]: 1 } }),
      )
      expect(view).not.toBeNull()
      expect(view!.figuresCapped).toBe(1)
      expect(view!.figuresFailed).toBe(0)
    },
  )

  it('同一束の理由は合算される(理由コードを個別に見せない)', () => {
    const view = buildUploadResultSummaryView(
      summary({
        figuresAttached: 2,
        figuresExcluded: {
          coordinate_null: 1,
          source_id_invalid: 2,
          malformed: 3,
          asset_id_invalid: 4,
          crop_failed: 5,
          image_limit_exceeded: 6,
          deadline_excluded: 7,
          orientation_unsupported: 8,
        },
      }),
    )
    expect(view).toEqual({
      cardsExtracted: 3,
      cardsTotal: 3,
      cardsExcluded: 0,
      figuresAttached: 2,
      figuresFailed: 23,
      figuresCapped: 13,
    })
  })

  it('card の N/M はそのまま透過する(理由別内訳は持たない)', () => {
    const view = buildUploadResultSummaryView(
      summary({ cards: { cardsExtracted: 9, cardsTotal: 11, cardsExcluded: 2 } }),
    )
    expect(view).not.toBeNull()
    expect(view!.cardsExtracted).toBe(9)
    expect(view!.cardsTotal).toBe(11)
    expect(view!.cardsExcluded).toBe(2)
  })
})

describe('buildUploadResultSummaryView — 表示しない条件', () => {
  it('出すものが何も無い(図版 0 / 除外 0 / card 除外 0)なら null', () => {
    expect(buildUploadResultSummaryView(summary())).toBeNull()
  })

  it('card 除外だけがある場合は null にしない(N/M を出す面がある)', () => {
    expect(
      buildUploadResultSummaryView(
        summary({ cards: { cardsExtracted: 2, cardsTotal: 3, cardsExcluded: 1 } }),
      ),
    ).not.toBeNull()
  })

  it('取り込んだ図版があれば null にしない(除外 0 でも成功を出す)', () => {
    expect(buildUploadResultSummaryView(summary({ figuresAttached: 1 }))).not.toBeNull()
  })
})

// T16-b Fix round 1: 新設キーだけ `.default(0)`。 本 deploy 前に書かれた行(7 キー)を
// 必須で弾くと、過去 doc の内訳ブロックが丸ごと消える = T16-a が潰した silent zero の
// 再発(11 問取れたときと 0 問のときが同じ見た目に戻る)。
describe('buildUploadResultSummaryView — 旧 deploy が書いた行の後方互換', () => {
  it('orientation_unsupported が無い(T16-b 以前の)summary も内訳を描画する', () => {
    const raw = summary({
      figuresAttached: 2,
      figuresExcluded: { crop_failed: 3, deadline_excluded: 1 },
    })
    delete (raw.figuresExcluded as Record<string, unknown>).orientation_unsupported

    const view = buildUploadResultSummaryView(raw)

    // 表示が消えない(この 1 行が後方互換の本体)。
    expect(view).not.toBeNull()
    expect(view!.figuresAttached).toBe(2)
    // 欠けたキーは 0 扱い = 束の合計を動かさない。 0 と読むのが嘘にならないのは、
    // 旧 deploy に EXIF 検知の機構自体が無く、実値が推定でなく事実として 0 だから。
    expect(view!.figuresFailed).toBe(3)
    expect(view!.figuresCapped).toBe(1)
  })
})

describe('buildUploadResultSummaryView — 契約外の入力は黙る', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['配列', []],
    ['文字列', 'nope'],
  ])('%s は null(throw しない)', (_label, raw) => {
    expect(buildUploadResultSummaryView(raw)).toBeNull()
  })

  it('figuresExcluded ごと欠けていれば null', () => {
    const raw = summary()
    delete raw.figuresExcluded
    expect(buildUploadResultSummaryView(raw)).toBeNull()
  })

  it('理由キーが 1 つ欠けていれば null(欠けたぶんを 0 と偽らない)', () => {
    const raw = summary({ figuresExcluded: { crop_failed: 1 } })
    delete (raw.figuresExcluded as Record<string, unknown>).deadline_excluded
    expect(buildUploadResultSummaryView(raw)).toBeNull()
  })

  it('件数が数値でなければ null', () => {
    expect(
      buildUploadResultSummaryView({
        ...summary({ figuresAttached: 1 }),
        cardsTotal: '3',
      }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// drift pin: producer が書く理由キー集合 == 読み手が畳む理由キー集合
//
// なぜ要るか: 理由キーを producer に足して読み手の束分けを更新し忘れると、
// zod が未知キーを **strip して parse は成功する**ため、
// **新理由がどちらの束にも入らず静かに過少計上される**(「取り込めなかった 2 件」という
// もっともらしいが誤った数字が出る)。 表示が消えるより悪い — 消えれば気付くが、
// 少ない数字は気付かない。 spec §13「loud failure over silent zero」を潰すために作った面に
// 同じ silent zero を 1 段上で作り直すことになる。
// この穴を**申し送り(人の記憶)でなく test で**閉じる。
//
// 起点は producer 側の 2 箇所を**実物から**取る(値をハードコードしたら二重定義になり
// drift を検出できない):
//   ① normalize 時の理由 = `figureExclusionTalliesSchema.shape` のキー
//   ② crop/publish 時の理由 = `planPublish()` が初期化する `figureExclusions` のキー
//   ③ 実際に result_summary へ載るキー = `buildResultSummary()` の実出力
//
// 読み手側のキー集合は**振る舞いで**測る(`result-summary-view.ts` の schema は
// 非 export で、export させるのは production code の変更になるため)。 1 キーだけ 1 に
// した summary を通し「ちょうど 1 つの束が 1 増える」ことを見る形は、キー集合の一致
// (取りこぼし = 0 束)と二重計上(2 束)を**同時に**検出するので、キー list を読むより
// 強い。
// ---------------------------------------------------------------------------
// producer の実物から 3 起点を取る。 **describe 収集時でなく test 本体から呼ぶ** —
// 収集時に throw すると 1 test でなく file 全体(= 読み手の契約 pin 19 本を含む全部)が
// 落ち、原因の特定が遅れる。
function readProducerKeys() {
  // ② crop/publish 側。 figure が 1 件も無い plan でもキーは 0 で初期化される。
  const cropPlan = planPublish([], new Map())
  if (cropPlan.decision !== 'publish') {
    throw new Error(`planPublish([]) must decide publish, got ${cropPlan.decision}`)
  }

  // ① normalize 側。
  const normalizeKeys = Object.keys(figureExclusionTalliesSchema.shape)
  const cropKeys = Object.keys(cropPlan.figureExclusions)

  // ③ 実際に result_summary へ載るキー(producer の実出力)。
  const payload: PreparedPayloadV1 = {
    schemaVersion: 1,
    cards: [],
    cardsTotal: 0,
    cardsExcluded: 0,
    // 本 pin は **figure** 理由キーの producer↔読み手 drift を見る。card 側の
    // 内訳(A)は読み手の束分けに入らない(表示 scope 外)ため、ここでは 0 で埋めて
    // figure 側の測定に影響させない。
    cardsExcludedReasons: { malformed: 0, invariant_failed: 0, card_id_invalid: 0 },
    figuresExcluded: Object.fromEntries(
      normalizeKeys.map((k) => [k, 1]),
    ) as FigureExclusionTallies,
  }
  const produced = buildResultSummary(payload, cropPlan, {
    operationId: 'op-1',
    examId: 'exam-1',
    sourceDocumentId: 'doc-1',
  })
  const producedKeys = Object.keys(produced.figuresExcluded as Record<string, number>)

  return { normalizeKeys, cropKeys, produced, producedKeys }
}

describe('producer ↔ 読み手 の理由キー drift pin', () => {
  it('buildResultSummary は normalize 側 + crop 側の全理由を載せる(どちらかの追加を落とさない)', () => {
    const { normalizeKeys, cropKeys, producedKeys } = readProducerKeys()

    expect(new Set(producedKeys)).toEqual(new Set([...normalizeKeys, ...cropKeys]))
  })

  it('producer が実際に書く summary は読み手を素通りする(読み手だけが要求するキーが無い)', () => {
    const { produced } = readProducerKeys()

    expect(buildUploadResultSummaryView(produced)).not.toBeNull()
  })

  it('producer の全理由キーが ちょうど 1 つの束に入る(取りこぼし / 二重計上の同時検出)', () => {
    const { produced, producedKeys } = readProducerKeys()
    const allZero = Object.fromEntries(producedKeys.map((k) => [k, 0]))

    for (const key of producedKeys) {
      const view = buildUploadResultSummaryView({
        ...produced,
        figuresAttached: 0,
        figuresExcluded: { ...allZero, [key]: 1 },
      })
      // 束に入らない理由は「除外 0」と同義になり、ブロックごと消える(= null)。
      expect(view, `${key} がどの束にも入っていない`).not.toBeNull()
      expect(
        view!.figuresFailed + view!.figuresCapped,
        `${key} は ちょうど 1 つの束に 1 件として入ること`,
      ).toBe(1)
    }
  })
})
