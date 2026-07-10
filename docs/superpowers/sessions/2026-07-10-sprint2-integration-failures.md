# Sprint 2: integration_failures 統一台帳 + Discord dual-write — session log

- 日付: 2026-07-10 / branch `develop`
- spec: `docs/superpowers/specs/2026-07-10-sprint2-integration-failures-design.md`(凍結)
- plan: `docs/superpowers/plans/2026-07-10-sprint2-integration-failures.md`
- 方式: subagent-driven-development(fresh Opus implementer per task・実装は commit せず controller が canonical+Codex 通過後に commit)

## 結論

課金・外部連携の失敗を Discord notify に加えて DB table `integration_failures` に additive に記録する dual-write 基盤を実装完了。回収ロジック・cron は out of scope(将来 sprint)。**実装 3 task 全 [reviewed]・whole-branch 最終 review = Ready to merge(Crit0/Imp0)・full test 3196 green・whole-repo lint exit0 確認済**。

**push + migration 0022 適用 + stg smoke = OT**(未実施)。

## commit 一覧

| task | 内容 | feat commit | codex docs |
| ---- | ---- | ----------- | ---------- |
| 1 | schema `integration_failures` + catalog(7 entry)+ `recordIntegrationFailure` helper(additive・未配線) | `f8a5db0` [reviewed] | `73d342a` |
| 2 | 配線 site1-3(stripe autorelease / gate mismatch / clerk sync) | `2e25f2f` [reviewed] | `c432865` |
| 3 | 配線 site4(削除失敗)+ `deletion_failures` 全廃 + migration 0022 生成 | `aeab72f` [reviewed] | `5451141` |

sprint 開始 base = `5d92b0d`。

## review 記録

- 各 task: canonical `superpowers:requesting-code-review`(general-purpose Opus・template 改変なし・read-only 未 commit diff)+ Codex `codex-review.sh`。全 task 未解決 Critical0 / Important0 で収束(1 周)。
- Task 1 の Codex Important 1(P2 = migration 未生成)は plan 意図の Task 3 集約(deploy 前に CREATE+DROP 1 本生成)で解決済み・self-run 吸収。
- 最終 whole-branch review(Opus・`5d92b0d..HEAD`)= Ready to merge・Crit0/Imp0/Minor2(非 actionable)。6 invariant を pre-sprint 状態と照合: dual-write byte 不変(全 4 site)/ helper 契約統一 + webhook-200 不変 / schema↔migration↔snapshot 一致 / deletion_failures 完全除去 + 削除挙動保存 / scope 規律(Sprint 1 不干渉・dormant 列未使用・env/secret なし)/ clerk_sync workflow=null 意図判断。
- Minor roll-up(全 review・非 blocking・記録のみ): (1) helper test(d)の logger payload key/err 未 assert(2)非 Error throw 分岐 String(err)未 test(3)stripe route.test の file-wide beforeEach default(4)migration SQL 末尾改行なし(drizzle 生成物)(5)recordFailure の userId/clerkId が ref 列 + context 両持ち(byte 不変ゆえ意図的)。

## site 3 workflow=null 可観測性(spec §6 の意図的判断・記録必須項目)

`syncClerkPublicMetadata` の全 callsite を実コードで trace した結果:

- **Stripe plan sync**(`handle-stripe-event.ts` / `project-subscription.ts`)= `context.keys` に `['plan']`
- **user.created 初期 sync**(`handle-clerk-event.ts`)= `['dbUserId','plan']`
- **backfill script** = `['dbUserId','plan']`(初期 sync と同一 keys)

→ `context.keys` で「plan sync」と「初期 sync/backfill」は分離できるが、**初期 sync と backfill は同一 keys ゆえ厳密判別不能**。

**判断 = 「厳密判別は不能を許容」**。workflow=null を維持し、workflow override 引数は入れない(自由文字列で 4 軸を渡さない原則)。将来厳密判別が必要なら呼び出し元別 catalog entry で割る。この判断は `lib/integration-failures.ts` の `clerk_sync` catalog entry 近傍コメントにも記録。

## 運用メモ

- **catalog key は DB 非保存**(DB に入るのは 4 軸 tuple のみ)。手動 SQL / runbook は 4 軸(service/operation/workflow/failure_code)で扱う。7 entry の tuple は全て相異なるため一意に origin へ写像可(helper test (g) が一意性を pin)。
- **手動回収**は spec §10 の runbook 参照(未解決一覧 / resolved_at + resolution_note 同時 UPDATE)。`retry_count` / `next_retry_at` は dormant(cron 導入まで手動でも触らない)。

## 既知の未台帳化 failure(将来 catalog entry 追加で additive に取込・今 sprint は中核に絞る round 1 確定判断ゆえ対象外)

- S4(A-3 drift: Stripe 成功後 DB write 失敗)/ S6(unlinked customer)= fact-finding で回収要否中以上・現状 Discord のみ
- S5(subscription unresolved)/ S7(missing/unknown price)/ S3(autorelease current_phase null)/ C2(user.deleted 未同期)= 一過性 or 稀

## OT 引き継ぎ(stop checkpoint)

1. **push**(develop)= OT。
2. **migration 0022_tan_penance.sql 適用**(`pnpm db:migrate` = CREATE integration_failures + DROP deletion_failures CASCADE)= OT 運用(spec §9)。zero-users ゆえ DROP 無条件安全。
3. **stg smoke**(push + migration 適用後・spec §8 の代替方針):
   - ① migration 適用確認 = `integration_failures` table 存在(`deletion_failures` 消滅)
   - ② 正常経路 regression = subscription 更新フロー / user 削除フローが従来どおり動く(失敗経路の実発火は誘発困難ゆえ unit test を正とする)
   - 失敗経路の台帳書込は unit test 3196 green が担保(実 API 誘発しない)。
4. smoke pass を本 session doc に追記して **[reviewed] の正記録**とする(push 済 commit の tag は追わない = CLAUDE.md「重要 Fix の裏取り」既存規律)。
