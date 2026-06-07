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
export const COLOR_TO_CLASS: Record<TagColorName, string> = {
  red: 'bg-red-100 text-red-800 border-red-200',
  orange: 'bg-orange-100 text-orange-800 border-orange-200',
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  yellow: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  lime: 'bg-lime-100 text-lime-800 border-lime-200',
  green: 'bg-green-100 text-green-800 border-green-200',
  emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  teal: 'bg-teal-100 text-teal-800 border-teal-200',
  cyan: 'bg-cyan-100 text-cyan-800 border-cyan-200',
  blue: 'bg-blue-100 text-blue-800 border-blue-200',
  violet: 'bg-violet-100 text-violet-800 border-violet-200',
  pink: 'bg-pink-100 text-pink-800 border-pink-200',
}

// 色なし (null) または未知色 (palette 削除後など) の fallback = ニュートラル grey。
export const COLOR_NULL_CLASS = 'bg-slate-100 text-slate-700 border-slate-200'

// 任意の文字列 / null / undefined から表示 class を解決する helper。
// 不明色は安全側に倒して COLOR_NULL_CLASS を返す。
export function colorToClass(color: string | null | undefined): string {
  if (color && (TAG_COLOR_NAMES as readonly string[]).includes(color)) {
    return COLOR_TO_CLASS[color as TagColorName]
  }
  return COLOR_NULL_CLASS
}
