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
  it('GREEN: ignoreGhsas 空配列のみ → exit 0', () => {
    const r = runOn('overrides:\n  react: 19.2.7\n\nauditConfig:\n  ignoreGhsas: []\n')
    expect(r.status).toBe(0)
  })

  it('GREEN: ignoreGhsas 複数行 list → exit 0(list 項目を key と誤認しない)', () => {
    const r = runOn('auditConfig:\n  ignoreGhsas:\n    - GHSA-aaaa-bbbb-cccc\n    - GHSA-dddd-eeee-ffff\n')
    expect(r.status).toBe(0)
  })

  it('GREEN: auditConfig block 無し → exit 0', () => {
    const r = runOn('overrides:\n  react: 19.2.7\n')
    expect(r.status).toBe(0)
  })

  it('GREEN: block 内コメント行(# 空白有無どちらも)を key と誤検知しない', () => {
    const r = runOn('auditConfig:\n  # 受容 allow-list のメモ\n  #詰めコメント\n  ignoreGhsas: []\n')
    expect(r.status).toBe(0)
  })

  it('RED: コメント内の ignoreCves 文字列も trip する(仕様 = 本 file にドキュメントを書かない・記録は台帳へ)', () => {
    const r = runOn('auditConfig:\n  # ignoreCves: 旧記法のメモ\n  ignoreGhsas: []\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ignoreCves')
    expect(r.stderr).toContain('dependency-audit-ledger')
  })

  it('GREEN: block 開始行の末尾コメントは許容', () => {
    const r = runOn('auditConfig: # allow-list(台帳参照)\n  ignoreGhsas: []\n')
    expect(r.status).toBe(0)
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

  it('RED: quoted な legit key(`  \'ignoreGhsas\': []`)も書式固定違反として弾く(fail-closed)', () => {
    const r = runOn("auditConfig:\n  'ignoreGhsas': []\n")
    expect(r.status).toBe(1)
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
