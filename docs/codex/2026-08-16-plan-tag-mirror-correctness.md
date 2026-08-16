# Codex plan cross-check — tag-mirror-correctness (2026-08-16)

- **作成日**: 2026-08-16
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. 「capture した owner の領域だけに書く」という不変条件は、cursor と `study_days` には成立するが、main pull の mirror 全体には成立しない。

   `pullDelta(A)` が capture するのは cursor key の owner だけで、cards / exams / tag_* の行 owner はサーバーレスポンス由来である。認証切替との境界で、capture 値 A とレスポンス owner B が食い違う可能性を設計上どう扱うかが未定義。

   最低限、main pull payloadについても次の契約を明示する必要がある。

   - owner 列を持つ全行が captured `userId` と一致すること
   - 不一致時に全 tx を reject すること
   - tombstone / `card_tags` のように owner 列を直接持たないデータを、owner 検証済み親データとの関係でどう検証するか
   - 認証切替中にサーバーが別 owner の payload を返し得ないという前提を置くなら、その根拠とテスト

2. バージョン混在・古いタブが考慮されていない。

   デプロイ後も既に開いている旧 bundle は次を継続できる。

   - owner 無スコープの読み
   - unscoped cursor の利用
   - `study_days.clear()`
   - owner guard のない mutation

   新実装だけが正しくても、同じ IndexedDBを旧タブが操作すればブラウザ全体としての「構造保証」にはならない。少なくとも以下の裁定が必要。

   - correctness保証の開始点を「全タブ reload 後」と限定するか
   - app/build version不一致を検出して旧タブを reload・書込停止させるか
   - stg smoke に旧 bundle タブと新 bundle タブの共存を含めるか
   - hygiene sprintまで旧タブ問題を送ってよいのか。ただしこれは衛生ではなく correctness に属する

3. 「異 owner データが表示されない」の保証範囲が曖昧。

   11件の全店読みと4件の直接 mutation guardは列挙されているが、保証対象が以下のどこまでかを明記すべき。

   - 現在存在するUI経路のみ
   - lib APIを直接呼ぶ全経路
   - 将来追加される読みを含むアーキテクチャ不変条件
   - dashboardを含む全画面
   - owner由来IDをURL、props、React state、古いRSC payloadから受け取る経路

   機械強制なしの場合、新規の `toArray()` や `.get(id)` 一件で保証が退行する。規約だけで構造保証と呼ぶなら、review checklist、コード所有者、grep/audit手順などの継続的な検出策が必要。

4. owner由来UUIDに依存する除外裁定には、IDの由来境界が必要。

   UUID衝突を無視すること自体は妥当でも、「そのIDが必ずownerスコープ済み読みから来る」ことは別の主張である。次を確認すべき。

   - URL paramsやserver propsからIDを直接受け取る経路
   - owner切替前のReact state、closure、非同期 callbackに残ったID
   - stale RSC payload / BFCache復元
   - mutation helperを他のcallerが直接呼べるか
   - `card_tags` tombstone/deleteが親IDだけで他owner行に到達しないか

5. `study_days` payload検証は良いが、snapshotの鮮度競合は残る。

   同一ownerで複数の `pullAllStudyDays` が並走すると、古いsnapshotが後着して新しいsnapshotを上書きし得る。これは異owner漏えいではないが、ユーザーデータの退行リスクである。既存問題として受容するなら、明示的に非保証へ置くべき。

6. `study_days` の「owner行 delete → bulkPut」は単一txであっても、検証対象と書込対象の同一性を保証する必要がある。

   検証後に変換・schema parse・正規化された別配列を書き込む場合、検証済み配列と実際の `bulkPut` 配列が異ならないことが重要。API responseのruntime schema検証、重複PK、欠落 `user_id`、不正型も裁定が必要。

7. `sync_meta` keyのowner識別は「非空文字列」だけでは契約が弱い。

   内部UUIDであることが前提なら、空白、delimiterを含む値、Clerk IDの誤伝播などもcaller bugである。UUID runtime validationを行わない場合は、「型とRSC起点を信頼し、非空のみ検査する」という保証限界を明記すべき。

8. 旧keyを読まない移行はcursorだけでなくprefs UXにも影響する。

   全deviceでfull pull、prefs resetが同時に起きる。以下が未評価。

   - 大規模データ利用者の初回pull負荷
   - 複数タブが同時にfull pullする負荷
   - rate limit、timeout、部分失敗時の再試行増加
   - prefs resetが保存失敗と誤認されないか
   - deploy rollback時に旧コードが旧cursorへ戻り、移行期間中の更新を取り逃がさないか

9. ロールバック互換性が未定義。

   新版はscoped keyだけ更新し、旧keyを放置するため、旧版へ戻すと古いcursorから再開する。通常は重複取得で済むのか、削除/tombstoneの再現範囲、cursor retentionとの組合せで欠落し得るのかを確認すべき。

10. fail-closed時の可観測性が弱い。

   空userIdやowner mismatchをsilent FAILにすると、UIは古いローカルデータを表示し続ける可能性がある。異owner表示は防げても「データが更新されない」状態が不可視になる。ログの機密性、頻度制限、監視、再試行、ユーザー通知の要否を決める必要がある。

11. owner切替時のUI状態はIndexedDB読みだけでは閉じない。

   `useLiveQuery` deps更新は必要だが、次も確認対象になる。

   - component local state
   - memo/cache
   - query結果から作ったselection
   - open popover/modal
   - optimistic state
   - pending promise callback
   - BFCache復元
   - Next.js client navigation cache

   DBクエリがowner scopedでも、Aの結果を保持したcomponentがBへ切り替わった瞬間に一時表示する可能性がある。

12. 「全書込点棚卸し」の将来維持方法がない。

   現在の全数性は強いが、一時点の証明である。新store、新helper、新しいDexie書込構文が追加された際の検出方法が必要。少なくともarchitecture規約に棚卸しクエリとレビュー観点を残す価値がある。

13. security/correctness境界を明記すべき。

   owner scopeはクライアント表示漏れを防ぐ防御であり、ローカル利用者によるDevTools/IndexedDB直接閲覧や端末上のat-rest confidentialityは保証しない。共有ブラウザ要件が「UI非表示」なのか「前ユーザーのデータを取得不能」なのかを明確にしないと、関係者が保証を過大解釈する。

14. server側認可との対応関係が必要。

   client `userId` は表示・namespace選択用であって、API認可主体ではない。prop改変やstale propでもサーバーが常にsession ownerだけを返すこと、client userIdをtenant selectorとして信用しないことを不変条件として記録すべき。

## plan ドラフトへの抜け・未考慮指摘

1. Task 4にmain pull payloadのcaptured owner検証がない。

   `study_days`だけはowner mismatchを全体rejectする一方、cards / exams / tag_categories / tag_optionsなどには同等のpinがない。capture原則を本当にowner分離の根拠とするなら、最重要の不足。

2. 旧bundleとの同時実行テストがない。

   stg smokeはA/B切替のみで、旧タブが `study_days.clear()` やowner無スコープ読みを続けるケースを扱わない。deploy直後の現実的な反例である。

3. owner切替直後の一時表示テストが不足している。

   Task 2は初期状態でAをrenderしてB行が出ないテストが中心。必要なのは同一mounted componentをA→Bへrerenderし、Aの結果・local state・popover内容が残らないpin。

4. props伝播の正しさをtypecheckだけに依存しすぎている。

   型検査は「何らかのstringを渡した」ことしか保証しない。内部 `users.id` ではなくexam IDやClerk IDを誤って渡しても通る。主要RSC境界で正しいuserIdを渡すcomponent testが必要。

5. Task 4のcaptureテストが、実際の認証切替境界を表現していない。

   A/Bの`pullDelta`をinterleaveするだけでは、captured Aとサーバーレスポンスowner Bが食い違うケースを検証できない。payload owner mismatchまたは認証切替時の契約を直接pinすべき。

6. 6 streamのテストがcursorだけに寄っている。

   tombstoneや`card_tags`はowner列なしの操作を含むため、異ownerの既存行を削除しないことのテストが必要。特に悪意ではなくstale IDやpayload契約driftを想定する。

7. `study_days` の並走・逆順完了テストがない。

   owner分離テストとは別に、同一ownerの古いsnapshot後着を受容するのか防ぐのかを決める必要がある。

8. migration・rollback試験がない。

   少なくとも次が必要。

   - legacy unscoped keyだけ存在するDBからの起動
   - scoped/unscoped key併存
   - 初回full pull失敗後の再試行
   - 新版利用後に旧版へrollbackした場合の挙動評価

9. full pullの運用負荷評価がない。

   全device一斉full pullを「一回コスト」として受容しているが、データ量、API rate、timeout、stgでの代表的大容量アカウント確認が計画にない。

10. owner mismatchログの仕様が未完成。

   event名だけでなく、userIdやpayload内容をログに出さないこと、件数、request correlation、監視先、連続再試行時のログ増幅を決めるべき。

11. `scopedSyncMetaKey`規約の退行検査がない。

   lintを作らない裁定でも、テストまたはCIで `sync_meta.put/get` の直書きを列挙する軽量auditは可能。少なくとも完了gateにproduction callerの再棚卸しを入れるべき。

12. Task 1の4 handlerテストは対象名を明示すべき。

   「rename / color 4 handler」では、どの4関数を必ずpinするか曖昧。削除・cascade系を含むなら、異ownerの子行やoutboxも不変であることを各関数単位で確認すべき。

13. dashboard smokeと実装対象の対応が示されていない。

   smokeではdashboardを確認するが、読みスコープ対象表・component testにはdashboard固有経路がない。dashboardが同じowner-scoped libを使う根拠を明示するか、専用テストを追加すべき。

14. TDDの「変異でred実証」が実行手順として危うい。

   実装を一時的に外す手動変異は記録性が低く、誤コミットの原因になる。テスト追加前の既存コードでredを記録する、または限定的mutation testとして方法を定義する方がよい。

15. Task単位commit/reviewとread-only設計レビューの責務が混在している。

   各taskでcanonical/Codex review収束を要求するとレビュー回数と境界が曖昧になる。task reviewと最終設計保証reviewで、確認対象を分けるべき。

16. 完了条件にブラウザ差・複数タブ実測がない。

   今回Web Locks依存は撤回されたが、IndexedDB共有、旧接続、BFCache、複数タブの状態残留は実ブラウザ依存。最低限Chrome系での複数タブ切替、可能ならSafari系を含む確認範囲を定めるべき。

17. hygiene sprintへの引継ぎに受入条件がない。

   「後で別spec」とするだけでは恒久放置されるリスクがある。追跡先、期限、対象データ、容量上限、privacy上の残余リスクをarchitectureまたはissueに紐付ける必要がある。

## リスク / 対立しうる設計判断

- main pull全payloadをcaptured ownerと照合するか  
  強いfail-closedになる一方、owner列を持たないtombstone等の検証が複雑になり、契約drift時にsync全停止となる。

- 旧タブを強制reloadするか  
  correctness保証は強くなるが、編集中データやpending outboxを失う可能性がある。書込停止＋明示reload案との比較が必要。

- 空userIdのみ検査するかUUIDまで検査するか  
  UUID検査は誤配線を早期発見できるが、テストfixtureや将来のID形式変更との結合が強くなる。

- owner由来IDの二次読みを現状どおり信頼するか  
  変更量とindex/schema bumpを避けられる一方、「入口が閉じている」という非局所的な証明に依存する。重要mutationだけowner guardを重ねる案もある。

- `study_days`並走を受容するか直列化・世代化するか  
  本sprintの異owner保証だけなら受容可能だが、古いsnapshot後着によるデータ退行は残る。scopeを広げるか既知リスクとして固定する必要がある。

- 規約だけで`sync_meta` namespaceを守るか軽量gateを置くか  
  lint新設は過剰でも、直接アクセスのgrep/audit testは比較的安価。将来の一件の直書きが保証全体を壊すため、完全に人的reviewだけにする判断はリスクが高い。

- 旧keyを放置するか移行マーカーを持つか  
  放置は実装が単純でraceも増やさない。一方、容量、rollback、どの版が最後に使われたかの診断性は下がる。

- silent FAILを維持するかUIへ同期異常を出すか  
  silentは既存UXと整合するが、長期stale状態を発見しにくい。少なくともtelemetryと再試行上限の裁定が必要。

- 「表示されない」をsecurity保証と呼ぶかcorrectness保証に限定するか  
  IndexedDB残骸は共有端末のローカル利用者から直接閲覧可能である。UI経路のtenant isolationとat-rest privacyを明確に分離して伝える必要がある。