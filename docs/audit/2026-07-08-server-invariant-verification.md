# server 側 invariant 欠落疑い 4 件の裏取り(fact-finding・実装なし)

- 日付: 2026-07-08 / branch `develop` / HEAD `3903468`
- 出所: `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` §4 の疑い 4 件。完全 DDD(F0)の判断と独立の先行裏取り — real なら個別 fix する価値があるため事実を確定する。
- 方法: Explore 4 体(コード追跡)+ controller による **実 DB 物理確認**(information_schema への read-only query・migration SQL と突合)。実際の不正 payload 送信テストは未実施(read-only 規律)— 判定はコード追跡による高確度。
- file:line は HEAD `3903468` 時点。fix 着手時に再スキャン。

## 判定サマリ

| # | 疑い | 判定 | 実害の質 | fix サイズ |
|---|---|---|---|---|
| ① | single カテゴリ制約が client のみ | **REAL** | 自分のデータ不整合(UI 混乱)・user_id scope 内 | **M** |
| ② | session 'completed' 後の event append ガード不在 | **部分的**(ガード不在は確定・ただし正当ケースが同経路) | 破損 client / 複タブ race のみ | S〜M(**設計判断が先**) |
| ③ | selected_answer_ids ⇄ options 整合検証なし | **REAL**(ただし**既知の意図的 deferral**) | 自分の学習統計の自己改竄のみ・他者/課金波及なし | **M** |
| ④ | 直書き action の tx/owner ばらつき | **部分的**(大半 LOW・**upgrade 2 action のみ REAL**) | Stripe⇄DB の eventual consistency 窓 | **M** |

**共通の安心材料**: 4 件とも認証・所有権(user_id scope)は破られていない。**他ユーザーのデータや課金の完全性に波及するものはゼロ**。全て「自分のデータを自分で(または壊れた client が)不整合にできる」類。

---

## ① single カテゴリ制約 — **REAL**

**業務ルール**: select_type='single' のカテゴリでは 1 card に同カテゴリの tag_option は 1 つまで。

**client 側 enforce(確認済)**: `lib/tags/build-next-tag-set.ts:33-39`(toggle 時の同カテゴリ入れ替え)/ `lib/tags/tag-crud.ts:445-455`(handleCreateOptionAndAssign の既存除去)/ use-card-tag-toggle・use-bulk-card-tags とも buildNextTagSet 経由。

**server 側(欠落確定)**: `lib/cards/card-field-handlers.ts:192-241` handleTagOptionIds の検証は ① uuid[] 形式(max100)② 重複排除 ③ card 所有 ④ option 全件の存在+所有、まで。**option→category→select_type の JOIN も「同カテゴリ 2 個以上」の検査も無い**。whole-set replace(DELETE→INSERT)で素通り。upload 経路(apply-ocr-tags.ts:130-132)は selectType 'multi' hardcode で当面 risk 外。

**DB 物理確認(3 点セット・実 DB information_schema)**: card_tags = PK(card_id,option_id) + FK3 + NOT NULL のみ。**UNIQUE/CHECK/TRIGGER なし(DB 全体で trigger ゼロ)**。single 制約は cross-table(tag_categories.select_type 参照)ゆえ UNIQUE では表現不能 — DB では守られていない。migration SQL(drizzle/migrations/0020)と一致。

**シナリオ**: 壊れた/悪意 client が `{field:'tag_option_ids', value:[optA, optB]}`(同一 single カテゴリの 2 option)を entity-mutations/bulk に POST → 全検査 pass → card_tags に 2 行 INSERT → 'applied'。pull 後の UI は「single なのに 2 個 checked」を表示し、toggle 挙動が前提崩れで混乱(次の toggle で自己修復はされる)。

**fix(M)**: handleTagOptionIds に tagOptions→tagCategories の JOIN + category 別 grouping + single で count>1 → 'failed'(+40〜60 行 + test)。DB trigger は既存方針(trigger ゼロ)に反するため application 層が妥当。

---

## ② session 'completed' 後の event append — **部分的**

**ガード不在(確定)**: Phase 0(route.ts:93-125)の upsert は payload の status をそのまま上書き(completed→active の巻き戻しも素通り)。processSession(ingest-review-events.ts)は session.status を一切読まない(検証は event_id 冪等 + orphan 排除のみ)。DB 制約なし(status は text・CHECK なし — 実 DB 確認済)。

**ただし正当ケースが同じ経路を通る**: local-first ゆえ「オフラインで session 完了 → online 復帰後に pending event を flush」は**設計上正当な遅延 flush**であり、これは「completed session への event append」そのもの。client コメント(review-events.ts)も「pending は次回 flush で拾える前提」と明記。**「completed なら拒否」の単純ガードは正当ケースを壊す**。

**正常 client では不発(確認済)**: session-runner.tsx:315-328 — phase='finished' 後は event 生成経路がない(completeStudySession → flush の順序固定)。実害が出るのは破損 client / 複タブ race(同 origin IDB 共有で別 tab が同 session_id に event を積む)のみ。

**その場合の不整合**: 過去日付の study_days 積み増し / completed 後の cards FSRS 上書き / streak 歪み — いずれも自分のデータ内。

**fix の方向(設計判断が先・S〜M)**: 単純拒否は不可。案 = (a) 「completed_at + 猶予窓(例 24h)を超えた event は failed に分離」(遅延 flush と破損を時間で区別)(b) status 巻き戻し(completed→active)のみ拒否(c) server guard でなく検知 log + 監視のみ。**どれも仕様判断であり、完全 DDD F2(Session aggregate の状態機械)で扱うのが自然**。

---

## ③ selected_answer_ids ⇄ options 整合 — **REAL(既知の意図的 deferral)**

**欠落(確定)**: eventSchema(ingest-review-events.ts:41-54)は selected_answer_ids を「string(min1)[]・max50」のみ検証(uuid 形式ですらない — `lib/validation/review-session-bounds.ts:11`、raw value 混在許容のコメントあり)。Phase 1 の cards SELECT(:106-132)は **options / correctAnswerIds を取得しない**。`deriveRating`(:68-70)= `ev.rating ?? (ev.is_correct ? 3 : 1)` — **is_correct は payload 直用(server 再計算なし)**。

**シナリオ 3 種(コード追跡で確定)**: (a) 存在しない option id + is_correct=true → そのまま保存・rating=3・streak+1・study_days.correct+1 (b) 別カードの option id → 同様に素通り (c) 不正解を is_correct=true に改竄 → FSRS が誤った学習曲線で進行。**波及は自分の answer_events / reviews / cards.currentStreak / study_days のみ**(user_id scope・課金非波及)。

**重要な文脈 — 新発見ではない**: `docs/audit/2026-06-12-repo-wide-audit.md §8` に **[P2] として既記録**(「selected_answer_ids が z.array(z.string()) のみ…工数 S」)。review-session-bounds.ts のコメントにも「uuid 化 / 正規化の締め直しは Phase 4 帰属(audit §10.3 (b) #12 残し分)」— **意図的に deferral された既知残債**であり、本裏取りはその「deferral されたものが完全 DDD 文脈で再浮上した」ことの確認。

**fix(M・~40 行)**: Phase 1 SELECT に options/correctAnswerIds 追加 → cardId→有効 optionId Set の map → applicable フィルタで不正 event を failed へ。**is_correct の server 再計算まで踏み込むか**は仕様判断(deriveRating の意味論 = P0 baseline §A #7 で「FSRS rating は MCQ 正誤と別概念」が intentional 確定済みのため、再計算は契約に触れる可能性 — spec で判断)。

---

## ④ 直書き server action の tx/owner ばらつき — **部分的(upgrade 2 action のみ REAL)**

**比較表(基準 = entity-mutations/bulk の per-mutation tx + owner WHERE + Zod)**:

| action | 認証 | owner | tx | Zod | 判定 |
|---|---|---|---|---|---|
| settings ×3(save-session-limit 等) | ✓ | ✓(PK=userId) | 単一 UPSERT=原子 | ✓ 値域 | **LOW** |
| contact(submitContact) | ✓(未認証も設計上可) | ✓(userId は lookup 経由・改竄不能) | 単一 INSERT | ✓ | **LOW** |
| create-exam | ✓ | ✓(auto-scoped) | 単一 INSERT | ✓ | **LOW** |
| delete-exam | ✓ | ✓(所有 SELECT + WHERE) | ✓ db.transaction | △(uuid 形式チェックなし=minor) | **LOW** |
| upload(processUpload) | ✓ | ✓(guard tx) | ✓ 複数 tx | ✓ 多層 | **LOW** |
| **changePlan** | ✓ | ✓ | ✗ | ✓ | **REAL(下記)** |
| **cancelDowngrade** | ✓ | ✓ | 単一 UPDATE | ✓ | **REAL(下記)** |

**upgrade 2 action の実態(app/(app)/app/upgrade/actions.ts:75-182)**: Stripe API 呼び出し(applyUpgrade / scheduleDowngrade / cancelScheduledDowngrade)→ DB UPDATE の順で、**外部 API と DB を跨ぐため tx で括れない構造的な整合性窓**がある:
- downgrade: Stripe schedule 作成成功 → DB 3 列 UPDATE 失敗 → DB は「予約なし」に見えるが Stripe には active schedule が残る(再操作で重複予約リスク)。
- cancelDowngrade: Stripe release 成功 → DB clear 失敗 → 再実行は NO_SCHEDULE error(Stripe 側は released 済で実害は限定的)。
- upgrade: applyUpgrade 成功 → redirect(DB は webhook 任せ)— これは webhook-driven(Stripe が真実・DB はコピー)の**設計どおり**の可能性が高い(customer.subscription.updated が plan を矯正)。

**要確認(推測が残る箇所)**: schedule 3 列(scheduledDowngradeScheduleId 等)を**webhook が矯正するか**は未確定 — handle-stripe-event.ts は subscription_schedule.**released** は処理するが、schedule **作成時**の event で 3 列を埋める経路があるかは本裏取りで未確認。無ければ downgrade 失敗窓は webhook でも自己修復しない(= fix 価値が上がる)。

**fix(M)**: idempotencyKey は既存(operation-based)。方向 = (a) DB 書込を Stripe 呼び出しの**前**に「意図の記録」として置き webhook で確定(outbox 的)、または (b) Stripe 成功後の DB 失敗を retry + 監視(notifyOps)で塞ぐ。完全 DDD F1(Subscription aggregate)の設計と重なるため、**F1 に同梱が自然**。

---

## ④-追補: schedule 3 列の webhook 矯正有無(2026-07-08 追加裏取り)

§④ の「要確認」を現 HEAD で確定。**判定 = 部分的(方向依存)**: 「DB に予約残存 / Stripe に無い」方向は webhook が矯正するが、**「Stripe に schedule 有 / DB が null」方向(= changePlan downgrade の整合窓そのもの)を矯正する経路は存在しない**。

### schedule 3 列の物理確認(3 点セット・実 DB information_schema + migration 0017 一致)

| 実列名 | 型 | NULL 可否 |
|---|---|---|
| `scheduled_downgrade_schedule_id` | text | YES |
| `scheduled_target_price_id` | text | YES |
| `scheduled_change_effective_at` | timestamp with time zone | YES |

schema 定義 = `lib/db/schema.ts:87-91` / migration = `drizzle/migrations/0017_lame_wonder_man.sql:1-3`。UNIQUE/CHECK/DEFAULT なし。

### webhook が 3 列に触る全経路(`lib/stripe/handle-stripe-event.ts`・網羅確認済)

| 経路 | file:line | 方向 |
|---|---|---|
| `customer.subscription.deleted` — 3 列 clear | handle-stripe-event.ts:256-259 | **clear のみ** |
| `subscription_schedule.released` — `WHERE scheduledDowngradeScheduleId = schedule.id` で冪等 clear | handle-stripe-event.ts:292-306 | **clear のみ** |
| release gate 方向2 — sub.schedule null かつ DB 予約残存 → clear | handle-stripe-event.ts:342-352 | **clear のみ** |
| release gate 完了時 clear(released / already_terminal) | handle-stripe-event.ts:377-386 | **clear のみ** |

**set する経路はゼロ**。`customer.subscription.created/updated` の plan-sync SET は 3 列を意図的に触らない(:194 コメント明記)。`subscription_schedule.created/.updated` event は handler の switch に無く default no-op(:307-309)。さらに release gate は `if (!dbScheduleId) return`(:328)で **DB null なら即 return** — Stripe に schedule が居ても照合・通知・矯正いずれも走らない(mismatch notifyOps :355-364 は DB 非 null 前提)。

### 方向別の確定判定

- **cancelDowngrade 窓(Stripe released 済 / DB に stale id 残存)= 自己修復する**。ユーザーの release 操作自体が `subscription_schedule.released` を発火 → :292-306 が schedule.id 照合で clear(webhook 配送遅延の数秒〜)。バックアップ = 次の `.updated` での方向2 clear(:342-352)。§④ の「実害は限定的」を「**webhook で自己修復確定**」に更新。
- **changePlan downgrade 窓(Stripe schedule 有 / DB null)= 自己修復しない・検知もされない**。actions.ts:141-145 の DB UPDATE 失敗は try/catch なし・notifyOps なしで silent(ユーザーには server action の汎用エラーのみ)。以後どの webhook でも 3 列は set されず、窓は**発効日まで持続(最長 1 課金周期 = 月額 1 ヶ月 / 年額 1 年)**。
- **upgrade(applyUpgrade → DB webhook 任せ)= 設計どおり確定**。`customer.subscription.updated` の plan-sync(:196-206)が plan/billingInterval/status を矯正。§④ の推測を確定に格上げ。

### 窓の間にユーザーが見る/できる状態(UI 露出)

- UI の予約表示・cancel ボタン・ブロック判定はすべて DB 列が真実 source(`app/(app)/app/upgrade/page.tsx:30-32`・changePlan の §5.5 判定 actions.ts:104-115 に「Stripe schedule 単独をブロック条件にしてはいけない」と明記)。窓の間、**予約 banner は出ず cancel ボタンも出ない** = ユーザーは「予約は入らなかった」と認識する。
- **再 downgrade 試行**: DB null なので CHANGE_BLOCKED を素通り → `subscriptionSchedules.create({from_subscription})`(subscription.ts:143-146)が「既に schedule attach 済み」で **Stripe 側 reject** → 汎用エラー。**重複予約は Stripe が物理的に阻止**(§④ の「重複予約リスク」は「二重 schedule 成立」ではなく「不可解なエラーで操作不能」に修正)。
- **upgrade 試行**: schedule 管理下の sub への `subscriptions.update`(items 変更)も Stripe が reject(高確度)→ 同じく汎用エラー。
- **帰結**: ユーザーは (a) 見えない予約が生きたまま (b) プラン変更操作が全て不可解に失敗し (c) 期末に「UI で見たことのない」downgrade が発効する。発効時は `customer.subscription.updated` が plan を正しく同期し、schedule も `end_behavior: 'release'` で自然消滅 → 後発の `.released` は 0 行 no-op — **発効後は全列整合に収束**(金銭的過剰請求なし)。

### fix サイズ・置き場

- **発生確率は低い**(Stripe 成功直後のその瞬間に DB UPDATE だけ失敗、が条件)が、発生時の窓は長い(最長 1 課金周期)+ silent(notifyOps 無し)。
- **fix S(即効・独立可)**: actions.ts:141-145 の DB UPDATE を try/catch + retry 1 回 + 失敗時 notifyOps(schedule.id 含む)。窓は塞がらないが silent でなくなり OT 手動修復可能に(schedule metadata に userId/targetPriceId/operationId が既に入っている — subscription.ts:159-164 — ため手動照合は容易)。
- **fix M(窓自体を塞ぐ)**: `subscription_schedule.created`(or `.updated`)handler を追加し、`metadata.kind === 'recallmint_downgrade'` の schedule から 3 列を populate(metadata に必要情報が全て有り、冪等 upsert 可能)。~40-60 行 + test + **Stripe endpoint の購読 event 追加(OT 手動)**。
- **置き場**: 窓の構造(外部 API と DB を tx で括れない)は Subscription aggregate の整合性設計そのもの — **M は完全 DDD F1 同梱が自然**(§④ の結論維持)。**S(観測性)のみ独立先行**する価値はある(グループ A ①③ の独立 fix と同梱可能なサイズ)。

## DB 物理確認の記録(3 点セット・実 DB)

- 方法: `.env.local` の DATABASE_URL(Supabase)へ postgres-js で **read-only** の information_schema query(table_constraints / key_column_usage / triggers / columns)。migration SQL(drizzle/migrations/)と突合し一致確認。
- card_tags: PK(card_id,option_id)・FK×3・NOT NULL のみ。study_sessions: PK(session_id)・FK×2・status に CHECK なし。answer_events: PK(id)・UNIQUE(event_id)・FK×3(session_id→study_sessions 含む)。**public schema に trigger ゼロ**。
- **副産物**: `tag_options` に **UNIQUE(category_id, name) が実 DB に存在しない**(apply 経路の事前 SELECT のみで enforce・race で同名重複が入り得る)。本裏取りの scope 外だが、①と同型の「application 層のみ enforce」パターンとして記録。

## OT 判断材料(fix の扱い案)

- **①(single 制約)**: 独立 fix 可能(S〜M・handleTagOptionIds 単体)。完全 DDD を待つ理由なし。
- **③(selected_answer_ids)**: 既知 P2 残債の再浮上。存在検証(failed 分離)までなら独立 fix 可能(M)。is_correct 再計算は契約判断を伴うため spec 必要。
- **②(session ガード)**: 仕様判断が先(遅延 flush との区別)。**完全 DDD F2 に同梱が自然**。
- **④(upgrade)**: Subscription の整合性設計そのもの。**完全 DDD F1 に同梱が自然**。ただし「schedule 3 列の webhook 矯正有無」の追加確認 1 点で緊急度が変わる。

## 参照

- 意図 doc: `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md`(§4 が本裏取りの出所・§5 F1/F2 が同梱先候補)
- 既知残債の記録: `docs/audit/2026-06-12-repo-wide-audit.md §8`(③の初出)/ `lib/validation/review-session-bounds.ts:8-10`(deferral コメント)
- P0 baseline: `docs/audit/2026-07-06-p0-contract-baseline.md §A #7`(deriveRating = intentional の確定記録 — ③の fix 範囲判断で参照)
