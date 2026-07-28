// Golden test: 実 Gemini 応答 (録画 fixture) を parseOcrResponse に通し、pin 済 ExtractedCard[] と
// 一致するかを検証する。
//
// 検出するもの = parse/validate 層 (parseOcrResponse / zod responseSchema) の drift のみ。
// 検出しないもの = モデル出力そのものの drift (録画応答は凍結されているため)。②-1/②-2 での
// モデル出力変化検出は「再 capture して baseline と diff」or「ocr-compare.ts 再実行」が実体。
// 詳細: docs/ops/ocr-regression-foundation-runbook.md §3。
//
// loud failure over silent green: fixture 0 件は RED (skip 禁止)。fixture が失われても suite が
// green のまま「保証があるつもり」になる事故を防ぐ。

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseOcrResponse } from './ocr'

const FIXTURE_DIR = fileURLToPath(new URL('../../tests/fixtures/ocr', import.meta.url))

const RESPONSE_SUFFIX = '.response.json'
const EXPECTED_SUFFIX = '.expected-cards.json'

const entries = readdirSync(FIXTURE_DIR)
const responseNames = entries
  .filter((f) => f.endsWith(RESPONSE_SUFFIX))
  .map((f) => f.slice(0, -RESPONSE_SUFFIX.length))
  .sort()
const expectedNames = entries
  .filter((f) => f.endsWith(EXPECTED_SUFFIX))
  .map((f) => f.slice(0, -EXPECTED_SUFFIX.length))
  .sort()

function read(name: string, suffix: string): string {
  return readFileSync(`${FIXTURE_DIR}/${name}${suffix}`, 'utf8')
}

describe('OCR golden fixtures', () => {
  // fixture 0 件 = RED。capture 前 (fixture 未投入) や fixture 消失を loud に検出する。
  it('has at least one recorded-response fixture', () => {
    expect(responseNames.length).toBeGreaterThan(0)
  })

  // response と expected は pair で揃っていること (孤児 fixture を loud に検出)。
  it('has no orphan fixtures (every response has expected, and vice versa)', () => {
    expect(responseNames).toEqual(expectedNames)
  })

  describe.each(responseNames)('%s', (name) => {
    it('parseOcrResponse output matches the pinned expected cards', () => {
      const cards = parseOcrResponse(read(name, RESPONSE_SUFFIX))
      const expected = JSON.parse(read(name, EXPECTED_SUFFIX))
      expect(cards).toEqual(expected)
    })
  })
})
