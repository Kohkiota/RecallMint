// upload saga client — 添付画像の圧縮 → reserve → 楽観層 → 直 PUT → finalize を配線する
// (画像フェーズ A Task 8 / spec §3.1・§3.4)。
//
// Client-only: `getClientDb()` (Dexie) / Cache API / server action の呼び出しを含むため
// client 側 (component / handler) から呼ばれる前提。 RSC からの import は `getClientDb`
// が server で throw する設計で防御する (`@/lib/sync/optimistic-mutation` と同 convention、
// 'use client' directive は付けず banner で示す)。
//
// 設計 (spec §3.1 正常系 / §3.4 失敗 end-state):
// - compressForAttach: 入口 gate (MIME + 拡張子) → browser-image-compression →
//   実 MIME = 出力 blob.type (Safari は webp 不可で silent PNG。 blob.type を信頼) →
//   圧縮後 blob を createImageBitmap で decode し width/height (EXIF 焼込後) →
//   SHA-256 hex hash。 decode / 圧縮失敗 (非 Error reject 含む) は Error に正規化して throw。
// - attachImageToCard: 圧縮 → reserve → 楽観層 (Cache put + media_assets 'uploading' +
//   mirror/outbox) → 直 PUT → finalize → media_assets 'ready' + flush trigger。
//   各失敗点は spec §3.4 の end-state に対応する code を返す (INVALID_TYPE /
//   COMPRESS_FAILED / RESERVE_FAILED / UPLOAD_FAILED / FINALIZE_FAILED)。
//   PUT / finalize 失敗時は abandonUpload で楽観層を巻き戻す (放棄 = clean end-state)。
// - abandonUpload: mirror entry 除去 (runOptimisticUpdate) + Cache delete + media_assets
//   delete。 server の 'reserved' 行は無害 orphan として残す (手動掃除・spec §3.4)。
//
// retry 方針 (spec §3.4): PUT/finalize 失敗時は「放棄 (abandon)」を clean end-state と
// する。 再試行は新規 attachImageToCard 呼び出し (fresh reserve = 新 assetId) で行い、
// in-place の re-reserve / 再 PUT は本 module では実装しない (saga の検証面を 1 経路に
// 保つ・spec §3.4 の「放棄時」列に準拠)。
//
// server action は dependency injection で受ける (import しない): `reserveAsset` /
// `finalizeAsset` は app/ layer の server action (`app/(app)/app/exams/[id]/_actions/
// asset-actions.ts`) だが、 ESLint Block A が `lib/` → `app/` import を禁ずる。
// canonical な解決は「注入」(eslint.config.mjs Block A' の "inject ... instead" 前例、
// P4 W5)。 呼出側の client component が実 action を import して `attachImageToCard` に
// 渡す。 これで file を lib/ に保ちつつ既 commit の action に触れず境界も守る。

import imageCompression from 'browser-image-compression'
import type { ActionResult } from '@/lib/actions/result'
import { getClientDb, type ClientCardImage } from '@/lib/client-db'
import { runOptimisticUpdate } from '@/lib/sync/optimistic-mutation'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { putAssetBlob, deleteAssetBlob } from '@/lib/media/cache'

// ---------------------------------------------------------------------------
// 型・定数
// ---------------------------------------------------------------------------

export type AttachErrorCode =
  | 'TOO_MANY_IMAGES'
  | 'INVALID_TYPE'
  | 'COMPRESS_FAILED'
  | 'RESERVE_FAILED'
  | 'UPLOAD_FAILED'
  | 'FINALIZE_FAILED'

// 1 card の画像上限。 server imagesSchema.max(10) と一致させる。 これを超える添付は
// reserve/upload 前に弾く (超えると server が images mutation を reject し、 local だけ
// 増えて sync できない ready asset の orphan が残るため)。
const MAX_IMAGES_PER_CARD = 10

export type CompressResult = {
  blob: Blob
  mime: string
  width: number
  height: number
  hash: string
}

export type AttachResult =
  | { ok: true; assetId: string }
  | { ok: false; code: AttachErrorCode }

// 注入する server action の構造型 (実 action の signature に一致。 app/ layer を import
// しないため lib/ 側で構造的に定義する。 呼出側は実 action をそのまま渡せる)。
export type ReserveAssetFn = (input: {
  mime: string
  byteSize: number
  width: number
  height: number
  hash: string
}) => Promise<ActionResult<{ assetId: string; uploadUrl: string }>>

export type FinalizeAssetFn = (assetId: string) => Promise<ActionResult>

// 注入 deps。 呼出側 (client component) が実 action を渡す。
export type AttachDeps = {
  reserveAsset: ReserveAssetFn
  finalizeAsset: FinalizeAssetFn
}

// 受付 MIME / 拡張子 (spec §3.1 / 前提 10: jpg/jpeg/png/webp のみ)。
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
const ACCEPTED_EXT = new Set(['jpg', 'jpeg', 'png', 'webp'])

// 圧縮 options (spec §4 / 論点 3 確定。値は verbatim・変更禁止)。
const COMPRESSION_OPTIONS = {
  maxWidthOrHeight: 1600,
  fileType: 'image/webp',
  initialQuality: 0.8,
  maxSizeMB: 1,
  useWebWorker: true,
} as const

// browser-image-compression の worker が importScripts するライブラリ本体を self-host する
// (spec §4 訂正)。 既定は jsDelivr CDN だが、 CSP allowlist に CDN を足さない最小権限方針
// ゆえアプリ内配置 (public/vendor/) を参照する。 vendored file は package と同版を drift test
// で pin。 worker は blob: origin ゆえ root-relative では解決できず絶対 URL が要る。 module
// 評価時 (SSR import) は window 不在ゆえ、 実際に呼ぶ browser 文脈でのみ絶対化する。
const COMPRESSION_LIB_PATH = '/vendor/browser-image-compression.js'
function compressionLibURL(): string {
  return typeof window !== 'undefined'
    ? new URL(COMPRESSION_LIB_PATH, window.location.origin).href
    : COMPRESSION_LIB_PATH
}

// 直 PUT の timeout。 外部 fetch は AbortSignal.timeout 必須の repo 慣習 (lib/storage/r2.ts
// の HEAD=10s / lib/ops.ts=3s 等) に倣う。 hang した PUT が saga を無限に止め、 held
// mutation を release できなくなるのを防ぐ。 body は圧縮後 ≤1MiB ゆえ 60s で十分な余裕
// (bytes 転送ゆえ R2 HEAD の 10s より長め)。
const PUT_TIMEOUT_MS = 60_000

// 入口 gate 違反を圧縮失敗と区別するための tagged Error (attachImageToCard が
// INVALID_TYPE / COMPRESS_FAILED を出し分けるのに使う)。
class InvalidImageTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidImageTypeError'
  }
}

// ---------------------------------------------------------------------------
// compressForAttach
// ---------------------------------------------------------------------------

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  // 拡張子なし (dot が無い / 末尾) は空文字 → 受付集合に含まれず reject される。
  if (dot <= 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toLowerCase()
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 添付画像を圧縮し、 reserve に渡すメタ (実 MIME / 寸法 / hash) を算出する。
 *
 * - 入口 gate: `file.type` ∈ {jpeg, png, webp} かつ拡張子 ∈ {jpg,jpeg,png,webp}。
 *   不一致 (空 MIME 含む) は `InvalidImageTypeError` を throw (呼出側で INVALID_TYPE 化)。
 * - 実 MIME = 出力 `blob.type` (Safari は webp 不可で silent PNG。 webp を仮定しない)。
 * - width/height = 圧縮後 blob を `createImageBitmap` で decode した値 (EXIF orientation
 *   焼込後の寸法)。 bitmap は close する。
 * - 圧縮 / decode 失敗 (lib の非 Error reject を含む) は Error に正規化して throw。
 */
export async function compressForAttach(file: File): Promise<CompressResult> {
  // 入口 gate (silent 破壊禁止 = 前提 10)。
  if (!ACCEPTED_MIME.has(file.type) || !ACCEPTED_EXT.has(extensionOf(file.name))) {
    throw new InvalidImageTypeError(
      `unsupported image: type=${file.type || '(empty)'} name=${file.name}`,
    )
  }

  let blob: Blob
  try {
    // libURL は self-host 版を呼出時に絶対 URL 化して渡す (COMPRESSION_OPTIONS の値は不変)。
    blob = await imageCompression(file, {
      ...COMPRESSION_OPTIONS,
      libURL: compressionLibURL(),
    })
  } catch (err) {
    // lib は decode 失敗時に非 Error (Event 様) で reject しうる → Error に正規化。
    throw normalizeError(err, 'image compression failed')
  }

  // 実 MIME はデータ駆動 (出力 blob.type)。 Safari = image/png。
  const mime = blob.type

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch (err) {
    throw normalizeError(err, 'image decode failed')
  }
  const { width, height } = bitmap
  // ImageBitmap.close は環境により無い場合がある (defensive、 通常は存在)。
  bitmap.close?.()

  const hash = await sha256Hex(blob)

  return { blob, mime, width, height, hash }
}

// 非 Error reject (browser-image-compression / createImageBitmap が投げうる Event 等)
// を Error instance に正規化する (既存 guard パターン踏襲)。
function normalizeError(err: unknown, fallbackMessage: string): Error {
  if (err instanceof Error) return err
  return new Error(fallbackMessage)
}

// ---------------------------------------------------------------------------
// attachImageToCard (saga)
// ---------------------------------------------------------------------------

// 同一 card への attach/abandon を直列化する in-memory chain。 複数の attach が同じ
// stale な currentImages snapshot から full-array-replace すると、 後発が先発の追加を
// 上書きして asset が card から消える (ready orphan 化する) — これを防ぐ。 card ごとに
// 直前の操作を await してから実行し、 各操作は mirror の最新 images を読んで append/remove
// する (fresh read + 直列化で lost-update を排除)。 別 card 同士は key が違うので並行のまま。
// entry は card ごとに上書きするだけで evict しない (意図的): tab session 中に触った
// distinct card 数ぶんの settled Promise が残るのみ (無視できる量) で、 安全な evict には
// tail の identity check が要り複雑さに見合わないため置かない。
const cardImageOpChains = new Map<string, Promise<unknown>>()

function serializePerCard<T>(cardId: string, op: () => Promise<T>): Promise<T> {
  const prev = cardImageOpChains.get(cardId) ?? Promise.resolve()
  // prev の失敗は後続に伝播させない (catch で握ってから連結)。
  const next = prev.then(op, op)
  // chain 追跡用の tail も失敗を握る (Map に reject 済 promise を残さない)。
  cardImageOpChains.set(
    cardId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

// mirror の最新 card.images を読む (row 不在時は fallback)。 直列化区間内で呼び、
// stale snapshot でなく最新値に対して append/remove する。
async function readCardImages(
  cardId: string,
  fallback: ClientCardImage[],
): Promise<ClientCardImage[]> {
  const row = await getClientDb().cards.get(cardId)
  const images = row?.images
  // stale / 旧 schema row では images が undefined / 非配列でありうる。 append (spread) や
  // remove (filter) が "not iterable" で throw するのを防ぎ、 常に配列を返す (Codex 指摘)。
  if (Array.isArray(images)) return images
  return Array.isArray(fallback) ? fallback : []
}

// mirror images 更新 (runOptimisticUpdate) を共通化する。 append / remove 両方が
// 「配列全置換 + 対応 mutation」 の同型ゆえ 1 箇所に閉じる。
//
// flush timing は saga が明示制御する (append 直後の flush gate は Task 7 が
// 'uploading' の間 held するため、 helper 内蔵の即時 flush を skip し、 saga が
// finalize→ready 後 / abandon 後に自前で trigger する)。
async function commitImages(
  cardId: string,
  before: ClientCardImage[],
  after: ClientCardImage[],
): Promise<void> {
  await runOptimisticUpdate({
    store: getClientDb().cards,
    rowKey: cardId,
    beforeValue: { images: before },
    afterPatch: { images: after },
    mutation: {
      entity_type: 'card',
      entity_id: cardId,
      op: 'update_field',
      patch: { field: 'images', value: after },
    },
    logEvent: 'media.attach',
    logContext: { cardId },
    // mirror 失敗を saga に surface させる (楽観層破綻を握り潰さない)。
    throwOnError: true,
    // flush timing は saga 側で制御 (下記 comment 参照)。
    skipInternalFlush: true,
  })
}

/**
 * 添付 saga: 圧縮 → reserve → 楽観層 → 直 PUT → finalize。
 *
 * 失敗点 → code のマッピング (spec §3.4):
 * - 受付外 MIME/拡張子              → INVALID_TYPE  (何も書かれない)
 * - 圧縮 / decode 失敗              → COMPRESS_FAILED (何も書かれない)
 * - reserve ok:false (offline 含む) → RESERVE_FAILED (何も書かれない)
 * - PUT !ok / throw                → UPLOAD_FAILED  (abandon で楽観層巻戻し)
 * - finalize ok:false              → FINALIZE_FAILED (abandon で楽観層巻戻し)
 *
 * 成功時: media_assets を 'ready' 化 + flush trigger (held mutation を流す) →
 * `{ ok: true, assetId }`。
 *
 * `deps` に `reserveAsset` / `finalizeAsset` (app/ layer の server action) を注入する
 * (Block A boundary 回避。 呼出側 client component が実 action を渡す)。
 */
export async function attachImageToCard(
  p: {
    userId: string
    cardId: string
    target: string
    file: File
    currentImages: ClientCardImage[]
  },
  deps: AttachDeps,
): Promise<AttachResult> {
  // 同一 card への並行 attach を直列化する (fresh read と併せ lost-update を排除)。
  // 別 card は key が異なるため並行のまま。
  return serializePerCard(p.cardId, () => attachImageToCardInner(p, deps))
}

async function attachImageToCardInner(
  p: {
    userId: string
    cardId: string
    target: string
    file: File
    currentImages: ClientCardImage[]
  },
  deps: AttachDeps,
): Promise<AttachResult> {
  const { userId, cardId, target, file } = p
  const { reserveAsset, finalizeAsset } = deps

  // 直列化区間内で mirror の最新 images を読む (caller の snapshot は row 不在時の fallback)。
  // これにより先行 attach の追加を踏まえた append となり、 上書き (lost-update) を防ぐ。
  const currentImages = await readCardImages(cardId, p.currentImages)

  // 0. 上限 pre-check (fresh 値で authoritative。 server imagesSchema.max(10) と一致)。
  //    超過は reserve/圧縮前に弾く (超えて upload すると server が mutation を reject し、
  //    ready asset の orphan と sync 不能な local entry が残る)。
  if (currentImages.length >= MAX_IMAGES_PER_CARD) {
    return { ok: false, code: 'TOO_MANY_IMAGES' }
  }

  // 1. 圧縮 (入口 gate 込み)。 gate 違反 = INVALID_TYPE、 それ以外 = COMPRESS_FAILED。
  let compressed: CompressResult
  try {
    compressed = await compressForAttach(file)
  } catch (err) {
    if (err instanceof InvalidImageTypeError) {
      return { ok: false, code: 'INVALID_TYPE' }
    }
    return { ok: false, code: 'COMPRESS_FAILED' }
  }

  // 2. reserve (offline / 検証失敗 → 何も書かない)。 client からの server action 呼び出しは
  //    transport 失敗で reject しうるため try/catch し、 reject も RESERVE_FAILED に落とす
  //    (Promise<AttachResult> 契約: throw を saga 外に漏らさない)。
  let reserved: ActionResult<{ assetId: string; uploadUrl: string }>
  try {
    reserved = await reserveAsset({
      mime: compressed.mime,
      byteSize: compressed.blob.size,
      width: compressed.width,
      height: compressed.height,
      hash: compressed.hash,
    })
  } catch {
    return { ok: false, code: 'RESERVE_FAILED' }
  }
  if (!reserved.ok || !reserved.data) {
    return { ok: false, code: 'RESERVE_FAILED' }
  }
  const { assetId, uploadUrl } = reserved.data

  // 楽観層で追加する images (abandon が参照するため try の外で構築。 配列構築は throw しない)。
  const nextImages: ClientCardImage[] = [
    ...currentImages,
    // url は書かない (表示時に解決。 server は url 非空 entry を reject。spec §2.2)。
    { key: assetId, target, alt: '' },
  ]

  // 以降 (楽観層 / PUT / finalize) の失敗・reject は abandon で楽観層を巻き戻して必ず
  // { ok:false, code } を返す (throw を saga 外に漏らさない = 呼出側が code を描画できる)。
  // abandon 自体の失敗は best-effort として握る (startup sweep が stale 'uploading' を backstop)。
  const abandonAndFail = async (
    code: AttachErrorCode,
  ): Promise<AttachResult> => {
    try {
      // 既に直列化区間内 (attachImageToCardInner) ゆえ inner を直接呼ぶ (二重 lock 回避)。
      await abandonUploadInner({ userId, cardId, assetId, currentImages: nextImages })
    } catch {
      // 巻き戻し自体の失敗は握る (深い storage 障害。 sweep が回収)。
    }
    return { ok: false, code }
  }

  // 3. 楽観層 (reserve 成功後): Cache put + media_assets 'uploading' + mirror/outbox。
  //    Dexie/Cache の書込 throw も UPLOAD_FAILED として abandon + return する
  //    (楽観層の部分書込を残して契約を破る unhandled rejection を防ぐ)。
  try {
    await putAssetBlob(userId, assetId, compressed.blob)
    await getClientDb().media_assets.put({
      id: assetId,
      user_id: userId,
      status: 'uploading',
      mime: compressed.mime,
      byte_size: compressed.blob.size,
      width: compressed.width,
      height: compressed.height,
      hash: compressed.hash,
      created_at: new Date().toISOString(),
    })
    await commitImages(cardId, currentImages, nextImages)
  } catch {
    return abandonAndFail('UPLOAD_FAILED')
  }

  // 4. 直 PUT (browser → R2)。 Content-Length は body=blob.size = reserved byteSize で
  //    署名の presign と一致する。 timeout 付き (hang 防止)。 失敗・abort は放棄 → UPLOAD_FAILED。
  let putOk = false
  try {
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      body: compressed.blob,
      headers: { 'Content-Type': compressed.mime },
      // 署名クエリ認証ゆえ cookie 不要。 cross-origin (R2) 明示 + redirect は許さない
      // (presigned は 200 直返し。 予期せぬ redirect は失敗扱い)。
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    })
    putOk = put.ok
  } catch {
    // network 失敗 / abort (timeout) → UPLOAD_FAILED。
    putOk = false
  }
  if (!putOk) {
    return abandonAndFail('UPLOAD_FAILED')
  }

  // 5. finalize (R2 HEAD 検証 → ready)。 reject も !ok も放棄 → FINALIZE_FAILED。
  let finalized: ActionResult
  try {
    finalized = await finalizeAsset(assetId)
  } catch {
    return abandonAndFail('FINALIZE_FAILED')
  }
  if (!finalized.ok) {
    return abandonAndFail('FINALIZE_FAILED')
  }

  // 成功: media_assets を 'ready' 化して flush gate を外す。 この最終 write が reject した
  // 場合、 row が 'uploading' のまま残ると gate が held mutation を永久に止める (asset は
  // server 上 ready 済なのに local だけ stuck)。 そのため update 失敗時は row を削除して
  // gate を確実に release する (asset は ready・表示は Cache/resolve 経由で成立)。 いずれの
  // 経路でも finalize 成功ゆえ {ok:true} を返す (throw を漏らさない)。
  try {
    await getClientDb().media_assets.update(assetId, { status: 'ready' })
  } catch {
    try {
      await getClientDb().media_assets.delete(assetId)
    } catch {
      // best-effort。 最悪 stale 'uploading' が残るが startup sweep が回収する。
    }
  }
  // flush trigger (uploading gate を外し held mutation を流す)。 fire-and-forget。
  void runGuardedEntityMutationFlush().catch(() => {})

  return { ok: true, assetId }
}

// ---------------------------------------------------------------------------
// abandonUpload
// ---------------------------------------------------------------------------

/**
 * 楽観層の巻戻し (放棄): mirror から該当 entry 除去 + Cache delete + media_assets delete。
 *
 * - mirror 除去は mirror の最新 images を読んで `filter(key !== assetId)` の配列全置換
 *   (idempotent: entry 不在でも no-op。 fresh read ゆえ並行 attach の追加を巻き込まない)。
 * - server の 'reserved' 行は無害 orphan として残す (削除しない・手動掃除。spec §3.4)。
 *
 * 公開 `abandonUpload` は per-card 直列化する。 saga 内部 (attachImageToCardInner) からは
 * 既に直列化区間内ゆえ二重 lock を避けるため `abandonUploadInner` を直接呼ぶ。
 */
async function abandonUploadInner(p: {
  userId: string
  cardId: string
  assetId: string
  currentImages: ClientCardImage[]
}): Promise<void> {
  const { userId, cardId, assetId, currentImages } = p

  // mirror の最新 images から該当 key のみ除去する (caller snapshot は fallback)。
  const latest = await readCardImages(cardId, currentImages)
  const nextImages = latest.filter((i) => i.key !== assetId)
  await commitImages(cardId, latest, nextImages)

  await deleteAssetBlob(userId, assetId)
  await getClientDb().media_assets.delete(assetId)

  // commitImages は skipInternalFlush ゆえ、 除去後の最終値 (coalesce 済) を server へ
  // 反映するため放棄時は flush を明示 trigger する (fire-and-forget)。
  void runGuardedEntityMutationFlush().catch(() => {})
}

export async function abandonUpload(p: {
  userId: string
  cardId: string
  assetId: string
  currentImages: ClientCardImage[]
}): Promise<void> {
  await serializePerCard(p.cardId, () => abandonUploadInner(p))
}

// ---------------------------------------------------------------------------
// removeImageFromCard (編集面の「画像削除」)
// ---------------------------------------------------------------------------

/**
 * card の images から該当 entry を除去する (asset/R2 object は残す。 spec §5「画像削除」)。
 * abandonUpload と違い Cache/media_assets は削除しない — 添付済み ready 画像を card から
 * 外すだけの操作。
 *
 * attach/abandon と同じ per-card 直列化 + mirror fresh read を通す (編集面の delete が
 * upload saga の in-flight な楽観追加と full-array-replace で競合し、 追加中の画像を消したり
 * 削除済み画像を復活させるのを防ぐ — Codex 指摘)。 fresh read ゆえ legacy / 他 target の
 * entry も key 不一致で保持される。
 */
export async function removeImageFromCard(p: {
  cardId: string
  assetId: string
}): Promise<void> {
  const { cardId, assetId } = p
  await serializePerCard(cardId, async () => {
    const before = await readCardImages(cardId, [])
    const after = before.filter((i) => i.key !== assetId)
    await commitImages(cardId, before, after)
  })
  // commitImages は skipInternalFlush ゆえ、 除去後の最終値を server へ反映するため
  // 明示 flush する (fire-and-forget)。
  void runGuardedEntityMutationFlush().catch(() => {})
}
