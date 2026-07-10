# Codex plan cross-check — sprint2-integration-failures-spec (2026-07-10)

- **作成日**: 2026-07-10
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **「記録対象の中核」の境界を実装可能な粒度まで固定する必要**
   - 確定判断では「課金整合(orphan / gate mismatch)・Clerk sync・削除失敗」が対象。
   - ただし fact-finding には S4(A-3 drift), S6(unlinked customer) も「回収要る中核」寄りとして出ている。
   - Sprint 2 要件では中核を絞る判断が入っているため、**対象外にする理由と将来追加時の catalog 拡張方針**は明示が必要。

2. **dual-write helper の失敗セマンティクスが重要**
   - DB INSERT は本処理を壊さない throw-safe。
   - ただし notifyOps は production webhook URL 未設定時に fail-fast する既存契約を維持。
   - つまり helper は「INSERT 失敗は握るが notifyOps throw は握らない」という非対称契約になる。
   - 呼び出し元ごとに、この伝播が既存 webhook 200 不変条件を壊さないか確認が必要。

3. **INSERT→notifyOps 順序の副作用**
   - 既存 deletion_failures の precedent に合わせるなら妥当。
   - ただし INSERT 成功後に notifyOps が production misconfig で throw した場合、DB 行だけ残る。
   - これは意図した状態か、少なくとも設計上の許容として明記すべき。

4. **context を verbatim 保存する場合の情報管理**
   - notifyOps context をそのまま jsonb に保存する方針。
   - Discord payload と DB 永続化では保持期間・検索性・漏洩影響が違う。
   - customerId, clerkId, eventId, error 内容などが残るため、PII/secret 混入防止、保存対象の妥当性、将来の削除ポリシーは論点。

5. **重複記録の扱い**
   - webhook 再送、同じ失敗の再発、Clerk sync の複数呼び出し元、削除時 retry などで同一事象が複数行になる可能性がある。
   - 要件上は additive ledger なので重複許容でもよいが、手動 SQL で拾う基盤なら「重複は仕様」か「自然キーで抑制しない理由」を明示すべき。

6. **resolved_at / retry_count / next_retry_at の dormant 列の意味**
   - cron は作らないが将来用の列を持つ。
   - Sprint 2 では retry_count / next_retry_at をアプリが触らない。
   - 手動 SQL 運用では resolved_at / resolution_note だけを更新する想定なのか、next_retry_at も手動で使うのか曖昧になりやすい。

7. **resolution_note がアプリ外更新専用であることの運用設計**
   - アプリから読み書きしないなら、誰が、どの SQL で、どの基準で更新するかが運用依存になる。
   - 最低限、手動回収時の SQL 例や「resolved_at と resolution_note は同時更新推奨」程度の runbook が必要。

8. **4 軸分類は DB では enforce されない**
   - DB CHECK なしは確定判断。
   - その分、catalog 以外から insert できる経路、手動 SQL、将来 script が不正 tuple を入れうる。
   - コード側 catalog の型安全はアプリ経由に限るため、運用上の不整合は許容する設計になる。

9. **catalog key を DB に保存しないことのトレードオフ**
   - DB には 4 軸のみ保存。
   - tuple が一意なら集計には十分だが、コード上のハンドル名と DB 行を直接対応させたい場合は追跡しづらい。
   - 将来 tuple のリネームが必要になった場合、既存 DB 行との意味継続も論点になる。

10. **PK のみ index 方針の妥当性**
   - zero-users / 手動 SQL 前提なら妥当。
   - ただし実際に見るクエリは多くの場合 `resolved_at IS NULL`, `service`, `workflow`, `failure_code`, `created_at` になる。
   - cron 導入時だけでなく、手動運用でも未解決一覧が増える可能性はある。

11. **deletion_failures DROP の影響範囲**
   - zero-users なのでデータ移行不要は妥当。
   - ただし schema 参照、テスト、既存 route の mock、Drizzle 型、migration snapshot などの全撤去が必要。
   - 削除失敗の既存 semantics、特に error_message NOT NULL から nullable への変化も確認対象。

12. **Clerk sync の workflow null 方針**
   - 呼び出し元が複数あるため null は理解できる。
   - ただし将来の手動回収では「どの文脈の sync 失敗か」が重要になる可能性がある。
   - context に呼び出し元由来の識別子が十分残るか、または helper 呼び出し時に optional workflow override を許すべきかが論点。

13. **削除失敗の service = db を含める設計**
   - テーブル名は integration_failures だが deletion_data は自 DB transaction 失敗。
   - 「外部連携失敗」の台帳に DB 内部失敗を含める理由は、ユーザー削除 workflow の未完了 failure として整理すれば妥当。
   - 命名と利用者理解には注意が必要。

14. **正常経路 byte 不変の定義**
   - Discord subject/context を byte 不変にする要件がある。
   - INSERT 失敗時だけ `ledgerWriteError` を追加するなら、異常経路では payload が変わる。
   - テストでは「INSERT 成功時は完全一致」「INSERT 失敗時のみ追加」を分けて検証すべき。

15. **手動回収のための最低限の可観測性**
   - DB に記録するだけでは運用者が何を見ればよいか分からない。
   - 対象 query、未解決件数、解決時 update 例、failure_code ごとの対応方針は設計文書か runbook に必要。

## plan ドラフトへの抜け・未考慮指摘

1. **S4 / S6 を対象外にする理由が弱い**
   - 要件の round 1 では「課金整合(orphan / gate mismatch)・Clerk sync・削除失敗」が対象だが、fact-finding では S4(A-3 drift) と S6(unlinked customer) も回収要否が中以上。
   - plan は Out に列挙しているが、なぜ Sprint 2 の「課金整合」に含めないのか、判断基準をもう少し明示した方がよい。

2. **手動 SQL / tsx script の運用設計が薄い**
   - 目的に「手動 SQL / tsx script で棚卸し・回収」とあるが、plan は schema と配線中心。
   - 最低限、未解決一覧 query、resolved_at / resolution_note 更新例、failure type ごとの手動対応メモが必要。

3. **context 永続化の安全性が未記載**
   - `notifyOps` context を verbatim 保存する設計だが、DB 永続化に伴う PII/secret/error stack 混入リスクへの言及がない。
   - 「既存 notifyOps payload は保存してよい前提」なのか、「secret を入れないテスト/レビュー観点」を置くのか明示が欲しい。

4. **重複行の扱いが未定義**
   - webhook 再送や同一失敗の複数回発火で重複記録される可能性がある。
   - unique 制約を置かないなら、重複許容を明文化すべき。
   - 手動 SQL で重複をどう扱うかも運用上の注意点になる。

5. **notifyOps throw 伝播と webhook 200 不変条件の整合がやや危うい**
   - plan は「notifyOps throw semantics は不変」と「webhook handler は常に 200」を両方掲げている。
   - production misconfig 時に helper が notifyOps throw を伝播するなら、呼び出し元によっては webhook 200 不変と衝突しうる。
   - 既存 outer catch が本当に同じように処理するのか、site ごとの確認観点を明記した方がよい。

6. **INSERT 成功・notifyOps 失敗時の状態が未定義**
   - DB 行は残るが Discord は飛ばない可能性がある。
   - これは dual-write の片側成功として許容するのか、logger だけで十分かが明記されていない。

7. **catalog key 非保存の将来運用リスクが未説明**
   - DB には 4 軸 tuple のみ保存する方針。
   - tuple が全て相異なるとは書かれているが、将来 tuple 変更・名称変更時の扱いは未記載。
   - catalog key を保存しない判断自体は成立するが、レビュー観点として一言ほしい。

8. **Clerk sync の workflow null による診断情報不足**
   - null の理由は書かれている。
   - ただし context に呼び出し元文脈が残る保証が弱い。
   - 後で「初期 sync 失敗」なのか「Stripe plan sync 失敗」なのかを拾えるか確認が必要。

9. **`service = 'db'` の導入理由が少し唐突**
   - integration failure table に DB transaction failure を入れる理由は deletion workflow の未完了記録として妥当。
   - plan には catalog 上の説明はあるが、テーブルの概念説明では「外部連携失敗」に寄っているため、削除 workflow failure ledger として含む、と明確にした方がよい。

10. **migration 生成だけで DROP の実体確認が不足**
   - `pnpm db:generate` で DROP が出る前提だが、Drizzle migration snapshot や既存 enum/type 相当の除去、参照テスト更新の確認が必要。
   - 「deletionFailures の参照がゼロになること」を検証項目に入れるとよい。

11. **index PK のみの判断は良いが、手動 SQL の想定 query とセットで示すべき**
   - YAGNI は妥当。
   - ただし未解決一覧を見るために `resolved_at IS NULL` は頻出するため、現時点で index 不要とする根拠を件数・運用頻度と結びつけた方がよい。

12. **テスト戦略が DB mock に寄りすぎる可能性**
   - helper unit は mock でよい。
   - ただし migration/schema の実テーブル形、jsonb/context、nullable/default は integration か migration smoke で確認したい。
   - plan の stg smoke には table 存在確認があるが、local migration verification も入れると堅い。

## リスク / 対立しうる設計判断

1. **中核だけ記録 vs 広めに記録**
   - 中核だけ: ノイズが少なく Sprint 2 が小さい。
   - 広めに記録: S4/S6/S5/S7 などを SQL で棚卸しでき、後続設計が楽。
   - 今回は中核のみが確定だが、対象外が将来重要障害として再浮上するリスクは残る。

2. **DB 制約なし vs データ品質**
   - DB CHECK なし/catalog SSoT は変更容易。
   - 一方で手動 SQL や将来 script から不正 tuple が入る余地は残る。
   - 運用自由度と台帳品質のトレードオフ。

3. **context verbatim 保存 vs 永続化の安全性**
   - verbatim は Discord と DB の対応が明快。
   - ただし永続 DB に保存することで PII/secret/error detail の影響範囲が広がる。
   - notify 用 payload と audit 用 payload を完全同一にするかは慎重に見るべき。

4. **重複許容 ledger vs dedupe**
   - 重複許容は実装が単純で webhook 再送にも強い。
   - dedupe なしだと未解決件数が実態より膨らむ。
   - 手動運用なら重複許容でもよいが、将来 cron では注意が必要。

5. **catalog key 非保存 vs 4 軸正規化**
   - 4 軸だけ保存すると SQL 集計は綺麗。
   - catalog key を残さないと、コード上の失敗種別との対応や将来 rename の追跡が弱くなる。
   - tuple を stable identifier として扱うなら、その運用ルールが必要。

6. **notifyOps throw 維持 vs webhook 安定性**
   - 既存契約維持は正しい。
   - ただし helper 経由で notifyOps call site が増える/置換されるため、production misconfig 時の failure surface を改めて確認すべき。

7. **PK only index vs 早期 partial index**
   - PK only は zero-users では合理的。
   - ただし台帳の主目的は未解決抽出なので、`resolved_at IS NULL` partial index は将来ほぼ確実に欲しくなる。
   - Sprint 2 で入れない判断は YAGNI、ただし cron 導入時の必須追加として明記しておくのがよい。