# ②-4a source_assets ライフサイクル fact-finding(read-only・現物確認)

**日付**: 2026-08-03
**目的**: T14b commit 判断の前に、新要件「source(著作物疑い)を R2 に残さない」の下で source_assets ライフサイクルを現物確定する。実装変更なし・file:line 根拠付き・不明は「不明」。
**新 risk 軸(OT 確定)**: provenance 消失=許容 / **source が消え残る=受容しない(最優先)**。

---

## 結論(先に)

**現行 T14b(および関連経路)は新軸の下で source を確実に purge できない。** 逆に T14b の設計・レビュー修正群は「source を残す」方向に最適化されており、新軸と正面衝突する。主な消え残り経路は 6 本(§4)。**最重要 = (B) 正常完走 source は設計上 retain=永続 / (C) exam・退会削除で行だけ cascade 消滅し R2 は永久 orphan(GC が発見不能)**。到達不能論拠(§5)は新軸では moot(守っていた race が新軸では望ましい方向)。

---

## 1. grace / retention cap の定義

### grace(source R2 物理削除の遅延)
- **値**: `DEFAULT_GRACE_DAYS = 30`(`scripts/gc-image-assets.ts:103`)。単位=日。
- **起点・対象**: source lane promote の SQL 条件 `source_assets.created_at < now() - (graceDays * interval '1 day')`(`scripts/gc-image-assets.ts:815`)。起点列 = **`source_assets.created_at`**、対象 = source_assets 行(Class A reserved / Class B ready)。pure mirror = `isPastGrace`(`lib/media/domain/source-asset-state.ts:44-46`)。
- **上書き**: `--grace-days N`(`scripts/gc-image-assets.ts:1008`)。**prod ガード**: `VERCEL_ENV|NODE_ENV==='production'` かつ `n < DEFAULT_GRACE_DAYS(30)` は reject(exit 1)(`scripts/gc-image-assets.ts:981-984`)。
- **設定場所**: コード定数 + CLI 引数。**env / DB ではない**。

### retention cap(upload_operations の終端化)
- **値**: `PREPARED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000`(7 日)(`lib/exams/derive-exam-statuses.ts:34`)。単位=ms。
- **起点・対象**: **upload_operations**(source_assets ではない)。2 用途:
  1. `isLiveUploadOperationCondition()`: op が live = `status IN (awaiting_sources,claimed,prepared)` AND(`created_at > now() - retention` OR 有効 lease 保持)(`lib/exams/source-doc-status.ts:83-91`)。起点 = `upload_operations.created_at` / `lease_expires_at`。
  2. **T14a 7 日 cap**(claim/takeover 時): 非終端(awaiting/claimed/prepared)かつ無 lease の op が `created_at` から `PREPARED_RETENTION_MS` 超 → fenced に `terminal_failed` + payload NULL(`app/(app)/app/upload/_actions/claim-operation.ts:31-35, 113-114`)。**発火は claim/takeover が呼ばれた時のみ**(背景 sweep ではない)。
- **関連定数**(source_assets には非適用): `STALE_PROCESSING_MS = 15 分`(`lib/exams/derive-exam-statuses.ts:18`・legacy source_documents 'processing' 窓)/ `LEASE_TTL_MS = 15 分`(`app/(app)/app/upload/_lib/constants.ts:38`・lease 有効期間)。

### 両者の関係(どちらが先か)
- **別テーブル・別遷移に効く。競合せず逐次**: retention(7日・upload_operations)が「op を非live/終端にする」→ その後 source が T14b 適格になる → grace(30日・source_assets.created_at)経過 → 手動 GC 実行、の順。
- 不変条件 `grace(30) > retention(7)`(spec §11)は「op が終端になってから source を grace 適格にする」順序を担保(provenance/retry 順序のため)。**新軸ではこの順序が source 削除を最短でも ~30 日遅延させる**。
- **prod/stg 実値**: 同一(grace 30 日 / retention 7 日)。stg のみ `--grace-days 0` 可(prod は <30 拒否)。すべてコード定数。

---

## 2. GC の起動方式

- **手動 script のみ**: `pnpm tsx --conditions=react-server scripts/gc-image-assets.ts [--sweep] [--dry-run] [--user <id>] [--grace-days N]`(`scripts/gc-image-assets.ts:17-23`)。source lane は `main()` 末尾で `--sweep` 時のみ `runSourceReconciler` を呼ぶ。
- **cron / scheduled / API trigger は存在しない(現物確認)**:
  - `vercel.json` に `crons` キー無し(grep count 0)。
  - `app/api` に cron/gc route 無し(find 0 件)。
  - `@vercel/cron` / QStash / inngest / `setInterval` で GC を呼ぶ箇所 無し(grep 0)。
  - `.github` workflow 無し(node_modules 以外 0)。`package.json` に gc/cron script 無し。
  - production コードから GC script への参照 無し(コメント・docs のみ)。
  - → **prod / stg とも手動 script のみ・方式差なし**。
- **誰が・いつ**:
  - **誰 = OT 手動**: 「production 実行は OT が手動」(`scripts/gc-image-assets.ts:56`)。
  - **いつ = 不明(未定義)**: 実行頻度・トリガ・スケジュールを定めた runbook / ops doc は**存在しない**。ledger/handoff は「cron 化は post-cutover ops」(先送り)とのみ記載。→ **定期実行の保証は無い**。

---

## 3. source_assets の状態遷移全体像

- **状態**: `reserved | ready | deleting`(`lib/db/schema.ts:911-914`。`deleted` state は無い)。
- **作成契機**: `prepareUpload` が reserved 行(temp key `users/{uid}/src/tmp/{assetId}`)を作成(`app/(app)/app/upload/_actions/prepare-upload.ts:416`)。
- **reserved→ready**: `finalizeSource` の CAS(`app/(app)/app/upload/_actions/source-asset-actions.ts:219-238`)。最終 key `users/{uid}/src/{assetId}.{ext}` へ server PUT(immutable)。
- **削除されうる全経路**:
  | # | 経路 | 行 | R2 | 備考 |
  |---|---|---|---|---|
  | (i) | finalize の temp 削除 | temp 行は ready 化(残る) | **temp object のみ**削除 | `source-asset-actions.ts:285`・best-effort・**最終 source は残す**(finalize の目的) |
  | (ii) | T14b GC lane(手動) | deleting→行 DELETE | R2 delete | Class A(reserved-stale)/ Class B(terminal-op ready)のみ・`scripts/gc-image-assets.ts` source lane |
  | (iii) | exam 削除 cascade | 行 DELETE(cascade) | **削除しない** | `delete-exam.ts:87` → source_documents cascade(`schema:383 examId cascade`)→ source_assets cascade(`schema:903`)。soft-delete(deleting)化もしない |
  | (iv) | 退会(GDPR)cascade | 行 DELETE(cascade) | **削除しない** | `handle-clerk-event.ts:217` exams DELETE → 同 cascade chain。source_assets は Group I にも II にも明示列挙されない(§4-C) |
- **OCR/crop 正常完走時、source はいつ消えるか**: **消えない**。T14b Class B は `op.status='terminal_failed'` を要求し **completed op を除外(RETAIN)**(`source-asset-state.ts:96-107` + `gc-image-assets.ts:745-762`)。最終 source は R2 に永続(exam/退会削除まで・その時は行だけ消え R2 orphan 化)。
- **op 失敗・中断・放置時**: source が T14b 適格になるのは **op が終端化された後**のみ:
  - Class B(ready source): op が `terminal_failed` に**なってから**。terminal 化は (a) claim/takeover 時の 7 日 cap(`claim-operation.ts:31-35`・claim が呼ばれた時のみ)(b) prepareUpload supersede(次 upload 時・非 live op を terminalize)(c) 手動 abandonment sweep(`scripts/gc-abandoned-operations.ts`・T14a #3・R2 は触らない `:14`)。**いずれも自動背景実行ではない**。
  - Class A(reserved source): op が非 live(terminal / aged-out / 不在)になってから。

---

## 4. 消え残り経路の洗い出し(最重要)

新軸「source が R2 に残る=受容しない」で列挙:

- **(A) GC 手動ゆえ未実行なら全放置**: §2 の通り scheduler 皆無。OT が走らせなければ Class A/B 全対象が R2 に残り続ける。定期実行の保証は「不明(未定義)」。

- **(B) 正常完走 source は設計上 retain=永続【最重要】**: T14b は completed op の source を意図的に残す(§3)。**成功した全 upload の source(=著作物原本)が R2 に永続する**。新軸では最大の違反。旧軸(②-5 文書ライブラリ/dedup で source 再利用)の前提そのものが新軸と矛盾。

- **(C) exam 削除・退会で行だけ cascade 消滅 → R2 永久 orphan【最重要・非対称】**: (iii)(iv)で source_assets **行は cascade 削除されるが R2 object は削除されず、`assets` のような 'deleting' soft-delete もされない**。行が消える=object_key が失われる → **row 駆動 GC(`gc-image-assets.ts` は行が指す objectKey しか辿れない)が永久に発見不能**。→ GC を走らせても回収不能な永久 orphan。
  - 対比: `assets`(表示画像)は退会時 `status='deleting'` へ soft-delete し object_key を保全(`handle-clerk-event.ts:227-237`)。**source_assets は同等処理を持たない**(Group I 明示 11 表に不在・`handle-clerk-event.ts:166-190`)。
  - spec §6.3 / T15(GDPR Group I に upload_operations/source_assets 追加)は**未実装**(T14b の後の残タスク)。現状この穴は開いている。

- **(D) claim-lost / 中断 op の ready source**: op が `claimed`(lease 切れ・`terminal_failed` でない)の ready source は Class B 非該当(Class B は terminal_failed 要求)→ op が supersede / 手動 abandonment sweep で terminal 化されるまで GC されない。両者ともイベント/手動駆動ゆえ、放置ユーザーの source は terminal 化されず残り続ける。(`source-asset-state.ts:96-107`)

- **(E) finalize の temp/lost-CAS 削除失敗 = silent orphan**: `deleteObject(asset.objectKey)`(temp 削除・`source-asset-actions.ts:285`)と lost-CAS orphan 削除(`:271`)は **best-effort never-throw・戻り値未検査・リトライ/台帳なし**。失敗すると temp/最終 key が orphan 化し、行は既に最終 key を指す(temp)or 別行が勝った(lost-CAS)ため **row 駆動 GC が発見不能**。silent に諦める。

- **(F) T14b collect の R2 削除失敗**: 行を `deleting` のまま存置 + `integration_failures` 台帳記録 + 次 run リトライ(`scripts/gc-image-assets.ts:680-700`)。**silent ではない**が、リトライは手動 GC 再実行が前提。

### 削除失敗の扱い(まとめ)
- T14b collect = 台帳 + 次 run リトライ(§4-F)。
- finalize temp/lost-CAS = **silent best-effort・リトライなし**(§4-E)。
- cascade(exam/退会)= **そもそも R2 削除を試みない**(§4-C・omission による silent)。

### 「該当なし」ではない
消え残り経路は **6 本(A-F)実在**。うち (B)(C) は設計/未実装起因で恒常的、(A)(D) は運用/イベント依存、(E) は silent 失敗、(F) は手動リトライ依存。

---

## 5. 到達不能論拠の再検証

- 先の裁定で使った「prod では race に到達不能」= **crop-vs-GC race(source を削除し provenance を cascade 消失させる)** が対象。依存値 = grace 30 + 7 日 cap(30 日超 source が mid-crop になり得ない)。この数値前提は現物上は**今も成立**。
- しかし **新軸では moot(無意味)**: その race は「source を削除する」方向。新軸では **source 削除は望ましく、provenance 消失は許容**。→ race が起きても許容方向にしか振れない=もはや risk でない。
- **逆に、race を潰すために入れた T14b 修正群が新軸に逆行する**:
  - Finding 1 guard(`noDerivations`・derivation を持つ source を GC しない・`gc-image-assets.ts:820-825`)= 消すべき source を残す(→ §4-B/D 助長)。
  - Finding 5 self-heal(derivation 復活で source を ready へ戻す・`gc-image-assets.ts:664-671`)= 消すべき source を能動的に保持。
  - Class B の completed 除外・op 不在 ready 非適格(保守的 keep 既定)= すべて source 保持方向。
- **帰結**: T14b の設計前提(source を残す=provenance/②-5 のため)が新軸と反転。到達不能論拠の依存値は数値上健在だが、守っていた対象が新軸では非 risk 化したため、論拠自体が**判断材料として無効**。

---

## 付録: T14b commit 判断への含意(fact のみ・決定は OT)

- 現行 staged T14b は新軸を満たさない(§4-B が設計、§4-C が未実装穴、Finding1/5 が逆方向)。
- 新軸を満たすには最低限: (1) 正常完走後の source purge(crop 完了で source 削除)(2) exam/退会 cascade を「source_assets を 'deleting' soft-delete → R2 削除」へ(assets 同様・= T15 前倒し + soft-delete 化)(3) Finding1/5 の provenance 保護を撤回 or 反転(4) GC の自動化 or 同期削除化(手動放置で残らない構造)。
- これらは T14b の scope 再定義に相当(実装判断は OT)。
