# ②-4a クローズ stg smoke(2026-08-06)

whole-branch review の fix(I-1 PDF copy / I-2 architecture §6 / I-3 spec header)+ 台帳更新を push した後の
最終 smoke。②-4a はこの smoke で完了し、次は prod 反映判断。

対象: `origin/develop` = local HEAD = **`eee7661`**(ahead 0 / behind 0)/ deploy = **`dpl_9QpaTs1A7ZXg1GBUMYQzPG44pE2S`**
実施 = CC(Playwright MCP + app-role psql read-only)。**検証のみ・変更/commit なし**(本 doc を除く)。

**総合判定 = 全項目 PASS。** ただし新発見 3 件(§4〜§6)があり、うち 1 件(preview の strip 未適用)は follow-up 起票。

---

## §0 pre-flight

### push 同期

```
local  = eee76616be5c9444a7fab51aeb2183b639f8fb56
origin = eee76616be5c9444a7fab51aeb2183b639f8fb56
ahead=0 behind=0
```

### deploy 同一性

deploy id は chunk の query string から取得: **`dpl_9QpaTs1A7ZXg1GBUMYQzPG44pE2S`**

```
chunks/0-sb4ggyc6bca.js?dpl=dpl_9QpaTs1A7ZXg1GBUMYQzPG44pE2S
chunks/05rgkrronxjsc.js?dpl=dpl_9QpaTs1A7ZXg1GBUMYQzPG44pE2S
chunks/0cz1d0mv5g_q7.js?dpl=dpl_9QpaTs1A7ZXg1GBUMYQzPG44pE2S
```

**dpl ↔ git SHA の対応表は Vercel Dashboard(= OT)でしか引けない。** CC 側で言える等価性は次の 2 段:

1. 最終 **code** commit は `551f514`。`551f514..HEAD` の diff は docs 2 file(`docs/codex/…` / `docs/superpowers/sessions/…`)のみ
   → **deploy 出力として HEAD と `551f514` は同一**。
2. その `551f514` が入れた marker(`PDF は現在未対応です` / `accept="image/*"`)が deploy 上に実在(§1)。

→ 「deploy = HEAD 相当」は CC 側の証拠で成立。dpl↔SHA の直接照合のみ OT。

### `/app/upload` の maxDuration 720s

**未実施(Vercel Functions タブ = Dashboard 権限 = OT)。** CC 側の担保:

- `app/(app)/app/upload/page.tsx:23` = `export const maxDuration = 720`(literal)
- drift pin test(行の消失でも fail)が gate green
- S-4 着手前提として **OT が Dashboard で実効 720s を確認済**(`docs/superpowers/sessions/2026-08-05-ocr-2-4a-s4-preconditions.md`)

### 旧経路への bare 参照(build chunk 22 本 全走査)

`document.querySelectorAll('script[src]')` + `link[href*=/_next/static/]` から 22 chunk を列挙し、
各本文を fetch して文字列一致(scanned=22 / fetch 失敗 0):

```json
{
 "reserveSource": 0, "finalizeSource": 0, "stagePrepared": 0,
 "claimOperation": 0, "publishPreparedUpload": 0,
 "prepareUpload": 0, "abandonUploadOperation": 0,
 "sourceAssets": 0, "source_assets": 0,

 "beforeunload": 0,
 "PDF はそのまま投入されます": 0, "画像や PDF": 0,

 "PDF は現在未対応です": 1, "完了すると試験一覧に反映されます": 1, "処理が中断された可能性があります": 1
}
```

---

## §1 I-1(PDF copy の cross-task seam)— **PASS**

whole-branch review I-1 = 「UI が PDF 対応を約束する一方、submit は hard-reject する」矛盾の解消確認。

- header: **「試験問題の画像を選択すると、 AI が問題を抽出します。 抽出結果は次の画面で確認 / 保存できます。」**(「や PDF」消滅)
- 画面内の PDF 言及は **1 箇所のみ**:
  **「画像 (JPG / PNG / HEIC 等) は自動で圧縮されます。 PDF は現在未対応です。合計 40 枚・サイズ上限 4 MB まで。」**
- `input[type=file]` の `accept` 属性(DOM 実測)= **`image/*`** → ファイル選択ダイアログに PDF が出ない

submit 時の hard-reject は backstop として残置(`accept` は advisory ゆえ「すべてのファイル」で回避可能)。
本 smoke では PDF を投入していない(reject 経路は cutover smoke §C で検証済)。

---

## §2 通常経路

### upload 実行の一覧(本 smoke の全 run)

| # | submit (UTC) | doc | exam | 結果 | 備考 |
|---|---|---|---|---|---|
| 1 | 00:08:54 | `8f44209d` | `6de7e9d3` | 11 問 / 図版 10 | auto-nav 確認。**証跡として残置** |
| 2 | 00:11:25 | `33382551` | `a9eb2c0b` | 11 問 | completed 00:11:39 |
| 3 | 00:12:17 | `5632c151` | `d97b33fa` | 11 問 | close 00:12:33.5 / completed 00:12:35(**判定不能** — §3) |
| 4 | 00:14:10 | `5300ae78` | `fad4caa5` | 11 問 / 図版 10 | close 00:14:19.3 → completed 00:14:28 |
| 5 | 00:15:43 | `4c691b9a` | `2fb94076` | **捏造 1 問**(無地画像)| §5 |
| 6 | 00:39:17 | `dbe19776` | `033e1cc2` | 11 問 / 図版 10 | close が完了後になり判定不能 |
| 7 | 00:40:54 | `7b75f662` | `92803817` | 11 問 / 図版 5 | **タブ閉じの厳密証明** — §3 |

入力は全 run 共通で `scripts/ai/ocr-samples/mock-exam-set-p-{1..5}.png`(5 枚・元 1.33MB → client 圧縮 **523.5 KB**)。
run 5 のみ無地 PNG 1 枚。

### run 1 の内訳(result_summary 生値)

```
op: completed / last_error_code 空 / prepared_payload NULL
doc: completed / pages_processed 5
cards 11 / card_asset_refs 10

result_summary:
  cardsExtracted   11
  cardsExcluded     0
  figuresAttached  10
  figuresExcluded  {"malformed":0,"crop_failed":0,"coordinate_null":0,"asset_id_invalid":0,
                    "deadline_excluded":0,"source_id_invalid":0,"image_limit_exceeded":0,
                    "orientation_unsupported":0}
```

`orientation_unsupported` が producer 側の key として実在(T16-b 整合)。

### 図版の実描画(exam 詳細・run 6 の exam)

```
img[0] blob: 807x548 complete
img[1] blob: 705x486 complete
img[2] blob: 454x550 complete

presigned GET key(R2 リクエスト 3 本):
  users/85541b25-51e9-44a3-8952-e383f98d4ae3/81ee9842-d67a-4460-8c07-3b07d50e23b6.webp
  users/85541b25-51e9-44a3-8952-e383f98d4ae3/5388599a-4888-497f-9fa7-b582ab78fec0.webp
  users/85541b25-51e9-44a3-8952-e383f98d4ae3/4cac8b44-979f-40fe-9d90-f548ec1d0462.webp
→ `src/` を含む key = 0
```

### `src/` が空のまま — **PASS**

R2 listing(read-only dry-run・2 回実施):

```
[dry-run] listed=150 matched=0 skipped=150   (§2 前半)
[dry-run] listed=165 matched=0 skipped=165   (§2 後半)
```

DB 側: `SELECT count(*) FROM assets WHERE object_key LIKE '%/src/%'` = **0**(全 157 件中)。

### 再訪カードの中立文言 — **PASS**

処理中に別タブで `/app/upload` を開いた実測(`main` の innerText 全文):

```
アップロード

試験問題の画像を選択すると、 AI が問題を抽出します。 抽出結果は次の画面で確認 / 保存できます。

直前のアップロードがまだ完了していません。

処理中です。 完了すると試験一覧に反映されます。

試験一覧を見る
```

禁止語チェック(`再度お試しください` / `中断` / `お待ちください` / `削除` / 待ち時間の数値)= **全て不在**。

### 確定失敗面の文言(I-3(b) の分離が生存)— **PASS**

既存 failed doc `8d6f19e7`(2026-08-05 の smoke 由来)の result page:

```
hasAlertRole: true
⚠ 問題を抽出できませんでした

処理が中断された可能性があります。 しばらく待ってから再度お試しください。 処理状況は試験一覧で確認できます。

試験一覧へ
```

中立文言(`完了すると試験一覧に反映されます`)の混入 = **なし** / `✅` = **なし**。

### T16-a の除外表示 — **0 件非表示は PASS / 除外束の文言は観測できず**

run 7 の result page:

```
heading: ✅ 11 問を抽出しました
summary: 図版 5 件を取り込みました。
has_excluded_line (取り込めませんでした): false
has_capped_line   (上限のため省略):     false
has_cards_excluded_line (問中):          false
```

→ **0 件の 3 行が非表示になる側は実機で確認**。除外束そのものの文言は、本 smoke で除外が 1 件も発生せず**観測できていない**。
既存の completed op を DB 全走査しても除外 > 0 の行は **0 件**だった:

```sql
SELECT … FROM upload_operations WHERE status='completed'
  AND ((result_summary->>'cardsExcluded')::int > 0
    OR (SELECT sum(v::int) FROM jsonb_each_text(result_summary->'figuresExcluded') AS t(k,v)) > 0)
→ (0 rows)
```

誘発は行わない方針(§5 のとおり無地画像は誘発手段として成立しない)。

### exam 削除 cascade — **PASS**

本 smoke で作成した exam を UI から削除(確認ダイアログ「この試験を削除しますか?」→「削除する」)。
前半 4 件 + 後半 2 件を削除し、いずれも同じ結果:

```
exams_left | docs_left | ops_left | cards_left
         0 |         0 |        0 |          0

tombstones(直近):  exam 2 / card 22     ← 後半 2 exam(11+11)と一致
tombstones(前半):  exam 4 / card 34     ← 前半 4 exam(11+11+11+1)と一致

非終端 op = 0
```

---

## §3 タブ閉じの厳密証明(S-4 の主眼)— **PASS**

`after()` 化の眼目は「client が離脱しても処理が継続する」こと。**閉じた時点でまだ処理中だった**ことを
DB で確認しない限り、単に「完了が早かった」だけかもしれず証明にならない。run 3 / run 6 は実際に
close 前に完了しており**判定不能**だった。run 7 で以下の順に確定させた。

### 手順と生の観測

```
1. submit クリック(page 内 evaluate の戻り値)
   "SUBMIT_CLICKED 2026-08-06T00:40:54.096Z"

2. タブを閉じる(browser_tabs close index 0)

3. 閉じた直後に DB を読む
   $ date -u  →  tab_closed_at=00:41:07

   doc_id                               | doc_status | doc_created | op_status  | op_completed | lease_present
   7b75f662-6955-4c45-8bf3-f2c501848640 | processing | 00:40:54    | processing | (null)       | t
   ↑ 閉じた時点で doc/op とも processing・lease 生存

4. 25 秒待って再度 DB を読む(ブラウザは about:blank のまま)
   doc_id       | doc_status | created  | op_status | completed | last_error_code | extracted | attached | cards
   7b75f662…    | completed  | 00:40:54 | completed | 00:41:11  |                 | 11        | 5        | 11

   非終端 op = 0
```

**close(00:41:07)時点で `processing` → その 4 秒後(00:41:11)に completed。** 間にブラウザ側の
タブは存在しない(残っていたのは `about:blank` のみ)。`after()` の継続実行が実機で成立している。

補足: run 4 も close 00:14:19.3 → completed 00:14:28 で同じ向きの観測だが、close 時点の DB 状態を
確認していないため run 7 を正記録とする。

---

## §4 新発見: result page の preview だけ本文 markdown 画像記法が生表示される

**②-3(本文 markdown 画像記法の描画側 enforce)の strip が、upload result page の preview surface に
適用されていない。**

### 観測

result page(run 7)の preview:

```
第10問 架空器具イプシロンの正しい設置方向を示す図はどれか。

![](q010-img-1)   ← 生の markdown 画像記法がそのまま見えている
選択肢 4 件
```

同じ card を exam 詳細(実カード表示)で見ると:

```
第10問
問題文
架空器具イプシロンの正しい設置方向を示す図はどれか。
(以下 選択肢)

main の innerText を /!\[[^\]]*\]\([^)]*\)/g で走査 → マッチ 0 件
```

DB 実測(記法は保存側に存在する = ②-3 の設計どおり):

```
 title  | question_text(抜粋)
 第1問  | …下記の解答群から選べ。 |  | ![](q…
 第9問  | …正しい記述はどれか。 |  | ![](q009-img-1) |  | 1 最高血中濃度に…
 第10問 | 架空器具イプシロンの正しい設置方向を示す図はどれか。 |  | ![](q010-img-1)

記法を含む card 総数(全 exam)= 24 件
```

### 原因(read-only 調査)

- preview の文字列は `lib/exams/list.ts:206` の **`questionTextSnippet: snippet(r.questionText, 80)`**
  = DB の生 `question_text` を 80 字で切っただけ。②-3 の `stripInlineImages` を通らない。
- ②-3 の strip は `components/markdown/md-table-text.tsx` の **`segmentStrippedForRender`**
  (= `MdTableText` / `MdTableBlock` 経由)にしか無い。preview はこの component を使わず、
  `page.tsx:166` が `{c.questionTextSnippet}` を素のテキストとして出している。

### 判定

- **影響は表示のみ**。保存データ・実カード描画・図版 attach はいずれも正常。
- ②-3 が記録した「**単一点 = entry-point strip**」という主張は**偽**だった(→ §7 の doc 訂正へ)。
- fix は `lib/` から `components/` を import する形になり eslint Block A に当たる可能性が高く、
  strip の共有化(配置換え)が要るため小さくない → **follow-up は claude.ai 側 todo へ**(公開前トラック / UIUX 整理)。

---

## §5 新発見: 無地画像は失敗の誘発手段として成立しない(捏造カードが出た)

run 5 で「有効カード 0 → `empty_cards` で terminal」を誘発する目的で **白一色 1200×1600 PNG** を投入したところ:

```
✅ 1 問を抽出しました
第1問 次のうち、OSI参照モデルにおけるネットワーク層の役割として適切なものはどれか。
選択肢 4 件
→ op completed(failed にならない)
```

**入力に存在しない問題を Gemini が生成した。** 2026-08-05 の smoke では同型入力が `empty_cards` → failed に
なっており、挙動が run ごとに割れる。

- 機構としては正しい(有効 card が 1 件ある以上 publish するのが仕様)。
- しかし **失敗系の誘発手段としては信頼できない**(成功してしまう)。以後 failed 面の確認は
  **既存の failed doc を開く**方法で行う(本 smoke もそうした)。
- 「無入力から内容が捏造されうる」こと自体は品質観点の別論点(prompt/model は ②-4a の凍結スコープ外)。

作成された exam は削除済み。

---

## §6 新発見: 図版検出数が同一入力で揺れる

同じ 5 枚を投入して `figuresAttached` が **10 → 5** と変化した(run 6 = 10 / run 7 = 5)。
両 run とも除外束は全 0:

```
run 7: cardsExcluded 0
       figuresExcluded {"malformed":0,"crop_failed":0,"coordinate_null":0,"asset_id_invalid":0,
                        "deadline_excluded":0,"source_id_invalid":0,"image_limit_exceeded":0,
                        "orientation_unsupported":0}
       card_asset_refs 5(= figuresAttached と一致)
```

→ **除外ではなく Gemini が検出した figure region の数そのものが違う**(非決定性)。
仕様上の欠陥ではないが、「同じ入力なら同じ図版数」を前提にした test を書いてはいけない、という制約として
follow-up に記録する。

---

## §7 付随観測

- **未参照 asset 68 件**(`status='ready'` かつ `card_asset_refs` からの参照 0)。本 smoke と前日 smoke で
  削除した exam 由来で、GC v2 の mark 対象。reconciler は手動実行(設計どおり・OT)。
  ```
   status |  n  | zero_ref
   ready  | 157 |       68
  ```
  `status IN ('deleting','deleted')` の asset = 0(= 削除直後に即 mark される設計ではない・想定どおり)。
- **OCR quota**: 226 → 195(本 smoke で 31 ページ消費・うち無地 1 枚)。
- **`integration_failures`** は本 smoke で増えていない(予期しない throw なし)。
- **非終端 op = 0**(smoke 終了時点・残骸なし)。
- 証跡として run 1 の exam(`アップロード 2026-08-06 09:08` / 11 cards / 図版 10)のみ残置。他は削除。

---

## §8 未実施 / OT に残るもの

1. **Functions タブでの maxDuration 720s 目視**(Dashboard 権限)。§0 のとおり CC 側は間接証拠まで。
2. **dpl ↔ git SHA の直接照合**(Dashboard)。CC 側は「deploy 出力 = HEAD 相当」まで証明。
3. **T16-a の除外束の文言**(3 行の実表示)。除外が自然発生した doc が出たときに確認する。
4. **`in_progress` 面**(race 限定・任意項目)。文言は unit で pin 済。
5. **予期しない throw の `integration_failures` 書込**(UI から誘発不能・iso のみ・architecture.md「証明の空白」に記載済)。
6. **40 枚 upper-scale の実測**(本 smoke は最大 5 枚)。
