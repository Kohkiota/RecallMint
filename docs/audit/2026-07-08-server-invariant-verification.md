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
