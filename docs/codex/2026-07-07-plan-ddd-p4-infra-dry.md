# Codex plan cross-check — ddd-p4-infra-dry (2026-07-07)

- **作成日**: 2026-07-07
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- 最上位は「挙動不変」。API shape、status、error code、header、log/ops event 名、文言、snapshot は原則固定。W6 の TEMP-MEASURE 撤去だけが明示例外。
- DRY の対象は「現存する同型」だけ。予測共通化、設定可能化、wire generic 化、retry 体系統合、clock helper 化は scope creep になりやすい。
- outbox は「限定共通化」と「統合」の境界が重要。per-table 機械操作だけを括り、review 固有の retry controller、pull-back、session grouping、in-flight の分離は維持すべき。
- pull factory は SQL builder 部限定。cursor 列、return key、mapper、card_tags の createdAt semantics、client 側補完、PullResponse wire は entity 側に残す必要がある。
- route 認証 wrapper は read-only 4 本だけ。同じ wrapper に見えても、`UnauthenticatedError`、`!user`、内部例外、log level、`Cache-Control: no-store` の付与範囲が route ごとに完全一致しているかが主リスク。
- lib 再編は import path 変更より module-load side effect が危険。`lib/clerk.ts` / `lib/stripe.ts` の fail-fast 発火タイミング、server/client 境界、循環 import を build と review で見る必要がある。
- `VERCEL_ENV` helper は式の意味を統一してはいけない。`?? NODE_ENV ?? 'unknown'` 系と `=== 'production'` 系、さらに fallback なしの site が混ざる可能性を分けて扱うべき。
- replacer 統合は byte-exact 前提。新たな public export や import 方向による循環が生じるなら、単純 DRY 以上の設計変更になる。
- contact-form action の `lib/actions` 移設は `'use server'` の維持だけでなく、client component からの import が Next の server action 制約に沿うかが確認点。
- measure revert は「consumer 不在」が成立条件。repo 外監視、ログ集計、運用 dashboard まではコード検索で保証できないため、OT 判断済みの範囲を明記しておくべき。
- 検証は task 局所 test だけでなく、import path 変更ごとの build、P0 contract snapshot 更新ゼロ、最終 full test が必要。

## plan ドラフトへの抜け・未考慮指摘

- **Task 3 が spec と食い違っている可能性が高い**。spec §3.4 は `UnauthenticatedError → 500` と読めるが、plan は `UnauthenticatedError → 401 {error:'unauthenticated'}` としている。ここは凍結契約の中核なので、現行 4 route の実応答に合わせて明確化が必要。
- Task 3 の `authFailEvent なし → rethrow` は、outer catch で最終的に何 status/body/header/log になるかまで固定していない。`exams/status` の非対称保存を狙うなら、wrapper 外側との合成後の応答を受け入れ条件に書くべき。
- Task 1 は spec が「per-table 同型 5 対」と言う一方、plan は「同型 4 対」として in-flight を対象外にしている。分離維持が正しそうだが、数え方の不一致は実装時の迷いになるため、in-flight は「確認のみ・helper 化しない」と明記した方がよい。
- Task 1 の `modifyByKeys(... patch)` は Dexie `modify` に渡す object の評価タイミングが現行と一致するか注意。特に `last_attempted_at` が caller 側で一度だけ計算されるのか、既存と同じかを受け入れ条件に入れたい。
- Task 2 の `since ? gte(...) : ...` は危険な擬似記述。空文字など falsy 値の扱いが現行と一致しない可能性があるため、`since === undefined/null` の現行条件をそのまま使う、と書くべき。
- Task 2 は `maxIso` を raw rows に対して取るのか mapped rows に対して取るのかが曖昧。mapper による field 名変換があるなら、現行と同じ入力で計算する条件が必要。
- Task 4 は「verbatim 移動」と言いつつ test の dynamic import path 更新や importer 更新を含むため妥当だが、旧 path の re-export shim を置かない方針を明記した方がよい。CLAUDE.md 更新を伴うなら path 名指しルールとの整合も final gate に含めたい。
- Task 5 は `logger.ts` の `expandError` export 化を選んでいるが、logger と ops の依存方向によっては循環リスクがある。plan は「新 file を作らない」としているため、循環が出た場合の停止条件または代替方針が欲しい。
- Task 5 の VERCEL_ENV 置換対象が「実測 site」として列挙されているが、Task4 後のファイル移動で再検索する条件が弱い。実装直前に `rg VERCEL_ENV` で lib 内残存を確認する、と明記すると漏れに強い。
- Task 7 は server action を `lib/actions/contact.ts` に置いた後、client component から直接 import する形が Next の制約上問題ないかを build で見るだけでなく、review 観点にも入れるべき。
- Task 8 は repo 内 consumer 発見時の停止はあるが、運用側 consumer 不在は plan 実装者だけでは再確認不能。OT 承認済み前提の範囲と、コード内 consumer のみ再確認する範囲を分けて書くとよい。
- Global gate の per-task `pnpm test:contract` は堅いが重い。設計上は問題ない一方、失敗時の切り分け負荷が高いので、Task ごとの対象 contract と full contract の位置付けを明確にしてもよい。

## リスク / 対立しうる設計判断

- `withReadOnlyAuth` で例外処理まで共通化するか、`!user → empty` だけ共通化して catch は route に残すか。前者は DRY だが凍結応答を壊しやすい。
- `expandError` を logger から export するか、共通 replacer module を新設するか。最小差分と依存方向の安全性が対立する。
- `lib/clerk.ts` / `lib/stripe.ts` を完全移設するか、旧 path shim を残すか。並行命名の根治と fail-fast path の安定性が対立する。
- VERCEL_ENV helper の適用範囲を lib 内に限定するか、app 側も一括で寄せるか。scope 管理上は lib 限定が妥当だが、残存 inline は将来の再重複になる。
- outbox helper を object config 化するか、小さな関数群に分けるか。抽象の読みやすさと過剰汎用化の境界が出やすい。
- pull factory の型をどこまで厳密にするか。Drizzle generic を攻めると複雑化し、緩めると型安全性が落ちる。plan の「any 不可」は正しいが、実装難度は上がる。