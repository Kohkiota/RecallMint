import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'

import {
  planPublish,
  buildCardRows,
  buildResultSummary,
  isCropBudgetExhausted,
  type FigureDisposition,
  type PublishDecision,
} from './publish-prepared-plan'
import type { PreparedCard, PreparedFigure, PreparedPayloadV1 } from '@/lib/ocr/prepared-schema'

// ②-4a T12 pure planner の単体 test。 crop / DB / R2 に触れない純関数の決定ロジック
// (disposition → images / 除外集計 / publish 条件 / card row 変換 / result_summary)を pin。

function makeFigure(target = 'question_text'): PreparedFigure {
  return { assetId: randomUUID(), sourceId: 's1', box_2d: [0, 0, 100, 100], target, label: null }
}

function makeCard(overrides: Partial<PreparedCard> = {}): PreparedCard {
  return {
    cardId: randomUUID(),
    title: 'T',
    sortKey: null,
    questionText: 'Q?',
    options: [
      { id: 'a', uid: randomUUID(), text: 'A', isCorrect: true },
      { id: 'b', uid: randomUUID(), text: 'B', isCorrect: false },
    ],
    correctAnswerIds: ['a'],
    explanationText: null,
    memo: null,
    figures: [],
    customProps: {},
    ...overrides,
  }
}

function dispositions(entries: Array<[string, FigureDisposition]>): Map<string, FigureDisposition> {
  return new Map(entries)
}

function asPublish(decision: PublishDecision): Extract<PublishDecision, { decision: 'publish' }> {
  if (decision.decision !== 'publish') throw new Error(`expected publish, got ${decision.decision}`)
  return decision
}

describe('planPublish', () => {
  it('not_ours が 1 件でもあれば stale(retryable と共存しても not_ours 優先)', () => {
    const fA = makeFigure()
    const fB = makeFigure()
    const card = makeCard({ figures: [fA, fB] })
    const plan = planPublish(
      [card],
      dispositions([
        [fA.assetId, 'retryable'],
        [fB.assetId, 'not_ours'],
      ]),
    )
    expect(plan).toEqual({ decision: 'stale' })
  })

  it('retryable が 1 件でもあれば(not_ours 無し)retryable', () => {
    const fA = makeFigure()
    const fB = makeFigure()
    const card = makeCard({ figures: [fA, fB] })
    const plan = planPublish(
      [card],
      dispositions([
        [fA.assetId, 'attach'],
        [fB.assetId, 'retryable'],
      ]),
    )
    expect(plan).toEqual({ decision: 'retryable' })
  })

  it('attach → card image / exclude → crop_failed 計上(crop 全滅でも publish)', () => {
    const fAttach = makeFigure('question_text')
    const fExclude = makeFigure('explanation_text')
    const card = makeCard({ figures: [fAttach, fExclude] })
    const plan = asPublish(
      planPublish(
        [card],
        dispositions([
          [fAttach.assetId, 'attach'],
          [fExclude.assetId, 'exclude'],
        ]),
      ),
    )
    expect(plan.cardImagesByCardId[card.cardId]).toEqual([
      { key: fAttach.assetId, target: 'question_text', alt: '' },
    ])
    expect(plan.figuresAttached).toBe(1)
    expect(plan.figureExclusions.crop_failed).toBe(1)
    expect(plan.figureExclusions.image_limit_exceeded).toBe(0)
    expect(plan.expectedReadyAssetIds).toEqual([fAttach.assetId])
  })

  it('crop 全滅(全 exclude)でも publish・image は空・expectedReadyAssetIds 空', () => {
    const f1 = makeFigure()
    const f2 = makeFigure()
    const card = makeCard({ figures: [f1, f2] })
    const plan = asPublish(
      planPublish(
        [card],
        dispositions([
          [f1.assetId, 'exclude'],
          [f2.assetId, 'exclude'],
        ]),
      ),
    )
    expect(plan.cardImagesByCardId[card.cardId]).toEqual([])
    expect(plan.figuresAttached).toBe(0)
    expect(plan.figureExclusions.crop_failed).toBe(2)
    expect(plan.expectedReadyAssetIds).toEqual([])
  })

  it('images ≤ 10 超過は決定順で先頭 10 件採用 + 残りを image_limit_exceeded 計上', () => {
    const figures = Array.from({ length: 13 }, () => makeFigure())
    const card = makeCard({ figures })
    const plan = asPublish(
      planPublish(
        [card],
        dispositions(figures.map((f) => [f.assetId, 'attach' as FigureDisposition])),
      ),
    )
    // 決定順(figures 配列順)の先頭 10 件のみ image になる。
    expect(plan.cardImagesByCardId[card.cardId]).toHaveLength(10)
    expect(plan.cardImagesByCardId[card.cardId].map((i) => i.key)).toEqual(
      figures.slice(0, 10).map((f) => f.assetId),
    )
    expect(plan.figuresAttached).toBe(10)
    expect(plan.figureExclusions.image_limit_exceeded).toBe(3)
    expect(plan.expectedReadyAssetIds).toHaveLength(10)
  })

  it('deadline_excluded は crop_failed と別カウント(spec §13 reason g)、text card は publish される', () => {
    const fAttach = makeFigure('question_text')
    const fDeadline = makeFigure('explanation_text')
    const card = makeCard({ figures: [fAttach, fDeadline] })
    const plan = asPublish(
      planPublish(
        [card],
        dispositions([
          [fAttach.assetId, 'attach'],
          [fDeadline.assetId, 'deadline_excluded'],
        ]),
      ),
    )
    expect(plan.cardImagesByCardId[card.cardId]).toEqual([
      { key: fAttach.assetId, target: 'question_text', alt: '' },
    ])
    expect(plan.figuresAttached).toBe(1)
    expect(plan.figureExclusions.deadline_excluded).toBe(1)
    expect(plan.figureExclusions.crop_failed).toBe(0)
  })

  it('expectedReadyAssetIds は複数 card 横断で union・昇順・重複排除', () => {
    const f1 = makeFigure()
    const f2 = makeFigure()
    const c1 = makeCard({ figures: [f1] })
    const c2 = makeCard({ figures: [f2] })
    const plan = asPublish(
      planPublish(
        [c1, c2],
        dispositions([
          [f1.assetId, 'attach'],
          [f2.assetId, 'attach'],
        ]),
      ),
    )
    expect(plan.expectedReadyAssetIds).toEqual([f1.assetId, f2.assetId].sort())
  })
})

describe('buildCardRows', () => {
  it('option を camelCase isCorrect → snake_case is_correct へ変換(uid/explanation 保持)', () => {
    const card = makeCard({
      options: [
        { id: 'a', uid: 'uid-a', text: 'A', isCorrect: true, explanation: 'exp-a' },
        { id: 'b', uid: 'uid-b', text: 'B', isCorrect: false },
      ],
    })
    const rows = buildCardRows([card], {}, {
      userId: 'u1',
      examId: 'e1',
      sourceDocumentId: 'sd1',
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(card.cardId)
    expect(rows[0].examId).toBe('e1')
    expect(rows[0].sourceDocumentId).toBe('sd1')
    expect(rows[0].options).toEqual([
      { id: 'a', uid: 'uid-a', text: 'A', is_correct: true, explanation: 'exp-a' },
      { id: 'b', uid: 'uid-b', text: 'B', is_correct: false },
    ])
  })

  it('images は cardImagesByCardId から採る(無ければ空配列)', () => {
    const withFig = makeCard()
    const withoutFig = makeCard()
    const img = { key: randomUUID(), target: 'question_text', alt: '' }
    const rows = buildCardRows(
      [withFig, withoutFig],
      { [withFig.cardId]: [img] },
      { userId: 'u1', examId: 'e1', sourceDocumentId: null },
    )
    expect(rows[0].images).toEqual([img])
    expect(rows[1].images).toEqual([])
  })
})

describe('buildResultSummary', () => {
  it('normalize 時 + crop 時の除外理由を統合し preview を含む(本文全文は含めない)', () => {
    const card = makeCard({ title: 'カード1', questionText: 'x'.repeat(120) })
    const payload: PreparedPayloadV1 = {
      schemaVersion: 1,
      cards: [card],
      cardsTotal: 3,
      cardsExcluded: 2,
      figuresExcluded: {
        coordinate_null: 1,
        source_id_invalid: 2,
        malformed: 3,
        asset_id_invalid: 4,
      },
    }
    const plan = asPublish(planPublish([card], new Map()))
    // crop 集計を直接差し込む(planPublish 由来の値でも良いが reason 統合を pin する)。
    const planWithCounts = {
      ...plan,
      figuresAttached: 5,
      figureExclusions: { crop_failed: 6, image_limit_exceeded: 7, deadline_excluded: 8 },
    }
    const summary = buildResultSummary(payload, planWithCounts, {
      operationId: 'op1',
      examId: 'e1',
      sourceDocumentId: 'sd1',
    })
    expect(summary.cardsExtracted).toBe(1)
    expect(summary.cardsTotal).toBe(3)
    expect(summary.cardsExcluded).toBe(2)
    expect(summary.figuresAttached).toBe(5)
    expect(summary.figuresExcluded).toEqual({
      coordinate_null: 1,
      source_id_invalid: 2,
      malformed: 3,
      asset_id_invalid: 4,
      crop_failed: 6,
      image_limit_exceeded: 7,
      deadline_excluded: 8,
    })
    const preview = summary.cardsPreview as Array<{ questionSnippet: string; title: string }>
    expect(preview[0].title).toBe('カード1')
    // snippet は 80 文字上限(本文全文は保存しない・spec §14)。
    expect(preview[0].questionSnippet).toHaveLength(80)
  })
})

// ②-4a T14a: crop フェーズ time budget 判定の純関数(spec §11 deadline)。
describe('isCropBudgetExhausted', () => {
  it('残り予算が最低予算以上なら false(まだ crop を試みてよい)', () => {
    // deadline まで 10_000ms 残っており、 最低予算 5_000ms 以上ある。
    expect(isCropBudgetExhausted(0, 10_000, 5_000)).toBe(false)
  })

  it('残り予算がちょうど最低予算なら false(境界は許容側)', () => {
    expect(isCropBudgetExhausted(0, 5_000, 5_000)).toBe(false)
  })

  it('残り予算が最低予算を下回れば true(次の crop を試みない)', () => {
    expect(isCropBudgetExhausted(0, 4_999, 5_000)).toBe(true)
  })

  it('deadline を過ぎていれば true(残り予算が負)', () => {
    expect(isCropBudgetExhausted(10_000, 1_000, 5_000)).toBe(true)
  })
})
