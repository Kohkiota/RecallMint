# Sprint I(画像 4 欄化)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画像添付を問題文 / 各選択肢 / 解説 / メモ の 4 面に拡張し、選択肢削除時の zombie 画像による誤紐付き破損を閉じる。

**Architecture:** spec `docs/superpowers/specs/2026-07-15-sprint-i-image-four-fields-design.md`(承認済・凍結)。HEAD 再検証(spec §2)により実変更点は ①削除 cascade ②schema widen ③gallery 増設 ④学習面 read-only の 4 点のみ。handleImages / card_asset_refs / GC / discovery / backfill は field 非依存で無改修・migration 不要。

**Tech Stack:** 既存のみ(新 dep なし)。Dexie mirror + entity_mutations outbox / `attachImageToCard`・`removeImageFromCard`(`lib/media/upload.ts`)/ Vitest + fake-indexeddb。

## 全体ルール(各 task に適用・task からは参照)

1. 全 task feat = **TDD(test first)** → canonical + Codex review → **Crit0/Imp0 収束** → `[reviewed]` commit。**per-task で full test green**(赤で task 間を連結しない・RED を commit しない)。
2. **新 gallery instance は必ず既存 `attachImageToCard` / `removeImageFromCard` を経由**し、target 部分集合の独自 commit を新設しない(spec §3 不変条件。attach/remove の全配列 fresh read/write が refs 全置換の union を構造的に保つ = GC 孤児化の唯一の破壊経路を塞ぐ)。
3. `MAX_IMAGES_PER_CARD = 10` は **card 全体(4 面合計)のまま維持**(既存 pre-check は全配列 length・per-field 上限は作らない = YAGNI)。
4. target 語彙(spec §4.1): `'question_text'` / `'option:<id>'` / `'explanation_text'` / `'memo'`。OCR legacy(非 UUID key・`option_1` 語彙)は別 namespace で不干渉・cascade / gallery の対象外(`isAssetKey` filter)。
5. test は実 Dexie(fake-indexeddb)+ server action / R2 / reclaim は mock(実 I/O 禁止)。
6. 自走継続・停止条件・spec 凍結は CLAUDE.md 準拠。

---

### Task W1: 選択肢削除の画像 cascade(test first)

**目的**: `nextOptionId` の削除済 id 再利用 × `handleDeleteOption` が images を触らない zombie 残存が重なると、旧画像が新選択肢へ誤紐付く(spec §3)。削除時に該当 `option:<id>` 画像を cascade 除去して破損 window と storage リークを同時に閉じる。

**Files**: Modify `app/(app)/app/exams/[id]/_hooks/use-card-options.ts`(`handleDeleteOption` + hook 引数に `userId` 追加)/ `inline-option-row.tsx`・`card-editor-fields.tsx`(userId 透過の配線のみ)/ Test `use-card-options.test.tsx`。

**設計(decouple・OT plan 入力 1)**:
- 順序 = **選択肢削除を先に確定**(既存 `commit(nextAll, true)`)→ **画像 cascade は後段 best-effort**(fire-and-forget async)。逆順にしない(「画像が消せないから選択肢も消せない」を禁止 = DB 状態変更を fallible 操作の成功に gate しない)。
- cascade 本体: 削除前に `optionsRef.current[idx].id` を捕捉 → commit 後に `getClientDb().cards.get(cardId)` → `images` から `isAssetKey(key) && target === 'option:<id>'` の key を抽出 → **直列 for-await** で各 key を既存 `removeImageFromCard` で除去(**部分失敗は assetId 単位で warn し継続** = 1 件失敗が残り件の除去を止めない)→ 成功分を `reclaimLocalAssetBlobs(userId, keys)` fire-and-forget。**reclaim は 2 段が正**(Codex 指摘で確定: `removeImageFromCard` は reclaim を内蔵せず、gallery `handleDelete` も remove 後に別途 reclaim を呼ぶ現物 2 段構成 — spec §3 括弧書き「reclaim 内蔵」は事実記述として不正確。実装は gallery と同型の 2 段に倣う)。※ `useCardOptions` は `userId` を持たないため hook 引数に追加し、caller(**`InlineOptionList` が唯一の consumer**)経由で `CardEditorFields` の既存 `userId` prop を透過(+ `use-card-options.test.tsx` の renderHook 追随)。
- **競合との整合**: cascade の remove は `removeImageFromCard` 内蔵の per-card 直列化 + fresh read に乗るため、削除直後の並行 attach/remove とは「最後の操作勝ち」で収束(追加実装なし)。
- **失敗記録(OT plan 入力 1)**: `removeImageFromCard` の reject は `logger.warn({ event: 'card_option_delete.image_cascade_failed', cardId, optionId, assetId })` で記録して継続(選択肢削除は確定済・rollback しない)。**`integration_failures` 台帳には乗せない** — 同台帳は server 側 reconciliation(Sprint2 B1)の器で client からの書込経路が無い。client 側の既存失敗記録語彙(`card_inline.delete.tx_failed` 等の logger イベント)に揃える。残置 zombie は次回同 id 削除時の再 cascade または手動削除で回収可能(GC は ref 存在で削除しない = 安全側)。**self-heal / UI 再試行 / add 前 stale cleanup は作らない**(YAGNI: cascade 失敗 = local Dexie 書込障害級の稀事象 × 同 id 再利用の二重条件。warn で検知可能。Codex 論点として OT に提示済)。

**test(先行・破損回帰)**: ① `option:b` 画像を持つ選択肢 b を削除 → 新選択肢追加で id `b` が再利用 → `cards.get().images` に `target='option:b'` が**無い**(cascade 済ゆえ誤紐付きしない)② union 非破壊: `question_text` 画像・他選択肢(`option:a`)画像・legacy 非 UUID entry は残る ③ cascade 失敗(removeImageFromCard mock reject)でも options の削除 commit は確定 + warn 記録。**async 観測点**: cascade は fire-and-forget ゆえ、test は `waitFor` で mirror(`cards.get().images`)の収束を観測する(fake-indexeddb 実 Dexie・fake timers 不使用)。**非空振り**: cascade を neuter(除去 skip)して ① が RED になることを commit 前 review 時に確認・報告(RED は commit しない)。

**完了条件**: 上記 test + 既存 option/hook test 回帰なしで green・Crit0/Imp0・`[reviewed]`。

---

### Task W2: imageEntrySchema target widen

**目的**: 解説/メモ target を validation で許容する(spec §4.1。widen が無いと W3 の attach が server `handleImages` で 'failed' になる)。

**Files**: Modify `lib/validation/card.ts`(refine・現 :110 相当)/ Test 既存 validation test(`lib/validation/card.test.ts` 系)に追加。

**制約**: refine を `['question_text', 'explanation_text', 'memo'].includes(entry.target) || /^option:.+/.test(entry.target)` に widen(エラーメッセージも 4 面語彙へ更新)。**追加のみ**(既存 `question_text` / `option:` 実データは従来どおり通る)。legacy(非 UUID key)passthrough は不変。server / client 双方がこの共有 schema を経由するため変更は 1 箇所。

**test**: `explanation_text` / `memo` の UUID-key entry 通過・未許容 target(`'body'` 等)reject 継続・legacy passthrough 不変・url 非空 reject 不変。

**完了条件**: test green・既存 imagesSchema test 回帰なし・Crit0/Imp0・`[reviewed]`。

---

### Task W3: gallery 増設(compact 形態 + 編集面 4 面配線)

**目的**: 編集面(list + side-peek 共有の `CardEditorFields`)で 4 面すべてに添付 UI を出す。選択肢は §9(多択行高肥大)を悪化させない compact 形態(spec §4.2)。

**Files**: Modify `app/(app)/app/exams/[id]/_components/card-image-gallery.tsx`(compact prop)/ `card-editor-fields.tsx`(解説・メモ gallery + InlineOptionList への props 透過)/ `inline-option-row.tsx`(`InlineOptionList` に `images`・`userId` props 追加 + 各 `<li>` 内 Row 直後に compact gallery)/ Test `card-image-gallery.test.tsx` 系 + list 結合 test。

**compact affordance の実物(OT plan 入力 2・既存 UI 語彙に揃える)**:
- `CardImageGallery` に `compact?: boolean`。**thumbnail 描画は不変**(h-16 既存)。変わるのは空/add affordance のみ。
- affordance = 生 button `h-6 w-6`(24px)— **gallery 内既存 icon 語彙 = thumbnail の × 削除 button(`min-h-6 min-w-6`)と同寸**。中身は lucide `ImagePlus` `size-3.5`(Button size-xs の svg 語彙)。**aria-label は文脈付け**(Codex a11y 指摘採用): `CardImageGallery` に `attachAriaLabel?: string` を追加し、選択肢 instance は `'選択肢 ' + opt.id + ' に画像を追加'` を渡す(既定 = 「画像を追加」・複数 option で同名 button が並ぶ SR 不可判別を回避)。`text-slate-400 hover:bg-slate-100 hover:text-slate-900` + 既存 focus-visible ring。click/tap = 既存 `fileInputRef.click()`(hidden input・attach 経路共有 = 全体ルール 2)。dashed「画像を追加」テキストボタンと空 flex container は compact では出さない。
- 設置位置: `InlineOptionList` の各 `<li>` 内・`InlineOptionRow` の**直後**(Row は un-export presentational のまま不変・grid 非改変)。`target={'option:' + opt.id}`。
- **§9 影響記録**: 空選択肢の増分 = 24px icon 1 個/選択肢(常時 dashed gallery なら ~52px+/選択肢)。画像を持つ行のみ thumb 高が乗る。行高変動は Sprint F の measureElement が吸収(spec §4.2 の 1 行記録を session doc へ転記)。
- 解説/メモ = 問題文と同じ**常時形態**で `InlineTextField` 直下に `target='explanation_text'` / `'memo'` を増設(card あたり各 1 個・選択肢数非比例ゆえ §9 無関係)。

**test**: 4 面それぞれ attach → `cards.images` に正しい target で entry 追加 / remove で消える(既存 gallery test を target parametrize)・compact 空 = icon affordance のみ(dashed テキスト不在)・compact readOnly 空 = null 不変。

**完了条件**: test green(既存 gallery/editor test 回帰なし)・Crit0/Imp0・`[reviewed]`。

---

### Task W4: 学習面 read-only 表示

**目的**: 4 面画像を「解く/答え合わせ」時に見せる(spec §4.3・W4 なしは機能破綻。memo は学習非表示ゆえ除外)。

**Files**: Modify `app/(app)/app/study/smart/_components/session-runner.tsx` / Test `session-runner.test.tsx`。

**制約**:
- 選択肢: 各 `<li>` 内・選択 `<button>` の**外**(直後)に `readOnly` gallery `target={'option:' + opt.id}`(button 内は nested interactive になるため禁止)。readOnly + 0 件 → null(既存)ゆえ空選択肢は DOM 増ゼロ。**readOnly thumbnail は非 interactive**(click しても選択動作と独立・何も起きない = 既存 readOnly gallery と同挙動)。option 画像は選択フェーズから表示(reveal 非依存)ゆえ判定前後の DOM 変化は既存 explanation 節の増減と同型。
- 解説: 解説 div 内に `target='explanation_text'` readOnly を追加。**表示条件を「`explanationText` truthy または explanation_text 画像あり」に拡張**(現条件はテキスト truthy のみ → 画像だけ添付した card で解説節ごと消えるエッジを閉じる)。判定は `current.images` の UUID-key `explanation_text` entry 有無。
- 問題文 gallery(既存)不変。添付/削除 UI は一切出さない(readOnly)。

**test**: option / explanation 画像が read-only 表示される・「画像を追加」「×」affordance 不在・explanation テキスト無し + 画像ありの card で解説節が表示される・テキストも画像も無い card では解説節が出ない(既存挙動不変)。

**完了条件**: test green(既存 session-runner test 回帰なし)・Crit0/Imp0・`[reviewed]`。

---

### Task F: 完了 gate + handoff

**目的**: sprint 完了 gate と OT への引き渡し。

**手順**: ① whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm typecheck` / `pnpm test` 全 exit 0(報告に「whole-repo lint exit 0 確認済」明記)② session doc(`docs/superpowers/sessions/`)に commit range・per-task 要点・§9 影響記録・OT smoke checklist(spec §7 の 6 項: 4 面添付+reload 復活 / 削除の非復活 / 選択肢削除の追随 / GC 非孤児化 / §9 非悪化 / 学習面 read-only)を記載し `docs(session)` `[no-review]` commit ③ stop checkpoint 報告 → OT push → OT smoke。

**完了条件**: 3 gate exit 0・session doc commit 済・working tree clean・stop checkpoint 報告。

---

## 実行順序と依存

W1(独立・破損防止を最優先)→ W2(W3 解説/メモの前提)→ W3(W2 依存)→ W4(W2 依存・W3 と独立だが直列で回す)→ F。
