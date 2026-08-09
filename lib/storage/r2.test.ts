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

describe('getObject', () => {
  beforeEach(() => {
    setValidEnv()
    vi.restoreAllMocks()
  })

  it('returns { bytes } from the response body on an ok response', async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    const { getObject } = await import('./r2')
    const result = await getObject('src/u1/idem1/f1.pdf')
    expect(result).not.toBeNull()
    expect(Buffer.compare(result!.bytes, Buffer.from(body))).toBe(0)
  })

  it('issues a GET request against the object URL', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }))
    const { getObject } = await import('./r2')
    await getObject('src/u1/idem1/f1.pdf')
    const request = fetchSpy.mock.calls[0][0] as Request
    expect(request.method).toBe('GET')
    const url = new URL(request.url)
    expect(url.pathname).toBe(`/${BUCKET_NAME}/src/u1/idem1/f1.pdf`)
  })

  it('returns null when the response is not ok (e.g. 404)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
    const { getObject } = await import('./r2')
    const result = await getObject('src/u1/idem1/f1.pdf')
    expect(result).toBeNull()
  })

  it('returns null when fetch throws (network error / abort)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation was aborted', 'AbortError'),
    )
    const { getObject } = await import('./r2')
    const result = await getObject('src/u1/idem1/f1.pdf')
    expect(result).toBeNull()
  })

  // ②-4b: opts.timeoutMs が AbortSignal.timeout へ渡ることを pin する(省略時は
  // 既定 GET_TIMEOUT_MS=10s のまま=既存呼出無改変)。
  it('uses the default 10s timeout when opts.timeoutMs is omitted', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }))
    const { getObject } = await import('./r2')
    await getObject('src/u1/idem1/f1.pdf')
    expect(timeoutSpy).toHaveBeenCalledWith(10_000)
  })

  it('passes opts.timeoutMs through to AbortSignal.timeout when provided', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }))
    const { getObject } = await import('./r2')
    await getObject('src/u1/idem1/f1.pdf', { timeoutMs: 60_000 })
    expect(timeoutSpy).toHaveBeenCalledWith(60_000)
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

  // ②-4b: opts.timeoutMs が AbortSignal.timeout へ渡ることを pin する(getObject と
  // 同じ idiom。省略時は既定 DELETE_TIMEOUT_MS=10s のまま=既存呼出 3 箇所は無改変)。
  it('uses the default 10s DELETE_TIMEOUT_MS when opts.timeoutMs is omitted', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const { deleteObject } = await import('./r2')
    await deleteObject('users/u1/asset1.webp')
    expect(timeoutSpy).toHaveBeenCalledWith(10_000)
  })

  it('passes opts.timeoutMs through to AbortSignal.timeout when provided', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const { deleteObject } = await import('./r2')
    await deleteObject('users/u1/asset1.webp', { timeoutMs: 30_000 })
    expect(timeoutSpy).toHaveBeenCalledWith(30_000)
  })
})

describe('listObjects', () => {
  beforeEach(() => {
    setValidEnv()
    vi.restoreAllMocks()
  })

  function listObjectsXml(keys: string[], opts: { truncated?: boolean; nextToken?: string } = {}) {
    const keyXml = keys.map((k) => `<Key>${k}</Key>`).join('')
    const truncatedXml = `<IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>`
    const tokenXml = opts.nextToken
      ? `<NextContinuationToken>${opts.nextToken}</NextContinuationToken>`
      : ''
    return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${truncatedXml}${tokenXml}${keyXml}</ListBucketResult>`
  }

  it('issues a GET against the bucket root with list-type=2 and the given prefix', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(listObjectsXml(['users/u1/src/a.pdf']), { status: 200 }))
    const { listObjects } = await import('./r2')
    await listObjects('users/u1/src/')
    const request = fetchSpy.mock.calls[0][0] as Request
    expect(request.method).toBe('GET')
    const url = new URL(request.url)
    expect(url.pathname).toBe(`/${BUCKET_NAME}`)
    expect(url.searchParams.get('list-type')).toBe('2')
    expect(url.searchParams.get('prefix')).toBe('users/u1/src/')
  })

  it('paginates: follows NextContinuationToken and returns keys from both pages', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          listObjectsXml(['users/u1/src/a.pdf', 'users/u1/src/b.pdf'], {
            truncated: true,
            nextToken: 'token-page-2',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(listObjectsXml(['users/u1/src/c.pdf']), { status: 200 }),
      )
    const { listObjects } = await import('./r2')
    const keys = await listObjects('users/u1/src/')
    expect(keys).toEqual(['users/u1/src/a.pdf', 'users/u1/src/b.pdf', 'users/u1/src/c.pdf'])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const secondRequest = fetchSpy.mock.calls[1][0] as Request
    const secondUrl = new URL(secondRequest.url)
    expect(secondUrl.searchParams.get('continuation-token')).toBe('token-page-2')
  })

  it('unescapes XML entities in returned keys', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(listObjectsXml(['users/u1/src/a&amp;b.pdf']), { status: 200 }),
    )
    const { listObjects } = await import('./r2')
    const keys = await listObjects('users/u1/src/')
    expect(keys).toEqual(['users/u1/src/a&b.pdf'])
  })

  it('throws (does not return an empty array) on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }))
    const { listObjects } = await import('./r2')
    await expect(listObjects('users/u1/src/')).rejects.toThrow(/listObjects failed/)
  })

  it('throws (does not return an empty array) when fetch throws (network error / abort)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))
    const { listObjects } = await import('./r2')
    await expect(listObjects('users/u1/src/')).rejects.toThrow()
  })

  it('throws when IsTruncated=true but NextContinuationToken is missing (refuses to loop forever)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(listObjectsXml(['users/u1/src/a.pdf'], { truncated: true }), { status: 200 }),
    )
    const { listObjects } = await import('./r2')
    await expect(listObjects('users/u1/src/')).rejects.toThrow(/NextContinuationToken/)
  })

  // Codex fix round 1 (P1): a 200 response with a malformed/empty/truncated body
  // must not silently be treated as "0 keys" — that would let a destructive
  // script's post-delete readback misread "can't tell" as "confirmed empty".
  it('throws on a 200 response with a completely empty body (does not silently return [])', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    const { listObjects } = await import('./r2')
    await expect(listObjects('users/u1/src/')).rejects.toThrow(/malformed response/)
  })

  it('throws on a 200 response missing <IsTruncated> even though the root element is present and closed', async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Key>users/u1/src/a.pdf</Key></ListBucketResult>'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(xml, { status: 200 }))
    const { listObjects } = await import('./r2')
    await expect(listObjects('users/u1/src/')).rejects.toThrow(/malformed response/)
  })

  it('throws on a 200 response whose root element is never closed (body cut off mid-stream)', async () => {
    // truncated mid-<Key>: no </ListBucketResult> ever appears.
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated><Key>users/u1/src/a.p'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(xml, { status: 200 }))
    const { listObjects } = await import('./r2')
    await expect(listObjects('users/u1/src/')).rejects.toThrow(/malformed response/)
  })

  // ②-4b pin②: listObjects は listObjectsBounded(prefix, MAX_LIST_PAGES) へ委譲するが、
  // maxPages 到達(=truncated:true)を従来と**文言同一**の throw に変換する契約を保つ
  // (既存 test が regex で pin している契約の維持を明示的に確認する)。MAX_LIST_PAGES
  // は r2.ts 内部定数(非export)につき、値 10000 は throw message から観測する。
  it(
    'MAX_LIST_PAGES cap: still throws with the legacy pagination-guard message after delegating to listObjectsBounded',
    async () => {
      let callCount = 0
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        callCount++
        return new Response(
          listObjectsXml([], { truncated: true, nextToken: `token-${callCount}` }),
          { status: 200 },
        )
      })
      const { listObjects } = await import('./r2')
      await expect(listObjects('users/u1/src/')).rejects.toThrow(
        /listObjects: aborted after 10000 pages \(prefix=users\/u1\/src\/\) — pagination loop guard triggered/,
      )
      expect(callCount).toBe(10_000)
    },
    20_000,
  )
})

describe('listObjectsBounded', () => {
  beforeEach(() => {
    setValidEnv()
    vi.restoreAllMocks()
  })

  // listObjects describe 内の同名 helper と同一実装(local scope のため複製・
  // 既存 describe を触らないための独立コピー)。
  function listObjectsXml(keys: string[], opts: { truncated?: boolean; nextToken?: string } = {}) {
    const keyXml = keys.map((k) => `<Key>${k}</Key>`).join('')
    const truncatedXml = `<IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>`
    const tokenXml = opts.nextToken
      ? `<NextContinuationToken>${opts.nextToken}</NextContinuationToken>`
      : ''
    return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${truncatedXml}${tokenXml}${keyXml}</ListBucketResult>`
  }

  // pin①: maxPages 到達で throw せず { truncated: true } + 収集済み keys を返す
  // (listObjects の throw 契約とは非対称 — 呼出元の退会 prefix purge は「上限で
  // 打ち切ったが取れた分の削除は続行する」ため throw では扱えない・spec §3.2)。
  it('returns { truncated: true } with the keys collected so far instead of throwing when maxPages is reached', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          listObjectsXml(['users/u1/src/a.pdf'], { truncated: true, nextToken: 'token-2' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          listObjectsXml(['users/u1/src/b.pdf'], { truncated: true, nextToken: 'token-3' }),
          { status: 200 },
        ),
      )
    const { listObjectsBounded } = await import('./r2')
    const result = await listObjectsBounded('users/u1/src/', 2)
    expect(result).toEqual({
      keys: ['users/u1/src/a.pdf', 'users/u1/src/b.pdf'],
      truncated: true,
    })
  })

  // pin④: 境界 maxPages=1 × IsTruncated=true — 1 page だけ fetch し truncated:true。
  it('maxPages=1 boundary with IsTruncated=true: fetches exactly 1 page and reports truncated:true', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          listObjectsXml(['users/u1/src/a.pdf'], { truncated: true, nextToken: 'token-2' }),
          { status: 200 },
        ),
      )
    const { listObjectsBounded } = await import('./r2')
    const result = await listObjectsBounded('users/u1/src/', 1)
    expect(result).toEqual({ keys: ['users/u1/src/a.pdf'], truncated: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // pin④: 境界 maxPages=1 × IsTruncated=false — 1 page で完了・truncated:false。
  it('maxPages=1 boundary with IsTruncated=false: fetches exactly 1 page and reports truncated:false', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(listObjectsXml(['users/u1/src/a.pdf'], { truncated: false }), { status: 200 }),
      )
    const { listObjectsBounded } = await import('./r2')
    const result = await listObjectsBounded('users/u1/src/', 1)
    expect(result).toEqual({ keys: ['users/u1/src/a.pdf'], truncated: false })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // pin③: maxPages の不正値は fail-fast reject する(数値引数を public にする以上、
  // 型だけでは不正入力を防げない)。fetch が一切呼ばれないこと(network 到達前に
  // 検証が効くこと)も確認する。
  it.each([0, -1, 1.5, NaN, Infinity])(
    'rejects maxPages=%p (not a positive integer) without calling fetch',
    async (invalidMaxPages) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const { listObjectsBounded } = await import('./r2')
      await expect(listObjectsBounded('users/u1/src/', invalidMaxPages)).rejects.toThrow(
        /maxPages must be a positive integer/,
      )
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  // pin⑤: opts.timeoutMs 省略時は既定 LIST_TIMEOUT_MS(10s)のまま(既存 listObjects
  // 経由の呼出は無改変で通る)。
  it('uses the default 10s LIST_TIMEOUT_MS when opts.timeoutMs is omitted', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(listObjectsXml(['users/u1/src/a.pdf']), { status: 200 }),
    )
    const { listObjectsBounded } = await import('./r2')
    await listObjectsBounded('users/u1/src/', 10)
    expect(timeoutSpy).toHaveBeenCalledWith(10_000)
  })

  // pin⑤: opts.timeoutMs 指定時は各 page fetch の AbortSignal.timeout に反映される
  // (退会 prefix purge が残予算を渡す口・getObject と同じ idiom)。
  it('passes opts.timeoutMs through to AbortSignal.timeout for each page fetch', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(listObjectsXml(['users/u1/src/a.pdf']), { status: 200 }),
    )
    const { listObjectsBounded } = await import('./r2')
    await listObjectsBounded('users/u1/src/', 10, { timeoutMs: 5_000 })
    expect(timeoutSpy).toHaveBeenCalledWith(5_000)
  })
})

describe('listObjectsWithMetaBounded', () => {
  beforeEach(() => {
    setValidEnv()
    vi.restoreAllMocks()
  })

  // ②-4b §3 Task 1: <Contents> block 単位で Key + LastModified を組み立てる XML
  // helper。 `swapOrder` で block 内の <LastModified>/<Key> の出現順を入れ替えられる
  // (順序入替 XML でも組が崩れないことを確認する pin①用)。 `lastModified: undefined`
  // (省略)は <LastModified> tag 自体を出さない(欠落ケース)。
  function listObjectsMetaXml(
    entries: Array<{ key: string; lastModified?: string; swapOrder?: boolean }>,
    opts: { truncated?: boolean; nextToken?: string } = {},
  ) {
    const contentsXml = entries
      .map((e) => {
        const keyTag = `<Key>${e.key}</Key>`
        const lastModifiedTag =
          e.lastModified !== undefined ? `<LastModified>${e.lastModified}</LastModified>` : ''
        return e.swapOrder
          ? `<Contents>${lastModifiedTag}${keyTag}</Contents>`
          : `<Contents>${keyTag}${lastModifiedTag}</Contents>`
      })
      .join('')
    const truncatedXml = `<IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>`
    const tokenXml = opts.nextToken
      ? `<NextContinuationToken>${opts.nextToken}</NextContinuationToken>`
      : ''
    return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${truncatedXml}${tokenXml}${contentsXml}</ListBucketResult>`
  }

  // pin①: <Contents> block 単位の Key/LastModified 対応付け。 2 件目は block 内で
  // <LastModified> が <Key> より先に出現する(R2 実測の要素順は Key, Size,
  // LastModified, ETag, StorageClass — AWS の公開例と順序が異なるため、tag 出現順に
  // 依存しない実装であることを確認する)。 2 つの独立 matchAll を index で突き合わせる
  // 実装だと、この swap では組がずれないので落ちない — mutation で個別に確認する
  // (report 参照)。
  it('pairs Key and LastModified per <Contents> block even when element order is swapped within a block', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([
          { key: 'src/u1/idem1/a.pdf', lastModified: '2026-08-09T01:09:31.220Z' },
          { key: 'src/u1/idem1/b.pdf', lastModified: '2026-08-08T00:00:00.000Z', swapOrder: true },
        ]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    const result = await listObjectsWithMetaBounded('src/u1/idem1/', 10)
    expect(result).toEqual({
      entries: [
        { key: 'src/u1/idem1/a.pdf', lastModifiedMs: 1786237771220 },
        { key: 'src/u1/idem1/b.pdf', lastModifiedMs: Date.parse('2026-08-08T00:00:00.000Z') },
      ],
      truncated: false,
    })
  })

  // pin②(正例): R2 実形式(ミリ秒付き ISO8601 + Z)を epoch ms へ正しく parse する。
  // 値は独立算出した pin(`Date.parse` を assertion 内で呼ばない — 実装のバグで
  // Date.parse の呼び方自体が壊れても検出できるようにする)。
  it('parses R2-format LastModified (ms-precision ISO8601 with Z) into the exact epoch ms', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: '2026-08-09T01:09:31.220Z' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    const result = await listObjectsWithMetaBounded('src/u1/idem1/', 10)
    expect(result.entries).toEqual([{ key: 'src/u1/idem1/a.pdf', lastModifiedMs: 1786237771220 }])
  })

  // pin②(負例 a): <LastModified> tag 自体が欠落 → page 全体を throw(fail-closed —
  // 「age が読めない object は削除しない」を parse 層で保証する)。
  it('throws when a <Contents> block is missing <LastModified> entirely (fail-closed)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf' }]), { status: 200 }),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // pin②(負例 b): 非 ISO 文字列(Date.parse が NaN を返す)→ throw。
  it('throws when <LastModified> is not a parseable date (non-ISO string)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: 'not-a-date' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // pin②(負例 c): 空文字 → throw(`Date.parse('')` は NaN)。
  it('throws when <LastModified> is an empty string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: '' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // 制約④(2つの独立 matchAll を index で突き合わせる実装は不可)の discriminating
  // test: 中間の <Contents> block が <Key> を欠く(<LastModified> はある)場合、
  // 「全体から Key を全部・全体から LastModified を全部」を index で zip する実装は
  // 個数が食い違うぶん後続の組がずれ、3件目の Key に2件目の LastModified が
  // 静かに誤対応してしまう(NaN にならないため fail-closed の NaN チェックも
  // すり抜ける)。block 単位実装は該当 block の <Key> 欠落そのもので即 throw する
  // ため、この XML は必ず throw になるはず — mutation で実際に区別を確認した
  // (report 参照: 素朴な index-zip 実装に差し替えると本 test だけが green のまま
  // 通ってしまう=検出できない。 この test を追加して初めて検出できるようになった)。
  it('does not silently mispair Key/LastModified across blocks when a middle <Contents> block lacks <Key>', async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      '<Contents><Key>src/u1/idem1/a.pdf</Key><LastModified>2026-08-09T01:09:31.220Z</LastModified></Contents>' +
      '<Contents><LastModified>2026-08-07T00:00:00.000Z</LastModified></Contents>' +
      '<Contents><Key>src/u1/idem1/c.pdf</Key><LastModified>2026-08-06T00:00:00.000Z</LastModified></Contents>' +
      '</ListBucketResult>'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(xml, { status: 200 }))
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // Codex round 2 指摘: R2/S3 実形式(`YYYY-MM-DDTHH:MM:SS[.sss]Z`)以外は
  // `Date.parse` が NaN を返さず解釈してしまうため、format regex で追加拒否する
  // (詳細は r2.ts の `R2_LAST_MODIFIED_FORMAT` コメント参照)。
  // 負例②: タイムゾーン無し — ローカル時刻解釈により UTC でないランタイムで
  // age が最大 ±14h ずれ、cutoff 6h を不当に跨いで生きている object を削除しうる。
  it('throws when <LastModified> has no timezone designator (would be interpreted as local time)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: '2026-08-09T01:09:31' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // 負例③: 日付のみ(`Date.parse` は UTC 解釈で通ってしまうが R2 実形式ではない)。
  it('throws when <LastModified> is date-only (no time component)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: '2026-08-09' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // 負例④: offset 形(`+09:00`)— R2 は常に `Z` を返すため意図的に受容しない
  // (受容を広げると round 2 で塞ぐ穴が戻る)。
  it('throws when <LastModified> uses a UTC offset instead of Z (R2 always returns Z)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: '2026-08-09T01:09:31+09:00' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // 負例⑤: format regex は通るが暦として不正(`Date.parse` が NaN を返す)場合も
  // throw する — format regex と NaN 判定は独立した2つの gate であることを pin
  // (round 2 の完了条件: format regex だけ通しても NaN 判定は残す)。
  it('throws when <LastModified> matches the format regex but is not a valid calendar date (NaN gate still applies)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: '2026-13-45T99:99:99Z' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // 正例(round 2 追加): 小数秒なしの R2/S3 実形式(`YYYY-MM-DDTHH:MM:SSZ`)は
  // 受理される(S3 は常に小数秒を付けるが、format regex は任意にしている)。
  it('accepts R2-format LastModified without fractional seconds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: '2026-08-09T01:09:31Z' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    const result = await listObjectsWithMetaBounded('src/u1/idem1/', 10)
    expect(result.entries).toEqual([{ key: 'src/u1/idem1/a.pdf', lastModifiedMs: 1786237771000 }])
  })

  // Codex round 3 指摘: format regex を通っても `Date.parse` は暦として存在しない
  // 日付を正規化してしまう(Feb 30 → 3/2 等)。NaN にも format 不一致にもならず
  // 素通りするため、round-trip 検証(暦フィールド突き合わせ)で追加拒否する。
  // 負例①: 2月30日は存在しない(`Date.parse` は3月2日として正規化する)。
  it('throws when <LastModified> is a calendar-invalid date normalized by Date.parse (Feb 30 -> Mar 2)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: '2026-02-30T01:00:00Z' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // 負例②: 4月31日は存在しない(`Date.parse` は5月1日として正規化する)。
  it('throws when <LastModified> is a calendar-invalid date normalized by Date.parse (Apr 31 -> May 1)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: '2026-04-31T01:00:00Z' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // 正例(round 3 回帰確認): うるう年の2月29日は正当な日付であり round-trip 検証を
  // 通らなければならない(round-trip gate が正しい日付まで誤って弾かないこと)。
  it('accepts a valid leap-year date (2028-02-29, round-trip gate must not over-reject)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified: '2028-02-29T01:00:00Z' }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    const result = await listObjectsWithMetaBounded('src/u1/idem1/', 10)
    expect(result.entries).toEqual([{ key: 'src/u1/idem1/a.pdf', lastModifiedMs: 1835398800000 }])
  })

  // 正例(round 3 回帰確認): 小数秒の桁数違い(2桁 `.22Z` / 6桁 `.220000Z`)を
  // round-trip 検証が誤って弾かないこと — 実装は小数秒を比較対象に含めていない
  // (Y/M/D/h/m/s のみ比較)ため、桁数に関わらず通る設計であることを pin する。
  it.each([
    ['2026-08-09T01:09:31.22Z', 1786237771220],
    ['2026-08-09T01:09:31.220000Z', 1786237771220],
  ])('accepts fractional-second digit-count variant %s without over-rejecting', async (lastModified, expectedMs) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([{ key: 'src/u1/idem1/a.pdf', lastModified }]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    const result = await listObjectsWithMetaBounded('src/u1/idem1/', 10)
    expect(result.entries).toEqual([{ key: 'src/u1/idem1/a.pdf', lastModifiedMs: expectedMs }])
  })

  // canonical + Codex 収束指摘(fix round 1): 2件目の <Contents> block が
  // </Contents> を欠く(壊れた 200 応答)が、root(<ListBucketResult>)と
  // <IsTruncated> は健全なため既存の parseListObjectsPage 検証はすり抜ける。
  // <Contents>...<\/Contents> の非貪欲 matchAll は「閉じタグに到達しない block」を
  // 単に「見つからない」ものとして無視し、1件目だけの「成功・ただし件数が少ない」
  // page として黙って返してしまう — parseListObjectsPage が root 要素の開閉検証で
  // 塞いだのと同じ失敗クラスが Contents block 単位で再発する。開始タグ数と実際に
  // 組めた block 数の parity 検証で検出し throw する。
  it('throws when a <Contents> block is unclosed (missing </Contents>) even though root/IsTruncated are healthy', async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      '<Contents><Key>src/u1/idem1/a.pdf</Key><LastModified>2026-08-09T01:09:31.220Z</LastModified></Contents>' +
      '<Contents><Key>src/u1/idem1/b.pdf</Key><LastModified>2026-08-08T00:00:00.000Z</LastModified>' +
      '</ListBucketResult>'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(xml, { status: 200 }))
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 10)).rejects.toThrow(/malformed response/)
  })

  // pin③: truncated/token 前進の既存挙動(listObjectsBounded と同じ pagination core)
  // が entries 版でも成立する — 2 page を跨いで NextContinuationToken を追随する。
  it('paginates: follows NextContinuationToken and returns entries from both pages', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          listObjectsMetaXml(
            [{ key: 'src/u1/idem1/a.pdf', lastModified: '2026-08-09T01:09:31.220Z' }],
            { truncated: true, nextToken: 'token-page-2' },
          ),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          listObjectsMetaXml([{ key: 'src/u1/idem1/b.pdf', lastModified: '2026-08-08T00:00:00.000Z' }]),
          { status: 200 },
        ),
      )
    const { listObjectsWithMetaBounded } = await import('./r2')
    const result = await listObjectsWithMetaBounded('src/u1/idem1/', 10)
    expect(result).toEqual({
      entries: [
        { key: 'src/u1/idem1/a.pdf', lastModifiedMs: 1786237771220 },
        { key: 'src/u1/idem1/b.pdf', lastModifiedMs: Date.parse('2026-08-08T00:00:00.000Z') },
      ],
      truncated: false,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const secondRequest = fetchSpy.mock.calls[1][0] as Request
    const secondUrl = new URL(secondRequest.url)
    expect(secondUrl.searchParams.get('continuation-token')).toBe('token-page-2')
  })

  // pin③: maxPages 到達で throw せず { truncated: true } + 収集済み entries を返す
  // (listObjectsBounded の pin①と同じ非 throw 契約が entries 版でも成立する)。
  it('returns { truncated: true } with entries collected so far instead of throwing when maxPages is reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        listObjectsMetaXml(
          [{ key: 'src/u1/idem1/a.pdf', lastModified: '2026-08-09T01:09:31.220Z' }],
          { truncated: true, nextToken: 'token-2' },
        ),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    const result = await listObjectsWithMetaBounded('src/u1/idem1/', 1)
    expect(result).toEqual({
      entries: [{ key: 'src/u1/idem1/a.pdf', lastModifiedMs: 1786237771220 }],
      truncated: true,
    })
  })

  // 制約①(二重実装禁止)の regression pin: maxPages の fail-fast 検証が
  // listObjectsBounded と同じ core を経由していることを、同じ挙動(fetch 未到達で
  // reject)で確認する。
  it('rejects maxPages that are not a positive integer without calling fetch (shares core validation with listObjectsBounded)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { listObjectsWithMetaBounded } = await import('./r2')
    await expect(listObjectsWithMetaBounded('src/u1/idem1/', 0)).rejects.toThrow(
      /maxPages must be a positive integer/,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // ④の補強: Key 抽出仕様(XML entity unescape)は listObjects/listObjectsBounded と
  // 不変のはずだが、meta 版は <Contents> block 単位の独自 regex で Key を抽出する
  // 新しいコード経路のため、既存 test(listObjects describe)だけでは検証されない。
  it('unescapes XML entities in returned keys (same escaping contract as listObjects)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        listObjectsMetaXml([
          { key: 'src/u1/idem1/a&amp;b.pdf', lastModified: '2026-08-09T01:09:31.220Z' },
        ]),
        { status: 200 },
      ),
    )
    const { listObjectsWithMetaBounded } = await import('./r2')
    const result = await listObjectsWithMetaBounded('src/u1/idem1/', 10)
    expect(result.entries).toEqual([{ key: 'src/u1/idem1/a&b.pdf', lastModifiedMs: 1786237771220 }])
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
