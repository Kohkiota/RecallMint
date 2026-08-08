// ②-4a 単一 invocation Sprint Task S-1: submitUpload の「tx に入る前」の責務
// (認証 → FormData parse → 入力検証)と、maxDuration drift pin の unit 検証。
//
// 入力検証は 1 tx(submitUploadTx)より手前で行う契約(brief ①)ゆえ、DB を
// 一切張らずに境界を pin できる — withTenantTx を mock し「tx に到達しない」
// ことを assert することで、検証が本当に前段で効いていることを示す。
//
// tx 本体(advisory lock / 冪等 replay / live-op gate / daily cap / 行作成)の
// 検証は実 PG が要るため tests/integration/pg/submit-upload.test.ts が担う。
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { MAX_ASSET_BYTES } from '@/app/(app)/app/exams/[id]/_actions/asset-limits'
import {
  LEASE_TTL_MS,
  MAX_PDF_BYTES,
  MAX_PDF_TOTAL_BYTES,
  TOTAL_UPLOAD_LIMIT_BYTES,
  UPLOAD_PIPELINE_BUDGET_MS,
} from '../_lib/constants'

const {
  mockGetCurrentUser,
  mockWithTenantTx,
  mockRunUploadPipeline,
  mockAbsorbUploadPipelineFailure,
  mockAfter,
  mockRecordIntegrationFailure,
  mockLoggerError,
  mockHeadObject,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockWithTenantTx: vi.fn(),
  mockRunUploadPipeline: vi.fn(),
  mockAbsorbUploadPipelineFailure: vi.fn(),
  mockAfter: vi.fn(),
  mockRecordIntegrationFailure: vi.fn(),
  mockLoggerError: vi.fn(),
  mockHeadObject: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({ getCurrentUser: mockGetCurrentUser }))
vi.mock('@/lib/db/tenant-tx', () => ({ withTenantTx: mockWithTenantTx }))
// S-4: 本処理は `after()` に載る。実物の `after` は request scope の外(vitest)では
// 必ず throw する仕様(next/dist/server/after: workStore が無ければ E468)なので、
// 「登録された callback」を捕まえて test 側から明示的に走らせる形にする。
// 登録失敗の分岐は mockAfter.mockImplementationOnce(throw) で個別に注入する。
vi.mock('next/server', () => ({ after: mockAfter }))
// after() 境界の防波堤が best-effort 記録に使う 2 面。
vi.mock('@/lib/integration-failures', () => ({
  recordIntegrationFailure: mockRecordIntegrationFailure,
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: mockLoggerError, info: vi.fn() },
}))
// ②-4b T7: submit-upload.ts が R2 に触れるのは PDF 経路の headObject(pre-tx 検証・
// spec D6 層 2)だけ。他の export は無いダミーにし、誤って追加 import されたら
// 実行時に落ちて気付ける形にする(regex pin と二重に担保)。
vi.mock('@/lib/storage/r2', () => ({ headObject: mockHeadObject }))
// pipeline 本体(S-2/S-3)は tests/integration/pg/upload-pipeline.test.ts で検証する。
// ここで見るのは action → pipeline の受け渡し契約だけ。
vi.mock('../_lib/upload-pipeline', () => ({
  runUploadPipeline: mockRunUploadPipeline,
  absorbUploadPipelineFailure: mockAbsorbUploadPipelineFailure,
}))

// vi.mock は import より前に hoist される。
import { submitUpload } from './submit-upload'

// after() に登録された callback。 submitUpload の応答後に platform が走らせる分を
// test が明示的に再現する。
let afterTasks: Array<() => unknown>

async function runAfterTasks(): Promise<void> {
  const tasks = afterTasks
  afterTasks = []
  for (const task of tasks) await task()
}

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

// ---------------------------------------------------------------------------
// ②-4b T7: orderManifest 分岐(PDF 経路)の unit test 用 helper。
// ---------------------------------------------------------------------------
const UPLOAD_SESSION_ID = '11111111-1111-4111-8111-111111111111'
const PDF_FILE_ID_A = '22222222-2222-4222-8222-222222222222'
const PDF_FILE_ID_B = '33333333-3333-4333-8333-333333333333'

type ManifestEntry =
  | { kind: 'image'; fileIndex: number }
  | {
      kind: 'pdf'
      fileId: string
      filename: string
      pageCount: number
      declaredBytes: number
    }

function pdfManifestEntry(
  overrides: Partial<Extract<ManifestEntry, { kind: 'pdf' }>> = {},
): Extract<ManifestEntry, { kind: 'pdf' }> {
  return {
    kind: 'pdf',
    fileId: PDF_FILE_ID_A,
    filename: 'a.pdf',
    pageCount: 3,
    declaredBytes: 1000,
    ...overrides,
  }
}

// orderManifest(JSON 文字列)+ uploadSessionId を積んだ FormData(spec §3.4 の
// wire 契約どおり両方 top-level field)。`uploadSessionId: null` を渡すと
// field 自体を送らない(未送信のケースを作るため)。
function buildManifestFormData(
  images: File[],
  manifest: ManifestEntry[],
  opts: {
    idempotencyKey?: string | null
    mode?: string | null
    examId?: string
    uploadSessionId?: string | null
  } = {},
): FormData {
  const fd = buildFormData(images, opts)
  fd.set('orderManifest', JSON.stringify(manifest))
  if (opts.uploadSessionId !== null) {
    fd.set('uploadSessionId', opts.uploadSessionId ?? UPLOAD_SESSION_ID)
  }
  return fd
}

// headObject の既定成功応答: manifest 中の全 pdf entry の declaredBytes と一致させる。
function mockHeadObjectVerifiedFor(pdfEntries: Extract<ManifestEntry, { kind: 'pdf' }>[]): void {
  mockHeadObject.mockImplementation(async (key: string) => {
    const entry = pdfEntries.find((e) => key.endsWith(`/${e.fileId}.pdf`))
    if (!entry) return { exists: false, contentLength: null }
    return { exists: true, contentLength: entry.declaredBytes }
  })
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
    mockRecordIntegrationFailure.mockReset()
    mockRecordIntegrationFailure.mockResolvedValue(undefined)
    mockLoggerError.mockReset()
    mockHeadObject.mockReset()
    afterTasks = []
    mockAfter.mockReset()
    mockAfter.mockImplementation((task: () => unknown) => {
      afterTasks.push(task)
    })
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
    await runAfterTasks()
    expect(mockRunUploadPipeline).toHaveBeenCalledTimes(1)
  })

  it('replay(replayed=true)では OCR phase を実行しない(Gemini を再実行しない)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx({ replayed: true }))

    const result = await submitUpload(buildFormData([imageFile('a.png', 100)]))
    expect(result).toMatchObject({ outcome: 'accepted', replayed: true })
    expect(mockWithTenantTx).toHaveBeenCalledTimes(1)
    // after() の登録自体が起きない = 再送のたびに Gemini を再実行しない。
    expect(mockAfter).not.toHaveBeenCalled()
    await runAfterTasks()
    expect(mockRunUploadPipeline).not.toHaveBeenCalled()
  })

  it('pipeline には実バイトの Buffer を渡す(File / FormData を渡さない)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx({ leaseVersion: 7 }))
    const a = imageFile('a.png', 100)
    const b = imageFile('b.png', 120)
    const before = Date.now()

    await submitUpload(buildFormData([a, b]))
    await runAfterTasks()

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
    // 画像のみ経路(orderManifest 不在)は sourceOrder が空(spec §2 の manifest 順
    // 復元は PDF 経路にのみ要る・fix round 1)。
    expect(mockRunUploadPipeline.mock.calls[0][7]).toEqual([])
  })

  it('Buffer 実体化が失敗しても 500 化せず terminal 化に落とす(no-throw envelope)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx({ leaseVersion: 2 }))
    const broken = imageFile('a.png', 100)
    // request body の読み出しが途中で切れた等(到達可能性は低いが契約の穴)。
    vi.spyOn(broken, 'arrayBuffer').mockRejectedValue(new Error('body stream aborted'))

    const result = await submitUpload(buildFormData([broken]))
    await runAfterTasks()

    expect(result.outcome).toBe('accepted')
    expect(mockAfter).not.toHaveBeenCalled()
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

// ---------------------------------------------------------------------------
// ②-4b T7: orderManifest 分岐(PDF 経路)。spec §3.4 / D6 / D7。
// ---------------------------------------------------------------------------
describe('submitUpload — orderManifest 分岐(PDF 経路・T7)', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset()
    mockWithTenantTx.mockReset()
    mockRunUploadPipeline.mockReset()
    mockRunUploadPipeline.mockResolvedValue(undefined)
    mockAbsorbUploadPipelineFailure.mockReset()
    mockAbsorbUploadPipelineFailure.mockResolvedValue(undefined)
    mockRecordIntegrationFailure.mockReset()
    mockRecordIntegrationFailure.mockResolvedValue(undefined)
    mockLoggerError.mockReset()
    mockHeadObject.mockReset()
    afterTasks = []
    mockAfter.mockReset()
    mockAfter.mockImplementation((task: () => unknown) => {
      afterTasks.push(task)
    })
    mockGetCurrentUser.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001' })
  })

  describe('zod strict 検証', () => {
    it('uploadSessionId が uuid v4 でない → invalid_input(headObject を呼ばない)', async () => {
      const entry = pdfManifestEntry()
      mockHeadObjectVerifiedFor([entry])
      const error = await expectInvalidInput(
        buildManifestFormData([], [entry], { uploadSessionId: 'not-a-uuid' }),
      )
      expect(error).toContain('入力内容が正しくありません')
      expect(mockHeadObject).not.toHaveBeenCalled()
    })

    it('PDF fileId が uuid v4 でない → invalid_input', async () => {
      const error = await expectInvalidInput(
        buildManifestFormData([], [pdfManifestEntry({ fileId: 'not-a-uuid' })]),
      )
      expect(error).toContain('入力内容が正しくありません')
      expect(mockHeadObject).not.toHaveBeenCalled()
    })

    it('pageCount が 0 → invalid_input(pageCount ≥ 1)', async () => {
      const error = await expectInvalidInput(
        buildManifestFormData([], [pdfManifestEntry({ pageCount: 0 })]),
      )
      expect(error).toContain('入力内容が正しくありません')
      expect(mockHeadObject).not.toHaveBeenCalled()
    })

    it('declaredBytes が MAX_PDF_BYTES 超過 → invalid_input', async () => {
      const error = await expectInvalidInput(
        buildManifestFormData(
          [],
          [pdfManifestEntry({ declaredBytes: MAX_PDF_BYTES + 1 })],
        ),
      )
      expect(error).toContain('入力内容が正しくありません')
      expect(mockHeadObject).not.toHaveBeenCalled()
    })

    it('空 manifest([])→ invalid_input', async () => {
      const error = await expectInvalidInput(buildManifestFormData([], []))
      expect(error).toContain('入力内容が正しくありません')
      expect(mockHeadObject).not.toHaveBeenCalled()
    })

    // fix round 2(Codex Important・controller 実在確定): 件数上限が無いと、
    // 却下確定の manifest(合計ページ超過)でも headObject が entry 数ぶん fan-out
    // する増幅ベクタになる。schema の `.max(OCR_MAX_PAGES)` がここで発火し、
    // headObject を 1 回も呼ばずに却下されることを pin する。
    it(`entry ${OCR_MAX_PAGES + 1} 件の manifest → invalid_input(headObject を 1 回も呼ばない)`, async () => {
      const entries = Array.from({ length: OCR_MAX_PAGES + 1 }, () =>
        pdfManifestEntry({ fileId: randomUUID(), filename: 'p.pdf', pageCount: 1, declaredBytes: 1 }),
      )
      const error = await expectInvalidInput(buildManifestFormData([], entries))
      expect(error).toContain('入力内容が正しくありません')
      expect(mockHeadObject).not.toHaveBeenCalled()
    })
  })

  describe('完全性(Codex I6)', () => {
    it('同一 fileId の PDF entry が 2 件 → invalid_input(fileId 重複禁止)', async () => {
      const error = await expectInvalidInput(
        buildManifestFormData(
          [],
          [pdfManifestEntry(), pdfManifestEntry({ filename: 'b.pdf' })],
        ),
      )
      expect(error).toContain('入力内容が正しくありません')
    })

    it('image fileIndex が重複 → invalid_input(全単射)', async () => {
      const files = [imageFile('a.png', 100), imageFile('b.png', 100)]
      const error = await expectInvalidInput(
        buildManifestFormData(files, [
          { kind: 'image', fileIndex: 0 },
          { kind: 'image', fileIndex: 0 },
        ]),
      )
      expect(error).toContain('入力内容が正しくありません')
    })

    it('image fileIndex に欠番(FormData files 件数と manifest 件数が不一致)→ invalid_input', async () => {
      const files = [imageFile('a.png', 100), imageFile('b.png', 100), imageFile('c.png', 100)]
      const error = await expectInvalidInput(
        buildManifestFormData(files, [
          { kind: 'image', fileIndex: 0 },
          { kind: 'image', fileIndex: 1 },
        ]),
      )
      expect(error).toContain('入力内容が正しくありません')
    })

    it('image fileIndex が範囲外 → invalid_input', async () => {
      const files = [imageFile('a.png', 100), imageFile('b.png', 100)]
      const error = await expectInvalidInput(
        buildManifestFormData(files, [
          { kind: 'image', fileIndex: 0 },
          { kind: 'image', fileIndex: 5 },
        ]),
      )
      expect(error).toContain('入力内容が正しくありません')
    })
  })

  it('Σ declaredBytes が MAX_PDF_TOTAL_BYTES 超過 → invalid_input(spec D7 r4)', async () => {
    // 各 entry は MAX_PDF_BYTES ちょうど(per-entry zod 上限の境界・pass)。
    // 5 件 × 50MB = 250MB > MAX_PDF_TOTAL_BYTES(200MB)で Σ 上限だけが発火する。
    const entries = Array.from({ length: 5 }, (_, i) =>
      pdfManifestEntry({
        fileId: `4444444${i}-4444-4444-8444-444444444444`,
        filename: `p${i}.pdf`,
        declaredBytes: MAX_PDF_BYTES,
      }),
    )
    expect(entries.reduce((s, e) => s + e.declaredBytes, 0)).toBeGreaterThan(MAX_PDF_TOTAL_BYTES)
    const error = await expectInvalidInput(buildManifestFormData([], entries))
    expect(error).toContain('合計サイズが上限を超えています')
    expect(mockHeadObject).not.toHaveBeenCalled()
  })

  describe('headObject 検証(tx 外)', () => {
    it('R2 に実在しない(exists:false)→ invalid_input', async () => {
      const entry = pdfManifestEntry()
      mockHeadObject.mockResolvedValue({ exists: false, contentLength: null })
      const error = await expectInvalidInput(buildManifestFormData([], [entry]))
      expect(error).toContain('アップロードの検証に失敗しました')
      expect(mockHeadObject).toHaveBeenCalledTimes(1)
    })

    it('contentLength が declaredBytes と不一致 → invalid_input', async () => {
      const entry = pdfManifestEntry({ declaredBytes: 1000 })
      mockHeadObject.mockResolvedValue({ exists: true, contentLength: 999 })
      const error = await expectInvalidInput(buildManifestFormData([], [entry]))
      expect(error).toContain('アップロードの検証に失敗しました')
    })
  })

  it('層 2 却下: 画像枚数 + Σecho pageCount > OCR_MAX_PAGES は行ゼロで却下(tx 未到達・HEAD fan-out 前に却下)', async () => {
    // fix round 2(Codex Important): headObject は mock しない — 層 2 の判定が
    // HEAD より前にあることをこの test 自体が強制する(呼ばれたら mock 未設定で
    // 例外化 = 見逃さない)。
    const entry = pdfManifestEntry({ pageCount: OCR_MAX_PAGES + 1 })
    const error = await expectInvalidInput(buildManifestFormData([], [entry]))
    expect(error).toContain(`合計ページ数は ${OCR_MAX_PAGES} ページまでです`)
    expect(mockHeadObject).not.toHaveBeenCalled()
  })

  it('境界(層 2 の合計ちょうど OCR_MAX_PAGES)は tx に到達する', async () => {
    const entry = pdfManifestEntry({ pageCount: OCR_MAX_PAGES - 1 })
    mockHeadObjectVerifiedFor([entry])
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx())
    const files = [imageFile('a.png', 100)]
    const result = await submitUpload(
      buildManifestFormData(files, [
        { kind: 'image', fileIndex: 0 },
        entry,
      ]),
    )
    expect(result.outcome).toBe('accepted')
    expect(mockWithTenantTx).toHaveBeenCalledTimes(1)
  })

  it('画像 + PDF 混在(有効 manifest)は tx に到達し、pipeline へ pdfFiles + uploadSessionId を渡す', async () => {
    const pdfA = pdfManifestEntry({ fileId: PDF_FILE_ID_A, filename: 'a.pdf', pageCount: 3 })
    const pdfB = pdfManifestEntry({ fileId: PDF_FILE_ID_B, filename: 'b.pdf', pageCount: 2 })
    mockHeadObjectVerifiedFor([pdfA, pdfB])
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx({ leaseVersion: 4 }))
    const files = [imageFile('a.png', 100)]

    const result = await submitUpload(
      buildManifestFormData(files, [
        { kind: 'image', fileIndex: 0 },
        pdfA,
        pdfB,
      ]),
    )
    expect(result.outcome).toBe('accepted')
    expect(mockHeadObject).toHaveBeenCalledTimes(2)

    await runAfterTasks()
    expect(mockRunUploadPipeline).toHaveBeenCalledTimes(1)
    const call = mockRunUploadPipeline.mock.calls[0]
    // [userId, refs, leaseVersion, files, deadlineAt, sourcePdfManifest, uploadSessionId, sourceOrder]
    expect(call[5]).toEqual([
      { fileId: PDF_FILE_ID_A, filename: 'a.pdf', pageCount: 3, declaredBytes: 1000 },
      { fileId: PDF_FILE_ID_B, filename: 'b.pdf', pageCount: 2, declaredBytes: 1000 },
    ])
    expect(call[6]).toBe(UPLOAD_SESSION_ID)
    // manifest 順(image, pdfA, pdfB)がそのまま写っていること(fix round 1 Critical)。
    expect(call[7]).toEqual([
      { kind: 'image', fileIndex: 0 },
      { kind: 'pdf', fileId: PDF_FILE_ID_A },
      { kind: 'pdf', fileId: PDF_FILE_ID_B },
    ])
  })

  // fix round 1(canonical Critical): `files`(画像)/`pdfFiles`(PDF)は disjoint な
  // 2 配列で、画像/PDF が交互に混在した選択順を復元する手段を持たない。境界へ渡す
  // `sourceOrder` が manifest の到着順そのままであることをこの test が pin する
  // (spec §2「manifest 順で合流」/ D3「Gemini parts 順 = 選択順を維持」)。
  it('画像 → PDF → 画像 → PDF の混在順は sourceOrder に manifest 順そのまま反映される', async () => {
    const PDF_FILE_ID_C = '44444444-4444-4444-8444-444444444444'
    const pdfA = pdfManifestEntry({ fileId: PDF_FILE_ID_A, filename: 'a.pdf' })
    const pdfC = pdfManifestEntry({ fileId: PDF_FILE_ID_C, filename: 'c.pdf' })
    mockHeadObjectVerifiedFor([pdfA, pdfC])
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx())
    const files = [imageFile('img0.png', 100), imageFile('img1.png', 100)]

    const result = await submitUpload(
      buildManifestFormData(files, [
        { kind: 'image', fileIndex: 0 },
        pdfA,
        { kind: 'image', fileIndex: 1 },
        pdfC,
      ]),
    )
    expect(result.outcome).toBe('accepted')

    await runAfterTasks()
    expect(mockRunUploadPipeline).toHaveBeenCalledTimes(1)
    const sourceOrder = mockRunUploadPipeline.mock.calls[0][7]
    expect(sourceOrder).toEqual([
      { kind: 'image', fileIndex: 0 },
      { kind: 'pdf', fileId: PDF_FILE_ID_A },
      { kind: 'image', fileIndex: 1 },
      { kind: 'pdf', fileId: PDF_FILE_ID_C },
    ])
  })

  it('PDF のみ(画像 0 件)提出は tx に到達する(files.length===0 の早期 reject をしない)', async () => {
    const entry = pdfManifestEntry()
    mockHeadObjectVerifiedFor([entry])
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx())
    const result = await submitUpload(buildManifestFormData([], [entry]))
    expect(result.outcome).toBe('accepted')
    expect(mockWithTenantTx).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// S-4: after() 化(即応答 + 本処理は応答後)
// ---------------------------------------------------------------------------
describe('submitUpload — after() 境界(S-4)', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset()
    mockWithTenantTx.mockReset()
    mockRunUploadPipeline.mockReset()
    mockRunUploadPipeline.mockResolvedValue(undefined)
    mockAbsorbUploadPipelineFailure.mockReset()
    mockAbsorbUploadPipelineFailure.mockResolvedValue(undefined)
    mockRecordIntegrationFailure.mockReset()
    mockRecordIntegrationFailure.mockResolvedValue(undefined)
    mockLoggerError.mockReset()
    mockHeadObject.mockReset()
    afterTasks = []
    mockAfter.mockReset()
    mockAfter.mockImplementation((task: () => unknown) => {
      afterTasks.push(task)
    })
    mockGetCurrentUser.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001' })
  })

  it('応答は pipeline の完了を待たない(after() に 1 件登録し、その時点では未実行)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx())

    const result = await submitUpload(buildFormData([imageFile('a.png', 100)]))

    expect(result.outcome).toBe('accepted')
    expect(mockAfter).toHaveBeenCalledTimes(1)
    // 応答を返した時点で pipeline は 1 度も走っていない = 同期 await でない。
    expect(mockRunUploadPipeline).not.toHaveBeenCalled()

    await runAfterTasks()
    expect(mockRunUploadPipeline).toHaveBeenCalledTimes(1)
  })

  it('File の Buffer 化は after() 登録より **前** に完了する(request 由来を closure に残さない)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx())
    const order: string[] = []
    const a = imageFile('a.png', 100)
    const b = imageFile('b.png', 100)
    for (const [name, file] of [['a', a], ['b', b]] as const) {
      const original = file.arrayBuffer.bind(file)
      vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
        order.push(`read:${name}`)
        return original()
      })
    }
    mockAfter.mockImplementation((task: () => unknown) => {
      order.push('after')
      afterTasks.push(task)
    })

    await submitUpload(buildFormData([a, b]))

    // 全 file を読み切ってから登録する。逆順だと応答後に request body を読むことになる。
    expect(order).toEqual(['read:a', 'read:b', 'after'])
  })

  it('after() の **登録** が失敗したら同期側で即 terminal 化する(callback 不実行の穴)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx({ leaseVersion: 5 }))
    mockAfter.mockImplementationOnce(() => {
      throw new Error('after() unavailable')
    })

    const result = await submitUpload(buildFormData([imageFile('a.png', 100)]))

    // client には accepted のまま返す(op は同期側で終端化済み = poll が failed を返す)。
    expect(result.outcome).toBe('accepted')
    expect(mockRunUploadPipeline).not.toHaveBeenCalled()
    // 登録に失敗した = pipeline 内部の catch も after() 境界の catch も発火しない。
    // 同期側の terminal 化がこのクラスの唯一の検出経路。
    expect(mockAbsorbUploadPipelineFailure).toHaveBeenCalledTimes(1)
    const [userId, refs, leaseVersion, err] = mockAbsorbUploadPipelineFailure.mock.calls[0]
    expect(userId).toBe('00000000-0000-4000-8000-000000000001')
    expect(refs).toEqual({
      operationId: 'op-1',
      examId: 'exam-1',
      sourceDocumentId: 'doc-1',
    })
    expect(leaseVersion).toBe(5)
    expect((err as Error).message).toBe('after() unavailable')
  })

  // 境界 catch は「防波堤」であって分類器ではない。ここで確認するのは
  // **best-effort 記録が発火すること**だけ(失敗クラスの assert は置かない —
  // 分類は runUploadPipeline の責務で、二重に持たないのが S-4 の責務分担)。
  it('after() 内で pipeline が throw しても外へ出さず、best-effort 記録だけ行う', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx())
    mockRunUploadPipeline.mockRejectedValueOnce(new Error('no-throw contract broken'))

    await submitUpload(buildFormData([imageFile('a.png', 100)]))
    await expect(runAfterTasks()).resolves.toBeUndefined()

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.after_boundary_failed' }),
    )
    expect(mockRecordIntegrationFailure).toHaveBeenCalledTimes(1)
    const arg = mockRecordIntegrationFailure.mock.calls[0][0]
    expect(arg.key).toBe('ocr_pipeline')
    expect(arg.userId).toBe('00000000-0000-4000-8000-000000000001')
    // PII-free: context は operationId + errorCode のみ(filename / バイトを載せない)。
    expect(arg.context).toEqual({
      operationId: 'op-1',
      errorCode: 'after_boundary_error',
    })
    // 分類は pipeline の責務ゆえ、境界は terminal 化を試みない。
    expect(mockAbsorbUploadPipelineFailure).not.toHaveBeenCalled()
  })

  it('台帳書込にも失敗したら log だけ残して飲む(境界から throw を出さない)', async () => {
    mockWithTenantTx.mockResolvedValueOnce(acceptedTx())
    mockRunUploadPipeline.mockRejectedValueOnce(new Error('boom'))
    mockRecordIntegrationFailure.mockRejectedValueOnce(new Error('ledger down'))

    await submitUpload(buildFormData([imageFile('a.png', 100)]))
    await expect(runAfterTasks()).resolves.toBeUndefined()

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.after_boundary_record_failed' }),
    )
  })
})

// ②-4b T7: 画像経路は R2 を経由しない(spec §2)が、PDF 経路の層 2 は pre-tx の
// HEAD 検証(spec D6)のため R2 に触れる必要がある。「一切 import しない」pin は
// もう成立しないため、「許可 import は headObject のみ」pin へ置換する(brief
// 「regex pin の置換」)— PUT/GET/DELETE を新たに import したら本 test が落ちる。
describe('submit-upload.ts の R2 import は headObject のみ(spec D6 層 2 の HEAD 検証以外は R2 に触れない)', () => {
  it('@/lib/storage/r2 からの import 節が headObject 以外を含まない', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, 'submit-upload.ts'),
      'utf8',
    )
    const match = source.match(
      /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*lib\/storage\/r2['"]/,
    )
    expect(match).not.toBeNull()
    const importedNames = match![1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    expect(importedNames).toEqual(['headObject'])
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
