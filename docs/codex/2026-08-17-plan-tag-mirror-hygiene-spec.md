# Codex plan cross-check — tag-mirror-hygiene-spec (2026-08-17)

- **作成日**: 2026-08-17
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. Cache 不可侵集合と lock 禁止は、そのままでは同時に強保証できない

   Dexie transaction 後に非 `ready` asset と `downloading` job から保護 blob 集合を作っても、集合確定後に新しい upload/download が開始できます。

   反例:

   1. hygiene が保護集合を取得
   2. upload が `media_assets(status='uploading')` と blob を追加
   3. hygiene が Cache を列挙し、新 blob を「保護集合外」として削除

   これにより「非 `ready` 行に対応する blob は触らない」という要件を破ります。Cache API と IndexedDB の間に原子的 snapshot はないため、単なる実装順では閉じません。

   少なくとも保証表現を「開始時点で観測済みの保護 blob」に弱めるか、削除候補を限定する、削除直前に再確認する、または upload/download 側に回復可能性があることを別途証明する必要があります。再確認でも TOCTOU 自体は完全には消えません。

2. `downloading` job が保護する対象範囲が曖昧

   要件は「job 行 + `added_asset_ids` blob」を不可侵としていますが、`added_asset_ids` に対応する `media_assets` 行が `ready` なら、現分類では purge 対象です。job と blob は残っても metadata が消えるため、download の resume/rollback/completion が `media_assets` 行を必要とするなら all-or-nothing が壊れます。

   `deck-download.ts` の各遷移について、次を確定すべきです。

   - `added_asset_ids` の blob だけで resume/rollback できるか
   - 対応 `media_assets` 行も job 完了まで必要か
   - purge 後に job が完了した場合、消した mirror/Cache をどう再構成するか

3. cursor CAS の比較対象と失敗契約を厳密化する必要がある

   CAS は6本すべてについて、値だけでなく「存在/不在」を区別する必要があります。`undefined` を値として保存可能なら、不在との区別も検討対象です。

   また Dexie transaction を abort する方法は通常例外になるため、例外を pull 全体の reject に漏らさず、既存契約どおり `{ok:false}` に正規化する境界が必要です。通常の IndexedDB 障害と CAS mismatch を同じ扱いにするかも明示すべきです。

4. CAS は hygiene 以外の cursor writer も検出する

   別 tab pull が先に cursor を更新した場合も CAS mismatch になります。安全側ではありますが、次回が必ず full pullになるとは限りません。現在値が「削除」ではなく別 pull により更新された場合、次回はその新 cursorからの deltaです。

   したがって回復説明は次の2種類を分けるべきです。

   - cursor 消失: 次回 full pull
   - cursor 前進/変化: 次回は現在 cursor から再 pull

5. CAS が防ぐのは「cursor snapshot 後の変更」のみ

   mirror と cursor が既に不整合な状態で pull が始まった場合、CAS は両方を健全とは判定できません。今回の単一 transaction によって新規不整合を作らないことと、既存/旧 bundle 由来の不整合を修復することは別です。

   既存不整合の reconcile は非スコープなので、CAS の保証を「既存状態の整合性検証」と誤読できないよう明示が必要です。

6. purge と新 session の競合は correctness だけでなく local work の UX を劣化させる

   signed-out 状態で始まった purge が新 session 成立後に走ると、新 user の mirror、cursor、prefs、synced outbox、ready media/blob まで削除できます。server mirror は再取得可能でも、次を確認する必要があります。

   - UI が次の pull trigger まで空表示になり得る時間
   - `exam_view_prefs` が「sign-out 1回分」を超えて新 session 操作後にも消えること
   - 再 fetch 不可能な ready blobが存在しないこと
   - 新 session 中に purge が失敗した場合の再試行有無

7. root の signed-out mount は「sign-out」以外でも purge を起こす

   `<SignOutPurge />` は遷移検出ではなく状態駆動なので、以下も同じ purge になります。

   - 初回の匿名 marketing page 訪問
   - 別 tab では app 使用中だが、この tab が一時的/継続的に signed-out と観測した場合
   - Clerk 初期化や session refresh の境界で signed-out が観測された場合

   発火条件は確定要件ですが、「sign-out ごと」という受容コストより実際の発火集合が広い点は運用仕様として明記すべきです。

8. 「1回発火」の単位が未定義

   component lifetime中に一度なのか、`isSignedIn: true → false` ごとなのかで挙動が変わります。単純な `useEffect([isLoaded,isSignedIn])` なら false 状態への各遷移で発火しますが、Strict Mode、remount、route/layout lifecycleでも再実行され得ます。

   冪等性だけでなく、重複した非同期 purge 同士が新 sessionへ遅着する時間を伸ばす点も考慮が必要です。

9. `Dexie.exists()` と既存 singleton/open connection の関係

   DB 存在確認後、`getClientDb()` を開くまでに DB 状態が変わる raceがあります。また既存 singleton が既に open 済みなら、「未訪問 visitorに空DBを作らない」という guard の意味が変わります。

   `Dexie.exists()` の結果を correctness 判定に使わず、単なる不要生成抑止に限定する方針は妥当ですが、その raceを許容することを明記すべきです。

10. Cache key の認識規則がセキュリティ・削除範囲を決める

   Cache の request URL は絶対URLとして列挙されます。単純な文字列 prefix 判定では、encoding、余分な path segment、query、別 origin相当の requestを誤分類し得ます。

   次を固定する必要があります。

   - URL parse後の origin/path判定
   - userId/assetId segmentの decode 方針
   - query付き keyの扱い
   - `/__media/` 以外の同一 cache内 entryを purgeするか
   - malformed/将来形式を purge・温存のどちらに倒すか

11. sync_meta scoped key の構文判定を明文化する必要がある

   `base:<self>` と `base:<other>` の判定について、空 suffix、追加 colon、prefixだけ一致する未知 keyをどうするかが未定義です。将来 key温存が目的なら、既知 baseに対する厳密な構文だけを削除対象にすべきです。

12. store 分類の将来変更に対する機械的完全性が必要

   sync_meta key追加には分類強制がある一方、新しい Dexie table、media status、outbox statusの追加時にも判断が必要です。

   特に以下が silent regressionになります。

   - mirror store追加が transaction scopeから漏れる
   -新 statusが「非 ready」「非 downloading」の否定条件に偶然入る
   - 新 outbox storeが purge/sweep対象から漏れる
   - Cache namespace追加が掃除対象にならない

   明示 allowlist/exhaustiveness testは sync_metaだけでなく、store/status/Cache namespaceにも必要です。

13. pending outbox と mirror 全消しの整合性

   pending mutationを残して対応 mirrorを消すため、同一 userの再 sign-inでは server snapshotが入り、未 flush の楽観表示が一時的に失われます。後続 flushで回復できるとしても、mutationの再適用、競合判定、画像 mutation gateの動作を確認すべきです。

   「pending行を残す」ことと「利用者に未送信編集が継続表示される」ことは同義ではありません。

14. study-days echo の wire契約

   client型、正常応答、`emptyBody`、field欠落、不正型を揃えて定義する必要があります。`owner_user_id` が string以外の場合も fail-closedにすべきです。

   またserver/clientのdeploy順とrollback非対称に加え、旧 tabが新serverを読む場合、新clientが旧serverを読む場合を明示すべきです。

15. sweepの実行頻度と eventual の意味

   mount 1回だけなら、sweep完了後に遅着した異 owner writerは、同じsign-in session中には回収されない可能性があります。「eventual」は次回sign-in/remount依存であり、時間上限がありません。この保証水準を明記すべきです。

## plan ドラフトへの抜け・未考慮指摘

1. 最重要の抜けは、Cache 保護集合取得後に upload/download が始まる raceです。ドラフトは「遅着 put は残る」方向だけを扱っていますが、逆に「新規 blobが cleanupに巻き込まれる」方向を扱っていません。これは単なる残骸ではなく、不可侵要件への反例です。

2. `downloading` jobの `added_asset_ids` に対応する `media_assets` 行を削除してよいか未検証です。ドラフトの表と「all-or-nothing維持」の説明の間に証明不足があります。

3. CAS mismatch後の回復を一律「次 trigger full pull」としているのは不正確です。別 pullによるcursor変化なら、次回は現在cursorからのdeltaです。

4. CAS abortの具体的なエラー境界がありません。transactionを確実にrollbackしつつ、既存のsilent `{ok:false}` 契約へ戻す設計が必要です。

5. purgeが新 session後に遅走するケースについて、「pending不変だからデータ喪失なし」だけでは不足です。新規upload/download、ready blob、prefsの新session操作、楽観mirrorの消失を個別に検討していません。

6. `<SignOutPurge />` の発火回数・Strict Mode/remount時の重複・auth状態の再遷移が未定義です。「1回発火」と「signed-out marketing pageごとに発火」が併記され、単位が曖昧です。

7. Cache列挙・削除の具体的なkey判定規則がplan送りになっていますが、削除安全性の中心なのでspec段階で固定すべきです。

8. Cache API非対応、`caches.has/open/keys/delete` の途中失敗、個別entry削除失敗時の振る舞いとテストがありません。

9. sync_metaのkey parser境界テストが不足しています。`future_key` だけでなく、既知base prefix、空suffix、複数colon、類似baseを含めるべきです。

10. store分類testをpure関数で行うだけでは、実際のDexie transaction store listや実削除queryとの乖離を検出できません。実DBを使ったstore横断の統合pinとschema追加時のexhaustivenessが必要です。

11. media status/outbox statusの将来追加に対するfail-safe方針がありません。否定条件の `status !== 'downloading'` は、新statusを自動的に削除対象へ入れるため特に危険です。

12. テスト戦略に以下が不足しています。

   - Cache保護集合取得と新upload/download開始の競合
   - purgeの二重並走
   - purge開始後の新session成立
   - downloading jobに属するready asset metadataの生存要否
   - malformed/unknown Cache key
   - Cacheだけ存在しDexieなし、かつCache操作途中失敗
   - CAS mismatchがcursor削除でなくcursor前進の場合
   - CAS abort例外が外へrejectせず `{ok:false}` になること
   - pending mutationを残してmirrorを消した後のflush/recovery

13. smoke方針は静的readback中心で、危険な非同期競合をほぼ観測しません。最低でも遅延させたupload/downloadまたはputとcleanupの交差試験が必要です。

14. 「Cache部だけ失敗 / blobだけ先に消えてもserverから再fetch」という論証は、uploading blobやdownload中blobには一般化できません。回復可能なのはserverに既に存在するready assetに限定される可能性があります。

15. 「purgeは冪等」という主張は最終状態については概ね成立しても、進行中writerとの交差では操作の意味が同一とは限りません。純粋な集合削除の冪等性と並行実行安全性を分けるべきです。

## リスク / 対立しうる設計判断

- 不可侵の強保証 vs lock・直列化禁止  
  Cache/IndexedDB横断では原子性がなく、完全な不可侵を主張するなら何らかの協調が必要です。協調禁止を優先するなら、保証をbest-effortへ弱め、破壊時の回復経路を証明する必要があります。

- orphan Cacheの積極削除 vs 進行中mediaの安全  
  未知・orphan keyを広く消すほど衛生は良くなりますが、保護集合snapshot後に生成された正当なblobを巻き込む危険が増えます。削除候補を既知の削除済みrow由来に限定すると安全性は上がる一方、orphan回収率は下がります。

- purgeのauth再検証禁止 vs 新session保護  
  再検証なしは単純ですが、旧signed-out処理が新sessionデータを消すことを許します。これはcorrectness漏洩ではないものの、可用性・帯域・prefs保持・進行中mediaには実害があり得ます。

- 全mirror削除 vs pending local workの継続性  
  outbox自体は残っても、楽観mirrorや依存metadataが消えると未送信編集の体験・flush前提が壊れる可能性があります。

- 未知key温存 vs privacy hygiene  
  sign-in sweepで未知sync_meta keyを温存する方針は将来互換性に強い一方、将来追加されたowner-bearing keyが異owner残骸として残ります。表示/read側が必ずowner分離されることを別の規約で担保する必要があります。

- 明示allowlist vs保守負担  
  silent削除を防げますが、分類testが実装定数と同じ誤りを共有すると形骸化します。schema・status・Cache namespaceを含む独立した網羅性チェックが必要です。

- best-effort trigger vs「eventual」という用語  
  次回mount/sign-inがなければ永遠に回収されません。これは「再実行機会があれば収束する」という条件付きeventualであり、無条件の最終回収保証ではありません。