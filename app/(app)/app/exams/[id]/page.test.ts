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

describe('page.tsx: ExamDetailView に key={userId} を渡す (S-local-2 Task 3 fix round 1 / Critical fix)', () => {
  it('<ExamDetailView> の JSX に key={userId} が付与されている', () => {
    // userId が live に変わっても (remount なしの internal navigation。app/(app)/app/layout.tsx が
    // persistent layout tree を remount しないため) 前 user の prefs state が新 user の sync_meta
    // namespace に漏れないよう、instance を丸ごと作り直す key={userId} が必須 (canonical review 指摘)。
    // <ExamDetailView> の JSX ブロックのみを切り出して assert する (ファイル全体 grep だと他箇所の
    // "key={userId}" 文字列に誤って一致する可能性を排除するため)。
    const start = pageSource.indexOf('<ExamDetailView')
    expect(start, '<ExamDetailView の JSX が見つからない').toBeGreaterThan(-1)
    const end = pageSource.indexOf('/>', start)
    expect(end, '<ExamDetailView /> の閉じタグが見つからない').toBeGreaterThan(-1)
    const block = pageSource.slice(start, end + 2)
    // `//` 行コメントを除去してから判定する (JSX ブロック内の説明コメントが "key={userId}" と
    // いう文字列そのものに言及していても、実際の prop 行だけを見て判定するため)。
    const blockWithoutLineComments = block
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    expect(
      blockWithoutLineComments,
      'ExamDetailView に key={userId} が無いと、userId 変更時に mount-load effect (deps []) が' +
        '再実行されず前 user の state のまま persist effect が新 user の sync_meta key に書いてしまう',
    ).toContain('key={userId}')
  })
})
