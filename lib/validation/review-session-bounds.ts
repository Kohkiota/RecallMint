// T-C2 段 1 (audit §10.3 (b) #12): study_sessions.card_ids / answer_events.selected_answer_ids
// の zod max 制約を helper 経由で提供する。 item format (uuid / string item 厳格化) は
// spec §10.3 OT SELECT 結果に基づき段 2 で別 commit (本 helper は段 1 = bound 追加のみ)。
import { z } from 'zod'

// 段 2 (T-C2-stage2): cardIdsSchema は段 1 で z.array(z.uuid()) に既到達 = 段 2 no-op (schema 不変)。
export const cardIdsSchema = z.array(z.uuid()).max(2000)
// 段 2 (T-C2-stage2): selectedAnswerIdsSchema は item を z.string().min(1) に緩和形で許容化
// (OT SELECT 結果 2026-06-12: string item は uuid とは限らず option_id raw value 等が混在
// のため緩和)。 uuid 化 / 正規化の締め直しは Phase 4 帰属 (audit §10.3 (b) #12 残し分)。
export const selectedAnswerIdsSchema = z.array(z.string().min(1)).max(50)
