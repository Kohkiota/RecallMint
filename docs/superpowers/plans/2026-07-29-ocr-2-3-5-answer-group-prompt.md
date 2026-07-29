# ②-3.5 解答群 prompt 差し替え Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans。Steps は checkbox(`- [ ]`)で追跡。

**Goal:** `COMMON_EXTRACTION_RULES` の解答群記述を「問題タイプ名条件付け」から「受験者は何を選ぶか」の単一の問いへ差し替え、組合せ問題での解答群重複(question_text と options[] の両方に選択肢を出す)を prompt レベルで潰す。

**Architecture:** `lib/ai/prompts/ocr-extract.ts` の COMMON_EXTRACTION_RULES 配列の line 223-227 を差し替えるのみ(1 commit)。モデル移行は §2 実測で撤回済(cost.ts 不触)。効果検証は Phase 2 の arm 比較(prompt 前後・3.1-flash-lite 固定)。

**Tech Stack:** TypeScript strict / prompt string builder。

## Global Constraints(spec verbatim・全 task に暗黙適用)

- **凍結**: cost.ts(モデル ID = gemini-3.1-flash-lite・単価 = 維持)/ schema(ocr-response.ts / ocr.ts zod)/ OCR pipeline / **images 関連 prompt**(`IMAGE_REFERENCE_RULES` 全体 + COMMON_EXTRACTION_RULES line 228「図表参照は本文中にテキストで残す」/ line 233「画像は抽出しない」)。触る必要が出たら**停止して OT 相談**。
- **差し替え対象 = COMMON_EXTRACTION_RULES の line 223-227 のみ**(question_text 定義 + 重複/例外)。line 228 以降は不触。
- **prompt に unit test を付けない**(content ゆえ brittle・承認済)。効果検証は Phase 2 arm 比較。**commit message にその旨を明記**。
- **完了 gate(全 exit 0)**: whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit`。既存 flaky は当該 file 単体 PASS で切り分け。
- **Phase 順序**: commit-then-confirm(Phase 1 commit → Phase 2 arm 比較)。

---

## Task 1: COMMON_EXTRACTION_RULES 解答群記述の差し替え(1 commit)

**目的:** line 223-227 を OT 指定の統一ルールへ差し替え(「のように」= 類推拡大を除去・line 223「リード文のみ」の矛盾も解消)。

**Files:**
- Modify: `lib/ai/prompts/ocr-extract.ts:223-227`

- [ ] **Step 1: prompt 差し替え**

`lib/ai/prompts/ocr-extract.ts` の COMMON_EXTRACTION_RULES 配列、以下を置換:

置換前(223-227):
```ts
  '- question_text: 設問本文。通常は、解答選択肢を除いたリード文のみを入れる。Markdown 可。',
  '- options[].text に入れる各解答選択肢の本文は、question_text に重複させない。',
  '- 例外: 正誤組合せ問題のように、a〜d / ア〜エ の各記述が解答選択肢ではなく、',
  '  後続の 1〜5 等の組合せ表で参照される前提記述である場合、その a〜d / ア〜エ 記述は question_text に含める。',
  '  この場合、options[] には 1〜5 等の組合せ表の各行を入れる。',
```
置換後:
```ts
  '- question_text: 受験者が最終的に選ぶ選択肢そのもの以外のすべてを入れる',
  '  (リード文 / 前提記述 a〜d / 穴埋め本文 / 参考表 を含む)。Markdown 可。',
  '- options[]: 受験者が最終的に選ぶ選択肢を入れる (1〜5、ア〜オ 等の番号が振られた行)。',
  '- 同じ内容を question_text と options[] の両方に入れない。',
  '- 選択肢が表形式で並んでいる場合、その表は options[] として抽出し、',
  '  question_text に表として再掲しない。',
```
line 228 以降(図表参照 / options[].id / options[].text / is_correct / correct_answer_ids / 画像は抽出しない)は**不触**。

- [ ] **Step 2: prompt を pin する既存 test が無いことを確認**

Run: `rg -n "buildDiscoverPrompt|COMMON_EXTRACTION|解答選択肢を除いた|正誤組合せ問題" --type ts -g '*.test.*'`
Expected: prompt content を pin する test 無し(あれば当該 test を新文言へ更新。golden test は parseOcrResponse のみ・mock test は prompt 非依存ゆえ通常は影響なし)。

- [ ] **Step 3: typecheck + 影響 test 確認**

Run: `pnpm typecheck` → 0(string 配列の変更ゆえ型影響なし)。
Run: `pnpm vitest run lib/ai/ocr-golden.test.ts lib/ai/clients/gemini.test.ts scripts/ai/lib/gemini-raw.test.ts`
Expected: PASS(prompt content に非依存)。

- [ ] **Step 4: canonical review + Codex**

canonical(`superpowers:requesting-code-review`・general-purpose + template 改変なし・観点に whole-repo lint / test:iso / **凍結(cost.ts/schema/images prompt 不触)** / **line 228 以降を触っていないこと** / **新ルールが内部矛盾しないこと**を含む)+ Codex(`scripts/ai/codex-review.sh ocr-2-3-5-prompt`)。未解決 Critical 0 かつ Important 0 まで(上限 3 周)。prompt 差分 = 抽出挙動変更ゆえ review 対象。

- [ ] **Step 5: 1 commit**

commit 直前宣言(chat 4 点)。
```bash
git add lib/ai/prompts/ocr-extract.ts
git commit -m "feat(ai): 解答群 prompt を「受験者は何を選ぶか」へ統一(組合せ問題の重複解消) [reviewed]"
```
commit message body に: ① 「のように」= 問題タイプ名条件付けを撤去し類推拡大を防ぐ ② line 223「リード文のみ」の矛盾も解消 ③ **効果検証は Phase 2 arm 比較(prompt 前後・3.1-flash-lite 固定)= unit test を付けない理由**、を明記。

**完了条件:** line 223-227 差し替え / line 228 以降不触 / cost.ts・schema・images prompt 凍結 / typecheck 0 / 影響 test green / canonical + Codex Critical 0 Important 0 / commit `[reviewed]` + message に検証方針明記。

---

## Task 2: Phase 1 完了 gate + stop checkpoint

**目的:** whole-repo gate → 停止(OT push → Phase 2 合図)。

- [ ] **Step 1: 完了 gate**
```bash
pnpm lint --max-warnings=0
pnpm typecheck
pnpm build
pnpm test
pnpm test:iso
pnpm run audit
```
各 exit 0。`pnpm test` 既存 flaky は当該 file 単体 PASS で切り分け。

- [ ] **Step 2: stop checkpoint 報告**

chat に結論のみ: gate 各 exit 0(「whole-repo lint exit 0 確認済」「test:iso green 確認済」「pnpm run audit exit 0 確認済」明記)/ commit SHA / Phase 2(arm 前後比較)は OT 実 API 合図待ち、を報告して**停止**。

**完了条件:** 全 gate exit 0 / 3 必須 1 行明記 / commit SHA 提示 / OT 合図待ちで停止。

---

## Task 3: Phase 2 — prompt 前後 arm 比較(OT 実 API 合図後)

**目的:** prompt 差し替えが組合せ問題の解答群重複を解消したかを検証(変更源 = prompt 1 つゆえ純粋検証)。

**制約:** 実 API は OT 合図後のみ。コード変更なし(観測+報告)。**gemini-3.1-flash-lite 固定**(移行しない)。before = §2 の事前観測(現行 prompt)、after = 新 prompt。

- [ ] **Step 1: after を実 API で取得(OT 合図後)**

同一サンプル(`mock-exam-set-p-1..5.png`・OT 配置・非 commit)を **3.1-flash-lite・新 prompt** で実行。pdf は除外し 5 pngs を scratchpad へコピーして `--images` に渡す(§2 の事前観測と同手順)。command 例: `pnpm exec tsx --env-file=.env.local scripts/ai/ocr-compare.ts --images <scratchpad-5pngs> --models gemini-3.1-flash-lite --arm A`。

- [ ] **Step 2: before/after 差分の判定(主目的 = 解答群重複の解消)**

- **解答群重複**: 組合せ問題(p-2 Card003/004)で before の完全重複(dupCount 5/4)が after で **0** になるか(option 本文が question_text に substring 出現するかを programmatic 解析・結果は scratchpad file 出力 → Read で破損回避)。
- 選択肢表の question_text 再掲がないか / `![…]` 混入の変化 / Markdown 表出力率 / **致命シグナル(数値/単位/否定)の劣化がないか**(劣化 = 停止して OT)。
- 実教材を含む出力・scratch は報告後に掃除(commit しない・§2 と同運用)。

- [ ] **Step 3: 停止条件 + 報告**

解答群重複が解消しない or 致命シグナル劣化 = **停止して OT**(対処方針は CC で決めない)。問題なければ結果を報告(session doc に記録・実教材本文は含めない)。

**完了条件:** after 取得 / before/after を programmatic 比較 / 重複解消の可否判定 / 致命シグナル劣化なし(あれば停止)/ tracked に実教材漏れなし / 報告。

---

## Self-Review

- **Spec coverage:** §4 差し替え = Task 1 / §5 Phase1 = Task 1-2・Phase2 = Task 3 / §6 観測 = Task 3 Step2 / §8 gate = Task 2 / §3 凍結 = Global Constraints / §7 1 commit = Task 1 Step5。§10 ②-4 記録は spec/architecture.md/台帳に記録済ゆえ task 化しない。全 spec 項に対応。
- **Placeholder scan:** TBD/TODO なし。置換前後の具体コードあり。
- **Type consistency:** 変更は string 配列のみ(型なし)。
