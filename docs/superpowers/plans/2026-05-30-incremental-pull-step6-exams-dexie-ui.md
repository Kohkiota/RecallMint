# 増分 pull Step 6「exams Dexie 化 UI(試験一覧)」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 試験一覧 UI を Postgres 直読み(`getActiveExamsWithCardCount` RSC)から **Dexie exams mirror の `useLiveQuery` 参照**へ切替え、step 1-5 で増分更新されるようになった exams mirror を初めて UI が読む(これまで dead read)。card_count は cards mirror から算出。

**Architecture:** `<ul>` の exam list 描画を client component `ExamListLive`(`useLiveQuery`)に抽出。exams を `archived_at == null` filter + `updated_at` DESC sort、card_count は cards mirror を `exam_id` で集計。RSC(`exams/page.tsx`)は auth / OCR statusMap seed(`ExamStatusProvider`)/ `CreateExamForm` / 見出しを保持。3 状態(skeleton / 空状態 / list)は `ExamListLive` が持つ。mirror は pull 駆動のため、同一 page 上の exam 削除は mirror 反映に pull が要る(Task 2)。

**Tech Stack:** React, dexie-react-hooks `useLiveQuery`, Dexie, Vitest + jsdom + fake-indexeddb + @testing-library/react。新規ライブラリなし。

**位置づけ (spec 整合):** 確定 spec `docs/.../2026-05-29-incremental-pull-design.md` §4 / §6 step 6。exams mirror が dead read でなくなり、OT 当初動機「試験一覧の読取を軽くする(毎回 Postgres 直読みしない)」が実現。step 1-5(増分 pull/tombstone/pull-back)が前提。

---

## 全体制約(各タスク共通、冒頭一度のみ)

- **TDD**: 失敗 test 先行 → fail 確認 → 最小実装 → green → review → commit。test 実行 `pnpm test <path>`、型は `pnpm exec tsc --noEmit`。
- **mirror は read-only(pull 上書きのみ)**: `ExamListLive` は Dexie を読むだけ。書込はしない(`ClientExam` は pull 専用 cache)。
- **既存パターン踏襲**: `useLiveQuery` + skeleton は `dashboard-actions.tsx`(undefined → `role="status"` skeleton → data)を手本。card mirror read は `db.cards.where('user_id').equals(userId).toArray()` 形。
- **client-safe 部品のみ client で使う**: `formatRelativeJa`(`@/lib/exams/format`、server 依存なし)/ `ExamStatusBadge`(context 購読)/ `DeleteExamButton`(既存 client)/ `OpenCreateExamButton`(既存 client)。`@/lib/exams/list`(`import 'server-only'`)は client から import しない。
- **OCR statusMap は server seed 維持**: RSC が `getExamStatusMap` → `ExamStatusProvider initialStatuses`。`ExamListLive` はその内側で `ExamStatusBadge` を描画(context 流通)。Dexie 非対象。
- **詳細 page(`exams/[id]`)はスコープ外**(一覧のみ切替、詳細は Postgres 直読み据え置き)。
- **review/commit 規律**: feat は `superpowers:requesting-code-review` 必須経路。UI 読取切替(削除導線含む)→ 通常 review。step 1-5 運用に合わせ **review pass → `[no-review]` commit → UI stg smoke → `[reviewed]` amend**。

---

## File Structure

| 変更 file | 責務 |
|---|---|
| Create `app/(app)/app/exams/_components/exam-list-live.tsx` | client。`useLiveQuery` で exams(archived 除外・updated_at DESC)+ cards 集計 card_count を読む。3 状態(skeleton / 空状態 CTA / list)を描画。各行 name / `ExamStatusBadge` / cardCount / `formatRelativeJa` / 詳細 Link / `DeleteExamButton` |
| Create `app/(app)/app/exams/_components/exam-list-live.test.tsx` | fake-indexeddb + render。exams 読取 / card_count 算出 / archived 除外 / updated_at DESC / skeleton / 空状態 |
| Modify `app/(app)/app/exams/page.tsx` | RSC: `getActiveExamsWithCardCount` 撤去。auth / `getExamStatusMap` → `ExamStatusProvider` / `CreateExamForm` / 見出しを保持し `<ExamListLive userId={userId} />` を描画。空状態判定は `ExamListLive` へ移譲 |
| Modify `lib/exams/list.ts` | dead 化した `getActiveExamsWithCardCount` + `ExamWithCardCount` 型を撤去(caller は本 page のみ=切替で dead、dead-code-removal 方針)。`getActiveExamsForUser` は upload page が使用中のため不変 |
| Modify `app/(app)/app/exams/_components/delete-exam-button.tsx` | 削除成功時に pull を kick し、mirror から tombstone 反映 → list が live に消える(Task 2) |

**型・シグネチャ**: `ExamListLive({ userId }: { userId: string })`。`ClientExam`(`id/name/updated_at/archived_at?/card_count`)/ `ClientCard`(`exam_id/user_id`)は既存・不変。`runGuardedPull`(`@/lib/sync/pull`、step4)を再利用。

---

## Task 1: `ExamListLive` 抽出 + page.tsx 切替 + dead query 撤去

**Files:** Create `exam-list-live.tsx` / Test `exam-list-live.test.tsx` / Modify `exams/page.tsx` / Modify `lib/exams/list.ts`

**目的**: 試験一覧の `<ul>` を Dexie `useLiveQuery` 参照の client component に抽出し、card_count を cards mirror から算出。**制約**: mirror read-only、archived 除外・updated_at DESC、skeleton/空状態/list の 3 状態、表示要素(name/バッジ/件数/相対時刻/詳細Link/削除)を回帰なく踏襲。**完了条件**: 下記 test green + `pnpm build` 型/RSC エラーなし + `pnpm exec tsc --noEmit`。

**実装の骨子**(`exam-list-live.tsx`):
```tsx
'use client'
import { useLiveQuery } from 'dexie-react-hooks'
import { getClientDb } from '@/lib/client-db'
import { formatRelativeJa } from '@/lib/exams/format'
// ... Button/Card/Link/ExamStatusBadge/DeleteExamButton/OpenCreateExamButton import

export function ExamListLive({ userId }: { userId: string }) {
  const exams = useLiveQuery(async () => {
    const db = getClientDb()
    const [allExams, allCards] = await Promise.all([
      db.exams.where('user_id').equals(userId).toArray(),
      db.cards.where('user_id').equals(userId).toArray(), // 1 read + JS 集計 (N count query 回避)
    ])
    const countByExam = new Map<string, number>()
    for (const c of allCards) countByExam.set(c.exam_id, (countByExam.get(c.exam_id) ?? 0) + 1)
    return allExams
      .filter((e) => e.archived_at == null)                       // archived_at IS NULL 相当 (== null は undefined も捕捉)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))   // updated_at DESC (ISO string lexicographic)
      .map((e) => ({ id: e.id, name: e.name, updatedAt: e.updated_at, cardCount: countByExam.get(e.id) ?? 0 }))
  }, [userId])

  if (exams === undefined) return /* skeleton (role="status", animate-pulse、dashboard-actions と同型) */
  if (exams.length === 0) return /* 空状態 CTA (アップロード Link + OpenCreateExamButton、現 page.tsx の空状態を移植) */
  return /* <ul> 各行: name / <ExamStatusBadge examId={id}/> / カード {cardCount} 件・最終更新 {formatRelativeJa(new Date(updatedAt))} / 詳細 Link(prefetch=false) / <DeleteExamButton examId={id}/> */
}
```
- 現 `page.tsx` の `<ul>`(L69-101)と空状態(L53-67)の JSX を `ExamListLive` に移植(見た目・class・prefetch=false・文言を維持)。`formatRelativeJa(new Date(updatedAt))` で ISO string を Date 化。
- `page.tsx` 改修: `getActiveExamsWithCardCount` import/呼出を撤去、`<ul>`/空状態 JSX を `<ExamListLive userId={userId} />` に置換。`ExamStatusProvider`/`CreateExamForm`/見出し/auth は保持。
- `lib/exams/list.ts`: `getActiveExamsWithCardCount` + `ExamWithCardCount` を撤去(grep で本 page 以外 caller 無しを確認済 = dead)。

- [ ] **Step 1: 失敗 test**(`exam-list-live.test.tsx`、`@vitest-environment jsdom` + fake-indexeddb。手本 = dashboard 系 useLiveQuery test）。seed: `db.exams` に active 2 + archived 1、`db.cards` に exam 別件数。検証:
  1. **exams 読取 + card_count 算出**: render → `waitFor` で active exam 名 2 件表示、各行のカード件数 = seed の cards 数。
  2. **archived 除外**: archived exam 名が表示されない。
  3. **updated_at DESC**: 表示順が updated_at 降順(新しい exam が先)。
  4. **空状態**: exams 0 件(active 0)→ 空状態 CTA(「まだ試験がありません。」等の文言/アップロード Link)表示。
  5. **skeleton**: render 直後(useLiveQuery undefined)に `role="status"` skeleton、`waitFor` 後に list へ。
  - `ExamStatusBadge` は `ExamStatusProvider` で wrap(空 statusMap)して context エラーを回避、または badge を含む最小 provider で render。`DeleteExamButton` は deleteExam action を mock(または render only)。
- [ ] **Step 2: red** — `pnpm exec vitest run "app/(app)/app/exams/_components/exam-list-live.test.tsx"` → FAIL(未実装)。
- [ ] **Step 3: 実装** — 骨子適用 + page.tsx 切替 + list.ts dead 撤去。
- [ ] **Step 4: green** — 同 test 全 PASS。`pnpm exec tsc --noEmit` + `pnpm build`(RSC/`server-only` 境界エラーなし)確認。
- [ ] **Step 5: commit** — `feat(exams): 試験一覧を Dexie mirror (useLiveQuery) 参照の ExamListLive に切替 + dead getActiveExamsWithCardCount 撤去` + `[no-review]`。

---

## Task 2: exam 削除を Dexie-backed list に live 反映(pull kick)

**Files:** Modify `delete-exam-button.tsx` / Test `delete-exam-button.test.tsx`(無ければ Create)

**目的**: 一覧 page 上で exam を削除したとき、Dexie mirror から当該 exam が消えて list が live に更新されるようにする。**背景**: 削除は server で tombstone を作るが、mirror への反映は pull(tombstone bulkDelete)が要る。従来は `router.refresh()` で RSC が Postgres 再読込し即消えたが、list が Dexie 参照になったため `router.refresh()` では mirror が更新されず**削除した exam が残る**(回帰)。よって削除成功時に pull を kick して tombstone を取り込み、`useLiveQuery` が行を除去する。**制約**: 既存の confirm 2 段/`useTransition`/error UI は不変。`runGuardedPull`(step4、in-flight guard 付き)を再利用。失敗 silent。**完了条件**: 下記 test green + tsc。

**実装の骨子**(`delete-exam-button.tsx` の `onConfirmDelete` 成功分岐):
```tsx
if (result.ok) {
  router.refresh() // statusMap seed 等 RSC 部分の更新は維持
  // list は Dexie 参照のため、 tombstone を mirror に取り込んで行を消すために pull を kick。
  void runGuardedPull({ reason: 'exam-delete' }).catch(() => {})
}
```
`import { runGuardedPull } from '@/lib/sync/pull'`。

- [ ] **Step 1: 失敗 test** — `@/lib/sync/pull` の `runGuardedPull` を vi.mock、`deleteExam` action を mock(ok 返し)。検証: 削除確定(confirm → 削除する)→ `deleteExam` 成功 → `runGuardedPull` が `{ reason: 'exam-delete' }` で 1 回。失敗時(`ok:false`)は `runGuardedPull` 呼ばれない。既存の confirm/error 挙動 test があれば不変通過。
- [ ] **Step 2: red** — 同 test → FAIL。
- [ ] **Step 3: 実装** — 骨子適用。
- [ ] **Step 4: green** — 同 test PASS + tsc。
- [ ] **Step 5: commit** — `feat(exams): exam 削除時に pull を kick し Dexie-backed 一覧へ live 反映` + `[no-review]`。

---

## この step 単体の stg smoke(UI 経由)

認証済 staging + DevTools(IDB `exams`/`cards`・Network `/api/pull`)。exams mirror を初めて読む段。

1. **一覧が Dexie 参照で表示**: `/app/exams` 表示 → IDB `exams`/`cards` mirror から名前・件数・相対時刻が出る。Postgres 直読み時と**見た目・順序が一致**(updated_at DESC)。RSC は `getActiveExamsWithCardCount` を**呼ばない**(Network/DB で確認)。
2. **増分 pull で更新が反映**: 別経路で exam を更新(または card 追加)→ reload/visibility で増分 pull → 一覧の件数/順序が live 更新(`useLiveQuery`)。
3. **削除が一覧から消える(Task 2)**: 一覧で exam を削除 → tombstone → `runGuardedPull` で mirror から bulkDelete → **行が live に消える**(reload 不要)。IDB から当該 exam/cards 消失を確認。
4. **card 件数 live 更新**: card 追加(OCR)/削除(詳細 page)後、pull トリガ(reload/visibility/online)で cards mirror 更新 → 一覧件数が live 反映。
5. **archived 除外 / OCR バッジ**: archived 試験は出ない。処理中/失敗バッジは従来どおり `ExamStatusBadge` polling で表示・clear。
6. **未 pull 時 skeleton**: mirror 未充足/初回 undefined で skeleton(layout shift なし)。
7. **回帰**: Postgres 直読み→Dexie 読みで一覧の見た目・詳細遷移・削除・空状態 CTA が不変。

全観点 PASS で 2 feat commit を `[reviewed]` へ amend(step 1-5 同手順 filter-branch)。FAIL は amend せず報告で停止。

---

## Self-Review(spec 整合)

- §4(list 部分のみ client 抽出 / archived 除外・updated_at DESC / card_count は cards mirror 算出・`exams.card_count` 列読まない / RSC は auth・statusMap・CreateExamForm 保持 / `ExamStatusBadge` polling 維持 / skeleton / 詳細 page スコープ外)→ Task 1。
- exams mirror が dead read でなくなる(OT 動機実現)→ Task 1。削除の live 反映 → Task 2。
- placeholder なし。型整合: `ExamListLive`/`ClientExam`/`runGuardedPull` 一貫。dead code(`getActiveExamsWithCardCount`)撤去。

---

## 実装前に確認・判断が要る点(spec/実コード食い違い・要 OT 認識)

- **U1(空状態 CTA の所在・確定)**: spec §4 は「RSC が空状態 CTA を保持」と記すが、**空状態判定は exam 件数 = Dexie 由来のため client(`ExamListLive`)に移る**必要がある。CTA 部品(`OpenCreateExamButton` / アップロード Link)は client で問題なく描画可。→ 本 plan は空状態を `ExamListLive` に移植(spec 文言の自然な具体化、機能不変)。
- **U2(OCR 完了/card mutation の card_count 即時性・要 OT 判断)**: 従来 `ExamStatusProvider` の OCR 完了 `router.refresh()` が RSC で Postgres 件数を即再読込していたが、list が Dexie 参照になり **`router.refresh()` では件数が更新されない**(新 OCR cards は次 pull で mirror に入る)。本 plan は **既存の pull トリガ(reload/visibility/online)に委ねる**(smoke 観点4 は reload/visibility で検証)。**即時性が要るなら** `ExamStatusProvider` の completed 遷移で `runGuardedPull` を 1 回 kick する追加 task を提案(任意・OT 判断)。card 詳細 page の card 削除はスコープ外のため、その件数即時反映も同様にトリガ依存。**既定: トリガ依存(追加 kick なし)**。
- **U3(card_count 算出方式・確定)**: cards mirror を 1 read(`where('user_id')`)+ JS で `exam_id` 集計(Map)。exam 数 × `where('exam_id').count()` の N round-trip は採らない(dashboard と同じ単一 read pattern、件数規模も小)。
- **U4(削除の反映手段・要 OT 認識)**: Task 2 は **pull kick**(mirror を pull 駆動に保つ、tombstone が単一の削除経路)で記述。代替は **optimistic local delete**(`db.exams.delete`+`db.cards` 局所削除、即時だが mirror read-only 不変条件をわずかに破り次 pull で reconcile)。**既定: pull kick**(architectural 一貫)。OT が体感速度優先なら optimistic。
- **`getActiveExamsForUser`(upload page 使用)/ 詳細 page / `ExamStatusBadge` polling / `formatRelativeJa`** は変更なし(確認済)。spec との食い違いは U1/U2 のみ(いずれも Dexie 化の自然な帰結)。
