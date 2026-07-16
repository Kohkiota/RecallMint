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
} = vi.hoisted(() => ({
  mockAttachImageToCard: vi.fn(),
  mockAbandonUpload: vi.fn(),
  mockRemoveImageFromCard: vi.fn(async () => undefined),
  mockGetAssetObjectURL: vi.fn(),
  mockReserveAsset: vi.fn(),
  mockFinalizeAsset: vi.fn(),
  mockResolveAssetUrls: vi.fn(),
  mockReclaimLocalAssetBlobs: vi.fn(async () => undefined),
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
// getClientDb().media_assets.get(key) の best-effort width/height 読み取りは
// 未定義でも壊れないよう、 undefined を返す最小 stub にする(本 test の主眼は
// gallery の filter / attach / delete / placeholder 挙動であり mirror の
// media_assets 内容そのものではないため)。
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

import { CardImageGallery } from './card-image-gallery'

const USER_ID = 'user-gallery-test'
const CARD_ID = 'card-gallery-test'
const TARGET = 'question_text'

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UUID_OTHER_TARGET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LEGACY_KEY = 'img-1'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAssetObjectURL.mockResolvedValue('blob:mock-object-url')
})

afterEach(() => {
  cleanup()
})

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
