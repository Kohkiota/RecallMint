import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// gate が実際に呼ぶ CLI 契約(exit code + stderr)そのものを検証する。
// 対象 = check-audit-config.mjs(audit gate の規律外 key 検査・security guard)。
const SCRIPT = join(__dirname, 'check-audit-config.mjs')

function runOn(yaml: string): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'audit-config-test-'))
  const file = join(dir, 'pnpm-workspace.yaml')
  writeFileSync(file, yaml)
  const r = spawnSync('node', [SCRIPT, file], { encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr }
}

describe('check-audit-config.mjs (audit gate tripwire)', () => {
  // 受容が scripts/audit-allowlist.json へ移行(matrix v2 / 2026-07-25)して以降、
  // pnpm-workspace.yaml の auditConfig は用途を失い、置かれると pnpm が advisory を
  // wrapper へ渡す前に沈黙 filter する = allowlist 迂回。よって auditConfig 行は無条件拒否。
  it('RED: auditConfig + ignoreGhsas 空配列 → exit 1(受容は JSON へ移行・auditConfig 全拒否)', () => {
    const r = runOn('overrides:\n  react: 19.2.7\n\nauditConfig:\n  ignoreGhsas: []\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('auditConfig')
    expect(r.stderr).toContain('audit-allowlist.json')
  })

  it('RED: auditConfig + ignoreGhsas 複数行 list → exit 1(silent-filter 迂回の防止)', () => {
    const r = runOn('auditConfig:\n  ignoreGhsas:\n    - GHSA-aaaa-bbbb-cccc\n    - GHSA-dddd-eeee-ffff\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('auditConfig')
  })

  it('GREEN: auditConfig block 無し → exit 0', () => {
    const r = runOn('overrides:\n  react: 19.2.7\n')
    expect(r.status).toBe(0)
  })

  it('RED: auditConfig 内コメント行があっても auditConfig 行自体で trip する', () => {
    const r = runOn('auditConfig:\n  # 受容 allow-list のメモ\n  #詰めコメント\n  ignoreGhsas: []\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('auditConfig')
  })

  it('RED: コメント内の ignoreCves 文字列も trip する(層1 substring・記録は本 file に書かない)', () => {
    const r = runOn('overrides:\n  # ignoreCves: 旧記法のメモ\n  react: 19.2.7\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
    expect(r.stderr).toContain('dependency-audit-ledger')
  })

  it('RED: block 開始行の末尾コメントがあっても auditConfig 行で trip する', () => {
    const r = runOn('auditConfig: # 旧 allow-list(台帳参照)\n  ignoreGhsas: []\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('auditConfig')
  })

  it('RED: 規律外 key ignoreCves(pnpm --ignore が書く block 形)→ exit 1 + key 名', () => {
    const r = runOn('auditConfig:\n  ignoreCves:\n    - CVE-2026-8723\n  ignoreGhsas: []\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
  })

  it('RED: inline flow style(auditConfig: { ... })は fail-closed で exit 1', () => {
    const r = runOn('auditConfig: { ignoreGhsas: [], ignoreCves: ["CVE-2026-8723"] }\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('認識外')
  })

  it('RED: 後続 top-level key があっても block 内の規律外 key を検出する(終端判定)', () => {
    const r = runOn('auditConfig:\n  ignoreCves: []\n\nonlyBuiltDependencies:\n  - bufferutil\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
  })

  it('RED: コロン前空白(`auditConfig :`)でも検出する(有効 YAML の bypass 防止)', () => {
    const r = runOn('auditConfig :\n  ignoreCves:\n    - CVE-2026-8723\n  ignoreGhsas: []\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
  })

  it('RED: quoted key(`\'auditConfig\':`)でも検出する(pnpm は同一 key に解決)', () => {
    const r = runOn("'auditConfig':\n  ignoreCves:\n    - CVE-2026-8723\n")
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
  })

  it('RED: double-quoted key(`"auditConfig":`)でも検出する', () => {
    const r = runOn('"auditConfig":\n  ignoreCves: []\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
  })

  it('RED: 4-space indent の規律外 key(`    ignoreCves:`)も whitelist 外として検出する', () => {
    const r = runOn('auditConfig:\n    ignoreCves: []\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
  })

  it('RED: 内側 key の colon 前空白(`  ignoreCves : []`)も検出する', () => {
    const r = runOn('auditConfig:\n  ignoreCves : []\n  ignoreGhsas: []\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
  })

  it('RED: 旧受容 key(`  \'ignoreGhsas\': []`)も auditConfig 行で弾く(受容は JSON へ移行済)', () => {
    const r = runOn("auditConfig:\n  'ignoreGhsas': []\n")
    expect(r.status).toBe(1)
  })

  // Codex review(2026-07-25 task1 r2)の実証例: root mapping 全体を一律 indent した
  // 有効 YAML を pnpm は honor する(ignoreGhsas が効く実測)。column1 固定 regex だと
  // 素通りする bypass ゆえ `^\s*` で拾う。ignoreCves を含まない = 層1 では捕捉不能。
  it('RED: indent された root の auditConfig(ignoreGhsas・ignoreCves 無し)も層2 で弾く', () => {
    const r = runOn('  overrides:\n    react: 19.2.7\n  auditConfig:\n    ignoreGhsas:\n      - GHSA-x\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('auditConfig')
  })

  // 以下 2 本は Codex review(2026-07-21 3周目)の敵対例をそのまま fixture 化した pin。
  // top-level 検出(層2)は素通りする表現だが、substring 層(層1)が捕捉する。
  it('RED: `!!str auditConfig:` tag 形でも ignoreCves を substring 層で検出する', () => {
    const r = runOn('!!str auditConfig:\n  ignoreCves:\n    - CVE-2026-8723\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
  })

  it('RED: `? auditConfig` explicit key 形でも ignoreCves を substring 層で検出する', () => {
    const r = runOn('? auditConfig\n:\n  ignoreCves: []\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
  })

  // 非目標の宣言(検出しないことが仕様): escape 難読化(例 `"ignoreC\x76es":` =
  // YAML double-quote escape で文字列を分断する形)は敵対的難読化クラスであり
  // tripwire の対象外 — 難読化を書ける悪意者は本 script 自体を編集できるため
  // script 層では原理的に防御不能。その層は review governance が管掌する
  // (threat model = check-audit-config.mjs 冒頭コメント・OT 確定 2026-07-21)。

  it('実 file smoke: repo の pnpm-workspace.yaml(引数省略の既定 path)で exit 0', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' })
    expect(r.status).toBe(0)
  })
})
