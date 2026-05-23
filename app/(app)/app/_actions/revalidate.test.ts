import { describe, it, expect, vi, beforeEach } from 'vitest'
import { revalidatePath } from 'next/cache'

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

const { mockGetCurrentUser } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

import { revalidateAppPath, type AppPath } from './revalidate'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('revalidateAppPath', () => {
  it('user 不在時は no-op (revalidatePath 不発火)', async () => {
    mockGetCurrentUser.mockResolvedValue(null)
    await revalidateAppPath('/app')
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it.each<AppPath>([
    '/app',
    '/app/settings',
    '/app/upload',
    '/app/exams',
    '/app/study/smart',
    '/app/study/smart/session',
  ])('user 存在時、path=%s で revalidatePath を 1 回呼ぶ', async (path) => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user_1' })
    await revalidateAppPath(path)
    expect(revalidatePath).toHaveBeenCalledTimes(1)
    expect(revalidatePath).toHaveBeenCalledWith(path)
  })
})
