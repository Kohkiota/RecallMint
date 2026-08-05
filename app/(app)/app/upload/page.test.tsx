// @vitest-environment jsdom
// ②-4a 単一 invocation Sprint Task S-4 / I-3(b): `/app/upload` 再訪時の「処理中」カードが
// **中立文言**(_lib/constants.ts の UPLOAD_PENDING_NOTICE)を出すことの pin。
//
// なぜ pin するか: この面は **結果がまだ確定していない**面である。 gate
// (hasActiveProcessingUpload)が見ているのは `status='processing'` かつ作成が
// STALE_PROCESSING_MS(15 分)以内、それだけで lease は読んでいない — ゆえに文言の
// 根拠は「実行が生きている」ことではなく「確定していない」こと(区別できない間は
// 区別できないと言う・_lib/constants.ts の分割根拠)。 ここで失敗面の文言
// (「中断された可能性があります。 …再度お試しください」)を出すと、gate が閉じていて
// UploadForm を描画しない = 行き場のない再試行を案内することになり、かつ submit 直後の
// 「閉じても処理は続きます」案内と矛盾する。 negative assert(再試行案内・中断の主張が
// 出ないこと)が I-3(b) の実質的な検出力。
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
import {
  UPLOAD_INTERRUPTED_NOTICE,
  UPLOAD_PENDING_NOTICE,
} from './_lib/constants'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAuthContext.mockResolvedValue({ dbUserId: 'user-1', plan: 'free' })
  mockGetActiveExamsForUser.mockResolvedValue([])
  mockGetCurrentMonthOcrPages.mockResolvedValue(0)
})

afterEach(() => {
  cleanup()
})

describe('UploadPage — 処理中カードの公開文言(S-4 / I-3(b))', () => {
  it('in-flight あり: 中立文言を出し、UploadForm を出さない', async () => {
    mockHasActiveProcessingUpload.mockResolvedValue(true)

    render(await UploadPage())

    expect(screen.getByText(UPLOAD_PENDING_NOTICE)).toBeInTheDocument()
    expect(screen.queryByTestId('upload-form')).not.toBeInTheDocument()
    expect(screen.getByText(/まだ完了していません/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /試験一覧/ })).toBeInTheDocument()
  })

  // I-3(b) の実質的な検出力: この面(valid lease あり)で失敗面の文言を出さない。
  // 定数を 1 本に戻す(= 中立面にも failed 文言を当てる)と、この test が落ちる。
  it('in-flight あり: 中断を主張しない / 再試行を勧めない(失敗面の文言を出さない)', async () => {
    mockHasActiveProcessingUpload.mockResolvedValue(true)

    const { container } = render(await UploadPage())

    const text = container.textContent ?? ''
    expect(text).not.toContain('再度お試しください')
    expect(text).not.toContain('中断')
    expect(text).not.toContain(UPLOAD_INTERRUPTED_NOTICE)
  })

  it('公開文言の規律: 待ち時間の数値を出さない / 試験の削除を案内しない / 待たせない', async () => {
    mockHasActiveProcessingUpload.mockResolvedValue(true)

    const { container } = render(await UploadPage())

    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\d+\s*(分|秒|時間)/)
    expect(text).not.toContain('削除')
    // 分割根拠 ③: submit 直後の banner が「閉じても処理は続きます」と離脱を勧めた直後に
    // 「お待ちください」と留め置く文言を**足す**変異は、見出しの差し替えを見る
    // getByText(/まだ完了していません/) では捕まらない(追加は既存文言を壊さない)。
    expect(text).not.toContain('お待ちください')
  })

  it('in-flight なし: 従来どおり UploadForm を描画する(gate の挙動不変)', async () => {
    mockHasActiveProcessingUpload.mockResolvedValue(false)

    render(await UploadPage())

    expect(screen.getByTestId('upload-form')).toBeInTheDocument()
    expect(screen.queryByText(UPLOAD_PENDING_NOTICE)).not.toBeInTheDocument()
  })
})
