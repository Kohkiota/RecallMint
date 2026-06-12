# プロジェクトルール

## 概要 / スタック

RecallMint(旧 mcq-platform): 学習資料を AI OCR で MCQ 化し FSRS で復習する学習 SaaS。local-first(Dexie/IndexedDB mirror + outbox)。リポジトリ: `Kohkiota/RecallMint`。
現フェーズ・ロードマップは sprint docs(`docs/plans/` / `docs/superpowers/`)と OT 管理の todo が正本。**本 file に進捗を書かない**。

- Next.js 16.x(App Router)/ TypeScript strict / Tailwind v4 / pnpm(packageManager field が SSoT)
- PostgreSQL(Supabase)+ Drizzle / Dexie(client mirror + entity_mutations outbox)
- Clerk(認証)/ Stripe(決済)/ Gemini 2.5 Flash(@google/genai)
- Vercel(hnd1 / Function timeout 900s)/ Node 24
- 新ライブラリ導入は事前相談。API 仕様は Context7 MCP で裏取り、**最新 patch 版の判定は registry 直叩きが正**(Context7 は patch に遅れる)

## Stripe(絶対)

1. キーは `VERCEL_ENV` で分岐、`lib/stripe.ts` で fail-fast(production = live のみ / その他 = test のみ。SECRET は `rk_` Restricted Key 推奨)
2. webhook 署名検証(`constructEvent`)+ idempotency(`stripe_events` に event.id 保存)必須。エラー時も 200 を返す(再送ループ防止)、timeout 10 秒以内
3. 本番切替(live key / Vercel env / endpoint 登録)は OT 手動、CC 関与不可。ローカルは Stripe CLI 転送のみ

## Clerk(絶対)

1. キーは `VERCEL_ENV` で分岐、`lib/clerk.ts` で fail-fast
2. `proxy.ts` で保護ルート設定。Server: `auth()` / `currentUser()`、Client: `useUser()` / `useAuth()`
3. **全 table に `user_id` 必須**、query は必ず `WHERE user_id = ?`
4. Clerk User ↔ Stripe Customer の紐付けは `users` table(`clerk_id`, `stripe_customer_id`)

## AI API(絶対)

1. 無料枠のみ運用(カード紐付けなし)。日次上限 `GEMINI_DAILY_LIMIT` + `ai_usage` カウント、上限到達で UI エラー + 停止
2. **429 受信で即停止・リトライ禁止**。外部 API call はタイムアウト必須(値は tech-spec で定義)
3. 生成はユーザー明示トリガーのみ(自動生成禁止)。無限ループで叩くコード・テスト禁止。test は mock 必須(実 API 禁止)

## 品質基準

- TypeScript strict / UI は一貫した世界観(テンプレ的 AI デザイン回避: 紫グラデ・白カード羅列禁止)
- mobile 実機 view(DevTools)で動作検証必須
- 決済は Stripe Checkout(自前フォーム禁止)、認証は Clerk UI component 基本使用
- プラン制限時は残り枠・上限・超過 message を明示。各機能は実動(モック・スタブで誤魔化さない)

---

## Sprint フロー(skill skip 禁止)

`brainstorming`(spec 起草 = 同 skill 内 step 6。`writing-specs` という独立 skill は存在しない)/ `writing-plans` を CC 独断で skip 禁止。brief を「spec + plan 確定済」と解釈する判断は OT 専権。

**着手前宣言**(feat/fix 系 task の着手直前に chat へ): ① 現在 phase ② skill 起動方針(A full / B 部分 skip + 根拠1行 / C 全 skip + 根拠1行)③ OT 承認要否。迷ったら full flow。C は brief が scope + 完了条件 + やらないこと + 実装手段を 1-2 file 粒度で具体指定している場合のみ。skip ミスに気付いたら即中断して OT に巻き戻し/継続を仰ぐ(cover up 禁止)。

**実装方式の既定** = `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)。`executing-plans` は OT が明示選択した場合のみ。

**subagent dispatch は常に foreground で行う**。`run_in_background` は使用禁止(背景: 完了通知の取りこぼしで停止する既知バグ anthropics/claude-code#20236、および background agent の write auto-deny)。並列が必要な場合は同一メッセージ内の複数 Task 呼び出しで行う。

---

## Review と Commit(最重要)

### 順序の絶対則

**review pass → commit([reviewed] 込み)の一方向のみ。commit してから review する順序は禁止。**
tag の後付け amend が必要になった時点で順序違反(未 push なら amend 可だが、原則発生させない)。

### task 完了後の標準フロー(第二の順序則)

1. 実装 + review pass + commit → stop checkpoint 報告で CC は必ず停止
2. OT + claude.ai が報告チェック → OK なら OT が push
3. stg deploy 反映後、OT 指示で CC が stg smoke を DevTools MCP で実走(push 前に stg を叩かない、旧コード smoke は無意味)
4. CC で検証困難な smoke(実機依存 / 決済実行 / 破壊的操作 等)のみ OT 実機
5. prod 反映判断は smoke 結果を見て OT

補足: 重要 fix(決済・認証・削除・外部副作用)の [reviewed] は OT 実機確認後 — push 時点はタグなしを許容し確認後 OT 指示で旗を立てる(既存規律)。smoke の省略・代替(単体 test を正とする等)は plan に 1 行明記した場合のみ可。

### 必須経路

feat(_) / fix(_) は `superpowers:requesting-code-review` skill canonical 経路(skill template + general-purpose subagent + 厳格 prompt、改変禁止)。自由形式 review / 軽量 agent 投げ捨て禁止。velocity 優先で省略不可。
例外: chore / docs / test / refactor で実装ロジック変更なしのみ skip 可(= `[no-review]`)。

### Tag と hook

commit 末尾に `[reviewed]`(formal review 完了)or `[no-review]`(意図的 skip)。`.claude/hooks/check-review.sh`(Stop hook)が tag 無し feat/fix を block する。手動無効化禁止。

### Commit 直前の宣言(feat/fix)

chat に4点: ① review 経路(skill 名 / general-purpose / template 改変なし)② 結果(Critical N / Important N / Minor N)③ Important を残す場合は項目 + 理由 + OT 承認済み旨 ④ [reviewed] 付与宣言。宣言なし commit 禁止。

### 結果分類

Critical = 即 fix / Important = 原則 fix(MVP スコープ薄・コスト高は OT 判断)/ Minor = 記録のみ可。

### 重要 Fix の裏取り

**決済・認証・削除・外部副作用**に触れる fix は review pass だけで [reviewed] を付けない: review pass → commit(tag 無し)→ OT 実機確認 → 未 push amend で [reviewed] 追記。UI 微調整 / typo / ロジック不変 refactor は対象外。

### docs の commit

確定した docs(spec / plan / session log / lessons)は**必ず即 commit**(`docs(_)` + `[no-review]`)。未 commit 放置禁止。

---

## Sprint 完了 gate(恒久規律)

lint gate はローカル3層: ① eslint.config.mjs(ルール正本)② lefthook pre-commit(staged のみ)③ sprint 完了 gate + review checklist(whole-repo)。GHA は不採用(PR なし運用、git 履歴 `6958d18` から復活可)。

**全 sprint 共通**: 完了時に whole-repo `pnpm lint`(--max-warnings=0)exit 0。報告 chat に「whole-repo lint exit 0 確認済」を1行明記。
**依存 / Next / Node / lockfile を触る sprint は追加**: `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` 全 exit 0。
**Next 設定 file (matcher / proxy.ts / next.config.\*) を触る task は per-task gate に追加**: `pnpm build` 必須 (vitest / typecheck / lint は内部 js regex で動作するため Next.js matcher の path-to-regexp 制約 (capturing group / lookahead 禁止) を検出不能、 Vercel build で初めて表面化する。 Y-2 T-A4 で実際に発生、 commit 45a74cf → 6f82025 で hotfix)。
**review dispatch の観点 list にも whole-repo lint 実行確認を必須項目として含める**(CC と reviewer の2経路。どちらか漏れたら完了報告に明記して OT 判断)。

`git commit --no-verify` / `-n` は**全面禁止**。hook が失敗したら根本原因を fix(設計問題なら lefthook.yml を編集して明示的に直す)。

---

## OT 向け出力規律

chat には結論のみ。詳細 trace / log は `docs/superpowers/sessions/` 等に書き path 提示。

構造: ① 結論(3-5 行)② 論点(あれば text 番号 bullet。選択式 UI 不使用 — OT は自由形式で一括返答)③ **判断必要: yes / no** ④ 詳細 file path。
禁止: 長文 prose の状況説明 / 言い換え反復 / 確度曖昧表現の連発 / CLAUDE.md 既出ルールの再説明。

### Smoke 確認

原則 CC が DevTools MCP(chrome-devtools / playwright)で実行し、証拠(Network reqid / IDB 抜粋 / console / snapshot)を report に含める。OT 依頼は次のみ: 課金 API 実走系 / CC 環境で届かない条件(物理 mobile / push / Stripe 本番等)/ CC が環境制約で頓挫した場合。依頼時は ① URL ② 手順 ③ 期待挙動 ④ mobile 要否 を整理(丸投げ禁止)。

### kickoff prompt 受領時

plan 級詳細(test 戦略 / コード片)を kickoff に求めない — 不足は skill で自分で drafting。claude.ai は判断材料整理担当、実装方法判断は OT 専権。

---

## Plan の書き方(writing-plans)

Plan は**設計判断の記録**。各 task は ① 目的 ② 制約(型 / 命名 / 絶対ルールのどれを守るか)③ 完了条件(テスト可能 + Critical 0 + [reviewed])の3要素のみ、10-20 行。全体ルールは冒頭一度、task からは参照。
禁止: file 完全な中身を書く / scaffolding を複数 task に割る / 起動確認を TDD step と呼ぶ。
分量: 150-250 行。**300 行超で STOP・OT 相談**。完成時に最終行数を報告。

### Spec の凍結

spec は実装フェーズで書き換えない(仕様変更が必要なら停止して OT 相談)。

### Sprint 境界の停止

各 Sprint 完了で停止、OT 判断待ち。複数 Sprint の連続 auto mode 禁止。Sprint 内でも Critical 検出 / 仕様解釈揺れ / 外部サービス設定変更要で停止。

---

## 環境変数

新規 env を参照するコードと**同 commit で `.env.example` に追加**(値はプレースホルダ、実値は `.env.local` のみ、後から埋める項目は空値記法 `KEY=`)。取得タイミング非自明はコメント補足。deploy 前に全 env 記載を再確認。

## コーディング規約

- file kebab-case / Component PascalCase / 関数 camelCase / 定数 UPPER_SNAKE_CASE。import 順: 外部 → 内部 → 相対。コメントは「なぜ」のみ
- **flat ESLint config の `files:` glob は minimatch 評価** — route group `(...)` / dynamic segment `[...]` は `\\(...\\)` / `\\[...\\]` で escape(escape 不在は silent に override 不発)

## テスト方針

Unit: Vitest(FSRS / 課金ガード / プレフィックス検証は厚く)。E2E: Playwright MCP。Stripe: `generateTestHeaderString`。Clerk: test トークン。AI: mock 必須。

## デプロイ前チェック

- [ ] `pnpm build` / `pnpm test` 全通過
- [ ] `.env.example` に全 env 記載、`.env.local` が `.gitignore` 入り
- [ ] Stripe / Clerk キーが環境に対し正しい prefix
- [ ] 全 feat / fix commit に [reviewed] tag
