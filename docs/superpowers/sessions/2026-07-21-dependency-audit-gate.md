# Session: 依存脆弱性 audit gate(sprint 完了 gate へ pnpm audit 組み込み)

- **日付**: 2026-07-21
- **範囲**: `31ee586..`(chore `143ca57` [reviewed] + docs 本 commit)。未 push。
- **実装方式**: controller 直実装(config/policy 4 file・前 sprint「機械的 config/docs は controller inline」前例)+ canonical/Codex review-before-commit。brainstorming / writing-plans skip(brief が plan 級)。

## Step 0(裏取り・docs URL = https://pnpm.io/10.x/cli/audit)

- **exit code は docs 無記載** → 10.33.0 実測で確定: `--audit-level` 以上の advisory が 1 件でも存在 ⟺ exit 1(low/moderate/high→1・critical→0 を実証)。
- ignore 機構(10.x)= `pnpm-workspace.yaml` の `auditConfig.ignoreGhsas` / `ignoreCves`。
- 現状検出: **48 advisories(critical 0 / high 16 / moderate 26 / low 6)** → **blocking 分岐該当で停止・OT 判断**。

## OT 判断(記録)

- **(c) 二段階制**: gate は当面 `--audit-level critical`(即 green・ignoreGhsas 空維持)。high 16 件は **bump 待ち**(受容にしない)。transitive bump sprint(別途)完了を条件に high へ引き上げ。
- allow-list 用途 = 「patched 不在 or 理由ある真の受容」限定を台帳冒頭に明記。
- `--ignore-registry-errors` 不使用(fail-closed)。台帳 = `docs/audit/dependency-audit-ledger.md` 承認。

## 実装(4 file)

- `package.json`: `"audit": "pnpm audit --audit-level critical"`。
- `pnpm-workspace.yaml`: `auditConfig.ignoreGhsas: []`(用途制限コメント付き)。
- `CLAUDE.md`: Sprint 完了 gate に audit 行(二段階 + 規律 2 点 + `--ignore` 禁止 + `pnpm run audit` 固定)。
- `docs/audit/dependency-audit-ledger.md` 新設: 運用 + 受容済(空)+ 全 48 件 snapshot(audit --json から機械生成・転記ミス排除)。

## 実証(記憶で断定しない、の実行記録)

1. `pnpm run audit` exit 0 / builtin `pnpm audit` は script に優先し low で走り exit 1(gate は `pnpm run audit` 固定の根拠)。
2. **ignoreGhsas の green 証明**: high の unique 15 GHSA を一時全登録 → `--audit-level high` exit 1→**0**・表示「16 high (16 ignored)」→ 空 list へ復元(exit 1 復帰確認)。1 件 ignore では exit 反転しない(残 15 high)ため全登録で証明した。
3. `pnpm audit --json` の metadata 件数は **ignore filter 前** — 器の検証は表出力「(N ignored)」+ exit code で行う。
4. **CLI `--ignore` は罠**: 「No new vulnerabilities were ignored」出力で exit 0。canonical reviewer が worktree copy + pnpm source で実証: **`pnpm-workspace.yaml` へ `auditConfig.ignoreCves` を無断書込**し、commit されると**以後の全 gate 実行で抑止が持続**(通常 report 経路も ignoreCves を読む)。→ 使用禁止 + 「`ignoreGhsas` 以外の `auditConfig` key 出現 = 無許可 suppression として revert」の検出規律を CLAUDE.md/台帳に明文化。
5. registry 障害は ~70s retry(10s→1min)後 exit 1 = fail-closed(reviewer 実測)。

## Review

- canonical(template 改変なし): 初回 **Crit 0 / Imp 1 / Minor 2**。Important = ignoreCves 並行 suppression 経路が規律未網羅(上記 4)。fix(検出規律追記 + Minor 2 件 = patched 表現精緻化・retry 挙動注記)→ 再レビュー **Crit 0 / Imp 0 / Ready=Yes**(reviewer が pnpm source で fix の正確性を独立検証)。
- Codex 独立: **findings 0**(`docs/codex/2026-07-21-audit-gate.md`)。
- 再レビュー新 Minor 2: ① auditConfig key の機械的 tripwire(script/lefthook)化 = YAGNI 記録のみ・follow-up 候補 ② ignoreCves 持続性の明記 = 反映済。

## Gate(フル・全 exit 0)

lint 0 / **pnpm run audit 0(新設)** / frozen-lockfile 0 / typecheck 0 / build 0 / unit **3781** / iso **171**。

## Follow-up(申し送り)

1. **transitive bump sprint(別途・OT 起票)**: high 16 件(全 patched 版リリース済)解消 → gate を `--audit-level high` へ引き上げ(台帳「bump 待ち」参照)。
2. (Minor 記録)auditConfig 異 key 検出の機械化(audit script or lefthook 1 行)— 導入判断は OT。
