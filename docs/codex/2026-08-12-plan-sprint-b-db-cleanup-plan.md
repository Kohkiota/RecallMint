# Codex plan cross-check — sprint-b-db-cleanup-plan (2026-08-12)

- **作成日**: 2026-08-12
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- `code deploy → migrate` は無停止互換ではない。旧 schema の `mode` / `filename` / `file_size_bytes` が NOT NULL・default 無しなので、新 code の upload 書込みは migration まで必ず失敗する。これは単なる「リスク」ではなく、意図的な upload 停止期間である。停止対象、開始・終了、利用者への周知、失敗済み operation の回復方法を運用契約として明示する必要がある。

- migration 後は旧 code に rollback できない。DB backup はデータ復旧手段であって、短時間のアプリ rollback 手段ではない。migration 直前の go/no-go、migration 後障害時の forward-fix 方針、DB restore を選ぶ条件を区別すべき。

- drain が完了しない場合の扱いが必要。`processing` / `prepared` が恒久的に残るケースについて、原因確認、terminal 化・再実行・中断のどれを選ぶかが未定義。単にゼロ件を待つだけでは runbook が停止する可能性がある。

- 「Function 上限 900 秒」は現行設定と一致すること、queue・再試行・遅延実行・旧 deployment の保持時間まで覆うことを確認する必要がある。900 秒経過だけでは古い invocation が皆無とは限らない。

- migration 検証は空 DBだけでなく、明示的な0035状態のDBに、境界値・既存データ・実運用に近いデータを入れた状態から0036を適用する必要がある。全 migration を空から流す試験だけでは upgrade path を独立に保証しない。

- migration の原子性は実際の migrator 実装と PostgreSQL DDLに依存する。「file単位tx」を前提にするなら、それをテストまたは実装根拠で固定すべき。`lock_timeout` / `statement_timeout` による途中失敗後、schema が完全に0035のままであることも確認対象になる。

- FK変更は、直接 source document 削除、exam cascade、退会処理だけでなく、複数 cascade path が同時に作用する状態を検証すべき。削除結果だけでなく関連全表、監査・課金記録、再送時の応答も確認対象。

- `upload_operations` を source document と同時消滅させることで、操作台帳・冪等性情報が消える。現在直接削除経路がないことはDB不変条件ではない。将来の削除機能だけでなく、運用SQL、データ修復、retention処理からの削除も設計境界に含めるべき。

- CHECK追加前に、全27制約について既存書込み経路が許容値を生成することを確認する必要がある。正常値・違反値テストだけでなく、webhook、seed、fixture、管理SQL、failure/reconcile経路も対象になる。

- nullable enumのCHECKは NULLを許すだけで、課金三列の相関整合性を保証しない。例えば free plan と subscription/billing値の不整合を許容する。この非保証を明示しないと、CHECK導入後に課金整合性まで保証されたとの誤解を生む。

- CHECK集合一致テストで `pg_get_constraintdef` の文字列を解析する方式は、括弧、cast、列順、PostgreSQL版による表現差に弱い。堅牢な正規化方法、または許容値ごとの受理・拒否試験を主保証にする必要がある。

- iso の違反INSERTは、各テストの transaction rollbackまたはfixture再生成を保証しなければ後続テストを汚染する。FK cascadeや退会handler試験も同様に、並列実行時のユーザー・exam識別子分離が必要。

- index削除の正しさには二つの軸がある。

  - 現在対応queryがないこと。
  - 削除後、残存queryの性能が許容されること。

  `EXPLAIN` は小規模fixtureではseq scanを選びやすく、特定index使用の厳密assertは不安定。代表データ量・統計更新・実行計画の許容条件を定義すべきで、index名の完全一致だけを保証にするのは脆い。

- `entity_mutations` owner-scope化は、取得だけでなく全状態遷移の競合を考慮する必要がある。flush開始後に別flush、coalesce、stale隔離が並走した場合でも、選択済みID集合が別ownerや新規mutationを巻き込まないことを確認すべき。

- `mutation_id` だけで更新する安全性は「owner-scopeで選んだIDは一意」という前提に依存する。コードレビューだけでなく、別owner同一IDをDB上で作れない `&mutation_id` と、upgrade後に旧行が残らないことをテストで結び付ける必要がある。

- mirror行の `user_id` を認証主体とみなす設計は、端末内データ破損や切替競合を検出しない。防御を追加しない判断は可能だが、「構造的に起きない」ではなく、client誤送信防止がbest-effortでありserver認可が最終境界だと明記すべき。

- Dexie upgradeでは次も考慮対象になる。

  - hard-coded DB名を使うテストの並列干渉と確実なcleanup。
  - v10→v12だけでなく、新規DB作成、v11相当で中断したDBの再open。
  - upgrade blocked時のユーザー可視挙動。
  - 複数タブ解消後にupgradeが自動再開するか。
  - upgrade失敗時に旧storeとpending行が原子的に戻るか。
  - browser/storage quotaやprivate modeでのopen失敗。

- v11でpending mutationを破壊する前提は「ユーザー0」に依存する。stg・開発端末・自動テスト利用者を含む対象環境の定義と、適用直前の再確認が必要。

- `classifyBulkError` の `permanent` は実際には「自動backoff停止」であり、pendingは自然trigger待ちになる。自然triggerが必ず発生する保証、長期pendingの可観測性、利用者が再試行させる手段がなければ、silent stallになり得る。

- 23502・23514・22003はpayload起因だけでなくserver実装やdeploy driftでも発生する。400でもデータを捨てない点は被害を抑えるが、400件数、constraint/code、pending滞留時間を監視しなければ回復性を確認できない。

- write-only/forensic列やPIIの「意図をcommentに書く」ことは保持期間・アクセス制御・削除手順の代替ではない。特に contact message、Stripe/Clerk event、integration failureにはretention未決という残余リスクが残る。

- `card_count`撤去後の正しさは表示だけでなく、作成・削除・bulk upload・offline同期・tombstone・seed/perf scriptを通じた件数整合で確認すべき。`cascadeLike`維持により性能低下が残るため、別task化するなら判断条件と計測値を残す必要がある。

- generated migrationのDDL件数を数えるだけでは不十分。constraint名、FK参照先、delete action、NULL semantics、型cast、既存constraintの意図しない再生成、snapshot/journalの整合を意味レベルで照合すべき。

## plan ドラフトへの抜け・未考慮指摘

- Task 7が過大。13列削除、3 index、FK、NOT NULL、27 CHECK、複数writer chain、null分岐、schema comment、runtime tuple、migration生成を一つのtask・commitに集約している。repo規律の「task 10–20行」「独立レビュー可能な単位」と緊張し、原因切分けも困難になる。migrationを一回に保ちつつ、事前のcode cleanup・schema設計レビュー・生成検証を別taskに分離できる。

- Task 7で実装を終え、Task 8で主要な保証テストを後付けしている。「置換pinを同taskで置く」「常時green」は満たしても、CHECK/FK/indexに対するred先行保証になっていない。少なくともtest skeletonと期待するredをmigration実装前に置く順序が必要。

- Task 8のred検証方法が危険かつ曖昧。「schemaからCHECKを外す」と、既生成migration、テストDB、snapshotのどれを変異させるのかが不明。各テストに対応する安全なmutation方法と、変異を確実に元へ戻したことの検証が必要。

- 置換pin表のindex行が対応していない。registry/asset status集合一致はCHECKの保証であり、削除する3 indexの代替保証ではない。`source_docs_user_exam_idx`にはEXPLAINがあるが、`entity_mutations_entity_idx` と `cards_answered_idx` には、query不存在の再確認または代表操作の性能pinがない。

- Task 8のEXPLAINで「特定indexを使う」と固定するとfixture規模やplanner差でflakyになる。データ量、`ANALYZE`、許容plan、CI PostgreSQL版をplanに定義すべき。

- Task 1のscratch testは、成立しなければ未commit変更が残る。read/write実装時の作業規律として、破棄方法、Task 6への引継ぎ、失敗時の証拠保存場所を定義すべき。

- Task 1はv10→v12しか明記しておらず、v11中断相当DB、upgrade transaction abort、blocked解消後の再openを自動検証しない。「原子的rollbackに依拠する」重要前提に対応するtestが不足。

- Task 6のowner-scope試験は、別ownerのflush/coalesceだけでなく、failed/attempted/synced/stale遷移、並走flush、logout/login切替を含んでいない。

- Task 6は呼出14箇所を列挙するが、全production呼出が移行済みであることを機械的に保証する完了条件がない。型検査に加え、旧signature・ownerなしquery・単独`sync_status`参照がゼロであることを監査対象にすべき。

- Task 7のmigration検証は「空DBへの適用」を明記する一方、0035まで適用済みで旧列にデータが存在するDBからのupgrade試験が明確でない。正に危険なのはこちらの経路。

- Task 7の完了条件にTask 8で追加予定のFK/CHECK保証が入っていないため、migration commitが重要保証なしで`[reviewed]`になる。

- Task 9のrunbook/docsを `[no-review]` としているが、deploy順、停止点、backup、DDL診断は本変更で最も運用リスクが高い部分である。少なくともrunbookはcanonical/Codex review対象にすべき。

- Task 9で「sprint完了」としながら、specで検証手段に含めたstg実機Dexie smokeをOT判断後へ送っている。実装完了とdeploy readinessを別状態に分け、どの完了条件にsmokeが属するか明示すべき。

- runbookにdrain timeout時の分岐、stuck operationの処置、失敗したuploadの回復、migration後障害時のforward-fix/restore判断がない。

- 「900秒」の設定値確認taskがない。固定値を文書へ写すだけでは、設定変更時にrunbookがdriftする。

- backupについて「restore検証済み」の判定基準、対象時点、暗号化・保管、RPO、復旧所要時間がない。

- `pnpm db:generate`を再実行してno-diffとする手順は、no-op時のCLI挙動や不要file生成有無を明示していない。検証後のworktree clean確認も完了条件に必要。

- Task 7の「生成SQLを手動編集しない」は健全だが、DrizzleがFK張替順・constraint名・CHECK式を期待どおり生成できない場合、停止以外の許容手順がない。schema表現の限界やcustom SQL migrationが必要になった場合はspec再裁定になることを明記すべき。

- Task 2ではarchitecture.md更新がTask 9まで遅れる。その間、コード上の意味論と文書化された「pendingはtransientのみ」が複数commitにわたり矛盾する。同commit、または少なくとも同review単位で更新する方が安全。

- Task 4/5のproduction参照ゼロ再確認が完了条件にない。調査時点から実装時点までの差分を考え、DROP直前に対象field・index queryの再検索をgateにすべき。

- `pnpm install --frozen-lockfile` は通常依存検証だが、既存workspaceを書き換える可能性がある。実装planではclean worktree確認とlockfile差分ゼロを併記すべき。

- 全体として、deploy compatibility testがない。少なくとも「新code+旧schemaではuploadが期待どおり失敗する」「新code+新schemaは成功する」「旧code+新schemaはrollback不可」をstgまたは統合試験で明示確認する必要がある。

## リスク / 対立しうる設計判断

- **単一migration vs expand-contract**  
  単一migrationは簡潔だが意図的なupload停止窓とrollback不能を作る。ユーザー0を強く信頼できるなら妥当だが、運用安全性を優先するならnullable化/default導入→code切替→column dropの段階移行が勝る。

- **`ON DELETE CASCADE` vs ledger保持**  
  CASCADEはNOT NULLとの整合と削除成功を保証する一方、冪等・監査ledgerを失う。ledger保持が必要なら、source documentとは別の不変な識別子へ切り離す設計が必要。

- **広いPG code分類 vs constraint単位分類**  
  code単位は単純だがserver欠陥も400に含める。constraint/route単位は精密だが保守負担が大きい。現案を採るなら監視とpending再起動経路が必須。

- **pending保持 vs terminal化**  
  pending保持はデータ回復性を高めるが、自然triggerがないと無期限滞留する。terminal化は明快だが修正後の自然回復を失う。第三案として、再試行停止状態と手動再開可能なquarantine状態を明示的に持つ余地がある。

- **破壊的Dexie upgrade vs user_id backfill**  
  drop/recreateは単純でowner混線を確実に消すがpendingを失う。実利用者が現れた後は採用困難なので、「ユーザー0」を適用直前gateにする必要がある。

- **`&mutation_id` global unique vs owner複合unique**  
  global uniqueは操作と更新を簡潔にするが、owner境界をDB indexで表現しない。`[user_id+mutation_id]` uniqueは境界を明確にする一方、既存のID更新処理を広く変更する。

- **index使用の固定assert vs性能予算assert**  
  index名固定は回帰を早く検出するがplanner変更に脆い。実行時間・buffer・scan行数などの性能予算は現実的だがCI変動がある。構造検証と代表データでのplan確認を分けるのが安全。

- **CHECKの広範囲追加 vsアプリSSoT**  
  DB backstopは破損防止に強いが、語彙追加時に3点更新とdeploy順制約が生じる。集合一致testが壊れやすい場合、DB enumや共有定義生成まで含めた単一定義化を将来検討する余地がある。

- **一括commit vs常時レビュー可能な小分け**  
  migration自体は一括でも、schema変更、writer cleanup、検証、運用文書まで一commitに集約するとレビュー精度が落ちる。migration生成直前までを小分けし、最後にDDLだけを集約する構成の方が追跡しやすい。

- **コメントによる残余リスク管理 vs実制御**  
  forensic/PII列を維持する意図は説明できるが、retention・アクセス監査・削除jobがなければリスクは減らない。今回非スコープでも、ownerと判断期限を持つ追跡項目が必要。