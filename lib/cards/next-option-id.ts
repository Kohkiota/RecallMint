// 新規 option の id を card 内で衝突しないように採番する純粋関数。
//
// rule:
// - 既存が全て英字 1 文字 (a〜z) → 次の未使用英字
// - 既存が全て数字のみ → max(id) + 1
// - 上記いずれも該当しない (mix / 英字 z 枯渇 / 空 等) → `opt-N` (N=1 から重複しない最小値)
//
// 元実装は `app/(app)/app/cards/[id]/_components/card-editor.tsx` 内に閉じていたが、
// 試験詳細 page の inline 編集 (S2.0b-3 で「+ 選択肢を追加」 機能) でも同じ採番が
// 必要になり、 file を跨いで共有するため本 lib に切り出した。 同 file の caller は
// `card-editor.tsx` の addOption と `inline-option-row.tsx` (InlineOptionList) の
// 「+ 選択肢を追加」 handler の 2 箇所。

export function nextOptionId(existing: string[]): string {
  const taken = new Set(existing)
  if (existing.length > 0 && existing.every((id) => /^[a-z]$/.test(id))) {
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c)
      if (!taken.has(ch)) return ch
    }
  }
  if (existing.length > 0 && existing.every((id) => /^\d+$/.test(id))) {
    return String(Math.max(...existing.map((id) => parseInt(id, 10))) + 1)
  }
  let n = 1
  while (taken.has(`opt-${n}`)) n++
  return `opt-${n}`
}
