# S2.0.8-a 調査 — 試験一覧 / アップロードページの DB クエリ並列化

調査日: 2026-05-22 / 種別: 調査のみ (コード変更ゼロ)
対象: `app/(app)/app/exams/page.tsx` / `app/(app)/app/upload/page.tsx`

---

## 結論 (先出し)

S2.0.8-a が要求した「直列 await の並列化」は**実装不要**だった。
両ページの並列化可能なクエリは既に `Promise.all` 済み。plan 背景の
「getCurrentUser() → getActiveExamsWithCardCount() → getExamStatusMap() が
直列 await」は事実と異なる。コード変更なしで close。

## 1. 現在のクエリ依存関係

### 試験一覧 `exams/page.tsx`

- `getCurrentUser()` を await — `user.id` 取得に必須。`cache()` 済で layout の
  呼び出しと dedupe され、実 SELECT は 1 本。
- `Promise.all([getActiveExamsWithCardCount(user.id), getExamStatusMap(user.id)])`
  — **既に並列**。両者 `user.id` のみ依存・相互依存なし。
- この `Promise.all` は commit `a6aaacd` (`getExamStatusMap` 導入時) から存在し、
  一度も直列だったことがない。

### アップロード `upload/page.tsx`

- `getCurrentUser()` を await — `user.id` / `user.plan`。`cache()` 済。
- `hasActiveProcessingUpload(user.id)` を await — 結果で分岐。
  `isProcessing === true` のとき早期 return し、後続 2 本を**意図的に skip**
  (処理中案内のときは不要 fetch を省く最適化、コード comment 明記)。
- `Promise.all([getActiveExamsForUser(user.id), getCurrentMonthOcrPages(user.id)])`
  — **既に並列**。
- `limitsFor(user.plan)` — 同期・純関数、クエリなし。
- 残る直列は `hasActiveProcessingUpload` → 条件付き fetch のみ。これは制御フロー
  依存 (処理中なら 2 本を打たない) で、plan の「依存関係がある場合は無理に
  並列化しない」に該当。

## 2. 遅さの真因

変更前計測: 試験一覧 約 2.2 秒 / アップロード 約 2.5 秒。
warm 状態の再計測: **試験一覧 420ms / アップロード 405ms**。

2 秒級の遅延は warm 状態では再現せず、**Neon serverless の compute cold start**
が主因。`lib/db/index.ts` は Neon serverless WebSocket `Pool`。Neon は idle 時に
compute を auto-suspend するため、cold 状態の初回クエリで compute 復帰に数秒かかる。
これは page query を並列化しても改善しない (全クエリが同一 pool を共有し、
最初のクエリが接続 + compute 復帰コストを払う)。

## 3. 結論

- S2.0.8-a の要求変更 (page query 並列化) は既に実装済み・**no-op で close**。
- warm 状態の応答 (試験一覧 420ms / アップロード 405ms) は許容範囲。
- cold start 由来の初回遅延は現スタック (Vercel serverless + Neon auto-suspend)
  の構造的特性で、アプリ側コードでの改善余地はほぼ無い。恒久対策が必要なら
  Neon の compute 常時起動プラン等インフラ層の判断になる (別途検討)。
