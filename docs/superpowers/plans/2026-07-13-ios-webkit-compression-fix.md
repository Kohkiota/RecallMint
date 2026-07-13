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
- **gate 区別(Codex#15)**: **per-task gate** = 対象 test + whole-repo lint(--max-warnings=0)+ typecheck(build なし — 新規 route/matcher/next 設定なしゆえ)。full test は統合 task(T4-T6)。**sprint 完了 gate(T6)** = + `build` + full `test`(全 exit 0)。
- **命名の統一**: spec の `compressionPath="webkit-safe"` を canonical とする(kickoff の "ios-custom" は同一経路の別称 → webkit-safe に統一)。

---

### Task 1: WebKit 判定

**Files:** Create `lib/media/webkit-detect.ts` / Test `lib/media/webkit-detect.test.ts`
**Interfaces — Produces:** `isWebKitImagePipeline(): boolean`(判定のみ。WebP probe は概念別責務ゆえ T3 の `compress-image-safe.ts` に置く — spec File 表準拠)

- **目的**: WebKit(iOS 全 browser + desktop Safari + desktop-class iPad)判定を提供し、圧縮 pipeline 分岐の gate とする。
- **制約**: 判定 = `/iP(ad|hone|od)/.test(ua)` **OR** `navigator.platform==='MacIntel' && (navigator.maxTouchPoints??0)>1`(desktop-class iPad の穴)**OR** `/AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(ua)`。iOS Chrome(CriOS)/Firefox(FxiOS)は iP* 条件で true(除外しない)。`typeof navigator==='undefined'` は false。
- **完了条件**: unit(iOS Safari/iOS Chrome(CriOS)/iOS Firefox(FxiOS)/desktop-class iPad(MacIntel+touch)/desktop Safari=true、Blink/desktop Firefox=false)green / Crit0 / [reviewed]。

### Task 2: 出力妥当性検証(全経路共通)

**Files:** Create `lib/media/image-validation.ts` / Test `lib/media/image-validation.test.ts`
**Interfaces — Produces:** `validateImageStructure(blob: Blob, expected?: { width: number; height: number }): Promise<{ ok: boolean; reason?: string; width: number; height: number }>`(decode + magic-byte↔type + 寸法。構造のみ・T5 fallback が元画像に再利用)/ `validateCompressionOutput(input: Blob, output: Blob, expected?: { width: number; height: number }): Promise<{ ok: boolean; reason?: string; metrics: ValidationMetrics }>`(構造 + 情報消失)/ 純関数 `evaluateValidity(structural, inM, outM): { ok: boolean; reason?: string }`。型 = `SampleMetrics = { opaqueRatio; meanLuma; lumaVar; edgeEnergy }` / `ValidationMetrics = { input: SampleMetrics; output: SampleMetrics; mae }`(reject は入出力両方の metric を要するため分離)。

- **目的**: 「白いか」でなく「情報が消えたか」を判定し、空/塗り潰し/透過全欠落/偽装 type の破損出力を reject する。**誤検知回避最優先**。
- **制約**: decode は **WebKit-safe(`HTMLImageElement` + object URL・`createImageBitmap` 不使用)**。構造 = decode 成功 / `naturalW,H>0` / `blob.type ∈ {image/webp,png,jpeg}` / magic-byte↔type 一致(`RIFF..WEBP`/`\x89PNG`/`\xFF\xD8\xFF`)/ 空 type・null blob は fail / expected 有(WebKit 経路)のみ寸法 ±1px 照合。内容 = 入出力を `VALIDATE_SAMPLE` 角 canvas に全体縮小し `SampleMetrics` 算出 + `mae`。reject(AND)= 構造 fail **OR**(`input.opaqueRatio>OPAQUE_IN_MIN && output.opaqueRatio<OPAQUE_OUT_MAX`)**OR**(`input.lumaVar>VAR_IN_MIN && output.lumaVar<VAR_OUT_MAX && mae>MAE_MAX`)。edge energy は metrics のみ(gate 外)。判定は `evaluateValidity` 純関数に分離。
- **完了条件**: unit — **誤検知テスト最重要**(全白/単色背景/小アイコン/黒板写真/線画/手書きメモ/透過 PNG を **pass**)+ reject 系(空/塗り潰し/透過全欠落/magic≠type/空 type/null/極小)を合成 `ImageData`+metrics で。`validateImageStructure` の decode 失敗/寸法/magic も unit。green / Crit0 / [reviewed]。

### Task 3: WebKit 自前圧縮 pipeline

**Files:** Create `lib/media/compress-image-safe.ts` / Test `lib/media/compress-image-safe.test.ts`
**Interfaces — Consumes:** `isWebKitImagePipeline`(T1・caller 側)/ **Produces:** `compressImageSafe(file: File): Promise<CompressResult>`(`CompressResult` = `upload.ts` 既存 `{ blob, mime, width, height, hash }`)/ `canEncodeWebp(): boolean` / 純関数 `computeScale(srcW: number, srcH: number): { outW: number; outH: number }`

- **目的**: 最終出力寸法の canvas だけで圧縮し、巨大 canvas を作らない(根本原因を断つ)。
- **制約**: `scale=min(1, MAX_EDGE/srcW, MAX_EDGE/srcH, sqrt(MAX_PIXELS/(srcW*srcH)))`・`outW=max(1,round(srcW*scale))`(H 同)。src が 0/NaN は decode 失敗 throw。手順 = `HTMLImageElement`(`createObjectURL`)decode → `img.decode()` await → oriented 寸法 → `outW×outH` canvas 生成 → `drawImage(img,0,0,outW,outH)` → **alpha 判定**(縮小後 canvas の `getImageData` の alpha channel に <255 が存在するか。白塗り**前**に判定 — 白塗りは alpha を潰すため)→ 形式決定 → encode。`canEncodeWebp()` = 2×2 canvas `toDataURL('image/webp')` が `'data:image/webp'` 始まり(memoize・例外 false)。
- **形式**: `canEncodeWebp()` → **WebP**(alpha 保持ゆえ白塗り不要)/ 否 かつ alpha → **PNG**(白塗りしない)/ 否 かつ alpha なし → **JPEG**(この時のみ **drawImage 前に別 canvas 白塗り** or 白背景合成)。encode = `toBlob(cb,type,quality)` 優先(null → `toDataURL`→blob fallback)。`mime = 実 blob.type`。`hash = sha256(出力)`(既存 `sha256Hex` 流用)。**EXIF orientation はブラウザ自動適用に委ね再回転しない**。**object URL revoke + canvas width=height=0 解放**。`createImageBitmap` 不使用。
- **完了条件**: unit(`computeScale` 境界: 長い/極端縦横/巨大/小/正方/1px/round→0防止 / 形式選択を `canEncodeWebp` stub × alpha 有無で・白塗りが JPEG のみ)green。drawImage/encode 実挙動は smoke。Crit0 / [reviewed]。

### Task 4: `compressForAttach` 分岐 + 共通検証 + single-flight(統合・risk)

**Files:** Modify `lib/media/upload.ts` / Test `lib/media/upload.test.ts`
**Interfaces — Consumes:** `isWebKitImagePipeline`(T1)/`compressImageSafe`(T3)/`validateCompressionOutput`(T2)/ **Produces:** `runExclusiveImageWork<T>(fn: () => Promise<T>): Promise<T>`(module single-flight)/ tagged `ValidationFailedError`

- **目的**: WebKit 分岐 + 全経路共通検証を統合し、iOS を逐次化する。**Blink の圧縮処理(lib 呼出)は無改変**(検証は全経路に追加されるが正常出力は pass = observable 回帰なし)。
- **制約**: `compressForAttach` = 入口 gate → (WebKit → `compressImageSafe` / 否 → 既存 `imageCompression(...)`) → **共通 `validateCompressionOutput`**(WebKit 経路のみ `expected` 渡す・lib 経路は decode>0)。検証 reject → `ValidationFailedError` throw。**single-flight の境界(Codex#6)**: `runExclusiveImageWork` は **saga(`attachImageToCard`)側で 1 添付の「compress→validate→(fallback)」区間を 1 つの exclusive work として包む**(compressForAttach 内で自己 wrap しない = 二重 lock 回避・compress 失敗後 lock を解放せず fallback まで連続)。**WebKit のみ wrap**(Blink は従来どおり並列)。既存「Safari WebP→PNG 前提」コメント/仮定を runtime probe 前提に置換(非 Safari 無影響を実コードで確認)。`CompressResult` shape・既存 error code 不変。
- **完了条件**: unit(WebKit stub → safe pipeline+検証呼出 / 非 WebKit → lib+検証(並列)/ 検証 reject → `ValidationFailedError` / WebKit のみ逐次)+ **既存 `upload.test.ts` 回帰 green(Blink 経路無変化)** + whole-repo test green。Crit0/Imp0(risk ゆえ Codex 重点)/ [reviewed]。

### Task 5: fallback — 元画像 direct PUT

**Files:** Modify `lib/media/upload.ts` / Test `lib/media/upload.test.ts`
**Interfaces — Consumes:** `compressForAttach` の throw(`COMPRESS_FAILED`/`ValidationFailedError`・T4)/ `validateImageStructure`(T2)

- **目的**: 圧縮 or 検証失敗でユーザーを詰ませない。元画像を圧縮版と同じ reserve→楽観層→PUT→finalize 経路で上げる。
- **制約**: `attachImageToCard` の compress catch で fallback: 元が jpg/png かつ ≤ `MAX_ASSET_BYTES`(5MiB)なら **`validateImageStructure(元 blob)` を再利用**(T2・重複実装しない)して decode/寸法/magic を確認 → `mime=file.type`(fallback は入口 gate 通過後ゆえ `file.type` は非空・妥当。万一空なら magic-byte から補完)/ `width,height=validateImageStructure が返す oriented 寸法`(圧縮版と統一)/ `hash=sha256(元)` で reserve。**楽観層 primitive は 1 回だけ**(圧縮失敗→fallback 成功で二重更新しない)。fallback は T4 の同一 exclusive work 区間内(新規 lock 取得しない)。許可外/>5MiB/decode 不能/偽装拡張子(magic≠拡張子)→ 既存 `COMPRESS_FAILED`(UI 維持)。
- **完了条件**: unit(圧縮失敗→元 PUT / 検証失敗→元 PUT / >5MiB→エラー / 偽装拡張子・decode 不能→エラー / 楽観層 1 回)+ 回帰 green。Crit0 / [reviewed]。

### Task 6: telemetry(全転帰)

**Files:** Modify `lib/media/upload.ts` / Test `lib/media/upload.test.ts`
**Interfaces — Consumes:** T4/T5 の全経路

- **目的**: 修正の効果確認 + 閾値調整材料を、**1 添付 = 1 レコード**(最終 outcome + reason)で記録する。
- **制約**: `attachImageToCard` は **1 添付につき logger.info を 1 回**(最終転帰)。`outcome ∈ {success, fallback_used, error}` + `reason?`(`validation_failed`/`compress_failed`/`fallback_too_large`/`fallback_not_allowed`/`decode_failed`)で、検証 reject→fallback 成功は `outcome:"fallback_used", reason:"validation_failed"`(reject を別レコードにしない)。schema = `{ event:'image_attach', outcome, reason?, compressionPath, source?:{type,bytes,width?,height?}, output?:{requestedType?,actualType,bytes,width,height}, validationMetrics? }`。**decode 不能等で取れない field は optional(省略)**・`requestedType` は WebKit-safe のみ(lib/fallback は省略)。`compressionPath ∈ {webkit-safe, lib, fallback}`。**bytes 本体/file名/hash は記録しない**。upload.ts 肥大時は小 helper(`image-attach-telemetry.ts`)へ抽出可(Codex#12)。
- **完了条件**: unit(各転帰で 1 レコード・正しい `outcome`/`reason`/`compressionPath`/optional field を logger mock で assert)+ 回帰 green。**sprint 完了 gate = whole-repo lint --max-warnings=0 / typecheck / build / test 全 exit 0**(build はここで実施)。Crit0 / [reviewed]。

---

## 検証(spec §10 の plan 具体化)

- **unit を正**(T1-T6 各完了条件)。canvas/WebKit の drawImage/encode 実挙動は mock 困難ゆえ smoke で担保。**reject/fallback の正しさは unit が authority**(良品画像では実機で誘発困難ゆえ・Codex#13)。
- **実機 smoke(OT iPad・Mac なし → telemetry 構造化ログを stg 確認 or 画面表示)**: iPad で 長いスクショ / 大画像 / 通常画像 / 透過画像 を添付 → 健全な webp/jpeg/png が R2 着地(**856B 破損が出ない**)+ 表示 + telemetry に `compressionPath="webkit-safe"`・`outcome:"success"`・健全な `validationMetrics`。EXIF orientation(代表 = iPhone orientation 6)実機確認(正立表示 + 保存寸法一致)。**PC(Blink)回帰**(`compressionPath="lib"` で従来どおり正常)。
- **破損 test データ手動掃除(Codex#14)**: 完了条件に含める。対象特定 = 本バグ期間に着地した **≈856B(極小)webp を `users/{test user_id}/` prefix で**特定(§画像フェーズ A session doc §8 の掃除 SQL/prefix 参照)。誤削除防止に件数確認後 OT が R2 コンソールで削除。

## 実装確認事項(実装時裏取り・spec 差し戻しでない)

1. **T4 で Blink 既存経路が無改変**であることを実コードで確認(分岐は WebKit のみ・lib 呼出と既存 `mime=blob.type`/`createImageBitmap` 寸法取得は不変)。既存 `upload.test.ts` の Blink 系 assertion が全て green のまま。
2. **T2 の誤検知テストを最重要扱い**: 「壊れた出力を reject」より「正当な低分散/白/単色/透過を通過」の test を厚く。閾値が保守的か・入力比で情報消失を見る設計(GPT 意図)が test で担保されているか。

## Codex plan cross-check 取りまとめ

Codex plan cross-check(生ログ `docs/codex/2026-07-13-plan-ios-webkit-compression-plan.md`)の decomposition 論点 15 件を反映済: `canEncodeWebp` を T3 へ(spec File 表準拠・#1)/ `ValidationMetrics` を input/output 分離(#2)/ `validateImageStructure` を T2 で共通化し T5 が再利用(#3)/ alpha 判定を白塗り前に明示・白塗りは JPEG のみ(#4,#5)/ single-flight を saga 側 1 区間・WebKit のみ(#6)/ telemetry を 1 添付 1 レコード + optional field(#7,#9,#10)/「無改変」を「圧縮処理は無改変・検証は追加」に是正(#8)/ fallback の file.type/magic 補完(#11)/ telemetry helper 抽出余地(#12)/ smoke の reject-fallback は unit authority(#13)/ R2 掃除の対象特定(#14)/ per-task と完了 gate の build 区別(#15)。**新規 OT 判断論点なし**(risk トレードオフ = desktop Safari 含む / 形式簡素化 / single-flight UX / server defense は spec review で既出・OT 確定済)。

*次段: 本 plan(反映済)を docs commit → **OT 承認** → subagent-driven 実装(Opus subagent + per-task canonical + Codex review)。*
