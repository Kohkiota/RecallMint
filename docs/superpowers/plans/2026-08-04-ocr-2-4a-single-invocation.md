# ②-4a S-1〜S-5 実装 plan: OCR+crop の 1 invocation 化

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。

**Goal**: upload を単一 server action(sync tx → after() で OCR+crop+publish)に統合し、source を R2 に置かない。
**Architecture**: spec = `docs/superpowers/specs/2026-08-04-ocr-2-4a-single-invocation-design.md`(5d800f6・§1/§4/§9 は anchor)。前進方式: S-1〜S-3 で新経路構築(S-3 で UI 切替)→ S-4 after() 化 → S-5 旧経路撤去。
**Tech**: Next 16.2.11 `after()` / postgres.js singleton pool / sharp / Gemini(既存 `callImageCropWithRetry`)。新規依存なし。

## Global Constraints(全 task 共通・task からは参照のみ)

- G→R→W: 先に test(red)→ 実装(green)→ 各 task 代表 1 つの **mutation injection で red 実証**(③に明記・revert して commit)。
- 各 task 完了条件に共通: canonical review + Codex 協調で Critical 0 / Important 0 → `[reviewed]` commit。tag と宣言は CLAUDE.md 規律どおり。
- Sprint 完了 gate: whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm test`(full)/ `pnpm test:iso` / `pnpm run audit` 全 green。S-1(page.tsx 変更)と S-5(schema/migration)は per-task で `pnpm typecheck` + `pnpm build` も踏む。
- AI は mock 必須(実 API 禁止)。429 即停止・リトライ禁止は既存 `callImageCropWithRetry` 挙動を不変で使う。
- 上限系定数は既存を再利用: 40 枚 / 1 file 5MiB / 合計 4MB / body 4.5mb(spec §10)。時間予算は暫定値(§台帳)・実測後見直し。
- OT push → stg smoke の順序は CLAUDE.md 標準フロー。**S-5 は S-4 の stg smoke pass 後にのみ着手**(新経路 GREEN → 旧経路撤去)。

## 設計決着(kickoff 論点・plan で確定)

### maxDuration 800 → 720 の形 = literal 維持 + drift pin test

**出所 = OT 追加決定(plan kickoff・spec 未反映)**: 800s では lease TTL 15 分に対し余裕 1.7 分で薄い → 720s(余裕 3 分)。実測(5 枚 23 秒)に対し 12 分枠は十分。spec §1-5 の「800」はこの決定で上書きされる(Codex #1 は kickoff 非参照による誤検・§採否)。

- 公式 doc の確認結果: v14 doc に「The values of the config options currently need be statically analyzable. For example `revalidate = 600` is valid, but `revalidate = 60 * 10` is not.」(https://nextjs.org/docs/14/app/api-reference/file-conventions/route-segment-config ・config options 全般 = maxDuration 含む)。現行 v16.3.0 doc(https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/maxDuration ・lastUpdated 2026-03-13)にこの文は**記載なし**だが、提示される形は literal(`export const maxDuration = 5`)のみで、import 定数を許す記載も無い。→ **記載なしの前提で「import 定数は使えない」に倒し、literal `720` を維持**。
- **Dashboard との関係(OT 確認済・公式 doc)**: Dashboard の Function Max Duration は**デフォルト値**であり route segment config が上書きする(https://vercel.com/docs/functions/configuring-functions/duration)。Server Action は呼出元 page の segment config を継承する。→ OT は Dashboard を 800 のままにし、**コード側 720 で実効 720** とする。
- 機械強制 = **drift pin test**(`next.config.test.ts` の bodySizeLimit pin と同型の「値 pin」)。ただし import 型でなく **fs+regex 型**: page.tsx を import すると client component(Dexie 等)まで vitest に引き込むため、`readFileSync` で `export const maxDuration = (\d+)` を抽出する。assert 3 本: ① **regex が一致しない(= 行が消えた)なら fail**(行が消えると Dashboard デフォルト 800 に戻り lease 余裕が黙って 1.7 分に縮むため、値の不一致と同格の失敗として扱う)② 値 = 720 ③ `maxDuration*1000 + 180_000 <= LEASE_TTL_MS`(margin 180s = OT 決定「720 なら余裕 3 分」の明文化。`LEASE_TTL_MS` は directive 無し共有 file `_lib/constants.ts:38` から import 可)。
- 付随: `_lib/constants.ts:28-37` の lease コメント(「現行 Vercel 関数上限(800s)」)を 720 に追随。移行期の注記: 旧経路の `OCR_OVERALL_DEADLINE_MS`(720s)は maxDuration と同値になり内部 deadline が名目化するが、実測(5 枚 23 秒)から実害なし・S-2 以降の統合予算で置換される。

### 論点 A: lease と supersede = 「拒否が勝つ」(順次関係・現行維持)

- 現物確認: `prepare-upload.ts:282-308` は既に順次関係 — claimed/prepared かつ **valid lease → `in_progress` 拒否**、lease NULL/失効 → 全 supersede。矛盾ではなく時間軸で直列。新経路も同一 semantics を `processing` に適用する。
- hard-death(spec §4.4 (d))と生存中の区別手段は**現構成に無い**(lease 書込は claim/takeover の 2 箇所のみ・heartbeat 不在 = spec §10)。旧 spec 補足 1 が同一問題を「heartbeat 無しでは原理的に解決不能・bounded residual として受容」と裁定済み — これを継承する。
- **拒否側に倒す根拠**: supersede 側に倒すと生存中 invocation の横取り(fencing が防ぐとはいえカード二重作成リスクの窓を自作)+ 二重 submit 防止の実質無効化。拒否側の副作用は「hard-death 後、lease 失効まで新規 upload 不可」で、**上限 = LEASE_TTL_MS(15 分)**。但し書き(誤読防止): 「最短 3 分」は **720s を走りきった直後に死んだ場合**の失効待ちであり、序盤の死亡では 15 分近くになる(待ち = TTL − 死亡時点の経過)。現行と同一挙動であり UX 後退ではない。
- ユーザーに見える挙動: ① hard-death 中は「処理中」表示 + 新 submit は in_progress 拒否 ② lease 失効後は次 submit の supersede で即再実行可。exam 削除でも cascade で gate は外れるが、**公開文言では削除を案内しない**(OT 決定: upload は既存試験への追加に対応しており(`prepare-upload.ts:59` の destination `'existing'`)、その場合の削除は既存カードごと消える(`delete-exam.ts:61` の child cascade)。押せることと案内してよいことは別)。spec §1-2「選び直し」は中断後の再開方式の話であり、この 15 分 bound とは別軸。
- **公開文言(面は 3 つ・文言は 2 種類。いずれも削除案内なし・待ち時間の数値なし)** — **2026-08-05 OT 裁定で改訂**(当初の「3 面共通」を上書き):

  | 面 | 状態の実体 | 文言 |
  |---|---|---|
  | (b) action が `in_progress` / (c) `/app/upload` 再訪時の処理中カード(`page.tsx` の `hasActiveProcessingUpload` gate) | **valid lease = 生きている**(でなければ supersede される) | **中立**。「処理中です。完了すると試験一覧に反映されます」相当。**中断を主張しない・再試行を勧めない** |
  | (a) poll が `failed` を返したとき | 確定失敗(terminal 化済み) | 「処理が中断された可能性があります。しばらく待ってから再度お試しください。処理状況は試験一覧で確認できます。」 |

  **当初 3 面共通とした根拠**は「ユーザーから見て failed と in_progress は区別できず、次の行動も同じ(待つか、やり直す)」だった。**S-4 の `after()` 化でこの根拠が両方とも崩れた**: ① **次の行動が同じでない** — `in_progress` の間は gate が弾くので「再度お試しください」は**実行不能な行動の案内**になる ② **支配的ケースが逆転した** — 以前は離脱すると処理が止まったが、now は離脱が正常で、戻ってきたユーザーの op はたいてい健全に実行中 ③ **自己矛盾** — submit 直後の banner が「閉じても処理は続きます」と離脱を勧めておきながら、その通りにして戻ったユーザーが最初に見るのが「中断された可能性があります」になる。

  hard-death のユーザーは最大 15 分「処理中」を見てから failed に変わるが、**これは正直な表示**である(生きているか死んでいるか区別できない間は区別できないと言い、確定してから失敗と言う)。lease 失効後は gate も開くため、**再試行の案内は実行可能になったタイミングでのみ出る**。
- **follow-up 起票(本 sprint では作らない)**: 実行中 op の即時キャンセル(user 起点の中断手段)は別の設計課題。

### 論点 B: decode 逐次実行 = **unit test で機械強制できる**(採用)

- 形: sharp を vi.mock し「呼出時に in-flight counter を increment / resolve で decrement、peak を記録」する計測 mock で、decode/verify loop(S-2)と crop loop(S-3)の **peak 同時実行数 = 1** を assert。mutation(`for await` → `Promise.all`)で red になる実検出力を持つ。新しい lint 機構や規律は増やさない(通常の unit test)。
- 補助としてコード comment(「メモリ見積り(spec §4.7)は逐次 decode 前提」)も残す。

## File map(新規/主変更のみ・撤去は S-5 に列挙)

- Create: `app/(app)/app/upload/_actions/submit-upload.ts`(新 action `submitUpload` + `submitUploadTx`)/ `app/(app)/app/upload/_lib/pipeline.ts`(after() から呼ぶ本処理 `runUploadPipeline(userId, opIds, files)` — OCR phase + crop phase + terminal 化 catch を含む)/ `app/(app)/app/upload/_lib/max-duration-lease.test.ts` / `tests/integration/pg/submit-upload.test.ts` / `tests/integration/pg/upload-pipeline.test.ts` / `drizzle/migrations/0031_*`(S-3: asset_derivations.source_asset_id nullable)/ `0032_*`(S-5: source_assets drop + 列 drop)/ `scripts/gc-src-prefix.ts`(S-5 one-shot・dry-run 既定)
- Modify: `page.tsx`(720)/ `_lib/constants.ts`(status 集合・統合予算 `UPLOAD_PIPELINE_BUDGET_MS` 暫定 660_000)/ `lib/db/schema.ts`(status union に `processing`)/ `lib/media/crop-and-store.ts`(バイト+寸法引数の新 entry)/ `publish-prepared.ts`(`fileSizeBytes` 引数化)/ `lib/exams/source-doc-status.ts`(live 述語)/ `app/api/exams/status/route.ts`(docStatuses)/ `upload-form.tsx`(S-3 切替・S-4 poll)/ `lib/integration-failures.ts`(catalog 新 key)

---

## Task S-1: 単一 action の骨組み(sync tx)+ maxDuration 720

① **目的**: `submitUpload(formData)` を新設。入力検証(件数≤40 / 各≤5MiB / 合計≤4MB / magic bytes)→ 1 tx(`submitUploadTx`: advisory lock → 冪等 replay lookup → live-op gate → daily cap → op(`status='processing'`)+ exam + source_document(`processing`)作成 + lease 発行)→ `{ outcome:'accepted', operationId, examId, sourceDocumentId }`。OCR/crop は `not_implemented` の即 terminal スタブ。UI 未接続。maxDuration 720 化 + pin test も本 task(lease 不変条件の確立と不可分)。
② **制約**: tx ロジックは `prepareUploadTx`(`prepare-upload.ts:196-308`)の advisory lock / replay / gate / supersede を**同 semantics で移植**(daily cap は `claim-operation.ts:289-305` と同型・同 tx 内)。冪等 replay は**状態不問で既存 op の 3 ID を返す**(completed / terminal も同様・終状態は client poll が表示する。同一 key = transport retry のみ — ユーザー再試行は client が submit ごとに新 key を発行する既存契約(`upload-form.tsx:553-556`・案 D)ゆえ dead op への固定は起きない。Codex #5 への裁定)。`source_documents.filename` の合成(1 件ならその名 / 複数なら「{先頭} ほか N 件」= `prepare-upload.ts:399-402`)と `pages_processed` = 受領枚数の意味は現行踏襲。schema.ts の status union と非終端集合 3 箇所(`source-doc-status.ts:85` / `gc-abandoned-operations.ts:56` / `prepare-upload.ts:277`)に `'processing'` を追加(DB CHECK なし・migration 不要)。lease は `now()+LEASE_TTL_MS`(PG 時計)。R2 module を import しない。
③ **完了条件**: iso(`submit-upload.test.ts`)— 同時 2 submit で片方 `in_progress`(valid-lease `processing` を gate が拒否)/ lease 失効 op が supersede される / cap 超過拒否 / 同一 key 再送が同一 3 ID に収束 / R2 client mock 呼出 0。unit — 入力検証境界(41 枚・5MiB+1・合計 4MB+1・偽 magic bytes)+ maxDuration pin(行存在 + =720 + `*1000+180_000<=LEASE_TTL_MS`)。**red 実証 3 パターン** = ① page.tsx を 900 に変異 → pin fail ② **`export const maxDuration` 行を削除 → pin fail** ③ lease 判定条件を外す → gate test fail。`pnpm typecheck` + `pnpm build` exit 0。Critical 0 → `[reviewed]`。
**既存 test 影響**: なし(maxDuration を pin する既存 test 無し・非終端集合 3 箇所への `'processing'` 追加は既存 assert と非衝突を full test で確認)。
**Produces**: `submitUpload(formData) → {outcome:'accepted', operationId, examId, sourceDocumentId} | {outcome:'in_progress'|'daily_limit_exceeded'|'invalid_input', …}` / `submitUploadTx(tx, user, input, files)` / status 値 `'processing'`。

## Task S-2: メモリのバイトで OCR → prepared commit

① **目的**: `pipeline.ts` に OCR phase を実装: 受領 Buffer 群を逐次 sharp decode 検証(旧 finalize の `verifyImageBytes` 相当・寸法確定)→ source_id を受領順で server 採番 → Gemini(`callImageCropWithRetry` + per-attempt `incrementAiUsage`)→ `normalizePrepared` → `prepared_payload` commit(CAS: `status='processing' AND lease_version=:mine` → `'prepared'`)。S-1 のスタブを OCR phase まで置換(crop は未実装のまま terminal スタブ)。
② **制約**: `normalize-prepared` / `prepared-schema` は無改変(spec §1-3)。userId は全層引数渡し(auth 再呼出なし — after() 化の前提)。統合予算 `UPLOAD_PIPELINE_BUDGET_MS`(暫定 660_000・台帳記録)から `deadlineAt` を 1 つ作り OCR に残余を渡す形をここで導入 — **起点 = action 入口時刻**(sync tx の時間も予算内・Codex 独立論点 8)。decode は**逐次**(論点 B)。**decode 1 枚でも失敗したら upload 全体を terminal にする**(現行 finalize 失敗と同義であり変更ではないが、「40 枚中 1 枚が壊れていたら全部やり直し」という挙動の決定としてここに置く。将来「壊れた 1 枚だけ除外して残りを OCR」へ変える場合の起点)。manifest 検証は移植しない(spec §4.2)。**失敗の分類・terminal 化・`integration_failures` 記録は全て pipeline 内部の責務**(throw しない契約)— after() 側(S-4)は薄い呼出のみ(Codex #3 の一本化)。
③ **完了条件**: iso(`upload-pipeline.test.ts`・Gemini mock)— payload commit までに R2 GET 0 回 / Gemini が受け取る inlineData = 渡した Buffer の base64 と一致 / commit 後 `status='prepared'` / `ai_usage` が attempt ごとに +1 / Gemini 失敗(429 / timeout / JSON 不読)で op terminal + doc failed が同一 tx。unit — decode 計測 mock で **peak 同時 decode = 1**。既存 `normalize-prepared` / `preparedPayloadSchema` の test が無改変 green。**red 実証** = pipeline に `getObject` 呼出を注入して R2-0 pin fail、decode loop を `Promise.all` 化して concurrency pin fail。
**既存 test 影響**: なし(旧経路 file 不触・新規 file のみ)。
**Produces**: `runUploadPipeline(userId, {operationId, examId, sourceDocumentId}, leaseVersion, files: {buffer, filename}[]) → Promise<void>`(全失敗を内部で terminal 化・throw しない契約)。

## Task S-3: メモリから crop → crop 済みのみ PUT → publish + UI 切替

① **目的**: crop phase を実装し publish まで通す。**この時点の `submitUpload` は `runUploadPipeline` を同期 await して完了後に返す**(after() 化は S-4・Codex #2)。`crop-and-store.ts` に **バイト+寸法を引数で受ける新 entry `cropFigureFromBuffer`**(source 行 SELECT と R2 GET を行わない・asset 行 INSERT → 条件付き PUT の順序と reserved 行の GC 回収は既存機構踏襲 = row-less orphan は構造的に生まれない・Codex #13)。**crop phase 全体を try/catch し、個別 figure 失敗は既存 disposition(crop_failed 等)、phase 共通の unexpected throw は残 figure を crop_failed 計上して text publish へ進む(publish tx 自体の失敗のみ terminal — spec §9-6「crop 失敗で OCR を巻き添えにしない」の実装・Codex #4)**。`publishPreparedUploadTx` の `SUM(source_assets.byte_size)`(`publish-prepared.ts:238-255`)を **`fileSizeBytes` 引数化**(旧経路は呼出側で SUM を計算して渡す・新経路は受領 Buffer 合計)。migration 0031: `asset_derivations.source_asset_id` を nullable 化(新経路は NULL・旧経路は継続書込。列 drop は S-5)。最後に **UI 切替**: `upload-form.tsx` の呼出列(prepare→reserve→PUT→finalize→claim→stage→publish)を `submitUpload` 1 本(同期 await・現行 UX 不変)へ差し替え。
② **制約**: crop ループは逐次 + `isCropBudgetExhausted` を統合予算の残余に付け替え(`deadline_excluded` 意味論不変)。crop 済み key は既存 `users/{uid}/{assetId}.webp` 形のみ。図版なし publish(`planPublish`)無改変。**commit 分離**: (a) 本体(crop/publish/migration)と (b) UI 切替を別 commit(kickoff 条件 6・cutover 前例と同型で切替 diff を1 file に閉じる)。切替では既存エラー文言マッピング(`upload-form.tsx:723-753` 相当)を新 outcome 集合(`in_progress` / `daily_limit_exceeded` / 検証エラー等)へ移植する。旧 action file 群は削除しない(S-5)。
③ **完了条件**: iso — R2 PUT の全 key が crop asset key のみで **`src/` を含まない** / crop 全滅 mock + **crop phase 共通例外の注入**の両方で text card publish に到達 / `upload_records.file_size_bytes` = Buffer 合計・`pages_processed` = files.length / **pipeline 二重起動を fencing(status + lease_version CAS)が拒否し cards/assets が増えない**(Codex #12 の明確化)。unit — crop 計測 mock で peak 同時 crop = 1。**red 実証** = PUT key に `src/` を注入して key pin fail。UI 切替後に local dev で upload 1 回実走(happy path)。stg smoke は OT push 後(5 枚 → cards + 図版 attach・cutover smoke §4 手順流用)。
**既存 test 影響**: `publish-prepared.test.ts:334-335`(`fileSizeBytes=SUM(source_assets.byte_size)` pin)を引数化契約へ追随改修(契約変更ゆえ feat commit 内)。`crop-and-store.test.ts` は旧 entry のまま green 維持(削除は S-5)。migration 0031 は snapshot 追随のみ。

## Task S-4: after() 化 + polling / auto-nav + 失敗表示 + live 述語簡素化

**着手前提(gate)**: OT の Vercel Dashboard 確認(Fluid compute 有効/無効・`/app/upload` の実 Max Duration)結果を受領していること。**未受領なら本 task に入らず停止**(spec §7 冒頭)。結果は session doc に記録(spec には値を書かない)。

**S-1 からの申し送り(必須前提)**: 新経路の op は client から一切終端化できない(S-1 の I-2: `'processing'` op は abandon を受け付けない — 実行中 invocation に対し client が `leaseVersion` を bump できず版一致 fencing が原理的に不成立)。回収は lease 失効後の reconciler / 次 submit の supersede / exam 削除の 3 経路のみ。**失敗表示 UI を「abandon を呼べば消える」前提で作らない**。論点 A の公開文言のうち **failed 面**(「しばらく待ってから再度お試しください」)はこの帰結と整合する(lease 失効後に gate が開くため、再試行の案内が実行可能なタイミングでのみ出る)。

① **目的**: `submitUpload` を「sync tx → 即応答 → `after(() => runUploadPipeline(...))`」に変更。**失敗処理の責務分担(OT 整理)**: `runUploadPipeline` = spec §4.4 の 5 クラスの**分類・terminal 化・`integration_failures` 記録の主責務**(S-2 の no-throw 契約のまま)。`after()` 境界 catch = **防波堤のみ** — no-throw 契約違反と pipeline 自身の failure-handler の失敗だけを最後に握り、best-effort 記録(logger.error + 可能なら `recordIntegrationFailure`)に留める。**分類ロジックを二重に持たない**。防波堤のもう半分 = **`after()` の登録呼出自体を try/catch し、失敗したら同期側で即 terminal 化する**(登録に失敗すると pipeline が一度も走らず内部 catch も発火しないため、spec §4.4 の (a)〜(e) いずれにも属さない穴になる。同期側 terminal 化が唯一の検出経路)。catalog 新 key `ocr_pipeline` を `INTEGRATION_FAILURE_CATALOG` に追加(Discord dual-write は既存 `recordIntegrationFailure` 経由)。`/api/exams/status` に `docStatuses`(sourceDocumentId → 'processing'|'completed'|'failed'・completed を明示値で)を additive 追加。upload page は自 doc を 5 秒 poll → completed で `router.push(result)`(auto-nav 案 a 吸収)/ failed で中断案内(**論点 A の公開文言 = 面は 3 つ・文言は 2 種類**。failed のみ「中断/再試行」を述べ、`in_progress` と再訪カードは**中立文言**。削除案内なし・待ち時間の数値なし)/ 縮退 2 条件で poll 停止 + 「試験一覧で確認」banner: 連続 6 回 fetch 失敗、または**絶対上限 20 分**(暫定・台帳。processing が返り続ける hard-death ケースの無限 poll 防止・Codex #7)。reload / 再訪時の poll 復元は scope 外(既存 exam 一覧 badge が回収・Codex #8 は不採用)。`isLiveUploadOperationCondition` を「非終端 + valid lease」のみへ簡素化(7 日 retention 枝除去)+ `reconcileStaleProcessing` が doc failed 化と同時に対応 op を terminal 化。
② **制約**: **応答前に `File.arrayBuffer()` を全件 Buffer 化し、request / File object を closure に渡さない**(Codex #10)。**pipeline 冒頭に開始 CAS**(op 存在 + `lease_version` 一致を確認・不一致/行消滅なら Gemini 呼出前に静かに終了 — 削除競合の課金を削る。以降の各 I/O 前の再確認はしない = 稀な競合の課金・orphan は bounded residual として受容し GC が回収・Codex #15)。after() 内は userId 引数渡しのみ(auth()/cookies() 不使用・`logger.warn` 以上)。`integration_failures` の context は operationId / エラーコードのみ(filename・base64・payload 禁止 = 既存 PII-free 規律・Codex #16)。既存 `statuses`(exam 粒度)と `exam-status-live.tsx` は無改変。reconciler の駆動源 = status API の poll(既存 `route.ts:99-106`)であり、「誰かがアプリを見ている限り lease 失効(≤15 分)+ poll 周期で failed 表示に収束・無人なら次回アクセス時」— 失敗表示文言はこの上限で書く(Codex #14)。`PREPARED_RETENTION_MS` 定数と claim 側 7 日 cap は S-5 まで触らない(旧経路 file が参照中)。abandonUploadOperation は呼出を外すのみ(file 削除は S-5)。
③ **完了条件**: iso — pipeline 内部に throw 注入 → op terminal + doc failed(同一 tx)+ `integration_failures` 1 行(key=`ocr_pipeline`)/ lease 失効 op を reconciler が terminal 化(**callback 不実行窓 = after() 登録失敗も同経路で収束することの保証を兼ねる**・Codex #9)/ 開始 CAS: 行消滅・lease 不一致で Gemini mock 呼出 0 / 簡素化後の live 述語で lease NULL op が即 supersede 可。unit — route の docStatuses(processing/failed/completed 明示・既存 `statuses` 不変)。**red 実証** = **pipeline 内部の terminal 化 catch を外して** throw-injection test fail(**検証対象 = pipeline 層**。境界 catch は「pipeline mock を throw させる unit 1 本」で best-effort 記録の発火のみ確認 — 分類 assert は置かない)。stg 実測(OT push 後)— submit 応答が本処理完了前に返る / **タブを閉じても completed 到達**(fact-finding §5 手順・実施 = OT または資格情報供与後 CC)/ poll → result auto-nav / 失敗注入(不正画像)で failed 表示。
**既存 test 影響**: 7 日 retention 前提の assert を lease 単独 semantics へ改修 — `reconcile-stale-processing.test.ts` / `gc-abandoned-operations.test.ts`(仕様変更ゆえ commit message に明記)。同系の `source-asset-state.test.ts` / `gc-source-assets.test.ts` は S-5 削除対象のため最小追随に留める。`exam-status-live` 系は無改変 green が条件。

## Task S-5: 旧経路撤去 + source_assets drop + stg `src/` 一掃

**着手前提**: S-4 の stg smoke pass(新経路 GREEN)。

① **目的**: 旧経路の全撤去。削除 file: `source-asset-actions.ts` / `prepare-upload.ts` / `claim-operation.ts` / `stage-prepared.ts` / `publish-prepared-orchestrate.ts` / `abandon-operation.ts` / `lib/media/source-purge.ts` / `lib/media/domain/source-asset-state.ts` / `gc-image-assets.ts` の source lane / `crop-and-store.ts` の旧 entry。migration 0032: `DROP TABLE source_assets` + `asset_derivations.source_asset_id` 列 drop + **`upload_operations.next_retry_at` 列 drop**(新経路で唯一 dead になる列。`attempt_count` / `last_error_code` は新経路も書くため残す — Codex #22 の明確化)。status union から `awaiting_sources`/`claimed` 除去(`prepared` は残る)+ `PREPARED_RETENTION_MS` / retry marker / backoff 定数の除去。**migration 0032 の stg 適用 = 不可逆点(OT push 判断がゲート・Codex #18)**。`db/policies` / `verify-rls-state` oracle / GDPR Group I(clerk deletion)から source_assets を除去。stg R2 `users/*/src/` prefix 一掃(`scripts/gc-src-prefix.ts`)— 安全条件(Codex #19): prefix regex 厳密一致(`^users/[0-9a-f-]{36}/src/`)/ pagination 全列挙 / dry-run 既定 + 一覧出力を session doc に保存 / 削除後 listing readback 0 件 / 実行は OT 指示下(確認→削除 2 段・既存破壊 script 規律)。**`listObjects()` は prefix を引数に取る汎用形で書く**(S-4 で登録した trigger 付き follow-up「crop lane の row-less orphan 検出」で asset lane に転用するため — `users/{uid}/` 配下の crop key 列挙に同じ関数を使えるようにしておく)。
② **制約**: `publishPreparedUploadTx`(publish-prepared.ts)と `normalize-prepared` / `prepared-schema` / `crop-geometry` は残す。legacy `process.ts` / `upload-guard.ts` は本 sprint 射程外(cutover の revert 保険・別 task 起票)。撤去に伴う test 整理: 削除 = `source-asset-actions.test.ts` / `source-asset-finalize` / `claim-operation` / `stage-prepared` / `source-purge` / `gc-source-assets` / `abandon-operation` の各 test・`prepare-upload.test.ts`(supersede 系は S-1 の submit-upload.test に移植済みであること)。改修 = iso fixture(`fixture.ts:183-196` の source_assets seed)/ `completeness.ts` / `global-setup.ts` / `publish-prepared.test.ts` / `crop-and-store.test.ts` / `derive-exam-statuses` 系。test 削除は「保証減」でなく対象消滅(commit message に理由明記)。
③ **完了条件**: **grep 0 件**(全 repo — `db/policies` / `scripts/` 含む。対象: `sourceAssets` / `source_assets` / `reserveSource` / `finalizeSource` / `purgeOperationSources` / `prepared_taken_over` / `stagePrepared` / `claimOperation` / `abandonUploadOperation` / `SourceManifestRow` / `isSourceManifestValid` / `PREPARED_RETENTION_MS` / `nextRetryAt` / `awaiting_sources` / `src/tmp` — 許容残 = migration SQL・docs・spec/plan)+ **DB catalog 検査**(stg: `information_schema` で source_assets 表と drop 対象列の不在を SQL 確認・grep の取りこぼし対策・Codex #17)。全 gate green(lint 0 / typecheck 0 / build / full test / test:iso / audit)。stg: migration 0032 適用 + `src/` prefix 空(listing で確認)+ GDPR 退会 iso green。Critical 0 → `[reviewed]`。

---

## Codex cross-check 採否(raw = `docs/codex/2026-08-04-plan-ocr-2-4a-single-invocation.md`・1 パス)

**採用(plan 修正済)**: #2 S-3 同期構造の明記 / #3 catch 責務の pipeline 内一本化(S-2 契約 + S-4 red 実証の整合)/ #4 crop 共通例外→text publish 倒し + iso / #5 replay 状態別規則の明記(挙動は現行踏襲 — 新 key 発行契約で dead-op 固定は不成立)/ #7 poll 絶対上限 20 分 / #9 callback 不実行窓の保証明記 / #10 Buffer 実体化制約 / #12 冪等 test の意味明確化(fencing 拒否)/ #14 reconciler 駆動源と収束上限の明記 / #15 開始 CAS(Gemini 前 1 回のみ・以降は受容)/ #16 記録の PII-free 明記 / #17 DB catalog 検査追加 / #18 不可逆点の明記 / #19 src/ 一掃の安全条件 / #22 next_retry_at 列 drop の明確化。独立論点 8(予算起点 = action 入口)も採用。

**不採用(理由付き)**: #1 maxDuration 720 は OT 追加決定(kickoff)であり plan 独断ではない(Codex は kickoff 非参照)/ #6 body 超過の action 前拒否 — client が合計 4MB を事前ブロック済(`totalExceeded`)+ 切替時の汎用 catch で表示(新規機構は作らない)/ #8 reload 後の poll 復元 — scope 外(既存 badge 経路が回収・YAGNI)/ #11 orientation 契約 — 旧 spec §4.3/§4.5(回転入力の明示除外・webp 再エンコード)を無改変継承済で新規リスクなし / ~~#13 R2 orphan GC test — 既存 asset lane(行先行 INSERT + conditional PUT + GC v2)踏襲で構造的に既カバー~~ → **【2026-08-05 訂正・S-3 実装時に現物で判明】この不採用根拠は事実誤認**。crop lane は **PUT 先行**(`crop-and-store.ts:454` の `putObject` → その後に `assets` 行 INSERT)で **reserved 状態を持たない**(`:495`「crop-derived asset は常に 'ready' で直接 INSERT する設計(reserved 経由ではない)」)。行先行 + reserved は client 添付画像 lane の機構であり crop lane のものではない。したがって「PUT 成功 → 行 INSERT 失敗」で row-less orphan は**生じうる**(Codex #13 の指摘は妥当だった)。ただしこれは**旧経路が prod で既に持つ性質**で S-3 の新規退行ではないため、S-3 は既存機構をそのまま共有した(順序変更 = 保存機構の新設ゆえ別 task 起票が妥当)。**要 OT 判断**: 別 task 起票の要否/ #20 4MB vs 40 枚×0.5MB — 現行 UI 仕様の踏襲・値の妥当性は spec 非スコープ / #21 filename/metadata 契約 — 現行規則踏襲を S-1 に明記のみ。独立論点 12(Gemini 送信自体のプライバシー)= 本 sprint の変更外(現行も送信・公開前 PII バケットの既存台帳)。

## 修正後 verification(OT 指示・別枠 1 回・raw = `docs/codex/2026-08-04-plan-ocr-2-4a-single-invocation-verify.md`)

OT 修正 3 点(削除案内の撤去 / 3 面文言 / catch 責務整理)反映後の確認走行。修正 3 点への直接指摘は **#16(failed と in_progress の同趣旨文言は確定失敗と処理中を混同)のみ — 不採用**(OT 決定 = 3 面同趣旨。確定失敗面でも「再度お試しください」は正しい案内 — terminal 化済みで gate は外れており即再試行可)。plan 本文はこれ以上変更しない(OT 指示: 3 点の追記で足りる)。

- **実装時に吸収する小粒 7 件(task 実装者への注記・plan 構造は不変)**: after() 登録呼出自体を try/catch し失敗は同期側で即 terminal 化(S-4・verify#1)/ decode 1 枚失敗 = upload 全体 terminal(現行 finalize 失敗と同義・S-2・verify#9 前段)/ prepared commit 前の R2 PUT 0 件を iso で assert(§7.3 の test 化・S-3・verify#11)/ `docStatuses` の tenant 分離 assert(S-4・verify#14)/ crop 共通例外時、例外前に attached 済の figure は採用し未処理分のみ crop_failed(S-3・verify#10)/ 反復ごとに decode 結果への参照を解放・crop 出力は即 PUT(論点 B 補足・verify#5,6)/ phase 別所要時間の PII-free log を pipeline に含める(実測材料・S-2・verify#18,21)。S-4 前提の OT Dashboard 確認に**メモリ割当**も含める(verify#3)。
- **不採用(理由)**: #2 reconciler 時間保証 = plan 既記載(「無人なら次回アクセス時」と明記済・過大表現なし)/ #4 lease 式の終了余白 = 2 段 margin(660+60s / 720+180s)で表現済 / #12 S-3 同期切替の露出 = 現行 production と同一挙動でリスク新設なし(§9-7 OT 確定)/ #17 completed 境界 = publish tx の原子性(doc completed + cards 同一 commit)で既成立 / #7 multipart 境界・#9 入力 fingerprint = 初回パス #6・#5 で採否済みの再演 / #13 開始 CAS 後の競合区別 = §4.4 (e) で既定義 / #15 poll 停止後の表示 = 縮退 banner が終端表示・一覧 badge が回収 / #19 deploy 混在窓・#20 bucket 誤選択 = 実ユーザー 0 + OT push ゲート + 既存破壊 script 規律(env 目視)で受容。

## 残る不明(plan 時点)

- Fluid compute / 実 Max Duration(S-4 前提・OT 確認待ち)。~300s 関数消滅の未解明事象は S-4 stg 実測で再観測されたら停止して OT。
- 40 枚 upper-scale の実測(統合予算 660s 暫定の妥当性)— S-3 smoke 以降に実測、値の確定は台帳へ。
- `after()` callback throw の framework 側挙動(公式 doc 記載なし)— 全包 try/catch で設計済・S-4 の throw-injection iso が保証。

## 台帳(暫定値・実測後見直し)

`UPLOAD_PIPELINE_BUDGET_MS = 660_000`(< maxDuration 720s − 60s margin)/ maxDuration-lease margin 180s(pin test 内 literal)/ poll 5s・error 縮退 6 回 — いずれも spec 非スコープ「値の妥当性」に属し、実測(S-3/S-4 smoke)後に確定。
