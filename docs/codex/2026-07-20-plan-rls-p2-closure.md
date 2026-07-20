# Codex plan cross-check — rls-p2-closure (2026-07-20)

- **作成日**: 2026-07-20
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. loud の保証範囲を正確に定義する必要がある  
   「context 未設定なら例外」は、単に policy 内で関数を参照するだけで全 SQL 形に保証されるとは限らない。空表、対象候補 0 行、実行計画上 policy 式が評価されないケース、INSERT/UPDATE/DELETE/SELECT の差を実 PG17 で確認すべき。保証したいのが「5 表に触る全クエリ」なら、policy 評価依存ではなく入口 wrapper による明示検査との二重化も検討対象になる。

2. SQLSTATE は専用コードであるべき  
   要件は「専用 SQLSTATE」の loud 例外である。既存エラー、認証処理、retry 判定、監視分類と衝突しない非標準コードを決め、例外名・メッセージも固定する必要がある。

3. tenant context の真正性・脅威モデル  
   `app.user_id` は app role 自身が `set_config` できるため、任意 SQL を実行できるほど app role が侵害された場合、攻撃者は任意 UUIDを設定できる。今回のRLSが防ぐのは「配管ミス・WHERE漏れ・pooler残留」であり、「app roleを完全に侵害した攻撃者」ではないことを明記すべき。

4. claim の信頼境界  
   `sessionClaims.dbUserId` の型、UUID妥当性、Clerkユーザーとの対応保証、古いclaimの有効期間、scrub後の残存期間を整理する必要がある。不正形式はDB cast例外になるのか、null契約へ合流させるのかを固定する必要もある。

5. tx 冒頭の厳密な意味  
   `set_config` より前に対象表への query が一切発行されないこと、callbackが同一接続を使うこと、nested transaction/savepoint、retry時に毎回再設定されることを保証する必要がある。mock unitだけでなく実PGでの確認が必要。

6. SECURITY DEFINER の最小権限化  
   以下を個別に確認すべき。

   - 関数所有者がRLSを意図どおり迂回できること
   - テーブル・関数・型をスキーマ修飾すること
   - `public` schemaへのCREATE権限
   - `PUBLIC`からのEXECUTE剥奪
   - owner変更・再作成後も権限が維持されること
   - `p_by` の許容値をallowlist化すること
   - 返却列を必要最小限にすること
   - 例外や件数差がcross-tenant oracleにならないこと

   `SET search_path = public` だけを十分な防御とみなさない方がよい。

7. bootstrap関数の公開面  
   `SETOF users` は全列を返し得る。共用app roleから任意のClerk IDを渡せるなら、呼出経路のバグによって他ユーザー情報を取得する特権バイパスになる。必要列だけ返す、呼出可能箇所を限定する、監査可能にする、のいずれかが必要。

8. resolver関数の公開面  
   `p_by/p_value` で4種類のanchorを自由に解決できる関数は強い権限を持つ。特にschedule IDやStripe IDからユーザーIDを得られることが必要最小権限か、経路別関数に分けるべきかを評価する必要がある。

9. user.created の原子性  
   存在確認、事前採番、context設定、INSERTが同一txである必要がある。存在確認とINSERTのraceでunique violationが起きた場合、現行の冪等吸収と本当に同じ結果になるか、metadata syncや通知の差も含めて確認すべき。

10. scrub の原子性と後続処理  
    scrub関数だけでなく、Group I DELETE、assets UPDATEとの順序・同一tx性、途中失敗時のrollbackを固定する必要がある。scrub後に子行が残る中間状態をcommitしない保証が重要。

11. ghost UUID の定義  
    ghost testはusersだけでなく、削除tx完了後に対象4表の同一UUID行が存在しないことをowner ground truthでも確認すべき。単にRLS越しに0行では、「削除漏れだがghost contextなら読める」ケースを見落とし得る。

12. policy のコマンド別完全性  
    共通4表の `FOR ALL` だけでなく、SELECT、INSERT、UPDATEのUSING/WITH CHECK、DELETEを個別に検証する必要がある。UPDATEでは「他tenant行の変更不可」と「自tenant行のuser_idを他tenantへ付け替え不可」は別保証である。

13. users policy の特殊性  
    usersでは少なくとも次を分離して検証すべき。

    - scrub済み行のSELECT不可
    - scrub済み行の通常UPDATE不可
    - INSERTでid/context不一致を拒否
    - UPDATEによるid変更を拒否
    - DELETEは常に拒否
    - SECURITY DEFINER経由のscrubだけは成功

14. `eq(userId)` 残存の機械的確認  
    「全経路で残す」はレビューだけでは抜けやすい。5表ごとの操作サイト一覧と、各SQLについてapp predicate・RLS・context供給元を対応付けたマトリクスが必要。

15. partial RLS の安全性説明  
    「policy評価は表単位」はDBエラー面の説明にはなるが、アプリの安全性全体には不足する。RLS有効表から得たIDを使ってRLS無効表を読む経路、join/subquery、helper再利用、pull内のmixed streamについて、新しいcross-tenant連鎖がないことを確認すべき。

16. FK・cascade の実動作確認  
    「内部cascadeはRLS非適用」を前提だけで済ませず、app roleによるexam削除で期待するcascadeがPG17上で成功し、他tenant行を巻き込まず、既存件数と一致することをintegration testすべき。

17. pooler実証の観測項目  
    行の純度だけでなく、transaction終了後のGUC消滅、rollback後、エラー後、接続再利用、同時A/Bリクエスト、pool飽和時を確認すべき。逐次交互実行だけでは競合時の漏れを十分に検証できない。

18. 性能評価の統計設計  
    30回のp95は外れ値に敏感。beforeが別デプロイ・別時点なら環境差も混ざる。同一stg条件で直前baselineを取り直すか、少なくともDB負荷、pool wait、tx時間、query数、エラー率を併記すべき。単一ユーザーの応答時間だけでpool圧悪化は検出しにくい。

19. rollbackの整合性  
    RLSだけ無効化して新コード・SECURITY DEFINER関数を残す場合の挙動を確認する必要がある。どの時点で何を戻すか、適用途中で0026が失敗した場合、ロック待ち・タイムアウト時の扱いもrunbookに必要。

20. migrationの運用安全性  
    `ENABLE RLS` やpolicy作成に必要なロック、migration transaction、statement/lock timeout、再実行可能性、部分適用検出、適用済み確認SQLを設計すべき。

21. 監視と障害分類  
    loud例外を「期待された防御作動」と一般500から区別し、経路、query種別、request correlationを残しつつUUIDや個人情報を過剰にログしない設計が必要。stgで0件確認するだけでなく、本番展開時のalert条件もPhase 3へ引き継ぐべき。

22. Phase 3への反復可能性  
    usersのSECURITY DEFINER、lifecycle、Stripeは特殊設計であり、今回の全作業が単純反復になるわけではない。反復可能な標準部分と、Phase 3で再設計が必要なreview-ingest等を分けて成果物化すべき。

## plan ドラフトへの抜け・未考慮指摘

1. Task 1のSQLSTATE `28000` は要件との不整合  
   `28000` は標準の認証系SQLSTATEであり、「専用SQLSTATE」とはいえない。認証失敗や既存のエラーマッピングと混同する。カスタムコードを選定すべき。

2. loud保証のテストが不十分  
   Task 9は未設定queryを試すが、空表、対象0行、各コマンド、異なるquery planで関数が確実に評価されるかがない。policyだけで「必ずRAISE」が成立するという設計仮定を独立に検証するTaskが必要。

3. `SETOF users` が過剰  
   Task 1はbootstrap関数からusers全列を返す。specの「忠実移植」を理由にしても、SECURITY DEFINERとしての権限面・情報露出面の評価がない。必要列の明示が必要。

4. resolver 4 arm の権限レビューがない  
   `p_by` の不正値、任意anchor照会、重複・NULL、型変換、退会済み行の返却仕様、最小返却列が未定義。

5. SECURITY DEFINERのhardening検証が弱い  
   `search_path`、PUBLIC revoke、grantは記載されているが、public schema CREATE権限、完全修飾名、関数owner、再作成時のdefault EXECUTE、app roleからの直接悪用テストがない。

6. `setTenantContext` のUUID検証方針が曖昧  
   Task 2は「DB側 ::uuid cast」とするが、`set_config` 自体ではcastされない。対象表queryまで不正値が潜伏する。設定時にDBでuuid castするのか、query時に初めて失敗させるのかを固定すべき。

7. wrapperの実PGテスト不足  
   mockで「先頭」を確認するだけでは、同一connection、rollback、retry、pooler transaction mode、nested transactionを保証できない。

8. helperのoptional `dbc=getDb()` が将来の抜けを温存  
   Phase 2中も引数渡し忘れがコンパイル上成功する。対象helperについては必須dbc化、またはRLS対象経路からdefault使用がないことを静的・テストで検証する方が安全。Phase 3までlintを延期するリスクが明記されていない。

9. 全操作サイトの証跡がない  
   「sweep済み」とあるだけで、5表×read/write×経路×context供給元×`eq(userId)` の対応表がない。漏れのレビュー可能性が低い。

10. user.created のtx境界が明記不足  
    Task 6の「存在チェック→set_config→INSERT」が同一txなのか不鮮明。SECURITY DEFINERの存在確認はcontext不要だが、INSERTはRLS対象なので、実装形を明記すべき。

11. unique violation時の挙動差が未検証  
    outer catch 200+通知を「現行と同水準」としているが、現行onConflict分岐との差、metadata同期、通知ノイズ、dedupe記録のcommit状態を検証していない。

12. scrub関数の戻り値が `void`  
    RETURNING禁止は守れるが、対象0行と成功をDB関数呼出側が区別できない。再削除no-opを意図するなら、その契約と通知位置を明文化すべき。

13. Stripe log+skipの対象イベント網羅が不明  
    「handle-stripe-event / upgrade actions」だけでは、4 anchorを使用する全call siteが網羅される証跡がない。退会後イベントで外部副作用が先に起きないことも確認が必要。

14. Task 8で既存testを一括変更するリスク  
    owner ground-truth化とwithTenantTx化を同一段階で行うと、テストがapp roleの実挙動を迂回してgreenになる危険がある。刺激はapp role、観測だけowner、という境界を明示すべき。

15. writeテストが「代表」に留まる  
    5表×代表read/writeでは、INSERT WITH CHECK、UPDATE USING、UPDATE WITH CHECK、DELETE、usersのpolicyなしDELETEを十分に証明できない。

16. ghostテストの期待値が曖昧  
    「write 0行 or 拒否」では、どちらが正しい契約か固定されない。操作別に期待結果とSQLSTATEを決めるべき。またownerで残存行も検査すべき。

17. red検証方法が粗い  
    policyを5表すべてDISABLEすると、多数のassertionがまとめて赤になるだけで、各policy・USING・WITH CHECKが効いている証明にならない。変異後の確実な復旧、並列test汚染防止も未記載。

18. null契約7分類の検証が「既存資産」依存  
    どの既存testがどの分類を担保するか対応表がない。分類の一部が実際には未テストでも見逃される。

19. FK cascadeのintegration testがない  
    exam削除txをclosure選定根拠にしているのに、cascadeとRLSの相互作用を直接検証する項目がない。

20. partial残余の説明が表単位policyに限定  
    mixed transaction、join、ID受け渡し、RLS無効表の誤tenant指定についての回帰テストがない。「新失敗モードなし」の立証として弱い。

21. 性能計測が同時負荷を扱わない  
    pull直列化とtx長期化によるpool待ちが主要リスクなのに、単発30回だけ。少なくとも複数同時ユーザー、pool utilization、DB connection wait、transaction durationが必要。

22. stg A/Bテストが逐次のみ  
    「交互pull」は残留検査にはなるが、同時実行時の接続再利用・pool競合を検証しない。並行A/Bも追加すべき。

23. deploy/migration成果物の分離方法がない  
    0025と0026が同じコード成果物に含まれる場合、通常の自動migrationが両方適用しない保証が必要。0025だけ先行適用できる運用方式、migration履歴確認、誤って0026まで適用した際の復旧をrunbookに含めるべき。

24. rollback確認が弱い  
    `DISABLE RLS ×5` 後のsmoke、関数を使う新コードの正常性、rollback SQL自体の事前演習、再enable手順がない。

25. migrationロック・失敗時処理がない  
    stgでも長時間txやlock contentionはあり得る。lock timeout、適用前チェック、適用後policy/grant確認、部分失敗時の判定を追加すべき。

26. 監視設計が「28000なし」に留まる  
    例外件数、経路別集計、SQLSTATEのアプリ変換、retry対象外であること、機密情報を含まないログ形式が未定義。

27. 「Phase 2はstg限定」と通常のbranch/deploy運用の整合がない  
    Phase 2コードがdevelopに入り、その後prod deployへ混入しない統制が必要。RLS offなら安全という前提でも、SECURITY DEFINERやStripe挙動変更はprod影響を持ち得る。

28. prod非反映なのに新規Stripe挙動を同じ変更に含める点  
    退会後Stripeのlog+skipは既存挙動変更であり、RLS off期間にも効く。stg限定をmigrationだけで担保しても、コードがprodに出れば要件違反になり得る。

29. Task 12はstg実証前に「完了」し得る  
    Goalはstgで「動く・漏れない・遅くならない」を実証することだが、Task 11では実走を別指示待ちとし、Task 12をsprint完了としている。stg smoke・性能・pooler A/Bの合格を最終gateに含めなければ目的未達のまま完了扱いになる。

## リスク / 対立しうる設計判断

- policy内loud関数だけで未設定を必ず検出するか、wrapperでも明示検査するか。前者は単純、後者は保証が強いがqueryが1回増える。
- helperのdbcをoptionalにして互換性を優先するか、必須化して配線漏れをコンパイルエラーにするか。
- bootstrapを1本の汎用SECURITY DEFINERにするか、用途別・最小返却列に分けるか。
- resolverを4 anchor統合にするか、Stripeなど経路別に分離して権限面を狭めるか。
- users UPDATE policyに`deleted_at IS NULL`を含める方が退会後遮断は強い。一方、将来の管理・復旧処理はSECURITY DEFINERまたはowner経路へ明示的に分離する必要がある。
- unique violationを通知付き200で吸収する設計は現状近似だが、onConflictによる静かな冪等性とは運用ノイズが異なる。
- 30回の単発レイテンシ比較は短時間で実施できるが、pool圧・同時負荷悪化の検出力が低い。
- policy DISABLEによるred検証は簡単だが、保証単位が粗く、復旧失敗時のtest環境汚染リスクがある。
- 部分RLSを短期stgで許容する判断は妥当でも、コード変更自体がprodへ混入しないリリース統制が別途必要。
- 最大の完了条件上の対立は、実装・test greenを完了とするか、要件どおりstgの性能・pooler実証合格までを完了とするかである。主入力の目的からは後者が必要。