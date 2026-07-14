# Codex plan cross-check — image-gc-normalized-refs (2026-07-14)

- **作成日**: 2026-07-14
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **`card_asset_refs` と `cards.images` の二重持ち invariant**
   - 書き手が現状 `handleImages` 単一点である前提に強く依存する。
   - 将来 `cards.images` を書く経路が増えた場合、refs 更新漏れが即 GC 誤判定につながる。
   - 対策として「images writer 追加時は refs 同期必須」をコードコメント・テスト・レビュー観点に固定する必要がある。

2. **backfill 完了前に reconciler を走らせる危険**
   - refs が空の状態では既存 ready asset が全て orphan に見える。
   - migration 後、backfill 前、reconciler 実行前の運用順序が load-bearing。
   - script 側にも「refs table exists but backfill incomplete」を検知・警告できるかが論点。

3. **backfill の asset 実在性 / ready 性**
   - `cards.images` に UUIDv4 形式だが assets に存在しない、または `ready` でない key がある場合の扱いが未確定。
   - refs→assets FK があるため存在しない asset は INSERT 失敗する。
   - backfill は invalid UUID-looking refs を skip するのか、fail-fast するのか、summary で隔離するのかを決める必要がある。

4. **`card_asset_refs.user_id` の整合保証**
   - schema は `user_id` を持つが、FK は cards/assets の user 整合までは保証しない。
   - `card_id` は user A、`asset_id` は user B のような不整合を DB 制約だけでは防げない可能性がある。
   - app 側 ready 検証で防ぐ設計なら、その invariant のテストが重要。

5. **PK `(card_id, field_key, ordinal)` と重複 asset**
   - 同一 card/field/ordinal の一意性は良いが、同じ asset が同一 card に複数回出ることは許容される。
   - これは images 配列の忠実射影として妥当だが、将来「表示再構築」や「重複排除」を入れる時に意味論が変わりうる。

6. **`ordinal` 採番の定義**
   - 「同 target 内連番」だが、元配列全体順序ではない。
   - 将来 refs から images 全体を完全再構築するなら、target 間の相対順序は失われる。
   - 現 spec は field ごとの gallery 前提なら問題ないが、「完全復元可能」と言うなら target 横断順序の扱いを明確化した方がよい。

7. **`deleting` から `ready` への self-heal の意味論**
   - promote 後は handleImages が `ready` 以外を弾くため、通常は新規参照不可。
   - ただし並走 tx や不整合修復では `deleting` に refs が出現しうる。
   - self-heal で `ready` に戻すのは安全策だが、user 削除由来の `deleting` asset を誤って復活させない条件確認が必要。

8. **user 削除由来 asset の扱い**
   - user 削除後は assets 行と R2 object が sweep まで残る。
   - 取得権限は `status != ready` で失効するが、保存期間・運用 SLA・手動 sweep 忘れのリスクは残る。
   - GDPR/データ削除方針として「次回手動 sweep」だけで足りるかは技術外も含め確認が必要。

9. **manual-first GC の運用リスク**
   - cron がスコープ外なので、GC は人間の実行に依存する。
   - R2 object、`deleting` rows、integration_failures が蓄積するリスクがある。
   - 最低限、runbook、頻度、誰が user 削除後に sweep するか、失敗時の再実行手順が必要。

10. **R2 DELETE と DB 更新の部分失敗**
   - `deleteObject` success 後、`status='deleted'` 更新や row DELETE が失敗する crash case は state machine で吸収する設計。
   - ただし `deleted` 状態の assets 行が長期残る場合の監視・summary・再実行確認が必要。

11. **DB DELETE 失敗の可視化**
   - spec は R2 失敗だけ integration_failures に積み、DB 側失敗は logger/summary。
   - 手動 script の標準出力だけだと見落としやすい。
   - RESTRICT 失敗や row DELETE 失敗を運用上どう検知するかが論点。

12. **resolve 条件を refs EXISTS にしない判断**
   - state gate のみなら attach 直後・mutation 未 flush の取得不可を避けられる。
   - 一方、ready asset で refs が既に消えたものは grace 中に resolve 可能なまま。
   - 「即時に効く取得権限失効」は `deleting` 遷移時であり、「カード参照から外れた瞬間の取得不可」ではない点を明確にすべき。

13. **poison mutation / stale offline mutation**
   - 正規化後も offline 端末の古い images mutation が sweep 後に失敗する問題は残る。
   - これは仕様として受容する必要があり、UI 回復経路の十分性が重要。

14. **migration rollback / deploy ordering**
   - refs table 追加後、アプリが新旧混在する時間に `handleImages` が refs を書く/書かないバージョン差が出る可能性。
   - additive migration なので大事故にはなりにくいが、backfill と deploy 順序の運用は要整理。

15. **integration_failures の重複蓄積**
   - R2 DELETE が失敗し続ける asset で run ごとに failure row が増える可能性がある。
   - 許容するのか、dedupe/context 更新するのか、既存規約に沿って確認が必要。

16. **reserved asset の GC**
   - mark は `reserved` も対象にする。
   - upload 中断や finalize されない asset を拾える利点がある一方、長時間 upload / stale client との関係は grace 30 日で受容する設計。
   - `reserved` の意味と `deleting` promote 条件が domain module で明確化される必要がある。

17. **テストデータと実 DB 分布**
   - zero-user 前提でも、実 DB の `images.target`、UUID-looking invalid key、legacy OCR entry は dry-run で確認が必要。
   - 「事実上 question_text のみ」は設計前提ではなく観測で検証すべき。

18. **将来 dedup との接続**
   - refs many-to-many は布石として良い。
   - ただし dedup 導入時は `assets` と R2 object の所有・共有・hash reuse の意味論が変わる。
   - 今回の state machine が dedup 後も破綻しないか、少なくとも「dedup 導入時に再設計が必要」と明記した方がよい。

## plan ドラフトへの抜け・未考慮指摘

1. **backfill の invalid asset 対応が不足**
   - plan G4 は射影・再実行安全・dry-run を扱っているが、UUIDv4 key が assets に存在しない/ready でない場合の方針がない。
   - FK で本実行が落ちる可能性があるため、dry-run summary に `missingAssetIds` / `nonReadyAssetIds` 相当の検出を入れるべき。

2. **`user_id` cross-tenant 整合テストが明示されていない**
   - W1 の ready 検証が user scope を守るはずだが、refs INSERT で card user と asset user の不一致を防ぐテストが plan に見えない。
   - `card_id + user_id` DELETE だけでなく、INSERT 側の tenant 整合を検証したい。

3. **backfill の既存 refs 全置換範囲が曖昧**
   - 「全置換 or upsert は実装時に選び理由 1 行」では少し弱い。
   - 再実行安全だけでなく、古い refs が残らないことが GC correctness に直結する。
   - card 単位または user 単位で「消えた refs も消える」ことを完了条件に入れるべき。

4. **reconciler の backfill 済みガードがない**
   - spec では backfill 完了が reconciler 運用開始の前提。
   - plan G5 に「script header note」はあるが、実行時の安全確認や強い警告がない。
   - 少なくとも dry-run summary で refs/card images の乖離を検知する項目が欲しい。

5. **`deleted` lane / DB row DELETE 失敗の可視化が弱い**
   - plan G5 は crash 再開を検証するが、row DELETE が RESTRICT 等で失敗した時の summary/logger の明示が薄い。
   - DB 失敗を台帳に積まない設計なら、手動運用で見落とさない出力仕様が必要。

6. **user 削除由来の self-heal 防止が未明示**
   - W2 で assets を `deleting` にするが、G5 collect の self-heal は refs 出現時に `ready` に戻す。
   - user 削除後 asset は復活させてはいけない。
   - refs cascade 消滅後に通常は起きないが、plan に「user 削除対象で self-heal しないこと」または「起き得ない理由」のテスト/説明があるとよい。

7. **manual operation runbook が plan 外**
   - Deploy/stg smoke はあるが、prod で誰がいつ `gc-image-assets.ts --sweep` を打つか、user 削除後の運用、failure row 確認手順がない。
   - cron スコープ外なら runbook は実装成果物に近い重要要素。

8. **resolve の invariant テストがない**
   - R1 は resolve を変更しない方針だが、`status='deleting'/'deleted'` が resolve/handleImages から除外されることは設計の要。
   - 既存 `eq('ready')` に依存するなら、明示テストを追加した方がよい。

9. **deployment mixed-version リスクが未整理**
   - G1 migration、W1 app deploy、backfill、reconciler の順序は書かれているが、新旧 app が混在する時間の refs drift 許容が未記載。
   - 特に W1 deploy 前に発生した images 更新は backfill 後に refs に反映されない可能性があるため、backfill の実行タイミングは W1 deploy 後が自然か要確認。

10. **integration_failures 重複方針がない**
   - R2 失敗を run ごとに記録するのか、同一 asset/objectKey で集約するのか未記載。
   - 既存 catalog 規約に合わせるとしても、運用ノイズの観点で明示した方がよい。

11. **`ordinal` の完全復元性に関する注意がない**
   - plan は spec を踏襲しているが、同 target 内 ordinal では target 横断の元配列順は保存しない。
   - 将来 refs から cards.images を完全再構築する意図があるなら、ここは設計注意点として残した方がよい。

12. **W3 の対象経路が仕様通りだが、exam 削除の local cache は残る**
   - spec では対象外なので plan は間違いではない。
   - ただし UX/容量観点では exam 削除時に local ready cache が残る可能性がある。
   - 「対象外として許容」と明記するとレビュー時の誤解を避けられる。

## リスク / 対立しうる設計判断

1. **state-only resolve vs refs-required resolve**
   - state-only は attach 直後の UX に強い。
   - refs-required はカードから外れた画像の取得権限失効がより即時になる。
   - spec は state-only 裁定だが、「参照消滅」と「取得権限失効」の即時性を混同しない説明が必要。

2. **全置換 refs vs diff 更新**
   - 全置換は単純で images max 10 なら妥当。
   - diff は write を減らせるが old SELECT と集合比較が増え、LWW と cascade 問題を再び持ち込みやすい。
   - plan の全置換判断は妥当だが、writer 追加時の discipline が必要。

3. **manual GC vs cron**
   - manual-first は攻撃面と実装面が小さい。
   - 一方、user deletion、R2 cost、failure cleanup は運用依存になる。
   - 本番では cron 導入の判断時期を早めに決めるべき。

4. **DB failure を integration_failures に積まない判断**
   - 外部 API failure だけ台帳に積む既存規律には合う。
   - ただし GC は手動 run なので DB failure が標準出力だけだと埋もれやすい。
   - logger/summary/runbook の品質が重要。

5. **user deletion asset を即 sweep eligible にする判断**
   - privacy/削除要求には合う。
   - ただし R2 外部呼び出しを webhook critical path に入れないため、実際の物理削除は次回 sweep 依存。
   - 「即時不可視」と「物理削除完了」は分けて説明すべき。

6. **DB CHECK なし + domain SSoT**
   - DDL 変更が少なく柔軟。
   - DB 直書きや script bug で未知 status が入りうる。
   - domain module 配線、テスト、summary で unknown status を検出する設計が必要。

7. **二重持ちの短期低リスク vs 長期 drift リスク**
   - 現状の blast radius は小さい。
   - 長期的には `cards.images` writer の増加や per-option gallery 実装で drift リスクが増える。
   - 将来 refs を表示再構築にも使うか、wire 配列を残し続けるかは再判断ポイント。