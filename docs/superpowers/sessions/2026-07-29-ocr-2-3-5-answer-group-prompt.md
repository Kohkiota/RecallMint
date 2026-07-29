# ②-3.5 解答群 prompt 差し替え — Phase 1 完了記録

- 日付: 2026-07-29
- Sprint: ②-3.5(OCR track / 小)
- 状態: **Phase 1 完了・未 push**(feat 1 commit `[reviewed]`)。Phase 2(prompt 前後 arm 比較)は OT 実 API 合図待ち。
- spec: `docs/superpowers/specs/2026-07-29-ocr-2-3-5-model-and-answer-group-design.md`
- plan: `docs/superpowers/plans/2026-07-29-ocr-2-3-5-answer-group-prompt.md`

## commit(develop・未 push)

| SHA | 内容 | tag |
|---|---|---|
| 62f2ee6 / 813a6fa / d6ff7fe / 3078023 | spec(起草→§2 反証→prompt単独縮小→§4 positive-list) | `[no-review]` |
| 1dd8acc | ②-4 記録(architecture.md §10 + ledger follow-up) | `[no-review]` |
| f1413e5 | plan 起草 | `[no-review]` |
| `1f40985` | **feat**: 解答群 prompt を「受験者は何を選ぶか」へ統一 | **`[reviewed]`** |

(この上に ②-2 P2 以降の ②-3 系 docs も未 push)

## 経緯(スコープが縮小した理由)

- 当初 ②-3.5 = **モデル移行(3.1→3.5-flash-lite)+ prompt 差し替え**の 2 本立て。
- **事前観測(実 API・現行コード・組合せ問題サンプル・OT 合図)で移行の前提が反証**: 3.5-flash-lite は組合せ問題(p-2)で解答群を**完全重複**(全選択肢を question_text に列挙 + options[] にも・dupCount 5/4)、現行 3.1-flash-lite は**重複ゼロ**。→ **3.5-lite は重複を悪化**させ、単価も高く混入増・字落ちもあり移行理由消滅 → **commit A(移行)撤回**。cost.ts 不触・3.1-flash-lite 維持。
- **教訓(記録)**: ① 変更源を 1 つずつ動かす原則が反証を可能にした(A+B 同時なら「prompt が効いた」と誤結論)。② ②-0 sweep(組合せ問題なし)の「全モデル 0 件」で結論していたら逆判断。「0 件=起きない」でなく「検証できていない(結論不能)」と報告し適切サンプルで再検証したことが反証につながった。

## 実装結論(prompt 差し替え単独)

- `COMMON_EXTRACTION_RULES` の解答群記述を差し替え。「正誤組合せ問題のように」= 問題タイプ名条件付け(類推拡大の起点)を撤去し「受験者は何を選ぶか」へ統一。旧「question_text: リード文のみ」の矛盾も解消。
- **Codex Critical(答え露出)→ positive-list で対処**: 当初「question_text = 選ぶ選択肢以外のすべて」案は正答/解説/メタデータも含め学習者に答えを露出しうる(専用 field と矛盾)。OT 判断で question_text を「入れるものを列挙する **positive-list**」(問い/解答条件/症例文/資料文/穴埋め本文/参照される前提記述)へ変更 → 正答・解説はリスト外 = 各専用 field へ routing され露出せず、既存 ANSWER_GROUNDING/EXPLANATION_USAGE と整合。
- **prompt に unit test を付けない**(content ゆえ brittle・承認済)。効果検証は **Phase 2 arm 比較**。commit message にその旨明記。

## review(fix ループ)

- **canonical**(2 回): r0(broad 版)Ready-Yes(scope/凍結/OT ルール適合を検証・答え露出は semantic ゆえ見逃し)→ 最終(positive-list 版)**Ready-Yes / Crit0 / Imp0 / Minor1**(暗黙除外の note・記録のみ)。
- **Codex**(2 回・収束): **r1 Critical 1(P1・答え露出: broad 定義が正答/解説/メタデータを question_text に含める)→ r2 Crit0 / Imp0 / Minor0**(positive-list で構造解消)。
- **教訓**: canonical は「OT 指定どおり」で pass、Codex が「指定ルール自体の意味的欠陥(答え露出)」を検出。指定ルールの欠陥は仕様変更ゆえ CC 独断で直さず OT 判断(freeze 則)→ OT が positive-list 文言を指定 → 解消。Codex md = `docs/codex/2026-07-29-ocr-2-3-5-prompt{,-r2}.md`。

## 完了 gate(全 exit 0)

lint 0 / typecheck 0 / build 0 / **test 4041**(prompt は unit test 無しゆえ ②-3 と同数・flaky も今回 fail せず)/ **test:iso 217** / audit 0(prod high 0 / dev high 1 = brace-expansion allowlist)。

## Phase 2(OT 実 API 合図待ち)= plan Task 3

- **gemini-3.1-flash-lite 固定で prompt 前後比較**。before = 事前観測(現行 prompt・組合せ問題サンプル `mock-exam-set-p-1..5.png`・非 commit)、after = 新 prompt。
- 主目的 = 組合せ問題 p-2 Card003/004 の解答群完全重複(dupCount 5/4)が after で 0 になるか(programmatic 解析・結果 scratchpad 出力 → Read)。
- 併せ: 表再掲 / `![…]` 混入 / 表出力率 / 致命シグナル劣化(劣化 = 停止 OT)。実教材出力・scratch は報告後掃除(commit しない)。

## ②-4 持ち越し(記録済)

spec §10(A-E + prompt 3 件 + test 素材)/ architecture.md §10(検証失敗の隔離原則)/ ledger(cross-field 検証 / 100 問分割 / 3.5-lite 除外・trigger 付き)。
