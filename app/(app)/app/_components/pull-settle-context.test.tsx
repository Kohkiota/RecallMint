// @vitest-environment jsdom
// pull-settle-context.test — Provider/hook の機構そのものを pin する
// (Dash-1 Home v1 Task 5・spec §6)。 「何が settle を意味するか」の判断は
// PullTrigger 側の関心事なので、 ここでは markFirstPullSettled を直接呼ぶ小さな
// probe component で検証する(PullTrigger の outcome 分岐ロジックは
// pull-trigger.test.tsx が担当)。

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  PullSettleProvider,
  useFirstPullSettled,
  useMarkFirstPullSettled,
} from './pull-settle-context'

// このファイルの他 test(pull-trigger.test.tsx)と同じ規律: このリポジトリの
// vitest 設定は RTL の自動 cleanup を有効化していないため、test 間で手動 cleanup
// しないと DOM が蓄積し getByTestId/getByRole が「複数要素」で失敗する。
afterEach(() => {
  cleanup()
})

function SettledProbe() {
  const settled = useFirstPullSettled()
  return <div data-testid="settled">{String(settled)}</div>
}

function MarkButton() {
  const mark = useMarkFirstPullSettled()
  return (
    <button type="button" onClick={() => mark()}>
      mark
    </button>
  )
}

describe('PullSettleProvider / useFirstPullSettled', () => {
  it('初期状態は false', () => {
    render(
      <PullSettleProvider>
        <SettledProbe />
      </PullSettleProvider>,
    )
    expect(screen.getByTestId('settled').textContent).toBe('false')
  })

  it('markFirstPullSettled 呼出で true になり、以後 true のまま(冪等 latch)', () => {
    render(
      <PullSettleProvider>
        <SettledProbe />
        <MarkButton />
      </PullSettleProvider>,
    )
    act(() => {
      screen.getByRole('button', { name: 'mark' }).click()
    })
    expect(screen.getByTestId('settled').textContent).toBe('true')

    act(() => {
      screen.getByRole('button', { name: 'mark' }).click()
    })
    expect(screen.getByTestId('settled').textContent).toBe('true')
  })

  it('Provider 不在(context default)では常に false・markFirstPullSettled は no-op で crash しない', () => {
    const probe = render(<SettledProbe />)
    expect(screen.getByTestId('settled').textContent).toBe('false')
    probe.unmount()

    // no-op マーカーを直接呼んでも例外にならないことを確認。
    render(<MarkButton />)
    expect(() =>
      act(() => {
        screen.getByRole('button', { name: 'mark' }).click()
      }),
    ).not.toThrow()
  })
})

describe('PullSettleProvider — user 切替でリセット(critical property)', () => {
  it('key を変えて remount すると、前 user の settled=true を引き継がない', () => {
    const { rerender } = render(
      <PullSettleProvider key="user-a">
        <SettledProbe />
        <MarkButton />
      </PullSettleProvider>,
    )
    act(() => {
      screen.getByRole('button', { name: 'mark' }).click()
    })
    expect(screen.getByTestId('settled').textContent).toBe('true')

    // key 変更 = 新 user への切替を模す(layout.tsx の key={user.id} と同じ契約)。
    rerender(
      <PullSettleProvider key="user-b">
        <SettledProbe />
        <MarkButton />
      </PullSettleProvider>,
    )
    expect(screen.getByTestId('settled').textContent).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// (app)/app/layout.tsx への配線 pin(fix round 2/5・Codex Important I2 是正)
// ---------------------------------------------------------------------------
// 「critical property(user 切替で settled を引き継がない)」は
// `<PullSettleProvider key={user.id}>` の外側配線が実際にそうなっていて初めて
// 成立する。 上の component test は `key` を test 自身が渡しており、layout.tsx が
// user.id を key として渡している**こと自体**は証明しない — `key={user.id}` を
// 消しても、あるいは `<PullSettleProvider>` ごと外して `<PullTrigger>` を元の
// 場所へ戻しても、component test 一式は green のままになる(default context の
// no-op latch が静かに false を返し続けるだけで、消費側にエラーは出ない)。
//
// これは HygieneSweepTrigger の唯一の起動点を pin する
// hygiene-sweep-trigger.test.tsx と同型の source-text pin(修正3 と同じ手法)。
// layout は async server component で getCurrentUser() / DB を巻き込むため RTL
// render は採らない。 **判定前に JSX コメントを除去する**(除去しないと
// `{/* <PullSettleProvider ...> */}` のようなコメントアウトも toContain が
// green を返してしまう)。 JSX の表記(属性順・self-closing 等)を変えると
// 偽陰性になりうるので、 mount の書き方を変えるときは本 pin も更新すること。

function stripJsxComments(source: string): string {
  return source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

describe('(app)/app/layout.tsx への配線(source-text pin)', () => {
  const layoutSourceRaw = readFileSync(
    path.resolve(import.meta.dirname, '../layout.tsx'),
    'utf8',
  )
  const layoutSource = stripJsxComments(layoutSourceRaw)

  it('layout が PullSettleProvider を import して key={user.id} 付きで mount している', () => {
    expect(layoutSource).toContain("from './_components/pull-settle-context'")
    expect(layoutSource).toContain('<PullSettleProvider key={user.id}>')
  })

  it('PullTrigger が PullSettleProvider の内側(descendant)で mount されている', () => {
    const providerStart = layoutSource.indexOf('<PullSettleProvider key={user.id}>')
    const providerEnd = layoutSource.indexOf('</PullSettleProvider>')
    expect(providerStart).toBeGreaterThan(-1)
    expect(providerEnd).toBeGreaterThan(providerStart)

    const triggerIndex = layoutSource.indexOf('<PullTrigger userId={user.id} />')
    expect(triggerIndex).toBeGreaterThan(providerStart)
    expect(triggerIndex).toBeLessThan(providerEnd)
  })
})
