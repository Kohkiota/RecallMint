# F2: Session aggregate(StudySession + AnswerEvents)— design spec

- 日付: 2026-07-09 / branch `develop` / 前提 HEAD: fact-finding 時 `6cd468a`(着手時に再スキャン)
- 入力: `docs/audit/2026-07-09-f2-session-factfinding.md`(10f6b5a)+ OT/claude.ai 確定 4 判断(下記・**再議論しない**)
- 位置づけ: 完全 DDD の F2(意図 doc `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` §5)。型 = F1 spec(`docs/superpowers/specs/2026-07-08-f1-subscription-aggregate-design.md`)を踏襲。**F1 との構造差分 = 2 書込点を跨ぐ aggregate seam(§3.4)** — ここだけ F1 の型をコピーできないため本 spec の重点。

---

## 1. 確定判断(spec の前提・固定)

1. **②status 遷移ガード = (b)状態後退のみ拒否**。session 行 status の後退遷移(completed→active 等)だけ弾き、**正当な遅延 flush(状態を後退させない event の遅延到着)は通す**(A-2 の「正当操作を弾かない」型)。時間窓(magic number)不採用・検知のみ(c)不採用 = 窓を閉じる。F2 の隔離 commit(phase W)で埋める。
2. **③b(is_correct 再計算)= F3 帰属**。deriveRating は P0 凍結契約(`docs/audit/2026-07-06-p0-contract-baseline.md` §A #7)ゆえ F2 で触れない。F2 の挙動変更は②のみ。
3. **aggregate 境界 = 2 書込点(route Phase 0 の session 行 / processSession の event/replay)両方を aggregate 経由に寄せる**。両方寄せて初めて session 状態規則が aggregate 不変条件として閉じる(片方だけだと status ガードが aggregate 外に漏れる)。
4. **golden 先張り = ②期待値筆頭**。ただし②は挙動変更ゆえ「現挙動 pin」でなく「②導入後の期待値 pin」を **W commit と対で**置く(G には置かない)。G は R が触る経路の現挙動固定(status 遷移の不変部分 + I-1/C-1 の behavioral 化)。不変条件 1/3/4/5/6 は二重 pin 済(fact-finding Step 5)ゆえ追加は薄く。

環境前提: **zero users(prod 含む)・migration 一切不要**。本 spec は **schema 変更ゼロ**(status text 列に CHECK を足さない — trigger/CHECK ゼロの既存方針維持、ガードは application 層 = A-2 と同じ置き方)。

### 用語(本 spec 内)

- **後退遷移** = terminal(completed / abandoned)から**別値**への status 書換え。active への巻き戻しに加え terminal 間の横滑り(completed↔abandoned)も含む(§6.1)。
- **正当な遅延 flush** = completed/abandoned 済み session への answer_event の遅延到着。**status を後退させない限り無条件で通す**(event 側は session status を見ない — 確定判断 1 の帰結)。

## 2. スコープ / やらないこと

**やる**: Session domain 層新設(VO 1 + 純粋関数群)/ 意図別 repository / processSession・route Phase 0 の配線置換(挙動不変)/ golden(G2-G5)+ test fake の upsert 意味論強化(G1)/ ②status ガード(W・隔離 commit)/ import 境界 lint 拡張。
**やらない**: ③b is_correct 再計算(F3)/ client 側の一切(Dexie store・flush・runner — ルール二重実装ゼロゆえ非該当。wire payload shape / 2 Dexie store shape 不変)/ wire 契約変更(response `{ok, failed}` 200 / 400 / 503 + Retry-After = D-2 凍結)/ schema 変更 / `lib/cards/replay-card.ts` の移動(pure 済・domain から pure sibling import で足りる。ingest header の「最終形でない」残債は F4+ の bounded context 整理へ)/ selectedAnswerIds の uuid 化(Phase 4 帰属の既知残債)/ event admission への session status 参照(確定判断 1 で append 許容 — 使わない引数を足さない)。

## 3. 目標構造と file 配置(F1 の lib/stripe/domain/ 踏襲)

```
lib/reviews/
  domain/                         ← 新設(純粋層)
    session-values.ts             ← VO: SessionStatus + 遷移規則(§3.1)
    session-aggregate.ts          ← event admission / replay 計画・実行 / JST 集計 / deriveRating(§3.2)
  session-repository.ts           ← repository(infra。drizzle over study_sessions / answer_events /
                                     reviews / cards(replay slice)/ study_days)(§3.3)
  ingest-review-events.ts         ← orchestrator に縮退(tx 境界 + 順序 + failed[] 組立 + zod schema)
app/api/review-events/bulk/route.ts ← Phase 0 を repository 経由に置換(§3.4。auth / error 分類は現状維持)
lib/cards/replay-card.ts          ← 既存維持(pure。domain から import — pure sibling 許容)
```

**import 純度**: `lib/reviews/domain/*` は runtime import ゼロ原則、pure sibling(`lib/cards/replay-card` / `lib/jst` / `lib/fsrs` 型)のみ許容。**zod 非依存** — domain は最小 structural 型(`AnswerEventInput` 等)を自前定義し、ingest の zod infer 型(ParsedEvent)が構造的に適合する形(F1 の「resolver 注入で env 依存ゼロ」と同じ純度思想)。drizzle / next / logger / lib/db 不可。P0 lint 機構に enforce ルール追加(F1 R4 前例・独立 commit 可)。

### 3.1 VO(1 つのみ・YAGNI)

**SessionStatus + 遷移規則**(`session-values.ts`):

- `type SessionStatus = 'active' | 'completed' | 'abandoned'`(schema $type と同値)。
- `canApplyStatusWrite(current: SessionStatus, incoming: SessionStatus): boolean` — **遷移規則の唯一の定義**:
  - `current === 'active'` → 常に true(前進・abandoned 化・active 再送すべて)
  - `current` が terminal → `incoming === current` のみ true(冪等再送)
  - それ以外(terminal→別値)→ false = **後退遷移**
- fresh insert(既存行なし)は遷移概念なし = ガード対象外(規則は conflict 時のみ)。
- **completed_at の規則**(status と別に明示 — Codex 指摘採用): completed_at は set 節ごと status ガードに従属する。ガード通過時(same-status 再送含む)は**現行どおり LWW**(payload 値で更新)、ガード不発時は status とともに保護(null 上書き・巻き戻し不可)。「terminal timestamp の初回凍結」までは踏まない(挙動変更は②status のみ — 確定判断 1 の scope。将来変えるなら別 spec)。`active→abandoned` の completed_at は現行どおり payload 依存(client の abandon は completed_at を送らない → null。`abandoned_at` 列は追加しない — schema 変更ゼロ)。

rating / selected_answer_ids は VO 化しない(rating は既に `RatingInt` 型 + deriveRating 関数で足りる / selected_answer_ids の締め直しは Phase 4 残債)。F1 の「VO は確定最小のみ」を踏襲。

### 3.2 aggregate(`session-aggregate.ts`・全 pure)

Session aggregate = 「session 行の状態規則」+「event 処理の不変条件」の単一 domain module。関数群(F1 同様 class にしない):

- `buildCardOptionIndex(rows: {id, options: unknown}[]) → Map<cardId, Set<optionId>>` — options jsonb の正規化(**malformed 要素の element 単位握り潰し** ingest:159-175)。fail-closed 挙動が domain test で直接見えるよう repo でなく domain に置く(Codex 指摘採用 — repo で Set 化すると A-2(e) の握り潰し挙動が domain の外に隠れる)。repo は raw rows を返すだけ。
- `admitEvents(events, knownCards: Map<cardId, Set<optionId>>) → { applicable, rejected: eventId[] }` — 不変条件 #2(orphan)+ #7(A-2 存在検証)の統合 admission。現ロジック(ingest:179-196)を verbatim 移設。rejected は event_id の flat 配列 — 現 wire `failed[]` と同形(reason enum は wire に出す先がなく YAGNI — Codex 対立論点への回答)。
- `planReplay(applicable, insertedEventIds: Set) → Map<cardId, AnswerEventInput[]>` — 不変条件 #1 の replay gating(inserted のみ)+ intra-payload dedup(consumedSet)+ #3 の payload 順 per-card group(ingest:225-255 verbatim)。
- `replaySession(cardStates: Map<cardId, ReplayCardState>, groups) → { finalStates, reviewRows }` — replayCard fold + zip(ingest:257-274 verbatim。replayCard は pure sibling import)。
- `aggregateStudyDays(eventsToApply) → Map<day, {total, correct}>` — 不変条件 #5 の JST 集計 core(ingest:357-366 verbatim。todayInJst は pure sibling)。distinct 集計 SQL は repository(§3.3)。
- `deriveRating(ev) → RatingInt` — verbatim 移設(P0 §A #7 凍結契約。**挙動・シグネチャ不変**)。

**判断 3 の構造**: session 行 status を書く経路は repository の `upsertSessionGuarded` のみで、その許否は `canApplyStatusWrite`(domain 定義)に従う。event 側の許否は `admitEvents` のみが決める。**session 状態規則と event 規則が同一 domain module に同居** = 2 書込点の規則が 1 箇所で読める(将来 F3 で event 側が session 状態を参照する時も seam 追加不要)。

### 3.3 repository(`session-repository.ts`)

`DbExecutor` 型(tx/db 両対応・既存 apply 関数群と同形)。意図別メソッド(単一汎用口にしない — F1 判断踏襲):

- `loadCardReplayStates(userId, cardIds) → rows` — Phase 1 SELECT(owner-scoped WHERE verbatim)。
- `insertAnswerEvents(rows) → insertedEventIds` — ON CONFLICT DO NOTHING + returning(冪等の執行点)。
- `insertReviews(rows)` / `applyCardFinalStates(userId, finalStates) → void`(VALUES UPDATE + **count-mismatch throw を内包** — RETURNING 件数検査は storage 整合性検査 = repo 責務。挙動 verbatim)。
- `upsertStudyDays(userId, dayMap)` — distinct 集計 SELECT + per-day UPSERT(verbatim)。
- `upsertSessionGuarded(user, session) → { applied: boolean }` — Phase 0 upsert。R 時点は現行 verbatim(setWhere = tenant のみ)、**W で遷移ガード追加**(§6.2)。**repository は logger を呼ばない**(observability は呼び出し側 = route の責務。infra と観測の分離 — Codex 指摘採用)。`applied: false` は**正常系**であり error 分類(classifyBulkError)に流さない — route は logger.warn にのみ使い response は不変。

**owner-scope 絶対則**: 全 query の WHERE(user_id / setWhere)を verbatim 維持。

### 3.4 2 書込点 seam(★F1 との構造差分・本 spec の核心)

F1 は書込が射影 use-case 1 本に集約できた。F2 は **2 書込点が異なる tx・異なる error 契約を持つ**ため 1 本化できない(統合すると wire 挙動が変わる — 下表の失敗系が D-2 で凍結されているため**分離維持が正**):

| 書込点 | tx | 失敗時 wire(凍結) | aggregate 経由の形 |
|---|---|---|---|
| **Phase 0**(session 行) | 単文 upsert(events tx 外) | 503 + Retry-After(transient)/ 400(permanent)・**events 未処理** | route → `repo.upsertSessionGuarded`(許否規則 = `canApplyStatusWrite`) |
| **Phase 1-2**(events/replay/read model) | 単一 tx | 200 + `failed[]`(rollback で applicable 全滅) | ingest(orchestrator)→ domain 関数群 + repo メソッド |

- **route の責務** = auth / zod parse / Phase 0 呼出 + error 分類(classifyBulkError)/ processSession 呼出 / response 組立 — 現行のまま。**Phase 0 用の独立 use-case file は作らない**(1 メソッド呼ぶだけ・YAGNI — CC 判断点 4)。
- **ingest の責務** = tx 境界 + 実行順序 + failed[] 組立 + zod schema 定義。規則本体は domain へ、SQL は repo へ。
- **遷移規則の二層**(CC 判断点 3): 規則の**定義**は `canApplyStatusWrite`(pure・単体 test)、**執行**は `upsertSessionGuarded` の SQL 述語(単文 ON CONFLICT の setWhere 拡張 — §6.2)。read-modify-write にしない(round-trip 追加 + TOCTOU を避け、現行の単文性を保つ)。二層の等価性担保は分担明示: (i) test fake の upsert simulation は `canApplyStatusWrite` **そのもの**を使う = TS 定義が unit/golden の単一の正(定義と test 正のズレを構造的に排除)(ii) SQL 述語の実 DB 挙動は **stg smoke item**(§8 完了条件 4)で検証(unit は fake 経由ゆえ SQL を直接叩けない — 既存 test 方針の制約を正直に記録)。

## 4. Phase 構成 = commit 境界(安全網先行順序・固定)

| phase | commit | 内容 | 挙動 |
|---|---|---|---|
| **G** | `test(reviews): F2 golden 先張り(G1-G5)`(1 commit) | §5。test fake 強化 + 現挙動 pin | 不変(test 追加のみ) |
| **R** | `refactor(reviews): …`(R1-R3 の 3 commit 提案 + lint 独立 commit。plan で確定) | §3 の抽出・配線置換。**golden/snapshot 更新ゼロ = 挙動不変の客観証明** | 不変 |
| **W** | `fix(reviews): reject session status regression(②)`(単独 commit・**TAG 無し**) | §6。②期待値 test 同梱 | **変更(隔離)** |

- R 分割提案(plan で確定): R1 = domain 抽出(additive・配線なし)/ R2 = repository 新設 + processSession 配線置換(risk)/ R3 = route Phase 0 配線置換(risk)/ R4 = import 境界 lint(独立 commit)。F1 R3a/R3b と同じ「配線置換 = risk task 分割」の粒度。
- R で golden が赤 → 即停止。golden を修正して通す行為は禁止(P0〜P4 と同じ規律)。
- W はデータ保全系の重要 fix → review pass → **TAG 無し commit** → stg smoke(push 後)。**[reviewed] の正記録は session doc**(恒久規律 6cd468a: push→smoke 順で amend 窓が構造的に閉じるため。force-push しない)。

## 5. Phase G: golden 先張り(5 本)

fact-finding Step 5 の gap(status 遷移 = 完全未 pin / I-1・C-1 = shape のみ / permanent-4xx = 無 test)から、**R が触る経路で W 後も不変な現挙動**を pin する:

| # | 置き場 | 内容 | 塞ぐ gap |
|---|---|---|---|
| G1 | `tests/fixtures/review-events.ts` | **test fake の upsert 意味論強化**: makeFakeDb の onConflictDoUpdate が conflict 行 merge を実際に模す + upsert chain の `.returning()` 対応(現状 args 捕捉のみ・既存 mock chain への影響範囲は plan で棚卸し — Codex 指摘採用)。guard 述語の simulation は W 時点で `canApplyStatusWrite` を直接使う設計(§3.4 (i))— sql fragment の解釈器は書かない。G2-G4 と W の遷移 test の前提能力 | mock が ON CONFLICT を模さない(fact-finding Step 5 gap 2-3) |
| G2 | `app/api/review-events/bulk/route.test.ts` | **前進遷移の現挙動 pin**: active→completed(status + completed_at 値 assert)/ active→abandoned(completed_at null のまま)/ completed→completed **同一 payload** 再送(値不変)/ completed→completed **異 completed_at** 再送(**LWW 更新 = 現行挙動**。§3.1 の completed_at 規則を pin — Codex 指摘採用)。**W 後も不変な部分のみ**(後退素通りは pin しない — 確定判断 4) | status 遷移 = 完全未 pin |
| G3 | 同上 | **I-1 behavioral**: 再送 payload の card_ids 差替え → 保存値不変(shape assert から挙動 assert へ) | I-1 shape のみ |
| G4 | 同上 | **C-1 behavioral**: 他 user の session_id 衝突 POST → UPDATE no-op(status 不変) | C-1 shape のみ |
| G5 | 同上 | Phase 0 `permanent-4xx` → 400 分岐 pin(route.ts:140) | 無 test 分岐 |

既存 42 test(route 30 + contract 12)+ G1-G5 が R の回帰の正。**「更新禁止対象」= 既存 golden/snapshot 全部 + G 追加分**(R では凍結。W は②期待値 test を新規追加するのみで G2-G5 は不変のまま通ることが W の非退行証明)。

## 6. Phase W: ②status 遷移ガード(唯一の挙動変更・隔離 commit)

### 6.1 遷移表(canApplyStatusWrite の全域)

| 既存行 status | payload status | 判定 | 根拠 |
|---|---|---|---|
| (行なし) | any | INSERT(ガード外) | fresh insert に後退概念なし |
| active | active / completed / abandoned | **許可** | 前進 + active 冪等再送 |
| completed | completed | **許可** | 冪等再送(client retry の正常経路) |
| completed | active | **拒否** | 後退(audit ②の巻き戻しシナリオ) |
| completed | abandoned | **拒否** | terminal 凍結(CC 判断点 1) |
| abandoned | abandoned | **許可** | 冪等再送 |
| abandoned | active / completed | **拒否** | 後退 / terminal 凍結 |

**terminal 凍結の根拠**(CC 判断点 1): 「session の帰結は一度確定したら不変」が最も単純な不変条件。複タブの complete/abandon 競合を LWW にせず先着確定にする。rank 案(terminal 同格で横滑り許容)は「後退」の定義に曖昧さを持ち込む割に許す実益がない(abandon の UI 配線は現状不在 — fact-finding Step 2)。**確定判断(b)との整合**(Codex 指摘採用・明示): (b) は「後退**のみ**拒否 = 前進と冪等再送は必ず通す」の意で、「後退」の外延(terminal 間横滑りを含むか)は本 spec が定義する具体化領域。terminal 凍結は (b) の範囲内の最単純解であり、将来「completed→abandoned の訂正」を許したくなったらそれは仕様追加(別 spec)— 現時点でその要求は存在しない(YAGNI)。

### 6.2 執行(upsertSessionGuarded・W での変更)

- 現行 `setWhere: eq(userId)` を拡張: `userId 一致 AND (既存 status = 'active' OR 既存 status = excluded.status)`。**単文 ON CONFLICT DO UPDATE を維持**(read-modify-write にしない — §3.4)。`excluded` 参照は Drizzle API で表現困難なら raw sql fragment 許容(repository = infra 層で lint 制約外。具体表現は plan で確定 — Codex 指摘採用)。
- **拒否 = set 節全体の不発**(status だけでなく completed_at の巻き戻し(null 上書き)も同時に防がれる)。card_ids は従来どおり insert-only(I-1 不変)。
- **検知**: `.returning()` を追加し、**conflict かつ 0 行 = ガード不発(clamp)または tenant 不一致** → route が `logger.warn`(event: `review_events.session_upsert_blocked`、sessionId / userId / 送信 status を含む)。**両者を 1 event に束ねる理由**(Codex 指摘への回答): 区別には現 status の追加 SELECT が要り単文性を壊す。「書かなかった」事実と調査キー(sessionId で DB を引けば現 status / owner が判明)は共通で、tenant 衝突は uuid 推測を要する極レア系 — warn の分岐に値しない。notifyOps は使わない(自 user データ内の事象)。現行 C-1 の silent no-op が warn 化されるのは observability の追加であって wire 不変。
- **events への波及ゼロ**: clamp されても Phase 1-2 は通常続行(event は failed に入らない・FSRS 適用される)= **正当な遅延 flush の非弾き**(確定判断 1)。processSession は W で不触。

### 6.3 wire 契約(D-2)の保存

- response は常に現行どおり: 200 `{ok: true, failed}` / 400 / 401 / 503 + Retry-After。**clamp は wire 非表出**(CC 判断点 2)。新 status code(409 等)を導入しない — client の retry 分類(classifyBulkError 対向)に触れず、client 改修ゼロ。
- client との整合: sessions は pull-back されない(fact-finding Step 2)ため、stale tab の Dexie が active のままでも server 正(completed 維持)と矛盾が表面化する経路がない。divergence は無害。

### 6.4 非真空 test(実際に後退遷移を起こす・W commit に同梱 = ②期待値 pin)

1. completed 済み行へ active payload 再送 → **保存 status='completed'・completed_at 維持**(値 assert)。
2. completed → abandoned → 拒否(terminal 凍結)。
3. abandoned → active → 拒否。
4. active → completed → 通る(G2 と同値の非退行確認)。
5. completed → completed 再送 → 通る(冪等)。
6. **clamp 発生時に同 payload の events が通常処理される**(failed に入らない・answer_events INSERT + FSRS 適用を assert)= 遅延 flush 非弾きの実証。
7. clamp 時 `logger.warn` 1 回(event 名 assert)。
8. wire: clamp 時も response 200 `{ok: true, failed: []}`(D-2 面の直接 pin。**contract test file に置く** — wire 契約は contract 側が正の置き場・Codex 指摘採用)。

手順注記(確定判断 4「②期待値筆頭」の W 内実現): W commit 内で test 1-8 を**先に書いて赤を確認 → ガード実装で green**(TDD)。G に置かないのは「W 前は赤 = R の gate を汚す」ため — 期待値 pin の先行性は W 内の test-first で担保する(Codex 指摘採用・表現明確化)。

## 7. 制約(全 phase 共通)

- **D-2 凍結 wire 不変**: `{ok, failed}` 200 / 400 / 401 / 503 + Retry-After・部分失敗ポリシ(orphan/A-2 → failed[]・tx 失敗 → applicable 全滅 200)に一切触れない。
- **P0 凍結契約**: §A #1(answer_events に rating 列なし)/ #7(deriveRating・correct_count = rating>=2)/ #8(JST day)を R で変えない(既存 golden が pin)。
- **owner-scope 絶対則**(CLAUDE.md Clerk 3): repository の全 query が現行 WHERE を verbatim 維持。
- **processSession の公開 API 不変**(Codex 指摘採用): シグネチャ(db, user, session, events)・戻り値 `{failed: string[]}`・failed[] の構成順(orphan/A-2 先・tx 失敗時は applicable 全滅を後結合)・duplicate は failed に入れない、を R で verbatim 維持(route から見た関数契約が回帰の正)。
- 簡潔性規律: VO 1 つのみ・使わない引数(event admission への status 参照等)を書かない・起きえない遷移の防御分岐を書かない。
- test 方針: 既存 mock 境界(fake db / fixtures)を維持。実 DB 禁止。

## 8. 完了条件

1. G/R/W の全 commit が §4 の境界で分離され、R は **golden・snapshot 更新ゼロ**で full test green。
2. whole-repo gate: `pnpm lint --max-warnings=0` / `typecheck` / `test`(full)/ `build` 全 exit 0(import 境界 lint 追加を含む)。
3. W の非真空 test 8 本 green。canonical + Codex review(risk = R2/R3 配線置換と W)で未解決 Critical 0 / Important 0。
4. W commit は TAG 無し → stg smoke(push 後 OT 指示)→ **[reviewed] 正記録は session doc**(恒久規律)。smoke item(SQL 述語の実 DB 検証を兼ねる — §3.4 (ii)): (a) 通常演習 1 周の非退行(complete → status='completed' 確認)(b) completed 済み session への stale active payload 再送(DevTools から fetch 再現)→ **実 DB で status='completed' 維持** + events 通常処理 (c) 同一 payload 再送の冪等。unit fake では SQL 述語を直接検証できないため、この smoke が二層等価性の実 DB 側の正(integration test 基盤の新設はしない — 既存 test 方針(全 fake)維持・YAGNI)。
5. client 側 diff ゼロ(lib/sync / client-db / runner 系 file 不触の確認)。

## 9. CC 判断点(4 確定の範囲内での具体化・OT veto 対象)

1. **terminal 凍結**(completed↔abandoned 横滑りも拒否。「後退のみ」の最小解釈 = rank 案より強いが、遷移表が全域で単純・先着確定)— §6.1。
2. **clamp = wire 非表出**(200 不変 + server log のみ。新 status code なし・client 改修ゼロ)— §6.3。
3. **遷移規則の二層**(domain pure 定義 + repository SQL 述語。単文 upsert 維持の帰結。等価性は W test が pin)— §3.4。
4. **Phase 0 の独立 use-case file を作らない**(route → repo 直。許否規則は domain 定義)— §3.4。

## 10. Codex cross-check 統合記録(帰属)

`docs/codex/2026-07-09-plan-f2-session-aggregate.md`(1 パス・独立論点・detector PASS)。CC spec との突き合わせ結果:

- **採用(spec に反映)**: ① completed_at の遷移規則明示(same-status LWW = 現行維持・ガード不発時は status とともに保護・§3.1)② G2 の completed→completed「値不変」pin の精密化(同一 payload と異 completed_at LWW の 2 面 pin — 現行挙動との一致を担保・§5)③ abandoned の completed_at 扱い明記(payload 依存 null・abandoned_at 列は追加しない・§3.1)④ malformed options 正規化(buildCardOptionIndex)を domain 関数化 — A-2(e) fail-closed が domain test で直接見える形(§3.2)⑤ terminal 凍結と確定判断 (b) の整合説明強化(「後退」の外延定義は spec の具体化領域・§6.1)⑥ upsertSessionGuarded の返り値扱い明確化(applied=false は正常系・error 分類に流さない・repo は logger を呼ばない・§3.3)⑦ tenant no-op / clamp を 1 warn event に束ねる理由の明文化(§6.2)⑧ W test #8(wire pin)を contract file に配置(§6.4)⑨ 「②期待値筆頭」の W 内 test-first 手順明確化(§6.4 注記)⑩ processSession 公開 API・failed[] 構成順の verbatim 維持を R 制約に明記(§7)⑪ G1 に `.returning()` chain 対応 + 既存 mock 影響の plan 棚卸しを明記(§5)⑫ stg smoke item の具体化 = SQL 述語の実 DB 検証を兼ねる(§8 完了条件 4)。
- **部分採用(plan へ委譲)**: Drizzle `excluded` 参照の具体表現(raw sql fragment 許容のみ spec で規定・§6.2)/ G1 の既存 mock chain 影響範囲の棚卸し。
- **不採用(理由記録)**: (i) admitEvents の rejected に reason enum — 現 wire failed[] は event_id flat 配列で理由フィールド不在(orphan/A-2 同列 vocabulary が現契約)・使い先がなく YAGNI(§3.2 註記)。(ii) 実 Postgres integration test 新設 — 既存 test 方針(全 fake)に基盤がなく新規 infra はスコープ外。実 DB 検証は stg smoke item で担保(§8)。(iii) spec から運用手順(commit/TAG)分離 — F1 spec の §4 前例踏襲(phase = commit 境界の定義は本プロジェクトの spec 責務)。
- **確認のみ(spec 変更不要)**: 1 tx 統合の回避(§3.4 で既対応)/ client divergence 許容の根拠(§6.3 で既対応)/ domain→replayCard の pure sibling 依存と lint 例外最小化(§3 で既対応)/ 意図別 repository の責務粒度(F1 型維持)。

## 参照

- fact-finding: `docs/audit/2026-07-09-f2-session-factfinding.md`(不変条件 7 / 2 書込点 / client mirror = write-only / test gap)
- F1 型: `docs/superpowers/specs/2026-07-08-f1-subscription-aggregate-design.md` / plan 同名(phase 構成・risk task 分割・§10/§11 の型)
- 契約: `docs/audit/2026-07-06-p0-contract-baseline.md` §A #1/#7/#8 / D-2(`docs/plans/2026-07-06-ddd-refactor-design-decisions.md`)
- ②の裏取り: `docs/audit/2026-07-08-server-invariant-verification.md` §②(遅延 flush 正当ケースの初出判定)
- 恒久規律: CLAUDE.md「stg smoke 要の重要 Fix は session doc を [reviewed] 正記録とする」(6cd468a)
