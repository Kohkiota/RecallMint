// 2 段 gate helper (audit §10.3 (b) #5)。
//
// 用途: OCR_DEBUG_LOG / BULK_FULL_PARAMS_LOG など、 debug 用に raw payload を log へ
// 流す環境変数を production で uncontrolled に有効化させないための共有判定。
// production (= VERCEL_ENV === 'production') では env 直 + LOG_GATE_ALLOW_PROD の
// **AND** を要求し、 片方だけ '1' になっても effective にならない (誤設定 fail-safe)。
// 非 production (preview / dev / undefined) では従来どおり env 直 = '1' のみで判定。
//
// '1' 比較 semantics は既存 caller (OCR_DEBUG_LOG === '1' /
// BULK_FULL_PARAMS_LOG === '1') を踏襲。 'true' / 'yes' 等は false (既存 test 仕様)。
//
// server-only 不付: caller は server-side route だが、 helper 自体は副作用ゼロ pure 関数
// で client bundle に入る経路は構造的にない (Y-1 T5 / T-A1 precedent と同方針)。
// 将来 env key が増えても helper を触らず caller 側で `isLogGateOpen('NEW_KEY')` を
// 呼べばよいよう、 env key は引数指定 (固定 list を helper 内に持たない)。

import { isProduction } from '@/lib/env/runtime-env'

export function isLogGateOpen(envKey: string): boolean {
  if (process.env[envKey] !== '1') return false
  if (isProduction()) {
    return process.env.LOG_GATE_ALLOW_PROD === '1'
  }
  return true
}
