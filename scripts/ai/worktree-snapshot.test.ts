import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// codex-review.sh の git clean detector の中核。porcelain 状態でなく「内容ベース」で
// あることを保証する test(vacuous = 常に空/定数 を返す実装に退化していないかを固める)。
const SNAPSHOT_SH = path.join(process.cwd(), 'scripts/ai/worktree-snapshot.sh')

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8' })
}
function snapshot(cwd: string): string {
  return execSync(`bash ${SNAPSHOT_SH}`, { cwd, encoding: 'utf8' })
}

describe('worktree-snapshot (git clean detector)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'wtsnap-'))
    sh('git init -q', repo)
    sh('git config user.email t@t', repo)
    sh('git config user.name t', repo)
    writeFileSync(path.join(repo, 'tracked.txt'), 'original\n')
    sh('git add -A && git commit -q -m init', repo)
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('変更なし → snapshot は安定(同一)', () => {
    expect(snapshot(repo)).toBe(snapshot(repo))
  })

  it('tracked file の内容改変を検出', () => {
    const base = snapshot(repo)
    writeFileSync(path.join(repo, 'tracked.txt'), 'modified\n')
    expect(snapshot(repo)).not.toBe(base)
  })

  // Codex P2-① の穴 (a): 既に dirty な file をさらに書き換えても porcelain は ` M` で不変。
  it('既に dirty な file の「さらなる内容改変」を検出', () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty-1\n')
    const s1 = snapshot(repo)
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty-2\n')
    expect(snapshot(repo)).not.toBe(s1)
  })

  // Codex P2-① の穴 (b): 既存 untracked dir 内に新 file を足しても porcelain は `??` で畳まれ不変。
  it('既存 untracked dir 内の新規 file を検出', () => {
    mkdirSync(path.join(repo, 'untracked-dir'))
    writeFileSync(path.join(repo, 'untracked-dir/a.txt'), 'a\n')
    const s1 = snapshot(repo)
    writeFileSync(path.join(repo, 'untracked-dir/b.txt'), 'b\n')
    expect(snapshot(repo)).not.toBe(s1)
  })

  it('非 vacuous: snapshot が実内容を反映する(空/定数でない)', () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'sentinel-XYZ\n')
    expect(snapshot(repo)).toContain('sentinel-XYZ')
  })

  it('repo top-level の untracked file を検出', () => {
    const base = snapshot(repo)
    writeFileSync(path.join(repo, 'top.txt'), 'top\n')
    expect(snapshot(repo)).not.toBe(base)
  })

  // execution-persistence vector: .git/hooks への書込を検出(gitignore 対象外として明示包含)。
  it('.git/hooks への書込(post-commit hook)を検出', () => {
    const base = snapshot(repo)
    writeFileSync(path.join(repo, '.git/hooks/post-commit'), '#!/bin/sh\necho pwned\n')
    expect(snapshot(repo)).not.toBe(base)
  })

  // accepted residual risk を pin: .gitignore 済みパスへの書込は snapshot を変えない(意図的限界)。
  it('gitignore 済み file への書込は snapshot を変えない(documented limitation)', () => {
    writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n')
    sh('git add -A && git commit -q -m gitignore', repo)
    const base = snapshot(repo)
    writeFileSync(path.join(repo, 'ignored.txt'), 'should be invisible\n')
    expect(snapshot(repo)).toBe(base)
  })
})
