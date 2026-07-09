# F2: Session aggregate — 完了記録(SDD 全 7 task 完走)

- 日付: 2026-07-09 / branch `develop` / 完走 range `508c5e0..4384c93`(code 5 commit + docs/codex 4 + M4 fix 1)
- spec `docs/superpowers/specs/2026-07-09-f2-session-aggregate-design.md`(fc052e0)/ plan 同名(508c5e0)。fact-finding `docs/audit/2026-07-09-f2-session-factfinding.md`(10f6b5a)。
- 実装 = subagent-driven-development(task 単位 fresh Opus subagent・実装 subagent は commit せず controller が review 後 commit)。ledger = `.superpowers/sdd/progress.md`(F2 section)。

## 成果(何をしたか)

Session(StudySession + AnswerEvents)の 7 不変条件を pure domain 層 + 意図別 repository に集約(挙動不変)し、②status 後退遷移ガード(terminal 凍結)を隔離 commit で追加。**F1 との構造差 = 2 書込点(route Phase 0 / processSession)を跨ぐ aggregate seam** を、規則を単一 domain module(canApplyStatusWrite / admitEvents)に同居させて閉じた。

- `lib/reviews/domain/session-values.ts`(SessionStatus + canApplyStatusWrite)/ `session-aggregate.ts`(buildCardOptionIndex / admitEvents / planReplay / replaySession / aggregateStudyDays / deriveRating)= runtime import ゼロ(pure sibling replayCard/todayInJst/RatingInt 型のみ)。
- `lib/reviews/session-repository.ts`(意図別 method・SQL verbatim・logger 呼ばない)/ processSession = orchestrator に縮退。
- route Phase 0 = `upsertSessionGuarded` 経由。
- eslint `lib/reviews/domain/**` 純度 enforce(Block A''・F1 Block A' 踏襲)。
- W = ②ガード: ON CONFLICT setWhere 述語 `userId AND (既存.status='active' OR 既存.status=excluded.status)` + `.returning()` で applied 実計算 + route が applied=false で `logger.warn(session_upsert_blocked)`。clamp は wire 非表出(200 維持・events 通常処理)。

## commit(G → R → W → M4)

| task | commit | tag |
|---|---|---|
| Task1 G golden+fake | `8c697cb` | [reviewed] |
| Task2 R1 domain 抽出 | `1b7f72c` | [reviewed] |
| Task3 R2 repository+ingest(risk) | `f87f5be`(+codex `6116ca2`) | [reviewed] |
| Task4 R3 route Phase0(risk) | `f216e93`(+codex `4298c40`) | [reviewed] |
| Task5 R4 domain lint | `c6b6ee0` | [reviewed] |
| **Task6 W ②status ガード(risk・挙動変更)** | **`c55befd`(+codex `61beed7`)** | **TAG 無し**(下記) |
| Task7 M4 comment fix | `4384c93` | [no-review] |

## review 結果

- 各 task = canonical(SDD task-reviewer・opus・template 無改変)/ risk task(R2/R3/W)= + Codex(codex-review.sh・gpt-5.5・detector PASS)。全 task Crit0/Imp0。
- **whole-branch review**(opus・508c5e0..61beed7)= **Ready to merge: Yes / Crit0 Imp0**。独立検証: R 挙動不変(snapshot churn ゼロ + golden 弱体化ゼロ・eventsToApply 再順序は order-insensitive aggregation ゆえ観測不変)/ W 予述語 10 行 canApplyStatusWrite 一致・clamp が events/wire を阻害しない(processSession は永続 session 行非依存)/ domain 純度実体 / owner-scope 全通 / P0(deriveRating・rating列なし・JST)不変 / wire D-2 不変 / **client 側 diff ゼロ**。
- Minor triage: **M4(fake header comment stale)= 修正済**(`4384c93`)。M1(G4 userId decorative)/ M3(zod deny message spec §3 引用)/ M5(下記 smoke)= record-only。

## 最終 gate(全 exit 0)

whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / full `pnpm test`(205 files・3144 passed)/ `pnpm build`。snapshot churn ゼロ(`git diff 508c5e0..HEAD -- '*.snap'` 空)。client diff ゼロ(lib/sync / lib/client-db.ts / app/(app)/app/study / review-flush-trigger.tsx 不触)。

## W の [reviewed] 扱い(恒久規律)★重要

W(`c55befd`)は **TAG 無し commit**。データ保全経路の重要 fix + `.returning()` の実 driver(postgres-js + Supabase pooler)挙動が unit 対象外(M5)= **stg smoke が最終防衛線**。push→smoke 順で amend 窓が構造的に閉じるため、**本 session doc が W の [reviewed] 正記録**(commit tag は追わない・push 済 force-push しない)。canonical + Codex + whole-branch review は全 pass 済(上記)= smoke 後に本 doc で [reviewed] 相当を確定する。

## stg smoke 項目(push 後・OT 指示で CC が DevTools/fetch 実走・参照事実 C)

1. 通常演習 1 周 → session status='completed'(非退行)。
2. **completed 済み session へ stale `active` payload 再送(fetch 再現)→ 実 DB で status='completed' 維持 + events 通常処理**(②ガードの実 driver 確認 = M5)。
3. completed 済みへ `abandoned` payload → 実 DB status='completed' 維持(terminal 凍結)。
4. 同一 payload 再送の冪等(status 不変)。
- 拒否残り 2 行(abandoned→active / abandoned→completed)は述語同一構造ゆえ机上照合(参照事実 A・10/10 一致確認済)で足りる。

## stg smoke 結果(2026-07-09・全 4 項目 PASS)★[reviewed] 確定

- 実行: Playwright MCP(stg.recallmint.nekotest.net・Clerk test 認証済 persistent session)。DB read-back = `.env.local` DATABASE_URL(= **stg DB**・seed-perf-exam.ts:7-9 が根拠)へ read-only SELECT。session_id = `5e3a74c6-39a9-4ac2-b6fb-3787fd7a59b9`(test 用に fetch で作成)。
- 反映確認: `/app` 200・**age=0**(stale cache でない)・hnd1・`GET /api/review-events/bulk` → **405**(POST-only route 実 deploy)。**F2 code live の決定的証拠 = item 2 のガード結果**(pre-F2 なら active に巻き戻る)。

| # | 項目 | POST 結果 | DB 実測(実 driver postgres-js/Supabase pooler)| 判定 |
|---|---|---|---|---|
| 1 | 通常 completed session + 適用 event | 200 `{ok:true,failed:[]}` | status=**completed** / completed_at 有 / answer_events n=**1** | **PASS** |
| 2 | **stale `active` 再送(後退・核心)**+ 別 card event | 200 `{ok:true,failed:[]}` | status=**completed 維持**(active に戻らず)/ completed_at 保持 / answer_events n=**1→2**(event 適用=遅延 flush 非弾き)/ n_card_ids=**1 維持**(I-1・2要素 payload でも非上書き) | **PASS** |
| 3 | completed→`abandoned`(後退) | 200 `{ok:true,failed:[]}` | status=**completed 維持** | **PASS** |
| 4 | 冪等 completed→completed(同 completed_at) | 200 `{ok:true,failed:[]}` | status=completed / completed_at 不変 / n=2 不変 | **PASS** |

- **核心実証**: ②ガードは status 後退(completed→active / completed→abandoned)だけ弾き、response は 200 不変・同 payload の event は通常 INSERT(wire 非表出 clamp + 遅延 flush 非弾き)。**M5 close**: `.returning()` の実 driver 0-row-on-blocked clamp が実 DB で作動確認(unit fake だけでなく)。対応表 #6(completed→active)/#7(completed→abandoned)/#5(冪等)/#1(通常)を実機確認。残り #9/#10(abandoned 起点)は述語同型ゆえ机上(10/10 一致済)。
- console: app 由来 error **0**(dashboard 初期ロード 0 errors)。error 2 件は smoke 用の意図的プローブ(405 GET liveness / 400 = 最初の malformed `completed_at:null` payload・wire validation が null を正しく弾いた副次確認)。500 系ゼロ。
- logger.warn(`review_events.session_upsert_blocked`)= server 側(Vercel log)ゆえ browser 非観測。ただし applied=false 分岐は DB 証拠(3 後退全 block)で走行確定。Vercel error ログの最終確認は OT 側(500 未観測)。
- test data: stg test account に session 1 + answer_events 2 + card A/B の FSRS 前進 + study_days/reviews 増分が残存(smoke 副作用・削除経路なし・test account ゆえ許容。要削除なら OT 判断)。

**→ 恒久規律により本 session doc が W(`c55befd`)の [reviewed] 正記録。canonical + Codex + whole-branch review 全 pass 済 + stg smoke 4/4 PASS(実 DB・実 driver)= [reviewed] 相当 確定。** commit tag は追わない(push 済 force-push しない)。

## 次アクション

1. ~~OT push~~ 済(origin = 527ca63 相当)。~~stg smoke~~ 済(上記 4/4 PASS・W [reviewed] 相当確定)。
2. **prod 反映判断 = OT**(smoke 全 PASS・回帰なし・挙動変更は②status 後退拒否のみ)。CC は prod 判断せず。
3. (任意)stg test data cleanup(session 5e3a74c6… + answer_events 2 + card A/B FSRS 前進)= OT 判断。
4. 完全 DDD 次フェーズ = F3(③b is_correct 再計算・deriveRating 凍結契約との関係整理)は別 sprint(OT 判断)。

## 参照

- ledger: `.superpowers/sdd/progress.md`(F2 section・各 task の review 詳細)
- Codex artifacts: `docs/codex/2026-07-09-f2-r2-repository-ingest.md` / `-f2-r3-route-phase0.md` / `-f2-w-status-regression-guard.md`
- 意図 doc: `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` §5(F2 = Session aggregate)
