# asset レーン整合: asset GC cron 化 + orphan 走査 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。実装セッションは Opus(OT 指示)。

**Goal:** 画像 asset GC(mark/promote/collect)を日次 cron の `asset_gc` lane として自動化し、row-less orphan を `asset_orphan_scan` lane で回収する。

**Spec(確定・凍結):** `docs/superpowers/specs/2026-08-10-asset-lane-gc-design.md`(以下「spec」)。仕様変更が必要になったら停止して OT 相談。fact-finding = `docs/audit/2026-08-10-asset-lane-gc-factfinding.md`。

## Global Constraints(全 task 共通)

- 不変条件は spec §8 の 8 項(R2→確認→行 DELETE 順序 / 判定失敗は全 skip / 行実在 object を orphan scan は消さない / prod grace 短縮の構造的拒否 / lane never-throw / 記帳失敗 recordErrors / HTTP 200 = 走破のみ / 判定原理レーン別)
- 数値: grace 30 日(`DEFAULT_GRACE_DAYS` 既存)/ `ORPHAN_CUTOFF_MS` = 7 日 / budget = 既存 `SWEEP_BUDGET_MS` 270_000・TAIL 10_000・MIN_SLICE 2_000・chunk 20・listing 10 page / 台帳 quota: 実削除失敗 ≤20・行 DELETE 失敗 ≤20・pattern 不一致 ≤5・incomplete ≤1(超過は suppressed 加算)
- catalog 4 軸は spec §3.5 / §4.3 の表のとおり(`asset_gc` 既存 + `asset_orphan_scan` 新設・相乗り禁止)。context の PII は objectKey / 内部 uuid のみ
- **core(`runReconciler`)は無改造**(spec §3.1)。行 DELETE 失敗の台帳化は lane が summary `rowDeleteFailures` を後処理(Task 5)
- 予算・phase idiom は src-sweep 踏襲だが定数・phase 語彙は lane ごとに独立定義(意味が別)。**live check だけは 1 定義共有**(spec §4.2・fail-open 版 `hasLiveUploadOperation` は使用禁止)
- TDD(red→green)。時刻 `now: () => number` 注入。R2 / DB / recordIntegrationFailure は unit では mock(実 API 禁止)。iso は実 PG17
- feat commit = canonical review(requesting-code-review 既定経路)+ Codex(`scripts/ai/codex-review.sh`)pass 後 [reviewed]。commit 直前 4 点宣言。test-only 増分は red 検証 + 簡易 review
- RLS 下でも `user_id` 条件は query 側にも明示(CLAUDE.md Clerk-3)

## File Structure

- `drizzle/migrations/0033_*.sql`(create): SECURITY DEFINER 4 本目(0025 と同経路 = `drizzle-kit generate --custom` で scaffold し SQL 記述)
- `lib/storage/asset-gc.ts`(create): core 移設(types / `runReconciler` / 定数)+ `buildReconcilerDeps`(executor 注入で owner / app-role 両対応 — 判定 SQL を 1 定義に保つ。architecture §8 の契約再利用)
- `lib/storage/asset-gc-lane.ts`(create): user 列挙 + per-user 実行 + 集約 + 台帳(spec §11 は core+lane を 1 file と記載 — 責務分離のため 2 file に分割。判定 SQL 1 定義・機構は spec どおりで変更なし)
- `lib/storage/orphan-scan.ts`(create): 選定 pure 関数 + lane orchestration
- `lib/storage/live-upload-check.ts`(create): `hasLiveUploadOperationForSweep` の抽出移設
- `scripts/gc-image-assets.ts`(modify): thin CLI wrapper 化(CLI parse + owner executor bind のみ残す)
- `app/api/cron/sweep/route.ts` / `run-lanes.ts`(modify): LaneContext 縮小・LANES 3 本・override 2 param
- `lib/integration-failures.ts`(modify): catalog +4
- `tests/integration/pg/asset-gc.test.ts`(create): definer 両方向 pin + A/B 共有 pin
- docs: `docs/architecture.md` §11・空白 #8 行 / `docs/ops/r2-key-inventory.md` / `docs/ops/scripts-and-seed.md` / `docs/harness.md`

---

### Task 1: migration 0033 — `app_list_asset_gc_user_ids()` + iso 両方向 pin

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

**制約:** additive のみ(旧コード無影響)。関数コメントに「何を迂回(assets RLS の user_id 列挙のみ・行データ非返却)/ なぜ安全(uuid 集合のみ・得た uuid で他 user 行は読めない)/ cron lane 専用」を明示。3 arm は core の markSet / markClear+promote / collect の WHERE と同値であること(spec §3.2)。

**完了条件:** `tests/integration/pg/asset-gc.test.ts`(新規・第 1 部)red→green — **両方向 pin(OT 裁定 4)**: ① 返る側 3 fixture(deleting 行のみ / marked 行のみ / mark 候補のみ の各 user が返る)② 返らない側(referenced ready のみの user が**返らない**)③ app role が tenant context 無しで EXECUTE 可。red 検証(例: arm ③ を落とす変異で ① の mark 候補 fixture が fail)。canonical + Codex pass → `[reviewed]`。

### Task 2: core 移設 + deps の executor 注入化(挙動不変)

**目的:** `runReconciler` core と production deps SQL を `scripts/gc-image-assets.ts` から `lib/storage/asset-gc.ts` へ移設し、deps を接続方式非依存にする(spec §3.1。app code は scripts/ を import 不能)。

**Interfaces(Produces):**
```ts
// lib/storage/asset-gc.ts(型・runReconciler・DEFAULT_GRACE_DAYS・COLLECT_BATCH_SIZE は現行のまま export)
export type ReconcilerExec = <T>(fn: (db: TenantDb) => Promise<T>) => Promise<T>
export function buildReconcilerDeps(args: {
  exec: ReconcilerExec; userId?: string
  deleteObject: ReconcilerDeps['deleteObject']; log: (msg: string) => void
}): ReconcilerDeps
```
owner 経路 = `exec: (fn) => fn(getAdminDb())` / app 経路 = `exec: (fn) => withTenantTx(userId, fn)`。

**制約:** core・SQL 本体は verbatim 移設(判定 WHERE を 1 定義に保つ — owner/app で SQL を二重実装しない)。`parseUserFlag` / `parseGraceDays` / `main` は script に残す(CLI 固有)。script は lib から import する thin wrapper 化。`server-only` 事情(`--conditions=react-server`)は現行コメントごと維持。R2 dynamic import の分岐(collect 実行時のみ)も script 側 main の現行挙動を維持し、lane 側は静的 import(Task 5)。

**完了条件:** 既存 `scripts/gc-image-assets.test.ts` の core 対象 test を import 追従で全 green(**保証不変**・新規 assertion なし)。CLI が documented コマンド(`--dry-run --user <uuid>`)で実起動すること(feedback: mock test は起動経路を検証しない — stg 向け dry-run 1 回で確認)。挙動不変 refactor だが GC 削除経路の配線変更ゆえ canonical + Codex 実施 → `[reviewed]`。

### Task 3: catalog 新 entry 4(`lib/integration-failures.ts`)

**目的:** spec §3.5 / §4.3 の表どおり `r2_gc_row_delete` / `r2_gc_incomplete` / `r2_orphan_delete` / `r2_orphan_incomplete` を追加(workflow 8 値目 = `asset_orphan_scan`)。

**Interfaces(Produces):** `IntegrationFailureKey` に上記 4 key。4 軸: `r2_gc_row_delete` = db / asset.row.delete / asset_gc / db_error。`r2_gc_incomplete` = r2 / asset_gc.incomplete / asset_gc / incomplete。`r2_orphan_delete` = r2 / object.delete / asset_orphan_scan / external_api_error(pattern mismatch も `reason` discriminator でこの key)。`r2_orphan_incomplete` = r2 / orphan_scan.incomplete / asset_orphan_scan / incomplete。

**制約:** 既存 entry の 4 軸 tuple 不変。コメントは既存形式(spec 参照 § / なぜこの 4 軸 / context 形 / PII 制約)。`r2_gc_delete` は不変(cron 化しても workflow は変えない — spec §3.5)。

**完了条件:** `lib/integration-failures.test.ts` red→green — 件数 17→21・tuple ユニーク性・4 entry の 4 軸完全一致 assert。canonical + Codex pass → `[reviewed]`。

### Task 4: live check の抽出(`lib/storage/live-upload-check.ts`)

**目的:** `hasLiveUploadOperationForSweep` を src-sweep から抽出移設し、src_sweep / orphan_scan の 2 lane が同一定義を import する(spec §4.2)。

**Interfaces(Produces):** `export async function hasLiveUploadOperationForSweep(userId: string): Promise<boolean>`(現行 signature・意味論そのまま: 非終端 + valid lease、**throw は伝播**し呼出側が skip に倒す)。

**制約:** 実装 verbatim 移設(fail-safe 極性の説明コメントごと)。`src-sweep.ts` は import 先変更のみ。fail-open 版 `hasLiveUploadOperation`(`lib/exams/source-doc-status.ts`)には触らない。`isLiveUploadOperationCondition` の利用 site 台帳コメント(同 file `:70` 周辺)の site 数を更新。

**完了条件:** 既存 `src-sweep.test.ts` 全 green(**保証不変**)。ロジック変更なし → `[no-review]`(message に「保証不変」)。

### Task 5: `asset_gc` lane(`lib/storage/asset-gc-lane.ts`)

**目的:** 列挙 → per-user に `buildReconcilerDeps`(app executor)+ `runReconciler` → 集約 → 台帳、の lane 本体(spec §3.3〜§3.5)。

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

**制約:** 列挙 = `getNonTenantDb()` で `SELECT app_list_asset_gc_user_ids()`(pre-tenant site の理由コメント必須)。`userScope` 指定時は列挙を打たず単一 user 実行。per-user 例外(guard trip 含む)は catch → `usersSkipped` + phase `user_error` で続行。user 境界で `slice()` 確認(TAIL/MIN_SLICE は src idiom・定数は独立定義)、打ち切りは phase `deadline`。**行 DELETE 失敗の台帳化 = 後処理**: per-user summary の `rowDeleteFailures`(assetId)ごとに `withTenantTx` で `object_key` を引き `r2_gc_row_delete` 記帳(行は残存中ゆえ引ける・quota ≤20)。incomplete 1 run 1 行(phase 配列 = `['user_error', 'deadline']`・先頭優先で 1 本に統合 — src の `higherPriorityPhase` 同型・定数は独立定義)。`deleteObject` は静的 import。never-throw 契約 + 記帳個別 try/catch + `recordErrors`。lane は R2 I/O を tx に混ぜない(deps の per-op tx 構造が保証)。

**完了条件:** `lib/storage/asset-gc-lane.test.ts` red→green(runReconciler は本物・deps 相当の DB/R2 は mock)— ① 複数 user の件数集約 ② user 途中の deadline 打ち切り(後続 user 未実行 + incomplete 記帳)③ per-user throw が後続 user を巻き込まない ④ `rowDeleteFailures` → `r2_gc_row_delete` 記帳(objectKey 解決含む)⑤ 記帳 throw で `recordErrors` 加算・run 続行 ⑥ override 時のみ `graceDaysOverride` / `userScope` が summary に載る。canonical + Codex pass → `[reviewed]`。

### Task 6: `asset_orphan_scan` lane(`lib/storage/orphan-scan.ts`)

**目的:** `users/` listing → 三重条件 + 行不在確認 → DELETE(spec §4)。

**Interfaces(Produces):**
```ts
export const ORPHAN_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000
export function selectOrphanCandidates(entries: R2ObjectMeta[], nowMs: number): {
  candidates: { userId: string; keys: string[]; oldestMs: number }[] // oldest 昇順
  patternMismatch: string[]
}
export type OrphanScanSummary = {
  lane: 'asset_orphan_scan'; listed: number; candidates: number; rowSkipped: number
  deleted: number; failed: number; skippedLiveUsers: number; patternMismatch: number
  truncated: boolean; phase: string | null; recordErrors: number; error?: string
}
export async function runOrphanScanLane(args: { deadlineAt: Date; now?: () => number }): Promise<OrphanScanSummary>
```

**制約:** key 規約 = `/^users\/([^/]+)\/([^/]+)\.(webp|png|jpg)$/` + 両 uuid セグメント `z.uuid({version:'v4'})`(case-insensitive・拡張子/prefix は case-sensitive — src-sweep と同判断・local 定義踏襲)。age は `>` 比較(境界は候補外)。per-user 順序 = oldest 昇順。**判定順 = live check(throw は skip・phase `live_check`)→ 行不在確認(`withTenantTx` で候補 `object_key` を `inArray` SELECT・行のある key は `rowSkipped`)→ chunk DELETE**(行確認が DELETE に最近接 — 不変条件 3)。pattern mismatch は削除せず `r2_orphan_delete` に `reason: 'pattern_mismatch'` で記帳(≤5)。listing は `listObjectsWithMetaBounded('users/', 10, { timeoutMs: slice()/10 })`(page 単位 timeout の多重化防止・src 同型)。phase 語彙 = `list` / `live_check` / `list_truncated` / `deadline`(独立定義)。never-throw + `recordErrors`。

**完了条件:** `lib/storage/orphan-scan.test.ts` red→green — ① 三重条件の境界(age ちょうど・uuid 非 v4・`.PDF`/`.WEBP` 大文字拡張子・3 セグメント `users/{uid}/src/…` は mismatch)② **行あり key は削除されない**(inArray に載った key の DELETE 未発行を pin)③ live throw → user skip ④ deadline 打ち切り + incomplete ⑤ mismatch 記帳 quota。red 検証は gate 個別変異(age だけ壊す / 行確認だけ外す / live だけ外す)。canonical + Codex pass → `[reviewed]`。

### Task 7: cron runner 配線(`route.ts` / `run-lanes.ts`)

**目的:** LANES 3 本化・`LaneContext` を `{ deadlineAt }` に縮小・`?graceDays=` / `?user=` override(spec §2 / §5.1)。

**Interfaces(Produces):** `run-lanes.ts` の `LaneContext = { deadlineAt: Date }`。route が lane 固有 config を closure bind(`cutoffMs` 系は `runSrcSweepLane` 引数に直接渡す — 現行引数 signature 不変)。

**制約:** lane 順序 = `src_sweep` → `asset_gc` → `asset_orphan_scan`(spec §2 の v58 根拠をコメントに)。override 検証は auth 後(§3 と同順)・`VERCEL_ENV === 'production'` で両 param とも 400(`cutoff_override_forbidden` と同型の error code)・`graceDays` は整数 ≥ 0(clamp しない)・`user` は uuid v4。`maxDuration = 300` literal 不変。既定 run は `graceDays = DEFAULT_GRACE_DAYS` を lib から import して渡す。

**完了条件:** `route.test.ts` / `run-lanes.test.ts` red→green — ① 3 lane が順に走り 1 本の throw が他 lane と readback を巻き込まない(既存 stub seam)② `graceDays=0`(非 prod)が lane 引数に渡り summary に `graceDaysOverride` 出現 ③ production で `graceDays` / `user` → 400 ④ 非整数・負値 → 400 ⑤ 既存 `cutoffMinutes` test 全 green(挙動不変)。canonical + Codex pass → `[reviewed]`。

### Task 8: iso A/B 共有 pin(`tests/integration/pg/asset-gc.test.ts` 第 2 部)

**目的:** refs↔GC 整合を実 SQL で証明し空白 #8 を閉じる(spec §9・OT 裁定 4)。

**制約:** Task 2 の `buildReconcilerDeps`(app executor = `withTenantTx`)+ 本物 `runReconciler` を実 PG に対して実行(deleteObject のみ注入 stub)。fixture: 2 card が同一 asset を参照(`card_asset_refs` 2 行)。

**完了条件:** red→green — ① A の refs 削除 → mark 実行 → `unreferenced_at` **NULL のまま** ② B も削除 → mark で set ③ grace 0 promote → `deleting` ④ collect → stub deleteObject 呼出 + 行消滅 ⑤ collect 直前に refs を戻すと self-heal(`ready` 復帰・R2 未呼出)。test-only 増 = **red 検証**(mark の NOT EXISTS を外す変異で ① fail)+ 簡易 review → `[reviewed]`。

### Task 9: docs 反映

**目的:** §11 レーン表(asset の二次回収 = 日次 cron・検知 = orphan scan)+ 空白 #8 行に手当て(iso pin)を記録・`r2-key-inventory.md` の「誰が消す」列・`scripts-and-seed.md`(script = thin wrapper・調査/緊急用)・`harness.md`(cron lane 3 本)。

**制約:** §11 の「やってはいけない 2 つ」「非対称の理由」は不変。件数・数値は書かない(正本参照)。

**完了条件:** 上記 4 file 更新 + `docs(_)` `[no-review]` commit。

## Sprint 完了 gate(恒久規律)

whole-repo `pnpm lint`(--max-warnings=0)exit 0 / `pnpm test:iso` green / `pnpm run audit` exit 0 / `pnpm test` 全通過。報告 chat に 3 宣言行(lint / test:iso / audit)。review dispatch の観点 list に whole-repo lint 確認を含める。

## 実装後(plan 外・OT 管理)

- **OT 作業(適用順序・spec §6)**: stg = migration 0033 適用(migrate)→ push/deploy(policies 変更なし)。prod = 同順 + **`CRON_SECRET` が Production scope 登録済みであることの確認**(未登録は 500)
- CC stg smoke(OT 指示後): 手動 GET `?graceDays=0&user=<test-uuid>` で refs↔GC smoke(smoke4 手順書 §8 の判定基準・事前 gate `referenced > 0` を app-role SQL で確認)+ orphan lane readback(`rowSkipped` ≈ listed・deleted = 0)
- 30 日後の初回 promote+collect 集中(~204 件)は readback / incomplete で観測(spec §7・§13)
