# card_tags delta 完全性(authoritative replace)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** delta pull 応答の card_tags を「変更 card は by-card SELECT 時点の authoritative 集合」に置換し、card_tags のローカル恒久欠落(→ server 実削除伝播)を発生源で断つ。

**Architecture:** **production code の変更は 2 file のみ**(`lib/db/card-tags-pull.ts` に by-card 取得を追加 + `app/api/pull/route.ts` で authoritative replace。test / doc は別途)。client 無変更(I-5)。union は不採用(READ COMMITTED の stale 混入 — spec I-1 blocker)。

**Tech Stack:** Drizzle / postgres.js / Vitest(route unit は既存 mock 構造)/ 実 PG iso(devcontainer PG17・`pnpm test:iso`)。

**Spec:** `docs/superpowers/specs/2026-08-17-card-tags-delta-completeness-design.md`(**r3 凍結**・OT 裁定済・Codex 差分再確認 GO)

## Global Constraints

- **hotfix 級だが品質 gate は通常どおり**(OT 裁定)。simplicity 規律・DDD 方針は既定どおり。
- **不変条件 I-1〜I-5(spec §1)が完了条件の柱**。特に: I-2(cursor は増分 rows のみから算出 — 応答 rows から再計算しない)/ I-3(明示 `eq(cardTags.userId, userId)` 必須)/ I-4(skip 条件は (a) 変更 card 0 件 (b) `since_card_tags` 欠落のみ・**skip 時は filter も不適用**)/ I-5(client コード無変更・既存凍結 pin 全 green 維持、退行 = Critical)。
- **red 規律**: gate は 1 つずつ個別変異(まとめ壊し不可)。test 追加を含む commit は message に「red 検証」記録行。
- **review**: 各 fix commit 前に canonical(`superpowers:requesting-code-review` 既定経路)+ Codex(`scripts/ai/codex-review.sh`)収束(Critical 0 / Important 0)。**Codex を先に単独実行し、その時点の working tree は「temporary RED 変異をすべて revert 済みで、意図した未 commit task diff だけが残る状態」にする**(`codex exec review --uncommitted` の対象 = その task diff。review 前 commit 禁止と両立)。この条件は Codex clean detector の偽陽性(canonical 側の変異注入が混入する既知事象)を避けるためのもので、**未 commit diff を消すことではない**。
- **[reviewed] の扱い(今回限りの例外・OT 承認済)**: Task 1/2 の `[reviewed]` は **code review 完了のみ**を意味し **rollout-ready ではない**(smoke pending)。両 commit の message に **smoke pending を 1 行明記**する。**rollout の正記録は Task 5 後の session doc**(spec §5・既存裁定)。CLAUDE.md「重要 Fix の裏取り」と `check-review.sh` の不整合(tag が 2 つの状態を区別できない)の整合化は **follow-up として claude.ai todo へ**(本 sprint では扱わない)。
- assert は `(card_id, option_id)` の**集合**比較(配列順序・件数のみの assert 禁止 — spec §4-8)。
- subagent dispatch は foreground のみ(`run_in_background` 禁止)。

---

### Task 1: `getCardTagsByCardIds` + owner-scope / full-stream iso pins

**目的**: 変更 card の authoritative 集合を返す server helper を追加し、owner-scope 2 層 + I-4(b) 前提を実 PG で pin する(spec §2.1 / §4-3,4,5)。

**Files:**
- Modify: `lib/db/card-tags-pull.ts`(helper 追加。既存 `getCardTagsDelta` / `toClientCardTag` は無変更)
- Modify: `tests/integration/pg/delta-isolation.test.ts`(describe 3 本追加。既存 fixture `seedTwoTenants` / `asTenant` / `getFixtureOwnerDb` を再利用)

**Interfaces(Produces — Task 2 が消費):**

```ts
export async function getCardTagsByCardIds(
  userId: string,
  dbc: TenantDb,
  cardIds: string[],
): Promise<ClientCardTag[]>
// WHERE and(eq(cardTags.userId, userId), inArray(cardTags.cardId, cardIds))。
// cursor 条件なし・max を返さない(I-2 の構造的表現)。mapper = toClientCardTag。
```

**制約**: `getDeltaRows` factory 不使用(cursor 列なしの別形 query・factory の optional 化は YAGNI)。bind 上限は受容済(spec §2.1 台帳)— chunking を書かない。`cardIds = []` は **caller precondition**(route は I-4(a) で呼ばない)— helper に guard を書かず、コメントで契約を 1 行明記(過剰防御をしない。drizzle 0.45 の `inArray(col, [])` は `false` 条件 = 空結果で挙動も安全)。

- [ ] **Step 1(red)**: iso test 4 本を先に書き、helper 不在の compile fail を確認
  - **owner 第 1 層(RLS bypass・predicate 単独証明)**: `getFixtureOwnerDb()` を `dbc` に渡し(`as unknown as TenantDb` cast — test 限定・runtime は select/from/where のみで構造互換、1 行コメント)、`getCardTagsByCardIds(a.userId, ownerDb, [a.cardId, b.cardId])` → 返る pair 集合 = A の pair のみ・B の `(b.cardId, b.tagOptionId)` 不含。
  - **通常経路(asTenant・predicate + RLS 重畳)**: positive = `(a.userId, tx, [a.cardId])` で A の pair が返る / negative = `(a.userId, tx, [b.cardId])` → 空。
  - **RLS backstop(第 2 層の独立証明・Codex plan 指摘 1)**: `asTenant(a.userId)` 内で **`getCardTagsByCardIds(b.userId, tx, [b.cardId])` → 空**。predicate は B 行を候補にする(userId=B)が、tenant context = A の RLS が遮断する — predicate にマスクされない第 2 層単独の pin。RLS policy の存在自体は既存 rls-drift / rls-single-defense が pin 済みのため、この pin の red は policy 無効化変異でなく「predicate を B に向けても漏れない」構成自体で担保(変異注入は行わない)。
  - **full-stream contract(I-4(b) 機械化)**: **専用 describe**(共有 fixture への追加 seed の副作用を避ける — Codex plan 指摘 10)内で owner 接続から A に 2 本目の tag_option + card_tag を追加 seed → 同一 test 内で owner ground-truth read と `getCardTagsDelta(a.userId, tx, undefined)` の rows を**集合一致**で比較(両 read が同 test 内 = describe 間の順序非依存)。pin するのは「静的データに対する全件・無 LIMIT 契約」であって snapshot 同時性ではない(コメントに明記)。
- [ ] **Step 2**: helper 実装(上記 Interfaces どおり・~15 行)→ `pnpm test:iso` green
- [ ] **Step 3(red 実証・個別変異)**: ① `eq(cardTags.userId, userId)` を外す変異 → 第 1 層 pin が fail(通常経路 pin は RLS で通る = 層の役割差が実証される)② `getDeltaRows` に `.limit(1)` を入れる変異 → full-stream pin が fail ③ **RLS backstop の red(OT 裁定 2)**: policy は無効化せず、backstop pin の呼出を**一時的に owner DB(`getFixtureOwnerDb()`)へ差し替える**変異 → RLS が効かないため B 行が返り assert が fail することを確認(= この pin が RLS を実際に見ていることの実証)。各変異は単独適用 → revert。
- [ ] **Step 4**: Codex 単独実行(clean tree)→ canonical review dispatch → 収束後 commit
  - `fix(pull): card_tags by-card 取得 + owner-scope 2 層 / full-stream contract の iso pin(spec §2.1/§4-3..5)`+ red 検証記録行 + `[reviewed]`

**完了条件**: `pnpm test:iso` green / red 3 変異の fail 実証記録 / Critical 0・Important 0 / `[reviewed]` commit。

---

### Task 2: route authoritative replace + regression / 発行条件 pin

**目的**: `/api/pull` の card_tags 応答を replace 合成に変更し、バグの直接証明 pin と発行条件 pin を張る(spec §2.2 / §4-1,2)。

**Files:**
- Modify: `app/api/pull/route.ts`(withTenantTx 内 7 本目 + 合成。~12 行)
- Modify: `app/api/pull/route.test.ts`(mock に `getCardTagsByCardIds` 追加 + describe 2 本)

**Interfaces(Consumes)**: Task 1 の `getCardTagsByCardIds(userId, dbc, cardIds)`。

**制約**: 合成は route 内 inline(helper 化しない — rule of three 不成立)。skip 分岐に I-4(b) の前提コメント必須(全件 SELECT = 単一 statement snapshot が authoritative / LIMIT 等を入れるとこの分岐が壊れる旨)。`cursors.card_tags` の行は**触らない**(`ct.maxCreatedAt` のまま = I-2)。実装形(spec §2.2 sketch):

```ts
let cardTagRows = ct.rows
if (sct !== undefined && changedCardIds.length > 0) {
  const byCard = await getCardTagsByCardIds(user.id, tx, changedCardIds)
  const changed = new Set(changedCardIds)
  cardTagRows = [...ct.rows.filter((r) => !changed.has(r.card_id)), ...byCard]
}
```

- [ ] **Step 1(red)**: route.test に 2 describe を先に書き fail を確認(mock は既存構造に `vi.mock('@/lib/db/card-tags-pull')` へ `getCardTagsByCardIds` を追加)
  - **regression pin(spec §4-1)**: cards → c1 / 増分 → `c1:o_old` + `c2:o_x`(since_card_tags 指定・`maxCreatedAt` は null variant と `'X'` variant)/ by-card → `c1:o_new`。assert(集合比較): ① `c1:o_new` が応答に載る ② `cursors.card_tags` = 増分由来値のまま ③ 応答 = `{c1:o_new, c2:o_x}` で **`c1:o_old` 不含**(replace)。
  - **発行条件 pin(spec §4-2)**: (a) cards 0 件 → 不呼出 (b) since_card_tags 欠落 → 不呼出**かつ応答 = 増分 rows そのまま(c1 の増分行が残る)** (b') **不正 ISO の since_card_tags** → 同じく不呼出 + 全件 fallback(`parseSince` が不正値も undefined に落とす現行契約 — spec I-4(b) の「欠落」は `sct === undefined` 全ケースを指す。取りまとめで OT に明示済)(c) 両条件成立 → `(user.id, tx, changedCardIds)` で 1 回。
  - **failure 伝播 pin(Codex plan 指摘 8)**: `getCardTagsByCardIds` reject → 応答 500・`api.pull.failed` log・payload / cursors を返さない(部分成功にならない — 既存 try/catch 経路に乗ることの pin)。
- [ ] **Step 2**: route 実装 → `pnpm vitest run app/api/pull` green
- [ ] **Step 3(red 実証・個別変異)**: ① by-card 呼出を外す → regression ① fail ② `cursors.card_tags` を `maxIso(cardTagRows...)` に変える → regression ② fail ③ replace を pair union(Map merge)に戻す → regression ③ fail。単独適用 → revert。
- [ ] **Step 4**: Codex 単独(clean)→ canonical → 収束後 commit
  - `fix(pull): delta 応答の card_tags を変更 card の authoritative 集合で置換(I-1)`+ red 検証記録行 + `[reviewed]`

**完了条件**: route unit green / red 3 変異 fail 実証 / Critical 0・Important 0 / `[reviewed]` commit。

---

### Task 3: client test の契約明記(改稿のみ・保証不変)

**目的**: `lib/sync/pull.test.ts:388`(全削除+再構築)と `:417`(空集合化)が依拠する server 契約を test 名 / コメントで I-1 に紐付ける(spec §4-6)。assert は一切変えない。

**制約**: test-only・**保証不変**分類(新規 pin なし・red 不要)。文言は「server payload の変更 card への projection は当該 card の authoritative 集合と一致する(spec I-1)— 本 test の前提はこの契約」の趣旨。

- [ ] **Step 1**: 2 test の名称 / コメント改稿 → `pnpm vitest run lib/sync/pull.test.ts` green(assert 不変の確認)
- [ ] **Step 2**: commit — `test(sync): pull.test の card_tags 再構築 pin に I-1 契約を明記(保証不変)[no-review]`

**完了条件**: pull.test.ts 全 green・diff が名称 / コメントのみ。

---

### Task 4: sprint 完了 gate + whole-branch review + session doc

**目的**: 完了 gate 全通過と whole-branch 視点の最終確認(教訓: task 単位 review は caller 未 pin を見逃す)、記録の確定。

- [ ] **Step 1**: gate 実行 — whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm test` / `pnpm test:iso` / `pnpm run audit` / `pnpm typecheck` **全 exit 0**(`pnpm build` は非必須 — spec §7-3、Vercel deploy build + stg smoke が後段 gate)
- [ ] **Step 2**: whole-branch review(canonical dispatch・対象 = 本 sprint 全 diff。観点 list に whole-repo lint 実行確認と凍結 pin 全 green を含める)→ 指摘あれば fix → 再収束
- [ ] **Step 3**: session doc 起票(`docs/superpowers/sessions/2026-08-17-card-tags-delta-completeness.md`: commit 一覧 / gate 実測 / red 実証記録 / review 実績 / stg smoke 手順 = spec §5 の 1〜4)→ `docs(sessions): ... [no-review]` commit
- [ ] **Step 4**: stop checkpoint 報告(chat)→ **停止**(push は OT)。報告に含める:
  - gate 3 行明記(whole-repo lint exit 0 / test:iso green / pnpm run audit exit 0)
  - follow-up 3 件(spec §6-①②③)の全文を claude.ai todo へ
  - **OT 裁定依頼 2 件**: ① prod 未リリース確認(spec §7-5 — Task 5 の rollout hard gate)② **stg A の既発生実損の扱い**(fact-finding §5.3)。選択肢は **放置 / fixture reset / 既知 baseline がある場合のみ復元** の 3 択 —**「調査」は選択肢にしない**(個体履歴を保存しない非要件確定により forensics 不能・OT 裁定 4)
  - observability 追加なしの判断明記(新規 metrics / log は入れない — hotfix 変更面積の抑制。異常検知は既存 `api.pull.failed` log、実測は Task 5 で session doc に記録)
  - `[reviewed]` 例外の適用状況(Task 1/2 は code review 完了のみ・smoke pending)+ **CLAUDE.md / check-review.sh 整合化の follow-up**(4 件目)を claude.ai todo へ

**完了条件**: 全 gate exit 0 / whole-branch review 収束 / session doc commit 済 / checkpoint 報告で停止。**この時点は「実装完了」であって spec §7-4/7-5(smoke / rollout)は未充足 — sprint 完了は Task 5**。

---

### Task 5: push 後 — deploy 確認 + stg smoke + rollout gate(OT 指示で開始)

**目的**: spec §7-4(stg smoke PASS)と §7-5(rollout 前提)を充足し、session doc を [reviewed] 正記録として確定する。

**制約**: OT push → stg deploy 反映後にのみ開始(push 前に stg を叩かない)。smoke は Playwright MCP + stg DB SQL readback(既存 read-only 経路)。stg A アカウントの実データを触るのは §5-③ の 1 card のみ。

- [ ] **Step 1**: deploy 確認 — stg の deploy SHA が本 sprint の HEAD であること(lockfile-only でないので CC 照合可)。Vercel build 失敗時は rollback 不要(旧版が生きたまま)— 原因 fix を新 commit で行い OT 再 push
- [ ] **Step 2**: stg smoke(spec §5 の 1〜4・判定は pair 集合一致):
  - ① cursor 削除 → full pull → delta pull で境界 card ごとの集合が DB readback と一致
  - ② card 1 枚復習 → pull 後も当該 card の集合一致
  - ③ ②と同じ card で S → add x → `S∪{x}` → remove x → `S`(server / IDB 双方)
  - **失敗時の復旧手順**: x が残存したら remove を再実行 → なお不一致なら**そこで停止**し、現状の server / IDB readback を session doc に証拠保全して OT へ(追加操作をしない)。①②の不一致は読み取りのみで破壊なし — 即停止・報告
  - **実測記録**(Codex plan 指摘 11 + OT 裁定 3): delta 応答の **`cards.length`** / **変更 card への projection 行数**(= by-card 由来の行数)/ card_tags 総行数 / 応答 byte / latency を session doc に記録(新規 metrics は入れない代わりの観測)
- [ ] **Step 3**: session doc に smoke 結果を追記([reviewed] 正記録の確定)→ `docs(sessions): ... [no-review]` commit → 報告
- [ ] **Step 4**: rollout gate — **prod 反映は「prod 未リリースの OT 確認」が取れるまで blocked**(spec §7-5)。確認できない場合は強制 full pull / cursor migration の裁定を OT に上げ、裁定完了まで prod 反映しない

**完了条件**: smoke 全項目 PASS + 実測記録 + session doc 追記 commit 済。prod 反映判断は OT(Step 4 の gate 充足が前提)。

---

## Self-Review(spec 照合)

- spec §2.1/§2.2 → Task 1/2。§4-1..5 → Task 1/2、§4-6 → Task 3、§4-7(凍結 pin 全 green)→ Task 4 gate(`pnpm test` 全件に含まれる)+ whole-branch 観点。§4-8/9 は制約として転記済。§5 smoke + §7-4/7-5 → Task 5。§6 follow-up → Task 4 Step 4。§7-1..3 → Task 4。
- 型整合: `getCardTagsByCardIds(userId, dbc, cardIds)` の署名は Task 1 Interfaces と Task 2 Consumes で一致。
- placeholder なし・file 完全中身なし・scaffolding 分割なし。
- Codex plan cross-check(`docs/codex/2026-08-17-plan-card-tags-delta-completeness-plan.md`)反映済: RLS backstop pin(指摘 1)/ Task 5 新設(指摘 2,3,4,11,12)/ 不正 since pin + failure 伝播 pin(指摘 6,8)/ 空配列契約・seed 隔離・ground-truth 文言(指摘 7,9,10)/ 表現修正(指摘 14,15)/ stg 実損裁定(指摘 13)。第 2 層 red の対称性(指摘 5)は「predicate を B に向ける構成」で代替し変異注入なし(理由は Task 1 に記載)。
