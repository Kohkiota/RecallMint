# RLS-P2 stg 反映 Runbook

RLS-P2(closure 5 表 {users, exams, cards, tombstones, study_days} への RLS 有効化)を stg
に反映し、「動く・漏れない・遅くならない」を実機で実証するための実行手順。**正本 spec**:
`docs/superpowers/specs/2026-07-20-rls-p2-representative-closure-design.md`(以下「spec」、§
参照は全てこの doc)。**plan**: `docs/superpowers/plans/2026-07-20-rls-p2-representative-closure.md`
Task 11。**対象 commit range**: `a546be6`(Task1)`..e216600`(Task10)、全 `[reviewed]`。

**sprint 完了の定義 = 本 runbook の実証(§4-§6)合格まで**(spec §4)。code 完了 + test:iso
green(Task 12 gate)は中間 checkpoint であり、本 runbook の実走完了で初めて sprint を close する。

**実行タイミング**: 標準フロー(CLAUDE.md「task 完了後の標準フロー」)に従い、Task 12 の
checkpoint 報告後、OT が push した時点から本 runbook を開始する(push 前に stg を叩かない)。

## 0. 前提確認(反映着手前・OT)

| # | 何を | どう | 期待結果 | NG 時 |
|---|---|---|---|---|
| 0.1 | RLS-P1(app role 分離)が稼働中であること | Supabase SQL Editor(owner)で `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname='recallmint_app';` | 1 行、`rolbypassrls=f` | 0 行 → RLS-P1 未反映。本 runbook は前提が崩れるため中断し RLS-P1 session doc(`docs/superpowers/sessions/2026-07-18-rls-p1-app-role-separation-implementation.md`)を確認 |
| 0.2 | Vercel(stg scope)に `DATABASE_URL_APP` / `DATABASE_URL_ADMIN` が設定済であること | Vercel dashboard → Project → Settings → Environment Variables → Preview scope を目視 | 両方存在(値は非公開でよい、存在確認のみ) | 欠落 → RLS-P1 の env 手順(同 session doc)に立ち戻る。0025 は関数 DDL のため `DATABASE_URL_ADMIN` 必須 |
| 0.3 | 0025 functions が stg に未適用であること | SQL Editor(owner)で `SELECT proname FROM pg_proc WHERE proname IN ('app_current_user_id','app_bootstrap_user_from_clerk','app_resolve_user_for_stripe','app_scrub_deleted_user');` | 0 行(未適用) | 既に 4 行 = 適用済 → §1 Step 1 は re-run 相当(`CREATE OR REPLACE FUNCTION` は冪等)。実害なし、そのまま Step 2 へ進めてよい |
| 0.4 | policy が stg に未適用であること | SQL Editor(owner)で `SELECT tablename, policyname FROM pg_policies WHERE schemaname='public';` | 0 行 | 既に行がある → 過去の途中適用の可能性。§1 Step 3 の確認 SQL(§2)で全 7 policy 揃っているか確認し、欠けていれば `rls-p2-enable.sql` を再適用(冪等 DROP IF EXISTS 付なので安全) |
| 0.5 | `[PERF-SEED] 300-card exam` が test1(`komail9server+clerk_test@gmail.com`)に存在すること(after 計測の同条件維持) | stg にログインし `/app/exams` で exam 名 `[PERF-SEED]...` の有無を確認、または SQL Editor で `SELECT id, name FROM exams WHERE name LIKE '[PERF-SEED]%';` | 300 件規模の exam が 1 件存在 | 消失(過去 re-seed で流出した実績あり — `docs/superpowers/sessions/2026-07-17-sprint-t-md-table-readonly-completion.md`)→ OT が `docs/audit/2026-07-16-seed-perf-exam-reseed-procedure.md` の確定手順で再投入(`DATABASE_URL_ADMIN` inline・`--user-id=<test1 内部 uuid>` 必須) |

## 1. 適用順序(厳守・逆順禁止)

**順序 = ① 0025 functions migrate → ② push・stg deploy → ③ enable SQL(RLS on)。**
理由: 0025 の関数は旧コードから未参照のため先行適用は無害(additive、RLS 状態を持たない)。
新コードは 0025 の関数(`withTenantTx`/`setTenantContext` 経由の `app_current_user_id()` 呼出)
を前提に書かれているが、**RLS がまだ off の間は policy 自体が存在しない**ため実害なく走る。
**もし逆順(policy 先行)にすると**、まだ deploy されていない旧コードが RLS 有効化後の
5 表に触れた瞬間、`app_current_user_id()` の呼出元である policy 式が評価されるが、旧コードは
`set_config('app.user_id', …)` を張らないため GUC 未設定 = `app_current_user_id()` が
loud に `RAISE EXCEPTION … USING ERRCODE = 'P0RLS'` する。5 表に触れる全リクエストが
即 500 で壊れる(spec §2.9)。

### 1.1 Step 1 — 0025 functions 適用(OT・ADMIN inline)

| 項目 | 内容 |
|---|---|
| 何を | `drizzle/migrations/0025_rls_p2_functions.sql`(loud 関数 `app_current_user_id` + SECURITY DEFINER 3 本 `app_bootstrap_user_from_clerk`/`app_resolve_user_for_stripe`/`app_scrub_deleted_user` + EXECUTE grants)を適用 |
| どう | `DATABASE_URL_ADMIN='<stg owner 接続文字列>' pnpm db:migrate`(`drizzle.config.ts` が `DATABASE_URL_ADMIN` を読む。inline 供給は `.env.local` の値を上書きする — dotenv は既存 `process.env` を上書きしないため、shell 側で先に代入した inline 値が勝つ) |
| 期待結果 | `drizzle-kit migrate` が `0025_rls_p2_functions` を適用して exit 0。前提 0.3 の SQL で 4 関数が 4 行返るようになる |
| NG 時 | permission denied → `DATABASE_URL_ADMIN` が owner(postgres)でない可能性、接続先を再確認。接続不可 → stg Supabase の稼働状況を確認。**RLS 状態は変わらない操作のため、失敗しても既存機能に影響なし**(rollback 不要、原因解消後に再実行するだけ) |

### 1.2 Step 2 — push + stg deploy(OT)

| 項目 | 内容 |
|---|---|
| 何を | `develop` を push して Vercel Preview(`stg.recallmint.nekotest.net`)に新コードを反映 |
| どう | `git push origin develop`(通常の push。事前に `git status` / `git log origin/develop..develop` で対象 commit を確認) |
| 期待結果 | Vercel dashboard で該当 deployment が `Ready` になる。**この時点では RLS はまだ off**(Step 3 未実施)なので挙動は反映前と不変 — 通常の deploy 後 smoke で十分(本 runbook の CC smoke は Step 3 後にやり直す) |
| NG 時 | build 失敗 → Vercel build log を確認(Task 12 gate で lint/typecheck/build/test 済のはずなので通常は通る)。失敗時は原因を fix して再 push、RLS 適用(Step 3)には進まない |

### 1.3 Step 3 — policy 適用(OT・Supabase SQL Editor)= RLS on

| 項目 | 内容 |
|---|---|
| 何を | `db/policies/rls-p2-enable.sql` を owner(postgres)権限で適用。5 表に `ENABLE ROW LEVEL SECURITY` + policy 7 本を作成 |
| どう | Supabase SQL Editor を開き、`db/policies/rls-p2-enable.sql` の全文をそのまま貼り付けて実行(ファイルが正本 — 下記は 2026-07-20 時点の内容の参考コピー) |
| 期待結果 | エラーなく完了。§2 の確認 SQL で 7 policy + 5 表 `relrowsecurity=t` |
| NG 時 | `lock_timeout`(5s)超過エラー(`55P03`)→ 対象表に長時間 lock を握っている query がないか確認し再実行(ファイルは冪等 `DROP POLICY IF EXISTS` 付なので再実行安全)。途中でエラーが出た場合、postgres-js/SQL Editor は 1 文ずつ独立実行のため**途中まで反映された状態であり得る**→ §2 の確認 SQL で実際の状態を確認してから再実行するかを判断 |

参考コピー(正本は `db/policies/rls-p2-enable.sql`。実行直前に file を再確認すること):

```sql
SET lock_timeout = '5s';

ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exams_tenant ON exams;
CREATE POLICY exams_tenant ON exams FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cards_tenant ON cards;
CREATE POLICY cards_tenant ON cards FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

ALTER TABLE tombstones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tombstones_tenant ON tombstones;
CREATE POLICY tombstones_tenant ON tombstones FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

ALTER TABLE study_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS study_days_tenant ON study_days;
CREATE POLICY study_days_tenant ON study_days FOR ALL TO recallmint_app
  USING (user_id = (SELECT public.app_current_user_id()))
  WITH CHECK (user_id = (SELECT public.app_current_user_id()));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_select ON users;
CREATE POLICY users_select ON users FOR SELECT TO recallmint_app
  USING (id = (SELECT public.app_current_user_id()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS users_insert ON users;
CREATE POLICY users_insert ON users FOR INSERT TO recallmint_app
  WITH CHECK (id = (SELECT public.app_current_user_id()));
DROP POLICY IF EXISTS users_update ON users;
CREATE POLICY users_update ON users FOR UPDATE TO recallmint_app
  USING (id = (SELECT public.app_current_user_id()) AND deleted_at IS NULL)
  WITH CHECK (id = (SELECT public.app_current_user_id()));
```

## 2. 適用後確認 SQL(Step 3 直後・OT)

| # | 何を | どう(SQL) | 期待結果 |
|---|---|---|---|
| 2.1 | 7 policy の存在 | `SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' ORDER BY 1,2;` | 7 行: `cards / cards_tenant`・`exams / exams_tenant`・`study_days / study_days_tenant`・`tombstones / tombstones_tenant`・`users / users_insert`・`users / users_select`・`users / users_update` |
| 2.2 | 5 表の RLS 有効化 | `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('users','exams','cards','tombstones','study_days');` | 5 行、全て `relrowsecurity = t` |

どちらか欠けていたら Step 3 が不完全 — `rls-p2-enable.sql` を再実行(冪等)。

## 3. Rollback

### 3.1 即時 rollback(incident 時・いつでも実行可)

| 項目 | 内容 |
|---|---|
| 何を | `db/policies/rls-p2-disable.sql` で 5 表の RLS を DISABLE(policy 定義は残置) |
| どう | SQL Editor(owner)で file 全文を実行 |
| 期待結果 | §2.2 の確認 SQL で 5 表とも `relrowsecurity = f` に変わる。**旧來動作(RLS なし)に即時復帰**、policy 定義自体は残るため再 ENABLE すれば同じ policy が即復活 |
| NG 時 | `lock_timeout` 超過 → enable.sql と同様、対象表の lock 保持 query を確認し再実行 |

### 3.2 Rollback 演習(Step 3 の直後・「戻せること」を実証してから smoke に進む)

spec §4 の明示要求: 反映直後に一度 disable→re-enable を回し、rollback が実際に機能することを
事前実証してから本格 smoke・計測に入る。

| # | 何を | どう | 期待結果 | NG 時 |
|---|---|---|---|---|
| 1 | disable | §3.1 の `rls-p2-disable.sql` を実行 | §2.2 で全表 `relrowsecurity=f` | 上記 NG 時と同じ |
| 2 | 簡易 smoke(RLS off 状態で通常機能が壊れていないこと) | stg にログインし dashboard 表示 + exam 1 件開閉を目視(CC or OT どちらでも可、非破壊) | 通常どおり表示される | 壊れていれば RLS 以外の要因(直近 deploy の別問題)を疑う — 本 runbook のスコープ外の障害として調査に切替 |
| 3 | 再 enable | `rls-p2-enable.sql` を再実行 | エラーなく完了(`DROP POLICY IF EXISTS` があるため `CREATE POLICY` の `42710` 重複衝突が起きない = 冪等性の実証そのもの) | `42710` が出た場合は enable.sql の DROP 文が抜けている退行 — file を確認 |
| 4 | 復元確認 | §2.1 + §2.2 の確認 SQL | 7 policy + 5 表 `relrowsecurity=t` に復元 | 一部欠落 → 個別 `CREATE POLICY` 文を手動再実行 |

演習完了後、本番の RLS on 状態(§4 以降の smoke・計測)に進む。

## 4. CC smoke(DevTools MCP・Playwright MCP・非破壊)

Step 3(+ §3.2 演習)完了後、RLS が実際に on の状態で実施する(off の間は `P0RLS` が
そもそも発火しないため、この smoke は enable 後でなければ意味を持たない)。

| # | 何を | どう | 期待結果 | NG 時 |
|---|---|---|---|---|
| 4.1 | 通常操作一巡 | test1(`komail9server+clerk_test@gmail.com`、OTP `424242`)でログイン → upload(小さい画像 1 枚)→ OCR 完了待ち → カード編集(タグ付け等)→ 復習セッション 1 往復 → 作成した exam を削除、を Playwright MCP で実行 | 各操作が通常どおり完了(200 系レスポンス・UI 上エラーなし) | 500 / OCR 失敗 / 保存失敗などが出たら該当 request の response body を確認(§4.3)、`P0RLS` を含むか要確認 |
| 4.2 | Network / console 観測 | 一巡の間 `browser_network_requests` で全 request の status を確認、`browser_console_messages` で JS error 有無を確認 | 5xx が 0 件、console error 0 件 | 5xx あり → §4.3 で response body を掘る |
| 4.3 | エラー時の掘り下げ(client 側から観測できる範囲) | 5xx が出た request を `browser_network_request`(`part: 'response-body'`)で確認 | production の Next.js は詳細 stack を client に返さない設計のため、client 側では「5xx が出たか」までしか判別できない場合がある | **`P0RLS` の SQLSTATE 文字列そのものは server 側 stack にしか出ない** — client 側で 5xx を確認できたら、その正確な原因確認(stack 中に `P0RLS` があるか)は OT が Vercel Runtime Logs(Vercel dashboard → Project → Logs)で該当 request 時刻を確認する。CC 単独では検証しきれない部分として役割分担する(§7) |
| 4.4 | `current_user` 確認 | app role が実際に `recallmint_app` で動いていることの確認は DB 接続(psql / SQL Editor)を要するため CC の browser 経路では実行不可 — OT が app 用接続文字列(`DATABASE_URL_APP`)で `SELECT current_user;` を実行(RLS-P1 と同一手順) | `current_user = 'recallmint_app'` | owner 接続になっていたら env 設定の退行 — RLS-P1 session doc の手順に立ち戻る |

**証拠**: 4.1-4.2 の Network reqid 一覧 / console 出力 / 主要画面の snapshot を report に添付。

## 5. After 性能計測(CC・Perf-0b 同条件)

**方法**(Perf-0b と同一・`docs/audit/2026-07-18-rls-performance-before-factfinding.md` §3.2-3.4):
Playwright MCP browser の page-context `fetch(url, { credentials: 'include', cache: 'no-store' })`
を `performance.now()` で計測(request → full body 読了)。各経路: **warmup 5 回捨て → 30 回計測**、
`p50`/`p95` は **nearest-rank**(昇順 30 件で p50 = 15 番目、p95 = 29 番目、1-indexed)。認証は
test1(`+clerk_test`)、seed は前提 0.5 の `[PERF-SEED] 300-card exam` を使い回す(before と同一
データ量であることが比較の前提)。

> **⚠️ before は「flip 直前に同日再取得」してから after を取る**(2026-07-20 Phase B 実証の教訓)。
> Perf-0b の before(2026-07-18)を数日跨いで after と比較すると、network floor(実測で RTT
> favicon 3→16ms)/ Vercel instance 状態 / server 負荷の **baseline drift** がコード変更・RLS の
> 増分に上乗せされ、判定が汚染される。実際 Phase B では **pull delta(DB 仕事ほぼ皆無)が +77ms
> 増**という「直列化でも RLS でも説明不能」な shift が観測され、drift とコード変更を分離できな
> かった。**手順**: enable SQL 適用の**直前**に、その時点の deploy(= 新コード・RLS off)で全経路
> の before を 30 回計測 → enable → 直後に after を 30 回計測。これで network/instance を共通化
> し、**同一 delta 経路の増分を drift の proxy** として差し引ける(after − before の経路固有増分
> のみを予算と突合)。旧並列 pull コードの before(181 等)は un-deploy 後は再取得不能ゆえ、この
> 「直前 before」が唯一の clean baseline。Phase 3 全表展開でも同手順を必須とする。

### 5.1 合格基準(spec §3.2)

各経路 **p95 悪化 ≤ max(before_p95 の 10%, 20ms)**。ただし **`/api/pull` full のみ特例**で
p50・p95 とも **+40ms 予算**(6-way 並列 → 1-tx 直列化による絶対増分を許容する経路のため)。

| 経路 | before p50 | before p95 | 判定基準(p95) | 判定基準(p50, pull full のみ) |
|---|---|---|---|---|
| dashboard `/app` | 91 | 114 | ≤ 134ms | — |
| exams 一覧 `/app/exams` | 91 | 162 | ≤ 182ms | — |
| exam 詳細(300件)`/app/exams/{id}` | 131 | 204 | ≤ 224ms | — |
| `/app/upload` | 94 | 138 | ≤ 158ms | — |
| `GET /api/pull` full | 181 | 226 | ≤ 266ms(特例 +40ms) | ≤ 221ms(特例 +40ms) |
| `GET /api/pull` delta(0行)| 77 | 85 | ≤ 105ms | — |

超過した経路があれば、その場で fix せず「高度化 task」として起票し OT 判断を仰ぐ(spec §3.2
の after 条項。チャンク分割等の高度化は今回スコープ外の YAGNI)。

### 5.2 記録项目

各経路: p50 / p95 / mean / min / max / resp bytes(Perf-0b と同一形式)を表にまとめ、before
との差分(ms・%)を併記。

## 6. Pooler 実機検証(§3.3)

### 6.1 2nd Clerk test user

| 項目 | 内容 |
|---|---|
| 何を | test1 とは別の内部 DB user を用意する(隔離検証には最低 2 tenant が要る) |
| どう | Clerk test-mode 規約(`+clerk_test` を含むメールは固定 OTP `424242`)に沿った新規メールで通常のサインアップ UI を実行。例: `komail9server.rls2+clerk_test@gmail.com`(既存 test1 とは別の local-part、同じ `+clerk_test` suffix)。**注意**: Clerk の test-mode 判定 regex が `+clerk_test@` 終端のみを厳密に見る設定の場合、この alias が弾かれる可能性がある — その場合は OT が Clerk dashboard の test-mode 設定を確認し、確実に通る alias に差し替える |
| 実行者 | CC(サインアップは非破壊・課金なし)。Clerk dashboard 側の確認が必要になった場合のみ OT |
| 期待結果 | 新規 users 行が 1 件作成される(内部 DB uuid を SQL Editor `SELECT id, email FROM users WHERE email LIKE '%rls2%';` 等で確認し、以降 test2 として記録) |

### 6.2 交互 pull ×30(残留検査)

| 項目 | 内容 |
|---|---|
| 何を | 同一 browser で test1 → test2 → test1 → … と交互にログインし直し、都度 `/api/pull`(full)を叩いて 30 回分の応答を集める。pooler 接続の再利用時に前 tenant の GUC(`app.user_id`)が残留していないかを検査 |
| どう | Playwright MCP で ログイン→`fetch('/api/pull', {credentials:'include'})`→ 結果保存 → ログアウト→次の user でログイン、を 30 iteration 繰り返す。各回のレスポンス JSON の `cards[].user_id` / `exams[].user_id` / `tombstones[].user_id` 等を全て検査 |
| 期待結果 | test1 の回はすべての行が test1 の内部 uuid、test2 の回はすべて test2 の uuid(1 件でも他 tenant の uuid が混入したら RLS/pooler 分離失敗) |
| NG 時 | 即座に Critical 案件として OT へ報告(コード上の tenant 分離の失敗を意味する)。原因調査は本 runbook のスコープを超え、systematic-debugging へ切替 |
| 実行者 | CC(非破壊 read のみ。ログイン/ログアウトの繰り返しは UI 操作で完結、課金なし) |

### 6.3 並行同時 ×N(接続再利用・競合純度検査)

| 項目 | 内容 |
|---|---|
| 何を | test1 と test2 を**同時刻**に並行して `/api/pull` を叩き、pooler が同一物理接続を tenant 間で使い回す際に GUC 混線が起きないかを検査 |
| **CC 環境制約** | Playwright MCP の `browser_tabs`(new/select)は同一 browser context 内でタブを増やすのみで cookie jar/session を共有する — 1 つの CC 制御下 browser instance では test1 と test2 に**同時に**ログインした状態を作れない(タブを増やしても Clerk session は 1 つしか保持できない)。したがって真の同時並行実行は CC 単独では実施不可 |
| どう(OT 実行) | OT が 2 つの独立した browser プロファイル(通常ウィンドウ + シークレットウィンドウ、または 2 台の端末)でそれぞれ test1 / test2 にログインし、双方から手動 or 簡易スクリプトで `/api/pull` を同時に連打(目安 N=10 程度・数秒間隔なしで連続実行) |
| 期待結果 | 6.2 と同じ purity 基準(応答行の `user_id` が要求元 tenant のものと完全一致) |
| NG 時 | Critical。OT が気づいた時点で immediate 停止し CC に報告、systematic-debugging へ |
| 実行者 | **OT**(role split §7 の「CC 環境で届かない条件」に該当するため委譲) |

### 6.4 Pool 指標(OT・Supabase dashboard)

| 何を | どう | 記録項目 |
|---|---|---|
| pool 利用状況(Perf-0 §7 の未取得項目と統合) | Supabase dashboard → Database → Connection Pooling / Reports | pool utilization、connection wait、6.2-6.3 実行中の同時接続 peak |

## 7. 役割分担まとめ

| 作業 | 担当 | 備考 |
|---|---|---|
| 0025 migrate(ADMIN inline) | OT | DDL・owner 権限必須 |
| push + deploy | OT | 通常の git push |
| policy 適用・確認 SQL・rollback(即時/演習) | OT | Supabase SQL Editor、owner 権限必須 |
| CC smoke(通常操作一巡・network/console 観測) | CC | Playwright MCP、非破壊 |
| `current_user` 確認・Vercel Runtime Logs の `P0RLS` 有無確認 | OT | DB 直接接続・server log アクセスが必要で CC の browser 経路では届かない |
| after 性能計測(§5) | CC | Playwright MCP、read のみ |
| 2nd test user 作成 | CC(必要なら Clerk dashboard 確認のみ OT) | サインアップ UI、非破壊・課金なし |
| 交互 pull ×30(§6.2) | CC | 同一 browser 内で逐次ログイン切替、非破壊 |
| 並行同時 ×N(§6.3) | OT | 複数 browser プロファイル/端末が必要、CC の単一 browser instance では同時多 tenant セッションを構成不可 |
| pool 指標記録(§6.4) | OT | Supabase dashboard |
| PERF-SEED 再投入(前提 0.5 の NG 時) | OT | `DATABASE_URL_ADMIN` inline・破壊的操作(削除含む)のため |

## 8. prod 方針

**Phase 2 は prod に反映しない**(stg 限定・短期間、spec §0.4-5)。policy は versioned SQL(
`db/policies/`)であり drizzle migration に含まれないため、通常の migrate 経路から prod へ
混入することはない(spec §2.9)。

**ただし**、Phase 2 期間中に通常の prod deploy(develop → main へのリリース)が走る場合は
注意が必要: 新コードは 0025 の関数(`app_current_user_id` 等)呼出を前提に書かれているため、
**0025 が未適用の prod にこの新コードを出すと動作しない**(関数不在で例外)。0025 自体は
RLS 状態を持たない additive migration で prod 適用しても安全(spec §2.9)。→ **Phase 2 期間中に
prod deploy する場合は、0025 の prod 適用とセットで OT が判断する**(policy は出さない・
functions のみ prod にも適用)。

## 9. 完了判定

以下すべて揃って本 runbook 完了(= RLS-P2 sprint 完了、spec §4 準拠):

- [ ] §1-§2: 0025 migrate → deploy → policy 適用が順序どおり完了、確認 SQL で 7 policy + 5 表
      `relrowsecurity=t`
- [ ] §3.2: rollback 演習(disable→簡易 smoke→re-enable)が成功し、確認 SQL で復元確認
- [ ] §4: CC smoke で 5xx 0 件・console error 0 件、OT が Vercel Runtime Logs で `P0RLS` 出現
      なしを確認、`current_user='recallmint_app'` 確認
- [ ] §5: 6 経路すべて合格基準内(超過があれば高度化 task 起票 + OT 判断済み)
- [ ] §6: 交互 pull ×30 + 並行同時 ×N とも purity 突合 OK、pool 指標記録済み
- [ ] 上記結果を session doc にまとめ、OT へ最終報告

未解決 Critical(tenant 分離失敗等)が 1 件でもあれば completion 宣言せず、systematic-debugging
へ切り替えて原因究明を優先する。

## 10. RLS-P3 Wave 1 追記(stg 適用・8 表追加・stg 限定)

> **追随(2026-08-11「FSRS 整合 Sprint A」)**: `reviews` は表ごと DROP され、**Wave 1 は 8 表 → 7 表**(`db/policies/rls-p3-wave1-{enable,disable}.sql` は更新済)。以下の「8 表 / 8 policy」は当時の記述。加えて `answer_events` は同 sprint で **DROP/CREATE** されたため、migration 適用後は **policy と grant が同時に落ちる** — 適用手順は `docs/ops/fsrs-sprint-a-stg-migration-runbook.md` が正。

RLS-P3 Wave 1 は配線ゼロ 8 表(`reviews`/`answer_events`/`tag_categories`/`tag_options`/`card_tags`/`entity_mutations`/`card_asset_refs`/`ai_usage_users`)を **P2 と同一の共通形 policy** で RLS 化する。stg 適用は本 runbook §1 Step 3 と**同機構**(Supabase SQL Editor・owner・冪等 `DROP POLICY IF EXISTS` 付)。

- **前提**: 0025 functions は P2 で適用済(Wave 1 は**新 function なし**・policy SQL のみ)。よって Step 1(functions)は不要、push→deploy 後に policy を適用するだけ。
- **適用**: `db/policies/rls-p3-wave1-enable.sql` の全文を SQL Editor(owner)で実行(正本は file・実行直前に再確認)。
- **確認 SQL**: `SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' AND policyname LIKE '%_tenant' AND tablename IN ('reviews','answer_events','tag_categories','tag_options','card_tags','entity_mutations','card_asset_refs','ai_usage_users');` で 8 policy、`SELECT relname FROM pg_class WHERE relrowsecurity AND relname IN (...上記 8 表...);` で 8 表 `relrowsecurity=t`。
- **rollback**: `db/policies/rls-p3-wave1-disable.sql`(P2 disable と**完全対称 = RLS 無効化のみ・`DROP POLICY` を含まない**)。**disable 後の確認 SQL 期待値 = policy 8 行 / relrowsecurity 0 行**(policy はカタログに残置するが RLS 無効時は不活性 = 挙動 RLS 前と同一。**8 行/0 行 は正常であって適用漏れではない** — 2026-07-21 演習で確認)。re-enable は enable.sql が冪等(既存 policy 上でエラーなく通過)→ 8 行/8 行に復帰。演習手順は §3.2 と同型。
- **smoke(CC・push 後)**: pull 全 6 stream / review-events/bulk / entity-mutations/bulk が RLS on で従来どおり通ること、`P0RLS`/`42501`/5xx が 0 件、`current_user='recallmint_app'`(§4 と同要領)。
- **after 計測(perf)**: **Wave 1 単体では取らない**。prod 有効化直前に同日 before とセットで取る(Wave 1〜2 の policy が出揃ってから・drift 分離のため)。
- **prod 方針**: Wave 1 も **prod に出さない**(§8 と同じ・部分 RLS を prod に出さない = Phase 3 全表完了後にまとめて反映)。

## 11. RLS-P3 hardening 追記(非 RLS 5 表の grant 縮小・stg 適用)

RLS-P3 最終 hardening wave (Task 5) は **RLS 非対象 5 表**(`ai_usage` / `stripe_events` / `clerk_events` / `contact_messages` / `integration_failures`)の app-role grant を「実経路が使うコマンドだけ」へ縮小する。これらは tenant RLS を張らないため **command-level GRANT が唯一の防壁**。policy 適用(§1〜§2 / §10)とは**独立**(表が重ならない)ゆえ順序非依存 — grant 縮小は policy 有効化の前でも後でも安全に単独適用できる。

### 11.1 適用(OT・Supabase SQL Editor・owner)

| 項目 | 内容 |
|---|---|
| 何を | `db/roles/recallmint_app-grants-phase3.sql`(5 表の REVOKE 群)を owner(postgres)権限で適用 |
| 順序 | **base grants → phase3 REVOKE の順が絶対**。base grants(`db/roles/recallmint_app-grants.sql` の blanket `GRANT ... ON ALL TABLES`)が既に適用済の前提で、その**後段**に REVOKE を流す。逆順(REVOKE 先→ blanket GRANT 後)にすると GRANT が REVOKE を上書きし縮小が無効化する。stg は既に RLS-P1 で base grants 適用済ゆえ、本 file を単独実行すればよい |
| どう | SQL Editor に `recallmint_app-grants-phase3.sql` の全文を貼り付け実行(正本は file・実行直前に再確認)。冪等(REVOKE は権限非保持でも no-op 成功)ゆえ再実行安全 |
| 期待結果 | エラーなく完了。§11.2 の readback で 5 表 × 全コマンドの実効権限が期待 matrix と一致 |
| NG 時 | REVOKE 自体がエラーになることは通常ない(権限非保持でも成功)。readback が期待とズレたら base grants の再適用有無・適用順を確認して再実行 |

### 11.2 適用確認 readback SQL(§11.1 直後・OT)

**SQL Editor で「実行成功」しても実効権限が変わった保証にはならない**(REVOKE は no-op でも成功する)。必ず `has_table_privilege` で実効 matrix を readback して検証する。

```sql
-- 5 表 × 4 コマンドの app-role 実効権限 matrix。期待値は下表と完全一致すること。
SELECT
  t.relname AS table_name,
  has_table_privilege('recallmint_app', 'public.' || t.relname, 'SELECT') AS can_select,
  has_table_privilege('recallmint_app', 'public.' || t.relname, 'INSERT') AS can_insert,
  has_table_privilege('recallmint_app', 'public.' || t.relname, 'UPDATE') AS can_update,
  has_table_privilege('recallmint_app', 'public.' || t.relname, 'DELETE') AS can_delete
FROM pg_class t
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname IN ('ai_usage','stripe_events','clerk_events','contact_messages','integration_failures')
ORDER BY t.relname;
```

期待 matrix(t=許可 / f=拒否):

| table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `ai_usage` | **t** | **t** | **t** | f |
| `clerk_events` | **t** | **t** | f | f |
| `contact_messages` | **t** | **t** | f | **t** |
| `integration_failures` | f | **t** | f | f |
| `stripe_events` | **t** | **t** | f | f |

> **⚠️ contact_messages が SELECT=t なのは意図**。退会 lifecycle の `DELETE FROM contact_messages WHERE user_id=…`(`handle-clerk-event.ts:219`)が WHERE で user_id を読むため、PostgreSQL は DELETE 権限に加え **SELECT 権限も要求**する(SELECT 剥奪下では退会 DELETE 自体が 42501 で失敗)。列単位 GRANT(`SELECT(user_id)` のみ)は本 wave 対象外のため table-level SELECT を残す。詳細は grants-phase3.sql の根拠コメント。

補助 readback(role_table_grants で付与コマンドを列挙・上の matrix と交差確認):

```sql
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'recallmint_app' AND table_schema = 'public'
  AND table_name IN ('ai_usage','stripe_events','clerk_events','contact_messages','integration_failures')
ORDER BY table_name, privilege_type;
```

期待: `ai_usage` = INSERT/SELECT/UPDATE / `clerk_events` = INSERT/SELECT / `contact_messages` = DELETE/INSERT/SELECT / `integration_failures` = INSERT / `stripe_events` = INSERT/SELECT。

### 11.3 意図的 42501 発火(実効確認・任意)

readback に加え、revoke 済コマンドを app 用接続(`DATABASE_URL_APP`)で 1 発叩き 42501 を確認できる(例: `DELETE FROM ai_usage;` / `SELECT id FROM integration_failures LIMIT 1;` → いずれも `permission denied` = SQLSTATE 42501)。破壊コマンドだが対象は非 RLS 台帳・件数少で影響軽微、かつ revoke 済ゆえ**実際には行が消えない**(権限拒否で plan 段階で止まる)。

### 11.4 smoke(CC・push 後・非破壊)

grant 縮小後、非 tenant handle 経路が従来どおり動くこと: contact 送信(匿名 + 会員)/ webhook 受信(Stripe or Clerk 実イベント 1 発 = INSERT+RETURNING)/ OCR 1 枚(ai_usage UPSERT)。`P0RLS` / 意図しない 42501 / 5xx = 0 件。特に**会員の退会**(contact DELETE を含む)は SELECT 保持の実機確認になるが破壊操作ゆえ OT 実機(test user の削除)。

### 11.5 rollback

grant 縮小の rollback は base grants の再適用(`recallmint_app-grants.sql` を再実行 = blanket CRUD 復帰)。policy と独立ゆえ RLS 状態には影響しない。

### 11.6 prod 適用成果物(適用はしない・整備のみ)

prod 有効化セッションで grant 縮小も一括適用する。順序: base grants(既存)→ phase3 REVOKE → §11.2 readback。policy 有効化とは独立(表非重複)ゆえ policy 適用順に依存しない(先行・後行どちらでも可)。失敗時停止条件 = readback matrix が期待と不一致なら prod 適用を中断し原因究明。

## 12. RLS-P3 hardening 追記(policy drift 監査・operator read-only SQL)

RLS-P3 最終 hardening wave (Task 6) は versioned SQL(`db/policies/{rls-p2,rls-p3-wave1,rls-p3-wave2}-enable.sql`)と実 DB の RLS 状態乖離を検出する drift-detection test(`tests/integration/pg/rls-drift.test.ts`)を test:iso に追加した。

**⚠️ test:iso が保証する範囲の限界**: drift test は「repo の enable SQL ↔ **test DB**」の整合のみを検出する(global-setup が毎 run 3 enable SQL を適用した結果を期待カタログと突合)。**stg/prod で operator が手動適用した後に誰かが直接 policy を変更した「手動適用 drift」は test:iso では検出できない**。それを埋めるのが以下の operator 用 read-only 監査 SQL — 適用直後(§1.3 / §10 の policy 適用後)および定期監査で SQL Editor から実行し、実 DB の RLS 状態が期待カタログと一致することを readback する。

### 12.1 policy drift 監査 SQL(read-only・OT・SQL Editor)

いずれも read-only(SELECT のみ)。owner でも app 接続でも実行可(pg_policies / pg_class は誰でも読める)。

```sql
-- (A) RLS 対象 21 表 = relrowsecurity=true / 非対象 5 表 = false / FORCE は全 public 表 false。
--     期待と異なる行 (unexpected true / 想定外の force) が 1 行でも出たら drift。
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relrowsecurity DESC, c.relname;

-- (B) policy 全定義の readback。期待カタログ (下表) と (tablename, policyname, roles, cmd,
--     permissive, qual, with_check) が完全一致すること。roles に recallmint_app 以外
--     (特に public) が出たら即 drift。qual/with_check が下の正規化テキストと 1 文字でも違えば drift。
SELECT tablename, policyname, roles, cmd, permissive, qual, with_check
FROM pg_policies WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- (C) 件数の即時 sanity: RLS on 表 = 20 / policy 総数 = 22 (共通形 19 + users 3)。
--     ②-4a S-5 の migration 0032 で 1 表(旧 source 台帳)を drop したため、旧値
--     (21 / 23) からそれぞれ 1 減っている。**0032 未適用の環境では旧値のまま**
--     (その環境では表がまだ実在し RLS on = カタログ外の表として finding に出るのが正常)。
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity) AS rls_on_tables,   -- 期待 20
  (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS total_policies;         -- 期待 22
```

### 12.2 期待カタログ(独立 oracle・drift 判定基準)

drift test の hardcoded 期待値と同一。qual/with_check は PostgreSQL が式を正規化して pg_policies に格納した後のテキスト(PG17 実測)ゆえ、下記の正規化形と**完全一致**を照合する。

**注意(PG major 差)**: (B) の qual/with_check 定数は devcontainer の **PG17** で正規化されたテキスト。stg/prod(Supabase)が異なる PG major の場合、正規化の綴り(空白・alias 形等)が cosmetic に違いうる — その text 差だけでは drift ではなく、enable SQL 再適用でも解消しない(正規化は版依存)。**PG 版に依らず authoritative な drift signal は §12.3 の semantic 兆候**(roles に `public` 混入 / qual が `true` 等の緩い述語に化ける = tenant 境界の実質無効化)。qual/with_check の text 差を見たら、まず §12.3 の semantic 兆候の有無で判定する。

正規化述語(定数):

- `TENANT_PRED` = `(user_id = ( SELECT app_current_user_id() AS app_current_user_id))`
- `USERS_ID_PRED` = `(id = ( SELECT app_current_user_id() AS app_current_user_id))`
- `USERS_LIVE_PRED` = `((id = ( SELECT app_current_user_id() AS app_current_user_id)) AND (deleted_at IS NULL))`

| 表 | policyname | roles | cmd | permissive | qual | with_check |
|---|---|---|---|---|---|---|
| 共通形 17 表※ | `<表>_tenant` | `{recallmint_app}` | ALL | PERMISSIVE | `TENANT_PRED` | `TENANT_PRED` |
| users | `users_select` | `{recallmint_app}` | SELECT | PERMISSIVE | `USERS_LIVE_PRED` | (空) |
| users | `users_insert` | `{recallmint_app}` | INSERT | PERMISSIVE | (空) | `USERS_ID_PRED` |
| users | `users_update` | `{recallmint_app}` | UPDATE | PERMISSIVE | `USERS_LIVE_PRED` | `USERS_ID_PRED` |

※ 共通形 17 表 = `exams` / `cards` / `tombstones` / `study_days`(P2)+ `answer_events` / `tag_categories` / `tag_options` / `card_tags` / `entity_mutations` / `card_asset_refs` / `ai_usage_users`(Wave1)+ `user_settings` / `assets` / `source_documents` / `upload_records`(Wave2)+ `upload_operations` / `asset_derivations`(②-4a・§13)。各表ちょうど 1 policy。正本は `scripts/verify-rls-state.ts` の `COMMON_FORM_RLS_TABLES`(本表はその写し — 食い違ったら script 側が正)。**2026-08-11「FSRS 整合 Sprint A」で `reviews`(Wave1)/ `study_sessions`(Wave2)が表ごと DROP され 19 → 17 表**(RLS 対象 = 17 + users = 18 表 / policy = 17 + users 3 = 20 件)。**prod は本 sprint の migration 未適用**のため、prod へ本 script を向けると当面この 2 表が「カタログ外の表が RLS on」として finding に出るのが正常。

**users に DELETE policy が無いこと**(FOR ALL も FOR DELETE も不在 = app-role の users hard delete を構造的 deny)を (B) の users 行が 3 件(select/insert/update)ちょうどであることで確認する。**非対象 5 表**(`ai_usage` / `stripe_events` / `clerk_events` / `contact_messages` / `integration_failures`)は (B) に 1 行も出ないこと(policy ゼロ)+ (A) で relrowsecurity=false。

### 12.3 drift 検出時の対応

- (A)/(B)/(C) が期待とズレた場合 = 手動適用 drift の疑い。**まず enable SQL(`db/policies/*-enable.sql`)を再適用**(冪等・DROP POLICY IF EXISTS 内蔵)して期待状態へ復元し、再度 (A)〜(C) で一致を確認する。
- roles に `public` が混入・qual が `true` 等の緩い述語に化けている場合 = tenant 境界が実質無効化されている可能性。復元前に incident 扱いで OT にエスカレーション(§3 rollback 判断)。
- prod 有効化セッションでは policy 適用直後に (A)〜(C) を必ず readback してから smoke に進む(適用「成功」≠ 期待状態、の原則は §11.2 grant readback と同じ)。

## 13. ②-4a 追記(upload_operations / asset_derivations・2 表)

②-4a(OCR 画像図版切り出し)の新設 tenant 表を **P2 / Wave1 / Wave2 と同一の共通形 policy** で RLS 化する。適用機構は §1.3 Step 3 と同一(Supabase SQL Editor・owner・冪等 `DROP POLICY IF EXISTS` 付)。

**当初 3 表だったが 2 表になった**(2026-08-05・S-5): 単一 invocation 経路への cutover に伴い、旧 source 台帳を migration 0032 が drop した。`ocr-2-4a-{enable,disable}.sql` も 2 表に縮んでいる。**0032 未適用の環境で disable.sql を打っても、drop 前のその 1 表だけは RLS が有効なまま残る**(§3 の緊急 rollback を打つ場合の既知の穴)。**この穴は 0032 未適用の環境にのみ当てはまる — stg / prod はいずれも 0032 適用済**(prod は 2026-08-10 の app role 実効検証で `source_assets` の不在を確認・§13.3)。**prod は ocr-2-4a policy 適用済み**(同検証で `upload_operations` / `asset_derivations` とも RLS 有効・policy あり・実効検証 P0RLS)。

- **前提**: 0025 functions は P2 で適用済(新 function なし・policy SQL のみ)。migration 0026-0032 が適用済で 2 表が存在すること。
- **適用**: `db/policies/ocr-2-4a-enable.sql` の全文を SQL Editor(owner)で実行(正本は file・実行直前に再確認)。
- **rollback**: `db/policies/ocr-2-4a-disable.sql`(RLS 無効化のみ・policy 定義は残置。§3.1 と同型)。
- **確認**: §13.2 の実効検証を必ず実施する(SQL Editor の readback だけでは足りない — 下記)。

### 13.1 恒久規律 — 新規 tenant 表は migration と policy を同一作業内で当てる(分けない)

**新しい tenant 表を追加する migration を適用したら、その同じ作業の中で対応する policy SQL(`db/policies/*-enable.sql`)を当てる。別作業に分けてはならない。**

根拠(2026-08-04 実測):

- **stg**: migration 0026-0030 は適用済・grant も付いていたが、`ocr-2-4a-enable.sql` は**当たっていなかった**。ledger には「適用済み・合格」と記録されていた(記録と現物の乖離)。app role 接続で無関係な tenant context を張ると `source_assets` の他 user 行が 2 件読めた。
- **prod**: migrate 直後の状態を実測したところ **「3 表あり / RLS off / policy なし / grant は 12 行フル」**。つまり **migrate は RLS を伴わず、既定 grant だけが自動で付く**(`db/roles/recallmint_app-grants.sql:5-6` の `ALTER DEFAULT PRIVILEGES`)。**migration と policy を別作業に分けた瞬間、「表とフル権限はあるが tenant 境界は無い」窓が開く。**

新表を追加する sprint では、この runbook に §13 と同型の節(対象表 / enable SQL / disable SQL / 実効検証)を**その sprint 内で追記**する。追記していない = 適用手順が存在しない = 今回と同じ漏れが起きる。

### 13.2 「合格」と書いてよい条件 — app role 実効検証の出力を証跡に残すまで書かない

**SQL Editor(owner)での readback は検証にならない。** owner 接続は policy を素通しするため、RLS が無効でも「見える」= false-green になる(`db/policies/ocr-2-4a-enable.sql:2-3` の非 FORCE 設計の帰結)。**実効検証は必ず app role(`recallmint_app`)接続で行い、その生出力を session doc / ledger に貼るまで「合格」と記録しない。**

検証手段 = `scripts/verify-rls-state.ts`(read-only・app role 専用・カタログ突合 + 実効検証を 1 コマンド):

```bash
RLS_VERIFY_DATABASE_URL='postgresql://recallmint_app:...@<host>:6543/postgres' \
  pnpm tsx scripts/verify-rls-state.ts [--user <uuid>]
```

- **app role 以外(owner / superuser / BYPASSRLS)では実行を拒否**して exit 2(false-green を構造的に封じる)。
- exit code: `0` = カタログ突合合格 / `1` = カタログ不一致 or 実効検証 FAIL / `2` = 前提エラー(未検証)。
- **実効検証が「判定不能」と出力されることがある**(migrate 直後の prod 等)。決定的証拠は「context 無しで読むと P0RLS が raise する」ことだが、**raise の有無は行数ではなく実行計画依存**(同じ空表でも index scan なら raise し seq scan なら raise しない・PG17 実測)。ゆえに raise しなかった場合は「qual はあるが評価されなかった」と「**そもそも qual が無い = RLS 未適用**」の両方を含み、観測だけでは区別できない。この場合は**カタログ突合の結果をもって判断**すること。判定不能を「合格」と書き替えないこと。
- 期待カタログの正本は script 側(`scripts/verify-rls-state.ts`)。`tests/integration/pg/rls-drift.test.ts` は同じカタログを import する(二重管理なし)。ただし **drift test の実行先は local iso PG 固定**(`tests/integration/pg/setup/db-url.ts` の `assertLocalTestDb`)ゆえ、**stg/prod の drift を検出できるのは本 script だけ**。

### 13.3 実効検証の証跡(env ごとに生出力を並べる)

**§13.2 の「合格と書いてよい条件」を満たした実行の記録**。新しい実行をしたらこの節に追記する(上書きしない)。

| env | 実行日 | 接続 role | RLS 表 | policy | grant | 実効検証 | exit | 生出力 |
|---|---|---|---|---|---|---|---|---|
| **prod** | 2026-08-10 | `recallmint_app`(rolsuper=false / rolbypassrls=false) | 20 / 20 | 22 / 22 | 25 表 / 25 表 | **PASS**(decisive 19 / **inconclusive 0**) | 0 | 下記 |
| stg | 2026-07-22 | `recallmint_app` | 18 | 20 | 5 表 readback 一致 | PASS(drift ゼロ) | — | `docs/superpowers/sessions/`(RLS P2/Wave 実証記録)+ §11.2 / §12 の readback |

**stg 18 表 / prod 20 表の差は設計差ではなく時点差**: ②-4a の 2 表(`upload_operations` / `asset_derivations`)が stg 実証(2026-07-22)の時点では存在しなかった。policy の形・非 RLS 5 表の集合・`force` 全 false・grant 突合はすべて一致している。

#### prod 生出力(2026-08-10・read-only・`scripts/verify-rls-state.ts`)

```
## 1. 接続
項目             | 値
-----------------+--------------------------------------------------------------------
接続元 env       | RLS_VERIFY_DATABASE_URL
接続先           | host=aws-1-ap-northeast-1.pooler.supabase.com port=6543 db=postgres
current_user     | recallmint_app
current_database | postgres
rolsuper         | false
rolbypassrls     | false

## 2. カタログ突合
観点            | 実測  | 期待  | 判定
----------------+-------+-------+-----
RLS 有効表      | 20    | 20    | OK
policy 総数     | 22    | 22    | OK
grant(app role) | 25 表 | 25 表 | OK

table                | rowsecurity | force
---------------------+-------------+------
ai_usage             | false       | false
ai_usage_users       | true        | false
answer_events        | true        | false
asset_derivations    | true        | false
assets               | true        | false
card_asset_refs      | true        | false
card_tags            | true        | false
cards                | true        | false
clerk_events         | false       | false
contact_messages     | false       | false
entity_mutations     | true        | false
exams                | true        | false
integration_failures | false       | false
reviews              | true        | false
source_documents     | true        | false
stripe_events        | false       | false
study_days           | true        | false
study_sessions       | true        | false
tag_categories       | true        | false
tag_options          | true        | false
tombstones           | true        | false
upload_operations    | true        | false
upload_records       | true        | false
user_settings        | true        | false
users                | true        | false

## 3. 実効検証
前提                                           | 結果
-----------------------------------------------+------------------------
app_current_user_id() 直接呼出(context 未設定) | P0RLS(raise 機構は健在)

table             | no-context probe  | bogus ctx 可視
------------------+-------------------+---------------
exams             | P0RLS(効いている) | 0
cards             | P0RLS(効いている) | 0
tombstones        | P0RLS(効いている) | 0
study_days        | P0RLS(効いている) | 0
reviews           | P0RLS(効いている) | 0
answer_events     | P0RLS(効いている) | 0
tag_categories    | P0RLS(効いている) | 0
tag_options       | P0RLS(効いている) | 0
card_tags         | P0RLS(効いている) | 0
entity_mutations  | P0RLS(効いている) | 0
card_asset_refs   | P0RLS(効いている) | 0
ai_usage_users    | P0RLS(効いている) | 0
study_sessions    | P0RLS(効いている) | 0
user_settings     | P0RLS(効いている) | 0
assets            | P0RLS(効いている) | 0
source_documents  | P0RLS(効いている) | 0
upload_records    | P0RLS(効いている) | 0
upload_operations | P0RLS(効いている) | 0
asset_derivations | P0RLS(効いている) | 0

実効検証 = PASS
理由: decisive 19 / inconclusive 0 — no-context probe が P0RLS を raise した表 19 件(例: exams, cards, tombstones)= policy が実効で評価されている決定的証拠。

## 4. 総合判定
項目         | 結果
-------------+-----
カタログ突合 | 合格
実効検証     | PASS
exit code    | 0
```

policy 一覧(§2 の 3 つ目の表)は tenant 20 表が各 1 policy(`<table>_tenant`・FOR ALL・TO `recallmint_app`・qual/with_check とも `(user_id = ( SELECT app_current_user_id() AS app_current_user_id))`)、`users` のみ 3 policy(`users_select` / `users_update` は `AND (deleted_at IS NULL)` 付き・`users_insert` は with_check のみ)で合計 22。**紙幅のため本節では省略**(再取得はコマンド 1 本)。

**この実行で分かった付随事実**: prod に `source_assets` は存在しない(= migration 0032 適用済み)。**inconclusive 0** ゆえ、0 行を「合格」に流した表は無い。

## 関連 doc

- Wave 1 factfinding / wave 定義: `docs/audit/2026-07-21-rls-phase3-step0-tx-boundary-factfinding.md`(§5.3 / 追補 / 追補2)
- Wave 1 policy 正本: `db/policies/rls-p3-wave1-enable.sql` / `db/policies/rls-p3-wave1-disable.sql`
- spec: `docs/superpowers/specs/2026-07-20-rls-p2-representative-closure-design.md`
- plan: `docs/superpowers/plans/2026-07-20-rls-p2-representative-closure.md`
- Perf-0b(before 数値): `docs/audit/2026-07-18-rls-performance-before-factfinding.md`
- RLS-P1(app role 分離・env 分離の前提): `docs/superpowers/sessions/2026-07-18-rls-p1-app-role-separation-implementation.md`
- PERF-SEED 再投入手順: `docs/audit/2026-07-16-seed-perf-exam-reseed-procedure.md`
- test:iso カバレッジ対応表: `tests/integration/pg/COVERAGE.md`
- policy 正本: `db/policies/rls-p2-enable.sql` / `db/policies/rls-p2-disable.sql`
- 0025 migration: `drizzle/migrations/0025_rls_p2_functions.sql`
- Phase 3 grant 縮小正本: `db/roles/recallmint_app-grants-phase3.sql`(base: `db/roles/recallmint_app-grants.sql`)
- Phase 3 grant test: `tests/integration/pg/grant-narrowing.test.ts` / plan: `docs/superpowers/plans/2026-07-21-rls-phase3-hardening.md`(Task 5)
- Phase 3 policy drift test: `tests/integration/pg/rls-drift.test.ts` / plan: `docs/superpowers/plans/2026-07-21-rls-phase3-hardening.md`(Task 6・drift 監査 SQL = 本 doc §12)
