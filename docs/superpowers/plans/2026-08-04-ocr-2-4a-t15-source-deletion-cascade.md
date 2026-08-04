# ②-4a T15 — 削除経路の source purge(経路 C 閉じ)実装 plan

> **For agentic workers:** 実装は `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)。各 task = 1 commit。

**Goal:** exam 削除 / 退会 の cascade で `source_assets` の行だけが消え R2 に source(著作物疑い)が永久 orphan として残る経路(fact-finding §4-C)を閉じ、加えて行を失った既存 orphan を回収できる網を作る。

**Architecture:** 主経路 = 削除トランザクションの**前**に、既存 `purgeOperationSources()`(T14b′ の net-safe collect)を対象 source_document 単位で呼び、R2 → 行の順で先に消す。網 = R2 prefix listing による row-less orphan sweep(row 駆動 GC が原理的に届かない領域を埋める唯一の手段)。

**Tech Stack:** Next.js server action / Clerk webhook handler / Drizzle + 実 PostgreSQL(RLS on)/ aws4fetch(R2 S3 互換 API)/ Vitest + tests/integration/pg(実 PG)。

## Global Constraints(全 task 共通・task からは参照のみ)

- **新軸(OT 確定・正本 = `docs/architecture.md` §6)**: source は R2 に残さない。**source が消え残る = 受容しない(最優先)** / provenance 消失 = 許容。
- **net-safe 順序(絶対)**: mark(`status='deleting'`・行残す)→ R2 DELETE → 行 DELETE。**行を R2 より先に消さない**。
- **削除失敗を silent に握らない**: 失敗は `integration_failures`(key=`r2_gc_delete_source`)+ `logger.error`。既存 purge の契約を変えない。
- 退会の既存仕様(users soft-delete + `app_scrub_deleted_user` scrub + Group I/II 削除設計)を壊さない。**物理削除に倒さない**。
- owner-scope 必須(`user_id` 条件)。app 層は `withTenantTx(userId, fn)`、scripts は `getAdminDb()`。外部 I/O(R2)は tx の外。
- 簡潔性規律: 既存 `purgeOperationSources` に乗る。新しい purge 機構・新テーブルを発明しない。
- 破壊経路ゆえ **commit は tagless → OT push → stg smoke → session doc で [reviewed] 正記録**(T14b′ と同じ扱い)。

---

## 0. 前提(確認済みの現物事実)

- 経路 C の入口は **2 つだけ**: `app/(app)/app/exams/_actions/delete-exam.ts:88` / `lib/clerk/handle-clerk-event.ts:217`(いずれも `tx.delete(exams)`)。他に production の exam/source_document 削除経路は無い(`grep delete(exams)` = seed script のみ)。
- `source_assets.source_document_id` = **NOT NULL + cascade**(`schema.ts:901-903`)。「FK を SET NULL して行を生かす」案は凍結 spec の schema 変更 → 採らない。
- `upload_operations.exam_id` = **NOT NULL + cascade**(`schema.ts:960-962`)。**PII(`prepared_payload`)は exam 削除・退会いずれでも既に cascade で物理削除される** → 旧 plan「Group I に追加」は現 schema では不要。T15 では**コードを足さず pin test で固定**する。
- **T14b′ 後の定常状態では、正常完了した exam の source 行は 0**(publish completed で同期 purge 済)。削除経路の purge が実際に仕事をするのは in-flight / 異常終了の残骸のみ = 通常は no-op。
- R2 key: source 最終 `users/{uid}/src/{assetId}.{ext}` / temp `users/{uid}/src/tmp/{assetId}` / 表示 asset `users/{uid}/{assetId}.webp` → **`users/{uid}/src/` が source を過不足なく囲む**。
- presigned PUT の既定 TTL = **600 秒**(`r2.ts:35`)、lease TTL = 15 分(`_lib/constants.ts:38`)。
- `lib/storage/r2.ts` に listing API は無い。

**旧 plan `### Task 15: GDPR Group I 統合` は本 plan で置換。**

---

## 1. 設計判断(記録)

**D1. 主経路 = 既存 `purgeOperationSources` の再利用。** `lib/media/source-purge.ts` は既に mark→R2→行の net-safe collect + loud failure + 冪等 + owner-scope を実 PG iso で pin 済み。削除経路は「対象 source_document を列挙して 1 件ずつ呼ぶ」だけでよい。`SourcePurgeTrigger` に `'exam_delete' | 'user_delete'` を追加する(union の役割は**任意文字列 trigger の禁止と呼出点の grep 可能性**であり、呼出漏れ自体を型が検出するわけではない — 完全性は「入口が 2 つしかない」現物事実と iso test で担保する)。

**D2. purge は削除 tx の「前」・tx の外。** R2 は外部 I/O ゆえ tx 内に入れない(T5 canonical 裁定「外部 I/O を跨いで lock を保持しない」)。順序 = 列挙 → purge(R2+行)→ 削除 tx(cascade)。

**D3. purge 失敗時の分岐は経路で非対称。**
- **exam 削除 = 中断**(`ok:false` + 既存 retryable 文言)。行が `deleting` で残り、row 駆動の網が従来どおり発見できる = net-safe 順序を字義どおり守れる唯一の形。**中断条件は `r2DeleteFailed > 0` のみ**(`rowDeleteFailed` は「R2 は消えたが行が残った」= source 残存ではないため中断理由にしない。その行は次回の cascade で消えて無害)。定常状態では purge 自体が no-op ゆえ、この中断路は事実上 in-flight 時のみ。
- **退会 = 続行**(GDPR 削除を R2 障害で止めない)。この分岐でのみ row-less orphan が発生しうるため、網(Task 3/4)が必須の対になる。

**D4. 既存 orphan の回収(prefix listing)は T15 に含める。** 根拠: (a) D3-退会が構造的に row-less orphan を生む。(b) fact-finding 経路 E(finalize の temp/lost-CAS 削除失敗)も row-less。(c) **presigned PUT の後着**(発行から最大 10 分)は行が cascade された後に object を生むため、DB 側のどんな fence でも閉じられず sweep でしか回収できない。(d) T14b′ smoke で実物 1 件検出済。**別 task に切ると「新軸達成」を宣言できる時点が来ない。**
コスト設計 = **2 段 listing**(`users/` を delimiter `/` で列挙 → 各 user の `users/{uid}/src/` のみ列挙)。表示 asset を舐めない。operator 手動・opt-in flag・dry-run・`--user` scope。

**D5. sweep の削除判定は 4 条件の連言(誤削除防止)。** ① `source_assets.object_key` に一致行が無い ② `lastModified < now - ORPHAN_MIN_AGE_MS`(既定 24h。導出 = presign TTL 10 分 + lease 15 分 + finalize 実行時間に対する大幅な安全余裕。prod で既定未満へ下げるのは reject)③ key が **正規文法**(`users/{uuid}/src/{uuid}.{ext}` または `users/{uuid}/src/tmp/{uuid}`)に一致 ④ **DELETE 直前に primary DB で不在を再確認**(LIST→DELETE 間の TOCTOU)。DB 照会失敗・listing 失敗・XML parse 異常は **fail-closed**(その user を skip・loud log)で、不明を orphan と解釈しない。

**D6. 新しい deletion ledger table は作らない(Codex 対案の不採用)。** 失敗の durable 記録は既に `integration_failures`(objectKey 込み)が担い、回収の網は prefix sweep が **row-less な object 集合を構成的に包含**する(台帳に載る失敗 object も、載らない後着 PUT も同じ prefix 下にある)。3 つ目の機構を足すのは YAGNI。**ただし残存時間の上限は sweep の実行頻度に依存する = 手動運用のままでは時間保証が無い**(§2-4)。

**D7. 表示 asset prefix(`users/{uid}/*.webp`)は対象外。** row 駆動 asset lane の管轄。orphan crop は別 follow-up(scope creep を作らない)。

---

## 2. OT 判断が要る点(plan 確定前)

1. **D4(prefix sweep を T15 に含める)** — CC 推奨 = 含める。切り出す場合、退会分岐 / 後着 PUT / 既存 1 件は T15 完了後も未回収で残る。
2. **D3-exam の「中断」** — exam 削除が R2 障害で失敗しうる UX を受容するか(定常状態では purge が no-op ゆえ発生頻度は極小)。代案 = 続行(orphan を作り sweep に委ねる。net-safe 順序の字義は破る)。
3. **退会 handler の inline purge 件数上限**(案 = source_document 50 件で打ち切り + loud log)。webhook を外部 I/O で長時間 block させない bound。上限超過分は sweep 依存になる。
4. **T15 完了時に何を「閉じた」と言うか** — 構造的な穴(経路 C)は閉じるが、**残存時間の上限は GC 自動化(公開前 follow-up)に依存**する。Codex 指摘どおり手動 sweep は時間保証を与えない。完了報告の文言をこの限定付きにしてよいか。

---

## 3. File structure

| file | 役割 |
|---|---|
| `lib/media/source-purge.ts` | `SourcePurgeTrigger` に 2 値追加(既存ロジック不変) |
| `app/(app)/app/exams/_actions/delete-exam.ts` | 削除 tx の前に purge / tx 内で残存再検査 / 失敗時中断 |
| `lib/clerk/handle-clerk-event.ts` | 削除 tx の前に purge(続行・失敗は台帳) |
| `lib/storage/r2.ts` | `listObjects()` 追加(ListObjectsV2 + 継続 token + delimiter) |
| `scripts/gc-image-assets.ts` | `runSourceOrphanSweep` lane + `--sweep-orphans` CLI |
| `tests/integration/pg/delete-exam-source-purge.test.ts` | 実 PG・exam 削除経路 |
| `tests/integration/pg/user-deletion-source-purge.test.ts` | 実 PG・退会経路 |
| `lib/storage/r2.test.ts` | list の parse / pagination / fail-closed unit |
| `tests/integration/pg/gc-source-orphan-sweep.test.ts` | 実 PG + R2 mock・sweep lane |

---

## 4. Tasks

### Task 1: exam 削除経路の同期 purge

- **目的**: `deleteExam` が exams DELETE を発行する前にその exam 配下の全 source を R2 ごと消し切り、消し切れなければ削除しない。
- **file**: `app/(app)/app/exams/_actions/delete-exam.ts`(`_deleteExam` = :39-108)/ `lib/media/source-purge.ts:47-54`(union)/ 新 iso test。
- **消費 IF**: `purgeOperationSources(userId: string, sourceDocumentId: string, trigger: SourcePurgeTrigger): Promise<PurgeOperationSourcesSummary>`(`source-purge.ts:81`。summary = `{ marked, r2DeleteOk, r2Delete404, r2DeleteFailed, rowDeleteOk, rowDeleteFailed, reclaimed }`)。
- **制約**: D1-D3 準拠。列挙 = `source_documents.exam_id = :examId AND user_id = :uid` の id 集合(tx 外 read・exam 不在/他 user は従来どおり silent success で purge も呼ばない)。purge は tx 外・1 件ずつ `trigger='exam_delete'`。**中断条件 = いずれかの summary の `r2DeleteFailed > 0`**(`logger.error` で loud・既存 retryable 文言を返す)。加えて**削除 tx 内で残存再検査**: 当該 exam 配下に `source_assets` が 1 行でも残っていれば DELETE せず中断(列挙後に始まった新規 upload を cascade で巻き込まないため)。tombstone / cascade / `revalidatePath` の既存挙動は不変。
- **完了条件**: 実 PG iso が RED→GREEN で示す — (a) source 2 件の exam 削除 → `source_assets` 0 行 + 両 key で `deleteObject` 呼出 + exam / `upload_operations`(`prepared_payload` 非 NULL のものを含む)0 行、(b) R2 delete 失敗 → exam が**残る** + 行が `deleting` で残る + 台帳記録、(c) 行 DELETE のみ失敗 → **削除は続行**(R2 は消えている)、(d) 列挙後に新規 source_assets が現れた場合は削除中断、(e) 二重削除が冪等、(f) source_assets を持たない legacy exam の削除が従来どおり成功。全 gate exit 0 → Crit0/Imp0 → **tagless commit**。

### Task 2: 退会経路の同期 purge

- **目的**: 退会 webhook が Group I 削除 tx を回す前に、その user の source を R2 ごと消す。GDPR 削除自体は R2 障害でも必ず完了させる。
- **file**: `lib/clerk/handle-clerk-event.ts`(`handleUserDeleted`)/ 新 iso test。
- **制約**: D1-D3 準拠。Stripe cancel ループの**後**・`runTransactionWithRetry` の**前**に purge を置く(削除 tx 本体・retry・scrub・Group I 列挙は不変)。対象 = `source_assets.user_id = :uid` の `source_document_id` distinct 集合(status 不問 = 前回失敗の `deleting` 残置も拾う)。`trigger='user_delete'`。purge 全体を try/catch で包み、**throw しても削除 tx へ進む**(`logger.error` + 既存 `recordFailure`)。件数上限(§2-3)超過は loud log で打ち切り、残りは網に委ねる。
- **完了条件**: 実 PG iso が RED→GREEN で示す — (a) 退会後 `source_assets` 0 行 + 全 source key で `deleteObject` 呼出 + `upload_operations` 0 行(`prepared_payload` 非 NULL を含む)+ users は soft-delete のまま(`deleted_at` セット・`email`/`clerk_id` NULL)、(b) R2 delete 全失敗でも**退会 tx は完走**(Group I 削除 + scrub 成立)し台帳に記録が残る、(c) source 列挙自体が throw しても退会 tx は完走、(d) webhook 再送(2 回実行)が冪等。既存 `route.test.ts` の Group I 不変条件 test が緑のまま。全 gate exit 0 → **tagless commit**。

### Task 3: R2 listing API

- **目的**: prefix sweep の材料。`lib/storage/r2.ts` に ListObjectsV2 を 1 関数だけ足す。
- **file**: `lib/storage/r2.ts` / `lib/storage/r2.test.ts`。
- **制約**: 既存 module の作法(`AwsClient` 再利用 / `retries:0` / `AbortSignal.timeout` 必須 / never-throw 正規化)。署名 = `listObjects(params: { prefix: string; delimiter?: string; continuationToken?: string }): Promise<{ keys: { key: string; lastModified: Date }[]; commonPrefixes: string[]; nextContinuationToken: string | null } | null>`(失敗 = `null`)。新規依存を入れず最小 parse(`<Contents>` の `<Key>`/`<LastModified>`、`<CommonPrefixes>` の `<Prefix>`、`<IsTruncated>`/`<NextContinuationToken>`)。key は XML entity decode を行う。**parse 異常(必須要素欠落 / 日時不正 / decode 不能)は entry を落とさず page 全体を `null` にする fail-closed**(entry だけ捨てると、その object が sweep から永久に不可視になる)。`IsTruncated=true` なのに token が無い場合も `null`。
- **完了条件**: unit が pin — (a) 複数 `<Contents>` の parse、(b) `IsTruncated=true` + token 返却、(c) `CommonPrefixes` 抽出、(d) 非 2xx / timeout / 壊れた XML / 欠落要素 / truncated-without-token で `null`、(e) entity を含む key の decode。typecheck0 / lint0 → **tagless commit**(破壊 lane で使うため Task 4 と同じ smoke gate に載る)。

### Task 4: row-less orphan sweep lane

- **目的**: 行を失った source object(退会分岐の残り・後着 PUT・経路 E の silent orphan・既存 1 件)を R2 側から発見して削除する網。
- **file**: `scripts/gc-image-assets.ts`(`runSourceReconciler`:622 / `buildSourceProductionDeps`:785 が構造の前例)/ `tests/integration/pg/gc-source-orphan-sweep.test.ts`。
- **消費 IF**: Task 3 の `listObjects()` / 既存 `deleteObject(objectKey)` / `recordIntegrationFailure({ key: 'r2_gc_delete_source', ... })`。
- **制約**: 既存 lane の作法(DI deps + `--dry-run` + `--user` + owner-scope + 台帳 + loud log)。2 段 listing(D4)で**両階層とも continuation token を最後まで辿る**。削除判定は D5 の 4 条件連言。**`--sweep-orphans` を明示指定した時だけ走る**(既定 `--sweep` に混ぜない)。prod で min-age を既定未満へ下げるのは reject(既存 `--grace-days` guard と同型)。listing / DB 照会の失敗は該当 user を skip して loud log(fail-closed)。削除成功は key 列を `logger.info` に残す(誰が何を消したかの追跡・PII 無し)。R2 DELETE 失敗 / timeout は台帳 + 続行、404 は成功扱い(冪等)。表示 asset prefix は触らない(D7)。
- **完了条件**: 実 PG + R2 mock の iso が RED→GREEN で示す — (a) 行のある key は消さない、(b) 行の無い古い key は消す、(c) min-age 未満は消さない、(d) 文法外 key は消さない、(e) LIST 後 DELETE 前に行が出現したら消さない(TOCTOU 再確認)、(f) dry-run は R2 DELETE を 1 度も呼ばない、(g) `--user` scope で他 user prefix を list しない、(h) 両階層の 2 ページ以上を辿る、(i) listing 失敗 user を skip し他 user は続行、(j) DELETE 失敗が台帳に残り走査は続行。RED = D5 の 4 条件それぞれの変異で fail。全 gate exit 0 → **tagless commit** + stg smoke 手順書。

---

## 5. 完了 gate(sprint 共通 + 本 plan 固有)

- whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit` 全 exit 0(報告 chat に各 1 行明記)。
- 各 task: canonical review(`superpowers:requesting-code-review`)→ `scripts/ai/codex-review.sh`(**new axis を diff コメントで明示**)→ Critical 0 / Important 0 → tagless commit。
- **stg smoke(OT push 後)**: ① exam 削除で source が R2 から消える(in-flight 残骸を作ってから削除)② 退会経路(実施可否は OT 判断・不能なら iso を正記録)③ orphan sweep: 既知 1 件が dry-run に出る → 実行で HEAD 404。**再現性のため、既知 1 件とは別に「行だけ消した source」を 1 件用意してから走らせる**(既知 1 件は一度消すと再現不能)。smoke PASS を session doc に記録して **[reviewed] 正記録**(push 済 commit の tag は追わない)。
