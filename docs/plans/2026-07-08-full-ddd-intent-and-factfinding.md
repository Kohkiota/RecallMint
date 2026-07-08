# 完全 DDD 移行 — 意図の記録 + fact-finding

- 日付: 2026-07-08 / branch `develop`(HEAD `7c90246`・DDD リファクタ P0〜P4 完了直後)
- 本 doc の役割: **OT の方針表明の記録**と、その場で実施した fact-finding の結果。**将来のセッションはこの doc を読めば「なぜ完全 DDD に進むのか・現状どこまで来ているのか・何から着手すべきか」が分かる**ことを目的とする。spec でも plan でもない(着手時に brainstorming → spec → plan を正規に回すこと)。
- fact-finding 実施: Explore 2 体(aggregate 候補・不変条件棚卸し / 書込経路・ルール執行点棚卸し)+ controller 統合。file:line は HEAD `7c90246` 時点 — **着手時に必ず再スキャン**(P0〜P4 と同じ規律)。

---

## 1. 意図の記録(OT・2026-07-08)

**OT 決定: 「やはり、完全な DDD にしたい」。** pragmatic DDD(P0〜P4)で止めず、entity / value object / aggregate / repository / domain event を備えた本格的な DDD 構造へ進む意向。

### 背景(この決定に至った文脈・2026-07-08 の議論)

1. **P0〜P4 完了直後**: pragmatic DDD(純粋 domain 関数 + use-case 関数 + infra 分離 + import 境界 lint)が完成し、develop/main に ff-merge・stg smoke pass 済み。
2. **横展開の視野**: Notion のように web + デスクトップ + モバイルへ横展開する可能性、別サービス追加の可能性を OT が意識。domain の再利用性(FSRS / フィルタ代数 / streak が全フロントで同一挙動)を確保したい。
3. **「SaaS は DDD にしておけばよかった」という実務者の後悔談**(OT が言及)への共感: 業務ルールが route/UI に散ると「ルールの本体はどこ?」が失われ、後から retrofit するコストが跳ね上がる。**先に構造を作っておく先行投資**として。
4. **モノレポ化も視野**(同日の議論): 完全 DDD の層は将来 `packages/domain` 等の物理 package 境界の下敷きになる。パイロットとして純粋層 1 package の切り出し案も出ている(未決)。

### 完全 DDD で何を得たいか(意図の要約)

- 不変条件(invariant)を **aggregate に閉じ込め、不正な状態を作れなくする**(現状: ルールが最大 14+ 箇所に分散)。
- 状態遷移(特に Subscription)を **state machine として明示**する。
- ドメインの重要な出来事を **domain event として型で表現**する(現状: implicit)。
- client/server で二重実装されているルールを **共有 pure module に単一化**する。

---

## 2. 既存確定判断との衝突(解除には OT 判断が要る)

P0〜P4 の SSoT(`docs/plans/2026-07-06-ddd-refactor-design-decisions.md`)に記録された確定判断のうち、完全 DDD と衝突するもの:

| 判断 | 内容 | 完全 DDD との関係 |
|---|---|---|
| **D-1** | pragmatic DDD(フル DDD はしない) | **正面から解除対象**。解除の範囲(どの aggregate まで・repository の深さ)を次 spec で OT 確定 |
| **N-5** | client repository 層は新設しない(mirror+outbox+flush は application transaction であり、隠蔽すると coalesce/rollback/pull-back が不可視化) | **部分解除の検討対象**。ただし理由は今も有効 — 後述 §5 の推奨は「repository は server 側に限定、client は aggregate 純粋関数 + 既存 outbox の形を維持」 |
| **N-1** | 競合解決 3 方式(replay/LWW/server-wins)の統一は恒久にやらない | **衝突しない(維持推奨)**。context ごとの競合意味論はむしろ bounded context の教科書的帰結。完全 DDD でも統一しない |
| N-2 / N-3 / N-4 | outbox 2 系統統合 defer / pull wire generic 見送り / Dexie 再設計別 sprint | 完全 DDD と直交。個別に再評価可 |

---

## 3. Fact-finding ①: aggregate 候補と不変条件の現在地

6 候補を「不変条件数 / 分散度 / local-first 二重実装 / 難度」で棚卸しした結果(詳細な file:line は本節の各行参照):

| 優先 | Aggregate 候補 | 不変条件 | 分散度 | 二重実装 | 難度 | 備考 |
|---|---|---|---|---|---|---|
| ★★★★★ | **Subscription / Billing** | 9(status 正規化・rank・pending/schedule・cancel_at 一元化・release gate 等) | **14+ 箇所 / 4 file**(handle-stripe-event.ts:29-102,122-387 / subscription-changes.ts:14-45 / subscription.ts:59-289) | **なし(server-only)** | 低 | 最有力。state machine 化で release gate の多層防御が構造化できる |
| ★★★★ | **StudySession + AnswerEvents** | 6(冪等・orphan 排除・replay 順序・count mismatch 防御・JST 集計) | **1 file に集約済**(lib/reviews/ingest-review-events.ts:86-402) | 低 | 低 | ほぼ「関数 → aggregate に持ち替えるだけ」。ただし session status 遷移ガード(completed 後 append 拒否)が未実装(§4 発見 #2) |
| ★★★ | **Card + Options** | 8(correct_answer_ids 導出・null 正規化・option 採番・長さ制限) | 8 箇所(card-write.ts:33-103 / card-field-handlers.ts / validation/card.ts / mutation-schemas.ts / apply-card-mutation.ts:81-83 等) | **構造的に残る**(楽観更新 ⇄ server 再検証) | 中 | 共有 pure module で二重化を最小化する方向 |
| ★★ | **TagCategory + Options** | 7(single/multi 制約・UNIQUE(category,name)・cascade・sort_key 採番) | 9+ 箇所 / 5 file | partial | 中 | **single 制約は card との cross-aggregate invariant**(§4 発見 #1)— bounded context 設計が本丸 |
| ★ | **Exam** | 4(card_count 整合・status 導出・stale timeout・cascade) | 2-3 箇所(集約度は高い) | なし | 高 | status が source_document 外部参照 = 境界が曖昧。card.create が exams.card_count±1 する cross-aggregate 不変条件が apply 関数に埋没(apply-card-mutation.ts:113,176) |
| — | Quota(ai_usage) | 4 | 2 file(plan-limits.ts / ai-usage-mcq.ts) | なし | 低 | 独立 aggregate でなく Plan/User の subdomain |

**value object 候補(primitive obsession)**: `plan`('free'|'standard'|'pro' リテラル)/ rank(number)/ SubscriptionStatus(10→3 値圧縮)/ sort_key(string|null・lexicographic)/ cursor(ISO string)。

---

## 4. Fact-finding ②: 書込経路とルール執行点(+ 発見事項)

### 書込経路の全景(22 経路・詳細表は調査 raw)

- **client**: `runOptimistic{Mutation,Create,Update}`(lib/sync/optimistic-mutation.ts)に集約済(直 Dexie tx の漏れなし・P3 の成果)。tag-crud 12 関数 / card 系 handler が consumer。
- **server**: entity-mutations/bulk(registry dispatch・9 entity_type×op)/ review-events/bulk(processSession)/ webhooks 2 本 / upload 3 tx / server actions(exam create/delete・settings・upgrade・contact)。
- **server 防御の深さ**: 所有権(owner-scoped WHERE)と型(Zod)と冪等(mutation_id/event_id)は**堅牢**。card の correct_answer_ids は server 再生成で client 改竄耐性あり(apply-card-mutation.ts:81-83)。
- **repository seam**: apply 関数群は `DbExecutor` 型(tx/db 両対応)で事実上の repository 前段。ただし app/ 内に Drizzle 直叩きが **19 箇所**(upload 4 / exams 2 / settings 3 / upgrade 2 / ほか)。

### ⚠ 発見事項(完全 DDD と独立に価値がある・**要裏取り**)

> **裏取り完了(2026-07-08)**: 4 件とも `docs/audit/2026-07-08-server-invariant-verification.md` で判定確定 — ① single 制約 = **REAL**(fix M・独立 fix 可)② session ガード = **部分的**(遅延 flush が正当ケースと同経路・仕様判断が先 = F2 同梱が自然)③ selected_answer_ids = **REAL だが既知の意図的 deferral**(2026-06-12 監査 §8 P2・存在検証まで独立 fix 可)④ = **部分的**(大半 LOW・upgrade changePlan/cancelDowngrade のみ Stripe⇄DB 整合窓 = F1 同梱が自然)。共通: 認証・所有権は全件無傷、他ユーザー/課金への波及ゼロ。以下は裏取り前の原文。

fact-finding 中に見つかった「server 側でドメイン不変条件が enforce されていない可能性」。いずれも Explore の推測を含むため**着手前に個別裏取りが必須**。裏取りの結果 real なら、完全 DDD を待たず個別 fix の価値がある:

1. **single カテゴリ制約の server 検証欠落(疑い)**: select_type='single' の「1 card に同カテゴリ最大 1 option」は client(build-next-tag-set.ts:21-47 / tag-crud.ts:445-455)のみで enforce し、server の apply(card-field-handlers の tag_option_ids handler)は whole-set replace を無検証で受ける可能性。→ 改竄 client が single カテゴリに複数 option を付けられるかも。
2. **session status 遷移ガード不在(疑い)**: 'completed' 後の answer_event append を拒む制約が DB にも ingest にも見当たらない(event_id 冪等はあるが session 状態は見ていない)。
3. **selected_answer_ids ⇄ options の整合検証なし(確認済に近い)**: review-events/bulk は selected_answer_ids の形式のみ検証、カードの実在 option との整合は client 信任(is_correct の導出も payload 信任)。
4. **直書き server action の tx/owner 検証のばらつき(疑い)**: settings/upgrade/contact は直 db.insert/update(tx なし)。owner check の網羅は要確認。

---

## 5. 完全 DDD の目標形(素案 — spec で確定させる)

### 戦術パターンの適用方針(推奨)

- **aggregate**: Subscription → Session → Card/Tag の順(§3 優先度)。Exam は SourceDocument との境界再設計とセットで後回し。
- **value object**: Plan / Rank / SubscriptionStatus / SortKey から(classifyChange 等の pure 関数を VO に内包)。
- **repository**: **server 側に限定して導入**(apply 関数群 + lib/db を interface 化)。client 側は N-5 の理由が今も有効(mirror+outbox+flush は persistence でなく application transaction)なので、**client は「aggregate 純粋関数で不変条件を計算 → 既存 runOptimistic* で書く」形を維持**する。教科書完全準拠より local-first の現実を優先する、が現時点の推奨(spec で OT 判断)。
- **domain event**: PlanChanged / SubscriptionReleased / UserDeleted / CardCreated / ReviewCompleted 等を TypeScript 型として明示。event sourcing への全面移行はしない(answer_events は既に event log であり、他は state-based を維持)。
- **共有 invariant module**: client/server 二重実装(deriveCorrectAnswerIds / single 制約 / 正規化)は「同じ pure 関数を両側から import」に単一化。local-first ゆえ**検証の実行が 2 回になるのは不可避**だが、**定義は 1 つ**にする。
- **bounded context**: audit(2026-07-05)§5.1 の context 分割案(learning / content / billing / identity)を出発点に spec で確定。

### フェーズ骨子(提案・plan ではない)

- **F0**: brainstorming → spec。D-1/N-5 の解除範囲・bounded context・「どこまで教科書に寄せるか」を OT 確定。§4 発見 4 件の裏取りと fix の先行/同梱判断。
- **F1**: Subscription aggregate + VO(Plan/Rank/Status)+ state machine 化(server-only・二重実装なし・最高リターン)。
- **F2**: Session aggregate(ingest-review-events からの持ち替え)+ status 遷移ガード。
- **F3**: server 側 invariant 強化(発見 #1/#3 — **挙動変更を含むため凍結契約 D-2 との関係を spec で整理**。「今まで通っていた不正 payload が failed になる」のは契約変更か bug fix かの判断)。
- **F4**: Card/Tag aggregate + 共有 invariant module(client/server 単一定義化)。
- **F5**(任意): domain event 明示化 / Exam↔SourceDocument 境界再設計 / モノレポ package 化(`packages/domain` パイロット)との合流。

### リスク・原則(P0〜P4 から継承)

- 挙動不変を原則とし、挙動変更(F3)は明示的に切り出して契約影響を評価する。P0 golden 77 + 既存 test 3004 が回帰の正。
- over-engineering への警戒: CLAUDE.md 簡潔性規律(YAGNI / rule of three)は完全 DDD でも有効。「教科書に書いてあるから」でなく「不変条件が実在するから」導入する。
- 各フェーズは sprint フロー(brainstorming → spec → plan → subagent-driven + canonical/Codex review)に載せる。

---

## 6. 次のアクション

1. OT が着手を指示したら: **brainstorming から正規に開始**(本 doc §1 の意図 + §3-4 の fact-finding が入力)。着手時 HEAD で §3-4 の file:line を再スキャン。
2. spec の主判断点(先取り): ① D-1/N-5 解除の範囲 ② bounded context 確定 ③ §4 発見 4 件の裏取り結果と扱い(先行 fix / F3 同梱 / 見送り)④ client 側の形(repository なし維持 or 部分導入)⑤ F1 の scope(Subscription のみで 1 sprint)。
3. 関連: モノレポ化(`packages/domain` パイロット)は独立の選択肢として保留中(2026-07-08 議論)。完全 DDD の層が package 境界の下敷きになるため、F4 以降で合流を検討。

## 参照

- SSoT(P0〜P4): `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(D-1〜D-6 / N-1〜N-5 / 進捗・完了記録)
- audit(凍結): `docs/audit/2026-07-05-ddd-refactor-investigation.md`(§5.1 bounded context 候補 / §5.3 目標依存方向)
- P0 baseline: `docs/audit/2026-07-06-p0-contract-baseline.md`(§B 凍結契約 inventory — F3 の契約判断で参照)
- 本 fact-finding の raw: Explore 2 体の出力(aggregate 候補・不変条件 / 書込経路 22 本の全列挙表)は本 doc に要約済み。詳細が必要なら着手時に再調査が正(file:line の鮮度優先)。
