# asset レーン整合 sprint — fact-finding(read-only・2026-08-10)

> **read-only 調査**。実装変更・commit(本 doc 以外)・DB 書込・R2 破壊操作は一切していない。
> 実行したのは `SELECT` のみ(stg・app role)と R2 の `ListObjectsV2` のみ。
> 前提(②-4b close / 2 レーン契約 = `docs/architecture.md` §11)は brief のとおりで、本書は差分と反証のみ書く。

**結論を 2 行で**: 項目 1 は「owner が要るのは**権限でなく行スコープ**」— app role 化は可能だが **user 列挙の手段を新設**しないと成立しない(3 択・OT 判断)。項目 3 は **brief の前提が誤り** —「`assets` 行が無い = 消してよい」は**現物では成立しない**(行より先に R2 object が置かれる正規経路が実在)。よって brief の停止条件 2 件のうち **項目 3 に該当**し、設計前に OT 判断を要する。

---

## 0. 実測データ(stg `recallmint-dev` / 2026-08-10)

`DATABASE_URL_ADMIN` は `.env.local` で**空文字**(`len=0`)。ゆえに全 user 集計は不能で、R2 listing で判明した 3 user に個別 tenant context を張って測った。

| user | R2 object | `assets` 行 | status | zero-ref | `unreferenced_at` セット済 |
|---|---|---|---|---|---|
| `85541b25-…4dae3` | 234 | 234 | 全 `ready` | **202** | **0** |
| `b775b3f1-…6cddf` | 6 | 6 | — | — | — |
| `2ac594a5-…bb54c26` | 2 | 2 | 全 `deleting` | 2 | 0 |
| 合計 | **242** | — | | | |

- **zero-ref の実数 = 202 + 2 = 204 以上**。brief の「現状 68 件 zero-ref」は**現物と合わない**(出典が repo 内に無い。claude.ai 側の別時点の値と思われる)。sprint の見積りは 204 を基準にすること。
- **`unreferenced_at` が 1 件も立っていない** = mark run が一度も本実行されていない(2026-07-16 の smoke④ は `--user` scope の 4 件のみ)。ゆえに現状は「mark 済で grace 待ち」ではなく「**mark 前**」。cron 初回 run は 204 件を一斉に mark する(promote は 30 日後)。
- zero-ref 204 件の `created_at` 分布: 07-21:1 / 07-24:3 / 08-02:16 / 08-04:9 / **08-05:80 / 08-06:60 / 08-07:31** / 08-08:2。②-4a〜②-4b の smoke で作られた crop 図版が主。
- **row-less orphan(R2 にあるが `assets` 行が無い object)は 242 件中 0 件**(3 user 全数を object_key 単位で突合)。逆向き(行はあるが object が無い)も 0 件。

> **`docs/ops/r2-key-inventory.md:53` の訂正**: 「照合には reconciler の `--dry-run` が出力する backfill-divergence が該当」は**誤り**。`countRefDivergence`(`scripts/gc-image-assets.ts:728-752`)は `cards.images` の UUID key 数 vs `card_asset_refs` 行数という **DB 内 2 者の比較**で、R2 を一切見ない。reconciler は `listObjects*` を import すらしない(`:52-66` の import 一覧・`deleteObject` のみ dynamic import)。→ 本書 §3 で詳述。

---

## 1. reconciler の owner 依存の実態

### 事実: owner が要る理由は **RLS の行スコープ 1 点のみ**。権限(DDL / grant 外表)由来の依存はゼロ。

reconciler が触る表は `assets` / `card_asset_refs` / `cards` / `integration_failures` の 4 つだけで、app role は前 3 者に **SELECT/INSERT/UPDATE/DELETE をすべて保持**している(実測):

```
assets               | DELETE,INSERT,SELECT,UPDATE
card_asset_refs      | DELETE,INSERT,SELECT,UPDATE
cards                | DELETE,INSERT,SELECT,UPDATE
integration_failures | INSERT
```
根拠 = `db/roles/recallmint_app-grants.sql:4`(blanket GRANT)+ `db/roles/recallmint_app-grants-phase3.sql:52-56`(REVOKE 対象に `assets` / `card_asset_refs` / `cards` は**含まれない**)。台帳書込は INSERT のみで足りる(`lib/integration-failures.ts:262` が `getNonTenantDb()` を選ぶ)。

DDL は 1 つも無い。`main()` の deps は全部 DML(`scripts/gc-image-assets.ts:565-753`)。

### 事実: 阻んでいるのは RLS。app role は **tenant context 無しでは `assets` を 1 行も読めない**(実測)

```
$ psql "$DATABASE_URL_APP" -c "SELECT count(*) FROM assets;"
ERROR:  tenant context (app.user_id) is not set
CONTEXT:  PL/pgSQL function app_current_user_id() line 6 at RAISE
```
`assets_tenant` は `FOR ALL … USING (user_id = (SELECT public.app_current_user_id()))`(`db/policies/rls-p3-wave2-enable.sql:37-41`)、`card_asset_refs_tenant` も同型(`db/policies/rls-p3-wave1-enable.sql:65-69`)、`cards_tenant` も同型(`db/policies/rls-p2-enable.sql:25-29`)。`app_current_user_id()` は GUC 未設定で P0RLS を RAISE する(`drizzle/migrations/0025_rls_p2_functions.sql:11-22`)。

### 事実: app role で「user 横断の走査」を表現する手段は現状 **存在しない**

- `withTenantTx(userId, fn)` は userId を**受け取る側**(`lib/db/tenant-tx.ts:29-37`)。走査対象の userId 集合をどこから得るかは解いていない。
- `users` の SELECT policy は `id = app_current_user_id() AND deleted_at IS NULL`(`db/policies/rls-p2-enable.sql:46-47`)。自分 1 行しか見えず、**しかも退会済 user は自分でも見えない**。
- SECURITY DEFINER は 3 本のみで、いずれも user 列挙をしない(`0025_rls_p2_functions.sql:29`/`:44`/`:74`)。
- 非 RLS 5 表に user 一覧は無い: `clerk_events` は `event_id/type/processed_at` のみ(`lib/db/schema.ts:206-212`)、`ai_usage` は `date/count` のみ(`:173-176`)、`stripe_events` も同型、`integration_failures` は SELECT 自体 revoke 済、`contact_messages` は問い合わせ者のみ。

### 代替案は 3 つ。**どれも設計判断を伴う**(OT 判断が要る)

| 案 | 何を足すか | 得るもの | 失うもの / リスク |
|---|---|---|---|
| **(a) SECURITY DEFINER を 1 本追加** — 例 `app_list_asset_gc_users(limit int) RETURNS SETOF uuid` = GC 作業のある user_id だけ返す | migration 1 本 + GRANT EXECUTE | **行駆動のまま**・走査量 O(作業量)・退会済 user も拾える・`assets` の `(user_id,status)` index に素直に乗る | architecture §3 の「SECURITY DEFINER 3 関数は RLS 迂回が必須な特殊経路のみ」を 4 本目で緩める。関数内で `assets` 全体を読むため**実質 owner 相当の読取窓を 1 つ開ける**(引数は件数のみ = 露出面は user_id 集合に限定できる) |
| **(b) R2 `users/` listing から userId を導出**(`src/` sweeper と同 idiom・`lib/storage/src-sweep.ts:63-75`) | 新 DB object ゼロ | 既存 idiom の再利用・row-less orphan の検出が**同じ listing で同時に取れる** | ① 走査量が **O(全 object)**。`src/` は ephemeral(現在 0 件)だが asset は長命で、現在 242・将来数万〜。`SWEEP_MAX_LIST_PAGES=10` = 10,000 key 上限(`src-sweep.ts:166`)を恒常的に超える設計になる ② **R2 に object が残っていない user の行を永久に拾えない**(`deleted` crash marker 行・R2 削除成功後に行 DELETE が失敗した行 = `rowDeleteFailures` の対象がまさにこれ)③ 契約上「asset は行駆動」を、入口だけとはいえ listing 駆動に寄せる |
| **(c) cron route に owner 接続を持たせる**(`DATABASE_URL_ADMIN` を Vercel runtime env に投入) | env 追加のみ・**コード変更ほぼゼロ** | 既存 `runReconciler` をそのまま cron から呼べる | **RLS-P1 の封じ込め(app runtime = 最小権限)を正面から壊す**。`getAdminDb` は lint ban の対象外(ban は `getDb` のみ・`eslint.config.mjs:262-300`)なので**機械的に止まらない**。architecture §9「owner 経路 = script 専用」に反する |

### sprint 設計への含意

- 「app role 化が不可能」ではない。**(a) か (b) を選ぶ設計判断が未決**というのが正確な状態。CC の推奨は **(a)**: 契約(行駆動)を保ち、走査量が作業量に比例し、②-4b で確立した「判定原理はレーンの性質に従わせる」(§11)を破らない。ただし SECURITY DEFINER の追加は architecture §3 に触るので **OT 承認事項**。
- **(c) は採らないことを推奨**(RLS-P1 の設計意図を無効化する)。
- `runReconciler` の core(`scripts/gc-image-assets.ts:229-412`)は **userId を知らない**(deps が自分で scope する)。ゆえに **「1 user ぶんの deps を束ねて runReconciler を N 回呼ぶ」形にすれば core は無改造で再利用できる**。`--user` scope が既に全 SQL に注入されている(`:545` `userScope` / 各 deps の `userId ? eq(...) : undefined`)ため、per-user deps は「常に userId あり」に固定するだけ。summary は N 本を集約する薄い層が要る。

---

## 2. cron lane として載せる際の形

### 事実: cron は引数を持てない — が、4 flag は**すべて定数に潰れる**

| flag | 実装 | cron 実行時 |
|---|---|---|
| `--sweep` | `argv.includes` (`:533`) | **常に true**(mark だけ回しても回収されない) |
| `--dry-run` | `argv.includes` (`:534`) | **常に false**。dry-run は operator の観測手段(`:265` の guard 免除もこれ前提)で cron には不要 |
| `--user` | `parseUserFlag` (`:479-487`) | **無い**(全 user 対象が cron の目的)。§1 の user 列挙がこれを置き換える |
| `--grace-days` | `parseGraceDays` (`:495-518`) | **`DEFAULT_GRACE_DAYS`(30)固定**。§4 で後述するとおり prod ガードは cron 経路では意味を持たない(そもそも override 入口が無い方が強い) |

→ **CLI script(手動 = stg 検証・調査用)と cron lane(無引数)を両立させるのが素直**。`src/` レーンと同型: 判定は lane 側の関数、入口は 2 つ(cron / 手動 GET)。

### 事実: cron 入口は既に**追加 lane を受ける形**で作られている

`app/api/cron/sweep/route.ts:20` は `const LANES: CronLane[] = [{ name: 'src_sweep', run: runSrcSweepLane }]`。`run-lanes.ts:27-48` は lane 逐次実行 + per-lane catch(1 本の throw が後続 lane と readback を巻き込まない)を既に持ち、`run-lanes.ts:3-10` のコメントが「stub lane を渡して pin する seam」と明記している。**`asset_gc` lane を配列に足すのが設計者の想定形**。`vercel.json:4` の cron は `/api/cron/sweep` 1 本のみで、path を増やさず済む。

- ただし `LaneContext`(`run-lanes.ts:12-16`)は `deadlineAt` / `cutoffMs` / `cutoffOverrideMinutes` = **`src/` 固有の語彙**。asset lane は `cutoffMs` を使わない(grace は日単位・DB 側で評価)ので、context を lane 共通部(`deadlineAt`)と lane 固有部に割る小改造が要る。
- **予算の再配分が要る**: 現状 `SWEEP_BUDGET_MS = 270_000` を `src_sweep` が単独で使い切れる形(`src-sweep.ts:162`)で、route の `maxDuration = 300`(`route.ts:15`)。lane を 2 本にするなら deadline を分割配布するか、maxDuration を上げるかの判断が要る。

### 事実: mark / promote / collect は 1 invocation に収まる。ただし**初回だけ様相が違う**

- mark / markClear / promote は**単文 bulk UPDATE**(`:586-632`)。per-user 化しても user 数ぶんの短い UPDATE。
- collect のみ per-asset ループで R2 DELETE を伴う(`:302-408`)。現在の collect 候補 = `deleting`/`deleted` = **2 件**(退会由来)。
- **初回 run**: mark が 204 件を一斉に `unreferenced_at=now()` にする(promote は 0 件 — grace 30 日)。**30 日後の run で 204 件が一斉に promote → collect** = R2 DELETE 204 回が 1 run に集中する。`src/` の chunk idiom(`SWEEP_DELETE_CHUNK=20` 並列 + chunk ごと deadline 確認・`src-sweep.ts:366-412`)に載せれば 270s 予算で十分だが、**「打ち切り時に何を優先し何を繰延べるか」を決める必要がある**(`src/` は oldest 昇順で starve を防いでいる = `src-sweep.ts:80`)。現状の `fetchCollectCandidates`(`:673-690`)は **ORDER BY も LIMIT も無い**。
- `assets` の index は `(user_id, hash)` と `(user_id, status)` のみ(`lib/db/schema.ts:848-849`)。**先頭列が user_id** なので、全 user 横断の `WHERE status IN ('deleting','deleted')` は index が効かない。per-user 走査(§1 の (a)/(b) どちらでも per-user になる)なら既存 index に素直に乗る。

### 事実: 台帳 key は **`r2_gc_delete` をそのまま使うのが 4 軸規律に合う**

`lib/integration-failures.ts:72-77` = `{service:'r2', operation:'object.delete', workflow:'asset_gc', failureCode:'external_api_error'}`。`src/` 側は入口が cron になっても workflow を `src_sweep` のまま保っている(`:174-181`)ので、**「cron 化したから key を分ける」は 4 軸の意味に反する**(4 軸は *どの workflow の失敗か* を表し、*誰が起動したか* ではない)。

一方で **`src/` が持っていて asset lane が持たない台帳行が 2 種ある**:
- `r2_sweep_incomplete` 相当(**打ち切り・phase の記録**)。reconciler は打ち切り概念自体が無いので現存しない。cron 化で予算打ち切りが発生しうる以上、**`r2_gc_incomplete` の新設が要る**(`r2_deletion_src_incomplete` / `r2_sweep_incomplete` と同型・`:156` `:193`)。
- `r2_sweep_overdue` 相当(**滞留検知**)。§11 レーン表が asset lane の「期限・滞留の検知」を **未整備**と書いているのがこれ。行 DELETE 失敗(`rowDeleteFailures`)は現状 `logger.error` だけで台帳に載らない(`:431-441`)= **Vercel Logs 以外に観測点が無い**。cron 化すると stdout を誰も読まないため、**ここが観測の穴として顕在化する**。

---

## 3. row-less orphan の実在確認手段 — **「行が無い = 消してよい」は成立しない**

### 事実 A: reconciler の `--dry-run` では検出できない(構造的に)

`countRefDivergence`(`:728-752`)が比べるのは `cards.images` 内の UUIDv4 key 数と `card_asset_refs` 行数 = **どちらも DB**。R2 は登場しない。reconciler 全体で R2 に触るのは `deleteObject` のみ(`:552-560` の dynamic import)。→ **backfill-divergence は「backfill 漏れ」の観測であって「R2 と DB のズレ」の観測ではない**。`docs/ops/r2-key-inventory.md:53` の記述は誤りなので訂正が要る。

### 事実 B: 検出には listing 駆動の走査が要る。必要なのは 3 点だけ

本調査で実際に走らせた read-only probe(scratchpad・repo に残していない)が最小形:
1. `listObjectsWithMetaBounded('users/', N)`(`lib/storage/r2.ts:526-532`)で key + `lastModifiedMs` を取る
2. key を `users/{userId}/{assetId}.{ext}` で割って userId を得る(`asset-actions.ts:98` / `crop-and-store.ts:308` の生成規則)
3. `withTenantTx(userId)` で `assets.object_key` を引き、集合差を取る

実測結果 = **242 件中 row-less 0 / object-less 0**(§0)。現時点で row-less orphan は**実在しない**。

### 事実 C(重要): **行より先に R2 object が置かれる正規経路が実在する**

`cropFigureFromBuffer`(`lib/media/crop-and-store.ts:307`)は **`putObject` を先に打ち、`assets` 行の INSERT は後**(`:380-391` → `writeCropAssetRows`)。しかも `:357-359` のコメントが明示している:

> `hash 一致 + 行が存在しない = crash-recovery(前回試行が R2 PUT 成功後・DB INSERT 前に中断した)`

つまり **「object があって行が無い」状態は異常ではなく、設計上の中間状態**であり、crash 時にはそのまま恒久化する。手動添付レーン(`reserveAsset` = 行 INSERT → presign、`asset-actions.ts:103-118`)は逆順で安全だが、**crop レーンは逆**。

→ **「`assets` 行が無い = 消してよい」は現物では成立しない。**

### 判定を成立させる条件(`src/` sweeper と同じ 3 条件になる)

窓の上界は測れる:
- crop の PUT→INSERT 窓は 1 invocation 内に閉じ、上界 = **`maxDuration = 720`s**(`app/(app)/app/upload/page.tsx:23`)
- 同 user の live upload operation の lease TTL = **`LEASE_TTL_MS = 15 分`**(`app/(app)/app/upload/_lib/constants.ts:55`)

ゆえに削除可の条件は **①key 規約一致 ②age > cutoff(720s / 15 分を十分上回る値。`src/` の 6h = lease の 24 倍という既存の取り方に倣える)③その user に live upload operation が無い** の三重条件。②③ は `src/` sweeper が既に持っている形(`src-sweep.ts:339-363`)。

**③ の実装で踏んではいけない罠**(②-4b の既知教訓・memory にも記録済): `hasLiveUploadOperation`(`lib/exams/source-doc-status.ts`)を再利用してはならない。DB error を握って `false`(= live でない)を返すため、判定不能が**削除側に反転**する。`src-sweep.ts:482-491` の `hasLiveUploadOperationForSweep` が正しい形(throw をそのまま返し呼出側が skip に倒す)。

### sprint 設計への含意 / 停止点

- brief の「assets 行が無い = 消してよい、が成立するか」への答えは **No(無条件では成立しない)**。三重条件を課せば成立する。**brief の停止条件に該当するので、ここで OT 判断を仰ぐ。**
- 副次的な設計選択: row-less orphan lane は §1 の案 (b) と**同じ listing を使う**。(b) を選ぶなら 1 回の listing で「user 列挙」と「row-less 検出」が両方取れる。(a) を選ぶなら listing は row-less lane 専用になり、頻度を落とせる(日次である必要が無い — 現在 0 件かつ発生源が crash のみ)。**(a) + row-less lane は週次/月次、が走査量的に最も素直**。

---

## 4. refs↔GC 整合(証明の空白 #8)の検証手順

### 事実: 現状 **SQL レベルの証明がゼロ**

- `scripts/gc-image-assets.test.ts`(971 行 / 44 test)は**全て DI mock**。`refsExists`(`:526-528`)や `markSet` の WHERE(`:586-598`)といった **実 SQL は一度も実行されない**。
- iso(`tests/integration/pg/`)に reconciler の test は無い。`cardAssetRefs` を触る iso は `publish-prepared.test.ts`(refs 書込)と `rls-wave1.test.ts`(RLS 隔離)のみで、**GC 判定は見ていない**。
- 既存 smoke は `docs/audit/2026-07-16-gc-reconciler-smoke4-procedure.md`(9 節・実行手順完備)で、**2026-07-16 に OT が stg で実施し PASS**(`docs/superpowers/sessions/2026-07-16-sprint-i-image-four-fields-completion.md:90-96`)。ただし守ったのは **1 枚のカードの 4 面に貼った同一 asset** であり、**カードをまたぐ共有(A/B 2 枚)は検証していない**。
- 現物でも A/B 共有は**存在しない**: `card_asset_refs` を asset ごとに数えると **refs_per_asset = 1 が 32 件、2 以上は 0 件**(§0 の user)。→ 実データで偶然守られているだけで、証明にはなっていない。

### 事実: A/B 共有を作れる構造ではある

`card_asset_refs` の PK は `(card_id, field_key, ordinal)`(`lib/db/schema.ts:880`)で **`asset_id` は PK に入らない** → 同一 asset を複数 card から参照できる。`asset_id` には FK `onDelete: 'restrict'`(`:871`)、`card_id` は `cascade`(`:867`)。ゆえに card A を削除すると A の refs 行だけ cascade で消え、B の refs 行が残る = asset は referenced のまま。

### 推奨手順(2 層で取る)

**層 1 = iso test(自動・恒久)**:
`tests/integration/pg/` に reconciler の実 SQL を通す test を足すのが最も費用対効果が高い。DI deps の代わりに**実 PG 向け deps**を束ね、fixture の 2 card × 1 asset を作って
① card A の refs 削除 → mark run → `unreferenced_at` が **立たない**
② card B も削除 → mark run → 立つ → `--grace-days 0` 相当で promote → collect 対象になる
を pin する。**これが証明の空白 #8 に対する唯一の恒久的な手当て**(stg smoke は 1 回きりで regression を守らない)。

**層 2 = stg smoke(cron lane の実機確認)**:
既存 `docs/audit/2026-07-16-gc-reconciler-smoke4-procedure.md` の手順がそのまま使える(§5 向き先確認 / §8 判定基準 / **事前 gate = `referenced > 0` を dry-run で確認**)。差分は A/B シナリオの作り方のみ:
1. stg で card A に画像を添付 → 同じ画像を card B にも添付(`handleImages` が refs 全置換するので 2 card 分の refs 行ができる)
2. card A を削除 → 同期完了を待つ(local-first ゆえ outbox flush が server に届くまで refs は変わらない = 手順書 §8 の前提)
3. mark run → 当該 asset の `unreferenced_at` が NULL のままを SQL で確認
4. card B を削除 → 同期 → mark run → `unreferenced_at` が立つ / collect で R2 object 消滅

**CC 実行可否**: 手順 1-2 は Playwright MCP で実走可(sign-in は OTP 424242 で自走可)。手順 3-4 の DB 確認は app role + tenant context で可(§0 で実証済)。**mark/promote/collect の実行だけが不可**(`DATABASE_URL_ADMIN` が空。cron 化後は手動 GET で叩けるようになる = cron 化がこの smoke の前提になる)。

### `--grace-days 0` の prod ガード

- 現状: `parseGraceDays`(`:509-516`)が `VERCEL_ENV==='production' || NODE_ENV==='production'` かつ `n < 30` を reject。
- **既知の穴**(`docs/audit/2026-07-16-gc-reconciler-smoke4-procedure.md:99`): ローカル `node --env-file` からは両 env が unset ゆえ**発火しない**。`DATABASE_URL_ADMIN` が prod を指していても `--grace-days 0` は止まらない。実効境界は operator の env 目視のみ(architecture §9 / 証明の空白「破壊 script の機械境界」)。
- **cron 化後にどう効くべきか**: `src/` の cutoff override(`route.ts:36-49`)が既に正解の形を示している — **手動 GET の query で override でき、`VERCEL_ENV==='production'` なら 400 で構造的に拒否**、かつ**下限へ clamp せず reject**(silent なズレを作らない)。asset lane の grace も同型にするのが素直で、**この形にすると prod での grace 短縮が「env の目視」でなく「platform env 由来の分岐」で塞がる = 既知の穴が cron 経路については閉じる**(CLI script 経路の穴は残る。script を残す限り消えない)。

---

## 5. 退会由来 asset の扱い(確認のみ)

### 事実: brief の理解は**現物と一致する**

- 退会 handler は `assets` を**物理 DELETE せず** `status='deleting'` へ倒す(`lib/clerk/handle-clerk-event.ts:286-289`)。Group I 唯一の soft-delete 例外(`:279-284` のコメント)。
- collect 候補の取得は `inArray(assets.status, ['deleting','deleted'])` のみで、**`unreferenced_at` も grace も見ない**(`scripts/gc-image-assets.ts:684-687`)。判定は `canSweepDelete`(`lib/media/domain/asset-state.ts:108-110`)= `deleting || deleted` の無条件 true。
- → **退会由来 asset は grace を経ず collect 対象**。理解は正しい。

### 事実: 退会後に R2 実体が残る期間を決めているのは **reconciler の実行頻度だけ**

- asset prefix に lifecycle は**張らない**(architecture §11「やってはいけない 2 つ」の 1 番目)= backstop 無し。
- reconciler は手動実行のみ(`docs/ops/scripts-and-seed.md:20`)。
- **実測がそれを裏付けている**: user `2ac594a5-…` の 2 件は `deleting` かつ `created_at` が **2026-08-04** で、6 日経った 2026-08-10 現在も **R2 に実体が残っている**(§0)。GDPR 削除契約(architecture §4)は DB 側の PII scrub を保証するが、**R2 実体の削除期限は誰も保証していない**。

### 追加の観察(brief 外・記録のみ)

1. 退会 UPDATE には **status 条件が無い**(`.where(eq(assets.userId, internalUserId))` のみ)。既に `deleted`(R2 削除済・行 DELETE 待ちの crash marker)だった行も `deleting` に戻る。害は「次 run で R2 DELETE を 1 回余分に打つ(404 → `ok:true` に正規化・`r2Delete404` に計上)」だけで correctness は壊れないが、**`deleted` の意味(R2 は既に消えている)を上書きしている**。
2. **退会済 user に対して app role の tenant context は張れる**(`setTenantContext` は GUC を書くだけで users 表を見ない・`lib/db/tenant-tx.ts:22-24`)。`assets_tenant` policy にも `deleted_at` 条件が無い。→ §1 の app role 化で退会由来 asset を扱うのは可能。ただし **§1 案 (b)(R2 listing 駆動)では、退会 purge 後に R2 が空になった user の残行を拾えない**(asset レーンには prefix purge が無いので現状は問題化しないが、将来退会時に R2 も即消す設計に変えると (b) は破綻する)。

### sprint 設計への含意

- brief 記載の「退会由来 asset の grace 30 日の要否未確定」(§11 未解決 ②)は、**現物では既に「grace 無し」で確定している**。未確定なのは「**それでよいか**」= GDPR 的に R2 実体の削除期限を明示すべきか、という**要件側の問い**。cron 化(日次)が入れば実効期限は「退会から最大 ~24h + 予算打ち切り分」になり、これは §11 が `src/` に対して書いているのと同じ粒度の保証になる。**cron 化がこの問いの答えを兼ねる**。

---

## 6. OT 判断が要る点(番号 = 報告の論点番号に対応)

1. **§1 の user 列挙手段**: (a) SECURITY DEFINER 4 本目 / (b) R2 listing 駆動 / (c) runtime に owner 接続。CC 推奨 = **(a)**、(c) は非推奨。
2. **§3 の停止点**: 「行が無い = 消してよい」は無条件では偽。**三重条件(key 規約 + age + live-op)に変更してよいか**。
3. **§2 の台帳**: `r2_gc_incomplete`(打ち切り)の新設と、行 DELETE 失敗の台帳化(現状 logger のみ)。
4. **§4 の証明**: iso test(層 1)を sprint scope に入れるか。入れないと証明の空白 #8 は stg smoke 1 回で終わり regression を守らない。
5. **§5**: 退会 → R2 実体削除の期限を契約として明文化するか(cron 化で実効 ~24h になる)。

## 7. 本調査で確認していないこと(推測しない)

- **prod の実データ**。接続していない。§0 はすべて stg(`recallmint-dev` bucket は dev/stg 共有)。
- **R2 lifecycle rule の実設定**。現行 credential では readback が 403(`docs/ops/r2-key-inventory.md:52`)。asset prefix に rule が**無い**ことは repo 内に記述が無いことの確認どまりで、dashboard 目視はしていない。
- **Vercel の cron 本数上限**。plan 依存。`vercel.json` は 1 本のみで、本書は「lane を足す(path を増やさない)」前提なので抵触しないが、path を分ける設計にするなら要確認。
- **`assets` の全 user 集計**。`DATABASE_URL_ADMIN` が空のため、R2 listing に現れた 3 user のみ測定。R2 に 1 件も object を持たない user の残行は**測れていない**(§5 追加観察 2 と同じ盲点)。
