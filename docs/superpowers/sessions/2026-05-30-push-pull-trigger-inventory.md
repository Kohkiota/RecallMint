# push / pull トリガー棚卸し (step1-6 反映「いま現在」)

調査日: 2026-05-30 / branch: develop / HEAD: b0a46cd
方針: 実装変更なし・推測禁止・実コード根拠付き。step6 の「一覧に効く操作への pull 相乗り」は
**未実装(予定)** と判明したため、現状発火するものと区別して記載する。

---

## 1. 結論

- **push** は 2 系統: ①演習 review-events flush → `POST /api/review-events/bulk`、
  ②試験編集 → server action (Drizzle 直書き、REST endpoint ではない)。
- **pull** は 2 経路: ①cards/exams/tombstone 増分 = `runGuardedPull → pullDelta → GET /api/pull`、
  ②study_days full-window = `pullAllStudyDays → GET /api/study-days/pull`。`pullBack()` は両方を
  fire-and-forget で同時に叩く。
- pull の発火点は現状 **mount / visibilitychange / online / flush 成功後の pull-back(3 経路)** のみ。
- **step6 で追加予定の「OCR 完了 / 試験作成 / 試験削除 / カード追加 / カード削除 への pull 相乗り」は
  未実装**。該当箇所はいずれも現状 `router.refresh()` のみ(RSC 再 fetch)で、`runGuardedPull` /
  `pullBack` を呼んでいない。

---

## 2. push トリガー 根拠 (file:関数:行)

### 演習 review-events flush (送信先 = `POST /api/review-events/bulk`, bulk/route.ts:433)

| トリガー | 起点 (file:関数:行) | 経路 | Web Locks |
|---|---|---|---|
| 5 件閾値 flush | `session-runner.tsx:287-288` `runSubmit` 内 IIFE。pending ≥ `FLUSH_THRESHOLD(=5, :74)` で `flushPendingEvents(sessionId)` 直叩き | 直接 (controller 非経由) | なし |
| セッション完了 flush | `session-runner.tsx:306-316` `useEffect(phase==='finished')` → `completeStudySession` → `flushAllPendingEvents()` 直叩き | 直接 | なし |
| controller mount flush | `review-flush-trigger.tsx:45` `controller.kick('mount')` (前段 `dropStalePendingAnswerEvents` で 24h 超 pending を drop, :32) | `createReviewFlushController` → `runGuardedFlush` | あり(`recallmint:review-events:flush`) |
| controller visibilitychange(visible) | `review-flush-trigger.tsx:48-51` | 同上 | あり |
| controller online | `review-flush-trigger.tsx:53-55` | 同上 | あり |
| controller retry (backoff) | `review-flush.ts:200-203` `scheduleRetry` → `kick('retry')`。`outcome==='transient'` 時のみ(`review-flush.ts:229`)。429 は即停止(`:232-234`、CLAUDE.md ルール5)。5 回 10s→30s→1m→5m→15m+jitter(`:123-124`) | 同上 | あり |

補足: flush 本体 `flushPendingEvents` は in-flight `event_id` を除外して並走二重送信を防ぐ
(`review-events.ts:305-315`)。session-runner の直叩き 2 経路は Web Locks を**経由しない**
(controller 配線のみ runGuardedFlush)。多重は server 側 `event_id` UNIQUE + ON CONFLICT で吸収。

### 試験編集 (送信先 = Server Action / Drizzle 直書き、REST endpoint なし)

| トリガー | 起点 (file:関数:行) | 呼ぶ action | debounce | revalidate |
|---|---|---|---|---|
| inline text 編集 (sort_key/title/question_text/explanation_text/memo) | `inline-text-field.tsx:194 handleBlur` → `:169 scheduleSend` → `:139 send` → `updateCardField` | `update-card-field.ts:129` | **500ms** (`:53 DEBOUNCE_MS`), queue 付き | なし (`update-card-field.ts:151-158` で revalidatePath 撤去) |
| 選択肢 cell 編集 (id/text/explanation) | `inline-option-row.tsx` blur → 親 `InlineOptionList` send → `updateCardField(field='options')` (`:68` import) | `update-card-field.ts:129` | **500ms** (`:107`) | なし |
| 選択肢 checkbox (is_correct) | `inline-option-row.tsx` checkbox change → 親 send | `update-card-field.ts:129` | **なし=即時** (`:24` コメント) | なし |
| カード追加 | `inline-card-list.tsx:34 handleAddCard` → `createCard(examId)` | `create-card.ts:28` | 即時 (click) | `revalidatePath('/app/exams')` (`:34`) |
| カード削除 | `delete-card-button.tsx:30-31` `onConfirmDelete` → `deleteCard(cardId)` | `delete-card.ts:24` | 即時 (2段 confirm) | `revalidatePath('/app/exams')` (`:33`) |
| 試験作成 | `create-exam-form.tsx:38-39 onSubmit` → `createExam(name)` | `create-exam.ts:31` | 即時 (submit) | `revalidatePath('/app/upload')` (`:37`) |
| 試験削除 | `delete-exam-button.tsx:32-33 onConfirmDelete` → `deleteExam(examId)` | `delete-exam.ts:25` | 即時 (2段 confirm) | `revalidatePath('/app/upload')` (`:34`) |

---

## 3. pull トリガー 根拠 (file:関数:行)

### 共通 component (mount/visibility/online)
- `PullTrigger` は `(app)/app/layout.tsx:52` に mount(内部 navigation で unmount しない)。
  `pull-trigger.tsx:43 kick('mount')` / `:47 visibilitychange(visible)` / `:49 online`。
  kick は `runGuardedPull`(`:33`) と `pullAllStudyDays`(`:38`) を**並走**で叩く。
- `ReviewFlushTrigger` は `layout.tsx:56` に mount。flush 成功(`outcome==='ok'`)時に
  `onFlushed: () => pullBack('flush')`(`review-flush-trigger.tsx:27`)。

### 増分 cards/exams/tombstone (経路 = `runGuardedPull → pullDelta → GET /api/pull`, pull.ts:76/194)

| トリガー | 起点 (file:行) | in-flight guard |
|---|---|---|
| mount | `pull-trigger.tsx:43` | あり(`pull.ts:195 pullInFlight` + Web Locks `recallmint:pull` `:208`) |
| visibilitychange(visible) | `pull-trigger.tsx:47` | あり |
| online | `pull-trigger.tsx:49` | あり |
| pull-back: flush(controller) | `review-flush-trigger.tsx:27` ← `review-flush.ts:222-227 onFlushed` (`outcome==='ok'` のみ) | あり |
| pull-back: threshold-flush | `session-runner.tsx:292` `classifyFlushResults([r])==='ok'` 時 `pullBack('threshold-flush')` | あり |
| pull-back: session-complete | `session-runner.tsx:316` `classifyFlushResults(results)==='ok'` 時 `pullBack('session-complete')` | あり |

`pullBack(reason)` は `pull-back.ts:19-22` で `runGuardedPull` と `pullAllStudyDays` を各々独立
catch の fire-and-forget で起動。in-flight guard / Web Locks は `runGuardedPull` 側が担うため複数箇所
から呼んでも二重 pull にならない。

`classifyFlushResults` の 'ok' は「実 sync 成功(syncedEventIds 非空)」のみ(`review-flush.ts:52-64`)。
skip(attempted:0)/ session-only(events 無し)は 'no-pending' に畳まれ pull-back 不発。

### study_days full-window (経路 = `pullAllStudyDays → GET /api/study-days/pull`, study-days.ts:53)

| トリガー | 起点 (file:行) | guard |
|---|---|---|
| mount / visibilitychange / online | `pull-trigger.tsx:38` (kick 内で並走) | なし(idempotent full-replace, clear+bulkPut, cursor race なし) |
| pull-back(flush / threshold-flush / session-complete) | `pull-back.ts:21` (3 経路すべて pullBack 経由で同梱) | なし |

### 未実装(step6 で追加予定) — 現状は router.refresh() のみで pull 相乗りなし

| 予定トリガー | 現状コード (pull 不発の根拠) |
|---|---|
| OCR 完了 (processing→completed 遷移) | `exam-status-live.tsx:79-80` `hasCompletion` 真で `router.refresh()` のみ。`runGuardedPull`/`pullBack` の import・呼出なし |
| 試験削除 成功後 | `delete-exam-button.tsx:39` `router.refresh()` のみ |
| 試験作成 成功後 | `create-exam-form.tsx:41` `router.push` のみ |
| カード追加 成功後 | `inline-card-list.tsx:45` `router.refresh()` のみ |
| カード削除 成功後 | `delete-card-button.tsx:33` `router.refresh()` のみ |

注: これらは step6 で試験一覧を Dexie `useLiveQuery`(ExamListLive)参照へ切替える前提の相乗り
(plan: bf39b6a / 調査: b0a46cd)。現状の試験一覧は server-render のため `router.refresh()` で足り、
pull 相乗りは未配線。step6 では `exam-status-live.tsx:80` と `delete-exam-button.tsx:39` に
`runGuardedPull(step4)` を 1 行相乗りする計画(b0a46cd)。

---

## 4. 比較ドキュメント貼付用 (claude.ai: recallmint-idb-sync-bestpractice-comparison)

### 表A: push のトリガー一覧

| トリガー (起点イベント) | 対象 | 送信先 | 呼出箇所 | 備考 |
|---|---|---|---|---|
| 復習回答 pending 5 件到達 | 演習 | `POST /api/review-events/bulk` | session-runner.tsx:287 | 即時直叩き / Web Locks 非経由 / 失敗は pending 残置 |
| セッション完了 | 演習 | `POST /api/review-events/bulk` | session-runner.tsx:313 | 完了 status 書込→全 session group flush / 直叩き |
| mount (アプリ起動・復帰) | 演習 | `POST /api/review-events/bulk` | review-flush-trigger.tsx:45 | controller 経由 / Web Locks / 前段で 24h 超 pending drop |
| visibilitychange (タブ可視復帰) | 演習 | `POST /api/review-events/bulk` | review-flush-trigger.tsx:50 | controller 経由 / Web Locks |
| online (ネット復帰) | 演習 | `POST /api/review-events/bulk` | review-flush-trigger.tsx:54 | controller 経由 / Web Locks |
| retry (backoff) | 演習 | `POST /api/review-events/bulk` | review-flush.ts:202 | transient(5xx/network)のみ / 5回 10s→30s→1m→5m→15m+jitter / 429 即停止 |
| inline text 編集 blur | 試験編集 | Server Action `updateCardField` | inline-text-field.tsx:146 | **debounce 500ms** + queue / revalidate なし |
| 選択肢 cell 編集 blur | 試験編集 | Server Action `updateCardField(options)` | inline-option-row.tsx (InlineOptionList) | **debounce 500ms** + queue |
| 選択肢 checkbox 切替 | 試験編集 | Server Action `updateCardField(options)` | inline-option-row.tsx | **即時(debounce なし)** |
| カード追加 click | 試験編集 | Server Action `createCard` | inline-card-list.tsx:37 | 即時 / revalidatePath('/app/exams') |
| カード削除 確定 | 試験編集 | Server Action `deleteCard` | delete-card-button.tsx:31 | 即時(2段 confirm) / revalidatePath('/app/exams') |
| 試験作成 submit | 試験編集 | Server Action `createExam` | create-exam-form.tsx:39 | 即時 / revalidatePath('/app/upload') |
| 試験削除 確定 | 試験編集 | Server Action `deleteExam` | delete-exam-button.tsx:33 | 即時(2段 confirm) / revalidatePath('/app/upload') |

### 表B: pull のトリガー一覧

| トリガー (起点イベント) | 対象 mirror | 経由 | 呼出箇所 | 備考 |
|---|---|---|---|---|
| mount (アプリ起動・復帰) | cards / exams / tombstone | runGuardedPull | pull-trigger.tsx:43 | in-flight guard + Web Locks 有 / 実装済 |
| visibilitychange (可視復帰) | cards / exams / tombstone | runGuardedPull | pull-trigger.tsx:47 | guard 有 / 実装済 |
| online (ネット復帰) | cards / exams / tombstone | runGuardedPull | pull-trigger.tsx:49 | guard 有 / 実装済 |
| mount / visibility / online | study_days | pullAllStudyDays | pull-trigger.tsx:38 | guard 無(idempotent full-replace)/ 実装済 |
| flush 成功 pull-back (controller) | cards / exams / tombstone + study_days | pullBack → runGuardedPull + pullAllStudyDays | review-flush-trigger.tsx:27 | outcome==='ok' のみ / 実装済 |
| threshold-flush 成功 pull-back | cards / exams / tombstone + study_days | pullBack | session-runner.tsx:292 | classify 'ok' のみ / 実装済 |
| session-complete 成功 pull-back | cards / exams / tombstone + study_days | pullBack | session-runner.tsx:316 | classify 'ok' のみ / 実装済 |
| **OCR 完了 (processing→completed)** | exams (+ cards 件数) | (予定) runGuardedPull | exam-status-live.tsx:80 | **step6 予定**。現状 router.refresh() のみ |
| **試験削除 成功後** | exams / tombstone | (予定) runGuardedPull | delete-exam-button.tsx:39 | **step6 予定**。現状 router.refresh() のみ |
| **試験作成 成功後** | exams | (予定) runGuardedPull | create-exam-form.tsx:41 | **step6 予定**。現状 router.push のみ |
| **カード追加 成功後** | cards | (予定) runGuardedPull | inline-card-list.tsx:45 | **step6 予定**。現状 router.refresh() のみ |
| **カード削除 成功後** | cards / tombstone | (予定) runGuardedPull | delete-card-button.tsx:33 | **step6 予定**。現状 router.refresh() のみ |
</content>
</invoke>
