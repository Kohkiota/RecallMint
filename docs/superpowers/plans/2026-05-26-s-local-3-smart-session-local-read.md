# S-local-3 smart session local read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** smart session 開始時の cards 取得を **Dexie cards (S-local-2 で mirror 済) からの read** に切替える。 Dexie が空なら server cards に fallback、 server SSR 自体は維持して initial 描画は壊さない。

**Architecture:** server `page.tsx` は引き続き `getSessionCards()` を呼んで cards prop を `StudySessionHost` に渡す (= fallback)。 `StudySessionHost` (client) mount 時に `getDueCardsFromDexie()` を試行し、 1 件以上返れば props を上書きして `SessionRunner` に渡す。 既存 server fetch path / SessionRunner 内部 / FSRS server 計算は無変更。 schema 変更なし、 ts-fsrs client 化なし。

**Tech Stack:** Next.js 15 App Router / Drizzle / Dexie 4.4.2 / Vitest + fake-indexeddb + @testing-library/react / TS strict

---

## Plan-wide rules

CLAUDE.md 絶対ルール (Stripe / Clerk / AI) は本 sprint で触れない。 共通事項:

- **TypeScript strict 維持** (kebab-case file / PascalCase comp / camelCase fn)
- **server authoritative 維持**: FSRS state 更新は server `submit-review-tx.ts` で確定、 cards mirror は read-only
- **silent fallback**: Dexie read 失敗 / 0 件は console / UI 警告なし、 server cards に切替
- **mirror stale 警告 UI なし**: 古い mirror で session 開始しても server reconcile で整合 (詳細 §設計判断)
- **commit 規律**: 1 commit (plan + 実装 + test) で `superpowers:requesting-code-review` 経由 formal review → Critical 0 / Important 0 → `[reviewed]` tag

## 設計判断 (OT 必須 10 項目への回答)

### 1. 現在のデータフロー (D-4、 inventory doc 参照)

```
Server: page.tsx → getSessionCards(user.id, limit) [Drizzle SELECT] → cards prop
        → <StudySessionHost cards={...} fsrsMode mode="smart" />
Client: StudySessionHost.useEffect → createStudySession (Dexie write) → <SessionRunner cards={...} />
Session: cards は props のまま使う。 Dexie cards table は touch しない (= 本 sprint で変更する点)
```

### 2. `getSessionCards()` 返す shape

`lib/cards/get-session-cards.ts:19-32`、 `Card[]` = `typeof cards.$inferSelect` (Drizzle row 型、 camelCase + Date)。 due ASC + LIMIT。

### 3. Dexie `cards` table shape

`ClientCard` (`lib/client-db.ts:67-99`)、 snake_case + ISO8601 文字列 + `sync_status`。 index: `id, exam_id, user_id, due, updated_at, content_version, sync_status`。

### 4. session-runner が必要とする field 差分

`SessionRunner` は `Card[]` を props で受ける (`session-runner.tsx:77-83`)。 `id / options / questionText / explanationText` 等を camelCase で参照。 既存 test 62 case が `Card` 型前提なので、 **session-runner の型を変えない方針**。 Dexie 由来 cards を Card 型に逆 mapping して渡す。

### 5. Dexie cards から smart session cards を作れるか

YES。 reverse mapper `toCard(client: ClientCard): Card` を `lib/db/cards-pull.ts` に追記 (`toClientCard` の対称)。 ISO 文字列 → Date 復元、 snake_case → camelCase、 `sync_status` は drop。

### 6. FSRS client due 判定が今回必要か

**NO**。 due の比較は単純な ISO 文字列の lexicographic 比較で済む (Dexie は ISO 文字列保存、 lexicographic 順 = 時系列順が成立)。 ts-fsrs を client bundle に追加しない。 FSRS state 更新は引き続き server `submit-review-tx.ts` で行い、 次 pull で mirror 同期。

### 7. local cards が空の場合の fallback

`getDueCardsFromDexie()` が `[]` を返したら、 `StudySessionHost` は `props.cards` (= server fetch 結果) をそのまま使う。 server SSR cards prop を破棄せず、 client で「空チェック → 上書き or fallback」 を 1 行で分岐。

### 8. local cards が stale な場合の扱い

**stale 警告 UI なし** (本 sprint 範囲外)。 stale = mirror pull 前に server cards が更新された状態。 影響:
- 既に解いた cards が due として再出することがある (server 側で submit-review-tx 後 mirror が古いまま) → session 開始時に 1-2 件の重複が起きうるが、 user は何度回答しても server 側冪等 (event_id) で副作用なし
- 完了画面で server flush + 次 dashboard mount で PullTrigger が走り mirror 更新 → 次 session は最新で開始

session 中に warning を出すと UX 後退、 また「stale 判定」 自体に server へ問い合わせが必要 (本末転倒)。 **silent 受容** 方針で問題なし。

### 9. server authoritative との整合

- 回答 → answer_events Dexie 即記録 → bulk flush → server submitReviewTx で cards 更新 → 次 pull で Dexie cards 更新
- Dexie mirror は **read-only** の前提 (本 sprint で書き込まない)
- session 開始時の Dexie cards が server より古くても、 session 完了時の server flush + 次 pull で reconcile
- 整合の真実 source は server cards、 Dexie は時間遅れ snapshot

### 10. test 方針

新規 / 拡張:
- `lib/db/cards-pull.test.ts` (拡張): `toCard` reverse mapper test 2-3 case (ISO → Date 復元 / null フィールド)
- `lib/cards/get-dexie-session-cards.test.ts` (新規): fake-indexeddb 実 Dexie で due filter / limit / userId 絞り / sort / 0 件返却を 5-6 case
- `app/(app)/app/study/smart/_components/study-session-host.test.tsx` (新規): RTL で Dexie helper を mock、 Dexie cards あり → Dexie 由来で SessionRunner render / Dexie 空 → server cards で render / Dexie throw → server cards に fallback の 3-4 case

E2E は対象外、 OT 実機 smoke で代替。

## ファイル構成

新規:
- `lib/cards/get-dexie-session-cards.ts(+test)`
- `app/(app)/app/study/smart/_components/study-session-host.test.tsx`

修正:
- `lib/db/cards-pull.ts(+test)`: `toCard` 追記
- `app/(app)/app/study/smart/_components/study-session-host.tsx`: useEffect 内で hybrid 切替

無変更 (重要):
- `lib/sync/cards.ts` (pull write helper)
- `lib/db/schema.ts`
- `lib/client-db.ts` (Dexie schema)
- `app/(app)/app/study/smart/page.tsx` (server SSR は維持)
- `app/(app)/app/study/smart/_components/session-runner.tsx` (型 / 内部 logic 不変)
- `lib/cards/submit-review-tx.ts` (server FSRS)
- `app/api/cards/pull/route.ts` 等 server endpoint

---

## Task 1: `toCard` reverse mapper

**Files:** Modify `lib/db/cards-pull.ts` + `lib/db/cards-pull.test.ts`

**目的:** ClientCard (Dexie) → Card (Drizzle inferSelect) の逆 mapping。 ISO 文字列 → Date 復元、 snake_case → camelCase、 `sync_status` drop。

**制約:**
- `toClientCard` と対称 (round-trip 等価)
- `last_review: null` → `lastReview: null` (Date 型保持)
- `last_review: '<iso>'` → `lastReview: new Date('<iso>')`
- `id / examId / userId / sourceDocumentId / customProps / options / images / tags / answered / lastCorrect / currentStreak / FSRS 全 column` のフィールド rename を完全網羅

**完了条件:** vitest 3-4 case (round-trip: ClientCard → Card → field match / Date 復元 / null 維持)、 typecheck clean、 review Critical 0

---

## Task 2: `getDueCardsFromDexie` read helper

**Files:** Create `lib/cards/get-dexie-session-cards.ts` + test

**目的:** Dexie cards table から user 別 + due <= now (ISO 比較) + sort by due asc + limit で due cards を取得、 Card[] (server 型) に変換して返却。

**制約:**
- signature: `getDueCardsFromDexie(userId: string, limit: number, now?: Date): Promise<Card[]>`
- `now` 省略時は `new Date()`。 比較は ISO 文字列 lexicographic (Dexie cards.due は ISO 文字列保存) → `now.toISOString()` と比較
- query: `db.cards.where('user_id').equals(userId).toArray()` → JS filter (due <= now.iso) → sort + slice limit
- (理由: Dexie multi-condition where は複雑、 JS filter で十分。 sort も同様。 件数上限 1 user 数千件想定で問題なし)
- mapper: 各 ClientCard を `toCard()` に通す
- 失敗時: throw を許容 (呼出側で catch して fallback)

**完了条件:** vitest 5-6 case (fake-indexeddb 実 Dexie):
- 空 table → []
- 全て future due → []
- 一部 due 該当 → 該当のみ返却
- limit 超え → limit 件で truncate
- sort by due asc 確認 (due が小さい順)
- 他 user の cards 含まれない (tenant)
- review Critical 0、 typecheck clean

---

## Task 3: `StudySessionHost` hybrid 切替

**Files:** Modify `app/(app)/app/study/smart/_components/study-session-host.tsx` + Create `study-session-host.test.tsx`

**目的:** mount 時に `getDueCardsFromDexie` を試行し、 結果が 1 件以上なら props.cards を上書きして `SessionRunner` に渡す。 Dexie 空 / throw 時は props.cards (server fetch 結果) を fallback として使う。

**制約:**
- 新規 prop: `userId: string` (page.tsx から渡す)、 `sessionLimit: number` (同上)
- useEffect 順序: (1) Dexie 試行 → (2) cards 確定 → (3) createStudySession (Dexie write) → (4) sessionId 確定 → (5) Loading 解除
- Dexie cards 試行は try/catch、 throw 時 / 0 件時 → props.cards を使う (silent fallback)
- 既存 `cards` prop は残置 (= initial fallback、 page.tsx は無変更で動作)
- `createStudySession.card_ids` は **確定後の cards** (Dexie 由来か server 由来かに関わらず) の id 配列を使う
- StrictMode 二重 mount 対策の `cancelled` flag は維持
- Loading 表示は cards 確定 + sessionId 確定の AND
- silent: console.log / console.error / UI 警告なし

**完了条件:** vitest RTL 3-4 case (`@testing-library/react` + jsdom):
- Dexie cards 1 件以上 → Dexie cards で SessionRunner が render (server cards は使われない)
- Dexie cards 0 件 → server cards で SessionRunner が render (fallback)
- Dexie helper が throw → server cards で SessionRunner が render (silent fallback)
- createStudySession の card_ids が確定後 cards と一致
- review Critical 0、 typecheck clean

---

## Task 4: 統合確認 (commit 前)

**Files:** なし (動作確認のみ)

**目的:** `pnpm exec tsc --noEmit` clean + `pnpm test` 全通過 + 既存 session-runner.test.tsx / smart page.test.tsx が壊れていないこと。

**完了条件:** typecheck clean / 全 test pass / 既存 test の regression なし

---

## Task 5: stg smoke 手順 (commit 後 OT 実施)

**Files:** なし

**目的:** stg deploy 後の OT 実機確認手順。

**手順:**
1. stg login → `/app` 訪問 → PullTrigger で cards mirror 確認 (DevTools Application → IndexedDB → recallmint → cards に行)
2. `/app/study/smart` 訪問 → session 開始
3. Network panel で `/app/study/smart` SSR の cards fetch (RSC body) は走る (= fallback path 維持)
4. ただし session 中の cards 表示は Dexie 由来 (= 上書きが効いている、 server cards と完全同等のはず)
5. (検証 hack 用): DevTools Application IDB で cards table を 1 行削除 → reload → 削除した card は session に出ない (= Dexie 由来になっている証拠)
6. 回答 → 完了 → 「ダッシュボードへ」 で S-cache-3.1 await 経路 + S-local-2 PullTrigger で cards 再 pull → mirror 復元

**完了条件:** OT 実機 smoke PASS

---

## やらないこと (本 sprint 範囲外)

完全 offline 演習成立 (server SSR が必要) / FSRS 更新 client 計算 / dueCount local projection / dashboard local 化 / Service Worker / image cache / card_mutations bulk push / user_settings Dexie 化 / Δ pull (since cursor 利用) / mirror stale 警告 UI / conflict resolution 本実装 / マルチデバイス sync UX / ts-fsrs client bundle 化 / per-exam mirror / due-soon mirror / sort by stability / random shuffle 等の session ロジック変更。

## Plan 完了基準

Task 1-3 を `pnpm test` 全通過 + typecheck clean + review Critical 0 / Important 0 で `[reviewed]` tag 付き 1 commit に集約。 Task 4 は commit 前の verification、 Task 5 は OT 実機 (commit 後)。

## 分量

S-local-3 plan: ~220 行 / 上限 250

## 関連 doc

- inventory: `docs/superpowers/sessions/2026-05-26-localdb-inventory.md`
- design: `docs/superpowers/specs/2026-05-26-s-local-1-design.md` (Phase β 該当)
- 前 sprint plan: `docs/superpowers/plans/2026-05-26-s-local-2-cards-pull-mvp.md`
- 既存 server side: `lib/cards/get-session-cards.ts` / `app/(app)/app/study/smart/page.tsx`
- 既存 Dexie pull: `lib/sync/cards.ts` / `lib/db/cards-pull.ts`
