# Codex plan cross-check — card-tags-delta-completeness-plan (2026-08-17)

- **作成日**: 2026-08-17
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **I-1 の保証範囲は「by-card SELECT 時点」に限定される**

   authoritative replace により、その SELECT 時点の集合一致は成立する。ただし SELECT 後に別 transaction がタグを変更した場合、応答は返却時点の最新状態ではない。これは仕様上許容されるが、「次回 delta で必ず収束」という説明は §6-③ の timestamp/commit 順序 hazard が未解決な限り絶対保証にできない。  
   「今回の恒久欠落を防ぐ保証」と「将来必ず収束する保証」を分けて記述すべき。

2. **RLS 第2層を独立に検証する試験条件が必要**

   通常の `userId=A, cardIds=[B]` は明示 user predicate だけで空になるため、RLS がなくても通る。RLS 単独を実証するには、tenant context=A のまま、helper 引数を `userId=B, cardIds=[B]` として、predicate が B 行を候補にする条件で RLS が遮断することを確認する必要がある。

3. **full fallback の条件は「cursor 欠落」だけではない**

   現物の `parseSince` は欠落・不正値の両方を `undefined` にする。したがって skip 条件の実際の意味は「`sct === undefined`（欠落または不正）」である。  
   不正 cursor を意図的に full fallback として扱うのか、欠落だけを想定した契約なのかを明示する必要がある。現在の I-4 の自然言語と実装条件にずれがある。

4. **card_tags 自体の tenant 整合性は schema だけでは完全には保証されない**

   `card_tags` は `card_id`、`option_id`、`user_id` が個別 FK で、同一 user に属する組合せを褨合 FK で保証していない。明示 `user_id` predicate は必要だが、壊れた行の `card_id`/`option_id` 所有者まで検証するものではない。  
   writer 検証を信頼境界とするなら、その前提を明示すべき。少なくとも本修正がこの既存リスクを解決しないことは区別した方がよい。

5. **bind 上限は発生時に endpoint 全体を 500 にする**

   6.5万 card を非現実的として受容する判断自体は可能だが、超過時は一部劣化でなく pull 全体の失敗となる。プラン制限が DB 制約でないなら、運用上の上限変更・大量 import・異常データによって前提が崩れる。監視指標、エラー識別、上限再評価条件が必要。

6. **性能評価は行数だけでなく query/serialization のコストを見る必要がある**

   full pull 以下の行数でも、増分 SELECT と大きな `IN (...)` query の両方を実行し、変更 card 分の増分行を後で捨てる。DB bind/parse、メモリ、JSON serialization、route timeout の追加コストは full pull と同値ではない。実測対象として変更 card 数、by-card 行数、応答 byte 数、latency を持つべき。

7. **既存欠落データの回復は rollout の安全条件そのもの**

   prod 利用者が存在する場合、未更新 card は回復せず、その間の編集で server 損失が確定しうる。したがって「prod 未リリース確認」は単なるチェック項目でなく、本設計だけで rollout 可能かを決める hard gate。確認不能時の代替策も rollout 前に決定が必要。

8. **既発生した server 損失には修正能力がない**

   authoritative replace は現在の server 真値を配るだけなので、すでに server から消えた関連を復元しない。stg A の損失をどう扱うか、prod に類似損失がないことをどう確認するかは別のデータ修復判断になる。

9. **障害時の原子性は HTTP 応答単位だが、追加 query が可用性を下げる**

   by-card query が失敗すれば pull 全体が 500 になり、古い不完全 payload を返すより安全ではある。一方で、新たな timeout/error 面になる。部分応答しないこと、cursor を進めないことが既存 client behavior とともに確認対象。

10. **発行条件の将来変更に弱い契約**

    full-stream skip の正当性は、無制限・無 pagination・owner 全件という実装詳細に依存する。テスト pin に加え、将来 pagination を導入する場合は route の skip 条件も同時変更が必要という設計依存を API 契約として残す必要がある。

11. **観測可能性が不足している**

    hotfix 後に期待どおり by-card が動作しているか、異常に大きな fan-out がないかを把握する情報がない。少なくとも既存 logging/metrics 方針との整合、`changedCardIds.length`・取得行数・query failure の監視要否を判断すべき。

---

## plan ドラフトへの抜け・未考慮指摘

1. **Task 1 の「owner 第2層」試験は RLS を独立に証明していない**

   計画の negative は `(userId=A, tenant=A, cardIds=[B])` なので、A predicate が先に B を除外する。RLS を外しても通るため、第2層 pin になっていない。  
   `asTenant(A)` 内で `getCardTagsByCardIds(B, tx, [B])` が空になる試験など、predicate を通過させて RLS に遮断させる条件が必要。

2. **spec の完了条件と Task 4 の完了条件が矛盾している**

   spec §7-4 は「stg smoke PASS」を完了条件にしている。一方 plan は push 前 checkpoint で停止し、stg smoke を後段扱いにしながら Task 4 を完了としている。  
   「実装完了」と「rollout完了」を別 milestone にするか、Task 5 として deploy build・smoke・証拠記録・最終 reviewed 確定を置く必要がある。

3. **Vercel build 成功の確認工程が plan 本体にない**

   build をローカル gate から外す根拠は「push 後 Vercel build + smoke」だが、その実施・失敗時対応・対象 commit SHA 確認がチェックリスト化されていない。後段 gate に依存するなら明示タスクが必要。

4. **prod 未リリース確認が「報告文への記載」に留まっている**

   OT の回答取得、記録場所、prod 反映を止める条件がない。「確認できない場合に cursor migration/backfill 裁定を完了するまで rollout blocked」とする明示的 checkpoint が必要。

5. **RLS 第1層 red と第2層 red の対称性がない**

   predicate 削除変異は第1層をよく検証するが、RLS policy 無効化相当で第2層試験が落ちる実証がない。少なくとも第2層試験が predicate にマスクされない形であることを red で確認すべき。

6. **不正 `since_card_tags` の発行条件 test がない**

   route の実条件は `sct !== undefined` なので、不正 ISO も全件 fallback + by-card skip になる。この behavior を契約とするなら pin が必要。契約しないなら parse 結果と「欠落」の区別を設計し直す必要がある。

7. **by-card helper の空配列直接呼出契約が未定義**

   route は空配列時に呼ばないが、export helper 自体が `cardIds=[]` を受けた場合の挙動は未規定。Drizzle の `inArray(..., [])` の生成挙動に依存させるのか、caller-only precondition とするのか明記がない。

8. **query failure/500 の route pin がない**

   by-card rejection 時に response が 500、cursor/payload が返らず、logger が呼ばれることを既存汎用 error testが本当に覆うか確認されていない。新規 query の配線ミスや例外が部分成功にならないことを固定した方がよい。

9. **full-stream contract test の ground truth 時点が曖昧**

   ground-truth read と `getCardTagsDelta` は別 statement/transaction になりうる。fixture が静的なので実用上は比較できるが、「同一 snapshot の authoritative 性」を試験しているわけではない。試験が固定するのは「静的データに対する全件・無LIMIT契約」と正確に表現すべき。

10. **iso fixture への追加 seed の副作用管理が弱い**

    共有 `beforeAll` で A の2本目を追加すると、既存テストが暗黙に1行を期待していないこと、option/card/user の整合した seed であること、重複時刻や cleanup が問題にならないことを確認する工程がない。専用 describe/fixture の方が隔離性は高い。

11. **性能・運用観測の実行項目がない**

    bind 上限を受容し、量的互換を主張している一方、テストや smoke で changed card 数、応答行数、応答 byte、latency を記録しない。少なくとも実測値を session doc に残す項目が欲しい。

12. **stg smoke の失敗時の復旧手順がない**

    A アカウントのデータを実際に変更するが、途中失敗時の期待状態、`x` が残った場合の cleanup、S に戻せなかった場合の停止・証拠保全が定義されていない。

13. **既発生 stg 損失の扱いが Task 化されていない**

    spec では OT 確認事項だが、plan の checkpoint では follow-up 3件と prod 条件しか明示されず、stg A の既発生実損に対する裁定取得が抜けている。

14. **「server 2 file のみ」という表現が変更範囲と紛らわしい**

    実際には route/test、iso test、client test、session doc を変更する。「production code は2 fileのみ」と明記しないと、凍結された変更範囲との照合で誤解を生む。

15. **reviewed 状態の意味が工程内で揺れている**

    Task 1/2 commit に `[reviewed]` を付ける一方、spec は stg smoke 後の session doc を正記録とする。code-review 完了とデータ保全の実機検証完了を別状態名・別証跡として扱わないと、途中 commit が rollout-ready に見える。

---

## リスク / 対立しうる設計判断

- **単一大規模 `IN` vs chunking**  
  現状は単純性を優先して上限リスクを受容。hotfix として合理性はあるが、上限が運用慣行にしか依存しない。少なくとも再検討閾値と監視が必要。

- **READ COMMITTED 維持 vs repeatable-read snapshot**  
  authoritative replace は局所的 I-1 を満たす。一方、応答全体の時点整合性や writer 競合まで強く保証しない。隔離レベル強化は意味論を明快にするが、競合・コスト・既存 endpoint への影響が大きい。

- **発生源 hotfix vs client whole-set replace の防御強化**  
  server payload を直すのは最小修正。ただし別原因で local mirror が欠ければ server 実削除へ増幅する構造は残る。差分 op 化は長期的な防御だが、scope と移行コストが大きい。

- **自然回復 vs 強制 backfill/full pull**  
  prod 未リリースなら自然回復で十分。既存利用者がいるなら自然回復はデータ保全要件を満たさず、cursor migration・強制 full pull・修復処理のいずれかが必要。

- **full fallback の寛容性 vs 不正 cursor の fail-closed**  
  不正 cursor を全件 fallback にする現在の設計は可用性・自己回復に寄るが、大量応答を誘発する。400/reject は負荷を抑える一方、古い client や壊れた local state の回復性を下げる。

- **追加 observability vs hotfix の変更面積**  
  metrics/logging は異常 fan-out の早期発見に有効だが、「production code 2 file」の範囲やログ量を増やす。少なくとも既存基盤で取得可能な情報を確認し、追加しない判断も明文化すべき。

総評として、authoritative replace 自体は主障害に対する整合的な修正です。最重要の plan 修正点は、**RLS 第2層試験が実際には RLS を試していないこと**と、**stg smoke を spec 上の完了条件にしながら plan 上は実施前に完了扱いしていること**です。