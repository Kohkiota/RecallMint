# 2026-06-12 Repo-wide Audit

目的: production レベルで許容できない実装・セキュリティホール・構造的負債の棚卸し。調査のみで修正は未実施。

実施方法: security / data integrity / error handling / duplication / type safety / perf を fresh subagent で監査し、operations は controller が追加監査。controller が既知項目を分離して集約した。

## P0 Highlight

P0 は見つからなかった。

## New Findings

| file:line | 問題 | 深刻度 | 推奨対応 | 推定工数 |
|---|---|---:|---|---:|
| app/(app)/app/_components/entity-mutation-flush-trigger.tsx:36, app/(app)/app/_components/entity-mutation-flush-trigger.tsx:62, lib/sync/entity-mutations.ts:177 | entity mutation outbox の 24h 超 pending を mount 時に `failed` へ隔離する。長時間 offline / sleep 後の編集が自動 retry 対象から外れ、ユーザー復旧動線もない。 | P1 | durable outbox は自動 failed 化せず backoff retry を継続する。失敗隔離が必要なら UI で recover / retry 可能な queue として扱う。 | S |
| app/api/review-events/bulk/route.ts:409, app/api/review-events/bulk/route.ts:548, lib/sync/review-flush.ts:66 | review events の tx rollback を `failed[]` + HTTP 200 に変換するため、client は `httpStatus: 200` を permanent と分類し、transient DB 障害でも自動 retry が止まりうる。 | P2 | tx-level infrastructure failure は 5xx で返すか、retryable failure kind を response に含める。orphan / validation failure と DB failure を分離する。 | M |
| app/api/entity-mutations/bulk/route.ts:193, app/api/entity-mutations/bulk/route.ts:207, lib/sync/entity-mutations.ts:281 | entity mutation の予期しない DB error も `failed[]` + HTTP 200 に混ぜるため、transient write failure が permanent 扱いになり retry controller と噛み合わない。 | P2 | infrastructure error は 5xx または structured retryable metadata で返し、validation/domain failure と区別する。 | M |
| app/(app)/app/exams/[id]/_components/delete-card-button.tsx:37, app/(app)/app/exams/[id]/_components/delete-card-button.tsx:44 | card mirror delete が先に成功し、その後の `enqueueEntityMutation(...).catch(() => {})` を握り潰す。outbox enqueue 失敗時に UI から消えた card の server tombstone が作られない。 | P2 | mirror delete と outbox enqueue を同一 Dexie transaction にする。enqueue 失敗時は rollback / revert し、少なくとも logger と UI error を出す。 | S |
| app/api/entity-mutations/bulk/route.ts:184, app/api/entity-mutations/bulk/route.ts:186, app/(app)/app/exams/[id]/_components/card-tags-section.tsx:475 | dependent multi-mutation が server で mutation ごとの独立 tx として処理される。tag option create が commit 済みで、対応する card `tag_option_ids` update だけ失敗する partial state がありうる。 | P2 | atomic mutation group、または create-and-assign の compound operation を導入する。 | M |
| app/api/review-events/bulk/route.ts:62, app/api/review-events/bulk/route.ts:499 | `session.card_ids` に `.max()` がなく、認証済み client が巨大 UUID 配列を DB に保存できる。storage / request 処理 DoS になりうる。 | P2 | session の realistic max を zod に追加し、DB write 前に reject する。 | S |
| app/api/review-events/bulk/route.ts:71, app/api/review-events/bulk/route.ts:209 | `selected_answer_ids` が `z.array(z.string())` のみで item format / length / array size bound がない。1000 events に unbounded JSON payload を積める。 | P2 | option ID の形式と長さを検証し、配列長を card option 上限に合わせて cap する。 | S |
| app/(marketing)/contact/actions.ts:19 | public contact server action が DB insert と ops 通知を行うが、per-IP / email / session の rate limit がない。bot による DB 書き込み・ops spam が可能。 | P2 | validation 後 DB insert 前に rate limit / abuse counter を追加する。honeypot だけに依存しない。 | M |
| lib/ai/clients/gemini.ts:138, lib/ai/clients/gemini.ts:142 | `OCR_DEBUG_LOG=1` で Gemini raw response を最大 50,000 文字 log 出力する。試験本文やユーザー投入内容が Vercel logs に残りうる。 | P2 | production では強制無効化する env validation を追加し、staging でも redaction / sampling / short preview に限定する。 | S |
| lib/ops.ts:22, lib/ops.ts:23, app/api/webhooks/stripe/route.ts:59, app/api/webhooks/clerk/route.ts:106 | `OPS_DISCORD_WEBHOOK_URL` 未設定時に ops 通知が no-op になる。webhook handler は失敗を 200 swallow するため、production misconfig では復旧シグナルが消える。 | P2 | production では ops webhook / 代替 error sink を fail-fast validation する。少なくとも healthcheck / deploy check で通知経路を検証する。 | M |
| app/(app)/app/exams/[id]/_components/inline-card-list.tsx:91 | exam detail の `useLiveQuery` が `tag_categories` / `tag_options` / `card_tags` を全件読む。tag / card-tag 更新ごとに全 tag relation を regroup する。 | P2 | `card_tags` は表示中 card IDs に `where('card_id').anyOf(cardIds)` で scope する。tag master と per-card tag relation の subscription 分離も検討する。 | M |
| app/(app)/app/exams/_components/exam-list-live.tsx:29 | exam list が user 全カードを読み、exam ごとの件数を JS 集計する。card 変更ごとに user 全カード scan が走る。 | P2 | local mutation / pull で `exam.card_count` を正しく維持して render に使うか、local aggregate table を持つ。 | M |
| lib/ai/schemas/ocr-response.ts:14, lib/ai/ocr.ts:38, app/(app)/app/upload/_actions/process.ts:521 | OCR response shape が JSON Schema / zod / TS / DB JSON 型で手定義重複している。`c.images as CardImage[]` で assignability が失われる。 | P2 | zod または shared DB-compatible type を source of truth にし、JSON Schema / TS を派生させる。upload 側の cast を型検査される変換に置き換える。 | M |
| next.config.ts:17, proxy.ts:18 | CSP が `frame-ancestors 'none'` のみ。`default-src` / `script-src` / `connect-src` / `img-src` / `base-uri` 等の app-level policy がない。 | P3 | Clerk / Stripe / app asset / API origin を棚卸しして明示 CSP を設定する。report-only から rollout する。 | M |
| app/api/me/deletion-status/route.ts:19 | public polling endpoint が raw `userId` query で削除 lifecycle を返す。削除フロー中 user id を知る相手に状態を観測される。 | P3 | raw user id ではなく、短命 nonce / signed token に bind した polling にする。 | M |
| app/(app)/app/settings/_actions/save-fsrs-mode.ts:15 | server action が runtime で boolean validation せず、TS 型を信頼して DB に書く。malformed server-action call が clean validation ではなく DB error になる。 | P3 | `z.boolean().safeParse(value)` などで runtime validation し、ActionResult error を返す。 | S |
| app/(app)/app/exams/_actions/delete-exam.ts:25 | `examId` を UUID runtime validation せず DB query / tombstone insert / log context に渡す。malformed input が DB error path に入る。 | P3 | tx 開始前に `z.uuid().safeParse(examId)` で reject する。 | S |
| lib/client-db.ts:253, lib/client-db.ts:255, lib/client-db.ts:256 | Dexie v3 migration が `card_mutations` を migrate せず drop する。pending mutation が残る client では local write が失われる。 | P3 | 旧 `card_mutations` を `entity_mutations` へ migrate するか、outbox empty を確認する upgrade gate を設ける。 | M |
| app/(app)/app/_components/dashboard-actions.tsx:33 | dashboard CTA が user 全カードを読み、due 判定を JS filter する。cards store invalidation ごとに全 scan。 | P3 | Dexie に `[user_id+due]` index を追加し、upper-bound range count にする。もしくは due aggregate を持つ。 | M |
| lib/cards/get-dexie-session-cards.ts:29 | smart study startup が user 全カードを読み、due filter / sort / slice を JS で行う。カード数増加で起動が劣化する。 | P3 | `[user_id+due]` index を追加し、due rows だけを query して limit 前に materialize する。 | M |
| app/(app)/app/exams/[id]/_components/card-tags-section.tsx:304 | category delete impact count が option 取得後、option ごとに `card_tags` query する IDB N+1。 | P3 | option IDs に対して `card_tags.where('option_id').anyOf(optionIds)` を 1 回実行し、distinct card count を memory 集計する。 | S |
| app/(app)/app/tags/_components/category-list.tsx:132 | tag manager の category delete impact count も同じ IDB N+1 を持つ。 | P3 | `anyOf(optionIds)` で 1 query にまとめる。 | S |
| app/api/review-events/bulk/route.ts:376, app/api/review-events/bulk/route.ts:379 | review bulk flush が JST day ごとに `COUNT(DISTINCT card_id)` SQL を発行する。offline batch が複数日にまたがると day-count N+1。 | P3 | 対象日をまとめて 1 grouped SQL で取得し、結果 map から `studyDays` を upsert する。 | M |
| lib/db/cards-pull.ts:20, lib/db/exams-pull.ts:27, lib/db/tag-categories-pull.ts:33, lib/db/tag-options-pull.ts:32, lib/db/tombstones-pull.ts:28, lib/db/card-tags-pull.ts:35 | delta pull helpers が tenant filter / optional cursor filter / select-map-max cursor logic を重複実装している。 | P3 | table / user column / cursor column / mapper / cursor key を受ける typed helper を抽出する。 | M |
| app/(app)/app/tags/_components/category-row.tsx:86, app/(app)/app/tags/_components/option-row.tsx:118 | tag category / option inline edit の optimistic mirror update + enqueue + debounced flush が重複している。 | P3 | table / entity type / fields / log event を引数にした shared helper または hook に集約する。 | M |
| app/(app)/app/tags/_components/category-create-form.tsx:63, app/(app)/app/tags/_components/option-create-form.tsx:79 | tag category / option create flow の timestamp / optimistic put / enqueue create / immediate flush / reset が重複している。 | P3 | `createTagEntityOptimistically` のような helper に row builder / patch builder を渡す形へ集約する。 | M |
| app/(app)/app/tags/_components/category-list.tsx:170, app/(app)/app/tags/_components/option-list.tsx:149 | tag category / option delete cascade の mirror purge / enqueue delete / flush / log failure が重複している。 | P3 | cascade strategy callback を持つ shared delete helper に集約する。 | M |
| components/ui/dropdown-menu.tsx:254, app/(app)/app/tags/_components/option-row.tsx:33 | `components/ui/dropdown-menu.tsx` が実 importer なしで残っている。option-row 側コメントでは jsdom 問題で custom menu に戻した履歴がある。 | P3 | 未使用なら削除する。必要なら category-move UI に実配線して custom menu と二重化しない。 | S |
| lib/sync/review-events.ts:79 | `abandonStudySession` が export されているが production consumer がない。abandoned session を記録する実経路がないか、dead export。 | P3 | 不要なら削除する。必要なら session abandon の production path を実装する。 | S |
| lib/validation/contact.ts:5, lib/db/schema.ts:514 | contact category enum が zod 側 const と DB typing 側 union で二重定義。comment が同時更新必須を明示しており drift しやすい。 | P3 | shared module に category const/type を移し、validation と schema typing の双方から import する。 | S |

## Known Convergence

既知項目として扱い、新規発見リストには重複登録しない。

| file:line | 問題 | 深刻度 | 推奨対応 | 推定工数 | 既知 |
|---|---|---:|---|---:|---|
| app/(app)/app/tags/_components/category-create-form.tsx:64, app/(app)/app/tags/_components/option-create-form.tsx:80, app/(app)/app/tags/_components/category-row.tsx:94, app/(app)/app/tags/_components/option-row.tsx:131 | tag optimistic mirror write と outbox enqueue が別 operation / fire-and-forget で、enqueue failure 時に local-only write が残る。 | P1 | mirror write + enqueue を 1 Dexie transaction に統一する shared helper へ移行する。 | L | Sync-fix-1 |
| app/(app)/app/exams/[id]/_components/inline-text-field.tsx:168, app/(app)/app/exams/[id]/_components/inline-option-row.tsx:185, app/(app)/app/exams/[id]/_components/inline-card-list.tsx:162, app/(app)/app/exams/[id]/_components/delete-card-button.tsx:44 | card inline edit / create / delete も mirror change と outbox enqueue が分離し、一部で enqueue error を swallow する。 | P1 | `card-tags-section` と同等の atomic mirror+outbox tx、または enqueue failure 時の revert を導入する。 | M | Sync-fix-1 |
| app/api/pull/route.ts:28, app/api/pull/route.ts:31 | invalid `since_*` が `undefined` になり full fallback する。攻撃面としては owner-scoped だが、hardening 対象。 | P3 | invalid cursor は 400 にするか、client recovery と server load を分けた明示 policy にする。 | S | /api/pull hardening |
| app/api/me/deletion-status/route.ts:19 | raw `userId` polling は deletion-status 既知項目。 | P3 | nonce / signed token 化。 | M | deletion-status |
| app/api/webhooks/stripe/route.ts:55, app/api/webhooks/stripe/route.ts:66, app/api/webhooks/clerk/route.ts:103, app/api/webhooks/clerk/route.ts:113 | webhook handler failure を notify 後 200 swallow する運用設計は runbook 依存。通知経路が死ぬと復旧が手動検知できない。 | P2 | webhook runbook / alert sink / replay 手順を production 運用に固定する。 | M | webhook runbook |
| app/(app)/app/upload/_actions/process.ts:303, app/(app)/app/upload/_actions/process.ts:304 | `GEMINI_DAILY_LIMIT` 不正 / 未設定で guard off。コスト暴走の安全弁が warning だけになる。 | P2 | production では positive integer を fail-fast validation する。 | S | Gemini 日次上限 |
| app/(app)/app/upload/_actions/process.ts:447, app/(app)/app/upload/_actions/process.ts:470, lib/ops.ts:31, lib/logger.ts:62 | `String(err)` / `err.message` の ad hoc 正規化が残る。情報落ちや秘匿対象の扱いが callsite ごとに揺れる。 | P3 | shared error serializer に統一し、user-facing / ops-facing / log-facing を分離する。 | M | String(err) 統一 |
| lib/tags/apply-tag-mutation.ts:76, lib/tags/apply-tag-mutation.ts:228, lib/tags/apply-tag-mutation.ts:253, lib/sync/server/entity-mutation-registry.ts:194 | tag update validation が create schema と drift している。create は trim/max あり、update は type / non-empty 寄り。 | P2 | create/update 共通の zod schema へ統一し、registry から inferred patch type を使う。 | M | Sync-fix-1 |
| lib/client-db.ts:147, lib/client-db.ts:150, lib/client-db.ts:152, lib/client-db.ts:153 | `ClientEntityMutation` が loose な `string` / `Record<string, unknown>` で、server registry contract と型連動していない。 | P3 | supported `(entity_type, op)` の discriminated union を registry schema と colocate する。 | L | Sync-fix-1 |
| lib/sync/review-events.ts:32, lib/sync/entity-mutations.ts:25 | `newId()` helper が outbox ごとに重複。 | P3 | client-safe UUID helper を共有化する。 | S | Sync-fix-1 |
| lib/sync/review-flush.ts:72, lib/sync/entity-mutation-flush.ts:31, lib/sync/pull.ts:310 | Web Locks `MinimalLockManager` / lock resolution pattern が 3 箇所にコピーされている。 | P2 | lock-name / callback / outcome を受ける shared lock runner を抽出する。 | M | Sync-fix-1 |
| app/(app)/app/exams/[id]/_components/card-tags-section.tsx:636 | tag assignment path の IDB delete/put/outbox 処理は Sync-fix-1 既知対象。 | P3 | planned shared helper に folded bulk operation として合流する。 | M | Sync-fix-1 |
| app/api/webhooks/clerk/route.ts:226 | GDPR deletion の child table 明示 delete は invariant test で守られているが、新規 direct user_id table 追加時は既知 GDPR 残件の監視対象。 | P3 | schema invariant test を維持し、追加 table の deletion policy を設計 checklist に入れる。 | M | GDPR 残件 |

## Verification

- `corepack pnpm exec tsc --noEmit --pretty false`: PASS
- `corepack pnpm exec eslint . --max-warnings=0`: PASS

## Notes

- 修正は一切実施していない。
- agent 上限により operations 領域は controller が担当した。
- P1 新規は entity mutation outbox の 24h 自動 failed 隔離のみ。P1 既知は Sync-fix-1 に合流。
