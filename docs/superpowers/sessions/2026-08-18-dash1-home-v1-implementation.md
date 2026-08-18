# Dash-1 Home v1 実装 — 中断時点の記録(2026-08-18)

- 状態: **Task 5/13 まで完了・Task 6 が未 commit で進行中**。OT 指示により中断。
- plan: `docs/superpowers/plans/2026-08-18-dash1-home-v1.md`(r2)
- spec(凍結): `docs/superpowers/specs/2026-08-18-dash1-home-v1-design.md`(r2)/ 定義 doc `2026-08-17-dashboard-metric-definitions.md`(r3)
- 実行方式: `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)
- SDD ledger(scratch・gitignored): `.superpowers/sdd/2026-08-18-dash1-home-v1/progress.md`

## 1. 再開手順(これだけ読めば再開できる)

1. `git log --oneline e1740c3..HEAD` で 5 commit(Task 1〜5)を確認。**すべて未 push**。
2. `git status` に Task 6 の**未 commit 変更**がある(下記 §3)。**`git clean -fdx` / `git checkout -- .` を実行しない**。scratch(`.superpowers/`)も同時に消える。
3. Task 6 は実装 + Codex Critical 修正まで完了し、**canonical review が未完**(中断時に API 障害で再実行中だった)。再開時は canonical review から。
4. canonical pass → commit(`[reviewed]`)→ Task 7 以降へ。

## 2. 完了 task(全て review clean・未 push)

| Task | commit | 内容 |
|---|---|---|
| 1 | `73f3927` | migration 0040(`exams.daily_new_target` / `cards.first_reviewed_at` / `answer_events.origin` + summary rank index)+ 型/mapper 追随 |
| 2 | `af54857` | shared pure domain 層(`lib/dashboard/domain/`: 定数・分類・順序・推定・週)+ eslint 純粋性 block |
| 3 | `ea1baa7` | fold が `first_reviewed_at` を遷移時に 1 回だけ書く(SELECT 列 + VALUES + COALESCE の 3 点) |
| 4 | `42d9514` | origin を wire → ingest 正規化まで貫通(未知値 null 化・batch は 200) |
| 5 | `0af21a2` | 選択中試験 resolver + PullTrigger 初回 pull settle シグナル |

## 3. Task 6(未 commit・working tree)

**内容**: スマート復習の出題プール契約変更(全試験 `due <= now` → 選択試験 + state 別 review 部 + 上限付き新規部)。

変更 file: `study-session-host.tsx`(+test)/ `smart/page.tsx`(+test)/ `get-dexie-session-cards.ts`(+test)/ `get-session-cards.ts`(+test)/ `tests/integration/pg/read-isolation.test.ts`
新規 file: `lib/cards/domain/session-pool.ts`(+test)/ `lib/cards/session-pool-equivalence.test.ts`

**pool selector の署名**(Task 11 が消費する):
```ts
selectSessionPool<T extends SessionPoolCard>(input: {
  cards: readonly T[]; examId: string; dailyNewTarget: number | null; now: Date
}): { pool: T[]; reviewCount: number; newCount: number; nextAvailableAt: Date | null }
```

**状態**: 4 gate 全 green(`pnpm test` 5533 / `test:iso` 471 / typecheck 0 / lint 0)。Codex Critical 1 件を修正済み(下記)。**canonical review 未完**。
report / commit message は `.superpowers/sdd/2026-08-18-dash1-home-v1/task-6-{report,commit-msg}.md|txt`。

## 4. レビューが捕まえた実バグ(記録)

**実装そのものの欠陥は 3 件で、全て Codex または canonical の独立レビュー由来。**

| # | 検出 | 内容 |
|---|---|---|
| 1 | Codex(T1) | `toClientCard` が `first_reviewed_at` を常時付与し round-trip 契約が破れていた。`pnpm test`(unit)が gate に無く未検出だった |
| 2 | Codex(T5) | `lock-busy` を settle 扱いにしていた。他タブが pull 中で mirror が空/stale のまま Home が「試験 0」を確定表示する |
| 3 | canonical(T5) | **上の隣の分岐** `inflight-skip` に同型の欠陥。`runGuardedPull` が最初の await 前に同期でフラグを立てるため、StrictMode の二重 effect で settle を発火させる主体が消える。`reactStrictMode: true` ゆえ **dev で Home が毎回 skeleton 固着** |
| 4 | Codex(T6) | `selectionStartedRef` が恒久 ref で、解決後に server cards が届いても再選定されず**空セッション固着**。試験切替でも前試験のカードが残る |

**残る Important 指摘 8 件は全て「証拠が主張を支えない」型**だった: 消しても通る mapper の pin / 恒真の境界式 / 上限を消しても通る fixture / 検出器の無い防御層 / 回数を観測しない「1 batch = 1 行」pin / 値を pin しない host / 未 test の禁止方向。

## 5. 裁定(Ruling)一覧 — 再開時に有効

| # | 裁定 | 誤りのコスト |
|---|---|---|
| 1 | `ORIGIN_VALUES` + pure `normalizeOriginValue` は shared に、logger を伴う wrapper は ingest 側に分離 | module 1 つの移動 |
| 2 | 30 暦日境界の iso pin は T8 に置く(T2 は pure helper のみ) | pin の置き場 1 つ |
| 3 | **T12(dead route 削除)は OT の外部利用確認が未充足のため保留**。他 task は継続 | 後続で commit 1 本 |
| 4 | `selectSessionPool` の返り値を T11 が再計算せず消費する | 署名変更 1 箇所 |
| 5 | worktree を作らず `develop` 上で実装(本 repo の確立運用) | commit の付け替え |
| 6 | **implementer は commit せず unstage で返す**。controller が Codex + canonical → pass 後に `[reviewed]` で commit(`codex exec review --uncommitted` は commit 済みを見ないため) | commit 1 本の巻き戻し |
| 7 | **全 task の gate に `pnpm test` を追加**(plan の T1 完了条件から欠落していた) | なし |
| 8 | `build-new-client-card` の `first_reviewed_at` 欠落は Minor 分類だが、後続の `u` 導出述語(`!== null` か `!= null`)に直結するため load-bearing として修正 | 新規カードが「導入済み」と誤判定 |
| 9 | `STREAK_WINDOW_DAYS` / `formatStreakDisplay` は `lib/streak-core.ts` へ(pure・server/client 双方が既に import 済)。`lib/db/streak.ts` の -60 収束は範囲外 | 定数 1 つの移動 |
| 10 | `lib/dashboard/domain/**` に eslint 純粋性 block を追加(既存 5 層に前例) | config 数行 |
| 11 | COALESCE は削除せず **isolated detector を追加**(`applyCardFinalStates` 直呼びで他 2 層を迂回) | iso test 1 本 |
| 12 | client flush は schema 失敗を terminal にするため、**query 由来 origin は必ず `normalizeOriginValue` を通す**(T6/T7 の必須制約) | 実データ損失 |
| 13 | T4 report の相互参照ずれは park(恒久記録の commit message は正確・scratch のみ) | なし |
| 14 | `inflight-skip` にも `lock-busy` と同じ bound を与え**両分岐を統一**(分岐を別扱いしたことが Critical の原因) | skeleton 固着 |
| 15 | T5 の timer 追跡は**整頓であって正しさの guard ではない**(cancelled は cleanup で同期に立ち timer は macrotask)。未 pin で許容・report の「個別に必要」記述は訂正 | なし |
| 16 | keyed Provider 配下に `{children}` が入り user 切替で page subtree 全体が再 mount される件は受容(layout コメントに明記) | 切替時の再 mount コスト |

## 6. deferred(最終 whole-branch review で triage)

- **T2**: `isCarryoverAt` に production caller が無い → T11 で消費されるか、さもなくば削除
- **T3**: ingest 写像層(row→`ReplayCardState`)の「値」に detector が無い。TS strict は field の存在しか強制しない。**データ損失経路は閉じている**(新規は遷移で値を得る / 既存は COALESCE が守り、その COALESCE には detector が付いた)
- **T5**: `lib/sync/pull.ts` に AbortSignal/timeout が無い。production の単一 mount で最初の pull が hang し以後 kick が来ない場合、bound を発火させる sibling chain が無く Home が skeleton 固着。**本 sprint の導入ではなく pull 経路の既存性質**
- **T6**: `session_limit` cap を JS で選定後に適用(query 側で掛けると未到来 step が席を埋め両経路が乖離するため)。代償 = Dexie が cap 超の行を materialize

## 7. 残 task(7〜13)

7 クイック演習 route / 8 summary endpoint(+ EXPLAIN で索引利用確認)/ 9 K 設定面 / 10 design tokens + widget-card / 11 Home 刷新 / 12 dead route 削除(**Ruling 3 で保留中**)/ 13 完了 gate + smoke 手順 session doc 化。

**T7 への必須申し送り**: Ruling 12(query 由来 origin の正規化)。
**T11 への必須申し送り**: Ruling 4(`selectSessionPool` の返り値を再計算しない)/ T2 deferred(`isCarryoverAt` の消費または削除)。

## 8. 運用メモ

- API server error による subagent 中断が 3 回発生(implementer 2 / reviewer 1)。いずれも作業内容とは無関係で、controller が現物状態を実測して再開すれば継続できた。**commit は review 通過後にしか行わないため、中断が中途半端な状態を確定させることはない**。
- 中断時は必ず「実装が半端に適用されていないか自分の変更を読み直せ」を再開指示に含めた(記憶上の最後の編集がディスクに乗っている保証がないため)。
