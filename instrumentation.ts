// 運用通知 (notifyOps) の最終防護網。関連設計: tech-spec §6 アカウント削除フロー。
//
// Next.js 15 onRequestError フック。Server Action / page render の uncaught
// error を notifyOps に流す最後の防護網。Webhook handler は内部で outer catch +
// explicit notifyOps を呼ぶため本フックの主目的ではない (uncaught 限定 fire のため)。
//
// runtime 識別: Next.js の context 引数には runtime field が無い (instrumentation
// types.d.ts 確認済)。公式 pattern の process.env.NEXT_RUNTIME ('nodejs' | 'edge')
// を notifyOps の context に含めて Node / Edge 両 runtime での発火元を識別可能に。
//
// 機微情報 (cookie / Authorization header) は request.headers に含まれるが、本実装は
// path / method のみを抽出して headers を notifyOps に渡さない。

import type { Instrumentation } from 'next'
import { notifyOps } from '@/lib/ops'

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  const errorInfo =
    err instanceof Error
      ? { errorName: err.name, errorMessage: err.message, errorStack: err.stack }
      : { errorRaw: String(err) }
  const errorDigest = (err as { digest?: string } | null | undefined)?.digest

  await notifyOps('unhandled server error', {
    runtime: process.env.NEXT_RUNTIME ?? 'unknown',
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
    requestPath: request.path,
    requestMethod: request.method,
    ...errorInfo,
    errorDigest,
  })
}
