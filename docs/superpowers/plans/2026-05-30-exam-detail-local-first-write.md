# 試験詳細画面 local-first 書込化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (推奨) で task 単位 fresh subagent + task 間 review。steps は checkbox 同期。

**Goal:** 試験詳細 (`/app/exams/[id]`) の card 編集を、演習側で確立した outbox/flush/pull-back 機構と対称な local-first (楽観 state + Dexie 永続 outbox + 背景 flush) にする。

**Architecture:** 全 card write (field 更新 / 追加 / 削除) を Dexie `card_mutations` outbox に積み、新設 bulk endpoint `/api/card-mutations/bulk` に背景送信する。ドメインロジック (owner-scope UPDATE / `correct_answer_ids` 再生成 / `card_count` / tombstone) は既存 3 server action から共有内部関数に抽出して endpoint と共用。表示は cards mirror を `useLiveQuery` で直読み (IDB 一本、component state 二層なし)。編集は mirror へ optimistic 直書き + outbox enqueue し、表示は IDB 直読みで返ってくる。詳細画面 滞在中は ambient pull を suppress (mount で止め、unmount で必ず戻す = React cleanup 紐付け) して、単一ユーザー前提で自分の pull × 自分の編集の衝突を発生源から消す。flush 成功で pull-back (離脱後 / 再開後の最新化)。送信 orchestrator は演習の `createReviewFlushController` を deps 注入で再利用 (lock 名のみ別)。

**Tech Stack:** Next.js 15 App Router / Drizzle (Postgres) / Dexie (IndexedDB) / Web Locks / Vitest。

**全体制約 (各 task 共通、以降は参照):**
- CLAUDE.md 絶対ルール: 全 query `WHERE user_id = ?` owner-scope / 429 即停止・retry 禁止 / AI 無関係 (本 feature は AI 呼出なし) / test は実 API 禁止モック必須。
- 命名 kebab/Pascal/camel/UPPER、import 順 外→内→相対、コメントは「なぜ」。TypeScript strict。
- 各 task 完了条件は共通で「Vitest 該当 test 通過 + `pnpm build` 緑 + code-review Critical 0 + `[reviewed]` tag」。
- 段階規律: 各 Stage = plan→実装→`[no-review]` 中間 commit→OT push→stg smoke→`[reviewed]` amend。Stage 完了で停止し OT 判断待ち。
- defer (本 plan 対象外): OCC (`content_version` +1 配線、器のみ残置) / 複数人協働・CRDT・field 単位 merge (単一ユーザー前提で pull-suppress を採用、将来 multi-user 化時はマージへ置換要) / 真の offline・Service Worker。
- 衝突方針: ケース2 (他デバイス) は field 単位 LWW、`options` は配列ごと後勝ち (部分マージ不可・低リスク許容)。打刻は DB `now()` 統一済 (増分 pull step1) で client 時計ずれ回避。

---

## Stage 1: Server 受信 endpoint (`/api/card-mutations/bulk`)

**Stage スコープ:** 全 card write のドメインロジックを共有内部関数へ抽出し、冪等 bulk receiver を新設。既存 server action 直叩き path は温存 (UI 無改修)。
**区切り (smoke):** REST/curl で update/create/delete mutation を POST → DB 反映 (cards 値 / `card_count` / tombstone) + `card_mutations` log 行 + 同 `mutation_id` 再 POST が no-op を確認。UI は従来通り動作。
**依存:** なし (起点)。

### Task 1.1: ドメインロジックの共有内部関数抽出
- **目的:** `update-card-field.ts` / `create-card.ts` / `delete-card.ts` の core を `lib/cards/apply-card-mutation.ts` 等に `tx` 受取の純関数 (`applyCardFieldUpdate` / `applyCardCreate` / `applyCardDelete`) として抽出、各 server action はそれを呼ぶ薄い wrapper に。
- **制約:** **logic 不変** (列・正規化・`correct_answer_ids` 再生成・`card_count` 増減・tombstone `onConflictDoNothing` を一字一句保つ)。owner-scope 全 statement 維持。`buildSetClause` は export して再利用。
- **完了条件:** 既存 3 action の test が全通過 (挙動 invariance) + 共通条件。

### Task 1.2: bulk endpoint payload schema + 認証 + 冪等 dedup
- **目的:** `app/api/card-mutations/bulk/route.ts` 新設。zod で `{ mutations: Array<{ mutation_id, card_id, op:'update_field'|'create'|'delete', patch }> }` を検証 (`review-events/bulk` と対称、`max(1000)`)。Clerk 不在 401。各 mutation を `card_mutations` に `mutation_id` UNIQUE + `ON CONFLICT DO NOTHING` で記録し、未適用分のみ apply 対象に。
- **制約:** `runtime='nodejs'`。429 は本 endpoint では発生しないが他失敗は `failed[]` に積み 200 返却 (review-events と同方針)。`serializeDbError` で log。
- **完了条件:** schema 単体 test + dedup (再 POST で `applied` 0 件) test 通過 + 共通条件。

### Task 1.3: op 別 apply 配線 + createCard 冪等化
- **目的:** endpoint 内で op に応じ Task1.1 の純関数へ dispatch。`create` は client 生成 `card_id` を PK に `INSERT ... ON CONFLICT (id) DO NOTHING` + 実 insert 時のみ `card_count += 1` (RETURNING で判定)。`update_field` は `buildSetClause` 検証後 UPDATE。`delete` は tombstone + DELETE + `card_count -= 1` (既存 idempotent path)。
- **制約:** orphan / 他 user card は `failed[]`、owner-scope。create の `card_count` 二重加算を RETURNING 有無で厳密回避。
- **完了条件:** 3 op × (新規適用 / 冪等再送) の endpoint 統合 test 通過 + 共通条件。

---

## Stage 2: Client outbox + flush engine + ambient triggers

**Stage スコープ:** Dexie `card_mutations` の write/coalesce helper、flush、Web Locks guard、flush controller (演習 controller 再利用)、layout 常駐 trigger (ambient + pagehide)。**まだ編集 UI には未配線** (UI は従来 server action のまま)。
**区切り (smoke):** DevTools console で mutation を 1 件 enqueue → タブ復帰 (visibilitychange) で background flush → server (Stage1) 適用 + Dexie `sync_status='synced'` + flush 成功で pull-back 発火 (Network に `/api/pull`) を確認。
**依存:** Stage 1 (送信先 endpoint)。

### Task 2.1: card_mutations Dexie write/coalesce helper
- **目的:** `lib/sync/card-mutations.ts` 新設。`enqueueCardMutation` は `(card_id, field)` 単位 coalesce (同 key の pending を最新 patch で上書き = 深さ1 永続版)。`getPendingCardMutations` / `markCardMutationsSynced` / `markCardMutationsAttempted` / `dropStalePendingCardMutations` を `review-events.ts` の対応 helper を手本に実装。
- **制約:** ブラウザ専用 (`getClientDb` server throw)。timestamp は ISO string。`mutation_id` は `newId()` (crypto.randomUUID)。
- **完了条件:** coalesce (同 field 2 回 enqueue → pending 1 行最新値) / pending 取得 / synced 化 test 通過 + 共通条件。

### Task 2.2: flush + Web Locks guard
- **目的:** `flushAllPendingCardMutations` (pending を bulk payload 化 → POST → `failed` 差分で synced/pending 振分け、`FlushResult` 互換 shape 返却) + `runGuardedCardMutationFlush` (新 lock 名 `recallmint:card-mutations:flush` + `ifAvailable` skip)。in-flight guard は `inFlightMutationIds` module set。
- **制約:** `classifyFlushResults` (review-flush) を再利用 (429→rate-limited 即停止 / 5xx→transient / 4xx→permanent)。多重送信は `mutation_id` UNIQUE + in-flight + lock の 3 重で防止。
- **完了条件:** 成功 synced / 部分 failed 残置 / lock-busy skip / 429 即停止分類 test 通過 + 共通条件。

### Task 2.3: flush controller 再利用 + layout 常駐 trigger
- **目的:** `createReviewFlushController` を `runGuarded=runGuardedCardMutationFlush` / `onFlushed=()=>pullBack('card-mutation-flush')` / `log` override で**そのまま再利用**。`app/(app)/app/_components/card-mutation-flush-trigger.tsx` を新設し `(app)` layout に mount: ambient (mount/visibilitychange/online) `kick` + best-effort `pagehide` flush + unmount で `stop()`。
- **制約:** controller は closure scope で timer 保持 (layout 持続性に依存、`ReviewFlushTrigger` と同型)。interval polling は入れない。`pagehide` は同期 best-effort (await しない)。
- **完了条件:** trigger の各イベントで `kick` 呼出 / unmount で listener 解除・`stop` test 通過 + 共通条件。

---

## Stage 3: 詳細滞在中の pull-suppress + 入口 pull kick

**Stage スコープ:** layout 常駐 `PullTrigger` / `runGuardedPull` の ambient 発火を、試験詳細 滞在中だけ止める suppress gate を新設。詳細 mount で suppress on・unmount で必ず off (cleanup 紐付け)。詳細 mount で `runGuardedPull` を 1 回明示 kick (入口 fresh pull) は維持。
**区切り (smoke):** 詳細滞在中は visibilitychange / online で pull が発火しない / 離脱後は再び発火する / 入口で 1 回 pull が走る、を Network で確認。
**依存:** なし (Stage 1/2 と独立。pull 機構のみに閉じる)。

### Task 3.1: ambient pull の suppress gate
- **目的:** layout 常駐 `PullTrigger` の ambient kick (mount / visibilitychange / online) を抑止できる suppress フラグを新設し、`PullTrigger` がフラグ on の間は `runGuardedPull` を呼ばないようにする。実装手段 (module-scope フラグ / React context / `usePathname` 判定) は最小のものを Generator 判断 (最有力: module-scope の `suppressAmbientPull` カウンタ + `PullTrigger` 側参照、test 容易性優先)。
- **制約:** 入口 kick (Task 3.2) と flush 後 pull-back は suppress の対象外 (明示 kick は常に通す)。suppress 中の visibilitychange / online は「無視」であって queue しない (離脱後の次トリガで自然回復)。フラグ既定値は off。
- **完了条件:** suppress on で ambient kick が `runGuardedPull` を呼ばない / off で呼ぶ / 明示 kick は on でも通る test 通過 + 共通条件。

### Task 3.2: 詳細 mount/unmount への suppress 紐付け + 入口 kick
- **目的:** 試験詳細 page 配下の client 境界に、mount で suppress on + `runGuardedPull({reason:'exam-detail-mount'})` を 1 回 kick、**unmount で必ず suppress off** を `useEffect` cleanup に紐付ける専用小 component (例 `exam-detail-pull-gate.tsx`) を新設し配線。
- **制約:** cleanup での off は解除し忘れを構造的に防ぐ唯一経路 (early return / 例外でも React が cleanup を保証)。入口 kick は fire-and-forget・silent。StrictMode 二重 mount でも guard と冪等 off で副作用なし。
- **完了条件:** mount で suppress on + kick 1 回 / unmount で suppress off / 二重 mount でも最終 off 保証 test 通過 + 共通条件。

---

## Stage 4: 編集 UI の local-first 化 (cutover)

**Stage スコープ:** cards mirror を `useLiveQuery` で直読み + 各編集操作を「mirror 楽観直書き + outbox enqueue」に統一 (component state 二層を撤去)。debounce を「送信遅延」から「drain」へ移設。server action 直叩きを撤去。
**区切り (smoke):** 詳細 page で text/options 編集・カード追加・削除 → UI 即時反映 (IDB 直読み) → reload で編集が永続 (Dexie) → 数秒後 server 反映 + 一覧の `card_count` 整合。**背景 pull を再開させた状態 (離脱→再入場後) でも編集が IDB 直読みで正しく反映**。mobile view 動作検証。
**依存:** Stage 1〜3 全て。

### Task 4.1: cards mirror を useLiveQuery で直読み
- **目的:** 詳細 page の cards 表示 source を server fetch から **Dexie cards mirror の `useLiveQuery` 直読み** に切替 (exam 単位 + owner-scope + sort)。表示の真実を IDB 一本にし、component state の二層管理を撤去。Dexie 0 件 / SSR は server fetch を初期 fallback。
- **制約:** 表示は IDB 直読みで返ってくるので楽観値の二重保持はしない。owner-scope。`useLiveQuery` の購読は詳細滞在中のみ (Stage3 の suppress で背景 pull は止まっているため購読更新は自分の編集起因のみ)。
- **完了条件:** mirror 変化が live 反映 / exam filter・sort 正しい test 通過 + 共通条件。

### Task 4.2: inline-text-field / inline-option-row を mirror 直書き + outbox 配線へ
- **目的:** `inline-text-field.tsx` / `inline-option-row.tsx` の `send` を `updateCardField` 直叩きから「**mirror 直書き (Dexie cards patch) + `enqueueCardMutation` (op='update_field')**」に置換。`scheduleSend` の 500ms debounce は**送信遅延ではなく outbox drain trigger** (`runGuardedCardMutationFlush`) に移設。表示は `useLiveQuery` で返るため component state への楽観二重書きは撤去。
- **制約:** 入力中フィールドのカーソル保護は既存の編集中/送信中 dirty-guard (外部値で上書きしない) を流用。coalesce で連続入力は最新値のみ pending。`correct_answer_ids` は server 再生成 (client は送らない、Stage1 踏襲)。失敗時の rollback は mirror を server 確定値へ戻す形に再構成。
- **完了条件:** 編集→mirror 直書き→live 反映 / debounce 後 drain / 失敗 rollback の test 通過 + 共通条件。

### Task 4.3: createCard / deleteCard の local-first 化
- **目的:** `inline-card-list.tsx` の追加を client 生成 id + `buildEmptyCard` で mirror 即時 insert + outbox enqueue (op='create') + exam mirror の `card_count` 楽観 ++、`delete-card-button.tsx` の削除を mirror remove + outbox enqueue (op='delete') + `card_count` 楽観 --。server action 直叩き (`createCard`/`deleteCard`) と `revalidatePath` を撤去。
- **制約:** 追加直後の新 card 問題文 cell auto-edit (`autoEditOnMount`) は client id 即時採番で維持。`card_count` は server 適用後 pull-back で確定収束。最後の 1 枚削除許容。
- **完了条件:** 追加/削除の楽観反映 + outbox enqueue + reload 永続 test 通過 + 共通条件。

### Task 4.4: 旧 server action 撤去棚卸し + dead 確認
- **目的:** cutover 後に dead 化した `updateCardField`/`createCard`/`deleteCard` の server action wrapper・関連 test の生死を grep で確定し、dead なら撤去 (内部純関数 Task1.1 は endpoint が使うため残す)。
- **制約:** [[dead-code-removal-before-refactor]] 規律: 「据え置き」判断でも grep で alive/dead 確定してから撤去。撤去対象が他 route から参照される場合は残す。
- **完了条件:** dead 撤去後 `pnpm build` 緑 + 全 test 通過 + 共通条件。

---

## Self-Review

- **Spec coverage:** §2 含む全項目 = local-first write (S2/S4) / `useLiveQuery` 直読み (4.1) / 永続 outbox coalesce (2.1) / bulk endpoint 既存 logic 流用 (1.1-1.3) / createCard 冪等 (1.3+4.3) / 送信タイミング debounce-drain+ambient+pagehide+retry/429 (2.2-2.3,4.2) / 二重送信防止 (2.2) / 入口 pull kick (3.2) / 詳細滞在中 pull-suppress (3.1+3.2)。§3 ケース1 = pull-suppress で衝突を発生源から消す (3.1) + flush 後 pull-back は離脱後最新化として維持 (2.3)。ケース2 LWW = field 単位 update (1.3) に内包 + 全体制約に明記。defer (OCC / 複数人協働・CRDT / offline) = 全体制約に明記。漏れなし。
- **Type 一貫性:** `enqueueCardMutation`/`runGuardedCardMutationFlush`/`flushAllPendingCardMutations`/`applyCardFieldUpdate` 等を Stage 間で同名参照。`FlushResult`/`classifyFlushResults` は review-flush から再利用 (shape 互換)。
- **Placeholder scan:** TBD / 「適切に」等なし。各 task に具体 file path・reuse 元・完了条件。
