# Codex plan cross-check — dash1-home-v1-plan (2026-08-18)

- **作成日**: 2026-08-18
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. `first_reviewed_at` の「一度だけ」がDB更新契約でも保証されるか  
   replay の pure ロジックだけでは不十分です。並行 flush、古い初期状態を読んだ複数トランザクション、再試行により後着処理が既存値を上書きしないよう、`UPDATE` 側でも `COALESCE(existing, incoming)` 相当、または行ロック下の条件更新が必要です。14→15列への単純追加では不変性を保証できません。

2. `applyCardFinalStates` の null 上書き危険  
   旧状態や一部経路が `firstReviewedAt: null` を渡した際、既に設定済みのDB値を nullへ戻さない契約が必要です。全VALUES列を一律代入する既存方式なら特に重要です。

3. card fold の全書込経路の網羅  
   `replayCard` 以外にカード状態を初期化・再構築・import・管理更新する経路がないか確認が必要です。stateだけ非0になり `first_reviewed_at` がnullの新規行を将来作れると、K計算が壊れます。

4. pull契約の完全な伝播  
   mapperとTypeScript型だけでなく、cards/exams pullのSELECT列、レスポンスschema、fixture、serialization、bulkPut前の変換に新列が通る必要があります。explicit mapperの上流も確認対象です。

5. soft limit の競合範囲  
   複数端末だけでなく、同一端末の複数タブ、flush失敗、pull-back失敗、直後の再セッションでもK超過が継続します。「収束後」の条件と、収束しないオフライン状態でのUXを明示すべきです。

6. K設定変更の反映遅延  
   server action成功後、mirrorへ反映されるまでHomeとセッション選定は旧Kを使います。action後に明示pullするのか、次回mountまで待つのか、UI上の保存成功表示と実効値の関係が未定です。

7. `daily_new_target` の入力意味論  
   空欄をnullにする操作、0と未設定の識別、整数化、小数・指数表記・巨大値、IME入力中、楽観表示、保存失敗時の復元を決める必要があります。DBには上限がなく、極端な値による走査・表示負荷も検討対象です。

8. `first_reviewed_at` の不変性とカード移動の組合せ  
   過去日に導入されたカードを今日別試験へ移しても今日の枠は消費しません。一方、今日導入したカードは移動先の枠を消費します。この非対称性は「現在状態意味論」だけでは利用者に予測しづらい挙動です。

9. 選択試験resolverの副作用・競合  
   URL更新、sync_meta保存、Dexie変更通知、再resolverが循環しない設計が必要です。古い非同期resolve結果が新しいURL選択を上書きしないよう、世代管理または現在値再確認も必要です。

10. settleシグナルのスコープ  
    シグナルは少なくともuser単位・認証セッション単位でリセットされる必要があります。sign-out/sign-in、layout再mount、pull再試行、Strict Modeの二重effectで前ユーザーのsettled状態を引き継がない保証が必要です。

11. pull失敗＋空mirrorの誤認  
    要件上は失敗でもsettledとしてmirrorを採用しますが、初回利用かつオフラインでは「試験0」と断定してupload heroを出します。「本当に0」と「取得不能」を区別しないことによる誤誘導は明示的な製品リスクです。

12. URL正規化の境界  
    重複`exam`パラメータ、空文字、percent encoding不正、配列形式、大小文字、fragment、billing等の既存param保持を定義する必要があります。無効URL除去時にも無関係なparam順序・値を壊さないことが必要です。

13. `origin` の入力信頼境界  
    `/smart?origin=...`をそのまま採用すると、bookmarkや手入力で`home_today`を偽装できます。smartでは`home_today`または`smart`への正規化、quickではpreset/tagからoriginを導出し、queryのoriginを信頼しない契約が必要です。

14. origin観測ログの安全性  
    未知の受信値そのものをwarnへ載せる設計は、ログ注入・高カーディナリティ・ユーザー生成文字列混入のリスクがあります。長さ制限後の構造化フィールド化、改行処理、値のハッシュ化または件数のみの記録を検討すべきです。

15. origin正規化ログの大量発生  
    新clientと古いserverの共存は安全でも、壊れたclientが大量送信すると回答ごとにwarnが発生し得ます。batchにつき1件、未知値ごとの集約、rate limitなどの観測契約が必要です。

16. quick routeの不正入力  
    不明preset、tagなしのタグorigin、他試験のtag、削除済みtag、他ownerのexam、母集合0、session cap=0、N算出不能をどう処理するか未定です。空セッションを起動せず、戻り先と表示を決める必要があります。

17. tag母集合の所有・試験整合性  
    `tag=<option_id>`だけで選ぶ場合、optionが選択試験に属すること、card_tags経由でowner/exam scopeが強制されることが必要です。URL値を直接条件にするだけでは越境選択の余地があります。

18. smartのclient/server fallback同値性  
    shared関数だけでなく、入力スナップショット、時刻、JST境界、nullの順序、`base_order`の型、session limit、u/Kの取得時点を一致させる必要があります。server側がmirrorと異なる鮮度なら、同じ関数でも結果は一致しません。

19. `base_order` のnull・重複・跨教材意味論  
    comparator再利用だけでは、null値、同値時のUUID比較、異なる教材間の優先順が仕様どおりか不明です。DBとJavaScriptのnull orderingも固定する必要があります。

20. W2表示量と実際の開始可能量の乖離  
    Learning/Relearningの未到来分だけでなく、mirror遅延、session cap、soft limit超過、pull-back失敗でも表示とプールがずれます。「学習を始める」を押して0件になる経路を防ぐ必要があります。

21. 共有`useLiveQuery`の依存関係  
    選択試験変更時にcards集計が確実に再実行されることが必要です。N標本を`[userId]`だけに依存させる設計は、Nが試験別なら試験切替で古い推定を使います。全試験共通なら、その意味を明文化すべきです。

22. N標本とanswer_eventsの試験対応  
    answer_eventsにexam_idがない場合、現在カードとのJOIN、削除カード、試験移動カードをどの試験の標本として扱うかが必要です。最大1,000行をどのindex・順序で読むかも性能と結果を左右します。

23. summary SQLの性能  
    全期間の全applied eventにcard別rankを振ってから30日を切る処理は、データ増加時に高価です。Dash-3のindex追加を非スコープにしても、W4を本番提供する以上、既存index確認と`EXPLAIN`による上限評価が必要です。

24. summaryの評価時刻整合  
    handlerの`receivedAt`とHome rootの固定`now`は別時刻です。日跨ぎ付近ではW2/W6とW4の「今日」が異なる可能性があります。許容するなら明示が必要です。

25. summary応答のruntime検証  
    owner/exam echoだけでなく、配列要素、数値範囲、null、重複option_idをclientで検証するかが未定です。不正応答を候補0と混同せずfetch failureとして扱う必要があります。

26. W4 fetch lifecycle  
    試験切替時の遅着破棄に加え、AbortController、unmount後更新、同一試験への切替戻し、Strict Mode二重fetchを考慮すべきです。

27. W7の61日表示と90日snapshot  
    現在は足りますが、snapshot欠損日、未来日、重複、部分pull失敗、ユーザーtimezoneではなくJST固定であることを表記・テストする必要があります。

28. 日跨ぎ時に全表示が古い  
    mount時now固定により、開いたままの日跨ぎではW2、W6、W7、K残枠が前日のままです。「既存受容」でも、長時間開きやすいHomeでの影響範囲は明示すべきです。

29. アクセシビリティは色以外にも必要  
    dropdownのkeyboard操作、disabled理由、fetch errorの通知、skeletonの`aria-busy`、バーグラフのテキスト代替、フォーカス遷移、タップ領域、見出し階層が受け入れ基準に必要です。

30. API削除の互換性確認  
    repo内callerゼロだけではbookmark、監視、手動運用、別リポジトリ利用を否定できません。削除前のOT確認が仕様上の必須条件であり、実装開始前のgateとして扱うべきです。

31. migrationの運用  
    Drizzleのjournal/snapshot等、repo固有のmigration metadata更新、既存0036〜0039との通し適用、空DBと既存DBの両方、CHECK名衝突、down/復旧手順を確認する必要があります。

32. 3列を一本にした障害半径  
    originだけの問題でもdaily-new-targetとfirst_reviewed_atを含むmigration全体が止まります。「個別rollbackの実益なし」と、デプロイ時の障害分離は別問題です。

## plan ドラフトへの抜け・未考慮指摘

- Task 1に、pullのSELECT・wire response schema・migration metadataの追随が明記されていません。mapper追加だけでは新列がmirrorへ届く保証になりません。
- Task 3に、DB更新時の既存`first_reviewed_at`保護、並行fold、null上書き防止の試験がありません。「初回のみ」の逐次テストだけでは契約を証明できません。
- Task 3は`applyCardFinalStates`の列追加しか挙げておらず、行ロックや条件更新を含むrepositoryの同時実行契約を扱っていません。
- Task 4の完了条件に、要求されている`review_events.bulk.origin_normalized`のログ名・件数・非機密内容を検証するテストがありません。
- Task 4はUI props chainを扱いますが、query由来originの許可規則がありません。任意値による成功指標の汚染を防げません。
- Task 5はsettleシグナルのuser切替時リセット、失敗理由、再試行、Strict Mode、layout remountのテストを欠いています。
- Task 5のresolverを「共通」としつつ、RSCのsmart/quickからclient helperをどう利用するか、router副作用をpure resolutionからどう分離するかが不明です。
- Task 6の同値性pinは「同一fixture」だけで、同一評価時刻・同一DB snapshot・null ordering・鮮度差を固定していません。
- Task 6に、他owner exam、削除済みexam、URL切替中の古い結果を拒否するテストがありません。
- Task 6に、プール表示上は対象ありだが実際の開始可能カードが0になる場合のUXがありません。
- Task 7に、不正preset、他owner tag、別試験tag、削除済みtag、母集合0、cap=0、N欠損時の挙動がありません。
- Task 7は「preset別母集合」とだけあり、間違い・苦手のdue順、未出題のbase_order順、同率決定性を十分にpinしていません。
- Task 8に、実データ量を想定したSQL plan・既存index確認・query count/timeoutの検証がありません。
- Task 8のroute unitは500、Cache-Control、owner echo不一致、DB例外、method違いの契約を欠いています。
- Task 8にreview_accuracyの丸め境界、重複タグ付け、名称変更、applied=false、session_id null、同一時刻event_id順の網羅が明確ではありません。
- Task 9に、保存後のmirror再取得方針と、設定直後にHome/Smartへ移動した場合の実効Kがありません。
- Task 9にnullへ戻すUI、小数・巨大値・空欄・保存失敗・連打競合のテストがありません。
- Task 10の「目視」だけではWCAG AAを完了条件として再現可能に検証できません。色値のコントラスト計算または自動a11y検査が必要です。
- Task 10が要求する`frontend-design` skillは、提示された利用可能skill一覧には存在しません。実行環境で利用可能かを開始前に確認し、なければ停止または代替手順を決める必要があります。
- plan冒頭で必須とする`superpowers:subagent-driven-development`も、提示された利用可能skill一覧に存在しません。実行不能な必須条件になっている可能性があります。
- Task 11に、共有集計が「試験切替で再評価されること」とN標本の試験スコープを検証するテストがありません。
- Task 11に、W4のAbort、遅着応答、runtime schema不正、同一試験再選択のテストがありません。
- Task 11の空状態テストに「pull失敗＋空mirror」「認証ユーザー切替」「選択exam削除中」のケースがありません。
- Task 11にW1 dropdownのkeyboard/focus、W6テキスト代替、loading/errorのaria属性がありません。
- Task 11で旧component testを撤去しますが、BillingBannerとプラン変更リンクの維持をpinする置換テストが明記されていません。
- Task 12は仕様で必須の「外部利用の有無をOTに1行確認」を完了条件に含めていません。grepだけで削除へ進めてしまいます。
- Task 12を`[no-review]`とするのは、外部互換性を壊し得るAPI削除のリスクと釣り合いません。少なくとも削除対象・caller確認・OT確認のレビューが必要です。
- Task 13のsmokeに、Learning/Relearning未到来除外、Review later-due包含、K=0、pull失敗、複数試験、他owner防御、dark theme、keyboard操作がありません。
- deploy順を検証するtaskがありません。旧code＋新schema、新code＋旧client、未適用0036〜0040の連続適用をstagingで確認すべきです。
- rollback/forward-fix判断、migration適用済みでcode deployに失敗した場合の運用がありません。
- frozen specとの齟齬検出を各task任せにしており、最終的なspec節→実装→testのトレーサビリティ確認がありません。

## リスク / 対立しうる設計判断

- **分析上の単純さ vs 利用者の期待**  
  現存カード基準のuは実装が単純ですが、「今日導入した累計」という通常の理解とは異なります。削除・移動で枠が変動するため、将来hard limitへ移行すると意味論の互換性が問題になります。

- **回答全受理 vs Kの信頼性**  
  soft limitは同期可用性を守りますが、「1日K問」という設定名から受ける保証より弱いです。UI文言を「目安」「新規出題の上限目標」等にするかが設計判断です。

- **不変性 vs 歴史的正確性**  
  `first_reviewed_at`の先着固定は安定しますが、遅延到着イベントにより実際の初回日と異なる値が永久に残ります。K制御用の運用時刻と、分析用の史実時刻を同じ列に担わせる将来リスクがあります。

- **mirror一貫性 vs 即時性**  
  server snapshotだけを表示する方針は端末間意味論を単純化しますが、回答直後のHomeが古く見え、同じカードを再選択し得ます。信頼感を損なう可能性があります。

- **URLを正とする設計 vs 端末ローカル保存**  
  deep linkには強い一方、別タブ変更は現在タブへ反映されません。これを受容するなら、dropdown表示とURLの一貫性を最優先に保つ必要があります。

- **全期間rank SQLの正確性 vs 性能**  
  復習判定は正確ですが、履歴増大に対して高価です。index追加をDash-3へ送る判断と、W4をDash-1で常時fetchする判断が衝突し得ます。

- **固定nowによる内部整合性 vs 日跨ぎ鮮度**  
  1回の描画内では整合しますが、長時間開いた画面は誤った日付状態を維持します。再訪前提がHome利用実態に合うか確認が必要です。

- **originの可用性優先 vs 計測品質**  
  未知値null化は同期停止を防ぎますが、計測欠損や偽装を静かに受け入れます。originを分析ラベルに限定し、課金・実験割当・権限制御には使わない制約が必要です。

- **一本migrationの簡潔さ vs 障害分離**  
  適用は簡潔ですが、独立した三機能が同時に失敗・延期します。特に回答ingestへ触れるoriginと、表示設定列を同時展開する必要性は再評価余地があります。

- **dead route整理 vs 後方互換性**  
  repo内callerゼロは削除の強い根拠ですが、外部利用を技術的に証明できません。OT確認前の削除は不可逆ではなくても運用障害を起こし得ます。

- **大規模一括Home刷新 vs 段階的検証**  
  migration、fold、同期、選定、API、UIを同一sprintで変更するため、障害原因の切り分けが難しくなります。feature flagや段階的有効化を使わない判断には、staging smoke以上の観測・切戻し策が必要です。