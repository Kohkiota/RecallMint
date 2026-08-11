# Codex plan cross-check — fsrs-sprint-a-plan (2026-08-11)

- **作成日**: 2026-08-11
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **`study_days` の再集計には別の lost update が残る**

   card 行ロックは「同一 card」の FSRS 更新だけを直列化します。同一 user・同一 JST day に対して、異なる card の回答を別 transaction が同時処理すると、両者は別々の card をロックして並行実行できます。

   その場合、各 transaction が相手の未 commit event を含まない集計値を作り、同じ `study_days(user_id, day)` を後勝ちで上書きし得ます。UPSERT 時の行ロックだけでは、既に計算済みの古い集計値による上書きを防げません。

   必要な設計判断は、たとえば次のいずれかです。

   - user/day 単位の advisory lock
   - `study_days` 行の先行ロック。ただし未作成行の競合も扱う
   - user 単位の直列化
   - commit 可視化後に安全に再計算できる別方式

   現仕様の「full 再集計だから加算競合が消える」は、異なる card の同時 ingest については成立しません。最重要の未解決点です。

2. **event_id の他ユーザー衝突検証と RLS の整合が必要**

   tenant RLS 下では、他 user の既存 `answer_events` 行を通常の SELECT で読めない可能性があります。`INSERT ... ON CONFLICT DO NOTHING` により衝突した事実は分かっても、「他 user 所有」をどう判定するかは別問題です。

   少なくとも以下を明文化すべきです。

   - own-user SELECT で取得できず、かつ INSERT 非新規なら「foreign/不可視衝突」と判定するのか
   - privileged query、security-definer、admin connection等を使うのか
   - logger に既存 owner IDを出す必要があるのか、単に不可視衝突として記録するのか

   RLS を迂回する実装を採るなら、tenant isolation を弱めない限定性の証明も必要です。

3. **option 実在検証の同時更新規律が不明**

   card 行はロックされますが、選択肢の削除・更新処理が同じ card 行を必ずロックするとは限りません。A-2 検証中に option mutation が並走すると、`applied` 判定が transaction timing に依存します。

   option mutation が card lock 規律に従うことを invariant とするか、option 行もロックするか、snapshot 依存を正式に受容するかを決める必要があります。

4. **「現行コードによる再計算可能性」は answer_events だけでは不足し得る**

   再計算には少なくとも次が必要です。

   - card の初期状態・生成時刻
   - 適用対象 card の存在または復元情報
   - option 実在判定に使う deck/card 内容
   - applied event の確定適用順
   - FSRS version・parameters

   card や option の削除後も event を残す設計では、answer_events 単独から `applied` 判定や card state を再構成できません。「再計算可能性」が「現存 card と保存済み applied flagを前提に、現行コードで近似再生できる」という意味なら、その前提まで限定した方が正確です。

5. **`applied=false` の理由が保存されない**

   次の事象がすべて同じ状態になります。

   - card 不在
   - 他 user card
   - option 不一致
   - 時系列ガードによる skip

   監査・障害調査・将来の修復判断では区別できません。理由列を追加しない裁定でも、最低限ログだけで十分か、将来の調査能力を意識的に捨てるかを明記すべきです。

6. **「全回答の恒久記録」と実際の保存範囲に差がある**

   以下は server 正本へ保存されません。

   - client 送信前 schema validation で failed になった event
   - event_id 衝突で拒否された内容
   - 退会時に明示削除された event

   したがって保証は「schema-valid で、event_id 衝突せず受理された回答の、退会までの記録」程度です。「全回答」「恒久」の表現は過大になり得ます。

7. **client の event_id 一意性が schema 上保証されていない**

   Dexie 定義の `event_id` は通常の indexに見え、unique indexの指定ではありません。local に同じ event_id の複数行ができると、次が曖昧になります。

   - 先勝ち dedupe でどの内容が送られるか
   - response の event_id でどの local 行を synced/failed 化するか
   - userId + event_id 更新が複数行に作用するか

   `event_id` の local uniqueness、生成衝突時の挙動、既存 duplicate の破棄方針を契約化すべきです。

8. **immutable field の一致比較を型ごとに定義する必要がある**

   特に曖昧なのは次です。

   - `selected_answer_ids`: 配列順を内容の一部とするか、集合として比較するか
   - optional `session_id` / `elapsed_ms`: missing と DB `NULL` の正規化
   - `answered_at`: ISO offset、桁数、DB の timestamp 精度丸め
   - UUIDや日時文字列の表現差をparse後の値で比較するか

   SQL `jsonb` equalityや文字列比較へ暗黙に委ねると、正当再送の偽衝突が起き得ます。

9. **全 transaction throw を503 transient扱いするのは危険**

   CHECK違反、SQL shape不良、想定外データ、実装バグまで503にすると、client は永久再送します。503に変換する retryable DB error の範囲と、非retryableな server defect の観測・応答方針を分ける必要があります。

10. **transaction isolation level が正しさの前提**

    `SELECT ... FOR UPDATE` 待機後に先行 transaction の更新状態を読み取れることは、通常 `READ COMMITTED` を前提にしています。`REPEATABLE READ` 等では serialization failureやsnapshot差が生じます。`withTenantTx` の isolation levelを仕様またはテスト前提として固定すべきです。

11. **複数 card lock取得と request上限の運用リスク**

    最大1000 eventで最大1000 cardをロックし、その後に全 insert・fold・集計を行います。重い requestが同一 userの別操作、card delete、entity mutationを長時間待たせます。timeout、deadlock retry、statement/transaction時間、Retry-After値の根拠が必要です。

12. **古い event による過去 `study_days` の無制限生成**

    下界 clampなしのため、誤時計で数十年前の日付も生成できます。「自 userのみ」でも、dashboard range、streak query、storage、運用調査への影響があります。受容するなら、表示・集計側が異常日付で壊れない確認が必要です。

13. **RLS/grant再適用を別手順にすると無防備窓を完全には排除できない**

    DROP/CREATE後、policy/grant再適用までが別command・別transactionなら「即時」でも窓はあります。新表作成時点で権限を閉じる、migrationとpolicy適用を同一transactionにする、またはapp trafficを止める、といった原子的な運用設計が必要です。

14. **migrationとapplication deployの互換切替点**

    migration適用後から新application稼働まで、旧serverはDROP済み表・変更済み必須列へアクセスします。ユーザー0でもhealth check、cron、管理処理などが失敗し得ます。「中間deployしない」だけではmigration/appの切替原子性は保証されません。

15. **監視・運用指標がwarnログ中心で弱い**

    最低限、次を識別・集計できる必要があります。

    - clamp件数
    - foreign/内容不一致衝突
    - applied=false理由別件数
    - 503/retry回数
    - failed local event件数
    - flush backlogと最古pending age
    - transaction時間・lock wait

    保存列を増やさなくても、structured log/metricの契約は必要です。

---

## plan ドラフトへの抜け・未考慮指摘

1. **`study_days` の異なる card 間競合テストがない**

   Task 6の同時実行は同一 cardのみです。異なる2 card・同一 user・同一 JST dayを2接続で同時適用し、最終 `review_count=2` / `distinct_card_count=2` になるisoが必要です。現設計なら失敗し得ます。

2. **FOR UPDATE red testのbarrier説明が実現困難**

   「両 transaction のSELECT完了を同期してから解放」とありますが、対象SELECT自体が同じ cardへの `FOR UPDATE` なら、2本目は1本目のcommitまで完了できません。

   正常系とロック除去変異の両方で成立する同期点を、対象SELECTの直前などに設計し直す必要があります。現記述のままだとdeadlockまたはテスト不能になり得ます。

3. **RLS下の他ユーザーevent_id衝突を実装する具体策がない**

   Task 4は「2段検証」とだけ記載し、不可視行をどうforeign collisionと認定するかを定めていません。ISOも「他人」をpinするだけで、RLSを誤って迂回していないことの観点がありません。

4. **option mutationとの競合テスト・lock invariantがない**

   card/option削除・更新とingestの並走について、card deletionだけが仕様にあります。A-2判定とoption mutationのserializationを追加で扱う必要があります。

5. **Dexie event_id重複の設計とテストがない**

   `event_id` unique化、重複生成防止、複数local rowが存在した場合のstatus更新範囲がTask 5にありません。

6. **collision canonicalizationのテストが不足**

   Task 6の正当再送はclampのみです。少なくとも以下もpin対象です。

   - missing と null
   - ISO timezone表現と精度
   - selected_answer_ids の順序差
   - payload内duplicate event_idの同内容・異内容
   - duplicateを含むresponseとlocal status更新

7. **空配列、chunk境界、payload重複の契約がない**

   `{events: []}` を許すか、1000/1001境界、同一payload内duplicateのfailed/synced扱い、warnの機密性と量制御がplanにありません。

8. **503分類の検証が粗い**

   Task 4はtx throwを一律503としています。retryable errorとprogramming/data errorを区別する設計・testがありません。無限retryを新たに作る可能性があります。

9. **最終gateに通常unit testの明示がない**

   各taskでは `pnpm test` を実行しますが、Task 7のsprint最終gateからは抜けています。最終統合後の回帰として通常test suiteも必要です。

10. **stg smokeがspecの完了条件とplanで矛盾**

    spec §13はstg smoke PASSを完了条件に含めています。一方Task 7はpush前にSprint境界で停止し、stg smokeをOT指示後へ延期しています。この状態で「Sprint完了」と判定できません。

    「local implementation complete」と「Sprint complete」を別状態にする必要があります。

11. **migration/app切替runbookがない**

    RLS再適用runbookには触れていますが、旧server停止、新migration適用、新server切替、rollback不能なDROPへの対応順がありません。

12. **DROP前の参照網羅がfile list依存**

    reviews/study_sessions参照について、TypeScript以外のSQL、scripts、audit、seed、generated artifacts、monitoring query、CI helperまで `rg` で全数確認するtaskがありません。cards INSERTには探索stepがある一方、廃止表には同等の探索完了条件がありません。

13. **`applied=false` 理由の観測確認がない**

    danglingと順序skipはtestされますが、運用上両者を判別できないことの受容、またはreason別logのtestがありません。

14. **性能計測が所要時間ログだけ**

    lock wait、SQL query count、study_daysの対象day数、1000 distinct cards、1000 distinct days、同一day集中など、負荷形状別の確認がありません。特に1000日分VALUESはparameter数・SQLサイズ・実行計画の確認が必要です。

15. **Task 4が大きすぎて失敗局面を分離できない**

    schema破壊、ingest、RLS、退会、集計、統計定義、fixture全面改稿を一commit単位に束ねています。「greenな中間状態がない」としても、内部チェックポイントやreview単位まで不可分である必要はありません。問題発生時に原因特定とreviewが難しくなります。

16. **共有schemaのclient bundle境界確認がない**

    server/client共有zod moduleがserver-only dependencyやNode専用importを引き込まないこと、bundle sizeへの影響、RSC/client component境界のbuild pinが必要です。

17. **削除対象APIの外部利用確認がない**

    `createStudySession` 等を削除する前に、repo内参照だけでなくroute contract、browser storage upgrade、古いservice worker/tabからの呼出しをどう扱うかがありません。ユーザー0でも開いた開発tabなどはあり得ます。

18. **red変異の安全な実施方法が未定義**

    5種類の手動変異を同じ共有worktreeで行うなら、ユーザー変更や他taskの変更を損なわず確実に復元する手順が必要です。特にcommit済みコードを直接変異して戻し忘れるリスクがあります。

---

## リスク / 対立しうる設計判断

| 判断点 | 一方の利点 | 反対側のリスク |
|---|---|---|
| card単位ロックのみ | 並行性が高い | `study_days` はuser/day共有資源なので集計lost update |
| applied reasonを保存しない | schemaが簡潔 | 監査・修復・障害解析能力が低い |
| cross-request tieをlock順にする | watermark不要 | 再現不能、lock scheduling依存 |
| raw timestampを保存しない | schema・privacyが簡潔 | clock異常の事後解析不能 |
| card_id FKなし | 履歴をcard削除から保護 | dangling増加、再計算にcard情報不足 |
| option mismatchも受理 | poison pillを回避 | 不正入力が正本に入り、理由も残らない |
| client判定のis_correctを統計正本化 | UI意味論と一致 | client改変・version差で統計を操作可能 |
| ratingを別の正誤軸にする | FSRS入力を保持 | 「正解だがAgain」等の説明・分析が複雑 |
| app時刻でcreated_at設定 | clampと完全に同じ時刻源 | DB直書き・別writerが契約を破りやすい |
| 下界clampなし | 正当な長期offlineを保持 | 異常な過去日付・dashboard/streak汚染 |
| 無期限event保持 | audit性が高い | 容量、退会・privacy、index成長 |
| indexをuser/timeのみに限定 | write costを抑制 | card別調査・衝突調査・再計算が遅い |
| DROP/CREATE | clean schemaへ直行 | policy/grant欠落、deploy非互換、rollback困難 |
| failed local行を永久保持 | データ非損失 | UI/運用で不可視なら実質的な墓場 |
| 全tx errorを503 | wireが単純 | 恒久バグの無限retry・障害隠蔽 |
| Task 4を不可分実装 | 一時的な型不整合を避ける | review困難、変更原因の切り分け困難 |

最優先で解消すべきなのは、`study_days` の異なるcard間の並行再集計、RLS下のforeign event_id衝突判定、そしてstg smokeを含む「完了」の定義矛盾です。