import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// codex-plan-input.sh の anchor 防止構造を pin する(plan 版の肝)。
// 「調査結果+要件」が主入力として先に来て、plan ドラフトは参考添付・承認対象でない後置、
// かつ「独立論点を先に導く」指示が含まれることを保証。崩れると Codex が CC の plan に
// 引きずられ cross-check が死ぬ。
const INPUT_SH = path.join(process.cwd(), 'scripts/ai/codex-plan-input.sh')

function build(context: string, plan?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'planin-'))
  try {
    const c = path.join(dir, 'ctx.md')
    writeFileSync(c, context)
    let p = ''
    if (plan !== undefined) {
      p = path.join(dir, 'plan.md')
      writeFileSync(p, plan)
    }
    return execSync(`bash "${INPUT_SH}" "${c}" "${p}"`, { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('codex-plan-input (anchor 防止の stdin 組み立て)', () => {
  it('read-only / 修正禁止 指示を含む', () => {
    const out = build('CTX')
    expect(out).toContain('read-only')
    expect(out).toContain('禁止')
  })

  it('出力フォーマット3見出し(独立論点 / plan 抜け / リスク)を指示に含む', () => {
    const out = build('CTX')
    expect(out).toContain('## 独立論点')
    expect(out).toContain('## plan ドラフトへの抜け')
    expect(out).toContain('## リスク')
  })

  it('調査結果+要件を主入力として含む', () => {
    const out = build('CONTEXT-SENTINEL')
    expect(out).toContain('CONTEXT-SENTINEL')
    expect(out).toContain('主入力')
  })

  it('plan ドラフトは参考添付・承認対象でないとして後置(context が先)', () => {
    const out = build('CTX-A', 'PLAN-B')
    expect(out).toContain('PLAN-B')
    expect(out).toContain('=== 参考添付: plan ドラフト(承認対象ではない')
    expect(out.indexOf('CTX-A')).toBeLessThan(out.indexOf('PLAN-B'))
    expect(out).toContain('まず調査結果と要件から独立に論点を導き')
  })

  it('plan 無し → 添付セクション(ヘッダ + plan 本文)を出さない', () => {
    const out = build('CTX-ONLY')
    expect(out).not.toContain('=== 参考添付:')
  })
})
