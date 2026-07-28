# Codex plan cross-check — ocr-regression-foundation (2026-07-28)

- **作成日**: 2026-07-28
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **[P1] SDK 内部 retry を含めて「retry 禁止」を保証する必要がある。**  
  ラッパー側で retry loop を書かないだけでは不十分。SDK 自身が 429/5xx を再試行する場合、要件違反になる。SDK 1.50.1 の retry 設定・既定値を確認し、無効化できないなら「1回の `generateContent` が内部で複数HTTP要求になり得る」ことを制約として明記すべき。複数モデル実行も逐次または中断可能なスケジューリングにし、429 検出後に未開始呼び出しを確実に止める必要がある。

- **[P1] 応答完了性を観測しないと、末尾欠落を正しく判定できない。**  
  `text` と token 数だけでは、正常完了・出力上限到達・安全停止などを区別できない。少なくとも `finishReason`、可能なら候補単位の終了情報やエラー分類を記録しないと、「選択肢末尾欠落」やカード途中終了を通常のモデル差として誤判定する。

- **[P1] 比較対象の対応付け規則が必要。**  
  カード配列の同じ index 同士を比較すると、1カードの欠落・挿入で以降すべてが差分になる。`sort_key`、`title`、問題文類似度等による対応付け方針と、重複・空・変更されたキーの扱いが必要。選択肢も index と `id` のどちらで照合するかを決める必要がある。

- **[P1] arm B と box 可視化の target 語彙を明確に分離すべき。**  
  要件(c)は `question_text` / `option:<id>` を要求する一方、現行 OCR は `question` / `option_{id}` / `explanation`。これは単なる表記差ではなく、後続 ②-4 の mapping 境界である。探索出力の語彙、可視化ラベルの語彙、現行 `images[]` の語彙を混同せず、今 sprint では保存側へ射影しないことを明記すべき。

- **[P1] golden の「0件 RED」を実際に検証する必要がある。**  
  `files.length > 0` を書くだけでなく、一時的な空 fixture directory または fixture root 注入により、0件時に本当に fail することを確認すべき。expected の一部改変による RED は別の保証であり、0件検出の実証にはならない。

- **[P1] golden fixture の生成元と期待値の独立性に限界がある。**  
  capture と golden が同じ `parseOcrResponse` を使うため、capture 時点の parser 誤りを正解として固定する。これは将来の parser drift 検出には有効だが、抽出内容の妥当性を保証しない。初回 expected は OT が目視承認したものか、少なくとも「自動生成・未校正」であることを provenance に残す必要がある。

- **[P1] 表直下空行は集計値だけでは検出力が不足する。**  
  「各本文フィールド」には少なくとも `question_text`、各 `options[].text`、各 `options[].explanation`、`explanation_text` が含まれる。カード・field path・表番号ごとに結果を出さないと、aggregate の件数に異常が埋もれる。表が末尾にある場合、連続表、空白だけの行、CRLF、blockquote 内の shared context 表についても判定定義が必要。

- **[P1] `segmentMdTables` 再利用には検出範囲上の制約がある。**  
  現物の helper は root 直下の表だけを対象とし、blockquote/list 内の表を意図的に除外する。shared context は Markdown 引用ブロックになるため、その中の表が評価対象なら現在の helper だけでは検出できない。既存 helper の意味を変えず、今回何を「表」と数えるか決定が必要。

- **[P1] usage 欠落を `0` に潰すとコスト比較を誤る。**  
  `promptTokenCount`、`candidatesTokenCount`、`thoughtsTokenCount` が未提供の場合は「0トークン」ではなく「計測不能」。nullable/availability を保持し、コストと現行比も `N/A` にすべき。baseline が失敗・0・usage欠落の場合の比率も定義が必要。

- **[P2] 「実コスト」は請求額ではなく usage ベース推定値。**  
  表示名を `estimatedUsd` 等にし、標準 tier、cached token、長文閾値等を考慮していない場合は明示する必要がある。少なくとも計算に使った単価表・input/candidates/thoughts・式を JSON に残し、丸め前値で比較すべき。

- **[P2] 致命的差分の語彙抽出だけを主判定にしてはいけない。**  
  日本語の否定、全角数字、指数・小数・範囲、μ/µ、±、上付き、Unicode 記号は単純 regex で取りこぼす。field-level の原文 diff を正本とし、否定語・数値・単位・記号抽出は強調表示に限定するのが安全。

- **[P2] 2.5-flash 不応答を通常エラーと区別して記録すべき。**  
  HTTP status、モデル不存在、権限、429、timeout、parse/validation failure、empty text を別カテゴリで結果化する必要がある。ただし429だけは結果保存後、全実行を即停止する。

- **[P2] arm B schema の合成方法に drift リスクがある。**  
  本番 schema を手書き複製すると直ちに二重管理になる。本番 schema の deep clone に探索フィールドだけを追加する等、本番 schema を正本として構成すべき。また structured-output 対応 subset の範囲、tuple長、座標 min/max、target pattern が当該SDK/APIで受理されるかも実走前に確認が必要。

- **[P2] box の幾何学的異常を隠さない設計が必要。**  
  4要素でない、非数、範囲外、`min > max`、ゼロ面積をどう扱うかを決めるべき。表示時に clamp や並べ替えをするとモデルの異常を隠すため、raw 値は必ず保存し、invalid として目立たせる方が回帰検出向き。

- **[P2] overlay の座標系と画像表示領域を一致させる必要がある。**  
  overlay container を画像の実表示サイズに厳密に合わせる必要がある。EXIF orientation、CSSの余白、`object-fit`、ブラウザ縮小時の挙動を確認すべき。元寸法が不要な%表示でも、画像の向きがブラウザ解釈とAPI入力で一致しない場合はずれる。

- **[P2] HTML 出力の escaping が必要。**  
  `target`、`label`、モデル由来テキストを未escapeで埋めると、ローカルHTMLでも任意 markup/script が実行され得る。属性値と本文をescapeし、未知 target も安全に表示する必要がある。

- **[P2] 比較結果の再現情報が必要。**  
  モデルID、SDK版、実行日時、arm、prompt/schema hash、画像hash、timeout、usage、生 response、parse成否、エラー分類を保存しないと、後から何を比較した結果か確定できない。モデル alias を使わない点も結果に残すべき。

- **[P2] fixture pair の完全性と名前衝突を扱う必要がある。**  
  response だけ書けた半端な状態、既存fixtureの無言上書き、`--name` の path traversalを防ぐ必要がある。少なくとも safe name、既存時fail、pair単位の一時書込→renameが望ましい。

- **[P2] commit対象の情報管理確認が必要。**  
  画像を除外しても、Gemini response には教材本文、個人情報、著作物が含まれ得る。fixture commit 可否をOTが確認する gate、fixture内容のレビュー、秘密情報チェックが必要。

- **[P2] 実API実行の gate は手順だけでなく境界を明示すべき。**  
  CLIを起動すること自体を「OT合図」とみなすのか、CCだけが起動できる運用なのか、要件中の「OTが(b)(c)実行」と「OT合図でCCが実行」の関係が曖昧。責任者と証跡を一本化する必要がある。

- **[P3] SDK型契約は“存在”と“完全一致”を分けるべき。**  
  `text` が厳密に `string | undefined` であることを要求すると、互換的な型の狭まりでも不要にfailする。一方、単なる `satisfies` はmethod引数との接続方法次第で検出力が弱い。実際の `generateContent` 引数型から config を導出し、使用フィールドの存在・代入可能性を検証すべき。

- **[P3] typecheck は runtime semantics を保証しない。**  
  deprecated field が型上残る、値の意味が変わる、常にundefinedになる変更は検出できない。薄い型アサートの保証範囲を明文化し、golden/比較実走との役割を分けるべき。

- **[P3] MIME 判定を拡張子だけに依存する場合の扱いが必要。**  
  対応拡張子の allowlist、大小文字、`.jpg`/`.jpeg`、未知拡張子、画像以外の混入を明確にし、directory列挙順も決定論的にする必要がある。

- **[P3] golden は成功 fixture だけでは parser 境界を十分に覆わない。**  
  実応答goldenとは別に、invalid JSON、required欠落、型違い、unknown key strip、optional field、cards空配列などの単体契約が既存testで覆われているか確認が必要。ただし追加は必要最小限でよい。

- **[P3] 本番挙動不変の確認は既存test greenだけでは完全ではない。**  
  rename/exportは機械的変更だが、export前後で同一入力に同一結果・同一error messageになることを直接確認できると、goldenの前提が明確になる。

- **[P4] P0相当の即時データ破壊・本番変更リスクは、提示範囲では見当たらない。**  
  ただしAPIの自動retryとfixtureの情報持ち出しは、実装前に解消すべきP1/P2事項。

## plan ドラフトへの抜け・未考慮指摘

- **[P1] Task 3 はSDK内部retryを扱っていない。**  
  「429 即throw・retryなし」はwrapper実装だけに見える。SDK内部のretry無効化確認と、モデル比較全体を即停止する制御がTask化されていない。

- **[P1] Task 3 の戻り値に終了理由・raw usage availability・エラー分類がない。**  
  `text` と数値5項目だけでは、出力上限による末尾欠落を判定できない。欠落usageをnumber `0`に正規化するinterfaceも不適切。

- **[P1] Task 3 の arm B target が要件(c)と衝突している。**  
  planは `question` / `option_{id}` / `explanation` を採用しているが、可視化要件は `question_text` / `option:<id>`。Task 3/7で語彙と用途を分離し、②-4のmappingを実装しないことを明記すべき。

- **[P1] Task 6 にカード・選択肢のalignment設計がない。**  
  `buildComparisonReport(results)` の前提となる対応付けが未定義。配列index比較では欠落時に差分が崩壊する。

- **[P1] Task 6 は終了理由を見ないため「末尾欠落」を誤診し得る。**  
  選択肢個数・末尾IDだけでは、モデルの意味的差とtoken上限終了を分離できない。

- **[P1] Task 9 の red 検証は0件REDを検証していない。**  
  expected改変はmismatch検出の確認にすぎない。fixture列挙を0件にした検証を別途入れる必要がある。

- **[P1] Task 4/6 の blank-line 出力粒度が不足している。**  
  `{tables, withBlankLineBelow}` ではどのcard・field・tableが違反したか分からない。「埋もれさせない」要件に反する。少なくともfield path付き詳細が必要。

- **[P1] `segmentMdTables` のroot-only制約が未考慮。**  
  planは再利用を全面的前提にしているが、shared-context引用内の表を検出しない。評価対象外とするか、別の観測方法を設計する必要がある。

- **[P2] Task 3 の arm B schema は「本番 card schema」の取得方法が曖昧。**  
  手書き複製なら本番schema driftを生む。本番builderの結果を正本として非破壊合成する旨が必要。

- **[P2] Task 4 の cost interface が欠測を表現できない。**  
  token fieldが必須numberなので、APIがusageを返さない場合に0へ潰す構造になる。各tokenをnullableにするか、計測可能性を別途持たせるべき。

- **[P2] Task 4 の「現行比」境界条件がない。**  
  baseline不応答、unknown price、usage欠落、cost 0の場合の表示規則が未定義。

- **[P2] Task 6 の致命的差分抽出が過度にheuristic。**  
  negations/numbers/units/symbolsの定義、Unicode正規化、対象fieldが未記載。原文field diffを正本にする記述もない。

- **[P2] Task 6 の出力にprovenanceが不足。**  
  prompt/schema/image hash、SDK版、実行日時、終了理由、raw response、エラー種別が成果物interfaceにない。後続sprintとの比較証跡として弱い。

- **[P2] Task 6 の429時制御が曖昧。**  
  「モデル/arm毎try/catch」と「429即停止」が競合する。429だけはcatchして結果保存後、外側run全体をthrow/abortする構造を明記すべき。

- **[P2] Task 7 はinvalid boxの扱いとraw座標表示がない。**  
  `boxToPercent` は不正座標もそのまま負幅等にできる。validation、異常の可視化、raw値併記が必要。

- **[P2] Task 7 はHTML escapingと画像orientationを考慮していない。**  
  model由来labelのescape、container/imageの寸法一致、EXIF orientationの確認がtest観点にない。

- **[P2] Task 5 は安全なfixture書込が不足。**  
  name validation、既存ファイル上書き拒否、pairのatomicity、途中失敗時cleanupがない。

- **[P2] Task 5/9 はfixtureの人手承認・情報管理gateがない。**  
  parse出力をそのままexpectedとしてcommitするだけで、誤抽出や秘匿・著作権情報を固定する可能性がある。

- **[P2] Task 9 だけがOT gateになっており、(b)(c)の実走完了条件がない。**  
  Sprint成果を機構完成までとするのか、比較・可視化の初回実走までとするのかが不明。要件上OTが(b)(c)を実行・判定するため、そのhandoffまたは実走証跡を完了条件に含めるべき。

- **[P3] Task 2 の config型アサートは実method型との接続が弱い可能性がある。**  
  `satisfies`対象を手書き型にせず、`generateContent` の実引数型から導出する必要がある。また厳密型一致とfield存続検出を混同しない方がよい。

- **[P3] Task 2 の契約範囲にraw scriptが読む実フィールドが反映されていない。**  
  比較で終了理由等を追加するなら、それらも「実際に読むfield」として型契約対象に含めるべき。

- **[P3] Task 3 の timeout testがtimer解放まで保証していない。**  
  正常・throw・abortの全経路でtimerが残らないこと、abort後の遅延成功が採用されないことを確認したい。

- **[P3] Task 3 の画像loaderに対応形式と決定論的列挙がない。**  
  未知拡張子を推測して送信せずloud failureにすること、ファイル順をsortすることが必要。

- **[P3] Task 8 のignoreが広すぎる可能性がある。**  
  `scripts/ai/ocr-samples/` 全体をignoreすると、将来置くREADMEや非機密テンプレートも追跡不能になる。input/outputのみを限定ignoreする案と比較すべき。

- **[P3] Task 9 のfixture命名対応が拡張子規約頼み。**  
  orphan response、orphan expected、重複basenameを明示的にfailさせる検査が必要。

- **[P3] Self-Reviewの「gapなし」は根拠として弱い。**  
  spec sectionとTaskの対応があることは、異常系・意味的境界・実走運用が網羅されていることを示さない。特にretry、finish reason、alignment、target語彙、0件RED実証が抜けている。

## リスク / 対立しうる設計判断

- **goldenの忠実性 vs fixtureの安定性**  
  SDK response envelope全体を録画すればSDK driftへの観測力は上がるが、変動metadataでfixtureが不安定になる。parse用raw textと、provenance/usage/finish reasonのmetadataを分離保存する案が妥当。

- **自動生成expected vs 人手校正expected**  
  自動生成はcaptureの再現性を検証し、人手校正はOCR正確性を検証する。②-0の主目的がparse回帰なら自動生成でもよいが、「OCR品質golden」と誤称しないことが重要。

- **逐次実行 vs 実行時間短縮**  
  並列化は速いが429即停止時に既発行要求を止めにくく、コスト制御も弱い。本要件では逐次実行が安全側。

- **厳格schema vs モデル間互換性**  
  box tupleやtargetを厳格にすると異常をAPI側で拒否できる一方、新モデルのstructured-output subset差で比較不能になり得る。schemaは最小限にし、runtime validationで異常を結果化する選択肢がある。

- **不正boxを補正表示 vs 異常として露出**  
  clamp・min/max入替は見やすいが回帰を隠す。rawを正本としてinvalid表示し、補正版を併記するなら明示的に区別すべき。

- **既存Markdown helper再利用 vs 評価範囲の完全性**  
  既存helperの再利用はYAGNIに沿うが、root表限定という意味を引き継ぐ。blockquote表まで要件対象なら、再利用強制と検出完全性が対立する。

- **未知usageを0扱い vs N/A扱い**  
  0扱いは処理が簡単だが、コスト優位を偽装する。比較・go/no-go用途ではN/Aが適切。

- **型の厳密一致 vs 互換変更への耐性**  
  厳密一致は変更検出力が高い一方、無害な型狭まりでも止まる。必要fieldの存在とcall-site代入可能性を契約にする方が目的に合う。

- **fixtureの網羅性 vs commit量・情報管理**  
  3–5枚すべてをgolden化すれば検出力は上がるが、教材内容のcommit量も増える。比較用画像数とcommitするgolden数は分けてもよい。

- **社会的OT gate vs CLIによる機械的gate**  
  runbookだけなら簡素だが誤実行を防げない。確認flagやdry-run defaultは安全性を上げる一方、OT合図そのものをコードで認証できるわけではない。責任境界と実行ログの方が重要。

総括すると、最優先で補うべきなのは **SDK内部を含むretry禁止、終了理由の記録、比較alignment、target語彙の分離、0件fixture REDの実証、usage欠測のN/A化** です。これらが未解決のままだと、機構は動いても②-1/②-2のgo/no-go判断で誤った比較結果を出す可能性があります。