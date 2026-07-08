# Codex plan cross-check — group-a-invariant-fixes (2026-07-08)

- **作成日**: 2026-07-08
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

### 全体

- 4 件はいずれも「既存の正常操作を壊さず、不正・異常系だけを狭く弾く/検知する」変更であり、正常系 regression 検出が最重要。
- behavior-changing なので、既存 test の期待値を安易に更新すると「正常系破壊」を見逃す。変更してよい期待値は不正 payload / 偽アラート系に限定すべき。
- server reject 後の client pending 残置 → stale 隔離が確認済みとはいえ、UX 上は「ユーザーには直ちに失敗が見えない」可能性がある。今回の方針では許容されているが、運用・CS 観点では記録しておくべき。
- 4 件は独立 fix だが、すべて sync / billing / webhook の境界に関わるため、単体 test だけでなく「どの副作用が起きないか」の assertion が重要。
- DB schema / migration なしが前提なので、application invariant と DB invariant の責務境界を明確にする必要がある。
- DDD 本体に送る項目と今回 fix する項目の境界を崩さないことが重要。特に A-2 で `is_correct` 再計算や answer snapshot 設計に踏み込むと scope creep になる。
- commit 分離は妥当だが、A-3/A-4 は決済・削除領域なので staging smoke と OT 実機確認の前後関係を明確に残す必要がある。

### A-1 single カテゴリ制約

- `tagOptionIds` が whole-set replace である以上、矛盾 set を server が丸めるのは危険。reject は妥当。
- ただし server 側で `tag_options` と `tag_categories` の整合を二段 SELECT する場合、category が owner-scope で取れなかった時の扱いを明確にする必要がある。option 所有は確認済みでも、category 欠落・不整合時は fail closed が自然。
- `categoryId` が nullable かどうか、既存データに orphan option がありうるかは確認対象。もし型上 non-null でも、実 DB の古いデータを考慮するなら異常時 reject がよい。
- grouping は de-duplicate 後の ids に対して行うべき。重複 payload を 2 個扱いして single 違反にすると既存の重複排除 semantics と衝突する。
- multi と single の混在、複数 single category 各 1 個は regression test 必須。
- DELETE/INSERT 前の副作用ゼロ確認は、戻り値だけでなく transaction mock の呼び出し有無で検証すべき。

### A-2 selected_answer_ids 存在検証

- option id は uuid でないため、形式検証を強めると壊れる。存在検証だけに限定すべき。
- 「対象 card の options に含まれるか」を見る必要があり、全 card 横断の option id 存在確認では不足。
- orphan 判定後、answer_events INSERT 前に弾く順序が critical。INSERT 後に弾くと duplicate skip 経路で client が synced と誤認するリスクがある。
- 空配列が許容される設計かどうかを確認すべき。現在の主入力では「選択 id がある場合の存在検証」が中心で、未選択回答や free-form 的ケースが存在するなら壊してはいけない。
- card options が `null` / `undefined` / malformed json の既存データをどう扱うかが論点。通常は空 option set とみなし、selected があれば reject、selected 空なら通す、など明文化が必要。
- 正当 race による review 1 件喪失は許容判断済みだが、failed[] の理由語彙を増やさない場合、運用上の識別性は低い。ログや test 名で補完する必要がある。
- `selected_answer_ids` が 50 件 max なので性能リスクは小さいが、cards SELECT に jsonb options を追加することで ingest payload が増える。bulk サイズが大きい場合の影響は一応見るべき。

### A-3 upgrade 整合窓 observability

- `redirect()` を catch しないことが最重要。try/catch 範囲が広いと正常 redirect を error と誤認する。
- `notifyOps → rethrow` の順序は妥当だが、`notifyOps` が本当に swallow する前提に依存する。test では notifyOps reject 時の挙動まで必要かは判断余地がある。
- context に `scheduleId` / `operationId` / `targetPriceId` が入ることで手動修復可能になる。逆に PII や不要な Stripe object 全体を載せないよう注意。
- timestamp / environment の生成責務を caller 側で持つなら既存作法と整合させる必要がある。
- DB write 失敗時に Stripe 側は成功済みなので、rethrow によりユーザーへ汎用エラーが出ても実際には課金側状態は変わっている。この UX 不整合は既存挙動維持として許容されているが、運用 runbook 前提。

### A-4 webhook 偽アラート

- root cause は `clerkId != null` を row match proxy にしたことなので、行有無と metadata sync 可否を分離するのが妥当。
- `.deleted` だけでなく `.created/.updated` の同型 proxy を直す必要がある。片方だけだと root fix ではない。
- 真の unlinked customer、つまり 0 行 match は通知維持が不変条件。偽陽性を消す過程で本物の検知を殺すリスクがある。
- scrub 済み row では metadata sync しないのが正しいが、release gate など clerkId 不要の処理が clerkId 条件に巻き込まれていないか確認が必要。
- `.updated` で scrub row に対して release gate を評価する場合、予約 3 列や schedule id の状態によって無害に early return することを test または既存ロジック確認で担保すべき。
- webhook は idempotency / event ordering の影響を受けるため、`.deleted` 先行・`.updated` 後着など順序差で通知が再発しないかが論点。
- 既存 unlinked test が「scrub row」を暗黙に表していた場合、fixture 名や setup を直さないと test の意味が曖昧になる。

## plan ドラフトへの抜け・未考慮指摘

- plan は全体として主入力の方針をかなり反映しているが、A-2 の「空 `selected_answer_ids` をどう扱うか」が明記されていない。既存 schema が空配列を許すなら、空配列は存在検証を pass するのか確認が必要。
- A-2 で `options` が null / 非配列 / 壊れた json の既存データだった場合の fail closed / fail open が未定義。実装者が都度判断すると挙動が割れる。
- A-1 で `tag_categories` SELECT が category を返さなかった場合の扱いが明記されていない。owner-scope SELECT する以上、件数不一致時は reject などの方針が必要。
- A-1 の count は重複排除後の option ids に対して行うべきだが、plan では明示が弱い。既存の「重複排除」挙動を維持するために書いておくとよい。
- A-3 の test で `notifyOps` が reject しない前提を置いているが、mock が accidental throw した場合に本来の rethrow semantics が崩れる可能性がある。少なくとも `notifyOps` 内部で握る既存設計に依存することを test かコメントで固定したい。
- A-3 の context に `error` とあるが、Error object そのものを渡すのか serialize した値を渡すのか未指定。既存 `notifyOps` 作法に合わせる必要がある。
- A-4 の plan は「対象 2 分岐」と言いつつ `.created/.updated` を一括で 1 分岐としている。実コード上で created と updated の処理差がある場合、両方の event fixture で確認する必要がある。
- A-4 の test は scrub `.updated` で notifyOps 不発を確認するが、release gate が clerkId なしでも適切に呼ばれる/無害に return する点までは assertion が曖昧。plan 自身が release gate の紐付け変更を要求しているため、ここは test 観点に入れた方がよい。
- sprint gate から typecheck/build が外れているのは主入力どおりだが、server action / webhook / drizzle 型に触るため、lint/test だけで型破壊を拾えるかはリスク。対象外にするなら「なぜ十分か」を残すか、少なくとも task-local test 実行時に TS transform が型を見ない点を認識しておくべき。
- plan 冒頭の `REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development` は今回の実装 plan としては外部依存が強い。実行環境でその skill が使えない場合の fallback がない。
- A-3/A-4 の `[reviewed]` amend は「未 push amend」前提だが、Task 5 では push は OT とある。誰がいつ amend するか、stg smoke 前に push が必要なら amend 不能になる可能性があるため運用手順に曖昧さがある。

## リスク / 対立しうる設計判断

- **reject vs salvage**: A-1/A-2 は reject 方針が妥当だが、local-first の正当 race ではユーザー操作 1 件が失われうる。データ衛生を優先する判断と UX 継続性の対立。
- **application invariant vs DB invariant**: 今回は migration なし・application 層 enforcement。将来別 write path が増えると invariant 漏れが再発しうる。
- **検知追加 vs 挙動不変**: A-3 は notifyOps 追加のみだが、catch 範囲や error serialization を誤ると user-facing behavior が変わる。
- **偽陽性削減 vs 真の異常検知維持**: A-4 は通知条件の精密化が目的。0 行 match と scrub row を混同すると、偽アラート継続または本物のアラート欠落のどちらかになる。
- **scope control**: A-2 は `is_correct` 再計算、answer snapshot、option edit race の完全解決に広がりやすい。今回は存在検証だけに止めるべき。
- **test confidence**: unit/contract test で DB 失敗や webhook 分岐は担保できるが、A-3 の実 DB 失敗注入や A-4 の真の unlinked 実走は staging で破壊的。unit test を正とする部分が残る。
- **review/commit workflow risk**: A-3/A-4 の tag なし commit → OT 確認 → amend `[reviewed]` は、push タイミングを誤ると履歴運用が面倒になる。