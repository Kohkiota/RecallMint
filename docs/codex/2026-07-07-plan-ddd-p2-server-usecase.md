# Codex plan cross-check — ddd-p2-server-usecase (2026-07-07)

- **作成日**: 2026-07-07
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **「as-is 移動」と「新しい関数境界」の衝突**
  - route 3 本は関数単位移動なので比較的安全だが、`process.ts` は新規関数化が入るため、完全な verbatim 移動ではない。
  - 特に `guard tx` / 保存 tx / 完了 tx / `markFailed` は、引数化に伴って参照変数・型・閉包依存が変わる。ここは「挙動不変」の中でも最も差分リスクが高い。

- **tx 境界だけでなく「tx 内で同じ db/tx オブジェクトを使う」ことが重要**
  - 保存 tx の `applyOcrTags` は同一 tx 前提。
  - 単に同じ関数内に置いても、`db` と `tx` の取り違え、helper 側で `getDb()` し直す、`applyOcrTags` に渡す対象が変わる、などで意味が壊れる。
  - 「1 関数 = 1 tx」に加えて「tx 内 I/O は必ず transaction callback の `tx` を通す」制約が必要。

- **route に残す wire 境界の定義がやや曖昧**
  - 認証・署名検証・idempotency・parse・HTTP/result 化は route 残留。
  - ただし review-events の Phase 0 session upsert は DB 書き込みだが route 残留。
  - これは現仕様維持として正しいが、「wire 境界のみ残す」という表現とはズレる。実装者が Phase 0 も use-case 側へ動かしたくなる余地がある。

- **schema 移動による公開 API の増加**
  - `payloadSchema` を lib から export する必要がある。
  - zod schema は runtime 値なので、今後別 consumer が直接 import し始める可能性がある。
  - P2 では問題ないが、`lib/reviews` が「暫定置き場」であることと合わせて、将来の依存固定化リスクがある。

- **mock 境界は green だけでは不足**
  - test が green でも、route が moved use-case を通らず mock 済み module を叩いているだけ、または古い import path を mock していて実体との差が出る可能性がある。
  - 「どの test がどの実体関数まで到達しているか」を明示確認する必要がある。

- **webhook の 200 swallow semantics は抽出時に壊れやすい**
  - Stripe / Clerk とも outer catch、idempotency insert、handler error、invalid signature の扱いが route 側に残る。
  - `handleEvent` 側で error を飲む/投げる責務が少しでも変わると、HTTP status は同じでも DB 状態・通知・ログが変わる。

- **idempotency insert と handler 呼び出し順序の固定**
  - webhook route は idempotency insert が wire 側に残る。
  - duplicate の場合に `handleEvent` を呼ばないこと、insert failure の扱い、outer catch への伝播が凍結対象。
  - plan では触れているが、設計論点としては「use-case は idempotency 済み event のみを受ける」前提を明文化した方がよい。

- **ops/log event name だけでなく payload shape も凍結対象**
  - 要件では ops/log イベント名不変が強調されているが、実運用上は `notifyOps` subject、payload fields、logger meta の shape/order/値も観測面。
  - byte 単位温存と言うなら、イベント名だけでなく meta payload の維持も明記対象。

- **Next.js server boundary の扱い**
  - `process.ts` は `'use server'` を entry に残す。
  - 分割先 module は non-`use server` とされるが、server-only 依存を含む。
  - client から誤 import されないよう、配置・export・lint で守る必要がある。可能なら `server-only` import の要否も検討論点。

- **`lib/clerk.ts` と `lib/clerk/` の併存リスク**
  - `lib/stripe.ts` + `lib/stripe/` の前例があるとはいえ、import 解決や人間の探索性にリスクがある。
  - barrel file を作らない方針、`@/lib/clerk` と `@/lib/clerk/...` の混同回避を明示した方がよい。

- **export 最小化と testability の対立**
  - helper を非 export にする設計は API 面では良い。
  - 一方で moved helper の単体検証はしないため、回帰検知は route 経由に依存する。
  - P2 方針として妥当だが、重要 helper を非 export にする分、route tests の到達性確認がより重要。

- **docs 更新のタイミングと commit 粒度**
  - SSoT を Task 1 commit に同梱して「実装中」にする設計は、実装途中の状態が履歴に残る。
  - 一方、code commit と docs commit の混在ルールが Task 6 では「混ぜない」とされている。
  - 状態遷移 docs の commit 方針は一貫性を明確にした方がよい。

- **line number 前提の stale 化**
  - spec は `b3bcb07` 再スキャン済み、plan は `f59ad5d` 前提。
  - 実装時 symbol 再特定とあるが、関数 body の verbatim 移動では import や周辺依存が変わるため、line 範囲だけに依存しない確認が必要。

## plan ドラフトへの抜け・未考慮指摘

- **`process.ts` 分解で `server-only` の要否が未検討**
  - `_actions/upload-guard.ts` / `_actions/upload-persistence.ts` は server 専用 DB・logger・schema を触る。
  - entry に `'use server'` を残すだけで十分か、分割先に `import 'server-only'` を入れるべきかの判断が plan にない。
  - 既存 repo 方針に従うべきだが、設計判断として明記した方が安全。

- **`ReturnType<typeof getDb>` を interface に使う場合の import 副作用が未確認**
  - Task 1/4/5 で `getDb` 型参照が interface に入っている。
  - 型専用 import にできるか、runtime import が必要になるか、server/client bundle 境界に影響しないかの確認が不足している。

- **`User` 型の import 元が未明記**
  - Task 1 と Task 4 の signature に `User` が出る。
  - route 内 local 型なのか、認証 helper 由来なのか、`@/lib/auth` 由来なのかが plan だけでは曖昧。
  - lib 側が app 側型を import しない制約と衝突しないか確認が必要。

- **`ParsedEvent` を非 export にする一方で `processSession` signature に出ている**
  - Task 1 では `ParsedEvent` は非 export と書かれているが、`processSession` signature は `events: ParsedEvent[]`。
  - TypeScript の exported function signature に非 exported type alias が含まれると、declaration emit や外部利用時の型表示で問題になり得る。
  - route 側が `payloadSchema.parse` の結果を渡すだけなら推論で通る可能性はあるが、設計としては `ParsedEvent` を export するか、signature を `BulkPayload['events']` にする方が明確。

- **Task 5 の `customProps` 型設計が脆い**
  - `Array<Parameters<typeof applyOcrTags>[2][number]['custom_props']>` は `applyOcrTags` の引数構造に強く依存する。
  - `custom_props` が optional / nullable / widened の場合、既存 `pipelineResult.cards[i].custom_props` と完全一致するか要確認。
  - body 内置換が唯一の機械的差分なら、ここは重点 review 項目に入れるべき。

- **Task 5 の保存 tx 抽出範囲が不足している可能性**
  - spec では保存 tx は `cards INSERT + applyOcrTags + card_count`。
  - plan の移動対象が `:541-565` とされているが、card rows の insert 結果、exam update、tag 適用、戻り値生成がその範囲に全て入るかは symbol ベースで確認が必要。
  - `cardRows` 構築を entry に残す判断はよいが、`pipelineResult.cards[i]` との index 対応 invariant を明記した方がよい。

- **Task 4 の `Destination` 型 export 化が API 変化**
  - 現在 local 型なら export 化は新しい公開面。
  - 必要最小ではあるが、「全型 export は現 path 維持」という要件と、分割先からも export することの関係が曖昧。
  - entry の `process.ts` から再 export するのか、内部 import のみに留めるのかを明記した方がよい。

- **route tests の mock 到達性確認が報告 1 行に圧縮されすぎ**
  - 条件 3 は P1 教訓として重要。
  - 各 task の完了条件に「どの mock が残り、どの moved function が実体で走ったか」を最低限列挙する成果物を要求した方がよい。
  - 特に Stripe の `vi.mock('@/lib/stripe/subscription')` は moved module 側から同じ mock を見るか確認が必要。

- **contract test 名の存在確認が前提化されている**
  - plan は `tests/contract/review-events-bulk.contract.test.ts` 等を指定している。
  - 実在名が違う場合、worker が近い test だけ実行して済ませるリスクがある。
  - 実装前に `rg --files tests/contract` で確定する手順があるとよい。

- **`pnpm test:contract` を per-task で全件実行することと「対象 contract test」記述が混在**
  - Global では `pnpm test:contract` exit 0。
  - Task 完了条件では対象 contract test green。
  - per-task gate のコストと意図が曖昧なので、「対象 route test + full contract」なのか「対象 contract + 最終 full contract」なのかを明確にした方がよい。

- **canonical review / Codex review の実行単位がかなり重い**
  - 全 code task で build + full contract + lint + typecheck + 2 review は安全側だが、実行時間・レビュー疲れのリスクが高い。
  - 要件上許容されるならよいが、subagent-driven の各 task commit 前 gate として現実的かは確認論点。

- **SSoT 更新の commit ルールがやや矛盾**
  - Global では「実装中」は Task 1 commit に同梱。
  - Task 6 では docs は code と混ぜない。
  - 「状態開始は code と同梱、完了は docs 独立」という意図なら明文化した方がよい。

- **`lib/reviews/` の暫定性が plan 側では弱い**
  - spec では Learning context 未確定・FSRS ロジック分散の注記が重要。
  - plan Task 1 にはこの将来移動リスクがほぼ出ていない。
  - 新規 directory の README までは不要でも、plan 上の設計意図として残した方がよい。

## リスク / 対立しうる設計判断

- **verbatim 移動 vs TypeScript 型の健全性**
  - byte 単位維持を優先すると、抽出後の import/type/export が不自然になる可能性がある。
  - 型を綺麗にすると signature や helper visibility が変わる。
  - P2 では挙動不変優先。ただし exported signature に非 export 型が出る箇所は例外的に整理が必要。

- **route 薄化 vs Phase 0 session upsert 残留**
  - use-case 化の目的からは Phase 0 も lib に寄せたくなる。
  - しかし現仕様では tx 外かつ独自 error path を持つため、P2 では route 残留が安全。
  - 「wire 境界のみ」という表現は少し緩めて、例外として Phase 0 残留を強調すべき。

- **export 最小化 vs 将来の再利用**
  - 非 export helper 方針は P2 の surface を小さくできる。
  - ただし将来 P3/P4 で retry 統合や Learning context 整理をするときに再移動が必要になる。
  - 今は churn 抑制を優先する判断で妥当。

- **app 内分割 vs lib 化**
  - `process.ts` は単一 consumer なので app `_actions` 配下に留める判断は妥当。
  - ただし guard/persistence はかなり domain/use-case 的で、将来再利用や testability を考えると lib 化したくなる。
  - P2 では import path 凍結と server action 境界維持を優先するのが安全。

- **per-task gate の厳格さ vs 実装効率**
  - 全 task で lint/typecheck/build/contract/review は高信頼だが重い。
  - ただし P2 は挙動不変 refactorで、失敗時の原因特定は小さい task ごとの方が容易。
  - 時間より安全を取る設計として一貫している。

- **コメント修正 8→10 vs verbatim ルール**
  - 挙動不変だが唯一の非 verbatim 差分。
  - レビュー時に「この差分だけが意図的」と明確に扱う必要がある。

- **`lib/clerk/` 新設 vs `lib/clerk.ts` 併存**
  - 対称性はあるが、import 混同のリスクは残る。
  - barrel を追加しない、明示 path import に限定する、という運用が望ましい。