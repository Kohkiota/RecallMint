# F1: Subscription aggregate — 完了記録(完全 DDD phase 1)

- 日付: 2026-07-09 / branch `develop`
- spec: `docs/superpowers/specs/2026-07-08-f1-subscription-aggregate-design.md`(2b92705)/ plan: `docs/superpowers/plans/2026-07-08-f1-subscription-aggregate.md`(7aba4b3)/ fact-finding: `docs/audit/2026-07-08-f1-subscription-factfinding.md`
- 実装レジーム: SDD(fresh Opus implementer per task・実装 subagent は commit せず controller が review 後 commit)/ canonical = SDD task-reviewer(sonnet)/ risk task(4a/4b/7)+ Codex 独立 review。

## 成果

subscription slice(plan 6 列 + 予約 3 列)を **aggregate + VO 2 + 意図別 repository + 射影 use-case** に集約(server-only・client mirror 非該当)。整合窓 W-A2(upgrade 射影窓)を eager projection で解消。**F2/F4 が踏襲する「型の基準回」**。

### 構造(新設)
- `lib/stripe/domain/subscription-values.ts`(VO・runtime import ゼロ): normalizeSubStatus / derivePlanFromStripe(price resolver 注入・anomaly 返却)/ ScheduledChange / isCancelScheduled / extractPriceId。
- `lib/stripe/domain/subscription-aggregate.ts`(純粋 aggregate): projectStripeSnapshot(Stripe obj 必須=逆流禁止の型保証)/ applyDeleted(currentPeriodEnd 非含)/ reserve・clearReservation(3 列一括=I-9 atomicity)/ canChangePlan(I-6)/ evaluateRelease(I-8 判定 4 値)。
- `lib/stripe/subscription-repository.ts`(infra): SubKey 別 owner-scope WHERE / 意図別 save 4(個別予約列 writer なし)/ RETURNING SaveResult{matched,clerkId,予約2列}。
- `lib/stripe/project-subscription.ts`(use-case): infra 呼出の唯一の新境界(anomaly 通知 → 射影 → saveProjection → RETURNING gate Clerk sync)。
- eslint flat config: `lib/stripe/domain/**` の runtime infra import 禁止(allowTypeImports・intra-domain 許可)。

## commit(8 本・7aba4b3..6fc1555)

| commit | phase | tag |
|---|---|---|
| `7cc7351` | G golden 先張り 7 本(characterization) | [reviewed] |
| `6db08a3` | R1 VO 抽出 | [reviewed] |
| `64958b3` | R2 aggregate/repository 新設(additive) | [reviewed] |
| `68737d9` | R3a 射影 use-case + webhook 配線(risk) | [reviewed] |
| `0904c3c` | R3b action 配線(risk) | [reviewed] |
| `f4fe99f` | R4 domain import 境界 lint | [reviewed] |
| `6fc1555` | **W eager projection(W-A2・挙動変更・決済 fix)** | **TAG無し** |
| (`05df0c5` = Task4b Codex md docs) | — | [no-review] |

## 挙動不変の客観証明 + W の隔離
- **R(G/R1/R2/R3a/R3b/R4)= 挙動不変**: whole-branch review が per-commit で確認 — snapshot 変更は G(`7cc7351`)の +16 行(新 golden 2)のみ。R/lint/W は `.snap` 変更ゼロ。golden 弱体化・更新ゼロ。
- **W = 唯一の挙動変更**(upgrade 枝のみ・A-3 型検知)。I-14(pending_update→旧 plan)保存。二重課金なし = Stripe 同 price update proration ゼロ(Context7 裏取り済・自己修復は保険)。

## 最終 gate(controller 実走・全 exit 0)
whole-repo lint --max-warnings=0 / typecheck / **full test 202 files 3083 passed** / build。snapshot working tree clean。

## whole-branch review(opus・7aba4b3..6fc1555)
**READY TO MERGE / Critical 0 / Important 0 / Minor 全 record-only**。独立検証: R 挙動不変(snapshot diff ゼロ)/ W A-3 fidelity(projection-in-try・非 masking inner notifyOps・rethrow・redirect try 外)/ projection-purity 型保証 / I-9 atomicity 型保証 / domain lint 実走 exit 0 / syncClerkPublicMetadata 非 throw ゆえ A-3 catch 誤帰属なし / Stripe 200/sig/idempotency 無改変 / owner-scope 全通 / A-4 row/clerkId 分離保存 / anomaly-before-DB-write 順序保存。

## OT 報告事項
1. **domain 純度の運用解釈**: spec §3 の「import type のみ」は、pure sibling(subscription-values)からの runtime import(normalizeSubStatus 等)を許容する解釈で運用(intent=infra 非依存は充足・Task3 で確定)。lint もこの境界を enforce(intra-domain 許可・infra 値 import 禁止)。
2. **W(`6fc1555`)は TAG無し**(決済 fix・挙動変更)。**OT stg 実機確認後に amend で [reviewed]**(A-3/A-4 と同運用)。

## stg smoke 申し送り(push 後・OT 指示で CC 実走)
- 正常 upgrade + **直後 DB 反映(= W-A2 の直接確認)**
- downgrade 予約 → 取消(release gate 非退行)
- 退会 flow 非退行(A-4 偽アラート不発生)
- **再 upgrade 再試行経路**(W-A2 自己修復・Stripe 同 price no-op の実確認)

## 次
OT 報告 → OT push → stg smoke(CC・DevTools MCP)→ **W に [reviewed] amend**(未 push amend or push 後 OT 指示)→ prod 判断は OT。CC は push・prod 判断せず。
