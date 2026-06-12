// T-C2 段 1 (audit §10.3 (b) #12): study_sessions.card_ids / answer_events.selected_answer_ids
// の zod max 制約を helper 経由で提供する。 item format (uuid / string item 厳格化) は
// spec §10.3 OT SELECT 結果に基づき段 2 で別 commit (本 helper は段 1 = bound 追加のみ)。
import { z } from 'zod'

export const cardIdsSchema = z.array(z.uuid()).max(2000)
export const selectedAnswerIdsSchema = z.array(z.string()).max(50)
