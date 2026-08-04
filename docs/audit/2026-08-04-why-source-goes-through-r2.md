# source を R2 経由にしている理由の現物確定(②-4a T15 前・調査のみ)

**日付**: 2026-08-04 / **範囲**: 実装・変更・commit なし(read-only)
**問い**: 再利用(再 OCR)が不採用になった今、source を R2 に置く理由が残っているか。

---

## 1. ブラウザ → R2 は presigned PUT の直接アップロード

- `reserveSource` が presigned PUT URL を発行: `app/(app)/app/upload/_actions/source-asset-actions.ts:102`(`presignPutUrl(row.objectKey, mime, byteSize)`)
- client が R2 へ直 PUT: `app/(app)/app/upload/_components/upload-form.tsx:627-628`(`await fetch(reserveResult.data.uploadUrl, { method: 'PUT', … })`)
- その後 server が temp を GET → 実バイト検証 → 最終 key へ **server PUT**: 最終 key 生成 `source-asset-actions.ts:168`、設計 = spec `docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md:229`
- → **バイトは Next server を経由せずブラウザから R2 へ入り、server は R2 から読み直す**。

## 2. OCR / crop の実行単位 = それぞれ別の server action invocation

- OCR = `stagePrepared`(client が呼ぶ: `upload-form.tsx:722`)
- crop = `publishPreparedUpload`(client が呼ぶ: `upload-form.tsx:757`)
- **別 invocation であることはコードコメントに明文化**: `app/(app)/app/upload/_lib/constants.ts:67-70`「OCR(stage-prepared.ts・**別 invocation**)と crop(publishPreparedUpload の Step B・**本 invocation**)が別の server action 呼出に分かれている」
- どちらも**ブラウザ発の HTTP request**。background worker / queue ではない。

## 3. 別 invocation はどこから元画像を取るか → 両方とも R2

- stage: `app/(app)/app/upload/_actions/stage-prepared.ts:10`(`import { getObject } from '@/lib/storage/r2'`)+ 手順コメント `:41-42`(「R2 GET(tx 外・外部 I/O): 各 ready source の最終 key から実バイトを取得」)
- crop: `lib/media/crop-and-store.ts:352`(`const srcObj = await getObject(source.objectKey)`)。objectKey は `source_assets` 行から取得 `:188`
- crop 元の不変条件 = spec `:170`「crop 元 = **Gemini に送ったバイトと同一の画像**」

## 4. タブを閉じても継続する仕組み

- **実行中の invocation**: 90 秒経過後に離脱ガードを外し「閉じてよい」と案内する UI がある(`upload-form.tsx:145-146` / `:175-177` / `:886`「このまま閉じても、後で「試験一覧」から抽出結果を確認できます。」)。**ただし Vercel が client 切断後も function を走らせ続けることを実測・記録した資料は repo 内に無い = 不明**(この UI 文言は legacy 単一 action 時代 S1.9.3 のもの)。
- **次の段階は自動では走らない(現物)**: `stagePrepared` / `publishPreparedUpload` の呼出元は `upload-form.tsx` のみ(grep 済 — server 側の worker / cron / API route / reconciler からの呼出は**存在しない**)。takeover も `claimOperation`(= 次の submit)からしか発火しない(`app/(app)/app/upload/_actions/claim-operation.ts:264` `prepared_taken_over`)。
- → タブを閉じたのが stage と publish の間なら、op は `prepared` のまま止まり、**ユーザーが次に submit した時に takeover して publish**(Gemini は再実行しない: `upload-form.tsx:669-676`)。
- → **R2 依存の実体**: 「閉じても走り続ける」ためではなく、**「後の別 invocation でも crop できる」ため**。takeover 後の publish は crop で R2 GET する(`crop-and-store.ts:352`)ので、この再開経路だけが source の R2 常駐に依存する。

## 5. 1 op あたりの上限と実測時間

- 枚数上限 = **40**: `app/(app)/app/upload/_actions/prepare-upload.ts:55`(`MAX_SOURCES_PER_UPLOAD = OCR_MAX_PAGES`)/ `lib/ai/ocr-limits.ts:4`(`OCR_MAX_PAGES = 40`)
- 合計サイズ = **4MB**: `app/(app)/app/upload/_lib/constants.ts:18,26`。1 file = **5MiB**: `lib/media/upload.ts:72` / `app/(app)/app/exams/[id]/_actions/asset-limits.ts`
- 実測 = **画像 5 枚 → 11 cards、~1-2 分/5 枚**(`docs/superpowers/sessions/2026-08-02-ocr-2-4a-cutover-smoke.md:161`)。全暫定予算を大きく下回り deadline / timeout / maxDuration いずれも未発火(`:163`)
- **per-stage の timing 専用ログは無い**(同 doc `:115`)。**40 枚スケール・モバイル回線の実測は無い = 不明**

## 6. Max Duration / body size

- `app/(app)/app/upload/page.tsx:16` `export const maxDuration = 800`(コメント `:13-15`: server action は**呼出 page の route segment config に従う**ため page 側に宣言)
- `vercel.json` の `functions` 指定は webhook 2 本(60s)のみ。upload 経路の個別指定は無い。
- request body 上限 = `next.config.ts:69` `bodySizeLimit: '4.5mb'`(`next.config.test.ts:54-59` で drift pin)
- 内部予算: OCR 全体 720s(`lib/ai/ocr.ts:60`)/ crop フェーズ 600s(`_lib/constants.ts:71`)/ sharp per-crop 30s

---

## 7. 判定 —「server が画像を受け取り、同一 invocation で OCR + crop まで完了、R2 には crop 済みのみ」は成立するか

### 成立する(現行のスケール・ポリシーの範囲では)。根拠:

1. **サイズ**: OCR 投入上限 4MB < server action body 上限 4.5mb → 1 request で受け切れる。**legacy flow が実際にそうしていた**: `app/(app)/app/upload/_actions/process.ts:152`(FormData の File を受領)→ `:286-287`(`arrayBuffer()` → base64 で Gemini へ)。R2 非経由であることは schema コメントにも明記(`lib/db/schema.ts` source_documents 節「アップロードファイル自体は inline base64 で Gemini に渡すのみで永続化しない (R2 非経由)」)。
2. **時間**: maxDuration 800s に対し実測 5 枚 ~1-2 分。OCR(720s 予算)+ crop(600s 予算)を 1 invocation に束ねる場合は**合算予算の再設計が要る**が、実測スケールでは収まる。
3. **crop 元の不変条件**(spec `:170`)は、同一 invocation でバイトを保持する方が R2 往復より**強く**満たす(finalize の immutability 保証が不要になる)。

### 成立を妨げる可能性がある制約(具体)

- **中断後の「サーバだけで完了」ができなくなる**(唯一の本質的トレードオフ)。現行は `prepared` で止まった op を、次の submit が takeover し **client がバイトを持っていなくても** publish(crop)できる(§4)。1 invocation 方式ではバイトが request 限りゆえ、publish だけの再試行に **client の画像再送**が要る。再送不能なら「図版なしで publish」か「再 OCR = Gemini 再課金」の二択になる。
- **上限スケール未検証**: 40 枚 / 4MB を 1 invocation で OCR + crop した実測は**無い(不明)**。5 枚しか測っていない。
- **メモリ**: 原本 4MB + sharp decode を同一 invocation で保持する必要がある(現行も crop 時に R2 から同じバイトを読むため decode 側の負荷は同等。同時保持枚数の実測は**不明**)。
- **②-4b(PDF)は射程外**: rasterize が入るため本判定は適用しない(未評価)。

### 成立する場合に不要になる部分

- `reserveSource` / `finalizeSource` の saga 一式(`source-asset-actions.ts`)= presigned PUT・temp→最終 key promote・reserved→ready CAS・immutability 保証
- `source_assets` 表と、それに紐づく manifest 検証群(`expected_source_count` / T6 claim の FOR UPDATE 検証 / T8b stage の manifest 再検証)
- **T14b′ の source purge 主経路**(`lib/media/source-purge.ts` + 6 箇所の trigger 配線)と `scripts/gc-image-assets.ts` の source lane
- **T15 の経路 C そのもの**(exam 削除・退会で source_assets 行だけ消えて R2 に orphan が残る問題が原理的に消滅)
- 既存 orphan(stg `src/` の 14 件)の一掃は**別途 1 回必要**(prefix 一括削除で足りる)

### 残るもの(source を R2 に置かなくても必要)

`upload_operations`(冪等 replay / daily cap / lease-fencing)/ `prepared_payload` の atomic publish(spec §1.1 の「未完成カードを DB に置かない」根拠は source 保存とは無関係)/ crop 結果の `assets` + `asset_derivations`。

---

## 8. 結論(現物からの確定)

**source を R2 に置いている構造的理由は、現時点では 1 つだけ残っている: OCR と crop が別 invocation に分かれており、かつ中断後の再開を client のバイト再送なしで完了させられるようにしているため。** 再利用(再 OCR)を目的とした保持は不採用が確定しており、それ以外の理由(サイズ制限・実行時間・crop 元の同一性)は**現物の数値上、R2 を要求していない**。
