# git 履歴 secret scan(H-3・検出のみ)

- **日付**: 2026-07-27 / 種別: audit(read-only 検出・修正なし)
- **契機**: stg `DATABASE_URL_APP` パスワードが CC のコマンド出力に一度露出した既知 1 件(rotation は公開前トラック予定)。**git 履歴に他に何が残っているか**を確認する。
- **本タスクは検出と報告のみ**。rotation / 履歴書き換え / force push / 値の無効化は行っていない(判断は OT)。
- **本 doc に secret の値は一切書かない**(種別 / 環境 / commit 時期 / ファイルパスまで。値・部分値は書かない)。

## ツールと走査範囲

- **ツール = 自前の targeted pickaxe scan**(`git log --all -G<pattern>`)。選定理由: ① `curl`/`wget` が permission deny ゆえ gitleaks 公式 binary を取得できず、go/pip/docker も不在(node/pnpm のみ)② npm の `gitleaks` wrapper は非公式・provenance 不明ゆえ security scan に投入しない(K1 supply-chain 規律)③ pickaxe は **diff 行を印字せず commit+file だけを返す**ため値漏洩をしない構造 ④ install/egress/live-verification 皆無(接続・API 呼び出しをしない制約に適合)。永続ツールとしての pin 追加はしていない(使い捨て = 自前コマンドのみ)。
- **走査範囲 = 全履歴**: `git rev-list --all --count` = **1401 commit** / branch = develop / main / dddrefactor / backup 系 4 本 + origin/{main,develop,dddrefactor}(`--all` で全 ref をカバー)。
- **検出対象パターン**: postgres URI(`user:pass@`)/ Stripe・Clerk `sk_|rk_(live|test)` / `whsec_` / Gemini `AIza` / AWS `AKIA` / Supabase JWT(`eyJ.eyJ`)/ credential 付き supabase URI / PRIVATE KEY block / 64-hex / 広域 net(`PASSWORD|SECRET|SERVICE_ROLE|ACCESS_KEY|PRIVATE_KEY|_TOKEN` = 長い値代入)/ 非 secret 識別子(project ref・pooler host)。

## 検出件数(分類別)

| 分類 | 件数 |
|---|---|
| **実 secret・現在も有効の可能性(rotation 候補)** | **0** |
| **実 secret・既に無効** | **0** |
| **false positive(fixture / placeholder / env 参照 / public digest / 非 secret 識別子)** | 全ヒット |

**= 実 secret の履歴混入は検出ゼロ。**

## false positive の内訳(値非表示)

- **postgres URI(7 commit・2026-05〜07)**: 全て `127.0.0.1` / `localhost` / `/fake` / 拒否テスト用の illustrative host `db.abcdefgh.supabase.co`。file = `tests/integration/pg/setup/db-url.{ts,test.ts}` / `vitest.setup.ts` / `lib/db/index.test.ts` / RLS-P1 の plan・spec・audit doc。= 実 test 用ローカル throwaway(`postgres` 既定)/ placeholder / docs 例。
- **credential 付き supabase URI(1 commit)**: `db-url.test.ts` の `assertLocalTestDb` が **非ローカル URL を拒否する**ことを検証する fixture(`db.abcdefgh.supabase.co` = 明白な placeholder host)。
- **`whsec_`(2 commit)**: `tests/integration/pg/lifecycle-behavioral.test.ts` の `CLERK_SECRET` 定数 / `tests/integration/clerk-webhook.test.ts` の svix test webhook。= 署名検証テスト用 fixture。
- **広域 net(8 commit)**: webhook route/contract test・deletion-token test・clerk-webhook test 等の fixture + `lib/storage/r2.ts`。r2.ts は `process.env.R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` の **env 参照のみ(hardcode なし)**。
- **64-hex(2 commit)**: `.devcontainer/devcontainer-lock.json` の **container image digest**(public content-addressed hash・secret でない)。当該 file は f3e6aa5 で削除済。
- **Stripe/Clerk key prefix・Gemini・AWS・Supabase JWT・PRIVATE KEY block**: いずれも **0 件**。
- **非 secret 識別子**: stg/prod の Supabase project ref は `docs/ops/connections-and-env.md`(2026-07-26・本 H トラックで CC が追記)にのみ出現。**project ref は secret でない**(brief 定義)ゆえ報告のみ。`pooler.supabase.com` / `supabase.co` は README・docs の host 言及(credential 非随伴 = postgres URI パターンで credential 付きヒットしていない)。
- **`.env.example`(commit 済)**: 全 env が placeholder(`postgresql://...` / `sk_test_...` / `whsec_...` / `...` / 空値)。実値なし。
- **env file の履歴混入**: `.env.local` / `.env.stg` 等の commit 痕跡なし(`.gitignore` に `.env*` 登録済 + 履歴 path 走査で env file 0)。

## 既知 1 件(stg `DATABASE_URL_APP`)の照合結果

**git 履歴に無い(= コマンド出力のみで commit されていない)と確定。**

- 根拠: ① credential 付き supabase URI の全履歴走査で該当は `db.abcdefgh.supabase.co` 拒否テスト fixture の 1 件のみ(stg pooler host + 実パスワードの URI は 1401 commit / 全 branch に不在)② stg project ref `oxmbnzllwfalfgqjpssk` は `connections-and-env.md`(パスワード非随伴)にのみ出現 ③ `pooler.supabase.com` host 言及に credential(`user:pass@`)が随伴した commit は 0。
- → 露出は **ephemeral な CC コマンド出力に限局**し、session doc / log として履歴に残っていない。rotation の要否判断は OT(本スキャンは「履歴には無い」ことの確定まで)。

## 残余(limitation・取り繕わない)

- 本スキャンは **targeted pattern + 広域 net** であり gitleaks の entropy 検出ではない。**列挙 secret 種別に合致しない unknown-shape の高エントロピー値**は理論上見逃しうる。ただし RecallMint の secret は全て shape 付き(prefix / URI / JWT)+ env file 未混入 + 広域 net で `PASSWORD|SECRET|KEY|TOKEN` 長値代入を横断済ゆえ、残余リスクは低い。より強い保証が要るなら gitleaks を別 sprint で(egress/tool 導入の判断込みで)導入する。

## 実行境界(制約遵守の記録)

- 検出のみ。履歴書き換え・force push・file 削除・値の無効化なし。
- 値は本 doc・チャットとも非表示(pickaxe は diff 行非印字 / 分類時は credential を `***`・64-hex を `<64hex>` にマスクして環境のみ確認)。
- 有効性検証のための接続・API 呼び出しなし。
- 永続ツール pin 追加なし。走査条件は緩めず(過検出許容・広域 net + 複数 shape で見逃し回避)。
