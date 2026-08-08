# プロジェクトルール

## 概要 / スタック

RecallMint(旧 mcq-platform): 学習資料を AI OCR で MCQ 化し FSRS で復習する学習 SaaS。local-first(Dexie/IndexedDB mirror + outbox)。リポジトリ: `Kohkiota/RecallMint`。
現フェーズ・ロードマップは sprint docs(`docs/plans/` / `docs/superpowers/`)と OT 管理の todo が正本。**本 file に進捗を書かない**。
**todo / backlog / roadmap は claude.ai 側が正本で repo に置かない**(2026-08-06 一本化)。repo 側に todo doc を新設・復活させない。恒久の記録先は用途で決まる: 機構 = `docs/harness.md` / 設計不変条件・証明の空白 = `docs/architecture.md` / 経緯と実測 = `docs/superpowers/sessions/` / 教訓 = `docs/superpowers/lessons/`。**follow-up は claude.ai の todo へ渡す**(chat 報告に全文を出す)。

- Next.js 16.x(App Router)/ TypeScript strict / Tailwind v4 / pnpm(packageManager field が SSoT)
- PostgreSQL(Supabase)+ Drizzle / Dexie(client mirror + entity_mutations outbox)
- Clerk(認証)/ Stripe(決済)/ Gemini 2.5 Flash(@google/genai)
- Vercel(hnd1 / Function timeout 900s)/ Node 24
- 新ライブラリ導入は事前相談。API 仕様は Context7 MCP で裏取り、**最新 patch 版の判定は registry 直叩きが正**(Context7 は patch に遅れる)

## Stripe(絶対)

1. キーは `VERCEL_ENV` で分岐、`lib/stripe/client.ts` で fail-fast(production = live のみ / その他 = test のみ。SECRET は `rk_` Restricted Key 推奨)
2. webhook 署名検証(`constructEvent`)+ idempotency(`stripe_events` に event.id 保存)必須。エラー時も 200 を返す(再送ループ防止)、timeout 10 秒以内
3. 本番切替(live key / Vercel env / endpoint 登録)は OT 手動、CC 関与不可。ローカルは Stripe CLI 転送のみ

## Clerk(絶対)

1. キーは `VERCEL_ENV` で分岐、`lib/clerk/env-check.ts` で fail-fast
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

**ツール呼び出しのテキスト漏れ(既知 harness バグ)**: 稀にツール呼び出しがパースされず本文テキスト化して未実行になる(副作用ゼロ)。`.claude/hooks/detect-leaked-toolcall.sh`(Stop hook)が検出し 1 回だけ自動で言い直させる。言い直しは **prose を書かず、ツール呼び出し 1 件だけを応答の先頭要素**として出す。**同一セッションで 2 回以上再発したら復旧を試みず**(context 汚染で retry 自体が再発源)、作業状態を報告して停止(新セッション移行は OT 判断)。詳細: `docs/superpowers/lessons/2026-07-03-malformed-toolcall-leak-investigation.md`。

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
例外: chore / docs / refactor で実装ロジック変更なしは skip 可(= `[no-review]`)。

**test-only 変更は「保証の増減」で分岐**(2026-07-18 制定、遡及なし。背景 = docs/audit/2026-07-17-test-quality-audit.md — 検出力の空振りと主張の不正確は別の欠陥で、red と review は同じものを見ていない):

- **増**(新規 pin / assertion 追加)= **red 検証必須**(その保証を壊す変異で fail する実証、commit message に「**red 検証**」記録行)+ **簡易 review**(主張の記述が正確か: 何を pin し何を保証しないか。canonical subagent へ専用観点 dispatch or Codex)→ `[reviewed]`
- **減**(assertion 削除 / 期待値緩和 / skip 化)= **review 必須**(何の保証を落とすか・なぜ落としてよいかを message に「**保証減**」+ 理由で明示)→ `[reviewed]`。減に red は原理的に不成立(新しい主張がない)
- **保証不変の整理**(fixture 更新 / 命名 / rename)= skip 可(= `[no-review]` + message に「**保証不変**」)
- 混在 diff は両 gate 適用。分類は自己申告 + commit message 宣言(既存 tag 規律と同じ・事後 grep 可能性で受容)
- **宣言の形式は Stop hook が強制**: `.claude/hooks/check-review.sh` が test-only diff(全変更 file が `*.test.ts(x)` / `tests/**`)の commit を検出し、tag + 上記宣言 token の不在を block。強制は形式のみ — 分類の正直さと red の実走は宣言者責務、虚偽宣言は cover up として扱う
- 原理: red = 検出力(効いているか)/ review = 主張の妥当性(言っていることが正しいか)。役割が違うため序列なし

### レビュアーは superpowers ネイティブ reviewer

feat/fix の canonical review は `superpowers:requesting-code-review` の**デフォルト経路**(汎用 general-purpose subagent + template `code-reviewer.md` の `## Read-Only Review` 文言、read-only が本体保証)で回す。template 改変禁止は従来どおり。

`pr-review-toolkit` 専門エージェント配線は**撤去した**(`.claude/settings.json` の `enabledPlugins` から無効化済)。撤去理由: 6 体中 `code-simplifier` が指摘専用でなく Edit/Write で**能動的にコードを書き換える実装者**であり read-only レビュー枠と両立しない、残り 5 体も本体に書込抑止が無く厳格 prompt 依存(`comment-analyzer` のみ本体 read-only)で「想定=指摘のみ / 実体=書込可能」のズレを持つため。reviewer の多観点強化は **Codex 独立レビュー**(後述)で担保する。

### Codex 協調レビュー(canonical 後 / commit 前)

canonical review(native reviewer)pass 後・`[reviewed]` commit 前に、Codex を独立レビュアーとして実行する: `scripts/ai/codex-review.sh <topic>`。reviewer の多観点強化はこの Codex で担保(pr-review-toolkit の代替)。

- **対象** = HEAD に対する未 commit 変更一式(staged+unstaged+untracked。`codex exec review --uncommitted` がネイティブに拾う)。対象範囲は feat/fix の非自明変更のみ — chore/docs/ロジック不変 refactor は canonical 同様 skip 可、test-only は「必須経路」の増減分岐に準拠(増の簡易 review の担い手として Codex を使ってよい)。
- **Codex = レビュー専用(指摘のみ)。修正主体は CC 本体**。Codex に canonical の結論を見せない(anchor 防止 — 独立に diff を見させる)。
- **重大度マッピング(語彙統一)**: Codex の P0/P1 → Critical / P2 → Important / P3,P4 → Minor。canonical も Critical/Important/Minor で返るため両者を**同一語彙・同一収束条件**で扱う。分類後の扱いは「結果分類」準拠。
- **fix ループ**: CC が canonical 指摘 + Codex 保存 md(`docs/codex/`)の両方を読む → 修正(CC)→ 再 review を、**未解決 Critical 0 かつ未解決 Important 0** まで反復。安全弁 = **上限 3 周**。3 周で収束しなければ「収束困難」として停止し OT に上げる。
- **pass 判定は exit code でなく保存 md の内容**(Critical/Important ゼロ)。exit code は走破 / timeout(124)/ detector FAIL(3)/ codex 異常の検出専用(別レイヤー)。
- **read-only 担保**: 書込/apply 系フラグ(`codex apply` / `--dangerously-bypass-*` / `--add-dir`)を渡さない。`worktree-snapshot.sh`(`.git/hooks` 含む内容ベース)の git clean detector が唯一のガード — **pass 宣言の前に評価**。

### Tag と hook

commit 末尾に `[reviewed]`(formal review 完了)or `[no-review]`(意図的 skip)。`.claude/hooks/check-review.sh`(Stop hook)が tag 無し feat/fix を block する。手動無効化禁止。

### Commit 直前の宣言(feat/fix)

chat に4点: ① review 経路(skill 名 / general-purpose / template 改変なし)② 結果(Critical N / Important N / Minor N)③ Important を残す場合は項目 + 理由 + OT 承認済み旨 ④ [reviewed] 付与宣言。宣言なし commit 禁止。

### 結果分類

Critical = 即 fix / Important = 原則 fix(MVP スコープ薄・コスト高は OT 判断)/ Minor = 記録のみ可。

### 重要 Fix の裏取り

**決済・認証・削除・外部副作用**に触れる fix は review pass だけで [reviewed] を付けない: review pass → commit(tag 無し)→ OT 実機確認 → 未 push amend で [reviewed] 追記。UI 微調整 / typo / ロジック不変 refactor は対象外。

**stg smoke を要する重要 Fix(データ保全・課金・削除)は push→smoke の順ゆえ、smoke 実施時点で [reviewed] amend 窓が構造的に閉じる。この場合は session doc を [reviewed] の正記録とし、commit message tag は追わない(push 済 commit の force-push はしない)。**

### docs の commit

確定した docs(spec / plan / session log / lessons)は**必ず即 commit**(`docs(_)` + `[no-review]`)。未 commit 放置禁止。

---

## Sprint 完了 gate(恒久規律)

lint gate はローカル3層: ① eslint.config.mjs(ルール正本)② lefthook pre-commit(staged のみ)③ sprint 完了 gate + review checklist(whole-repo)。GHA は不採用(PR なし運用、git 履歴 `6958d18` から復活可)。

**全 sprint 共通**: 完了時に whole-repo `pnpm lint`(--max-warnings=0)exit 0。報告 chat に「whole-repo lint exit 0 確認済」を1行明記。
**全 sprint 共通(Iso-1 制定・無条件恒久)**: 完了時に `pnpm test:iso`(実 PostgreSQL 2 テナント統合テスト・テナント隔離の behavioral 保証)green。**条件付き(schema 変更時のみ等)にしない** — テナント境界 regression は無関係に見える refactor からも起きるため、判断点を作らず全 sprint で無条件実行する。前提 = devcontainer 常駐 PG17 cluster(`.devcontainer/pg-setup.sh` / `postStartCommand`)。報告 chat に「test:iso green 確認済」を1行明記。review dispatch の観点 list にも含める。
**Sprint 完了 gate(audit gate)**: `pnpm run audit` = `scripts/audit-gate.mjs`。prod 依存は high 以上で無条件 fail(受容なし・optional 含む)。dev 依存は `scripts/audit-allowlist.json` と version-aware 照合(未受容 / 期限切れ / range 外 = fail)。fail-closed(exit code・JSON parse・構造検証のいずれか欠けたら fail)。受容の追加・変更は allowlist JSON + 台帳(`docs/audit/dependency-audit-ledger.md`)のセット記録が必須。`pnpm-workspace.yaml` の `auditConfig` は廃止済みで、存在すれば gate が無条件 fail する(allowlist 迂回の防止)。報告 chat に「pnpm run audit exit 0 確認済」を1行明記。閾値は **high**(builtin `pnpm audit` は level 未指定=low で走るため gate は必ず `pnpm run audit`)。
**依存 / Next / Node / lockfile を触る sprint は追加**: `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` 全 exit 0。
**Next 設定 file (matcher / proxy.ts / next.config.\*) を触る task は per-task gate に追加**: `pnpm build` 必須 (vitest / typecheck / lint は内部 js regex で動作するため Next.js matcher の path-to-regexp 制約 (capturing group / lookahead 禁止) を検出不能、 Vercel build で初めて表面化する。 Y-2 T-A4 で実際に発生、 commit 45a74cf → 6f82025 で hotfix)。**同種の「local build green でも production runtime でのみ表面化する」class は他にもある**(sharp `.so` dlopen 未 trace / `@hyzyla/pdfium` wasm の `new URL(..., import.meta.url)` 静的置換 → ENOENT。②-4b で実際に発生)— `pnpm build` 単体はこの class を検出できないため、`scripts/verify-pdfium-wasm-packaging.mjs`(`package.json` の `postbuild` で `pnpm build` に自動連結・fail-closed)のような build 後の実 packaging 検証 script を伴わせる。`serverExternalPackages` / `outputFileTracingIncludes` を触る変更は同種の検証を追加する前提で行う。
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

### plan 段階の Codex 協調(cross-check)

fact-finding → spec → plan ドラフト(CC)の後、**plan 確定の前**に Codex に独立論点を出させる: `scripts/ai/codex-plan-review.sh`。狙い = plan を CC 単独で固めて後で Codex に見せ抜けが出る二度手間を、確定時点に前倒しで潰す。

- **入力** = 調査結果 + 要件を主、CC の plan ドラフトは参考添付(承認させない)。指示は「調査結果と要件から独立に論点・抜け・リスクを挙げ、その上で添付 plan の抜けを照合せよ」(anchor 防止)。
- これは fix ループでなく **1 回の cross-check**。CC 本体が CC 自身の plan + Codex 論点を突き合わせ、取りまとめ(どちらが出したか / 重複・対立を明示)て OT に提示。**OT 承認で plan 確定**。

### Sprint 境界の停止

各 Sprint 完了で停止、OT 判断待ち。複数 Sprint の連続 auto mode 禁止。Sprint 内でも Critical 検出 / 仕様解釈揺れ / 外部サービス設定変更要で停止。

### 自走継続条件(plan 確定後)

plan が OT 承認で確定したら、**plan 完了まで一気通貫で自走**する(task ごとに OT 確認を取らない)。直上「Sprint 境界の停止」の『Sprint 内でも Critical 検出で停止』の**例外**を以下に定める(この例外がないと毎 Critical で止まり自走にならない):

- **claude.ai に即上げる条件** = canonical または Codex の **Critical(P0/P1)を、CC が修正・検証・rollback 計画しても未解決の時のみ**。解決すれば自走継続(修正試行前に上げない)。
- **Important(P2)以下は CC が吸収**(fix して自走継続)。Minor は記録のみ可(「結果分類」準拠)。
- 不変の停止理由(仕様解釈揺れ / 外部サービス設定変更要 / Sprint 完了)は従来どおり停止。

---

## 環境変数

新規 env を参照するコードと**同 commit で `.env.example` に追加**(値はプレースホルダ、実値は `.env.local` のみ、後から埋める項目は空値記法 `KEY=`)。取得タイミング非自明はコメント補足。deploy 前に全 env 記載を再確認。

## 簡潔性規律

恒久の横断規律。実装・レビュー(canonical / Codex)双方の判断基準。

- タスク要件を満たす**最小実装**を選ぶ。
- 「将来必要かも」で抽象化・汎用化・設定可能化しない(**YAGNI**)。
- **既存パターンに乗る**。同種処理が既にあれば新しい書き方を発明せず既存に倣う。
- 抽象化は**実重複が 3 回以上実在する時だけ**(rule of three)。予測重複や 2 回では共通化しない。
- **タスク範囲外のコードを触らない**。ついでのリファクタ・改善をしない(scope creep 禁止)。必要なら別タスク起票し OT 判断。
- レイヤー・ラッパー・間接層を足す前に、**それ無しで書けないか試す**。足すなら理由を 1 行で正当化できること。
- 過剰な防御的コードを書かない(起きえない分岐の握り / 不要 null guard / 使われない汎用引数)。

## 設計方針(DDD)

ビジネスロジックに触るコードは既存の**薄い DDD** 構成に従う(P0〜P4 + F1〜F3 で確立):

- ドメイン規則(不変条件・判定・状態遷移)は `lib/<context>/domain/` の **pure 関数**(I/O なし・test 厚く)。server の書込は repository / apply 層経由、orchestration は usecase / action / handler 層、外部 I/O は infra 層(`lib/storage/` 等)。
- **新しいビジネス規則を server action / component に直書きしない**。既存 aggregate(Subscription / Session / Card / Tag)がある領域はそこへ寄せる。
- client 側は repository を持たない(意図的): **aggregate の pure 関数で不変条件を計算 → 既存 `runOptimistic*` で書く**形を維持(local-first 優先)。
- client/server 二重実装をしない: 共有 invariant は **pure 関数 1 定義を両側から import**。
- 教科書 DDD の全部盛り(Repository/Entity 全面導入・event sourcing 化等)はしない。導入基準は「**不変条件が実在するから**」(簡潔性規律の YAGNI と両立)。
- 意図・経緯の正本 = `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md`(+ P0〜P4 / F1〜F3 design docs)。

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
