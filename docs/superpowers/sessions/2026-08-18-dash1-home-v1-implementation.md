# Dash-1 Home v1 実装 — 引継ぎ記録(最終更新 2026-08-19)

- 状態: **Task 8/13 完了(全て review clean・commit 済)。Task 9 が未 commit・未レビューで作業ツリーに存在**。コンテキスト逼迫のため OT 指示で停止。
- plan: `docs/superpowers/plans/2026-08-18-dash1-home-v1.md`(r2)
- spec(凍結): `docs/superpowers/specs/2026-08-18-dash1-home-v1-design.md`(r2)/ 定義 doc `2026-08-17-dashboard-metric-definitions.md`(r3)
- 実行方式: `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)
- SDD ledger(scratch・**gitignored ゆえ消えうる**): `.superpowers/sdd/2026-08-18-dash1-home-v1/progress.md`

---

## 1. 新セッションでの再開手順

1. **作業ツリーを壊さない**。`git clean -fdx` / `git checkout -- .` 厳禁 — Task 9 の未 commit 変更と SDD scratch が消える。
2. `git log --oneline e1740c3..HEAD` で **feat 8 本 + docs 2 本**を確認。全て**未 push**。
3. `git status` の未 commit 変更は **Task 9(K 設定面)の途中成果**。レビューを一切通していない。§3 の手順で扱う。
4. 以降は §7 の残 task を plan の順で進める。**各 task の進め方は §8 の運用規律に従う**(これが本 sprint で最も価値が出た部分)。

## 2. 完了 task(commit 済・未 push)

| Task | commit | 内容 |
|---|---|---|
| 1 | `73f3927` | migration 0040(`exams.daily_new_target` / `cards.first_reviewed_at` / `answer_events.origin` + summary 用 index)+ 型/mapper 追随 |
| 2 | `af54857` | shared pure domain 層(`lib/dashboard/domain/`)+ eslint 純粋性 block |
| 3 | `ea1baa7` | fold が `first_reviewed_at` を遷移時に 1 回だけ書く(SELECT 列 + VALUES + COALESCE の 3 点) |
| 4 | `42d9514` | origin を wire → ingest 正規化まで貫通(未知値 null 化・batch は 200) |
| 5 | `0af21a2` | 選択中試験 resolver + PullTrigger 初回 pull settle シグナル |
| 6 | `d1806fb` | スマート復習の出題プールを W2 契約へ(選択試験 + state 別条件 + 新規 k 件) |
| 7 | `edec219` | `/app/study/quick` preset route |
| 8 | `ce24591` | `GET /api/stats/summary`(W4 用・sprint 唯一の server 集計) |

## 3. Task 9(未 commit・**未レビュー**)の扱い

実装 agent が走行中に停止したため、**gate 実行・report・commit message・レビューのいずれも未了**。

変更されている file:
- 新規: `app/(app)/app/exams/_actions/update-daily-new-target.ts`(+test)/ `app/(app)/app/exams/[id]/_components/daily-new-target-field.tsx`(+test)/ `lib/exams/daily-new-target.ts`
- 変更: `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx` / **`lib/db/report-rls-context-failure.ts`**

**再開時に必ず確認すること**:
- `lib/db/report-rls-context-failure.ts` の変更は **Task 9 の範囲外に見える**。意図的な追随か scope creep かを判定し、後者なら戻す。
- 実装が半端に適用されていないか(4 gate 実走 = `pnpm test` / `pnpm typecheck` / `pnpm test:iso` / `pnpm lint --max-warnings=0`)。
- **`0` を falsy として扱っていないか**(`||` と `??` の取り違え・form の falsy チェック)。`0` = 「新規を出さない」という有効値であり、`null` = 「既定に追従」。ここを取り違えると設定が静かに無効化される。これが Task 9 最重要の pin。
- 他 owner の試験を更新できないことが、型ではなく **tenant scoping で** 担保されているか。

判断: **やり直すより現物を検証して続ける方が安い**(実装は概ね揃っている)。ただし report と commit message は新規に書かせること。

## 4. レビューが捕まえた実バグ(全て独立レビュー由来・実装者の自己申告ではゼロ)

| # | 検出 | 内容 |
|---|---|---|
| 1 | Codex(T1) | `toClientCard` が `first_reviewed_at` を常時付与し round-trip 契約が破れた。**`pnpm test` が gate に無く**未検出だった |
| 2 | Codex(T5) | `lock-busy` を settle 扱い。他タブが pull 中で mirror が空/stale のまま Home が「試験 0」を確定表示 |
| 3 | canonical(T5) | **その隣の分岐** `inflight-skip` に同型の欠陥。`reactStrictMode: true` ゆえ **dev で Home が毎回 skeleton 固着** |
| 4 | Codex(T6) | `selectionStartedRef` が恒久 ref で bookmark 経路が**空セッション固着** |
| 5 | Codex 再(T6) | `examIds === []`(mirror 未 pull)未 guard。fresh browser の deep link が**有効な server cards を捨て `?exam=` も剥がす** |
| 6 | canonical(T6) | 同一試験で 2 回目の選定が走り**回答中にプールが差し替わる**(`SessionRunner` は cards を snapshot しない) |
| 7 | canonical(T7) | `ten_min` が pool を `due` 再ソートし、New の due(= 作成時刻)が全 review より前に来て**「10分」が復習を 1 件も出さない** |

**それ以外の Important 指摘は全て「証拠が主張を支えない」型**: 消しても通る pin / 恒真の境界式 / 検出器の無い防御層 / 回数を観測しない pin / 値を pin しない host / 未 test の禁止方向 / 同率を区別できない fixture。

## 5. 裁定(Ruling)一覧 — 再開時に有効

| # | 裁定 | 誤りのコスト |
|---|---|---|
| 3 | **T12(dead route 削除)は OT の外部利用確認が未充足のため保留**。他 task は継続 | 後続で commit 1 本 |
| 4 | `selectSessionPool` の返り値を T11 が再計算せず消費する | 署名変更 1 箇所 |
| 5 | worktree を作らず `develop` 上で実装(本 repo の確立運用) | commit の付け替え |
| 6 | **implementer は commit せず unstage で返す**。controller が Codex + canonical → pass 後に `[reviewed]` で commit(`codex exec review --uncommitted` は commit 済みを見ない + CLAUDE.md の「review pass → commit」順序) | commit 1 本の巻き戻し |
| 7 | **全 task の gate に `pnpm test` を追加**(plan の完了条件から欠落していた) | なし |
| 12 | client flush は schema 失敗を terminal にするため、**query 由来 origin は必ず `normalizeOriginValue` を通す** | 実データ損失 |
| 17 | **spec §8.5 の入口棚卸しは誤り**(`app-header.tsx:50-51` に恒久リンクが実在)。contract ではなく事実記述の誤りゆえ **erratum として続行**。header link に `?exam=` を付けるかは **OT 判断事項として残置** | nav クリックごとに RSC 往復 1 回 |
| 20 | T6 の残余(stale `examIds` + `count()` 失敗の複合 race で `?exam=` が落ちる)は**修正せず明文化**して park | 稀な複合障害で deep link が 1 回自己劣化 |
| 21 | `tag` は preset と独立した第 5 の入口(spec §7:109 が母集合を単独定義)。**T11 の W4 ボタンはこの解釈に整合する URL を出す** | W4 導線が別の母集合を出す |
| 22 | **`ten_min` は `selectSessionPool` の順序を保つ**(再ソートしない)。定義 doc W5 が「due 昇順で良いかは Dash-1 で確認」と本 sprint へ明示委譲しており、§8.4 が未出題側は既に解決済 | ten_min の並びが変わるのみ(可視・即戻せる) |

(Ruling 1/2/8/9/10/11/13/14/15/16/18/19 は完了 task 内で消化済み。詳細が要れば scratch ledger 参照。)

## 6. deferred(最終 whole-branch review で triage)

- **T2**: `isCarryoverAt` に production caller が無い → **T11 で消費するか削除する**
- **T3**: ingest 写像層の「値」に detector が無い(TS strict は field の存在しか強制しない)。**データ損失経路は閉じている**
- **T5**: `lib/sync/pull.ts` に AbortSignal/timeout が無い。単一 mount で初回 pull が hang し以後 kick が来ないと Home が skeleton 固着。**本 sprint 導入ではなく既存性質**
- **T6**: `session_limit` cap を JS で選定後に適用(query 側だと未到来 step が席を埋め両経路が乖離)。代償 = Dexie が cap 超の行を materialize。**大きい試験で prod 前に実測**
- **T7**: cold-mirror gate が smart/quick で **verbatim 2 コピー**。rule of three により今は抽出しないが、**Home(T11)が 3 番目の消費者**になるのでそこで抽出する(3 コピー目を作らない)
- **既知 flake**: `card-image-gallery.test.tsx` の ResizeObserver 系。本 sprint と table/module の重複ゼロと独立確認済

## 7. 残 task(9〜13)

9 K 設定面(**進行中**・§3)/ 10 design tokens + widget-card / 11 Home 刷新 / 12 dead route 削除(**Ruling 3 で保留**)/ 13 完了 gate + smoke 手順 session doc 化。

**T10 への申し送り**: `frontend-design` skill を起動して値を決める。追加色の実コントラスト比を算出して記録(AA 4.5:1)。
**T11 への必須申し送り**:
- Ruling 4(`selectSessionPool` の返り値を再計算しない)
- Ruling 21(W4 の URL は tag 独立解釈に整合させる)
- §9.2-3(summary の echo は optional・**描画は echo 2 本の一致を条件**・race 経路は 400 でなく 200)
- T2 deferred(`isCarryoverAt` の消費または削除)
- T7 deferred(cold-mirror gate をここで抽出)

## 8. 運用規律(本 sprint で効果が実証されたもの — 再開時も維持する)

- **Codex → canonical の直列実行**(並列は canonical の変異注入が Codex の clean detector に偽陽性を出す)。**両方通すまで commit しない**。fix 後は **Codex を再実行**して収束を確認する(CLAUDE.md の収束条件は保存 md で判定)。
- **red 検証は 1 変異ずつ**。まとめて壊して 1 つ落ちても他が pin されている証明にならない。逆に「単独変異で落ちない」= 防御が冗長で検出器が無い、という発見にもなる(T3 の COALESCE / T5 の timer 追跡)。
- **pin は「あること」でなく「効くこと」**。reviewer には毎回「その規則を消したらこの test は落ちるか」を判定させる。本 sprint の Important の大半がここで出た。
- **受容した限界も書く**。code コメント + 恒久 doc の両方に。書かないと後から bug として再発見される。
- **subagent の中断(API 障害)は 4 回発生**。いずれも controller が現物を実測して再開すれば継続できた。再開指示には必ず「記憶上の最後の編集がディスクに乗っている保証はないので自分の変更を読み直せ」を入れる。
- **`.superpowers/` は gitignored scratch**。消えて困る事実は本 doc へ移す(§9 がその実例)。

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
