# Dash-1 Home v1 実装 — 中断時点の記録(2026-08-18)

- 状態: **Task 5/13 まで完了・Task 6 が未 commit で進行中**。OT 指示により中断。
- plan: `docs/superpowers/plans/2026-08-18-dash1-home-v1.md`(r2)
- spec(凍結): `docs/superpowers/specs/2026-08-18-dash1-home-v1-design.md`(r2)/ 定義 doc `2026-08-17-dashboard-metric-definitions.md`(r3)
- 実行方式: `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)
- SDD ledger(scratch・gitignored): `.superpowers/sdd/2026-08-18-dash1-home-v1/progress.md`

## 1. 再開手順(これだけ読めば再開できる)

1. `git log --oneline e1740c3..HEAD` で 5 commit(Task 1〜5)を確認。**すべて未 push**。
2. `git status` に Task 6 の**未 commit 変更**がある(下記 §3)。**`git clean -fdx` / `git checkout -- .` を実行しない**。scratch(`.superpowers/`)も同時に消える。
3. Task 6 は実装 + Codex Critical 修正まで完了。**canonical review は中断後に到着済**(結果は §3.1)。再開時は **§3.1 の Important 2 件の fix round から**。
4. fix → scoped re-review → **Codex 再実行**(§3.1 M-4)→ commit(`[reviewed]`)→ Task 7 以降へ。
5. **§3.1 の I-2 は spec の誤りで OT 裁定が要る**(task 内では直せない)。

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

**状態**: 4 gate 全 green(`pnpm test` 5533 / `test:iso` 471 / typecheck 0 / lint 0)。Codex Critical 1 件を修正済み。
report / commit message は `.superpowers/sdd/2026-08-18-dash1-home-v1/task-6-{report,commit-msg}.md|txt`。

### 3.1 canonical review の結果(中断後に到着・未対応)

**Spec ✅ / Task quality: Changes requested**(Critical 0 / Important 2 / Minor 4)。契約 15 項目すべて met、test 書き換え対応表も検証済(**契約変更と無関係な保証は全て存置**: テナント分離・型変換・limit 挙動・空入力・now 既定)。

- **I-1(要 fix)**: 選定キー `${resolvedExamId}|${server cards 到着有無}` が **同一試験での 2 回目の選定を許す**。`?exam=` 無しで入ると boolean が false→true に変わるため、① Dexie から選定し `SessionRunner` を mount → ② URL 正規化の RSC 往復で server cards が届き **回答中に pool が差し替わる**。`SessionRunner` は `cards` を snapshot せず live 参照する(`cards[idx]` / `cards.length` / `n / total` 表示)ため、`idx=1` の利用者に別カードが出て 1 枚飛び、カウンタも飛ぶ。`SessionLauncher` の `sessionId` は lazy `useState` なので remount による `idx` reset も起きない。**「1 session = 1 選定」を documenting しているコメント自体が偽**になる。未 pin(bookmark 再選定 test は「空の初回選定」からしか始まらないため、「既に非空の選定を置き換えない」が未 assert)。
- **I-2(OT 裁定事項・spec の誤り)**: spec §8.5 は「`/app/study/smart` への導線は home の `DashboardActions` のみ・nav からのリンクは grep 0 件」と書いているが、**`app/(app)/app/_components/app-header.tsx:50-51` に恒久の `<Link href="/app/study/smart">`(exam なし・origin なし)が存在**し、W2 置換後も残る。帰結: (a) I-1 の往復が bookmark の縁ケースではなく**主要導線**で常時起きる (b) nav クリックごとに RSC 往復 + `router.replace` のコスト (c) これらの session の origin が `smart` になるのは §8.5 上正しいが、棚卸し漏れの結果ではなく意識的な判断であるべき。**spec 凍結ルールにより task 内で直せない**。選択肢 = header link に `?exam=` を付ける / 現状維持して I-1 を締める。
- **M-1**: Dexie が選択試験の全 row を full record で materialize(旧経路は最大 `session_limit` 件)。state 分割・`base_order` 順・`u` は due range で表現できないため設計上妥当だが、**Y-2 subplan B の記録済み教訓と同型**。report の緩和論(Home と 1 回走査を共有)は `/app` の話で、このページには当てはまらない。大きい試験での実測を prod 前に。
- **M-2**: `reviewCount` / `newCount` は現時点 consumer ゼロ(T11 が消費予定)。
- **M-3**: server が 0 件を返し、その後 mirror が埋まる経路では再選定されない。**変更前と同挙動で退行ではない**が、コメントの「正しくなった入力には追随する」を完全と読ませないこと。
- **M-4**: **fix round 後の Codex 再実行が未記録**。CLAUDE.md の収束条件(保存 md で Critical 0 / Important 0)上、`[reviewed]` 前に 1 回必要。

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

## 9. Task 8 — summary endpoint(`GET /api/stats/summary`)の恒久記録

`.superpowers/sdd/**` は gitignore された scratch なので、**消えては困る事実だけ**をここへ移す。
実装は `lib/db/weak-tags-summary.ts`(集計)+ `app/api/stats/summary/route.ts`(HTTP 層)。

### 9.1 EXPLAIN(spec §10 / plan Task 8 の完了条件)

計測は使い捨ての iso test で **production の SQL object をそのまま `EXPLAIN (ANALYZE, BUFFERS) ${query}` に合成**して採取(写し間違いの排除)。採取後 instrumentation・temp test とも削除済み。

**(a) 小 fixture(8 cards / 25 events)— index 利用**

```
->  Bitmap Heap Scan on answer_events ae  (rows=25)
      Recheck Cond: (user_id = '…'::uuid)   Filter: applied
      ->  Bitmap Index Scan on answer_events_user_card_answered_idx  (rows=25)
->  Sort  Sort Key: ae.card_id, ae.answered_at, ae.event_id     (WindowAgg の入力)
Planning Time: 1.744 ms / Execution Time: 1.226 ms
```

migration 0040 の `answer_events_user_card_answered_idx` が選ばれる。ただし bitmap 経由なので順序は保存されず、WindowAgg 用の Sort が別に入る。

**(b) 大 fixture(user A = 24,001 events / 表全体 40,002 events・ANALYZE 済)— Seq Scan**

```
->  Seq Scan on answer_events ae  (rows=24001)
      Filter: (applied AND (user_id = '…'::uuid))   Rows Removed by Filter: 16001
->  Sort  Sort Key: ae.card_id, ae.answered_at, ae.event_id   (quicksort 2269kB)
Execution Time: 26.779 ms
```

**(c) 同 fixture + `SET LOCAL enable_seqscan = off`(診断のみ)— 索引順がそのまま使える**

```
->  WindowAgg (rows=24001)
      ->  Index Scan using answer_events_user_card_answered_idx on answer_events ae  (rows=24001)
            Index Cond: (user_id = '…'::uuid)   Filter: applied
Execution Time: 24.235 ms
```

**Sort node が消える**。index の列順 `(user_id, card_id, answered_at, event_id)` が `PARTITION BY card_id ORDER BY answered_at, event_id` とそのまま噛み合い、WindowAgg が索引順の入力を直接受け取る = 0040 でこの index を足した狙いそのもの。`enable_seqscan` は**診断 session の GUC** であり、production の query には planner hint を一切入れていない。

**(b) で Seq Scan が選ばれた理由 = 選択率(selectivity)**。この fixture では user A が 40,002 行中 24,001 行(≈60%)を占めており、**その選択率なら cache 状態に関係なく seq scan が正しい**。prod では 1 user は `answer_events` 全体のごく一部なので選択率が跳ね上がり、(c) の index path 側が選ばれる。
→ **「小さい test data で seq scan が出た」ことを索引不要の根拠にしないこと**。索引を落とす判断は prod の選択率で測り直してからにする。

### 9.2 裁定・解釈(コードだけからは読み取れないもの)

1. **同率判定の第 1 キーは `round` 後の整数**。spec §4-P は「復習正答率が同値のとき」としか書かず、生の比率で比較する解釈もありえたが、**表示値と順位基準を一致させる**方(§3.10)を採った。「表示は同じ 47% なのに並びが違う」を構造的に無くすため。`ORDER BY review_accuracy`(出力列別名)がこの意思であって書き損じではない — **「正確な式に直す」refactor は仕様変更**。iso の「同率判定は round 後の整数で行う」(X=7/15→47 / Y=8/17→47)がこれを pin している。
2. **`ranked` を試験で絞っていない**。card ごとの全期間を保つ限り exam で絞っても出力は同じで走査量は減るが、0040 の index が「user 全体を card 順に舐める」形を前提に置かれており、semi-join を挟むと planner が索引順を捨てて hash + sort に倒れやすい。spec §10 の文面にも素直。
3. **sign-up race(users 行未同期)の 200 応答には `owner_user_id` も `exam_id` も載らない**。`withReadOnlyAuth` の静的リテラル `emptyBody` の構造的帰結で、`/api/pull` が同じ論点を自身のコメントで決着させている既存 pattern。**この経路では handler 前に return するので `exam_id` 検証も走らない = 壊れた `exam_id` でも 400 でなく 200 になる**。→ **W4 client(Task 11)は「400 だけが不正 exam_id の信号」と思ってはいけない**。schema は `weak_tags` 必須 / echo 2 本を optional にし、**描画は echo 2 本の一致を条件にする**。

### 9.3 pin の穴(既知・意図的)

- **カード削除(§3.3a)**: `card_tags.card_id` が `ON DELETE CASCADE` なので、削除で集計から落ちる主因は schema の cascade であり、query 側の変異では red にならない。ただし cascade が効く限り「除外を落とす regression の形」は存在しないため穴ではない。**唯一の盲点は `cards` が soft delete 化された場合** — §3.3a が壊れるのに iso は green のまま通る(本番の削除が hard DELETE であることの根拠 = `lib/cards/apply-card-mutation.ts:161-163`)。
- **`tag_options` / `tag_categories` の owner 絞り、`cards.user_id` 絞り**: RLS(tenant tx)との二層防御なので、片方だけ外しても red にならない。単層変異が green なことを欠陥と読まない。
