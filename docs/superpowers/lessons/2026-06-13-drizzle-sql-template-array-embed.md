# Drizzle `sql` template への array 直接 embed は record 展開 — array bind は `sql.param(array)` 必須

> **Source**: 2026-06-13 Y-2 T-B2 (review-events/bulk study_days SQL N+1 解消)、 初版実装 (旧 commit `481d2e4`、 git reset で巻き戻し済) で `ANY(${days}::date[])` の array embed が **invalid PG cast を生成**、 spec / code quality 両 reviewer round 1 が Critical 検出、 round 2 で `sql.param(days)` 化 + render-shape regression test 強化で fix (新 commit `d1987da` + session log `ce1c257`)。

## 1. 背景

T-B2 で per-JST-day SELECT N+1 を `GROUP BY day` 1 文集約する際、 day 配列 `days: string[]` を Drizzle の `sql` template に **直接 embed**して PostgreSQL の `ANY()` 述語に渡そうとした:

```ts
const days = [...dayMap.keys()]
const distinctRows = await tx.execute(sql`
  SELECT ...
  WHERE user_id = ${user.id}::uuid
    AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date = ANY(${days}::date[])  -- ★ broken
  GROUP BY (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date
`)
```

**現実の rendering** (`PgDialect().sqlToQuery()` 実機検証):

```
SQL:    ... ANY(($1, $2)::date[])
PARAMS: ["2026-05-25", "2026-05-26"]
```

Drizzle は `${array}` を **record 構造 `(p1, p2, ..., pN)`** で展開する (`node_modules/drizzle-orm/sql/sql.cjs` 内 `StringChunk('(')` + `StringChunk(')')` 包囲)、 各要素は別 param に分解。 結果 PG runtime で `cannot cast type record to date[]` 相当の throw、 `tx` rollback、 **bulk endpoint が常に failed[] 全件返す** = review session 完了経路が production で常時破綻。

**unit test は false confidence**: `tx.execute` を完全 mock + 構造 string 検査 (`rendered.toContain('ANY')`) で旧 broken 形 (`ANY(($1, $2)::date[])`) を通した、 30/30 vitest pass。 mock では actual PG cast が走らないため bug が隠れる。

## 2. Lessons learned

### L1. `${array}` 直接 embed は禁止、 array → 1 つの array 値 bind には `sql.param(array)` 必須

**Rule of thumb**: Drizzle の `sql` template で JS array を 1 つの array 値として bind するときは **必ず `sql.param(arr)` で wrap**:

```ts
WHERE x = ANY(${sql.param(days)}::date[])
```

`sql.param(arr)` は配列を **driver に「1 値」 として渡し**、 postgres-js が text[] (or 適切な array 型) として serialize → `::date[]` cast で型強制 = `ANY($1::date[])` 形に rendering。 1 param、 record 展開なし、 PG runtime で valid cast。

逆経路 (NG):
- `${arr}` 直接 embed: record 展開 (`(p1, p2, ...)`)、 array 型 cast 不能
- 個別要素を spread して `IN ($1, $2, ...)` 形に組む: param 数が array 長依存 = prepared plan cache 無効化リスク (副次的) + array bind 専用の helper (`inArray()`) と乖離

**既存 codebase 内 `sql.param` 利用例**: **0 件** (2026-06-13 時点)。 array bind は本 T-B2 が初出経路。 将来 array bind を増やす時の **再発リスクは構造的に高い** (self-discipline で防げない、 既存 pattern が存在しないため模倣材料不在)、 本 lesson を記録材料とする。

### L2. array-bind shape regression test を mock test に必須として組み込む

mock unit test で `rendered.toContain('ANY')` のような **粗い substring 検査は危険**: broken 形 (`ANY(($1, $2)::date[])`) を通す + actual PG cast が走らないため bug 検出不能。

**必須 assertion**:

```ts
// PgDialect で実機 render
const { sql: rendered, params } = new PgDialect().sqlToQuery(capturedSql)

// 正 form (single param 形) を positive match
expect(rendered).toMatch(/ANY\(\$\d+::date\[\]\)/)
// 旧 broken (record 形) を negative match で reject
expect(rendered).not.toMatch(/ANY\(\(\$\d+/)
// params 内に array が 1 要素 (= record 展開でない array bind) として存在する verify
const arrayParam = params.find((p): p is string[] => Array.isArray(p))
expect(arrayParam).toEqual([...expectedValues])
```

これで `${arr}` 直接 embed への silent regression を遮断。 future maintainer が「cleanup」 で `sql.param` を外しても test が即 fail。

実機 PG での type cast 確認は別途必要 (= post-push の stg smoke で `/api/review-events/bulk` POST 200 + `study_days` row 反映確認、 lessons L2 of `2026-05-29-bulk-refactor-driver-layer-lessons.md` 「unit test の mock は driver / pooler 層を再現できない」 と同型)。

## 3. Related

- `docs/superpowers/lessons/2026-05-29-bulk-refactor-driver-layer-lessons.md`: 「Drizzle の `sql` template に JS Date を embed すると postgres-js の timestamptz serializer (OID 1184) が bypass され `Buffer.byteLength(Date)` で TypeError」 = 同型の `sql` template + driver 層落とし穴の先例。 Date は `toPgTimestamptz()` helper で ISO string 化、 array は `sql.param()` で 1 値 bind、 という 2 つの非自明 encode pattern が現状 codebase で共存。
- T-B2 実装 commit: `d1987da` (sql.param 化 + render-shape regression test)
- T-B2 session log: `ce1c257` (= `docs/superpowers/sessions/2026-06-13-y2-t-b2-study-days-sql-n1.md`)
- 巻き戻し済の旧 broken commit: `481d2e4` (`git reflog` でのみ確認可、 develop branch history からは消滅)
- Drizzle 内部 expand 仕様: `node_modules/drizzle-orm/sql/sql.cjs` の array→record 展開、 公式 docs では明示記述少なめ (= 実装挙動依存、 docs 拡充は upstream 課題)
