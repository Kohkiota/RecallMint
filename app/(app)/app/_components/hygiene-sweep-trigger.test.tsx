// @vitest-environment jsdom
// HygieneSweepTrigger client component の test(tag mirror hygiene sprint Task 5 /
// spec §5.2)。 sweepForeignLocalData は mock し、 配線(発火単位と失敗の握り潰し)
// のみ verify する。
//
// 観点: mount 1 回 kick / 同 userId の rerender では再 kick しない / userId 変化で
// 新 userId で再 kick(共有ブラウザのアカウント切替が sweep の発火契機そのもの)/
// UI なし / sweep の失敗が上へ漏れない。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const { mockSweep } = vi.hoisted(() => ({ mockSweep: vi.fn(async () => {}) }))

vi.mock('@/lib/sync/local-hygiene', () => ({
  sweepForeignLocalData: mockSweep,
}))

import { HygieneSweepTrigger } from './hygiene-sweep-trigger'

const USER_A = 'user-a'
const USER_B = 'user-b'

beforeEach(() => {
  vi.clearAllMocks()
  mockSweep.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('HygieneSweepTrigger', () => {
  it('mount で sweepForeignLocalData(userId) を 1 回 kick する', async () => {
    render(<HygieneSweepTrigger userId={USER_A} />)

    await waitFor(() => expect(mockSweep).toHaveBeenCalledTimes(1))
    expect(mockSweep).toHaveBeenCalledWith(USER_A)
  })

  it('同じ userId の rerender では再 kick しない', async () => {
    const { rerender } = render(<HygieneSweepTrigger userId={USER_A} />)
    await waitFor(() => expect(mockSweep).toHaveBeenCalledTimes(1))

    rerender(<HygieneSweepTrigger userId={USER_A} />)
    await new Promise((r) => setTimeout(r, 0))

    expect(mockSweep).toHaveBeenCalledTimes(1)
  })

  it('userId が A→B に変わると B で再 kick される(deps が userId 変化に反応する)', async () => {
    const { rerender } = render(<HygieneSweepTrigger userId={USER_A} />)
    await waitFor(() => expect(mockSweep).toHaveBeenCalledTimes(1))

    rerender(<HygieneSweepTrigger userId={USER_B} />)

    await waitFor(() => expect(mockSweep).toHaveBeenCalledTimes(2))
    expect(mockSweep).toHaveBeenLastCalledWith(USER_B)
  })

  it('UI は何も描画しない (null)', () => {
    const { container } = render(<HygieneSweepTrigger userId={USER_A} />)

    expect(container.firstChild).toBeNull()
  })

  it('sweep の失敗は握り潰される(呼出側へ漏れない)', async () => {
    mockSweep.mockRejectedValue(new Error('sweep failed'))
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)

    render(<HygieneSweepTrigger userId={USER_A} />)
    await waitFor(() => expect(mockSweep).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))

    expect(onUnhandled).not.toHaveBeenCalled()
    process.off('unhandledRejection', onUnhandled)
  })
})

// ---------------------------------------------------------------------------
// (app)/app/layout.tsx への mount pin
// ---------------------------------------------------------------------------
// HygieneSweepTrigger の唯一の起動点は (app)/app/layout.tsx の mount であり、これを
// 外しても component 単体 test / typecheck / lint / build は全 green のまま通る
// (参照が layout.tsx と本 test だけのため)。 起動点そのものを pin する
// (repo 教訓「唯一の caller が未 pin」/ sign-out-purge.test.tsx と同型)。
//
// **これは source-text マッチによる pin**。 layout は async server component で
// getCurrentUser() / DB を巻き込むため RTL render は採らない。 JSX の表記
// (self-closing / 属性 / import 経路)を変えると偽陰性になりうるので、 mount の
// 書き方を変えるときは本 pin も更新すること。

describe('(app)/app/layout.tsx への mount(source-text pin)', () => {
  const layoutSource = readFileSync(
    path.resolve(import.meta.dirname, '../layout.tsx'),
    'utf8',
  )

  it('layout が HygieneSweepTrigger を import して user.id 付きで mount している', () => {
    expect(layoutSource).toContain("from './_components/hygiene-sweep-trigger'")
    expect(layoutSource).toContain('<HygieneSweepTrigger userId={user.id} />')
  })
})
