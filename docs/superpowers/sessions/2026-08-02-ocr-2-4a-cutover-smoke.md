# ②-4a-cutover 手動 smoke 手順書(OT 実機・stg only)

**対象**: 新 prepare→publish flow の初 e2e。**主目的 = 実測**(時間予算・retry・ページ上限は現在すべて暫定 → この smoke で確定)。
**前提**: stg deploy 反映後・OT 実機。**prod には出さない**。実行前に `NEXT_PUBLIC_VERCEL_ENV != production`(stg)であること(UI に「詳細 (staging / dev only)」エラー欄が出る)。

---

## 0. 案 D の retry 挙動(先に理解)

- **1 submit = 1 operation**。失敗したら**普通にもう一度アップロード**すればよい(UI が失敗表示時に旧 operation を abandon 済み。fresh key の新 operation が走る)。
- **例外**: 実行中の submit(valid lease 保持中の claimed/prepared)がある間は「現在 OCR を実行中です」表示で最大 **15 分**(LEASE_TTL_MS)ブロックされる。これは同時 1 upload 制限の保護。待てば自動解除。
- 手動解除 SQL は**案 D により原則不要**(§6 に「詰まった場合の確認 SQL」だけ残す)。

---

## 1. 何を上げれば何が起きるか(期待遷移)

### A. 画像 1 枚(正常系)
1. `/app/upload` で画像 1 枚選択 → 投入先(新規 exam or 既存)選択 → 「AI で問題を抽出する」。
2. amber banner「AI が問題を抽出しています…」+ spinner。button は「AI で抽出中…」。
3. 完了 → **`/app/upload/result/{sourceDocumentId}` へ自動遷移**し、抽出カードが表示される。
4. 「試験一覧」に該当 exam が `completed` で並ぶ。

### B. 画像複数枚(2〜3 枚)
- 上と同じ。complete 後 result page に全画像由来のカードが出る。図版付き画像なら図版がカードに attach される。

### C. PDF(②-4a では非対応の確認)
- PDF を 1 件でも含めて submit → **送信前に赤エラー**「PDF は現在このアップロードでは対応していません(画像のみ対応)」。**これが正しい挙動**(PDF rasterize は ②-4b)。OCR は走らない。

### D. HEIC / GIF(mime 後退の確認・任意)
- iOS の Files から HEIC、または GIF を上げる → 圧縮で webp 化されるため **正常に OCR される**はず(fileType pin の効果)。
- もし圧縮自体が失敗(古い端末で HEIC decode 不可)→ 該当ファイルが赤「error」表示で submit 不可(server invalid_input ではなく client 側で明示)。

---

## 2. DB で成功を確認する SQL(該当 user の最新 upload)

`:uid` = 対象ユーザーの `users.id`。

```sql
-- 1) operation が completed
SELECT id, status, lease_version, lease_expires_at, next_retry_at, attempt_count, source_document_id
FROM upload_operations
WHERE user_id = :uid ORDER BY created_at DESC LIMIT 3;
-- 期待: 最新行 status='completed'。lease_expires_at/next_retry_at は NULL 化されていてよい。

-- 2) source_document が completed
SELECT id, status, pages_total, filename FROM source_documents
WHERE user_id = :uid ORDER BY created_at DESC LIMIT 3;
-- 期待: 最新 status='completed'(失敗した submit は 'failed'・案 D の abandon)。

-- 3) cards が作られている
SELECT count(*) FROM cards c
JOIN source_documents sd ON sd.id = c.source_document_id
WHERE sd.user_id = :uid AND sd.id = :sourceDocumentId;
-- 期待: >= 1(抽出できた問題数)。

-- 4) upload_records に pages_processed 記帳(月次 quota SUM の源・②-5)
SELECT pages_processed, created_at FROM upload_records
WHERE user_id = :uid ORDER BY created_at DESC LIMIT 3;
-- 期待: 最新行 pages_processed = 投入画像数。

-- 5) source_assets が ready(finalize 済)
SELECT id, status, object_key, byte_size, mime FROM source_assets
WHERE user_id = :uid ORDER BY ready_at DESC NULLS LAST LIMIT 5;
-- 期待: 該当 upload の行が status='ready'、object_key = users/{uid}/src/{assetId}.{webp|png|jpg}。

-- 6) 図版がある画像なら crop 資産 + provenance
SELECT a.id, a.object_key, a.status FROM assets a WHERE a.user_id = :uid ORDER BY a.created_at DESC LIMIT 5;
-- 期待: crop 図版行 status='ready'、object_key = users/{uid}/{figureAssetId}.webp。
SELECT source_asset_id, orig_bbox, clamped_bbox FROM asset_derivations
WHERE user_id = :uid ORDER BY created_at DESC LIMIT 5;
-- 期待: crop ごとに 1 行(source_asset_id + bbox)。
```

## 3. R2 の key 形式

| 種別 | key |
|---|---|
| source temp(reserve 直後・finalize 前) | `users/{userId}/src/tmp/{assetId}` |
| source 最終(finalize 後・immutable) | `users/{userId}/src/{assetId}.{webp\|png\|jpg}` |
| crop 図版(publish 後) | `users/{userId}/{figureAssetId}.webp` |

## 4. 失敗時にどのログを見るか

- **Vercel Functions ログ**(stg プロジェクト): 各 server action(`prepareUpload` / `reserveSource` / `finalizeSource` / `claimOperation` / `stagePrepared` / `publishPreparedUpload` / `abandonUploadOperation`)が個別 invocation。失敗はここに出る。
- **構造化 logger event**(Vercel ログ内 grep):
  - crop 失敗: `ocr.crop.*`(`sharp_pipeline_failed` / `hash_mismatch` / `source_unreadable` / `forbidden_deleted_asset` 等)。
  - publish 失敗: `ocr.publish.*`(`payload_parse_failed` / `retryable` / `terminal_failed` / `tx_failed`)。
- **UI の詳細欄**(stg のみ): エラー時に「詳細 (staging / dev only)」を開くと code / rawError / sourceDocumentId 等が出る。
- **ブラウザ DevTools Network**: 失敗した server action の response body。

## 5. T10 の 6 基準(cutover smoke が実環境で初検証する #4/#5/#6)

- **#4 冪等(同ファイル 2 回上げ)**: 同一画像を 2 回、**別々の upload として** submit する。
  - 注意: UI は毎 submit fresh idempotency key(案 D)ゆえ **operation は 2 件・cards も 2 セット**になる(これは正常。operation-level 冪等は UI からは使わない)。
  - **検証対象は crop 資産の content-hash dedup**: 同じ画像の同じ図版は `assets` に**新規行を作らず既存を reuse**(`putObject ifNoneMatch` + hash 一致)。→ `assets` の当該 figure 行数が 2 回目で**増えない**(object_key は content 由来で同一)、`asset_derivations` は upload ごとに増える。
- **#5 決定性**: 同一画像 → 同一 crop bytes → 同一 R2 key(`users/{uid}/{figureAssetId}.webp` の figureAssetId は stage 時 UUIDv4 だが object 内容 hash は決定的)。#4 の reuse が成立すれば決定性も示される。
- **#6 §7.3 guard(crop-derived は prepared commit 後のみ)**: publish が失敗(retryable/terminal)した upload で `assets` に **crop 図版が残っていない**ことを確認(commit 前に crop を確定しない guard)。失敗ケースを 1 つ作れれば理想(§下記の失敗注入)。

## 6. 実測箇所(**この smoke の主目的**)

**timing 専用ログは無い**。各段階が独立 server action ゆえ **DevTools Network の各リクエスト所要 or Vercel Functions の各 invocation duration** で測る:

| 測りたいもの | 見る場所 |
|---|---|
| **Gemini 応答時間**(1枚 / 複数枚) | `stagePrepared` リクエストの所要時間(OCR 呼出を内包)。Network の該当 POST の Timing、または Vercel の `stagePrepared` invocation duration。 |
| **crop 1 枚あたり** | `publishPreparedUpload` の所要時間(crop 全枚 + DB 確定を内包)。**per-crop 個別ログは無い** → 図版 1 枚の画像で測れば ≒ 1 crop 分。複数図版なら合計。 |
| **upload 全体** | submit クリック → result page 遷移までの wall time(手計 or Network の prepareUpload 開始〜publishPreparedUpload 完了)。 |

**この実測で確定する暫定値**(現在すべて暫定):
- `CROP_PHASE_BUDGET`(publish の per-invocation deadline)/ `CROP_MIN_REMAINING_MS`(5s 暫定)/ sharp `.timeout()`(30s 暫定)/ OCR タイムアウト(720s)。
- retry 回数 / backoff / ページ数上限(`OCR_MAX_PAGES`=40)。

→ 実測を持ち帰り、CC が値を確定する(measure-first・OT 方針)。

## 7. 失敗注入(#6 guard と retry の確認・任意)

- 失敗系を安全に作るのは難しいため必須ではない。もし作れるなら:
  - crop 失敗を 1 回起こして(例: 極端な座標の教材)publish retryable → **UI「もう一度お試しください」→ 再 submit で新 operation が正常完走**することを確認(案 D の abandon+新規)。
  - このとき `upload_operations` の旧行が `terminal_failed`、旧 `source_documents` が `failed` になっていることを §2 の SQL で確認。

## 8. 詰まった場合の確認 SQL(案 D で原則不要・保険)

「現在 OCR を実行中です」が 15 分以上続く等で調べたい時:
```sql
-- live 扱いされている operation を確認
SELECT id, status, lease_expires_at, lease_expires_at > now() AS lease_valid, next_retry_at, created_at
FROM upload_operations
WHERE user_id = :uid AND status IN ('awaiting_sources','claimed','prepared')
ORDER BY created_at DESC;
-- lease_valid=true の claimed/prepared があれば「実行中」でブロック(正常・待てば解除)。
-- lease_valid=false or awaiting のみなら、次回 submit が supersede して自動的に通るはず。
```
案 D では次回 submit が自動掃除するため手動 UPDATE は不要。どうしても即時解除したい場合のみ OT 判断で該当 operation を terminal 化(要 owner 権限・破壊操作ゆえ CC は実行しない)。

**既知 bounded residual(Codex round-3・OT 確認要)**: **claim 応答喪失**(claim がサーバ commit した直後に通信断/parse throw)時のみ、claimed op が valid lease のまま残り最大 15 分 `in_progress`(nothing 実行中なのに「実行中」表示)。**self-heal**(15 分後 supersede)。smoke でこの窓に当たったら 15 分待って再 submit すれば通る。頻度は低い(応答喪失の稀な窓)。完全解消は op 状態再取得の往復追加ゆえ 0 ユーザーでは未実装(spec §3.1 受容・公開前再評価)。

---

**この後**: OT が push → 本手順で smoke。結果(実測値 + #4/#5/#6)を持ち帰り、CC が暫定値を確定 → T14b(source_assets GC・破壊)→ T15(GDPR)→ T16。cutover + T10/T12/T14a の [reviewed] は smoke 後 session doc に記録。
