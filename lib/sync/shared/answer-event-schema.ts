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
  elapsed_ms: z.number().int().min(0).max(86_400_000).optional(),
})

export type AnswerEventWire = z.infer<typeof answerEventWireSchema>
