# S1.9.1 sprint — OCR 月次 counter 分離 + schema 整理 + R2 cleanup (2026-05-20)

> S1.9 後の追加 fix sprint。 Bug A (OCR カウンタが「やり直す」 で返金され月次
> 上限が事実上バイパス可能) の構造解決 + 周辺 schema 整理 + R2 関連 cleanup。
> Bug B (「ファイル変更」 後の「抽出中」 残留) は S1.9.2 で別扱い。

---

## 完了内容 (3 commit)

| # | hash | type | 概要 |
|---|---|---|---|
| 1 | `6df2fd9` | fix(usage) | upload_records 新設 + source_documents 整理 + counter 分離 |
| 2 | `c98282d` | docs(spec) | Tech Spec を inline OCR / upload_records に整合 |
| 3 | (本 commit) | docs(session) | 本 session log |

commit 1 は `[no-review]` provisional。 重要 Fix 該当 (schema 変更 + DB DELETE
経路変更 + cascade 依存) のため、 OT staging smoke (下記 1-10) pass 後に
`[reviewed]` へ amend する。 commit 2 / 3 は docs。

---

## Bug A の構造と採用方針

### 構造欠陥

月次 OCR quota が `SUM(source_documents.pages_processed)` で計算され、
`discardUpload` が source_documents を物理削除すると SUM の集計元が消える =
quota が返金される。 「やり直す」 を N 回繰り返すと実 Gemini API call は N 回
発生するのに月次 quota は最新 1 件分のまま → 月次上限を事実上バイパス可能。

S1.7 で「quota = source_documents SUM」 を採用した時点で潜在化、 S1.9 smoke で
顕在化 (S1.9 regression ではない)。

### 採用方針: 案 Y (upload_records 新設)

source_documents が「OCR ジョブ作業 table」 と「カウンタ集計元」 の二役を兼ねて
いたのを分離:

- `source_documents`: OCR ジョブ作業 / trace。 exam と同寿命、 FK CASCADE で消える
- `upload_records` (新規): 月次利用台帳。 OCR 完了 / 失敗時に append-only、
  exam から独立、 discard で一切 touch しない → 月次消費は monotonic

### 不採用案: 案 X (SET NULL + soft delete)

discardUpload で source_documents を soft-delete し集計に残す案は却下。 理由:
- `source_documents.exam_id` が `ON DELETE CASCADE` のため、 exam を hard-delete
  すると soft-delete した source_documents 行も cascade で物理削除され、 soft
  delete が無効化される (counter が結局返金される)
- `deleted_at` を「除外しない」 集計にする反直感性 — 将来開発者が `WHERE
  deleted_at IS NULL` を足すと静かに返金バグが復活する schema 負債
- counter を source_documents から切り離せば、 discard は cascade に乗って
  自由に hard-delete でき、 entanglement が消える (案 Y の優位)

---

## 実装詳細

### schema (`lib/db/schema.ts` + migration 0004)

新規 `upload_records`:
- `id` / `user_id` (FK users CASCADE) / `filename` / `file_size_bytes` /
  `pages_processed` / `ocr_cost_yen` numeric(10,4) / `status`
  ('completed'|'failed') / `created_at`
- index `(user_id, created_at)` — 月次 SUM 用
- `exam_id` は持たない (台帳は exam から独立)

`source_documents` 整理:
- `file_url` 列 drop (R2 にスキャン元を保存しない方針、 元々常に null)
- `ocr_cost_yen` `integer` → `numeric(10, 4)` (mode:'number'、 cost 小数化)
- `status` enum 4→3 値 (`'uploading'` 廃止)、 default `'processing'` に
- R2 関連コメント削除

migration `0004_organic_starhawk.sql` を `pnpm db:generate` で 1 本生成。
production active user 0 件のため backfill 不要。 `'uploading'` 廃止は drizzle
`$type` (TS のみ、 DB CHECK なし) のため migration には出ない (正常)。

### process.ts

- OCR 完了時: `db.transaction` で source_documents UPDATE (status='completed')
  + upload_records INSERT (status='completed') を 1 transaction (atomic)
- OCR 失敗時: `markFailed` を audit object 受け取りに拡張、 source_documents
  UPDATE (status='failed') + upload_records INSERT (status='failed') を
  1 transaction。 best-effort (失敗しても throw せず logger.warn)
- markFailed 3 呼び出し箇所に audit 値: file read / pipeline 失敗は pages=0
  cost=0、 cards INSERT 失敗は実発生値 (pages=totalPages、 cost=実 cost)
- source_documents INSERT から `fileUrl: null` 除去

#### failure path の upload_records 計上方針

失敗も `status='failed'` で台帳に append する (監査として正確)。 ただし月次
quota SUM は `status='completed'` で絞るため、 failed 行は消費に計上されない。
「失敗は記録するが課金枠は消費しない」 を構造的に担保。

### ai-usage-mcq.ts

- `getCurrentMonthOcrPages` の SUM 対象を source_documents → upload_records に。
  WHERE `user_id` + `status='completed'` + `created_at` が当月 (JST 月境界) 内
- S1.7 の stale processing 除外ロジック (`staleProcessingCutoff` /
  `STALE_PROCESSING_MINUTES`) を撤廃。 upload_records は完了/失敗時 append のみで
  processing 状態の行が存在しないため不要
- `canRunOcr` signature 不変、 `jstMonthBoundsUtc` 維持

### discard.ts — cascade 連鎖の整理

S1.9 の NOT EXISTS guard を完全撤廃し FK CASCADE に委譲:

- **mode='new'** (autoCreatedExamId あり): `DELETE exams WHERE id + user_id` の
  1 文。 `source_documents.exam_id` / `cards.exam_id` の `ON DELETE CASCADE` で
  source_documents と cards が DB 連動削除 (単一文のため cascade 含め atomic)。
  exam ごと消えるため S1.9 で直した「空 exam 残骸」 も再発しない
- **mode='existing'** (autoCreatedExamId なし): exam は既存ユーザー資産のため
  残し、 cards + source_documents のみ transaction で手動削除
- 所有者確認 SELECT 維持、 exam / source_documents DELETE とも WHERE user_id
  でテナント保護
- `upload_records` は両 mode で一切 touch しない (= 月次 quota 返金が原理的に
  起きない、 Bug A 解消の本体)

---

## review

- 経路: `superpowers:requesting-code-review` skill + general-purpose subagent、
  template 改変なし
- base / head: `cac6d61` → staged working tree (10 file)
- 結果: **Critical 0 / Important 0 / Minor 3**
- 対応:
  - M1 (markFailed catch コメント明確化) → S1.9.1 で月次 quota が
    upload_records 集計に移ったため source_documents 残骸が消費に影響しない旨を
    1 行追記
  - M2 (upload-form.tsx の stale 関連コメント陳腐化) → 本 sprint で stale 排除
    ロジックを撤廃したため事実矛盾。 prop JSDoc と runProcess コメント 2 箇所を
    upload_records 集計に整合 (commit 1 に含む)
  - M3 (discard mode='existing' の cards delete に user_id ガードなし) →
    **不対応**。 所有者確認 SELECT で source_document の所有者を user に限定済、
    cards は単一所有の source_document に紐づくため越境不可。 追加は起こり得ない
    scenario への防御 (CLAUDE.md「不要な validation を足さない」)、 reviewer も
    「MVP では不要」 と明記
- assessment: 「With fixes (Minor のみ、 fix 任意)」

---

## test 推移

- S1.9 末: 335 passed
- S1.9.1 末: 332 passed
  - `ai-usage-mcq.test.ts`: staleProcessingCutoff describe 撤廃で -3
  - `discard.test.ts`: cascade 設計に書き換え (5 test 維持、 内容更新)
  - `process.test.ts`: mock に transaction 追加、 completed/failed 両 path で
    upload_records append を assert (test 数不変、 assertion 追加)
- build: pass、 tsc: clean

### test の検証限界 (明示)

- `discard.test.ts`: FK CASCADE は DB 任せのため mock では検証不能。 unit test
  は「どの table に DELETE が発行されたか」 (mode='new'→exams 1 文 /
  mode='existing'→cards+source_documents) と「upload_records が touch されない」
  までを検証。 cascade で実際に source_documents/cards が消えることは staging
  smoke 9 で確認
- `process.test.ts`: transaction mock は tx を db と同 API で渡す。
  upload_records INSERT は status 持ち判別で実 INSERT を捕捉 (mock theater 回避)

---

## OT staging smoke (commit 1 の [reviewed] amend 前提)

### Bug A 解消確認 (最重要)

1. 新規 sign-up → /app/upload で残量 30/30
2. mode='new' 10 page submit → 完了 → preview → 残量 20/30
3. 「同じファイルでやり直す」 → 完了 → preview → **残量 10/30** (返金されない)
4. もう 1 回「やり直す」 → 完了 → preview → **残量 0/30**
5. もう 1 回「やり直す」 → **canRunOcr で QUOTA_EXCEEDED ブロック**

### 既存挙動回帰

6. mode='new' submit → 「試験一覧へ」 → exam が /app/exams に保存される
7. mode='existing' で既存 exam に submit → 「やり直す」 → 既存 exam / 既存
   cards は無事、 今回分のみ削除
8. 削除フロー (S1.9 task 1): settings → 削除 → reverification → 完了 →
   /sign-out-deleted (回帰なし)
9. 空 exam fix (S1.9 task 2): mode='new' で「やり直す」 後 /app/exams に
   0 cards exam が残らない (cascade 経由でも正常)

### upload_records 台帳確認 (Neon)

10. `SELECT * FROM upload_records WHERE user_id = ?` → smoke 中の OCR 実行分
    だけ row が積み上がる (discard で消えない、 status / pages / cost が正しい)

### push / amend

OT が host WSL から push → migration `0004` を staging DB に apply
(`pnpm db:migrate` 相当) → staging smoke (1-10) 全 pass → commit 1 を
`[no-review]` → `[reviewed]` amend → main merge → production migration apply
→ production smoke。

---

## 起動コマンド

```bash
pnpm dev                # /app/upload で OCR / やり直し
pnpm test --run         # 332 passed
pnpm build              # production build
pnpm db:migrate         # migration 0004 を DB に apply (OT 実施)
```

---

## out of scope (S1.9.2 以降)

- Bug B (「ファイル変更」 後の「抽出中」 残留、 result page 構造の整理)
- 編集用画像 R2 経路 (Logic 2) の実装 — 将来機能
- `source_documents` の rename (upload_records への改名はしない、 両方残す)
- ai_usage / ai_usage_users の整理 (用途違い、 Tech Spec の文言修正のみ実施済)
- 既存 user data の backfill (production active user 0 件で不要)
