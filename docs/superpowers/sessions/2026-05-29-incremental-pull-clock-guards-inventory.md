# 演習読込 増分 pull 化 — 追加棚卸し (クロック源 / pull 側ガード)

- **日付**: 2026-05-29
- **目的**: 増分 pull spec の前段。前回 `2026-05-29-incremental-pull-inventory.md` の続きで、
  設計判断に必要な 2 事実を実コード根拠で確定する。
- **スコープ**: 実装変更なし・推測禁止。設計判断 (揃え方 / ガード採用) は**確定しない**、影響整理のみ。

---

## 軸1. タイムスタンプのクロック源

cursor は cards/exams の `updated_at` と tombstone の `deleted_at` を跨いで比較する。各列が
**DB クロック (Postgres `now()`)** か **アプリ実行環境クロック (Vercel function の Node `new Date()`)** の
どちらで打刻されるかを書込経路別に確定した。

### DDL の default
- `cards.updated_at` / `exams.updated_at`: `timestamp with time zone DEFAULT now() NOT NULL`
  (`drizzle/migrations/0000_keen_the_hunter.sql:40,79` 他)。→ **INSERT 時に値省略なら DB クロック**。
- `tombstones.deleted_at`: `timestamp with time zone NOT NULL` (`0014_living_may_parker.sql:6`)、
  **DEFAULT なし** → アプリが必ず値を供給。

### 書込経路別クロック表

| 列 | 書込経路 | 供給値 | クロック |
|---|---|---|---|
| `cards.updated_at` | INSERT (OCR `process.ts:532` / 手動 `create-card.ts:67`) — values に updatedAt 無し | DDL `DEFAULT now()` | **DB** |
| `cards.updated_at` | inline 編集 `update-card-field.ts:142-145` `.set(built.data)` (updatedAt 含まず → schema `.$onUpdate(()=>new Date())` 発火) | `new Date()` | **App** |
| `cards.updated_at` | bulk push FSRS `bulk/route.ts:333` `updatedAt: sql\`${toPgTimestamptz(new Date())}::timestamptz\`` | `new Date()` を ISO 化 | **App** |
| `exams.updated_at` | INSERT (`create-exam.ts:52` / `process.ts:333`) | DDL `DEFAULT now()` | **DB** |
| `exams.updated_at` | 全 UPDATE 経路 (`create-card.ts:76` / `process.ts:542` / `delete-card.ts:79`) は `updatedAt: sql\`${exams.updatedAt}\`` で**凍結** | 既存値据置 | 移動しない |
| `tombstones.deleted_at` | `delete-card.ts:64` `deletedAt: new Date()` / `delete-exam.ts:71-78` `const now = new Date()` | `new Date()` | **App** |

(参考: `users.deleted_at` は `clerk/route.ts:221` で `sql\`now()\`` = DB クロックだが users は pull 対象外。
`source_documents.completed_at` も `process.ts:597` `sql\`now()\`` だが pull 対象外。)

### 特記事項 (事実)
- **`cards.updated_at` はクロック混在**: 生成時 = DB クロック、以後の編集 / 復習 push = App クロック。
  「OCR で作られたまま一度も触られていない card」の updated_at は DB クロック、「編集 or 復習済 card」は
  App クロックになる。
- **`exams.updated_at` は実質 DB クロック固定**: INSERT 以外の全更新経路が凍結 (`sql\`${exams.updatedAt}\``)、
  かつ exam の rename / name 編集 action は**存在しない** (`update(exams)` の呼出は create-card / delete-card /
  process の card_count 凍結更新のみ。grep 確認)。→ 現状 exams.updated_at は生成時の DB クロック値から動かない。
- **`tombstone.deleted_at` は App クロック固定**。

### cursor 比較への影響 (整理のみ・確定しない)
- cursor は **App クロック由来 (tombstone.deleted_at、編集/push 済 card)** と
  **DB クロック由来 (未編集 card・全 exam の生成時刻)** を混在比較することになる。
- Vercel function (Node) と Supabase Postgres は**別ホスト**。両者のクロックは NTP 同期に依存し、
  完全一致は保証されない (通常 sub-second〜数秒の skew が起こりうる)。
- 具体的な取りこぼし筋:
  - next-cursor を「返却行の `max(updated_at)`」とした場合、その max が DB クロック由来の値で、
    直後の削除 tombstone が App クロック (= function 時計が DB より遅れていれば max より小さい deleted_at) で
    打たれると、**exclusive (`>`) cursor で当該 tombstone を取りこぼす**。
  - 逆に function 時計が進んでいれば、同一論理時刻でも App クロック行が先に見え、DB クロック行を再取得する
    (二重 merge は bulkPut 冪等なので実害は小)。
- 影響の大きさは Vercel↔Supabase の skew 幅で bound される (= 通常小だが 0 保証なし)。
- **設計選択肢 (確定しない)**: (A) cursor を inclusive (`>=`) にして取りこぼしを冪等再取得で吸収 /
  (B) 全 cursor 源を単一クロック (例: 返却を DB `now()` 基準、tombstone も `sql\`now()\`` 打刻へ統一) /
  (C) updated_at / deleted_at を別 cursor で管理し各々のクロック内で完結。

---

## 軸2. pull 周辺の既存ガード / 残骸

grep ベースで pull 経路 (`pull-trigger.tsx` / `sync/cards.ts` / `sync/exams.ts` / `sync/study-days.ts`) を
網羅確認した。

### 結論: **pull 側にはガードが一切無い**

| 観点 | pull 側の有無 | 根拠 |
|---|---|---|
| 演習セッション中の pull 抑制 | **無** | grep (`suppress`/`isStudying`/`inSession`/`skipPull` 等) 0 件 |
| interval / polling 定期 pull | **無** | `pull-trigger.tsx:22` は `useEffect(..., [])` で mount 時 1 回のみ。`setInterval` の使用は別機能のみ (下記) |
| debounce / throttle / 時刻ガード (60s 等) | **無** | sync helper に debounce/throttle/lastPull 無し。cursor (`sync_meta`) は書込のみで読み手ゼロ (前回調査) のため時刻ガードとして機能していない |
| in-flight guard / dedup | **無** | `pull-trigger.tsx` は 3 本を fire-and-forget。StrictMode 二重 mount は `clear()+bulkPut()` の atomic + 冪等で許容 (`pull-trigger.tsx` コメント) |

**pull と紛らわしいが無関係な既存 timer/guard**:
- `exam-status-live.tsx:98` `setInterval(tick, POLL_INTERVAL_MS)` — OCR 進捗バッジの `/api/exams/status` polling。
  mirror pull ではない。
- `settings/delete-button.tsx:87` `setInterval` — アカウント削除ステータス poll。無関係。
- `inline-text-field.tsx` / `inline-option-row.tsx` の debounce(500ms) / `inFlightRef` — card **編集 push** 方向。pull 無関係。
- `upload/_actions/process.ts` の advisory lock + in-flight check — OCR 並列起動の **server-side** guard。無関係。

### push 側に存在するガード (pull への流用候補)

| ガード | 実装 | semantics |
|---|---|---|
| Web Locks 多タブ排他 | `review-flush.ts:33` `FLUSH_LOCK_NAME` / `:90` `runGuardedFlush` / `:64` `MinimalLockManager` / `:78` `resolveLocks` / `:102` `locks.request(name,{ifAvailable:true},cb)` | lock 取得失敗は待たず `lock-busy` skip。非対応環境は lock 無し直 flush |
| event 単位 in-flight guard | `review-events.ts:218` `inFlightEventIds = new Set<string>()` / `:305,319,393` add/filter/delete | module-scope Set、並走 flush の二重送信排除 |
| 1 タブ内 trigger coalesce | `createReviewFlushController` の `running` + `rerunRequested` flag (`review-flush.ts:157-224`) | 実行中 kick を drop せず完了後 1 回追走 |
| 軽量 concurrent-tick guard | `exam-status-live.tsx:54-92` `let inFlight=false` (`if (stopped||inFlight) return; inFlight=true; ... finally inFlight=false`) | 同一タブ内の tick 二重起動 skip (Set より軽量な単発 pattern) |

**流用候補の整理 (確定しない)**:
- 多タブ排他: `runGuardedFlush` / `MinimalLockManager` / `resolveLocks` を pull 用 lock 名 (例 `recallmint:pull`) で
  そのまま流用可能。`ifAvailable:true` skip は、Dexie `useLiveQuery` がクロスタブ IDB 書込を購読する前提
  (前回調査 軸7) のもとでは leader 1 タブ書込→他タブ自動反映で UX 問題が出にくい。
- 1 タブ内重複 (mount + 将来 visibility/online trigger): `running`/`rerunRequested` coalesce か、
  より軽量な `exam-status-live` 型 `inFlight` boolean のいずれかを pull orchestrator に被せる。
- 現状 pull は完全無防備なため、**増分 merge 化 (clear 撤去 → cursor read/write を伴う)** では
  少なくとも 1 タブ内 in-flight guard が無いと cursor の read-then-write race が起こりうる
  (前回調査 軸6 の指摘と一致)。

---

## まとめ (本調査で確定した事実)

1. **クロック混在は事実**: cards.updated_at = DB(生成)/App(編集・push) 混在、exams.updated_at = DB 固定
   (編集 action 不在で実質不動)、tombstone.deleted_at = App 固定。cursor は App↔DB クロックを跨ぐため
   Vercel↔Supabase の skew 分の取りこぼし/再取得が起こりうる。
2. **pull 側はガード皆無**: session 中抑制 / 定期 polling / debounce / 時刻ガード / in-flight guard すべて無し。
   push 側 (`review-flush` の Web Locks・`review-events` の in-flight Set・controller coalesce・
   `exam-status-live` の inFlight boolean) が流用候補。

設計判断 (cursor のクロック統一方式・pull ガードの採否と粒度) は spec で決める。
