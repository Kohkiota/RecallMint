# tag mirror correctness sprint(Path C)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 共有ブラウザで異 owner のローカルデータが表示されない構造保証(読み owner スコープ + sync_meta userId namespace + study_days owner 限定置換)。

**Architecture:** spec r4 = Path C(owner による空間的分離)。lock 系機構は導入しない。遅着 writer は capture した owner の namespace に書くだけで次 user に無害。

**Tech Stack:** Dexie 4.4.4 / fake-indexeddb / Vitest / Next.js App Router(**schema 変更なし。server 変更 = `/api/pull` への `owner_user_id` echo 追加のみ**)。

**Spec:** `docs/superpowers/specs/2026-08-16-tag-mirror-owner-scope-and-signout-purge-design.md`(**r5**。r4 凍結 + Codex plan review Important 2 件 / OT 裁定 3 件の最小改訂 = §5.1a owner echo / §4.2 限定 audit / §7 保証開始点 / §7a rollback 方針)

## Global Constraints

- **capture 原則(spec §5.1・凍結)**: pull の cursor read/write は開始時に受け取った userId のみ使用。「現在の user」を表す mutable な module 状態・store・hook の完了時参照は禁止。
- **key 形式(spec §4.1)**: `${base}:${userId}`。`SYNC_META_KEYS` 定数・`SyncMetaKey` 型・Dexie schema は不変。
- **旧 key(userId なし)残骸は放置**(hygiene sprint 対象)。掃除コードを足さない(scope creep 禁止)。
- 空 userId は fail-closed: `scopedSyncMetaKey` = throw / `pullDelta` `pullAllStudyDays` = fetch 前に FAIL 返却・network / Dexie 不触。
- 全 pin は TDD(red → green を task 内で実証)。**red の手法を区別する**: 新規挙動の pin = テスト先行(実装前に fail を確認)。既存コードへの保証 pin(スコープ化を外す等の変異で fail 確認)は**変異の注入位置を session doc に記録**(変異は repo に残らないため — architecture.md:186 の既存前例と同形)。TypeScript strict / 簡潔性規律。
- **rollback 方針(spec §7a・原則 roll-forward)**: 旧版が読む legacy unscoped cursor は**別 user 由来でありうる**(まさに本 sprint が解消する cursor 汚染)。ゆえに rollback は既知 bug(cursor 汚染・**under-fetch による silent 表示欠落**)を再開させる — 「over-fetch 方向で冪等だから安全」ではない。rollback する場合は**旧版が読む前に legacy unscoped cursor 6 本を削除して full pull を強制する互換 patch が必須**(patch は事前に作らない = 必要時)。同様に旧 server へ戻すと新 client は `owner_user_id` 欠落で全 pull を reject する(spec §5.1a)。
- **保証開始点(spec §7)**: 保証対象は本 bundle を実行している tab のみ。旧 bundle tab は保証外(smoke でも検証しない)。
- 各 task: 実装 + `pnpm typecheck` + 関連 vitest green + canonical/Codex review 収束 + commit(tag 規律)。データ保全に触れる fix ゆえ「重要 Fix の裏取り」適用 — push→stg smoke の順で [reviewed] amend 窓が閉じる場合は session doc を正記録(既存裁定)。
- **既存 liveness(A の pull 実行中に B の mount pull が inflight-skip / lock-busy となり次 trigger まで遅れる)は correctness 非阻害として受容 — stg smoke に visibilitychange / online 相当の再 trigger 手順を含める**(OT 裁定)。
- stg smoke(push 後・OT 指示で実施): spec §10 の手順 + 上記再 trigger。A 残骸の IDB 残存は仕様で、確認対象は「表示されないこと」。dashboard の表示確認は「dashboard 読みは既に owner スコープ済(dashboard-track fact-finding §3: `[user_id+due]` / study_days user_id 読み)」の再確認として行う(本 sprint の変更対象外)。

---

### Task 1: 読みスコープ化 — lib 層(spec §3.1 #1-3 + §3.2 guard 4 箇所)

**Files:** Modify `lib/cards/get-custom-session-cards.ts:60-61` / `lib/tags/tag-crud.ts:50,54,87,121,158`。Test: 各既存 `.test.ts`。

- 目的: `tag_categories` / `tag_options` の全店 `toArray()` を `.where('user_id').equals(userId).toArray()` へ(#1-3)。guard 対象 4 handler は名指しで固定: `handleRenameCategory`(:50)/ `handleSetCategoryColor`(:87)/ `handleRenameOption`(:121)/ `handleSetOptionColor`(:158)— 各 `.get()` 直後に `if (!before || before.user_id !== userId) return`。
- 制約: §3.3 の除外裁定(category_id / option_id / card_id-anyOf keyed 読み)には触れない。`countCategoryImpact` / `countOptionImpact` の signature 不変。挙動変化は「異 owner 行 = silent no-op」のみ。
- pin(fake-indexeddb に 2 user seed): ① `selectCustomSessionRows`(user A)の結果に B の category / option / tag が現れない ② `handleRenameCategory` の同名 check が B の同名 category と衝突しない(throw しない)③ 4 handler に B の行 id を渡すと no-op(mirror 不変・outbox enqueue なし)。
- 完了条件: 各 pin red(スコープ化を外す変異で fail)→ green。typecheck / 関連 test 通過。commit。

### Task 2: 読みスコープ化 — component 層(spec §3.1 #4-11)

**Files:** Modify `app/(app)/app/tags/_components/category-list.tsx:133` / `option-list.tsx:133` / `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:202-203` / `exam-card-table.tsx:433-434` / `app/(app)/app/study/custom/_components/custom-filter-form.tsx:66,70`。Test: 各既存 `.test.tsx`。

- 目的: 8 箇所の `toArray()` をスコープ化し、`useLiveQuery` deps `[]` の 4 site(#4/#5/#10/#11)を `[userId]` に(#6-9 は既に `[examId, userId]`)。
- 制約: 各 component は userId prop 既保有 — prop 追加・親変更なし。読み以外のロジックに触れない。
- pin(render + fake-indexeddb 2 user seed): 各 component(user A)の描画結果 / 選択肢に B の tag master が出ない。custom-filter-form はタグ絞込候補、exam-card-table / inline-card-list はタグ列・popover 系 fixture、category-list / option-list は一覧本体。
- 完了条件: 各 pin red(スコープ化を外す変異で fail)→ green。typecheck / 関連 test 通過。commit。

### Task 3: sync_meta — `scopedSyncMetaKey` + JSON helper の userId 化 + prefs per-user 化(spec §4)

**Files:** Modify `lib/sync/sync-meta.ts` / `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx:90,166`。Test: `lib/sync/sync-meta.test.ts` / `exam-detail-view.test.tsx`。

**Interfaces(Produces):**
- `scopedSyncMetaKey(base: SyncMetaKey, userId: string): string` — `` `${base}:${userId}` ``。空 userId は throw。
- `getJsonSyncMeta<T>(key: SyncMetaKey, userId: string, schema: z.ZodType<T>): Promise<T | undefined>` / `setJsonSyncMeta<T>(key: SyncMetaKey, userId: string, value: T, schema: z.ZodType<T>): Promise<void>` — 内部で `scopedSyncMetaKey` を通す。
- `setSyncMeta` は**削除**(production caller ゼロ。test のみ追随)。`getSyncMeta` の userId 化は Task 4(唯一の reader = pull.ts と同時変更)。
- **限定 audit test(spec §4.2 / OT 裁定 2)**: production コードの `.sync_meta` 直接 access を許可 file(`lib/sync/sync-meta.ts` / `lib/sync/pull.ts` — 実装時に確定)に限定する grep test。許可外 file での出現で fail。

- 目的: key 構成を builder に一元化し、`exam_view_prefs` を per-user 化(exam-detail-view は userId prop 既保有・伝播不要)。
- 制約: `SYNC_META_KEYS` / `SyncMetaKey` / schema 群(`examViewPrefsV4Schema` 等)は不変。規約「素の base 文字列で put / get を新規に書かない」は機械強制しない(architecture.md に限界ごと記録 — Task 6)。
- pin: ① `scopedSyncMetaKey('cards_cursor', 'u1')` = `'cards_cursor:u1'` / 空 userId throw ② prefs namespace — A で保存 → `sync_meta` の実 key が `exam_view_prefs:A` / B で読むと undefined(default 挙動)③ **audit** — 許可 file 外の production コードに `.sync_meta` access が無い(現状 green で開始し、以後の退行を検出する gate)。
- 完了条件: pin red → green。typecheck / sync-meta + exam-detail-view test 通過。commit。

### Task 4: pull の userId capture + cursor namespace + 伝播一式(spec §4.2 / §5)

**Files:** Modify **`app/api/pull/route.ts`(owner echo)** / `lib/sync/pull.ts` / `lib/sync/pull-back.ts` / `app/(app)/app/_components/pull-trigger.tsx` / `app/(app)/app/layout.tsx`(PullTrigger へ `user.id`)/ 入口 5 component(`exam-detail-pull-gate.tsx` / `create-exam-form.tsx` / `delete-exam-button.tsx` / `exam-title-inline-edit.tsx` / `exam-status-live.tsx` — userId prop 追加 + 親配線)/ userId 既保有 4 経路(`exam-card-table.tsx:810` / `session-runner.tsx:328,346` / `entity-mutation-flush-trigger.tsx:54` / `review-flush-trigger.tsx:29` — 引数追加のみ)。Test: `pull.test.ts` / `pull-back.test.ts` / `pull-trigger.test.tsx` + 呼び出し元の既存 test 追随(`exam-status-live` / `exam-detail-pull-gate` / `create-exam-form` / `delete-exam-button` / `exam-title-inline-edit` / `session-runner` / flush trigger 2)。

**Interfaces(Produces):**
- **server `/api/pull`**: 正常応答(`app/api/pull/route.ts:82` の `Response.json`)の top-level に `owner_user_id: user.id` を追加。**additive**(旧 client は無視)。**`emptyBody`(`:39-55`)は user 不在 path の静的リテラルゆえ追加しない**(spec §5.1a の既知副作用 — sign-up race の空応答は client が reject するが payload 空 + cursors 全 null で実害ゼロ)。route の既存 test は応答 shape の追随のみ。
- `pullDelta(userId: string, client: PullApiClient = defaultClient): Promise<PullDeltaResult>` — 冒頭 capture。cursor read(現 `:128-133`)= `getSyncMeta(key, userId)`(この task で userId 化)、cursor write(現 `:265-286`)= `scopedSyncMetaKey(base, userId)`。空 userId は fetch 前に FAIL。**tx を開く前に owner 検証**: `body.owner_user_id === userId`(欠落も不一致も FAIL)+ owner 列を持つ 5 stream(cards / exams / tag_categories / tag_options / card_tags)の全行 `user_id === userId`。違反時は **mirror / cursor とも一切書かず** FAIL 返却、log は event 名 + 件数のみ(userId / payload 内容を出さない)。tombstone は行検証不能(id のみ)ゆえ owner echo が単独で担う。
- `GuardedPullDeps` に `userId: string`(必須)追加。default pull = `() => pullDelta(deps.userId)`。guard 構造(in-flight / ifAvailable)は無変更。
- `pullBack(userId: string, reason: string): void`(`pullAllStudyDays` 呼びは Task 5 まで無引数のまま)。
- `PullTrigger({ userId }: { userId: string })` — **effect deps を `[]` → `[userId]`**(Codex Minor 1)。

- 目的: cursor 汚染の構造解消(spec §4.3)。B の pull は自 key を読み cursor 不在 = 自然 full pull。
- 制約: capture 原則(Global)。lock / guard / suppress 機構は無変更。親 RSC は全て内部 userId 保有済(prop drilling のみ)。server 変更は `owner_user_id` の 1 field 追加のみ(query / RLS / tenant tx には触れない)。
- pin: ① **cursor namespace(table-driven・6 stream 全数 = cards / exams / tombstone / tag_categories / tag_options / card_tags — Codex Minor 2)**: `${base}:A` seed 下で `pullDelta(A)` は 6 本の `since_*` を全部送る / `pullDelta(B)` は 1 本も送らない(= full)/ 応答 cursor は `${base}:B` に書かれ A の 6 key は不変 ② **capture**: client mock の fetch 解決を遅延させ、pending 中に `pullDelta(B)` を interleave しても A の invocation は `${base}:A` に書く ③ fail-fast: `pullDelta('')` = FAIL・`client.get` 不呼 ④ **PullTrigger deps**: render(userId=A)→ mount kick(A で呼ばれる)→ rerender(userId=B)→ **再 kick が B で発火**(Codex Minor 1)⑤ **owner echo(spec §5.1a)**: (a) `owner_user_id` 不一致 + **payload 空**で reject・cursor 不変 (b) **tombstone-only 応答**の `owner_user_id` 不一致で reject(行検証では捕まらない経路の実証)(c) `owner_user_id` **field 欠落**で reject (d) 5 stream いずれかの行 `user_id` 不一致で reject・**mirror 不変** ⑥ server: `/api/pull` 正常応答に `owner_user_id` が載る。
- 完了条件: pin red → green。typecheck / 上記全 test 通過(repo 全体が compile — 呼び出し元の引数漏れは typecheck が検出)。commit。

### Task 5: study_days の owner 限定置換(spec §6)

**Files:** Modify `lib/sync/study-days.ts` / `lib/sync/pull-back.ts`(`pullAllStudyDays(userId)` + **header `:13-14` の「Web Locks は runGuardedPull 側が担う」を実体に合わせ修正**)/ `app/(app)/app/_components/pull-trigger.tsx:52`(userId 伝播)。Test: `study-days.test.ts` / `pull-back.test.ts` / `pull-trigger.test.tsx`。

**Interfaces(Produces):** `pullAllStudyDays(userId: string, client?: PullApiClient): Promise<PullResult>` — 処理順: 空 userId は fetch 前に `{ok:false}`(Codex Minor 3)→ fetch → **payload 全行 `row.user_id === userId` 検証・1 行でも違反で batch 全体 reject(`{ok:false}`・Dexie 不変・log 1 行 `study_days.pull.owner_mismatch` — event 名 + 件数のみ、userId / payload 内容はログに出さない)** → 単一 rw tx で `where('user_id').equals(userId).delete()` → `bulkPut`。**検証と書込は同一配列に対して行う**(検証後に別配列を組み立てて bulkPut しない — 同一性を pin で固定)。

- 目的: 遅着 snapshot が自 owner の行だけを置換する形にし、「破壊的」writer を消す。
- 制約: server は owner 単一を強制済(棚卸し Appendix A-3)— client 検証は defense-in-depth。既存の silent FAIL 契約(early return・次トリガー再試行)に整合。cursor は無関係(full snapshot)。**同一 owner の複数 pullAllStudyDays 並走で古い snapshot が後着し新しい snapshot を上書きする鮮度退行は、既存挙動として受容し本 sprint 非対象**(異 owner 漏えいではない。次トリガーで自然回復 — Codex 論点 5 の裁定)。
- pin: ① 異 owner 生存 — A/B 両 seed 下で `pullAllStudyDays(B)` 後も A の行が全件不変 ② mixed reject — payload に A の行 1 件混入で `{ok:false}` + Dexie 完全不変(B の既存行も置換されない)③ 正常系 — B の行だけが新 snapshot に置換 ④ `pullAllStudyDays('')` = fetch 不呼・Dexie 不触(Codex Minor 3)。
- 完了条件: pin red(検証 / owner 限定 delete を外す変異で各 fail)→ green。typecheck / 関連 test 通過。commit。

### Task 6: sprint 完了 gate + architecture.md 更新(spec §10)

**Files:** Modify `docs/architecture.md`(§1 に 3 点: ① 新不変条件「client 持続状態の owner 分離は空間的(owner 列 / userId namespace key)。sync_meta は `scopedSyncMetaKey` 経由(**許可 file 限定 audit test で部分的に機械検出・key 構成の正しさまでは見ない**)・pull cursor は開始時 capture した userId を read/write 両方に使用(mutable 現在 user の完了時参照禁止)・**応答は `owner_user_id` echo と 5 stream の行 owner を検証してから書く**」② outbox owner 行の実測記述と §残余リスク行を「表示漏れは解消(correctness sprint)・at-rest 残骸の除去は hygiene sprint へ」に更新 — **全解消と書かない** ③ **保証開始点 1 行**(spec §7: 本 bundle 実行 tab に限る・旧 bundle tab は保証外))。

- 目的: 恒久記録の更新と全体 gate の通過。
- 制約: Web Locks 要件行は書かない(spec §8)。docs は `[no-review]` 可だが本 task は gate 実行を含むため報告に測定値を明記。
- 完了条件: whole-repo `pnpm lint`(--max-warnings=0)exit 0 / `pnpm test:iso` green / `pnpm run audit` exit 0 / `pnpm test` 全通過 / `pnpm typecheck` exit 0。報告 chat に「whole-repo lint exit 0 確認済」「test:iso green 確認済」「pnpm run audit exit 0 確認済」を明記。commit。

---

## 実行順とレビュー

- 依存: Task 3 → 4 → 5(builder → capture → study_days)。Task 1 / 2 は独立(先行)。
- 実装方式 = `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)。
- 各 task の review dispatch 観点に「whole-repo lint 実行確認」を含める(CLAUDE.md 恒久規律)。
- 全 task 完了 → stop checkpoint 報告で停止(push は OT)。stg smoke は push 後 OT 指示で実施(Global Constraints の手順 + 再 trigger 1 行)。
