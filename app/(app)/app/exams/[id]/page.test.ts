// S2b-2: page.tsx 戻るリンク撤去 の非回帰テスト。
//
// page.tsx は async server component + 重量依存 (Clerk / Drizzle / Next.js) のため
// jsdom では render 不可。「← 試験一覧」Link が撤去されたことと ExamDetailPullGate が
// 残存することを ソース文字列アサーション で固定する (lightest possible test)。
//
// 根拠: directory には page.tsx の render test が存在せず、async server component を
// jsdom でレンダリングするための重量モックハーネスを新設するのは YAGNI。
// ソースアサーションは「撤去した / まだある」という事実を確実に捕捉できる。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')

describe('page.tsx: S2b-2 戻るリンク撤去', () => {
  it('「← 試験一覧」リンクテキストが page.tsx から削除されている', () => {
    expect(pageSource).not.toContain('← 試験一覧')
  })

  it('ExamDetailPullGate が page.tsx に残存する (null render で副作用のみ)', () => {
    expect(pageSource).toContain('ExamDetailPullGate')
  })
})
