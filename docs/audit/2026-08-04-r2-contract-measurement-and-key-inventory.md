# R2 契約実測 + キー構造 fact-finding(②-4a T15 前・調査のみ)

**日付**: 2026-08-04
**目的**: 公式 doc に記載が無い R2 の挙動を stg 実測で確定し、キー構造を現物確認する。**実装・plan 修正・commit なし**。
**接続先**: `.env.local` の R2 = bucket `recallmint-dev`。**stg 同定の根拠** = read-only LIST で既知 orphan `users/85541b25-51e9-44a3-8952-e383f98d4ae3/src/654e3523-86bc-431f-9910-7ab819656ca3.webp`(T14b′ smoke で検出された実物)の実在を確認。
**破壊範囲**: 使い捨て prefix `__t15probe__/` 配下のみ(自分で PUT → 実測 → DELETE)。既存 `users/` には write/delete 一切なし。実測後 `__t15probe__/` が空であることを LIST で確認済。probe script は削除済(scratchpad・repo 外)。

---

## 1. DeleteObjects — 不在 key 混在(実測)

要求 = 実在 2 件 + 不在 2 件、`Content-MD5` あり。

```
### 4. DeleteObjects: 実在2 + 不在2 (Content-MD5 あり)
HTTP 200 OK
content-type: application/xml
<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Deleted><Key>__t15probe__/ced40bd7/a.bin</Key></Deleted><Deleted><Key>__t15probe__/ced40bd7/b.bin</Key></Deleted><Deleted><Key>__t15probe__/ced40bd7/does-not-exist-1</Key></Deleted><Deleted><Key>__t15probe__/ced40bd7/does-not-exist-2</Key></Deleted></DeleteResult>
```

- HTTP **200**。不在 key も **`<Deleted>` 側に入る**。`<Error>` 要素・`<Errors>` 配列は**出ない**。
- `<Deleted>` は `<Key>` のみ(`<VersionId>` / `<DeleteMarker>` なし)。
- 付随: `Content-MD5` **なし**でも 200(R2 は必須としない)。

```
### 6. DeleteObjects: Content-MD5 なし
HTTP 200 OK
<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Deleted><Key>__t15probe__/ced40bd7/c.bin</Key></Deleted></DeleteResult>
```

## 2. 部分失敗のレスポンス形 → **stg では再現できず**

試した誘発手段と結果(すべて生レスポンス):

```
### F1. DeleteObjects 1001 件 (上限 1000 超過)
HTTP 400 Bad Request
<?xml version="1.0" encoding="UTF-8"?><Error><Code>MalformedXML</Code><Message>The number of keys in the request must be between 1 and 1000 inclusive.</Message></Error>

### F2. DeleteObjects 1000 件 (実在1 + 不在999)
HTTP 200 OK
<?xml version="1.0" encoding="UTF-8"?><DeleteResult …><Deleted><Key>__t15probe__/349700fe/keep.bin</Key></Deleted><Deleted><Key>__t15probe__/349700fe/bulk-0</Key></Deleted>…(1000 件すべて Deleted)

### F3. DeleteObjects 超長 key (1500B)
HTTP 200 OK
<?xml version="1.0" encoding="UTF-8"?><DeleteResult …><Deleted><Key>__t15probe__/349700fe/xxxx…(1500B)</Key></Deleted></DeleteResult>

### F4. DeleteObjects 空リスト
HTTP 400 Bad Request
<?xml version="1.0" encoding="UTF-8"?><Error><Code>MalformedXML</Code><Message>The XML you provided was not well formed or did not validate against our published schema.</Message></Error>

### DeleteObjects: 空 <Key></Key>
HTTP 200
<?xml version="1.0" encoding="UTF-8"?><DeleteResult …><Deleted><Key></Key></Deleted></DeleteResult>

### DeleteObjects: 実在 weird key + 空 key 混在
HTTP 200
<?xml version="1.0" encoding="UTF-8"?><DeleteResult …><Deleted><Key>__t15probe__/enc/a&amp;b テスト.bin</Key></Deleted><Deleted><Key></Key></Deleted></DeleteResult>
```

- 上限超過・空リストは **request 全体が 400**(per-key 情報なし)。
- 超長 key / 空 key / それらの混在は **すべて 200 + `<Deleted>`**。
- → **per-key `<Error>` を 1 度も観測できていない。要素名・構造は不明**(推測で書かない)。単一資格情報の stg では権限差・object lock 等の失敗要因を作れないため。

## 3. ListObjectsV2(実測)

```
### 1. LIST max-keys 未指定 (3 objects)
HTTP 200 OK
<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>recallmint-dev</Name><Contents><Key>__t15probe__/ced40bd7/a.bin</Key><Size>5</Size><LastModified>2026-08-04T08:12:28.130Z</LastModified><ETag>&quot;8da843ff65205a61374b09b81ed0fa35&quot;</ETag><StorageClass>STANDARD</StorageClass></Contents>…<IsTruncated>false</IsTruncated><Prefix>__t15probe__/ced40bd7/</Prefix><MaxKeys>1000</MaxKeys><KeyCount>3</KeyCount></ListBucketResult>

### 2. LIST max-keys=1 (truncation)
HTTP 200 OK
…<IsTruncated>true</IsTruncated><Prefix>…</Prefix><MaxKeys>1</MaxKeys><NextContinuationToken>1-JTdCJTIydiUyMiUzQTElMkMlMjJzdGFydEFmdGVyJTIyJTNBJTIyX190MTVwcm9iZV9fJTJGY2VkNDBiZDclMkZhLmJpbiUyMiUyQyUyMnV1aWQlMjIlM0ElMjI3ZTYwMzQyYjM1ZWQ2OWE3Mjc1ZWNiZTA0NWQzYjhlMSUyMiU3RA==</NextContinuationToken><KeyCount>1</KeyCount></ListBucketResult>

### 3. LIST continuation-token 継続
HTTP 200 OK
…<Contents><Key>__t15probe__/ced40bd7/b.bin</Key>…</Contents><IsTruncated>true</IsTruncated>…<NextContinuationToken>…</NextContinuationToken><ContinuationToken>…(要求した token をエコー)</ContinuationToken><KeyCount>1</KeyCount></ListBucketResult>
```

- `max-keys` 未指定 → **`<MaxKeys>1000</MaxKeys>`**(既定 1000)。
- `IsTruncated` / `NextContinuationToken` / `ContinuationToken` エコー すべて動作。token は base64(中身は URL エンコードされた JSON)。
- `delimiter=/` → `<CommonPrefixes><Prefix>…</Prefix></CommonPrefixes>` が返る(§5 の実測参照)。

### 3.1 key の XML 表現(parse 設計に直結)

```
### LIST (weird key の XML 表現)
<Key>__t15probe__/enc/a&amp;b テスト.bin</Key>

### LIST encoding-type=url
<Key>__t15probe__%2Fenc%2Fa%26b%20%E3%83%86%E3%82%B9%E3%83%88.bin</Key> … <EncodingType>url</EncodingType>
```

- 既定は **XML entity 化**(`&` → `&amp;`)。`encoding-type=url` を付けると key 全体が percent-encoded になる(XML 特殊文字が key に現れなくなる)。
- `<Contents>` の要素順は **Key, Size, LastModified, ETag, StorageClass**。AWS S3 の公開例(Key, LastModified, ETag, Size, StorageClass)と**順序が異なる** → 順序前提の parse は不可。
- `LastModified` = `2026-08-04T08:12:28.130Z`(ミリ秒付き ISO8601)。`<Owner>` は返らない。

## 4. @aws-sdk/client-s3 → **未導入ゆえ実測不能**

- `package.json` に `@aws-sdk/*` の記載なし(依存は `aws4fetch@1.0.20`・`package.json:34`)。`node_modules/@aws-sdk` も不在。
- 現行の R2 seam は **aws4fetch による生 HTTP**(`lib/storage/r2.ts:53-59` で `AwsClient` を構築)。
- → `DeleteObjectsCommand` の戻り値型(Deleted / Errors)と例外挙動は**本調査では不明**。導入は新ライブラリゆえ事前相談事項(CLAUDE.md)。**推測は書かない**。

---

## 5. キー構造(現物・file:line)

| 種別 | key 形 | 生成箇所 |
|---|---|---|
| source 最終(immutable) | `users/{user_id}/src/{sourceAssetId}.{ext}` | `app/(app)/app/upload/_actions/source-asset-actions.ts:168` |
| source temp(presigned PUT 先) | `users/{user_id}/src/tmp/{sourceAssetId}` | `app/(app)/app/upload/_actions/prepare-upload.ts:444` |
| crop 図版(表示) | `users/{user_id}/{figureAssetId}.webp` | `lib/media/crop-and-store.ts:380` |
| 手動 upload asset(表示) | `users/{user_id}/{assetId}.{ext}` | `app/(app)/app/exams/[id]/_actions/asset-actions.ts:98` |

- パス位置は **`users/` + user_id が第 2 セグメント**、以降は asset の UUID。**exam_id / operation_id / source_document_id は key に一切現れない**(4 箇所とも)。
- **user 単位で source だけを絞れるか = 可**。`users/{uid}/src/` の前方一致が最終 + temp(`src/tmp/`)を内包し、表示 asset(`users/{uid}/{uuid}.ext`)を含まない。
- **exam 単位で絞れるか = 不可**。key に exam 情報が無いため、exam scope は DB 行(`source_documents.exam_id`)からしか辿れない。

### 5.1 stg 実在オブジェクトの実測(read-only)

- `users/` を `delimiter=/` で列挙 → **user prefix 3 件**。うち `src/` 配下を持つのは 1 user のみ。
- `users/85541b25-…/src/` = **14 オブジェクト**(最終 `.webp` 11 件 + `src/tmp/` 直下 3 件)。
- 既知 orphan `654e3523-86bc-431f-9910-7ab819656ca3.webp` を含む。**temp 3 件は経路 E(finalize の temp 削除失敗)の残骸候補**(DB 突合は本調査の範囲外 = 未実施)。
- **legacy / 想定外形式の key は `src/` 配下には観測されなかった**(14 件すべて上表の形)。他 2 user の prefix 配下は表示 asset 側ゆえ未列挙。

## 6. 既存 R2 seam(現物・file:line)

- **削除 seam** = `deleteObject(objectKey): Promise<{ ok: boolean; status: number | null }>`(`lib/storage/r2.ts:242-257`)。単体 DELETE のみ・never-throw・**404 を `ok:true` として扱う**(`:250-252`)・timeout 10 秒(`:41`)。
- 呼出 5 箇所: `lib/media/source-purge.ts:129` / `app/(app)/app/upload/_actions/source-asset-actions.ts:271,285` / `scripts/gc-image-assets.ts:399,658`。
- **List 相当の seam は存在しない**(`lib/storage/r2.ts` の export = presignPutUrl:81 / presignGetUrl:100 / headObject:119 / getObject:153 / putObject:190 / deleteObject:242)→ **新設が要る**。
- **integration_failures への記録**:
  - asset lane: key `r2_gc_delete`(`scripts/gc-image-assets.ts:1131-1132`)
  - source lane: key `r2_gc_delete_source`(`scripts/gc-image-assets.ts:870-871` / `lib/media/source-purge.ts:137-143`)
  - catalog 定義 = `lib/integration-failures.ts:72`(`r2_gc_delete`)/ `:83`(`r2_gc_delete_source`)
  - **`source-asset-actions.ts:271` / `:285` は台帳記録なしの best-effort**(戻り値未検査)= fact-finding 経路 E の silent orphan 源。

## 7. 退会経路(現物・file:line)

- `lib/clerk/handle-clerk-event.ts:217` `tx.delete(exams).where(eq(exams.userId, internalUserId))` が唯一の起点。cascade chain:
  - `source_documents.exam_id` cascade(`lib/db/schema.ts:387-389`)
  - `source_assets.source_document_id` cascade(`lib/db/schema.ts:901-903`)
  - `upload_operations.exam_id` cascade(`lib/db/schema.ts:960-962`)
- **`source_assets` / `upload_operations` を handler が明示処理する箇所は無い**(Group I 明示 DELETE 10 件 + `assets` soft-delete = `handle-clerk-event.ts:217-237`)。R2 DELETE もこの経路には無い。
- **users soft-delete の実態**: `app_scrub_deleted_user`(`drizzle/migrations/0025_rls_p2_functions.sql:74-86`)が `UPDATE users SET deleted_at = now(), email = NULL, clerk_id = NULL WHERE id = p_user_id`。**users 行自体は残る**(`lib/db/schema.ts:139` `deleted_at`)。
- → **退会後に user_id を引けるか**: **DB からは可**(`users.id` 行は残存・`deleted_at IS NOT NULL` で退会済を識別可能)。**clerk_id からは不可**(NULL 化ゆえ `app_bootstrap_user_from_clerk` は 0 行 = `handle-clerk-event.ts:104-114` の未解決分岐に落ちる)。

---

## 8. T15 の設計に効く事実 / 効かない事実

**効く**
- DeleteObjects は不在 key も 200 + `<Deleted>` → 削除の冪等性が API レベルで担保される(事前の存在確認が不要)。
- per-key `<Error>` の形が**不明** → `Errors` 配列前提の分岐は今は書けない。失敗検出は「`<Deleted>` の件数 ≠ 要求件数」または request 全体の非 200 に依らざるを得ない。
- 1001 件で request 全体が 400 → **1000 件 chunk が必須**(既存 `COLLECT_BATCH_SIZE = 1000`・`scripts/gc-image-assets.ts:102` と同値)。
- `max-keys` 既定 1000 + `NextContinuationToken` 動作確認 → 全ページ走査の実装可否は確定。
- key に exam_id が無い → **exam 削除は prefix 一括削除に倒せない**(行駆動のまま)。**退会だけが `users/{uid}/src/` の prefix 一括に倒せる**。
- 退会後も `users.id` が残る → user 単位 prefix sweep を DB から駆動できる(clerk_id 経由は不可)。
- XML: 要素順が AWS と異なる / 既定は entity 化 / `encoding-type=url` が使える → parser は順序非依存 + decode 必須(または url encoding を選ぶ)。
- List seam が無い → 新設が要る(実装コストは T15 の scope 判断に直結)。
- stg の `src/` 実在 14 件(最終 11 + temp 3)= sweep 初回実行時の想定対象規模。

**効かない**
- `Content-MD5` が不要であること(実装が少し楽になるだけ)。
- 超長 key / 空 key が 200 になること(正規 key 生成経路では発生しない)。
- `ETag` / `StorageClass` / `Size` / `<Owner>` 不在(削除判定に使わない)。
- lifecycle rule の前方一致仕様(`users/{uid}/src/` は表現可能だが **user ごとに rule が要り、rule 数上限は未調査 = 不明**。今回の実測対象外)。
