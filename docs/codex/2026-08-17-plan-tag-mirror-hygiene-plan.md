# Codex plan cross-check — tag-mirror-hygiene-plan (2026-08-17)

- **作成日**: 2026-08-17
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. 実装順の必須依存

   - study-days owner echo は衛生処理より先。
   - cursor CAS は purge / sweep 導入前に必要。
   - DL success gate も Cache cleanup 導入前に必要。
   - sweep は共通 hygiene / Cache helper の完成後。
   - M-c は機能的には独立だが、correctness pin 全体を維持して実施する。
   - 最後に全 repo gate、文書更新、review 収束を行う。

2. study-days owner echo

   - 正常 API 応答だけに `owner_user_id` を追加し、静的 `emptyBody` は変えない。
   - client は既存 shape 検証後、行検証前・tx 前に echo を必須検証する。
   - 不一致、欠落、非 string、空 payload でも fail-closed。
   - echo 一致後も既存の全行 owner 検証を残す。
   - reject 時は既存 study_days を含む Dexie 状態が完全不変。
   - 正常な「echo 一致 + 空配列」は自 owner 行を全削除する。
   - server-only rollback が新 client を silent reject させる非対称を運用記録に残す。

3. pull cursor CAS

   - 6 cursor の `undefined` を含む開始 snapshot を保持する。
   - apply tx の先頭、かつ同一 tx 内で6本を再読する。
   - 消失・値変更・不在からの出現をすべて不一致とする。
   - mismatch は tx 全体を abort し、mirror / cursor を不変にする。
   - CAS mismatch だけを既存 FAIL 形式へ正規化し、それ以外の tx 例外の現行伝播を変えない。
   - cursor write の「応答 null は据え置き」契約を維持する。
   - capture 原則、owner echo、5 stream 行検証、validate-before-tx、scoped key、default caller I-1 pinを退行させない。
   - abort 後の回復として、cursor 消失なら full pull、前進なら現在 cursor から delta、の両方を固定する。

4. purge / sweep の Dexie 原子性

   - 11 store すべてについて、purge と sweep の各扱いを明示分類する。
   - 触る全 store は各処理につき単一 rw tx に含める。
   - mirror と cursor の部分削除を許さない。
   - tx 中途例外による rollback を、purge と sweep の両方で検証する。
   - store 追加時に「purge と sweep の各分類または明示除外」を要求する網羅 pin が必要。単に store 名が一つの共通配列に存在するだけでは分類判断を強制できない。

5. 削除規則と不可侵集合

   - outbox は `synced` のみ削除し、pending / syncing / failed は owner を問わず不可侵。
   - assets は `ready` のみ削除し、それ以外の行と対応 blob は不可侵。
   - jobs は `done` のみ削除し、`downloading` 行と `added_asset_ids` blob は不可侵。
   - 将来 status を誤削除しないよう、削除条件は陽形だけにする。
   - purge と sweep の双方について、pure table-driven 判定と実 DB 統合テストを用意する。
   - protection set は Dexie tx 後に残存行から作る。sweep でも owner を問わない不可侵集合が優先される。

6. Cache cleanup

   - Cache 不在時に新規 cache を作らない。
   - key parser は pathname 3 segment、query なしを厳密に要求する。
   - malformed / 規則外 key は purge・sweep とも削除。
   - purge は保護対象を除く全 namespaceを削除。
   - sweep は self namespace を温存し、foreign namespaceと malformedを削除。ただし保護 blob は owner を問わず温存。
   - 1 key の削除失敗が残りを止めない。
   - Dexie DB 不在でも Cache cleanup は実行する。
   - 遅着 blob は完全排除できず、次の hygiene 機会で回収するという保証境界を維持する。

7. DL success gate

   - `misses.length === 0` の早期成功出口と、download後の成功出口の両方を支配する。
   - deck の全 key、特に preflight hit と newly added の両方を検査する。
   - 早期出口失敗では job row が作られていないことを固定する。
   - download経路失敗では既存 rollback に合流し、added blob と job row を消す。
   - never-throw、per-exam lock、既存 status 集合を維持する。
   - 各出口の gate を個別に壊す red 実証が必要。

8. sign-out trigger

   - root ClerkProvider 内で常時 mountする。
   - `isLoaded && !isSignedIn` の状態観測で発火する。
   - remount等による再実行は許容し、同一 tab 内の同時実行だけを in-flight Promise で dedupする。
   - signed-in 中は不発火。
   - 匿名訪問でも呼ばれうることを仕様として受容する。
   - `Dexie.exists(false)` は Dexie skipの条件にすぎず、Cache skip条件にしない。
   - fire-and-forget の rejection を React 側へ漏らさない。

9. sign-in sweep / sync_meta

   - 空 userId は fail-closedで、Dexie / Cacheとも変更しない。
   - mirror は foreign owner のみ。
   - outbox / assets / jobs は foreign ownerかつ陽形の削除可能状態のみ。
   - sync_meta は bare 7本と既知 base の foreign / malformed suffixだけを削除。
   - self scoped key、未知 key、prefix類似 keyは温存する。
   - allowlist は `SYNC_META_KEYS` から自動生成せず、リテラルにする。
   - `SYNC_META_KEYS` の追加時に allowlistまたは明示除外への分類を強制する。
   - trigger は mountと userId変更時に発火し、失敗を外へ漏らさない。
   - `.sync_meta` 直接アクセス audit の許可対象追加が必要。

10. M-c

   - options一覧 queryのみ owner filterを追加する。
   - `useLiveQuery` depsに `userId` を含める。
   - adversarialな foreign option fixtureで表示面を pinする。
   - correctness spec §3.3 の他の除外箇所へ拡張しない。

11. 完了・運用条件

   - spec §9 の1〜5・10を全て満たす。
   - correctness sprint の capture、validate-before-tx、owner echo群、I-1 default caller pinを全 greenにする。
   - reviewは Critical 0 / Important 0へ収束。
   - lint、test:iso、auditを必須 gateとする。
   - architecture、棚卸し Appendix、sessionの変異記録を更新する。
   - pre-hygiene writer不在、すなわち deploy後の旧 tab reloadを保証開始条件とする。
   - smokeは配線・IDB / Cache readback中心とし、競合再現は決定的 unit testに任せる。

## plan ドラフトへの抜け・未考慮指摘

1. **Critical: sweep の空 userId fail-closedが具体化・pinされていない**

   Global Constraintsには書かれていますが、Task 5の `sweepForeignLocalData(userId)` に early return条件と「Dexie / Cache不変」のテストがありません。`notEqual('')` 等でほぼ全 ownerを foreign と判定しうるため、削除処理では重大です。

2. **Important: store網羅 pinが弱すぎる**

   Task 4の `HYGIENE_STORE_NAMES` は「全 table名が一つの配列にある」ことしか確認しません。これでは新 storeを名前だけ追加し、purge / sweepの処理分類を実装しない逃げ道があります。

   specが要求するのは、purgeとsweepそれぞれについて「扱い分類または明示除外」を強制する pinです。`HYGIENE_STORE_NAMES` 一本では不足します。

3. **Important: sweep側の pure store分類テストが落ちている**

   spec §9-8 は purge / sweep双方について、store × 条件のpure table-driven testと実DB統合testを要求しています。Task 5でpure化されているのは実質 sync_meta key分類だけです。assets / jobs / outbox の foreign-owner + status判定をpure規則として直接 pinする手順がありません。

4. **Important: tx原子性 pinが purgeにしかない**

   Task 4には中途throwによる原子性試験がありますが、Task 5のsweepにはありません。両者は異なる delete query・filter・sync_meta削除を使うため、purgeの試験ではsweep実装の単一tx性を保証できません。

5. **Important: sweep不可侵 pinの列挙が不足**

   Task 5は「異 owner pending生存・非ready / downloading生存」と要約されていますが、凍結 §9-3 が求める以下が明示されていません。

   - foreignの pending / syncing / failed 全状態
   - self / foreign双方の非ready assets行と対応blob
   - self / foreign双方のdownloading jobと `added_asset_ids` blob
   - 対になる foreign synced / ready / done の削除

   とくに行だけでなく blob 生存までassertする必要があります。

6. **Important: sweep Cacheの継続性テストが不足**

   Task 4にはper-key削除失敗後の続行がありますが、Task 5にはありません。sweepのnamespace判定と削除ループは別経路なので、foreign keyの一件失敗後に他のforeign / malformed keyが削除されることも固定すべきです。

7. **Important: sweepの保護集合算出手順が曖昧**

   Task 4は「tx後に算出」と明記していますが、Task 5は「保護 blob除き」としか書いていません。sweepでもDexie tx後の残存する非ready assets / downloading jobsから、ownerを問わず保護集合を作る interfaceを明記すべきです。

8. **Important: pure判定と実削除queryの対応が不明**

   Task 4は「pureに切った判定」と書く一方、Interfacesに判定関数や、実処理がその判定を共有するのかがありません。テスト専用pure関数と実queryが別実装になると、specが懸念する乖離が残ります。少なくとも分類表、pure判定、実削除の対応関係をplan上で固定する必要があります。

9. **correctness凍結 pin の実行箇所が曖昧**

   GlobalとTask 7には「全 green」がありますが、I-1 default caller pinをどの関連テストで維持するか、CAS変更後にどの既存テスト群を必ず走らせるかが弱いです。Task 2で `pull.test.ts` 全件を走らせる点は良いものの、完了報告で capture / validate-before-tx / owner echo / I-1を個別確認した証跡が必要です。

10. **Task 4とTask 5のinterface分割に不整合がある**

    `local-hygiene.ts` はTask 4で作るのに、store網羅や共通保護集合、pure分類の完成形がTask 5まで見通せていません。Task 4時点のexportをTask 5でどう拡張するかを明示しないと、Task 4のテスト設計をTask 5で作り直す可能性があります。

11. **Task 7の完了gateにはspec超過がある**

    `pnpm vitest run`、`pnpm typecheck`、`pnpm build` は品質上は合理的ですが、spec §10の必須 sprint gateは lint / test:iso / auditです。これらは「spec必須」ではなく追加gateであることを区別すべきです。特にbuildを必須化するなら、失敗時のscopeと修正権限が無制限に広がらないようにする必要があります。

12. **不要または過剰になりうる具体化**

    - `CAS はowner検証でない`という実装コメントの文言まで固定するのは、意図の保存には有益ですが、テスト可能な成果ではなくplanの必須interfaceとしてはやや過剰です。
    - Cache helperの公開関数名・戻り値を細かく固定していますが、specが要求するのは挙動です。既存設計との親和性が確認できない段階では実装自由度を狭めています。
    - `SWEEP_EXEMPT_BASES = []` の具体名固定も、必要なのは明示除外集合と分類強制であり、名称まで仕様化する必然性はありません。
    - route正常応答とemptyBodyをそれぞれassertする追加testは妥当ですが、凍結 §9-1の柱そのものではなく補強テストとして区別すると追跡しやすくなります。

13. **spec文書自体のヘッダ状態に注意**

    repo内spec先頭には現在も「r4 draft・OT spec review待ち」とありますが、今回の入力では凍結済みが正です。spec改稿は禁止なので変更対象ではありません。ただし実装者がヘッダを見て承認状態を誤認しないよう、session docに「今回の承認状態の正」を明記する必要があります。

## リスク / 対立しうる設計判断

1. **削除安全性と衛生強度**

   unknown sync_metaは機能保全のため温存し、unknown Cache keyはPII衛生のため削除するという非対称が必要です。一律fail-open / fail-closedに寄せると、機能破壊か残骸温存のどちらかが悪化します。

2. **不可侵とsign-out完全消去の対立**

   pending / failed outbox、uploading / failed assets、downloading jobsを残すため、sign-out purgeは「全データ消去」ではありません。名称・UI・運用説明で完全消去を暗示すると実装保証と衝突します。

3. **遅走purgeと新sessionのliveness**

   auth再検証やlockを入れないため、新sessionのmirror / cursor / prefsを遅走purgeが消す可能性があります。correctnessはCASとfull pullで回復しますが、一時的な空表示とprefs消失は残ります。

4. **保護snapshotとCache TOCTOU**

   DexieとCacheを原子的に扱えません。uploadは実害bound、downloadはsuccess gateで閉じるというレーン別判断が必要です。共通cleanup lockへ寄せると凍結されたbest-effort設計と衝突します。

5. **success gateの時間的保証**

   gate通過直後の削除までは防げません。specはsign-outによる意図的消去として受容しています。「`ok:true` 後も永続的にblobが存在する」という強い保証へ読み替えてはいけません。

6. **CASの責務拡大**

   CASはnetwork窓中のcursor変化検知だけです。開始時点ですでにmirror / cursorが不整合なケースや旧bundle writerは修復しません。reconcile機構へ拡張するとscope逸脱です。

7. **single transactionとテスト注入性**

   原子性を強く固定するには、tx中途で決定的に失敗させる seamが必要です。ただしproduction APIへ汎用failure hookを露出するとYAGNIになります。テスト可能性と本番surface増加のバランスが必要です。

8. **filter走査の性能**

   outboxには単独 `sync_status` indexがないため全走査になります。sign-in / sign-out時の一回処理として受容済みですが、データ量増加時には発火頻度とmain-thread負荷が問題化しえます。今回schema変更へ拡張するのはscope外です。

9. **useAuth初導入の不確実性**

   cross-tab、初期化境界、Strict Modeでの観測回数は保証外です。発火回数を厳密契約にせず、dedupと次回sweepによるeventual回収に限定する必要があります。

10. **追加gateとscope creep**

    buildやwhole-repo vitestを追加必須化すると、無関係な既存失敗まで本sprintの修正対象に見えます。実行は有益ですが、失敗時は「本変更起因か既存か」を切り分け、無関係修正へ拡張しない運用が必要です。