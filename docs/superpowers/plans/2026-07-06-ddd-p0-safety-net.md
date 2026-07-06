# DDD P0 安全網 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。step 追跡は checkbox(`- [ ]`)。

**Goal:** P1 以降の behavior-preserving refactoring を機械判定できる安全網(contract/golden test + import 境界 lint + Tier 1 掃討 + baseline docs)を、挙動を一切変えずに構築する。

**Architecture:** vitest `toMatchSnapshot` で 5 契約面の現状実値を golden 固定。triage を先行させ bug 焼き込みを防ぐ。標準 `no-restricted-imports` で層違反を allowlist 付き検出。dead は Tier 1 のみ。

**Tech Stack:** vitest(snapshot)/ ESLint flat config(no-restricted-imports)/ 既存 route test の fake-tx harness 再利用。

## Global Constraints

- branch `dddrefactor`。実装 = CC(Opus)、subagent-driven。
- **挙動を一切変えない**(P0)。bug を見つけても P0 で直さない(T0 の handoff 分岐へ)。
- **凍結契約**(spec §1.4): payload / Dexie schema 形 / entity_mutations 形式 + error code・HTTP status・日本語文言・cache header・revalidatePath・tombstone entity_type・op 名・ops イベント名。
- **Dexie に触らない**(D-6 発火なし。P0 で隔離 commit は発生しない)。
- **固定対象の契約面は spec §3.2 の altitude 表を正**とする(本 plan は列挙を重複させない)。
- **実施順序(spec §2・条件 A)を commit 群で保持**: T0 triage → T1 fixtures → T2-T6 contract+.snap → T7 lint → T8 dead-sweep。前後させない。
- **.snap↔triage トレーサビリティ(条件 3)**: 各 contract task の .snap commit message に baseline §A(T0)の commit SHA を記す。
- **snapshot -u 規律**: `.snap` diff は review 成果物。無条件 `-u` 禁止。差分は必ず「意図的挙動変更か」を review。
- review = canonical(requesting-code-review)+ Codex(codex-review.sh)を非自明 task ごとに実施。docs のみ task は [no-review] 可。
- 各 task 完了時は `pnpm test` / `pnpm typecheck` / whole-repo `pnpm lint --max-warnings=0` を該当範囲で green 維持。

---

### Task 0: §2.3 契約乖離 triage(最初の実作業)

- [ ] **目的**: 契約面に出る server/client 乖離を全数分類し baseline §A を作る。snapshot 生成の前提。
- **Files:** Create `docs/audit/2026-07-06-p0-contract-baseline.md`(§A のみ。§B は T9)。
- **制約**: 現 HEAD 再スキャン。列 = 乖離 / file:line / 契約面に出るか / intentional|bug / 根拠 / snapshot 反映 / 回収 phase。seed(intentional 確定 2 件)= ClientAnswerEvent.rating(payload 専用・deriveRating が正)/ ClientUserSettings(pull 非出力)。追加候補 = card_tags cursor 非対称・tombstone entity_type union・option camel⇄snake・study_days JST 集計・**study_days.correct_count = rating>=2**。挙動変更しない。
- **完了条件**: 全乖離が intentional|bug 分類済 + 回収 phase 記入。**bug 判定が出たら**: (a) snapshot 対象外にし §A に記録、かつ (b) その bug が後続 phase(P1 replay/streak・P2 review-events route 等)の refactor 対象ロジックに含まれる場合は「P0 で例外的に直すか / 該当 phase の前提として明記するか」を **OT 判断に上げてから** P0 を進める(条件 2・単に対象外にして完了としない)。docs commit([no-review])。

### Task 1: 共有 fixtures + 決定論基盤

- [ ] **目的**: contract test 共通の入力生成と非決定値固定を tests/fixtures/ に集約。
- **Files:** Create `tests/fixtures/`(makeReq / fake-tx builder / payload・event factory / clock・id stub / 限定 serializer mask)。Modify `package.json`(`test:contract` script)。
- **制約**: 既存 route test の fake-tx / delta mock パターンを移植(新規発明しない)。clock = `vi.setSystemTime`(`Date.now()` 含む)、id = `crypto.randomUUID`/`lib/sync/new-id` 決定論 stub、DB returning 値も fixture 固定。serializer マスクは最後の手段・個別 field 限定。route の signature/実装は変更しない。
- **完了条件**: fixtures が import 可能。決定論が trivial な安定 snapshot 1 本で実証(2 回連続 run で同一)。`test:contract` script が `tests/contract/` のみ実行。commit。

### Task 2: `/api/pull` contract + .snap

- [ ] **目的**: pull の wire 契約(6 stream key + cursor 名 + no-store + 未同期 200 空 body + 401/500 + tombstone entity_type)を固定。
- **Files:** Create `tests/contract/pull.contract.test.ts` + `.snap`。
- **制約**: 固定対象 = spec §3.2 pull 行。代表 tombstone に tag_category/tag_option を含める。T1 fixtures 使用。triage 対象外面(§A)は焼かない。
- **完了条件**: `test:contract` green。.snap が happy + 401 + 500 + 未同期空 body を含む。.snap commit(message に §A SHA 参照)。canonical+Codex review pass。

### Task 3: `entity-mutations/bulk` contract + .snap

- [ ] **目的**: mutation envelope の応答 + 捕捉 DB mutation + 全 error code + 200-failed 意味論を固定。
- **Files:** Create `tests/contract/entity-mutations-bulk.contract.test.ts` + `.snap`。
- **制約**: 固定対象 = spec §3.2 entity-mutations 行。全 error code(unauthenticated/user_not_synced/invalid_json/invalid_payload/**duplicate_mutation_id**/503)。200-failed(unknown entity/op・invalid patch)。skipLog delete(INSERT なし・applied 計上)。op inventory を作り代表 op + skipLog + invalid-patch failed + cascade serial fallback を固定。fake tx は抽出値のみ固定(SQL object 全体を焼かない)。
- **完了条件**: `test:contract` green。上記 error code・意味論が .snap に現れる。.snap commit(§A SHA 参照)。canonical+Codex review pass。

### Task 4: `review-events/bulk` contract + .snap

- [ ] **目的**: `{ok,failed}` + 捕捉 DB 書込(sessionUpsert/answerEvent/reviews/studyDays)+ rating derive 契約を固定。
- **Files:** Create `tests/contract/review-events-bulk.contract.test.ts` + `.snap`。
- **制約**: 固定対象 = spec §3.2 review-events 行。rating derive 同時固定 = answer_events に rating 出ない / reviews.rating・study_days.correct_count は deriveRating 由来 / **correct_count は rating>=2**(FSRS rating ありケースを golden に含む)。fake tx 抽出値のみ。
- **完了条件**: `test:contract` green。rating>=2 ケースと全 error code が .snap に現れる。.snap commit(§A SHA 参照)。canonical+Codex review pass。

### Task 5: upload result union contract + .snap

- [ ] **目的**: `ProcessUploadResult` union 形 + 11 error code + revalidatePath 常時発火を targeted に固定(full pipeline 実行しない)。
- **Files:** Create `tests/contract/upload-result.contract.test.ts` + `.snap`。
- **制約**: 固定対象 = spec §3.2 upload 行。advisory lock/AI 呼出/DB pipeline は走らせない。`revalidatePath('/app/upload')` と `'/app'` が finally で error path 含め常時発火することを固定。非決定値(Date.now・DB default id・sourceDocumentId・ops timestamp)は fixture 固定。
- **完了条件**: `test:contract` green。11 error code + success union + revalidate 2 発火が .snap/assert に現れる。.snap commit(§A SHA 参照)。canonical+Codex review pass。

### Task 6: webhook(stripe/clerk)contract + .snap

- [ ] **目的**: text response + status + 捕捉 DB mutation + 「error でも 200」面 + stripe status matrix + clerk 10 テーブル DELETE を固定。
- **Files:** Create `tests/contract/webhook-stripe.contract.test.ts` / `tests/contract/webhook-clerk.contract.test.ts` + `.snap`。
- **制約**: 固定対象 = spec §3.2 webhook 行。stripe = active/trialing・past_due・unpaid/incomplete(status=past_due だが plan=free)・canceled 系・不明 price_id fallback を inventory 化。clerk = user.created+publicMetadata sync / user.deleted の soft delete + 10 子テーブル DELETE 全数。error でも 200(duplicate/handler error swallowed/unknown ok/invalid signature)。既存 fake-tx 素材再利用。
- **完了条件**: `test:contract` green。上記代表面が .snap に現れる。.snap commit(§A SHA 参照)。canonical+Codex review pass。

### Task 7: import 境界 lint(allowlist)

- [ ] **目的**: lib/components→@/app と app 内の深い相対 import を検出、既知 4 件を allowlist。
- **Files:** Modify `eslint.config.mjs`。Create pattern 検証 test(`tests/contract/` or lib test)。
- **制約**: 標準 `no-restricted-imports`(新規依存なし)。禁止 = `lib/**`・`components/**` → `@/app/*|**`、`app/**` → `../../../*`(**4 段以上も拾う**)。allowlist per-file override(禁止ブロックの後方)= get-custom-session-cards.ts / contact-form.tsx / exam-detail-view.tsx / upload result page.tsx。app 2 パスは `\\(app\\)` `\\[id\\]` `\\[sourceDocumentId\\]` escape 必須。app 内横断 import は P0 対象外(P3 送り・§B 記録)。
- **完了条件**: whole-repo `pnpm lint --max-warnings=0` exit 0。pattern test で 4 段以上・escape が効くことを検証。per-file off 副作用は §B に記録(T9)。commit。

### Task 8: dead-sweep Tier 1(contract green 後の独立 commit)

- [ ] **目的**: 完全 dead + stale コメントのみ除去。掃討で golden が赤 → dead 判定撤回が commit 単位で見えるように。
- **Files:** Delete `components/ui/dropdown-menu.tsx`。Modify `app/(app)/app/tags/_components/option-row.tsx`(コメント 2 箇所)/ `lib/db/schema.ts:1`(13→21)/ `lib/cards/replay-card.ts`(dangling `submit-review-tx.ts` を実対向 review-events route へ)+ `replay-card.test.ts`。
- **制約**: T2-T6 の contract green 確認**後**の独立 commit。dropdown-menu 削除条件 = import ゼロ + barrel/re-export なし + shadcn 再生成対象でない + docs 参照なし。Tier 2/3 は触らない(owning phase / P3)。
- **完了条件**: 削除後 `test:contract` + `pnpm test` green(赤なら dead 判定撤回し §A/§B に記録)。`pnpm lint`/`typecheck` exit 0。独立 commit。canonical review(コード削除のため)+ Codex。

### Task 9: baseline §B + smoke checklist(deliverable docs)

- [ ] **目的**: 凍結契約 inventory と未 cover 境界・運用注記・smoke checklist を残す。
- **Files:** Modify `docs/audit/2026-07-06-p0-contract-baseline.md`(§B 追記)。Create `docs/audit/2026-07-06-p0-smoke-checklist.md`。
- **制約**: §B = (i) 凍結契約 inventory(upload 11 code + ProcessUploadResult union / 各 route の error code・status・response 形)(ii) Dexie schema v1〜7 stores 定義文字列(P0 で触らないが後続移動の差分基準)(iii) 既存 route test と contract test の役割分担 (iv) lint allowlist の per-file off 副作用 + 削減期限 (v) **未 cover の app 内境界の実リスト**(現 HEAD 再スキャン: custom-filter-form.tsx:15,21 → exams _components/_lib、column-pinning.ts:6 → _components の _lib→_components 逆向き。P3 が allowlist 化の基点にする)。smoke checklist = auth / カード編集 / タグ CRUD / 5 問回答→bulk flush / OCR upload / plan 変更、各に手順+期待+mobile 要否。
- **完了条件**: §B 5 項目 + smoke checklist 記載。docs commit([no-review])。

### Task 10: 完了 gate + SSoT 更新

- [ ] **目的**: whole-repo gate 通過と SSoT 状態更新で P0 を締める。
- **Files:** Modify `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(P0 状態 → 完了 + HEAD SHA + 再スキャン記録)。
- **制約**: 条件 B(状態更新は該当 commit で CC)。全 feat/fix commit に [reviewed] tag 確認。
- **完了条件**: whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm test`(contract 含む)exit 0。T0 の bug handoff 分岐が発火した場合は OT 判断が付いていること。SSoT P0 状態 = 完了 + SHA。commit。stop checkpoint 報告で停止(OT push 待ち)。

---

## Self-Review(spec coverage)

- spec §3.1 triage → T0 / §3.2 contract(pull/entity-mutations/review-events/upload/webhook)→ T2-T6 / §3.3 smoke → T9 / §3.4 lint → T7 / §3.5 dead Tier1 → T8 / §4 deliverable(§A/§B/smoke)→ T0・T9 / §5 完了条件 → T10 / §6 Tier 分散 → SSoT 記録済(前 commit)/ §8 app 内境界 defer → T7 制約 + T9 §B。
- 条件 1(§B app 内境界実リスト)→ T9(v)。条件 2(bug handoff)→ T0 完了条件 + T10。条件 3(.snap↔§A SHA)→ Global + T2-T6。条件 4(commit 分割・dead 独立)→ Global + T8。
- placeholder なし。型不整合なし(契約面は spec §3.2 を単一 source 参照)。
