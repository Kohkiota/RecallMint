# 開発コンテナ構成(RecallMint)

このリポジトリの開発は全てこの Dev Container 内で行う。構成の正本はこのディレクトリの 2 file:

| file | 役割 |
|---|---|
| `devcontainer.json` | コンテナ定義(image / mount / env / port / VS Code 拡張) |
| `post-create.sh` | 初回作成時のセットアップ(CLI 導入 + plugin 登録)。**各 step は postcondition 検証付き** — 「実行した」でなく「効いている」を確認し、不成立なら non-zero で build が落ちる |

---

## 1. ベース環境

- **image**: `mcr.microsoft.com/playwright:v1.58.2`(Ubuntu + Node 24 + Playwright 依存一式)
- **user**: root(`IS_SANDBOX=1`。コンテナ隔離を境界とする設計)
- **pnpm**: corepack 経由で `package.json` の `packageManager` field に完全追従(version のハードコード無し)
- **port**: 3000(Next.js)/ 5173(Vite)/ 8000(汎用)/ 4983(Drizzle Studio)

## 2. post-create.sh が入れるもの(8 step)

1. npm global prefix(EACCES 対策)
2. pnpm(corepack install = packageManager field 準拠)
3. **Claude Code**(native installer / stable channel)
4. Stripe CLI(webhook のローカル転送用)
5. TypeScript Language Server + **Codex CLI**(exact pin。独立レビュアー用 → §5)
6. Google Chrome(Playwright MCP が `--browser chrome` で使用)
7. Claude plugin 登録(marketplace: claude-plugins-official / plugin: typescript-lsp)
8. **PostgreSQL 17**(`pg-setup.sh` を呼ぶ。実 PG 2 テナント統合テスト `pnpm test:iso` の乗り物 → §7.1)

> step 8 の実体は独立 script `.devcontainer/pg-setup.sh`(冪等・postcondition 内蔵)。**手動適用と script が乖離しないよう**、開発中の PG セットアップも必ずこの script を実行する(rebuild checklist の担保対象)。cluster は `postStartCommand`(devcontainer.json)が restart 毎に idempotent start する。5432 は forward しない(コンテナ内 localhost のみ・外部公開しない安全境界)。

## 3. Claude Code の設定レイヤー(何がどこで決まるか)

| 層 | file | 永続性 | 決めていること |
|---|---|---|---|
| global | `/root/.claude/settings.json` | **named volume**(rebuild しても残る) | model 既定・effort・user scope plugin(typescript-lsp) |
| project | `.claude/settings.json` | **git tracked** | permission(bypassPermissions + deny list)・**Stop hook 3 本の配線**・project plugin(superpowers / frontend-design) |
| local | `.claude/settings.local.json` | gitignored(workspace に残るが clone には無い) | .mcp.json server の承認(enabledMcpjsonServers)・個人 allow |

- model の project pin は**置かない**(global に委譲)。
- deny list: 外部送信系(curl / wget / ssh)・publish・`git push`(OT 専権)・`git commit --no-verify` / `-n` 系(lefthook 迂回の機械的封鎖。端点アンカー型のみ — 中間ワイルドカードは commit message 文字列に誤爆する実績あり)。

## 4. Stop hooks(`.claude/hooks/`・3 本とも tracked)

| hook | 役割 |
|---|---|
| `check-review.sh` | feat/fix commit の `[reviewed]` / `[no-review]` tag 無しを block。test-only commit の「保証の増減」宣言(red 検証 / 保証減 / 保証不変)も形式検査 |
| `detect-leaked-toolcall.sh` | ツール呼び出しがパースされず本文にテキスト漏れした場合(既知 harness バグ)を検出し 1 回だけ言い直させる |
| `discord-notify.py` | 最終応答を Discord へ分割送信(background task 稼働中の中間 Stop は抑止)。debug 記録は `CLAUDE_HOOK_DEBUG=1` opt-in |

## 5. MCP / Plugin / AI レビュー体制

- **MCP**(正本 = リポジトリ直下 `.mcp.json`): `playwright`(**唯一のブラウザ MCP**。stg smoke はこれで実走)/ `context7`(ライブラリ docs 裏取り)。
  - chrome-devtools MCP は 2026-07-18 に撤去(全期間で成功 0 件)。再導入レシピ: `docs/superpowers/sessions/2026-07-18-c1-workflow-cleanup-execution.md` §5
- **Plugin**: superpowers(process skill 一式: brainstorming / writing-plans / code-review 等)/ frontend-design / typescript-lsp
- **Codex CLI**: 独立レビュアー(`scripts/ai/codex-review.sh` / `codex-plan-review.sh`)。read-only 運用を git clean detector(`worktree-snapshot.sh`)で担保。認証は手動 `codex login`

## 6. 永続化と rebuild

- **rebuild で残る**: `/root/.claude`(named volume: global settings・plugin・session 履歴・memory)/ bash history / workspace(settings.local.json 含む)
- **rebuild で走る**: post-create.sh(全 postcondition 通過 = exit 0 が正常。落ちたら step 名が出る)
- rebuild 後の確認 checklist: `docs/superpowers/sessions/2026-07-18-c1-workflow-cleanup-execution.md` §9
- **PG(Iso-1)追加 checklist**: rebuild 後に ① `pg_lsclusters` で `17 main ... online` ② `PGPASSWORD=postgres psql -h 127.0.0.1 -p 5432 -U postgres -d recallmint_test -c 'SELECT 1'` 成功 ③ `pnpm test:iso` green を確認(postStartCommand の restart 永続はこの手順で担保)。手動適用と `pg-setup.sh` の乖離が無いこと(step 8 が同 script を呼ぶ)も確認。

## 7. バージョン pin 一覧と更新手順(2026-07-18 C2 制定)

### 7.1 pin 一覧(何がどこで固定されているか)

| 対象 | 固定場所 | 現在の pin | 備考 |
|---|---|---|---|
| container image | `devcontainer.json` `image` | `mcr.microsoft.com/playwright:v1.58.2` | bump は別イベント(→ §7.5) |
| playwright MCP | `.mcp.json` | `@playwright/mcp@0.0.78` | 内部に playwright `1.62.0-alpha-1783623505000` を exact 同梱(→ §7.6) |
| context7 MCP | `.mcp.json` | `@upstash/context7-mcp@3.2.4` | |
| Codex CLI | `post-create.sh` `CODEX_VERSION` | `0.144.5` | pin と postcondition 期待値は同一変数(二重管理なし)。更新は contract gate 必須(→ §7.3) |
| pnpm | `package.json` `packageManager` field | (field が SSoT) | corepack が field に追従。ここに版番号を書かない(二重管理防止) |
| PostgreSQL | `.devcontainer/pg-setup.sh` `PG_MAJOR` + PGDG repo | major `17`(Supabase prod=17 に合わせる。patch は PGDG 追随) | `pnpm test:iso` 専用の常駐 cluster。接続契約 = `127.0.0.1:5432` / user `postgres` / db `recallmint_test`。app 本体の `DATABASE_URL`(Supabase)とは無関係 |

**意図的に pin しないもの**(「全部 exact pin」からの非対称。後から"統一"しないこと):

- **Claude Code 本体 = stable channel**。「最新安定版に追随する」の実装が channel そのもので、auto-update を殺して exact pin する運用コストに見合う事故実績が無い。担保は ① rebuild 時の実版記録(post-create の `--version` postcondition 出力)② regression 時の特定版固定手順(→ §7.4)。
- **Google Chrome = apt stable**(rebuild 時点の最新 stable が入る)。playwright MCP が CDP で駆動する対象で、playwright 側が branded Chrome stable を公式サポートするため版結合は緩い。実版は rebuild 時の post-create summary で記録される。

### 7.2 更新手順(共通形)

1. 最新**安定**版を registry で確認(`npm view <pkg> dist-tags --json`。alpha / beta / RC / canary は除外。Context7 は patch に遅れるため registry 直叩きが正)
2. pin 行を書き換える(`.mcp.json` or `post-create.sh` の `CODEX_VERSION`)
3. Codex のみ: contract gate(→ §7.3)を**書き換え確定の前に**通す
4. rebuild → post-create の postcondition 全通過(exit 0)を確認
5. commit(`chore(devcontainer)`)。MCP は rebuild 不要で反映される(npx が起動毎に解決)が、記録の一貫性のため手順は共通形とする

### 7.3 Codex pin 更新の contract gate

scripts/ai の invocation(`codex exec review --uncommitted` / `codex exec -`)を**変えずに**、旧 pin vs 新候補を同一入力の fixture で比較(rebuild 不要 = `npx -y @openai/codex@<ver>` の exact 指定で実行):

- a. 既知欠陥を植えた diff → その欠陥が finding として出る
- b. clean diff → Critical / Important 0
- c. 実行前後で worktree 内容不変(`worktree-snapshot.sh` detector 再利用)
- d. `count-findings.sh` の `- [Pn]` 集計・保存 md 判定が新版出力で壊れない
- e. ツール失敗(timeout / auth 失敗)と「finding 無し」が出力上区別できる(auth 失敗 = 非 0 exit + `-o` file 未生成 / timeout = exit 124 / finding 無し = exit 0 + md 保存)

いずれかで旧版より劣化 → pin 更新見送り・差分を報告して停止(判断は OT)。

### 7.4 戻し方

- **MCP / Codex**: pin 行を前版へ revert するだけ(`git log -p .mcp.json` / `post-create.sh` で前値確認)。MCP は次回 server 起動から、Codex は rebuild(または `npm install -g @openai/codex@<ver>` 手動実行)で反映。
- **Claude Code 本体のみ**(regression 時の特定版固定・公式 [setup docs](https://code.claude.com/docs/en/setup) 裏取り済 2026-07-18):
  1. 特定版を install: `curl -fsSL https://claude.ai/install.sh | bash -s <版番号>`(`stable` / `latest` と同じ位置に版番号を渡す)
  2. auto-update を無効化: settings.json の `env` に `"DISABLE_AUTOUPDATER": "1"`(背景更新チェックのみ停止。`claude update` 手動実行は残る。全更新路 block は `DISABLE_UPDATES`)
  3. stable channel 復帰 = env を外して `curl -fsSL https://claude.ai/install.sh | bash -s stable` を再実行

### 7.5 image 更新手順(別イベント。pin 統一と混ぜない)

`mcr.microsoft.com/playwright:vX.Y.Z` の bump は Node 版・同梱ブラウザ・OS deps が一斉に動くため、単独 sprint で行う。確認点:

1. 新 image の **Node major**(post-create の corepack / packageManager 追従が動くか、app の engines と整合するか)
2. **同梱ブラウザ**(現状 playwright MCP は `--browser chrome` で system Chrome を使うため未使用だが、前提が変わっていないか → §7.6)
3. **post-create postcondition への影響**(apt 系 step 4/6 が新 base で通るか)
4. rebuild → postcondition 全通過 → 実版 summary を記録して commit

### 7.6 ブラウザ責務表(どのブラウザを誰が使うか)

| ブラウザ | 導入経路 | 使うもの |
|---|---|---|
| image 同梱ブラウザ(chromium 等・playwright 1.58.2 世代) | image に pre-install | **誰も使わない**(repo に playwright 依存なし・MCP は下記 Chrome を使用) |
| Google Chrome(apt stable) | post-create step 6 | playwright MCP(`--browser chrome` 指定・CDP 駆動) |

**版 skew の結論(2026-07-18 事実確認)**: playwright MCP(`@playwright/mcp@0.0.78`)は内部に playwright `1.62.0-alpha` を exact 同梱し npx が独立に解決するため、**image v1.58.2 の playwright/同梱ブラウザとは実行経路が交わらず、skew は実害にならない**。実在する唯一の版結合は「MCP 内部 playwright ↔ system Chrome stable」で、これは playwright が公式サポートする緩い結合(CDP)。image が効くのは Node 版と OS deps のみ。

## 8. よく使うコマンド

```bash
claude                                                  # Claude Code 起動
stripe login && stripe listen --forward-to localhost:3000/api/webhooks/stripe
pnpm dev / build / lint / test                          # README.md §5.1 参照
```

開発ワークフロー(review / commit 規約 / sprint gate)の正本は `CLAUDE.md`。
