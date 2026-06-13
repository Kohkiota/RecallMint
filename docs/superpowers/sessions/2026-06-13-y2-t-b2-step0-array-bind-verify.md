# Y-2 T-B2 Step 0 — postgres-js array bind 実機検証 結果 (2026-06-13)

T-B2 (#1a study_days SQL N+1) 再設計の前段。 revert された d1987da の `sql.param(days)` 形が postgres-js (3.4.9) + Supabase Transaction pooler (prepare:false) で `Buffer.byteLength(Array)` TypeError を起こした件を踏まえ、 claude.ai が公式 docs 照合で提示した fix 候補 X / Y を stg 実 DB で叩いて確認。 throwaway endpoint `/api/verify-array-bind` を一時設置、 本 log 作成後の commit で削除する。

## 結論

**両候補とも postgres-js + Supabase Transaction pooler (prepare:false) で実機 pass**:

- candidate X (claude.ai 推奨形 = `sql.join + ${d}::date 個別展開 + IN`): ✅
- candidate Y (claude.ai 予測 ✗ = 式 inArray): ✅ **(予測と乖離)**

= claude.ai 予測「Y は drizzle bindIfParam の `isDriverValueEncoder=false` 経路で T-B2 と同型 TypeError」 は **実機で覆された**。 Drizzle 0.45.2 + postgres-js 3.4.9 の組合せで `inArray(sql\`...\`, primitiveArray)` は内部的に valid な形 (おそらく `IN ($1, $2, ...)` への展開) に rendering されている。

未確認事項 (a) `${d}::date` 形が prepare:false PgBouncer で問題ないか → **両候補で実証** (= 200 OK + 期待結果)。

X / Y どちらも本実装採用可能、 設計選好の問題。 OT 裁定要 (詳細後述)。

## 計測条件

- 環境: stg.recallmint.nekotest.net、 deploy hash `dpl_8ywBLMPPWRe6CweD6Dnd11zYA4uc` (= commit `5247638` rename 反映、 旧 throwaway hash `dpl_C59iLWRmquh643i8oaZ2mLmVtzth` から更新)
- env field = `preview` (= Vercel preview deploy / stg.recallmint.nekotest.net)
- driver: Playwright MCP × `fetch('/api/verify-array-bind')` (GET)
- 認証: test user `komail9server+clerk_test@gmail.com` (session 継続)
- 計測時刻: 2026-06-13T04:17 UTC

### days fixture (endpoint 内 ハードコード)

```ts
const days = ['2026-06-13', '2026-06-12']
```

### test user account の reviews state (今 turn 計測時点)

- 2026-06-13 (JST): 10 distinct cards 分の reviews (本日 UI session 5 問 × 2 回完走の残置由来)
- 2026-06-12 (JST): 0 reviews

## 生 results

```json
{
  "purpose": "Y-2 T-B2 Step 0 — postgres-js array bind 実機検証 (throwaway)",
  "days": ["2026-06-13", "2026-06-12"],
  "env": "preview",
  "candidateX_sqlJoinIn": {
    "ok": true,
    "rowCount": 1,
    "rows": [{ "day": "2026-06-13", "distinct_count": 10 }]
  },
  "candidateY_exprInArray": {
    "ok": true,
    "rowCount": 1,
    "rows": [{ "day": "2026-06-13", "distinct_count": 10 }]
  }
}
```

### candidate X = sql.join + 個別 param 展開 + IN

```ts
const dayParams = sql.join(
  days.map((d) => sql`${d}::date`),
  sql`, `,
)
const rows = await db.execute(sql`
  SELECT (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date::text AS day,
         COUNT(DISTINCT card_id)::int AS distinct_count
  FROM reviews
  WHERE user_id = ${user.id}::uuid
    AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date IN (${dayParams})
  GROUP BY (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date
`)
```

実機: **✅ ok=true、 rowCount=1**、 row = `{day: '2026-06-13', distinct_count: 10}` (期待結果と一致)、 error 無し。

### candidate Y = 式 inArray

```ts
const rows = await db
  .select({
    day: sql<string>`(reviewed_at AT TIME ZONE 'Asia/Tokyo')::date::text`,
    distinct_count: sql<number>`COUNT(DISTINCT card_id)::int`,
  })
  .from(reviews)
  .where(
    and(
      eq(reviews.userId, user.id),
      inArray(sql`(reviewed_at AT TIME ZONE 'Asia/Tokyo')::date`, days),
    ),
  )
  .groupBy(sql`(reviewed_at AT TIME ZONE 'Asia/Tokyo')::date`)
```

実機: **✅ ok=true、 rowCount=1**、 row = `{day: '2026-06-13', distinct_count: 10}` (X と完全一致)、 error 無し。

**claude.ai 予測「Y は型エンコーダなしで生値が postgres-js に渡され T-B2 と同型 TypeError」 が実機で覆された**。 真因は別経路 (Drizzle 0.45.2 内部で `inArray(expr, primitiveArray)` が `IN ($1, $2, ...)` 形に展開している可能性が高い、 = sql.param(array) 経路を踏まず個別 param 化する) と推定。 ただし本 log では Drizzle 内部の rendering までは未取得 (= 結果動作 pass の確認のみ)、 内部実態は実機検証 §3 で別途。

## 未確認事項 (a) — prepare:false PgBouncer 問題なし

両候補とも実 Supabase Transaction pooler (= PgBouncer transaction mode、 lib/db/index.ts:12-13 「prepare: false は Supabase pooler の要件」) で 200 OK + 期待結果。 `::date` cast / `IN ($1, $2)` 形 / `ANY` 形 すべて PgBouncer transaction pooler で問題なし実証。

## 本実装方針 (CC 推奨)

両候補とも実機 pass = どちらでも採用可。 設計選好で:

| 観点 | candidate X (sql.join+IN) | candidate Y (式 inArray) |
|---|---|---|
| 抽象度 | 低 (生 SQL に近い) | 高 (drizzle helper) |
| 既存 codebase 整合 | sql.join 利用例あり (route.ts:319 VALUES 用) | 式 inArray 利用例なし (プレーンカラム inArray のみ既存 2 件) |
| 内部 rendering 可視性 | 明示的 (= sql.join で見える) | 暗黙的 (drizzle 内部展開) |
| failure mode の予測 | 各 ${d} は string 個別 param、 driver 層 serialize は単純 | drizzle 内部 rendering の挙動依存 (本検証 pass だが将来 drizzle バージョンアップで挙動変化リスク) |

**CC 推奨 = candidate X (sql.join + IN)**:
- 既存 codebase に `sql.join` 利用例あり (= route.ts:319 Phase 2e の VALUES 構文) = 採用前例
- 内部 rendering が明示的 = driver 層挙動の予測が単純 (各 `${d}` は単一 string param、 postgres-js は string scalar として確実 serialize)
- Y は実機 pass だが drizzle 内部 rendering 挙動依存、 将来の drizzle バージョンアップで挙動変化リスクあり (= T-B2 の `sql.param(array)` が drizzle docs 通り正常 render しつつ driver 層で潰れた事案と同型のリスク継承)

OT 否認なら Y も採用可、 ただし上記リスク注記。

## throwaway 削除

本 log 作成後、 同 turn で:
- `app/api/verify-array-bind/route.ts` 削除
- chore commit ([no-review])

stg には削除 commit push 後、 endpoint が 404 に戻ることで cleanup 完了。

## 関連 commit / file

- throwaway 作成: `e3f84cd` (= `app/api/_verify-array-bind/route.ts` 新規 109 行)
- throwaway rename: `5247638` (= `_verify-array-bind/` → `verify-array-bind/`、 Next.js private folder convention 由来の 404 修正)
- 本 session log: 本 file (commit 予定)
- 削除 commit: 本 turn 末尾で作成 (chore [no-review])
- T-B2 revert: `8777e8f` (d1987da の reverse)
- 関連 lesson (本検証で訂正必要): `docs/superpowers/lessons/2026-06-13-drizzle-sql-template-array-embed.md` (= claude.ai 予測「Y ✗」 を含む内容、 本検証で「Y も pass」 が確定したため次回 update 余地、 ただし本 lesson の中核「sql.param(array) は postgres-js では機能しない」 は本検証で否定されていない = 訂正 section の next update で「Y も pass、 ただし drizzle 内部 rendering 依存のリスク注記」 を追加)

## 次 step

OT が X / Y どちらを採用するかを判断 → CC が本実装着手 (= route.ts Phase 2f を採用形で実装、 N+1 解消)。 vitest は driver 層を再現できないため (lesson `2026-05-29` L2)、 本実装の commit 後にも実機 smoke が必須 (= 本検証と同経路で再確認、 review session 完了経路の failed=0 確認)。
