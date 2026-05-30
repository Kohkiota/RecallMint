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

**統合 `/api/pull` endpoint を新設する** (§7-B 確定)。cards delta + exams delta + tombstone delta +
ストリーム別 3 cursor (= 各 maxUpdatedAt/maxDeletedAt) を **1 round-trip** で返す。既存
`/api/cards/pull`・`/api/exams/pull` は段階移行のうえ最終的に廃止する (§6 step 7)。

### 2.1 統合 endpoint の `?since` 受領 (ストリーム別)

現状: `cards/pull/route.ts:18` `GET(_req: Request)` は req を無視 (コメントに「Phase α は since 無視」明記)、
`exams/pull/route.ts:13` 同様。DB 入口 `getAllCardsForUser` は `where(eq(cards.userId, userId))` のみ
(`cards-pull.ts:22-26`)、`getAllExamsForUser` 同 (`exams-pull.ts:26-30`)。

変更:
- `/api/pull` route で `new URL(req.url).searchParams` から **ストリーム別の since を 3 本**受領
  (例 `?since_cards=&since_exams=&since_tombstone=`)。各々 ISO8601 検証 (不正/欠落は当該ストリームのみ
  「since 無し = 全件」に fallback、= 初回 pull)。
- DB 入口に `since?: string` を足し、指定時は `and(eq(userId), gte(cards.updatedAt, sinceDate))` を適用
  (**inclusive `>=`**)。exams 同様。tombstone は別ストリーム (2.3)。

### 2.2 next-cursor (max) の算出 — DB 入口が `{ rows, maxUpdatedAt }` を返す

確定 (§7-A): next-cursor = 返却行の `max(対象列)`、**算出は DB 入口関数**
(`getAllCardsForUser`/`getAllExamsForUser` 相当) が `{ rows, maxUpdatedAt }` を返す形にする。
WHERE 強制点に集約し、別クエリを足さず rows から max を取る。0 件は `maxUpdatedAt = null` →
client は当該 cursor を据え置く。route は wall-clock `now` を**使わない**。

統合レスポンス形 (案):
```
{
  cards:      ClientCard[],      // since_cards 以降の delta (inclusive)
  exams:      ClientExam[],      // since_exams 以降の delta (inclusive)
  tombstones: { entity_type: 'exam'|'card', entity_id: string, deleted_at: string }[],
  cursors: {
    cards:     string | null,    // max(cards.updated_at)、0 件は null
    exams:     string | null,    // max(exams.updated_at)、0 件は null
    tombstone: string | null,    // max(tombstones.deleted_at)、0 件は null
  }
}
```
（旧 endpoint の `now` フィールドは新 endpoint に持ち込まない。client 側 helper の
`typeof now === 'string'` validation (`sync/cards.ts:65`) は新 endpoint 移行時に `cursors` 対応へ変更。）

### 2.3 tombstone を返す形 — 統合 `/api/pull` に同梱 (1 ストリーム)

確定 (§7-B): tombstones は単一テーブルで `entity_type ('exam'|'card')` を持ち (`schema.ts:631-649`)、
**deleted_at cursor は 1 ストリーム**。統合レスポンスに entity 別に分割せず 1 配列で同梱する。
- tombstone query: `WHERE user_id = ? AND deleted_at >= since_tombstone` (`tombstones_user_deleted_idx`
  (user_id, deleted_at) がそのまま効く)。返却に entity_type / entity_id / deleted_at。
- next-cursor = `max(deleted_at)`、0 件 null で据え置き。
- 不採用案 (記録のみ): tombstone 専用 endpoint / cards・exams pull への分割同梱 (後者は「deleted_at cursor 1 本」
  と整合しづらい)。いずれも 1 round-trip / 1 tx merge の単純さに劣るため統合に確定。

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
変更 (統合 `/api/pull` 前提・失敗時不変性を維持したまま):
- 統合レスポンス (cards / exams / tombstones / cursors) を **1 レスポンスで受け、1 tx に集約**:
  `db.transaction('rw', db.cards, db.exams, db.sync_meta, ...)`。
- `clear()` を撤去し cards/exams を `bulkPut(rows)` (Dexie bulkPut は PK=id の upsert)。
- 同 tx 内で tombstones を entity_type 別に振り分けて `db.cards.bulkDelete(cardIds)` /
  `db.exams.bulkDelete(examIds)`。
- 同 tx 内で 3 cursor (cards / exams / tombstone) を `setSyncMeta`。`cursors.* === null` (0 件) の
  ストリームは据え置き、非 null のみ更新。
- 以上 (merge upsert + tombstone delete + 3 cursor 更新) を **1 tx** に包み、現状の atomic 失敗時不変性を踏襲。

### 3.3 pull-back 配線 (flush 成功フック)

push 完了経路: `createReviewFlushController.kick` (`review-flush.ts:192-224`) のループ内 `outcome === 'ok'`
分岐 (`review-flush.ts:213` 付近) が flush 成功確定点。bulk route はサーバーで cards/study_days を更新するが
レスポンスは `{ok, failed}` のみ (`bulk/route.ts:548`) で値を返さない → mirror 反映は再 pull が必須。
変更:
- `ControllerDeps` (`review-flush.ts:127-136`) に `onFlushed?: () => void` 相当を追加し、`outcome === 'ok'`
  で pull-back kick。配線は `review-flush-trigger.tsx` 側で
  `createReviewFlushController({ onFlushed: () => pullBack() })` を渡す。
- pull-back の対象は **cards + study_days の両方** (§7-D 確定)。cards は統合 `/api/pull` の delta で FSRS 後の
  due/stability/updated_at を引き戻す。study_days は**増分化しない方針を維持**しつつ、pull-back では
  既存 `/api/study-days/pull` の **90 日 full-window 再取得を相乗り**させる (sync 方式は full-window 据え置き、
  pull-back の契機に含めるだけ)。
- pull-back も 3.5 の in-flight guard / Web Locks を通す (二重 pull 防止)。
- dashboard dueCount は `useLiveQuery` (`dashboard-actions.tsx:33`) のため、pull-back の Dexie 書込が
  再 mount 不要で live 反映 (調査1 軸7)。

> **実装時補正 (2026-05-30、step 5 実装で判明)**: 上記は pull-back hook を「controller の
> `outcome === 'ok'` のみ」と記述していたが、実コードの flush 経路は **2 系統**ある:
> (1) 背景回復 flush = `review-flush-trigger.tsx` → `controller.kick(mount/visibility/online)` (controller 経由)、
> (2) session 内 flush = `session-runner.tsx` の `flushPendingEvents` (5件閾値) / `flushAllPendingEvents`
> (session 完了) ── **後者は controller を通らず直叩き**。**通常の復習完了では session-runner が先に pending
> queue を drain する**ため、後続の controller.kick は `no-pending` を返し `onFlushed` が発火しない =
> controller hook だけでは通常フローで pull-back が走らない (controller hook は「session を中断して離脱 →
> 後で背景回復 flush が拾う」safety-net 経路でのみ発火)。
> よって pull-back hook は **各送信経路の末尾**に置く(下記）。
>
> **再々補正 (2026-05-30、step 5b 再設計 — stg smoke 観点1 FAIL を受けて)**: 上記初版(step 5)は
> (B) を「session 完了 flush 成功 = `classifyFlushResults === 'ok'`」で発火させたが、**`classifyFlushResults`
> が skip(in-flight 空振り = `attempted:0`)を `'ok'` と誤分類**するため、daily=5=`FLUSH_THRESHOLD` のとき
> 5件閾値 flush と session 完了 flush が race し、完了 flush の in-flight-skip を `'ok'` と誤認して **bulk commit
> 前に pull-back を premature 発火 → stale** を取った(`docs/superpowers/sessions/2026-05-30-incremental-pull-step5-pull-back-flush-hook-stg-smoke.md`)。
> 再設計で **発火条件を「実際に events を send して成功した(`FlushResult.syncedEventIds` 非空)」に限定**する:
> - `classifyFlushResults` の `'ok'` を「failed 無し **かつ** 実 sync ≥1 件」へ再定義(skip / session-only は
>   `'no-pending'`、retry 分類は不変)。`syncedEventIds` は bulk POST が 200(= tx commit 後)を返した後にのみ
>   set されるため、synced gate にすれば pull-back は構造的に必ず commit 後に走る。
> - hook は **3 経路すべて**の末尾に置き、各々「実 sync 成功」でのみ発火(skip / 空振り / 失敗では不発):
>   - **(A) controller `onFlushed`**(`review-flush.ts`、`outcome==='ok'`)── 背景回復 / 中断セッション safety-net。
>   - **(B) session 完了 flush**(`session-runner.tsx` の `flushAllPendingEvents` 成功時、`classifyFlushResults==='ok'`)。
>   - **(C) 5件閾値 flush**(`session-runner.tsx` の `flushPendingEvents` 成功時、`classifyFlushResults([r])==='ok'`)
>     ── daily=threshold では threshold flush が実 sync を担うため必須(step 5 初版の「(C) には付けない」を撤回 / U6 反転)。
> - race の正しい挙動: threshold flush が実 sync(→(C) で発火)/ 完了 flush は残件 0 で skip(→ 'no-pending' で不発)
>   → **commit 後に 1 回だけ pull-back**。複数経路が近接発火しても step 4 `runGuardedPull` の in-flight guard で
>   `/api/pull` は 1 本に coalesce。pull-back 実体は `lib/sync/pull-back.ts` の `pullBack(reason)`。
> (詳細: pre-investigation `docs/superpowers/sessions/2026-05-30-incremental-pull-step5-pull-back-redesign-investigation.md`、
> 再設計 plan `docs/superpowers/plans/2026-05-30-incremental-pull-step5b-pull-back-redesign.md`。)

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
  push と共有できるよう必要なら共通 util へ抽出 (過度な抽象化は避け、まず複製でも可 — 後続 plan の実装判断)。
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

変更 (§7-C 確定: list 部分のみ client 抽出):
- `<ul>` の exam list 描画を client component (例 `ExamListLive`) に抽出し、`useLiveQuery` で Dexie から:
  - exams: `where archived_at IS NULL` 相当 (Dexie 上は `archived_at == null` filter) を updated_at DESC sort。
  - cardCount: cards mirror を `exam_id` で count (確定事項、`exams.card_count` 列は読まない)。
  - updatedAt 表示: `ClientExam.updated_at` (ISO string) を `Date` 化して `formatRelativeJa` (`format.ts`、client-safe)。
- RSC (`exams/page.tsx`) は残す: auth、`getExamStatusMap` → `ExamStatusProvider` の初期値 (OCR status は
  サーバー由来で Dexie 非対象)、`CreateExamForm`、空状態 CTA。`ExamStatusBadge` は従来どおり client polling。
- 未 pull / `useLiveQuery` undefined 中は skeleton (dashboard と同方針、layout shift 防止)。
- **試験詳細 page (`exams/[id]/page.tsx` の `getCardsForExam`) は本機能スコープ外** (一覧のみ切替)。
  詳細は引き続き Postgres 直読み。

> **実装時補正 (2026-05-30、step 6 実装で確定)**:
> - **空状態 CTA は client (`ExamListLive`) が持つ**: exam 件数 (= 空状態判定) が Dexie 由来になるため、
>   RSC でなく `ExamListLive` が skeleton / 空状態 CTA / list の 3 状態を持つ (CTA 部品 `OpenCreateExamButton` /
>   アップロード Link は client で描画可)。RSC は auth / statusMap seed / `CreateExamForm` / 見出しを保持。
> - **一覧に効くサーバー変更の即時反映 = 既存成功ハンドラへの `runGuardedPull` 相乗り**:
>   list が Dexie 参照になり `router.refresh()` (RSC 再 render) では mirror が更新されないため、一覧の
>   件数・表示に影響する 5 操作の既存成功ハンドラに `void runGuardedPull({reason}).catch(()=>{})` を 1 行相乗り
>   させ mirror を pull で最新化する (新規 polling/検知/helper は作らない。既存 `router.refresh()`/`push()` は残す):
>   - OCR 完了: `exam-status-live.tsx` の `hasCompletion`(processing→completed)分岐 (`'ocr-complete'`)。
>   - 試験削除: `delete-exam-button.tsx` 削除成功 (`'exam-delete'`)。試験作成: `create-exam-form.tsx` 作成成功 (`'exam-create'`)。
>   - カード追加: `inline-card-list.tsx` createCard 成功 (`'card-add'`)。カード削除: `delete-card-button.tsx` 削除成功 (`'card-delete'`)。
>   - カード編集 (inline 編集、updated_at のみ変化) は一覧の試験名/件数に無影響のため相乗り対象外。
>   - 削除の反映は **pull kick** で行う (optimistic local delete はしない = mirror は pull でのみ書く read-only 不変条件を維持)。
>   - `pullBack` (study_days 同梱) でなく `runGuardedPull` 単体 (study_days は一覧に無関係)。
> - dead 化した `getActiveExamsWithCardCount` + `ExamWithCardCount` は撤去 (caller は本 page のみ)。
> - 流用棚卸し: `docs/superpowers/sessions/2026-05-30-incremental-pull-step6-reuse-inventory.md`。

---

## 5. 接続点一覧 (実コード)

| 領域 | 接続点 (file:関数/行) |
|---|---|
| 統合 pull endpoint (新設) | 新 `app/api/pull/route.ts` (cards/exams/tombstone delta + cursors を 1 round-trip) |
| cards DB 入口 (`{rows,maxUpdatedAt}` 化) | `lib/db/cards-pull.ts:22` getAllCardsForUser / `lib/db/cards-mapper.ts` toClientCard |
| exams DB 入口 (`{rows,maxUpdatedAt}` 化) | `lib/db/exams-pull.ts:26` getAllExamsForUser / `:12` toClientExam |
| 旧 pull route (段階移行→廃止) | `app/api/cards/pull/route.ts:18` / `app/api/exams/pull/route.ts:13` |
| tombstone query | `lib/db/schema.ts:631` tombstones / index `tombstones_user_deleted_idx` |
| study-days pull (now 削除のみ) | `app/api/study-days/pull/route.ts:43` (`now` フィールド削除) / `lib/sync/study-days.ts:65` validation |
| cursor (client) | `lib/sync/sync-meta.ts:12` SYNC_META_KEYS / `:21` getSyncMeta (未使用→新規 caller) |
| 増分 merge | `lib/sync/cards.ts:52` pullAllCards / `lib/sync/exams.ts:39` pullAllExams |
| クロック (a) | `app/(app)/app/exams/[id]/_actions/update-card-field.ts:142` |
| クロック (b) | `app/api/review-events/bulk/route.ts:333` |
| クロック (c) | `app/(app)/app/exams/[id]/_actions/delete-card.ts:64` / `_actions/delete-exam.ts:71` |
| pull-back hook (3 経路・実 sync gate、§3.3 再々補正) | 発火条件 = `classifyFlushResults==='ok'`(再定義: failed 無し かつ `syncedEventIds` 非空)。(A) controller: `lib/sync/review-flush.ts` onFlushed / `ControllerDeps` / `review-flush-trigger.tsx` ; (B) session 完了: `session-runner.tsx` `flushAllPendingEvents` 成功時 ; (C) 5件閾値: `session-runner.tsx` `flushPendingEvents` 成功時 (`classifyFlushResults([r])==='ok'`) ; 実体 `lib/sync/pull-back.ts` `pullBack(reason)` |
| トリガー | `app/(app)/app/_components/pull-trigger.tsx:22` / push 同型は `review-flush-trigger.tsx:46-57` |
| Web Locks 流用 | `lib/sync/review-flush.ts:33,64,78,90,102` / in-flight `lib/sync/review-events.ts:218` |
| exams 一覧 UI | `app/(app)/app/exams/page.tsx:40-101` / `lib/exams/list.ts:46` / `lib/exams/format.ts` formatRelativeJa |
| 既存 mirror 消費 | cards: `dashboard-actions.tsx:33` (live) / `get-dexie-session-cards.ts:23` (mount一発) ; study_days: `dashboard-stats.tsx:28` |

---

## 6. 実装順 (依存関係順、各段で stg smoke、慎重に分割)

各段の完了時に **stg smoke を挟む**前提 (DevTools MCP で Network reqid 順序 / IDB 抜粋 / console を証跡化)。
詳細タスク分割 (test 戦略・修正 logic 粒度) は後続 plan に委ねる。

1. **クロック統一** (§2.4): (a) card inline 編集 / (b) 復習 bulk push / (c) tombstone の updated_at・deleted_at を
   SQL `now()` 化。schema 不変・単体先行。既存 test (update-card-field / bulk route / delete-card / delete-exam) を
   `now()` 経路へ更新。→ stg smoke。
2. **統合 `/api/pull` 新設** (§2.1-2.3): cards delta + exams delta + tombstone delta + ストリーム別 3 cursor +
   maxUpdatedAt、ストリーム別 `?since` 受領、inclusive (`>=`)、0 件据え置き。DB 入口を `{ rows, maxUpdatedAt }` 化。
   既存 cards/exams/study-days pull はこの段では**残す**。新 endpoint を単体で検証。→ stg smoke。
3. **client 切替** (§3.1-3.2): 統合 endpoint 参照 + 増分 merge (clear 撤去 → bulkPut upsert) +
   tombstone bulkDelete + cursor 3 本 read/write を 1 tx。旧 endpoint からの移行。レスポンス validation を
   `cursors`/`maxUpdatedAt` 対応へ。→ stg smoke。
4. **pull ガード + トリガー** (§3.4-3.5): 1 タブ内 in-flight guard + 多タブ Web Locks (push 側流用、pull 用 lock 名) +
   visibilitychange / online トリガー拡張。→ stg smoke。
5. **pull-back 配線** (§3.3): flush 成功確定点フックに cards + study_days pull-back 相乗り。→ stg smoke。
6. **exams Dexie 化 UI** (§4): 一覧 list を `ExamListLive` に抽出、card_count は cards mirror 算出。→ stg smoke。
7. **後片付け**: 旧 `/api/cards/pull`・`/api/exams/pull` 廃止 + `study-days/pull` の `now` フィールド削除。→ stg smoke。

（各段で feat/fix は `superpowers:requesting-code-review` 必須経路 + `[reviewed]`。クロック (c)/削除・pull-back は
CLAUDE.md「重要 Fix の裏取り」対象 = 削除/外部副作用に該当しうるため OT 実機確認後に [reviewed]。）

---

## 7. 旧 §7 未確定事項の確定結論 (全件確定済み)

| 項目 | 確定 |
|---|---|
| **A. next-cursor 算出場所** | DB 入口関数 (`getAllCardsForUser`/`getAllExamsForUser` 相当) が `{ rows, maxUpdatedAt }` を返す。WHERE 強制点に集約、追加クエリなし。→ §2.2 反映済 |
| **B. tombstone の返し方** | 統合 `/api/pull` に確定。cards delta + exams delta + tombstone delta + ストリーム別 3 cursor + maxUpdatedAt を 1 round-trip、client は 1 tx で merge。旧 `/api/cards/pull`・`/api/exams/pull` は段階移行のうえ最終廃止 (§6 step 7)。専用 endpoint 案・分割同梱案は不採用。→ §2/§3.2 反映済 |
| **C. exams 一覧 UI 切替範囲** | list 部分のみ client 抽出 (`ExamListLive`) に確定。RSC は auth / statusMap / CreateExamForm / 空状態を保持。詳細 page はスコープ外。→ §4 反映済 |
| **D. pull-back の対象** | cards + study_days の両方を戻すに確定。study_days は増分化しない方針を維持し、pull-back では 90 日 full-window 再取得を相乗り (sync 方式は full-window 据え置き)。→ §3.3 反映済 |
| **E. study-days の `now`** | `study-days/pull` が返す `now` フィールドを削除するに確定。現状 dead-write (cursor として読まれていない) のため削除は無害で、3 endpoint の役割を明確化する掃除として §6 step 7 で実施。**削除で壊れる箇所が無いことは後続 plan で実コード確認する** (現時点の調査では `now` の read 側 caller は未検出だが、plan で grep 再確認を前提とする)。 |

本 spec に未確定事項は残っていない (確定状態)。
