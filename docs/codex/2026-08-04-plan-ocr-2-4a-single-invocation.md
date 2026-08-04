# Codex plan cross-check — ocr-2-4a-single-invocation (2026-08-04)

- **作成日**: 2026-08-04
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. `after()` に渡すデータの所有権・寿命

- `File[]` や request body をそのまま closure に保持せず、応答前に全ファイルを独立した `Buffer` に実体化する必要がある。
- `after()` 登録前後、tx commit 後、HTTP 応答の serialization 失敗時など、「DB 行は作成済みだが callback が登録・開始されない」窓がある。この場合も lease/reconciler で必ず終端化されることを明記すべき。
- callback 開始時に op/doc がまだ存在し、自分の `lease_version` を保持していることを確認する開始 CAS が必要。exam 削除済みなら Gemini 呼出前に終了するのが望ましい。

2. 冪等 key のライフサイクル

- 同一 key の replay が「既存 op を返して再スケジュールしない」だけでは、hard-death した非終端 opへの replayが新処理を永久に開始できない可能性がある。
- 少なくとも次を状態別に決める必要がある。

  - `processing/prepared` + valid lease: 既存 ID を返す。
  - 非終端 + expired lease: stale op を返すのか、新 key を要求するのか、同一 key で新 generation を作るのか。
  - `terminal_failed`: 同一失敗を replay するのか、再試行を許すのか。
  - `completed`: completed ID を返す。
- 「画像を選び直すと必ず新しい key が発行される」という client 契約に依存するなら、transport retry とユーザー再試行を区別する key 発行規則が必要。

3. 状態機械と fencing の厳密化

- 各遷移の許可元、lease 条件、lease の NULL 化、payload の処理を表に固定すべき。

  - `processing → prepared`
  - `prepared → completed`
  - `processing|prepared → terminal_failed`
  - 行削除による正常中断
- publish の二重作成防止は、最後の op UPDATEだけでなく、カード作成を含む同一 tx の冒頭で fencing を取得・確認できなければならない。
- reconciler と実行中 callback が競合した場合、期限切れ lease の callback が publish を継続できないことも必要。
- `prepared_payload` の「1回保存」は、CAS 失敗時や pipeline 二重起動時にも成立する必要がある。

4. 「crop 失敗でも text publish」の失敗境界

- 予期しない crop 例外まで全体の `terminal_failed` に落とすと、「crop が OCR 成果を巻き添えにしない」という要件を満たさない。
- 次を分離する必要がある。

  - 個別 figure の decode/sharp/R2失敗: exclusion にして継続。
  - crop phase の共通処理失敗: 残りを適切な exclusion として text publishへ進む。
  - DB接続断、payload破損、publish tx失敗: terminal failure。
- crop phase 全体が途中で落ちた場合、未処理 figure をどの exclusion reason/count にするかも必要。
- hard-death 後は resume しないため、`prepared_payload` があっても OCR成果は最終的に破棄される。通常例外への耐性とhard-deathへの耐性は区別して説明すべき。

5. R2とDBの非原子的な整合性

- asset行作成、R2 PUT、derivation記録、publishの途中失敗ごとの残存物を定義する必要がある。
- exam削除やfencing lossとR2 PUTが競合すると orphan が発生する。既存GCが新しい行状態・key・NULL参照でも確実に回収できるかが必要。
- R2 PUT成功後にDB記録が失敗した「row-less orphan」もGC対象にできる必要がある。
- conditional PUTの衝突を成功扱いできる条件、asset ID/key の再利用規則も明記すべき。

6. 画像入力契約と座標系

- magic bytesだけでなく、許可format、animated/multi-page画像、最大pixel数、0寸法、極端なaspect ratio、corrupt/truncated画像を規定すべき。
- EXIF orientationやGemini側の自動回転があると、「sharpがrotateしない」だけではGeminiの座標系とcrop座標系の一致を保証できない。client生成WebPだけを許すのか、serverが任意JPEG等も受けるのかを固定する必要がある。
- `File.type` ではなくsniff結果をGeminiのMIMEに使う必要がある。
- server採番した `source_id` の範囲外、重複、欠落、別画像参照をnormalize/safeParseで隔離する契約が必要。
- client圧縮は信頼境界ではないため、2048pxというメモリ見積りをserverが強制しない限り、40MP guard側の約160MBを基準にすべき。

7. メモリ見積り

- sharp内部は入力Buffer、展開画像、出力WebP、crop一時Bufferを同時に保持し得るため、単純なRGBA 1枚分よりpeakが大きい。
- base64生成時はBufferに加えてJS文字列を保持する。Gemini SDKがさらにpayloadを褡製する可能性もある。
-逐次処理だけでなく、sharp cache/concurrency、レスポンスpayload、複数crop出力の保持期間を明示すべき。
- callback終了時まで全原本を保持する設計なので、同一instance上の並行invocation数による総メモリも考慮が必要。

8. 時間予算

- platformのMax Durationはfunction invocation開始から進む一方、設計上の `start` がaction関数内で取得されるなら、body parseやsync txの時間が予算外になり得る。
- OCRに渡すtimeout、per-attempt retry、Discord通知、DB/R2 timeoutが残余を超えないよう、各外部I/O timeoutを残余でclampする必要がある。
- 残余がpublishに不足した場合、cropを打ち切るだけでpublish txを完了できる最低保証が必要。
- lease TTL、platform上限、pipeline budget、reconciler判定に使う時計の関係を一つの不変条件として定義すべき。

9. pollingの有限性

- 「fetch errorが連続したら停止」だけでは、HTTP成功かつ `processing` が永続するケースで無限pollになる。
- client側にも絶対待機上限を設け、「バックグラウンド処理中なので一覧で確認」に縮退する必要がある。
- tab復帰、ブラウザ再読み込み、同一upload pageへの再訪時に、operation/sourceDocument IDをどう復元するかが未定。
- status APIが一時的にdocを返さない場合を、completed、deleted、権限なし、整合性遅延のどれとして扱うか必要。
- auto-nav直前のexam削除やresult routeの404も扱う必要がある。

10. reconcilerの実効性

- 「TTL 15分 + sweep周期」で収束するには、reconcilerの起動方法、実際の周期、排他、batch上限、失敗時再実行が必要。
- stale docとopを同一txで更新する際のtenant/RLS条件、複数docを持つopの扱い、すでにcompletedになったopとの競合を定義すべき。
- 15分以内の表示収束ではなく「15分 + 最大sweep間隔」であるため、UX文言もそれに合わせる必要がある。

11. 削除競合と外部課金

- exam削除でDB行がcascade削除されても、既に開始したGemini呼出やR2 PUTはキャンセルされない。
- Gemini直前、各crop/R2 PUT前、publish前に軽量なownership/fencing確認を入れるか、削除後の課金・orphanをbounded residualとして明示的に受容する必要がある。
- 退会削除との競合も同様に検討が必要。

12. プライバシー・観測性

- sourceをR2に保存しなくてもGeminiには送信するため、外部AIへの送信、provider retention、region、DPA上の扱いは別途残る。
- logger、integration failure、Discord、例外causeにfilename、base64、OCR payload、画像metadataを含めないredaction規則が必要。
- `integration_failures` にoperationId/sourceDocumentIdを安全に相関できる構造が必要。
- hard-deathは記録できないため、stale terminal化時に「platform death疑い」を観測可能にする必要がある。

13. 入力上限とUX

- 合計4MBなら「各ファイル5MiB」は実質的に到達不能で、5MiB境界testだけでは実利用契約を証明しない。
- 40枚×約0.5MBは合計4MBを大幅に超える。client圧縮の目標値とserver合計上限の不整合を、事前表示・再圧縮・枚数削減のどれで扱うか必要。
- multipart overhead込みの4.5MB body limitに対して、4MBのbinary上限が全filename/headers込みで常に通るか確認が必要。
- frameworkがbodySizeLimitでaction到達前に拒否した場合、通常の `invalid_input` outcomeでは返せない。client側のエラー経路が必要。

14. migration/cutover

- S-3で新旧経路を同居させるため、nullable化したschemaを旧コードが安全に扱えることが必要。
- app deployとmigrationの適用順、rolling deployment中の旧instance互換性を決める必要がある。
- S-5後のrollbackはDB表dropとR2 source削除により不可能になる。staging passだけでなく、撤去前checkpoint/rollback方針が必要。
- `source_assets` drop前に、他の運用script、audit、admin query、RLS policy、generated snapshot、バックアップ処理まで探索対象に含めるべき。

15. 仕様上のデータ意味

- 複数画像に対する単一 `source_documents.filename` の値を何にするか。
- `pages_processed = files.length` が「正常decode済み枚数」なのか「受領枚数」なのか。
- `file_size_bytes` がclient送信後の圧縮済みbytesであることを明示する必要がある。
- cropがdeadline除外された結果と実障害によるcrop_failedを、ユーザー表示・metrics上で区別する必要がある。

## plan ドラフトへの抜け・未考慮指摘

1. 主仕様と異なる `maxDuration=720` をplanだけで確定している

主入力は現行800秒を前提にしており、値の妥当性は実測後決定、Fluid/実Max DurationはOT確認事項としている。planは独自に720秒へ変更し、660秒予算と180秒lease marginまで確定している。これは単なる実装詳細ではなく、処理成功率・lease・stale判定を変える設計変更で、主仕様から導けない。

また、plan内でも「repoはNext 16.2.11」と「現行v16.3.0 doc」が混在している。

2. S-3の同期action構造が明記されていない

S-1/S-2の `submitUpload` は即terminal stub、S-4で初めて `after()` 登録とされている。S-3 smokeを同期版で通すには、S-3時点でactionが `runUploadPipeline` をawaitし、完了後に返す形へ変更する必要があるが、task本文に明示されていない。

3. S-2のpipeline契約とS-4のcatch責務が矛盾する

S-2のProducesは「全失敗を内部terminal化・throwしない」。一方S-4はcallback最上位catchを外すmutationでthrow-injection testが失敗するとしている。どの層がunexpected errorを分類し、terminal化し、integration failureを記録するのか一本化されていない。

4. crop例外からtext publishへ倒す実装taskが不足

S-3は「crop全滅mock」を扱うが、これは各cropが通常の失敗結果を返すケースに見える。crop loop途中のunexpected throw、R2障害、derivation INSERT失敗からprepared payloadを使ってtext publishへ進む試験がない。

5. expired leaseと同一idempotency keyの関係が未定

S-1はreplay lookupをlive gate/supersedeより先に行う。既存expired opが同じkeyで見つかった場合、supersede試験とは別にreplayが先勝ちし得る。状態別replay規則とtestが必要。

6. action到達前のbody rejectionを扱っていない

`bodySizeLimit=4.5mb` 超過は入力検証より前にframeworkが拒否するため、`invalid_input` outcomeにはならない。upload formのnetwork/action例外マッピングが必要。

7. pollingは依然として無限になり得る

「連続6回fetch失敗」で止まるだけで、正常応答がずっと `processing` の場合の上限がない。hard-death、reconciler停止、status不整合で無限pollになる。

8. reload/re-entryが未考慮

operationId/sourceDocumentIdをReact stateだけで持つ場合、reloadするとpoll対象を失う。URL、session storage、DB上のcurrent op探索など、復旧方式がplanにない。

9. callback未登録窓のtestがない

sync tx成功後に `after()` 登録、closure準備、応答serializationのいずれかが失敗したケースがない。reconcilerで最終収束することを最低限検証すべき。

10. Buffer実体化のタイミングが曖昧

`runUploadPipeline(... files: {buffer,...}[])` という署名はあるが、`File.arrayBuffer()` を応答前に全件完了し、request objectをcallbackへ渡さないという制約がtaskにない。

11. Geminiとsharpのorientation一致が未検証

base64一致testはbytes同一を証明するだけで、Geminiが同じ向き・frameを解釈することは証明しない。受理formatの制限またはorientation fixtureが必要。

12. cropの「retryなし冪等」testの意味が不明

同一pipeline再実行はstatus/lease CASにより拒否されるべきであり、「同一payload再実行でcards/assets不増」が何を再実行する試験か曖昧。publish txの冪等性、crop PUTの冪等性、pipeline fencingを別々に検証すべき。

13. R2 orphanの保証が不足

S-3はkey形状しか検証しない。PUT後DB失敗、exam削除競合、publish失敗で残ったasset行/object、row-less objectをGCが回収するtestがない。

14. reconcilerの運用条件がない

op terminal化のunit/iso testはあるが、reconcilerがproductionでいつ・何により実行されるか、最大収束時間、batch処理、失敗監視がplanにない。

15. 削除競合testが遅すぎる

S-4の「行消滅なら静かに中断」だけでは、Gemini前に削除された場合も外部呼出する可能性がある。少なくとも開始時・外部I/O前のチェック有無を決定し、課金とorphanの期待値を試験すべき。

16. failure通知のredaction試験がない

unexpected throwにBuffer、base64、Gemini payload、filenameが含まれてもDiscordへ流れない保証が必要。

17. S-5のgrep条件だけでは撤去完全性を証明できない

別名import、raw SQL、運用script、generated schema、RLS grant、backup/analytics queryは列挙文字列から漏れる可能性がある。DB catalog検査とR2 write mockを併用すべき。

18. S-5 rollback不能点が未管理

表dropと`src/`一掃後は旧経路へ戻せない。実ユーザー0でもstaging/fixtureデータを失うため、不可逆化の承認点、migration適用順、旧deploymentが残っていない確認が必要。

19. `src/` 一掃scriptの安全条件が不足

pagination、全tenant列挙、versioned object/delete marker、対象prefixの厳密検証、dry-run結果の保存、削除件数readbackが必要。「OT指示下」だけでは誤削除防止条件として弱い。

20. client側4MB制約の実現方法がない

40枚・約0.5MB/枚というclient仕様に対し、server合計4MBを満たすためのUXや再圧縮がtask化されていない。境界unit testだけでは実upload成功率を担保しない。

21. `source_document` と複数Fileのmetadata契約がない

filename、pages processed、表示順、同名file、空filenameの扱いがplanにない。`fileSizeBytes` の引数化だけではproductionデータ意味が確定しない。

22. planのS-5対象に状態列そのものの整理が不足する可能性

retry marker/backoffを「定数・分岐」だけ撤去するのか、DB列もdropするのかが不明。残すなら将来誤読を避けるコメントが必要で、dropするならmigration・rolling compatibilityが必要。

## リスク / 対立しうる設計判断

| 判断軸 | 選択肢と対立 |
|---|---|
| Max Duration | 800秒維持は成功余地が大きい。720秒化はlease余白を増やすが、未実測で成功率を下げる。Dashboard確認前の確定は危険。 |
| expired opの再試行 | 同一key replayはtransport冪等性が強いが、dead opへ固定される。同一keyでgeneration更新は再試行しやすいが、冪等モデルが複雑。新key必須は単純だがclient契約依存。 |
| crop共通例外 | text publish優先ならOCR成果を守れるが、部分的asset状態の整理が複雑。terminal failure優先なら整合性は単純だが、明示要件に反する可能性が高い。 |
| polling上限 | terminalまでpollすればauto-nav成功率は高いが無限化する。client上限を置けばUXはboundedだが、完了後の自動遷移を逃す。 |
| 削除競合 | DB行消滅だけを検知する設計は単純だが、削除後のAI課金・R2 orphanを許容する。外部I/O前に都度fencing確認するとDB負荷が増える。 |
| 入力format | client生成WebPのみ許可すればorientation・寸法契約が強いが、action再利用性が下がる。JPEG等を許すならEXIF/animation/frame契約が必要。 |
| prepared checkpoint | forensicsとcrop縮退に有効。一方resumeしないためhard-death後には活用されず、機微OCR payloadのDB滞留時間を増やす。terminal化・GCの確実性が重要。 |
| source metadata削除 | 誤読防止と単純化には有効だが、将来の監査、入力別障害分析、PDF設計、再現性を弱める。source bytesを保持しなくても最小metadataだけ残す選択肢はある。 |
| 逐次crop | メモリ上限には安全だが、40枚時の時間上限に不利。限定並列は高速だが、instance並行数を含めたメモリ制御が必要。 |
| stale判定 | heartbeatなしは単純だが、TTL内はhard-deathと生存中を区別できない。heartbeat追加はUXを改善するが、書込負荷と状態機械が増える。 |
| S-5不可逆化 | 早期撤去は複雑性を減らす。一定期間の旧schema残置はrollback性を上げるが、「保持前提の誤読」と保守対象を残す。 |
| integration failure通知 | Discord通知は発見性が高いが、処理時間と情報漏洩面が増える。DB記録を先に確定し、通知はbest-effortかつredactedに限定すべき。 |