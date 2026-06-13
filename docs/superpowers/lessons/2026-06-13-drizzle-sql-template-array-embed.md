# Drizzle `sql` template への array 直接 embed は record 展開 — array bind は `sql.param(array)` 必須

> **⚠️ 訂正 (2026-06-13、 後刻)**: 本 lesson の中核主張 (= `sql.param(array)` で OK) は **誤り**と判明。 後述「### 訂正: sql.param(array) は postgres-js では機能しない」 section を必読。 d1987da は revert (`8777e8f`)、 stg 経路復旧済。 本 lesson の §1 / §2 / §3 は誤誘導の記録として温存 (削除でなく訂正記録、 false lesson の発生→否定の trace を残す)。

> **Source**: 2026-06-13 Y-2 T-B2 (review-events/bulk study_days SQL N+1 解消)、 初版実装 (旧 commit `481d2e4`、 git reset で巻き戻し済) で `ANY(${days}::date[])` の array embed が **invalid PG cast を生成**、 spec / code quality 両 reviewer round 1 が Critical 検出、 round 2 で `sql.param(days)` 化 + render-shape regression test 強化で fix を試みた (新 commit `d1987da` + session log `ce1c257`)。 しかし fix も postgres-js 実 serializer 段で別 TypeError、 stg smoke で発覚 → revert (`8777e8f`)。

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

---

## ⚠️ 訂正: `sql.param(array)` は postgres-js では機能しない (2026-06-13、 後刻)

### 真因 (OT が Vercel function log で確認、 2026-06-13)

```
TypeError: The "string" argument must be of type string or an instance of
Buffer or ArrayBuffer. Received an instance of Array
  at Buffer.byteLength
  at Function.str (postgres-js serializer)
```

- 型解決自体は drizzle で正しく走り (`types=2950,1182` = uuid,date の OID 解決済)、 SQL は `ANY($2::date[])` 形に render される
- しかし **param #2 (= `sql.param(days)` の array 値)** が postgres-js シリアライザに渡される時、 driver は array を **1 つの array 値 (= text[] serialize)** として扱わず、 **スカラ string として `Buffer.byteLength` を呼んで TypeError** で死ぬ
- 結果 Phase 2f 内で tx throw → catch で applicable events 全 failed[]、 stg で review session 完了経路が常時 broken

### `sql.param(array)` の誤解釈

本 lesson の §1 / §2 で「`sql.param(arr)` は配列を driver に 1 値として渡し、 postgres-js が text[] serialize する」 と書いたが、 これは **誤り**:

- drizzle 内の `sql.param()` は単に `Param` instance を generate して param スロットに 1 個分 assign する (= rendering は `$N` 1 個)、 driver 渡しを 1 値にする
- しかし **postgres-js は array 値を受け取った時に「これは array bind」 とは推論しない** (= 標準的な PG protocol で array bind は `text[]` 等の専用 type が指定されている前提)、 既定で **string とみなして `Buffer.byteLength` を呼ぶ**
- → Array.prototype を Buffer.byteLength に渡せず TypeError

### local render テストが false confidence だった理由

- `PgDialect().sqlToQuery()` は **render 文字列を返すだけ** = postgres-js 実シリアライズを通さない
- render output (`ANY($1::date[])`) は **valid SQL form として見える** が、 driver 段で別 issue が起きるかは未検証
- 本 lesson の L2 で提案した「render-shape regression test (`/ANY\(\$\d+::type\[\]\)/` match)」 は driver 層 mock を再現しない、 = 初版 `481d2e4` の broken 形 (`ANY(($1,$2)::date[])`) を通した「`tx.execute` mock + 構造 substring 検査」 と **同じ false confidence の穴** に落ちる
- 既存 lesson `2026-05-29-bulk-refactor-driver-layer-lessons.md` L2 「unit test の mock は driver / pooler 層を再現できない、 実 DB smoke を完了条件に」 が **本件でも的中**

### 真の Lesson (= 既存 2026-05-29 L1/L2 と同型 + array bind 特有)

1. **driver 層は mock で再現できない**: render shape test は SQL 文字列の構造を pin する以上の意味を持たない、 実 PG serialize の通過は **stg / preview deploy + 実 DB smoke でしか証明できない** (= `2026-05-29` L2 と同一)
2. **postgres-js への array bind の正解は未確定** (2026-06-13 時点): 候補 = drizzle `inArray()` helper / `sql.join(days.map(d => sql\`${d}\`), sql\`, \`)` で `ANY(ARRAY[$1, $2]::date[])` 形に個別 param 展開 / `unnest($1::text[])` 経由。 いずれも local render では確証不能 = 再 push 後の実機 smoke 必須。 候補のどれが postgres-js + 実 PG で通るかは本 lesson の **次回 update で記録**する (= revert 後の再設計 task で確定する)
3. **「array は sql.param() で 1 値 bind」 は誤り**を本 lesson に記録: 次セッションの自分が本 lesson の §1 / §2 だけ読んで再採用するリスクを警告 (= 訂正 section を必読化)

### 訂正の commit chain

- 初版 broken (`${days}` 直接 embed): `481d2e4` (git reset で巻き戻し済)
- sql.param fix 試行 (本 lesson §1/§2 の主張): `d1987da` (revert された)
- session log: `ce1c257` (内容に sql.param の経緯記述あり、 revert に伴い同様に訂正余地、 本 lesson の訂正で trace 維持)
- revert: `8777e8f` (本 lesson 訂正 commit と同 push 単位、 stg 経路復旧)
- T-B2 再設計 task: 別 commit で `inArray` / `sql.join` / `unnest` 候補を検証 (= postgres-js + 実 PG で通る形を確定後に本 lesson を再 update)
