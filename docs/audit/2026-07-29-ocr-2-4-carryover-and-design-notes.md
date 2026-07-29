# ②-4(図版切り出し)持ち越し設計事項 統合記録

- 日付: 2026-07-29(②-2/②-3/②-3.5 を通じて蓄積した ②-4 設計事項の統合)
- 位置付け: **記録のみ。②-4 では改めて fact-finding → spec → plan で実装する**。本 doc は ②-4 着手時の出発点(抜け漏れ防止のチェックリスト)。
- 関連正本: spec §10(`2026-07-29-ocr-2-3-5-*`)/ architecture.md §10 / ledger(`todo-v47` §残件記録)。

## 0. ②-4 の核 = 検出条件の変更

- **検出条件を「本文の参照表現(別冊No.N / 図X / 下図)」から「ページ内の視覚領域(box_2d 座標)」へ変更**。②-0 で box_2d 座標取得を実証済(arm B)。②-2 arm B でも機能 go。
- **別冊参照(ページ内に実体が無い)は images[] に入れず、テキストのまま本文に残す**。切り出し対象は「ページ内に視覚領域として存在する図」に限定。
- **図の ASCII art 描画**(②-3.5 事前観測で 3.5-flash-lite に観測 = 図を question_text に ASCII で描こうとする)は、現行 prompt「画像は抽出しない」の副作用の可能性。検出方針を視覚領域化する ②-4 で解消見込み。

## 1. 表と図の切り分け

- **「Markdown 表で表現できるか否か」の単一二択**: 表として表現可能なもの = Markdown 表(既存 ②-3 の描画経路)。図として表現できないもの = box_2d 切り出し。判定軸を 1 つに絞り、モデルの類推余地を減らす(②-3.5 で「問題タイプ名条件付け」の失敗を学んだのと同型)。

## 2. box_2d / bbox

- **A. box_2d は optional でなく nullable 必須**: `box_2d: [number,number,number,number] | null`。optional だと「座標確定不可」と「返し忘れ」が区別不能。null 明示で「確定できなければ null・推測して座標を作らない」を契約化(②-0「欠測を 0 に潰さない」と同型)。**`detection_status` 等の状態 field は追加しない**(null で表せる状態を 2 箇所に書くと矛盾)。(spec §10-A)
- **bbox を捨てず保持(切り直しのため)**: 切り出した画像を通常 asset として保存するだけでなく、**元ページ上の座標・検出領域 ID を別途保持**する。座標が無いとパディングを調整して切り直せない(box2d 可視化目視で「矩形がぎりぎりで出所表記が切れる」等の後追い調整が不能になる)。
- **切り出し時のパディング**: 出所表記・軸ラベルが矩形ぎりぎりで切れる問題。座標保持(上記)により後からパディングを調整して切り直せるようにする。

## 3. target(紐付け先)

- **ambiguous(判定不能)を許容**: 図が question と option_1 の境界にある等、モデルに必ずどちらかを選ばせると silent error になる。**target 値域に「判定不能」を含めるか、候補を複数返せる形**にする。

## 4. 表示順

- **表示順はアプリが座標から計算する**(モデルに番号を振らせない)。切り出し図の並び順は box_2d 座標(ページ上の位置)からアプリ側で決定。モデル採番に依存しない(採番揺れ・重複を避ける)。

## 5. 検証 / 失敗の隔離

- **B. images[] は要素ごとに safeParse**: 配列全体を一度に検証せず要素ごとに検証し壊れた要素だけ落とす(card 無傷で図が減る)。親 schema で `images: z.array(imageSchema)` にすると画像 1 件の破損で card 全体が失敗するため、**入力境界用と正規化後用で schema を分ける**。(spec §10-B)
- **C. 検証失敗の隔離原則**(architecture.md §10 記録済): 「検証失敗は影響を受ける最小の価値単位まで隔離する。後続処理の安全性を保証できない場合のみ親単位を失敗させる。除外・修復結果は必ず利用者に明示する」。適用 = JSON 不読/cards 非配列/有効 card 0 → upload 失敗 / question_text・options 破損 → その card 除外 / option 1 つ破損 → **card 全体除外** / image 破損 → その image 除外 / tag 破損 → その tag 除外。型か内容かでなく依存関係とユーザー価値で決める。
- **D. 除外件数のユーザー提示**: 「カード N 件作成 / M 件作成できず / K 件の図版取り込めず」。loud failure over silent zero-rows =「黙って落とすな」。件数提示までを ②-4 範囲とし、警告バッジ/除外一覧 UI/再試行導線は実害観測後。(spec §10-D)

## 6. images の key field

- **E. images の key field は維持**: key は UUID の場合 media_assets lookup / GC sweep / デッキ DL / 削除クリーンアップ / card_asset_refs 射影の主参照 id(fact-finding 確認済)。死んでいるのは OCR の placeholder key であって field ではない。②-4 で切り出し画像に UUID を入れれば placeholder は自然に消える。**field 維持**。(spec §10-E)

## 7. 実装方式

- **client-side crop 方式**: 切り出しは client 側で行い、**server 側の image decoder / R2 PUT 新設を回避**する。box_2d 座標を元に client がページ画像から crop → 既存の client 画像添付経路(compressForAttach / attachImageToCard・UUID key)に載せる。server に新しい画像処理レイヤーを足さない(簡潔性規律)。

## 8. prompt 画像記述の整理(②-4 で一括)

②-4 が prompt を触る際にまとめて処理(同一箇所ゆえ最安・②-3 では描画側単一点で完結ゆえ prompt を触らなかった):

1. `IMAGE_REFERENCE_RULES` 冒頭コメント「画像本体の中身解釈はしない(AI は別冊画像を切り出せない)」: 別冊は今も正しいが**同一ページ内の図は誤り**(box_2d 座標取得を ②-0 で実証)→ 書き換え。
2. `COMMON_EXTRACTION_RULES`「画像は抽出しない」: ②-4 の方針変更そのもの。放置すると「図を検出し座標を返せ」と矛盾同居。
3. 「プレースホルダ埋め込みについて」行の削除(実測根拠なき消極的打ち消し・lite に非効)。

## 9. test 素材

- **擬似問題 2 枚 tracked**: mock-exam-page2(問1=文+解説2図 / 問2=選択肢1-4別図 / 問3=別冊参照のみ・ページ内図なし)を `tests/fixtures/ocr/` へ。既存実教材が「問題文の図」中心で選択肢ごとの図の target 判定が未検証な穴を埋める。
- **実教材(看護師国家試験等)non-commit**: `scripts/ai/ocr-samples/`(gitignore)に置き比較 run でのみ使用。

## 出典(この doc の各項の由来)

- box_2d nullable(A)/ safeParse(B)/ 隔離(C)/ 件数提示(D)/ key 維持(E)= ②-3.5 kickoff §ADD → spec §10 / architecture.md §10。
- bbox 保持・ambiguous target = ②-3 Phase2 kickoff。
- 検出視覚領域化 / 表図切り分け / パディング / 表示順 / ASCII art / client-side crop / 別冊テキスト残す = ②-3.5 Phase2 kickoff(OT の統合リスト)。
- prompt 3 件 = ②-2/②-3 spec 継承。
