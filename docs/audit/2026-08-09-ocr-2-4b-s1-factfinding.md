# ②-4b §1 着手前 fact-finding(read-only)

対象: §1(entry 削除時の R2 cleanup)の spec 起草前に確定しておく 5 点。
**read-only 調査のみ**(実装変更・commit 対象コードなし・DB 書込なし・R2 破壊操作なし)。
外部への呼出は次の 3 種だけで、いずれも GET / SELECT:

- R2 S3 互換 `GET ?lifecycle` / `GET ?cors` / `ListObjectsV2`(`.env.local` の R2_* = stg)
- stg DB への `information_schema` SELECT + `integration_failures` の SELECT 試行(`DATABASE_URL_APP`)
- Cloudflare / Vercel 公式 docs の WebFetch

---

## 1. 現行 entry 削除ハンドラの構造

### 1.1 削除が実際にすること

`removeEntry(id)` = `app/(app)/app/upload/_components/upload-form.tsx:595-612`。動作は 3 つだけ:

1. `generationRef.current.delete(id)` — generation token の revoke(:598)
2. image なら `URL.revokeObjectURL(thumbUrl)`(:601-603)
3. `entries` から filter で除去。`next.length === 0` なら `uploadSessionIdRef.current = null`(:604-609)

**server 呼出・R2 呼出は一切ない。** コメントも設計意図をそのまま書いている:
「残った R2 object は lifecycle が回収する・spec『削除 = manifest から外すのみ』」(:606)。

### 1.2 entry 状態機械

型定義 = `upload-form.tsx:62-76`、遷移の記述 = `:55-61`。

| kind | 状態 | 入る条件 | 出る先 |
|---|---|---|---|
| image | `processing` | `handleAdd` で追加(:576-584) | 圧縮成功 → `ready` / 失敗 → `error`(`processImage` :292-335) |
| image | `ready` / `error` | 上記 | (終端) |
| pdf | `uploading` | `handleAdd` で追加(:568-575)、または `retryPdfSession` で `ready` から差し戻し(:512-525) | PUT 成功 → `counting` / PUT 失敗・reserve 失敗 → `error`(:375-384, :436-457) |
| pdf | `counting` | PUT 成功直後(:380-384) | finalize 成功 → `ready` / finalize reject・throw → `error`(:392-413) |
| pdf | `ready` | `pageCount` 確定(:401-408) | `retryPdfSession` で `uploading` へ戻ることがある(:500-536) |
| pdf | `error` | PUT 失敗 / 0 ページ / `OCR_MAX_PAGES` 超 / parse 失敗 / reserve 失敗 | (終端・削除して入れ直す運用) |

`uploadSessionId` の生存範囲は `:185-197` に表として記載(維持 / 無効化 / 終了)。
「終了」= entries が空になった時点 = `removeEntry` の :607-609。

### 1.3 飛行中の PUT / finalize の管理 — **AbortController は存在しない**

- PUT の `signal` は `AbortSignal.timeout(PDF_PUT_TIMEOUT_MS)` のみ(:369)。これは**時間切れ専用**で、
  entry 削除では中断されない。
- promise は保持されない。`void continuePdfUpload(...)`(:458)= fire-and-forget。保持先の ref も Map も無い。
- 削除後に応答が届いた場合の現状実挙動:
  - **state は汚れない** — `writeEntry` が generation token を突合して書込を捨てる(:339-342)。
    既存 test で pin 済(`upload-form.test.tsx:473`「削除後に届く stale finalize 応答は entry を復活させない」)。
  - **R2 の実体は残る** — PUT はそのまま完走して object を書く。誰も消さない。
  - 例外的に消えるのは finalize が **reject 経路**に落ちた時だけ: parse 不能 / 0 ページ / 上限超で
    `deleteObject(objectKey)` が走る(`_actions/finalize-pdf-source.ts:100 / 112 / 116`)。
    **成功経路(= 通常)では消えない。**
- → 残骸の発生源は 2 つ:(a) `uploading` 中の削除 → PUT が後着地、(b) `counting` / `ready` での削除 → object が既に在る。

### 1.4 削除時点で DELETE 対象を特定できるか

**key は組めないが、対象は特定できる。**

- key 形 = `src/{userId}/{uploadSessionId}/{fileId}.pdf`(`lib/media/source-object-key.ts`)。
  3 セグメントとも **server 導出が構造要件**で、`userId` は `users` 表の内部 uuid ゆえ client は持たない。
  reserve / finalize の入力 schema にも key 文字列 field は無い(所有権 pin・Codex I7。
  `reserve-pdf-upload.ts:16-20` / `finalize-pdf-source.ts:16-19`)。
- client が削除時点で持つのは entry `id`(= fileId)と `uploadSessionIdRef.current` の 2 つ。
  これは **finalize がすでに受けている入力形と同一**(`finalize-pdf-source.ts:50-54`)。
- → server 側で `sourcePdfObjectKey(user.id, uploadSessionId, fileId)` を再構築すれば足りる。

### 1.5 client から R2 DELETE を撃つ経路 — **現存しない**

- presign は **PUT 専用**(`reserve-pdf-upload.ts:88`)と GET(`asset-actions.ts:10`)のみ。
  `presignDeleteUrl` は存在せず、r2.ts が明示的に否定している:
  「presigned DELETEは採用しない — 本関数はserver直DELETE専用」(`lib/storage/r2.ts:377` 付近のコメント)。
- DELETE 用の server action / route handler も無い。
- repo 全体で **R2 DELETE の呼出元は 4 箇所のみ**:

| 呼出元 | 位置 | 文脈 |
|---|---|---|
| `deleteSourceKeys` | `app/(app)/app/upload/_lib/upload-pipeline.ts:559` | pipeline 出口 DELETE(spec §6 本線 2) |
| `finalizePdfSource` | `_actions/finalize-pdf-source.ts:100 / 112 / 116` | 完了通知の reject 3 経路(本線 1) |
| 画像 GC reconciler | `scripts/gc-image-assets.ts:372` | OT 手動 script |
| 旧経路 src 一掃 | `scripts/gc-src-prefix.ts:100` | OT 手動 one-shot script |

### 1.6 §1 への含意

1. **server action を 1 本新設するのが最小構成**。入力は finalize と同型 `(uploadSessionId, fileId)`、
   key は server で導出。既存の所有権 pin(key 文字列を受けない)をそのまま踏襲できる。
2. **DELETE を撃っても飛行中の PUT は止まらない** — `uploading` 中の削除では
   「DELETE が先・PUT が後」の順序が現実に起こりうる(= object が復活する)。spec が扱うべき race。
   潰すなら AbortController の新設(現状ゼロからの追加)か、DELETE の後追い再試行か、
   lifecycle 受け皿のままにするかの選択になる。
3. Codex plan cross-check の Important #17(entry 削除時の early best-effort delete)は
   ②-4b 実装時に**意図的に見送られている**(`sessions/2026-08-08-ocr-2-4b-pdf-rasterize.md:214`)。
   §1 はその判断の巻き戻しにあたる — spec に「なぜ今やるのか」を 1 行置くのが筋。

---

## 2. staging が純 client state であることの裏取り — **反例なし**

### 2.1 submit 前の 3 呼出はいずれも DB 書込ゼロ

| 呼出 | 位置 | 書込 |
|---|---|---|
| `reservePdfUploadUrls` | `_actions/reserve-pdf-upload.ts:63-97` | presign 発行のみ。DB handle を import していない。doc コメント「DB 無し(spec §3 分岐 (a) — reserve レコードを作らない台帳なし設計)」(:16) |
| R2 直 PUT | `upload-form.tsx:362-370` | browser → R2 のみ |
| `finalizePdfSource` | `_actions/finalize-pdf-source.ts:66-124` | HEAD / GET / `loadPdf` のみ。doc コメント「無状態(DB 書込なし・spec §3)」(:16) |

### 2.2 IDB mirror / outbox への書込もゼロ

- `upload-form.tsx` の import は react / next / lucide / browser-image-compression / ui 2 本 /
  `lib/exams/format` / `_lib/constants` / `lib/ai/ocr-limits` / action 3 本 / `_lib/dedupe-filenames` /
  `_lib/upload-error-types` / `lib/exams/ocr-poll-signal` のみ(:1-43)。
  Dexie / `entity_mutations` / `runOptimistic*` を **一切 import していない**。
- 同 file への `db.` / `dexie` / `entityMutations` / `outbox` / `mirror` の grep = **0 hit**。

### 2.3 同期経路に R2 I/O は無い

- `lib/sync/**` / `lib/dexie/**` / `lib/db/**` / `app/api/pull/` / `app/api/entity-mutations/` から
  `@/lib/storage/r2` への import = **0 件**(唯一の hit は `lib/db/schema.ts:400` のコメント文言)。
- §1.5 の R2 DELETE 呼出元 4 箇所はいずれも同期経路の外(pipeline / action / operator script 2 本)。
  tombstone / apply registry / pull stream が R2 を触る箇所は存在しない。

### 2.4 含意

「staging 削除を同期経路に載せない」(todo v58)の前提は成立。
§1 は **R2 に対する片方向の副作用**のみを足す設計でよく、sync / outbox / tombstone の設計に触れない。

---

## 3. lifecycle「未設定」誤判定の原因

### 3.1 出所は doc 連鎖のみ — API / script の実行は一度も無い

| 世代 | 記述 | 根拠 |
|---|---|---|
| spec | `specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md:239-243` §12「OT 作業(repo 外)1. R2 lifecycle rule 設定」 | 作業項目の列挙(= まだやっていない、という宣言ではない) |
| 実装クローズ | `sessions/2026-08-08-ocr-2-4b-pdf-rasterize.md:158, 190`「**未設定**(§9 参照。OT 作業は spec §12)」 | spec §12 に完了記録が無いこと**のみ** |
| §0 close | `sessions/2026-08-08-ocr-2-4b-close-s0-terminal-delete.md:102`「その lifecycle rule は未設定のまま」 | 上記クローズ記録の引用 |

- repo 全体 grep: `GetBucketLifecycle` / `bucketlifecycle` / `?lifecycle` = **0 hit**。probe コードも script も存在しない。
- 先行の R2 実測 doc も明示的に対象外と書いている:
  - `audit/2026-08-04-r2-contract-measurement-and-key-inventory.md:167`「lifecycle rule の前方一致仕様(…)今回の実測対象外」
  - `audit/2026-08-07-ocr-2-4b-rasterize-feasibility-measurement.md:268`「lifecycle の秒指定が実際に受理されるか(実 API 実行)| **未実測**(docs の schema 記述のみ)」

→ **「単に確認していなかった」型**。正確には「外部設定項目に repo 側の完了記録が無い」→「未設定」と**推定**し、
その推定が doc 3 世代で断定に固化した。記録の不在を事実の不在として読んだ誤り。

### 3.2 ただし「CC の読み取り経路からは見えない」型**でもある**(今回実測)

R2 は S3 互換 `GetBucketLifecycleConfiguration` を実装済(Cloudflare docs「Implemented bucket-level operations」表で確認)。
そこで `.env.local` の R2_*(= stg / bucket `recallmint-dev`)で read-only GET を実行した:

| 呼出 | 結果 |
|---|---|
| `GET ?lifecycle` | **403 AccessDenied** |
| `GET ?cors` | **403 AccessDenied** |
| `GET ?list-type=2&prefix=src/` | **200**(keys=2) |

→ credential 自体は有効で、**bucket 設定 subresource の読取だけが権限外**。
仮に §0 の時点で確認しようとしても、現行 token では読めなかった。

### 3.3 §4(readback 機械化)への結論

現行 `R2_ACCESS_KEY_ID` では **rule 本体の readback は機械化不可能**。選択肢:

1. bucket 設定読取を含む R2 API token(Admin Read 相当)を新規発行 → S3 互換 `?lifecycle` GET で script 化可能
   (実装は今回の probe と同じ ~20 行)
2. Cloudflare REST API(`GET /accounts/{id}/r2/buckets/{bucket}/lifecycle`)用の account API token を追加 → 同上
3. token を増やさず **OT の dashboard 目視**に倒す

**推奨は 3。** rule は「設定したら基本変わらない」外部設定であり、読取専用とはいえ bucket 設定権限を持つ
credential を常置する対価に見合わない。定期監視が本当に要るなら 1(script 専用・runtime env には置かない)。

**token 追加なしで取れる代替 readback がある**: `src/` の**最古 object age** を `listObjects` で測る。
rule が効いていれば最古 age が実効上限(≈48h)を恒常的に超えない。
rule の**存在**ではなく**効果**を測る readback で、§3 sweeper と同じ credential で完結する。

### 3.4 観測(副産物・read-only)

2026-08-09 04:17 UTC 時点の `src/` = **2 object**(age 3.1h / 16.5h、いずれも 24h 未満)。

- §0 が baseline とした「1 本」は age 16.5h のもの(2026-08-08 11:44 UTC)と整合。
- 一方 smoke log の lifecycle sentinel(2026-08-07 22:47 UTC PUT・344,798 B)は **既に存在しない**。
  ただし消失時点で 24h 未満だったため **lifecycle rule の効果では説明できない**(1 日 rule は 24h 未満の object を消さない)。
  手動回収の可能性が高く、**sentinel 実験としては成立しなかった**。
- → 「rule が実際に削除している」ことを示す実測は現時点で**無い**。§3/§4 はこれを前提に組む。

---

## 4. `integration_failures` の実列契約

### 4.1 実 schema(stg 実 DB を `information_schema.columns` で読取)

| 列 | 型 | null | default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `service` | text | NO | — |
| `operation` | text | NO | — |
| `workflow` | text | YES | — |
| `failure_code` | text | NO | — |
| `user_id` | uuid | YES | — |
| `clerk_id` | text | YES | — |
| `stripe_customer_id` | text | YES | — |
| `stripe_subscription_id` | text | YES | — |
| `schedule_id` | text | YES | — |
| `context` | jsonb | NO | — |
| `error_message` | text | YES | — |
| `retry_count` | integer | NO | `0` |
| `next_retry_at` / `resolved_at` | timestamptz | YES | — |
| `resolution_note` | text | YES | — |
| `created_at` | timestamptz | NO | `now()` |

**`key` 列は存在しない。** `key` は code 側の handle(`INTEGRATION_FAILURE_CATALOG` の key)で、
DB に入るのは 4 軸値のみ(`lib/integration-failures.ts:15-17`)。
§0 の todo に載っていた照会 SQL が実行不能だったのはこれが原因。

### 4.2 source delete 失敗時に書かれる値

`lib/integration-failures.ts:87-92`(catalog)+ `upload-pipeline.ts:552-578`(呼出):

| 列 | 値 |
|---|---|
| `service` | `'r2'` |
| `operation` | `'object.delete'` |
| `workflow` | `'upload_single_invocation'` |
| `failure_code` | `'external_api_error'` |
| `user_id` | pipeline の `userId` |
| `context` | `{ objectKey, status }` |
| `error_message` | 未設定(NULL) |

`subject`(`'upload pipeline source PDF delete failed'`)は **DB に入らず Discord のみ**。

### 4.3 既存 R2 系失敗記録の実値一覧

| catalog key | service | operation | workflow | failure_code | context |
|---|---|---|---|---|---|
| `r2_gc_delete` | `r2` | `object.delete` | `asset_gc` | `external_api_error` | `{ assetId, objectKey, status }` |
| `r2_source_delete` | `r2` | `object.delete` | `upload_single_invocation` | `external_api_error` | `{ objectKey, status }` |

**両者は `workflow` だけが違う**(他 3 軸は同一)。→ §3 sweeper への含意:

- sweeper の失敗を `r2_source_delete` に相乗りさせると、**pipeline 出口の失敗と sweeper の失敗が区別不能**になる。
  catalog 自身の規律「値変更は原則『新 entry 追加』で行い、既存 tuple の rename はしない」(:16-17)に従い、
  **新 entry(例 `workflow='src_sweep'`)を足すのが正**。
- なお `scripts/gc-src-prefix.ts` は台帳に**書かない**(:31-32「OT 手動実行の one-shot であり、
  台帳は『調査を要する異常』用」)。§3 が cron 化するなら「無人実行 = 出力を見る人が居ない」ため
  この判断は反転する(設計論点として spec に上げる)。

### 4.4 権限(stg 実測)

`information_schema.role_table_grants` → **`recallmint_app : INSERT` のみ**。
実際に `select count(*) from integration_failures` を試行 → **42501 permission denied**。
→ 照会は Supabase SQL Editor(owner)で実行する必要がある。

### 4.5 OT 貼付用 SQL(source delete 失敗の抽出)

```sql
-- ②-4b: pipeline 出口の source PDF DELETE 失敗(直近 7 日)
select
  created_at,
  user_id,
  context ->> 'objectKey' as object_key,
  context ->> 'status'    as http_status,
  error_message
from integration_failures
where service      = 'r2'
  and operation    = 'object.delete'
  and workflow     = 'upload_single_invocation'
  and failure_code = 'external_api_error'
  and created_at >= now() - interval '7 days'
order by created_at desc;
```

```sql
-- R2 系の失敗を lane 別に俯瞰(件数のみ・期間指定なし)
select workflow, failure_code, count(*) as n, max(created_at) as latest
from integration_failures
where service = 'r2' and operation = 'object.delete'
group by workflow, failure_code
order by latest desc nulls last;
```

---

## 5. 定期実行の既存機構

### 5.1 現存しない

- `vercel.json` に `crons` key **無し**(`regions` と `functions` の 2 key のみ)。
- cron 用 route 無し。`app/api` 配下は 8 本:`dashboard/stats` / `entity-mutations/bulk` /
  `exams/status` / `pull` / `review-events/bulk` / `study-days/pull` / `webhooks/clerk` / `webhooks/stripe`。
- `.env.example` に `CRON_SECRET` 無し。
- 既存 GC 2 本は明示的に手動運用:`scripts/gc-abandoned-operations.ts:29`
  「NO cron / auto-scheduling(spec 指示どおり手動運用。gc-image-assets.ts と同型)」。

### 5.2 Vercel Cron に必要な要素(公式 docs / 2026-06-16・2026-07-15 更新版)

| 項目 | 内容 |
|---|---|
| 設定 | `vercel.json` の `crons: [{ path, schedule }]`(または Build Output API) |
| 起動 | **production deployment URL への HTTP GET**。UA = `vercel-cron/1.0`、`x-vercel-cron-schedule` header に cron 式 |
| timezone | **常に UTC**。`MON` / `JAN` 等の別名不可。day-of-month と day-of-week の同時指定不可 |
| 認証 | env `CRON_SECRET` を設定すると Vercel が `Authorization: Bearer <CRON_SECRET>` を自動付与。route 側で突合(公式サンプルは App Router Route Handler) |
| 上限(Pro) | 100 jobs/project・最小間隔 **1 分**・**分精度**(Hobby は 1 日 1 回 + ±59 分) |
| duration | 通常 Function と同じ(`maxDuration`) |
| 失敗時 | **retry しない** |
| 配送保証 | best-effort。**欠落も重複もありうる** → 冪等 + reconciliation ベース設計が公式推奨。同時実行防止は自前 lock |
| その他 | **redirect を追わない**(3xx は最終応答扱い)。存在しない path でも invocation 自体は実行され 404 が出る。`vercel dev` / `next dev` はサポート外(local はただの GET で叩く) |

### 5.3 現 repo 構成との干渉

**(a) proxy.ts / Clerk — 除外は不要**

`config.matcher` に `'/(api|trpc)(.*)'` があるため cron route も middleware を通る(`proxy.ts:85-90`)。
ただし `isProtectedRoute = createRouteMatcher(['/app(.*)'])`(:4)なので `auth.protect()` は**発火せず、401 にならない**。
webhook が `isWebhookBypass` で明示除外されているのは「Clerk auth context を要求しない構造保証」が目的であって
401 回避ではない(:56-64)ため、cron に同じ除外は**必須ではない**。
Clerk middleware の実行コストと CSP header 付与は乗るので、除外したければ bypass 述語の拡張という選択肢はある(spec 論点)。

**(b) script → route 化の最大の障害 = DB role**

既存 GC 2 本は `getAdminDb()` = `DATABASE_URL_ADMIN`(owner role)を使う
(`gc-image-assets.ts:53 / 542`、`gc-abandoned-operations.ts:42 / 196`)。
**Vercel runtime は `DATABASE_URL_APP` のみ**(RLS-P1)ゆえ、**そのままでは cron route に載らない**。
載せるには app role で足りるよう query / 権限を組み直すか、runtime に owner 接続を持たせる(RLS-P1 の設計に逆行)かの判断が要る。

一方 **`src/` sweeper は DB を一切使わない**(`gc-src-prefix.ts` は R2 のみ)ため、この障害を受けない。
台帳記録を足す場合も `recordIntegrationFailure` は `DATABASE_URL_APP` があれば `getNonTenantDb()`(app role)を選び
(`lib/integration-failures.ts:165`)、app role は INSERT 権限あり(§4.4 実測)→ **runtime から書ける**。

**(c) `notifyOps` の production throw**

`OPS_DISCORD_WEBHOOK_URL` 未設定 + production なら `notifyOps` は **throw**(`lib/ops.ts:33-37`)。
cron route から `recordIntegrationFailure` を呼ぶなら、この throw を route 側で吸って 200 を返すか
env 設定を前提にするかを決める必要がある(現行 `deleteSourceKeys` は呼出側で try/catch 済み:`upload-pipeline.ts:561-577`)。

**(d) script 固有事情は route 化で消える**

`--conditions=react-server`(`import 'server-only'` 対策)も `import 'dotenv/config'` も route では不要。

**(e) ⚠ `gc-src-prefix.ts` は新 key を拾わない**

`SRC_KEY_PATTERN = /^users\/[0-9a-f-]{36}\/src\//`(`scripts/gc-src-prefix.ts:47`)は
**旧経路 `users/{uid}/src/`** を対象にしており、②-4b の新 key
`src/{userId}/{uploadSessionId}/{fileId}.pdf`(`lib/media/source-object-key.ts`)に**一致しない**。
既定 listing prefix も `users/`(:66-68)で `src/` を列挙すらしない。

→ §3 は「`gc-src-prefix.ts` を cron 化」ではなく **新 prefix 用の別 lane が要る**。
name が紛らわしいので spec / 実装で明記する。

---

## 6. 停止判断

項目 2 の反例なし・項目 3 の原因も特定済のため、**停止事由なし**。§1 spec 起草へ進める。

要 OT 判断として残るのは §4 readback の方針(§3.3 の 3 択・推奨は「dashboard 目視」)のみ。
