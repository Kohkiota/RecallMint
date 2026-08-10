# Codex plan cross-check — asset-lane-gc (2026-08-10)

- **作成日**: 2026-08-10
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. 共有 deadline と lane ごとの進捗保証

`src_sweep → asset_gc → asset_orphan_scan` を単一の `deadlineAt = start + 270s` で逐次実行する場合、先頭 lane が予算を使い切ると後続 2 lane は毎日実質未実行になりうる。特に退会 asset の「日次、最大おおむね24時間」という要件は、cron が日次で起動するだけでは満たせず、`asset_gc` に実行枠が配分されることまで必要。

必要な設計事項:

- lane ごとの予約予算、個別 deadline、または最低実行保証
- 先行 lane が期限超過して返らない場合の後続 lane 保護
- 各 lane の最大 I/O 時間と tail reserve
- 「日次削除期限」が best effort なのか契約なのか

2. `runReconciler` 無改造と deadline/chunk 要件の整合

現行 core は collect 候補を一括取得し、asset ごとに逐次 R2 DELETE する。core 内に deadline 判定も LIMIT も chunk 並列もない。

したがって次の両立は、そのままでは不可能:

- core を無改造で再利用
- collect chunk 境界で deadline を確認
- DELETE を chunk 20 で並列化
- 1 user が大量の候補を持っても予算内で中断

user 境界のチェックだけでは、単一大型 tenant の処理中に platform timeout へ到達する。これは将来規模だけでなく、30日後の204件集中でも実装見積りの前提に直接関係する。

3. collect 候補の boundedness と公平性

必要なのは user の処理順だけでなく、user 内の候補順・上限・再開性。

- `fetchCollectCandidates` に ORDER BY / LIMIT がない
- oldest-first などの順序がない
- promote 後の全件が一度にメモリへ載る
- 1 user が大きいと後続 user が starve する
- uuid 順は「処理の古い作業」を優先しない

少なくとも `(status, 時刻, id)` 等による安定順序、LIMIT、翌日再開可能な状態依存処理が必要。

4. SECURITY DEFINER の安全境界

返却列を UUID のみに絞るだけでなく、以下を固定する必要がある。

- function owner が誰か
- `REVOKE`/`GRANT` の対象と migration 後の実測
- `search_path` hijack 対策
- 関数が参照する object の schema qualification
- app role が関数定義を変更できないこと
- 関数 predicate と実 GC predicate のドリフト防止
- 関数実行が無制限集合を返すことによる負荷
- parallel cron 実行時に同じ user が重複処理されることの許容範囲

また「得た UUID では他 user の行を読めない」は、呼出側が必ず tenant transaction を使うことに依存するため、関数単体だけで安全性が完結しているわけではない。

5. user 列挙 predicate の完全性

列挙関数は GC 作業集合の唯一の入口になる。false negative は作業が永久に拾われない silent failure になる。

確認すべき集合:

- mark 候補
- markClear 候補
- promote 候補
- deleting/deleted
- 異常 status
- 行 DELETE retry
- status と `unreferenced_at` の不整合状態
- 将来 status を追加した場合の扱い

正常系の3 armだけでなく、不整合状態を観測・修復対象にするか、明示的に対象外とするかが必要。

6. orphan scan の TOCTOU

「DELETE 直前の行不在確認」は窓を縮めるが、原子的ではない。

```text
行不在 SELECT → crop/recovery が assets INSERT → R2 DELETE
```

が理論上残る。「age 7日かつ live operation なしなら後から行が生えない」という主張は、すべての recovery 経路と再試行可能期間について証明が必要。live operation が終了・失効した後でも古い object を使った recovery が可能なら不十分。

必要なのは次のいずれか:

- 後発 INSERT が不可能であることの恒久テスト
- recovery 側で R2 existence を再確認する契約
- orphan tombstone/claim の導入
- DELETE 後の DB 再確認と、不整合発生時の明示的修復・台帳化

7. bounded listing は eventual scan を保証しない

`users/` の先頭10 pageを毎日取得するだけなら、10,000 keyを超えた時点で辞書順後半は永久に観測されない可能性がある。`truncated` の記録は「不完全だった」ことを示すだけで、走査範囲を前進させない。

必要な設計事項:

- continuation token/checkpoint の永続化
- prefix sharding/ローテーション
- 定期的な全域 operator scan
- 「partial observation の受容」が orphan 回収目的と矛盾しないか

現時点242件という事実は、この構造的問題を解消しない。

8. pattern mismatch の意味と通知設計

`users/` には旧 `src/` key等も存在しうるため、asset 規約不一致をすべて failure として毎日記帳すると、既知 keyを繰り返し通知する可能性がある。

明確化が必要:

- mismatch のうち期待された別レーン key と真の異常 keyの区別
- 同一 key の重複抑止
- quota超過後の総数・oldest・sample
- mismatch は incomplete なのか正常 skip なのか

9. 台帳の意味と観測可能性

最低限、次を readback/台帳で区別できる必要がある。

- lane未開始
- deadline前に0件正常終了
- listing partial
- user列挙失敗
- user guard trip
- live判定失敗
- DB行確認失敗
- R2 DELETE失敗
- R2成功後のmarkDeleted失敗
- 行DELETE失敗
- 台帳自体の記録失敗
- platform timeoutでsummaryを返せなかった場合

HTTP 200 + summaryだけでは、platform killやcron未起動は観測できない。成功 heartbeat/last-success の必要性も別途判断が要る。

10. R2成功後・行DELETE前の各障害点

既存の `deleting → R2 DELETE → deleted → row DELETE` には、少なくとも次の crash point がある。

- R2 DELETE成功、`markDeleted`失敗
- `markDeleted`成功、row DELETE前に停止
- row DELETE成功、summary/台帳出力前に停止

404冪等性により収束可能でも、各状態が次回列挙関数に必ず拾われること、件数が誤計上されても運用判断を壊さないことを pin すべき。

11. 手動入口の blast radius

`?graceDays=0&user=X` が `asset_gc` のみを scopeする一方、同じ GET で `src_sweep` と全域 `asset_orphan_scan` も実行されるなら、stg smoke のつもりで他 laneの実削除まで起動する。

手動実行について必要な判断:

- lane selectorを設けるか
- smoke時に他 laneも動くことを明示的に受容するか
- orphan scanを手動 GET で毎回走らせる必要があるか
- 同時手動実行とcron重複への排他・冪等性

12. 退会 asset の削除期限

「日次 cron」は起動頻度であり、削除完了期限ではない。deadline、R2障害、user starvation、cron失敗により24時間を超える。

GDPR上の契約にするなら、例えば次を定義する必要がある。

- 通常目標とhard upper bound
- incomplete連続回数のalert
- overdue基準
- 手動復旧手順
- R2 lifecycle実設定未確認をどう扱うか

13. テスト境界

恒久的に必要なのは、A/B共有だけではない。

- SECURITY DEFINER のRLS境界と権限
- 列挙predicateとGC predicateの同値性
- 単一user大量候補でのdeadline
- concurrent run
- R2成功後の各DB障害
- orphanの行確認後INSERT race
- listing >10 pageの非到達
- malformed LastModified/list response
- row check queryのchunk上限・parameter上限
- platform deadlineより各I/O timeoutが短いこと
- cron未起動/未完了の運用検知

## plan ドラフトへの抜け・未考慮指摘

1. 最重要の内部矛盾: Task 2は「core verbatim・無改造」、Task 5はuser境界のdeadline確認だけだが、Global Constraints/specは「collect chunk境界のdeadline確認」「chunk 20並列」を要求している。現行 `runReconciler` の制御ループ内部を変えずに実現する手段がplanにない。

2. 共通deadlineの配分taskがない。Task 7は`LaneContext`を縮めるだけで、先頭の`src_sweep`が270秒消費した場合の後続lane実行保証を設計していない。

3. Task 5のuser処理順をuuid順・starve制御なしとしているが、これは「日次回収」や退会assetの残留期間と衝突する。少なくとも恒常的incompleteを検出するだけでなく、発生後どう公平性を回復するかがない。

4. Task 6の10-page listingはcontinuationをrun間で引き継がない。規模が上限を超えると後半を永久に見ない問題が、テストにも実装taskにもない。

5. Task 6は「行不在確認がDELETEに最近接」で安全とするが、確認とDELETE間のINSERT raceを閉じていない。三重条件から「後から行が生えない」ことを証明するテストもない。

6. Task 6の`inArray`はuser内候補数のchunkingが指定されていない。大量候補でSQL parameter上限、statement size、transaction時間の問題がある。

7. Task 5の`rowDeleteFailures`後処理は、失敗後にasset行を再検索してobject keyを得る設計。再検索自体が失敗・競合した場合、肝心の失敗contextを失う。core summaryが最初から `{assetId, objectKey, error分類}` を返す方が堅いが、「core無改造」と衝突している。

8. core内部の既存`recordFailure`失敗は握り潰され、summaryに`recordErrors`がない。lane側が`recordErrors`を正確に集約する具体的配線がTask 5にない。

9. Task 5のdeadline testは「user途中のdeadline打ち切り」と書く一方、実装制約はuser境界だけの確認。テスト要求と実装interfaceが一致していない。

10. Task 7の手動GETテストに、override実行時も他2 laneが走ることの安全性・期待値がない。`user` scopeがorphan laneへ効かないため、限定smokeが全域破壊処理を伴う点が未考慮。

11. Task 1のSECURITY DEFINER testは返却集合とEXECUTE可だけ。PUBLIC revoke、非app role、function owner、search path、他tenant行が直接読めないことのpinが不足。

12. Task 1は3 armが「core WHEREと同値」とするが、自動的な同値性保証がない。将来core predicateだけ変更されるドリフトへの手当てがない。

13. Task 6のpattern mismatchは`.WEBP`等を異常として毎日記帳するが、重複抑止・既知legacy prefix除外・alert fatigueの試験がない。

14. Task 6は`truncated`を記録するだけで、`remaining`や観測範囲、走査前進位置を持たない。summaryの`rowlessFound`もspec本文にはあるが、planの`OrphanScanSummary`には明示されず、`candidates`がage/live/row確認のどの段階か曖昧。

15. Task 8はself-healを追加している点はよいが、R2 DELETE直前の参照再読後にrefが追加される競合は試験しない。既存app論理が弾くことを依存条件として明記・pinすべき。

16. Sprint gateにcron routeのbuild/production bundle確認が明示されていない。`server-only`、静的R2 import、route segment制約を変更するため、unit/lintだけでなく実buildが必要。

17. 適用後確認がplan外に追い出されているため、「実装完了」と「運用可能」の境界が曖昧。少なくともmigration grant実測、CRON_SECRET、cron schedule、lane readback、初回mark件数の受入条件がrelease checklistとして必要。

18. docs taskに、既に誤りと判明した「reconciler dry-runでR2/DB divergenceを検出できる」という記述の訂正が明示されていない。`r2-key-inventory.md`の「誰が消す列」更新だけでは不足。

19. planはprod lifecycle実設定を別件として受容している一方、asset prefixにlifecycleがないことを設計前提にしている。未知のdashboard設定が二重削除や保持期間へ影響するため、少なくともdeploy前gateか明示的リスク受容が必要。

20. 「30日後204件は数十秒」という見積りを検証する負荷試験・計測taskがない。しかも現行coreは逐次DELETEなので、chunk 20並列という見積り前提と一致していない。

## リスク / 対立しうる設計判断

- core不変 vs deadline安全性  
  coreを完全に保つほど回帰リスクは低いが、単一user内の中断・LIMIT・並列化は実現できない。今回のcron化では後者を優先し、core interfaceをbounded batch型へ拡張する方が整合的。

- 単一共通deadline vs laneごとのSLO  
  実装は単純になるが、後続laneの日次実行を保証できない。特に退会asset回収を要件化するなら予算予約が必要。

- bounded listing vs eventual completeness  
  boundedは安全だが、固定prefix先頭から毎回読む設計は「安全な部分観測」ではなく「永久未観測」を作る。checkpoint導入か、回収保証を明確に放棄する必要がある。

- UUID順の単純さ vs fairness  
  現規模では十分でも、特定tenantの大量候補や先行laneの長時間化で恒常starvationになりうる。

- 7日cutoffの保守性 vs raceの証明  
  大きなcutoffは事故確率を下げるが、TOCTOUを論理的には消さない。時間だけを排他機構の代替にしてよいかが判断点。

- 手動endpointの利便性 vs blast radius  
  smokeが容易になる一方、1 laneを試したい操作で3 laneすべての実削除を起動する。lane selectorは操作面を増やすが、安全な検証境界を作れる。

- failure-only台帳 vs successful-run heartbeat  
  失敗台帳だけではcron未起動・platform kill・認証失敗の継続を検出できない。成功記録を別の軽量な観測系に置くか判断が必要。

- SECURITY DEFINERの露出最小化 vs predicate保守性  
  作業userだけ返す設計は露出が小さい反面、GC predicateとの二重定義になりsilent skipを生みうる。単純な広い列挙と厳密な権限制御の方が保守しやすい可能性もある。

- prod lifecycle未確認のまま進めるか  
  repo上の設計と実環境が一致する保証がない。実装sprintを止めない選択は可能だが、release前の確認条件には置くべき。

総括すると、ドラフトの最大の問題は「core無改造」「chunk境界deadline」「chunk並列」の三者が両立していない点と、共有270秒deadlineのため後続asset laneに日次実行保証がない点です。この2点は実装詳細ではなく、確定specの目的を満たせるかに関わるため、着手前に解消が必要です。