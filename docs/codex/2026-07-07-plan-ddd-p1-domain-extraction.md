# Codex plan cross-check — ddd-p1-domain-extraction (2026-07-07)

- **作成日**: 2026-07-07
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **P1 の本質は「移設」ではなく「境界の再定義」**
  pure module 化後に、どの import が pure / impure の境界を表すのかを明確にする必要がある。単にファイルを分けても、pure module が `app/`、DB、Dexie、Stripe client、logger、Next runtime に依存すると目的を失う。

- **behavior-preserving の判定対象が P0 golden だけでは不足**
  調査結果自身が示す通り、streak / exam-status / plan-change / tag 表示順 / custom session 選定は P0 golden の主対象外。既存 unit / component test が実質の回帰網なので、どの既存 test がどの挙動を守るかを明示しておく必要がある。

- **pure carve-out は import consumer の切り分けが設計上の要点**
  `source-doc-status.ts` や `subscription.ts` から pure symbol を抜く場合、consumer が pure function だけ必要なのか、I/O wrapper も必要なのかを誤ると、境界は改善せず、mock 構造や bundle 分割に副作用が出る。

- **型 relocate は runtime 影響ゼロでも設計影響はある**
  `CustomSessionCriteria` を独立 type module に出すことは、pure → infra 型依存を切る意味がある。一方で型だけの新ファイル追加は、境界 clarity と churn のトレードオフになる。defer 可能性は明示すべき。

- **byte-identical dedup は「意図的二段構え」と混同しない**
  `computeStreak` core は共有してよいが、server/Postgres wrapper と client/Dexie wrapper は統合対象ではない。upload quota / cascade / UNIQUE pre-check 等の二段構え統合も P1 範囲外。

- **tag comparator 抽出では欠落 guard の責務境界が重要**
  `card-tags-section.tsx` の `.find` 解決と欠落時 `return 0` は comparator 本体ではなく ID 解決レイヤーの関心。ここまで共通化すると挙動や責務が変わる可能性がある。

- **card-filter-predicates 移動は lint allowlist 削除までが成果**
  ファイル移動だけでは逆依存解消の実証にならない。`eslint.config.mjs` allowlist と `import-boundary.test.ts` の期待更新、whole-repo lint green が完了条件。

- **test 移動・mock 差し替えは behavioral risk**
  特に Stripe subscription 周辺は mock 対象の分割ミスで、実装は同じでも test が別のものを検証する状態になりうる。mock の real/override 境界を明示しておく必要がある。

- **module path 設計は将来の一貫性に影響する**
  `lib/domain/` を作らない判断なら、pure module 名と配置が既存 `lib/*` の意味に沿う必要がある。`lib/streak-core.ts` のような横断名は、今後の配置規律として妥当か確認対象。

- **export surface の増加に注意**
  `addDays` など、従来 local だった helper を export することで public-ish API が増える。最小 export で済むか、テストや wrapper の都合で export 必須かを確認すべき。

- **path alias / relative import の揺れ**
  app 側は `@/lib/...`、同一 lib 配下は relative import など、既存規約と一致していないと移設後に import style が散る。

- **line number 前提の劣化**
  spec は `a11afca` 再スキャン済みだが、plan に固定 line range が多い。実装時 HEAD が進むとずれるため、行番号は参照補助であり、symbol ベース確認が必要。

- **SSoT 更新も成果物だが、behavior-preserving 変更と同 commit に含めるかは管理判断**
  SSoT 進捗表更新は運用上必要。ただし code refactor commit と docs status commit を混ぜることで review 粒度が落ちる可能性がある。

- **V5 filter 代数 confirm-only の証跡**
  「何も変えない」タスクでも、何を grep / 確認して、何をもって三重コピーなしと判断したかの記録が必要。

## plan ドラフトへの抜け・未考慮指摘

- **read-only レビュー観点では、plan が実装運用に寄りすぎている**
  task 分解は詳細だが、「設計上なぜその境界で正しいか」の確認項目が薄い。特に各新 module の許可 import / 禁止 import を task ごとに明示するとよい。

- **`pnpm test` を各 code task の共通完了条件にしている点は重い**
  安全側ではあるが、task 単位 subagent 運用だと毎回全 test / lint / typecheck / review / commit はコストが大きい。最終 gate と task-local gate の分離を検討余地あり。

- **Task 1 の「新規 unit test 追加」は spec の「新規 characterization は不要」とやや緊張する**
  plan では唯一の例外としているが、これは characterization ではなく新 API `compareTagEntry` の unit test だと明確化した方がよい。

- **Task 2 の `lib/streak-core.ts` 配置名は少し孤立している**
  既存配置方針が `lib/cards`, `lib/tags`, `lib/exams`, `lib/stripe` のドメイン別なら、`lib/streak-core.ts` が妥当か、`lib/streak/core.ts` のような場所がよいか検討余地がある。

- **Task 2 の `addDays` export 増加リスクが未記載**
  wrapper が使うため export する理由は書かれているが、従来 private helper を公開することへの最小化判断がない。

- **Task 3 の test move は挙動不変だが履歴・責務面の判断が必要**
  `source-doc-status.test.ts` を `derive-exam-statuses.test.ts` に move すると、DB wrapper の test が存在しない状態がより見えにくくなる可能性がある。問題ないなら「現 test は pure 専用なので move が正」と明記済みだが、DB 関数未カバーの残リスクも併記した方がよい。

- **Task 3 の consumer list が spec より狭い可能性**
  spec では `process.ts` / `exam-status-poll.ts` / `exam-status-live.tsx` / `api/exams/status/route.ts` 等とあるが、plan では poll/live は comment のみで変更不要としている。実 HEAD で symbol import が本当にないことを確認する手順が欲しい。

- **Task 4 の `import type Stripe from 'stripe'` が pure 判定上どう扱われるか明示不足**
  外部 SDK 型 import は許容という判断は spec にあるが、lint や目視基準で「値 import なし」を確認する項目を task 内に入れるとよい。

- **Task 4 の partial mock 例が実装依存で壊れやすい**
  `vi.mock(..., async (io) => ({ ...(await io()), ... }))` の形は Vitest の実 API と既存 mock style に合っているか確認が必要。設計 plan では「real `classifyChange` を維持し、`getPendingState` だけ override」までに留めてもよい。

- **Task 5 の import 更新対象が網羅されている保証が弱い**
  ファイル列挙はあるが、最終的に `rg "card-filter-predicates"` で旧 path / 相対 import 残存ゼロを確認する acceptance があるとよい。

- **Task 5 の allowlist 残件数「3 件残」が固定前提**
  他作業で allowlist 件数が変わると不要な失敗条件になる。件数より「当該 exception が消えている」ことを条件にした方が堅い。

- **Task 6 の依存型 import により type module が predicates に依存する**
  `custom-session-criteria.ts` が `card-filter-predicates` の型を import する設計は自然だが、predicate module が runtime logic も持つなら type-only import であることを明確にする必要がある。

- **Task 7 の commit 方針が曖昧**
  「他 task に同梱 or docs/chore」は運用上ぶれやすい。confirm-only の結果を SSoT に残すなら、どの task 完了時に更新するか決めた方がよい。

- **SSoT 更新タイミングと HEAD SHA 記録が task flow に組み込まれていない**
  Deliverables / 完了条件にはあるが、具体 task にはない。最終 Task 8 相当として docs update / final verification を置く方が漏れにくい。

- **canonical review / Codex review の対象粒度が過剰または曖昧**
  「各 code task」「非自明 task」「Task 4 は必須」が混在している。どの task が review 必須か、confirm-only は対象外かを明確化した方がよい。

## リスク / 対立しうる設計判断

- **最小 churn vs 境界の明確さ**
  `lib/domain/` を作らない判断は churn を抑える。一方、pure / infra の境界が命名と lint 規律に依存するため、将来の混入を防ぐ仕組みは弱め。

- **既存 test 温存 vs test 構造の自然さ**
  streak test を二重に残すのは server/client wrapper の安全確認として妥当。ただし shared core の同一 case を二重実行する冗長性は残る。

- **verbatim 移設 vs module API としての整形**
  本体を 1 文字も変えない方が behavior-preserving の証明は強い。一方、新 module として export するなら命名・型・コメントを整えたくなる誘惑がある。P1 では verbatim 優先が妥当。

- **型 edge 解消 vs ファイル増加**
  `CustomSessionCriteria` の relocate は設計純度を上げるが、runtime 影響はない。P1 でやる価値は「pure seed の infra 型依存を切る」ことに尽きる。

- **mock 分割による検証精度低下**
  Stripe carve-out は実装より test mock の方が壊れやすい。mock が新 module を隠しすぎると、pure function の実挙動を test しなくなるリスクがある。

- **helper export の API 固定化**
  `addDays` や `compareTagEntry` を export すると、今後利用が増えて戻しにくくなる。P1 の範囲では必要最小の export に留めるべき。

- **allowlist 削除の成功条件**
  lint green は重要だが、lint が import boundary を完全に表現しているとは限らない。目視 / `rg` による旧 path 残存確認も必要。

- **confirm-only task の扱い**
  コード変更なしの確認は実装 task より軽く扱われがちだが、P1 scope 補正の根拠なので、証跡が残らないと後続 phase で再議論になりやすい。