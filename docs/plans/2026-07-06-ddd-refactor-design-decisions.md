# DDD リファクタ top-level design decisions

- 日付: 2026-07-06 / branch: `dddrefactor`(develop `8b4a1e9` から分岐)
- 根拠調査: `docs/audit/2026-07-05-ddd-refactor-investigation.md`(統合版・現状検証済。§ 参照は同 doc)
- 本 doc の役割: **プログラム全体の確定判断と phase 進捗の SSoT**。各 phase の実装詳細は持たない(phase ごとの spec / plan が持つ)。仕様判断が変わる場合は本 doc を更新してから phase spec に反映する。

---

## 1. 確定判断(OT 確定・2026-07-06)

### D-1. pragmatic DDD

domain 純粋層 + use-case 関数 + 既存 seam 昇格。フル DDD(全 aggregate に entity クラス + repository の機械的導入)はしない。
**client 側は既存 `runOptimistic*` を application service に昇格し、新 repository 層は作らない**(mirror 書込 + outbox enqueue + flush kick は persistence でなく application transaction であり、repository 抽象はこれを不可視化するため)。

### D-2. wire 変更系はスコープ外 + 凍結契約の定義

audit §6.2(pull の wire generic 化 / outbox 2 系統統合 / 競合解決統一)は今回やらない(→ §3)。
**凍結対象 = 「挙動同一の契約」**: API payload shape / Dexie schema※ / entity_mutations 形式、に加えて **error code・HTTP status・user-facing 日本語文言・cache header・revalidatePath 対象・tombstone entity_type・op 名・ops/log イベント名**。全 phase の review 観点に含める。
※ Dexie schema は D-6 により data 喪失観点の凍結は解除。ただし契約としての形(store 名・index・型)の変更は別 commit 隔離(D-6)。

### D-3. 安全網 = contract/golden test を標準

P0 で /api/pull response・mutation envelope・review-events bulk result・upload result union・webhook 状態遷移の snapshot を固定し、以降の全 phase の回帰検知の正とする。Playwright/E2E は**任意**(必要と判断した時点で別途 OT 相談 — 新規依存のため)。

### D-4. P0 から sprint 化

全 phase の安全網が P0 で作られるため先頭が正しい。phase 順は P0 → P1 → P2 → P3 → P4(§2)。

### D-5. 着手時期 = 今

dddrefactor branch 上で開始。exams UI への機能追加が進むほど P3 対象が広がるため先送りしない。

### D-6. DB 全消去可(prod 含む)の反映

- **Dexie 移行コード・lazy migration・旧版 schema 保持は書かない**。Dexie 変更は version bump + 旧定義削除で行う。
- Dexie store/index 変更は data 喪失リスクとしては**解除**(audit §6.2 の「pending outbox 喪失リスク」は前提消滅)。
- ただし **Dexie schema 変更は DDD 抽出(コード移動・層再編)とは別 commit に隔離**する — bisect 可能性の維持(「移動で壊れたのか schema で壊れたのか」を切り分け可能に保つ)。
- **隔離対象は「形の変化」に限定**:
  - store の追加・削除・index 変更 = D-6 隔離対象(別 commit)。
  - 既存 store の中身削除のみ(store 名・index・型は不変)= 通常の抽出 commit に同居可。
  - 理由 = bisect の切り分け対象は「schema の形が変わったか」であり、データの有無ではない(全消可のため)。形が不変なら「移動で壊れた」以外の疑いが無く隔離不要。

---

## 2. Phase 進捗表

定義は audit §7 の骨子(1 行要約)。詳細は各 phase spec が持つ。

| Phase | 内容(1 行) | 状態 | 完了時 HEAD | 再スキャン記録 |
|---|---|---|---|---|
| P0 | contract/golden tests + smoke checklist + import 境界 lint(allowlist 方式)+ dead code・stale 掃討 | 完了(SHA 記録済・OT push 待ち) | 7b36e58(実装完了)+ 本 SSoT gate commit | 現 HEAD 全数再スキャン済(§A triage 16 乖離 = intentional 15 / 対象外 1 / bug 0)。deliverable = docs/audit/2026-07-06-p0-contract-baseline.md(§A triage + §B 凍結契約 inventory)/ 2026-07-06-p0-smoke-checklist.md。contract golden = tests/contract/(5 面 77 test)。lint 境界 = eslint.config.mjs + tests/lint/import-boundary.test.ts。gate: whole-repo lint --max-warnings=0 / typecheck / test(2979)/ test:contract(77)全 exit 0 |
| P1 | domain 純粋層の抽出・移設 + 二重実装の仕分け・単一 source 化 | 完了(SHA 記録済・OT push 待ち) | 8a0e8ee(実装完了・Task6)+ 本 SSoT gate commit | 着手時 `a11afca` 再スキャン済(§5.2 純粋資産は既に lib/ 適所・逆流ゼロ / carve-out 2 + 型 relocate 1 + 逆依存 1 + dedup 2 が実体)。**Task1** compareTagEntry 抽出(3 site dedup)**Task2** computeStreak+addDays→lib/streak-core.ts hoist(二段構え温存)**Task3** deriveExamStatuses→lib/exams/derive-exam-statuses.ts carve(pure import0)**Task4** classifyChange+getPendingState→lib/stripe/subscription-changes.ts carve(決済・import type Stripe のみ・build server-only 混入なし)**Task5** card-filter-predicates→lib/cards move + allowlist entry 削除=**P0 lint 機構初回実証**(削除後 lint green で逆依存消滅実証)**Task6** CustomSessionCriteria→type-only module relocate(pure seed の Dexie 型 edge 切断)**Task7** V5 filter 代数 confirm-only=単一 source 確定(predicate/型が card-filter-predicates.ts に単一・3 重コピーなし)。全 code task = canonical review pass、Task3/4/5 = Codex 独立 review pass(全 Crit0/Imp0)。**最終 gate 全 exit 0**: test 2983(P0 2979+compareTagEntry unit 4)/ typecheck / whole-repo lint --max-warnings=0 / build。**残リスク**: source-doc-status.ts の 3 DB 関数は既存 unit test なし(P1 挙動不変ゆえ非追加・route.test が経路担保)。**latent 不純**(fsrs.rate/newCard/todayInJst の =new Date() default)は P1 非対象・baseline §B 申し送り(clock 注入 phase で扱う)。spec = specs/2026-07-07-ddd-p1-domain-extraction-design.md / plan = plans/2026-07-07-ddd-p1-domain-extraction.md / Codex = codex/2026-07-07-plan-ddd-p1-domain-extraction.md + task3/4/5-*.md |
| P2 | server 側 use-case 化(review-events route → webhooks 2 本 → process.ts 分解) | 実装中 | — | 着手時 `b3bcb07` 再スキャン済(audit §3.3/§6.1 の 4 対象は行数・構造とも全一致・stale なし。P1 carve-out 資産との衝突なし)。spec = specs/2026-07-07-ddd-p2-server-usecase-design.md / plan = plans/2026-07-07-ddd-p2-server-usecase.md(6 task)/ Codex plan cross-check = codex/2026-07-07-plan-ddd-p2-server-usecase.md(採用 15 / 不採用 3) |
| P3 | client 側 use-case 化(タグ CRUD 移設 / card write 集約 / side peek 複製解消 / runOptimistic* 昇格 / inline primitive 統合) | 未着手 | — | — |
| P4 | インフラ DRY(outbox flush 層の限定共通化 / pull server 内 factory / retry・transient 統合 / 認証 wrapper / lib 再編) | 未着手 | — | — |

**運用注記**:

- 各 phase は sprint フロー(brainstorming → spec → plan → 実装 + canonical/Codex review)に載せる。phase 完了時に本表へ **完了時 HEAD SHA** と **再スキャン箇所**(着手時に audit の該当主張を現 HEAD で再確認した範囲と結果)を記録する。
- audit の file:line は `5d3baef` 検証時点。**phase 着手時に対象箇所を再スキャン**し、stale があれば audit でなく phase spec 側に現状を記す(audit は歴史記録として凍結)。
- 状態欄の値: 未着手 / spec 起草中 / plan 確定 / 実装中 / 完了(SHA 記録済)。
- **状態欄の更新は各 phase の CC が該当 commit と同じ commit で行う**(spec 起草開始時 → spec 起草中、plan 確定 commit 時 → plan 確定、実装 commit 時 → 実装中、完了時 → 完了 + HEAD SHA 記録)。OT push で確定する。

---

## 3. やらない 4+1(理由の記録)

後から「なぜやらなかったか」を追うためのセクション。解除には OT 判断を要する。

| # | やらないこと | 理由 |
|---|---|---|
| N-1 | **競合解決 3 方式(replay / LWW / server-wins)の統一** | **反 DDD だから**。FSRS=event replay、entity 編集=LWW、mirror=server-wins は各 context のドメイン特性に合った正しいモデルであり、統一は「見た目の一貫性」のために意味論を壊す。恒久にやらない(deferではない)。 |
| N-2 | **outbox 2 系統(entity_mutations ⇄ answer_events)の統合** | **defer**。価値小: review 系のみ retry controller / pullBack hook / session grouping を持つ非対称(検証済)で、統合は大改修の割に得るものが薄い。将来 3 系統目が必要になった時に再評価。 |
| N-3 | **pull の完全 generic 化(PullResponse 型そのものの wire generic 化)** | server 内 factory 化(wire に出ない範囲)は **P4 で in scope**。wire generic 化は残り 2 割の**任意 consider** — P4 spec 起草時に費用対効果を見て判断し、採らない場合は理由を P4 spec に記す。 |
| N-4 | **Dexie schema の再設計(store 分割・index 全面見直し等)** | **別 sprint**。DDD 層再編と直交する関心。D-6 により移行コスト自体は低いが、混ぜると bisect 可能性と review 粒度を壊す。本リファクタ中の Dexie 変更は「抽出に必要な最小限 + 別 commit 隔離」のみ。 |

**dead code の Tier 分散(P0 spec 由来・2026-07-06)**: audit §4.3 の dead リストは「P0 で全消し」ではなく phase 分散に変更(現 HEAD 再スキャンで多くが「本体は内部利用で生存・export だけ test 専用」型 or 型連鎖の設計変更と判明)。Tier 1(完全 dead + stale コメント)= P0 / Tier 2(export-only-dead: isUpgrade・newCard・buildNewOption・jstMonthBoundsUtc・scheduler)= owning phase / Tier 3(onOpenEdit・createOptionAndAssignPlaceholder)= P3。詳細表 = P0 spec §6。後 phase での「掃討し忘れ」誤認防止のための記録。
| N-5 | **client 側 repository 層の新設**(= D-1 の裏面) | **唯一の pragmatic 判断点として明示**。教科書的 DDD なら repository を置く場面だが、Dexie mirror + outbox + flush は application transaction であり、隠蔽すると coalesce / rollback / pull-back の同期挙動が不可視化する(audit §5.3、Codex 指摘 3)。`runOptimistic*` の application service 昇格で代替する。 |

---

## 4. 変更履歴

- 2026-07-06: 初版(OT 確定判断 D-1〜D-6 / phase 表初期化 / やらない 4+1)。
- 2026-07-06: D-6 に Dexie 隔離対象の明確化(形の変化に限定)、進捗表に状態更新の責任者・タイミングを追記。
- 2026-07-06: P0 spec 起草開始(状態 → spec 起草中)。dead code Tier 分散を §3 に記録(P0 spec §6 詳細)。
- 2026-07-06: **P0 完了**(状態 → 完了)。subagent-driven で 11 task 実走(T0 triage→T1 fixtures→T2-T6 contract golden 5 面→T7 import 境界 lint→T8 dead-sweep Tier1→T9 §B+smoke→T10 gate)。各非自明 task に canonical(requesting-code-review)+ Codex 独立 review 実施・全 Critical/Important 収束。bug handoff(条件 2)不発火(§A bug 0)。実装完了 HEAD=7b36e58。
- 2026-07-07: **P1 spec 起草開始**(状態 → spec 起草中)。前セッションの brainstorming(Explore ×3 で現 HEAD `a11afca` 実測)+ OT 承認済み方向を spec 化。3 判断点 = 物理構造(lib/domain 一括新設せず carve-out のみ)/ 逆依存 P1 解消(card-filter-predicates 移動 = P0 lint 機構初回実証)/ streak characterization 新規不要(既存二重 suite re-point)。P1 実体 = carve-out 2(deriveExamStatuses / classifyChange+getPendingState)+ 型 relocate 1(CustomSessionCriteria)+ 逆依存解消 1 + dedup 2(computeStreak hoist / compareTagEntry 抽出)。V5 filter 代数は確認のみに格下げ。latent 不純は §B 申し送り。
- 2026-07-07: **P1 plan 確定**(状態 → plan 確定)。8 task(Task1 compareTagEntry / Task2 streak hoist / Task3 deriveExamStatuses carve / Task4 subscription pure carve〈決済〉/ Task5 card-filter-predicates move + allowlist 削除 / Task6 CustomSessionCriteria relocate / Task7 V5 confirm / Task8 最終 gate + SSoT)。Codex plan cross-check(1 パス)反映済。OT 補正 = review 粒度分離(canonical 全 task / Codex+build は Task3/4/5 のみ / full test は Task8 集約)。共有 module = lib/streak-core.ts。SSoT commit は code と分離。次 = subagent-driven で Task1 自走(Critical 未解決 or build server-only 混入時のみ停止)。
- 2026-07-07: **P1 完了**(状態 → 完了)。subagent-driven で 8 task 完走(Task1-6 code / Task7 confirm / Task8 gate)。実装 = fresh subagent(commit させず controller が review→[reviewed] commit の一方向則)。canonical(SDD task-reviewer)全 code task pass、Codex 独立 review = risk task Task3/4/5 pass(全 Crit0/Imp0)。per-task Minor は全て controller 即修正(stale comment / dead re-export / import style 統一)。build は Task3/4/5 + 最終 Task8 集約で全 exit 0(Task4 決済 carve-out で server-only 混入なし=escalation 不発火)。最終 gate: test 2983 / typecheck / lint / build 全 exit 0。実装完了 HEAD=8a0e8ee。Critical 停止・build 混入・仕様揺れとも不発火で一気通貫自走。次 = OT 報告 → push → stg smoke(OT 指示)。P2 は別 sprint 境界で停止。
- 2026-07-07: **P2 plan 確定**(状態 → plan 確定・OT 承認 `f168b9c`)。6 task(Task1 review-events→lib/reviews / Task2 stripe webhook→lib/stripe / Task3 clerk webhook→lib/clerk〈+stale コメント 8→10〉/ Task4 process.ts guard 分解→_actions/upload-guard / Task5 persistence 分解→_actions/upload-persistence / Task6 最終 gate + SSoT + baseline §B(vi))。Codex plan cross-check 1 パス反映(採用 15 = tx 内 I/O は tx 経由・ParsedEvent type export・server-only・mock 到達性列挙・保存 tx index invariant 等 / 不採用 3 = per-task gate 軽量化・guard/persistence lib 化・Phase 0 lib 寄せ〈全て OT 方針と衝突〉)。OT 反映 2 条件 = Phase 0 境界順序(Task1 制約・「wire 境界のみ残す」唯一の明文例外)/ measure・timing log 接触 = Critical 相当で自走停止(Global エスカレーション)。review 粒度 = 全 code task で canonical + Codex + per-task build、full test は Task6 集約。次 = subagent-driven で Task1 自走(Global エスカレーション条件のみで停止)。
- 2026-07-07: **P2 spec 起草開始**(状態 → spec 起草中)。起草 = Fable(P1 完了時 OT 判断・handoff 準拠)、実装 = CC(Opus)。現 HEAD `b3bcb07` 再スキャン(4 対象全一致)+ OT 方向承認済み 5 論点(①配置 = lib/reviews 新設 / lib/stripe 既存 / lib/clerk 新設〈stripe 対称〉②process.ts は in-place 分解〈現 path 維持必須・lib/upload 新設なし〉③as-is 移動のみ〈measure 配管温存〉④新規 unit test なし〈route.test + golden が正〉⑤clerk stale コメント 8→10 回収)+ 追加 4 条件(lib/reviews は暫定置き場注記 / 1 関数 = 1 tx〈lock も tx も跨がない〉/ mock 境界の task ごと検証 / golden 赤 = 即停止)を spec 化。
- 2026-07-07: **P1 完了時 OT 判断(記録)**。① **push/merge**: dddrefactor は develop/main に反映しない — 全 phase(P0〜P4)完了 + 異常なし確認まで merge しない方針(P1 単独の develop/main 反映もしない)。develop/main 反映は **P4 完了後に OT 判断**。② **P1 個別 stg smoke = 省略**(理由: 挙動不変の pure 移設 + 既存 co-located test cover + build green + stg 環境が dddrefactor に無い)。merge 後のまとめ smoke 対象は baseline §B (vi) に申し送り。③ **最終 review Minor 2 = record-only 据え置き**(streak-core.ts の lib/ root 配置 = 判断1〈lib/domain 新設せず〉の帰結どおりで意図通り / codex md 末尾 newline = cosmetic)。
