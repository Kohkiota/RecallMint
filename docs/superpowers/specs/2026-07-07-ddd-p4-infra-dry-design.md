# DDD リファクタ P4 — インフラ DRY spec

- 日付: 2026-07-07 / branch `dddrefactor` / 起草 = Fable / 実装 = CC(Opus)subagent-driven
- 根拠: fact-finding = `docs/superpowers/sessions/2026-07-07-ddd-p4-factfinding.md`(現 HEAD `a62fb1c` 再スキャン・OT 承認済)/ SSoT §1 D-1〜D-6・§3 N-1〜N-5 / P4 handoff
- **P4 は DDD リファクタ最終 phase**。完了で P0〜P4 全体が完了(出口 = develop merge → まとめ stg smoke → prod 判断、いずれも P4 完了時に OT)。

## 1. 目的とスコープ

### 1.1 目的

インフラ層に残る同型コピペの DRY と lib/ 配置基準の統一。fact-finding の乖離 4 点(§2)により、audit 想定の「大掛かりな infra 統合」は P0〜P3 で大半消化済みと判明 — **P4 の実体は「取り残された小さな DRY + lib 整理 + TEMP 撤去」に縮小**した。

### 1.2 in scope(OT 確定 5 論点・§3 に判断根拠)

1. outbox per-table 同型 5 対の helper 化(W1)
2. pull 6 module の server 内 factory 化 — SQL builder 部限定(W2)
3. route 認証 wrapper — read-only 4 route のみ(W3)
4. lib 再編: 並行命名 2 組解消 / replacer 統合 / VERCEL_ENV helper 化 / retry⇄transient dir 配置整理(W4)
5. contact-form server action の lib/actions 移設 + Block A allowlist 回収(W5)
6. P2 measure 計測配管(TEMP-MEASURE)の revert(W6)

### 1.3 out of scope(P4 で触らない — 理由の記録)

- **PullResponse wire generic 化(N-3 任意 consider → 不採用で確定)**: wire に出る(契約変更・回帰リスク)一方、得るのは entity 追加時の型定義がやや楽になる程度。pull の実質 DRY は W2(wire に出ない 8 割)で達成される。client 手展開(pull.ts cursor read/write)は wire 形状に bind しており W2 では消えない — それで良い。
- **toISOString の nowIso() 化**: clock 注入(latent 不純・baseline §B 申し送り)と絡む領域。注入設計なしの機械置換は中途半端(呼び出しは括れるが注入点が無い)。clock 注入をやる phase / 別 task に送る。
- **mutation 2 route(entity-mutations/bulk / review-events/bulk)の wrapper 化**: error path(classifyBulkError 応答・401 user_not_synced)が独自で read-only と 2 形態。同型だけ括る原則(§3.1 と同じ)。
- **clerk local `runTransactionWithRetry` の汎用化**: consumer 1 箇所(同 file 内削除 tx)・YAGNI。現状維持(確認のみ)。
- **outbox 非対称部の統合**(N-2 defer)/ **競合解決統一**(N-1 恒久)/ **Dexie schema**(N-4 別 sprint)/ client repository(N-5 完了済)。

### 1.4 凍結契約(D-2 再掲)と measure revert の sanctioned 例外

全 work item の最上位制約 = 挙動不変。API payload shape / error code / HTTP status / 文言 / cache header / op 名 / ops・log イベント名 は不変。P0 golden 全面 green(**snapshot 更新ゼロ**)+ 既存 test green が回帰の正。

**唯一の例外 = W6 measure revert**(OT 確定): `review_events.bulk.request` / `review_events.bulk.timing` イベントの撤去は「TEMP と明記された一時配管の設計通り撤去」であり恒久挙動の変更でない。根拠 §3.2。D-2 の趣旨(既存イベントの改名・意味変更の禁止)に反しない sanctioned 例外として本 spec に記録。

## 2. 現 HEAD grounding(`a62fb1c` 再スキャン・確定事実)

audit(5d3baef 時点)との乖離 4 点(詳細 = fact-finding §7):

- **A. outbox**: handoff の sanctioned scope(withWebLock / classifyFlushResults 共有)は**消化済み**(entity-mutation-flush.ts:20-24 が import 済)。残余 = per-table 同型 5 対のみ(markSynced / markAttempted / dropStale / fetch wrapper / in-flight。table 名 + key 列名だけ違い — controller 裏取りで構造完全一致確認)。
- **B. retry**: ocr.ts:27 / review-flush.ts:29 とも `lib/retry/transient-error.ts` を**共有済み**。残余 = clerk local helper(handle-clerk-event.ts:257-317)+ lib/retry ⇄ lib/transient の dir 並列(各 1 file・実装は HTTP message regex 系 vs DB SQLSTATE 系で別物)。
- **C. route 認証**: 6 route = read-only 4(!user → 200 + 空 + no-store)⇄ mutation 2(!user → 401 user_not_synced)の 2 形態。単一 wrapper 不成立。
- **D. pull**: audit どおり同型。差異 = cursor 列 3 種(updatedAt / createdAt / deletedAt)+ return key 命名 3 種 + mapper のみ。card_tags 例外意味論は client 側補完(pull.ts:16-20・213-225)で現存・不変必須。

## 3. 判断点の記録(OT 確定・2026-07-07)

### 3.1 outbox 残余 = per-table 同型 5 対の helper 化(論点 1 = (b))

**限定共通化 ≠ 統合**の線引き(最重要・N-2 維持): helper 化は非対称部(retry controller / backoff / pullBack hook / session grouping = review-flush 固有)に**一切触れない**。共通化するのは per-table の機械操作のみ — entity-mutations と review-events は「同じ per-table helper を呼ぶが、その周りの retry / pullBack は各自のまま」。orchestrator 2 file(entity-mutation-flush.ts / review-flush.ts)は不変。in-flight set は**インスタンス 2 つの分離を維持**(共有インスタンス化は統合になる)。

### 3.2 申し送り 3 件(論点 2)

- **measure revert = 実施**。最終 phase で撤去しないと TEMP が恒久化する。条件 2 点は fact-finding で確認済み:
  (i) **consumer 不在**: code 内 consumer = emitter(route.ts:176)のみ。docs 参照は完了済み計測 campaign(2026-05-28/29)の歴史 log のみ。repo 内に監視・アラート設定なし。golden は timing / logger payload を明示的に非凍結(review-events-bulk.contract.test.ts「NOT frozen: timing metrics / logger payloads」・fixtures/common.ts:42)→ **snapshot 更新ゼロは revert 後も成立**。
  (ii) **設計通りの撤去**: route.ts:70-71 の注記「[TEMP-MEASURE 2026-05-28] … 計測 campaign 後に revert」どおり。P2 spec §8.2 も「revert は別 task・OT 判断」と申し送り済 → 本 spec がその OT 判断の記録。
  実装中に consumer が見つかる / 撤去が挙動変更になる場合は**停止して OT 相談**。
- **contact-form → lib/actions 移設 = 実施**(P3 判断点 4 の P4 送り。受け皿 `lib/actions/` 既存 = result.ts と同居)。
- **PullResponse wire generic = 不採用**(§1.3 に理由記録)。

### 3.3 retry 残余(論点 3)

clerk local `runTransactionWithRetry` / `isTransientDbError` = **現状維持**(確認のみ・§1.3)。lib/retry ⇄ lib/transient = **dir 配置・命名のみ整理**(W4)— retry(再試行)と transient(一時エラー判定)は関心の違う実装ゆえ**実装は統合しない**。判定コード集合の不一致(isTransientDbError の 08 前方一致 / 57P01・57P02 ⇄ classify-bulk-error の 57014 / 53300)は各消費文脈に紐づく意図的差異として不触。

### 3.4 route wrapper = read-only 4 本のみ(論点 4)

対象 = pull / study-days/pull / dashboard/stats / exams/status。wrapper が担うのは getCurrentUser → UnauthenticatedError → 500 / !user → 200 + 空 body(shape は route 引数)/ 成功 body + `Cache-Control: no-store` / catch → 500 の定型。**条件 = 4 route の wire 契約(status / body shape / header / log level)が個別にバイト同一で保存される**(P0 golden の pull contract 含め snapshot 更新ゼロ)。

### 3.5 lib 再編の深さ(論点 5)

実施 = ① 並行命名 2 組解消(lib/clerk.ts の中身を lib/clerk/ へ、lib/stripe.ts の中身を lib/stripe/ へ寄せる)② replacer verbatim 重複統合(logger.ts:46-58 expandError ⇄ ops.ts:121-133 makeReplacer — byte-exact 確認済)③ VERCEL_ENV inline(`?? NODE_ENV` enrichment 系 + `=== 'production'` 判定系・12+ file)の helper 化。

**並行命名解消の条件**: import path が変わるため build で server/client 境界確認(P1 card-filter-predicates 移動と同じ・lint + build green で担保)。**module-load 時 throw(clerk.ts / stripe.ts / price-mapping)の発火位置は import 順依存**(audit §6.3 地雷)— 移設は「fail-fast の発火タイミングが変わらないこと」を review 観点に含める。

**⚠ spec review での確認事項(唯一の未決)**: CLAUDE.md の絶対ルール文面が「`lib/stripe.ts` で fail-fast」「`lib/clerk.ts` で fail-fast」と **path を名指し**している。並行命名解消はこの 2 行の CLAUDE.md 更新(新 path への書き換え)を伴う。(a) 移設 + CLAUDE.md 該当 2 行更新(推奨 — 並行命名の根治)/ (b) lib/clerk.ts・lib/stripe.ts の path 維持で re-export shim(CLAUDE.md 不変だが間接層が残る)。**OT 判断待ち**。

### 3.6 簡潔性規律の適用

P4 は「DRY のための抽象化を作る phase」だが rule of three / YAGNI は維持: 対象は**実重複が現存する箇所のみ**(本 spec 列挙分)。予測共通化・設定可能化はしない。helper の引数は現 consumer が使う分だけ。replacer 統合(重複 2)は byte-exact verbatim + OT 確定ゆえ rule of three の例外として明記。

## 4. Work item 詳細

### 4.1 W1. outbox per-table helper 化

対象 5 対(fact-finding §1.2 の表): markSynced(review-events.ts:162-168 ⇄ entity-mutations.ts:145-153)/ markAttempted(:173-182 ⇄ :164-173)/ dropStale(:188-204 ⇄ :188-204)/ fetch client wrapper(:238-257 ⇄ :221-240)。共通 helper は Dexie table handle + key 列名を引数に取る(配置は plan で・lib/sync/ 内)。in-flight set = 分離維持(§3.1)。orchestrator 2 file 不変。挙動 byte-equivalent(既存 unit test green が正)。

### 4.2 W2. pull server 内 factory 化(SQL builder 部限定)

factory が括るのは `getDb() → select().from(table).where(user_id AND cursor列 >= since) → map(mapper) → maxIso` の同型部のみ。**entity 側に残すもの** = mapper / cursor 列の選択 / return key 命名 / card_tags 例外意味論(client 補完 pull.ts:16-20・213-225 は不触)。route 構築(app/api/pull/route.ts:82-108)・PullResponse・client 手展開・SYNC_META_KEYS = wire につき不変。server-only は factory module に付与(現欠落 3 file の直接 marker は factory 化で自然統一)。study-days-pull(全件返し・cursor 形が別)は同型でなければ対象外 — plan で確定。

### 4.3 W3. route read-only 4 本の認証 wrapper

§3.4 のとおり。空 body shape は route ごとに引数で渡す(pull = 空配列 + cursors / stats = 空 stat object 等、現行と同一バイト)。mutation 2 本・webhook 2 本 = 不触。

### 4.4 W4. lib 再編

1. lib/clerk.ts → lib/clerk/ 配下へ移設(env fail-fast。§3.5 の CLAUDE.md 判断に従う)。
2. lib/stripe.ts → lib/stripe/ 配下へ移設(env fail-fast + SDK init。`export const stripe` の import 元更新)。
3. replacer 統合: 共通 module 1 つ(配置・命名は plan で)を logger.ts / ops.ts が import。
4. VERCEL_ENV helper: enrichment 系(`?? NODE_ENV ?? 'unknown'`)と production 判定系(`=== 'production'`)は用途が別 — helper を分けるか 1 module 2 export かは plan で。lib/env/ 配下。
5. retry ⇄ transient dir 統合: 配置のみ(一方へ寄せる・実装不変・命名は plan で)。
全項目: import path 変更を伴うため per-task build 必須(§3.5 条件)。

### 4.5 W5. contact-form 移設 + lint 回収

`submitContact` + `getRequestIp` を app/(marketing)/contact/actions.ts → `lib/actions/contact.ts` へ移設('use server' directive 維持)。actions.test.ts 同時移動。contact-form.tsx:4 の import 更新。eslint.config.mjs:134-139 の Block A override 削除 → **Block A allowlist 0 件**(P0 lint 機構の最終回収)。cross-feature 3 件 + react-hooks/refs 1 件は P4 対象外(app 内分割・Sync-fix-1 と独立)。

### 4.6 W6. measure revert(TEMP-MEASURE 撤去)

撤去対象(fact-finding §6-1): route.ts:70-86(measureEnabled / timings / measure closure / tStart / `request` marker)・:111 の measure('session-upsert') unwrap・:173-182(total 集計 + timing log)/ ingest-review-events.ts の measure 引数(:91)+ 6 call site unwrap(:109/:173/:228/:256/:273/:336)+ processSession シグネチャ変更(call site = route.ts の 1 箇所のみ)。co-located test の measure 引数調整は可(unit test 変更 ≠ golden)。**error path の `session_upsert_failed` log は TEMP 外・不触**。根拠 = §3.2。

### 4.7 W7. 最終 gate + docs

whole-repo lint --max-warnings=0 / typecheck / full test / **test:contract 77 snapshot 更新ゼロ** / build 全 exit 0。SSoT 進捗表 + 変更履歴更新、baseline §B(vi) に P4 surface 追記、P4 完了報告(= DDD リファクタ全体完了報告。merge / まとめ smoke / prod は OT)。

## 5. 回帰検知の正

- P0 golden 77(snapshot 更新ゼロ — W6 含む・§3.2(i) で成立確認済)+ 既存 co-located test green。P4 対象は server / lib で test が厚い領域(audit §6.4)につき characterization 先行は不要(handoff 確定)。
- W1 は outbox flush の既存 unit 4 suite(entity-mutations / review-events / 両 flush)、W2 は pull 系 unit + pull contract、W3 は route.test 4 本 + pull contract、W5 は actions.test が正。
- per-task build(W4 全項 + W2/W3/W5 の import 変更 task)で server/client 境界混入を検知。

## 6. Deliverables

本 spec / plan(writing-plans + Codex cross-check)/ 実装 commit 群([reviewed])/ SSoT 更新 / baseline §B(vi) 追記 / Codex review md(risk task 分)。

## 7. 完了条件

W1〜W6 完了 + W7 gate 全 exit 0 + 全 feat/fix commit [reviewed] + SSoT「完了 + HEAD SHA」記録。P4 完了 = sprint 境界で停止し OT 判断(develop merge → まとめ stg smoke → prod)。

## 8. 非目標 / 申し送り

§1.3 の全項目。次工程への申し送り = N-4 Dexie 再設計(別 sprint・OT 検討)/ clock 注入(nowIso 化はそこで)/ cross-feature allowlist 3 件(機能境界強化時に再評価)/ E2E 残余 3 点(baseline §B(vi) 申し送り済・まとめ smoke で実走)。

## 9. Codex cross-check(plan 段階で実施)

`scripts/ai/codex-plan-review.sh`。入力 = fact-finding + 本 spec の要件を主、plan ドラフトは参考添付(anchor 防止)。1 回の cross-check → CC が突き合わせ → OT 承認で plan 確定。

## 付録: 参照

fact-finding = `docs/superpowers/sessions/2026-07-07-ddd-p4-factfinding.md` / SSoT = `docs/plans/2026-07-06-ddd-refactor-design-decisions.md` / handoff = `docs/plans/2026-07-07-p4-handoff.md` / audit §4.2・§6・§7(凍結・file:line は fact-finding が現状正)/ P2 spec §8.2(measure 申し送り元)。
