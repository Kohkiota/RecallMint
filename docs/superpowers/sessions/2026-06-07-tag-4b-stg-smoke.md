# Tag-4b stg smoke 結果 (2026-06-07)

deploy: `c2336be` (feat Tag-4b 試験詳細 page card にタグ section 追加) を含む 17 commits 反映済 stg。 Claude Code が Playwright MCP + DevTools (IndexedDB evaluate) で実行、 観測のみ。

Tag-4b の核心:
- **Tag-2c handler (`field='tag_option_ids'` whole-set replace) を UI から初呼出**
- **案 a の取り直し (`cards.updated_at` bump → pull) を UI 経由で初観測**

Tag-2 smoke の B.3 (全外し `[A,B]→[]` の正しい同期) が fetch 直送で確認した経路を、 UI 操作で再現できることを実観測。

## 結論

**Tag-4b stg smoke 全 PASS (機能観点)**。 Tag-2c handler の UI 経由初呼出、 案 a の取り直し UI 経由初観測、 whole-set 不変条件、 single 最大 1 個 + 0 個許容、 multi 併存、 optimistic 即反映、 全て確認。

## 観点別結果

| # | 観点 | 結果 | 実観測根拠 |
|---|------|---|---|
| A.1 | タグ section 表示 (タイトル下 + タグ管理 link) | ✅ | 各 card に「タグ」 h3 + 「タグ管理 →」 link |
| A.2 | カテゴリ別 group + 型アイコン (CheckSquare/Circle) | ✅ | 各カテゴリ見出し横に lucide icon + 「+ 追加」 button |
| B.1 | multi 付与 (smoke-cat-renamed / opt-renamed) | ✅ | 即 IDB card_tags 1 件 put + UI pill 即表示 |
| B.2 | multi 併存 (b10-ok-1 追加) | ✅ | IDB 2 件、 multi で両方 pill 表示 |
| B.3 | pill × 削除 (opt-renamed) | ✅ | 即 IDB delete + UI pill 即消滅 |
| **B.6** | **whole-set payload** | ✅ | POST body: `entity_type='card' / op='update_field' / patch.field='tag_option_ids' / patch.value=[opt-renamed-id, b10-ok-1-id]` (全 option_ids whole-set) |
| C.7 | single 付与 (asksdfsd / aka) | ✅ | 即 pill 表示 |
| C.8 | single radio 的置換 (aka → まちがえた) | ✅ | aka 即外れ + まちがえた 即表示 |
| **C.9** | **single 0 個許容** (同 option 再 click) | ✅ | まちがえた 再 click → 即 0 個 (最大 1 個、 0 個許容) |
| **D** | **whole-set 不変条件** (他カテゴリ落とし回避) | ✅ | C.7-C.9 全期間、 multi b10-ok-1 維持。 single asksdfsd 操作で他カテゴリのタグは落ちない |
| **E.13** | **全外し → reload → IDB 0 件** (Tag-2 B.3 UI 経由再現) | ✅ | 全 pill 外し → reload (pull) → IDB 該当 card_tags 0 件 |
| **E.14** | **cards.updated_at bump** (案 a 起点) | ✅ | 操作前 `06-05T14:49` → 1 回目 reload で `06-07T15:04:52` → 2 回目 reload で `06-07T15:06:17` と単調進む |
| H.17 | console error / 全 API 200 | ⚠️ | console error 2 件は Clerk dev domain DNS = Tag-4b 無関係。 全 /api/* 200 |
| H.18 | entity_mutations pending 残らず | ✅ | pending=0 / syncing=0 / failed=0 |
| H 既存 regression | 試験詳細 card 編集 (Tag-2a 経路) | ✅ | fetch 直送 title 編集 → applied:1 |

## 核心検証

### Tag-2c handler の UI 経由初呼出 (B.6)

Tag-2 smoke では fetch 直送のみで確認していた Tag-2c handler (`field='tag_option_ids'` whole-set replace) が、 Tag-4b で UI dropdown click 経由で初呼出。 POST payload で whole-set 経路を実観測:

```json
{
  "mutation_id": "2c5d503e-0e98-47ad-a256-0f3b2a96f7ae",
  "entity_type": "card",
  "entity_id": "96583613-...",
  "op": "update_field",
  "patch": {
    "field": "tag_option_ids",
    "value": ["3c6531fb-... (opt-renamed)", "84108fdb-... (b10-ok-1)"]
  },
  "edited_at": "2026-06-07T14:58:39.871Z"
}
```

= card 全カテゴリ横断の whole-set が送信されている。 「他カテゴリのタグを誤って落とさない」 不変条件 (D 観点) も同 payload から確認可能。

### 案 a の取り直し UI 経由初観測 (E.13, E.14)

**Before (Tag-2 smoke)**: fetch 直送で確認していた「[A,B]→[]」 ケース (案 a の核心 = 全外し空集合化)

**After (Tag-4b smoke)**: UI で pill 全外し → reload → pull → IDB card_tags 0 件

具体経路:
1. UI で pill × click → optimistic `db.card_tags.delete([cardId, optId])` + enqueue (whole-set=[])
2. server Tag-2c handler applied → card_tags 全 DELETE + INSERT 0 + cards.update().set({updated_at: now()})
3. reload → cards 増分 pull で変更カード集合 = [cardId] 検知
4. IDB の該当 card_tags 全削除 → server stream 取り直し (= 0 件) → bulkPut
5. **結果: IDB 該当 card_tags 0 件** (server 真実と一致)

cards.updated_at の単調進行 (3 回 bump 確認: `06-05T14:49` → `06-07T15:04:52` → `06-07T15:06:17`) は案 a 取り直しの起点が正しく動作している証拠。

### whole-set 不変条件 (D 観点)

C.7〜C.9 の全期間中、 multi カテゴリ smoke-cat-renamed の b10-ok-1 が維持されたことで、 「single asksdfsd の操作で multi カテゴリのタグが誤って落ちる」 事故が起きていないことを実観測。 plan の最重要要求 (他カテゴリ落とし回避) が正しく動作。

### single 「最大 1 個・0 個許容」 (C 観点)

- C.7 aka 付与 → 1 個
- C.8 まちがえた 選択 → aka 自動外し + まちがえた 表示 (radio 的置換)
- C.9 まちがえた 再 click → 0 個 (= 最大 1 個、 0 個許容)

これら 3 段の挙動が連続で確認できる UI = OT 確定設計 (Tag-4b spec §3) の挙動と一致。

## 設計判断の検証 OK

- ✅ **parent 一括 subscribe**: per-card useLiveQuery 回避、 4 store を 1 useLiveQuery で取得
- ✅ **optimistic 即反映**: Tag-4a-fix 型紙踏襲 (IDB put/delete → enqueue 並列)
- ✅ **whole-set 構築**: card 全カテゴリ横断、 自カテゴリ差分のみ適用、 他カテゴリ落とさない
- ✅ **lucide icon button**: Plus / CheckSquare / Circle、 既存 deps
- ✅ **shadcn DropdownMenu**: multi/single 切替挙動
- ✅ **案 a 取り直し**: cards.updated_at bump → 変更カード集合の card_tags 取り直し (UI 経由で初観測)

## stg 残存変更 (cleanup)

- 問110 card (`96583613-...`) の card_tags は smoke 内で 0 件に戻した (兼 cleanup)
- card `030c1b55-...` の title は「Tag-4b-regression」 (H.18 regression test 用、 Tag-4c smoke で続行可)
- Smoke分野 + Smoke-B + その他カテゴリ/option は維持 (Tag-3 / Tag-4c smoke 用)

## 実行環境

- URL: stg.recallmint.nekotest.net
- Clerk test mode `+clerk_test` アカウント
- 対象 exam: `Sync1 Smoke Exam` (id=08ec7835-db67-4e45-b402-db776ba93048)
- 対象 card: 問110 (id=96583613-8670-4d1c-9769-3e64d66e38b4)、 030c1b55-... (regression 用)

## 参照

- spec: `docs/superpowers/specs/2026-06-07-tag-4b-card-tags-section-design.md`
- plan: `docs/superpowers/plans/2026-06-07-tag-4b-card-tags-section.md`
- smoke checklist: `docs/superpowers/plans/2026-06-07-tag-4b-smoke-checklist.md`
- 案 a 設計判断: `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` §4
- Tag-2 smoke (B.3 fetch 直送経路): `docs/superpowers/sessions/2026-06-07-tag-2-stg-smoke.md`
- commits: `2d1bcc8` (spec) / `9df031d` (plan) / `c2336be` (feat Tag-4b)
