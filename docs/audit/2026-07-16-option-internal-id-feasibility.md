# CardOption 内部 id(A')成立可否 fact-finding

- **日付**: 2026-07-16
- **性質**: read-only 調査のみ(W3 未 commit diff 非接触)。Sprint I W3 escalate の判断材料。
- **調査対象**: HEAD `4cdf8b1` + working tree(W3 diff は gallery target `option:<id>` の新設 consumer として参照)。
- **問い**: `CardOption.id`(a/b/c・ユーザー編集可・表示ラベル兼務)と別に**内部 id(UUID・不変・不可視)**を導入し、画像紐付けを内部 id に切替できるか(= rename/blank-text 孤児化の根本解)。

## 1. `CardOption.id` の全参照分類(file:line)

### identity(同一性)として使用

| # | 箇所 | 内容 |
|---|---|---|
| I-1 | `lib/db/schema.ts:621` `answer_events.selected_answer_ids`(jsonb)/ `lib/client-db.ts:165` | 回答履歴に **option id を永続保存**。書込元 = `session-runner.tsx:292`(`[...selectedIds]` = `opt.id` 集合) |
| I-2 | `lib/reviews/domain/session-aggregate.ts:96-117` `admitEvents` + `lib/reviews/ingest-review-events.ts:3,49` | **A-2 存在検証**: selected_answer_ids の全 id が「ingest 時点の現 options」Set に実在するか。欠ければ rejected |
| I-3 | `lib/cards/domain/card-rules.ts:46` `deriveCorrectAnswerIds` | `correct_answer_ids` = is_correct な option の **id 配列**(cards 列に保存・`mutation-schemas.ts:55` server 再生成) |
| I-4 | `session-runner.tsx:209` `equalSet(selectedIds, correctIds)` | 正誤判定。**同時点・同 card 内で自己整合**(選択と正解が同じ id 空間) |
| I-5 | `use-card-options.ts:165,168` ghost merge | editor working-set の server/local diff key(`serverIds.has(o.id)`) |
| I-6 | **W3 diff(未 commit)** `inline-option-row.tsx:119` / `use-card-options.ts:81`(W1 cascade) | gallery target / cascade target = `option:<id>` — **今回の問題の当事者** |

### 表示ラベルとして使用

| # | 箇所 | 内容 |
|---|---|---|
| L-1 | `inline-option-row.tsx`(正解サマリ `correctIds.join(', ')`)/ `session-runner.tsx:472`(`{opt.id}` 表示) | 「○ 正解: a, b」等の画面露出 |
| L-2 | `InlineOptionCell kind="id"`(編集 cell)| **id はユーザー編集可**(rename の入口) |
| L-3 | `session-runner.tsx:96-102` `stripPrefix` | opt.text 先頭の id prefix 除去(文字列一致) |
| L-4 | `ocr-extract.ts:229`(採番規則 "a","b","c".../"1","2"... 昇順)+ `:126-127`(images target `option_{id}` — legacy 非 UUID 語彙・refs 外)| OCR は**表示ラベルを採番** |
| L-5 | `lib/cards/next-option-id.ts` | a/b/c・1/2/3・opt-N の**表示ラベル採番**(削除済 id を再利用 = 破損ベクタの片翼) |
| L-6 | `scripts/seed-perf-exam.ts:517-520` | seed は `opt-${i}-${j}` 形式 |

### その他の事実

- **順序**: options の表示順は**配列順**(`options.sort` 等の id 依存 sort は repo に無し)。
- **mutation**: options は **whole-set replace**(`update_field options` = 配列全体・`card-field-handlers.ts:147-162` handleOptions)。option 単位の mutation identity は存在しない(= id は sync の同一性に使われていない)。
- **`option:` prefix の parse consumer** = 3 箇所のみ: validation regex(`card.ts:116`)/ W3 gallery(`inline-option-row.tsx:119`)/ W1 cascade(`use-card-options.ts:81`)。prefix から id を「取り出して」使う consumer は無し(全て構築側)。
- **DDL**: options は cards.options **jsonb** — CardOption 形状変更に **migration 不要**。
- validation: `optionSchema.id` = `z.string().min(1)`(`card.ts:15`)+ `optionsSchema` id 一意 refine(`:69`)。

## 2. (A') 成否判断

### 結論: **agree(成立する)**。ただし範囲は (A'-min) で切るべき

**(A'-min)**: `CardOption` に `uid`(UUID v4・不変・不可視)を追加し、**画像 target のみ** `option:<uid>` に切替。`selected_answer_ids` / `correct_answer_ids` / 正解サマリ / OCR 採番は**表示 id のまま不変**。

- **rename(a→b)**: ラベル変更のみ・uid 不変 → 画像は自動追随。**「rename か delete+add か」の判別問題そのものが消滅**(claude.ai 仮説に agree: 現データにこの判別情報は存在せず、(A) の migrate はヒューリスティック — editor の同一 cell 操作文脈でしか判別できず、commit payload / pull-back レベルでは原理的に判別不能)。
- **blank-text 除去 / delete**: uid ごと消える。画像は孤児化するが **UUID は再利用されない → mis-attach(破損)が構造的に消滅**。残るは storage リーク(GC は ref 存在で保持 = 安全側)のみで、set-diff cascade **1 機構**(「配列から消えた uid の掃除」)で衛生的に回収できる。cascade が失敗しても**破損しない**(W1 の decouple 懸念も軽くなる)。
- 学習系(I-1〜I-4)は**不変** — 回答履歴は表示 id のままで自己整合(I-4 は同時点判定・I-2 は ingest 時点照合)。rename → 回答履歴の意味変化は pre-existing の別問題(画像と無関係・本 sprint 外)。
- I-5(ghost merge)は表示 id のままで既存挙動不変(optionsSchema の id 一意が保たれる限り)。

**(A'-full)**(selected_answer_ids も uid 化)は **disagree(不採用 lean)**: blast radius が学習系全域(session-runner / review-events / ingest / session-aggregate / FSRS 集計)へ拡大し、解く問題(画像孤児)と無関係。YAGNI。

## 3. (A'-min) の blast radius

| 変更点 | file | 内容 |
|---|---|---|
| 型 | `lib/db/schema.ts`(CardOption)/ `lib/client-db.ts`(ClientCardOption)| `uid: string` 追加。**DDL/migration 不要**(jsonb) |
| validation | `lib/validation/card.ts` | `optionSchema.uid: z.uuid()` + uid 一意 refine。`imageEntrySchema` の `/^option:.+/` は**そのまま uid にも match**(変更不要) |
| OCR 経路 | `app/(app)/app/upload/_actions/process.ts:373`(写像点)| **server 後処理で `crypto.randomUUID()` を mint**。OCR prompt / response schema は不変(LLM に UUID を吐かせない) |
| 新規 card | `lib/cards/empty-card.ts:29` | 既定 option に uid |
| add 採番 | `use-card-options.ts` handleAddOption | uid mint(`newId()`)。`nextOptionId` は**表示ラベル採番に降格**(変更不要・責務名のみ) |
| cascade | `use-card-options.ts`(W1 実装済 + W3)| target を uid 化 + **set-diff 化**(delete/blank-text 両対応の単一機構)。= W1 [reviewed] 済コードの改修 commit |
| gallery | W3 diff 2 行 | `target={'option:' + opt.uid}`(attachAriaLabel は表示 id のまま) |
| server handler | `lib/cards/card-field-handlers.ts` handleOptions | `uid: o.uid` 透過(camel/snake 詰め替えに 1 field)+ `card-write.ts` / `mutation-schemas.ts` は共有 schema 経由で追随 |
| seed | `scripts/seed-perf-exam.ts` | option に uid 追加 + **stg 再 seed が必要**(下記) |

**既存データの扱い(唯一の運用注意)**: prod = zero-user(空・OT 前提)。**stg PERF-SEED は uid 無し options** → `optionSchema.uid` を必須にすると既存 card の options 編集が reject される。対処 = **stg 再 seed**(clean・zero-user 前提と整合)。uid optional + lazy 付与は複雑化ゆえ非推奨。
**不明**: stg に answer_events 実データが存在するか(DB 未クエリ)。ただし (A'-min) は selected_answer_ids に触れないため影響なし。

## 4. (A) vs (A') コスト比較・CC lean

| | (A) migrate + set-diff | (A'-min) uid |
|---|---|---|
| rename 対応 | **ヒューリスティック**(hook 内の同一 cell 操作文脈で擬似判別・payload レベルでは判別不能・blur/ghost との edge 多)| **概念ごと消滅**(uid 不変) |
| 破損(mis-attach)| cascade 失敗時に window 残存 | **構造的に消滅**(UUID 非再利用) |
| cascade の性格 | 正確性機構(失敗 = 破損リスク)| 衛生機構(失敗 = リークのみ・安全) |
| 変更規模 | hook 中心 ~3 file だが脆い | ~8 file + seed + W3 2 行。機構は 1 個減 |
| データ形 | 不変 | CardOption に uid(zero-user ゆえ自由・spec §2 の想定内) |

**CC lean = (A'-min)**。(A) は「データに無い情報をヒューリスティックで補う」、(A') は「情報を持たせる」。破損クラスを構造的に消す後者が本質的で、簡潔性規律にも合う(機構数減)。

## 5. 判断が要る点

1. **(A'-min) の採否**(vs (A) / (C))。
2. 採用時: **W1 [reviewed] 済 cascade の uid 化 + set-diff 化**を新 task(W5)として spec §3 改訂 + plan 追補で起こす手続き。
3. **stg 再 seed** の実施タイミング(uid 必須 validation の deploy と同期)。
4. OCR mint の置き場所確定(process.ts 写像点 = CC lean・ocr.ts 内でも可)。
