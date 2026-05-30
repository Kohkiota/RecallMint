# 増分 pull Step 6「exams Dexie 化 UI(試験一覧)」 Implementation Plan (改訂)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 試験一覧 UI を Postgres 直読み(`getActiveExamsWithCardCount` RSC)から **Dexie exams mirror の `useLiveQuery` 参照**へ切替え、step 1-5 で増分更新されるようになった exams mirror を初めて UI が読む(これまで dead read)。card_count は cards mirror から算出。一覧件数・表示に効くサーバー変更(OCR 完了/試験作成・削除/カード追加・削除)の既存成功ハンドラに `runGuardedPull` を相乗りさせ、mirror を即時最新化する。

**Architecture:** `<ul>` の exam list 描画を client component `ExamListLive`(`useLiveQuery`)に抽出。exams を `archived_at == null` filter + `updated_at` DESC sort、card_count は cards mirror を 1 read して `exam_id` で JS 集計(N count query 回避)。RSC(`exams/page.tsx`)は auth / OCR statusMap seed(`ExamStatusProvider`)/ `CreateExamForm` / 見出しを保持。3 状態(skeleton / 空状態 / list)は `ExamListLive` が持つ。mirror は **pull でのみ書く**(read-only 不変条件)ため、一覧に効く 5 操作の既存成功ハンドラに `runGuardedPull` を fire-and-forget で 1 行相乗り(新規 polling/検知/helper は作らない)。

**Tech Stack:** React, dexie-react-hooks `useLiveQuery`, Dexie, `runGuardedPull`(step4), Vitest + jsdom + fake-indexeddb + @testing-library/react。新規ライブラリなし。

**位置づけ (spec 整合):** 確定 spec §4 / §6 step 6。流用棚卸し `docs/superpowers/sessions/2026-05-30-incremental-pull-step6-reuse-inventory.md`(U2/U4 とも新規不要、`runGuardedPull` 相乗りで足りる)を反映。step 1-5(増分 pull/tombstone/pull-back)が前提。

---

## 全体制約(各タスク共通、冒頭一度のみ)

- **TDD**: 失敗 test 先行 → fail 確認 → 最小実装 → green → review → commit。test 実行 `pnpm test <path>`、型は `pnpm exec tsc --noEmit`。
- **mirror は read-only(pull 上書きのみ)**: `ExamListLive` は Dexie を読むだけ。削除等の反映も optimistic local delete はせず、**`runGuardedPull` 相乗りで pull 経由**にする(U4)。
- **既存パターン踏襲**: `useLiveQuery` + skeleton は `dashboard-actions.tsx`(undefined → `role="status"` skeleton → data)。card mirror read は `db.cards.where('user_id').equals(userId).toArray()` 形。
- **client-safe 部品のみ**: `formatRelativeJa`(`@/lib/exams/format`)/ `ExamStatusBadge` / `DeleteExamButton` / `OpenCreateExamButton`。`@/lib/exams/list`(`import 'server-only'`)は client から import しない。
- **相乗りは「足すだけ」**: 既存の `router.refresh()` / `router.push()` は**残す**(RSC 部分・遷移を維持)。その隣に `void runGuardedPull({ reason }).catch(() => {})` を 1 行追加。`pullBack`(study_days 同梱)でなく `runGuardedPull` 単体。
- **詳細 page(`exams/[id]`)の表示自体はスコープ外**。ただし詳細 page の card 追加/削除ハンドラには一覧件数最新化のため pull 相乗りを足す(下記 Task 2)。
- **review/commit 規律**: feat は `superpowers:requesting-code-review` 必須経路。step 1-5 運用に合わせ **review pass → `[no-review]` commit → UI stg smoke → `[reviewed]` amend**。

---

## File Structure

| 変更 file | 責務 |
|---|---|
| Create `app/(app)/app/exams/_components/exam-list-live.tsx` | client。`useLiveQuery` で exams(archived 除外・updated_at DESC)+ cards 集計 card_count。3 状態(skeleton / 空状態 CTA / list)。各行 name / `ExamStatusBadge` / cardCount / `formatRelativeJa` / 詳細 Link / `DeleteExamButton` |
| Create `app/(app)/app/exams/_components/exam-list-live.test.tsx` | fake-indexeddb + render。exams 読取 / card_count 算出 / archived 除外 / updated_at DESC / skeleton / 空状態 |
| Modify `app/(app)/app/exams/page.tsx` | RSC: `getActiveExamsWithCardCount` 撤去。auth / statusMap / `ExamStatusProvider` / `CreateExamForm` / 見出し保持し `<ExamListLive userId={userId} />` 描画。空状態判定は `ExamListLive` へ移譲(U1) |
| Modify `lib/exams/list.ts` | dead 化した `getActiveExamsWithCardCount` + `ExamWithCardCount` 撤去(caller は本 page のみ)。`getActiveExamsForUser`(upload page 使用)は不変 |
| Modify `app/(app)/app/exams/_components/delete-exam-button.tsx`<br>`app/(app)/app/exams/_components/create-exam-form.tsx`<br>`app/(app)/app/exams/_components/exam-status-live.tsx`<br>`app/(app)/app/exams/[id]/_components/inline-card-list.tsx`<br>`app/(app)/app/exams/[id]/_components/delete-card-button.tsx` | 一覧に効く 5 操作の成功ハンドラに `runGuardedPull` を 1 行相乗り(Task 2) |

**型・シグネチャ**: `ExamListLive({ userId }: { userId: string })`。`ClientExam`(`id/name/updated_at/archived_at?/card_count`)/ `ClientCard`(`exam_id/user_id`)既存・不変。`runGuardedPull`(`@/lib/sync/pull`、step4)再利用。reason 文字列: `'ocr-complete'` / `'exam-delete'` / `'exam-create'` / `'card-add'` / `'card-delete'`。

---

## Task 1: `ExamListLive` 抽出 + page.tsx 切替 + dead query 撤去

**Files:** Create `exam-list-live.tsx` / Test `exam-list-live.test.tsx` / Modify `exams/page.tsx` / Modify `lib/exams/list.ts`

**目的**: 試験一覧の `<ul>` を Dexie `useLiveQuery` 参照の client component に抽出し、card_count を cards mirror から算出。**制約**: mirror read-only、archived 除外・updated_at DESC、skeleton/空状態/list の 3 状態、表示要素を回帰なく踏襲。**完了条件**: 下記 test green + `pnpm build` 成功(RSC/`server-only` 境界エラーなし)+ `pnpm exec tsc --noEmit`。

**実装の骨子**(`exam-list-live.tsx`):
```tsx
'use client'
import { useLiveQuery } from 'dexie-react-hooks'
import { getClientDb } from '@/lib/client-db'
import { formatRelativeJa } from '@/lib/exams/format'
// Button/Card/Link/ExamStatusBadge/DeleteExamButton/OpenCreateExamButton import

export function ExamListLive({ userId }: { userId: string }) {
  const exams = useLiveQuery(async () => {
    const db = getClientDb()
    const [allExams, allCards] = await Promise.all([
      db.exams.where('user_id').equals(userId).toArray(),
      db.cards.where('user_id').equals(userId).toArray(), // 1 read + JS 集計
    ])
    const countByExam = new Map<string, number>()
    for (const c of allCards) countByExam.set(c.exam_id, (countByExam.get(c.exam_id) ?? 0) + 1)
    return allExams
      .filter((e) => e.archived_at == null)                     // archived_at IS NULL 相当 (== null は undefined も捕捉)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)) // updated_at DESC (ISO lexicographic)
      .map((e) => ({ id: e.id, name: e.name, updatedAt: e.updated_at, cardCount: countByExam.get(e.id) ?? 0 }))
  }, [userId])

  if (exams === undefined) return /* skeleton (role="status", animate-pulse、dashboard-actions と同型) */
  if (exams.length === 0) return /* 空状態 CTA (アップロード Link + OpenCreateExamButton、現 page.tsx 空状態を移植) */
  return /* <ul> 各行: name / <ExamStatusBadge examId={id}/> / カード {cardCount} 件・最終更新 {formatRelativeJa(new Date(updatedAt))} / 詳細 Link(prefetch=false) / <DeleteExamButton examId={id}/> */
}
```
- 現 `page.tsx` の `<ul>`(L69-101)と空状態(L53-67)JSX を `ExamListLive` に移植(class/prefetch=false/文言維持)。
- `page.tsx`: `getActiveExamsWithCardCount` import/呼出を撤去、`<ul>`/空状態 を `<ExamListLive userId={userId} />` に置換。`ExamStatusProvider`/`CreateExamForm`/見出し/auth 保持。
- `lib/exams/list.ts`: `getActiveExamsWithCardCount` + `ExamWithCardCount` 撤去(本 page 以外 caller 無し=dead)。

- [ ] **Step 1: 失敗 test**(`exam-list-live.test.tsx`、`@vitest-environment jsdom` + fake-indexeddb)。seed: `db.exams` active 2 + archived 1、`db.cards` exam 別件数。検証: (1) active exam 2 件表示 + 各行 card_count = seed cards 数、(2) archived 非表示、(3) updated_at DESC 順、(4) active 0 件 → 空状態 CTA、(5) render 直後 `role="status"` skeleton → `waitFor` で list。`ExamStatusBadge` は `ExamStatusProvider`(空 statusMap)で wrap、`DeleteExamButton` の `deleteExam` は mock。
- [ ] **Step 2: red** — `pnpm exec vitest run "app/(app)/app/exams/_components/exam-list-live.test.tsx"` → FAIL。
- [ ] **Step 3: 実装** — 骨子 + page.tsx 切替 + list.ts dead 撤去。
- [ ] **Step 4: green** — 同 test PASS + `pnpm exec tsc --noEmit` + `pnpm build`。
- [ ] **Step 5: commit** — `feat(exams): 試験一覧を Dexie mirror (useLiveQuery) 参照の ExamListLive に切替 + dead getActiveExamsWithCardCount 撤去` + `[no-review]`。

---

## Task 2: 一覧に効く 5 操作の成功ハンドラに `runGuardedPull` 相乗り

**Files:** Modify `delete-exam-button.tsx` / `create-exam-form.tsx` / `exam-status-live.tsx` / `inline-card-list.tsx` / `delete-card-button.tsx`(+ 各 test)

**目的**: 一覧件数・表示に影響するサーバー変更を即時 mirror に反映し、Dexie-backed 一覧を live 更新する。**背景**: list が Dexie 参照になり `router.refresh()`(RSC 再 render)では mirror が更新されない → 削除した exam が残る/新 card 件数が古い等の回帰を防ぐ。**制約**: 既存 `router.refresh()`/`router.push()` は残す。`runGuardedPull` を fire-and-forget で足すだけ(失敗 silent)。card 編集(updated_at のみ変化、一覧表示に無影響)は対象外。**完了条件**: 各 test green + tsc。

**相乗り先と reason**(既存成功分岐に `void runGuardedPull({ reason }).catch(() => {})` を追加。import `from '@/lib/sync/pull'`):

| # | file:行 | 既存ハンドラ | reason |
|---|---|---|---|
| 1 | `exam-status-live.tsx:80` | `hasCompletion(...)` true → `router.refresh()`(OCR 処理中→完了) | `'ocr-complete'` |
| 2 | `delete-exam-button.tsx:39` | 削除成功 → `router.refresh()` | `'exam-delete'` |
| 3 | `create-exam-form.tsx:41` | 作成成功 → `router.push(詳細)` | `'exam-create'` |
| 4 | `inline-card-list.tsx:45` | createCard 成功 → `router.refresh()` | `'card-add'` |
| 5 | `delete-card-button.tsx:33` | deleteCard 成功 → `router.refresh()` | `'card-delete'` |

- [ ] **Step 1: 失敗 test** — 5 component の各 test で `@/lib/sync/pull` の `runGuardedPull` を vi.mock。各成功フロー(action mock を ok 返し)で `runGuardedPull` が該当 reason で 1 回呼ばれ、**既存の `router.refresh()`/`router.push()` も呼ばれる**ことを検証。失敗時(`ok:false`)は `runGuardedPull` 呼ばれない。OCR(#1)は `/api/exams/status` fetch mock で processing→completed 遷移を起こして `hasCompletion` true を発火させ、`runGuardedPull('ocr-complete')` を検証(既存 `exam-status-live` test の polling 駆動を流用)。既存 test は不変通過。
- [ ] **Step 2: red** — 各 test FAIL。
- [ ] **Step 3: 実装** — 5 箇所に 1 行ずつ追加。
- [ ] **Step 4: green** — 全 test PASS + `pnpm exec tsc --noEmit`。
- [ ] **Step 5: commit** — `feat(exams): 一覧に効く 5 操作(OCR完了/試験作成・削除/カード追加・削除)の成功時に runGuardedPull を相乗りし Dexie 一覧を live 反映` + `[no-review]`。

---

## Task 3: spec §4 を実態へ追記修正

**Files:** Modify `docs/superpowers/specs/2026-05-29-incremental-pull-design.md`

**目的**: §4 を実装実態に合わせる。**doc・[no-review]・review skip 可**。**完了条件**: §4 に以下追記。
- 空状態 CTA は client(`ExamListLive`)が持つ(emptiness が Dexie 由来のため。U1)。
- 一覧件数・表示に効くサーバー変更(OCR 完了/試験作成・削除/カード追加・削除)の既存成功ハンドラに `runGuardedPull` を相乗りし、mirror を即時最新化(card 編集は対象外)。削除は pull kick で反映(optimistic local delete はしない。U4)。
- 流用棚卸し(`...step6-reuse-inventory.md`)へ参照。

- [ ] **Step 1**: §4 に上記を追記。
- [ ] **Step 2: commit** — `docs(spec): §4 を実態へ追記 (空状態 client 移譲 + 一覧に効く 5 操作への runGuardedPull 相乗り)` + `[no-review]`。

---

## この step 単体の stg smoke(UI 経由)

認証済 staging + DevTools(IDB `exams`/`cards`・Network `/api/pull`)。exams mirror を初めて読む段。

1. **一覧が Dexie 参照で表示**: `/app/exams` → IDB mirror から名前・件数・相対時刻。Postgres 直読み時と見た目・順序一致(updated_at DESC)。`getActiveExamsWithCardCount` 不使用。
2. **増分 pull で反映**: 別経路で exam 更新 → reload/visibility で増分 pull → 一覧 live 更新。
3. **試験削除が即時消える**: 一覧で削除 → `runGuardedPull('exam-delete')` → tombstone bulkDelete → 行が live 消失(reload 不要)。
4. **試験作成が即時出る**: 作成 → 詳細遷移 → 一覧に戻ると新 exam が出る(`runGuardedPull('exam-create')` で mirror に入る)。
5. **カード追加/削除で件数 live 更新**: 詳細 page で card 追加/削除 → `runGuardedPull('card-add'/'card-delete')` → 一覧件数が live 反映。
6. **OCR 完了で件数更新**: OCR 完了の既存 polling 遷移(`hasCompletion`)→ `runGuardedPull('ocr-complete')` → 新 card 件数反映。OCR バッジは従来どおり。
7. **archived 除外 / skeleton / 回帰**: archived 非表示、未 pull 時 skeleton、見た目・詳細遷移・空状態 CTA 不変。

全観点 PASS で feat commit を `[reviewed]` へ amend(step 1-5 同手順 filter-branch)。FAIL は amend せず報告で停止。

---

## Self-Review(spec 整合)

- §4(list 部分のみ client 抽出 / archived 除外・updated_at DESC / card_count は cards mirror 集計 / RSC は auth・statusMap・CreateExamForm 保持 / `ExamStatusBadge` polling 維持 / skeleton / 詳細 page 表示スコープ外)→ Task 1。一覧に効く 5 操作の即時反映 → Task 2。空状態 client 移譲(U1)/ pull-kick 反映(U4)反映。
- placeholder なし。型整合: `ExamListLive`/`ClientExam`/`runGuardedPull` 一貫。dead `getActiveExamsWithCardCount` 撤去。
- spec §4 追記(Task 3)。

---

## 確定済み判断(U1/U2/U4・所与)

- **U1(空状態の所在)**: client(`ExamListLive`)に移譲。spec 文言の自然な具体化(機能不変)。
- **U2(一覧に効く操作の即時性)**: 5 操作の既存成功ハンドラに `runGuardedPull` 相乗り(新規検知/polling/helper なし)。card 編集は対象外。`router.refresh()`/`push` は残す。
- **U3(card_count 算出)**: cards mirror 1 read + JS 集計(N count query 回避)。
- **U4(削除反映)**: pull kick(`runGuardedPull('exam-delete')`)。optimistic local delete はしない(mirror read-only 不変条件維持)。
- 食い違い: U1(空状態 client 移譲)/ §4 が当初「list 抽出のみ」想定で 5 操作相乗りまで明記していなかった点 → Task 3 で追記。所与方針内。
