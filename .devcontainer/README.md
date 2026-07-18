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

## 2. post-create.sh が入れるもの(7 step)

1. npm global prefix(EACCES 対策)
2. pnpm(corepack install = packageManager field 準拠)
3. **Claude Code**(native installer / stable channel)
4. Stripe CLI(webhook のローカル転送用)
5. TypeScript Language Server + **Codex CLI**(exact pin。独立レビュアー用 → §5)
6. Google Chrome(Playwright MCP が `--browser chrome` で使用)
7. Claude plugin 登録(marketplace: claude-plugins-official / plugin: typescript-lsp)

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

## 7. よく使うコマンド

```bash
claude                                                  # Claude Code 起動
stripe login && stripe listen --forward-to localhost:3000/api/webhooks/stripe
pnpm dev / build / lint / test                          # README.md §5.1 参照
```

開発ワークフロー(review / commit 規約 / sprint gate)の正本は `CLAUDE.md`。
