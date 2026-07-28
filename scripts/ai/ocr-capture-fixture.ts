#!/usr/bin/env tsx
// Golden fixture capture: 本番モデル(gemini-2.5-flash 固定)+ 本番 prompt/schema で
// 1 画像を叩き、 raw response text + parseOcrResponse(T1)の出力を
// tests/fixtures/ocr/ へ安全に(atomic・無言上書き禁止)書く。
// ②-0 OCR regression 基盤 Task 5。
//
// 実行(OT 合図で実 API 呼出。 GEMINI_API_KEY 必須・料金発生):
//   tsx scripts/ai/ocr-capture-fixture.ts --image <path> --name <fixtureName>
//
// 安全書込:
// - name は ^[A-Za-z0-9._-]+$ のみ許可(path traversal 防止・空文字/".." も拒否)。
// - <name>.response.json / <name>.expected-cards.json のいずれかが既に存在すれば
//   無言上書きせず throw する。 有料 API 呼出の前(runCapture 冒頭)に早期 gate として
//   一度チェックし、 writeFixturePair 内でも再チェックする(defense in depth)。
// - 最終配置は temp → linkSync(atomic かつ exclusive: 宛先が既に存在すれば EEXIST
//   で失敗する。 existsSync→write の間に他プロセスが同名で書いても TOCTOU で
//   すり抜けない)。 2 ファイル目の link が失敗したら 1 ファイル目の link を
//   巻き戻し(unlink)、 temp を掃除して throw する(「片方だけ書かれた」状態を
//   残さない)。
//
// 本番との違い(T3 callGeminiRaw と同型の注意点): modelId は raw string 固定
// (本番 modelId() 変換を経由しない)、 retry は一切しない(1 回呼び出し)。

import { existsSync, writeFileSync, linkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { parseOcrResponse } from '@/lib/ai/ocr'
import { buildDiscoverPrompt } from '@/lib/ai/prompts/ocr-extract'
import { buildDiscoverResponseJsonSchema } from '@/lib/ai/schemas/ocr-response'
import { callGeminiRaw } from './lib/gemini-raw'
import { loadImageInline } from './lib/load-images'

// capture は本番 modelId() 変換を経由しない固定モデル(brief 要求: リテラル文字列)。
export const CAPTURE_MODEL_ID = 'gemini-2.5-flash'

export const FIXTURES_DIR = join(process.cwd(), 'tests/fixtures/ocr')

const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/

// fixture name の safe-write validation。 path traversal(`/` 等の separator・`..`)
// と空文字を拒否する。 regex 単体では ".." (2 文字とも許可文字)を弾けないため
// 明示チェックを separate で持つ。
export function validateFixtureName(name: string): void {
  if (name.length === 0) {
    throw new Error('--name must not be empty')
  }
  if (name.includes('..')) {
    throw new Error(`--name "${name}" must not contain ".."`)
  }
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(
      `--name "${name}" contains unsafe characters (allowed: ${SAFE_NAME_RE})`,
    )
  }
}

// fs 呼び出しの差し替え口(default = 実 node:fs)。 test から atomic write の
// 途中失敗(2 個目の link 失敗)を注入するために存在する。
export type FsDeps = {
  existsSync: typeof existsSync
  writeFileSync: typeof writeFileSync
  linkSync: typeof linkSync
  unlinkSync: typeof unlinkSync
}

const realFsDeps: FsDeps = { existsSync, writeFileSync, linkSync, unlinkSync }

function cleanupTemp(fs: FsDeps, path: string): void {
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path)
  } catch {
    // best-effort cleanup: 削除失敗は握りつぶし、 元の throw を優先させる。
  }
}

export type FixturePairPaths = {
  responsePath: string
  cardsPath: string
}

// name を validate した上で、 dir 内の 2 つの destination path を返す。
export function fixturePairPaths(dir: string, name: string): FixturePairPaths {
  validateFixtureName(name)
  return {
    responsePath: join(dir, `${name}.response.json`),
    cardsPath: join(dir, `${name}.expected-cards.json`),
  }
}

// name validation + destination 非存在の事前チェック。 有料 API 呼出(runCapture)の
// 前段の早期 gate、 かつ writeFixturePair 内の再チェック(defense in depth)の
// 両方から呼ぶ。 ここでの existsSync チェックは fail-fast のヒントに過ぎず、
// 「無言上書きしない」の最終保証は writeFixturePair 内の linkSync(exclusive)が担う
// (このチェックと実際の書込の間に TOCTOU の隙間がありうるため)。
export function assertFixtureDestinationsFree(
  dir: string,
  name: string,
  fsDeps: FsDeps = realFsDeps,
): FixturePairPaths {
  const paths = fixturePairPaths(dir, name)
  if (fsDeps.existsSync(paths.responsePath)) {
    throw new Error(`refusing to overwrite existing fixture: ${paths.responsePath}`)
  }
  if (fsDeps.existsSync(paths.cardsPath)) {
    throw new Error(`refusing to overwrite existing fixture: ${paths.cardsPath}`)
  }
  return paths
}

// rawResponseText(検証済 name)を dir へ atomic かつ exclusive に書く。 既存 file が
// あれば throw(無言上書き禁止・TOCTOU 下でも linkSync の EEXIST で保証)。 fsDeps は
// test 用の差し替え口。
export function writeFixturePair(
  dir: string,
  name: string,
  rawResponseText: string,
  fsDeps: FsDeps = realFsDeps,
): FixturePairPaths {
  const { responsePath, cardsPath } = assertFixtureDestinationsFree(dir, name, fsDeps)

  // 両ファイルの内容を先に確定させてから書く(途中失敗時に「どちらの内容が
  // 欠けているか」を悩まないため)。 raw text は verbatim(再整形しない)、
  // cards は T1 parseOcrResponse の出力を pretty JSON 化する(golden test と同じ parse)。
  const cards = parseOcrResponse(rawResponseText)
  const cardsJsonText = JSON.stringify(cards, null, 2) + '\n'

  const responseTmp = `${responsePath}.tmp-${process.pid}-${Date.now()}`
  const cardsTmp = `${cardsPath}.tmp-${process.pid}-${Date.now()}`

  try {
    fsDeps.writeFileSync(responseTmp, rawResponseText, 'utf8')
    fsDeps.writeFileSync(cardsTmp, cardsJsonText, 'utf8')
  } catch (err) {
    cleanupTemp(fsDeps, responseTmp)
    cleanupTemp(fsDeps, cardsTmp)
    throw err
  }

  // 最終配置は hardlink(atomic かつ exclusive: 宛先が既に存在すれば EEXIST で
  // 失敗する。 rename と違い上書きしない)。 成功後、 temp 側の directory entry は
  // 不要になる(dest 側が inode を共有する独立 entry として残るので、 temp を消しても
  // dest の内容は消えない)。
  try {
    fsDeps.linkSync(responseTmp, responsePath)
  } catch (err) {
    cleanupTemp(fsDeps, responseTmp)
    cleanupTemp(fsDeps, cardsTmp)
    throw err
  }

  try {
    fsDeps.linkSync(cardsTmp, cardsPath)
  } catch (err) {
    // response 側は既に最終 path へ link 済(EEXIST 含む)→ 片肺状態を残さないよう
    // 巻き戻す(最終 path を unlink する。 temp 側は別 directory entry のままなので
    // 元の内容は失われない)。
    try {
      fsDeps.unlinkSync(responsePath)
    } catch {
      // 巻き戻し自体の失敗は無視(best-effort・元の err を優先して throw する)。
    }
    cleanupTemp(fsDeps, responseTmp)
    cleanupTemp(fsDeps, cardsTmp)
    throw err
  }

  cleanupTemp(fsDeps, responseTmp)
  cleanupTemp(fsDeps, cardsTmp)

  return { responsePath, cardsPath }
}

// 画像読込 → 本番 prompt/schema で 1 回 API 呼出 → fixture pair 書込、までの
// orchestration。 main() から呼ばれるほか、 test からも直接呼べる(callGeminiRaw /
// loadImageInline は module mock で差し替える前提)。
export async function runCapture(opts: {
  imagePath: string
  name: string
  fixturesDir?: string
}): Promise<FixturePairPaths> {
  const fixturesDir = opts.fixturesDir ?? FIXTURES_DIR
  // 有料・最大 220s の Gemini 呼出より前に、 ローカルで検知可能なエラー(不正 name /
  // 既存 destination)を弾く(Codex Important 1: 無駄な API 呼出を避ける早期 gate)。
  assertFixtureDestinationsFree(fixturesDir, opts.name)

  const file = loadImageInline(opts.imagePath)
  const prompt = buildDiscoverPrompt()
  const responseJsonSchema = buildDiscoverResponseJsonSchema()

  const result = await callGeminiRaw({
    modelId: CAPTURE_MODEL_ID,
    files: [file],
    prompt,
    responseJsonSchema,
  })

  return writeFixturePair(fixturesDir, opts.name, result.text)
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx === -1) return undefined
  return argv[idx + 1]
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const imagePath = argValue(argv, '--image')
  const name = argValue(argv, '--name')
  if (!imagePath) throw new Error('--image <path> is required')
  if (!name) throw new Error('--name <fixtureName> is required')

  const { responsePath, cardsPath } = await runCapture({ imagePath, name })
  console.log(`wrote ${responsePath}`)
  console.log(`wrote ${cardsPath}`)
}

// process.argv[1] が本 file のとき = CLI 起動。 import(test 含む)時は走らない
// (backfill-clerk-metadata.ts 踏襲の guard)。
if (process.argv[1]?.endsWith('ocr-capture-fixture.ts')) {
  main().catch((err) => {
    console.error('[ocr-capture-fixture] fatal:', err)
    process.exit(1)
  })
}
