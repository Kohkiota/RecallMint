<!-- 移送元: .superpowers/sdd/2026-08-04-ocr-2-4a-single-invocation/s3-stg-smoke.md(SDD workspace = git-ignored scratch)。
     実機観測は再現コストが最も高く、S-5 で旧経路が消滅したため S-3 時点の観測は二度と取れない。
     scratch 削除に先立ち全文を恒久記録へ移送(2026-08-05・要約なし・観測値は原文のまま)。 -->

# S-3 stg smoke 結果(2026-08-05)

対象: `origin/develop` = local HEAD = `a0fcace` / deploy = `dpl_AbCJZRTrsJXXTsyeazeDs7eB7SyG`

## §0 pre-flight

- push 同期: `git rev-list --count origin/develop..HEAD` = **0**(S-1〜S-3 反映済)
- 旧経路の bare 参照: `/app/upload` が読み込む **22 chunk 全走査**で `reserveSource` / `finalizeSource` / `stagePrepared` / `claimOperation` / `publishPreparedUpload` / `prepareUpload` / `abandonUploadOperation` の **hit 0**(UI 切替が deploy 済 build に反映)
- **未実施**: Vercel Functions タブの Max Duration・メモリ割当(Dashboard = OT のみ)

## S3-1 / S3-2 — PASS

5 枚(元 1.33MB → client 圧縮 **523.5KB**)→ **11 問**抽出。

| 観測 | 値 |
|---|---|
| op | `completed` / `last_error_code` 空 / payload NULL |
| source_document | `completed` / pages_processed 5 / cards 11 |
| card_asset_refs | **5 件 / 4 cards**(図版 attach) |
| exam 詳細の実描画 | blob 画像 **797×544 / 450×533**(R2 から取得して描画) |
| crop asset key | `users/{uid}/{assetId}.webp` |
| **`src/` を含む key** | **0** |
| asset_derivations | 5 件・**source_asset_id 全て NULL**・padding 6% / `crop-v1` |
| upload_records.file_size_bytes | **523454**(= 受領 Buffer 合計。新経路の意味論どおり) |

**新軸の総括(全 smoke 通算)**: `source_assets` 総数 **0** / crop asset **28 件中 `src/` key 0**。

## 失敗系 — PASS(ユーザー表示)

無地画像 → 有効カード 0。

- op = `terminal_failed` / `last_error_code` = **`empty_cards`** / payload NULL / lease NULL
- doc = `failed` / `error_message` = `operation empty_cards` / cards 0
- UI = `role="alert"`「**⚠ 問題を抽出できませんでした**」+ 論点 A の公開文言(「処理が中断された可能性があります。しばらく待ってから再度お試しください。処理状況は試験一覧で確認できます。」)。**緑の成功表示なし**・導線「試験一覧へ」(R2-3 の修正どおり)
- **`integration_failures` 総数 = 0**(admin read-only 確認)→ **予期される失敗は台帳に書かない**設計(spec §4.4)が実機で成立

**未検証**: 予期しない throw(台帳に載る唯一のクラス)は UI から誘発できず、iso のみで担保。

## S3-3 — PASS

別タブで `processing` の doc の result page を直叩き:

- 「**⏳ まだ処理中です**」+「試験『…』への取り込みを実行中です。処理状況は試験一覧で確認できます。」
- 緑表示なし / **削除案内なし** / **待ち時間の数値なし**(確定事項どおり)/ 導線「試験一覧へ」

※ 同一タブでの遷移は beforeunload ガード(離脱防止)が出て 60 秒待たされ、その間に処理が完了してしまう。別タブが正しい観測手段。

## S-2 申し送り 1 の解消 — PASS

- 非終端 op **0 件**(全 smoke 後)
- upload form は毎回正常表示 = `hasActiveProcessingUpload` が旧経路 form を塞ぐ事象なし

## GC 方式の判定 — **(B) 行駆動**

- asset lane の候補生成は `assets` 表の SELECT(`scripts/gc-image-assets.ts:1084-1101`・`status IN ('deleting','deleted')`)
- R2 に触れるのは `deleteObject(asset.objectKey)` のみ(`:399`)。`sweep && !dryRun` 時に **`deleteObject` 1 関数だけ** dynamic import(`:963-971`)
- `lib/storage/r2.ts` の export は 6 つ(`presignPutUrl`/`presignGetUrl`/`headObject`/`getObject`/`putObject`/`deleteObject`)で **list 系は存在しない**
- → **row-less orphan(PUT 成功 → 行 INSERT 失敗)は永久に発見不能**
- `listObjects()` は**未実装の plan**(`docs/superpowers/plans/2026-08-04-ocr-2-4a-t15-source-deletion-cascade.md:74,102`)に記載があるのみ。repo に R2 列挙の実装経路は無い
- source lane(`runSourceReconciler`)も同型の行駆動

## 消費

OCR quota: 300 中 **使用済 28 → 残 272**(smoke で 5+1+5+2+1+5 = 19 ページ消費)。作成した exam / op は証跡として削除していない。
