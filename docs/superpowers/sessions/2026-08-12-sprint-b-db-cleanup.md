# Sprint B(DB 全体掃除)— 実施記録(2026-08-12)

- **spec(凍結・r4)**: `docs/superpowers/specs/2026-08-12-sprint-b-db-cleanup-design.md`
- **plan(r2)**: `docs/superpowers/plans/2026-08-12-sprint-b-db-cleanup.md`
- **入力 fact-finding**: `docs/audit/2026-08-11-db-schema-full-inventory.md`(第 3 弾)§8 / §9(§9.4 に本 sprint の採否結果を追記済)
- **適用 runbook**: `docs/ops/sprint-b-db-cleanup-runbook.md`(新規)
- **Codex raw**: `docs/codex/2026-08-12-*`
- 状態: **実装 + docs 完了・未 push**(OT の push 判断待ち)。**migration 0036 は未適用**、stg smoke 未実施

## 1. 何を作ったか

第 3 弾 §8 の歪み 15 件のうち OT 裁定で「掃除する」と決まった分を一掃した。死列・死 store・死 index を落とし、生きている W-only 表には意図を schema comment として刻み、壊れると課金・冪等性・状態機械が狂う列に DB CHECK を張った。Sprint A の follow-up 2 件(`classifyBulkError` の 400 到達不能 / entity_mutations outbox の owner-scope)も引き取った。

| commit | 内容 | 規模 | canonical | Codex |
|---|---|---|---|---|
| (Task 1) | Dexie upgrade を fake-indexeddb で実走できるかの spike。**FEASIBLE** — 素の Dexie で v10 を組んで close → `new ClientDb()` で再 open すると upgrade が実走する。commit なし(Task 6 が発展) | — | — | — |
| `1cc9729` | **T2** `classifyBulkError` に `PERMANENT_PG_CODES` を新設し 400 分岐を到達可能に | 7 files | C0 / I0 / M2 | 指摘なし |
| `8bbfe09` | **T3** `FlushResult` の死 field 3 本(attempted / sessionSynced / reachable)撤去 | 6 files | C1 → fix 1 周で 0 | C0 / I0 / M0 |
| `c3f9573` | **T4** `archived_at` の読み手を全撤去し archived 概念を廃止 | 24 files | C0 / **I1** → fix 1 周 | C0 / I0 / M0 |
| `62013ca` | **T5** `exams.card_count` の bump 機構と `question_no_format` を撤去 | 24 files | **iso RED** → fix 1 周 | C0 / I0 / M0 |
| `bf703c8` | **T6** entity_mutations outbox の owner-scope 化 + Dexie v11 / v12 | 60 files | 全 finding ADDRESSED(3 周) | **P1×2**(2 周目)→ 3 周目 C0 / I0 / M0 |
| `0664b90` | **T7** schema stale comment 一掃 + `ASSET_STATUSES` を runtime tuple 化 | 4 files | `[no-review]` | — |
| `1066446` | **T8** migration 0036(DROP COLUMN 13 / DROP INDEX 3 / SET NOT NULL 1 / FK 張替 1 / ADD CHECK 27)+ 書込 chain 撤去 | 35 files | C0 / **I2** → fix 1 周 | **P1**(runbook へ routing) |
| (T9) | 本 doc + runbook + architecture.md / 第 3 弾 §9.4 の波及 | docs | — | — |

**未解決の Critical / Important はゼロ**(すべて同 task 内の fix round で解消 or 証拠付きで裁定)。

---

## 2. 設計の芯(実装から読めない裁定)

### 2.1 outbox の帰属は「認証主体一択」— judgment が 2 度反転した

本 sprint で最も高くついた論点。**2 人の独立レビュアーが逆の結論に達し、最終的に server コードの現物が決着させた。**

出発点は「client の Dexie query が owner を見ていない(`where('sync_status')`)ので、共有ブラウザでは flush が別 user の行を拾って送る」という素直な bug fix だった。ところが **`user_id` をどこから取るか**で 3 案が競合した。

| 案 | 帰結 |
|---|---|
| **(a) 認証主体**(採用) | foreign な mirror 行を編集しても outbox 行は認証主体名義。server の owner check(`WHERE id AND user_id`)で弾かれ、**delete は `'applied'` の silent no-op / update は `'failed'` で 30 日隔離**。どちらもデータを変えない |
| **(b) mirror 行の owner** | outbox 行が **inert にならず deferred になる**。その owner が同じブラウザでサインインした session で owner check を**通過し**、A の編集が B のデータに**実適用される** = 認可境界の迂回 |
| **(c) flush だけ auth / enqueue は行 owner** | (b) と同じ穴が enqueue 側に残る |

反転の経緯:

1. **Codex 1 周目**が「tag delete 経路が `rowUserId` を渡していない = 認証主体に帰属 → server が認可できず永久再送」と Important×2 を出した。→ **CC が現物確認で却下**。`lib/tags/apply-tag-mutation.ts` は foreign / 不在 id に対して `return 'applied'`(silent success)を返すため「永久再送」は成立せず、初回 flush で synced 化する。むしろ `rowUserId` を渡すと当該行が foreign owner の flush まで pending に残り、その session では owner check を**通過して実削除**が起きる — **無害な no-op を実データ損失に変える改悪**。canonical re-review も独立に同結論。
2. ところが **fix round 1 で CC 自身が「outbox 行 = row owner」を指示していた**。**Codex 2 周目がこれを P1×2 として検出**。現物(`apply-tag-mutation.ts` の `WHERE id AND user_id`)を再確認して **CC が自分の指示を撤回**した。1 の却下と 2 の受諾は矛盾しない — どちらも「foreign 行は inert であるべきで、deferred にしてはいけない」という同じ原理から出ている。
3. 裁定 = **`rowUserId` という概念自体を撤去**(fix round 3)。enqueue も flush も認証主体の 1 本に統一。Codex 3 周目で C0 / I0 / M0 に収束(上限 3 周以内)。

**教訓として残す形**: この非対称(delete = `'applied'` no-op / update = `'failed'` 隔離)は**コードを読んでも分かりにくい** — 2 人のレビュアーが逆の結論に達したこと自体がその証拠なので、`lib/sync/entity-mutations.ts` と `lib/sync/optimistic-mutation.ts` の module 冒頭 comment に「なぜ行 owner に帰属させてはいけないか」を明文化した。

### 2.2 spec §5.3 の前提が偽だった(spec defect・凍結ゆえ本文は直さない)

spec §5.3 は「mirror の読み経路が全て user-scoped query である既存構造により、UI が編集対象にできる行 = 認証主体の行」を根拠に「不一致検査の新設はしない」と書いている。

**この根拠は `tag_categories` / `tag_options` について偽**だった(現物確認)。mirror 読みは **4 経路とも owner 無スコープ**(`toArray()`)で、**sign-out purge も無い**。したがって共有ブラウザには別 user のタグ行が残り、UI に出る。

- **結論は変わらない**(不一致検査は作らない)が、**理由が変わる**: 「構造的に起きないから検査不要」ではなく「**起きても認証主体名義に固定してあるので server 側で無害化される**から検査不要」。
- **spec は凍結規律で書き換えない**。訂正の正記録は **`docs/architecture.md` §1 の追加行**(本 task で追加済み)。
- 「別 user のタグが表示される」こと自体は**既存 bug**で本 sprint の範囲外 → §5 の follow-up へ。

### 2.3 FK を `SET NULL` → `CASCADE` に張り替えた

`upload_operations.source_document_id` の NOT NULL 化は、FK action がそのままでは**両立しない**。`source_documents` 行が消えると SET NULL が発火し、NOT NULL 列への SET NULL は違反になる — 順序が不利なら**退会や exam 削除ごと失敗しうる**。

現物では `delete(sourceDocuments)` の単独経路が production に 0 件なので、CASCADE にして失われる記録も無い。ただし **「経路が無い」はコード現況であって DB 不変条件ではない**(Codex r3 の指摘)ので、`source_documents` の単独 DELETE 経路を新設する際に保持方針を再判断する旨を **architecture.md §2 と schema comment の両方**に残した。iso は削除 3 経路(exam cascade / 退会 handler / 直 DELETE)を分けて pin している。

### 2.4 DB CHECK = backstop / アプリ層 = SSoT(二重定義を地獄にしない形)

CHECK 27 本のうち `entity_mutations.op` と `assets.status` は、アプリ層に語彙の SSoT が既にある。schema.ts が値を import して CHECK 式を生成する「単一定義」案は、registry の型再編と schema.ts への runtime import が要り blast radius が大きいので**採らなかった**(簡潔性規律)。

代わりに **iso で集合一致を機械検証**する。しかも `pg_get_constraintdef` の**文字列比較ではなく**、アプリ層の語彙(`ENTITY_MUTATION_REGISTRY` の op key / `ASSET_STATUSES`)から**受理される INSERT と拒否される INSERT を動的生成**して実 PG に撃つ形にした — どちら向きの drift も red になる。この前提として `AssetStatus` を type-only alias から **runtime tuple 由来の導出へ反転**した(T7)。

語彙を増やすときの deploy 順(**CHECK を広げる migration が先・新値を書く code が後**)は schema comment に 1 行残してある。

### 2.5 `permanent-4xx` は「終端化」ではなく「自動 retry の対象外」

`classifyBulkError` の 400 分類は、**outbox の終端化(synced / failed)とは独立の軸**。400 を受けた client は outbox を terminal 化せず **pending のまま残す**ため、書込は放棄されない — 止まるのは自動 backoff だけで、次の自然 trigger で再送される。

これにより「permanent と分類したのに再送する」という見かけの矛盾が生じるが、意図的:契約 drift バグ由来の 400 で学習記録を failed 隔離すると、**server 側を直しても自然回復する道が断たれる**。データ保全を優先した。

`23502` / `22003` / `23514` は server 側欠陥でも起きうる(Codex 指摘)が、**書込放棄を伴わない**ので誤分類のコストは「backoff が止まる」だけ。constraint 名や処理段階まで見る精密分類は、この軽い帰結に対して過剰と判断した。

なお Sprint A spec §3 の「残る pending は transient のみ」はこの既知例外を持つ形になるため、architecture.md §1 の該当行に **T2 の commit(`1cc9729`)で既に 1 行追記済み**(本 task で現物確認 — 重複追記はしていない)。

---

## 3. review が設計を変えた箇所(結果だけ見ても分からないもの)

| # | 誰が | 何を指摘し、何が変わったか |
|---|---|---|
| 1 | Codex → **CC が却下** | tag delete に `rowUserId` を渡せ(P2×2)。→ `apply-tag-mutation.ts` の silent success を現物確認して却下。**受け入れていたら無害な no-op が実データ削除に変わっていた** |
| 2 | Codex → **CC が自分の指示を撤回** | 「outbox = row owner」が deferred 適用を生む(P1×2)。→ §2.1 の統一規則へ。**canonical はこれを見逃していた** |
| 3 | canonical | T4: `list.ts` の pin が「全 exam を返す」を検証していない(I)。→ PG-backed pin(archived_at を実タイムスタンプで立てた exam と NULL の exam の両方が返る)へ強化。**旧 `isNull` filter があれば必ず fail する形**にした |
| 4 | **iso gate(controller 実走)** | T5: implementer は「編集不要」と報告していたが、`publish-prepared.test.ts` の 2 test が削除済み bump を pin していて **iso が RED**。→ **未検証の主張だった**(実行していれば分かった) |
| 5 | canonical | T6: `exam-card-table-columns.tsx` の `?? ''` fallback が orphan outbox 行を生む(I)→ 修正 |
| 6 | canonical | T8: `submit-upload.ts` に 4 つ目の null 分岐があり、spec §1.10-6 の列挙が不完全だった(I)。**規則は正しく適用されたが list が漏れていた** |
| 7 | canonical | T8: 本 task が `source_documents.filename` / `file_size_bytes` を **write-only 化してしまった**(= sprint が消そうとしている歪み #6 そのもの)(I)→ §4 準拠の意図 comment を付与。**drop 判断は follow-up へ** |
| 8 | Codex | T8: 0027 世代の legacy NULL 行で `SET NOT NULL` が migration 全体を rollback させる(P1)。生成 SQL の手編集禁止ゆえ migration 層では解けず、**runbook §1.2 へ routing**。**owner 権限が無く全テナント確認ができないため「NULL 行なし」ではなく「未確認」と記録した** |

---

## 4. 保証の増減(test-only gate の記録)

CLAUDE.md の「test-only 変更は保証の増減で分岐」規律に沿った宣言の実体。

**増(red 検証あり)** — `1066446`:

> iso 検証群を **0035 の状態で先に書き 40/64 fail を記録** → 0036 適用後 **64/64 green**。検出力の実証。
> #11 / #12 の語彙一致 pin は文字列比較ではなくアプリ層語彙から受理・拒否 INSERT を動的生成(§2.4)。

**減(理由つき)**:

| commit | 落とした保証 | なぜ落としてよいか |
|---|---|---|
| `62013ca` | `publish-prepared` iso 3 箇所の `readExamCardCount` 断言 | 落とす保証 = 「publish 後に `exams.card_count` が実 card 数を反映する」。**それを維持していた bump 自体が消える**ので主張が成立しない。安全な理由 = (a) 列は後続 task で DROP するため「0 のまま」pin を置いても再削除になる (b) 同 test の `countCards` 断言が実 card 数を end-to-end で pin し、「bump しない」保証は unit の `tx.update` spy が担う |
| `1066446` | `archived_at` の iso test 2 件 / `file_size_bytes` の pin 3 件 / `referenceCount` の `not.toHaveProperty` 1 件 | **対象列が本 migration で消滅し主張自体が成立しない**。なお `ocr-owner-scope` の台帳照合は削除ではなく **filename → id-delta + pagesProcessed へ置換**(以前より強い) |

**保証不変** — `0664b90`(comment + 型等価の refactor のみ・test 変更なし)。

---

## 5. 未解決・繰越(claude.ai todo へ渡す follow-up)

1. **`tag_categories` / `tag_options` の mirror 読みが owner 無スコープ(4 経路)+ sign-out purge 不在** = 共有ブラウザで**別 user のタグが表示される既存 bug**。本 sprint は「表示される前提でも認可境界は破れない」ところまでを保証しただけで、**表示そのものは直していない**(§2.2)。
2. **`source_documents.filename` / `file_size_bytes` を将来 drop するか判断**。本 sprint で `upload_records` 側の同名 2 列を落とした結果、`source_documents` 側が **write-only になった**(§3-7)。歪み #6 と同じ形なので放置すると次の inventory で同じ指摘が出る。
3. **`completeUploadTx` / `markFailed` は production caller がゼロ**(test のみ)= 死関数の可能性。本 sprint の引数縮小で気付いた。
4. **`drizzle.config.ts` が offline generate でも `DATABASE_URL_ADMIN` を要求する**。`db:generate` は DB に接続しないので不要な要求。
5. **migration 0036 の適用**(stg → prod)と **stg smoke**。runbook 参照。**§1.2 の NULL 行確認は stg / prod のどちらに対しても未実行**。

### deferred minor(記録のみ)

- T2: `classify-bulk-error.ts` の header comment が permanent list に言及していない
- T4: `upload-form.test.tsx` の test 名に空白抜け(pre-existing style)
- T6: debounce test が flush を call count のみで assert / `runOptimistic*` の guard が非対称 / **他 user の stale 行が無制限蓄積**(spec 受容済 — runbook §5.3 に記載)

### 未捕捉の観測

T6 の実装中、full test が **1 回だけ fail**した(原因を捕まえられず、以降 5 回連続 pass。既知の flaky file は isolation で 3/3 pass)。green と断定せずに記録だけ残していたが、**本 task の gate では 278 files / 4756 tests が 1 回目で green**(下記)。既知 flake(`lib/sync/review-events.test.ts` の 1001-chunk 5 秒 timeout / `card-image-gallery.test.tsx`)も**再現しなかった** — 再実行はしていない。

---

## 6. sprint 完了 gate(全 exit 0・1 回目)

| gate | 結果 |
|---|---|
| `pnpm install --frozen-lockfile` | **exit 0** |
| `pnpm lint`(whole-repo・`--max-warnings=0`) | **exit 0** |
| `pnpm typecheck` | **exit 0** |
| `pnpm test` | **exit 0**(278 files / 4756 tests passed) |
| `pnpm test:iso` | **exit 0**(34 files / 414 tests passed) |
| `pnpm run audit` | **exit 0** |
| `pnpm build` | **exit 0**(`postbuild` の pdfium wasm packaging 検証も PASS) |

---

## 7. 次の phase(sprint 完了 ≠ deploy readiness)

sprint の完了は **code + docs** まで。deploy readiness は別 phase で、順序は:

**push → 【★ deploy 前に Dexie v10 を seed】→ code deploy → drain 確認 → backup(prod 必須)→ `pnpm db:migrate` → postflight 照合 → stg smoke(Dexie upgrade の実機 2 タブ + upload 一巡)**

**先頭の ★ を飛ばすと取り返しがつかない**: IndexedDB は origin scope なので、deploy 後に stg origin で `/app` を開くとその瞬間に v12 へ上がり、**「他タブが v10 接続を保持した状態での upgrade 調停」を二度と再現できない**(Vercel の deployment 個別 URL は別 origin なので回避にならない)。deploy 前に stg origin で v10 まで育てたタブを**開いたまま**にしておく。なお検証対象は「blocked のまま止まること」ではなく **Dexie 既定の `versionchange` 自動 close で upgrade が自力で完走すること**(期待値の取り違えに注意 — runbook §6.2(a))。

手順・診断 SQL・drain 不達時の分岐・postflight 照合は `docs/ops/sprint-b-db-cleanup-runbook.md` にある。**stg 適用は「データの入った 0035 DB → 0036」という経路の唯一の実証**(自動テストは常にまっさらな DB を頭から流すため、この経路を一度も踏んでいない)なので、診断と照合の**生出力**を残すこと。

---

## stg smoke(2026-08-13 JST・migrate/照合/2 タブ upgrade 完了後・CC 実走)

前提確認: IDB **v12(idbVersion=120)**・`user_settings` store 不在・`entity_mutations` = `[user_id+sync_status]` + `mutation_id`(空)・user = `85541b25-…`。旧 exam mirror 行の stale prop(archived_at 等)は spec どおり inert 残存(pull 再送時に置換)。

| # | 項目 | 判定 | 証跡 |
|---|---|---|---|
| 1 | upload 一巡(image → OCR → publish → 一覧) | **PASS** | UI「✅ 3 問を抽出・図版 1 件」→ exam `1b61e6bf…`。DB readback(app role・row_to_json): source_documents 全列に **mode / ocr_cost_yen キー無し**(filename/file_size_bytes は設計どおり残存・status=completed・cards_extracted=3)/ upload_records = **`{id, user_id, pages_processed, status, created_at}` のみ** / upload_operations = completed・source_document_id 充足 |
| 2 | 一覧件数の Dexie 動的集計 | **PASS** | 新 exam「カード 3 件」→ 問1 削除 → 詳細「カード (2 件)」即時・一覧「カード 2 件」・**server 実数も 2**(削除 mutation の server 適用まで一巡) |
| 3 | カード編集 + タグ並べ替え → bulk 200 | **PASS** | title 編集 → POST /api/entity-mutations/bulk **200**(req #54)・server title「問2(smoke 編集)」反映。カテゴリ DnD(keyboard)→ POST **200**(req #48)・server sort_key = 難易度 0 / ドメイン 1 / …(UI 順序と一致)。outbox は全行 synced・user_id 帰属正 |
| 4 | EXPLAIN(app role・実在 user) | **FAIL(基準未達・下記診断)** | 生出力 ↓ |

### smoke 4 の生出力と診断

自然 plan(app role・`85541b25-…`):

```
 Unique  (cost=1.31..1.32 rows=2 width=50) (actual time=0.088..0.091 rows=4 loops=1)
   Buffers: shared hit=4
   InitPlan 1
     ->  Result  (cost=0.00..0.26 rows=1 width=16) (actual time=0.030..0.030 rows=1 loops=1)
   ->  Sort  (cost=1.05..1.05 rows=2 width=50) (actual time=0.088..0.088 rows=4 loops=1)
         Sort Key: source_documents.exam_id, source_documents.created_at DESC
         Sort Method: quicksort  Memory: 25kB
         ->  Result  (cost=0.00..1.04 rows=2 width=50) (actual time=0.062..0.064 rows=4 loops=1)
               One-Time Filter: ((InitPlan 1).col1 = '85541b25-…'::uuid)
               ->  Seq Scan on source_documents  (cost=0.00..1.04 rows=2 width=50) (actual rows=4)
                     Filter: (user_id = '85541b25-…'::uuid)
 Execution Time: 0.128 ms
```

強制 plan(`SET LOCAL enable_seqscan = off`・診断のみ):

```
 Unique  (cost=2.07..3.82 rows=2 width=50) (actual time=0.172..0.175 rows=4 loops=1)
   ->  Incremental Sort  (actual time=0.171..0.172 rows=4 loops=1)
         Sort Key: source_documents.exam_id, source_documents.created_at DESC
         Presorted Key: source_documents.exam_id
         ->  Result  ...
               ->  Index Scan using source_docs_user_exam_created_idx on source_documents
                     Index Cond: (user_id = '85541b25-…'::uuid)
 Execution Time: 0.209 ms
```

診断(3 点・**0036 の regression ではない**):

1. **自然 plan の Seq Scan は表規模由来**(`relpages=1` — 表全体が 1 ページ)。runbook §4 が予告した「小規模では planner が index を選ばない」ケースそのもので、index の当否について何も言わない。
2. **強制 plan は `source_docs_user_exam_created_idx` を使う = index は健在・使用可能**。削除した `source_docs_user_exam_idx`(prefix)で出来たことは全て現 index で出来ることの実証でもある。
3. **「Sort ノードが無いこと」は現 query/index の組では原理的に達成不能**(既存問題の新発見): query は drizzle `desc()` = `created_at DESC`(暗黙 **NULLS FIRST**)を発行、index は `created_at DESC NULLS LAST`(0008 で作成)。PG の pathkey 照合は NULLS 位置まで厳密なため、`created_at` が NOT NULL で意味論的に同一でも planner は index 順を ORDER BY の充足とみなさず Incremental Sort を挿む。**0036 以前から存在**し(削除した prefix index はそもそも created_at を持たず同様に Sort が必要)、初めて実 EXPLAIN を取ったことで顕在化した。schema comment(D1)の「index 走査で解決する」は NULLS 位置の一致まで含めて初めて真になる。

follow-up 候補(修正せず報告のみ・指示どおり): query 側に `NULLS LAST` を付ける(drizzle: `sql`${col} DESC NULLS LAST``)か index を `DESC`(= NULLS FIRST)に揃えるかの 1 語変更で pathkey が一致し Sort が消える。created_at は NOT NULL のため挙動差はゼロ。行数が 1 ページに収まる現状では実性能差もゼロ(0.128ms)。
