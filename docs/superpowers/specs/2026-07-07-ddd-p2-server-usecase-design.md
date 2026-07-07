# DDD リファクタ P2 — server 側 use-case 化 spec

- 日付: 2026-07-07 / branch: `dddrefactor` / phase: **P2**(P1 の次)
- SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(確定判断 D-1〜D-6 / phase 表 / やらない 4+1)
- 前提 phase: P0 完了(golden 5 面 77 test + import 境界 lint)+ P1 完了(実装 HEAD `8a0e8ee`)。P2 の回帰検知は **P0 golden が主網**(P1 と違い、P2 の変更面は golden 4 面に直接出る)。
- 根拠: `docs/audit/2026-07-05-ddd-refactor-investigation.md`(§3.3 route 内ドメイン / §6.1 凍結境界 / §6.3 地雷)。**file:line は `5d3baef` 時点**。本 spec の grounding は §2 で現 HEAD(`b3bcb07`)再スキャン済(audit 主張と全一致・stale なし)。
- 位置づけ: P2 は **挙動を一切変えない phase**(behavior-preserving)。「server 側 use-case 化」= route/action に **wire 境界**(認証・署名検証・idempotency・zod parse・HTTP/result 化)のみ残し、use-case 関数を**関数単位 as-is** で lib へ移動(route 3 本)+ process.ts の in-place 分解。本 spec は WHAT と主要 HOW を記す。task 分解は plan(writing-plans)が持つ。

---

## 1. 目的とスコープ

### 1.1 目的

audit §3.3 の「route 内のドメイン」4 hotspot を、wire 契約(P0 golden)を割らずに wire 境界と use-case に分離する。移動は関数単位 as-is(内部 pure 化・再構成なし)。**tx 境界・advisory lock 範囲・error code・HTTP status・日本語文言・ops/log イベント名は不変**。

### 1.2 in scope

- **A. review-events/bulk route**: `processSession` + `deriveRating` + `toPgTimestamptz` + payload zod schema 群 → `lib/reviews/`(新 dir)。
- **B. stripe webhook route**: `handleEvent` + `normalizeSubStatus` + `resolvePlanFromSub` + `extractSubFields` + `evaluateReleaseGate` + `extractCustomerId` → `lib/stripe/`(既存 dir)。
- **C. clerk webhook route**: `handleEvent` + `handleUserDeleted` + `recordFailure` + `isCustomerMissing` + `isTransientDbError` + `runTransactionWithRetry` + `CANCEL_TARGETS` → `lib/clerk/`(新 dir)。
- **D. process.ts(761 行)の in-place 分解**: `_actions/` 配下の別 module へ分割(課金ガード / AI 呼出 / DB / 文言 の分離)。lib へは移設しない。
- **E. 付随回収**: clerk route の stale「8 テーブル」集約コメント → 「10」修正(baseline §B 申し送り・挙動不変)。

### 1.3 out of scope(P2 で触らない)

- **retry・transient 統合 / route 認証 wrapper / outbox flush 共通化 / pull server factory**(= P4)。clerk の `runTransactionWithRetry` / `isTransientDbError` は**そのまま同居移動**し `lib/retry` 等と統合しない。
- **client 側 use-case 化**(session-runner / タグ CRUD / card write 集約 等 = P3)。
- **measure 計測配管の revert**(review-events の TEMP marker)。timing log は D-2 凍結(ops/log イベント名)対象。配管ごと温存し、revert は別 task・OT 判断(§8.2)。
- **内部 pure 化・再構成**(replay fold の phase 分割、文言 catalog 化、handler の event-map 化 等)。as-is 移動のみ。
- **clock 注入 / latent 不純の除去**(P1 spec §8.1 の申し送りを維持)。
- **Dexie**(P2 は server 側のみ。D-6 発火なし)。
- **Tier2 dead-export 回収**(`isUpgrade` / `newCard` 等は P2 が触る file に無い)。

### 1.4 凍結契約(D-2 再掲 + OT 追加条件 4・全 work item の最上位制約)

P0 golden が review-events / entity-mutations / upload / webhook の契約を凍結済み: payload shape / error code / HTTP status / user-facing 日本語文言 / cache header / revalidatePath 対象 / op 名 / ops・log イベント名。P2 はこれらを**割らずに route から中身を抽出**する。**golden が赤 = 挙動が変わった = 即停止**。特に webhook の「error でも 200」意味論(invalid signature のみ 400)は状態遷移込みで golden 固定済み — 抽出で status 分岐を動かさない。凍結契約 inventory = baseline §B(i)。

---

## 2. 現 HEAD grounding(`b3bcb07` 再スキャン・確定事実)

audit §3.3/§6.1/§6.3 の主張は現 HEAD で**全一致**(行数・構造とも)。以下は抽出設計が依拠する実測値。

1. **`app/api/review-events/bulk/route.ts` = 594 行**。`deriveRating` :104-106(rating 導出の唯一の正・replay と study_days 集計の両方から呼ぶ)/ `toPgTimestamptz` :113-115 / `processSession` :122-455(334 行)。**単一 tx** :141-436 が Phase 1(cards SELECT)〜 Phase 2f(study_days UPSERT)を包含、count mismatch 防御 :352-364 は tx 内(mismatch → throw → rollback)。**Phase 0(study_sessions upsert)は handler 側 :519-577 で tx の外**(失敗時 503/400 の独自 error path を持つ現仕様)。`measure` closure は handler :483-490 で定義され processSession に引数注入(TEMP marker :479-481)。
2. **`app/api/webhooks/stripe/route.ts` = 441 行**。POST(wire 境界):16-66 / `extractCustomerId` :71-81(POST の outer catch と `invoice.payment_failed` handler の両方が使用)/ `normalizeSubStatus` :86-104 / `resolvePlanFromSub` :117-156 / `extractSubFields` :161-174 / `handleEvent` :176-365(6 event switch)/ `evaluateReleaseGate` :372-441。**既存 lib 委譲 seam あり**: `releaseCompletedDowngrade`(`lib/stripe/subscription.ts`)/ `resolveFromPriceId`(`lib/stripe/price-mapping.ts`)を import 済。P1 Task4 で `classifyChange`+`getPendingState` は `lib/stripe/subscription-changes.ts` へ carve 済(P2 対象と重複なし)。
3. **`app/api/webhooks/clerk/route.ts` = 417 行**。POST(wire 境界):49-128(zod schema は既に `lib/validation/clerk-webhook.ts`)/ `handleEvent` :130-165 / `handleUserDeleted` :167-301(Stripe cancel ループ :198-237 = tx 外、10 テーブル明示 DELETE tx :273-300)/ `recordFailure` :315-346 / `isCustomerMissing` :349-354 / `isTransientDbError` :360-375 / `runTransactionWithRetry` :385-416(「local 非 export 関数」思想のコメント付き = P4 統合対象の意図的複製)。stale「8 テーブル」コメント = :242(実 10、baseline §A 注記 3)。
4. **`app/(app)/app/upload/_actions/process.ts` = 761 行**。`processUpload`(export・revalidatePath finally):117-133 / `_processUpload` :135-686。内部構造: formData parse + ページ数算出 + PAGE/SIZE 上限(:141-224、DB 非依存)→ **guard tx** :254-376(advisory xact lock + in-flight check + 月次 quota + Gemini 日次上限 + exam 確定 + sourceDoc INSERT を単一 tx、`GuardTxResult` union で返す)→ 結果分岐・文言 :378-419 → base64 :425-452 → OCR pipeline :454-507 → **保存 tx** :509-595(cards INSERT + `applyOcrTags` + card_count を単一 tx — **applyOcrTags の同一 tx 前提採番は保存 tx 内**)→ **完了 tx** :597-659(sourceDoc completed + uploadRecords)→ preview 構築 :661-686。helper: `truncate` / `parseDailyLimit`(prod fail-fast)/ `markFailed`(失敗台帳 tx・best-effort)。
5. **消費者制約(D の現 path 維持の根拠)**: contract test が `@/app/(app)/app/upload/_actions/process` を**直 import**(`tests/contract/upload-result.contract.test.ts:241`)、`upload-form.tsx:26` が型 import。`processUpload` と型 export の path 不変が必須。
6. **route.test 4 本の厚さ** = 1295 / 1194 / 855 / 1106 行(review-events / stripe / clerk / process)。分岐網羅の回帰網はここが正(baseline §B(iii) の役割分担)。

---

## 3. 判断点の記録(OT 承認済み 5 論点 + 追加 4 条件・2026-07-07)

### 3.1 配置(論点 1 + 条件 1)

- A → `lib/reviews/`(新 dir)/ B → `lib/stripe/`(既存)/ C → `lib/clerk/`(新 dir。`lib/clerk.ts` 単 file と併存 = `lib/stripe.ts` + `lib/stripe/` と同形・対称)。
- 小 dir 新設は P1 判断(lib/domain 一括新設せず)と矛盾しない: P1 が否定したのは**既に適所にある pure 資産の集約 churn**。今回は抽出対象が route 内にあり lib に居場所が無いため作る — 別ケース(OT 確認済)。
- **条件 1(Learning context 注記)**: `lib/reviews/` は「P2 時点の置き場」であり Learning context(audit §5.1-2)の最終形ではない。P1 で `replay-card` を `lib/cards/` に据え置いたため、抽出後は FSRS ロジックが `lib/cards/`(replay-card)と `lib/reviews/`(processSession)に**分散する**。これは §5.1 の先取りだが統合的配置は将来の context 確定作業の判断で、**P2 は「route から出す先」として使うだけ**。「なぜ FSRS が 2 箇所か」は本注記が答え。

### 3.2 process.ts = in-place 分解(論点 2 + 条件 2・最重要)

- `processUpload` / 全型 export(`ProcessUploadResult` union / 11 error code / `ProcessedCard` 等)は**現 path 維持**(§2.5 の直 import 制約 = P0 golden 凍結対象)。`lib/upload/` 新設はしない(単一 consumer・YAGNI)。中身を `_actions/` 配下の別 module へ分割。
- **条件 2(1 関数 = 1 tx)**: 各 tx 境界が「1 関数 = 1 tx」で閉じることを構文的制約とする。具体的に:
  - **guard tx**(advisory lock 取得〜sourceDoc INSERT)= 1 関数のまま。lock 範囲を跨ぐ分割をしない(分割で採番 race / in-flight guard 無効化を作らない — audit §6.3)。
  - **保存 tx**(cards INSERT + `applyOcrTags` + card_count)= 1 関数のまま。**applyOcrTags の同一 tx 前提採番**(audit §6.3)を同一関数内に保つ。
  - **完了 tx** / **markFailed tx** も各 1 関数。
  - 「lock を跨がない」だけでなく「**tx を跨がない**」を同じ原則で押さえる(分割で lock/採番が漏れる余地を構文的に消す)。

### 3.3 深さ = as-is 移動のみ(論点 3)

関数単位の移動・分割のみで内部は書き換えない。`measure` 配管(TEMP marker 込み)・timing log・logger イベント名・notifyOps subject/payload は byte 単位で温存(D-2)。処理順序・error path・early return 構造も不変。

### 3.4 test 方針(論点 4 + 条件 3)

- **新規 unit test は書かない**。既存 route.test 4 本(経路担保)+ P0 golden(wire 固定)が回帰の正。DB-mock test の複製を作らない(P1 の source-doc-status 前例)。移動する co-located test は無い(4 対象とも test は route/action 側に co-located であり、test file は移動対象の module を route 経由で検証している)。
- **条件 3(mock 境界の検証・P1 Task4 教訓)**: move で route.test の mock 対象・import が変わる箇所は「実装は同じでも test が別物を検証」に陥っていないか**各 task で確認**する。processSession / handleEvent は DB I/O を含む use-case の move ゆえ、`vi.mock` の real/override 境界(どの module が mock され、どの module が実体で走るか)を明示し、move 後に route.test が**緑かつ正しい対象を検証している**ことを担保する(mock 先は `@/lib/db` 等の絶対 path で move の影響を受けない見込みだが、task ごとに実証する)。

### 3.5 付随回収(論点 5)

clerk route :242 の stale「8 テーブル」→「10」修正(移動先 module 内で同時修正・コメントのみ・挙動不変)。Tier2 dead-export は P2 file に無く回収なし。

---

## 4. Work item 詳細

全 item 共通: 挙動不変。P0 golden green + route.test 4 本 green 維持が回帰検知の正(§5)。移動後の route/action は wire 境界のみ(認証 / 署名検証 / idempotency / zod parse / HTTP・result 化 / revalidatePath)。

### 4.1 A. review-events/bulk → `lib/reviews/`

- **移動**: `processSession`(signature 不変: `db, user, session, events, measure`)+ `deriveRating` + `toPgTimestamptz` + payload zod schema 群(`sessionSchema` / `eventSchema` / `payloadSchema` + infer 型)→ 新 module(例 `lib/reviews/ingest-review-events.ts`)。
- **schema の所在**: zod schema は use-case の入力型と一体のため lib 側へ移し、route が import して **parse 実行は route に残す**(wire 境界 = parse の実行)。既存 precedent = clerk route(schema は `lib/validation/clerk-webhook.ts`、parse は route)。型を route に残すと lib→app 型逆依存(lint Block A 違反)になるため、この形が唯一 lint 中立。
- **route 残留**: 認証(getCurrentUser / 401 分岐)/ measure closure 定義(TEMP marker)/ payload parse / **Phase 0 session upsert**(tx 外・503/400 error path 込み — 現仕様どおり tx に含めない)/ response 化。
- **制約**: 単一 tx(Phase 1〜2f)+ count mismatch 防御を processSession ごと as-is 移動(条件 2 の「1 関数 = 1 tx」を自然充足)。`review_events.bulk.tx_failed` 等の log イベント名不変。

### 4.2 B. stripe webhook → `lib/stripe/`

- **移動**: `handleEvent` + `normalizeSubStatus` + `resolvePlanFromSub` + `extractSubFields` + `evaluateReleaseGate` + `extractCustomerId` → 新 module(例 `lib/stripe/handle-stripe-event.ts`)。`extractCustomerId` は export(route の outer catch も使用)。
- **route 残留**: `requireWebhookSecret` / signature 検証(constructEvent)/ `stripe_events` idempotency INSERT / outer catch(notifyWebhookError + `'handler error swallowed'` 200)。
- **制約**: status matrix(baseline §B: unpaid/incomplete → status=past_due + plan=free 非対称含む)/ 6 event の DB 書込値 / notifyOps subject 群 / release gate の分岐(方向2 保険・mismatch anomaly 通知)を byte 単位温存。text response 5 種と status は route 残留側で不変。

### 4.3 C. clerk webhook → `lib/clerk/`

- **移動**: `handleEvent` + `handleUserDeleted` + `recordFailure` + `isCustomerMissing` + `isTransientDbError` + `runTransactionWithRetry` + `CANCEL_TARGETS` → 新 module(例 `lib/clerk/handle-clerk-event.ts`)。retry helper 群は**統合せず同居移動**(P4 送り・§1.3)。
- **route 残留**: `requireWebhookSecret` / svix 検証 / zod safeParse(schema は既に lib)/ `clerk_events` idempotency INSERT / outer catch。
- **制約**: Stripe cancel ループ = **tx 外**(現仕様: Stripe 失敗が記録されても DB tx は forward-only)を維持 / 10 テーブル明示 DELETE + soft delete PII scrub = 単一 tx 1 関数のまま / route.test の **10 DELETE 網羅性 invariant test が move 後も同じ実体を検証**していること(条件 3 の重点確認先)。「8 テーブル」コメントは移動時に「10」へ修正(§3.5)。

### 4.4 D. process.ts in-place 分解

- **entry(現 path・`process.ts`)に残す**: `'use server'` + `processUpload`(revalidatePath finally)+ 全型 export + `_processUpload` の orchestration(結果分岐・**日本語文言の組み立て**を含む — 文言は wire 契約ゆえ entry の result 化に同居が自然)。
- **分割先(`_actions/` 配下・非 'use server' module)= 2 module**(file 単位の最終形は plan で確定):
  1. **guard module**: guard tx 関数(`GuardTxResult` union 返却・advisory lock〜sourceDoc INSERT 一体)+ `parseDailyLimit`。
  2. **persistence module**: 保存 tx 関数(cards INSERT + applyOcrTags + card_count)/ 完了 tx 関数 / `markFailed`。
- **entry 側に残る orchestration**: formData parse・ページ数算出・上限チェック(DB 非依存前段)、base64 変換、OCR pipeline 呼出(AI 呼出は数行 + error 文言が本体のため entry の文言 mapping と同居)、preview 構築。
- **制約**: 条件 2(1 関数 = 1 tx・§3.2)。`GuardTxResult` union / error code 11 種 / 文言 / revalidatePath 2 対象常時発火 / notifyOps subject 3 種 / `ocr.*` log イベント名 = 不変。

### 4.5 E. 付随回収

§3.5 のとおり(C の task 内で実施)。

---

## 5. 回帰検知の正(behavior-preserving の検証)

P2 の変更面は **P0 golden 4 面に直接出る**(review-events / upload / webhook stripe・clerk。entity-mutations は P2 非対象だが全面 green を gate に含める):

1. **P0 contract/golden green 維持**(最上位): `pnpm test:contract` exit 0。赤 = 挙動が変わった = 即停止(条件 4)。
2. **route.test 4 本 green 維持** + 条件 3 の mock 境界確認(task ごと)。特に clerk の 10 DELETE invariant test。
3. **whole-repo `pnpm lint --max-warnings=0`**: 新 lib module が Block A(lib→app)違反を作らないこと(A/B/C の import は全て lib→lib で中立、D は app 内分割で中立)。
4. **`pnpm typecheck`**。
5. **`pnpm build`**: risk task(§7 — A〜D 実質全 code task が該当見込み、粒度は plan で確定)で per-task 実行、全体は最終 gate 集約(P1 と同じ粒度分離)。route の `export const runtime = 'nodejs'` 等 Next 契約 export は route 残留で不変。

---

## 6. Deliverables

1. 新 lib module ×3(`lib/reviews/` 新 dir / `lib/stripe/` 追加 / `lib/clerk/` 新 dir)+ route 3 本の wire 境界化。
2. process.ts の in-place 分解(entry + guard + persistence、現 path・export 不変)。
3. clerk stale コメント修正(8→10)。
4. SSoT 進捗表の P2 状態更新(spec 起草中 → plan 確定 → 実装中 → 完了 + HEAD SHA、各 commit と同 commit で)。
5. baseline §B(vi) へ P2 の触った surface を追記(phase 完了時・まとめ smoke 申し送りの運用)。

---

## 7. 完了条件

- `pnpm test`(contract 含む)/ `pnpm test:contract` 単独 / whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` 全 exit 0。報告に「whole-repo lint exit 0 確認済」1 行明記。
- P0 golden 全面 green(snapshot 更新ゼロ = 契約不変の証明。snapshot 更新が必要になった時点で停止・OT 相談)。
- route.test 4 本 green + 条件 3(mock 境界)の task ごと確認記録。
- canonical review 全 code task pass + Codex 独立 review は risk task(A = tx 境界 / B = 決済 / C = 認証・削除 / D = tx 境界・課金ガード — 実質全 code task が risk 該当、plan で粒度確定)pass。未解決 Critical 0 / Important 0。
- 新 lib module が app/ を import しないこと(lint + 目視)。
- SSoT の P2 状態欄 = 完了 + HEAD SHA + 再スキャン記録。

---

## 8. 非目標 / 申し送り

### 8.1 P4 送り(再掲・§1.3)

retry・transient 統合(clerk の `runTransactionWithRetry` / `isTransientDbError` は移動先で局所 helper のまま)/ route 認証 boilerplate wrapper / outbox flush 層共通化 / pull server factory。

### 8.2 measure 計測配管(TEMP marker)

review-events の per-phase timing 計測は「計測 campaign 後に revert」注記付きの TEMP 実装だが、timing log イベント名は D-2 凍結対象のため P2 では配管ごと温存。revert するかは OT 判断の別 task(P2 完了報告で再掲する)。

### 8.3 重要 fix 裏取り規律との関係

B(決済)/ C(認証・削除)は「決済・認証・削除」領域だが、P2 は**ロジック不変 refactor**であり CLAUDE.md「重要 Fix の裏取り」(OT 実機確認まで [reviewed] 保留)の対象外(同規律の除外規定「ロジック不変 refactor は対象外」)。ただし review は canonical + Codex の二重で行う(§7)。

### 8.4 まとめ smoke への申し送り

P2 完了時に baseline §B(vi) へ追記する surface(見込み): 演習フロー(回答 flush → dashboard 反映)/ upload フロー(OCR → preview)/ 決済 webhook 経路(stg では Stripe CLI 転送のみ)/ アカウント削除経路(OT 実機領域)。確定は phase 完了時。

---

## 9. Codex cross-check(plan 段階で実施)

CLAUDE.md「plan 段階の Codex 協調」に従い、fact-finding(§2)+ 要件(§1/§3)を主入力、plan ドラフトを参考添付(anchor 防止)として `scripts/ai/codex-plan-review.sh` を **plan 確定の前**に 1 回実行する。spec 段階では inline self-review のみ(brainstorming skill step 7)。実装 review 段階の Codex(`codex-review.sh`)は §7 の risk task で実施。

---

## 付録: 参照

- SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`
- P2 handoff: `docs/plans/2026-07-07-p2-handoff.md`(orientation・本 spec が具体化)
- P0 baseline: `docs/audit/2026-07-06-p0-contract-baseline.md`(§B(i) 凍結契約 inventory / §B(iii) test 役割分担 / §B(vi) まとめ smoke)
- 調査: `docs/audit/2026-07-05-ddd-refactor-investigation.md`(§3.3 / §6.1 / §6.3)
- P1 spec: `docs/superpowers/specs/2026-07-07-ddd-p1-domain-extraction-design.md`(carve-out の型・判断記録形式の前例)
- grounding: 本 spec §2(現 HEAD `b3bcb07` 再スキャン結果)
