import { describe, it, expect } from 'vitest'
import {
  normalizePrepared,
  normalizePreparedCard,
  type IdFactory,
} from './normalize-prepared'
import { preparedCardSchema } from './prepared-schema'

// ---------------------------------------------------------------------------
// test helpers
// ---------------------------------------------------------------------------

// 決定的・衝突しない v4 UUID 文字列を index から生成する(8-4-4-4-12 hex・
// version nibble=4・variant nibble=8 固定)。 isAssetKey / preparedCardSchema の
// v4 検証を通す必要があるテストで使う。
function uuidAt(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

// 決定的 counter factory: 呼ぶたびに uuidAt(1), uuidAt(2), … を順に返す。
function makeUuidFactory(seed = 1): IdFactory {
  let counter = seed
  return () => uuidAt(counter++)
}

// dropped card (構造破損) は factory を一切呼ばないことを証明するための
// throwing factory。 **業務規則(title 長さ/options 個数/option 境界等)による
// drop はこの契約の対象外**: `preparedCardSchema` 一本化(spec §5.4)により、
// candidate は必ずフル構築してから 1 回の safeParse で判定するため、 業務規則
// 違反の card でも cardId/options/figures の id は全て消費される(これは
// whack-a-mole を避けるための意図的なトレードオフ・report 参照)。
const throwingFactory: IdFactory = () => {
  throw new Error('id factory should not be called for a structurally-broken card')
}

// 呼出順を明示制御して cardId/assetId の malformed・重複ケースを再現するための
// 固定シーケンス factory(枯渇したら throw して配線ミスを検出する)。
function sequenceFactory(values: string[]): IdFactory {
  let i = 0
  return () => {
    if (i >= values.length) {
      throw new Error('sequenceFactory exhausted (test wiring bug)')
    }
    return values[i++]
  }
}

function rawOption(
  id: string,
  isCorrect: boolean,
  extra: Record<string, unknown> = {},
) {
  return { id, text: `option ${id}`, is_correct: isCorrect, ...extra }
}

function rawCard(overrides: Record<string, unknown> = {}) {
  return {
    title: 'カードタイトル',
    question_text: '問題文',
    options: [rawOption('a', true), rawOption('b', false)],
    correct_answer_ids: ['a'],
    images: [],
    ...overrides,
  }
}

function rawFigure(overrides: Record<string, unknown> = {}) {
  return {
    source_id: 'src-1',
    box_2d: [100, 200, 300, 400],
    target: 'question',
    ...overrides,
  }
}

const ZERO_FIGURE_EXCLUSIONS = {
  coordinate_null: 0,
  source_id_invalid: 0,
  malformed: 0,
  asset_id_invalid: 0,
}

const ZERO_CARD_EXCLUSIONS = {
  malformed: 0,
  invariant_failed: 0,
  card_id_invalid: 0,
}

const SRC1 = new Set(['src-1'])

// ---------------------------------------------------------------------------
// happy path + 正規形(spec §5.4①②: undefined でなく null・customProps 必須)
// ---------------------------------------------------------------------------

describe('normalizePrepared: happy path + 正規形', () => {
  it('1 card + 1 figure(target=question)を正規化する', () => {
    const raw = { cards: [rawCard({ figure_regions: [rawFigure()] })] }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())

    expect(result.cardsTotal).toBe(1)
    expect(result.cardsExcluded).toBe(0)
    expect(result.figuresExcluded).toEqual(ZERO_FIGURE_EXCLUSIONS)
    expect(result.cards).toHaveLength(1)

    const card = result.cards[0]
    expect(card.title).toBe('カードタイトル')
    expect(card.questionText).toBe('問題文')
    expect(card.options).toHaveLength(2)
    expect(card.options[0].id).toBe('a')
    expect(card.options[0].isCorrect).toBe(true)
    expect(card.correctAnswerIds).toEqual(['a']) // isCorrect から再導出(a のみ)
    expect(card.figures).toHaveLength(1)
    expect(card.figures[0].sourceId).toBe('src-1')
    expect(card.figures[0].box_2d).toEqual([100, 200, 300, 400])
    expect(card.figures[0].target).toBe('question_text')

    // staged id は全て v4 shape かつ相互に一意
    const ids = [card.cardId, ...card.options.map((o) => o.uid), card.figures[0].assetId]
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    }
  })

  it('sort_key/explanation_text が raw に無ければキー必須・値 null で正規化される(undefined にしない)', () => {
    const raw = { cards: [rawCard()] } // sort_key/explanation_text 未指定
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    const card = result.cards[0]
    expect('questionLabel' in card).toBe(true)
    expect(card.questionLabel).toBeNull()
    expect('explanationText' in card).toBe(true)
    expect(card.explanationText).toBeNull()
    expect('memo' in card).toBe(true)
    expect(card.memo).toBeNull() // OCR 抽出に無い概念・常に null
  })

  it('sort_key/explanation_text が raw にあれば値がそのまま保持される', () => {
    const raw = {
      cards: [rawCard({ sort_key: 'A-1', explanation_text: '解説本文' })],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    const card = result.cards[0]
    expect(card.questionLabel).toBe('A-1')
    expect(card.explanationText).toBe('解説本文')
  })

  it('figure_regions 無し(未指定)の card は figures=[] で正規化される', () => {
    const raw = { cards: [rawCard()] }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].figures).toEqual([])
    expect(result.figuresExcluded).toEqual(ZERO_FIGURE_EXCLUSIONS)
  })

  it('figure の label が raw に無ければ null・あればそのまま保持される', () => {
    const raw = {
      cards: [
        rawCard({
          figure_regions: [
            rawFigure({ target: 'question' }), // label 未指定
            rawFigure({ target: 'explanation', label: '図1' }),
          ],
        }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    const [f1, f2] = result.cards[0].figures
    expect(f1.label).toBeNull()
    expect(f2.label).toBe('図1')
  })

  it('custom_props が raw に無ければ customProps={}(必須キー・optional にしない)', () => {
    const raw = { cards: [rawCard()] } // custom_props 未指定
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    const card = result.cards[0]
    expect('customProps' in card).toBe(true)
    expect(card.customProps).toEqual({})
  })

  it('custom_props が妥当な形状なら値がそのまま保持される(タグ保持・spec §5.4②)', () => {
    const raw = {
      cards: [
        rawCard({ custom_props: { genre: 'math', level: ['1', '2'] } }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].customProps).toEqual({ genre: 'math', level: ['1', '2'] })
  })

  it('custom_props の形状が壊れていれば {} に正規化される(card は drop しない・タグは補助情報)', () => {
    const raw = { cards: [rawCard({ custom_props: 'not-an-object' })] }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(0)
    expect(result.cards[0].customProps).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 契約テスト(spec §5.4 の要): normalize が生成する全 card は
// preparedCardSchema を通る(normalize の出力は構造的に publisher-valid)。
// ---------------------------------------------------------------------------

describe('normalizePrepared: 契約テスト(preparedCardSchema 包含関係)', () => {
  it('多様な raw 入力から生成された全 card が preparedCardSchema.parse を例外なく通る', () => {
    const raw = {
      cards: [
        rawCard(), // 最小形
        rawCard({ sort_key: 'B-2', explanation_text: '解説' }), // 全 field あり
        rawCard({
          options: [rawOption('a', true), rawOption('b', false), rawOption('c', false)],
          figure_regions: [
            rawFigure({ target: 'question' }),
            rawFigure({ target: 'option_a', label: 'ラベル' }),
          ],
          custom_props: { tag: ['x', 'y'] },
        }),
        rawCard({
          options: Array.from({ length: 50 }, (_, i) => rawOption(`o${i}`, i === 0)),
        }), // options 境界(50・最大)
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards.length).toBeGreaterThan(0) // 空配列でテストが無意味化するのを防ぐ
    for (const card of result.cards) {
      expect(() => preparedCardSchema.parse(card)).not.toThrow()
    }
  })

  it('normalizePreparedCard の単体戻り値も preparedCardSchema を通る', () => {
    const result = normalizePreparedCard(rawCard(), SRC1, makeUuidFactory())
    expect(result.card).not.toBeNull()
    expect(() => preparedCardSchema.parse(result.card)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 要素隔離(spec §5.3)
// ---------------------------------------------------------------------------

describe('normalizePrepared: 要素隔離', () => {
  it('構造破損 card(title が数値)は除外され、他の正常 card は生存する', () => {
    const raw = {
      cards: [
        rawCard({ title: 'card 1' }),
        rawCard({ title: 12345 }), // 破損: title は string 必須
        rawCard({ title: 'card 3' }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsTotal).toBe(3)
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toHaveLength(2)
    expect(result.cards.map((c) => c.title)).toEqual(['card 1', 'card 3'])
  })

  it('配列全体は 1 要素の構造破損で reject されない(cards=[] にならない)', () => {
    const raw = { cards: [rawCard({ options: 'not-an-array' })] }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsTotal).toBe(1)
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toEqual([])
    // 例外を投げない(pure・adversarial 入力に対しても安全)
  })

  it('構造破損 card は id factory を一切呼ばない(rawCardSchema で即 drop・id 未消費)', () => {
    const raw = { cards: [rawCard({ question_text: 42 })] } // 破損: question_text は string 必須
    expect(() =>
      normalizePrepared(raw, SRC1, throwingFactory),
    ).not.toThrow()
  })

  it('破損 figure(source_id が数値)はその figure のみ除外・card は生存する', () => {
    const raw = {
      cards: [
        rawCard({
          figure_regions: [rawFigure(), rawFigure({ source_id: 42 })],
        }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(0)
    expect(result.cards[0].figures).toHaveLength(1)
    expect(result.figuresExcluded.malformed).toBe(1)
  })

  it('box_2d の要素数が 4 でない figure は malformed 扱いで除外', () => {
    const raw = {
      cards: [
        rawCard({ figure_regions: [rawFigure({ box_2d: [1, 2, 3] })] }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].figures).toEqual([])
    expect(result.figuresExcluded.malformed).toBe(1)
  })

  it('figure_regions が配列でない(型不正)場合は figures=[] 扱い・card は破損としない', () => {
    const raw = { cards: [rawCard({ figure_regions: 'oops' })] }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(0)
    expect(result.cards[0].figures).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// box_2d null → coordinate_null
// ---------------------------------------------------------------------------

describe('normalizePrepared: box_2d null', () => {
  it('box_2d===null の figure は coordinate_null で除外(座標を推測しない)', () => {
    const raw = {
      cards: [rawCard({ figure_regions: [rawFigure({ box_2d: null })] })],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].figures).toEqual([])
    expect(result.figuresExcluded.coordinate_null).toBe(1)
    expect(result.figuresExcluded.source_id_invalid).toBe(0)
  })

  it('他の生存 figure・card には影響しない', () => {
    const raw = {
      cards: [
        rawCard({
          figure_regions: [rawFigure({ box_2d: null }), rawFigure()],
        }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].figures).toHaveLength(1)
    expect(result.figuresExcluded.coordinate_null).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// source_id 解決(spec §5.2・§13)
// ---------------------------------------------------------------------------

describe('normalizePrepared: source_id 解決', () => {
  it('validSourceIds に無い source_id は source_id_invalid で除外', () => {
    const raw = {
      cards: [
        rawCard({ figure_regions: [rawFigure({ source_id: 'unknown' })] }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].figures).toEqual([])
    expect(result.figuresExcluded.source_id_invalid).toBe(1)
    expect(result.figuresExcluded.coordinate_null).toBe(0)
  })

  it('source_id 不正 かつ box_2d null が同時に成立する figure は source_id_invalid を優先し二重計上しない', () => {
    const raw = {
      cards: [
        rawCard({
          figure_regions: [rawFigure({ source_id: 'unknown', box_2d: null })],
        }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.figuresExcluded).toEqual({
      coordinate_null: 0,
      source_id_invalid: 1,
      malformed: 0,
      asset_id_invalid: 0,
    })
  })

  it('同一 source_id を複数 figure が参照しても両方生存し、異なる assetId を持つ(重複は許容・決定的)', () => {
    const raw = {
      cards: [
        rawCard({
          figure_regions: [
            rawFigure({ target: 'question' }),
            rawFigure({ target: 'explanation' }),
          ],
        }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].figures).toHaveLength(2)
    const [f1, f2] = result.cards[0].figures
    expect(f1.sourceId).toBe('src-1')
    expect(f2.sourceId).toBe('src-1')
    expect(f1.assetId).not.toBe(f2.assetId)
    expect(f1.target).toBe('question_text')
    expect(f2.target).toBe('explanation_text')
  })
})

// ---------------------------------------------------------------------------
// target 解決(spec §13・全 variant)
// ---------------------------------------------------------------------------

describe('normalizePrepared: target 解決', () => {
  it("target='question' → 'question_text'", () => {
    const raw = {
      cards: [rawCard({ figure_regions: [rawFigure({ target: 'question' })] })],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].figures[0].target).toBe('question_text')
  })

  it("target='explanation' → 'explanation_text'", () => {
    const raw = {
      cards: [
        rawCard({ figure_regions: [rawFigure({ target: 'explanation' })] }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].figures[0].target).toBe('explanation_text')
  })

  it("target='option_a'(id 一致)→ 'option:<staged-uid>' (2 段変換)", () => {
    const raw = {
      cards: [rawCard({ figure_regions: [rawFigure({ target: 'option_a' })] })],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    const card = result.cards[0]
    const optionA = card.options.find((o) => o.id === 'a')!
    expect(card.figures[0].target).toBe(`option:${optionA.uid}`)
  })

  it("target='foobar'(未知 vocab)→ ambiguous fallback 'question_text'", () => {
    const raw = {
      cards: [rawCard({ figure_regions: [rawFigure({ target: 'foobar' })] })],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].figures[0].target).toBe('question_text')
  })

  it("target='option_zzz'(存在しない option id)→ 'question_text' にフォールバック(silent drop しない)", () => {
    const raw = {
      cards: [
        rawCard({ figure_regions: [rawFigure({ target: 'option_zzz' })] }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    // フォールバックされ生存する(除外理由にならない)
    expect(result.cards[0].figures).toHaveLength(1)
    expect(result.cards[0].figures[0].target).toBe('question_text')
    expect(result.figuresExcluded).toEqual(ZERO_FIGURE_EXCLUSIONS)
  })
})

// ---------------------------------------------------------------------------
// options 個数境界(spec §5.4: optionsSchema(lib/validation/card.ts)を
// compose した preparedCardSchema.options が判定する。 51 件超は card 全体を
// drop する — schema 一本化に伴い figure_regions があっても figure は minting
// までは処理される(id は消費されるが結果には反映されない・report 参照)。
// ---------------------------------------------------------------------------

describe('normalizePrepared: options 個数境界', () => {
  it('options=0 は card を drop する', () => {
    const raw = { cards: [rawCard({ options: [] })] }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toEqual([])
  })

  it('options=50(境界)は許容される', () => {
    const options = Array.from({ length: 50 }, (_, i) => rawOption(`o${i}`, i === 0))
    const raw = { cards: [rawCard({ options })] }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(0)
    expect(result.cards[0].options).toHaveLength(50)
  })

  it('options=51(境界超過)は card を drop する', () => {
    const options = Array.from({ length: 51 }, (_, i) => rawOption(`o${i}`, i === 0))
    const raw = { cards: [rawCard({ options })] }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toEqual([])
  })

  it('options=51 で drop された card の figure 除外理由は結果全体の集計に反映しない(dropped card の内部事情は数えない)', () => {
    const options = Array.from({ length: 51 }, (_, i) => rawOption(`o${i}`, i === 0))
    const raw = {
      // box_2d=null の figure(card が生存していれば coordinate_null が 1 件
      // 計上されるはずの図)を含める。card 自体が options 境界超過で drop
      // されるため、この figure の除外理由は最終結果に現れない。
      cards: [rawCard({ options, figure_regions: [rawFigure({ box_2d: null })] })],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(1)
    expect(result.figuresExcluded).toEqual(ZERO_FIGURE_EXCLUSIONS)
  })
})

// ---------------------------------------------------------------------------
// option field 境界(spec §5.4: optionSchema(lib/validation/card.ts)を
// preparedOptionSchema として verbatim 再利用・数値を再定義しない)。
// ---------------------------------------------------------------------------

describe('normalizePrepared: option field 境界(publisher schema を verbatim 再利用)', () => {
  it('option の id が空文字(optionSchema.id.min(1) 違反)の card は drop・他 card は生存', () => {
    const raw = {
      cards: [
        rawCard({ title: 'card 1', options: [rawOption('', true)] }), // 空 id
        rawCard({ title: 'card 2' }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].title).toBe('card 2')
  })

  it('option の text が 1000 文字超(optionSchema.text.max(1000) 違反)の card は drop・他 card は生存', () => {
    const tooLongText = 'x'.repeat(1001)
    const raw = {
      cards: [
        rawCard({
          title: 'card 1',
          options: [rawOption('a', true, { text: tooLongText })],
        }),
        rawCard({ title: 'card 2' }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].title).toBe('card 2')
  })

  it('option の explanation が 2000 文字超(optionSchema.explanation.max(2000) 違反)の card は drop・他 card は生存', () => {
    const tooLongExplanation = 'y'.repeat(2001)
    const raw = {
      cards: [
        rawCard({
          title: 'card 1',
          options: [rawOption('a', true, { explanation: tooLongExplanation })],
        }),
        rawCard({ title: 'card 2' }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].title).toBe('card 2')
  })

  it('境界内(text=1000文字・explanation=2000文字)は許容される', () => {
    const raw = {
      cards: [
        rawCard({
          options: [
            rawOption('a', true, {
              text: 'x'.repeat(1000),
              explanation: 'y'.repeat(2000),
            }),
            rawOption('b', false),
          ],
        }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(0)
    expect(result.cards).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// correct_answer_ids 再導出(spec §8.2 — 入力の list は信用しない)
// ---------------------------------------------------------------------------

describe('normalizePrepared: correct_answer_ids 再導出', () => {
  it('入力の correct_answer_ids は無視し isCorrect から再導出する', () => {
    const raw = {
      cards: [
        rawCard({
          options: [rawOption('a', false), rawOption('b', true)],
          correct_answer_ids: ['a'], // 誤った値(a は is_correct=false)
        }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].correctAnswerIds).toEqual(['b'])
  })

  it('正解なし(全 is_correct=false)は空配列', () => {
    const raw = {
      cards: [
        rawCard({
          options: [rawOption('a', false), rawOption('b', false)],
          correct_answer_ids: ['a', 'b'],
        }),
      ],
    }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cards[0].correctAnswerIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// uid/cardId 一意性 + v4 shape(壊れた factory への防御・preparedCardSchema 経由)
// ---------------------------------------------------------------------------

describe('normalizePrepared: uid/cardId 一意性・v4 shape 検証(factory 防御)', () => {
  it('常に同じ値を返す factory(uid 衝突)は card を drop する(optionsSchema の uid 一意性 refine 経由)', () => {
    const constantFactory: IdFactory = () => '11111111-1111-4111-8111-111111111111'
    const raw = { cards: [rawCard()] } // 2 options → cardId+2 uid で必ず衝突
    const result = normalizePrepared(raw, SRC1, constantFactory)
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toEqual([])
  })

  it('v4 shape でない値を返す factory は card を drop する(preparedCardSchema の cardId/uid 検証経由)', () => {
    let n = 0
    const nonV4Factory: IdFactory = () => `not-a-uuid-${n++}`
    const raw = { cards: [rawCard()] }
    const result = normalizePrepared(raw, SRC1, nonV4Factory)
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// cardId/assetId 一意性・v4 shape 検証(response 全体スコープ・normalize-level
// accumulator。 spec §5.4「統一しないもの」: 1 card しか見えない schema では
// cross-card 一意性を表現できないため、 引き続き normalize 側の責務)。
// ---------------------------------------------------------------------------

describe('normalizePrepared: cardId/assetId 一意性・v4 shape 検証(cross-card accumulator)', () => {
  it('malformed(非 v4)な cardId を返す card: その card のみ drop・他 card は生存する', () => {
    const raw = {
      cards: [
        rawCard({ title: 'card 1', options: [rawOption('a', true)] }),
        rawCard({ title: 'card 2', options: [rawOption('a', true)] }),
      ],
    }
    const factory = sequenceFactory([
      'not-a-uuid', // card1 cardId(malformed)
      uuidAt(1), // card1 option a uid(消費されるが card1 は schema で drop)
      uuidAt(2), // card2 cardId
      uuidAt(3), // card2 option a uid
    ])
    const result = normalizePrepared(raw, SRC1, factory)
    expect(result.cardsTotal).toBe(2)
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].title).toBe('card 2')
  })

  it('重複 cardId(2 card 目が 1 card 目と同じ値)は 2 card 目を drop する(keep-first)', () => {
    const raw = {
      cards: [
        rawCard({ title: 'card 1', options: [rawOption('a', true)] }),
        rawCard({ title: 'card 2', options: [rawOption('a', true)] }),
      ],
    }
    const dupId = uuidAt(1)
    const factory = sequenceFactory([
      dupId, // card1 cardId
      uuidAt(2), // card1 option a uid
      dupId, // card2 cardId(重複)
      uuidAt(3), // card2 option a uid(消費されるが card2 は重複で drop)
    ])
    const result = normalizePrepared(raw, SRC1, factory)
    expect(result.cardsExcluded).toBe(1)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].title).toBe('card 1')
    expect(result.cards[0].cardId).toBe(dupId)
  })

  it('reserve-after-validate: cardId は preparedCardSchema 通過確定後にのみ予約する(drop された card の cardId は後続 card が再利用できる)', () => {
    // card1: cardId=X(単独では valid)を発行後、 option uid が malformed
    // (非 v4)なため preparedCardSchema.safeParse で card1 自体が drop される。
    // このとき cardId=X を seenCardIds に「予約したまま」にしてはいけない
    // (card1 は結果に含まれず実質存在しないため)。 card2 が同じ X を
    // (replay/壊れた factory 経由で)正当に使っても、 誤って「重複」扱いされず
    // 生存するはずである。
    const raw = {
      cards: [
        rawCard({ title: 'card 1', options: [rawOption('a', true)] }),
        rawCard({ title: 'card 2', options: [rawOption('a', true)] }),
      ],
    }
    const cardId = uuidAt(1)
    const factory = sequenceFactory([
      cardId, // card1 cardId(単独では valid)
      'not-a-uuid', // card1 option a uid(malformed)→ card1 は schema で drop
      cardId, // card2 cardId(card1 と同じ値だが、card1 は生存していないので重複ではない)
      uuidAt(2), // card2 option a uid(valid)
    ])
    const result = normalizePrepared(raw, SRC1, factory)
    expect(result.cardsExcluded).toBe(1) // card1 のみ(option uid malformed)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].title).toBe('card 2')
    // fix 前は「card2 の cardId が既出(card1 の予約)」として誤って drop され、
    // cards=[] になっていた。 fix 後は cardId を正当に再利用して生存する。
    expect(result.cards[0].cardId).toBe(cardId)
  })

  it('malformed(非 v4)な assetId を返す figure はその figure のみ除外する', () => {
    const raw = {
      cards: [
        rawCard({
          options: [rawOption('a', true)],
          figure_regions: [rawFigure(), rawFigure({ target: 'explanation' })],
        }),
      ],
    }
    const factory = sequenceFactory([
      uuidAt(1), // cardId
      uuidAt(2), // option a uid
      'not-a-uuid', // figure1 assetId(malformed)→ 除外
      uuidAt(3), // figure2 assetId
    ])
    const result = normalizePrepared(raw, SRC1, factory)
    expect(result.cardsExcluded).toBe(0)
    expect(result.cards[0].figures).toHaveLength(1)
    expect(result.cards[0].figures[0].target).toBe('explanation_text')
    expect(result.figuresExcluded.asset_id_invalid).toBe(1)
  })

  it('重複 assetId(card をまたいでも)は後発の figure を除外する(card 自体は生存)', () => {
    const raw = {
      cards: [
        rawCard({ title: 'card 1', options: [rawOption('a', true)], figure_regions: [rawFigure()] }),
        rawCard({ title: 'card 2', options: [rawOption('a', true)], figure_regions: [rawFigure()] }),
      ],
    }
    const dupAssetId = uuidAt(99)
    const factory = sequenceFactory([
      uuidAt(1), // card1 cardId
      uuidAt(2), // card1 option a uid
      dupAssetId, // card1 figure assetId
      uuidAt(3), // card2 cardId
      uuidAt(4), // card2 option a uid
      dupAssetId, // card2 figure assetId(重複)→ 除外
    ])
    const result = normalizePrepared(raw, SRC1, factory)
    expect(result.cardsExcluded).toBe(0)
    expect(result.cards).toHaveLength(2)
    expect(result.cards[0].figures).toHaveLength(1)
    expect(result.cards[0].figures[0].assetId).toBe(dupAssetId)
    expect(result.cards[1].figures).toHaveLength(0) // 重複側は除外され card は生存
    expect(result.figuresExcluded.asset_id_invalid).toBe(1)
  })

  it('reserve-after-validate(assetId): card-level field(title 長さ)違反で drop された card の figure が使った assetId を、後続 card が正当に再利用できる', () => {
    // card1: cardId/option uid/figure assetId は全て単独では valid だが、
    // title が 200 文字超のため preparedCardSchema.safeParse で card1 自体が
    // drop される。 このとき card1 の figure が消費した assetId を
    // seenAssetIds に「予約したまま」にしてはいけない(card1 は結果に含まれず
    // 実質存在しないため)。 card2 の figure が同じ assetId を(replay/壊れた
    // factory 経由で)正当に使っても、 誤って「重複」扱いされず生存するはず。
    const raw = {
      cards: [
        rawCard({
          title: 'x'.repeat(201), // titleSchema.max(200) 違反
          options: [rawOption('a', true)],
          figure_regions: [rawFigure()],
        }),
        rawCard({
          title: 'card 2',
          options: [rawOption('a', true)],
          figure_regions: [rawFigure()],
        }),
      ],
    }
    const assetId = uuidAt(99)
    const factory = sequenceFactory([
      uuidAt(1), // card1 cardId
      uuidAt(2), // card1 option a uid
      assetId, // card1 figure assetId(単独では valid)
      uuidAt(3), // card2 cardId
      uuidAt(4), // card2 option a uid
      assetId, // card2 figure assetId(card1 と同じ値だが、card1 は生存していないので重複ではない)
    ])
    const result = normalizePrepared(raw, SRC1, factory)
    expect(result.cardsExcluded).toBe(1) // card1 のみ(title 長さ違反)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].title).toBe('card 2')
    // fix 前は「card2 の figure の assetId が既出(card1 の予約)」として誤って
    // 除外され figures=[] になっていた。 fix 後は assetId を正当に再利用して
    // figure が生存する。
    expect(result.cards[0].figures).toHaveLength(1)
    expect(result.cards[0].figures[0].assetId).toBe(assetId)
    expect(result.figuresExcluded.asset_id_invalid).toBe(0)
  })

  it('reserve-after-validate(cardId): card-level field(title 長さ)違反で drop された card の cardId を、後続 card が正当に再利用できる', () => {
    // reserve-after-validate はこれまで「option uid 違反による drop」でのみ
    // テストしていた(既存の reserve-after-validate テスト)。 card-level
    // field(title)違反による drop でも同じ discipline が成り立つことを別途
    // 確認する(figures を伴う card の drop 経路・assetId テストと対の検証)。
    const raw = {
      cards: [
        rawCard({
          title: 'x'.repeat(201), // titleSchema.max(200) 違反
          options: [rawOption('a', true)],
        }),
        rawCard({ title: 'card 2', options: [rawOption('a', true)] }),
      ],
    }
    const cardId = uuidAt(1)
    const factory = sequenceFactory([
      cardId, // card1 cardId(単独では valid)
      uuidAt(2), // card1 option a uid
      cardId, // card2 cardId(card1 と同じ値だが、card1 は生存していないので重複ではない)
      uuidAt(3), // card2 option a uid
    ])
    const result = normalizePrepared(raw, SRC1, factory)
    expect(result.cardsExcluded).toBe(1) // card1 のみ(title 長さ違反)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].title).toBe('card 2')
    expect(result.cards[0].cardId).toBe(cardId)
  })
})

// ---------------------------------------------------------------------------
// 決定性(spec §D retry 再利用契約の基盤)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// card 除外理由の内訳(A)
//
// 3 分岐が同一の戻り値を返していたため「何件落ちたか」しか残らず、除外理由が
// result_summary / last_error_code / ログのいずれにも存在しなかった。ここでは
// **3 分岐を 1 つずつ単独で踏ませ**、対応する区分だけが 1 増えることを見る
// (まとめて壊して「1 件除外された」を見る形にしない — それでは区分の配線が
// 入れ替わっていても気付けない)。各 test は他 2 区分が 0 のままであることも
// 同時に assert するため、区分の取り違えが必ず落ちる。
// ---------------------------------------------------------------------------

describe('normalizePrepared: card 除外理由の内訳', () => {
  it('分岐 1 単独: rawCardSchema 形状破損 → malformed だけが 1', () => {
    // question_text が string でない = loose 構造で落ちる(factory は呼ばれない)。
    const raw = { cards: [rawCard({ question_text: 123 })] }
    const result = normalizePrepared(raw, SRC1, throwingFactory)
    expect(result.cardsExcluded).toBe(1)
    expect(result.cardsExcludedReasons).toEqual({
      ...ZERO_CARD_EXCLUSIONS,
      malformed: 1,
    })
  })

  it('分岐 2 単独: preparedCardSchema の hard invariant 違反 → invariant_failed だけが 1', () => {
    // question_text は string ゆえ loose は通り、questionTextSchema の
    // 「trim して非空」で落ちる = 分岐 2 のみを踏む。
    const raw = { cards: [rawCard({ question_text: '   ' })] }
    const result = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(1)
    expect(result.cardsExcludedReasons).toEqual({
      ...ZERO_CARD_EXCLUSIONS,
      invariant_failed: 1,
    })
  })

  it('分岐 3 単独: cardId の cross-card 重複 → card_id_invalid だけが 1', () => {
    // 2 card とも単独では valid。2 枚目が 1 枚目と同じ cardId を得る配線にして
    // 分岐 3 のみを踏む(分岐 1/2 は通過する)。
    const raw = {
      cards: [
        rawCard({ title: 'card 1', options: [rawOption('a', true)] }),
        rawCard({ title: 'card 2', options: [rawOption('a', true)] }),
      ],
    }
    const dupId = uuidAt(1)
    const result = normalizePrepared(
      raw,
      SRC1,
      sequenceFactory([dupId, uuidAt(2), dupId, uuidAt(3)]),
    )
    expect(result.cardsExcluded).toBe(1)
    expect(result.cardsExcludedReasons).toEqual({
      ...ZERO_CARD_EXCLUSIONS,
      card_id_invalid: 1,
    })
  })

  it('除外ゼロなら全区分 0(生存 card が誤って計上されない)', () => {
    const result = normalizePrepared({ cards: [rawCard()] }, SRC1, makeUuidFactory())
    expect(result.cardsExcluded).toBe(0)
    expect(result.cardsExcludedReasons).toEqual(ZERO_CARD_EXCLUSIONS)
  })

  it('内訳の総和は必ず cardsExcluded に一致する(区分を返さない除外経路が無いことの pin)', () => {
    // 3 分岐を 1 response に同居させる。1 枚目 = 分岐 1(factory 非消費)、
    // 2 枚目 = 分岐 2、3 枚目 = 生存、4 枚目 = 3 枚目と同じ cardId で分岐 3。
    const dupId = uuidAt(10)
    const raw = {
      cards: [
        rawCard({ question_text: 123 }),
        rawCard({ question_text: '   ', options: [rawOption('a', true)] }),
        rawCard({ title: 'survivor', options: [rawOption('a', true)] }),
        rawCard({ title: 'dup', options: [rawOption('a', true)] }),
      ],
    }
    const result = normalizePrepared(
      raw,
      SRC1,
      sequenceFactory([uuidAt(1), uuidAt(2), dupId, uuidAt(3), dupId, uuidAt(4)]),
    )
    const r = result.cardsExcludedReasons
    expect(r).toEqual({ malformed: 1, invariant_failed: 1, card_id_invalid: 1 })
    expect(r.malformed + r.invariant_failed + r.card_id_invalid).toBe(
      result.cardsExcluded,
    )
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].title).toBe('survivor')
  })
})

describe('normalizePrepared: 決定性', () => {
  it('同一入力 + 同一 factory 呼出列 → 同一出力', () => {
    const raw = {
      cards: [
        rawCard({ figure_regions: [rawFigure(), rawFigure({ target: 'option_b' })] }),
        rawCard({ title: 'card 2', figure_regions: [rawFigure({ source_id: 'unknown' })] }),
      ],
    }
    const result1 = normalizePrepared(raw, SRC1, makeUuidFactory())
    const result2 = normalizePrepared(raw, SRC1, makeUuidFactory())
    expect(result2).toEqual(result1)
  })
})

// ---------------------------------------------------------------------------
// トップレベル adversarial 入力(pure・throw しない)
// ---------------------------------------------------------------------------

describe('normalizePrepared: トップレベル不正入力', () => {
  it('raw が null でも throw せず空結果を返す', () => {
    const result = normalizePrepared(null, SRC1, throwingFactory)
    expect(result).toEqual({
      cards: [],
      cardsTotal: 0,
      cardsExcluded: 0,
      cardsExcludedReasons: ZERO_CARD_EXCLUSIONS,
      figuresExcluded: ZERO_FIGURE_EXCLUSIONS,
    })
  })

  it('raw.cards が配列でない場合も throw せず空結果を返す', () => {
    const result = normalizePrepared({ cards: 'oops' }, SRC1, throwingFactory)
    expect(result.cards).toEqual([])
    expect(result.cardsTotal).toBe(0)
  })

  it('raw が object でない(文字列)場合も throw せず空結果を返す', () => {
    const result = normalizePrepared('not-json', SRC1, throwingFactory)
    expect(result.cards).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// normalizePreparedCard 単体(publish 層が同名の関数を再利用する想定は撤回済み・
// spec §5.4 で publisher は組み立て時に 1 回 parse 済みの in-memory payload を
// 消費するのみで normalizePreparedCard を呼ばない。本関数は normalizePrepared の
// 内部 orchestration 単位として単体テストする)。
// ---------------------------------------------------------------------------

describe('normalizePreparedCard: 単体', () => {
  it('正常 card を渡すと生存側 union({card, figuresExcluded})を返す', () => {
    const result = normalizePreparedCard(rawCard(), SRC1, makeUuidFactory())
    expect(result.card).not.toBeNull()
    expect(result.card?.options).toHaveLength(2)
    expect(result.figuresExcluded).toEqual(ZERO_FIGURE_EXCLUSIONS)
    // 生存側に除外区分が載らないことは union で型強制されるが、実体でも確認する
    // (生存 card が誤って理由付きで返ると集計が水増しされる)。
    expect('excludedReason' in result).toBe(false)
  })

  it('破損 card を渡すと card=null + 区分を返す(例外を投げない)', () => {
    const result = normalizePreparedCard(
      { title: 42 },
      SRC1,
      throwingFactory,
    )
    expect(result.card).toBeNull()
    expect(result.card === null ? result.excludedReason : null).toBe('malformed')
  })
})
