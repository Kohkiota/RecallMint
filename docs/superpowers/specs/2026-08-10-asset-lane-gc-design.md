# asset レーン整合 sprint: asset GC cron 化 + row-less orphan 走査 設計 spec

> fact-finding = `docs/audit/2026-08-10-asset-lane-gc-factfinding.md`(数値・根拠 path はそちら)。
> OT 裁定済(蒸し返さない): ① user 列挙 = SECURITY DEFINER 4 本目 ② row-less 判定 = 三重条件 ③ 台帳 2 件追加 ④ iso test を scope に含める ⑤ 退会由来 grace = 無し(cron 化が答え)。
> status: **確定(2026-08-10 OT 承認・論点 5 件裁定 = §12・Codex cross-check 反映 amend 済 = §2.1 / §3.3a / §7 / §13)**。以後、実装フェーズでの書き換え禁止(仕様変更は停止して OT 相談)。

## 1. 目的

architecture.md §11 の asset レーン未解決 4 件を閉じる: ① reconciler の cron 化 ② 退会由来 asset の R2 残留期間の確定(cron 頻度 = 日次が答え・裁定済)③ refs↔GC 整合の証明(空白 #8)④ zero-ref 滞留(実測 204+)+ row-less orphan の走査(現在 0 件・crop の PUT→INSERT 順ゆえ将来発生しうる)。

## 2. 全体像 — lane を 2 本追加(cron 入口・観測は統一、判定原理はレーン別)

`/api/cron/sweep` の `LANES` 配列に追加(`vercel.json` 不変・path 増やさない):

| lane | 駆動原理 | やること |
|---|---|---|
| `src_sweep`(既存) | 時間 | 変更なし |
| **`asset_gc`(新)** | **行**(`assets` 行が正) | mark / promote / collect の 3 相を per-user で実行 |
| **`asset_orphan_scan`(新)** | **時間**(行が無い object に記録は無い) | `users/` listing → 三重条件 + 行不在確認 → DELETE |

実行順 = この表の順。根拠 = §11 の v58 原理そのまま: 記録がない側(`src/`・orphan)は時間駆動、記録がある側(asset 行)は遅延してよい — 予算逼迫時に asset_gc が打ち切られても行が durable に残り翌日収束する。orphan scan を最後に置くのは発生源が crash のみで現在 0 件のため。

`LaneContext` は共通部 `{ deadlineAt }` のみに縮め、lane 固有 config(cutoffMs / graceDays 等)は route が lane closure に bind する(現行の `cutoffMs` を context に持つ形は src 固有語彙の漏れ — 2 本目追加のこの時点で直す)。

### 2.1 予算配分 — per-lane 固定絶対 deadline(2026-08-10 amend・Codex cross-check A-2)

共有 deadline 1 本(= 全 lane が `start + 270s` を見る)は**採らない**: 先行 lane が予算を使い切ると後続 lane が毎日 0 実行になり、日次回収の前提が静かに崩れる(先行 lane 側の incomplete しか鳴らないため、asset レーンが止まっている事実が観測に出ない)。

route が **run 開始時刻を原点とする固定絶対 deadline** を lane ごとに配る:

| lane | deadline | 実効上限 |
|---|---|---|
| `src_sweep` | `start + 90s` | 90s |
| `asset_gc` | `start + 210s` | ≤120s |
| `asset_orphan_scan` | `start + 260s` | ≤50s |

(tail 40s は route の `maxDuration = 300` に対する余裕。各 lane 内部の tail reserve は従来どおり lane 側が別途先取りする。)

**絶対時刻ゆえ、先行 lane が早く終わればその余りは後続 lane の開始を早める**(後続の着手が前倒しされ実働時間が伸びる)。ただし**各 lane の絶対上限は前倒しでは動かない** — 上限は原点固定で、早い開始が上限を押し上げることはない。これが「予算は守るべき境界と同じ原点から測る」の lane 版。

lane 開始時点で残 slice が `MIN_SLICE` 未満なら **lane を起動せず `not_started` を summary に立てる**(runner の責務)。理由 = ① 開始時点でゼロ以下の slice を lane に渡すと、lane が listing 失敗と同じ phase を立てて silent に誤ったラベルを残す(src route が固定オフセットを選んだのと同じ既知問題)② 「実行されなかった」と「実行して 0 件だった」を readback で区別できる必要がある。

## 3. `asset_gc` lane

### 3.1 core の移設(挙動不変 refactor)

`runReconciler` core(DI・`scripts/gc-image-assets.ts`)を **`lib/storage/asset-gc.ts` へ移設**する。app code は `scripts/` を import できない。core は無改造(fact-finding §1: core は userId を知らず deps が scope する)。`scripts/gc-image-assets.ts` は owner-deps を bind する thin CLI wrapper として**存続**(dry-run 観測・調査・緊急用。runbook `docs/audit/2026-07-16-gc-reconciler-smoke4-procedure.md` の資産を生かす)。既存 unit test は import 先変更のみ(**保証不変**)。置き場が `lib/media/` でなく `lib/storage/` なのは src-sweep と同判断(domain aggregate でなく infra 層の GC)。

cron と手動 script の並走は安全: TOCTOU 防御は core 内(collect 直前の fresh refs 再読・status WHERE・404 = ok 正規化)にあり、二重実行は 404 収束する。

### 3.2 user 列挙 — SECURITY DEFINER 4 本目(migration 0033)

```sql
CREATE FUNCTION public.app_list_asset_gc_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
```

- 返すのは **GC 作業のある user の id のみ**(3 arm の DISTINCT: ① `status IN ('deleting','deleted')` 行あり ② `unreferenced_at IS NOT NULL` 行あり ③ mark 候補あり = `status IN ('reserved','ready') AND unreferenced_at IS NULL AND NOT EXISTS refs`)。走査量 = O(作業のある user)。
- 迂回するもの = `assets` の RLS(user_id 列挙のみ・**行データ非返却**)。安全な理由 = 露出は「GC 作業を持つ user の uuid 集合」に限定され、得た uuid で他 user の行は読めない(RLS が塞ぐ)。cron lane 専用であることを関数名コメントに明示。`REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO recallmint_app`(0025 の 3 本と同型)。
- 退会済 user も拾える(`users` を見ない)— 退会由来 `deleting` 行の回収に必須(arm ①)。

### 3.3 per-user 実行

lane は 列挙 → user ごとに **app-role deps を bind して `runReconciler` を呼ぶ**:

- deps の各 DB 操作は `withTenantTx(userId, …)` の **per-op tx**(R2 I/O を tx の成功条件に混ぜない共通不変条件を維持。core の呼び順がそのまま「R2 DELETE → 確認 → 行 DELETE」を守る)。
- 退会済 user にも tenant context は張れる(`setTenantContext` は GUC を書くだけ・`assets_tenant` に `deleted_at` 条件なし — fact-finding §5)。
- pre-sweep guard(`checkRefsPopulated`)は per-user 評価。trip(throw)は **その user だけ skip** し summary に記録(lane の per-user catch)。
- summary は per-user `ReconcilerSummary` を lane が集約(件数加算 + `usersProcessed` / `usersSkipped`)。`scanned`/`referenced` の母集合は「列挙された user の assets」に変わる(作業ゼロ user は列挙されず数に入らない — 全表 scan の旧意味論との差は readback の解釈のみで判定に影響しない)。
- deadline slicing: **user 境界**で `slice()` 確認(打ち切り時は `r2_gc_incomplete` 1 行 + 翌日継続)。
- user の処理順 = 列挙順(uuid 順)。starve 対策の順序制御は入れない — 下記 §3.3a の per-user LIMIT が 1 user の占有時間を構造的に bound するため。恒常的 incomplete が観測されたら再訪。

### 3.3a boundedness は deps 注入で作る(2026-08-10 amend・Codex cross-check A-1)

**`runReconciler` core は無改造**(§3.1)。core の collect ループは候補を一括取得して逐次処理する形で、内部に deadline 判定も LIMIT も並列も持たない。ゆえに「core 無改造」と「collect ループ内部での chunk 境界 deadline 確認 / chunk 並列」は**両立しない** — 後者を捨て、boundedness を **deps 側(本 sprint の新規コード)** で作る:

| 手段 | deps | 効果 |
|---|---|---|
| 候補の上限と順序 | `fetchCollectCandidates` に **ORDER BY(最古の作業優先)+ per-user per-run LIMIT = `COLLECT_LIMIT_PER_USER` = 20** | 1 user あたりの collect ループ長が構造的に bound。core は渡された候補だけ処理する |
| I/O の上限 | `deleteObject` に `min(DELETE_TIMEOUT_MS, slice())` を注入 | 1 call の超過が lane 予算を壊さない |
| 記帳の上限 | `recordFailure` は残 slice が `MIN_SLICE` 未満なら書かず suppressed 加算 | 記帳の連鎖(notifyOps の fetch 待ち)が tail reserve を食わない |

**chunk 20 並列は行わない**(逐次のまま)。実測 204 件・LIMIT 20 では並列の実益がなく、core 改造を要するため(YAGNI)。

**帰結(正直に書く)**: 回収レートは **user あたり 20 object / run(= 日次なら 20/day)** が上限。

- 30 日後の promote+collect spike(実測起点 204 件・うち 1 user に 202 件)は **~11 日かけて drain** する。
- 退会 user の R2 実体削除は **⌈N/20⌉ 日**(N ≤ 20 なら翌 run で完了)。
- これを許すのは §11 v58 原理そのもの: **`deleting` 行が durable な削除意図として残るため、回収が遅れても意図は失われない**。時間駆動レーン(`src/`)なら同じ遅延は許されない。

**受容する停滞シナリオ(修理しない・観測する)**: 最古 20 件が R2 側の理由で DELETE 失敗し続けると、その user の queue を恒久占有し、後から入った garbage が順番待ちのまま進まない。skip/backoff 機構は導入しない(over-engineering)。**この停滞は `r2_gc_row_delete` / `r2_gc_delete` に同一 `objectKey` の失敗行が連日出る形で観測可能**であり、それを手動介入のトリガーとする(§13)。

### 3.4 flag の定数化(cron 経路)

`--sweep` = 常に true / `--dry-run` = 常に false / `--user` = 列挙が置換 / `--grace-days` = `DEFAULT_GRACE_DAYS`(30)固定。cron 経路には override の入口自体を作らない(手動 GET の override は §5.1)。

### 3.5 台帳(workflow = `asset_gc` 不変・裁定済の 2 件)

| key | 4 軸 | 意味 |
|---|---|---|
| `r2_gc_delete`(既存) | r2 / object.delete / asset_gc / external_api_error | 不変(cron 化しても workflow は変えない — 4 軸は「どの workflow の失敗か」であり「誰が起動したか」でない) |
| **`r2_gc_row_delete`(新)** | db / asset.row.delete / asset_gc / db_error | 行 DELETE 失敗(RESTRICT 等)。現状 logger.error のみ = cron 化で不可視になる穴を塞ぐ。1 件 1 行・quota 付き |
| **`r2_gc_incomplete`(新)** | r2 / asset_gc.incomplete / asset_gc / incomplete(`r2_sweep_incomplete` の 4 軸に倣う) | 1 run 1 行。phase 語彙 = `enumerate`(user 列挙失敗・final fix wave 2026-08-10 追記。優先度最高 — 列挙が取れないと lane 全体が無効化される最も早い段階の失敗)/ `deadline` / `user_error`(guard trip・user 単位 throw)。suppressed 件数同梱 |

quota は src と同規律(種別ごと独立・洪水が実失敗を抑圧しない)。記帳失敗は `recordErrors` + logger(観測経路の破損を別経路で可視化)。

## 4. `asset_orphan_scan` lane

### 4.1 src_sweep との違い(設計の根拠)

`src/` は全 object が消してよい前提(ephemeral)で age だけが判定材料。asset prefix は**行が正の判定材料**: 行がある object は参照中でありうる正当データで、絶対に触らない。lane の仕事は「行の無い object」だけを、発生窓(crop の PUT→INSERT)と誤検出(listing と INSERT の race)を排除した上で回収すること。長命レーンゆえ回収を急ぐ理由が無い — 判定はすべて保守側に倒す。

### 4.2 発見と判定(三重条件 + 行不在)

1. `listObjectsWithMetaBounded('users/', 10 pages)`(bounded・truncated は記録)。
2. **key 規約**: `users/{uuidv4}/{uuidv4}.(webp|png|jpg)`(uuid は case-insensitive・拡張子/prefix は生成側固定ゆえ case-sensitive — src sweeper と同判断)。旧 `users/{uid}/src/…` 等の規約不一致は**記録のみ**(`gc-src-prefix.ts` の領分・消さない)。
3. **age > `ORPHAN_CUTOFF_MS` = 7 日**。実測窓(crop PUT→INSERT ≤ 720s / lease TTL 15 分)の ~670 倍。src の「6h = lease の 24 倍」より大きく取るのは、長命レーンで急ぐ理由が無く、crash した prepare の残骸は恒久 garbage で待っても失うものが無いため。
4. **live 判定**: その user に live upload operation が無いこと。src-sweep の `hasLiveUploadOperationForSweep` を `lib/storage/live-upload-check.ts` へ抽出し両 lane が同一定義を import(§8 の「同一 invariant は 1 定義」・`hasLiveUploadOperation`(UI 用 fail-open)は再利用禁止のまま)。**判定失敗(throw)= skip**。
5. **行不在確認を DELETE 直前に**(user 単位): `withTenantTx(userId)` で候補 `object_key IN (…)` を SELECT し、**行のある key は候補から外す**(それは asset_gc の領分)。直前性は live 判定と同じ理由(listing 時点の判定を信用しない)。

age > 7 日 + 行不在 + live 無しで「後から行が生える」経路は存在しない: 行の出現源は reserve(行が先)と crop(PUT 先だが窓 ≤ 720s、以後の 412-recovery は live operation を要する)のみ(fact-finding §3)。

### 4.3 台帳(新 workflow = `asset_orphan_scan`)

別 lane・別判定原理ゆえ workflow を分ける(4 軸相乗り禁止): **`r2_orphan_delete`**(r2 / object.delete / asset_orphan_scan / external_api_error・1 件 1 行・quota。pattern mismatch の記録もこの key に `reason` で載せる — `r2_sweep_delete` と同型)+ **`r2_orphan_incomplete`**(r2 / orphan_scan.incomplete / asset_orphan_scan / incomplete・1 run 1 行・phase = `list` / `live_check` / `list_truncated` / `deadline`)。台帳 4 entry 新設の計 = §3.5 の 2 + ここの 2。

### 4.4 §11 の「期限・滞留の検知」欄を埋める

row-less の**発見**(summary の `rowlessFound` / readback)と**回収**を同 lane が担う。観測範囲は listing 上限内の partial observation(src overdue と同じ限界・truncated で明示)。

## 5. 手動入口

### 5.1 手動 GET override(非 prod 限定・src の A1 と同型)

`?graceDays=N`(整数 ≥ 0)と `?user=<uuid>` を追加。両方 **`asset_gc` lane にのみ効く**(orphan scan は対象外・listing prefix は `users/` 全体のまま)。**`VERCEL_ENV === 'production'` では両方 400**(clamp せず reject — silent なズレを作らない)。**override の実効値は lane summary に必ず含める**(`graceDaysOverride` / `userScope` — override run と既定 run を readback で区別できること。src の `cutoffOverrideMinutes` と同型・OT 裁定 3)。これで stg の refs↔GC smoke が CC 自走可能になり(grace 0 + user scope を endpoint から)、**cron 経路の prod grace 短縮は構造的に閉じる**。dry-run param は作らない(YAGNI: 事前観測は app role SQL で可・script の dry-run も残る)。

### 5.2 手動 script の存続(論点 → 推奨 = 存続)

`scripts/gc-image-assets.ts` は thin wrapper 化して残す。理由: dry-run 観測は endpoint に無い機能 / owner 経路の調査・緊急手段 / runbook 資産 / `gc-src-prefix.ts`(手動 one-shot 存続)と同じ前例。CLI の prod ガードがローカル env unset で効かない既知の穴(smoke4 手順書 §4)は**残る** — 実効境界は従来どおり運用(env 目視 + `--user` + dry-run 先行・architecture §9)。cron 経路がこの穴を持たないことが本 sprint の前進。

## 6. 適用順序

既存規律(functions = migrate / deploy = push / policies = SQL Editor)に従う。本 sprint は **policies 変更なし・新表なし**(runbook §13 の新表手順は非該当)ゆえ 3 段のうち 2 段のみ:

1. **migration 0033 適用**(OT・`drizzle-kit migrate`)— function・additive・旧コード無影響ゆえ deploy 前でよい
2. **deploy**(OT push → Vercel)— lane code
3. 手動 GET で readback 確認 → prod は 1→2 の同順

**prod 反映時の追加確認**: ① `CRON_SECRET` が **Production scope** に登録済み(§3 sweeper と同前提・未登録は 401 でなく 500 で日次 run が毎日失敗)② asset prefix に R2 lifecycle rule が無いこと(OT dashboard 目視・§13)。iso は global-setup が実 migration を適用するため 0033 が自動で入る。

## 7. 初回 run の規模(実測 204 起点)

初回 = mark 204 件(per-user bulk UPDATE・現 3 user)で数秒。promote 0(grace 30 日)。

**30 日後に promote 204 件が一斉に `deleting` へ落ちる**が、collect は §3.3a の per-user LIMIT 20 で bound される: 202 件を持つ user は **1 run 20 件 × ~11 日**で drain する。promote 自体は単文 bulk UPDATE ゆえ集中しても数秒。1 run の実働は「列挙 + 3 user × (bulk 3 文 + 最大 20 回の R2 DELETE)」= `asset_gc` の 120s 枠に十分収まる。

**平滑化・分散機構は作らない**。理由 = LIMIT が既に平滑化そのものであり、行が durable に残る以上 drain が複数日に跨っても意図は失われない(§3.3a)。`maxDuration = 300` 不変。

## 8. 不変条件(実装が守るもの)

1. R2 DELETE → success-equivalent 確認 → 行 DELETE の順序絶対(既存・core が保持)
2. 判定失敗・age 不明・pattern 不一致・live 判定失敗 = すべて skip 側(fail-safe)
3. **行が実在する object を orphan scan は消さない**(行不在確認は DELETE 直前・per-user)
4. grace の prod 短縮は構造的拒否(cron = 定数のみ / 手動 GET = production 400 / CLI = 既存 parseGraceDays + 運用境界)
5. lane は throw しない契約(summary.error に畳む・runner の per-lane catch は契約違反の backstop)
6. 記帳失敗は recordErrors + logger(観測経路の破損を別経路で可視化)
7. HTTP 200 = runner 走破のみ(成否は lane summary を読む)
8. 判定原理はレーン別・統一は入口と観測のみ(§11 契約不変。asset prefix への lifecycle / src の行駆動化はしない)
9. **lane 予算は run 開始時刻を原点とする固定絶対 deadline**(§2.1)。先行 lane の早期完了は後続の開始を早めるが、**各 lane の絶対上限は動かない**。開始時に slice 枯渇なら `not_started`(silent skip にしない)
10. **1 user 1 run あたりの collect は `COLLECT_LIMIT_PER_USER` = 20 で bound**(§3.3a)。core は無改造で、上限・順序・timeout はすべて deps 側が持つ

## 9. テスト(実装 task が TDD で書く。pin する主張)

- **iso 新規 `tests/integration/pg/asset-gc.test.ts`(実 PG・証明の空白 #8 のクローズ条件)**:
  - A/B 2 card が同一 asset を参照 → A の refs 削除 → mark 実行 → `unreferenced_at` **立たない** → B も削除 → mark で立つ → grace 0 promote → collect(deleteObject 注入)で行消滅・`reclaimed` 計上
  - definer 関数の**両方向 pin**(OT 裁定 4): ① 作業のある user が**返る**(3 arm 各々に fixture: deleting 行 / marked 行 / mark 候補)② 作業の無い user が**返らない**(referenced ready のみの user)。片方向だけでは predicate の緩み/締まりの一方しか検出できない — 返らない側の欠陥は「その user の作業が永遠に残る」silent skip に直結するため両方向必須。+ app role が EXECUTE 可
- unit: core 移設は既存 test の import 追従のみ(**保証不変**)。lane 新規分(per-user 集約 / deadline 打ち切り / 台帳 quota / guard trip の user 単位 skip)と orphan-scan(三重条件境界 / 行あり skip / live 失敗 skip / pattern mismatch 記録のみ)は src-sweep.test.ts の idiom 踏襲
- route: `graceDays` / `user` override の受理・下限・**production 400**(cutoffMinutes test と同型)
- 変異 red: 新規 pin は gate 個別変異で red 実証(既存規律)

## 10. やらないこと

- asset prefix への lifecycle / `src/` の行駆動化(§11 禁止 2 つ)
- dedup(据え置き不変)・mark/promote の平滑化(§7 が不要と示す)・orphan scan の dry-run mode・user 処理順の starve 制御(§3.3)・`users/` listing の全域保証(bounded + truncated 記録)
- **collect の chunk 並列**(§3.3a: core 改造を要し、LIMIT 20 では実益なし)・**失敗候補の skip / backoff**(§3.3a の停滞は観測して手動介入)・**listing の checkpoint / shard**(§13 の再訪トリガー待ち)・**成功 run の heartbeat 記録**(既存「成功 run は台帳に書かない」方針と一貫。cron 死の検知は全 lane 横断の別課題)
- prod への反映判断・R2 lifecycle 実設定の readback(credential 403 のまま・別件)

## 11. 変更一覧(file 粒度)

| 種別 | file |
|---|---|
| 新規 | `drizzle/migrations/0033_*.sql`(definer 関数)/ `lib/storage/asset-gc.ts`(core 移設先 + lane)/ `lib/storage/orphan-scan.ts` / `lib/storage/live-upload-check.ts`(抽出)/ `tests/integration/pg/asset-gc.test.ts` + 各 unit test |
| 変更 | `app/api/cron/sweep/route.ts`(LANES 3 本 + override 2 param)/ `run-lanes.ts`(LaneContext 縮小)/ `lib/storage/src-sweep.ts`(live check import 先変更)/ `lib/integration-failures.ts`(catalog 4 entry)/ `scripts/gc-image-assets.ts`(thin wrapper 化)/ `scripts/gc-image-assets.test.ts`(import 追従) |
| docs | `docs/architecture.md` §11(レーン表: asset の二次回収 = cron・検知 = orphan scan)/ `docs/ops/r2-key-inventory.md`(誰が消す列)/ `docs/ops/scripts-and-seed.md`(script の位置づけ) |

## 12. 論点の裁定(OT・2026-08-10・確定)

1. **手動 script = 存続(thin wrapper 化)**。dry-run 観測は endpoint に無い機能・runbook 資産。CLI prod ガードの穴は §13 に記録(修理しない)。
2. **orphan cutoff = 7 日**。実測窓の ~670 倍・短縮の実益なし。保守側は長命レーンの性質に合う。
3. **手動 GET param 2 つ承認**(graceDays / user・非 prod 限定・production 400)。**summary に実効値必須**(§5.1 に反映済)。
4. **definer 関数 = 作業 predicate 版**。露出最小を SQL の複雑さより優先。**iso で両方向 pin 必須**(§9 に反映済)。
5. **workflow 語彙 = `asset_orphan_scan` 新設**。4 軸相乗り禁止どおり。workflow は計 8 値になる。

## 13. 限界(受容・記録)

- **CLI(手動 script)の prod ガードはローカル env unset で効かない**(smoke4 手順書 §4 の既知の穴)。修理しない — 破壊 script の機械境界は証明の空白 #5 の別件で、実効境界は従来どおり運用(env 目視 + `--user` + dry-run 先行)。**cron 経路はこの穴を持たない**(§8-4)ことが本 sprint の前進。
- orphan scan の観測範囲は listing 上限(10 page ≈ 10,000 key)内の partial observation。**上限超過時は辞書順後半が恒久的に未観測になる**(毎回 prefix 先頭から読むため前進しない)— これは「安全な部分観測」ではなく構造的な盲点。**受容する根拠 = 盲点は無音でない**: 到達時は `truncated: true` → `r2_orphan_incomplete`(phase `list_truncated`)→ Discord で毎日鳴る。**この行の出現が StartAfter shard / checkpoint 導入の再訪トリガー**(現規模 242 件では YAGNI ゆえ今回作らない)。
- **退会 asset の R2 削除期限は soft**(⌈N/20⌉ 日・§3.3a)。hard SLA ではない。SLA 化の要否は公開前 gate で判定する(法務・監査要件の具体化待ち。§11 非要件の再判定と同じ扱い)。
- **collect queue の停滞**(最古 20 件が連続失敗すると当該 user の queue を占有)は修理せず観測する。トリガー = 同一 `objectKey` の失敗行が連日出る(§3.3a)。
- prod bucket の中身・R2 lifecycle 実設定は未確認のまま(credential 403・別件)。**asset prefix に rule が無いことは repo 内記述の確認どまり**で dashboard 目視をしていない — release 前確認条件に置く(§6)。
- cron 未起動 / platform kill は本 sprint の観測系(失敗台帳のみ)では検出できない。全 lane 横断の別課題として扱う(成功 heartbeat を作らない判断は §10)。
- **row-check の deadline guard が閉じるのは「期限切れ後に次の batch を開始しない」ことだけ**で、`withTenantTx` に query timeout が無いため単一 query が長時間ブロックする経路は残り、lane 全体の hard bound は無い(OT 裁定・2026-08-10 追記)。
- **行不在確認(row-check)は orphan scan の唯一の安全弁で、backstop が無い**(final fix wave・2026-08-10 追記)。throw は skip に倒れるが、RLS の tenant context が意図と違う値で張られる等で読み取りが静かに空になると、全 key が rowless(削除対象)に見えてしまう — `asset_gc` の pre-sweep guard(`checkRefsPopulated`)に相当する同種の backstop はここには無い。緩和として per-run 削除上限(`ORPHAN_MAX_DELETE_PER_RUN` = 50)を導入し、誤判定が起きても 1 run の削除量そのものに天井を作る(実測 row-less は 0 件のため、上限到達自体が異常 signal として Discord に出る)。根本的な backstop(独立した二重判定等)の要否は再訪トリガー(§13 上記の各項と同様、恒常的な `max_delete` 到達が観測されたら)扱いとする。
