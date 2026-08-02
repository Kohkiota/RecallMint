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
const DELETE_TIMEOUT_MS = 10_000

// GET (finalize saga の実バイト取得)・PUT (finalize saga の最終 immutable key への
// server 書込) のnetwork timeout。 HEAD_TIMEOUT_MS/DELETE_TIMEOUT_MSと同値 (CLAUDE.md AI-2)。
const GET_TIMEOUT_MS = 10_000
const PUT_TIMEOUT_MS = 10_000

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
 * headObject/deleteObject と同じ never-throw契約: fetchのthrow/timeout(abort)・
 * 非2xx(404含む)はcatchせずnullに正規化する。 呼出側(finalize)にtry/catchを
 * 強制せず、 「検証不能」を一律 null で扱えるようにする。
 */
export async function getObject(
  objectKey: string,
): Promise<{ bytes: Buffer } | null> {
  try {
    const res = await client.fetch(objectUrl(objectKey), {
      method: 'GET',
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
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
 */
export async function deleteObject(
  objectKey: string,
): Promise<{ ok: boolean; status: number | null }> {
  try {
    const res = await client.fetch(objectUrl(objectKey), {
      method: 'DELETE',
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    })
    if (res.ok || res.status === 404) {
      return { ok: true, status: res.status }
    }
    return { ok: false, status: res.status }
  } catch {
    return { ok: false, status: null }
  }
}
