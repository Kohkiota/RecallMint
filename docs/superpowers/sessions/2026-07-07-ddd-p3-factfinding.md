# DDD P3 fact-finding(現 HEAD 再スキャン)

- 日付: 2026-07-07 / branch: `dddrefactor` / 再スキャン基点 HEAD = `aeb4d23`(実装 HEAD `fdb7d93` + docs 2 commits・working tree clean)
- 手順: p3-handoff「進め方 1」に従い、audit(`docs/audit/2026-07-05-ddd-refactor-investigation.md`、検証時 HEAD `5d3baef`)の P3 対象主張を Explore subagent 4 体(①V1 タグ CRUD ②V3/V6/side peek 複製/inline primitive ③runOptimistic\*/地雷群 ④テスト網/lint)で全数再検証。surprising な結果(§4 テスト網)は controller が直接裏取り済。
- 結論: **audit 主張はほぼ全数一致(行番号レベルで現存)。実質的乖離は 2 件** — (A) V3 の正規化ロジック所在、(B) 「安全網最薄」前提の適用範囲(P3 spec の characterization 戦略に直結)。

---

## 1. V1: タグ CRUD(card-tags-section.tsx)— 一致

- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx`(**701 行**)。CRUD 一式の常駐行範囲 **80-508 = audit と完全一致**。
- module スコープ export 関数 12 + `type TagEditCallbacks`(514-537)+ `buildNextTagSet` re-export(:61)+ `CardTagsSection` component(:700):

| 関数 | 行 | 責務 | 書込経路 |
|---|---|---|---|
| handleRenameCategory | 80-106 | rename | runOptimisticUpdate |
| handleSetCategoryColor | 112-135 | color | runOptimisticUpdate |
| handleRenameOption | 141-167 | rename | runOptimisticUpdate |
| handleSetOptionColor | 173-196 | color | runOptimisticUpdate |
| handleDeleteCategory | 203-228 | cascade delete | db.transaction 直 |
| handleDeleteOption | 234-253 | cascade delete | db.transaction 直 |
| countCategoryImpact | 266-277 | delete 前影響集計 | IDB read-only |
| countOptionImpact | 282-287 | 同上 | IDB read-only |
| handleCreateCategory | 310-351 | create + enqueue | db.transaction 直 + guarded flush |
| buildNewOption | 360-389 | pure builder(採番) | なし |
| createOption | 398-421 | create(bulk 用) | db.transaction 直 + guarded flush |
| handleCreateOptionAndAssign | 435-508 | create + card 即付与 | db.transaction 直(whole-set 差分) |

- **被 import 実装 4 経路 = audit と一致**: inline-card-list.tsx:30(CardTagsSection)/ exam-card-table.tsx:86-98(handler 10 + type)/ exam-card-table-tag-cell.tsx:28-31(handleCreateOptionAndAssign + type)/ exam-card-side-peek.tsx:23(CardTagsSection)。加えて **type-only 参照 4 件**(card-tag-edit-popover / card-tag-add-popover / exam-card-table-columns / exam-card-table-action-bar — いずれも `TagEditCallbacks`)。
- P1 抽出済 lib 依存: `lib/tags/`(18 file)の compareTagEntry / nextSortKey / buildNextTagSet / reorder-handlers を既に import。

## 2. V3: 「空文字→null」正規化 — **乖離(A): 実体は 1 箇所のみ**

- audit は 3 箇所(inline-card-list:218-236 / inline-text-field:67-71,198-209 / use-card-options:159-225)と読めるが、現 HEAD 実態:
  - **inline-text-field.tsx:67-71(`NULLABLE_FIELDS` = sort_key/explanation_text/memo)+ 198-209(commit 内 `target === '' ? null : target`)が唯一の動的正規化**。
  - inline-card-list.tsx:218-236 = 新規カード patch 構築で `explanation_text: null, memo: null` を**静的**設定(正規化ではない)。
  - use-card-options.ts:159-225 = commit 関数。正規化なし。sanitize は `o.text.trim().length > 0` の **ghost 除外**のみ(空文字→null 変換はしない。scalar は server zod 依存)。
- grep 全域確認: 同種正規化の他出現なし(inline-option-row.tsx にも `NULLABLE_FIELDS` なし)。
- **spec への含意**: V3「card write use-case 集約」の対象は「正規化ルールの 3 重複解消」ではなく「**patch 構築 + 正規化 + commit 経路が 3 file に分散**している集約」— 重複解消でなく所在整理が本体。

## 3. §4.4-1: side peek 複製 — 一致(near-verbatim 確認)

- `exam-card-side-peek.tsx`(**192 行**)107-185 ⇄ `inline-card-list.tsx`(**396 行**)284-369。
- 構成 = InlineTextField ×5(sort_key/title/question_text/explanation_text/memo)+ CardTagsSection + InlineOptionList。**field ブロックはほぼ verbatim**。
- 意図的差分: inline-card-list のみ `DeleteCardButton`(:305)+ `autoEditOnMount={newCardIds.has(card.id)}`(:325-333)/ side peek は cardTags を直接 prop(単一 card)/ layout wrapper(flex-wrap vs space-y-3 p-4)。

## 4. V6 + inline primitive — 一致

- **V6**: exam-card-side-peek.tsx **56-64 = audit と一致**。`onOpenChange` で `document.activeElement.blur()` → `onClose()`。コード内コメント自体が「InlineOptionCell は blur 時のみ commit し commit-on-unmount を持たない」と依存を自認。
- **sharedBoxChrome**: inline-text-field.tsx:275 ⇄ inline-option-row.tsx:312、**文字列完全 verbatim**(`'block w-full min-h-11 rounded-md p-2 md:min-h-8 md:py-1'`)。
- **並行実装の差分表**:
  - dirty-guard: 両者 render-phase sentinel(text-field 144-150 / option-row 273-277)、条件記述順のみ差。
  - auto-resize useLayoutEffect: text-field 123-132 / option-row 281-290、変数名のみ差。
  - commit-on-blur: 両者あり(text-field 259-271 / option-row 303-307)。
  - **commit-on-unmount: text-field のみ**(157-179、latestRef で stale closure 回避 + `cards.get(cid)` 存在確認で orphan enqueue 防止)。option-row は持たない = V6 の blur 依存の根拠。
  - debounce drain(500ms): text-field のみ(232-240)。option cell は親 useCardOptions に委譲。

## 5. runOptimistic\* — consumer 全数(昇格対象の実測)

- `lib/sync/optimistic-mutation.ts`: `runOptimisticMutation`(:72 複数 mutation + mirror 書込 1 tx)/ `runOptimisticCreate`(:144 id 採番 + insert + enqueue)/ `runOptimisticUpdate`(:245 単一 row update + enqueue + debounce-drain 委譲)。
- **consumer 18 site = exams 9 / tags 6 / study 0**:
  - exams: inline-card-list:210(Create)/ inline-text-field:210(Update)/ delete-card-button:40(Mutation)/ use-bulk-card-tags:139(Mutation)/ use-bulk-card-delete:67(Mutation)/ use-card-options:198(Update)/ card-tags-section:90,119,151,180(Update ×4)。
  - tags: category-create-form:66 / category-row:100 / category-list:171 / option-create-form:78 / option-row:139 / option-list:149。
  - **helper 非経由の直 tx**: use-card-tag-toggle.ts:93-117(card_tags delete/put + enqueue を直書き)+ card-tags-section の delete/create 系 5 関数(§1 表)。昇格 spec ではこの「直 tx 群」の扱い(helper に寄せるか as-is か)が論点。
- rollback: 全経路 **explicit revert なし・Dexie tx auto-rollback 100% 依存**(audit 地雷の主張どおり)。tx 外 side-effect は guarded flush(fire-and-forget・失敗時 outbox 残留 → 再送)と console.error のみで設計上セーフ。

## 6. 地雷 §6.3 — 全件現存(現行 file:line)

| 地雷 | 現 HEAD 所在 |
|---|---|
| 単一 subscription 不変条件 | exam-detail-view.tsx:216(card)/:233(table)の conditional mount で排他。useLiveQuery は inline-card-list.tsx:92-118 / exam-card-table.tsx:313-329 の 2 箇所のみ。side peek は exam-card-table.tsx:345-352 で liveData から派生(新規購読なし)、:866-873 で props 渡し |
| commit-on-unmount + dirty-guard | inline-text-field.tsx 157-179 / 144-150(§4) |
| ghost merge | use-card-options.ts:113-125(server 側に無い id のうち「text あり or autoEdit 中」のみ温存) |
| TagCell placeholder override | exam-card-table-tag-cell.tsx:111-126(spread + createOptionAndAssign を cardId-bound closure で差替。placeholder 本体 = exam-card-table.tsx:429-436) |
| selection prune HS-2 | exam-card-table.tsx:490-516(可視 row 集合外の selection を prune) |
| scroll collapse + virtualizer memo 凍結 | exam-card-table.tsx:242-250(`MemoizedTableBody` comparator が isResizing 中 re-render skip)/ 132-139(useVirtualizer)/ 552-576(columnSizeVars は凍結外で実時間更新) |
| V2 UI 直 Dexie | exam-card-table.tsx:313-329 / inline-card-list.tsx:92-118 / inline-text-field.tsx:172(unmount commit の存在確認)/ use-card-tag-toggle.ts:93-117 |
| tags optimistic rollback | §5 のとおり auto-rollback 依存 |

## 7. Tier 3 dead + stale — 現存確認

- `CardTagBadge.onOpenEdit`: 定義 card-tag-badge.tsx:33、呼出 :71。**全 call site が no-op**(card-tags-section.tsx:678 / exam-card-table-tag-cell.tsx:174 とも `() => {}`)= dead 主張正。
- `createOptionAndAssignPlaceholder`: exam-card-table.tsx:429-436。コメント自認の到達不能 placeholder(TagCell が常に override)= dead 主張正。※ただし §6 の placeholder override 地雷と表裏 — 除去は設計変更(TagEditCallbacks の型分割等)を伴う。
- `session-runner.tsx:255` の `submit-review-tx` dangling 参照: 現存(grep で app 内この 1 件のみ)。

## 8. テスト網 — **乖離(B): 「安全網最薄」は要修正(P3 spec の前提に直結)**

- audit §6.4「components: ~13%」は **`components/`(共有 UI)の数字**。P3 の主戦場 `app/(app)/app/exams/[id]/` は別で、**現 HEAD で `_components/` に test 32 file・P3 対象 11 file 全てに co-located test が現存**(controller 裏取り済):
  - card-tags-section.test.tsx **2,191 行** + card-tags-section-idb.test.tsx / exam-card-table.test.tsx **2,309 行**(+ bulk/sorting/columns 等の分割 suite)/ card-tag-add-popover.test.tsx **2,905 行** / inline-text-field.test.tsx 951 行(debounce + commit)/ inline-option-row.test.tsx 782 行 / exam-card-side-peek.test.tsx 461 行(side peek 実装 commit `81e17f6` から同梱)/ inline-card-list.test.tsx 544 行。
  - hooks: use-card-options / use-card-tag-toggle / use-bulk-\* に renderHook test(use-card-tag-toggle は「enqueue 失敗 → rollback」「stale-closure regression」describe あり)。
  - lib/sync: optimistic-mutation.test.ts 686 行(rollback / multi-store / noop / fail-fast)+ entity-mutation-flush / review-flush で **optimistic→flush pipeline は unit レベル完備**。
  - インフラ: vitest default env=node、component test は per-file `@vitest-environment jsdom` + fake-indexeddb/auto(グローバル)+ @testing-library/react 16 + ResizeObserver/offset stub(vitest.setup.ts)。**characterization を書く足場は既製**。
- **本当に無いもの**(= P3 characterization の実 gap 候補):
  1. **cross-component 相互作用 flow**(例: text-field commit → optimistic-mutation → flush を exam-detail-view 実 tree で通す統合)— 単体 suite は各層個別に mock 境界で切っている。
  2. **地雷 invariant を明示 pin する test があるかは未確認**(単一 subscription 排他 / V6 blur close commit / memo 凍結 / selection prune が describe 名レベルで既存 suite に固定されているか — **spec 起草時に地雷×既存 test の対照表を作るのが次作業**)。
  3. E2E/Playwright: 不在(audit どおり)。integration 3 本は webhook/page で P3 無関係。contract 7 file は全て server/wire で client interaction cover ゼロ(audit どおり)。
- **spec への含意**: characterization 戦略は「ゼロから回帰網を作る」ではなく「**(a) 地雷 invariant が既存 suite に pin 済みかの監査 → (b) 欠けている invariant と cross-component flow だけ追加**」の 2 段に再定義できる。工数前提が handoff 記述より大幅に軽い可能性。

## 9. lint 面の P3 surface(baseline §B(iv)/(v) + 現 config)

- **§B(iv) 'off' override 削減期限 = P3**(明記): 残 3 file = components/marketing/contact-form.tsx(Block A)/ exams exam-detail-view.tsx(Block B 深相対)/ upload result page(Block B 深相対)。※get-custom-session-cards は P1 で削除済。
- **§B(v) cross-feature import 5 件は現状 lint 非捕捉・allowlist 未登録**(P3 で allowlist 化 or 解消): study/custom→exams ×2(custom-filter-form.tsx:15,21)/ exams→tags ×2(card-tag-edit-fields.tsx:26,27)/ `_lib`→`_components` 逆依存 1(column-pinning.ts:6 — audit 補足どおり意図的 columns-as-data、循環要因として注記のみ)。
- 追加発見: **use-card-options.ts に `react-hooks/refs: off` override**(eslint.config.mjs L105、Sync-fix-1 由来・wave-2 後回し明記)— V3/昇格で同 file を触るため P3 で解消可否を判断する surface。

## 10. spec 起草(次工程)への論点持ち込み

1. characterization 戦略の再定義(§8 — 監査 + 差分追加の 2 段。E2E 新規導入の費用対効果判断は据え置きで OT 相談事項のまま)。
2. V3 スコープの実態補正(§2 — 正規化 1 箇所 + patch 構築分散の集約)。
3. runOptimistic\* 昇格で「helper 非経由の直 tx 6 箇所」(use-card-tag-toggle + card-tags-section 5 関数)をどう扱うか(§5)。
4. Tier 3 dead の createOptionAndAssignPlaceholder 除去は placeholder override 地雷と表裏(§7)— 単純削除でなく TagEditCallbacks 設計に踏み込むか。
5. lint 面 3 系統(off 削減 / cross-feature allowlist / react-hooks-refs)を P3 task に含める(§9)。
