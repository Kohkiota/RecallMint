# 演習 push 失敗時 retry の現状 + Web Locks 導入前提の棚卸し

- 日時: 2026-05-29
- 種別: investigation / session log (**実装変更・commit なし**、 成果物は本 doc のみ)
- 対象 branch: `develop`
- 目的: 演習 push (review-events) に (1) 指数 backoff + 429 即停止の retry 規律、 (2) Web Locks 多タブ flush 排他、 を導入する**前**に、 現状の retry 実態と Web Locks 被せの境界を実コードで確定する (決定はしない)
- 手段: grep + 実コード read (推測排除)。 対象 file は grep で自己特定
- 関連: `docs/cache-fix-roadmap.md` §5.1 (retry / 24h drop / Web Locks の確定スコープ)、 前 investigation 2 本 (localsync-mvp / inline-edit-send-timing)

### 対象ファイル (grep + read で特定)

| 役割 | path |
| --- | --- |
| flush 経路本体 | `lib/sync/review-events.ts` |
| flush 呼出元 (trigger) | `app/(app)/app/study/smart/_components/session-runner.tsx` |
| bulk endpoint (status code 設計) | `app/api/review-events/bulk/route.ts` |
| Dexie schema (timestamp 列 / index) | `lib/client-db.ts` |
| 既存 retry/backoff の完成形 (OCR) | `lib/ai/ocr.ts` + `lib/ai/clients/gemini.ts` |

---

## 軸1. 送信失敗時の現状挙動

### flush 失敗時の pending 残置と再送

- `flushPendingEvents` (`review-events.ts:245`) は `client.post(payload)` (`:305`) の結果が `!response.ok || !response.body || response.body.ok !== true` のとき **何も synced 化せず、 対象 event を pending のまま返す** (`:306-316`)。 `markAnswerEventsSynced` (`:324`) は成功時のみ。 = **失敗 = Dexie 上 `sync_status='pending'` のまま据置**
- network / timeout: `defaultClient.post` の `fetch` が throw すると `catch` で `{ok:false, status:0, body:null}` を返す (`:217-219`) → 同じく全件 pending 据置
- 部分失敗: server が 200 + `failed[]` を返した場合のみ、 failed 以外を synced 化し failed は pending 据置 (`:318-332`)。 session 側 sync_status は「全 event synced」 時のみ `synced` に倒す (`:329-331`)
- **next trigger での再送**: pending は次の flush で再 pickup される。 trigger は現状 **2 種のみ** (`session-runner.tsx`): ① 回答ごとに pending が `FLUSH_THRESHOLD=5` (`:72`) 到達で `flushPendingEvents` (`:285-286`)、 ② `phase==='finished'` で `completeStudySession` → `flushAllPendingEvents` (`:300-310`)。 **online / visibilitychange / mount 時の再送 trigger は無い** (前 investigation で確認済、 grep 0 件)

### in-flight 中の重複排除 (問題 2)

- module-scope `inFlightEventIds` Set (`:182`) が event_id 単位で並走 flush を排除 (`:265,278`)、 `finally` で解放 (`:343-345`)。 失敗してもここで解放されるため next flush で再 pickup 可能

### 失敗の UI / state 反映

- **失敗は UI に出さない (silent)**。 `session-runner.tsx` の runSubmit 内 flush は `try/catch` で握りつぶし「次 trigger で再試行」 とコメント (`:280-294` 周辺)、 finished useEffect も `flushAllPendingEvents()` を `catch {}` で silent (`:307`)
- = 旧 submitReview の inline error UI は廃止済。 失敗は state にも反映されず、 pending 残置のみが「未送信」 の唯一の痕跡

---

## 軸2. transient error 判定の現状

### review-events flush 側: status 分類は事実上ゼロ

- flush は `response.status` を受け取るが (`:194-198,216`)、 **429 / 503 / その他を区別していない**。 唯一の分類は `FlushResult.reachable = response.status >= 400 && response.status < 600` (`:314`) で「API に届いたか / fetch level fail か」 を見るだけ。 429 と 503 は**完全に同一視** (両方とも「失敗 → pending 据置 → next trigger」)
- bulk endpoint 自身が返す status は **200 (`{ok,failed}`) / 400 (invalid_json・invalid_payload) / 401 (unauthenticated・user_not_synced) / 500 (session_upsert_failed)** のみ (`route.ts:440,448,474,481,532,548`)。 **429 / 503 は route から出さない** (rate limit gate なし)。 = 実 429 は来るとすれば Vercel / WAF / infra layer 由来
- → backoff 導入時は client が `response.status` で 429/5xx/4xx を**新規に分類**する必要がある (現状その分岐が無い)

### 既存の完成形: OCR pipeline (`lib/ai/ocr.ts`) — 429 と 503 を厳密に分離

CLAUDE.md AI ルール 5「429 即時停止・リトライ禁止」 を実装した参照実装が既にある:

| 判定関数 | 対象 | 挙動 | file:line |
| --- | --- | --- | --- |
| `isRateLimitError` | `\b429\b` / `rate ?limit` / `resource_exhausted` | **即 throw (retry も fallback もしない)** | `ocr.ts:93-100` |
| `isTransientError` | `500\|502\|503\|504` / `timeout` / `unavailable` / network (`ECONNRESET` 等) | retry 対象。 **429 は明示除外** (`:103` コメント) | `ocr.ts:110-120` |

- retry loop (`callWithRetry` `:134-173`): `MAX_HTTP_RETRIES=2` (`:84`)、 `isRateLimitError` なら即 throw (`:162`)、 transient かつ attempt 上限未満なら backoff 後 retry (`:163-171`)
- backoff: `BACKOFF_BASE_MS=[5000,20000]` + `BACKOFF_JITTER_MAX_MS=[2000,5000]` (`:126-127`)、 `setTimeout` 待機 (`:171`)。 server 指示 `Retry-After` があれば優先し `RETRY_AFTER_CAP_MS=60000` で clamp (`:132,166-170`、 `parseRetryAfterMs` は `gemini.ts:58-88`)
- → **429 と 503 を同一視していない**のは OCR 側のみ。 review-events 側は未分類。 演習 push に同等の規律を入れるなら、 この 2 関数の判定方針 (特に 429 即停止 = retry 対象から除外) を踏襲できる

---

## 軸3. backoff / timer の配置先

- **現状 flush 経路に retry 間隔制御は一切無い**。 `flushPendingEvents` (`:245`) は 1 回 POST して結果を返すだけ、 `flushAllPendingEvents` (`:227`) は session 別に `Promise.allSettled` で 1 回ずつ並列 flush するだけ (`:235-237`)。 timer / sleep / 再 invoke scheduling は無い
- **挟める位置の候補** (現状コードから):
  - (a) `flushPendingEvents` 内: POST 失敗時に `setTimeout` で自己再 invoke — ただし session-runner unmount で timer 消失 (component lifecycle 非依存にするなら module-scope timer 管理要)
  - (b) flush の呼出元 (orchestrator 新設): trigger 層で「失敗 → backoff schedule」 を持つ。 LocalSync orchestrator (前 investigation で新規予定) に集約する形
- **既存 setTimeout/debounce 資産**:
  - review-events 側には **無い** (flush は debounce なし、 `recordAnswerEvent` も「debounce なし」 と明記 `review-events.ts:8`)
  - debounce の実装例は inline 編集側 (`inline-text-field.tsx:160-168` 等の `scheduleSend`/`clearTimeout`) と OCR の `setTimeout` backoff (`ocr.ts:171`) にある。 ただし inline debounce は component-scope (unmount 消失)、 OCR backoff は server-side の同期 loop 内 (`await new Promise(setTimeout)`) で、 **client の永続 retry には直接転用しにくい** (lifecycle / 永続性が違う)
- → backoff の「待機計算ロジック」 (BASE+jitter / Retry-After clamp) は OCR から流用可。 「いつ再 invoke するか」 の scheduling は client では新規設計 (component lifecycle に縛られない module / orchestrator 層)

---

## 軸4. 24h 超 pending silent drop の前提

### timestamp 列の有無

`ClientAnswerEvent` (`client-db.ts:128-140`):

| 列 | 用途 | drop 判定に使えるか |
| --- | --- | --- |
| `answered_at: string` (ISO8601、 常に set: `recordAnswerEvent` `:130`) | client 回答時刻 | **使える** (= event 作成時刻として 24h 経過判定の基準に直接利用可) |
| `last_attempted_at?: string \| null` | 最終試行時刻 (型に存在) | **現状 dormant** — `recordAnswerEvent` は set せず、 flush も update しない (grep で write 箇所 0)。 「最終試行」 基準で drop したいなら flush 時に書き込む配線が新規要 |

### index の有無

- answer_events の Dexie index = `++local_id, event_id, session_id, card_id, sync_status` (`client-db.ts:195`)。 **`answered_at` / `last_attempted_at` は index されていない**
- → 24h drop の scan は index range query では引けず、 `where('sync_status').equals('pending')` で pending を絞った後に **JS 側で `answered_at` を時刻比較**する形になる (pending 件数は小規模想定なので実害は小だが、 index 前提の設計はできない)

### 実装可否

- **可能**。 `answered_at` を作成時刻基準にすれば schema 変更なしで 24h 判定できる。 「最終試行時刻」 基準にしたい場合のみ `last_attempted_at` の write 配線 (flush 時 update) が追加で要る
- drop の意味: 該当 pending を `synced` ではなく削除 or `failed` 隔離 (roadmap §5.1 は「silent drop」)。 現状 `SyncStatus` は 4 値 (`pending/syncing/synced/failed`、 `client-db.ts:30`)、 drop を `failed` 表現にするか物理 delete にするかは設計判断

---

## 軸5. Web Locks 導入の境界

### 現状

- **`navigator.locks` は repo 全体で 0 件** (lib/app/components grep、 前 investigation と一致)。 初導入
- 現状の多重 flush 防止は **module-scope `inFlightEventIds` Set のみ** (`review-events.ts:182`)。 これは **同一 JS realm (= 同一タブ / 同一 document) 内**の並走しか排除できない。 **別タブは別 realm で別 Set を持つため、 多タブ同時 flush は現状ノーガード** (server 側 event_id UNIQUE + ON CONFLICT DO NOTHING で吸収している、 後述軸6)

### Web Locks と in-flight guard の併用境界

- 2 つは**層が違う**:
  - `inFlightEventIds` (module Set): 同一タブ内の event_id 単位並走排除 (細粒度、 既存)
  - Web Locks: **タブ間**の flush 排他 (粗粒度、 新規)。 `navigator.locks` は origin 単位で全タブ共有されるロックマネージャ
- → **併存させる** (どちらかに統合する話ではない)。 Web Locks で「同時に flush するタブは 1 つ」 を保証し、 その内側で既存の in-flight Set が同一タブ内重複を防ぐ、 という二段

### lock を被せる関数

- 候補は **`flushAllPendingEvents` (`:227`)** または **`flushPendingEvents` (`:245`)**:
  - `flushAllPendingEvents` に被せる = session 完了 sweep 全体を 1 lock。 粗いが「全 session 一括送信」 の単位と一致
  - `flushPendingEvents` に被せる = session 単位 lock。 細かいが `flushAllPendingEvents` が内部で session 別に複数回呼ぶ (`:236`) ため lock 取得が複数回 / 入れ子になる懸念
- → 「flush 経路の最外 entry」 に被せるのが素直。 ただし現状 2 つの公開 entry があり、 経路1 (`flushPendingEvents` 直接) と経路2 (`flushAllPendingEvents`) の両方を 1 つの lock 名でくくる必要がある

### lock 取得失敗時 (他タブ保持中) の扱い

- `navigator.locks.request(name, options, cb)` の `ifAvailable: true` を使えば「取得できなければ即 `null` で cb を呼ばずに返る」 が選べる。 演習 push の性質上:
  - 他タブが flush 中なら **当該タブは skip して良い** (同じ pending を server に二重送信しても event_id UNIQUE で吸収されるため、 待つ必要性は低い)。 = `ifAvailable` で「取れなければ skip、 pending は据置で次 trigger に委ねる」 が現状の冪等性と整合
  - あるいは default (待機) で「順番待ち」 にもできるが、 演習 push は遅延許容なので skip の方が単純
- → **論点**: skip (ifAvailable) か 待機か。 冪等性が効いているので skip 寄りが自然だが、 これは設計判断

### Web Locks 非対応 fallback

- 非対応環境 = iOS Safari 16.4 未満等。 PWA 対象は `review-events.ts:29-30` コメントで **iOS 16.4+ / Android Chrome** と明記 (= `crypto.randomUUID` の fallback も「敢えて入れない」 方針)
- Web Locks は iOS Safari 15.4+ で利用可のため、 **対象環境 (16.4+) では全て対応**。 ただし `navigator.locks` が `undefined` の場合の fallback (= lock なしで従来通り flush、 server UNIQUE に委ねる) を defensive に入れるかは設計判断 (roadmap §5.1 は「非対応は UNIQUE で server 吸収」)

---

## 軸6. 既存 pattern / 冪等性を壊さないかの評価

| 既存 pattern | 影響評価 |
| --- | --- |
| **event_id UNIQUE + ON CONFLICT DO NOTHING** (server 冪等) | retry / backoff / 多タブ flush は**全てこの冪等性の上に乗る安全な操作**。 同じ event を何度送っても server は 1 回しか適用しない。 backoff 追加で送信回数が増えても冪等性は不変。 Web Locks skip で「待たずに諦めて後で再送」 しても二重適用にならない |
| **問題 2: in-flight guard** (`inFlightEventIds`) | Web Locks は**上位層**として併存。 既存 Set のロジックを変えずに外側を lock で囲むだけなら非破壊。 ただし lock 取得を flush 内に入れる場合、 `finally` の Set 解放 (`:343-345`) と lock 解放の順序 / 例外時解放を壊さないこと |
| **問題 3: 単一 tx + bulk SQL + RETURNING 照合** (`route.ts`) | server 側は client の retry 方式に非依存。 retry/backoff/locks は全て client 側の話で、 bulk endpoint の tx 構造には触れない = 非破壊 |
| **部分失敗 failed[]** (`:318-332`) | backoff retry が「failed だった event を後で再送」 する形になるが、 failed は pending 据置のままなので次 flush で自然に再 pickup される既存挙動と整合。 ただし backoff 導入で「failed を即再送せず待つ」 にする場合、 現状の「next trigger 即 pickup」 とのタイミング差を設計で明示要 |
| **session sync_status 倒し** (`:329-331`) | 「全 event synced で session synced」 のロジックは retry 回数に非依存。 非破壊 |

→ **総じて、 retry/backoff/Web Locks はいずれも event_id UNIQUE 冪等性の上に乗る加算的変更で、 既存 pattern を壊さない**。 唯一注意は (a) in-flight Set 解放と lock 解放の順序、 (b) backoff で「即再送 → 待って再送」 に変えた場合の trigger タイミング整合。

---

## まとめ: 現状コードから導かれる選択肢と論点 (決定せず)

### 1. retry / backoff の実装方針

- **流用可**: OCR の判定 2 関数の方針 (`isRateLimitError`=429 即停止 / `isTransientError`=5xx・timeout・network) と backoff 計算 (BASE+jitter / Retry-After clamp、 `ocr.ts:93-132`)。 ただし OCR は server-side 同期 loop、 演習 push は client 永続 retry なので**計算ロジックのみ流用、 scheduling は新規**
- **新規要**: ① client 側で `response.status` を 429/5xx/4xx に分類する分岐 (現状 `reachable` のみで未分類)。 ② 「いつ再 invoke するか」 の scheduling — component lifecycle に縛られない module / orchestrator 層 (component-scope timer は unmount 消失)。 ③ 429 は CLAUDE.md ルール 5 に従い**即停止 (自動 retry 停止)**、 5xx/network は有限 backoff retry、 という分岐
- **論点**: (A) backoff timer をどの層に置くか (flushPendingEvents 内自己再 invoke / orchestrator 集約)。 (B) 429 即停止後の復帰 trigger (online / 次 session / 手動)。 (C) retry 回数上限と間隔 (roadmap §5.1 案 = 5 回・10s→30s→1min→5min→15min) を OCR の [5s,20s] とどう揃える/変えるか

### 2. Web Locks の lock 粒度と被せ位置

- **粒度の選択肢**: (A) flush 全体を 1 lock (`recallmint:localsync:flush:${dbUserId}` 相当、 全 table 共通) / (B) review-events 専用 lock (演習 push のみ排他)。 roadmap §5.1 は前者寄り (LocalSync 全般 flush を 1 lock)
- **被せ位置**: flush の最外 entry。 現状 2 entry (`flushPendingEvents` 直接 / `flushAllPendingEvents`) があるため、 両方を同一 lock 名でくくる必要。 `flushAllPendingEvents` 内の per-session `flushPendingEvents` 呼出 (`:236`) で lock が入れ子にならないよう、 lock は呼出元 (orchestrator) で 1 回取る設計が素直
- **取得失敗時**: 冪等性が効いているため `ifAvailable: true` で **skip (pending 据置・次 trigger 委譲)** が自然。 待機より単純で二重送信も無害。 ただし設計判断
- **fallback**: 対象環境 (iOS 16.4+) は全て Web Locks 対応。 `navigator.locks === undefined` の defensive fallback (lock なしで従来 flush、 server UNIQUE 吸収) を入れるかは判断

### 3. 24h drop の実装可否

- **可能 (schema 変更なし)**: `answered_at` (常に set、 `client-db.ts:135`) を作成時刻基準に使えば 24h 経過判定できる。 index は無いので pending を絞ってから JS 側で時刻比較
- **論点**: (A) 基準を `answered_at` (作成時刻) にするか `last_attempted_at` (最終試行、 ただし現状 dormant で write 配線が新規要) にするか。 (B) drop の表現 — 物理 delete か `failed` 隔離か (SyncStatus 4 値の `failed` 流用可)。 (C) drop を silent にする (roadmap §5.1) か UI 通知するか
