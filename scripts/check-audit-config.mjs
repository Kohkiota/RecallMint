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
//   層2 whitelist: auditConfig block はサニクション形のみ通す:
//       auditConfig: / 2-space indent の ignoreGhsas:([] or 後続 list)/
//       list 項目 / コメント / 空行。それ以外の行は全て非0(規律外 key の
//       indent 変種・quoted key・colon 前空白等は認識外として弾く)。
//   既知の非対象: tab indent / 重複 auditConfig block は YAML parse error になり
//   pnpm 自体が受け付けない(検査到達前に壊れる)ため対象外。
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

  // 層2: auditConfig block の whitelist
  // `auditConfig :` / `'auditConfig':` も有効 YAML で pnpm は同一 key に解決する
  const start = lines.findIndex((l) => /^(['"]?)auditConfig\1\s*:/.test(l));
  if (start !== -1) {
    if (!/^(['"]?)auditConfig\1\s*:\s*(#.*)?$/.test(lines[start])) {
      offending.push(lines[start]); // inline flow (`auditConfig: { ... }`) 等
    } else {
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\S/.test(line)) break; // 次の top-level key で block 終端
        if (/^\s*$/.test(line)) continue; // 空行
        if (/^\s*#/.test(line)) continue; // コメント行
        if (/^ {2}ignoreGhsas:\s*(\[\]\s*)?(#.*)?$/.test(line)) continue; // 唯一の key
        if (/^ {3,}-\s*\S/.test(line)) continue; // ignoreGhsas 配下の list 項目
        offending.push(line);
      }
    }
  }

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
        .join(', ')} — 受容は auditConfig.ignoreGhsas のみ。ignoreCves はコメント含め本 file に書かない(ドキュメント・記録は docs/audit/dependency-audit-ledger.md へ)。無許可 suppression の疑いとして扱う(台帳「運用」参照)`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
