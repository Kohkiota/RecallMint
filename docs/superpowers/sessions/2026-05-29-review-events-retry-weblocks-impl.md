# 演習 push (review-events) の失敗保全 + 多タブ排他 実装

- 日時: 2026-05-29
- 種別: implementation / session log (feat、 TDD)
- 対象 branch: `develop` (commit のみ、 push は OT)
- 事前調査: `docs/superpowers/sessions/2026-05-29-review-events-retry-weblocks-inventory.md` (方針確定済)
- 関連: `docs/cache-fix-roadmap.md` §5.1 (retry / 24h drop / Web Locks の確定スコープ)

## 結論

演習 push に (1) transient 判定の共有 util 化、 (2) 指数 backoff retry (タブ起動中のみ)、
(3) mount / visibilitychange / online の再送 trigger、 (4) 24h 超 pending silent drop、
(5) Web Locks 多タブ flush 排他、 を **全て加算的に** 実装。 既存 idempotency
(event_id UNIQUE + ON CONFLICT) と問題 2/3 pattern (in-flight guard / bulk SQL /
serializeDbError / RETURNING 照合 / timestamptz ISO bind)・session-runner・bulk route は
**未改変**。 全 927 test green / build clean。

## スコープと実装物

| # | 内容 | 実装 (file) |
| --- | --- | --- |
| 1 | transient 判定共有 util (429≠503) | **新規** `lib/retry/transient-error.ts` (`isRateLimitError`/`isTransientError`/`computeBackoffMs`)。 `lib/ai/ocr.ts` は **import 差し替えのみ** (private 関数削除 → 共有 import、 挙動不変) |
| 2 | 指数 backoff retry (タブ起動中) | **新規** `lib/sync/review-flush.ts` `createReviewFlushController` (closure-scope timer)。 transient のみ retry、 429 即停止、 既定 5 回 10s→30s→1min→5min→15min + jitter |
| 3 | 再送 trigger 追加 | **新規** `app/(app)/app/_components/review-flush-trigger.tsx` (mount / visibilitychange(visible) / online)、 `app/(app)/app/layout.tsx` に mount |
| 4 | 24h drop + last_attempted_at write | `lib/sync/review-events.ts` に `dropStalePendingAnswerEvents` (answered_at 基準、 `failed` 隔離) 追加 + flush 試行時の `last_attempted_at` 打刻配線 |
| 5 | Web Locks 多タブ排他 | `lib/sync/review-flush.ts` `runGuardedFlush` (固定 lock 名 + `ifAvailable:true` で待たず skip、 lock→in-flight→POST→in-flight 解放→lock 解放 の LIFO、 `navigator.locks` 存在チェックのみ defensive) |

補足:
- FlushResult に `httpStatus` を加算 (retry 分類用)。 `classifyFlushResults` が 429→rate-limited (優先) / 5xx・network→transient / 4xx→permanent / 空→no-pending / lock 不可→lock-busy に畳む。 status→signal は `statusToSignal(0)='fetch failed'` で network を transient に。
- 観測ログ (logger.info): `kick`(reason+outcome) / `retry_scheduled`(attempt+delayMs) / `rate_limited_stop` / `retry_exhausted` / `lock_busy` / `stale_dropped`(count)。

## 設計上の判断

- **session-runner は未改変**: 演習中 (5 件閾値) / 完了 flush は active tab・in-flight guard 済のため直 flush 維持。 Web Locks は **回復経路** (mount/visibility/online/retry) に被せる = 多タブ races (複数タブが残 pending を同時 flush) が実際に効く所。 active tab 自身の重複は server 冪等で吸収。
- **retry timer は closure-scope** (module singleton ではない): `ReviewFlushTrigger` が controller を保持。 (app) layout は内部 navigation で unmount しないため /app/* 滞在中は生存、 離脱/タブ閉で stop()・pending は Dexie 残置 → 次 mount で回復。
- **24h drop は `failed` 隔離** (物理削除せず): 痕跡を残し以降の自動 retry 対象から外す。 `answered_at` 基準 (常に set される作成時刻)、 境界 (ちょうど 24h) は残す。

## TDD 記録 (test 先行 → RED → 最小実装 → GREEN)

| unit | test file | 内容 |
| --- | --- | --- |
| 1 | `lib/retry/transient-error.test.ts` | 429/5xx/network/4xx 分類、 429≠503 相互排他、 computeBackoffMs 決定論 (11 test) |
| 2 | `lib/sync/review-events.test.ts` (追記) | httpStatus 載せ、 last_attempted_at write 配線、 dropStale (boundary / synced 除外 / 戻り値) |
| 3 | `lib/sync/review-flush.test.ts` | classify / Web Locks (busy→skip・非対応→直 flush) / backoff retry / 429 即停止 / lock-busy / 打ち止め / **coalesce** (17 test) |
| 4 | `app/(app)/app/_components/review-flush-trigger.test.tsx` | mount drop+kick / visibility / online / unmount stop+listener 解除 (5 test) |

各 unit で RED (module/関数/behavior 欠落) を確認後に最小実装で GREEN。 OCR (45 test) は extract 後も green = 挙動不変を実証。

## Code review (canonical 経路)

- 経路: `superpowers:requesting-code-review` skill / general-purpose subagent / template 改変なし。 working tree diff (HEAD=613400a) を対象。
- 結果: **Critical 0 / Important 2 / Minor 3**。
- Important 対応:
  - **#1 retry chain stall (concurrent kick で retry timer が no-op に飲まれ得る)** → `kick` を coalescing rerun loop 化 (実行中の kick/retry は drop せず完了後 1 回追走)。 回帰 test 2 本追加。
  - **#2 comment 過大記述 (timer の unmount 越え生存)** → closure-scope / layout 持続性に即した記述へ修正。
- Minor 対応: #5 (log spread clobber) → `{...extra, event}` 順に修正。 #3 (`reachable` 旧 field) は既存 test が assert し dead でないため据置。 #4 (permanent の可観測性) は `kick` ログが outcome を含むため据置。
- Important 残し: なし (両方 fix)。 本変更は 決済/認証/削除/外部副作用 のいずれにも非該当 (自前 API への内部 POST) のため review pass で `[reviewed]` 可。

## 検証

- `pnpm test`: 83 files / **927 passed**
- `pnpm build`: **Compiled successfully** (型エラーなし、 static 25/25)
- OT 実機 smoke (任意): stg で 演習完了 → オフライン化 → online 復帰で pending flush 回復 / 2 タブ同時で二重 POST が lock 又は server UNIQUE で吸収されること、 が後追い確認候補 (Vercel log の `review_events.flush.*` で事実確認可)。
