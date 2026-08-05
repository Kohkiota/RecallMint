# ②-4a T16-b: EXIF≠1 の検知(2026-08-05)

fact-finding = `docs/audit/2026-08-05-ocr-2-4a-t16-factfinding.md`
前段 = `docs/superpowers/sessions/2026-08-05-ocr-2-4a-t16a-exclusion-display.md`
Codex raw = `docs/codex/2026-08-05-t16b-exif-orientation-detection.md`(r1)/ `-r2.md`(r2 clean)

---

## 1. 位置づけ(見失うと負債になる)

**これは「ユーザーのための除外」ではなく「前提破綻の検知」である。**

client は画像を**無条件に** canvas 再エンコードする(`upload-form.tsx:207-218`・review が実コードで確認)ため、
**EXIF≠1 は現行 UI 経路では server に到達しない**。つまり**通常は絶対に発火しない機構**を意図的に作った。

作る理由は、client を経由しない経路(将来の API 直叩き / ②-4b の PDF / client 改修ミス)で到達したとき、
それが**前提が破れた合図**だから。`source_assets.rotation` 予約列は migration 0032 で消えており、
他に知る手段がない。

**本命は `logger.warn`。ユーザー向けの除外表示は副次。** コードのコメントにも同じ優先順位を書いた。
本 sprint の S-2 で「時間予算のチェックが、絶対に発火しない位置にあった」失敗を踏んでいる —
今回は**発火しないこと自体が想定内**だが、それを書き残さないと同型の負債になる。

---

## 2. 実装

### 判定

- **単位 = source**(EXIF は 1 画像 1 つ。figure は部分領域なので figure 単位はありえない)
- **位置 = `_lib/source-image-verify.ts` の `verifyImageBytes` の `metadata()` 直後**。既に読んでいるので**追加 I/O ゼロ**
- **条件は「1 でない」ではなく「1 でも `undefined` でもない」**。sharp の `metadata().orientation` は
  EXIF 非搭載なら `undefined` を返すため、「1 でない」を異常にすると**全 PNG が誤検知**になる
  (red 実証の変異 2 で既存 crop suite が総崩れになり、実害がそのまま可視化された)
- **`logger.warn` は pipeline の decode ループ**(`operationId` を持つ層)。context は
  `{ event, operationId, orientation }` **のみ** — filename / bytes / payload を入れない(PII-free 規律)。
  review が「`not.toContain('b.png')` の PII assert が空振りでない」ことまで確認済
- decode 自体は失敗させない。**text 抽出は継続**する

### 除外の効かせ方(凍結 file を 1 つも触らない形にできた)

`figureExclusionTalliesSchema`(`lib/ocr/prepared-schema.ts` の 4 key)は **normalize 時**の tally。
orientation は **decode 時に判明し attach 時に効く**ので、`crop_failed` / `deadline_excluded` と
**同じ層** = `publish-prepared-plan.ts` の `FigureExclusionCounts` に置いた。

結果、**`lib/ocr/prepared-schema.ts` と `lib/ocr/normalize-prepared.ts` は無変更**(review が
`git diff --stat HEAD -- lib/ocr/` の空で機械確認)。prompt も無変更。

- `FigureDisposition` union に `orientation_unsupported` を追加
- **`planPublish` の優先順位判定(`not_ours` → `retryable`)には影響させない** — publish を止めない
- crop ループで、当該 source の figure は **`cropFigureFromBuffer` を呼ばずに** disposition を割り当てる

### spec 文言との差(黙って残さない)

spec §4.5 は「EXIF≠1 の source は**図版検出をスキップ**」と書いているが、prompt は凍結でありテキスト
抽出のため画像は Gemini に送る。**実際に実現したのは「検出はされるが attach しない」**。
この差はコード内コメントと本 doc に明記した(spec 文言自体は未修正 = 別 task)。

### 束の帰属 = 「取り込めませんでした」(OT 決定)

理由 = **「上限のため」は嘘になる**。こちらが上限を決めて打ち切ったのではなく、扱えなかったから。
回転が入力側の性質なのは事実だが、ユーザーから見れば「上げた画像が使われなかった」であり、
原因の帰属より扱えなかったことが伝わるべき。仕様上の打ち切りと混ぜると除外の意味が薄まる。

---

## 3. spec §9 の V1/V2 ルールを置換した

旧文:

> 将来 schema 変更は **V1 を書き換えず V2 追加**、旧 schema は **最大 retry 保持期間(7 日・§11)以上残す**
> (旧デプロイ保存 payload を新 publisher が reject しないため)

これは **payload が別 invocation に跨いで読まれる前提**のルール。1 invocation 化(S-1〜S-5)で resume が
撤去され、`prepared_payload` は**同一 invocation 内で commit → 数秒後に消費**される。
**cross-version read が構造的に起きない**ため前提が消えていた。ルールごと置換した(注記を足していない)。

**裏取り(review が独立に実施)**: `preparedPayloadSchema.parse()` の呼出は **1 箇所だけ**
(`stage-prepared-payload.ts:30` = 組み立て時)。repo 内に `prepared_payload` を **SELECT する箇所は
存在しない**。in-memory の payload が `upload-pipeline.ts` から crop/publish へ直接流れる。

**注記**: 上記 §2 の設計では payload schema を触らないため、このルールは今回そもそも抵触しなかった。
更新したのは**前提が事実として古いから**であって、今回の変更を通すためではない。

同 doc §5.4 が「publisher は**保存済み** payload を parse する」と書いたままで、§9 の書き換えが
**同じ doc 内に自己矛盾を作っていた**ため併せて訂正した(canonical Minor-1)。
凍結 file(`normalize-prepared.ts:249-250` と test:855)にも同じ「保存済み」表現が残っているが、
**凍結ゆえ触らず follow-up** とした(canonical Minor-2)。

---

## 4. 後方互換 — 読み手 schema の `.default(0)`(controller 裁定)

実装者が **escalate** した(独断で緩めなかったのは正しい): 新 key を必須にすると、**本 deploy 前に
書かれた `result_summary`(7 キー)が parse に落ち、過去 doc の result page から内訳ブロックが
丸ごと消える**。stg には completed doc が多数ある。これは T16-a が解消した「silent zero」を
**別の形で再発させる**。

**裁定 = 新 key のみ `.default(0)`。既存 7 キーは必須のまま。**

- **`.default(0)` が嘘にならない根拠**: 旧 deploy には検知機構自体が存在せず、**旧行の実値は
  証明可能に 0**。推定で埋めるのではなく、機構が無かった事実から確定する。
- **drift pin は弱まらない**: pin が見ているのは「読み手が各 producer key をちょうど 1 束に
  入れているか」であって zod の required/optional ではない。**producer にだけ key を足すと
  pin は赤くなる**ことを red 実証(変異 B)で確認した。**runtime は寛容・CI は厳格**。
- **sunset 条件**をコメントに残した(deploy 前に書かれた行が出尽くしたら必須へ戻せる)。

---

## 5. Codex が canonical と controller の取り違えを捕まえた(dual-review の実例)

**Codex r1 = Important(P2) 1 件**: crop ループで**予算枯渇の判定が orientation より先**にあり、
予算が既に枯渇していると回転 source の figure が `deadline_excluded` に計上される —
つまり**「上限のため省略しました」と表示される**。

**canonical はここを Minor-3 として記録のみとし、controller(私)も「現状維持」と裁定していた。**
根拠は「warn は decode 段で必ず出るので**検知**は落ちない」だった。

**それは争点の取り違えだった。** Codex が指摘したのは**検知**ではなく**計上の正しさ**:

- orientation は **crop phase より前に判明**しており、それらの figure は**そもそも crop され得なかった**。
  時間切れのせいにするのは**事実として誤り**。
- そして OT が束を「取り込めませんでした」に決めた理由は**まさに「上限のため」が嘘になるから**。
  この順序は**その嘘を corner case で復活させていた**。
- 「稀だから」は本 task では通らない — **機構全体が rare path の検知**であり、稀であることは
  受容の理由にならない。

**裁定を覆して修正した**。判定順を `① 予算 → ② source → ③ orientation` から
**`① source → ② orientation → ③ 予算`** へ。

**不変条件の確認**: 「予算は一度枯渇したら揺り戻さない(un-latch しない)」は壊れない。
`budgetExhausted` は 1 箇所でしか書かれず false へ戻す代入が存在しない。orientation の `continue` で
latch 評価を飛ばす figure は生まれるが、枯渇判定は時間について単調ゆえ skip しても後続は
「同じかより枯渇した側」しか得ない。かつ **crop 実行の直前には必ず latch 評価が入る**順序を保っており、
「予算切れなのに crop を始める」経路は生まれない。

**red 実証**: 判定順を元に戻す変異 → 新設 pin が fail(`expected +0 to be 1`)。同じ変異下で
**既存の deadline test は green** = 順序変更が既存の保証を壊していないことの実証。

---

## 6. red 実証(全て 1 箇所ずつ・T16-a §2 の教訓を適用)

| # | 変異 | 落ちたもの |
|---|---|---|
| 1 | orientation 判定を外す | 検知 test |
| 2 | `undefined` も異常扱いにする | **既存 crop suite が総崩れ**(全 PNG 誤検知の実害) |
| 3 | crop skip を外す | 「crop が呼ばれない」test **のみ**(warn test は green = 別々に pin) |
| 4 | 失敗束から key を落とす | 束合流 test **のみ**(drift pin は green = 束の帰属だけ) |
| 5 | producer にだけ key を足す | **drift pin のみ** |
| A | `.default(0)` を必須へ戻す | 後方互換 test |
| B | producer にだけ架空 key | **drift pin のみ**(`.default(0)` 後も pin が生存) |
| C | 判定順を元に戻す | 判定順 pin のみ(既存 deadline test は green) |

canonical reviewer が 7 種を scratch copy で**独立に再実行**し、まとめ変異での代用が無いこと・
落ちた test が狙ったものであることを確認した。

---

## 7. gate(controller 実走)

| gate | 結果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm lint --max-warnings=0` | **0** |
| `pnpm build` | **0** |
| `pnpm test` | **0** — 272 files / **4,428 tests** |
| `pnpm test:iso` | **0** — 30 files / 316 tests |
| `pnpm run audit` | **1** — 上流 advisory・**依存 1 行も変更なし**ゆえ本 task 起因でない(brief で blocker 外) |

review 経過: canonical = spec ✅ / Ready to merge / Critical 0 / Important 0 / Minor 5 →
fix で 3 件対処・2 件記録。Codex = r1 **Important 1** → fix → **r2 clean**。

---

## 8. whole-branch review に持ち越す不明 / follow-up

1. **stg smoke 未実施**(push 前)。本機構は**通常経路では発火しない**ため、stg で「何も起きないこと」
   しか確認できない。**発火側の実機確認には client を経由しない投入経路が要る**が、現状それが無い
   (= iso の実 EXIF=6 JPEG が唯一の実証手段)。
2. **spec §4.5 の文言**(「図版検出をスキップ」)が実装(「検出はされるが attach しない」)と差がある。
   コメントと本 doc に明記済だが spec 自体は未修正 — 別 task。
3. **凍結 file の「保存済み payload」表現**(`normalize-prepared.ts:249-250` / test:855)。
   §3 の訂正と同じ follow-up。
4. `.default(0)` の **sunset**(旧行が出尽くしたら必須へ戻す)は条件だけ記録した状態。
5. **予算枯渇と orientation 以外の判定順**は見直していない。今回覆したのは 1 箇所のみ。
