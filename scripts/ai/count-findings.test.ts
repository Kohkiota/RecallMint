import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// count-findings.sh の parsing を fixture で pin する。
// reviewer Important #1 を直接捕捉する test: 行頭 bullet `- [Pn]` のみを finding として
// 数え、ヘッダ/prose 中の素の "P0/P1" 表記を誤集計しないことを保証。
const COUNT_SH = path.join(process.cwd(), 'scripts/ai/count-findings.sh')

function countFindings(md: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cntfind-'))
  try {
    const f = path.join(dir, 'findings.md')
    writeFileSync(f, md)
    return execSync(`bash ${COUNT_SH} ${f}`, { encoding: 'utf8' }).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('count-findings (P 別重大度集計)', () => {
  it('codex exec review 実出力形式(bracketed bullet)を CRIT/IMP/MIN に集計', () => {
    const md = [
      '- [P0] blocker — a.ts:1',
      '- [P1] urgent — b.ts:2',
      '- [P1] urgent2 — c.ts:3',
      '- [P2] important — d.ts:4',
      '- [P3] minor — e.ts:5',
      '- [P4] info — f.ts:6',
    ].join('\n')
    // P0+P1=3 → Critical, P2=1 → Important, P3+P4=2 → Minor
    expect(countFindings(md)).toBe('3 1 2')
  })

  it('ヘッダ/prose 中の素の "P0/P1" 表記を finding と誤集計しない(#1 の核)', () => {
    const md = [
      '- **修正主体**: CC 本体(P0/P1=Critical / P2=Important / P3,P4=Minor)',
      '## P0 Highlight',
      'P0 は見つからなかった。P2 が気になる程度。',
      '- [P2] only real finding — x.ts:1',
    ].join('\n')
    // bullet finding は [P2] の 1 件のみ。素の P0/P1/P2 表記は無視。
    expect(countFindings(md)).toBe('0 1 0')
  })

  it('findings ゼロ → "0 0 0"', () => {
    expect(countFindings('（指摘なし）\n')).toBe('0 0 0')
  })
})
