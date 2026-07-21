# Codex plan cross-check — rls-p3-wave2 (2026-07-21)

- **作成日**: 2026-07-21
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **RLS の安全性は policy だけでなく実行ロールに依存する。** `recallmint_app` が表 owner、superuser、または `BYPASSRLS` を持つと通常の RLS は迂回される。iso/stg で `current_user` だけでなく、owner/BYPASSRLS 属性と実際に RLS が強制されることを確認する必要がある。`FORCE ROW LEVEL SECURITY` を採らない既存方針なら、その前提を明文化すべき。

- **context の寿命と接続プール境界が重要。** `set_config(..., true)` は transaction-local なので、全クエリが同一 transaction/connection 上にあること、callback 外へ `tx` や遅延クエリを逃がさないことが安全条件になる。rollback、例外、ネストした transaction 時の context 消失・残留も確認対象。

- **「全 raw site」の完全性を担保する再監査が必要。** 列挙された経路だけでなく、別名 import、repository/helper 経由、cron/job/webhook、テスト専用経路、SQL直書き、将来追加された経路を policy flip 前に機械的に再検索する必要がある。単発の Step 0 grep は実装中の差分や並行変更を捕捉しない。

- **認証済み user ID と SQL 上の対象 user ID の一致が安全条件。** `withTenantTx` に渡す ID が Clerk/auth由来なのか、route parameter・payload・署名イベント由来なのかを経路ごとに区別する必要がある。RLS は「設定された tenant」を信頼するため、誤った context 設定自体は防げない。

- **5表すべてについて schema 前提を確認すべき。** `user_id` の型、NULL可否、既存孤児行、default、trigger、FK cascade、view、function、partition の有無が policy 式と整合する必要がある。NULL行は全 tenant から不可視になり、運用上「消えた行」になり得る。

- **read隔離、既存行への更新、挿入防御は別々の性質を持つ。**  
  `B` 行への `UPDATE/DELETE` が0件になることだけでは `WITH CHECK` を検証できない。最低でも次を区別すべき。

  - predicateなし read で他 tenant 行が不可視
  - 他 tenant 既存行への update/delete が0件
  - `user_id=B` の insert/upsert が `42501`
  - A行をBへ移す updateが拒否
  - context未設定時の read/write が fail-closed

- **UPSERT は固有の検証が必要。** `user_settings` や usage 系では、他 tenant の一意キーとの conflict が、情報漏えい、予期しない update、または policy violationのどれになるかを実DBで確認すべき。単純 insert/update のテストでは代替できない。

- **エラー意味論の変化を評価する必要がある。** RLS/context導入後は、従来のDB例外に加えて context設定失敗、`P0RLS`、`42501` が発生する。既存の `503/400` 分類や best-effort の空値化が、障害を認可上の「データなし」に見せないか確認が必要。

- **best-effort read は fail-openではないが、障害隠蔽リスクがある。** `source_documents` の空Map/false返却は、処理中判定や再処理判断を誤らせる可能性がある。少なくともログ、メトリクス、アラートで「本当に空」と「RLS/context障害」を区別できる必要がある。

- **`finalizeAsset` の外部I/O境界は、接続保持だけでなく整合性の問題。** read tx → `headObject` → write tx に分ける場合、途中で予約状態、所有者、object metadataが変わり得る。atomic updateの `status='reserved'` は二重finalizeを抑止するが、最初に検証したDB行と更新対象が同一条件であること、サイズ・key・etag等をwrite側で再検証することまでは自動的に保証しない。

- **外部オブジェクトの tenant binding も確認対象。** DBのassets行だけでなく、R2 keyが別tenantのobjectを指せないこと、presigned URL生成がRLSで取得した行に限定されること、finalize時にclient指定値を信用しすぎないことが必要。

- **study_sessions の別tx維持には明確な意味がある。** 単純wrapは既存rollback範囲を保つ一方、Phase 0成功後にPhase 1+2が失敗する部分成功も維持する。この状態がretry/idempotency設計と整合するかを確認すべき。

- **policy適用の原子性・展開順序が必要。** 「全経路context済 → policy flip」は正しいが、コードdeployとSQL適用の間には必ず時間差がある。旧コード＋RLS-on、新コード＋RLS-off、複数instance混在の各状態をどう許容するかが必要。rollbackでもコードとpolicyの戻し順を定義すべき。

- **disableがpolicyを残す運用にはdrift検知が必要。** disable中に古いpolicy定義が残るため、再enable前に式・対象role・tableが期待値どおりか確認しないと、単なる `ENABLE` で古い定義が復活する可能性がある。

- **partial-RLSの主張範囲を限定すべき。** `ai_usage(off global) × ai_usage_users(on tenant)` は「同一tx内でRLS有無が混在しても、on側policyが働く」証明にはなる。一方、tenant-owned表が一時的にoffである移行期間の安全性や、off側のtenant隔離は証明しない。

- **恒久off global表への書込み権限自体を評価すべき。** tenant contextを設定していても `ai_usage` はRLS対象外なので、app roleが任意日付・任意値を書ける設計なら、RLS混在とは別の権限制御リスクがある。テストで「off側は自由に書ける」と固定化する前に、それが意図した権限であることを確認すべき。

- **iso testの独立性・決定性が必要。** global `ai_usage` は共用かつtruncate対象外なので、固定日付、並列実行、失敗後cleanup、他testとの競合を考慮する必要がある。日付を変えるだけでなく、同一DBを共有するworker間の衝突回避が必要。

- **stg実証では negative test も必要。** 正常系smokeだけでなく、contextなし、tenant B対象、偽造ID、旧instance残存時の拒否、disable/re-enable後のpolicy定義一致まで確認したい。

## plan ドラフトへの抜け・未考慮指摘

- Task 7の「配線経路」定義が不十分。`upsertSessionGuarded` を `asTenant` で直接呼ぶテストは、routeに `withTenantTx` が追加されたことを証明しない。`getCurrentMonthOcrPages` も同様で、helper直呼びではpage callerの配線を検証できない。要件の「配線経路」を満たすには、可能な限りroute/action/page境界、またはcontext供給を観測できるテストが必要。

- 逆に、Next page/actionを実PG isoから直接実行するとauth、cache、redirect、R2などの境界が絡む。どこをintegrationで、どこを既存unit/contract testで保証するかという対応表がない。

- Task 7は `USING` 側の0行更新を中心にしており、`WITH CHECK` の独立検証が明示されていない。他tenant insert、tenant移動update、UPSERT conflictを追加すべき。

- context未設定テストがreadのみかwriteも含むか不明。5表すべてについて少なくとも代表read/writeをfail-closedで確認し、対象操作がない表は理由を記載すべき。

- policy適用後にapp roleが本当にRLS対象か確認するassertionがない。`current_user`、table owner、`rolbypassrls`、`relrowsecurity`、policy role/qual/with_checkを検証するメタデータ assertionが必要。

- policy SQLの原子的適用が明示されていない。「5表一括ファイル」と「per-table不可分」は同義ではない。途中失敗時にどの状態が残るか、明示的transactionを使うか、migration runnerの暗黙transactionを根拠にするかが必要。

- `lock_timeout='5s'` 時の失敗運用がない。1表でもlock timeoutになった場合の再実行、状態確認、stgでの接続・長時間txの調査手順が必要。

- SQL識別子、policy名、schema qualificationの具体的確認がない。`public.<table>` を一貫して使うか、`search_path` 依存を許すかを既存Wave 1と照合すべき。

- `finalizeAsset` の2tx分割で、write txが再確認すべき条件が列挙されていない。`status` だけで十分か、owner、asset ID、object key、期待metadata、更新行数0時の返却意味を明文化すべき。

- finalizeの競合テストがない。並行finalize、予約取消、行削除、R2確認後の状態変更について、少なくとも更新行数0となる代表ケースが必要。

- best-effort readでcontext設定失敗が既存catchに吸収されることを「挙動不変」としているが、監視可能性が計画にない。ログ内容にtenant情報を安全に含めるか、障害カウンタをどう観測するかが抜けている。

- study/smartでtxを分ける判断は最小変更だが、同一request内のsettingsとcardsが別snapshotになる点を明記していない。従来も別queryなので原則不変だが、RLS配線後もその非原子性を意図的に維持するとの記録があるとよい。

- `global-setup` にenableを足すだけでは、disable SQLの正当性を自動検証しない。disable→状態確認→再enableのiso test、またはSQL構造検査がない。

- red検証方法として「global-setup行を一時revert」「対象表disable」は作業者依存で再現性が低く、未commit変更の取り違えも起こりやすい。どのテストがどの理由でfailしたか、off状態でも配線正常系は通ることとの区別が必要。

- partial testのcleanupが `beforeEach` の対象日削除だけで、テスト失敗後や並列workerの干渉を十分扱わない。固有日付を使えるのか、serial suiteにするのか、owner cleanupを`afterEach`にも置くのかが必要。

- `incrementAiUsage(A)` の実経路試験だけでは、context設定がない場合にon側で拒否されることや、off側だけがcommitしてしまわないことを証明しない。単一tx rollbackの確認も価値がある。

- mixed txでon側違反を意図的に発生させ、off側更新もrollbackされることを確認する観点がない。「混在しても成立」だけでなく「on側拒否時にtx全体が原子的に失敗」も重要。

- `ai_usage` を「off自由」とするassertionが、本来の業務API制約を迂回して直接SQLで任意変更できる状態を仕様化する危険がある。証明したいのはRLS機構の混在であり、global表への過剰権限ではない。

- fixtureの19表seed済という事実に依存しているが、各Wave 2行の必須列、status、一意制約が実経路試験の前提を満たすかの確認がない。特にassets/source_documentsは単なるdecoyと業務的に有効なfixtureを分ける必要がある。

- 完了gateにpolicy SQLの静的監査・期待policy数確認が明示されていない。`audit` が何を保証するか不明なので、5 policyの `USING`/`WITH CHECK`/role一致を別途pinすべき。

- prod flip禁止と「versioned policy file追加」の関係が未整理。deploy pipelineが `db/policies` を自動適用しないこと、誤ってprodに適用されないことを確認するrelease controlが必要。

- stg rollback確認の「policy 5行 / relrowsecurity 0行」だけではpolicy内容の正しさを確認できない。再enable後のqual、with_check、roles、commandも確認すべき。

- stg smokeにtenant間negative検証がない。正常動作と `P0RLS/42501/5xx=0` だけでは、RLSが無効でも成功するため隔離証明にならない。

- COVERAGE.mdに、経路だけでなく「保証層」を記録する観点がない。caller配線、policy単独防御、実業務経路、stg smokeのどれが何を保証するかを分けるべき。

## リスク / 対立しうる設計判断

- **finalizeAsset: 1tx vs 2tx**
  
  1txはDB snapshotと行lockを維持しやすい一方、R2 I/O中に接続・transactionを保持する。2txは運用上健全だが競合窓が広がる。現状情報では2txが妥当。ただしwrite側で期待状態と、必要ならobject key/metadataを再検証し、更新0件を明確な競合結果として扱うことが条件。

- **partial-RLSの相手をai_usageへ変更**
  
  RLS機構の混在を実在経路で証明する目的には妥当。ただし「tenant表を段階的にon化する移行安全性」の完全な代替ではない。テスト名・COVERAGEで「global off × tenant onのtransaction compatibility」と主張範囲を限定すべき。

- **study_sessions Phase 0の単純wrap vs processSessionへの合流**
  
  単純wrapが要件の「Wave 1同型」「新規設計しない」に整合し、rollback意味論も保存する。合流は原子性を高める可能性があるが、失敗範囲、lock時間、retry/idempotencyを変えるため今回のscope外とするのが妥当。

- **実経路test vs policy単体test**
  
  実経路testは配線漏れを検出するが、auth・外部I/O・framework依存で不安定になりやすい。policy単体testは隔離を精密に検証できるがcaller配線を保証しない。両方必要で、同じテストを「双方の証明」とみなさないことが重要。

- **best-effort維持 vs fail-fast**
  
  挙動不変のため今回はbest-effort維持が自然。ただしRLS導入障害を「データなし」に変換するリスクが増すため、監視強化を同時条件にするか、後続課題として明示すべき。

- **RLS disable時にpolicy残置 vs drop**
  
  要件どおり残置すればrollback/re-enableは速い。一方で古いpolicy再活性化とdriftのリスクがある。再enable前の定義検証を運用条件にすべき。

- **per-table不可分 vs 5表一括flip**
  
  一括flipは単純だが、1表の問題が全Waveに波及する。per-table不可分を厳密に求めるなら、各表について「コード互換deploy完了→確認→policy enable」を管理する必要がある。今回の一括SQLを採るなら、全配線が旧/新policy双方で動く後方互換期間と、SQL全体の原子性が前提になる。