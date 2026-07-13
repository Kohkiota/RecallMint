# iOS/WebKit 画像圧縮破損 修正 — 設計 (spec)

**Goal:** iPad(iOS/WebKit)で画像添付が破損(R2 に ≈856B の壊れた webp が着地)する不具合を、WebKit 専用の自前圧縮 pipeline + 出力妥当性検証 + fallback で恒久修正する。

**Status:** 原因究明・3 本柱設計は OT 確定済(claude.ai 討議 + Codex code 追跡 + GPT 2 巡 WebKit 監査)。本 spec は確定設計の実装計画への落とし込み。**独立スプリント**(画像フェーズ A の後付けでなく変更源を分離)。

**確定した原因**(詳細: `docs/superpowers/sessions/2026-07-12-ios-webkit-compression-corruption-debug.md`):
- `browser-image-compression` が canvas 上限を「面積」近似(`w*h ≤ 4096²`)し per-dimension を見ない → 長い/大きい画像が iOS canvas 上限に抵触。
- lib は `maxWidthOrHeight` 適用**前**に元画像サイズの巨大 canvas を作る → 縮小前に空/部分描画。
- iPad が desktop Safari 扱いになる UA 判定の穴。
- 出力の pixel/decode/format 検証が皆無 → 壊れた出力を size のみで success 扱い。
- どの分岐(巨大 canvas / UA 誤判定 / worker fallback / encode 差)を通ったかに関わらず**正しい修正は同一**ゆえ実機での分岐特定は不要。修正後 telemetry で検証。

---

## Architecture(3 本柱 + 統合)

WebKit 判定時のみ自前 pipeline に分岐し、非 WebKit は既存ライブラリを維持する。**出力妥当性検証と fallback は全経路共通**。統合点は既存 `compressForAttach`(圧縮の入口)と `attachImageToCard`(saga)。

```
attachImageToCard
  └─ compressForAttach(file)                     [入口 gate: 型/拡張子]
       ├─ WebKit?  → compressImageSafe(file)      [柱1: 自前 pipeline]
       │            else → browser-image-compression(既存)
       └─ validateCompressionOutput(file, out)    [柱2: 全経路共通・圧縮直後]
  ├─ (compress or validate 失敗) → fallback:      [柱3]
  │      元が jpg/png かつ ≤5MiB → 元画像を direct PUT / 否 → 明示エラー
  ├─ reserve(byteSize/mime = 実 blob.type)        [孤児防止: 検証 pass 後にのみ reserve]
  ├─ 楽観層 → 直 PUT → finalize
  └─ telemetry(logger.info: path / metrics)       [検証]
```

### 柱1 (a): WebKit 専用圧縮 pipeline — `lib/media/compress-image-safe.ts`(新規)

**核: 最初から最終出力寸法の canvas だけ作る**(元画像サイズの巨大 canvas を作らない = 根本原因を断つ)。

- **縮小率**は max-edge と max-pixels の両方で決定:
  ```
  scale = min(1, MAX_EDGE/srcW, MAX_EDGE/srcH, sqrt(MAX_PIXELS/(srcW*srcH)))
  outW = max(1, round(srcW*scale)), outH = max(1, round(srcH*scale))
  ```
  初期定数 `MAX_EDGE = 2048` / `MAX_PIXELS = 4_000_000`(4MP)。両方 spec 定数化(telemetry で後調整)。
  **境界(Codex#2)**: `round` の 0px 化を `max(1,…)` で防ぐ / 極端な縦長・横長(片辺だけ長い)も per-edge cap で確実に縮む / srcW or srcH が 0/NaN は decode 失敗扱い。
- **手順**: `HTMLImageElement`(`new Image` + `URL.createObjectURL`)で decode → `img.decode()` await → oriented 寸法取得 → `outW×outH` の canvas を 1 枚だけ生成 → `drawImage(img, 0,0, outW,outH)`(元サイズ canvas を経由しない)→ encode。iOS では `createImageBitmap` を使わない(lib の Safari 対策と同理由)。**object URL は decode 後 `revokeObjectURL`・canvas は使用後 `width=height=0` で解放**(Codex#3・連続添付のメモリ圧迫防止)。
- **出力形式**(§論点1 の probe で決定・**UA で決めない**):
  1. `canEncodeWebp()` probe 成功 → **WebP**。
  2. 否 かつ 元に alpha あり → **PNG**。
  3. 否 かつ alpha なし → **JPEG**(q `JPEG_QUALITY`)。
  - **encode API(Codex#7)**: `canvas.toBlob(cb, type, quality)` を**優先**(Blob 直返し=base64 の余分メモリを避ける)。`toBlob` が `null`/未対応なら `toDataURL`→blob に fallback。
  - **probe と実 encode の乖離(Codex#6)**: 小 canvas probe 成功でも実 encode が別 MIME を返しうる → **実 `blob.type` を信頼し、allowlist 外/magic 不一致は柱2 で reject→柱3 fallback**(型を仮定しない安全網)。
  - **簡素化(要 OT 確認)**: brief の「写真→JPEG / 図表・スクショ→PNG」区別は WebP 経路が主(modern WebKit)ゆえ **no-WebP fallback 時のみ**必要。**脆い写真/図表分類器を置かず alpha 有無で決める**(YAGNI)。no-WebP の旧 WebKit は稀。可否は OT 判断。
- **JPEG 化時は drawImage 前に canvas を白塗り**(alpha→黒 化を防ぐ)。
- **Content-Type / 拡張子 / presigned PUT の署名 Content-Type は全て実 `blob.type` から決める**(webp を仮定しない)。既存 `mime = blob.type` を踏襲。
- **iOS 逐次化(Codex#8,#12)**: module-level single-flight(`runExclusiveImageWork`)で **1 添付の圧縮 + 検証 + fallback decode まで**を**全 card 横断**に逐次化(圧縮だけ逐次でも validation/fallback の canvas decode が並列だとメモリ問題が残るため)。中断時は object URL / canvas / optimistic Cache / reserved asset を残さない。

### 柱2 (b): 出力妥当性検証 — `lib/media/image-validation.ts`(新規・全経路共通)

「白いか」でなく「**情報が消えたか**」を判定(uniform reject 単独は白紙テンプレ/黒板写真を誤検知)。

- **decode 経路の一貫性(Codex#4)**: 検証の再 decode は **pipeline と同じ WebKit-safe 経路**(`HTMLImageElement` + object URL、`createImageBitmap` を使わない)を共有する。WebKit で `createImageBitmap` が不安定なら検証自体が false-fail するため。出力は圧縮済(≤MAX_EDGE)ゆえ decode メモリ問題なし。
- **magic-byte / blob.type 空文字・偽装(Codex#5,#14)**: `blob.type` が空 / allowlist 外 / `toBlob` が `null` / magic-byte 不一致 は**すべて構造検証 fail**(reject)。encode が要求 MIME を無視して PNG を返す等はここで捕捉。
- **構造検証**: 再 decode 成功 / `naturalWidth,Height > 0` / `blob.type ∈ {image/webp,image/png,image/jpeg}` / **magic-byte と `blob.type` 一致**(RIFF+`WEBP` / `\x89PNG` / `\xFF\xD8\xFF`)。**期待寸法一致(±1px)は `expected` が渡る WebKit pipeline 経路のみ**(outW/outH を自前で決める)。lib/fallback 経路は decode>0 のみ。
- **内容検証**: 入力と出力を**同じ 64×64 canvas に全体縮小**描画(crop でなく全体ゆえ端欠け・片側破損・空描画は縮小版に現れる)。指標 = 非透明率 / 平均輝度 / 輝度分散 / edge energy(隣接差分和)/ 入出力 MAE。**全指標を telemetry 記録**。
- **reject 条件(複数 AND・§論点3 の初期閾値)**:
  - decode 失敗 OR (WebKit 経路の)寸法不一致 OR magic/type/空文字 不一致、**または**
  - (入力 非透明率 > 0.5 AND 出力 非透明率 < 0.01) [情報全欠落・透過崩壊]、**または**
  - (入力 輝度分散 > 100 AND 出力 輝度分散 < 4 AND MAE > 40) [構造の破滅的崩壊 = 空/塗り潰し化]。
  - → **正当な白/低分散画像は入力も低分散ゆえ前提(入力分散 > 100)が成立せず通過**(誤検知しない)。
  - **edge energy は初期は hard gate 外・telemetry 記録のみ**(実機依存・誤検知回避優先)。蓄積後に gate 昇格可。閾値は全て定数 export・調整可。
- **見逃しリスク(受容・Codex#3,#9)**: 64×64 全体縮小は **破滅的崩壊(空/塗り潰し/透過全欠落)** を捕るが、**細線消失・文字潰れ・局所軽微破損は見逃しうる**。要件の「誤検知回避最優先」ゆえ初期は破滅的崩壊のみ reject し、telemetry の全 metric 蓄積で閾値を段階強化する(初期から局所検出を積むと誤検知過多になる)。

### 柱3: fallback — saga 内(`attachImageToCard`)

圧縮 or 検証失敗でユーザーを詰ませない。
- 失敗時、元ファイルが**許可形式(jpg/png)かつ ≤ `MAX_ASSET_BYTES`(5MiB)**なら、**元画像を** reserve→PUT(direct-to-R2 ゆえ Vercel 4.5MB 制限に当たらない)。
- **元画像も構造検証を通す(Codex plan#1)**: 入口 gate は型/拡張子のみで実 decode・magic-byte を保証しない。fallback でも **decode 成功 / `naturalWidth,Height>0` / magic-byte↔`file.type` 一致** を確認(内容検証=入出力比較は不要 — 元画像自身が基準ゆえ)。decode 不能・偽装拡張子・空 MIME はここで明示エラー化。
- **fallback metadata(Codex#2,#13)**: `mime = file.type`(jpg/png)/ `width,height = decode 実寸`(圧縮版と同じ **EXIF 適用後(oriented)寸法** に統一 — 保存寸法の意味を経路で揃える)/ `hash = sha256(元 blob)`。圧縮版と同一の reserve→楽観層→PUT→finalize 経路に乗せる(`finalize` の contentLength 照合は原サイズで pass)。
- **楽観層の整合(Codex#11)**: fallback 成功時も **同じ楽観層 primitive**(Cache put + media_assets 'uploading' + mirror)を元 blob/mime で 1 回だけ実行(圧縮失敗→fallback 成功で二重更新しない)。
- 許可外/巨大(>5MiB)/未知形式/decode 不能 → **明示エラー**(silent に壊さない)。既存 error code(`COMPRESS_FAILED` 等)を UI 維持しつつ、telemetry では reason を分離(§telemetry)。

### 同時手当て(iOS pitfall)

- **EXIF orientation**: 二重回転を防ぐ。`img.decode()` 後にブラウザが自動適用する orientation を基準にし、アプリ側で再回転しない(oriented 寸法をそのまま使う)。orientation 1-8 の実機確認を smoke に。
- **decode メモリ**: 逐次処理 + canvas 即解放で対処(compressed bytes でなく同時 canvas メモリが問題)。
- **color profile(P3/HDR)**: 検証は pixel 完全一致を求めず破滅的情報消失のみ検出(柱2 で担保)。
- **HEIC**: 現状受付外ゆえ本スプリント範囲外(将来)。

---

## 論点の確定(OT guidance で解決)

**論点1 — WebKit 判定方法**: gate = **WebKit エンジン検出(inclusion 寄り)**。自前 pipeline は全 browser で正しく安全ゆえ、false-positive は無害・false-negative(iPad 見逃し)のみ危険。判定 = 従来 iOS UA(`/iP(ad|hone|od)/`)**OR** desktop-class iPad(`navigator.platform==='MacIntel' && maxTouchPoints>1`= iPadOS 13+ が Macintosh を名乗る穴を塞ぐ)**OR** Apple WebKit(`/AppleWebKit/ && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/`)。→ iOS 全 browser + desktop Safari を含む(desktop Safari も WebKit で同 canvas 挙動ゆえ含めるのが正)。**WebP 可否は本 gate と独立に `canEncodeWebp()` runtime probe で決める**(UA で WebP を決めない)。

**論点2 — 検証を挟む位置**: **圧縮直後(reserve 前)に主検証**(柱2 フル)。reserve **より前**で失敗させ reserved 孤児を作らない(GPT 推奨)。**PUT 直前 guard は本設計では置かない(Codex#12 反映・要 OT 確認)**: 主検証〜PUT の間で blob は不変ゆえ最終 guard は冗長で、reserve **後**に失敗させると reserved orphan を生む(画像 GC は out)。belt-and-suspenders を望むなら guard 失敗を既存 `UPLOAD_FAILED`(reserved orphan は spec §3.4 の無害許容)にマップして残す選択も可 — OT 判断。

**論点3 — reject 閾値の初期値**: 誤検知回避を最優先に**保守的**(柱2 の hard gate: 非透明率 0.5/0.01・輝度分散 100/4・MAE 40)。破滅的崩壊のみ reject。edge energy は初期 gate 外(telemetry のみ)。全て定数 export し telemetry で調整可能に。

**論点4 — 既存統合**: `compressForAttach` を **dispatcher 化**(WebKit→`compressImageSafe` / 否→既存 lib)し、末尾で**共通** `validateCompressionOutput` を通す。既存の「Safari WebP→PNG 前提」の暗黙仮定は **runtime probe + 実 `blob.type`** に置換(型を仮定しない)。`mime = blob.type` は honest ゆえ維持。saga は compress/validate 失敗の `catch` に fallback を差す。

**論点5 — fallback の byteSize/mime**: fallback の元画像は**圧縮版と同じ** reserve→PUT→finalize 経路。`byteSize = original.size` / `mime = file.type`(jpg/png)/ `width,height = decode 実寸` / `hash = sha256(original)`。finalize の `contentLength===byteSize` は原サイズ一致で pass。>5MiB は reserve `max` で弾かれる = 柱3 の明示エラー対象。

---

## File 構成

| File | 役割 |
|---|---|
| `lib/media/compress-image-safe.ts`(新) | WebKit 自前 pipeline: 縮小率計算 / 最終寸法 canvas / 形式選択 / 白塗り / 単一 flight / 解放。`canEncodeWebp()` probe。 |
| `lib/media/webkit-detect.ts`(新) | `isWebKitImagePipeline(): boolean`(論点1 の判定)。純関数 + navigator 参照、unit test 可。 |
| `lib/media/image-validation.ts`(新) | `validateCompressionOutput(input, output, expected): Promise<{ ok, reason?, metrics }>`(柱2)。合成 ImageData で unit test。 |
| `lib/media/upload.ts`(改) | `compressForAttach` dispatcher + 共通検証。`attachImageToCard` に fallback + telemetry。 |
| `lib/media/compress-image-safe.test.ts` / `image-validation.test.ts` / `webkit-detect.test.ts`(新) | unit。 |

**Produces(主要 interface)**:
- `isWebKitImagePipeline(): boolean`
- `compressImageSafe(file: File, opts: { maxEdge: number; maxPixels: number }): Promise<{ blob: Blob; width: number; height: number; mime: string; hash: string }>`(= `CompressResult` 互換)
- `validateCompressionOutput(input: File, output: Blob, expected?: { width: number; height: number }): Promise<{ ok: boolean; reason?: string; metrics: ValidationMetrics }>`(`expected` は WebKit pipeline 経路のみ渡す = exact 寸法照合。lib 経路は省略)

---

## 定数(初期値・全て export・telemetry で調整)

```
MAX_EDGE = 2048            // 出力 max 辺 px
MAX_PIXELS = 4_000_000     // 出力 max 面積 (4MP)
JPEG_QUALITY = 0.85
WEBP_QUALITY = 0.85
VALIDATE_SAMPLE = 64       // 内容検証の縮小 canvas 辺
// reject 閾値 (hard gate)
OPAQUE_IN_MIN = 0.5, OPAQUE_OUT_MAX = 0.01
VAR_IN_MIN = 100, VAR_OUT_MAX = 4, MAE_MAX = 40
// edge energy は初期 gate 外 (telemetry 記録のみ)。
```

## Telemetry(実装に組み込む・別 UI は作らない)

stg で `logger.info`(Sprint 2 と同様の構造化ログ)に、**全転帰を同一 schema で 1 レコード**(成功だけでなく **reject / fallback / error も** — Codex#10。閾値調整には reject された画像の metrics が最重要):
`source: { type, bytes, width, height }` / `output: { requestedType, actualType, bytes, width, height }`(fallback は元画像値)/ `compressionPath: "webkit-safe" | "lib" | "fallback"` / `outcome: "success" | "validation_rejected" | "fallback_used" | "error"` / `reason?`(`validation_failed` / `compress_failed` / `fallback_not_allowed` / `fallback_too_large` / `decode_failed`)/ `validationMetrics`。
目的 = 直った確認 + 閾値(2048/4MP/reject)の妥当性検証。**PII 方針(Codex#15): 画像 bytes 本体・file 名・hash はログに出さない(メタ数値のみ)**。

## Error handling / データフロー

- 入口 gate 違反 → `INVALID_TYPE`(既存 UI code)。
- 圧縮 throw or 検証 reject → fallback 試行 → fallback 成功なら通常 success / fallback 不可(許可外・>5MiB・decode 不能)→ `COMPRESS_FAILED`(既存 UI code)。**UI code は既存互換維持、telemetry `reason` で原因を分離**(Codex#13)。
- reserve/PUT/finalize 失敗 → 既存 code。
- 検証は**必ず reserve より前**(孤児防止)。PUT 直前 guard は置かない(論点2)。

---

## テスト方針(unit を正・canvas/WebKit は mock 困難)

- **検証ロジック**: 合成 `ImageData`(全白 / 低分散 / 高分散写真 / 全透明 / 部分破損)で `validateCompressionOutput` を unit。**誤検知テスト最重要**(正当な白画像/低分散図表/線画/手書きメモ/透過 PNG を通過)。**構造 fail 系(Codex#14)も必須**: `blob.type` 空文字 / allowlist 外 / magic-byte↔type 不一致(PNG bytes を webp と主張)/ `toBlob`→`null` / 空 blob / 極小 blob。
- **縮小率計算**: `scale` を srcW×srcH の代表値で unit(長い画像 / 極端縦長横長 / 巨大 / 小画像 / 正方形 / 1px 境界 / round→0 防止)。
- **形式選択 / probe 分岐**: `canEncodeWebp` を stub し webp可/不可 × alpha有/無 の出力型を unit。encode-type 乖離(probe webp OK だが実 encode が png)→ reject→fallback を unit。
- **判定(Codex#5)**: `isWebKitImagePipeline` を navigator stub で厳密 unit — iOS Safari / **iOS Chrome(CriOS)** / **iOS Firefox(FxiOS)**(いずれも iP* UA で true)/ desktop-class iPad(MacIntel+touch)/ desktop Safari(true)/ Blink(false)/ desktop Firefox(false)。
- **fallback**: compress/validate 失敗 → 元画像 構造検証→PUT 経路 / >5MiB → 明示エラー / 偽装拡張子・decode 不能 → 明示エラー、を saga unit(reserve mock)。
- **telemetry**: 各 outcome(success/reject/fallback/error)で正しい reason + metrics が記録されるかを unit(logger mock)。
- AI/実 canvas は使わない。圧縮 pipeline の drawImage/encode 自体は実機 smoke で担保。

## 実機 smoke(§ 完了条件・OT iPad)

Mac なしゆえコンソール不可 → **telemetry の構造化ログを stg で確認**(or 画面表示)。
- iPad で **長いスクショ / 大画像 / 通常画像** を添付 → 正常 webp/jpeg/png が R2 に着地(**856B 破損が出ない**)+ 表示される。
- telemetry に `compressionPath="webkit-safe"` と健全な `validationMetrics`。
- **EXIF orientation(Codex#15)**: 8 種全ての実機用意は難ゆえ、**代表 = iPhone 撮影の orientation 6(横持ち)**を必須とし、可能なら他数種。判定 = 表示画像が正立 + 保存 width/height が oriented 寸法(縦横が期待どおり)。素材と期待寸法は plan で事前定義。
- 非 iOS(PC/Blink)回帰: 従来どおり `compressionPath="lib"` で正常。

---

## スコープ

**In**: WebKit 専用圧縮 pipeline / 出力検証(全経路共通)/ fallback / EXIF・逐次・canvas 解放・alpha 手当て / telemetry / 既存 upload saga への統合(reserve→PUT の前に検証)。
**Out**: HEIC 対応(受付外・将来)/ server-side re-encode(R2 event→Queue・将来)/ 非 WebKit の圧縮ライブラリ置換(現状維持)/ 画像 GC(別スプリント)。

**server 側 defense-in-depth を Out にする根拠(Codex#9,#14・要 OT 確認)**: reserve に byteSize 下限を足す案は、要件が明示的に退けた「min-size 単独 = 弱い」検査そのもの(正当な小画像を誤 reject)。真の内容検証は server が R2 object を DL せねば不能(HEAD は size のみ)。ゆえ client 検証 + fallback を主防御とし server 追加は見送る。**最小の byteSize floor を defense-in-depth として足すか否かは OT 判断**(足すなら誤検知覚悟の保守値)。

## Ops / 完了条件

- 完了条件に **破損 test データ(R2 の壊れた ≈856B webp)の手動掃除**を含める(OT が R2 コンソールで削除。§画像フェーズ A session doc の手動掃除素材参照)。
- gate: `pnpm lint --max-warnings=0` / `typecheck` / `build`(client component 触るため)/ `test` 全 exit 0。
- feat 経路(canonical + Codex・Crit0/Imp0)。**重要 fix(外部副作用: R2 書込)ゆえ [reviewed] は canonical+Codex pass で付与・実機 smoke は session doc を正記録**(画像フェーズ A 既定踏襲)。

---

## Codex cross-check 取りまとめ(独立論点の反映)

Codex 独立 cross-check(生ログ `docs/codex/2026-07-13-plan-ios-webkit-compression-fix.md`)を CC 設計と突き合わせ。**spec に反映した Codex 論点**: 検証 decode の WebKit-safe 統一(#4)/ 元画像 fallback も構造検証(plan#1)/ fallback metadata の EXIF・hash 明確化(#2,#13)/ toBlob 優先(#7)/ 逐次化を圧縮+検証+fallback へ拡張(#8)/ telemetry を全転帰 + reason(#10,#13)/ scale 境界(#2)/ object URL revoke(#3)/ 楽観層整合(#11)/ encode-type 乖離の安全網(#6)/ 構造 fail の test 追加(#14)/ iOS Chrome/Firefox 判定 pin(#5)/ 見逃しリスク受容の明記(#3,#9)/ EXIF smoke 具体化(#15)/ PUT 直前 guard 撤回(#12)。

**OT 判断に上げる論点(spec review で確定)**:
1. **形式簡素化**: no-WebP fallback を写真/図表分類器でなく alpha 有無で決める(YAGNI)。可否。
2. **PUT 直前 guard**: 冗長ゆえ撤回(論点2)。belt-and-suspenders で残すなら失敗=UPLOAD_FAILED。可否。
3. **server defense-in-depth**: byteSize floor は「弱い min-size 検査」ゆえ Out。最小 floor を足すか否か。
4. **WebKit 判定の inclusion 範囲**: desktop Safari も自前 pipeline に含める(安全側だが lib と品質/速度が変わりうる・Codex risk#2)。範囲の可否。
5. **single-flight の UX**: 複数添付で待ち時間増(Codex risk#5)。逐次(メモリ安全)を優先で可か。

---

*次段: 本 spec を [no-review] docs commit(反映済)→ **OT 承認** → plan(writing-plans・Opus)→ 実装。*
