# Webhook/Action 全経路 — 「DB 整合を失敗しうる外部 API 成功に依存」パターン横断監査(read-only)

- 日付: 2026-07-10 / branch `develop` / **read-only 調査(修正・push なし)**
- 契機: `docs/audit/2026-07-10-stripe-downgrade-reservation-clear-bug.md` で判明した構造欠陥の**同型パターン**を webhook 全経路 + subscription action で洗い出す。
- 対象 = `lib/stripe/handle-stripe-event.ts` / `lib/stripe/subscription.ts` / `lib/stripe/project-subscription.ts` / `app/(app)/app/upgrade/actions.ts` / `app/(app)/app/settings/actions.ts` / `lib/clerk/handle-clerk-event.ts`(Clerk 対比)/ `app/api/webhooks/{stripe,clerk}/route.ts`
- 方法: 全 `stripe.*` 呼出(12 箇所)と全 `users` 書込を grep で網羅 → 各 coupling を first-hand read で分類。

---

## 結論(TL;DR)

1. **「DB 書込が、直前の失敗しうる外部 API 成功に条件付けられている」coupling は 5 箇所**存在(checkout 射影 / delegate clear / upgrade 射影 / downgrade 予約 set / cancel 予約 clear)。ただし**恒久破綻(self-heal なし)は downgrade delegate clear の 1 箇所のみ**(既知バグ)。残り 4 箇所は **self-heal 経路あり or user-facing で可視・retry 可**。
2. **恒久破綻が delegate clear だけである理由 = self-heal 構造の有無**。予約 clear の普遍的 self-heal は `subscription_schedule.released` webhook(`handle-stripe-event.ts:171`)だが、これは**実際に release が発火した時だけ**動く。cancel は本物の release を撃つので self-heal する。downgrade 発効は開放端 phase1 で released が自然発火せず、active-release(唯一の release 契機)が throw する → **released が永遠に来ない = self-heal 皆無**。
3. **増幅要因 = webhook は常に 200 を返す**(`route.ts:60`・CLAUDE.md Stripe-2 の再送ループ防止)。→ handler が silent に throw しても **Stripe は再送しない**。よって「別 event が別経路で同じ DB 書込をやり直す」以外の回復手段がない。checkout 射影は後続 `customer.subscription.created/updated` が **retrieve 非依存で**再射影して self-heal するが、delegate clear を再実行する経路は全て同じ throwing release を通る → 回復不能。
4. **Clerk 対比(item 4)**: 「外部失敗を DB 整合から切り離す」パターンは **Stripe 経路にも既に存在**する — `handle-clerk-event.ts` の `user.deleted` は Stripe sub cancel の成否に関わらず **DB 削除 transaction を forward-only 実行**し、失敗は `deletion_failures` + notifyOps に記録(`:97-139` vs `:175-202`)。**delegate clear だけがこの規律から外れている**(clear を release 成功に賭けている)。
5. **fix 要否**: **downgrade delegate clear のみ必須 fix**(既 doc の通り)。他 4 箇所は self-heal ゆえ不要。ただし cancel clear(`actions.ts:243`)は delegate と**同じ「clear を release 成功に gate」構造**なので、downgrade fix と同じ decouple helper を**ついでに best-effort 化しておく価値は中程度**(self-heal はあるが二重防御)。→ **downgrade 単独 fix が主。cancel decouple は同 helper で安価なら同梱、高コストなら別 chore。広域 hardening sprint は不要**。

---

## パターン定義と判定軸

**対象パターン** = 「**DB 状態変更**(plan 投影 / 予約列 set・clear / リセット)が、その**直前の失敗しうる外部 API 呼出の成功**に条件付けられ、API が throw すると DB 書込が skip される」構造。

判定軸(各 coupling を 4 軸で評価):
- **kind**: 外部呼出が **read(retrieve/list)** か **mutation(update/create/release/cancel)** か。read は許容寄り、mutation を critical path で撃つのが危険。
- **surface**: **webhook**(async・無人・200 で silent 握り)か **action**(user-facing・throw が UI に出る・retry 可)か。
- **self-heal**: API 失敗後、別 event / 別経路 / 冪等再処理で DB が最終整合するか。
- **verdict**: 恒久破綻(self-heal なし)/ degraded(self-heal あり)/ 可視(action で throw が UI に出る)。

---

## 全 coupling 一覧(file:line + 分類 + self-heal)

| # | 箇所(DB 書込 ← 依存する外部呼出) | kind | surface | self-heal 経路 | verdict |
| - | ----------------------------------- | ---- | ------- | -------------- | ------- |
| **1** | **`handle-stripe-event.ts:244` 予約 clear ← `releaseCompletedDowngrade`(release mutation `subscription.ts:203` / retrieve :258)** | **mutation** | **webhook** | **なし**(released 開放端で非発火・再 .updated も同 throw・200 で Stripe 再送なし) | **🔴 恒久破綻(既知バグ)** |
| 2 | `handle-stripe-event.ts:73` plan 射影 ← `stripe.subscriptions.retrieve(subId)`(:68) | read | webhook | **あり**: 後続 `customer.subscription.created/updated`(:82)が event payload の sub で **retrieve 非依存**再射影(:53-59 コメントが degraded mode と明記) | 🟢 degraded(許容) |
| 3 | `upgrade/actions.ts:150` plan 射影 ← `applyUpgrade`(update mutation `subscription.ts:110`) | mutation | action | **あり**: A-3 で notifyOps + **rethrow → UI に error**(:155-173)+ 後続 `customer.subscription.updated` webhook 再射影 | 🟡 可視 + self-heal |
| 4 | `upgrade/actions.ts:185` 予約 set ← `scheduleDowngrade`(create+update mutation `subscription.ts:143/151`) | mutation | action | **部分**: A-3 rethrow → UI error(:190-211)。schedule 作成成功 + set 失敗 = **予約 under-set**(orphan の逆・「予約中」非表示で二重変更余地)だが可視。plan 発効は webhook 経由 | 🟡 可視(逆リスク) |
| 5 | `upgrade/actions.ts:243` 予約 clear ← `cancelScheduledDowngrade`(release mutation `subscription.ts:203`) | mutation | action | **あり**: (a) A-3 rethrow → UI error(:244-264)、(b) **user 起点 release は `subscription_schedule.released` を発火** → `handle-stripe-event.ts:171` が scheduleId で clear = **本物の self-heal** | 🟡 可視 + self-heal(**#1 と同構造だが self-heal あり**) |

### 対象パターンで**ない**(= 正しく decouple 済 or 依存なし)経路

| 箇所 | 構造 | 評価 |
| ---- | ---- | ---- |
| `handle-stripe-event.ts:131` deleted リセット | sub は event payload・**先行 Stripe 呼出なし** | 🟢 依存なし |
| `handle-stripe-event.ts:177` released clear | schedule は event payload・**先行呼出なし**(これが #1/#5 の self-heal 本体) | 🟢 依存なし(good) |
| `handle-stripe-event.ts:219` clear_direct | sub は event payload・先行呼出なし | 🟢 依存なし |
| `handle-stripe-event.ts:88` created/updated 射影 | sub は event payload・射影内 `syncClerkPublicMetadata` は **throw しない**(`clerk-metadata.ts:52-69`) | 🟢 依存なし |
| `invoice.payment_failed`(:158) | notifyOps のみ・DB 書込なし | 🟢 依存なし |
| `handle-clerk-event.ts:175` user.deleted DB 削除 tx | Stripe cancel(`:106-138`)の成否と**独立**に forward-only 実行・失敗は `deletion_failures`+notifyOps 記録 | 🟢 **decouple 済(参照実装)** |
| `handle-clerk-event.ts:46` user.created insert | 先行 Stripe 呼出なし・syncClerk は throw-safe | 🟢 依存なし |
| `settings/actions.ts:19` billingPortal.create | session 生成 + redirect のみ・**DB 書込なし**(実 cancel は portal→webhook) | 🟢 依存なし |
| `subscription.ts:63/83` resolveActiveSubscription | read のみ・DB 書込を伴わない(action の前段解決) | 🟢 read only |

---

## なぜ #1(downgrade delegate)だけが恒久破綻か(self-heal 構造の核心)

予約 clear の **self-heal 本体は `subscription_schedule.released` webhook**(`:171`、scheduleId で無条件 clear)。これは **release が実際に発火した時だけ**トリガーされる:

- **#5 cancelDowngrade**(発効**前**の user 取消): `cancelScheduledDowngrade` → `release` API を撃つ → Stripe が `subscription_schedule.released` を発火 → `:171` が clear。**DB write(clearReservation)が action 側で失敗しても、released webhook が拾い直す = self-heal 成立**。
- **#1 downgrade 発効**(phase0→phase1 遷移): 開放端 phase1(`subscription.ts:173-176`、iterations/duration 未指定)は自然完了せず **released が発火しない**。release の唯一の契機は delegate の active-release(`releaseCompletedDowngrade`)だが、それが throw(§既知バグ)→ released 永遠に来ない → **`:171` の self-heal が inert** → 恒久 orphan。

さらに **webhook 常時 200(`route.ts:60`)**が回復を断つ: handler throw でも Stripe は 200 を受けて**再送しない**。回復は「別 event が別経路で clear をやり直す」しかないが、次の `.updated` も同じ throwing release を通る → 回復不能。

**→ 恒久破綻の必要十分条件** = (mutation を critical path で撃つ)∧(webhook = silent 200)∧(self-heal 経路が構造的に不在)。**この 3 条件を全て満たすのは #1 のみ**。#2 は read + 別 event self-heal、#3〜#5 は action で可視 + webhook/released self-heal。

---

## Clerk 対比(item 4): decouple 規律の適用状況

- **`syncClerkPublicMetadata`(`clerk-metadata.ts:36-70`)** = 「外部(Clerk API)失敗を DB 整合から切り離す」の教科書実装: throw せず `ok:false` + notifyOps、404 は silent skip。DB 側は既に commit 済で巻き戻さない。
- **この規律は Stripe 経路にも部分適用済**: `handle-clerk-event.ts` user.deleted は Stripe sub cancel を **try で囲み失敗を `deletion_failures` に記録**、DB 削除 transaction は**独立に forward-only 実行**(`:97-99` コメントが明示)。= 「外部 mutation の成否に DB 整合を賭けない」。
  - 補足リスク(別種): cancel 失敗時 user 行は削除済だが Stripe sub は残る = **課金 leak**。ただし `deletion_failures` + notifyOps で**可視**(OT 手動回収前提の意図的 forward-only)。silent orphan とは別。
- **delegate clear(#1)だけがこの規律に反している**: clear を release 成功に gate(`if (result==='released'||...)` `:243`)。**同じ decouple を適用すれば #1 は解消**する = fix 方向 (a) の核と一致。

---

## fix 要否(箇所別)

| # | 箇所 | fix 要否 | 理由 |
| - | ---- | -------- | ---- |
| 1 | delegate clear | **必須(主 fix)** | 唯一の恒久破綻。既 doc の (a) 核 = clear を price==target で decouple + 冪等条件付き UPDATE |
| 5 | cancelDowngrade clear | **任意(中)** | #1 と同構造。self-heal(released webhook)あるので必須でないが、**同じ decouple helper を best-effort で当てれば二重防御**。DB write を release 前 or 独立に + 冪等化 |
| 2 | checkout 射影 | 不要 | read 依存 + 別 event self-heal(degraded mode は設計意図) |
| 3 | upgrade 射影 | 不要 | action 可視 + A-3 + webhook self-heal |
| 4 | downgrade 予約 set | 不要(監視のみ) | action 可視 + A-3。逆リスク(under-set)だが可視。fix するなら別議 |

---

## 一括 sprint 化の規模感

- **恒久破綻は #1 のみ**ゆえ、**「webhook 外部依存 hardening」の広域 sprint は過剰**(YAGNI)。他箇所は既に self-heal / 可視で防御済。
- **推奨** = **downgrade orphan fix を主 sprint**(既 doc の G→R 小 sprint)とし、そこに **#5 cancel clear の decouple を同梱**する(同じ「clear を release から切離す + 冪等条件付き UPDATE」helper を再利用できるなら安価。rule-of-three 未満だが同一パターン 2 箇所を同 helper で締めるのは妥当)。
  - 同梱条件: repository に**冪等条件付き clear 口**(`WHERE scheduledDowngradeScheduleId=? AND scheduledTargetPriceId=?`、I-9 3 列一括維持)を 1 つ足し、#1(webhook delegate)と #5(action cancel)の両方から使う。これで「予約 clear は release 成功に依存しない」を **2 経路で統一**。
  - 同梱しない場合: #1 のみ fix、#5 は self-heal に委ねて別 chore 起票(优先度低)。
- **規模**: F1 と同じ **G→R(1〜2 task)**。#5 同梱でも task +0〜1。**W(広域配線)不要**。決済経路ゆえ canonical + Codex review + Test Clock stg smoke 必須(#5 は cancel→released の self-heal も smoke で確認可)。

---

## 未確定 / OT 判断ポイント

1. **#5 cancel clear を downgrade fix に同梱するか**(冪等条件付き clear helper を 2 経路共用 = 中コスト・二重防御)。self-heal あるので必須ではない。
2. **#4 downgrade 予約 set の under-set リスク**(schedule 作成成功 + saveReservation 失敗 → 「予約中」非表示で二重変更余地)を今回対象にするか。A-3 で可視だが、これも別種の「DB<Stripe ズレ」。別 task 候補。
3. 主 fix の詳細(clear 条件の強度 = 冪等条件付き UPDATE か単純 by-customerId か)は既 doc `2026-07-10-stripe-downgrade-reservation-clear-bug.md` §6 と同一論点。

---

## 参照(file:line)

- 恒久破綻 #1: `lib/stripe/handle-stripe-event.ts:237-250`(clear gate :243)/ `lib/stripe/subscription.ts:254-289`(release :203 / retrieve :258)/ `route.ts:60`(常時 200)
- self-heal 本体: `lib/stripe/handle-stripe-event.ts:171-183`(released clear)
- 開放端 phase1: `lib/stripe/subscription.ts:173-176`
- coupling #2〜#5: `handle-stripe-event.ts:68-78` / `upgrade/actions.ts:137-174`(#3)/ `:176-211`(#4)/ `:218-266`(#5)
- decouple 参照実装: `lib/clerk/handle-clerk-event.ts:97-139`(Stripe cancel 独立)vs `:175-202`(DB 削除 forward-only)/ `lib/auth/clerk-metadata.ts:52-69`(throw-safe)
- 依存なし clear: `handle-stripe-event.ts:131`(deleted)/ `:177`(released)/ `:219`(clear_direct)
- 既 doc: `docs/audit/2026-07-10-stripe-downgrade-reservation-clear-bug.md`
</content>
