# Dash-1 Home v1 実装 — 引継ぎ記録(最終更新 2026-08-19)

- 状態: **Task 9/13 完了(全て review clean・commit 済・未 push)**。次は Task 10。
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

## 3. Task 9(**完了** — commit `8ef12d3`)

実装 agent の成果を controller が引き取り、4 gate 実走 → Codex → canonical → fix → commit まで完了。以下は当時の記録(実装 agent の成果物の性質)+ §10 に review で出た事実を追記。

### 3.0 当時の扱い(履歴)

実装 agent は**完走した**(停止指示の後に報告が到着)。実装・test・4 gate は完了、**レビュー(Codex / canonical)と commit のみ未了**。

変更 file:
- 新規: `lib/exams/daily-new-target.ts` / `app/(app)/app/exams/_actions/update-daily-new-target.ts`(+test)/ `app/(app)/app/exams/[id]/_components/daily-new-target-field.tsx`(+test)
- 変更: `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx` / `lib/db/report-rls-context-failure.ts`

**停止時に「要検証」としていた 2 点は controller が実測して解決済**:
1. `lib/db/report-rls-context-failure.ts` の変更は **scope creep ではない**。差分は `RlsAlertRoute` union への `'update-daily-new-target'` **1 行追加のみ**で、既存の `rename-exam` / `delete-exam` と同じ登録。`reportRlsContextFailure` は action の `:71` で**実際に呼ばれている**(停止時の diagnostics「未使用」は red 検証 A6 の変異中に採取された stale)。
2. UI の置き場が brief の「試験一覧の行メニュー(rename の隣)」と違うのは **brief 側が現物と食い違っていた**ため。rename は行メニューではなく試験詳細ページのタイトル(`exam-title-inline-edit.tsx`)にしか存在せず、実装者は新しい一覧 UI を発明せず詳細ページに置いた。**判断として妥当**だが、意図した配置かは OT 確認の余地あり。

自己申告の gate/red: `pnpm test` 5640 / `test:iso` 489 / typecheck 0 / lint 0。red 検証 10 件(A1 認証 guard / A2 owner-scope WHERE / A3 保存時の `|| null` で 0 が null 化 / A4 上限 off-by-one / A5 整数チェック / A6 RLS alert / U1 初期表示の `||` / U2 保存 parse の `||` / U3 失敗の握り潰し / U4 既定値表示)。**`0` を falsy 扱いしない pin が A3・U1・U2 の 3 経路で立っている**のは要件どおり。

**再開時の手順**: 現物を信用せず 4 gate を実走 → Codex → canonical → fix ループ → commit。report は `.superpowers/sdd/2026-08-18-dash1-home-v1/task-9-report.md`(scratch)。**commit message は未作成なので新規に書かせること**。

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

9 K 設定面(**完了** `8ef12d3`・§3 / §10)/ 10 design tokens + widget-card / 11 Home 刷新 / 12 dead route 削除(**Ruling 3 で保留**)/ 13 完了 gate + smoke 手順 session doc 化。

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

---

## 10. Task 9 — K 設定面の恒久記録(commit `8ef12d3`)

### 10.1 **migration 0040 は stg DB に未適用**(2026-08-19 実測・push 計画に直接効く)

`.env.local` の `DATABASE_URL_APP`(= stg)へ local dev を向けると `/api/pull` が **500** で落ちる:

```
Failed query: select ..., "first_reviewed_at", ... from "cards" where "cards"."user_id" = $1
```

→ **Dash-1 の UI smoke(Task 9/10/11)は stg では 0040 適用まで構造的に実行できない**。memory の「stg は 0036〜0039 適用済」は正しく、0040 は Task 1 で新規作成した分ゆえ未適用。
**push 順序への含意**: push → stg deploy しても 0040 未適用なら Dash-1 画面は動かない。**0040 の適用(OT)を stg smoke の前提として Task 13 の手順に含めること**。

### 10.2 local PG による full-stack smoke(stg が使えない間の代替・再現手順)

devcontainer 常駐 PG17(test:iso の乗り物)に別 DB を立てれば CC 単独で実機相当の smoke ができる。**`recallmint_test` は globalSetup が drop/create するので使わない**(別名にする)。

```bash
export PGPASSWORD=postgres
psql -h 127.0.0.1 -U postgres -d postgres -c "CREATE DATABASE recallmint_devlocal;"
DATABASE_URL_ADMIN="postgresql://postgres:postgres@127.0.0.1:5432/recallmint_devlocal" npx drizzle-kit migrate
# users 行は Clerk webhook 同期ゆえ local には来ない → 手で入れる。
# clerk_id は stg から読める: psql "$DATABASE_URL_APP" -c "SET app.user_id='<内部 id>'; SELECT clerk_id FROM users WHERE id='<内部 id>';"
#   テスト A: 内部 id 66fb6d00-526f-4264-9691-e2e036c656f7 / clerk_id user_3HtMzBoNw6HNGXKg5LJ2p5TjtXx
# 起動は env 差し替えのみ(role は postgres = superuser ゆえ RLS を bypass する点に注意)
DATABASE_URL_APP="postgresql://postgres:postgres@127.0.0.1:5432/recallmint_devlocal" \
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/recallmint_devlocal" pnpm dev
```

sign-in は Clerk **dev instance**(`recall-mint-dev`)で stg と同じアカウントが使える(`komail9server+clerk_test@gmail.com` / `komail8server` / 2FA OTP `424242`)。
**限界**: 接続 role が superuser なので **RLS policy の検証にはならない**(policy 検証は `pnpm test:iso` 側)。あくまで UI / 経路 / mobile view 用。

### 10.3 mobile view 実測(375px・spec の完了条件)

| 項目 | 実測 |
|---|---|
| 設定行のレイアウト | 1 行(343×38px)。wrap なし・`documentElement.scrollWidth` 375 = viewport(横スクロールなし) |
| 初期表示 | mirror の `daily_new_target = 35` を表示 |
| `0` 保存 | DB に **0**(`IS NULL` = false)/ 表示は "0" のまま(**巻き戻らない**)/ `role=status` に「保存しました」 |
| 空欄保存 | DB **null** / 入力は空欄 + placeholder 20 |
| 他 owner の試験 URL | **404**(RSC guard) |

### 10.4 レビューが捕まえた実バグ(§4 の続き)

| # | 検出 | 内容 |
|---|---|---|
| 8 | Codex(T9) | mirror 追従 state が「表示中の確定値」と「最後に観測した mirror 値」を兼用 → **保存成功直後に保存値が旧 mirror 値へ巻き戻る**。`ExamDetailPullGate` が本ページ滞在中の ambient pull を抑止するため、これは稀ケースではない |

**pin の教訓(§8 に追加すべき実例)**: 「上書きしない」のような**不在の主張は、そもそも変更が届いたことを観測しないと pin にならない**。初版の dirty guard test は `waitFor` が即時解決して伝播前に通っており、変異(guard 削除)で red にならなかった。**未編集の 2 個目を同時 render して伝播の検出器に使う**形で解決。

### 10.5 記録のみ(canonical Minor・修正しない)

- **M-4**: `<label>新規/日</label>` と `aria-label="新規/日の上限"` が競合し label が装飾化(WCAG 2.5.3 は通る)。修正すると test 14 箇所の query を書き換えるため見送り。
- **M-5**: 初期表示 pin 群と mirror 追従 pin 群は**同じ render guard 分岐**を通る(独立な証拠ではない)。「8 本 pin がある」と数えないこと。
- **M-7**: `withTenantTx` を passthrough mock しているため「tenant tx 内で走ること」は pin されていない(`rename-exam.test.ts` と同じ既知の穴)。runtime は RLS で backstop。
- **M-8**: 二重送信 guard が ref でなく state(`disabled={pending}`)。rename と違い結果が冪等なので実害なし。

### 10.6 検証しなかったこと(明示)

- **RLS policy 経路**(§10.2 の限界)。tenant context を張らない接続での挙動は iso 側の担保に依存。
- **stg 上での動作**(§10.1 により 0040 適用まで不可)。
