# Codex plan cross-check — ocr-2-4b-s1-staging-delete (2026-08-09)

- **作成日**: 2026-08-09
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **cleanup の保証水準を明確にする必要がある**

   entry 削除と R2 DELETE は原子的ではなく、DELETE は network failure、画面遷移、Server Action の配送失敗で失われうる。「削除時点から orphan を残さない」は保証できず、正確には「削除操作を契機に即時回収を試行し、lifecycle / sweeper で収束させる」である。

2. **飛行中 PUT との順序保証が中心課題**

   DELETE 後に PUT が完了すると object が再生成される。したがって、少なくとも次を区別する必要がある。

   - PUT 未開始
   - PUT request 飛行中
   - PUT 成功、finalize 未開始
   - finalize 飛行中
   - finalize 終了後
   - PUT / finalize の成否が不明な例外・timeout

   client state の status だけでは非同期処理の実際の所有状態を表せないため、別の同期的な所有権・飛行状態が必要になる。

3. **「DELETE 主体の一意性」と「最終的な回収」は別の性質**

   DELETE 呼出元を一意にしても、その一回が失敗すれば object は残る。一意性は race の理解には有効だが、回収保証そのものではない。重複 DELETE は冪等なので、安全性よりも実装簡潔性・観測ノイズ・API 負荷の問題である。

4. **PUT の結果が不明な経路を扱う必要がある**

   timeout、browser network error、応答喪失では、client からは PUT 失敗に見えても R2 に object が存在する可能性がある。`putOk === true` の場合だけ削除する設計では、この uncertain outcome を回収できない。存在しなくても DELETE が成功系 no-op なら、削除済み entry については保守的に DELETE する方が収束性は高い。

5. **continuation の全終了経路の網羅性が必要**

   `return`、response non-OK、fetch throw、parse throw、finalize reject、finalize throw、予期しない例外のすべてで、次が成立する必要がある。

   - 飛行状態が解除される
   - 削除済みなら cleanup 主体が失われない
   - registry の stale record が残らない
   - state を復活させない

6. **registry と generation の寿命・再利用規則が必要**

   特に以下を定義すべきである。

   - reserve 成功前に削除された entry
   - error / ready entry の retry
   - retry 中に再削除
   - 同じ entry ID に対して別 session が割り当てられる場合
   - 複数 PDF が同じ session に属する場合
   - last entry 削除による session null 化
   - session purge と continuation の同時進行

   registry 更新が古い continuation によって新しい record を上書き・削除しないことも必要である。Map の lookup を ID だけで行うなら、record identity または session/generation の一致確認が要る。

7. **所有権移譲の境界を厳密にする必要がある**

   submit の「開始」「server 到達」「operation 作成」「accepted 応答」のどこで R2 object の責任が client から pipeline に移るかを定義する必要がある。単に submit throw しただけでは、server が受理済みか未到達か判別できない。

8. **submit throw 時の一律 purge は orphan を増やしうる**

   request が server に届く前の同期的失敗や通信失敗でも registry を purge すると、client がまだ所有すべき objectを回収不能にする。二重 DELETE 競合の回避と、未受理 object の回収可能性が対立するため、ownership fencing、operation ID、accepted の有無などに基づく判断が必要である。

9. **Server Action 自体の throw-free 境界が必要**

   `deleteObject` が never-throw でも、認証、入力処理、key 槕築、台帳、logger などは例外を投げうる。fire-and-forget の未処理 rejection を避けるなら、どこまでを action 内で捕捉するかを明示すべきである。

10. **認可モデルは namespace 制限だけで十分か確認が必要**

    userId を server 導出するため他ユーザーの object は消せない。一方、同一ユーザーの別タブ・別 upload session の UUID が漏れた場合には削除可能である。UUID の推測困難性を認可補助として受容するのか、session 台帳がない以上それ以上検証しないのかを明文化すべきである。

11. **運用上の観測と再試行導線が必要**

    client DELETE 失敗を台帳に記録しても、app role は SELECT 不可であり自動 retry もない。誰が、どの頻度で、どの SQL を見て、どの lane で再回収するかが未定なら、台帳は検知ではなく蓄積に留まる。

12. **lifecycle は未確認のバックストップ**

    rule 本体も削除効果も確認できていないため、設計上「lifecycle が必ず回収する」とは置けない。sweeper 導入前は、最古 object age の観測や OT 確認が実質的な安全網となる。

13. **個別 DELETE の負荷と配送特性**

    複数 entry の連続削除では Server Action が entry 数だけ発生する。最大件数、同時呼出数、Vercel/R2 制限、画面離脱時の未配送を考慮すべきである。bulk 化しない判断にも根拠が必要である。

14. **プライバシー上の表現**

    目的が「ユーザーが取り下げた著作物の早期削除」であるなら、best-effort・最大保持期間・バックストップ未検証を混同してはならない。プロダクト上の削除表示が即時消去を約束していないかも確認対象になる。

---

## plan ドラフトへの抜け・未考慮指摘

1. **PUT uncertain outcome のテストがない**

   plan は checkpoint 2 で「`putOk` のときのみ DELETE」としている。しかし fetch timeout / throw 時に PUT が着地済みという重要経路を扱っていない。削除済み entry なら、PUT の結果が不明でも冪等 DELETE を試す設計を検討すべきである。

2. **古い continuation が新 registry を触る race が未考慮**

   `finally` の `pdfSourceRef.current.get(id)` と `map.delete(id)` は entry ID だけを条件にしている。retry 等で同じ ID に新しい session record が登録された場合、古い continuation が新 record の `inFlight` を false にしたり削除したりしうる。

   record object、generation、uploadSessionId の一致を確認して「自分が登録した record だけを変更する」という不変条件が必要である。

3. **submit throw 時 purge の妥当性が未証明**

   plan は submit throw を一律 ownership 移譲済み相当として purge するが、server 未到達の場合には client 所有の orphan を意図的に作る。throw の種類・accepted の有無・operation 作成可能性を分けるべきである。

4. **checkpoint 3 の「成功 / reject / throw 全て」の実装写像が曖昧**

   「finalize await 直後と catch 節先頭」では、catch が PUT と finalize を共用している場合にどちらの例外か不明になる。また response parse、`writeEntry`、cleanup action 呼出準備など、どこまでが catch 対象か明示されていない。

5. **`finally` と checkpoint の原子性説明が不足**

   plan は checkpoint 内で map を削除した後に `finally` が走る構造になる。通常終了では state 更新、checkpoint、finally の順序が保証の根拠になるため、具体的な制御フローをテストまたはコメントで pin すべきである。

6. **registry identity race のテストがない**

   少なくとも以下が必要である。

   - retry で新 session record が作られた後、旧 continuation が終了
   - reserve 未解決中に削除、その後 retry / 再追加
   - 複数 PDF の一方だけ削除
   - session purge 後に遅延 continuation が終了
   - last entry 削除後も遅延 continuation が正しい旧 session key を削除

7. **狙っている「render commit 窓」の専用テストがない**

   spec は status ではなく ref を使う主要理由として、continuation 完了から React commit までの窓を挙げている。しかし単なる ready 削除テストでは、その窓を再現できない可能性がある。finalize resolve と UI commit の間で削除する制御テストが必要である。

8. **DELETE 404 の明示的テストがない**

   error/reject 経路では重複 DELETE が通常発生するため、404 が `{ok:true}` になることは中心契約である。正常ケースとは別に pin すべきである。

9. **予期しない action 例外の契約テストが不足**

   `recordIntegrationFailure` reject のみでなく、少なくとも `deleteObject` が契約違反で throw した場合や logger が throw した場合に、action が本当に未処理 rejection を出さないか検討が必要である。

10. **client fire-and-forget rejection の防御がない**

    action が将来 throw する回帰を起こした場合、`void deletePdfSource()` は rejection を処理しない。action の throw-free を唯一の防壁にするのか、client 側でも `.catch()` を置くのかが未決定である。

11. **台帳書込自体の回帰確認が弱い**

    workflow の区別は正しいが、`error_message`、context の秘匿性、status が undefined の場合、同一失敗の重複記録などは未考慮である。

12. **smoke が成功経路に偏っている**

    ready / uploading の 0 件収束だけでは、timeout、DELETE 失敗、finalize throw、retry、複数 PDF、submit throw purge を検証できない。少なくとも失敗時に台帳へ記録され、object がバックストップ対象として残ることを確認する観点が必要である。

13. **architecture.md 以外の運用文書更新がない**

    lifecycle が未検証であること、台帳照会が owner 限定であること、sweeper 未実装期間の確認方法は運用上重要だが、Task 3 は経路列挙だけで終わっている。

14. **TDD の red 証跡と commit 分割が設計リスクを増やす可能性**

    Task 1 の action を先に commit すると未使用 endpoint が一時的に存在する。最終 branch では問題ないが、各 commit を deployable とする規律があるなら feature flag や一体 commit の要否を確認すべきである。

15. **「新 helper は plan 記載分のみ」が過度に実装を拘束する**

    registry identity の安全な更新など、正しさのための小さな helper や型が必要になる可能性がある。簡潔性規律を、spec にない抽象化を全面禁止する形にすべきではない。

---

## リスク / 対立しうる設計判断

| 判断 | 一方の利点 | 反対側のリスク |
|---|---|---|
| DELETE 主体を厳密に一意化 | 制御フローと観測が明快 | 一回の失敗で回収機会を失う。冪等な重複 DELETE を許す方が収束性は高い |
| PUT abort を導入しない | 変更範囲が小さい | 転送量と保持時間を減らせず、uncertain outcome が残る |
| PUT 成功時だけ後追い DELETE | 不要な DELETE を減らす | timeout・応答喪失後に着地した object を回収できない |
| submit throw で一律 purge | pipeline との DELETE 競合を避ける | server 未到達時にも client の回収能力を失う |
| accepted 時だけ ownership 移譲 | orphan を減らせる | accepted 応答喪失時に pipeline と client が競合しうる |
| ID だけで registry を管理 | 実装が単純 | retry・旧 continuation による ABA 型 race が起きる |
| generation/session を registry identity に含める | 古い処理が新 record を壊さない | 状態管理とテストが増える |
| action は完全 throw-free | fire-and-forget が簡潔 | 例外捕捉範囲が広がり、障害を隠す可能性 |
| client 側でも rejection を吸収 | 未処理 rejection を防ぐ | action 契約違反が見えにくくなるため観測が必要 |
| entry ごとの Server Action | 実装と認可が単純 | 多数削除時の呼出増加、離脱時の配送欠落 |
| lifecycle を主要バックストップとする | retry 機構を今作らずに済む | rule の存在・効果が未確認で、保持上限を保証できない |
| 台帳記録のみで retry しない | scope が小さい | SELECT 制約と監視主体不在により、実質的に回収されない可能性 |
| privacy 目的を強く掲げる | 改善理由が明確 | best-effort 実装を即時消去保証と誤認させる |

最優先で詰めるべき点は、**registry の ABA race、PUT uncertain outcome、submit throw 時の ownership 判定**の3点である。これらはテスト追加だけでなく、現在の設計論証そのものに影響する。