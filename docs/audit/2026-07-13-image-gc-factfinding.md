# 画像 GC(orphan cleanup)fact-finding — 現 HEAD 実体調査

- **日付**: 2026-07-13
- **HEAD**: `develop` = `42d9de1`(imgdebug 撤去後)
- **性質**: **read-only 調査のみ**。実装 / migration / 挙動変更 / spec 起草はしない。成果物 = 本 doc(事実 + 論点)。
- **規律**: 過去 session / 引継 doc の「実装済 / dormant」記述を confirmed 扱いせず、全て現 HEAD の実コード(migration + schema 定義 + 実クエリ / helper signature / 呼出経路)で 3 点裏取り。推測数値は作らず、未確認は「不明」と明記。
- **裏取り手段**: 主要 file は直接 Read、広域 sweep は read-only subagent 2 体(参照モデル / 参照減経路)で fan-out、結果の load-bearing 事実(assets 列 / refcount write 有無 / R2 DELETE seam / handleImages の diff 有無)は本体が実 file で再確認。

---

## Step 0: 現状資産の実体確認

### assets テーブル(migration 0023 + schema.ts の 3 点一致)

migration `drizzle/migrations/0023_windy_ultimates.sql`(実 SQL)と `lib/db/schema.ts:816-842`(Drizzle SSoT)の全列:

| 列 | 型 | default / 制約 | 現状 write |
|---|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` | reserve で `crypto.randomUUID()` |
| `user_id` | uuid NOT NULL | **FK → users.id ON DELETE cascade** | reserve |
| `object_key` | text NOT NULL | **UNIQUE** | reserve(`users/{user_id}/{assetId}.{webp\|png\|jpg}`)|
| `mime` | text NOT NULL | — | reserve |
| `byte_size` | integer NOT NULL | — | reserve |
| `width` / `height` | integer NOT NULL | — | reserve |
| `hash` | text NOT NULL | — | **reserve で書かれる**(SHA-256 hex)|
| `status` | text NOT NULL | default `'reserved'` | reserve→finalize で `'ready'` |
| `created_at` | timestamptz NOT NULL | `now()` | reserve |
| `ready_at` | timestamptz nullable | — | finalize |
| `reference_count` | integer NOT NULL | default `0` | **一切書かれない(dormant)** |
| `unreferenced_at` | timestamptz nullable | — | **一切書かれない(dormant)** |

index: `assets_user_hash_idx (user_id, hash)` / `assets_user_status_idx (user_id, status)`(migration 0023 + `schema.ts:839-840`)。
FK は **user_id → users のみ**。cards / exams への FK は無い(`schema.ts:820-822`)= card を消しても assets 行は DB 上まったく連動しない。

### `reference_count` / `unreferenced_at` は「真に dormant」= 裏取り済

grep(`referenceCount` / `reference_count` / `unreferencedAt` / `unreferenced_at`、test 除く)の全ヒット:
- `lib/db/schema.ts:835-836` 列定義 + `:810-811` コメント「本 phase のアプリコードは一切読み書きしない = dormant」。
- `app/(app)/app/exams/[id]/_actions/asset-actions.ts:101` 「reference_count / unreferenced_at は書かない(将来 orphan 掃除用の dormant 枠、DB default に任せる)」コメント。
- test: `asset-actions.test.ts:314-315` は reserve が両列を **書かないこと** を assert(`not.toHaveProperty`)。

→ **read も write も production コードに存在しない**。過去 doc の「dormant」記述は現 HEAD と一致(訂正不要)。ただし後述のとおり「incremental で埋める」前提は現 sync 構造では想定より重い(§参照モデルの帰結)。

### finalize での hash

hash は **reserve 時**(`asset-actions.ts:103-113`、値は client の `compressForAttach` が算出した SHA-256)に書かれ、finalize(`asset-actions.ts:127-163`)は `status='ready'` + `ready_at` を書くのみで hash に触れない。dedup 再利用は後続 sprint で hash は「記録のみ」(`asset-actions.ts:19-20`)。

### deleteAssetBlob helper

`lib/media/cache.ts:32-38` に実在。signature = `deleteAssetBlob(userId: string, assetId: string): Promise<void>`。
cache key 合成 = `/__media/{userId}/{assetId}`(`cache.ts:10-12`)。Cache API 名 = `'recallmint-media'`(`cache.ts:6`)。同 file に `putAssetBlob` / `matchAssetBlob`。

### presigned は PUT のみか / R2 実体 DELETE 経路の有無

`lib/storage/r2.ts` の export は **`presignPutUrl`(:73)/ `presignGetUrl`(:92)/ `headObject`(:111)の 3 つのみ**(いずれも aws4fetch `AwsClient`)。
grep(`presignDelete` / `DeleteObject` / `removeObject` / method `'DELETE'`、lib/storage + app)= **R2 オブジェクト DELETE 経路は存在しない**。ヒットした `'DELETE'` は全て entity_mutations の card tombstone op(`use-bulk-card-delete.ts:62` 等)で R2 とは無関係。

→ **R2 実体を消す seam は現状ゼロ**。GC は新設が必須(§C)。

---

## A. 参照モデル

### A1. cards.images の構造 / assetId の在処

`cards.images` = `jsonb ... notNull ... default '[]' ... $type<CardImage[]>()`(`schema.ts:316-319`)。
`CardImage = { key; target; alt; source_ref?; url? }`(server: `schema.ts:53-59` / client `ClientCardImage`: `lib/client-db.ts:62-68`、同形)。zod = `imageEntrySchema` / `imagesSchema = z.array(...).max(10)`(`lib/validation/card.ts:94-119`、`url` 非空は reject = 署名 URL の DB 保存禁止)。

- **フラット配列**(問題文 / 選択肢でネストしない)。各 entry は `target` で束ねる: `'question_text'` または `'option:...'`(asset key に対しては `card.ts:110` で強制)。
- **assetId は `key` フィールド**に載る(`upload.ts` の attach append `{ key: assetId, target, alt: '' }` / `card-field-handlers.ts:174` の `images.map(i => i.key)`)。
- server↔client mapping は素通し(`cards-mapper.ts:29` / `:67`、per-entry 変換なし)。

### A2. UUID(asset)vs 非 UUID(legacy OCR)判別

`isAssetKey(key)` = **UUIDv4 厳密判定**(`lib/validation/card.ts:88-90`、`z.uuid({ version: 'v4' })`)。UUIDv4 = asset 参照(server が「自 user の `status='ready'` 実在」を検証 + target 形式強制)、非 v4 = legacy OCR passthrough(検証対象外)。
呼出: `card.ts:109`(target 強制の分岐)/ `card-field-handlers.ts:174`(ready 検証)/ `deck-download.ts:129`(DL 対象収集)/ `card-image-gallery.tsx:167`(描画対象 filter)。

### A3. 「ある assetId を参照している card 数」を数えられるか

**SQL で数える経路は存在しない**。
- grep(`jsonb_array_elements` / `@>` / `->>'key'` / `jsonb_path` 等、test 除く)= **cards.images への jsonb path クエリはゼロ**。
- `cards` に images への jsonb-path index も無し(`schema.ts:298-377`、tenant/FK index のみ)。images は常に「行全体の blob」として読まれる。
- 唯一の集約は **client 側の全走査**: `deck-download.ts:120-131` が `db.cards.where('[user_id+exam_id]').toArray()` → 各 `images` を JS で線形 scan。sweep も同型で全 cards 線形 scan(`sweep.ts:70-77`、「per-item クエリ最適化は不要」)。

→ **「assetId X を参照する card 数」は既存 SQL では引けず、cards を app 側にロードして scan するしかない**(現 HEAD)。server 側に逆引き index も集計関数も無い。

### A4. 同一 assetId が複数 card に入る N:1 の有無

**現フローでは N:1 は起きない**。reserve は毎回 `crypto.randomUUID()` で fresh assetId を発番(`asset-actions.ts:95`)→ 1 card の images に 1 entry append(`upload.ts` attach)。retry も新規 reserve = 新 assetId(`upload.ts` 冒頭コメント)。dedup 再利用は **後続 sprint(§3.5)で未実装**(`asset-actions.ts:19-20`、hash は記録のみ)。card 複製 / コピー機能も **存在しない**(duplicate/clone/copy/複製 grep でヒットなし)。
→ 今日は「1 assetId = ちょうど 1 card の 1 entry」。**refcount は事実上 0 か 1**。N:1 が生じるのは将来 dedup 再利用を入れた時のみ。

---

## B. 参照が減る経路(GC トリガー源)

### B1. card 削除

per-card delete に専用 server action は無く、**outbox → bulk apply registry** を通る(client emit `{ entity_type:'card', op:'delete', patch:{} }`。単票 `delete-card-button.tsx` / bulk `use-bulk-card-delete.ts:59-64`)。
server apply = `applyCardDelete`(`lib/cards/apply-card-mutation.ts:131-168`): 同一 tx で tombstone INSERT → `cards DELETE`(images ごと消える)→ **`bumpExamCardCount(tx, {examId, userId, delta:-1})`(:167)**。この −1 スロットが「asset refcount ∓ を差し込む前例位置」。ただし **この地点で images 配列は手元に無い**(examId のみ保持)。

**追加の card-loss 経路(registry を通らない)**:
- **exam 削除 cascade**: `delete-exam.ts:38-105`(実 `'use server'`)が `exams DELETE` → **FK cascade** で子 cards が消える(`schema.ts:300-302`)。`applyCardDelete` を **経由せず** per-card hook も無い。
- **user 削除 cascade**: `handle-clerk-event.ts:190` の `exams` 削除 → cards cascade。加えて `:200` で `tx.delete(assets).where(userId=...)` = **asset 行自体を app 側で削除**(FK cascade とも整合)。ただし **R2 オブジェクトは消えない**(delete seam 無し)ため R2 orphan 化。同 file が「assets は cascade 削除だが R2 は out of scope(手動)」と明記。

### B2. card 編集で画像だけ外す(card は残る)

client `removeImageFromCard`(`upload.ts:838` 付近): fresh images を読み `after = before.filter(i => i.key !== assetId)` → `commitImages` が `{ card, update_field, patch:{ field:'images', value: after } }` を emit(**配列全置換**)。
server apply = `handleImages`(`card-field-handlers.ts:168-190`): 新配列を zod 検証 + 新 UUID key の ready 実在検証(:174-188)後、`updateCardField` で **images 列を wholesale SET**(:189 → :99-104)。

→ **server は old/new を一切 diff しない**(現 images を SELECT しない)。**どの assetId が参照から抜けたかを server は知らない**。抜けた key は client が捨てた pre-image の中にしか存在しない。これが GC 設計の中核制約。

### B3. apply registry 機構

`lib/sync/server/entity-mutation-registry.ts`: `ENTITY_MUTATION_REGISTRY: Record<entity_type, Record<op, RegistryEntry>>`。`lookupRegistryEntry(entity_type, op)` → bulk receiver `app/api/entity-mutations/bulk/route.ts` の `processMutation`(per-mutation tx で `entry.apply` 呼出)。
card 系 handler(± hook 候補地): `card.create → applyCardCreate` / `card.update_field → applyCardUpdateField`(field='images' は `handleImages`)/ `card.delete → applyCardDelete`。2 段目 field dispatch = `CARD_FIELD_HANDLERS`(`card-field-handlers.ts:291-300`)。

### B4. incremental(±1)vs on-demand scan の当該コスト

- **incremental 前例** = `bumpExamCardCount(tx, {examId, userId, delta})`(`lib/cards/card-count.ts:24-40`、`delta<0` は `GREATEST(card_count+delta, 0)` の負値ガード)。± は card mutation と **同一 tx**(create +1: `apply-card-mutation.ts:110-112` / OCR bulk +N: `upload-persistence.ts:36-40` / delete −1: `:167`)。
- **asset refcount を incremental で保つ場合に hook が要る site**(registry + cascade):
  1. `card.create`(images 付き作成)— ただし registry の `applyCardCreateWithId` は現状 **images を INSERT しない**(images は attach の後続 `update_field` でのみ入る)。この path の hook は現状不要の可能性(**不明**: 将来 images 付き create が無いとは断言できない)。
  2. `card.update_field` field='images' — 追加 key +Δ / 削除 key −Δ。**old images の SELECT + diff が必須**(現状やっていない)。
  3. `card.delete` — 削除 card の全 key −1。**images 配列を手元に持たない**(SELECT/RETURNING 追加要)。
  4. `exam.delete` cascade — registry 非経由。子 cards の全 images を bulk pre-enumerate しないと減算できない。
  5. `user.delete` cascade — asset 行ごと cascade 削除ゆえ refcount は moot(だが R2 orphan は残る)。
  → **4〜5 site**、うち 3 site は「in-tx に必要データが無い」(delete/exam-cascade/update-diff)。**exams.cardCount パターンの単純流用では済まない**。
- **on-demand scan**(代替): 対象 user の全 `cards.images` を SELECT → unnest → `isAssetKey(key)` で filter → assetId ごと count → assets 行と突合。in-tx hook 不要の read-side 再計算で、「どの key が抜けたか server が知らない」問題を **回避**(生存 cards から真値を再計算)。コスト = 全 cards jsonb scan(A3 のとおり index 無し)。

---

## C. R2 DELETE seam

- **現状 seam ゼロ**(§Step 0)。新設が必要。選択肢(事実整理・確定しない):
  - **server-side authenticated DELETE**: `r2.ts` の `AwsClient` は `client.fetch(objectUrl, { method:'DELETE' })` で S3 DeleteObject を直に叩ける(headObject が同 client の HEAD を使う前例)。GC は server 駆動ゆえ browser 経由不要で、これが最小。
  - **presigned DELETE**: browser に消させる形。GC は server バッチ想定ゆえ用途薄。
- **Sprint 1/2 の decouple 規律の再適用可否**: 適用可能。
  - `integration_failures` 台帳(`schema.ts:221-241`)= 4 軸判別列 `service / operation / workflow / failure_code` + `context` jsonb + dormant `retry_count/next_retry_at/resolved_at/resolution_note`。
  - `recordIntegrationFailure`(`lib/integration-failures.ts:96`)= catalog(`INTEGRATION_FAILURE_CATALOG:18`)から 4 軸を引く INSERT→notifyOps dual-write(INSERT 失敗は握って Discord 継続、server-only)。
  - 「R2 GC 失敗」を足す差込点 = **catalog に新 entry 1 つ追加**(例 `service:'r2'`〔新規 service〕/ `operation:'object.delete'` / `workflow:'asset_gc'` / `failureCode:'external_api_error'`)。既存 4 軸 tuple は rename せず「新 entry 追加」で拡張する規約(`integration-failures.ts:16-17`)に合致。
  - decouple 形: **DB 参照減(refcount 0 判定 / unreferenced_at 立て)は forward-only の真実、R2 delete は best-effort、失敗は台帳に記録**(fallible 外部 op を主経路から切り離す Sprint1/2 と同型)。

## D. ローカル Cache blob 回収

- `deleteAssetBlob` の現呼出点は **3 つのみ**: `abandonUpload`(`upload.ts:807` 付近、upload 巻戻し)/ `sweep`(`sweep.ts:99, 131`、stale 'uploading' / 中断 DL job)/ `deck-download` rollback(`deck-download.ts:105`)。
- **card 削除 / image 外し編集では現状 deleteAssetBlob を呼んでいない**(`removeImageFromCard` は images を filter するだけ、local card delete 経路も呼ばない)。→ **ready asset を card から外した後の local Cache blob は現状回収されない**(local orphan も既に存在)。sweep は 'uploading' 限定で ready を掃かない。
- 「ローカルは消えうるキャッシュゆえ即消し可・端末間協調不要」前提は実装上成立する: Cache API は origin+userId scope(`cache.ts:10`)、消えても表示時に resolve→R2 GET で再取得できる設計(`get-asset` 経路)。ただし **再取得は R2 実体が生きていてこそ成立**(§E)。deck-download が再 populate しうる点も踏まえ、local delete は「参照が local mirror から消えた時点」で安全に即実行できるが、**R2 実体消去とは独立**に扱うべき(local は best-effort 掃除、R2 は refcount 0 収束後)。

## E. sync / concurrency(後段 Fable 判断材料)

- **sync モデル = field 単位 LWW 全置換**。outbox は `(entity_type + entity_id + op + patch.field)` で coalesce(`entity-mutations.ts:41-52`)= 同 card 同 field の最新値が勝つ。images は「配列丸ごと」を送る(operational delta ではない)。server も wholesale overwrite(§B2)。
- **refcount を server 権威にした場合**: client 側に refcount は無い(Dexie `media_assets` は status/mime 等のみ)。複数端末が add/remove しても各端末は「images 配列全体」を送るだけで「asset X を −1」とは送らない。→ **incremental ±1 は overwrite モデルと構造的に不整合**(server が delta を復元するには old-diff が必須、かつ exam/user cascade は hook を素通り)。**on-demand recount(生存 cards から再計算)なら LWW 収束後の真値に自然収束**し、二重減算 / lost-update / 順序前後の危険を持たない。
- **R2 回収後の stale presigned GET**: `resolveAssetUrls`(`asset-actions.ts:170-225`)は `status='ready'` の自 user asset のみ返す。asset 行が消えていれば resolve は黙って省く(client は不在扱い)。**危険なのは「asset 行は ready のまま R2 実体だけ消えた」状態**(GC の best-effort R2 delete と別端末の stale mirror 参照の competition)→ presigned GET が 403/404。「消えたら再取得」は R2 実体が生きている前提ゆえ、**回収発火は真に refcount 0 に収束した後のみ**にする設計要件が導かれる。
- **dedup 再利用(後続)を入れた場合**: 現状は 2 端末が同一画像を同時 upload しても各々 fresh assetId + 別 object_key(`users/{uid}/{assetId}.ext`、object_key UNIQUE に assetId を含む)ゆえ **R2 は別オブジェクト 2 個**(衝突無し)。dedup を入れると finalize が既存 `(user_id, hash)` ready asset を指す形になり、**余った PUT 実体 or 敗者側が orphan 化**しうる。かつ 1 asset が複数 card 共有 = **単一 card 削除で R2 を消せなくなり refcount が必須化**する。→ dedup と GC は相互依存(§論点 5)。

---

## dormant 前提の訂正(現 HEAD との突合)

- **「dormant」記述自体は正**(reference_count / unreferenced_at は真に未使用)。訂正不要。
- **「思ったより重い」補正**: 「exams.cardCount の bumpExamCardCount パターンを流用して incremental refcount」は**過小評価**。理由 =(1)images update は diff 不能な wholesale overwrite、(2)exam 削除 / user 削除 cascade は per-card hook を素通り、(3)card.delete apply は images 配列を in-tx に持たない。単純流用不可で、3 site が追加 SELECT / bulk enumerate を要する。
- **「思ったより軽い」補正**: dedup 導入前は N:1 が起きず「1 asset = 1 card」ゆえ refcount は実質 0/1。**厳密な counter を持たずとも「生存 cards から参照されていない assets を scan で検出 → orphan」で足りる**(dedup 前限定)。GC を dedup より先に入れるなら scan-based が最小で、将来 refcount にも移行しやすい。

## 後段 spec で決める論点リスト(fact-finding では確定しない)

1. **回収タイミング**: ①参照減 apply 時 refcount 0 で即 R2 delete / ②`unreferenced_at` を立てて後で sweep(reconciler)/ ③手動 SQL。→ 現削除経路(wholesale overwrite + cascade 素通り + delete 時 images 不在)を踏まえると①は hook 不備で漏れやすく、②(scan/reconciler)が最も現構造に自然(§B4/E)。要 OT 判断。
2. **refcount incremental vs on-demand scan**: incremental は 4-5 hook site(3 site データ不足)+ cascade 特別扱いで fragile。scan は LWW-overwrite sync と整合。どちらを正にするか。
3. **R2 DELETE seam**: server-side authenticated DELETE(`AwsClient.fetch DELETE`)vs presigned DELETE。GC が server バッチなら前者最小。
4. **decouple 台帳**: DB 参照減 forward-only / R2 delete best-effort / 失敗 → integration_failures(catalog に `service:'r2'` 新 entry)。台帳再利用の可否と 4 軸語彙確定。
5. **dedup との順序**: GC を dedup より先に入れるか。dedup 後は refcount 必須化(単一 card 削除で R2 を消せない)。scan-based GC を先に入れて dedup 時に refcount へ寄せる移行計画。
6. **回収発火条件**: stale presigned GET 防止のため「真に refcount 0 に収束後のみ R2 delete」。収束をどう判定するか(unreferenced_at + 猶予期間 grace など)。
7. **exam / user 削除 cascade の捕捉**: per-card hook が無い cascade を GC がどう拾うか(scan なら自然に拾える / incremental だと特別 pre-enumerate 要)。
8. **local Cache blob**: 現状 card delete / image 外しで deleteAssetBlob 未呼出 = local orphan も既存。GC で local trigger を足すか、sweep 拡張で拾うか。

## CC 暫定所見(agree / disagree を分離)

**agree(事実が強く支持)**
- **on-demand scan(≒論点①の②:unreferenced_at + reconciler sweep)が現 sync(field 単位 LWW 全置換)と最も整合**。incremental refcount は wholesale-overwrite + cascade 素通りゆえ heavy かつ抜けやすい。
- **R2 delete は server-side authenticated DELETE seam を新設し、integration_failures 台帳 + Sprint1/2 decouple(forward-only DB / best-effort R2 / 失敗記録)を再適用**するのが既存規律に最も乗る。
- **dedup 前は「参照ゼロ scan = orphan」で十分**(N:1 不成立ゆえ厳密 counter 不要)。

**disagree / caution**
- 「bumpExamCardCount をそのまま流用して refcount を incremental 維持」は **現構造では成立しない**(§B2 の diff 不能 overwrite が load-bearing 制約)。採るなら handleImages に old-images SELECT+diff / applyCardDelete に images RETURNING / exam-cascade の pre-enumerate を全部足す必要があり、YAGNI・簡潔性規律に照らして scan-based より重い。
- 「回収を参照減 apply の同 tx で即 R2 delete」は、外部 fallible op を主経路に載せる点で Sprint1/2 decouple 規律に反する(best-effort へ切り離すべき)。

**未確認 / 不明(後段で要裏取り)**
- registry の `card.create` に images 付き経路が将来生じないか(現状 `applyCardCreateWithId` は images を INSERT せず、images は attach の後続 update_field 経由。**不明**)。
- scan-based recompute を既存 sync cursor(`content_version` / pull-back)に相乗りできるか未調査(**不明**)。
- R2 の実 DeleteObject 応答 / 冪等性(存在しない key の DELETE 挙動)は未検証(**不明**、seam 新設時に stg smoke 要)。
