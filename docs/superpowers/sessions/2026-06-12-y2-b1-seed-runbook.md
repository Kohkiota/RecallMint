# Y-2 Sub-plan B T-B1 前段 — `/app/tags` H7 計測用 stg seed runbook (2026-06-12)

T-B1 (H7 `/app/tags` 初期遅延 切り分け) の measurement に必要な stg fixture (2000+ card 級) を **test exam 隔離 + 計測後削除可能** な形で投入する手順。 OT 承認後に CC が Playwright MCP 経由実行する。

---

## 1. fixture target

`/app/tags` の dominant cost は **`category-list.tsx:127-148` の per-option `db.card_tags.where('option_id').equals(...).count()`** = options 数 × card_tags subset count の N+1 (tag_categories: O(N), tag_options: O(N×M), card_tags: O(rows))。

H7 切り分け (a server roundtrip / b Dexie 初回 fetch / c SSR rendering) を意味のある負荷で測るため、 cards 単体ではなく **cards + tag_categories + tag_options + card_tags** 4 store を協調 seed する:

| store | 件数 | 備考 |
|---|---|---|
| exams | 1 | seed 専用 1 件 (`seed-y2-b1-tags-perf-2026-06-12`) |
| cards | **2000** | 上記 exam 内 |
| tag_categories | 10 | prefix `Y2B1-cat-` |
| tag_options | 100 (10/cat × 10) | prefix `Y2B1-opt-` |
| card_tags | 4000 | card × 2 option (deterministic round-robin、 計測再現性確保) |

deterministic 割当: `card[i] → [tag_options[(i*2) % 100], tag_options[(i*2+1) % 100]]`。 random だと再 seed 時の Dexie scan 特性が揺れる。

prefix `Y2B1-` (固定) で UI 上の test data を一目で識別可能。

---

## 2. 投入経路の選択 — Playwright MCP × bulk endpoint (採用)

CC 環境制約 (DB credential なし) と「production-faithful な経路」 を両立する案として **Playwright MCP 経由で stg にログイン済 session を使い `POST /api/entity-mutations/bulk` を直接 fetch** する。 投入も計測も同 session 内で完結。

|案|採用|理由|
|---|---|---|
|**A. Playwright + bulk endpoint POST**|✅|server-side validation を通る = real code path、 mutation_id 冪等性も effective、 ログイン session 流用、 CC 側 credential 不要 |
|B. Drizzle direct script|❌|stg Supabase credential が CC 環境に無い、 entity_mutations log + Dexie sync を bypass し H7 計測の前提が変質|
|C. Supabase SQL via OT 手動|❌|OT 手数 増、 client mirror (Dexie) は pull 経由で別途 sync 必要、 投入経路が異質で再現性低下|

exam create だけ Server Action 経路 (`createExam(name)`) で bulk envelope に乗らないため、 ① UI から 1 回 exam 作成 → ② 残り tag_categories / tag_options / cards / tag attachments を bulk POST で投入 の 2 段。

---

## 3. 前提条件

- stg ログイン済 Playwright session (test user `komail9server+clerk_test@gmail.com`)
- 既存 seed 残骸が無いこと (前回 cleanup 完遂、 確認 step あり)
- `Y2B1-` prefix の tag_categories / `seed-y2-b1-` 始まる exams が 0 件
- Y-2 Sub-plan A push 反映済 develop が stg に出ていること (envelope 仕様変更なしのため backward 互換、 直前リリース確認のみ)

---

## 4. 投入手順 (Playwright)

CC が stg にアクセス → 以下を順に実行。

### Step 0: 既存残骸の確認 + cleanup (idempotency 担保)

```js
// browser_evaluate (stg signed-in session 内)
async () => {
  // exams 一覧から seed-y2-b1- 始まる行を検出
  const res = await fetch('/api/pull?since=0&limit=10000');  // 例、 実 endpoint shape 要確認
  // または UI 経由で /app/exams を navigate して prefix 含む行を抽出
  return { /* 残骸 file path 一覧 */ };
}
```

残骸あり → UI で削除 (exam 削除でカード cascade) → `/app/tags` で `Y2B1-cat-*` 削除 (option + 残 card_tags cascade) → 再確認で 0 件まで repeat。

### Step 1: exam 作成 (1 件、 UI 経由)

```
navigate /app/exams
click "手動で試験を作成"
fill "試験名" = "seed-y2-b1-tags-perf-2026-06-12"
click "作成"
→ navigated to /app/exams/<EXAM_UUID> — page URL から exam_id 抽出
```

`EXAM_UUID` を以降 step で参照。

### Step 2: tag_categories 10 件 + tag_options 100 件 投入 (bulk POST × 1)

```js
async ({ EXAM_UUID }) => {
  const uuid = () => crypto.randomUUID();
  const now = new Date().toISOString();

  // 10 categories
  const categories = Array.from({ length: 10 }, (_, i) => ({
    id: uuid(),
    name: `Y2B1-cat-${String(i + 1).padStart(2, '0')}`,
  }));

  // 10 options per category (= 100 total)
  const options = categories.flatMap((cat, ci) =>
    Array.from({ length: 10 }, (_, oi) => ({
      id: uuid(),
      categoryId: cat.id,
      name: `Y2B1-opt-${String(ci + 1).padStart(2, '0')}-${String(oi + 1).padStart(2, '0')}`,
      color: 'blue',  // 適切な enum 値、 envelope schema 確認
    })),
  );

  const mutations = [
    ...categories.map((c) => ({
      mutation_id: uuid(),
      entity_type: 'tag_category',
      entity_id: c.id,
      op: 'create',
      patch: { name: c.name, color: 'blue' /* 適切な default */ },
      edited_at: now,
    })),
    ...options.map((o) => ({
      mutation_id: uuid(),
      entity_type: 'tag_option',
      entity_id: o.id,
      op: 'create',
      patch: { category_id: o.categoryId, name: o.name, color: o.color },
      edited_at: now,
    })),
  ];
  // 10 + 100 = 110 mutations、 bulk max 1000 内 1 POST OK
  const res = await fetch('/api/entity-mutations/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutations }),
  });
  return { status: res.status, body: await res.json(), optionIds: options.map((o) => o.id) };
}
```

期待: `{ok:true, applied:110, failed:[]}` + 全 100 option UUID を session 内変数に保持。

### Step 3: cards 2000 件 投入 (bulk POST × 2、 1000/batch)

```js
async ({ EXAM_UUID }) => {
  const uuid = () => crypto.randomUUID();
  const now = new Date().toISOString();

  const cardIds = [];
  for (let batch = 0; batch < 2; batch++) {
    const mutations = Array.from({ length: 1000 }, (_, j) => {
      const idx = batch * 1000 + j;
      const cardId = uuid();
      cardIds.push(cardId);
      return {
        mutation_id: uuid(),
        entity_type: 'card',
        entity_id: cardId,
        op: 'create',
        patch: {
          exam_id: EXAM_UUID,
          title: `Y2B1-card-${String(idx).padStart(4, '0')}`,
          sort_key: String(idx + 1).padStart(5, '0'),
          question_text: `Y2B1 stress card ${idx}`,
          options: [{ id: '1', text: 'A', is_correct: true }],
          explanation_text: null,
          memo: null,
        },
        edited_at: now,
      };
    });
    const res = await fetch('/api/entity-mutations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutations }),
    });
    // batch ごとに { ok, applied, failed } 確認、 failed が空でないなら停止
    const body = await res.json();
    if (body.failed?.length) return { error: 'card batch failed', batch, body };
  }
  return { cardIds };  // 2000 件保持
}
```

期待: 2 batch とも `{ok:true, applied:1000, failed:[]}`。 wall-clock 推定 = 50-150 秒/batch (per-mutation tx serial 実装 = T-B3 前)。 **本 seed の wall-clock 自体が T-B3 #1b の改善対象数値の baseline にもなる** (session log に記録)。

### Step 4: card_tags 4000 件 投入 — card.tag_option_ids field update (bulk POST × 2、 1000/batch)

```js
async ({ cardIds, optionIds }) => {
  const uuid = () => crypto.randomUUID();
  const now = new Date().toISOString();

  // deterministic round-robin: card[i] → [options[(i*2) % 100], options[(i*2+1) % 100]]
  for (let batch = 0; batch < 2; batch++) {
    const mutations = Array.from({ length: 1000 }, (_, j) => {
      const i = batch * 1000 + j;
      return {
        mutation_id: uuid(),
        entity_type: 'card',
        entity_id: cardIds[i],
        op: 'update_field',
        patch: {
          field: 'tag_option_ids',
          value: [optionIds[(i * 2) % 100], optionIds[(i * 2 + 1) % 100]],
        },
        edited_at: now,
      };
    });
    const res = await fetch('/api/entity-mutations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutations }),
    });
    const body = await res.json();
    if (body.failed?.length) return { error: 'tag attach batch failed', batch, body };
  }
  return { ok: true };
}
```

期待: 2 batch とも `{ok:true, applied:1000, failed:[]}` で card_tags 4000 行 INSERT (server side `handleTagOptionIds` が DELETE then INSERT 走らせる)。

### Step 5: client mirror (Dexie) への反映確認

bulk POST は server-side のみ書く。 client mirror (Dexie) は別途 pull で同期される (`lib/sync/pull.ts`)。 投入後の操作:

1. browser reload (`mcp__playwright__browser_navigate` で `/app` reload) → pull 自動発火
2. `mcp__playwright__browser_evaluate` で IDB 直問:
   ```js
   const db = await new Promise((r) => { const o = indexedDB.open('recallmint'); o.onsuccess = () => r(o.result); });
   const counts = {};
   for (const store of ['cards', 'tag_categories', 'tag_options', 'card_tags']) {
     counts[store] = await db.transaction(store).objectStore(store).count();
   }
   ```
3. 期待: `cards >= 2000` (+ 既存 35)、 `tag_categories >= 10`、 `tag_options >= 100`、 `card_tags >= 4000` (= ちょうど 4000、 既存ゼロが前提)

pull が遅延する場合は明示的に `/api/pull?since=0` を fetch して即時同期。

---

## 5. 計測 (T-B1 本体、 seed 完了直後に実行)

`docs/superpowers/sessions/2026-06-12-y2-tags-perf-investigation.md` (plan B T-B1 定義の path) に投入結果 + 計測値を記録。 計測項目:

- (a) server roundtrip: `mcp__playwright__browser_network_requests` で `/app/tags` SSR navigation 経路 Network waterfall、 server response time
- (b) Dexie 初回 fetch: Performance trace で useLiveQuery 経路の time-to-first-render
- (c) SSR rendering: TTFB → FCP → LCP の差分、 Lighthouse 同 page 3 回平均

比較対象 = `/app/exams` (同等 RSC + Dexie useLiveQuery、 ただし category-list の N+1 構造なし)。

---

## 6. cleanup 手順 (計測完了後、 stg test data 残置禁止)

**逆順 (FK cascade に依存)**:

1. UI で `/app/exams` → `seed-y2-b1-tags-perf-2026-06-12` exam の「削除」 ボタン → 確認 → cards 2000 件 + card_tags 4000 行 cascade 削除 (DB FK + entity_mutation delete)
2. UI で `/app/tags` → `Y2B1-cat-*` 10 件を 1 件ずつ「削除」 (tag_options 100 件 + 残 card_tags cascade)
3. step 1+2 を Playwright で自動化する場合: bulk POST `op='delete'` で `tag_category` / `card` entity を順次 (delete cascade は server-side で完結、 mutation 数は 10 + 2000 = 2010、 1000/batch で 3 POST)
4. 確認: `db.cards`, `db.tag_categories`, `db.tag_options`, `db.card_tags` の `Y2B1-` 含む / `seed-y2-b1-` 含む行が全 0 件 + UI 上で 0 件

---

## 7. acceptance / stop checkpoint

- seed 完了報告: `{exam_id, total_inserted: {cards, tag_categories, tag_options, card_tags}, wall_clock_per_batch_ms[]}`
- 計測完了後: T-B1 plan の完了条件 (= 切り分け結果 + fix 提案 (i)/(ii)/(iii)) を満たした session log を OT review
- cleanup 完了確認 → Sub-plan B 残り task の ordering を OT 判断

実行可否は **本 runbook を OT 確認 → CC が Playwright 駆動** で進める。 投入そのものは破壊的でないが test data 量が多いため OT 承認待ち。

---

## 8. 未確定 detail (OT or 着手時に確定)

- tag_category / tag_option の `color` field default 値 (`'blue'` で仮置き、 envelope `tagCategoryCreatePatchSchema` / `tagOptionCreatePatchSchema` で許可 enum 確認 — 違反なら mutation failed で即発見可)
- `/api/pull` の query / response shape (Step 5 確認用、 違いがあれば `mcp__playwright__browser_network_requests` から actual request 観測で吸収)
- exam UI の確認 dialog 経由削除が UI flow に依存するため、 cleanup 自動化は bulk POST `op='delete'` の方が確実
