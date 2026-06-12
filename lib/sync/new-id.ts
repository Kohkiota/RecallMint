// new-id — entity-mutations.ts / review-events.ts の旧 inline 実装を 1 経路に集約。
// ブラウザ / Node 19+ 共通の crypto.randomUUID() (v4 UUID) を返す。
// 古い WebView fallback は要件未確認のため敢えて入れない (PWA 対象 iOS 16.4+ /
// Android Chrome では問題なし)。
export function newId(): string {
  return crypto.randomUUID()
}
