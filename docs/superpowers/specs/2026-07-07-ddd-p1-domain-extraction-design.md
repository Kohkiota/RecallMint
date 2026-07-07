# DDD リファクタ P1 — domain 純粋層抽出 + 二重実装単一 source 化 spec

- 日付: 2026-07-07 / branch: `dddrefactor` / phase: **P1**(P0 の次)
- SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(確定判断 D-1〜D-6 / phase 表 / やらない 4+1)
- 前提 phase: P0 完了(HEAD `a11afca`)= contract/golden(5 面 77 test)+ import 境界 lint(allowlist 4 件)+ smoke checklist。P1 の回帰検知はこの安全網が正。
- 根拠: `docs/audit/2026-07-05-ddd-refactor-investigation.md`(§5.2 純粋資産 / §4.1 二段構え)。**file:line は `5d3baef` 時点**。本 spec の grounding は下記 §2 で現 HEAD(`a11afca`)再スキャン済。
- 位置づけ: P1 は **挙動を一切変えない phase**(behavior-preserving)。「domain 純粋層の抽出」= 純粋ロジックを I/O 同居 file から抜く carve-out、「二重実装の単一 source 化」= byte-identical なコピペを共有 pure module に hoist。本 spec は WHAT と主要 HOW を記す。task 分解・コード片は plan(writing-plans)が持つ。

---

## 1. 目的とスコープ

### 1.1 目的

audit §5.2 が想定した「domain 純粋層の抽出」を、現 HEAD の実態(下記 §2)に即して**最小 churn** で実施する。具体的には (a) I/O(DB / Stripe)と同居している pure fn を pure module へ **carve-out**、(b) lib→app の逆依存を **1 件解消**(P0 lint 機構の初回機能実証)、(c) byte-identical な二重実装を共有 pure module へ **hoist / 抽出**して single source 化する。

### 1.2 in scope(現 HEAD 確定分)

- **A. 純粋層 carve-out(2 件)+ 型 relocate(1 件)**: `deriveExamStatuses` / `classifyChange`+`getPendingState` を I/O 同居 file から pure module へ抽出。`CustomSessionCriteria` 型の pure 位置への relocate。
- **B. 逆依存解消(1 件)**: `card-filter-predicates.ts` を app→`lib/cards/` へ移動し、P0 lint allowlist の当該 entry を除去。
- **C. 二重実装 dedup(2 件)**: `computeStreak`+`addDays` の共有 pure module 化 / tag comparator の 2 段 wrapper(`compareTagEntry`)抽出。

### 1.3 out of scope(P1 で触らない)

- **latent 不純の除去**(`fsrs.rate` / `newCard` / `todayInJst` の `= new Date()` default 引数)。default を消すと呼出側の挙動が変わりうる(= 挙動変更 = scope 違反)。carve-out(純 fn を抜く)と latent 除去(clock 注入)は別物。baseline §B に申し送り、clock 注入が要る phase で扱う(§8.1)。
- **大規模 rename / `lib/domain/` 一括新設**(判断1・§3.1)。純粋資産は既に lib/ 適所にあり逆流ゼロ。
- **Dexie の store/index/型変更**(D-6 発火なし。card-filter 系は Dexie を read するが schema の形は不変)。
- **二段構え(upload quota・cascade・UNIQUE pre-check)の統合**(§4.1 意図的・P1 対象外)。
- **タグ CRUD 移設 / card write 集約 / side peek 複製解消 / runOptimistic\* 昇格 / inline primitive 統合**(= P3)。
- **V5 filter 代数の再集約**(既に単一 source。§4.4 で確認のみに格下げ)。

### 1.4 凍結契約(D-2 再掲・全 work item の制約)

payload shape / Dexie schema 形 / entity_mutations 形式、error code・HTTP status・user-facing 日本語文言・cache header・revalidatePath 対象・tombstone entity_type・op 名・ops/log イベント名。P1 は純粋層の移設のみで、これらの契約面に**一切触れない**ことが behavior-preserving の定義。

---

## 2. 現 HEAD grounding(`a11afca` 再スキャン・確定事実)

本 spec の「最小 churn」判断の根拠。audit §5.2 の想定に対する実態差分を記録する(進捗表 運用注記準拠)。

1. **純粋資産は既に lib/ 適所**。§5.2 が挙げた資産(`lib/cards` / `lib/tags` / `lib/fsrs.ts` / `lib/jst.ts` / `lib/plan-catalog.ts`)は既に pure 位置にあり、**pure→app の逆流はゼロ**。大移動は不要。
2. **carve-out が要る同居は 2 件のみ**:
   - `lib/exams/source-doc-status.ts`: pure `deriveExamStatuses`(+ 定数 `STALE_PROCESSING_MS`)が DB 関数(`getExamStatusMap` / `reconcileStaleProcessing` / `hasActiveProcessingUpload`、`getDb`/`schema`/`logger` 依存)と同居。
   - `lib/stripe/subscription.ts`: pure `classifyChange` / `getPendingState` が Stripe I/O 関数群(`stripe` client 依存)と同居。
3. **逆依存は 1 件のみ**: `lib/cards/get-custom-session-cards.ts`(lib)が `card-filter-predicates`(app `exams/[id]/_lib`)を import。これが P0 lint allowlist の 4 件中 1 件(`eslint.config.mjs:76-79` + `tests/lint/import-boundary.test.ts:103-109` の assertion)。`card-filter-predicates.ts` は **import 文ゼロの完全 pure**。
4. **型 edge**: pure `lib/cards/seed-from-criteria.ts`(決定論 PRNG)が `type CustomSessionCriteria` を Dexie 結合 module(`get-custom-session-cards.ts`、`getClientDb` 依存)から type-import。runtime は erase されるが構造上 pure→infra の型依存が残る。
5. **`computeStreak`+`addDays` は byte-identical**: `lib/db/streak.ts`(server)と `lib/client/streak.ts`(client)で同一。DB/時刻に非依存の純 UTC 文字列算術。両側に同一 characterization suite(`streak.test.ts` ×2、各 `computeStreak` 6 case + wrapper test)。wrapper(`getReviewStatsForUser` / `getStreakStatsFromDexie`)は storage(Postgres / Dexie)差のみの**意図的二段構え(§4.1)**。dashboard は client wrapper のみ使用、**P0 contract は dashboard streak を cover しない**(`current_streak` は無関係な per-card FSRS 列)。
6. **comparator コピペは 3 app site**(base `sortByKeyThenCreated` は `lib/tags/sort-comparator.ts` で既に共有済)。コピペ本体は「category 比較 → tiebreak で option 比較」の 2 段 wrapper:
   - `exams/[id]/_lib/tag-sort-key.ts:22-26` / `exam-card-table-tag-cell.tsx:82-84` = 解決済 `{category, option}` に対する純 3 行。
   - `card-tags-section.tsx:560-568` = `.find` で option/category を id から解決 + 欠落→`return 0` guard 付き、その後同 3 行。
7. **V5 filter 代数は既に単一 source**(`card-filter-predicates` + `card-filter-labels` に集約、`condition-bar` は `filter-editors` を import する協働関係)。3 重コピーではない。→ P1 dedup から格下げ(§4.4)。

---

## 3. 3 判断点の記録(OT 承認済み・推奨 + 現 HEAD 根拠)

### 3.1 判断1: 物理構造 = 既存 lib/ 位置維持 + carve-out のみ(`lib/domain/` 一括新設【しない】)

**推奨 = 既存 lib/ 位置を維持し、carve-out 2 件 + 型 relocate だけ行う**。折衷(新規分のみ `lib/domain/`)も取らない。

- 根拠: §2.1 のとおり資産は既に lib/ 適所・逆流ゼロ。behavior-preserving phase での一括 rename は挙動価値ゼロの churn 純増(D-1・YAGNI・P0 で作った allowlist/churn を膨らませない方針に反)。折衷は pure の置き場が 2 箇所に割れ境界が余計曖昧になる。境界担保は P0 の import 境界 lint + 規律で足りる。
- **条件**: carve-out 先の pure module が新たな逆依存を作らない(pure fn が app/ や I/O を引かない)ことを lint + 目視で確認。

### 3.2 判断2: lib→app 逆依存 = P1 で【解消】

**推奨 = `card-filter-predicates.ts`(完全 pure・import ゼロ)を `lib/cards/` へ移動**。唯一の allowlisted 逆依存(`get-custom-session-cards`)が lib→lib 化して消滅し、新逆依存ゼロ。V5 filter 代数の lib/ 集約 home にもなる。

- **条件(機能実証)**: 移動後に P0 lint allowlist から当該 entry(`eslint.config.mjs:76-79`)を除去し、`import-boundary.test.ts:103-109` の assertion を実態(移動後は @/app import 自体が無い)へ更新。削除後 whole-repo `pnpm lint --max-warnings=0` が green になることで逆依存消滅を実証する。これが「allowlist を移設ごとに削る」の**初回実行** = P0 で作った仕組みの機能実証。

### 3.3 判断3: streak characterization = 新規【不要】(既存二重 suite を re-point)

**推奨 = `computeStreak`+`addDays` を共有 pure module に hoist し、既存の二重 suite を共有 module に re-point**(緑維持 = 回帰検知)。新規 characterization は書かない。

- 根拠: P0 contract は dashboard streak を cover しないが(§2.5)、既存 suite(各 6 case)が代替の回帰網。
- **条件**: 元の 2 つの test file は**両方温存**し共有 core を指す(統合して 1 本にしない)。server wrapper と client wrapper は storage 差で別物(§4.1 の意図的二段構え)ゆえ、各 wrapper の検証を別々に残す。共有された `computeStreak` core は両方が通る。**DB/Dexie wrapper 自体は触らない**(§4.1 準拠)。

---

## 4. Work item 詳細

全 item 共通の制約: **挙動不変**。P0 contract/golden green 維持 + 各 item の既存 co-located unit test green 維持が回帰検知の正(§5)。

### 4.1 A. 純粋層 carve-out + 型 relocate

| # | 抽出対象 | 元 file(I/O 同居)| 抜き先(pure)| 元 file 側の後処理 |
|---|---|---|---|---|
| A1 | `deriveExamStatuses` + 定数 `STALE_PROCESSING_MS` | `lib/exams/source-doc-status.ts` | pure module 新設(例 `lib/exams/derive-exam-statuses.ts`)| DB 関数 3 本は残置し、定数 + pure fn を新 module から import |
| A2 | `classifyChange` + `getPendingState`(+ `PendingState` 型)| `lib/stripe/subscription.ts` | pure module 新設(例 `lib/stripe/subscription-changes.ts`)| Stripe I/O 関数群・error class 2 種は残置。`getPendingState` の `Stripe.Subscription` は `import type Stripe` で型のみ引く(外部 lib 型・I/O 非依存)|
| A3 | `CustomSessionCriteria` 型 | `lib/cards/get-custom-session-cards.ts`(Dexie 結合)| type-only module 新設(例 `lib/cards/custom-session-criteria.ts`)| `get-custom-session-cards` / `seed-from-criteria` の両者が新 module から type-import。pure seed fn の infra 型依存を切る |

- **carve-out の受け入れ条件**: 抜いた pure module が app/ / I/O(`getDb`/`getClientDb`/`stripe`/`logger`)を import しないこと。
- **importer 波及**: A1 は pure symbol の consumer(`process.ts` / `exam-status-poll.ts` / `exam-status-live.tsx` / `api/exams/status/route.ts` 等)を新 module へ repoint、DB 関数 consumer は `source-doc-status.ts` のまま。A2 は `upgrade/actions.ts` 等を repoint。**どの consumer が pure/impure どちらを使うかは plan で file 単位に確定**。
- **A3 の位置づけ**: 型のみ・runtime erase ゆえ trivially behavior-preserving。plan で「新 file 1 個追加が scope に見合うか」を最終判断し、見合わなければ defer 可(判断は plan 段階)。
- co-located test(`source-doc-status.test.ts` / `subscription.test.ts`)の pure fn 部分は新 module 側へ repoint or 分割。plan で確定。

### 4.2 B. 逆依存解消(`card-filter-predicates` 移動)

- `app/(app)/app/exams/[id]/_lib/card-filter-predicates.ts`(+ co-located `card-filter-predicates.test.ts`)を `lib/cards/` へ移動。
- 全 app consumer(`card-filter-labels.ts` / `exam-card-table-columns.tsx` / `custom-filter-form.tsx` / `exam-card-table-condition-bar.tsx` / `exam-card-table-filter-editors.tsx` 等)を `@/lib/cards/card-filter-predicates` へ repoint(app→lib = 順方向・許容)。
- `get-custom-session-cards.ts` の import が lib→lib 化。
- P0 lint allowlist entry 除去 + `import-boundary.test.ts` assertion 更新(§3.2 条件)。**`card-filter-labels.ts` は移動しない**(lib からの import 元が無く逆依存を持たない = 移動の正当化なし。YAGNI・scope 最小)。

### 4.3 C. 二重実装 dedup

**C1 — `computeStreak`+`addDays` hoist**:
- 共有 pure module 新設(例 `lib/streak-core.ts`)に `computeStreak` + `addDays` を置く(両者を export。`addDays` は wrapper の lowerBound 算出でも使うため)。
- `lib/db/streak.ts` / `lib/client/streak.ts` は wrapper(`getReviewStatsForUser` / `getStreakStatsFromDexie`)を残し、core を新 module から import。client 側の `STREAK_WINDOW_DAYS` 定数・window 算出は現状維持(server は `-60` 直値、client は `-(WINDOW-1)` で同値 = 挙動同一)。
- `streak.test.ts` ×2 の `computeStreak` suite を新 module import へ re-point(両 file 温存・§3.3 条件)。wrapper test は各 wrapper を指したまま。

**C2 — tag comparator 2 段 wrapper 抽出(`compareTagEntry`)**:
- `lib/tags/sort-comparator.ts` に `compareTagEntry(a, b)`(解決済 `{ category, option }` を受け「category 比較 → tiebreak option 比較」する 2 段 comparator)を新設(base `sortByKeyThenCreated` の隣 = 自然な home、rule of three 成立 = 実 3 site)。
- `tag-sort-key.ts` / `exam-card-table-tag-cell.tsx` は inline 3 行を `compareTagEntry` 呼出へ置換。
- `card-tags-section.tsx` は `.find` 解決 + 欠落 guard(`if (!optA...) return 0`)は**その場に残し**、解決後の 3 行のみ `compareTagEntry({category: catA, option: optA}, {category: catB, option: optB})` へ置換(guard は sort_key 比較でなく id 解決の関心 = 別レイヤーゆえ共通化しない)。

### 4.4 V5 filter 代数 = 確認のみ(dedup から格下げ)

§2.7 のとおり既に単一 source。P1 では**残留 inline op list の確認のみ**行い、3 重コピーが無いことを記録して dedup 対象から外す(scope 補正)。新規の共通化はしない。

---

## 5. 回帰検知の正(behavior-preserving の検証)

P1 の変更面は P0 golden の 5 契約面(pull / entity-mutations / review-events / upload / webhook)に**出ない**(streak・exam-status・plan-change・tag 表示順・custom session 選定は golden 対象外)。ゆえに P1 の回帰網は下記の重層:

1. **P0 contract/golden green 維持**: 移設で `.snap` が赤 → 意図せず契約面に波及した = 停止して見直し(移設が契約に触れていない証明)。
2. **各 item の既存 co-located unit test green 維持**(実質の behavior 網): `source-doc-status.test.ts` / `subscription.test.ts` / `streak.test.ts` ×2 / `sort-comparator.test.ts` + comparator 利用 component test / `card-filter-predicates.test.ts` / `get-custom-session-cards.test.ts` / `seed-from-criteria.test.ts`。
3. **whole-repo `pnpm lint --max-warnings=0`**(allowlist entry 除去後も green = 逆依存消滅の実証 + 新逆依存ゼロ)。
4. **`pnpm typecheck`**(型 relocate / repoint の健全性)。
5. `pnpm build` は Next 設定 file(matcher / proxy.ts / next.config.\*)を触らないため gate 必須ではないが、move 主体 phase ゆえ**推奨実行**(import 解決の最終保険)。

---

## 6. Deliverables

1. pure module 新設 ×(A1 / A2 / C1)+ type module(A3)+ `compareTagEntry`(C2、既存 file 追記)。
2. `card-filter-predicates.ts`(+ test)の `lib/cards/` 移動 + 全 consumer repoint。
3. `eslint.config.mjs` allowlist entry 除去 + `import-boundary.test.ts` assertion 更新。
4. 既存 test suite の re-point(streak ×2 / comparator / carve-out co-located)。両 streak test file 温存。
5. SSoT 進捗表の P1 状態更新(spec 起草中 → … → 完了 + HEAD SHA、各 commit と同 commit で。運用注記準拠)。

---

## 7. 完了条件

- `pnpm test`(contract 含む全 test)exit 0。`test:contract` 単独 exit 0(P0 golden 不変で green)。
- whole-repo `pnpm lint --max-warnings=0` exit 0(allowlist entry 除去後)。報告に「whole-repo lint exit 0 確認済」1 行明記(sprint 完了 gate 規律)。
- `pnpm typecheck` exit 0。
- streak / comparator / carve-out の既存 co-located test が re-point 後も green。両 streak test file 温存確認。
- canonical review(`requesting-code-review` デフォルト経路)+ Codex review 各非自明 task で pass、未解決 Critical 0 / Important 0。
- carve-out 先 pure module が I/O / app を import しないこと(lint + 目視)を確認。
- SSoT の P1 状態欄 = 完了 + HEAD SHA + 再スキャン箇所記録。

---

## 8. 非目標 / 申し送り

### 8.1 latent 不純(baseline §B 申し送り)

`fsrs.rate` / `newCard`(`lib/fsrs.ts`)/ `todayInJst`(`lib/jst.ts`)等の `= new Date()` default 引数は P1 で**触らない**。default 除去は clock 注入 = 呼出側挙動の変更を伴い behavior-preserving を外れる。clock 注入が必要になる phase(なければ据え置き)で扱う。P1 の carve-out(純 fn を抜くだけ)とは別関心。

### 8.2 P3 送り(再掲・§1.3)

タグ CRUD 移設 / card write 集約 / side peek 複製解消 / runOptimistic\* application service 昇格 / inline primitive 統合。P1 では扱わない(SSoT phase 表 P3)。

### 8.3 Dexie(D-6 発火なし)

P1 は純粋層移設のみで Dexie の store/index/型の形を変えない。万一 plan で形の変更が必要と判明したら D-6(形の変化は別 commit 隔離)を発火し停止して OT 相談。

---

## 9. Codex cross-check(plan 段階で実施)

canonical process(CLAUDE.md「plan 段階の Codex 協調」)に従い、fact-finding + 要件を主入力・本 spec ドラフトを参考添付(anchor 防止)として `scripts/ai/codex-plan-review.sh` を **plan 確定の前**に 1 回実行する。spec 段階では inline self-review のみ(brainstorming skill step 7)。review 段階の Codex(`codex-review.sh`)は各 task 実装時に別途実施。

---

## 付録: 参照

- SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(D-1〜D-6 / N-1〜N-5)
- P0 spec: `docs/superpowers/specs/2026-07-06-ddd-p0-safety-net-design.md`(安全網 = 回帰検知の正)
- P0 baseline: `docs/audit/2026-07-06-p0-contract-baseline.md`(§A triage / §B 凍結契約 inventory・latent 不純の申し送り先)
- 調査: `docs/audit/2026-07-05-ddd-refactor-investigation.md`(§5.2 純粋資産 / §4.1 二段構え)
- grounding: 本 spec §2(現 HEAD `a11afca` 再スキャン結果)
