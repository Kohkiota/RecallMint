# driver / DB 層に踏み込む変更は三段でクローズする

**作成日**: 2026-06-13
**抽出元 sprint**: Y-2 Sub-plan B T-B3 (#1b entity-mutations/bulk per-mutation tx 順序保証付き選択並列化、 案 X)
**関連 sprint**: Y-2 T-B2 (#1a study_days SQL N+1) / problem 3 bulk refactor (2026-05-29)
**先行 lesson**: `docs/superpowers/lessons/2026-05-29-bulk-refactor-driver-layer-lessons.md` L1 / L2 (driver 層は mock 不能 — 4 度目の的中を本 sprint で記録)

---

## TL;DR

並列化 / 配列バインド / DB pool 周り など **driver / DB 層に踏み込む変更**は、 mock green + lint exit 0 だけではクローズできない。 (1) 設計段階で race / cross-key 経路を**設計除外**、 (2) mock で**検出可能な risk** を unit test で潰す、 (3) 実機 smoke で **mock 不能な残り** (pool exhaustion / 並列 race / driver 値 encode) を確認、 の三段すべてを踏んでクローズする。 mock green だけで deploy した過去 3 件 + Y-2 T-B3 計 4 件が同 driver 層問題に当たっており (2026-05-29 L2 が 4 度目の的中)、 三段クローズは規律として固定する。

---

## 教訓: 三段クローズの中身

### 段 1: 設計レビューで race / cross-key 経路を **設計除外** する

並列化や配列バインドのような driver 層変更は、 「実装の正しさ」 と並んで「経路を作らない」 設計判断が中核になる。 race の可能性がある経路を実装 / test で潰すより、 **そもそも経路を持たせない設計** を採るのが工学的に正しい。

T-B3 案 X (= cascade detected → 全体 serial fallback) の例:
- 並列化対象を 「entity 内 self-contained な 5 op (= update_field / create 系)」 に限定
- 「cross-entity read-modify-write」 (= card.create で `exams.card_count += 1`) と「強 cascade」 (= 各 entity の delete) を **`cascadeLike: true` flag で entity_type × op レベル**で並列化対象から外す
- これにより「異なる entity key 間で実際には DB row が overlap するパス (= cross-key race、 R10)」 が **設計上発生しない** ことを示せる
- 残る非 cascade op は entity 内 self-contained で cross-key read-modify-write を含まない → R10 は案 X の前提が成立する根拠

設計除外の利点:
- test カバレッジを「並列化された op のみ」 に絞れる (= 試験対象が小さい)
- 万一の race が起きた場合の影響範囲が「設計外経路に逸脱した時のみ」 に閉じる
- review 段で「この race は起きないか」 を **コードでなく設計図で**確認できる

設計除外が失敗するパターン:
- 「とりあえず並列化、 race は後で潰す」 — race の存在自体が設計の隙
- 「並列化対象を都度判定する registry を持つが flag が op レベルでなく case-by-case」 — drift 源
- 「cascade を細密に並列化 (= phase 分離)」 — 順序の正しさが phase 設計依存になる、 mock で確証不能

### 段 2: mock で検出可能な risk を unit test で潰す

driver 層変更には mock で検出できる risk と検出できない risk が混在する。 mock 検出可な risk は unit test で **全て** 潰す。 同じ test を実機 smoke で繰り返さない (smoke は mock 不能経路のためにあける)。

T-B3 で unit test で潰した risk (R1-R4 / R7-R9):
- R1: 同一 key 並列で UPDATE 競合 → helper test 1 (同一 key 入力 → 同一 group に集約 assert) + 順序破壊 self-throw test 3 (= `assertSequentialPath(group, 'parallel')` で `throw new Error('ordering violated')`)
- R2: group 内 throw → group 内残り mutation の挙動 → 既存 1033 行 route test + 拡張 case で per-mutation 内側 catch を pin
- R3: response mutation_id 順正規化失敗 → route test (10 独立 key 並列 → response shape) + Map → 入力順 iterate logic
- R4: cascade-like 誤判定 (registry flag 立て忘れ) → registry test 9 件 enumerate (= 新 op 追加時に flag を **必ず立てる** culture を test で gate)
- R7: mutation_id 重複の race → envelope zod `superRefine` で 400 `duplicate_mutation_id` reject + route test (c) で pin
- R8: envelope 致命 vs per-mutation throw の error 分類 2 層不変 → route test (e) で並列化前後不変、 (f) で group async body 自体 throw 時の fail-silent 防御
- R9: cascade-like serial fallback path → helper test 4 + route test (b) 4 subtest で 4 件 cascade すべて pin

unit test 経路の特徴:
- driver / pooler 層を mock で代替する (`getDb` mock、 `db.transaction` fake、 handler mock)
- 純関数 logic (= helper / registry / zod) の検証は実 driver 不要
- T-B2 教訓 L2 「driver 層は mock で確証不能」 を逆手に取り、 driver 層に**触れない**経路の検証を unit に閉じ込める

mock 検出不能な risk (= 段 3 へ送る):
- R5: DB connection pool exhaustion (Supabase Transaction pooler の実 pool size、 postgres-js max queue 挙動)
- driver 値 encode (Date / array / jsonb の OID hint = 2026-05-29 L1 / L2 の rollback の原因)
- 実 並列下の tx 競合可能性 (cross-key race の不在を実機で確認)

### 段 3: 実機 smoke で mock 不能な残りを確認

mock で代替できない経路は **必ず実機 smoke** で確認する。 段 1 で設計除外、 段 2 で mock 検出 を通っていても、 段 3 で実機 smoke を省略すると 「実 deploy で初めて driver 層 rollback」 (= 過去 3 件 + 本 T-B3 系で計 4 件) を踏む。

T-B3 で実機 smoke を踏んだ risk:
- R5: DB pool exhaustion → 5 並列発火 (Promise.all × 5 lambda × 50 group = 250 同時 mutations) で connect_timeout 0 / 5xx 0 を実機実証
- 駆動経路 確認 → 並列 wall-clock 5.09x speedup (= 並列化が driver 層を実際に通過している実証)
- cascade serial fallback path → tag_category.delete 1 件混在で wall-clock が parallel baseline の 6.7x = 全体 serial 倒れの実機証拠 (mock 不能、 mock は path を踏むかどうかしか観測できない)
- card.create 多数 serial (OCR 典型) → 全件 serial 倒れ wall-clock 2853 ms = ~57 ms / card で実用許容範囲を実機実証

smoke 経路の特徴:
- production と同じ driver / pooler を使う (= stg = Supabase Transaction pooler + postgres-js prepare:false)
- mock で出てこない driver 層 encode (Date / array / jsonb) / pool 上限 / lambda 並列度 が実環境で見える
- 段 2 unit test と異なる経路を踏むことが目的、 同じ test の繰り返しでは意味がない
- 証拠は wall-clock 3 回平均 + Network reqid + response body 抜粋 + console / log を session log に貼付 (T-B2 / T-B3 smoke session log と同形)

---

## 三段を踏まないとどうなるか (過去事例 4 件)

| # | 時期 | 変更 | mock green | 実機 smoke なしで deploy → | 根本原因 |
|---|---|---|---|---|---|
| 1 | 2026-05-28 problem 3 bulk refactor | `update().from(sql\`(VALUES ...)\`)` で Date 値 embed | 887 unit test green | stg で全 event `failed[]`、 tx rollback | postgres-js Date OID 1184 serializer bypass (Drizzle #5789 既知挙動) |
| 2 | 2026-06-13 T-B2 初版 `481d2e4` | `ANY(${days}::date[])` 直接 embed | unit test green | stg deploy 前 reflog 段階で誤動作疑い、 即巻き戻し | Drizzle record 展開挙動を mock で確証不能 |
| 3 | 2026-06-13 T-B2 fix attempt `d1987da` | `sql.param(days)` 経路 | unit test green | stg で全 event `failed[]`、 `Buffer.byteLength(Array)` TypeError | postgres-js Array encode 経路を mock で確証不能 |
| 4 | 2026-06-13 T-B3 (本 sprint、 **未然に防止**) | per-mutation tx 並列化 (案 X) | unit test 2072 件 green + helper / registry / route 全 pass | (実機 smoke 全 pass で deploy 前にクローズ確定) | (避けた): pool exhaustion / cascade fallback 動作不良 / OCR 多数 serial の体感影響 — mock では観測不能 |

#1〜#3 はいずれも unit test green で「OK」 と判断し stg deploy で rollback。 #4 は段 1 設計除外 (cascade を serial に倒し cross-key race 経路を設計外に出す) + 段 2 unit test (R1-R4/R7-R9 を mock で pin) + 段 3 実機 smoke 4 指標 (R5 + 実 並列度 + cascade serial fallback + OCR 典型) を通過して、 4 件目の rollback を未然に防いだ。

「2026-05-29 L2 が 4 度目の的中」 = 過去 3 件は事後対応で T-B3 は事前対応、 三段クローズが規律として機能した最初の sprint = T-B3。

---

## 三段クローズの判定 checklist (実装者向け)

driver / DB 層に踏み込む変更を始める前に、 以下を確認:

- [ ] **段 1**: 設計レビューで「race / cross-key 経路を持つか」 を確認、 持つなら**経路を設計外に出す** 案 (e.g. 案 X の serial fallback) を選ぶ。 経路を残したまま実装 / test で対応する案は採らない。
- [ ] **段 1 補足**: 設計除外を doc で明文化 (= 何が並列化対象で何が外されたか、 その判断の根拠)。 review 段でコードでなく設計図を読んで race の不在を確認できる状態にする。
- [ ] **段 2**: mock 検出可な risk を列挙、 unit test で**全て** pin。 register / helper の純関数 logic は driver mock + 構造的 assert で確証。
- [ ] **段 2 補足**: 新 op / 新 entity_type 追加時の flag 立て忘れ等の **drift 源**は test の enumerate (= 全 op / 全 type を網羅 assert) で gate する。 review 規律だけに頼らない。
- [ ] **段 3**: mock 検出不能な risk (pool / driver encode / 並列下の tx 競合) を実機 smoke 指標として列挙、 各指標を実走 + 証拠 (wall-clock / Network reqid / response body / console / log) を session log に貼付。
- [ ] **段 3 補足**: smoke は段 2 unit test と**異なる経路**を踏むこと。 同じ assert を mock と実機で重ねるのは目的外。 mock で潰せない経路だけを smoke で踏む。
- [ ] mock green + lint exit 0 で「クローズ」 と判断しない。 三段すべての証拠を session log に揃えてからクローズ報告。

---

## 付随証拠 (T-B3 実測、 三段クローズの実走例)

段 1 設計除外:
- 案 X (= cascade detected → 全体 serial fallback) を採用、 4 件 (`card.create` / `card.delete` / `tag_category.delete` / `tag_option.delete`) を cascadeLike=true flag で並列化対象から外した
- 残る非 cascade 5 op は entity 内 self-contained、 cross-key race 経路を **設計上持たない**

段 2 unit test (mock 検出経路):
- helper test 4 case + 補助 negative (`lib/sync/server/group-mutations-by-entity-key.test.ts`)
- registry test 9 件 enumerate (`lib/sync/server/entity-mutation-registry.test.ts`)
- route test 拡張 6 case 9 subtests (`app/api/entity-mutations/bulk/route.test.ts`)
- whole-repo `pnpm test` 2072 件 / `pnpm typecheck` / `pnpm lint --max-warnings=0` 全 exit 0

段 3 実機 smoke (mock 不能経路):
- 指標 1 並列 wall-clock: parallel avg 298 ms / serial 1518 ms / **speedup 5.09x** (= 並列化が driver 層を実際に通過、 mock では timing 観測不能)
- 指標 2 5 連発 pool exhaustion: 5 並列発火 250 mutations 全成功、 `connect_timeout` 0、 `5xx` 0、 `Retry-After` 不発火 (= Supabase Transaction pooler 15 + postgres-js max 10 で短命 tx drain が実環境で機能、 mock では観測不能)
- 指標 3 cascade serial fallback: 1985 ms = parallel baseline の 6.7x (= 全体 serial 倒れの実機証拠、 mock では path 踏むか否かしか観測できない)
- 指標 4 card.create 多数 serial (OCR 典型): 2853 ms / 57 ms per card (= 体感許容範囲を実機実測、 mock では wall-clock 観測不能)

これらの実測は「案 X が**速かった**」 でなく「三段クローズ規律が**機能した**」 証拠として記録。

---

## 関連参照

- 先行 lesson: `docs/superpowers/lessons/2026-05-29-bulk-refactor-driver-layer-lessons.md` (L1 driver 層 pre-investigation / L2 mock 不能 / L3 観測と対策の時間分離 / L4 driver vs pooler の切り分け / L7 RETURNING + 件数照合)
- T-B2 lesson: `docs/superpowers/lessons/2026-06-13-drizzle-sql-template-array-embed.md` (sql.param(array) 誤誘導 + 訂正、 本 lesson と隣接)
- 先行 lesson: `docs/superpowers/lessons/2026-05-07-spec-confirmed-vs-smoke-judgment.md` (= 仕様確定 vs smoke 判定の分離、 本 lesson の段 1/2 と段 3 の分離規律と同根)
- T-B3 smoke 結果: `docs/superpowers/sessions/2026-06-13-y2-t-b3-step0-design.md` §10 (4 指標 全 pass)
- T-B2 smoke 結果: `docs/superpowers/sessions/2026-06-13-y2-t-b2-smoke.md` (3 指標 全 pass、 段 3 経由の事後対応例)
- 関連 commit: T-B3 commit 1 `4a0704d` / commit 2 `7b60614` / smoke session log `911bd0c`
- 関連 review raw findings: `docs/codex/2026-06-13-y2-t-b3-commit1-review.md` / `commit2-review.md`
