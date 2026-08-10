# asset レーン整合: asset GC cron 化 + orphan 走査 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。実装セッションは Opus(OT 指示)。

**Goal:** 画像 asset GC(mark/promote/collect)を日次 cron の `asset_gc` lane として自動化し、row-less orphan を `asset_orphan_scan` lane で回収する。

**Spec(確定・凍結):** `docs/superpowers/specs/2026-08-10-asset-lane-gc-design.md`(以下「spec」)。**Codex cross-check 反映 amend 済**(§2.1 / §3.3a / §7 / §13)。仕様変更が必要になったら停止して OT 相談。fact-finding = `docs/audit/2026-08-10-asset-lane-gc-factfinding.md` / cross-check 突き合わせ = `docs/superpowers/sessions/2026-08-10-asset-lane-gc-plan-crosscheck.md`。

## Global Constraints(全 task 共通)

- 不変条件は spec §8 の 10 項(R2→確認→行 DELETE 順序 / 判定失敗は全 skip / 行実在 object を orphan scan は消さない / prod grace 短縮の構造的拒否 / lane never-throw / 記帳失敗 recordErrors / HTTP 200 = 走破のみ / 判定原理レーン別 / **per-lane 固定絶対 deadline + not_started** / **collect は per-user LIMIT 20 で bound**)
- 数値: grace 30 日(既存 `DEFAULT_GRACE_DAYS`)/ `ORPHAN_CUTOFF_MS` = 7 日 / **`COLLECT_LIMIT_PER_USER` = 20** / lane deadline = src `start+90s` / asset_gc `start+210s` / orphan `start+260s`(`maxDuration` 300 不変)/ TAIL 10_000・MIN_SLICE 2_000・listing 10 page / 台帳 quota: 実削除失敗 ≤20・行 DELETE 失敗 ≤20・pattern 不一致 ≤5・incomplete ≤1(超過は suppressed 加算)
- catalog 4 軸は spec §3.5 / §4.3 の表のとおり(`asset_gc` 既存 + `asset_orphan_scan` 新設・相乗り禁止)
- **core(`runReconciler`)は無改造**(spec §3.1)。boundedness・順序・timeout・記帳 guard は**すべて deps 側**(spec §3.3a)。**collect の chunk 並列は実装しない**
- 予算・phase idiom は src-sweep 踏襲だが定数・phase 語彙は lane ごとに独立定義(意味が別)。**live check だけは 1 定義共有**(spec §4.2・fail-open 版 `hasLiveUploadOperation` は使用禁止)
- TDD(red→green)。時刻 `now: () => number` 注入。R2 / DB / recordIntegrationFailure は unit では mock(実 API 禁止)。iso は実 PG17
- feat commit = canonical review(requesting-code-review 既定経路)+ Codex(`scripts/ai/codex-review.sh`)pass 後 [reviewed]。commit 直前 4 点宣言。test-only 増分は red 検証 + 簡易 review
- RLS 下でも `user_id` 条件は query 側にも明示(CLAUDE.md Clerk-3)

## File Structure

- `drizzle/migrations/0033_*.sql`(create): SECURITY DEFINER 4 本目(`drizzle-kit generate --custom` で scaffold し SQL 記述)
- `lib/storage/asset-gc.ts`(create): core 移設(types / `runReconciler` / 定数)+ `buildReconcilerDeps`(executor 注入で owner / app-role 両対応 — 判定 SQL を 1 定義に保つ。architecture §8 の契約再利用)
- `lib/storage/asset-gc-lane.ts`(create): user 列挙 + per-user 実行 + 集約 + 台帳(spec §11 は core+lane を 1 file と記載 — 責務分離のため 2 file に分割。判定 SQL 1 定義・機構は spec どおりで変更なし)
- `lib/storage/orphan-scan.ts`(create): 選定 pure 関数 + lane orchestration
- `lib/storage/live-upload-check.ts`(create): `hasLiveUploadOperationForSweep` の抽出移設
- `scripts/gc-image-assets.ts`(modify): thin CLI wrapper 化(CLI parse + owner executor bind のみ残す)
- `app/api/cron/sweep/route.ts` / `run-lanes.ts`(modify): per-lane deadline 配分・LANES 3 本・override 3 param
- `lib/integration-failures.ts`(modify): catalog +4
- `tests/integration/pg/asset-gc.test.ts`(create): definer hardening + oracle 同値性 + A/B 共有 pin
- docs: `docs/architecture.md` §11・空白 #8 行 / `docs/ops/r2-key-inventory.md` / `docs/ops/scripts-and-seed.md` / `docs/harness.md`

---

### Task 1: migration 0033 — `app_list_asset_gc_user_ids()` + iso pin(両方向 + hardening + oracle)

**目的:** GC 作業のある user_id のみ返す SECURITY DEFINER 関数を追加(spec §3.2)。

**Interfaces(Produces):**
```sql
CREATE OR REPLACE FUNCTION public.app_list_asset_gc_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT a.user_id FROM public.assets a
  WHERE a.status IN ('deleting','deleted')
     OR a.unreferenced_at IS NOT NULL
     OR (a.status IN ('reserved','ready') AND a.unreferenced_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.card_asset_refs r WHERE r.asset_id = a.id));
$$;
```
+ `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE … TO recallmint_app`(0025 の 3 本と同型)。

**制約:** additive のみ(旧コード無影響)。関数コメントに「何を迂回(assets RLS の user_id 列挙のみ・行データ非返却)/ なぜ安全(uuid 集合のみ・得た uuid で他 user 行は読めない = **呼出側が必ず tenant tx を使うことに依存**する旨も明記)/ cron lane 専用」。3 arm は core の markSet / markClear+promote / collect の WHERE と同値。

**完了条件:** `tests/integration/pg/asset-gc.test.ts`(新規・第 1 部)red→green:
- **両方向 pin**(OT 裁定 4): ① 返る側 3 fixture(deleting 行のみ / marked 行のみ / mark 候補のみ)② 返らない側(referenced ready のみの user が返らない)
- **hardening pin**(B-1・Codex 指摘 11): PUBLIC に EXECUTE 権が無い / app role は EXECUTE 可 / 関数 owner = `postgres` / `prosecdef` true / `proconfig` に `search_path=public`(`pg_proc` 直読で assert)
- **oracle 同値性 pin**(B-2・Codex 指摘 12): owner 接続で全 `assets` を走査し「core が作業対象にする行を持つ user 集合」を SQL で独立に導出 → 関数結果と**集合一致**を assert。fixture は 5 状態(3 arm + deleted-only + referenced-ready-only)。core predicate だけ変わる drift を検出する恒久 pin
- red 検証(gate 個別変異): arm ③ を落とす変異で mark 候補 fixture が fail / arm ① を落とす変異で deleting fixture が fail

canonical + Codex pass → `[reviewed]`。

### Task 2: core 移設 + deps の executor/bounded 注入化

**目的:** `runReconciler` core と production deps SQL を `lib/storage/asset-gc.ts` へ移設し、deps を接続方式非依存かつ bounded にする(spec §3.1 / §3.3a)。

**Interfaces(Produces):**
```ts
export const COLLECT_LIMIT_PER_USER = 20
export type ReconcilerExec = <T>(fn: (db: TenantDb) => Promise<T>) => Promise<T>
export function buildReconcilerDeps(args: {
  exec: ReconcilerExec
  userId?: string
  collectLimit?: number                    // 省略 = 無制限(CLI 既定・現行挙動)
  deleteObject: ReconcilerDeps['deleteObject']
  onRecordError?: () => void               // 記帳失敗の集約 hook(B-4)
  log: (msg: string) => void
}): ReconcilerDeps
```
owner 経路 = `exec: (fn) => fn(getAdminDb())` / app 経路 = `exec: (fn) => withTenantTx(userId, fn)`。

**制約:**
- core・判定 SQL 本体は verbatim 移設(owner/app で SQL を二重実装しない)。`parseUserFlag` / `parseGraceDays` / `main` は script に残す(CLI 固有)
- `fetchCollectCandidates` に **`ORDER BY unreferenced_at NULLS FIRST, created_at, id` + `LIMIT collectLimit`**(`collectLimit` 未指定なら LIMIT 無し = 現行挙動)。NULLS FIRST の理由 = 退会由来(`unreferenced_at` NULL の `deleting`)を最優先で回収
- `recordFailure` deps を内部 try/catch で包み、失敗時に `onRecordError?.()`(**B-4**: core 無改造のまま lane が `recordErrors` を集約できる唯一の seam)
- `server-only` 事情(`--conditions=react-server`)は現行コメントごと維持。R2 dynamic import の分岐は script 側 main の現行挙動を維持し、lane 側は静的 import(Task 5)

**完了条件:** 既存 `scripts/gc-image-assets.test.ts` の core 対象 test を import 追従で全 green(**保証不変**)+ 新規 assertion(`collectLimit` 指定時に LIMIT/ORDER BY が発行される / 未指定で現行 SQL と同一 / `onRecordError` が記帳 throw 時に呼ばれる)は red→green。CLI を documented コマンド(`--dry-run --user <uuid>`)で**実起動**して確認(feedback: mock test は起動経路を検証しない)。canonical + Codex pass → `[reviewed]`。

### Task 3: catalog 新 entry 4(`lib/integration-failures.ts`)

**目的:** spec §3.5 / §4.3 の表どおり 4 key を追加(workflow 8 値目 = `asset_orphan_scan`)。

**Interfaces(Produces):** `IntegrationFailureKey` に `r2_gc_row_delete` = db / asset.row.delete / asset_gc / db_error。`r2_gc_incomplete` = r2 / asset_gc.incomplete / asset_gc / incomplete。`r2_orphan_delete` = r2 / object.delete / asset_orphan_scan / external_api_error(pattern mismatch も `reason` discriminator でこの key)。`r2_orphan_incomplete` = r2 / orphan_scan.incomplete / asset_orphan_scan / incomplete。

**制約:** 既存 entry の 4 軸 tuple 不変。コメントは既存形式(spec 参照 § / なぜこの 4 軸 / context 形 / PII 制約)。`r2_gc_delete` は不変(spec §3.5)。

**完了条件:** `lib/integration-failures.test.ts` red→green — 件数 17→21・tuple ユニーク性・4 entry の 4 軸完全一致 assert(件数変遷コメント追記)。canonical + Codex pass → `[reviewed]`。

### Task 4: live check の抽出(`lib/storage/live-upload-check.ts`)

**目的:** `hasLiveUploadOperationForSweep` を src-sweep から抽出移設し、2 lane が同一定義を import(spec §4.2)。

**Interfaces(Produces):** `export async function hasLiveUploadOperationForSweep(userId: string): Promise<boolean>`(現行 signature・意味論そのまま: 非終端 + valid lease、**throw は伝播**し呼出側が skip に倒す)。

**制約:** 実装 verbatim 移設(fail-safe 極性の説明コメントごと)。`src-sweep.ts` は import 先変更のみ。fail-open 版 `hasLiveUploadOperation`(`lib/exams/source-doc-status.ts`)には触らない。`isLiveUploadOperationCondition` の利用 site 台帳コメント(同 file `:70` 周辺)の site 数を更新。

**完了条件:** 既存 `src-sweep.test.ts` 全 green(**保証不変**)。ロジック変更なし → `[no-review]`(message に「保証不変」)。

### Task 5: `asset_gc` lane(`lib/storage/asset-gc-lane.ts`)

**目的:** 列挙 → per-user に bounded deps + `runReconciler` → 集約 → 台帳(spec §3.3〜§3.5)。

**Interfaces(Produces):**
```ts
export type AssetGcSummary = {
  lane: 'asset_gc'; usersListed: number; usersProcessed: number; usersSkipped: number
  scanned: number; referenced: number; marked: number; cleared: number; promoted: number
  r2DeleteOk: number; r2Delete404: number; r2DeleteFailed: number
  rowDeleteOk: number; rowDeleteFailed: number; deletedLaneProcessed: number
  selfHealed: number; unknownStatus: number; phase: string | null; recordErrors: number
  graceDaysOverride?: number; userScope?: string; error?: string
}
export async function runAssetGcLane(args: {
  deadlineAt: Date; graceDays: number; graceDaysOverride?: number
  userScope?: string; now?: () => number
}): Promise<AssetGcSummary>
```

**制約:**
- 列挙 = `getNonTenantDb()` で `SELECT * FROM app_list_asset_gc_user_ids()`(pre-tenant site の理由コメント必須)。`userScope` 指定時は列挙を打たず単一 user 実行
- per-user に `buildReconcilerDeps({ exec: withTenantTx bind, userId, collectLimit: COLLECT_LIMIT_PER_USER, deleteObject: (k) => deleteObject(k, { timeoutMs: Math.min(DELETE_TIMEOUT_MS, slice()) }), onRecordError: () => recordErrors++ })`
- per-user 例外(guard trip 含む)は catch → `usersSkipped` + phase `user_error` で続行
- **deadline 確認は user 境界のみ**(B-9: core 内部には入れない)。打ち切りは phase `deadline`
- **行 DELETE 失敗の台帳化**: per-user summary の `rowDeleteFailures`(assetId)ごとに `withTenantTx` で `object_key` を引き `r2_gc_row_delete` 記帳(quota ≤20)。**再検索が失敗/0 行なら `objectKey: null` で記帳**(B-3: 失敗事実を落とさない)
- incomplete 1 run 1 行(phase 配列 = `['user_error', 'deadline']`・先頭優先で統合 — src の `higherPriorityPhase` 同型・定数は独立定義)
- never-throw 契約 + 記帳個別 try/catch + `recordErrors`。`deleteObject` は静的 import

**完了条件:** `lib/storage/asset-gc-lane.test.ts` red→green(runReconciler は本物・DB/R2 は mock)— ① 複数 user の件数集約 ② **user 境界**の deadline 打ち切り(後続 user 未実行 + incomplete 記帳)③ per-user throw が後続 user を巻き込まない ④ `rowDeleteFailures` → `r2_gc_row_delete` 記帳(objectKey 解決成功 / 解決失敗 → null の両方)⑤ 記帳 throw で `recordErrors` 加算・run 続行 ⑥ override 時のみ `graceDaysOverride` / `userScope` が summary に載る ⑦ `collectLimit` が deps に渡り 1 user 21 件目が当 run で処理されない。canonical + Codex pass → `[reviewed]`。

### Task 6: `asset_orphan_scan` lane(`lib/storage/orphan-scan.ts`)

**目的:** `users/` listing → 三重条件 + 行不在確認 → DELETE(spec §4)。

**Interfaces(Produces):**
```ts
export const ORPHAN_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000
export const ORPHAN_ROW_CHECK_BATCH = 500
export function selectOrphanCandidates(entries: R2ObjectMeta[], nowMs: number): {
  candidates: { userId: string; keys: string[]; oldestMs: number }[] // oldest 昇順
  patternMismatch: string[]
}
export type OrphanScanSummary = {
  lane: 'asset_orphan_scan'; listed: number
  candidates: number   // object 数: age + key 規約を通過(**行確認前**)
  rowSkipped: number   // object 数: assets 行が実在したため除外
  rowless: number      // object 数: 行不在確認を通過した実 orphan(= DELETE 対象)
  deleted: number; failed: number
  skippedLiveUsers: number  // **user 数**(他 field と単位が違う)
  patternMismatch: number; truncated: boolean
  phase: string | null; recordErrors: number; error?: string
}
export async function runOrphanScanLane(args: { deadlineAt: Date; now?: () => number }): Promise<OrphanScanSummary>
```

**制約:**
- key 規約 = `/^users\/([^/]+)\/([^/]+)\.(webp|png|jpg)$/` + 両 uuid セグメント `z.uuid({version:'v4'})`(case-insensitive・拡張子/prefix は case-sensitive — src-sweep と同判断・local 定義踏襲)。age は `>` 比較(境界は候補外)。per-user 順序 = oldest 昇順
- **判定順 = live check(throw は skip・phase `live_check`)→ 行不在確認 → chunk DELETE**(行確認が DELETE に最近接 — 不変条件 3)
- 行不在確認は `withTenantTx(userId)` で候補 `object_key` を `inArray` SELECT、**`ORPHAN_ROW_CHECK_BATCH` = 500 key ずつ分割**(B-5: SQL parameter 上限 / statement size)。行のある key は `rowSkipped` に計上して候補から除外
- pattern mismatch は削除せず `r2_orphan_delete` に `reason: 'pattern_mismatch'` で記帳(≤5)
- listing は `listObjectsWithMetaBounded('users/', 10, { timeoutMs: Math.floor(slice()/10) })`(page 単位 timeout の多重化防止・src 同型)。`truncated` は phase `list_truncated`
- phase 語彙 = `['list', 'live_check', 'list_truncated', 'deadline']`(独立定義・先頭優先)。never-throw + `recordErrors`

**完了条件:** `lib/storage/orphan-scan.test.ts` red→green — ① 三重条件の境界(age ちょうど / uuid 非 v4 / `.WEBP` 大文字拡張子 / 3 セグメント `users/{uid}/src/…` は mismatch)② **行あり key は削除されない**(`rowSkipped` 計上 + 当該 key の `deleteObject` 未発行を pin)③ live throw → user skip・DELETE 未発行 ④ 501 件超の候補で行確認が 500 ずつ 2 回に分かれる ⑤ deadline 打ち切り + incomplete ⑥ mismatch 記帳 quota ⑦ `candidates` / `rowSkipped` / `rowless` の関係(`rowless = candidates − rowSkipped − live skip 分`)。red 検証は gate 個別変異(age だけ壊す / 行確認だけ外す / live だけ外す)。canonical + Codex pass → `[reviewed]`。

### Task 7: cron runner 配線(`route.ts` / `run-lanes.ts`)

**目的:** LANES 3 本化・**per-lane 固定絶対 deadline 配分 + `not_started`**・override 3 param(spec §2.1 / §5.1)。

**Interfaces(Produces):**
```ts
// run-lanes.ts
export type LaneContext = { deadlineAt: Date }
export type CronLane = { name: string; deadlineOffsetMs: number; run: (ctx: LaneContext) => Promise<LaneSummary> }
export type LaneSummary = { lane: string; error?: string; notStarted?: true }
export async function runLanes(lanes: CronLane[], startMs: number, now?: () => number): Promise<LaneSummary[]>
```

**制約:**
- **deadline は run 開始時刻 `startMs` からの固定オフセット**(src 90_000 / asset_gc 210_000 / orphan 260_000)。`runLanes` が各 lane に `new Date(startMs + lane.deadlineOffsetMs)` を渡す。**早く終わった lane の余りは後続の開始を早めるが、後続の絶対上限は動かない**(オフセットは原点固定)— この意図をコメントに 1 行明記
- lane 起動前に `startMs + offset − now() < MIN_SLICE` なら **起動せず `{ lane, notStarted: true }`** を push(spec §2.1)
- lane 順序 = `src_sweep` → `asset_gc` → `asset_orphan_scan`(spec §2 の v58 根拠をコメントに)。lane 固有 config は route が closure bind(`runSrcSweepLane` の引数 signature は不変)
- override は auth 後に検証(§3 と同順)・`VERCEL_ENV === 'production'` で **3 param とも 400**。`graceDays` は整数 ≥ 0(clamp しない)/ `user` は uuid v4 / **`lane` は lane 名の allowlist(カンマ区切り複数可)**(B-10: smoke で他 lane の実削除を巻き込まない)。cron(無 param)は常に全 lane
- `maxDuration = 300` literal 不変。既定 `graceDays = DEFAULT_GRACE_DAYS` を lib から import

**完了条件:** `route.test.ts` / `run-lanes.test.ts` red→green — ① 3 lane が順に走り 1 本の throw が他 lane と readback を巻き込まない(既存 stub seam)② 各 lane が **開始時刻由来の固定 deadline** を受け取る(先行 lane が長引いても後続の deadline 値が動かないことを固定 `now` で pin)③ 予算枯渇 lane が `notStarted: true` で **run されない** ④ `graceDays=0`(非 prod)が lane に渡り summary に `graceDaysOverride` 出現 ⑤ production で `graceDays` / `user` / `lane` → 400 ⑥ 非整数・負値・未知 lane 名 → 400 ⑦ `lane=asset_gc` 指定時に他 2 lane が走らない ⑧ 既存 `cutoffMinutes` test 全 green。canonical + Codex pass → `[reviewed]`。

### Task 8: iso A/B 共有 pin(`tests/integration/pg/asset-gc.test.ts` 第 2 部)

**目的:** refs↔GC 整合を実 SQL で証明し空白 #8 を閉じる(spec §9・OT 裁定 4)。

**制約:** Task 2 の `buildReconcilerDeps`(app executor = `withTenantTx`)+ 本物 `runReconciler` を実 PG に対して実行(`deleteObject` のみ注入 stub)。fixture: 2 card が同一 asset を参照(`card_asset_refs` 2 行)。

**完了条件:** red→green — ① A の refs 削除 → mark 実行 → `unreferenced_at` **NULL のまま** ② B も削除 → mark で set ③ grace 0 promote → `deleting` ④ collect → stub `deleteObject` 呼出 + 行消滅 ⑤ collect 直前に refs を戻すと self-heal(`ready` 復帰・R2 未呼出)。test-only 増 = **red 検証**(mark の NOT EXISTS を外す変異で ① fail)+ 簡易 review → `[reviewed]`。

### Task 9: docs 反映

**目的:** §11 レーン表(asset の二次回収 = 日次 cron・検知 = orphan scan)+ 空白 #8 行に手当て(iso pin)を記録・`r2-key-inventory.md` の「誰が消す」列・`scripts-and-seed.md`(script = thin wrapper・調査/緊急用)・`harness.md`(cron lane 3 本 + per-lane deadline)。

**制約:** §11 の「やってはいけない 2 つ」「非対称の理由」は不変。件数・数値は書かない(正本参照)。**回収レートが soft(≥20/user/day)である事実を §11 に 1 行**(「日次で消える」と読める書き方をしない)。

**完了条件:** 上記 4 file 更新 + `docs(_)` `[no-review]` commit。

## Sprint 完了 gate(恒久規律)

whole-repo `pnpm lint`(--max-warnings=0)exit 0 / `pnpm test:iso` green / `pnpm run audit` exit 0 / `pnpm test` 全通過 / **`pnpm build` exit 0**(B-7: route segment config・`server-only`・静的 R2 import を触るため。unit/lint では検出不能な class)。報告 chat に 4 宣言行(lint / test:iso / audit / build)。review dispatch の観点 list にも whole-repo lint 実行確認を含める。

## 観測(運用開始後に見るもの・spec §13)

- **collect queue の停滞**: `r2_gc_delete` / `r2_gc_row_delete` に**同一 `objectKey` の失敗行が連日出る** = 最古 20 件が当該 user の queue を恒久占有している。skip/backoff は実装しない(spec §3.3a)ので、これが**手動介入のトリガー**
- **listing 盲点**: `r2_orphan_incomplete` の phase `list_truncated` = 10 page 上限到達。**StartAfter shard / checkpoint 導入の再訪トリガー**
- **lane starvation**: `notStarted` が連日立つ lane
- **初回 mark**: 実測起点 204 件(spec §7)。30 日後の drain は ~11 日かける想定

## 実装後(plan 外・OT 管理)= release checklist

**OT 作業(適用順序・spec §6 = 既存規律 functions → deploy → policies のうち policies は非該当)**:
1. stg: migration 0033 適用(`drizzle-kit migrate`)→ **適用実測**(app role で `SELECT * FROM app_list_asset_gc_user_ids()` が通り、PUBLIC には権が無いこと)
2. stg: push / deploy
3. **prod 反映時**: 同順 + ① `CRON_SECRET` が **Production scope** 登録済み(未登録は 500 で日次 run が毎日失敗)② asset prefix に R2 lifecycle rule が無いことを dashboard 目視(spec §13)

**CC stg smoke(OT 指示後)**:
- refs↔GC: 手動 GET `?lane=asset_gc&graceDays=0&user=<test-uuid>`(smoke4 手順書 §8 の判定基準・**事前 gate `referenced > 0`** を app-role SQL で確認)
- orphan: `?lane=asset_orphan_scan` の readback(`rowSkipped` ≈ `candidates`・`rowless` = 0・`deleted` = 0 を期待 = 現物 row-less 0 件と整合)
- cron 発火の readback(schedule 到来後の lane summary 3 本 + `notStarted` 不在)
