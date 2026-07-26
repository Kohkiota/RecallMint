# テストユーザー台帳(運用)

> 本書は運用手順。**設計の理由は `docs/architecture.md`(H-1b で新設)を参照**。email / users.id は識別子(secret でない)。**カード枚数など変動する数値は書かない**(「seed 済 / 未 seed」の別まで)。正本 = Clerk / Supabase dashboard。

## 1. stg アカウント(`stg.recallmint.nekotest.net`)

| email alias | 用途 | 備考 |
|---|---|---|
| `komail9server+clerk_test@gmail.com` | 一般検証(seed 済)| — |
| `komail9server+clerk_test1@gmail.com` | 一般検証(少量)| — |
| `komail9server+clerk_test3@gmail.com` | 退会テストで使用 | 削除済 |
| `komail9server+clerk_testclock@gmail.com` | Stripe Test Clock 固定アカウント | `users.id = bb68971d-12ec-45fa-9ade-d9a049c83ca4`(下記 §3)|

- 上記のうち **tracked repo で裏取り済は `+clerk_testclock` のみ**(`docs/ops/stripe-test-clock-verify-runbook.md`)。`+clerk_test` / `+clerk_test1` / `+clerk_test3` は claude.ai 供給・正本 = Clerk dashboard。

## 2. prod アカウント

| email alias | 用途 | 備考 |
|---|---|---|
| `komail9server+001@gmail.com` | prod 検証 | 未 seed |

- claude.ai 供給・正本 = Clerk dashboard(tracked repo に無い)。

## 3. Clerk test mode / Test Clock アカウント運用

- **Clerk test mode の固定 OTP = `424242`**(test instance の verification code)。
- **Test Clock 固定アカウントの `users.id`**: `bb68971d-12ec-45fa-9ade-d9a049c83ca4`。**app-role(RLS)では CC が自力探索できない**設計ゆえ OT が値を渡す前提だった(owner 露出防止の裏返し)。本台帳に記載して再利用性を上げる。
- Test Clock 用アカウントの **DB リセットは課金列のみ**(`clerk_id` / `deleted_at` は不変)ゆえ、再ログインで同一行を再利用できる(手作業は初回作成のみ)。
- Test Clock の実行手順は `docs/ops/stripe-test-clock-verify-runbook.md`(本書はポインタ)。
