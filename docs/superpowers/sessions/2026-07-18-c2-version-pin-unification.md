# C2: version pin 統一 + 更新手順 README — 実装記録

- **日付**: 2026-07-18
- **kickoff**: @latest 全廃・最新安定版 exact pin(alpha/beta/RC/canary 除外)。例外 2 つ = Claude Code 本体(stable channel 維持)/ container image(v1.58.2 現状維持)。Codex は contract gate 通過後のみ更新。
- **status**: **完了**(contract gate 全通過 → Codex 0.144.5 へ pin 更新。OT rebuild + postcondition 確認待ち → §7)

## 1. Step 0 現物確認

- `.mcp.json`: playwright / context7 とも `@latest` — pin 対象で確定
- `post-create.sh`: `CODEX_VERSION="0.142.3"` 変数 1 箇所。install(L70)と postcondition(L71-72)が同一変数参照 = **pin と期待値の二重管理は既に無い**(kickoff 論点 4 は現状構造で解消済、追加変更不要)
- scripts/ai 現 invocation(本 sprint で不変更):
  - `codex-review.sh`: `timeout $T codex exec review --uncommitted -c sandbox_mode="danger-full-access" -o <raw>` → 保存 md を `count-findings.sh`(行頭 `- [Pn]` bullet anchor)で Crit/Imp/Min 集計。pass 判定は保存 md、exit code は走破レイヤー(0/3/124/他)
  - `codex-plan-review.sh`: `codex exec - -s danger-full-access -o <raw>`(stdin 入力)
  - read-only 担保 = `worktree-snapshot.sh`(内容ベース + .git/hooks)前後比較
- `.devcontainer/README.md`: kickoff は「新設」だが **C1(339a74c)で既設**。→ 新 file を作らず既存に §7 を追記する形に変更(報告済)
- `devcontainer-lock.json`: C1 で撤去済の `desktop-lite` feature を lock したまま陳腐化(現 devcontainer.json に features キー無し)→ **削除**(pin 正本を README 化する本 sprint と矛盾する死に file。revert は 1 file 復元のみ)

## 2. registry 実値(2026-07-18 `npm view <pkg> dist-tags --json`)

| package | latest(安定) | 除外した tag |
|---|---|---|
| `@playwright/mcp` | **0.0.78** | next = 0.0.78-alpha-2026-07-17 |
| `@upstash/context7-mcp` | **3.2.4** | canary = 2.1.0-canary-* |
| `@openai/codex` | **0.144.5** | alpha = 0.145.0-alpha.23 / beta / native |

## 3. Codex contract gate(0.142.3 → 0.144.5 候補)

方式 = rebuild 不要の `npx -y @openai/codex@0.144.5` exact 指定。fixture repo は scratchpad(`codex-gate/fixture-repo`、average 関数の off-by-one で常時 NaN になる既知欠陥を uncommitted で植込み)。

### 3.1 認証不要部分(完了)

- **版起動**: `npx -y @openai/codex@0.144.5 --version` → `codex-cli 0.144.5` exit 0
- **flag 互換(静的)**: `codex exec --help` / `codex exec review --help` の出力が旧新で **byte 一致**(diff 差分ゼロ)。scripts/ai 使用 flag(`--uncommitted` / `-c --config` / `-o --output-last-message` / `-s --sandbox`)全て実在
- **fixture e(auth 失敗の判別)**: 未認証状態で両版実測 —— 旧新とも **exit 1 + stderr に 401 ERROR ×5 retry + `-o` 出力 file 未生成**。「finding 無し」(exit 0 + md 保存)と明確に区別可能、挙動も旧新同一
- **fixture e(timeout の判別)**: `timeout 5 npx ...@0.144.5 exec review ...` → **exit 124**(script 層の timeout(1) 由来、版非依存を実測確認)

### 3.2 fixture a–d(OT `codex login` 後に実走・全通過)

前提: 直近 rebuild で `~/.codex` が named volume 外のため認証消失していた(OT が login 再実行)。同一入力・同一 invocation(`codex exec review --uncommitted -c sandbox_mode="danger-full-access" -o`)で旧新比較:

| fixture | 旧 0.142.3 | 新 0.144.5 | 判定 |
|---|---|---|---|
| a. 欠陥植込み diff(off-by-one → 常時 NaN) | **[P1] 1 件で検出**(exit 0) | **[P1] 1 件で検出**(exit 0)。指摘内容も同旨(out-of-bounds read → NaN) | 同等 |
| b. clean diff(median 関数追加・sanity 済) | Crit/Imp/Min = **0 0 0** | **0 0 0** | 同等 |
| c. worktree 内容不変(worktree-snapshot sha256 前後比較) | UNCHANGED(a/b 両走) | UNCHANGED(a/b 両走) | 同等 |
| d. count-findings `- [Pn]` 集計 | a=`1 0 0` / b=`0 0 0` | a=`1 0 0` / b=`0 0 0`(bullet 形式不変) | 同等 |

- 追加: plan-review 側 invocation `codex exec - -s danger-full-access -o`(stdin)も 0.144.5 で exit 0 + `-o` 出力を確認
- **gate 判定: 通過(全項目で旧版と同等・劣化なし)→ `CODEX_VERSION` を 0.144.5 へ更新**
- raw 証拠: scratchpad `codex-gate/`(a-old/a-new/b-old/b-new/stdin-new の .md + .log。session 限りの一時領域)

## 4. MCP pin + live 確認(完了)

`.mcp.json` を `@playwright/mcp@0.0.78` / `@upstash/context7-mcp@3.2.4` に exact pin(起動形態 flag は不変更)。live 確認は pin 版を stdio JSON-RPC 直叩き(scratchpad/mcp-smoke.mjs: initialize → tools/list → tools/call 順)で実施 — session 常駐 server の版曖昧性を排除するため:

- **playwright 0.0.78**: serverInfo `{"name":"Playwright","version":"1.62.0-alpha-1783623505000"}` / tools 24 本 / `browser_navigate` https://example.com → Page Title "Example Domain" / `browser_snapshot` で heading 取得 / `browser_close` 正常 → **PASS**
- **context7 3.2.4**: serverInfo version 3.2.4 / `resolve-library-id`("next.js") → `/vercel/next.js`(snippets 6027)/ `query-docs`(app router routing)→ 実 doc 取得 → **PASS**

## 5. ブラウザ責務 / 版 skew の事実確認(完了)

- `@playwright/mcp@0.0.78` の dependencies = playwright / playwright-core `1.62.0-alpha-1783623505000` **exact**(npm view で確認)。npx が独立に解決し、image 内蔵の playwright とは無関係
- repo package.json に playwright 依存なし(grep 0 件。E2E は MCP のみ)
- `--browser chrome` により実駆動は post-create 導入の system Google Chrome(apt stable)
- **結論**: image v1.58.2 同梱ブラウザ/playwright は誰も使わず、**skew は実害にならない**。唯一の実結合 = MCP 内部 playwright ↔ system Chrome stable(playwright 公式サポートの緩い CDP 結合)。image が効くのは Node 版と OS deps のみ。→ README §7.6 の表に記載

## 6. インシデント記録(正直申告)

**`.playwright-mcp/` の誤削除**: pin 版 live 確認が repo root に生成した snapshot を掃除する際、`ls && rm -rf` を同一コマンド連鎖で実行し、ls 出力(= 7/7 以降の過去 smoke セッション raw artifact: console log 47 本 / page snapshot 90 本超 / smoke-test.png)を確認する前に削除が走った。

- **影響**: repo/source への影響ゼロ(`.gitignore` L39 で untracked・一度も track されず)。失われたのは過去 smoke の raw 証拠 file のみで、必須証拠は各 session doc に転記済みの運用のため実害は限定的。ただし raw 遡及は不能になった
- **原因**: 削除対象の内容確認と削除を 1 コマンドに連結した(確認結果を見て中止する余地を自分で潰した)
- **再発防止**: 削除は「内容確認 → 別コマンドで削除」の 2 段に分離する(feedback memory に保存)

## 7. OT rebuild チェックリスト(C2 反映版。C1 §9 との差分 = 3・8)

1. post-create が exit 0 で完走(POSTCONDITION FAIL 出力なし)
2. `pnpm --version` = packageManager field と一致
3. `claude --version` / `codex --version`(**= 0.144.5**)/ `stripe --version` / `google-chrome --version` 成功
4. `claude plugin list` に chrome-devtools が無い・typescript-lsp / superpowers / frontend-design enabled
5. VS Code PORTS に 6080 が無い
6. claude 起動時 model が global 既定
7. 初回セッションで Stop hook 3 本発火
8. **`codex login` を再実行**(`~/.codex` は named volume 外 = rebuild で認証消失。今回実証)
9. fresh clone の場合のみ: .mcp.json 承認プロンプト応答

## 8. 変更 file と検証

- `.mcp.json`: `@playwright/mcp@0.0.78` / `@upstash/context7-mcp@3.2.4` exact pin(起動 flag 不変更)
- `.devcontainer/post-create.sh`: `CODEX_VERSION` 0.142.3 → **0.144.5**(contract gate 通過済)
- `.devcontainer/README.md`: §7(pin 一覧 / 更新手順 / contract gate / 戻し方 / image 手順 / ブラウザ責務表)追記、旧 §7 → §8
- `.devcontainer/devcontainer-lock.json`: 削除(C1 撤去済 desktop-lite の陳腐化 lock)
- 検証分担: CC = fixture 比較 + MCP live 確認 + 静的検証(完了)/ OT = rebuild + postcondition + §7 checklist
- **whole-repo `pnpm lint --max-warnings=0` exit 0 確認済**(sprint 完了 gate)
- commit: `f3e6aa5`(chore(devcontainer): pin 統一 + lock 削除)+ 本 doc / README の docs(devcontainer) commit(直後)
