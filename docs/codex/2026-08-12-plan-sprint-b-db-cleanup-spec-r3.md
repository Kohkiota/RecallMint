# Codex plan cross-check — sprint-b-db-cleanup-spec-r3 (2026-08-12)

- **作成日**: 2026-08-12
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- `classifyBulkError` の「400 到達可能化」では、単に PostgreSQL の SQLSTATE を列挙するだけでなく、400 の意味を先に固定する必要がある。
  - 400 が「その outbox 項目を再送しても永久に成功しない」を意味するなら、client 側で terminal 化するのか、pending のまま残すのかを契約として決める必要がある。
  - 現状の「400でも pending 残置、自然 trigger で再送」は permanent という分類名と矛盾する。
  - Sprint A の「pending は transient のみ」という不変条件とも衝突するため、既知例外として済ませるのか、仕様自体を更新するのかが必要。
  - DB制約違反を400にする場合も、レスポンスに内部DB情報を漏らさず、詳細はサーバーログだけに残す境界が必要。

- SQLSTATE の永続性はコード番号だけでは決定できない場合がある。
  - `23502` は payload 欠損だけでなく、deploy drift、server 側の INSERT 列漏れ、trigger の不具合でも発生する。
  - `22003` も client payload ではなく server 側の計算・変換で起こりうる。
  - `23514` も、どの制約に違反したかを見ず一律に client permanent と扱うと、サーバー実装不整合を client 責任に誤分類しうる。
  - より安全なのは、共有入力検証や明示的な domain error を400にし、DB error は制約名や処理段階まで含めて限定分類する設計。

- 400 応答の単位も重要。bulk transaction 全体が失敗する場合、どの item が不正か特定できないまま chunk 全体を pending にすると、正常 item まで恒久的に巻き込まれる。200 + `failed[]` と400 envelope failureの責務境界を明示すべき。

- `upload_operations.source_document_id` の NOT NULL 化には、親削除時の所有関係を定義する必要がある。
  - `SET NULL` は不可能になるため、`CASCADE`、`RESTRICT`、source document の単独削除禁止のいずれかが必要。
  - `CASCADE` は整合的だが、upload operation を冪等台帳・障害調査記録としてどこまで保存したいかと対立する。
  - 「現在単独削除経路がない」はコードの現況であり、DB不変条件ではない。将来追加される削除経路や運用SQLへの防御を schema comment/test で固定する必要がある。
  - exam と source document の二経路から cascade されるため、実PGで削除結果を検証すべき。

- NOT NULL 化は既存NULL確認だけでなく、確認後からDDLまでの競合も考慮対象。ユーザー0でも background job、webhook、残存Functionが書き込む可能性がある。DDL自身が安全側に失敗することと、運用上の停止条件を分けて扱う必要がある。

- CHECK 追加では次の境界が必要。
  - 既存行の違反値を migration 前に検出し、値、PK、発生元を特定できること。
  - nullable 列、default、INSERT省略時の挙動が一致すること。
  - enum追加時の変更順序。先に新値を書くcodeをdeployすると旧CHECKで失敗し、先にCHECKを広げれば安全、という将来のdeploy規約が必要。
  - DB制約名が安定し、エラー分類や監視で制約名を利用できること。
  - CHECK追加は既存行走査とロックを伴うため、ユーザー0でも表サイズ・statement timeout・lock timeoutの確認が必要。

- 「アプリ層SSoT」とDB CHECKの二重管理には、実行可能な同期機構が必要。TypeScriptの型 union は実行時に消えるため、`AssetStatus` が純粋な型 alias ならDB値との集合比較はできない。runtime tuple/objectなど列挙可能な正本が必要。

- `entity_mutations` owner-scope 化では、少なくとも以下の不変条件が必要。
  - enqueue、coalesce、pending取得、stale削除、送信、synced/failed更新の全段階が同一owner集合に閉じる。
  - user切替中やlogout直前の非同期flushが、別userのセッションで継続しない。
  - `userId` はmutation対象行由来なのか、現在の認証主体由来なのかを統一し、両者不一致時はenqueueしない。
  - wireにuser_idを載せない方針でも、server認証主体とclient ownerの対応をどこで保証するかを明記する。
  - mutation IDのみで更新する処理は、「直前にowner-scopeで選別した集合からしか呼べない」という局所的不変条件をAPI構造またはtestで固定する。

- Dexie破壊upgradeでは、v10→v12だけでなく以下を検証すべき。
  - 新規DBが最終schemaで作成できること。
  - v10からupgradeできること。
  - v11で一度停止・再起動したDBがv12へ進めること。
  - upgrade transaction失敗後に再openでき、半端なstore状態にならないこと。
  - 複数タブが旧versionを保持している場合の `blocked` / `versionchange` 処理。
  - テスト用v10 schemaがproductionの本物と一致し続ける仕組み。
  - `&mutation_id` 化に際して、既存重複はdropで消えるが、新規enqueue競合時のConstraintErrorをどう扱うか。

- 死列削除はschemaだけでなく、型、mapper、関数引数、seed、fixture、mock、serialization、ログ属性、監視query、運用SQLまで探索対象。特に `ocr_cost_yen` はDB保存だけが死んでおり、UI表示用計算まで誤って消さない境界が重要。

- `exams.archived_at` 削除は、列だけでなくAPI outcomeの型変更になる。互換性不要でも、server action、UI exhaustive branch、テストfixture、ログやanalytics上の outcome 名を一括して整合させる必要がある。

- `exams.card_count` 削除後は、件数取得が常にDexie動的集計へ一本化されること、pull直後・create/delete直後・tombstone適用中でも一時的な誤表示が許容範囲かを確認する必要がある。

- index削除はソース上のquery不在だけでなく、FK内部処理、運用SQL、将来の管理query、実行計画への影響を区別する必要がある。prefix indexによる代替は妥当だが、列順、sort方向、partial predicate、opclass/collationまで同一であることが条件。

- deploy順はDDL互換性ではなく、運用上の停止窓を伴う。
  - code先行では新codeのupload INSERTが旧NOT NULL列で失敗する。
  - migration先行では旧codeのSELECT/INSERTが失敗する。
  - ユーザー0でも残存OCR invocationやbackground処理は存在するため、upload受付停止、drain、migration、再開という明示的なmaintenance手順が必要。
  - 900秒経過だけでなく、対象deploymentの実行数・processing operation・queue状況を確認する必要がある。
  - DROP COLUMN後のcode rollback不能に対し、DB backupだけで実用的な復旧時間を満たせるかを確認すべき。

- migrationが単一transactionでも、`DROP COLUMN`、CHECK検証、FK張替えをまとめることでlock時間と失敗範囲が増える。原子性を優先するか、運用上の短時間化を優先するかは明示的判断になる。

- schema comment がTypeScriptコメントなのか、PostgreSQLの `COMMENT ON` なのかを統一する必要がある。運用者がSQLから確認すべき意図なら、コードコメントだけではDBに残らない。

## plan ドラフトへの抜け・未考慮指摘

- 最大の不足は、400を到達可能にした後のclient契約が未解決なこと。planは「pending残置・自然triggerで再送」をpinするとしているが、`permanent-4xx`、Sprint Aの「pendingはtransientのみ」、実際の再送挙動が三者不一致のまま。

- `PERMANENT_PG_CODES` の選定根拠が強すぎる。特に `23502` と `22003` は「payloadの形だけから決定的」とは限らない。constraint名、失敗段階、明示的domain errorへの変換を用いずSQLSTATEだけで400にするリスクが未処理。

- bulk内の一件だけが制約違反した場合に、正常itemをどう扱うかがない。transaction全体400、item単位 `failed[]`、chunk分割再試行のどれを契約とするか必要。

- `AssetStatus` の「unionと集合一致 assert」は、純粋なTypeScript unionなら実装不能。runtimeで列挙可能な値配列が既にあるかの確認、なければ正本を値として定義する設計が必要。

- CHECKの将来拡張時のdeploy順がない。enum値追加では「DB制約を先に広げる→code deploy→必要なら旧値を狭める」という展開規約が必要になる。

- CHECK追加時のlock/timeout/表サイズ確認、migration用 `lock_timeout`・`statement_timeout`、失敗時の停止判断がrunbook項目にない。

- FKを `CASCADE` に変更する判断は現在の削除経路だけに依存している。source document単独削除を将来も禁止するDB・architecture上の不変条件、またはoperation消失を許容する保持方針が不足している。

- source document削除cascadeのtestはあるが、退会handler、exam削除、source document直接削除の3ケースを分けた期待値が明示されていない。

- Dexie upgrade testにv11中間状態からv12への再開、upgrade失敗、複数タブによるblocked/versionchangeがない。新規DBだけでなく実ブラウザのversion競合が実運用上の主な失敗点。

- 手作業で「v10累積schema」をテストに複製すると、production schemaとのdriftが起きる。過去schema fixtureを固定資産として保持するのか、現行履歴から生成するのかが未設計。

- `&mutation_id` の新規unique化について、同時enqueue/coalesce時のDexie `ConstraintError` 処理とテストがない。

- owner-scope化は関数へのuserId追加を列挙しているが、認証主体とmirror行の `user_id` が食い違った場合の扱い、logout/user切替中のin-flight flush cancellationがない。

- 「synced/failed更新はmutation_id集合だけでよい」という判断は、APIの誤用防止が弱い。owner-scope済み選別結果を型や専用関数で閉じるか、少なくとも別owner同一/異なるIDを用いたnegative testが必要。

- card countのtestが「create/delete後に正しい」に留まり、pull競合、tombstone、失敗rollback、複数タブ更新時の一時整合性が未考慮。

- index削除についてschema上のprefix確認はあるが、`EXPLAIN` または代表queryの実PG確認が完了条件にない。

- code deploy→drain→migrationの間、新uploadが必ず失敗するにもかかわらず、upload受付停止・UI maintenance表示・background retry停止の手段がない。「ユーザー0」は外部処理や誤アクセスを防ぐ機構ではない。

- drain条件が `processing=0` と900秒だけで、queued/prepared、非uploadの古いinvocation、再試行queue、Vercel上の実行確認を含まない。

- rollback不能への対策が「pg_dump必須」だけ。restore手順、所要時間、restore検証、migration直前バックアップの整合点がない。

- 単一migrationへ全変更を詰めることで、CHECK検証やFK追加が失敗した場合に全DROPもロールバックされる点は安全だが、長時間lockの評価がない。

- migration適用検証に、27制約の定義だけでなく、削除列・削除index・FK action・NOT NULL・constraint validation状態を `pg_catalog` から一括照合するpostflightがない。

- 「schema comment」として要求された意図がTSコメントだけでよいか未確定。DB運用者向け台帳なら `COMMENT ON TABLE/COLUMN` が必要かもしれない。

- `architecture.md` への追記が完了条件に含まれる一方、要件では archived gate の1行だけ承認済み。#12/#13/#14やFK不変条件まで追記する範囲が、確定要件と追加設計判断のどちらか整理されていない。

- plan自身の状態記述に「OT承認待ち」と「r2の確認点は承認済み」が混在し、§8の新規判断が未承認。実装開始条件を「どの判断の承認完了か」で明確にすべき。

## リスク / 対立しうる設計判断

- 400を広く使って無限retryを抑えること vs server/deploy欠陥をclient permanentとして誤分類し、書込みを滞留させること。

- 400でpendingを残してデータ喪失を避けること vs permanent itemが自然triggerごとに再送され続けること。

- `upload_operations` をsource documentとともにCASCADE削除して整合性を単純化すること vs 冪等台帳・forensic記録を親削除後も保持すること。

- CHECKでDBを強くすること vs アプリSSoTとの二重管理およびenum追加deployの複雑化。

- migrationを単一transactionにして原子性を得ること vs CHECK全件検証・FK張替えによるlock時間とblast radius。

- 互換レイヤーを作らず一回で掃除すること vs code/migration間でupload不能時間が必ず発生すること。

- Dexieをdrop/recreateして単純なowner-scope schemaを得ること vs pending mutation喪失、複数タブupgrade、upgrade失敗への耐性。

- mutation IDだけで状態更新して実装を簡潔にすること vs owner predicateを各更新にも入れて防御を多層化すること。

- `card.create.cascadeLike` を保守的に維持して挙動変更を避けること vs 根拠のない直列化を残して性能・概念負債を継続すること。

- 死indexを削除して書込みコストを下げること vs 稀な運用queryや将来機能のため再作成が必要になること。

- TSコメントのみで意図を管理すること vs PostgreSQL metadataにもコメントを持たせ、運用者がDB単体で意図を確認できるようにすること。