# Order-1 — base_order 導入 + question_label 転換 実装 session(2026-08-14)

- spec: `docs/superpowers/specs/2026-08-14-order-1-base-order-design.md`(**r3**・凍結)
- plan: `docs/superpowers/plans/2026-08-14-order-1-base-order.md`(r2 + deploy 手順 1 行訂正)
- commit range: `dd9956d..01f96b9`(feat 2 / test 1 / docs 4)
- 状態: **実装完了・未 push**。次 = OT 報告確認 → cards 件数確認 → stg migration 0037 → push / deploy → smoke。

## 1. 完了 gate(全 exit 0)

| gate | 結果 |
|---|---|
| `pnpm lint`(whole-repo `--max-warnings=0`)| **exit 0 確認済** |
| `pnpm typecheck` | exit 0 |
| `pnpm build`(postbuild の pdfium wasm packaging 検証込み)| exit 0 / PASS |
| `pnpm test` | **4777 passed (277 files)** |
| `pnpm test:iso` | **green 確認済 — 428 passed (36 files)** |
| `pnpm run audit` | **exit 0 確認済**(prod high/critical 0)|

依存 / Next 設定 file は不触のため、`--frozen-lockfile` 系の追加 gate は対象外。

## 2. task 別の結果

| task | commit | review |
|---|---|---|
| 1. 順序 domain(pure・5 export + 24 unit)| `7be41b5` | canonical Crit0/Imp0/Minor2 + Codex Crit0/Imp0/Minor0 |
| 2. migration 0037 + 全層 rename + 採番配線(96 file)| `d7d2b4f` | canonical Crit1/Imp2/Minor5 → **fix round 1 で Crit0/Imp0 収束**(scoped re-review が red 実証を独立再現)+ Codex P1 1 件は裁定で不適用 |
| 3. 順序契約の新規 pin 4 本(test-only・保証の増)| `01f96b9` | 簡易 review Crit0/Imp3/Minor6 → 全件反映。red 検証 5 変異 |
| 4. 完了 gate + 本 doc | — | `[no-review]` |

## 3. migration 0037 の実測(spec §3 との照合)

生成 SQL は spec §3 と**完全一致**:

```sql
ALTER TABLE "cards" RENAME COLUMN "sort_key" TO "question_label";
DROP INDEX "cards_sort_idx";
ALTER TABLE "cards" ADD COLUMN "base_order" integer NOT NULL;
CREATE INDEX "cards_order_idx" ON "cards" USING btree ("user_id","exam_id","base_order","id");
ALTER TABLE "cards" ADD CONSTRAINT "cards_base_order_positive" CHECK ("cards"."base_order" >= 1);
```

- **RENAME 形式**(DROP+ADD ではない)/ `base_order` に **DB default なし** / CHECK / 旧 index DROP / 新 index の列順、すべて意図どおり。
- **drizzle-kit の rename 判定は対話 prompt(TTY 必須)**で、非対話実行では `Error: Interactive prompts require a TTY terminal` で落ちる。`script -qec` で pty を割り当て、`~ sort_key › question_label rename column` を選択して生成した(brief の「非対話で崩れたら OT 相談」は発火せず、TTY 割当で解決)。**次に列 rename を伴う migration を作る人はこの手順を使うこと。**

## 4. 実装中に spec を訂正した 1 件(r2 → r3)

**§4.1 のみ**。r2 は「SSR SELECT に `baseOrder` を追加しない(行内で base_order を読む UI が無い — YAGNI)」としていたが、**その理由が実測で偽**だった。

- 手動追加の末尾採番は「画面上の行が持つ順序列」を読む。Dexie mirror 未 hydrate の窓では `liveData` が undefined で SSR fallback(`initialCards` = `ExamDetailCard`)に落ち、base_order が無いと max 不明のまま stride 先頭(1024)に採番されて既存カードと衝突する。
- **実証**: 追加 test を click 前に 50ms 待つ形へ一時改変 → pass(2048)/ 待たない現行 → fail(1024)。
- 旧実装は `ExamDetailCard.sortKey` を持っていたため fallback でも正しく採番できており、**非退行条件**に該当した。
- OT 承認の上で r3 として訂正(commit `0efd623`)。`getCardsForSourceDocument`(`CardListEntry`)は採番の読み手ではないため**変更していない**。

## 5. plan からの逸脱(known-good・1 件)

**plan 57 行目「OCR golden は `mock-exam-page1.expected-cards.json` のみ rename」は誤りで、実装は rename していない。これが正しい。**

- この fixture は `lib/ai/ocr-golden.test.ts:50` が `parseOcrResponse`(`lib/ai/ocr.ts`)に通した出力を pin するもので、**wire 層(`ExtractedCard`)の golden**。spec D-8 の「Gemini wire の field 名 `sort_key` は不変」の側に属する。rename すると golden test が壊れる。
- 完了条件の「rename 残存 re-grep でゼロ件」に対しこの file が hit として残るのは**意図どおり**。「spec からの逸脱ゼロ」の主張と grep 証拠が矛盾して見えないよう、ここに記録する。

## 6. Codex P1 の裁定(不適用)

Codex 独立レビューが **P1: 「既存行がある DB では `ADD COLUMN base_order integer NOT NULL`(default / backfill なし)が失敗するので deploy できない。nullable → backfill → NOT NULL にせよ」** を出した。**適用しない**と裁定した。

- PG の挙動記述としては正しいが、結論「blocks deployment」は「cards に行がある」前提に依存し、本 sprint ではその前提が偽。
- spec §3.1 が**この挙動をそのまま予期して受容**している(「空テーブル前提(OT 確定 7)。行が残る DB では loud fail — 対処は operator が truncate。**backfill 経路は作らない**」)。§9 も expand-contract 不採用を意図的制約として明記。backfill 化は **spec 変更 = OT 裁定事項**。Codex は anchor 防止のため spec を見ない設計で、この前提を知らない。
- **前提の実測再確認**: 当日午前の調査時点で stg にあった 368 cards / 5 exams(user `85541b25…`)は**現在 0 / 0**。非 RLS 表 `contact_messages` も 0 件。
- **ただし「表が全体として空」は app role では原理的に確認できない**(`cards` は RLS 対象 = tenant 単位でしか数えられない)。残余リスクは **deploy 直前の owner 接続での件数確認**で閉じる。
- **副産物**: この裁定の過程で **plan の deploy 手順に事実誤り**が見つかった(「件数確認は CC が app role で代行可」)。上記のとおり不可能なので「OT の owner 接続でしか行えない」に訂正した。Codex P1 は結果として、実行不能な guard を実行可能な形に直させた点で価値があった。

## 7. 教訓(次に同種の作業をする人へ)

1. **機械的一括 rename は「型が守る範囲」と「守らない範囲」を分けて扱う。** 本 sprint で一括置換の事故を 3 回捕捉した:
   - tag entity(`tag_categories` / `tag_options`)の `sort_key` を 40 行巻き込み → typechecker の `Partial<ClientTagCategory>` エラーを正として行単位で revert。
   - `normalize-prepared.test.ts` の **raw wire fixture** を rename → 継ぎ目 test の fail で検出。
   - **`base_order` の一括挿入 script が production の mapper(`toExamDetailCard`)にも当たり定数返しを埋め込んだ** → canonical review が Critical として検出。**型検査も既存 test も通ってしまった**のが最も危険な点。
   → 一括置換の後は「型が守らない場所」(JSON fixture / 自前 fake / cast 越しの literal / wire literal / **production の同名 field を持つ mapper**)を名指しで再監査すること。
2. **fixture の同値化は空振り test を作る。** `base_order` を全件 1024 で埋めた結果、mapper が定数を返していても末尾採番の assert が同じ値で通った。さらに**非同値化だけでは足りず**、SSR fallback 経路が正解を出してしまうため「live 経路を強制する pin」(mirror 専用カードの描画を待ってから操作)が必要だった。
3. **列 rename を伴う drizzle migration は TTY が要る**(§3 の手順)。
4. **「ここでしか押さえられない」と書く前に実測する。** 一致 iso の冒頭に「localeCompare に変えたら崩れる」と書いたが、小文字 canonical UUID では ICU 照合順が素比較と一致するため**この iso は検出しない**(5000 件で再現確認)。`lesson_single_point_claims_decay` の型そのものだった。

## 8. Grid-3 への handoff(次 sprint の必須検討事項)

1. **並走再採番・移動の収束意味論**: 部分適用でも全順序が成立することは spec §2.3-3 が保証するが、複数端末の再採番/移動が競合したとき「**意図した順に収束する**」保証は無い。Order-1 は決定性までしか約束していない。
2. **`getCardsForSourceDocument` の単一 exam 前提が崩れる**: 現在この関数の `ORDER BY base_order, id` は「1 source_document の cards は 1 exam に閉じる」前提の上でのみ意味を持つ(publish が単一 exam へ INSERT / 移動経路なし)。**exam 間移動を入れた時点で order 定義の再裁定が要る**(`lib/exams/list.ts` の当該コメント参照)。
3. **`base_order` の update_field handler 追加時の契約**: spec §2.4 — handler は `z.number().int().min(1)` で検証し他列を触らない。決定 6(ラベル編集で行が動かない)の pin と対称に、移動 op が **question_label を触らない**ことも pin すること。
4. **再採番の wire 形の採否**: spec §2.3-3 は計算式と安全性質までを凍結し、per-card update_field N 件 / 専用 op のどちらにするかは **Grid-3 の設計判断**として開けてある。新 op を作る場合は entity_mutations の CHECK + registry + migration 同時更新規約(`lib/db/schema.ts` の該当コメント)に従うこと。
5. **`cards_order_idx` は exam_id 等価を前提にした複合 index**。移動で exam を跨ぐ query が増えるなら index 設計を再検討する。

## 9. 次の手順(OT)

1. **cards 件数確認(owner 接続)** → 非ゼロなら中止。
2. stg へ `DATABASE_URL_ADMIN='...' pnpm db:migrate`(migrate 先行 → deploy の順)。
3. push → stg deploy。deploy が失敗した場合は **forward-fix 一択**(旧 code へは戻せない — 新 schema に 23502 で書けないため)。
4. CC smoke(plan の Deploy 節 ①〜⑧)。⑧ の account 作成 / checkout 完了操作は OT、sign-in 以降と DB readback は CC。
