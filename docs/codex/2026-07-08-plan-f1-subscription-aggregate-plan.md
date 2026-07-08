# Codex plan cross-check — f1-subscription-aggregate-plan (2026-07-08)

- **作成日**: 2026-07-08
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **phase 境界の厳格性**
  G/R/W の意味が安全性の中核。特に R は golden/snapshot 更新ゼロで挙動不変を証明し、W のみ挙動変更に隔離する必要がある。R 中に test 期待値を直す、W の準備変更を混ぜる、lint surface 変更を同 commit に混ぜる、のいずれも bisect 性を落とす。

- **R commit 分割の粒度**
  移動、新設、配線置換、import 境界 lint は別 commit にする必要がある。とくに配線置換は最大リスクなので、新設だけの commit と混ぜると「既存挙動の破れ」の原因特定が難しくなる。

- **release gate の pure/infra/use-case 分離**
  判定値と副作用の対応表を現行コードから verbatim に起こす必要がある。`delegate / clear_direct / skip / mismatch` の条件だけでなく、通知有無、DB 書込有無、throw 伝播、再入時挙動、releaseCompletedDowngrade の戻り値ごとの clear/維持が設計対象。

- **source of truth の構造保証**
  plan/status 系の DB 書込は Stripe snapshot 由来に限定し、ローカル計算値から plan 列へ逆流できない型設計が必要。repository に汎用 update 口を作るとこの保証が崩れる。

- **repository の owner-scope 維持**
  zero users は migration 不要の根拠であり、runtime 防御や 0 行 match 分岐を削る根拠ではない。`users.id / clerkId / stripeCustomerId / scheduleId` の WHERE と、silent/notify 分岐の差分は現行維持が必要。

- **RETURNING shape の不足リスク**
  `matched` だけでは A-4 の row-match/clerkId 分離や Clerk sync gate、release gate の後続評価に足りない。`clerkId` と予約列を返す設計が必要。

- **anomaly 通知順序**
  unknown price / missing price の notifyOps は現行と同じく、導出直後かつ DB 書込前でなければならない。DB 書込失敗時にも通知済み、という順序が挙動として重要。

- **I-7 signal drift の扱い**
  cancel 判定は `cancel_at != null || cancel_at_period_end === true` に一本化する一方、永続列は現行どおり raw `cancelAt` 保存。この「gating は合成、永続は raw」という関係を test で pin する必要がある。

- **webhook wire 不変**
  route の 200-swallow、署名失敗 400、response body、idempotency、outer catch の notifyWebhookError は凍結対象。R/W の都合で route surface を変えてはいけない。

- **integration test 運用**
  R 中の高速反復では unit/route.test 中心にしつつ、commit 前 gate では integration を回す必要がある。integration を毎回必須にすると作業速度が落ち、逆に最後だけだと配線破壊検出が遅れる。

- **W-A2 の失敗 UX**
  eager projection で Stripe 成功後 DB 書込が失敗すると、ユーザーにはエラーが見えるが Stripe は変更済みになりうる。この二重状態は notifyOps と再試行自己修復で扱う必要があり、成功 UX だけでは不足。

- **Stripe 同 price update の根拠**
  再試行自己修復が二重課金を起こさない根拠は推測禁止。Stripe docs で proration/charge 条件を裏取りし、plan に明示する必要がある。

- **Clerk sync の重複・非 throw 性**
  action と webhook が同じ projection を重複実行しうる。Clerk sync が同値 set 冪等かつ失敗時 non-throw であることを前提にするなら、その前提を崩さない配線が必要。

- **import 境界 lint**
  `lib/stripe/domain/**` は runtime import ゼロ、`import type Stripe` のみ許容。price-mapping、db、drizzle、ops、next などを入れない enforce が必要。

- **W commit の運用**
  W は TAG 無しで commit し、OT 実機後に `[reviewed]` amend。G/R と同じ review/tag 運用に混ぜると承認プロセスが崩れる。

## plan ドラフトへの抜け・未考慮指摘

- **Task 4 が R と action 配線を混ぜすぎている**
  Task 4 は「webhook/action 配線置換」として、actions.ts の gating・reservation・cancel clear も R で置換している。W-A2 は Task 6 に隔離されているが、action path の広範な書換え自体は決済重要領域で、R の挙動不変に強く依存する。plan 上は actions 側の既存 A-3/A-4/CHANGE_BLOCKED/NO_CHANGE/NO_SCHEDULE の全分岐をどの test で pin するかをもう少し明示した方がよい。

- **`projectStripeSnapshot(sub)` の責務が曖昧**
  spec では aggregate メソッドとして `projectStripeSnapshot(sub)` が plan 6 列の射影を担うが、VO の `derivePlanFromStripe` は resolver 注入と anomaly を持つ。plan では Task 3/4 間で「price resolver をどこで呼び、aggregate に何を渡すか」がやや曖昧。Stripe sub だけで aggregate が price→plan 解決するなら domain の price resolver 注入が必要になり、既存記述と齟齬が出る。

- **release gate の対応表はあるが検証対象の列挙が薄い**
  参照事実 A は良いが、Task 4 の完了条件に「evaluateRelease の pure unit test が表の全判定を網羅する」ことが明示されていない。既存 release gate suite だけに頼ると、pure 判定の境界が設計通り切れているかの検証が弱い。

- **repository unit test の観点が不足**
  Task 3 に repository unit test とあるが、重要観点である owner-scope WHERE verbatim、予約 3 列 atomicity、個別予約列 update 口がないこと、RETURNING shape、0 行 match の shape が明示されていない。

- **lint 境界の negative test 運用が危うい**
  Task 5 に「違反 import を一時挿入して戻す」とあるが、readable な実証記録をどこに残すかが曖昧。作業者の口頭記録だけだと review で検証しづらい。少なくともレビュー報告に対象 import と lint failure を明記する運用が必要。

- **G1 の “snapshot 2 本追加” は注意**
  status matrix が contract snapshot 型なら、G では追加 snapshot は許容だが、R 以降の更新禁止対象になる。plan はそれを global に書いているが、Task 1 内にも「追加後は R で凍結」と明記した方が事故が減る。

- **G7 の matrix 範囲が “代表遷移” に縮んでいる**
  spec は `classifyChange 全 rank matrix` としているが、plan は「rank matrix(up/down/same 代表遷移)」と読める。全 rank matrix が要件なら、代表だけでは不足の可能性がある。

- **Stripe docs 裏取りの出典が弱い**
  参照事実 C は必要要素を満たしているが、`docs.stripe.com/billing/subscriptions/coupons` は proration の一般説明としてはやや間接的。`subscriptions/update` と subscription item price update の公式 docs を主出典にする方が、二重課金なし根拠として強い。

- **Task 7 の docs commit が phase 要件と干渉しうる**
  完了 docs commit `[no-review]` が実装 phase 外なら問題ないが、G/R/W の commit 境界と「W は単独 commit 隔離」を曖昧にしない必要がある。docs commit が W と混ざらないことを明示した方がよい。

- **fresh subagent / canonical review の task 単位は明記されているが、risk task の Codex review 範囲がやや狭い**
  Task 4/6 は対象だが、Task 3 の repository 型境界は「型の基準回」として重要。Codex review 対象に含めるか、canonical review の観点に明示した方がよい。

## リスク / 対立しうる設計判断

- **Stripe 型を domain に入れるか**
  `import type Stripe` は runtime 依存ではないが、domain 純度を厳しく見る立場では SDK 型結合に見える。一方で「Stripe snapshot からしか射影できない」構造保証には有効。将来 monorepo 化時の alias 切断方針をコメント/型境界で残すのが妥当。

- **aggregate が射影値を作るか、VO/use-case が作るか**
  price resolver 注入と anomaly 通知を考えると、aggregate に Stripe sub だけを渡して完結させる設計は難しい。pure aggregate の責務を「すでに導出済みの plan/status 値を SliceUpdate に整形する」に寄せるか、「resolver を引数に取り導出も含める」かを明確にすべき。

- **eager projection の UX**
  DB projection 失敗時に error を返す設計は整合性検知として正しいが、ユーザー視点では Stripe 変更済みなのに失敗表示になる。A-3 と同型に寄せる判断は一貫しているが、サポート/OT で扱える通知 payload が十分かは要確認。

- **R の配線置換を 1 commit にするか**
  bisect 単位としては合理的だが、webhook・action・release gate を一度に触るため blast radius は大きい。さらに分けると挙動不変証明はしやすいが、途中状態の重複や一時 adapter が増える。速度と検証容易性の対立がある。

- **integration gate の頻度**
  commit 前 gate に寄せるのは現実的だが、Task 4 のような最大リスクでは途中で integration を挟まないと原因特定が遅れる可能性がある。

- **同 price update の自己修復依存**
  eager projection 本体は Stripe docs 裏取りに依存しないが、再試行自己修復の説明は依存する。Stripe API の細部に依存するため、docs 根拠と stg smoke の両方を残すべき。