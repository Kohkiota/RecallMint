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
// active = bg-{c}-200 / text-{c}-800 / border-{c}-300。 12 色とも高コントラスト
// を確保し、 明色 (yellow / amber / lime) も含め例外なく text-{c}-800 で揃える。
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
  red: 'bg-red-200 text-red-800 border-red-300',
  orange: 'bg-orange-200 text-orange-800 border-orange-300',
  amber: 'bg-amber-200 text-amber-800 border-amber-300',
  yellow: 'bg-yellow-200 text-yellow-800 border-yellow-300',
  lime: 'bg-lime-200 text-lime-800 border-lime-300',
  green: 'bg-green-200 text-green-800 border-green-300',
  emerald: 'bg-emerald-200 text-emerald-800 border-emerald-300',
  teal: 'bg-teal-200 text-teal-800 border-teal-300',
  cyan: 'bg-cyan-200 text-cyan-800 border-cyan-300',
  blue: 'bg-blue-200 text-blue-800 border-blue-300',
  violet: 'bg-violet-200 text-violet-800 border-violet-300',
  pink: 'bg-pink-200 text-pink-800 border-pink-300',
}

// 色なし (null) または未知色 (palette 削除後など) の fallback = ニュートラル grey。
// 彩色タグと同段 (slate-200) のニュートラル、 hue だけ抜いた中立色で区別する。
export const COLOR_NULL_CLASS = 'bg-slate-200 text-slate-700 border-slate-300'

// 任意の文字列 / null / undefined から表示 class を解決する helper。
// 不明色は安全側に倒して COLOR_NULL_CLASS を返す。
export function colorToClass(color: string | null | undefined): string {
  if (color && (TAG_COLOR_NAMES as readonly string[]).includes(color)) {
    return COLOR_TO_CLASS[color as TagColorName]
  }
  return COLOR_NULL_CLASS
}
