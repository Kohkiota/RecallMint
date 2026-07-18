# Codex plan cross-check — iso1-tenant-isolation (2026-07-18)

- **作成日**: 2026-07-18
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- fixture 完全性には「19 table に A/B 行が存在する」だけでなく、各テスト対象の選択条件を B 行が満たすことが必要。
  - active 状態、exam ID、更新日時、削除フラグ、`since` 範囲、JOIN 先などが A と同条件でなければ、owner 条件を外しても B 行が候補にならない。
  - 各 assertion は「A の期待行が返る／A 自身への更新・削除は成功する」という positive control も必要。B 不在だけでは空結果による vacuous green が残る。
  - write/delete は B の更新前値と更新後値だけでなく、対象関数が実際に更新を試みたことを、同条件の A 行成功で確認する必要がある。

- schema 完全性検査には二つの独立した比較が必要。
  1. アプリの Drizzle schema から得た `user_id` table 集合
  2. migration 適用後の実 PostgreSQL catalog から得た `user_id` table 集合
  - Drizzle schema だけを introspect すると、schema 定義への table 追加漏れや migration/schema drift を同時に見落とす。
  - 期待値19との比較も必要で、単に発見した集合を seed するだけでは「検出器と fixture が同じ漏れ方をする」可能性がある。

- 経路網羅は SQL idiom の類似ではなく、実装共有境界で分類すべき。
  - 同じ `and(eq(id), eq(userId))` を各所にコピーしているだけなら、一つの代表テストは他経路を保証しない。
  - factory、共通repository、共通handlerを実際に共有する family と、単に書き方が似ている family を区別する必要がある。
  - 62 `getDb()` call site を tenant-facing / tenant非依存 / webhook / operator / internal-only に棚卸しし、IN/OUTと根拠を成果物として固定する必要がある。

- mutation 実証は、除去する述語と観測する失敗の因果を確認する必要がある。
  - owner predicate 除去後に別の例外や件数変化でREDになるだけでは隔離検出の実証にならない。
  - RED時に「既知のB IDが返った」「Bの既知フィールドが変わった」「B行が消えた」を確認すべき。
  - deleteのように複数段階でowner checkする経路は、どの段階を変異させれば本当に越境するかを事前に特定する必要がある。

- test lifecycle と並列性を明示する必要がある。
  - 同一DBを `TRUNCATE + reseed` するなら、Vitest worker/file並列実行で相互破壊が起きる。
  - suite全体の直列化、worker別schema/DB、またはテスト単位transactionのいずれかを選ぶ必要がある。
  - transaction rollbackは、アプリが独自のpostgres-js接続を取得する構造では外側transactionに参加できない可能性が高い。
  - `getDb()` singletonはテスト間・env切替間で必ず`closeDb()`される設計が必要。

- globalSetup、setupFiles、アプリimportの順序を実測する必要がある。
  - migrationを行うglobalSetup自身も、接続前に同等の接続先guardを通らなければならない。
  - setupFilesでのhard-setはglobalSetupの接続先を保護しない可能性がある。
  - URL定数と検証処理を一箐所にし、provision用maintenance URLとtest DB URLの両方を検証する必要がある。

- `DROP DATABASE` は安全性・競合性の主要論点。
  - 同時実行、前回プロセスの残存接続、別worktree/devcontainerによる同名DB利用で失敗または相互破壊しうる。
  - database名の固定値だけで十分か、run固有DB名にするかを決める必要がある。
  - maintenance接続、DB作成、migration接続を例外時にも確実にcloseする必要がある。
  - `DROP DATABASE ... WITH (FORCE)` を使う場合は、誤接続防止をさらに強くする必要がある。

- allow-listはURL全体を厳密に評価すべき。
  - hostnameだけでなくdatabase名、port、protocol、空hostname、IPv6、URL parse失敗を扱う必要がある。
  - `localhost` は名前解決依存なので、「構造的に外部へ届かない」を厳密に求めるなら `127.0.0.1` 固定の方が強い。
  - guard検査後に別URLで接続するTOCTOUを防ぐため、検査済みURLそのものを接続に使う必要がある。

- migration検証はtable数だけでは弱い。
  - 「24 table」は将来の正当なmigration追加で壊れる一方、同数の誤ったschemaを見逃す。
  - migration journal、必要table名、重要column/FKの存在を確認する方が意図に近い。
  - migration folderの相対pathは実行cwd依存なので、config位置基準で解決する必要がある。

- delta fixtureには境界値設計が必要。
  - B行を `since` より明確に後に置き、A行も同範囲に置く。
  - DB時刻精度、JS Date精度、`>`/`>=`、同一timestamp、timezoneによる偶然の除外を避ける。
  - IDだけでtenantを識別できないstreamでは、既知のB row identityを確実に追跡する必要がある。

- OCR修正のaffected-row契約を呼出元まで確認する必要がある。
  - `completeUploadTx` の0件throwが既存transaction、retry、エラー分類、ユーザー向け応答に与える影響。
  - `markFailed` のwarnに個人情報や機密IDを載せないこと、既存のbest-effort契約を維持すること。
  - 0行だけでなく、想定外の複数行が不可能であること、正常時が厳密に1行であることも確認対象。
  - affected-row取得方法がDrizzle/postgres-jsの実際の戻り値と一致するか、実DBで確認が必要。

- 常駐PGの運用責務も設計対象。
  - role/database/password/認証方式、PGDATA、cluster名、port、再起動方法を固定する必要がある。
  - postStartは「cluster未作成」「既に起動」「停止中」の全状態で冪等である必要がある。
  - PGDG repo key、distribution codename、apt update、パッケージバージョン確認をpostconditionに含める余地がある。
  - `pg_isready`だけでは目的DBへの認証・migration権限を保証しない。

## plan ドラフトへの抜け・未考慮指摘

- G4の`integration_failures`除外は主要件と直接矛盾する。主入力は「全 user_id 保持tableに必ずA/B行」であり、明示された19 tableに例外はない。read経路がなくてもfixture餌データの完全性から除外する根拠にはならない。

- G4のDrizzle schema introspectionだけでは不十分。実DB catalogとの照合、期待する19 table集合との三者比較がない。

- fixture completenessは行数しか確認しておらず、「対象queryの非owner条件をB行が満たす」ことを保証していない。active/status/timestamp/FK関係など、テスト別decoy適格性のassertionが必要。

- R1/R2はB ID不在のみで、A行が実際に返ったことが明記されていない。queryが常に空でもgreenになる。

- W1/W2もA所有行への同操作成功というpositive controlが明記されていない。対象関数が何も更新・削除しなくなった退行でもgreenになりうる。

- 「代表1本 + 完全性 assertion」は異なる種類の保証を混同している。fixture完全性は未実行のコード経路を保証しない。特にW1のapply系は単なるidiom共有に見え、共通実装共有の証拠が示されていない。

- 経路IN/OUTの明示がtask成果物に落ちていない。Self-Reviewの「R/WがIN、webhook/operator/JWTはOUT」だけでは、75 import / 62 call siteのどれを対象外にしたか監査できない。OUT理由も個別または分類単位で必要。

- G2の順序記述に危険がある。`globalSetup→setupFiles→test`であるなら、setupFilesのenv-guardはglobalSetupが行うDROP/CREATE/migrateを保護できない。globalSetup自身が接続前guardを呼ぶ設計が必要。

- globalSetupがどのURLを入力としてDBをdrop/createするか不明確。setupFilesが後からhard-setするなら、globalSetupが外部`DATABASE_URL`を参照する事故がありうる。

- 固定`recallmint_test`へのDROP/CREATEと並列実行・残存接続の扱いがない。複数の`pnpm test:iso`、IDE実行、失敗後のsingleton接続で競合しうる。

- `TRUNCATE ... reseed`をper-testで行う一方、Vitestのfile/worker並列性を制限する記述がない。現状のままではflakyまたは相互汚染が強く懸念される。

- `getDb()` singletonをいつ`closeDb()`するかがない。test file間、suite teardown、失敗時に接続が残り、DROP DATABASE失敗やプロセスhangにつながる。

- auth seamのmock方法が曖昧。Vitestのmodule cacheと静的import順により、`withTenant()`内でmockを切り替えても対象moduleが既にcaptureした関数へ反映されない可能性がある。tenant切替の実証testが必要。

- G3の「24 table count」はmigration成功条件として脆弱。table名・migration journal・必要schemaの確認がない。

- migration path `./drizzle/migrations`がcwd依存。IDEや別scriptからの実行で壊れる可能性が未考慮。

- allow-list unit testのRED条件が不適切。「guard除去でunit testが通過」は通常、throw期待testなら失敗するはずで、記述が論理的に曖昧。安全guardのmutationは、危険な接続を実際に試みず、接続関数が呼ばれる前に停止したことをspyで確認すべき。

- allow-listにport制約がない。localhost上の別用途PGを破壊する可能性が残る。database suffixだけでDROP許可するのも弱く、固定DB名または固有prefixの方が安全。

- R1のpredicate変異が二候補併記され、どちらを代表REDにするのか不明。JOIN有無を別境界として採用したなら、各境界の代表性とmutation要否を整理すべき。

- W2の`deleteExam`は三段階owner checkであり、単一predicate除去だけではB削除まで到達しない可能性がある。変異対象と期待される越境経路の因果が未検証。

- OCR REDの表現が曖昧。「A文脈」は関数引数の`userId=A`を意味するのか、auth mockを経由するのかを固定すべき。DB層関数を直接呼ぶだけなら、上位auth経路を検証したとは主張できない。

- OCRのGREENに「0行 affected」とあるが、関数契約上`completeUploadTx`はthrow、`markFailed`はwarnであり、呼出側からaffected rowsを直接観測できない可能性がある。観測可能な期待結果を関数ごとに分ける必要がある。

- devcontainer postconditionに実際のtest role/database URLでの接続確認がない。`postgres` roleで`SELECT 1`できてもsuiteが動く保証にはならない。

- PG17のmajor確認だけか、prod相当17.6をどこまで要求するかが未記載。要件が「PG17」で十分なら、その非同一性を明示して誤った本番同一主張を避けるべき。

- 通常CIやlaunch gateで`test:iso`を誰がどこで実行するかがない。devcontainer限定なら、CI非実行による将来のsilent regressionをどう防ぐかが未解決。

## リスク / 対立しうる設計判断

- 固定DB vs run固有DB
  - 固定DBは簡単だが、並列実行・誤DROP・残存接続に弱い。
  - run固有DBは安全性と並列性が高いが、作成・cleanup・失敗残骸管理が増える。

- TRUNCATE/reseed vs DB再作成 vs worker別schema
  - TRUNCATEは速いが直列化必須。
  - DB再作成は強い隔離を得られるがmigrationコストが高い。
  - worker別schema/DBは並列化できるが、URLとmigration管理が複雑になる。

- 網羅的behavioral test vs shared-family代表
  - 代表主義は実行時間と保守性に優れる。
  - ただし実装を共有していないコピーSQLには適用できず、セキュリティ保証が過大になる。family判定基準を厳格にする必要がある。

- schema自動発見 vs 明示expected list
  - 自動発見は将来tableを検知できる。
  - 明示listは意図しない減少を検知できる。
  - どちらか一方ではなく、実DB・Drizzle・expected listの一致確認が妥当。

- localhost許可 vs `127.0.0.1:固定port`限定
  - localhost許可は環境互換性が高い。
  - 固定IP/portは誤接続防止が強い。launch blocker向け安全境界としてどちらを優先するか明示が必要。

- PGの常駐運用 vs suite自己完結
  - 常駐PGは本番に近く高速。
  - 環境ドリフト、cluster停止、開発者ごとの差異が増えるため、厳密なpreflightと診断メッセージが必要。

- OCR 0件をthrowするか冪等成功にするか
  - throwはowner不一致や消失を明確に検知できる。
  - retryや既完了状態を許す設計とは衝突しうる。既存呼出契約と状態遷移を確認して決める必要がある。

- suiteを通常testから分離する判断
  - 日常実行は軽くなる。
  - セキュリティ回帰がCIで実行されない危険が増える。少なくとも必須CIジョブまたはmerge/launch gateへの明示的組込みが必要。