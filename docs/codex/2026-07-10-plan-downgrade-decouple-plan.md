# Codex plan cross-check — downgrade-decouple-plan (2026-07-10)

- **作成日**: 2026-07-10
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **correctness の本体は「発効後」と「発効前」の非対称**
  - webhook delegate は downgrade 発効後なので、DB 予約列はすでに消費済み。release API の成否に関係なく clear すべき。
  - cancelDowngrade は発効前なので、release 失敗時に clear すると Stripe schedule が残ったまま UI/DB だけ予約なしになり、逆向きの破綻を作る。
  - この非対称は実装コメントと test の両方で固定する必要がある。

- **条件付き clear の同一性条件**
  - `scheduleId` だけでなく `targetPriceId` も match させる判断は妥当。
  - ただし owner scope も必須。`scheduleId` が実質一意でも、既存 repository の SubKey pattern と Clerk-3 の owner 条件規律に合わせるべき。
  - 0-row は正常系として扱う設計でよいが、テストで `matched:false` を観測可能にしておく必要がある。

- **DB clear と外部 API release の障害境界**
  - DB clear の失敗は correctness failure なので握らない。
  - release の失敗は best-effort failure なので握る。
  - この境界が曖昧になると、orphan 再発または silent data loss のどちらかに寄る。

- **transaction 境界**
  - clear は単発 UPDATE として commit 完了後に release へ進むべき。
  - 外部 Stripe API を DB transaction 内に入れないことが重要。
  - spy の呼出順だけでなく、設計意図として「await clear 完了後 release」が守られる必要がある。

- **I-9 破損データへの扱い**
  - `scheduledDowngradeScheduleId` があるのに `scheduledTargetPriceId` が null のケースは通常ありえないが、`!` で握りつぶすべきではない。
  - notifyOps + 予約維持が安全側。
  - ここは test がないと実装者が non-null assertion に戻しやすい。

- **released / clear_direct / deleted 既存経路との責務分離**
  - released handler の無条件 clear を残すことは self-heal 層として意味がある。
  - delegate の条件付き clear と released の無条件 clear は意図が違うため、無理に統一しない方がよい。
  - clear_direct や deleted 経路への副作用がないことを回帰で確認する必要がある。

- **429 retry の範囲**
  - release 専用、1s 固定、1 回、同一 idempotency key の再利用に限定するのがスコープとして適切。
  - webhook latency は伸びるが、clear が先に完了していれば correctness には影響しない。
  - Retry-After 不使用は方針として明記されているので、実装で賢くしすぎないことが重要。

- **observability の限界**
  - Sprint 1 では release 失敗の永続記録なしなので、notifyOps/Discord と Vercel log 依存が残る。
  - これは承認済み境界だが、運用上は一時的な観測不足リスクとして残る。
  - Sprint 2 の insertion seam は実装コメントだけでなく、payload が将来 dual-write に足る形であることが重要。

- **test の赤確認**
  - R 内 TDD では N-1 が旧実装で fail することが主命題の証明になる。
  - 既存挙動 pin と新挙動 pin を混ぜると、何が仕様変更で何が回帰防止か不明瞭になる。
  - G は既存挙動のみ、R は新挙動のみ、という境界は守るべき。

- **staging smoke の射程**
  - Test Clock で実環境の発効経路を確認するのは必須。
  - release 失敗系は実 Stripe で意図的に作りにくいため unit golden 代替でよい。
  - JWT/publicMetadata stale 表示を完了条件に含めない線引きも必要。

## plan ドラフトへの抜け・未考慮指摘

- **read-only ではなく実装 plan としては概ね spec を反映しているが、Task 3 が scope 外 commit を含む**
  - 要件のスコープは触る 4 file + test と session doc/smoke 記録の扱いがやや別枠。
  - plan は `docs(session)` commit を最終 task に入れているが、spec の完了条件では「session doc を正記録」とある一方、実装修正の R commit とは別管理に見える。
  - 実装者向けには、session doc commit が許容される scope 外変更なのか明示した方がよい。

- **review のタイミングが spec と微妙にずれる**
  - plan は canonical + Codex review を「commit 前」に pass と書いている。
  - しかし通常 review は diff/commit 単位で扱うことが多く、spec では「R は 1 commit」「canonical review + Codex review → Critical/Important 0」とある。
  - commit 前 review が本当に既存運用に合うのか、また review 後に commit で差分が変わらない保証をどう置くのかが曖昧。

- **G の不足を 1 本と断定しているが、R の null guard test との関係がやや曖昧**
  - plan は Task 2 で `dbTargetPriceId null → notifyOps + 予約維持` を追加すると書いている。
  - これは新挙動というより破損データ guard の仕様固定なので、N 群とは別に明示した方がよい。
  - 完了条件に「N 群」とだけ書くと、この null guard case が落ちても見逃されやすい。

- **N-3 の「二重副作用なし」の定義が不足**
  - clear 済み再送で `matched:false` は分かるが、release を再度呼ぶのか、status gate で `already_terminal` に収束するのか、notifyOps が出ないことまで含むのかが曖昧。
  - spec では「release は status gate で収束」とあるため、plan 側も副作用の観測対象を明確にした方がよい。

- **N-4 の別予約 race で release を呼ぶかどうかの期待が曖昧**
  - 条件付き clear が 0-row なら誤 clear は防げる。
  - ただしその後に旧 `dbScheduleId` を release するのか、0-row を見て release を避けるのかが plan では明確でない。
  - spec は release 結果を clear に gate しないが、clear の `matched:false` 時に release まで進む設計かは実装者が迷いやすい。

- **#5 の `user.scheduledTargetPriceId null` 到達時の扱いが弱い**
  - spec は「従来型 clear に倒さず 0-row 扱い、実質到達しない」としている。
  - plan の anchor では `targetPriceId: user.scheduledTargetPriceId` とだけ書いており、型上 null をどう扱うかが不明。
  - guard、throw、no-op 用 sentinel 回避のどれかを明確にしないと、実装で non-null assertion や無条件 clear fallback が入りうる。

- **repository allowlist 更新の意味は書いているが、export surface の確認が不足**
  - `clearReservationMatching` をどこから export するか、既存の public repository API 整理と test import の関係が plan では薄い。
  - forbidden regex は非該当でも、予約 writer allowlist の意味保持に加え、意図せず広い export を増やしていないかを確認対象に入れるとよい。

- **notifyOps payload の timestamp/environment の生成責務が未整理**
  - plan は payload fields を pin しているが、`notifyOps` 側で付与されるものと call site が渡すものの境界が不明。
  - spec は payload に含めると明記しているため、test は「call site の渡し値」なのか「最終通知 payload」なのかを揃える必要がある。

- **429 retry の fake timer 手順が不足**
  - `sleep 1s` を fake timer で決定論化するには、promise flush と timer advance の順序が重要。
  - plan は十分な設計粒度ではあるが、実装者向けには既存 `cancelWithRetry` test pattern を参照する、と明記した方が事故が少ない。

- **whole-repo gate が per-task と最終で重複して重い**
  - 各 task で full `pnpm test`、最終でも full gate は品質上はよい。
  - ただし実行時間が長い場合、現実には省略されやすい。必須 gate と任意再確認の区別があると運用しやすい。
  - 要件上は最終 `pnpm lint --max-warnings=0` と全 test green が重要。

- **superpowers sub-skill 依存が主入力にはない**
  - plan 冒頭で REQUIRED SUB-SKILL を置いているが、承認済 spec の固定判断には含まれていない。
  - 実装プロセス上の規律としてはよいが、設計要件と混ざると「設計変更に必要な条件」なのか「作業運用」なのか曖昧になる。

## リスク / 対立しうる設計判断

- **0-row no-op を通知しない判断**
  - ノイズ削減として妥当。
  - 一方で破損データや race anomaly を運用で見落とすリスクは残る。
  - Sprint 2 で永続記録を入れるなら、0-row の扱いを再評価する余地がある。

- **delegate で clear 後に release へ進むか、matched:false なら release しないか**
  - clear 結果非依存で release する方が「detach best-effort」を最大化する。
  - matched:false で release しない方が別予約 race への保守性は高い。
  - spec は release best-effort 保持を重視しているが、この分岐は実装前に期待を明文化した方がよい。

- **Retry-After 不使用**
  - webhook を短く諦める方針には合う。
  - ただし Stripe が明示する backoff を無視するため、rate limit が継続する環境では release 成功率は限定的。
  - correctness は clear で担保されるので、これは意図的な可用性トレードオフ。

- **release 失敗の永続記録を Sprint 2 に送る判断**
  - correctness fix を小さく保つには妥当。
  - ただし active schedule が残り続ける運用負債は可視性が Discord/Vercel log に依存する。
  - 決済系なので Sprint 2 を先送りしたまま忘れない仕組みが必要。

- **R を 1 commit にまとめる判断**
  - 挙動変更の原子性は高い。
  - 一方で repository、webhook、action、retry、test 更新が一体化し、review 負荷は上がる。
  - commit 分割より bisect green を優先する判断としては一貫している。

- **released handler を無条件 clear のまま残す判断**
  - self-heal と既存契約維持には有利。
  - ただし delegate は 2 列 match、released は scheduleId 単独という差が残る。
  - その理由は spec に書かれているが、実装コメントか test 名でも補強しないと将来統一されやすい。