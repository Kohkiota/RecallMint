# 演習読込 増分 pull 化 — 設計 spec

- **日付**: 2026-05-29
- **位置づけ**: `S-local-2` (full snapshot pull) + `S-delete-0` (tombstone 記録) の続き、**読込側**の
  offline-first / incremental sync 化。スプリント code は OT 確定待ち (本 spec では「本機能」と呼ぶ)。
- **前段調査** (事実根拠): `docs/superpowers/sessions/2026-05-29-incremental-pull-inventory.md` /
  `docs/superpowers/sessions/2026-05-29-incremental-pull-clock-guards-inventory.md`
- **実装はまだしない。本 spec の承認後に `writing-plans` で plan 化する。**

---

## 1. 背景と確定事項

現状 pull は (app) layout mount 時に cards / exams / study_days を **full snapshot + 全置換 (clear+bulkPut)**
で取得する (`pull-trigger.tsx`)。削除は clear が唯一の反映機構で、cursor (`sync_meta`) は書かれるが読まれない
dead-write。これを「前回 cursor 以降の差分取得 + merge + tombstone 反映」へ best-practice 準拠で直す。

### 確定事項 (ディベート不可・所与)

**スコープ**
- cards / exams を増分 pull 化する。
- exams は試験一覧 UI を Postgres 直読みから **Dexie mirror (useLiveQuery) 参照**へ切替え、現状 dead read の
  exams mirror を生かす。
- study_days は据え置き (updated_at 列が無く 90 日 full-window のため増分化しない)。

**クロック統一**
- cursor 比較に乗る全打刻を **DB クロック (SQL `now()`)** に統一。対象は (a) カード inline 編集時の updated_at、
  (b) 復習 bulk push の updated_at、(c) tombstone の deleted_at。現状これらは Node の `new Date()` (App クロック)。
  **schema 変更はせず打刻箇所のみ `now()` に変更**。

**cursor / 削除**
- 境界取りこぼし対策は **inclusive (`>=`) cursor + 受信側 id 冪等適用** (Dexie bulkPut/bulkDelete が id キー冪等)。
  tx in-flight gap もこれで吸収。keyset tie-break は導入しない。
- cursor は**ストリーム別に独立管理**。`sync_meta` に cards updated_at / exams updated_at / tombstone deleted_at
  の 3 cursor を別々に保持。単一 global cursor にしない。
- next-cursor は「**返却行の max(対象列)**」。サーバー wall-clock の `now` は cursor に使わない。**0 件返却時は据え置き**。
- 削除は tombstone を pull で返し、client が entity_type 別に bulkDelete して mirror に反映。

**exams card_count**
- 試験一覧の件数は **IDB の cards mirror から算出**。`exams.updated_at` の card_count 凍結ロジックには手を入れない。

**pull-back / トリガー / ガード**
- 復習 push の **flush 成功確定点**をフックに pull-back (cards 等の再 pull) を相乗りさせ、FSRS 再計算後のサーバー値を
  mirror へ戻す。push レスポンスで値を返す改修はしない。
- pull トリガーを mount に加えて **visibilitychange / online** へ拡張 (push 側 flush trigger と同型)。
- pull に **1 タブ内 in-flight guard + 多タブ Web Locks の両方** (G-2)。push 側 guarded flush / lock manager /
  lock resolver を pull 用 lock 名で流用。

**完了基準の軸** (前回比較ドキュメント §8-2 の読込側 未充足項目)
- フォーカス/再接続トリガー / push 後 pull-back / cursor stale ガード / 増分 pull / 削除 tombstone 反映 /
  pull in-flight / 多タブ排他、の 7 項目が埋まること。
- cards / exams の全件 pull が増分 pull になること。

### 前提と実コードの食い違い (指摘)
- **`exams.updated_at` は現状ほぼ不動**: INSERT 以外の全更新が `sql\`${exams.updatedAt}\`` で凍結され、
  exam rename/編集 action は不在 (調査2 軸1)。よって exams の増分 pull は当面「新規 exam の INSERT 検知 +
  削除 (tombstone)」が主で、既存 exam の内容変化は cursor に乗らない。card_count は cards mirror 算出 (確定事項)
  のため UI 上は問題ないが、**exams 差分が実質「追加と削除のみ」になる**点を設計前提として明示する
  (将来 exam rename を実装したら $onUpdate→now() 統一が効いて自然に差分に乗る)。

---

## 2. server 側変更点

### 2.1 pull endpoint の `?since` 受領

現状: `cards/pull/route.ts:18` `GET(_req: Request)` は req を無視 (コメントに「Phase α は since 無視」明記)、
`exams/pull/route.ts:13` 同様。DB 入口 `getAllCardsForUser` は `where(eq(cards.userId, userId))` のみ
(`cards-pull.ts:22-26`)、`getAllExamsForUser` 同 (`exams-pull.ts:26-30`)。

変更:
- route で `new URL(req.url).searchParams.get('since')` を取り、ISO8601 として検証 (不正/欠落は「全件 = since 無し」に
  fallback、= 初回 pull)。
- DB 入口に `since?: string` を足し、`since` 指定時は `and(eq(userId), gte(cards.updatedAt, sinceDate))` を適用
  (**inclusive `>=`**)。tombstone は別ストリーム (2.3)。

### 2.2 next-cursor (max) の算出

確定: next-cursor = 返却行の `max(対象列)`、0 件は据え置き (= client は cursor を更新しない)。
算出場所は **§7 で選択肢提示** (推奨: DB 入口関数が `{ rows, maxUpdatedAt }` を返す)。route は `now` を捨て、
`maxUpdatedAt` (0 件なら `null`) をレスポンスに載せる。

レスポンス形 (案):
```
{ cards: ClientCard[], maxUpdatedAt: string | null }   // cards/pull
{ exams: ClientExam[], maxUpdatedAt: string | null }   // exams/pull
```
（`now` フィールドは廃止。client 側 helper の `typeof now === 'string'` validation (`sync/cards.ts:65`) を
`maxUpdatedAt` 対応に変更。）

### 2.3 tombstone を返す形

tombstones は単一テーブルで `entity_type ('exam'|'card')` を持ち (`schema.ts:631-649`)、確定事項でも
**deleted_at cursor は 1 ストリーム**。よって entity 別に分割せず 1 レスポンスで返すのが自然。
**同梱 / 統合 endpoint のどちらを採るかは §7 で選択肢提示** (推奨: 統合 `/api/pull`)。
- tombstone query: `WHERE user_id = ? AND deleted_at >= since_tombstone` (`tombstones_user_deleted_idx`
  (user_id, deleted_at) がそのまま効く)。返却に entity_type / entity_id / deleted_at。
- next-cursor = `max(deleted_at)`、0 件据え置き。

### 2.4 クロック統一 (打刻箇所のみ `now()` 化、schema 不変)

| 対象 | 現状 (App クロック) | 変更後 (DB クロック) |
|---|---|---|
| (a) card inline 編集 | `update-card-field.ts:142-145` `.set(built.data)` が `$onUpdate(()=>new Date())` 発火 | `.set({ ...built.data, updatedAt: sql\`now()\` })` で明示上書き ($onUpdate より優先) |
| (b) 復習 bulk push | `bulk/route.ts:333` `updatedAt: sql\`${toPgTimestamptz(new Date())}::timestamptz\`` | `updatedAt: sql\`now()\`` |
| (c) tombstone | `delete-card.ts:64` `deletedAt: new Date()` / `delete-exam.ts:71-78` `const now = new Date()` | `deletedAt: sql\`now()\`` (delete-exam は exam+配下 card を同一 tx の `now()` で揃える) |

注意点:
- (b) `bulk/route.ts` は Drizzle #5789 回避で timestamptz を ISO string bind している (route header 参照)。
  `sql\`now()\`` は DB 側評価で JS Date を bind しないため #5789 と無関係に安全 (むしろ単純化)。
  ただし VALUES UPDATE の `v.due` / `v.last_review` 等 FSRS 値 (App 計算結果) は引き続き ISO bind のまま
  (これらは cursor 列ではないので統一対象外)。`updatedAt` のみ `now()` に変える。
- (c) `delete-exam.ts` は現状 1 つの `new Date()` 変数を exam+全 card に使い回している。`now()` 化後も
  「1 tx 内で全 tombstone が同一サーバー時刻」になる (同一 statement 内の `now()` は tx 開始時刻で一定)。
  確定方針 (inclusive + 冪等) のため同値の取りこぼし対策は不要。
- INSERT 時の `DEFAULT now()` (cards/exams 生成) は既に DB クロック。変更不要。

---

## 3. client 側変更点

### 3.1 cursor read 側の新設

現状: `getSyncMeta` (`sync-meta.ts:21`) は定義のみで caller ゼロ。`SYNC_META_KEYS` に
`lastCardPullAt`/`lastExamPullAt`/`lastStudyDayPullAt` (`sync-meta.ts:12-17`)。
変更:
- key を「pull した時刻」から「ストリーム別 cursor」へ意味変更。**3 cursor を独立 key で保持**:
  cards updated_at / exams updated_at / tombstone deleted_at。tombstone 用 key を `SYNC_META_KEYS` に追加。
  (`lastStudyDayPullAt` は study_days 据え置きのため現状のまま。)
- pull 前に該当 cursor を `getSyncMeta` で読み、`?since=` に乗せる。

### 3.2 増分 merge (clear 撤去 → upsert) + tombstone bulkDelete + cursor 更新を 1 tx

現状: `pullAllCards` (`sync/cards.ts:52-78`) / `pullAllExams` (`sync/exams.ts:39-65`) は
`db.transaction('rw', ...) { clear(); bulkPut(); sync_meta.put(cursor) }`。失敗時は Dexie/sync_meta を
touch しない不変性 (`cards.ts:55-67`)。
変更 (失敗時不変性を維持したまま):
- `clear()` を撤去し `bulkPut(rows)` のみ (Dexie bulkPut は PK=id の upsert)。
- 同 tx 内で tombstone を entity_type 別に `bulkDelete(ids)` (cards 用 tx は card tombstone、exams 用は exam tombstone)。
- 同 tx 内で 3 cursor を `setSyncMeta` (max を返した分のみ更新、0 件 null は据え置き)。
- merge upsert + tombstone delete + cursor 更新を **1 tx** に包む (現状の atomic 失敗時不変性を踏襲)。
- 統合 endpoint 案 (§7) を採る場合: cards/exams/tombstone を 1 レスポンスで受け、1 tx で
  `db.transaction('rw', cards, exams, sync_meta)` にまとめる。

### 3.3 pull-back 配線 (flush 成功フック)

push 完了経路: `createReviewFlushController.kick` (`review-flush.ts:192-224`) のループ内 `outcome === 'ok'`
分岐 (`review-flush.ts:213` 付近) が flush 成功確定点。bulk route はサーバーで cards/study_days を更新するが
レスポンスは `{ok, failed}` のみ (`bulk/route.ts:548`) で値を返さない → mirror 反映は再 pull が必須。
変更:
- `ControllerDeps` (`review-flush.ts:127-136`) に `onFlushed?: () => void` 相当を追加し、`outcome === 'ok'`
  (および `study_days` も戻すなら同時) で pull-back kick。配線は `review-flush-trigger.tsx` 側で
  `createReviewFlushController({ onFlushed: () => pullCardsDelta() })` を渡す。
- pull-back は cards delta pull (FSRS 後の due/stability/updated_at) + study_days pull (確定事項「cards 等」)。
  pull-back も 3.5 の in-flight guard / Web Locks を通す (二重 pull 防止)。
- dashboard dueCount は `useLiveQuery` (`dashboard-actions.tsx:33`) のため、pull-back の Dexie 書込が
  再 mount 不要で live 反映 (調査1 軸7)。

### 3.4 トリガー拡張 (mount + visibilitychange + online)

現状: `pull-trigger.tsx:22` は `useEffect(..., [])` で mount 1 回のみ。push 側 `review-flush-trigger.tsx:46-57`
は visibilitychange(visible)/online を listener 登録。
変更:
- `PullTrigger` を push trigger と同型に拡張: mount + visibilitychange(visible) + online で pull kick、
  unmount で listener 解除。

### 3.5 pull in-flight guard + 多タブ Web Locks

現状: pull 側はガード皆無 (調査2 軸2)。push 側に流用元:
- Web Locks: `runGuardedFlush` / `MinimalLockManager` / `resolveLocks` / `FLUSH_LOCK_NAME`
  (`review-flush.ts:33,64,78,90,102`)、`ifAvailable:true` skip semantics。
- in-flight: `inFlightEventIds` Set (`review-events.ts:218`) / controller の `running`+`rerunRequested` coalesce
  (`review-flush.ts:157-224`)。
変更:
- pull 用 lock 名 (例 `recallmint:pull`) で Web Locks を被せる。`resolveLocks`/`MinimalLockManager` は
  push と共有できるよう必要なら共通 util へ抽出 (過度な抽象化は避け、まず複製でも可 — §7 ではなく plan 判断)。
- 1 タブ内 in-flight guard: pull orchestrator (cards/exams/tombstone を束ねる新 helper) に `running` flag を持たせ、
  実行中の重複 kick を coalesce (push controller と同型、軽量実装でよい)。
- `ifAvailable:true` skip は、`useLiveQuery` のクロスタブ IDB 書込購読でリーダー 1 タブの書込が他タブへ伝播する
  前提のもとで UX 問題なし (調査2 軸2)。

---

## 4. exams Dexie 化 (試験一覧 UI 切替)

現状: `exams/page.tsx` は RSC で `getActiveExamsWithCardCount(userId)` (exams + card_count、archived_at IS NULL、
updated_at DESC、`lib/exams/list.ts:46`) と `getExamStatusMap(userId)` (OCR バッジ) を引き、`<ul>` で
name / `ExamStatusBadge` / cardCount / `formatRelativeJa(updatedAt)` / 詳細 Link / `DeleteExamButton` を描画。
exams mirror を読む client は現状ゼロ (調査1 軸7)。

変更 (切替範囲は §7 で選択肢提示、推奨: list 部分のみ client 抽出):
- `<ul>` の exam list 描画を client component (例 `ExamListLive`) に抽出し、`useLiveQuery` で Dexie から:
  - exams: `where archived_at IS NULL` 相当 (Dexie 上は `archived_at == null` filter) を updated_at DESC sort。
  - cardCount: cards mirror を `exam_id` で count (確定事項、`exams.card_count` 列は読まない)。
  - updatedAt 表示: `ClientExam.updated_at` (ISO string) を `Date` 化して `formatRelativeJa` (`format.ts`、client-safe)。
- RSC (`exams/page.tsx`) は残す: auth、`getExamStatusMap` → `ExamStatusProvider` の初期値 (OCR status は
  サーバー由来で Dexie 非対象)、`CreateExamForm`、空状態 CTA。`ExamStatusBadge` は従来どおり client polling。
- 未 pull / `useLiveQuery` undefined 中は skeleton (dashboard と同方針、layout shift 防止)。
- **試験詳細 page (`exams/[id]/page.tsx` の `getCardsForExam`) は本機能スコープ外** (一覧のみ切替)。
  詳細は引き続き Postgres 直読み。

---

## 5. 接続点一覧 (実コード)

| 領域 | 接続点 (file:関数/行) |
|---|---|
| cards pull route | `app/api/cards/pull/route.ts:18` GET / `lib/db/cards-pull.ts:22` getAllCardsForUser / `lib/db/cards-mapper.ts` toClientCard |
| exams pull route | `app/api/exams/pull/route.ts:13` GET / `lib/db/exams-pull.ts:26` getAllExamsForUser / `:12` toClientExam |
| tombstone query | `lib/db/schema.ts:631` tombstones / index `tombstones_user_deleted_idx` |
| cursor (client) | `lib/sync/sync-meta.ts:12` SYNC_META_KEYS / `:21` getSyncMeta (未使用→新規 caller) |
| 増分 merge | `lib/sync/cards.ts:52` pullAllCards / `lib/sync/exams.ts:39` pullAllExams |
| クロック (a) | `app/(app)/app/exams/[id]/_actions/update-card-field.ts:142` |
| クロック (b) | `app/api/review-events/bulk/route.ts:333` |
| クロック (c) | `app/(app)/app/exams/[id]/_actions/delete-card.ts:64` / `_actions/delete-exam.ts:71` |
| pull-back hook | `lib/sync/review-flush.ts:213` (outcome==='ok') / `:127` ControllerDeps / `review-flush-trigger.tsx:25` |
| トリガー | `app/(app)/app/_components/pull-trigger.tsx:22` / push 同型は `review-flush-trigger.tsx:46-57` |
| Web Locks 流用 | `lib/sync/review-flush.ts:33,64,78,90,102` / in-flight `lib/sync/review-events.ts:218` |
| exams 一覧 UI | `app/(app)/app/exams/page.tsx:40-101` / `lib/exams/list.ts:46` / `lib/exams/format.ts` formatRelativeJa |
| 既存 mirror 消費 | cards: `dashboard-actions.tsx:33` (live) / `get-dexie-session-cards.ts:23` (mount一発) ; study_days: `dashboard-stats.tsx:28` |

---

## 6. 実装順 素案 (依存関係順、粒度は大枠)

1. **クロック統一** (§2.4): (a)(b)(c) の打刻を `now()` 化。schema 不変・単体で安全に先行可、後続 cursor の前提を作る。
   既存 test (update-card-field / bulk route / delete-card / delete-exam) の updated_at/deleted_at 検証を
   `now()` 経路に合わせて更新。
2. **server pull の差分対応** (§2.1-2.3): DB 入口に `since` + `maxUpdatedAt` 返却、route の `?since` 受領、
   tombstone 返却 (endpoint 形は §7 確定後)。`now` フィールド廃止。
3. **client cursor read + 増分 merge** (§3.1-3.2): cursor 3 本独立 read/write、clear 撤去 + upsert +
   tombstone bulkDelete を 1 tx。レスポンス validation を `maxUpdatedAt` に変更。
4. **pull ガード + トリガー拡張** (§3.4-3.5): in-flight guard + Web Locks + visibility/online。
5. **pull-back 配線** (§3.3): flush 成功フックに cards/study_days pull-back 相乗り。
6. **exams Dexie 化 UI** (§4): 一覧 `<ul>` を `ExamListLive` に抽出、cardCount を cards mirror 算出。

（各段で `superpowers:requesting-code-review` 必須経路 + `[reviewed]`。クロック (c)/削除・pull-back は
CLAUDE.md「重要 Fix の裏取り」対象 = 削除/外部副作用に該当しうるため OT 実機確認後に [reviewed]。
詳細タスク分割は後続 plan。)

---

## 7. spec 段階で未確定の細部 (選択肢、OT 判断要)

### 7-1. next-cursor (max) の算出場所
- **(A) 推奨: DB 入口関数** (`getAllCardsForUser`/`getAllExamsForUser`) が `{ rows, maxUpdatedAt }` を返す。
  WHERE 強制点に集約、追加クエリ不要 (rows から max)。
- (B) route で map 後の `ClientCard[]` から `reduce` で max。
- (C) SQL `max(updated_at)` を別 select (round-trip +1、却下寄り)。

### 7-2. tombstone の返し方: 同梱 vs 統合 endpoint
- **(A) 推奨: 統合 `/api/pull`** — cards delta + exams delta + tombstone delta + 3 cursor を 1 round-trip。
  1 tx merge / 単一 Web Lock / スナップショット整合と相性良。既存 2 endpoint は段階移行 or 廃止。
- (B) 既存 `/api/cards/pull`・`/api/exams/pull` を温存し、tombstone 専用 `/api/tombstones/pull` を新設
  (tombstone 1 ストリームに合致、変更局所化)。cards/exams pull は tombstone を含まない。
- (C) cards/pull が card tombstone、exams/pull が exam tombstone を同梱 (tombstone を 2 分割するため
  「deleted_at cursor 1 本」確定事項と整合しづらい、却下寄り)。

### 7-3. exams 一覧 UI の切替範囲
- **(A) 推奨: list 部分のみ client 抽出** (`ExamListLive`)。RSC は statusMap/CreateExamForm/空状態を保持。
- (B) page 全体を client 化 (OCR statusMap の初期 seed をどう client に渡すか追加検討要)。

### 7-4. pull-back の対象範囲
- flush 成功で cards のみ戻すか、study_days も戻すか (確定事項は「cards 等」)。study_days は据え置き方針だが
  pull-back では full-window 再取得が安価なため同時取得を推奨 — OT 確認。

### 7-5. `now` フィールド廃止に伴う既存 study_days helper
- study_days は据え置きだが `study-days/pull` も `now` を返す (`study-days-pull` 経由)。本機能で cards/exams のみ
  `maxUpdatedAt` に変える場合、study_days helper の validation を据え置くか統一するか (整合性のための軽微判断)。
