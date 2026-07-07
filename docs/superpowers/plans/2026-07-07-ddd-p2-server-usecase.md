# DDD リファクタ P2 — server 側 use-case 化 実装 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)。Steps は checkbox 追跡。

**Goal:** route 3 本(review-events / stripe webhook / clerk webhook)を wire 境界化して use-case を lib へ as-is 移動し、process.ts(761 行)を in-place 分解する(全て挙動不変・P0 golden 4 面が回帰の正)。

**Architecture:** 関数単位 as-is 移動 + tx 単位の関数化のみ。新規挙動ゼロ。route/action 残留 = 認証・署名検証・idempotency・zod parse 実行・HTTP/result 化・revalidatePath。

**Tech Stack:** TypeScript strict / Vitest / Next.js 16 App Router / Drizzle。

- SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md` / Spec: `docs/superpowers/specs/2026-07-07-ddd-p2-server-usecase-design.md`(§ 参照は同 spec)
- 前提: HEAD `f59ad5d`(P1 完了 + P2 spec 確定)。**行番号は `b3bcb07` 実読の参照補助** — 実装時は必ず symbol ベース(`rg`)で再特定してから編集。

## Global Constraints(全 task 共通・冒頭一度)

- **挙動不変**。凍結契約(D-2 + spec §1.4)不変。**P0 golden(`pnpm test:contract` 77)が赤 = 即停止**(snapshot 更新は挙動変更の証拠 — 更新して通さない)。logger meta / notifyOps subject・payload fields も byte 温存(spec §3.3。イベント名だけでなく shape も観測面 — Codex 論点)。
- **移動は verbatim**(コピー時に 1 文字も変えない。唯一の例外 = Task 3 の stale コメント「8」→「10」と Task 5 の customProps 参照置換 — 各 task に明記)。本 plan は本体を再掲せず source 行範囲を指す(転記 drift 防止)。分割で新設する関数境界(Task 4/5)も **body は verbatim**、変わるのは signature 化のみ。新 file 冒頭の `import 'server-only'` / doc コメント追加は verbatim 例外に数えない(header 追加であり body 不変)。
- **1 関数 = 1 tx(OT 条件 2)**: guard tx / 保存 tx / 完了 tx / markFailed tx / processSession tx / clerk 削除 tx は各 1 関数に閉じる。lock も tx も跨ぐ分割をしない。**tx callback 内の I/O は必ず callback の `tx` を通す**(分割 module 内で `getDb()` 再取得・外側 `db` 直参照への差し替え禁止 — Codex 論点)。新 module が `db` を受ける signature の `ReturnType<typeof getDb>` は `import type { getDb }`(型のみ・値 import しない)。
- **server-only**: 新 lib module 3 本(Task 1-3)は先頭に `import 'server-only'`(`lib/exams/list.ts` 等の既存 lib server module 慣習に一致)。`_actions/` 分割 2 本(Task 4/5)は付けない(`@/lib/db` 経由の transitive guard + app 内に同慣習の前例なし — 新パターンを発明しない)。
- **measure 計測配管 / timing log(TEMP marker 含む)を触る変更 = Critical 相当で自走停止・OT 判断**(OT 条件・golden が捕まえない領域のガードレール)。
- **mock 境界検証(条件 3)**: 各 task で route.test / contract test の `vi.mock` 対象を確認し、move 後も「緑かつ正しい実体を検証」を確認。報告は green 宣言でなく **「mock 対象 module 一覧 + 実体で走った moved 関数」を列挙**する(Codex 論点: 到達性の明示)。事前確認済の事実: 全 mock 対象は絶対 path(`@/lib/db` 等)or `svix`/`next/cache` で move 中立、process 系のみ相対 `../_lib/pdf-page-count`(entry 残留で不変)、contract test 4 file の実在名は確認済。clerk の 10 DELETE invariant test は runtime 捕捉型(POST → mock `tx.delete` 引数捕捉)で source 参照なし = move 安全。
- 新 lib module は **app/ を import しない**(lint Block A。use-case ゆえ I/O import は当然含む)。export 最小化(consumer が実際に要る symbol のみ)。import style: app→lib = `@/lib/...` / 同一 dir = `./`。
- **per-task gate(全 code task = Task 1-5)**: ① 対象 route.test(各 task 記載)+ **full `pnpm test:contract`(77 全面** — 対象面以外への波及も検知。per-task で全面実行、曖昧さ排除 = Codex 論点)exit 0 ② `pnpm typecheck` ③ whole-repo `pnpm lint --max-warnings=0` ④ `pnpm build`(route→lib move / server 境界 = 全 code task が risk)⑤ canonical review(`superpowers:requesting-code-review` デフォルト経路)+ **Codex review(`scripts/ai/codex-review.sh`・全 code task**: A=tx 境界 / B=決済 / C=認証・削除 / D=lock・採番、全て audit §6.3 地雷領域のため per-task Codex を省略しない)で未解決 Critical 0 / Important 0 ⑥ commit 末尾 `[reviewed]`。**full `pnpm test` は Task 6 集約**。
- commit type = `refactor(scope): …`。P2 はロジック不変 refactor ゆえ「重要 Fix 裏取り」([reviewed] 保留)の対象外(spec §8.3)。
- **自走エスカレーション(OT 確定)**: 停止 = ① golden 赤 ② measure/timing log 接触 ③ 1 関数 = 1 tx・lock 範囲・applyOcrTags 採番を保てない構造が判明 ④ Critical が CC 修正でも未解決 ⑤ 仕様解釈揺れ。それ以外(Important 以下・mock 調整)は CC 吸収で自走。終着 = Task 6 完了で停止・OT 確認待ち。
- SSoT 状態遷移(規律の明文化 — Codex 論点): **開始遷移(→実装中)= Task 1 の code commit に同梱**(SSoT 運用注記「該当 commit と同 commit」準拠)/ **完了記録(→完了 + HEAD SHA)= Task 6 の独立 docs commit**。「code と docs を混ぜない」が指すのは完了記録側であり、両者は矛盾しない。

---

### Task 1: review-events/bulk → `lib/reviews/ingest-review-events.ts`(A)

**目的:** FSRS ingest use-case(単一 tx + count mismatch 防御)を route から lib へ as-is 移動し、route を wire 境界化する。

**Files:**
- Create: `lib/reviews/ingest-review-events.ts` — 移動対象(route.ts より verbatim): `sessionSchema`/`eventSchema`/`payloadSchema`(:67-96)+ `BulkPayload`/`ParsedEvent` 型(:98-99)+ `deriveRating`(:104-106)+ `toPgTimestamptz`(:113-115)+ `processSession`(:122-455)。付随 import(zod / drizzle / schema / replay-card / in-date-list / serialize-db-error / fsrs 型 / logger / jst / validation bounds)も移す。
- Modify: `app/api/review-events/bulk/route.ts` — 移動分を削除し `import { payloadSchema, processSession, type BulkPayload } from '@/lib/reviews/ingest-review-events'`。

**Interfaces(Produces):** `export { payloadSchema, processSession }` / `export type { BulkPayload, ParsedEvent }`(`ParsedEvent` は processSession の exported signature に現れるため type export する — 非 export 型が公開 signature に漏れる TS 不健全を避ける・Codex 論点)。`processSession` の signature は**現状不変**: `(db: ReturnType<typeof getDb>, user: User, session: BulkPayload['session'], events: ParsedEvent[], measure: <T>(name: string, fn: () => Promise<T>) => Promise<T>)`。`User` は `@/lib/db/schema`(lib→lib・現 route と同一 import 元)。`deriveRating`/`toPgTimestamptz` は module 内部(非 export)。

**制約:**
- **route 残留(OT 条件 1・Phase 0 境界)**: 認証(:461-477)/ measure closure + TEMP marker(:479-495)/ payload parse 実行(:497-511)/ **Phase 0 session upsert + classifyBulkError 503/400 error path(:513-577)**/ response 化(:579-592)。「Phase 0 upsert → 成否判定(失敗なら processSession を呼ばず 503/400 return)→ processSession 呼出」のシーケンスと error path を handler 側で不変維持。**Phase 0 は「wire 境界のみ残す」の唯一の明文例外**(DB 書込だが tx 外 + 独自 error path の現仕様ゆえ route 残留)— use-case 側へ動かさない。
- schema は lib 定義 + parse は route 実行(spec §4.1・clerk precedent)。
- 新 module 冒頭 doc コメントに「P2 時点の置き場。Learning context の最終形ではない(spec §3.1 条件 1 — replay-card は lib/cards/ に分散)」を 1 行残す(将来の再配置判断の手がかり・Codex 論点)。
- log イベント名(`review_events.bulk.tx_failed` 等)・`Retry-After` header・failed[] 合成順(orphan → tx)不変。

**完了条件:** `app/api/review-events/bulk/route.test.ts`(1295 行)+ `tests/contract/review-events-bulk.contract.test.ts` green(mock 境界確認 1 行報告)。+ Global per-task gate。

---

### Task 2: stripe webhook → `lib/stripe/handle-stripe-event.ts`(B・決済)

**目的:** 課金状態遷移 use-case(6 event switch + release gate)を route から lib へ as-is 移動。

**Files:**
- Create: `lib/stripe/handle-stripe-event.ts` — 移動対象(route.ts より verbatim): `extractCustomerId`(:71-81)+ `normalizeSubStatus`(:86-104)+ `resolvePlanFromSub`(:117-156)+ `extractSubFields`(:161-174)+ `handleEvent`(:176-365)+ `evaluateReleaseGate`(:372-441)。付随 import(stripe client / getDb / users schema / Plan 型 / price-mapping / ops / clerk-metadata / subscription)も移す。
- Modify: `app/api/webhooks/stripe/route.ts` — 移動分を削除し `import { handleEvent, extractCustomerId } from '@/lib/stripe/handle-stripe-event'`。

**Interfaces(Produces):** `export { handleEvent, extractCustomerId }`(`extractCustomerId` は route の outer catch でも使用)。他 4 関数は module 内部(非 export)。signature 全て不変。

**制約:**
- route 残留: `requireWebhookSecret` / signature 検証 / `stripeEvents` idempotency INSERT / outer catch(`notifyWebhookError` + `'handler error swallowed'` 200)。text response 5 種 + status 不変。**duplicate 時は `handleEvent` を呼ばず 200 return の順序不変**(use-case は idempotency 済み event のみ受ける前提・Codex 論点)。`handleEvent` は throw を route の outer catch へ伝播させる現分担のまま(lib 側で新たに握らない)。
- status matrix(unpaid/incomplete → status=past_due + plan=free 非対称)/ notifyOps subject 群 / release gate 分岐(方向2 保険・mismatch anomaly)を byte 温存(baseline §B)。
- P1 の `lib/stripe/subscription-changes.ts`(classifyChange 等)とは重複なし — 触らない。

**完了条件:** `app/api/webhooks/stripe/route.test.ts`(1194 行)+ `tests/contract/webhook-stripe.contract.test.ts` green(mock 境界確認 1 行報告。`vi.mock('@/lib/stripe/subscription')` は evaluateReleaseGate 移動後も絶対 path で有効 — green で実証)。+ Global per-task gate。

---

### Task 3: clerk webhook → `lib/clerk/handle-clerk-event.ts`(C・認証/削除)

**目的:** 削除カスケード use-case を route から lib へ as-is 移動(retry helper は統合せず同居移動)+ stale コメント回収。

**Files:**
- Create: `lib/clerk/handle-clerk-event.ts`(**`lib/clerk/` 新 dir**・`lib/clerk.ts` と併存 = stripe 対称)— 移動対象(route.ts より verbatim): `CANCEL_TARGETS`(:43-47)+ `handleEvent`(:130-165)+ `handleUserDeleted`(:167-301)+ `recordFailure`(:315-346)+ `isCustomerMissing`(:349-354)+ `isTransientDbError`(:360-375)+ `MAX_DB_RETRIES` + `runTransactionWithRetry`(:383-416)。付随 import(drizzle / Stripe / getDb / schema 13 table / logger / stripe+cancelWithRetry / ops / clerk-metadata / clerk-webhook validation 型)も移す。
- Modify: `app/api/webhooks/clerk/route.ts` — 移動分を削除し `import { handleEvent } from '@/lib/clerk/handle-clerk-event'`。

**Interfaces(Produces):** `export { handleEvent }`(signature 不変: `(evt: ClerkWebhookEvent) => Promise<void>`)。他は全て module 内部(非 export — route.ts 内の「local 非 export 関数」思想を維持、P4 統合まで温存)。

**制約:**
- route 残留: `requireWebhookSecret` / svix 検証 / zod safeParse(schema は既に `lib/validation/clerk-webhook.ts`)/ `clerkEvents` idempotency INSERT / outer catch。duplicate 時は `handleEvent` を呼ばず 200 return の順序不変(Task 2 と同前提)。
- **barrel(`lib/clerk/index.ts`)を作らない**。import は `@/lib/clerk/handle-clerk-event` の明示 path のみ(`@/lib/clerk`(= lib/clerk.ts)との混同回避・Codex 論点)。
- Stripe cancel ループ = **tx 外**(forward-only)/ 10 テーブル明示 DELETE + soft delete = 単一 tx 1 関数のまま。
- **stale コメント回収(spec §3.5・verbatim の唯一の例外)**: 集約コメント(:242)の「8 テーブル」→「10 テーブル」に修正して移動。
- **条件 3 重点**: 10 DELETE 網羅性 invariant test(route.test.ts:759-796)は POST 経由 runtime 捕捉のため move 後も同じ実体(lib 経由の実 handleUserDeleted)を検証する — green + `mockDbDelete` 捕捉件数 10 を確認して報告。

**完了条件:** `app/api/webhooks/clerk/route.test.ts`(855 行・invariant 含む)+ `tests/contract/webhook-clerk.contract.test.ts` green。+ Global per-task gate。

---

### Task 4: process.ts guard 分解 → `_actions/upload-guard.ts`(D-1・advisory lock)

**目的:** guard tx(advisory lock〜sourceDoc INSERT 一体)を 1 関数 1 tx のまま別 module へ切り出す。

**Files:**
- Create: `app/(app)/app/upload/_actions/upload-guard.ts` — 移動対象(process.ts より): `Destination` 型(:32-34・export 化)+ `GuardTxResult` union(:248-252・export 化)+ guard tx 本体(:254-376 の `db.transaction(...)` 全体を関数 body に verbatim 移動)+ `parseDailyLimit`(:700-716・非 export)。付随 import(drizzle / schema exams・sourceDocuments / ai-usage-mcq / ai-usage-counter / logger / jst / derive-exam-statuses)も移す。
- Modify: `app/(app)/app/upload/_actions/process.ts` — 該当部を削除し `import { runUploadGuardTx, type Destination, type GuardTxResult } from './upload-guard'`。呼出: `const guardResult = await runUploadGuardTx(db, user, destination, { filename, fileType, totalSize, totalPages })`。

**Interfaces(Produces):**
```ts
export type Destination = { mode: 'new' } | { mode: 'existing'; examId: string }
export type GuardTxResult = /* :248-252 verbatim */
export async function runUploadGuardTx(
  db: ReturnType<typeof getDb>,
  user: User,
  destination: Destination,
  meta: { filename: string; fileType: 'pdf' | 'image'; totalSize: number; totalPages: number },
): Promise<GuardTxResult>
```

**制約:**
- **advisory lock 取得(a)〜sourceDoc INSERT(e)を同一関数・同一 tx に保つ**(条件 2。in-flight check / quota / daily limit / exam 確定を分割しない)。
- entry 残留: formData parse・ページ数算出・PAGE/SIZE 上限(:141-224)/ guard 結果の文言 mapping(:378-419)/ 型 export・`processUpload`・revalidatePath(現 path 不変 — §2.5 直 import 制約)。
- `Destination` は upload-guard から export し **process.ts からは再 export しない**(実測: upload-form の import は `processUpload` + `ProcessUploadErrorCode`/`Details` のみで `Destination` 不使用 — 既存公開面を増やさない・Codex 論点)。
- `gemini.daily_limit.disabled` log イベント名・GuardTxResult の outcome 文字列不変。

**完了条件:** `process.test.ts`(1106 行)+ `tests/contract/upload-result.contract.test.ts` green(相対 mock `../_lib/pdf-page-count` は entry 残留で不変 — 確認 1 行報告)。+ Global per-task gate。

---

### Task 5: process.ts persistence 分解 → `_actions/upload-persistence.ts`(D-2・採番 tx)

**目的:** 保存 tx(applyOcrTags 同 tx 採番)・完了 tx・markFailed を各 1 関数 1 tx のまま別 module へ切り出す。

**Files:**
- Create: `app/(app)/app/upload/_actions/upload-persistence.ts` — 移動対象(process.ts より): 保存 tx 本体(:541-565 verbatim → `saveExtractedCards`)+ 完了 tx 本体(:608-627 verbatim → `completeUploadTx`)+ `markFailed`(:722-761 verbatim・関数まるごと)。付随 import(drizzle / schema / apply-ocr-tags / logger)も移す。
- Modify: `process.ts` — 該当部を削除し import。catch 節(markFailed + notifyOps + 文言 return)は **entry に残す**(error-path orchestration + 文言 = wire 契約)。

**Interfaces(Produces):**
```ts
export async function saveExtractedCards(
  db: ReturnType<typeof getDb>,
  args: {
    userId: string; examId: string
    cardRows: Array<typeof cards.$inferInsert>
    customProps: Array<Parameters<typeof applyOcrTags>[2][number]['custom_props']>
  },
): Promise<Array<{ id: string; title: string }>>   // 保存 tx: cards INSERT + applyOcrTags + card_count
export async function completeUploadTx(
  db: ReturnType<typeof getDb>,
  args: { sourceDocumentId: string; userId: string; filename: string; totalSize: number; totalPages: number; cardsExtracted: number; ocrCostYen: number },
): Promise<void>
export async function markFailed(/* 既存 signature 不変 :722-731 */): Promise<void>
```

**制約:**
- **保存 tx = cards INSERT + `applyOcrTags` + card_count を同一関数・同一 tx に保つ**(条件 2・同 tx 前提採番)。tx 範囲は確認済: `db.transaction`(:541)内 = INSERT(:542-545)+ applyOcrTags(:546-553)+ exams UPDATE(:554-563)+ `return inserted`(:564)で全体が :541-565 に収まる。
- body 内の `pipelineResult.cards[i].custom_props` 参照のみ `args.customProps[i]` に置換(**Task 3 コメントと並ぶ verbatim 例外・canonical/Codex review の重点項目に指定**)。`inserted[i] ⟷ cardRows[i] ⟷ customProps[i]` の index 対応は drizzle bulk INSERT + RETURNING の VALUES 順保持に依拠(既存契約・:537-540 コメント)— 呼出側で配列順を変えない。customProps の型は実装時に `applyOcrTags` 実 signature から導出し optionality 一致を確認(手書きしない・Codex 論点)。
- 完了 tx / markFailed tx も各 1 関数。markFailed の best-effort(throw しない)・`source_documents.mark_failed.update_failed` log 不変。
- `exams.updatedAt` 据え置き(`sql\`${exams.updatedAt}\``)・`cardCount` 加算式・uploadRecords 書込値 = byte 温存。
- cardRows 構築(:512-527)と preview 構築(:661-686)は entry 残留(DB 非依存 mapping)。

**完了条件:** `process.test.ts` + `tests/contract/upload-result.contract.test.ts` green(revalidatePath 常時発火 golden 含む)。+ Global per-task gate。

---

### Task 6: 最終 gate + SSoT 完了記録 + baseline §B(vi) 追記(docs)

**目的:** phase 完了の whole-repo gate を通し、SSoT と smoke 申し送りを確定する。

**Files:**
- Modify: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(P2 行: 状態→完了 + HEAD SHA + 再スキャン記録 / 変更履歴 1 行)
- Modify: `docs/audit/2026-07-06-p0-contract-baseline.md` §B(vi)(P2 行追記: 触った surface = 演習 flush→dashboard / upload OCR→preview / stripe webhook 経路 / アカウント削除経路(OT 実機領域)。spec §8.4 を確定値に)

**制約:** 独立 docs commit(`docs(plans): P2 完了・SSoT 更新 [no-review]`)。code commit と混ぜない。報告に measure 配管 revert の申し送り再掲(spec §8.2)。

**完了条件:** whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm test`(full・contract 含む)/ `pnpm build` 全 exit 0、報告に「whole-repo lint exit 0 確認済」明記。SSoT P2 = 完了 + SHA。停止して OT 確認待ち(sprint 境界)。

---

## Self-Review(spec 突合)

- **Spec coverage:** A=Task1 / B=Task2 / C+E=Task3 / D=Task4+5(guard・persistence の 2 module = spec §4.4 の分割先 2 module と一致)/ §6-4・§6-5(SSoT・§B(vi))=Task6。追加条件: 条件1(Phase 0 境界)=Task1 制約 / 条件2(1 関数 = 1 tx)=Global+Task4/5 / 条件3(mock 境界)=Global+各 task 報告 / 条件4(golden 停止)=Global エスカレーション。
- **Placeholder scan:** module 名・行範囲・signature・export 集合は全て確定値。「verbatim」は移設操作の明示。
- **Type consistency:** `processSession`/`payloadSchema`(Task1)、`handleEvent`/`extractCustomerId`(Task2)、`handleEvent`(Task3・別 module で衝突なし)、`runUploadGuardTx`/`Destination`/`GuardTxResult`(Task4)、`saveExtractedCards`/`completeUploadTx`/`markFailed`(Task5)は定義と呼出で一貫。
- **依存順序:** Task 4→5 は同一 file(process.ts)編集のため順次。Task 1-3 は独立(subagent-driven で逐次実行)。Task 6 は全 task 後。

## Codex plan cross-check(実施済・2026-07-07)

`scripts/ai/codex-plan-review.sh ddd-p2-server-usecase` 実行済(detector PASS)。raw = `docs/codex/2026-07-07-plan-ddd-p2-server-usecase.md`。**採用 15 論点を本 plan に反映済**(本文中「Codex 論点」表記): tx 内 I/O は `tx` を通す / `import type { getDb }` / `ParsedEvent` type export / `User` import 元明記 / logger meta・notifyOps payload byte 温存明文化 / server-only 方針 / mock 到達性の列挙成果物化 / per-task full contract の曖昧さ排除 / SSoT commit 規律明文化 / idempotency→handleEvent 順序前提 ×2 / barrel 禁止 / Destination 非再 export / 保存 tx 範囲確定 + index invariant + customProps 型導出 / lib/reviews 暫定性の module コメント。**不採用(方針衝突・OT 確定済のため)**: per-task gate 軽量化(地雷領域ゆえ維持)/ guard・persistence の lib 化(in-place 確定)/ Phase 0 の lib 寄せ(条件 1 で route 残留確定)。
