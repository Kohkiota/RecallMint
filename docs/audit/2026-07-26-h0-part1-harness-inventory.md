# H-0 ① ハーネス機構の全棚卸し(fact-finding・読み取り専用)

- **作成日**: 2026-07-26
- **位置づけ**: H トラック(ハーネス & アーキテクチャ文書化)H-0 の 3 分割 1 本目。最終目的 = `docs/harness.md`(AI が間違えない仕組みの索引)の材料出し。**本 doc は素材。harness.md は本タスクで作らない。**
- **scope**: 機構(仕組み)の列挙に徹する。②(設計不変条件)③(docs 整理)は別セッション。改善提案は書かない(H-1 以降)。
- **調査手法**: 既知の正本候補を先に読み、現物と食い違うものだけ矛盾として報告。deps は `pnpm list --depth 0` 実測から生成(記憶・推測で埋めない)。確定できないものは「未確認」で残す。
- **HEAD**: `b9280e7`(develop)。

---

## 1. サマリ表(harness.md の行候補)

強制レベル: **機械**(lint / hook / policy / script が人手を介さず自動で止める)/ **構成**(コンテナ・権限で構造的に不可能)/ **プロセス**(人の約束・人が実行して初めて効く)。
状態: **現行** / **形骸化の疑い** / **未確認**。
how(実装の書き写し)は書かない。why + where のみ。

| # | 防御 / 機構 | 何を防ぐ | 強制レベル | 正本(パス) | 状態 |
|---|---|---|---|---|---|
| A1 | `getDb` repo-wide ban | RLS を迂回する raw tenant 接続。`withTenantTx`/`getNonTenantDb` 強制 | 機械 | `eslint.config.mjs`(GETDB_BAN + 6 scope block) | 現行 |
| A2 | Domain purity(Subscription/Session/Card/Tag/Media)| pure domain が infra/framework/orchestration を runtime import | 機械 | `eslint.config.mjs`(Block A'〜A''''')| 現行 |
| A3 | Block A: lib/components → app 禁止 | 共有ロジックの app 層への逆流 | 機械 | `eslint.config.mjs`(LIB_NO_APP_IMPORTS)| 現行(allowlist 0)|
| A4 | Block B: deep relative / cross-feature `_components` | 3+ 階層相対 import・機能境界越え private import | 機械 | `eslint.config.mjs`(Block B)| 現行(cross-feature は可視化 allowlist=一時的負債)|
| A5 | Block C: `_lib` → `_components` 逆依存 | feature 内レイヤー逆流 | 機械 | `eslint.config.mjs`(Block C)| 現行(1 件 意図的 allowlist)|
| A6 | `no-unused-vars`(`^_` 例外)| 未使用 import/var | 機械 | `eslint.config.mjs` | 現行 |
| A7 | lefthook pre-commit lint(staged のみ)| commit 時点の lint 崩れ | 機械(commit 契機・自動)| `lefthook.yml` | 現行 |
| A8 | Stop hook: `[reviewed]`/`[no-review]` tag 強制 | feat/fix の未 review commit | 機械(形式のみ)| `.claude/hooks/check-review.sh` | 現行 |
| A9 | Stop hook: test-only 増減宣言強制(red 検証/保証減/保証不変)| test 変更の分類申告漏れ | 機械(形式のみ)| `.claude/hooks/check-review.sh` | 現行 |
| A10 | Stop hook: ツール呼び出しテキスト漏れ検出 | 既知 harness バグの未実行放置 | 機械 | `.claude/hooks/detect-leaked-toolcall.sh` | 現行 |
| B1 | Sprint 完了 gate: whole-repo `pnpm lint --max-warnings=0` | staged 外の lint 崩れ | プロセス(人が実行・報告)| `CLAUDE.md`「Sprint 完了 gate」 | 現行 |
| B2 | Sprint 完了 gate: `pnpm test:iso` green(無条件)| テナント境界 regression | プロセス(実行)/ 機械(判定)| `CLAUDE.md`「Iso-1」 | 現行 |
| B3 | audit gate `pnpm run audit`(prod/dev scope 別・fail-closed・tripwire)| high/critical 脆弱性・allowlist 迂回 | プロセス(実行)/ 機械(判定)| `scripts/audit-gate.mjs` | 現行 |
| B4 | 依存/Next 触る sprint: frozen install + typecheck + build | lockfile drift・matcher 制約の build 時表面化 | プロセス | `CLAUDE.md`「デプロイ前」「Next 設定」| 現行 |
| C1 | 権限 deny list(push / curl / wget / ssh / scp / publish / `--no-verify`)| 外部送信・publish・push・hook 迂回 | 構成(権限)| `.claude/settings.json` `permissions.deny` | 現行 |
| C2 | `git commit --no-verify`/`-n` の機械封鎖 | lefthook 迂回 | 構成(権限・端点アンカー)| `.claude/settings.json` + `CLAUDE.md`「全面禁止」| 現行 |
| C3 | コンテナ隔離(root+`IS_SANDBOX=1` を境界・5432 非 forward)| 権限境界の代替 | 構成 | `.devcontainer/devcontainer.json` / `.devcontainer/README.md` §1 | 現行 |
| D1 | MCP pin(playwright `0.0.78` / context7 `3.2.4`)| ツール挙動の暗黙 drift | プロセス(pin)| `.mcp.json`(正本)/ README §7.1 | 現行 |
| D2 | Codex CLI pin(`0.144.5`)+ 更新 contract gate | フラグ仕様の版変動 | プロセス(pin)/ 機械(gate)| `.devcontainer/post-create.sh` `CODEX_VERSION` | 現行 |
| D3 | TSLS `5.3.0` / global TS `6.0.3`(repo `^6.0.3` lockstep)| LSP 機能前提(TS7 不動作)| 構成(postcondition)| `post-create.sh` + `verify-lsp-diagnostics.mjs` | 現行 |
| E1 | canonical review(`requesting-code-review` + general-purpose subagent + template 改変禁止)| feat/fix の未検証 merge | プロセス | `CLAUDE.md`「必須経路」 | 現行 |
| E2 | Codex 独立レビュー(canonical 後・commit 前)| 単一レビュアーの観点漏れ | プロセス | `scripts/ai/codex-review.sh` + `CLAUDE.md`「Codex 協調」| 現行 |
| E3 | Codex read-only 担保(内容ベース git clean detector)| danger-full-access 下の working tree 書換 | 機械 | `scripts/ai/worktree-snapshot.sh` | 現行 |
| F1 | test:iso: 2 テナント behavioral 隔離(RLS 単独防御含む 8 カテゴリ)| user 間データ暴露 | プロセス(実行)/ 機械(判定)| `tests/integration/pg/` + `COVERAGE.md` | 現行 |
| F2 | RLS policy drift 検出(`rls-drift.test.ts`)| SQL と実 DB の policy ズレ | 機械(test:iso 内)| `tests/integration/pg/rls-drift.test.ts` | 現行 |
| F3 | grant narrowing pin(非 RLS 5 表)| 最小権限逸脱 | 機械(test:iso 内)| `tests/integration/pg/grant-narrowing.test.ts` + `db/roles/` | 現行 |
| F4 | Stripe Test Clock 検証ツール(downgrade/予約取消 回帰)| 課金時間依存 regression | プロセス(手動資産)| `scripts/stripe-test-clock-verify.ts` + `docs/ops/stripe-test-clock-verify-runbook.md` | 現行 |
| G1 | direct 依存 全 exact pin | patch drift・意図しない bump | プロセス(規約)/ 機械(exact→install 不 bump)| `package.json` / matrix v2 §1 | 現行 |
| G2 | overrides(transitive 固定・GHSA 対処)| 脆弱 transitive の再解決 | 構成(lockfile)| `pnpm-workspace.yaml` `overrides` | 現行(uuid のみ疑い→§5)|
| G3 | audit allowlist + expiry 無条件強制 | 期限切れ受容の居座り | 機械(audit-gate.mjs)| `scripts/audit-allowlist.json` | 現行 |
| G4 | ESLint 9 維持(10 不採用)| upstream 未対応 plugin の実行時クラッシュ | プロセス(watch)| matrix v2 §7 / 台帳「監視」 | 現行 |

---

## 2. 項目別の詳細(A〜G / why + where)

### A. lint / hooks

**eslint.config.mjs 全ルール(flat config・上から順)**。ルール本体は `next/core-web-vitals` + `next/typescript` preset を継承し、その上に自前 block を重ねる。自前で設定した rule は実質 2 種(`no-restricted-imports` を多数 scope で・`no-unused-vars` の `^_` 例外・`react-hooks/preserve-manual-memoization` off・1 file だけ `react-hooks/refs` off)。

- **`@typescript-eslint/no-unused-vars`**(error, `^_` 例外): test mock 等の意図的 unused 許容。preset は `_` を default で ignore しないため明示(header コメント根拠あり)。
- **`react-hooks/preserve-manual-memoization`**(off): React Compiler OFF 制約(deps-target-matrix v1.1)と紐づく一時 off。Compiler 採用 sprint で再有効化予定(コメント根拠あり)。
- **`react-hooks/refs`**(off・1 file のみ: `exams/[id]/_hooks/use-card-options.ts`): `optionsRef.current = options` の render-phase 同期更新を撤去する構造変更(behavior 変化)を避けるための据え置き。`Sync-fix-1` / P4 別 task で解消予定(長いコメント根拠あり)。
- **`no-restricted-imports`**(error・scope 別に多重定義): 下記が全て同 rule の scope 違い。flat config は **rule options を per-file で REPLACE(merge しない)**ため、後段 block は前段の pattern を明示的に再 include して連鎖させる設計(各 block header に注記)。
  - **getDb ban(A1)**: `getDb` named symbol を lib/db 内部と test/fixture 以外で import 禁止。RLS-P3 Task 4。`paths`(`@/lib/db` alias)+ `patterns`(subpath / 相対 bypass を **anchored regex** で・glob だと `@/lib/db/schema` に誤爆する既知の落とし穴回避、長い NOTE コメントあり)。scope = lib/components / app / tests / scripts / root `*.ts` の**全 executable scope を網羅**(RED sweep 30/30 の根拠 = メモリ `project_rls_p2_representative_closure`)。exempt = `lib/db/**`・`**/*.test.ts(x)`・`tests/integration/pg/setup/fixture.ts` の 1 site。
  - **Block A(A3)**: `lib/**`・`components/**` は `@/app/*` 等を import 禁止。allowlist は P4 W5 で 0 化。
  - **Domain purity(A2)**: `lib/{stripe,reviews,cards,tags,media}/domain/**` が infra(db/drizzle/logger)・framework(next)・zod・orchestration back-flow を **runtime** import 禁止。`import type` は allowTypeImports で常に許可。Media block のみ `@/lib/db/*` subpath も塞ぐ(他 4 block は既存 gap を共有・意図的に触っていない、header 注記)。
  - **Block B(A4)**: `app/**` の deep relative(`../../../**`)+ cross-feature private `_components` import。cross-feature は 3 file / 4 違反を per-file allowlist で「可視化(tracked)」= error にはしないが黙殺もしない(分類: 一時的負債 / 意図的設計)。
  - **Block C(A5)**: `app/**/_lib/**` の `../_components/**` 逆依存。`column-pinning.ts` 1 件のみ allowlist(columns-as-data SSoT・意図的)。
- **ignores**: `.next/** out/** build/** coverage/** public/vendor/**`(self-host vendor)`.devcontainer/**`(ops script・React/Next 前提 rule 不整合)。
- **route group escape 規律**: flat-config `files:` は minimatch 評価ゆえ `(app)` / `[id]` を `\\(...\\)` / `\\[...\\]` で escape する(escape 不在で silent に override 不発 → gate 立ち上げ時 fail した実績。ただし `no-restricted-imports` の `group` は import **source 文字列** matcher でここは escape 不要、という非対称も header で明記されている)。

**lefthook(A7)**: `pre-commit` が `pnpm exec eslint --max-warnings=0 --no-warn-ignored {staged_files}`(glob `*.{ts,tsx,js,mjs,cjs}` / `stage_fixed: false`)。**staged file のみ・実走 ~11 秒**。typecheck/vitest/build は走らせない(重いので Sprint 完了 gate + デプロイ前チェックへ委譲、header コメント根拠)。コンテナ内前提(`prepare` script の `lefthook install`)。

**Stop hooks(3 本・`.claude/settings.json` の `Stop` matcher で配線)**:
- `check-review.sh`(A8/A9): 直前 commit を検査。**(1)** test-only diff(全変更 file が `*.test.ts(x)` / `tests/**`・merge は除外)なら「保証の増減」宣言 token(`保証不変` / `red 検証`|`保証減`)+ tag の有無を検査し不在なら `decision: block`。**(2)** feat/fix なら `[reviewed]`/`[no-review]` tag 不在で block。tag ありは silent pass(旧版の毎 stop lint リマインドは context 浪費として撤去済、コメント根拠)。`stop_hook_active` guard で無限ループ回避。jq 非依存(python3 で JSON 構築)。**強制するのは宣言の形式のみ** — 分類の正直さと red 実走は宣言者責務(hook 自身が明記)。
- `detect-leaked-toolcall.sh`(A10): 最後の assistant text にツール呼び出しの text 漏れ痕跡(名前空間なし `<invoke>` 等)があれば 1 回だけ block して言い直させる。2 回目以降は `stop_hook_active` で素通り(self-poisoning 回避)。
- `discord-notify.py`: 最終応答を Discord へ分割送信(防御でなく通知)。background task 稼働中の中間 Stop は抑止。

**`--no-verify` 迂回禁止の文言化**: `CLAUDE.md`「`git commit --no-verify` / `-n` は全面禁止」+ `.claude/settings.json` の deny list(端点アンカー 6 パターン)+ README §3(「lefthook 迂回の機械的封鎖」)の 3 箇所。

### B. gate(Sprint 完了 gate)

正本 = `CLAUDE.md`「Sprint 完了 gate(恒久規律)」。**GHA/CI は不採用(PR なし運用)**ゆえ、下記はすべて**人 or CC が実行し報告 chat に 1 行明記する**プロセス gate(判定ロジック自体は決定的)。

- **whole-repo lint**(B1): `pnpm lint`(= `eslint . --max-warnings=0`)exit 0。報告に「whole-repo lint exit 0 確認済」。CC と reviewer の 2 経路で確認義務。
- **test:iso**(B2): `pnpm test:iso`(実 PG 2 テナント統合)green。**無条件・全 sprint**(schema 変更時のみ等の条件を付けない — 判断点を作らないため)。報告に「test:iso green 確認済」。前提 = devcontainer 常駐 PG17。
- **audit gate**(B3): `pnpm run audit` = `scripts/audit-gate.mjs`。
  - **prod**: `pnpm audit --prod --audit-level high --json` で high/critical 1 件でも fail。**allowlist 一切不適用・optional 依存含む**(公開面受容ゼロ)。
  - **dev**: `pnpm audit --dev` を `scripts/audit-allowlist.json` と **version-aware 照合**(`findings[].version` が `vulnerableRange` 内のものだけ受容)。未受容 / 期限切れ / range 外 = fail。照合キーは ghsa+module(path は照合しない)。
  - **fail-closed 3 点**(pass 判定前): ① exit code 健全性(0/1 のみ・内容整合)② `JSON.parse` 成否 ③ 期待構造(`advisories` + `metadata.vulnerabilities.high|critical` が数値)。
  - **tripwire**: 冒頭で `check-audit-config.mjs` を実行し `pnpm-workspace.yaml` に `auditConfig`(`ignoreGhsas`/`ignoreCves` いずれも)行があれば無条件 fail(pnpm が wrapper へ渡す前に advisory を沈黙 filter する迂回を封鎖)。
  - **expiry 強制**: allowlist 全 entry を advisory 検出有無に依らず無条件で期限判定(`today > expiry` で fail)+ 暦日実在検証(`2026-13-01` 等の shape 素通り防止)。
  - 閾値 = **high**(builtin `pnpm audit` は level 未指定=low で走るため gate は必ず `pnpm run audit`)。
- **依存/Next/Node/lockfile を触る sprint**(B4): `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` 全 exit 0。**Next 設定(matcher/proxy.ts/next.config.*)を触る task は `pnpm build` 必須**(vitest/typecheck は Next matcher の path-to-regexp 制約を検出不能・Vercel build で初表面化、Y-2 T-A4 実績)。

### C. コンテナ / 権限

- **権限モデル**(C1/C2): `.claude/settings.json` `permissions.defaultMode = "bypassPermissions"` + `deny` list。deny 実値 = `curl:* wget:* ssh:* scp:*`(外部送信)/ `npm|pnpm publish`(publish)/ `git config --global`(global config)/ `git push:*`(**OT 専権**)/ `git remote add|set-url|remove` / `gh repo delete|edit` / `gh release delete` / `git commit --no-verify|-n`(端点アンカー 6 変種)。`allow` は空(bypass ゆえ)。`settings.local.json`(gitignored)に個人 allow 2 件 + `enabledMcpjsonServers`(playwright/context7 承認)。
- **push を「中から手動」にしている実態**(C の核心): **設定(機械)+ 約束(プロセス)の二重**。設定 = `git push:*` を permission deny で CC から機械封鎖。約束 = `CLAUDE.md`「task 完了後の標準フロー」で「OK なら OT が push」と規律化。→ CC は構造的に push 不能。
- **bypassPermissions の適用範囲と境界**: bypass でも `deny` list の項目は止まる(それが唯一の境界)。deny 外の Bash/Write は無確認で通る。
- **コンテナ隔離**(C3): image `mcr.microsoft.com/playwright:v1.58.2`・root user・`IS_SANDBOX=1`・`NODE_OPTIONS=--max-old-space-size=4096`。5432(PG)は forward せずコンテナ内 localhost のみ(外部非公開の安全境界)。forwardPorts = 3000/5173/8000/4983。
- **mount / volume(rebuild で消える境界)**: named volume で **残る** = `/root/.claude`(global settings・plugin・session 履歴・memory)+ bash history + workspace(`settings.local.json` 含む)。**走り直す(消える扱い)** = `post-create.sh` 全体(CLI/plugin/PG は毎 rebuild 再セットアップ)。`.gitconfig` は host から readonly bind。→ 正本 README §3/§6。
- **network 制約の実態(重要な精密化)**: 観測できる egress 制約は**CC の permission deny(curl/wget/ssh/scp)層のみ**。devcontainer.json に `runArgs --network` 等のコンテナレベル firewall 定義は無い。`post-create.sh` は curl で外部から CLI を install する(= postCreateCommand は CC の permission 層を通らないため network 到達はある)。→ 「network 遮断」はコンテナ firewall ではなく **CC 権限層の egress CLI ban** と理解するのが正確。コンテナレベルの network policy 有無は**未確認**。

### D. コンテナ内 MCP / CLI / プラグイン(何を・なぜ・どう運用・どの pin)

正本 = `.mcp.json`(MCP)/ `.devcontainer/post-create.sh`(CLI/plugin install)/ README §7.1(pin 一覧)。実 install 定義と README pin は**一致**(矛盾なし)。

| 対象 | 何を / なぜ | どう運用 | pin(実値・出典) |
|---|---|---|---|
| playwright MCP | 唯一のブラウザ MCP。stg smoke 実走 | `.mcp.json`・`--browser chrome --no-sandbox --headless` | `@playwright/mcp@0.0.78`(`.mcp.json`)。内部に playwright `1.62.0-alpha` 同梱 |
| context7 MCP | ライブラリ docs 裏取り | `.mcp.json` | `@upstash/context7-mcp@3.2.4` |
| Codex CLI | 独立レビュアー(§E)。read-only 運用 | `post-create` install・手動 `codex login`・`scripts/ai/` から起動 | `0.144.5`(`CODEX_VERSION`。pin=postcondition 同一変数)。更新は contract gate 必須(README §7.3)|
| typescript-language-server | 編集直後の型診断/参照/定義 | `post-create` global install・`verify-lsp-diagnostics.mjs` で実診断受信を postcondition 化 | `5.3.0`(`TSLS_VERSION`)|
| global TypeScript | LSP の動作前提(TS7 native は `tsserver.js` 不在で不動作)| repo `^6.0.3` と lockstep bump | `6.0.3`(`TS_VERSION`)|
| Claude Code 本体 | harness | **敢えて非-pin = stable channel 自動追従**(exact pin/auto-update 停止しない方針)| pin なし(README §7.1「意図的に pin しないもの」)|
| Google Chrome | playwright MCP の CDP 駆動対象 | `post-create` apt stable | pin なし(apt stable) |
| superpowers plugin | process skill 一式 | `.claude/settings.json` `enabledPlugins`・project scope | marketplace float(6.1.1 稼働・README §7.1)|
| frontend-design plugin | UI 実装 skill | 同上 | marketplace float |
| typescript-lsp plugin | LSP 配線 | `post-create` install・user scope | marketplace float(v1.0.0)|
| PostgreSQL 17 | test:iso の乗り物 | `pg-setup.sh`(冪等・常駐 cluster・`recallmint_app` role provision)| major `17`(`PG_MAJOR`・Supabase prod 合わせ)|
| pnpm | package manager | corepack が field 追従 | `package.json` `packageManager: pnpm@10.33.0`(SSoT)|

**過去に撤去したもの(不採用の記録として残存)**:
- **chrome-devtools MCP**: 2026-07-18 撤去(全期間 成功 0 件)。再導入レシピ = `docs/superpowers/sessions/2026-07-18-c1-workflow-cleanup-execution.md` §5。README §5 / `post-create.sh` header に記録あり。
- **pr-review-toolkit plugin 配線**: 撤去済(`.claude/settings.json` の `enabledPlugins` から無効化)。理由 = 6 体中 `code-simplifier` が read-only レビュー枠と両立しない実装者、他 5 体も本体に書込抑止なし。→ `CLAUDE.md`「レビュアーは superpowers ネイティブ reviewer」に記録。多観点強化は Codex 独立レビューで代替。
- `enabledPlugins` 現状(`.claude/settings.json`)= `superpowers` + `frontend-design` の 2 件のみ(typescript-lsp は user scope で post-create install)。

### E. レビュー体制

正本 = `CLAUDE.md`「Review と Commit(最重要)」。

- **順序の絶対則**: review pass → commit([reviewed] 込み)の一方向のみ。commit してから review は禁止(tag 後付け amend が必要になった時点で順序違反)。
- **canonical(必須経路)**(E1): feat/fix は `superpowers:requesting-code-review` skill の**デフォルト経路**(汎用 general-purpose subagent + template `code-reviewer.md` の `## Read-Only Review` 文言・template 改変禁止)。自由形式 review 禁止。例外 = chore/docs/ロジック不変 refactor は skip(`[no-review]`)。test-only は「保証の増減」で分岐(§A9)。
- **Codex 協調**(E2/E3): canonical pass 後・`[reviewed]` commit 前に `scripts/ai/codex-review.sh <topic>`。
  - 対象 = HEAD への未 commit 変更一式(`codex exec review --uncommitted` が staged+unstaged+untracked をネイティブ収集)。**scope 境界 = feat/fix の非自明変更のみ**(chore/docs/ロジック不変 refactor は skip・test-only は増減分岐準拠)= `CLAUDE.md`「Codex 協調レビュー」に文言化。
  - Codex = 指摘のみ・修正主体は CC 本体。canonical の結論を Codex に見せない(anchor 防止 = 独立に diff を見させる)。
  - 重大度マッピング: Codex P0/P1 → Critical / P2 → Important / P3,P4 → Minor(canonical と同一語彙・同一収束条件)。集計は `count-findings.sh`(行頭 `- [Pn]` bullet に anchor)。
  - fix ループ = **未解決 Critical 0 かつ Important 0** まで反復・**安全弁 = 上限 3 周**。3 周で収束せねば「収束困難」で停止し OT へ。pass 判定は exit code でなく保存 md(`docs/codex/`)の内容。
  - **read-only 担保**(E3): 書込/apply フラグ(`codex apply` / `--dangerously-bypass-*` / `--add-dir`)を渡さない + `worktree-snapshot.sh` の**内容ベース** git clean detector(tracked HEAD 差分 + untracked 実内容 + `.git/hooks` を連結し前後 sha256 比較)が唯一のガード。porcelain 比較の盲点(既 dirty file の中身書換 / 既 untracked dir 内の新 file)を内容埋め込みで塞ぐ。**pass 宣言の前に評価**。exit code = 走破レイヤー専用(0 正常 / 3 detector FAIL / 124 timeout / 他 codex 異常)。
- **plan 段階 Codex cross-check**: `scripts/ai/codex-plan-review.sh`(diff でなく設計論点出し・`codex exec -` に stdin で plan 文脈・**1 回のみ / fix ループなし**)。入力 = 調査結果+要件(主)+ plan ドラフト(参考・承認させない=anchor 防止)。
- **commit 直前の宣言(feat/fix)**: ① review 経路 ② 結果(Critical/Important/Minor 件数)③ Important 残す場合の理由+OT 承認 ④ [reviewed] 付与宣言(`CLAUDE.md`「Commit 直前の宣言」)。
- **重要 fix(決済/認証/削除/外部副作用)の裏取り**: review pass だけで [reviewed] を付けず、OT 実機確認後に amend(未 push 時)or session doc を正記録(push 済で smoke を要する場合)。

### F. テスト規約

- **inline TDD / RED 実証(neuter 方式)の文言化場所**: `CLAUDE.md`「必須経路」の test-only 増減分岐 = **増(新規 pin/assertion 追加)は red 検証必須**(保証を壊す変異で fail する実証・commit message に「red 検証」記録行)。原理 = red は検出力(効いているか)/ review は主張の妥当性(言っていることが正しいか)で役割が違うため序列なし(2026-07-18 制定・背景 `docs/audit/2026-07-17-test-quality-audit.md`)。
- **eq-spy パターンの現在位置づけ**: **構造 pin のみ**(「owner 列で `eq` が呼ばれた」を pin するが「別 user の行が実際に除外される」は未観測)。behavioral な暴露防御は **test:iso が引き受ける**(COVERAGE §既存 test 現況: eq-spy suite とは REPLACE でなく COEXIST の上位互換)。
- **test:iso が「PG のユーザー間データ暴露」をどう担保するか(対外説明の中核・厚め)**:
  - **乗り物**: `tests/integration/pg/`(22 test file)。`vitest.integration-pg.config.ts` の globalSetup が毎 run **DROP/CREATE `recallmint_test` → 実 migration 適用 → base grants → phase3 REVOKE(順序固定)→ RLS enable SQL 3 本(p2 / wave1 / wave2)を owner で適用**(`setup/global-setup.ts`)。= test:iso は**毎 run 本番相当の RLS-on + 縮小 grant 状態で走る**(現物確認済)。接続契約 = `127.0.0.1:5432` / postgres / `recallmint_test`。刺激は app-role(`recallmint_app`・`asTenant`=`withTenantTx` で `app.user_id` GUC を張る)、観測/seed は owner(`getFixtureOwnerDb`・RLS bypass)。
  - **各カテゴリが何を証明するか**(file 名 → 主張):
    - **2 テナント behavioral 隔離**(`read-isolation` / `write-isolation` / `delta-isolation` / `delete-isolation`): user A/B を実データで seed し、B の read/write/delta/delete に **A の行が 1 行も混ざらない**を実行動観測(eq-spy の構造 pin の上位互換)。
    - **RLS 単独防御**(`rls-single-defense`): app 層の `eq(userId)` を**意図的に外して** policy 単独で隔離が成立することを示す = 「app WHERE を信頼しない最終境界」の最強証明。
    - **per-command**(`rls-per-command`): SELECT/INSERT/UPDATE/DELETE 各コマンドで policy(USING / WITH CHECK)が効くこと。
    - **ghost**(`rls-ghost`): claim はあるが users 行が無い/退会済 tenant の扱い。
    - **cascade**(`rls-cascade`): 親削除の cascade が owner-scope に収まる。
    - **null 契約**(`lifecycle-null-contract`): `getCurrentUser` の null/throw/User 契約 7 分類(claim+行→User / ghost→null / 未同期→null / no-session→throw)を実 PG RLS-on で pin。
    - **grant narrowing**(`grant-narrowing`・F3): 非 RLS 5 表で REVOKE した全コマンドが app-role で 42501、残したコマンドが実 query 形で動く(positive control)を完全 matrix で pin(RED 検証あり)。
    - **partial-RLS mixed**(`rls-partial-mixed` / `rls-partial-chain`): global-off 表 × tenant-on 表が 1 tx 同居しても on 隔離・off 非スコープ・違反時 tx 原子的 rollback(主張範囲は「global-off × tenant-on の tx 互換性」に限定と明記)。
    - **drift 検出**(`rls-drift`・F2): `pg_policies` の (roles, cmd, permissive, **qual, with_check**) 全 tuple + relrowsecurity/relforcerowsecurity を **hardcode した独立 oracle**(SQL と同一 SSoT を読まない)と完全一致照合。`USING (true)` 化のような load-bearing predicate 改変を green にしない(RED 3 種で実証)。
    - **関数 drift**(`rls-functions`): `app_current_user_id()` 本体を behavioral 担保。
  - **範囲の限界(対外説明で必須の但し書き)**: test:iso は「repo の enable SQL ↔ test DB」の整合しか見ない。**stg/prod で operator が手動適用後に直接 policy をいじる「手動適用 drift」は検出不能** → `docs/ops/rls-p2-stg-runbook.md` §12 の operator 用 read-only 監査 SQL が補完。caller 配線(route/action が実際に `withTenantTx` で包むか)は iso が Next auth/cache/R2 境界を叩かないため pin せず、canonical review + 機械 re-grep + build/typecheck が担う(COVERAGE「保証層の分離」)。
- **fake-indexeddb / jsdom の位置づけ**: unit(Vitest)の client 側 mirror テスト用(`vitest.setup.ts`)。**証明できる** = client(Dexie/IndexedDB)ロジック・component 描画。**証明できない** = 実 PG のテナント境界(→ test:iso)/ Next auth・cache・R2 の実境界。COVERAGE が「webhook/contract/Dexie tier は test:iso と COEXIST(REPLACE でない)」と位置づけ。
- **Test Clock 検証ツール**(F4): `scripts/stripe-test-clock-verify.ts`(setup/observe/advance/cleanup)。downgrade/予約取消の時間依存 regression を検証する**回帰資産**。責務境界 = CC は setup/observe/advance/cleanup、人力は app UI の upgrade→downgrade/取消。前提 = `STRIPE_TEST_CLOCK_SECRET_KEY` + 固定 user.id(RLS で CC 探索不可)。runbook = `docs/ops/stripe-test-clock-verify-runbook.md`。
- **テスト数・構成(実測・実行せず静的列挙)**:
  - whole-repo test file = **264**(`git ls-files '*.test.ts' '*.test.tsx'`)。it/test 呼び出し(静的 grep 上限)= 約 **4005**。※ 実行時 case 数(`.each` 展開等)とは一致しない。台帳スナップショットの実行数は unit ~3892 / iso 217(2026-07-25 時点・doc 由来)。
  - test:iso = `tests/integration/pg/*.test.ts` **22 file** / describe **70** / it・test **178**(静的)。
  - 区分 = `tests/{contract, fixtures, integration, lint}` + root/lib/app/components の co-located `*.test.ts(x)`。`tests/lint/import-boundary.test.ts` は eslint import 境界の test。`tests/contract/` は webhook(clerk/stripe)/ pull / bulk 等の契約 test。

### G. pin 規則 / deps 実態(`pnpm list --depth 0` 実測から生成)

- **pin 規則の正本 = matrix v2**(`docs/superpowers/sessions/2026-07-25-deps-target-versions-matrix-v2.md`。v1.3 は superseded)。
  1. direct 依存は**全 exact**(caret 不使用)。判定基準 = 「バージョン・挙動が動く=触る / 宣言形式のみ(caret→exact・版不変)=触らない」。
  2. 版更新は明示 sprint のみ(exact ゆえ `pnpm install` で動かない)。
  3. transitive は lockfile + overrides で管理。
- **CLAUDE.md 側との整合**: CLAUDE.md は「packageManager field が SSoT」「新ライブラリ導入は事前相談」「最新 patch は registry 直叩きが正」を述べるのみで pin 方針の細目は matrix v2 に委譲。**矛盾なし**。
- **deps 実態(実測で確定)**: `pnpm list --prod/--dev --depth 0` の出力が `package.json` と**完全一致**(prod 35 / dev 20・すべて exact・range ゼロ)。→ 実態は **「exact pin + 意図的据え置き」**(「常に最新」ではない)。matrix v2 §4 の確定版一覧とも一致。据え置きの明示例 = `@google/genai` 1.x 維持(2.x は OCR sprint 同梱)/ `shadcn` 4.6.0 bump 保留(重 transitive 回避)/ remark 系 4 点は unified 11 line 相互ピンで単独 major 昇格不可 / `@tanstack/react-table` v9 alpha 不採用。
- **overrides の現状(実値・`pnpm-workspace.yaml`)と理由**:
  - `postcss ^8.5.12` — GHSA-6g55(sourceMappingURL 任意ファイル読取)floor 引き上げ。実解決 = 8.5.21 / 8.5.23(both ≥ floor)。撤去条件 = 全消費側が >=8.5.12 を自然解決。
  - `vite 8.0.16` — GHSA-fx2h。pnpm update が peer-suffix transitive を更新しないため exact 固定。実解決 = 8.0.16。撤去条件 = vitest/plugin-react bump 時に override なしで >=8.0.16 解決を確認。
  - `sharp ^0.35.0` — GHSA-f88m(libvips 継承)。next の optionalDependencies.sharp が ^0.34.5 のままゆえ override で patched 化。実解決 = 0.35.3。撤去条件 = next の optional.sharp が >=0.35.0 に上がった時点。
  - `react 19.2.7` / `react-dom 19.2.7` — 核固定(lockstep)。
  - `uuid ^14.0.0` — **理由コメントなし・台帳エントリなし・`pnpm why uuid` 空(ツリー到達なし)** → §5 に矛盾/形骸化として計上。
- **意図的に上げていないもの + 解除条件の記録場所**:
  - **ESLint 9 維持(10 不採用)**(G4): `eslint-config-next@16.2.11` 同梱 3 plugin(react/import/jsx-a11y)の peer が `^10` 未対応 + `eslint-plugin-react@7.37.5` が ESLint 10 で `context.getFilename()` 削除により**実行時クラッシュ**(`jsx-eslint/eslint-plugin-react#3977` = OPEN)。**解除条件 3 つ全部** = ① 同梱 3 plugin の ESLint 10 peer 対応 ② plugin-react #3977 修正 ③ override なしで eslint@10 install 成立。記録 = matrix v2 §7 + 台帳「監視(watch)」。
  - **@google/genai 1.x / shadcn 4.6.0 / photoswipe 5.4.4 / @tanstack/react-table 8**: matrix v2 §4/§5 に据え置き理由記録。
  - **pnpm 11 audit endpoint 移行 watch**: 台帳「監視」に記録(wrapper の期待構造依存の再確認契機)。
- **audit 受容(allowlist)実態**: `scripts/audit-allowlist.json` に **1 entry のみ** = `GHSA-mh99-v99m-4gvg` / brace-expansion / `vulnerableRange <2.0.0`(受容している現物の系列=v1 系・patched 不在)/ `expiry 2026-08-22` / dev 経路。`vulnerableRange` は affected 転記でなく「受容系列」を書く(OT 裁定・Codex r4 P1 対応)。台帳「受容済」に理由・再検討条件・移行経緯を記録。

---

## 3. 機械強制済み一覧(= H-2 Skills 化で「skill に書かないもの」判定入力)

lint / gate script / policy / hook / permission で**人手を介さず自動的に止まる**もの。skill に重複記載すると lint と skill の両方が腐るため網羅を優先。

1. **getDb ban**(eslint `no-restricted-imports`・全 executable scope)
2. **Domain purity 5 blocks**(Subscription/Session/Card/Tag/Media・runtime import 制限)
3. **Block A**(lib/components → app 禁止)
4. **Block B**(deep relative / cross-feature private `_components`)
5. **Block C**(`_lib` → `_components` 逆依存)
6. **no-unused-vars**(`^_` 例外)
7. **lefthook pre-commit lint**(staged・commit 契機で自動)
8. **`[reviewed]`/`[no-review]` tag 強制**(check-review.sh・feat/fix 未 tag を block)
9. **test-only 増減宣言の形式検査**(check-review.sh・token 不在を block ※形式のみ)
10. **ツール呼び出しテキスト漏れ検出**(detect-leaked-toolcall.sh)
11. **permission deny list**(push / curl / wget / ssh / scp / publish / git config --global / git remote / gh repo・release / `--no-verify`・`-n`)
12. **audit gate の判定ロジック**(prod 無条件 fail / dev version-aware / fail-closed 3 点 / tripwire auditConfig 全拒否 / expiry 無条件強制)※**起動はプロセス**(§4-2 参照)
13. **audit allowlist の expiry 機械強制 + 暦日実在検証**
14. **exact pin による install 非 bump**(caret 不在 → `pnpm install` が版を動かさない)
15. **overrides による transitive 固定**(lockfile 解決の機械的固定)
16. **RLS policy(test:iso 内)**: 2 テナント隔離・単独防御・per-command・drift・grant narrowing・partial-mixed(判定は機械・**起動はプロセス**)
17. **Codex read-only の git clean detector**(worktree-snapshot.sh・内容ベース sha256)
18. **LSP 機能 postcondition**(verify-lsp-diagnostics.mjs・post-create で binary 実診断を強制)
19. **post-create.sh の各 step postcondition**(pin 不一致 / 未 install で build を落とす)

> 注: 12・16 は**判定ロジックは機械(決定的・fail-closed)だが起動が人手**(CI なし)。skill 観点では「ルール本体は書かず『sprint 完了時に必ず実行し報告』という起動規律だけ skill/CLAUDE.md に残す」対象。純粋に自動で止まる 1〜11・13〜15・17〜19 とは層が違う。

---

## 4. プロセス依存一覧(人の約束でしか守られない = ずれうる場所)

各項目に「機械化できるか」の所見を一言。

1. **whole-repo lint / test / test:iso の実行と報告**(CI なし)— 機械化可(GHA 復活で。ただし PR なし運用ゆえ pre-push hook 化が現実的。現状は意図的に人手)。
2. **audit gate の起動**(`pnpm run audit` を誰かが叩く)— 上に同じ。判定は既に機械・**起動だけ**が人手。
3. **canonical review の経路遵守**(skill 起動・template 改変なし・general-purpose subagent)— 経路の起動自体は機械化困難(subagent dispatch は controller 判断)。tag 不在だけは check-review.sh が機械捕捉(事後)。
4. **Codex 独立レビューの実施**(canonical 後・commit 前)— 実施タイミングは人手。read-only 担保だけ機械(detector)。
5. **Codex fix ループの収束条件**(未解決 Critical 0 / Important 0・上限 3 周)— 収束判定は保存 md を CC が読む=人手判断。
6. **test-only 増減の分類の正直さ + red の実走**(hook は形式のみ強制)— 原理的に機械化不可(宣言者責務・虚偽は cover up)。
7. **重要 fix(決済/認証/削除/外部副作用)の裏取り順序**(review→commit tag 無し→OT 実機→amend or session doc 正記録)— OT 実機依存ゆえ機械化不可。
8. **着手前宣言 / commit 直前宣言 / 完了報告の 1 行明記**(lint exit 0 / test:iso green / audit exit 0)— 機械化困難(自己申告)。
9. **pin 更新の明示 sprint 化 + registry 直叩き裏取り**— exact pin が「意図しない bump」は機械封鎖するが、「上げるべき時に上げる」判断は人手。
10. **overrides / allowlist 追加時の台帳セット記録**— 機械化困難(JSON entry の shape は audit-gate.mjs が fail-closed 検証するが、台帳への理由記載は人手)。
11. **MCP / Codex pin 更新手順**(registry 確認 → contract gate → rebuild → commit)— contract gate だけ機械、手順遵守は人手。
12. **subagent dispatch を foreground で行う(background 禁止)**— 現状 CLAUDE.md 規律のみ(機械強制は未整備・未確認)。
13. **spec の凍結・Sprint 境界の停止・skill skip 判断(A/B/C)**— プロセス専権(OT 判断)。

---

## 5. 矛盾・不明・要 OT 判断

### 5-1. docs 間 / 設定間の矛盾

- **`uuid: ^14.0.0` override が理由不明・形骸化の疑い**(要 OT 判断):
  - `pnpm-workspace.yaml` の他 override(postcss/vite/sharp/react)は全て理由コメント付きだが **uuid だけコメントなし**。
  - `dependency-audit-ledger.md` を全読したが **uuid の受容/override 理由エントリが存在しない**(postcss/vite/sharp は「解消済」に理由あり)。matrix v2 §8 は「各撤去条件は台帳参照」と書くが台帳に uuid 項が無い = **参照先不在**。
  - `pnpm why uuid` が**空(ツリー到達なし・exit 0)**。lockfile も overrides 宣言行(L8)以外に uuid path なし。→ 現在のツリーに uuid 依存が存在せず、override は effect ゼロの可能性が高い(`node_modules/.pnpm/uuid@14.0.0` は残存するが dependents なし)。
  - **所見**: 理由未記録 + 到達不能 = **形骸化の疑い**。撤去可否は OT 判断(過去に何を守るための override だったかの履歴確認が要る)。本タスクでは撤去しない(読み取り専用)。
- **matrix v2 doc の「CLAUDE.md は stale」注記が、それ自体 stale**:
  - matrix v2 §2 補足 と「OT follow-up #2」が「CLAUDE.md audit gate 段落は wrapper 化前の旧構造のまま stale・更新は OT follow-up」と記す。
  - しかし git log 上 **`3620884` docs: CLAUDE.md audit gate 段落を wrapper 構造へ更新** が既に入っており、現行 CLAUDE.md は wrapper 構造(prod/dev scope・fail-closed・auditConfig 廃止)を正しく記述。
  - → **CLAUDE.md 側に現時点の矛盾は無い**。矛盾は「matrix v2 doc の stale 注記が更新後に取り残されている」= docs-vs-docs の履歴齟齬。matrix v2 doc の当該注記/follow-up #2 は解消済としてクローズ相当(要 OT 確認・本タスクでは触らない)。

### 5-2. 理由が記録されていないルール

- 上記 **uuid override**(唯一の明確な理由未記録項目)。
- eslint preset 継承分(`next/core-web-vitals` + `next/typescript` の中身)は個別ルールの「なぜ」を repo 側に持たない(Next 公式 preset の既定)。自前 block は全て header コメントに根拠あり(理由未記録なし)。

### 5-3. 形骸化の疑い

- **uuid override**(§5-1)。
- **その他は現行と判断**。lefthook / hooks / eslint block / audit-gate / test:iso はいずれも直近 commit(〜7-25)で touch され、参照 doc と実体が一致。形骸化と断定できるものは uuid 以外に検出せず。

### 5-4. 未確認(埋めずに残す)

- **コンテナレベルの network policy 有無**: devcontainer.json に firewall 定義は無いが、host/ランタイム側の network 制約(iptables 等)の有無は本タスクの読み取り範囲外 → **未確認**。observed は「CC permission 層の egress CLI ban のみ」。
- **subagent background 禁止の機械強制**: CLAUDE.md 規律は明文だが、background dispatch を機械 block する hook/設定は発見できず → 機械強制は**未確認(おそらく無し=プロセスのみ)**。
- **`node_modules/.pnpm/uuid@14.0.0` の残存経緯**: dependents 無しで store に materialize されている理由は未特定(過去 install 残骸の疑い)→ **未確認**。
- **実行時テスト数**: 実行しない方針ゆえ静的 grep 値(file 264 / it 約 4005 / iso 22 file・178 it)を報告。実行数(unit ~3892 / iso 217)は台帳 doc 由来の転記で、本タスクでは**再実行検証していない**。

---

## 6. 実測エビデンス(根拠にした読み取りの要点)

現物 Read / 実測コマンドで裏取りした(記憶・既存 docs の無検証転記はしていない)。deps は実測出力ベース。

| 対象 | 手段 | 要点 |
|---|---|---|
| eslint 全 block | `Read eslint.config.mjs`(727 行全読)| getDb ban + 5 domain block + Block A/B/C + allowlist・ignores を現物確認 |
| lefthook | `Read lefthook.yml` | pre-commit staged lint のみ(11 秒)を確認 |
| Stop hooks 3 本 | `Read .claude/hooks/*` | check-review の test-only 分岐 / feat-fix tag block / leaked-toolcall / discord を現物確認 |
| 権限 | `Read .claude/settings.json` / `settings.local.json` | bypassPermissions + deny 実値・enabledPlugins 2 件を確認 |
| audit gate | `Read scripts/audit-gate.mjs` / `audit-allowlist.json` | prod/dev scope・fail-closed 3 点・tripwire・version-aware・expiry・entry 1 件を現物確認 |
| container | `Read .devcontainer/{devcontainer.json,README.md,post-create.sh,pg-setup.sh}` | mount/volume・postcondition・pin 一覧・PG17 provision を確認 |
| MCP/CLI | `Read .mcp.json` + README §7.1 照合 | playwright 0.0.78 / context7 3.2.4 / codex 0.144.5 / TSLS 5.3.0 / TS 6.0.3 一致(矛盾なし) |
| Codex 経路 | `Read scripts/ai/{codex-review,codex-plan-review,worktree-snapshot,count-findings}.sh` | detector 内容ベース・exit code 層・P 集計 anchor を確認 |
| test:iso | `Read tests/integration/pg/{COVERAGE.md,setup/global-setup.ts,setup/as-tenant.ts,setup/rls-assert.ts}` | 毎 run RLS-on + phase3 REVOKE 適用・app-role 刺激/owner 観測・8 カテゴリを確認 |
| deps 実態 | `pnpm list --prod/--dev --depth 0` | prod 35 / dev 20・**全 exact・range ゼロ**(package.json と完全一致)= exact pin 実証 |
| override 解決 | `pnpm why {uuid,postcss,vite,sharp}` + `node -p` | postcss 8.5.21/23 / vite 8.0.16 / sharp 0.35.3(override 満足)。**uuid = pnpm why 空(到達なし)** |
| test 数 | `git ls-files '*.test.ts(x)'` / `grep -cE 'it\|test\|describe'` | file 264・it 約 4005・iso 22 file/70 describe/178 it(静的) |
| deps 正本 | `Read matrix v2 doc` + `dependency-audit-ledger.md` 全読 | pin 規則 3 条・ESLint 9 維持根拠・overrides 理由(uuid のみ不在)を確認 |

---

## 申し送り(②「設計不変条件」で扱うべき論点)

本タスク(機構の列挙)では扱わず、H-0 ②(設計不変条件の全列挙)へ回すべきと気づいた点:

1. **薄い DDD の層責務**(domain=pure / repository / usecase / infra)は eslint domain-purity block で「壊れないよう機械強制」されているが、**なぜその層分けか**は不変条件側の論点(正本 = `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md`)。lint は境界を守るだけで意図は語らない。
2. **RLS を「app WHERE を信頼しない最終境界」とする trust-boundary 設計**(client 供給は row ID のみ・userId は常に auth 由来 / OCR 2 write の provenance 依存 / webhook は署名を別 trust anchor とする)= COVERAGE「trust-boundary 上の注意」。これは test で担保される**不変条件**であって機構ではない。
3. **local-first(Dexie mirror + outbox)の client は repository を持たない**意図(aggregate pure 関数 + `runOptimistic*`)= CLAUDE.md「設計方針(DDD)」。client/server の invariant 二重実装禁止(pure 関数 1 定義を両側 import)も不変条件。
4. **非 RLS 5 表を command GRANT だけで守る**判断(行隔離を与えない受容・contact_messages の SELECT 保持が GDPR DELETE の PG 規則由来)= 「防御の非対称性」の設計判断。COVERAGE 表 5 + hardening 節。
5. **Stripe apiVersion を明示 pin しない**判断(SDK exact pin ゆえ送信版が決定的・二重管理回避)= matrix v2 §6。設計判断であって機構ではない。
6. **exact pin + 意図的据え置き**の哲学(「動く=触る / 宣言形式のみ=触らない」)自体は pin **規則**(機構)だが、個々の据え置き(remark 系相互ピン / genai 1.x / shadcn 保留)は**設計判断の集合**として②で棚卸す価値がある。
