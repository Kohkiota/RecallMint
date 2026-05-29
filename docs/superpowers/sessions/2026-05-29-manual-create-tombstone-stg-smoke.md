# 試験/カード手動作成 + 削除 + tombstone — stg 実機 smoke 結果

- 日時: 2026-05-29 (14:30〜14:45 GMT)
- 種別: session log / stg smoke (実装変更・commit なし、 結果 doc のみ)
- 対象 stg: `https://stg.recallmint.nekotest.net` (deploy `dpl_FEACJ8eZZSfaLmwLGsHQQzbq7Nm9`、 origin/develop `6fa6f31` 反映済)
- 対象実装: Task1-6 (00cd34f / f4eeadf / 18f70c0 / b7f9af3 / 550e99a / 6fa6f31)
- account: `komail9server+001@gmail.com` (既存 Clerk セッション生存、 2FA hand-off 不要だった)
- 手段: chrome-devtools MCP (Playwright 同等) + DevTools Network
- **結論: Task3/4/5/6 の正常系は全て PASS。 ただし判断要の異常 1 件 = 「0 件の手動試験にカード追加ボタンが出ず、 最初の 1 枚を追加できない」 (手動作成フローの致命的ギャップ)。 DB 行確認・多 card cascade+N+1 は OT runbook (§OT)。**

---

## 0. 環境・前提確認

- deploy: `x-deployment-id: dpl_FEACJ8eZZSfaLmwLGsHQQzbq7Nm9`。 RSC payload に `ReviewFlushTrigger` 等の新 component chunk 含む = 新コード反映確認。
- region: deleteExam server action (reqid=946 `POST /app/exams`) の **x-vercel-id `hnd1::hnd1::f57jn-...` = function 東京 (hnd1)** (item 1)。 全 server action 同 region。
- **tombstones テーブル存在**: 直接 DB query は OT 担当 (§OT)。 ただし Task5 (deleteCard) / Task6 (deleteExam) が **tombstones への INSERT を含む tx で 200 / `{ok:true}` を返した**事実が、 テーブル不在なら `relation "tombstones" does not exist` で 500 になるはずである点から、 **0014 適用済 = テーブル存在を間接実証**。

---

## 1. 試験手動作成 (Task3) — ✅ PASS

- `/app/exams` 一覧上部「手動で試験を作成」 → 試験名入力フォーム展開。
- **validation (server zod、 live)**:
  - 空白のみ (`"   "`) → inline error **「試験名は必須です」**、 invalid=true、 遷移なし。
  - 201 文字 → inline error **「試験名は 200 文字以内で入力してください」**、 遷移なし。
- **有効作成**: name「Smoke手動試験A」 → 作成 → **`/app/exams/1bf2edb8-cfc3-4c95-8703-62e2e67045f8` (詳細) へ遷移**、 「カード (0 件)」。
- **一覧表示 (item 1)**: 「Smoke手動試験A / カード 0 件」 が一覧に表示。 **source_documents 行なし → status バッジ非表示** (getActiveExamsWithCardCount は exams 単体 SELECT、 ExamStatusBadge は entry なしで null = 設計通り破綻なし)。

## 2. カード手動作成 + autoEdit (Task4) — ✅ PASS

(0 件手動試験ではボタンが出ないため、 カードを持つ既存 OCR 試験 `27a7ddb5` (39 件) で検証)

- 「＋ カードを追加」 → **cardCount 39 → 40** (header「カード (40 件)」)。
- **autoEdit**: 新 card の **問題文セルが editing モードで focus**された textarea (`aria-label=問題文 編集`, focused, `value="(問題文を入力してください)"`)。 他セルは display。
- **placeholder 値** (evaluate で確認):
  - title = **「新規カード 40」** (nextCardTitle, existingCount 39 → 40)
  - sortKey = **「40」** (nextCardSortKey, OCR の混在 key → fallback length+1)
  - questionText = **「(問題文を入力してください)」**
  - 選択肢 = **1 件** (placeholder option、 削除 disabled = 最後の 1 個)
- **inline 編集可**: 問題文 textarea に「smoke: 手動追加カードの問題文」 を入力 → 受理 (既存 update-card-field 経路、 非回帰)。

## 3. カード削除 + tombstone (Task5) — ✅ PASS

- 上記で追加した card の削除導線 → **2 段 confirm**「このカードを削除しますか?」「カードと学習履歴が削除され、 元に戻せません。」 [削除する][キャンセル]。
- 「削除する」 → **cardCount 40 → 39**、 card 一覧から消滅。
- delete が 200 成功 = **tombstones への card 行 INSERT 成功** (テーブル存在の間接実証)。
- 「最後の 1 枚も削除可」: unit test + 「Smoke手動試験A」 が card 0 件で存在できた事実で担保 (live で 1 枚 exam を 0 にする破壊は実施せず)。

## 4. 試験削除 + tombstone (Task6) — ✅ PASS (0 件 exam で live、 多 card は §OT)

- 一覧で「Smoke手動試験A」(0 件) の削除 → **2 段 confirm**「この試験を削除しますか?」「含まれるカードと学習履歴もすべて削除され、 元に戻せません。」 [削除する][キャンセル]。
- 「削除する」 → server action `POST /app/exams` reqid=946 → **200 / response `{"ok":true}`**、 一覧から消滅 (3 → 2 件)、 x-vercel-id `hnd1::hnd1`。
- deleteExam tx (exam tombstone INSERT 含む) が成功 = **tx 経路 + exam tombstone 記録が stg で稼働**。
- **多 card 試験の cascade (cards/source_documents/reviews 物理削除) + tombstone 件数照合 (N+1) は live 未実施** → OCR 試験を破壊せず OT が DB で検証する手順を §OT に整理 (DB query は元来 OT 担当)。

## 5. 観測 (serializeDbError) (item 5) — code 確認

createCard / deleteCard / deleteExam の catch に `serializeDbError` 配線済 (Task4-6 の code review で type-correct 確認、 createCard は examId を logger payload で保持)。 **正常系では出力されない**ため smoke では非顕在 (今回も異常ログなし)。 異常時の可視化は OT が Vercel log で `exams.delete.failed` / `cards.*.failed` 系を確認可能。

## 6. 非回帰 (item 6) — ✅ 観測範囲で正常

- 既存 OCR 試験 2 件 (13/39 件) が一覧・詳細とも従来通り表示 (選択肢・正解・inline 編集 cell)。
- inline 編集 (S2.0b) で問題文 textarea が入力受理。
- dashboard「今日の学習問題数 15 / スマート復習 47 件」 表示 (Dexie 由来、 従来通り)。
- 演習 (smart review) は本変更と無関係のため再 smoke せず (別途 review-events smoke でカバー済)。

---

## ⚠️ 判断要の異常 (1 件)

### A. 【要修正】 0 件の手動試験にカード追加ボタンが出ず、 最初の 1 枚を追加できない

- 事象: 手動作成直後の試験 (card 0 件) の詳細 `/app/exams/[id]` は、 空状態として **「この試験にはまだカードがありません。」 + 「アップロードから追加」 (OCR への link) のみ**を表示。 **「＋ カードを追加」 ボタンが出ない**。
- 根因 (実コード): `app/(app)/app/exams/[id]/page.tsx:60-73` が `cards.length === 0 ? <空状態(アップロード導線のみ)> : <InlineCardList examId={id} cards={cards} />`。 **Task4 の「＋ カードを追加」 ボタンは `InlineCardList` 内**にあるため、 0 件分岐では描画されない。
- 影響: **手動作成フロー (項目2→項目3) の核 = 「空試験を作って手動でカードを足す」 が成立しない** (最初の 1 枚を UI から追加できない)。 1 件以上ある試験 (OCR 由来等) では正常 (Task4 検証済)。
- spec との関係: spec §5 は「card 0 件の exam 詳細: InlineCardList は cards.map で 0 件描画 + 『＋ カードを追加』 ボタンのみ表示 (空でも破綻しない)」 を**意図**していたが、 page.tsx の 0 件分岐 (manual 作成以前からの OCR 向け空状態) が未更新で意図と乖離。 Task4 の review でも見逃し (page.tsx の diff は examId 受け渡しのみ、 0 件分岐は未着手)。
- 提案 (実装は本 smoke 対象外): page.tsx の 0 件分岐で `InlineCardList` を描画する (cards=[] でも「＋ カードを追加」 が出る) か、 空状態 card に「手動でカードを追加」 ボタンを足す。 follow-up fix task として要対応。

判断必要: **yes** (A の follow-up fix を起票するか)。

---

## OT runbook (実 DB 確認 — Supabase で実行)

DB 行確認・件数照合は OT 担当。 以下を Supabase SQL で:

1. **tombstone 記録 (Task5/6 の live 削除分)**:
   - `SELECT entity_type, entity_id, deleted_at FROM tombstones WHERE user_id = '1231f42d-9c9f-4edb-addd-104890193571' ORDER BY created_at DESC LIMIT 20;`
   - 期待: 本 smoke で削除した card (39件試験 27a7ddb5 に追加→削除した「新規カード 40」) の `entity_type='card'` 行 1 件 + 削除した exam「Smoke手動試験A」(`1bf2edb8-...`) の `entity_type='exam'` 行 1 件。
2. **多 card 試験の cascade + N+1 (live 未実施、 OT が実行)**:
   - 対象 exam を 1 つ選び (例: 13 件の `ff5f3091-...`)、 削除前に `SELECT count(*) FROM cards WHERE exam_id='ff5f3091-...';` で N を記録。
   - UI で当該 exam を削除 (2 段 confirm)。
   - `SELECT count(*) FROM cards WHERE exam_id='ff5f3091-...';` = 0 / `SELECT count(*) FROM source_documents WHERE exam_id='ff5f3091-...';` = 0 (cascade 物理削除)。
   - `SELECT entity_type, count(*) FROM tombstones WHERE entity_id='ff5f3091-...' OR entity_id IN (削除前 card ids) GROUP BY entity_type;` → **exam 1 + card N = 計 N+1 行**。
   - 同 exam を再削除 (idempotent) → tombstone 行数が増えない (`onConflictDoNothing`)。
3. **cardCount 整合 (§3.6)**: `SELECT id, card_count, (SELECT count(*) FROM cards c WHERE c.exam_id = e.id) AS actual FROM exams e WHERE user_id='...';` → 全 exam で `card_count = actual`。
4. **serializeDbError**: 異常時のみ。 Vercel log で `event: exams.delete.failed` / `cards.create_card.failed` 等 + native pg error フィールドが出ることを (障害時に) 確認。

> 註: 本 smoke で test account に「新規カード 40」 を 27a7ddb5 へ追加→削除 (差し引きゼロ)、 「Smoke手動試験A」 を作成→削除 (差し引きゼロ) した。 試験一覧の見かけ上の card 件数 (13/39) は smoke 前と同じ。 27a7ddb5 詳細末尾に**以前のテストの空 placeholder card が複数残存** (選択肢 1 件の card 群) を確認したが、 本 smoke の生成物ではない (既存データ noise)。

## 計測識別子

| 軸 | 値 |
| --- | --- |
| deploy | `dpl_FEACJ8eZZSfaLmwLGsHQQzbq7Nm9` |
| deleteExam x-vercel-id | `hnd1::hnd1::f57jn-1780065743495-a5e2de9e7ee6` (14:42:23 GMT) |
| dbUserId | `1231f42d-9c9f-4edb-addd-104890193571` |
| 作成→削除した手動試験 | `1bf2edb8-cfc3-4c95-8703-62e2e67045f8` (Smoke手動試験A) |
| Task4/5 対象 OCR 試験 | `27a7ddb5-6261-4512-9f89-7e12df3b36e4` (39 件) |
