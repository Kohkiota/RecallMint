# Codex plan cross-check — f1-subscription-aggregate (2026-07-08)

- **作成日**: 2026-07-08
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **aggregate 境界の精密化**
  - `users` 全体ではなく subscription slice のみだが、実際には `stripeCustomerId` / `clerkId` / `deletedAt` が repository の lookup・A-4・Clerk sync に関与する。aggregate 状態に含めないとしても、repository/use-case の入力・戻り値としてどこまで扱うかを明確にする必要がある。
  - soft-delete 済み row は subscription state を保持し続ける。aggregate が「有効 user の subscription」と「scrub 済み correlation row」を混同しない設計が必要。

- **source of truth の非対称性**
  - plan/status 6 列は Stripe snapshot からの projection。
  - 予約 3 列は action が作り、webhook が clear/recovery する。
  - したがって「Stripe が唯一の source」という単純化ではなく、予約状態については DB が gating truth であることを型・API・命名で分ける必要がある。

- **W-A2 fix の意味**
  - F1 内で W-A2 を埋めるなら、これは純粋 refactor ではなく user-visible な整合性変更。
  - upgrade action から DB projection を行う場合、既存の「plan/status は webhook 専属」という運用前提が変わる。source は Stripe response なので方向性は保てるが、書き手は webhook 専属ではなくなる。
  - DB 書込失敗時に upgrade action を失敗扱いにするなら、Stripe 側変更成功後に user-facing error が返る可能性がある。これは A-3 型と整合する一方、既に Stripe は変更済みという UX/運用上の扱いを明記すべき。

- **webhook 200-swallow との関係**
  - webhook route はエラーでも 200 を返す凍結 wire。F1 で use-case/repository 化しても、この catch 境界・通知・idempotency の意味を変えない必要がある。
  - use-case 層が throw する設計の場合、action path では rethrow、webhook path では swallow-to-200 という呼び出し側差分を明示する必要がある。

- **release gate / 予約 3 列の atomicity**
  - I-8/I-9 が最も壊れやすい。`ScheduledChange | null` の VO だけでは不十分で、repository が 3 列を常に同時 set/clear する API だけを公開することが重要。
  - mismatch 時に「書かない + alarm + OT 介入」という現行挙動を aggregate/use-case 分割後も保存する必要がある。

- **A-4 row-match / clerkId 分離**
  - `.updated` / `.deleted` の row match 判定と scrub 済み row の偽アラート回避は F1 で崩れやすい。
  - repository の戻り値は単なる `updatedCount` では足りず、`matched`, `clerkId`, `scheduled fields` など現行分岐に必要な情報を表現する必要がある。

- **Clerk publicMetadata sync**
  - client が plan を知る唯一の経路が Clerk metadata なので、projection use-case 化で DB 書込と Clerk sync の順序・失敗扱いを明確にする必要がある。
  - DB projection 成功・Clerk sync 失敗時に action/webhook でどう扱うかは、gating DB と client-visible JWT plan の一時不一致リスクとして残る。

- **I-7 signal drift**
  - DB 永続は `cancelAt`、gating は `cancel_at` と `cancel_at_period_end` の合成 predicate。F1 で一本化するなら「永続値を変えない挙動不変」なのか、「判定仕様を整理する挙動変更」なのかを厳密に分ける必要がある。

- **test/golden の役割**
  - F1 先頭の golden は、単なる追加 test ではなく R phase の挙動不変証明の基準になる。
  - 既存 snapshot/golden 更新ゼロを守るなら、G phase で追加した golden と既存 golden のどちらを「更新禁止対象」にするか明確にする必要がある。

- **zero users 前提の限界**
  - migration/compat は不要だが、Stripe webhook が過去 event や test/stg 残存 customer に対して来る可能性までは消えない。schema migration 不要と runtime defensive behavior 不要を混同しない方がよい。

## plan ドラフトへの抜け・未考慮指摘

- **`stripeCustomerId` / `clerkId` の扱いが境界外すぎる**
  - aggregate 境界から外す判断は妥当だが、repository/use-case では `stripeCustomerId` lookup、`clerkId` RETURNING gate、A-4 偽アラート回避、Clerk sync に不可欠。plan は slice 9 列中心で、補助 identity/correlation fields の型上の扱いが薄い。

- **W-A2 eager projection の失敗 UX が未整理**
  - Stripe upgrade は成功したが DB projection が reject した場合、action は rethrow して redirect 不到達になる設計。これは「検知」としてはよいが、user には失敗に見え、実際には Stripe が変更済みという二重状態になる。
  - notifyOps だけでなく、user 再試行時の挙動、二重 upgrade 回避、Stripe 側が既に新 plan の場合の changePlan 判定を考慮すべき。

- **`projectStripeSubscription` の key 設計が曖昧**
  - checkout Step2 は `clerkId`。
  - created/updated は `stripeCustomerId`。
  - W-A2 action は `user.id` または `stripeCustomerId` のどちらで owner-scope するかが重要。
  - plan は `key` と書くが、各 caller ごとの必須 match 条件・RETURNING 内容・0 row 時の挙動差が不足している。

- **checkout `.created` 先着 test の期待が現行事実と衝突しうる**
  - `customer.subscription.created/updated` は `WHERE stripeCustomerId` なので、checkout Step1 前なら 0 row match は自然。
  - ただし silent なのか notify なのかは A-4 の分岐と絡む。G6 の「silent」と plan 本文の repository row-match handling が整合しているか要確認。

- **anomaly 通知の順序が未定義**
  - `derivePlanFromStripe` が `unknown_price` / `missing_price` を返し、caller が notifyOps する方針だが、DB 書込前に通知するのか後に通知するのか、DB 書込失敗時も通知するのかが未記載。
  - 現行の unknown price golden が通知 payload・回数・タイミングを pin しているなら、移設時の挙動不変条件として書くべき。

- **release gate の use-case 編成が不足**
  - aggregate は `delegate | clear_direct | skip | mismatch` を返すとしているが、現行には Stripe schedule release、already released recovery、DB clear、mismatch alarm など複数副作用がある。
  - 各戻り値に対する side effect、失敗時の throw/swallow、通知、再入可能性を表にした方がよい。

- **repository save API が粗い**
  - `applySliceUpdate(key, update)` だと、plan 6 列 projection、deleted reset、reservation set、reservation clear、release-gate conditional clear が同じ口に見える。
  - 「逆流禁止」や「予約 3 列 atomicity」を構造保証するには、意図別メソッドまたは update type の discriminated union が必要。

- **import 境界 lint の追加が挙動不変 phase に混ざる**
  - R phase に eslint import 境界を追加すると、挙動は変えないが build/lint surface は変わる。既存 lint config への影響、CI failure の切り分け、escape 規約の導入 commit を分けるべきか検討余地がある。

- **`price-mapping.ts` の domain import 例外がやや危うい**
  - domain pure 層が env load fail-fast を持つ mapping に依存するなら、純粋層のテスト容易性と import 副作用を損なう可能性がある。
  - VO が直接参照するのではなく、price resolver を引数にする選択肢とのトレードオフを明記すべき。

- **I-7 の扱いが「副産物」にしては重要**
  - `isCancelScheduled` を VO に入れるなら ScheduledChange とは別概念に近い。VO は 2 つのみという判断の中で、cancel predicate が ScheduledChange VO に同居する理由を明確にした方がよい。

- **deletion cascade との接続が薄い**
  - F1 は deletion cascade を大きく触らないとしても、`.deleted` webhook と Clerk user deleted 後の scrub row の関係は A-4 の核心。
  - `applyDeleted()` が scrub 済み row に対してどう振る舞うか、`clerkId null` の場合に Clerk sync を避ける条件が必要。

## リスク / 対立しうる設計判断

- **eager projection vs webhook 専属 projection**
  - eager projection は W-A2 を実質的に閉じられる。
  - 一方で action path に plan/status DB write が増え、Stripe 成功後 DB 失敗時の user-facing error という新しい運用リスクを作る。

- **薄い repository vs 意味別 repository**
  - 薄い repository は YAGNI に合う。
  - ただし `applySliceUpdate` が汎用すぎると、逆流禁止・予約 atomicity・A-4 分離を型で守りにくい。

- **pure domain が Stripe 型を受けるか**
  - `Stripe.Subscription` を直接受けると projection の入力 source を構造保証しやすい。
  - ただし domain が Stripe SDK 型に結合し、将来の domain package 化や fixture 作成が重くなる。

- **Clerk sync を projection use-case に含めるか**
  - 含めると DB plan と client-visible plan の射影定義が一箇所になる。
  - 含めると action upgrade 時にも Clerk sync が走り、失敗扱い・通知・重複実行の設計が必要になる。

- **I-7 を挙動不変で pin するか、仕様として整理するか**
  - 挙動不変なら F1/R に収めやすい。
  - 仕様整理まで踏み込むと F3 寄りの挙動変更になり、commit 境界が崩れる。

- **golden 追加の量**
  - G1-G7 は refactor safety として強い。
  - ただし integration 寄り test が増えると R phase の反復速度が落ち、失敗時の原因切り分けが難しくなる。 unit/contract/integration の役割分担を保つ必要がある。