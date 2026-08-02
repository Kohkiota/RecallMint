// GEMINI_DAILY_LIMIT 環境変数の parse helper。
//
// ②-4a spec §3 C-5: 旧 `upload-guard.ts`(runUploadGuardTx)内の private 実装を
// 再利用可能な helper へ切り出したもの。 upload-guard.ts(legacy flow)と
// claim-operation.ts(T6・新 flow の claim 直前 cap 判定)の両方がここから import
// する — 日次 cap 判定ロジックを 2 箇所にコピーしない(rule of three 未満だが
// 「1 定義を両呼出元が共有」という既存方針、constants.ts の
// LEASE_TTL_MS / asset-limits.ts の MAX_ASSET_BYTES と同型)。
//
// directive 無し(sync 関数を export するため)。claim-operation.ts は
// 'use server' file であり、Next.js の "use server" transform は非 async 関数の
// export を compile error にする(T4 の asset-limits.ts 切り出しと同じ制約)。

// GEMINI_DAILY_LIMIT 環境変数を Number に変換。 未設定 / 不正値 / 0 以下は
// null を返し guard を off にする (.env.example で 1000 を default 提示済、
// 想定外の設定で本番が止まることを避ける)。
//
// T-A3 (audit §10.3 (b) #6): production (VERCEL_ENV='production') では未設定 /
// 不正値で fail-fast。 quota 機構が silent に no-op になり実際の Gemini 課金 API へ
// 無制限に流れる事故を防ぐ。 preview / dev は従来通り null fallback (= guard off)。
export function parseDailyLimit(raw: string | undefined): number | null {
  const failed = (): null => {
    if (process.env.VERCEL_ENV === 'production') {
      throw new Error(
        'GEMINI_DAILY_LIMIT must be set in production (see audit §10.3 (b) #6)',
      )
    }
    return null
  }
  if (!raw) return failed()
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return failed()
  return n
}
