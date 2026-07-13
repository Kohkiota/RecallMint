# iOS/WebKit 画像圧縮破損 修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development で task 単位に実装。各 task は fresh subagent + per-task review(canonical + Codex)。

**Goal:** iPad(iOS/WebKit)で画像添付が破損(≈856B の壊れた webp が R2 着地)する不具合を、WebKit 専用自前圧縮 pipeline + 出力妥当性検証 + fallback + telemetry で恒久修正する。

**Architecture:** `compressForAttach` を「WebKit → 自前 pipeline(最終寸法 canvas のみ)/ 非 WebKit → 既存 browser-image-compression」に分岐し、**全経路共通の出力妥当性検証**(構造 + 情報消失)を reserve より前に一段挟む。検証/圧縮失敗は fallback(元画像 direct PUT)。iOS は圧縮+検証+fallback を single-flight で逐次。全転帰を telemetry 記録。

**Tech Stack:** TypeScript strict / Next.js client(browser canvas API: HTMLImageElement / `canvas.toBlob` / `toDataURL` probe)/ Vitest(合成 ImageData で検証ロジック unit)/ 既存 R2 presigned 直 PUT saga。

**Spec(凍結):** `docs/superpowers/specs/2026-07-13-ios-webkit-compression-fix-design.md`

## Global Constraints(全 task 共通・spec verbatim)

- **非 WebKit(Blink/Firefox)の既存 `compressForAttach` 経路は無改変**で回帰 green(正常な 44KB webp 生成を壊さない)。分岐 = WebKit → 自前 pipeline / それ以外 → 既存 lib。
- **出力形式は実 `blob.type` から決める**(webp を仮定しない)。**WebP 可否は UA でなく `canEncodeWebp()` runtime probe**。
- **検証は reserve より前に一段だけ**(孤児防止)。**PUT 直前 guard は置かない**(論点2)。
- **誤検知回避が最優先**: 正当な低分散/白/単色/透過画像を通す。**破滅的崩壊のみ reject**。入力比で情報消失を見る(単独 uniform reject 禁止)。
- **iOS 逐次(single-flight)**: 圧縮 + 検証 + fallback decode を**全 card 横断**で逐次(並列圧縮の黒画像回避)。object URL は `revokeObjectURL`・canvas は `width=height=0` で解放。
- **ESLint Block A**: `lib/**` は `@/app/**` を import 不可(server action は既存 DI のまま・本 plan で新規注入なし)。
- **定数(全 export・telemetry で調整)**: `MAX_EDGE=2048` / `MAX_PIXELS=4_000_000` / `JPEG_QUALITY=0.85` / `WEBP_QUALITY=0.85` / `VALIDATE_SAMPLE=64` / `OPAQUE_IN_MIN=0.5` / `OPAQUE_OUT_MAX=0.01` / `VAR_IN_MIN=100` / `VAR_OUT_MAX=4` / `MAE_MAX=40`。
- **telemetry**: `logger.info`(`lib/logger.ts`)で全転帰(success / validation_rejected / fallback_used / error)+ reason + source/output メタ + validationMetrics + `compressionPath ∈ {webkit-safe, lib, fallback}`。**PII(画像 bytes 本体 / file 名 / hash)は記録しない**。
- **feat 経路**: 各 task canonical(general-purpose)+ Codex(codex-review.sh)で Crit0/Imp0 → commit `[reviewed]`。外部副作用(R2 書込)ゆえ `[reviewed]` は canonical+Codex pass で付与・実機 smoke は session doc を正記録。
- **per-task gate**: 対象 test + whole-repo lint(--max-warnings=0)+ typecheck。full test は統合 task(T4-T6)で。client component は build 不要(新規 route/matcher なし)。
- **命名の統一**: spec の `compressionPath="webkit-safe"` を canonical とする(kickoff の "ios-custom" は同一経路の別称 → webkit-safe に統一)。

---

### Task 1: WebKit 判定 + WebP encode probe

**Files:** Create `lib/media/webkit-detect.ts` / Test `lib/media/webkit-detect.test.ts`
**Interfaces — Produces:** `isWebKitImagePipeline(): boolean` / `canEncodeWebp(): boolean`

- **目的**: WebKit(iOS 全 browser + desktop Safari + desktop-class iPad)判定と、canvas の WebP encode 可否 probe を提供する。
- **制約**: 判定 = `/iP(ad|hone|od)/.test(ua)` **OR** `navigator.platform==='MacIntel' && (navigator.maxTouchPoints??0)>1`(desktop-class iPad の穴)**OR** `/AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(ua)`。iOS Chrome(CriOS)/Firefox(FxiOS)は iP* 条件で true。`typeof navigator==='undefined'` は false。`canEncodeWebp` = 2×2 canvas の `toDataURL('image/webp')` が `'data:image/webp'` 始まり(session 1 回 memoize・例外は false)。
- **完了条件**: unit(iOS Safari/iOS Chrome(CriOS)/iOS Firefox(FxiOS)/desktop-class iPad(MacIntel+touch)/desktop Safari=true、Blink/desktop Firefox=false、probe 可/不可 stub)green / Crit0 / [reviewed]。

### Task 2: 出力妥当性検証(全経路共通)

**Files:** Create `lib/media/image-validation.ts` / Test `lib/media/image-validation.test.ts`
**Interfaces — Produces:** `validateCompressionOutput(input: Blob, output: Blob, expected?: { width: number; height: number }): Promise<{ ok: boolean; reason?: string; metrics: ValidationMetrics }>`(`input` は元 File/Blob、`output` は圧縮 Blob)/ 純関数 `evaluateValidity(structuralOk, structuralReason, inM, outM): { ok: boolean; reason?: string }`(`ValidationMetrics = { opaqueRatio; meanLuma; lumaVar; edgeEnergy; mae }`)

- **目的**: 「白いか」でなく「情報が消えたか」を判定し、空/塗り潰し/透過全欠落/偽装 type の破損出力を reject する。**誤検知回避最優先**。
- **制約**: decode は **WebKit-safe(`HTMLImageElement` + object URL・`createImageBitmap` 不使用)**。構造 = decode 成功 / `naturalW,H>0` / `blob.type ∈ {image/webp,png,jpeg}` / magic-byte↔type 一致(`RIFF..WEBP`/`\x89PNG`/`\xFF\xD8\xFF`)/ 空 type・null blob は fail / expected 有(WebKit 経路)のみ寸法 ±1px 照合。内容 = 入出力を `VALIDATE_SAMPLE` 角 canvas に全体縮小し metrics 算出。reject(AND)= 構造 fail **OR**(`opaqueRatio_in>OPAQUE_IN_MIN && opaqueRatio_out<OPAQUE_OUT_MAX`)**OR**(`lumaVar_in>VAR_IN_MIN && lumaVar_out<VAR_OUT_MAX && mae>MAE_MAX`)。edge energy は metrics のみ(gate 外)。判定は `evaluateValidity` 純関数に分離。
- **完了条件**: unit — **誤検知テスト最重要**(全白/単色背景/小アイコン/黒板写真/線画/手書きメモ/透過 PNG を **pass**)+ reject 系(空/塗り潰し/透過全欠落/magic≠type/空 type/null/極小)を合成 ImageData + metrics で。green / Crit0 / [reviewed]。

### Task 3: WebKit 自前圧縮 pipeline

**Files:** Create `lib/media/compress-image-safe.ts` / Test `lib/media/compress-image-safe.test.ts`
**Interfaces — Consumes:** `canEncodeWebp`(T1) / **Produces:** `compressImageSafe(file: File): Promise<CompressResult>`(`CompressResult` = `upload.ts` 既存 `{ blob, mime, width, height, hash }`)/ 純関数 `computeScale(srcW: number, srcH: number): { outW: number; outH: number }`

- **目的**: 最終出力寸法の canvas だけで圧縮し、巨大 canvas を作らない(根本原因を断つ)。
- **制約**: `scale=min(1, MAX_EDGE/srcW, MAX_EDGE/srcH, sqrt(MAX_PIXELS/(srcW*srcH)))`・`outW=max(1,round(srcW*scale))`(H 同)。src が 0/NaN は decode 失敗 throw。手順 = `HTMLImageElement`(`createObjectURL`)decode → `img.decode()` await → oriented 寸法 → `outW×outH` canvas 生成 → `drawImage(img,0,0,outW,outH)` → encode。**EXIF orientation はブラウザの自動適用(既定 `image-orientation:from-image`)に委ね、アプリ側で再回転しない**(二重回転防止)。形式 = `canEncodeWebp()` → WebP / alpha あり → PNG / else JPEG(**drawImage 前に白塗り**)。encode = `toBlob(cb,type,quality)` 優先(null → `toDataURL`→blob fallback)。`mime = 実 blob.type`。`hash = sha256(出力)`(既存 `sha256Hex` 流用)。**object URL revoke + canvas width=height=0 解放**。`createImageBitmap` 不使用。
- **完了条件**: unit(`computeScale` 境界: 長い/極端縦横/巨大/小/正方/1px/round→0防止 / 形式選択を `canEncodeWebp` stub × alpha 有無で)green。drawImage/encode 実挙動は smoke。Crit0 / [reviewed]。

### Task 4: `compressForAttach` 分岐 + 共通検証 + single-flight(統合・risk)

**Files:** Modify `lib/media/upload.ts` / Test `lib/media/upload.test.ts`
**Interfaces — Consumes:** `isWebKitImagePipeline`(T1)/`compressImageSafe`(T3)/`validateCompressionOutput`(T2)/ **Produces:** `runExclusiveImageWork<T>(fn: () => Promise<T>): Promise<T>`(module single-flight)/ tagged `ValidationFailedError`

- **目的**: WebKit 分岐 + 全経路共通検証を既存 `compressForAttach` に統合し、iOS を逐次化する。**Blink 既存経路を無改変で回帰 green**。
- **制約**: `compressForAttach` = 入口 gate → (WebKit → `compressImageSafe` / 否 → 既存 `imageCompression(...)`) → **共通 `validateCompressionOutput`**(WebKit 経路のみ `expected` 渡す・lib 経路は decode>0)。検証 reject → `ValidationFailedError` throw(saga が fallback 判定に使う)。WebKit 時は圧縮+検証を `runExclusiveImageWork` で逐次(`serializePerCard` と別・全 card 横断)。既存「Safari WebP→PNG 前提」コメント/仮定を runtime probe 前提に置換(非 Safari 無影響を実コードで確認)。`CompressResult` shape・既存 error code 不変。
- **完了条件**: unit(WebKit stub → safe pipeline+検証呼出 / 非 WebKit → lib+検証 / 検証 reject → `ValidationFailedError` / 逐次化)+ **既存 `upload.test.ts` 回帰 green(Blink 経路無変化)** + whole-repo test green。Crit0/Imp0(risk ゆえ Codex 重点)/ [reviewed]。

### Task 5: fallback — 元画像 direct PUT

**Files:** Modify `lib/media/upload.ts` / Test `lib/media/upload.test.ts`
**Interfaces — Consumes:** `compressForAttach` の throw(`COMPRESS_FAILED`/`ValidationFailedError`・T4)

- **目的**: 圧縮 or 検証失敗でユーザーを詰ませない。元画像を圧縮版と同じ reserve→楽観層→PUT→finalize 経路で上げる。
- **制約**: `attachImageToCard` の compress catch で fallback: 元が jpg/png かつ ≤ `MAX_ASSET_BYTES`(5MiB)なら **元 blob の構造検証**(decode/naturalW,H>0/magic↔`file.type`)→ `mime=file.type` / `width,height=oriented decode`(圧縮版と統一)/ `hash=sha256(元)` で reserve。**楽観層 primitive は 1 回だけ**(圧縮失敗→fallback 成功で二重更新しない)。fallback decode も `runExclusiveImageWork` 内。許可外/>5MiB/decode 不能/偽装拡張子 → 既存 `COMPRESS_FAILED`(UI 維持)。
- **完了条件**: unit(圧縮失敗→元 PUT / 検証失敗→元 PUT / >5MiB→エラー / 偽装拡張子・decode 不能→エラー / 楽観層 1 回)+ 回帰 green。Crit0 / [reviewed]。

### Task 6: telemetry(全転帰)

**Files:** Modify `lib/media/upload.ts` / Test `lib/media/upload.test.ts`
**Interfaces — Consumes:** T4/T5 の全経路

- **目的**: 修正の効果確認 + 閾値調整材料を、全転帰同一 schema で記録する。
- **制約**: `attachImageToCard` の各転帰(success / validation_rejected→fallback / fallback_used / error)で `logger.info({ event: 'image_attach', outcome, reason?, compressionPath, source:{type,bytes,width,height}, output:{requestedType,actualType,bytes,width,height}, validationMetrics })`。**reject/fallback 例も必ず記録**(閾値調整に必須)。`compressionPath ∈ {webkit-safe, lib, fallback}`。**bytes 本体/file名/hash は記録しない**(メタ数値のみ)。
- **完了条件**: unit(各転帰で正しい `outcome`/`reason`/`compressionPath`/metrics を logger mock で assert)+ 回帰 green + **whole-repo gate 全 exit 0**(lint --max-warnings=0 / typecheck / build / test)。Crit0 / [reviewed]。

---

## 検証(spec §10 の plan 具体化)

- **unit を正**(T1-T6 各完了条件)。canvas/WebKit の drawImage/encode 実挙動は mock 困難ゆえ smoke で担保。
- **実機 smoke(OT iPad・Mac なし → telemetry 構造化ログを stg 確認 or 画面表示)**: iPad で 長いスクショ / 大画像 / 通常画像 / 透過画像 を添付 → 健全な webp/jpeg/png が R2 着地(**856B 破損が出ない**)+ 表示 + telemetry に `compressionPath="webkit-safe"` と健全な `validationMetrics` + 全転帰(success/reject/fallback)が理由付きで記録。EXIF orientation(代表 = iPhone orientation 6)実機確認(正立表示 + 保存寸法一致)。**PC(Blink)回帰**(`compressionPath="lib"` で従来どおり正常)。
- **完了条件に「破損 test データ(R2 の壊れた ≈856B webp)の手動掃除」を含める**(OT が R2 コンソールで削除)。

## 実装確認事項(実装時裏取り・spec 差し戻しでない)

1. **T4 で Blink 既存経路が無改変**であることを実コードで確認(分岐は WebKit のみ・lib 呼出と既存 `mime=blob.type`/`createImageBitmap` 寸法取得は不変)。既存 `upload.test.ts` の Blink 系 assertion が全て green のまま。
2. **T2 の誤検知テストを最重要扱い**: 「壊れた出力を reject」より「正当な低分散/白/単色/透過を通過」の test を厚く。閾値が保守的か・入力比で情報消失を見る設計(GPT 意図)が test で担保されているか。

*次段: 本 plan を [no-review] docs commit → `codex-plan-review.sh` で cross-check → 結果報告 → OT 承認 → subagent-driven 実装(Opus subagent + per-task Codex review)。*
