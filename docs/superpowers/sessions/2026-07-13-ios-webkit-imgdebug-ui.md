# iPad 画像添付診断 — 一時デバッグ UI(原因特定後に撤去)

- **日付**: 2026-07-13
- **commit**: feat `5b30c00`(`[reviewed]`)/ codex `075b955`(`[no-review]`)
- **性質**: **一時的な診断 UI**。iOS/WebKit 圧縮修正を入れても iPad で「画像の処理に失敗しました」が続くため、Mac/コンソール不要で原因を確定するために追加。**原因特定後に撤去する**。

## 目的

iPad の画面上に、画像添付 1 回ごとの telemetry を人間可読で表示し、OT がスクショで原因を確定する:
- **A**: 圧縮がまだ壊れた output(≈856B / 空)を出している(= 圧縮側がまだ壊れている)
- **B**: 圧縮は健全だが検証が正常 output を誤 reject している(= 検証の誤検知)
- 併せて **compressionPath が `webkit-safe` か**(自前 pipeline が iPad で engage しているか。`lib` なら判定/分岐の穴 = 別原因)。

## OT の使い方(iPad)

1. iPad(Safari or Chrome)で対象 exam を **`?imgdebug=1` 付き URL** で開く(例 `…/app/exams/<id>?imgdebug=1`)。または任意ページの console 不要で `localStorage.setItem('recallmint:imgdebug','1')`。
2. カードの「画像を追加」で問題の画像を添付する。
3. 添付エリア直下に **🐞 画像 telemetry パネル**が出る → **スクショ**。
4. パネルの 1 行目 verdict:
   - `🅰 圧縮出力が破損/空(…)` → **A(圧縮側)**。
   - `🅱 出力は健全に見えるのに検証 reject` → **B(検証誤 reject)**。
   - `⚠️ path=lib(自前 pipeline 未通過)` → 判定/分岐が iPad で engage していない(別原因)。
   - `元画像 fallback で成功` → 圧縮は失敗したが元画像で復帰(圧縮出力欄が破損なら A の兆候)。
5. パネルの raw 値(compressionPath / 圧縮出力 bytes・寸法 / 検証メトリクス 入力→出力 / outcome・reason)も一緒に読める。

## 実装(production footprint は最小・撤去容易)

- `lib/media/upload.ts`: `ImageAttachTelemetry` 型 export + `attachImageToCard` に **optional `onTelemetry` callback**(finishAttach が logger と同 record を 1 回渡す・callback 例外は握って never-throw 契約維持)。検証 reject でも**実出力サイズ/寸法**を運ぶ(A/B 判別の核心)。
- `image-telemetry-debug.tsx`(新): 自己 gate(`?imgdebug=1` or localStorage)+ 折りたたみパネル + verdict。
- `card-image-gallery.tsx`: `onTelemetry` で record を state 捕捉しパネル描画(`!readOnly` のみ)。

## 撤去手順(原因特定後)

1. `image-telemetry-debug.tsx` + `.test.tsx` 削除。
2. `card-image-gallery.tsx` の import / state / `onTelemetry` 配線 / パネル描画を除去(gallery test の `onTelemetry: expect.any(Function)` も戻す)。
3. `upload.ts` の `onTelemetry` param / `AttachTelemetry.onTelemetry` / `ImageAttachTelemetry` export / `ValidationFailedError.output` / finishAttach の callback 呼び出しを除去(logger.info telemetry は残す)。upload.test.ts の onTelemetry 2 test を除去。
   - ※ `ValidationFailedError.output`(reject 時の出力サイズ捕捉)と fallback の `if (!t.output)` は telemetry 精度向上として**残す判断も可**(logger 側の診断価値がある)。撤去時に OT 判断。

## 露出注記(OT 判断)

- gate は `?imgdebug=1`(URL)/ localStorage で、**prod bundle にも含まれ guessable param で有効化可**。表示は非 PII(MIME/サイズ/寸法/メトリクスのみ・file 名/hash/画像 bytes 非表示)ゆえ security 問題ではないが、**一時ゆえの露出窓を OT が承認**した上で使い、原因特定後に撤去する。

## レビュー収束

canonical(general-purpose/sonnet)= Crit1(verdict の B 分岐が検証の reject 条件〔出力 lumaVar<4〕と矛盾し到達不能 = 誤って常に A 断定)+ Imp1(onTelemetry 未 test)を修正。Codex 4 周収束(r1 fallback が破損圧縮出力を上書き隠蔽 → r2 error+decode_failed が中立表示 → r3 fallback_used+decode_failed 同 → r4 clean。`compressOutputBroken = decode_failed || 出力空/極小` で両経路統一)。build0/lint0/typecheck0・whole-repo 3492 green。

## 撤去完了(2026-07-13)

- **commit**: `df98cf6` feat(media,exams)`[reviewed]`。原因 = push 忘れ(iPad HEIC/PNG は通過・圧縮修正は正常動作)と判明したため、§撤去手順どおり画面表示 UI を撤去。
- **撤去内容**: image-telemetry-debug.tsx(+.test.tsx)削除 / card-image-gallery.tsx の imgdebug 配線除去(import・debugRecord state・onTelemetry・パネル描画)/ upload.ts の onTelemetry param・callback・ImageAttachTelemetry export を除去 / upload.test.ts の onTelemetry 2 test + gallery test の onTelemetry assertion 除去。
- **残置(OT 判断 = 残す)**: `ValidationFailedError.output` + fallback の `if(!t.output)` guard は **logger telemetry(image_attach record の output)の精度**として残置(reject/fallback 時も実出力サイズを prod ログに残す)。関連コメントを「デバッグ UI」→「logger telemetry」表現に更新。**telemetry 記録(logger.info)本体は無傷**。
- **review**: canonical(general-purpose + code-reviewer.md 改変なし)Crit0/Imp0/Minor1(fallback guard コメント表現 = 修正済)+ Codex 独立 Crit0/Imp0/Minor0(`docs/codex/2026-07-13-imgdebug-removal.md`)。
- **gate**: whole-repo `pnpm lint --max-warnings=0` exit0 / typecheck exit0 / test 3480 green / build exit0。
- **残タスク**: OT push → stg で画像添付本経路が引き続き通るか軽く確認(UI 層のみ撤去ゆえ本経路不変の想定)。
