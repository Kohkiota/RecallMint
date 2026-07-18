# Codex plan cross-check — rls-p1-app-role (2026-07-18)

- **作成日**: 2026-07-18
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. 「明示的に CRUD だけ grant」と「実効権限が CRUD だけ」は別です。`recallmint_app` は `PUBLIC` 経由の権限も継承します。少なくとも以下を実環境で棚卸しする必要があります。

   - database の `CONNECT` / `TEMP`
   - schema `public` の `USAGE` / `CREATE`
   - function/procedure の `EXECUTE`
   - 既存 role membership
   - table/schema/database owner、または owner role の membership
   - `has_database_privilege`、`has_schema_privilege`、`has_table_privilege` 等による実効権限

   `TEMP` が残れば一時テーブル DDL は可能です。`PUBLIC` に `CREATE ON SCHEMA public` があれば永続 DDL も可能なので、「DDL を構造的に排除」という目的は、個別 GRANT だけでは証明できません。

2. PostgreSQL は通常、function に `PUBLIC EXECUTE` が付与されます。既存の user-defined function、特に `SECURITY DEFINER` function がある場合、app role が直接の table 権限を持たなくても強い操作を実行できる可能性があります。現行 runtime が組み込み関数しか使わないというコード調査だけでなく、DB catalog 上の function/procedure と ACL の確認が必要です。

3. `GRANT ... ON ALL TABLES IN SCHEMA public` は「runtime が利用する business table」より広い可能性があります。`__drizzle_migrations` が `public` にあるなら、runtime アクセス不要なのに CRUD を付与します。最小権限を厳密にするなら、migration metadata を除外するか、対象表を正本化するかを判断すべきです。

4. `USAGE ON SCHEMA public` は CRUD 実行に必要ですが、「grant は SELECT/INSERT/UPDATE/DELETE のみ」という文言とは字義上衝突します。schema `USAGE` は必要な補助権限として明示的に例外定義すべきです。

5. default privileges は「対象DB・schema・将来のobject creator role」の組み合わせごとの設定です。

   - `FOR ROLE postgres` は、実際に将来の migration が `postgres` 所有で object を作る場合にしか効かない
   - SQL Editor、pooler、CLI、別の保守 role が creator なら漏れる
   - database ごとに設定が必要
   - table の owner 変更では default privilege の対象 creator は自動的に整理されない
   - partition、view、materialized view、foreign table、別schema導入時の扱いも将来確認が必要

   migration 接続で `SELECT current_user, session_user` を確認し、新規 object の `relowner` を検証する gate が必要です。

6. default privilege の正しさは静的SQLだけでなく、将来 migration の模擬で検証すべきです。owner/migration role でテスト表を作成し、app role が CRUD でき、TRUNCATE/ALTER/DROP できないことを確認してから owner で削除する試験が有効です。

7. test:iso は単なる green では接続主体を証明できません。テスト中に app接続から `current_user = 'recallmint_app'`、`relowner <> recallmint_app` を明示 assert すべきです。環境変数の設定ミスで owner 接続へ戻っても74本が通るためです。

8. 否定的権限試験が必要です。app role で少なくとも次が失敗することを構造的に確認すべきです。

   - `TRUNCATE`
   - `ALTER TABLE` / `DROP TABLE`
   - `CREATE POLICY` / `ALTER POLICY`
   - `CREATE TABLE public...`
   - migration metadata への操作（非許可方針の場合）
   - owner roleへの `SET ROLE`
   - app role が owner/memberでないこと

9. setup/reset の owner 接続と code-under-test の app接続が、同一 worker/process でsingletonやenv変更により混線しない設計が必要です。`closeDb()` が両方を閉じる仕様は、fixture がadmin accessorを共有した場合にapp側まで意図せず閉じる可能性があります。

10. test role はcluster-level objectなので、DBのDROP/CREATEでは消えません。既存 role が強い属性やmembershipを持っていた場合、`IF NOT EXISTS` は安全な状態へ矯正しません。ローカルでも属性・membership・所有関係を検査する必要があります。

11. rollout はDB role/grants、環境変数、コードdeployを原子的に扱えません。安全な順序は概ね以下です。

   1. pooler互換性を確認
   2. role作成・grants適用
   3. app URLで直接接続確認
   4. Vercelへ `DATABASE_URL_APP` を追加
   5. 新コードをdeployしてsmoke
   6. 無印 `DATABASE_URL` を削除し、再deploy/再確認

   旧コードが動いている間に無印URLを先に削除すると、redeploy、rollback、旧serverless instanceなどで失敗し得ます。

12. Vercelの環境変数は production/staging だけでなく Preview、Development、branch scope、CLI同期、CI secretも確認対象です。削除・追加後に再deployが必要か、既存deploymentへどう反映されるかもrunbook化が必要です。

13. rollback の意味を厳密にする必要があります。新コードは `DATABASE_URL_APP` しか読まないため、即時rollbackは「`DATABASE_URL_APP` の値をowner URLへ差し替えてredeploy」であり、「旧 `DATABASE_URL` を復活」ではありません。またVercel反映・再deploy時間があるので、文字どおり即時ではありません。

14. コード自体を旧版へrollbackする場合、新旧コードで期待するenv名が異なります。アプリrollbackとcredential rollbackの二種類を分け、旧版へ戻す際に一時的にどのenv名が必要かを定義すべきです。

15. app passwordをURLへ埋める際のURL encoding、TLS parameter、pooler port、username形式を確認する必要があります。特殊文字を含む強いpasswordを生URLへ連結すると接続失敗し得ます。

16. passwordの生成、保管、ローテーション、漏洩時失効、stg/prod間の分離が未定です。inline shell assignmentもshell history、CIログ、エラー出力への露出方針が必要です。

17. pooler互換性確認は「ログインできる」だけでなく、transaction pooler経由で以下を確認する必要があります。

   - `current_user` が期待どおりか
   - CRUDとadvisory lockが動くか
   - connection limit/pool sizeがowner系poolと分離されるか
   - password変更・credential rotation後のpool再接続挙動
   - `prepare:false` 前提が維持されるか

18. advisory lockはrole分離後も同一DB内で共有されます。owner operatorとappが同じlock keyを使う場合の競合は維持されますが、pool変更に伴うtransaction境界が変わらないことをsmoke対象に含めるべきです。

19. RLS P2前提として、app roleがtable ownerでなく、`BYPASSRLS`を持たず、owner roleを継承できないことをcatalogで継続検証すべきです。将来のmigrationが誤ってtable ownerをapp roleへ変更すると、RLSが迂回されます。

20. repo全体の参照探索は `process.env.DATABASE_URL` だけでは不足します。CI/CD、workflow、Docker/devcontainer、package scripts、shell、dotenv、docs、deployment設定、文字列組立、secret名をrepo全域で確認する必要があります。凍結記録を残すなら「repo内0件」ではなく「実行可能経路0件」と定義すべきです。

## plan ドラフトへの抜け・未考慮指摘

1. 最大の不足は、`PUBLIC` 経由を含む実効権限の検証です。提示SQLは権限を追加するだけで、schema `CREATE`、database `TEMP`、function `EXECUTE`、role membershipを確認・除去しません。このままでは「DDLを構造的に排除」を完了条件にできません。

2. `CREATE ROLE ...` は新規作成時の属性しか保証しません。既存roleに余分なmembershipや権限があった場合の監査・是正手順がありません。

3. `ALL TABLES` により `__drizzle_migrations` など不要tableにもCRUDを付与する可能性が未考慮です。「runtimeアクセス無し」という調査結果をgrant範囲へ反映していません。

4. `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` の前提確認が未解決欄に留まり、Task 1では固定SQLを先に正本化しています。creator role確認をTask 1の前提gateに昇格すべきです。

5. 「別roleで作成された場合」の検討が要求されていますが、planには検出・運用ルールがありません。少なくとも migration後のACL検査、object owner検査、default privilege模擬テストが必要です。

6. test:isoに `current_user` の恒久assertがありません。一時的なgrant文コメントアウト試験だけでは、owner接続への誤退行を将来検知できません。

7. negative privilege testがありません。CRUD成功だけでは、TRUNCATE/DDL/policy変更が禁止されていることを検証できません。

8. `fixture.ts` を「owner専用client」へ変える一方、`getAdminDb()`を使うのか独立clientを使うのか曖昧です。`closeDb()`が両singletonをまとめて閉じる設計とのライフサイクル干渉も未検討です。

9. `vitest` globalSetupで設定したenvが各workerへどの時点で伝播するか、既存import時のlazy singleton初期化より先か、明示的な検証がありません。

10. rollout順序のVercel手順が「`DATABASE_URL` を削除 → APP追加」になっています。旧コード稼働中の互換期間と再deploy境界がなく、環境変数欠落による停止リスクがあります。

11. prod手順が「stgの1–2を反復」となっており、prodでのmigration方針、app URL直接確認、smoke、`current_user`確認、operator確認が明示されていません。

12. rollback記述が不正確です。`DATABASE_URL_APP` をowner URLへ差し替えること、Vercelで反映のため再deployが必要なこと、アプリコードrollback時のenv互換性が抜けています。

13. `.env.local` の実変更が要件なのに、明確なTaskとして入っていません。`.env.example` と「依存」という未解決記述だけでは要件5を満たしません。

14. Vercel Preview/Development/branch scope、CI secrets、ローカルdotenv同期の棚卸しがありません。

15. `grep` の範囲が限定的です。Task 4のコマンドではworkflow、shell、package設定、devcontainer、全docs等を漏らします。またTask 5で意図的に過去文書を残すため、「無印参照ゼロ」というGoalとの定義調整も必要です。

16. pooler確認が外部gateに留まり、検証項目がusername形式だけです。app URLでの `current_user/session_user`、CRUD、advisory lock、TLS、credential特殊文字を含む接続試験が必要です。

17. password運用が「強力な値」以上に定義されていません。生成、URL encoding、保管、rotation、stg/prod分離、漏洩時手順が不足しています。

18. operator scriptsを一律ownerへ移すことで、日常的なGCやbackfillが常に最大権限になるリスクを評価していません。要件上admin接続に寄せるとしても、実行頻度、credential供給方法、誤接続防止、監査を設計すべきです。

19. smokeの `SELECT current_user` をどの経路で実行するかが曖昧です。通常アプリには診断endpointを恒久追加せず、app URLを用いた限定SQLと実アプリ操作を分けるべきです。

20. role/grants SQLの再適用性が十分ではありません。role作成は手動一回とされていますが、stg/prodで既存roleがある場合、password更新や属性是正をどう扱うかがありません。

## リスク / 対立しうる設計判断

- **広い一括grant vs 厳密な最小権限**  
  `ALL TABLES + default privileges` は運用事故を減らしますが、migration metadataや将来の管理用tableまで自動公開します。対象table列挙は安全性が高い一方、新規table時のgrant漏れが増えます。

- **default privilegesによる自動追随 vs migrationごとの明示grant**  
  自動追随は可用性に強く、creator role変更に弱い設計です。明示grantはレビュー可能ですが、漏れやすくなります。両方を使い、CIでACLを検査する案が堅いです。

- **operatorをownerへ統一 vs operator専用の限定role**  
  二本立ては単純ですが、日常operator scriptにowner credentialを渡します。将来的にはmigration ownerと保守operatorを分ける余地があります。

- **`PUBLIC`権限をREVOKEする vs 既存Supabase機能との互換性維持**  
  `TEMP`、schema `CREATE`、function `EXECUTE`を広くrevokeすれば強固になりますが、Supabase管理機能や既存処理へ影響し得ます。まず実効権限を観測し、app role個別の対策と全体REVOKEを分けて判断すべきです。

- **段階rollout vs 「常設環境からowner URLゼロ」の即時達成**  
  安全なdeployには短い互換期間が必要ですが、その間は旧owner URLが残ります。移行中の一時状態と完了状態を区別し、終了gateで確実に削除する必要があります。

- **owner URLへの迅速rollback vs 最小権限保証**  
  `DATABASE_URL_APP` にowner URLを入れるrollbackは復旧性が高い一方、分離保証を意図的に破ります。発動条件、期限、事後再分離をincident手順として定義すべきです。

- **admin URLを常設しない安全性 vs migration/operatorの運用性**  
  inline供給は常設secretを減らしますが、shell historyや手動転記事故が増え得ます。安全な一時secret注入方式との比較が必要です。

- **testの本番忠実性 vs ローカル単純性**  
  ローカルPG17の直接接続では、Supavisor固有の認証・pooling失敗を再現できません。test:isoはACL検証、stgはpooler統合検証と責務を明確に分けるべきです。