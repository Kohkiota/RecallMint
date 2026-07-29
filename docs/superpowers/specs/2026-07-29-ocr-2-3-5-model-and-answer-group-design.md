# ②-3.5: 解答群 prompt 差し替え(COMMON_EXTRACTION_RULES)設計 (spec)

- 日付: 2026-07-29
- Sprint: ②-3.5(OCR track / 小)
- 種別: prompt(COMMON_EXTRACTION_RULES)の解答群記述差し替え **のみ**(モデル移行は §2 の実測で撤回)
- モデル: Opus
- 前提: fact-finding 不要(prompt / cost.ts の現物把握済・OT 指定)。

## 1. 目的

prompt の解答群記述を「問題タイプ名(正誤組合せ問題のように)」条件付けから「受験者は何を選ぶか」の単一の問いへ差し替える(「のように」がモデルの類推による適用範囲拡大を招き、組合せ問題で解答群を question_text と options[] に**重複抽出**させていたため)。**モデルは gemini-3.1-flash-lite を維持**(3.5-flash-lite への移行は §2 の実測で撤回。cost.ts は不触)。

## 2. 事前観測の結果(OT 要求・実 API・現行コード・組合せ問題サンプル)→ モデル移行を撤回

OT が組合せ問題を含む新サンプル(`mock-exam-set-p-1..5.png`・5 ページ・実教材ゆえ非 commit)を配置。**現行コード(cost.ts/prompt 変更前)**のまま `ocr-compare.ts --arm A` を **gemini-3.1-flash-lite(現行)+ gemini-3.5-flash-lite(移行先候補)の 2 モデル × 5 ページ**で実行(2026-07-29・OT 合図)。目的 = 変更前に「3.5 でも重複が出るか」を切り分け、モデル移行 / prompt 差し替えのどちらが効くかを isolate。option 本文が question_text に substring 出現 = 重複を programmatic 解析(22 card 行):

- **決定的結果(組合せ問題 = p-2)**:
  - **gemini-3.5-flash-lite**: Card003 で **全 5 選択肢を question_text に列挙(「〔解答群〕ア…オ…」)+ options[] にも同 5 = 完全重複**(dupCount 5)。Card004 も **全 4 選択肢重複**(dupCount 4)。裏取り済(該当 card raw を抽出確認)。
  - **gemini-3.1-flash-lite(現行)**: 同 Card003/004 で **重複ゼロ**(question_text = リード文+参考表のみ・選択肢は options[] のみ)。
- 他観測: ASCII art なし / `![…]` 混入は 3.5 が 2 card・3.1 が 1 card(3.5 やや多)/ 参考表は question_text に入る(両モデル・legitimate)・選択肢の表再掲なし / 致命数値保持(3.5 に軽微字落ち「物価指数→物価数」)/ card・option 脱落なし。

**結論**: **prompt 差し替えが必須で確定**(現行 prompt の曖昧性が重複を許し、モデル世代 up では直らない)。**モデル移行(→3.5-lite)は重複を悪化させ、単価も高く、混入増・字落ちもあり移行理由が消滅** → **撤回**。3.1-flash-lite 維持。

**教訓(観測順序の価値・記録)**: ① commit A(モデル)と B(prompt)を同時に入れていたら、重複解消を見て「prompt が効いた」と誤結論し、モデルが悪化させ prompt が打ち消した可能性を切り分けられなかった。**変更源を 1 つずつ動かす原則**が反証を可能にした。② ②-0 sweep の残存データ(組合せ問題を含まない 3 画像)で「全モデル 0 件」を見て結論していたら逆の判断に着地していた。**「0 件 = 起きない」でなく「検証できていない(結論不能)」と報告し、適切なサンプルで再検証**したことが反証につながった。

## 3. 非目標(凍結)

- **cost.ts(モデル ID・単価)= gemini-3.1-flash-lite 維持**(移行しない・§2)。
- schema(`lib/ai/schemas/ocr-response.ts` / `lib/ai/ocr.ts` の zod)。
- OCR pipeline。
- **images 関連 prompt 記述**: `IMAGE_REFERENCE_RULES` 全体 + COMMON_EXTRACTION_RULES の line 228「図表参照は本文中にテキストで残す」/ line 233「画像は抽出しない」。**画像関連は全て ②-4 に集約**(§10)。

## 4. 変更 = COMMON_EXTRACTION_RULES の解答群記述差し替え(1 commit)

`lib/ai/prompts/ocr-extract.ts` の COMMON_EXTRACTION_RULES を差し替え。OT 指定の差し替え後ルール:

- `question_text`: 設問の問い、解答条件、症例文、資料文、穴埋め等を含む本文、および後続の選択肢から番号・記号で参照される前提記述を入れる(**ポジティブリスト定義**)。Markdown 可。
- `options[]`: 受験者が最終的に選ぶ選択肢(1〜5、ア〜オ 等の番号付き行)。
- 同じ内容を question_text と options[] の両方に入れない。
- 選択肢が表形式で並ぶ場合、その表は options[] として抽出し question_text に表として再掲しない。

**Codex Critical(P1)対処(2026-07-29)**: 当初案「question_text = 選ぶ選択肢以外のすべて」は正答キー / 解説 / メタデータも question_text に含めてしまい、専用 field(correct_answer_ids / explanation_text / options[].explanation / custom_props)と矛盾し**学習者に正答が露出**しうる(旧「リード文のみ」は narrow で安全だったのを broad 化して regression を導入)。OT 判断で question_text を「入れるものを列挙する**ポジティブリスト**」(問い/解答条件/症例文/資料文/穴埋め本文/参照される前提記述)へ変更。正答・解説・メタデータはリストに含まれず各専用 field へ = 露出せず既存 ANSWER_GROUNDING_RULES / EXPLANATION_USAGE_RULES と整合。

**line 223 も併せて置換**(承認済): 既存 line 223「question_text: … 通常は、解答選択肢を除いた *リード文のみ* を入れる」が新ルール「question_text = 前提記述/参考表を含む」と矛盾する(前提記述 a〜d は「リード文」でない)。「のように」を消してもこの矛盾が残ると狙い(prompt の曖昧性除去)が半減するため、line 223 の「リード文のみ」を撤去し新 question_text 定義に統一する。差し替え対象 = line 223-227。line 228/233(images)は不触。

**test**: prompt は content ゆえ直接の unit test を付けない(承認済・brittle 回避)。効果の検証は **Phase 2 の arm 比較**(§5)。**commit message にその旨を明記**(将来この commit を見た人が「なぜ test が無いか」= 効果検証は arm 比較であることを追える必要がある)。

## 5. Phase 構成

- **Phase 1(offline・実 API 不要・commit)**: prompt 差し替え(§4)。gate 全通過。canonical + Codex(prompt 差分 = 抽出挙動変更ゆえ review 対象)。
- **Phase 2(OT 実 API 合図・prompt 前後比較)**: 変更源が prompt 1 つゆえ「prompt 差し替えが効いたか」の純粋検証。比較は **gemini-3.1-flash-lite 固定で prompt の前後**。**今回の事前観測(§2)がそのまま before**(3.1-flash-lite・現行 prompt・組合せ問題サンプル)として使える。同一サンプル・同一モデルで after(新 prompt)を取り差分を見る。

## 6. 観測項目(Phase 2・主目的 = 解答群重複の解消)

- **解答群の重複が解消したか**(主目的): 組合せ問題(p-2 Card003/004)で before の完全重複(dupCount 5/4)が after で解消(dupCount 0)するか。
- 選択肢が表形式の問題で、同じ表が question_text にも Markdown 表として再掲されないか。
- 本文への `![…](…)` 混入の変化(描画側は ②-3 で除去済・ここは prompt 由来の出力頻度観測)。
- Markdown 表として出力される率の変化。
- 致命シグナル(数値/単位/否定)の劣化がないか(劣化 = 停止して OT)。

## 7. commit 構成と tag

**1 commit**(変更源 = prompt 1 つ・モデル移行撤回で分離消滅):
- prompt 差し替え: `feat(ai)` `[reviewed]`(canonical + Codex・prompt 差分 = 抽出挙動変更ゆえ review 対象)。commit message に「効果検証は Phase 2 arm 比較(unit test なし)」を明記。
- docs: `docs(...)` `[no-review]`。

## 8. 完了 gate(全 exit 0)

依存不変ゆえ install 系不要。whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit`。既存 flaky は当該 file 単体 PASS で切り分け。prompt は string 定数ゆえ既存 test(golden/mock)への影響は無い見込み(buildDiscoverPrompt を pin する test があれば更新)。

## 9. リスクと停止条件

- 停止(即 OT): Phase 1 で golden・typecheck・build fail(prompt 変更が parse/型に波及したシグナル)。Phase 2 で解答群重複が解消しない or 致命シグナル劣化。
- Codex plan cross-check は省略(OT 指定)。実装後 Codex 独立レビューは通常実施。

## 10. 持ち越し(②-4)= 設計事項(記録のみ・②-3.5 では実装しない)

②-4(図版切り出し)着手時に反映:

- **既存の prompt 画像 3 件**(②-2/②-3 spec から継承): IMAGE_REFERENCE 冒頭コメント「別冊切り出せない」= 同ページ図は誤 / COMMON「画像は抽出しない」/「プレースホルダ埋め込み」行削除。
- **A. box_2d は optional でなく nullable 必須**: `box_2d: [number,number,number,number] | null`。optional だと「座標確定不可」と「返し忘れ」が区別不能。null 明示で「確定できなければ null・推測して座標を作らない」を契約化(②-0「欠測を 0 に潰さない」と同型)。別冊参照(ページ内実体なし)は images[] に入れない方針ゆえ、実体ある図で座標が取れないケースは限定的。**`detection_status` 等の状態 field は追加しない**(null で表せる状態を 2 箇所に書くと矛盾する)。
- **B. images[] は要素ごとに safeParse**: 配列全体を一度に検証せず要素ごとに検証し壊れた要素だけ落とす(card 無傷で図が減る)。親 schema で `images: z.array(imageSchema)` にすると画像 1 件の破損で card 全体が失敗するため、**入力境界用と正規化後用で schema を分ける**。
- **C. 検証失敗の隔離範囲(原則・architecture.md §10 に記録済)**: 「検証失敗は影響を受ける最小の価値単位まで隔離する。後続処理の安全性を保証できない場合のみ親単位を失敗させる。除外・修復結果は必ず利用者に明示する」。適用: JSON 不読/cards 非配列/有効 card 0 = upload 失敗 / card の question_text・options 破損 = その card 除外(他保存)/ option 1 つ破損 = **card 全体除外**(選択肢欠落は問題の意味と正答確率を変えるため部分救済しない)/ image 破損 = その image 除外 / tag 破損 = その tag 除外。**型か内容かでなく依存関係とユーザー価値で決める**。
- **D. 除外件数のユーザー提示**: 「カード N 件作成 / M 件作成できず / K 件の図版取り込めず」。loud failure over silent zero-rows =「黙って落とすな」。**件数提示までを ②-4 範囲**とし、警告バッジ/除外一覧 UI/再試行導線は実害観測後に判断。
- **E. images の key field は残す**: key は UUID の場合 media_assets lookup / GC sweep / デッキ DL / 削除クリーンアップ / card_asset_refs 射影の主参照 id(fact-finding 確認済)。死んでいるのは OCR の placeholder key であって field ではない。②-4 で切り出し画像に UUID を入れれば placeholder は自然に消える。**field 維持**。
- **test 素材**(②-2/②-3 継承): mock-exam-page2 tracked + 実教材 non-commit。

## 11. spec 凍結

実装フェーズで書き換えない。§3 凍結対象に触れる必要が出たら停止して OT 相談。
