# DDD リファクタ P3 — client 側 use-case 化 spec

- 日付: 2026-07-07 / branch: `dddrefactor` / 起草 = Fable(OT 決定)、実装 = CC(Opus)subagent-driven
- 根拠: fact-finding = `docs/superpowers/sessions/2026-07-07-ddd-p3-factfinding.md`(現 HEAD `aeb4d23` 再スキャン・OT 承認済)+ spec 起草時の追加実測 4 本(地雷×test 対照監査 / 直 tx 6 箇所 / TagEditCallbacks / 統合 flow 実現性)
- SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(D-1〜D-6 / N-1〜N-5)

## 1. 目的とスコープ

### 1.1 目的

exams UI の presentation に常駐する client ドメインロジック(タグ CRUD / card write / commit セマンティクス)を use-case 層(lib)へ移設し、side peek 着地で生まれた near-verbatim 複製を解消する。挙動不変(behavior-preserving)。

### 1.2 in scope

- **W0**: characterization gap 埋め(地雷 pin 2 + cross-component 統合 flow 1)— **全移設 task に先行**
- **W1**: V1 = タグ CRUD の `lib/tags` 移設(card-tags-section.tsx:80-508 の 12 関数 + TagEditCallbacks)
- **W2**: runOptimistic\* 昇格の実体 = 直 tx 6 箇所の helper 寄せ(個別判定済・全箇所可)+ tags manager 側との単一 source 化(判断点 1)
- **W3**: V3 = card write の patch 構築・空文字→null 正規化の `lib/cards` 集約(乖離 A 補正済スコープ)
- **W4**: §4.4-1 = side peek ⇄ inline-card-list のカード編集 UI 複製解消(共通 component 抽出)
- **W5**: inline primitive の低次共有(sharedBoxChrome / dirty-guard / auto-resize)— commit 機構は統合しない
- **W6**: 掃討 = Tier 3 dead(onOpenEdit / createOptionAndAssignPlaceholder)+ session-runner.tsx:255 stale コメント
- **W7**: lint 回収(判断点 4 の線引き)
- **W8**: 最終 gate + SSoT + baseline §B(vi) P3 surface 追記

### 1.3 out of scope(P3 で触らない)

- **V2 の read 側**(useLiveQuery / UI 直 Dexie read)は温存 — D-1/N-5(client repository 層を作らない)の帰結。mirror 購読は presentation の正当な関心。
- 二段構え(client pre-check = UX / server = authoritative)の統一(§4.1 仕分け方針)。
- wire 変更系(N-1〜N-3)/ Dexie store・index の形の変更(N-4。P3 は schema 変更不要の見込み。必要が生じたら D-6 で別 commit 隔離)。
- V6 の blur 依存 close commit の**解消**(InlineOptionCell に commit-on-unmount を足す等)— 挙動変更のため P3 外。W4/W5 は現機構を温存したまま移動する(§3.6)。
- measure/timing 配管(P2 温存判断の継続)/ contact-form の components→app 解消(P4 送り・判断点 4)。

### 1.4 凍結契約(D-2 再掲・全 work item の最上位制約)

API payload / Dexie schema の形 / entity_mutations 形式 / error code / HTTP status / 日本語文言 / cache header / revalidatePath / tombstone entity_type / op 名 / ops・log イベント名。**P3 固有の追加凍結 = 地雷 8 invariant(§5 対照表)** — 特に enqueue 失敗時の Dexie auto-rollback 意味論、mutation の patch shape・enqueue 件数・順序。

## 2. 現 HEAD grounding(`aeb4d23` 再スキャン・確定事実)

fact-finding doc §1-9 が正本。spec 起草時の追加実測による確定事実:

1. **地雷 8 invariant 中 6 つは既存 test で明示 pin 済**(§5 対照表)。gap = selection prune HS-2(test 完全欠落)+ TagCell cardId-bound override(間接のみ)。
2. **直 tx 6 箇所は全て既存 helper に乗る**: use-card-tag-toggle(→ runOptimisticMutation そのまま)/ handleDeleteCategory・handleDeleteOption(→ runOptimisticMutation。tags manager の category-list.tsx:171 / option-list.tsx:147 が**同形 cascade delete を helper で実装済** = client 内二重実装が実在)/ handleCreateCategory・createOption(→ runOptimisticCreate そのまま)/ handleCreateOptionAndAssign(→ runOptimisticMutation。2 mutations のため runOptimisticCreate は不可)。
3. **エラー挙動差**: 直 tx は throw を caller に伝播、helper は silent catch + logger.warn 既定(`throwOnError` で伝播可)。寄せる際は各 caller の現行エラー処理(console.error / UI 表示)を保存する必要がある(§3.3)。
4. **統合 flow test は既存インフラの組み合わせだけで記述可能**: fake-indexeddb + useLiveQuery 実走(exam-card-table.test.tsx smoke②③前例)+ 実 Dexie mirror 書込 assert(inline-text-field.test 前例)+ BulkApiClient injection(entity-mutation-flush.test 前例)。jsdom で担保不能な残余 = 実 focus/blur・virtualizer 実 scroll・実 scroll 起因 unmount の 3 点のみ。
5. **TagEditCallbacks**(10 メンバー全必須): placeholder は型充足のためだけの Tier 3 dead。実経路は TagCell(cardId-bound)と ActionBar(bulk 版)の 2 override。除去 3 案の実測 = (a) 型分割 8 file / (b) optional 化 5 file + null guard 2 箇所 / (c) 温存 0 file。

## 3. 判断点の記録

### 3.1 characterization 戦略 = 「監査 + 差分追加」の 2 段(OT 承認済・乖離 B)

- 段 (a) **監査は完了**(§5 対照表 = deliverable)。6/8 pin 済のため「ゼロから構築」しない。
- 段 (b) **追加は 3 点のみ**: ① selection prune HS-2 の明示 pin(HIGH・filter 変更/行削除で selection ⊆ 可視集合を assert)② TagCell override の明示 pin(MEDIUM・createOptionAndAssign が cardId-bound で呼ばれることを assert)③ cross-component 統合 flow 1 本(inline-card-list 実 tree で text-field 編集 → blur → 実 Dexie mirror 反映 + outbox enqueue → mock client flush まで)。
- **W0 は全移設 task に先行**(動かす前に固定)。

### 3.2 E2E(Playwright)= 不採用を推奨(判断点 3)

費用 = 新規依存導入(CLAUDE.md 事前相談事項)+ PR なし・GHA なし運用での維持。効果 = jsdom で書けない残余 3 点のみ(§2-4)。この 3 点は **baseline §B(vi) の merge 後まとめ stg smoke(DevTools MCP 実 browser)で担保可能な性質**のため、E2E を導入せず §B(vi) に P3 surface として明記する(W8)。

### 3.3 直 tx 6 箇所 = 全箇所 helper 寄せ・ただしエラー挙動保存(OT 論点 3)

一律でなく個別判定した結果、6 箇所とも helper のモデルに乗る(§2-2)。「乗らない正当な理由」は無かった — cascade delete も whole-set 差分も tx 前計算 + mutate callback で表現可能で、tags manager 側に helper 実装の前例が既にある。ただし:

- **W1(as-is 移設)と W2(helper 寄せ)は別 task・別 commit**(P1/P2 の「移動と書換えの分離」規律。bisect 切り分け維持)。
- **エラー挙動の保存が W2 の受け入れ条件**: 各 caller が直 tx の reject に依存している場合(catch → console.error / UI 通知)は `throwOnError: true` で現行どおり伝播させる。silent catch への黙変更は挙動変更であり禁止。
- log イベント名は凍結対象(D-2)— helper の logEvent に渡す名前は既存 ops/log 名を変えない(新規 log を増やさない)。

### 3.4 tags manager との単一 source 化 = in scope を推奨(判断点 1)

card-tags-section の cascade delete ⇄ tags manager(category-list / option-list)の cascade delete は client 内の実重複(§2-2)。W1 で lib/tags に use-case を置いた後に manager 側を付け替えないと「lib use-case + manager 実装」の新たな二重状態を P3 自身が作ることになるため、**manager 側 rewiring を W2 内の独立 commit として in scope に含めることを推奨**。scope 膨張を懸念する場合は out(別 task 起票)も可 — OT 判断。

### 3.5 placeholder 除去 = (b) optional 化を推奨(OT 論点 4・判断点 2)

`createOptionAndAssign?` の optional 化(5 file・null guard 2 箇所)。ExamCardTable が undefined を渡す実 caller になるため guard は実分岐(過剰防御に非該当)。(a) 型分割(8 file)は V1 移設と絡めると diff が混濁、(c) 温存は dead の永続。W6 の独立 commit で実施。`onOpenEdit` は全 call site no-op のため prop ごと削除(単純)。

### 3.6 W4/W5 の地雷温存原則(最重要制約)

- **W4(side peek 複製解消)**: 共通 component はデータを props で受ける(**新規 useLiveQuery を作らない** — 単一 subscription 不変条件)。V6 の blur → close commit 機構は side peek 側 container に残す(共通 component に commit 知識を持ち込まない)。DeleteCardButton / autoEditOnMount / layout 差分は props で表現。
- **W5(inline primitive)**: 共有するのは**低次 3 点のみ**(sharedBoxChrome 文字列 / dirty-guard sentinel / auto-resize)。**commit 機構(commit-on-unmount・debounce drain)は意図的差分として統合しない** — InlineOptionCell が commit-on-unmount を持たない事実に V6 が依存しているため、統合は挙動変更に直結する。

### 3.7 lint 線引き(OT 論点 5・判断点 4)

- **回収**: exam-detail-view.tsx + upload result page の深相対 2 件(機械的 `@/` alias 置換 + 'off' override 除去。§B(iv) 期限 = P3)/ use-card-options の `react-hooks/refs: off` は W3 で同 file を触る際に解消可否を判定(直せなければ理由を記録し据え置き)。
- **allowlist 化(解消せず可視化)**: cross-feature 4 件(study/custom→exams ×2 / exams→tags ×2)+ column-pinning 逆依存 1 件(意図的 columns-as-data・注記のみ)。※custom-filter-form:21 の型 import は P1 の card-filter-predicates 移動で解消済みの可能性 — W7 で現物確認。
- **P4 送り**: contact-form(components→app は server action の配置問題で P3 の関心外)。
- Next matcher/proxy/next.config は触らないため per-task `pnpm build` gate の追加条件は非該当(通常の risk task build は §7)。

## 4. Work item 詳細

### 4.1 W0. characterization 追加(先行 task)

§3.1 の 3 test を既存 suite の流儀で追加(selection prune → exam-card-table.test.tsx / override → exam-card-table-tag-cell.test.tsx / 統合 flow は新 file 可)。既存 test の変更はしない(pin の付け足しのみ)。完了 = 3 test green + 既存全 green。

### 4.2 W1. タグ CRUD → `lib/tags` as-is 移設(V1)

card-tags-section.tsx の module スコープ 12 関数(80-508)+ TagEditCallbacks 型を lib/tags へ**verbatim 移動**(直 tx のまま。書換えは W2)。importer 8 箇所(実装 4 + type 4)を rewiring。CardTagsSection component と popover 配線は presentation に残す。buildNewOption(pure)も lib/tags へ。co-located test(card-tags-section.test.tsx の該当 describe / -idb.test.tsx)は移設先へ re-point。

### 4.3 W2. 直 tx 6 箇所の helper 寄せ + manager 統一(runOptimistic\* 昇格)

§3.3 の条件下で 6 箇所を runOptimisticMutation / runOptimisticCreate へ(handleCreateOptionAndAssign は 2 mutations で runOptimisticMutation)。判断点 1 採択時は tags manager(category-list / option-list)を lib/tags use-case へ付け替え(独立 commit)。optimistic-mutation.ts に「application service(mirror + outbox + flush kick = application transaction)」の役割コメントを付す(層の新設・改名はしない = N-5)。

### 4.4 W3. card write 集約(V3・補正スコープ)

NULLABLE_FIELDS + 空文字→null 正規化(inline-text-field)/ 新規カード patch 構築(inline-card-list 218-236)/ options commit の patch 組み立て(use-card-options)を lib/cards の pure 関数群へ carve。runOptimisticUpdate 呼び出し自体は hook/component に残る(トリガーは UI の関心)。react-hooks/refs off の解消可否をここで判定(§3.7)。

### 4.5 W4. side peek 複製解消(§4.4-1)

InlineTextField ×5 + CardTagsSection + InlineOptionList のブロックを共通 component(例: `card-editor-fields.tsx`、exams `_components` 内)へ抽出し両者から使用。§3.6 の温存原則が受け入れ条件。exam-card-side-peek.test.tsx F2(blur 順序 pin)と inline-card-list.test.tsx が回帰の正。

### 4.6 W5. inline primitive 低次共有

sharedBoxChrome / dirty-guard sentinel / auto-resize を exams `_lib` の共有 module へ(3 重目の複製が無いため lib/ 昇格はしない — rule of three)。commit 機構は不変(§3.6)。

### 4.7 W6. 掃討

onOpenEdit prop 削除 / placeholder optional 化(§3.5)/ session-runner.tsx:255 の `submit-review-tx` → 実対向(review-events/bulk route → lib/reviews)へのコメント修正。

### 4.8 W7. lint 回収

§3.7 の線引きどおり: 深相対 2 件の alias 置換 + override 除去 / cross-feature allowlist 新 config block(escape 規約: `\\(...\\)` / `\\[...\\]`)+ import-boundary.test.ts 追随。

### 4.9 W8. 最終 gate + docs

whole-repo lint --max-warnings=0 / typecheck / test / test:contract 77 / build 全 exit 0。SSoT 進捗表更新(完了 HEAD + 再スキャン記録)。baseline §B(vi) に P3 surface 追記(タグ CRUD 実操作 / card inline 編集 / side peek 開閉 commit / **E2E 残余 3 点**: 実 focus/blur・virtualizer 実 scroll・scroll 起因 unmount commit)。

## 5. 回帰検知の正(地雷 × 既存 test 対照表 = 監査 deliverable)

| # | 地雷 invariant | pin 状態 | 根拠 |
|---|---|---|---|
| 1 | 単一 subscription 排他 | 明示 pin | exam-detail-view.test.tsx:341-370(Case ⑤ conditional unmount) |
| 2 | commit-on-unmount + dirty-guard | 明示 pin | inline-text-field.test.tsx:820-951(Fix-3 Imp#1・5 case: dirty 保存/2 guard/orphan gate/二重 enqueue なし) |
| 3 | ghost merge | 明示 pin | inline-option-row.test.tsx:672-782 + .debounce.test.tsx:232-247 |
| 4 | TagCell cardId-bound override | **間接のみ → W0 で追加** | tag-cell.test.tsx は placeholder 描画のみ。override 動作の assert 欠落 |
| 5 | selection prune HS-2 | **なし → W0 で追加** | filter 変更/削除後の prune を assert する test 皆無 |
| 6 | virtualizer memo 凍結 | 明示 pin | exam-card-table.remount.test.tsx:216-305(T2 凍結 / T3 非 resize 追従) |
| 7 | V6 blur 依存 close commit | 明示 pin | exam-card-side-peek.test.tsx:411-438(F2 blur → onClose 順序) |
| 8 | Dexie auto-rollback 依存 | 明示 pin | card-tags-section.test.tsx:681-849 + -idb.test.tsx:147-227 + optimistic-mutation.test.ts:230-436 |

P0 golden(wire 面)は client interaction を cover しない — P3 の回帰の正は「上表 + W0 追加分 + 既存 co-located suite green(snapshot 更新ゼロ)」。

## 6. Deliverables

- lib/tags use-case 群(W1/W2)/ lib/cards card-write pure 群(W3)/ 共通 card-editor component(W4)/ inline primitive 共有 module(W5)
- characterization 3 test(W0)+ 対照表(§5・本 spec に収録済)
- lint: override 2 除去 + cross-feature allowlist block(W7)
- SSoT / baseline §B(vi) 更新(W8)

## 7. 完了条件

- 全 task: 挙動不変(既存 test + W0 test green・snapshot 更新ゼロ)+ canonical review Critical 0 + [reviewed]。
- risk task(W1/W2/W4 = 地雷直上)は Codex 独立 review + per-task build。
- W8 gate 全 exit 0 + 「whole-repo lint exit 0 確認済」明記。
- 自走規律: plan 確定後は Global エスカレーション条件(未解決 Critical / 仕様解釈揺れ / 外部設定変更要)のみで停止。

## 8. 非目標 / 申し送り

- V6 機構の解消・commit セマンティクス統一 → 将来 sprint(P3 は温存)。
- contact-form の境界解消 → P4(lib 再編と同時)。
- tags manager 統一を out とした場合 → 別 task 起票(判断点 1)。
- E2E 導入 → 不採用(§3.2)。残余 3 点は §B(vi) stg smoke。

## 9. Codex cross-check(plan 段階で実施)

plan ドラフト後・確定前に `scripts/ai/codex-plan-review.sh`(入力 = fact-finding + 本 spec、plan は参考添付・anchor 防止)。cross-check 1 回 → CC 取りまとめ → OT 承認で plan 確定。

## 付録: 参照

- fact-finding: `docs/superpowers/sessions/2026-07-07-ddd-p3-factfinding.md`
- SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md` / handoff: `docs/plans/2026-07-07-p3-handoff.md`
- audit(凍結): `docs/audit/2026-07-05-ddd-refactor-investigation.md` §3.1 / §4.4 / §5.3 / §6.3
- baseline: `docs/audit/2026-07-06-p0-contract-baseline.md` §B(iv)(v)(vi)
- P2 前例: `docs/superpowers/specs/2026-07-07-ddd-p2-server-usecase-design.md`(as-is 移動 + verbatim 規律)
