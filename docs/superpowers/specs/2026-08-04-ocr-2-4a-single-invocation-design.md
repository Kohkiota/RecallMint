# ②-4a S-1〜S-5 設計 spec: OCR+crop の 1 invocation 化(source を R2 に置かない)

- 日付: 2026-08-04 / 状態: **ドラフト(OT + claude.ai レビュー待ち)**
- 前提 fact-finding(固定入力・再オープンしない):
  `docs/audit/2026-08-04-why-source-goes-through-r2.md` /
  `docs/audit/2026-08-04-ocr-crop-invocation-split-factfinding.md` /
  `docs/audit/2026-08-04-single-invocation-feasibility-factfinding.md`
- 旧 spec(②-4a 本体)= `docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md`。本 spec は同 spec の **prepare→publish の不変条件を引き継ぎつつ、invocation 構造と source 保存を置き換える**。

## 0. スコープ / 非スコープ

- **スコープ**: upload の OCR+crop を 1 つの server action invocation に統合し、source(元画像)を R2 に一切置かない。R2 には crop 済みパーツのみを置く。`after()` 化 + polling 完了検知。旧経路(reserve/finalize/claim/stage/publish の 5 action 列 + `source_assets` 表)の撤去。
- **非スコープ**: ②-4b(PDF)。時間予算・枚数上限の値の妥当性(実測後に決定・足りなければ枚数上限で調整)。prompt / schema / crop 品質。
- **破壊的変更は自由**(実ユーザー 0)。何を壊すかは §8 に列挙。

## 1. 確定前提(kickoff anchor の要約)

1. source は R2 に「置かない」。server が受け取り、同一実行単位内で OCR + crop を完了、R2 は crop 済みのみ。
2. 中断時はユーザーが画像を選び直す(再アップロードなし再開は要件外・Gemini 再課金許容)。
3. 方式 = 前進(新経路を作って切替)。`normalize-prepared` / `prepared-schema` / `publishPreparedUploadTx` / `crop-geometry` は再利用。
4. `after()` は Server Action で使える(公式 doc: https://nextjs.org/docs/app/api-reference/functions/after 「Server Functions」に明記・v15.1.0 stable・repo は Next 16.2.11・`next/server` 同梱で新規依存なし)。
5. `after()` の実行時間 = route の `maxDuration`(同 doc「Duration」節)。`app/(app)/app/upload/page.tsx:16` の `maxDuration = 800` がそのまま適用。追加枠なし。
6. `after()` callback 自身の throw の扱いは**公式 doc に記載なし = 不明**。自前 try/catch + `integration_failures` で受ける(§5)。
7. 図版なし publish は実装済み(`publish-prepared-plan.ts` が crop_failed / deadline_excluded を exclusion 計上して publish)。
8. polling 基盤は既にある(`/api/exams/status` 5 秒 poll + `requestOcrPoll()`)。auto-nav 案 a は S-4 に吸収。
9. client 切断で function は終了しない(`supportsCancellation` は opt-in・repo 全体 0 件。公式 doc: https://vercel.com/docs/functions/functions-api-reference#cancel-requests)。ただし Fluid compute 有効/無効・実 Max Duration は **repo から判定不能 = OT 確認事項**(fact-finding Part1 §2)。

## 2. 新アーキテクチャ

```
ブラウザ: 圧縮(webp・最大辺 2048・~0.5MB/枚)→ FormData(File[] + 宛先 + idempotency key)で単一 action へ
┌─ processUploadV2(仮名)──────────────────────────────────────────┐
│ 【sync phase(応答前)】1 tx:                                      │
│   入力検証(件数≤40・各≤5MiB・合計≤4MB・magic bytes)              │
│   advisory lock → 冪等 replay lookup → live-op gate → daily cap 判定 │
│   → operation('processing')+ exam + source_document('processing')   │
│     作成 + lease 発行(メモリ保持・client に渡さない)               │
│ → 即応答 { operationId, examId, sourceDocumentId }                   │
│ 【after() phase(応答後・同一 invocation)】try/catch 全包:          │
│   sharp decode 検証(寸法・decodability = 旧 finalize 相当)         │
│   → Gemini(inline base64・incrementAiUsage per attempt)             │
│   → normalize → prepared_payload commit(status='prepared')          │
│   → メモリのバイトから crop(asset 行 reserved → R2 PUT crop のみ)  │
│   → publishPreparedUploadTx(cards/tags/refs/status='completed')     │
│   catch → op terminal 化 + doc failed 化(同一 tx)+ 失敗記録(§5)  │
└──────────────────────────────────────────────────────────────┘
client: 応答受領後は doc 粒度 poll(§6)→ completed で result へ auto-nav / failed でエラー表示
```

- バイトは request body で 1 回だけ server に入り(`bodySizeLimit: '4.5mb'` `next.config.ts:69` > OCR 上限 4MB)、invocation 終了で破棄。R2 への source PUT/GET は 0 回。legacy `process.ts` が同型の先例(FormData 受領 → `arrayBuffer()` → base64)。
- **crop 元 = Gemini に送ったバイトと同一**(旧 spec §4.2)は、同一メモリ上の Buffer を両方に使うことで R2 往復より強く成立。finalize の immutability 保証(Codex P1 の TOCTOU 対策)は**保護対象ごと消滅**する。
- 座標系の一致: 旧 finalize の `verifyImageBytes`(`source-image-verify.ts:123-161`)と crop は共に `.rotate()` を呼ばない decode で寸法を得る(`crop-and-store.ts:336-340` に明記)。新 flow は**同一 Buffer への同一 sharp 呼出**で width/height を得るため、DB 列(`source_assets.width/height`)と同値になる — 分母の代替は成立(裏取り済)。

## 3. Step 0 unknowns の解決結果(現 HEAD 裏取り済)

1. **中断 op / カード 0 件 exam の UI 削除 = 可能・fix 不要**。削除ボタンは `/app/exams` 一覧に無条件表示(`exam-list-live.tsx:125`・status/件数による無効化なし)。`deleteExam` は `exams` DELETE のみで FK cascade が `upload_operations`(`schema.ts:960-962`)/ `source_documents` / `source_assets` を連鎖削除(`delete-exam.ts:88-90`)。live-op gate は upload 開始のみに効き削除には効かない。
2. **`after()` 内の `integration_failures` 書込 = 構造上可能**。DB 接続は module スコープ singleton pool(`lib/db/index.ts:10-27`)で request lifecycle に紐付く close は無い(`closeDb` は script/test 専用・`:63-66`)。`withTenantTx(userId, fn)` は request 非依存(`tenant-tx.ts:29-37`)。`recordIntegrationFailure`(`integration-failures.ts:126`)は `getNonTenantDb()` 直・INSERT のみ grant・Discord dual-write(3s timeout)込み。**要改修 2 点**: ① publish orchestrator が自前 auth する構造(`publish-prepared-orchestrate.ts:240-242`)→ userId 引数受けに 1 段割る ② `INTEGRATION_FAILURE_CATALOG` に OCR/upload 用 key が無い → 新 entry 追加。補足: `logger.info` は production で不可視(既定 warn)→ after() 内の観測ログは warn 以上。
3. **polling は表示でなく状態判定**。`/api/exams/status` は `source_documents.status`(DB 実列)を唯一のソースに derive(`derive-exam-statuses.ts:59-111`)。ただし新設計に効く 3 つの gap を確認: ① 返却は **exam 粒度**で completed は「key 不在」表現(doc 粒度の status は返らない)② 失敗表示は一覧の赤バッジのみ(理由なし)③ **lease 失効は表示を終わらせない** — live 判定は `created_at` 7 日 retention が支配的(`source-doc-status.ts:83-91`)で、invocation 死亡時「処理中」が最大 7 日残る。→ §6 で対処。

## 4. 設計論点の決定

### 4.1 `source_assets` 表 = drop する(claude.ai 見立てに同意・現物で代替を確認済)

全 17 列の使用実態(専用調査・全 grep 網羅):

| 失う値 | 現在の唯一の用途 | 代替(裏取り済) |
|---|---|---|
| `byte_size` | claim の実測 SUM ≤4MB 検査(`claim-operation.ts:371-378`)+ `upload_records.file_size_bytes`(**production 読者ゼロ**の write-only) | 受領 Buffer 長の直接検証(同一 request 内 = 現行より強い)。publish tx へ引数渡し |
| `width` / `height` | crop の座標変換分母(`crop-and-store.ts:360` の 1 箇所のみ) | 同一 Buffer の sharp decode(§2・同値保証) |
| `mime` | Gemini `inlineData.mimeType` | `sniffMagicBytes` をメモリ上で(既存関数) |
| `object_key` | R2 GET/PUT/purge | R2 に置かないため不要 |
| `source_id` | Gemini parts 順序 + figure→source 解決 | **server が受領順から採番**(invocation 内で完結)。client 発行(旧 spec §5.2)の理由 = 別 invocation 間の対応固定、は前提ごと消滅するため一本化 |
| `original_filename` / `content_hash` / `ready_at` / `source_kind` / `page_count` / `rotation` / `rasterizer` | **production 読者ゼロ**(schema/migration/test のみ) | 不要。filename の読者経路は `source_documents.filename` 側(別系統・維持) |
| `expected_source_count` | — **`upload_operations` 側の列**(`schema.ts:985`)。影響なし | 列は残す。ただし manifest oracle の役割は消え、`files.length` の bookkeeping に降格(§4.2) |

- **②-4b(PDF)予約列(`source_kind`/`page_count`/`rotation`/`rasterizer`)は「source を R2 に保持する」前提の設計**(schema コメント `schema.ts:888-889`)。新軸では PDF も同様に server 受領 → メモリ rasterize → crop のみ R2 となるべきで、page 概念は prepared_payload / `asset_derivations` 側(figure の page 属性)で表現できる。**表を残すと「保持前提だった」と将来誤読される**ため drop が正。②-4b を阻害しない。
- **副作用 1**: `asset_derivations.source_asset_id`(FK cascade・`schema.ts:1024-1026`)の参照先が消える。→ **列を `source_id text NOT NULL` + `source_width integer` + `source_height integer` に置換**(提案)。理由: bbox は 0-1000 正規化で保存されており、分母(source 寸法)が無いと px 変換の事後検証が再現不能になる。切り直し(旧 spec §10 の動機)は source 非保持で原理的に不能になるが、座標バグの事後調査価値は残る。代替案 = 単純 drop(§9 論点 2)。
- **副作用 2**: claim の server 実測サイズ enforcement の移設 → sync phase の受領時検証(§2)。

### 4.2 manifest 検証 = 概念ごと廃止

現行 3 サイト(claim `claim-operation.ts:336-378` の FOR UPDATE 5 分岐 / stage の fast-fail `stage-prepared.ts:216` / commit 直前 re-check `:296`)は、いずれも「**別 tx・別 invocation が見る DB 行集合が、claim〜stage 間の外部 I/O 窓で欠落・deleting 化していないか**」の drift 検出である(`stage-prepared.ts:92-103` に明記)。1 invocation では source はメモリ上の files 配列であり、①検査対象の DB 行が存在しない ②外部 I/O 窓に別状態が挟まる余地がない(配列は immutable)。**検出すべき drift が定義不能になるため、検証は概念ごと消える**。残るのは受領時の入力検証(件数・サイズ・magic bytes・decode)で、これは manifest 照合ではない。

### 4.3 lease / claim / fencing の再設計

| 機構 | 判定 | 設計 |
|---|---|---|
| `idempotency_key` UNIQUE + user advisory lock(`prepare-upload.ts:196-205`) | **残す** | sync phase の 1 tx に統合。同一 key の replay は既存 op を返す(after() を再スケジュールしない = Gemini 再実行なし) |
| live-op gate | **残す(条件を簡素化)** | 「非終端 op かつ **valid lease**」のみ block。7 日 retention 枝(`PREPARED_RETENTION_MS`)は撤去(§5) |
| daily cap | **残す** | 判定 = sync phase の同一 tx(現行 claim 手順 3 と同型・非原子受容は不変)。計上 = after() 内 Gemini call 直前 per-attempt(`incrementAiUsage`・現行どおり) |
| lease | **残す(意味変更)** | 「実行中 invocation の生存表明」専用。sync phase で発行、terminal 化で NULL。**heartbeat 不要**: `LEASE_TTL_MS`(15 分)> `maxDuration`(800s)を不変条件として明文化(現行コメント `constants.ts:28-37` の考え方を継承) |
| `lease_version` の client 往復 | **廃止** | 発行値を invocation メモリで保持。action 署名から leaseVersion が消える |
| 状態 CAS(WHERE status + lease_version) | **残す(最小限)** | payload commit / publish finalize / terminal 化の各 UPDATE に維持。万一同一 op を 2 invocation が持った場合(transport 重複の極小窓)のカード二重作成防止 = 旧 F6 の「唯一の権威 gate」(`publish-prepared.ts:41-46`)を継承 |
| `prepared_taken_over`(T12b) | **廃止** | takeover の動機(バイト再送なしの publish 再開)が前提ごと消滅。client 分岐(`upload-form.tsx:676-679`)も撤去 |
| retry marker(`next_retry_at` / `RETRYABLE_BACKOFF_MS`)・再 claim 分岐・7 日 cap(claim 手順 2.5) | **廃止** | resume が存在しないため retryable 状態自体が消える。全失敗は terminal(§5) |
| 二重 submit 防止の担保 | — | 入口 1 点(sync phase tx): advisory lock で直列化 → live-op gate で valid-lease op を `in_progress` 拒否 → 冪等 replay。after() 実行中は lease が生きているため第 2 submit は必ず拒否される |

### 4.4 `after()` の失敗設計(silent failure ゼロ)

前提: callback throw の扱いは公式 doc 記載なし(§1-6)。**callback 最上位を try/catch で全包し、フレームワークに例外を渡さない**。

| 失敗クラス | 処理 | 記録先 | ユーザーに見えるもの |
|---|---|---|---|
| (a) 予期される失敗(Gemini エラー/429/timeout・JSON 不読・有効 card 0・decode 失敗) | op `terminal_failed` + `last_error_code` + doc `failed` を**同一 tx**(`terminalizeAbandonedOperation` の教訓 = 旧 spec §3.1 を継承) | op 行(error code)+ logger.warn | poll が failed を返し upload page がエラー表示(§6)。離脱後は一覧の「失敗」バッジ |
| (b) 予期しない throw | (a) と同じ terminal 化 + **`recordIntegrationFailure`(新 catalog key・Discord 通知)** + logger.error | integration_failures + Discord | 同上 |
| (c) terminal 化自体の失敗(DB 断) | `recordIntegrationFailure` を best-effort(それも失敗なら logger.error のみ) | 可能な範囲で | lease 失効(≤15 分)→ reconciler が doc failed 化 + **op も terminal 化**(§5 で新設)→ 赤バッジ |
| (d) hard-death(OOM・platform kill = catch 不達) | 検出者なし(構造上不可避) | なし | (c) と同じ失効経路で ≤15 分 + sweep 周期で failed 表示に収束 |
| (e) 処理中のユーザー削除競合(exam 削除 cascade で op/doc 行消滅) | CAS が 0 行 → 正常系として静かに中断(ユーザー起点のため escalate しない)。PUT 済 crop asset は ref ゼロ → 既存 GC lane が回収 | logger.warn | なし(本人が削除した) |

- crop 部分失敗・全滅は失敗ではない: 既存 `planPublish` の exclusion 計上 + text card publish(旧 spec §8.3)を不変で継承。
- 429 は既存どおり即停止・リトライ禁止(`callImageCropWithRetry` の挙動不変)。

### 4.5 op 状態機械の改訂

- **新経路の状態**: `(なし) → processing → prepared → completed | terminal_failed`。
  - `processing`(**新値**・§9 論点 1): sync phase で op 作成と同時に。`awaiting_sources`(source 待ちが存在しない)と `claimed`(claim が独立 invocation でない)は新経路で不使用。
  - `prepared`: payload commit 時の checkpoint として**維持**(§9 論点 3)。crash 時の forensics(どこまで進んだか)+ 旧 spec §7.3 の順序不変条件「**crop-derived asset 行・R2 object は prepared commit 後にのみ**」の観測点。挙動分岐には使わない(UI は processing と同扱い)。
  - status 列は text + TS union(DB CHECK なし・現物確認済)ゆえ値追加に migration 不要。非終端集合のハードコード 3 箇所(`source-doc-status.ts:85` / `gc-abandoned-operations.ts:56` / `prepare-upload.ts:277`)を更新。
- **中断時に残る状態と回収**: `processing` / `prepared` + lease 失効。回収 3 経路 = ① reconciler(≤15 分で doc failed 化 + op terminal 化・§6)② 次 submit の supersede(既存 `prepare-upload.ts:294-307`・維持)③ ユーザーが exam ごと削除(Step 0-①・可能)。**カード 0 件 exam も削除可能**のため「消せないゴミ」は生まれない。
- `prepared_payload` は publish 成功で NULL 化 / terminal 化で NULL 化(既存規律不変)。手動 sweep script(`gc-abandoned-operations.ts`)は残置するが、reconciler の op terminal 化により主経路ではなくなる。

### 4.6 時間予算の統合(形のみ・値は実測後)

- **単一予算 + 残余参照**: invocation 開始時刻を起点に `deadlineAt = start + UPLOAD_PIPELINE_BUDGET_MS`(暫定値・`maxDuration` − margin 未満を不変条件)を 1 つだけ作り、全フェーズが「残余」を参照する。
  - OCR: 既存 `OCR_OVERALL_DEADLINE_MS`(720s・OCR 内部予算)を「残余 − crop 最低保証」との min に置換。
  - crop: 既存 `isCropBudgetExhausted`(残余 < `CROP_MIN_REMAINING_MS` で `deadline_excluded`)の deadline を統合予算の `deadlineAt` に付け替え。per-crop の sharp `.timeout()` / R2 I/O timeout / Gemini 自前 abort は不変(各操作の hard cap)。
- `CROP_PHASE_BUDGET_MS`(per-invocation 600s)は概念ごと統合予算に吸収。`deadline_excluded` の意味論(text card publish への倒し込み)は不変。
- 予算超過は「静かな縮退」でなく exclusion 計上 + result_summary 反映(既存)。値の確定は cutover 後実測(kickoff 前提 9)。

### 4.7 メモリ保持の見積り(上限枚数で成立)

同時保持: 原本 Buffer 合計 ≤4MB(client 圧縮上限・`constants.ts:18`)+ Gemini 送信用 base64 文字列 ≈5.5MB + Gemini 応答 payload(高々数 MB)+ decode は**1 枚ずつ逐次**(検証・crop とも)。decode 1 枚 = 圧縮上限の最大辺 2048px → 2048²×4ch ≈ **16.8MB**、guard 上限でも `DECODE_MAX_PIXELS`(40MP・`source-image-verify.ts:38`)≈160MB。**peak ≈ 数十〜200MB < Vercel 既定メモリ 2GB**(公式 doc: https://vercel.com/docs/functions/configuring-functions/memory 「By default, on Pro and Enterprise, functions execute with 2 GB」last_updated 2026-06-16)。40 枚でも原本合計は 4MB cap で抑えられており、decode を並列化しない限り成立。**decode の逐次実行を実装制約として明記**。

## 5. polling / 完了検知(S-4)

- `/api/exams/status` を **doc 粒度に拡張**(additive): 応答に `docStatuses: { [sourceDocumentId]: 'processing' | 'completed' | 'failed' }` を追加(completed を「key 不在」でなく明示値で返す)。既存 `statuses`(exam 粒度)は不変 = 既存 consumer(`exam-status-live.tsx`)無改修。
- upload page: submit 応答(operationId / sourceDocumentId)受領後、自 doc の status を 5 秒 poll。`completed` → `router.push(/app/upload/result/{sourceDocumentId})`(**auto-nav 案 a の実装 = todo v48 §0.5 残 #5 をここで吸収**)。result page は sourceDocumentId から source_document + cards を DB で server render する独立 route(`app/(app)/app/upload/result/[sourceDocumentId]/page.tsx`)のため、同期戻り値なしで描画できる(現物確認済)。`failed` → エラー表示(op の `last_error_code` は将来拡張・②-4a は既存文言粒度でよい)。poll は有限化(応答 error 連続で「試験一覧で確認」banner へ縮退 — 既存 kick session の「error で無限 poll」穴を再現しない)。
- **live-op 判定の簡素化**(§4.3): `isLiveUploadOperationCondition` を「非終端 + valid lease」のみに。7 日 retention 枝の存在理由(retryable prepared の再開保護 = 旧 spec §11)は resume 廃止で消滅。これにより invocation 死亡時の「処理中」表示は **最大 7 日 → 最大 ~15 分**に短縮(旧 spec 補足 2 の表示 fix を構造的に吸収)。
- **reconciler の拡張**: `reconcileStaleProcessing` が doc failed 化と同時に、対応する非終端 op(lease 失効)を terminal 化する(旧 spec 補足 2 の計画を本 sprint で実装)。

## 6. 引き継ぐ不変条件(旧 spec から)

- **未完成カードを DB に置かない**(§1.1): publish tx の atomicity(`publishPreparedUploadTx`)不変。
- **crop-derived asset 行・R2 object は prepared_payload commit 後にのみ**(§7.3): 同一 invocation 内でも commit → crop の順序を保持。
- **crop 全滅でも text card を publish**(§8.3)/ 除外理由別件数の提示(§13)/ `result_summary` 内容(§14)/ `prepared_payload` 運用規律(§9: 1 回保存・publish で NULL 化・SELECT * 禁止)/ tag category 最古選択(§12)— すべて不変。
- 要素単位 safeParse・隔離原則(§5.3)・座標契約(§4)・回転入力の明示除外(§4.5)— 不変。
- GDPR: `upload_operations` の削除不変条件(§6.3)は維持。`source_assets` 分は表ごと消滅(退会 sweep の対象表から除去)。

## 7. task 分割と完了の証明

前進方式: S-1〜S-3 で新経路を構築(S-3 で UI 切替)、S-4 で after() 化、S-5 で旧経路撤去。cutover 前例と同型に「切替は `upload-form.tsx` の呼出列に閉じ込める」。

| # | task | 完了の証明(検証可能な形で) |
|---|---|---|
| **S-1** | 単一 action の骨組み: FormData 受領 → 入力検証 → 1 tx(advisory lock / 冪等 replay / live-op gate / daily cap / op+exam+doc 作成 / lease 発行)。**非終端集合 3 箇所(§4.5)へ `processing` 追加**(これが無いと live-op gate が新 op を素通しし二重 submit 防止が壊れる)。OCR/crop は未実装(この時点では即 terminal 化して返るスタブ・UI 未接続) | iso(実 PG): ① 同時 2 submit で 1 つだけ通る(valid-lease の `processing` op を gate が拒否)② cap 超過拒否 ③ 同一 key 再送が同一 op に収束 ④ **R2 client の呼出 0 回**(mock 計測)。unit: 入力検証の境界(41 枚 / 5MiB+1 / 合計 4MB+1 / 偽 magic bytes) |
| **S-2** | メモリのバイトで OCR → normalize → prepared_payload commit(status='prepared')。`incrementAiUsage` 配線 | iso(Gemini mock): ① payload commit までに **R2 GET 0 回** ② Gemini が受け取る base64 = 渡した Buffer と一致 ③ `normalize-prepared` / `preparedPayloadSchema` の既存契約 test が無改変で green |
| **S-3** | メモリのバイトから crop(`crop-and-store` をバイト+寸法引数受けに改修)→ crop 済みのみ R2 PUT → `publishPreparedUploadTx`(SUM/filename 依存の引数化)→ **UI 切替**(upload-form 呼出列を新 action 1 本へ・同期版) | iso: ① **R2 PUT の key が crop asset key のみで `src/` を含まない**(新軸の実行可能な証明)② 図版なし publish 成立(crop 全滅 mock)③ publish tx の出力(cards/tags/refs/upload_records)が現行経路と同値(fixture 比較)。stg smoke: 新経路で upload → cards 生成(同期版・現行 UX と同一) |
| **S-4** | `after()` 化(即応答)+ doc 粒度 polling + auto-nav + 失敗表示 + live-op 述語簡素化 + reconciler の op terminal 化 + catalog 新 key | iso: ① after 相当の handler に throw 注入 → op terminal + doc failed + `integration_failures` 1 行 ② lease 失効 op を reconciler が terminal 化。stg 実測: ③ submit 応答が本処理完了前に返る ④ **タブを閉じても completed に到達**(fact-finding §5 の手順・Fluid/実 maxDuration の OT 確認込み)⑤ poll → result へ auto-nav |
| **S-5** | 旧経路撤去: `source-asset-actions.ts` / `source-purge.ts` / GC source lane / manifest 検証 / takeover / retry marker / `source_assets` 表 drop migration + `asset_derivations` 改修 + 旧 status 値整理 + stg `src/` prefix 一掃 | ① 撤去対象の参照 0 件(grep: `sourceAssets` / `reserveSource` / `finalizeSource` / `purgeOperationSources` / `prepared_taken_over`)② 全 gate green(lint 0 / typecheck 0 / build / full test / **test:iso** / audit)③ **stg の `users/*/src/` prefix が空**(row-less orphan 14 件含む一掃・R2 listing で確認)④ GDPR 退会 sweep の対象表更新が iso で green |

- 各 task とも feat/fix の canonical review + Codex 協調 + [reviewed] は既存規律どおり(spec では省略)。
- S-4 の stg 実測 ④ は CC の stg ログイン資格情報が無いため実施者は OT(または資格情報供与後の CC)— fact-finding Part1 §4 の既知制約。

## 8. 壊すもの(明示)

1. `source_assets` 表 drop(データごと・migration)。iso fixture / completeness カタログ / RLS 検証 oracle(`verify-rls-state.test.ts:91`)/ 関連 test 群(source-asset-finalize / gc-source-assets / source-purge ほか)を同時撤去・改修。
2. `asset_derivations.source_asset_id` FK → `source_id text + source_width + source_height` に置換(§4.1・論点 2)。
3. server action 群: `reserveSource` / `finalizeSource` / `claimOperation` / `stagePrepared` / `publishPreparedUpload` の公開列が単一 action に置換(client 呼出列変更)。`abandonUploadOperation` も撤去(失敗 terminal 化は server 側で完結・client abandon の役割消滅)。
4. `publishPreparedUploadTx` の署名変更(`fileSizeBytes` / `pagesProcessed` / filename を引数化 — source_assets SUM 依存の除去)。**fact-finding S-3 の「byte-for-byte 不変」は不成立**(§10 の SUM が表依存)— 本 spec で訂正。
5. `crop-and-store` の署名変更(source 行 SELECT + R2 GET → バイト + 寸法引数)。
6. `upload_operations.status` の語彙改訂(`processing` 追加・非終端 3 値の新経路不使用)+ live-op 述語の lease 単独化(7 日 retention 撤去)。
7. `/api/exams/status` 応答拡張(additive・既存 key 不変)。
8. upload-form の同期完了依存(`'published'` → `router.push`)→ poll ベース遷移。

## 9. 未確定論点(OT 判断待ち)

1. **op status 新値 `processing` の新設** vs 既存 `claimed` の流用。CC 推奨 = 新設(1 invocation の意味に合致・観測時に新旧経路が判別できる。text 列ゆえ migration 不要)。
2. **`asset_derivations` の source 参照の置換**(`source_id text + source_width/height int` を追加)vs 単純 drop。CC 推奨 = 置換(座標検証の分母を保全・3 列で済む)。YAGNI 判定は OT。
3. **`prepared_payload` の commit 維持**(checkpoint として)vs メモリ内のみ(DB に書かない)。CC 推奨 = 維持(旧 spec §7.3 の順序不変条件の観測点 + crash forensics + 既存資産の最小改変。コスト = jsonb 1 write/upload)。
4. **UI 切替を S-3(同期版)で行う** vs S-4 まで遅延。CC 推奨 = S-3(切替 diff と after() 化 diff を分離し、各段で stg smoke 可能にする)。
5. **Fluid compute 有効/無効・実 Max Duration の確認**(Vercel Dashboard・OT のみ可能)— S-4 着手前に必要(after() の実行余地の前提。~300s で関数消滅した未解明事象が observe-close のまま)。

## 10. 付録: 主要裏取り(現 HEAD)

- 上限系: 40 枚 `ocr-limits.ts:4` / 合計 4MB `constants.ts:18,26` / 1 file 5MiB `asset-limits.ts:17` / body 4.5mb `next.config.ts:69` / maxDuration 800 `page.tsx:16` / lease 15 分 `constants.ts:38` / 圧縮 2048px・0.5MB・webp `upload-form.tsx:270-281`
- 状態機械: status 5 値(text・CHECK なし)`schema.ts:966-971` / 遷移 12 サイト・fencing 9 サイト(調査時の遷移表は本 spec 起草 session の subagent 報告に基づく。正本は現物コード)/ heartbeat 不在(lease 書込は claim `claim-operation.ts:395` と takeover `:242` のみ)
- 削除: `delete-exam.ts:88-90` + cascade `schema.ts:960-962` / 削除ボタン無条件 `exam-list-live.tsx:125`
- after() 受け皿: singleton pool `lib/db/index.ts:10-27` / `withTenantTx` request 非依存 `tenant-tx.ts:29-37` / `recordIntegrationFailure` `integration-failures.ts:126`(catalog に OCR key なし `:18-99`)/ orchestrator 自前 auth `publish-prepared-orchestrate.ts:240-242`
- polling: exam 粒度 + key 不在 = completed `app/api/exams/status/route.ts` / live 述語 `source-doc-status.ts:83-91` / 15 分 sweep `derive-exam-statuses.ts:18` / 7 日 retention `derive-exam-statuses.ts:34`
- source_assets 全列の読者調査・upload_records 読者(`ai-usage-mcq.ts:47-63` のみ)・manifest 3 サイト・width/height 分母(`crop-and-store.ts:360`)= 本 spec §4.1-4.2 に記載のとおり
