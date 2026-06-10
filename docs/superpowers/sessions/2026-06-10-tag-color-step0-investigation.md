# Tag-color Step 0 ファクト調査レポート

date: 2026-06-10
scope: 調査のみ (実装・commit なし)。 新 palette を当てる前提で「現状どう定義・保存・描画されているか」 の事実確認。
result: 描画ロジックは `colorToClass()` 1 関数に中央集約 / 既存値は UI 経由なら 12 色名 + null / **color 更新経路に H3 由来の二重実装 (Sync-fix-1 収束対象) が存在**。

---

## 1. palette の定義場所

ファイル: `lib/tags/color-palette.ts` (全 54 行、 単一ファイルで完結)

### 定義の中身 (lines 10-44)

- `TAG_COLOR_NAMES` (lines 10-23): 12 色 const tuple
  ```
  red, orange, amber, yellow, lime, green, emerald, teal, cyan, blue, violet, pink
  ```
- `COLOR_TO_CLASS: Record<TagColorName, string>` (lines 28-41): 各 value は
  `'bg-{name}-100 text-{name}-800 border-{name}-200'` の **固定文字列 1 本** (bg + text + border 3 utility 同居)。
  動的構成 `` `bg-${color}-100` `` は Tailwind v4 の static purge で消えるため、 12×3=36 utility を value に静的に埋め込む設計。
- `COLOR_NULL_CLASS = 'bg-slate-100 text-slate-700 border-slate-200'` (line 44): 「色なし」 fallback (neutral grey)。
- `colorToClass(color: string | null | undefined): string` (lines 48-53): 不明色 / null / undefined は `COLOR_NULL_CLASS` に safe fallback (palette 削除後の遺物色対策)。

### palette の選び方

色名のみ DB に保存し、 表示時に class へ解決する設計のため、 「palette 名を増やす = `TAG_COLOR_NAMES` + `COLOR_TO_CLASS` に項目追加で完結、 DB migration 不要」 とコメントに明記 (lines 1-3)。

### 刷新時の影響範囲

- palette 命名そのものの変更 (red → coral 等) は **このファイル + consumer 7 site の入力値変換** が必要。
- 「bg/fg/border 1 文字列」 → 「bg/fg 2 token」 構造変更は **`colorToClass()` の return 型変更 = consumer 7 site の className 合成式変更**。
- 8 文字列 (= 1 ファイル) で API 中央集約されているため、 設計判断は局所で済む (差分の範囲は次節 #4 参照)。

### red flag

- なし (palette 定義そのものは 1 ファイル / 1 helper で清浄)。

---

## 2. color 値の保存形式

### DB (`lib/db/schema.ts`)

- `tag_categories.color` (line 677): `text('color')` nullable。 CHECK 制約・enum なし。
- `tag_options.color` (line 710): `text('color')` nullable。 同上。

### Server mutation バリデーション (`lib/tags/apply-tag-mutation.ts`)

- `applyTagCategoryUpdate` case 'color' (lines 82-87): `patch.value` が `null` or `string` 型なら受理。 **TAG_COLOR_NAMES との照合なし**。 文字列ならどんな値でも書ける。
- `applyTagOptionUpdate` case 'color' (lines 252-257): 同上。 型 check のみ。
- `applyTagCategoryCreate` (line 52) / `applyTagOptionCreate` (line 202): `patch.color ?? null` をそのまま INSERT。 同様に値検証なし。

### IDB mirror (`lib/client-db.ts`)

- `ClientTagCategory.color?: string | null` (line 167)
- `ClientTagOption.color?: string | null` (line 178)

### Pull mapper (server → client) — 変換なし

- `lib/db/tag-categories-pull.ts:26` → `color: row.color`
- `lib/db/tag-options-pull.ts:25` → `color: row.color`

正規化・サニタイズなし、 DB raw 値がそのまま IDB に乗る。

### UI 経由の書込値の集合

- 書込 trigger は **`ColorPalettePopover` 1 経路のみ** (`onChange: (color: TagColorName | null) => void`)。 TS 型上は 12 文字列 + null に閉じている。
- option / category の create 時の初期値は **`color: null` 固定** (`card-tags-section.tsx:373`, `:459`)。
- 結論: **UI 経由で DB に入る値は `TAG_COLOR_NAMES` の 12 文字列 + null のみ**。 hex / 自由文字列を書く経路は確認できず。

### DB と IDB の同期

mapper は無変換スルーのため一致。 UI 経由なら両方とも palette 内に閉じる。

### 本番 DB の実際の値の集合 (確認未実施)

`SELECT DISTINCT color FROM tag_categories WHERE color IS NOT NULL` 等は **本調査では未実行**。 「UI 経由なら遺物なし」 は code 上の推論であり、 旧 schema / migration / 手動 SQL の遺物が混在していないことは裏取り 1 発で確定可能。

### 刷新時の影響範囲

- (a) DB migration **不要**: column shape は text nullable のまま再利用可能。
- (b) Client 変換のみで完結可能 (palette 名そのまま再利用なら無変換、 改名なら旧 → 新マッピング helper 1 関数で済む)。
- (c) Server バリデーションを「TAG_COLOR_NAMES のみ受理」 に絞るかは別議論 (現状は string なら何でも受け入れる)。 palette 刷新と同時にやるかは設計判断。

### red flag

- **中**: 本番 DB の実値集合は未確認。 「UI 経由なら 12 + null」 と推論しているが、 手動 SQL / migration 経路の遺物が無いことは本番 `SELECT DISTINCT color` で要裏取り。

---

## 3. bg/fg・文字色の現状

### 構造

- 「bg と fg が別 token」 ではなく、 **`bg-{name}-100 text-{name}-800 border-{name}-200` を 1 文字列に連結した「3 utility 同居」 形** (`color-palette.ts:28-41`)。
- 文字色は **color name から固定派生** (常に `text-{name}-800`)。 contrast 計算なし、 動的算出なし、 ハードコードなし (全 12 色で 100/800/200 段差を統一)。
- 「色なし」 (null / 未知) は **neutral grey** (`bg-slate-100 text-slate-700 border-slate-200`)。

### bg/fg ペア化したい場合

現状 1 文字列に bg/text/border を embed しているため、 「bg と fg を別 token として独立に出す」 には:

- `colorToClass()` の return 型を `string` から `{ bg: string, fg: string, border?: string }` 等に変える、 または
- 別 helper `colorToBgClass()` / `colorToFgClass()` を増やす

のどちらか。 7 consumer site の className 組み立てが影響を受ける。

### red flag

- なし (構造変更は局所 helper の問題で、 思想が決まれば作業は単純)。

---

## 4. バッジ描画コンポーネントと適用箇所

### 中央集約点

**`colorToClass()` 1 関数のみ**が共有。 「バッジ component 本体」 (色 + テキスト + a11y を内包する単一 React component) は **存在しない**。 各 site が「pill 形状の `<button>` or `<span>` + `colorToClass()` 文字列を className に流し込む」 という JSX をコピーしている。

### consumer 7 site (palette 定義ファイル除く)

| # | File | 該当行 | 用途 / 形状 |
|---|---|---|---|
| 1 | `app/(app)/app/tags/_components/color-palette-popover.tsx` | 61, 77 | 色 picker grid cell (28×28 px、 4 cols × 4 rows = 12 色 + 1 null) |
| 2 | `app/(app)/app/tags/_components/category-row.tsx` | 218 | manager: category 行 swatch (5×5 円形、 H7b で常時表示化) |
| 3 | `app/(app)/app/tags/_components/option-row.tsx` | 248 | manager: option 行 swatch (5×5 円形) |
| 4 | `app/(app)/app/tags/_components/option-create-form.tsx` | 132 | manager: 新規 option 作成フォームの色 pill |
| 5 | `app/(app)/app/exams/[id]/_components/card-tag-badge.tsx` | 68 | **試験詳細: 付与済みバッジ** (rounded-full pill、 forwardRef wrapped、 Notion 風) |
| 6 | `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` | 370 | popover 内 option list の色 pill (rounded-md、 break-all) |
| 7 | `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx` | 181 | popover edit-mode の色 pill |

7 site で「pill JSX」 を別実装。 形状の差 (rounded-full vs rounded-md、 border の有無、 padding、 hover scale 等) は各 site で独自。

### 同一バッジ component を共有しているか

**否**。 「`<CardTagBadge />` を manager でも popover でも再利用」 という構造になっていない。 各 site が `<button>` or `<span>` を自前で書き、 `colorToClass()` だけ共有。

### color → 見た目への変換ロジックの集約度

`colorToClass()` 1 関数のみ。 入力 (`color: string | null | undefined`) → 出力 (Tailwind class 文字列) の写像はここで完結。 hex 計算 / contrast 判定等のロジックは存在しない。

### 刷新時の影響範囲

- 「palette 名のみ変更 (return 型は string 維持)」: `colorToClass()` 内部 + 同じ class 段差 (100/800/200) を新 token に置換するだけ → consumer 7 site は **無変更**。
- 「bg/fg を独立 token に分離 (return 型を object 化 or helper 増設)」: consumer 7 site すべて touch (className 合成式が変わる)。
- 「バッジ JSX を `<TagBadge />` 共有 component に寄せる」 は palette 刷新と直交する別 refactor (scope 外)。

### red flag

- **中**: 描画ロジックは 1 関数集約だが、 「pill JSX」 が 7 site にコピー散在。 palette 刷新が return 型変更を伴う場合、 7 file touch が必要 (= repo-wide ではないが「一発置換」 でもない)。 OT が新 palette の API shape を確定した時点で「7 site touch」 で済むか「pill JSX 共有 component 化」 まで足すかを decide。

---

## 5. 既存 color 値の移行

### (a) DB migration が要るか

**不要**。 column は `text` nullable のまま使える。 新 palette が hex でも token 名でも同 column に入る。

### (b) Client 側変換で済むか

**済む**。 現状 UI 経由の値が 12 文字列 + null に閉じているため (item 2 参照):

- 新 palette が 12 色名を**再利用** (red / orange / ...): 既存 row の値はそのまま新 palette にバインドされ、 **マッピング不要**。
- 新 palette で**改名** (red → coral 等): `colorToClass()` 内に旧 → 新 alias マップを足す 1 helper で完結。 「旧名は COLOR_NULL_CLASS に fallback」 で feature flag 的に切替える選択もあり。

### (c) マッピングの判断材料

- 現状 IDB / DB に入っている値の集合 = `TAG_COLOR_NAMES` の 12 文字列 + null (UI 経由のみ書込なら確定。 本番 `SELECT DISTINCT color` で裏取り推奨)。
- 旧 schema / migration / 手動 SQL の遺物は code 上は確認できず (palette 導入は git log 上 `a26ecd5 feat(tag): Tag-4a タグ管理 page (/app/tags) [no-review]` が初出、 それ以前は color column が UI から書かれていなかった)。

### red flag

- **低**: マッピング判断は「12 色名再利用 or 改名」 の OT 設計判断で決まる。 「自由入力 hex の遺物への対応」 は本番 `SELECT DISTINCT color` 1 発で消せる前提。

---

## 6. color 更新が optimistic 経路に触るか (**最重要 red flag**)

### 結論

**触る。 しかも同一 mutation を 2 つの異なる shape で発行する二重実装が存在**。

### 経路 A: manager (H3 で追加)

| File | 関数 | 行 |
|---|---|---|
| `app/(app)/app/tags/_components/category-row.tsx` | `enqueueUpdate(field, value)` | 83-121 |
| `app/(app)/app/tags/_components/option-row.tsx` | `enqueueUpdate(field, value)` | 115-158 |

shape:

```ts
void getClientDb().tag_categories.update(id, mirrorPatch).catch((err) => logger.warn(...))
void enqueueEntityMutation({...}).catch((err) => logger.warn(...))
debounceTimerRef = setTimeout(() => runGuardedEntityMutationFlush(), 500)
```

特性:

- **非 atomic**。 mirror update / enqueue が **`void` で並列発行**、 個別に catch して warn。
- **revert ロジックなし**。 enqueue が throw しても mirror は更新済みのまま残る (逆も同様)。
- 500ms debounced flush (連続編集の drain 圧縮)。
- color / name / category_id の 3 field 共通経路 (option-row のみ category_id 対応)。

### 経路 B: 試験詳細 popover

| File | 関数 | 行 |
|---|---|---|
| `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` | `handleSetCategoryColor` | 145-170 |
| `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` | `handleSetOptionColor` | 210-234 |

shape:

```ts
const before = await db.tag_categories.get(id)
if (beforeColor === color) return // no-op
try {
  await db.tag_categories.update(id, { color, updated_at: now })
  await enqueueEntityMutation({...})
} catch (err) {
  await db.tag_categories.update(id, { color: beforeColor, updated_at: before.updated_at })
  throw err
}
void runGuardedEntityMutationFlush().catch(() => {})
```

特性:

- **sequential await** (mirror update → enqueue)。
- **手動 revert** (enqueue throw で mirror を before 値に書き戻す)。
- no-op 短絡 (`beforeColor === color`)。
- toggle 経路 (`db.transaction('rw', ...)`) と違い **同一 Dexie tx には包んでいない** (single-store 想定)。

### 共通点

両経路とも server 受信時は同一 mutation:

```
entity_type: 'tag_category' | 'tag_option'
op: 'update_field'
patch: { field: 'color', value: TagColorName | null }
```

→ 差分は **client 側の atomicity 保証のみ**。

### Sync-fix-1 との関係 (red flag 高)

`card-tags-section.tsx` の toggle 経路コメント (lines 632-634) に既に言及:

> 「他 8 ファイル経路は別 sprint『Sync-fix-1』 で共有 helper に収束予定、 本 component が reference 実装」

つまり経路 A (manager の `enqueueUpdate`) は **Sync-fix-1 の収束ターゲット**に既に入っている公算が高い。 経路 B (popover) は reference 実装。

### red flag

- **高**: Tag-color 単独で「描画 (colorToClass) だけ刷新」 して済ませる場合、 経路 A / B の atomic 差は palette 刷新と直交し問題なし。 ただし、 palette 刷新と同時に「経路 A を atomic 化 = Sync-fix-1 の一部を先取り」 する判断が要るなら、 **Sync-fix-1 との sprint 統合 / 順序を OT が decide すべき**。

---

## 全体 red flag 評価

| 項目 | level | 内容 |
|---|---|---|
| 1 palette 定義 | 低 | 1 ファイル / 1 helper で清浄 |
| 2 保存形式 | 中 | UI 経由なら集合は閉じる前提だが、 本番 `SELECT DISTINCT color` の裏取り 1 発推奨 |
| 3 bg/fg / 文字色 | 低 | 構造変更は局所 helper の return 型問題 |
| 4 描画コンポーネント | 中 | 描画 helper は中央集約だが pill JSX が 7 site にコピー散在。 return 型変更で 7 file touch |
| 5 既存値の移行 | 低 | DB migration 不要、 client 変換のみで可能 (旧 12 色名再利用なら無変換) |
| 6 optimistic 経路 | **高** | manager (H3) = void 並列、 popover = sequential + 手動 revert の二重実装。 Sync-fix-1 と sprint 重複判断要 |

---

## 次の判断材料

1. Tag-color の scope: 描画 (colorToClass / 7 site) のみに閉じるか / manager 経路の atomic 化も含めるか
2. 新 palette token 名: 12 色名再利用 (DB 無変換) か / 改名 (旧 → 新 マッピング設計) か
3. 本番 DB の `SELECT DISTINCT color` 確認の要否
