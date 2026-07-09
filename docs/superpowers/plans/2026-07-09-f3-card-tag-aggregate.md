# F3: Card + Tag aggregate(薄い DDD)— implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** spec `docs/superpowers/specs/2026-07-09-f3-card-tag-aggregate-design.md`(c2b3bd1 承認済)の実装 — Card/Tag のルール定義を domain へ単一化(server dedup)+ card_count ±N helper 集約 + Tag golden gap 閉じ。**W 無し・G→R 完結**。

**Architecture:** 新 repository を作らない(既存 apply-\* = DbExecutor seam 維持)。lib/cards/domain(card-rules / card-tag-constraint)+ lib/tags/domain(tag-values)+ lib/validation/card.ts 拡張 + lib/cards/card-count.ts。additive → 配線を別 commit(F1/F2 型)。

## Global Constraints(全 task 共通)

- 挙動不変。**R の各 task で golden/snapshot 更新ゼロ**(赤 → 即停止。golden を直して通す行為は禁止。spec §4 divergence checklist〔zod issue path / message / WHERE 述語 / updatedAt / wire shape / tombstone entity_type / skipLog〕に該当したら W 隔離で OT 判断)。
- schema 変更ゼロ・migration 禁止。P0 凍結契約(§A #3/#4/#5/#6/#10)不触。owner-scope WHERE verbatim。エラーメッセージ byte 一致。
- G の期待値 = **現行実挙動**(test を書いたら現 HEAD で実行し PASS を確認してから commit。FAIL したら仕様から推測せず原因調査 — fake 不備か divergence 発見かを切り分け)。
- 各 task 完了 = 対象 test green + full `pnpm test` green + `pnpm lint --max-warnings=0` + `typecheck` exit 0(risk task は snapshot 更新ゼロ確認込み)。commit は [reviewed](canonical + risk task は Codex review。G/R1/R5 も canonical — spec §10 で任意化棄却済)。
- **レビュー dispatch 観点(全 review prompt に含める)**: ① OCR path へ correct_answer_ids 再導出を誤配線していない(判断 5)② tag_category 同名の server 検証を偶然追加していない(spec §7 発見)③ whole-repo lint 実行確認。
- **card-field-handlers.ts を触る commit(R2/R3/R6)**: 必要最小 import 行のみ追加・formatter による import 一括 reorder 禁止。各完了時に `git diff -- lib/cards/card-field-handlers.ts` で hunk が参照事実 C の行域内に収まることを確認(Codex 指摘採用)。
- **SQL fragment の観測粒度 = 構造的観測**(render 文字列 pin 禁止・Codex 指摘採用): set 句捕捉の assert は (a) 参照 column(exams.cardCount / exams.updatedAt 自己参照)(b) 数値 param 値 (c) GREATEST 有無、を sql object の構造から判定。Drizzle の render 差・param 化で割れる文字列比較はしない。
- file:line は HEAD `aafcae7` 基準 — 着手時に必ず re-scan。

## 参照事実(task から参照・再調査不要。plan 主タスク 3 件の確定を含む)

### A. G1 fake 設計 = **applyOcrTags を vi.mock**(kickoff 主タスク 1・確定)

- 根拠: apply-ocr-tags.ts は find-or-create 2 段 × 3 table(SELECT×2-6 + INSERT×0-3・:41-308)。executor fake で通すと fake が本体より複雑化し brittle。G1 の pin 対象は card_count 面のみで tag 分解は無関係。
- 「同 tx」の観測 = **applyOcrTags が saveExtractedCards と同一の tx object で呼ばれること**を mock 引数で assert(`expect(mock.calls[0][0]).toBe(txObject)`)。
- fake db 形: `{ transaction: (cb) => cb(tx) }` + tx = apply-card-mutation.test:255-298 の executor fake 型踏襲。insert(cards).values(rows).returning() → rows を捕捉し `[{id, title}]` を返す / update(exams).set(捕捉).where(捕捉)。
- updatedAt 据え置きと +N は **set 句の捕捉 assert(shape)**: `set.cardCount` の sql fragment に param `cardRows.length` が含まれ、`set.updatedAt` が `exams.updatedAt` 自己参照(`now()` 不在)であること。apply-card-mutation.test の update fake(:286-293)は set 引数を捨てているため、G2 で捕捉に拡張する(既存 assert は不変)。

### B. R3 zod 同値照合表(kickoff 主タスク 2・確定)

**現 test は outcome('applied'/'failed')のみ観測・message/issue path は非 assert**(card-field-handlers.test / contract 両方で確認済)。→ 同値担保は (i) **schema 式を文字通り移動**(合成し直さない・z.object の field に同一 schema object を差すだけ = issue path が構造的に変わらない)+ (ii) 本照合表の机上チェック:

| schema | card-field-handlers(削除側) | mutation-schemas(参照差し替え側) | 一致確認点 |
|---|---|---|---|
| titleSchema | :60-64 | :51-55 | trim→min(1,'タイトルは必須です')→max(200,'…200 文字以内…') |
| sortKeySchema | :66-69 | :56 | max(100,'ソートキーは…')→nullable |
| questionTextSchema | :71-74 | :57-60 | max(10000)→refine(trim>0,'問題文は必須です')の順 |
| explanationTextSchema | :76-79 | :68-71 | max(10000)→nullable |
| memoSchema | :81-84 | :72 | max(10000)→nullable |
| optionsSchema | :86-92 | :61-67 | array(optionSchema)→min(1)→max(50)→refine(id 重複) |

移設先 = lib/validation/card.ts(export 名は既存 `optionSchema` の無 prefix 前例に合わせ同名 6 つ)。R3 の直接の正 = `tests/contract/entity-mutations-bulk.contract.test.ts` + `tests/contract/pull.contract.test.ts` の snapshot 更新ゼロ(spec §7)。

### C. card-field-handlers 3 回接触の行域(kickoff 主タスク 3・確定 — 互いに素)

| commit | 触る行域(現 HEAD) | 内容 |
|---|---|---|
| R2 | :139-141(sort_key)/ :152-154(explanation)/ :159-161(memo)/ :175-179(options 導出) | inline → card-rules import |
| R3 | :57-92(schema 定義 block 削除。:97 tagOptionIdsSchema は残置) | 定義 → validation/card import |
| R6 | :242-253(A-1 集計 + 判定 block) | inline → hasSingleCategoryOverflow |

共通接触 = import block(:18-28)のみ(各 commit で 1 行追加・衝突なし)。**R2→R3→R6 の直列で hunk 干渉なし**。handleOptions は R2 が本体:177-179、R3 が参照先 schema 定義のみ触り、識別子名 `optionsSchema` は不変ゆえ非干渉。

### D. シグネチャ適応 2 件(verbatim からの意図的最小逸脱・挙動同値)

1. `normalizeNullableTextField(field, value)` の value を `string` → `string | null` に widening。server の r.data は nullable schema 通過後 `string | null` であり、null 入力は `value === ''` 不成立で素通し(= 現 server inline `r.data === '' ? null : r.data` と同値)。client 呼び出し(string)は部分型ゆえ無影響。
2. `hasSingleCategoryOverflow(assigned: ReadonlyArray<{categoryId: string}>, categories: ReadonlyArray<{id: string; selectType: SelectType}>)` — spec §3.2 の `{optionId, categoryId}` から optionId を落とす(判定に不使用・YAGNI)。handler の `valid`({id, categoryId})が構造的部分型でそのまま渡る。

### E. client 変更の全列挙(spec §3.6・これ以外の client 変更 = 違反)

session-runner.tsx:206(inline → `deriveCorrectAnswerIds(options)`・handleAnswer 内)/ use-card-options.ts:14(import 先 rewire)/ inline-text-field.tsx:34(同)/ card-write.ts 縮退。inline-card-list.tsx:22(buildNewCardMutationPatch)は**残置 — 触らない**。

---

## Phase G(1 commit: `test(cards): F3 golden 先張り(G1-G5・Tag UNIQUE/cascade 含む)[reviewed]`)

### Task 1: golden 5 本先張り

- [ ] **目的**: R が触る 3 面(card_count / bounds 移設周辺 / Tag apply)の現挙動 pin。spec §5 の G1-G5。
- [ ] **G1**(新設 `app/(app)/app/upload/_actions/upload-persistence.test.ts`): 参照事実 A の設計で saveExtractedCards を pin — ① cards INSERT rows = cardRows(N 件)+ returning zip ② `set.cardCount` fragment に param N(構造的観測 — Global 参照)③ `set.updatedAt` 自己参照(now() 不在)④ where に eq(exams.id)+eq(exams.userId)⑤ applyOcrTags mock が同一 tx object + inserted ids(zip 順)で 1 回呼ばれる ⑥ exams UPDATE が transaction callback に渡した tx 経由で発生(tx identity で観測)。**rollback 経路は G1 対象外**(applyOcrTags mock ゆえ throw 巻込は観測不能 — 非対象と明記・Codex 指摘採用)。
- [ ] **G2**(`lib/cards/apply-card-mutation.test.ts` 追記): 両 describe の update fake を set/where 捕捉に拡張(既存 assert 不変)→ create(+1)/delete(-1)で `set.updatedAt` 自己参照 + `set.cardCount` fragment(+1 は素加算 / -1 は GREATEST)を pin。
- [ ] **G3/G4**(`lib/tags/apply-tag-mutation.test.ts` 追記): create-dup(同 category 同名別 id → 'failed' + INSERT 不発)/ move-dup(category_id 移動先に同名 → 'failed' + UPDATE 不発)。既存 store fake(:87-)へ row を狙って積む型。
- [ ] **G5**(同 file 追記): fake に tombstones INSERT 捕捉を追加 → applyTagCategoryDelete で category 自身 + 配下 option **全件**の tombstone(entityType/entityId)列挙 pin / applyTagOptionDelete で自身 tombstone pin。
- [ ] **完了条件**: 新 test 全て**現 HEAD で PASS**(FAIL = fake 不備 or divergence — 切り分けて報告)。full test green。canonical review(Critical 0 / Important 0)→ commit。

## Phase R — F3a Card(4 commits)

### Task 2: R1 — card-rules 新設(additive)(`refactor(cards): F3-R1 card-rules domain 抽出(additive)[reviewed]`)

- [ ] **目的**: `lib/cards/domain/card-rules.ts` 新設 — card-write.ts から deriveCorrectAnswerIds / NULLABLE_TEXT_FIELDS / normalizeNullableTextField を **verbatim 移動コピー**(widening = 参照事実 D-1 のみ適用)。配線なし(旧定義残置・二重定義は R2 で解消)。
- [ ] **test**: `lib/cards/domain/card-rules.test.ts` 新設(card-write.test.ts:11-35 / :70-の該当 describe を copy・card-write.test 側は R2 で削除)。
- [ ] **制約**: domain 純度(zod / drizzle / next / Dexie / React import なし)。コメントの「なぜ」(mirror ⇄ server 一致の理由書き)を保存。
- [ ] **完了条件**: 新 test green + full green。canonical review → commit。

### Task 3: R2 — card-rules 配線 + card-write 縮退(`refactor(cards): F3-R2 card-rules 配線 + card-write 縮退 [reviewed]`・**risk**)

- [ ] **目的**: 定義の単一化 — **server inline は計 5 箇所**(Codex 指摘採用・内訳明示): apply-card-mutation.ts:83(導出 1)→ `deriveCorrectAnswerIds(options)` / card-field-handlers.ts:139-141, :152-154, :159-161(正規化 3)→ `normalizeNullableTextField('<field>', r.data)` / :175-179(導出 1)→ `deriveCorrectAnswerIds(options)`。client(参照事実 E): session-runner.tsx:206 呼び出し置換 / use-card-options.ts:14・inline-text-field.tsx:34 import rewire。card-write.ts から移動 2 関数 + 定数を削除(buildNewCardMutationPatch 残置・**re-export shim なし**)、card-write.test.ts から移動済 describe を削除。
- [ ] **制約**: OCR path(upload-persistence / apply-ocr-tags)に deriveCorrectAnswerIds を**導入しない**(判断 5)。
- [ ] **完了条件**: golden 更新ゼロ(card-field-handlers.test 57 + apply-card-mutation.test + G1/G2 + contract 全 green・snapshot 更新ゼロ)。rg で `card-write` からの旧シンボル import 残存ゼロ。canonical + Codex review → commit。

### Task 4: R3 — bounds 集約(`refactor(cards): F3-R3 field bounds を validation/card に集約 [reviewed]`・**risk**)

- [ ] **目的**: 参照事実 B の照合表どおり 6 schema を lib/validation/card.ts へ**文字通り移動**(export 追加)→ card-field-handlers.ts:57-92 の local 定義削除 + import / mutation-schemas.ts:51-72 の inline を import 参照に差し替え。
- [ ] **制約**: 式の合成し直し禁止(z.object field に同一 schema object を差すのみ)。message byte 一致。tagOptionIdsSchema(:97)残置。validation/card.ts は zod のみ import(循環なし — mutation-schemas → validation/card の単方向維持)・既存 export `optionSchema` と新 6 export の名前衝突なし(Codex 指摘採用)。
- [ ] **完了条件**: golden 更新ゼロ + **contract 2 file(entity-mutations-bulk / pull)snapshot 更新ゼロを個別確認**(spec §7)+ **移設前後の one-shot 同値確認**(代表 3 例: title 201 字 / options 51 個 / sort_key 101 字の safeParse issue(path/message)を移設前後で node one-liner 比較・結果は session doc 記録・test 化しない = 現 test が path/message 非観測な弱さの補完・Codex 指摘採用)。canonical + Codex review → commit。

### Task 5: R4 — card_count helper(`refactor(cards): F3-R4 card_count ±N helper 集約 [reviewed]`・**risk**)

- [ ] **目的**: `lib/cards/card-count.ts` 新設 — `bumpExamCardCount(tx: DbExecutor, args: {examId, userId, delta}) → Promise<void>`(delta > 0 = 素加算 / delta < 0 = `GREATEST(card_count + delta, 0)`・updatedAt 自己参照・owner-scoped WHERE — spec §3.5 verbatim)+ 3 site 配線(apply-card-mutation.ts:109-117 → delta:+1 / :171-179 → delta:-1 / upload-persistence.ts:36-45 → delta:+N)。
- [ ] **test**: helper 直 unit(+1 素加算 / -1 GREATEST / +N の fragment 構造・delta=0 は test しない — spec §3.5)。**位置づけの分離**(Codex 指摘採用): G1/G2 = consumer 側 golden(呼び出し文脈の挙動)/ helper unit = helper 単体の contract(符号分岐)— 重複でなく二層。
- [ ] **完了条件**: **G1/G2 が更新ゼロで green**(helper 化で count 面がズレない客観証明 = 本 sprint 唯一の挙動保存リスク面)+ apply-card-mutation.test の integrity/GREATEST/WHERE spy 不変。canonical + Codex review → commit。

## Phase R — F3b Tag(2 commits)

### Task 6: R5 — tag domain 新設(additive)(`refactor(tags): F3-R5 tag-values + card-tag-constraint 新設(additive)[reviewed]`)

- [ ] **目的**: `lib/tags/domain/tag-values.ts`(`export type SelectType = 'single' | 'multi'` + 帰属 doc — spec §3.3)/ `lib/cards/domain/card-tag-constraint.ts`(hasSingleCategoryOverflow — card-field-handlers.ts:242-253 の集計 + 判定を verbatim 抽出・シグネチャ = 参照事実 D-2・入力契約 doc「存在検証済み入力前提」)。配線なし。
- [ ] **test**: `card-tag-constraint.test.ts`(single×2 option → true / single×1 → false / multi×N → false / 混在 category / 空 assigned → false)。
- [ ] **制約**: cards→tags domain は `import type` のみ(SelectType)。
- [ ] **完了条件**: 新 test green + full green。canonical review → commit。

### Task 7: R6 — A-1 配線(`refactor(cards): F3-R6 A-1 single 制約判定を domain 配線 [reviewed]`・**risk**)

- [ ] **目的**: handleTagOptionIds の :242-253 を `if (hasSingleCategoryOverflow(valid, categories)) return 'failed'` に置換(orphan fail-closed :239-240 は handler 残置)。
- [ ] **完了条件**: **A-1 の 4 test(card-field-handlers.test:1059-1137)更新ゼロで green** + full green。canonical + Codex review → commit。

## Phase R — lint(1 commit)

### Task 8: R7 — domain 純度 lint(`chore(lint): F3 domain import 境界 enforce(cards+tags 一括)[reviewed]`)

- [ ] **目的**: eslint.config.mjs に F2 block(:47-70)型で 2 block 追加 — `lib/cards/domain/**`(deny: zod / drizzle-orm / @/lib/db / @/lib/logger / server-only / next|next/* / **@/lib/tags/domain**〔allowTypeImports: true = type-only 強制〕/ @/lib/cards/apply-card-mutation・card-field-handlers〔orchestration 逆流〕)/ `lib/tags/domain/**`(同基本 deny)。*.test.ts は scope 除外(F1/F2 前例)。
- [ ] **完了条件**: 違反 import(例: card-rules.ts へ drizzle-orm、card-tag-constraint.ts へ runtime SelectType import)を一時挿入 → lint 赤を実証 → revert(**git status clean 確認・working tree に残さない**)。記録粒度 = **rule 名 + 赤 message 1 行を session doc に**(Codex 指摘採用)。whole-repo lint exit 0。canonical review → commit。

## 最終

### Task 9: 最終 gate + client diff 実証 + docs

- [ ] whole-repo gate: `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm test`(full)/ `pnpm build` 全 exit 0(報告に「whole-repo lint exit 0 確認済」1 行明記)。
- [ ] **client diff 実証**(spec §8-4): **base = G commit 直前(sprint 開始 HEAD)で固定**(実証対象 = sprint 全体・Codex 指摘採用)。`git diff <base>..HEAD -- app/ lib/sync/ lib/client-db.ts` が参照事実 E の列挙のみ + rg 確認は**旧シンボル単位**(`buildNewCardMutationPatch` は card-write 残置ゆえ「card-write 参照ゼロ」は誤 — Codex 指摘採用): ① `deriveCorrectAnswerIds|normalizeNullableTextField|NULLABLE_TEXT_FIELDS` の `from '@/lib/cards/card-write'` import 残存ゼロ ② `from '@/lib/cards/card-write'` の残存 = inline-card-list.tsx:22(buildNewCardMutationPatch)のみ。session doc に「client diff = import rewire + byte-equivalent 呼び出し置換(session-runner)」と記録。
- [ ] session doc(`docs/superpowers/sessions/`)+ stg smoke 申し送り(spec §8-5: card CRUD+count 整合 / OCR upload count 加算 / tag CRUD + single toggle + category 削除 mirror 反映 + **category delete 後 card 側 tag 割当が残らない**〔実 FK CASCADE〕。W 無しゆえ OT 実機必須なし)を commit(`docs(session): … [no-review]` — docs は CLAUDE.md 必須経路の例外ゆえ review skip が正・Codex 指摘への回答)→ **停止・OT 判断待ち**(push は OT)。

## Codex plan cross-check 統合記録(帰属)

`docs/codex/2026-07-09-plan-f3-card-tag-plan.md`(1 パス・独立論点・detector PASS)。突き合わせ結果:

- **採用(plan に反映)**: ① SQL fragment の観測粒度 = 構造的観測に固定・render 文字列 pin 禁止(Global)② G1 の tx identity 観測明示 + rollback 経路の非対象明記(Task 1)③ R3 の one-shot 同値確認(代表 3 例の safeParse path/message 前後比較・test 化しない)= 机上照合の検出力限界の補完(Task 4)④ validation/card.ts の循環なし・export 名衝突なし確認(Task 4)⑤ import 最小接触 + formatter reorder 禁止 + 各 R で card-field-handlers の hunk 行域確認(Global)⑥ R2 server inline の内訳明示(1+4 = 計 5・Task 3)⑦ G1/G2 = consumer golden / helper unit = helper contract の位置づけ分離(Task 5)⑧ client diff base = sprint 開始 HEAD に固定(Task 9)⑨ rg を旧シンボル単位に限定(buildNewCardMutationPatch 残置と両立・Task 9)。
- **部分採用**: R7 lint 赤実証の記録粒度固定(rule 名 + message 1 行・working tree clean 確認)— 実証自体は F1/F2 前例維持(Task 8)。
- **不採用**: なし(「zod golden test の新規追加」はリスク section の対立論点であり、one-shot 確認(採用③)で足りる — spec G 範囲を変えず R の golden 更新ゼロ運用を保つ)。
- **確認のみ(plan 既対応)**: applyOcrTags mock 優位(参照事実 A)/ updatedAt 捕捉拡張(G2)/ delta 符号 semantics + 0 非対応(Task 5)/ OCR 誤配線・category 同名の review 観点(Global)/ 行域直列(参照事実 C)/ type-only lint(Task 8)/ UNIQUE precheck と DB 制約の分離・cascade tombstone と実 FK の分離(Task 1・spec §5)/ docs [no-review] の規約整合(Task 9 で明記)。
