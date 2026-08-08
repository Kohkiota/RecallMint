#!/usr/bin/env node
// ②-4b packaging gate: `@hyzyla/pdfium` の import 版(`dist/index.esm.js`)は wasm 実体を
// `new URL("pdfium.wasm", import.meta.url)` で参照する。 Turbopack がこれを静的アセット
// 扱いして public URL 文字列(`/_next/static/media/pdfium.*.wasm`)へ書き換えると、
// emscripten 側はその文字列をそのまま `fs.readFileSync` に渡す(Node 実行パスは file
// URL/文字列いずれも fs 直読み)ため、production worker の cwd から見て存在しない絶対
// path となり ENOENT で 500 になる(stg で実際に発生した障害)。
//
// next.config.ts の `serverExternalPackages: ['@hyzyla/pdfium']` で bundle 対象から
// 外すことでこの静的置換を回避しているが、「externalize されている」ことと「wasm が
// production function に同梱される」ことは別の性質(NFT が dlopen/実行時 URL 参照を
// トレースし損ねる例が sharp .so で既に実例あり — next.config.ts 参照)。 本 script は
// build 後に次の 3 点が一致することを実測で検証する(仮定で pass にしない):
//   ① runtime lookup path: PDFiumLibrary.init() を実際に呼び、pdfium が
//      fs.readFileSync に渡す path を捕捉する(production は serverExternalPackages に
//      より un-bundle のまま require するため、ここでの import は production の module
//      解決と同一)。
//   ② その path に実ファイルが存在するか(size > 0)。
//   ③ 対象 worker page の nft.json trace(= Vercel が deploy function に同梱する
//      file 一覧)にその実ファイルが含まれるか。
//
// 検証対象の worker page は server-reference-manifest.json から動的に導出する
// (特定 entry を hard-code しない — build 次第で server action の所属 chunk は変わりうる)。
// probe route は使わない(実証経路と本番経路が別物になる穴を作らないため)。
//
// fail-closed: 前提ファイル欠如・対象 action 未発見・捕捉 0 件・path 不一致は
// いずれも非 0 exit(判定不能を pass にしない)。
import { existsSync, readFileSync, statSync } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.cwd()
const NEXT_DIR = path.join(ROOT, '.next')
const MANIFEST_PATH = path.join(NEXT_DIR, 'server', 'server-reference-manifest.json')
// この export を検査の起点にしている。 pdfium 依存を持つ server action は他にも
// ある(`submitUpload` → `runUploadPipeline` → `loadPdf`)が、canonical review で
// 現物確認済みの通り、両方とも同じ worker page(`app/(app)/app/upload/page`)に
// bundle されるため、この export 1 つの worker page 集合が pdfium 依存全体の
// coverage になっている。この結合は **load-bearing な暗黙の前提**であり、将来
// pipeline 呼出しが別 route / background function(例: queue worker)へ移ると
// 静かに範囲外になる(この export 側は fail-closed のままだが、そちらは検査されない)。
// そのため下の「coverage 検査」で、pdfium.wasm を trace に含む worker page が
// pagePaths の外に存在しないことを nft.json 全体から機械的に確認する
// (Minor 2 対応 — 暗黙の前提を検査化)。
const TARGET_EXPORT = 'finalizePdfSource'

const failures = []

function fail(message) {
  failures.push(message)
  console.error(`[verify-pdfium-wasm-packaging] FAIL: ${message}`)
}

function ok(message) {
  console.log(`[verify-pdfium-wasm-packaging] OK: ${message}`)
}

function exitWithResult() {
  if (failures.length > 0) {
    console.error(
      `[verify-pdfium-wasm-packaging] ${failures.length} 件の不一致(3 点一致 NG)`,
    )
    process.exit(1)
  }
  console.log(
    '[verify-pdfium-wasm-packaging] PASS: 3 点一致(runtime lookup path / 実ファイル存在 / nft.json trace)を確認',
  )
  process.exit(0)
}

// --- 0. build 前提の存在確認(fail-closed) -----------------------------------------
if (!existsSync(MANIFEST_PATH)) {
  fail(
    `server-reference-manifest.json が見つからない(${MANIFEST_PATH})。先に \`pnpm build\` を実行すること。`,
  )
  exitWithResult()
}

// --- 1. 対象 server action の worker page を manifest から動的に発見 -----------------
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
const nodeActions = manifest.node ?? {}
const matchedActions = Object.values(nodeActions).filter(
  (action) => action?.exportedName === TARGET_EXPORT,
)
if (matchedActions.length === 0) {
  fail(
    `server-reference-manifest.json に "${TARGET_EXPORT}" が見つからない(action 名の変更/削除の可能性 — 判定不能)。`,
  )
  exitWithResult()
}

const pagePaths = new Set()
for (const action of matchedActions) {
  for (const workerPath of Object.keys(action.workers ?? {})) {
    pagePaths.add(workerPath)
  }
}
if (pagePaths.size === 0) {
  fail(`"${TARGET_EXPORT}" の worker page が manifest から取得できない(判定不能)。`)
  exitWithResult()
}
ok(`"${TARGET_EXPORT}" worker page(s): ${[...pagePaths].join(', ')}`)

// --- 1.5. coverage 検査: pdfium 依存を持つ worker page が pagePaths の外に無いか -----
// pagePaths は TARGET_EXPORT(現在値 = "finalizePdfSource")1 export から逆算した
// 集合でしかない(冒頭コメント参照)。 その前提が崩れていないかを、`.next/server/app`
// 配下の nft.json 全件を実際に走査して確認する — pdfium(wasm 本体 / index.esm.js / 外部
// require 用シンボリックリンク)への参照を持つ page が pagePaths に**すべて**
// 含まれることを要求する(fail-closed。含まれなければ「この gate が把握していない
// pdfium 依存箇所がある」ことを意味する)。
function listNftFilesRecursively(dir) {
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...listNftFilesRecursively(full))
    } else if (entry.isFile() && entry.name.endsWith('.nft.json')) {
      found.push(full)
    }
  }
  return found
}

const appServerDir = path.join(NEXT_DIR, 'server', 'app')
const allNftFiles = listNftFilesRecursively(appServerDir)
if (allNftFiles.length === 0) {
  fail(`coverage 検査: ${appServerDir} 配下に nft.json が 1 件も無い(判定不能)。`)
  exitWithResult()
}

const pdfiumDependentPages = new Set()
for (const nftFile of allNftFiles) {
  const nft = JSON.parse(readFileSync(nftFile, 'utf-8'))
  const referencesPdfium = (nft.files ?? []).some(
    (relPath) => relPath.includes('@hyzyla') && relPath.toLowerCase().includes('pdfium'),
  )
  if (referencesPdfium) {
    const rel = path.relative(path.join(NEXT_DIR, 'server'), nftFile)
    const pagePathFromNft = rel.replace(/\.js\.nft\.json$/, '').split(path.sep).join('/')
    pdfiumDependentPages.add(pagePathFromNft)
  }
}

const uncoveredPages = [...pdfiumDependentPages].filter((p) => !pagePaths.has(p))
if (uncoveredPages.length > 0) {
  fail(
    `coverage 検査: pdfium 依存を持つ worker page が "${TARGET_EXPORT}" の検査対象集合の外に存在する` +
      `(${uncoveredPages.join(', ')}) — pagePaths の前提(冒頭コメント参照)が崩れている。`,
  )
} else {
  ok(
    `coverage 検査 OK: pdfium 依存を持つ worker page(${[...pdfiumDependentPages].join(', ')})はすべて検査対象に含まれる`,
  )
}

// --- 2. ① runtime lookup path を実測で捕捉する ---------------------------------------
// PDFiumLibrary.init() を実際に呼び出し、内部が pdfium.wasm を開こうとする path を
// fs.readFileSync の monkeypatch で捕捉する(Node built-in module は singleton object
// のため、@hyzyla/pdfium 内部の `require('fs')` も同じ object を見る)。
const capturedReads = []
const originalReadFileSync = fs.readFileSync
fs.readFileSync = function patchedReadFileSync(filePath, ...rest) {
  const asString = typeof filePath === 'string' ? filePath : String(filePath)
  if (asString.includes('pdfium.wasm')) {
    capturedReads.push(asString)
  }
  return originalReadFileSync.call(this, filePath, ...rest)
}

let initError = null
try {
  const { PDFiumLibrary } = await import('@hyzyla/pdfium')
  const library = await PDFiumLibrary.init()
  library.destroy()
} catch (e) {
  initError = e
} finally {
  fs.readFileSync = originalReadFileSync
}

if (capturedReads.length === 0) {
  fail(
    'PDFiumLibrary.init() が pdfium.wasm を fs.readFileSync 経由で読もうとしなかった(捕捉 0 件 — 実装/version 変化で読込経路が変わった可能性)。' +
      (initError ? ` init() error: ${initError?.stack ?? initError}` : ''),
  )
  exitWithResult()
}

const rawLookupPath = capturedReads[0]
const runtimeLookupAbsPath = rawLookupPath.startsWith('file:')
  ? fileURLToPath(rawLookupPath)
  : path.resolve(rawLookupPath)

if (initError) {
  fail(
    `PDFiumLibrary.init() が失敗した(捕捉した lookup path = ${runtimeLookupAbsPath})。error: ${initError?.stack ?? initError}`,
  )
  exitWithResult()
}
ok(`① runtime lookup path = ${runtimeLookupAbsPath}`)

// --- 3. ② 実ファイル存在確認 ----------------------------------------------------------
if (!existsSync(runtimeLookupAbsPath)) {
  fail(`② lookup path にファイルが存在しない: ${runtimeLookupAbsPath}`)
  exitWithResult()
}
const stat = statSync(runtimeLookupAbsPath)
if (stat.size === 0) {
  fail(`② lookup path のファイルサイズが 0: ${runtimeLookupAbsPath}`)
} else {
  ok(`② 実ファイル存在確認 OK(${stat.size} bytes): ${runtimeLookupAbsPath}`)
}

// --- 4. ③ 各 worker page の nft.json trace にそのファイルが含まれるか(全 worker 必須)---
for (const pagePath of pagePaths) {
  const nftPath = path.join(NEXT_DIR, 'server', `${pagePath}.js.nft.json`)
  if (!existsSync(nftPath)) {
    fail(`③ ${pagePath}: nft.json が見つからない(${nftPath})`)
    continue
  }
  const nft = JSON.parse(readFileSync(nftPath, 'utf-8'))
  const nftDir = path.dirname(nftPath)
  const tracedAbsPaths = new Set(
    (nft.files ?? []).map((relPath) => path.resolve(nftDir, relPath)),
  )
  if (tracedAbsPaths.has(runtimeLookupAbsPath)) {
    ok(`③ ${pagePath} の nft.json trace に含まれる: ${nftPath}`)
  } else {
    fail(
      `③ ${pagePath}: nft.json trace に runtime lookup path が含まれない(${nftPath} — deploy 後に ENOENT の恐れ)`,
    )
  }
}

exitWithResult()
