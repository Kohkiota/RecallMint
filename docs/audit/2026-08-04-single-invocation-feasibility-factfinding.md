# OCR+crop 1 invocation 化の実現性 fact-finding(調査のみ)

**日付**: 2026-08-04 / **範囲**: 実装・変更・migration・commit なし(read-only + 公式 doc 引用 + stg read-only 照会)

---

## ⚠️ 0. 副次発見(本調査中に検出・本題より優先度が高い可能性)

**stg の DB で `source_assets` / `upload_operations` / `asset_derivations` の RLS が無効。policy も 0 件。**

実測(stg・app role `recallmint_app` で read-only 照会):

```
-- 無関係な tenant context を張っても source_assets が読めてしまう
BEGIN; SELECT set_config('app.user_id','00000000-0000-0000-0000-000000000000',true);
  bogus_ctx_rows=2      -- source_assets: 他 user の行が見える
  bogus_ctx_exams=0     -- exams: 正しく 0 件(RLS 効いている)
COMMIT;

-- pg_class / pg_policies
RLS_OFF: ai_usage, asset_derivations, clerk_events, contact_messages,
         integration_failures, source_assets, stripe_events, upload_operations
RLS_ON_count=18
policies_on_ocr_tables=0   -- source_assets / upload_operations / asset_derivations
```

- 期待値との差: ledger は「stg DB: migration 0026-0030 + grants + **RLS policy(ocr-2-4a-enable.sql)適用**・runbook §2 検証 SQL 合格」と記録している(`.superpowers/sdd/2026-07-30-.../progress.md:521`)が、**現物は未適用**。
- 適用 SQL は repo に存在する: `db/policies/ocr-2-4a-enable.sql:24-33`(`ALTER TABLE source_assets ENABLE ROW LEVEL SECURITY` + `CREATE POLICY … FOR ALL TO recallmint_app`)。
- **なぜ検知されなかったか**: drift 検出 test は 3 表を対象に含む(`tests/integration/pg/rls-drift.test.ts:63-65`)が、実行先は **local iso PG に固定**(`tests/integration/pg/setup/db-url.ts` の `assertLocalTestDb`)。stg の drift は構造的に test では検出できない。
- 影響範囲: app コードは全 query に `WHERE user_id` を持つ多層防御があるため即時の情報漏洩を意味しないが、**RLS 層は効いていない**。prod flip の前提が崩れている。
- **本 doc の残りの調査結果とは独立の論点**。OT 判断事項として最上位に置く。

(参考: 他の RLS_OFF 5 表 = `ai_usage` / `clerk_events` / `contact_messages` / `integration_failures` / `stripe_events` は RLS-P3 で「非 RLS + grant 縮小」と決めた既知の 5 表。今回の 3 表だけが想定外。)

---

## Part 1: 切断時の挙動

### 1. vercel.json 全内容 / `supportsCancellation`

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["hnd1"],
  "functions": {
    "app/api/webhooks/clerk/route.ts": { "maxDuration": 60 },
    "app/api/webhooks/stripe/route.ts": { "maxDuration": 60 }
  }
}
```

- **`supportsCancellation` は repo 全体に 1 件も存在しない**(`grep -rn supportsCancellation` = 0 hit・node_modules/.git 除く)。upload 経路にも無い。
- 公式 doc(Vercel Functions API Reference・`last_updated: 2026-07-01`・https://vercel.com/docs/functions/functions-api-reference#cancel-requests):
  > 「**Cancellation is opt-in.** In your `vercel.json`, add `"supportsCancellation": true` to the specific paths you want to enable it for」
  > 「When cancellation is enabled, Vercel notifies your function through the standard `AbortSignal` on `request.signal`. When the client disconnects, the signal fires and **the function is terminated**.」
  > 「**This differs from a standalone Node.js server, where your process continues running after a client disconnects.**」
  > 「Termination on disconnect applies to every function matching the glob, whether or not your code listens for the abort signal. Any work not wrapped in `waitUntil` or `after` will be lost on cancellation.」
- → **opt-in していない現状、client 切断で function は終了しない**(doc ベースの結論)。

### 2. Fluid Compute の有効/無効

- **repo からは判定不能 = OT 確認事項**(Vercel Dashboard → Project → Settings → Functions)。
- 関連する既知事象: 2 回目 smoke で「claim 成功 → 約 300s で関数消滅」(`docs/superpowers/sessions/2026-08-02-ocr-2-4a-cutover-review.md:97`)。build は `/app/upload` に maxDuration=800 を emit 済で、原因は **Vercel プロジェクト設定側(Fluid 有効 / Default Max Duration)の疑い**のまま **未解明**、6 回目非再発で observe-close(同 review doc §「maxDuration 300s 消滅事象」)。**2026-08-05 追記**: OT の Dashboard 確認で Fluid Compute 有効・実効 720s が判明し、根因候補から「設定由来」は外れた(`docs/superpowers/sessions/2026-08-05-ocr-2-4a-s4-preconditions.md`)。
- → **Fluid の有効/無効・実 Max Duration は不明**。1 invocation 化の前提確認としてここは潰しておく価値がある(Functions タブの実 Max Duration 表示)。

### 3. `request.signal` / `AbortSignal` 参照

- **`request.signal` / `req.signal` の参照は 0 件**(grep 済)。そもそも Server Action は `Request` を受け取らない。
- 存在する `AbortSignal` は全て**自前 timeout**であり client 切断とは無関係:
  - `lib/storage/r2.ts:125 / 159 / 218 / 248`(HEAD/GET/PUT/DELETE の 10s timeout)
  - `lib/ai/clients/gemini.ts:122,134`(自前 `AbortController` で SDK call を打ち切り)
  - `app/(app)/app/upload/_components/upload-form.tsx:634`(client 側 R2 PUT の timeout)
- → **OCR・crop 経路に client 切断を観測するコードは無い**。

### 4. stg 実測(タブを閉じる) → **CC 実施不能**

- Playwright で `https://stg.recallmint.nekotest.net/app/upload` に遷移 → `/sign-in?redirect_url=…` へリダイレクト = **未ログイン**。
- `.env.local` に stg のテストユーザー資格情報は**存在しない**(キー一覧に E2E/TEST 系なし)。
- → **この実測は OT 実施事項**。手順は本 doc 末尾 §5。
- 併せて観測した stg の現況(read-only・app role + tenant context):

```
now=2026-08-04 09:28:45+00
upload_operations(3 行): 85541b25… completed / 2ac594a5… completed
                          2ac594a5… awaiting_sources (age=3548s ≒ 59 分・放棄済)
source_assets(2 行): いずれも status=reserved・key=users/2ac594a5…/src/tmp/{id}
```

- **R2 側は 09:12 時点で `users/85541b25…/src/` に 14 objects(最終 11 + temp 3)**(前回調査)。**DB の source_assets は 2 行のみ**(しかも別 user)→ **85541b25 の 14 objects は全て row-less orphan**。前回調査で「既知 orphan 1 件」としていたが、**実際は 14 件規模**。T15 の sweep 対象規模はこの数字で見積もること。

---

## Part 2: `after()` / `waitUntil`

出典 = Next.js 公式 `after` API Reference(https://nextjs.org/docs/app/api-reference/functions/after ・doc version 16.3.0 / lastUpdated 2026-03-13)。repo の Next は **16.2.11**(`package.json:43`)、`after` は **v15.1.0 で stable**(同 doc の Version History)。

### 5. Server Action から使えるか → **使える**

> 「It can be used in [Server Components](…) (including `generateMetadata`), **Server Functions**, [Route Handlers](…), and [Proxy](…).」

- Next 16 の用語では **Server Functions = Server Actions**(`'use server'`)。Route Handler 限定ではない。
- 補強(同 doc「In Route Handlers and Server Functions」節):
  > 「You can call `cookies` and `headers` directly inside the `after` callback when used in **Route Handlers and Server Functions**.」
  → Server Action 内の `after` では request API も使える(Server Component 内では不可、という非対称がある)。
- repo 内で `after` は**未使用**(`grep '\bafter('` = 0 hit)。`@vercel/functions`(`waitUntil`)は**未導入**(`package.json` に `@vercel` なし)。`after` は `next/server` 同梱ゆえ**新規依存は不要**。

### 6. `after()` 内の処理と maxDuration

> 「### Duration
> `after` will run for the platform's default or configured max duration of your route. If your platform supports it, you can configure the timeout limit using the `maxDuration` route segment config.」

- → **route の maxDuration がそのまま `after` の実行時間上限**。`app/(app)/app/upload/page.tsx:16` の `maxDuration = 800` が効く(= 別枠の追加時間はもらえない)。
- serverless 実装の裏付け(同 doc の折りたたみ節):
  > 「Using `after` in a serverless context requires waiting for asynchronous tasks to finish after the response has been sent. In Next.js and Vercel, this is achieved using a primitive called `waitUntil(promise)`, which **extends the lifetime of a serverless invocation** until all promises passed to `waitUntil` have settled.」

### 7. `after()` 内で例外が出た場合 → **記載なし**

- 上記 doc に**コールバック自身が throw した場合の扱い(ログに出るか silent か)の記述は無い**。
- 近い記述はあるが**別のこと**を言っている(レスポンス側が失敗しても after は走る、という保証):
  > 「`after` will be executed even if the response didn't complete successfully. Including when an error is thrown or when `notFound` or `redirect` is called.」
- → **不明**。採用するなら callback 全体を自前 try/catch で包み、失敗を `integration_failures` + `logger.error` に落とす設計が要る(現行 purge/GC と同じ loud failure 規律)。

### 8. Server Action のままでよいか → **よい(Route Handler 化は不要)**

- §5 の通り `after` は Server Function で使用可。**現行の `'use server'` action のまま「即レスポンス + after() で本処理」に変えられる**。
- ただし 2 点の設計含意:
  - **maxDuration は page の route segment config に従う**(`page.tsx:13-16` のコメントが明記: 「maxDuration は呼び出し page の route segment config に従うため、process.ts ('use server') ではなくここに宣言する」)。after 化しても同じ制約下。
  - 完了を client に返せなくなるため、**完了検知は polling へ移す必要がある**(→ item 14)。

---

## Part 3: 1 invocation 化の影響範囲

### 9. 消える / 残る / 変わる(file 単位)

**消える**

| file | 理由 |
|---|---|
| `app/(app)/app/upload/_actions/source-asset-actions.ts` | `reserveSource`(presigned PUT 発行 `:102`)/ `finalizeSource`(GET→検証→最終 key へ server PUT `:168`)/ temp・lost-CAS cleanup(`:271,285`)が丸ごと不要 |
| `lib/media/source-purge.ts` | source を R2 に置かない = purge 主経路が消える(6 trigger 配線も) |
| `scripts/gc-image-assets.ts` の source lane | `runSourceReconciler`(`:622`)/ `buildSourceProductionDeps`(`:785`)/ Class A・B 判定 / `SOURCE_RESERVED_NET_GRACE_MS`(`:546`) |
| `lib/media/domain/source-asset-state.ts` | source lane の pure 判定 |
| `tests/integration/pg/{source-purge,gc-source-assets,source-asset-finalize}.test.ts` | 上記の証明 test |
| **T15 の経路 C 対応そのもの** | exam 削除・退会で source orphan が残る問題が原理的に消滅 |

**残る**

| file | 理由 |
|---|---|
| `upload_operations` 表 + `claim-operation.ts` の一部 | 冪等 replay(UNIQUE(user_id, idempotency_key))/ daily cap / 二重 submit 防止 |
| `publish-prepared.ts` の `publishPreparedUploadTx` | cards/tags/refs/card_count/status/upload_records の atomic 確定(spec §8) |
| `lib/ocr/normalize-prepared.ts` / `prepared-schema.ts` | 要素隔離・schema SSoT(T8a 資産) |
| `lib/media/crop-and-store.ts` | crop 本体(ただし §「変わる」参照) |
| `assets` / `asset_derivations` / `card_asset_refs` | crop 結果側は不変 |
| `app/(app)/app/_components/exam-status-live.tsx` + `/api/exams/status` | 完了表示の polling 基盤(item 14) |

**変わる**

| file | 変化 |
|---|---|
| `upload-form.tsx` | 呼出列が 1 本になる(`:557` prepare → `:606` reserve → `:627` PUT → `:647` finalize → `:667` claim → `:722` stage → `:757` publish が 1 call に) |
| `prepare-upload.ts` | source reservation 行の作成(`:444-453`)が消え、operation 作成 + gate のみに |
| `stage-prepared.ts` → 統合 | R2 GET(`:473`)が「request で受けた Buffer」に置き換わる |
| `publish-prepared-orchestrate.ts` | `preparedPayload` の DB 読み直し(`:256,306`)が不要(メモリの payload をそのまま使う)。Step A の 4 terminal 分岐は縮む |
| `crop-and-store.ts` | source 行の SELECT(`:186-188`)+ R2 GET(`:352`)を廃し、**バイトと width/height を引数で受ける**形へ |
| `_lib/constants.ts` | `CROP_PHASE_BUDGET_MS`(`:71`)と `OCR_OVERALL_DEADLINE_MS`(`lib/ai/ocr.ts:60`)の**予算統合**が必要 |
| `derive-exam-statuses.ts` / `source-doc-status.ts` | live-op 判定は残るが、「in-flight」の定義が after() 実行中を指すように変わる |

### 10. `source_assets` を落とすと失う情報と代替

| 失う値 | 現在の用途(file:line) | 1 invocation での代替 |
|---|---|---|
| `byte_size` 合計 | `upload_records.file_size_bytes`(`publish-prepared.ts:239-245` の `SUM(byte_size)`) | request で受けた `File.size` の合計(メモリ) |
| `expected_source_count` | `upload_records.pages_processed`(`publish-prepared.ts` の insert `pagesProcessed: expectedSourceCount`) | `files.length` |
| `original_filename` | `source_documents.filename` 等(`prepare-upload.ts:453` で保存) | `File.name` |
| `width` / `height` | crop の座標変換(`crop-and-store.ts:186-187`) | sharp の decode 結果(finalize が今やっている検証をメモリで実施) |
| `content_hash` | **現状 dedup の照合経路なし**(`docs/audit/2026-08-04-image-hash-dedup-factfinding.md` = 意図的 deferred) | 影響なし |
| manifest 検証(count 一致 / 全 ready / byte_size NOT NULL) | `claim-operation.ts` + `stage-prepared.ts:106-127` | **概念ごと消える**(同一 request 内の files 配列が唯一の真実で drift しえない) |
| `source_kind` / `page_count` / `rotation` / `rasterizer` | **②-4b(PDF page-source)の予約列**(`schema.ts:921-924`) | **②-4b の設計と衝突しうる = 判断点**(本調査の対象外) |

→ **`expected_source_count` の独立 oracle としての役割は消える**(oracle が必要なのは「別 invocation が見る DB 行が欠けていないか」を検出するためであり、1 invocation では検査対象が同じメモリ上の配列になる)。

### 11. lease / fencing / claim の判定

| 機構 | 判定 | 理由 |
|---|---|---|
| `idempotency_key` UNIQUE + user advisory lock(`prepare-upload.ts`) | **残す** | 二重 submit / 冪等再送は 1 invocation でも別 request として起きる |
| live-op gate(実行中 op があれば `in_progress`) | **残す** | after() 実行中は「実行中」を表現する唯一の手段 |
| lease(`lease_version` / `lease_expires_at`) | **残す(意味が変わる)** | 「別 worker との排他」から「実行中 invocation の生存表明 + 失効判定」へ。UI の processing 表示と supersede 判定に必要 |
| `lease_version` の client 往復(`upload-form.tsx:466`) | **不要** | 同一 invocation のメモリ内で完結 |
| publish tx 冒頭の fencing(`publish-prepared.ts` header) | **残す(降格可)** | 守る対象は「takeover した新 worker と旧 worker の競合」。ユーザー再送で 2 invocation が同時に走る余地は残るため、CAS 自体は保持が安全 |
| `prepared_taken_over`(T12b・`claim-operation.ts:264`) | **前提が消える** | 「バイト再送を許容」方針では、payload 再利用の動機は **Gemini 再課金の回避のみ**。残すかは費用判断 |
| `CROP_PHASE_BUDGET_MS` の per-invocation 予算 | **変わる** | OCR + crop を 1 予算に統合(値は実測後・本調査対象外) |

### 12. 二重 submit 防止と daily cap

- 現行は **claim(`claim-operation.ts`)が単一 tx で** ① live-op 分類 ② daily cap 判定 ③ source manifest 検証 ④ lease CAS を束ねている。
- 1 invocation では **③ が不要**になるだけで、①②④ はそのまま同じ 1 tx に置ける(operation 作成 tx と統合可)。
- daily cap は現行どおり `getTodayAiUsageGlobal` vs `GEMINI_DAILY_LIMIT` の非原子判定(spec §3 で受容済)。**1 invocation 化で悪化も改善もしない**。

### 13. crop 失敗時の着地 → **「図版なしで publish」は既に選べる。DB 制約上の障害なし**

- `planPublish`(`app/(app)/app/upload/_lib/publish-prepared-plan.ts`)は figure の disposition を集計し、`crop_failed` / `deadline_excluded` は **exclusion として計上したうえで publish する**(`:128-147`)。
- publish を止めるのは **`retryable` disposition が 1 件でもある場合のみ**(`:117-124` → `decision: 'retryable'`)。
- → 1 invocation では「`retryable` も図版なし publish に倒す」選択が可能。**これは DB 制約ではなく仕様判断**(現行が retry に倒しているのは、別 invocation で再試行できる前提があるため)。

### 14. 完了をユーザーに見せる手段 → **polling 基盤は既に存在する**

- 現行 UI は**同期的な戻り値に依存**している(`upload-form.tsx:757-763`: `publishPreparedUpload` の戻り値 `'published'` で `router.push` して result page へ)。
- ただし **常駐 poller が既にある**:
  - `app/(app)/app/_components/exam-status-live.tsx` — `/api/exams/status` を **5 秒間隔**で poll(`:41-42`)、processing→completed 遷移で `router.refresh()` + `runGuardedPull`(`:11-13` のヘッダコメント)、タブ hidden 中は停止、可視復帰で即 tick。
  - upload 開始時に `requestOcrPoll()` で poller を kick(`upload-form.tsx:827-831` / pub-sub = `lib/exams/ocr-poll-signal.ts`)。kick session は processing を一度も観測しないと `KICK_MAX_EMPTY_TICKS`(≈30s)で停止(`:43-47`)。
- → **「即レスポンス + after() で本処理 + 完了は polling で表示」に必要な部品は揃っている**。follow-up の「auto-nav 案 a(poll ベース遷移)」(todo v48 §0.5 残 #5)は**この 1 invocation 化と同じ基盤の上に載る** — 別々に作る必要はない。

---

## Part 4: task 分割案

### 15. 分割案(cutover 相当の規模を想定)

| # | task | 何を証明したら完了か |
|---|---|---|
| **S-0** | **前提の是正(独立・先行推奨)**: stg に `ocr-2-4a-enable.sql` 適用 + stg drift の定点確認手段 | stg で 3 表の `relrowsecurity=true` + policy 3 件 + bogus context で 0 行(§0 の逆) |
| **S-1** | 単一 action の骨組み(FormData 受領 → operation 作成 + live-op gate + daily cap + lease を 1 tx)。OCR/crop はまだ呼ばない | 実 PG iso: 同時 2 submit で 1 つだけ通る / cap 超過で拒否 / 冪等再送が同一 op に収束 / **R2 を 1 度も呼ばない** |
| **S-2** | OCR をメモリのバイトで実行 → `prepared_payload` を同一 invocation で commit | iso(Gemini mock): payload commit までに **R2 GET 0 回**(mock の呼出回数で pin)/ 既存 `normalize-prepared` の契約不変 |
| **S-3** | メモリのバイトから crop → **crop 済みのみ R2 PUT** → 既存 publish tx で確定 | iso: R2 PUT の key が `users/{uid}/{assetId}.webp` のみで `src/` を含まない(**新軸の実行可能な証明**)/ `publishPreparedUploadTx` は byte-for-byte 不変 / 図版なし publish が成立 |
| **S-4** | `after()` 化(即レスポンス)+ 完了表示を polling へ | stg 実測: submit 直後に応答が返る / **タブを閉じても op が completed に到達**(§5 の手順)/ callback の例外が `integration_failures` に載る(§7 が「記載なし」ゆえ自前で担保) |
| **S-5** | 旧経路の撤去(`source-asset-actions.ts` / `source-purge.ts` / GC source lane / `source_assets` 表) | 参照 0 件(grep)/ 全 gate green / **stg の row-less orphan 14 件を一掃**して `src/` prefix が空 |

- **S-0 は本題と独立**(1 invocation 化を採らなくても必要)。
- **S-5 の表 drop は ②-4b(PDF page-source 予約列)と衝突しうる**ため、S-5 を「コード撤去のみ・表は残置」と「表ごと drop」に分ける判断が要る(**OT 判断・本調査の射程外**)。

### 16. 巻き戻しか前進か → **前進(新経路を作って切替)を推奨**

- 理由 1: **同じ形の前例がある**。cutover は「legacy `processUpload` の呼出だけ削除し、**`process.ts` 自体は残す = 戻せる状態を保つ**」で実施した(plan Phase Cut)。同じやり方で新経路を足し、`upload-form.tsx` の呼出列を差し替えるのが最小リスク。
- 理由 2: **revert すると再利用したい資産まで巻き戻る**。`normalize-prepared` / `prepared-schema`(T8a の schema SSoT)/ `publishPreparedUploadTx`(T12)/ `crop-geometry`(T9)/ `crop-and-store` は 1 invocation 化でも**そのまま使う**。cutover の revert はこれらを載せる土台を壊す。
- 理由 3: 現行経路は stg で動いており、**切替を 1 file(`upload-form.tsx`)の呼出列に閉じ込めれば両経路を併存させたまま比較できる**(cutover 時と同じ検証構造)。
- 撤去(S-5)は切替が stg smoke を通ってから。**revert ではなく「新経路 GREEN → 旧経路撤去」の順**。

---

## 5. OT 実施依頼(Part 1-4 の実測)

1. **URL**: `https://stg.recallmint.nekotest.net/app/upload`(ログイン済み状態で)
2. **手順**: 画像 1-2 枚を選び submit → **「AI が抽出中」表示になり claim が通った直後(目安 5-15 秒後)にタブを閉じる**(リロードでなく閉じる)。
3. **期待挙動の分岐**(どちらが起きたかを記録):
   - 5 分後に op が `prepared` または `terminal_failed`/`retryable` marker まで進んでいる → **切断後も invocation は継続した**(doc どおり)
   - `claimed` のまま lease だけ切れている → **切断で function が終了した**(doc と矛盾 → Fluid/設定を疑う)
4. **確認 SQL**(app role + tenant context。CC が実行可):
   ```sql
   BEGIN; SELECT set_config('app.user_id','<自分の users.id>',true);
   SELECT id, status, lease_expires_at, last_error_code, prepared_payload IS NOT NULL AS has_payload,
          result_summary IS NOT NULL AS has_summary, created_at, completed_at
   FROM upload_operations ORDER BY created_at DESC LIMIT 3;
   COMMIT;
   ```
5. **併せて確認**: Vercel Dashboard → Project → Settings → Functions の **Fluid compute 有効/無効 と Default Max Duration**、および該当 Deployment → Functions タブの `/app/upload` の実 Max Duration(§1-2 の未解明事象)。
6. 検証で作った op は**削除しない**(証跡)。

---

## 6. 不明一覧(推測で埋めていないもの)

- `after()` の callback が throw した場合の扱い(ログに出るか silent か)= **公式 doc に記載なし**
- stg の Fluid compute 有効/無効・実 Max Duration = **repo から判定不能(OT 確認)**
- 切断時に function が継続するかの**実測** = 未実施(CC は stg 未ログイン・資格情報なし)
- 40 枚 / 4MB upper-scale での OCR+crop 所要時間 = **実測なし**(既存実測は 5 枚 ~1-2 分のみ)
- 1 invocation 化した場合の時間予算の再配分値 = **本調査の対象外**(実測後に決定)
- `source_assets` 表を drop してよいか(②-4b の page-source 予約列との衝突)= **②-4b 設計待ち**
