# Y-2 Sub-plan B T-B5 stg smoke (2026-06-14)

T-B5 (= `feat(perf) inline-card-list card_tags 全 scan → anyOf(pageCardIds)`、 commit `5db89d6`、 [reviewed]) の stg deploy 反映後 smoke。 OT 指示「描画 pill 集合不変 = T-B5 正当性の核を突く」 + 「実機 mobile / 決済 / 破壊操作禁止」。

- **計測日時**: 2026-06-14
- **stg**: stg.recallmint.nekotest.net (deploy SHA = origin/develop HEAD = `8871e10`、 deployment ID `dpl_BvTH74p9YRQJoxTQs7btZXTUzGHh`)
- **計測 user**: `komail9server+clerk_test@gmail.com` (Clerk dev key 環境の test account、 OT 本アカウントには波及しない)
- **計測手段**: Playwright MCP + 既存 stg signed-in session + raw IndexedDB API + bulk POST `/api/entity-mutations/bulk`
- **本番 stg DB 'recallmint'**: 多 exam fixture を test user に投入 (= 製品 user の信頼性 < テスト test user の通常状態、 OT 指示で許容範囲)。 cleanup は smoke 完了報告で OT 判断

---

## 1. deploy 同期確認

| 項目 | 値 |
|---|---|
| origin/develop HEAD | `8871e10` (push 済) |
| local develop HEAD | `8871e10` (同期確認) |
| Vercel deployment ID | `dpl_BvTH74p9YRQJoxTQs7btZXTUzGHh` |
| chunk 検査経路 | `_next/static/chunks/3nrksxzt4dr57.js` (exam detail bundle) |

検査方法: navigate `/app/exams/[id]` → bundle fetch → 新 code path の構造的 fingerprint で deploy SHA を確認 (Vercel 側 SHA exposing 経路なし、 公開 build env からの直接抽出も不可)。

bundle 内 fingerprint (minified、 関数識別子は最小化されるが構造は保存):

```
[t,a,n]=await Promise.all([
  e.cards.where("exam_id").equals(s).toArray(),
  e.tag_categories.toArray(),
  e.tag_options.toArray()
]),
i=t.filter(e=>e.user_id===u).sort(ec),
l=i.map(eo),
o=i.map(e=>e.id),
c=0===o.length?[]:await e.card_tags.where("card_id").anyOf(o).toArray(),
d=new Map;
for(let e of c){let t=d.get(e.card_id)??[];t.push(e),d.set(e.card_id,t)}
return{cards:l,categories:a,options:n,tagsByCardId:d}
```

= T-B5 commit `5db89d6` の正確な実装。 旧コード (toArray 4 stores Promise.all) は含まれず。 **deploy 反映確定**。

---

## 2. seed (multi-exam fixture)

bulk POST `/api/entity-mutations/bulk` × 1 で 14 mutations (4 card create + 10 update_field tag_option_ids) 投入、 server pull 後 client mirror に反映確認。

### 2.1 投入 mutations

| 種別 | 件数 | 内訳 |
|---|---|---|
| card create | 4 | 新 exam (`565e71dc-...`) に `seed-t-b5-smoke c1-c4` |
| update_field (target exam) | 6 | 既存 6 cards に tag_option_ids 設定 (1-3 tag/card) |
| update_field (other exam) | 4 | 新 4 cards に tag_option_ids 設定 (1-3 tag/card) |

bulk response: `{ok: true, applied: 14, failed: []}`。

### 2.2 client mirror 反映 (8 秒 wait 後)

| store | 件数 | 内訳 |
|---|---|---|
| exams | 2 | target (73008426...) + 新 (565e71dc...) |
| cards | 10 | target 6 + 新 4 |
| card_tags | 20 | target 11 + 他 exam 9 + orphan 0 |
| tag_categories | 3 (既存) | シングル / nagai / 1あ |
| tag_options | 10 (既存) | 全 reuse、 新規 create なし |

### 2.3 target exam の各 card に seed した pill 集合 (期待値)

| card | tags seed |
|---|---|
| 問109 (cd14be7b) | nagai: aaaa... (1) |
| 問110 (74c2c1f8) | 1あ: 2, nagai: aaaa... (2) |
| 問111 (e96fdbcb) | シングル: 2, 1あ: 2 (2) |
| 問112 (c3395c35) | シングル: 1, 1あ: 12, nagai: みじかい (3) |
| 新規カード 5 (b15a7cae) | nagai: bbbb... (1) |
| 新規カード 6 (26c85a66) | 1あ: 1, nagai: みじかい (2) |
| **合計** | **11** |

### 2.4 他 exam (565e71dc) の card_tags (描画リーク監視対象 = 9 件)

card_id (8 桁) → tags:
- 1307731a → nagai: みじかい, nagai: aaaa
- bbb90737 → nagai: bbbb, 1あ: 1, 1あ: 12
- 1b461d21 → シングル: 1
- c8cb3c02 → nagai: aaaa, nagai: bbbb, 1あ: 2

= **9 件**。 anyOf isolation が効いていれば、 target exam 描画には 1 件も現れないはず。

---

## 3. smoke check 結果

| # | check | 期待 | 実測 | 判定 |
|---|---|---|---|---|
| **1a** | console errors (page 由来) | 0 | 0 (1 件のみ `/api/health` 404 = CC の deploy probe、 page 由来ではない) | **pass** |
| **1b** | network failed request | 0 | 0 (study-days/pull, /api/pull × 2, entity-mutations/bulk × 2、 全 200) | **pass** |
| **2a** | pill 集合 = target seed 11 件 + 他 exam pill 0 件 | rendered 11、 他 exam pill 0 | rendered 11、 他 exam pill 0 (label 一致) | **pass** |
| **2b** | IDB に他 exam card_tags 9 件存在 (= anyOf isolation の検証材料) | 9 | 9 (target 11 + other 9 + orphan 0) | **pass (前提成立)** |
| **2c** | 件数表示「カード (6 件)」 | 6 | 6 | **pass** |
| **3a** | tag remove → 即時 pill 消滅 (memoize 削除検証) | 即時 | 問109 の nagai pill click → rendered 11→10、 IDB target 11→10、 other 9 不変 | **pass** |
| **3b** | tag add → 即時 pill 追加 (memoize 削除検証) | 即時 | 問109 に 1あ: 1 追加 → rendered 10→11、 IDB target 10→11、 other 9 不変、 card_id `cd14be7b` の card_tags = [OPT_1A_1] | **pass** |
| **4a** | longtask 件数 (観測記録、 perf gate ではない) | — | 0 | 観測 OK |
| **4b** | longtask max ms | — | 0 | 観測 OK |
| **4c** | navigation TTFB / FCP / load | — | TTFB 10.9 ms / FCP 252 ms / load 292.1 ms | 観測 OK |

### 3.1 詳細 (smoke 2a — pill 集合の正当性)

target exam 描画 11 pill (DOM `button[aria-label^="タグ: "]`) と seed §2.3 完全一致:

```
[
  "タグ: nagai: aaaaaaaaaaaaaaaaaaaa"    (問109 - 期待 1/1)
  "タグ: 1あ: 2",                          (問110 - 期待 2/2)
  "タグ: nagai: aaaaaaaaaaaaaaaaaaaa",
  "タグ: シングル: 2",                     (問111 - 期待 2/2)
  "タグ: 1あ: 2",
  "タグ: シングル: 1",                     (問112 - 期待 3/3)
  "タグ: 1あ: 12",
  "タグ: nagai: みじかい",
  "タグ: nagai: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"  (新規カード 5 - 期待 1/1)
  "タグ: 1あ: 1",                          (新規カード 6 - 期待 2/2)
  "タグ: nagai: みじかい"
]
```

- 欠落 0 / 余剰 0 / 他 exam tag 混入 0
- IDB には他 exam の card_tags 9 件存在するが、 描画には**1 件も現れていない** = **anyOf isolation の正当性確認**

### 3.2 詳細 (smoke 3a/3b — 即時反映 = memoize 削除検証)

memoize 削除 (T-B5 plan policy) で「pill 操作後に描画が古いまま」 という stale 失敗が起きないことの検証:

- **remove**: 問109 nagai pill × click
   - rendered 11 → 10
   - IDB cd14be7b card_tags: [nagai:aaaa] → []
   - other exam card_tags: 9 → 9 (不変)
   - 即時 (500ms wait で確認)
- **add**: 問109 popover 経由 1あ:1 選択 → close
   - rendered 10 → 11
   - IDB cd14be7b card_tags: [] → [OPT_1A_1 (78669d30-...)]
   - other exam card_tags: 9 → 9 (不変)
   - 即時 (600ms wait で確認)

両操作で other exam の IDB row は変化なし = **anyOf 経路下でも mutation flow が正しく target exam の subset にのみ書き込む** ことを確認。 memoize 削除による stale 失敗なし。

### 3.3 詳細 (smoke 4 — 観測記録、 perf gate ではない)

- longtask 0 件 = main thread 50 ms+ block なし
- FCP 252 ms / load 292 ms = exam detail page の体感即時域
- これは **現実 seed scale (10 cards / 20 card_tags = scenario A 域)** での実測。 perf 正本は step0-redo §3 (anyOf 4.04 ms mean at 200 tags) で取得済、 本観測は smoke 副産物 = 「実機で longtask が出ていないこと」 の sanity 確認に留める

---

## 4. seed 残置状態 (smoke 後の test user データ)

cleanup 未実施 (OT 判断待ち)。 test user `komail9server+clerk_test@gmail.com` 上の現状:

| store | 件数 | 内容 |
|---|---|---|
| exams | 2 | (i) 既存 `73008426-...` 「アップロード 2026-06-06 13:45」、 (ii) 新規 `565e71dc-...` 「seed-t-b5-smoke-2026-06-14 別 exam」 |
| cards | 10 | 既存 6 (target) + 新 4 (other) |
| card_tags | 20 | target 11 (smoke 3 で 1 remove → 1 add した cd14be7b は OPT_1A_1 に置換、 残 10 件は seed のまま) + other 9 (不変) |
| tag_categories | 3 | 既存のみ (新規 create なし) |
| tag_options | 10 | 既存のみ (新規 create なし) |

新規 exam `565e71dc-245d-4407-912d-260e87559c76` は **smoke 専用の seed**、 prefix なし (UI 上の name `seed-t-b5-smoke-2026-06-14 別 exam` で識別可能)。

### 4.1 cleanup 経路 (OT 指示時に CC が実行可能)

T-B1 runbook §6 と同形:
1. UI で `/app/exams` → `seed-t-b5-smoke-2026-06-14 別 exam` 削除ボタン → cascade で cards 4 + card_tags 9 削除
2. target exam 側 card_tags 11 件は UI 上 1 件ずつ pill × click で削除可能 (もしくは bulk POST `op='update_field'` で空配列に reset)
3. tombstone 反映確認 (`/api/pull` 1 回実走で次 pull 0 件確認)

または:
- `bulk POST op='delete'` で entity (exam / card) を一括削除、 server cascade で関連 card_tags 自動削除

### 4.2 cleanup しない場合の影響

- test user は OT 本アカウントと別、 製品 user データには波及しない
- 次回 smoke は seed 残置状態で開始 (= 多 exam scale から始まる)、 計測 baseline が異なる
- T-B5 fetch path の構造的検証は今回 close 済のため、 残置でも CC 検証フローに支障なし

---

## 5. 判定

| 観点 | 結果 |
|---|---|
| deploy 同期 | ✓ |
| pill 集合不変 (T-B5 正当性の核) | ✓ (11/11、 他 exam pill 0 件) |
| 更新即時反映 (memoize 削除検証) | ✓ (add/remove 両方) |
| anyOf isolation (他 exam IDB row が描画に leak しない) | ✓ |
| console / network error | ✓ (0 件) |
| longtask / 体感 | ✓ (longtask 0、 FCP 252 ms) |

**CC 環境で実行可能な smoke は全 pass**。 不一致 / error / 更新非反映なし。 stop 条件 (実装 regression 疑い) は発火せず。

---

## 6. 添付情報

- smoke session URL: `https://stg.recallmint.nekotest.net/app/exams/73008426-e91a-4566-9801-4530c92b7196`
- T-B5 実装 commit: `5db89d6` (`feat(perf): T-B5 inline-card-list card_tags 全 scan → anyOf(pageCardIds)` + `[reviewed]`)
- 関連 docs:
   - Step 0 micro-bench: `docs/superpowers/sessions/2026-06-14-y2-t-b5-step0.md` (commit `4d95494`)
   - Step 0 再調査 + close: `docs/superpowers/sessions/2026-06-14-y2-t-b5-step0-redo.md` (commit `8d4935e`)
   - plan 完了条件改訂: `e8c678d` + `9f4b2d7`
   - T-B5b 起票: `8871e10`

[[reference-stg]] / [[project-y2-subplan-b-t-b1p-handoff]] を参照。
