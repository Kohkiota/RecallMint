# Codex plan cross-check — ddd-p0-plan (2026-07-06)

- **作成日**: 2026-07-06
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- P0 の正は「現状実値」だが、bug を焼かないため triage の完了条件が最重要。特に後続 P1/P2 対象に絡む `review-events` の rating/study_days、entity mutation の tag 系 op、pull の card_tags 非対称は、snapshot 対象にする/しないの判断を先に固定する必要がある。
- 既存 test harness は route ごとにかなり違う。`entity-mutations` は registry/card handler mock、`review-events` は Drizzle SQL capture、webhook は署名込み integration 風、upload は server action mock。`tests/fixtures` の共通化は「全部を一つの fake DB に寄せる」より、共通 Request/clock/id と route 別 fake builder の境界を明確にする方が安全。
- 非決定値は `Date.now` / `new Date` / `crypto.randomUUID` だけではない。`performance.now()` による `review_events.bulk.timing`、`notifyOps`/logger payload の timestamp、Stripe/Svix 署名 timestamp、DB `sql\`now()\`` / returning id がある。snapshot 対象から外すか、個別に固定する設計が必要。
- snapshot に SQL object 全体を焼くのは危険。既存コードにも `collectParamValues` や `PgDialect().sqlToQuery` 的な補助があり、契約として焼くべきなのは response、headers、DB mutation の抽出値、呼び出し回数、主要 SQL shape まで。
- `/api/entity-mutations/bulk` は現在 `card` だけでなく `tag_category` / `tag_option` 系 schema/registry が存在する。op inventory は 9 系統の存在確認が必要で、代表 snapshot だけだと後続 DDD で tag 系だけ壊れる穴が残る。
- `/api/review-events/bulk` は response が `{ ok, failed }` だけなので、副作用 snapshot が主契約になる。session upsert、answer_events、reviews、cards update、study_days に加え、503 + `Retry-After`、orphan、duplicate event skip、tx rollback 時 failed[] の意味を固定しないと P1/P2 の安全網として弱い。
- webhook は「error でも 200」と「署名/headers 不正 400」を分ける必要がある。Stripe/Clerk とも invalid signature は 400、duplicate/unknown/handler error は 200 系で、ここを曖昧にすると誤った golden になる。
- Stripe webhook は subscription status matrix 以外にも `checkout.session.completed` の subscription retrieve、`invoice.payment_failed`、`subscription_schedule.released`、unknown event no-op が契約面。status 正規化だけでは webhook 契約として不足しうる。
- upload は full pipeline を走らせない方針が妥当だが、targeted test が浅すぎると `ProcessUploadResult` union の success data shape、finally の `revalidatePath` 2 発、`markFailed`/ops 通知の error path を見落とす。
- import lint は flat config/minimatch の逃げが実務リスク。route group `()` / dynamic `[]` escape、override 順序、`../../../` が 4 段以上を拾うか、per-file `off` の副作用を検証対象にする必要がある。
- dead-sweep の `dropdown-menu.tsx` は実 importer はゼロに見えるが、docs 参照は多数ある。削除条件に「docs 参照なし」を置くなら現 HEAD では不成立。履歴 docs は live 参照から除外する、など判定基準を明確化すべき。

## plan ドラフトへの抜け・未考慮指摘

- Task 1 の決定論基盤に `performance.now()`、Stripe/Svix 署名 timestamp、logger/notifyOps timestamp の扱いが明記されていない。特に `review-events` の timing log を snapshot/capture するなら不安定になる。
- Task 3 は `op inventory` と代表 op の記述はあるが、現 HEAD の `tag_category` / `tag_option` op 群をどの粒度で固定するかが弱い。少なくとも inventory の検証失敗が test red になる条件が必要。
- Task 3/4 の 503 系は `Retry-After` header が契約に含まれる可能性が高いが、完了条件に明示されていない。
- Task 4 は duplicate event skip、orphan failed、session upsert 失敗、tx rollback で applicable events が failed になる面が明示不足。rating derive だけでは branch 網羅として不足。
- Task 5 は upload の 11 error code と success union を固定するとあるが、`INVALID_INPUT` は複数分岐、`SAVE_FAILED` も複数分岐。どこまで代表化するか、同一 code の複数 user-facing 文言を焼くかが未定義。
- Task 6 は webhook の「invalid signature」を「error でも 200」群と同列に読める。現実装では Stripe/Clerk とも invalid signature は 400 なので、明確に分離した方がよい。
- Task 6 の Stripe 対象に `checkout.session.completed with subscription retrieve`、`invoice.payment_failed`、`subscription_schedule.released`、unknown event no-op の扱いが薄い。status matrix だけだと後続 refactor の検知力が足りない。
- Task 7 の pattern 検証 test を `tests/contract/` に置く案は、contract script と lint 検証の責務が混ざる。ESLint config の RuleTester/CLI smoke なのか、単なる unit test なのかを明確にした方がよい。
- Task 8 の dropdown 削除条件「docs 参照なし」は現 HEAD の実態と衝突する。歴史 docs を許容するなら plan 側の条件を書き換えるべき。
- Task 10 の `pnpm test` が contract を含む保証は、`test:contract` 新設後も Vitest default include が `tests/contract` を拾う前提に依存する。完了 gate には `pnpm test:contract` を明示した方が安全。

## リスク / 対立しうる設計判断

- snapshot を広く焼くほど回帰検知は強いが、Drizzle SQL 内部構造・timing・ops payload まで焼くと脆くなる。抽出値中心にするか、wire response 中心にするかの線引きが必要。
- 共有 fixtures を厚くすると重複は減るが、route 固有の fake DB 形が隠れて誤った共通抽象になる。P0 では薄い共通基盤 + route 別 builder が無難。
- bug 判定面を snapshot 対象外にすると P1/P2 の安全網に穴が残る。要件どおり、後続 phase 対象なら OT 判断を P0 完了前 gate にする必要がある。
- import lint の allowlist は per-file `off` のため将来違反も通す。標準ルールのみで行くならこの副作用を受け入れるか、P1 以降で早めに削減する運用が必要。
- dead-sweep は挙動不変だが、docs 参照や shadcn 再生成可能性をどう扱うかで「完全 dead」の定義が揺れる。削除 commit を独立させ、赤なら撤回できる運用は必須。