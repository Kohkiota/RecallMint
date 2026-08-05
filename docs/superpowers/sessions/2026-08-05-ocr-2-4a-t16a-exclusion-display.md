# ②-4a T16-a: 除外理由の提示(2026-08-05)

fact-finding = `docs/audit/2026-08-05-ocr-2-4a-t16-factfinding.md`(`411bfcb`)。
実装 = `5ca2d32` **feat [reviewed]** / Codex raw = `docs/codex/2026-08-05-t16a-exclusion-display.md`(`d9796b6`)。

> **復元について**: 本 doc は **SDD workspace(`.superpowers/sdd/`)を全削除した後に**書いている。
> T16-a の ledger・implementer report・canonical review / re-review の各 file は**既に存在しない**。
> 以下は commit message / 実コードとコメント / Codex raw / 作業時の記憶から復元したもので、
> 復元できなかったものは §7 に「復元不能」として明示する。**推測で埋めていない。**

---

## 1. 何をしたか

result page が `✅ N 問を抽出しました` しか出さず、`upload_operations.result_summary` に
**既にある**除外情報を 1 つも読んでいなかった(spec §13「loud failure over silent zero」の未達
= **11 問取れたときと 0 問のときが同じ見た目**)。既にある summary を読んで出すだけで解消した。

producer(`lib/ocr/prepared-schema.ts` / `lib/ocr/normalize-prepared.ts` / `buildResultSummary`)は無変更。

### 実装要点

- **op の選び方**(`lib/exams/list.ts` `getLatestCompletedUploadSummary`)
  ```
  WHERE user_id = ? AND source_document_id = ? AND status = 'completed'
  ORDER BY completed_at DESC, id DESC LIMIT 1
  ```
  「作成が最新の op」ではない。1 doc に複数 op が並ぶのは replay か supersede で、
  **supersede された op は terminal になる**。terminal を拾うと「0 問」と誤誘導する。
  `id DESC` の tie-break は同値時の決定性のため。`completed_at` は `publish-prepared.ts` の
  finalize が `resultSummary` と**同一 UPDATE** で書くため completed op では常に non-null
  (git 全履歴で唯一の writer であることを review が確認)。
  PG の `DESC` は **NULLS FIRST** なので、仮に NULL が現れれば「負ける」のではなく**勝つ** —
  到達不能だが、コメントに向きを明記した(当初コメントは逆に書いていた)。
- **`result_summary` は `jsonb`** で TS 型は `Record<string, unknown>` = 何も保証しない。
  narrow な zod で `safeParse` し、**通らなければ「表示しない」に倒す**(throw せず result page を落とさない)。
- **3 束への畳み込みは pure 関数**(`_lib/result-summary-view.ts`)に切り出して unit で pin。
  理由コード(`crop_failed` 等)は画面に出さない。

### 表示(確定仕様)

描画順は **card が先**、図版が後(付随情報のため):

```
{M} 問中 {N} 問を取り込みました。      ← cardsExcluded > 0 のときだけ
図版 {K} 件を取り込みました。            ← figuresAttached > 0 のときだけ
{N} 件の図版は取り込めませんでした。      ← 失敗束 > 0 のときだけ
{N} 件の図版は上限のため省略しました。    ← 打ち切り束 > 0 のときだけ
```

各行は独立に自分の件数で gate する。4 つすべて 0 なら pure が `null` を返しブロックごと出さない。
帰結として **`figuresAttached = 0` でも除外があればその行は出る**(黙って消えない)。
文言定数は**常に独立した 1 文**として使い、述語として文中に連結しない(I-3(b) の規律)。

### なぜ「上限のため」に 2 つの理由を畳んだか

`image_limit_exceeded`(1 card あたりの枚数上限)と `deadline_excluded`(crop の時間予算切れ)は
**原因は違うがユーザーの取れる行動が同じ**(枚数を減らす)ため 1 束にした。意図的な畳み込みであり、
束を分けても行動が変わらない以上、行が増えるぶん読まれなくなる方が損。

---

## 2. 必須 A: red 実証のやり方が間違っていた(本 sprint 7 例目・**新種**)

**指摘**: `page.tsx` の図版 3 行の `> 0` gate に**検出力がゼロ**だった。各 gate を**個別に** `true` へ
変異させても page test は **10/10 green** のまま。pin されていたのは `cardsExcluded > 0` だけ。

**なぜ見逃したか**: 実装者の red 実証が **4 つの gate をまとめて消して「1 failed」を見て、
pin されたと読んだ**。1 つ落ちたのは `cardsExcluded` の分であり、残り 3 つが守られている証明には
なっていなかった。

**出荷されうる形(具体)**: `figuresCapped > 0` の gate を失うと、**crop が 1 件失敗しただけの
平凡な upload で「0 件の図版は上限のため省略しました。」が表示され、何も赤くならない**。

**なぜ新種か**: 本 sprint の「緑は守られていることを意味しない」は今回で 7 例目だが、これまでの 6 例は
- test が無かった(S-3 の crop throw 台帳記録)
- 別のものを見ていた(S-4 の生存ガード = 文 1 の NOT EXISTS が先に守るため文 2 に到達しない)
のいずれかだった。今回は **test はあり対象も正しいのに、red の当て方が間違っていた**。
壊し方が粗いと、細かい gate は壊れていないのに壊れたことにされる。

**教訓**:
> **gate は個別に変異させる。まとめて壊して 1 つ落ちても、他が pin されている証明にならない。**

対処後は 4 gate それぞれを 1 つずつ変異させ **4/4 それぞれ 1 failed** を確認した。

---

## 3. 必須 B: zod の挙動(T16-b に直接効く)

**当初の申し送りは逆だった**。「読み手 schema は 7 キー必須なので、producer にだけ理由キーを足すと
parse が落ちて表示が丸ごと消える(silent)」と書いていたが、**zod 4.4.1 の `z.object` は
未知キーを strip して parse は成功する**(repo 実物の zod で実測)。

したがって T16-b で producer だけ先に足した場合の実際の失敗は:

> 表示が消えるのではなく、**その理由がどの束にも入らず静かに過少計上される**。

**もっともらしいが誤った数字は、何も出ないより悪い。** 誰も異常に気付かない。

**採った対処 = drift pin(機械強制)**。producer の**実物 3 起点**(`figureExclusionTalliesSchema.shape` /
`planPublish()` の実返り値 / `buildResultSummary()` の実出力)からキー集合を取り、読み手が各キーを
**ちょうど 1 つの束**に入れることを assert する test を置いた(値を書き写した二重定義にすると
drift を検出できず pin として無意味になるため、実物起点であることが要件)。

**不採用にした案 = `figuresExcluded` を `.strict()` にして未知キーで parse fail させる**。
runtime で表示ブロックごと消えるだけで、ユーザーから見れば「数が違う」が「何も出ない」に
変わるだけであり**同じく silent**。CI で赤くする方が強い。

申し送りに頼る担保は本 sprint で 3 回破れている(S-2 M-6 / S-3 の fence 誤分類 / S-4 の生存ガード)。

---

## 4. 必須 C: 「RLS 下で owner-scope は pin 不能」は実 PG で反証された

当初 report は「`upload_operations` は RLS-on ゆえ `WHERE user_id` の有無を区別できず空振り test に
なる」と書いていた。**誤り**。review が実 PG で実証:

- GUC = tenant A・`userId` 引数 = tenant B で A の doc を引くと、**述語ありは `<null>`**
- **述語を落とした変異は `{"marker": "A"}` を返す**(= 他テナントの行が漏れる)

コード自体は正しかった(述語は最初から入っていた)。問題は「**owner-scope は test 不能**」という
誤った先例が記録に残ることで、それは CLAUDE.md の `WHERE user_id = ?` 規律を**他所で緩める根拠**に
使われうる。iso を 1 本足して閉じた。

---

## 5. 規律逸脱の申告(fix round 3)

fix round 3(コメント 1 行 + test scaffolding の移動)に対し、**3 度目の canonical scoped re-review を
立てず、Codex を当該ラウンドの独立レビューとした**。

- **判断根拠**: 変更が test file 1 本のコメントと実行位置の移動のみで production code を含まず、
  Codex が未 commit diff 全体を独立レビューしている(Critical 0 / Important 0 / Minor 0)。
  CLAUDE.md が必須とする経路(canonical + Codex)は満たしている。
- **省いたのは skill 側のループ機構**であって repo の review 必須要件ではない。
- **残るリスク**: S-5 session doc §8.3 と同じ — 「1 行だから」を理由に省く判断は積み重なると
  形骸化する。同種の省略はこの節に記録し、頻度が上がったら規律側を見直す。

同型の省略は S-5fix でも 1 回行っている(`docs/superpowers/sessions/2026-08-05-ocr-2-4a-s5-legacy-path-removal.md` §8.3)。
**本 sprint で 2 回目**。

---

## 6. T16-b への申し送り

- **`orientation_unsupported` は「取り込めませんでした」束に入れる(OT 決定)。**
  理由 = 「上限のため」は嘘になる。こちらが上限を決めて打ち切ったのではなく、**扱えなかった**から。
  回転が入力側の性質なのは事実だが、ユーザーから見れば「上げた画像が使われなかった」であり、
  原因の帰属より**扱えなかったことが伝わるべき**。仕様上の打ち切りと混ぜると除外の意味が薄まる。
- **producer と読み手は同 commit で更新する。** §3 の drift pin が CI で赤くするので忘れようがないが、
  束の帰属(上記)を決めないと実装できない — それは上で決まった。
- 判定箇所は `verifyImageBytes`(`_lib/source-image-verify.ts`)の `metadata()` 直後 = **OCR 送信前**
  (追加 I/O ゼロ・1 invocation 経路の全画像が必ず通る)。判定は **source 単位**(EXIF は 1 画像 1 つ、
  figure は部分領域なので figure 単位はありえない)。詳細は fact-finding doc §5。
- **本命は `logger.warn`**(PII-free・operationId + orientation 値のみ)。`source_assets.rotation` 列が
  0032 で消えた今、前提破綻の唯一の通知手段。

---

## 7. 復元不能(SDD workspace 削除により失われたもの)

以下は本 doc 執筆時点で**現物が存在せず、内容を正確には復元できない**:

- **canonical review 本文**(`t16a-canonical-review.md`)— 指摘の要旨は §2〜§4 に残したが、
  reviewer が挙げた**行番号付きの検証手順と、Minor 3 件の詳細**は復元不能。
- **scoped re-review 本文**(`t16a-re-review.md`)— 各 finding の ADDRESSED 判定根拠、および
  新規 Minor 2 件(test file のコメント矛盾 / collection 時 throw)の詳細は復元不能。
  ※ 2 件とも fix round 3 で解消済みであることは commit と現コードから確認できる。
- **implementer report**(`task-T16a-report.md`)— red 実証の**実 output(落ちた test 名と行番号)**は
  復元不能。「4 gate それぞれ 1 failed」「drift pin の RED A / RED B」という結果の要旨のみ残る。
- **ledger**(`progress.md` の T16-a 節)— fix round ごとの経過。要旨は本 doc に吸収済。

**教訓**: 「完了時に session doc を書くから移送しない」と決めた対象は、**session doc を書く前に
scratch を消すと失われる**。順序は「session doc を書く → 消す」でなければならなかった。
