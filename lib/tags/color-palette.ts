// tag_options.color に保存する色名 (文字列 / null) と、 UI 側の Tailwind class
// との mapping を一元管理する。 DB には色名のみ保存し、 表示時に COLOR_TO_CLASS
// で class を解決する設計のため、 palette を拡張する際に DB 移行が不要になる。
//
// なぜ動的構成 (`bg-${color}-100`) を避けるか: Tailwind v4 の class 検出は静的解析
// ベースのため、 template 文字列で組み立てた class は purge で消える。 12 色 × 3
// utility = 36 個を Record の value に固定文字列として埋め込み、 ビルド時に必ず検出
// される形にする。

export const TAG_COLOR_NAMES = [
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'blue',
  'violet',
  'pink',
] as const

export type TagColorName = (typeof TAG_COLOR_NAMES)[number]

// pill 表示用の bg / text / border の 3 utility を 1 まとめにした固定文字列。
// active = 深めトーン (bg-300 / text-900 / border-400)。 12 色とも高コントラスト
// を確保し、 明色 (yellow / amber / lime) も含め例外なく text-{c}-900 で揃える。
//
// ── 将来ダークモード用の色案 (実装時にどちらか選ぶ) ──
// Tailwind v4 の source scanner はコメント内の literal も拾うため、 ここでは
// プレースホルダ {c} 短縮表記で記述し dead utility 生成を回避する。 案 B の
// 「例) red →」 だけは 1 色分の literal を残して具体形を示す (3 utility 増は許容)。
// 案A ソリッド(鮮やか): red/orange/green/emerald/teal/cyan/blue/violet/pink = bg-{c}-600 text-white border-{c}-700。
//     明色は白文字不可 → amber/yellow/lime = bg-{c}-400 text-{c}-950 border-{c}-500。
// 案B ダークモード本命(暗トーン+明色文字、Notion 暗モード相当): dark: variant を全 12 色で設計。
//     例) red → dark:bg-red-950/40 dark:text-red-300 dark:border-red-900。
//     ダークモードの定石は案 B。 案 A は明モードでも使える vivid 控え。
export const COLOR_TO_CLASS: Record<TagColorName, string> = {
  red: 'bg-red-300 text-red-900 border-red-400',
  orange: 'bg-orange-300 text-orange-900 border-orange-400',
  amber: 'bg-amber-300 text-amber-900 border-amber-400',
  yellow: 'bg-yellow-300 text-yellow-900 border-yellow-400',
  lime: 'bg-lime-300 text-lime-900 border-lime-400',
  green: 'bg-green-300 text-green-900 border-green-400',
  emerald: 'bg-emerald-300 text-emerald-900 border-emerald-400',
  teal: 'bg-teal-300 text-teal-900 border-teal-400',
  cyan: 'bg-cyan-300 text-cyan-900 border-cyan-400',
  blue: 'bg-blue-300 text-blue-900 border-blue-400',
  violet: 'bg-violet-300 text-violet-900 border-violet-400',
  pink: 'bg-pink-300 text-pink-900 border-pink-400',
}

// 色なし (null) または未知色 (palette 削除後など) の fallback = ニュートラル grey。
// 彩色タグ (bg-300) より一段静かに、 ただし旧 -100 の淡さは脱する (bg-200)。
export const COLOR_NULL_CLASS = 'bg-slate-200 text-slate-700 border-slate-300'

// 任意の文字列 / null / undefined から表示 class を解決する helper。
// 不明色は安全側に倒して COLOR_NULL_CLASS を返す。
export function colorToClass(color: string | null | undefined): string {
  if (color && (TAG_COLOR_NAMES as readonly string[]).includes(color)) {
    return COLOR_TO_CLASS[color as TagColorName]
  }
  return COLOR_NULL_CLASS
}
