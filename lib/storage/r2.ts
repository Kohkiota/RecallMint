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
 * Content-Typeを署名に含める (aws4fetchのs3+signQueryは既定でcontent-typeを
 * UNSIGNABLE_HEADERS扱いし除外するため、 `aws.allHeaders: true` で強制的に
 * signed headersへ含める — brief記載の検証事項。 これによりPUT時に異なる
 * Content-Typeを送ると署名不一致でR2が拒否する = Content-Typeがpresignに固定される)。
 */
export async function presignPutUrl(
  objectKey: string,
  mime: string,
  expiresSec: number = DEFAULT_EXPIRES_SEC,
): Promise<string> {
  const url = new URL(objectUrl(objectKey))
  url.searchParams.set('X-Amz-Expires', String(expiresSec))
  const signed = await client.sign(url.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': mime },
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
