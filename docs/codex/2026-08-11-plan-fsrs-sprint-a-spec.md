# Codex plan cross-check — fsrs-sprint-a-spec (2026-08-11)

- **作成日**: 2026-08-11
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. 順序ガードには、card ごとの完全な全順序が必要。

   - `answered_at` の比較演算子だけでは、同時刻 event の順序が決まらない。
   - 同一 payload 内だけでなく、別 POST・別端末・別 transaction に分かれた同時刻 eventにも tie-break が必要。
   - tie-break は永続値、例えば `(answered_at, event_id)` で定義し、cards 側にも最後に適用した順序キーを保持するかを決める必要がある。
   - `last_review` だけを watermark にすると、同時刻の別 transaction はロック取得順で結果が変わりうる。

2. `applied` の意味を厳密に定義する必要がある。

   - 「ingest 時点で scheduling に採用された事実」なのか、「正規順序で再生した際に採用対象となる event」なのかで意味が違う。
   - 前者なら arrival order に依存する履歴となり、後から全 event を並べ替えて再 replayしても同じ結果にならない。
   - `applied` は一度だけ `false→true` になり以後不変か、再構築時に更新可能かも明示が必要。
   - card が存在しないため `applied=false` だった event を、将来同じ UUID の card が作成された際に再評価しないことも契約化すべき。

3. event sourcing と「決定的 replay」の成立条件が不足している。

   - `rating`、実効 `answered_at`、`is_correct` があっても、FSRS ライブラリ版、パラメータ、初期状態定義が変われば同じ結果を再現できない。
   - ReviewLog を保存しない判断とは別に、scheduler/version/config を記録しない場合、answer_events は監査用の入力ログにはなっても、将来まで決定的に再構築できる event source ではない。
   - 非スコープとするなら「何をどのコード版まで再現できる正本か」を限定して明記すべき。

4. 冪等性は「同じ event_id が存在する」だけでは不十分。

   - 同一 event_id の再送で payload 内容が異なる場合の扱いが必要。
   - 別ユーザーの既存 event_id と衝突した場合、`ON CONFLICT DO NOTHING` を成功扱いにすると、攻撃者または偶発衝突の event が保存されないまま client が synced になりうる。
   - 重複時には少なくとも所有者を確認し、可能なら immutable fields の一致も検証する必要がある。
   - payload 内重複を先勝ちにする場合も、内容不一致を silent に捨てるか request error にするか決定が必要。

5. 永続失敗の終端は、request 単位と event 単位を分けて設計する必要がある。

   - schema不正、1000件超、認証不整合などは transaction に到達しない request-level failure。
   - 1件の壊れた local event が chunk 全体を400にすると、後続の正常 event まで送れない poison-pill 問題が起きる。
   - terminal 化しない方針なら、chunk 分割・単件隔離・正常 event の継続送信などが必要。
   - 「controller が自動 retry しない」だけでは、visibility、次回回答、再起動による新しい flush で再送されない保証にはならない。

6. server 応答の意味を整理する必要がある。

   - transaction が原子的なら、tx throw 時に一部 event_id だけを `failed[]` で返すケースは基本的にない。
   - HTTP 5xxと `200 { failed: [...] }` の役割が重複している。
   - client が synced にしてよい event、pending を維持する event、terminal にする eventを response contractとして明示すべき。
   - timeoutや応答消失では、server commit済み/client pending となるため、再送時の重複応答も成功として確実に収束させる必要がある。

7. card ロックで保護される範囲を明示する必要がある。

   - SELECT成功後のcard削除は行ロックで競合するが、削除が先に完了した場合は dangling eventとなる。
   - card作成、card削除、entity mutationによる同一行更新とreview flushのロック順序・競合意味論を確認する必要がある。
   - `applyCardFinalStates` 以外のcards更新が同じ13列を保持した古いsnapshotで上書きしないことも必要。
   - 複数cardのSELECTだけでなく、後続UPDATEも既取得ロックの集合・順序内に限定されることを保証すべき。

8. clamp の時刻源と監査意味論を決める必要がある。

   - app server clockとDB clockの差、transaction開始までの待機時間、複数server instanceのclock skewがある。
   - `created_at` を「HTTP受信時刻」「parse完了時刻」「transaction開始時刻」のどれとするか固定が必要。
   - raw timestampを捨てると、後から端末clock異常を調査できない。列を増やさない判断ならログの保持期間・検索可能性を含め、観測能力を意識的に捨てることになる。
   - 下界を設けないため、極端に古いtimestampによる古いstudy day生成を許すことも仕様になる。

9. study_days 再集計にはゼロ件時の意味論が必要。

   - 再集計結果が0件の場合、既存行をゼロで上書きするのかDELETEするのかを決める必要がある。
   - applied eventを削除・訂正しない現在の前提では発生しにくいが、退会、運用修復、将来のrebuildでは必要になる。
   - 影響日だけの再集計が完全であるためには、`applied`、`answered_at`、`user_id`が更新不能であることが前提。
   - 過去日を無制限に指定できるため、悪意あるclientが広い日付範囲に行を生成できる点も確認対象。

10. JST共通化は「日付文字列」だけでなく境界生成まで同一である必要がある。

   - ISO dateの解釈、UTC変換、inclusive/exclusive境界をpinする。
   - server/client双方からimport可能なpure moduleであること、Node専用依存やclient bundle副作用がないことを確認する。
   - 日跨ぎ直前・直後、閏日、異常な古い日時のテストが必要。

11. elapsed_ms の計測契約が必要。

   - tab非表示、スリープ、問題表示中の別画面遷移を含めるか。
   - 「前へ」で再表示した場合に旧計測を破棄するか、新しいeventとして別計測するか。
   - 二重submit時の計測値とevent生成の単一性。
   - integer上限と過大値の扱い。非負CHECKだけではPG integer overflowはrequest全体失敗になりうる。

12. client owner-scope は読み出しだけでなく状態更新にも必要。

   - pending SELECTにuser_idを使うだけでなく、synced化も `(user_id, event_id)` で限定すべき。
   - logout/login切替の途中でin-flight応答が返った場合、旧userの処理が新userの状態やUIに作用しないこと。
   - userIdの供給元をpropsの一時状態ではなく、認証済みownerと一貫させる必要がある。

13. Web Locks不在環境を正常系として扱う必要がある。

   - Web Locksは正しさの根拠にしないという方針は妥当だが、未対応browser、worker、lock取得skip時の再kick条件を定義する必要がある。
   - threshold/完了flushをguardへ寄せた結果、session終了時に送信機会を失わないことを検証すべき。

14. 初期FSRS値のpure関数には時刻注入が必要。

   - `due=now` をpureにするには `now` を引数として受け取る必要がある。
   - client optimistic時刻とserver採用時刻のどちらを正とするか。
   - DB default撤去後はproductionの3経路だけでなく、fixtures、seed、管理SQL、integration setupの全INSERTが必須列を提供する必要がある。

15. schema変更にはDB運用上の原子性・ロック影響がある。

   - ユーザー0でも、`real→double precision` はtable rewriteとACCESS EXCLUSIVE lockになりうる。
   - `DROP/CREATE answer_events` とRLS policy再作成の間にapp roleから無防備または利用不能な状態を作らないmigration/runbookが必要。
   - migration本体と別SQLのRLS適用に依存するなら、適用順・失敗時復旧・検証を完了条件に含める必要がある。

16. event sourceとして必要なindex/read APIを検討すべき。

   - `(user_id, answered_at)` はstudy_daysには適するが、card単位の履歴表示、再構築、障害調査には効きにくい。
   - 現在読み手がないことだけを理由にcard indexを消すと、「正本化したが実用的に読めない」状態になりうる。
   - 無期限保持を選ぶ以上、将来のreplay/access patternとindex方針は最低限明文化すべき。

## plan ドラフトへの抜け・未考慮指摘

1. §2.4のtie-breakは同一payload内しか決定していない。

   `answered_at同順・payload順` は、別POSTに分かれた同時刻eventには適用不能である。2接続のロック取得順によって最終FSRS状態が変わる。要件の「同時刻tie-breakをspecで確定」を満たしていない。

2. §2.4の`>=`とarrival-order依存の関係が説明されていない。

   同時刻eventを両方適用するなら、cardsに保持するwatermarkが`last_review`だけでは次のeventとの全順序比較ができない。`(last_review,last_event_id)`等が必要か、同時刻は到着順を正式仕様とする必要がある。

3. §3は確定事項8を実質的に置換している。

   要件は「serverがpermanentと判定したeventをclientでterminal化」としている。全eventを受理してpermanent概念を消す案は単なる実装詳細ではなく裁定変更であり、OT確認前には確定仕様として扱えない。

4. §3の「server判定が永遠に来ないeventはlocal残置で無害」は成立しない。

   pendingのままなら次のflush対象であり続ける。さらに1件のinvalid eventによるHTTP 400がchunk全体を阻害する。隔離、二分探索、単件terminal化のいずれもないため、正常eventまで恒久的に詰まる可能性がある。

5. §2.1/§3の`failed[]`契約が曖昧。

   tx throwなら通常はHTTP errorであり、200応答の`failed[]`を返せない。部分成功を廃止した設計なら`failed[]`自体の必要性を再評価すべき。重複event、応答消失後の再送、event_id衝突時のresponseも未定義。

6. event_id conflict時の所有権・内容一致検証がない。

   グローバルPKに対する`DO NOTHING`だけでは、別user所有のevent_id衝突や、同一ID・異内容再送を正常成功にしてしまう。これは正本の完全性に関わる。

7. 「全eventをINSERT」とpayload dedupeの関係が未定義。

   payload内で同じevent_idが異なる内容を持つ場合、先勝ちで黙って捨てる案は監査性が低い。エラーにするか、完全一致だけdedupeするかを決める必要がある。

8. event sourcingを掲げながらrebuild仕様がない。

   answer_eventsからcardsを再構築するコマンド、順序、対象、scheduler version、初期状態、`applied`の扱いがない。§11の「決定的 replayで代替」という主張を支える仕様が不足している。

9. scheduler/library versionの問題が未考慮。

   ReviewLog不採用は確定でも、FSRS versionやparametersを残さず「決定的 replay」と呼ぶのは過大である。少なくとも再現可能性の限界を明記すべき。

10. §5の再集計にゼロ件・削除・修復時の扱いがない。

    UPSERTする値が0の場合、行を残すか消すかが不明。今回appliedになった日のみを対象にする前提が、将来の運用修復でも成立するとは限らない。

11. §5の性能根拠が推測に留まる。

    「高々数百」はschema上保証されず、payloadは1000、複数device・複数flush・無期限履歴がある。性能を確定事項にするなら、代表量と上限寄りのEXPLAIN/計測条件が必要。

12. §1.1でcard indexを全廃する判断が早い。

    answer_eventsを唯一の正本にするなら、card単位replay・履歴調査が主要access patternになりうる。現行読み手ゼロは旧設計の結果で、新設計のindex要否の根拠にはならない。

13. §2.3のapp層`created_at`は、要件のserver受信時刻との対応が弱い。

    HTTP受信、route開始、parse後のどこで採るか未定義。DB clockとの差の観測もない。CHECKを成立させるためにDB defaultを外すことと、受信時刻の正確性は別問題である。

14. §2.3のlogger観測は運用仕様が不足。

    60秒という閾値の根拠、ログ保持、集計・alert有無、PII/identifier取扱いがない。event_idだけではuser/card影響を追跡しにくい一方、user_idを加えるならログデータ取扱いが必要。

15. §4.2の逐次chunk処理に失敗時の継続規則がない。

    chunk 1が429、400、5xx、network errorの場合にchunk 2以降を送るか止めるか。400 poison pillの場合に同じ先頭chunkを永久に作り続けないかが未定義。

16. §4.2のWeb Lock統一にfallbackがない。

    lock取得失敗時にthreshold/完了契機をskipした後、どの契機が配送を保証するかを明示していない。Web Locks未対応環境の挙動も必要。

17. §4.5のelapsed_msに上限がない。

    zodとDB integer範囲、background時間を含めるか、`performance.now()`が利用不能なSSR/test環境、二重submitをテスト対象に含める必要がある。

18. §4.6はin-flight account switchを扱っていない。

    owner-scoped SELECTだけでなく、response適用、synced化、pullBack、controller stateも旧userに束縛する必要がある。

19. §7.1の「3生成点」だけではDB default撤去の影響網羅にならない。

    tests、fixtures、seed、direct SQL、iso setupも含めた全INSERT探索が必要。pure初期値関数の時刻引数と、server/clientの採用時刻も未定義。

20. §9.1のisoでは同時刻tieが検証されない。

    必須追加候補は、別接続から同一card・同一answered_atを送るケース、逆のlock取得順で繰り返すケース、同一event_id異内容、別user event_id衝突、deleteとの競合。

21. §9.1の順序ガードtestが弱い。

    「古い1件」だけでなく、同一request内の新旧混在、別requestで中間時刻が遅着、同時刻、null lastReview、clampで同時刻化された複数eventが必要。

22. §9.1のred検証は並行testの再現性に注意が必要。

    FOR UPDATEを外しても毎回lost updateになるとは限らない。barrierやDB-side coordinationで両transactionが同じsnapshotを読んだことを保証しなければ、mutation testがflakyになる。

23. §9.2にmigration SQL・RLSの構造検証が不足。

    PK/FK/CHECK/default/index/policyを実PGからreadbackするschema contract testが必要。特にanswer_events再作成でgrant、owner、RLS enable/force、policyが失われる。

24. §10の「DROP→CREATE」とmigration生成手順に不整合リスクがある。

    drizzle生成物を手動調整する場合、snapshot/journalと実SQLの一致、将来の`db:generate`が同じ変更を再生成しないことを確認する必要がある。

25. §11のtech-spec改稿除外は危険。

    tech-specに旧payload/session/answer_events定義が残るなら、architecture.mdだけ更新しても正本が競合する。少なくとも旧記述の無効化または参照先変更が必要。

26. §13の完了条件にrebuild可能性の検証がない。

    「event sourcing」を目的に掲げるなら、answer_eventsから期待cards状態を再計算できること、または本Sprintでは再構築を保証しないことのどちらかを完了条件・文書に置くべき。

## リスク / 対立しうる設計判断

| 判断 | 一方の利点 | 対立するリスク |
|---|---|---|
| `>=`で同時刻eventを全適用 | clock解像度不足でも回答を失わない | 別POST間の適用順がlock取得順になり、決定性を失う |
| `(answered_at,event_id)`で全順序化 | device/POSTを跨いで決定的 | cardsに追加watermarkが必要。UUID順に業務的意味はない |
| arrival orderを正式な順序とする | 実装が単純、現在状態を前進のみで維持 | event sourcingからの時系列rebuildと一致しない |
| 全well-formed eventを受理しapplied=falseにする | orphan再送問題を単純化、履歴を失わない | server permanent terminal化という確定事項を変更。無効データを正本へ恒久保存 |
| permanent理由をwireで返す | clientが確実にterminal化できる | 状態・理由語彙・migration・UI/運用が増える |
| raw answered_atを保存しない | schemaが簡潔、clamp後の順序が一意 | clock異常の監査・将来の再解釈ができない |
| created_atをapp clockで打刻 | clamp上界とCHECKを一致させやすい | DB clockとの乖離、複数instance間の時刻一貫性低下 |
| card indexを削除 | write/storage cost削減 | 正本からのcard replay・調査が遅くなる |
| affected dayだけ再集計 | flushコストを限定 | eventの訂正・削除・applied再判定を将来導入すると整合維持が難しい |
| DB defaultを全撤去 | 初期状態を1定義に統一 | direct insert、fixture、運用SQLが脆くなり、関数経由強制をDBが保証できない |
| scheduler versionを保存しない | scopeと列数を抑制 | 将来のFSRS upgrade後に決定的replay不能 |
| Web Locksでclient入口を一本化 | 無駄な重複送信を減らす | lock非対応・取得skip時の配送保証が複雑化 |
| invalid requestをlocal残置 | 誤terminal化によるデータ損失を避ける | poison eventが正常eventを恒久的にブロックしうる |
| card不在eventを永久にapplied=false | 削除済み履歴を安全に保持 | UUID再利用・復元・card再作成時に再評価しない意味論が固定される |

最大の設計上の未解決点は、同時刻eventのcross-request順序、event sourcingの再現可能性、そしてrequest-level permanent failureのpoison-pill処理である。この3点は実装詳細ではなく、正本の意味とデータ消失・配送保証を左右するため、plan承認前に確定が必要。