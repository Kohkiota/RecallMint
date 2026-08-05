// @vitest-environment jsdom
// ②-4a 単一 invocation Sprint Task S-4: `/app/upload` 再訪時の「処理中」カードが
// 公開文言(_lib/constants.ts の単一定義)を出すことの pin。
//
// なぜ pin するか: この gate(hasActiveProcessingUpload)は source_document が
// 'processing' であることしか見ておらず、その実行が生きているのか既に死んで lease の
// 失効待ちなのかを区別できない。「実行中です、お待ちください」と断定すると死んでいる
// 場合に嘘になるため、poll failed / in_progress と同じ文言(待ち時間の数値なし・
// 試験の削除案内なし)へ統一した。
//
// page は server component(async function)。 auth + DB helper を mock し、
// `await Page()` の JSX を render する(result/[sourceDocumentId]/page.test.tsx と同方式)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const {
  mockGetAuthContext,
  mockGetCurrentUser,
  mockHasActiveProcessingUpload,
  mockGetActiveExamsForUser,
  mockGetCurrentMonthOcrPages,
} = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  mockHasActiveProcessingUpload: vi.fn(),
  mockGetActiveExamsForUser: vi.fn(),
  mockGetCurrentMonthOcrPages: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getAuthContext: mockGetAuthContext,
  getCurrentUser: mockGetCurrentUser,
}))
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: async (_userId: string, fn: (tx: unknown) => unknown) => fn({}),
}))
vi.mock('@/lib/exams/list', () => ({
  getActiveExamsForUser: mockGetActiveExamsForUser,
}))
vi.mock('@/lib/ai-usage-mcq', () => ({
  getCurrentMonthOcrPages: mockGetCurrentMonthOcrPages,
}))
vi.mock('@/lib/exams/source-doc-status', () => ({
  hasActiveProcessingUpload: mockHasActiveProcessingUpload,
}))
// UploadForm は client component(圧縮 / PDF 解析 / poll)。この page test の関心は
// gate 分岐と文言だけなので、module ごと差し替えて client 依存を引き込まない。
vi.mock('./_components/upload-form', () => ({
  UploadForm: () => <div data-testid="upload-form" />,
}))

import UploadPage from './page'
import { UPLOAD_INTERRUPTED_NOTICE } from './_lib/constants'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAuthContext.mockResolvedValue({ dbUserId: 'user-1', plan: 'free' })
  mockGetActiveExamsForUser.mockResolvedValue([])
  mockGetCurrentMonthOcrPages.mockResolvedValue(0)
})

afterEach(() => {
  cleanup()
})

describe('UploadPage — 処理中カードの公開文言(S-4)', () => {
  it('in-flight あり: 公開文言(単一定義)を出し、UploadForm を出さない', async () => {
    mockHasActiveProcessingUpload.mockResolvedValue(true)

    render(await UploadPage())

    expect(screen.getByText(UPLOAD_INTERRUPTED_NOTICE)).toBeInTheDocument()
    expect(screen.queryByTestId('upload-form')).not.toBeInTheDocument()
    // 見出し / 本文のどちらでも「実行中」と断定しない(canonical I-3(a)): 断定を
    // 残すと直下の公開文言「中断された可能性があります」と同じカード内で矛盾する。
    expect(screen.queryByText(/完了までしばらくお待ちください/)).not.toBeInTheDocument()
    expect(screen.queryByText(/抽出中です/)).not.toBeInTheDocument()
    expect(screen.getByText(/まだ完了していません/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /試験一覧/ })).toBeInTheDocument()
  })

  it('公開文言の規律: 待ち時間の数値を出さない / 試験の削除を案内しない', async () => {
    mockHasActiveProcessingUpload.mockResolvedValue(true)

    const { container } = render(await UploadPage())

    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\d+\s*(分|秒|時間)/)
    expect(text).not.toContain('削除')
  })

  it('in-flight なし: 従来どおり UploadForm を描画する(gate の挙動不変)', async () => {
    mockHasActiveProcessingUpload.mockResolvedValue(false)

    render(await UploadPage())

    expect(screen.getByTestId('upload-form')).toBeInTheDocument()
    expect(screen.queryByText(UPLOAD_INTERRUPTED_NOTICE)).not.toBeInTheDocument()
  })
})
