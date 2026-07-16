# Sprint I(画像 4 欄化)完了記録

- **日付**: 2026-07-16
- **branch**: `develop`(未 push・OT push 待ち)
- **spec**: `docs/superpowers/specs/2026-07-15-sprint-i-image-four-fields-design.md`(rev2・承認済)
- **plan**: `docs/superpowers/plans/2026-07-15-sprint-i-image-four-fields.md`(v2・承認済)
- **実装方式**: subagent-driven-development 適応形(CC inline TDD / canonical review = read-only subagent + code-reviewer.md 改変なし / Codex 独立 / per-task [reviewed] / commit=CC)。

## 目的・結論

画像添付を 4 面(問題文/選択肢/解説/メモ)へ拡張。実装中に **W3 レビュー(canonical+Codex)が spec §3 初版の delete-only cascade の取りこぼし 2 経路(option id rename / blank-text 除去)を検出**し escalate。fact-finding(`docs/audit/2026-07-16-option-internal-id-feasibility.md`)で **(A'-min)= CardOption 内部 uid** の成立を確認 → OT 承認で spec §3 rev2 に改訂し **W5(uid 導入)を W3 の前に追加**。紐付けキーを `option:<uid>`(不変 UUID・非再利用)にして **mis-attach を構造的に不能化**。**全 gate green・push + OT 再 seed + smoke = OT 待ち**。

## commit 範囲(range `863e6d5..7eda895`)

| task | 種別 | fix/feat commit | codex 記録 | tag |
|---|---|---|---|---|
| W1 | fix(exams): 選択肢削除の画像 cascade | `b35fae6` | `f4c8c78` | `[reviewed]` |
| W2 | feat(validation): 画像 target を解説/メモへ widen | `5c137a9` | `4cdf8b1` | `[reviewed]` |
| W5 | feat(cards): 内部 uid + option:<uid> + set-diff cascade | `3436ba5` | `d4b26af`(W3 と併記) | `[reviewed]` |
| W3 | feat(exams): 編集面 4 面 gallery 増設(compact) | `372a46a` | `d4b26af` | `[reviewed]` |
| W4 | feat(study): 学習面 option/explanation read-only 表示 | `47100df` | `7eda895` | `[reviewed]` |

docs(spec/plan/audit)= `d488609` / `78aa3a6` / `eb168ba` / `26cc585` / `dbee52e`。

## 各 task の要点

- **W1**: 選択肢削除時に `option:<id>` 画像を cascade 除去(delete-only)。W5 で set-diff に一般化・revert せず。
- **W2**: `imageEntrySchema` refine を 4 面語彙へ widen(解説/メモ)。追加のみ・legacy passthrough 不変。
- **W5(§3 rev2・sprint の白眉)**: `CardOption.uid`(不変 UUID・非再利用・ユーザー不可視)を導入。画像 target を `option:<uid>` 化 → **id rename / blank-text / id 再利用による mis-attach を構造的に不能化**(確率対処→不変条件)。cascade を commit の**永続集合 set-diff**(`serverCommittedRef`=直近永続 vs `sanitized`=今回永続 の uid 差分)に一般化し delete/blank-text を単一機構でカバー。uid 非再利用ゆえ cascade は**衛生機構**(失敗しても破損せず storage リークのみ)。id(a/b/c)は表示ラベルとして存続(`selected/correct_answer_ids`・正解サマリ・OCR 採番は不変 = 学習系は同時点自己整合)。
  - **uid 型 = optional / validation = required**: 型 optional は orthogonal な既存 fixture 30 file/230 箇所の churn 回避、`optionSchema.uid: z.uuid(v4)` で write 境界必須 + uid 一意 refine。mint 完全性は test で担保。
  - **mint 全 4 生成経路**: handleAddOption / buildEmptyCard / OCR server 写像点(`process.ts`・**Gemini prompt/schema 非接触**)/ seed。+ 透過 2 箇所(handleOptions / applyCardCreate)。**seed のみ unit test でなく inspection(コード上 `randomUUID()`)+ 再 seed smoke で担保**(dev script ゆえ)。
  - **uid DB 自動採番は不採用**(記録): options は cards の jsonb(DB 行でない)+ local-first(端末先書き)ゆえ列採番は不可/遅い → 生成地点 mint が正。
- **W3**: 編集面 4 面 gallery。選択肢は compact 形態(空選択肢は小 +画像 アイコン・§9 悪化回避)、問題文/解説/メモは常時表示。選択肢 gallery は **text 非空 + uid あり**で gate(未確定 ghost + legacy uid 無し option に出さない = `option:undefined` 衝突を構造回避)。
- **W4**: 学習面に option/explanation の read-only gallery(選択肢は選択フェーズから可視・解説は判定後)。**解説節の表示条件を「テキスト or 解説画像あり」に拡張**(画像だけ添付した card で解説節ごと消えるエッジ = 4 面化で初出 を閉じる)。memo は学習非表示ゆえ除外。

## 設計判断・非対称の記録

- **blank-text の非対称(W5・OT 判断 = cascade する)**: 画像付き選択肢の text を空にして blur → sanitize が永続集合から除外 → cascade が画像削除。**working-set は blank 行を保持ゆえ UI に行は残るが、打ち直しても画像は戻らない**(現行の壊れた挙動では zombie 残存ゆえ戻っていた・W5 は意図的に消す)。理由 = 「空 = option 消滅」の意味論一貫 + 不可視の永久 leak を避ける。uid 化で mis-attach 不能ゆえ**破損でなく hygiene vs UX トレードオフ** → smoke 3c で OT が実物許容判断。

## §9(多択行高肥大)検証結果

- W5 seed 改修で **20 択カード 3〜5 枚を分散混入**(`seed-perf-exam.ts`・`i % 75 === 37` で 300 件中 ~4 枚)。Sprint F §9 の「未検証・持ち越し」を今回 smoke で解消する準備。
- **【smoke 後に追記】**: § smoke 5b(多択前後 scroll で gap/飛び/カクつき)の結果 → 「検証済=持ち越し解消」or「観測→別 task 起票(対策候補=explanation トグル化/estimateSize 精緻化/overscan 調整)」。**現時点は再 seed + smoke 前ゆえ未記入**。

## commit 粒度の注記(W5/W3 の相互依存)

W5(uid+cascade)と W3(galleries on `option:<uid>`)は**相互依存**(W3 は W5 の uid を使い、共有 test fixture も跨ぐ)ため isolation-green な完全分離は不可。→ **working-tree-green 前提で W5(core)→ W3(UI+mixed test)の 2 commit**に分け、**review は entangle した working-tree diff を 1 回の canonical(opus)+ Codex** で実施(W3 は escalation 時に既 canonical 済・combined で W5 込み再確認)。両 feat が review される形で OT の分離意図を満たす。

## レビュー収束

- 各 task canonical + Codex を Crit0/Imp0 まで反復。W5+W3 combined review = canonical **Crit0/Imp1(fix済 = uid gate で `option:undefined` 衝突を code 構造閉塞)/Minor3(記録)** + Codex **P1 1 件**。
- **Codex P1 の adjudication(重要・OT 再確認要)**: 「legacy(uid 無し)option 編集が uid 必須 validation で reject = 既存データ regression」。→ これは **OT 決定済 legacy-data 項目**(spec §3 rev2-4 / §7: **prod = zero-user・テストアカウント全消去済・stg は W5 後 reseed・lazy backfill は作らない**)。legacy uid 無し option は存在しないため regression は発生せず = **未解決 Critical 0**(no-legacy-data で検証済み解決)。**この解決は「OT push → 再 seed(uid 付き)→ smoke」の運用順が load-bearing**(reseed 前に legacy データがあれば options 編集が全滅する)。

## 完了 gate(2026-07-16 実行)

- whole-repo `pnpm lint`(--max-warnings=0)**exit 0**。
- `pnpm typecheck`(tsc --noEmit)**exit 0**。
- `pnpm test`(vitest run 全 231 files)**3653/3653 green**。

## OT smoke checklist(push + 再 seed 後・人力 or CC DevTools)

**前提**: W5 は `optionSchema.uid` 必須化を含むため **OT push → OT が seed script 実行(uid 付き + 多択込み)→ smoke** の順(既存 seed card は uid 無しで options 編集が reject される)。

再 seed 後の stg で:
1. **4 面添付 + 永続**: 問題文/選択肢/解説/メモ すべてに画像添付 → reload → 4 面とも復活表示。
2. **削除の非復活**: 各面で画像削除 → reload → 復活しない。
3. **選択肢削除の追随**: 画像付き選択肢を削除 → (同 id 再利用が起きる操作で)新選択肢に旧画像が付かない。
3b. **rename 追随**: 画像付き選択肢の id を編集(a→x 等)→ 画像がその選択肢に付いたまま(消えない・他選択肢に付かない)。
3c. **blank-text の非対称(OT 実物許容判断)**: 画像付き選択肢の text を空にする → 画像が消える → 同じ行に打ち直す → 画像は戻らない(仕様どおり)。行は残るが画像は消える非対称を OT が許容できるか判断(不可なら別 task 起票)。
4. **GC 非孤児化**: GC reconciler 実行後、4 面の生存画像が孤児判定・削除されない。
5. **§9 非悪化(compact)**: 多択カードで空選択肢が小 affordance のみ・行高が肥大しない。
5b. **§9 再燃検証(多択 scroll)**: 20 択カード前後を scroll し gap/飛び/カクつきが無いか(Sprint F 持ち越し解消・観測時は別 task 起票)。
6. **学習面 read-only**: 学習画面で question/option/explanation の画像が read-only 表示。

## follow-up

- §9 検証結果(smoke 後に上記「§9 検証結果」欄へ追記)。
- MAX_IMAGES=10 の上限単位表示(`docs/next-sprints-priority.md` §4・4 面化で当たる確率上昇の観察)。

## 触ったファイル

- **W5 core**: `schema.ts` / `client-db.ts` / `validation/card.ts` / `empty-card.ts` / `card-write.ts` / `card-field-handlers.ts` / `entity-mutation-registry.ts` / `upload/_actions/process.ts` / `seed-perf-exam.ts` / `use-card-options.ts` / `inline-card-list.tsx`(handleAddCard 順序)+ 各 test + fixture。
- **W3 UI**: `card-image-gallery.tsx`(compact/attachAriaLabel)/ `card-editor-fields.tsx` / `inline-option-row.tsx`(per-option gallery + uid gate)+ test。
- **W4**: `session-runner.tsx`(option/explanation read-only + 解説条件拡張)+ test。
- **W1/W2**: `use-card-options.ts`(delete cascade→W5 で set-diff 化)/ `validation/card.ts`(target widen)。
- 新 dep なし・**DB migration なし**(uid は jsonb 内・DDL 不要)・`.env` 変更なし。
