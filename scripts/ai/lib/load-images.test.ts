import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadImageInline } from './load-images'

// allowlist mime 判定 + 未知拡張子 throw を実 file (OS temp dir 配下の使い捨て dir) で
// 検証する。 repo 内 file や外部 fixture には一切触れない・test 後に必ず削除する。

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function writeTempFile(name: string, contents = 'dummy-bytes'): string {
  dir = mkdtempSync(path.join(tmpdir(), 'load-images-test-'))
  const filePath = path.join(dir, name)
  writeFileSync(filePath, contents)
  return filePath
}

describe('loadImageInline', () => {
  it.each([
    ['a.png', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.webp', 'image/webp'],
    ['a.pdf', 'application/pdf'],
  ])('%s → mime "%s" + base64-encoded data', (fileName, expectedMime) => {
    const filePath = writeTempFile(fileName, 'hello-bytes')
    const result = loadImageInline(filePath)
    expect(result.mimeType).toBe(expectedMime)
    expect(result.data).toBe(Buffer.from('hello-bytes').toString('base64'))
  })

  it('拡張子は大文字小文字を区別しない (.PNG も image/png)', () => {
    const filePath = writeTempFile('a.PNG', 'hi')
    const result = loadImageInline(filePath)
    expect(result.mimeType).toBe('image/png')
  })

  it('未知拡張子は throw する (推測しない)', () => {
    const filePath = writeTempFile('a.gif', 'hi')
    expect(() => loadImageInline(filePath)).toThrow(/unsupported extension/)
  })

  it('拡張子が無いファイルも throw する', () => {
    const filePath = writeTempFile('README')
    expect(() => loadImageInline(filePath)).toThrow(/unsupported extension/)
  })
})
