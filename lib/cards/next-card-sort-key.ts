// 新規 card の sort_key を採番する純粋関数。
//
// rule:
// - 既存の sort_key が全て数字のみ (ゼロパディング含む、 e.g. "001" "009") →
//   max(as int) + 1 を返す (パディングなし、 e.g. "10")
// - 既存が階層・混在 (e.g. "03-02", "1.2", "a") → length + 1 に fallback
// - null / 空文字 / whitespace-only は集計から除外
//   (UI 未設定 card や過去 default null からの upgrade path)
//
// nextOptionId と異なり、 sort_key は user 指定可能な自由度を想定し、
// 数字判定後即座に maxint+1 を返す (opt-N fallback なし)。

export function nextCardSortKey(existing: (string | null)[]): string {
  // null / 空 / whitespace-only を除外
  const vals = existing.filter(
    (v): v is string => v !== null && v !== '' && v.trim().length > 0,
  )

  // 空 → '1'
  if (vals.length === 0) {
    return '1'
  }

  // 全て数字 (ゼロパディング含む) ならば max + 1
  if (vals.every((v) => /^\d+$/.test(v))) {
    const max = Math.max(...vals.map((v) => parseInt(v, 10)))
    return String(max + 1)
  }

  // 混在・非数字は fallback: 既存件数 + 1
  // fallback は既存 key と衝突しうるが sort_key は非 UNIQUE・ユーザー編集可・並び順専用のため許容 (intentional)
  return String(vals.length + 1)
}
