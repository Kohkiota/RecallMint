# Order-1 — base_order 導入 + question_label 転換 実装 plan(r2 — Codex cross-check 反映済み)

> Codex raw = `docs/codex/2026-08-14-plan-order-1-base-order.md`(独立 14 / 抜け 16 / リスク 8)。抜け 16 件の採否 = **採用 13(うち部分採用 3: 抜け 1(動的並走 iso は不採用・静的重複ケース + 非並走限定明記で対応)/ 抜け 8(恒久 DDL iso pin は不採用・目視照合 + doc 記録)/ 抜け 11(iso EXPLAIN pin は不採用・stg 観測 — Sprint B 同裁定))/ 不採用 2(抜け 12 = TS strict の代入不能が既に強制 / 抜け 13 = ゼロユーザー窓の一過性)**。独立・リスク段の不成立 3(反証): label 比較のブラウザ依存(現設計は `<` 比較で locale 非依存)/ 独立 7(cardsPreview 無改変で対応済)/ 独立 8(spec §5.3 が同一 tx を規定済)。反映は本 r2 に「(Codex 抜け N 採用)」の帰属付きで織込済。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 凍結 spec(`docs/superpowers/specs/2026-08-14-order-1-base-order-design.md` r2)を、常時 green の 4 task で実装する。

**Architecture:** 先に schema 非依存の順序 domain(pure 関数)を Task 1 で確立し、Task 2 で migration 0037 + 全層 rename + create/publish への採番配線を **1 つの型閉包**として一括する(sort_key rename は drizzle property → mapper → ClientCard → UI literal union と連鎖するため、分割すると中間状態で typecheck/iso が通らない — scaffolding を task に割らない原則とも整合)。Task 3 は新規保証の pin(test-only 増)、Task 4 は sprint 完了 gate。

**Tech Stack:** Drizzle(`pnpm db:generate` / `db:migrate`)/ Dexie(version bump なし — spec D-5)/ Vitest + `pnpm test:iso`(実 PG)/ Gemini prompt は 1 行追記のみ。

**Spec:** `docs/superpowers/specs/2026-08-14-order-1-base-order-design.md`(r2・凍結。順序契約 = §2 が正本)

## Global Constraints(全 task に適用)

- spec r2 は凍結。仕様判断が必要になったら停止して OT 相談(自走継続条件の停止理由に該当)。
- 各 feat task = canonical review(superpowers:requesting-code-review 既定経路)pass → Codex(`scripts/ai/codex-review.sh <topic>`)Critical 0・Important 0 → `[reviewed]` commit。test-only task は「保証の増」分岐(red 検証 + 簡易 review)。
- 語彙固定: 列 = `question_label` / `base_order`、stride 定数 = `BASE_ORDER_STRIDE = 1024`、CHECK = `cards_base_order_positive`、index = `cards_order_idx`。全順序 = `(base_order ASC, id ASC)`(spec §2.1)。
- Gemini wire の field 名 `sort_key` は**変更しない**(spec D-8)。`ocr-response.ts` / `ocr-image-crop-response.ts` / `lib/ai/ocr.ts` は不触。
- Dexie の `stores()` 宣言・version は**不触**(spec D-5)。`base_order` の update_field handler は**作らない**(spec D-6)。
- `--no-verify` 全面禁止。AI 呼出は mock。ユーザー 0 前提(切替窓の loud failure は spec §9 で裁定済)。

## 削除 → 置換 pin 対応表(削除で green にしない)

| 削除 | 置換 pin(置き場所) |
|---|---|
| `nextCardSortKey` + その unit test | `nextBaseOrders` unit(Task 1)+ `buildEmptyCard` が `questionLabel: null` + 末尾 base_order を返す(Task 2 の empty-card test 書換 — spec §10-8) |
| `sortLikeServer` + `sort-like-server.test.ts` | `compareByBaseOrder` / `AcrossExams` unit(Task 1)+ server/client 一致 iso(Task 3-1)。旧「文字列辞書順 + NULLS LAST」の保証は `compareByQuestionLabel` unit(Task 1)へ移る(用途 = label 列ソート専用に縮小・spec 決定 3) |
| `cards_sort_idx` | `cards_order_idx` の存在は migration 適用(iso global-setup)自体が前提化。ラベルで WHERE/ORDER する server query 不在は spec §3.2 の根拠(query 追加時は Grid-3 以降の設計判断) |
| 既存 `ORDER BY sort_key, created_at`(server ×2) | publish 採番 iso の「INSERT 後 `ORDER BY base_order, id` = prepared 配列順」(Task 3-2)+ 一致 iso(Task 3-1) |

---

### Task 1: 順序 domain module(pure)+ unit

- 目的: `lib/cards/domain/card-order.ts` を新設し、順序契約 §2 の全計算を 1 定義に集約する。export 5 点:
  - `BASE_ORDER_STRIDE = 1024`
  - `nextBaseOrders(maxExisting: number | null, count: number): number[]` — `(max ?? 0) + i·S`(i=1..count)
  - `compareByBaseOrder(a, b)` — 引数は構造的型 `{ base_order: number; id: string }`(ClientCard 非依存 — Task 2 前に単独 green にするため)。id は素の `<` 比較(`localeCompare` 禁止・spec §2.1)
  - `compareByBaseOrderAcrossExams(a, b)` — `{ exam_id: string; base_order: number; id: string }`、exam_id → base_order → id(spec §2.5)
  - `compareByQuestionLabel(a, b)` — `{ question_label?: string | null; base_order: number; id: string }`、label 文字列 ASC + NULLS LAST → (base_order, id) tiebreak(spec §6.2)
- 制約: I/O なし・import なし(型のみ可)の pure module。既存 file は一切触らない(配線は Task 2)。`nextBaseOrders` の入力契約は JSDoc で明記(count = 0 以上の整数 / maxExisting = 1 以上の整数 or null — **検証は呼出側契約・防御分岐は書かない**。呼出側は SQL max / mirror max / cards.length のみで異常値は構造上生じない)(Codex 独立 4 / 抜け 7 対応 — 防御しない方針の明文化)。
- test(`card-order.test.ts`): nextBaseOrders(null→[1024] / max=3072,count=3→[4096,5120,6144] / count=0→[])/ compareByBaseOrder(昇順・id tiebreak・重複 base_order でも決定的 = shuffle 2 回で同一列)/ AcrossExams(exam グループ化)/ QuestionLabel(NULLS LAST — **undefined と null を同一扱いで固定**・tiebreak)。3 comparator 共通で **反対称性(compare(a,b) = -compare(b,a))・同一 id で 0・入力配列の非破壊**を assert(Codex 独立 6 採用)。
- 完了条件: 対象 unit green + typecheck + [reviewed]。

### Task 2: migration 0037 + 全層 rename + 採番配線(spec §3〜§9 本体)

- 目的: `sort_key → question_label` rename と `base_order` 導入を、DB から UI までの型閉包 1 commit で完了する。
- migration(spec §3 verbatim): `pnpm db:generate` で 0037 を生成 — RENAME COLUMN / ADD COLUMN base_order integer NOT NULL(default なし)/ CHECK `base_order >= 1` / DROP INDEX `cards_sort_idx` / CREATE INDEX `cards_order_idx (user_id, exam_id, base_order, id)`。**生成 DDL が RENAME でなく DROP+ADD になったら停止して OT 相談**(drizzle-kit の rename 検出は対話 prompt — 非対話で崩れたら custom SQL 採用は OT 裁定)。
- 変更(層別 — spec §8 の列挙と 1:1):
  - server: `lib/db/schema.ts`(列 + index)/ `lib/exams/list.ts`(ORDER BY ×2 → `.orderBy(cards.baseOrder, cards.id)` + `ExamDetailCard.questionLabel`)/ `lib/db/cards-mapper.ts`(両方向 + base_order 透過)/ `lib/cards/apply-card-mutation.ts`(input `baseOrder` 追加 + INSERT 供給)/ `lib/cards/card-field-handlers.ts`(key rename・handler は base_order 不触)/ `lib/cards/domain/card-rules.ts` / `lib/sync/shared/mutation-schemas.ts`(`question_label: questionLabelSchema` + `base_order: z.number().int().min(1)` 必須)/ `lib/validation/card.ts`(schema rename)
  - OCR: `lib/ocr/normalize-prepared.ts`(継ぎ目 1 行 `questionLabel: data.sort_key ?? null` + 継ぎ目 comment)/ `lib/ocr/prepared-schema.ts` / `publish-prepared-plan.ts`(`buildCardRows(cards, images, ctx & { maxBaseOrder: number | null })` が `nextBaseOrders(maxBaseOrder, cards.length)` を配列順割当)/ `publish-prepared.ts`(publish tx 内・cards INSERT 直前に `SELECT max(base_order) WHERE user_id AND exam_id`)/ `lib/ai/prompts/ocr-extract.ts` に spec §5.2 の 1 行(「cards[] は文書の読み取り順(ページ順・ページ内の出現順)に出力する。番号の昇順への並べ替えはしない」)
  - client: `lib/client-db.ts`(`question_label?` rename + `base_order: number` 追加・stores() 不触)/ `lib/cards/next-card-sort-key.ts` **削除**・`lib/cards/sort-like-server.ts` **削除**(importer 4 箇所を Task 1 の comparator 直 import へ。`inline-card-list.tsx:43` の互換 re-export も新名へ)/ `empty-card.ts`(`buildEmptyCard(existingBaseOrders: number[], existingCount)` → `questionLabel: null` + `baseOrder`)/ `build-new-client-card.ts` / `card-write.ts`(patch = `question_label: null` + `base_order: number`)/ `get-custom-session-cards.ts`(sequential = `compareByBaseOrderAcrossExams`)
  - UI(rename + 既定順置換のみ): `inline-card-list.tsx`(pre-sort = `compareByBaseOrder`・field/placeholder・buildEmptyCard 呼出)/ `exam-card-table.tsx`(pre-sort)/ `exam-card-table-columns.tsx`(列 id・`sortingFn = compareByQuestionLabel`・filterFn)/ `exam-card-side-peek.tsx` / `inline-text-field.tsx`(union)/ `exam-detail-view.tsx` + `exam-card-table-test-harness.tsx`(columnVisibility key)/ `exam-card-table-filter-editors.tsx` / `card-filter-labels.ts`。表示ラベル「ソートキー」→「番号」・placeholder `(番号)`(spec §12-6 承認済)
  - scripts: `seed-perf-exam.ts`(base_order = `i·S` + questionLabel = 旧 4 桁文字列)
  - test 追随: 既存 unit の rename 追随 / `tests/fixtures/pull.ts`・`entity-mutations.ts` / iso の cards INSERT 全箇所に base_order 供給(`tests/integration/pg/setup/fixture.ts` ほか)/ `check-constraints.test.ts` の POSITIVE_CASES に `cards_base_order_positive`(legal `1` / illegal `0`,`-1` / nullAllowed false)/ OCR golden は `mock-exam-page1.expected-cards.json` のみ rename(response.json 不触)
- 制約: ロジック変更は「ORDER BY 置換 / create・publish 採番配線 / prompt 1 行 / 既定順 comparator 置換」の 4 種のみ — それ以外は機械的 rename。採番式を Task 2 内で再実装しない(必ず `nextBaseOrders` を import)。
- 前提注記(現物確認済・Codex 独立 2/3 対応): ① `getCardsForSourceDocument` は Order-1 では単一 exam に閉じる(WHERE = user_id + source_document_id / publish は単一 exam へ INSERT / 移動経路なし)。ORDER BY は `cards_order_idx` で解決しない(exam_id 等価なし)が、旧 `cards_sort_idx` でも同様に解決していなかった = **非退行**。WHERE は既存 `cards_source_document_idx` が担う。exam 移動導入後の再裁定は Grid-3 handoff(Task 4)。② 手動追加の max 母集団 = mirror の **exam 全件**(唯一の呼出元 `inline-card-list.tsx` handleAddCard の liveData はフィルタ非適用・pending create は楽観 insert 済みで含まれる。table view に追加導線なし)。
- 実装順の内部チェックポイント(1 commit のまま・Codex 抜け 15 採用): ① migration + schema + server 層(この時点の typecheck red は許容)→ ② client + UI で `typecheck` exit 0 → ③ test 追随で `test` / `test:iso` exit 0。切り分け不能な巨大 diff を作らない。
- 完了条件: `pnpm lint`(whole-repo)/ `typecheck` / `build` / `test` / `test:iso` 全 exit 0 + **rename 残存 re-grep**(`sort_key|sortKey` が許容リスト = Gemini wire 3 file(`ocr-response.ts` / `ocr-image-crop-response.ts` / `lib/ai/ocr.ts`)+ prompt の `q{sort_key}` 命名規則 + `normalize-prepared.ts` の継ぎ目 1 行 + `mock-exam-page1.response.json` + **tag 系の sort_key(別 entity・対象外)** 以外でゼロ件。Codex 抜け 4 採用)+ **生成 migration SQL を spec §3 と目視照合**(RENAME 形式 / NOT NULL default なし / CHECK / index 列順 — 結果は Task 4 の session doc に記録。Codex 抜け 8 の軽量採用)+ canonical + Codex Crit0/Imp0 + [reviewed]。

### Task 3: 順序契約の新規 pin(test-only・保証の増)

- 目的: spec §10 の未充足 pin 4 本を追加する(Task 2 の既存 test 追随ではカバーされない保証)。
  1. **server/client 一致 iso**(新 file `tests/integration/pg/card-order-agreement.test.ts`): 1 exam に base_order を shuffle(重複値 2 組を意図的に含む)した 50 行を INSERT → PG `ORDER BY base_order, id` の id 列と、同 row set を `compareByBaseOrder` で sort した id 列の**完全一致**を assert(uuid 文字列比較 = PG uuid byte order の pin を兼ねる — spec D-3)。
  2. **publish 採番 iso**(既存 `tests/integration/pg/publish-prepared.test.ts` に追加): 空 exam → S=1024 から配列順 / 既存 max=2048 の exam への追加 publish → 3072 から続き / INSERT 後の `ORDER BY base_order, id` = prepared 配列順。**test 名・comment に「非並走時限定の保証」と明記**(並走時の交互配置は仕様 — spec §2.1/§5.3。並走の結果状態 = 重複 base_order の決定性は pin 1 の重複ケースが静的に検証。Codex 独立 1 / 抜け 1 対応)。
  3. **create wire 検証**(bulk route or registry test): base_order 欠落 → per-mutation failed / `0`・小数 → failed / **正値 + `question_label: null` の create が DB に保存される成功 pin**(Codex 抜け 5 採用で拒否系 + 成功系の両面に拡張)。
  4. **決定 6 の pin**(2 層): card-field-handlers test の SET 句 assert(`questionLabel` + `updatedAt` のみ — repo 既存慣行)+ **iso で update_field(question_label)前後の base_order 不変を DB readback で 1 assert**(実装形式非依存の仕様レベル pin。Codex 抜け 6 採用)。
- 制約: **red 検証は pin ごとに個別変異**(まとめ壊し禁止 — 教訓準拠): ① comparator の id tiebreak を降順に変異 → fail ② `nextBaseOrders` 呼出を reverse 配列に変異 → fail ③ zod の `base_order` を optional に変異 → fail ④ handler SET に `baseOrder: 1` を注入 → fail。**変異は 1 件ずつ適用 → fail 確認 → 復元 → `git diff --stat` で差分ゼロ確認してから次へ**(戻し忘れ防止・Codex 抜け 14 採用)。実証 log を commit message の「red 検証」行に記録。
- 完了条件: 4 pin green + red 実証記録 + 簡易 review(canonical subagent へ専用観点 dispatch: 「各 pin の主張範囲の記述が正確か」)→ [reviewed]。

### Task 4: sprint 完了 gate + session doc

- 目的: 完了 gate を実走し、session doc を書いて stop checkpoint 報告で停止する。
- gate(CLAUDE.md 共通): whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit` 全 exit 0。依存・Next 設定は不触のため追加 gate なし。
- session doc: `docs/superpowers/sessions/2026-08-14-order-1-base-order.md` — 実測(生成 DDL の形 + spec §3 照合結果 / red 検証 log の要点 / rename 残存 re-grep 結果 / 逸脱ゼロ確認)を記録し `[no-review]` で即 commit。**Grid-3 handoff 節を必須で含める**(Codex 抜け 16 採用): ① 並走再採番・移動の収束意味論(決定性は保証済・「意図した順への収束」は未保証 = Grid-3 の必須設計課題)② `getCardsForSourceDocument` の単一 exam 前提は移動導入で崩れる(再裁定要)③ base_order handler 追加時の validation 契約(spec §2.4)④ 再採番の wire 形(per-card update_field / 専用 op)の採否(spec §2.3-3)。
- 報告(chat・OT 出力規律): 「whole-repo lint exit 0 確認済」「test:iso green 確認済」「pnpm run audit exit 0 確認済」を各 1 行明記 + 結論 3-5 行 + 判断必要 yes(push 判断)。
- 完了条件: 全 gate exit 0 + doc commit + 停止(push は OT)。

---

## Deploy / smoke(Task 4 stop 後・OT 指示で実施)

実施順: **cards=0 確認 → stg migration 0037 → push / stg deploy → smoke**。

1. **OT**: stg へ migration 0037 適用(`DATABASE_URL_ADMIN='...' pnpm db:migrate` — migrate 先行 → deploy の順、spec §9)。**適用直前に `SELECT count(*) FROM cards` を read-only 確認し、非ゼロなら中止**(空テーブル前提の運用検証 — Codex 独立 10 / 抜け 9 採用)。
   **この件数確認は OT(owner 接続)でしか行えない**(r2 は「CC が app role + tenant context で代行可」と書いていたが**誤り** — `cards` は RLS 対象で app role は tenant 単位でしか数えられず「表が空か」を答えられない。2026-08-14 実測で確認)。CC が代行できるのは「特定 user の cards が 0」までで、全体の空判定ではない。
   → push → stg deploy。
2. **復旧方針**(Codex 独立 11 / 抜け 10 採用): 0037 適用後に deploy が失敗した場合は **forward-fix 一択**(migration rollback・旧 code への切戻しはしない — 旧 code は新 schema に 23502 で書けないため。ゼロユーザーゆえ許容、spec §9 と同根拠)。
3. **CC smoke**(Playwright MCP・stg): ① 複数画像 upload → 試験詳細の並びが読み取り順(DB readback: app role + tenant context で `ORDER BY base_order, id` が 1024 刻み連番)② 同 exam へ追加 upload → 続き番号 ③ 手動追加が末尾 + ラベル空 ④ ラベル編集(inline)で行が動かない ⑤ ラベル列ソート ON/OFF ⑥ 回帰: pull 6-stream / entity-mutations 200・console error 0 ⑦ **EXPLAIN 観測 1 回**(getCardsForExam 相当の `WHERE user_id AND exam_id ORDER BY base_order, id` — Sort ノード有無を記録。iso での EXPLAIN pin は小規模 fixture の planner が seq scan を選び flaky なため stg 側で観測 — Sprint B と同裁定・Codex 抜け 11 の採用形)。

   **⑧ 全データ削除後の再検証**: ① を新規サインアップした test user で実施し、同 user で Stripe checkout(test mode)を完了。`checkout.session.completed` の delivery 200 に加え、`users.stripe_customer_id` / `stripe_subscription_id` / `plan` / `billing_interval` / `subscription_status='active'` が購入内容と一致し、webhook handler error 通知がないことを確認。① と合わせて post-wipe の認証・課金一巡を確認。

   ⑧ の実施分担(既存規律・CLAUDE.md §Smoke 確認): **account 作成(Clerk sign-up)と checkout 完了操作は OT**(sign-up は Turnstile で自動化不能 / 課金 API 実走系は OT 依頼対象)。**sign-in 以降の ①(upload → 並び確認)と DB readback(5 列照合)・Discord 通知不在の確認は CC 自走可**(sign-in は OTP `424242`、DB は app role + tenant context)。分担の切れ目は smoke 実施時に OT へ ① URL ② 手順 ③ 期待挙動 ④ mobile 要否 を整理して依頼する。
4. prod 反映判断は smoke 結果を見て OT(prod 側も migrate 先行 + 件数確認)。

## 完了の定義

- Task 1-4 全 [reviewed](Task 4 の doc は [no-review])+ gate 全 exit 0 + stop checkpoint 報告。
- spec からの逸脱ゼロ(逸脱が必要になったら停止して OT 相談)。
