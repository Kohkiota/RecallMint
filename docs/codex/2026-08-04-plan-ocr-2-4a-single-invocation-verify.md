# Codex plan cross-check — ocr-2-4a-single-invocation-verify (2026-08-04)

- **作成日**: 2026-08-04
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. `after()` 登録と初期 TX commit の間に原子性がない  
   op/doc を `processing` で commit した後、callback 登録前に例外・プロセス終了が起きる窓がある。reconciler で最終収束できても、登録失敗を同期側で検知できる場合は即 terminal 化すべきである。登録順序、登録 API 自体の throw、応答シリアライズ失敗時の扱いを定義する必要がある。

2. reconciler の「時間保証」と駆動方式が一致していない  
   status API 呼出時だけ reconciler が動くなら、タブを閉じ、誰も一覧を開かなければ失効検知されない。「lease 失効 ≤15分 + sweep 周期で収束」は定期実行基盤がある場合だけ成立する。正確には「次回 status API 呼出時に収束」であり、時間上限は保証できない。

3. lease TTL の安全性は duration だけでは決まらない  
   必要なのは次の時刻関係である。

   `pipeline deadline + terminal化/DB retry/ログ記録の最悪時間 < lease TTL`

   maxDuration と pipeline budget の差だけでなく、sync TX 時間、queueing、DB遅延、時計基準（PG時刻とJS時刻）、終了処理の余白も含める必要がある。生存中に lease が失効すると、次 submit が supersede し、二つの invocation が並走しうる。

4. `after()` closureでBufferが確実に保持されることへの依存  
   request終了後もBufferを参照可能というプログラム上の前提に加え、ランタイムの凍結・再開、メモリ圧迫、Fluid compute設定、デプロイ切替時の終了条件に依存する。公式に保証される範囲と、staging実測でしか保証できない範囲を分けるべきである。

5. メモリ見積りが楽観的  
   peakには原本、base64文字列、SDK内部コピー、Gemini応答文字列とparse後object、sharpのdecode領域、crop出力Buffer、R2 SDKの送信Bufferが重なる可能性がある。40MPならsharpだけで約160MBだが、libvips内部領域や複数コピーは含まれない。Vercelの実メモリ割当もDashboard確認事項に含める必要がある。

6. 逐次decodeだけでは逐次メモリ解放を保証しない  
   `await`が逐次でも、配列にmetadata・sharp結果・crop Bufferを保持すればpeakは累積する。各反復後に大容量参照を残さないこと、crop結果を全件メモリ保持せず即永続化することも実装不変条件になる。

7. multipart overheadとbody limitの境界  
   4MBのファイル合計に対しbodySizeLimit 4.5MBだが、40ファイル分のmultipart header、filename、宛先、idempotency keyを含む。許容できる余白か境界試験が必要。またフレームワークによるbody拒否はaction内の`invalid_input`へ到達しないため、ユーザーに見えるエラー経路を区別する必要がある。

8. destination認可の維持  
   `destination='existing'`では対象examのtenant所有確認、削除済みexam、別ユーザーIDの注入を新TXでも防ぐ必要がある。advisory lock、idempotency replay、返却するexam/docのすべてが現在ユーザーに束縛される必要がある。

9. idempotency keyと入力内容の対応  
   同じkeyで異なるfiles/destinationが送られた場合に既存opを無条件replayすると、クライアントは今回の入力とは異なる処理IDを受け取る。keyに入力fingerprintを保存しない設計なら、「同一key・異入力は拒否」か「同一keyは結果だけが権威」とする契約を明示すべきである。

10. replay時のレスポンス意味論  
    completed、terminal_failed、processing、superseded相当をすべて`accepted`として返すと、同期S-3とpolling S-4で挙動が異なり得る。特にterminal opを返した直後に、clientがどの状態・文言へ遷移するかを定義する必要がある。

11. source順序とGemini出力の対応契約  
    server採番が受領順でも、decode失敗要素を除外するか、全体失敗にするかでsource_id対応が変わる。Geminiへ渡したparts順、prepared payloadのsource_id、crop対象Buffer indexが一意に対応する不変条件が必要。

12. crop phaseの部分成功時の整合性  
    共通例外までtext publishへ縮退するなら、例外発生前に作成済みのreserved/ready asset、R2 object、asset_derivationを採用するのか除外するのかを決める必要がある。「残りをcrop_failed」にするだけでは、既処理分の状態が曖昧になる。

13. publish失敗・hard-death時のcrop資産回収  
    prepared後にR2 PUTし、publish前に死亡するとrefなしassetが残る。既存GCが新しい行状態・新しい作成経路を確実に回収するか、TTL、tenant条件、R2 delete失敗時の再試行まで確認が必要である。

14. 「sourceをR2に置かない」の証明条件  
    `src/`を含まないことだけでは不十分で、別prefixにsource相当をPUTするバグを検出できない。全PUTがDB上のcrop-derived asset IDと対応し、content type/寸法がcrop出力であり、prepared commit前のPUTが0件であることが強い証明になる。

15. prepared checkpointとterminal化の競合  
    payload commit、crop、publish、reconciler、ユーザー削除が競合する。各CASの期待status、CAS 0件を「削除」「失効・supersede」「二重実行」のどれとして扱うかを区別しないと、必要な障害通知を静かに捨てる可能性がある。

16. status APIのtenant分離とレスポンス肥大  
    `docStatuses`は要求ユーザーが所有するdocだけに限定する必要がある。全docをmapで返す設計なら、長期利用時のレスポンスサイズも検討対象になる。poll対象IDだけを問い合わせる方式との比較が必要。

17. completedの定義  
    doc `completed`、op `completed`、publish TX commitが同時に成立する必要がある。docだけ先にcompletedになるとresult routeが空になる。pollがnavigation可能と判断する単一のcommit境界を明示すべきである。

18. 観測性不足  
    hard-deathはcatchできないため、`started_at`、phase、prepared時刻、終了時刻、lease失効回収件数、処理時間、crop exclusion件数などがないと、720/660秒の妥当性を実測できない。PIIを保存せず、運用判断に必要な指標を残す設計が必要。

19. migration/deployの互換窓  
    nullable化、UI切替、旧経路削除、table dropの間に旧・新server instanceが混在する可能性がある。S-5 migration適用中に旧instanceや実行中旧invocationが`source_assets`へ触れないことを保証するデプロイ順序・drain条件が必要である。

20. 破壊的R2一掃の所有範囲  
    prefix regexだけでなく、対象environment/account/bucket、pagination cursor、削除件数上限、再実行可能性、一覧と削除の間に新規作成されないことを確認すべきである。

## plan ドラフトへの抜け・未考慮指摘

1. S-4はcallback内部throwを扱っているが、`after()`登録そのものが失敗した場合の同期側terminal化がない。reconciler任せにするなら、その遅延と駆動条件を明記すべき。

2. 「callback不実行窓もreconcilerで保証」は過大表現。reconcilerがstatus API駆動のみなら、無アクセス時の収束時間は保証されない。定期cronを設けないなら文言修正が必要。

3. maxDuration pinは静的値のdriftしか検出しない。実Dashboard設定、実メモリ、Fluid compute、デプロイ先ごとのduration overrideは検出できない。S-4 gateにメモリ割当も追加すべき。

4. lease pin式がpipeline終了処理の余白を表現していない。660秒pipeline budget後のpublish/terminal化が予算内か、予算超過時にもlease内で確実にterminal化できるかが未定義。

5. S-2の逐次decode testは並列化を検出できるが、大容量Bufferの累積保持やSDK内部コピーは検出できない。upper-scale memory計測またはpeak RSSのstaging観測が必要。

6. S-1の入力境界試験に「4MB files + multipart overheadで4.5MB超過」と、actionへ到達しないbody-size拒否のUX試験がない。

7. S-1のidempotency replayが状態不問・入力不問。異なるdestination/filesで同じkeyが来た場合の契約とtestがない。

8. S-1でexisting destinationの所有権・削除競合・他tenant ID注入のnegative testが明記されていない。

9. S-2でdecode途中の1枚失敗時に全体terminalとするのか、その画像だけ除外するのかが不明。source_idとBuffer対応を保証するtestも不足。

10. S-3の「crop phase共通例外」試験は、例外発生前に一部crop成功済みのケースを扱っていない。成功済みassetをpublishするか除外するか、reserved行とR2 objectの最終状態を検証すべき。

11. S-3のR2証明がkey文字列依存に偏っている。全PUTがcrop asset行に対応すること、sourceと同寸法・同内容の誤PUTがないこと、prepared commit前PUT 0件も検査対象にすべき。

12. S-3の同期UI切替は、S-4まで長時間同期actionをユーザー経路に露出する。ブラウザ・CDN・Server Action transportのtimeoutや再送を受ける中間状態であり、別々にdeployするならリスクが高い。feature flag、同一release内切替、staging限定などの安全策がない。

13. S-4の開始CASはGemini前の削除競合を減らすだけで、その後の削除・supersede競合を区別できない。各CAS 0件の扱いと、どのケースでintegration failureを抑制するかが不足。

14. S-4の`docStatuses`にtenant isolation、未知ID、削除済みdoc、複数docを持つexam、レスポンスサイズのtestがない。

15. S-4のpoll 20分停止後、処理が21分目にcompletedになった場合の再発見導線が一覧badgeだけに依存する。reload復元をscope外にする判断は可能だが、upload page上で永久に古い表示を残さない条件は必要。

16. S-4の公開文言は`failed`と`in_progress`を同趣旨にしているが、確定失敗と正常処理中を混同する。ユーザーが再試行すべき時点が曖昧になる。

17. S-4のintegration failure testは、terminal化TX自体が失敗し、さらにfailure recordも失敗する二段障害を十分扱っていない。少なくともlogger.error発火のtestまたは運用確認が必要。

18. S-5にデプロイ中の旧instance・旧invocation drain確認がない。staging smoke passだけでは、table drop時に旧コードが残っていない証明にならない。

19. S-5のgrep許容残に生成物、SQL view/function、運用query、外部dashboardが含まれない。DB catalogではFK、index、policy、function dependencyも確認した方がよい。

20. S-5のR2削除scriptにbucket/environmentの誤選択防止、削除件数の上限確認、cutover後にsource PUTが増えていないことの直前再確認が明記されていない。

21. 実測後に時間予算を見直すとしているが、何を測るか、合格基準、40枚試験、p95/p99、Gemini遅延・429時をどう評価するかがない。

22. planの完了gateはテスト中心で、運用観測の成立条件が弱い。hard-death件数、stale回収件数、phase別時間、memory peakを確認できなければ、非スコープとした上限値の後日決定が困難。

## リスク / 対立しうる設計判断

- 定期reconcilerを設けるか  
  status API駆動は追加基盤不要だが、無アクセス時の収束時間を保証できない。cronは保証を強める一方、運用対象が増える。

- S-3で同期UIへ切り替えるか  
  diff分離と段階検証には有利だが、一時的に長時間同期経路を公開する。UI切替をfeature flag化するか、S-4と同一deployにまとめる選択肢がある。

- leaseを固定TTLにするかheartbeatを導入するか  
  固定TTLは単純だが、設定driftや遅延で生存中失効が起こる。heartbeatは堅牢性を上げる一方、DB更新・停止判定・回復ロジックが複雑になる。

- idempotency replayを無条件にするか入力fingerprintを持つか  
  無条件replayは実装が単純。fingerprintは異入力事故を検出できるが、sourceを永続化しない前提でhashをどこまで保持するかというプライバシー・schema判断が発生する。

- crop共通例外を常にtext publishへ縮退するか  
  OCR成果を守れる反面、コード不変条件違反やDB/R2整合性バグまで「図版失敗」として隠す危険がある。予期されるcrop失敗と、構造的unexpected errorを分けて後者はterminalにする案もある。

- prepared_payloadをterminal時に消すか  
  PII最小化には有利だが、hard-deathやcrop障害のforensicsを失う。短いTTLで隔離保持する案とのトレードオフがある。

- source_assetsを即dropするか一段階残すか  
  dropは新しい設計意図を明確にする。一方、混在deployやrollbackは難しくなる。実ユーザー0でも、実行中instanceとstaging運用上の互換窓は別問題である。

- poll応答を全doc mapにするか対象ID queryにするか  
  additive mapは既存APIへ載せやすいが、長期的にレスポンスが増える。対象sourceDocumentIdを指定するAPIは効率的だがendpoint契約が増える。

- source非保持を絶対条件にするか、暗号化短期保持を障害回復用に認めるか  
  現要件では絶対非保持であり、hard-death後の再開不能・Gemini再課金を受容する設計になる。この運用上の帰結は変更不能な制約として明示しておくべきである。