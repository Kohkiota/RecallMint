# プロジェクトルール

## プロジェクト概要

多肢選択問題 PWA (mcq-platform)。学習資料 (テキスト/ノート/教材) を
AI OCR で MCQ 化し、FSRS 忘却曲線で復習する学習アプリ。
Notion 互換のカスタムプロパティ方式 (cards.custom_props /
exams.property_schema) でドメイン中立、マルチテナント対応。
リポジトリ: `Kohkiota/mcq-platform` (devcontainer-template + plan00
SaaS template を起点に派生、vocab 機能は drop / mcq 機能を新規追加中)。

**現フェーズ**: Phase 0b PoC 完全完了、Sprint A (DB migration +
環境構築) 着手前。詳細は `docs/02-tech-spec.md` §14 改訂履歴
(v0.6 + v0.6 続編) を参照。

## 技術スタック（固定）

- フロントエンド: Next.js 15.x (App Router)
- 言語: TypeScript (strict mode)
- スタイル: Tailwind CSS v4
- DB: PostgreSQL (Neon)
- ORM: Drizzle ORM
- 認証: Clerk (@clerk/nextjs)
- 決済: Stripe (stripe, @stripe/stripe-js)
- AI: Google Gemini 2.5 Flash 主軸 (Phase 0b PoC 実測値 1 問 0.1 円)。
  Pro fallback は v1.x で post-validation 失敗時のみ採用検討。
  Flash-lite はコスト最重視時の検討候補
- PWA: 骨格のみ (manifest.json + icons + metadata、Phase 1 G-pwa-1 で導入)
  service worker / offline cache / push 通知 / next-pwa パッケージは Phase 2 検討
- デプロイ: Vercel (Pro 昇格で Function timeout 900s 化、OCR は
  1 ファイル ≤ 150 ページ単発で完結)
- パッケージマネージャ: pnpm

**重要**: 上記以外のライブラリ導入時は事前相談。
API 仕様は Context7 MCP (`use context7`) から取得する。

---

## Stripe 取扱いの絶対ルール

1. 使用するキーは **`sk_test_` または `rk_test_` で始まるもののみ**
2. `sk_live_` / `rk_live_` / `pk_live_` の取り扱い禁止
   - コード内で参照しない
   - 設定ファイル・ドキュメント・コメント・テストにも書かない
3. **アプリ起動時にキーのプレフィックス検証を必須実装**
   `lib/stripe.ts` 冒頭で `sk_test_` / `rk_test_` 以外なら起動拒否
4. Webhook の検証を省略しない（`stripe.webhooks.constructEvent` 使用必須）
5. **Webhook は idempotency 必須**
   - `event.id` を `stripe_events` テーブルに保存、重複処理を弾く
   - エラー時も 200 を返す（Stripe の再送ループ防止）
   - タイムアウト 10 秒以内
6. 本番環境への切替は人間が手動、Claude Code は関与しない
7. Stripe CLI でのローカル webhook 転送のみ使用
   （本番 Webhook エンドポイント登録は人間が実施）

---

## Clerk 認証の取扱いルール

1. キーは `VERCEL_ENV` に応じて使い分け、`lib/clerk.ts` で fail-fast 検証
   - `VERCEL_ENV === 'production'` → `pk_live_` / `sk_live_` 必須
   - それ以外 (preview / development / undefined) → `pk_test_` / `sk_test_` 必須
   - 詳細: `docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md`
2. `middleware.ts` で保護ルート設定、未ログインはサインインページへ
3. サーバーコンポーネント: `auth()` / `currentUser()` を使用
4. クライアントコンポーネント: `useUser()` / `useAuth()` を使用
5. **DB の全テーブルに `user_id` カラム必須**
   クエリは必ず `WHERE user_id = ?` で絞る（テナント分離）
6. Clerk User と Stripe Customer の紐付けは `users` テーブルで管理
   （`clerk_id`, `stripe_customer_id` カラム）

---

## AI API 呼び出しの絶対ルール（AI使用時のみ）

1. **クレジットカード紐付けなし運用前提**（無料枠のみ）
2. **日次呼び出し上限を環境変数 `GEMINI_DAILY_LIMIT` で制御**
3. **DB に `ai_usage` テーブル（date, count）を持ち、呼び出しごとにカウントアップ**
4. 上限到達時は UI にエラー表示、API 呼び出し停止
5. **429 エラー受信時は即時停止、リトライ禁止**
6. タイムアウト必須（30 秒）、その他エラーは指数バックオフ最大 3 回
7. **AI 生成はユーザー明示トリガーのみ**（自動生成しない）
8. 無限ループで API を叩くコード・テストは絶対に書かない
9. テストではモック化必須、実 API を叩かない

---

## 品質基準

- TypeScript strict モード維持
- UI は一貫した世界観（色・タイポ・レイアウトの統一）
- テンプレ的 AI デザイン回避（紫グラデ、白カード羅列は禁止）
- モバイル実機（Chrome DevTools のモバイルビュー）で動作検証必須
- 決済フローは Stripe Checkout を使う（自前の決済フォームを作らない）
- Clerk UI コンポーネント（`<SignIn />`, `<UserButton />`）を基本使用
- プラン制限時は残り枠・上限・超過時メッセージを明示
- 各機能は実際に動くこと（モック・スタブで誤魔化さない）

## 役割境界

- 設計書（`docs/design.md`）は設計フェーズのみ更新
- 実装時に設計書を書き換えない（仕様変更が必要なら一旦停止して相談）
- 完了報告時は起動コマンドを必ず明記
- 「概ね良い」で済ませず、問題があれば具体的に指摘

## Review と Commit のルール（最重要）

### Review の必須性

feat(_) / fix(_) 系の commit は、auto mode 運用であっても必ず
**superpowers:requesting-code-review** skill 経由の formal review を
通すこと。velocity 優先で review を省略する判断をしてはならない。

**重要**: review は `superpowers:requesting-code-review` skill canonical
経路 (skill template + general-purpose subagent + 厳格 prompt) で行うこと。
skill template を使わない自由形式 review、 軽量 agent への投げ捨て、
template 改変は**禁止**。skill template は plan / spec / coding standards
に沿った正式 review prompt を担保するために整備されており、代替しない。

(註: superpowers 5.0.7 系では `superpowers:code-reviewer` という独立
subagent が存在したが、 5.1.0 で削除され `requesting-code-review` skill
+ general-purpose subagent に統合された。 plan00 では Phase 1 I-J / I-K
(2026-05-05 / 2026-05-07) で新経路を実運用検証済。 本 §Review 文言は
2026-05-07 mini-sprint で 5.1.0 ecosystem に整合 update。)

例外: chore(_) / docs(_) / test(_) / refactor(_) で実装ロジック変更を
含まないもののみ review スキップ可。

### Tag 運用

commit message 末尾に以下いずれかの tag を付与する:

- **`[reviewed]`**: requesting-code-review skill 経由の formal review 完了後
- **`[no-review]`**: review 不要な軽微変更 (typo / 単純 revert /
  コメント修正等) を意図的にスキップする場合

`.claude/hooks/check-review.sh` (Stop hook) が、直前 feat/fix commit に
どちらの tag も無ければ次タスクへの進行を **block** する。
構造的に review スキップを防ぐ仕組みなので、手動で無効化しないこと。

### Commit 直前の review ログ明示

feat/fix commit の直前に、以下 4 点を必ずユーザー応答内に明示してから
commit すること:

1. 呼び出した review 経路 (skill 名 = `superpowers:requesting-code-review`、
   subagent 種別 = general-purpose、 template 改変なし) の確認
2. review 結果の要約 (Critical N 件 / Important N 件 / Minor N 件)
3. Important 指摘を fix せずに残す場合は、その項目名と理由、
   および OT 承認済みである旨
4. [reviewed] tag を付けて commit する宣言

宣言なしで commit するのは禁止。ユーザーは review 経路と結果要約を見て、
skill template を経ない自由形式 review への代替が起きていないか、
および Important の握り潰しが起きていないかを確認できる必要がある。

### Review 結果の分類

review 結果は Critical / Important / Minor で分類すること:

- **Critical**: 即 fix。同一 commit に amend、または follow-up commit で解消
- **Important**: 原則 fix。ただし MVP スコープと関係薄い、または対応コストが
  高い場合は OT 判断を仰ぐ
- **Minor**: 記録のみで可 (nice-to-have、防御的プログラミング好み等)

---

## 重要 Fix の裏取り

以下のいずれかに該当する Fix は、code-reviewer の review pass だけでは
確定 ([reviewed] 付与) としない:

- **決済**に関わる変更 (Stripe Checkout / Customer portal / Webhook /
  subscription 状態遷移)
- **認証**に関わる変更 (Clerk middleware / session / protect ルート)
- **削除**を伴う変更 (アカウント削除 / データ cascade delete / 論理削除)
- **外部副作用**を伴う変更 (外部 API 呼び出し / email 送信 / Webhook 発火)

これらは **OT 実機観察での動作確認を経てから** [reviewed] tag を付与する。
手順: review pass → commit (tag 無し状態で一旦止まる) → OT 確認 →
`git commit --amend` で [reviewed] 追記。

対象外 (review pass で即 [reviewed] 付与可):

- UI 微調整 (色・余白・文言)
- typo 修正
- ロジック変更のない refactor (型付け強化・命名変更等)

## OT 向け出力規律

OT への chat 出力は以下構造を厳守。詳細 trace / log / 検証 step は
別 file (`docs/superpowers/sessions/` 等) に書き、chat には path のみ。

### 構造

1. **結論** (3-5 行): 何をやったか / 発見 / 次の一手
2. **論点** (あれば、1 行 bullet 選択肢併記)
3. **判断必要: yes / no** を明示
4. **詳細 file path** (あれば)

### 禁止

- 長文 prose による状況説明
- 同内容の言い換え繰り返し
- 「〜と思われます」連発 (確度を 1 行で)
- memory / 既定方針 / `CLAUDE.md` 既出ルールの再説明

### 例

```
復習 bug の root cause 特定。revalidatePath による server queue 動的縮小
+ client idx 独立前進の二重作用。
詳細: docs/superpowers/sessions/2026-05-04-review-bug-trace.md

論点:
- 再 due card 取扱い: A) 同 session 再出題 / B) 次 session 待ち
- 完了判定: A) 全件解いたら完了 / B) due 0 で完了

判断必要: yes
```

### 適用

- spec / plan / 実装報告 / retro 全 phase に適用
- subagent 中間出力 / skill 内部 trace は対象外、最終 OT 提示時のみ本規律

### kickoff prompt 受領時

- plan 級詳細 (test 戦略 / 修正 logic / コード片 / 検証 step) を kickoff
  に求めない。不足は自分で skill (writing-specs / brainstorming) で drafting
- claude.ai に具体実装方法を求めない (claude.ai は判断材料整理担当、実装方法
  判断は OT 専権)

## Plan の書き方（writing-plans への指示）

Plan は**設計判断の記録**。実装コードそのものではない。

### 禁止

- ファイルの完全な中身（`package.json` / Drizzle schema / component 等）を plan 内に書かない。コードは Generator が TDD で書く
- `pnpm create next-app` / `pnpm add` で済む scaffolding を複数タスクに割らない（1 タスクにまとめる）
- 「`pnpm dev` で起動確認」等の検証を TDD ステップと呼ばない

### 各タスクに書くこと（3 要素のみ）

1. **目的** — 何を、なぜ
2. **制約** — 型・命名・依存・上記の絶対ルール（Stripe / Clerk / AI）のどれを守るか
3. **完了条件** — テスト可能な形で + code-reviewer の Critical 0 件 + commit に [reviewed] tag

### 書き方の原則

- 実装コード本体 (関数定義 / schema 全文 / component 全文 / test case 全文) を
  plan 内に書かない。コードは Generator が TDD で書く
- 各タスクは「何を / どんな制約で / 完了をどう判定するか」のみ記述

❌「`lib/foo.ts` を作る (実装コード 20 行)」
✅「`lib/foo.ts` は X を検証、Y で throw。test 通過 + Critical 0 件 + [reviewed]」

### 分量の目安と超過時の停止ルール

- plan 全体: **150〜250 行以内**
- 各タスク: **10〜20 行**
- 全体ルールは冒頭に一度だけ、各タスクからは**参照**のみ（再掲しない）

**plan が 300 行を超えた時点で STOP し、ユーザーに相談すること**。
スコープ分割または抽象度を上げる修正が必要で、Generator が推測で進める
フェーズではない。

各 Sprint の plan 書き終わり時点で **最終行数を報告すること**
（例: 「Sprint 2 plan 完成: 187 行 / 上限 250」）。

### Sprint 境界の停止ルール

各 Sprint 完了時点で停止し、OT の判断を待つこと。
複数 Sprint を連続で auto mode で走らせてはならない。
Sprint 内であっても、Critical 検出 / 仕様の解釈揺れ / 外部サービス設定変更が
必要な場合は停止して OT に相談すること。

## 環境変数の取扱い

新規環境変数を参照するコードを書くとき、**同じ commit で `.env.example`
に項目を追加する**。追加し忘れると、clone 先で「動かない」を毎回デバッグ
することになる。

- 値はプレースホルダ (`...`) のみ。実値は `.env.local` にしか書かない
- 「後から埋める」マーカーは空値記法 (`CLERK_WEBHOOK_SECRET=`) を使う
- 取得タイミングが非自明なものはコメントで補足
  (例: `# Vercel デプロイ後に Clerk Dashboard で取得`)
- deploy 前チェックで「`.env.example` に全環境変数が記載」を再確認

## コーディング規約

- ファイル名: kebab-case（例: `user-profile.tsx`）
- コンポーネント名: PascalCase
- 関数名: camelCase
- 定数: UPPER_SNAKE_CASE
- import 順: 外部ライブラリ → 内部モジュール → 相対パス
- コメントは「なぜ」を書く（「何を」はコードから読める）

## テスト方針

- Unit: Vitest（FSRS 等の数値計算、課金ガード、プレフィックス検証は特に厚く）
- E2E: Playwright MCP で実ブラウザ検証
- Stripe: `stripe.webhooks.generateTestHeaderString` で webhook テスト
- Clerk: Clerk のテスト用トークン機能を使用
- AI API: モック必須（実 API は絶対に叩かない）

## 立ち上げ時の必須修正

`pnpm create next-app` 直後、`docs/setup-notes.md` の 3 点
（bufferutil / watchOptions / .gitignore 追加）を必ず実施。
scaffold デフォルトのままでは dev server 無限ループ / Neon 接続失敗が起きる。
plan00 は scaffold 完了済み、3 点反映済み。

## デプロイ前チェックリスト

- [ ] `pnpm build` がエラーなく完了
- [ ] `pnpm test` が全通過
- [ ] `.env.example` に全環境変数が記載
- [ ] `.env.local` が `.gitignore` に入っている
- [ ] Stripe キーが `sk_test_` / `rk_test_` で始まることを確認
- [ ] Clerk キーが `pk_test_` / `sk_test_` で始まることを確認
- [ ] すべての feat(_) / fix(_) commit に [reviewed] tag がついている
- [ ] `README.md` に起動手順が記載
