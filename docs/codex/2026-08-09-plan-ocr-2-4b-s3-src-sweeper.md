# Codex plan cross-check — ocr-2-4b-s3-src-sweeper (2026-08-09)

- **作成日**: 2026-08-09
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **bounded listing による恒久 starvation**
   - 毎回 `src/` の先頭から最大10ページだけ読む構造では、先頭側に「若い object」「live user」「pattern mismatch」が大量にあると、後続ページへ永久に到達できない。
   - 特に pattern mismatch は削除しないため、辞書順の先頭10,000件を恒久的に占有しうる。
   - 「翌日 run が残りを拾う」「1日10,000 keyずつ進む」は、先頭集合が削除される場合にしか成立しない。
   - 台帳なしでも、continuation cursor、prefix shard、巡回開始位置などの公平性設計は別途必要になりうる。

2. **72h alert は `src/` 全体の最古 age を表さない**
   - 最大10ページしか見ない以上、算出できるのは「今回観測した範囲の oldest」であり、prefix 全体の oldest ではない。
   - R2 listing は key 順であり age 順ではないため、72h超 object が11ページ目以降にあれば検知不能。
   - したがって現状の alert は lifecycle/sweeper 全体の「効果監視の正本」にはならず、bounded partial observation である。

3. **同一 key への再 PUT/overwrite と DELETE の競合**
   - 「LIST後に新規 PUT された object は age 0なので安全」という説明は、新しい別 key には成立する。
   - 一方、listing で古い key を候補化した後、同じ key が再 PUTされて `LastModified` が更新され、その後 sweeper が DELETEすると、新しい objectを削除する。
   - presigned PUTの再試行、uncertain outcome後の再送、同一manifest再利用が同一 key overwriteを起こさないという不変条件が必要。保証できないなら DELETE直前HEAD、version/ETag条件、key一回限り保証などが論点になる。

4. **「保持上限55h」は無条件の上限ではない**
   - live-op skipが連日続く、DB live-checkが連日失敗する、cronが欠落する、先頭ページでstarvationする、処理量が日次能力を超える場合、55hを超えて残る。
   - これは「cronが毎日動く」「対象が有限時間内に走査される」「skipは最大1回」などを仮定した条件付き期待値/SLOであり、保持時間の不変条件ではない。

5. **成功履歴がないため cron停止を検知できない**
   - overdue alertは「実行された sweeper が古いobjectを観測した」場合しか発火しない。
   - CRON_SECRET欠落、Vercel設定不良、route障害、scheduler停止などでは、alert自体が実行されない。
   - Vercel logsだけでは保持期限・検索性・dead-man監視が弱い。scheduler heartbeat、外部モニタ、最終成功時刻のreadbackの要否を明確にすべき。

6. **alert経路自体の障害時の扱い**
   - `recordIntegrationFailure`/`notifyOps` の失敗を個別catchすると削除継続性は守れるが、肝心のoverdue alertが失われる。
   - 記帳失敗を必ず構造化error logへ残す、lane summaryへ反映する、HTTP結果を劣化扱いにする等の二次観測経路が必要。

7. **GETによる破壊操作**
   - Bearer認証下でも、GETはキャッシュ、prefetch、監視ツールの再送、手動リプレイの対象になりやすい。
   - `Cache-Control: no-store`、動的routeの明示、CDNキャッシュ非対象の確認が必要。
   - duplicate-safeでも、override付きGETの意図しない再送は15分超objectを繰り返し走査・削除する。

8. **cutoff overrideの環境境界**
   - 「手動GET限定」はHTTP上の制約になっておらず、同じsecretを持つ者はproductionでも15分cutoffを指定できる。
   - staging限定にするか、productionで許容する運用権限として明記するか、別secret/明示的環境gateを設けるかが必要。

9. **DB query量とtenant transactionコスト**
   - 最大10,000 keyが多数userに分散すると、userごとに`withTenantTx`を張るN+1処理になる。
   - 270秒内での処理能力、DB pool枯渇、RLS/transaction setupコスト、同時手動実行時の負荷を見積もる必要がある。
   - user処理順が固定なら、deadline時の後半user starvationも起こりうる。

10. **失敗行のquota配分**
    - delete失敗、pattern mismatch、overdue、incompleteが同じ20行枠をどう共有するかが曖昧。
    - pattern mismatchが大量にあると、実DELETE失敗やoverdueを抑圧する可能性がある。
    - incomplete用だけでなく、overdue用の予約、failure種別ごとの上限、優先順位が必要。

11. **pattern mismatchのfailure分類**
    - DELETE未試行なのに `service=r2 / operation=object.delete / failureCode=external_api_error` とするのは、実際の外部API失敗と意味が異なる。
    - 集計・通知・SLOで誤分類されないか検討が必要。少なくとも集計側は`reason`必須で区別する必要がある。

12. **XML/日時parseの契約**
    - `<Contents>`単位というだけでなく、XML namespace、entity decode、空Key、重複タグ、malformed XML、Date.parseの過剰許容、timezone欠落をどう扱うかが必要。
    - 「ISO文字列」の具体的形式を固定しないとruntime差や曖昧日時を受け入れうる。
    - 1件のmetadata不良でpage全体を停止する方針は安全だが、その不良objectが毎回sweep全体を停止させる恒久障害にもなる。

13. **live判定の前提検証**
    - `isLiveUploadOperationCondition()`がuser scope、lease期限、operation状態を意図どおり包含することをテストで固定する必要がある。
    - platform遅延やDB更新遅延を含めても「src最終GETは必ずlease内」という保証が成立するか確認が必要。
    - DB障害時skipは安全だが、連続障害時には保持期限保証を失う。

14. **summary/errorの意味**
    - laneが内部catchして200を返す設計では、listing全失敗でもscheduler/API上は成功に見える。
    - `phase`, `error`, `failed`, `remaining`, HTTP statusのどれを運用上の成功判定に使うかを定義すべき。
    - 将来複数laneになった際、部分失敗を200にするのか207相当とするのかも必要。

15. **PII・ログ安全性**
    - catalog contextの制限だけでなく、`summary.error`や`logger.error`へDB/R2の生エラー、署名付きURL、レスポンス本文等が流れない保証が必要。
    - API responseに内部error詳細を返す場合も、認証済みとはいえ情報露出範囲を決める必要がある。

16. **運用前提の未確定事項**
    - Vercel planで`maxDuration=300`が有効か、stagingが別projectのproduction deploymentかは、実装後ではなく配線・安全性に影響する前提条件。
    - stgのcron自動発火可能性とsecret設定順序は、デプロイ前gateとして扱う必要がある。

## plan ドラフトへの抜け・未考慮指摘

1. **pagination starvationのテスト・対策がない**
   - Task 1はpagination機構のみ、Task 4はtruncated記録のみで、「毎回同じ先頭10ページになる」問題を扱っていない。
   - 「翌日retry」を完了性の根拠にするテストも成立しない。

2. **overdueが全prefix監視ではない点を扱っていない**
   - Task 3のoldest選定は渡されたentries内だけ。
   - `truncated=true`時にoverdue count/oldestを部分観測として表示する、または監視不完全を別phase/alertにする設計がない。

3. **同一key overwrite競合のテストがない**
   - LIST→live check→DELETEの間に同じkeyのLastModifiedが更新されるケースが未考慮。
   - DELETE前HEADをしない方針なら、同一key再PUTが不可能というコード上の証明・回帰テストが必要。

4. **user処理順と公平性が未定義**
   - `Map`挿入順のまま処理すると、常に後半userがdeadlineで打ち切られうる。
   - 大量user、先頭userのlive-check遅延、複数日継続時のテストがない。

5. **failure row quotaの正確な仕様がない**
   - Task 4のheldFailureはincompleteの1枠だけを示し、overdueとpattern mismatchと実DELETE失敗の優先順位がない。
   - overdue記帳失敗やquota抑圧がsummaryへどう反映されるかも未定義。

6. **runnerとlaneのthrow契約が二重**
   - specは「laneはthrowしない」、Task 5は「stub laneがthrowしてrunnerがerror summary化」としている。
   - 防御的catch自体は妥当だが、生成するsummaryの必須field、lane名、phase、ログ形式が定義されていない。

7. **listing失敗時のincomplete記帳が曖昧**
   - Task 4の大域catchだけでは、`phase='list'`のincomplete行を最後に残せるか不明。
   - selection前に失敗した場合の各summary値、`truncated`、`remaining`も決まっていない。

8. **auth/override評価順が未指定**
   - 認証前にquery validationするか、認証後にするかが未定義。
   - 通常は認証を先に行い、未認証callerへparameter validation差を返さない方が単純。

9. **GETの非キャッシュ化がない**
   - route taskに`no-store` response/cache設定やroute動的化の確認がない。

10. **production overrideの安全策がない**
    - `cutoffMinutes=15`をproductionでも受理する実装になっているが、planに環境制限・運用警告・監査ログの判断がない。

11. **記帳失敗の観測テストが不足**
    - 「後続DELETEが止まらない」だけで、記帳失敗がlogger/summaryに確実に残ることをテストしていない。
    - overdue通知経路が壊れた場合にsilentになる。

12. **XML parserの異常系が不足**
    - namespace、escaped key、空Key、malformed block、重複LastModified、timezoneなし日時等がTask 1にない。
    - 「非ISO」の判定方法も未定義。

13. **保持上限の前提を検証するテスト/文書化がない**
    - docs Task 6がworst 55hを実装済み事実として記述しうるが、starvation、複数skip、cron欠落を除外した条件付き値であることを明記する条件がない。

14. **cron dead-man監視がplan外**
    - Vercel logsしか成功履歴がなく、scheduler未発火を自動検知できない。
    - 「実発火検証がclose条件外」でも、恒久運用監視の設計論点は残る。

15. **性能・負荷テストがない**
    - 10ページ、10,000 key、多数user、DB N+1、chunk delete、duplicate runの負荷を検証するテストまたは計測gateがない。

16. **Vercel plan/stg形態の確認が実装後に送られている**
    - `maxDuration=300`の可否やstg cron発火範囲はroute配線の成立性・sentinel安全性に直結するため、Task 5前の前提gateが適切。

17. **既存設定とのmerge検証が弱い**
    - `vercel.json`へcronsを追加する際、既存regions/functions/maxDuration設定を保持する構造テストがない。
    - JSON schema/デプロイ設定検証もbuildだけでは検出できない可能性がある。

18. **UUID規則の根拠をテストで固定していない**
    - userId、uploadSessionId、fileIdの全てが小文字UUIDv4であることを生成側との契約テストにすべき。
    - regex単体テストだけでは生成規約変更時に合法objectを永久skipする。

## リスク / 対立しうる設計判断

- **安全性 vs 完了性**  
  age不明、pattern mismatch、DB判定不能をskipするのは削除安全性に寄与するが、恒久残存とprefix starvationを引き起こす。安全側に倒すなら、別のquarantine/diagnostic laneや巡回性が必要。

- **台帳なしretry vs 公平な走査**  
  永続object台帳は不要でも、pagination cursorまで持たない判断は別問題。完全statelessを優先すると、bounded listingの完了性を保証できない。

- **DELETE前HEAD vs APIコスト**  
  HEADを省けば高速だが、同一key overwrite競合を防げない。HEADを追加してもHEAD後overwriteのTOCTOUは残るため、条件付きDELETEやkey不変性の保証との比較が必要。

- **user単位live check vs DB負荷**  
  user単位除外は安全でschema変更不要だが、多数user時にtransaction数が支配的になる。bulk判定は効率的だがtenant/RLS境界を複雑化する。

- **partial observation alert vs 正本監視**  
  bounded scanのalertは安価だが、全prefixのretention保証を証明できない。「正本」と呼ぶなら全域巡回または別のinventory/metricsが必要。

- **200 partial failure vs 運用可用性**
  他lane継続のため200を返す設計と、scheduler/外部監視に失敗を認識させる設計が対立する。HTTP結果とlane単位結果を分離して運用定義する必要がある。

- **15分overrideの利便性 vs production破壊半径**
  smokeは容易になるが、secret誤用時の保持policyを6hから15分へ変更できる強い操作になる。staging限定、別credential、production無効化のいずれかを検討すべき。

- **失敗イベントの詳細度 vs alert flood**
  object単位記録は調査しやすい一方、pattern mismatchや継続障害で毎日大量通知・quota消費が起こる。集約行とサンプルkey方式も比較対象になる。

- **55hという明快な数値 vs 実態の条件依存性**
  運用説明には有用だが、hard upper boundとして扱うと誤解を生む。正常時目標、条件付きworst、保証不能条件を分離して記述すべき。