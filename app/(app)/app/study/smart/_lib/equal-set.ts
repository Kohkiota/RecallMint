// 順序非依存・重複統合の集合一致判定。 ユーザー選択 opt id 集合と
// 正解 opt id 集合の完全一致 (correct) を判定する用途。

export function equalSet(a: string[], b: string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return false
  for (const v of sa) {
    if (!sb.has(v)) return false
  }
  return true
}
