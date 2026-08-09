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

- ⚠ **r2 までの記述「`runTransactionWithRetry` は永続失敗でも throw せず return するので、後ろに
  置いたコードは必ず走る」は誤り**(OT 指摘・r3 で撤回)。確かに正常系では return する(:365-367)が、
  その直前の **`await onFailure(...)`(:365)は `recordFailure` → `recordIntegrationFailure` を呼び、
  同 helper は `notifyOps` の throw(production で `OPS_DISCORD_WEBHOOK_URL` 未設定時の fail-fast)を
  意図的に伝播させる契約**(`lib/integration-failures.ts:139-141`)。よって **C は throw しうる**。
  → **後置(C の直後に書く)では到達保証にならない。到達保証は §3.1 の外周 `finally` で構造的に作る。**
  (現物確認が 1 段浅かった例。経緯は close 時の session doc に記録する)
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

### 3.1 配置 — **外周 `finally`**(到達保証を構造で作る)

```
A resolve(internalUserId 確定)
  try {
    B Stripe cancel ループ
    C DB tx(scrub / Group I 削除 / assets deleting)
  } finally {
    D 退会 prefix purge(新設)
  }
```

- **`finally` を使う理由**: §2.1 のとおり B / C はいずれも throw しうる(`recordIntegrationFailure`
  が `notifyOps` の production throw を伝播する)。後置では「今この瞬間 throw する site が無い」
  ことに依存し、将来 record site が増えるたびに全 site を監査し続ける保証になる —
  **単一点主張が無言で偽になる型**。`finally` は構造保証で、②-4b 本線の
  `runUploadPipeline` 出口 DELETE(§0 で stg 実測済)と同型。
- **採らない案 = 各 record site の個別隔離**: 上記の監査依存ゆえ不採用(OT 裁定)。
- **A の早期 return(`internalUserId` 未解決)は try の外**に置く — prefix を導出できず purge 不能。
  受け皿は §3 sweeper / lifecycle(§7 に受容として記載)。
- **purge は `finally` 内から throw しない**(§4-1)。`finally` での throw は元の例外を握り潰し
  route の outer catch を汚すため、never-throw 契約が構造的に必須になる。

### 3.2 処理と予算(OT 追加要件: 上限を設けて打ち切る)

`maxDuration: 60` の同期実行(§2.1)ゆえ、purge が退会 handler を圧迫してはならない。
**listing・DELETE の両方に上限を設け、超過分は打ち切って台帳に記録**する(受け皿は §3 / lifecycle)。

#### 予算の原点(OT 裁定・r3)

**一般則: 予算は、それが守るべき境界と同じ原点から測る。** 守る対象は route 全体の
`maxDuration: 60` なので、原点は **`POST()` の冒頭**でなければならない — purge 開始からの
相対予算では、先行処理(body 読出し / Svix 検証 / dedup INSERT / Stripe ループ / DB tx)が
何秒使ったかを一切考慮できず「全体を圧迫しない」を保証できない(発火しない位置に予算チェックを
置くのと同型の罠)。

- `app/api/webhooks/clerk/route.ts` の `POST()` 冒頭で `handlerStart = Date.now()` を取り、
  **`handleEvent(evt, handlerStart)` → `handleUserDeleted(clerkUserId, handlerStart)` と引数で伝播**。
  引数は **必須**(optional + 既定値にしない — 渡し忘れが silent に誤った原点になるのを型で防ぐ)。
- `purgeDeadline = min(purgeStart + SRC_PURGE_BUDGET_MS, handlerStart + HANDLER_BUDGET_MS)`

| 定数 | 値 | 根拠 |
|---|---|---|
| `HANDLER_BUDGET_MS` | `50_000` | route の `maxDuration: 60` に 10s の余裕。予算の原点は `POST()` 冒頭 |
| `SRC_PURGE_BUDGET_MS` | `20_000` | purge 単体の上限(handler 予算との `min` を取る) |
| `SRC_PURGE_MAX_LIST_PAGES` | `2` | 1 page ≈ 最大 1000 key。実運用の staging 数本を桁で上回る |
| `SRC_PURGE_DELETE_CHUNK` | `20` | chunk 並列。chunk ごとに deadline を確認して打ち切れる粒度 |
| `SRC_PURGE_MIN_SLICE_MS` | `2_000` | floor。残予算がこれ未満なら I/O を開始せず打ち切る |
| `SRC_PURGE_TAIL_RESERVE_MS` | `4_000` | 最終 incomplete 行を書くために作業 deadline から先取りする分 |
| `SRC_PURGE_MAX_FAILURE_ROWS` | `20` | 台帳の暴走防止(§3.3) |

#### in-flight I/O への残予算の配分(OT 裁定・r3)

**LIST 各ページ / DELETE 各 chunk に `min(既定 timeout, 残予算)` を timeout として渡す。**
「残予算 ≥ 最大所要のときだけ開始する」gate 方式は、最大 10s 分の予算を未使用で捨てるため不採用。

- 作業 deadline = `purgeDeadline - SRC_PURGE_TAIL_RESERVE_MS`(打ち切りの事実そのものを
  書けない事態を避けるための先取り)。
- 残予算 < `SRC_PURGE_MIN_SLICE_MS` なら当該 I/O を**開始せず** deadline 打ち切り扱い。
- これに伴い **`listObjectsBounded` / `deleteObject` は timeout を上書きできる必要がある**
  (§3.2 末尾の API 変更点を参照)。

**`listObjects` の bounded 化**(`lib/storage/r2.ts`・外部契約は不変):

```
listObjectsBounded(
  prefix: string,
  maxPages: number,
  opts?: { timeoutMs?: number },              // 残予算を渡す口(既定 = LIST_TIMEOUT_MS)
): Promise<{ keys: string[]; truncated: boolean }>   // 新 export
listObjects(prefix): Promise<string[]>   // 既存。bounded core に委譲し、truncated なら従来どおり throw
```

- `maxPages` は **正の整数以外を fail-fast で reject**(`0` / 負数 / 非整数 / `NaN` / `Infinity`)。
  数値引数を public にする以上、型だけでは不正入力を防げない。
- `deleteObject(key, opts?: { timeoutMs?: number })` も同様に timeout 上書きを受ける
  (既定 = `DELETE_TIMEOUT_MS`。既存呼出 3 箇所は無改変で既定を使う)。`getObject` に
  同型の `{ timeoutMs }` が既にある(`finalize-pdf-source.ts` が使用)ので、その idiom に倣う。

既存の throw 契約(`MAX_LIST_PAGES` 超過 / malformed / token 非前進 / `!res.ok`)は**完全に保持**する。
呼出元は `gc-src-prefix.ts` の 2 箇所のみ(§2.3 実測)で、両者とも既存 `listObjects` を使い続ける
= 挙動不変。**新旧 2 実装を作らない**(rule of three 以前に、同じ pagination を二重に書かない)。

purge 本体(`handle-clerk-event.ts`。時刻注入のため **named export**(§5)。新 module は作らない):

1. `purgeDeadline` を算出(上記)/ `workDeadline = purgeDeadline - SRC_PURGE_TAIL_RESERVE_MS`
2. `listObjectsBounded(\`src/${internalUserId}/\`, SRC_PURGE_MAX_LIST_PAGES, { timeoutMs: 残予算 })`
   - `truncated` なら `phase: 'list_truncated'` を **incomplete entry**(§3.3)へ 1 行、
     そのうえで取れた分の削除へ進む(観測の失敗が削除を止めない・§4-7)
3. `keys` を `SRC_PURGE_DELETE_CHUNK` ごとに `Promise.all(chunk.map((k) => deleteObject(k, { timeoutMs: 残予算 })))`
   - **各 chunk の開始前**に残予算を評価し、`< SRC_PURGE_MIN_SLICE_MS` なら残件を打ち切り
   - **DELETE 直前に key の prefix を再検証**(下記)
4. 打ち切りが起きた場合、tail reserve の中で **incomplete 行を 1 行**書く
   (`phase: 'deadline'` + `{ deleteRequested, remaining }`)。reserve 内でも書けなければ skip
   (platform kill による喪失と等価・best-effort として受容)
5. **全体を try/catch で包む**うえに、**各記帳呼出も個別に try/catch**(§4-7)。
   `listObjectsBounded` の throw は `phase: 'list'` + `errorMessage` 1 行にして飲む。
   **この関数は throw しない契約**。

**破壊境界の二重関門**(Codex 採用): prefix は `src/{internalUserId}/` の**末尾スラッシュ必須**
(`src/{uid}` だと別 uuid の前方一致を拾いうる)。加えて **listing 応答を全面的には信用せず、
DELETE 直前に各 key が当該 prefix で始まることを検証**し、不一致 key は**削除せず** loud に記録する。
先例 = `scripts/gc-src-prefix.ts:38-47`(「listing の prefix 引数だけに頼らない二重の関門」)。

**用語の固定**(誤読防止・Codex 採用): `deleteRequested` = `deleteObject` 呼出数
(404 は success-equivalent ゆえ「実削除数」ではない)/ `remaining` = **未試行** key 数。
本処理の成功は「prefix が空になったこと」ではなく「**列挙済み key への削除要求が完了したこと**」
(readback しないため・§7)。

### 3.3 失敗記録 — catalog 新 entry **2 つ**(OT 裁定・r3)

**原則: 4 軸は「原因」ではなく「結果」を識別する。原因は `context.phase` が持つ。**
1 行 = 1 object DELETE 失敗、という集計前提(OT 裁定 2 の目的)を守るため、
**制御系(purge が完遂しなかった事実)を別 entry に分離**する。

```
r2_deletion_src_delete: {           // 結果 = 個々の object DELETE が失敗した
  service: 'r2',
  operation: 'object.delete',
  workflow: 'user_deletion',
  failureCode: 'external_api_error',
}
r2_deletion_src_incomplete: {       // 結果 = purge が列挙/削除を完遂しなかった
  service: 'r2',
  operation: 'src_purge.incomplete',
  workflow: 'user_deletion',
  failureCode: 'incomplete',        // 新設(既存 4 語彙に適合値なし・下記)
}
```

- **`failureCode: 'incomplete'` は新設**。既存語彙は `external_api_error` / `state_mismatch` /
  `db_error` / `unexpected_error` の 4 種(実測)で、いずれも「予算内に収まらず打ち切った」を
  表さない。特に **`external_api_error` を使うと deadline 打ち切りが R2 障害として集計される** ため
  不可(§5 で pin する)。`failure_code` は `text` 列で enum 制約なし = migration 不要。
- 4 軸一意性: 既存 `user_deletion` は `stripe/subscription.cancel` `stripe/subscription.list`
  `db/user.data.delete` の 3 種。`r2/object.delete` も `r2/src_purge.incomplete` も未使用 → 両方一意。
- 他の `r2/object.delete` とは **workflow で区別**: `asset_gc` / `upload_single_invocation` /
  `upload_staging`(§1)/ **`user_deletion`(本 spec)**。相乗り禁止(`lib/integration-failures.ts:16-17`)。

**`r2_deletion_src_delete`(1 件 = 1 行)**
- context = `{ userId, objectKey, status }`。**key 以外の PII は入れない**(Discord へも出る)。
  `clerkId` は渡さない(データ最小化。ゆえに purge helper は `clerkUserId` を引数に取らない)。
- `subject` = `'user deletion: source PDF delete failed'`。
- `status: null`(fetch throw / timeout)には `errorMessage` が無いので**設定しない**
  (`deleteObject` は never-throw で例外を返さないため。status が null であること自体が情報)。
- **在庫上限 = `SRC_PURGE_MAX_FAILURE_ROWS`(20)行**。厳密規則:
  - 失敗が **20 件以下**: そのまま 1 件 1 行(打ち切り行は書かない)
  - 失敗が **21 件以上**: 個別行は **19 行**まで。残りは incomplete 行 1 本に畳み、
    `context.suppressedFailures = 失敗総数 - 19`(= 書かなかった件数。20 件目を含む)
  - **残予算が尽きたら個別行の書き込みを止め**、書けなかった件数を同じ counter に足す

**`r2_deletion_src_incomplete`(1 回の退会につき最大 1 行)**
- `phase` = `'list'`(listing throw・`errorMessage` 付)/ `'list_truncated'`(page 上限到達)/
  `'deadline'`(時間切れ)/ `'no_budget'`(開始時点で残予算 < floor)。
  **複数該当時の優先順位 = `list` > `no_budget` > `list_truncated` > `deadline`**(より早い段階で
  諦めた事実を残す)。行は 1 本に統合し、`suppressedFailures` もこの行に載せる。
- context = `{ userId, phase, deleteRequested, remaining, suppressedFailures }`(該当分のみ)。
- `subject` = `'user deletion: source prefix purge incomplete'`。
- **上限 20 行にはこの行も算入**(合計 20 行を超えない)。

### 3.4 やらないこと

- migration / schema 変更 / 台帳行の新設 / `listObjects` の**外部契約**変更(bounded core の
  切り出しは行うが、既存 signature・throw 契約・呼出元の挙動はすべて不変)
- 退会 prefix purge の retry ループ(取り漏らしの受け皿は §3 sweeper / lifecycle)
- **1 回の purge で完結する仮定を置かない**: 退会と同時に飛行中だった presigned PUT は
  purge の後に着地しうる(presigned URL は失効まで有効)。§7 に限界として記録。

## 4. 不変条件

1. **退会処理は R2 の失敗で失敗しない**: D は throw しない契約(try/catch で全て飲む)。
   `finally` 内から throw すると元の例外を握り潰すため、これは構造的に必須。
2. **D は B / C の成否に依存せず到達する** — 根拠は**外周 `finally`**(§3.1)。
   「後置だから走る」ではない(その根拠は §2.1 のとおり不成立)。
3. prefix は `src/{internalUserId}/`(末尾スラッシュ)。他 prefix・他 user を触らない。
4. DB 呼出を増やさない(既存 Group I 不変条件 test の件数 pin を動かさない)。
5. **purge は有限時間で必ず終わる**: 予算の原点は `POST()` 冒頭。in-flight I/O には
   `min(既定 timeout, 残予算)` を渡し、floor 未満なら開始しない。打ち切りは必ず台帳 1 行として
   可視化する(**silent truncation 禁止**)。
6. `listObjects` の既存呼出元(`gc-src-prefix.ts` × 2)/ `deleteObject` の既存呼出元(3 箇所)の
   挙動を変えない。
7. **観測(記帳)の失敗が削除の forward progress を止めない**: 各記帳呼出を個別に try/catch する。
   大域 catch だけでは「外へ throw しない」しか保証されず、`list_truncated` の記帳失敗で
   取得済み key の削除まで中断しうる。
8. **破壊境界の二重関門**: DELETE 直前に各 key が `src/{internalUserId}/` で始まることを検証し、
   不一致は削除せず記録する(listing 応答を全面的には信用しない)。

## 5. テスト(実装 task が TDD で書く)

**配置**: purge helper を **named export** し、時刻(`now`)を注入可能にして**直接 unit test** する
(private のままだと時刻注入が届かず、実 sleep 依存の test になる)。route 経由の配線は
`app/api/webhooks/clerk/route.test.ts` で 1 本だけ pin する。
**route.test に `@/lib/storage/r2` の mock 追加が必須**(`r2.ts` は module load 時に R2_* env を
fail-fast するため、mock hoisting を誤ると suite 全体が import 時に落ちる)。

- 退会成功時に `listObjects('src/{internalUserId}/')` が **末尾スラッシュ付き**で呼ばれる
- 返った key 全件に `deleteObject` が呼ばれる(pagination 済みの配列をそのまま消費)
- `deleteObject` 失敗 → 台帳が `r2_deletion_src_delete` で呼ばれる / 成功のみなら台帳不呼出
- `listObjectsBounded` throw → 台帳 1 行(`phase='list'`)+ **handleEvent は throw しない**
- **B / C が throw しても D は実行される**(不変条件 2 = `finally` の pin。
  `recordFailure` を throw させる変異で red を取る)
- userId 未解決(bootstrap 0 行)の early return では listing **不呼出**
- **上限系(不変条件 5)**:
  - listing が `truncated: true` → `phase='list_truncated'` 行 + 取れた分の DELETE は実行される
  - 失敗 20 件ちょうど → **個別 20 行のみ**(incomplete 行を書かない)
  - 失敗 21 件以上 → **個別 19 行 + incomplete 1 行**(計 20)で `suppressedFailures = 総数 - 19`
  - deadline 超過 → 残 chunk が `deleteObject` されず `phase='deadline'` 行が出る
  - `handlerStart` が古い(既に 50s 経過)→ purge が **listing すら開始せず** `phase='no_budget'`
  - LIST / DELETE に渡る `timeoutMs` が `min(既定, 残予算)` になっている
- **4 軸の意味(裁定 4)**: deadline 打ち切りが `failureCode='external_api_error'` で
  記録**されない**(= R2 障害として集計されない)ことを pin
- **不変条件 7**: `list_truncated` の記帳が throw しても、取得済み key の DELETE は実行される /
  個別記帳が throw しても後続 key の DELETE は続く
- **不変条件 8**: listing が prefix 外の key を返した場合、その key は `deleteObject` **されず**記録される
- **`lib/storage/r2.test.ts`**: `listObjectsBounded` が maxPages 到達で **throw せず**
  `{ truncated: true }` を返す / 既存 `listObjects` は同条件で**従来どおり throw**、
  かつ **error 文言が従来と同一**(既存 test が regex で pin している。文言互換の明示 pin を足す)/
  `maxPages` の不正値(`0` / `-1` / `1.5` / `NaN` / `Infinity`)を fail-fast reject /
  境界 `maxPages=1` × IsTruncated true/false で `truncated` が正しく出る /
  `timeoutMs` 上書きが `AbortSignal.timeout` に反映される(`deleteObject` も同様)
- 既存 pin の回帰なし(Group I 集合 / update×1・delete×10 の件数 pin / 200 返却 /
  `gc-src-prefix` の listing 挙動)

## 6. 変更一覧

| file | 変更 |
|---|---|
| `lib/storage/r2.ts` | `listObjectsBounded` を切り出して export(+ `maxPages` fail-fast / `timeoutMs`)。`listObjects` は委譲(契約不変)。`deleteObject` に `{ timeoutMs }` 追加 |
| `lib/storage/r2.test.ts` | bounded の truncated / 引数境界 / timeout 上書き + 既存 throw 文言の互換 pin |
| `app/api/webhooks/clerk/route.ts` | `POST()` 冒頭で `handlerStart` 取得 → `handleEvent(evt, handlerStart)` |
| `lib/clerk/handle-clerk-event.ts` | 定数 7 + purge helper(named export)+ **外周 try/finally** + `handlerStart` の引数伝播(`handleEvent` / `handleUserDeleted` は**必須引数**) |
| `lib/integration-failures.ts` | catalog に **2 entry** 追加(`r2_deletion_src_delete` / `r2_deletion_src_incomplete`・§3.3) |
| `lib/integration-failures.test.ts` | 件数 pin **12→14** + 4 軸 pin **2 本** |
| `app/api/webhooks/clerk/route.test.ts`(or 単体) | §5 の pin |
| `docs/architecture.md` | source 行の DELETE 経路列挙に退会 prefix purge を追記 |

migration / env なし。

## 7. 限界(受容・記録)

- 退会と同時に飛行中だった PUT の後着地(presigned URL は失効まで有効)
- **listing は snapshot ではない**(ListObjectsV2 は transaction 的一貫性を持たない):
  pagination の途中、あるいは LIST 後 DELETE 前に PUT された object は取り漏らす。
  即時 purge は「**その時点で観測できた集合への best-effort**」である。
- listing / DELETE の失敗分・上限打ち切り分(いずれも台帳に残る・retry しない)
- `internalUserId` 未解決(bootstrap 0 行)の退会は prefix を導出できず purge 不能
- **readback しないため「prefix が空」は保証しない**。本処理が主張するのは
  「列挙済み key への削除要求が完了した」まで(§3.2 の用語固定)。

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

### 8.3 手順 6 が 0 件にならなかった場合の切り分け(smoke を「実装不良」と即断しない)

`src/{testUserId}/` が 0 件でないとき、原因は 3 通りありうる。次の順で切り分ける:

1. **後着地 PUT**(§7): 残 object の `LastModified` が**退会実行時刻より後**か。後なら
   snapshot 非一貫性による取り漏らしで、設計どおり(受け皿 = §3 / lifecycle)。
2. **R2 一時障害 / 打ち切り**: 台帳(OT 照会)に `r2_deletion_src_delete` または
   `r2_deletion_src_incomplete` の行があるか。あれば purge は動いており R2 側 or 予算の問題。
3. **実装不良**: 上記いずれでもない(退会前から在る object が残り、台帳も無い)場合のみ。
   このときだけ実装を疑い、stop して報告する。

いずれの場合も **sentinel 2 本には触れず**、残 object は lifecycle 待ちに回す(手動削除しない —
§3 sweeper の実測材料として残す価値があるため)。

## 9. 論点の裁定(OT・2026-08-09・**確定**)

| # | 論点 | 裁定 |
|---|---|---|
| 1 | 退会 handler 内で直接 R2 を触るか / §3 へ全面委譲か | **直接触る(本 spec の方針)で承認**。理由 = §7.1 の非対称(記録がある側は遅延してよく、記録がない側は即時性が要る)。brief の「assets と同じ分離を踏襲」は不正確として訂正され、**assets と同形にしないこと自体が裁定**。追加要件として上限を必須化(§3.2) |
| 2 | 台帳の粒度(集約 / 1 件 1 行) | **1 件 1 行(既存規律)を採用**。集約は §3 の集計・alert 設計を壊すため不採用。暴走防止は 20 行上限 + 打ち切り行で担保(§3.3) |
| 3 | smoke の test account | **専用の使い捨て account 必須で確定**。加えて sentinel 巻き込み防止を**手順として** §8.1 に組み込む(手順 1-3 の userId 照合 gate) |

### 9.1 Codex cross-check 追補の裁定(OT・2026-08-09・r3 で反映済)

| # | 内容 | 裁定 |
|---|---|---|
| 4 | 予算の原点 | **`POST()` 冒頭**から測る(引数で伝播)。一般則「予算は守るべき境界と同じ原点から測る」を §3.2 に明記 |
| 5 | in-flight I/O と記帳の残予算 | **`min(既定 timeout, 残予算)` を渡す**方式(gate 方式は予算を捨てるため不採用)+ floor 2s + tail reserve 4s。`recordIntegrationFailure` への新規 timeout 配管はしない |
| 6 | purge 到達保証 | **外周 `finally`**(構造保証)。個別 record site の隔離は「全 site を監査し続ける」保証ゆえ不採用。**r2 の根拠(後置で必ず走る)は現物で不成立と判明したため撤回**(§2.1) |
| 7 | incomplete entry の 4 軸 | **別 entry に分離**。`operation='src_purge.incomplete'` / `failureCode='incomplete'`(新設)。**4 軸は原因でなく結果を識別し、原因は `context.phase` が持つ** |

以後この 7 点は再論しない。**spec 凍結**(cross-check は 1 回で終了・追加 round は行わない)。
