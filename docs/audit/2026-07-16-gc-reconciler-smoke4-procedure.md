# GC reconciler smoke④ 実行手順 fact-finding(read-only)

> **RLS-P1 注記**: 本 doc は 2026-07-16 時点の調査記録だが、実行手順は live runbook として維持する。RLS-P1 で env 変数名が `DATABASE_URL` → `DATABASE_URL_ADMIN`(script は `getAdminDb()` 経由)に改名されたため、本文中の `DATABASE_URL` / `getDb()` 表記は現行名に置き換えてある(operator が向き先を目視する安全境界の趣旨・guard ロジック自体は無変更)。

- **日付**: 2026-07-16
- **性質**: read-only 現物調査のみ(script 実行・DB 接続・実装変更・commit なし)。Sprint I smoke④(GC 非孤児化 = 4面画像を孤児誤判定しない / 削除画像・選択肢 cascade 外れ画像は回収する)の実行手順確定。
- **調査 HEAD**: `52a56b1`(develop)。全て `scripts/gc-image-assets.ts` / `lib/db/index.ts` / `lib/storage/r2.ts` / `lib/media/domain/asset-state.ts` / `lib/db/schema.ts` / `lib/cards/card-field-handlers.ts` の実コードで裏取り。
- **reconciler 本体**: `scripts/gc-image-assets.ts`(GC v2 Task G5)。

---

## 実測確定(2026-07-16・smoke④ PASS・OT 実施 stg)

本 doc の fact-finding を OT が stg 実機で実行し **PASS**。以下は実測で確定した事項(§10 手順の裏付け)。

- **実行形は doc の記述どおりで正しかった**: `node --env-file=.env.local --conditions=react-server --import tsx scripts/gc-image-assets.ts ...` で動作。
- **env file は `.env.local` で足りた**(`.env.gc-stg` の新規作成は不要だった): `.env.local` に stg の `DATABASE_URL_ADMIN`(6543 pooler)と R2 env 4 種が揃っていた。→ §10 の `.env.gc-stg` は「stg 専用 file を作るなら」の一般形。実運用は既存 `.env.local` を `--env-file` で指せば足りる(**ただし `.env.local` が stg を指すことの目視確認は依然必須**・§5)。
- **2 回実施し、1 回目は vacuous と判断してやり直した(記録として重要)**:
  1. **1 回目(空振り)**: `scanned=23 referenced=0` → sweep で `reclaimed=23`。試験データ全消去 → cards CASCADE で refs 消滅 → assets のみ残存(user→asset を単純 cascade にしない GC v2 設計どおり)ゆえ全 asset が孤児。**`referenced=0` = 守るべき対象がゼロ**ゆえ「誤収しない」の証明にならず **vacuous** と判断。
  2. **2 回目(本番・gate を通した)**: 画像添付 → 1 枚を残して削除 → dry-run で `scanned=4 referenced=1` / `imageUuidKeys=1 refRows=1`(divergence なし = 同期到達を確認)→ sweep で**孤児のみ回収・`referenced=1` の生存画像は非回収**。R2 ダッシュボードで生存 object 1 個のみ残存を目視確認。
- **結論**: spec §2「GC は asset_id ベースで field 非依存ゆえ 4 面化の影響なし」が実機で裏付けられた。

### 教訓(load-bearing・§8 の事前 gate に反映済)

- **GC smoke は dry-run で `referenced > 0` を確認してから sweep しないと vacuous**。守るべき対象(生存画像)がゼロの状態で「誤収しない」は証明できない。= **「test は実際に gate を通さないと vacuous」の運用版**。→ §8 判定基準に**事前 gate「dry-run で `referenced > 0` を確認」を必須化**した。

---

## 0. 結論(smoke④ が成立する理由 = §2「asset_id ベース・field 非依存」の裏取り)

- **GC の「参照あり」判定は asset 単位**: `EXISTS (SELECT 1 FROM card_asset_refs WHERE asset_id = assets.id)`(`gc-image-assets.ts:527` `refsExists` / `:570-572` scan)。**どの面(field_key)に貼られているかを一切見ない**。
- **refs テーブルの PK = `(card_id, field_key, ordinal)`**(`schema.ts:876`)。∴ 同一 asset は面ごとに複数 ref 行を持ちうるが、GC は `asset_id` の EXISTS だけを見る。→ **4面(問題文/選択肢/解説/メモ)化は GC 判定に無影響**(spec §2 の主張をコードで確認)。
- **保存時に refs は全置換**(`card-field-handlers.ts:171` `handleImages` → `:204-206` 当該 card の refs を DELETE → `:228` 現存 UUID image entry を INSERT / `:225-227` UUID key ゼロなら INSERT skip = refs クリア)。→ 画像を外す / 画像付き選択肢を削除して**保存が stg DB に届く**と、その面の ref 行が消える。他の面にまだ同 asset があれば ref 行が残る = 参照継続。
  - 帰結: **生きた画像**(いずれかの面に現存)= ref 行あり → 未マーク → 非回収。**外した画像**(どの面にも無い)= ref 行ゼロ → マーク対象 → grace 超で回収。

---

## 1. 実行形

- **script**: `scripts/gc-image-assets.ts`。CLI entry は `process.argv[1]` が本 file の時のみ発火(`:759`)。
- **`--conditions=react-server` 必須(確定)**: 本 script は top-level で `@/lib/db`(getAdminDb)と `@/lib/integration-failures`(→ `@/lib/db`)を import。`lib/db/index.ts:4` に `import 'server-only'`。素の実行では server-only が throw する。`--conditions=react-server` で react-server 条件が empty(no-op)に解決(header `:25-30`・seed/backfill と同前例)。**dry-run でも必須**(top-level import ゆえ)。
- **env 供給 = `node --env-file=<file>`(GC v2 で確立した形・seed audit と一致)**:
  - `node --env-file=<file> --conditions=react-server --import tsx scripts/gc-image-assets.ts ...`
  - `--env-file`(Node native・Node 24.13.0 で利用可)が file を process.env に先読み。`getAdminDb()`(`lib/db/index.ts:31-39`)が `process.env.DATABASE_URL_ADMIN` を lazy に読む(RLS-P1)。
  - `pnpm tsx --conditions=...`(script header `:17-23` の例)は `--conditions` は通るが `--env-file` は Node flag ゆえ **`node --import tsx` 形が確実**(header は env 供給を明示していない)。
  - 接続文字列(パスワード平文)を CLI に書かずに済む(env file 経由)。
- **module-load 時に要求される env**:
  - **dry-run(`--dry-run`)= `DATABASE_URL_ADMIN` のみ**。`@/lib/storage/r2` は top-level import しない(`:61-64`)。R2 実削除する本実行のときだけ dynamic import(`:552-560`・`willDeleteFromR2 = sweep && !dryRun`)。
  - **本 sweep(`--sweep` かつ非 dry-run)= `DATABASE_URL_ADMIN` + R2 env 4 種**。`lib/storage/r2.ts:16-31` が module-load で `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` を fail-fast 検証(1つでも欠けると起動直後に throw・exit 1)。
    - ⚠ **この 4 種は stg の R2 bucket を指すこと**。DATABASE_URL_ADMIN=stg でも R2 env が別 bucket を指すと、stg DB の objectKey を別 bucket に対し DELETE してしまう(向き先の二重確認が必要)。
- **`.env.local` の自動ロードは効かない**: 本 script は `dotenv/config` すら import しない(top-level import に dotenv 無し = 実コード確認)。∴ **必ず `--env-file` で明示供給**する。
- **pooler(6543)適合(確定)**: `getAdminDb()` は `postgres(url, { prepare: false })`(`lib/db/index.ts:36`)= Supabase transaction pooler(6543)要件。reconciler は INSERT/UPDATE/DELETE のみ(DDL 無し)ゆえ 6543 で問題なし。→ `.env.local`/env file の `DATABASE_URL_ADMIN` が **stg・6543 を指しているならそのまま動く**。
- **不明**: `.env.local` の `DATABASE_URL_ADMIN` が stg を指すか dev/local/prod を指すかは **CC から確認不可**(secret・未読)。stg を指さないと別 DB を触る(下記 §5・§9 参照)。

---

## 2. 実在する flag(全リスト・file:line)

`main()`(`:532-540`)が parse する flag はこれで**全て**。他の flag は解釈されない(無視される)。

| flag | file:line | 挙動 |
|---|---|---|
| `--sweep` | `:534` | `argv.includes('--sweep')`。無 = **mark のみ**(orphaned_at の set/clear だけ)。有 = mark + promote + collect(本回収)|
| `--dry-run` | `:535` | `argv.includes('--dry-run')`。write を一切行わず予告集計のみ(下記 §3・§7)|
| `--user <id>` | `:536`(`parseUserFlag` `:479-487`)| 対象 user を内部 DB UUID で限定。**値必須**(値欠落 / 次が別 flag なら `:483-485` で throw → exit 1)。無指定 = 全 user 対象(意図的)|
| `--grace-days N` | `:537`(`parseGraceDays` `:495-518`)| grace 日数上書き(既定 `DEFAULT_GRACE_DAYS = 30`・`:70`)。値欠落/非整数/負数は throw。**prod ガード**あり(§4)|

- mark / promote / sweep(collect)は**別 flag ではない**。`--sweep` の有無で mark-only か full(mark+promote+collect)かが決まる。promote と collect を個別に打つ flag は**無い**(sweep が両方を一続きに実行)。
- ∴ 「stg で即座に 1 サイクル回して回収まで見る」= **`--sweep`(+ 即回収なら `--grace-days 0`)を 1 回打つ**。

---

## 3. 各フェーズの意味と順序(`runReconciler` `:229-412`)

実行順は固定。1 run 内で下から順に流れる。

1. **countScannedAssets**(`:235` / `:565-580`): 対象 asset 総数 `scanned` と、参照あり(EXISTS refs)`referenced` を数える。**read のみ**(dry-run/本実行とも実行)。
2. **mark**(`:245-248`): 参照ゼロ+未マークの reserved|ready を `unreferenced_at = now()` に(`markSet` `:581-599`)/ 再参照されたマーク済みを `unreferenced_at = NULL` に戻す(`markClear` `:600-615`・self-heal)。意味論 = `asset-state.ts` `shouldMarkUnreferenced` `:47-57` / `shouldClearUnreferenced` `:69-74`。**dry-run では skip(write ゼロ・件数見積りも出さない)**(`:245` `if (!opts.dryRun)`)。
3. **pre-sweep guard**(`:266-276` / `checkRefsPopulated` `:649-672`): `--sweep` かつ非 dry-run のみ。`card_asset_refs` が空 かつ `cards.images` に UUID key ありなら「refs 未投入(W1 未 deploy or backfill 未実行)」と判断し **throw で abort**(参照中 asset の誤削除を防ぐ backstop)。dry-run は gate しない。
4. **promote**(`:282-290`): grace 超 + 参照ゼロの reserved|ready を `status = 'deleting'` に(`promote` `:616-632`・単文 UPDATE)。境界は strict older(`unreferenced_at < now() - N days`・`asset-state.ts:28-37` `isSweepEligible` と同義)。**dry-run は write せず** `fetchPromoteCandidates`(既にマーク済みの未参照 reserved|ready)を取得し `isSweepEligible` で「本実行なら promote されるであろう件数」を予告(`:284-290`)。
5. **collect**(`:293-408`): `status IN ('deleting','deleted')` を per-asset 処理(`fetchCollectCandidates` `:673-690`)。直前に refs を fresh 再読(TOCTOU 防御・`fetchReferencedAssetIds` `:691-702`)。
   - 参照が復活した `deleting` → `ready` に戻す(self-heal・`:333-355`)。
   - `deleted`(R2 済 crash マーカー)→ 行 DELETE のみ(`:358-362`)。
   - `deleting` → **R2 DELETE(`deleteObject` `r2.ts:152`)→ success 等価(2xx/404)確認 → `status='deleted'` マーカー(`markDeleted`)→ 行 DELETE(`deleteAssetRow`)**(`:364-408`)。decouple 順序厳守(R2 先・行後)。R2 失敗は行を deleting のまま存置 + integration_failures 台帳 + 次 asset へ続行。
   - **dry-run は R2 も DB も叩かず**、回収予定を `reclaimed` に積むのみ(`:366-369` / `collectDeleteRow` dry `:423-426`)。
6. **countRefDivergence**(`:251-253` / `:728-752`): **dry-run 限定**。`cards.images` 内 UUIDv4 key 総数 vs `card_asset_refs` 行数を出力(backfill 漏れ観測材料)。

**mark-only(`--sweep` 無し)は write を行う点に注意**(orphaned_at を set/clear する)。**完全 read-only は `--dry-run` のみ**。

---

## 4. `--grace-days 0` の扱いと prod ガード

- **`--grace-days 0` は許容値**(`parseGraceDays` は `n >= 0` の整数を通す・`:506`)。非 prod 環境では通る。
- **意味**: promote 条件が `unreferenced_at < now() - 0日` = `unreferenced_at < now()`。∴ **mark 済み(orphaned_at セット済)の未参照 asset を即 promote 対象にする**。既定 30 日を待たず即回収したい stg 検証専用。
- **1 run で mark→promote→collect まで通るか**: 通る。mark(`SET unreferenced_at = now()`)と promote(`WHERE unreferenced_at < now()`)は別 statement = 別 transaction_timestamp ゆえ promote の `now()` が mark の値より厳密に後(ms 差)。∴ **その run で marked → promoted → reclaimed が同数で立つ**。万一同一 run で拾わなくても、2 回目の同一 run で確実に回収(unreferenced_at が過去に固定される)。
- **grace 0 を使わないと即時回収は見えない**: mark しても既定 30 日は promote されない。smoke で「回収まで」見るには `--grace-days 0` が必要。
- **prod ガード(`:509-516`)**: `VERCEL_ENV === 'production' || NODE_ENV === 'production'` の時のみ、grace < 30 を throw で reject。
  - ⚠ **これは env 変数が literal `'production'` の時だけ発火する**。OT がローカル shell から `node --env-file=...` で回す場合、通常 `NODE_ENV`/`VERCEL_ENV` は unset ゆえ **発火しない**。→ **DATABASE_URL_ADMIN が誤って prod を指していても `--grace-days 0` は止まらない**(seed の SEED_FORCE L1/L2 と同じ穴)。**向き先は operator が保証する**(§5)。
  - **prod では絶対に `--grace-days 0`(や < 30)を打たない**: in-flight / offline-pending mutation を全収する。stg 検証専用。

---

## 5. 向き先確認(破壊操作前の read-only identity check)

reconciler には **seed の `--dry-run --cleanup` のような専用 identity 列挙は無い**。ただし **`--dry-run` の出力そのものが間接 identity check**(GC v2 の「assets 件数で stg/prod 間接判定」と同型):

- **`--dry-run`(全 user)or `--user <uuid> --dry-run`** を打つと stdout に:
  - `scanned=<総 asset 数>` `referenced=<参照あり数>`(§7 の done 行)
  - `[dry-run] backfill divergence: imageUuidKeys=.. refRows=..`
- これらの**件数が想定 stg(件数規模・テスト user の内訳)と一致**するなら向き先 = stg で正しい。想定外(0 / 桁違い / prod 規模)なら向き先違いを疑い中断。
- **`--user <test-uuid>` で全操作を owner-scope に bound**(`:545` `userScope` を各 SQL に注入)。→ 万一 prod を指しても、触れるのは**そのテスト user の未参照 asset だけ**(seed L3 と同じ実質 bounding)。smoke④ は**必ず `--user` を付ける**。
- **コードは Supabase URL の stg/prod を判別しない**(seed L2 相当のチェックすら reconciler には無い)。→ **DATABASE_URL_ADMIN と R2 env 4 種が stg を指すことは operator が目視確認する責任**。env file を開き、`DATABASE_URL_ADMIN` の host/port(6543 pooler・stg プロジェクト)と `R2_BUCKET_NAME` が stg bucket であることを実行前に確認。

---

## 6. 結果の見方(§7 に stdout 詳細)

3 系統で確認する:

1. **script stdout の done 行**(§7)= 各フェーズの件数。**回収件数 = `reclaimed=N`**。
   - ⚠ **回収された個別の (assetId, objectKey) は stdout に出ない**(`logSummary` `:449-458` は `reclaimed=<count>` のみ印字。内訳 list は `ReconcilerSummary.reclaimed` に入るが未印字)。個別特定は下記 SQL / R2 で行う。
2. **SQL(Supabase)**: 実行前後で `assets` 行を照合。
   - 生きた画像 asset の行が**残存**(status='ready')= 非回収の確認。
   - 外した画像 asset の行が**消滅**(SELECT で 0 件)= 回収の確認。
   - `card_asset_refs` で当該 asset_id の ref 行有無を確認(生き = 行あり / 外し = 行ゼロ)。
3. **R2 ダッシュボード**: objectKey(`users/{user_id}/{assetId}.{webp|png|jpg}`・`schema.ts:811` 形式)で object の存在/不在を目視。生き = 存在 / 外し = 不在。

---

## 7. stdout(done 行の全フィールド・`logSummary` `:449-468`)

```
[gc-image-assets] done. mode=<mark|sweep> dryRun=<bool> grace=<N>d user=<uuid|all> |
  scanned=.. referenced=.. marked=.. cleared=.. promoted=.. |
  r2Ok=.. r2_404=.. r2Failed=.. rowDeleteOk=.. rowDeleteFailed=..
  deletedLane=.. selfHealed=.. unknownStatus=.. reclaimed=..
[gc-image-assets] [dry-run] backfill divergence: imageUuidKeys=.. refRows=..   # dry-run 時のみ
[gc-image-assets] row DELETE failures (assetIds, not in ledger): ...            # 失敗時のみ
```

- `marked` = 今 run で orphaned_at をセットした件数 / `cleared` = 再参照で解除した件数(dry-run は 0)。
- `promoted` = deleting に落とした件数(dry-run は予告件数)。
- `r2Ok`/`r2_404` = R2 DELETE 成功(404 も望む end-state)/ `r2Failed` = 台帳記録した失敗数。
- `rowDeleteOk`/`rowDeleteFailed` = assets 行 DELETE 成否 / `reclaimed` = 回収完了件数(dry-run は回収予定件数)。

---

## 8. smoke④ の判定基準

前提: **削除操作が stg DB に同期済み**であること(local-first ゆえ outbox → server の handleImages が stg で走って初めて refs が更新される。同期前に GC を打つと「まだ ref 行が残る」→ 未回収に見える)。

- **【事前 gate・必須】dry-run で `referenced > 0` を確認してから sweep する**(2026-07-16 実測教訓): `referenced=0`(守るべき生存画像がゼロ)の状態で sweep して全孤児が回収されても、「誤収しない = 生存画像を守れた」の**証明にはならない(vacuous)**。必ず「生きた画像(いずれかの面に現存)を最低 1 枚残した」状態を作り、①の dry-run で `referenced ≥ 1` を目視してから sweep する。= 「test は gate を通さないと vacuous」の運用版。
- **「生きた画像が回収されない」**:
  - dry-run: その asset は `referenced` にカウントされ、`reclaimed`(回収予定)に**含まれない**。
  - 本 sweep 後: `assets` 行が**残存**(status='ready')・R2 object **存在**・`card_asset_refs` に asset_id の**行あり**。
  - 4面いずれか / 複数面に貼った asset は、いずれかの面に残る限り ref 行が残り非回収(§0)。
- **「削除した画像 / 選択肢 cascade で外れた画像が回収される」**:
  - dry-run(初回): mark を打たないため `reclaimed=0`・`promoted=0`。**シグナルは `scanned − referenced` の差**(未参照 asset が存在すること)と divergence。→ **「回収される」は本 sweep で確認する**(dry-run の reclaimed には出ない点に注意)。
  - 本 sweep(`--sweep --grace-days 0`): `marked` / `promoted` / `reclaimed` が外した画像の枚数だけ立つ。実行後 `assets` 行が**消滅**・R2 object **不在**・ref 行**ゼロ**。
  - **選択肢削除 cascade**: 画像付き選択肢を削除 → 保存で `handleImages` が refs 全置換 → その面の ref 行が消える → 他面に無ければ未参照化 → 上と同じ経路で回収(§0)。field 非依存ゆえ問題文/解説/メモ削除でも同一。

---

## 9. 危険な操作 / 打ってはいけないもの

- **prod で `--grace-days 0`(や < 30)= 禁止**。in-flight/offline-pending を全収する。prod ガードは NODE_ENV=production の時しか効かず、ローカルからは効かない(§4)。stg 検証専用。
- **向き先未確認での `--sweep` = 禁止**。DATABASE_URL_ADMIN / R2 env(4 種)が stg を指すことを実行前に目視。dry-run を先に打って件数で裏取り(§5)。
- **R2 env と DATABASE_URL_ADMIN の環境ズレ = 禁止**。DB=stg・R2=別 bucket だと別 bucket の object を消しに行く。env file 内で両方 stg に揃える。
- **`--user` 無しの `--sweep` を smoke で打たない**。全 user の未参照 asset を回収対象にする。smoke は必ず `--user <test-uuid>`。
- **W1 未 deploy / backfill 未実行環境での `--sweep` = 参照中 asset を消しうる**。pre-sweep guard(`:266-276`)は「refs 完全未投入」だけを backstop(部分 stale は検知不能)。stg が W1 deploy 済 + backfill 済であることを前提とする(GC v2 の運用不変条件)。**不安なら先に dry-run の divergence(imageUuidKeys ≒ refRows か)を確認**。
- **書込/apply 系フラグは存在しない**が、`--grace-days` に負値・非整数を渡すと exit 1(害はない)。

---

## 10. 確定手順(コピペ可・パスワードを CLI に書かない)

前提:
- env file に **stg の `DATABASE_URL_ADMIN`(6543 pooler・owner 接続。RLS-P1)** と **stg R2 の `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME`** が揃っていること。**実測(2026-07-16)では既存 `.env.local` に全て揃っていたため `--env-file=.env.local` で足りた**(専用 file 作成は不要だった)。stg 専用に分離したい場合のみ `.env.gc-stg`(gitignore 済)を作る。いずれにせよ**その file の DATABASE_URL_ADMIN/R2 が stg を指すことの目視確認は必須**(§5・§9)。
- `<uuid>` = テストアカウントの内部 DB UUID(Supabase `users` で Clerk ID から逆引き)。
- stg が **W1 deploy 済 + backfill 実行済**であること。
- 下記コマンドは実測どおり `.env.local` を使う形で記載(専用 file を作った場合は file 名を差し替え)。

```bash
# ─────────────────────────────────────────────────────────────
# 事前(OT が UI で用意する状態)
#  - テスト card の 4 面(問題文/選択肢/解説/メモ)に画像を添付し保存
#  - 【重要】生存画像を最低 1 枚残す(§8 事前 gate: referenced>0 を作らないと vacuous)
#  - うち 1 枚を「画像削除」、別の 1 枚を「画像付き選択肢ごと削除」して保存
#  - 上記の削除が stg DB に同期完了していること(outbox drain 済)
# ─────────────────────────────────────────────────────────────

# ① 向き先確認 + 【事前 gate】referenced>0 の確認(read-only・DB 書込なし・R2 触らない)
node --env-file=.env.local --conditions=react-server --import tsx \
  scripts/gc-image-assets.ts --user <uuid> --dry-run
#   → done 行の scanned / referenced が想定 stg・テスト user 規模か目視
#   → 【必須 gate】referenced >= 1(生存画像あり)を確認。referenced=0 なら vacuous ゆえ中断・状態を作り直す
#   → [dry-run] backfill divergence: imageUuidKeys ≒ refRows か(乖離大なら backfill 疑い→中断)
#   → scanned − referenced が「外した枚数」相当あれば未参照 asset が存在(回収候補)
#   (実測 2026-07-16: scanned=4 referenced=1 / imageUuidKeys=1 refRows=1 で gate 通過)

# ② sweep の予告(read-only・promote/collect の予定件数を確認)
node --env-file=.env.local --conditions=react-server --import tsx \
  scripts/gc-image-assets.ts --user <uuid> --sweep --dry-run --grace-days 0
#   → 注: 初回 dry-run は mark を打たないため promoted/reclaimed は 0 になりうる
#     (dry-run の promote 予告は「既にマーク済み」の asset のみ対象)。
#     ①②は「向き先と未参照の存在」を read-only で押さえる工程。回収の可否は ③ で見る。

# ③ 本 sweep(即時回収・破壊操作)= mark → promote → R2 DELETE + 行 DELETE
node --env-file=.env.local --conditions=react-server --import tsx \
  scripts/gc-image-assets.ts --user <uuid> --sweep --grace-days 0
#   → done 行: marked / promoted / reclaimed が「外した枚数」と一致
#              r2Ok(+r2_404) と rowDeleteOk が同数、r2Failed=0 / rowDeleteFailed=0 が正常
#   → 生きた画像 asset は referenced に残り、reclaimed に含まれない

# ④ 結果照合(SQL + R2 ダッシュボード)
#   - 生きた画像: assets 行 残存(status=ready)/ R2 object 存在 / card_asset_refs に行あり
#   - 外した画像: assets 行 消滅 / R2 object 不在 / card_asset_refs 行ゼロ
```

- `--grace-days 0` は secret でないゆえ CLI 記載可。
- **`--env-file` が指す file の DATABASE_URL_ADMIN(stg・6543)と R2_* (stg bucket)を ① の前に確認**(CC からは file 内容未確認 = 不明)。

---

## 11. 不明点(推測で埋めない)

以下は本 doc 作成時点の不明点。**2026-07-16 の smoke④ 実測で①②④は解消済**(下記に結果を併記)。

- **`.env.local` の `DATABASE_URL_ADMIN` が stg を指すか**: 【解消】OT が `.env.local` で実行し smoke④ PASS。件数(scanned=4/referenced=1)が想定 stg・テスト user 規模と一致し、向き先 = stg を確認。※CC からは依然 secret 未読ゆえ、今後の実行でも OT の目視確認は必須。
- **R2 env 4 種が stg bucket を指すか**: 【解消】本 sweep が正常回収し、R2 ダッシュボードで stg の生存 object を目視確認 = R2 も stg を指していた。
- **テストアカウントの内部 DB UUID の実値**: Supabase/Clerk で OT 取得(実測で取得済)。
- **stg が W1 deploy 済 + backfill 実行済か**: 【解消】dry-run の divergence が `imageUuidKeys=1 refRows=1`(乖離なし)= refs が live に投入済 → W1 deploy 済 + backfill 実行済を実測で確認。pre-sweep guard も発火せず本 sweep 完走。
- **R2 削除失敗時の Ops 通知**(`recordFailure` → `recordIntegrationFailure` → notifyOps)が `OPS_*` env 欠落で throw しても、script は握って logger + 続行(`:383-398`)。実測では R2 正常ゆえ未発火。
