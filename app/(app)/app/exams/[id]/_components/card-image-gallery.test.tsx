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
  mockPeekAssetObjectURL,
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
  mockPeekAssetObjectURL: vi.fn(),
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
  peekAssetObjectURL: mockPeekAssetObjectURL,
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
  // 兄弟は openModal で同期 peek される(実コードでは各 thumbnail の解決で objectUrlCache に
  // 載るため tap 時には解決済み)。既定は「解決済み(blob:<key>)」を返す(未解決兄弟を検証する
  // test は個別に null を返させる)。tap 画像は getAssetObjectURL 経路ゆえ peek 既定と独立。
  mockPeekAssetObjectURL.mockImplementation((_u: string, key: string) => `blob:${key}`)
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
  it('× click → removeImageFromCard({userId, cardId, assetId}) が呼ばれ、 abandonUpload / runOptimisticUpdate は使わない (直列化+fresh-read 経路)', async () => {
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
    // 削除する asset は 1 つ目 (UUID_A)。 removeImageFromCard は owner + cardId + assetId
    // のみ受ける (fresh-read + 直列化は upload.ts 側。 gallery は snapshot を渡さない)。
    expect(mockRemoveImageFromCard).toHaveBeenCalledWith({
      userId: USER_ID,
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

  it('未解決の兄弟(peek=null)は集合から除外、 startIndex は tap key で再計算', async () => {
    // ordinal 順は [B(未解決), A(tap)]。 除外後 A は index 0 (ordinal 1 ではない)。
    // B は解決不可 → thumbnail は failed placeholder(getAssetObjectURL=null)、 かつ objectUrlCache
    // 未登録ゆえ openModal の兄弟 peek も null → 集合から除外(spec §3.6「未解決は除外」)。
    mockGetAssetObjectURL.mockImplementation(async (_u: string, key: string) =>
      key === UUID_B ? null : `blob:${key}`,
    )
    mockPeekAssetObjectURL.mockImplementation((_u: string, key: string) =>
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

  it('未解決兄弟の解決を待たず tap 画像で即 open(開扉ブロック防止・spec §3.6 / Codex whole-branch P2)', async () => {
    // B は in-flight(解決しない): getAssetObjectURL(B) は resolve しない promise、 peek(B)=null
    //(未 cache)。 openModal が兄弟を getAssetObjectURL で解決していたら B の未解決 fetch を await し
    // 最大 FETCH_TIMEOUT_MS ブロックする(→ mockOpen 未呼で waitFor timeout=discriminating)。
    // peek 経路なら未解決 B を除外し tap 画像 A で即 open する。
    let resolveB: (v: string | null) => void = () => {}
    mockGetAssetObjectURL.mockImplementation(async (_u: string, key: string) => {
      if (key === UUID_A) return `blob:${UUID_A}`
      return new Promise<string | null>((r) => {
        resolveB = r // B は永久 pending(in-flight download 相当)
      })
    })
    mockPeekAssetObjectURL.mockImplementation((_u: string, key: string) =>
      key === UUID_A ? `blob:${UUID_A}` : null,
    )
    await seedAssetDims(UUID_A, 10, 20)
    const images: ClientCardImage[] = [
      { key: UUID_A, target: TARGET, alt: 'a' },
      { key: UUID_B, target: TARGET, alt: 'b' },
    ]
    const { container } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    // A のみ img 描画(B は永久 loading skeleton)。
    await waitFor(() => expect(container.querySelector('img')).toBeInTheDocument())

    fireEvent.click(imageButtons(container)[0]!) // A

    // B の未解決を await せず A のみで即 open(ブロックしていたら timeout する)。
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1))
    const [zoomImages, startIndex] = mockOpen.mock.calls[0]!
    expect(zoomImages).toEqual([{ src: `blob:${UUID_A}`, width: 10, height: 20, alt: 'a' }])
    expect(startIndex).toBe(0)
    resolveB(null) // dangling promise を解放
  })

  it('解決中にカードが進んだら旧カードの画像で open しない(session-runner 再利用の stale open 防止・Codex whole-branch P2)', async () => {
    // A の thumbnail は解決(tappable)、 openModal 内の getAssetObjectURL(A) は保留させる。
    // 保留中に cardId を変えて再 render(カード送り = 同 position gallery 再利用で hook は mount のまま)
    // → 解放後も stale guard(現行 card != 起動時 card)で open されない。 guard 無しなら open が呼ばれ
    // る=discriminating。
    let callCount = 0
    let resolveOpen: (v: string | null) => void = () => {}
    mockGetAssetObjectURL.mockImplementation(async (_u: string, key: string) => {
      if (key !== UUID_A) return null
      callCount += 1
      // 1 回目 = thumbnail mount(解決 → tappable)、 2 回目 = openModal(保留)。
      if (callCount === 1) return `blob:${UUID_A}`
      return new Promise<string | null>((r) => {
        resolveOpen = r
      })
    })
    await seedAssetDims(UUID_A, 10, 20)
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: 'a' }]
    const { container, rerender } = render(
      <CardImageGallery images={images} target={TARGET} cardId={CARD_ID} userId={USER_ID} />,
    )
    const btn = await waitFor(() => {
      const b = imageButtons(container)[0]
      if (!b) throw new Error('image button not rendered yet')
      return b
    })

    fireEvent.click(btn) // openModal 開始 → getAssetObjectURL(A) 2 回目 = 保留

    // 解決中にカードが進む(cardId 変化 → latestCardRef 更新)。
    rerender(
      <CardImageGallery images={images} target={TARGET} cardId="card-next" userId={USER_ID} />,
    )

    resolveOpen(`blob:${UUID_A}`) // openModal 継続 → stale guard で return

    // openModal の残り(dims 読み + guard)を flush してから open 未呼を確認。
    await new Promise((r) => setTimeout(r, 10))
    expect(mockOpen).not.toHaveBeenCalled()
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

// ---------------------------------------------------------------------------
// ⑪ display='inflow' (Task 5): 演習 in-flow 大きめ表示。単一(===1)は幅100%画像 +
// 縦長畳み(computeFold 実関数)、複数(>=2)は 128px タイル wrap(畳みなし)。
//
// jsdom は CSS `min(70svh,44rem)` の computed px や実 layout 幅を解決できない。畳み分岐は
// capPx(実装が読む measure.clientHeight = used max-height の px 値)/ renderedWidthPx
// (wrapper.clientWidth)を注入して computeFold 実関数を通す(実 CSS↔JS 一致は smoke で担保・
// Codex 独立12)。computeFold は mock せず実関数(renderedHeightPx = renderedWidthPx * naturalHeight
// / naturalWidth)。
// ---------------------------------------------------------------------------
describe("CardImageGallery display='inflow' (Task 5)", () => {
  // capPx(実装が読む measure.clientHeight = used max-height の px 値)と renderedWidthPx
  // (wrapper.clientWidth)を注入する。実装は capPx を getComputedStyle().maxHeight ではなく
  // measure.clientHeight で読む(iOS Safari が maxHeight に式文字列を返し parseFloat→NaN で畳みが
  // 永久 no-op 化するのを避けた robustness fix)。jsdom は layout しないため clientHeight/clientWidth は
  // 既定 0。clientWidth と clientHeight は別プロパティゆえ衝突せず、prototype getter として両方生やす。
  // recomputeFold は wrapper.clientWidth と measure.clientHeight のみ読むため、この 2 getter で
  // computeFold 実関数へ実数を通せる。
  function stubLayout(capPx: number, renderedWidthPx: number): void {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => renderedWidthPx,
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => capPx,
    })
  }

  afterEach(() => {
    // prototype に生やした clientWidth/clientHeight override を除去(jsdom 既定 = 0 に戻す)。
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  })

  it('単一 inflow・縦長 dims → 畳み時は「全体を見る」pill(pointer-events-none・視覚合図のみ)を表示・独立ボタンは無し・画像 button tap→open', async () => {
    // capPx=400, renderedWidthPx=400。縦長 400x1200 → renderedHeightPx=1200 > 448 → fold=true。
    stubLayout(400, 400)
    mockGetAssetObjectURL.mockResolvedValue('blob:tall')
    await seedAssetDims(UUID_A, 400, 1200)
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '縦長図' }]
    const { container } = render(
      <CardImageGallery
        images={images}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
        readOnly
        display="inflow"
      />,
    )
    // 「全体を見る」pill(縦幅を食わない畳み表示 fix の中心保証)。装飾のみ = aria-hidden +
    // pointer-events-none。旧実装(独立ブロックボタン)にはこの要素が存在しないため、この
    // assert は旧コードで findByTestId が timeout して fail する(red 確認済)。
    const pill = await screen.findByTestId('inflow-fold-pill')
    expect(pill).toHaveTextContent('全体を見る')
    expect(pill.getAttribute('aria-hidden')).toBe('true')
    expect(pill.className).toContain('pointer-events-none')
    // pill 自体が absolute 配置であること(縦幅増分ゼロ保証の直接 pin)。DOM nesting
    // (clip.contains(pill))だけでは in-flow static 化(52px フロー回帰)を検知できないため、
    // position クラスを明示的に assert する(canonical review Important 指摘)。
    expect(pill.className).toContain('absolute')
    // clip wrapper = <img> の最近接 div(overflow-hidden + max-h クラス)。pill は clip wrapper の
    // 内側(フェード領域への重ね)= wrapper.contains(pill) で縦幅を消費しない配置を確認。
    const img = container.querySelector('img')!
    const clip = img.closest('div')!
    expect(clip.className).toContain('overflow-hidden')
    expect(clip.className).toContain('max-h-[min(70svh,44rem)]')
    expect(clip.contains(pill)).toBe(true)
    // フェード overlay(gradient・pointer-events-none)
    expect(container.querySelector('.pointer-events-none.bg-gradient-to-t')).toBeInTheDocument()
    // inflow は full-width(64px サムネではない)
    expect(img.className).not.toContain('h-16')
    expect(img.className).toContain('w-full')
    // 独立ブロックボタン(旧 mt-2 + min-h-11 = 52px 占有)は廃止 = 画像 button のみで button は
    // ちょうど 1 個。旧コードは image button + 独立ボタンの 2 個描画するため、この assert は
    // 旧コードで fail する(red 確認済)。
    expect(screen.getAllByRole('button')).toHaveLength(1)
    // 唯一のキーボード起動口(画像 button)の aria-label が畳み状態で「全体を見る」意図を伝える。
    // 旧コードは常に「<alt>を拡大」固定でこの文言を含まないため、この assert は旧コードで
    // fail する(red 確認済)。
    const imgBtn = img.closest('button')!
    expect(imgBtn.getAttribute('aria-label')).toContain('全体を見る')
    // 畳み時は wrapper が overflow-hidden + button 下端が fold 下端より下に伸びるため、外側
    // outline(outline-offset)は clip されて不可視になる(Codex P2 a11y 回帰)。inset ring は
    // button 自身の border-box 内側に描画され clip されない。旧コードは outline-offset-1 の
    // ままのため、この assert は旧コードで fail する(red 確認済)。
    expect(imgBtn.className).toContain('ring-inset')
    // 画像 button tap → 同一 openModal 経路で open が呼ばれる(タップは画像 button に委譲)。
    fireEvent.click(imgBtn)
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1))
  })

  it('単一 inflow・横長 dims → 畳まない(pill 不在・clip なし・フェードなし = 全高表示)', async () => {
    // capPx=400, renderedWidthPx=400。横長 800x100 → renderedHeightPx=50 < 448 → fold=false。
    stubLayout(400, 400)
    mockGetAssetObjectURL.mockResolvedValue('blob:wide')
    await seedAssetDims(UUID_A, 800, 100)
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '横長図' }]
    const { container } = render(
      <CardImageGallery
        images={images}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
        readOnly
        display="inflow"
      />,
    )
    // 任意 setTimeout(flaky)を排し、mirror dims(width=800)が img に乗る = fold 判定材料が
    // 揃い computeFold が走った deterministic 信号を待つ(横長ゆえ fold は false のまま)。
    const img = await waitFor(() => {
      const el = container.querySelector('img') as HTMLImageElement | null
      if (!el || el.getAttribute('width') !== '800') throw new Error('mirror dims not applied yet')
      return el
    })
    // fold=false は pill(視覚合図)を出さない(fold ガード踏襲)。
    expect(screen.queryByTestId('inflow-fold-pill')).not.toBeInTheDocument()
    const clip = img.closest('div')!
    // fold=false は max-height/overflow-hidden clip を当てない(silent-clip bug 防止)。
    expect(clip.className).not.toContain('overflow-hidden')
    expect(clip.className).not.toContain('max-h-')
    expect(container.querySelector('.bg-gradient-to-t')).not.toBeInTheDocument()
    expect(img.className).toContain('w-full')
    // 画像 button のみ(button は 1 個)・aria-label は非畳み文言(「全体を見る」を含まない)。
    expect(screen.getAllByRole('button')).toHaveLength(1)
    const imgBtn = img.closest('button')!
    expect(imgBtn.getAttribute('aria-label')).toBe('横長図を拡大')
  })

  it('単一 inflow・dims 未取得 → 初期は畳まず、onLoad の naturalWidth/Height(縦長)で再評価して畳む', async () => {
    // media_assets に seed しない = mirror dims 無し。onLoad で natural を stub 供給。
    stubLayout(400, 400)
    mockGetAssetObjectURL.mockResolvedValue('blob:unknown')
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '' }]
    const { container } = render(
      <CardImageGallery
        images={images}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
        readOnly
        display="inflow"
      />,
    )
    const img = await waitFor(() => {
      const el = container.querySelector('img')
      if (!el) throw new Error('no img yet')
      return el as HTMLImageElement
    })
    // dims 未取得 → 初期は畳まない
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('inflow-fold-pill')).not.toBeInTheDocument()
    // onLoad で縦長 natural(400x1200)供給 → computeFold 再評価で畳む
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 400 })
    Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1200 })
    fireEvent.load(img)
    expect(await screen.findByTestId('inflow-fold-pill')).toBeInTheDocument()
  })

  // ResizeObserver wiring(P2 fix): recomputeFold は wrapper.clientWidth と measure.clientHeight
  // を読むが、measure.clientHeight(= capPx = min(70svh,44rem))は viewport 高さ変化(desktop 縦
  // リサイズ等)で wrapper 幅不変のまま変わる。よって RO は wrapper だけでなく measure も observe
  // しなければ、その変化で recomputeFold が呼ばれず fold が stale になる。RO の発火は jsdom no-op
  // stub で unit 検証不能だが、observe 配線(どの element を渡すか)は検証できる。
  // ro.observe(measure) を外すと measure が observed 集合に入らず本 test は FAIL する(discriminating)。
  it('単一 inflow: ResizeObserver は wrapper と measure の両方を observe する(viewport 高さ変化追従)', async () => {
    const observed: Element[] = []
    // 記録専用 stub(disconnect/unobserve は no-op 維持・observe だけ記録)。
    vi.stubGlobal(
      'ResizeObserver',
      class RecordingResizeObserver {
        observe(el: Element): void {
          observed.push(el)
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    mockGetAssetObjectURL.mockResolvedValue('blob:ro')
    await seedAssetDims(UUID_A, 400, 1200)
    const images: ClientCardImage[] = [{ key: UUID_A, target: TARGET, alt: '' }]
    const { container } = render(
      <CardImageGallery
        images={images}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
        readOnly
        display="inflow"
      />,
    )
    const img = await waitFor(() => {
      const el = container.querySelector('img')
      if (!el) throw new Error('inflow img not rendered yet')
      return el
    })
    // wrapper = <img> の最近接 div(ref=wrapperRef)。measure = 唯一の .w-0 div(ref=measureRef・
    // 幅 0 の測定要素。内側 spacer は .w-px ゆえ .w-0 は measure に一意)。
    const wrapper = img.closest('div')!
    const measure = container.querySelector('.w-0')!
    expect(wrapper).not.toBe(measure)
    // observed に wrapper と measure の両方が入る(effect は複数回走りうるが同一 element instance)。
    expect(observed).toContain(wrapper)
    expect(observed).toContain(measure)
    expect(new Set(observed).size).toBeGreaterThanOrEqual(2)
  })

  it('複数 inflow(2 枚)→ 128px タイル flex-wrap・畳みラッパー不在・各タイル tap→open', async () => {
    mockGetAssetObjectURL.mockImplementation(async (_u: string, key: string) => `blob:${key}`)
    await seedAssetDims(UUID_A, 100, 200)
    await seedAssetDims(UUID_B, 300, 400)
    const images: ClientCardImage[] = [
      { key: UUID_A, target: TARGET, alt: 'a' },
      { key: UUID_B, target: TARGET, alt: 'b' },
    ]
    const { container } = render(
      <CardImageGallery
        images={images}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
        readOnly
        display="inflow"
      />,
    )
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2))
    // 複数は畳まない(CardImageInflowTile は fold を持たない)= pill 不在
    expect(screen.queryByTestId('inflow-fold-pill')).not.toBeInTheDocument()
    // 128px タイル(h-32 w-32)・object-cover・flex-wrap コンテナ
    const imgs = Array.from(container.querySelectorAll('img'))
    imgs.forEach((im) => {
      expect(im.className).toContain('h-32')
      expect(im.className).toContain('object-cover')
    })
    expect(container.querySelector('.flex.flex-wrap')).toBeInTheDocument()
    // 各タイル tap → 同一 openModal 経路
    fireEvent.click(imageButtons(container)[0]!)
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1))
    fireEvent.click(imageButtons(container)[1]!)
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2))
  })

  // key regression(Critical): 演習で次カードへ進むと同 position の inflow single が再利用され
  // (key 不在時)useAssetObjectUrl の url / dims が前 asset のまま残留する。mirror row 無しの
  // 新 asset では dims が更新されず旧 dims が居座り fold 誤り + 旧画像残像になる。key で asset
  // ごとに remount して state を rest することを、別 key・mirror row 無しの B へ rerender して pin。
  // (key を外すと B の img に A の url/dims が残り、下の 2 assert が FAIL する = discriminating)
  it('単一 inflow: 別 key の asset へ rerender すると state を rest する(前 asset の url / dims を引き継がない・mirror row 無し)', async () => {
    // A = url:blob:A + mirror dims(400x1200)。B = 別 key・url:blob:B・mirror row 無し。
    mockGetAssetObjectURL.mockImplementation(async (_u: string, key: string) =>
      key === UUID_A ? 'blob:A' : 'blob:B',
    )
    await seedAssetDims(UUID_A, 400, 1200)
    // B は seedAssetDims しない = media_assets mirror row 無し(新 asset で dims が空になる経路)。

    const { container, rerender } = render(
      <CardImageGallery
        images={[{ key: UUID_A, target: TARGET, alt: 'A' }]}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
        readOnly
        display="inflow"
      />,
    )
    // A が解決 → img(src=blob:A)+ A の mirror dims(width=400/height=1200)が乗る。
    const imgA = await waitFor(() => {
      const el = container.querySelector('img') as HTMLImageElement | null
      if (!el || el.getAttribute('src') !== 'blob:A' || el.getAttribute('width') !== '400') {
        throw new Error('A not resolved with dims yet')
      }
      return el
    })
    expect(imgA.getAttribute('height')).toBe('1200')

    // 別 key の B(mirror row 無し)へ rerender = 演習の次カード相当。
    rerender(
      <CardImageGallery
        images={[{ key: UUID_B, target: TARGET, alt: 'B' }]}
        target={TARGET}
        cardId={CARD_ID}
        userId={USER_ID}
        readOnly
        display="inflow"
      />,
    )
    // B の img(src=blob:B)が乗るのを待つ。
    const imgB = await waitFor(() => {
      const el = container.querySelector('img') as HTMLImageElement | null
      if (!el || el.getAttribute('src') !== 'blob:B') throw new Error('B not resolved yet')
      return el
    })
    // key で remount → dims は fresh(null)。B は mirror row 無しゆえ width/height 属性が付かない。
    // key を外すと同一 instance が A の dims(400/1200)を保持し B の img に旧 dims が居座る = FAIL。
    expect(imgB.getAttribute('width')).toBeNull()
    expect(imgB.getAttribute('height')).toBeNull()
  })
})
