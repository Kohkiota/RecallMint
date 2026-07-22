# 画像表示 UX 改修 — Step 0 fact-finding(2026-07-22)

改修方向(未確定・この調査で裏取り): 全画面タップ拡大モーダル(ピンチズーム)/ 演習画面 in-flow 画像の拡大 / 縦長画像の clip+フェード+ボタン / モーダルで viewport fit or 横幅 fit+縦スクロール。

本 doc は **現状コード事実のみ**。プラン・コードは含まない。5 並列 general-purpose subagent + メモ判定 1 件のソース直読 / grep 実測に基づく(行番号は subagent 報告値、Step 0 精度)。

---

## 1. 画像表示コンポーネントの現状

**カード画像を実際に `<img>` で描画しているのは単一コンポーネント**:
`app/(app)/app/exams/[id]/_components/card-image-gallery.tsx` の `CardImageThumbnail`(唯一の `<img>`, L139-145)。`next/image` 不使用 = プレーン `<img>` + blob objectURL(src は Cache/R2 の objectURL、署名 URL を DB/Dexie/`<img src>` に置かない恒久防衛 L9)。

**サイズは全画面共通で 1 箇所ハードコード**: サムネ `h-16 w-16`(64×64px 固定)+ `object-cover` + `rounded-md border`(L144)。loading/失敗プレースホルダも `h-16 w-16`(L108,116)。`<img>` の width/height 属性は media_assets から best-effort で読む実寸(layout-shift 回避のみ、表示寸は CSS 64px が支配)。`compact`/`slot`(`'full'|'add'|'thumbnails'`)/`readOnly` props は「追加ボタン/サムネの表示可否」だけを制御し**サイズは変えない**。**max-h/max-w・ズーム・ライトボックスは全画面ゼロ**(grep 確認)。

画面別(すべて同一 `CardImageGallery` 共用、差は渡す props のみ):
- **① 編集画面**: `inline-card-list.tsx` → `card-editor-fields.tsx`(`CardEditorFields`)→ gallery。問題文/解説/メモ各フィールドで add(`slot="add" compact`)+ thumbnails。選択肢は `inline-option-row.tsx` 経由(`target=option:<uid>`)。
- **② 演習画面(スマート/カスタム共通)**: 両モードとも `SessionLauncher`(`app/(app)/app/study/_components/session-launcher.tsx`)→ `SessionRunner`(`app/(app)/app/study/smart/_components/session-runner.tsx`)に合流、描画は完全共通。画像 slot は**集約でなく分散**: 問題文(L445)/各選択肢(L509, options.map 内)/解説(L551)。すべて `readOnly`。
- **③ プレビュー**: `custom-session-preview.tsx` は問題文テキストのみ(L107 `line-clamp-2`)、**カード画像を描画しない**。OCR 結果プレビュー(`upload/result/.../page.tsx`)もカード画像なし。**カード画像専用プレビュー画面は該当なし**。
- **④ サイドピーク**: `exam-card-side-peek.tsx`(radix Dialog `modal={false}`、480px 右パネル)→ `CardEditorFields`。**① と同一共有実装**。
- **⑤ カードビュー(テーブル)**: `exam-card-table-columns.tsx`(問題文/解説/メモ列, `compact`)+ 選択肢は `exam-card-table-options-edit-cell.tsx`(`CompactOptionsCell`)。`compact` でもサムネは 64px のまま。

**Sprint I「画像4欄」= question_text / explanation_text / memo / option:<uid>**。演習画面では「フィールド別 slot に分散配置」(4枚同時でも1枚ずつでもない)。同一 target 内複数枚は `flex flex-wrap gap-2`(L227)で 64px サムネが折り返し。カード最大 10 枚(`TOO_MANY_IMAGES`)。
**欠落: メモ欄(`target="memo"`)画像は演習画面で描画されない**(メモ島 L566-574 は `MdTableBlock` で本文テキストのみ、gallery なし。加えてメモ本文 falsy でメモ島ごと非表示)。→ この spec/bug 判定は §7。

---

## 2. 拡大モーダル / ギャラリー資産

- **画像専用の拡大モーダル / lightbox / gallery-overlay は存在しない(該当なし)**。`CardImageGallery` は名前に反し**実体は inline サムネ列**(モーダルではない)。
- **ピンチズーム未実装**。gesture/zoom/lightbox 系ライブラリ(`react-zoom-pan-pinch` / `use-gesture` / `hammer` / `panzoom` / `photoswipe` / `yet-another-react-lightbox` / `framer-motion` 等)は **package.json に一切なし**。UI 依存は `radix-ui: ^1.4.3` のみ。touch/gesture ハンドラなし。
- **画像タップハンドラは全画面で存在しない**。`card-image-gallery.tsx` L139 の `<img>` に `onClick`/`onTap`/`onPointerDown` なし → **どの画面でも画像タップは無反応**(拡大しない/遷移しない/選択しない)。gallery 内 onClick は別物: 再読込ボタン(L120)/削除×(L149, 編集面のみ)/画像追加(L246,255)。
- **既存の唯一のモーダルオーバーレイ汎用部品** = `components/ui/confirm-dialog.tsx`(`createPortal(document.body)` + `fixed inset-0 z-50 bg-black/40` + `role="dialog"` + `aria-modal`、Esc/backdrop close、focus 退避復帰手動)。**用途は削除確認等のみ、画像用途では未使用**。side-peek は radix Dialog(`modal={false}`)の右スライドで lightbox ではない。
- CardImageGallery 呼び出し元(実消費点): `card-editor-fields.tsx` / `inline-option-row.tsx` / `exam-card-table-columns.tsx` / `exam-card-table-options-edit-cell.tsx` / `session-runner.tsx`(readOnly ×3)。**dead な呼び出し元なし**。

---

## 3. asset metadata(スキーマ)

**サーバ(Drizzle, `lib/db/schema.ts`, migration `drizzle/migrations/0023_windy_ultimates.sql`)**:
- `assets`(L821-847): `id, user_id, object_key(UNIQUE), mime, byte_size, ` **`width int NOT NULL`, `height int NOT NULL`**`, hash, status(reserved|ready), created_at, ready_at, reference_count(dormant), unreferenced_at(dormant)`。→ **width/height あり**。
- `card_asset_refs`(L860-879, GC 権威): `card_id, asset_id, user_id, field_key, ordinal`。**width/height なし**。
- `cards.images` jsonb(L321-324, 型 `CardImage` L58-64): `{ key, target, alt, source_ref?, url? }`。**width/height なし、`alt` あり**(表示/wire 用の二重持ち)。

**クライアント(Dexie, `lib/client-db.ts`, DB `recallmint` v8)**:
- `media_assets` store(型 `ClientMediaAsset` L76-86, stores L356-359): `id, user_id, status(uploading|ready|failed), mime, byte_size, ` **`width`, `height`**`, hash, created_at`(w/h は非 index・保存のみ)。→ **width/height あり**。
- `ClientCardImage`(L64-70): `key, target, alt, source_ref?, url?`。w/h なし、`alt` あり。

**alt/caption/decorative**: **alt = あり**(両側、cards.images jsonb 内)。**caption = なし**。**decorative flag = なし**(両側 grep ゼロ・migration にも列なし)。

**width/height 取得経路**(既に測定・保存済): `lib/media/upload.ts` — 標準 `createImageBitmap` の `bitmap.width/height`(L360付近)、WebKit/iOS fallback は `lib/media/image-validation.ts` の `HTMLImageElement.decode()` → `naturalWidth/Height`(L261-276)。確定寸法を client `media_assets`(L709)と server `assets` の両方へ書込。

**UX 上重要な帰結(コード上の帰結・推測でない)**: 表示時 layout-shift dims は **client `media_assets` mirror からのみ**取得(`card-image-gallery.tsx:90-103`)。`media_assets` 行は **upload した端末にしか作られない**(deck-download は media_assets を書かない、§5)。server `resolveAssetUrls` は w/h を返す(`asset-actions.ts:264-272`)が表示経路 `getAssetObjectURL` はそれを破棄し objectURL 文字列のみ返す(`get-asset.ts:64-84`)。→ **DL のみの端末では表示時に w/h が得られず `<img>` に width/height 属性が付かない**。

---

## 4. R2 / next/image 経路

- **variant = 単一のみ**。1 asset = R2 に 1 object。object key `users/${userId}/${assetId}.${webp|jpg|png}`(`asset-actions.ts:97-99`)、**variant suffix(_thumb 等)なし**。添付圧縮は 1 blob だけ生成(WebKit `compress-image-safe.ts` `MAX_EDGE=2048`/`MAX_PIXELS=4M`/q0.85、Blink/FF `upload.ts` `maxWidthOrHeight:1600`/webp/q0.8、**fallback = 圧縮失敗 jpg/png ≤5MiB を無変換 direct PUT = この時だけ真の原寸**)。`attachImageToCard` が 1 回だけ PUT(`upload.ts:729`)。複数サイズ書き出しはリポジトリに存在しない。
- **next/image を一切使用していない**。`next.config.ts` に **`images` ブロック自体が無い**(remotePatterns/domains/quality/formats/deviceSizes/imageSizes/unoptimized 全て未設定=Next default)。全画像がプレーン `<img>` + blob objectURL。`upload-form.tsx:664` に「next/image 化(波1)」の未着手 TODO あり。
- `CardImageThumbnail` の `<img>`(L134-145): `src=blob objectURL`, `width/height=intrinsic best-effort`, `className="h-16 w-16 object-cover"`。**`sizes`/`quality`/`fill` なし**。
- **presigned URL = 使用**。SDK は `@aws-sdk/s3-request-presigner` でなく **`aws4fetch`**(`AwsClient.sign(..., {aws:{signQuery:true}})`, `lib/storage/r2.ts:8,101-105`)。`presignGetUrl`(L95-106)/`presignPutUrl`(L76-90)。**有効期限 `DEFAULT_EXPIRES_SEC = 600`秒(10分)**(GET/PUT 共通, `r2.ts:35`)。バケット非公開(`R2_PUBLIC_URL` 意図的未使用)。`resolveAssetUrls`(`asset-actions.ts:217-275`)は ready かつ owner の asset のみ presign、他は黙って省略。
- **モーダル高解像度**: 高解像度用の別 variant は無い → 使えるのは R2 の唯一の object のみ。それも添付時に ≤1600/≤2048px へ縮小済(真の原寸は fallback 経路のみ R2 に残る)。64px サムネより大きく出す余地はその 1 枚ぶんだけ。

---

## 5. オフライン画像取得(local-first)

- **Cache API 使用(Service Worker なし)**: `lib/media/cache.ts` が `caches.open('recallmint-media')` に `cache.put(/__media/{userId}/{assetId}, Response(blob))`。**Dexie に blob は持たない**(`media_assets` は状態のみ、blob 本体は Cache API のみ)。SW 全 grep ゼロ。
- **解決順**(`lib/media/get-asset.ts` `getAssetObjectURL`): ① プロセス内 `objectUrlCache` Map hit → 再利用 ② Cache API hit → blob から `createObjectURL` ③ miss → `resolveAssetUrls`(server action)で R2 presigned GET → `fetch`(cors/omit/redirect:error/30s timeout)→ **Cache API に put** → objectURL ④ 全失敗 → **null**(呼出側が placeholder)。**ローカル blob 優先 → 無ければ presigned fetch → Cache 充填**。
- **オフライン可否 = 条件付き**: Cache API に blob がある asset(自端末 upload、または deck 一括 DL `lib/media/deck-download.ts` `downloadDeckImages`)→ **オフライン可**。Cache miss → presigned fetch 必要 → **オフライン不可 → placeholder「画像を取得できません」+ 再読込ボタン**(`card-image-gallery.tsx:114-132`)。deck-download は差分 DL(Cache miss のみ)。
- **AssetResolver 相当は存在する**: 単票表示は `getAssetObjectURL` が local↔remote を抽象化する単一解決レイヤー。ただし単票(get-asset)と一括(deck-download)で 2 実装に分岐(共通化は下位プリミティブ = `cache.ts` 3 関数 + `resolveAssetUrls` のレベル)。表示側の実消費点は現状 `CardImageGallery` 1 箇所のみ。
- **補足**: deck-download は Cache API と `media_download_jobs` にのみ書き `media_assets` mirror を書かない → DL 端末は blob 表示可だが w/h mirror なし(§3 と同根)。

---

## 6. iOS WebKit 現状

- **viewport meta**(`app/layout.tsx:66-70` `export const viewport`): `width:'device-width', initialScale:1`。**`user-scalable` 指定なし(既定 yes = ピンチ禁止していない)/ `maximum-scale` なし / `viewport-fit=cover` なし**(→ `safe-area-inset` env() が inert、`inline-card-list.tsx:497-498` に意図的と明記)。他 layout(auth/marketing/app)に viewport export なし = root が SSoT。
- **全画面高さ指定**: `100vh/svh/lvh` 不使用。`100dvh` は 1 箇所のみ(`exam-detail-view.tsx:247` `calc(100dvh - ${shellTop}px)` = テーブルビュー app-shell 骨格、モーダルではない。test で pin 済)。既存 overlay は inset ベース(confirm-dialog `fixed inset-0`、side-peek `fixed inset-y-0 right-0`)。
- **scroll lock = 現状どこにも未実装**。ライブラリ(`react-remove-scroll`/`body-scroll-lock`/`vaul`)なし。confirm-dialog は body の overflow/position を触らない。side-peek は radix Dialog `modal={false}` = scroll lock も focus trap も適用されない。**Drawer/Sheet/vaul コンポーネント不在**。
- **iOS 既知問題の記録 = 画像圧縮まわりに集中**(spec/plan/session `2026-07-12〜13-ios-webkit-compression-*`、Codex `2026-07-13-ios-webkit-t1..6`): WebKit OOM(フル解像度中間 canvas)→ WebKit-safe pipeline、`createImageBitmap` 不安定 → `HTMLImageElement`+objectURL decode、≈856B 破損、`toBlob` null fallback、HEIC 変換(OT 実機確認項)、PWA standalone は `navigator.standalone` 判定、Web Locks iOS 16.4+。**100vh バグ/touch-action/overlay の iOS 既知問題の記録はなし**(ズーム/overlay 自体が未実装ゆえ顕在化箇所がない)。
- **`touch-action` CSS = 該当なし**(app/components/lib/globals.css で 0 件)。ピンチ実装前提の touch-action 指定は存在しない。

---

## 7. メモ画像 spec-vs-bug 判定

**判定 = 意図的な仕様(実装漏れではない)**。学習面(W4)の表示対象は question/option/explanation の 3 面に限定、memo は「学習非表示ゆえ対象外/除外」と 4 文書が一致明記:
- spec(凍結)`docs/superpowers/specs/2026-07-15-sprint-i-image-four-fields-design.md` §4.3(L63)「memo は学習非表示ゆえ対象外」/ §9(L121)「memo 除外は正(学習非表示)」/ §1 In(L13)「学習面 read-only 表示(question/option/explanation)」。
- plan `docs/superpowers/plans/2026-07-15-sprint-i-image-four-fields.md` W4(L100)「memo は学習非表示ゆえ除外」。
- 完了 session `docs/superpowers/sessions/2026-07-16-sprint-i-image-four-fields-completion.md` W4(L34)「memo は学習非表示ゆえ除外」。
- Codex plan review `docs/codex/2026-07-15-plan-sprint-i-image-four-fields.md`(L37-39)「memo は学習非表示でよい」。

**注意(推測・要 OT 確認)**: docs の除外根拠「memo は学習非表示」という**前提記述**と、コード事実「メモ本文**テキスト**は演習画面に描画されている(空のときのみメモ島ごと非表示)」との間に齟齬の可能性。これは docs 前提記述の不正確という別論点で、session-runner に memo gallery が無いこと自体は依然 spec どおりの意図実装(判定は変わらない)。

---

## 改修方向への含意(事実ベース・プランではない)

事実として言える範囲のみ:
- モーダル資産はゼロから。既存の再利用可能資産は `confirm-dialog.tsx` の portal+`fixed inset-0` パターンのみ(画像用に流用可能かは設計判断)。ピンチ/scroll lock/touch-action/dvh-overlay/next-image いずれも現状未実装。
- 表示コンポーネントが `CardImageGallery` 1 本に集約されている = 改修の入口は 1 箇所(タップハンドラ/モーダル起動を足す先が単一)。
- モーダルで出せる解像度の上限 = R2 の単一 stored object(≤1600/2048px 縮小済、真の原寸は fallback 経路のみ)。原寸ソースを別途持っていない。
- 縦長画像の実寸判定に必要な width/height は server assets / client media_assets にあるが、**DL のみ端末では client mirror に無い**(表示経路が server 返り値を破棄)= clip 判定を実寸で行う場合の既存の穴。
- viewport は `user-scalable` 未設定でブラウザ標準ピンチが既に効く状態(モーダル内 pinch を JS 実装するか OS 標準に委ねるかで前提が変わる論点が存在)。
