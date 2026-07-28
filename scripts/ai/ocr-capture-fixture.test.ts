// ocr-capture-fixture.ts の test。 実 API / 実 network は使わない
// (callGeminiRaw / loadImageInline を vi.mock で完全に差し替える)。
// filesystem は実 OS tmpdir(mkdtemp)を使い、 各 test で作成・削除する
// (repo の tests/fixtures/ocr/ には一切書き込まない)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  linkSync,
  unlinkSync,
  type PathLike,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { mockCallGeminiRaw, mockLoadImageInline } = vi.hoisted(() => ({
  mockCallGeminiRaw: vi.fn(),
  mockLoadImageInline: vi.fn(),
}))

vi.mock('./lib/gemini-raw', () => ({
  callGeminiRaw: mockCallGeminiRaw,
}))
vi.mock('./lib/load-images', () => ({
  loadImageInline: mockLoadImageInline,
}))

import {
  runCapture,
  writeFixturePair,
  validateFixtureName,
  type FsDeps,
} from './ocr-capture-fixture'

// parseOcrResponse は zod schema に対し恒等 (未知キーの無い入力なら validate 後も
// 同じ形の値を返す) ため、 期待 JSON をここで別途手計算せず、 CARDS リテラルを
// そのまま pretty-print すれば production の parseOcrResponse(RAW_RESPONSE) 出力と
// 一致する。
const CARDS = [
  {
    title: 'サンプル問題',
    question_text: '問1: 1+1 は?',
    options: [
      { id: 'a', text: '1', is_correct: false },
      { id: 'b', text: '2', is_correct: true },
    ],
    correct_answer_ids: ['b'],
    images: [],
  },
]
const RAW_RESPONSE = JSON.stringify({ cards: CARDS })
const EXPECTED_CARDS_JSON = JSON.stringify(CARDS, null, 2) + '\n'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ocr-capture-fixture-test-'))
}

describe('validateFixtureName', () => {
  it('rejects a name containing a path separator', () => {
    expect(() => validateFixtureName('a/b')).toThrow()
  })

  it('rejects a name that is exactly ".."', () => {
    expect(() => validateFixtureName('..')).toThrow()
  })

  it('rejects a name containing ".." as a segment', () => {
    expect(() => validateFixtureName('foo..bar/..')).toThrow()
  })

  it('rejects an empty name', () => {
    expect(() => validateFixtureName('')).toThrow()
  })

  it('accepts a safe name', () => {
    expect(() => validateFixtureName('mock-exam-page1')).not.toThrow()
  })
})

describe('writeFixturePair', () => {
  let dir: string

  beforeEach(() => {
    dir = makeTmpDir()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the raw response verbatim and the parsed cards as pretty JSON', () => {
    const { responsePath, cardsPath } = writeFixturePair(dir, 'sample', RAW_RESPONSE)

    expect(responsePath).toBe(join(dir, 'sample.response.json'))
    expect(cardsPath).toBe(join(dir, 'sample.expected-cards.json'))
    expect(readFileSync(responsePath, 'utf8')).toBe(RAW_RESPONSE)
    expect(readFileSync(cardsPath, 'utf8')).toBe(EXPECTED_CARDS_JSON)
  })

  it('rejects an unsafe name before touching the filesystem', () => {
    expect(() => writeFixturePair(dir, '../evil', RAW_RESPONSE)).toThrow()
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('throws and does not overwrite when <name>.response.json already exists', () => {
    const responsePath = join(dir, 'sample.response.json')
    writeFileSync(responsePath, 'PRE-EXISTING-RESPONSE')

    expect(() => writeFixturePair(dir, 'sample', RAW_RESPONSE)).toThrow()
    expect(readFileSync(responsePath, 'utf8')).toBe('PRE-EXISTING-RESPONSE')
    expect(existsSync(join(dir, 'sample.expected-cards.json'))).toBe(false)
  })

  it('throws and does not overwrite when <name>.expected-cards.json already exists', () => {
    const cardsPath = join(dir, 'sample.expected-cards.json')
    writeFileSync(cardsPath, 'PRE-EXISTING-CARDS')

    expect(() => writeFixturePair(dir, 'sample', RAW_RESPONSE)).toThrow()
    expect(readFileSync(cardsPath, 'utf8')).toBe('PRE-EXISTING-CARDS')
    expect(existsSync(join(dir, 'sample.response.json'))).toBe(false)
  })

  it('is atomic: a simulated failure on the 2nd linkSync leaves neither final file (nor temp leftovers)', () => {
    let linkCalls = 0
    const flakyFsDeps: FsDeps = {
      existsSync,
      writeFileSync,
      unlinkSync,
      linkSync: (existingPath: PathLike, newPath: PathLike) => {
        linkCalls++
        if (linkCalls === 2) {
          throw new Error('simulated link failure')
        }
        linkSync(existingPath, newPath)
      },
    }

    expect(() =>
      writeFixturePair(dir, 'sample', RAW_RESPONSE, flakyFsDeps),
    ).toThrow('simulated link failure')

    expect(existsSync(join(dir, 'sample.response.json'))).toBe(false)
    expect(existsSync(join(dir, 'sample.expected-cards.json'))).toBe(false)
    // 一時ファイルも残らない (片肺状態を残さない)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('is exclusive: linkSync EEXIST on an existing destination throws even if the fast-fail existsSync gate is bypassed', () => {
    // assertFixtureDestinationsFree (existsSync ベースの早期チェック) が
    // 通ってしまう TOCTOU state を模倣: 事前チェック用 fsDeps は「存在しない」と
    // 嘘をつくが、 実ファイルは既に存在する。 最終保証は linkSync の EEXIST が
    // 担うことを確認する。
    writeFixturePair(dir, 'sample', RAW_RESPONSE)
    const lyingFsDeps: FsDeps = {
      existsSync: () => false,
      writeFileSync,
      unlinkSync,
      linkSync,
    }

    expect(() =>
      writeFixturePair(dir, 'sample', RAW_RESPONSE, lyingFsDeps),
    ).toThrow()
    // 元の内容は上書きされていない (linkSync は rename と違い置換しない)。
    expect(readFileSync(join(dir, 'sample.response.json'), 'utf8')).toBe(RAW_RESPONSE)
  })
})

describe('runCapture', () => {
  let dir: string

  beforeEach(() => {
    dir = makeTmpDir()
    mockCallGeminiRaw.mockReset()
    mockLoadImageInline.mockReset()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads the image, calls callGeminiRaw with the fixed model, and writes the fixture pair', async () => {
    mockLoadImageInline.mockReturnValue({ mimeType: 'image/png', data: 'base64data' })
    mockCallGeminiRaw.mockResolvedValue({
      text: RAW_RESPONSE,
      finishReason: 'STOP',
      usage: {},
    })

    const { responsePath, cardsPath } = await runCapture({
      imagePath: '/fake/path.png',
      name: 'sample',
      fixturesDir: dir,
    })

    expect(mockLoadImageInline).toHaveBeenCalledWith('/fake/path.png')
    expect(mockCallGeminiRaw).toHaveBeenCalledTimes(1)
    expect(mockCallGeminiRaw.mock.calls[0][0]).toMatchObject({
      modelId: 'gemini-2.5-flash',
      files: [{ mimeType: 'image/png', data: 'base64data' }],
    })
    expect(readFileSync(responsePath, 'utf8')).toBe(RAW_RESPONSE)
    expect(readFileSync(cardsPath, 'utf8')).toBe(EXPECTED_CARDS_JSON)
  })

  it('rejects an unsafe --name before spending a paid API call', async () => {
    await expect(
      runCapture({ imagePath: '/fake/path.png', name: '../evil', fixturesDir: dir }),
    ).rejects.toThrow()

    expect(mockLoadImageInline).not.toHaveBeenCalled()
    expect(mockCallGeminiRaw).not.toHaveBeenCalled()
  })

  it('refuses an already-existing destination before spending a paid API call', async () => {
    writeFileSync(join(dir, 'sample.response.json'), 'PRE-EXISTING-RESPONSE')

    await expect(
      runCapture({ imagePath: '/fake/path.png', name: 'sample', fixturesDir: dir }),
    ).rejects.toThrow()

    expect(mockLoadImageInline).not.toHaveBeenCalled()
    expect(mockCallGeminiRaw).not.toHaveBeenCalled()
  })
})
