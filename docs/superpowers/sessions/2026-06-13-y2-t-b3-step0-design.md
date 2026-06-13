# Y-2 Sub-plan B / T-B3 Step 0 — 現物調査 + 設計提示 (OT 判断反映済、 実装着手可)

- **作成日**: 2026-06-13
- **更新**: 2026-06-13 (OT 判断 4 件反映、 §4 を判断結果に書き換え、 §1.2 / §3.2 / §5.2 / §6 を **4 件 cascade-like 前提**に同期 — drift 防止)
- **位置づけ**: T-B3 (#1b per-mutation tx 順序保証付き選択並列化、 Y-2 最大リスク) の実装着手前 stop checkpoint (plan B 全体ルール 6) → **OT 判断受領済**、 実装着手可。
- **plan**: `docs/superpowers/plans/2026-06-12-y2-launch-hardening-B-perf.md` T-B3
- **spec**: `docs/superpowers/specs/2026-06-12-y2-launch-hardening-design.md` §3.2 (順序保証契約 = 正本)
- **直前完了**: T-B2 (#1a study_days SQL N+1 解消) `8d7a6ae` 実機 smoke 3 指標 pass で クローズ

---

## 0. drift 防止の絶対則 (本 doc 最重要、 実装者必読)

OT 判断で **cascade-like = 4 件** (= `tag_category.delete` / `tag_option.delete` / `card.delete` / **`card.create`**) に確定。
本 doc / 実装 / registry test / helper test / route test / smoke session log の **全箇所が 4 件前提**で揃っている必要がある。 古い「3 件 true / 残り 6 件 false」 記述は本 doc 含めて使用禁止 (本 update で全て書き換え済)。 実装中に「3 件 cascade」 を見たら drift = 即中断 + 訂正。

registry test 期待値: **4 件 `cascadeLike: true` / 残り 5 件 `false` (or undefined)**。

---

## 1. 現状調査 (per-mutation tx 経路の実コード)

### 1.1 bulk route の現行 loop site

`app/api/entity-mutations/bulk/route.ts:194-215` — 単純 `for-of` の **逐次** await:

```ts
for (const mutation of mutations) {
  try {
    const result = await processMutation(db, user, mutation)  // L196 = 唯一の per-mutation tx call
    if (result === 'applied') applied++
    else if (result === 'failed') failed.push(mutation.mutation_id)
    // 'skipped' は applied / failed どちらにも入れない (冪等 skip)
  } catch (err) {
    // 予期せぬ throw → log + failed[] に積んで継続 (200 契約維持)
    logger.warn({...})
    failed.push(mutation.mutation_id)
  }
}
```

- 並列化対象は **L194 の for-of 1 箇所のみ**。 envelope-level 致命 error (getDb 失敗 等) を catch する外側 try は維持。
- `processMutation` は 1 mutation で 1 tx (`db.transaction(async (tx) => {...})`、 L78)。 内部で registry lookup → patch 検証 → 冪等チェック → apply → log INSERT。 戻り値 = `'applied' | 'skipped' | 'failed'`。
- response = `{ ok: true, applied, failed }`、 status 200 (envelope-level 致命のみ 503/400)。

### 1.2 registry 構成と cascade-like の実態 (OT 判断 2026-06-13 反映、 4 件)

`lib/sync/server/entity-mutation-registry.ts`: 現状 9 entries = 3 entity_type × 3 op。 OT 判断で `card.create` を安全側に倒し cascade-like 扱いとした (理由: `exams.card_count += 1` の cross-entity read-modify-write は row-level lock 整合の DB 挙動依存、 並列で確実に安全と言い切れない経路。 異 exam 混在 bulk でしか並列恩恵が出ない頻度低事象に、 推論しきれないリスクを開く理由がない)。

| entity_type | op | apply 関数 | cascade / cross-entity 副作用 | **cascadeLike** |
|---|---|---|---|---|
| card | create | `applyCardCreate` | `exams.card_count += 1` (cross-entity read-modify-write) | **true** (OT 安全側判断) |
| card | update_field | `applyCardUpdateField` → `CARD_FIELD_HANDLERS[field]` | 単一 cards UPDATE (本人 entity 内) | false |
| card | delete | `applyCardDelete` | tombstone + cards DELETE + `exams.card_count -= 1` | **true** |
| tag_category | create | `applyTagCategoryCreate` | 単一 tag_categories INSERT | false |
| tag_category | update_field | `applyTagCategoryUpdate` | 単一 tag_categories UPDATE | false |
| tag_category | delete | `applyTagCategoryDelete` | 配下 tag_options 全件 SELECT → tombstones bulk INSERT → tag_categories DELETE → FK CASCADE で tag_options / card_tags 連動消滅 | **true** |
| tag_option | create | `applyTagOptionCreate` | 親 tag_categories owner check (read-only) → tag_options INSERT | false |
| tag_option | update_field | `applyTagOptionUpdate` | 単一 tag_options UPDATE | false |
| tag_option | delete | `applyTagOptionDelete` | tombstone INSERT + tag_options DELETE → FK CASCADE で card_tags 連動消滅 | **true** |

cascade / cross-entity 副作用の整理 (cascadeLike=true の 4 件):
- **強 cascade (= 配下 entity を巻き込んで削除)**: `tag_category.delete` / `tag_option.delete`
- **cross-entity read-modify-write**: `card.create` (`+= 1`) / `card.delete` (tombstone + DELETE + `-= 1`)
- **本人 entity 内 self-contained (cascadeLike=false の 5 件)**: `card.update_field` / `tag_category.create|update_field` / `tag_option.create|update_field`

### 1.3 dependent multi-mutation の境界 (Grid-2 範疇)

spec §3.2 と plan B §5 が呼ぶ「dependent multi-mutation」 は **異なる entity key (= 異なる (entity_type, entity_id))** の mutation が論理的に同一 unit で適用される必要があるケース。 具体例:
- card create + 同 card に対する card_tags 紐付け mutation (Grid-1 で card_tags 正規化予定)
- tag_category create + 同 category 配下に tag_option create を同時実施

現状 registry には card_tags entity_type が**存在しない** (Grid-1 未着手) ので、 dependent multi-mutation 系は本 sprint scope では発生しない (= Grid-2 で初めて表面化、 spec §1.3 範囲外明示)。

---

## 2. plan B 制約と実コードの mapping

plan B T-B3 制約 (line 71-72) と実コードの突合:

| 制約 | 実コード対応 |
|---|---|
| spec §3.2 順序保証契約 (= 同一 entity key 内逐次 / 独立 key 間のみ並列) | L194 for-of の loop body を group 化 → group 間 `Promise.allSettled`、 group 内 for-of 維持 |
| entity key 境界 = 同一 `(entity_type, entity_id)` のみ の最狭定義 | group key = `${entity_type}:${entity_id}` (sortable string)、 spec §3.2 と一致 |
| cascade delete / dependent multi-mutation は entity key 境界外で逐次 fallback (Grid-2 対象) | §1.2 表で **cascadeLike=true の 4 件** (= `card.create` / `card.delete` / `tag_category.delete` / `tag_option.delete`) を「並列化対象外」 として serial 経路に倒す。 dependent multi-mutation は本 sprint では発生しない (Grid-1 未着手) |
| response mutation_id 順は維持 (入力順正規化) | 結果集約は `mutation_id → ApplyResult` の `Map` 経由、 最後に **入力順 array** で iterate して `applied++ / failed.push()` を再構築 |
| wire format / `{ ok, applied, failed }` 形不変 | response shape は変更なし。 既存 envelope zod / 503 / 400 経路もすべて維持 |

→ 制約の実装方針への 1:1 対応は確認できる。

---

## 3. 採用設計 = 案 X (= cascade detected → 全体 serial fallback、 OT 確定)

### 3.1 採用理由 (OT 判断 2026-06-13)

案 X / Y / Z のうち **案 X 採用** で確定。 決め手:
- 案 Y は cascade の先後 phase で挙動が変わり順序の正しさが phase 設計依存 = T-B2 教訓「複雑な経路ほど実機でしか確証できない」 の典型。 Y-2 最大リスク task で複雑な方を選ぶ理由なし。
- 案 X は cascade 混在時に prod 実績ある現状経路へ丸ごと戻る = 並列化の新規リスクを「非 cascade のみ」 に閉じ込める。 §5 表の R10 (cross-key race) が案 X で設計上発生しない根拠 (= 非 cascade op = entity 内 self-contained) も妥当。
- 案 Z は YAGNI で却下。

### 3.2 共通骨子

1. 新規 helper: `lib/sync/server/group-mutations-by-entity-key.ts` を作成。
   - signature: `groupMutationsByEntityKey(mutations: ParsedMutation[]): { groups: Map<string, ParsedMutation[]>; serialFallback: boolean }`
   - group key = `${entity_type}:${entity_id}` の文字列。 value = 入力順 (= 受領順) を保持した array。
   - cascade-like 判定 = registry の `cascadeLike` flag を参照、 1 件でも検出 → `serialFallback: true`。
2. bulk route の L194 loop を group 単位に分割:
   - `serialFallback: true` の時は現行 for-of 経路をそのまま使う (= 改変箇所最小、 prod 実績ある経路丸ごと再利用)。
   - `serialFallback: false` の時のみ `Array.from(groups.values()).map(async (group) => { for (const m of group) await processMutation(db, user, m) })` を `Promise.allSettled` で並列化。 group 内 for-of は **そのまま** 維持 (= 順序保証)。
3. 結果集約:
   - 並列 path: 各 group の per-mutation 結果を `mutationId → 'applied' | 'skipped' | 'failed'` の `Map<string, ApplyResult>` に投入。
   - 入力順 (= `mutations` array 順) で iterate して `applied` count と `failed[]` を再構築 → response mutation_id 順を入力順に正規化。
   - serial path: 現行 logic 通り (= for-of 中で `applied++` / `failed.push()`)。
4. 順序破壊 self-guard:
   - 同一 entity key の mutation array に対して「内部で `Promise.all` を意図的に呼ぶ違反 path」 を helper test 内に埋め込み、 invariant assert 経由で `throw new Error('ordering violated')` を expect (= plan 完了条件 3 番目 directly)。
   - 通常 path では到達しない。 設計違反の regression を絶つ。
5. envelope zod に **mutation_id 重複検出** を追加 (§4.4 OT 判断反映): 入力 array に同 mutation_id が 2 件以上あれば 400 reject (`{ error: 'duplicate_mutation_id' }`)。 並列化で初めて race 化する R7 を入口で殺す。

---

## 4. OT 判断結果 (2026-06-13、 確定)

### 4.1 採用案 = 案 X (= 全体 serial fallback)

§3.1 参照。 cascade-like 検出時は **全体 serial fallback** で現状経路を丸ごと再利用、 非 cascade のみの bulk のみ group + 並列。

### 4.2 cascadeLike flag を立てる op = 4 件 (確定)

§1.2 表参照。 `tag_category.delete` / `tag_option.delete` / `card.delete` + **`card.create`**。

- `card.create` を含めた根拠 (OT 判断): `exams.card_count += 1` は cross-entity read-modify-write、 row-level lock で silent 整合する **DB 挙動依存** の経路。 並列で確実に安全と言い切れない。 効果薄 (= card 一括作成は同一 exam_id 集中ゆえ並列恩恵が出るのは異 exam 混在時のみ、 頻度低) なのにリスクを開けるのは不整合。 安全に推論できる経路だけ並列化する本 sprint の目的に合わせ serial に倒す。
- **副次効果**: card.create 多数 bulk (OCR 典型 = 1 exam に 50+ 件一括作成) は全体 serial に倒れる。 OCR 作成は元々 user が待つ重い処理ゆえ serial の体感影響は許容。 ただし smoke で wall-clock を計測し、 将来「OCR 作成が遅い」 判断の材料として残す (§5.2 指標 4)。

### 4.3 concurrency cap = 本 sprint なし (確定、 但し pool 事前確認 + smoke 必須)

- 本 sprint で `p-limit` 等は入れない (= group 数そのまま並列)。
- 「cap なし」は「pool を実機確認しない」 の意味ではない。 **着手前に Supabase Transaction pooler の pool size を dashboard で確認して session log に記録**する (現在 memory に正確値なし)。
- §5.2 smoke 指標 2 (5 連発で pool 上限を叩く) を必須化、 connect_timeout 等が出たら即 hotfix で `p-limit` 後付け。

### 4.4 mutation_id 重複検出 = envelope zod に追加 (確定、 400 reject)

- 入力 array に同 mutation_id が 2 件以上 → 400 (`{ error: 'duplicate_mutation_id' }`、 既存 `invalid_payload` 経路を流用 or 新規 error code)。
- §5 R7 (異 group 分離 race) を入口で殺す。 並列化で初めて問題化する経路を同 sprint で塞ぐ。
- 実装位置: `payloadSchema` の `.refine` か post-parse の `Set<string>` チェック。

### 4.5 helper signature 確定

```ts
type GroupResult = {
  groups: Map<string, ParsedMutation[]>  // key = `${entity_type}:${entity_id}`
  serialFallback: boolean                 // cascade-like 検出時 true
}
function groupMutationsByEntityKey(
  mutations: ParsedMutation[],
  registry: typeof ENTITY_MUTATION_REGISTRY,
): GroupResult
```

- registry を引数で渡す (test mock しやすさ + 純関数化)。
- 戻り値の Map は `Map<string, ParsedMutation[]>` で挿入順を保証 (ES2015 仕様)。
- `serialFallback: true` の時、 caller は groups を無視して現行 for-of に戻る分岐を持つ。

---

## 5. risk 列挙 + 検出経路分類 (T-B2 教訓「driver 層は mock で確証不能」 適用)

| # | risk | 発生経路 | 検出経路 |
|---|---|---|---|
| R1 | 同一 key 並列で UPDATE 競合 → row-level lock 待ち or serializable 違反 | 設計違反 (helper bug で同一 key を別 group に振る) | **mock 検出可**: helper unit test (同一 key 入力 → 同一 group に集約 assert) + 順序破壊 regression test (= self-throw path) |
| R2 | group 内 throw → group 内残り mutation の挙動 (現実装: per-mutation tx で次の mutation に影響なし、 failed[] に積んで継続) | 並列化後も挙動不変 (group 内 for-of は維持) | **mock 検出可**: 既存 bulk route test の「per-mutation throw → 200+failed」 経路を group 形でも再現 |
| R3 | response mutation_id 順正規化失敗 (= 完了順で並んでしまう) | 集約 logic bug (Map 経由 → 入力順 iterate を忘れる) | **mock 検出可**: route test (10 独立 key 入力 → response failed[] が入力順) |
| R4 | cascade-like 誤判定 (registry flag 不在で並列化される) | 新 op 追加時に cascadeLike flag を立て忘れ | **mock 検出可**: registry test (cascadeLike=true 4 件 / false 5 件 を網羅 assert)。 ただし「registry 改変による新 op 追加」 で flag を **必ず立てる** culture は test だけでは強制できない (= review 規律) |
| R5 | DB connection pool exhaustion (= 多並列で pool 上限超え) | Supabase Transaction pooler の pool size 不足 | **実機 smoke 要**: 着手前 dashboard で pool size 記録 + §5.2 指標 2 で 5 連発実走 |
| R6 | logger.warn の log 順序 lost (= 並列 group の warn が混在) | logger 出力経路 | **影響軽微** (debug 性低下のみ、 機能 regression なし)。 検出不要 |
| R7 | mutation_id 重複の race (= 異 group に分離されて 2 件並列適用、 1 件 skipped 残らず両方 applied) | 不正 payload (実用上発生しない) | §4.4 OT 判断で envelope zod 重複検出 400 reject 追加、 **mock 検出可** (zod schema test) |
| R8 | 503 retry-after の classification ずれ (= envelope-level catch との結合崩れ) | 並列下で getDb 失敗等を group 内 throw として吸い込んでしまう | **mock 検出可**: 既存 envelope test を group 形でも再現 (`getDb` 自体 throw → 503 経路) |
| R9 | cascade detected 時の全体 serial fallback path 検証 | helper の `serialFallback: true` 経路 (= 現状 for-of に戻る) | **mock 検出可**: helper test (cascade 入力 → `serialFallback: true` assert) + route test (cascade 入力で 既存 serial path と挙動同一) |
| R10 | 並列下の **「読み → 書き」 race** (= group A が tag_categories SELECT 中に group B が同 row UPDATE → group A の patch 適用後の状態が古い) | 異 entity key 間で実際には DB row が overlap するパス (= cross-key 副作用) | **設計除外**: cross-key 副作用は cascade-like として §1.2 で 4 件抽出済、 案 X で serial fallback に倒される。 残る非 cascade op (= update_field / create) は entity 内 self-contained で cross-key read-modify-write を含まない (`card.create` は §4.2 で cascade-like に格上げ済) → R10 は案 X で設計上発生しない |

### 5.1 検出経路サマリ

- **mock 検出可 (helper test 4 case + 既存 route test 拡張 + registry test 拡張で全カバー)**: R1 / R2 / R3 / R4 / R7 / R8 / R9
- **実機 smoke 要**: R5 (DB pool exhaustion)
- **影響軽微で検出省略**: R6 (logger interleave)
- **設計除外**: R10 (案 X の前提が成立、 cross-key race 経路を持たない)

### 5.2 実機 smoke 設計 (= plan T-B3 完了条件と一体化、 4 指標)

**着手前準備**: Supabase Transaction pooler の pool size を dashboard で確認 (production / stg 両方)、 本 session log §10 に追記してから smoke 計画を確定。

- **指標 1**: wall-clock before/after (10 独立 key 並列 path)。 stg で 10 異なる cards の `update_field` × 各 5 = 50 mutations bulk POST。 before = main 上 develop tip (= T-B2 完了状態)、 after = 本 task 完了 commit。 期待 = 並列 path で「ほぼ最遅 group の所要時間」 に収束 (= 旧 50 件直列の ~1/10 + overhead)。
- **指標 2**: pool exhaustion 検出 (5 連発 path)。 同 bulk を 5 連続発火、 pool 上限を実環境で叩く。 期待 = エラー 0、 `connect_timeout` 等が出たら本 sprint で `p-limit` を後付け hotfix。
- **指標 3**: cascade serial fallback 確認 (= 並列 path に行かない証明)。 1 件の `tag_category.delete` を mix した 11 件 bulk を発火、 全体 serial 経路に倒れることを log + wall-clock で確認。
- **指標 4**: card.create 多数 serial の wall-clock (OCR 典型ケース)。 1 exam に 50 件 `card.create` の bulk → §4.2 副次効果で全体 serial に倒れる。 wall-clock を before/after で計測 (期待 = 同等、 改善なし)、 将来「OCR 作成が遅い」 判断の材料として session log に残す。

証拠 = stg Network reqid / response body / wall-clock (3 回平均) を本 session log §10 に追記 (実装完了後)。

---

## 6. test case 案 (plan T-B3 完了条件の 4 case を 4 件 cascade-like 前提に具体化)

**helper test** (`lib/sync/server/group-mutations-by-entity-key.test.ts` 新規):

1. **同一 entity key 内逐次**: 同一 `(card, entity_id=X)` の 3 件 `update_field` 入力 → `groups` Map に 1 entry、 array 長 3、 入力順保持、 `serialFallback: false`。
2. **独立 entity key 間並列**: 5 件異なる `(card, entity_id=X1..X5)` の `update_field` 入力 → `groups` Map に 5 entry、 各 array 長 1、 `serialFallback: false`。
3. **順序破壊 regression (= self-throw path)**: 同一 entity key の mutation array に対して「内部で `Promise.all` を呼ぶ違反 path」 を invariant assert で踏ませる test → `throw new Error('ordering violated')` を expect。 plan 完了条件 3 番目 directly。
4. **cascade-like 入力 → serial fallback**: cascade-like 4 件 (= `tag_category.delete` / `tag_option.delete` / `card.delete` / `card.create`) のいずれかを 1 件含む mixed 入力 → `serialFallback: true`、 caller (= route) が serial path に倒れることを mock 検証。 **4 件すべてを 1 ケースずつ subtest で網羅** (= flag 立て忘れ regression を物理的に塞ぐ)。

**registry test** (`lib/sync/server/entity-mutation-registry.test.ts` 拡張、 既存 35 行):

- 各 op の `cascadeLike` flag を全件 assert:
  - **`cascadeLike: true` の 4 件**: `card.create` / `card.delete` / `tag_category.delete` / `tag_option.delete`
  - **`cascadeLike: false` (or undefined) の 5 件**: `card.update_field` / `tag_category.create` / `tag_category.update_field` / `tag_option.create` / `tag_option.update_field`
- 9 件すべて enumerate して assert (= 1 件でも記述漏れたら test 失敗、 新 op 追加時に flag 立て忘れを test で気づく gate)。

**route test** (`app/api/entity-mutations/bulk/route.test.ts` 拡張、 既存 1033 行に case 追加):

- 非 cascade のみの 10 独立 key 入力 (= `update_field` 系) → response `{applied: 10, failed: []}`、 mutation_id 順は入力順、 `processMutation` が並列発火 (= mock の calls timestamp で確認、 or `Promise.allSettled` の path を踏むことを mock spy で確認)。
- cascade-like 1 件混在 (= `card.create` 含む) 11 件 → response `{applied: 11, failed: []}` (apply は成功)、 serial path を踏むこと (= 並列発火していないことの mock 検証)。
- mutation_id 重複 (= envelope zod 重複検出) 入力 → 400 + `{ error: 'duplicate_mutation_id' }`。
- 既存 1033 行の test 全 pass を維持 (= regression なし)。

---

## 7. 想定 commit と review 経路

- **commit 1**: `feat(sync): T-B3 #1b group-mutations-by-entity-key helper 新設 + registry cascade flag (4 件)` — helper + registry flag + helper test + registry test 拡張
- **commit 2**: `feat(api): T-B3 #1b entity-mutations/bulk per-group 並列化 + 順序保証 self-guard + mutation_id 重複検出` — route 並列化 + route test 追加
- **commit 3**: `docs(superpowers): T-B3 #1b stg smoke 結果 (4 指標) + pool size 確認結果` `[no-review]`

review 経路: 各 feat commit は `superpowers:requesting-code-review` canonical (general-purpose subagent + template 改変なし)。 重要 fix (決済 / 認証 / 削除 / 外部副作用) には**該当しない**ため、 review pass で `[reviewed]` 即付与の通常経路。

push しない (= 本 task の plan B 全体ルール 6 で明示)。 commit までは本 session 内で実施するが、 stg deploy は OT 専権。

**実装方式**: CLAUDE.md 既定 = `superpowers:subagent-driven-development` (task 単位 fresh subagent + task 間 review、 foreground only — background 禁止 / anthropics/claude-code#20236 既知バグ回避)。

**Codex raw findings 保存先**: review subagent から返る raw findings は `docs/codex/` 配下に保存 (OT 規律)。

---

## 8. OT 判断結果サマリ (確定)

1. **採用 = 案 X** (cascade detected → 全体 serial fallback)
2. **cascadeLike flag = 4 件**: `tag_category.delete` / `tag_option.delete` / `card.delete` / `card.create` (`card.create` は OT 安全側判断で追加)
3. **concurrency cap = 本 sprint なし**、 着手前 pool size 確認 + §5.2 指標 2 で必須 smoke、 不足なら hotfix で `p-limit` 後付け
4. **mutation_id 重複検出 = envelope zod に追加** (400 reject)

判断必要: no (OT 判断受領済、 実装着手可)

---

## 9. 参考

- spec §3.2 = 順序保証契約の正本 (`docs/superpowers/specs/2026-06-12-y2-launch-hardening-design.md:99-116`)
- plan T-B3 = `docs/superpowers/plans/2026-06-12-y2-launch-hardening-B-perf.md:64-72`
- T-B2 教訓 = `docs/superpowers/lessons/2026-05-29-bulk-refactor-driver-layer-lessons.md` L1 / L2 (= driver 層 mock 不能、 実機 smoke 必須)
- T-B2 完了 session = `docs/superpowers/sessions/2026-06-13-y2-t-b2-smoke.md` (3 指標 pass、 commit 8d7a6ae)
- 現行 bulk route = `app/api/entity-mutations/bulk/route.ts`
- registry = `lib/sync/server/entity-mutation-registry.ts`
- 関連 apply 関数 (cascade 実態確認元) = `lib/tags/apply-tag-mutation.ts:111` (tag_category.delete) / `:325` (tag_option.delete) / `lib/cards/apply-card-mutation.ts:136` (card.delete) / `lib/cards/apply-card-mutation.ts` (card.create = `applyCardCreateWithId` 経由、 `exams.card_count += 1`)

---

## 10. 実装後 追記 (TBD、 commit 3 で更新)

- pool size 確認結果 (production / stg、 着手前 dashboard 取得値)
- §5.2 指標 1 / 2 / 3 / 4 の実測値 (wall-clock 3 回平均、 Network reqid、 response body 抜粋)
