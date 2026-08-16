# Codex plan cross-check — r0-review-log-persistence (2026-08-16)

- **作成日**: 2026-08-16
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **「1 event = 1 log」はDB上では片方向しか保証されない**
   - `review_logs.event_id → answer_events.event_id` とPKにより、「logには必ずeventがある」「1 eventに最大1 log」は保証される。
   - 一方、「`answer_events.applied=true` なら必ずlogが1件ある」は同一txのアプリ実装に依存し、DB制約では保証されない。
   - 通常経路だけでなく、旧コード、operator SQL、将来の別writer、コードrollbackを含む保証範囲を明記すべき。

2. **`user_id` / `card_id` の帰属整合性がDBで保証されない**
   - `review_logs.user_id=A` が、ユーザーBの `answer_events.event_id` を参照する行をDB構造上は作成できる。
   - `card_id` も親eventの `card_id` と不一致にできる。
   - RLSはreview_logs自身の `user_id` しか検査しないため、誤帰属を防がない。owner/operator経路ではさらに顕在化する。
   - アプリ写像を信頼する判断なら、その残余リスクと整合性監査が必要。

3. **アルゴリズム・設定のprovenanceが不足**
   - 将来のパラメータ最適化では、各行がどの `ts-fsrs` バージョン、FSRSパラメータ、設定で生成されたかが重要。
   - exact pinは「現時点」の再現性しか保証せず、将来バージョンやパラメータ変更後には異なる母集団が同じ表へ混在する。
   - 少なくとも、変更時にepoch/versionをどう識別するか、別表・deploy時刻・event時刻から再現可能かを決める必要がある。

4. **同時刻eventの総順序は依然保存されない**
   - after 3列により各event単体の遷移は保存できる。
   - しかし同じcard・同じ`answered_at`の複数eventについて、DB上の総適用順序は `event_id` や時刻から確定できない。
   - before/afterの連鎖から一意に並べられないケースもあり得る。after列は「遷移の保存」には有効だが、「順序の完全保存」ではない。
   - 将来の系列分析が総順序を必要とするなら、fold ordinalや適用sequenceが必要。

5. **rolling deployで欠損が発生する**
   - migrate・policy適用後、旧コードと新コードが混在するrolling deployでは、旧instanceがanswerを適用してもlogを書かない。
   - これは「今日記録しないものは永久欠損」および `applied ⇒ log` と直接衝突する。
   - code rollback後も同じ問題が起こる。
   - 書込停止を伴うcutover、全instance同時切替、feature gate、欠損許容境界などのrelease方式が必要。

6. **migrateとRLS適用の間に実際の無防備窓がある**
   - default privilegesが新表を自動grantするなら、CREATE TABLE後・RLS enable前はapp roleからアクセス可能になり得る。
   - 「同一メンテ窓」は原子性を意味しない。app停止、同一transaction、先行REVOKEなど、窓を閉じる具体策が必要。
   - disable SQLを実行した場合もgrantが残るため、rollback時の露出条件を定義すべき。

7. **失敗分類とクライアント再送性の確認**
   - 23505と23503は現行classifierではtransientだが、23514/23502はpermanent-4xxに分類される。
   - ReviewLog写像バグでCHECK/NOT NULL違反になると、answer event自体もrollbackする一方、クライアントが4xxを終端扱いすれば復習が永久に未受理になる可能性がある。
   - 「loud failure」のHTTP分類、pending保持、再送、運用復旧後の回復手順まで確認が必要。

8. **原子性の負方向テストが必要**
   - 同一txオブジェクトを渡したことだけでは、「log INSERT失敗時にanswer_events、card状態、applied、study dayがすべてrollbackする」ことを証明しない。
   - 本設計の中心的性質なので、失敗注入による実PG rollback試験が望ましい。

9. **全フィールドの意味保存を検証する必要**
   - 主要before/afterだけでなく、`due_before`、deprecated 2列、`scheduled_days`、`learning_steps`、`created_at`、`card_id`、`user_id` の写像ミスも分析データを静かに破壊する。
   - 特に `created_at = answer_events.created_at = receivedAt` と `review = clamp済みansweredAt` の区別をpinすべき。
   - PostgreSQL timestamp精度・JS Date変換を含む比較方法も決める必要がある。

10. **数値異常をDBで許容する判断**
    - PostgreSQLのdouble precisionはNaNやInfinityを保持できる。負のstability/difficultyや負のday系も現制約では入る。
    - ts-fsrsを唯一のproducerとして信頼する判断は可能だが、分析データ汚染とingest可用性のどちらを優先するか明示した方がよい。

11. **保持ポリシーは容量以外の運用面が不足**
    - 無期限保持では、heap/indexだけでなくWAL、replica、backup、vacuum、restore時間も増える。
    - 退会scrubがlive DBだけなのか、backupからの復元時にも再scrubされるのかが未定義。
    - 個人データ分類、法的保持、障害復旧、将来のpartition/tiering条件も論点になる。

12. **性能評価は平均的な単発local測定だけでは弱い**
    - 実運用ではWAL fsync、同時tenant、deadlock、RLS、autovacuumの影響がある。
    - 複数回測定、中央値/p95、適用件数0・一部skip・1000件全適用の区別が必要。
    - +20%をgateにしないなら、超過時の受入判断者と後続条件を定義すべき。

13. **監視・障害検出**
    - ReviewLog障害がreview ingest全停止になる設計なので、エラー率、SQLSTATE、503/400比率、欠損監査結果へのalertが必要。
    - `applied=true` とlogのanti-join監査は、release事故やoperator書込の検出にも使える。

14. **`replayCard` の並列配列契約が脆い**
    - `{state, logs[]}` はeventとの対応をindexに依存する。
    - 現在foldが1 eventずつ呼ぶため成立するが、将来まとめて呼ぶ変更では、各logに対応するafter状態を正しく取り出せない。
    - event・log・afterを一体化した結果型の方が不変条件を局所化できる。

## plan ドラフトへの抜け・未考慮指摘

1. **最重要の欠落はdeploy中の旧コード混在対策**
   - Task 5は「migrate → policies → code」だけで、rolling deploy中に旧instanceがlogなしanswerを生成する問題を扱っていない。
   - rollback手順にも同じ欠落がある。

2. **RLS無防備窓への具体策がない**
   - Task 1はmigrationとpolicyを別成果物・別適用としている一方、app roleのgrant済み状態を考慮した遮断手順がない。
   - enable失敗時の停止条件、disable SQL実行時の安全性も未記載。

3. **FK先とのtenant/card整合性試験がない**
   - schema readbackはFKの存在しか確認しない。
   - `review_logs.user_id/card_id` と参照先answer eventの値が一致することは保証・監査されない。
   - 少なくともアプリ写像テストと、異tenant参照が構造上可能であることの受容判断が必要。

4. **log INSERT失敗時の実rollback試験がない**
   - tx identity unit testは配線確認に留まる。
   - answer_events挿入、card更新、markApplied、study-day更新まで戻ることを失敗注入で検証すべき。

5. **iso試験の列検証範囲が不足**
   - Task 4はbefore/after 3値、review、rating中心で、残りのReviewLogフィールド、帰属列、`created_at`の厳密な写像をpinしていない。
   - 「10 field verbatim」という主要要件に対して検査が弱い。

6. **provenance方針がない**
   - ts-fsrs 5.4.1 pinは記載されるが、将来upgradeやパラメータ変更後の行識別方法がない。
   - 今回列追加をしない場合でも、移行時に識別できる根拠をspecまたは運用記録に残す必要がある。

7. **同時刻eventの分析上の順序問題を試験していない**
   - 連鎖試験は異なるbefore/afterが順に並ぶ通常ケースのみ。
   - 同一timestamp複数eventについて、何が保存でき、何が復元不能かを明示する試験または仕様記述がない。

8. **恒久4xxとなるReviewLog書込障害を扱っていない**
   - CHECK/NOT NULL違反時のroute応答とclient pending挙動を確認するtaskがない。
   - 「既存tx失敗クラス」と述べるだけでは、復旧可能性の説明にならない。

9. **監視・整合性監査が完了条件にない**
   - ingest全停止を意図的に選ぶなら、review_logs起因エラーを識別できるログ・metric・alertが必要。
   - 定期またはdeploy後の `applied=true AND NOT EXISTS(review_log)` 検査もない。

10. **性能測定方法の統計的再現性が不足**
    - 1回のlocal測定値だけでは±20%判定がノイズに左右される。
    - warm-up、反復数、代表値、環境情報、全適用件数を固定すべき。

11. **migration生成物の完全な列挙が曖昧**
    - `drizzle-kit generate` がjournal/snapshot等を更新する構成なら、Files欄と成果物一覧から漏れている。
    - 0036〜0038が未pushのため、生成時のschema差分にR0外変更が混入しない確認も必要。

12. **policy disable側の検証がない**
    - enableのカタログ検査はあるが、disable → enableの冪等性や、disable時にpolicyだけ外れて表が露出する運用リスクは扱われていない。

13. **fixtureの意味整合性が弱い**
    - fixture用review logが、親answer eventの`applied=true`、rating/card/user/timestampと整合することを明示的に要求していない。
    - 単に合法値を入れるだけだと、fixture自体が本番不変条件に反する可能性がある。

14. **`replayCard` API変更の全caller確認が完了条件にない**
    - production callerが1箇所でも、test/helper/import利用を含めた全参照更新が必要。
    - `rg`等による全caller確認をtaskに明記した方がよい。

15. **成果物記述に自己矛盾がある**
    - 「実装4 file」としながら、列挙はschema、replay-card、session-aggregate、session-repository、ingestの5 file。
    - レビュー・完了判定時のscope漏れにつながる。

16. **red変異の記録方式が不明瞭**
    - working treeだけの変異をcommit messageに記録しても、実際にどのコマンド・どのtestが失敗したか再現しにくい。
    - session docに変異内容、対象test、期待した失敗、実結果を残す方が監査可能。

## リスク / 対立しうる設計判断

- **完全性 vs 可用性**
  - log欠損を防ぐためreview ingest全体をrollbackする判断は一貫している。
  - ただし分析用副次データの障害が主要復習機能を停止させる。監視・復旧時間・4xx分類まで含めないと運用リスクが大きい。

- **非正規化 vs DB整合性**
  - `user_id`、`card_id`、after値の保持は分析性を高める一方、親eventとの不一致可能性を増やす。
  - DB制約追加、監査、アプリ信頼のどこで担保するかを選ぶ必要がある。

- **最小schema vs 将来再現性**
  - version/config/ordinalを持たない最小設計は今の書込コストを抑える。
  - 一方、後から復元不能なprovenanceや適用順序は「今日記録しないものは永久欠損」という目的と緊張する。

- **最小index vs 運用性**
  - consumerがないためPKのみは妥当。
  - ただしanti-join監査、ユーザー単位調査、incident response、将来の直接user scrubにはuser/card index不在が効く。読み取りindexだけでなく運用queryも判断材料になる。

- **厳格CHECK vs ingest停止**
  - CHECKを増やせばデータ汚染を早期検出できるが、復習全体を停止させる。
  - CHECKを減らせば可用性は上がるが、NaN・負値等が分析を静かに汚染する。

- **FK cascadeによるGroup II vs疎結合な履歴**
  - event削除に追随してlogも削除されるためscrubは単純になる。
  - 一方、answer_eventsの誤削除・将来のretention変更が分析履歴も自動消去する。履歴の独立性とのトレードになる。

- **同一timestamp対応**
  - after 3列保持は正しい改善だが、総順序の保存とは別問題。
  - 将来用途が独立遷移の集計だけなら現設計で足りるが、系列最適化や厳密replayまで狙うならordinal不足が残る。

総評として、通常の単一version・単一writer・停止を伴うdeploy下では整った設計です。最も重大な未解決点は、**rolling deploy/rollbackによる永久欠損、アルゴリズムprovenance、親eventとの帰属不整合、log失敗時rollbackの実証**です。ファイル変更・git操作は行っていません。