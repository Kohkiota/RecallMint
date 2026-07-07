# P0 契約 baseline — 乖離 triage(§A)/ 凍結契約 inventory(§B)

- 日付: 2026-07-06 / branch: `dddrefactor` / phase: **P0**(安全網構築)
- 出典 spec: `docs/superpowers/specs/2026-07-06-ddd-p0-safety-net-design.md`(§3.1 triage / §3.2 contract 対象表)
- 位置づけ: golden snapshot 生成の前提となる correctness gate。現 HEAD の実挙動を全数スキャンし、契約面(golden に現れうる値)に出る server↔client 乖離を `intentional`(固定 OK)/ `bug`(固定前に相談・snapshot 対象外)に分類する。**P0 は挙動不変**ゆえ本 triage でコードは変更しない。

> **§B(凍結契約 inventory)は後続 Task 9(T9)が追記する。本 commit では §A のみ。**

---

## §A 乖離 triage 表

「契約面に出るか」= spec §3.2 の対象表(pull / entity-mutations/bulk / review-events/bulk / upload result union / webhook stripe・clerk)に照らして golden に現れる値かで判定。file:line はすべて現 HEAD 実読で裏取り済(古い audit の転記ではない)。

判定サマリ: **全 16 件を分類。intentional = 15(#1・#3〜#16)/ 契約対象外(契約面に出ない)= 1(#2 のみ)/ bug = 0 / 要確認 = 0。**

| # | 乖離 | 現 HEAD file:line | 契約面に出るか | 判定 | 根拠 | snapshot 反映 | 回収 phase |
|---|---|---|---|---|---|---|---|
| 1 | `ClientAnswerEvent.rating`(client mirror に `rating?:1..4`)vs server `answer_events` に rating 列なし | client: `lib/client-db.ts:141` / server schema: `lib/db/schema.ts:588-611`(rating 列不在、`is_correct` のみ line 611) / route insert: `app/api/review-events/bulk/route.ts:213-222`(answerEvents INSERT に rating を書かない) | 出る(review-events/bulk: answer_events INSERT 値) | **intentional**(seed・OT 確認済) | rating は payload 専用の輸送列で、server は `deriveRating`(route.ts:104-106)を唯一の正として `reviews.rating` / `study_days.correct_count` を導出。answer_events は MCQ の `is_correct` のみ保持し FSRS rating を持たない設計 | 固定する(answer_events INSERT に client 由来 rating が出ないことを golden 化。rating は reviews / study_days 側にのみ deriveRating 経由で出る) | 制約参照点として P2(review-events route refactor)/ P3(rating 導出を触る時)で参照。P0 で固定済 |
| 2 | `ClientUserSettings`(client mirror)pull writer 不在 + `custom_session_limit` 欠落 | client: `lib/client-db.ts:103-112`(`session_limit` / `fsrs_mode` のみ。`custom_session_limit` なし)/ server schema: `lib/db/schema.ts:485-491`(`session_limit` + `custom_session_limit` + `fsrs_mode`)/ pull route: `app/api/pull/route.ts:36-113`(user_settings を返す stream が存在しない) | **出ない**(pull は 6 stream = cards/exams/tombstones/tag_categories/tag_options/card_tags のみ。user_settings は非出力) | 契約対象外(seed・OT 確認済) | client mirror コメント自身が「pull writer 不在で現状未使用」(client-db.ts:105-107)と明記。session 上限は RSC server read で解決し Dexie からは引かない(Q-5)。契約面(pull golden)に一切現れないため intentional/bug 分類の対象外 | 対象外(pull golden に user_settings が出現しないことを確認して記録) | 将来 user_settings を pull 配線する phase(現状未計画)で mirror 形を server と整合させる |
| 3 | card_tags cursor 非対称: `cursors.card_tags = maxCreatedAt`(他 stream は maxUpdatedAt / tombstone は maxDeletedAt) | pull route: `app/api/pull/route.ts:98-105` / helper: `lib/db/card-tags-pull.ts:35-46`(`maxCreatedAt` 返却) | 出る(pull: cursor 名 + 値) | **intentional** | card_tags は card↔option junction で `updated_at` 列を持たない(card-tags-pull.ts:8-9・schema junction)。cursor を created_at base にする以外の選択肢がない | 固定する(6 cursor key 名 + card_tags のみ maxCreatedAt の非対称を golden 化) | P0 で固定。client-db 移動(P1/P4)時の制約参照点 |
| 4 | card_tags「解除は tombstone でなくカード更新側で補完」の意図的非対称(whole-set 縮小 `[A,B]→[]` は card_tags 増分に乗らず、`cards.updated_at` bump 起点で client が旧集合を削除→再 upsert) | server helper: `lib/db/card-tags-pull.ts:9-14`(同期穴コメント)/ client apply: `lib/sync/pull.ts:16-20, 213-225`(cards 増分で changedCardIds を検出→旧 card_tags 削除→新集合 bulkPut) | 出る(pull: card_tags stream は created_at 増分のみ。補完は client apply 側の挙動) | **intentional** | 案 a として設計・両側コメントに明記。server /api/pull の契約は「card_tags = created_at 増分のみ返す」で確定。解除補完は client(pull.ts)ロジックであり server response の値には現れない | 固定する(server pull golden = card_tags created_at 増分のみ。client 補完ロジックは server contract snapshot の対象外、§B に client 挙動として注記) | P0 で server 側固定。client 補完は P1/P4(client-db 移動)で挙動保存確認 |
| 5 | tombstone `entity_type` union = `'exam'\|'card'\|'tag_category'\|'tag_option'`(client/server 対称) | server: `lib/db/tombstones-pull.ts:15` / schema $type: `lib/db/schema.ts:773` / client: `lib/sync/pull.ts:46, 231-246` | 出る(pull: tombstones stream) | **intentional** | union は client/server 一致(対称)。DDD entity 移動で union が壊れるリスクがあるため golden で代表 tombstone に tag_category / tag_option を含めて固定する(spec §3.2) | 固定する(4 種 entity_type すべてを代表 tombstone に含める) | P0 で固定。DDD で tombstone entity_type を触る phase の制約参照点 |
| 6 | option の camel⇄snake 変換(card create patch: zod `options[].isCorrect`(camel)→ 保存 `CardOption.is_correct`(snake)) | `lib/sync/server/entity-mutation-registry.ts:156-162`(`is_correct: o.isCorrect` に変換) | 出る(entity-mutations/bulk: 捕捉 cards INSERT の options 値) | **intentional** | client outbox patch は camelCase、server は CardOption(snake_case)で保存する変換が registry apply に明示。tag_option/tag_category patch は snake_case のまま列名 mapping(sort_key→sortKey)のみで wire 乖離なし | 固定する(entity-mutations 代表 op = card create の捕捉 INSERT で options=snake_case を golden 化) | P0 で固定。P1/P2(sync/registry 移動)の制約参照点 |
| 7 | `study_days.correct_count = deriveRating(ev) >= 2`(MCQ `is_correct` ではなく FSRS rating 閾値) | route: `app/api/review-events/bulk/route.ts:379-382`(`if (rating >= 2) existing.correct += 1`)/ deriveRating: `route.ts:104-106` / schema: `lib/db/schema.ts:471` | 出る(review-events/bulk: 捕捉 study_days UPSERT の correctCount 値) | **intentional**(brief の重点候補・裏取り済) | deriveRating が「replay と study_days 集計の両方から呼ぶ唯一の正」(route.ts:101-106 コメント)。FSRS の "correct"(rating>=2 = Again 以外 = 記憶保持)は MCQ の is_correct と別概念で、明示 rating 提供時に意図的に分離する。fallback(rating 未指定)時は `is_correct?3:1` ゆえ correct_count==count(is_correct) で一致し、乖離は明示 rating 提供ケースのみ。spec §3.2 が「correct_count は is_correct でなく rating>=2」を固定対象と明記 | 固定する(**明示 rating>=2 かつ is_correct=false が乖離するケースを golden に必須**。rating>=2 semantics を lock)| P0 で固定。P1(replay/streak)/ P2(review-events route)の制約参照点。**注**: 「correct rate 表示の製品意図が MCQ 正答率だった」なら製品仕様の再確認事項であってコードバグではない(下 §A 注記参照) |
| 8 | study_days の JST 集計(`todayInJst` day グルーピング + `AT TIME ZONE 'Asia/Tokyo'` の distinct 集計) | route: `app/api/review-events/bulk/route.ts:377`(todayInJst), `396-401`(AT TIME ZONE Asia/Tokyo)/ client mirror: `lib/client-db.ts:205-214`(day='YYYY-MM-DD' JST) | 出る(review-events/bulk: study_days.day 値 + study_days pull) | **intentional** | JST day 境界は全 study_days の確定 convention。server 書込 / client mirror 双方 JST で一致 | 固定する(day 文字列 = JST date を golden 化) | P0 で固定。P1(streak 算出)の制約参照点 |
| 9 | entity-mutations の 200-failed 意味論(unknown entity/op・invalid patch は 400 でなく per-mutation failed + 200) | route: `app/api/entity-mutations/bulk/route.ts:104-114`(registry 不在→failed), `110-114`(patch zod 不正→failed), `240-263`(failed[] 収集で 200) | 出る(entity-mutations/bulk: status + `{ok,applied,failed}`) | **intentional** | 部分失敗ポリシとして route header(:25-28)+ 実装に明示。envelope 不正のみ 400、per-mutation 不正は 200+failed で再送余地を残す設計 | 固定する(unknown op / invalid patch → 200+failed を代表面で golden 化) | P0 で固定 |
| 10 | skipLog delete(delete op は `entity_mutations` INSERT なし・`applied` に計上) | route: `app/api/entity-mutations/bulk/route.ts:120, 148-163`(skipLog なら log INSERT skip)/ registry skipLog 設定 | 出る(entity-mutations/bulk: 捕捉 mutation 値 = log INSERT の有無 + applied count) | **intentional** | delete は監査 log 不要、再送 dedupe は tombstone + applyCardDelete 自然冪等で担保(route header :20-24)。旧 card-mutations 経路の挙動維持 | 固定する(delete op で entity_mutations INSERT なし・applied+1 を golden 化) | P0 で固定 |
| 11 | `duplicate_mutation_id` → 400(payload 内 mutation_id 重複を envelope zod で 400 reject) | route: `app/api/entity-mutations/bulk/route.ts:70-90`(superRefine), `200-209`(専用 error code 400) | 出る(entity-mutations/bulk: 全 error code/status) | **intentional** | 並列化後の同 mutation_id 二重 applied race(R7)を入口で殺す設計(route.ts:66-69 コメント)。invalid_payload と切り分けて専用 code を返す | 固定する(duplicate_mutation_id 400 を golden 化) | P0 で固定 |
| 12 | pull user 行未同期(Clerk session あり / users 行なし)→ 200 + 空 body(6 空配列 + 6 null cursor) | route: `app/api/pull/route.ts:51-71` | 出る(pull: 境界レスポンス) | **intentional** | sign-up race を 401 と区別して 200 空で吸収(client に「user 行が来るまで待って再送」を促す)。同 pattern が entity-mutations/review-events では `user_not_synced` 401(route.ts:184-188 / 472-477)。pull だけ 200 空 body の非対称も設計(pull は read 冪等) | 固定する(200 + 空 body + null cursor を golden 化) | P0 で固定 |
| 13 | webhook「error でも 200」面(handler error → `'handler error swallowed'` 200 / duplicate → `'duplicate'` 200 / unknown・schema 外 event → `'ok'` 200 / invalid signature → 400) | stripe: `app/api/webhooks/stripe/route.ts:46-48, 50-65, 361-364` / clerk: `app/api/webhooks/clerk/route.ts:80-93, 105-107, 113-127` | 出る(webhook: text response 文言 + status) | **intentional** | CLAUDE.md Stripe-5 / Clerk 再送ループ抑止。error 時も 200 を返す(recovery は notifyWebhookError + OT 手動)が凍結契約 | 固定する(各 text 文言 + status を golden 化) | P0 で固定 |
| 14 | stripe status 正規化の非対称(`unpaid` / `incomplete` は `subscriptionStatus='past_due'` に正規化されるが `plan='free'` に downgrade) | route: `app/api/webhooks/stripe/route.ts:86-104`(normalizeSubStatus: unpaid/incomplete→past_due), `117-133`(resolvePlanFromSub: unpaid/incomplete を再分岐して plan=free) | 出る(webhook stripe: 捕捉 users UPDATE の subscriptionStatus vs plan) | **intentional** | past_due は初回支払失敗の retry 期間中アクセス保持、unpaid は max retry 後の downgrade という設計(route.ts:113-116, 127-133 コメント)。status 正規化(10→3 種)と plan 解決を分離した結果の意図的非対称 | 固定する(unpaid/incomplete ケース = status=past_due + plan=free を代表面で golden 化) | P0 で固定 |
| 15 | clerk 子テーブル明示 DELETE = **実 10 件**(集約コメント header の「8 テーブル」は stale) | route: `app/api/webhooks/clerk/route.ts:242`(header コメント「8 テーブル」stale)/ `:246`(Group I「10 件」= 正)/ 実 DELETE `:280-289`(exams/studyDays/contactMessages/aiUsageUsers/uploadRecords/userSettings/studySessions/tombstones/entityMutations/tagCategories = 10) | 出る(webhook clerk: 捕捉 DB mutation = 10 DELETE + users soft delete) | **intentional**(実 10 が契約) | user_id direct FK の全テーブルを handler が明示 DELETE。実装は 10 件で正しく、invariant test(route.test.ts)が網羅性を保証。「8 テーブル」は line 242 header コメントの取り残しで**契約値ではなく stale コメント**(下 §A 注記: Tier1 dead-sweep の追加候補) | 固定する(10 DELETE + users soft delete(deletedAt/email=null/clerkId=null)を golden 化) | P0 で固定 |
| 16 | upload `ProcessUploadResult` union + **11 error code** + `revalidatePath` 常時発火(error path 含む finally) | union/codes: `app/(app)/app/upload/_actions/process.ts:73-84`(11 code: AUTH/INVALID_INPUT/EXAM_NOT_FOUND/UPLOAD_IN_PROGRESS/PAGE_LIMIT_EXCEEDED/SIZE_LIMIT_EXCEEDED/QUOTA_EXCEEDED/GEMINI_DAILY_LIMIT_EXCEEDED/GEMINI_FAILED/SAVE_FAILED/OTHER)/ union shape `:99-106` / revalidate `:127-133`(finally で `/app/upload` + `/app` 常時) | 出る(upload result union) | **intentional** | S1.7 の構造化戻り値 + revalidate 責務集約(finally で error path でも常時発火)が凍結契約。full pipeline(advisory lock / AI / DB)は golden で実行しない | 固定する(union 形 + 11 code + revalidatePath 2 対象常時発火を golden 化。非決定値 = Date.now / DB default id / sourceDocumentId は fixture 固定) | P0 で固定。P2(process.ts 分解)の契約境界参照点 |

### §A 注記

1. **bug 判定 = 0 件。** 全乖離は実コード + コメント + spec §3.2 の三者で intentional と裏取りできた。→ brief の「bug handoff 分岐(条件 2)」は発火せず、OT 停止判断は不要(controller はそのまま P0 を進めてよい)。

2. **#7(study_days.correct_count = rating>=2)の判断根拠を明示。** brief がバグ候補として重点指定した項目。コードは deriveRating を単一の正として一貫使用しており(replay の reviews.rating と study_days.correct_count が同一導出)、明示 rating 提供時のみ is_correct と乖離する。これは FSRS の「想起できた(rating>=2)」と MCQ の「選択が正解(is_correct)」を区別する**設計上の意図的乖離**であり、コードバグではない。ただし「ダッシュボードの correct rate 表示が MCQ 正答率を意図している」場合は**製品仕様の確認事項**(コード修正ではなく product 判断)であり、P1(replay/streak)/ P2(review-events route)で当該ロジックを触る際に UX 意図を再確認すること。P0 では現挙動(rating>=2)を golden で固定する。

3. **incidental finding(triage 対象外・記録のみ): clerk route.ts:242 の「8 テーブル」コメントが stale**(実 10)。契約値(=10 DELETE)には影響しないため bug ではないが、spec §3.5 Tier1 dead-sweep(dropdown-menu / schema「13→21」/ replay-card dangling コメント)に**未収載の追加 stale コメント**。schema.ts:1 の「13 tables」(実 21)と同種。P0 の Tier1 掃討で拾うか、当該 route を触る phase 送りかは controller/OT 判断(挙動不変ゆえ P0 内修正は任意)。

4. **回収 phase 欄の意味**: 全 intentional 面は P0 で golden 固定するため「回収」対象ではない。欄は「後続 phase が当該乖離のロジックを触る際に、本 §A を制約参照点として読むべき phase」を示す(spec §4 条件 D)。契約対象外の #2 のみ、将来 pull 配線時に mirror 形を整合させる真の回収対象。

5. **#5 は client/server 対称値(乖離なし)を DDD リスクマーカーとして例外収録。** 厳密には server↔client 乖離ではないが、tombstone `entity_type` union は DDD の entity 移動で壊れやすいため、代表 tombstone に全 4 種を含めて golden 固定する目的で §A に載せた(T9 §B の「DDD 移動リスク contract 値」inventory へ引き継ぐ)。

6. **pull の stream key `tombstones`(複数)/ cursor key `tombstone`(単数)の命名非対称**(route `app/api/pull/route.ts:59,63` data=`tombstones` / `:92,101` cursor=`tombstone`。client `lib/sync/pull.ts:45,56` も同名で一貫 = 真の乖離ではない)。#3 の cursor 記述は value 非対称(card_tags=maxCreatedAt)に着目しており本 key name 非対称は別物。golden は実 JSON を自動捕捉するため実害なしだが、T9 §B / golden 手書き時に `cursors.tombstones` と誤記しないよう明記。

---

## §B 凍結契約 inventory

> T9 追記 (2026-07-06)。§A で分類した intentional 面をもとに、P0 golden テスト (T2〜T6) が凍結した契約を人間可読形式でまとめる。本 §B の記述は現 HEAD 実読で裏取り済。file:line はすべて HEAD の実値。

---

### (i) 凍結契約 inventory

§A の intentional 判定を受けて各 face の error code / HTTP status / response shape を索引化する。各 face の golden snapshot test (`tests/contract/*.contract.test.ts`) が変更されない限り、以下の値は変更禁止。

---

#### pull — `app/api/pull/route.ts` / `tests/contract/pull.contract.test.ts`

**error codes & HTTP statuses**

| code (JSON `error` field) | status | trigger |
|---|---|---|
| `unauthenticated` | 401 | `UnauthenticatedError` thrown (route.ts:44) |
| `internal` | 500 | unexpected error after auth (route.ts:47, 111) |
| (empty body — code なし) | 200 | `getCurrentUser` returns null (Clerk session valid, users 行未 sync) |

**response shape (happy path 200)**

```
{
  cards: ClientCard[],
  exams: ClientExam[],
  tombstones: ClientTombstone[],
  tag_categories: ClientTagCategory[],
  tag_options: ClientTagOption[],
  card_tags: ClientCardTag[],
  cursors: {
    cards: ISO | null,
    exams: ISO | null,
    tombstone: ISO | null,   // key = singular (§A #6)
    tag_categories: ISO | null,
    tag_options: ISO | null,
    card_tags: ISO | null    // value = maxCreatedAt (§A #3)
  }
}
```

**常時凍結**: 全レスポンスに `Cache-Control: no-store` ヘッダ (pull.contract.test.ts で hard assert)。

**未同期 200 empty body** (§A #12): 全 6 配列が `[]`、全 6 cursor が `null`(tombstone cursor key も singular)。

---

#### entity-mutations/bulk — `app/api/entity-mutations/bulk/route.ts` / `tests/contract/entity-mutations-bulk.contract.test.ts`

**error codes & HTTP statuses**

| code | status | notes |
|---|---|---|
| `unauthenticated` | 401 | route.ts:180 |
| `user_not_synced` | 401 | route.ts:187 |
| `invalid_json` | 400 | route.ts:195 |
| `invalid_payload` | 400 | route.ts:211 |
| `duplicate_mutation_id` | 400 | route.ts:206; `Retry-After` ヘッダなし(permanent error) |
| `transient_unavailable` | 503 | route.ts:343; `Retry-After: '30'` ヘッダ必須 |

**200-failed semantics** (§A #9): unknown entity_type / op / invalid patch は per-mutation `failed[]` + HTTP 200(envelope 400 ではない)。

```json
{ "ok": true, "applied": 0, "failed": ["<mutation_id>"] }
```

**skipLog delete** (§A #10): `card.delete` / `tag_category.delete` / `tag_option.delete` は `applied` カウント + `entity_mutations` テーブルへの INSERT なし。

**success response shape**: `{ "ok": true, "applied": N, "failed": [] }`

**op inventory** (9 pairs, `lib/sync/server/entity-mutation-registry.ts`):

| entity_type | op | skipLog | cascadeLike |
|---|---|---|---|
| card | update_field | false | false |
| card | create | false | true |
| card | delete | true | true |
| tag_category | update_field | false | false |
| tag_category | create | false | false |
| tag_category | delete | true | true |
| tag_option | update_field | false | false |
| tag_option | create | false | false |
| tag_option | delete | true | true |

---

#### review-events/bulk — `app/api/review-events/bulk/route.ts` / `tests/contract/review-events-bulk.contract.test.ts`

**error codes & HTTP statuses**

| code | status | notes |
|---|---|---|
| `unauthenticated` | 401 | route.ts:468 |
| `user_not_synced` | 401 | route.ts:476 |
| `invalid_json` | 400 | route.ts:502 |
| `invalid_payload` | 400 | route.ts:507 |
| `session_upsert_failed` | 503 | route.ts:571; `Retry-After: '30'` ヘッダ必須 |

**success response shape**: `{ "ok": true, "failed": [] }`

**凍結 DB 書込値** (§A #7, #8):
- `answer_events` INSERT に rating 列なし (`ratingPresent: false` golden 固定)
- `reviews.rating` / `study_days.correct_count` は `deriveRating` (route.ts:104-106) 経由で導出
- `correct_count = rating >= 2`(is_correct でない) — 乖離ケース: rating=3 + is_correct=false → correct_count=1
- `study_days.day` = JST date 文字列 (route.ts:377 `todayInJst`)

---

#### upload — `app/(app)/app/upload/_actions/process.ts` / `tests/contract/upload-result.contract.test.ts`

**11 error codes** (process.ts:73-84):

`AUTH` / `INVALID_INPUT` / `EXAM_NOT_FOUND` / `UPLOAD_IN_PROGRESS` / `PAGE_LIMIT_EXCEEDED` / `SIZE_LIMIT_EXCEEDED` / `QUOTA_EXCEEDED` / `GEMINI_DAILY_LIMIT_EXCEEDED` / `GEMINI_FAILED` / `SAVE_FAILED` / `OTHER`

**`ProcessUploadResult` union shape** (process.ts:99-106):

```typescript
| { ok: true; data: ProcessResultData }
| {
    ok: false
    code: ProcessUploadErrorCode
    error: string        // user 向け文言
    details?: ProcessUploadErrorDetails
  }
```

**`revalidatePath` 常時発火** (process.ts:127-133): `finally` ブロックで `/app/upload` と `/app` を常時 revalidate。error return / throw のいずれでも発火する。

**upload multi-branch inventory** (Task 5 handoff; `tests/contract/upload-result.contract.test.ts` が根拠):

INVALID_INPUT — 3 branches:

| Branch | message | status |
|---|---|---|
| A: mode invalid / missing | `投入先が指定されていません` | FROZEN (representative) |
| B: mode=existing, examId なし | `既存の試験が選択されていません` | documented only — not frozen |
| C: files empty | `ファイルが選択されていません` | documented only — not frozen |

EXAM_NOT_FOUND — 2 branches, 両方 frozen:

| Branch | message | status |
|---|---|---|
| A: found.length === 0 | `選択された試験が見つかりません` | FROZEN |
| B: archivedAt !== null | `アーカイブ済の試験には追加できません` | FROZEN |

GEMINI_FAILED — 2 branches:

| Branch | message | status |
|---|---|---|
| A: OcrDeadlineError | `処理時間が長すぎました…` | documented only — not frozen |
| B: other Error | `混み合っているようです…` | FROZEN (representative) |

SAVE_FAILED — 2 branches:

| Branch | message | status |
|---|---|---|
| A: cards INSERT / applyOcrTags throw | `抽出結果の保存に失敗しました` | FROZEN (representative) |
| B: completion tx failure | same message | skipped — identical message |

UPLOAD_IN_PROGRESS — 2 branches:

| Branch | message | status |
|---|---|---|
| A: advisory xact lock fails | `処理中の OCR があります…` | FROZEN (representative; contract.test.ts:415) |
| B: in-flight row check | same message | skipped — identical message |

---

#### webhook stripe — `app/api/webhooks/stripe/route.ts` / `tests/contract/webhook-stripe.contract.test.ts`

**frozen HTTP responses**

| body text | status | trigger |
|---|---|---|
| `'missing stripe-signature'` | 400 | signature header absent (route.ts:25) |
| `'invalid signature'` | 400 | `constructEvent` throws (route.ts:34) |
| `'duplicate'` | 200 | duplicate event_id (route.ts:47) |
| `'ok'` | 200 | unknown / unsupported event type (route.ts:52) |
| `'handler error swallowed'` | 200 | outer catch (route.ts:64) |

**status matrix — users UPDATE extracted values** (§A #14):

| Stripe status | subscriptionStatus | plan |
|---|---|---|
| `active` | `'active'` | resolved from price_id |
| `trialing` | `'active'` | resolved from price_id |
| `past_due` | `'past_due'` | preserved(NOT downgraded) |
| `unpaid` | `'past_due'` | `'free'`(§A #14 非対称) |
| `incomplete` | `'past_due'` | `'free'` |
| `canceled` | `'canceled'` | `'free'` |
| `incomplete_expired` | `'canceled'` | `'free'` |

**frozen added events**: `checkout.session.completed`(subscription retrieve + plan sync), `invoice.payment_failed`(notifyOps のみ / DB plan/status 変更なし), `subscription_schedule.released`(scheduled 3 cols を null クリア), unknown event → HTTP 200 `'ok'`。

---

#### webhook clerk — `app/api/webhooks/clerk/route.ts` / `tests/contract/webhook-clerk.contract.test.ts`

**frozen HTTP responses**

| body text | status | trigger |
|---|---|---|
| `'missing svix headers'` | 400 | svix headers absent (route.ts:60) |
| `'invalid signature'` | 400 | `svix.verify` throws (route.ts:74) |
| `'ok'` | 200 | schema parse fail / unsupported event type (route.ts:92, 115) |
| `'duplicate'` | 200 | duplicate event_id (route.ts:106) |
| `'handler error swallowed'` | 200 | outer catch (route.ts:126) |

**user.deleted frozen contract** (§A #15):

- users soft delete: `email=null`, `clerkId=null`, `deletedAt` set; `stripeCustomerId` は **変更しない**
- 10 child-table 明示 DELETE (Group I, route.ts:245-248):
  `exams` / `study_days` / `contact_messages` / `ai_usage_users` / `upload_records` / `user_settings` / `study_sessions` / `tombstones` / `entity_mutations` / `tag_categories`

**stale comment handoff** (§A note 3 / Task 8 deferred):
`app/api/webhooks/clerk/route.ts:242` の集約 header コメントが "8 テーブル" と記述しているが、実際の凍結契約は **10** child-table DELETE (route.ts:245 が "Group I … 10 件" と正しく記述し、実 DELETE は 10 件)。コメントは P0 の dead-sweep 対象外として意図的に修正せず残置。修正対象: clerk route を触る後続 phase(当該コメント行のみ修正、挙動変更なし)。契約値(10)は正しく golden 固定済。

---

### (ii) Dexie schema v1〜7 stores 定義文字列

`lib/client-db.ts` (lines 243-310) の `.stores({...})` 定義文字列をそのままコピー。P0 は Dexie に一切触らないが、後続 phase が store 移動を行う際の差分基準として記録する。

```
v1 (lib/client-db.ts:243-252)
  exams:           'id, user_id, updated_at, content_version'
  cards:           'id, exam_id, user_id, due, updated_at, content_version, sync_status'
  user_settings:   'user_id'
  study_sessions:  'session_id, exam_id, mode, status, sync_status'
  answer_events:   '++local_id, event_id, session_id, card_id, sync_status'
  card_mutations:  '++local_id, mutation_id, card_id, sync_status'
  sync_meta:       'key'

v2 (lib/client-db.ts:255-257) — S-perf-3: study_days mirror 追加
  study_days:      '[user_id+day], user_id, day'

v3 (lib/client-db.ts:263-267) — S-sync-1: card_mutations → entity_mutations rename
  card_mutations:  null  (drop)
  entity_mutations:'++local_id, mutation_id, [entity_type+entity_id], sync_status'

v4 (lib/client-db.ts:271-274) — Tag-1: tag mirror 追加
  tag_categories:  'id, user_id, updated_at'
  tag_options:     'id, user_id, category_id, updated_at'

v5 (lib/client-db.ts:282-284) — Tag-2b: card_tags junction 追加
  card_tags:       '[card_id+option_id], card_id, option_id, user_id'

v6 (lib/client-db.ts:294-297) — Y-2 T-B4: [user_id+exam_id] compound index 追加
  cards:           'id, exam_id, user_id, due, updated_at, content_version, sync_status, [user_id+exam_id]'

v7 (lib/client-db.ts:307-310) — Y-2 T-B6/B7: [user_id+due] compound index 追加
  cards:           'id, exam_id, user_id, due, updated_at, content_version, sync_status, [user_id+exam_id], [user_id+due]'
```

DB name: `'recallmint'` (lib/client-db.ts:242)。現在の current version = **7**。

---

### (iii) 既存 route test と contract test の役割分担

二重メンテナンス混乱を防ぐため、両テスト群の責務境界を明示する。

**既存 co-located route tests** (+ process.test.ts):

| file | 責務 |
|---|---|
| `app/api/pull/route.test.ts` | control-flow: auth guard, user=null 分岐, DB error パス |
| `app/api/entity-mutations/bulk/route.test.ts` | control-flow: validation分岐, skipLog, registry lookup, partial-fail |
| `app/api/review-events/bulk/route.test.ts` | control-flow: session upsert, event処理, duplicate skip, orphan |
| `app/api/webhooks/stripe/route.test.ts` | control-flow: signature検証, event dispatch, status matrix |
| `app/api/webhooks/clerk/route.test.ts` | control-flow: signature検証, user.deleted 10 DELETE 網羅性 invariant |
| `app/(app)/app/upload/_actions/process.test.ts` | control-flow: 11 error code 分岐, advisory lock, pipeline mock |
| その他 route.test.ts (dashboard / study-days / exams/status) | 各 route の control-flow / local invariants |

役割: **分岐の正しさ・local invariant の保証**。DB mock を細粒度で制御し、どの branch が走るかを検証する。wire body の厳密な形や複数副作用の組み合わせは対象外。

**新設 contract tests** (`tests/contract/*.contract.test.ts`):

| file | 責務 |
|---|---|
| `tests/contract/pull.contract.test.ts` | wire body: 6 stream keys + cursor 形 + Cache-Control |
| `tests/contract/entity-mutations-bulk.contract.test.ts` | wire body: error code 文字列 + 200-failed envelope + DB write values(extracted) |
| `tests/contract/review-events-bulk.contract.test.ts` | wire body: success envelope + DB write values(rating derive / study_days) |
| `tests/contract/upload-result.contract.test.ts` | wire body: ProcessUploadResult union + revalidatePath 常時発火 |
| `tests/contract/webhook-stripe.contract.test.ts` | wire body: text response 文言 + status + status matrix DB values |
| `tests/contract/webhook-clerk.contract.test.ts` | wire body: text response 文言 + 10 DELETE count + soft delete values |

役割: **client が依存するワイヤー形(JSON body / text body / headers)と代表的な副作用(DB write values)の snapshot 固定**。`toMatchSnapshot()` で golden 化し、DDD リファクタが wire を壊した瞬間に検出する。

**役割分担の要点**:
- route.test.ts は「この branch が走るか」を検証する — branch exhaustive coverage
- contract test は「wire が何を返すか」を snapshot する — representative superset
- branch の追加・削除は route.test.ts を更新する。wire shape の変更は contract test の snapshot を更新する
- 同じ assert を両方に書かない(重複メンテ禁止)。route.test.ts が持つ control-flow assert を contract test に再掲しない

---

### (iv) lint allowlist per-file off 副作用 + 削減期限

(Task 7 実装 / `eslint.config.mjs` の 4 allowlist override blocks が根拠)

**4 ファイルへの `'no-restricted-imports': 'off'` override**:

| file | 理由(P0 時点での違反) |
|---|---|
| `lib/cards/get-custom-session-cards.ts` | Block A 違反: lib から app への import |
| `components/marketing/contact-form.tsx` | Block A 違反: components から app への import |
| `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx` | Block B 違反: 3 段以上の相対 import (`../../../**`) |
| `app/(app)/app/upload/result/[sourceDocumentId]/page.tsx` | Block B 違反: 3 段以上の相対 import |

**副作用**: `'no-restricted-imports': 'off'` はその file の `no-restricted-imports` ルール**全体**を無効化する(特定 pattern だけでなく)。P3 が app-to-app cross-feature import に対して `no-restricted-imports` の新 config block を追加しても、この 4 file にはそのルールが適用されない。

**削減期限 = P3**: 各違反の根本修正(lib への述語抽出 / `@/` alias への置換)を行い、修正完了後に `'off'` override を除去する。除去後は P3 で追加した cross-feature ルールが正しく適用される。

---

### (v) 未 cover の app 内境界の実リスト

(現 HEAD 再スキャン 2026-07-06)

P0 の lint (Block A: lib/components→app 禁止 / Block B: `../../../**` 深相対禁止) は `app/(app)/app/` 内のアプリ機能間 cross-feature import を捕捉しない。これらは P3 の allowlist 化の基点リストとして記録する。

**機能間 cross-feature imports (feature A → feature B の private namespace)**:

1. `app/(app)/app/study/custom/_components/custom-filter-form.tsx:15`
   - `import { CardTagAddPopover } from '@/app/(app)/app/exams/[id]/_components/card-tag-add-popover'`
   - study → exams `_components`(cross-feature コンポーネント流用)

2. `app/(app)/app/study/custom/_components/custom-filter-form.tsx:21`
   - `import type { TagFilterValue, AnswerStateFilter, ... } from '@/app/(app)/app/exams/[id]/_lib/card-filter-predicates'`
   - study → exams `_lib`(cross-feature 型依存)

3. `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx:26`
   - `import { ColorPalettePopover } from '@/app/(app)/app/tags/_components/color-palette-popover'`
   - exams → tags `_components`(cross-feature コンポーネント流用)

4. `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx:27`
   - `import { DeleteConfirmDialog } from '@/app/(app)/app/tags/_components/delete-confirm-dialog'`
   - exams → tags `_components`(cross-feature コンポーネント流用)

**機能内の逆方向依存 (`_lib` → `_components`)**:

5. `app/(app)/app/exams/[id]/_lib/column-pinning.ts:6`
   - `import { examCardTableColumns } from '../_components/exam-card-table-columns'`
   - `_lib` → `_components` の逆方向(通常は `_components` が `_lib` に依存する)
   - 設計上の意図: 列順の SSoT を `examCardTableColumns` に一元化するための "columns as data" パターン。pinning 導出に UI 依存はなく、列 id 配列のみを参照する(column-pinning.ts:8-12)。

**P3 での対処方針**: 各 import を ESLint `no-restricted-imports` allowlist に追加して可視化し、将来の機能境界強化時に段階的に解消する。~~`custom-filter-form.tsx:15,21` は `card-filter-predicates` を lib/ に移動することで解消可能。~~ → **P1 Task5(commit 1196a68)で `card-filter-predicates.ts` を `lib/cards/` へ移動し、この lib→app 逆依存は解消済**(get-custom-session-cards の allowlist entry も削除)。上記 5 件のうち **app 内 cross-feature 依存(study/custom→exams・exams→tags・`_lib`→`_components`)は P3 の surface として未対処のまま残る**。

---

## §B (vi) develop merge 後の初回 stg smoke 対象(申し送り)

**背景**: dddrefactor branch は phase ごとの個別 stg smoke を**省略**している。理由 = 各 phase が挙動不変(behavior-preserving)であり回帰検知は P0 golden + 既存 co-located test + build green が担保する / stg 環境が dddrefactor に無い(develop/main にのみ deploy)。方針(SSoT 2026-07-07 OT 判断)により **develop/main への反映は全 phase(P0〜P4)完了後に OT 判断** → その merge → stg 反映の時点で、各 phase が触った surface を**まとめて smoke** する。本節はその「まとめ smoke」の対象リスト。**以降の phase も、触った surface をここに追記していく**(各 phase 完了時に CC が更新)。

**まとめ smoke の位置づけ**: 挙動不変前提の refactor ゆえ「新機能検証」でなく「移設・再編で意図せず壊れていないかの回帰確認」。P0 golden が緑でも捕捉しない UI/実挙動(表示順・描画・実 IDB 経路・実決済画面)を DevTools MCP(chrome-devtools / playwright)で確認する。CC で届かない条件(実決済実行・物理 mobile 等)のみ OT。

| phase | 触った surface | smoke 観点(まとめ時) |
|---|---|---|
| P0 | (安全網構築のみ・挙動不変・UI surface なし) | 個別対象なし(contract golden が回帰の正) |
| P1 | **タグ表示順**(compareTagEntry: exams カードのタグセル / タグ popover / カード詳細のタグ節)/ **streak・today count**(dashboard の streak 数値)/ **exam status**(試験一覧の processing/failed バッジ)/ **custom session 選定**(study/custom のフィルタ→出題・preview==session の乱数一致)/ **決済 upgrade page**(/app/upgrade の pending/schedule 表示・upgrade/downgrade 判定) | 各 surface が P1 前と同一挙動か: タグ並びが sort_key 順維持 / dashboard streak 数値一致 / バッジ表示一致 / custom session の絞り込み・順序・件数一致 / upgrade 画面の表示と判定一致(**実決済実行は不要=表示・分岐のみ**、実課金は OT) |

**注記**: P1 は pure 層の移設のみで wire/契約(payload・error code・文言・revalidatePath 等)を一切変えていない(D-2 凍結契約不変・最終 whole-branch review で確認済)。ゆえに上記 smoke は「表示・並び・数値の同一性」確認が主で、契約面は P0 golden が既に担保している。
