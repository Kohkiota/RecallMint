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
