# Sprint I(画像 4 欄化)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画像添付を問題文 / 各選択肢 / 解説 / メモ の 4 面に拡張し、選択肢削除時の zombie 画像による誤紐付き破損を閉じる。

**Architecture:** spec `docs/superpowers/specs/2026-07-15-sprint-i-image-four-fields-design.md`(承認済・凍結)。HEAD 再検証(spec §2)により実変更点は ①削除 cascade ②schema widen ③gallery 増設 ④学習面 read-only の 4 点のみ。handleImages / card_asset_refs / GC / discovery / backfill は field 非依存で無改修・migration 不要。

**Tech Stack:** 既存のみ(新 dep なし)。Dexie mirror + entity_mutations outbox / `attachImageToCard`・`removeImageFromCard`(`lib/media/upload.ts`)/ Vitest + fake-indexeddb。

## 全体ルール(各 task に適用・task からは参照)

1. 全 task feat = **TDD(test first)** → canonical + Codex review → **Crit0/Imp0 収束** → `[reviewed]` commit。**per-task で full test green**(赤で task 間を連結しない・RED を commit しない)。
2. **新 gallery instance は必ず既存 `attachImageToCard` / `removeImageFromCard` を経由**し、target 部分集合の独自 commit を新設しない(spec §3 不変条件。attach/remove の全配列 fresh read/write が refs 全置換の union を構造的に保つ = GC 孤児化の唯一の破壊経路を塞ぐ)。
3. `MAX_IMAGES_PER_CARD = 10` は **card 全体(4 面合計)のまま維持**(既存 pre-check は全配列 length・per-field 上限は作らない = YAGNI)。
4. target 語彙(spec §4.1): `'question_text'` / **`'option:<uid>'`(§3 rev2・内部不変 UUID。W1 実装時の `option:<表示id>` から W5 で改訂)** / `'explanation_text'` / `'memo'`。OCR legacy(非 UUID key・`option_1` 語彙)は別 namespace で不干渉・cascade / gallery の対象外(`isAssetKey` filter)。**表示ラベル(a/b/c = `opt.id`)は uid と別物** — aria-label 等の UI 語彙は `opt.id`(表示)、画像 target は uid(同一性)を使う。
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

### Task W5: option 内部 id(uid)導入 + target uid 化 + set-diff cascade(spec §3 rev2・W3 の前提)

**目的**: W3 レビュー(canonical + Codex)が検出した delete-only cascade の取りこぼし 2 経路(id rename / blank-text 除去)を、紐付けキーの構造変更で根本解消する。`CardOption.uid`(UUID v4・不変・不可視)を導入し画像 target を `option:<uid>` 化 → **uid は再利用されないため mis-attach が構造的に不可能**になり、cascade は「配列から消えた uid の掃除」= **衛生機構**(set-diff 1 個・失敗しても破損しない)へ降格する。裏取り = `docs/audit/2026-07-16-option-internal-id-feasibility.md`。

**Files**: Modify `lib/db/schema.ts`(CardOption)/ `lib/client-db.ts`(ClientCardOption)/ `lib/validation/card.ts`(optionSchema.uid + uid 一意 refine)/ `lib/cards/empty-card.ts` / `app/(app)/app/upload/_actions/process.ts`(OCR 写像点 mint)/ `scripts/seed-perf-exam.ts`(**uid mint + 多択カード 3〜5 枚混入・下記追加指示**)/ `app/(app)/app/exams/[id]/_hooks/use-card-options.ts`(handleAddOption mint + cascade set-diff 化)/ `lib/cards/card-field-handlers.ts`(handleOptions uid 透過)/ `lib/sync/server/entity-mutation-registry.ts`(create handler uid 透過)/ `lib/cards/card-write.ts`(create patch 透過・必要時)/ Test: 各対応 test。

**制約**:
- **G→W の型**: G = delete で画像が消える挙動の pin。**既存 W1 test の fixture を uid 化して green を維持する**(下記「W1 test 移行」)。
- **W1 test 移行(要修正 1・後方互換禁止)**: W1 test は `target='option:b'`(表示 id)+ uid 無し options で seed している。W5 後の cascade は **uid で diff** するため、この fixture のままだと削除対象 uid が定まらず image が除去されず **assert が落ちて RED**。これは**実装バグの RED ではなく、target 語彙を意図的に変えたことによる正当な test 更新**: **fixture に uid を足し image target を `option:<uid>` へ移行する**(実装を疑う対象ではない)。**`option:<表示id>` を受け付ける後方互換は一切足さない**(足すと mis-attach ベクタが復活し W5 の存在理由が消える・しかも test は green ゆえ気づけない。zero-user + テストアカウント全消去済ゆえ後方互換不要)。W1 test の残存価値は「delete で画像が消える」挙動 pin のみで、**mis-attach 回帰としては W5 で構造的に無意味化**(uid 非再利用)。
- **mint 経路 = 4 つ全て**(1 経路でも漏れると uid 無し option が validation reject): ① handleAddOption(client・`newId()`)② buildEmptyCard(「+カードを追加」既定 option・create patch 経路)③ OCR **server 写像点 `process.ts:373` のみ**(**Gemini prompt / `ocr-extract.ts` / response schema は一切触らない** — LLM は表示ラベルのみ返し uid はアプリが振る。受け皿のみ・画像自動切り出しは非スコープ)④ seed script。+ **詰め替え透過 2 箇所**(handleOptions の camel/snake 詰め替え / create handler)で uid を落とさない。
- cascade set-diff(**diff 対象を現物で確定 = 要修正 2**): `commit()`(`use-card-options.ts:210`)は `sanitized = target.filter(text 非空)` を **mirror(`afterPatch.options`)と server payload の双方**に書く一方、working-set state(`options`/`optionsRef.current`)は blank row を保持する。∴ **「実際に永続する集合」= `sanitized`**。cascade の diff は **`serverCommittedRef.current`(直近永続 = before)と `sanitized`(今回永続 = after)の uid 差分**を取る(working-set 差分は blank を残すため検出漏れ = 不可)。
  - blank-text 経路: text を空にして blur → `handleCellSave` → `commit` で当該 option が sanitize 除外 → **その commit 時点で `serverCommittedRef.current` はまだ当該 uid を保持** → diff が commit 時点で除去を検出(pull-back 不要)。delete 経路も `handleDeleteOption` → `commit` を通るため同一機構でカバー。→ **W1 の handleDeleteOption 専用 cascade は commit の set-diff に置換(一般化・revert しない)**。no-op 短絡(`shallowEqualOptions(sanitized, serverCommittedRef.current)`)時は diff も空。
  - 除去は W1 と同じ 2 段(removeImageFromCard → 成功分 reclaim)+ 直列 for-await + assetId 単位 warn。userId は `cards.get(cardId)` の `row.user_id` から導出(W1 と同じ)。cascade は fire-and-forget（衛生機構ゆえ失敗しても mis-attach 不能）。
- 学習系は不変: `selected_answer_ids` / `correct_answer_ids` / 正解サマリ / `nextOptionId`(表示ラベル採番に降格・実装不変)/ ghost merge(表示 id key のまま)。
- 既存データ: **lazy 付与は作らない**。stg は W5 push 後に OT が再 seed(uid 付き)。DDL/migration 不要(jsonb)。
- **blank-text の非対称(要修正 2・OT 判断 = cascade する)**: text 空 → blur で option は永続集合から消え cascade が画像削除する一方、**working-set は blank 行を保持**するため UI に行が残る。打ち直すと同 uid で option 復活するが**画像は戻らない**(現行の壊れた挙動では zombie 残存ゆえ戻っていた・W5 は意図的に消す)。方針 = **cascade する**: 「空 = option 消滅」の意味論が一貫し、cascade しない場合の「不可視の永久 leak(entry/ref 残存 → GC が生存判断)」より良い。uid 化で mis-attach 不能ゆえ**破損でなく hygiene vs UX トレードオフ**。→ smoke で OT が実物許容を判断(§7・許容不可なら別 task 起票 = 確認ダイアログ / blank 行即時除去)。
- **uid の DB 自動採番は採らない(OT 質問への回答・記録)**: options は cards の **jsonb**(DB 行でない)ゆえ `gen_random_uuid()` 等の列採番は及ばない。かつ **local-first** ゆえ DB 採番は遅すぎる(端末 IndexedDB に先書き → 同期後に uid が付くと、その間 画像を紐付けられない)。∴ uid は**生成地点で mint**(handleAddOption / OCR 写像点 / seed / buildEmptyCard = 上記 4 経路)が正。options 正規化(独立 table 化)すれば DB 採番可だが本問題に過剰 = 非スコープ。
- **seed 多択カード(追加指示・OT 確定)**: 現 seed は 4 択中心(実測 max 828px)で Sprint F spec §9(多択行高肥大・20 択 ≈ 4531px 想定)が未検証・持ち越し。再 seed する今、**20 択カードを 3〜5 枚、可視窓に 1〜2 枚入るよう分散配置**して混ぜる(追加コストほぼゼロ)。uid mint は 4 択・20 択とも同経路。

**test**: ① 生成 4 経路それぞれが uid を mint(handleAddOption / buildEmptyCard / OCR 写像点 / seed は build 関数単位)② 透過 2 箇所が uid を落とさない ③ **rename**: 画像付き option の id cell を編集 → 画像 target(uid)不変 = 追随(gallery filter が uid で hit)④ **blank-text(sanitize 経路を実際に通す = 非空振り必須)**: `handleCellSave(idx, {...opt, text: ''})` で commit → sanitize が option を永続集合から除外 → set-diff cascade が `option:<uid>` 画像を removeImageFromCard で除去(**配列から手で uid を消して diff を呼ぶ test は経路を通らず vacuous ゆえ禁止**)。cascade を neuter して RED になることを commit 前 review で確認(W1 と同型の非空振り担保)⑤ **delete**: 既存 W1 test を **fixture uid 化したうえで green 維持**(set-diff 化後も delete で画像除去。後方互換は足さない = 要修正 1)⑥ uid 一意 refine・uid 無し option の reject。

**完了条件**: 上記 test green + 既存 test 回帰なし + **「全 option 生成経路が mint する」を test で担保** + Crit0/Imp0 + `[reviewed]`。

---

### Task W3: gallery 増設(compact 形態 + 編集面 4 面配線)【W5 後・保持済 diff を修正して仕上げ】

**目的**: 編集面(list + side-peek 共有の `CardEditorFields`)で 4 面すべてに添付 UI を出す。選択肢は §9(多択行高肥大)を悪化させない compact 形態(spec §4.2)。

**Files**: Modify `app/(app)/app/exams/[id]/_components/card-image-gallery.tsx`(compact prop)/ `card-editor-fields.tsx`(解説・メモ gallery + InlineOptionList への props 透過)/ `inline-option-row.tsx`(`InlineOptionList` に `images`・`userId` props 追加 + 各 `<li>` 内 Row 直後に compact gallery)/ Test `card-image-gallery.test.tsx` 系 + list 結合 test。

**compact affordance の実物(OT plan 入力 2・既存 UI 語彙に揃える)**:
- `CardImageGallery` に `compact?: boolean`。**thumbnail 描画は不変**(h-16 既存)。変わるのは空/add affordance のみ。
- affordance = 生 button `h-6 w-6`(24px)— **gallery 内既存 icon 語彙 = thumbnail の × 削除 button(`min-h-6 min-w-6`)と同寸**。中身は lucide `ImagePlus` `size-3.5`(Button size-xs の svg 語彙)。**aria-label は文脈付け**(Codex a11y 指摘採用): `CardImageGallery` に `attachAriaLabel?: string` を追加し、選択肢 instance は `'選択肢 ' + opt.id + ' に画像を追加'` を渡す(既定 = 「画像を追加」・複数 option で同名 button が並ぶ SR 不可判別を回避)。`text-slate-400 hover:bg-slate-100 hover:text-slate-900` + 既存 focus-visible ring。click/tap = 既存 `fileInputRef.click()`(hidden input・attach 経路共有 = 全体ルール 2)。dashed「画像を追加」テキストボタンと空 flex container は compact では出さない。
- 設置位置: `InlineOptionList` の各 `<li>` 内・`InlineOptionRow` の**直後**(Row は un-export presentational のまま不変・grid 非改変)。**`target={'option:' + opt.uid}`**(§3 rev2・画像同一性は uid)。aria-label は表示ラベル `opt.id`(据え置き)。保持済 diff は `opt.id`→`opt.uid` の 1 箇所修正で拾う。
- **§9 影響記録**: 空選択肢の増分 = 24px icon 1 個/選択肢(常時 dashed gallery なら ~52px+/選択肢)。画像を持つ行のみ thumb 高が乗る。行高変動は Sprint F の measureElement が吸収(spec §4.2 の 1 行記録を session doc へ転記)。
- 解説/メモ = 問題文と同じ**常時形態**で `InlineTextField` 直下に `target='explanation_text'` / `'memo'` を増設(card あたり各 1 個・選択肢数非比例ゆえ §9 無関係)。

**test**: 4 面それぞれ attach → `cards.images` に正しい target で entry 追加 / remove で消える(既存 gallery test を target parametrize)・compact 空 = icon affordance のみ(dashed テキスト不在)・compact readOnly 空 = null 不変。

**完了条件**: test green(既存 gallery/editor test 回帰なし)・Crit0/Imp0・`[reviewed]`。

---

### Task W4: 学習面 read-only 表示

**目的**: 4 面画像を「解く/答え合わせ」時に見せる(spec §4.3・W4 なしは機能破綻。memo は学習非表示ゆえ除外)。

**Files**: Modify `app/(app)/app/study/smart/_components/session-runner.tsx` / Test `session-runner.test.tsx`。

**制約**:
- 選択肢: 各 `<li>` 内・選択 `<button>` の**外**(直後)に `readOnly` gallery **`target={'option:' + opt.uid}`**(§3 rev2・画像同一性は uid。button 内は nested interactive になるため禁止)。readOnly + 0 件 → null(既存)ゆえ空選択肢は DOM 増ゼロ。**readOnly thumbnail は非 interactive**(click しても選択動作と独立・何も起きない = 既存 readOnly gallery と同挙動)。option 画像は選択フェーズから表示(reveal 非依存)ゆえ判定前後の DOM 変化は既存 explanation 節の増減と同型。
- 解説: 解説 div 内に `target='explanation_text'` readOnly を追加。**表示条件を「`explanationText` truthy または explanation_text 画像あり」に拡張**(現条件はテキスト truthy のみ → 画像だけ添付した card で解説節ごと消えるエッジを閉じる)。判定は `current.images` の UUID-key `explanation_text` entry 有無。
- 問題文 gallery(既存)不変。添付/削除 UI は一切出さない(readOnly)。

**test**: option / explanation 画像が read-only 表示される・「画像を追加」「×」affordance 不在・explanation テキスト無し + 画像ありの card で解説節が表示される・テキストも画像も無い card では解説節が出ない(既存挙動不変)。

**完了条件**: test green(既存 session-runner test 回帰なし)・Crit0/Imp0・`[reviewed]`。

---

### Task F: 完了 gate + handoff

**目的**: sprint 完了 gate と OT への引き渡し。

**手順**: ① whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm typecheck` / `pnpm test` 全 exit 0(報告に「whole-repo lint exit 0 確認済」明記)② session doc(`docs/superpowers/sessions/`)に commit range・per-task 要点・§9 影響記録・W5 の uid 化経緯(W3 レビュー 2 経路 → uid で構造解消)・**OT smoke checklist(spec §7: 4 面添付+reload 復活 / 削除の非復活 / 選択肢削除の追随 / **rename 追随 3b** / GC 非孤児化 / §9 非悪化 / **§9 再燃検証 5b(多択 scroll)** / 学習面 read-only)**+ **§9 の検証結果欄(smoke 後に「検証済=持ち越し解消」or「観測→別 task 起票」を追記する受け皿)**を記載し `docs(session)` `[no-review]` commit ③ stop checkpoint 報告 → OT push(→ **OT が再 seed:uid 付き + 多択**)→ OT smoke。

**完了条件**: 3 gate exit 0・session doc commit 済・working tree clean・stop checkpoint 報告。

---

## 実行順序と依存(§3 rev2 で改訂)

W1(完了・[reviewed] `b35fae6`)→ W2(完了・[reviewed] `5c137a9`)→ **W5(uid 導入・W3 の前提)→ W3(W5 依存: working tree 保持中の実装済 diff の選択肢 target を `option:<uid>` へ修正して review→commit)→ W4(W2 依存)→ F**。

- W3 の未 commit diff は W5 完了まで working tree に保持(消失リスクが出る場合= W5 review 長期化等は OT 相談)。
- smoke 前提: W5 は uid 必須 validation を含むため **OT push → stg 再 seed(uid 付き)→ smoke** の順(spec §7)。
