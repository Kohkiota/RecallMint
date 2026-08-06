# OCR チューニング sprint — fact-finding(2026-08-06)

調査のみ。**実装・prompt 書換・migration・データ削除は一切していない。修正案も書かない**(OT 指示)。
契機 = deps T1 の stg smoke で `cardsExcluded 1` が出た際、除外理由が `result_summary` から取れなかったこと(`docs/superpowers/sessions/2026-08-06-deps-t1-stg-smoke.md`)。

---

## 1. T16-a の実体 — card 側の除外理由は**どの層にも存在しない**

### T16-a の scope は display 限定

T16-a 自身の記録(`docs/superpowers/sessions/2026-08-05-ocr-2-4a-t16a-exclusion-display.md` §1)が明記している:

> 既にある summary を読んで出すだけで解消した。producer(`lib/ocr/prepared-schema.ts` / `lib/ocr/normalize-prepared.ts` / `buildResultSummary`)は**無変更**。

= T16-a は**除外理由の記録経路を 1 つも追加していない**。`result_summary` に既にある値を result page が読んでいなかった問題(11 問取れた時と 0 問の時が同じ見た目)を、表示側だけで解消した task。

### card が除外される分岐は 3 つ・すべて理由を残さない

すべて `lib/ocr/normalize-prepared.ts`:

| # | 分岐 | 行 | 戻り値 | 理由の記録先 |
|---|---|---|---|---|
| 1 | `rawCardSchema.safeParse` 失敗(構造破損) | 278-281 | `{ card: null, figuresExcluded: zeroFigureExclusions() }` | **無し** |
| 2 | `preparedCardSchema.safeParse` 失敗(hard invariant) | 341-347 | 同上 | **無し** |
| 3 | `seenCardIds.has(cardId)`(cardId の cross-card 衝突) | 355-357 | 同上 | **無し** |

**3 分岐の戻り値は完全に同一**で、呼び出し元 `normalizePrepared`(423-437)は

```
if (result.card === null) { cardsExcluded += 1; continue }
```

としか書けない。**どの分岐で落ちたかは呼び出し元から判別不能**。

記録先の候補を全て潰した結果:

- `result_summary`(`upload_operations.result_summary`)= `cardsExcluded` の**件数のみ**。理由の器が無い。
- `last_error_code`(`upload_operations`)= **operation 単位**の列で card 単位の概念ではない。今回の smoke でも `NULL`。
- ログ = `normalize-prepared.ts` に `console` / `logger` / `captureException` の類は **1 つも無い**(純関数)。
- 表示 = result page は `{M} 問中 {N} 問を取り込みました。` の件数のみ。

### figure 側との非対称

figure は **8 区分**の理由が集計され `result_summary.figuresExcluded` として **DB に残る**:

- `lib/ocr/prepared-schema.ts:81-91` に 4 区分 — `coordinate_null` / `source_id_invalid` / `malformed` / `asset_id_invalid`
- crop / publish 段で 4 区分 — `crop_failed`(`lib/media/crop-and-store.ts`)/ `deadline_excluded` / `image_limit_exceeded` / `orientation_unsupported`(`app/(app)/app/upload/_lib/publish-prepared-plan.ts:34-57`)

ただし T16-a は**理由コードを画面に出さない**設計を明示的に選び、3 束(取り込めなかった / 上限のため省略 / 図版 N 件取り込み)に畳んでいる(同 doc「表示(確定仕様)」)。**画面に出ないだけで DB には残る**点が card 側と決定的に違う。

**要約**: 除外理由の記録は **figure 側のみ**。card 側は件数だけで、理由は producer にも DB にもログにも存在しない。

---

## 2. OCR prompt の現物(`lib/ai/prompts/ocr-extract.ts`・268 行)

### 選択肢を問題文に含めない指示 — **2 段階で明示されている**

```
225: - 同じ内容を question_text と options[] の両方に入れない。
226: - 選択肢が表形式で並んでいる場合、その表は options[] として抽出し、
227:   question_text に表として再掲しない。
```

225 が一般則、226-227 が**表形式の選択肢に対する個別の指示**。関連して 223-224 が question_text / options[] の役割を定義している。

= 二重出力が起きている場合、**指示は済んでおり守られていない側**。

### 表の出力に関する指示 — **複数段ヘッダーへの言及はゼロ**

表に関する記述は 37-42 の 1 箇所のみ:

```
37: - 表データ (項目一覧 / 集計表 / データ一覧など) → Markdown 表形式:
38:     | 項目 | 値 |
39:     |---|---|
40:     | 在庫A | 410 |
41:     | 在庫B | 7800 |
42:   要素数が少なく自然文で読める場合 (例:「幅168cm、高さ65cm」) はそのまま自然文で可。
```

**2 列・ヘッダー 1 段**の例が 1 つあるだけ。`複数段` / `多段` / `段組` / `結合` / `colspan` / `rowspan` / `入れ子` / `ネスト` / `ヘッダー行` を全文 grep して**該当ゼロ**(47 行目の「段落区切り…結合しない」は段落の話で無関係)。

### 参考: 本文への画像記法

```
153: - question_text / options[].text / explanation_text 内に Markdown 画像記法
154:   (![](key)) を埋め込む必要はない。対応関係は images[].target で表現する
```

「埋め込む必要はない」= **禁止形ではない**(②-3 が描画側 enforce を選んだ前提)。

---

## 3. 本文中の markdown 画像記法

### ingest 側に加工点は無い

OCR 出力 → card 本文の経路で、テキストへの加工は**一切行われていない**:

- `lib/ai/ocr.ts:47` — `question_text: z.string()`(型検証のみ)
- `lib/ocr/normalize-prepared.ts:332` — `questionText: data.question_text`(**素通し代入**)
- publish 層は `preparedPayloadSchema.parse()` 済み payload を消費するのみで再正規化しない(`normalize-prepared.ts:249-251` のコメント)

strip も正規化も **ingest では存在しない**。

### `stripInlineImages` の呼び出し全列挙

実装側は **1 箇所のみ**(他は `strip-inline-images.test.ts`):

- `components/markdown/md-table-text.tsx:61` — `segmentStrippedForRender(value) = segmentMdTables(stripInlineImages(value))`

これを使う公開 component は同 file の `MdTableText`(85 行)/ `MdTableBlock`(94 行)。利用箇所:

| 利用側 | 行 |
|---|---|
| `app/(app)/app/exams/[id]/_components/inline-text-field.tsx` | 319 |
| `app/(app)/app/exams/[id]/_components/inline-option-row.tsx` | 456 |
| `app/(app)/app/study/smart/_components/session-runner.tsx` | 438 / 490 / 500 / 547 / 572 |

### strip 未適用 surface の全列挙(**entry-point 主張は今も偽**)

card 本文を描画する全 file を洗い出し(`questionText` / `question_text` / `explanationText` / `explanation_text` / `opt.text` の grep)、各々の描画方法を確認した結果、**`MdTableText` を通らない表示面が 2 つ**ある:

| # | 場所 | 描画 |
|---|---|---|
| 1 | `app/(app)/app/upload/result/[sourceDocumentId]/page.tsx:166` | `{c.questionTextSnippet}` — 素の JSX テキスト |
| 2 | `app/(app)/app/study/custom/_components/custom-session-preview.tsx:107` | `<p className="line-clamp-2 leading-snug">{card.question_text}</p>` — 素の JSX テキスト |

#1 は既知(memory / `2026-08-06-ocr-2-4a-close-stg-smoke.md` の「preview surface の strip 未適用」)。**#2 は本調査で新たに判明した分**。

**strip 適用済みが確認できた面**(念のため全て追跡した):

- exam 詳細のカード表示 → `InlineTextField` → `MdTableText`
- exam 詳細の選択肢 → `InlineOptionCell`(`inline-option-row.tsx:456`)→ `MdTableText`
- **テーブルビュー** → 5 列(title / sort_key / question / explanation_text / memo)が `InlineTextField`、options 列が `CompactOptionsCell` → `InlineOptionCell` → いずれも `MdTableText`(`exam-card-table-columns.tsx:148/171/197/286/320` + `exam-card-table-options-edit-cell.tsx:67`)
- side peek → `CardEditorFields` → `InlineTextField` → `MdTableText`(`exam-card-side-peek.tsx:139`)
- スマート復習 → `MdTableText` / `MdTableBlock`
- deck download button — card 本文を描画しない

編集モードの `<textarea>` が raw を表示するのは編集対象が raw source ゆえで、上記の「未適用 surface」には数えていない。

### 現存件数(**集計範囲の限界を先に明記**)

**この数字は全体の主張にできない。**

- **stg のみ**。prod は `.env.local` に接続情報が無く **CC から到達不可**。
- **1 ユーザー分のみ**。`DATABASE_URL_APP` は `recallmint_app` role で RLS 配下、`DATABASE_URL_ADMIN` は**空文字**(len=0)ゆえ全ユーザー集計ができない。対象 = `user 85541b25-51e9-44a3-8952-e383f98d4ae3`(smoke で使った test ユーザー)。
- この user の当該時点の card 総数 = **322**。

| 対象 | `![...](...)` 全般 | `![]()` ちょうど |
|---|---|---|
| `question_text` | **4** | **0** |
| `options[].text`(いずれかの option) | **0** | **0** |
| `explanation_text`(参考) | **0** | — |

**現存する記法の実体は `![]()` ではない。** 実サンプル(4 件すべて同形):

```
![](q009-img-1)   card 1dc6cc60-a750-44fb-a682-4d9e60018e9c
![](q010-img-1)   card 4edf5270-c678-48e1-b895-f7bd3aaf0353
![](q004-img-1)   card 286addc4-e431-42e1-95af-a9353c42db96
![](q001-img-1)   card ae6912e7-b3fc-47b4-b011-281da2ee6c0d
```

= **alt が空・target key は非空**(`qNNN-img-N`)。文字どおり空の `![]()` は**この範囲では 0 件**。

---

## 4. 図版検出の非決定性 — temperature / seed の指定は**無い**

本番経路の `generateContent` は `lib/ai/clients/gemini.ts:129` の **1 箇所のみ**(`scripts/ai/lib/gemini-raw.ts:82` は調査用 script)。渡している `config` の全内容:

```ts
config: {
  responseMimeType: 'application/json',
  responseJsonSchema: input.responseJsonSchema,
  abortSignal: controller.signal,
}
```

`temperature` / `seed` / `topK` / `topP` / `candidateCount` / `generationConfig` / `thinkingConfig` は **`lib/ai/` 配下に 1 度も出現しない**(全文 grep で該当ゼロ)。

参考: 同一入力での `figuresAttached` 実測は 10(`2026-08-06-ocr-2-4a-close-stg-smoke.md` run 1/4/6)/ 5(同 run 7)/ 8(`2026-08-06-deps-t1-stg-smoke.md`)。後者は `figuresExcluded` が全キー 0 = crop / 座標 / deadline いずれの失敗も無く、**検出数そのものの差**。

---

## 付記: 本調査で確認しなかったこと

- prod DB の状態(到達手段が無い)
- 対象ユーザー以外の card(RLS)
- `cardsExcluded 1`(smoke の問9 脱落)が上記 3 分岐のどれだったか — **判別する手段が実装に無い**ため、`OCR_DEBUG_LOG` 付きの再走なしには確定できない
