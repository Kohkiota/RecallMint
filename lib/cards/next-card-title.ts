// 新規 card のタイトルを生成する純粋関数。
// 既存 card 数に基づいて「新規カード N」 形式で返す。

export function nextCardTitle(existingCount: number): string {
  return `新規カード ${existingCount + 1}`
}
