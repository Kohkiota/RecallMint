import { describe, it, expect, beforeEach, vi } from 'vitest'

// R2 接続モジュールの env fail-fast + presign + HEAD unit test。
// lib/stripe/client.test.ts と同形式: dynamic import('./r2') で module-load-time
// validation を再評価 (vitest.setup.ts の beforeEach 全体 vi.resetModules() 済)。
//
// presign は署名 digest を assert しない (時刻依存)。 URL 形状 (host/path) と
// query param の存在・値のみを assert する (brief 指定の deterministic な範囲)。

const ACCOUNT_ID = 'test-account-id'
const ACCESS_KEY_ID = 'test-access-key-id'
const SECRET_ACCESS_KEY = 'test-secret-access-key'
const BUCKET_NAME = 'test-bucket'

function setValidEnv() {
  process.env.R2_ACCOUNT_ID = ACCOUNT_ID
  process.env.R2_ACCESS_KEY_ID = ACCESS_KEY_ID
  process.env.R2_SECRET_ACCESS_KEY = SECRET_ACCESS_KEY
  process.env.R2_BUCKET_NAME = BUCKET_NAME
}

describe('R2 client - env fail-fast', () => {
  beforeEach(() => {
    setValidEnv()
  })

  it('unset R2_ACCOUNT_ID throws with message mentioning the key name', async () => {
    delete process.env.R2_ACCOUNT_ID
    await expect(import('./r2')).rejects.toThrow(/R2_ACCOUNT_ID/)
  })

  it('unset R2_ACCESS_KEY_ID throws with message mentioning the key name', async () => {
    delete process.env.R2_ACCESS_KEY_ID
    await expect(import('./r2')).rejects.toThrow(/R2_ACCESS_KEY_ID/)
  })

  it('unset R2_SECRET_ACCESS_KEY throws with message mentioning the key name', async () => {
    delete process.env.R2_SECRET_ACCESS_KEY
    await expect(import('./r2')).rejects.toThrow(/R2_SECRET_ACCESS_KEY/)
  })

  it('unset R2_BUCKET_NAME throws with message mentioning the key name', async () => {
    delete process.env.R2_BUCKET_NAME
    await expect(import('./r2')).rejects.toThrow(/R2_BUCKET_NAME/)
  })

  it('all 4 required vars present loads module successfully', async () => {
    const mod = await import('./r2')
    expect(mod.presignPutUrl).toBeInstanceOf(Function)
    expect(mod.presignGetUrl).toBeInstanceOf(Function)
    expect(mod.headObject).toBeInstanceOf(Function)
    expect(mod.deleteObject).toBeInstanceOf(Function)
  })
})

describe('presignPutUrl', () => {
  beforeEach(() => {
    setValidEnv()
  })

  it('returns a URL with the correct R2 host and bucket/objectKey path', async () => {
    const { presignPutUrl } = await import('./r2')
    const url = new URL(await presignPutUrl('users/u1/asset1.webp', 'image/webp', 1000))
    expect(url.hostname).toBe(`${ACCOUNT_ID}.r2.cloudflarestorage.com`)
    expect(url.pathname).toBe(`/${BUCKET_NAME}/users/u1/asset1.webp`)
  })

  it('sets X-Amz-Expires to the default 600 when expiresSec is omitted', async () => {
    const { presignPutUrl } = await import('./r2')
    const url = new URL(await presignPutUrl('users/u1/asset1.webp', 'image/webp', 1000))
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
  })

  it('sets X-Amz-Expires to the passed value when provided', async () => {
    const { presignPutUrl } = await import('./r2')
    const url = new URL(await presignPutUrl('users/u1/asset1.webp', 'image/webp', 1000, 120))
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120')
  })

  it('includes X-Amz-Algorithm, X-Amz-Credential (with access key + /auto/s3/), X-Amz-SignedHeaders, X-Amz-Signature', async () => {
    const { presignPutUrl } = await import('./r2')
    const url = new URL(await presignPutUrl('users/u1/asset1.webp', 'image/webp', 1000))
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toContain(ACCESS_KEY_ID)
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/')
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
  })

  it('X-Amz-SignedHeaders includes content-type (Content-Type is bound to the PUT signature)', async () => {
    const { presignPutUrl } = await import('./r2')
    const url = new URL(await presignPutUrl('users/u1/asset1.webp', 'image/webp', 1000))
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders')
    expect(signedHeaders).toContain('content-type')
  })

  it('X-Amz-SignedHeaders includes content-length (byteSize is bound to the PUT signature — storage size cap)', async () => {
    const { presignPutUrl } = await import('./r2')
    const url = new URL(await presignPutUrl('users/u1/asset1.webp', 'image/webp', 1000))
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders')
    expect(signedHeaders).toContain('content-length')
  })
})

describe('presignGetUrl', () => {
  beforeEach(() => {
    setValidEnv()
  })

  it('returns a URL with the correct R2 host and bucket/objectKey path', async () => {
    const { presignGetUrl } = await import('./r2')
    const url = new URL(await presignGetUrl('users/u1/asset1.webp'))
    expect(url.hostname).toBe(`${ACCOUNT_ID}.r2.cloudflarestorage.com`)
    expect(url.pathname).toBe(`/${BUCKET_NAME}/users/u1/asset1.webp`)
  })

  it('sets X-Amz-Expires to the default 600 when expiresSec is omitted', async () => {
    const { presignGetUrl } = await import('./r2')
    const url = new URL(await presignGetUrl('users/u1/asset1.webp'))
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
  })

  it('sets X-Amz-Expires to the passed value when provided', async () => {
    const { presignGetUrl } = await import('./r2')
    const url = new URL(await presignGetUrl('users/u1/asset1.webp', 300))
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
  })

  it('includes X-Amz-Algorithm, X-Amz-Credential, X-Amz-Signature', async () => {
    const { presignGetUrl } = await import('./r2')
    const url = new URL(await presignGetUrl('users/u1/asset1.webp'))
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toContain(ACCESS_KEY_ID)
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
  })
})

describe('headObject', () => {
  beforeEach(() => {
    setValidEnv()
    vi.restoreAllMocks()
  })

  it('returns exists:true and parsed contentLength when the response is ok with a content-length header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'content-length': '12345' },
      }),
    )
    const { headObject } = await import('./r2')
    const result = await headObject('users/u1/asset1.webp')
    expect(result).toEqual({ exists: true, contentLength: 12345 })
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('issues a HEAD request against the object URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200, headers: { 'content-length': '1' } }),
    )
    const { headObject } = await import('./r2')
    await headObject('users/u1/asset1.webp')
    const request = fetchSpy.mock.calls[0][0] as Request
    expect(request.method).toBe('HEAD')
    expect(request.signal).toBeInstanceOf(AbortSignal)
    const url = new URL(request.url)
    expect(url.pathname).toBe(`/${BUCKET_NAME}/users/u1/asset1.webp`)
  })

  it('returns exists:true and contentLength:null when content-length header is absent on an ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    const { headObject } = await import('./r2')
    const result = await headObject('users/u1/asset1.webp')
    expect(result).toEqual({ exists: true, contentLength: null })
  })

  it('normalizes a non-numeric content-length to null (not NaN) on an ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200, headers: { 'content-length': 'abc' } }),
    )
    const { headObject } = await import('./r2')
    const result = await headObject('users/u1/asset1.webp')
    expect(result).toEqual({ exists: true, contentLength: null })
  })

  it('returns exists:false and contentLength:null when the response is not ok (e.g. 404)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
    const { headObject } = await import('./r2')
    const result = await headObject('users/u1/asset1.webp')
    expect(result).toEqual({ exists: false, contentLength: null })
  })

  it('does not retry on 5xx (retries:0) so the HEAD timeout is not defeated by backoff', async () => {
    // retries 既定(10)だと 5xx で指数 backoff retry し 10s timeout を超えて block する。
    // retries:0 を証明: 500 に対し fetch はちょうど 1 回だけ呼ばれ即 exists:false を返す。
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 500 }))
    const { headObject } = await import('./r2')
    const result = await headObject('users/u1/asset1.webp')
    expect(result).toEqual({ exists: false, contentLength: null })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('returns exists:false and contentLength:null when fetch throws (network error / abort)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))
    const { headObject } = await import('./r2')
    const result = await headObject('users/u1/asset1.webp')
    expect(result).toEqual({ exists: false, contentLength: null })
  })
})

describe('deleteObject', () => {
  beforeEach(() => {
    setValidEnv()
    vi.restoreAllMocks()
  })

  it('issues a DELETE request against the object URL with a timeout signal', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const { deleteObject } = await import('./r2')
    await deleteObject('users/u1/asset1.webp')
    const request = fetchSpy.mock.calls[0][0] as Request
    expect(request.method).toBe('DELETE')
    expect(request.signal).toBeInstanceOf(AbortSignal)
    const url = new URL(request.url)
    expect(url.pathname).toBe(`/${BUCKET_NAME}/users/u1/asset1.webp`)
  })

  it('returns ok:true with the response status on a 2xx response (204)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const { deleteObject } = await import('./r2')
    const result = await deleteObject('users/u1/asset1.webp')
    expect(result).toEqual({ ok: true, status: 204 })
  })

  it('returns ok:true with the response status on a 2xx response (200)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    const { deleteObject } = await import('./r2')
    const result = await deleteObject('users/u1/asset1.webp')
    expect(result).toEqual({ ok: true, status: 200 })
  })

  it('returns ok:true with status 404 (object already absent = success-equivalent end-state)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
    const { deleteObject } = await import('./r2')
    const result = await deleteObject('users/u1/asset1.webp')
    expect(result).toEqual({ ok: true, status: 404 })
  })

  it('returns ok:false with the response status on a non-2xx/404 response (500)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }))
    const { deleteObject } = await import('./r2')
    const result = await deleteObject('users/u1/asset1.webp')
    expect(result).toEqual({ ok: false, status: 500 })
    // retries:0 も継承していること (headObject と同じ client) を1回呼び出しで確認
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('returns ok:false and status:null when fetch throws (network error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('network error'))
    const { deleteObject } = await import('./r2')
    const result = await deleteObject('users/u1/asset1.webp')
    expect(result).toEqual({ ok: false, status: null })
  })

  it('returns ok:false and status:null when fetch throws due to timeout (abort)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('The operation timed out', 'TimeoutError'))
    const { deleteObject } = await import('./r2')
    const result = await deleteObject('users/u1/asset1.webp')
    expect(result).toEqual({ ok: false, status: null })
  })
})

describe('putObject Content-Length', () => {
  beforeEach(() => {
    setValidEnv()
  })

  it('sends an explicit Content-Length header (R2 requires it for PUT; missing → 411)', async () => {
    // ②-4a smoke fix: aws4fetch/undici は Content-Length を省くと chunked で送り、R2 は
    // PUT に Content-Length を要求するため 411(Length Required)を返す(finalize の最終
    // key PUT / crop の PUT が 411 で失敗した)。putObject が Content-Length を明示すること
    // を回帰 pin する。aws4fetch は署名後に global fetch を Request で呼ぶ。
    let capturedReq: Request | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedReq = input as Request
      return new Response(null, { status: 200 })
    })
    const { putObject } = await import('./r2')
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70]) // 7 bytes
    const result = await putObject('users/u1/src/a1.webp', bytes, 'image/webp')
    expect(result).toBe('success')
    expect(capturedReq).toBeDefined()
    expect(capturedReq!.headers.get('content-length')).toBe('7')
  })
})
