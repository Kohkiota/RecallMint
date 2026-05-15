// service brand logo (text 版)。 marketing / auth chrome の Header で
// `<Link href="/"><Logo /></Link>` の形で wrap される (href は親責務、
// Logo 自身は単一責任)。
//
// `{{SERVICE_NAME}}` placeholder は docs/legal-placeholders.md §1 #1 に
// 既登録、 sed 一括置換 system に相乗り (本気運用 / template 抽出時に値
// 差し替え 1 箇所)。 plan00 default 値: 「Vocab App」。
//
// Phase 2 で image / svg / icon に差し替え予定、 本 file 1 箇所差し替え
// で Header chrome 全更新。
export function Logo() {
  return (
    <span className="text-lg font-bold text-slate-900">
      {`{{SERVICE_NAME}}`}
    </span>
  )
}
