# ②-4a T16 fact-finding + 設計提案(2026-08-05)

除外理由の提示 + 回転(EXIF≠1)除外。**調査と提案のみ・実装なし・未 commit。**
裏取りは現 HEAD(`ea66cb0`)の実コード。当初 plan / spec の記述は「そう書いてあった」という事実として扱い、
現状と一致するかは個別に確認した。

---

## 1. 当初 plan / spec に何が書かれているか(事実)

**plan `docs/superpowers/plans/2026-07-30-ocr-2-4a-image-figure-crop.md:148-151`(Task 16)**

> - **目的/file**: upload result payload + UI(理由別件数)+ source 取込前段の EXIF orientation 判定。
> - **制約**: 件数 = card N/M + 図版「取込 K / 座標null / source_id 不正 / crop 失敗 / 制限超過 / 向き未対応 / image_limit_exceeded / deadline_excluded」。EXIF≠1(sharp metadata)→当該 source を figure 対象外(text 継続)+ 計上。前提破綻検出器ゆえ発火時 logger.warn(PII-free)。採用順=source 入力順→(page)→y_min→x_min→最終 tie-breaker(source_id)。
> - **完了条件**: unit(採用順ソート・理由別集計・orientation 分岐・向き未対応計上)。

**spec `2026-07-30-ocr-2-4a-image-figure-crop-design.md`**

- `:173`(§4.3)— **回転除外の位置づけの正本**:
  > 座標基準 = crop 元バイトの decoded 寸法。前提: **browser-image-compression が EXIF orientation をピクセルへ焼き込むため Gemini バイト=crop 元バイト=正立で、解釈差は構造的に不発**。前提破綻(圧縮変更等)で契約が壊れる旨を明記。
- `:178-179`(§4.5)— 「EXIF orientation ≠ 1 の source は図版検出をスキップ(text 抽出は実行)、除外理由「向き未対応」計上。検出可能ケース限定(EXIF 無し回転は非対象)。**前提破綻検出器を兼ねる**。exp7 通過で除外を外す follow-up」
- `:355-356`(§16)— exp7 = 回転 JPEG を通した実測。通れば §4.5 の除外を外す。**未実施**。
- §13 — 「**loud failure over silent zero**」。図版の理由は a〜g の 7 区分 + 「向き未対応 e」。②-4a は**件数提示まで**。

### 1 invocation 化で前提が変わった箇所

| 当初の前提 | 現状 | 影響 |
|---|---|---|
| source は R2 に保存し `source_assets` 表が台帳 | **0032 で表ごと drop**。source は R2 に置かない | 「source 取込前段」という段階自体が消滅。EXIF 判定を置く場所が変わる |
| 予約列 `source_kind` / `page_count` / `rotation` / `rasterizer` | **表と一緒に消滅** | 「rotation を列に記録」という選択肢は無い。判定結果は payload か log にしか置けない |
| prepared_payload は最大 7 日保持され別 invocation が再開しうる | **同一 invocation 内で commit → 数秒後に消費**(`upload-pipeline.ts` は in-memory の `payload` をそのまま crop/publish に渡す。DB の payload は fencing/durability 用で cross-version read されない) | **schema 追加に V1/V2 併存が要らない**(§9 の「7 日以上 V1 を残す」運用ルールの前提が消えている)。これは提案 1 のコストを大きく下げる |
| retry / takeover で同じ payload を別 deploy が読む | resume 機構ごと撤去(失敗は全て terminal) | 同上 |

---

## 2. `result_summary` は今どこまで揃っているか

**書いている場所** = `publish-prepared-plan.ts:214-246` `buildResultSummary()`(`upload-pipeline.ts:458` から呼ばれ `publish-prepared.ts:248` で `upload_operations.result_summary` へ)。

```
schemaVersion / operationId / examId / sourceDocumentId
cardsExtracted / cardsTotal / cardsExcluded
figuresAttached
figuresExcluded: { coordinate_null, source_id_invalid, malformed, asset_id_invalid,   ← normalize 時
                   crop_failed, image_limit_exceeded, deadline_excluded }             ← crop/publish 時
cardsPreview: [{ id, title, questionSnippet, optionCount }]
```

### 揃っているもの / 足りないもの

| 項目 | 状態 |
|---|---|
| **図版の理由別内訳** | **揃っている**(7 区分)。spec §13 の a/b/c/d/f/g に対応 + 公式語彙外の `malformed` / `asset_id_invalid` |
| **card の N/M** | **揃っている**(`cardsExtracted` / `cardsTotal`) |
| **card の理由別内訳** | **無い。しかも集計側に存在しない** — `cardsExcluded` は `z.number()` の**単なる合計**(`prepared-schema.ts:136`)。`normalize-prepared.ts:432` は `result.card === null` で `+= 1` するだけ |
| **向き未対応(spec §13 e)** | **どこにも無い**(schema にも集計にも) |
| 採用順ソート | **未実装**。`capImagesToSchemaLimit(candidates)`(`publish-prepared-plan.ts:158`)は **payload の出現順**で truncate する。`y_min` は crop 幾何(`crop-geometry.ts`)にしか出てこず、並べ替えロジックは存在しない |

**card 理由が「捨てられている」のではなく「作られていない」**点が重要。`normalizePreparedCard` は 3 つの異なる理由で `card: null` を返すが、返り値に理由が無い:

- `normalize-prepared.ts:279` — `rawCardSchema` safeParse fail(= card 本体の構造破損)
- `normalize-prepared.ts:345` — `preparedCardSchema` safeParse fail(= 正規化後の厳密検証 fail)
- `normalize-prepared.ts:355` — `seenCardIds` 重複(cardId 衝突)

→ **提示だけでは足りない。card 側は producer(`normalize-prepared` + `prepared-schema`)の変更が要る。** 両 file は S-2 で「無改変」を制約にしていた(spec §1-3)ので、触るなら仕様判断。

---

## 3. UI に出ているか

**出ていない。`result_summary` の reader はコード上 1 つも存在しない**(app/ lib/ 全 grep で writer と schema 以外 hit 0)。

- result page(`app/(app)/app/upload/result/[sourceDocumentId]/page.tsx:43-57,108`)は `getCardsForSourceDocument` で **cards 行を数えて** `✅ {cards.length} 問を抽出しました` と出す。`result_summary` を読まない
- exam 詳細に件数表示は無い
- 実機確認(2026-08-05 smoke): 5 枚 → 「✅ 11 問を抽出しました」。**図版 3 件が attach されたことも、除外が何件あったかも画面に出ない**

→ spec §13 の「loud failure over silent zero」は**現状 満たされていない**。除外は silent に消えている。

---

## 4. EXIF orientation の現状

| 層 | 実装 | file:line |
|---|---|---|
| client | `imageCompression(file, { fileType: 'image/webp' })` を**無条件**に通す。canvas 再エンコードのため **EXIF は焼き込まれて剥がれる** | `upload-form.tsx:209-216` |
| server 検証 | `verifyImageBytes` は `sharp.metadata()` を読むが **`orientation` を見ていない** | `source-image-verify.ts:118-135` |
| server crop | **`.rotate()` を一切呼ばない**(呼ばなければ sharp は EXIF を無視)。検証側と同一経路ゆえ box_2d と寸法基準が一致 | `crop-and-store.ts:266-271` |

**結論: EXIF≠1 の検出は未実装。** そして spec §4.3 のとおり、現行 UI 経路では EXIF≠1 のバイトは**そもそも server に到達しない**(client が必ず canvas 再エンコードするため)。

残る露出は次の 3 つのみ:

1. client 圧縮の仕様変更(spec §4.3 が名指しする「前提破綻」)
2. UI 以外から `submitUpload` を呼ぶ経路の追加(**現状 存在しない**)
3. PDF 経路(②-4b・本 task 対象外)

→ **回転除外の価値は「除外」ではなく「前提が壊れたことの検出」**。spec §4.5 自身が「前提破綻検出器を兼ねる」と書いており、1 invocation 化後もこの位置づけは変わっていない。むしろ `source_assets.rotation` 列が消えた分、**検出結果の置き場所が payload と log しか無くなった**。

---

## 5. 設計提案

### 提案 A — 提示(2 段階に分ける)

**A-1(小・先行可): 図版の理由別を出す。producer 変更不要。**

- `result_summary` に既にある 7 区分をそのまま使う。**新たな集計は要らない**
- 出す場所 = **result page のみ**。exam 詳細には出さない(exam は「学習する場所」で、取り込みの内訳は upload の結果に属する。②-4a は件数提示までという spec §13 の線とも合う)
- 粒度 = **理由コードをそのまま見せない**。ユーザー向けに 3 束へ畳む:
  - 「図版 K 件を取り込みました」(`figuresAttached`)
  - 「N 件は取り込めませんでした」= `crop_failed` + `coordinate_null` + `source_id_invalid` + `malformed` + `asset_id_invalid`(= **こちらの都合で失敗した**群)
  - 「N 件は上限により省きました」= `image_limit_exceeded` + `deadline_excluded`(= **仕様上の打ち切り**群)
  - 内訳コードは `<details>` か開発者向け表示に留める(運用調査は `result_summary` を直接引ける)
- result page は現在 `cards` 行しか読まないので、`upload_operations.result_summary` を読む query を 1 本足す必要がある。**doc → operation の引き方**(`sourceDocumentId` から最新 op)を決める必要あり — ここは未確認事項(下記 §7-1)

**A-2(中・要仕様判断): card の理由別を出す。producer 変更が要る。**

- `normalizePreparedCard` の返り値を `card: null` → `{ card: null, reason: 'malformed' | 'invalid' | 'duplicate_id' }` にし、`normalize-prepared` で tally する
- `prepared-schema` の `cardsExcluded: number` → `cardsExcludedBy: { … }` へ(`cardsExcluded` は互換のため合計として残す案も可)
- **V2 を切る必要は無い**と考える(§1 の表: payload は同一 invocation 内で消費されるため cross-version read が構造的に起きない)。ただし §9 の「V1 を 7 日残す」運用ルールは spec 本文に残っているので、**ルールごと更新するのが正しい**(黙って破らない)
- ユーザーに出すかは別問題。「11 問中 2 問は読み取れませんでした」は意味があるが、内訳(構造破損 / 検証 fail / id 重複)は**ユーザーには無意味**。**内訳は運用向け、ユーザーには N/M だけ**を推す

### 提案 B — EXIF≠1 の除外

- **判定は source 単位。figure 単位ではない。** EXIF は 1 画像に 1 つで、figure は画像の部分領域だから、figure ごとに向きが違うことはありえない
- **判定箇所 = `verifyImageBytes`(`source-image-verify.ts`)の `metadata()` 直後**。既に metadata を読んでいるので追加 I/O ゼロ。ここは decode 検証の単一点で、1 invocation 経路の全画像が必ず通る
- **段階**: OCR に送る**前**。Gemini 送信前に分かるので、当該 source の figure 検出結果を後から捨てるのでなく、最初から「この source は figure 対象外」と決められる
- **挙動**: text 抽出は継続(spec §4.5 のまま)。当該 source 由来の figure は全て除外し `向き未対応` として計上
- **`logger.warn`(PII-free・operationId + orientation 値のみ)を必ず出す** — これが本命。前提破綻の唯一の通知手段(`rotation` 列が無くなったため)
- **schema**: `figureExclusionTalliesSchema` に `orientation_unsupported` を追加。normalize 時の 4 区分と同じ層に置く…が、**判定は normalize より前(decode 時)**なので、tallies の合流点を決める必要がある(下記 §7-2)

### 提案 C — silent に減らさない形

現状 UI は「✅ 11 問」しか出さず、除外は完全に silent。提案 A-1 だけでも「図版 K 件取り込み / N 件除外」が出るので **silent zero は解消する**。card 側は A-2 まで待たずとも `cardsTotal` と `cardsExtracted` の差で「M 問中 N 問」は**今すぐ出せる**(集計は既にある)。

**推奨 = A-1 + card の N/M 提示を 1 task、B を別 task。**

### 提案 D — task 分割

| task | 内容 | 規模 | 依存 |
|---|---|---|---|
| **T16-a** | result page に result_summary を読む経路 + card N/M + 図版 3 束の提示 | 小〜中(UI + query 1 本・producer 不変) | なし |
| **T16-b** | EXIF≠1 検出 + `orientation_unsupported` 計上 + warn | 小(判定 1 箇所 + schema 1 key + tallies 合流) | schema key を足すので T16-a の表示と同 sprint が望ましいが独立可 |
| **T16-c**(任意) | card 除外理由の producer 化(`normalize-prepared` 改変) | 中(凍結 file の改変 = 仕様判断) | A-2 を採る場合のみ |

**1 task には収まらない**と判断する。理由 = (a) T16-a は表示のみで producer 不変、T16-b は**凍結 file(`prepared-schema`)への key 追加**を含み承認の性質が違う (b) T16-c は S-2 で「無改変」と決めた file を触る仕様変更で、OT 判断が要る。

**採用順ソート**(plan の T16 制約に含まれる)は**本提案から外すことを推奨**。現状 `capImagesToSchemaLimit` は payload 出現順で truncate しており、決定性は payload の順序に依存する。仕様どおり `y_min`/`x_min` で並べるのは独立した挙動変更で、除外理由の提示とも回転除外とも関係がない。別 task 起票が妥当。

---

## 6. 提案しないこと(理由付き)

- **exam 詳細への件数表示** — 取り込みの内訳は upload の結果であり exam の属性ではない。②-4a は「件数提示まで」(spec §13)
- **理由コードの生表示**(`crop_failed` 等をそのまま) — ユーザーに意味がない。畳んだ言い方に落とす
- **`rotation` 相当を DB 列で持つ** — 0032 で予約列ごと消えており、復活は表の再設計になる。payload + log で足りる
- **exp7(回転 JPEG の座標裏取り)の実施** — spec §16 が「実装前 gate にしない」と決めており、除外を**外す**ための材料。除外を**入れる**本 task の前提ではない

---

## 7. 未確認 / OT 判断が要る点

1. **result page から `result_summary` をどう引くか未確認。** result page は `sourceDocumentId` で引いており、`upload_operations` は `source_document_id` を持つ(nullable)。1 doc に複数 op が並ぶ状況(supersede 後の再 submit など)で「どの op の summary を出すか」の規則が未定。**最新 1 件で足りるかは要確認**
2. **`orientation_unsupported` の計上経路が未確定。** 判定は decode 時(`verifyImageBytes` 付近)で、既存の `figuresExcluded` は normalize と crop の 2 層で組み立てられている。decode 時の tally をどこで合流させるか(pipeline が持ち回るか、normalize に渡すか)は実装時の設計判断
3. **`prepared-schema` / `normalize-prepared` の「凍結」を解くかは OT 判断。** T16-b は schema に 1 key、T16-c は normalize の返り値を変える
4. **spec §9 の「V1 を最大 retry 保持期間(7 日)以上残す」ルールは前提が消えている**(resume 撤去 + payload は同一 invocation 内消費)。schema を触る前にこのルール自体を更新すべきか、OT 判断
5. **EXIF≠1 が実際に到達しうる経路の有無**は「現状のコードでは無い」までしか言えない。client 圧縮の将来変更を検出する仕組み(= T16-b の warn)がそのまま答えになる
