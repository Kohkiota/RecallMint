# T14b′ §A smoke 判定補助 — source の R2 経路と観測性(read-only 診断)

**日付**: 2026-08-03 / **read-only**(実装変更なし・file:line + 実装根拠)。stg R2 timestamps / Vercel ログは CC 到達不可ゆえ該当項は「OT 確認」or「不明」と明記。

## 結論(先に)
1. **source は R2 を経由する**(bypass しない)。temp(client PUT)→ finalize が最終 key へ server PUT → **OCR(Gemini)も crop(sharp)も最終 key を R2 から読む** → 完走 purge が最終 key を削除。
2. **目視すべきは最終 source `users/{uid}/src/{assetId}.{ext}`(src/ 直下)**であって temp(`src/tmp/{assetId}`)ではない。**temp は finalize で即消える(短命)/ 最終 source は finalize〜完走 purge まで=処理時間ぶん存在**。OT が `src/tmp/` を見ていたなら最短命の方を見ていた可能性が高い。
3. **purge は成功時サイレント(app ログ無し)**。ゆえに §A の判定は目視/ログでなく **DB 行消滅 + R2 404 の不在確認**に置き換えるのが確実(下記提案)。
4. **要確認(最優先)**: T14b′ commit `3c962a2` は**未 push**。smoke した deploy がこれを含むか(手順書 §0)。含まないなら purge は動いておらず、観測は反転前挙動。

---

## 1. 散らばっている src / tmp オブジェクトの素性 → **一部 不明(要 OT: R2 timestamps)**+ 強い推定

- **強い推定**: 反転前(T14b/T14b′ 前)は **source purge が存在しなかった**ため、cutover smoke 以降の**全完走 upload の最終 source が `src/{id}.ext` に残留**(回収機構なし)=「ページ全体の画像が散らばっている」の主因。加えて finalize の **temp 削除は best-effort・サイレント**(`source-asset-actions.ts:285`)ゆえ、削除に失敗した temp が `src/tmp/` に孤児化して残る。さらに finalize 未実行の reserved source(temp key)も残る。
- **新規 vs 古い の判別**: R2 オブジェクトの作成日時が要る → **CC は stg R2 に到達不可 = 不明**。OT が R2 console の作成日時で判別。
- **DB 行の有無(回収可能性)** — OT が実行:
  ```sql
  SELECT sa.id, sa.status, sa.object_key, sa.created_at,
         op.status AS op_status
  FROM source_assets sa
  LEFT JOIN upload_operations op ON op.source_document_id = sa.source_document_id
  WHERE sa.user_id = '<uid>'::uuid
  ORDER BY sa.created_at DESC;
  ```
  - **行あり**(status=ready/reserved)= 網が回収可能(T14b′ 網 Class A/B・要 deploy + sweep 実行)。
  - **R2 に在るが対応行なし** = orphan。src/tmp 側は **finalize temp 削除失敗(経路 E)**、src/ 側で行なしは **exam/退会 cascade で行だけ消えた経路 C**(=T15 scope)。R2 key ↔ source_assets.object_key の突合で判別(object_key に載っている key が R2 に在り DB に無い=orphan)。

## 2. 今回の op で purge が実行されたか → **不明(要 Vercel ログ/trace)**+ 確認方法

CC は Vercel ログに到達不可。OT が確認する箇所:
- **purge は成功時サイレント**(`lib/media/source-purge.ts` の success path に logger 無し・失敗時のみ `:110 recordIntegrationFailure` / `:118,:141 logger.error`)。→ app ログに「purge 成功」の痕跡は出ない。
- **R2 削除の実痕跡 = Vercel Function trace の「External APIs」**(cutover 手順書 §4 と同じ)。`publishPreparedUpload` invocation の trace に **R2 DELETE `.../src/{assetId}.{ext}`** が出れば purge が R2 を叩いた証拠。同 op の finalize invocation には **R2 PUT `.../src/{assetId}.{ext}`** が出る。
- **失敗痕跡** = `integration_failures` に `r2_gc_delete_source`(key)行。無ければ purge は失敗していない。
- **どの terminal 経路か**: 正常完走なら completed(`publish-prepared-orchestrate.ts:409` が purge 呼出)。失敗なら terminal_failed(claim:461 / stage:447,538 / abandon:136,138 / prepare supersede:508)。trace の invocation 名で判別。
- **実測経過時間** = 下記 §4 の residence window(finalize→完走)。

## 3. source は R2 を経由するか → **経由する(definitive・file:line)**

| 段階 | R2 操作 | key | file:line |
|---|---|---|---|
| reserve | (行のみ) | temp `users/{uid}/src/tmp/{assetId}` | `prepare-upload.ts:416` |
| client PUT | **PUT** temp | 同上(presigned) | reserveSource presigned(source-asset-actions) |
| finalize | GET temp → **PUT final**(server)→ **DELETE temp**(best-effort) | 最終 `users/{uid}/src/{assetId}.{ext}` | PUT `source-asset-actions.ts:181` / temp DELETE `:285` |
| OCR(stage) | **GET final**(Gemini 入力) | 最終 | `stage-prepared.ts:473`(`getObject(source.objectKey)`) |
| crop(publish) | **GET final**(sharp 入力) | 最終 | `crop-and-store.ts:352`(`getObject(source.objectKey)`) |
| 完走 purge | **DELETE final** + 行 DELETE | 最終 | `source-purge.ts:102`(deleteObject)/ `:135`(行 DELETE) |

- OCR/crop はいずれも `source_assets.objectKey`(finalize 後は**最終 key**・`source-asset-actions.ts:228` で最終 key に更新)を R2 から読む。**R2 を経由せず直接処理する経路は無い**。
- **tmp→src の promote と purge の時系列**:
  1. client PUT → temp 存在開始
  2. finalize: 最終 key PUT(最終 source 存在開始)→ **temp DELETE(temp 消滅)**
  3. stage(OCR)/publish(crop)が最終 source を read(この間ずっと存在)
  4. 完走 → purge が最終 source DELETE(最終 source 消滅)

## 4. 目視観測は可能か → **原理上は最終 source が処理時間ぶん存在するが、判定は不在確認へ切替を推奨**

- **temp `src/tmp/{id}`**: client PUT〜finalize temp 削除。**短命**(finalize の GET+sharp検証+PUT+CAS 分=数秒/source)。目視困難。
- **最終 source `src/{id}.ext`**: finalize〜完走 purge。**= 処理時間ぶん存在**。cutover 実測で 5 枚 ~1-2 分ゆえ、複数枚なら数十秒〜分オーダー(=目視可能)。ただし **1 枚の小 upload で OCR が速いと数秒**になり、手動更新 + R2 eventual consistency では取りこぼしうる。
- **purge 成功がサイレント**ゆえ「消えた瞬間」をログで押さえられない。
- **§A 判定方法の見直し提案(目視 → 決定的な不在確認)**:
  - **判定 = 完走後の DB + R2 不在**: `SELECT count(*) FROM source_assets WHERE source_document_id=:sdId` → **0**(purge で行削除)+ R2 HEAD `src/{assetId}.{ext}` → **404**。crop 図版(`users/{uid}/{figureAssetId}.webp`)と cards は**残る**ことも併せ確認。
  - **purge の実行痕跡 = Vercel trace External APIs の R2 DELETE**(§2)。
  - **(follow-up・別 commit)** purge 成功時に `logger.info`(op/sourceDocumentId・PII-free)を 1 行足せば、将来 smoke で「purge 実行 + 時刻」がログで確定できる。現状サイレントは観測性の穴。**要 OT 判断で follow-up 起票**(実装変更ゆえ本診断では入れない)。

---

## OT へのアクション(CC 不能分)
1. **deploy SHA が `3c962a2` 以降か確認**(未 push ゆえ最優先。含まねば purge 未稼働=反転前挙動)。
2. §1 SQL で散らばり object の DB 行有無を突合(row あり=網回収可 / row なし=orphan[E or C])+ R2 作成日時で新旧判別。
3. §2 の Vercel trace External APIs で今回 op の R2 PUT(finalize)/ R2 DELETE(purge)を確認。
4. §4 の不在確認へ §A 判定を切替(目視は timing 脆弱)。purge 成功ログ追加は follow-up 判断。
