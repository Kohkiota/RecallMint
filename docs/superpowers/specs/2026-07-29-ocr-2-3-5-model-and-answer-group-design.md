# ②-3.5: モデル移行(3.1→3.5-flash-lite)+ 解答群 prompt 差し替え 設計 (spec)

- 日付: 2026-07-29
- Sprint: ②-3.5(OCR track / 小)
- 種別: モデル ID 置換 + prompt(COMMON_EXTRACTION_RULES)の解答群記述差し替え
- モデル: Opus
- 前提: fact-finding 不要(prompt / cost.ts の現物把握済・OT 指定)。

## 1. 目的

① prod OCR モデルを `gemini-3.1-flash-lite` → `gemini-3.5-flash-lite` へ移行(世代を上げ解答群の重複抽出が改善するかを見る・単価は 2.5-flash と同額ゆえ値上がりなし)。② prompt の解答群記述を「問題タイプ名(正誤組合せ問題のように)」条件付けから「受験者は何を選ぶか」の単一の問いへ差し替える(「のように」がモデルの類推による適用範囲拡大を招いていたため)。

## 2. 事前確認の結果(OT 要求・実 API・現行コード・組合せ問題サンプル)

OT が組合せ問題を含む新サンプル(`mock-exam-set-p-1..5.png`・5 ページ・実教材ゆえ非 commit)を配置。**現行コード(cost.ts/prompt 変更前)**のまま `ocr-compare.ts --arm A` を **gemini-3.1-flash-lite(現行)+ gemini-3.5-flash-lite(移行先候補)の 2 モデル × 5 ページ**で実行(2026-07-29・OT 合図)。目的 = 変更前に「3.5 でも重複が出るか」を切り分け、モデル移行 / prompt 差し替えのどちらが効くかを isolate。option 本文が question_text に substring 出現 = 重複を programmatic 解析(22 card 行):

- **決定的結果(組合せ問題 = p-2)**:
  - **gemini-3.5-flash-lite**: Card003 で **全 5 選択肢を question_text に列挙(「〔解答群〕ア…オ…」)+ options[] にも同 5 = 完全重複**(dupCount 5)。Card004 も **全 4 選択肢重複**(dupCount 4)。
  - **gemini-3.1-flash-lite(現行)**: 同 Card003/004 で **重複ゼロ**(question_text = リード文+参考表のみ・選択肢は options[] のみ)。
- **→ 移行の前提が反証された**: 3.5-flash-lite は組合せ問題で解答群重複を **悪化**させる(現行 3.1 は重複しない)。「世代を上げて改善」の仮説は**成立せず**。**モデル移行(commit A)は重複目的には逆効果**。
- 他観測: ASCII art 描画は本サンプルでは無し / `![…]` 混入は 3.5 が 2 card・3.1 が 1 card(3.5 やや多)/ 表は参考表が question_text に入る(両モデル・legitimate)・選択肢の表再掲は無し / 致命数値(表の価格・数量・指数値)は両モデル保持(3.5 に軽微な字落ち「物価指数→物価数」)。card/option 脱落は両モデルなし。

- **結論(§1 の再検討が必要)**: **prompt 差し替え(commit B)は必須で確定**(現行 prompt の曖昧性が重複を許し、モデル世代 up では直らない)。一方 **モデル移行(commit A・→3.5-flash-lite)は重複を悪化させるため、この理由での移行は不適**。→ **commit A の是非は OT 判断**(重複以外の移行理由がなければ ②-3.5 から commit A を外し prompt 差し替え単独にする案が有力)。§4.1 / §7 は commit A の可否確定後に調整する。

## 3. 非目標(凍結)

- schema(`lib/ai/schemas/ocr-response.ts` / `lib/ai/ocr.ts` の zod)。
- OCR pipeline。
- **images 関連 prompt 記述**: `IMAGE_REFERENCE_RULES` 全体 + COMMON_EXTRACTION_RULES の line 228「図表参照は本文中にテキストで残す」/ line 233「画像は抽出しない」。**画像関連は全て ②-4 に集約**(§10)。

## 4. 変更

### 4.1 commit A — モデル移行(cost.ts)

- `lib/ai/cost.ts`: `modelId('flash')` → `'gemini-3.5-flash-lite'`(実体 ID は modelId() の 1 箇所のみ = 二重書きなし)。`PRICING_USD_PER_1M['flash']` を `{input:0.25, output:1.5}`(3.1-lite)→ **`{input:0.3, output:2.5}`**(3.5-lite・出典 `scripts/ai/lib/pricing.ts` PRICE_TABLE の 3.5-flash-lite・偶然 2.5-flash と同額)。
- test(`lib/ai/cost.test.ts` / `lib/ai/ocr.test.ts`): 単価 3.5-lite 化で期待値を更新(**保証増 = red 検証**)。flash 単価 pin: 1M in+0out=**45** / 0in+1Mout=**375** / 10k+1k=**0.825** / 1k+0=**0.045**。thoughts 加算 pin(②-2 commit B): `estimateCostYen('flash',0,1M,1M)`=**750** / 3引数=**375**。ocr.test costYen(1M in+100k out)=**82.5** / thoughts 透過(+200k)=**157.5**。modelId('flash')=`'gemini-3.5-flash-lite'`。

### 4.2 commit B — 解答群 prompt 差し替え(COMMON_EXTRACTION_RULES)

`lib/ai/prompts/ocr-extract.ts` の COMMON_EXTRACTION_RULES を差し替え。OT 指定の差し替え後ルール:

- `question_text`: 受験者が最終的に選ぶ選択肢そのもの以外のすべて(リード文 / 前提記述 a〜d / 穴埋め本文 / 参考表 を含む)。
- `options[]`: 受験者が最終的に選ぶ選択肢(1〜5、ア〜オ 等の番号付き行)。
- 同じ内容を question_text と options[] の両方に入れない。
- 選択肢が表形式で並ぶ場合、その表は options[] として抽出し question_text に表として再掲しない。

**整合性の要注意点(OT 判断が要る)**: OT が指定した差し替え対象は line 224-227(重複/例外)だが、**line 223「question_text: … 通常は、解答選択肢を除いた *リード文のみ* を入れる」が新ルール「question_text = 前提記述/参考表を含む」と矛盾する**(前提記述 a〜d は「リード文」ではない)。「のように」を消してもこの矛盾が残ると OT の狙い(prompt の曖昧性除去)が半減する。→ **line 223 も併せて置換**(「リード文のみ」を撤去し新 question_text 定義に統一)を推奨。line 228/233(images)は不触。

**test**: prompt は content ゆえ直接の unit test を持たない(効果は OCR 出力に現れ Phase 2 arm 比較で観測)。既存 prompt を pin する snapshot test は無い(brittle ゆえ追加しない)。→ commit B は test-less の prompt 変更(observe は Phase 2)。

## 5. Phase 構成

- **Phase 1(offline・実 API 不要・commit)**: commit A(cost.ts + test・red 検証)+ commit B(prompt 差し替え)。gate 全通過。canonical + Codex(commit A は cost 数値・commit B は prompt 差分の妥当性)。
- **Phase 2(OT 実 API 合図・観測のみ)**: arm 比較(baseline 2.5-flash vs 3.5-flash-lite)。**観測項目(直さない・§6)**を記録。Phase 順序 = commit-then-confirm(②-2 と同型)。

## 6. 観測項目(Phase 2・直さない)

- 解答群の重複が解消したか。
- 本文への `![qNNN-img-N]` 等の混入が変化したか(描画側は ②-3 で除去済・ここは prompt/model 由来の出力頻度観測)。
- Markdown 表として出力される率の変化(同一画像で表になる/ならないが観測済)。
- 参考: 図の ASCII 描画(②-0 sweep で 3.5-lite に観測)/ 致命シグナル(数値/単位/否定)劣化がないか(劣化 or box2d NG は停止して OT)。

## 7. commit 構成と tag

**2 commit に分離**(変更源が別 = モデル / prompt。片方のみ revert しうる・②-1/②-2 の分離原則):
- commit A(移行): `feat(ai)` `[reviewed]`。
- commit B(prompt): `feat(ai)` `[reviewed]`。canonical + Codex(prompt 差分 = 抽出挙動変更ゆえ review 対象)。
- docs: `docs(...)` `[no-review]`。

## 8. 完了 gate(全 exit 0)

依存不変ゆえ install 系不要。whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit`。既存 flaky は当該 file 単体 PASS で切り分け。

## 9. リスクと停止条件

- 停止(即 OT): Phase 1 で cost test の red 検証不成立 / golden・typecheck・build fail。Phase 2 で致命シグナル劣化 or box2d NG。
- Codex plan cross-check は省略(OT 指定)。実装後 Codex 独立レビューは通常実施。

## 10. 持ち越し(②-4)= 設計事項(記録のみ・②-3.5 では実装しない)

②-4(図版切り出し)着手時に反映:

- **既存の prompt 画像 3 件**(②-2/②-3 spec から継承): IMAGE_REFERENCE 冒頭コメント「別冊切り出せない」= 同ページ図は誤 / COMMON「画像は抽出しない」/「プレースホルダ埋め込み」行削除。
- **A. box_2d は optional でなく nullable 必須**: `box_2d: [number,number,number,number] | null`。optional だと「座標確定不可」と「返し忘れ」が区別不能。null 明示で「確定できなければ null・推測して座標を作らない」を契約化(②-0「欠測を 0 に潰さない」と同型)。別冊参照(ページ内実体なし)は images[] に入れない方針ゆえ、実体ある図で座標が取れないケースは限定的。**`detection_status` 等の状態 field は追加しない**(null で表せる状態を 2 箇所に書くと矛盾する)。
- **B. images[] は要素ごとに safeParse**: 配列全体を一度に検証せず要素ごとに検証し壊れた要素だけ落とす(card 無傷で図が減る)。親 schema で `images: z.array(imageSchema)` にすると画像 1 件の破損で card 全体が失敗するため、**入力境界用と正規化後用で schema を分ける**。
- **C. 検証失敗の隔離範囲(原則・architecture.md に記録)**: 「検証失敗は影響を受ける最小の価値単位まで隔離する。後続処理の安全性を保証できない場合のみ親単位を失敗させる。除外・修復結果は必ず利用者に明示する」。適用: JSON 不読/cards 非配列/有効 card 0 = upload 失敗 / card の question_text・options 破損 = その card 除外(他保存)/ option 1 つ破損 = **card 全体除外**(選択肢欠落は問題の意味と正答確率を変えるため部分救済しない)/ image 破損 = その image 除外 / tag 破損 = その tag 除外。**型か内容かでなく依存関係とユーザー価値で決める**。
- **D. 除外件数のユーザー提示**: 「カード N 件作成 / M 件作成できず / K 件の図版取り込めず」。loud failure over silent zero-rows =「黙って落とすな」。**件数提示までを ②-4 範囲**とし、警告バッジ/除外一覧 UI/再試行導線は実害観測後に判断。
- **E. images の key field は残す**: key は UUID の場合 media_assets lookup / GC sweep / デッキ DL / 削除クリーンアップ / card_asset_refs 射影の主参照 id(fact-finding 確認済)。死んでいるのは OCR の placeholder key であって field ではない。②-4 で切り出し画像に UUID を入れれば placeholder は自然に消える。**field 維持**。
- **test 素材**(②-2/②-3 継承): mock-exam-page2 tracked + 実教材 non-commit。

## 11. spec 凍結

実装フェーズで書き換えない。§3 凍結対象に触れる必要が出たら停止して OT 相談。
