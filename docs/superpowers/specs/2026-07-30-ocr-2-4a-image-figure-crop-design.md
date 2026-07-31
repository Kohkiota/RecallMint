# ②-4a 画像図版切り出し 設計 spec(未公開 payload + 最終 atomic publish)

- 日付: 2026-07-30(初版)/ **2026-07-31 改訂: prepare→publish 方式へ全面改訂**。
- 位置付け: ②-4 本体を **画像入稿のみ**にスコープした ②-4a の設計正本。PDF rasterize / Files API / page 固有メタは ②-4b。
- 状態: **凍結(実装中)**。方式(未公開 payload + atomic publish)は Codex plan cross-check で妥当判定済。**§H Codex 差分レビュー実施済**(2026-07-31・`docs/codex/2026-07-31-ocr-2-4a-revision.md`): P1=1(§6.2 で対処済)。**2026-07-31 実装中改訂(OT 確定・Codex 再レビュー不要と OT 判断)**: (a) `input_fingerprint` 廃止 + 冪等契約明記(§2)(b) source_assets の検証済 5 列 nullable + lean reservation + `client_declared_*` 非採用(§6.1)(c) 日次 Gemini cap 配線 + T4 user advisory lock + 同時 1 upload 制限(§3・非原子)(d) §7.3 を crop-derived に限定。以降の仕様変更は停止して OT 相談。
- 前提資料: fact-finding(`docs/audit/2026-07-29-ocr-2-4-factfinding.md`)/ 実測 exp1-6(`scripts/ai/_ocr-*.ts`)/ Codex plan cross-check(`docs/codex/2026-07-30-plan-ocr-2-4a.md`)/ sync 調査(本 session)。

---

## 0. スコープ / 非スコープ

**やること(②-4a)**: 画像入稿(jpg/png/webp)に対し 1 回の generateContent で text 抽出 + 図版 box_2d 検出を行い、**検証・正規化した結果を未公開の prepared_payload として保存 → server 側で crop → 最終 atomic publish** で card + 図版 asset を確定する。同期一発。

**やらないこと(②-4b 以降)**: PDF 選択的 rasterize / Files API / page 固有メタ。account quota は ②-5。図の per-option 分割・警告 UI 詳細・再試行導線は実害観測後。

**境界の確保**: source 種別(image/pdf)・page 概念・rasterizer メタを ②-4b が足せる schema 境界を残す(§6/§17)。

---

## 1. アーキテクチャ = 未公開 payload + 最終 atomic publish

```
prepareUpload(operation / exam / source_document / source reservation を先に作成)
  → client が source を presigned PUT
  → claim(lease 取得)
  → Gemini 応答を検証・正規化
  → card ID / option uid / asset ID を UUIDv4 で発行(§D)
  → prepared_payload を atomic 保存(commit) … 状態 prepared
  → 【commit 後にのみ】crop asset 行作成・R2 PUT・ready 化(§C1)
  → publishPreparedUploadTx(短い DB tx で cards / tags / refs / card_count / status を一括確定)… 状態 completed
```

**server 側 crop は継続採用**(sharp = transitive→direct・exact pin `0.35.3`・OT 承認済)。crop 元 = Gemini に送ったバイトと同一(§4.2)。

### 1.1 現 spec から削除したもの(理由を記録)

- **読取経路への除外条件 3 点**(getCardsDelta / スマート復習 server fallback / 試験詳細 initialCards)= 削除。
- **cursor hole 対策の touch**(完了 tx での cards.updated_at bump)= 削除。
- **crop asset ID の UUIDv5 採用**= 削除(§D で UUIDv4 stage 発行へ)。
- **pull 原子性の懸念**= 削除(調査で **ページングなし・1 レスポンス・1 Dexie tx** と確定)。

**削除理由**: 3 ゲート案は補償策であり「新しい読取経路を追加するたびに除外を書き忘れない」という**人間の規律に依存する不変条件を永続的に負う**。publish 方式では**未完成カードが DB に存在しない**ため構造的に漏れず、cursor hole も「processing card が DB にある」前提が消えるため**原理的に発生しない**。

---

## 2. upload_operations 状態機械 + lease/fencing(Codex #2/#3)

**新表 `upload_operations`**。列:

- `id (uuid pk)` / `user_id (uuid fk cascade)` / `idempotency_key (text)` / `exam_id (uuid)` / `source_document_id (uuid nullable)`
- `status ('awaiting_sources'|'claimed'|'prepared'|'completed'|'terminal_failed')`
- `lease_version (bigint)`(or ランダム `lease_token`)/ `lease_expires_at` / `attempt_count (int)` / `next_retry_at` / `last_error_code (text)`
- `prepared_schema_version (int)` / `prepared_hash (text)` / `prepared_payload (jsonb, nullable)` / `result_summary (jsonb, nullable)`
- `created_at` / `completed_at`
- **UNIQUE(user_id, idempotency_key)**。index(user_id, status)/(next_retry_at)。**RLS 対象**。

> **改訂(2026-07-31・OT 確定): `input_fingerprint` 列を廃止**。二重処理防止は UNIQUE(user_id, idempotency_key) + T4 の並行再送収束(user 単位 advisory lock)+ T6 の lease CAS + T12 の fencing + source finalize 後 immutability + stage 済 UUID 再利用で成立し、fingerprint の一致/不一致分岐は不要。`prepared_hash` は残す(payload の破損・drift 検知という別目的)。**冪等契約(不変条件)**: 同一 idempotency key は常に**最初に作成された operation**を指す。再送時の引数が異なっても新規 operation として扱わず、既存 operation / result_summary を返す。source 集合は **unordered** として扱い、常に `source_id` で決定的に処理する(順序付き fingerprint 廃止に伴い `ordinal` 列は設けない)。

**状態遷移**: `awaiting_sources → claimed → prepared → completed` / `claimed|prepared → terminal_failed`。retryable error は **status を維持したまま lease を解放**し `last_error_code` / `next_retry_at` / `attempt_count++` を記録(再 claim 可)。

**lease/fencing(Codex #2)**: lease は「次実行に権利を渡してよい時刻」であって**旧実行の書込権を失効させる機構ではない**。takeover 後に旧実行が復帰し publish するとカード二重作成。ゆえに:

- claim / takeover 時に **CAS で `lease_version` 更新**。
- `publishPreparedUploadTx` 冒頭で operation を **`SELECT … FOR UPDATE`** し、`status='prepared' AND lease_version = :mine` 不一致なら**旧実行を拒否**。
- version 検証は publish に限らず **asset reservation / finalize / operation 状態更新にも可能な限り適用**。
- 補足: 現設定 Vercel 上限 800s < lease 15min ゆえ 15 分後に同関数が生存する可能性は通常ない。それでも `lease_version` は**将来の lease 値変更・手動回収・複数リクエスト化に対する状態機械の正当性**として必須。最低限 publish で不一致を必ず拒否すればカード二重作成は防げる。

---

## 3. prepareUpload と source 状態機械(Codex #3)

現行では exam / source_document は server guard 内で初めて作られる(`upload-guard.ts:126`)。client 事前 PUT と循環するため、**`prepareUpload` 相当で operation・exam/source_document・source reservation を先に作る段階**が要る。

- 状態 `awaiting_sources` の間に client が source を presigned PUT → finalize(§6)。
- source upload / prepare / claim / publish の各段階に **abandonment GC と再開契約**(§11)。

**T4 の並行制御 + 同時 1 upload 制限(2026-07-31・OT 確定)**: 旧 flow の同時 1 upload 制限は `runUploadGuardTx`(`upload-guard.ts:58` の user 単位 advisory lock + `:69` の processing 検査)で成立していたが、新 `prepareUpload` はこれを移植していない。ゆえに `prepareUpload` は **user 単位 advisory xact lock を冒頭で取得**し、以下の順で判定する:

1. user 単位 advisory lock(`pg_try_advisory_xact_lock(hashtext(userId))`)取得。取れなければ並行 prepare として弾く。
2. 同一 idempotency key の既存 operation があれば**それを返す**(冪等・§2 契約)。
3. 別 key の **live operation** があれば `in_progress` を返す(同時 1 upload 制限)。
4. なければ新規 operation + exam + source_document + **source reservation 行**を作成。

**live 判定の基準**: 旧 `source_documents.created_at` 15 分窓を**そのまま流用しない**(新状態機械は 7 日 retry を持ち矛盾する)。`upload_operations` の **status(非終端 = awaiting_sources|claimed|prepared)/ lease(lease_expires_at)/ abandonment TTL** を基準にする。abandonment TTL の正本は §11(T14 で確定)。T4 時点では暫定 TTL を定義し、T14 で §11 の値と整合させる。

**日次 Gemini cap の配線(2026-07-31・OT 確定)**: 新 prepare→publish flow は現状 **同時 1 upload 制限と日次 cap の両方を素通し**している(旧 `runUploadGuardTx` の guard を未移植)。account quota(月次ページ)は ②-5 だが、service 全体の **日次 Gemini call cap(`GEMINI_DAILY_LIMIT`・CLAUDE.md AI 絶対ルール 2 の安全弁)は本 sprint で配線する**。原子化(枠確保)は不要だが配線は必須:

1. **T4 冒頭で user 単位 advisory lock**(上記)。これで並行再送収束と同時 1 upload 制限を 1 機構で解決。
2. **T6 の claim 直前に日次 cap 判定**(現行と同じ global daily count)。上限到達なら claim せず operation を `awaiting_sources` のまま返す。
3. **T7 では各 attempt で `incrementAiUsage`**(既存どおり)。
4. `GEMINI_DAILY_LIMIT_EXCEEDED` を既存 UI エラーへ接続。
5. `parseDailyLimit`(`upload-guard.ts:23` private)を**再利用可能な helper へ切り出し**、T6 の日次 cap 判定で共有。

**原子的枠確保(`INSERT … ON CONFLICT … WHERE count < limit`)は実装しない**: 実ユーザー 0 で、超過してもサービス全体上限を 1〜2 回超える程度ゆえ。**実ユーザー増加後に再判断**する(この判断理由を記録)。

---

## 4. 座標契約(裏取り済・不変条件)

### 4.1 軸別正規化(実測裏取り済)
box_2d=`[y_min,x_min,y_max,x_max]` 各軸 0-1000 独立正規化。`x_px=x/1000×decoded_width, y_px=y/1000×decoded_height`。裏取り: `scripts/ai/lib/box-overlay.ts:10-52`(左/上/幅/高 %)+ container CSS(幅/高 基準)で軸別確定。代表例 page1 `[211,298,362,729]`・1653×2339 → x=[492.6→1205.0]/y=[493.5→846.7]px、overlay で図に密着。反証: y を幅正規化するとずれ図に乗らず=単一スケール反証。例外: exp1-5 全 box が [0,1000] 正面積。

### 4.2 crop 元の不変条件
crop 元 = **Gemini に送ったバイトと同一の画像**。画像入稿はそのバイト(R2 保存の source)を変換せず crop。PDF(②-4b)のみページレンダリングを crop 元とし、埋め込み画像の直接抽出は回転/座標乖離ゆえ禁止(**PDF 固有規則・画像入稿に非適用**)。

### 4.3 座標基準と EXIF 前提
座標基準 = crop 元バイトの decoded 寸法。前提: browser-image-compression が EXIF orientation をピクセルへ焼き込むため Gemini バイト=crop 元バイト=正立で、解釈差は構造的に不発。前提破綻(圧縮変更等)で契約が壊れる旨を明記。finalize で decoded 寸法を保存しその寸法で crop。

### 4.4 座標品質 ≠ 切り出し品質
exp5 の粗い座標(辺の run 間揺れ)は Gemini 検出品質の変動で、式のずれではない。切り出し品質は防御 3 点(padding/clamp/原 bbox 保持で再 crop 余地)で受ける。

### 4.5 回転入力の明示除外(exp7 は gate にしない)
portrait/PNG 前提で進める。**EXIF orientation ≠ 1 の source は図版検出をスキップ**(text 抽出は実行)、除外理由「向き未対応」計上(§13)。検出可能ケース限定(EXIF 無し回転は非対象)。前提破綻検出器を兼ねる。exp7(回転 JPEG 座標裏取り)通過で除外を外す follow-up。

---

## 5. schema / 検出

### 5.1 統合 schema
本番 `buildDiscoverResponseJsonSchema` を触らず、各 card に `figure_regions` を optional 注入した探索 schema を ②-4a 用に用意(exp5 で欠落ゼロ実測)。要素 = `source_id (必須)` / `box_2d ([number×4]|null・nullable 必須・推測生成禁止)` / `target (question|option_{id}|explanation)` / `label (optional)` / ②-4b 予約 `page`。card required に figure_regions を入れない。prompt = 本番 `buildDiscoverPrompt()` + 図版 suffix の探索用コピー(本番 prompt 不触)。

### 5.2 source_id(client 発行・送信順 index 不採用)
client が source ごとに source_id 発行。parts は `[text "source_id=X", image, …, prompt]` で interleave し Gemini に書き写させる。source_id ↔ source_asset は prepare 時に保持。source_id は **source_document 内 unique**(§6)。

### 5.3 要素単位 safeParse
親 schema で `figure_regions[]`/`images[]` を一括検証しない。入力境界用と正規化後用で schema を分け、**要素ごとに safeParse**。JSON 全体が truncate/parse 不能なら operation を retryable failed(要素隔離は「親 JSON が parse 可能」条件付き・§C1 の deadline 経路とは別)。隔離: card 本体破損→card 除外 / figure 破損→その figure 除外 / box_2d null→「座標 null」除外計上。

---

## 6. source_assets 保存

### 6.1 新表 `source_assets`(1 upload : N ファイル)
列: `id (uuid pk)` / `user_id (fk cascade)` / `source_document_id (fk cascade)` / `source_id (text)` / `object_key (text unique)` / `mime (nullable)` / `content_hash (server 計算 SHA-256・nullable)` / **`byte_size (int・nullable)`** / `width (nullable)` / `height (nullable)` / `status ('reserved'|'ready'|'deleting')` / `original_filename` / `source_kind ('image')` / `created_at` / `ready_at`。②-4b 予約: `page_count`/`rotation`/`rasterizer`(nullable)。**UNIQUE(source_document_id, source_id)**。index(user_id, status)/(source_document_id)。**RLS 対象**。
> 註: `byte_size` は Codex 指摘の初版漏れ。finalize の HEAD byteSize 一致に必須。

> **改訂(2026-07-31・OT 確定): 検証済み 5 列(`mime` / `content_hash` / `byte_size` / `width` / `height`)を NULLABLE 化**。これらは finalize で **server が実バイトから確定**する値であり reserve 時は未定。finalize の**条件付き UPDATE で 5 列の値と `status='ready'` を同時に確定**する(reserve 時に placeholder を入れない)。
> **reservation 行(T4 が作成)に保存するのは lean set のみ**: `id` / `user_id` / `source_document_id` / `source_id` / temp `object_key` / `status='reserved'` / `source_kind` / `original_filename` / `created_at`。
> **`client_declared_*` 列は作らない**。client 申告の size / MIME は **T5 の入力として検証し presigned URL 署名(content-length-range / content-type 条件)にのみ使用**、DB に永続化しない(§B 決定)。reservation 行を維持する理由(遅延作成しない): ① T4 再送時に同じ asset ID / temp key を返す ② presigned URL 発行時の owner/source 認可 ③ source 数・source_id 集合の固定 ④ finalize の `reserved → ready` CAS ⑤ **放棄された temp object の GC 手がかり** ⑥ **GDPR 削除時の object_key 保持**(特に ⑤⑥ が決定的 — 行が無いと放棄 object を DB から辿れず R2 prefix listing に依存する)。

### 6.2 保存フロー + finalize 後の immutability(Codex P1 対処)
client: 各画像を既存圧縮(browser-image-compression)で source 化 → reserve → **temp key へ presigned PUT** → finalize。

**finalize(server)**: temp key を R2 GET → **magic-byte / decode / byte_size / content_hash(SHA-256)/ decoded 寸法(+ mime)を実バイトから検証・算出**(client 申告は署名時のヒントのみ・DB 非永続)→ **その検証済バイトを server が最終 key へ PUT(server 書込)** → **条件付き UPDATE で検証済み 5 列(mime/content_hash/byte_size/width/height)+ ready_at を set し `status='ready'` へ遷移**(`WHERE status='reserved'` で TOCTOU 防御・reserved→ready CAS)。

- temp key = `users/{userId}/src/tmp/{assetId}` / 最終 key = `users/{userId}/src/{assetId}.{ext}`。
- **最終 key は server 書込専用(client は最終 key の presigned を持たない)= finalize 後の source は immutable**。Gemini 送信・crop は**最終 key**を読む。
- **[Codex P1]** これにより「finalize 後に client が同 presigned で最終バイトを上書き → 記録 hash/dims と Gemini/crop の実バイトが乖離(不正 crop・completed 再利用の誤判定)」という TOCTOU を**構造的に排除**。temp の再上書きは promote 済ゆえ無害、未 promote の stale temp は GC(§6.4)。
- コスト: finalize で server R2 GET + PUT が 1 往復増える(source は圧縮後 ≤ 数百 KB ゆえ許容)。decode bomb 対策に sharp `limitInputPixels` を課す。

### 6.3 GDPR(Codex #8)
`source_assets.user_id`/`source_document_id` cascade。**`upload_operations` / `source_assets` を GDPR Group I の不変条件に追加**(payload にカード本文を保持するため operations の削除漏れ不可)。user 削除時に operation を cancel/terminal 化し、asset reservation/finalize で **user 非削除を再確認**。DB cascade 先行で R2 key を失わないよう、削除は deleting 状態経由(§11)。

### 6.4 source_assets の GC(§F 決定)
現行 GC script は `assets` のみ(`gc-image-assets.ts:52`)ゆえ source_assets は対象外。**決定 = 共通化**: 既存 image-GC の asset-state 機構(reserved TTL / 参照ゼロ→deleting→R2 delete・reconciler は W1 deploy 後)を source_assets にも適用する lane を足す(状態列 reserved/ready/deleting を共有ゆえ自然)。参照ゼロ判定 = source_document FK + operation 状態(live operation の source は除外・§11)。加えて **未 promote の stale temp key(`src/tmp/`)は reserved TTL 超過で R2 delete**(§6.2 の immutability 経路の後始末)。

---

## 7. crop / 保存

### 7.1 padding / clamp
padding = 各辺 **6%**(0-1000 で ±60)→ clamp[0,1000] → px 化(**left/top=floor・right/bottom=ceil** で切れ防止)→ 整数。退化(幅/高≤0)は crop 失敗計上。**なぜ 6%**(揺れ実測 ~3.5% より広く): 目視で出所表記・軸ラベルの実欠けを観測、非対称性(余白過多は害小・切れは回復不能)ゆえ広めから始めて後で狭める。

### 7.2 asset ID = stage 時 UUIDv4(§D・UUIDv5 撤回)
`isAssetKey` は UUIDv4 のみ asset 判定(`card.ts:87`)。UUIDv5 では ready 検証・デッキ DL・ギャラリー・refs 射影の全対象外=画像が一切表示されない。→ **card ID / option uid / asset ID を stage 時 UUIDv4 発行し payload に保存。retry は payload 内の同 ID を再利用**。object key も asset ID 由来。「決定的」= 再計算でなく「再試行で同 ID」で足りる。

### 7.3 crop-derived asset は prepared commit 後のみ(Codex #1)
不変条件は **crop-derived asset 行(`assets` table)・その R2 object を prepared_payload commit 前に作らない**ことに限定する(2026-07-31 明確化)。source_assets の reservation 行は reserve 時=prepared 前に作る(§6.1・GC/GDPR 手がかりのため意図的)ので本規則の対象外。claim 直後〜payload 保存前の crash で UUID が再発行されても、**crop asset 行・crop R2 オブジェクトを作っていなければ孤児は生まれない**(Gemini 再呼出費用のみ残る)。この順序を不変条件として明記。

### 7.4 R2 条件付き PUT + 412 hash 検証(Codex #7)
crop 画像は最初から最終 key へ `If-None-Match: *` の条件付き PUT。照合:
- asset row `ready` かつ key/hash/size/mime 一致 → PUT せず再利用
- `reserved` → 条件付き PUT
- **412 → HEAD で size 確認 + GET して SHA-256 照合。不一致は loud failure**
- `deleting`/`deleted` → 再利用禁止

現行 `headObject` は content-length のみ(`r2.ts:108`)ゆえ hash 照合に **server R2 GET が必要**。DB の asset 行に **server 計算 SHA-256 を保存**。crop バイトは webp 再エンコード(quality/lossless 固定=同 asset ID に同バイトを保証・pipeline_version が包含)。

### 7.5 crop 進捗の判断
`assets.status` は**成功済み skip 判定にだけ使う**(ready は成功を示すが crop 失敗の excluded は表せない)。未 ready の図は再開時に再試行し、**当該実行の最終結果をメモリ上で attached/excluded に分類**して publish。永続失敗記憶が要る時のみ figure outcome 保存先を追加。

---

## 8. publish(publishPreparedUploadTx)

### 8.1 ロック順序固定 + asset 条件付き保護 UPDATE(Codex #4)
ロック順序: **operation → exam → source_document → assets(ID 順) → cards → tags → refs → counters/status/operation**。

`SELECT … FOR UPDATE` だけでは不十分(publisher が ready 確認 → GC が ready→deleting → publisher が refs INSERT で deleting asset 参照成立)。FK は行存在のみ検証・status 非制約(`schema.ts:860`)。ゆえに**条件付き保護 UPDATE で期待件数の全件返却を確認してから refs を張る**:

```sql
UPDATE assets SET unreferenced_at = NULL
WHERE user_id = ? AND id IN (...) AND status = 'ready'
RETURNING id;
```
返却件数が期待未満なら publish 失敗。通常 GC は retry 保持 7 日 < grace 30 日で競合対象外(§11)。GDPR 即時 deleting lane は operation cancel/fencing で防ぐ(§6.3)。

### 8.2 既存ロジックの共通化(publisher が引き継ぐ不変条件)
`handleImages` は既存 card 前提ゆえ publisher から呼べない。複製回避のため抽出:
- `projectCardAssetRefs(cardId, userId, images)` 純関数(`card-field-handlers.ts:199` の射影を切出・backfill 含め実質 3 経路で根拠十分)
- `assertReadyOwnedAssets(tx, userId, assetIds)` DB helper
- `normalizePreparedCard` 純関数 / `imagesSchema`(配列全体で最大 10・`card.ts:134`)/ correct answer 再導出

publisher 検証: title/question/explanation 長さ・必須 / options 1-50 / option id・uid 一意・uid が UUIDv4 / correct_answer_ids を is_correct から再生成 / images ≤10(超過は決定順で先頭採用・残り `image_limit_exceeded` 警告)/ URL 非保存 / asset key UUIDv4 / target が card field or 存在する option uid / asset の owner・ready・expected key/hash/size / **cards.images と refs を同一 tx INSERT**。

既存 helper 再利用可否:
- `saveExtractedCards`: 要改修(`RETURNING` 順と `customProps[i]` の位置対応依存・`upload-persistence.ts:25` → stage 済 card ID を使うなら custom props も **card ID で対応付け**)
- `applyOcrTags`: そのまま不可(§12 の非決定性)
- `completeUploadTx`: 不可(`id+userId` のみ・開始 status 非検証・`upload-persistence.ts:64`)
- `bumpExamCardCount`: 要改修(affected row 非検証・`card-count.ts:24`)

`publishPreparedUploadTx` は上記を同一 `TenantTx` 上で順に呼ぶ **orchestrator** に留める。型変換境界: `optionSchema` は camelCase `isCorrect`(`card.ts:14`)/ DB `CardOption` は snake_case `is_correct`(`schema.ts:46`)→ **変換を 1 箇所に固定**。**cards に `ON CONFLICT DO NOTHING` 不使用**(同一 tx 内重複=設計破綻・loud fail。upsert/条件付き PUT は DB/R2 境界の asset reservation 限定)。

### 8.3 publish 条件(crop 全滅でも text card を publish)
- 有効カード **1 枚以上 かつ** 全 figure が attached/excluded の**終端に達した** → publish
- 有効カード 0 → upload failed / DB publish 失敗 → retryable・何も publish しない
- crop 成功枚数は publish 条件にしない。全成功→completed / 一部失敗→completed+warnings / 全滅→**text card を completed+warnings** で publish
- これは未完成カードの途中公開ではなく、crop 試行が終了し「このアップロードでは画像なし」という**最終結果が確定した状態の公開**。

---

## 9. prepared_payload 運用(§D)
- `upload_operations` に jsonb。card 同型の staging table は作らない。**正規化後に原則 1 回だけ保存**(crop 進捗で書き換えない)。routine query は列明示・**`SELECT *` 禁止**。`prepared_schema_version`/`prepared_hash` 別列。**publish 成功で 1 回だけ NULL 化**。**Supabase Realtime publication に追加しない**。gzip bytea 化しない(TOAST と二重)。分離閾値: p95 payload が 5〜10MB を継続超過等で `upload_operation_payloads(operation_id PK, …)` 1:1 cold table へ(現段階は同一行で十分)。

---

## 10. provenance 永続先(§F 決定)
payload を publish 後 NULL 化するため、**bbox / padding 率 / clamp 後 bbox / crop 寸法 / source_id / detect target / pipeline_version を payload だけに置けない**(`assets` にも `CardImage` にも保存先なし)。**決定 = 新表 `asset_derivations`**(`asset_id (uuid pk, fk assets cascade)` / `user_id (fk cascade)` / `source_asset_id (fk)` / `orig_bbox (jsonb)` / `padding_pct` / `clamped_bbox (jsonb)` / `crop_w` / `crop_h` / `detect_target` / `pipeline_version` / `created_at`。RLS)。切り直し(padding 再調整)の余地を残す(assets metadata 列より正規化 table が ②-5 と整合)。

---

## 11. deadline / retry / GC grace(Codex #5/#8)
- **deadline**: operation 全体の **absolute deadline を 1 つ**持つ。現行 `OCR_OVERALL_DEADLINE_MS` は OCR だけで 720s(`ocr.ts:60`)。OCR 後の残時間が crop 最低予算を下回れば残図を **`deadline_excluded`** とし text card を atomic publish(architecture.md §10 隔離と整合)。
- **retry 保持 < GC grace**: 不変条件は「grace > lease」でなく「**grace > operation が非終端で再開可能な最大保持期間**」。初期値 = lease 15 分 / retryable prepared 保持 最大 7 日 / **7 日超で terminal_failed・payload NULL 化・ref ゼロ asset は GC へ** / GC grace 30 日(現行)。
- **stale source 回収統合**: 現行は `source_documents.created_at` 15 分超で failed(`source-doc-status.ts:64`/`upload-guard.ts:69`)。prepared 再試行が 15 分跨ぐと「source failed → 後から publisher が completed へ戻す」矛盾。→ source status/active-upload 判定を **operation lease と統合** or **reconciler が live operation を除外**。

---

## 12. tag category の deterministic 選択(Codex #6)
`applyOcrTags` の既存取得は ORDER BY なしで同名行を Map 上書き=非決定(`apply-ocr-tags.ts:90`)。`tag_categories` は同名重複を意図的許可(`schema.ts:682`)ゆえ unique 化しない。→ **「同名 category のうち `(created_at, id)` 最古を canonical に選ぶ」を明文化**し OCR 側選択順を固定。

---

## 13. target / 提示
- **option target = `option:<uid>`**(§D): `id` は再利用可・`uid` が内部不変 identity(`schema.ts:46`)。UI/学習とも `option:${uid}`(`use-card-options.ts:69`/`session-runner.tsx:504`)。2 段変換: `option_1` → `options[].id === "1"` 検索 → `option:${matchedOption.uid}`。
- ambiguous/未マッピング → `question_text`(OT 決定・検出 target は §10 に保持)。
- **除外理由別件数**(loud failure over silent zero): カード N/M 不可 + 図版「K 取込 / 座標 null a / source_id 不正 b / crop 失敗 c / 制限超過 d / 向き未対応 e / image_limit_exceeded f / deadline_excluded g」。②-4a は件数提示まで。

---

## 14. result_summary(§F)
再送時に元レスポンス同等の画面を再構成できる情報のみ: `schemaVersion / operationId / sourceDocumentId / examId / examName / completedAt / cardsExtracted / preview cards(id, title, snippet, optionCount) / figuresDetected・attached・excluded / warningCountsByReason / ocrCostYen / modelChain / pipelineVersion`。**raw OCR・prepared card 本文全文・署名 URL は含めない**。

---

## 15. 確定済み設計判断
prepare→publish(未完成 card は DB 非存在)/ server crop + sharp direct(0.35.3)/ padding 6%(広め→狭める)/ 回転入力の明示除外 / **UUIDv4 stage 発行 + retry 再利用**(UUIDv5 撤回)/ option:`<uid>` / crop 全滅でも text card publish(enum 追加せず completed+warnings)/ cards に ON CONFLICT 不使用 / 選択肢=図は 1 枠 question / 冗長表枠は非対応 / 全ファイル 1 generateContent / account quota は ②-5。

**2026-07-31 改訂で確定(OT)**: `input_fingerprint` 廃止(冪等は UNIQUE key + advisory lock + lease CAS + fencing + immutability + UUID 再利用で成立・§2)/ source 集合は unordered・`source_id` 決定処理・`ordinal` 列なし / source_assets 検証済 5 列(mime/content_hash/byte_size/width/height)nullable・finalize 条件付き UPDATE で確定 / `client_declared_*` 列なし(申告 size/MIME は署名用のみ・非永続)/ reservation 行は lean で維持(遅延作成しない・GC/GDPR 手がかり)/ T4 user advisory lock で並行再送収束 + 同時 1 upload 制限 / 日次 Gemini cap を配線(T4 lock→T6 claim 前判定→T7 increment→UI エラー)・**原子的枠確保は非実装**(実ユーザー 0・超過 1〜2 回許容・増加後再判断)/ T5 は T4 作成済 reserved 行を認可・検証し temp PUT URL 発行(source_assets 行を新規作成しない)/ §7.3 は crop-derived asset に限定。

---

## 16. exp7(follow-up・実装前 gate にしない)
回転 JPEG を browser-image-compression に通した出力で「Gemini 送信バイト=crop 元バイト=正立・decoded 寸法一致」を裏取り → 通れば §4.5 の回転除外を外す。

## 17. ②-4b 境界
figure_regions `page` / source_assets `source_kind='pdf'`・`page_count`/`rotation`/`rasterizer` / PDF 選択的 rasterize(座標返却後・図のあるページのみ)/ Files API は別 spec。

---

## 18. テスト方針(概要・§G 反映)
- **AI は mock 必須**。統合 schema の parse/隔離/変換は Gemini mock(欠落・box_2d null・source_id 不正/重複・target 各種・要素破損・JSON truncate)で厚く。
- **状態機械 iso**: claim/takeover の CAS lease_version / publish の `FOR UPDATE + status='prepared' AND lease_version=:mine` 不一致拒否 / awaiting_sources→prepared→completed / retryable の lease 解放+再 claim / TTL(7 日)terminal 化。
- **publish tx iso**: ロック順序 / asset 条件付き保護 UPDATE(期待件数未満で fail) / cards・refs 同一 tx / ON CONFLICT 不使用で重複 loud fail。
- **冪等 iso**: retry で同 card/option/asset ID 再利用 → cards/assets/refs/usage が増えない。
- 座標変換(pad6%・floor/ceil・退化)pure / 要素隔離 pure / crop 全滅 text publish / deadline_excluded / tag category(created_at,id)最古 / 除外理由別集計。
- **§G 横断**: 旧前提(**3 ゲート / touch / UUIDv5 / completed_with_warnings enum**)がテスト計画・他節に残らないことを確認。
- 実装後 throwaway 検証 **2 本のみ**: (1) 100 cards + 想定最大 tags/refs の publish tx 所要時間 / (2) R2 conditional PUT の 412 → 検証経路。設計を止める未実測はない。

---

## 19. OT レビュー結果(確定)
sharp 承認 / padding 6% / 回転明示除外 / **prepare→publish 方式採用**(3 ゲート・touch・UUIDv5・enum を撤回)/ fact-finding doc commit 済。**凍結前 = §H(Codex 差分 1 回)→ OT 再レビュー**。

## 付録: 裏取り file:line
座標: `scripts/ai/lib/box-overlay.ts:10-52` / `ocr-box2d-viz.ts:97-100,118-119` / `_ocr-exp5-viz.ts`。統合 schema 実測: `_ocr-pdf-integrated-probe.ts`(exp5)/ `out/exp5-cards.json`。既存経路: asset action `asset-actions.ts:84-210` / handleImages 射影 `card-field-handlers.ts:171-232` / imageEntrySchema `validation/card.ts:96-134` / OCR orchestration `app/(app)/app/upload/_actions/process.ts` / schema `lib/db/schema.ts:298-370(cards),378-421(source_documents),821-847(assets),860-879(card_asset_refs)`。
</content>
