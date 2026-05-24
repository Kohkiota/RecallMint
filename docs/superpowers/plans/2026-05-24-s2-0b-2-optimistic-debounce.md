# S2.0b-2 Optimistic UI + debounce / dashboard revalidate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 試験詳細画面の inline 編集を Optimistic UI + debounce 化、 submitReview 成功時に dashboard を revalidate。

**Architecture:** spec doc `docs/superpowers/specs/2026-05-24-s2-0b-2-optimistic-debounce-design.md` §3〜§5 に準拠。 InlineTextField / InlineOptionRow は state + ref で send queue 管理、 row 内 1 並列 + queue (B-2)、 失敗時 rollback (E-1)。 submitReview は `revalidatePath('/app')` 1 行追加。

**Tech Stack:** Next.js 15 App Router (Server Actions) / React 19 / TypeScript strict / Vitest + Testing Library + jsdom / Tailwind v4

---

## 全体ルール (各タスク共通、 再掲しない)

- **TDD 厳守**: 各 task で failing test → minimal 実装 → pass → review → commit
- **コード本体は plan 内に書かない**: Generator が spec doc §3 設計に従い実装
- **review 経路**: `superpowers:requesting-code-review` skill canonical (general-purpose subagent + 厳格 prompt + template 改変なし)、 commit 前に経路 / Critical N / Important N / Minor N / Important 残置の有無を text で OT に宣言
- **commit tag**: feat/fix は [reviewed]、 chore(docs) は [no-review]
- **完了判定**: 各 task の test + `pnpm test` 全 pass + `pnpm exec tsc --noEmit` clean + `pnpm build` pass (T3 完了後に一度確認)
- **fake timer**: 新規 debounce test ファイル (`*.debounce.test.tsx`) のみ `vi.useFakeTimers()`、 既存 test は real timer 維持 (G-1)
- **絶対ルール**: AI / Stripe / Clerk いずれも本 sprint で触らない (UI + cache revalidate のみ)

---

## Task 1: submitReview に revalidatePath('/app') 追加

**Files:**
- Modify: `app/(app)/app/study/smart/_actions/submit-review.ts`
- Test: `app/(app)/app/study/smart/_actions/submit-review.test.ts`

**目的:** submitReview 成功時に dashboard (`/app`) を revalidate して 「今日の枚数 / 連続日数」 反映漏れを解消。

**制約:** spec §4。 成功時のみ呼出、 failure 時は呼ばない (try 外、 catch 後の return ではスキップ)。 既存 logic / signature / error format 不変。

**完了条件:** test 「成功時 revalidatePath('/app') 呼出」 / 「failure 時不呼出」 pass + 既存 test 全 pass + review Critical 0 + [reviewed] commit

- [ ] **Step 1:** `vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))` を test 冒頭に追加し、 既存成功 case test を拡張して `expect(revalidatePath).toHaveBeenCalledWith('/app')` を assert。 別 case で failure 時不呼出を assert
- [ ] **Step 2:** `pnpm test submit-review` で新 assert が失敗することを確認
- [ ] **Step 3:** `submit-review.ts` に `import { revalidatePath } from 'next/cache'` 追加 + try 内成功 return 直前で `revalidatePath('/app')` を 1 行呼ぶ
- [ ] **Step 4:** `pnpm test submit-review` で全 pass、 `pnpm exec tsc --noEmit` clean
- [ ] **Step 5:** review (skill canonical) → 結果を OT に宣言 → `feat(study): S2.0b-2 T1 submitReview 成功時に /app revalidate (dashboard 反映漏れ修正) [reviewed]`

---

## Task 2: InlineTextField Optimistic UI + debounce + queue

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/inline-text-field.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/inline-text-field.test.tsx` (仕様変更分のみ)
- Create: `app/(app)/app/exams/[id]/_components/inline-text-field.debounce.test.tsx` (新規 fake timer 系)

**目的:** spec §3.2 の state/ref + scheduleSend/send 設計を実装。 blur で display 即時反映 + 500ms debounce + 進行中時 queue (B-2) + 失敗時 rollback (E-1)。

**制約:** spec §3.2 / §5.1 / §5.2。 useTransition 廃止 (純粋 useState + try)、 unmount 時 timer clear + setState ガード (mountedRef)。 server action signature 不変。

**完了条件:** 新 debounce test 全 pass + 既存 test 仕様変更分 update 完了 + `pnpm test` 全 pass + tsc clean + review Critical 0 + [reviewed] commit

- [ ] **Step 1:** 新 `inline-text-field.debounce.test.tsx` を作成し、 spec §5.1 列挙の 7 ケース (debounce 待機 / 経過 / reset / queue / optimistic display / rollback / 次 blur で error 消去) を failing test として記述 (`vi.useFakeTimers()` + `vi.advanceTimersByTime(500)` + `vi.waitFor`)
- [ ] **Step 2:** `pnpm test inline-text-field.debounce` で全 fail を確認
- [ ] **Step 3:** spec §3.2 設計通り `inline-text-field.tsx` を改修 (state + ref 整理、 blur で即時 display + scheduleSend、 send 関数で inFlight + queue + rollback、 mountedRef cleanup)
- [ ] **Step 4:** 既存 `inline-text-field.test.tsx` の仕様変更分のみ update (pending disabled / 保存中 spinner / pending 中再 click 不可 → 削除、 blur 成功 → display 即時、 失敗時 → display で旧値 + error、 spec §5.2 参照)。 send 検証する既存 assert は real timer + waitFor で 500ms 経過を待つ形に最小限調整
- [ ] **Step 5:** `pnpm test inline-text-field` 全 pass + `pnpm exec tsc --noEmit` clean
- [ ] **Step 6:** review → OT 宣言 → `feat(exams): S2.0b-2 T2 試験詳細 inline 編集 (text) を Optimistic UI + debounce 500ms + queue 化 [reviewed]`

---

## Task 3: InlineOptionRow Optimistic UI + debounce + checkbox individual disable

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/inline-option-row.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/inline-option-row.test.tsx` (仕様変更分)
- Create: `app/(app)/app/exams/[id]/_components/inline-option-row.debounce.test.tsx` (新規 fake timer)

**目的:** spec §3.3 の row 共有 send + cell の props.value 化 + checkbox 個別 inFlight を実装。 row 内 1 並列 + queue、 checkbox debounce なし + text 編集中の checkbox click で timer cancel 同梱。

**制約:** spec §3.3 / §3.5 / §5.1 / §5.2。 InlineOptionCell から local committed state を廃止し props.value から派生。 cell error は row 集約。 server action API (updateCardField('options', allOptions)) は不変、 payload は 常に最新 row committed snapshot から再構築。

**完了条件:** 新 debounce test 全 pass + 既存 test 仕様変更分 update + `pnpm test` 全 pass + tsc clean + `pnpm build` pass + review Critical 0 + [reviewed] commit

- [ ] **Step 1:** 新 `inline-option-row.debounce.test.tsx` を作成し、 spec §5.1 列挙の 5 ケース (text debounce / text 中 checkbox で timer cancel + 同梱 / checkbox inFlight 中 該当のみ disable + 他 cell edit 可 / text 送信中 他 cell blur → queue / row 全体 rollback) を failing test として記述
- [ ] **Step 2:** `pnpm test inline-option-row.debounce` で全 fail を確認
- [ ] **Step 3:** spec §3.3 設計通り `inline-option-row.tsx` を改修 (row 共有 committed + ref 群、 InlineOptionCell を props.value ベースに簡素化、 cell の cellError を廃止し row error 集約、 checkbox onChange で timer cancel + 個別 inFlight)
- [ ] **Step 4:** 既存 `inline-option-row.test.tsx` の仕様変更分のみ update (pending 中 row 全 cell disabled → 「checkbox のみ disabled + text/explanation edit 可」 に書換、 失敗時 edit mode 維持 → display で rollback + error、 spec §5.2 参照)
- [ ] **Step 5:** `pnpm test` 全 pass + `pnpm exec tsc --noEmit` clean + `pnpm build` pass
- [ ] **Step 6:** review → OT 宣言 → `feat(exams): S2.0b-2 T3 試験詳細 inline 編集 (options) を Optimistic UI + debounce + checkbox 個別 disable 化 [reviewed]`

---

## Task 4: tech-spec / session log 更新 + sprint closure

**Files:**
- Modify: `docs/02-tech-spec.md` (該当章: 試験詳細 inline 編集 + submitReview)
- Create: `docs/superpowers/sessions/2026-05-24-s2-0b-2-optimistic-debounce.md`

**目的:** Sprint S2.0b-2 closure。 動作モデル変更点 (Optimistic UI + debounce + queue + checkbox 個別 disable + dashboard revalidate) と既知制約 (row 内 1 並列 / 同時編集 OCC 未対応) を tech-spec に反映、 session log に Sprint 通史と review 結果を残す。

**制約:** docs commit のみ、 実装ロジック変更なし。 OT 規律準拠 (chat は結論 + 詳細 file path)。

**完了条件:** tech-spec 該当章 update 完了 + session log に T1〜T3 review 結果記載 + [no-review] commit

- [ ] **Step 1:** `docs/02-tech-spec.md` で試験詳細 inline 編集の動作モデルを Optimistic UI + debounce + queue + checkbox 個別 disable に書換、 既知制約欄に row 内 1 並列 / 同時編集 OCC 未対応を追記
- [ ] **Step 2:** `docs/02-tech-spec.md` で submitReview の section に revalidatePath('/app') 副作用を追記
- [ ] **Step 3:** `docs/superpowers/sessions/2026-05-24-s2-0b-2-optimistic-debounce.md` を作成し、 T1〜T3 commit hash + review 結果 (Critical/Important/Minor 件数) + 残課題を記載
- [ ] **Step 4:** `git add docs/02-tech-spec.md docs/superpowers/sessions/2026-05-24-s2-0b-2-optimistic-debounce.md` → `chore(docs): S2.0b-2 T4 closure — tech-spec 更新 + session log [no-review]`
