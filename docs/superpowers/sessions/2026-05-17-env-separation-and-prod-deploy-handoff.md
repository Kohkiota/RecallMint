# Session handoff: 環境分離 / 本番初回 deploy / DB migration 適用 完了

> 作成: 2026-05-17 (multi-task session 完了時)
> 状態: working tree clean、 production verify (Step 5) は OT 動作確認待ち

## このセッションでの commit (時系列)

| hash | subject | tag |
|---|---|---|
| `7292a79` | fix(env): rename STRIPE_PRICE_ID_PRO_MONTHLY → STRIPE_PRICE_PRO_MONTHLY | [reviewed] |
| `dbdf9c9` | feat(plans+contact): Sprint A-3.2 - mcq plan-limits + contact_messages 配線 | [reviewed] |
| `2da60bc` | chore: open develop branch for preview deploy | (空 commit) |
| `4f8002d` | fix(stripe): allow live keys in production, enforce test keys elsewhere | [reviewed] |
| `7616140` | Merge develop: Stripe live-key support + Sprint A-3.2 | (merge --no-ff) |
| `6b2947e` | chore(docs): trim tech-spec to implementation reference, remove plan v0.2 | [no-review] |
| `8459efa` | chore(docs): update cross-refs after tech-spec/plan trim + add env-separation lesson | [no-review] |

(前 session の commit はすでに `2026-05-15-sprint-a2-a3.1-handoff.md` に記録、 本 session の commit は上記 7 件)

## 主要成果

### 1. Sprint A-3.2 完成 (`dbdf9c9`)

- plan-limits を mcq 用 (free / standard / pro × ocrPagesPerMonth) に書換
- vocab 時代の lib/ai-usage.{ts,test.ts} + integration test 削除
- contact_messages DB INSERT 配線 (category field 追加、 auth-throws 防御パス含む 9 tests)
- users.plan 型を `'free' | 'standard' | 'pro'` widening、 Standard 配線は forward-prep TODO

### 2. Stripe key mode 強制を env-aware に進化 (`4f8002d`)

- 本番初回 deploy で `STRIPE_SECRET_KEY=rk_live_*` が test-only validation で弾かれて build 失敗 → fix
- `lib/stripe.ts` を VERCEL_ENV-aware に書換 (`lib/clerk.ts` と同 pattern)
- `STRIPE_PUBLISHABLE_KEY` 検証を新規追加 (Clerk pattern 統一目的)
- CLAUDE.md §Stripe 絶対ルールを env-aware 文言に書換 (旧 #1/#2/#3 collapse → 新 #1)
- 19 tests (non-prod 9 / prod 7 / cancelWithRetry 3) で両 mode 検証

### 3. 環境分離構築

- 2 環境構成確定: **prod** (`recallmint.nekotest.net` / main / Vercel Production scope) と
  **dev 共用** (`stg.recallmint.nekotest.net` / develop / Vercel Preview scope + Development scope + localhost)
- Vercel Preview と Development は同一 R2 bucket / Neon staging branch / Clerk Dev / Stripe test を共有
- 各 service の環境分離方式確定 (詳細は env-separation-and-stripe-mode-enforcement.md §2.2)

### 4. DB migration `0000_keen_the_hunter.sql` を staging + production 両 branch に適用

| branch | endpoint | tables | history | 適用日 |
|---|---|:---:|:---:|---|
| staging | `ep-long-fog-aox51k1u` (pooled) | 12 | id=1 applied | 2026-05-17 |
| production | `ep-shiny-waterfall-aoi80vxd` (pooled) | 12 | id=1 applied | 2026-05-17 |

両 branch 完全同一構成 (12 table / 11 FK / 14 non-PK index)。
.env.local は staging を向いたまま、 production URL は inline 環境変数で 1 回限り使用 (file 書込なし)。

### 5. doc 整理

- OT が Obsidian から `docs/02-tech-spec.md` (v0.5.1) / `docs/03-plan.md` (v0.2) を一時投入
- tech-spec を implementation reference 用に trim (1463 → 1296 行、 戦略文脈 / 版管理 / 解決済 OQ / 戦略 OQ を Obsidian 移管)
- plan は完全削除 (sprint 個別 plan は `docs/plans/`、 全体ロードマップは Obsidian)
- cross-ref を README / CLAUDE で update
- 新 lesson `env-separation-and-stripe-mode-enforcement.md` を追加 (commit `4f8002d` の補完 doc)

### 6. Vercel Deployment Protection 起因の Clerk webhook 401 問題

- stg 環境で Clerk webhook が Failed × 3 retry、 Function Logs に request 到達せず
- Claude 仮説 H1 (`STRIPE_PUBLISHABLE_KEY` 不在で `lib/stripe.ts` module load throw) を強く支持 → **誤り**
- 真因: Vercel Preview default の Deployment Protection (Standard Protection) で Edge 401 弾き、 function 未到達
- OT が Preview の Require Log In = Off に切替で復旧
- 教訓 (Lesson A / B) の lesson doc 追記は **Step 2 方針合意で停止中** (下記未完了タスク §1)

## 実 DB 状態 (Neon、 両 branch)

両 branch とも以下構成で完全同一:

12 tables: users / ai_usage / ai_usage_users / clerk_events / stripe_events /
deletion_failures / reviews / exams / cards / source_documents / study_days /
contact_messages

11 FK constraints: 全 user_id → users CASCADE、 cards.source_document_id → SET NULL
(OCR 元削除時 card 保持)、 deletion_failures は FK なし (audit log 設計)

14 non-PK indexes: cards 5 / exams 1 / reviews 2 / source_documents 2 + 複合 PK 2
(ai_usage_users, study_days) + UNIQUE 2 (users.clerk_id, users.stripe_customer_id)

## OT 動作確認結果 (verified)

### staging (`stg.recallmint.nekotest.net`)

- ✅ /sign-up → /app 遷移成功
- ✅ Clerk Dev instance webhook 200 配信、 users INSERT 成功
- ✅ Stripe Checkout (test card 4242) で users.plan='pro' / stripe_customer_id /
   subscription_status='active' / current_period_end 更新成功
- ✅ アカウント削除 → soft delete (deleted_at セット) + Stripe cancel → plan='free' リセット

### production (`recallmint.nekotest.net`)

- ⏳ **Step 5 OT 動作確認待ち** (sign-up flow + 削除 flow のみ、 課金 live mode 触らない)

## 未完了タスク (OT 担当 or pending)

### 1. lesson doc 追記 (Vercel Deployment Protection + env validation 仮説暴走)

OT 提示の 2 lesson (A: Deployment Protection × Preview / B: env validation 仮説固定リスク) を
`env-separation-and-stripe-mode-enforcement.md` に追記する task は **Step 2 方針合意で停止中**。

- Step 1 報告済 (既存 doc 検索結果 = `env-separation-and-stripe-mode-enforcement.md` のみ)
- Step 2 提案済 (P1 = §2.6 + §2.7 連番 推奨、 §3 推奨 1 bullet 追加、 Lesson B 表現強度の A/B 案)
- OT 判断待ち項目: 配置案 (P1/P2/P3)、 §3 §4 更新範囲、 §2.7 表現強度

### 2. push 系 (OT 担当、 push は memory ルール通り Claude 不可)

- 現 local develop: `8459efa` (doc trim + lesson 追加済)
- origin/develop 状態未確認 (本 session 中 ls-remote が SSH key permission denied、 origin から取得不可)
- 想定: 旧 `4f8002d` のまま、 OT が前回 Task 3 (develop 再作成 = `git push origin --delete develop` + `git push -u origin develop`) を実行していれば最新化

### 3. Step 5 (production sign-up flow OT 検証)

migration は適用済、 OT が本番で sign-up → users INSERT → 削除 flow の動作確認。
課金 flow は live mode のため触らない。

## 環境変数の重要参照 (memory 候補)

| 名前 | 値 | 用途 |
|---|---|---|
| Neon production endpoint | `ep-shiny-waterfall-aoi80vxd` | pooled、 ap-southeast-1 |
| Neon staging endpoint | `ep-long-fog-aox51k1u` | pooled、 ap-southeast-1 |
| 本番ドメイン | `recallmint.nekotest.net` | main branch + Vercel Production scope |
| stg ドメイン | `stg.recallmint.nekotest.net` | develop branch + Vercel Preview scope |

DATABASE_URL の Production 値は OT 管理 (本 session で 1 回 inline 受領、 file 書込なし、 transcript 上にのみ残存)。

## このセッションで読んだ / 触った主要 file

### 新規作成 (commit 済)

- `lib/stripe.ts` (env-aware 書換、 PUBLISHABLE_KEY 検証追加)
- `lib/stripe.test.ts` (19 tests、 prod / non-prod の 2 describe 構成)
- `docs/02-tech-spec.md` (Obsidian 投入 → trim、 commit 6b2947e で新規追加扱い)
- `docs/superpowers/lessons/env-separation-and-stripe-mode-enforcement.md` (新 lesson)
- `docs/superpowers/sessions/2026-05-17-env-separation-and-prod-deploy-handoff.md` (本 file)

### 変更 (commit 済)

- `app/(marketing)/contact/actions.{ts,test.ts}` (Sprint A-3.2)
- `app/(marketing)/contact/contact-form.tsx` (Sprint A-3.2)
- `lib/validation/contact.{ts,test.ts}` (Sprint A-3.2)
- `lib/auth/plan-limits.{ts,test.ts}` (Sprint A-3.2)
- `lib/db/schema.ts` (Sprint A-3.2、 users.plan widening)
- `app/api/webhooks/stripe/route.ts` (Sprint A-3.2、 Extract<Plan, ...>)
- `app/(app)/app/{page,settings/page,settings/delete-button,upgrade/page}.tsx` (Sprint A-3.2、 cleanup)
- `app/(app)/app/upgrade/actions.ts` (env fix `7292a79`)
- `vitest.setup.ts` (env fix)
- `README.md` (Stripe env fix + cross-ref 更新 commit 8459efa)
- `CLAUDE.md` (Stripe 絶対ルール書換 + cross-ref 更新)
- `lib/clerk.ts` (cross-ref コメント更新)
- `.env.example` (Stripe section header)
- `docs/architecture-guide.md` (env validation 記述)
- `docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md` (§5 Update)

### 削除 (commit 済)

- `lib/ai-usage.{ts,test.ts}` (Sprint A-3.2、 aiGenPerDay 廃止)
- `tests/integration/ai-usage-concurrent.test.ts` (同)
- `docs/03-plan.md` (Obsidian 投入後 trim 時に削除、 plan は Obsidian 管理に移行)

## 関連 doc

- `docs/superpowers/sessions/2026-05-15-sprint-a2-a3.1-handoff.md` (前 session、 旧マシン状態の handoff、 v0.7 / v0.4 言及は実 repo と乖離あり「後でまとめて訂正」per OT)
- `docs/superpowers/lessons/env-separation-and-stripe-mode-enforcement.md` (commit `8459efa`、 本 session 主要 lesson)
- `docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md` (Clerk env-aware pattern 先行 lesson、 §5 で Stripe 統一を追記済)
- `docs/02-tech-spec.md` (trim 後の implementation reference)
- CLAUDE.md §Stripe 絶対ルール (env-aware 書換済)
