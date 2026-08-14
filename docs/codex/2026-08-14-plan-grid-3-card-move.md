# Codex plan cross-check — grid-3-card-move (2026-08-14)

- **作成日**: 2026-08-14
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **undo の「前提変化」判定には server-side の原子的な比較が必要**

   要件は「前提変化時は失敗＋理由」だが、単にカード・元 exam の存在を見るだけでは不足する。forward 後にカードが別操作で再移動・並べ替えされた場合、古い絶対値による undo が後続操作を上書きする。

   少なくとも undo apply 時に、各カードが forward 直後の `(exam_id, base_order)` のままであることを同一 tx 内で比較する必要がある。client mirror だけの検査では stale mirror・別端末競合を検出できない。

2. **通常 move と条件付き undo は意味論が異なる**

   通常 move は絶対値 LWW でよいが、undo は「現在値が期待値と一致する場合だけ復元」という compare-and-set に近い。現在の wire `{id, base_order}` だけでは expected current state を運べない。

   選択肢は次のいずれかになる。

   - `card_move.move` に任意の precondition を持たせる
   - undo 専用 mode を同じ op 内に設ける
   - 「前提変化時失敗」を弱め、存在確認だけと明文化する

   凍結要件をそのまま満たすなら前二者が必要。

3. **`base_order` の PostgreSQL `integer` 上限を全経路で扱う必要**

   schema は `integer` なので最大値は `2,147,483,647`。一方、wire は `z.number().int().min(1)` のみで上限がなく、`i * 1024`、末尾の `max + count * stride`、再採番後の総件数で DB 範囲を超え得る。

   必要な論点は以下。

   - wire で DB integer 上限を検証する
   - `Number.isSafeInteger` 相当も保証する
   - planner が末尾採番・一括再採番の overflow を明示的に失敗させる
   - UI が optimistic update 前に理由を表示する
   - 境界テストを設ける

4. **10,000 assignment と実装方式の容量設計**

   10,000 件を許すなら、約 550KB という JSON 推定だけでは不十分。

   - Next.js／proxy／CDN／WAF の request body 上限
   - zod parse の CPU・メモリ
   - DB statement timeout、lock 保持時間
   - response／ログへの巨大 payload 混入
   - Dexie での 10,000 回 update
   - server の 10,000 回逐次 UPDATE

   特に per-card UPDATE 方式は、集約 op でネットワーク往復を減らしても DB 内で N クエリになり、大規模結合や再採番で tx が長時間化する。上限を契約にするなら `UPDATE ... FROM VALUES`、chunk の扱い、bind parameter 上限まで評価が必要。

5. **client 上限超過を optimistic update 前に拒否すべき**

   server zod だけで 10,000 件超を拒否すると、mirror は移動済み、outbox は永久 pending という既知の破綻になる。件数は planning 時点で確定するため、client は enqueue／mirror 更新前に同じ上限で fail-fast できる。これは残余リスクとして受容するより、低コストで防げる必須防衛に近い。

6. **assignment 件数は「移動枚数」ではない**

   step=0 では常駐カードも patch に含まれる。したがって、移動対象が少数でも target exam の再採番により 10,000 件を超える。UI の事前判定、進捗表示、監査ログ、テストでは次を区別する必要がある。

   - moved card count
   - assignment count
   - renumbered resident count

7. **server が受け取る assignment の意味境界**

   patch は移動対象と再採番常駐を区別しないため、server は「指定された所有カードをすべて target exam に所属させる」だけになる。これは薄い apply と引き換えに、壊れた／古い client が target 外の任意の所有カードを同一 op に混ぜても受理する設計である。

   認可上は他 tenant を守れても、domain validation はほぼ client 信頼になる。この信頼境界を明記し、少なくとも observability と異常件数検知が必要。

8. **missing と他 tenant を同じ skip にする意味**

   owner-scoped SELECT では「削除済」と「他 tenant の既存 ID」を区別できず、両方 skip される。情報漏洩を避ける点では妥当だが、all-or-nothing の説明は正確には「現在 user が所有し、存在するカードだけに適用」である。

   また typo・client corruption も削除済と同じく成功扱いになるため、skip 件数を server log／metric に残さないと不具合が不可視化する。

9. **全件 missing を `applied` にする観測性**

   冪等な収束には有利だが、壊れた patch や ownership bug も成功扱いになる。少なくとも `requestedCount / appliedCount / skippedCount` の構造化ログまたは metric が必要。クライアントに詳細を返す場合は tenant 情報を漏らさない設計が必要。

10. **楽観更新と blind pull の競合**

    pull は version 比較なしの `bulkPut` なので、move の optimistic mirror 更新後、server apply 前の pull が旧 server 行を取得すると、mirror を元に戻し得る。その後 flush 成功時に必ず pull-back されなければ、server と mirror の乖離が残る。

    次を明確にすべき。

    - entity mutation flush 成功後に cards pull が必ず起動するか
    - pending mutation の対象行を blind pull が上書きしてよいか
    - pull と planner read の競合時にどの snapshot を使うか
    - pending overlay または成功後 pull が必要か

11. **client planning と optimistic write の snapshot 一貫性**

    movedCards／targetCards を Dexie から読んだ後、別 pull・別操作が入り、その後 `runOptimisticMutation` の tx で update すると、計算の前提と書込み時点がずれる。読み取りも同じ Dexie transaction に含めるか、書込み前に対象値を再検証する必要がある。

12. **MoveCards の入力集合の source exam 制約**

    内部操作の定義は一般の「対象カード群」だが、undo wire は単一 destination exam しか表せない。複数 source exam のカードを一度に移動した場合、逆操作は一件の MoveCards では戻せない。

    現 UI は事実上単一 source に寄せられているが、内部 API／hook でも次のどちらかを契約として固定すべき。

    - moved cards は全て同一 source exam でなければならない
    - undo は source exam ごとに複数 mutation を発行する

13. **undo が復元すべき状態の範囲**

    forward の step=0 で target 常駐カードを再採番した場合、cross-exam undo が移動対象だけを戻すと、表示上の相対順は保たれても target の元の絶対 `base_order` は戻らない。

    要件の「元の `(exam_id, base_order)` を控え逆方向 MoveCards を絶対値で発行」を厳密に読むと、forward が触った全 assignment の復元が自然である。一方、単一 destination wire では source と target の両方を一件で復元できない。ここは「undo は視覚順のみ復元」か「全書込みを復元」かを明示すべき対立点。

14. **同一 exam 内 undo と後続 insert の競合**

    元の絶対値を復元すると、toast 表示中に新規カード作成や別 reorder が入った場合、重複値や意図しない交錯が起こる。重複自体は許容されるが、「前提変化」として拒否する範囲を定義する必要がある。

15. **空集合・stale count の扱い**

    merge UI の `cardCount > 0` と実行時の mirror 内容は競合し得る。実行時に 0 件なら schema の `.min(1)` と衝突する。以下を明示すべき。

    - 0 件は UI no-op success か、理由付き失敗か
    - selectedIds の一部が mirror から消えた場合
    - moved card の read 結果が要求 ID 数と一致しない場合

16. **切り出しの `runGuardedPull` は hydrate 完了保証とは限らない**

    Web Lock が busy の場合、`runGuardedPull` は skip outcome になり得る。単に await しても新 exam が mirror に必ず存在するとは限らない。その状態で move を続行すると、undo の「元 exam／target exam 存在」判定や picker 表示と不整合になる。

    server action の返却 ID を用いて move 自体は可能でも、mirror hydrate を前提にする箇所を分離すべき。

17. **切り出しの部分成功と再実行**

    exam create 成功後、move の local transaction が失敗すると空 exam が残る。許容するとしても、二度押し・通信再試行で「無題の試験」が複数作られる可能性がある。commit 中 disable、action の二重実行防止、失敗後の再試行 UX が必要。

18. **rename の同時編集・失敗状態**

    rename は server action で LWW になる。blur と Enter が連続発火して二重 commit しないこと、外部 refresh で local title state が古いまま残らないこと、trim 後の値を UI に反映すること、同名・未変更時の扱いを決める必要がある。

19. **exam `updated_at` を move で触らないことの UI 波及**

    一覧を `updated_at desc` で並べるなら、カードを移動・結合した試験が最近の試験として浮上しない。これは技術的不変条件と UX の衝突なので、一覧の並びを「試験メタデータ更新順」と説明するか、カード活動順を別途設けるか判断が必要。

20. **source document 横断順序の意味変更**

    `(exam_id, base_order, id)` は決定的だが、UUID の exam_id 順はユーザーに意味のある試験順ではない。利用先が表示・生成・学習セッションであれば、決定性だけでなく意味的順序が必要かを確認すべき。exam 名、作成時刻、元の document sequence 等との整合も要る。

21. **UI の大量リストとアクセシビリティ**

    「少数枚用」という説明だけでは、大量 exam を選択した際の checkbox 全件 render を防げない。上限、検索、遅延読込、または一定件数以上を UI で拒否する必要がある。

    Popover を menu として使う場合、keyboard navigation、focus return、Escape、aria role、disabled reason の読み上げも確認対象。

22. **toast の lifecycle**

    local state 方式では、table/card の live 更新による再レンダーは問題ないが、component unmount、route refresh、表示モード切替で消える。これは reload で消える要件には合うものの、`router.refresh()` 等でも消える可能性がある。どの操作が toast owner を unmount するか確認が必要。

23. **複数 move の toast 方針**

    15 秒以内に連続 move した場合、前の undo を上書きするのか、queue するのか、同時表示するのかが未定義。単一 local state なら通常は最新だけが残る。これは「toast 表示中のみ undo」と関係するため明示が必要。

24. **failed mutation の回復性は destination deletion 以外にも広い**

    恒久 validation failure、payload 上限、DB integer overflow、schema mismatch、壊れた UUID、将来の constraint 違反でも mirror は楽観状態のまま pending になる。残余リスクは「移動先 exam 並走削除」だけではない。失敗分類と recoverable／terminal の区別が必要。

25. **運用・observability**

    新しい集約 op は一件で多数行を変えるため、少なくとも以下が必要。

    - assignment／moved／skipped 件数
    - apply latency と tx timeout
    - validation failure reason
    - destination-not-found 件数
    - 10,000 上限接近
    - stale 隔離された `card_move`
    - mutation_id／op instance id を用いた追跡

26. **migration の展開互換性**

    CHECK 先行は正しいが、「新 client →旧 server」は service worker/CDN cache、複数 server version、長時間開いたタブを含めて評価すべき。failed が retry されるだけでなく、旧 server が unknown envelope を batch 全体 400 にする経路がないことも pin が必要。

27. **性能・ロック競合**

    `cascadeLike` は同一 request 内の実行順を制御するだけで、別 request／別端末の tx を直列化しない。大規模再採番と create、delete、別 move が同時に走る場合の row lock 順序、deadlock、statement timeout、retry 方針が必要。

---

## plan ドラフトへの抜け・未考慮指摘

1. **最重要: undo の前提変化検査が不足**

   Task 5 は card 欠け・元 exam 消滅しか検査しない。forward 後にカードが別 exam へ移された、同一 exam 内で再配置された、別端末で更新された場合を検出せず、古い undo が後続操作を上書きする。しかも検査は mirror 上だけで、apply まで原子的でない。

2. **undo wire の設計タスクが欠けている**

   expected current `(exam_id, base_order)` を server に渡す schema、apply 内の条件検査、競合失敗理由、テストがない。「前提変化時失敗」を満たすには Task 2 の契約変更が必要。

3. **`base_order` overflow の検証・テストがない**

   Task 1、Task 2 とも DB integer 最大値を扱っていない。`z.number().int()` は PostgreSQL integer の範囲保証にならない。末尾、再採番、k≥S の全経路に境界テストが必要。

4. **10,000 件を per-card UPDATE でよいと断定している**

   Task 2 の「数千行で問題が出てから」は、すでに wire が 10,000 件を正式サポートする設計と矛盾する。実装前に representative な 1k／10k の iso benchmark、statement timeout、query count を gate にすべき。

5. **client-side 10,000 件事前拒否がない**

   server validation failure後の mirror 乖離を既知としながら、Task 5 は assignment 計算後に上限を確認せず optimistic update する。これは容易に防げる抜け。

6. **MoveResult の `sourceExamId: string` が暗黙**

   `moveCards` の入力は任意の `cardIds` なのに、全カードが同じ source exam か検証する手順がない。複数 source が入ると undo が一部しか戻らない。hook の runtime invariant と失敗テストが必要。

7. **missing moved card の client 検査がない**

   要求 `cardIds` と mirror read 結果の件数一致を確認せず planning すると、選択直後の削除・stale ID が黙って消える可能性がある。0 件も含めて behavior が未定義。

8. **cross-exam step=0 undo の期待値が弱い**

   Task 1 は「cross-exam undo が移動対象のみを返す」と固定しているが、target 常駐カードの絶対値を復元しない。これは「順序を戻す」のか「forward が変更した状態を戻す」のかという仕様上の争点をテストで先に固定してしまっている。

9. **blind pull と optimistic move の競合テストがない**

   Task 5 に、enqueue 後・server apply 前の `runGuardedPull` が旧 server 値を `bulkPut` するケースがない。flush 成功後の pull-back も Task 2／5 の完了条件に含まれていない。

10. **Dexie read-plan-write の一貫性がない**

    hook 手順は mirror read → plan → 別 transaction で update/enqueue。途中の pullや別 moveによる変更を検出しない。読み取りを transaction に含めるか、expected local values を再検査する設計が plan にない。

11. **切り出しで guarded pull の outcome を確認しない**

    Task 6 は `runGuardedPull` を await するだけ。lock busy で skip された場合の hydrate 不成立を扱っていない。

12. **切り出しの二重 submit／複数空 exam のテストがない**

    create 中・pull 中・move 中の disable、double-click、move 失敗後の再試行が未記載。

13. **rename の二重 commit race が未考慮**

    Enter に続いて blur が発火する一般的なケース、props 更新と local state の同期、trim 後表示、未変更時 no-op のテストがない。

14. **toast の連続操作方針がない**

    Task 5 は単一 toast component の機能だけで、二回連続 move、古い timeout が新 toast を閉じる timer race、unmount cleanup を扱っていない。

15. **toast の二度押し防止の責務が曖昧**

    Task 5 は `ActionToast` の test に disabled を要求するが、Props に pending 状態や disabled がない。action component が押下直後に同期的に無効化するのか、親が管理するのかが未設計。

16. **大規模 picker の保護がない**

    Task 7 は検索・仮想化なしで全カードを render する。説明文だけでは性能問題を防げない。少数枚の具体的上限か、source 選択時の件数 gate が必要。

17. **bulk request body／インフラ上限の検証がない**

    Task 2 の tests は zod 件数だけで、実 HTTP endpoint に約 550KB以上を送る試験、deployment platformの制限確認がない。

18. **server apply の observability がない**

    skip-missing、全滅 applied、destination missing、大規模 tx の構造化ログ／metric が task に含まれていない。成功扱いの silent skip を後から診断できない。

19. **別 request 間 concurrency の iso test がない**

    cascadeLike の unit testは batch内 serial fallbackだけ。二つの同時 move、move対delete、move対create、再採番同士の競合・deadlock試験がない。

20. **UI 4入口の共通契約テストが不足**

    各 component は mock `moveCards` の引数確認中心で、全入口が実際に「基準順保持」「上限事前拒否」「単一 source」「undo 素材」を同じ hook 経由で満たす integration test がない。

21. **source-document 順序変更の消費者影響調査が plan にない**

    Task 3 は query と iso testだけで、`getCardsForSourceDocument` の全 callerにとって UUID exam順が妥当か確認する作業がない。

22. **exam 削除との UI race が限定的**

    destination deletion は残余リスクにあるが、pickerを開いたまま削除、source deletion、結合元削除、undo中削除など入口別の状態遷移が未テスト。

23. **deployment smoke に失敗系が不足**

    smoke は成功系中心。少なくとも destination並走削除、undo前提変化、10,000超過事前拒否、network offline→再送、旧server切替窓、連続move/toast置換を含めるべき。

24. **「各 task が独立に green」と migration 先行制約の緊張**

    Task 2 が schema、generated migration、registry、wire、serverを一 commit相当にまとめると、実際の本番展開単位では migration先行とcode deployを分離できる成果物・手順が必要。plan上の開発commit構成とdeploy artifact順序を区別すべき。

---

## リスク / 対立しうる設計判断

| 設計判断 | 利点 | 主なリスク・対立 |
|---|---|---|
| clientで絶対値化 | wire統一、再送冪等、薄いserver | stale snapshot、domain検証をclientに依存、undo競合検出が困難 |
| missing cardをskip | delete競合で永久retryを避ける | typo・破損・他tenant IDも成功扱い、異常が不可視 |
| undoを通常MoveCardsで表現 | 機構が単純 | 条件付き復元を表現できず、後続操作を上書き |
| cross-exam undoでtarget再採番を戻さない | 単一mutationで済む | 元の絶対状態には戻らない。「undo」の意味が弱い |
| `content_version`を触らない | 既存実装と整合 | 将来version競合制御を導入する際にmove履歴だけ欠落 |
| exam `updated_at`を触らない | カード以外不触を厳守 | 一覧の更新順がユーザーの活動順と一致しない |
| per-card UPDATE | 実装が単純 | 1k～10k件でtx長期化、timeout、deadlock、DB負荷 |
| 10,000固定上限 | DoS防御が明確 | optimistic後server拒否、インフラ上限・DB整数上限とは無関係 |
| local toast state | 実装最小、reloadで消える | route/unmountで意図せず消える、連続操作で旧undo喪失 |
| picker全件render | 実装が簡単 | 大規模examでUI freeze、アクセシビリティ低下 |
| `(exam_id, base_order, id)` | 決定的 | UUID順に業務的意味がなく、消費者の期待順とずれる |
| cascadeLike serial fallback | 同一batch内競合を低減 | 別request・別端末は直列化されず、完全な競合制御ではない |

結論として、plan の最大の未充足は **undo の前提変化を server で原子的に検出できないこと**、次いで **`base_order` integer overflow**、**10,000件を支える性能・client事前拒否**、**blind pullと楽観更新の競合**です。これらは実装中の細部ではなく、wire／apply契約に戻る設計論点です。凍結 spec の「仕様判断が必要なら停止」に該当するため、実装開始前に OT へ再裁定を求めるのが妥当です。