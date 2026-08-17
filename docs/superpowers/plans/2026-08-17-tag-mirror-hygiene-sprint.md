# tag mirror hygiene sprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** at-rest 衛生(sign-out purge + sign-in 異 owner sweep + 旧 key 物理削除)+ correctness follow-up(study-days owner echo / pull cursor CAS / M-c)。保証水準 = eventual hygiene(表示保証は correctness sprint で完結済 — 毀損しないことが最上位制約)。

**Architecture:** spec r4 = best-effort 消去(発火・順序・完了待ち保証なし)+ correctness 非毀損の 4 条件(単一 rw tx / cursor CAS / 不可侵集合 / DL success gate)。lock / marker / bootstrap / 直列化は再導入禁止。

**Tech Stack:** Dexie 4.4.4 / fake-indexeddb / Vitest / Clerk `useAuth`(repo 初使用)/ Cache API(**schema 変更なし。server 変更 = `/api/study-days/pull` への `owner_user_id` echo 追加のみ**)。

**Spec:** `docs/superpowers/specs/2026-08-17-tag-mirror-hygiene-design.md`(**r4 凍結**・OT 承認 / Codex re-review GO)

## Global Constraints

- **凍結 pin(完了条件の柱)**: spec §9 の 1〜5・10 + **correctness sprint の既存凍結 pin(capture 原則 / validate-before-tx 順序 / owner echo 4 pin / I-1 caller pin)全 green**。退行 = Critical。
- **CAS の境界(spec §3・転記)**: 変えない = capture 原則 / owner echo + 5 stream 行検証の validate-before-tx 順序 / cursor の scoped key 構成 / FAIL silent 契約。変える = apply tx 先頭の CAS 再読 + abort 分岐のみ。CAS は owner 検証でなく**並行性検証**(tx 内でしか意味を持たない)— この区別を実装コメントに書く。
- **正毀損の 4 条件(spec §0)**: ① purge / sweep の Dexie 削除は触る全 store を跨ぐ単一 rw tx ② cursor CAS ③ 不可侵集合 = pending/syncing/failed outbox 全行(owner 不問)・非 `'ready'` assets 行 + blob・`'downloading'` jobs 行 + added blob ④ DL success gate は**両成功出口を支配する共通 gate**。
- **削除条件は陽形のみ**(spec §4.1): assets = `'ready'` / jobs = `'done'` / outbox = `'synced'`。否定形(`!== 'downloading'` 等)禁止。
- **fail-safe の向き規約**(spec §4.1): sync_meta 未知 key = 機能状態 → 温存 / Cache 未知・malformed key = 再取得可能 blob → 削除。
- 空 userId は fail-closed(既存契約)。log は event 名 + 件数のみ(userId / payload 内容を出さない)。
- **red 規律**: gate は 1 つずつ個別変異(まとめ壊し不可)。既存コードへの保証 pin の変異注入位置は session doc に記録。新規挙動はテスト先行。
- **review 運用**: canonical / Codex は**逐次 — Codex を先に単独実行 → canonical**(canonical の変異注入が Codex git clean detector に偽陽性を出す既知事象・correctness sprint 裁定 3)。feat/fix は canonical 経路 + Codex、収束条件 = Critical 0 / Important 0。
- 各 task: 実装 + `pnpm typecheck` + 関連 vitest green + review 収束 + commit(tag 規律)。データ保全(削除)に触れるため「重要 Fix の裏取り」適用 — push→smoke 順で amend 窓が閉じるため session doc を [reviewed] の正記録とする(既存裁定)。
- **保証開始条件(spec §8-4)**: pre-hygiene writer(旧 bundle tab)不在が前提。deploy 後全 tab reload(現状ユーザー 0 = OT tab 閉じで充足)。smoke で旧 bundle 混在は検証しない。
- **rollback 非対称(spec §8-1)**: `/api/study-days/pull` の echo を server だけ戻すと新 client が study_days 全 pull を silent reject。roll-forward 原則(correctness spec §7a)の適用範囲に本 endpoint を加える。
- stg smoke(push 後・OT 指示): correctness sprint の A/B アカウントで CC 自走(spec §10)。競合系は unit pin が正 — smoke は E2E 配線 readback に徹する。

---

### Task 1: study-days owner echo(spec §2・先頭固定)

**Files:** Modify `app/api/study-days/pull/route.ts` / `lib/sync/study-days.ts`。Test: `app/api/study-days/pull/route.test.ts` / `lib/sync/study-days.test.ts`。

**Interfaces(Produces):**
- server 正常応答 = `Response.json({ owner_user_id: user.id, studyDays }, ...)`(additive。`withReadOnlyAuth` の `emptyBody: { studyDays: [] }` は不変 — 静的リテラルゆえ echo を構造上持てない・client が reject するが payload 空で実害ゼロ)。
- client `PullApiClient` body 型に `owner_user_id?: string` 追加。検証順 = 既存 shape 検証(`Array.isArray(studyDays)`)→ **echo 検証 `body.owner_user_id !== userId` で reject**(不一致・欠落・非 string すべて)→ 既存の行検証(2 段目・維持)。reject = `{ok: false, count: 0}`・Dexie 不変。log event 例 = `study_days.pull.owner_echo_mismatch`。

- 目的: 空 payload で行検証が vacuous になる穴(session doc §7b)を `/api/pull` と同型の「echo + 行検証」2 段で閉じる。
- 制約: `/api/pull` の echo 実装(`app/api/pull/route.ts:90` / `lib/sync/pull.ts` §3a)の idiom に合わせる。特例分岐なし(uniform reject)。
- pin(spec §9-1): ① echo 不一致 + **空 payload** で reject・Dexie 不変(vacuous 穴の直接 pin)② field 欠落で reject ③ echo 一致 + 行 mismatch で reject(2 段の独立性)④ echo 一致 + 空 payload の正常系(自 owner 行の正当な全削除)⑤ server: 正常応答に `owner_user_id` が載る / emptyBody には載らない。
- 完了条件: pin red(echo 検証を外す変異等・個別)→ green。typecheck / 両 test 通過。commit。

### Task 2: pull cursor CAS(spec §3)

**Files:** Modify `lib/sync/pull.ts`。Test: `lib/sync/pull.test.ts`。

**Interfaces(Produces):**
- `pullDelta` §1 の cursor 6 値(`sinceCards` 等・`string | undefined`)を snapshot として保持し、apply tx(`lib/sync/pull.ts:244`)の**先頭**で同 6 key を `getSyncMeta(key, userId)` で tx 内再読 → 各値を厳密 `!==` 比較。1 本でも不一致(値変化・消失・出現)で module-private の sentinel error(例 `CursorCasMismatch`)を throw。
- tx 呼び出しを try/catch で包み、**sentinel のみ** catch して `logger.warn({ event: 'pull.cursor_cas_mismatch' })` + `FAIL` 返却。**sentinel 以外は rethrow**(現挙動を変えない — 現 tx は catch 無しで caller へ伝播しており、そこに触るのは scope 外)。
- tx の store list・戻り値型・関数 signature はすべて不変。

- 目的: cursor 読取〜apply tx の network 窓に purge / sweep が挟まった遅着 delta の silent 欠落を自壊検知で防ぐ(purge / sweep が存在してよいための前提)。
- 制約: Global「CAS の境界」。correctness sprint の凍結 pin(capture / validate-before-tx / owner echo)を一切退行させない — Task 完了時に `pull.test.ts` 全件 green を確認。
- pin(spec §9-2): client mock の fetch 解決を遅延 → 窓中に ① cursor 削除(消失)② 別値へ更新(前進)③ snapshot 全 undefined の full pull 中に cursor 再生成(出現)— 各 variant で abort・mirror / cursor 不変・`{ok: false}`。④ abort が例外として外へ漏れず FAIL に正規化 ⑤ 消失 variant の続きで再 pull が since 無し full になる。red = CAS 検証を外す変異で各 variant が個別に fail。
- 完了条件: pin red → green。typecheck / `pull.test.ts` 全 green — **task 報告に capture / validate-before-tx / owner echo / I-1 caller pin の個別 green 確認を明記**(凍結 pin 退行なしの証跡)。commit。

### Task 3: DL success gate(spec §4.2)

**Files:** Modify `lib/media/deck-download.ts` / `lib/media/cache.ts`。Test: `lib/media/deck-download.test.ts` / `lib/media/cache.test.ts`。

**Interfaces(Produces):**
- `lib/media/cache.ts` に `hasAssetBlob(userId: string, assetId: string): Promise<boolean>` を追加(`cache.match` の存在確認のみ・blob 本体を読まない。`matchAssetBlob` は不変)。
- `deck-download.ts` 内部に `async function verifyDeckBlobs(userId, keys: string[]): Promise<boolean>`(全 key を `hasAssetBlob` で確認)。**両成功出口を支配**: ① `misses.length === 0` の早期 `ok:true` の直前 — fail なら `{ok: false, total: deckTotal, downloaded: 0}` を返すのみ(**added blob / job row 未生成のため rollback 対象なし**)② `'done'` 確定 update の直前 — fail なら `return await rollback()`(既存経路合流)。`'failed'` status は新設しない。

- 目的: cleanup と進行中 DL の交差で「`ok:true` + blob 欠け」を成立させない(all-or-nothing のオフライン契約保全 — cleanup が存在してよいための前提ガード)。
- 制約: per-exam DL lock・既存 try / rollback / never-throw 契約は不変。lock / 完了待ちの新規導入なし。
- pin(spec §9-10・出口別): ① 全件 preflight hit → 検証前に blob 1 件削除 → `{ok: false}` + **job row が作られない**ことも assert ② mixed hit/miss → `'done'` 確定前に **hit 分** blob 1 件削除 → rollback(added blob + job row 消滅)+ `{ok: false}` ③ 同・**added 分** blob 1 件削除 variant。red = **各出口の gate を個別に外す変異**で該当出口の `ok:true` + 欠けが成立。
- 完了条件: pin red → green。typecheck / 両 test 通過。commit。

### Task 4: sign-out purge — `local-hygiene.ts` + `<SignOutPurge />`(spec §4)

**Files:** Create `lib/sync/local-hygiene.ts` / `app/_components/sign-out-purge.tsx`。Modify `app/layout.tsx`(ClerkProvider 内に mount)/ `lib/media/cache.ts`(cache 列挙 helper)/ `lib/sync/sync-meta-access-audit.test.ts`(**`ALLOWED_FILES` に `lib/sync/local-hygiene.ts` を追加** — purge / sweep は `.sync_meta` を直接触る正当な新 writer。audit の「許可 file は実際に access を持つ」検査も自動で満たす)。Test: `lib/sync/local-hygiene.test.ts` / `app/_components/sign-out-purge.test.tsx` / `lib/media/cache.test.ts`。

**Interfaces(Produces):**
- `lib/media/cache.ts`: `parseMediaCacheKey(url: string): { userId: string; assetId: string } | null`(pathname 厳密 `/__media/<userId>/<assetId>` 3 segment・query なし。malformed = null。key 形式の正本 `cacheKey` の隣に置く)/ `listMediaCacheRequests(): Promise<readonly Request[]>`(`typeof caches === 'undefined'` または `!(await caches.has(CACHE_NAME))` なら `[]` — **cache を新規作成しない**)/ `deleteMediaCacheRequest(req: Request): Promise<void>`。
- `lib/sync/local-hygiene.ts`:
  - `purgeAllLocalData(): Promise<void>` — 手順: (1) module 変数 `purgeInFlight` で並走 dedup(実行中なら既存 Promise を返す)。**guard のライフサイクル(Codex r2 Important 1)**: guard は Dexie + Cache の**全工程を包含**し、**`finally` で成功・失敗の双方から解除**する(settled Promise の永久保持 = 2 回目以降の purge が恒久 no-op、を構造的に禁止)(2) Dexie 部: `Dexie.exists('recallmint') === false` なら skip(空 DB を作らない。exists→open の race は受容)。単一 rw tx(全 11 store)で: mirror 6 store `clear()` / `media_assets` は `'ready'` のみ削除 / `media_download_jobs` は `'done'` のみ削除 / `sync_meta` `clear()`(未知 key 含む)/ outbox 2 store は `'synced'` のみ削除(filter 走査)(3) 保護 blob 集合を tx 後に算出(生存した非 `'ready'` assets の id + `'downloading'` jobs の `added_asset_ids`)(4) Cache 部(**Dexie skip とは独立に実行**): 全 Request を列挙し、`parseMediaCacheKey` が保護集合に該当するもの以外(malformed 含む)を per-key try/catch で削除。全体 fire-and-forget・失敗 silent。
  - `HYGIENE_STORE_RULES` — **store 名 → {purge 規則, sweep 規則} の宣言的分類表**(正確な型は実装で確定)。**purge / sweep の実行体はこの同じ表を消費する**(テスト専用の別 pure 実装を作らない — 判定と実削除の乖離を構造的に防ぐ)。sweep 列は本 task で完成形を定義し Task 5 が消費(Task 5 での表の作り直し禁止)。
- `app/_components/sign-out-purge.tsx`: `'use client'`。`useAuth()` の `isLoaded && !isSignedIn` 観測ごとに `void purgeAllLocalData().catch(() => {})`(dedup は module 側)。UI なし・`SignOutPurge()` は null 返却。

- 目的: sign-out での at-rest 残骸消去(best-effort)。発火は状態駆動 — useAuth は repo 初使用・cross-tab 反映未検証だが**保証にしない**(不発は次 sign-in の sweep が回収)。
- 制約: Global「4 条件」「陽形」「fail-safe 規約」。実行時 auth 再検証・lock・queued 化はしない(遅走 purge の実害は spec §7 で bound 済)。**命名・log・コメントで「完全消去」を主張しない**(不可侵集合が残る — Codex risk 指摘)。DDD: ビジネス規則でなく同期基盤の衛生 — domain 層新設なし。
- pin: ① 分類(spec §9-8): `HYGIENE_STORE_RULES` の table-driven unit + fake-indexeddb 実走で「synced 消・pending/syncing/failed 生存(自 + 異 owner)・非 `'ready'` assets 行 + blob 生存・`'downloading'` jobs 行 + added blob 生存・`'ready'` / `'done'` 消・sync_meta 全消」(spec §9-3 の purge 側)② **網羅**: `new ClientDb().tables` の全名が `HYGIENE_STORE_RULES`(または明示除外 list)に**分類として**現れる(store 名の追加だけでは通らない — purge / sweep 両規則の宣言を強制)③ **tx 原子性**(spec §9-5): tx 内 1 操作を test 側 spy で throw させる(**production に failure hook を足さない**)→ 全 store 変更前のまま ④ Cache(spec §9-9 purge 側): malformed key 削除・保護 blob 生存・per-key 失敗続行・cache 不在時に新規作成しない ⑤ trigger(spec §9-7): signed-out で発火 / signed-in で不発火 / 並走 dedup / `Dexie.exists` false で Dexie 部 skip + Cache 部実行 ⑥ **guard ライフサイクル(Codex r2 Important 1)**: 「並走 2 回は 1 実行」に加え「**settle 後の次回呼出は新規実行**」(成功後・失敗後の両 variant)。red = 解除を外す変異(settled Promise 保持)で 2 回目が no-op になること。
- 完了条件: pin red(規則・gate 個別変異)→ green。typecheck / 上記 test + audit test 通過。commit。

### Task 5: sign-in 異 owner sweep + 旧 key 物理削除(spec §5)

**Files:** Modify `lib/sync/local-hygiene.ts`。Create `app/(app)/app/_components/hygiene-sweep-trigger.tsx`。Modify `app/(app)/app/layout.tsx`(trigger 兄弟に追加)。Test: `lib/sync/local-hygiene.test.ts` / `app/(app)/app/_components/hygiene-sweep-trigger.test.tsx`。

**Interfaces(Consumes):** Task 4 の `parseMediaCacheKey` / `listMediaCacheRequests` / `deleteMediaCacheRequest` / `HYGIENE_STORE_RULES`(sweep 列)+ 保護 blob 集合の算出 helper(Task 4 と同一手順 — Dexie tx 後・**owner 不問**の残存 非 `'ready'` assets + `'downloading'` jobs から算出)。

**Interfaces(Produces):**
- `SWEEP_SYNC_META_BASES: readonly string[]` — **明示リテラル 7 本**(`'cards_cursor'`, `'exams_cursor'`, `'tombstone_cursor'`, `'tag_categories_cursor'`, `'tag_options_cursor'`, `'card_tags_cursor'`, `'exam_view_prefs'`)。`SYNC_META_KEYS` から導出**しない**。`SWEEP_EXEMPT_BASES: readonly string[] = []`(分類強制 pin 用の明示除外 list)。
- `classifySyncMetaKeyForSweep(key: string, userId: string): 'delete' | 'keep'` — spec §5.1 厳密規則: 各 base B に対し key === B(bare)→ delete / key が `B:` 始まりで suffix === userId → keep・それ以外(空 suffix・colon 入り)→ delete / どの base にも非該当(prefix 類似含む)→ keep。
- `sweepForeignLocalData(userId: string): Promise<void>` — **空 userId は即 return(Dexie / Cache とも不変・fail-closed。`notEqual('')` が全 owner を foreign 判定する事故を構造的に防ぐ — Codex Critical 指摘)**。単一 rw tx(`HYGIENE_STORE_RULES` の sweep 列を消費): mirror 6 store `where('user_id').notEqual(userId).delete()` / assets = 異 owner かつ `'ready'` / jobs = 異 owner かつ `'done'` / outbox = 異 owner かつ `'synced'`(filter 走査)/ sync_meta = 全 key を `classifySyncMetaKeyForSweep` で判定し delete 分を一括削除。tx 後 Cache 部: malformed → 削除 / well-formed で userId ≠ self → 保護 blob 除き削除 / 自 namespace → 温存。fire-and-forget・失敗 silent。
- `HygieneSweepTrigger({ userId }: { userId: string })` — `MediaSweepTrigger` precedent(mount 1 回 `useEffect` / `[userId]` deps / fire-and-forget / UI なし)。

- 目的: sign-in 時の異 owner 残骸回収。**bare legacy key 7 本(cursor 6 + 旧 `exam_view_prefs`)の物理削除はこの分類が吸収**(独立 task なし — OT 裁定 2)。
- 制約: Global 準拠。自分の pull と非干渉(異 owner + bare のみ触る)。将来 key の判断は allowlist 追加を明示的に踏む(分類強制 pin が機械強制)。
- pin: ① allowlist / parser(spec §9-4): bare 7 本削除・`base:<other>` 削除・`base:<self>` 温存・未知 key(`future_key` / `future_key:<self>`)温存・空 suffix / 複数 colon 削除・`cards_cursor_v2` 温存 ② **分類強制**: `SYNC_META_KEYS` 全値 ∈ `SWEEP_SYNC_META_BASES ∪ SWEEP_EXEMPT_BASES` ③ sweep 側の不可侵 + 異 owner 分類(spec §9-3・**全列挙**): 異 owner の pending / syncing / failed **全状態**生存・自 / 異 owner 双方の非 `'ready'` assets **行 + 対応 blob** 生存・自 / 異 owner 双方の `'downloading'` jobs **行 + added blob** 生存・対になる異 owner の synced / `'ready'` / `'done'` は削除・自 owner は全生存 ④ **空 userId**: Dexie / Cache とも不変 ⑤ **tx 原子性**(spec §9-5 の sweep 側 — purge とは別 query 群のため独立に必要): tx 内 1 操作を test 側 spy で throw → 全 store 変更前のまま ⑥ Cache(spec §9-9 sweep 側): 異 owner key 削除・malformed 削除・自 namespace 温存・保護 blob 生存・**per-key 失敗後も残り(異 owner / malformed)の削除が続行** ⑦ trigger: mount kick + userId 変化で再 kick。
- 完了条件: pin red → green。typecheck / 関連 test 通過。commit。

### Task 6: M-c — option-list 一覧 read の owner-scope 化(spec §6)

**Files:** Modify `app/(app)/app/tags/_components/option-list.tsx:118-127`。Test: `app/(app)/app/tags/_components/option-list.test.tsx`。

- 目的: options 一覧 read(`where('category_id').equals(activeCategoryId)`)に `.and((o) => o.user_id === userId)` を追加し deps を `[activeCategoryId, userId]` に。挙動は現状も正しい(§3.3 裁定下)— 目的は**検証面の一貫性**(同 file の dropdown read と pin surface を揃える)。
- 制約: r5 §3.3 除外裁定からの 1 件だけの例外。他の除外(tag-crud / category-list 等)に触れない(scope creep 禁止)。
- pin(spec §9-6): self の category 配下に**異 owner の option 行**を fixture で混入(自然発生しない adversarial fixture)→ 一覧に描画されない / self の option は描画される + **userId deps pin(Codex r2 Important 2)**: `activeCategoryId` 固定のまま userId を A→B に rerender し、A の option が消え B のみ表示される(deps 反応性の直接 pin — 教訓「React の deps 漏れは表示 pin だけでは捕まらない」の再演防止)。red = ① `.and()` を外す変異 ② **deps から `userId` を外す変異**(それぞれ個別・②は deps pin が fail することを確認)。
- 完了条件: pin red → green。typecheck / `option-list.test.tsx` 全 green。commit。

### Task 7: docs 更新 + sprint 完了 gate(spec §10)

**Files:** Modify `docs/architecture.md` / `docs/superpowers/sessions/2026-08-16-tag-mirror-writer-inventory-factfinding.md`(Appendix 追記)。Create `docs/superpowers/sessions/2026-08-17-tag-mirror-hygiene-sprint.md`(session doc — 変異注入位置の記録を含む)。

- 目的: ① architecture.md に hygiene 層の不変条件(purge / sweep = 単一 tx + 不可侵集合 + best-effort / pull apply = cursor CAS 自壊検知 / sync_meta sweep = リテラル allowlist + 分類強制 pin / DL success gate)+ 残余リスク行を「at-rest 残骸 = eventual 回収。**残置集合は不可侵集合どおり列挙**: pending / syncing / failed outbox・非 `'ready'` assets 行 + blob・`'downloading'` job + added blob(過小記載しない — Codex r2 Minor)。うち pending / failed の解消は公開前トラックへ」に更新 ② 棚卸し doc へ Appendix 追記: media flush-gate hazard + DL blob 完全性 TOCTOU(spec §4.2)を新規発見として記録。
- 制約: correctness spec r5 は凍結のまま改稿しない(§5.1a 訂正の正記録 = session doc §7b + hygiene spec §2)。docs commit は `docs(_)` + `[no-review]` で即 commit。
- 完了条件(sprint 完了 gate・報告 chat に各 1 行明記)。**区分**: spec / CLAUDE.md 必須 = `pnpm lint --max-warnings=0` exit 0 / `pnpm test:iso` green / `pnpm run audit` exit 0。追加 gate(デプロイ前チェック由来)= whole-repo `pnpm vitest run` 全 green(**correctness 凍結 pin 含む — 退行なしの証跡**)/ `pnpm typecheck` exit 0 / `pnpm build`(postbuild 連結)PASS。追加 gate の失敗は「本 sprint 起因か既存か」を切り分けて報告し、無関係な既存失敗の修正へ scope を広げない(OT 判断)。

---

## stg smoke(push 後・OT 指示で実施 — spec §10)

correctness sprint の A/B アカウント(+clerk_test / +clerk_test1・OTP 424242)で CC 自走・IDB readback 中心:

1. A で操作(cursor / prefs / synced outbox 生成)→ sign-out → readback: mirror 空・sync_meta 空(**bare legacy key も消える — correctness smoke §10 の「残置が正」の反転**)・synced outbox 消・pending 残存(作れれば)・Cache 保護外 key 消
2. B sign-in → sweep 後 readback: fixture で作った異 owner 残骸の消滅・B namespace 無傷
3. `/api/study-days/pull` 応答 top-level に `owner_user_id`(correctness smoke §10.1 #10 の反転)
4. useAuth 発火の実挙動観測(不発でも FAIL にしない — best-effort・保証外)

競合系(CAS 窓 / Cache TOCTOU / 遅走 purge / 二重並走)は unit pin が正 — smoke で交差試験はしない。
