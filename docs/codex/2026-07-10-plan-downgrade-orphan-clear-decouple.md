# Codex plan cross-check — downgrade-orphan-clear-decouple (2026-07-10)

- **作成日**: 2026-07-10
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **correctness の本体は「発効済み予約の DB clear を外部 release 成功から独立させる」こと**
  - downgrade 発効は price==target で確認できる。
  - その時点で予約は消費済みなので、DB の `scheduled_*` は release 成否と無関係に clear されるべき。
  - release は Stripe schedule detach の後始末であり、DB correctness の前提にしてはいけない。

- **clear は必ず冪等・条件付きである必要がある**
  - webhook 再送、重複処理、別予約への差し替わり race がある。
  - `WHERE scheduledDowngradeScheduleId=? AND scheduledTargetPriceId=?` がないと、古い発効イベントで新しい予約を誤 clear する危険がある。
  - I-9 の 3 列一括 clear は維持すべき。

- **delegate 分岐と cancelDowngrade では「clear 先行」の意味が違う**
  - delegate は発効後なので clear 先行が正しい。
  - cancelDowngrade は発効前なので、release 前に clear すると Stripe 予約だけ残り、UI 上は予約なしになる逆 orphan を作る。
  - 同じ helper を使うとしても、順序は経路ごとに分ける必要がある。

- **active-release は correctness ではなく Stripe 側 detach の best-effort**
  - 残す判断は固定だが、失敗しても handler に throw させないことが重要。
  - 失敗時は notifyOps のみ。本 sprint では永続失敗記録を入れない。
  - release の戻り値 `released` / `already_terminal` / `skipped` は clear 判断に使わない。

- **webhook の常時 200 方針と相性を考える必要がある**
  - handler 内 throw は Stripe 再送を生まない。
  - そのため、webhook で必須 DB 整合を外部 API 成功に依存させる設計は危険。
  - clear は外部 API より前に commit される構造が望ましい。

- **429 retry は補助であり、主 fix ではない**
  - SDK は 5xx/network/timeout を retry 済み。
  - 429 は gap だが、429 対応だけでは orphan は直らない。
  - 429-aware release は best-effort release の成功率改善として扱うべき。

- **`evaluateRelease` pure 4分類は固定境界として守るべき**
  - 要件上 verbatim 維持。
  - 変更点は分類結果 `delegate` の処理側に閉じるべき。
  - golden では分類そのものの既存挙動も回帰保護が必要。

- **既存 self-heal 経路の性質を壊さないこと**
  - `subscription_schedule.released` handler は引き続き無条件 clear でよい。
  - `clear_direct` も event payload 上 `sub.schedule == null` なら既存の無条件 clear でよい。
  - ただし delegate の active-release 失敗時に released webhook が来ない前提で設計する。

- **観測・運用面の境界**
  - `integration_failures` 永続化は別 sprint。
  - ただし notifyOps payload は後続調査に足る情報を持つ必要がある。
  - Test Clock smoke では DB clear、UI banner 消滅、release 成否ログ、released webhook 有無を分けて見る必要がある。

- **表示問題は二系統**
  - 「変更予約中」banner / CTA disable は `scheduled_*` orphan 由来で本 fix 対象。
  - 「現プラン Pro」は DB ではなく Clerk JWT/publicMetadata stale の可能性が高く、本 fix の完了条件に混ぜるべきではない。

## plan ドラフトへの抜け・未考慮指摘

- **`clearReservationMatching` の customer scope が不明**
  - plan の SQL は scheduleId + targetPriceId のみ。
  - Stripe schedule id は実質一意だとしても、既存 repo が customer/user 単位で扱っているなら、`stripeCustomerId` または user id も条件に含めるか、含めない理由を明記した方がよい。
  - 少なくとも multi-tenant safety の設計判断として明文化が必要。

- **0-row no-op の観測方針が薄い**
  - 0-row は正常 no-op とされているが、delegate で 0-row が起きた場合は「既 clear 済み」と「別予約 race」と「データ不整合」が混ざる。
  - notifyOps までは不要かもしれないが、test/log/return result で判別可能にするかは論点。
  - 特に G-4 の race 保護を入れるなら、0-row を完全に黙殺してよいか検討余地がある。

- **clear 先行後に DB clear 自体が失敗した場合の扱いが未記述**
  - delegate で DB clear が throw した場合、release を実行しないのか、handler は従来どおり swallowed になるのか。
  - correctness 的には DB clear 失敗は重大なので throw 伝播でよい可能性が高いが、明記がない。
  - 「release throw は握る」が「clear throw は握らない」という境界を書くべき。

- **transaction 境界が曖昧**
  - `clearReservationMatching(tx, ...)` とあるが、delegate 側でどの transaction/client を使うのか、既存 repository pattern と合うかが未記述。
  - clear と release は同一 transaction にできないが、clear の DB commit 完了後に release へ進むことは明確にした方がよい。

- **`dbTargetPriceId!` の非 null 根拠はもう少し堅く pin すべき**
  - I-9 で保証、delegate 到達時 priceId と一致済み、という説明はある。
  - ただし現実の破損データで target が null の場合に `!` で落ちると webhook で clear できない。
  - 要件上 YAGNI ならよいが、「破損データは skip/notify で予約維持」か「ありえない invariant violation として throw」かを明記した方が安全。

- **429 retry の sleep が webhook latency を伸ばす点は認識されているが、設計判断が少し弱い**
  - 1s なら大きくないが、retrieve/release それぞれ SDK retry + timeout が絡む。
  - best-effort release は correctness 外なので、webhook では長時間待たずに短く諦める方針を明文化するとよい。
  - 例えば 429 retry 1回固定、Retry-After は使わない/上限を持つ、など。

- **`releaseScheduleIdempotent` へ 429 retry を入れる副作用範囲**
  - delegate と cancel の両方に乗る点は書かれている。
  - ただし他の呼び出し元が存在しない/将来増えた時の契約として「release 専用の 429 retry」になることを test で縛る必要がある。
  - cancel action では 429 連続時に UI 待ち時間が増える点も明記されるとよい。

- **notifyOps payload の既存型・慣習との整合が未確認**
  - payload 例に `environment`, `timestamp`, `error` があるが、既存 notifyOps が Error object をどう serialize するかに依存する。
  - 後続調査に必要な `eventId`, `eventType`, `customerId`, `scheduleId`, `targetPriceId`, release result/error kind は最低限 pin した方がよい。

- **Test Clock smoke に cancelDowngrade 側の確認がない**
  - plan は #5 を同梱するが、stg smoke は主に発効 delegate 経路だけ。
  - unit で十分という判断でもよいが、#5 を触る以上、少なくとも「cancel 成功後に予約 clear・UI 復帰」程度の手動確認を入れるか、除外理由を書くべき。

- **Clerk/JWT stale の非対象化は plan に入っているが完了条件で誤解されうる**
  - smoke の表示是正に upgrade/settings の banner 消滅はある。
  - 「現プラン Pro」表示は本 fix 対象外と明記した方がよい。
  - そうしないと smoke で JWT stale を本 fix の失敗と誤判定する可能性がある。

- **G commit で “fail のまま commit” する運用は環境規律依存**
  - TDD red commit を許容する前提があるならよい。
  - ただし CI が red commit を許さない運用なら、branch local commit だけなのか、push 前に R まで積むのかを明記した方がよい。

- **`released` handler の無条件 clear と条件付き clear の整合確認が薄い**
  - delegate は条件付き clear、released は scheduleId 一致で無条件 clear。
  - cancel 経路では released self-heal があるため、released handler が targetPriceId を見ないままでよい理由を残すとよい。
  - 特に別予約 race と released webhook の順序が絡む場合の期待挙動を 1 本 test する価値がある。

## リスク / 対立しうる設計判断

- **DB correctness 優先 vs Stripe schedule detach 完了優先**
  - 固定判断では DB clear 先行。
  - 対立点は、release 失敗時に Stripe schedule が attach されたまま再変更 API と衝突しうること。
  - 今回は active-release best-effort で軽減し、残余は notifyOps/別 sprint 扱い。

- **条件付き clear の条件をどこまで強くするか**
  - scheduleId + targetPriceId は固定。
  - 追加で customer/user id も含めるかは設計判断。
  - 強くすると安全性は増すが、呼び出し側引数と repository API はやや重くなる。

- **0-row no-op を完全正常扱いするか、異常観測するか**
  - 冪等再送では正常。
  - 別予約 race でも正常。
  - 破損データや想定外 mismatch も同じ 0-row に見えるため、観測を厚くするかは tradeoff。

- **cancelDowngrade の保守性**
  - delegate と同じ helperを使う一方、順序は逆。
  - 将来の実装者が「共通化」と誤解して clear 先行に揃えるリスクがある。
  - test G-5/G-6 とコメントで非対称性を強く固定すべき。

- **429 retry の範囲**
  - release 専用に閉じるのは YAGNI に合う。
  - 一方、Stripe mutation 全体の 429 gap は残る。
  - 今回は correctness fix ではなく成功率改善なので、広げない判断は妥当だが、将来の監査メモに残す価値はある。

- **永続失敗記録を入れない判断**
  - 固定判断として本 sprint では notifyOps のみ。
  - ただし best-effort release 失敗が Discord 流れで失われると、残 attach schedule の後追い回収が難しい。
  - Sprint 2 の `integration_failures` へつなげるため、今回の catch 位置と payload は後で二重書きしやすくしておくべき。