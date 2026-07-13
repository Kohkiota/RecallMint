# Codex plan cross-check — ios-webkit-compression-plan (2026-07-13)

- **作成日**: 2026-07-13
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **WebKit 判定の安全側設計**
   - iPadOS desktop UA 問題を確実に拾う必要がある。
   - iOS Chrome/Firefox も実体は WebKit なので、`CriOS` / `FxiOS` を除外してはいけない。
   - desktop Safari を含めるかは品質・速度差と安全性のトレードオフ。

2. **圧縮 pipeline の根本要件**
   - 元画像サイズ canvas を一切作らないことが核心。
   - `maxWidthOrHeight` だけでなく、per-dimension と total pixels の両方で制限する必要がある。
   - 極端な縦長・横長、1px 境界、0/NaN decode を明示的に扱う必要がある。

3. **decode / encode API の WebKit 安全性**
   - `createImageBitmap` は WebKit で避けるべき。
   - `HTMLImageElement + objectURL + img.decode()` に統一するなら、検証側・fallback 側も同じ経路に揃える必要がある。
   - `objectURL` revoke と canvas 解放は連続添付時のメモリ対策として必須。

4. **出力形式の決定と実 blob の信頼境界**
   - WebP 可否は UA ではなく runtime probe。
   - probe 成功と実 encode 成功は別問題なので、最終的には `blob.type` と magic-byte を見る必要がある。
   - `toBlob` が `null`、空 MIME、要求と異なる MIME、magic mismatch は reject 対象。

5. **検証の位置**
   - reserve 前に検証しないと orphan asset が発生する。
   - PUT 直前 guard は blob 不変なら冗長だが、入れる場合は reserve 後失敗時の orphan 設計が必要。
   - この仕様では reserve 前一段検証に寄せる判断が妥当。

6. **検証の性質**
   - 「白い画像」を reject するのではなく、入力から出力への情報消失を見る必要がある。
   - 正当な低分散画像、白紙、単色、透過 PNG、線画を通すことが優先。
   - 初期は破滅的崩壊のみ reject し、細線消失・局所破損の検出は telemetry 後に強化する設計が現実的。

7. **fallback の完全性**
   - fallback 元画像も型・拡張子だけでは不十分で、decode と magic-byte 検証が必要。
   - fallback の `mime` / `byteSize` / `width,height` / `hash` は圧縮成功時と同じ意味論に揃える必要がある。
   - 楽観層更新が二重に走らないよう、fallback 成功時も同じ primitive を一度だけ使う必要がある。

8. **EXIF orientation**
   - ブラウザ decode が orientation を適用する前提なら、アプリ側で再回転しないこと。
   - 保存 metadata の width/height は圧縮・fallback で同じ oriented 寸法に統一する必要がある。
   - 実機 smoke で orientation 6 以上は必須確認。

9. **メモリ・並列性**
   - 問題は compressed bytes だけでなく canvas/decode メモリなので、圧縮だけでなく検証・fallback decode も逐次化対象にする必要がある。
   - 全 card 横断 single-flight は安全だが、複数添付 UX の待ち時間増がある。

10. **telemetry**
   - 成功だけでは閾値調整できないため、reject / fallback / error も同一 schema で記録する必要がある。
   - 画像本体、ファイル名、hash はログに出さない。
   - `requestedType` と `actualType`、validation metrics、reason の分離が重要。

11. **非 WebKit 回帰**
   - Blink/Firefox の既存 lib 経路は維持するが、共通検証追加による false reject リスクは残る。
   - 「非 WebKit は無改変」という表現は、検証追加まで含めると厳密には無改変ではない。挙動回帰の検証が必要。

12. **server-side defense-in-depth**
   - server の size floor は根本検証ではない。
   - ただし client-only 防御なので、将来の別経路 upload や悪意ある client を考えるなら server 側検査を out にする判断の明示が必要。

13. **実機検証の限界**
   - Mac なし・console なしなら telemetry 依存になる。
   - telemetry が staging で確実に見えること、R2 object の MIME/bytes/表示確認手順が必要。

## plan ドラフトへの抜け・未考慮指摘

1. **`canEncodeWebp` の配置が spec とズレている**
   - spec では `compress-image-safe.ts` の責務として `canEncodeWebp()` が書かれているが、plan Task 1 では `webkit-detect.ts` に置いている。
   - 実装上は問題ない可能性があるが、WebKit 判定と encode probe は概念的に別責務。ファイル分離または責務説明の明確化が必要。

2. **Task 2 の `ValidationMetrics` 型が入出力ペアを表現しきれていない**
   - plan は `ValidationMetrics = { opaqueRatio; meanLuma; lumaVar; edgeEnergy; mae }` と読める。
   - reject 条件には input/output それぞれの `opaqueRatio` / `lumaVar` が必要なので、`input` / `output` を分けた型にすべき。
   - telemetry でも source/output metrics の意味が曖昧になる。

3. **fallback 用の構造検証 API が明示されていない**
   - Task 5 は「元 blob の構造検証」と書くが、Task 2 の exported interface は `validateCompressionOutput(input, output, expected?)` 中心。
   - 元画像単体の `validateImageStructure(blob)` や decode 寸法取得 API を共通化しないと、Task 5 で重複実装・仕様ズレが起きやすい。

4. **alpha 判定の実装方法が plan で薄い**
   - spec は no-WebP 時に alpha 有無で PNG/JPEG を決める。
   - plan Task 3 では「alpha あり → PNG」とあるが、いつ・どの canvas/pixel sampling で alpha を判定するかが未定義。
   - JPEG 白塗りとの順序も重要。白塗り前に alpha 判定しないと alpha 情報を失う。

5. **JPEG 白塗りの条件がやや曖昧**
   - Task 3 は「else JPEG(drawImage 前に白塗り)」とある。
   - 実際には JPEG 出力時だけ白塗りし、PNG/WebP では alpha 維持するのか、WebP でも背景合成するのかを明記した方がよい。
   - WebP は alpha 対応なので、通常は白塗り不要。

6. **single-flight の適用境界が Task 4/5 に分散している**
   - Task 4 は WebKit 時の圧縮+検証を逐次化。
   - Task 5 は fallback decode も `runExclusiveImageWork` 内。
   - ただし compress 失敗から fallback decode までを「1添付単位で連続して exclusive」にするのか、圧縮失敗後にロックを解放して fallback で再取得するのかが曖昧。メモリ安全優先なら attach 全体の画像処理区間を一つの exclusive work に寄せる方が明確。

7. **telemetry outcome の重複・粒度が曖昧**
   - plan は `validation_rejected→fallback` と `fallback_used` の両方を記録するようにも読める。
   - spec は「全転帰を同一 schema で 1 レコード」としているため、1 attach に対して reject と fallback success を別レコードにするのか、最終 outcome `fallback_used` に reason `validation_failed` を載せるのかを決める必要がある。
   - 「1レコード」方針なら plan Task 6 は明確化が必要。

8. **非 WebKit 経路の「無改変」表現が強すぎる**
   - plan の Global Constraints は「非 WebKit の既存 compressForAttach 経路は無改変」と書くが、共通検証を通す時点で observable behavior は変わる。
   - より正確には「圧縮処理は既存 lib 維持。圧縮後検証は追加」と書くべき。

9. **`source.width,height` の取得失敗時 telemetry が未定義**
   - 成功 telemetry では source dimensions を持てるが、decode 不能・fallback 構造 fail・入口 gate fail では width/height が取れない。
   - nullable にするのか、省略するのか、`0` にするのかを schema で決める必要がある。

10. **`requestedType` の意味が fallback/lib で曖昧**
   - WebKit safe pipeline では requested encode type がある。
   - lib 経路や fallback 元画像では requested type がない、または元 MIME。
   - telemetry schema で `requestedType?: string` などにしないと、実装者が適当に埋めるリスクがある。

11. **`blob.type` 空文字の fallback 元画像扱い**
   - spec は fallback 許可形式を jpg/png とし `mime=file.type` とする。
   - ただし iOS/ブラウザによって `file.type` が空になるケースをどう扱うかが plan では薄い。
   - 「拡張子で許可しても `file.type` 空なら magic から MIME 補完するのか、明示エラーにするのか」を決める必要がある。spec 寄りなら空 MIME は fail だが、ユーザー影響がある。

12. **既存 upload.ts の責務肥大リスク**
   - Task 4-6 がすべて `upload.ts` 変更で、分岐・fallback・telemetry・single-flight が集中する。
   - plan には抽出境界がない。既存 saga の複雑度次第では、`buildAttachUploadPayload` 的な純関数化や telemetry helper が必要になる可能性がある。

13. **実機 smoke の fallback/reject 観測方法**
   - 通常の良品画像だけでは `fallback_used` や `validation_rejected` が実機で出ない可能性が高い。
   - plan は「全転帰が理由付きで記録」と書くが、どうやって staging 実機で reject/fallback を誘発するかが未定義。
   - unit で十分にするのか、テスト用破損 blob 注入手段を用意するのか判断が必要。

14. **R2 手動掃除の責任・対象特定**
   - plan は手動掃除を完了条件に含めるが、対象 key の特定方法や誤削除防止がない。
   - 実装 plan としては OT 作業でも、session doc の参照だけでなく対象条件を明記した方が安全。

15. **build 不要の記述が spec と衝突**
   - spec の Ops は `pnpm lint --max-warnings=0` / `typecheck` / `build` / `test`。
   - plan Global Constraints では「client component は build 不要」とある一方、Task 6 完了条件では build を含めている。
   - 最終 gate と per-task gate の違いとして明記すべき。現状は読み手が迷う。

## リスク / 対立しうる設計判断

1. **安全性 vs UX**
   - 全 card 横断 single-flight は iOS メモリ安全には強いが、複数画像添付の待ち時間が伸びる。
   - queue 状態やキャンセル時 cleanup の扱いを誤ると、ユーザーには「固まった」ように見える。

2. **false positive vs false negative**
   - 初期閾値は誤検知回避寄りで妥当。
   - ただし局所破損・文字潰れ・細線消失は見逃しうる。要件上は受容だが、添付用途がスクショ/メモ中心なら将来強化が必要。

3. **desktop Safari を WebKit safe pipeline に含めるか**
   - 含めると iPad 見逃しリスクは下がる。
   - 一方で desktop Safari だけ圧縮品質・速度・出力形式が変わり、既存 lib と差分が出る。

4. **client-only validation の限界**
   - 通常 UI 経路の破損対策としては十分だが、server は壊れた object を防げない。
   - 別 upload 経路や悪意ある client があるなら defense-in-depth は別途必要。

5. **WebP 優先 vs JPEG/PNG 分類**
   - WebP 優先は実装が単純で modern WebKit に合う。
   - no-WebP fallback を alpha のみで決めると、写真 PNG 化や図表 JPEG 化の品質/サイズ最適化は捨てる判断になる。

6. **reserve 前検証一段 vs PUT 直前 guard**
   - reserve 前一段は orphan 防止に強い。
   - PUT 直前 guard を省く前提は blob 不変性に依存する。実装中に blob を再生成・差し替える構造が入ると前提が崩れる。

7. **telemetry の詳細度 vs PII**
   - 閾値調整には metrics が多いほどよい。
   - ただし file 名・hash・画像内容を出さない制約下では、個別事象の追跡性は限定される。数値 metadata のみに徹する設計は妥当だが、調査運用の限界はある。