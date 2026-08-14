# Order-1 — cards 順序キー再設計(base_order 導入 + sort_key → 番号ラベル転換)設計 spec(r3)

- **r2 → r3(2026-08-14・実装中の OT 承認)**: §4.1 のみ訂正 — `ExamDetailCard` に `baseOrder` を追加し `getCardsForExam` の SELECT に含める。r2 が SELECT 追加を退けた理由(「行内で base_order を読む UI が無い」)が Task 2 の実装中に**実測で偽**と判明したため(詳細は §4.1 の r3 訂正注記)。他の節は不変。
- 状態: **確定・凍結**(2026-08-14 OT 承認)。**§12 の確認点 7 件も承認済み**(凍結指示に含む)。r1 → r2 の差分 = OT 指示の文面修正 3 組(① §2.3-3 wire 表現の凍結境界の明確化 ② §5.3 並走説明を実 lock 構造(submit の user 単位 advisory xact lock は publish 段に及ばない)で訂正 ③ §2.1 UNIQUE 衝突時の挙動を実 error 経路(per-mutation failed[] → 再送ループ → stale 隔離 = silent lost write / publish は tx rollback)で訂正)。**以後、本 spec は実装フェーズで書き換えない** — 仕様判断が必要になった時点で停止し OT に相談する。実装 plan = `docs/superpowers/plans/2026-08-14-order-1-base-order.md`。
- 位置づけ: **Order-1 → Grid-3(試験間移動)→ 行 DnD の 3 sprint の第 1 段**。本 spec が cards の順序の**正本契約**。Grid-3 / DnD は本契約(§2)を消費する — 挿入・再採番の**実装**は Grid-3 側だが、**契約の定義**は本 spec に置く。
- 入力: OT kickoff(確定 8 決定・2026-08-14)+ 前提確認レポート 3 本(同日 chat: Grid-3 実装状況 / sort_key 実態 / 移動+順序再設計の前提確認)。事実の根拠 file:line は同レポートを正とし、本 spec では設計に効く箇所のみ再掲する。
- 前提: **stg / prod とも全アカウント・全データ削除済み**(OT 確定 7)。既存データの移行なし。互換レイヤー不要。次 migration = **0037**(0036 = Sprint B が最新)。

## 0. 目的

現 `cards.sort_key` は「文書上の元番号」であって順序キーではない — OCR は source 画像ごとに番号を振り直したものをそのまま格納し(stg 実測: 1 upload 内で `001..011` / `001..002` / `001..031` の 3 ブロック)、`ORDER BY sort_key(text 辞書順), created_at` はブロックを交互に混ぜ、created_at は publish 単位で全カード同値なので tie-break が機能しない。表示順は重複グループ内で server / client が別の順を返しうる未定義状態にある。

本 sprint で順序と番号ラベルを分離する: 順序の正 = 新設 `base_order`(整数・NOT NULL)、`sort_key` は「番号ラベル」(`question_label`)に転換して表示・編集用の自由テキストとする。

## 1. 決定事項

### 1.1 OT 確定(kickoff 8 決定 — 本 spec の前提。矛盾は検出されなかった)

1. `sort_key` → **`question_label`** に物理 rename。表示・編集用の自由テキスト。順序の根拠にしない。重複・NULL 許容(現性質維持)。
2. 新列 **`base_order`**(内部整数の基準順)。NOT NULL。全順序 = **`(base_order ASC, id ASC)`**。server SQL / client comparator で同一結果を保証。
3. 既定表示 = 基準順。列ソートは表示専用(TanStack の現機構のまま)。番号ラベル列のソートは現行の文字列比較を専用 comparator として残す。置換対象は既定順 3 箇所(テーブル pre-sort / カードビュー pre-sort / カスタム演習 sequential)+ server ORDER BY 2 箇所(`lib/exams/list.ts:117, 196`)のみ。
4. OCR: prompt に「読み取り順で出力」を明示追加した上で、publish 時に**応答配列順**で採番。採番起点 = 対象 exam の既存 `max(base_order)` の続き(既存試験への追加アップロードがあるため)。
5. 手動追加: 末尾採番。番号ラベルは **null** で作成(自動採番しない)。`nextCardSortKey` は廃止し base_order 採番器へ転換。
6. ラベル編集で行は動かない(既定順表示時の保証。ラベル列ソート適用中はソート結果として動いてよい)。
7. 既存データの移行なし(全データ削除済み)。
8. deploy 順は **migrate 先行 → deploy**。切替中の書込失敗は loud failure として許容。**expand-contract を採らない意図的制約**: ゼロユーザー・ゼロトラフィックであり、二段 deploy(nullable 追加 → backfill → NOT NULL 化 → 旧列削除)の運用コストに対して得られる無停止性の利得がゼロのため(§9)。

### 1.2 spec が確定する設計判断(→ §12 に OT 確認点として集約)

- D-1 **型 = `integer` / stride S = 1024 / CHECK `base_order >= 1`**(§2.2, §3)
- D-2 **UNIQUE を張らない**(重複容認 + `id` tiebreak で全順序を保つ — §2.1)
- D-3 **`id` tiebreak の比較 = 小文字 UUID 文字列の単純比較**(PG uuid byte order と一致することを iso で pin — §2.1)
- D-4 index = `(user_id, exam_id, base_order, id)` 全 ASC(§3.2)
- D-5 **Dexie は version bump なし・index 追加なし**(§6.1)
- D-6 **base_order は本 sprint では update_field 対象にしない**(書き手は create 経路のみ。Grid-3 で field 追加 — §2.4)
- D-7 カスタム演習 sequential の複数 exam 順 = **`(exam_id ASC 文字列比較, base_order, id)`**(§2.5)
- D-8 **Gemini wire の field 名 `sort_key` は維持**し、rename は normalize 境界から app 側のみ(§5.1)

## 2. 順序契約(正本 — Grid-3 / DnD はここを消費する)

### 2.1 全順序

exam 内の card の全順序は **`(base_order ASC, id ASC)`**。

- `base_order` は**一意性を要求しない**(UNIQUE 制約を張らない)。重複時は `id` が決定的 tiebreak。
  - 理由: local-first で offline 端末 2 台が同時に末尾追加する / OCR publish と手動追加が並走する、のいずれでも同値採番が起きうる。UNIQUE を張った場合の衝突時挙動(現物の error 経路で確認済)は回復不能: **手動 create 側**は 23505 が bulk route の per-mutation catch(`entity-mutations/bulk/route.ts:258-274`)で failed[] に積まれ、client は pending 残置 → 再送のたび同じ衝突を踏む → stale 隔離(`dropStalePendingEntityMutations`)で最終的に **silent lost write**。**OCR publish 側**は publish tx ごと rollback = upload 全体の失敗。どちらにも回復経路が無い。重複容認 + tiebreak なら**どの並走でも書込は成功し、順序は決定的**なまま(表示上の相対位置が採番規則の意図と数枚ずれるだけ)。
- `id` の比較: server = PG `uuid` 型の byte order。client = **小文字 canonical UUID 文字列の単純 `<` 比較**(`localeCompare` 禁止)。両者は同一結果になる(同長 hex 文字列 + 固定位置ダッシュの ASCII 比較 = byte 比較。id の生成源は `crypto.randomUUID()`(client)と PG text 出力(pull)でいずれも小文字 canonical)。**この一致は iso test で pin する**(§10-2)。
- `base_order` は **exam 内でのみ意味を持つ**。exam を跨ぐ比較には使わない(跨ぐ場合は §2.5)。

### 2.2 値域と刻み

- 型: `integer`(int4)。CHECK **`base_order >= 1`**。0 と負値は使わない(0 は挿入計算の仮想下界 L として予約 — §2.3)。
- stride **S = 1024**。定数は `lib/cards/domain/` 配下の順序 domain module に 1 定義(client / server 両側から import)。
- headroom: int4 上限 2,147,483,647 ÷ 1024 ≈ **209 万回の末尾追加/exam** — 実用上限(数千枚)に対し十分。overflow は loud failure(23514/22003)で許容し、防御コードは書かない。

### 2.3 採番・挿入の計算式(契約。末尾以外の実装は Grid-3)

exam 内の既存 max を `M`(空 exam は `M = 0`)とする。

1. **末尾に k 枚**: `b_i = M + i·S`(i = 1..k)。Order-1 で実装(OCR publish / 手動追加)。
2. **位置挿入(A の直後・B の直前に k 枚)**: `step = floor((B − A) / (k + 1))`(A / B = 現順序で隣接する card の base_order 値)。
   - `step >= 1` なら `b_i = A + i·step`。
   - **先頭挿入は A = 0**(仮想下界)として同式を使う。
   - `step = 0`(整数の空きが無い。**A = B の重複隣接もここに落ちる**)なら **exam 内再採番**(下記 3)を先行してから再計算する。
3. **exam 内再採番**: 現在の全順序(`base_order, id`)で並べた順に、全 card へ `i·S`(i = 1..N)を再割当。
   - **本 spec が凍結するのは計算式と安全性質まで**: server は per-mutation 成否で all-or-nothing を提供しないが、**部分適用でも全順序の不変条件(§2.1)は壊れない** — 重複容認 + id tiebreak により途中状態も決定的な順序を持ち、残りは再送で収束する。ゆえに**原子的 bulk op は契約上不要**。
   - **具体的な wire 表現(per-card update_field N 件 / 専用 op 等)は凍結しない — Grid-3 の設計判断**。上の性質が per-card 表現を安全にすることを本 spec は保証するが、形の確定は Grid-3 spec が行う(新 op を作る場合は entity_mutations の CHECK + registry + migration 同時更新規約(`lib/db/schema.ts:648-655`)に従うこと)。

### 2.4 書き手(Order-1 の範囲)

- Order-1 で `base_order` を書くのは **create 経路のみ**(OCR publish / 手動追加、いずれも式 1)。
- `base_order` を `CARD_FIELD_HANDLERS` の update_field 対象に**しない**(D-6)。挿入・並べ替え・移動の書き手が存在しないため。Grid-3 で field を追加する際の契約: handler は `z.number().int().min(1)` で検証し、他列は触らない。
- ラベル(`question_label`)の update_field handler は現 `sort_key` handler の rename(`'' → null` 正規化維持)。**base_order に触らない**ため決定 6(ラベル編集で行は動かない)は構造的に成立する。

### 2.5 exam を跨ぐ決定的順序(カスタム演習 sequential)

複数 exam 選択時の sequential は **`(exam_id ASC(文字列比較), base_order ASC, id ASC)`** — exam 単位でグループ化し、各 exam 内は基準順。

- exam_id は uuid で並び自体に意味はないが、**決定的・追加データ不要**(comparator が ClientCard の 3 field だけで完結し、exams mirror への join が要らない)。
- 検討した代替: exams.created_at 順(ユーザーに意味のある順だが、comparator に exams mirror の join 依存と「exam 行不在時の順序未定義」という失敗モードを持ち込む)→ 不採用。単一 exam 選択時は両案同一。

## 3. DB(migration 0037)

```sql
ALTER TABLE cards RENAME COLUMN sort_key TO question_label;
ALTER TABLE cards ADD COLUMN base_order integer NOT NULL;
ALTER TABLE cards ADD CONSTRAINT cards_base_order_positive CHECK (base_order >= 1);
DROP INDEX cards_sort_idx;
CREATE INDEX cards_order_idx ON cards (user_id, exam_id, base_order, id);
```

(実ファイルは drizzle-kit 生成。上記は意図の宣言。)

### 3.1 設計注記

- `base_order` に **DB default を置かない**。全 INSERT 経路が明示供給する契約にし、供給漏れを 23502 で loud に検出する(silent 0 埋めを作らない)。
- `ADD COLUMN ... NOT NULL`(default 無し)は**空テーブル前提**(OT 確定 7)。行が残る DB(ローカル dev 等)では migration が loud fail する — その場合の対処は operator が truncate(意図的。backfill 経路は作らない)。
- `question_label` は rename のみ(text / nullable / 制約なし — 現性質維持)。
- UNIQUE を張らない理由は §2.1(D-2)。

### 3.2 index

- `cards_sort_idx (user_id, exam_id, sort_key)` は **DROP**(ラベルは順序に使わず、server がラベルで WHERE/ORDER する query は存在しない)。
- 新設 `cards_order_idx (user_id, exam_id, base_order, id)` 全 ASC:
  - `ORDER BY base_order, id`(§4.1)の pathkey と一致。**全列 NOT NULL + 全 ASC(既定 NULLS LAST 同士)なので、Sprint B で発見した NULLS 位置不一致による Sort ノード残存(sessions/2026-08-12 §216)は構造的に起きない**。
  - publish 採番の `max(base_order)`(§5.2)も同 index の backward scan で解決する。

### 3.3 CHECK

`cards_base_order_positive CHECK (base_order >= 1)` の 1 本のみ。上限 CHECK は張らない(overflow は int4 自体が 22003 で loud fail する)。iso の `check-constraints.test.ts` の `POSITIVE_CASES` に追加する(§10-5)。

## 4. server 層

### 4.1 ORDER BY 置換(2 箇所 — 決定 3 の全量)

- `getCardsForExam`(`lib/exams/list.ts:117`)/ `getCardsForSourceDocument`(同 `:196`): `.orderBy(cards.sortKey, cards.createdAt)` → **`.orderBy(cards.baseOrder, cards.id)`**。`sortKey` 列の SELECT は `questionLabel` に rename。
- `ExamDetailCard` 型(list.ts)の `sortKey` → `questionLabel` rename + **`baseOrder: number` 追加**、`getCardsForExam` の SELECT に `baseOrder` を含める。
  - **r3 訂正(2026-08-14・OT 承認)**: r2 は「SSR SELECT に baseOrder を追加しない(行内で base_order を読む UI が無い — YAGNI)」としていたが、**その理由は実測で偽**だった — 手動追加の末尾採番は SSR fallback(`initialCards` = `ExamDetailCard`)経由で行の base_order を読む。Dexie mirror 未 hydrate の窓では max が不明になり採番が stride 先頭(1024)に落ちて既存カードと衝突する(実証: 追加 test を click 前に 50ms 待つ形にすると pass(2048)、待たない現行は fail(1024))。旧実装は `ExamDetailCard.sortKey` を持っていたため fallback でも正しく採番できており、非退行条件に該当する。
  - `getCardsForSourceDocument`(`CardListEntry`)は**変更しない** — 採番の読み手ではない(OCR result page の snippet 表示専用)。追加するのは `getCardsForExam` の 1 経路のみ。

### 4.2 wire / apply

- `cardCreatePatchSchema`(`lib/sync/shared/mutation-schemas.ts`): `sort_key: sortKeySchema` → `question_label: questionLabelSchema`、**`base_order: z.number().int().min(1)` を必須追加**。
- `applyCardCreateWithId`(`lib/cards/apply-card-mutation.ts`): input に `baseOrder: number` 追加、INSERT values に供給。`sortKey` → `questionLabel` rename。
- `CARD_FIELD_HANDLERS`(`lib/cards/card-field-handlers.ts`): key `sort_key` → `question_label`(handler 実体は rename + `''→null` 正規化維持)。`base_order` の handler は**追加しない**(D-6)。
- `NULLABLE_TEXT_FIELDS`(`lib/cards/domain/card-rules.ts`)の `'sort_key'` → `'question_label'`。
- registry(`entity-mutation-registry.ts`)は schema shape の変更が透過するのみ(構造変更なし)。entity_mutations の DB CHECK(entity_type / op)は field 名を含まないため **migration 不要**。
- 旧 field 名 `sort_key` の update_field が届いた場合: dispatch lookup 失敗 → per-mutation `failed`(既存機構)。ゼロユーザーにつき許容(§9)。

### 4.3 採番 domain(新設)

`lib/cards/domain/` に順序 domain module を新設(pure・I/O なし、DDD 方針準拠):

- `BASE_ORDER_STRIDE = 1024`
- `nextBaseOrders(maxExisting: number | null, count: number): number[]` — 式 §2.3-1。手動追加(count=1)と publish(count=N)の**両方がこの 1 定義を使う**(client / server で式を二重実装しない)。
- `compareByBaseOrder(a, b)` — §2.1 の comparator(client 用。server は SQL ORDER BY が対応物)。
- `nextCardSortKey`(`lib/cards/next-card-sort-key.ts`)は**削除**(呼出は buildEmptyCard の 1 箇所のみ)。

## 5. OCR 層

### 5.1 wire 名は `sort_key` のまま、rename は normalize 境界から(D-8)

Gemini 応答 schema の field 名 `sort_key` は**変更しない**。根拠:

- live 探索 schema(`ocr-image-crop-response.ts`)は本番 builder(`ocr-response.ts` の `buildDiscoverResponseJsonSchema()`)の出力を copy して合成しており、wire rename は共有 builder + legacy 経路 + prompt の key 命名規則(`q{sort_key}-img-{n}`、`ocr-extract.ts:142-143`)まで波及する。モデルへの抽出意味論(「文書上の元番号を保持」)は**変わらない**ため、wire 名を動かす利得がない。
- rename 境界 = `normalizePrepared`(`lib/ocr/normalize-prepared.ts:359`): `sortKey: data.sort_key ?? null` → `questionLabel: data.sort_key ?? null`。**この 1 行が wire(sort_key)↔ app(questionLabel)の唯一の継ぎ目**であることを module コメントに明記する。
- prepared payload schema(`lib/ocr/prepared-schema.ts:138`)の `sortKey` → `questionLabel`(prepared_payload は publish 時 NULL 化 + データ全削除済みゆえ互換不要)。

### 5.2 prompt 追加(決定 4)

`COMMON_EXTRACTION_RULES`(`lib/ai/prompts/ocr-extract.ts` の【抽出範囲】ブロック)に 1 行追加:

> `cards[] は文書の読み取り順(ページ順・ページ内の出現順)に出力する。番号の昇順への並べ替えはしない`

**この命令はモデルへの強化であって機械保証ではない**(前提確認レポート: 出力順を保証する機構はコードにも prompt にも無い)。契約の正はコード側 — **publish は応答配列順を正として採番する**(順序検証・並べ替えはしない)。入力側の順序(選択順 merge → parts 順)は既存実装が保証済みで無改変。

### 5.3 publish 採番(決定 4)

- publish tx 内(cards INSERT の直前)で `SELECT max(base_order) FROM cards WHERE user_id = ? AND exam_id = ?` を取り(`cards_order_idx` backward scan)、`buildCardRows`(`publish-prepared-plan.ts:211`)が `nextBaseOrders(max, cards.length)` を**配列順**に割り当てる。
- 既存 exam への追加 upload は続き番号になる(空 exam は S=1024 から)。**並走の実態**(現物確認済): submit は user 単位 advisory xact lock(`submit-upload.ts:432-437` の `pg_try_advisory_xact_lock(hashtext(user.id))`)で直列化されるが、これは **submit tx 内のみ**で publish 段には及ばない(publish-prepared.ts に lock なし。fenced CAS(lease_version)が防ぐのは同一 operation の二重実行であって operation 間の並走ではない)。よって同一 user の複数 operation の publish 同士・publish と手動追加 flush は並走しえて、同値採番が起きうる — §2.1 の重複容認 + id tiebreak で吸収し、exam / user 単位の lock を publish に**追加しない**(順序の決定性は保たれ、失われるのは採番規則どおりの相対位置のみ)。
- `buildResultSummary` の `cardsPreview` は無改変(OCR 順の記録として引き続き残る)。

## 6. client 層

### 6.1 Dexie(D-5: version bump なし)

- `ClientCard`(`lib/client-db.ts`): `sort_key?: string | null` → `question_label?: string | null`(rename)、**`base_order: number` 追加**。
- **Dexie index は追加しない・v13 は作らない**。根拠: 全読み経路が「exam 全件 fetch → JS ソート」(`where('exam_id')` / `where('user_id')`)であり、index 順走査の読み手が居ない。件数 count の `[user_id+exam_id]` も不変。`stores()` は index 宣言でありカラム定義ではないため、非 index field の追加・rename に version 不要。
- 旧 IDB 残骸行(削除済みアカウントの行)は owner-scope で到達不能のため upgrade 処理を書かない(過剰防御をしない)。

### 6.2 comparator

- `sortLikeServer`(`lib/cards/sort-like-server.ts`)の**既定順 3 箇所を `compareByBaseOrder` に置換**: カードビュー pre-sort(`inline-card-list.tsx:214`)/ テーブル pre-sort(`exam-card-table.tsx:322`)/ カスタム演習 sequential(`get-custom-session-cards.ts:85`。ここだけ §2.5 の exam_id 第 1 キー版)。
- **ラベル列ソート専用 comparator**(決定 3): 現 `sortLikeServer` の文字列比較 + NULLS LAST を `compareByQuestionLabel` として残す。tiebreak は `created_at` から **`(base_order, id)`** に変更(created_at は publish 単位で同値になり tie を解決できない — §0 の実測)。利用は label 列の `sortingFn`(`exam-card-table-columns.tsx:191`)のみ。
- `inline-card-list.tsx:43` の互換 re-export は新名に追随(importer 2 file 同時変更)。

### 6.3 手動追加(決定 5)

- `buildEmptyCard`(`lib/cards/empty-card.ts`): 引数 `existingSortKeys` → `existingBaseOrders: number[]`。返り値 `sortKey` → **`questionLabel: null` 固定 + `baseOrder: nextBaseOrders(max, 1)[0]`**。
- `buildNewClientCard` / `buildNewCardMutationPatch`(`card-write.ts` — `sort_key: string` 型は `question_label: null` + `base_order: number` に変更)/ 呼出元 `inline-card-list.tsx:376-379`(渡す配列を `c.baseOrder` に変更)。

## 7. UI 層(rename 追随のみ — 挙動変更は既定順の 3 置換に限る)

| 対象 | 変更 |
|---|---|
| `inline-card-list.tsx:130-139` / `exam-card-side-peek.tsx:112` / `exam-card-table-columns.tsx:184` | `InlineTextField field="sort_key"` → `"question_label"`。表示ラベル「ソートキー」→「**番号**」(placeholder `(番号)`) |
| `inline-text-field.tsx:44` | field union の rename |
| `exam-card-table-columns.tsx:169-193` | 列 id `sort_key` → `question_label`、`sortingFn` = `compareByQuestionLabel`、`filterFn` は questionLabel 直読み |
| `exam-detail-view.tsx:64` / `exam-card-table-test-harness.tsx:23` | 既定 `columnVisibility` key rename(保存済み record は全削除済みで互換不要) |
| `exam-card-table-filter-editors.tsx:298-305` / `card-filter-labels.ts:35` | key / ラベル rename |
| `scripts/seed-perf-exam.ts` | sortKey 採番を base_order(`i·S`)+ questionLabel(旧 4 桁文字列)に変更 |

表示列名「番号」は仮 — 実装時に UI 文言として OT 確認(§12-6)。

## 8. 触る箇所の全列挙(2026-08-14 前提確認レポートの sort_key 参照一覧を正とする)

- **DB**: migration 0037(§3)/ `lib/db/schema.ts:312, 358`
- **server**: `lib/exams/list.ts`(×2 + 型)/ `lib/db/cards-mapper.ts`(両方向 + base_order)/ `lib/cards/apply-card-mutation.ts` / `lib/cards/card-field-handlers.ts` / `lib/cards/domain/card-rules.ts` / `lib/sync/shared/mutation-schemas.ts`
- **validation**: `lib/validation/card.ts` — `sortKeySchema` → `questionLabelSchema`(内容不変: max 100 / nullable)
- **OCR**: `lib/ai/prompts/ocr-extract.ts`(順序指示 1 行のみ)/ `lib/ocr/normalize-prepared.ts` / `lib/ocr/prepared-schema.ts` / `publish-prepared-plan.ts` / `publish-prepared.ts`(max 取得)。**無改変**: `ocr-response.ts` / `ocr-image-crop-response.ts` / `lib/ai/ocr.ts`(legacy・到達不能)— wire 名維持(D-8)
- **client**: `lib/client-db.ts` / `lib/cards/sort-like-server.ts`(置換・新 comparator へ)/ `next-card-sort-key.ts`(削除)/ 順序 domain module(新設)/ `empty-card.ts` / `build-new-client-card.ts` / `card-write.ts` / `get-custom-session-cards.ts`
- **UI**: §7 の 8 file
- **test 追随**: `tests/fixtures/pull.ts` / `tests/fixtures/entity-mutations.ts` / `tests/integration/pg/setup/fixture.ts` ほか cards INSERT を持つ iso(base_order 供給)/ `check-constraints.test.ts`(CHECK 追加)/ OCR golden fixtures(`mock-exam-page1.expected-cards.json` = normalize 出力側のみ rename。**wire 側 `mock-exam-page1.response.json` は D-8 により不変**)/ 既存 unit の rename 追随

## 9. deploy 順と切替窓(決定 8)

**migrate 0037 先行 → deploy** の一方向。窓中の失敗は全て loud で許容(ゼロユーザー・ゼロトラフィック):

- 旧 code → 新 schema: create INSERT が base_order 不供給 → **23502**(per-mutation failed / publish 失敗が台帳・Discord に乗る既存経路)。
- 旧 client bundle → 新 server: create patch に base_order 欠落 → zod で per-mutation failed。旧 field 名 `sort_key` の update_field → dispatch 失敗で per-mutation failed。
- expand-contract(nullable 追加 → backfill → NOT NULL 化)を採らない理由は §1.1-8 に明記のとおり。**この判断はゼロユーザー前提に立つ一回性のものであり、公開後の schema 変更の前例にしない**。

## 10. テスト戦略

1. **comparator unit**: `compareByBaseOrder`(base_order 昇順 / id tiebreak / 重複 base_order でも決定的)・`compareByQuestionLabel`(文字列 ASC + NULLS LAST + (base_order, id) tiebreak)・§2.5 exam 跨ぎ版。
2. **server/client 一致(iso)**: shuffle した base_order + uuid で N 行 INSERT → PG `ORDER BY base_order, id` の結果列と JS comparator でソートした列の**完全一致**を assert。uuid 文字列比較 = PG uuid byte order の pin を兼ねる(D-3 の検証)。
3. **採番 unit**: `nextBaseOrders` — 空(max null)→ `[1024]` / 既存 max=3072, count=3 → `[4096, 5120, 6144]`。
4. **publish 採番(iso)**: 空 exam への publish(S から配列順)/ **既存 cards がある exam への追加 publish(max の続きから)**/ INSERT 後の `ORDER BY base_order, id` が prepared 配列順と一致。
5. **CHECK red**: `check-constraints.test.ts` の POSITIVE_CASES に `cards_base_order_positive` を追加(legal `1` / illegal `0`, `-1` / nullAllowed false)。
6. **create wire**: base_order 欠落 patch → per-mutation failed(bulk route / registry test)。
7. **決定 6 の pin**: `question_label` の update_field handler が base_order 列に触らない(SET 句 assert)。
8. **手動追加**: `buildEmptyCard` が `questionLabel: null` + 末尾 base_order を返す(旧 `nextCardSortKey` テストは削除)。

**gate**(kickoff 指定): `pnpm lint`(whole-repo, --max-warnings=0)→ `typecheck` → `build` → `test` → `test:iso` 全 exit 0。sprint 完了時は CLAUDE.md 共通 gate(`pnpm run audit` 含む)に従う。schema 変更 sprint のため `pnpm install --frozen-lockfile` 系は対象外(依存不変)、Next 設定 file も不触。

## 11. scope 外(明記)

- 試験間移動・集約 move op・undo・切り出し・結合(**Grid-3**)。§2.3-2/3(位置挿入・再採番)の**実装**も Grid-3。
- 行 DnD(Grid-3 直後の小 sprint)。
- 試験名 inline 編集(Grid-3)。
- `base_order` の update_field handler 追加(Grid-3 — 契約は §2.4)。
- OCR 出力順そのものの機械的検証・矯正(§5.2 のとおり応答配列順を正とする)。

## 12. OT 確認点(spec が新たに確定した判断 — 承認時に併せて裁定)

1. **D-1/D-2**: integer + S=1024 + CHECK(>=1)+ **UNIQUE なし**(重複容認 + id tiebreak)— §2.1-2.2
2. **D-6**: base_order の書き手を create 経路に限定(update_field 化は Grid-3)— §2.4
3. **D-7**: カスタム演習 sequential の exam 跨ぎ順 = exam_id ASC(created_at 順は不採用)— §2.5
4. **D-8**: Gemini wire の field 名 `sort_key` 維持(rename は normalize 境界から)— §5.1
5. **D-5**: Dexie version bump なし(index 非追加)— §6.1
6. UI 文言: ラベル列の表示名「ソートキー」→「番号」(仮)— §7
7. **ラベル列ソートの tiebreak 変更**: kickoff は「現行の文字列比較を残す」だが、tiebreak のみ `created_at` → `(base_order, id)` に変える(created_at は publish 単位で同値になり tie を解決できない — §0 実測)。第 1 キーの文字列比較 + NULLS LAST は不変 — §6.2
