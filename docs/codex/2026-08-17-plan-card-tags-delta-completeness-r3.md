# Codex plan cross-check — card-tags-delta-completeness-r3 (2026-08-17)

- **作成日**: 2026-08-17
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

**判定: GO**

1. authoritative replace は提示された競合列を閉じている。

   増分 SELECT が取得した `c1:o_old` は、`c1` が変更 card である限り合成時に無条件で破棄される。応答中の `c1` projection は、後続の by-card SELECT が返した集合だけで構成されるため、削除済み `o_old` が union 経由で再投入される経路はない。0 件の場合も空集合として正しく置換される。

2. READ COMMITTED でも、強化後の I-1 と矛盾しない。

   by-card SELECT は単一 statement の snapshot を持ち、変更 card の応答 projection はその statement 時点の集合と一致する。cards SELECT や増分 SELECT と同一 snapshot である必要はない。by-card SELECT 後の更新は I-1 の基準時点より後なので、I-1 違反ではない。

3. cursor 分離は妥当。

   応答から捨てられた増分行も `ct.maxCreatedAt` の計算対象に残す設計は正しい。応答集合から cursor を再計算すると、古い by-card 行の混入や、捨てた増分行による進捗喪失が起こりうる。r3 はこれを構造的に分離している。

4. skip 分岐は整合している。

   - 変更 card なし: 置換対象がないため増分結果をそのまま返せる。
   - `since_card_tags` 欠落: owner 全件を単一 statement で取得するため、その結果自体が各 card の authoritative projection になる。別時点の集合との union を根拠としていない点も適切。

5. wire 形式と client apply 処理は変わらず、旧 client との意味的互換性がある。

   変更されるのは既存 `card_tags` 配列の充足度だけであり、旧 client の全削除→再構築処理を成立させる方向の変更である。

6. 裁定事項は spec 内で整合して反映されている。

   full-stream contract pin、owner 接続による明示 predicate の検証、見送りテストの理由、非スコープ follow-up、prod 未リリースを前提とする rollout、同一 card での `S → S∪{x} → S` smoke が明記されている。

## plan ドラフトへの抜け・未考慮指摘

凍結を妨げる抜けは見当たらない。

ただし、以下は実装・レビュー時に確認すべき依存条件として残る。

- 「by-card SELECT 後のタグ変更は次回 cards delta に載る」という説明は、すべてのタグ変更経路が同一トランザクション等で `cards.updated_at` を確実に前進させる既存契約に依存する。今回の差分で新設された問題ではないが、その契約が破られる経路があると、I-1 の時点一致は満たしても次回収束の説明は崩れる。
- mocked route test は replace の配線と集合演算を固定するが、提示された READ COMMITTED の実競合列そのものを再現するテストではない。実 PG route testを見送る判断は明示され、iso・unit・stg smoke の分割検証で補っているため blocker ではない。
- bind 上限超過は黙った不整合ではなく pull 全体の失敗になる想定だが、単一 user の card 数に運用上限が本当にあるかは実装外の運用依存である。受容リスクとしては記録済み。
- client 側に応答サイズ上限がなくても、HTTP/CDN/serverless の response body・実行時間・メモリ上限は別問題である。full pull 以下という境界により新規リスクは限定されるが、「既存 full pull が通る」は最大規模での保証ではない。

## リスク / 対立しうる設計判断

- **時点整合性 vs 単純な実装**: r3 は全 stream の同一 snapshot を保証せず、変更 card ごとではなく一括 by-card statement 時点を authoritative とする。今回の I-1 には十分だが、応答全体の point-in-time snapshot を要求する設計とは異なる。
- **即時完全回復 vs hotfix scope**: 修正後も、既に欠落した未更新 card は自然には直ちに回復しない。prod 未リリース前提が崩れる場合、現設計のままの rollout は不適切で、強制 full pullまたは cursor migration の判断が必要。
- **chunking の堅牢性 vs YAGNI**: 6.5万規模の bind 上限を受容して実装を単純化している。運用上限が保証されない場合は、将来的に chunking または別の問い合わせ形式が必要。
- **統合テスト強度 vs hotfix速度**: 実 DB・route・client を通した自動障害シーケンステストを作らず、複数の pin と手動 smoke に分割している。裁定済みであり NO-GO 要因ではないが、回帰検出力は smoke の確実な実施に依存する。