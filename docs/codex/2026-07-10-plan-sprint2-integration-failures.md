# Codex plan cross-check — sprint2-integration-failures (2026-07-10)

- **作成日**: 2026-07-10
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **台帳の責務境界**
  - `integration_failures` は「外部連携・課金整合の後追い確認対象」を残す audit / ops table であり、業務状態機械ではない。
  - `source_documents.status` / `entity_mutations` と統合しない判断は妥当だが、将来 catalog 追加時に「通知ノイズ」まで吸い込まない基準が必要。

- **記録対象の絞り込み基準**
  - round 1 では「中核のみ」とされている一方、fact-finding では S4 / S6 も回収要否が中以上。
  - Sprint 2 で S4 / S6 を除外するなら、「将来取り込むべき既知ギャップ」として明示管理しないと、台帳があるのに重要 drift が SQL で拾えない状態が残る。

- **4 軸分類の安定性**
  - `service / operation / workflow / failure_code` は集計性を上げるが、DB 制約なしなので catalog が唯一の整合源になる。
  - 既存 DB 行との意味継続のため、4 軸 tuple の rename 禁止、追加で表現する運用ルールが重要。

- **catalog key の非保存**
  - DB に catalog key を保存しない設計なので、後から「どの catalog entry 由来か」は 4 軸 tuple で推定するしかない。
  - 現 7 entry は tuple が相異なる前提だが、将来 tuple が衝突すると運用上の識別性が落ちる。

- **workflow null の扱い**
  - `clerk_sync` は複数文脈から来るため `workflow = null` は合理的。
  - ただし文脈が必要な手動回収では `context` 依存になるため、context に十分な識別情報がない場合は「SQL で棚卸しできるが原因文脈は判別できない」状態になる。

- **context verbatim 保存の安全性**
  - Discord に既送の payload を DB に保存する前提は理解できるが、Discord と DB では保管期間・検索性・閲覧権限が違う。
  - 「既存 payload だから安全」ではなく、secret / token / PII / 過大 payload を増やさないレビュー観点が必要。

- **dual-write の失敗モード**
  - INSERT 成功・notifyOps 失敗は DB 行が残るので許容しやすい。
  - INSERT 失敗・notifyOps 成功は台帳欠落になるため、`ledgerWriteError` の Discord 可視化だけで運用的に足りるかは要確認。
  - INSERT 失敗時に context を mutate するなら、正常経路 byte 不変と失敗経路の差分が明確にテストされる必要がある。

- **notifyOps throw semantics と webhook 200 不変条件の衝突**
  - `notifyOps` は production webhook 未設定で throw する契約。
  - 一方で webhook handler は常に 200 が不変条件とされている。
  - helper が notifyOps throw を伝播する場合、呼び出し元の outer catch / 既存制御で本当に 200 が維持されるかを配線点ごとに確認すべき。

- **INSERT→notifyOps 順序**
  - DB を真実源とするなら INSERT 先行は妥当。
  - ただし既存 `notifyOps` のみだった箇所に DB 待ちが入るため、失敗経路の latency / DB transient failure 時の影響は throw-safe で抑える必要がある。

- **手動回収運用**
  - `resolved_at` / `resolution_note` は手動 SQL 専用だが、誰が、どの基準で、どの query を見て、どう resolve するかが曖昧だと台帳が溜まるだけになる。
  - `retry_count / next_retry_at` は dormant と決めた以上、手動運用で触らないことを明確にする必要がある。

- **index PK のみ**
  - zero-users / 手動 SQL なら妥当。
  - ただし未解決一覧は `WHERE resolved_at IS NULL ORDER BY created_at` が基本になるため、cron 導入時には partial index を足す判断が必要。

- **deletion_failures DROP**
  - zero-users なので移行不要・破壊的変更可は前提として妥当。
  - ただし参照ゼロ確認、Drizzle 型 export、既存 test、migration SQL の CREATE + DROP 目視は必須。

- **error_message nullable**
  - anomaly 系に合成エラーを作らない判断は妥当。
  - 手動 SQL で見る人にとっては `failure_code + context` が十分である必要がある。

- **user_id nullable / FK なし**
  - webhook 文脈では user が引けないため nullable は必要。
  - FK なしは audit 行残置として妥当だが、手動 JOIN 前提の query では `clerk_id / stripe_customer_id` の充実が重要。

- **テストの焦点**
  - helper 単体では順序、throw-safe、payload 不変、catalog mapping を押さえる必要がある。
  - 配線 test では「既存通知が変わっていない」と「DB 行が増える」の両方を確認すべき。
  - migration は生成物の目視が必要で、型テストだけでは不足。

## plan ドラフトへの抜け・未考慮指摘

- **S4 / S6 除外の残リスク管理が弱い**
  - plan は spec に従い対象外としているが、fact-finding 上は S4 / S6 も回収要否が中以上。
  - 実装対象外でよいとしても、session doc か TODO に「既知の未台帳化重要 failure」として残す項目があるとよい。

- **webhook 200 と notifyOps throw 伝播の検証がやや抽象的**
  - Global Constraint にはあるが、Task 2 / 3 の配線 test で「notifyOps throw 時に既存 webhook 応答契約が壊れない」ことまで見るかが明確でない。
  - helper unit だけでは呼び出し元の outer catch との相互作用は保証できない。

- **catalog tuple 衝突防止の完了条件が薄い**
  - spec は「現 7 entry の tuple は相異なる」としている。
  - plan の helper test に「全 catalog entry の 4 軸 tuple が一意」を入れると、将来追加時の事故を拾いやすい。

- **DB に catalog key を保存しないことの運用確認がない**
  - plan は 4 軸値の INSERT を検証するが、手動 runbook は 4 軸 query 前提。
  - 「catalog key は DB にないので、運用 query / docs では 4 軸 tuple で扱う」ことを session doc に明記した方がよい。

- **context 保管の安全レビューが gate に落ちていない**
  - Global Constraint に secret 混入禁止はある。
  - ただし Task 2 / 3 で新規 ref や context field を触る際、secret / token / 過大 payload が入っていないことを確認する具体ステップがない。

- **INSERT 失敗時の context mutation 仕様が細部未確定**
  - `ledgerWriteError: <msg>` を追記とあるが、元 context を破壊的に mutate するのか、notifyOps に渡す派生 object だけに付けるのかが plan 上は曖昧。
  - 正常経路 byte 不変を守るなら、入力 object の副作用なしを test した方が安全。

- **logger mock / event 名の検証が不足しうる**
  - helper 契約では `logger.error(event: integration_failures.insert_failed)` が重要。
  - Task 1 の test 項目に logger event の assert が明示されていない。

- **site 3 の workflow=null 判断は丁寧だが、実装コメントの置き場所に注意**
  - 「なぜ null か」は catalog 付近に置く方が、呼び出し site のコメントより保守されやすい。
  - plan は実装コメントと session doc としているが、catalog entry 近傍に残す指定があるとよい。

- **migration 生成タイミングのリスク**
  - Task 1 で schema に `integrationFailures` を追加し migration は Task 3 まで生成しない方針。
  - commit green は保てるが、Task 1 時点の schema と migration の不一致を許容する運用になる。チーム規律上、schema change と migration が同一 commit 必須でないかは確認点。

- **`pnpm db:migrate` を dev に適用する手順の前提**
  - read-only ではない実装 plan としてはよいが、DB 接続環境がない worker では詰まる可能性がある。
  - 失敗時の代替完了条件、たとえば migration SQL 目視 + typecheck までで止める判断基準があるとよい。

- **grep ゼロ条件の除外範囲**
  - Task 4 は migration file と docs の履歴記述を除くとしている。
  - 生成 migration の `DROP TABLE deletion_failures` は当然残るため、grep command の除外パターンを具体化しないと誤判定しやすい。

- **stg smoke の責任分界が実装 worker 外に寄っている**
  - plan は push = OT、push 後 smoke としている。
  - それ自体は運用判断だが、Sprint 完了条件と worker 停止条件が分かれるため、「実装完了」と「stg verified」の状態名を分けた方が混乱しにくい。

## リスク / 対立しうる設計判断

- **DB catalog 制約なし vs データ品質**
  - DDL 変更なしで catalog 追加できる利点がある。
  - 反面、手動 SQL や将来コードが catalog を迂回すると不正 tuple が入る。helper 経由徹底と test が実質的な制約になる。

- **4 軸のみ保存 vs catalog key も保存**
  - 4 軸のみは集計に強く、key 文字列規約依存を避けられる。
  - key 非保存は実装由来の識別が失われる。将来 tuple 衝突や分類変更があると運用上の追跡が難しくなる。

- **対象を中核に絞る vs 重要 drift も広く台帳化**
  - 中核のみはノイズを抑え、Sprint 2 を小さく保てる。
  - S4 / S6 のような中リスク failure が Discord のみに残るため、「統一台帳で拾える」という期待とのズレが残る。

- **INSERT→notifyOps vs notifyOps→INSERT**
  - INSERT 先行は DB を真実源にできる。
  - notifyOps misconfig throw 時に既に DB 行が残る片側成功を許容する必要がある。

- **notifyOps throw 伝播 vs webhook 200 不変**
  - 既存 fail-fast 契約を守るなら helper は握らない。
  - webhook 応答を絶対に守るなら呼び出し側の catch 構造確認が不可欠。

- **context verbatim 保存 vs DB 向け正規化**
  - verbatim は Discord payload byte 不変と実装単純性に優れる。
  - DB 運用では検索しづらい情報が jsonb に埋まり、保管リスクも上がる。

- **PK のみ index vs 将来 cron 前提**
  - 現スコープでは YAGNI。
  - cron 導入時に `resolved_at IS NULL` partial index を忘れると、台帳が増えた時に回収 query が重くなる。

- **手動 SQL 専用列 vs アプリ管理**
  - `resolution_note` をアプリから触らないのはスコープを抑えられる。
  - ただし誰がどう更新したかの監査性は弱い。必要なら将来 `resolved_by` / 操作ログが論点になる。