// @vitest-environment jsdom
// DailyNewTargetField の test (Dash-1 Home v1 spec §8.1)。
//
// 検証観点:
// - 初期値: Dexie mirror (db.exams) の daily_new_target を表示する。 null/undefined は
//   空欄 (既定追従)、 0 は "0" のまま (空欄に潰れない)。
// - 既定値の表示 (空欄が何を意味するかの説明)。
// - 空欄で保存 → updateDailyNewTarget(examId, null)。
// - 0 で保存 → updateDailyNewTarget(examId, 0) (null にすり替わらない — || 混入 pin)。
// - 保存成功 → runGuardedPull kick + 成功 message。
// - 保存失敗 (ok:false / reject) → silent success にせず inline error で表面化する。
// - mirror 追従: 外部 (pull) が動いた時だけ表示を差し替える。 保存直後に mirror がまだ
//   旧値でも巻き戻さない / 未編集なら外部更新に追従する / 編集中は上書きしない。
//
// getClientDb() は実 Dexie (fake-indexeddb、 exam-list-live.test.tsx と同方針)。
// mock するのは server action (updateDailyNewTarget) と runGuardedPull のみ。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { getClientDb, type ClientExam } from '@/lib/client-db'
import { DAILY_NEW_DEFAULT } from '@/lib/dashboard/domain/metric-constants'

const { mockUpdateDailyNewTarget, mockRunGuardedPull } = vi.hoisted(() => ({
  mockUpdateDailyNewTarget: vi.fn(),
  mockRunGuardedPull: vi.fn().mockResolvedValue('ran'),
}))

vi.mock('@/app/(app)/app/exams/_actions/update-daily-new-target', () => ({
  updateDailyNewTarget: mockUpdateDailyNewTarget,
}))

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))

import { DailyNewTargetField } from './daily-new-target-field'

const EXAM_ID = 'exam-1'
const USER_A = 'user-a'

function fakeExam(overrides?: Partial<ClientExam>): ClientExam {
  return {
    id: EXAM_ID,
    user_id: USER_A,
    name: 'テスト試験',
    content_version: 1,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-10T00:00:00.000Z',
    ...overrides,
  }
}

async function seedExam(overrides?: Partial<ClientExam>) {
  const db = getClientDb()
  await db.exams.put(fakeExam(overrides))
}

function renderField() {
  return render(<DailyNewTargetField examId={EXAM_ID} userId={USER_A} />)
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockUpdateDailyNewTarget.mockResolvedValue({ ok: true })
  mockRunGuardedPull.mockResolvedValue('ran')
  const db = getClientDb()
  await db.exams.clear()
})

afterEach(() => {
  cleanup()
})

describe('DailyNewTargetField — 初期表示', () => {
  it('daily_new_target が null → 入力は空欄 (既定追従)', async () => {
    await seedExam({ daily_new_target: null })
    renderField()
    await waitFor(() => {
      expect(
        (screen.getByRole('spinbutton', { name: '新規/日の上限' }) as HTMLInputElement)
          .value,
      ).toBe('')
    })
  })

  it('daily_new_target が undefined (旧行 field 欠落) → 入力は空欄 (既定追従)', async () => {
    // ClientExam.daily_new_target は optional。 明示的に欠落させて legacy row を模す。
    const db = getClientDb()
    const { daily_new_target: _omit, ...withoutField } = fakeExam()
    await db.exams.put(withoutField as ClientExam)
    renderField()
    await waitFor(() => {
      expect(
        (screen.getByRole('spinbutton', { name: '新規/日の上限' }) as HTMLInputElement)
          .value,
      ).toBe('')
    })
  })

  it('daily_new_target が 0 → 入力は "0" のまま (空欄に潰れない)', async () => {
    await seedExam({ daily_new_target: 0 })
    renderField()
    await waitFor(() => {
      expect(
        (screen.getByRole('spinbutton', { name: '新規/日の上限' }) as HTMLInputElement)
          .value,
      ).toBe('0')
    })
  })

  it('daily_new_target が数値 → その値を表示', async () => {
    await seedExam({ daily_new_target: 15 })
    renderField()
    await waitFor(() => {
      expect(
        (screen.getByRole('spinbutton', { name: '新規/日の上限' }) as HTMLInputElement)
          .value,
      ).toBe('15')
    })
  })

  it('compact variant では既定値の説明文を出さない (table chrome は密度優先)', async () => {
    await seedExam({ daily_new_target: null })
    render(<DailyNewTargetField examId={EXAM_ID} userId={USER_A} variant="compact" />)
    await waitFor(() => {
      expect(
        screen.getByRole('spinbutton', { name: '新規/日の上限' }),
      ).toBeInTheDocument()
    })
    expect(screen.queryByText(`空欄で既定 ${DAILY_NEW_DEFAULT} 問`)).toBeNull()
    // 空欄の意味は placeholder が担う (説明文を消したぶんの代替)。
    expect(
      screen.getByRole('spinbutton', { name: '新規/日の上限' }),
    ).toHaveAttribute('placeholder', String(DAILY_NEW_DEFAULT))
  })

  it('既定値を明示する説明文を表示する', async () => {
    await seedExam({ daily_new_target: null })
    renderField()
    await waitFor(() => {
      expect(
        screen.getByText(`空欄で既定 ${DAILY_NEW_DEFAULT} 問`),
      ).toBeInTheDocument()
    })
  })
})

describe('DailyNewTargetField — mirror 読込中', () => {
  it('読込中は保存できない (空欄のまま保存して server の K を潰さない)', () => {
    // useLiveQuery の初回 render は必ず undefined (= 読込中)。 この時点の表示は
    // 「空欄 = 既定へ戻す」に見えるため、 保存できると既存 K を null で上書きする。
    // seed していないので、 解決後は「行不在」— 読込中と行不在の区別が要る所以。
    renderField()
    const button = screen.getByRole('button', { name: '保存' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(mockUpdateDailyNewTarget).not.toHaveBeenCalled()
  })

  it('検出器: 読込が終われば保存できる', async () => {
    await seedExam({ daily_new_target: 30 })
    renderField()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '保存' })).toBeEnabled(),
    )
  })

  it('行が mirror に無い間は (query 解決後も) 保存できない', async () => {
    // 実害が大きいのはこちら: fresh browser / IndexedDB クリア / 詳細への deep link では
    // 行が届く前に画面が出る。 現在の K を知らないまま空欄で保存すると server の K を潰す。
    // 初回 pull の settle は「成功/失敗を問わない終了」なので、 pull 失敗端末では
    // 行が無いまま立つ = 条件に使えない (Codex r2 P1)。
    renderField() // seed しない = 行が来ていない状態
    // 下の対照 test は同じ待ち時間で有効化されるので、 ここでの無効は
    // 「まだ query が解決していないから」ではない。
    await new Promise((r) => setTimeout(r, 30))
    const button = screen.getByRole('button', { name: '保存' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(mockUpdateDailyNewTarget).not.toHaveBeenCalled()
  })

  it('検出器: 行が届けば保存できる', async () => {
    await seedExam({ daily_new_target: null })
    renderField()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '保存' })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mockUpdateDailyNewTarget).toHaveBeenCalled())
  })
})

describe('DailyNewTargetField — 保存', () => {
  it('空欄で保存 → updateDailyNewTarget(examId, null)', async () => {
    await seedExam({ daily_new_target: 10 })
    renderField()
    const input = await screen.findByRole('spinbutton', { name: '新規/日の上限' })
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('10'))

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(mockUpdateDailyNewTarget).toHaveBeenCalledWith(EXAM_ID, null)
    })
  })

  it('0 を入力して保存 → updateDailyNewTarget(examId, 0) (null にすり替わらない)', async () => {
    await seedExam({ daily_new_target: null })
    renderField()
    const input = await screen.findByRole('spinbutton', { name: '新規/日の上限' })
    // findBy は「要素の存在」で解決するため、 読込完了 (= 保存可能) まで明示的に待つ。
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '保存' })).toBeEnabled(),
    )

    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(mockUpdateDailyNewTarget).toHaveBeenCalledWith(EXAM_ID, 0)
    })
    // strict 比較: null が渡っていたら上の toHaveBeenCalledWith(EXAM_ID, 0) は落ちる
    // (Vitest の asymmetric 一致は Object.is 相当で 0 と null を区別する) が、
    // 「呼ばれてすらいない」regression も別途排除しておく。
    expect(mockUpdateDailyNewTarget).toHaveBeenCalledTimes(1)
  })

  it('保存成功 → runGuardedPull kick + 成功 message', async () => {
    await seedExam({ daily_new_target: null })
    renderField()
    const input = await screen.findByRole('spinbutton', { name: '新規/日の上限' })
    // findBy は「要素の存在」で解決するため、 読込完了 (= 保存可能) まで明示的に待つ。
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '保存' })).toBeEnabled(),
    )

    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('保存しました')
    })
    expect(mockRunGuardedPull).toHaveBeenCalledWith({
      userId: USER_A,
      reason: 'exam-daily-new-target',
    })
  })

  it('保存失敗 (ok:false) → silent success にせず server の error 文言を alert で表示', async () => {
    mockUpdateDailyNewTarget.mockResolvedValueOnce({
      ok: false,
      error: '試験が見つかりませんでした。画面を再読み込みしてください。',
    })
    await seedExam({ daily_new_target: null })
    renderField()
    const input = await screen.findByRole('spinbutton', { name: '新規/日の上限' })
    // findBy は「要素の存在」で解決するため、 読込完了 (= 保存可能) まで明示的に待つ。
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '保存' })).toBeEnabled(),
    )

    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      '試験が見つかりませんでした。画面を再読み込みしてください。',
    )
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
  })

  it('action が reject → unhandled にせず inline error に落とす', async () => {
    mockUpdateDailyNewTarget.mockRejectedValueOnce(new Error('offline'))
    await seedExam({ daily_new_target: null })
    renderField()
    const input = await screen.findByRole('spinbutton', { name: '新規/日の上限' })
    // findBy は「要素の存在」で解決するため、 読込完了 (= 保存可能) まで明示的に待つ。
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '保存' })).toBeEnabled(),
    )

    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      '新規/日の上限の変更に失敗しました。しばらくしてから再度お試しください。',
    )
  })
})

describe('DailyNewTargetField — mirror 追従', () => {
  const input = () =>
    screen.getByRole('spinbutton', { name: '新規/日の上限' }) as HTMLInputElement

  it('保存成功後、 mirror がまだ旧値でも入力は保存値を保つ (旧値へ巻き戻らない)', async () => {
    // pull が skip / 失敗して mirror が追いつかない状況 (runGuardedPull の skip は通常経路)。
    await seedExam({ daily_new_target: 10 })
    renderField()
    await waitFor(() => expect(input().value).toBe('10'))

    fireEvent.change(input(), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('保存しました')
    })

    // mirror は 10 のまま。 "保存しました" と表示値が食い違ってはならない。
    expect(await getClientDb().exams.get(EXAM_ID)).toMatchObject({
      daily_new_target: 10,
    })
    expect(input().value).toBe('30')
  })

  it('保存 → mirror が追いつく → その後の外部更新にも追従する (観測値の記録が続く)', async () => {
    await seedExam({ daily_new_target: 10 })
    renderField()
    await waitFor(() => expect(input().value).toBe('10'))

    fireEvent.change(input(), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('保存しました')
    })

    // pull が保存値を運んでくる (表示は 30 のまま)。
    await getClientDb().exams.update(EXAM_ID, { daily_new_target: 30 })
    await waitFor(() => expect(input().value).toBe('30'))

    // さらに他端末由来の変更が届いたら追従が回復していること。
    await getClientDb().exams.update(EXAM_ID, { daily_new_target: 40 })
    await waitFor(() => expect(input().value).toBe('40'))
  })

  it('未編集のまま mirror が外部更新 → 表示が追従する', async () => {
    await seedExam({ daily_new_target: 10 })
    renderField()
    await waitFor(() => expect(input().value).toBe('10'))

    await getClientDb().exams.update(EXAM_ID, { daily_new_target: 40 })

    await waitFor(() => expect(input().value).toBe('40'))
  })

  it('入力を編集した状態で mirror が外部更新 → 編集中の入力を上書きしない', async () => {
    // 「上書きしない」は不在の主張なので、 mirror 変更が component に届いたことを
    // 別途観測しないと pin にならない (待たずに assert すると伝播前に通ってしまう)。
    // 未編集の 2 個目を同時 render し、 そちらが 40 に追従したことを伝播の検出器に使う。
    await seedExam({ daily_new_target: 10 })
    render(
      <>
        <DailyNewTargetField examId={EXAM_ID} userId={USER_A} />
        <DailyNewTargetField examId={EXAM_ID} userId={USER_A} />
      </>,
    )
    const fields = () =>
      screen.getAllByRole('spinbutton', {
        name: '新規/日の上限',
      }) as HTMLInputElement[]
    await waitFor(() => expect(fields().map((f) => f.value)).toEqual(['10', '10']))

    fireEvent.change(fields()[0], { target: { value: '45' } })
    await getClientDb().exams.update(EXAM_ID, { daily_new_target: 40 })

    // 検出器 (未編集側) が追従した = 同じ mirror 変更が編集中側にも届いている。
    await waitFor(() => expect(fields()[1].value).toBe('40'))
    expect(fields()[0].value).toBe('45')
  })
})
