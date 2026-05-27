# rate-then-confirm fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** FSRS モード rate click 毎に Dexie write を発火する致命バグ修正。 rate
click を state-only にし、 「次へ」 / 「前へ」 押下時に lastRating で 1 件 submit
する仕様に変更。

**Architecture:** A 案 (handleRateFsrs inline state-only 化 + runSubmit 本体不変)、
通常モード無改修。 詳細: `docs/superpowers/specs/2026-05-27-rate-then-confirm-design.md`

**Tech Stack:** Next.js 15 / React / TypeScript strict / Vitest + Testing Library
(Dexie は mock のみ)

---

## 全体ルール (各 task 共通、 個別 task では参照のみ)

- TDD: 赤 → 緑 → commit。 各 task 内で `pnpm vitest run` で対象 test 確認
- 修正範囲: `app/(app)/app/study/smart/_components/session-runner.tsx` + 同
  `session-runner.test.tsx` のみ。 `lib/sync/` / server / 通常モード handler /
  runSubmit 本体 / S-cache-3.1 race gate は **一切 touch しない**
- 既存 invariant: tally / submittedCardIds 二重加算ゼロ (isFirstSubmit gate) /
  silent retry / fire-and-forget 設計 を維持
- 全 task の暗黙完了条件: 該当 test 緑 + typecheck clean + 既存 test 回帰なし
- 最終 task (Task 7) でのみ: `superpowers:requesting-code-review` canonical 経路
  + `fix(study)` commit + [reviewed] tag

### File 構造

```
app/(app)/app/study/smart/_components/
├── session-runner.tsx       (modify: handleRateFsrs / handleNextFsrsAfterRate / handlePrev)
└── session-runner.test.tsx  (modify: FSRS 系 test 反転 / new: 4 件追加)
```

---

## Task 1: 既存 FSRS test の反転 (赤確認)

**Files:**
- Modify: `app/(app)/app/study/smart/_components/session-runner.test.tsx`

**目的**: 旧仕様前提 (rate click → `mockRecordAnswerEvent` 即発火) の FSRS test
を新仕様 (rate click → fire しない / 「次へ」 / 「前へ」 で fire) に反転。 TDD 赤
を確立する。

**制約**:
- 対象は spec §4.1 列挙の test 群 (FSRS judged + rate 経路、 ~10 件)。 通常モード
  (L193- 群) / S-cache-3.1 (L1260- 群) は touch しない
- Optimistic 系 (L1055 / L1094) は highlight 即時反映 assert を維持、 mock 発火
  trigger を rate click → 「次へ」 click にずらす
- L896 「前へ → submit 追加なし」 は「**1 件 submit + goPrev**」 に反転、
  L938 / L967 二重加算 guard は rate 後 「次へ」 を flow に挟む
- test 名 / コメントも新仕様に書換

**完了条件**: vitest で **反転した FSRS test が赤** / 通常モード + S-cache-3.1
緑のまま / typecheck clean

---

## Task 2: 新規 test 4 件追加 (赤確認継続)

**Files:**
- Modify: `app/(app)/app/study/smart/_components/session-runner.test.tsx`

**目的**: spec §4.2 の 4 件を `describe('rate-then-confirm (Step 3b)', ...)` 配下
に追加して新仕様の核心挙動を guard。

**追加 test**:
1. FSRS rate 連打 → 次へ で `lastRating` で 1 件のみ submit (Hard→Good→Easy→次へ、
   `mockRecordAnswerEvent` 1 回 with `rating=4`)
2. FSRS rate → 前へ → 1 件 submit + 前 card 遷移 (idx=1 まで進めて rate Good →
   前へ、 1 回 with `rating=3`、 問1 遷移 + selecting reset)
3. FSRS 前へで戻った card で再回答 → 次へ で追加 1 件 (問1→次へ / 問2→前へ /
   問1 戻り再 rate→次へ、 累積 3 件、 上書きせず順次 apply)
4. FSRS リトライ → submit 呼ばれない regression guard (rate Good → リトライ、
   `mockRecordAnswerEvent` 0 回)

**制約**: 既存 helper (`makeCard` / `clickOption` / `NAME_*`) 再利用。 mock setup
は `beforeEach` default で十分。 test 名に `(Step 3b)` suffix。

**完了条件**: 新規 4 件のうち 1-3 が **未実装 source に対して赤**、 4 は既存挙動
で緑。 既存 test 状態は Task 1 終了時から変化なし。

---

## Task 3: handleRateFsrs を inline state-only 化

**Files:**
- Modify: `app/(app)/app/study/smart/_components/session-runner.tsx`
  (L328-332 周辺、 上部 phase machine コメント L1-50 も新仕様に短縮 update)

**目的**: rate click から Dexie write 撤去。 setLastRating + tally /
submittedCardIds の Optimistic 更新のみに削減。

**変更内容**:
- 旧: `handleRateFsrs(rating) → runSubmit(rating, () => {})`
- 新: inline で `current` / `currentCorrect === null` guard 維持 → `cardId` /
  `correctSnapshot` / `isFirstSubmit = !submittedCardIds.has(cardId)` 算出 →
  `setError(null)` → isFirstSubmit なら `setTally(...)` + `setSubmittedCardIds(s
  => new Set(s).add(cardId))` (runSubmit と同一加算式) → `setLastRating(rating)`。
  Dexie write 呼び出しなし

**制約**: runSubmit 本体は本 task で touch しない。 上部コメント (L17-20 /
L29-32) も新仕様に揃える。

**完了条件**: Task 1 で反転した「rate 連打 → submit 0 件」 系 + Task 2 新規 1, 4
が緑。 「次へ」 「前へ」 系は依然赤。 通常モード / S-cache-3.1 緑のまま。

---

## Task 4: handleNextFsrsAfterRate に runSubmit 追加

**Files:**
- Modify: `app/(app)/app/study/smart/_components/session-runner.tsx`
  (L335-338)

**目的**: 「次へ」 押下時に lastRating で Dexie write 1 件 + 次 card 遷移。

**変更内容**:
- 旧: `if (lastRating === null) return; goNext()`
- 新: `if (lastRating === null) return; runSubmit(lastRating, () => goNext())`

**制約**: `lastRating === null` guard は defensive で維持 (UI で button disabled
だが handler 内 guard も keep)。 runSubmit 内 isFirstSubmit gate が二重加算を
自動防止 (Task 3 で submittedCardIds.add 済)。 L334 コメント update。

**完了条件**: Task 1 反転の「次へ」 系 + Task 2 新規 1 が緑。 「前へ」 系は依然
赤。 通常モード緑のまま。

---

## Task 5: handlePrev に FSRS judged + rated 分岐追加

**Files:**
- Modify: `app/(app)/app/study/smart/_components/session-runner.tsx`
  (L221-223)

**目的**: FSRS judged かつ rated の「前へ」 で `runSubmit(lastRating, () =>
goPrev())` 発火、 それ以外は従来の `goPrev()` のみ。

**変更内容**:
- 旧: `goPrev()`
- 新:
  ```
  if (idx === 0) return
  if (fsrsMode && phase === 'judged' && lastRating !== null) {
    runSubmit(lastRating, () => goPrev())
  } else {
    goPrev()
  }
  ```
- `idx === 0` 早期 return は runSubmit 空打ち防止のため handler 内で先頭 guard

**制約**: selecting / 通常 judged / FSRS rate 前の「前へ」 は **既存挙動維持**
(submit 呼ばない)。 L222 コメント update。 runSubmit 本体無変更。

**完了条件**: Task 1 反転の「前へ」 系 + Task 2 新規 2, 3 が緑。 selecting / 通常
judged の「前へ」 既存 test 緑のまま。 通常モード / S-cache-3.1 緑のまま。

---

## Task 6: 全 test pass + typecheck clean 確認

**目的**: Task 3-5 実装後の総合 regression 確認。

**実行**:
- `pnpm vitest run app/(app)/app/study/smart/_components/session-runner.test.tsx`
  → 全 test 緑
- `pnpm vitest run` → 他 suite (sync / review-events 等) の間接影響なし確認
- `pnpm tsc --noEmit` (or `pnpm typecheck`) → エラーなし

**完了条件**: 上記 3 つすべて緑 / エラー 0。

---

## Task 7: review + `fix(study)` commit ([reviewed] tag)

**目的**: canonical review 経路で Critical 0 / Important 0 を確認、 [reviewed]
commit で完了。

**手順**:
1. `superpowers:requesting-code-review` skill 起動 (general-purpose subagent +
   template 改変なし)
2. 結果分類 (Critical / Important / Minor)、 Critical 即 fix / Important 原則 fix
3. fix 後 Task 6 と同じ vitest + typecheck で regression chk
4. commit 直前に CLAUDE.md 規律通り chat に 4 点明示 (review 経路 / 件数 /
   Important 残置あれば理由 + OT 承認 / [reviewed] 付与宣言)
5. `git add` で 2 ファイル明示指定 (`-A` 禁止)
6. `git commit -m "fix(study): ..."` 末尾に [reviewed] tag 付与

**制約**: 本 fix は決済 / 認証 / 削除 / 外部副作用に非該当 → review pass で
即 [reviewed] 付与可。 commit type `fix(study)` 固定、 push しない (memory:
commit-only-no-push)。 session log は別 commit (sprint 完了後)。

**完了条件**: review Critical 0 / Important 0、 commit に [reviewed] tag、
`.claude/hooks/check-review.sh` block されない、 chat に review log 明示済。

---

## Self-Review

**Spec coverage**: §2 確定仕様 7 step → Task 3 (rate) + Task 4 (次へ) + Task 5
(前へ)。 §3 確定設計 (A 案 / handler / 分岐 / button gating 不変 / data flow /
error handling) → Task 3-5。 §4 testing → Task 1-2。 §5 scope In/Out → 各 task
制約節で明示。 §6 完了条件 → Task 6-7。 §G やらないこと (in-flight guard / bulk
refactor / event_id deterministic / schema 変更 / migration / 通常モード変更) は
各 task の制約節で明示的に除外済。

**Placeholder scan**: TBD / TODO / 抽象的「error handling」「edge case」 文言
なし。 各 task に具体 line range + 変更内容。

**Type consistency**: `Rating` / `Phase` / `SessionRunnerProps` / mock 名
(`mockRecordAnswerEvent`) / handler 名 (`handleRateFsrs` /
`handleNextFsrsAfterRate` / `handlePrev`) を spec / plan / 既存 source で一致。

行数 < 250 (CLAUDE.md 規律内)。
