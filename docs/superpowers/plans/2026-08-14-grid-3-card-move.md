# Grid-3 — カードの試験間移動(card_move op + UI 4 入口 + 試験名 inline 編集 + undo)実装 plan(r2 — Codex cross-check 反映済み)

> Codex raw = `docs/codex/2026-08-14-plan-grid-3-card-move.md`(独立 27 / 抜け 24 / リスク表 12)。抜け 24 件の採否 = **採用 13(うち部分 5: 抜け 4(VALUES 一括を既定化・benchmark iso は不採用 → stg 実測)/ 抜け 11(pull outcome 非依存の注記)/ 抜け 20(hook 構造的保証で担保)/ 抜け 21(caller 単一の注記のみ)/ 抜け 23(smoke 失敗系 3 項のみ))/ 不採用 11**。不採用の根拠は 3 群: **凍結 spec / OT 裁定と衝突**(抜け 1・2 = undo の CAS 化は kickoff 決定 6「補償機構を作らない」+ spec §2.5 の LWW 受容・§5.4 検証範囲の裁定と矛盾 / 抜け 5 = client 事前拒否は OT が spec §11 追記で明示的に受容・再訪トリガー定義済み / 抜け 3 = overflow 防御は Order-1 §2.2 が「loud fail 許容・防御コード禁止」で凍結 / 抜け 8 = cross-exam undo の範囲は spec §5.4 裁定済)、**既存機構で充足**(抜け 9 = flush 成功→pull-back は既存 controller が起動 / 抜け 10 = read→write 窓は既存 bulk hook と同構造・LWW 受容 class / 抜け 24 = migrate 先行と deploy の分離は Deploy 節が既に規定 / 抜け 22 = 抜け 7 採用で吸収)、**iso で検証不能 → stg 代替**(抜け 17 = 実 HTTP body 上限 / 抜け 19 = 動的並走 iso は Order-1 と同裁定で不採用)。独立 26(未知 entity_type が batch 400 にならない pin)は部分採用(既存 pin 確認・無ければ追加)。反映は各 task に「(Codex 抜け N 採用)」の帰属付きで織込済。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 凍結 spec(`docs/superpowers/specs/2026-08-14-grid-3-card-move-design.md`)を、常時 green の 9 task で実装する。

**Architecture:** 下層から積む — ① 順序 domain の pure 計画関数(Task 1)② migration 0038 + `card_move` wire + server apply 一式(Task 2)③ 読み経路の再裁定(Task 3)④ exam rename レーン(Task 4)⑤ toast + client hook(Task 5)→ UI 3 入口(Task 6-8)→ 完了 gate(Task 9)。wire は追加のみ(rename 連鎖なし)なので Order-1 と違い型閉包の巨大 task は不要 — 各 task が独立に green。

**Tech Stack:** Drizzle(`pnpm db:generate` / CHECK 拡張のみ)/ Dexie(version bump なし)/ zod discriminated union(mutation-schemas)/ Vitest + `pnpm test:iso`(実 PG)/ Radix Popover(既存 wrapper)。新ライブラリ導入なし(toast は自作最小)。

**Spec:** `docs/superpowers/specs/2026-08-14-grid-3-card-move-design.md`(確定・凍結。集約 op 契約 = §2 が正本)

## Global Constraints(全 task に適用)

- spec は凍結。仕様判断が必要になったら停止して OT 相談。
- 語彙固定: entity_type = `card_move` / op = `move` / entity_id = **op instance uuid(client 生成)** / patch = `{ exam_id, cards: [{ id, base_order }] }`(cards は min 1・max 10,000・card id 重複 refine 拒否・base_order 値の重複は許容)。
- move apply の SET 句は **`exam_id` / `base_order` / `updated_at` の 3 列のみ**(spec 決定 8)。content_version・exams(source/target)・tombstone は不触(spec D-6 / §4.1)。
- exam は outbox に乗せない(spec D-8): 切り出しの exam 作成・改名は server action。`base_order` の update_field handler は作らない(spec D-3)。
- Dexie `stores()` / version は不触(entity_mutations の index 不変・cards store 不変)。
- 各 feat task = canonical review(superpowers:requesting-code-review 既定経路)pass → Codex(`scripts/ai/codex-review.sh <topic>`)Critical 0・Important 0 → `[reviewed]` commit。`--no-verify` 全面禁止。
- UI 文言は spec §7 の仮置き(「無題の試験」/ toast 15 秒 / gating 理由文言)を使い、実装時の見た目確認で OT 最終確認(spec §12-9)。

---

### Task 1: 順序 domain — 移動計画の pure 関数 + unit

- 目的: `lib/cards/domain/card-order.ts`(既存 pure module)に spec §2.3 / §5.1 の計画関数を追加する。export 3 点:
  - `type MovePlacement = { kind: 'end' } | { kind: 'start' } | { kind: 'after'; anchorId: string }`
  - `planMoveAssignments(input: { movedCards: OrderedCard[]; targetCards: OrderedCard[]; placement: MovePlacement }): { assignments: Array<{ id: string; base_order: number }>; renumbered: boolean }` — 内部で movedCards を `compareByBaseOrder` ソート(spec §2.3-1)/ 常駐列 = targetCards ∖ movedCards(§2.3-2)/ 末尾 = `nextBaseOrders` / 先頭・直後 = Order-1 §2.3-2 の `step = floor((B−A)/(k+1))`(先頭は A=0)/ step=0 → 常駐 `i·S` 再採番 + 再計算を**同一 assignments に畳む**(renumbered=true)/ k ≥ S(=1024)は合成列一括 `i·S`(終端規則・spec D-7)。anchor が常駐列に不在(移動対象含む)は `throw Error`(UI が除外済みの programming-error ガード)。
  - `planUndoAssignments(originals: Array<{ id: string; exam_id: string; base_order: number }>, sourceExamId: string): Array<{ id: string; base_order: number }>` — 元 exam_id = source の全 card を抽出(同一 exam 移動では再採番常駐を含む — spec §5.4)。
- 制約: I/O なし・import なし(既存 module の PURE 制約)。既存 export(`nextBaseOrders` / comparator 3 種)は不触・再実装禁止(必ず内部利用)。入力配列の非破壊。
- test(`card-order.test.ts` 拡張): 末尾/先頭/直後の割当値が凍結式と一致 / step=0 で常駐+移動の割当集合(renumbered=true)/ k=1023(step=1 で再採番のみ)と k=1024(終端規則)の境界 / 同一 exam 内移動(常駐から自身を除く)/ 移動対象の基準順ソート / anchor 不在・anchor=移動対象で throw / **undo round-trip: forward plan 適用 → planUndoAssignments 適用で元の順序に完全復元(同一 exam + step=0 再採番を含む forward を必須ケースに含める — spec §10-9 の反例)** / cross-exam forward の undo が移動対象のみを返す / 入力非破壊。
- 完了条件: 対象 unit green + typecheck + canonical/Codex Crit0・Imp0 + [reviewed]。

### Task 2: migration 0038 + card_move wire + server apply 一式(spec §2〜§4.3)

- 目的: 集約 op を DB CHECK → zod → registry → apply まで一括で通す(全て追加変更 — rename 連鎖なし)。
  - migration: `lib/db/schema.ts` の `entity_mutations_entity_type_enum` に `'card_move'`、`entity_mutations_op_enum` に `'move'` を追加 → `pnpm db:generate` で 0038 生成 → **spec §3 と目視照合**(DROP CONSTRAINT + ADD CONSTRAINT の 2 対。照合結果は Task 9 の session doc に記録)。schema comment(`schema.ts:657-673`)に entity_id 意味論の追記(「card_move の entity = 移動操作 instance、entity_id はその uuid」)。
  - wire: `lib/sync/shared/mutation-schemas.ts` に `cardMovePatchSchema`(exam_id: z.uuid() / cards: z.array(z.object({ id: z.uuid(), base_order: z.number().int().min(1) })).min(1).max(10_000) + card id 重複 refine)+ `cardMoveMutationEnvelope`(entity_type/op literal)を union(`:185-189`)へ追加。
  - apply: 新設 `lib/cards/apply-card-move.ts` — `applyCardMove(tx: DbExecutor, userId: string, entityId: string, patch: CardMovePatch): Promise<ApplyResult>`。手順 = spec §4.1: ① 移動先 exam owner 検証(0 行 → `'failed'`)② 対象 card owner-scoped 突合(不在 id は skip・全滅は空適用 `'applied'`)③ 存在割当を **`UPDATE ... FROM (VALUES ...)` の一括 1 statement** で UPDATE(SET = examId / baseOrder / updatedAt=now() のみ)— per-card loop は契約上限 10,000 で N 往復の tx 長時間化を招くため既定にしない(Codex 抜け 4 採用)④ 適用結果を構造化 log 1 行(`event: 'card_move.applied'` + requested / applied / skipped 件数 + examId — silent skip の不可視化防止。Codex 抜け 18 採用。metric 基盤は作らない)。
  - registry: `entity-mutation-registry.ts` に `card_move: { move: { patch: cardMovePatchSchema, apply: applyCardMove, cascadeLike: true } }`(skipLog なし = dedup log 有効)。
- 制約: bulk route(`app/api/entity-mutations/bulk/route.ts`)本体は不触(registry 駆動で透過)。card.create の cascadeLike 判断(follow-up 台帳)に触れない。
- test:
  - unit: SET 句 pin(`applyCardMove` の set が `{examId, baseOrder, updatedAt}` のみ = **question_label 不触** — spec §10-3)/ registry enumerate 9→10 件 + `card_move.move` の cascadeLike:true assert / group helper が card_move 混在 batch を serial fallback に倒す / route 拒否 matrix(exam_id 欠落・cards 空・card id 重複・base_order 0/負/小数・update_field `field:'base_order'` の dispatch miss → failed)/ **未知 entity_type が batch 全体 400 でなく per-mutation failed になる pin の有無を確認し、無ければ generic ケースで追加**(切替窓の旧 server 挙動の担保。Codex 独立 26 部分採用)。
  - iso: 原子性(N 割当が 1 tx・`ORDER BY base_order, id` readback が意図順)/ **不変条件 readback(移動前後で FSRS 全列・answered/current_streak・card_tags・answer_events・images・title/question_text・source_document_id・content_version が不変 — spec §10-2)** / 冪等(同一 mutation_id 再送 → skipped・log 1 行 / 別 mutation_id 同一 patch 再適用 → 結果不変)/ skip-missing(1 枚先行削除 → 残り適用 / 全滅 → 空適用 applied / 移動先 exam 不在 → failed)/ 他 tenant card id 混入 → 其行不変 / `check-constraints.test.ts` の registry 導出 parity が新語彙で green(`'exam'` illegal pin 維持)。
- 完了条件: `lint` / `typecheck` / `test` / `test:iso` exit 0 + canonical/Codex Crit0・Imp0 + [reviewed]。

### Task 3: getCardsForSourceDocument の順序再裁定(spec §4.4 / D-10)

- 目的: `lib/exams/list.ts` の `getCardsForSourceDocument` を `.orderBy(cards.examId, cards.baseOrder, cards.id)` に変更し、単一 exam 前提コメント(`list.ts:181-184`)を再裁定後の内容(「移動導入により §2.5 パターンで exam グループ化」)に書き換える。SELECT / `CardListEntry` 型は不変。
- 制約: `getCardsForExam` は不触(exam_id 等価条件のため影響なし)。index 追加しない(spec §3 の裁定 — `cards_source_document_idx` で行集合を引いた後の小規模 sort)。caller は `app/(app)/app/upload/result/[sourceDocumentId]/page.tsx:61` の 1 箇所・snippet 表示専用(現物確認済 — 意味順の要求なし。Codex 抜け 21 の照合結果)。
- test(iso): 1 source_document の cards を 2 exam に跨がせ(片方を card_move で移動)、`(exam_id, base_order, id)` 順で返ることを assert。
- 完了条件: 対象 iso green + canonical/Codex Crit0・Imp0 + [reviewed]。

### Task 4: 試験名 rename レーン(spec §6.2)

- 目的: 改名の書込経路と inline 編集 UI を新設する。
  - server: `app/(app)/app/exams/_actions/rename-exam.ts` — `renameExam(examId: string, name: string): Promise<ActionResult<null>>`。`create-exam.ts` の `nameSchema`(trim/min1/max200)を export 化して共有。owner-scoped `UPDATE exams SET name WHERE id AND user_id`(updated_at は `$onUpdate` 任せ)。0 行更新は failure message(既存 delete-exam の error 文体)。
  - UI: 新設 `app/(app)/app/exams/[id]/_components/exam-title-inline-edit.tsx`(client)— click → input、Enter/blur commit、Escape cancel、commit 中 disabled、成功 = local state 更新 + `router.refresh()` + `runGuardedPull({ reason: 'exam-rename' })`、失敗 = inline error(`option-row.tsx` rename パターン)。`exam-detail-view.tsx` の h1 ×2(`:219, :262`)を置換(props に examId 追加)。**race guard(Codex 抜け 13 採用)**: Enter → blur の二重発火は commit 中 flag で 1 回化 / trim 後値・未変更は no-op(action を呼ばない)/ 表示は commit 成功値(trim 済)で更新。
- 制約: exams の Dexie mirror へ楽観書込しない(read-only レーン維持 — spec §6.2)。`InlineTextField` は流用しない(card 専用)。試験一覧側の改名 UI は作らない。
- test: action unit(owner-scope 0 行 → failure / zod 境界: 空・201 字 → failure / 正常 → ok)+ component test(commit/cancel/error 表示 + **Enter→blur 二重発火で action 1 回・未変更 no-op**)。
- 完了条件: 対象 test green + canonical/Codex Crit0・Imp0 + [reviewed]。

### Task 5: toast 基盤 + useMoveCards hook + undo(spec §5.2〜§5.4 / §7.5)

- 目的: 移動実行と undo の client 機構を、UI 入口から独立に完成させる。
  - `components/ui/action-toast.tsx` — `ActionToast({ message, actionLabel?, onAction?, actionPending?, onClose }: Props)`。`billing-banner.tsx` の bespoke パターン(fixed / `role="status" aria-live="polite"`)+ action button 1 個 + auto-dismiss 15 秒 + 手動 close。グローバル store なし。**連続 move は単一 slot・最新で置換(旧 undo 素材は破棄・旧 timer は clear — timer race 防止)。二度押し防止の責務 = 親(発火元)が undo 発行状態を `actionPending` で渡し button を disabled**(Codex 抜け 14/15 採用)。
  - `app/(app)/app/exams/_hooks/use-move-cards.ts`(**placement のみ spec §8 の列挙(`[id]/_hooks/`)から変更**: 結合(Task 8・試験一覧階層)と共有するため 1 階層上に置く。設計不変・session doc に記録)— `useMoveCards({ userId }): { moveCards(input: { cardIds: string[]; targetExamId: string; placement: MovePlacement }): Promise<MoveResult> }`。手順 = spec §5.2: mirror read(対象 + 移動先常駐)→ `planMoveAssignments` → **割当対象全 card の originals `(id, exam_id, base_order)` を控える** → `runOptimisticMutation`(mutate = 割当ごと `db.cards.update(id, { exam_id, base_order })`・mirror updated_at 不触 / mutations = card_move envelope 1 件・`entity_id: newId()` / throwOnError: true)。`MoveResult = { ok: true; movedCount: number; originals: Original[]; sourceExamId: string } | { ok: false }`。
  - undo: 同 hook の `undoMove(result: MoveResult & { ok: true }): Promise<UndoResult>` — mirror 検証(card 欠け / 元 exam 消滅 → `{ ok: false, reason }` の理由 union)→ `planUndoAssignments(originals, sourceExamId)` → 逆方向 moveCards 相当を 1 mutation 発行。
  - **hook の runtime invariant(Codex 抜け 6/7 採用)**: ① mirror read 後、対象 card の元 exam_id が**単一**であることを assert(違反 = programming error → throw。undo 単一性の構造的保証 — spec D-9 を UI 規約から hook 契約へ格上げ)② 要求 cardIds のうち mirror 不在分は除外して続行(server の skip-missing と同意味論)・**存在 0 件は mutation を発行せず `{ ok: false }`**(no-op の明文化)。
- 制約: 採番・挿入計算を hook 内で再実装しない(Task 1 の関数のみ)。undo は補償機構でなく通常 move(新 mutation_id / entity_id)。既存 bulk hook(`use-bulk-card-tags.ts` / `use-bulk-card-delete.ts`)の構成・error 慣行に倣う。
- test: hook unit(既存 bulk hook の test 慣行に倣い fake Dexie / enqueue 捕捉): 割当と originals の整合 / envelope が 1 件・patch 形が契約どおり / **複数 source exam 混入で throw・mirror 不在分の除外・0 件 no-op**(Codex 抜け 6/7 採用)/ undo 検証失敗 path(card 欠け・exam 消滅の 2 理由)/ undo 発行 patch = originals 復元 / toast component の auto-dismiss・onAction 発火・actionPending disabled・**連続表示で旧 timer clear + 置換**。
- 完了条件: 対象 test green + canonical/Codex Crit0・Imp0 + [reviewed]。

### Task 6: UI 入口 a+b — 一括バー「移動」+ 切り出し(spec §7.1 / §6.1)

- 目的: `ExamCardTableActionBar` に 4 つ目の操作「移動」を追加し、`exam-card-move-popover.tsx` を新設する。
  - popover 内容: 移動先 exam の native `<select>`(mirror `db.exams`・updated_at desc・現 exam 含む)/ 配置 radio(末尾 既定・先頭・指定カードの直後)/ 「直後」選択時は anchor native `<select>`(移動先常駐を基準順・移動対象除外・表示 = question_label ?? title 先頭部)/ 「新規試験へ切り出し」ボタン。
  - 実行: 通常 = `moveCards` → 成功で toast(「N 枚を移動しました [元に戻す]」・undo 配線)。切り出し = `createExam('無題の試験')` await → `runGuardedPull({ reason: 'exam-create' })` → `moveCards`(末尾)→ toast。自動遷移しない(spec §6.1)。エラーは action bar の inline error 枠。**注記(Codex 抜け 11/12 採用)**: pull の outcome には依存しない(lock busy で skip されても新 exam は空ゆえ plan は mirror hydrate 不要で正しい — pull は一覧表示の追随用)。切り出し実行中は popover の実行系 button を disabled(二重 submit で「無題の試験」が複数できるのを防ぐ)。
  - gating: `sorting.length > 0 || columnFilters.length > 0`(`exam-card-table.tsx:283,285` の state を props で受ける)で「直後」を disabled + 理由「ソート/フィルタ適用中は位置指定できません(解除するか、末尾/先頭を使ってください)」。
- 制約: 選択 model(`rowSelection` / `selectedIds`)不触。popover は既存 `CardTagAddPopover` の Radix 構成に倣う。card ビューへの導線は作らない。
- test: component test(popover の配置選択と anchor 除外 / gating で「直後」disabled / 切り出しが createExam → moveCards の順で呼ぶ / **切り出し実行中の二重 submit 不発**)最小限。
- 完了条件: 対象 test green + canonical/Codex Crit0・Imp0 + [reviewed]。

### Task 7: UI 入口 c — 行メニュー「ここに取り込む」(spec §7.2 / D-9)

- 目的: table 行 select セルに行メニュー trigger(⋯)を新設し、pull 型取り込みを実装する。
  - `exam-card-row-menu.tsx`(新設・`ColumnHeaderMenu` の Radix Popover パターン、項目は「ここに取り込む」のみ)+ 取り込み picker dialog(`ConfirmDialog` の portal パターン転用): ① source exam native select(mirror・現 exam 除外・**1 操作 1 exam**)② その exam の card を基準順 checkbox リスト(検索・仮想化なし + 「多数の移動は一括バーの移動を使ってください」の説明文)③ 確定 → `moveCards(picked, 現 exam, { kind: 'after', anchorId: 行 card })` → toast。
  - trigger 配線: `exam-card-table-columns.tsx` の select セル(side-peek trigger `:114-128` の隣)。
- 制約: ソート・フィルタ適用中は menu 項目 disabled + Task 6 と同一の理由文言。picker の複数 source exam 選択は作らない(undo 単一性の前提 — spec D-9)。**source exam のカードが 200 件超なら checkbox リストを出さず「一括バーの移動を使ってください」を表示**(「少数枚用」の具体化・全件 render の freeze 防止。閾値 200 は仮置き。Codex 抜け 16 採用)。keyboard / Escape / focus return は Radix Popover・既存 ConfirmDialog の既定に乗り、disabled 項目は理由を `title` + `aria-disabled` で提示(Codex 独立 21 の軽量採用)。
- test: component test(menu 表示 / gating disabled / picker が単一 exam に閉じる / 確定時の moveCards 引数が anchor 行を指す)最小限。
- 完了条件: 対象 test green + canonical/Codex Crit0・Imp0 + [reviewed]。

### Task 8: UI 入口 d — 試験一覧「結合」(spec §7.3)

- 目的: `exam-list-live.tsx` の行 action に「結合」を追加する(新設 `merge-exam-button.tsx`)。
  - `DeleteExamButton` の 4-phase inline 展開パターン: 合流先 native select(自身除外)+ 配置(末尾 既定 / 先頭)+ 確認文言(「N 枚を◯◯へ移動します。元の試験は空のまま残ります」)→ mirror から source 全 card を読み `moveCards(全件, 合流先, 配置)` → 一覧ページ側 toast(undo 配線)。
- 制約: 元 exam の削除・tombstone 化をしない。cardCount = 0 の行は disabled。移動機構は Task 5 の `useMoveCards`(共有 `_hooks/` 配置)を使う — 一覧側で再実装しない。
- test: component test(0 件 disabled / 確認文言に件数 / moveCards 引数 = source 全件・配置)最小限。
- 完了条件: 対象 test green + canonical/Codex Crit0・Imp0 + [reviewed]。

### Task 9: sprint 完了 gate + session doc

- 目的: 完了 gate を実走し、session doc を書いて stop checkpoint 報告で停止する。
- gate(CLAUDE.md 共通): whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit` 全 exit 0。依存・Next 設定 file 不触のため追加 gate なし。
- session doc: `docs/superpowers/sessions/2026-08-14-grid-3-card-move.md` — 生成 migration 0038 の spec §3 照合結果 / task 別 review 結果 / 逸脱有無 / **行 DnD への handoff 節**(① DnD は `card_move` op をそのまま消費(exam_id = 現 exam の割当)— 新チャネル不要 ② anchor UI の gating 条件の再利用点 ③ 残余リスク 2 項(spec §11)は claude.ai todo 起票済みの旨)を記録し `[no-review]` で即 commit。
- 報告(chat・OT 出力規律): 「whole-repo lint exit 0 確認済」「test:iso green 確認済」「pnpm run audit exit 0 確認済」を各 1 行明記 + 結論 3-5 行 + 判断必要 yes(push 判断)。
- 完了条件: 全 gate exit 0 + doc commit + 停止(push は OT)。

---

## Deploy / smoke(Task 9 stop 後・OT 指示で実施)

1. **OT**: stg へ migration 0038 適用(`DATABASE_URL_ADMIN='...' pnpm db:migrate` — migrate 先行 → deploy、spec §9)。CHECK 緩和のみでデータ前提なし(Order-1 の cards=0 確認は不要)。→ push → stg deploy。
2. 切替窓(spec §9): 新 client → 旧 server の card_move は per-mutation failed → pending 残置 → 新 server deploy 後の再送で適用(データ喪失なし)。deploy 失敗時も CHECK 緩和は旧 code と互換のため巻き戻し不要(forward-fix)。
3. **CC smoke**(Playwright MCP・stg): ① 同一 exam 内移動(複数選択 → 指定行の直後)→ 並び反映 + DB readback(`ORDER BY base_order, id`)② 試験間移動(末尾/先頭)+ 移動先で確認 ③ 切り出し(無題の試験が出来て移動・オンライン)④ 行メニュー取り込み ⑤ 結合(元 exam 空で残存)⑥ undo(toast から復元・DB readback で元順序)⑦ 移動前後の不変条件 readback(FSRS 列・card_tags・answer_events)⑧ ソート適用中 gating ⑨ 試験名 inline 改名 → 別端末相当(pull)反映 ⑩ 回帰: pull 6-stream / entity-mutations 200 / console error 0 ⑪ **1000 枚級 move の実測 1 回**(`scripts/seed-perf-exam.ts` を stg で実行して perf exam を作成した上で使用 — 全データ削除済みのため既存 seed は存在しない。apply latency と VALUES 一括の実挙動を観測 — iso benchmark 不採用の代替。Codex 抜け 4/17 の採用形)⑫ **失敗系 3 項**(連続 move で toast が最新に置換 / 対象カード削除後の undo → 理由表示 / offline 移動 → online 復帰で再送適用。Codex 抜け 23 部分採用)。
4. prod 反映判断は smoke 結果を見て OT(prod 側も migrate 先行)。

## 完了の定義

- Task 1-9 全 [reviewed](Task 9 の doc は [no-review])+ gate 全 exit 0 + stop checkpoint 報告。
- spec からの逸脱ゼロ(逸脱が必要になったら停止して OT 相談)。
