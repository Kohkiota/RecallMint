# Codex plan cross-check — ddd-p0-safety-net (2026-07-06)

- **作成日**: 2026-07-06
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

P0 の正は「後続の層移動で wire/API/DB mutation の観測挙動が変わっていない」ことなので、snapshot 対象はレスポンスだけでは不足する。特に以下は契約面として明示固定が必要。

- `/api/pull` は `Cache-Control: no-store`、401/500、user 行未同期時の **200 + 空 body**、6 stream の key 名と cursor 名が契約。実装上も `cards/exams/tombstones/tag_categories/tag_options/card_tags` と `cursors.card_tags = maxCreatedAt` が wire shape になっている。根拠: [route.ts](/workspaces/RecallMint/app/api/pull/route.ts:36)
- `card_tags` は `created_at` cursor で、削除・関連解除そのものは stream に出ない。コメント上も「cards.updated_at bump 起点の取り直し」で穴を塞ぐ設計なので、triage では `card_tags` 単体 snapshot だけでなく「カード更新と card_tags 再取得の意図的非対称」を記録すべき。根拠: [card-tags-pull.ts](/workspaces/RecallMint/lib/db/card-tags-pull.ts:10)
- tombstone の `entity_type` は `'exam' | 'card' | 'tag_category' | 'tag_option'`。後続 DDD 化で enum/type を動かすと壊れやすいので、代表 tombstone に `tag_category`/`tag_option` を含めるべき。根拠: [tombstones-pull.ts](/workspaces/RecallMint/lib/db/tombstones-pull.ts:14)
- `entity-mutations/bulk` は `duplicate_mutation_id` が独立 error code。要求の error list に明示されていないが、実装は 400 で返す。全 error code 固定に含める必要がある。根拠: [route.ts](/workspaces/RecallMint/app/api/entity-mutations/bulk/route.ts:70)
- `entity-mutations/bulk` は registry unknown / invalid patch を 400 ではなく per-mutation failed + 200 にする。`skipLog` delete は `entity_mutations` INSERT なし、`applied` には数える。この粒度を DB mutation 捕捉に含めないと、後続で「見た目 200」のまま監査 log 契約が変わる。根拠: [route.ts](/workspaces/RecallMint/app/api/entity-mutations/bulk/route.ts:103)
- `entity-mutations/bulk` は tag 系も現 HEAD で契約対象。card happy path だけでは `entity_type/op` の DDD 移動リスクを拾えない。少なくとも 9 op の inventory、snapshot は代表 op + skipLog/cascade/invalid patch を固定したい。
- `review-events/bulk` は response body が `{ ok, failed }` で applied count がない。DB mutation 捕捉側で、session upsert、answer_events、reviews、cards update、study_days を固定しないと挙動差を検知できない。
- `ClientAnswerEvent.rating` は answer_events には保存されず、reviews と study_days にだけ derive 済み値として出る。`answer_events` INSERT に rating が出ないこと、`reviews.rating` と `study_days.correctCount` が `deriveRating` ベースであることを同時に固定すべき。根拠: [route.ts](/workspaces/RecallMint/app/api/review-events/bulk/route.ts:77), [route.ts](/workspaces/RecallMint/app/api/review-events/bulk/route.ts:209)
- `study_days.correct_count` は `is_correct` ではなく `rating >= 2` で増える。これは seed 2 件以外の triage 候補。FSRS rating ありケースを golden に入れないと P3/P4 で壊れやすい。根拠: [route.ts](/workspaces/RecallMint/app/api/review-events/bulk/route.ts:377)
- upload は `ProcessUploadResult` union だけでなく `revalidatePath('/app/upload')` と `revalidatePath('/app')` が finally で常に走る契約。エラー path でも副作用が発火するため、固定対象に入れるべき。根拠: [process.ts](/workspaces/RecallMint/app/(app)/app/upload/_actions/process.ts:127)
- upload の非決定値は `Date.now()` 由来の in-flight threshold と新規 exam 名、DB default id、`sourceDocumentId`、ops 通知 timestamp。`vi.setSystemTime` だけでなく `Date.now` 依存と DB returning fixture の固定が必要。根拠: [process.ts](/workspaces/RecallMint/app/(app)/app/upload/_actions/process.ts:273), [process.ts](/workspaces/RecallMint/app/(app)/app/upload/_actions/process.ts:329)
- webhook は text/status だけでなく idempotency insert、duplicate の `duplicate` text、handler error の `handler error swallowed`、unknown/unsupported event の 200 `ok` が契約。Stripe/Clerk とも「エラーでも 200」の面が重要。根拠: [stripe route.ts](/workspaces/RecallMint/app/api/webhooks/stripe/route.ts:41), [clerk route.ts](/workspaces/RecallMint/app/api/webhooks/clerk/route.ts:80)
- Stripe webhook は subscription status 10 種を 3 種へ正規化し、`unpaid/incomplete` は `subscriptionStatus='past_due'` だが `plan='free'` に倒す。状態遷移 golden は代表 1 件では不足し、少なくとも active/trialing、past_due、unpaid/incomplete、canceled 系、不明 price_id fallback を inventory 化すべき。根拠: [route.ts](/workspaces/RecallMint/app/api/webhooks/stripe/route.ts:86)
- Clerk deletion は users soft delete + 10 子テーブル明示 DELETE が契約。コメントに「8 テーブル」と古い表現が残るが実体は 10 件なので、snapshot/contract は実 DELETE 呼び出し全数を固定すべき。根拠: [route.ts](/workspaces/RecallMint/app/api/webhooks/clerk/route.ts:239)
- Dexie schema は P0 で触らない前提でも、凍結 inventory には version 1〜7 の stores 定義を入れるべき。後続 DDD で client-db の移動・分割をするなら、Dexie schema string の差分が最も事故りやすい。根拠: [client-db.ts](/workspaces/RecallMint/lib/client-db.ts:263)

## plan ドラフトへの抜け・未考慮指摘

- `entity-mutations bulk` の error code 表に `duplicate_mutation_id` が抜けている。現 HEAD では明確に外部応答なので「全 error code」対象。
- `entity-mutations bulk` の対象が「payload + fake tx」と抽象的で、tag_category/tag_option、skipLog delete、cascade serial fallback、unknown entity/op、invalid patch の 200 failed 契約が明記不足。
- `review-events bulk` は `rating` seed を intentional としているが、`study_days.correct_count = rating >= 2` の契約固定が書かれていない。`is_correct` と乖離しうるので triage 表に必要。
- `/api/pull` の triage 候補に `card_tags created_at cursor + cards.updated_at bump` はあるが、golden にどう表すかが弱い。`card_tags` 単体 delta と「解除は tombstone ではなくカード更新側で補完」の inventory が必要。
- upload は「11 error code targeted」とあるが、`revalidatePath` が成功/失敗を問わず finally で走る点、`Date.now()` による新規 exam 名・inflight threshold、`markFailed` の upload_records/status 副作用が固定対象として不足。
- webhook は「stripe 状態遷移」とあるが、Stripe の状態遷移 matrix が広い。plan/free/billingInterval/subscriptionStatus/currentPeriodEnd/cancelAt/scheduled downgrade 3 列のどこまでを代表面にするかを明示しないと、snapshot が薄くなる。
- Clerk webhook は `user.created` と `user.deleted`、unknown event、duplicate、missing/invalid signature の text/status がそれぞれ契約。plan は deletion 10 テーブルに寄っており、created/publicMetadata sync や unknown 200 `ok` の扱いが薄い。
- import 境界 lint は `lib/**・components/** から @/app 禁止` なら現 HEAD の該当は確かに主に 2 件だが、`app/**` 内の `@/app/...` 横断 import は検出対象外。`custom-filter-form.tsx` など app 内で exams の `_components/_lib` を参照する箇所があり、DDD 境界の再汚染として許容するのか別ルールにするのか未決。
- `no-restricted-imports` で allowlist を per-file override にする場合、単に rule を `off` にするとそのファイル内の全禁止 import が将来も通る。対象 import だけを許す設計にするか、override の副作用を baseline doc に明記すべき。
- `app/** から ../../../ 禁止` は app route group の相対 import 2 件を拾うが、`../../../../` など 4 段以上も確実に拾う pattern になっているか確認が必要。`../../../*` だけだと ESLint pattern の解釈次第で漏れる可能性がある。
- snapshot serializer fallback は最後の手段にすべき。serializer でマスクすると、契約値そのものの変化まで隠す危険がある。まず fixture/stub で固定、残りを個別 field mask に限定する制約が欲しい。
- `pnpm test` に contract が含まれる配置では、`.snap` 更新が通常 test と混ざる。`test:contract` だけでなく、CI/レビュー時に `-u` を使わない運用、snapshot diff review のルールが必要。
- dead-sweep Tier 1 は概ね妥当。ただし `dropdown-menu.tsx` 削除は import ゼロだけでなく shadcn 再生成・docs 参照・barrel export がないことを確認条件に入れるとよい。コメント修正は挙動不変。

## リスク / 対立しうる設計判断

- snapshot は「現状実値」を固定する強い武器だが、bug・偶然の mock 実装・Zod issue の内部形まで正にしやすい。triage 先行は必須だが、triage 対象を seed 2 件に閉じると焼き込み事故が残る。
- golden の高度は代表面に絞る方針でよいが、代表面の選び方を誤ると P1〜P4 の安全網として過信を生む。特に sync と webhook は branch 数が多く、「happy + error code」だけでは DB mutation の意味変化を拾えない。
- 既存 route tests と contract tests の二重管理は避けられない。既存 test は制御フロー・局所 invariant、contract は wire/副作用 snapshot と役割分担を明記しないと、片方の修正漏れや矛盾が起きる。
- fake tx による DB mutation 捕捉は高速だが、Drizzle SQL object の内部構造に依存しやすい。snapshot に SQL object 全体を焼くと脆く、逆に抽象化しすぎると回帰検知力が落ちる。
- import lint の allowlist は現状維持には有効だが、per-file off は将来の新規違反を同じファイル内で見逃す。P0 では許容しても、後続 phase で削除期限を強く管理する必要がある。
- P0 は挙動不変なので、triage で bug 判定が出た面を snapshot 対象外にして停止・相談する判断は正しい。一方で対象外が増えるほど安全網に穴が空くため、baseline doc に「どの後続 phase がいつ回収するか」まで残すべき。