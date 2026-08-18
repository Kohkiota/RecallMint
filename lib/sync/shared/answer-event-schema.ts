// answer_events wire schema — server (bulk ingest) と client (outbox flush) の
// 両方から共有される契約 (mutation-schemas.ts 前例踏襲、 server-only 不付・client
// bundle 安全)。 selected_answer_ids の max 50 は review-session-bounds の既存
// bound をここへ内包 (Task 4 で review-session-bounds 側は削除予定)。

import { z } from 'zod'

export const answerEventWireSchema = z.object({
  event_id: z.uuid(),
  card_id: z.uuid(),
  session_id: z.uuid().optional(),
  selected_answer_ids: z.array(z.string().min(1)).max(50),
  is_correct: z.boolean(),
  // FSRS rating (1=Again / 2=Hard / 3=Good / 4=Easy)。 正本一本化ゆえ必須化
  // (旧 review-session-bounds 経路の optional + is_correct derive とは異なる)。
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  answered_at: z.iso.datetime(),
  // max = 24h (ms)。 client 側の対 (session-runner.tsx の ELAPSED_MS_MAX) と同値 —
  // 1 card の表示時間としてありえない上限を切るための cap で、 それ以上の妥当性判定はしない。
  elapsed_ms: z.number().int().min(0).max(86_400_000).optional(),
  // セッション開始入口の分析ラベル (Dash-1 Home v1 spec §11.1/§11.3)。optional bounded
  // string — z.enum で reject しない (未知値 400 は分析ラベル 1 つで回答 batch 全体の
  // 同期を止めてしまうため)。既知集合判定 + 未知値の null 正規化は server ingest 側
  // (normalizeOrigin, ORIGIN_VALUES 経由) が担う。
  origin: z.string().max(64).optional(),
})

export type AnswerEventWire = z.infer<typeof answerEventWireSchema>
