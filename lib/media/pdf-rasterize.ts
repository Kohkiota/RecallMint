import 'server-only'

import sharp from 'sharp'
import { PDFiumLibrary, type PDFiumDocument } from '@hyzyla/pdfium'

// upload/_lib/constants.ts の MAX_IMAGE_WIDTH_OR_HEIGHT(= 2048)と揃えた値。
// eslint Block A(`lib/` は `app/` layer を import 禁止)のため直接 import できず、
// lib/media/compress-image-safe.ts の MAX_EDGE と同じ既存パターンで局所定義する
// (循環/層違反を避けるための意図的な値の重複)。
const MAX_LONG_EDGE_PX = 2048

// ②-4b T4: pdfium を薄い module に閉じ込める(spec D1/D4/D8)。 使用する pdfium API は
// 5 つ(`init`/`loadDocument`/`getPageCount`/`getPage`/`render`)+ scale 算出に要る
// `getOriginalSize`(render 呼出前に長辺を知る必要があり、render 自身の内部でしか
// 呼ばれないため外側からも呼ぶ)。これ以外の pdfium API(getText / getObject /
// pages() Generator / renderFormFields 等)は使わない。

// 解析不能(壊れ・暗号化・非対応)を表す typed error。 呼び出し側(T5/T7/T8)は
// これだけを見て「この PDF は扱えない」を判定する。
export class PdfParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PdfParseError'
    // V8 以外 (e.g. SpiderMonkey) でも prototype chain を正しく繋ぐため明示設定
    // (既存 OcrDeadlineError と同じ規律)。
    Object.setPrototypeOf(this, PdfParseError.prototype)
  }
}

export type PdfHandle = {
  pageCount: number
  renderPageWebp(index: number): Promise<{ webp: Buffer; width: number; height: number }>
  destroy(): void
}

// destroy() 済み handle への renderPageWebp を表す typed error(Codex fix round 2
// P1: queue に未処理分を残したまま destroy されるケース)。 PdfParseError(解析不能)
// とは別物 — こちらは「呼び出し側の使い方」由来で、PDF 自体の解析可否とは無関係。
export class PdfHandleDestroyedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfHandleDestroyedError'
    Object.setPrototypeOf(this, PdfHandleDestroyedError.prototype)
  }
}

// wasm init は起動コストが高い(WASM instantiate)ため module 内 lazy singleton で
// invocation 内使い回す。 PDFiumLibrary.init() はライブラリ内蔵の base64 wasm を使う
// (network fetch 不要 = Vercel serverless で完結)。
let libraryPromise: ReturnType<typeof PDFiumLibrary.init> | null = null
function getLibrary() {
  if (!libraryPromise) {
    libraryPromise = PDFiumLibrary.init()
  }
  return libraryPromise
}

export async function loadPdf(buf: Buffer): Promise<PdfHandle> {
  const library = await getLibrary()

  let document: PDFiumDocument
  try {
    document = await library.loadDocument(buf)
  } catch (cause) {
    // 壊れ bytes / 暗号化(password 必須)/ 非対応セキュリティスキームはすべて
    // ここで FPDF_LoadMemDocument が投げる(Codex I8)。 loadDocument 自体が失敗した
    // 時点では document オブジェクトが作られていない(pdfium 側が自分の allocate 分を
    // 解放済み)ため、ここでの destroy は不要。
    throw new PdfParseError('failed to load PDF document (corrupt or encrypted)', { cause })
  }

  // ここから先で失敗したら、handle を返せないまま document だけが確保された状態に
  // なる — 呼び出し側は handle を受け取れていないので destroy を呼べない。
  // その漏れを防ぐため、確保後の失敗は必ずここで destroy してから投げる。
  let pageCount: number
  try {
    pageCount = document.getPageCount()
  } catch (cause) {
    document.destroy()
    throw new PdfParseError('failed to read PDF page count', { cause })
  }

  // renderPageWebp を並列呼出し(Promise.all 等)されても、同一 document(= 単一
  // WASM instance を共有)への同期 WASM 呼出しが入り乱れないよう、handle 単位で
  // 逐次化する。 呼び出し側の規律(for ループで呼ぶこと)に依存させない — 薄い
  // module としての閉じ込め(spec D1/D4/D8)。
  //
  // この直列化 queue を置いたことで「並列呼出し」自体は正当な使い方になった —
  // その結果、`Promise.all([render(0), render(1), render(99)])` のように 1 件が
  // reject し、呼び出し側の `finally { destroy() }` が queue に未処理分を残した
  // まま document を解放しうる(Codex fix round 2 P1)。 各 queue item は自分の
  // 番が来た**直後・document に触れる前**に `destroyed` を確認し、true なら
  // document には一切触れず PdfHandleDestroyedError で reject する(silent success
  // にしない)。 destroy() 自体は queue の settle を待たない(呼び出し側の
  // finally を block させない設計を維持)。
  let destroyed = false
  let queue: Promise<unknown> = Promise.resolve()
  const renderPageWebp = (index: number) => {
    const run = queue.then(() => {
      if (destroyed) {
        throw new PdfHandleDestroyedError(
          `handle already destroyed before rendering page ${index}`,
        )
      }
      return renderOnePage(document, index)
    })
    // 前段の失敗が後続呼出しの開始をブロックしないよう、queue には失敗を握り
    // つぶした版を繋ぐ(公開する `run` 自体は reject をそのまま呼び出し元へ返す)。
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    document.destroy()
  }

  return { pageCount, renderPageWebp, destroy }
}

async function renderOnePage(
  document: PDFiumDocument,
  index: number,
): Promise<{ webp: Buffer; width: number; height: number }> {
  try {
    const page = document.getPage(index)
    const { originalWidth, originalHeight } = page.getOriginalSize()
    // 長辺を MAX_LONG_EDGE_PX に合わせる scale(既存の画像アップロード上限と揃える)。
    const scale = MAX_LONG_EDGE_PX / Math.max(originalWidth, originalHeight)
    // 同期 WASM 実行(_FPDF_RenderPageBitmap)は途中中断不能 — per-page timeout は
    // 設けない。 hard cap は呼び出し元 invocation の maxDuration が担う(Codex 独立
    // 論点 3 への回答)。
    const { data, width, height } = await page.render({ scale })
    // pdfium の render() 既定 colorSpace 'BGRA' は API 上のラベルで、実際に返る
    // byte 順は実測で RGBA(既定で FPDF_REVERSE_BYTE_ORDER フラグが適用されるため)。
    // sharp の raw 4ch 解釈(R,G,B,A 順)と一致するため channel swap は不要 —
    // 実測済み(report 参照。合成 PDF の既知色矩形を render → sharp → webp → decode
    // で往復させ、色が反転しないことを確認)。
    const webp = await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
      .webp({ quality: 80 })
      .toBuffer()
    return { webp, width, height }
  } catch (cause) {
    throw new PdfParseError(`failed to render PDF page ${index}`, { cause })
  }
}
