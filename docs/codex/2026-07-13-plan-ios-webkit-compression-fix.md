# Codex plan cross-check — ios-webkit-compression-fix (2026-07-13)

- **作成日**: 2026-07-13
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **WebKit 判定は「漏れ最小」が重要**
   - iPadOS desktop UA、iOS 全ブラウザ、desktop Safari を拾う必要がある。
   - ただし UA だけでは不十分で、canvas / encode 能力 probe と役割を分けるべき。
   - WebKit 判定は圧縮 pipeline の選択、WebP 可否は出力形式選択であり、同じ判定に混ぜると誤る。

2. **canvas 上限は edge と pixels の両方で守る必要**
   - 面積だけでは長辺が iOS/WebKit の per-dimension 上限に触れる。
   - 最初から出力寸法 canvas を作ることが必須で、元画像サイズ canvas や中間巨大 canvas を作る実装は再発要因。
   - `round` による 0px 化、極端な縦長・横長画像、1px 近辺の境界も考慮が必要。

3. **decode 経路そのものが iOS で不安定になりうる**
   - `createImageBitmap`、worker、OffscreenCanvas、`img.decode()` は WebKit 世代差が出やすい。
   - decode 失敗時に fallback できるのか、fallback にも寸法取得が必要ならそこで詰まらないかを整理すべき。
   - object URL revoke、image/canvas 解放、連続添付時のメモリ圧迫が重要。

4. **EXIF orientation は圧縮・検証・寸法保存の全てに影響する**
   - ブラウザが自動適用した表示寸法と、server に保存する width/height が一致する必要がある。
   - 入力比較用の 64×64 サンプルと出力サンプルでも同じ orientation 前提で比較しないと、MAE や edge が不自然になる。
   - fallback で元画像を PUT する場合、保存寸法が EXIF 適用後か raw pixel 寸法かを明確にする必要がある。

5. **出力形式は実 blob.type を信頼しつつ、blob.type の空文字・偽装を扱う必要**
   - canvas encode が要求 MIME を無視して PNG を返すケースがある。
   - `toBlob` が `null` を返す、`blob.type` が空、magic-byte と不一致になるケースを失敗扱いにする必要がある。
   - presigned PUT の Content-Type、reserve の mime、表示側の拡張子/URL metadata が全て同じ値を使うべき。

6. **JPEG fallback 時の alpha 処理は白塗りだけでは足りない可能性**
   - 透過 PNG を JPEG 化すると情報の意味が変わるため、alpha ありなら PNG/WebP を優先すべき。
   - 白い背景の透過素材は問題になりにくいが、暗色 UI 用素材などは見た目が変わる。

7. **検証は reserve 前が必須**
   - 壊れた blob を reserve→PUT させないため、圧縮直後・reserve 前に主検証が必要。
   - PUT 直前にも安価な guard を置く価値はあるが、主防御は reserve 前。
   - reserve 後に fallback へ切り替わる設計だと孤児 asset や署名不一致が起きやすい。

8. **検証ロジックは誤検知回避を最優先にすべき**
   - 正当な白紙、低分散画像、スクショ、手書きメモ、線画、透過 PNG を落とさないことが重要。
   - 「白い」「低分散」単独 reject は危険。
   - 入力が情報量を持つのに出力だけ情報量を失った、という相対判定に寄せるべき。

9. **見逃しリスクも残る**
   - 64×64 サンプルでは局所破損、片側だけの欠落、細線の消失、文字潰れを見逃す可能性がある。
   - 中央だけ正常で端が壊れるケース、または端だけ重要なスクショもありうる。
   - 複数サンプル、全体縮小、edge/MAE の補助 telemetry が必要。

10. **fallback は「元画像を上げれば安全」とは限らない**
   - 元が jpg/png かつ ≤5MiB でも、decode 不能・拡張子偽装・MIME 空文字・orientation 未確定の可能性がある。
   - reserve には寸法と hash が必要なので、fallback 用にも信頼できる metadata 算出が必要。
   - 元画像が PNG で 5MiB 以下でもピクセル寸法が巨大な場合、表示・Cache mirror・decode メモリに影響する。

11. **fallback 成功時の UX / telemetry 区別が必要**
   - ユーザーには成功に見えるが、内部的には圧縮・検証失敗が起きている。
   - `compressionPath=fallback`、元 mime、元 byteSize、失敗 reason を必ず残さないと後続調整ができない。

12. **並行性はカード単位ではなくアプリ全体で見るべき**
   - iOS では複数 card、複数添付、再試行、画面遷移中 upload が重なる可能性がある。
   - 圧縮のみ逐次化しても、decode/validation/fallback metadata 取得が並列ならメモリ問題が残る可能性がある。
   - 中断時に object URL、canvas、optimistic Cache、reserve 済み asset が残らないか確認が必要。

13. **error code は既存互換と原因可観測性が対立する**
   - UI 互換のため既存 `COMPRESS_FAILED` を維持するのは妥当。
   - ただし telemetry では `compress_failed`、`validation_failed`、`fallback_not_allowed`、`fallback_too_large`、`decode_failed` を分けるべき。

14. **server 側の下限なしは再発時の検出を弱くする**
   - 要件では client 検証が主だが、server reserve/finalize は size 一致のみ。
   - 856B webp のような極小破損を client が漏らすと server は通す。
   - server-side re-encode は out でも、最低限の mime/size 下限や metadata sanity を入れるかは論点。

15. **telemetry は閾値調整可能な粒度が必要**
   - path、source/output、validation reason、各 metric、fallback reason が必要。
   - 画像 bytes や hash を PII 的に扱うか、ログに hash を出すかは慎重に決めるべき。
   - 成功例だけでなく reject/fallback 例が収集されないと閾値調整できない。

## plan ドラフトへの抜け・未考慮指摘

1. **fallback の「元画像は入口 gate 通過済で decode 可能なため検証自明 pass」は弱い**
   - 入口 gate は型/拡張子中心であり、実 decode 可能性や magic-byte 整合までは保証しない。
   - fallback でも少なくとも構造検証、寸法取得、magic/type 確認は必要に見える。

2. **fallback 元画像の寸法が EXIF 適用後か raw 寸法か未確定**
   - plan は `width,height = decode 実寸` とするが、EXIF orientation が絡む場合の定義が曖昧。
   - 圧縮版と fallback 版で保存寸法の意味が変わると、表示・レイアウト・validation 比較でズレる。

3. **64×64 単一サンプルの見逃しリスクへの対策が薄い**
   - plan は metrics を取るが、端欠け・部分描画・細線消失・文字潰れの見逃しに対する設計が弱い。
   - 少なくとも「全体縮小で端を含む」「複数領域サンプル」などを検討論点として明示した方がよい。

4. **`createImageBitmap` を検証で使う点が WebKit 方針と少し衝突**
   - 圧縮 pipeline では iOS で `createImageBitmap` を避けるとしている一方、構造検証では再 decode に使う記述がある。
   - WebKit で `createImageBitmap` が不安定なら、validation 自体が false fail になりうる。HTMLImageElement decode fallback が必要。

5. **WebKit 判定の正規表現が iOS Chrome/Firefox を除外しうる**
   - plan の AppleWebKit 判定では `CriOS` や `FxiOS` を除外している。
   - ただし iOS Chrome/Firefox も WebKit 強制なので、別条件で確実に拾えているかを unit で厳密に見る必要がある。

6. **`toDataURL('image/webp')` probe と実 encode の一致保証が弱い**
   - 小 canvas probe が成功しても、大きめ canvas の `toBlob` / `toDataURL` が同じ MIME で安定するとは限らない。
   - 実出力後の magic/type 検証で拾えるが、形式選択の fallback 戦略も明示した方がよい。

7. **`toDataURL` 利用はメモリ面で不利**
   - probe は小 canvas なので問題は小さいが、実 encode まで `toDataURL` を使うなら base64 文字列でメモリを余分に食う。
   - plan の文面は WebP 経路で `toDataURL` と書いており、実装は `toBlob` 優先にすべき。

8. **逐次化の範囲が圧縮だけで十分か未確定**
   - plan は `runExclusiveImageWork` を圧縮に置くが、validation の input/output decode も canvas を使う。
   - iOS メモリ対策なら、圧縮・検証・fallback metadata decode まで同じ single-flight に含めるか検討が必要。

9. **server 側 defense-in-depth が out 扱いに近い**
   - client 修正が主でよいが、server が 856B webp を通す構造は残る。
   - 少なくとも今回の破損パターンを弾く軽量 sanity check を入れない判断なら、その理由を明示した方がよい。

10. **telemetry の失敗ログ仕様がやや不足**
   - 成功時 1 レコードは書かれているが、compress throw、validation reject、fallback 成功/失敗、PUT 前 guard 失敗を同じ schema で残すかが曖昧。
   - 閾値調整には reject された画像の metrics が特に重要。

11. **optimistic Cache と fallback の整合が未詳細**
   - fallback で元画像 PUT になった場合、Cache mirror に入れる blob/mime/asset metadata が圧縮成功時と同じ扱いでよいか確認が必要。
   - 圧縮失敗後 fallback 成功時に、UI 上の optimistic state が二重更新・不一致にならないかが論点。

12. **PUT 直前 guard 失敗時の後始末が未記載**
   - reserve 後・PUT 前に guard が失敗した場合、すでに reserved asset が存在する。
   - 画像 GC は out だが、この局所的な orphan をどう扱うか、または guard を reserve 前だけに寄せるかを決める必要がある。

13. **元画像 direct PUT の hash/mime 算出タイミングが曖昧**
   - 圧縮版で hash をどこで計算するか、fallback で再計算するか、reserve 前に必ず一致した metadata を持つかを明確にする必要がある。

14. **テストに magic-byte/type 不一致と blob.type 空文字が明示されていない**
   - 破損検出の核なので、unit に入れるべき。
   - `toBlob(null)`、unsupported MIME fallback PNG、空 blob、極小 blob も重要。

15. **実機 smoke の EXIF orientation 1-8 は実施難度が高い**
   - OT iPad だけで 8 種の素材を用意し、telemetry だけで二重回転なしを判断できるか不明。
   - 表示確認方法、素材、期待寸法を事前に定義しないと完了条件が曖昧になる。

## リスク / 対立しうる設計判断

1. **false-positive を避ける vs 壊れ画像を絶対に止める**
   - 要件は誤検知回避優先。
   - その分、局所破損や軽度の情報欠落は通る可能性がある。
   - 初期は破滅的崩壊のみ reject、telemetry で閾値強化が妥当。

2. **WebKit false-positive 許容 vs 非 iOS Safari の品質/性能**
   - desktop Safari も自前 pipeline に寄せると安全側。
   - 一方で既存 lib より圧縮品質・ファイルサイズ・処理速度が変わる可能性がある。

3. **WebP 優先 vs 互換 fallback の単純化**
   - WebP probe 成功時に WebP 一択は実装が単純。
   - ただし図表・スクショ・透過素材・写真で最適形式が違うため、ファイルサイズや画質の最適性は犠牲になる可能性がある。

4. **client 完結 vs server 防御**
   - direct-to-R2 構成では client 検証が自然。
   - ただし server が内容を見ない限り、client 漏れや将来回帰には弱い。

5. **single-flight の安全性 vs UX**
   - iOS 逐次化はメモリ安全に効く。
   - 複数画像添付時の待ち時間は伸びるため、タイムアウト・キャンセル・進捗なし UX が問題になりうる。

6. **fallback direct PUT の成功率 vs ストレージ/表示負荷**
   - 元画像 ≤5MiB を許すとユーザー成功率は上がる。
   - ただし大きい pixel 寸法の PNG/JPEG が残り、表示 decode や Cache 容量に負荷を残す。

7. **telemetry 十分性 vs privacy**
   - 閾値調整には source/output metadata と validation metrics が必要。
   - hash、ファイル名、詳細寸法の扱いは privacy 方針に合わせる必要がある。