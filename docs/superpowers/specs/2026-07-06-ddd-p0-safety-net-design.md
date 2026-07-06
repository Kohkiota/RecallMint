# DDD リファクタ P0 — 安全網構築 spec

- 日付: 2026-07-06 / branch: `dddrefactor` / phase: **P0**(DDD リファクタの先頭 phase)
- SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(確定判断 D-1〜D-6 / phase 表 / やらない 4+1)
- 根拠: `docs/audit/2026-07-05-ddd-refactor-investigation.md`(統合調査。§ 参照は同 doc)
- 位置づけ: P0 は **挙動を一切変えない phase**。以降の P1〜P4(コード移動・層再編)の回帰検知の正(安全網)を構築する。本 spec は WHAT と主要な HOW 判断を記す。task 分解・コード片は plan(writing-plans)が持つ。

---

## 1. 目的とスコープ

### 1.1 目的

P1 以降の behavior-preserving refactoring を機械的に検証できる安全網を作る。具体的には (a) 主要 API/action の**現状実レスポンスを golden 固定**、(b) 層違反の再汚染を防ぐ **import 境界 lint**、(c) 掃討しても安全な **dead code / stale の除去**。P0 完了後、後続 phase は「golden が赤くなったら挙動が変わった」を唯一の客観判定に使える。

### 1.2 in scope

1. §2.3 契約乖離 triage(**P0 の最初の実作業**)
2. contract/golden tests(vitest `toMatchSnapshot`)+ smoke checklist
3. import 境界 lint(標準 `no-restricted-imports` + allowlist)
4. dead code・stale 掃討(**Tier 1 のみ**)
5. deliverable docs(triage 表 / 凍結契約 inventory)

### 1.3 out of scope(P0 では触らない)

- 層再編・コード移動・use-case 抽出(P1〜P4)。
- **Dexie に触らない**(store/index/型とも形不変。D-6 隔離判断は P0 で発火しない)。
- 挙動変更(bug 修正を含む)。triage で bug 判定が出た面は **snapshot 対象から外して別途相談**(修正して焼く、はしない)。
- Playwright/E2E 導入(D-3 により任意・別相談)。
- dead-sweep の Tier 2 / Tier 3(§6。owning phase / P3 送り)。

### 1.4 凍結契約(D-2 再掲・全 work item の制約)

payload shape / Dexie schema 形 / entity_mutations 形式、に加えて **error code・HTTP status・user-facing 日本語文言・cache header・revalidatePath 対象・tombstone entity_type・op 名・ops/log イベント名**を「挙動同一の契約」として扱う。golden はこれらを実値で固定する。

---

## 2. 実施順序(条件 A)

snapshot は「実行時に出た値」を無条件に焼くため、bug を golden に焼き込む事故を防ぐには triage が snapshot 生成より前に完了している必要がある。順序を固定する:

```
(1) §2.3 乖離 triage 完了(triage 表 deliverable 化)
        ↓  triage 結果を fixture / snapshot 対象選定に反映
(2) contract fixtures + clock/id 固定基盤 整備
        ↓
(3) .snap 生成(triage で intentional と確定した面のみ。bug 判定面は対象外)
        ↓  green 確認
(4) import 境界 lint 導入(allowlist)
        ↓  whole-repo lint exit 0 確認
(5) dead-sweep Tier 1(green 保持 — 掃討中に golden が落ちたら該当を dead 判定から除外)
```

(4)(5) は (3) の green 後。(5) は golden を安全網に使う(掃討で golden が赤 → その参照は動的に生きていた → dead 判定撤回)。

---

## 3. Work item 詳細

### 3.1 §2.3 乖離 triage(最初の実作業)

**目的**: 現 HEAD で、契約面(golden に現れうる値)に含まれる server/client 乖離を全数洗い、`intentional`(固定 OK)/ `bug`(固定前に相談・snapshot 対象外)に分類する。

**deliverable**: `docs/audit/2026-07-06-p0-contract-baseline.md` の §A(triage 表)。列 = 乖離 / 現 HEAD file:line / 契約面に出るか / 判定(intentional/bug)/ 根拠 / snapshot 反映(固定する / 対象外)。

**seed 分類(OT 確認済 2 件)**:
- `ClientAnswerEvent.rating`: server `answer_events` に rating 列なし・payload 専用で server `deriveRating` が正 → **intentional**。golden には「server response / DB mutation に client 由来 rating が現れない」形で固定される。
- `ClientUserSettings`(pull writer 不在 + `custom_session_limit` 欠落): `/api/pull` response に出ない → **contract 対象外**(pull golden に出現しないことを確認して記録)。

**triage 中に洗う既知候補(audit 由来。現 HEAD で再確認)**: card_tags の created_at cursor + cards.updated_at bump 由来の pull 挙動 / tombstone entity_type union / option の camel⇄snake 変換面 / study_days の JST 集計。各々「契約面に出るか」を判定し、出るものだけ intentional/bug 分類。

**bug 判定が出た場合**: snapshot 対象から外し、triage 表に理由を記載して**停止・OT 相談**(P0 は挙動不変ゆえ P0 内で修正しない)。

### 3.2 contract/golden tests

**機構**: vitest 標準 `toMatchSnapshot`(外部 `.snap`)。理由 = 現状実値の自動捕捉 = OT 方針「手書き期待値でなく現状を正とする」に合致 / 新規依存ゼロ / 後続 phase の意図的変更は `.snap` diff として review 成果物になる。

**配置(判断 2)**: 専用 `tests/contract/`(golden test 本体)+ 共有 `tests/fixtures/`(makeReq / fake tx builder / payload・event factory を集約。現状 4 test に重複する `makeReq` 等をここへ)。`package.json` に `test:contract` script 新設(vitest の filter 指定で `tests/contract/` のみ実行)。既存 co-located test は温存(削除・移動しない)。contract 層は既存の部分 assert を**代表面については superset として固定**する新設層。

**mock 層**: 既存 route test と同一(`@/lib/db` の fake tx / query-builder chain / delta 層 mock)。fixtures/ に共有化。

**非決定値の固定(判断 1 補足)**: server が生成する時刻・id を fixture 側で固定。clock = vitest `vi.setSystemTime`(グローバル Date に効くため route 署名変更不要)、server 生成 id = `crypto.randomUUID` / `lib/sync/new-id` の決定論 stub。**route の signature・実装は変更しない**(P0 は挙動不変)。fixture 固定で足りない非決定値が残る場合は snapshot serializer で正規化(値の存在は残し、非決定部分のみマスク)。

**altitude(判断 4)**: 代表面のみ固定 = happy path + 全 error code + §2.3 triage で intentional と確定した乖離ケース。網羅的パス被覆はしない。

**対象と固定内容**:

| 対象 | 入力(fixture)| 固定する契約面 |
|---|---|---|
| `GET /api/pull` | mock delta(各 entity)| response body(cursors / 各 entity 配列 / tombstone 反映)+ HTTP status + `cache-control` header。error path: 401 unauthenticated / 500 internal |
| `POST /api/entity-mutations/bulk` | payload + fake tx | `{ ok, applied, failed }` + 捕捉 DB mutation 値 + 全 error code/status(unauthenticated 401 / user_not_synced 401 / invalid_json 400 / invalid_payload 400 / 503)|
| `POST /api/review-events/bulk` | payload + fake tx | `{ ok, failed }` + 捕捉 DB 書込値(sessionUpsert / answerEvent / reviews / studyDays)+ 全 error code/status |
| upload result union | targeted 入力 | **`ProcessUploadResult` union 形 + 11 error code**(`process.ts:73-84`)を固定。**full pipeline(advisory lock / AI 呼出 / DB)は実行しない** — union shape と code 網羅を targeted unit で固定 |
| webhook(stripe / clerk)| event fixture(署名込み)| **text response 文言 + HTTP status + 捕捉 DB mutation 引数**(stripe: `.set()` 内容 / clerk: users SET + 10 子テーブル DELETE 発火)。既存 fake-tx 素材を再利用 |

### 3.3 smoke checklist

**成果物**: `docs/audit/2026-07-06-p0-smoke-checklist.md`。主要フロー = auth / カード編集 / タグ CRUD / 5 問回答 → bulk flush / OCR upload / plan 変更。各フローに手順 + 期待挙動 + mobile 要否を記す(丸投げ禁止規律準拠)。実行は stg 反映後に CC が DevTools MCP。P0 では checklist の**定義**まで(実走は各 phase 完了時の smoke で使用)。

### 3.4 import 境界 lint(allowlist 方式)

**機構(判断)**: 標準 `no-restricted-imports`(新規依存ゼロ)。禁止ブロック + allowlist per-file override(既存 config のブロック4 パターンと一貫)。

**禁止ルール**:
- `lib/**` `components/**` から `@/app/*` `@/app/**` を禁止(逆依存)。
- `app/**` から `../../../*`(3 段以上の相対)を禁止。

**allowlist(現 HEAD 全数 4 件)**:
- `lib/cards/get-custom-session-cards.ts`(→ exams `_lib/card-filter-predicates`)
- `components/marketing/contact-form.tsx`(→ contact action)
- `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx`(../../../ AppContainer)
- `app/(app)/app/upload/result/[sourceDocumentId]/page.tsx`(../../../ AppContainer)

**escape 必須(最大の実務リスク)**: allowlist の app 2 パスは flat config `files:` glob で route group `\\(app\\)` / dynamic `\\[id\\]` `\\[sourceDocumentId\\]` を escape(config L31 前例 / CLAUDE.md L197)。escape 漏れは silent に override 不発。allowlist ブロックは禁止ブロックより**後方**に置く(flat config の後勝ち)。

**完了確認**: whole-repo `pnpm lint --max-warnings=0` exit 0。以降の phase で移設ごとに allowlist を 1 件ずつ削る(P0 では削らない・導入のみ)。

### 3.5 dead code・stale 掃討(Tier 1 のみ)

golden green 後に実施。掃討中に golden が赤 → 動的参照が生きていた証拠 → dead 判定撤回。**Tier 1 = 完全 dead + stale コメントのみ**:

| 項目 | 対象 | 対応 |
|---|---|---|
| dropdown-menu | `components/ui/dropdown-menu.tsx` | ファイル削除(production import ゼロ確認済)+ `option-row.tsx:33,315` の stale コメント 2 箇所更新 |
| schema コメント | `lib/db/schema.ts:1` | 「13 tables」→「21 tables」 |
| replay-card コメント | `replay-card.ts:5,70,92`(+ `replay-card.test.ts:3`)| dangling な `submit-review-tx.ts` 参照を実対向(`app/api/review-events/bulk/route.ts`)へ読み替え or 削除 |

Tier 2 / Tier 3 は §6 のとおり P0 で触らない。

---

## 4. Deliverables

1. `tests/contract/**`(golden test)+ `.snap`(triage 通過面のみ)+ `tests/fixtures/**`(共有)+ `test:contract` script。
2. import 境界 lint(`eslint.config.mjs` に禁止 + allowlist ブロック追加)。
3. Tier 1 掃討の適用。
4. **`docs/audit/2026-07-06-p0-contract-baseline.md`**:
   - **§A 乖離 triage 表**(条件 D。P1 以降で「意図的乖離」を触る際の制約参照点。例: P3 で rating 導出を触る時「rating=payload 専用・server deriveRating が正」が制約)。
   - **§B 凍結契約 inventory**(条件 C。P0 が固定した契約の明文化。特に upload の 11 error code + `ProcessUploadResult` union 形。P2 の process.ts 分解が契約境界を最初から参照できるように)。
5. smoke checklist doc。

---

## 5. 完了条件

- `pnpm test`(contract 含む全 test)exit 0。`test:contract` 単独 exit 0。
- `.snap` は triage で intentional 確定した代表面のみを固定(bug 判定面は対象外・triage 表に記録)。
- whole-repo `pnpm lint --max-warnings=0` exit 0(allowlist 導入後)。
- `pnpm typecheck` exit 0。
- Tier 1 掃討後も golden green 維持。
- deliverable docs(baseline §A/§B・smoke checklist)commit 済。
- canonical review + Codex review(spec/plan phase・review phase)pass、未解決 Critical 0 / Important 0。
- design doc(SSoT)の P0 状態欄更新 + Tier 分散注記(条件 B)。

---

## 6. Tier 分散の記録(条件 B)

audit §4.3 の dead リストは「P0 全消し」ではなく phase 分散に変わった。後 phase での「掃討し忘れ」誤認を防ぐための記録:

| Tier | 項目 | 送り先 | 理由 |
|---|---|---|---|
| Tier 1 | dropdown-menu.tsx / schema「13→21」/ replay-card dangling コメント | **P0** | 完全 dead + stale コメント。独立・安全 |
| Tier 2 | isUpgrade / newCard / buildNewOption / jstMonthBoundsUtc / scheduler の export | **owning phase**(当該 module を触る phase)| export だけ test が唯一 consumer。半数は本体が内部利用中で export 修飾除去のみ可・価値低。安全網 phase で characterization test を消さない |
| Tier 3 | CardTagBadge.onOpenEdit / createOptionAndAssignPlaceholder | **P3** | TagEditCallbacks 型の optional 化を伴う設計変更。exams UI 再編(P3)の surface そのもの |

このうち Tier 2/3 は audit §4.3 に「dead」と記録されているが P0 で消さない。各 owning phase / P3 の spec がこの表を参照して処理する。

---

## 7. 非目標(P0 で明示的にやらないこと)

- コード移動・層抽出・DRY 化(P1〜P4)。
- Dexie 変更(D-6 発火なし)。
- bug 修正(triage で発見しても P0 では修正せず相談)。
- 既存 co-located test の削除・移動(contract 層は新設・共存)。
- allowlist の削減(導入のみ。削減は移設と同時に後続 phase)。
- E2E 導入。

---

## 付録: 参照

- SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(D-1〜D-6 / N-1〜N-5)
- 調査: `docs/audit/2026-07-05-ddd-refactor-investigation.md`(§2.3 乖離 / §3.4 lint 違反 / §4.3 dead)
- grounding(本 spec の根拠となった現 HEAD 調査): test 機構(snapshot 未使用・fake tx harness)/ lint(標準 no-restricted-imports で可・違反 4 件)/ dead 再スキャン(Tier 分類)は本 spec 内に反映済。
