import { describe, it, expect } from 'vitest'
import { deriveExamStatuses, STALE_PROCESSING_MS } from './derive-exam-statuses'

// 固定基準時刻: テスト全体で "now" を統一する
const NOW = new Date('2026-05-20T10:00:00Z')

// STALE_PROCESSING_MS (15分) より前の時刻: timeout 残骸として扱われる
const STALE_TIME = new Date(NOW.getTime() - STALE_PROCESSING_MS - 1)
// STALE_PROCESSING_MS (15分) 以内の時刻: まだ処理中と見なされる
const FRESH_TIME = new Date(NOW.getTime() - STALE_PROCESSING_MS + 60_000)

describe('deriveExamStatuses', () => {
  it('最新が completed の exam は Map に出ない', () => {
    const rows = [
      { examId: 'exam-a', status: 'completed' as const, createdAt: FRESH_TIME },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.has('exam-a')).toBe(false)
  })

  it('最新が failed の exam は "failed" になる', () => {
    const rows = [
      { examId: 'exam-b', status: 'failed' as const, createdAt: FRESH_TIME },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.get('exam-b')).toBe('failed')
  })

  it('最新が processing かつ 15 分以内の exam は "processing" になる', () => {
    const rows = [
      { examId: 'exam-c', status: 'processing' as const, createdAt: FRESH_TIME },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.get('exam-c')).toBe('processing')
  })

  it('最新が processing だが 15 分超の exam は "failed" になる (timeout fallback)', () => {
    const rows = [
      { examId: 'exam-d', status: 'processing' as const, createdAt: STALE_TIME },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.get('exam-d')).toBe('failed')
  })

  it('同一 exam に複数行ある場合、最新 (createdAt 最大) の status が採用される', () => {
    // 古い processing + 新しい completed → Map に出ない (completed 扱い)
    const rows = [
      {
        examId: 'exam-e',
        status: 'processing' as const,
        createdAt: new Date('2026-05-20T09:00:00Z'),
      },
      {
        examId: 'exam-e',
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
        status: 'completed' as const,
        createdAt: new Date('2026-05-19T08:00:00Z'),
      },
      {
        examId: 'exam-f',
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
        status: 'failed' as const,
        createdAt: new Date('2026-05-19T08:00:00Z'),
      },
      {
        examId: 'exam-g',
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
      { examId: 'exam-boundary', status: 'processing' as const, createdAt: exactThresholdTime },
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
      { examId: 'exam-h', status: 'completed' as const, createdAt: FRESH_TIME },
      { examId: 'exam-i', status: 'failed' as const, createdAt: FRESH_TIME },
      { examId: 'exam-j', status: 'processing' as const, createdAt: FRESH_TIME },
      { examId: 'exam-k', status: 'processing' as const, createdAt: STALE_TIME },
    ]
    const result = deriveExamStatuses(rows, NOW)
    expect(result.has('exam-h')).toBe(false) // completed → 出ない
    expect(result.get('exam-i')).toBe('failed')
    expect(result.get('exam-j')).toBe('processing')
    expect(result.get('exam-k')).toBe('failed') // stale processing → failed
  })
})
