# ②-4a 画像図版切り出し 実装 Plan(未公開 payload + 最終 atomic publish)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。
> 正本 spec: `docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md`(2026-07-31 改訂・prepare→publish)。spec を書き換えない(仕様変更は停止して OT)。

**Goal:** 画像入稿を 1 回の generateContent で text+図版検出 → 検証・正規化を未公開 prepared_payload に保存 → server crop → 最終 atomic publish で card+asset を確定(未完成 card は DB 非存在)。

**Architecture:** `prepareUpload`(operation/exam/source 先行作成)→ client presigned PUT → claim(lease)→ Gemini 正規化 → UUIDv4 stage ID 発行 → payload commit → **commit 後にのみ** crop(R2 条件付き PUT)→ `publishPreparedUploadTx`(短い DB tx で一括確定)。

**Tech Stack:** Next 16 / TS strict / Drizzle(PostgreSQL, RLS)/ Dexie mirror / @google/genai / sharp 0.35.3 / Vitest / R2(aws4fetch)。

## Global Constraints(spec 由来・全 task 共通)

- **座標**: box_2d 各軸 0-1000 独立正規化 `x=x/1000×W, y=y/1000×H`。crop 元=Gemini 送信バイト同一(画像は変換なし)。基準=decoded 寸法。**pad 各辺 6%→clamp[0,1000]→left/top=floor,right/bottom=ceil→整数**。退化は crop 失敗。
- **ID**: card ID/option uid/asset ID を **stage 時 UUIDv4 発行 + payload 保存 + retry 再利用**(UUIDv5 不使用)。object key=asset ID 由来。
- **未完成 card は DB 非存在**: cards/tags/refs は publish tx でのみ INSERT。**cards に ON CONFLICT 不使用**(重複は loud fail)。
- **fencing**: publish 冒頭で operation `SELECT … FOR UPDATE` + `status='prepared' AND lease_version=:mine` 不一致は拒否。
- **target 語彙**: `question→question_text` / `explanation→explanation_text` / `option_{id}→option:<uid>`(2 段: id 一致→uid)。ambiguous→question_text。
- **回転(EXIF≠1)**: 図版検出スキップ(text は実行)・「向き未対応」計上。
- **全 table に user_id + RLS**(withTenantTx 経由)。**AI は mock 必須**。**crop-derived asset(`assets` table)は prepared commit 後のみ**(それ以前に crop asset 行/crop R2 を作らない・spec §7.3)。**source_assets の reservation 行は reserve 時=prepared 前に作る**(GC/GDPR 手がかり・本規則の対象外)。
- **改訂(2026-07-31・OT 確定・spec §2/§3/§6/§7.3・§15)**: `input_fingerprint` 廃止(冪等=UNIQUE key+advisory lock+lease CAS+fencing)/ source 集合 unordered・`source_id` 決定処理・`ordinal` 列なし / source_assets 検証済 5 列 nullable・finalize 条件付き UPDATE 確定 / `client_declared_*` 列なし / reservation 行 lean で維持 / T4 user advisory lock + 同時 1 upload 制限 / 日次 Gemini cap 配線(T4 lock→T6 claim 前→T7 increment→UI)・原子的枠確保は非実装。
- **gate**(完了時): whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm test:iso` green / `pnpm run audit` exit0。deps/lockfile を触る task は `pnpm install --frozen-lockfile`+`typecheck`+`build` exit0 も。

## Commit 分離方針(1 commit に収めない)

Phase 単位で複数 commit・各 task = 1 commit(feat は canonical review+Codex→`[reviewed]` / schema+migration や純関数抽出で logic 不変は分類どおり)。**破壊/外部副作用(source GC=T14 / crop 保存=T10 / publish=T12 / GDPR=T15)は push→stg smoke 後に [reviewed] 確定**(session doc 正記録)。migration 追加(T1-3)は OT の DB 反映と同期。

## 実行順序改訂(2026-08-01・OT 指示)

T7〜T9 landed。**残タスクの実行順序 = T13 → T10 → T11 → T12(stop checkpoint)→ T14 → T15 → T16**(本節が実行順の正)。
- **変更点**: T13(applyOcrTags determinism)を T12(publish)より前に実行する(下記 Phase E でも T13 ブロックを T12 の前に配置した)。
- **理由**: T12 の制約が「applyOcrTags は §T13 の determinism 版」を**前方参照**する。T13 を先に land すれば T12 を最終 applyOcrTags に対して 1 回で実装でき、T12 の再 touch を避けられる(§G/architecture §8 の「契約を再利用し部分模倣で drift させない」判断と同型)。
- **task 番号は変更しない**(spec / ledger / memory の cross-reference 維持のため)。番号は非単調になるが実行順序は本節が正。
- **停止点**: T10/T14/T15 = stg-smoke gate(commit tagless → OT push → CC smoke → [reviewed])。T12 完了時 = fencing + prepared takeover の stop checkpoint(OT + claude.ai 確認)。

---

## Phase 0 — prep

### Task 0: sharp を direct 依存化
- **目的/file**: `package.json` dependencies に `"sharp": "0.35.3"` exact pin + `pnpm-lock.yaml`(transitive→direct)。
- **制約**: caret 不使用。next 経由 transitive 版(0.35.3)一致。新規コードなし。
- **完了条件**: `pnpm install`→`--frozen-lockfile`/typecheck/build/audit exit0 + `require('sharp')` load + 実 decode/crop smoke(1 buffer)。`[no-review]`(logic 不変)。

## Phase A — schema(3 表)

### Task 1: `source_assets` 表
- **目的/file**: `lib/db/schema.ts` + migration。1 upload:N ファイルの source。
- **制約**: 列 = id/user_id(fk cascade)/source_document_id(fk cascade)/source_id/object_key(unique)/**mime(nullable)**/**content_hash(nullable)**/**byte_size(nullable)**/**width(nullable)**/**height(nullable)**/status(reserved|ready|deleting)/original_filename/source_kind('image')/created_at/ready_at + ②-4b 予約(page_count/rotation/rasterizer nullable)。**UNIQUE(source_document_id, source_id)**。index(user_id,status)/(source_document_id)。**RLS**(policy+grant+drift test)。**改訂(2026-07-31): 検証済 5 列(mime/content_hash/byte_size/width/height)nullable**(finalize が条件付き UPDATE で確定・spec §6.1)。`client_declared_*` 列は作らない。reservation 行は lean(id/user_id/source_document_id/source_id/temp object_key/status/source_kind/original_filename/created_at)。
- **完了条件**: iso 2 テナント apply / unique 実測 / RLS drift green。schema 追加=`[no-review]`(保証不変)。OT DB 反映同期。

### Task 2: `upload_operations` 表(状態機械)
- **目的/file**: `lib/db/schema.ts` + migration。冪等 ledger + prepared_payload。
- **制約**: 列 = id/user_id(fk cascade)/idempotency_key/exam_id/source_document_id(nullable)/status('awaiting_sources'|'claimed'|'prepared'|'completed'|'terminal_failed')/lease_version(bigint)/lease_expires_at/attempt_count/next_retry_at/last_error_code/prepared_schema_version/prepared_hash/prepared_payload(jsonb nullable)/result_summary(jsonb nullable)/created_at/completed_at。**UNIQUE(user_id,idempotency_key)**。index(user_id,status)/(next_retry_at)。**RLS**。**Realtime publication 非追加**。**改訂(2026-07-31): `input_fingerprint` 廃止**(冪等は UNIQUE key + advisory lock + lease CAS + fencing で成立・spec §2)。`ordinal` 列なし(source 集合 unordered・source_id 決定処理)。`prepared_hash` は残す。
- **完了条件**: iso apply / unique 実測 / RLS drift green。schema 追加。OT DB 反映同期。

### Task 3: `asset_derivations` 表(provenance)
- **目的/file**: `lib/db/schema.ts` + migration。payload NULL 化後も残す切り直しメタ。
- **制約**: 列 = asset_id(uuid pk, fk assets cascade)/user_id(fk cascade)/source_asset_id(fk)/orig_bbox(jsonb)/padding_pct/clamped_bbox(jsonb)/crop_w/crop_h/detect_target/pipeline_version/created_at。**RLS**。GDPR cascade 対象。
- **完了条件**: iso apply / RLS drift green。schema 追加。OT DB 反映同期。

## Phase B — prepare + source lifecycle

### Task 4: prepareUpload(operation/exam/source 先行作成 + 並行制御)
- **目的/file**: `app/(app)/app/upload/_actions/prepare-upload.ts`。client 事前 PUT の循環解消(spec §3)。
- **制約**: 1 tx(withTenantTx)冒頭で **user 単位 advisory xact lock**(`pg_try_advisory_xact_lock(hashtext(userId))`・取得不可=並行 prepare を弾く)。順序: lock → 同一 idempotency_key 既存 operation は**それを返す**(冪等契約・引数差でも新規化しない・spec §2)→ 別 key の **live operation** あれば `in_progress`(同時 1 upload 制限)→ なければ operation(status='awaiting_sources'・**`expected_source_count`=sources 件数を保存**=T6 source 検証の immutable oracle・spec §2)+ exam(new/existing)+ source_document(processing)+ **lean な source reservation 行**を作成し ID 群返却。**live 判定**は upload_operations の status(非終端)/lease/abandonment TTL 基準(旧 source_documents 15 分窓を流用しない・T14 で §11 と整合)。**全体サイズ上限を client 申告合計で早期検査**(server 実測での再検査は T6)。**入力検証は既存 `reserveAsset` の Zod 境界(`asset-actions.ts:57`)に揃える**。reservation 行は検証済 5 列を書かない(nullable・finalize 確定)。
- **完了条件**: iso(新規/既存 exam・冪等 key 再送で同 operation・別 key live で in_progress・advisory lock 並行弾き・サイズ超過弾き)。feat→`[reviewed]`。

### Task 5: source reserve/finalize(temp→server promote・immutable)
- **目的/file**: `app/(app)/app/upload/_actions/source-asset-actions.ts` + `lib/storage/r2.ts`(server `getObject`/`putObject` 追加・T10 と共有)。
- **制約**: **reserve は T4 で作成済みの reserved 行を認可・検証し temp key(`src/tmp/`)への presigned PUT URL を発行する。source_assets 行は新規作成しない**(改訂 2026-07-31)。client 申告 size/MIME は検証し presigned URL 署名(content-length-range/content-type)にのみ使用・DB 非永続。finalize=temp を R2 GET → **magic-byte/decode/byte_size/content_hash(SHA-256)/decoded 寸法/mime を検証・算出 → 検証済バイトを server が最終 immutable key へ PUT** → **条件付き UPDATE で検証済 5 列 + ready_at を set し 'ready' へ**(TOCTOU=status='reserved' WHERE・reserved→ready CAS)。**最終 key は client presigned 無し=finalize 後 immutable**(Codex P1)。sharp `limitInputPixels` で decode bomb 防御。owner scope。
- **完了条件**: unit(mock r2: hash/dims 再計算・size/magic 不一致 reject・**temp→最終 promote で最終 key が server 書込**・条件付き UPDATE で 5 列+ready 同時確定)+ iso。feat→`[reviewed]`。

### Task 6: claim + lease CAS(+ 日次 cap 判定・単一 tx)
- **目的/file**: `app/(app)/app/upload/_actions/claim-operation.ts` + 日次 cap helper(`parseDailyLimit` を `upload-guard.ts:23` から directive-free `_lib/daily-limit.ts` へ切出)。**fingerprint module/分岐は廃止**(2026-07-31 revision)。
- **制約(spec §2.1 準拠・全て 1 tx)**: (1) `upload_operations` `SELECT … FOR UPDATE` (2) **認証・owner・status 分類を daily cap より先に**: `completed`→result_summary / `terminal_failed`→保存済み失敗結果 / 有効 lease `claimed`→`already_processing` / `prepared`→`already_prepared`(takeover は T12) (3) **実際に Gemini 再実行する claim 候補(awaiting_sources / 期限切れ claimed+next_retry 到達)だけ** daily cap 確認(`GEMINI_DAILY_LIMIT_EXCEEDED`・非原子) (4) 全 source_assets を `ORDER BY id FOR UPDATE`(**status で絞らない**) (5) source 検証: **`expected_source_count` と実行数一致**(検査対象 COUNT から導出しない)/ 全 `ready` / `byte_size NOT NULL` / deleting・欠落なし / server 実測 byte_size 合計 ≤ `TOTAL_UPLOAD_LIMIT_BYTES` (6) claim CAS(`lease_version`/`attempt_count`+1)。**lease/next_retry の時刻比較・設定は PG `now()` 基準**(app `new Date()` 不可・fencing 正しさ)。**lock order = operation→source_document→source_assets(ID順)→derived(ID順)**(§8.1 と統一・デッドロック回避)。**outcome**: 一部 reserved→**一時 `sources_not_ready`**(永続 status 非追加・awaiting のまま)/ 全 ready+超過→**終端 `terminal_failed`/rejected を保存**(再送で同結果)/ 欠落・deleting・byte_size NULL→データ不整合 or terminal(sources_not_ready と混同しない)。**原子的枠確保は非実装**(spec §6.5 の R2 staging bounded residual risk を明示受容)。
- **完了条件**: iso(concurrent claim exactly-one-winner / 期限切れ claimed takeover 競合 / 二重抑止 / 再 claim / **completed+cap 到達で冪等 replay** / **terminal_failed 冪等 replay** / reserved 1 件で sources_not_ready / finalize-claim race で古い合計 claim なし / 最後の ready 化で超過→size_exceeded 終端 / 件数不足 / byte_size NULL / deleting 混在)+ unit(cap helper)。**契約変更でテスト更新**(旧「reserved 除外 claim 成功」test は Crit#2 バグを pin していたため差替=commit message に明記)。feat→`[reviewed]`。

## Phase C — OCR → 正規化 → stage payload

### Task 7: 統合 schema + prompt + source_id interleave
- **目的/file**: `lib/ai/schemas/ocr-image-crop-response.ts` + `lib/ai/prompts/ocr-figure-suffix.ts` + Gemini parts 組立(`text "source_id=X"`→image interleave)。本番 schema/prompt 不触。
- **制約**: figure_regions{source_id, box_2d nullable, target, label, (page 予約)} を per-card 注入(required 非追加)。box_2d nullable。**各 OCR attempt で既存どおり `incrementAiUsage`**(日次 cap 配線・spec §3)。
- **完了条件**: unit(注入形・nullable・interleave 順)。feat(Gemini mock)→`[reviewed]`。

### Task 8: 要素隔離 + 正規化 + UUIDv4 stage 発行 → payload
- **目的/file**: `lib/ocr/normalize-prepared.ts`(boundary+normalize)+ stage 保存 action。**改訂(2026-07-31・OT): `lib/ocr/domain/` でなく `lib/ocr/`(non-domain)に置く** — raw Gemini JSON の未検証入力を zod で境界検証するため(domain zod-free 原則・F3 spec §3.4/§3.2。lib/ocr/ocr.ts が既に zod 使用の boundary 層)。8a=pure normalize / 8b=stage action に分割実装。
- **制約(spec §5.4 executable contract SSoT・2026-07-31 OT 収束設計)**: `prepared{Option,Figure,Card,Payload}Schema` を 1 file に定義し **leaf 境界値は `lib/validation/card.ts` を compose**(再定義しない)。`PreparedCard = z.infer<typeof preparedCardSchema>`(手書き型禁止)。入力境界/正規化後 schema 分離・要素 safeParse。JSON 全体 parse 不能→retryable failed。card ID/option uid/asset ID を **UUIDv4 発行**+検証(v4+横断 unique)。target: option_{id}→id 一致→`option:<uid>` / null 座標→「座標 null」/ source_id 未解決→「source_id 不正」。**正規形**: undefined でなく **null**(キー必須)/ 配列は空配列 / **`customProps: Record<string,string|string[]>` 必須+空 `{}`**(applyOcrTags 既存 helper へ渡す)。normalize は card ごと `preparedCardSchema.safeParse(candidate)` → **`data` を返す**(candidate 非返却)→ 失敗 isolate+tally。**`preparedPayloadSchema = discriminatedUnion('schemaVersion', [V1])`**(V1 不変・将来 V2 追加・旧 7 日保持)。**publisher(T12)は同 schema を `parse` し normalizePreparedCard を呼ばない**。DB INSERT 変換は 1 関数。**統一しない**: OCR raw / manual card / DB schema・DB 文脈検証(owner/ready/hash/存在/fencing)は publisher 専用。**正規化後 prepared_payload を 1 回 atomic 保存**(status→'prepared'・prepared_hash/schema_version 記録)。
- **完了条件**: pure test(隔離・null・target 各種・ambiguous・重複 source_id・publisher schema 全 field 弾き = title/sort_key/question/explanation/memo/options+option bounds)+ **契約テスト「normalize 生成 card は全て `preparedCardSchema` を通る」**+ iso(payload atomic 保存・status 遷移)。feat→`[reviewed]`。

## Phase D — crop(prepared commit 後のみ)

### Task 9: 座標変換 + padding/clamp(pure)
- **目的/file**: `lib/media/domain/crop-geometry.ts`(pure)。
- **制約**: `toCropRect(box_2d,W,H)`: 軸別 → pad±60 → clamp[0,1000] → ×decoded → **floor(left/top)/ceil(right/bottom)** → 整数。退化→null。監査メタ(orig_bbox/padding_pct/clamped_bbox/crop_w/crop_h)返却。NaN/Inf/逆転/範囲外の入力責務明記。
- **完了条件**: pure test(軸別・floor/ceil・退化 null・監査メタ・裏取り代表例 px 一致)。feat→`[reviewed]`。

### Task 10: server crop + R2 条件付き PUT + asset 行 + provenance
- **目的/file**: `lib/storage/r2.ts`(条件付き PUT `If-None-Match:*` 追加・base server get/put は T5)+ `lib/media/crop-and-store.ts`。**crop は operation status='prepared' 確認後のみ**。
- **制約**: source R2 GET → sharp extract(auto-rotate 禁止・pipeline 明文)→ webp(quality/lossless 固定)。asset id=payload の UUIDv4。最終 key へ `If-None-Match:*` PUT。**412→HEAD size+GET SHA-256 照合・不一致 loud fail / ready+一致=再利用 / deleting|deleted=禁止**。assets 行(status ready・byteSize/hash/width/height・server SHA-256 保存)。asset_derivations 保存。**assets.status は成功 skip 判定のみ**・未 ready は再試行。
- **完了条件**: unit(mock r2/sharp: 412 分岐・hash 照合・再利用・決定 ID 再現)+ iso。**外部副作用ゆえ stg smoke 後 [reviewed]**(session doc)。

## Phase E — publish

### Task 11: 純関数抽出(既存ロジック共通化)
- **目的/file**: `projectCardAssetRefs`(`card-field-handlers.ts:199` 射影切出)/ `assertReadyOwnedAssets`(DB helper)/ 変換境界(camelCase↔snake_case 1 箇所)。既存 handleImages/backfill と挙動一致(drift test)。
- **制約**: handleImages は既存 card 前提ゆえ publisher から呼べない → 射影を pure 抽出(実質 3 経路で根拠十分)。挙動不変。
- **完了条件**: 抽出前後の等価 test(既存 handleImages 経路の回帰 + backfill)。test 増=red 検証 + 簡易 review→`[reviewed]`。

### Task 13: applyOcrTags の deterministic 化 〔実行順=T12 の前・§実行順序改訂〕
- **目的/file**: `lib/tags/apply-ocr-tags.ts`(同名 category は `(created_at,id)` 最古を canonical)。
- **制約**: `tag_categories` の同名重複は意図的許可(unique 化しない)。ORDER BY(created_at,id) 追加で選択順固定。挙動変更は「非決定→決定」。
- **完了条件**: unit(同名複数で最古選択・red 検証)。feat→`[reviewed]`。

### Task 12: publishPreparedUploadTx 〔実行順=T13 の後・§実行順序改訂〕
- **目的/file**: `app/(app)/app/upload/_actions/publish-prepared.ts`(orchestrator)。
- **制約**: 冒頭で operation `FOR UPDATE`+`status='prepared' AND lease_version=:mine` 不一致拒否(fencing)。**ロック順 = operation→exam→source_document→assets(ID順)→cards→tags→refs→counters/status/operation**。asset は **条件付き保護 UPDATE**(`SET unreferenced_at=NULL WHERE user_id AND id IN(...) AND status='ready' RETURNING id`・期待件数未満で fail)。cards/tags/refs/card_count/status を同一 TenantTx で確定(saveExtractedCards 改修=card ID で customProps 対応 / applyOcrTags は §T13 の determinism 版 / completeUploadTx 相当は開始 status 検証込みで新規 / bumpExamCardCount affected row 検証)。**cards に ON CONFLICT 不使用**。images≤10 超過は決定順先頭採用+`image_limit_exceeded`。publish 条件(有効 card≥1 かつ 全 figure 終端 / 0→failed / DB 失敗→retryable)。成功で payload NULL 化 + result_summary 保存 + status='completed'(全滅/一部=completed+warnings、enum 追加せず warnings は result_summary/件数)。
- **prepared takeover(spec §2.2・2026-07-31 OT)**: 別経路 `claimPrepared`/publish-resume で **lease 期限切れの `prepared` を新 lease_version で takeover**(旧 worker が prepared 保存後に死んだ場合の引き継ぎ)。旧 worker は fencing で prepared 更新/publish を拒否。**Gemini 再実行しないため daily cap 非適用**。
- **完了条件**: iso(fencing 拒否・ロック順・保護 UPDATE 期待未満 fail・冪等再 publish で増えない・crop 全滅 text publish・ON CONFLICT なし重複 loud fail・**prepared takeover(期限切れ lease で新 version 取得・旧 worker fencing 拒否)**)。**外部副作用ゆえ stg smoke 後 [reviewed]**。**T12 完了時に別 stop checkpoint(publish の fencing + prepared takeover を OT + claude.ai で確認・2026-07-31 OT 指示)**。

## Phase F — lifecycle / 提示 / 回転

### Task 14: deadline / retry 保持 / source_assets GC / stale 統合
- **目的/file**: operation absolute deadline + `deadline_excluded` / retry 7 日→terminal_failed+payload NULL / `scripts/gc-image-assets.ts` に source_assets lane(共通化)/ stale source reconciler が live operation 除外。
- **制約**: grace 30 日 > 保持 7 日。source_assets GC = reserved TTL/参照ゼロ(source_document FK+operation 状態)→deleting→R2 delete。reconciler は W1 deploy 後・dry-run 先行。
- **完了条件**: unit/iso(deadline_excluded・7 日 terminal・source GC 参照ゼロ・stale が live operation 除外)。**破壊操作ゆえ stg smoke 後 [reviewed]**。

### Task 15: GDPR Group I 統合
- **目的/file**: 退会経路(`handle-clerk-event.ts`)に upload_operations/source_assets 追加 + user 削除時 operation cancel/terminal + reservation/finalize で user 非削除再確認。
- **制約**: DB cascade 先行で R2 key を失わない(deleting 経由)。payload にカード本文を持つため operations 削除漏れ不可。
- **完了条件**: iso(退会後 upload_operations/source_assets count0 + R2 delete 呼出)。**削除経路ゆえ stg smoke 後 [reviewed]**。

### Task 16: 提示(除外理由別)+ 回転除外
- **目的/file**: upload result payload + UI(理由別件数)+ source 取込前段の EXIF orientation 判定。
- **制約**: 件数 = card N/M + 図版「取込 K / 座標null / source_id 不正 / crop 失敗 / 制限超過 / 向き未対応 / image_limit_exceeded / deadline_excluded」。EXIF≠1(sharp metadata)→当該 source を figure 対象外(text 継続)+ 計上。前提破綻検出器ゆえ発火時 logger.warn(PII-free)。採用順=source 入力順→(page)→y_min→x_min→最終 tie-breaker(source_id)。
- **完了条件**: unit(採用順ソート・理由別集計・orientation 分岐・向き未対応計上)。feat→`[reviewed]`。

---

## Self-review(spec 対応 + 型整合 + §G drift)

- spec 対応: §1-3 状態機械=T2,T4,T6 / §4 座標=T9+Global / §5 schema=T7-8 / §6 source=T1,T5,T14,T15 / §7 crop=T9-10 / §8 publish=T11-13 / §9 payload=T8 / §10 provenance=T3,T10 / §11 deadline/retry/GC=T14 / §12 tag=T13 / §13 提示=T16 / §14 result_summary=T12 / §15 判断=Global / exp7=Global 回転。
- 型整合: `toCropRect`(T9)→crop-and-store(T10)/ normalize 除外理由 enum(T8)→提示(T16)/ lease_version CAS(T6)→publish fencing(T12)/ projectCardAssetRefs(T11)→publish(T12)。
- **§G drift**: 旧前提(**3 ゲート / touch / cards.updated_at bump / UUIDv5 / completed_with_warnings enum**)を本 plan・spec・test から除去済(getCardsDelta/smart fallback/exam detail 除外 task なし・UUIDv5 task なし・status enum に warnings 追加なし)。
- 未 gate: exp7(回転 JPEG 座標)は本 plan 外(除外運用で先行)。

**最終行数**: 138 行(17 task・6 phase + prep。prepare→publish 全面改訂・design 判断の記録として簡潔化)。
</content>
