// @vitest-environment jsdom
// ②-4a 単一 invocation Sprint Task S-3(canonical review I-1): result page が
// `source_documents.status` で成功 / 失敗を出し分けることの pin。
//
// 背景: 新経路の `submitUpload` は pipeline の成否を呼出側に返さない(失敗も server 側で
// 終端化する契約)ため、client は結果を知らずにこの page へ遷移する。ここで status を
// 見ないと、Gemini 失敗 / publish 失敗などの全失敗クラスが「✅ 0 問を抽出しました」と
// いう緑の成功パネルとして出る(silent failure・spec §4.4 違反)。
//
// page は server component(async function)。 auth + tenant tx + 2 query を mock し、
// `await Page()` の JSX を render する(study/smart/page.test.tsx と同じ方式)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const {
  mockGetCurrentUser,
  mockGetSourceDocumentForUser,
  mockGetCardsForSourceDocument,
  mockGetLatestCompletedUploadSummary,
  mockNotFound,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockGetSourceDocumentForUser: vi.fn(),
  mockGetCardsForSourceDocument: vi.fn(),
  mockGetLatestCompletedUploadSummary: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

vi.mock('@/lib/auth/ensure-user', () => ({ getCurrentUser: mockGetCurrentUser }))
vi.mock('next/navigation', () => ({ notFound: mockNotFound }))
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: async (_userId: string, fn: (tx: unknown) => unknown) => fn({}),
}))
vi.mock('@/lib/exams/list', () => ({
  getSourceDocumentForUser: mockGetSourceDocumentForUser,
  getCardsForSourceDocument: mockGetCardsForSourceDocument,
  getLatestCompletedUploadSummary: mockGetLatestCompletedUploadSummary,
}))

import UploadResultPage from './page'
import {
  UPLOAD_INTERRUPTED_NOTICE,
  UPLOAD_PENDING_NOTICE,
} from '../../_lib/constants'

const USER = { id: 'user-1' }

function params(id = 'doc-1') {
  return Promise.resolve({ sourceDocumentId: id })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCurrentUser.mockResolvedValue(USER)
  mockGetCardsForSourceDocument.mockResolvedValue([])
  // 既定は「summary が引けない doc」(op が無い / 旧行)。 T16-a 以前と同じ描画に
  // なることを他の test がそのまま検証し続ける。
  mockGetLatestCompletedUploadSummary.mockResolvedValue(null)
})

afterEach(() => {
  cleanup()
})

describe('UploadResultPage — source_documents.status で成功 / 失敗を出し分ける', () => {
  it("status='failed' はエラー表示(緑の成功パネルを出さない)", async () => {
    mockGetSourceDocumentForUser.mockResolvedValue({
      id: 'doc-1',
      examName: 'テスト試験',
      status: 'failed',
    })

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/問題を抽出できませんでした/)).toBeInTheDocument()
    // I-3(b): 失敗面は従来文言を維持(terminal 化済み = 再試行が実行可能な面)。
    expect(screen.getByText(UPLOAD_INTERRUPTED_NOTICE)).toBeInTheDocument()
    expect(screen.queryByText(UPLOAD_PENDING_NOTICE)).not.toBeInTheDocument()
    // 「N 問を抽出しました」「保存されました」は出さない — 失敗を成功として見せない。
    expect(screen.queryByText(/問を抽出しました/)).not.toBeInTheDocument()
    expect(screen.queryByText(/に保存されました/)).not.toBeInTheDocument()
    // 遷移先(試験一覧)は失敗時も出すが、失敗直後に「保存して」は齟齬ゆえ出さない。
    const link = screen.getByRole('link', { name: /試験一覧/ })
    expect(link).toBeInTheDocument()
    expect(link.textContent).not.toContain('保存して')
  })

  // `failed` だけを弾く形にすると processing が「✅ 0 問を抽出しました」になる。
  // S-4(after() + poll)では processing が常態になるためクラスごと閉じる。
  it("status='processing' も緑の成功パネルを出さない(まだ処理中の案内)", async () => {
    mockGetSourceDocumentForUser.mockResolvedValue({
      id: 'doc-1',
      examName: 'テスト試験',
      status: 'processing',
    })

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/まだ処理中です/)).toBeInTheDocument()
    expect(screen.queryByText(/問を抽出しました/)).not.toBeInTheDocument()
    expect(screen.queryByText(/に保存されました/)).not.toBeInTheDocument()
    // 失敗と処理中は別の文言(中断案内を処理中に出さない)。
    expect(screen.queryByText(/問題を抽出できませんでした/)).not.toBeInTheDocument()
    // 公開文言の規律: 待ち時間の数値を出さない / 試験の削除を案内しない。
    const alertText = screen.getByRole('alert').textContent ?? ''
    expect(alertText).not.toMatch(/\d+\s*(分|秒|時間)/)
    expect(alertText).not.toContain('削除')
    // I-3(b): この面も未確定(処理中)面 — 中断を主張せず再試行も勧めない。
    // 文言は _lib/constants.ts の中立定数を共有する(同じ状況を別の言い方で説明しない)。
    // 定数は独立した 1 文として使い、exam 名は併記で保持する(canonical M-2)。
    expect(alertText).toContain(UPLOAD_PENDING_NOTICE)
    expect(alertText).toContain('テスト試験')
    expect(alertText).not.toContain('再度お試しください')
    expect(alertText).not.toContain('中断')
  })

  it("status='completed' は従来どおり成功表示(件数 + 保存先 exam 名)", async () => {
    mockGetSourceDocumentForUser.mockResolvedValue({
      id: 'doc-1',
      examName: 'テスト試験',
      status: 'completed',
    })
    mockGetCardsForSourceDocument.mockResolvedValue([
      { id: 'c1', title: '問 1', questionTextSnippet: '設問', optionCount: 4 },
      { id: 'c2', title: '問 2', questionTextSnippet: '設問', optionCount: 2 },
    ])

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByText(/2 問を抽出しました/)).toBeInTheDocument()
    expect(screen.getByText(/に保存されました/)).toBeInTheDocument()
    expect(screen.queryByText(/問題を抽出できませんでした/)).not.toBeInTheDocument()
  })

  it('doc が見つからなければ notFound()(owner scope 外 / 削除済み)', async () => {
    mockGetSourceDocumentForUser.mockResolvedValue(null)

    await expect(UploadResultPage({ params: params() })).rejects.toThrow('NEXT_NOT_FOUND')
    expect(mockGetCardsForSourceDocument).not.toHaveBeenCalled()
  })
})

// ②-4a T16-a: `result_summary` に既にある除外情報を出す(spec §13「loud failure over
// silent zero」)。 出さないと 11 問取れたときと 0 問のときが同じ見た目になる。
describe('UploadResultPage — 取り込み内訳(result_summary)の提示', () => {
  function summaryRow(over: {
    cardsExtracted?: number
    cardsTotal?: number
    cardsExcluded?: number
    figuresAttached?: number
    figuresExcluded?: Partial<Record<string, number>>
  }): Record<string, unknown> {
    return {
      schemaVersion: 1,
      operationId: 'op-1',
      examId: 'exam-1',
      sourceDocumentId: 'doc-1',
      cardsExtracted: over.cardsExtracted ?? 2,
      cardsTotal: over.cardsTotal ?? 2,
      cardsExcluded: over.cardsExcluded ?? 0,
      figuresAttached: over.figuresAttached ?? 0,
      figuresExcluded: {
        coordinate_null: 0,
        source_id_invalid: 0,
        malformed: 0,
        asset_id_invalid: 0,
        crop_failed: 0,
        image_limit_exceeded: 0,
        deadline_excluded: 0,
        ...over.figuresExcluded,
      },
      cardsPreview: [],
    }
  }

  function completedDoc() {
    mockGetSourceDocumentForUser.mockResolvedValue({
      id: 'doc-1',
      examName: 'テスト試験',
      status: 'completed',
    })
    mockGetCardsForSourceDocument.mockResolvedValue([
      { id: 'c1', title: '問 1', questionTextSnippet: '設問', optionCount: 4 },
      { id: 'c2', title: '問 2', questionTextSnippet: '設問', optionCount: 2 },
    ])
  }

  it('除外がある doc は 3 束 + card の N/M を出す(理由コードは出さない)', async () => {
    completedDoc()
    mockGetLatestCompletedUploadSummary.mockResolvedValue(
      summaryRow({
        cardsExtracted: 2,
        cardsTotal: 5,
        cardsExcluded: 3,
        figuresAttached: 4,
        // 失敗束 = 1 + 2 = 3 / 上限束 = 1 + 1 = 2
        figuresExcluded: {
          coordinate_null: 1,
          crop_failed: 2,
          image_limit_exceeded: 1,
          deadline_excluded: 1,
        },
      }),
    )

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByText('図版 4 件を取り込みました。')).toBeInTheDocument()
    expect(screen.getByText('3 件の図版は取り込めませんでした。')).toBeInTheDocument()
    expect(screen.getByText('2 件の図版は上限のため省略しました。')).toBeInTheDocument()
    expect(screen.getByText('5 問中 2 問を取り込みました。')).toBeInTheDocument()
    // 理由コードを画面に出さない(運用向け内訳は result_summary を直接引く)。
    const body = document.body.textContent ?? ''
    for (const code of [
      'coordinate_null',
      'source_id_invalid',
      'malformed',
      'asset_id_invalid',
      'crop_failed',
      'image_limit_exceeded',
      'deadline_excluded',
    ]) {
      expect(body).not.toContain(code)
    }
    // 見出しは DB の実 card 行数のまま(summary は除外ブロックにだけ使う)。
    expect(screen.getByText(/2 問を抽出しました/)).toBeInTheDocument()
  })

  // 「取り込めなかった 0 件」を毎回見せると、本当に出た日に読まれなくなる。
  it('除外が全部 0 の doc は内訳を一切出さない', async () => {
    completedDoc()
    mockGetLatestCompletedUploadSummary.mockResolvedValue(
      summaryRow({ cardsExtracted: 2, cardsTotal: 2, cardsExcluded: 0, figuresAttached: 0 }),
    )

    render(await UploadResultPage({ params: params() }))

    expect(screen.queryByText(/取り込めませんでした/)).not.toBeInTheDocument()
    expect(screen.queryByText(/上限のため省略/)).not.toBeInTheDocument()
    expect(screen.queryByText(/図版 .* 件を取り込みました/)).not.toBeInTheDocument()
    // card の N/M も出さない(見出しの「✅ N 問」と重複するだけ)。
    expect(screen.queryByText(/問中 .* 問を取り込みました/)).not.toBeInTheDocument()
    // 内訳ブロック自体を描かない — 行が 0 本の空 <ul>(余白だけが空く)も出さない。
    // pure 側の「全部 0 なら null」が消えたらここが赤くなる(canonical Minor 4)。
    const successSection = screen.getByText(/2 問を抽出しました/).closest('section')
    expect(successSection?.querySelector('ul')).toBeNull()
    // 既存の成功表示は従来どおり。
    expect(screen.getByText(/2 問を抽出しました/)).toBeInTheDocument()
  })

  // --- 行ごとの 0 件非表示(brief ④ red #2)---
  // 「ある行だけが 0」の面を作らないと、その行の gate を落としても全 test が green で
  // 通ってしまう(canonical Important 1)。3 行それぞれに「その行だけが出ない」面を持たせる。

  it('card 除外が 0 なら N/M を出さない + 上限 0 なら上限行を出さない', async () => {
    completedDoc()
    mockGetLatestCompletedUploadSummary.mockResolvedValue(
      summaryRow({ figuresAttached: 1, figuresExcluded: { crop_failed: 2 } }),
    )

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByText('図版 1 件を取り込みました。')).toBeInTheDocument()
    expect(screen.getByText('2 件の図版は取り込めませんでした。')).toBeInTheDocument()
    expect(screen.queryByText(/問中 .* 問を取り込みました/)).not.toBeInTheDocument()
    // crop が 1 件失敗しただけの平凡な upload に「0 件の図版は上限のため省略しました。」が
    // 出るのを防ぐ gate。
    expect(screen.queryByText(/上限のため省略/)).not.toBeInTheDocument()
  })

  it('上限で省いた分だけがある doc は上限行だけ出す(取り込み行 / 失敗行を出さない)', async () => {
    completedDoc()
    mockGetLatestCompletedUploadSummary.mockResolvedValue(
      summaryRow({
        figuresAttached: 0,
        figuresExcluded: { image_limit_exceeded: 3 },
      }),
    )

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByText('3 件の図版は上限のため省略しました。')).toBeInTheDocument()
    // 0 件を「取り込みました」と言わない。
    expect(screen.queryByText(/図版 .* 件を取り込みました/)).not.toBeInTheDocument()
    // 0 件を「取り込めませんでした」と言わない。
    expect(screen.queryByText(/取り込めませんでした/)).not.toBeInTheDocument()
  })

  it('summary が引けなくても既存表示は壊れない(op 無し)', async () => {
    completedDoc()
    mockGetLatestCompletedUploadSummary.mockResolvedValue(null)

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByText(/2 問を抽出しました/)).toBeInTheDocument()
    expect(screen.getByText(/に保存されました/)).toBeInTheDocument()
    expect(screen.queryByText(/取り込めませんでした/)).not.toBeInTheDocument()
  })

  it('summary が契約外の形でも落ちない(旧 payload / 壊れた行)', async () => {
    completedDoc()
    mockGetLatestCompletedUploadSummary.mockResolvedValue({
      schemaVersion: 1,
      figuresAttached: 3,
      // figuresExcluded ごと欠けている
    })

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByText(/2 問を抽出しました/)).toBeInTheDocument()
    expect(screen.queryByText(/図版 .* 件を取り込みました/)).not.toBeInTheDocument()
  })

  // 失敗 / 処理中面は summary を読まない(そもそも completed の op が無い面)。
  it("status='failed' では summary を引かない(失敗面は現状のまま)", async () => {
    mockGetSourceDocumentForUser.mockResolvedValue({
      id: 'doc-1',
      examName: 'テスト試験',
      status: 'failed',
    })

    render(await UploadResultPage({ params: params() }))

    expect(mockGetLatestCompletedUploadSummary).not.toHaveBeenCalled()
    expect(screen.getByText(/問題を抽出できませんでした/)).toBeInTheDocument()
  })
})
