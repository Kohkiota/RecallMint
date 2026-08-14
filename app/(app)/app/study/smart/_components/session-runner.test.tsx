// @vitest-environment jsdom
// SessionRunner client component の test (S2.2.3 T1 で 3-button nav 拡張)。
//
// Phase machine: selecting → judged → finished
// - selecting (両モード共通): opt click + 「回答する」 で判定のみ (submit せず) → judged 遷移
//   3 button footer: 「← 前へ」 / 「回答する」 (primary) / 「次へ →」 (skip)
// - judged (通常): 3 button footer: 「← 前へ」 / 「↺ リトライ」 / 「次へ →」 (primary, auto submit)
// - judged (FSRS): 上段 4 rate (Again/Hard/Good/Easy) で submit + lastRating セット (自動次へなし)
//   下段 3 nav: 「← 前へ」 / 「↺ リトライ」 / 「次へ →」 (rate 後のみ enable、 submit なし純遷移)
// - finished: 統計 + もう一度 / ダッシュボードへ
//
// next/navigation / lib/sync/review-events は mock。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { Card } from '@/lib/db/schema'

// T11: SessionRunner は CardImageGallery (readOnly) を transitively import する。
// card-image-gallery.tsx 自体は ../../../exams/[id]/_actions/asset-actions ('use server' +
// R2_* env fail-fast) と @/lib/media/get-asset を real import するため、 未 mock だと module
// load 時に throw する (card-image-gallery.test.tsx と同じ制約)。 ここでは gallery 本体は
// real のまま、 その依存のみ mock して readOnly thumbnail 描画を検証する。
const { mockGetAssetObjectURL, mockReserveAsset, mockFinalizeAsset, mockResolveAssetUrls } =
  vi.hoisted(() => ({
    mockGetAssetObjectURL: vi.fn(),
    mockReserveAsset: vi.fn(),
    mockFinalizeAsset: vi.fn(),
    mockResolveAssetUrls: vi.fn(),
  }))

vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: mockGetAssetObjectURL,
}))
vi.mock('../../../exams/[id]/_actions/asset-actions', () => ({
  reserveAsset: mockReserveAsset,
  finalizeAsset: mockFinalizeAsset,
  resolveAssetUrls: mockResolveAssetUrls,
}))
// getClientDb().media_assets.get(key) の best-effort width/height 読み取りは
// card-image-gallery.test.tsx と同じ最小 stub (未定義でも壊れない)。
vi.mock('@/lib/client-db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/client-db')>('@/lib/client-db')
  return {
    ...actual,
    getClientDb: () => ({
      ...actual.getClientDb(),
      media_assets: { get: vi.fn(async () => undefined) },
    }),
  }
})

// -----------------------------------------------------------------------
// Hoisted mocks
// -----------------------------------------------------------------------
// S-cache-1: 旧 submitReview server action は撤去済 (bulk API + Dexie 経路へ完全移行)。
// submit 系の検証は lib/sync/review-events 経由の mockRecordAnswerEvent
// (card_id / is_correct / 呼ばれない事) に一本化している。
const {
  mockRefresh,
  mockPush,
  mockRecordAnswerEvent,
  mockCountPendingAnswerEvents,
  mockRunGuardedFlush,
  mockPullBack,
} = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockPush: vi.fn(),
  mockRecordAnswerEvent: vi.fn(),
  mockCountPendingAnswerEvents: vi.fn(),
  mockRunGuardedFlush: vi.fn(),
  mockPullBack: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: mockPush }),
}))

vi.mock('@/lib/sync/review-events', () => ({
  recordAnswerEvent: mockRecordAnswerEvent,
  countPendingAnswerEvents: mockCountPendingAnswerEvents,
}))

// 演習 flush は 3 入口とも runGuardedAnswerEventFlush (Web Locks 経由) を通る。
// component test は「どの入口が何を渡して呼ぶか」 の配線のみを見る。
vi.mock('@/lib/sync/review-flush', () => ({
  runGuardedAnswerEventFlush: mockRunGuardedFlush,
}))

vi.mock('@/lib/sync/pull-back', () => ({
  pullBack: mockPullBack,
}))

// 各 test の SessionRunner JSX に渡す session_id / user_id。 mock injection 済のため
// 値は形式が合っていれば bulk API には実際には届かない。
const TEST_SESSION_ID = '00000000-0000-4000-a000-000000000001'
const TEST_USER_ID = '00000000-0000-4000-a000-0000000000ff'

// -----------------------------------------------------------------------
// Import under test (after mocks)
// -----------------------------------------------------------------------
import { SessionRunner } from './session-runner'

// -----------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------
function makeCard(overrides?: Partial<Card>): Card {
  return {
    id: 'card-1',
    userId: 'user-1',
    examId: 'exam-1',
    sourceDocumentId: null,
    // default title は既存 test の questionText override 値 ('問1', '問2', ...) と
    // 衝突しないユニーク値。 title 表示テストで明示的に上書きする場合のみ '問1' 等を使う。
    title: 'カードタイトル既定',
    questionLabel: null,
    baseOrder: 1024,
    questionText: '問題文テキスト',
    options: [
      { id: 'a', text: '選択肢A', is_correct: false },
      { id: 'b', text: '選択肢B', is_correct: true, explanation: '選択肢B解説' },
    ],
    correctAnswerIds: ['b'],
    explanationText: 'カード全体の解説',
    memo: null,
    images: [],
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
    due: new Date('2020-01-01'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    contentVersion: 0,
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-01'),
    ...overrides,
  } as Card
}

beforeEach(() => {
  vi.clearAllMocks()
  // S-cache-1 新 path のデフォルト挙動 (success / pending 0 / flush no-op)。
  // 各 test は必要に応じて mockResolvedValueOnce で override する。
  mockRecordAnswerEvent.mockResolvedValue(undefined)
  mockCountPendingAnswerEvents.mockResolvedValue(0)
  // flush は threshold (経路 1) / finished useEffect (経路 2) の両方から呼ばれる。
  // デフォルトは「送るものなし」= pull-back 不発。
  mockRunGuardedFlush.mockResolvedValue('no-pending')
  // T11: CardImageGallery (readOnly) の thumbnail 解決。 デフォルトは resolve 成功。
  mockGetAssetObjectURL.mockResolvedValue('blob:mock-object-url')
})

afterEach(() => {
  cleanup()
})

// -----------------------------------------------------------------------
// 共通 helper
// -----------------------------------------------------------------------
function clickOption(text: string) {
  // opt は button role (selecting 中 click 可能)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(text) }))
}

// label の揺れに耐える regex で 3 nav button を取得 (icon + 「前へ」 等)
const NAME_PREV = /前へ/
const NAME_NEXT = /次へ/
const NAME_RETRY = /リトライ/

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------
describe('SessionRunner (3-button nav, S2.2.3 T1)', () => {
  it('初期描画: 問題文 + 選択肢 + 3 button (前へ disabled / 回答する 常時 enabled / 次へ enabled)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    expect(screen.getByText('問題文テキスト')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /選択肢A/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /選択肢B/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
    // idx=0 で「前へ」 disabled、 「次へ」 (skip) は常時 enabled
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
  })

  it('opt click で selectedIds 追加、 再 click で削除 (toggle)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    const optA = screen.getByRole('button', { name: /選択肢A/ })
    fireEvent.click(optA)
    expect(optA).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(optA)
    expect(optA).toHaveAttribute('aria-pressed', 'false')
  })

  it('1 件以上選択で 「回答する」 が enabled (通常モード)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢A')
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
  })

  it('selecting (両モード共通): FSRS モードでも footer は 3 button、 rate ボタンは存在しない', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()
    // selecting では 4 rate ボタン無し
    expect(screen.queryByRole('button', { name: 'Again' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hard' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Good' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Easy' })).not.toBeInTheDocument()
  })

  it('1 件以上選択で 「回答する」 が enabled (FSRS モードも同じ)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
    clickOption('選択肢B')
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
  })

  it('通常モード: 「回答する」 押下時に recordAnswerEvent は呼ばれず、 judged 遷移 + 解説 + 3 button (前へ/リトライ/次へ) 表示', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))

    // judged phase: 解説 + 3 nav
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_RETRY })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()
    expect(screen.getByText(/正解/)).toBeInTheDocument()
    // 「回答する」 は judged では消える
    expect(screen.queryByRole('button', { name: '回答する' })).not.toBeInTheDocument()
    // submit は呼ばれない (判定のみ)
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
  })

  it('通常モード: 誤答選択 → 「回答する」 で判定のみ (submit せず) + 不正解表示', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))

    expect(screen.getByText(/不正解/)).toBeInTheDocument()
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
  })

  it('通常モード: judged 「次へ」 で recordAnswerEvent(card_id) が呼ばれ次 card に遷移 (correct 時)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)

    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // 「次へ」 押下が submit を起動
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => {
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(expect.objectContaining({ card_id: 'c1' }))
    })
    // 問2 に進んでいる
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
  })

  it('通常モード: judged 「次へ」 で recordAnswerEvent が呼ばれる (incorrect 時)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)

    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => {
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(expect.objectContaining({ card_id: 'c1' }))
    })
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
  })

  // S-cache-1: 旧 submitReview の error→alert UI は撤去済。 Dexie 経路では flush 失敗時も
  // pending のまま次 trigger で retry し、 UI には error を出さない (silent retry)。
  // → このシナリオは新 path で「next card 即遷移 + alert なし」が期待挙動。
  it('通常モード: 「次へ」 押下で fire-and-forget recordAnswerEvent + 即 next card (error UI なし、 S-cache-1)', async () => {
    // Dexie 書込失敗を模擬 (実際はほぼ起きないが defensive)。
    mockRecordAnswerEvent.mockRejectedValueOnce(new Error('idb write failed'))
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    // 即 next card に遷移 (await なし、 fire-and-forget)
    expect(screen.getByText('問2')).toBeInTheDocument()
    // recordAnswerEvent は呼ばれている
    expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ card_id: 'c1' }),
    )
    // 旧 submit error UI は廃止: 次 card 上に alert が出ない (silent retry 設計)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('FSRS モード: 「回答する」 押下時に recordAnswerEvent は呼ばれず、 judged 遷移 + 4 rate + 3 nav (下段) 表示', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))

    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    // 上段 4 rate
    expect(screen.getByRole('button', { name: 'Again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Good' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Easy' })).toBeInTheDocument()
    // 下段 3 nav (前へ / リトライ / 次へ)
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_RETRY })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()
    // 「回答する」 は消える
    expect(screen.queryByRole('button', { name: '回答する' })).not.toBeInTheDocument()
    // rate 未押下 → 「前へ」 (idx=0 でもあり) / 「次へ」 disabled、 「リトライ」 enabled
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_RETRY })).not.toBeDisabled()
    // submit はまだ呼ばれない
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
  })

  it('FSRS モード (rate-then-confirm): Hard 押下では fire しない / 「次へ」 で rating=2 が fire', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)

    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // 新仕様: judged で Hard 押下は state 更新のみ。 Dexie write は呼ばない
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    // micro task を進めても rate click では recordAnswerEvent fire しない
    await new Promise((r) => setTimeout(r, 30))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    // judged 維持 (問1 のまま)、 lastRating セット → 「次へ」 が enable に変わる
    expect(screen.getByText('問1')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // 「次へ」 押下で rating=2 が 1 件 fire
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() =>
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ card_id: 'c1', rating: 2 }),
      ),
    )
    expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1)
  })

  it('FSRS モード (rate-then-confirm): rate 押下で fire しない / 「次へ」 で 1 件 fire + 問2 遷移 + selecting reset', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)

    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    // 新仕様: rate click 単独では fire しない
    await new Promise((r) => setTimeout(r, 30))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })

    // 「次へ」 押下 → rating=3 で 1 件 fire + 問2 遷移
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1)
    expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ card_id: 'c1', rating: 3 }),
    )
    // selecting reset 後も「回答する」 は常時 enable (選択 0 件でも押下可)
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
  })

  it('FSRS モード (rate-then-confirm): Again/Good/Easy 押下では 0 件 / 「次へ」 で rating=1|3|4 が 1 件 fire (連続 unmount)', async () => {
    {
      const { unmount } = render(
        <SessionRunner cards={[makeCard({ id: 'cA' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
      )
      clickOption('選択肢A')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Again' }))
      // rate click では fire しない
      await new Promise((r) => setTimeout(r, 20))
      expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
      // 「次へ」 押下で rating=1 が 1 件 fire
      fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
      await waitFor(() =>
        expect(mockRecordAnswerEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({ card_id: 'cA', rating: 1 }),
        ),
      )
      expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1)
      unmount()
    }
    {
      const { unmount } = render(
        <SessionRunner cards={[makeCard({ id: 'cG' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
      )
      clickOption('選択肢A')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Good' }))
      await new Promise((r) => setTimeout(r, 20))
      // (vi.clearAllMocks は beforeEach のみ。 ここでは前 block 後の mock state を引き継ぐが、
      //  前 block で 1 回 fire 済なので「rate click が新たに fire していない」 ことを件数で確認)
      const callsBeforeNext = mockRecordAnswerEvent.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
      await waitFor(() =>
        expect(mockRecordAnswerEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({ card_id: 'cG', rating: 3 }),
        ),
      )
      expect(mockRecordAnswerEvent.mock.calls.length).toBe(callsBeforeNext + 1)
      unmount()
    }
    {
      render(<SessionRunner cards={[makeCard({ id: 'cE' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
      clickOption('選択肢A')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Easy' }))
      await new Promise((r) => setTimeout(r, 20))
      const callsBeforeNext = mockRecordAnswerEvent.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
      await waitFor(() =>
        expect(mockRecordAnswerEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({ card_id: 'cE', rating: 4 }),
        ),
      )
      expect(mockRecordAnswerEvent.mock.calls.length).toBe(callsBeforeNext + 1)
    }
  })

  // S-cache-1: rate submit の error UI 経路は除去済。 Dexie 失敗時も alert なし、
  // lastRating / button enable 状態は Optimistic のまま保持されることを検証。
  it('FSRS モード: rate 時 Dexie 失敗でも judged 維持 + 4 ボタン enable のまま + lastRating Optimistic + 「次へ」 enable (alert なし、 S-cache-1)', async () => {
    mockRecordAnswerEvent.mockRejectedValueOnce(new Error('idb write failed'))
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))

    // 旧 error UI は廃止: alert は出ない (silent retry 設計)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // judged 維持 (解説 + 4 ボタン残置)
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    // 4 ボタンは常時 enable (pending gate 撤回)、 再押下で上書き record 可
    expect(screen.getByRole('button', { name: 'Again' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Hard' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Good' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Easy' })).not.toBeDisabled()
    // Optimistic: lastRating は click 時に Good 固定済、 「次へ」 enable
    expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
  })

  it('B2 fix: opt.id と一致する先頭 ID prefix (例 "1誤正正誤") を strip し、 ID は太字 span で 1 回だけ表示', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1誤正正誤', is_correct: false },
        { id: '2', text: '2正解候補', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)

    expect(screen.queryByText('1誤正正誤', { exact: true })).not.toBeInTheDocument()
    const opt1Btn = screen.getByRole('button', { name: /誤正正誤/ })
    expect(opt1Btn).toBeInTheDocument()
    const idSpans = opt1Btn.querySelectorAll('span.font-medium')
    const idSpansWith1 = Array.from(idSpans).filter((s) => s.textContent === '1')
    expect(idSpansWith1).toHaveLength(1)
  })

  it('B2 fix (review I-1 A 案): ID 直後が数字の場合は同一 token とみなし strip しない ("1990s" 保全)', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1990s', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    const opt1Btn = screen.getByRole('button', { name: /1990s/ })
    expect(opt1Btn).toBeInTheDocument()
  })

  it('B2 fix: "1) 答え" 形式 (ID + 閉じ括弧 + 半角 space) も strip', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1) 答え', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    const opt1Btn = screen.getByRole('button', { name: /^○?\s*1\s*答え$/ })
    expect(opt1Btn).toBeInTheDocument()
    expect(screen.queryByText('1) 答え', { exact: true })).not.toBeInTheDocument()
  })

  it('B2 fix: "1. 答え" 形式 (ID + 半角ドット) も strip', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1. 答え', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    expect(screen.queryByText('1. 答え', { exact: true })).not.toBeInTheDocument()
    const opt1Btn = screen.getByRole('button', { name: /答え/ })
    expect(opt1Btn).toBeInTheDocument()
  })

  it('B2 fix: "1 答え" 形式 (ID + 半角 space) も strip', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1 答え', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    expect(screen.queryByText('1 答え', { exact: true })).not.toBeInTheDocument()
    const opt1Btn = screen.getByRole('button', { name: /答え/ })
    expect(opt1Btn).toBeInTheDocument()
  })

  it('B2 fix: opt.text が opt.id で始まらない場合 (例 "単独") は strip しない', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '単独', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    const opt1Btn = screen.getByRole('button', { name: /単独/ })
    expect(opt1Btn).toBeInTheDocument()
  })

  it('B2 fix: 2 桁 ID ("12誤正" + opt.id="12") も startsWith マッチで strip', () => {
    const card = makeCard({
      options: [
        { id: '12', text: '12誤正', is_correct: false },
        { id: '13', text: '13正解', is_correct: true },
      ],
      correctAnswerIds: ['13'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    expect(screen.queryByText('12誤正', { exact: true })).not.toBeInTheDocument()
    const opt12Btn = screen.getByRole('button', { name: /誤正/ })
    expect(opt12Btn).toBeInTheDocument()
  })

  it('B2 fix (review I-1 trade-off 犠牲ケース): "1.5g" は ID + ドット strip 規則に従い "5g" 表示 (OT 承認済)', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1.5g', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    const opt1Btn = screen.getByRole('button', { name: /5g/ })
    expect(opt1Btn).toBeInTheDocument()
    expect(screen.queryByText('1.5g', { exact: true })).not.toBeInTheDocument()
  })

  it('judged 後: 正答 opt に ○、 非正答 opt に × mark', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    expect(screen.getByText('○')).toBeInTheDocument()
    expect(screen.getByText('×')).toBeInTheDocument()
  })

  it('judged 後 opt click は無効 (selectedIds 変わらない)', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()

    const optB = screen.getByRole('button', { name: /選択肢B/ })
    expect(optB).toBeDisabled()
  })

  it('3 枚連続 (通常モード) → 完了画面 (3/2/67%)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
      makeCard({ id: 'c3', questionText: '問3' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)

    // Card 1: 正答 → 回答する → 次へ (submit)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    // Card 2: 正答
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    // Card 3: 誤答
    await waitFor(() => expect(screen.getByText('問3')).toBeInTheDocument())
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    await waitFor(() => {
      expect(screen.getByText('🎉')).toBeInTheDocument()
      expect(screen.getByText(/3 枚/)).toBeInTheDocument()
      expect(screen.getByText(/2 正解/)).toBeInTheDocument()
      expect(screen.getByText(/67%/)).toBeInTheDocument()
    })
  })

  it('card 切替で selectedIds / phase が reset (前 card の選択を引き継がない)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)

    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
    const opts = screen.getAllByRole('button', { name: /選択肢/ })
    opts.forEach((o) => expect(o).toHaveAttribute('aria-pressed', 'false'))
  })

  it('完了画面の「もう一度」で router.refresh が呼ばれる', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'もう一度' }))
    expect(mockRefresh).toHaveBeenCalledOnce()
  })

  it('完了画面の「ダッシュボードへ」は <button> として render される (Link ではない)', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())

    // Link → Button: click で即 router.push('/app')。
    // flush は finished useEffect が fire-and-forget で担う。
    expect(screen.queryByRole('link', { name: 'ダッシュボードへ' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ダッシュボードへ' })).toBeInTheDocument()
  })

  it('カード進行インジケーター (1 / N) が表示される', () => {
    const cards = [makeCard({ id: 'c1' }), makeCard({ id: 'c2' })]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })

  it('集合一致 boundary: 複数正答 opt の片方だけ選択は incorrect → 「次へ」 で rating=1 submit', async () => {
    const card = makeCard({
      options: [
        { id: 'a', text: '選択肢A', is_correct: true },
        { id: 'b', text: '選択肢B', is_correct: true },
        { id: 'c', text: '選択肢C', is_correct: false },
      ],
      correctAnswerIds: ['a', 'b'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByText(/不正解/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenCalledWith(expect.objectContaining({ card_id: 'card-1' })))
  })

  it('集合一致 boundary: 複数正答 opt を完全一致選択は correct → 「次へ」 で rating=3 submit', async () => {
    const card = makeCard({
      options: [
        { id: 'a', text: '選択肢A', is_correct: true },
        { id: 'b', text: '選択肢B', is_correct: true },
        { id: 'c', text: '選択肢C', is_correct: false },
      ],
      correctAnswerIds: ['a', 'b'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢A')
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByText(/^正解/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenCalledWith(expect.objectContaining({ card_id: 'card-1' })))
  })

  it('集合一致 boundary: 余剰 opt 選択 (正答 + 誤答) は incorrect → 「次へ」 で rating=1 submit', async () => {
    const card = makeCard({
      options: [
        { id: 'a', text: '選択肢A', is_correct: true },
        { id: 'b', text: '選択肢B', is_correct: false },
      ],
      correctAnswerIds: ['a'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢A')
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenCalledWith(expect.objectContaining({ card_id: 'card-1' })))
  })

  // -------------------------------------------------------------------------
  // 出題 box の見出しは card.title (固定文字列 「問題」 ラベル廃止)
  // -------------------------------------------------------------------------
  it('出題画面: 出題 box に current.title が表示される (固定文字列「問題」 ではなく)', () => {
    render(
      <SessionRunner
        cards={[makeCard({ title: '問109' })]}
        fsrsMode={false}
        userId={TEST_USER_ID} sessionId={TEST_SESSION_ID}
      />,
    )
    expect(screen.getByText('問109')).toBeInTheDocument()
    // 旧固定ラベルは消えている
    expect(screen.queryByText('問題', { exact: true })).not.toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // 選択 0 件回答 (disabled 撤去後の挙動)
  // -------------------------------------------------------------------------
  it('選択 0 件回答 (正解あり card): 「回答する」 押下で 不正解判定 + judged 遷移 + 「次へ」 で rating=1 submit', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    // 何も選択せず 「回答する」
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // equalSet([], ['b']) = false → 不正解
    expect(screen.getByText(/不正解/)).toBeInTheDocument()
    // judged 遷移: 「次へ」 で c1 を rating=1 で submit + 問2 へ
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() =>
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ card_id: 'c1', is_correct: false, rating: 1 }),
      ),
    )
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
  })

  it('選択 0 件回答 (正解 0 件 card、 OCR 由来エッジケース): equalSet([], []) で正解判定 + judged 遷移', () => {
    // OCR が正答未抽出のまま保存された card (全 opt is_correct=false)。
    // validation/card.ts の意図的な「正答数下限なし」 仕様 (§2.5.2) と対応。
    const card = makeCard({
      options: [
        { id: 'a', text: '選択肢A', is_correct: false },
        { id: 'b', text: '選択肢B', is_correct: false },
      ],
      correctAnswerIds: [],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // equalSet([], []) = true → 「正解」 banner (現仕様、 ガード追加なし)
    expect(screen.getByText(/^正解/)).toBeInTheDocument()
    // judged footer 3 button が表示され、 次へ進める
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_RETRY })).toBeInTheDocument()
  })
})

// -----------------------------------------------------------------------
// S2.2.3 T1 新規: 3-button nav (前へ / リトライ / 次へ) の追加 spec
// -----------------------------------------------------------------------
describe('SessionRunner (S2.2.3 T1: 前後ナビ + リトライ)', () => {
  // ---------------------------------------------------------------------
  // selecting footer
  // ---------------------------------------------------------------------

  it('selecting: idx=0 で「前へ」 disabled、 「回答する」 常時 enabled、 「次へ」 常時 enabled', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
  })

  it('selecting: 「次へ」 押下 → submit せず idx+1、 「回答する」 再表示 (selecting reset)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    // 1 件選択した上で「次へ」 (スキップ) → submit せず進む
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    expect(screen.getByText('問2')).toBeInTheDocument()
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    // 問2 では選択 reset。 「回答する」 は常時 enable (新仕様)
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
  })

  it('selecting: idx>=1 で「前へ」 enable、 押下で idx-1 + selectedIds reset', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    // 問1 を選択せずスキップ → 問2 へ
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    expect(screen.getByText('問2')).toBeInTheDocument()
    // 問2 で「前へ」 enable、 1 件選択した状態で押下
    expect(screen.getByRole('button', { name: NAME_PREV })).not.toBeDisabled()
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: NAME_PREV }))
    // 問1 へ戻り、 selectedIds reset
    expect(screen.getByText('問1')).toBeInTheDocument()
    const optA = screen.getByRole('button', { name: /選択肢A/ })
    expect(optA).toHaveAttribute('aria-pressed', 'false')
    // 「前へ」 (idx=0) は再 disabled
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    // submit は呼ばれていない
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
  })

  it('selecting: 最後の card で「次へ」 押下 → finished phase', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    // finished
    expect(screen.getByText('🎉')).toBeInTheDocument()
    // tally 0 (スキップなので answered 増えない)
    expect(screen.getByText(/0 枚/)).toBeInTheDocument()
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------
  // judged 通常モード footer
  // ---------------------------------------------------------------------

  it('judged 通常モード: 3 button (前へ / リトライ / 次へ) 表示、 idx=0 で「前へ」 disabled、 「リトライ」 / 「次へ」 enabled', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_RETRY })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
  })

  it('judged 通常モード: 「リトライ」 押下 → selecting reset + 選択解除 + submit なし', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // judged 中
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: NAME_RETRY }))
    // selecting に戻る (「回答する」 再表示、 解説非表示)
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
    expect(screen.queryByText('カード全体の解説')).not.toBeInTheDocument()
    // 選択 reset
    const optB = screen.getByRole('button', { name: /選択肢B/ })
    expect(optB).toHaveAttribute('aria-pressed', 'false')
    // submit は呼ばれない
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
  })

  it('judged 通常モード: 「前へ」 押下 → idx-1 + selecting reset + submit なし', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    // 問1 スキップ → 問2
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    expect(screen.getByText('問2')).toBeInTheDocument()
    // 問2 で回答 → judged
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    // 「前へ」 → 問1 へ戻る (selecting reset)
    fireEvent.click(screen.getByRole('button', { name: NAME_PREV }))
    expect(screen.getByText('問1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.queryByText('カード全体の解説')).not.toBeInTheDocument()
    // submit は呼ばれていない
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------
  // judged FSRS モード footer
  // ---------------------------------------------------------------------

  it('judged FSRS モード: 4 rate (上段) + 3 nav (下段) 表示、 lastRating=null で「前へ」 / 「次へ」 disabled、 「リトライ」 enabled', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    // 問1 スキップ → 問2 (idx=1) で「前へ」 が idx 条件単独では enable のはず
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // 上段 4 rate
    expect(screen.getByRole('button', { name: 'Again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Easy' })).toBeInTheDocument()
    // 下段 3 nav
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_RETRY })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()
    // rate 未押下: idx>=1 でも lastRating === null で「前へ」 / 「次へ」 disabled
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_RETRY })).not.toBeDisabled()
  })

  it('judged FSRS モード (rate-then-confirm): Hard 押下では fire しない + lastRating セット → 「次へ」 enable (idx=0 で「前へ」 は idx 条件で disabled)', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    // rate click では fire しない
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    // lastRating セット → 「次へ」 enable
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // idx=0 なので「前へ」 は依然 disabled
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
  })

  it('judged FSRS モード (rate-then-confirm): idx>=1 + rate 押下後で「前へ」 enable (rate click 単独では fire しない)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    // 問1 スキップ → 問2 で回答 → judged
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    // 新仕様: rate click では fire しない (lastRating セットのみ)
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_PREV })).not.toBeDisabled()
    })
    expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
  })

  it('judged FSRS モード (rate-then-confirm): rate 連打では fire 0 件 / 「次へ」 で lastRating の 1 件のみ fire + client tally は初回のみ +1', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // 1 回目: Good (Optimistic tally +1、 state-only)
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    // 2 回目: Hard (state 上書きのみ、 tally 不変)
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    // 新仕様: rate 連打中は fire しない
    await new Promise((r) => setTimeout(r, 30))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    // 「次へ」 enable まで待つ
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // 「次へ」 押下 → lastRating (= Hard = rating=2) で 1 件のみ fire + finished
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1)
    expect(mockRecordAnswerEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ card_id: 'c1', rating: 2 }),
    )
    // tally は 1 枚 / 1 正解 / 100% (初回 click 時 correctSnapshot=true で +1 固定)
    expect(screen.getByText(/1 枚/)).toBeInTheDocument()
    expect(screen.getByText(/1 正解/)).toBeInTheDocument()
    expect(screen.getByText(/100%/)).toBeInTheDocument()
  })

  it('judged FSRS モード (rate-then-confirm): 「リトライ」 → selecting reset + lastRating=null + 4 rate / 「次へ」 が再 disabled (rate click では fire しない)', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    // rate click では fire しない (state-only)
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // 「リトライ」 → selecting reset
    fireEvent.click(screen.getByRole('button', { name: NAME_RETRY }))
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
    // 4 rate ボタンは judged でしか出ないので消える
    expect(screen.queryByRole('button', { name: 'Again' })).not.toBeInTheDocument()
    // 再選択 → 回答 → judged で「次へ」 が rate 前 disabled に戻る (lastRating=null)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeDisabled()
  })

  it('judged FSRS モード (rate-then-confirm): 「前へ」 (rate 後) → 1 件 submit + 問1 遷移 + selecting reset', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    // 問1 スキップ → 問2 で回答 → Good (state-only、 fire しない)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    // 新仕様: rate click では fire しない
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_PREV })).not.toBeDisabled()
    })
    // 「前へ」 押下 → rating=3 で 1 件 fire + 問1 へ戻り selecting reset
    fireEvent.click(screen.getByRole('button', { name: NAME_PREV }))
    expect(screen.getByText('問1')).toBeInTheDocument()
    await waitFor(() =>
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ card_id: 'c2', rating: 3 }),
      ),
    )
    expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
  })

  it('FSRS モード最後の card (rate-then-confirm): rate 押下 0 件 / 「次へ」 で 1 件 fire + finished phase', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Easy' }))
    // rate click では fire しない
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    // 「次へ」 で rating=4 が 1 件 fire
    expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1)
    expect(mockRecordAnswerEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ card_id: 'c1', rating: 4 }),
    )
  })

  // ---------------------------------------------------------------------
  // S2.2.3 T1 review I-1 fix: tally 真実 source を submittedCardIds に切替
  // (lastRating === null base では resetCardState で null 戻り → 再 submit 時に
  // isFirstSubmit が再 true になり tally 二重加算する bug があった)
  // ---------------------------------------------------------------------

  it('FSRS モード (rate-then-confirm): リトライ後の再 submit で tally が二重加算されない (1 枚 / 1 正解)', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    // 1 回目: 正答選択 → 回答 → Good (state-only、 Optimistic tally +1)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    // 新仕様: rate click では fire しない
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // リトライ → selecting reset (lastRating=null だが submittedCardIds は c1 保持)
    fireEvent.click(screen.getByRole('button', { name: NAME_RETRY }))
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
    // 再選択 → 回答 → Hard (state-only、 tally +1 しない: submittedCardIds に c1 既存)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // 「次へ」 → finished: lastRating=2 で 1 件 fire / tally 1 枚 / 1 正解 (初回 correctSnapshot=true を維持)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1)
    expect(mockRecordAnswerEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ card_id: 'c1', rating: 2 }),
    )
    expect(screen.getByText(/1 枚/)).toBeInTheDocument()
    expect(screen.getByText(/1 正解/)).toBeInTheDocument()
  })

  it('通常モード: 前へ戻り後の再 submit で tally が二重加算されない (2 枚 / 1 正解)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    // 問1: 選択B → 回答 → 次へ (auto submit rating=3、 tally=1/1)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenLastCalledWith(expect.objectContaining({ card_id: 'c1' })))
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    // 問2 で 「前へ」 → 問1 戻り (selecting reset、 submittedCardIds は c1 保持)
    fireEvent.click(screen.getByRole('button', { name: NAME_PREV }))
    expect(screen.getByText('問1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
    // 問1 を再回答 (誤答) → 次へ (上書き submit rating=1、 tally は二重加算しない)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenLastCalledWith(expect.objectContaining({ card_id: 'c1' })))
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    // 問2: 選択A (誤答) → 回答 → 次へ (auto submit rating=1、 tally +1 / correct +0)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenLastCalledWith(expect.objectContaining({ card_id: 'c2' })))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    // tally 2 枚 / 1 正解 (c1 は初回 correctSnapshot=true 維持で +1、 c2 incorrect で +0)
    // 二重加算していなければ answered=2 / correct=1 になる (c1 の再 submit で +1 されたら 3 枚 or 2 正解)
    expect(screen.getByText(/2 枚/)).toBeInTheDocument()
    expect(screen.getByText(/1 正解/)).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // S2.2.5: FSRS rate ボタン押下ハイライト (濃色 fill + 白文字、 S2.2.4 selected fill bug fix)
  // -------------------------------------------------------------------------
  describe('S2.2.5: FSRS rate ボタン押下ハイライト (濃色 fill)', () => {
    it('rate 未押下 (lastRating=null) では 4 ボタンとも idle class (selected fill class なし)', async () => {
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Again' })).toBeInTheDocument())
      // selected 用の bg-*-600 / text-white がついていない
      expect(screen.getByRole('button', { name: 'Again' })).not.toHaveClass('bg-red-600')
      expect(screen.getByRole('button', { name: 'Hard' })).not.toHaveClass('bg-orange-600')
      expect(screen.getByRole('button', { name: 'Good' })).not.toHaveClass('bg-emerald-600')
      expect(screen.getByRole('button', { name: 'Easy' })).not.toHaveClass('bg-blue-600')
      expect(screen.getByRole('button', { name: 'Again' })).not.toHaveClass('text-white')
    })

    it('Hard 押下後 (rate-then-confirm): Hard のみ orange-600 fill + text-white、 他 3 つは idle のまま (rate click は state-only / fire しない)', async () => {
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
      // Hard に selected fill + 白文字 (Optimistic、 同期反映)
      expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('bg-orange-600')
      expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('text-white')
      // 新仕様: rate click では Dexie write しない
      await new Promise((r) => setTimeout(r, 20))
      expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
      // 他は idle (fill / 白文字 なし)
      expect(screen.getByRole('button', { name: 'Again' })).not.toHaveClass('bg-red-600')
      expect(screen.getByRole('button', { name: 'Good' })).not.toHaveClass('bg-emerald-600')
      expect(screen.getByRole('button', { name: 'Easy' })).not.toHaveClass('bg-blue-600')
    })

    it('Hard → Good に切替 (rate-then-confirm): Good に selected fill、 Hard は idle に戻る (highlight 即時反映 / rate click では fire しない)', async () => {
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
      // 即時反映 (Optimistic)
      expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('bg-orange-600')
      // Good に切替
      fireEvent.click(screen.getByRole('button', { name: 'Good' }))
      // Good に selected fill + Hard が idle に戻る (highlight 同期反映)
      expect(screen.getByRole('button', { name: 'Good' })).toHaveClass('bg-emerald-600')
      expect(screen.getByRole('button', { name: 'Good' })).toHaveClass('text-white')
      expect(screen.getByRole('button', { name: 'Hard' })).not.toHaveClass('bg-orange-600')
      expect(screen.getByRole('button', { name: 'Hard' })).not.toHaveClass('text-white')
      // 新仕様: rate 連打中は fire しない
      await new Promise((r) => setTimeout(r, 20))
      expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    })

    it('Optimistic (rate-then-confirm): rate click 直後に selected fill が反映 / fire trigger は 「次へ」 (server 完了待ちなし、 fire-and-forget)', async () => {
      // 新仕様: rate click では Dexie write しない (state-only)、 「次へ」 押下で
      // fire-and-forget submit。 server resolve を意図的に保留しても 「次へ」 同期で
      // 即 next card / finished に遷移することを検証 (Optimistic UI 必須条件)。
      let resolveSubmit: () => void = () => {}
      mockRecordAnswerEvent.mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            resolveSubmit = () => res()
          }),
      )
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))

      // click 前は idle
      expect(screen.getByRole('button', { name: 'Hard' })).not.toHaveClass('bg-orange-600')

      // rate click 直後: 即 selected fill (highlight Optimistic 反映)
      fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
      expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('bg-orange-600')
      expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('text-white')
      // 新仕様: rate click では fire しない
      expect(mockRecordAnswerEvent).not.toHaveBeenCalled()

      // 4 ボタン + 「次へ」 が pending で disable されないことを同時確認
      // (rate4 / nav3 から pending gate を撤回した spec)
      expect(screen.getByRole('button', { name: 'Again' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: 'Hard' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: 'Good' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: 'Easy' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()

      // 「次へ」 押下で fire (resolve 未だ): finished phase に同期遷移
      fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ card_id: 'c1', rating: 2 }),
      )

      // 後片付け (テスト終了時の unhandled promise 防止)
      resolveSubmit()
    })

    it('Optimistic (rate-then-confirm): rate 連打で highlight 即時切替 / fire は 「次へ」 で lastRating の 1 件のみ', async () => {
      // 新仕様: rate click では fire しない (state-only)、 「次へ」 押下で lastRating
      // 値 1 件のみ fire。 highlight は rate click 同期で即切替されることを検証。
      // 「次へ」 fire 時 server resolve を hold しても finished に同期遷移する
      // (fire-and-forget) ことも併せて確認。
      let resolveFlush: () => void = () => {}
      mockRecordAnswerEvent.mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            resolveFlush = () => res()
          }),
      )
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))

      // 1 回目 (Hard) click — rate click では fire しない、 highlight 即時反映
      fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
      expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('bg-orange-600')

      // 2 回目 (Good) click — 連打でも fire せず、 highlight は Good に切替
      fireEvent.click(screen.getByRole('button', { name: 'Good' }))
      expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Good' })).toHaveClass('bg-emerald-600')
      expect(screen.getByRole('button', { name: 'Hard' })).not.toHaveClass('bg-orange-600')

      // 「次へ」 押下 → lastRating (= Good = rating=3) で 1 件のみ fire、 finished へ
      fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
      expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1)
      expect(mockRecordAnswerEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ card_id: 'c1', rating: 3 }),
      )
      await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
      // tally は初回 rate click のみ +1 (連打を 1 カウント固定)
      expect(screen.getByText(/1 枚/)).toBeInTheDocument()
      // 後片付け
      resolveFlush()
    })

    it('Optimistic 通常モード: 「次へ」 click で server 待たず即 next card (fire-and-forget) + 成功時 error が次 card に出ない', async () => {
      // server resolve を hold した状態で「次へ」 を押下、 next card が即表示
      // されることを検証 (旧実装 = useTransition await goNext では server resolve
      // まで遷移しなかった)。 加えて成功 resolve 後に次 card 上に error が出ない
      // ことを assert する (= ok:true 経路で setError が誤発火しないことの guard、
      // 将来 refactor で意図せず alert 系を発火させた regression を捕捉する)。
      // S-cache-1: recordAnswerEvent を hold して同期 next 遷移を検証。
      let resolveSubmit: () => void = () => {}
      mockRecordAnswerEvent.mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            resolveSubmit = () => res()
          }),
      )
      const cards = [
        makeCard({ id: 'c1', questionText: '問1' }),
        makeCard({ id: 'c2', questionText: '問2' }),
      ]
      render(<SessionRunner cards={cards} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

      // 同期: 即 next card に遷移している (Dexie write 未だ resolve)
      expect(screen.getByText('問2')).toBeInTheDocument()
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(expect.objectContaining({ card_id: 'c1' }))

      // Dexie resolve 後 microtask 経過させて、 次 card 上に error が出ないことを
      // 確認 (success path で alert が誤発火しない defensive guard)。
      resolveSubmit()
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })
      // 次 card のまま (= 副作用で何かが起きていないことの再確認)
      expect(screen.getByText('問2')).toBeInTheDocument()
    })

    it('リトライで lastRating=null 化、 再 judged 時 4 ボタンとも idle (fill なし)', async () => {
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Easy' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Easy' })).toHaveClass('bg-blue-600'))
      // リトライ → selecting → 再回答 → judged
      fireEvent.click(screen.getByRole('button', { name: NAME_RETRY }))
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      // 4 ボタンとも idle (lastRating=null に reset 済)
      expect(screen.getByRole('button', { name: 'Easy' })).not.toHaveClass('bg-blue-600')
      expect(screen.getByRole('button', { name: 'Again' })).not.toHaveClass('bg-red-600')
    })
  })

  // ---------------------------------------------------------------------------
  // rating forwarding (S-cache-1 follow-up)
  // ---------------------------------------------------------------------------
  describe('rating forwarding to recordAnswerEvent', () => {
    it('通常モード correct: 「次へ」 で rating=3 が recordAnswerEvent に渡る', async () => {
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
      clickOption('選択肢B') // 正解
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
      await waitFor(() =>
        expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
          expect.objectContaining({ card_id: 'c1', is_correct: true, rating: 3 }),
        ),
      )
    })

    it('通常モード incorrect: 「次へ」 で rating=1 が recordAnswerEvent に渡る', async () => {
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
      clickOption('選択肢A') // 誤答
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
      await waitFor(() =>
        expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
          expect.objectContaining({ card_id: 'c1', is_correct: false, rating: 1 }),
        ),
      )
    })

    it('FSRS モード (rate-then-confirm): 4 rate それぞれの値 (1/2/3/4) が 「次へ」 で recordAnswerEvent に渡る', async () => {
      const cases: Array<{ button: string; rating: 1 | 2 | 3 | 4 }> = [
        { button: 'Again', rating: 1 },
        { button: 'Hard', rating: 2 },
        { button: 'Good', rating: 3 },
        { button: 'Easy', rating: 4 },
      ]
      for (const c of cases) {
        const { unmount } = render(
          <SessionRunner cards={[makeCard({ id: `c-${c.rating}` })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
        )
        clickOption('選択肢B') // 正解選択 (is_correct=true)
        fireEvent.click(screen.getByRole('button', { name: '回答する' }))
        fireEvent.click(screen.getByRole('button', { name: c.button }))
        // 新仕様: rate click では fire しない
        await new Promise((r) => setTimeout(r, 20))
        expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
        // 「次へ」 押下で rating が forwarding される
        fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
        await waitFor(() =>
          expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              card_id: `c-${c.rating}`,
              is_correct: true,
              rating: c.rating,
            }),
          ),
        )
        unmount()
        vi.clearAllMocks()
      }
    })
  })
})

// ---------------------------------------------------------------------------
// S-cache-3.1 (新仕様): 完了画面「ダッシュボードへ」 は flush を await せず即
// router.push('/app')。 finished useEffect が flush を fire-and-forget するのみ。
// NavState / warning UI / 保存中 label は撤去済。
// ---------------------------------------------------------------------------
describe('SessionRunner (完了画面ナビゲーション: flush 非同期化)', () => {
  // 完了画面に到達するまでの共通 step (1 card 正答 → 次へ → finished)。
  async function reachCompletion() {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    // 完了 flush が走り終わるまで待機
    await waitFor(() => expect(mockRunGuardedFlush).toHaveBeenCalled())
  }

  it('「ダッシュボードへ」 click で flush を await せず即 router.push("/app")', async () => {
    await reachCompletion()

    fireEvent.click(screen.getByRole('button', { name: 'ダッシュボードへ' }))

    // 同期的に push が呼ばれる (flush を await しない)
    expect(mockPush).toHaveBeenCalledWith('/app')
    expect(mockPush).toHaveBeenCalledTimes(1)
    // click handler 経由の追加 flush は発生しない
    const callsAfterClick = mockRunGuardedFlush.mock.calls.length
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRunGuardedFlush.mock.calls.length).toBe(callsAfterClick)
  })

  it('warning UI は存在しない (NavState 撤去後)', async () => {
    await reachCompletion()

    fireEvent.click(screen.getByRole('button', { name: 'ダッシュボードへ' }))

    // warning sub-text は描画されない
    expect(screen.queryByText(/後で.*再送/)).not.toBeInTheDocument()
  })

  it('flushing 中 disabled / "保存中..." label は存在しない (NavState 撤去後)', async () => {
    await reachCompletion()

    // ボタンは常に「ダッシュボードへ」 label で disabled でない
    const btn = screen.getByRole('button', { name: 'ダッシュボードへ' })
    expect(btn).not.toBeDisabled()
    // "保存中..." というラベルのボタンは存在しない
    expect(screen.queryByRole('button', { name: '保存中...' })).not.toBeInTheDocument()
  })

  it('finished phase の flush は owner-scope の userId で runGuardedAnswerEventFlush を 1 回呼ぶ', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())

    // 経路 2 (finished useEffect)。 経路 1 (threshold) は countPending=0 で不発のため
    // ここでの呼び出しは完了 flush 1 回だけ。
    await waitFor(() => expect(mockRunGuardedFlush).toHaveBeenCalledWith(TEST_USER_ID))
    expect(mockRunGuardedFlush).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// rate-then-confirm (Step 3b)
// spec §4.2: FSRS rate click は state-only、 Dexie write は 「次へ」 / 「前へ」
// 押下時に lastRating で 1 件 submit する新仕様の核心挙動 guard。 詳細 spec:
// docs/superpowers/specs/2026-05-27-rate-then-confirm-design.md
// ---------------------------------------------------------------------------
describe('rate-then-confirm (Step 3b)', () => {
  it('FSRS rate 連打 → 次へ で lastRating の 1 件のみ submit (Step 3b)', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B') // 正答 (is_correct=true)
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))

    // Hard → Good → Easy 連打 (state-only、 fire しない)
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    fireEvent.click(screen.getByRole('button', { name: 'Easy' }))
    // micro-task を進めても rate click では recordAnswerEvent fire しない
    await new Promise((r) => setTimeout(r, 30))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()

    // 「次へ」 enable まで待ち、 押下で lastRating (= Easy = 4) で 1 件のみ fire
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() =>
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ card_id: 'c1', is_correct: true, rating: 4 }),
      ),
    )
    expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1)
    // finished phase + tally 1 枚 / 1 正解
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    expect(screen.getByText(/1 枚/)).toBeInTheDocument()
    expect(screen.getByText(/1 正解/)).toBeInTheDocument()
  })

  it('FSRS rate → 前へ → 1 件 submit + 前 card 遷移 (Step 3b)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)

    // 問1 スキップ → 問2 へ (mockRecordAnswerEvent 呼ばれない、 idx=1)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()

    // 問2 で 選択肢B → 「回答する」 → Good rate (state-only)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    // rate click 単独では fire しない
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()

    // 「前へ」 enable まで待ち、 押下で rating=3 で 1 件 fire + 問1 へ遷移 + selecting reset
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_PREV })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: NAME_PREV }))
    await waitFor(() => expect(screen.getByText('問1')).toBeInTheDocument())
    await waitFor(() =>
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ card_id: 'c2', rating: 3 }),
      ),
    )
    expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1)
    // 選択肢 reset: 全 opt aria-pressed=false / 「回答する」 は常時 enable のまま
    const opts = screen.getAllByRole('button', { name: /選択肢/ })
    opts.forEach((o) => expect(o).toHaveAttribute('aria-pressed', 'false'))
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
  })

  it('FSRS 前へで戻った card で再回答 → 次へ で追加 1 件 (Step 3b)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)

    // 問1: 選択肢B → 回答 → Good → 次へ (submit 1: c1 rating=3)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    // 新仕様: rate click 単独では fire しない (中間 guard)
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1))
    expect(mockRecordAnswerEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ card_id: 'c1', rating: 3 }),
    )

    // 問2: 選択肢B → 回答 → Good → 前へ (submit 2: c2 rating=3 + 問1 戻り)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_PREV })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: NAME_PREV }))
    await waitFor(() => expect(screen.getByText('問1')).toBeInTheDocument())
    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(2))
    expect(mockRecordAnswerEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ card_id: 'c2', rating: 3 }),
    )
    // 問1 戻り時 selecting reset を確認
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()

    // 問1 再回答: 選択肢A (誤答) → 回答 → Hard → 次へ (submit 3: c1 rating=2 上書き)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(3))
    expect(mockRecordAnswerEvent).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ card_id: 'c1', rating: 2 }),
    )

    // 問2 再表示 (selecting reset): 選択肢B → 回答 → Good → 次へ (submit 4: c2 rating=3)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(4))
    expect(mockRecordAnswerEvent).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ card_id: 'c2', rating: 3 }),
    )

    // tally: 2 枚 (submittedCardIds.size = 2)。 correct は初回 rate 時の
    // correctSnapshot 固定 (c1 初回=true / c2 初回=true) で 2 になる (上書きせず順次 apply)
    expect(screen.getByText(/2 枚/)).toBeInTheDocument()
  })

  it('FSRS リトライ → submit 呼ばれない regression guard (Step 3b)', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    // rate click では fire しない
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()

    // 「リトライ」 → selecting reset (submit fire しない)
    fireEvent.click(screen.getByRole('button', { name: NAME_RETRY }))
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRecordAnswerEvent).not.toHaveBeenCalled()
    // selecting phase 復帰: 「回答する」 表示 (選択 reset、 常時 enable) / 解説 + Again button 非表示
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
    expect(screen.queryByText('カード全体の解説')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Again' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// flush の 2 入口 (threshold / セッション完了) — FSRS 整合 Sprint A T5
// どちらも runGuardedAnswerEventFlush (Web Locks 経由) を owner-scope の userId で呼ぶ。
// 'ok' のときだけ pull-back で FSRS 後の値を mirror へ戻す。
// 入口を分離して検証するため、 threshold 側は 2 枚構成 (finished に到達させない)、
// 完了側は countPending=0 (threshold を発火させない) で駆動する。
// ---------------------------------------------------------------------------

// 1 card 正答 → 次へ → finished まで共通駆動。
async function reachFinished() {
  render(<SessionRunner cards={[makeCard()]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
  clickOption('選択肢B')
  fireEvent.click(screen.getByRole('button', { name: '回答する' }))
  fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
  await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
}

// 2 枚構成で 1 枚目だけ確定する (finished 未到達 = 完了 flush と混ざらない)。
async function answerFirstOfTwo() {
  render(
    <SessionRunner
      cards={[makeCard({ id: 'c1', questionText: '問1' }), makeCard({ id: 'c2', questionText: '問2' })]}
      fsrsMode={false}
      userId={TEST_USER_ID}
      sessionId={TEST_SESSION_ID}
    />,
  )
  clickOption('選択肢B')
  fireEvent.click(screen.getByRole('button', { name: '回答する' }))
  fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
  await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
}

describe('threshold flush', () => {
  it('pending が閾値 (5) に達したら owner-scope の userId で flush する', async () => {
    mockCountPendingAnswerEvents.mockResolvedValue(5)
    mockRunGuardedFlush.mockResolvedValue('ok')

    await answerFirstOfTwo()

    await waitFor(() => expect(mockRunGuardedFlush).toHaveBeenCalledWith(TEST_USER_ID))
    expect(mockRunGuardedFlush).toHaveBeenCalledTimes(1)
    // pending 件数の集計も owner-scope
    expect(mockCountPendingAnswerEvents).toHaveBeenCalledWith(TEST_USER_ID)
  })

  it('閾値未満 (4) では flush しない', async () => {
    mockCountPendingAnswerEvents.mockResolvedValue(4)

    await answerFirstOfTwo()

    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRunGuardedFlush).not.toHaveBeenCalled()
  })

  it('flush ok → pullBack("threshold-flush")', async () => {
    mockCountPendingAnswerEvents.mockResolvedValue(5)
    mockRunGuardedFlush.mockResolvedValue('ok')

    await answerFirstOfTwo()

    await waitFor(() => expect(mockPullBack).toHaveBeenCalledWith('threshold-flush'))
    expect(mockPullBack).toHaveBeenCalledTimes(1)
  })

  it('flush が ok 以外 (lock-busy) → pull-back なし', async () => {
    mockCountPendingAnswerEvents.mockResolvedValue(5)
    mockRunGuardedFlush.mockResolvedValue('lock-busy')

    await answerFirstOfTwo()

    await waitFor(() => expect(mockRunGuardedFlush).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(mockPullBack).not.toHaveBeenCalled()
  })
})

describe('セッション完了 flush', () => {
  it('完了 flush ok → pullBack("session-complete") が 1 回呼ばれる', async () => {
    mockRunGuardedFlush.mockResolvedValue('ok')

    await reachFinished()

    await waitFor(() => expect(mockPullBack).toHaveBeenCalledWith('session-complete'))
    expect(mockPullBack).toHaveBeenCalledTimes(1)
  })

  it('完了 flush 非 ok (transient) → pull-back なし', async () => {
    mockRunGuardedFlush.mockResolvedValue('transient')

    await reachFinished()

    await waitFor(() => expect(mockRunGuardedFlush).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(mockPullBack).not.toHaveBeenCalled()
  })

  it('完了 flush throw → pull-back なし (catch 内で握り潰される)', async () => {
    mockRunGuardedFlush.mockRejectedValue(new Error('net'))

    await reachFinished()

    await waitFor(() => expect(mockRunGuardedFlush).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(mockPullBack).not.toHaveBeenCalled()
  })

  it('完了 flush no-pending → pull-back なし', async () => {
    mockRunGuardedFlush.mockResolvedValue('no-pending')

    await reachFinished()

    await waitFor(() => expect(mockRunGuardedFlush).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(mockPullBack).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// answer_events の payload (owner-scope + elapsed_ms 計測) — spec §4.5 / §4.6
// ---------------------------------------------------------------------------
describe('recordAnswerEvent payload', () => {
  it('user_id / session_id / rating を載せる', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    await waitFor(() =>
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: TEST_USER_ID,
          session_id: TEST_SESSION_ID,
          card_id: 'c1',
          rating: 3,
        }),
      ),
    )
  })

  it('表示開始 → submit の wall-clock を elapsed_ms として載せる', async () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    nowSpy.mockReturnValue(3_500)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    await waitFor(() =>
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ elapsed_ms: 2_500 }),
      ),
    )
    nowSpy.mockRestore()
  })

  it('card 遷移で計測を打ち直す (前 card の表示時間を繰り越さない)', async () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    render(
      <SessionRunner
        cards={[makeCard({ id: 'c1', questionText: '問1' }), makeCard({ id: 'c2', questionText: '問2' })]}
        fsrsMode={false}
        userId={TEST_USER_ID}
        sessionId={TEST_SESSION_ID}
      />,
    )
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    nowSpy.mockReturnValue(2_000)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT })) // c1: 1000ms、c2 の計測開始
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())

    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    nowSpy.mockReturnValue(2_600)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(2))
    expect(mockRecordAnswerEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ card_id: 'c1', elapsed_ms: 1_000 }),
    )
    expect(mockRecordAnswerEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ card_id: 'c2', elapsed_ms: 600 }),
    )
    nowSpy.mockRestore()
  })

  it('24h 超は 86_400_000 に clip する (wire schema 上限)', async () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0)
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    nowSpy.mockReturnValue(90_000_000)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    await waitFor(() =>
      expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ elapsed_ms: 86_400_000 }),
      ),
    )
    nowSpy.mockRestore()
  })

  it('FSRS の rate 連打は 1 計測 = 1 event (最終 confirm までを測る)', async () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    nowSpy.mockReturnValue(5_000)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    await waitFor(() => expect(mockRecordAnswerEvent).toHaveBeenCalledTimes(1))
    expect(mockRecordAnswerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ rating: 3, elapsed_ms: 4_000 }),
    )
    nowSpy.mockRestore()
  })
})

// -----------------------------------------------------------------------
// 画像フェーズ A Task 11: 学習ビュー read-only gallery (問題文下)
// -----------------------------------------------------------------------
describe('SessionRunner (T11: read-only image gallery)', () => {
  const UUID_IMAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  it('images に question_text target の UUID entry あり → thumbnail が render され、 attach input / delete button は出ない (readOnly)', async () => {
    const card = makeCard({
      id: 'c1',
      userId: 'user-with-image',
      images: [{ key: UUID_IMAGE, target: 'question_text', alt: '' }],
    })
    const { container } = render(
      <SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
    )

    await waitFor(() => {
      expect(container.querySelectorAll('img')).toHaveLength(1)
    })
    expect(mockGetAssetObjectURL).toHaveBeenCalledWith(
      'user-with-image',
      UUID_IMAGE,
      expect.objectContaining({ resolveAssetUrls: mockResolveAssetUrls }),
    )
    // readOnly: 添付 input / 削除 button なし
    expect(container.querySelector('input[type="file"]')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '画像を追加' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '画像を削除' })).not.toBeInTheDocument()
  })

  it('images が空配列 → thumbnail も添付 control も render されない', () => {
    const card = makeCard({ id: 'c1', images: [] })
    const { container } = render(
      <SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
    )
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.querySelector('input[type="file"]')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '画像を追加' })).not.toBeInTheDocument()
    expect(mockGetAssetObjectURL).not.toHaveBeenCalled()
  })

  // Sprint I W4: 学習面 read-only を option / explanation にも拡張(memo は学習非表示ゆえ除外)。
  const OPT_A_UID = 'a0000000-0000-4000-8000-00000000000a'

  it('W4: option:<uid> の画像 → 選択肢下に read-only thumbnail(選択フェーズから表示・attach/delete なし)', async () => {
    const OPT_IMG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const card = makeCard({
      id: 'c1',
      userId: 'user-opt-img',
      options: [
        { id: 'a', uid: OPT_A_UID, text: '選択肢A', is_correct: false },
        { id: 'b', uid: 'b0000000-0000-4000-8000-00000000000b', text: '選択肢B', is_correct: true },
      ],
      images: [{ key: OPT_IMG, target: `option:${OPT_A_UID}`, alt: '' }],
    })
    const { container } = render(
      <SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
    )
    await waitFor(() => {
      expect(container.querySelectorAll('img')).toHaveLength(1)
    })
    expect(mockGetAssetObjectURL).toHaveBeenCalledWith(
      'user-opt-img',
      OPT_IMG,
      expect.objectContaining({ resolveAssetUrls: mockResolveAssetUrls }),
    )
    expect(container.querySelector('input[type="file"]')).not.toBeInTheDocument()
  })

  it('W4: explanation_text の画像 → 判定後に解説節に read-only thumbnail', async () => {
    const EXP_IMG = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const card = makeCard({
      id: 'c1',
      userId: 'user-exp-img',
      explanationText: 'カード解説',
      images: [{ key: EXP_IMG, target: 'explanation_text', alt: '' }],
    })
    const { container } = render(
      <SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
    )
    // 判定前は解説節なし
    expect(container.querySelectorAll('img')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /選択肢B/ }))
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    await waitFor(() => {
      expect(container.querySelectorAll('img')).toHaveLength(1)
    })
  })

  it('W4: explanationText 無し + explanation 画像あり → 判定後に解説節が表示(画像だけで節が出る)', async () => {
    const EXP_IMG = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const card = makeCard({
      id: 'c1',
      userId: 'u',
      explanationText: null,
      images: [{ key: EXP_IMG, target: 'explanation_text', alt: '' }],
    })
    const { container } = render(
      <SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /選択肢B/ }))
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    await waitFor(() => {
      expect(screen.getByText('解説')).toBeInTheDocument()
    })
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })
})

// Sprint T T5: 学習面 C(問題文)/ D(選択肢 text・解説)/ E(カード解説)の MD 表 read-only
// 描画。golden-first(修正2)= 差し替え前に表 0 個 DOM を snapshot(旧 DOM から生成)→
// 差し替え後も diff なし green で不変条件①(表 0 個 = DOM 同一)を機械証明。C/E は表を含む時
// のみ <p>→<div>(p>table の hydration 破壊回避)。表 0 個は <p> 維持で DOM 同一。
describe('Sprint T: MD 表 read-only 描画(学習面 C/D/E)', () => {
  const QF = '問題文\n2 行目 < & > 記号' // table-free question
  const QT = 'まえ\n\n| 成分 | 分量 |\n|---|---|\n| A | 1 |' // table question
  const EF = 'カード全体の解説' // table-free explanation (makeCard default)
  const ET = '解説まえ\n\n| 項目 | 値 |\n|---|---|\n| X | 9 |' // table explanation

  const renderRunner = (card: Partial<Card>) =>
    render(
      <SessionRunner
        cards={[makeCard(card)]}
        fsrsMode={false}
        userId={TEST_USER_ID} sessionId={TEST_SESSION_ID}
      />,
    )

  // --- C: 問題文(selecting phase・常時可視) ---
  it('C 問題文 表 0 個: 問題文ブロック DOM 不変(golden・不変条件①)', () => {
    const { container } = renderRunner({ questionText: QF })
    expect(container.querySelector('.bg-slate-50')!.innerHTML).toMatchSnapshot()
  })
  it('C 問題文 表入り: 問題文ブロック DOM(golden — 差し替え後 <div>+<table>)', () => {
    const { container } = renderRunner({ questionText: QT })
    expect(container.querySelector('.bg-slate-50')!.innerHTML).toMatchSnapshot()
  })
  it('C 問題文 表入り: <table> 描画(差し替え後 PASS・前は RED)', () => {
    const { container } = renderRunner({ questionText: QT })
    expect(container.querySelector('.bg-slate-50')!.querySelector('table')).not.toBeNull()
  })

  // --- D: 選択肢本文(selecting)+ 選択肢解説(judged) ---
  it('D 選択肢本文 表 0 個: options DOM 不変(golden・不変条件①)', () => {
    const { container } = renderRunner({})
    expect(container.querySelector('ul.space-y-2')!.innerHTML).toMatchSnapshot()
  })
  it('D 選択肢本文 表入り: <table> 描画(差し替え後 PASS・前は RED)', () => {
    const { container } = renderRunner({
      options: [{ id: 'a', text: '選択肢\n\n| x | y |\n|---|---|\n| 1 | 2 |', is_correct: true }],
      correctAnswerIds: ['a'],
    })
    expect(container.querySelector('ul.space-y-2')!.querySelector('table')).not.toBeNull()
  })
  it('D 選択肢解説 表入り: judged で <table> 描画(差し替え後 PASS・前は RED)', () => {
    const { container } = renderRunner({
      options: [{ id: 'a', text: '選A', is_correct: true, explanation: '解説\n\n| p | q |\n|---|---|\n| 3 | 4 |' }],
      correctAnswerIds: ['a'],
    })
    clickOption('選A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(container.querySelector('ul.space-y-2')!.querySelector('table')).not.toBeNull()
  })
  it('D 選択肢解説 表 0 個: judged options DOM を pin(不変条件① explanation・whole-branch Minor#2)', () => {
    // 選択肢解説は judged phase でのみ描画される。selecting phase の golden では覆えない
    // explanation 補間点(解説: <MdTableText>)の表 0 個 DOM を judged で pin する。
    const { container } = renderRunner({}) // 既定 option b が explanation='選択肢B解説'(表なし)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(container.querySelector('ul.space-y-2')!.innerHTML).toMatchSnapshot()
  })

  // --- E: カード解説(judged) ---
  it('E カード解説 表 0 個: 解説ブロック DOM 不変(golden・不変条件①)', () => {
    const { container } = renderRunner({ explanationText: EF })
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(container.querySelector('.bg-blue-50')!.innerHTML).toMatchSnapshot()
  })
  it('E カード解説 表入り: 解説ブロック DOM(golden — 差し替え後 <div>+<table>)', () => {
    const { container } = renderRunner({ explanationText: ET })
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(container.querySelector('.bg-blue-50')!.innerHTML).toMatchSnapshot()
  })
  it('E カード解説 表入り: <table> 描画(差し替え後 PASS・前は RED)', () => {
    const { container } = renderRunner({ explanationText: ET })
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(container.querySelector('.bg-blue-50')!.querySelector('table')).not.toBeNull()
  })

  // --- 回答フロー回帰 + DOM nesting warning なし(修正2 Step5) ---
  it('表入りカードでも判定フローが動作し console.error(nesting warning)が出ない', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderRunner({
      questionText: QT,
      explanationText: ET,
      options: [{ id: 'a', text: '選A', is_correct: true, explanation: '解説\n\n| p | q |\n|---|---|\n| 3 | 4 |' }],
      correctAnswerIds: ['a'],
    })
    clickOption('選A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // 判定 banner が出る(フロー健全)
    expect(screen.getByText(/正解/)).toBeInTheDocument()
    // validateDOMNesting 等の React warning が出ていない
    const nestingWarn = spy.mock.calls.find((c) =>
      String(c[0]).includes('validateDOMNesting') || String(c[0]).includes('cannot be a descendant') || String(c[0]).includes('cannot appear as'),
    )
    expect(nestingWarn).toBeUndefined()
    spy.mockRestore()
  })
})

// Sprint T(選択保持 fix): 回答後も「自分が選んだ選択肢」を識別できる(正誤=背景 /
// 選択=独立チャネル「あなたの回答」badge の 2 軸)。多択でも選び逃し / 選んだ誤答を区別。
describe('Sprint T: 回答後の選択保持(2 軸表示)', () => {
  // 各選択肢 button 内に「あなたの回答」badge があるかを opt.text で scope して判定。
  const hasYourAnswer = (optText: string): boolean => {
    const btn = screen.getByRole('button', { name: new RegExp(optText) })
    return within(btn).queryByText('あなたの回答') !== null
  }
  const judge = () => fireEvent.click(screen.getByRole('button', { name: '回答する' }))

  it('単択: 誤答を選んだ後、選んだ誤答と選ばなかった誤答が識別できる', () => {
    render(
      <SessionRunner
        cards={[
          makeCard({
            options: [
              { id: 'a', text: 'アルファ誤', is_correct: false },
              { id: 'b', text: 'ベータ正', is_correct: true },
              { id: 'c', text: 'ガンマ誤', is_correct: false },
            ],
            correctAnswerIds: ['b'],
          }),
        ]}
        fsrsMode={false}
        userId={TEST_USER_ID} sessionId={TEST_SESSION_ID}
      />,
    )
    clickOption('アルファ誤')
    judge()
    expect(hasYourAnswer('アルファ誤')).toBe(true) // 選んだ誤答
    expect(hasYourAnswer('ガンマ誤')).toBe(false) // 選ばなかった誤答
    expect(hasYourAnswer('ベータ正')).toBe(false) // 選ばなかった正答
  })

  it('単択: 正答を選んだ後、「正解であり自分の選択」と分かる(緑背景 + badge 併存)', () => {
    render(
      <SessionRunner
        cards={[
          makeCard({
            options: [
              { id: 'a', text: 'アルファ誤', is_correct: false },
              { id: 'b', text: 'ベータ正', is_correct: true },
            ],
            correctAnswerIds: ['b'],
          }),
        ]}
        fsrsMode={false}
        userId={TEST_USER_ID} sessionId={TEST_SESSION_ID}
      />,
    )
    clickOption('ベータ正')
    judge()
    const btn = screen.getByRole('button', { name: /ベータ正/ })
    expect(within(btn).queryByText('あなたの回答')).not.toBeNull() // 自分の選択
    expect(btn.className).toContain('bg-emerald-100') // 正解の背景(独立軸)
  })

  it('多択: 「選んだ正解」と「選び逃した正解」が区別できる', () => {
    render(
      <SessionRunner
        cards={[
          makeCard({
            options: [
              { id: 'a', text: 'アルファ正', is_correct: true },
              { id: 'b', text: 'ベータ正', is_correct: true },
              { id: 'c', text: 'ガンマ誤', is_correct: false },
            ],
            correctAnswerIds: ['a', 'b'],
          }),
        ]}
        fsrsMode={false}
        userId={TEST_USER_ID} sessionId={TEST_SESSION_ID}
      />,
    )
    clickOption('アルファ正') // 正解を 1 つだけ選ぶ(b は選び逃し)
    judge()
    expect(hasYourAnswer('アルファ正')).toBe(true) // 選んだ正解
    expect(hasYourAnswer('ベータ正')).toBe(false) // 選び逃した正解(緑だが未選択)
    // 両方とも正解の緑背景ではあること(正誤軸は独立)
    expect(screen.getByRole('button', { name: /アルファ正/ }).className).toContain('bg-emerald-100')
    expect(screen.getByRole('button', { name: /ベータ正/ }).className).toContain('bg-emerald-100')
  })

  it('多択: 「選んだ誤答」と「選ばなかった誤答」が区別できる', () => {
    render(
      <SessionRunner
        cards={[
          makeCard({
            options: [
              { id: 'a', text: 'アルファ誤', is_correct: false },
              { id: 'b', text: 'ベータ誤', is_correct: false },
              { id: 'c', text: 'ガンマ正', is_correct: true },
            ],
            correctAnswerIds: ['c'],
          }),
        ]}
        fsrsMode={false}
        userId={TEST_USER_ID} sessionId={TEST_SESSION_ID}
      />,
    )
    clickOption('アルファ誤')
    judge()
    expect(hasYourAnswer('アルファ誤')).toBe(true) // 選んだ誤答
    expect(hasYourAnswer('ベータ誤')).toBe(false) // 選ばなかった誤答
  })

  it('回答前(selecting)も選択チャネル(sky ring)が出る(判定前後で一貫・canonical Minor#1)', () => {
    render(
      <SessionRunner
        cards={[
          makeCard({
            options: [
              { id: 'a', text: 'アルファ誤', is_correct: false },
              { id: 'b', text: 'ベータ正', is_correct: true },
            ],
            correctAnswerIds: ['b'],
          }),
        ]}
        fsrsMode={false}
        userId={TEST_USER_ID} sessionId={TEST_SESSION_ID}
      />,
    )
    clickOption('アルファ誤') // 判定前に選択
    const btn = screen.getByRole('button', { name: /アルファ誤/ })
    expect(btn.className).toContain('ring-sky-500') // selecting phase でも ring あり
    // 未選択は ring なし
    expect(screen.getByRole('button', { name: /ベータ正/ }).className).not.toContain('ring-sky-500')
  })

  it('リトライ後に選択表示(badge)がリセットされる', () => {
    render(
      <SessionRunner
        cards={[
          makeCard({
            options: [
              { id: 'a', text: 'アルファ誤', is_correct: false },
              { id: 'b', text: 'ベータ正', is_correct: true },
            ],
            correctAnswerIds: ['b'],
          }),
        ]}
        fsrsMode={false}
        userId={TEST_USER_ID} sessionId={TEST_SESSION_ID}
      />,
    )
    clickOption('アルファ誤')
    judge()
    expect(hasYourAnswer('アルファ誤')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: NAME_RETRY }))
    // selecting へ戻り selectedIds クリア → badge 消滅
    expect(screen.queryByText('あなたの回答')).toBeNull()
  })
})

// Sprint T(メモ学習面表示): 回答後のみ・非空時のみ・MdTableText 経由・read-only・
// 解説(公式)と視覚的に区別(amber の別スタイル島)。
describe('Sprint T: 学習面のメモ表示', () => {
  const MEMO_LABEL = 'メモ(あなたの記録)'
  const judge = () => fireEvent.click(screen.getByRole('button', { name: '回答する' }))
  const renderCard = (memo: string | null) =>
    render(
      <SessionRunner cards={[makeCard({ memo })]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
    )

  it('回答前はメモが DOM に存在しない', () => {
    renderCard('ユーザーのメモ本文')
    expect(screen.queryByText(MEMO_LABEL)).toBeNull()
    expect(screen.queryByText('ユーザーのメモ本文')).toBeNull()
  })

  it('回答後、メモがある card でメモが表示される(read-only)', () => {
    renderCard('ユーザーのメモ本文')
    clickOption('選択肢B')
    judge()
    expect(screen.getByText(MEMO_LABEL)).toBeInTheDocument()
    expect(screen.getByText('ユーザーのメモ本文')).toBeInTheDocument()
    // read-only: メモ編集の textarea / 追加 UI は無い
    expect(screen.queryByRole('textbox', { name: /メモ/ })).toBeNull()
  })

  it('メモが空の card ではメモ関連 DOM が増分ゼロ', () => {
    const { container } = renderCard('')
    clickOption('選択肢B')
    judge()
    expect(screen.queryByText(MEMO_LABEL)).toBeNull()
    // amber island 自体が DOM に無いことを直接確認(canonical Minor#3)。
    expect(container.querySelector('.border-amber-200')).toBeNull()
  })

  it('メモは card 遷移で持ち越さない(card1 判定後メモ → 次へ → card2 pre-answer でメモなし)', () => {
    render(
      <SessionRunner
        cards={[
          makeCard({ id: 'card-mm-1', memo: 'カード1のメモ' }),
          makeCard({ id: 'card-mm-2', memo: 'カード2のメモ' }),
        ]}
        fsrsMode={false}
        userId={TEST_USER_ID} sessionId={TEST_SESSION_ID}
      />,
    )
    clickOption('選択肢B')
    judge()
    expect(screen.getByText('カード1のメモ')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    // card2 は pre-answer(selecting)→ どちらのメモも出ない(持ち越し・pre-answer 露出なし)。
    expect(screen.queryByText('カード1のメモ')).toBeNull()
    expect(screen.queryByText('カード2のメモ')).toBeNull()
  })

  it('メモに MD 表が入っていれば <table> 描画される', () => {
    renderCard('メモ前置き\n\n| 覚え方 | 内容 |\n|---|---|\n| A | 1 |')
    clickOption('選択肢B')
    judge()
    const block = screen.getByText(MEMO_LABEL).closest('div') as HTMLElement
    expect(block.querySelector('table')).not.toBeNull()
    expect(block.textContent).toContain('メモ前置き')
  })

  it('解説とメモは別スタイル島(出自の区別)= 両方あれば別 block', () => {
    render(
      <SessionRunner
        cards={[makeCard({ explanationText: '公式解説テキスト', memo: 'ユーザーメモテキスト' })]}
        fsrsMode={false}
        userId={TEST_USER_ID} sessionId={TEST_SESSION_ID}
      />,
    )
    clickOption('選択肢B')
    judge()
    const explBlock = screen.getByText('解説').closest('div') as HTMLElement
    const memoBlock = screen.getByText(MEMO_LABEL).closest('div') as HTMLElement
    expect(explBlock).not.toBe(memoBlock) // 別 block(混同しない)
    expect(explBlock.textContent).toContain('公式解説テキスト')
    expect(explBlock.textContent).not.toContain('ユーザーメモテキスト')
    expect(memoBlock.textContent).toContain('ユーザーメモテキスト')
  })
})

// -----------------------------------------------------------------------
// Task 5: 演習 in-flow 画像を大きめ表示(display='inflow')。3 slot(問題文 / 選択肢 /
// 解説)が inflow で描画される(64px サムネ = h-16 ではない)。メモ画像は非描画不変(spec §7)。
// getClientDb().media_assets.get は上部 mock で undefined を返す = mirror dims 無し →
// fold=false(全高)で描画。ここでは「inflow face(full-width)で描かれる」ことを pin する。
// -----------------------------------------------------------------------
describe('SessionRunner (Task 5: in-flow 画像 display=inflow)', () => {
  const IMG_Q = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const OPT_A_UID = 'a0000000-0000-4000-8000-00000000000a'
  const IMG_OPT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const IMG_EXP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const IMG_MEMO = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

  it('問題文画像は inflow(full-width)で描画され、64px サムネ(h-16)ではない', async () => {
    const card = makeCard({
      id: 'c1',
      userId: 'u',
      images: [{ key: IMG_Q, target: 'question_text', alt: '' }],
    })
    const { container } = render(
      <SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
    )
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1))
    const img = container.querySelector('img')!
    expect(img.className).toContain('w-full')
    expect(img.className).not.toContain('h-16')
  })

  it('選択肢画像(option:<uid>)も inflow(full-width)で描画される(h-16 でない)', async () => {
    const card = makeCard({
      id: 'c1',
      userId: 'u',
      options: [
        { id: 'a', uid: OPT_A_UID, text: '選択肢A', is_correct: false },
        { id: 'b', uid: 'b0000000-0000-4000-8000-00000000000b', text: '選択肢B', is_correct: true },
      ],
      images: [{ key: IMG_OPT, target: `option:${OPT_A_UID}`, alt: '' }],
    })
    const { container } = render(
      <SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
    )
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1))
    const img = container.querySelector('img')!
    expect(img.className).toContain('w-full')
    expect(img.className).not.toContain('h-16')
  })

  it('解説画像(explanation_text)も判定後 inflow(full-width)で描画される(h-16 でない)', async () => {
    const card = makeCard({
      id: 'c1',
      userId: 'u',
      explanationText: 'カード解説',
      images: [{ key: IMG_EXP, target: 'explanation_text', alt: '' }],
    })
    const { container } = render(
      <SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /選択肢B/ }))
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1))
    const img = container.querySelector('img')!
    expect(img.className).toContain('w-full')
    expect(img.className).not.toContain('h-16')
  })

  it('メモに画像 target があっても学習面ではメモ画像は描画されない(memo 島は非配線・spec §7)', () => {
    const card = makeCard({
      id: 'c1',
      userId: 'u',
      memo: 'メモ本文',
      images: [{ key: IMG_MEMO, target: 'memo', alt: '' }],
    })
    const { container } = render(
      <SessionRunner cards={[card]} fsrsMode={false} userId={TEST_USER_ID} sessionId={TEST_SESSION_ID} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /選択肢B/ }))
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // メモ島は表示されるが gallery は配線されていない = memo target の画像は描画されない
    expect(screen.getByText('メモ本文')).toBeInTheDocument()
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(mockGetAssetObjectURL).not.toHaveBeenCalled()
  })
})
