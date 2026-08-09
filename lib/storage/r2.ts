// server専用: Cloudflare R2 (S3互換API) と話す唯一のmodule。 aws4fetchでpresigned
// URL(PUT/GET)とHEAD検証を提供する。 画像フェーズA design spec §8 準拠。
//
// lib/db/index.ts と同様、 client bundleに混入したらbuildを loud に失敗させるため
// server-only guardを先頭に置く。
import 'server-only'

import { AwsClient } from 'aws4fetch'

// R2 env fail-fast (CLAUDE.md 環境変数節 / lib/stripe/client.ts の形を踏襲)。
// Stripe/Clerkと異なりR2は資格情報が1系統のみ (VERCEL_ENVによるprod/test分岐なし)
// なので存在チェックのみ行う。 module load時点でthrowし、 起動直後に設定漏れを検出する。
// R2_PUBLIC_URL は本phaseでは意図的に必須にしない (spec §8: 非公開bucket + presigned
// GETで表示するため未使用。 .env.exampleには将来のpublic配信用に残置)。 未読の変数を
// fail-fast対象にすると使わない設定を強制することになるため、 検証は下記4変数のみ。
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME

if (!R2_ACCOUNT_ID) {
  throw new Error('R2_ACCOUNT_ID is not set')
}
if (!R2_ACCESS_KEY_ID) {
  throw new Error('R2_ACCESS_KEY_ID is not set')
}
if (!R2_SECRET_ACCESS_KEY) {
  throw new Error('R2_SECRET_ACCESS_KEY is not set')
}
if (!R2_BUCKET_NAME) {
  throw new Error('R2_BUCKET_NAME is not set')
}

// presigned URLの既定TTL (spec §3.1: 10分)。
const DEFAULT_EXPIRES_SEC = 600

// HEAD検証のnetwork timeout。 CLAUDE.md AI-2 (外部API callはtimeout必須) 準拠。
const HEAD_TIMEOUT_MS = 10_000

// DELETE (GC sweep) のnetwork timeout。 HEAD_TIMEOUT_MSと同値 (CLAUDE.md AI-2)。
export const DELETE_TIMEOUT_MS = 10_000

// GET (finalize saga の実バイト取得)・PUT (finalize saga の最終 immutable key への
// server 書込) のnetwork timeout。 HEAD_TIMEOUT_MS/DELETE_TIMEOUT_MSと同値 (CLAUDE.md AI-2)。
const GET_TIMEOUT_MS = 10_000
const PUT_TIMEOUT_MS = 10_000

// LIST (ListObjectsV2 — 破壊 script の削除前 listing / 削除後 readback) の
// network timeout。 他の *_TIMEOUT_MS と同値 (CLAUDE.md AI-2)。
export const LIST_TIMEOUT_MS = 10_000

// listObjects の pagination 無限ループ耐性。 1 page ≈ 最大 1000 key (S3 互換の既定)
// なので 10,000 page は数百万 key 相当の余裕。 token が壊れて進まない/異常応答を
// 繰り返す場合に無限に fetch し続けないための上限 (超過は throw で異常を露出する)。
const MAX_LIST_PAGES = 10_000

// retries: 0 が必須 — AwsClient は既定で retries:10 の指数 backoff を行うが、 その
// backoff sleep は fetch へ渡す AbortSignal.timeout を観測しないため、 R2 が 5xx/429 を
// 返し続けると headObject が 10 秒の外部 API timeout (CLAUDE.md AI-2) を大幅に超えて
// block しうる。 headObject は finalize の検証 call ゆえ単発で十分 (失敗 → exists:false →
// finalize 失敗 → client が saga 全体を retry する)。 HEAD レベルの retry は不適切。
const client = new AwsClient({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  service: 's3',
  region: 'auto',
  retries: 0,
})

// S3 path-style endpoint (spec §8: `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)。
function objectUrl(objectKey: string): string {
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${objectKey}`
}

/**
 * PUT用のpresigned URLを発行する (browserからR2へ直PUTするための署名付きURL)。
 *
 * Content-Type と Content-Length の両方を署名に含める (aws4fetch の s3+signQuery は
 * 既定で content-type / content-length を UNSIGNABLE_HEADERS 扱いし除外するため、
 * `aws.allHeaders: true` で強制的に signed headers へ含める)。
 * - Content-Type 固定: 異なる Content-Type の PUT を R2 が署名不一致で拒否する。
 * - Content-Length 固定 (= byteSize): これがないと presigned URL は body サイズを
 *   一切制限せず、 reserve の 5 MiB cap が storage 層で無効化される (authed client が
 *   小さい byteSize で reserve し巨大 body を PUT → 巨大 orphan で cap 迂回)。 exact
 *   byteSize を署名に焼き込むことで R2 が Content-Length 不一致の PUT を拒否し、
 *   保存オブジェクトを宣言サイズ (≤5 MiB) に構造的に束縛する。 browser は body の
 *   実サイズから Content-Length を自動設定するため、 正直な client (body = byteSize
 *   の blob) は一致し、 サイズ詐称は 403 になる。 R2 の実 enforce は stg smoke で確認。
 */
export async function presignPutUrl(
  objectKey: string,
  mime: string,
  byteSize: number,
  expiresSec: number = DEFAULT_EXPIRES_SEC,
): Promise<string> {
  const url = new URL(objectUrl(objectKey))
  url.searchParams.set('X-Amz-Expires', String(expiresSec))
  const signed = await client.sign(url.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': mime, 'Content-Length': String(byteSize) },
    aws: { signQuery: true, allHeaders: true },
  })
  return signed.url
}

/**
 * GET用のpresigned URL (表示fetch用。 spec §6 resolve)。
 */
export async function presignGetUrl(
  objectKey: string,
  expiresSec: number = DEFAULT_EXPIRES_SEC,
): Promise<string> {
  const url = new URL(objectUrl(objectKey))
  url.searchParams.set('X-Amz-Expires', String(expiresSec))
  const signed = await client.sign(url.toString(), {
    method: 'GET',
    aws: { signQuery: true },
  })
  return signed.url
}

/**
 * R2オブジェクトの実在確認 (finalize saga の HEAD検証。 spec §3.1)。
 * network throw / timeoutを含め例外を外に投げない — `exists:false` に正規化する。
 * finalize (Task 4) 側は `exists:false` を「検証失敗」として一律扱えばよく、
 * try/catchをHEAD呼び出し側に強制しない契約とするための選択 (report参照)。
 */
export async function headObject(
  objectKey: string,
): Promise<{ exists: boolean; contentLength: number | null }> {
  try {
    const res = await client.fetch(objectUrl(objectKey), {
      method: 'HEAD',
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    })
    if (!res.ok) {
      return { exists: false, contentLength: null }
    }
    // content-lengthが欠落 or 非数値(NaN)なら null に正規化する。 Task 4 finalize は
    // `contentLength !== byte_size` で照合するため、 NaN を通すと「明示的な検証不能」でなく
    // 「サイズ不一致」に化けて誤診する。 R2は200 HEADで整数を返すので実際上は到達しないが、
    // finalize が継承する曖昧さを断つ (canonical review Minor #1)。
    const contentLengthHeader = res.headers.get('content-length')
    const parsed = contentLengthHeader === null ? null : Number(contentLengthHeader)
    const contentLength = parsed !== null && Number.isFinite(parsed) ? parsed : null
    return { exists: true, contentLength }
  } catch {
    return { exists: false, contentLength: null }
  }
}

/**
 * R2オブジェクトの実バイト取得 (source finalize saga の server 検証用。 ②-4a spec §6.2)。
 *
 * finalize は temp key の実バイトを取得し、 magic-byte/decode/hash/寸法を server で
 * 検証してから最終 key へ promote する (client 申告値を信用しない・Codex P1 対処)。
 *
 * `opts.timeoutMs`(②-4b spec D8): 省略時は既定 `GET_TIMEOUT_MS`(10s)のまま —
 * 既存呼出側は無改変で通る。 PDF source(最大 50MB・spec D7)の GET は既定 10s
 * では不足しうるため、 呼出側(finalize-pdf-source / pipeline count・render
 * phase)が明示的に長い timeoutMs(暫定 60s)を渡す。
 *
 * headObject/deleteObject と同じ never-throw契約: fetchのthrow/timeout(abort)・
 * 非2xx(404含む)はcatchせずnullに正規化する。 呼出側(finalize)にtry/catchを
 * 強制せず、 「検証不能」を一律 null で扱えるようにする。
 */
export async function getObject(
  objectKey: string,
  opts?: { timeoutMs?: number },
): Promise<{ bytes: Buffer } | null> {
  try {
    const res = await client.fetch(objectUrl(objectKey), {
      method: 'GET',
      signal: AbortSignal.timeout(opts?.timeoutMs ?? GET_TIMEOUT_MS),
    })
    if (!res.ok) {
      return null
    }
    const arrayBuffer = await res.arrayBuffer()
    return { bytes: Buffer.from(arrayBuffer) }
  } catch {
    return null
  }
}

// putObject の結果種別。 'success' = 書込成功。 'precondition_failed' = 条件付き
// PUT(ifNoneMatch)で既に key が存在し 412 が返った(first-writer-wins の敗者)。
// 'error' = その他の失敗(非2xx・throw・timeout — never-throw契約でここに正規化)。
export type PutObjectOutcome = 'success' | 'precondition_failed' | 'error'

/**
 * R2オブジェクトへのserver直PUT (source finalize saga の最終 immutable key への
 * promote。 ②-4a spec §6.2 Codex P1 対処 — 最終 key は client presigned URL を
 * 一切持たず、 server 検証済バイトのみが書き込まれる=finalize 後 immutable)。
 *
 * `options.ifNoneMatch: true` で条件付き PUT(`If-None-Match: *`)を行う —
 * key が未存在の場合のみ書き込む(spec §7.4 の first-writer-wins discipline。
 * Task 5 の finalize 同時実行 race 対処・Task 10 の crop 保存でも共有する)。
 * 既存 key があれば R2 が 412 を返す想定(呼出側が getObject で実体を再取得し
 * hash 照合する — 本関数は 412 を示すのみで内容比較はしない)。
 *
 * headObject/deleteObject と同じ never-throw契約: fetchのthrow/timeout(abort)は
 * catchし 'error' に正規化する。 呼出側(finalize)にtry/catchを強制しない。
 */
export async function putObject(
  objectKey: string,
  bytes: Uint8Array,
  mime: string,
  options: { ifNoneMatch?: boolean } = {},
): Promise<PutObjectOutcome> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': mime,
      // server 直 PUT は Content-Length を**明示**する。未設定だと aws4fetch/undici が
      // chunked transfer-encoding で body を送り、R2(S3 互換)は PUT に Content-Length を
      // 要求するため **411(Length Required)** を返す(②-4a smoke で finalize の最終 key
      // への server PUT が 411 で失敗 → finalize saga が「検証失敗」に落ちていた)。
      // presigned client PUT(presignPutUrl)は Content-Length を署名 + browser が自動送信
      // するため無影響で、この非対称が smoke まで露見しなかった。bytes は全長既知の
      // Buffer/Uint8Array(finalize=getObject の実バイト / crop=sharp().toBuffer())。
      'Content-Length': String(bytes.byteLength),
    }
    if (options.ifNoneMatch) {
      headers['If-None-Match'] = '*'
    }
    const res = await client.fetch(objectUrl(objectKey), {
      method: 'PUT',
      // `as BodyInit`: lib.dom.d.ts の fetch overload は `Uint8Array<ArrayBuffer>`
      // を要求するが、 @types/node の Buffer/Uint8Array は `ArrayBufferLike` 版の
      // generic を持つため型上噛み合わない (実行時には無害な既知の型定義乖離)。
      body: bytes as BodyInit,
      headers,
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    })
    if (res.ok) return 'success'
    if (res.status === 412) return 'precondition_failed'
    return 'error'
  } catch {
    return 'error'
  }
}

// XML entity unescape (ListObjectsV2 応答の <Key> 内で `&` `<` `>` `"` `'` が
// entity化されて返りうるため)。 `&amp;` は最後に処理する — 先に処理すると
// `&amp;lt;` (元は key に literal な `&lt;` という文字列を含む場合の正しい
// entity化) が二重展開されて `<` に化ける誤りを避けるため。
function unescapeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// ListObjectsV2 応答の構造検証(Codex fix round 1 P1・②-4a S-5a)。
//
// 背景: 200 応答であっても body が空/途中で切れた/壊れている場合、旧実装は
// <Key>/<IsTruncated> の regex がどちらも一致せず「listing 0件」を静かに返して
// いた — never-throw 契約を破ってまで避けようとした「分からない」を「空」として
// 扱う失敗が、非2xx経路でなく **2xx経路から** 再侵入していた(破壊 script の削除後
// readback が「残0件=削除完了」と誤認しうる)。
//
// 検出できる範囲(2点のみを必須にする — ListObjectsV2 の正常応答は必ず両方を
// 含むため正常系を壊さない):
//   (a) root 要素 `<ListBucketResult>` の開閉タグが両方存在する。 これは
//       「明らかな truncation(応答が途中で切れて閉じタグに到達しない)」の
//       主要形を捕まえる — 開閉タグが揃うには内側の各要素も概ね閉じている
//       必要があるため、個々の <Key> が中途半端に切れたケースの一部もここで
//       捕まる。
//   (b) `<IsTruncated>` が存在し `true`/`false` のどちらかとして曖昧さ無く
//       parse できる(欠落・空・他の値は reject)。
// 検出できない残余(regex ベースゆえの限界・隠さず明記する): root 要素の開閉
// タグが揃っていても **内部の値が改竄/破損**している(例: 中間プロキシが正しい
// XML構造を保ったまま <Key> の中身を差し替えた)ケースは検出できない。 完全な
// 検証には XML schema validation が要るが、CLAUDE.md の新規依存追加禁止(事前
// 相談)制約のもとでは、readback の偽陰性を引き起こす「主要な」経路(空 body・
// 明らかな truncation・IsTruncated 欠落)を塞ぐのがこの検証の目的であり範囲。
function parseListObjectsPage(xml: string, prefix: string): { isTruncated: boolean } {
  const hasOpenRoot = /<ListBucketResult[\s>]/.test(xml)
  const hasCloseRoot = /<\/ListBucketResult>/.test(xml)
  if (!hasOpenRoot || !hasCloseRoot) {
    throw new Error(
      `listObjects: malformed response — <ListBucketResult> root element not found/closed ` +
        `(prefix=${prefix}, bodyLength=${xml.length}) — refusing to treat as an empty page`,
    )
  }
  const truncatedMatch = xml.match(/<IsTruncated>\s*(true|false)\s*<\/IsTruncated>/)
  if (!truncatedMatch) {
    throw new Error(
      `listObjects: malformed response — <IsTruncated> missing or not true/false ` +
        `(prefix=${prefix}, bodyLength=${xml.length}) — refusing to treat as an empty page`,
    )
  }
  return { isTruncated: truncatedMatch[1] === 'true' }
}

// R2 の listing entry 1件分のメタ情報(②-4b spec §3.2)。src/ prefix の
// age-based sweeper が「削除してよい古さか」を判定するには key に加えて
// LastModified(epoch ms)が要るため、 key-only な `R2ObjectMeta` 無しの listing
// (listObjects/listObjectsBounded)とは別に公開する。
export type R2ObjectMeta = { key: string; lastModifiedMs: number }

/**
 * R2オブジェクトの一覧を bounded page 数で取得する pagination core(②-4b spec
 * §3.2)。 `listObjectsBounded`(key のみ)と `listObjectsWithMetaBounded`
 * (key+LastModified)は 1 page 分の応答から entry を抽出する方法だけが異なり、
 * continuation-token の前進検証・`maxPages` 到達時の打ち切り・`timeoutMs` の
 * 適用は完全に同一のため、 ここに一本化して二重実装を避ける(`extractEntries` が
 * xml 文字列から 1 page 分の entry 配列を返す差し替え点)。
 *
 * `maxPages` 到達時は throw せず `{ truncated: true }` + 収集済み entries で
 * 打ち切る — 呼出元(退会時の R2 prefix purge 等)は「上限で打ち切ったが取れた分の
 * 削除は続行する」必要があり、throw では呼出側に強制的な catch を課してしまう
 * ため。`listObjects`(既存の全列挙 + throw 契約)は `listObjectsBounded` に
 * `maxPages=MAX_LIST_PAGES` で委譲し、`truncated:true` を従来と同一文言の throw に
 * 変換するだけ — 外部契約は完全に不変。
 *
 * `maxPages` は数値引数を public にする以上、型だけでは不正入力を防げないため
 * fail-fast で reject する(正の整数以外 — `0`/負数/非整数/`NaN`/`Infinity`)。
 * `opts.timeoutMs` は `getObject` の `{ timeoutMs }` idiom に倣う — 省略時は既定
 * `LIST_TIMEOUT_MS`、指定時は各 page の `AbortSignal.timeout` に反映する(予算付き
 * 呼出側が残予算を渡す口)。
 *
 * ⚠ **`timeoutMs` は 1 page ごとに適用される値であって listing 全体の上限ではない**。
 * pagination は最大 `maxPages` 回 fetch するため、全体の最悪所要は
 * `maxPages × timeoutMs` になる。残予算を配る呼出側(budgeted caller)は
 * **`maxPages` で割った 1 page あたりの取り分**を渡すこと — 残予算をそのまま渡すと
 * 予算が page 数ぶん多重化する(②-4b §2 fix round 2 の実障害)。helper 側に絶対
 * deadline を持たせない理由: 「deadline 由来の打ち切り」と「page 上限由来の truncated」が
 * 同じ `truncated` フラグに潰れ、呼出側の phase 判別(§3.3)の意味が濁るため。
 *
 * 既存の throw 契約(`!res.ok` / malformed root / malformed IsTruncated / token
 * 非前進)はそのまま保持する — never-throw ではない(listObjects と同じ非対称)。
 * `extractEntries` が追加で throw した場合(meta 版の fail-closed 検証)もこの
 * page 単位の失敗としてそのまま伝播する。
 */
async function listPagesCore<T>(
  prefix: string,
  maxPages: number,
  opts: { timeoutMs?: number } | undefined,
  extractEntries: (xml: string) => T[],
): Promise<{ entries: T[]; truncated: boolean }> {
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`listObjectsBounded: maxPages must be a positive integer (received ${maxPages})`)
  }

  const entries: T[] = []
  let continuationToken: string | undefined

  for (let page = 1; ; page++) {
    if (page > maxPages) {
      return { entries, truncated: true }
    }

    const url = new URL(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}`)
    url.searchParams.set('list-type', '2')
    url.searchParams.set('prefix', prefix)
    if (continuationToken) {
      url.searchParams.set('continuation-token', continuationToken)
    }

    const res = await client.fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(opts?.timeoutMs ?? LIST_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`listObjects failed: prefix=${prefix} status=${res.status}`)
    }

    const xml = await res.text()
    const { isTruncated } = parseListObjectsPage(xml, prefix)

    entries.push(...extractEntries(xml))

    if (!isTruncated) {
      return { entries, truncated: false }
    }

    const tokenMatch = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)
    const nextToken = tokenMatch ? unescapeXmlEntities(tokenMatch[1]) : ''
    if (!nextToken || nextToken === continuationToken) {
      // IsTruncated=true なのに token が無い/前回と同じ = 応答が壊れているか
      // R2 側の異常。 無限ループするより throw で異常を露出させる。
      throw new Error(
        `listObjects: IsTruncated=true but NextContinuationToken is missing or not ` +
          `advancing (prefix=${prefix}) — refusing to loop forever`,
      )
    }
    continuationToken = nextToken
  }
}

/**
 * R2オブジェクトの一覧を bounded page 数で取得する(②-4b spec §3.2)。 pagination
 * (継続 token の前進検証・`maxPages` 到達時の打ち切り・`timeoutMs` の適用)は
 * `listPagesCore` に一本化されており、ここでは 1 page 分の xml から `<Key>` だけを
 * 抽出する(既存正規表現のまま — LastModified は見ないため `listObjectsWithMetaBounded`
 * の fail-closed 化を継承しない。既存 test green がこの非継承を pin する)。
 * signature・挙動は完全不変(呼出元は退会時の R2 prefix purge 等)。
 */
export async function listObjectsBounded(
  prefix: string,
  maxPages: number,
  opts?: { timeoutMs?: number },
): Promise<{ keys: string[]; truncated: boolean }> {
  const { entries, truncated } = await listPagesCore(prefix, maxPages, opts, (xml) =>
    Array.from(xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g), (match) => unescapeXmlEntities(match[1])),
  )
  return { keys: entries, truncated }
}

// `<Contents>` block 単位で Key と LastModified を対応付けて抽出する
// (`listObjectsWithMetaBounded` 専用)。 block 単位にする理由: 全体から <Key> を
// 全部・全体から <LastModified> を全部、という 2 つの独立 matchAll を index で
// 突き合わせる実装は、 R2 実測で block 内の要素順が Key/Size/LastModified/ETag/
// StorageClass(AWS の公開例=Key/LastModified/ETag/Size/StorageClass と順序が
// 異なる)こともあり、どちらかの tag が 1 件でも欠けると以降の組が丸ごとずれる。
// block を先に切り出し、その内側で <Key>/<LastModified> を探すことで tag の
// 出現順に依らず正しい組を保証する。
//
// fail-closed: <LastModified> が欠落/空/非ISO で `Date.parse` が NaN を返す、または
// <Key> が欠落している場合、この page 全体を throw で失敗させる(「age が読めない
// object は削除しない」という sweeper 側の上位不変条件を parse 層で保証する —
// 個別 entry を黙って落とすと、その object が sweep から永久に不可視になる)。
//
// fail-closed(format 厳格化・Codex round 2 指摘): `Date.parse` は ISO8601 以外にも
// タイムゾーン無し(`2026-08-09T01:09:31` — ローカル時刻として解釈され、UTC でない
// ランタイムでは epoch が最大 ±14h ずれる)・日付のみ(`2026-08-09`)・offset 形
// (`+09:00`)等、R2 が実際には返さない形式まで受理してしまう。JST(UTC+9)ランタイム
// でタイムゾーン無し値を解釈すると age が 9h 過大に出て、cutoff 6h を不当に跨いで
// まだ生きている object を削除しうる(spec §7 不変条件1違反)。R2/S3 実形式
// (`YYYY-MM-DDTHH:MM:SS[.sss]Z`)に regex で一致することを `Date.parse` の前に
// 要求する — offset 形は意図的に受容しない(R2 は常に `Z` を返すため、受容を
// 広げると今回塞ぐ穴が戻る)。regex 一致後も `Date.parse` の NaN 判定は残す
// (`2026-13-45T99:99:99Z` は regex には一致するが暦として不正で NaN になる —
// 2つの gate は独立に必要)。
//
// fail-closed(閉じタグ欠落・canonical/Codex 収束指摘 fix round 1): `<Contents>...
// </Contents>` の非貪欲 matchAll は、閉じタグに到達しない block を単に「見つから
// ない」ものとして無視する — root(`<ListBucketResult>`)/`<IsTruncated>` が健全な
// 200 応答でも、途中の <Contents> block だけが壊れていると「成功・ただし件数が
// 少ない」page として黙って返ってしまう(parseListObjectsPage が root 要素の開閉
// 検証で塞いだのと同じ失敗クラスが Contents block 単位で再発する)。full XML
// validation は不要 — 開始タグ `<Contents>` の出現数と実際に組めた block 数の
// parity(数の一致)だけを見る軽量な検証で、閉じタグ欠落/block 跨ぎの誤結合を
// 両方とも検出できる。
// R2/S3 実形式(`YYYY-MM-DDTHH:MM:SS[.sss]Z`)のみを受理する — 小数秒は任意
// (S3 は常に付けるが無しも受ける)。offset 形(`+09:00` 等)は意図的に受容しない
// (`parseContentsMeta` 上のコメント参照)。年/月/日/時/分/秒を capture group で
// 個別に取れるようにしておく(小数秒は round-trip 検証で比較しないため
// capture 不要 — 非 capturing group `(?:\.\d+)?` にしている)。
const R2_LAST_MODIFIED_FORMAT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/

/**
 * `<LastModified>` の生文字列を epoch ms へ変換する(3 gate: format regex →
 * `Date.parse` の NaN 判定 → 暦としての round-trip 妥当性)。 いずれかの gate に
 * 落ちたら `NaN` を返し、呼出側 `parseContentsMeta` が fail-closed へ倒す。
 *
 * round-trip 検証(Codex round 3 指摘): `Date.parse` は `2026-02-30T...Z`(存在
 * しない日付)を **3月2日として正規化**してしまい、NaN にも format 不一致にも
 * ならず素通りする(`2026-04-31` → 5/1 等も同様)。age が日単位でずれ、cutoff 6h
 * を不当に跨いでまだ生きている object を削除しうるため、`Date.parse` が返した
 * ms を UTC 暦フィールドへ戻し、入力の capture group と個別に突き合わせる。
 *
 * 実装選択(`toISOString()` の文字列比較でなくフィールド個別比較にした理由):
 * `toISOString()` は小数秒を常に3桁 `.sssZ` で返すため、入力の小数秒表記
 * (`.22Z` / `.220000Z` / 小数秒なし)ごとに文字列側を正規化するコードが要る。
 * 年/月/日/時/分/秒だけを個別比較すれば小数秒の桁数問題自体が発生しない
 * (比較対象に含めないため)。
 */
function parseR2LastModifiedMs(raw: string | undefined): number {
  if (raw === undefined) return NaN
  const fields = raw.match(R2_LAST_MODIFIED_FORMAT)
  if (!fields) return NaN
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return NaN
  const d = new Date(ms)
  const roundTripOk =
    d.getUTCFullYear() === Number(fields[1]) &&
    d.getUTCMonth() + 1 === Number(fields[2]) &&
    d.getUTCDate() === Number(fields[3]) &&
    d.getUTCHours() === Number(fields[4]) &&
    d.getUTCMinutes() === Number(fields[5]) &&
    d.getUTCSeconds() === Number(fields[6])
  return roundTripOk ? ms : NaN
}

function parseContentsMeta(xml: string, prefix: string): R2ObjectMeta[] {
  const openTagCount = (xml.match(/<Contents>/g) ?? []).length
  const blocks = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g))
  if (blocks.length !== openTagCount) {
    throw new Error(
      `listObjectsWithMetaBounded: malformed response — <Contents> open tag count (${openTagCount}) ` +
        `does not match matched block count (${blocks.length}) (prefix=${prefix}, bodyLength=${xml.length}) ` +
        `— refusing to treat a malformed/unclosed <Contents> block as an empty page`,
    )
  }

  const entries: R2ObjectMeta[] = []
  for (const contentsMatch of blocks) {
    const block = contentsMatch[1]
    const keyMatch = block.match(/<Key>([\s\S]*?)<\/Key>/)
    const lastModifiedMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)
    const lastModifiedMs = parseR2LastModifiedMs(lastModifiedMatch ? lastModifiedMatch[1] : undefined)
    if (!keyMatch || Number.isNaN(lastModifiedMs)) {
      throw new Error(
        `listObjectsWithMetaBounded: malformed response — <Contents> entry with missing <Key> or ` +
          `unparseable <LastModified> (prefix=${prefix}, bodyLength=${xml.length}) — refusing to treat the object's age as known`,
      )
    }
    entries.push({ key: unescapeXmlEntities(keyMatch[1]), lastModifiedMs })
  }
  return entries
}

/**
 * R2オブジェクトの一覧を LastModified 付きで bounded page 数で取得する(②-4b spec
 * §3.2 — src/ prefix の age-based sweeper が削除可否を判定するための入口)。
 * pagination 契約(継続 token の前進検証・`maxPages` 到達時の打ち切り・
 * `timeoutMs`)は `listObjectsBounded` と同一(`listPagesCore` を共有)。相違点は
 * 1 page 分の entry 抽出のみ: `<Contents>` block 単位で Key+LastModified を対応
 * 付け、LastModified が読めない entry があれば page 全体を throw する
 * (`parseContentsMeta` 参照)。
 */
export async function listObjectsWithMetaBounded(
  prefix: string,
  maxPages: number,
  opts?: { timeoutMs?: number },
): Promise<{ entries: R2ObjectMeta[]; truncated: boolean }> {
  return listPagesCore(prefix, maxPages, opts, (xml) => parseContentsMeta(xml, prefix))
}

/**
 * R2オブジェクトの一覧 (ListObjectsV2。 破壊 script(scripts/gc-src-prefix.ts等)が
 * 削除対象を DB を介さず R2 listing だけから求めるための唯一の口)。
 *
 * pagination を全列挙する (IsTruncated/NextContinuationToken を追随)。 token が
 * 欠落/非進行(壊れた応答の無限ループ)なら throw、 MAX_LIST_PAGES 超過でも throw
 * する (無限ループ耐性)。**実装は `listObjectsBounded(prefix, MAX_LIST_PAGES)` へ
 * 委譲**(②-4b spec §3.2)し、`truncated:true` を従来と同一文言の throw に変換する
 * だけ — signature・throw タイミング・文言を含め外部契約は完全に不変。
 *
 * **既存5関数(presignPutUrl/presignGetUrl/headObject/getObject/putObject/
 * deleteObject)の never-throw 契約を、この関数は意図的に継承しない — 失敗
 * (非2xx・fetch throw・timeout)は catch せずそのまま throw する。** 理由:
 * 本関数は破壊操作の事後検証(「削除後 readback = listing 0件」で削除完了を
 * 確認する)を支える。 失敗を空配列に正規化すると、 network 失敗時も
 * 「0件 = 削除完了」に見えてしまい検証そのものが無意味になる — 「空」と
 * 「分からない」を混同してはならない。
 */
export async function listObjects(prefix: string): Promise<string[]> {
  const { keys, truncated } = await listObjectsBounded(prefix, MAX_LIST_PAGES)
  if (truncated) {
    throw new Error(
      `listObjects: aborted after ${MAX_LIST_PAGES} pages (prefix=${prefix}) — ` +
        'pagination loop guard triggered',
    )
  }
  return keys
}

/**
 * R2オブジェクトの物理削除 (画像GC sweep がR2実体を消す唯一の口。 design spec §4.6)。
 *
 * success-equivalent判定: 2xx または 404 は「objectが存在しない」という望むend-stateに
 * 達しているとみなし ok:true を返す (spec §3-2: Cloudflareは実装済 + AWS S3は「object不在
 * でも204」と明文化されている挙動を踏襲)。DELETEは冪等なため再実行しても安全 — sweepが
 * crashしても次runが同じobjectKeyに再DELETEしてよい。
 *
 * headObjectと同じnever-throw契約: fetchのthrow/timeout(abort)はcatchし
 * `{ ok: false, status: null }` に正規化する。呼出側(reconciler)にtry/catchを強制しない。
 *
 * presigned DELETEは採用しない — 本関数はserver直DELETE専用 (reconcilerはserver環境の
 * scriptとして動くため、presign経由の間接呼び出しは不要)。
 *
 * `opts.timeoutMs`(②-4b spec §3.2): 省略時は既定 `DELETE_TIMEOUT_MS`(10s)のまま —
 * 既存呼出側は無改変で通る。`getObject` と同じ `{ timeoutMs }` idiom(退会 prefix
 * purge が残予算を渡す口)。
 */
export async function deleteObject(
  objectKey: string,
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; status: number | null }> {
  try {
    const res = await client.fetch(objectUrl(objectKey), {
      method: 'DELETE',
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DELETE_TIMEOUT_MS),
    })
    if (res.ok || res.status === 404) {
      return { ok: true, status: res.status }
    }
    return { ok: false, status: res.status }
  } catch {
    return { ok: false, status: null }
  }
}
