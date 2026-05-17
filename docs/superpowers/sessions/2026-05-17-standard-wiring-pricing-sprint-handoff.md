# Session handoff: Standard plan 配線 + /pricing + plan/cycle 整合 sprint 完了

> 作成: 2026-05-17 (Standard 配線 sprint 完了時、 前 session [env separation handoff](2026-05-17-env-separation-and-prod-deploy-handoff.md) の続き)
> 状態: working tree clean、 push + merge + 両 DB migration 完了、 C3 webhook 実機裏取り + Neon password rotation のみ pending

---

## このセッションでの commit (時系列、 develop → main merge 済)

| hash | subject | tag |
|---|---|---|
| `d799cdc` | feat(db): add billing_interval column to users | [reviewed] |
| `dd0f546` | feat(stripe): add price_id ↔ (plan, interval) lookup module | [reviewed] |
| `680c2be` | feat(stripe): wire Standard + billing_interval in webhook handler | [reviewed] |
| `ca7837d` | feat(frontend): wire Standard plan in 4 sites + plan catalog | [reviewed] |
| `855de9c` | feat(marketing): add /pricing page with toggle UI | [reviewed] |
| `597dfc4` | chore(brand): hardcode RecallMint everywhere, remove SERVICE_NAME placeholder | [no-review] |
| `ab2e28e` | docs(spec): align Standard OCR cap to 300/月 (was 500) | [no-review] |
| `46791e3` | (merge) Merge develop: Standard plan wiring + plan/cycle alignment | (merge --no-ff) |

C6 (`597dfc4`) は 3 回 amend 経過 (env injection 試行 → hardcode RecallMint with dual pattern → hardcode + placeholder 完全撤回)。 force-push `--force-with-lease` で develop 同期、 OT が手動で main にも merge + push 済。

---

## 主要成果

### 1. DB schema 拡張 + 両 branch 適用

- `users.billing_interval` text 列 (`'month' | 'year' | NULL`) を追加 (`d799cdc` で生成 + commit、 本 session で staging + production 両 branch に apply 完了)
- plan (free/standard/pro) と直交する課金 cycle 軸、 機能差は plan 単軸で決定する設計
- 適用結果:
  | branch | endpoint | drizzle migrations record |
  |---|---|---|
  | staging | `ep-long-fog-aox51k1u-pooler` | 0000 + 0001 ✓ |
  | production | `ep-shiny-waterfall-aoi80vxd-pooler` | 0000 + 0001 ✓ |
- production active users = 0 件 (`deleted_at IS NULL`) のため transition window (paid + interval=NULL) 対象ゼロ
- `.env.local` は staging を向いたまま、 production apply は inline `DATABASE_URL='...' pnpm db:migrate` で 1 回限り

### 2. price-mapping lib + Stripe webhook 配線

- `lib/stripe/price-mapping.ts`: 4 env (`STRIPE_PRICE_{STANDARD,PRO}_{MONTHLY,YEARLY}`) → `(plan, interval)` 双方向 lookup、 module load 時 fail-fast 検証 (欠落 / 空文字 / 重複 ID)
- webhook handler (`route.ts`) を Standard 対応に書換: `normalizeSubStatus` を純粋 status mapping + `resolvePlanFromSub` (async、 price_id 解決 + notifyOps fallback) に分割
- `subscription.deleted` で `billing_interval: null` 同時 reset、 `past_due` は plan 維持 (grace window)、 `unpaid` のみ downgrade
- 不明 price_id (env 設定漏れ / Stripe Dashboard 不一致) → notifyOps + plan='free' fallback (throw しない、 Stripe 再送ループ防止)
- stripe webhook 初の test 整備 (`route.test.ts`、 9 case)

### 3. plan-catalog + frontend 5 sites

- `lib/plan-catalog.ts`: 価格 / 機能 / `rankPlan()` / `planLabelFor()` を集約 (UI 用、 backend enforce の `plan-limits.ts` と責務分離)
- rank: `free=0 < standard月=1 < standard年=2 < pro月=3 < pro年=4`、 transition window NULL は month 扱い
- 価格 (税込): Free ¥0 / Standard ¥680 月 ¥6,800 年 / Pro ¥1,280 月 ¥12,800 年 (年額 17% off)
- 修正 sites: `/app/upgrade` page (toggle UI + 2 plan cards client component)、 `/app/settings`、 `/app/settings/delete-button` (plan 非依存警告)、 `/app` dashboard CTA、 `/api/webhooks/stripe` (前項)
- forward-prep TODO 5 sites 全解消

### 4. 公開 /pricing page 新規

- `app/(marketing)/pricing/page.tsx` (SSR) + `components/pricing/pricing-table.tsx` (client toggle)
- 認証 4 状態 (未認証 / Free / Standard月年 / Pro月年) × 月年 toggle で CTA 切替
- marketing-header に「料金」link 追加、 vitest config に `components/**/*.test.tsx` 追加

### 5. SERVICE_NAME placeholder 完全撤回 (C6 amend 3 回)

- 当初 dual pattern (env 注入 + sed placeholder) → OT 判断で hardcode 化 → さらに「RecallMint は具体的 project、 template ではない」判断で SERVICE_NAME placeholder 完全撤回
- `{{SERVICE_NAME}}` 全 6 箇所 (page.tsx h1 / privacy / terms ×2 / logo / footer) を `"RecallMint"` literal に置換
- `docs/legal-placeholders.md` を 13 → **12 placeholder** 体制に縮減 (個人名 / 連絡先 / 住所 / 価格 / 制定日等は OT 提供で本気運用切替時に sed 置換する運用は維持)
- 別サービステンプレ流用責務は `Kohkiota/devcontainer-template` repo に切り出し済 (本 repo は RecallMint 固有 project)
- cross-ref update: `README.md` §2 table / `architecture-guide.md` §3 / 既存 source file コメント
- 旧 lesson (`2026-05-07-spec-confirmed-vs-smoke-judgment.md`) は historical record として無変更

### 6. tech-spec §6 数値整合 (`ab2e28e`)

- Standard OCR 上限を `500 → 300` に書換 (`lib/auth/plan-limits.ts` を source of truth として doc 側を合わせる)

---

## 残作業 (OT 手動)

### A. C3 Stripe webhook 実機裏取り (CLAUDE.md §重要 Fix 裏取り)

staging (`stg.recallmint.nekotest.net`) で:
- Standard 月額 / Standard 年額 / Pro 月額 / Pro 年額 各 checkout 完了 → `users.{plan, billing_interval}` が正しく書き込まれるか
- Stripe Dashboard で「Mark as past due」→ plan 維持 + status=past_due 確認
- 「Mark as unpaid」→ plan=free downgrade 確認
- 解約予約 → cancel_at 記録、 期間終了後 subscription.deleted → `billing_interval=null` reset 確認
- 不明 price_id (旧 ¥500 等) で sub 作成 → Discord notifyOps + plan=free fallback 確認

裏取り完了後、 C3 commit (`680c2be`) は既に [reviewed] tag 付き (sprint 完了後一括方針) のため amend 不要。 異常検知 → follow-up fix commit。

### B. Neon password rotation (推奨)

production / staging credentials を chat に貼って頂いたため、 両 branch の password rotate を推奨:
- Neon Dashboard → 各 branch → connection string regenerate
- `.env.local` (staging URL) update
- Vercel env (Production / Preview / Development scope) 各々の `DATABASE_URL` update

### C. (確認のみ) main merge 直後の transition window

- main merge (12:02 UTC) → Vercel auto-deploy ≒ 数分で完了想定
- production migration 適用は本 session 内 (UTC ≒ 同日午後)、 merge 後すぐ実施
- もし Vercel deploy が migration 前に走り、 その間に Stripe webhook が来ていれば `column "billing_interval" does not exist` 500 → notifyOps Discord 通知が出ているはず
- production active user 0 件のため流入はほぼゼロ想定だが、 Discord ops channel + Vercel logs の同時刻帯のみ目視確認推奨

---

## 設計判断の重要 record

### SERVICE_NAME placeholder 撤回理由 (C6 amend 3 周分)

| 試行 | 設計 | 撤回理由 |
|---|---|---|
| amend #1 | `NEXT_PUBLIC_SERVICE_NAME` env + `lib/config.ts` 動的注入 | 実質固定値で動的価値なし、 env 増加による認知負荷・設定ミス risk |
| amend #2 | アプリ系 hardcode + 法務系 6 file は `{{SERVICE_NAME}}` sed 維持 (dual pattern) | RecallMint は具体的 project で template ではない、 placeholder 思想を残す理由がない |
| amend #3 (確定) | 全 file hardcode、 12 placeholder のみ維持 (個人情報 fill-in 用) | sed system は法務 fill-in 値専用の責務に純化、 brand 名は dev-template repo 側で扱う |

### billing_interval を別列にした理由 (Sprint 設計 Q1 = A 案採用)

- plan 5 値化 (B 案) は `plan === 'pro'` 等の equality 比較を全箇所破壊、 type narrow も劣化
- Stripe API 都度問い合わせ (C 案) は rate limit + latency 問題
- A 案 (3 plan + interval 別列) は機能判定が plan 単軸で完結、 cycle は表示専用

### transition window 設計 (paid plan + billing_interval=NULL)

- migration 適用直後の既存 paid user は interval=NULL のまま、 次回 webhook 受信で resync 想定
- production は active user 0 件のため実害ゼロ
- schema.ts コメント + frontend (rank() で NULL を month 扱い) + 「(同期中)」表示で UI fallback

---

## 関連 file

- 前 session handoff: `docs/superpowers/sessions/2026-05-17-env-separation-and-prod-deploy-handoff.md`
- 設計 reference: `lib/plan-catalog.ts` / `lib/stripe/price-mapping.ts` / `app/api/webhooks/stripe/route.ts`
- test: `app/api/webhooks/stripe/route.test.ts` / `app/(app)/app/upgrade/{actions,upgrade-plans}.test.tsx` / `lib/plan-catalog.test.ts` / `components/pricing/pricing-table.test.tsx`
- 縮減 doc: `docs/legal-placeholders.md` (12 placeholder 体制)
- spec 更新: `docs/02-tech-spec.md` §6
