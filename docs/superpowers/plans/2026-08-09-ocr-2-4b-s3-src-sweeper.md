# ②-4b §3: `src/` age-based sweeper 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。実装セッションは Opus(OT 指示)。

**Goal:** `src/` prefix の期限超過 object を日次 Vercel Cron で回収し、72h 超残存を alert する汎用 cron runner + `src_sweep` lane を実装する。

**Spec(確定・凍結):** `docs/superpowers/specs/2026-08-09-ocr-2-4b-s3-src-sweeper-design.md`(以下「spec」。§番号は spec 参照)。仕様変更が必要になったら停止して OT 相談。

## Global Constraints(全 task 共通)

- 不変条件は spec §7 の 10 項(age 不明は消さない / 二重関門 case-insensitive / live-op 除外は DELETE batch 直前 / overdue は DELETE 前 snapshot・閾値 cutoff 独立 / lane never-throw / 記帳個別 try/catch + `recordErrors` / 空 secret 401・auth 先行 / production override 400 / quota 種別独立 / 既存 listObjects 系 signature・挙動不変)
- 数値: cutoff 6h / ALERT 72h / override 下限 15min(未満・非整数・**production tier** = 400)/ maxDuration 300(literal)/ SWEEP_BUDGET_MS 270_000 / TAIL_RESERVE 10_000 / MIN_SLICE 2_000 / DELETE_CHUNK 20 / MAX_LIST_PAGES 10 / MAX_DELETE_FAILURE_ROWS 20 / MAX_MISMATCH_ROWS 5
- 台帳行 quota(spec §3.5・種別独立): 実削除失敗 ≤20 / pattern 不一致 ≤5 / overdue ≤1 / incomplete ≤1(overdue・incomplete は枠外)。超過分は incomplete の `suppressedFailures`。**heldFailure は採らない**(§2 実装は不変)
- catalog 4 軸は spec §3.5 の表のとおり(workflow = `src_sweep`・相乗り禁止)。context の PII は objectKey / 内部 uuid のみ
- §2 idiom を踏襲するが定数・phase 語彙は sweeper 側で独立定義(import 共有しない — rule of three 未満・意味が別)
- TDD(red→green)。時刻は `now: () => number` 注入(実 sleep 禁止)。R2 / DB / recordIntegrationFailure は mock(実 API 禁止)
- feat commit = canonical review(requesting-code-review 既定経路)+ Codex(`scripts/ai/codex-review.sh`)pass 後 [reviewed]。commit 直前の 4 点宣言
- sentinel 順序則(spec §8): §4 判定記録完了まで実削除 smoke 禁止・stg に CRON_SECRET を設定しない

## File Structure

- `lib/storage/r2.ts`(modify): parse を `<Contents>` 単位に拡張 + `listObjectsWithMetaBounded` 追加
- `lib/storage/src-sweep.ts`(create): 選定 pure 関数 + lane orchestration(infra 層・domain aggregate 非該当)
- `app/api/cron/sweep/route.ts`(create): 汎用 runner + auth + override parse
- `lib/integration-failures.ts`(modify): catalog +3
- `vercel.json` / `.env.example`(modify): crons / `CRON_SECRET=`(route と同 commit)
- docs: `docs/architecture.md` source 行 / `docs/harness.md`

---

### Task 1: listing の LastModified 拡張(`lib/storage/r2.ts`)

**目的:** `parseListObjectsPage` を `<Contents>` block 単位の Key + LastModified 抽出に拡張し、`listObjectsWithMetaBounded` を公開する(spec §3.2)。

**Interfaces(Produces):**
```ts
export type R2ObjectMeta = { key: string; lastModifiedMs: number }
export async function listObjectsWithMetaBounded(
  prefix: string, maxPages: number, opts?: { timeoutMs?: number },
): Promise<{ entries: R2ObjectMeta[]; truncated: boolean }>
```

**制約:** 既存 `listObjects` / `listObjectsBounded` の signature・挙動不変(既存 test green が regression pin・不変条件 8)。`<Contents>` 内に parse 不能な `LastModified` があれば page 全体を失敗(throw)にする fail-closed(不変条件 1)。pagination(continuation-token 前進検証・truncated)は既存実装を共有し二重実装しない。

**完了条件:** `lib/storage/r2.test.ts` に red→green で追加 — ① Contents 単位の Key/LastModified 対応付け(順序入替 XML でも組が崩れない)② parse 契約 = `Date.parse` が NaN を返す値(欠落・非 ISO・空文字)は page throw、正例は R2 実形式 `2026-08-09T01:09:31.220Z` ③ truncated / token 前進の既存挙動が entries 版でも成立 ④ 既存 test 全 green(Key 抽出仕様は escape 含め不変)。canonical + Codex pass → `[reviewed]`。

### Task 2: catalog 新 entry 3(`lib/integration-failures.ts`)

**目的:** spec §3.5 の表どおり `r2_sweep_delete` / `r2_sweep_incomplete` / `r2_sweep_overdue` を追加(workflow = `src_sweep` 新値)。

**Interfaces(Produces):** `IntegrationFailureKey` に上記 3 key。4 軸は spec §3.5 の表の値そのまま。

**制約:** 既存 entry の 4 軸 tuple 不変(stable identifier)。catalog コメントは既存形式(spec 参照 § / なぜこの 4 軸か / context = { ... } / PII 制約)。`r2_sweep_delete` のコメントに `reason: 'pattern_mismatch'` の構造化 discriminator 説明(§2 の `prefix_mismatch` と同形)。

**完了条件:** `lib/integration-failures.test.ts` red→green — 件数 14→17・tuple ユニーク性・3 entry の 4 軸完全一致 assert(件数変遷コメント追記)。canonical + Codex pass → `[reviewed]`。

### Task 3: 選定 pure 関数(`lib/storage/src-sweep.ts` 前半)

**目的:** listing snapshot から「削除候補(user 別)/ pattern 不一致 / overdue」を計算する pure 関数(spec §3.2, §3.3, §3.6。I/O なし・test 厚く)。

**Interfaces(Produces):**
```ts
export const SWEEP_CUTOFF_MS = 6 * 60 * 60 * 1000
export const ALERT_AGE_MS = 72 * 60 * 60 * 1000
export type SweepSelection = {
  // oldest 昇順(最古候補を持つ user が先)— deadline 打ち切り時に最古 garbage を優先し、
  // 毎回同じ後半 user が打ち切られる形にしない(Codex 論点採用)
  candidates: { userId: string; keys: string[]; oldestMs: number }[]
  patternMismatch: string[]                // age > cutoff だが key 規約非一致(削除しない・記録のみ)
  overdue: { count: number; oldestKey: string; oldestAgeHours: number } | null
}
export function selectSweepTargets(
  entries: R2ObjectMeta[], nowMs: number, cutoffMs: number,
): SweepSelection
```

**制約:** key 関門 = `^src/{uuid}/{uuid}/{uuid}\.pdf$` を **case-insensitive** で照合(A6・OT 裁定: `z.uuid` は大文字 hex を通すため小文字限定だと正規 object を恒久 skip する)。overdue は **cutoffMs でなく ALERT_AGE_MS 固定**で評価(OT 裁定: override の影響を受けない・不変条件 4 の「DELETE 前 snapshot」はこの関数が listing 直後に呼ばれることで成立)。age ちょうど cutoff は候補外(`>` 比較)。

**完了条件:** `lib/storage/src-sweep.test.ts` red→green — ① cutoff 境界(±1ms)② pattern 不一致の分離(似て非なる key: `.PDF` 拡張子 / セグメント欠落 / 旧経路 `users/...` / uuid 非形式)+ **大文字 uuid = 一致の正例**(A6)③ user 別グルーピング + oldest 昇順 ④ overdue: 72h±1ms 境界・oldest 選定・0 件で null・**cutoffMs を 15min に縮めても overdue 判定不変**。red 検証は gate 個別変異(まとめ壊し禁止)。canonical + Codex pass → `[reviewed]`。

### Task 4: lane orchestration(`lib/storage/src-sweep.ts` 後半)

**目的:** listing → 選定 → overdue 記帳 → user 単位 live-op 除外 → 予算付き chunk DELETE → 失敗記帳、を never-throw で回す lane 本体(spec §3.3, §3.4, §3.5)。

**Interfaces(Consumes):** Task 1 の `listObjectsWithMetaBounded` / Task 2 の catalog key / Task 3 の `selectSweepTargets` / 既存 `deleteObject`・`recordIntegrationFailure`・`withTenantTx`・`isLiveUploadOperationCondition`。
**Interfaces(Produces):**
```ts
export type SrcSweepSummary = {
  lane: 'src_sweep'; listed: number; candidates: number; deleted: number
  failed: number; skippedLiveUsers: number; patternMismatch: number
  overdueCount: number; truncated: boolean; phase: string | null
  recordErrors: number  // 記帳(recordIntegrationFailure)自体の失敗数 — alert 経路の劣化を summary で可視化(Codex 論点採用)
  cutoffOverrideMinutes?: number; error?: string
}
export async function runSrcSweepLane(args: {
  deadlineAt: Date; cutoffMs: number; cutoffOverrideMinutes?: number
  now?: () => number
}): Promise<SrcSweepSummary>
```

**制約:** live 除外 = 各 user の DELETE batch **直前**に `withTenantTx(userId, tx => EXISTS(live 条件 AND user_id = userId))`(不変条件 3・判定失敗も skip = phase `live_check`)。phase 語彙 `['list', 'live_check', 'list_truncated', 'deadline']`(配列順 = 優先順位・§2 idiom)。記帳は §2 `recordSrcPurgeRow` 同形の個別 try/catch ラッパ(不変条件 6)+ 失敗時 `recordErrors++`。**quota は種別独立**(実失敗 ≤20 / mismatch ≤5 / overdue ≤1 / incomplete ≤1・超過は `suppressedFailures` へ)。`patternMismatch` の各 key は DELETE 未試行のまま `r2_sweep_delete` + `reason: 'pattern_mismatch'` で 1 件 1 行記帳(mismatch 枠 5 を消費)。overdue 記帳 context に `partial: truncated`(A3)。listing は `listObjectsWithMetaBounded('src/', MAX_LIST_PAGES=10)`・LIST / DELETE の timeoutMs は残 slice で cap(§2 idiom)。workDeadline = `deadlineAt - TAIL_RESERVE(10s)`・chunk 境界で `slice < MIN_SLICE(2s)` 打ち切り。overdue 記帳(1 run ≤1 行)は DELETE 開始前・incomplete 記帳(1 run ≤1 行)は最後。lane は throw しない(大域 catch → summary.error + logger.error)。

**完了条件:** `lib/storage/src-sweep.test.ts` red→green(全 I/O mock・時刻注入)— ① 呼び出し順 pin: overdue 記帳 → live check → DELETE(spy 順序 assert)② live user の全候補 skip / check reject → skip + phase `live_check` ③ deadline 打ち切り・phase 優先順位統合 ④ **quota 各境界**(実失敗 21 件目が落ちる / mismatch 6 件目が落ちる / それでも overdue・incomplete は書かれる / 落ちた数が `suppressedFailures`)⑤ 記帳 throw(notifyOps 相当)で後続 DELETE が止まらない + `logger.error` に残り `recordErrors` に加算される(silent 劣化禁止)⑥ DELETE 404 = 成功系 ⑦ summary の各カウントと `cutoffOverrideMinutes` 透過 ⑧ user 処理順 = oldest 昇順(deadline 打ち切りで最古が残らない)。`summary.error` は `String(err)` のみ(R2 応答 body・URL を載せない)。canonical + Codex pass → `[reviewed]`。

### Task 5: cron runner route + 配線(`app/api/cron/sweep/route.ts` + `vercel.json` + `.env.example`)

**目的:** GET runner(auth・override parse・lane 逐次実行・実行 readback)を新設し cron を配線する(spec §3.1)。

**Interfaces(Consumes):** Task 4 の `runSrcSweepLane` / 既存 `requireWebhookSecret`。
**Produces:** `GET /api/cron/sweep` — 200 `{ runs: SrcSweepSummary[] }` / 401 / 400(override 不正)/ 500(runner 外周 catch)。`export const runtime = 'nodejs'` / `export const maxDuration = 300`(literal)。

**制約:** auth = `requireWebhookSecret('CRON_SECRET', 'Vercel cron')` 再利用・**空文字 secret は無条件 401**(不変条件 7)・Bearer 完全一致。**auth を query validation より先に評価**(未認証 caller に validation 差を返さない)。`?cutoffMinutes=` は整数かつ ≥15 のみ許容、それ以外 400(clamp しない)。**`VERCEL_ENV === 'production'` で `cutoffMinutes` 指定があれば 400**(A1・prod の保持 policy を secret 保持者が変更できないようにする機械強制)。応答に `Cache-Control: no-store`。運用上の成功判定 = 各 lane summary の `error` / `phase`(HTTP 200 は「runner が走破した」のみを意味する — 手動 GET の読み方として §8 smoke に引き継ぐ)。lane 配列は `[srcSweepLane]` の汎用形(判定ロジックは lane 内・runner は入口/auth/deadline 配布/readback のみ)。毎 run `logger.info({ event: 'cron.lane.run', lane, ...summary })`。zod 不使用(§2 骨格踏襲)。vercel.json: `"crons": [{ "path": "/api/cron/sweep", "schedule": "0 18 * * *" }]`。`.env.example` に `CRON_SECRET=`(空値記法・実値は OT が Vercel 設定)を**同 commit**で追加。

**完了条件:** `app/api/cron/sweep/route.test.ts` red→green — ① secret 未設定(local ''): 401 ② Bearer 不一致 401 ③ `cutoffMinutes=14`・`=abc` → 400(lane 不呼出を spy で確認)③' **`VERCEL_ENV='production'` + `cutoffMinutes=15` → 400**(A1)/ production + クエリ無し → 既定 6h で lane 実行 ④ `=15`(非 production)→ lane に 900_000ms が渡り summary に `cutoffOverrideMinutes: 15` ⑤ クエリ無し → cutoff 6h・summary に override key 無し ⑥ lane throw(stub lane)→ runner の per-lane 防御 catch で当該 lane summary が error になり後続 lane は実行・response 200(「lane throw が外に漏れない」= spec §9。500 は runner 自体の失敗用)⑦ production tier + env 欠落 → gate throw → 外周 catch 500(spec §9)。**`pnpm build` exit 0**(新 route + vercel.json を触るため per-task gate)。canonical + Codex pass → `[reviewed]`。

### Task 6: docs 反映(`docs/architecture.md` / `docs/harness.md`)

**目的:** architecture.md source 行の「§3 sweeper / lifecycle が受け皿」を実装済み記述へ更新。harness.md に cron 機構行(CRON_SECRET・fail-closed・schedule・production override 禁止)を追加し、lifecycle 行に「効果監視 = sweeper overdue alert(**listing 上限内の partial observation**)」を注記。

**制約:** 適用範囲を同じ文に書く(単一点主張の教訓)。保持上限は「正常時 ≈30h / 前提つき worst ≈55h(前提 = cron 稼働・走査完了・skip≤1)」の形で書き、**hard upper bound として書かない**(A4)。overdue alert の観測範囲が bounded であることを同じ文に併記(A3)。§4 判定が未確定の間は分岐未確定と明記(推定を断定に固化させない)。

**完了条件:** docs 2 file 更新・`docs(_)` + `[no-review]` で即 commit。

---

## Sprint 完了 gate(恒久規律どおり)

whole-repo `pnpm lint --max-warnings=0` exit 0 / `pnpm test` green / `pnpm test:iso` green / `pnpm run audit` exit 0 / `pnpm build` exit 0(Task 5 で実施済でも最終確認)。報告 chat に各 1 行明記。review dispatch の観点 list に whole-repo lint 実行確認を含める。

## 実装後(plan 外・OT 管理)

- OT: push → Vercel env `CRON_SECRET` 設定(**stg は §4 判定記録完了まで設定しない** — fail-closed 保護)/ Vercel plan・stg deployment 形態の readback(spec §4。**stg が production tier なら A1 により override 不可 = smoke は 6h 待ち**)/ prod 反映後チェックリストに「Vercel dashboard の cron 実行履歴を随時確認」を追加(dead-man 監視の代替・spec §13)
- stg smoke = spec §8(fixture staging → cutoff 経過 → 手動 GET → listing diff・CC 実走・OT 指示後)
- scheduler 実発火検証 = prod 反映後(close 条件外)。恒久監視(外形 / dead-man switch)は asset reconciler lane 追加 sprint で再訪
