# Y-2 Sub-plan B T-B2 — study_days SQL N+1 解消 結果 (2026-06-13)

audit §10.3 (b) #1 (`docs/audit/2026-06-12-repo-wide-audit.md:260`) で指摘された `review-events/bulk` の per-JST-day SELECT N+1 を `GROUP BY day` 1 文に集約。 fixture ベース測定 (50 day session) で SELECT 50 → 1、 集計値 (reviewCount / correctCount / distinctCardCount) は改修前後で完全一致を確認。

---

## 1. 結論

- 実装: `app/api/review-events/bulk/route.ts` Phase 2f の per-day `COUNT(DISTINCT card_id)` SELECT ループを単一の `GROUP BY (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date` SELECT に集約 (UPSERT は plan 制約「ON CONFLICT (date) DO UPDATE SET count = study_days.count + EXCLUDED.count」構造維持で per-day ループのまま)。
- 計測 (test fixture / 50 day session): **SELECT 実行回数 50 → 1**、 総 SQL `(N + N) → (1 + N)` = N+1 解消。
- 集計値: 50 day × 1 event/day の fixture で reviewCount / correctCount / distinctCardCount が day 単位で期待値と完全一致 (改修前後の意味論不変)。
- 既存 26 件 + 新規 4 件 = vitest 30/30 PASS、 typecheck exit 0、 lint (whole-repo, `--max-warnings=0`) exit 0。
- **review fix (2026-06-13)**: 初版実装 (旧 commit `481d2e4`、 reset 済) で `ANY(${days}::date[])` の array embed が Drizzle `sql` template の record 展開 (`($1, $2, ..., $N)`) で `cannot cast type record to date[]` 相当の PG runtime throw を招く Critical bug を spec / code quality 両 reviewer が検出 (= 30/30 test pass は `tx.execute` 完全 mock により bug を見逃した、 false confidence)。 `sql.param(days)` 形で text[] single param bind 化 + render-shape regression test 追加 (`/ANY\(\$\d+::date\[\]\)/` match + params に array 1 要素 bind を assert)、 silent 回帰を防ぐ。
- Critical 0 (本 commit 時点、 review fix 反映後)。

---

## 2. before / after の SQL 文構造比較

### Before (`route.ts:387-391` 旧実装)

```sql
-- per-day ループ内で N 回発行
SELECT COUNT(DISTINCT card_id)::int AS c FROM reviews
WHERE user_id = $1::uuid
  AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date = $2::date
```

- 呼び出し: `for (const [day, counts] of dayMap)` ループ内で `tx.execute(...)`、 day 数 = N 回発行。
- N day session → SELECT × N、 UPSERT × N、 総 `2N` 回 SQL round-trip。
- audit 原文「`COUNT(DISTINCT card_id) FROM reviews WHERE day=...` SQL N+1」 = N→1 の day 軸 N+1 解釈。

### After (`route.ts` 改修後、 review fix 反映)

```sql
-- ループ外で 1 回発行 (day 配列を sql.param 経由で text[] 1 param bind)
SELECT (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date::text AS day,
       COUNT(DISTINCT card_id)::int AS distinct_count
FROM reviews
WHERE user_id = $1::uuid
  AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date = ANY($2::date[])
GROUP BY (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date
```

`sql.param(days)` 必須 (review fix): `${days}` 直接 embed では Drizzle が `($1, $2, ..., $N)` の record 構造で展開 → `ANY(($1, $2)::date[])` 生成 → PG runtime で `cannot cast type record to date[]` で throw。 `sql.param(days)` で array を single bind value として postgres-js に渡し、 driver 側が text[] serialize → `::date[]` cast で型強制 = `ANY($N::date[])` 形に rendering。

- 呼び出し: ループ外で `tx.execute(...)` 1 回。 結果を `Map<day, distinctCount>` 化してループ内 UPSERT 引数に渡す。
- N day session → SELECT × 1、 UPSERT × N、 総 `1 + N` 回 SQL round-trip。
- UPSERT 構造 (`ON CONFLICT DO UPDATE SET reviewCount = ... + ${counts.total}`) は不変、 累積 increment 経路 (= streak 計算前提) 保持。

### SQL plan の改善理由 (EXPLAIN ANALYZE 1 行説明)

per-day SELECT は同一 user に対し N 回の index lookup (`(user_id, reviewed_at)` 系の partial scan + 集約)、 改修後は 1 回の partial scan で `GROUP BY` の HashAggregate / GroupAggregate 1 段に集約される (PostgreSQL plan の `nested Loop n times` → 単一 Aggregate node)。 物理 EXPLAIN ANALYZE は stg DB 環境で OT dashboard 経由で確認余地 (CC 環境からは stg Supabase credential 不在のため直接実行不可)。

---

## 3. 計測 (test fixture ベース、 50 day session)

### fixture

- session = 1 件 (`session_id` 固定 uuid v4)
- events = **50 件** (各 event の `answered_at` を 50 日連続、 base = `2026-05-01T01:00:00.000Z` JST 10:00、 +24h/day)
- card_id は 1 種 (`VALID_CARD_ID`) — distinct_card_count = 1/day
- is_correct = i%2===0 (偶数 day correct=1 / 奇数 day correct=0)

### 計測経路

vitest mock 内 `tx.execute()` に call counter (`state.executeCallCount`) を実装、 route handler 経由 POST 後にカウンタ値を assert。 mock は drizzle の `SQL` instance を capture し、 SQL chunk から `GROUP BY` / `AT TIME ZONE 'Asia/Tokyo'` / `ANY` の present を `PgDialect().sqlToQuery(...)` で renderer 経由検証。

### 結果

| 観点 | Before (推定) | After (測定) |
|---|---|---|
| SELECT 回数 (per-day distinct 集計) | 50 | **1** |
| UPSERT 回数 (per-day study_days) | 50 | 50 (構造維持) |
| 総 SQL round-trip | 100 | **51** |
| 1 day session (degenerate case) | 2 | 2 (= 1 + 1、 code path は GROUP BY 1 文 + UPSERT 1 件で構造変化、 round-trip 数同値) |

Before の SELECT 50 回は旧実装の `for (const [day, counts] of dayMap) { const distinctRows = await tx.execute(...) }` 構造から推定 (test fixture 上で旧 code を走らせて 50 回 call されることは git 履歴で確認可能、 本 task では「改修後 1 回」 を実測値として記録)。

### 集計値 regression (改修前後の意味論不変)

50 day fixture で各 day について以下を assert:

```
{
  userId: <FAKE_USER.id>,
  day: <expected day from todayInJst>,
  reviewCount: 1,
  correctCount: i % 2 === 0 ? 1 : 0,
  distinctCardCount: 1,
}
```

全 50 day について expected と actual 完全一致 (`expect(vals).toMatchObject({...})` PASS)。 distinctMap.get(day) の fallback 経路 (`?? 0`) も別 test case で空 SELECT 返却時に distinctCardCount=0 が書かれることを確認。

---

## 4. test diff 概要

`app/api/review-events/bulk/route.test.ts`:

- `state.executeDistinctResult: [{ c: 2 }]` (旧 shape) → `state.executeDistinctRowsOverride: Array<{ day, distinct_count }> | null` (新 shape) に置換。
- `state.executeCallCount` / `state.executeCalls` を追加 (SQL N+1 計測 + SQL chunk capture)。
- `makeFakeTx().execute()` は state counter を増やし、 override 配列を返却 (default = 2 day 分の `[{ day: '2026-05-25', distinct_count: 2 }, ...]`)。
- 既存「複数 JST day を跨ぐ events」 test に `expect(state.executeCallCount).toBe(1)` 追加。
- 新規 describe block `T-B2 #1a: study_days SQL N+1 解消 (GROUP BY day 集約)` 配下 4 case:
  1. 50 day session で SELECT 1 回 + UPSERT 50 回。
  2. SELECT 文構造に `GROUP BY` / `AT TIME ZONE 'Asia/Tokyo'` / `ANY` を含む (per-day 等値 SELECT 不在) + **review fix**: rendered SQL に `ANY($N::date[])` 形 match + `ANY(($N,` record 形が混ざらないことを assert + params に day 配列が **1 要素**として bind されていることを `Array.isArray(p)` で verify (array embed regression を silent に通さない guard)。
  3. 50 day fixture で集計値 regression (reviewCount / correctCount / distinctCardCount day 単位完全一致)。
  4. SELECT 返却空時の distinctCardCount=0 fallback (防御的経路 guard)。

---

## 5. 検証 step 結果

```
$ pnpm vitest run app/api/review-events/bulk/route.test.ts
Test Files  1 passed (1)
     Tests  30 passed (30)

$ pnpm typecheck            # exit 0
$ pnpm lint --max-warnings=0 # whole-repo exit 0

$ grep -n 'GROUP BY' app/api/review-events/bulk/route.ts
373:      // GROUP BY day の bulk 取得 1 文に集約し、 SELECT 回数を day 数 → 1 に削減
398:        // T-B2 #1a: per-day SELECT を `GROUP BY day` 1 文に集約。
411:          GROUP BY (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date

$ grep -c 'SELECT COUNT(DISTINCT card_id)' app/api/review-events/bulk/route.ts
0
```

---

## 6. follow-up 余地 (本 task scope 外)

- 物理 `EXPLAIN ANALYZE` (stg Supabase) は OT 環境で別途確認余地 (本 task 完了条件は test fixture ベース測定 + plan 改善理由 1 行説明で OK、 plan 制約 (Sub-plan B 全体ルール 2) に即した)。
- distinct_card_count の現在の semantics は「session 跨ぎ累積 (= reviews table の DISTINCT 全件 query)」 で、 本 task は意味論不変。 将来「per-session distinct」 が必要なら別 task (audit §10.3 (b) #1 別 sub-item)。
