# DDD P3 — client 側 use-case 化 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。

**Goal:** exams UI の client ドメインロジックを lib へ移設し side peek 複製を解消する(挙動不変)。
**spec:** `docs/superpowers/specs/2026-07-07-ddd-p3-client-usecase-design.md`(`95afcfc` OT 承認・判断点 4 つ全て推奨採用)+ OT 5 条件(2026-07-07)。
**基点:** fact-finding `docs/superpowers/sessions/2026-07-07-ddd-p3-factfinding.md`(HEAD `aeb4d23`)。

## Global Constraints(全 task 共通)

- **挙動不変**: D-2 凍結契約 + 地雷 8 invariant(spec §5)。既存 test 変更は「移設先への re-point」のみ可(assert 内容を変えない)。P0 golden snapshot 更新ゼロ。
- **移動と書換えの分離**(OT 条件 2): verbatim 移動 task と書換え task を混ぜない。TagEditCallbacks は Task1 で型不変のまま移動、Task7 で optional 化。
- **地雷温存原則**(spec §3.6): 共通 component に新規 useLiveQuery を作らない / commit 機構(commit-on-unmount・debounce・V6 blur)は統合・変更しない。
- **エラー挙動保存**(OT 条件 5): 直 tx → helper 寄せで reject 伝播を変えない。実測(plan 起草時・現 HEAD):

| 直 tx site | caller の reject 依存 | 実 handler の reject pin |
|---|---|---|
| use-card-tag-toggle | なし(内部 try/catch silent・:100-122) | n/a(rollback pin 済) |
| handleDeleteCategory | **あり**(add-popover:640 `setLastError('削除に失敗しました')`) | **未 pin → Task0 で追加** |
| handleDeleteOption | **あり**(edit-popover:229 / add-popover:698 同上) | **未 pin → Task0 で追加** |
| handleCreateCategory | あり(add-popover:330 createError) | pin 済(section.test:1455,1466) |
| createOption | あり(bulk 経路) | pin 済(section.test:2056,2087) |
| handleCreateOptionAndAssign | あり(popover ×3 createError) | pin 済(section.test:1828 + idb:197) |

  → 寄せ先は **throwOnError: true**(toggle のみ既定 silent のまま)。前例 = 同 file の rename/color 4 handler(runOptimisticUpdate + reject pin 済 :703,832,899,1015)。
- per-task gate: 対象 test + `pnpm test:contract`(77)+ `pnpm typecheck` + whole-repo `pnpm lint --max-warnings=0` 全 exit 0。risk task(Task1/2/3/5)は + `pnpm build` + Codex 独立 review。full `pnpm test` は Task9 集約。
- commit: review pass → [reviewed] commit の一方向。SSoT 状態遷移(実装中)は最初の code commit に同梱、完了記録は Task9 の独立 [no-review] commit。
- エスカレーション(停止): 未解決 Critical / 地雷 invariant 赤 / 単一 subscription 破綻 / V6 温存不能 / reject 伝播保存不能 / 仕様解釈揺れ。Important 以下は CC 吸収。

---

### Task 0: characterization 追加(W0・全移設に先行)

- **目的**: 移設前に gap 4 点を test で固定する。① selection prune HS-2(filter 変更・行削除後に selection ⊆ 可視集合)② TagCell cardId-bound override(createOptionAndAssign が cardId 付きで実行される)③ delete 2 関数の reject 伝播(enqueue 失敗 → `rejects.toThrow` — popover 側 mock pin の盲点を塞ぐ)④ cross-component 統合 flow 1 本(inline-card-list 実 tree: InlineTextField 編集 → blur → 実 Dexie mirror 反映 + outbox enqueue 内容 → mock BulkApiClient で flush)。
- **制約**: 既存 test の変更禁止(追加のみ)。既存パターンに乗る: ①② = exam-card-table.test.tsx / exam-card-table-tag-cell.test.tsx へ追加、③ = card-tags-section.test.tsx の enqueue-throw 前例(:703 等)踏襲、④ = 新 file `tests/integration/exam-card-edit-flow.test.tsx`(fake-indexeddb + useLiveQuery 実走 + BulkApiClient injection の既存 3 パターン組み合わせ・spec §2-4)。④ の flake 対策(Codex 指摘): real timers + `waitFor`/`vi.waitFor` 待機・beforeEach Dexie clear・flush は drain 待ちでなく mock client 呼び出し内容で assert(inline-text-field.test の既存流儀)。
- **完了条件**: 新規 test 全 green + 既存全対象 suite green + per-task gate。[reviewed](canonical)。

### Task 1: タグ CRUD → lib/tags verbatim 移設(W1・risk)

- **目的**: card-tags-section.tsx:80-508 の 12 関数 + TagEditCallbacks(514-537)+ buildNewOption を `lib/tags/` へ **as-is 移動**(書換えゼロ)。V1 解消。
- **配置**: CRUD → `lib/tags/tag-crud.ts` / impact 集計 → 同居可 / TagEditCallbacks 型 → 同居。CardTagsSection component・popover 配線・useCallback closure 化は card-tags-section.tsx に残す(presentation)。**tag-crud.ts の層 = application service(use-case)** — Dexie/outbox/flush に触れる。pure 部品(buildNewOption 等)と file 冒頭コメントで区別(lib/reviews の暫定置き場注記と同じ流儀・Codex 指摘)。
- **制約**: verbatim(コメント含む)。**許容される非 verbatim 差分 = import/export 文と path のみ**(Codex 指摘の明文化)。型変更禁止(OT 条件 2)。importer 8 箇所(実装: inline-card-list:30 / exam-card-table:86-98 / tag-cell:28-31 / side-peek:23、type: edit-popover / add-popover / columns / action-bar)を rewiring。card-tags-section.test.tsx の該当 describe + -idb.test.tsx は移設先 co-located へ re-point(assert 不変)。lib に 'use client' を持ち込まない(現 12 関数は directive 無しを確認済み前提 — 混入したら停止)。
- **完了条件**: 全対象 suite green + Task0 test green + per-task gate + build + canonical + Codex。[reviewed]。

### Task 2: 直 tx 6 箇所の helper 寄せ(W2a・risk)

- **目的**: runOptimistic\* 昇格の実体。lib/tags 内の 5 関数(delete ×2 / createCategory / createOption / createOptionAndAssign)+ use-card-tag-toggle を runOptimisticMutation / runOptimisticCreate へ。
- **対応表**(spec §2-2): toggle → runOptimisticMutation(既定 silent = 現行どおり)/ delete ×2 → runOptimisticMutation + **throwOnError: true** / createCategory・createOption → runOptimisticCreate + **throwOnError: true**(戻り値 {id} / newOptionId 維持)/ createOptionAndAssign → runOptimisticMutation(**2 mutations 順序維持**: tag_option create → card update_field)+ throwOnError: true。
- **制約**: mutation の patch shape・enqueue 件数・順序・op 名・log イベント名は凍結(D-2)。**throwOnError: true 経路では helper の logger.warn を発生させない(新規 log 出力ゼロ)/ toggle の silent 経路も現行 console 出力と同一性を確認**(Codex 指摘)。**create 系は id 採番(crypto.randomUUID / buildNewOption)・sort_key・created_at/updated_at・enqueue payload が現行と同一値になることを受け入れ条件に含める**(runOptimisticCreate の providedId / factory へ現行値を渡す・Codex 指摘)。tx 内 read(deleteCategory の tag_options where)は mutate callback 内で維持。guarded flush の fire-and-forget タイミング不変。optimistic-mutation.ts に application service 役割コメント追記(層新設なし = N-5)。
- **完了条件**: Task0-③ の reject pin + 既存 reject pin(:703 系 / :1455 / :2056 / :1828)全 green + rollback pin(idb:197 / Sync-fix-1 T2a)green + per-task gate + build + canonical + Codex。[reviewed]。

### Task 3: tags manager 統一(W2b・risk・独立 commit)

- **目的**: category-list.tsx:171 / option-list.tsx:147 の cascade delete を lib/tags use-case 呼び出しへ付け替え、client 内二重実装を単一 source 化(判断点 1 採用)。
- **制約**(OT 条件 1): 「同形 ≠ 同一」— 付け替え前に両実装の差分を実測比較し、差分があれば caller 側で吸収(use-case を manager 挙動に寄せない)。比較対象 = impact 集計・削除順・enqueue patch・エラー処理 + **UI 状態(dialog close・error message・loading state・impact 表示)**(Codex 指摘で拡張)。**受け入れ条件 = 両 caller の既存 test が両方 green**(exams 側 + tags manager 側 category-list.test / option-list.test)。差分吸収不能なら停止(仕様解釈揺れ)— 無理な統一より別 task 切り出しを優先。
- **完了条件**: 両側 suite green + per-task gate + build + canonical + Codex。[reviewed]。

### Task 4: card write 集約(W3)

- **目的**: V3(補正済スコープ)。NULLABLE_FIELDS + 空文字→null 正規化(inline-text-field:67-71,198-209)/ 新規カード patch 構築(inline-card-list:218-236)/ options commit patch 組立(use-card-options:159-225 の該当部)を `lib/cards/card-write.ts`(pure)へ carve。runOptimisticUpdate 呼び出しは hook/component に残す。
- **制約**: pure carve(Dexie import 禁止・P1 前例)。patch shape 不変。use-card-options を触る際に `react-hooks/refs: off`(eslint.config.mjs L105)の解消可否を判定 — **解消が挙動変更(再レンダリング変化)を伴うなら据え置き + 理由・次工程(P4 or 別 task)を実績欄と eslint.config.mjs コメントの両方に記録**(OT 条件 4 + Codex 指摘)。
- **完了条件**: inline-text-field / inline-card-list / use-card-options suite green(特に commit-on-unmount 5 case)+ Task0-④ 統合 flow green + per-task gate + canonical。[reviewed]。

### Task 5: side peek 複製解消(W4・risk)

- **目的**: §4.4-1。InlineTextField ×5 + CardTagsSection + InlineOptionList のブロックを `_components/card-editor-fields.tsx` へ抽出し、inline-card-list(284-369)と exam-card-side-peek(107-185)の両方から使用。
- **制約**(spec §3.6): 共通 component は**データを props で受ける**(新規 useLiveQuery 禁止 — 単一 subscription 不変条件)。V6 blur→close は side-peek container(:56-64)に残す。差分は props: `showDelete` / `autoEditOnMount`(list のみ)/ layout variant / cardTags 供給。抽出後の両者は verbatim 差分ゼロが理想、残す差分は props 表現のみ。**callback identity(useMemo/useCallback の dep 構成)を変えない — memo 凍結・row 再 render 頻度への影響ゼロを remount.test green で担保**(Codex 指摘)。
- **完了条件**: side-peek F2(blur 順序)+ inline-card-list + exam-detail-view Case ⑤ + **exam-card-table.remount.test(memo 凍結 pin)** green + per-task gate + build + canonical + Codex。[reviewed]。

### Task 6: inline primitive 低次共有(W5)

- **目的**: sharedBoxChrome(text-field:275 ⇄ option-row:312 verbatim)/ dirty-guard sentinel / auto-resize を `_lib/inline-edit-shared.ts` へ(rule of three 未満のため lib/ 昇格しない)。
- **制約**: **commit 機構は触らない**(commit-on-unmount・debounce drain・blur commit は各実装に残す — V6 依存)。共有は定数 + pure/hook 化できる 3 点のみ。挙動差(条件記述順・変数名)は共有化で消えるが assert 対象の挙動は不変であること。**dirty-guard(render-phase sentinel)は外部挙動同一を両 suite green で担保し、差が出る場合は共有を sharedBoxChrome + auto-resize の 2 点に縮小**(縮小判断は CC 吸収・実績欄に記録・Codex 指摘)。
- **完了条件**: inline-text-field(951 行 suite・unmount 5 case)+ inline-option-row(782 行 + debounce)green + per-task gate + canonical。[reviewed]。

### Task 7: 掃討(W6)

- **目的**: ① TagEditCallbacks.createOptionAndAssign を optional 化し createOptionAndAssignPlaceholder(exam-card-table:429-436)削除(判断点 2 = (b) 案・5 file・null guard 2 箇所は実分岐)② CardTagBadge.onOpenEdit prop 削除(全 call site no-op)③ session-runner.tsx:255 の `submit-review-tx` dangling コメントを実対向(review-events/bulk → lib/reviews/ingest-review-events)へ修正。
- **制約**: 型変更はこの task のみ(OT 条件 2)。null guard は edit-popover:169 / add-popover:543,577 経路 — guard 追加後も popover の createError 挙動 test green。**undefined 時の UX 期待を明文化**(Codex 指摘): 実経路では TagCell/ActionBar が必ず override するため undefined が popover に届く経路は無い — guard は型 narrowing のためで、**UI の表示・活性は一切変えない**(分岐 UI を追加しない)。
- **完了条件**: tag-cell + popover ×2 + card-tag-badge suite green + per-task gate + canonical。[reviewed]。

### Task 8: lint 回収(W7)

- **目的**: ① exam-detail-view.tsx + upload result page の深相対を `@/` alias 置換 → eslint.config.mjs の 'off' override 2 block 削除 ② cross-feature allowlist 新 config block(study/custom→exams ×2 / exams→tags ×2 / column-pinning 逆依存 1 — 解消せず可視化)③ import-boundary.test.ts 追随 ④ custom-filter-form:21 の型 import が P1 移動で解消済みか確認(済なら allowlist から除外)。
- **制約**: glob escape 規約 `\\(...\\)` / `\\[...\\]`(escape 不在は silent 不発)。contact-form は触らない(P4 送り)。**allowlist 各 entry にコメントで分類を付す**(Codex 指摘): 意図的設計(column-pinning = columns-as-data)/ 一時負債・将来解消(cross-feature 4 件 = 機能境界強化時に再評価)— 単なる免除リスト化を防ぐ。
- **完了条件**: whole-repo lint --max-warnings=0 + import-boundary.test green + per-task gate + canonical(ロジック不変のため Codex skip 可)。[reviewed]。

### Task 9: 最終 gate + docs(W8)

- **目的**: 全 gate + SSoT + 申し送り完備。
- **手順**: `pnpm install --frozen-lockfile` 不要(依存不変)→ full `pnpm test` / `pnpm typecheck` / whole-repo `pnpm lint --max-warnings=0` / `pnpm test:contract`(77・snapshot 更新ゼロ確認)/ `pnpm build` 全 exit 0 → SSoT 進捗表(完了 + HEAD SHA + 再スキャン記録)+ 変更履歴 → baseline §B(vi) に P3 surface 追記: タグ CRUD 実操作 / card inline 編集 / side peek 開閉 commit + **「E2E 残余・merge 後 stg smoke 対象」として実 focus/blur・virtualizer 実 scroll・scroll 起因 unmount commit の 3 点を、操作手順 + 期待挙動の粒度で明記**(OT 条件 3 — E2E 不採用の意図的 stg 送りと分かる形・Codex 指摘で粒度指定)。**plan 実績欄の記入 + spec からの逸脱があれば SSoT 変更履歴に記録**(Codex 指摘)。
- **完了条件**: 全 exit 0 + 「whole-repo lint exit 0 確認済」報告明記 + docs commit([no-review])→ **停止・OT 確認待ち**(sprint 境界)。

---

## 実行順序と依存

Task0 → Task1 → Task2 → Task3(W2 内独立 commit)→ Task4 → Task5 → Task6 → Task7 → Task8 → Task9。
Task4-6 は相互独立だが直列実行(subagent-driven の review 粒度維持・並列しない)。Task7 は Task1(型の移設先確定)後であれば Task4-6 と入れ替え可。

## 実績欄(実装時に追記)

- react-hooks/refs off の判定結果(Task4):
- tags manager 差分実測の結果(Task3):
- custom-filter-form:21 の確認結果(Task8):
