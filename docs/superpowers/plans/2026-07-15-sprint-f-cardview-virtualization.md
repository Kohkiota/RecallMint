# Sprint F: カードビュー freeze 修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** カードビュー(`inline-card-list.tsx`)の O(N) 再レンダー freeze を、仮想化 + 前提ガード 2 件(G→W0→W1→W2→S)で解消する。

**Architecture:** spec = `docs/superpowers/specs/2026-07-15-sprint-f-cardview-virtualization-design.md`(rev2・OT 承認済)。安全網 test → 行 component verbatim 抽出 → autoEdit consume → option commit-on-unmount → `useWindowVirtualizer` 仮想化の一方向。

**Tech Stack:** React 19 / `@tanstack/react-virtual@3.14.5`(導入済・新 dep なし)/ Dexie / Vitest + RTL(jsdom)。

## Global Constraints(全 task 共通・spec 準拠)

- **順序**: Task 番号順に直列実行。**W0/W1/W2 完了前に S に着手しない**(spec §2 順序制約)。
- **review**: 全 task canonical(`superpowers:requesting-code-review` デフォルト経路)+ Codex(`scripts/ai/codex-review.sh`)、Critical 0 / Important 0 まで(上限 3 周)。commit 直前の 4 点宣言必須。
- **tag**: G/W0/W1/S = `[reviewed]` 通常則。**W2 のみ tag 無し commit**(データ保全 fix・OT smoke 後に session doc を [reviewed] 正記録 = GC v2 W2 前例)。
- **test**: `pnpm test <file>` 単位で green 確認。**既存 test の書き換えで green にしない**(崩れたら実装を疑う・spec §8.5)。mock で unmount を握らない(実 `unmount()` 経由・spec §7.3)。
- 型: TS strict。命名: file kebab-case / 関数 camelCase / 定数 UPPER_SNAKE_CASE。コメントは「なぜ」のみ。scope 外のコードに触らない(spec §12「触らない」list)。
- 完了 gate(最終 task): whole-repo `pnpm lint`(--max-warnings=0)exit 0 + `pnpm test` 全 green。

---

### Task G: 安全網 — option cell「blur 後 unmount で追加書込なし」characterization

**Files:** Test: `app/(app)/app/exams/[id]/_components/inline-option-row.test.tsx`(describe 追加のみ)
**Interfaces:** Produces: test「blur 済み後 unmount → mirror/outbox 追加書込なし」— **W2 の #5(blur→unmount 二重 commit ガード)と同一 test**。W2 で書き直さず green 維持する(二重実装禁止・spec §5 / §7.3)。

- [ ] Step 1: 既存 test 資産(同 file の startTextEdit / mirror seed helper)を流用し、「text cell 編集 → blur(commit 1 回発生を assert)→ `unmount()` → mirror 書込・enqueue が増えていない」を追加。現挙動(cleanup は timer clear のみ = F4)で green になることを確認。
- [ ] Step 2: `pnpm test app/\(app\)/app/exams/\[id\]/_components/inline-option-row.test.tsx` green(既存含む全 pass)。
- [ ] Step 3: canonical + Codex review → 宣言 → commit `test(exams): option cell blur後unmountの無追加書込を pin(Sprint F G)[reviewed]`

**完了条件:** 新 test green・既存無傷・Crit0/Imp0。

### Task W0: InlineCardRow verbatim 抽出(挙動不変)

**Files:** Modify: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx`(map 中身 :269-318 を module scope へ移動)
**Interfaces:** Produces: `InlineCardRow`(module scope・props = 現 map が閉包参照する値そのまま: `card, userId, categories, options, cardTags, autoEditOnMount`)。W1 が mount effect を、S1 が measureElement ref を後からここに足す。

- [ ] Step 1: `<li key={card.id}>` の中身を **verbatim 移動のみ**で `InlineCardRow` へ。hook 追加なし・props 追加なし・JSX/className 変更なし・render 内定義禁止(module scope)・key は `card.id` のまま親 map 側に残す。
- [ ] Step 2: `pnpm test app/\(app\)/app/exams/\[id\]/_components/inline-card-list.test.tsx app/\(app\)/app/exams/\[id\]/_components/inline-card-list-live.test.tsx` — **test 変更ゼロで全 green** = 挙動不変の客観証明(spec §6.1)。
- [ ] Step 3: canonical + Codex review → 宣言 → commit `refactor(exams): InlineCardRow を module scope へ verbatim 抽出(Sprint F W0)[reviewed]`

**完了条件:** 既存 test 無傷 green・diff が移動のみ(reviewer 観点に「verbatim 性」を明示)・Crit0/Imp0。

### Task W1: newCardIds consume 経路

**Files:** Modify: `inline-card-list.tsx`(親: `consumeNewCardId` / 行: mount effect)。Test: `inline-card-list.test.tsx`
**Interfaces:** Consumes: W0 の `InlineCardRow`。Produces: 親 `consumeNewCardId(id: string): void`(functional updater で Set から削除・useCallback 安定化)、`InlineCardRow` 新 props `autoEditOnMount: boolean` + `onAutoEditConsumed(id: string): void`。

- [ ] Step 1(test first): 「追加 → auto-edit 発火 → 該当行を実 unmount → remount(key 変更 or rerender)しても edit mode に入らない」を RED で追加。
- [ ] Step 2: `InlineCardRow` に mount effect(empty deps): `autoEditOnMount` が true なら `onAutoEditConsumed(card.id)`。消すのは**親の Set のみ**(子の one-shot useState initializer は render 中に読取済 = 初回 auto-edit は構造的に先行、spec §6.2)。冪等(Set delete)・StrictMode 二重実行安全。
- [ ] Step 3: 新 test green + 既存 `:442-509`(追加→auto-edit / 2 連続)無傷 green。
- [ ] Step 4: canonical + Codex review → 宣言 → commit `fix(exams): newCardIds に mount 時 consume を追加(Sprint F W1)[reviewed]`

**完了条件:** 新旧 test green・`inline-card-list.tsx:162-179` の依存コメントを consume 実装済みの記述へ更新・Crit0/Imp0。

### Task W2: InlineOptionCell commit-on-unmount(データ保全)

**Files:** Modify: `app/(app)/app/exams/[id]/_components/inline-option-row.tsx`(cell latestRef + cleanup)、`app/(app)/app/exams/[id]/_hooks/use-card-options.ts`(existence gate 付き unmount 保存)。Test: `inline-option-row.test.tsx`
**Interfaces:** Consumes: Task G の #5 test(書き直さず green 維持)。Produces: `useCardOptions` に `unmountSave(option: CardOption): void`(`getClientDb().cards.get(cardId)` 存在時のみ既存 commit 経路 — F6 対応)、`InlineOptionCell` 新 prop `onUnmountSave: (value: string) => void`(Row/List 経由で unmountSave へ配線)。

- [ ] Step 1(test first): `inline-text-field.test.tsx:820-924` と対称の 4 本を RED で追加 — #1 editing+dirty→unmount→mirror+enqueue / #2 not-editing guard / #3 clean guard / #4 card 削除後 unmount→enqueue なし(存在 gate)。**#5 は Task G の test をそのまま流用**(追加実装後も green のままであることが二重 commit ガードの検証)。全て実 `unmount()` 経由(spec §7.3)。
- [ ] Step 2: cell に latestRef 自己整合 snapshot + empty-deps cleanup(`inline-text-field.tsx:101-164` と同型)。blur handler で `latestRef.editing=false` を同期反映(Codex P2 同型)。blur 経路は不変。
- [ ] Step 3: 4 本 green + G test green 維持 + 既存 option test 無傷。
- [ ] Step 4: canonical + Codex review → 宣言 → commit `fix(exams): InlineOptionCell に commit-on-unmount を付与(Sprint F W2)` — **tag 無し**(Global Constraints の W2 方針)。

**完了条件:** 5 観点 green(#5 は G 由来)・side-peek workaround(F5)無変更で共存・Crit0/Imp0。

### Task S1: 仮想化 core(useWindowVirtualizer・表示不変)

**Files:** Modify: `inline-card-list.tsx`。Test: `inline-card-list.test.tsx`(有界窓 test 追加)
**Interfaces:** Consumes: W0 の `InlineCardRow`。Produces: 行 `<li>` に `data-index` + `ref={measureElement}`(S2 と有界窓 test が依存)、定数 `ESTIMATED_CARD_HEIGHT`。

- [ ] Step 1(実測・勘で置かない): 既存 300 件 seed 試験のカードビュー(仮想化前の現 DOM)で DevTools MCP evaluate: `const h=[...document.querySelectorAll('ul>li')].map(e=>e.getBoundingClientRect().height).sort((a,b)=>a-b); ({median: h[Math.floor(h.length/2)], p90: h[Math.floor(h.length*0.9)], n: h.length})` — **中央値を `ESTIMATED_CARD_HEIGHT` とし、実測値と測定環境を本 plan 末尾へ追記**(spec §9 再燃条件の基準値)。ローカル dev で seed 済 DB に到達できない場合は stg で実測。どちらも不可なら seed データ形状(選択肢数 × option 行高 + chrome)からの導出値を代用し、報告に「実測代替」と明記。
- [ ] Step 2: `useWindowVirtualizer` 配線 — `count`/`estimateSize:()=>ESTIMATED_CARD_HEIGHT`/`overscan:3`/`getItemKey:(i)=>cards[i].id`/**`scrollMargin`=リスト先頭 offset**(window 座標原点合わせ・spec §8.1)。`<ul>` 内 = top spacer `<li aria-hidden>` + `getVirtualItems()` map(`InlineCardRow` に `data-index` + `ref={measureElement}`)+ bottom spacer。**行間 `space-y-3 md:space-y-2` margin を li 内 padding へ移す**(measureElement は margin を測らない・spec §8.2。視覚間隔は不変)。型 swap 厳禁・per-row memo 導入しない(spec §8.4)。
- [ ] Step 3(有界窓 test・F9 先例): N=100 seed → **`container.querySelectorAll('li[data-index]')` で row のみ数え**(素朴な `<li>` は spacer 2 本を含むため不可)`0 < count < 100`。既存 test(小 N)は test 変更ゼロで green 維持。
- [ ] Step 4: canonical + Codex review → 宣言 → commit `fix(exams): カードビューを useWindowVirtualizer で仮想化(Sprint F S1)[reviewed]`

**完了条件:** 有界窓 test green・既存無傷・ESTIMATED_CARD_HEIGHT の根拠値記録・Crit0/Imp0。

### Task S2: 「+ カードを追加」UX(scrollToIndex)

**Files:** Modify: `inline-card-list.tsx`。Test: `inline-card-list.test.tsx`
**Interfaces:** Consumes: S1 の virtualizer instance / W1 の `newCardIds`。Produces: list-level effect(追加 card の可視化)。

- [ ] Step 1: list-level effect(`[cards, newCardIds]`): `newCardIds` の id が `cards` に現れたら該当 index へ `scrollToIndex(idx, {align:'auto'})`(可視なら no-op)。**動的行高ズレの mitigation(二段構え・OT 入力 1)**: scrollToIndex は estimate 基準の概算で行を mount させるだけとし、**正確な位置合わせは mount 後の auto-edit `focus()` の browser 標準 scroll-into-view に委ねる**(`inline-text-field.tsx:110-114` 既存挙動)。追い scroll の自前実装は足さない(YAGNI・smoke ⑤ で不足が出たら再検討)。
- [ ] Step 2(test): 追加 → effect が scrollToIndex を呼ぶ(virtualizer method spy・jsdom では scroll 自体 no-op のため呼出のみ検証)+ 既存の追加→auto-edit test 無傷。end-to-end の着地精度は smoke ⑤(Global 外・OT)。
- [ ] Step 3: canonical + Codex review → 宣言 → commit `fix(exams): 追加カードの可視化 scroll を仮想化に対応(Sprint F S2)[reviewed]`

**完了条件:** spy test green・既存無傷・Crit0/Imp0。

### Task F: sprint 完了 gate + OT 引き渡し

**Files:** Create: `docs/superpowers/sessions/2026-07-XX-sprint-f-completion.md`(完了記録・W2 [reviewed] 正記録の受け皿)

- [ ] Step 1: whole-repo `pnpm lint` exit 0 / `pnpm test` 全 green / `pnpm typecheck` exit 0 を実行し報告に明記。
- [ ] Step 2: 完了記録 doc(range・review 結果・ESTIMATED_CARD_HEIGHT 根拠値・spec §10 smoke checklist 6 項の手順)を commit(`docs(session): ...[no-review]`)。
- [ ] Step 3: stop checkpoint 報告 → OT push → OT smoke(spec §10)。**freeze 残存時は spec §11 分岐**(糊塗禁止・claude.ai へ Critical 即上げ)。W2 の [reviewed] は smoke 後に本 doc へ追記。

**完了条件:** 3 gate exit 0・報告に「whole-repo lint exit 0 確認済」1 行・smoke 手順が OT へ渡る状態。

---

## 実測記録(Task S1 Step 1 で追記)

- ESTIMATED_CARD_HEIGHT = (未実測)/ 測定環境: / median: / p90: / n:
