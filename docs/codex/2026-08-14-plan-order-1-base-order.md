# Codex plan cross-check — order-1-base-order (2026-08-14)

- **作成日**: 2026-08-14
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. 「決定的順序」と「意図した順序」は別の保証である。  
   `(base_order, id)` は常に全順序を作るが、並走 publish／手動追加で同じ `base_order` が発生すると、UUID 順によりバッチ間のカードが交互に並びうる。「応答配列順で採番」は単一 publish 内では成立しても、並走後の最終表示が応答配列順を維持する保証ではない。この保証境界を利用者向け挙動・テスト名・コメントで誤認させない必要がある。

2. source document 単位取得と「exam 内だけで意味を持つ `base_order`」の整合確認が必要。  
   `getCardsForSourceDocument` が構造上必ず単一 exam に閉じるかを確認すべき。複数 exam のカードを返しうるなら、`ORDER BY base_order, id` は §2.5 とも異なり、exam 間順序を定義できない。また、新 index は `exam_id` の等価条件がない query では ORDER BY 最適化に使えない可能性がある。

3. 手動追加時の `max(base_order)` の母集団が重要。  
   UI に現在表示されている行、フィルタ後の行、ページング済み行ではなく、対象 exam のローカル全カードから最大値を取る必要がある。pending create、pull 未完了、論理削除／削除待ちカードを含めるかも明示が必要。間違えると通常操作だけで末尾ではない位置に追加される。

4. `nextBaseOrders` の入力契約が未定義。  
   `count < 0`、非整数、`maxExisting < 0`、非整数、`NaN`、int4 上限超過について、pure domain 関数が拒否するのか、呼出側契約にするのかが不明。DB の loud failure 方針だけでは、巨大配列生成や `NaN` の伝播など DB 到達前の異常を説明できない。

5. UUID 比較の前提を境界で維持する必要がある。  
   単純文字列比較が PG uuid 順と一致するのは、小文字 canonical UUID という前提下のみ。local create、pull mapper、fixtureだけでなく、import・mock・復元経路を含め、この形式を誰が保証するかが設計上の前提になる。

6. comparator は完全な比較関数として検証すべき。  
   昇順例だけでなく、反対称性、推移性、同一 `id` のときの `0`、入力を破壊しないことが必要。特に `question_label` の `undefined` と `null` を同じ NULLS LAST として扱うかを固定する必要がある。

7. OCR 順序保証の限界を観測可能にする必要がある。  
   モデル応答配列を正とする判断は確定しているが、モデルがページ順を誤った場合、システムは正常成功として保存する。後から原因を追えるよう、prepared payload／preview／operation ID と保存カード順の対応が十分残るか確認が必要。

8. publish の最大値取得と insert は同一 transaction・同一 exam/user 条件である必要がある。  
   query の実行位置だけでなく、publish plan 構築時点との差、再試行時の再計算、同一 operation の再実行時に既存カードを二重追加しない既存 fencing との結合を確認すべき。

9. rename の境界監査が必要。  
   app 内の `sort_key` は完全に消し、Gemini wire 内だけ残すため、単純な全置換も単純な残存ゼロ検査も使えない。許容箇所を明示した残存スキャンが必要。camelCase の `sortKey`、永続 JSON、ログ、テレメトリ、fixture、テスト harness も対象になる。

10. migration の空テーブル前提は運用上検証可能であるべき。  
    「空のはず」に依存するだけでなく、適用直前に stg/prod の `cards` 件数を確認し、非ゼロなら中止する手順が必要。ローカル DB の truncate 対象・関連テーブル・復旧方法も曖昧なままにしない方がよい。

11. migrate-first は rollback 非対称になる。  
    0037 適用後は旧コードへ単純 rollback できない。新 deploy が build/runtime 上失敗した場合、DB は新 schema、稼働コードは旧 schemaという状態になる。ゼロトラフィックでも、forward-fix、再deploy、migration rollbackのどれを採るかを事前に決める必要がある。

12. index の「存在」と「利用」は別。  
    `(user_id, exam_id, base_order, id)` が作成されたことに加え、主要 query の WHERE 条件と ORDER BY に対して Sort が消えるかを実行計画で確認する余地がある。`max(base_order)` も同様で、単なる index 存在テストでは性能仮説を pin できない。

13. SSR と client mirror の型境界確認が必要。  
    SSR SELECT から `base_order` を除く判断自体は成立しうるが、その結果型が `ClientCard`、Dexie write、hydration、client-side comparatorへ流入しないことを確認する必要がある。必須 `ClientCard.base_order` に不完全な SSR 行を代入すると、型キャストや runtime の `undefined` に隠れる。

14. Grid-3 に引き渡す契約には、決定性以外の並走意味論が残る。  
    部分再採番中も全順序があることは保証されるが、複数端末の再採番／移動が競合した場合、混合した最終値が「再送で意図した順に収束する」とは限らない。これは Order-1 の実装外でも、Grid-3 の必須設計課題として明示的に引き渡すべき。

## plan ドラフトへの抜け・未考慮指摘

1. 並走 publish の試験がない。  
   Task 3 の publish test は空 exam・既存 examへの逐次追加だけで、spec が UNIQUE を不採用にした中心理由である「publish同士」「publishと手動 create」の同値採番を検証しない。少なくとも、両方が成功し、カード欠落がなく、最終順序が決定的であることを pin すべき。配列順完全一致は非並走時限定と明記する必要もある。

2. 手動追加の母集団テストが不足している。  
   `buildEmptyCard` 単体だけでは、呼出元がフィルタ後カードを渡しても通ってしまう。ラベル列ソート中、検索／フィルタ中、既存 pending create がある場合でも exam 全体の max の続きになることを確認する観点がない。

3. `getCardsForSourceDocument` の exam 境界・index 利用確認がない。  
   ORDER BY を機械的に置換するだけで、その query が単一 exam に閉じるという契約を確認していない。ここは実装前の read-only 確認項目に入れるべき。

4. rename 完了の機械的監査がない。  
   Task 2 完了条件に、旧 app 名 `sort_key`／`sortKey` の残存検索と、Gemini wireの許容リスト照合がない。逆に wire fixtureやschemaを誤ってrenameしても、一般 gateだけでは見逃す可能性がある。

5. valid create の成功 pin が弱い。  
   「`base_order` 欠落が failed」だけでは、正しい `base_order` と `question_label` を持つ create がDBへそのまま保存されること、`question_label: null` が通ること、`0`／小数が拒否されることを十分保証しない。

6. label update の pin が実装詳細に寄りすぎている。  
   SET句の構造 assert はORM生成形への依存が強い一方、実際に既存 `base_order` が不変かを保証しない可能性がある。統合レベルで更新前後の `base_order` 不変を確認する方が仕様に近い。

7. `nextBaseOrders` の異常入力テストがない。  
   `count=0` はあるが、負数・非整数・int4 overflow近傍の扱いがない。防御しない方針なら、その前提を型／コメント／呼出側検証として明記すべき。

8. migration 検証が rename 方式の確認に偏っている。  
   exact column type、NOT NULL、defaultなし、CHECK、旧index削除、新index列順、旧列不存在、Drizzle snapshot整合まで確認する項目がない。生成成功と iso setup成功だけでは、余分なdefaultなどを見落としうる。

9. migrate直前の空データ確認と中止条件が deploy 手順にない。  
   Deploy節は即 migration 適用になっている。stg/prodそれぞれでカード件数をread-only確認し、非ゼロなら実行しない手順が必要。

10. deploy失敗時の復旧方針がない。  
    migrate-first後に新コードdeployが失敗した場合の手順、旧コードへ戻せないこと、forward deployを優先するのかが未記載。

11. index実行計画の確認がない。  
    新index作成は記載されているが、2つのserver queryと `max(base_order)` について `EXPLAIN` 相当の確認がない。特に source-document queryは要注意。

12. SSR非選択の境界テストがない。  
    `baseOrder` をSELECTしないSSR型と、必須 `ClientCard.base_order` の混同を防ぐ型テストまたは経路確認がplanにない。

13. smokeが並走・再試行・追加中断を扱わない。  
    通常系は厚いが、同一examへの複数upload並走、publish再試行、旧bundle由来mutationのloud failure確認がない。少なくとも運用上重要な失敗が台帳・通知に残ることは確認候補になる。

14. Task 3の mutation-based red 検証は作業事故リスクがある。  
    production codeを一時変異して戻す方式は、戻し忘れや並行変更混入を招く。実施するなら clean worktree確認、差分ゼロ確認、各変異後の復元確認を完了条件に含める必要がある。

15. 「常時green」とTask 2の巨大な型閉包が緊張する。  
    1 commitにまとめる理由は理解できるが、migration・全層rename・OCR publish・UIを同時に変更するため、障害切り分けとreview可能性が低い。commitを分けられないとしても、層ごとの中間検証チェックポイントは必要。

16. Grid-3へのhandoff記録がない。  
    partial renumber、競合再採番、`base_order` handler追加時のvalidation、専用op採否を次specの必須検討事項としてsession docへ残す項目がない。

## リスク / 対立しうる設計判断

- UNIQUEなしは書込成功性を高める一方、厳密な末尾順・バッチ連続性を弱める。これは仕様上承認済みだが、UIやテストが後者まで保証しているように表現しないことが重要。
- publish lockなしはスループットと単純性を保つ一方、同一examへの並走時にカード群が交互配置されうる。将来これがUX問題になれば、exam単位lock、予約レンジ、サーバ採番opなど別設計が必要になる。
- int4＋stride 1024は単純だが、挿入・再採番の頻度と将来上限を固定する。現規模には十分でも、overflowを完全にDB任せにするとoffline pending mutationの回復不能化と結び付く可能性がある。
- Dexie version据置は不要なupgradeを避ける一方、前提外の既存同一owner行があると必須 `base_order` 欠落がruntimeで表面化する。ゼロデータ前提をどこまで運用で強制するかとのトレードオフ。
- app/wireで異なる名称を維持する判断は影響範囲を抑える一方、将来の保守で誤置換しやすい。唯一の変換境界をコメントだけでなくテストでも固定する価値がある。
- label比較を表示専用に残す判断は妥当だが、文字列比較方法がブラウザ依存なら表示順の端末間一致は保証されない。基準順のserver/client一致とは保証レベルを分離すべき。
- expand-contract不採用は今回のゼロトラフィック条件には合う一方、rollback容易性を失う。無停止性の利得がゼロでも、deploy失敗からの復旧性の利得までゼロとは限らない。
- partial renumberの「常に決定的」は安全性の一部にすぎず、ユーザー意図の保存・競合収束・undo可能性とは対立しうる。Grid-3で改めて裁定が必要。