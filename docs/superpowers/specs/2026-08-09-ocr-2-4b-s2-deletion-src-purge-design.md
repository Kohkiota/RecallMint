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
  不要(prefix 全消しのため)。§3 が別 helper 追加か `listObjects` 拡張かを決める(本 spec の scope 外)。
- **呼出元は `scripts/gc-src-prefix.ts` の 2 箇所のみ**(+ 単体 test)。実測済。
- ⚠ **当初「listObjects は変更しない」と書いたが、OT 裁定の追加要件(listing 上限)により撤回**。
  §3.2 のとおり bounded core を切り出す(既存 `listObjects` の外部契約は完全に不変)。

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

### 3.2 処理と予算(OT 追加要件: 上限を設けて打ち切る)

`maxDuration: 60` の同期実行(§2.1)ゆえ、purge が退会 handler を圧迫してはならない。
**listing・DELETE の両方に上限を設け、超過分は打ち切って台帳に記録**する(受け皿は §3 / lifecycle)。

定数(`handle-clerk-event.ts` 内に置く。値の根拠を 1 行コメントで残す):

| 定数 | 値 | 根拠 |
|---|---|---|
| `SRC_PURGE_BUDGET_MS` | `20_000` | Stripe ループ + DB tx(retry backoff 最大 3.5s)を差し引いても 60s に収まる |
| `SRC_PURGE_MAX_LIST_PAGES` | `2` | 1 page ≈ 最大 1000 key。実運用の staging 数本を桁で上回る。listing 最悪 2×`LIST_TIMEOUT_MS`=20s |
| `SRC_PURGE_DELETE_CHUNK` | `20` | chunk 並列。chunk ごとに deadline を確認して打ち切れる粒度 |
| `SRC_PURGE_MAX_FAILURE_ROWS` | `20` | 台帳の暴走防止(§3.3) |

**`listObjects` の bounded 化**(`lib/storage/r2.ts`・外部契約は不変):

```
listObjectsBounded(prefix, maxPages): Promise<{ keys: string[]; truncated: boolean }>   // 新 export
listObjects(prefix): Promise<string[]>   // 既存。bounded core に委譲し、truncated なら従来どおり throw
```

既存の throw 契約(`MAX_LIST_PAGES` 超過 / malformed / token 非前進 / `!res.ok`)は**完全に保持**する。
呼出元は `gc-src-prefix.ts` の 2 箇所のみ(§2.3 実測)で、両者とも既存 `listObjects` を使い続ける
= 挙動不変。**新旧 2 実装を作らない**(rule of three 以前に、同じ pagination を二重に書かない)。

purge 本体(`handle-clerk-event.ts` に private 関数 1 本。新 module は作らない):

1. `const deadline = Date.now() + SRC_PURGE_BUDGET_MS`
2. `const { keys, truncated } = await listObjectsBounded(\`src/${internalUserId}/\`, SRC_PURGE_MAX_LIST_PAGES)`
   - `truncated` なら台帳に打ち切り 1 行(`phase: 'list_truncated'`)を書いてから、取れた分の削除へ進む
3. `keys` を `SRC_PURGE_DELETE_CHUNK` ごとに `Promise.all(chunk.map(deleteObject))`。
   **各 chunk の開始前に `Date.now() > deadline` を確認**し、超過なら残件を打ち切って
   台帳 1 行(`phase: 'deadline'` + `remaining`)。
4. **全体を try/catch で包む**。`listObjectsBounded` は throw しうる(§2.3)ので listing 失敗も
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
- **粒度 = 失敗 1 件 = 1 行**(OT 裁定・既存 `r2_source_delete` / `r2_gc_delete` と同形)。
  集約案は不採用 — 「1 行 = 1 失敗」を前提にする §3 の集計・alert 設計を壊さないため。
- context = `{ userId, objectKey, status }`(単体 DELETE 失敗)。
  **key 以外の PII は入れない**(context は Discord へもそのまま出る)。
- **暴走防止の上限 = 1 回の退会で `SRC_PURGE_MAX_FAILURE_ROWS`(20)行まで**。
  20 行目は**打ち切り行**とし、context に `{ userId, truncated: true, remainingFailures: N }` を持たせる
  (個別 objectKey は載せない)。
- 打ち切り系の行(いずれも 1 行・`phase` で区別):
  `phase: 'list'`(listing throw・`errorMessage` 付)/ `phase: 'list_truncated'`(page 上限到達)/
  `phase: 'deadline'`(時間切れ・`{ deleted, remaining }`)。

### 3.4 やらないこと

- migration / schema 変更 / 台帳行の新設 / `listObjects` の**外部契約**変更(bounded core の
  切り出しは行うが、既存 signature・throw 契約・呼出元の挙動はすべて不変)
- 退会 prefix purge の retry ループ(取り漏らしの受け皿は §3 sweeper / lifecycle)
- **1 回の purge で完結する仮定を置かない**: 退会と同時に飛行中だった presigned PUT は
  purge の後に着地しうる(presigned URL は失効まで有効)。§7 に限界として記録。

## 4. 不変条件

1. **退会処理は R2 の失敗で失敗しない**: D は throw しない契約(try/catch で全て飲む)。
2. **D は DB scrub の成否に依存しない**(C の後ろ・`runTransactionWithRetry` は return する)。
3. prefix は `src/{internalUserId}/`(末尾スラッシュ)。他 prefix・他 user を触らない。
4. DB 呼出を増やさない(既存 Group I 不変条件 test の件数 pin を動かさない)。
5. **purge は有限時間で必ず終わる**: listing は page 上限、DELETE は chunk ごとの deadline 判定で
   打ち切る。打ち切りは必ず台帳 1 行として可視化する(silent truncation 禁止)。
6. `listObjects` の既存呼出元(`gc-src-prefix.ts` × 2)の挙動を変えない。

## 5. テスト(実装 task が TDD で書く)

`app/api/webhooks/clerk/route.test.ts`(既存 harness の r2 mock 追加)または
`lib/clerk/handle-clerk-event` 単体で:

- 退会成功時に `listObjects('src/{internalUserId}/')` が **末尾スラッシュ付き**で呼ばれる
- 返った key 全件に `deleteObject` が呼ばれる(pagination 済みの配列をそのまま消費)
- `deleteObject` 失敗 → 台帳が `r2_deletion_src_delete` で呼ばれる / 成功のみなら台帳不呼出
- `listObjectsBounded` throw → 台帳 1 行(`phase='list'`)+ **handleEvent は throw しない**
- **DB tx が失敗(recordFailure 経路)しても D は実行される**(不変条件 2 の pin)
- userId 未解決(bootstrap 0 行)の early return では listing **不呼出**
- **上限系(不変条件 5)**:
  - listing が `truncated: true` → `phase='list_truncated'` 行 + 取れた分の DELETE は実行される
  - 失敗が 21 件以上 → 台帳行は **20 行ちょうど**で、20 行目に `truncated: true` と `remainingFailures`
  - deadline 超過 → 残 chunk が `deleteObject` されず `phase='deadline'` 行が出る
    (時間は注入可能にする — 実時間 sleep に依存する test を書かない)
- **`lib/storage/r2.test.ts`**: `listObjectsBounded` が maxPages 到達で **throw せず**
  `{ truncated: true }` を返す / 既存 `listObjects` は同条件で**従来どおり throw**(契約不変の pin)
- 既存 pin の回帰なし(Group I 集合 / update×1・delete×10 の件数 pin / 200 返却 /
  `gc-src-prefix` の listing 挙動)

## 6. 変更一覧

| file | 変更 |
|---|---|
| `lib/storage/r2.ts` | `listObjectsBounded` を切り出して export。`listObjects` は委譲(契約不変) |
| `lib/storage/r2.test.ts` | bounded の truncated 契約 + 既存 throw 契約の pin |
| `lib/clerk/handle-clerk-event.ts` | 定数 4 + private 関数 1 本 + C の後の呼出 1 行 + import |
| `lib/integration-failures.ts` | catalog に `r2_deletion_src_delete` 追加 |
| `lib/integration-failures.test.ts` | 件数 pin 12→13 + 4 軸 pin 1 本 |
| `app/api/webhooks/clerk/route.test.ts`(or 単体) | §5 の pin |
| `docs/architecture.md` | source 行の DELETE 経路列挙に退会 prefix purge を追記 |

migration / env なし。

## 7. 限界(受容・記録)

- 退会と同時に飛行中だった PUT の後着地(presigned URL は失効まで有効)
- listing / DELETE の失敗分・上限打ち切り分(いずれも台帳に残る・retry しない)

### 7.1 なぜ src/ と assets で機構を揃えないのか(OT 裁定 2026-08-09・**統合を試みる変更への予防線**)

本 spec 後も **画像 asset の R2 実体は OT 手動 GC まで残る**(assets は `'deleting'` 行を残して委譲)。
一方 `src/` は退会時に即時 purge する。この非対称は**レーンの性質に従った正しい形**であり、
「揃っていないから統合する」は誤り:

| | `assets`(画像) | `src/`(OCR 原本 PDF) |
|---|---|---|
| 削除意図の記録 | **ある**(`status='deleting'` 行が durable に残る) | **無い**(`source_assets` 表は存在しない・key 規約でしか辿れない) |
| 参照権限 | `'deleting'` 遷移の瞬間に失効(取得経路が `ready` を要求) | 元から短命 staging |
| 実体残存の意味 | 容量問題に留まる | **著作物の疑いのある source の保持**(architecture.md §6 の非保持が設計不変条件) |
| ゆえの要件 | 遅延してよい(記録があるので後から必ず辿れる) | **即時性が要る**(記録が無く、その場で消すか時間駆動に頼るかしかない) |

原理: **記録がある側は遅延してよく、記録がない側は即時性が要る**(v58「判定原理はレーンの性質に
従わせる」)。将来この 2 レーンを「一貫性のため」1 つの機構へ統合する変更は、この非対称の理由を
読み落としている — 統合するなら先に `src/` 側へ durable な削除意図の記録を導入する必要がある。

### 7.2 scope 外(別 sprint)

assets レーン側の残課題 — 退会後の R2 実体が OT 手動 script まで残る / backstop 不在 /
退会由来の grace 30 日の要否 — は **②-4b の scope 外**。close 後の「asset レーン整合 sprint」で
扱うことが OT 決定済み(2026-08-09)。**本 spec では解かない。**

## 8. stg smoke(OT push 後)

**退会は破壊操作かつ不可逆**。以下を厳守する:

- **専用の使い捨て test account を新規作成して行う**。既存 smoke アカウントは使わない。
- **理由(具体的な事故リスク)**: 現在 `src/` にある lifecycle 観測 sentinel 2 本
  (`55b4316c…` / `f4f91e6d…`)は **user `85541b25…`(既存 smoke アカウント)の prefix 配下**にある。
  このアカウントで退会 smoke を実行すると **sentinel を巻き込んで削除する**(8/11 まで不可触の制約に違反)。
### 8.1 手順(sentinel 保護を目視の約束でなく手順にする)

1. **CC: sentinel の prefix を listing で記録する** — `src/` を listing し、現存する
   sentinel 2 本の `userId` セグメントを控える(現状 `85541b25…`)。
2. **CC: 新 test account を作成**し、その **内部 userId(uuid)を取得**する
   (`.env.local` の `DATABASE_URL_APP` で `users` を引ける — [[reference_stg_db_readback]])。
3. **CC: gate — 手順 2 の userId が手順 1 で控えた sentinel の userId と一致しないことを
   明示的に verify する。一致したら smoke を中止**(sentinel を巻き込む事故の直前で止める)。
   この照合を通すまで退会操作を OT に依頼しない。
4. CC: その account で PDF を数冊 staging(**submit しない**)→ `src/{testUserId}/` の件数 n を記録。
5. **OT: Clerk dashboard から当該 account を退会**(破壊操作ゆえ OT)。
6. CC: `src/{testUserId}/` が **0 件**になることを確認。
7. CC: **sentinel 2 本が lastModified 込みで不変**であることを確認(§1 smoke と同じ確認手法)。

### 8.2 その他

- 台帳確認(`service='r2'` かつ `workflow='user_deletion'` の行が無いこと)は OT 照会(SELECT 42501)。
- 上限打ち切り(`phase='list_truncated'` / `'deadline'`)の実機再現は行わない — 実運用規模では
  到達しないため。検出力は §5 の unit(時間注入 + mock)で担保する。

## 9. 論点の裁定(OT・2026-08-09・**確定**)

| # | 論点 | 裁定 |
|---|---|---|
| 1 | 退会 handler 内で直接 R2 を触るか / §3 へ全面委譲か | **直接触る(本 spec の方針)で承認**。理由 = §7.1 の非対称(記録がある側は遅延してよく、記録がない側は即時性が要る)。brief の「assets と同じ分離を踏襲」は不正確として訂正され、**assets と同形にしないこと自体が裁定**。追加要件として上限を必須化(§3.2) |
| 2 | 台帳の粒度(集約 / 1 件 1 行) | **1 件 1 行(既存規律)を採用**。集約は §3 の集計・alert 設計を壊すため不採用。暴走防止は 20 行上限 + 打ち切り行で担保(§3.3) |
| 3 | smoke の test account | **専用の使い捨て account 必須で確定**。加えて sentinel 巻き込み防止を**手順として** §8.1 に組み込む(手順 1-3 の userId 照合 gate) |

以後この 3 点は再論しない。spec 凍結。
