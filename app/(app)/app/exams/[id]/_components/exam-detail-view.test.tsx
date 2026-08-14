// @vitest-environment jsdom
// ExamDetailView の unit test (Grid-1 T4)。
// - 5 case: saved prefs なし → default 'card' / saved 'table' → useEffect 後 'table' /
//   saved 不正値 → 'card' fallback / toggle click → setJsonSyncMeta が呼ばれる /
//   view 別 render (InlineCardList stub / ExamCardTable stub)。
// - InlineCardList は vi.mock で軽量 stub に差し替え (useLiveQuery 依存の肥大化を回避。
//   本 test は ExamDetailView の責務を検証するため stub mock が妥当)。
// - ExamCardTable も vi.mock で軽量 stub に差し替え (同方針)。
// - setJsonSyncMeta は vi.mock で部分 mock + spy (ESM named export の spy 確実化)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { getClientDb } from '@/lib/client-db'
import {
  SYNC_META_KEYS,
  examViewPrefsSchema,
  examViewPrefsV1Schema,
  examViewPrefsV2Schema,
  examViewPrefsV3Schema,
  examViewPrefsToV3,
  getJsonSyncMeta,
  setJsonSyncMeta as realSetJsonSyncMeta,
} from '@/lib/sync/sync-meta'

// ---------------------------------------------------------------------------
// モック: InlineCardList — 軽量 stub で useLiveQuery 依存を回避
// ---------------------------------------------------------------------------

vi.mock('./inline-card-list', () => ({
  InlineCardList: ({ examId }: { examId: string }) => (
    <div data-testid="inline-card-list-stub">inline-card-list-{examId}</div>
  ),
}))

// ---------------------------------------------------------------------------
// モック: ExamCardTable — 軽量 stub で TanStack / useLiveQuery 依存を回避
// ---------------------------------------------------------------------------

// S2-5: stub は columnVisibility prop を data 属性で露出し、 detail-view → table の
// controlled prop 配線 (mount-load / toggle 反映) を検証可能にする。
// S2b-1: stub は onCollapsedChange prop をボタン経由で呼び出せるよう露出する
// (scroll 伝播・chrome collapse の結合 test 用)。
// S5-2: stub は columnPinning prop を data 属性で露出し、 pinning 配線を検証可能にする。
//        stub-trigger-pin ボタンで onColumnPinningChange を注入できる (c-3 非 null path 用)。
vi.mock('./exam-card-table', () => ({
  ExamCardTable: ({
    examId,
    columnVisibility,
    columnPinning,
    onCollapsedChange,
    onColumnPinningChange,
  }: {
    examId: string
    columnVisibility?: unknown
    columnPinning?: unknown
    onCollapsedChange?: (collapsed: boolean) => void
    onColumnPinningChange?: (pinning: { left: string[]; right: string[] }) => void
  }) => (
    <div
      data-testid="exam-card-table-stub"
      data-colvis={JSON.stringify(columnVisibility ?? null)}
      data-pinning={JSON.stringify(columnPinning ?? null)}
    >
      {/* S2b-1: collapse/expand を test から注入するトリガーボタン */}
      <button
        data-testid="stub-trigger-collapse"
        onClick={() => onCollapsedChange?.(true)}
      />
      <button
        data-testid="stub-trigger-expand"
        onClick={() => onCollapsedChange?.(false)}
      />
      {/* S5-2: pinning 変更を test から注入するトリガーボタン (c-3 非 null path 用) */}
      <button
        data-testid="stub-trigger-pin"
        onClick={() => onColumnPinningChange?.({ left: ['select', 'title'], right: [] })}
      />
      exam-card-table-{examId}
    </div>
  ),
}))

// ---------------------------------------------------------------------------
// モック: sync-meta — setJsonSyncMeta を spy しつつ実装は通す (部分 mock)
// vi.hoisted で mockSetJsonSyncMeta を巻き上げ、vi.mock ファクトリより前に宣言。
// モジュール解決後に actual 実装を impl として注入することで infinite recursion を回避。
// ---------------------------------------------------------------------------

const { mockSetJsonSyncMeta, mockGetJsonSyncMeta } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSetJsonSyncMeta: vi.fn<any>(),
  // getJsonSyncMeta も spy 化 (既定は actual)。 load-race 回帰 test は
  // mockImplementationOnce で deferred promise に差し替え pre-load toggle を再現する。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockGetJsonSyncMeta: vi.fn<any>(),
}))

vi.mock('@/lib/sync/sync-meta', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/sync/sync-meta')>()
  // impl を actual に向けることで, spy は actual を通してから Dexie に書く
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSetJsonSyncMeta.mockImplementation(actual.setJsonSyncMeta as any)
  // 既定 impl は actual (既存 case は素通し)。 clearAllMocks は impl を保持する。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockGetJsonSyncMeta.mockImplementation(actual.getJsonSyncMeta as any)
  return {
    ...actual,
    setJsonSyncMeta: mockSetJsonSyncMeta,
    getJsonSyncMeta: mockGetJsonSyncMeta,
  }
})

import { ExamDetailView } from './exam-detail-view'

// ---------------------------------------------------------------------------
// 共通 fixtures
// ---------------------------------------------------------------------------

const defaultProps = {
  initialCards: [],
  examId: 'exam-1',
  userId: 'user-1',
  // S2-1 fix: hydration mismatch 解消 — server preformat 済み文字列を渡す。
  examName: 'テスト試験',
  createdLabel: '1ヶ月前',
  updatedLabel: '2日前',
}

beforeEach(async () => {
  vi.clearAllMocks()
  const db = getClientDb()
  await db.sync_meta.clear()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// Case ①: saved prefs なし → default 'card'
// ===========================================================================

describe('ExamDetailView — Case ①: saved prefs なし → default card', () => {
  it('sync_meta 空状態で render → カード button が active、InlineCardList が render される', async () => {
    render(<ExamDetailView {...defaultProps} />)

    // useEffect 完了を waitFor で待つ
    await waitFor(() => {
      const cardBtn = screen.getByRole('button', { name: 'カード' })
      expect(cardBtn).toHaveAttribute('aria-pressed', 'true')
    })

    // テーブル button は inactive
    const tableBtn = screen.getByRole('button', { name: 'テーブル' })
    expect(tableBtn).toHaveAttribute('aria-pressed', 'false')

    // InlineCardList stub が render されている
    expect(screen.getByTestId('inline-card-list-stub')).toBeInTheDocument()

    // ExamCardTable stub は render されていない
    expect(screen.queryByTestId('exam-card-table-stub')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// Case ②: saved 'table' → useEffect 後 'table'
// ===========================================================================

describe('ExamDetailView — Case ②: saved table → useEffect 後 table 切替', () => {
  it('事前に exam_view_prefs = table で seed → waitFor 後に table view に切替される', async () => {
    // 事前に sync_meta に { version: 1, view: 'table' } を seed
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 1, view: 'table' },
      examViewPrefsV1Schema,
    )

    render(<ExamDetailView {...defaultProps} />)

    // 初期は default 'card' (SSR-style)
    const cardBtnInitial = screen.getByRole('button', { name: 'カード' })
    expect(cardBtnInitial).toHaveAttribute('aria-pressed', 'true')

    // useEffect 後に 'table' に切替
    await waitFor(() => {
      const tableBtn = screen.getByRole('button', { name: 'テーブル' })
      expect(tableBtn).toHaveAttribute('aria-pressed', 'true')
    })

    // カード button は inactive
    const cardBtn = screen.getByRole('button', { name: 'カード' })
    expect(cardBtn).toHaveAttribute('aria-pressed', 'false')

    // ExamCardTable stub が render されている
    expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()

    // InlineCardList は render されていない
    expect(screen.queryByTestId('inline-card-list-stub')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// Case ③: saved 不正値 → 'card' fallback
// ===========================================================================

describe('ExamDetailView — Case ③: saved 不正値 → card fallback', () => {
  it('不正 JSON を seed → getJsonSyncMeta が undefined を返し setState 走らず default card のまま', async () => {
    // Dexie 直接書込で不正値を seed (schema mismatch → getJsonSyncMeta が undefined 返し)
    const db = getClientDb()
    await db.sync_meta.put({ key: 'exam_view_prefs', value: 'broken-json-{{{' })

    render(<ExamDetailView {...defaultProps} />)

    // useEffect 完了を waitFor で待つ
    await waitFor(() => {
      const cardBtn = screen.getByRole('button', { name: 'カード' })
      // 'card' のまま (fallback)
      expect(cardBtn).toHaveAttribute('aria-pressed', 'true')
    })

    // テーブル button は inactive
    const tableBtn = screen.getByRole('button', { name: 'テーブル' })
    expect(tableBtn).toHaveAttribute('aria-pressed', 'false')

    // InlineCardList stub が render されている
    expect(screen.getByTestId('inline-card-list-stub')).toBeInTheDocument()
  })
})

// ===========================================================================
// Case ④: toggle click → setState + setJsonSyncMeta が呼ばれる
// ===========================================================================

describe('ExamDetailView — Case ④: toggle click → setState + sync_meta write', () => {
  it('テーブル button を click → view が table に切替 + setJsonSyncMeta が正しい args で呼ばれる', async () => {
    // fix2: 書込は prefsLoaded (state, load 完了で true) に依存する。 実 Dexie load 遅延で
    // waitFor timeout する flake を避けるため load 完了を deferred で決定的にする。
    let resolveLoad!: (value: unknown) => void
    const deferred = new Promise<unknown>((resolve) => {
      resolveLoad = resolve
    })
    mockGetJsonSyncMeta.mockImplementationOnce(() => deferred)

    render(<ExamDetailView {...defaultProps} />)

    // useEffect 完了を waitFor (初期 prefs なし → card のまま)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // saved 欠損で load 解決 (prefsLoaded=true・無操作ゆえ write なし)
    await act(async () => {
      resolveLoad(undefined)
      await deferred
    })

    // spy カウントをここでリセット (無操作の load 完了では write は起きないが念のため)
    mockSetJsonSyncMeta.mockClear()

    // 「テーブル」 button を click
    const tableBtn = screen.getByRole('button', { name: 'テーブル' })
    fireEvent.click(tableBtn)

    // view が table に切替される
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'テーブル' })).toHaveAttribute('aria-pressed', 'true')
    })

    // S2-5 fix: view 変更で guard 付き永続 effect (deps [view, columnVisibility, columnPinning]) が 1 回
    // 発火し、 自 columnVisibility state (初期 { question_label: false }) から hiddenColumns=['question_label']
    // を書込む。 handleToggle は書かない (setView のみ) ため二重書込にならず書込は 1 回。
    // S5-2: 書込は V3 化 (pinnedBoundary: null = 固定なし初期値)。
    await waitFor(() => {
      expect(mockSetJsonSyncMeta).toHaveBeenCalledTimes(1)
    })
    expect(mockSetJsonSyncMeta).toHaveBeenCalledWith(
      SYNC_META_KEYS.examViewPrefs,
      { version: 3, view: 'table', hiddenColumns: ['question_label'], pinnedBoundary: null },
      examViewPrefsV3Schema,
    )

    // ExamCardTable stub が render されている
    expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()

    // InlineCardList は unmount
    expect(screen.queryByTestId('inline-card-list-stub')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// Case ④-b: view 切替が hiddenColumns を破壊しない (HARD GATE / 非破壊往復)
// S2-5 単一所有: view の書込は自 columnVisibility state から hiddenColumns を導出する。
// mount load で load 済の hiddenColumns が view 変更後も保持されることを stored 書込で固定する。
// ===========================================================================

describe('ExamDetailView — Case ④-b: view 切替が hiddenColumns を破壊しない', () => {
  it('hiddenColumns を保存済の state で view 切替 → hiddenColumns が保持される', async () => {
    // hiddenColumns を保存した state を seed (v2)。 fix2: mount echo write は無操作ゆえ起きない
    // ため、 load 完了の観測点を stub の columnVisibility 反映に変える (view=table で seed し
    // stub を render させる)。
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 2, view: 'table', hiddenColumns: ['memo', 'tags'] },
      examViewPrefsV2Schema,
    )

    render(<ExamDetailView {...defaultProps} />)

    // mount load 完了を待つ (単一所有: load が columnVisibility を set → stub の data-colvis に
    // memo/tags:false が反映される = load 完了の観測点)。 これで click 前に columnVisibility が
    // 反映済であることを保証し race を排除する。
    await waitFor(() => {
      const stub = screen.getByTestId('exam-card-table-stub')
      const colvis = JSON.parse(stub.getAttribute('data-colvis') ?? 'null')
      expect(colvis).toEqual({ memo: false, tags: false })
    })

    mockSetJsonSyncMeta.mockClear()

    // カードに切替 (ユーザー明示操作)
    fireEvent.click(screen.getByRole('button', { name: 'カード' }))

    // 単一所有: view=card + hiddenColumns=[memo,tags] (自 state から導出、 view は消えず
    // hiddenColumns も消えない = 相互非破壊)。
    // S5-2: 書込は V3 化 (pinnedBoundary: null = 固定なし)。
    await waitFor(() => {
      expect(mockSetJsonSyncMeta).toHaveBeenCalledWith(
        SYNC_META_KEYS.examViewPrefs,
        { version: 3, view: 'card', hiddenColumns: ['memo', 'tags'], pinnedBoundary: null },
        examViewPrefsV3Schema,
      )
    })
  })
})

// ===========================================================================
// Case ⑤: view 別 render (InlineCardList / ExamCardTable conditional unmount)
// ===========================================================================

describe('ExamDetailView — Case ⑤: view 別 render の conditional unmount', () => {
  it('view=card のとき InlineCardList が render され ExamCardTable は render されない', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    expect(screen.getByTestId('inline-card-list-stub')).toBeInTheDocument()
    expect(screen.queryByTestId('exam-card-table-stub')).not.toBeInTheDocument()
  })

  it('view=table に切替後は ExamCardTable が render され InlineCardList は unmount される', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // table に切替
    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))

    await waitFor(() => {
      expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()
    })

    // InlineCardList は unmount
    expect(screen.queryByTestId('inline-card-list-stub')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// Case ⑥: 幅クラス — card view は max-w-4xl (capped) / table view は w-full (full-width)
// ===========================================================================

describe('ExamDetailView — Case ⑥: 幅クラス (Edit-1 T2)', () => {
  it('default card view: InlineCardList の親要素が max-w-4xl を持つ', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    const stub = screen.getByTestId('inline-card-list-stub')
    const wrapper = stub.parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper!.className).toContain('max-w-4xl')
  })

  it('table view に切替後: ExamCardTable の親要素が w-full を持ち max-w-4xl を持たない', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // table に切替
    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))

    await waitFor(() => {
      expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()
    })

    const stub = screen.getByTestId('exam-card-table-stub')
    const wrapper = stub.parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper!.className).toContain('w-full')
    expect(wrapper!.className).not.toContain('max-w-4xl')
  })
})

// ===========================================================================
// Case ⑦: ViewToggle ボタンが xs サイズ variant を使う (Fix-3 cosmetic B)
// ===========================================================================

describe('ExamDetailView — Case ⑦: ViewToggle buttons が size=xs', () => {
  it('カード・テーブル両 button に data-size="xs" が付与される', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('data-size', 'xs')
    expect(screen.getByRole('button', { name: 'テーブル' })).toHaveAttribute('data-size', 'xs')
  })
})

// ===========================================================================
// Case ⑧: root 要素の gap が space-y-1(Fix-3 cosmetic C)
// ViewToggle と直下 view の間隔を密度優先で space-y-4(16px) → space-y-1(4px) に縮小
// ===========================================================================

describe('ExamDetailView — Case ⑧: root gap が space-y-1(Fix-3 cosmetic C)', () => {
  it('root div が space-y-1 を持ち space-y-4 を持たない', () => {
    const { container } = render(<ExamDetailView {...defaultProps} />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('space-y-1')
    expect(root.className).not.toContain('space-y-4')
  })
})

// ===========================================================================
// Case ⑨: タイトル/日付移管 — card view でタイトル/日付が視覚維持 (S2-1)
// page.tsx の <h1 text-2xl font-bold> + <p text-xs> 日付を ExamDetailView が
// props から描画。 card view branch では現状同等 (text-2xl font-bold) を維持。
// ===========================================================================

describe('ExamDetailView — Case ⑨: card view タイトル/日付 視覚維持 (S2-1)', () => {
  it('card view で examName が heading として描画され、text-2xl font-bold で日付も出る', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // タイトルが heading として描画される
    const heading = screen.getByRole('heading', { name: 'テスト試験' })
    expect(heading).toBeInTheDocument()
    // card view は現状同等スタイル (text-2xl font-bold) を維持
    expect(heading.className).toContain('text-2xl')
    expect(heading.className).toContain('font-bold')

    // 日付 (作成 / 最終更新) が描画される。createdLabel/updatedLabel が反映される (非 vacuous)
    expect(screen.getByText(/作成/)).toBeInTheDocument()
    expect(screen.getByText(/最終更新/)).toBeInTheDocument()
    expect(screen.getByText(/1ヶ月前/)).toBeInTheDocument()
    expect(screen.getByText(/2日前/)).toBeInTheDocument()
  })
})

// ===========================================================================
// Case ⑩: table view app-shell 骨格 (S2-1)
// table view branch = viewport 追従 flex 列骨格 + flex-none chrome
// (タイトル/日付 + view 切替) + flex-1 min-h-0 の ExamCardTable 領域。
// 密封 (container overflow / virtualizer 差替) は S2-2 = ここでは骨格のみ。
// jsdom は layout 計算不可ゆえ class/構造 + 高さ style の存在で固定。
// ===========================================================================

describe('ExamDetailView — Case ⑩: table view app-shell 骨格 (S2-1)', () => {
  it('table view branch が flex-col + viewport 追従高さ骨格、chrome が flex-none、表領域が flex-1 min-h-0', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // table に切替
    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))

    await waitFor(() => {
      expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()
    })

    // app-shell 骨格: flex flex-col + viewport 追従高さ (固定 px 禁止 = calc(100dvh - offset))
    const shell = screen.getByTestId('table-app-shell')
    expect(shell.className).toContain('flex')
    expect(shell.className).toContain('flex-col')
    // 高さは viewport 追従 (calc(100dvh - <topOffset>px))。 固定 px 高禁止 = inline style は calc(100dvh。
    expect(shell.style.height).toContain('calc(100dvh')
    expect(shell.style.height).not.toMatch(/^\d+px$/)

    // 上部 chrome は flex-none
    const chrome = screen.getByTestId('table-chrome')
    expect(chrome.className).toContain('flex-none')

    // ExamCardTable 領域は flex-1 min-h-0 (S2-2 の overflow が効く土台)
    const tableWrapper = screen.getByTestId('exam-card-table-stub').parentElement
    expect(tableWrapper).not.toBeNull()
    expect(tableWrapper!.className).toContain('flex-1')
    expect(tableWrapper!.className).toContain('min-h-0')
  })

  it('table view chrome 内にタイトル (examName) と view 切替が描画される', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))

    await waitFor(() => {
      expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()
    })

    const chrome = screen.getByTestId('table-chrome')
    // chrome 内にタイトルが描画される (heading)
    const heading = screen.getByRole('heading', { name: 'テスト試験' })
    expect(chrome.contains(heading)).toBe(true)
    // chrome 内に view 切替 button が描画される
    const toggleGroup = screen.getByRole('group', { name: '表示モード切替' })
    expect(chrome.contains(toggleGroup)).toBe(true)
  })

  it('table view branch は密封しない (S2-2 の責務): container の overflow を変えない', async () => {
    // 密封 (overflow-auto container) は S2-2 の責務。 表領域 wrapper に overflow-auto が
    // 付かないことを固定する (S2-5 で columnVisibility controlled prop は追加済 = 別軸)。
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))

    await waitFor(() => {
      expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()
    })

    // 表領域 wrapper は overflow-auto を持たない (密封は S2-2)
    const tableWrapper = screen.getByTestId('exam-card-table-stub').parentElement
    expect(tableWrapper!.className).not.toContain('overflow-auto')
  })
})

// ===========================================================================
// Case ⑪ (S2-5): 列ボタン (ColumnVisibilityToggle) の配置 — table view のみ表示
// ===========================================================================

describe('ExamDetailView — Case ⑪ (S2-5): 列ボタンは table view のみ表示', () => {
  it('card view (既定) では列ボタンが描画されない', async () => {
    render(<ExamDetailView {...defaultProps} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })
    expect(screen.queryByRole('button', { name: '列の表示・非表示' })).not.toBeInTheDocument()
  })

  it('table view に切替後は chrome 内に列ボタンが描画される', async () => {
    render(<ExamDetailView {...defaultProps} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => {
      expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()
    })

    // chrome 内に列ボタンが描画される (view 切替の並び)
    const chrome = screen.getByTestId('table-chrome')
    const colBtn = screen.getByRole('button', { name: '列の表示・非表示' })
    expect(chrome.contains(colBtn)).toBe(true)
  })
})

// ===========================================================================
// Case ⑫ (S2-5): 単一所有 mount-load — saved hiddenColumns が table へ渡る
// ===========================================================================

describe('ExamDetailView — Case ⑫ (S2-5): mount-load で hiddenColumns が table prop に反映', () => {
  it('saved hiddenColumns=[explanation_text] → stub の columnVisibility に反映される', async () => {
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 2, view: 'table', hiddenColumns: ['explanation_text'] },
      examViewPrefsV2Schema,
    )

    render(<ExamDetailView {...defaultProps} />)

    // saved view='table' へ切替 + stub が hidden 列を反映した columnVisibility を受ける
    await waitFor(() => {
      const stub = screen.getByTestId('exam-card-table-stub')
      const colvis = JSON.parse(stub.getAttribute('data-colvis') ?? 'null')
      expect(colvis).toEqual({ explanation_text: false })
    })
  })
})

// ===========================================================================
// Case ⑬ (S2-5): 単一所有 列 toggle 永続 — 列変更が view を消さない (HARD GATE)
// 列トグルで列を off → persist は {version:2, view:table, hiddenColumns:[col]} を書き、
// view=table を保持する (相互非破壊)。 stored 書込 + stub prop 反映を固定する。
// ===========================================================================

describe('ExamDetailView — Case ⑬ (S2-5): 列 toggle が view を破壊しない', () => {
  it('table view で列を off → 永続 record が view=table を保持し hiddenColumns に載る', async () => {
    // view=table + hidden なし で seed (chrome + 列ボタンが出る状態)
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 2, view: 'table', hiddenColumns: [] },
      examViewPrefsV2Schema,
    )

    render(<ExamDetailView {...defaultProps} />)

    // table view + 列ボタン描画を待つ
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'テーブル' })).toHaveAttribute('aria-pressed', 'true')
    })
    const colBtn = await screen.findByRole('button', { name: '列の表示・非表示' })

    mockSetJsonSyncMeta.mockClear()

    // 列ボタン popover を開いて メモ を off
    fireEvent.click(colBtn)
    const memoCheckbox = await screen.findByRole('checkbox', { name: '列表示: メモ' })
    fireEvent.click(memoCheckbox)

    // 永続 record を stored から確認 (HARD GATE): view=table 保持 + memo が hiddenColumns。
    // S5-2: 書込は V3 化。examViewPrefsToV3 で正規化して view / hiddenColumns を確認。
    await waitFor(async () => {
      const saved = await getJsonSyncMeta(SYNC_META_KEYS.examViewPrefs, examViewPrefsSchema)
      expect(saved).toBeDefined()
      const v3 = examViewPrefsToV3(saved!)
      expect(v3.view, '列変更が view を消さない').toBe('table')
      expect(v3.hiddenColumns).toContain('memo')
    })

    // detail-view → table の controlled prop 配線: stub が memo:false を受ける
    await waitFor(() => {
      const stub = screen.getByTestId('exam-card-table-stub')
      const colvis = JSON.parse(stub.getAttribute('data-colvis') ?? 'null')
      expect(colvis.memo).toBe(false)
    })
  })
})

// ===========================================================================
// Case ⑭ (S2-5 fix / R3): 永続 load-race — load 解決前の view 切替が saved を破壊しない
// getJsonSyncMeta を deferred promise で mock し、 load 未解決のまま view を切替える。
// 修正前 (handleToggle が非 guard で write) は default columnVisibility 由来の
// hiddenColumns=['question_label'] を書き saved (memo hidden) を上書き = 設定消失 (R3)。
// 修正後は永続が prefsLoadedRef guard 付き単一 effect に集約され、 pre-load write が
// 起きず、 load 解決後に saved hiddenColumns が保持される。
// ===========================================================================

describe('ExamDetailView — Case ⑭ (S2-5 fix / R3): 永続 load-race で saved を破壊しない', () => {
  it('load 解決前に view 切替 → guard で write されず、 load 解決後 saved hiddenColumns=[memo] を保持', async () => {
    // getJsonSyncMeta を未解決 deferred に差し替え (mount load を保留させる)
    let resolveLoad!: (value: unknown) => void
    const deferred = new Promise<unknown>((resolve) => {
      resolveLoad = resolve
    })
    mockGetJsonSyncMeta.mockImplementationOnce(() => deferred)

    render(<ExamDetailView {...defaultProps} />)

    // load 未解決: default 'card' のまま
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // load 解決前に table へ切替 (R3 の発火条件: slow read + 素早いクリック)
    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'テーブル' })).toHaveAttribute('aria-pressed', 'true')
    })

    // 修正の核心: load 未完了 (prefsLoadedRef=false) ゆえ永続 write は 1 回も起きない。
    // 修正前はここで handleToggle が hiddenColumns=['question_label'] を書き RED になる。
    expect(mockSetJsonSyncMeta).not.toHaveBeenCalled()

    // load を saved { view:'table', hiddenColumns:['memo'] } で解決
    await act(async () => {
      resolveLoad({ version: 2, view: 'table', hiddenColumns: ['memo'] })
      await deferred
    })

    // load 解決後の永続 write は saved hiddenColumns=['memo'] を保持する (clobber なし)。
    // S5-2: 書込は V3 化 (pinnedBoundary: null = 固定なし)。
    await waitFor(() => {
      expect(mockSetJsonSyncMeta).toHaveBeenCalledWith(
        SYNC_META_KEYS.examViewPrefs,
        { version: 3, view: 'table', hiddenColumns: ['memo'], pinnedBoundary: null },
        examViewPrefsV3Schema,
      )
    })

    // default 由来の ['question_label'] で上書きした形跡がない (= saved 消失していない)
    expect(mockSetJsonSyncMeta).not.toHaveBeenCalledWith(
      SYNC_META_KEYS.examViewPrefs,
      expect.objectContaining({ hiddenColumns: ['question_label'] }),
      expect.anything(),
    )
  })
})

// ===========================================================================
// Case ⑮ (S2-5 fix2): pre-load view toggle の post-load replay (Codex P2)
// fix1 が導入した edge: load 解決前に view 切替 + saved 欠損 (新規ユーザー) だと
// guard で write skip → fix1 は prefsLoadedRef (ref) を true にするだけで effect を
// 再発火せず、 pre-load の view 変更が永続されず消失した。 fix2 は「loaded」を state 化し
// load 完了で effect を再発火させ、 userInteracted 済ゆえ current view (table) を replay 書込。
// ===========================================================================

describe('ExamDetailView — Case ⑮ (S2-5 fix2): pre-load view toggle が post-load で replay される', () => {
  it('load 解決前に table 切替 + saved 欠損 → load 解決後に current view(table) が永続される', async () => {
    // getJsonSyncMeta を未解決 deferred に差し替え (mount load を保留させる)
    let resolveLoad!: (value: unknown) => void
    const deferred = new Promise<unknown>((resolve) => {
      resolveLoad = resolve
    })
    mockGetJsonSyncMeta.mockImplementationOnce(() => deferred)

    render(<ExamDetailView {...defaultProps} />)

    // load 未解決: default 'card' のまま
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // load 解決前に table へ切替 (ユーザー明示操作)
    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'テーブル' })).toHaveAttribute('aria-pressed', 'true')
    })

    // load 未完了ゆえ pre-load の write は起きない (guard skip)
    expect(mockSetJsonSyncMeta).not.toHaveBeenCalled()

    // load を「saved 欠損 (新規ユーザー)」で解決 (undefined)
    await act(async () => {
      resolveLoad(undefined)
      await deferred
    })

    // fix2 核心: load 完了で effect が再発火し、 userInteracted 済ゆえ current view(table) を
    // replay 書込する (fix1 では二度と発火せず消失していた = RED)。
    // S5-2: 書込は V3 化 (pinnedBoundary: null = 固定なし初期値)。
    await waitFor(() => {
      expect(mockSetJsonSyncMeta).toHaveBeenCalledWith(
        SYNC_META_KEYS.examViewPrefs,
        { version: 3, view: 'table', hiddenColumns: ['question_label'], pinnedBoundary: null },
        examViewPrefsV3Schema,
      )
    })
  })
})

// ===========================================================================
// Case ⑯ (S2-5 fix2): 新規ユーザー無操作の spurious mount write を抑止 (no-spurious)
// loaded-state 化で load 完了に effect が再発火するが、 userInteracted=false の間は
// write しない。 新規ユーザーが何も操作せず開いただけで sync_meta を書かないことを固定。
// (loaded-state 化のみで userInteracted guard を欠くと load 完了で spurious write = RED)
// ===========================================================================

describe('ExamDetailView — Case ⑯ (S2-5 fix2): 新規ユーザー無操作で spurious write なし', () => {
  it('saved 欠損で load 解決 + 無操作 → setJsonSyncMeta が一度も呼ばれない', async () => {
    // deferred で load 完了タイミングを決定的にする
    let resolveLoad!: (value: unknown) => void
    const deferred = new Promise<unknown>((resolve) => {
      resolveLoad = resolve
    })
    mockGetJsonSyncMeta.mockImplementationOnce(() => deferred)

    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // saved 欠損で load 解決 (無操作: click なし)
    await act(async () => {
      resolveLoad(undefined)
      await deferred
    })

    // 無操作 (userInteracted=false) ゆえ load 完了で effect が再発火しても write しない
    expect(mockSetJsonSyncMeta).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Case ⑰ (S2 scroll-fix): root の pb-8 view 分岐
// table view では document が一切スクロールしないよう root の pb-8 を付けない。
// card view では下部余白のため pb-8 を維持する(非 vacuous: 対比で双方を固定)。
// ===========================================================================

describe('ExamDetailView — Case ⑰ (S2 scroll-fix): root の pb-8 は card のみ', () => {
  it('card view (既定) では root が pb-8 を持つ', () => {
    const { container } = render(<ExamDetailView {...defaultProps} />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('pb-8')
  })

  it('table view に切替後は root が pb-8 を持たない', async () => {
    // table に seed して view=table で render させる
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 2, view: 'table', hiddenColumns: [] },
      examViewPrefsV2Schema,
    )

    const { container } = render(<ExamDetailView {...defaultProps} />)

    // useEffect 後に table view に切替されるのを待つ
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'テーブル' })).toHaveAttribute('aria-pressed', 'true')
    })

    const root = container.firstElementChild as HTMLElement
    expect(root.className).not.toContain('pb-8')
  })
})

// ===========================================================================
// Case ⑱ (S2b-1): table-chrome collapse — onCollapsedChange 受信で chrome が畳まれる
//
// ExamCardTable は stub(onCollapsedChange prop を持つ)。
// stub の trigger button を fireEvent.click して onCollapsedChange を注入し、
// table-chrome の grid-rows クラス変化を確認する。
//
// (b) collapsed → chrome に grid-rows-[0fr] / expand → grid-rows-[1fr]
// (d) table → card 切替で chromeCollapsed がリセット → 再 table 時に grid-rows-[1fr]
// ===========================================================================

describe('ExamDetailView — Case ⑱ (S2b-1): table-chrome collapse', () => {
  it('table view: 初期状態で table-chrome が grid-rows-[1fr] を持つ(展開)', async () => {
    render(<ExamDetailView {...defaultProps} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true'),
    )

    // table に切替
    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument())

    const chrome = screen.getByTestId('table-chrome')
    expect(chrome.className, '初期は grid-rows-[1fr]').toContain('grid-rows-[1fr]')
    expect(chrome.className, '初期は grid-rows-[0fr] なし').not.toContain('grid-rows-[0fr]')
  })

  it('onCollapsedChange(true) → table-chrome が grid-rows-[0fr] に切替(collapse)', async () => {
    render(<ExamDetailView {...defaultProps} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument())

    // stub の collapse trigger を click
    fireEvent.click(screen.getByTestId('stub-trigger-collapse'))

    await waitFor(() => {
      const chrome = screen.getByTestId('table-chrome')
      expect(chrome.className, 'collapse で grid-rows-[0fr]').toContain('grid-rows-[0fr]')
      expect(chrome.className, 'collapse で grid-rows-[1fr] 消滅').not.toContain('grid-rows-[1fr]')
    })
  })

  it('onCollapsedChange(false) → table-chrome が grid-rows-[1fr] に復帰(expand)', async () => {
    render(<ExamDetailView {...defaultProps} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument())

    // collapse
    fireEvent.click(screen.getByTestId('stub-trigger-collapse'))
    await waitFor(() =>
      expect(screen.getByTestId('table-chrome').className).toContain('grid-rows-[0fr]'),
    )

    // expand
    fireEvent.click(screen.getByTestId('stub-trigger-expand'))
    await waitFor(() => {
      const chrome = screen.getByTestId('table-chrome')
      expect(chrome.className, 'expand で grid-rows-[1fr] 復帰').toContain('grid-rows-[1fr]')
      expect(chrome.className, 'expand で grid-rows-[0fr] 消滅').not.toContain('grid-rows-[0fr]')
    })
  })

  it('collapse → table-chrome 内側 div が inert を持つ(F1 a11y)', async () => {
    render(<ExamDetailView {...defaultProps} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument())

    const chrome = screen.getByTestId('table-chrome')
    const innerDiv = chrome.firstElementChild as HTMLElement

    // 展開状態: inert なし
    expect(innerDiv, '展開時は inert なし').not.toHaveAttribute('inert')

    // collapse
    fireEvent.click(screen.getByTestId('stub-trigger-collapse'))
    await waitFor(() => {
      expect(innerDiv, 'collapse → inert を持つ').toHaveAttribute('inert')
    })
  })

  it('collapse → expand で table-chrome 内側 div の inert が消える(F1 a11y)', async () => {
    render(<ExamDetailView {...defaultProps} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument())

    const chrome = screen.getByTestId('table-chrome')
    const innerDiv = chrome.firstElementChild as HTMLElement

    // collapse
    fireEvent.click(screen.getByTestId('stub-trigger-collapse'))
    await waitFor(() => expect(innerDiv).toHaveAttribute('inert'))

    // expand
    fireEvent.click(screen.getByTestId('stub-trigger-expand'))
    await waitFor(() => {
      expect(innerDiv, 'expand → inert が消える').not.toHaveAttribute('inert')
    })
  })
})

describe('ExamDetailView — Case ⑲ (S2b-1 d): view 切替で chromeCollapsed がリセット', () => {
  it('table → collapse → card → table → chrome が展開状態でレンダーされる', async () => {
    render(<ExamDetailView {...defaultProps} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true'),
    )

    // table に切替
    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument())

    // collapse
    fireEvent.click(screen.getByTestId('stub-trigger-collapse'))
    await waitFor(() =>
      expect(screen.getByTestId('table-chrome').className).toContain('grid-rows-[0fr]'),
    )

    // card に切替(ExamCardTable unmount + chromeCollapsed reset)
    fireEvent.click(screen.getByRole('button', { name: 'カード' }))
    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-table-stub')).not.toBeInTheDocument(),
    )

    // table に再切替(ExamCardTable remount)
    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument())

    // chrome が展開状態(grid-rows-[1fr])で描画されること
    const chrome = screen.getByTestId('table-chrome')
    expect(chrome.className, 'view 再入後 chrome は展開 (grid-rows-[1fr])').toContain('grid-rows-[1fr]')
    expect(chrome.className, 'view 再入後 chrome は grid-rows-[0fr] なし').not.toContain('grid-rows-[0fr]')
  })

  it('table-chrome collapse 中は flex-none を維持する(既存 D-4 不変)', async () => {
    render(<ExamDetailView {...defaultProps} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))
    await waitFor(() => expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument())

    // collapse
    fireEvent.click(screen.getByTestId('stub-trigger-collapse'))
    await waitFor(() =>
      expect(screen.getByTestId('table-chrome').className).toContain('grid-rows-[0fr]'),
    )

    // flex-none を維持
    const chrome = screen.getByTestId('table-chrome')
    expect(chrome.className, 'collapse 中も flex-none').toContain('flex-none')
  })
})

// ===========================================================================
// S5-2 Cases: columnPinning 配線 — load 復元 / persist / guard 回帰 (brief 完了条件 c)
// ===========================================================================

describe('ExamDetailView — S5-2 (c-1): V3 record (pinnedBoundary:title) → ExamCardTable に left=[select,title]', () => {
  it('V3 prefs を seed → stub の data-pinning が {left:[select,title],right:[]} になる', async () => {
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 3, view: 'table', hiddenColumns: [], pinnedBoundary: 'title' },
      examViewPrefsV3Schema,
    )

    render(<ExamDetailView {...defaultProps} />)

    // mount load 完了を待つ (view=table で ExamCardTable stub が描画される)
    await waitFor(() => {
      const stub = screen.getByTestId('exam-card-table-stub')
      const pinning = JSON.parse(stub.getAttribute('data-pinning') ?? 'null')
      // computePinnedLeft('title') = ['select', 'title']
      expect(pinning).toEqual({ left: ['select', 'title'], right: [] })
    })
  })
})

describe('ExamDetailView — S5-2 (c-2): V2 record load → columnPinning = {left:[],right:[]} (migration)', () => {
  it('V2 prefs を seed → stub の data-pinning が {left:[],right:[]} (pinnedBoundary=null) になる', async () => {
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 2, view: 'table', hiddenColumns: [] },
      examViewPrefsV2Schema,
    )

    render(<ExamDetailView {...defaultProps} />)

    // V2 → pinnedBoundary: null → computePinnedLeft(null) = []
    await waitFor(() => {
      const stub = screen.getByTestId('exam-card-table-stub')
      const pinning = JSON.parse(stub.getAttribute('data-pinning') ?? 'null')
      expect(pinning).toEqual({ left: [], right: [] })
    })
  })
})

describe('ExamDetailView — S5-2 (c-3): pinning 変更 → persist effect が V3 + pinnedBoundary を書く', () => {
  it('view=table seed 後に view 切替 → V3 { pinnedBoundary: null } で persist される (null path)', async () => {
    // view=table で seed (stub が描画される状態にする)
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 2, view: 'table', hiddenColumns: [] },
      examViewPrefsV2Schema,
    )

    render(<ExamDetailView {...defaultProps} />)

    // load 完了を待つ
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'テーブル' })).toHaveAttribute('aria-pressed', 'true')
    })
    // stub が描画されていることを確認
    await waitFor(() => expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument())

    mockSetJsonSyncMeta.mockClear()

    // view 切替で persist effect が発火 → V3 format + pinnedBoundary:null が書かれる (null path)
    fireEvent.click(screen.getByRole('button', { name: 'カード' }))

    await waitFor(() => {
      expect(mockSetJsonSyncMeta).toHaveBeenCalledWith(
        SYNC_META_KEYS.examViewPrefs,
        expect.objectContaining({ version: 3, pinnedBoundary: null }),
        examViewPrefsV3Schema,
      )
    })
  })

  it('stub-trigger-pin → V3 { pinnedBoundary: "title" } で persist される (非 null path)', async () => {
    // view=table で seed (stub が描画される状態にする)
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 2, view: 'table', hiddenColumns: [] },
      examViewPrefsV2Schema,
    )

    render(<ExamDetailView {...defaultProps} />)

    // load 完了を待つ (stub 表示 = load 完了の観測点)
    await waitFor(() => expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument())

    mockSetJsonSyncMeta.mockClear()

    // stub-trigger-pin: onColumnPinningChange?.({ left: ['select','title'], right: [] }) を注入
    // → ExamDetailView が columnPinning state を更新 → persist effect が V3 + pinnedBoundary:'title' を書く
    fireEvent.click(screen.getByTestId('stub-trigger-pin'))

    await waitFor(() => {
      expect(mockSetJsonSyncMeta).toHaveBeenCalledWith(
        SYNC_META_KEYS.examViewPrefs,
        expect.objectContaining({ version: 3, pinnedBoundary: 'title' }),
        examViewPrefsV3Schema,
      )
    })
  })
})

describe('ExamDetailView — S5-2 (c-4): 無操作 mount では write なし (userInteracted guard 回帰)', () => {
  it('V3 seed + 無操作 → setJsonSyncMeta が一度も呼ばれない', async () => {
    // deferred で load 完了タイミングを決定的にする
    let resolveLoad!: (value: unknown) => void
    const deferred = new Promise<unknown>((resolve) => {
      resolveLoad = resolve
    })
    mockGetJsonSyncMeta.mockImplementationOnce(() => deferred)

    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // V3 record で load 解決 (無操作)
    await act(async () => {
      resolveLoad({
        version: 3 as const,
        view: 'table',
        hiddenColumns: [],
        pinnedBoundary: 'title',
      })
      await deferred
    })

    // 無操作 (userInteracted=false) ゆえ write なし
    expect(mockSetJsonSyncMeta).not.toHaveBeenCalled()
  })
})

describe('ExamDetailView — S5-2 (c-5): 未知 boundary id → {left:[],right:[]} に無害化', () => {
  it('V3 pinnedBoundary="unknown-col" → computePinnedLeft が [] を返し stub に {left:[],right:[]} が渡る', async () => {
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 3, view: 'table', hiddenColumns: [], pinnedBoundary: 'unknown-col-xyz' },
      examViewPrefsV3Schema,
    )

    render(<ExamDetailView {...defaultProps} />)

    // 未知 id → computePinnedLeft('unknown-col-xyz') = [] → { left: [], right: [] }
    await waitFor(() => {
      const stub = screen.getByTestId('exam-card-table-stub')
      const pinning = JSON.parse(stub.getAttribute('data-pinning') ?? 'null')
      expect(pinning).toEqual({ left: [], right: [] })
    })
  })
})
