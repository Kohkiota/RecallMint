# Session: LSP 運用締め(binary pin + README 記載 + 機能 postcondition + cache 掃除)

- **日付**: 2026-07-21
- **範囲**: `e96bb9b..46ce868`(未 push)
  - `16019f8` chore(devcontainer): TypeScript LSP を exact pin + 機能 postcondition 追加 **[reviewed]**
  - `46ce868` docs(devcontainer): §7.1 に TS LSP / global TS pin 記載 + Codex review 保存 **[no-review]**
- **前提**: 2026-07-21 の read-only fact-finding(typescript-lsp 動作実証・rebuild 耐性・版状況)結果の恒久化。
- **実装方式**: subagent-driven-development(implementer=NO commit → controller が canonical + Codex → fix loop → controller commit)。brainstorming/writing-plans は skip(brief が plan 級)。

## Step 0 現物再確認(調査値と一致)

- `typescript-language-server --version` = `5.3.0` / global `tsc --version` = `Version 7.0.2` / repo `package.json` typescript = `^6.0.3`。
- 既存 pin の型 = `CODEX_VERSION` 変数 + postcondition 同変数照合(二重管理なし)。
- cache: superpowers `6.0.3` = stale(installed_plugins.json 参照 0・orphan Jun27 marker のみ)/ `6.1.1` = active。

## Task 1(binary exact pin)

- `TSLS_VERSION="5.3.0"` / `TS_VERSION="6.0.3"`(repo `^6.0.3` と lockstep)を追加。
- install を exact 指定へ、postcondition を存在確認 → **pin 値完全一致**(`[ "$a" = "$b" ]`・substring 誤 match 回避)へ強化。
- in-container で冪等 2 回 exit0(global tsc 7.0.2 → 6.0.3 downgrade は intended)。

## Task 3(LSP 機能 postcondition)

- 新規 `.devcontainer/verify-lsp-diagnostics.mjs`: stdio LSP JSON-RPC で `initialize` → 型エラー probe(`const n: number = "x"`)を `didOpen` → `publishDiagnostics` 受信を検証。診断 ≥1 で exit0、無ければ non-0。probe は一時 file(終了時削除)、30s timeout。
- post-create step[7/8] に `node ... || fail` で配線。
- **判別力実証(TDD driving property)**: GREEN(bad probe → exit0・実診断1件)/ RED(clean probe → exit1)を実 tsls 5.3.0 で実走。
- Task C: eslint global ignores に `.devcontainer/**`(ops tooling・非 app source)。

## Task 2(README §7.1)

- pin 表に typescript-language-server / global TypeScript の 2 行(lockstep + TS7 機能前提注記)。
- 「意図的に pin しないもの」に typescript-lsp plugin(v1.0.0)/ Superpowers(6.1.1)+ トリガー(plugin 起因の挙動変化時は pin 検討起票)。

## Task 4(stale cache 掃除)

- 2 段分離(inspect → delete)。Stage1 で 6.0.3 = 参照0 + orphan marker のみ = stale、6.1.1 = active を確認。Stage2 で `6.0.3` のみ削除。6.1.1 保全・skills 健全・installed_plugins.json 不変を検証。

## Review(canonical + Codex)

- canonical(`superpowers:requesting-code-review` / general-purpose / template 改変なし):
  - 初回: Critical 0 / **Important 2**(#1 publishDiagnostics race = 空 syntax 先取りで誤 NG、#2 stderr 未消費 + exit handler 無し)/ Minor 3。深掘りで installed tsls 5.3.0 source を読み 50ms debounce 挙動を確認。
  - fix 後 再レビュー: **Critical 0 / Important 0 / Ready=Yes**(両 Important を実行検証で解消確認)。
- Codex 独立(`scripts/ai/codex-review.sh` / 2 回=pre-fix・post-fix): **両方とも findings 0**。
- **fix 内容**: #1 = 非空診断で即 resolve(race 構造排除)+ 空は quiescence 500ms + 30s backstop / #2 = stderr 捕捉 + `child.on('exit')` fast-fail / stdin.on('error') 補完(controller 追加)/ Minor コメント正確化・try/finally cleanup・summary に tsc 追加。
- Minor 記録のみ(record-only): 再レビュー 2 件(stdin.error↔exit の message 順序 / exit vs close の stderr tail)= いずれも synthetic のみ・実 tsls 不到達・fail-closed。

## 重要発見(OT 向け)

- **TS7 は native(Go)実装で `tsserver.js` を持たず typescript-language-server が動作しない**。よって global typescript の 6.x pin は drift 対策でなく **LSP 機能の前提**。将来 repo が 7.x に移る場合は typescript-language-server 互換性の再評価が必要(別イベント)。

## Gate

- whole-repo `pnpm lint` **exit 0**。
- `pnpm test:iso` **171 passed(19 files)green**(PG17 cluster online)。
- 追加 gate(frozen-lockfile / typecheck / build)は非該当(依存 / Next / Node / lockfile 不変)。

## 未了(OT 後続)

- **full rebuild 検証**: post-create.sh 全 step が rebuild で exit0 通過すること。CC は現コンテナ内で修正 step(step5 pin postcondition 冪等 2 回 / step7 verify-lsp GREEN/RED 実走)を単体実行済。
- push は OT。
