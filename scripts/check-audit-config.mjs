#!/usr/bin/env node
// audit gate の前段検査: pnpm-workspace.yaml への無許可 suppression(CLI
// `pnpm audit --ignore` が無断書込する auditConfig.ignoreCves 等)を機械検出
// して gate を落とす。正本規律 = docs/audit/dependency-audit-ledger.md「運用」。
//
// threat model(2026-07-21 OT 確定):
//   検出対象 = ①pnpm CLI の標準書込(--ignore が書く block style)②素朴な hand-edit。
//   非目標   = 敵対的 YAML 難読化(!!str tag / explicit key / escape 分断等の意図的
//              偽装)。理由: 難読化を書ける悪意者は本 script 自体を編集できるため
//              tripwire では原理的に防御不能 — その層は review governance の管掌。
//   js-yaml 等での構造 parse は不採用: pnpm 自前 parser との解釈差が新たな穴になる。
//
// 実装 = 2 層 fail-closed:
//   層1 substring: file 全文(コメント含む)に `ignoreCves` が現れたら非0。
//       コメント内出現も trip する仕様は意図 — この file にドキュメントを書かない、
//       記録は台帳へ。exotic な key 表現(!!str / ? explicit key)もここで捕まる。
//   層2 auditConfig 全拒否: 受容は scripts/audit-allowlist.json 管理の wrapper
//       (scripts/audit-gate.mjs)へ移行済(matrix v2 / 2026-07-25)ため、この file の
//       auditConfig は用途を失った。pnpm は auditConfig.ignoreGhsas/ignoreCves を
//       wrapper へ渡す前に advisory を沈黙 filter する(silent-filter による allowlist
//       迂回)ため、**auditConfig 行が現れたら無条件で非0**(旧 ignoreGhsas whitelist は撤去)。
//   layer2 の regex は先頭 whitespace を許容する: YAML は root mapping 全体を一律
//   indent しても有効で、pnpm はその indent された auditConfig も honor する(space indent
//   を実測 = ignoreGhsas が効き advisory が消える)。column1 固定だと indent 版が素通りする
//   bypass になるため `^\s*` で拾う(tab indent は pnpm 側が parse error だが拾って害なし)。
//   既知の非対象: 重複 auditConfig block は YAML parse error になり pnpm 自体が受け付けない
//   (検査到達前に壊れる)ため対象外。敵対的難読化(!!str auditConfig / ? explicit key /
//   escape 分断等・ignoreCves token を漏らさない形)は層1 も層2 も素通りしうるが
//   threat model 上 review governance の管掌(上記 non-goal・js-yaml parse は不採用)。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 戻り値: 認識外/規律外の行の配列(空 = pass)
export function checkAuditConfig(yamlText) {
  const lines = yamlText.split('\n');
  const offending = [];

  // 層1: substring(コメント含む全文)
  for (const line of lines) {
    if (line.includes('ignoreCves')) offending.push(line);
  }

  // 層2: auditConfig 行そのものを拒否(受容は scripts/audit-allowlist.json のみ)。
  // `auditConfig :` / `'auditConfig':` / `"auditConfig":` も有効 YAML で pnpm は同一 key に解決する。
  // 先頭 `\s*` = root mapping 一律 indent 版(pnpm が honor する実測)も拾う(冒頭コメント参照)。
  const start = lines.findIndex((l) => /^\s*(['"]?)auditConfig\1\s*:/.test(l));
  if (start !== -1) offending.push(lines[start]);

  return [...new Set(offending)];
}

function main() {
  // 検査対象 path は引数で注入可能(test が fixture を渡す)。既定 = repo の正本。
  const target = process.argv[2] ?? new URL('../pnpm-workspace.yaml', import.meta.url);
  const offending = checkAuditConfig(readFileSync(target, 'utf8'));
  if (offending.length > 0) {
    console.error(
      `NG: pnpm-workspace.yaml の audit 検査で認識外/規律外の内容(fail-closed で拒否): ${offending
        .map((l) => JSON.stringify(l.trim()))
        .join(', ')} — 受容は scripts/audit-allowlist.json のみ。pnpm-workspace.yaml に auditConfig を置かない(ignoreCves/ignoreGhsas いずれも pnpm が advisory を沈黙 filter するため)。記録は docs/audit/dependency-audit-ledger.md へ。無許可 suppression の疑いとして扱う(台帳「運用」参照)`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
