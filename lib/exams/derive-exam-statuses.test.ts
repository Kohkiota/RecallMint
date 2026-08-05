import { describe, it, expect } from 'vitest'
import {
  deriveDocStatuses,
  deriveExamStatuses,
  STALE_PROCESSING_MS,
} from './derive-exam-statuses'

// 固定基準時刻: テスト全体で "now" を統一する
const NOW = new Date('2026-05-20T10:00:00Z')

// STALE_PROCESSING_MS (15分) より前の時刻: timeout 残骸として扱われる
const STALE_TIME = new Date(NOW.getTime() - STALE_PROCESSING_MS - 1)
// STALE_PROCESSING_MS (15分) 以内の時刻: まだ処理中と見なされる
const FRESH_TIME = new Date(NOW.getTime() - STALE_PROCESSING_MS + 60_000)

describe('deriveExamStatuses', () => {
  it('最新が completed の exam は Map に出ない', () => {
    const rows = [
      { examId: 'exam-a', id: 'sd-a', status: 'completed' as const, createdAt: FRESH_TIME },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.has('exam-a')).toBe(false)
  })

  it('最新が failed の exam は "failed" になる', () => {
    const rows = [
      { examId: 'exam-b', id: 'sd-b', status: 'failed' as const, createdAt: FRESH_TIME },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.get('exam-b')).toBe('failed')
  })

  it('最新が processing かつ 15 分以内の exam は "processing" になる', () => {
    const rows = [
      { examId: 'exam-c', id: 'sd-c', status: 'processing' as const, createdAt: FRESH_TIME },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.get('exam-c')).toBe('processing')
  })

  it('最新が processing だが 15 分超の exam は "failed" になる (timeout fallback・live-op 保護なし = legacy 挙動)', () => {
    const rows = [
      { examId: 'exam-d', id: 'sd-d', status: 'processing' as const, createdAt: STALE_TIME },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.get('exam-d')).toBe('failed')
  })

  it('同一 exam に複数行ある場合、最新 (createdAt 最大) の status が採用される', () => {
    // 古い processing + 新しい completed → Map に出ない (completed 扱い)
    const rows = [
      {
        examId: 'exam-e',
        id: 'sd-e-old',
        status: 'processing' as const,
        createdAt: new Date('2026-05-20T09:00:00Z'),
      },
      {
        examId: 'exam-e',
        id: 'sd-e-new',
        status: 'completed' as const,
        createdAt: new Date('2026-05-20T09:30:00Z'),
      },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.has('exam-e')).toBe(false)
  })

  it('同一 exam: 古い completed + 新しい failed → "failed"', () => {
    const rows = [
      {
        examId: 'exam-f',
        id: 'sd-f-old',
        status: 'completed' as const,
        createdAt: new Date('2026-05-19T08:00:00Z'),
      },
      {
        examId: 'exam-f',
        id: 'sd-f-new',
        status: 'failed' as const,
        createdAt: new Date('2026-05-20T09:00:00Z'),
      },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.get('exam-f')).toBe('failed')
  })

  it('同一 exam: 古い failed + 新しい processing (fresh) → "processing"', () => {
    const rows = [
      {
        examId: 'exam-g',
        id: 'sd-g-old',
        status: 'failed' as const,
        createdAt: new Date('2026-05-19T08:00:00Z'),
      },
      {
        examId: 'exam-g',
        id: 'sd-g-new',
        status: 'processing' as const,
        createdAt: FRESH_TIME,
      },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.get('exam-g')).toBe('processing')
  })

  it('processing かつ ageMs がちょうど STALE_PROCESSING_MS の場合は "failed" になる (境界値: >= の包含確認)', () => {
    // ageMs === STALE_PROCESSING_MS のとき `ageMs >= STALE_PROCESSING_MS` は true。
    // この境界が inclusive であることをドキュメントとして確認する。
    const exactThresholdTime = new Date(NOW.getTime() - STALE_PROCESSING_MS)
    const rows = [
      {
        examId: 'exam-boundary',
        id: 'sd-boundary',
        status: 'processing' as const,
        createdAt: exactThresholdTime,
      },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.get('exam-boundary')).toBe('failed')
  })

  it('空配列は空 Map を返す', () => {
    const result = deriveExamStatuses([], NOW)
    expect(result.size).toBe(0)
  })

  it('複数 exam が混在しても各 exam の判定は独立している', () => {
    const rows = [
      { examId: 'exam-h', id: 'sd-h', status: 'completed' as const, createdAt: FRESH_TIME },
      { examId: 'exam-i', id: 'sd-i', status: 'failed' as const, createdAt: FRESH_TIME },
      { examId: 'exam-j', id: 'sd-j', status: 'processing' as const, createdAt: FRESH_TIME },
      { examId: 'exam-k', id: 'sd-k', status: 'processing' as const, createdAt: STALE_TIME },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.has('exam-h')).toBe(false) // completed → 出ない
    expect(result.get('exam-i')).toBe('failed')
    expect(result.get('exam-j')).toBe('processing')
    expect(result.get('exam-k')).toBe('failed') // stale processing → failed
  })

  // --- T14a fix round 2(Codex P2#1): live-op 保護による表示 op-awareness ---
  describe('liveOpSourceDocumentIds (T14a fix round 2)', () => {
    it('processing かつ 15 分超だが liveOpSourceDocumentIds に id あり → "processing"(reconciler の window-aware 除外と一致)', () => {
      const rows = [
        { examId: 'exam-live', id: 'sd-live', status: 'processing' as const, createdAt: STALE_TIME },
      ]
      const result = deriveExamStatuses(rows, NOW, new Set(['sd-live']))
      expect(result.get('exam-live')).toBe('processing')
    })

    it('processing かつ 15 分超・liveOpSourceDocumentIds に id が無い(legacy: upload_operations 行なし)→ 従来どおり "failed"', () => {
      const rows = [
        {
          examId: 'exam-legacy',
          id: 'sd-legacy',
          status: 'processing' as const,
          createdAt: STALE_TIME,
        },
      ]
      // 空集合を明示的に渡す = legacy(live op が一切無い)ケースを模す。
      const result = deriveExamStatuses(rows, NOW, new Set())
      expect(result.get('exam-legacy')).toBe('failed')
    })

    it('liveOpSourceDocumentIds を省略(デフォルト空集合)しても legacy 呼出は今までどおり動く(後方互換)', () => {
      const rows = [
        {
          examId: 'exam-default',
          id: 'sd-default',
          status: 'processing' as const,
          createdAt: STALE_TIME,
        },
      ]
      const result = deriveExamStatuses(rows, NOW)
      expect(result.get('exam-default')).toBe('failed')
    })

    it('liveOpSourceDocumentIds に別 exam の id が入っていても、無関係な exam の stale processing は "failed" のまま(誤保護しない)', () => {
      const rows = [
        {
          examId: 'exam-other',
          id: 'sd-other',
          status: 'processing' as const,
          createdAt: STALE_TIME,
        },
      ]
      const result = deriveExamStatuses(rows, NOW, new Set(['sd-unrelated']))
      expect(result.get('exam-other')).toBe('failed')
    })

    it('live-op 保護は 15 分以内(そもそも processing 判定)には影響しない', () => {
      const rows = [
        { examId: 'exam-fresh', id: 'sd-fresh', status: 'processing' as const, createdAt: FRESH_TIME },
      ]
      const result = deriveExamStatuses(rows, NOW, new Set(['sd-fresh']))
      expect(result.get('exam-fresh')).toBe('processing')
    })
  })
})

// ---------------------------------------------------------------------------
// deriveDocStatuses(②-4a 単一 invocation S-4)
// ---------------------------------------------------------------------------
// upload page の poll が読む doc 粒度 map。exam 粒度との決定的な違いは
// **completed を明示値で返す**こと — poll する client は「まだ結果が無い(key 不在)」
// と「完了した」を区別する必要があり、key 不在を completed とみなすと、まだ作られて
// いない doc / 取得失敗が全て「完了」に見えてしまう。
describe('deriveDocStatuses', () => {
  it('completed は key 不在ではなく明示値 "completed" で返る', () => {
    const rows = [
      { examId: 'exam-a', id: 'sd-a', status: 'completed' as const, createdAt: FRESH_TIME },
    ]
    const result = deriveDocStatuses(rows, NOW)
    expect(result.get('sd-a')).toBe('completed')
    // exam 粒度側は従来どおり entry を作らない(2 つの map の意味論が違うことの pin)。
    expect(deriveExamStatuses(rows, NOW).has('exam-a')).toBe(false)
  })

  it('failed はそのまま "failed"', () => {
    const rows = [
      { examId: 'exam-b', id: 'sd-b', status: 'failed' as const, createdAt: FRESH_TIME },
    ]
    expect(deriveDocStatuses(rows, NOW).get('sd-b')).toBe('failed')
  })

  it('15 分以内の processing は "processing"', () => {
    const rows = [
      { examId: 'exam-c', id: 'sd-c', status: 'processing' as const, createdAt: FRESH_TIME },
    ]
    expect(deriveDocStatuses(rows, NOW).get('sd-c')).toBe('processing')
  })

  it('15 分超の processing(live-op 保護なし)は exam 粒度と同じく "failed" に倒れる', () => {
    const rows = [
      { examId: 'exam-d', id: 'sd-d', status: 'processing' as const, createdAt: STALE_TIME },
    ]
    expect(deriveDocStatuses(rows, NOW).get('sd-d')).toBe('failed')
    // 同じ入力で exam 粒度も failed = 2 つの導出が同じ stale 規則を共有している。
    expect(deriveExamStatuses(rows, NOW).get('exam-d')).toBe('failed')
  })

  it('15 分超でも live-op 保護があれば "processing"(reconciler と表示を一致させる)', () => {
    const rows = [
      { examId: 'exam-e', id: 'sd-e', status: 'processing' as const, createdAt: STALE_TIME },
    ]
    expect(deriveDocStatuses(rows, NOW, new Set(['sd-e'])).get('sd-e')).toBe('processing')
  })

  it('key は source_document id(exam id ではない)', () => {
    const rows = [
      { examId: 'exam-f', id: 'sd-f', status: 'completed' as const, createdAt: FRESH_TIME },
    ]
    const result = deriveDocStatuses(rows, NOW)
    expect(result.has('sd-f')).toBe(true)
    expect(result.has('exam-f')).toBe(false)
  })

  it('行が無ければ空 map(未知の doc を completed に倒さない)', () => {
    expect(deriveDocStatuses([], NOW).size).toBe(0)
  })
})
