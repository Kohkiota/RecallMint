#!/usr/bin/env node
// audit gate wrapper(matrix v2 / 2026-07-25 制定)。sprint 完了 gate の `pnpm run audit`。
//
// なぜ wrapper か: pnpm の `--audit-level` は 1 実行 1 グローバル閾値ゆえ prod/dev に別
// ポリシーを課せない(Step0.5 領域 D 実証)。よって 2 回別実行し scope 別に判定する:
//   - prod: high/critical が 1 件でも fail。allowlist を一切適用しない(公開面の受容ゼロ)。
//     optional 依存も含める(--no-optional を付けない)。
//   - dev : scripts/audit-allowlist.json と version-aware で照合。未受容 high/critical /
//           期限切れ / range 外(patched 版が別経路で同 GHSA を踏む等)は fail。
//
// 受容の唯一の置き場は scripts/audit-allowlist.json。pnpm-workspace.yaml には auditConfig を
// 置かない — 置くと pnpm が本 wrapper に advisory を渡す前に沈黙 filter し allowlist を迂回する
// (pnpm の advisories map は ignore 後の値・実測)。冒頭で check-audit-config.mjs の tripwire を
// 通し、auditConfig 行(ignoreGhsas/ignoreCves いずれも)が pnpm-workspace.yaml に無いことを
// 保証する = wrapper の入力(advisory 全件)が沈黙 filter されていないことの担保。
//
// fail-closed(Step0.5 領域 3 の設計要件): audit 出力を鵜呑みにせず、pass 判定の前に
//   ① exit code の健全性(0=findings なし / 1=findings あり の 2 値のみ・整合も検証)
//   ② JSON.parse 成否
//   ③ 期待構造(advisories オブジェクト + metadata.vulnerabilities.high|critical が数値)
// のいずれか欠けたら pass ではなく fail(registry 障害・出力破損を「脆弱性なし」と誤認しない)。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkAuditConfig } from './check-audit-config.mjs';

const WORKSPACE_YAML = new URL('../pnpm-workspace.yaml', import.meta.url);
const ALLOWLIST_JSON = new URL('./audit-allowlist.json', import.meta.url);

// --- 最小・fail-closed な「版が range を満たすか」判定 ---------------------------
// semver パッケージは pnpm strict node_modules 下で first-party script から解決不能
// (MODULE_NOT_FOUND 実測)ゆえ最小自前実装。range = 空白 AND 連結の comparator。
// 想定外の版/表記(prerelease・|| 等)は throw → 呼び出し側で fail-closed(受容しない)。
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw new Error(`版として解釈不能(fail-closed): ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
function satisfiesComparator(version, comparator) {
  const m = /^(<=|>=|<|>|=)?\s*(\d+\.\d+\.\d+)$/.exec(String(comparator).trim());
  if (!m) throw new Error(`comparator 解釈不能(fail-closed): ${JSON.stringify(comparator)}`);
  const op = m[1] || '=';
  const c = cmpVersion(parseVersion(version), parseVersion(m[2]));
  if (op === '<') return c < 0;
  if (op === '<=') return c <= 0;
  if (op === '>') return c > 0;
  if (op === '>=') return c >= 0;
  return c === 0; // '='
}
function satisfiesRange(version, range) {
  const comps = String(range).trim().split(/\s+/).filter(Boolean);
  if (comps.length === 0) throw new Error(`range 空(fail-closed): ${JSON.stringify(range)}`);
  return comps.every((c) => satisfiesComparator(version, c));
}

// --- audit の 1 scope 実行 + fail-closed 検証 -----------------------------------
// 返り値: { ok:true, highOrCrit:[...] } または { ok:false, reason }
function evaluateScope(scope) {
  let stdout;
  let code;
  try {
    stdout = execFileSync('pnpm', ['audit', `--${scope}`, '--audit-level', 'high', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    code = 0; // findings なし(pnpm は high 以上ゼロで exit 0)
  } catch (e) {
    // pnpm audit は high 以上ありで exit 1 → execFileSync が throw。stdout は e.stdout に入る。
    stdout = e && e.stdout != null ? String(e.stdout) : '';
    code = e && typeof e.status === 'number' ? e.status : null;
  }

  // ① exit code の健全性: 0/1 以外(signal kill・registry 異常等)は fail-closed
  if (code !== 0 && code !== 1) {
    return { ok: false, reason: `${scope}: pnpm audit の exit code 想定外(${code})— registry 障害/異常終了の疑い` };
  }
  // ② JSON.parse
  let j;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: `${scope}: audit 出力を JSON parse 不能(出力長=${stdout.length})` };
  }
  // ③ 期待構造
  const vulns = j && j.metadata && j.metadata.vulnerabilities;
  if (
    !j || typeof j !== 'object' ||
    typeof j.advisories !== 'object' || j.advisories === null ||
    !vulns || typeof vulns !== 'object' ||
    typeof vulns.high !== 'number' || typeof vulns.critical !== 'number'
  ) {
    return { ok: false, reason: `${scope}: audit 出力の期待構造(advisories / metadata.vulnerabilities.high|critical)欠落` };
  }

  const highOrCrit = Object.values(j.advisories).filter(
    (a) => a && (a.severity === 'high' || a.severity === 'critical'),
  );
  // exit code と内容の整合(--audit-level high なので exit1 ⟺ high/crit あり)
  if (code === 0 && highOrCrit.length > 0) {
    return { ok: false, reason: `${scope}: exit 0 だが high/critical advisory ${highOrCrit.length} 件検出(矛盾)` };
  }
  if (code === 1 && highOrCrit.length === 0) {
    return { ok: false, reason: `${scope}: exit 1 だが high/critical advisory ゼロ(矛盾)` };
  }
  return { ok: true, highOrCrit };
}

function advisoryLabel(a) {
  const versions = [...new Set((a.findings || []).map((f) => f && f.version).filter(Boolean))];
  return `${a.github_advisory_id}(${a.module_name}@${versions.join(',') || '?'})`;
}

function loadAllowlist() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(ALLOWLIST_JSON, 'utf8'));
  } catch (e) {
    throw new Error(`audit-allowlist.json を読めない/parse 不能(fail-closed): ${e.message}`);
  }
  const entries = raw && Array.isArray(raw.entries) ? raw.entries : null;
  if (!entries) throw new Error('audit-allowlist.json に entries 配列がない(fail-closed)');
  for (const e of entries) {
    if (
      !e || typeof e.ghsa !== 'string' || typeof e.module !== 'string' ||
      typeof e.vulnerableRange !== 'string' || typeof e.expiry !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(e.expiry)
    ) {
      throw new Error(`audit-allowlist.json エントリの必須 field 欠落/不正(fail-closed): ${JSON.stringify(e)}`);
    }
    // expiry は実在する暦日であること。shape(\d{4}-\d{2}-\d{2})だけ通すと 2026-13-01 /
    // 2026-02-31 等が素通りし、expiry 判定は lexical 比較ゆえ「実在しないが常に未来」の値が
    // 受容を無期限に延長する fail-open になる → UTC round-trip で暦日実在を検証。
    const [ey, em, ed] = e.expiry.split('-').map(Number);
    const dt = new Date(Date.UTC(ey, em - 1, ed));
    if (dt.getUTCFullYear() !== ey || dt.getUTCMonth() !== em - 1 || dt.getUTCDate() !== ed) {
      throw new Error(`audit-allowlist.json エントリの expiry が実在しない暦日(fail-closed): ${JSON.stringify(e.expiry)}`);
    }
  }
  return entries;
}

function main() {
  const fails = [];

  // step0: tripwire — pnpm-workspace.yaml に auditConfig(ignoreGhsas/ignoreCves 系の
  // silent-filter)が無いこと。これが通ることで「pnpm 側で advisory が沈黙 filter されて
  // いない」= wrapper が high/critical 全件を見ている、を担保する(受容は allowlist のみ)。
  const offending = checkAuditConfig(readFileSync(WORKSPACE_YAML, 'utf8'));
  if (offending.length > 0) {
    fails.push(
      `pnpm-workspace.yaml の tripwire 検出(無許可 suppression の疑い): ${offending
        .map((l) => JSON.stringify(l.trim()))
        .join(', ')}`,
    );
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD(UTC)

  // prod: allowlist 不適用
  const prod = evaluateScope('prod');
  if (!prod.ok) {
    fails.push(prod.reason);
  } else if (prod.highOrCrit.length > 0) {
    fails.push(
      `prod に high/critical ${prod.highOrCrit.length} 件(prod は allowlist 不適用 = 無条件 fail): ${prod.highOrCrit
        .map(advisoryLabel)
        .join(', ')}`,
    );
  }

  // dev: allowlist と version-aware 照合
  let allowlist;
  try {
    allowlist = loadAllowlist();
  } catch (e) {
    fails.push(e.message);
    allowlist = [];
  }

  // 期限は全 entry に対し「無条件」で強制する: advisory が今回の audit 応答に現れるか否かに
  // 依らない。この pass が無いと、受容中の advisory が一時的に registry から消えた/脆弱依存が
  // 外れた場合に期限切れ entry が検出されず居座り、「expiry 経過で自動 fail」の保証が崩れる。
  for (const e of allowlist) {
    if (today > e.expiry) {
      fails.push(`allowlist entry 期限切れ(advisory 未検出でも強制): ${e.ghsa}(${e.module}) expiry=${e.expiry} / today=${today} — 撤去 or 再検討`);
    }
  }

  const dev = evaluateScope('dev');
  const accepted = [];
  if (!dev.ok) {
    fails.push(dev.reason);
  } else {
    for (const a of dev.highOrCrit) {
      const entry = allowlist.find((e) => e.ghsa === a.github_advisory_id && e.module === a.module_name);
      if (!entry) {
        fails.push(`dev: ${advisoryLabel(a)} は allowlist に該当エントリなし`);
        continue;
      }
      // 期限切れは上の無条件 pass が既に fail 済 — ここでは受容せず黙って skip(二重 message 回避)。
      if (today > entry.expiry) continue;
      const versions = [...new Set((a.findings || []).map((f) => f && f.version).filter(Boolean))];
      if (versions.length === 0) {
        fails.push(`dev: ${advisoryLabel(a)} は finding version 不明(fail-closed)`);
        continue;
      }
      let problem = null;
      for (const v of versions) {
        let inRange;
        try {
          inRange = satisfiesRange(v, entry.vulnerableRange);
        } catch (err) {
          problem = `版照合失敗(${err.message})`;
          break;
        }
        if (!inRange) {
          problem = `finding version ${v} が受容 range "${entry.vulnerableRange}" 外(patched/別版の疑い)`;
          break;
        }
      }
      if (problem) {
        fails.push(`dev: ${advisoryLabel(a)} — ${problem}`);
      } else {
        accepted.push(`${advisoryLabel(a)} [expiry ${entry.expiry}]`);
      }
    }
  }

  if (fails.length > 0) {
    console.error('NG: audit gate fail(fail-closed)');
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('OK: audit gate pass');
  console.log('  prod: high/critical 0');
  console.log(`  dev : high/critical ${accepted.length} 件を allowlist で受容${accepted.length ? '(' + accepted.join(', ') + ')' : ''}`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
