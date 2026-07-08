# グループ A: server invariant fix 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** server invariant 欠落 4 件(A-1 single 制約 / A-2 answer_ids 存在検証 / A-3 upgrade 整合窓検知 / A-4 退会偽アラート)を独立 fix で埋める。

**Spec:** `docs/superpowers/specs/2026-07-08-group-a-invariant-fixes-design.md`(OT 承認済・payload 方針 = 全て reject / A-4 = root fix)
**参照 audit:** `docs/audit/2026-07-08-server-invariant-verification.md` / `docs/audit/2026-07-08-deletion-self-induced-webhook-alarm.md`

## 全体制約(各 task に適用・task 内では再掲しない)

- TypeScript strict / 既存パターン準拠 / YAGNI(spec 記載の検証以外を足さない)/ 新規ライブラリ禁止 / DB スキーマ変更なし。
- TDD: 失敗 test 先行 → 実装 → pass。test は mock(実 API・実 DB 禁止)。既存 test file の mock 構造に乗る(新しい mock 流儀を発明しない)。
- **behavior-changing の扱い**: 既存正常系 test を変更しない(落ちたら実装を疑う)。不正 payload 系の期待値変更のみ「意図的変更」として commit message に 1 行記録。
- 各 task = 独立 commit。経路 = canonical review(`superpowers:requesting-code-review` 既定・template 改変禁止)pass → Codex review(`scripts/ai/codex-review.sh <topic>`・未解決 Critical/Important 0・上限 3 周)pass → commit。
- commit tag: **A-1 / A-2 = `[reviewed]`**。**A-3 / A-4 = tag 無し commit**(決済・削除領域 = 重要 fix 裏取り規律)。push 時点タグなし許容・OT 実機確認後に OT 指示で旗を立てる(既存規律どおり。stg smoke には push が必要なため「未 push amend」を前提にしない)。
- 自走継続条件(CLAUDE.md)準拠: Critical は修正試行 → 解決すれば継続、未解決のみ停止。

---

### Task 1: A-1 single カテゴリ制約の server enforce

**目的**: `handleTagOptionIds`(`lib/cards/card-field-handlers.ts:192-241`)に「select_type='single' のカテゴリに 2 個以上の option を含む whole-set は reject」を追加し、client のみだった single 制約を server で enforce する。

**制約**:
- 挿入位置 = 既存検査 ④(option 存在+所有 SELECT :209-217)の直後・DELETE(:221)より前。副作用ゼロで `'failed'` を返す(理由文字列なし・既存作法)。
- 実装: 検査 ④ の SELECT を `{ id, categoryId }` に拡張 → 取得 categoryId 群で `tag_categories` を owner-scope SELECT(`{ id, selectType }`)→ categoryId ごとに option 数を集計 → `selectType === 'single'` かつ count ≥ 2 が 1 つでもあれば `'failed'`。
- 既存検査 ④ の「件数一致で弾く」挙動・SELECT 回数の増加は tag_categories 1 回のみ(JOIN でも 2 SELECT でも可、既存 drizzle 流儀に合わせる)。
- grouping は**重複排除後**の optionIds に対して行う(既存 dedup :198 維持 — 同一 id 重複を single 違反に誤カウントしない)。tag_categories SELECT の件数不一致(orphan category — FK cascade 上は起きないはず)は **fail closed** で `'failed'`(Codex 論点採用)。
- test = `lib/cards/card-field-handlers.test.ts` の makeTagTx 構造に追加: (a) single カテゴリ 2 個 → failed + DELETE/INSERT 不発 (b) single 1 個 + multi 複数混在 → applied (c) multi のみ複数 → applied (d) 複数 single カテゴリ各 1 個 → applied。

**完了条件**: 新 test 4 系 + 既存 test 全 pass / canonical + Codex review pass / commit `fix(cards): enforce single-category tag constraint server-side [reviewed]`。

---

### Task 2: A-2 selected_answer_ids の存在検証

**目的**: review-events ingest(`lib/reviews/ingest-review-events.ts`)で「selected_answer_ids の全 id が対象 card の options に実在」を検証し、違反 event を orphan と同列の failed[] に分離する。

**制約**:
- Phase 1 cards SELECT(:108-132)に `options` 列を追加 → `cardId → Set<optionId>`(`options[].id`)の Map を構築。
- 検証位置 = **orphan 判定(:154-162)の直後・answer_events INSERT(:169)より前**。INSERT 後に弾くと再送時に ON CONFLICT で duplicate 扱いになり client が synced 誤認して silent 消失するため、この順序は絶対(spec の reject 意味論 = 再送 → stale 隔離、を保つ)。
- 違反 event は orphanFailed と同じ形で failed[] に積む(新しい応答形・語彙を発明しない)。is_correct / rating の照合はしない(F2 帰属)。
- correctAnswerIds は取得しない(不要)。options は jsonb・option id は任意 string(uuid 前提にしない)。
- 境界の明文化(Codex 論点採用): **空 selected_answer_ids** は検証対象なし = pass(従来挙動不変・schema 上 空配列は許容)。**options が非配列/壊れ値**の既存データは空 Set 扱い = **fail closed**(selected 非空なら reject)。
- test = `tests/contract/review-events-bulk.contract.test.ts` に追加: (a) 実在 id → applied (b) 存在しない id 混入 → 当該 event のみ failed[]・他 event は applied (c) 別 card の実在 id → failed[] (d) 複数選択で全 id 実在 → applied。frozen 仕様コメント(file 冒頭)に存在検証を 1 行追記。

**完了条件**: 新 test 4 系 + 既存 contract test 全 pass / canonical + Codex review pass / commit `fix(reviews): validate selected_answer_ids against card options [reviewed]`。

---

### Task 3: A-3 upgrade 整合窓の observability

**目的**: `app/(app)/app/upgrade/actions.ts` の Stripe 成功後 DB 更新 2 箇所(changePlan downgrade :141-145 / cancelDowngrade :176-180)の失敗を notifyOps で検知可能にする(挙動不変・検知のみ)。

**制約**:
- try/catch は **db.update のみ**を包む(`redirect()` は throw 制御ゆえ巻き込み禁止)。catch 内で notifyOps → **rethrow**(ユーザー向けは従来どおり汎用エラー)。
- subject = `'plan change: db write failed after stripe success'`(両箇所共通)。context = `operation`('scheduleDowngrade' | 'cancelDowngrade')/ `userId` / `operationId` / `scheduleId` / `targetPriceId`(downgrade のみ)/ `error` / `environment: runtimeEnv()` / `timestamp`(`lib/ops.ts` 既存作法)。
- 共通 helper を作らない(2 箇所・rule of three 未満)。notifyOps 内部は throw しない設計につき二重 catch 不要(この依存は実装コメントに 1 行固定)。`error` は Error object をそのまま context に渡す(`lib/ops.ts` expandError が serialize・notifyWebhookError と同作法)。
- test: actions の既存 test file があればそこへ、無ければ `app/(app)/app/upgrade/actions.test.ts` を既存 server action test の mock 流儀(stripe/subscription 関数 + getDb + notifyOps を vi.mock)で新設: (a) db.update reject → notifyOps が上記 subject + context で 1 回・エラー rethrow(redirect 不到達) (b) db.update 成功 → notifyOps 不発・redirect throw、を downgrade / cancel 両経路で。

**完了条件**: 新 test pass + 既存全 pass / canonical + Codex review pass / commit `fix(billing): notify ops when db write fails after stripe success`(**tag 無し** → OT 実機確認後 amend [reviewed])。

---

### Task 4: A-4 退会自己誘発 webhook 偽アラートの root fix

**目的**: `lib/stripe/handle-stripe-event.ts` の「clerkId 非 null = 行 match」の proxy 誤判定を、行 match 判定と clerkId 判定の分離に置換し(root fix・見積 S 確定済)、GDPR scrub 行への正常 webhook で 'unlinked customer' が誤発火しないようにする。

**制約**:
- 対象 2 分岐: `.deleted`(:263-276)と `.created/.updated`(:212-239)。`checkout.session.completed` は WHERE 自体が clerkId のため対象外(触らない)。
- 変更形: `const row = updated?.[0]` を導入し、(i) `!row`(0 行 match)→ 従来どおり notifyOps('stripe sub event for unlinked customer')= **真の整合崩壊の通知は維持**(偽を消すために本物を殺さない) (ii) `row && row.clerkId` → syncClerkPublicMetadata(従来どおり) (iii) `row && !row.clerkId`(scrub 済)→ metadata sync せず**無通知 skip**。
- `.updated` の release gate(evaluateReleaseGate)は「行 match」に紐付け直す(clerkId 不要のため scrub 行でも評価 — `.deleted` 先着で予約 3 列は clear 済みが通常、gate 冒頭の `!dbScheduleId` early return で無害)。
- DB UPDATE の SET 内容・返却形は不変(RETURNING 列の追加不要 — clerkId で行 match と scrub 判別の両方が可能: 行有無 = 配列長、scrub = clerkId null)。
- test = `app/api/webhooks/stripe/route.test.ts` に追加: (a) scrub 行(match 1 行・clerkId null)への `.deleted` → DB 更新従来どおり + notifyOps 不発 + metadata sync 不発 (b) 行なしへの `.deleted` → notifyOps 発火(既存維持) (c) scrub 行への `.updated` → notifyOps 不発 (d) 行なしへの `.updated` → notifyOps 発火(既存維持) (e) scrub 行 + 予約 3 列ありへの `.updated` → release gate が clerkId 無しでも評価され無害(Codex 論点採用)。`.created` の unlinked 無通知(既存設計)は変更しない。既存 unlinked test の期待値が「scrub 行」前提なら意図的変更として更新。

**完了条件**: 新 test 4 系 + 既存全 pass / canonical + Codex review pass / commit `fix(stripe): stop false unlinked-customer alarm for scrubbed users`(**tag 無し** → OT 実機確認後 amend [reviewed])。

---

### Task 5: sprint 完了 gate

**目的**: sprint 共通 gate の実行と完了報告。

**制約**: whole-repo `pnpm lint --max-warnings=0` exit 0 + `pnpm test` 全通過 + `pnpm typecheck` exit 0(typecheck は gate 規則外だが server action / webhook / drizzle 型に触るため安価な保険として追加 — Codex 論点採用)。review dispatch の観点 list に whole-repo lint 実行確認を含める(Task 1〜4 の reviewer prompt に記載済みであること)。

**完了条件**: 両 gate exit 0 を完了報告 chat に 1 行明記(「whole-repo lint exit 0 確認済」)/ 停止して OT 報告(push は OT)。stg smoke(A-1〜A-4 の live 確認)は push 後 OT 指示で実施(手順 = spec の smoke 節)。

---

## 実績欄(完了時に記入)

- Task 1: —
- Task 2: —
- Task 3: —
- Task 4: —
- Task 5: —
