// audit §10.4 #11、 T-A9 重要 fix (削除 + 認証)。
//
// HMAC-SHA256 + ttl 24h signed token。 削除 status polling URL (/api/me/deletion-status)
// の query parameter を `userId` 直接受領から signed token 経由に置換し、 他者
// userId での polling = 削除 status 漏洩を排除する。
//
// token format = `<userIdB64>.<expB64>.<hmacB64>` (全 segment base64url)
//   userIdB64 = base64url(clerk user id, ascii bytes)
//   expB64    = base64url(unix ms timestamp as decimal string)
//   hmacB64   = base64url(HMAC-SHA256(`${userIdB64}.${expB64}`, secret))
//
// verify 結果:
//   { ok:true, userId, expired:false } = caller は既存 polling 経路に流す
//   { ok:true, userId, expired:true }  = caller は HTTP 410 Gone (TTL 超過)
//   { ok:false, error:'invalid_format' | 'invalid_hmac' } = caller は HTTP 401
//
// 設計意図:
// - secret 取得は呼出時 (= request 到達時)。 module import 時に throw すると
//   build 時 / test 時の評価で意図しない fail を引く (webhook-secret-gate.ts と
//   同方針)。
// - timingSafeEqual で hmac 比較し、 長さ不一致時の早期 return も含めて副 channel
//   攻撃面を抑える (Buffer 長 mismatch では timingSafeEqual 自体が throw するため
//   長さ事前 check が必要)。
// - preview / local は dev-only dummy secret に fallback。 production のみ env
//   必須 = fail-fast (audit §10.4 #11 文言を含む error message)。 webhook-secret-gate
//   と異なり preview でも throw しないのは、 deletion-status は webhook と違い
//   secret 欠落で「全 user の削除 polling が壊れる」 user-facing impact が出るため
//   preview でも dev secret で動作継続を優先する (debug 用、 production 同 secret
//   流用は構造的に不可)。
//
// server-only 不付: helper 自体は pure 関数で client bundle に入る経路は構造的に
// ない (T-A1〜T-A8 precedent と同方針)。

import { createHmac, timingSafeEqual } from 'node:crypto'
import { logger } from '@/lib/logger'

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export type DeletionTokenVerifyResult =
  | { ok: true; userId: string; expired: false }
  | { ok: true; userId: string; expired: true }
  | { ok: false; error: 'invalid_format' | 'invalid_hmac' }

function getSecret(): string {
  const secret = process.env.DELETION_TOKEN_SECRET
  if (secret) return secret
  if (process.env.VERCEL_ENV === 'production') {
    throw new Error(
      'DELETION_TOKEN_SECRET must be set in production (see audit §10.4 #11)',
    )
  }
  if (process.env.VERCEL_ENV === 'preview') {
    // M1 (code review): T-A8 `requireWebhookSecret` の preview tier observability
    // と対称化。 preview deploy で env 未設定だと placeholder fallback が走り、
    // 旧実装では silent。 1 行 warn で OT に missing 状態を可視化する。 logger
    // 出力は best-effort、 caller の polling 経路は placeholder で継続。
    // 対照 precedent = `lib/env/webhook-secret-gate.ts` (T-A8 preview tier)。
    logger.warn({
      event: 'deletion.token_secret.missing_preview',
      envKey: 'DELETION_TOKEN_SECRET',
    })
  }
  // preview / local: deterministic dummy secret for dev UX。 production 以外は
  // 同一 secret で動くため preview 内 polling が機能する。
  return 'dev-only-deletion-token-secret-placeholder'
}

function b64urlEncodeString(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

function b64urlDecodeString(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8')
}

export function signDeletionToken(userId: string, now: number = Date.now()): string {
  const secret = getSecret()
  const exp = now + TOKEN_TTL_MS
  const userIdB64 = b64urlEncodeString(userId)
  const expB64 = b64urlEncodeString(String(exp))
  const data = `${userIdB64}.${expB64}`
  const hmac = createHmac('sha256', secret).update(data).digest('base64url')
  return `${data}.${hmac}`
}

export function verifyDeletionToken(
  token: string,
  now: number = Date.now(),
): DeletionTokenVerifyResult {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, error: 'invalid_format' }
  const [userIdB64, expB64, hmacB64] = parts
  // empty segment は format 不正として扱う (空文字 → b64decode が成功してしまうため
  // 早期 reject)。
  if (!userIdB64 || !expB64 || !hmacB64) {
    return { ok: false, error: 'invalid_format' }
  }

  const secret = getSecret()
  const data = `${userIdB64}.${expB64}`
  const expectedHmac = createHmac('sha256', secret).update(data).digest('base64url')

  // timingSafeEqual は length mismatch で throw するため、 長さを事前に比較し
  // 不一致は invalid_hmac として早期 return (副 channel 防止)。
  const given = Buffer.from(hmacB64)
  const expected = Buffer.from(expectedHmac)
  if (given.length !== expected.length) {
    return { ok: false, error: 'invalid_hmac' }
  }
  if (!timingSafeEqual(given, expected)) {
    return { ok: false, error: 'invalid_hmac' }
  }

  const userId = b64urlDecodeString(userIdB64)
  const exp = Number(b64urlDecodeString(expB64))
  // exp_ts 不正 (NaN) は format 不正扱い (HMAC が通っているのでこれは secret 漏洩
  // 後の改ざんでない限り起こらないが、 防御層として弾く)。
  if (!Number.isFinite(exp)) {
    return { ok: false, error: 'invalid_format' }
  }
  if (now >= exp) {
    return { ok: true, userId, expired: true }
  }
  return { ok: true, userId, expired: false }
}
