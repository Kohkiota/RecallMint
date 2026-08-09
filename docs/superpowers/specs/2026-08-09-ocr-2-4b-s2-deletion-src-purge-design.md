# ②-4b §2: 退会時の `src/{userId}/` prefix purge 設計 spec

- 関連: §1 spec `docs/superpowers/specs/2026-08-09-ocr-2-4b-s1-staging-delete-design.md`(catalog 規律・
  best-effort の考え方を継承)/ fact-finding `docs/audit/2026-08-09-ocr-2-4b-s1-factfinding.md`
- 親 spec(key 規約・凍結): `docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md`
- **用語衝突の注意**: §1 の「purge」= client registry の登録一掃。本 spec の「purge」= 退会時の
  R2 prefix 一括削除。以後、前者を **registry purge**、後者を **退会 prefix purge** と書き分ける。

## 1. 目的

退会処理に `src/` の listing / DELETE が無く、未 submit の staging PDF が lifecycle(実効 ≈48h)
まで残る。key に内部 userId が入る(`src/{userId}/{uploadSessionId}/{fileId}.pdf`)ため prefix で
列挙でき、台帳(`source_assets` 表)が無くても回収できる。

## 2. 現物確認の結果(read-only・2026-08-09)

### 2.1 退会処理の構造 — `lib/clerk/handle-clerk-event.ts:82-249`

| 段 | 内容 | tx | 失敗時 |
|---|---|---|---|
| A | `app_bootstrap_user_from_clerk(clerkId)` で `internalUserId` + `stripe_customer_id` 解決(:93-97) | 外 | 0 行なら `notifyOps` して **early return**(:104-114) |
| B | Stripe subscription cancel ループ(:119-158) | **外** | `recordFailure`(台帳)して続行(forward-only) |
| C | DB tx: tenant context → PII scrub → Group I 10 表 DELETE → `assets` を `'deleting'` へ UPDATE(:204-248) | 内 | `runTransactionWithRetry` が最大 3 retry → 最終失敗も **`recordFailure` して正常 return**(:344-374) |

- **`runTransactionWithRetry` は permanent 失敗でも throw せず return する**(:365-367)。
  → **C の後ろに置いたコードは、DB scrub の成否に関わらず必ず実行される。**
- webhook は `await handleEvent(evt)` の**同期実行**(`app/api/webhooks/clerk/route.ts:89`)。
  `after()` は使っていない。route は常に 200 を返し(Clerk 再送抑止)、outer catch が notifyOps。
- **時間制約 = `maxDuration: 60`**(`vercel.json` の `app/api/webhooks/clerk/route.ts`)。

### 2.2 ⚠ 前提との相違 — **退会経路に R2 I/O は 1 つも無い**

`lib/clerk/` から `@/lib/storage/r2` への import は **0 件**(grep 実測)。
brief が言う「R2 に触る既存処理(assets 側)」は退会 handler の中には**存在しない**:
`assets` は行を `status='deleting'` に倒すだけで(:234-237)、**R2 実体の削除は OT 手動実行の
`scripts/gc-image-assets.ts`(reconciler)に委譲**されている(spec §4.8 の decouple 規律)。

したがって「既存 assets と同じ分離を踏襲」は字義どおりには成立しない — assets の分離は
「tx 外で即やる」ではなく「**別プロセスへ全面委譲**」である。本 spec が採るのは、
brief の**設計方針**(R2 I/O を DB scrub tx の成功条件に混ぜない / best-effort / 失敗は台帳)に
沿った別の先例:

- **Stripe cancel ループ**(同 handler・tx 外・失敗は `recordFailure` して続行)= 最も近い先例
- `syncClerkPublicMetadata`(user.created 経路・「外部 I/O ゆえ tx 外」:66-72)

→ **論点 1**(§9)として OT 判断に上げる。判断が「委譲側に寄せる」なら本 spec は破棄し §3 に統合。

### 2.3 `listObjects`(`lib/storage/r2.ts:318-364`)

- prefix 指定 **あり** / pagination **あり**(`continuation-token` + `MAX_LIST_PAGES=10000` guard +
  token 非前進検出で throw)/ malformed 応答を空ページと誤読しない fail-closed
- **返すのは key 文字列のみ**。`LastModified` / `Size` は捨てている。
- **never-throw ではない**(`!res.ok` / malformed / pagination 異常で throw)。`deleteObject` の
  never-throw 契約とは非対称 — 呼出側で catch が要る。
- → **§3 sweeper への申し送り**: age ベースの sweep には `LastModified` が要る。本 spec では
  不要(prefix 全消しのため)なので **listObjects は変更しない**。§3 が別 helper 追加か
  `listObjects` 拡張かを決める(本 spec の scope 外)。

### 2.4 userId の可用性

`internalUserId` は **A 段(:96)で確定**し、C 段より前に変数として保持される。
C 段の scrub は `clerk_id` を NULL 化するが `users.id` は不変で、変数も影響を受けない。
→ 退会 prefix purge は **A の後ならどこにでも置ける**。

### 2.5 既存 invariant test への影響

`app/api/webhooks/clerk/route.test.ts:939` の Group I 不変条件 test は **schema 由来の機械算出 ×
drizzle spy の `tx.delete` 呼出集合**で照合する(source text 走査ではない)。:487 は
`update ×1 / delete ×10` を件数 pin。本 spec は **DB 呼出を 1 つも増やさない**ため両者に影響なし。

## 3. 設計

### 3.1 配置 — C(DB tx)の**後**

```
A resolve → B Stripe cancel → C DB tx(scrub/削除)→ **D 退会 prefix purge(新設)**
```

- C の後に置く理由: DB scrub(GDPR の本体)を先に完了させる。かつ §2.1 のとおり
  `runTransactionWithRetry` は失敗しても return するため、**C が失敗しても D は必ず走る**
  (R2 の原本回収は DB の成否に依存させない)。
- A の early return(userId 未解決)配下では D も走らない — prefix を組めないので正しい。

### 3.2 処理

`lib/clerk/handle-clerk-event.ts` に private 関数 1 本を追加する(新 module は作らない):

1. `const keys = await listObjects(\`src/${internalUserId}/\`)`
2. `await Promise.all(keys.map((k) => deleteObject(k)))` — 失敗 key のみ台帳へ
   (`deleteSourceKeys`(`upload-pipeline.ts:552-578`)と同型。`deleteObject` は never-throw + 404=成功系)
3. **全体を try/catch で包む**。`listObjects` は throw しうる(§2.3)ので、listing 失敗も
   台帳 1 行にして飲む。**この関数は throw しない契約**(退会処理を巻き込まない)。

prefix は `src/{internalUserId}/` の**末尾スラッシュ必須**(`src/{uid}` だと別 uuid の
前方一致を拾いうる)。key builder(`sourcePdfObjectKey`)と同じ形をコメントで参照する。

### 3.3 失敗記録 — catalog 新 entry(4 軸)

```
r2_deletion_src_delete: {
  service: 'r2',
  operation: 'object.delete',
  workflow: 'user_deletion',      // 既存 deletion_* と同じ workflow 語彙(意味的に正しい)
  failureCode: 'external_api_error',
}
```

- 4 軸 tuple の一意性: 既存 `user_deletion` は `stripe/subscription.cancel` `stripe/subscription.list`
  `db/user.data.delete` の 3 種で、`r2/object.delete` は**未使用** → 一意。
- 他の `r2/object.delete` とは **workflow で区別**: `asset_gc`(画像 GC)/
  `upload_single_invocation`(pipeline 出口)/ `upload_staging`(§1)/ **`user_deletion`(本 spec)**。
  相乗り禁止の規律(`lib/integration-failures.ts:16-17`)に従う。
- context = `{ userId, objectKey, status }`(単体 DELETE 失敗)/ listing 失敗時は
  `{ userId, phase: 'list' }` + `errorMessage`。**key 以外の PII は入れない**(Discord へも出る)。
- 件数が多い場合に台帳を洪水にしないため、**失敗 key は最大 20 件までを 1 行に集約**して記録する
  (`{ userId, failedCount, sampleKeys }`)。← 論点 2(§9)

### 3.4 やらないこと

- migration / schema 変更 / 台帳行の新設 / `listObjects` の変更
- 退会 prefix purge の retry ループ(取り漏らしの受け皿は §3 sweeper / lifecycle)
- **1 回の purge で完結する仮定を置かない**: 退会と同時に飛行中だった presigned PUT は
  purge の後に着地しうる(presigned URL は失効まで有効)。§7 に限界として記録。

## 4. 不変条件

1. **退会処理は R2 の失敗で失敗しない**: D は throw しない契約(try/catch で全て飲む)。
2. **D は DB scrub の成否に依存しない**(C の後ろ・`runTransactionWithRetry` は return する)。
3. prefix は `src/{internalUserId}/`(末尾スラッシュ)。他 prefix・他 user を触らない。
4. DB 呼出を増やさない(既存 Group I 不変条件 test の件数 pin を動かさない)。

## 5. テスト(実装 task が TDD で書く)

`app/api/webhooks/clerk/route.test.ts`(既存 harness の r2 mock 追加)または
`lib/clerk/handle-clerk-event` 単体で:

- 退会成功時に `listObjects('src/{internalUserId}/')` が **末尾スラッシュ付き**で呼ばれる
- 返った key 全件に `deleteObject` が呼ばれる(pagination 済みの配列をそのまま消費)
- `deleteObject` 失敗 → 台帳が `r2_deletion_src_delete` で呼ばれる / 成功のみなら台帳不呼出
- `listObjects` throw → 台帳 1 行(phase='list')+ **handleEvent は throw しない**
- **DB tx が失敗(recordFailure 経路)しても D は実行される**(不変条件 2 の pin)
- userId 未解決(bootstrap 0 行)の early return では `listObjects` **不呼出**
- 既存 pin の回帰なし(Group I 集合 / update×1・delete×10 の件数 pin / 200 返却)

## 6. 変更一覧

| file | 変更 |
|---|---|
| `lib/clerk/handle-clerk-event.ts` | private 関数 1 本 + C の後の呼出 1 行 + import 2 |
| `lib/integration-failures.ts` | catalog に `r2_deletion_src_delete` 追加 |
| `lib/integration-failures.test.ts` | 件数 pin 12→13 + 4 軸 pin 1 本 |
| `app/api/webhooks/clerk/route.test.ts`(or 単体) | §5 の pin |
| `docs/architecture.md` | source 行の DELETE 経路列挙に退会 prefix purge を追記 |

migration / env なし。

## 7. 限界(受容・記録)

- 退会と同時に飛行中だった PUT の後着地(presigned URL は失効まで有効)
- listing / DELETE の失敗分(台帳に残る・retry しない)
- **非対称の明記**: 本 spec 後も **画像 asset の R2 実体は OT 手動 GC まで残る**(assets は
  `'deleting'` 行を残して委譲)。「退会で R2 が消える」と書くと偽になる — doc では
  「`src/`(OCR 原本)は退会時に即時 best-effort 削除、asset 実体は GC lane」と範囲を同じ文に書く。

## 8. stg smoke(OT push 後)

**退会は破壊操作かつ不可逆**。以下を厳守する:

- **専用の使い捨て test account を新規作成して行う**。既存 smoke アカウントは使わない。
- **理由(具体的な事故リスク)**: 現在 `src/` にある lifecycle 観測 sentinel 2 本
  (`55b4316c…` / `f4f91e6d…`)は **user `85541b25…`(既存 smoke アカウント)の prefix 配下**にある。
  このアカウントで退会 smoke を実行すると **sentinel を巻き込んで削除する**(8/11 まで不可触の制約に違反)。
- 手順: 新 test account 作成 → PDF を数冊 staging(submit しない)→ listing で n 本を確認 →
  Clerk dashboard から退会 → 当該 prefix が **0 件**になることを確認 → 他 prefix(sentinel 含む)が
  **不変**であることを確認。
- 退会実行(Clerk dashboard 操作)は **OT**。listing 判定は CC。
- 台帳確認(`workflow='user_deletion'` かつ `service='r2'` の行が無いこと)は OT 照会(SELECT 42501)。

## 9. 論点(OT 判断)

1. **§2.2 の相違**: 退会経路に R2 I/O の先例は無い(assets は GC 委譲)。本 spec は
   「tx 外・best-effort・台帳」を Stripe ループの先例に倣って**退会 handler 内で直接 R2 を触る**
   設計にしている。代替は「§3 sweeper に全面委譲し §2 を作らない」(assets と同じ形)だが、
   それでは brief の acceptance「退会した user の `src/{userId}/` 配下 object が消える」を
   退会時点で満たせない。**本 spec の方針で進めてよいか。**
2. **§3.3 の台帳集約**(失敗 key を最大 20 件のサンプルに集約して 1 行)。既存 `r2_source_delete` /
   `r2_gc_delete` は **失敗 1 件 = 1 行**。退会は 1 user 分がまとめて失敗しうる(R2 障害時)ため
   集約を提案するが、既存規律との一貫性を採るなら 1 件 1 行。**どちらを採るか。**
