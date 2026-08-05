// ②-4a 単一 invocation Sprint Task S-1: submitUpload の「tx に入る前」の責務
// (認証 → FormData parse → 入力検証)と、maxDuration drift pin の unit 検証。
//
// 入力検証は 1 tx(submitUploadTx)より手前で行う契約(brief ①)ゆえ、DB を
// 一切張らずに境界を pin できる — withTenantTx を mock し「tx に到達しない」
// ことを assert することで、検証が本当に前段で効いていることを示す。
//
// tx 本体(advisory lock / 冪等 replay / live-op gate / daily cap / 行作成)の
// 検証は実 PG が要るため tests/integration/pg/submit-upload.test.ts が担う。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { MAX_ASSET_BYTES } from '@/app/(app)/app/exams/[id]/_actions/asset-limits'
import {
  LEASE_TTL_MS,
  TOTAL_UPLOAD_LIMIT_BYTES,
  UPLOAD_PIPELINE_BUDGET_MS,
} from '../_lib/constants'

const {
  mockGetCurrentUser,
  mockWithTenantTx,
  mockRunUploadPipeline,
  mockAbsorbUploadPipelineFailure,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockWithTenantTx: vi.fn(),
  mockRunUploadPipeline: vi.fn(),
  mockAbsorbUploadPipelineFailure: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({ getCurrentUser: mockGetCurrentUser }))
vi.mock('@/lib/db/tenant-tx', () => ({ withTenantTx: mockWithTenantTx }))
// OCR phase 本体(S-2)は tests/integration/pg/upload-pipeline.test.ts で検証する。
// ここで見るのは action → pipeline の受け渡し契約だけ。
vi.mock('../_lib/upload-pipeline', () => ({
  runUploadPipeline: mockRunUploadPipeline,
  absorbUploadPipelineFailure: mockAbsorbUploadPipelineFailure,
}))

// vi.mock は import より前に hoist される。
import { submitUpload } from './submit-upload'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function imageFile(name: string, byteSize: number): File {
  const bytes = Buffer.alloc(byteSize)
  Buffer.from(PNG_MAGIC).copy(bytes, 0)
  return new File([bytes], name, { type: 'image/png' })
}

// magic bytes が PNG/JPEG/WebP のいずれでもない file(client 申告 mime は image/png
// を騙る)。 mime 申告ではなく先頭バイトで弾くことの pin。
function fakeMagicFile(name: string): File {
  const bytes = Buffer.from('GIF89a-not-an-allowed-image-format', 'utf8')
  return new File([bytes], name, { type: 'image/png' })
}

function buildFormData(
  files: File[],
  fields: { idempotencyKey?: string | null; mode?: string | null; examId?: string } = {},
): FormData {
  const fd = new FormData()
  const key = 'idempotencyKey' in fields ? fields.idempotencyKey : 'idem-unit-1'
  const mode = 'mode' in fields ? fields.mode : 'new'
  if (typeof key === 'string') fd.set('idempotencyKey', key)
  if (typeof mode === 'string') fd.set('mode', mode)
  if (fields.examId !== undefined) fd.set('examId', fields.examId)
  for (const f of files) fd.append('files', f)
  return fd
}

function acceptedTx(
  overrides: { replayed?: boolean; leaseVersion?: number } = {},
): Record<string, unknown> {
  return {
    outcome: 'accepted',
    operationId: 'op-1',
    examId: 'exam-1',
    sourceDocumentId: 'doc-1',
    replayed: overrides.replayed ?? false,
    leaseVersion: overrides.leaseVersion ?? 0,
  }
}

async function expectInvalidInput(formData: FormData): Promise<string> {
  const result = await submitUpload(formData)
  expect(result.outcome).toBe('invalid_input')
  if (result.outcome !== 'invalid_input') throw new Error('unreachable')
  // 前段で弾けている = tx を一度も張っていない(検証が tx 手前で効いている証拠)。
  expect(mockWithTenantTx).not.toHaveBeenCalled()
  return result.error
}

describe('submitUpload — 入力検証(tx 手前)', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset()
    mockWithTenantTx.mockReset()
    mockRunUploadPipeline.mockReset()
    mockRunUploadPipeline.mockResolvedValue(undefined)
    mockAbsorbUploadPipelineFailure.mockReset()
    mockAbsorbUploadPipelineFailure.mockResolvedValue(undefined)
    mockGetCurrentUser.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001' })
  })

  it('未認証(getCurrentUser が UnauthenticatedError)は unauthenticated を返す', async () => {
    mockGetCurrentUser.mockRejectedValue(new UnauthenticatedError())
    const result = await submitUpload(buildFormData([imageFile('a.png', 100)]))
    expect(result).toEqual({ outcome: 'unauthenticated' })
    expect(mockWithTenantTx).not.toHaveBeenCalled()
  })

  it('idempotencyKey 欠落は invalid_input', async () => {
    const error = await expectInvalidInput(
      buildFormData([imageFile('a.png', 100)], { idempotencyKey: null }),
    )
    expect(error).toContain('入力内容が正しくありません')
  })

  it('mode 欠落は invalid_input', async () => {
    const error = await expectInvalidInput(
      buildFormData([imageFile('a.png', 100)], { mode: null }),
    )
    expect(error).toContain('投入先が指定されていません')
  })

  it('mode=existing で examId 欠落は invalid_input', async () => {
    const error = await expectInvalidInput(
      buildFormData([imageFile('a.png', 100)], { mode: 'existing' }),
    )
    expect(error).toContain('既存の試験が選択されていません')
  })

  it('file 0 件は invalid_input', async () => {
    const error = await expectInvalidInput(buildFormData([]))
    expect(error).toContain('ファイルが選択されていません')
  })

  it(`${OCR_MAX_PAGES + 1} 枚は invalid_input(件数上限 ${OCR_MAX_PAGES})`, async () => {
    const files = Array.from({ length: OCR_MAX_PAGES + 1 }, (_, i) =>
      imageFile(`p${i}.png`, 100),
    )
    const error = await expectInvalidInput(buildFormData(files))
    expect(error).toContain(`合計 ${OCR_MAX_PAGES} 件`)
  })

  it('1 file が 5 MiB + 1 byte は invalid_input(合計上限より先に per-file 上限で弾く)', async () => {
    const error = await expectInvalidInput(
      buildFormData([imageFile('big.png', MAX_ASSET_BYTES + 1)]),
    )
    expect(error).toContain('1 ファイルのサイズ上限')
  })

  it('合計が 4MB + 1 byte は invalid_input', async () => {
    const half = TOTAL_UPLOAD_LIMIT_BYTES / 2
    const error = await expectInvalidInput(
      buildFormData([imageFile('a.png', half), imageFile('b.png', half + 1)]),
    )
    expect(error).toContain('合計サイズは')
  })

  it('magic bytes が PNG/JPEG/WebP でない file は invalid_input(申告 mime を信用しない)', async () => {
    const error = await expectInvalidInput(buildFormData([fakeMagicFile('fake.png')]))
    expect(error).toContain('対応していない画像形式')
  })

  it('境界の内側(40 枚 / 合計ちょうど 4MB / 各 5 MiB 以下)は tx に到達する', async () => {
    const perFile = TOTAL_UPLOAD_LIMIT_BYTES / OCR_MAX_PAGES
    const files = Array.from({ length: OCR_MAX_PAGES }, (_, i) =>
      imageFile(`p${i}.png`, perFile),
    )
    expect(files.reduce((s, f) => s + f.size, 0)).toBe(TOTAL_UPLOAD_LIMIT_BYTES)

    mockWithTenantTx.mockResolvedValueOnce(acceptedTx())

    const result = await submitUpload(buildFormData(files))
    expect(result).toEqual({
      outcome: 'accepted',
      operationId: 'op-1',
      examId: 'exam-1',
      sourceDocumentId: 'doc-1',
      replayed: false,
    })
    // sync phase の tx は 1 本(OCR phase 以降の DB 書込は pipeline の内部責務)。
    expect(mockWithTenantTx).toHaveBeenCalledTimes(1)
    expect(mockRunUploadPipeline).toHaveBeenCalledTimes(1)
  })

  it('replay(replayed=true)では OCR phase を実行しない(Gemini を再実行しない)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx({ replayed: true }))

    const result = await submitUpload(buildFormData([imageFile('a.png', 100)]))
    expect(result).toMatchObject({ outcome: 'accepted', replayed: true })
    expect(mockWithTenantTx).toHaveBeenCalledTimes(1)
    expect(mockRunUploadPipeline).not.toHaveBeenCalled()
  })

  it('pipeline には実バイトの Buffer を渡す(File / FormData を渡さない)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx({ leaseVersion: 7 }))
    const a = imageFile('a.png', 100)
    const b = imageFile('b.png', 120)
    const before = Date.now()

    await submitUpload(buildFormData([a, b]))

    expect(mockRunUploadPipeline).toHaveBeenCalledTimes(1)
    const [userId, refs, leaseVersion, files, deadlineAt] = mockRunUploadPipeline.mock.calls[0]
    expect(userId).toBe('00000000-0000-4000-8000-000000000001')
    expect(refs).toEqual({
      operationId: 'op-1',
      examId: 'exam-1',
      sourceDocumentId: 'doc-1',
    })
    // lease_version は client を往復させず tx の戻り値から直接引き継ぐ。
    expect(leaseVersion).toBe(7)
    expect(files).toHaveLength(2)
    for (const [i, file] of [a, b].entries()) {
      expect(Buffer.isBuffer(files[i].buffer)).toBe(true)
      expect(files[i].buffer.equals(Buffer.from(await file.arrayBuffer()))).toBe(true)
      expect(files[i].filename).toBe(file.name)
      expect(files[i]).not.toHaveProperty('file')
    }
    // 予算の起点は action 入口(sync tx の消費分も予算内)。
    const deadlineMs = (deadlineAt as Date).getTime()
    expect(deadlineMs).toBeGreaterThanOrEqual(before + UPLOAD_PIPELINE_BUDGET_MS)
    expect(deadlineMs).toBeLessThanOrEqual(Date.now() + UPLOAD_PIPELINE_BUDGET_MS)
  })

  it('Buffer 実体化が失敗しても 500 化せず terminal 化に落とす(no-throw envelope)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx({ leaseVersion: 2 }))
    const broken = imageFile('a.png', 100)
    // request body の読み出しが途中で切れた等(到達可能性は低いが契約の穴)。
    vi.spyOn(broken, 'arrayBuffer').mockRejectedValue(new Error('body stream aborted'))

    const result = await submitUpload(buildFormData([broken]))

    expect(result.outcome).toBe('accepted')
    expect(mockRunUploadPipeline).not.toHaveBeenCalled()
    expect(mockAbsorbUploadPipelineFailure).toHaveBeenCalledTimes(1)
    const [userId, refs, leaseVersion, err] = mockAbsorbUploadPipelineFailure.mock.calls[0]
    expect(userId).toBe('00000000-0000-4000-8000-000000000001')
    expect(refs).toEqual({
      operationId: 'op-1',
      examId: 'exam-1',
      sourceDocumentId: 'doc-1',
    })
    expect(leaseVersion).toBe(2)
    expect((err as Error).message).toBe('body stream aborted')
  })

  it('action の戻り値に lease_version を含めない(client 往復の廃止)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx({ leaseVersion: 3 }))

    const result = await submitUpload(buildFormData([imageFile('a.png', 100)]))
    expect(result).not.toHaveProperty('leaseVersion')
    expect(Object.keys(result).sort()).toEqual([
      'examId',
      'operationId',
      'outcome',
      'replayed',
      'sourceDocumentId',
    ])
  })

  it('FormData でない payload は 500 化せず invalid_input(Server Action 引数は untrusted)', async () => {
    const result = await submitUpload(
      null as unknown as FormData,
    )
    expect(result).toEqual({
      outcome: 'invalid_input',
      error: '入力内容が正しくありません',
    })
    expect(mockWithTenantTx).not.toHaveBeenCalled()
  })
})

describe('submit-upload.ts は R2 module を import しない(spec §2: source は R2 に置かない)', () => {
  it('source 上に @/lib/storage/r2 への import が存在しない', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, 'submit-upload.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/from\s+['"][^'"]*lib\/storage\/r2['"]/)
  })
})

// ---------------------------------------------------------------------------
// maxDuration drift pin(plan 設計決着: literal 維持 + fs+regex 型の pin test)
// ---------------------------------------------------------------------------
// page.tsx を import せず readFileSync + regex で読む理由: page.tsx は
// UploadForm(client component / Dexie)を transitive import するため、値 1 つを
// 読むためだけに client 側 module 一式を vitest へ引き込むことになる。
describe('/app/upload page.tsx の maxDuration', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '../page.tsx'),
    'utf8',
  )
  const matched = source.match(/^export const maxDuration = (\d+)$/m)

  it('export const maxDuration の行が存在する', () => {
    // 行が消えると Vercel Dashboard の Function Max Duration(既定値)に黙って
    // 戻り、lease(15 分)に対する余裕が縮む。値の不一致と同格の失敗として扱う。
    expect(matched).not.toBeNull()
  })

  it('値が 720 である', () => {
    expect(matched).not.toBeNull()
    expect(Number(matched![1])).toBe(720)
  })

  it('maxDuration + margin 180s が lease TTL を超えない', () => {
    expect(matched).not.toBeNull()
    // margin 180s = OT 決定「720 なら余裕 3 分」の明文化。invocation が
    // maxDuration いっぱい走っても lease が先に失効しないことが不変条件。
    expect(Number(matched![1]) * 1000 + 180_000).toBeLessThanOrEqual(LEASE_TTL_MS)
  })

  it('統合 time budget が maxDuration より短い', () => {
    expect(matched).not.toBeNull()
    // 予算が maxDuration 以上になると「自前 terminal 化 + log」より先に platform が
    // 関数を打ち切り、失敗理由が operation にも台帳にも残らなくなる。
    expect(UPLOAD_PIPELINE_BUDGET_MS).toBeLessThan(Number(matched![1]) * 1000)
  })
})
