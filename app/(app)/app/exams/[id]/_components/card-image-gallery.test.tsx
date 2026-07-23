// @vitest-environment jsdom
// CardImageGallery — target 単位 gallery(添付・削除・表示) の unit test
// (画像フェーズ A Task 10 / spec §5、 task-10-brief.md)。
//
// モック方針:
// - `@/lib/media/upload` (attachImageToCard) / `@/lib/media/get-asset` (getAssetObjectURL) /
//   `@/lib/sync/optimistic-mutation` (runOptimisticUpdate) / `../_actions/asset-actions`
//   (reserveAsset/finalizeAsset/resolveAssetUrls) を spy mock する。
// - `../_actions/asset-actions` は 'use server' + `lib/storage/r2.ts` の R2_* env fail-fast
//   を経由するため、 未 mock だと module load 時に throw する (vitest.setup.ts は R2_* を
//   供給しない) — 本 test は必ず mock する。
// - abandonUpload は import せず、 mock module 内に定義した spy で「呼ばれていないこと」を
//   確認する (delete は abandonUpload を使わない、 brief 制約)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import type { ClientCardImage } from '@/lib/client-db'
import type { ZoomImage } from '@/components/media/use-image-zoom'

// ---------------------------------------------------------------------------
// モック (hoisted → vi.mock より先に定義)
// ---------------------------------------------------------------------------

const {
  mockAttachImageToCard,
  mockAbandonUpload,
  mockRemoveImageFromCard,
  mockGetAssetObjectURL,
  mockReserveAsset,
  mockFinalizeAsset,
  mockResolveAssetUrls,
  mockReclaimLocalAssetBlobs,
  mockOpen,
} = vi.hoisted(() => ({
  mockAttachImageToCard: vi.fn(),
  mockAbandonUpload: vi.fn(),
  mockRemoveImageFromCard: vi.fn(async () => undefined),
  mockGetAssetObjectURL: vi.fn(),
  mockReserveAsset: vi.fn(),
  mockFinalizeAsset: vi.fn(),
  mockResolveAssetUrls: vi.fn(),
  mockReclaimLocalAssetBlobs: vi.fn(async () => undefined),
  mockOpen: vi.fn<(images: ZoomImage[], startIndex: number) => Promise<void>>(
    async () => undefined,
  ),
}))

vi.mock('@/lib/media/upload', () => ({
  attachImageToCard: mockAttachImageToCard,
  abandonUpload: mockAbandonUpload,
  removeImageFromCard: mockRemoveImageFromCard,
}))
vi.mock('@/lib/media/reclaim-local-asset-blobs', () => ({
  reclaimLocalAssetBlobs: mockReclaimLocalAssetBlobs,
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: mockGetAssetObjectURL,
}))
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: mockReserveAsset,
  finalizeAsset: mockFinalizeAsset,
  resolveAssetUrls: mockResolveAssetUrls,
}))
// useImageZoom (PhotoSwipe を知る唯一の unit) は spy mock する。 open() の引数
// (解決済み ZoomImage[] / startIndex) を観測するのが本 task の主眼で、 実 PhotoSwipe /
// CSS import はここでは不要 (mock 化で photoswipe/style.css の import も回避)。
vi.mock('@/components/media/use-image-zoom', () => ({
  useImageZoom: () => ({ open: mockOpen }),
}))
// getClientDb はモックせず、 fake-indexeddb 上の実 Dexie を使う (vitest.setup.ts が
// 'fake-indexeddb/auto' を全 test に供給)。 openModal は media_assets mirror の dims を
// 実際に読むため、 実 store に seed して decode fallback / dims 経路を behavioral に検証する。

import { getClientDb } from '@/lib/client-db'

import { CardImageGallery } from './card-image-gallery'

const USER_ID = 'user-gallery-test'
const CARD_ID = 'card-gallery-test'
const TARGET = 'question_text'

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UUID_OTHER_TARGET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LEGACY_KEY = 'img-1'

beforeEach(async () => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  mockGetAssetObjectURL.mockResolvedValue('blob:mock-object-url')
  // 実 Dexie を使うため test 間で media_assets を掃除する (dims seed の残留防止)。
  await getClientDb().media_assets.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// openModal が実際に読む media_assets mirror へ dims を seed する。
async function seedAssetDims(key: string, width: number, height: number): Promise<void> {
  await getClientDb().media_assets.put({
    id: key,
    user_id: USER_ID,
    status: 'ready',
    mime: 'image/png',
    byte_size: 100,
    width,
    height,
    hash: `hash-${key}`,
    created_at: '2026-01-01T00:00:00.000Z',
  })
}

// 画像 button (tap→モーダル) は alt が名前になり得るため role 名で一意に取れない。
// 描画済み <img> の親 button を辿るのが安定 (loading/失敗は img が無い = button も無い)。
function imageButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('img')).map((img) => {
    const btn = img.closest('button')
    if (!btn) throw new Error('image <img> is not wrapped in a <button>')
    return btn
  })
}

// ---------------------------------------------------------------------------
// ① UUID-filter
// ---------------------------------------------------------------------------

describe('CardImageGallery UUID filter', () => {
  it('legacy key / 別 target の UUID key は除外し、 該当 target の UUID key のみ描画する', async () => {
    const images: ClientCardImage[] = [
      { key: UUID_A, target: TARGET, alt: '' },
      { key: LEGACY_KEY, target: TARGET, alt: '' },
      { key: UUID_OTHER_TARGET, target: 'option:opt-1', alt: '' },
    ]
    const { container } = render(
      <CardImageGallery
        images={images}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
      />,
    )
    await waitFor(() => {
      expect(container.querySelectorAll('img')).toHaveLength(1)
    })
    // resolve は該当 1 件分のみ呼ばれる
    expect(mockGetAssetObjectURL).toHaveBeenCalledTimes(1)
    expect(mockGetAssetObjectURL).toHaveBeenCalledWith(
      USER_ID,
      UUID_A,
      expect.objectContaining({ resolveAssetUrls: mockResolveAssetUrls }),
    )
  })

  it('images が undefined / 非配列 (stale mirror) でも throw せず描画する (Array.isArray 防御)', () => {
    // 旧 schema / stale row 想定。 filter で crash して exam 詳細 view を壊さないこと。
    expect(() =>
      render(
        <CardImageGallery
          images={undefined as unknown as ClientCardImage[]}
          target={TARGET}
          cardId={CARD_ID}
          userId={USER_ID}
        />,
      ),
    ).not.toThrow()
    // 画像は 0 件、 attach 影響なし。
    expect(mockGetAssetObjectURL).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ② Attach
// ---------------------------------------------------------------------------

describe('CardImageGallery attach', () => {
  function fileInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"]')
    if (!input) throw new Error('file input not found')
    return input as HTMLInputElement
  }

  it('file 選択 → attachImageToCard が正しい引数で呼ばれる', async () => {
    mockAttachImageToCard.mockResolvedValueOnce({ ok: true, assetId: UUID_A })
    const images: ClientCardImage[] = []
    const { container } = render(
      <CardImageGallery
        images={images}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
      />,
    )
    const file = new File(['x'], 'photo.png', { type: 'image/png' })
    fireEvent.change(fileInput(container), { target: { files: [file] } })

    await waitFor(() => {
      expect(mockAttachImageToCard).toHaveBeenCalledTimes(1)
    })
    expect(mockAttachImageToCard).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        cardId: CARD_ID,
        target: TARGET,
        file,
        currentImages: images,
      }),
      expect.objectContaining({
        reserveAsset: mockReserveAsset,
        finalizeAsset: mockFinalizeAsset,
      }),
    )
  })

  it('file 選択後、 同じ file を再選択しても change が発火するよう input value がリセットされる', async () => {
    mockAttachImageToCard.mockResolvedValueOnce({ ok: true, assetId: UUID_A })
    const { container } = render(
      <CardImageGallery images={[]} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    const input = fileInput(container)
    const file = new File(['x'], 'photo.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(mockAttachImageToCard).toHaveBeenCalledTimes(1))
    expect(input.value).toBe('')
  })

  it('{ok:false, code:"TOO_MANY_IMAGES"} → 「画像は10枚までです」を表示', async () => {
    mockAttachImageToCard.mockResolvedValueOnce({ ok: false, code: 'TOO_MANY_IMAGES' })
    const { container } = render(
      <CardImageGallery images={[]} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    const file = new File(['x'], 'photo.png', { type: 'image/png' })
    fireEvent.change(fileInput(container), { target: { files: [file] } })
    expect(await screen.findByText('画像は10枚までです')).toBeInTheDocument()
  })

  it('{ok:false, code:"INVALID_TYPE"} → 「対応していない画像形式です」を表示', async () => {
    mockAttachImageToCard.mockResolvedValueOnce({ ok: false, code: 'INVALID_TYPE' })
    const { container } = render(
      <CardImageGallery images={[]} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    const file = new File(['x'], 'photo.gif', { type: 'image/gif' })
    fireEvent.change(fileInput(container), { target: { files: [file] } })
    expect(await screen.findByText('対応していない画像形式です')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// ③ Delete
// ---------------------------------------------------------------------------

describe('CardImageGallery delete', () => {
  it('× click → removeImageFromCard({cardId, assetId}) が呼ばれ、 abandonUpload / runOptimisticUpdate は使わない (直列化+fresh-read 経路)', async () => {
    const images: ClientCardImage[] = [
      { key: UUID_A, target: TARGET, alt: '' },
      { key: UUID_B, target: TARGET, alt: '' },
    ]
    const { container } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    await waitFor(() => {
      expect(container.querySelectorAll('img')).toHaveLength(2)
    })
    const deleteButtons = screen.getAllByRole('button', { name: /削除|×/ })
    fireEvent.click(deleteButtons[0]!)

    await waitFor(() => {
      expect(mockRemoveImageFromCard).toHaveBeenCalledTimes(1)
    })
    // 削除する asset は 1 つ目 (UUID_A)。 removeImageFromCard は cardId + assetId のみ受ける
    // (fresh-read + 直列化は upload.ts 側。 gallery は snapshot を渡さない)。
    expect(mockRemoveImageFromCard).toHaveBeenCalledWith({
      cardId: CARD_ID,
      assetId: UUID_A,
    })
    // delete は asset を残す = abandonUpload を使わない。
    expect(mockAbandonUpload).not.toHaveBeenCalled()
    // removeImageFromCard 後にローカル Cache blob + media_assets 行を best-effort 掃除する
    // (spec §4.7)。
    await waitFor(() => {
      expect(mockReclaimLocalAssetBlobs).toHaveBeenCalledWith(USER_ID, [UUID_A])
    })
  })
})

// ---------------------------------------------------------------------------
// ④ Placeholder / readOnly
// ---------------------------------------------------------------------------

describe('CardImageGallery placeholder / readOnly', () => {
  it('getAssetObjectURL が null を返す → broken/retry placeholder を表示し <img> は描画しない', async () => {
    mockGetAssetObjectURL.mockResolvedValueOnce(null)
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '' }]
    const { container } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    expect(await screen.findByText('再読み込み')).toBeInTheDocument()
    expect(container.querySelector('img')).not.toBeInTheDocument()
  })

  it('readOnly=true → 追加 button と削除(×)button が存在しない', async () => {
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '' }]
    const { container } = render(
      <CardImageGallery
        images={images}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
        readOnly
      />,
    )
    await waitFor(() => {
      expect(container.querySelectorAll('img')).toHaveLength(1)
    })
    expect(container.querySelector('input[type="file"]')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /削除|×/ })).not.toBeInTheDocument()
    expect(screen.queryByText('画像を追加')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// ⑦ compact mode (Sprint I W3): 選択肢のように gallery が数に比例して増える面で、
// 空状態を dashed「画像を追加」ボタンでなく小さな +画像 アイコンに留める(§9 行高肥大回避)。
// ---------------------------------------------------------------------------
describe('CardImageGallery compact mode (Sprint I W3)', () => {
  it('compact + 空 + edit → 小さな +画像 アイコンボタン(attachAriaLabel でアクセス可)を出し、dashed「画像を追加」テキストは出さない', () => {
    render(
      <CardImageGallery
        images={[]}
        target="option:a"
        cardId={CARD_ID}
        userId={USER_ID}
        compact
        attachAriaLabel="選択肢 a に画像を追加"
      />,
    )
    expect(
      screen.getByRole('button', { name: '選択肢 a に画像を追加' }),
    ).toBeInTheDocument()
    // dashed テキストボタン「画像を追加」は compact では出さない(§9 行高肥大回避)
    expect(screen.queryByText('画像を追加')).not.toBeInTheDocument()
  })

  it('非 compact(既定)+ 空 + edit → dashed「画像を追加」テキストボタン(回帰維持)', () => {
    render(
      <CardImageGallery images={[]} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    expect(
      screen.getByRole('button', { name: '画像を追加' }),
    ).toBeInTheDocument()
  })

  it('compact + readOnly + 空 → 何も描画しない(null)', () => {
    const { container } = render(
      <CardImageGallery
        images={[]}
        target="option:a"
        cardId={CARD_ID}
        userId={USER_ID}
        compact
        readOnly
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('compact + 画像あり + edit → thumbnail と +画像 アイコンの両方を出す', async () => {
    const { container } = render(
      <CardImageGallery
        images={[{ key: UUID_A, target: 'option:a', alt: '' }]}
        target="option:a"
        cardId={CARD_ID}
        userId={USER_ID}
        compact
        attachAriaLabel="選択肢 a に画像を追加"
      />,
    )
    await waitFor(() => {
      expect(container.querySelectorAll('img')).toHaveLength(1)
    })
    expect(
      screen.getByRole('button', { name: '選択肢 a に画像を追加' }),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// ⑧ slot mode (Sprint I fix・§9 行高): add affordance と thumbnail を別配置する。
// 'add' = アイコンのみ(ラベル行/選択肢行に収める)/ 'thumbnails' = thumbnail のみ(下に表示)。
// ---------------------------------------------------------------------------
describe('CardImageGallery slot mode (Sprint I fix)', () => {
  it("slot='add' + 空 → add アイコンのみ(thumbnail なし)", () => {
    const { container } = render(
      <CardImageGallery
        images={[]}
        target="question_text"
        cardId={CARD_ID}
        userId={USER_ID}
        slot="add"
        compact
        attachAriaLabel="問題文に画像を追加"
      />,
    )
    expect(screen.getByRole('button', { name: '問題文に画像を追加' })).toBeInTheDocument()
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it("slot='add' + 画像あり → add アイコンのみ・thumbnail は出さない(下の slot='thumbnails' が担う)", async () => {
    const { container } = render(
      <CardImageGallery
        images={[{ key: UUID_A, target: 'question_text', alt: '' }]}
        target="question_text"
        cardId={CARD_ID}
        userId={USER_ID}
        slot="add"
        compact
        attachAriaLabel="問題文に画像を追加"
      />,
    )
    expect(screen.getByRole('button', { name: '問題文に画像を追加' })).toBeInTheDocument()
    // add slot は thumbnail を描画しない
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it("slot='thumbnails' + 画像あり → thumbnail のみ・add button/input なし", async () => {
    const { container } = render(
      <CardImageGallery
        images={[{ key: UUID_A, target: 'question_text', alt: '' }]}
        target="question_text"
        cardId={CARD_ID}
        userId={USER_ID}
        slot="thumbnails"
      />,
    )
    await waitFor(() => {
      expect(container.querySelectorAll('img')).toHaveLength(1)
    })
    expect(container.querySelector('input[type="file"]')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /画像を追加/ })).not.toBeInTheDocument()
  })

  it("slot='thumbnails' + 空 → null(下の表示専用 slot は空なら DOM 増ゼロ)", () => {
    const { container } = render(
      <CardImageGallery
        images={[]}
        target="question_text"
        cardId={CARD_ID}
        userId={USER_ID}
        slot="thumbnails"
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ⑨ 画像 tap → 全画面モーダル (Task 4)。 64px サムネ本体 tap で useImageZoom.open を
// target 単位の解決済み ZoomImage[] で開く。 layout / a11y / decode / ordinal / startIndex を pin。
// ---------------------------------------------------------------------------
describe('CardImageGallery 画像 tap → zoom modal (Task 4)', () => {
  it('画像 tap → open が target の解決済み ZoomImage[](ordinal 順)+ tap key の startIndex で呼ばれる', async () => {
    mockGetAssetObjectURL.mockImplementation(async (_u: string, key: string) => `blob:${key}`)
    await seedAssetDims(UUID_A, 100, 200)
    await seedAssetDims(UUID_B, 300, 400)
    const images: ClientCardImage[] = [
      { key: UUID_A, target: TARGET, alt: 'アルファ' },
      { key: UUID_B, target: TARGET, alt: 'ベータ' },
    ]
    const { container } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2))

    // 2 番目 (UUID_B) を tap → startIndex は ordinal index の 1。
    fireEvent.click(imageButtons(container)[1]!)

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1))
    const [zoomImages, startIndex] = mockOpen.mock.calls[0]!
    expect(zoomImages).toEqual([
      { src: `blob:${UUID_A}`, width: 100, height: 200, alt: 'アルファ' },
      { src: `blob:${UUID_B}`, width: 300, height: 400, alt: 'ベータ' },
    ])
    expect(startIndex).toBe(1)
  })

  it('別 target の画像は集合外(gallery は target 単位で ZoomImage[] を構築)', async () => {
    mockGetAssetObjectURL.mockImplementation(async (_u: string, key: string) => `blob:${key}`)
    await seedAssetDims(UUID_A, 10, 20)
    await seedAssetDims(UUID_OTHER_TARGET, 30, 40)
    const images: ClientCardImage[] = [
      { key: UUID_A, target: TARGET, alt: '' },
      { key: UUID_OTHER_TARGET, target: 'option:opt-1', alt: '' },
    ]
    const { container } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1))

    fireEvent.click(imageButtons(container)[0]!)

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1))
    const [zoomImages, startIndex] = mockOpen.mock.calls[0]!
    expect(zoomImages).toEqual([{ src: `blob:${UUID_A}`, width: 10, height: 20, alt: '' }])
    expect(startIndex).toBe(0)
  })

  it('loading 中の thumbnail は tap 無効(button 不在・open 未呼)', async () => {
    // getAssetObjectURL を未解決のままにして loading (pulse) 状態を維持する。
    mockGetAssetObjectURL.mockImplementation(() => new Promise<string | null>(() => {}))
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '' }]
    const { container } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeInTheDocument())
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('button', { name: /拡大/ })).not.toBeInTheDocument()
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('失敗 placeholder は tap 無効(再読み込み click でも open 未呼)', async () => {
    mockGetAssetObjectURL.mockResolvedValue(null)
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '' }]
    render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    expect(await screen.findByText('再読み込み')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /拡大/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('再読み込み'))
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('編集面: × 削除は従来どおり removeImageFromCard で、 open は呼ばれない', async () => {
    mockGetAssetObjectURL.mockResolvedValue('blob:x')
    await seedAssetDims(UUID_A, 10, 20)
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '' }]
    const { container } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    await waitFor(() => expect(container.querySelector('img')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '画像を削除' }))

    await waitFor(() => expect(mockRemoveImageFromCard).toHaveBeenCalledTimes(1))
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('画像 button ラップ後も 64px サムネ (h-16 w-16) は不変', async () => {
    mockGetAssetObjectURL.mockResolvedValue('blob:x')
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '' }]
    const { container } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    const img = await waitFor(() => {
      const el = container.querySelector('img')
      if (!el) throw new Error('no img')
      return el
    })
    // <img> の 64px 寸は不変。
    expect(img.className).toContain('h-16')
    expect(img.className).toContain('w-16')
    // ラップ button も 64px box を維持し flex layout を変えない。
    const btn = img.closest('button')!
    expect(btn.className).toContain('h-16')
    expect(btn.className).toContain('w-16')
  })

  it('alt 空でも画像 button にアクセシブルネーム(「画像を拡大」)が付く', async () => {
    mockGetAssetObjectURL.mockResolvedValue('blob:x')
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '' }]
    render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    expect(await screen.findByRole('button', { name: '画像を拡大' })).toBeInTheDocument()
  })

  it('alt ありの画像 button はアクセシブルネームに操作(拡大)を含む(「<alt>を拡大」)', async () => {
    mockGetAssetObjectURL.mockResolvedValue('blob:x')
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '設問の図' }]
    render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    // alt があっても名前は「<alt>を拡大」= 操作を伝える(alt のみだと拡大操作が SR に伝わらない)。
    expect(await screen.findByRole('button', { name: '設問の図を拡大' })).toBeInTheDocument()
  })

  it('mirror dims 無しの兄弟は Image().decode() で naturalWidth/Height を取得する', async () => {
    mockGetAssetObjectURL.mockImplementation(async (_u: string, key: string) => `blob:${key}`)
    await seedAssetDims(UUID_A, 100, 200) // tap 画像は mirror dims あり
    // UUID_B は media_assets 行なし → decode 経路。 Image を stub して naturalWidth/Height を供給。
    const dimsBySrc: Record<string, { w: number; h: number }> = {
      [`blob:${UUID_B}`]: { w: 320, h: 240 },
    }
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        decode(): Promise<void> {
          return Promise.resolve()
        }
        get naturalWidth(): number {
          return dimsBySrc[this.src]?.w ?? 0
        }
        get naturalHeight(): number {
          return dimsBySrc[this.src]?.h ?? 0
        }
      },
    )
    const images: ClientCardImage[] = [
      { key: UUID_A, target: TARGET, alt: 'a' },
      { key: UUID_B, target: TARGET, alt: 'b' },
    ]
    const { container } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2))

    fireEvent.click(imageButtons(container)[0]!)

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1))
    const [zoomImages] = mockOpen.mock.calls[0]!
    expect(zoomImages).toEqual([
      { src: `blob:${UUID_A}`, width: 100, height: 200, alt: 'a' },
      { src: `blob:${UUID_B}`, width: 320, height: 240, alt: 'b' },
    ])
  })

  it('解決不可(getAssetObjectURL=null)の兄弟は集合から除外、 startIndex は tap key で再計算', async () => {
    // ordinal 順は [B(解決不可), A(tap)]。 除外後 A は index 0 (ordinal 1 ではない)。
    mockGetAssetObjectURL.mockImplementation(async (_u: string, key: string) =>
      key === UUID_B ? null : `blob:${key}`,
    )
    await seedAssetDims(UUID_A, 10, 20)
    const images: ClientCardImage[] = [
      { key: UUID_B, target: TARGET, alt: 'b' },
      { key: UUID_A, target: TARGET, alt: 'a' },
    ]
    const { container } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    // A のみ img 描画 (B は失敗 placeholder)。
    await waitFor(() => expect(container.querySelector('img')).toBeInTheDocument())

    fireEvent.click(imageButtons(container)[0]!)

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1))
    const [zoomImages, startIndex] = mockOpen.mock.calls[0]!
    expect(zoomImages).toEqual([{ src: `blob:${UUID_A}`, width: 10, height: 20, alt: 'a' }])
    expect(startIndex).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ⑩ 表示面別回帰 (Task 4)。 gallery は編集 fields / テーブル columns / side-peek /
// 演習 runner に共用される。 host を個別に起動せず、 各 host が渡す prop 組合せ
// (readOnly 閲覧面 / slot='thumbnails' 表示面) で tap 配線 + 64px layout が保たれることを
// gallery 自身の test で pin する。
// ---------------------------------------------------------------------------
describe('CardImageGallery 表示面別 tap 回帰 (Task 4)', () => {
  it('readOnly 閲覧面 (テーブル/side-peek/演習): 画像 tap→open 有効・× 削除は無し・tap で button に focus (iOS focus 復帰)', async () => {
    mockGetAssetObjectURL.mockResolvedValue('blob:x')
    await seedAssetDims(UUID_A, 10, 20)
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '' }]
    const { container } = render(
      <CardImageGallery
        images={images}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
        readOnly
      />,
    )
    const btn = await waitFor(() => {
      const b = imageButtons(container)[0]
      if (!b) throw new Error('image button not rendered yet')
      return b
    })

    fireEvent.click(btn)
    // onClick が open 前に e.currentTarget.focus() を呼ぶ → tap した button が activeElement。
    // hook はこれを focus-return trigger として捕捉するため iOS でも復帰先が確実になる。
    expect(document.activeElement).toBe(btn)
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: '画像を削除' })).not.toBeInTheDocument()
  })

  it("slot='thumbnails' 表示面 (編集 fields の表示 slot): 画像 tap→open 有効・h-16 w-16 不変", async () => {
    mockGetAssetObjectURL.mockResolvedValue('blob:x')
    await seedAssetDims(UUID_A, 10, 20)
    const images: ClientCardImage[] = [{ key: UUID_A, target: 'question_text', alt: '' }]
    const { container } = render(
      <CardImageGallery
        images={images}
        target="question_text"
        cardId={CARD_ID}
        userId={USER_ID}
        slot="thumbnails"
      />,
    )
    const btn = await waitFor(() => {
      const b = imageButtons(container)[0]
      if (!b) throw new Error('image button not rendered yet')
      return b
    })
    expect(btn.className).toContain('h-16')
    expect(btn.className).toContain('w-16')

    fireEvent.click(btn)
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1))
  })
})
