# Codex plan cross-check — card-tags-delta-completeness (2026-08-17)

- **作成日**: 2026-08-17
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **完全性の定義を時点・owner込みで固定する必要がある**

   「変更 card の全集合」は、少なくとも次を明文化すべきです。

   - 応答中の `cards` に含まれる、当該 user 所有の各 card が対象
   - `card_tags` は by-card SELECT 時点で存在する全行
   - タグ 0 件も「空集合」として成立する
   - 増分由来行を含め、同一 `(card_id, option_id)` は高々1行
   - 変更 card 以外の通常増分行も失わない

   特に「全集合」は独立した wire key ではなく、`cards` と `card_tags` の組合せから暗黙に表現されます。将来 server/client の片側だけが変更されると再び契約が崩れやすいため、型だけではなく route レベルの契約 test が必要です。

2. **cursor の要件は「union 非影響」だけでは足りない**

   必要な性質は次の2つです。

   - by-card 行が `cursors.card_tags` を前進・後退させない
   - 応答 cursor がリクエスト時の既存 cursor より後退しない

   特に増分 rows が空のとき、`ct.maxCreatedAt = null` をそのまま返し、client が既存 cursor を `null` で上書きする実装なら、次回 full pull 化します。既存 route が `maxCreatedAt ?? since` 等で保持しているかを明示的に確認すべきです。「null variant の test」は、単に null を期待するのではなく、実際に serialize される cursor の単調性を検証する必要があります。

3. **同一トランザクションと同一スナップショットは同義ではない**

   PostgreSQL が既定の `READ COMMITTED` なら、同じ `withTenantTx` 内でも各 SELECT は異なる snapshot を見得ます。今回の完全性は通常、by-card SELECT 時点の集合として成立しますが、「6/7 stream 全体が同一 DB snapshot」という保証まではありません。

   したがって設計上は、次を区別すべきです。

   - 必須保証: cards 由来の削除対象について、by-card SELECT が返した集合で安全に再構築できる
   - 非保証: 応答全 stream が厳密に同一時点を表す

   これを曖昧にすると、後で tx 内に置いたことを snapshot consistency の根拠として誤用する危険があります。

4. **owner-scope は「predicate を生成した」だけでなく「最終 WHERE に結合された」ことが必要**

   `eq(cardTags.userId, userId)` と `inArray(...)` が個別に呼ばれたことだけでは、最終 query がその両方を使用した証明になりません。必要なのは以下です。

   - `AND(user_id = ?, card_id IN (...))` が実際の WHERE に入る
   - card IDs は scoped な `cards` query の結果だけから導出される
   - RLS がなくても明示 owner predicate 単独で越境を防ぐ
   - RLS はあくまで第二層

5. **変更 card ID の件数上限は実測1209件からは導けない**

   「user の card 総数だから PostgreSQL bind 上限に余裕」という主張は、現在の stg データについてだけ成立します。仕様上 card 数に上限がなければ、将来は以下が起こり得ます。

   - bind parameter 上限超過
   - 巨大な `IN` による query plan・メモリ・応答時間悪化
   - payload サイズ、serverless timeout、クライアント parse/transaction 時間の増大

   hotfix で chunking を入れない判断は可能ですが、その場合は「既存のシステム上限で安全」または「既知の運用リスクとして受容」のどちらかを根拠付きで記録すべきです。

6. **by-card SELECT のスキップは意味論的な同値性で判断すべき**

   変更 ID 0 件時のスキップは無条件に正しいです。

   `since_card_tags` 欠落時のスキップは、次の条件がすべて成立する場合のみ正しいです。

   - cursor 欠落が確実に「owner の全 `card_tags` を返す」意味である
   - full query に limit、pagination、別の visibility 条件がない
   - full query と cards query が同じ tenant tx 内にある
   - mapper/filter により一部行が除外されない

   単に「since がない」ことと「完全 snapshot」であることを同一視せず、`getCardTagsDelta` の契約として pin すべきです。

7. **deploy 互換性は wire shape だけでなく量的互換性も必要**

   key や行 shape は additive でなく実質「同じ配列の件数増加」なので、旧 client の構文互換性は高いです。一方で確認対象には以下も含まれます。

   - client response validator に配列件数や body size の制約がないか
   - API/CDN/serverless の response size 制限
   - 大きい `bulkPut` を既存 Dexie transaction が処理可能か
   - 旧 client が `card_tags` を純粋な増分とみなす別処理を持たないか

8. **既存 local 欠落は deploy だけでは全面回復しない**

   修正後に自然回復するのは、次のいずれかを満たす card だけです。

   - 再び cards delta に載る
   - full pull が実行される

   過去に欠落し、その後更新されない card は欠落したままです。さらに回復前に whole-set 書込みをすると server 損失が確定します。prod 未公開が事実なら影響は限定できますが、これは rollout 前に確認すべき前提です。

9. **検証は件数ではなく集合一致で行う必要がある**

   総件数 `N` 維持だけでは、別 card の欠落と重複・追加が相殺される偽陰性があります。最低限、変更 card ごとに `(card_id, option_id)` 集合が server と client で一致することを検証すべきです。

10. **最重要の回帰 test は実際の障害シーケンスである**

   mock の union test だけでなく、次の一連を1本で検証する価値があります。

   1. 古い `card_tags.created_at` を持つタグ付き card を作る
   2. card だけを更新して `cards.updated_at` を進める
   3. `since_cards` と `since_card_tags` が異なる delta pull を実行
   4. server response が当該 card の全集合を含む
   5. client delete＋bulkPut 後も集合が一致する
   6. cursor が前進または維持され、逆行しない

   これが Fault B の機序そのものを固定する test になります。

## plan ドラフトへの抜け・未考慮指摘

1. **I-2 が cursor の完全な単調性を規定していない**

   「増分 query の rows のみから算出」は必要条件ですが十分条件ではありません。空増分時に既存 cursor を保持するのか、`null` を返すのかが未定義です。§4-1の「null variant」は、この点を誤って pin する可能性があります。

2. **I-1 の時間的意味が曖昧**

   「server 上の完全な集合」が、transaction 開始時点、cards SELECT 時点、by-card SELECT 時点のどれか不明です。`withTenantTx` を根拠に応答全体が同一 snapshot だと読める記述は避けるべきです。

3. **query-shape test が偽陽性になり得る**

   `eq()` と `inArray()` の呼出 spy は、両 predicate が最終 WHERE に使われたことまでは保証しません。また、RLS 有効下の isolation test は明示 predicate 欠落をRLSが覆い隠します。最終 query 構造の確認、またはRLSに依存しない条件で第一層を検証する必要があります。

4. **route mock と DB isolation が分断されている**

   route test は mock による union、integration test は helper 単体です。この組合せでは、route が実 helper を誤った引数・tx・条件で呼ぶ接続不良を見逃し得ます。少なくとも1本、実DBからroute相当の response 完成までを通す契約 test が欲しいところです。

5. **`since_card_tags` 欠落時スキップの前提 pin がない**

   §4-2は「不呼出」だけを pin していますが、「既存 full delta が by-card 結果の超集合である」ことを直接証明していません。将来 full query に limit等が入ると、スキップ testだけgreenのまま完全性が壊れます。

6. **changedCardIds の上限・重複・query性能の扱いが弱い**

   「実測最大1209」は仕様上限ではありません。重複 ID の除去要否、巨大 `IN`、該当 index、bind上限、payload上限について、確認済みか受容リスクかの区別が必要です。

7. **deploy互換の量的検証がない**

   「旧 bundle は冪等 bulkPut」のみで互換と結論していますが、大量応答時の validator、body size、Dexie transaction の負荷は未考慮です。

8. **既存 local 欠落の回復説明が楽観的**

   「次に cards delta に載った時点」は正しいものの、載らない card は回復しません。hotfix deploy直後から全 client が健全になるようにも読めます。prod未公開の確認を完了条件または rollout 条件に置くべきです。

9. **stg smoke の `N件のまま` は偽陰性がある**

   総数だけでなく、境界5 cardおよびFSRS対象cardのタグ pair 集合を比較すべきです。Network上の件数も、旧タグが正しく同梱された証明にはなりません。

10. **FSRS smoke 後の server非破壊確認が不足**

    local表示不変だけでなく、修正後にタグ操作を1回行っても、意図した add/remove 以外の server tag が消えないことを確認すると、Criticalと評価された伝播経路まで閉じた証拠になります。ただし stgデータを意図的に変更するため、実走条件の明示が必要です。

11. **union順序を契約にしない旨がない**

    `Map` により増分側が先、by-card追加分が後になりますが、配列順は意味を持たないはずです。testが偶然その順序を固定しないよう、集合としてassertする必要があります。

12. **完了gateで build省略の根拠が弱い**

    route/libのみでも、型・bundle・server runtime境界の問題は `typecheck` だけで常に検出できるとは限りません。buildを必須にしないこと自体より、「hotfixの通常gate」との整合、および既存CIでbuildが別途走るかを明示すべきです。

## リスク / 対立しうる設計判断

- **単純な1本の `IN` query vs chunking/別query方式**  
  hotfixの小ささと、無制限card数に対する堅牢性の対立です。現在の実測値だけで安全を断定すべきではありません。

- **full pull時のby-card query省略 vs 条件分岐の単純性**  
  省略は性能上合理的ですが、「full deltaが常に全集合」という別契約への依存を増やします。hotfixで新たな分岐を増やす価値があるかは判断点です。

- **暗黙の完全集合契約 vs 明示的な wire 表現**  
  案②は変更量が小さい一方、`card_tags` 配列が「通常増分＋一部cardのsnapshot」という二重の意味を持ちます。将来保守では案③の方が安全ですが、今回のhotfix範囲とは衝突します。

- **即時backfillなし vs 回復前の損失伝播リスク**  
  prod未公開が確実ならbackfill省略は妥当です。既存利用者がいるなら、自然回復待ちはデータ保全上弱く、強制full pullやcursor migrationを検討する余地があります。

- **同一 tenant txで十分とする vs snapshot consistencyを強める**  
  今回の再構築契約には通常 `READ COMMITTED` で足りますが、「同一応答全体の時点整合」まで要求するなら isolation levelを含む別設計になります。

- **Fault Aを無害な帯域問題として延期 vs 負荷・raceの継続**  
  案②でタグ損失は止まりますが、境界card再送、応答増加、楽観編集巻き戻し候補は残ります。follow-upを単なる最適化扱いせず、correctness hazardを含む案件として追跡する必要があります。