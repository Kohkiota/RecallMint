# S1.9.2 sprint — result page 分離 + source_documents.mode + OCR cost 小数化 (2026-05-20)

> S1.9.1 closure 後の追加 sprint。 Bug B (preview からの遷移で残量 stale 表示) の
> 構造解決 + button 整理 + S1.9.1 scope 漏れ follow-up (cost 小数化) を統合。

---

## 完了内容 (4 commit)

| # | hash | type | 概要 |
|---|---|---|---|
| 1 | `fa28bfe` | fix(upload) | source_documents.mode 列追加 + discard 整合 |
| 2 | `4029bda` | fix(upload) | result page 分離 + button 整理 |
| 3 | `5ee88bd` | fix(ai) | OCR cost 小数化 |
| 4 | (本 commit) | docs(session) | 本 session log |

commit 1/2/3 は重要 Fix 該当 (schema 変更 + DB DELETE 経路変更 + owner-scoped
query 新設) のため当初 `[no-review]` provisional で作成。 OT staging smoke
(下記 1-15) 全 pass + Neon 確認 OK を受け、 `[reviewed]` で再作成済
(旧 hash c411930 / 1328dff / 5ec0b4e からの reword)。 commit 4 は docs。

---

## Bug B の構造と採用方針

### 構造

`/app/upload` の残量 banner 値 `remaining` は Server Component が初回 render
時に確定し prop として client component に渡す。 client インスタンス内では固定。
「ファイル変更」 後 `setPhase('idle')` で banner が即座に古い prop 値で描画され、
`router.refresh()` 完了まで stale 表示が滞留する race condition。

### 採用方針: result page 分離

preview を独立 route `/app/upload/result/[sourceDocumentId]` に切り出し、
`/app/upload` は idle (ファイル選択) のみを描画。 OCR 成功 → result page へ
`router.push`、 「破棄して再アップロード」 → `/app/upload` へ `router.push`。
**page 遷移ごとに fresh server render** されるため、 client が server data を
prop として抱え込む構造が消え、 stale 表示が原理的に発生しない。

---

## task 1: source_documents.mode 列追加

discard が「mode='new' で auto 作成 exam を cascade 削除 / mode='existing' で
既存 exam を残す」 を判定する根拠を、 client 持ち回りの `examWasAutoCreated`
引数から **`source_documents.mode` 列** に移行。 server が DB から読むため
URL / client 改竄に堅牢。

- schema: `source_documents.mode` (`'new' | 'existing'`, NOT NULL, default なし)
- process.ts: source_documents INSERT で `mode: destination.mode` を set、
  `ProcessResultData.examWasAutoCreated` を撤廃
- discard.ts: `discardUpload(sourceDocumentId)` の 1 引数化。 所有者確認 SELECT
  で mode + examId を取得し分岐。 revalidate scope を `'/', 'layout'` →
  `/app/upload` + `/app/exams` に縮小

### migration 0005 の hand-edit (重要)

drizzle-kit generate は素の `ADD COLUMN "mode" text NOT NULL` を出力するが、
既存 row があると NOT NULL 違反になる。 **3 段形式に hand-edit**:

```sql
ALTER TABLE source_documents ADD COLUMN mode text;
UPDATE source_documents SET mode = 'existing' WHERE mode IS NULL;
ALTER TABLE source_documents ALTER COLUMN mode SET NOT NULL;
```

- production active user 0 件だが staging に test row が残る可能性への対処。
  空 / 非空どちらでも安全
- backfill 値 `'existing'` = 保守側 (旧 row が万一 discard されても auto-created
  exam の cascade 削除を起こさない)
- drizzle snapshot は最終形 (mode NOT NULL) を表すため hand-edit と整合、
  `drizzle-kit check` で drift なしを確認済

---

## task 2: result page 分離 + button 整理

- 新規 route `app/(app)/app/upload/result/[sourceDocumentId]/page.tsx`
  (Server Component): owner-scoped で source_document + cards を DB 取得、
  不在 / 他 user は `notFound()`
- 新規 `result-actions.tsx` (Client Component): button 2 つ
  - 「保存して試験一覧へ」: `<Link href="/app/exams">` (cards は OCR 完了時点で
    DB 確定済、 確定処理不要)
  - 「破棄して再アップロード」: `useTransition` で `discardUpload` →
    `router.push('/app/upload')`。 押下中は「破棄しています…」 spinner
  - **「同じファイルでやり直す」 は廃止** (File オブジェクトが page navigation
    で消えるため成立しない、 retry の主目的は error phase 側)
- `lib/exams/list.ts`: `getSourceDocumentForUser` (owner-scoped、 exams INNER
  JOIN で examName) / `getCardsForSourceDocument` を新設、 owner-isolation
  test 4 件追加
- `upload-form.tsx`: `Phase` を `idle | submitting | error` の 3 値に縮約
  ('success' 廃止)。 OCR 成功時 `router.push` で result page へ。
  `ResultPreview` / `handleRetry` / `handleChangeFiles` を削除

### 「抽出中」 banner 流用問題の解消

旧来 `handleChangeFiles` が discard のみの経路でも `phase='submitting'` を流用し
OCR 用「抽出中」 banner を出していた問題は、 result page 分離で構造的に消滅
(result page と upload page が phase enum を共有しない)。 「破棄しています…」
は result-actions.tsx 固有の文言。

---

## task 3: OCR cost 小数化

`lib/ai/cost.ts` の `estimateCostYen` が `Math.round(usd * JPY_PER_USD)` で
integer 丸めしていたため、 numeric(10,4) 列 (S1.9.1) に格納しても小数部が常に
0、 1 ページ規模の sub-yen コストが 0 円に潰れていた。

`Math.round(x * 10000) / 10000` の 4 桁丸めに変更。 test 期待値を小数に更新
(1688→1687.5 / 1→0.825 / 0→0.045 / `ocr.test.ts` 83→82.5)。

task 1/2 とは完全独立 (cost.ts + test のみ touch)。

---

## review

- 経路: `superpowers:requesting-code-review` skill + general-purpose subagent、
  template 改変なし
- base / head: `ab32974` → staged working tree (16 file)
- 結果: **Critical 0 / Important 0 / Minor 3**
- 対応:
  - M3 (upload-form.tsx の amber banner コメントが削除済 `ResultPreview` を参照)
    → result-actions.tsx 参照に修正 (commit 2)
  - M1 (`result page.tsx` の `if (!user) return null` が middleware 保護で
    実質到達不能) → **不対応**。 他 (app) page (`exams/[id]` 等) と一貫した
    defensive guard、 reviewer も「記録のみで可」
  - M2 (process.ts の revalidate scope を縮小していない非対称) → **不対応**。
    kickoff が「process は触らない」 を明示、 reviewer も「将来 cleanup 候補、
    記録のみ」
- assessment: 「With fixes (Minor のみ — 任意)」

---

## test 推移

- S1.9.1 末: 332 passed
- S1.9.2 末: 336 passed (+4)
  - `discard.test.ts`: mode 分岐 (new/existing) に書き換え (5 test 維持)
  - `process.test.ts`: mode INSERT assertion に書き換え
  - `list.owner-isolation.test.ts`: 新規 query 2 本の owner-isolation +4 test
  - `cost.test.ts` / `ocr.test.ts`: cost 期待値を小数に更新
- build pass、 tsc clean

### 検証限界 (明示)

- result page (Server Component) + ResultActions の page 層 unit test は無し。
  owner-scoped query 2 本を owner-isolation test 4 件でカバー、 page 層は
  staging smoke 任せ (Server Component の DB fetch + notFound() は smoke で確認)

---

## OT staging smoke (15 シナリオ全 pass + Neon 確認 OK — [reviewed] 化済)

### Bug B 解消確認 (最重要)

1. 新規 sign-up → /app/upload で残量 30/30
2. mode='new' で 10 page submit → OCR 完了 → `/app/upload/result/...` に自動遷移
3. result page で結果確認 (cards / examName 表示)
4. 「破棄して再アップロード」 → 「破棄しています…」 spinner (OCR 用「抽出中」
   文言は出ない) → `/app/upload` 遷移 → 残量 **30/30 で正しく表示** (stale なし)

### button 整理確認

5. mode='new' 10 page submit → result page →「同じファイルでやり直す」 button が
   **存在しない**
6. result page に「破棄して再アップロード」 +「保存して試験一覧へ」 の 2 button のみ

### mode 別 cascade 動作

7. mode='new' 破棄: 新 user → mode='new' OCR → result →「破棄して再アップロード」
   → /app/exams に exam なし (cascade で exam + cards 消滅)、 Neon で
   source_documents の該当 row もなし
8. mode='existing' 破棄: mode='new' 1 件 OCR →「保存して試験一覧へ」 →
   /app/upload で mode='existing' 同 exam に追加 OCR → result →「破棄して再
   アップロード」 → /app/exams で既存 exam 無事、 1 件目 cards 無事、 2 件目のみ消滅

### 残量カウンタ整合性 (S1.9.1 回帰防止)

9. 新 user → mode='new' 10 page submit → result →「破棄して再アップロード」 →
   /app/upload で残量 **20/30** (upload_records に残る、 quota 返金されない)
10. もう 1 回 → 残量 **10/30** (累積消費)

### cost 小数化確認 (Neon)

11. smoke 中の upload_records を確認: `ocr_cost_yen` が小数値 (例: `1.6500` /
    `0.8250`)、 `2.0000` のような integer 丸めでない

### result page edge case

12. mode='new' OCR → result page URL コピー →「破棄して再アップロード」 →
    コピー URL を開く → **404**
13. 他 user の result page URL を直接開く → **404**

### S1.9 系 回帰防止

14. 削除フロー: settings → アカウント削除 → reverification → 削除完了 →
    /sign-out-deleted
15. 空 exam: mode='new' OCR →「破棄して再アップロード」 → /app/exams に
    0 cards exam の残骸なし

### push / amend (実績)

OT staging smoke (1-15) 全 pass + Neon の upload_records.ocr_cost_yen 小数値
確認 OK。 これを受け commit 1/2/3 を `[reviewed]` で再作成済
(fa28bfe / 4029bda / 5ee88bd)。 残: OT が host WSL から push → main merge →
production migration 0005 apply (`pnpm db:migrate`) → production smoke。

---

## 起動コマンド

```bash
pnpm dev                # /app/upload で OCR → result page
pnpm test --run         # 336 passed
pnpm build              # production build
pnpm db:migrate         # migration 0005 を DB に apply (OT 実施)
```

---

## out of scope (kickoff 通り)

- 「同じファイルでやり直す」 の保持 / 復活 (廃止確定)
- 「破棄しています…」 中の optimistic navigation (B1 = spinner 留まりで十分)
- File オブジェクト持ち回り設計
- discard 済 source_doc URL 用の専用 UI (404 で十分)
- Tech Spec の更新 (S1.9.2 完了後に別途、 OT or Claude Code が現場判断)
- process.ts の revalidate scope 縮小 (kickoff が process 不可触を指示)
- ai_usage / ai_usage_users の整理

S1.9.2 closure 後、 S1 シリーズ全体完了。 次は S2 問題管理 or S4 学習画面 を
OT が選択。
