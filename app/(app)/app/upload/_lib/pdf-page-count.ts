// PDF page count を binary 走査で近似する軽量関数 (pdf-lib 等の dep 追加を避ける、
// kickoff 案 B 採用)。
//
// 仕組み: PDF 内の `/Type /Page` (末尾が「s」 や「/」 でない、 つまり /Pages や
// /PageTreeNode 等を除く) 出現数を count。 多くの PDF で各 page object に
// `/Type /Page` が書かれるため、 近似 page 数として機能する。
//
// 制約: 暗号化 PDF / object stream で圧縮された PDF では正確に出ない可能性あり、
// off-by-few は許容範囲内。 page 制限の強制はこの関数ではなく呼び出し側が担う
// (per-file: MAX_PDF_PAGES=40 / per-upload 合計: OCR_MAX_PAGES=40)。

export async function pdfPageCount(file: File): Promise<number> {
  const buffer = await file.arrayBuffer()
  // latin1 で decode するのは binary safe (1 byte = 1 code point) なため、
  // PDF の ASCII header + マーカ部分が破損せず文字列検索可能。
  const text = new TextDecoder('latin1').decode(buffer)
  // `/Type[whitespace]/Page` で、 後続が「s」 (= /Pages) や「/」 (= /PageTreeNode 等)
  // ではない箇所のみ count。 PDF の object syntax 上は space / newline / tab を許す。
  const matches = text.match(/\/Type\s*\/Page(?![a-zA-Z\/])/g) ?? []
  return matches.length
}
