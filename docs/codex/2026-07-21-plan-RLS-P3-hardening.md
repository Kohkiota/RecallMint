# Codex plan cross-check — RLS-P3-hardening (2026-07-21)

- **作成日**: 2026-07-21
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

### 1. DB handle とトランザクション境界

- 非 tenant handle は「安全な global DB」ではなく、単に「app-role だが tenant context 未設定」の接続である。RLS 対象表への誤使用は P0RLS になる一方、非対象表には role の全権限がそのまま作用する。この能力境界を名前・型・利用規約のどこで表現するかが必要。
- `getGlobalDb()` が通常の `DB` 型を返すだけなら、型レベルでは tenant 表へのアクセスを防げない。今回新規設計をしないとしても、この制約が lint/comment のみであることは明記すべき。
- `getGlobalDb()` と `getDb()` が同じ memoized clientを共有する場合、tenant context が必ず transaction-local (`set_config(..., true)`) であり、transaction 外や pool connection に漏れないことが前提になる。
- `withTenantTx()` への統一時は、単なる呼出し置換だけでなく以下の保存確認が必要。

  - transaction の開始・commit・rollback 単位
  - helper が同じ transaction handle を最後まで使うこと
  - nested transaction/savepoint の有無
  - loop 中の fail-fast / partial commit の意味
  - context 設定前に query が走らないこと
  - fire-and-forget 処理が transaction handle を transaction 終了後に保持しないこと

- `TenantDb = DB | TenantTx` を残すと、DDD 規約上の「apply/repository は TenantTx のみ」と型定義が矛盾したままになる。今回絞らないなら、残存理由と将来課題を明示する必要がある。
- 7 site の分類は現在の実装に対するスナップショットであり、将来の新規 site を二択へ分類する仕組みも必要。コメントだけでは、新しい非 tenant 利用の妥当性までは lint できない。
- `integration_failures` の admin fallback は特に強い権限昇格点である。どの環境・条件で owner 接続へ落ちるのか、誤設定時に本番で owner を使わないかを確認すべき。

### 2. `getDb` 封じ込め

- ESLint の `no-restricted-imports` が防げるのは指定した import 形式だけである。次も遮断または検査対象にすべき。

  - alias 以外の相対 import
  - barrel file 経由の再 export
  - `require()` / dynamic import
  - `getDb` の別名 import
  - DB client/session singleton の別 export

- 「export を lib/db 内部に制限」は TypeScript/ESLint上の規約なのか、実際に `index.ts` の public export から除外するのかを区別する必要がある。
- test 全体を lint 除外すると、本番コードから参照される test helperやfixtureに escape hatchができる可能性がある。除外範囲は正当な integration DB setup に限定できるか検討が必要。
- 要件は「全 call site が二択」であるため、既存 site のゼロ確認だけでなく、負例fixtureなどで lint rule 自体が本当に違反を検出する保証も論点になる。

### 3. 非RLS表のGRANT縮小

- コマンド単位GRANTは最小化できても、行単位の隔離は提供しない。特に `contact_messages DELETE` は、app-role侵害時に全問い合わせを削除できる。これは今回の「列単位GRANTなし」とは別の残余リスクとして明示すべき。
- 同様に `ai_usage UPDATE` は全ユーザー・全日の利用量を変更可能である。コマンド最小化だけで十分という意味にはならない。
- `SELECT` は `RETURNING` 対象列や `ON CONFLICT DO UPDATE` の式・条件に必要になる。positive test は実際のDrizzle queryと同等の列・conflict pathで行う必要がある。
- 「各表1個の42501」では、複数 revoke コマンドの全てを pin できない。例えば `contact_messages` は SELECT と UPDATE の両方、`integration_failures` は3コマンドが revoke 対象である。期待権限行列を全組合せで検証すべき。
- `ALTER DEFAULT PRIVILEGES ... GRANT ALL CRUD` が残るため、新しく作られる非RLS表は再びblanket CRUDになる。既存5表への後段REVOKEだけでは将来の再発を防げない。
- table以外にsequence権限が必要か、identity/serialの実スキーマで確認が必要。integration testが通ることをもって実利用権限を確定するのが安全。
- SQLは再実行可能であるべきで、base grants→phase3 revokeの適用順序がrunbookとtest setupの双方で固定される必要がある。
- stg手動適用後には `information_schema.role_table_grants` または `has_table_privilege` によるreadbackが必要。SQL Editorが成功しただけでは実効権限を証明できない。
- positive testは実データを変更するため、衝突しないfixture、rollbackまたはcleanupが必要。

### 4. Policy drift detection

- `relrowsecurity=true` と `(tablename, policyname, cmd)` だけではpolicyの安全性を検証できない。少なくとも次を期待値と照合すべき。

  - schema
  - roles (`recallmint_app`)
  - permissive/restrictive
  - `qual`
  - `with_check`
  - usersだけのper-command構成とDELETE policy不在
  - 18表以外に意図しないpolicyがないこと
  - 必要なら `relforcerowsecurity` の期待値

- common policyの式が誤って別列・別関数になっても、policy名とcmdだけならtestが通る。
- hardcoded期待値は `db/policies/*.sql` と二重管理になる。両方を同時に誤更新すれば検出できないため、期待値のレビュー規約や、versioned SQLとの対応関係を明示する必要がある。
- test:iso は毎回同じrepository SQLを新DBへ適用してから検査する。そのため「repository SQLとtest DBの整合」は検出できるが、stg/prodへの適用漏れや手作業driftは検出できない。運用環境用read-only検査SQL/runbookが別途必要。
- policyが依存する `app_current_user_id()` の定義、owner/security属性、実行権限のdriftはpolicy catalog検査の対象外である。既存testで十分か確認が必要。

### 5. P0RLS alert

- P0RLSは任意のRLS queryで発生し得るため、2つのwrite catch siteだけへの配線では「P0RLS発生時にnotifyOps」の一般保証にならない。対象範囲を限定するなら、要件とのギャップとして明記すべき。
- `serializeDbError` の全呼出元だけでなく、P0RLSが到達し得るroute/action/jobの例外境界を棚卸しする必要がある。
- postgres-js/DrizzleでSQLSTATEがtop-levelにあるとは限らない。既存42501 helper同様、`.cause` chainを辿ってP0RLSを識別する必要がある。
- fire-and-forgetはserverless実行終了時に破棄され得る。「発火した」と「記録・通知が残った」は同義ではない。
- `recordIntegrationFailure` がDB INSERTに失敗するとnotifyOpsまで到達しない実装なら、DB障害由来のP0RLS通知経路として脆い。INSERT失敗時も通知を試すのか、少なくともログへfallbackするのかを確認すべき。
- alert記録自身がDB処理を行うため、再帰的失敗・重複通知・alert stormへの配慮が必要。
- PII非搭載は「テスト用文字列にUUIDがない」だけでは弱い。route/opを自由文字列にせず、列挙された定数・allowlistにする方が確実。
- P0RLSを通知した後も元のHTTPエラー、status、例外伝播、既存logが変化しないことを確認すべき。

### 6. 運用・検証

- 冒頭の「13表」と内訳の「実質18表」が混在している。gate、runbook、coverage、期待catalogでは18表に統一すべき。
- stg smokeの「P0RLS 0」は正常系確認にすぎず、P0RLS alertが実際にDiscord/台帳へ届くことを証明しない。安全な故障注入方法が必要。
- whole-repo gateに加え、変更前から存在するfailと今回のregressionを区別できる実行記録が必要。
- prod適用禁止と、prod有効化時に必要な成果物の準備は別である。適用順、readback、rollback、失敗時停止条件は今回整備しておくべき。

## plan ドラフトへの抜け・未考慮指摘

1. Task 2で「TenantDbは不変」、Task 3で「helperはTenantTxのみ」としており、型境界の到達状態が曖昧。少なくとも残る `DB | TenantTx` 利用箇所の棚卸しがない。

2. A-manualtx変換について、per-iteration境界は触れているが、nested transaction、context設定前query、transaction handleの寿命、例外時の継続/中断意味の検証項目が不足している。

3. `getDb` lintはalias import中心で、相対import、barrel再export、dynamic importなどの迂回路を考慮していない。ruleの負例testもない。

4. `tests/**` の一括除外が広すぎる。必要なintegration setupだけを除外する方針や、test helperからproductionへの逆流確認がない。

5. `getGlobalDb()` を通常のDB型で公開することにより、tenant表にもquery可能になる残余リスクが説明されていない。

6. `integration_failures` のowner fallbackを「不変」としているが、その分岐条件の安全性確認がない。環境変数欠落がowner利用につながるならfail-openになり得る。

7. grant negative testが「各表1件」だけで、revoke権限行列を完全にはpinしない。全revokeコマンドを検証すべき。

8. blanket default privilegesを維持したままなので、将来追加表への過剰grant再発を防げない。今回変更しない場合も既知リスクとして残す必要がある。

9. grant positive controlに、実際の `ON CONFLICT DO UPDATE` conflict branch、`RETURNING`列、contact DELETE条件などの具体性がない。

10. policy drift testがpolicy名とcmdしか比較せず、最重要の `roles/qual/with_check/permissive` を検証していない。誤ったtenant条件でもgreenになり得る。

11. test:isoだけでは手動適用されたstg/prodのdriftを検出できない。stg readback SQLまたは同じassertionを実DBに対して実行する運用手順が欠けている。

12. 「policyを意図的に外すred検証」だけでは、policy式の改変やrole変更を検出できる証明にならない。代表的なmutationを追加すべき。

13. P0RLSを2つのwrite siteだけに配線しながら、Task目的は一般的な「P0RLS発生時」と表現されている。目的と実装範囲が不一致。

14. read path全面配線をfollow-upにする根拠と、現時点でalertされない経路一覧がない。「握りつぶさず報告」の対象にすべき。

15. fire-and-forgetで通知永続性を保証できるか未検討。特にNext.js/serverlessで処理終了前に完了する保証がない。

16. `recordIntegrationFailure` のINSERT失敗時にnotifyOpsが呼ばれるか、通知経路自身の失敗・再帰をどう扱うかがない。

17. PII testがmock payload確認のみであれば、自由文字列のroute/opへUUIDやquery値が混入する経路を防げない。

18. stg smokeにP0RLS alertの故障注入と通知readbackがない。正常系でP0RLSが0件でもTask 7の実証にはならない。

19. stg grant確認は意図的42501が1件だけで、5表すべての実効権限を証明しない。最低でも権限catalogの一括readbackが必要。

20. Task順序上、Task 1で7 siteを先に移行し、Task 4までlint enforcementが入らない。各中間commitで新規raw利用が混入しない確認方法が弱い。

21. 「各siteに理由コメント」の品質基準がない。コメント分類と実際に触る表・必要権限が一致することをreview checklistへ入れるべき。

22. policy/grant/runbookのprod適用順とrollback条件が不完全。grantを先に縮小した結果、policy有効化前後のどちらで機能停止し得るかを整理すべき。

## リスク / 対立しうる設計判断

- `getGlobalDb` vs `getNonTenantDb`  
  `Global` はglobal表専用に見えるが、実際はpre-tenant、匿名、auditも含む。能力を正確に示すなら `NonTenant` が優れる一方、既存用語との一貫性では `Global` が分かりやすい。

- lint中心の封じ込め vs 型によるcapability制限  
  lintは小さな変更で済むが迂回可能。型/限定repositoryは強いが「新規設計をしない」というwave制約を超えやすい。

- default privilegesの維持 vs 将来安全性  
  blanket default grantは新表導入を簡単にするが、今回塞ぐ過剰権限を将来再発させる。明示grant方式は安全だがmigration運用負荷が増える。

- コマンド最小GRANT vs 行単位保護  
  今回の範囲は前者だが、contact全削除やai_usage全更新のblast radiusは残る。要件達成とセキュリティ境界の完成を混同しないことが重要。

- policy B採用 vs 実環境drift検知  
  Bはoperator分離を維持するため妥当。ただしCIのtest DB検査だけでは運用driftを検出できず、read-only実環境監査との組合せが必要。

- hardcoded期待catalog vs SQLからの自動導出  
  hardcodedは独立oracleになる一方、二重更新漏れが起きる。SQL解析は同期しやすいが、誤ったSQLをそのまま正解としてしまう。

- P0RLS通知の中央集約 vs catch site個別配線  
  中央集約はcoverageが高いが既存serializer契約を変え、重複通知を招きやすい。個別配線は小さいが必ずcoverage gapが残る。

- await通知 vs fire-and-forget  
  awaitは記録可能性を高めるが、エラー応答遅延や二次障害の影響を受ける。fire-and-forgetは応答を守るが、serverlessでは通知消失リスクがある。

- 1 wave継続 vs sub-wave分割  
  一括変更は最終状態を早く作れるが、決済・認証・削除・transaction境界・grantを同時に扱い回帰原因の切分けが難しい。少なくともcommit/gate/smoke単位は、handle移行、grant、drift、alertで分離する方が監査可能性が高い。