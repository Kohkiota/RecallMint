# OCR チューニング sprint(2026-08-06)

fact-finding = `docs/audit/2026-08-06-ocr-tuning-factfinding.md`。
起点 = deps T1 の stg smoke で `cardsExcluded 1` の理由が取れなかったこと。

| task | 内容 | commit |
|---|---|---|
| A | card 除外理由を 3 区分で記録 | `d8d1b63` `[reviewed]` / `41bcff5` |
| B | prompt に複数段ヘッダーの畳み込みルール | `2c1f2e1` `[reviewed]` / `d67d8c9` |
| D(破棄) | ingest でのトークン除去 | **commit せず破棄**(下記 §1) |
| D-1 | prompt から画像記法テンプレートを削除 | `71d5a0a` `[reviewed]` / `58e9408` |
| E | 描画時 mask と dead code の撤去 | **未着手**(解禁条件未達・下記 §4) |

---

## 1. D の破棄 — 指摘は正しかったが、解決対象が誤っていた

当初 D は **ingest 境界(`normalizePrepared`)で AST ベースにトークンを除去する**実装だった。Codex 独立レビューが 3 周連続で Important を出し、**3 本とも実測で真**だった:

| 周 | 指摘 | 実測 |
|---|---|---|
| r1 | 長さ guard の前提が偽 — トークンで上限超過した本文は strip すれば収まるのに card ごと捨てていた | 真 |
| r2 | `![](a) ![](b)` だけの行が**空白行として残る**(画像 1 個ずつ「前後が空白か」を見ると互いを非空白と観測する) | 真 |
| r3 | 複数行にまたがる画像 + 同一行の別画像で行 group が重なり、また空白行が残る | 真(`'本文\n![alt\ntext](url) ![](b)\n続き'` → `'本文\n \n続き'`) |

**patch → 新 edge case → patch を 3 周繰り返した**。②-3 でも同型の経過があり、そこでは patch でなく構造変更(entry-point strip)で解消している。

OT の判断は**解決対象の見直し**だった: **トークンの生成源は prompt**。観測された 4 件はすべて `![](qNNN-img-N)`(alt 空)で、prompt が持っていた `![](key)` テンプレートと同 section 内の key 命名規則(`q{sort_key}-img-{連番}`)の合成形。**生成を止めれば除去処理は要らない。** 実装(4 file / +333 -17)は破棄し、prompt 修正(D-1)へ転換した。

Codex raw 3 本は「**誤った解決対象に対する正しい指摘**」として残す(`docs/codex/2026-08-06-ocr-tuning-d-ingest-strip{,-r2,-r3}.md`)。

**残す教訓**: r2 / r3 が突いた multi-line 記法や複数トークン行は、**prompt 契約から要求されない入力**である。`question_text` / `options[].text` には今も「Markdown 可」とあるため原理的に出ないとは言えないが、**現時点でこれらへの汎用対応を正当化する証拠はない**(観測 4 件はすべて単一行・alt 空・prompt の字面と一致)。汎用 strip を持つ判断は、実際にそういう出力を観測してからで足りる。

## 2. A — card 除外理由の非対称を埋めた

card が落ちる分岐は 3 つあるのに 3 つとも同一の戻り値を返しており、理由が `result_summary` / `last_error_code` / ログのどこにも残らなかった(figure 側は 8 区分が DB に残る)。区分は figure 側の語彙に揃えた:

| 分岐 | 区分 | figure 側との対応 |
|---|---|---|
| `rawCardSchema` 形状破損 | `malformed` | 同名同義 |
| `preparedCardSchema` の hard invariant | `invariant_failed` | `crop_failed` と同語形 |
| cardId の cross-card 衝突 | `card_id_invalid` | `asset_id_invalid` と同型(**範囲差あり** — 非 v4 shape は `preparedCardSchema` が見るため `invariant_failed` に入る) |

`NormalizePreparedCardResult` を **discriminated union** にし「除外なら必ず区分がある / 生存なら区分が存在しない」を型で強制した。将来 4 つ目の除外経路が区分を忘れたら compile error になる。

canonical が突いた最大の穴は **producer→`result_summary` の 2 hop が未 pin** だったこと — 「stage の透過を全 0 に潰す」「`buildResultSummary` のキーを入れ替える」変異が **4444 test を全 green のまま通過**した。pin を追加し両変異が落ちることを RED 実証した。

## 3. B / D-1 — prompt 側

- **B**: 表の指示は 2 列 1 段ヘッダーの例が 1 つあるだけで複数段への言及がゼロだった。畳み込みルールを既存例の直下に追加。canonical が突いた点 = 追加ルールが prompt 唯一の `*最優先*`(改行保持・flat 圧縮禁止)と衝突し、モデルが保持側へ倒れると **2 行ヘッダーのまま出力 → GFM が表と認識せずリテラル化**して目的が達成されない。優先関係を 1 文で明示して解消。提示表が GFM として valid であることは repo の parser で実測。
- **D-1**: `![](key)` テンプレートを prompt から削除。**禁止文に置き換えない**(禁止でも記法が残るうえ、「埋め込む必要はない」は許可でモデルは任意選択と読む)。回帰 test は 1 assertion のみで、検査対象を **live 経路が実際に送る exploration prompt** に寄せた。RED で「suffix 側に混入させると落ちる / brief 原案(discover のみ)では捕まらない」ことまで実証した。

**残余リスク(D-1)**: 削除したのは「コピペできる完成形テンプレート」であって合成能力ではない。key 命名規則(`q{sort_key}-img-{連番}`)と「Markdown 可」は残るため、理論上モデルは今も合成できる。arm 比較で 0 が出なければ次の lever は禁止文ではなく §6 の起票候補。

## 4. E — 未着手(解禁条件が 1 つも満たされていない)

**E は問題解決ではない。** トークンを消すのは D-1(生成の停止)と backfill(既存行の掃除)。E は不要になった描画時 mask と dead code を撤去するだけで、D-1 と backfill が終われば**ユーザー影響なしに延期できる**。

解禁条件(すべて必要): D-1 deploy 済 / arm 比較で placeholder 0 / figure_regions の検出・添付が悪化していない / backfill 後の SELECT で 0 件 / OT が「実ユーザー 0」を確認。

### E 着手時に残っている判断(調査済み・未実行)

- **`strip` は文字を隠す以外のこともしていた**(前提が厳密には偽だった)。現在 strip 後に table segmentation しているため、**画像行が消えることで無効な表が有効になる**。`components/markdown/md-table-text.test.tsx:104` がその入力(`'| a |\n![x](u)\n|---|\n| 1 |'`)を使っており、strip 撤去後この入力は表でなくリテラルになる。同 file 唯一の `MdTableBlock` test でもあるため、`<table>` を `<p>` の子にしない不変条件を失わないよう**入力を差し替えて test 自体は残す**のが妥当(削除すると pin が消える)。
- 同 file `:93`(text セグメントの記法)は**新挙動へ書き換え**、`:115`(参照記法の whole-document strip)は**主題そのものが消える**ため削除が妥当。
- **strip を消しても画像は描画されない**。`COMPONENTS.img: () => null` は別目的の防御(表セル内の外部 URL でリクエストを飛ばさない)として維持する。text セグメントは markdown parse を通らない素の text node なので、strip 撤去で起きるのは「トークン文字列がリテラル表示になる」ことだけ。
- `docs/harness.md` に strip 機構の索引行は**無い**(確認済み)。歴史的 spec は凍結 record なので書き換えず、E の session 記録で supersede する。
- 未適用 surface 2 箇所(`upload/result/[sourceDocumentId]/page.tsx:166` / `study/custom/_components/custom-session-preview.tsx:107`)への個別対処はしない。D-1 + backfill 完了後は表示すべきトークン自体が存在しない。

## 5. arm 比較(B と D-1 を 1 回で)

どちらも prompt 変更なので **1 回にまとめる**。

合否条件:

1. 新規 OCR 出力に `![](` が **1 件も出ない**こと。**生出力を直接見る**。
2. **`figure_regions` として期待する図版が検出され、最終的に添付対象へ残っている**こと。**raw `images[]` を指標にしない** — 現行 single-invocation 経路では normalize が検証も転記もしない中間値で、実際に使われるのは `figure_regions`。
3. (B)選択肢表の `question_text` 再掲率が before から**増えていない**こと。追加した複数段ヘッダー例は先頭空セル + 行ラベル + 値行列で**組合せ選択肢表と構造的に同型**であり、このセクションの適用先に `options[].text` が含まれるため、二重出力を増やす方向に効く可能性がある(canonical 指摘。prompt 側で対処すると「選択肢の二重出力に手を入れない」に抵触するため検証条件へ移送した)。
4. (B)既存 1 段ヘッダー表の出力が**不変**であること。
5. (B)**物価指数表以外の多段表**を評価素材に含めること(追加例が ②-2 の評価素材の表と似ており、例との一致を測ってしまうため)。

before の基準値: ②-2 Phase2 で **3 画像中 2 に混入**を観測(`docs/superpowers/sessions/2026-07-29-ocr-2-2-migration-phase2-armcompare.md`)。**図表参照を含む素材**を選ばないと空振りする(②-3.5 の教訓「0 件 = 検証できていない」を再適用)。

## 6. backfill

既存行の掃除。**汎用 script / 引数 / dry-run mode は作らない。** SQL は下記を OT が実行する。

### SQL 1 を stg で read-only 実走した結果(2026-08-06)

**集計範囲の限界**: **stg のみ / 1 ユーザー分のみ**(`DATABASE_URL_APP` は RLS 配下の app role、`DATABASE_URL_ADMIN` は空、prod は CC から到達不可)。全ユーザー・prod は OT が SQL 1 を実行して確認する。

| field | ヒット | 内容 |
|---|---|---|
| `question_text` | **4** | `![](q001-img-1)` / `![](q004-img-1)` / `![](q009-img-1)` / `![](q010-img-1)` |
| **`options[3].explanation`** | **1** | card `1dc6cc60-…` に `![](q009-img-2)` |
| `title` / `sort_key` / `explanation_text` / `memo` / `options[].text` / `options[].id` | 0 | — |

**停止条件に該当**: `question_text` 以外(`options[].explanation`)にヒットしたため、**その場で汎用 SQL を作らず停止**した。options 用 UPDATE は用意していない。
`sort_key` / `options[].id` は 0 件(想定外停止には該当せず)、`memo` も 0 件。

**fact-finding の見落とし**: 前回は card 単位の `explanation_text`(0)と `options[].text`(0)しか数えておらず、**option 単位の explanation を数えていなかった**。E に備えて mask が掛かっていた全 field を走査したことで出た。

5 行とも `updated_at` が `2026-08-04T04:15:41.793Z` で一致しており、同一の一括操作由来と見られる。

### SQL 1: 候補確認(read-only)

本文は出さない(row ID / field 名 / 一致文字列 / 一致数 / field hash / updated_at のみ)。本文は著作物の疑いがある側で、②-4a の軸と一貫させる。

```sql
WITH opt AS (
  SELECT c.id, c.updated_at, e.ord, e.val
  FROM cards c,
       LATERAL jsonb_array_elements(c.options) WITH ORDINALITY AS e(val, ord)
),
fields AS (
  SELECT id, 'question_text'    AS field, question_text    AS v, updated_at FROM cards
  UNION ALL SELECT id, 'title',            title,            updated_at FROM cards
  UNION ALL SELECT id, 'sort_key',         sort_key,         updated_at FROM cards
  UNION ALL SELECT id, 'explanation_text', explanation_text, updated_at FROM cards
  UNION ALL SELECT id, 'memo',             memo,             updated_at FROM cards
  UNION ALL SELECT id, 'options[' || ord || '].text',        val->>'text',        updated_at FROM opt
  UNION ALL SELECT id, 'options[' || ord || '].explanation', val->>'explanation', updated_at FROM opt
  UNION ALL SELECT id, 'options[' || ord || '].id',          val->>'id',          updated_at FROM opt
)
SELECT
  f.id                                 AS card_id,
  f.field                              AS field,
  array_agg(m.match[1] ORDER BY m.ord) AS placeholders,
  count(*)::int                        AS match_count,
  md5(f.v)                             AS field_md5,
  f.updated_at
FROM fields f
CROSS JOIN LATERAL regexp_matches(f.v, '!\[[^]]*\]\([^)]*\)', 'g')
  WITH ORDINALITY AS m(match, ord)
WHERE f.v IS NOT NULL
GROUP BY f.id, f.field, f.v, f.updated_at
ORDER BY f.field, f.id;
```

### SQL 2: row 固有 UPDATE(question_text の既知 4 件のみ)

**deploy 後に流す。** deploy 先行にする理由 = ingest 側(prompt)が効いた後なら backfill が一度で確実に終わる。SQL 先行だと、旧 prompt を使う実行が掃除後の DB にトークン付き card を再挿入しうる(silent)。deploy 先行で生じるのは数分間リテラル表示されることだけ(loud)。

条件に **row ID + field hash** を使い、本文を SQL に転記せずに同時編集を検知する(hash 不一致なら 0 行更新 = 掃除されない・上書きしない)。`updated_at = now()` は必須 — cards の増分 pull は `updated_at >= cursor` だけを見ており DB trigger も無いため、bump しないと Dexie にトークンが残る。

```sql
-- 1) card ae6912e7 / ![](q001-img-1)
UPDATE cards SET
  question_text = regexp_replace(question_text, '!\[\]\(q001-img-1\)', '', 'g'),
  updated_at = now()
WHERE id = 'ae6912e7-b3fc-47b4-b011-281da2ee6c0d'
  AND md5(question_text) = '71da280f6822f74d9ae8faacc10ba8ab';

-- 2) card 286addc4 / ![](q004-img-1)
UPDATE cards SET
  question_text = regexp_replace(question_text, '!\[\]\(q004-img-1\)', '', 'g'),
  updated_at = now()
WHERE id = '286addc4-e431-42e1-95af-a9353c42db96'
  AND md5(question_text) = 'c99bcb60941e3c8e457a2a5429e509cc';

-- 3) card 1dc6cc60 / ![](q009-img-1)
UPDATE cards SET
  question_text = regexp_replace(question_text, '!\[\]\(q009-img-1\)', '', 'g'),
  updated_at = now()
WHERE id = '1dc6cc60-a750-44fb-a682-4d9e60018e9c'
  AND md5(question_text) = '401a3cdbc535e44b89a90853360d80e6';

-- 4) card 4edf5270 / ![](q010-img-1)
UPDATE cards SET
  question_text = regexp_replace(question_text, '!\[\]\(q010-img-1\)', '', 'g'),
  updated_at = now()
WHERE id = '4edf5270-c678-48e1-b895-f7bd3aaf0353'
  AND md5(question_text) = 'c8cfbaa4e833a20a6679c74df749cb85';
```

**注意**: トークンの周囲の空白・改行は触らない(構文だけを消す)。破棄した D 実装が扱っていた「行ごと消す」処理はここでは行わない — 4 件とも段落途中ではなく確認が必要なら SQL 1 の再実行で残存を見る。`options[3].explanation` の 1 件は**上記に含めていない**(停止条件)。

### SQL 3: 更新後確認(0 件確認・read-only)

SQL 1 をそのまま再実行し、**question_text のヒットが 0 件**になっていることを見る(`options[].explanation` の 1 件は指示があるまで残る)。

## 7. 残件

1. **`options[3].explanation` の 1 件**(card `1dc6cc60-…` / `![](q009-img-2)`)— 停止条件により未対応。OT 指示待ち。
2. **arm 比較**(§5)— B + D-1 を 1 回で。未実施。
3. **backfill 実行**(§6 SQL 2)— OT。全ユーザー・prod の走査も OT。
4. **E**(§4)— 解禁条件未達で未着手。
5. **起票候補**: `IMAGE_REFERENCE_RULES` 42 行は live 経路で死荷重になっている。schema は `images` を required で要求し prompt は 42 行かけて `key` / `target` / `alt` / `source_ref` の作り方を指示するが、**live 経路の ingest は `images` を捨てている**(`lib/ocr/normalize-prepared.ts` のコメントに明記・実際に付く画像は `figure_regions` → server crop 経路)。つまり `qNNN-img-N` の key 命名規則は誰も消費しない値のために置かれ続け、本文混入トークンの材料を供給していた。section ごと落とす(schema の `images` required 解除込み)判断は本 sprint の scope 外(canonical R-3)。
6. **A の申し送り**: `options[].text` がトークンだけの card は strip 後に空となり card 全体が除外される、という挙動は **D の破棄により消滅**した(ingest strip をやめたため)。現行は D 以前と同じくトークン文字列が非空のまま card は残る。
