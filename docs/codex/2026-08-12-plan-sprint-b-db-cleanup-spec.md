# Codex plan cross-check — sprint-b-db-cleanup-spec (2026-08-12)

- **作成日**: 2026-08-12
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **確定裁定と設計裁量の境界**
   - `assets.status` と `entity_mutations.op` は要件上、CHECK 対象として明示されている。既存 comment との衝突は「CHECK を除外する理由」ではなく、comment を新しい裁定に合わせて更新する対象。
   - `entity_mutations.op` の registry を SSoT とするなら、DB CHECK との二重管理をどう機械的に同期するかが設計課題。手書き二重定義、共有定数からの生成、migration test による一致検証など、実現形を決める必要がある。
   - `assets.status` も状態追加時に migration が必要になること自体を受け入れるのが今回の裁定と読める。

2. **CHECK 制約の選定と厳密な本数**
   - 対象列、本数、制約名、NULL 許容、許容値を一意な一覧にする必要がある。
   - 非負制約は少なくとも以下の性質を区別すべき。
     - NULL 不可列: `col >= 0`
     - NULL 可列: PostgreSQL の CHECK は NULL を通すため、NULL 許容を意図したものか明記
     - 相関制約候補: `correct_count <= review_count`、`pages_processed <= pages_total` など。今回張らないなら、単列非負だけを対象とすることを明記
   - `width` / `height` は「非負」で 0 を許すのか、「正」であるべきかを現行生成経路から確認する必要がある。
   - `attempt_count`、`expected_source_count`、`lease_version` など、調査結果にある数値列のうち何を採るかが未確定。要件の「15〜20本」と実列挙を一致させる必要がある。
   - CHECK 名は将来の障害解析や rollback に使うため、命名規約も spec に必要。

3. **CHECK 導入前検証**
   - runbook の SQL は単なる count だけでなく、違反時に対象 PK と値を特定できる diagnostic query が必要。
   - enum は `NOT IN (...)` だけだと NULL を検出しない。NULL 可否を別途検査する必要がある。
   - 事前確認から DDL 適用までに書き込みが入る TOCTOU がある。ユーザー0でも webhook、運用 SQL、ジョブなどの書き込み可能性を確認し、適用窓・停止対象・トランザクション境界を定めるべき。
   - PostgreSQL のロック時間を抑える必要がある環境なら、`NOT VALID` → `VALIDATE CONSTRAINT` → 正式化の要否も判断対象。

4. **`source_document_id` NOT NULL 化**
   - 「現在の生成経路では必ず入る」だけでなく、既存行、テスト fixture、seed、管理 script、失敗復旧経路、直接 SQL の全書き手を確認する必要がある。
   - null guard 撤去後、abandoned operation の処理が「関連 source document が必ず存在する」という別の不変条件に依存する。NOT NULL FKであること、参照先削除時の挙動も確認が必要。
   - migration とアプリ deploy の間に旧コードが NULL を書けないことを保証する rollout 順序が必要。

5. **削除列と API・wire shape の波及**
   - DB参照だけでなく、Zod schema、DTO、server action return type、serialized RSC props、pull cursor/payload、test fixture、seed、audit script、ドキュメントを対象に含める必要がある。
   - `archived_at` の削除は、列だけでなく `exam_not_found` の `archived` discriminator、UI表示、upload拒否理由を変える。互換レイヤー不要でも、全呼び出し側の exhaustive switch や fixture の追随が必要。
   - `card_count` の削除では、bump 関数だけでなく transaction 構成、mock、負数防止テスト、OCR一括作成・削除時の副作用がなくなることを確認すべき。
   - `upload_records` の削除列は通常 publish と失敗記録の両経路を網羅する必要がある。

6. **Dexie schema upgrade**
   - `user_settings` drop と `entity_mutations` 再作成を、具体的な Dexie version 列として設計する必要がある。
   - store の drop→create は端末上の未同期 mutation を消失させる。ユーザー0前提で許容するなら、その破壊を明示するべき。許容しないなら upgrade transaction 内で `user_id` を補完できるか、補完不能行をどう扱うかを決める必要がある。
   - ログイン切替時に旧 owner の pending/synced/failed 行が残るため、単に index を owner付きにするだけでなく以下が必要。
     - enqueue 時の owner 固定
     - flush select の owner条件
     - success/failure update の owner条件
     - retry、隔離、cleanup の owner条件
     - logout/user-switch時の扱い
   - user ID が取得できない時に enqueue を拒否するか保留するかも必要。
   - `[user_id+sync_status]` 以外の既存 query/index が失われないか確認が必要。

7. **owner-scope のセキュリティ境界**
   - client の owner-scope は誤送信防止であり、認可境界そのものではない。server は認証 user を正本として mutation を適用し、client supplied user ID を信頼しないことを明記すべき。
   - 同じ mutation ID を別 user が送った場合の UNIQUE 制約とdedupe queryの意味を確認する必要がある。グローバル UNIQUEなら他 user が衝突を誘発できないか、ownerとの複合一意性が必要かを検証すべき。

8. **`classifyBulkError` の分類契約**
   - 「permanent DB error」を列挙方式にするなら、対象外コードが transient に落ちる保守的方針と、その監視方法が必要。
   - `23505`、`23503` は常に client 不正とは限らず、順序競合、重複処理、server側実装不整合でも起こりうる。400で outbox を最終失敗にするなら、各 route で本当に再送不能か確認が必要。
   - `42601`、`42703`、`42P01`、`42883` は明確な server/deploy defect。HTTP 400 にすると client責任に見え、書き込みを永久放棄する危険がある。「永続的」と「client 4xx」は別軸として設計すべき。
   - SQLSTATE が `cause` chain、driver wrapper、aggregate errorのどこにあるか、循環 cause、非文字列 code、Zodとの優先順位をテストする必要がある。
   - 400応答後に client が対象行を `failed` にするのか削除するのか、ユーザーへの可視化・運用ログ・再実行手段も契約に含めるべき。

9. **migration と deploy の原子性・rollback**
   - `code deploy → migrate` では、新コードが旧schema上で動作できることを列ごとに確認する必要がある。
   - migration後に旧インスタンスや旧workerが残ると、削除列をSELECT/INSERTして失敗する。全実行主体の drain 条件が必要。
   - DROP COLUMN後のアプリrollbackは不可能。バックアップ、rollback方針、migration適用失敗時の停止点をrunbookに記載すべき。
   - DB schema、Drizzle migration、snapshot/meta、schema.tsの整合確認を完了条件に含める必要がある。

10. **index削除の確認範囲**
    - production queryだけでなく、FK親削除、運用SQL、cron、migration、EXPLAIN上の利用も考慮する必要がある。
    - `source_docs_user_exam_idx` が複合indexのprefixで代替できることは、列順・sort方向・partial条件まで比較すべき。
    - index drop後の主要queryについて、少なくとも代表的な `EXPLAIN` または論理的な代替index対応表が必要。

11. **コメント更新の正確性**
    - 表数はmigration適用後の schema から機械的に再集計すべき。
    - user CASCADE は「歪みを解消」したのではなく、「不発であることを正しく文書化」しただけ。機構上の歪みは意図的に維持される。
    - 将来 archive を再設計する際の注意は、削除済み列に隣接するschema commentには残せない。architecture/backlog/specなど、存続する正本を決める必要がある。

12. **検証範囲**
    - test削除だけでgreenにせず、削除後の現行挙動をpinする置換テストが必要。
    - 特に以下は明示的な回帰テスト対象。
      - archived条件なしでexam一覧・uploadが動く
      - card create/delete/OCR後も一覧件数がDexie動的集計で正しい
      - ownerの異なるmutationをflush/updateしない
      - Dexie upgradeが期待どおりstoreを生成する
      - 全CHECKの境界値、NULL、違反値
      - NOT NULL違反
      - permanent/transient/unknown SQLSTATE と nested cause
      - migrationを空DBとSprint A適用済みDBの双方に適用できる

## plan ドラフトへの抜け・未考慮指摘

1. **確定要件を再裁定しようとしている**
   - §5.2、§7、§8確認点1で `assets.status` と `entity_mutations.op` をCHECK対象外としているが、主入力では両方が対象として確定済み。
   - 「採否の再検討は不要」という前提にも反する。必要なのは除外提案ではなく、既存comment/registryとの整合方法。

2. **CHECKの本数が内部矛盾している**
   - 「enum 11 + 非負 8 = 19」とある一方、非負欄には少なくとも以下の14列が列挙されている。
     - `ai_usage` 2
     - `source_documents` 3
     - `upload_records` 1
     - `study_days` 3
     - `assets` 3
     - `upload_operations` 2
   - これならenumと合わせて25本であり、「19本」「15〜20本」と一致しない。
   - どの列を採用・除外するかと理由を確定一覧にする必要がある。

3. **要件上のCHECK対象との対応が不完全**
   - 要件にある `entity_mutations.op` と `assets.status` が欠落。
   - 一方で `source_documents.file_type` や `contact_messages.status` などを追加している。追加自体はあり得るが、確定対象・例示対象・任意追加対象を区別していない。
   - `users.plan` 等で NULL 可否やdefaultとの整合が十分記述されていない。

4. **`classifyBulkError` が「永続性」とHTTP責任区分を混同**
   - syntax error、undefined table/column/function を400にする設計は、server defectをclientの永久失敗として処理する恐れがある。
   - 「400分岐を到達可能にする」という要件は満たせるが、すべてのpermanent SQLSTATEを400へ送る必要までは示されていない。
   - route別の実際のoutbox挙動と、失敗の可視化・復旧方法が未記載。

5. **Dexie version設計が曖昧**
   - 「v11でstore再作成」「drop → createの2 version」と同時に書かれている。2 versionなら通常は別version番号が必要。
   - `user_settings` dropとの順序、最終stores定義、upgrade callback、既存データ消失の扱いがない。
   - queued entity mutationを全消去してよいかが明示されていない。

6. **owner-scopeの網羅性が不足**
   - pending selectとsynced/failed update以外に、retry、cleanup、30日隔離、bulk result対応、logout/login切替をowner-scopeする記述がない。
   - server側認可との境界、mutation ID uniquenessとの関係もない。

7. **NOT NULL化の依存確認が狭い**
   - 列を読むnull分岐は挙がっているが、全INSERT、fixture、seed、script、復旧処理が非NULLを保証することの一覧がない。
   - FK参照先が存在しないケースと、source document削除時の挙動も未整理。

8. **migration rolloutの説明が不足**
   - `code deploy → migrate` とだけあり、旧worker・旧server instance・queue consumerのdrain条件がない。
   - DROP後のrollback不能性、バックアップ、部分適用時の復旧がない。
   - 事前検査後の競合書き込み対策がない。

9. **事前確認SQLが抽象的**
   - 「全件についてSELECT count」としかなく、実SQL、NULL条件、違反行特定、期待結果、失敗時の判断が定義されていない。
   - constraint名、追加順、transaction単位もない。

10. **削除対象コードの列挙に取りこぼし防止策がない**
    - file:lineはあるが、型生成物、Zod、test factory、mock、snapshot、docs、SQL scriptの検索条件・完了判定がない。
    - line番号は実装時にずれるため、file:symbol中心の対応表が望ましい。

11. **index削除の性能検証がない**
    - query不在確認だけで、FK操作・運用SQL・代替indexの完全な対応が記載されていない。
    - `source_docs_user_exam_created_idx` が本当に全用途をprefixで代替することを明示すべき。

12. **「歪み解消」の表現が過大**
    - user CASCADEはcomment修正のみなので、#1は「解消」ではなく「意図的維持・誤説明のみ解消」。
    - W-only表も維持されるため、歪みというより「意図未記録の解消」。
    - 対応表はコード/DDL上の解消、文書化のみ、非スコープを分けるべき。

13. **匿名問い合わせPIIについて事実関係が不整合**
    - 調査結果は「残余リスク一覧に匿名行への言及なし」とする一方、planは「architecture.mdで公開前判断として管理中」と断定している。
    - Step 0後に文書が更新されたのでなければ乖離。根拠箇所を示すか、「未記録」のまま残ることを明記すべき。

14. **将来archive再導入の記録場所が曖昧**
    - 「schema/session docに残す」とあるが、列自体を削除するためschema上の自然な隣接先がない。
    - 非スコープの将来設計事項をどの永続ドキュメントで管理するか決める必要がある。

15. **完了条件が広い一方、重要なmigration検証が具体化されていない**
    - migrationのforward適用、schema snapshot一致、制約違反試験、Dexie upgrade試験、旧shape不存在の検索などが明示されていない。
    - 「Critical 0・Important 0」は判定主体・対象差分・基準が不明。

## リスク / 対立しうる設計判断

| 論点 | 一方の判断 | 反対側のリスク |
|---|---|---|
| permanent DB error | 400で即時永久失敗 | server/deploy defectでもclient writeを放棄する |
| unknown DB error | transient維持 | 恒久障害を無限再送し続ける |
| CHECKとregistry | DBにも値域を持つ | 語彙追加時にmigrationが必要、二重定義化 |
| registryのみ | 変更が軽い | DB直接書込・バグ経路から不正値が入る |
| Dexie store再作成 | 実装が単純 | 未同期mutationが消失する |
| Dexieデータ移行 | pendingを保全 | ownerを安全に補完できず、誤帰属の危険 |
| DROP COLUMN先行掃除 | schemaを直ちに簡潔化 | rollback不能、旧instanceとの混在に弱い |
| 段階的rollout | 運用安全性が高い | ユーザー0・互換不要という前提に対して過剰になり得る |
| 単列非負CHECKのみ | 本数と変更範囲を抑制 | `correct_count > review_count` 等の意味的不整合は残る |
| 相関CHECKも追加 | DB invariantが強くなる | 今回の確定範囲を超え、既存データ・書込順への影響が増える |
| indexをquery不在で削除 | 書込コストとschemaノイズを減らす | FK削除、運用SQL、将来調査の性能を落とす可能性 |
| user CASCADE維持 | 将来の物理削除へのdefense | 現行削除機構を誤認しやすく、二重の寿命モデルが残る |

最大の修正点は、確定裁定に反するCHECK除外を撤回すること、CHECK対象と本数の矛盾を解消すること、そしてDexie owner-scope移行時の既存outbox消失とSQLSTATE→400の永久失敗リスクを設計上明文化することです。