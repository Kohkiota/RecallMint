# DDD P4 fact-finding(現 HEAD a62fb1c 再スキャン)

- 日付: 2026-07-07 / branch `dddrefactor` / HEAD `a62fb1c`(P3 docs gate 後)
- 方法: Explore 6 体並列(outbox flush / pull 6 module / retry・transient / route 認証 / lib 再編 / 申し送り 3 件)+ controller 裏取り(replacer verbatim・server-only 欠落・markSynced 系同型・retry 共有実態を直接確認)
- 参照: P4 handoff = `docs/plans/2026-07-07-p4-handoff.md` / audit §4.2・§6.1-7・§7(凍結)/ SSoT §3 N-1〜N-5

---

## 1. outbox flush 層(audit §4.2 第 1 項)

### 1.1 共有済み(= handoff の sanctioned scope は消化済み)

**P4 handoff が「共通化せよ」とする「Web Lock guard / result 分類」は現 HEAD で既に共有完了している。**

- `withWebLock`: `lib/sync/with-web-lock.ts:18-67` を両 flush が import(entity-mutation-flush.ts:24 / review-flush 側も使用)。
- `classifyFlushResults` + `FlushOutcome`: `lib/sync/review-flush.ts:53-71` 定義を entity-mutation-flush.ts:20-21 が import・使用(:48)。
- `FlushResult` 型: `lib/sync/review-events.ts` 定義を entity-mutation-flush.ts:19 が type import。

### 1.2 残余の同型重複(sanctioned scope の**外**)

table 名 + key 列名だけ違いの per-table 同型 5 対(controller 裏取り: markSynced / markAttempted は構造完全一致を確認):

| 対 | review 側 | entity 側 | 差分 |
|---|---|---|---|
| markSynced | review-events.ts:162-168 | entity-mutations.ts:145-153 | `answer_events`/`event_id` ⇄ `entity_mutations`/`mutation_id` のみ |
| markAttempted | review-events.ts:173-182 | entity-mutations.ts:164-173 | 同上 |
| dropStale | review-events.ts:188-204 | entity-mutations.ts:188-204 | 同上 + 古さ判定列 |
| fetch client wrapper | review-events.ts:238-257 | entity-mutations.ts:221-240 | endpoint / payload 名 |
| in-flight set | review-events.ts:215 | entity-mutations.ts:217 | インスタンス 2 つ(意図的分離) |

### 1.3 非対称(統合禁止 = N-2 準拠・現存確認)

- retry controller(指数 backoff 10s→30s→1m→5m→15m + jitter・attempt counter・coalesce): `lib/sync/review-flush.ts:103-233`。entity 側に対応物なし。
- onFlushed hook(pull-back 起動): review-flush.ts:122-125。
- session grouping: review = session 別 / entity = atomic single-batch。
- sessionSynced: review = session 内全 synced で true / entity = 常時 false(session 概念なし)。classifyFlushResults は sessionSynced を参照しない(`syncedEventIds.length > 0` 判定)ため共有に支障なし。

---

## 2. pull 6 module(audit §4.2 第 2 項 / §6.1-7 / N-3)

### 2.1 構成

統合 `/api/pull` 向け 6 module = `lib/db/{cards,exams,tag-categories,tag-options,card-tags,tombstones}-pull.ts` + 独立 route の `study-days-pull.ts`(第 7)。

### 2.2 同型パターンと差異

共通形: `getDb() → select().from(TABLE).where(user_id AND cursor列 >= since) → map(mapper) → { rows, maxXxx: maxIso(...) }`。差異は 3-tuple のみ:

- **cursor 列 3 種**: updatedAt(cards/exams/tag_categories/tag_options)/ **createdAt(card_tags 例外)** / deletedAt(tombstones)。
- **return key 命名 3 種**: maxUpdatedAt / maxCreatedAt / maxDeletedAt。
- **mapper**: cards のみ別 file(cards-mapper.ts・双方向)、他 5 つは inline。

### 2.3 card_tags 例外意味論(地雷・不変必須)

- server: card-tags-pull.ts:35-46(createdAt cursor)。
- client 補完(案 a): `lib/sync/pull.ts:16-20`(規約コメント)+ :213-225(変更カードの旧 card_tags 全削除 → 空 bulkPut)。**factory 化しても cursor semantics は entity 側に残す**。

### 2.4 PullResponse wire と手展開

- wire 型 = `lib/sync/pull.ts:42-61`(cursors key は `tombstone` のみ singular)。route 構築 = app/api/pull/route.ts:82-108。
- client 手展開現存: cursor read(pull.ts:119-145)+ write(:263-287)+ `SYNC_META_KEYS`(sync-meta.ts:16-27)。**手展開は wire 形状そのものに bind しており、N-3 の wire generic 化なしには消えない**。
- server-only 直接 marker 欠落 3 file(exams-pull / tombstones-pull / study-days-pull)— ただし全て `@/lib/db`(index.ts:4 server-only)経由で транз的にガード済 = **実害なし・cosmetic**(統一は factory 化時に自然解消)。

---

## 3. retry / transient(audit §4.2 第 3 項)

### 3.1 audit との乖離(重要)

audit「lib/retry に共通関数があるのに各自再実装」は**現 HEAD では大半解消済み**: `lib/retry/transient-error.ts`(isRateLimitError / isTransientError / computeBackoffMs)を ocr.ts:27 と review-flush.ts:29 の両方が import 済み。429 即停止(AI ルール)も両所で準拠(ocr.ts:133-134 / review-flush.ts:209-211)。

### 3.2 残余

1. **lib/clerk/handle-clerk-event.ts の local helper**: `runTransactionWithRetry`(:257-317・非 export・consumer は同 file の削除 tx のみ)+ `isTransientDbError`(:261-276・SQLSTATE ベース)。backoff = 500ms×2^n・jitter なし。
2. **判定コード集合の不一致**: isTransientDbError(40001/40P01/**08 前方一致**/57P01/57P02/57P03・code 不在 = transient)⇄ `lib/transient/classify-bulk-error.ts` TRANSIENT_PG_CODES(40001/40P01/**57014/53300**/08 個別 4 種/57P03・ZodError→4xx・unknown→transient)。エラーソースは同じ SQLSTATE だが集合と用途(client retry 判定 vs HTTP 応答分類)が異なる。
3. **並列 dir**: `lib/retry/`(transient-error.ts 1 file)と `lib/transient/`(classify-bulk-error.ts 1 file)。中身は HTTP/SDK message regex 系 vs DB SQLSTATE 系で別物 — 統合は「dir 統合(配置)」の問題であり「実装統合」ではない。
4. **対象外と判明**: `lib/stripe.ts cancelWithRetry`(:80-95・429 のみ 1s 固定 1 retry・SDK maxNetworkRetries+Idempotency-Key 前提)は哲学が別で統合不適。`lib/ai/clients/gemini.ts parseRetryAfterMs` は ocr 専用付属。

---

## 4. route 認証 wrapper(audit §4.2 第 4 項)

- **6 route の内訳確定**: read-only 4(pull / study-days/pull / dashboard/stats / exams/status)= `getCurrentUser → !user なら 200 + 空 data + Cache-Control: no-store`、mutation 2(entity-mutations/bulk / review-events/bulk)= `!user なら 401 {error:'user_not_synced'}・no-store なし`。webhook 2 本(clerk/stripe)は署名検証ベースで**対象外**。
- 既存 helper: `getCurrentUser` / `UnauthenticatedError`(lib/auth/)はあるが**認証後のレスポンス定型は全 route inline**。
- 共通化の現実解 = read-only 4 本向け wrapper(空 body shape が entity 別なので shape は引数)。mutation 2 本は classifyBulkError 応答と絡み形が別 — 無理に 1 wrapper に畳まない。
- 凍結注意(D-2): 401 vs 200+empty の意味論 / no-store / body shape / log level はすべて凍結対象。wrapper 化は「同一バイトの応答を返す」ことが完了条件。

---

## 5. lib ディレクトリ再編(audit §4.2 残項 + handoff 第 5 項)

詳細 = Explore 保存レポート(scratchpad・要点のみここに転記):

1. **並行命名 2 組**: `lib/clerk.ts`(env fail-fast)⇄ `lib/clerk/`(webhook use-case)、`lib/stripe.ts`(env fail-fast + SDK init)⇄ `lib/stripe/`(billing use-case 3 file)。env prefix 検証は同型 ~92%(Stripe のみ rk_/sk_ dual prefix)。
2. **Error replacer verbatim 重複**(controller 裏取りで本体完全一致を確認): `lib/logger.ts:46-58 expandError` ⇄ `lib/ops.ts:121-133 makeReplacer`。
3. **VERCEL_ENV inline**: `VERCEL_ENV ?? NODE_ENV` 系 + `VERCEL_ENV === 'production'` 判定が lib/app 横断 12+ file(logger.ts:69 / ops.ts:106 / handle-stripe-event.ts ×6 / handle-clerk-event.ts ×2 他)。
4. **toISOString inline ~18 production file** — ただし clock 注入(latent 不純)は baseline §B で**別 phase 申し送り済み**。nowIso() helper 化はその設計判断を先取りするため P4 での扱いは要判断(下記論点)。
5. `lib/actions/` は**既存**(result.ts = ActionResult 型のみ)→ contact action 移設の自然な受け皿。
6. lib 全域 'use client' ゼロ維持・server-only 直接 marker 16 file(境界の現状は P0 audit と同型)。

---

## 6. 申し送り 3 件

1. **P2 measure 計測配管**: 現存 = route.ts:70-86(measureEnabled + measure closure + tStart)・:111(session-upsert)・:173-182(total 集計 + `review_events.bulk.timing` log)+ ingest-review-events.ts の measure 注入引数(:91)と 6 call site(:109/:173/:228/:256/:273/:336)。processSession の call site は route.ts 1 箇所のみ → revert 作業量 **S**。`review_events.bulk.timing` イベント名は D-2 凍結(revert = イベントごと消すか名前維持かは OT 判断の一部)。
2. **contact-form components→app**: `components/marketing/contact-form.tsx:4` が `@/app/(marketing)/contact/actions` を import(Block A 違反・eslint.config.mjs:134-139 で唯一の Block A allowlist)。解 = `submitContact` を `lib/actions/contact.ts` へ移設(既存 dir)+ co-located test 同時移動 + allowlist 削除。影響 3-4 file・作業量 **M**(配置判断込み)。
3. **PullResponse wire generic 化(N-3 任意 consider)**: client 手展開(§2.4)は wire 形状 + SYNC_META_KEYS に bind。generic 化は cursors key の非対称(singular `tombstone`)と card_tags 例外を型に持ち込む割に、消える重複は read/write 手展開 ~50 行のみ。**費用対効果低の見立て**(spec で正式判断・理由記録)。

### lint allowlist 現況(P3 Task8 後)

Block A 残 1 件(contact-form・上記 2 で解消可能)/ cross-feature 3 件(custom-filter-form / card-tag-edit-fields / column-pinning)= **P4 対象外**(app 内分割・lib 再編と独立)/ react-hooks/refs 1 件 = Sync-fix-1 待ちで P4 対象外。

---

## 7. audit との乖離まとめ(spec 前提に反映すべき点)

| # | audit の主張 | 現 HEAD 実態 |
|---|---|---|
| A | outbox flush 共通化は「Web Lock guard / result 分類に限定」して**これから**やる | **その限定範囲は既に共有済み**。残余は sanctioned scope 外の per-table 同型 5 対(§1.2) |
| B | retry 3 実装が「lib/retry に共通関数があるのに各自再実装」 | ocr / review-flush は**共有済み**。残余は clerk local helper + dir 並列のみ(§3.2) |
| C | route 認証 boilerplate「6 route 重複」 | 6 route は現存だが**2 形態**(read-only 4 ⇄ mutation 2)で単一 wrapper 不成立(§4) |
| D | pull 6 module 同型 | 一致(cursor 列 3 種・return key 3 種の差異まで確定)(§2) |

---

## 8. spec 主判断点(OT 論点)

1. **outbox 残余の in/out**: sanctioned scope 消化済みを受け、(a) outbox 項目は「確認のみ・完了扱い」 or (b) per-table 同型 5 対の機械的 helper 化まで拡張(N-2 の非対称 = retry controller / pullBack / session grouping は不触のまま守れる)。
2. **申し送り 3 件**: measure revert(S・イベント名の扱い含む)/ contact-form → lib/actions 移設(M)/ PullResponse generic = 不採用の見立てで良いか。
3. **retry 残余**: clerk local runTransactionWithRetry を (a) 現状維持(consumer 1 箇所・YAGNI) or (b) lib/db へ汎用化 + 判定コード集合を classify-bulk-error と突き合わせ整理。lib/retry ⇄ lib/transient の dir 統合(配置のみ)の要否。
4. **route wrapper 範囲**: read-only 4 本のみ wrapper 化(mutation 2 本は現状維持)で良いか。
5. **lib 再編の深さ**: 並行命名 2 組の解消(env validation を lib/env へ?)・replacer 統合・VERCEL_ENV helper 化は明確。**toISOString nowIso() 化は clock 注入申し送り(別 phase)と絡むため P4 で触らない**案を推奨するか。
6. **簡潔性規律との線引き**: P4 は「DRY のための抽象化」を作る phase だが rule of three / YAGNI は維持(実重複 3+ のみ対象化・予測共通化しない)を spec 冒頭に明文化。
