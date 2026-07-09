# F2: Session aggregate — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(fresh subagent per task + task 間 review)。

**Goal:** Session(StudySession + AnswerEvents)の 7 不変条件を domain 層 + 意図別 repository に集約し(挙動不変)、②status 後退遷移ガード(terminal 凍結)を隔離 commit で埋める。

**spec:** `docs/superpowers/specs/2026-07-09-f2-session-aggregate-design.md`(fc052e0・承認済)。4 確定判断 + CC 判断点 4 は固定。
**HEAD:** plan 起草時 `fc052e0`(code は fact-finding 時 `6cd468a` から不変を diff で確認済)。着手時に対象 file 再スキャン。

## Global Constraints(全 task 共通)

- **挙動変更は Task 6(W)のみ**。G/R は挙動不変 — 既存 golden/snapshot(route.test 30 + contract 12)+ G1-G5 の**更新ゼロ**が客観証明。golden 赤 = 即停止(golden を直して通す行為は禁止)。
- schema 変更ゼロ・migration 一切書かない(zero users)。wire(`{ok, failed}` 200 / 400 / 401 / 503 + Retry-After・部分失敗ポリシ)不触(D-2)。**client 側 diff ゼロ**(lib/sync / lib/client-db / runner 系 file 不触 — spec 完了条件 5)。
- P0 凍結契約不変: answer_events に rating 列なし(§A #1)/ deriveRating・correct_count = rating>=2(§A #7)/ JST day(§A #8)。
- owner-scope: repository の WHERE(cards.userId / setWhere userId)は現行 verbatim。**processSession 公開 API 不変**: シグネチャ(db, user, session, events)・戻り値 `{failed: string[]}`・構成順(orphan/A-2 先 → tx 失敗 applicable 後結合)・duplicate は failed に入れない(spec §7)。
- domain 純度: `lib/reviews/domain/**` は runtime import ゼロ。pure sibling 例外 = `lib/cards/replay-card` / `lib/jst` / `lib/fsrs`(型)。zod 非依存(最小 structural 型を自前定義)。
- **実装レーン**: 全 task = CC(Opus)fresh subagent。実装 subagent は commit しない(controller が review 後 commit)。
- review: 全 code task = canonical(SDD task-reviewer・read-only)。**risk task(Task 3 R2 / Task 4 R3 / Task 6 W)= + Codex review**(codex-review.sh・未解決 Crit/Imp 0・上限 3 周)。
- per-task gate: 対象 test + whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` 全 exit 0。**R 系 task は追加で** `pnpm vitest run app/api/review-events/bulk/route.test.ts tests/contract/review-events-bulk.contract.test.ts` green + golden/snapshot 更新ゼロ確認(`git status` に snapshot diff なし)。
- phase 完了 gate(Task 5 後 = R 完了 / Task 6 後 = W / Task 7 = 最終): full `pnpm test` + `pnpm build` 追加。
- commit/TAG: G・R = review 後 `[reviewed]`。W = `fix(reviews)` **TAG 無し** → push 後 stg smoke → **session doc が [reviewed] 正記録**(force-push しない・恒久規律 6cd468a)。
- エスカレーション(Global): 未解決 Critical / golden 赤(挙動不変の破れ)/ 仕様解釈揺れ / Sprint 完了 のみ停止。Important 以下は CC 吸収。

## 参照事実(task から参照・再調査不要)

### A. SQL 述語 ↔ 遷移表の 1:1 対応表(spec §6.1 全域 × §6.2 述語・机上照合の正)

W の setWhere 述語 = `userId 一致 AND (既存.status = 'active' OR 既存.status = excluded.status)`。canApplyStatusWrite(TS 定義)= `current === 'active' → true / それ以外 → incoming === current`。同一 user 前提での評価(userId 不一致は C-1 = 遷移と別軸):

| #   | 既存 status | payload status | 述語評価(SQL)                                            | canApplyStatusWrite        | 判定   |
| --- | ----------- | -------------- | -------------------------------------------------------- | -------------------------- | ------ |
| 1   | (行なし)    | any            | conflict 不発 → INSERT(述語非評価)                       | ガード対象外               | INSERT |
| 2   | active      | active         | `'active'='active'` → **T**                              | current='active' → **T**   | 許可   |
| 3   | active      | completed      | 左辺 T                                                   | **T**                      | 許可   |
| 4   | active      | abandoned      | 左辺 T                                                   | **T**                      | 許可   |
| 5   | completed   | completed      | 左辺 F・右辺 `'completed'=excluded('completed')` → **T** | incoming===current → **T** | 許可   |
| 6   | completed   | active         | 左辺 F・右辺 F → **F**                                   | **F**                      | 拒否   |
| 7   | completed   | abandoned      | 左辺 F・右辺 F → **F**                                   | **F**                      | 拒否   |
| 8   | abandoned   | abandoned      | 右辺 **T**                                               | **T**                      | 許可   |
| 9   | abandoned   | active         | **F**                                                    | **F**                      | 拒否   |
| 10  | abandoned   | completed      | **F**                                                    | **F**                      | 拒否   |

全 10 行で SQL / TS 一致(構造: 左辺 = 'active' 判定・右辺 = 同値判定、が両表現で同型)。**Task 6 の verify step はこの表と実装 SQL・実装 TS を突合し ledger に記録**(実装が表と乖離したら Critical・停止)。

### B. test fake は 2 系統(G1 の影響棚卸しの起点・first-hand 確認済)

- 共有 fixture `tests/fixtures/review-events.ts`: `makeFakeDb`(:385)の session upsert fake = `onConflictDoUpdate` が `{values, conflictSet, setWhere}` を `state.sessionUpsertCalls` に**記録して resolve するだけ**(行 store・merge・returning なし)。consumer = contract test。
- `app/api/review-events/bulk/route.test.ts` inline 近似コピー(:234 付近・fixtures 未移行)。consumer = route.test 30 本。
- **G1 は両系統を同型強化**(統合・移行はしない — scope creep 禁止)。強化 = additive: `sessionRows` map を state に追加し、upsert fake が INSERT or(userId 一致時)set 適用の merge を実際に行い、`.returning()` chain に対応。**`sessionUpsertCalls` の記録動作は不変**(既存 30+12 test の args-capture assert を壊さない)。guard 述語の simulation は W で `canApplyStatusWrite` を直接 import して組み込む(G1 時点は tenant 判定のみ = 現行挙動)。
- G5 の permanent-4xx 注入: `classifyBulkError` は zod 系を permanent-4xx、transient PG code + unknown default を transient に分類(lib/retry/classify-bulk-error.ts)。ZodError 相当を `sessionUpsertShouldThrow` 経由で注入 → 400 `{error:'invalid_payload'}` を観測して pin。

### C. stg smoke 拒否行の線引き(kickoff 確定・spec §8 完了条件 4 の具体化)

実 DB 確認 = **代表 2 行**: 対応表 #6(completed→active)+ #7(completed→abandoned)。残り拒否 2 行(#9/#10)は対応表 A の机上照合で足りる(述語は同一構造・abandoned 系は existing status の値が違うだけで評価経路同型)。加えて (a) 通常演習 1 周非退行(→ status='completed')(b) 同一 payload 再送冪等(#5)。

### D. upsertSessionGuarded の R→W シグネチャ安定化(spec §3.3/§6.2 の接続)

R2 で新設する signature は最初から `upsertSessionGuarded(user, session) → Promise<{applied: boolean}>`。**R 実装 = 現行 SQL verbatim(setWhere = tenant のみ・returning なし)+ `applied: true` 固定返却**(挙動不変・返り値は R では未消費)。W が (i) setWhere に遷移述語追加 (ii) `.returning()` 追加 (iii) applied = 実計算(conflict かつ 0 行 → false)に差し替え、route が applied=false で `logger.warn`(event: `review_events.session_upsert_blocked`)を発火。route の配線 shape は R3 から不変(W の diff が guard 本体だけに縮む)。

---

## Phase G(1 commit: `test(reviews): F2 golden 先張り(G1-G5)[reviewed]`)

### Task 1: golden 5 本先張り + fake 強化

- **目的**: R の挙動不変証明の基準を先に凍結(spec §5)。test-only・実装コード不触。
- **内容**(置き場・assert は spec §5 の表が正):
  - **棚卸し step(最初)**: 参照事実 B の 2 系統 fake の現 consumer(route.test 30 / contract 12)を実行し green を確認 → G1 強化 → **再度 full green を確認**(強化が既存 assert を壊さない実証)。結果(件数・変更点)を ledger に記録。
  - G1: 両 fake に `sessionRows` store + merge(INSERT or userId 一致で set 適用)+ `.returning()` chain 対応(参照事実 B。tenant 判定のみ = 現行挙動)。
  - G2 `route.test.ts`: 前進遷移 pin — active→completed(status + completed_at 値 assert)/ active→abandoned(completed_at null のまま)/ completed→completed 同一 payload 再送(値不変)/ completed→completed **異 completed_at** 再送(**LWW 更新 = 現行挙動**・spec §3.1 規則の pin)。
  - G3 `route.test.ts`: I-1 behavioral — 再送 payload の card_ids 差替え → 保存値不変(merge fake で挙動 assert 化)。
  - G4 `route.test.ts`: C-1 behavioral — 他 user の session_id 衝突 POST → UPDATE no-op(status 不変)。
  - G5 `route.test.ts`: permanent-4xx → 400 分岐 pin(参照事実 B の注入方法)。
- **制約**: 実装コード不触・**既存期待値/assert 不変**(fake 強化に伴う既存 test setup の最小修正は可 — 期待値を変えない・Codex 指摘採用)。**期待値は現行実挙動**(先に手元実行で観測してから assert を書く — 仕様から推測しない)。
- **完了条件**: 新 test 全 green + 既存 full test green + per-task gate + canonical review Crit0/Imp0。

## Phase R(4 commits: R1(Task2)→ R2(Task3)→ R3(Task4)→ lint 独立 commit(Task5)。R2/R3 = 配線置換 risk task 分割・F1 R3a/R3b と同粒度)

### Task 2: R1 — domain 抽出(`refactor(reviews): F2-R1 domain 抽出(session-values + session-aggregate)[reviewed]`)

- **目的**: spec §3.1/3.2 の domain 層を `lib/reviews/domain/` に**新設 + unit test**(additive only・既存コード未配線。配線は Task 3/4)。
- **内容**: ① `session-values.ts`: `SessionStatus` 型 + `canApplyStatusWrite(current, incoming)`(遷移規則の唯一定義・completed_at 規則の註記は spec §3.1 verbatim)。unit test = **対応表 A の #2-#10 全 9 組を機械列挙**。② `session-aggregate.ts`: `buildCardOptionIndex`(ingest:158-175 verbatim・malformed element 握り潰し)/ `admitEvents`(ingest:179-196 verbatim・rejected = event_id flat 配列)/ `planReplay`(ingest:225-236 verbatim・inserted gating + consumedSet + payload 順)/ `replaySession`(ingest:242-274 verbatim・replayCard fold + zip)/ `aggregateStudyDays`(ingest:357-366 verbatim・todayInJst + deriveRating)/ `deriveRating`(ingest:70-72 **verbatim・シグネチャ不変** — P0 §A #7)。unit test = 各関数の主経路 + A-2(e) 相当(malformed options が buildCardOptionIndex で空 Set 化)+ payload 順保持 + dedup。
- **制約**: 最小 structural 型(`AnswerEventInput` 等)を自前定義(zod 非依存)。既存 file 不触(ingest の重複削除は Task 3)。
- **完了条件**: 新 unit test green + per-task gate + R 系 gate + canonical Crit0/Imp0。

### Task 3: R2 — repository 新設 + processSession 配線置換(`refactor(reviews): F2-R2 repository + ingest 配線 [reviewed]`・**risk task**)

- **目的**: spec §3.3 の意図別 repository を新設し、processSession を orchestrator に縮退(挙動不変・ingest 側 bisect 単位)。
- **内容**: ① `lib/reviews/session-repository.ts`(DbExecutor 型): `loadCardReplayStates`(Phase 1 SELECT・owner WHERE verbatim・**raw options rows を返す** — Set 化は domain)/ `insertAnswerEvents`(ON CONFLICT DO NOTHING + returning)/ `insertReviews` / `applyCardFinalStates`(VALUES UPDATE + **count-mismatch throw 内包** ingest:297-351 verbatim)/ `upsertStudyDays`(distinct SELECT + per-day UPSERT ingest:368-416 verbatim)/ `upsertSessionGuarded`(**参照事実 D の R 形** = 現行 route:93-125 SQL verbatim・applied:true 固定)。**repository は logger を呼ばない**(spec §3.3)。② processSession 書換え: Phase 1-2f の inline ロジックを domain 関数 + repo メソッド呼出に置換し、Task 2 で copy した重複を削除。tx 境界・実行順序・catch(serializeDbError warn)・failed[] 組立は verbatim 維持。route.ts 不触。③ repository unit test 観点(assert 方法 = 既存 fake の args-capture 流儀・Codex 指摘採用): owner WHERE の userId が query 引数に含まれること / returning shape / count-mismatch = fake の returning 行数を不足させて throw を観測 / distinct 集計 SELECT の発行形 / upsertSessionGuarded が R 形で現行 args を発行。
- **制約**: processSession 公開 API 不変(Global)。zod schema(payloadSchema 等)は ingest に残す。**route.ts 不触のまま typecheck green = signature 不変の型面検出**(Codex 指摘採用)。
- **完了条件**: per-task gate + R 系 gate(**route.test 30 + contract 12 全 green・snapshot 更新ゼロ**)+ canonical + **Codex**(risk)Crit0/Imp0。

### Task 4: R3 — route Phase 0 配線置換(`refactor(reviews): F2-R3 route Phase 0 配線 [reviewed]`・**risk task**)

- **目的**: route.ts Phase 0 の inline upsert(:92-125)を `repo.upsertSessionGuarded` 呼出に置換(挙動不変・route 側 bisect 単位)。
- **内容**: inline `db.insert(studySessions)...onConflictDoUpdate` を repo 呼出へ。catch → classifyBulkError → 400/503 分岐・logger.error(session_upsert_failed)・Retry-After は **verbatim 維持**(route 側に残す)。返り値 `{applied}` は R では未消費(warn 配線は W)。独立 use-case file は作らない(CC 判断点 4)。
- **制約**: auth / zod parse / processSession 呼出 / response 組立に触らない。ingest / domain 不触。
- **完了条件**: per-task gate + R 系 gate(**route.test 30 全 suite + contract 12 green・snapshot 更新ゼロ**)+ canonical + **Codex**(risk)Crit0/Imp0。

### Task 5: R4 — import 境界 lint(`chore(lint): F2 domain import 境界 enforce [reviewed]`)

- **目的**: `lib/reviews/domain/**` の runtime import ゼロ(pure sibling 例外 = Global 記載の 3 つ)を eslint flat config で enforce(独立 commit・F1 R4 前例)。
- **制約**: `files:` glob は minimatch — escape 規約(CLAUDE.md)遵守。検証 = 違反 import(例: `@/lib/db`)を一時挿入して lint 赤を確認してから戻す。**実証記録(挿入 import 文 + lint failure 出力)は ledger の本 task 行に残す**。
- **完了条件**: whole-repo lint exit 0 + 違反検出の実証記録 + canonical(glob 検証観点)+ **phase R 完了 gate: full test + build 全 exit 0**。

## Phase W(1 commit: `fix(reviews): reject session status regression(②)` **TAG 無し**)

### Task 6: W — ②status 遷移ガード(spec §6)

- **目的**: session status の後退遷移(terminal 凍結)を閉じる。挙動変更は本 task のみ。
- **内容**(test-first・spec §6.4 注記): ① **非真空 test 9 本を先に書き赤を確認**: (1) completed へ active 再送 → status='completed'・completed_at 維持(値 assert)(2) completed→abandoned 拒否 (3) abandoned→active 拒否 (3b) abandoned→completed 拒否(対応表の拒否 4 行を route-level で網羅 — Codex 指摘採用)(4) active→completed 通る(G2 非退行)(5) completed→completed 再送 通る(冪等)(6) **clamp 時 events は通常処理**(failed に入らない・answer_events INSERT + reviews INSERT の**代表 assert で足りる** — FSRS 細部値は見ない(replay 契約への密結合回避・Codex 指摘採用)= 遅延 flush 非弾き)(7) clamp 時 logger.warn 1 回(event 名 `review_events.session_upsert_blocked`。**payload/message は「guarded upsert 不適用」の事実のみ — clamp 断定文言を避ける**(tenant 不一致と区別不能のため・Codex 指摘採用))(8) **contract file**: clamp 時も response 200 `{ok: true, failed: []}`(D-2 直 pin。**contract は wire のみ assert** — logger/DB 状態は route.test 側に閉じる・Codex 指摘採用)。(1)-(7) = route.test。② 実装(参照事実 D の W 形): repo の setWhere に遷移述語追加(Drizzle で excluded 参照が書けなければ raw sql fragment 許容 — spec §6.2。**実装時に `.toSQL()` 等で生成 SQL を確認**し断片を ledger へ — Codex 指摘採用)+ `.returning()` + applied 実計算(**条件明文化**: INSERT 成功 or conflict-update 1 行 → true / conflict かつ returning 0 行 → false。applied は throw しない正常戻り = route 既存 catch 分岐と独立・Codex 指摘採用)。両 fake の merge に `canApplyStatusWrite` を direct import で組込(spec §3.4(i)・fake の述語定義を TS 単一化)。route: applied=false → logger.warn(sessionId / userId / 送信 status。notifyOps 不使用)。③ **SQL 述語照合 verify step**: 実装 SQL・実装 TS を**参照事実 A の対応表全 10 行と突合**し、結果(SQL 断片 + 一致確認)を ledger に記録。乖離 = Critical・停止。
- **制約**: processSession / domain admission 不触(event 側は status を見ない — 確定判断 1)。G2-G5 は**更新ゼロのまま green**(W の非退行証明)。wire 不変(response shape・status code 追加なし)。
- **完了条件**: 新 test 9 green(spec §6.4 の 8 本 + (3b) 追加 — 拒否 4 行の route-level 網羅は spec「実際に後退遷移を起こして拒否を確認」の範囲内 additive・spec 書換え不要)+ 先赤の記録 + 既存 full green + G2-G5 更新ゼロ + 照合 ledger 記録 + per-task gate + canonical + **Codex** Crit0/Imp0 → **TAG 無し commit**。

## 最終

### Task 7: 最終 gate + docs

- **目的**: sprint 完了 gate + 記録。
- **内容**: full `pnpm test` / `pnpm build` / whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` 全 exit 0 + **golden 更新ゼロの最終確認**(G1-G5 含む全 snapshot が R 開始時点から不変)+ **client 側 diff ゼロ確認**(`git diff --stat <G直前>..HEAD -- lib/sync/ lib/client-db.ts 'app/(app)/app/study/' 'app/(app)/app/_components/review-flush-trigger.tsx'` が空 — fact-finding Step 2 の実パス網羅・Codex 指摘採用)+ whole-branch review(G〜W 全 commit)+ ledger 記録 + 完了 docs commit(`[no-review]`・**W commit と別 = 挙動変更 commit に docs を混ぜない**。**二重 fake 残債(fixtures/inline の同型 2 系統)を完了 doc に記録** — Codex 指摘採用)。stg smoke 申し送り = **参照事実 C**(代表 2 拒否行の実 DB 確認 + 通常 1 周 + 冪等再送。DevTools fetch で stale payload 再現)。
- **完了条件**: 全 gate exit 0 + 報告 chat に「whole-repo lint exit 0 確認済」明記 + 停止(OT push 判断待ち)。

---

## Codex plan cross-check 統合記録(帰属)

`docs/codex/2026-07-09-plan-f2-session-aggregate-plan.md`(1 パス・detector PASS)。独立論点 12 = 全て plan/spec と整合(相違なし)。plan 指摘 11 の扱い:

- **採用 9**: ① warn の payload/message を「guarded upsert 不適用」の事実表現に(clamp 断定回避・Task 6)② applied 実計算の条件明文化(INSERT/update 1 行 = true・conflict+0 行 = false・throw と独立・Task 6)③ `.toSQL()` での生成 SQL 事前確認 + ledger 断片記録(Task 6)④ G1 制約の表現修正(「既存期待値/assert 不変・setup 最小修正可」・Task 1)⑤ 二重 fake 残債の完了 doc 記録(Task 7)⑥ W test #6 の assert を代表 2 点に緩和(FSRS 細部値への密結合回避・Task 6)⑦ (3b) abandoned→completed 拒否を route-level に追加(拒否 4 行網羅・test 9 本化・Task 6)⑧ contract test は wire のみ assert の責務分離明記(Task 6)⑨ client diff path を fact-finding 実パスに拡張(review-flush-trigger 含む・Task 7)。
- **部分採用 2**: ⑩ repository unit test の assert 方法明文化 — 既存 fake args-capture 流儀で列挙(Task 3。SQL text そのものの assert までは既存 test 方針外)⑪ processSession signature の型面検出 — 「route.ts 不触のまま typecheck green」を完了条件に明記(Task 3。直接の型 test 追加はしない — route import が既に型消費者)。
- **リスク項(記録のみ・全て spec/plan で既決)**: terminal 凍結 vs 訂正可能性(spec §6.1)/ application guard vs DB constraint(spec §1)/ wire 非表出 vs divergence(spec §6.3。双方向 sync 化時は再評価)/ fake vs 実 DB = stg smoke が最終防衛線(参照事実 C)/ R2 blast radius(review 重点 = owner scope・順序・failed[]・Task 3 Codex 対象)/ buildCardOptionIndex の domain 配置(spec §3.2 既決・structural 型の肥大に実装時注意)。

- 行数: 本 plan 132 行(< 250)。
