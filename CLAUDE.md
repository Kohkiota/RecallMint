# プロジェクトルール

## プロジェクト概要

多肢選択問題 PWA (mcq-platform)。学習資料を AI OCR で MCQ 化し、 FSRS 忘却曲線で
復習する学習アプリ。 Notion 互換のカスタムプロパティ方式 (cards.custom_props、
freeform jsonb) でドメイン中立、マルチテナント対応。
リポジトリ: `Kohkiota/mcq-platform` (devcontainer-template + plan00 SaaS
template 起点、 vocab drop / mcq 新規追加中)。

**現フェーズ**: Sprint A 系 (A-1a / A-2 / A-3.2) 完了、 本番初回 deploy 成功。
詳細は `docs/02-tech-spec.md` および sprint 個別 plan (`docs/plans/`) 参照、
全体ロードマップ / 改訂履歴は Obsidian 管理。

## 技術スタック (固定)

- Frontend: Next.js 15.x (App Router) / TypeScript strict / Tailwind v4
- DB: PostgreSQL (Supabase) / Drizzle ORM
- 認証: Clerk (@clerk/nextjs) / 決済: Stripe
- AI: Google Gemini 2.5 Flash 主軸 (PoC 実測 1 問 0.1 円)。 Pro fallback は v1.x で
  post-validation 失敗時のみ検討、 Flash-lite はコスト最重視時の候補
- PWA: 骨格のみ (manifest + icons + metadata)。 service worker / offline /
  push / next-pwa は Phase 2 検討
- Deploy: Vercel (Pro / Function timeout 900s、 OCR は 1 ファイル ≤ 150p 単発)
- Package: pnpm

**重要**: 上記以外のライブラリ導入時は事前相談。 API 仕様は Context7 MCP
(`use context7`) から取得。

---

## Stripe 取扱い (絶対)

1. キーは `VERCEL_ENV` で使い分け、 `lib/stripe.ts` で fail-fast
   - `production` → `rk_live_`/`sk_live_` + `pk_live_` (test 拒否)
   - その他 → `rk_test_`/`sk_test_` + `pk_test_` (live 拒否)
   - SECRET*KEY は `rk*\*` Restricted Key 推奨
2. Webhook 検証必須 (`stripe.webhooks.constructEvent`)
3. Webhook idempotency 必須
   - `event.id` を `stripe_events` table に保存、 重複処理を弾く
   - エラー時も 200 を返す (再送ループ防止)、 timeout 10 秒以内
4. 本番切替 (live key 発行 / Vercel env / Webhook endpoint 登録) は人間が手動、
   Claude Code 関与不可
5. ローカルは Stripe CLI 転送のみ使用

## Clerk 認証 (絶対)

1. キーは `VERCEL_ENV` で使い分け、 `lib/clerk.ts` で fail-fast
   - `production` → `pk_live_`/`sk_live_` / その他 → `pk_test_`/`sk_test_`
   - 詳細: `docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md`
2. `middleware.ts` で保護ルート設定
3. Server: `auth()` / `currentUser()`、 Client: `useUser()` / `useAuth()`
4. **全 table に `user_id` カラム必須**、 query は必ず `WHERE user_id = ?` で絞る
5. Clerk User と Stripe Customer の紐付けは `users` table (`clerk_id`,
   `stripe_customer_id`)

## AI API 呼出 (絶対、 AI 使用時のみ)

1. クレジットカード紐付けなし運用前提 (無料枠のみ)
2. 日次上限を `GEMINI_DAILY_LIMIT` で制御
3. `ai_usage` table (date, count) で呼出毎にカウントアップ
4. 上限到達で UI エラー + API 停止
5. **429 受信で即時停止、 リトライ禁止**
6. timeout 30s 必須、 その他は指数バックオフ 最大 3 回
7. 生成はユーザー明示トリガーのみ (自動生成禁止)
8. 無限ループで叩くコード・テストは禁止
9. test では実 API 禁止、 モック必須

---

## 品質基準

- TypeScript strict / UI は一貫した世界観 (色・タイポ・レイアウト統一)
- テンプレ的 AI デザイン回避 (紫グラデ・白カード羅列禁止)
- mobile 実機 (Chrome DevTools mobile view) で動作検証必須
- 決済は Stripe Checkout (自前フォーム禁止)、 認証は Clerk UI component 基本使用
- プラン制限時は残り枠・上限・超過時 message を明示
- 各機能は実動 (モック・スタブで誤魔化さない)

## 役割境界

- 設計書 (`docs/design.md`) は設計フェーズのみ更新、 実装時は書き換えない
  (仕様変更要なら停止して相談)
- 完了報告に起動コマンド必記、 「概ね良い」 で済ませず具体指摘

---

## Sprint kickoff のフロー規律 (skill skip 禁止)

`brainstorming` / `writing-specs` / `writing-plans` の各 superpowers skill を
Claude Code が独断で skip するのは禁止。 brief を「spec + plan 確定済」と
解釈する判断は OT 専権。

**着手前宣言** (feat/fix 系 task の着手直前、 chat に明示):

1. 現在 phase (brainstorming / spec / plan / execute / review)
2. skill 起動方針: (A) full flow / (B) 部分 skip + 根拠 1 行 /
   (C) 全 skill skip + 根拠 1 行
3. OT 承認要否

**Skip 判断**: 迷ったら full flow。 全 skill skip (C) は brief が scope +
完了条件 + やらないこと + 実装手段を 1-2 ファイル粒度で具体指定している場合のみ
許容。 境界で迷えば OT 確認必須。

**skip ミスに進行中気付いたら**: 即中断、 OT に「巻き戻し」か「継続承認」を
仰ぐ。 cover up (黙って続行 / 後付け正当化) は禁止。

(初出経緯: 2026-05-27 cache-fix roadmap ④-1 / ④-4 で skill 全 skip 発生)

---

## Review と Commit (最重要)

### 必須経路

feat(_) / fix(_) は auto mode でも **`superpowers:requesting-code-review`
skill canonical 経路** (skill template + general-purpose subagent + 厳格
prompt) を通すこと。 自由形式 review / 軽量 agent 投げ捨て / template 改変は
**禁止**。 velocity 優先で省略不可。

例外: chore(_) / docs(_) / test(_) / refactor(_) で実装ロジック変更なしのみ
スキップ可。

(註: superpowers 5.0.7 の `code-reviewer` 独立 subagent は 5.1.0 で削除、
`requesting-code-review` skill + general-purpose subagent に統合。 plan00
Phase 1 I-J / I-K で運用検証済)

### Tag 運用

commit message 末尾:

- `[reviewed]`: formal review 完了後
- `[no-review]`: 軽微変更 (typo / 単純 revert / コメント修正) を意図的 skip

`.claude/hooks/check-review.sh` (Stop hook) が tag 無し commit を block する。
手動無効化禁止。

### Commit 直前の review ログ明示

feat/fix commit 直前に以下 4 点を chat に明示:

1. 呼出 review 経路 (skill 名 / subagent 種別 = general-purpose /
   template 改変なし)
2. review 結果 (Critical N / Important N / Minor N)
3. Important を fix せず残す場合: 項目名 + 理由 + OT 承認済み旨
4. [reviewed] tag 付与宣言

宣言なし commit 禁止。

### 結果分類

- **Critical**: 即 fix (amend or follow-up)
- **Important**: 原則 fix。 MVP スコープ薄 or コスト高は OT 判断
- **Minor**: 記録のみ可

### 重要 Fix の裏取り

以下に該当する Fix は code-reviewer pass だけで [reviewed] 付与しない:

- **決済** (Stripe Checkout / portal / Webhook / subscription)
- **認証** (Clerk middleware / session / 保護ルート)
- **削除** (アカウント削除 / cascade / 論理削除)
- **外部副作用** (外部 API / email / Webhook 発火)

手順: review pass → commit (tag 無し) → OT 実機確認 → `git commit --amend` で
[reviewed] 追記。

対象外 (review pass で即 [reviewed] 可): UI 微調整 / typo / ロジック変更なし
refactor。

---

## OT 向け出力規律

chat には結論のみ、 詳細 trace / log / 検証 step は別 file
(`docs/superpowers/sessions/` 等) に書き path 提示。

### 構造

1. **結論** (3-5 行): 何をやった / 発見 / 次の一手
2. **論点** (あれば、 text 番号 bullet `A. / B. / C.` で 1 メッセージ提示。
   AskUserQuestion 等の選択式 UI は使わない — OT は自由形式で全論点に一括返答)
3. **判断必要: yes / no**
4. **詳細 file path** (あれば)

### 禁止

- 長文 prose の状況説明 / 言い換え繰り返し
- 「〜と思われます」 連発 (確度を 1 行で)
- memory / 既定方針 / `CLAUDE.md` 既出ルールの再説明

### 例

```
復習 bug の root cause 特定。 revalidatePath による server queue 動的縮小
+ client idx 独立前進の二重作用。
詳細: docs/superpowers/sessions/2026-05-04-review-bug-trace.md

論点:
- 再 due card 取扱い: A) 同 session 再出題 / B) 次 session 待ち
- 完了判定: A) 全件解いたら完了 / B) due 0 で完了

判断必要: yes
```

### Smoke 確認

**実行担当**: 原則 Claude Code が DevTools MCP (chrome-devtools / playwright)
で実行。 以下のみ OT 依頼:

- 課金 API 呼出を伴うもの (OCR / AI 実走系)
- Claude Code 環境で届かない条件 (物理 mobile / push / Stripe 本番 /
  OT 専用 Clerk 設定 等)
- Claude Code が試行して環境制約で頓挫 (例: Vercel Live iframe → chrome-error)

**手順**: 着手 / 依頼前に整理:

1. 確認 URL 2. 確認手順 3. 期待挙動 4. mobile 要否

「動作確認してください」 だけの丸投げ禁止。 Claude Code 実行時は DevTools 証拠
(Network reqid 順序 / IDB 抜粋 / console / snapshot) を report に含める。

### kickoff prompt 受領時

- plan 級詳細 (test 戦略 / 修正 logic / コード片 / 検証 step) を kickoff に
  求めない。 不足は自分で skill (writing-specs / brainstorming) で drafting
- claude.ai に実装方法を求めない (claude.ai は判断材料整理担当、 実装方法判断
  は OT 専権)

---

## Plan の書き方 (writing-plans 指示)

Plan は**設計判断の記録**、 実装コードそのものではない。

### 禁止

- ファイル完全な中身 (`package.json` / schema / component) を plan に書かない
  (コードは Generator が TDD で書く)
- `pnpm create next-app` / `pnpm add` 等 scaffolding を複数 task に割らない
  (1 task)
- 「`pnpm dev` で起動確認」 等を TDD step と呼ばない

### 各タスクに書く 3 要素のみ

1. **目的**: 何を、 なぜ
2. **制約**: 型 / 命名 / 依存 / 絶対ルール (Stripe / Clerk / AI) のどれを守るか
3. **完了条件**: テスト可能 + code-reviewer Critical 0 件 + [reviewed] tag

❌「`lib/foo.ts` を作る (実装コード 20 行)」
✅「`lib/foo.ts` は X 検証、 Y で throw。 test 通過 + Critical 0 + [reviewed]」

### 分量

- plan 全体: 150〜250 行 / 各タスク: 10〜20 行
- 全体ルールは冒頭一度のみ、 各タスクからは**参照**

**plan 300 行超過で STOP、 OT 相談**。 各 Sprint plan 書き終わり時点で
**最終行数を報告** (例: 「Sprint 2 plan 完成: 187 行 / 上限 250」)。

### Sprint 境界の停止

各 Sprint 完了で停止、 OT 判断待ち。 複数 Sprint を連続 auto mode 禁止。
Sprint 内でも Critical 検出 / 仕様解釈揺れ / 外部サービス設定変更要時は停止。

---

## 環境変数

新規環境変数を参照するコードを書く時、 **同 commit で `.env.example` に項目追加**。

- 値はプレースホルダ (`...`) のみ、 実値は `.env.local` のみ
- 「後から埋める」 マーカーは空値記法 (`CLERK_WEBHOOK_SECRET=`)
- 取得タイミング非自明はコメント補足
  (例: `# Vercel deploy 後に Clerk Dashboard で取得`)
- deploy 前に「全環境変数が `.env.example` に記載」 を再確認

## コーディング規約

- ファイル名 kebab-case / Component PascalCase / 関数 camelCase /
  定数 UPPER_SNAKE_CASE
- import 順: 外部 → 内部 → 相対
- コメントは「なぜ」 (「何を」 はコードから読める)

## テスト方針

- Unit: Vitest (FSRS / 課金ガード / プレフィックス検証は特に厚く)
- E2E: Playwright MCP で実ブラウザ
- Stripe: `stripe.webhooks.generateTestHeaderString` で webhook test
- Clerk: test 用トークン機能
- AI: モック必須 (実 API 禁止)

## 立ち上げ時必須修正

`pnpm create next-app` 直後、 `docs/setup-notes.md` の 3 点 (bufferutil /
watchOptions / .gitignore 追加) を必ず実施。 scaffold デフォルトのままでは
dev server 無限ループ / Neon 接続失敗。 plan00 は反映済み。

## デプロイ前チェック

- [ ] `pnpm build` エラーなし
- [ ] `pnpm test` 全通過
- [ ] `.env.example` に全環境変数記載
- [ ] `.env.local` が `.gitignore` 入り
- [ ] Stripe キー `sk_test_` / `rk_test_` 確認
- [ ] Clerk キー `pk_test_` / `sk_test_` 確認
- [ ] 全 feat(_) / fix(_) commit に [reviewed] tag
- [ ] `README.md` に起動手順記載
