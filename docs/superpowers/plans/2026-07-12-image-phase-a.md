# 画像フェーズ A(画像基盤)— Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。steps は checkbox で追跡。

**Goal:** 編集面(テーブル inline / side peek)+ 学習ビューでカードに画像を添付・表示できる基盤。画像バイトは Vercel を通さず非公開 R2 へ presigned 直 PUT、card は assetId のみ参照、blob は Cache API(userId namespace)+ デッキ一括オフライン DL。

**Architecture:** reserve→直 PUT→finalize の saga。server 反映は flush gate(client)+ images handler(server 最終防衛)の二段で「server の cards.images が参照する assetId は常に ready」を保証。card sync(entity_mutations)と media transfer(専用 guarded loop)は分離。

**Spec(凍結・正本):** `docs/superpowers/specs/2026-07-12-image-phase-a-design.md`(§ 参照は本 spec。OT 確認 3 点確定済: custom domain 不要 / 学習ビュー gallery 含む / dedup=hash 記録のみ)

## Global Constraints(全 task 共通)

1. spec 凍結。仕様変更が要るなら停止して OT 相談。
2. **URL を DB / Dexie / DOM(src)に保存しない**(objectURL のみ)。server handler は url 非空 entry を reject(spec §2.2)。
3. **server の cards.images が参照する UUID key は常に ready**(gate + handler の二段。spec §3.2/3.3)。blob / 画像 mutation を entity_mutations に載せない。
4. Cache key / Dexie asset 状態は userId namespace(spec §2.3/2.4)。
5. server からの R2 呼出(HEAD 等)は `AbortSignal.timeout(10_000)` 必須(外部 API timeout 規律)。
6. 新規 env なし(既存 `R2_*` 5 変数を実配線。`.env.example` 記載済・実値は OT)。
7. `CardImage` / `ClientCardImage` の型変更なし(spec §2.2)。既存 OCR entry(非 UUID key)は passthrough・非描画。
8. 全 commit green(typecheck / test を赤いまま task 間に持ち越さない)。R2 / aws4fetch / Cache API は test で mock(実 API 禁止)。

**共通 gate(各 task)**: `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm test`(full)全 exit 0。**依存追加 sprint ゆえ sprint 完了時は加えて `pnpm install --frozen-lockfile` + `pnpm build` exit 0**。server↔client の import 境界を跨ぐ task(4/8/9/10/11/12)は per-task で `pnpm build` も実行(matcher 非依存だが境界検出の砦)。

**review 経路(feat task 共通)**: canonical `superpowers:requesting-code-review`(default 経路・general-purpose subagent・template 改変禁止)pass → `scripts/ai/codex-review.sh <topic>` → 未解決 Critical 0 + Important 0 まで反復(上限 3 周)→ commit 直前宣言 4 点 → commit。実装は Opus subagent + per-task Codex。**外部副作用(R2 書込)に触れるため「重要 Fix の裏取り」規律準用**: push 後 stg smoke → session doc を [reviewed] の正記録(Sprint 1/2 前例)。docs は `docs(_)` + `[no-review]` 即 commit。

**ops 前提(コード外・OT 手順・stg smoke の前提条件)**: ① R2 bucket(mcq-platform)CORS = app origin から **PUT + GET**(+ preflight・**AllowedHeaders に Content-Type**)許可。HEAD は server-side のみで CORS 不要 ② R2 単一オブジェクト上限・無料枠確認。custom domain は不要(確定)。

## 参照事実(plan 起草時に実コード裏取り済・再調査不要)

- **gate × coalesce 干渉なし(kickoff 確認事項 2・裏取り済)**: coalesce は enqueue 時に pending 行の patch/mutation_id を上書きして完結(`lib/sync/entity-mutations.ts:87-108`)。flush は開始時 1 回 read(`:229`)→ targets filter(`:234`)で gate 評価 = **常に最新 coalesce 済み value を見る**。read 後の並走 coalesce は mutation_id 再採番(`:96`)で既存機構が処理(古 id の synced 化は新行に不一致 → 新値 pending 残置)。gate は filter 1 条件の追加のみ。
- **sweep 発火点(確認事項 1・裏取り済)**: trigger component パターン実在 — `PullTrigger` / `EntityMutationFlushTrigger` が `app/(app)/app/layout.tsx:60,71` に mount。`dropStalePendingEntityMutations` の「mount 時 1 回・常駐なし」前例(`entity-mutations.ts:174`)。多重タブは Web Lock(`lib/sync/with-web-lock.ts`、既存 3 例)+ lock-busy skip。
- **aws4fetch(確認事項 3・Context7 裏取り済)**: presign = URL に `X-Amz-Expires` を付与し `client.sign(url, {method, headers:{'Content-Type':mime}, aws:{signQuery:true}})`。HEAD = `client.fetch(url, {method:'HEAD'})`(S3 HeadObject・response header Content-Length)。**fallback 確定(Codex 指摘で強化)**: Content-Length は S3 標準で必ず返る — 不在は異常として **finalize 失敗扱い(検証を緩和しない)**。HEAD は server-side のみ(client から R2 へ HEAD しない = browser CORS に HEAD 不要)。endpoint = `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/{R2_BUCKET_NAME}/{objectKey}`(path-style)。
- **既存 `cards.images.url` 非空は構造上不在(Codex 指摘への回答)**: OCR 出力型 `ExtractedImage` に url フィールドなし(`ocr-response.ts:21-26`)、write は常に `[]` or ref-only(`process.ts:376` / `build-new-client-card.ts:43`)→ T5 の url 非空 reject は既存データと衝突しない(migration 不要)。
- **images 配列の並走編集(多タブ)は last-write-wins**: 既存 update_field 系(options / tags)と同一挙動(coalesce + 全置換)。新 invariant を発明しない(意図的判断・許容)。
- 学習ビューは smart / custom とも `SessionRunner` に収束(`session-launcher.tsx:25,88`)。表示部 = `session-runner.tsx:430`(questionText)/ `:436`(options map)。
- 編集面共有 block = `card-editor-fields.tsx:42-114`。caller = `exam-card-side-peek.tsx:133-143` / `inline-card-list.tsx:301-312`(images prop 未配線)。
- 型: `CardImage` = `lib/db/schema.ts:53-59` / `ClientCardImage` = `lib/client-db.ts:62-68` / Dexie 最新 = version(7)(`client-db.ts:307-310`)。users FK = `uuid('user_id')` + cascade(既存パターン)。migration 採番 = **0023**。
- 手本: env fail-fast = `lib/stripe/client.ts`(prefix 分岐は R2 不要・不在チェックのみ)/ server action 戻り値 union = `app/(app)/app/exams/_actions/delete-exam.ts` / 楽観更新 = `lib/sync/optimistic-mutation.ts`(`runOptimisticUpdate`、flush 内蔵 fire-and-forget)/ field handler 追加 = `lib/cards/card-field-handlers.ts:258-266` + `:16` コメント。

---

## Task 1: aws4fetch 導入(de-risk gate)[chore / no-review]

- **目的**: `aws4fetch` を dependencies に追加(server 専用利用)。
- **制約**: de-risk gate = ① `pnpm add aws4fetch` ② `pnpm typecheck` + `pnpm build` exit 0 確認 ③ 一旦 revert ④ 専用 chore commit で正式追加(kickoff 指定手順)。最新版は registry 直叩きで確認(Context7 は patch に遅れる)。client bundle に import しない(この task では import 追加なし)。
- **完了条件**: `package.json` + lockfile のみの chore commit / frozen install + typecheck + build exit 0 / `[no-review]`。

## Task 2: `assets` テーブル + migration 0023(TDD)

- **目的**: spec §2.1 verbatim の `assets` を `lib/db/schema.ts` に追加し migration 0023 生成。型 export(`Asset` / `NewAsset`)。
- **制約**: 列・index は spec §2.1 のとおり(id uuid PK defaultRandom / user_id uuid FK cascade / object_key unique / mime / byte_size / width / height / hash / status default 'reserved' / created_at / ready_at / reference_count default 0 / unreferenced_at。index (user_id,hash) + (user_id,status))。**status / mime に DB CHECK は張らない**(アプリ層 invariant・Sprint 2 catalog 前例と同判断・意図的)。`reference_count` / `unreferenced_at` を読み書きするコードを**作らない**(dormant 列)。pull 同期非対象(sync 配線に触れない)。zero-users ゆえ移行コードなし。migration 生成は本 task で 1 回だけ。
- **手順**: [ ] schema 追加 → [ ] `drizzle-kit generate` で 0023 生成・SQL 目視(CREATE TABLE + index のみ)→ [ ] gate → review 経路 → commit。
- **完了条件**: 0023 SQL が spec §2.1 と一致 / gate exit 0 / review pass(Crit 0 / Imp 0)/ commit。

## Task 3: `lib/storage/r2.ts`(env fail-fast + presign + HEAD)(TDD)

- **目的**: R2 接続の単一モジュール。`lib/stripe/client.ts` の fail-fast 形を踏襲(5 つの `R2_*` 不在で module load throw)。
- **Produces**: `presignPutUrl(objectKey: string, mime: string, expiresSec?: number): Promise<string>` / `presignGetUrl(objectKey: string, expiresSec?: number): Promise<string>` / `headObject(objectKey: string): Promise<{ exists: boolean; contentLength: number | null }>`。expires 既定 600(spec: TTL 10 分)。
- **制約**: aws4fetch は「参照事実」の形で使用(signQuery + X-Amz-Expires + Content-Type 署名 / HEAD は `AbortSignal.timeout(10_000)`)。server 専用(`import 'server-only'` 相当は `@/lib/db` 同様の慣例確認の上で判断)。presign は純関数的に unit 可能: `aws.datetime` 固定で URL の `X-Amz-*` param(SignedHeaders に content-type 含む)を assert。HEAD は fetch mock。
- **完了条件**: unit(presign PUT/GET の URL 形状・expires 反映・HEAD exists/contentLength/timeout)green / gate / review pass / commit。

## Task 4: server actions — reserve / finalize / resolve(TDD)

- **目的**: saga の server 側 3 action を `app/(app)/app/exams/[id]/_actions/asset-actions.ts` に新設(spec §3.1/§6)。
- **Produces**: `reserveAsset(input: {mime, byteSize, width, height, hash}): Promise<...>` → `{assetId, uploadUrl}` / `finalizeAsset(assetId: string)` / `resolveAssetUrls(assetIds: string[])` → `Array<{assetId, url, mime, width, height}>`。戻り値 union は `delete-exam.ts` の既存 pattern 踏襲。
- **制約**: 全 action `auth()` 必須 + owner scope(WHERE user_id)。reserve: mime ∈ {image/webp, image/png} / byteSize ≤ 5MB / assets INSERT(reserved)/ objectKey = `users/{user_id}/{assetId}.{webp|png}`。finalize: owner 確認 → 対象 asset **row の object_key** で `headObject` → 実在 + contentLength===byte_size(**null は異常 = finalize 失敗。緩和しない**)→ ready + ready_at。resolve: ≤50 件 / ready のみ返す。hash は記録のみ(dedup 再利用 branch を書かない = spec §3.5)。
- **完了条件**: unit(認可 / 検証 / reserved→ready 遷移 / HEAD 不一致・Content-Length null reject / **cross-user assetId の finalize・resolve reject** / resolve ready filter。DB・r2 mock)green / gate + build / review pass / commit。

## Task 5: `imagesSchema` + server images handler(最終防衛)(TDD)

- **目的**: `lib/validation/card.ts` に `imagesSchema`、`lib/cards/card-field-handlers.ts` に `images` entry 追加(spec §3.3)。
- **制約**: zod = 配列 ≤10 / entry `{key: min1, target, alt, source_ref?, url?}` / **url 非空 reject** / UUID key entry のみ target 形式強制(`'question_text' | /^option:.+/`)。handler = UUID key 全てが「自 user の assets status='ready'」に実在(1 query IN)、違反は mutation fail(既存 failed 分類)。**非 UUID key(legacy OCR)は passthrough**。既存 handler 群(`:258-266`)の形(1 entry + zod 1 本)に倣い、他 field へ影響ゼロ。
- **完了条件**: unit(ready 全一致 pass / 非 ready reject / **他 user の ready asset 参照 reject** / url 非空 reject / legacy passthrough / target 形式 / 他 field 回帰なし)green / gate / review pass / commit。

## Task 6: Dexie version(8) + Cache helper(TDD)

- **目的**: client 基盤 — `lib/client-db.ts` に v8(`media_assets: 'id, user_id, [user_id+hash], status'` / `media_download_jobs: '[user_id+exam_id], user_id, status'`、値 shape は spec §2.3)+ `lib/media/cache.ts` 新設。
- **Produces**: `ClientMediaAsset` / `ClientMediaDownloadJob` 型、`putAssetBlob(userId, assetId, blob)` / `matchAssetBlob(userId, assetId): Promise<Blob | undefined>` / `deleteAssetBlob(userId, assetId)`(cache 名 `recallmint-media`、key `{origin}/__media/{userId}/{assetId}`)。
- **制約**: v8 は純粋 store 追加(v2/v4/v5 前例)・既存 store の index 文字列に触れない。Cache API は vitest に無い → global `caches` stub で unit。
- **完了条件**: unit(v8 upgrade 通過・両 store 読み書き・cache key の userId namespace・put/match/delete)green / gate / review pass / commit。

## Task 7: flush gate(TDD・risk task)

- **目的**: `flushAllPendingEntityMutations` の targets filter(`entity-mutations.ts:234` 相当段)に images gate を追加(spec §3.2)。
- **Produces**: pure helper `collectBlockedImageMutationIds(pending: ClientEntityMutation[], uploadingAssetIds: Set<string>): Set<string>`(判定は「card / update_field / field='images' かつ patch value 内 UUID key が uploadingAssetIds に 1 つでも含まれる」)。flush 側は media_assets の 'uploading' id を 1 回読み filter に合流。
- **制約**: **gate 条件は 'uploading' の有無のみ**(local 未知 key = pull 由来を block しない)。coalesce / in-flight / mutation_id 再採番の既存機構に触れない(参照事実の裏取りどおり filter 1 条件のみ)。'failed' は gate 対象外(sweep / handler が処理)。
- **完了条件**: unit 4 ケース('uploading' 含み残置 / ready 後送信 / **local 未知 key 素通し** / 非 images 素通し)+ 既存 flush test 回帰 green / gate / review pass / commit。

## Task 8: upload saga client(TDD・risk task)

- **目的**: `lib/media/upload.ts` 新設 — 圧縮 → reserve → 楽観層 → PUT → finalize の配線(spec §3.1/3.4)。
- **Produces**: `compressForAttach(file: File): Promise<{blob, mime, width, height, hash}>` / `attachImageToCard(p: {userId, cardId, target, file, currentImages: ClientCardImage[]}): Promise<{ok: true, assetId} | {ok: false, code: AttachErrorCode}>` / `abandonUpload(p: {userId, cardId, assetId, currentImages})`。
- **制約**: 圧縮 options verbatim `{maxWidthOrHeight: 1600, fileType: 'image/webp', initialQuality: 0.8, maxSizeMB: 1, useWebWorker: true}`。入口 gate = MIME ∈ {image/jpeg, image/png, image/webp} **かつ拡張子 ∈ {jpg,jpeg,png,webp}**(`file.type === ''` を含む不一致・decode 失敗は明示エラー、**非 Error reject を正規化**)。実 MIME = `blob.type`(Safari PNG データ駆動)。width/height は**圧縮後 blob の decode 値**(EXIF orientation 焼き込み後の寸法)。hash = `crypto.subtle.digest('SHA-256')`。楽観層 = `putAssetBlob` + media_assets put('uploading')+ `runOptimisticUpdate`(field 'images'・配列全置換)— 既存 helper 流用・新規 tx 発明なし。PUT 失敗 retry は presign 期限内は再 PUT / 期限切れは **re-reserve = 新 assetId で mirror entry 差し替え + 旧 cache・media_assets 削除**(旧 reserved row は無害 orphan)。放棄 = mirror entry 除去(runOptimisticUpdate)+ cache delete + media_assets 削除。finalize 成功 → media_assets 'ready' + flush trigger(既存 fire-and-forget 形)。
- **完了条件**: unit(正常系 / 圧縮失敗(Event reject・**空 MIME** 含む)/ reserve・PUT・finalize 各失敗の end-state = spec §3.4 表どおり / **re-reserve の差し替え+旧掃除** / PNG fallback で mime='image/png' が reserve に渡る)green(browser-image-compression・actions・cache は mock)/ gate + build / review pass / commit。

## Task 9: 取得側 getAssetObjectURL + 起動 sweep(TDD)

- **目的**: 表示用 blob 解決と自己修復 sweep(spec §6 / §3.4)。
- **Produces**: `lib/media/get-asset.ts` — `getAssetObjectURL(userId, assetId): Promise<string | null>`(cache hit → objectURL / miss → `resolveAssetUrls` → fetch → put → objectURL / 失敗 null。objectURL は module Map で **`${userId}:${assetId}` key** に再利用・差し替え時 revoke — user 混線防止)。`lib/media/sweep.ts` — `sweepStaleMedia(userId): Promise<void>`。`app/(app)/app/_components/media-sweep-trigger.tsx`(mount 1 回 fire-and-forget、`app/(app)/app/layout.tsx` の既存 trigger 群(:60,71)に併設)。
- **制約**: sweep = Web Lock `'recallmint:media:sweep'`(lock-busy skip = 多重タブ担保)で ① stale 'uploading'(1h 超)→ media_assets 削除 + cache delete + 該当 assetId を含む card の mirror images から entry 除去(runOptimisticUpdate → coalesce で server へ)② 'downloading' 残骸 job → added_asset_ids の cache delete + job row 削除。mirror 除去は冪等(entry 不在なら no-op)。
- **完了条件**: unit(cache hit / miss→fetch→put / 失敗 null / sweep ①② / lock-busy skip / 冪等)green / gate + build / review pass / commit。

## Task 10: 編集面 gallery(添付・削除・表示)(TDD)

- **目的**: `card-editor-fields.tsx` に target 単位 gallery + 添付 affordance(file picker)+ 削除を追加し、両 caller に `images` ほか必要 prop を配線(spec §5)。
- **Produces**: `CardImageGallery`(`app/(app)/app/exams/[id]/_components/card-image-gallery.tsx`、props `{images: ClientCardImage[], target: string, userId: string, readOnly?: boolean, onAttach?, onDelete?}`)— T11 が readOnly で共用。
- **制約**: 表示は UUID key entry のみ(legacy 非描画)。生 `<img>` + `getAssetObjectURL` + width/height 属性(media_assets 値)。miss/失敗は placeholder + retry。添付 = `attachImageToCard`、削除 = images 配列から entry 除去の `runOptimisticUpdate`(asset 残置)。caller 2 箇所(side-peek `:133-143` / list `:301-312`)に prop threading。世界観 = 既存編集面の tone 踏襲(テンプレ AI デザイン回避)・mobile view 検証。
- **完了条件**: unit(gallery の UUID filter / 添付・削除ハンドラ配線 / placeholder)+ 既存編集面 test 回帰 green / gate + build / review pass / commit。

## Task 11: 学習ビュー read-only gallery(TDD)

- **目的**: `session-runner.tsx` の questionText(:430)下と options map(:436)内に `CardImageGallery readOnly` を差し込む(spec §5・OT 確定 2)。
- **制約**: read-only(添付・削除なし)。card 供給は Dexie mirror read のみ(`ClientCard.images` 既載)につき、**許される変更は images フィールドの素通し(型伝搬)だけ** — session 集計・並び・選定ロジックへの変更は禁止(scope 膨張の既知リスク点)。smart / custom 両モードは SessionRunner 収束済ゆえ差し込みは 1 箇所。
- **完了条件**: unit(images 付き card で gallery render / 無しで非 render / 回帰)green / gate + build / review pass / commit。

## Task 12: デッキ一括 DL + InstallPrompt + persist()(TDD)

- **目的**: `lib/media/deck-download.ts`(all-or-nothing DL)+ exam 詳細の DL entry UI + `components/pwa/install-prompt.tsx` + persist() 配線(spec §6/§7)。
- **Produces**: `downloadDeckImages(userId, examId, opts?): Promise<{ok: boolean, total, downloaded}>`。
- **制約**: 対象 = mirror の exam 配下 cards(`[user_id+exam_id]` index)から UUID key 集合 → cache miss のみ。resolve は 50 件 batch。job row(`media_download_jobs`)で進捗、**書込順序固定: added_asset_ids へ記録 → その後 Cache put**(added が常に superset = crash 時も sweep が全追加分を掃除可能)。**1 件でも失敗 → 当該 job の added_asset_ids のみ cache delete + job row 削除**(既存キャッシュ不巻込・再開なし)。Web Lock guarded(既存 3 例踏襲)。UI: 進捗(done/total)+「完了までタブを閉じないでください」。DL 開始時 `navigator.storage.persist()` 要求(拒否でも続行)+ iOS Safari 非 standalone なら InstallPrompt(ホーム画面追加案内・**警告付き続行可**)。tech-spec §9.1 checkbox は scope 宣言で SW は未実装・本 task も SW を作らない(spec §7)。
- **完了条件**: unit(miss 差分のみ DL / all-or-nothing rollback / **記録→put 順序(crash 時 superset)** / job 状態遷移 / persist 拒否続行 / 非 standalone 判定)green / gate + build / review pass / commit。

---

## Sprint 完了 gate・smoke(spec §10)

- [ ] whole-repo `pnpm lint --max-warnings=0` / `pnpm install --frozen-lockfile` / `pnpm typecheck` / `pnpm build` / `pnpm test`(full)全 exit 0。報告に「whole-repo lint exit 0 確認済」1 行。
- [ ] whole-branch review(canonical + Codex)で Ready to merge(Crit 0 / Imp 0)。
- [ ] session doc 即 commit(`[no-review]`)— **手動掃除の素材を含める**(orphan reserved / ready 孤児の確認・削除 SQL 例 + `users/{user_id}/` prefix の R2 手動削除手順)→ 停止 → OT push → **stg smoke(DevTools MCP・ops 前提の CORS 設定完了後)**: 正常経路(添付 → 即時表示 → reload 後表示 → server 反映)/ 一括 DL 正常 / placeholder 経路。
- [ ] OT 実機のみ: iPhone HEIC(Photos 経由 JPEG 自動変換の真偽)/ Safari 実機 PNG fallback。
- [ ] 失敗経路(PUT 失敗・圧縮失敗・Safari fallback 等)は unit を正とする(spec §10・1 行明記済)。
