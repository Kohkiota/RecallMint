# 演習読込 増分 pull 化 — 実装前棚卸し調査

- **日付**: 2026-05-29
- **目的**: 演習 mirror (cards / exams / study_days) の pull を「mount 時 full snapshot 全置換」から
  「前回 cursor 以降の差分取得 + merge (削除は tombstone 反映)」へ直す設計の **spec 入力となる事実確定**。
- **スコープ**: 実装変更なし。推測禁止・実コード根拠付き。設計判断 (削除反映方式の選択等) は**確定しない**、
  選択肢と影響のみ整理。
- **関連調査**: `docs/superpowers/sessions/2026-05-29-review-events-retry-weblocks-inventory.md`
  (push 側 retry / Web Locks の前段調査)。

---

## 0. pull 対象テーブルの確定

`app/(app)/app/_components/pull-trigger.tsx:21-37` が (app) layout mount 時に **3 本**を
fire-and-forget で kick する:

- `pullAllCards()` → `/api/cards/pull` → Dexie `cards`
- `pullAllExams()` → `/api/exams/pull` → Dexie `exams`
- `pullAllStudyDays()` → `/api/study-days/pull` → Dexie `study_days`

以下、この 3 本を対象に各軸を確認する。

---

## 軸1. スキーマ実態 (cursor 利用可能列 / 更新タイミング / 削除方式)

| table | 増分 cursor 候補列 | 更新タイミング | 削除方式 |
|---|---|---|---|
| `cards` | `updated_at` timestamptz `.$onUpdate(()=>new Date())` (`schema.ts:311-314`)。`content_version` int も併存 (`schema.ts:305-306`) | bulk push が **明示的に** `updatedAt = now` を書く (`bulk/route.ts:333`)。manual create/delete は **card 行**は default now、ただし `exams.updated_at` は card 増減で凍結 (`delete-card.ts:79-80`) | **物理削除** (deleted_at 無し、`schema.ts:244` コメント) |
| `exams` | `updated_at` timestamptz `.$onUpdate` (`schema.ts:234-237`)。`content_version` int (`schema.ts:228-230`) | rename / 手動編集で bump。**ただし card_count 増減時は `updatedAt` を凍結** (`delete-card.ts:79`、create も同方針) | **物理削除** (`schema.ts:206-208`) |
| `study_days` | **updated_at 列が存在しない** (`schema.ts:440-452`、列は user_id/day/review_count/correct_count/distinct_card_count のみ) | bulk push の `onConflictDoUpdate` で counts を加算 (`bulk/route.ts:388-404`) | **行削除なし** (insert/upsert のみ。user cascade 以外で消えない) |

**増分 pull 化の影響/制約**:
- **cards / exams は `updated_at` を cursor に使える**。物理削除のため、削除の検知は updated_at では不可能 →
  tombstone (軸4) が必須。
- **exams の `updated_at` は card_count 変化で凍結される設計** (`delete-card.ts:79`、create-card 同方針)。
  card 追加/削除は exam 行を「変更」とみなさない意図。**カード件数だけ変わった exam は updated_at が動かない**ため、
  「`since` 以降の exams 差分」に card_count 変化が乗ってこない。card_count は cards 側 push か tombstone から
  client で再算出する／別途扱う必要あり。→ **設計判断ポイント (確定しない)**。
- **study_days は updated_at が無く、updated_at cursor が引けない**。一方で「直近90日 window」で常に冪等な
  full snapshot (`study-days-pull.ts:50-61`、最大90行) のため、増分化の必要性自体が薄い。
  選択肢: (A) study_days だけ現状の90日 full-window 据え置き / (B) updated_at 列を追加して増分化。

---

## 軸2. pull endpoint の構造 (?since 受領 / next-cursor 返却)

**現状**:
- `cards/pull/route.ts:18` `GET(_req: Request)` — Request を受けるが **query を一切読まない**。
  route 冒頭コメント (`route.ts:4-5`) に明記: 「Phase α では since cursor は受信するが無視 (全件返却)、
  Δ pull は Phase β 以降」。実体は `?since` parse 無し。
- `exams/pull/route.ts:13` 同様 (`GET(_req: Request)`、query 未読)。
- `study-days/pull/route.ts:18` は `GET()` で **req 引数すら取らない**。
- DB 入口 `getAllCardsForUser` は `where(eq(cards.userId, userId))` のみ (`cards-pull.ts:22-26`)、
  `getAllExamsForUser` 同様 (`exams-pull.ts:26-30`)。`getAllStudyDaysForUser` は
  `userId` + `day >= 90日下限` (`study-days-pull.ts:50-61`)。
- レスポンスの `now` フィールドは **`new Date().toISOString()` (= サーバー wall-clock)** で、
  返却行集合の `max(updated_at)` ではない (`cards/route.ts:43`、exams/study-days 同形)。

**増分 pull 化に要する変更点**:
- `?since` 受領: route で `new URL(req.url).searchParams.get('since')` を parse + ISO 検証し、
  `getAllCardsForUser(userId, since)` へ渡す。DB 入口に `since ? gte(cards.updatedAt, since)` を AND する。
  (study-days は req 引数の追加が必要)。
- **next-cursor 設計の落とし穴**: 現状の `now`= wall-clock を cursor に使うと、
  「クエリ実行〜レスポンス生成の間に commit された行 (updated_at < now だが SELECT に乗らなかった行)」を
  取りこぼす危険。best practice 準拠なら **返却行の `max(updated_at)` を next-cursor として返す**か、
  tx snapshot 時刻を使う。接続点: `getAllCardsForUser` が rows を持っているので max 算出は容易
  (mapper or route で `rows.reduce`)。0 件返却時は cursor を据え置く運用も要設計。

---

## 軸3. client helper (全置換→増分 merge / cursor の現状)

**現状 (3 helper 完全同型)**:
- `pullAllCards` (`sync/cards.ts:52-78`): tx 内で `db.cards.clear()` → `bulkPut(cards)` →
  `setSyncMeta(lastCardPullAt, now)`。`pullAllExams` (`sync/exams.ts:57-63`)、
  `pullAllStudyDays` (`sync/study-days.ts:71-80`) も `clear()+bulkPut()+put(cursor)` を 1 tx で実行。
- 失敗時不変性: network throw / non-2xx / body 不正のいずれも Dexie / sync_meta を touch しない
  (`cards.ts:55-67`)。

**cursor (sync_meta) の現状 — 「書いてあるが未使用」の真偽**:
- **真**。`SYNC_META_KEYS.lastCardPullAt / lastExamPullAt / lastStudyDayPullAt` は各 helper で
  `setSyncMeta`(= 書込) されるが、`getSyncMeta` (`sync-meta.ts:21-27`) の **呼出元は存在しない**
  (grep: 定義 + コメントのみ、production caller ゼロ)。cursor は dead-write 状態。

**全置換→増分 merge (upsert) の影響範囲**:
- `clear()` を撤去し `bulkPut()` のみにする (Dexie `bulkPut` は PK=id の **upsert**)。
- **削除が一切反映されなくなる** — clear() が唯一の削除反映機構だったため。→ tombstone を読んで
  `db.cards.bulkDelete(deletedIds)` を同 tx で適用する必要 (軸4)。
- cursor を **読む側を新設**: pull 前に `getSyncMeta(lastCardPullAt)` → `?since=` に乗せる。成功時に
  返却 next-cursor を `setSyncMeta`。merge upsert + tombstone delete + cursor 書込を **1 tx** に包んで
  現状の失敗時不変性を維持する。

---

## 軸4. tombstone を読む側

**スキーマ** (`schema.ts:631-649`、migration `drizzle/migrations/0014_living_may_parker.sql`):
- 列: `id` uuid PK / `user_id` uuid FK cascade / `entity_type` `'exam'|'card'` / `entity_id` uuid (**FK 不可**: 対象物理削除済) / `deleted_at` timestamptz / `created_at`。
- index: `tombstones_user_deleted_idx` (user_id, deleted_at) / unique `tombstones_entity_uq` (entity_type, entity_id)。

**記録側** (着地済):
- `delete-card.ts:58-66`: card 1 件、`onConflictDoNothing`、tx 内で tombstone→DELETE→card_count−1。
- `delete-exam.ts:69-82`: exam 1件 + 配下 card 全件を **同一 `now`** で網羅 INSERT してから CASCADE 削除。

**pull endpoint が返す形 / 接続点**:
- 現状 tombstone を返す endpoint は無い。追加案: tombstones を `WHERE user_id AND deleted_at >= since` で
  引き、cards/exams pull のレスポンスに同梱 (または統合 `/api/pull`)。client は `entity_type` 別に
  `bulkDelete(entity_ids)`。`tombstones_user_deleted_idx` がそのまま使える。

**deletedAt 同値の取りこぼし / tie-break 接続点**:
- **同値は構造的に必発**: `delete-exam.ts:71` が exam+配下 card 全件に **同一 `now`** を打刻するため、
  1 回の exam 削除で N 行が同一 deleted_at を持つ。
- tie-break 接続点: `id` (uuid PK) が利用可能。選択肢 (確定しない):
  - (A) cursor を `deleted_at` のみ + **inclusive (`>=`)** にし、client 側で idempotent 適用
    (`bulkDelete` は冪等なので二重適用無害) → tie-break 不要だが境界行を毎回再送。
  - (B) keyset `(deleted_at, id)` 複合 cursor で exclusive。`tombstones_user_deleted_idx` は
    (user_id, deleted_at) 止まりで id は heap 参照になる点に留意。
- **cursor の clock 統一問題**: cards/exams の `updated_at` cursor と tombstone の `deleted_at` cursor は
  **別列・別系列**。単一 `since` で両方を比較する場合、next-cursor の前進は両ストリームの min を取るか
  別管理するか要設計 (確定しない)。

---

## 軸5. push 後 pull-back の接続点

**push 完了経路**:
`study-session-host.tsx` (mount で session 開始) → `recordAnswerEvent` (Dexie 即書込) →
`createReviewFlushController.kick` (`review-flush.ts:192-224`) → `runGuardedFlush` →
`flushAllPendingEvents` → `flushPendingEvents` (`review-events.ts:284`) → **POST `/api/review-events/bulk`**。

**サーバー側の FSRS 再計算**:
- `bulk/route.ts` の `processSession` が 1 tx で cards を UPDATE (Phase 2e、`route.ts:300-358`)、
  study_days を upsert (Phase 2f、`route.ts:363-407`)。
- **レスポンスは `{ ok: true, failed }` のみ** (`route.ts:548`)。**更新後の card 値 (FSRS 後の due/stability 等) を返さない**。
  → FSRS 後のサーバー値を mirror に引き戻すには **別途 cards pull (+ study_days pull) が必須**。

**フック点**:
- `createReviewFlushController.kick` のループ内、`outcome === 'ok'` 分岐 (`review-flush.ts:213` 付近) が
  「flush 成功確定」の唯一点。ここで pull-back (`pullAllCards`/`pullAllStudyDays`) を kick できる。
  controller に `onFlushed?: () => void` 相当の dep を足すのが最小改変 (現状 `ControllerDeps`、`review-flush.ts:127-136`)。
- **flush trigger と pull trigger は現在別 component**:
  - flush: `review-flush-trigger.tsx` が mount / visibilitychange(visible) / online で kick (`:43,47,51`)。
  - pull: `pull-trigger.tsx` は **mount のみ** (`:22`)。
  → 「相乗り」案: flush 成功後に pull-back を呼べば、現状 mount でしか走らない pull が
  visibility/online 復帰 + push 完了でも更新される。dashboard の dueCount は `useLiveQuery` (軸7) のため
  pull-back の Dexie 書込が **再 mount 不要で live 反映**される。

---

## 軸6. 多タブ排他 (push 側 Web Locks の pull 流用)

**push 側の現状**:
- Web Locks: `FLUSH_LOCK_NAME = 'recallmint:review-events:flush'`、`runGuardedFlush` が
  `navigator.locks.request(name, { ifAvailable: true }, cb)` で囲み、lock 取得失敗は
  `'lock-busy'` で **待たず即 skip** (`review-flush.ts:90-111`)。非対応環境は lock 無しで直 flush
  (server UNIQUE が二重吸収)。
- in-flight guard: `inFlightEventIds` (module-scope `Set`、`review-events.ts:218`) で event_id 単位の
  並走 POST を排除 (`review-events.ts:305-320`)。

**pull 側への流用可否 / 接続点**:
- **流用可能**。pull 用に別 lock 名 (例 `recallmint:pull`) + `ifAvailable:true` で同じ leader/skip semantics。
- 現状 pull には **lock も in-flight guard も無い** (`pull-trigger.tsx` が 3 本を fire-and-forget、
  StrictMode 二重 mount は clear+bulkPut の atomic+冪等で許容)。**増分 merge にすると** 多タブ/二重 mount で
  cursor read→write が interleave し得る (cursor 巻戻り / 二重 merge) → pull 側にも排他が要る。
- 最外接続点: `pullAllX` を束ねる新 orchestrator を `runGuardedFlush` と同型で `navigator.locks.request` に
  包む。`MinimalLockManager` 型 (`review-flush.ts:64-70`) と `resolveLocks` (`:78-87`) は pull へ抽出再利用可能。
- leader election の選択 (確定しない): pull は flush と違い「skip した tab も最新を見たい」。
  ただし **Dexie の `useLiveQuery` はクロスタブ IDB 書込を購読**するため、leader 1 タブが書けば
  他タブの dashboard 件数は自動更新される → `ifAvailable` skip でも UX 上問題ない可能性が高い。

---

## 軸7. UI 読込経路 (全置換前提か / 増分 merge で壊れないか)

**Dexie mirror の消費側 (網羅確認済)**:
| mirror | 消費 UI | 読み方 |
|---|---|---|
| `cards` | `dashboard-actions.tsx:33-47` (dueCount) | `useLiveQuery` + `where(user_id).filter(due<=now).length` |
| `cards` | `study-session-host.tsx` → `get-dexie-session-cards.ts:23-38` | **mount で 1 回** (`useState`/`useEffect`、live ではない)。`filter(due<=now).sort(due).slice(limit)` |
| `study_days` | `dashboard-stats.tsx:28-34` | `useLiveQuery` → `getStreakStatsFromDexie` |
| `exams` | **無し** | 試験一覧/詳細は Postgres 直読み (`exams/page.tsx` `getActiveExamsWithCardCount`、`exams/[id]/page.tsx:34` `getCardsForExam`)。**Dexie exams mirror を読む client は 0 件** (grep 確認) |

**全置換前提の有無 / 増分 merge upsert で壊れるか**:
- いずれの reader も **query ベース** (`where user_id` + `filter due` + JS sort)。`clear()` 由来の
  「table 全体が真実/挿入順依存」前提は無い。id は PK で安定、`bulkPut` は id upsert → **並び順・id 安定性は無傷**。
- **削除反映の見え方**: 現状は clear()+bulkPut で次 mount pull 時に消える。増分化後は tombstone の
  `bulkDelete` 適用時点で消える。dueCount (live) / session cards (mount) とも「削除済 id が消える」だけで
  破綻しない。万一 tombstone 適用漏れがあっても、削除済 card は server に無いため push 時 `failed[]` で
  **安全に degrade** (`bulk/route.ts` orphan exclusion `:184-192`)。
- **特記**: exams mirror は現状 **誰も読んでいない write-only dead mirror**。exams を増分化する価値は
  「将来 exams 一覧を Dexie 化する」前提が無い限り低い → 優先度判断の材料 (確定しない)。

---

## まとめ (設計で決める論点・確定しない)

- A. **削除反映方式**: tombstone cursor を (A) inclusive `deleted_at` + client 冪等適用 / (B) `(deleted_at,id)` keyset exclusive。
- B. **cursor の clock 統一**: updated_at (cards/exams) と deleted_at (tombstone) を単一 since にするか別管理か。
- C. **next-cursor 源**: wall-clock `now` を捨て、返却行 `max(updated_at)` or tx snapshot に切替。
- D. **study_days の扱い**: updated_at 不在のため (A) 90日 full-window 据え置き / (B) updated_at 列追加。
- E. **exams の card_count**: updated_at 凍結により exams 差分に乗らない card_count をどう同期するか。
- F. **exams mirror**: 現状 dead read。増分化の優先度。
- G. **pull-back 配線**: flush 成功 (`outcome==='ok'`) フックに pull-back 相乗り / pull 側 Web Locks 排他の導入。
