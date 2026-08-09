# Codex plan cross-check — ocr-2-4b-s2-deletion-purge (2026-08-09)

- **作成日**: 2026-08-09
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **60 秒上限を本当に保証できるか**
   - `SRC_PURGE_BUDGET_MS=20_000` は purge 開始後の相対予算であり、先行する Stripe 処理・DB transaction が何秒消費したかを考慮しない。
   - DB retry の 3.5 秒は backoff だけで、各 DB query/transaction 自体の所要時間上限ではない。
   - Stripe subscription 数や retry 所要時間にも上限がなければ、「20 秒を足しても 60 秒以内」という根拠は成立しない。
   - purge の有限性と webhook 全体の `maxDuration: 60` 遵守は別の不変条件として扱う必要がある。

2. **失敗記録・通知処理も時間予算に含める必要**
   - DELETE は最大 10 秒で timeout しても、その後の最大 20 件の台帳 INSERT・Discord 通知には明示的な deadline がない。
   - `recordIntegrationFailure` は `notifyOps` の throw を伝播させる契約であり、ネットワーク待ちも含めて purge 全体が 20 秒を超える可能性がある。
   - 「purge は有限時間で必ず終わる」を成立させるには、R2 I/O だけでなく observability 処理も対象にする必要がある。

3. **観測処理の失敗が削除処理を中断してはいけない**
   - `list_truncated` の記録が throw したため、取得済み key の削除まで中断される、といった結合を避ける必要がある。
   - 個別 DELETE 失敗の記帳が throw しても、後続 key の DELETE は続けるべき。
   - 「全体を大きな try/catch で包む」だけでは、外へ throw しないことは保証できても、内部の forward progress は保証できない。

4. **bounded listing API の入力契約**
   - 新たな public export の `maxPages` に対し、`0`、負数、非整数、`NaN`、`Infinity` をどう扱うかが必要。
   - 内部利用だけなら export 範囲を狭める選択肢もある。export するなら fail-fast validation とエラー契約を決めるべき。

5. **破壊対象 key の二重検証**
   - LIST に prefix を渡すだけでなく、DELETE 直前にも全 key が厳密に `src/${internalUserId}/` で始まることを検証する余地がある。
   - malformed/想定外応答や mock の誺りが、そのまま別ユーザー key の破壊につながるため、破壊境界での defense-in-depth が有効。
   - 不一致 key は削除せず、loud に記録する契約が望ましい。

6. **LIST と同時 PUT の race は後着地以外にもある**
   - purge 完了後に PUT が着地する場合だけでなく、pagination 中や LIST 後・DELETE 前の同時 PUT、ページ間で集合が変わる場合にも取り漏らしうる。
   - ListObjectsV2 はトランザクション的 snapshot ではない。prefix 再 listing をしない本設計では、即時 purge は「その時点で観測できた集合への best-effort」であることを明文化すべき。

7. **即時削除要件と backstop 依存**
   - 本処理には retry がなく、dedup 済み webhook の再実行にも期待できない。
   - §3 sweeper が未実装・停止中でも lifecycle 約 48 時間で最終回収されるのか、法務・保持方針上それで許容されるのかを明確にする必要がある。
   - 台帳は削除意図そのものではないため、台帳記録だけでは確実な再処理対象にならない。

8. **台帳 entry の意味と phase の不一致**
   - `operation: 'object.delete'` の同じ entry に、LIST API throw、LIST truncation、deadline 打ち切りも記録すると、DELETE 失敗件数の集計に異種イベントが混ざる。
   - §3 の集計・alert が「1 行 = object DELETE 失敗」を前提にするなら、listing/control-flow 行との区別方法を集計契約まで確認する必要がある。
   - `phase` が context 内にしかない場合、4 軸集計だけでは区別できない。

9. **20 行上限の厳密な意味**
   - 21 件失敗時に「個別 19 行 + summary 1 行」とするのか、個別 20 行まで書いて追加 summary を諦めるのか。
   - `remainingFailures` は「20 件目を含む抑制件数」か「20 件目より後の件数」か。
   - `list_truncated` や `deadline` 行も 20 行上限に算入するのか。
   - 複数種類の打ち切りが同時に起きた場合の優先順位も必要。

10. **削除結果と集計値の定義**
    - `deleted` は DELETE 呼出数、`ok:true` 数、実際に存在した object の削除数のどれか。
    - 404 は success-equivalent なので、「deleted」と表記すると実削除件数と誤読される。
    - `remaining` が未試行 key 数であることも固定した方がよい。

11. **退会後に残す識別子のデータ最小化**
    - context の `userId`、object key 内の userId、台帳列の `userId`、場合によっては `clerkId` が、PII scrub 後も保持される。
    - plan の helper 引数に `clerkUserId` がある一方、要件は「key 以外の PII は入れない」としており、台帳列・Discord payload に clerkId を渡すかが曖昧。
    - integration failure 行の retention、閲覧権限、退会済み user との再結合可能性を確認すべき。

12. **prefix purge の冪等性**
    - DELETE の 404 success-equivalent により再実行安全なのはよい。
    - 一方、同じ退会イベントの重複実行時に truncation/deadline/失敗台帳が重複する可能性と、Clerk event dedup の境界を明記すると運用時の誤診を防げる。

13. **成功判定の限界**
    - 取得済み key の DELETE が全成功しても、削除後 readback を行わないため prefix が空になった保証はない。
    - 予算上 readback をしない判断は合理的だが、「purge 成功」ではなく「列挙済み key の削除要求成功」と表現すべき。

## plan ドラフトへの抜け・未考慮指摘

1. **webhook 全体の残時間を扱っていない**
   - Task 2 は purge 開始時に常に新しい 20 秒を与える。先行処理が既に 50 秒消費していても同じで、60 秒制約を守れない。
   - route 開始時刻または絶対 deadline の受け渡し、あるいは最低残時間 gate の検討が抜けている。

2. **台帳・Discord の所要時間を deadline test が覆っていない**
   - deadline test は残 chunk の DELETE 不呼出だけを確認している。
   - `recordIntegrationFailure` が遅い、または `notifyOps` が pending/throw する場合にも handler が収束するかという pin がない。

3. **大域 try/catch による早期中断リスク**
   - plan は「台帳呼出自体の throw も飲む」とするが、各記録 site を独立して保護するとは書いていない。
   - 特に `list_truncated` 記録失敗後も取得済み key を削除する test、個別記帳失敗後も後続 DELETE を続ける test が必要。

4. **`clerkUserId` 引数の用途が未定義**
   - `purgeSourcePrefix(internalUserId, clerkUserId, ...)` としながら、台帳 context の規定には clerkUserId がない。
   - 台帳の `clerkId` 列や Discord に渡すならデータ最小化要件と衝突し、渡さないなら引数は不要。

5. **subject・errorMessage の具体契約がない**
   - `recordIntegrationFailure` は `subject` 必須であるが、plan は値を定義していない。
   - DELETE の `{ok:false,status:null}` には例外メッセージが存在しないため、`errorMessage` をどう作るかも未指定。

6. **20 行アルゴリズムが曖昧**
   - 「19 行まで。20 件目以降が残る場合は20行目」という記述では、ちょうど20件失敗した場合の挙動が決まらない。
   - test も「21件以上・20行ちょうど」だけで、summary の `remainingFailures` の期待値を固定していない。

7. **control 行と failure-row cap の関係がない**
   - `list_truncated` 1 行を書いた後に DELETE が20件以上失敗した場合、合計21行を許すのか不明。
   - 「1回の退会で最大20行」という要件なら plan の個別失敗カウンタだけでは違反しうる。

8. **`listObjectsBounded` の引数境界 test がない**
   - `maxPages=0/負数/非整数` の契約と test が抜けている。
   - `maxPages=1` で、1ページ目が `IsTruncated=false` の場合は `truncated:false`、`true` の場合は `true` になる境界も明示的に pin した方がよい。

9. **既存 `listObjects` の guard 文言完全互換の実装条件が弱い**
   - wrapper が bounded の結果から throw する場合、従来と同じ「何ページ取得した後に」「どの定数を表示して」throw するかを pin する必要がある。
   - 「同条件」の test だけでなく既存エラーメッセージの同一性が重要。

10. **返却 key の prefix 検証がない**
    - mock が異なる prefix の key を返した場合にそれを DELETE しない testがない。
    - 退会処理という破壊操作では、storage helper を全面的に信用するかを明示的な設計判断にすべき。

11. **同時 PUT / pagination 変動の限界が test・docs task に反映されていない**
    - architecture.md の追記は §3/lifecycle を受け皿とするだけで、purge が snapshot ではない点を示さない。
    - 「退会時に prefix 全件が消える」と誤読される可能性が残る。

12. **観測 entry の意味を守る test がない**
    - `phase:'list'` 行にも `r2_deletion_src_delete` を使うことが、既存集計・alert と互換かの確認 task がない。
    - catalog の4軸一意性 testだけでは、運用上の意味の整合性を検証できない。

13. **テスト配置の選択が未決定**
    - plan は実質 route test に固定している一方、時間注入対象は private helper である。
    - private 関数を直接 test できないなら route harness で `now()` の進行をどう制御するか、あるいは module-level clock injection をどうリセットするかが未設計。
    - helper を export しない制約との両立方法が必要。

14. **import 時 fail-fast への対応が明示されていない**
    - `r2.ts` は module load 時に R2 env を要求する。既存 route test に import を追加すると、mock hoistingや環境設定次第で suite 全体が import 前に落ちうる。
    - mock 追加の順序と既存 env harness との互換を完了条件に含めるべき。

15. **smoke の成功条件が強すぎる可能性**
    - unit 設計では best-effort・上限付きなのに、smoke は prefix 0 件を必須としている。通常規模では妥当だが、失敗時に「実装不良」「R2一時障害」「後着地 PUT」を切り分ける手順がない。
    - 0 件でない場合の停止、台帳確認、presigned URL 発行時刻確認、lifecycle 待ちへの移行手順が必要。

## リスク / 対立しうる設計判断

- **即時性 vs webhook 可用性**  
  handler 内直接 purge は即時性を高める一方、60 秒制約と Clerk webhook の処理余裕を削る。絶対 deadline を共有しなければ、best-effort 削除が webhook 自体の強制終了を招きうる。

- **詳細な1件1行記録 vs forward progress**  
  個別記録は調査性が高いが、最大20回のDB・通知 I/Oが削除本体より重くなりうる。1件1行の裁定を維持する場合でも、記帳を削除クリティカルパスからどう隔離するかが必要。

- **台帳の完全性 vs データ最小化**  
  userId/objectKey は再調査には有用だが、退会後の相関識別子を新たに残す。保持期限とアクセス制御がなければ、source PDF を即時削除するプライバシー目的と緊張する。

- **既存 API 契約維持 vs bounded API の安全性**  
  pagination core 共通化は妥当だが、public な数値引数を増やすことで新しい不正入力面が生じる。型だけでは正の整数を保証できない。

- **取得済み key の削除継続 vs 異常時 fail-closed**  
  `truncated:true` でも取得済み key を消すのはデータ最小化には有利。一方、異常な listing 応答に混入した prefix 外 key まで消さないための検証が必要。

- **単一 catalog entry vs telemetry の意味精度**  
  entryを増やさない簡潔性と、LIST失敗・DELETE失敗・予算打ち切りを正しく区別する運用性が対立する。少なくとも既存集計は `phase` を認識する必要がある。

- **成功 readback なし vs 時間上限**  
  readback は完全性を高めるがLIST予算をさらに消費する。本設計で省くなら、成功の意味を「prefix 空」ではなく「観測済み対象への削除要求完了」に限定すべき。