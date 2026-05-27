# /app/cards/[id] 廃止 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/app/cards/[id]` 個別 card 編集 page (S2.0 で導入後 inline 編集主軸化で dead code 化) を、 自己参照 9 file + 副次依存 4 modify + 1 delete + lib 部分削除を含めて 1 commit で一括撤去する。

**Architecture:** 単純な dead code cleanup。 機能変更なし (削除後の inline 編集挙動は S-cache-2a で確立済の Next.js 15 server action 自動再実行で完全維持)。 副次依存は (a) revalidatePath dead 行 + test assertion / (b) lib helper の使用箇所が削除 page だけ / (c) lib の部分 export 削除 (`optionSchema` 1 個を残し他 4 export 削除) / (d) comment 更新 の 4 種。

**Tech Stack:** Next.js 15 App Router / TypeScript strict / Drizzle / Vitest / pnpm

**関連 spec:** `docs/superpowers/specs/2026-05-27-app-cards-id-removal-design.md` (touch list 13 file / 部分削除境界 / 代替経路不要根拠 / test 影響を完全明示)

**関連 roadmap:** `docs/cache-fix-roadmap.md` §④-3

---

## Plan-wide rules

各 task 共通 (再掲しない):

- **CLAUDE.md 絶対ルール準拠**: Clerk / Stripe / AI は本 task で touch しない
- **brief 指示「1 commit で完結」 厳守**: 自己参照削除 + 副次整理を分割 commit しない (= 削除完了後の中間状態を残さない、 build / test が必ず通る状態で commit)
- **既存 test は壊さない**: 873 → ~860 前後 (削除分減) で全 pass、 修正対象は `update-card-field.test.ts:284-289` の revalidatePath assertion 1 件のみ
- **TDD 適用範囲**: 本 task は dead code 削除のため failing test 先行不要。 既存 test が baseline 873 pass を担保、 削除後も全 pass + 副次 modify 後も全 pass で完了判定
- **review 経路**: `superpowers:requesting-code-review` skill canonical (general-purpose subagent + 厳格 prompt + template 改変なし)
- **commit tag**: 実装ロジック変更 (lib/validation/card.ts 部分削除 + update-card-field 挙動) を含む refactor のため **formal review 必須**、 `[reviewed]` tag (`[no-review]` 不可)
- **完了判定**: `pnpm exec tsc --noEmit` clean + `pnpm test -- --run` 全 pass + Critical 0 / Important 0 + 1 commit
- **やらないこと** (spec §3 Out 参照): inline 編集 UI 改修 / 他 dead code 棚卸し / 再導入議論 / LocalSync MVP への影響反映

---

## Task 1: /app/cards/[id] + 副次依存一括削除 (1 commit)

**目的:** spec §3 で確定した touch list 13 file (自己参照 9 + 副次 modify 4 + lib delete 1) を spec §5 部分削除境界 + spec §6 代替経路不要根拠に従い一括撤去、 機能変更ゼロで dead code をクリーンに除く。

**制約:**
- spec §3 (a) の 9 file は **dir 単位で rm** (`app/(app)/app/cards/` 配下を空にする、 ただし `app/(app)/app/cards/[id]/` のみ削除で `app/(app)/app/cards/` 自体が空 dir になれば dir も rm)
- spec §3 (b) #1 `lib/cards/get-card-for-edit.ts` は file 削除
- spec §3 (b) #2 `lib/validation/card.ts` は **部分削除** (`optionSchema` のみ残す、 他 4 export = `updateCardInputSchema` / `UpdateCardInput` / `ParseUpdateCardResult` / `parseUpdateCardInput` を削除) + docstring を「inline 編集 (option) の validation」 に更新
- spec §3 (b) #3 `update-card-field.ts:159` は `revalidatePath` 行のみ削除 + 直前 comment (`:152-158`) を S-cache-2a 自動再実行根拠だけに整理 (cross-page revalidate 言及撤去)
- spec §3 (b) #4 `update-card-field.test.ts:284-289` は revalidatePath assertion のみ削除 (同 file 内の他 case は維持)
- spec §3 (b) #5 `app/(app)/app/exams/[id]/page.tsx:15` の comment は「page は廃止済、 全 inline で完結」 に書換
- spec §4 残置: `inline-card-list.test.tsx:65` の test と test 名内文言は **触らない**
- TypeScript strict / kebab-case file (CLAUDE.md コーディング規約)

**Steps:**

- [ ] **Step 1.1**: baseline 確認 — `pnpm test -- --run` で現状 873 pass を verify、 `pnpm exec tsc --noEmit` clean を verify (削除前の green を base に据える)
- [ ] **Step 1.2**: `app/(app)/app/cards/[id]/` 配下 9 file を `git rm` (page / loading / 2 actions + tests / 2 components + tests)。 親 dir が空になれば dir も整理
- [ ] **Step 1.3**: `lib/cards/get-card-for-edit.ts` を `git rm`
- [ ] **Step 1.4**: `lib/validation/card.ts` を部分編集 (4 export 削除 + docstring 更新、 `optionSchema` のみ残す)
- [ ] **Step 1.5**: `app/(app)/app/exams/[id]/_actions/update-card-field.ts` を編集 (`:159` revalidatePath 行削除 + `:152-158` comment 整理)
- [ ] **Step 1.6**: `app/(app)/app/exams/[id]/_actions/update-card-field.test.ts:284-289` の revalidatePath assertion を削除
- [ ] **Step 1.7**: `app/(app)/app/exams/[id]/page.tsx:15` の comment 書換
- [ ] **Step 1.8**: `pnpm exec tsc --noEmit` で clean を verify (削除影響で残骸 import / 未参照型がないことの確認)
- [ ] **Step 1.9**: `pnpm test -- --run` で全 pass を verify (削除分減で ~860 前後、 inline-card-list.test.tsx:65 含む既存 case 維持)
- [ ] **Step 1.10**: `superpowers:requesting-code-review` skill canonical 経路で review (general-purpose subagent + template 改変なし)
- [ ] **Step 1.11**: review 結果を chat で declare (経路 / Critical N / Important N / Minor N / Important 残置の有無)
- [ ] **Step 1.12**: Critical 0 / Important 0 を確認後、 `[reviewed]` tag 付き 1 commit (commit type = `refactor(perf)` 推奨)

**完了条件:**

- spec §3 touch list 13 file の差分が全て commit 内に含まれる
- spec §4 残置 (inline-card-list.test.tsx:65) は untouched
- `pnpm exec tsc --noEmit` clean
- `pnpm test -- --run` 全 pass
- review Critical 0 / Important 0
- commit message 末尾 `[reviewed]` tag

---

## Self-review (本 plan)

spec カバレッジ:

- [x] spec §3 (a) 自己参照 9 file 削除 → Step 1.2
- [x] spec §3 (b) #1 lib/cards/get-card-for-edit.ts 削除 → Step 1.3
- [x] spec §3 (b) #2 lib/validation/card.ts 部分削除 → Step 1.4 + spec §5 境界参照
- [x] spec §3 (b) #3 update-card-field.ts:159 revalidatePath 削除 → Step 1.5
- [x] spec §3 (b) #4 update-card-field.test.ts revalidatePath assertion 削除 → Step 1.6
- [x] spec §3 (b) #5 page.tsx:15 comment 書換 → Step 1.7
- [x] spec §4 残置 (inline-card-list.test.tsx:65) → 制約セクションで untouched 明示
- [x] spec §6 代替経路不要根拠 → 制約セクション + spec 参照 (router.refresh 等追加なし)
- [x] spec §7 test 影響 → Step 1.9 (削除分減 + assertion 1 件削除)
- [x] spec §8 完了条件 → Task 1 完了条件 + Plan-wide rules

placeholder scan: TBD / TODO / 「適切に」 等の vague 語なし。

type / 命名整合性: `optionSchema` / `updateCardInputSchema` / `parseUpdateCardInput` 等の名称は spec / 実コードと一致。

scope: 1 task 1 commit で完結、 sub-project 分割不要。

**最終行数: 117 行 / 上限 250**
