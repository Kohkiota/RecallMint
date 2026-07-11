# 画像系フェーズ A 追加 fact-finding — 自動圧縮 / Anki 形式受付 / デッキ一括オフライン DL (2026-07-11)

> フェーズ A(画像基盤)spec の前段・追加調査。基盤調査
> (`docs/superpowers/sessions/2026-07-11-image-attachment-r2-presigned-factfinding.md`:
> R2 未実装 / `cards.images` 受け皿 / presigned で 4.5MB bypass / `card-editor-fields.tsx` 差し込み点)
> は確定済で**再調査せず**、討議で追加された 3 論点のみ実コード + 公式 docs で裏取り。
>
> - 対象 HEAD: `develop`(基盤調査時 `c33bedc` から docs commit のみ)
> - 方法: 3 並列 read-only subagent + CC 本体 orientation。ライブラリは **node_modules の実体 2.0.2**
>   (dist source map 内 original source)を一次資料に、外部挙動は Anki 実ソース / MDN / caniuse /
>   HTML spec / webkit.org で裏取り。**数字は全て出典付き、推測ゼロ**(未確認は UNKNOWN と明記)。

---

## 0. 結論(TL;DR)

**フェーズ A の spec に進める状態。追加のコード調査は不要。** ただし spec に織り込むべき確定 fact が 3 つ:

1. **「保存は WebP」は Safari で静かに破綻する**(①② が独立に確認)。Safari(macOS/iOS 全 version)は
   canvas から WebP エンコード不可で、仕様上 **エラーにならず silent に PNG が出力される**。
   ライブラリも検知しない。→ 出力 MIME は仮定せず **`blob.type` データ駆動**で扱う設計が必須
   (Safari は PNG 保存を許容する fallback を仕様化 / または WASM encoder = 新 dep・OT 相談)。
2. **変換段の要注意形式**: SVG(固有サイズ無しはラスタ寸法明示が必須・passthrough 保存なら XSS 対策要)/
   animated gif・webp(エラーなく silent 1 フレーム化 — 仕様として明記するか検出 reject するか要決定)/
   tiff・heic(decode 不能 → reject。ただし iOS Photos 経由 HEIC は JPEG 自動変換の報告あり **非公式・実機 smoke 要**)。
   decode→再エンコード経路は自己検証的で、**magic-number 検証が要るのは passthrough 経路と presigned PUT の
   Content-Type ピン留めのみ**。
3. **一括 DL の保存領域の当たり = Cache API `card-images`**(tech-spec §9.1 設計と一致、**SW 不要**
   — window context で `caches.open` 可能 [MDN 確認済])。OPFS は URL アドレッシング無し + repo/spec 前例ゼロで不採用の当たり。
   job 状態は Dexie **version(8)** 新 store。iOS 耐久は **home-screen install が ITP 7 日消去の免除条件**
   (webkit.org 一次資料)→ InstallPrompt(spec 済・未実装)が前提要件に昇格。

---

## 1. 自動圧縮の実装可否(browser-image-compression 2.0.2)

**結論: 方針「長辺 N px + WebP + 品質 Q + alpha 保持 + EXIF 補正 + worker」はライブラリ options で直接表現可能。
ギャップは 4 点(Safari WebP / 非 Error reject / SVG・アニメ / CDN worker)。**

> 一次資料 = `node_modules/browser-image-compression/dist/browser-image-compression.mjs.map` の
> sourcesContent(実行される正確なコードの pre-minify 原文)。installed 2.0.2 確認済
> (`node_modules/browser-image-compression/package.json:3` / repo `package.json:32` `^2.0.2`)。

### 現行 repo 利用
- 唯一の実利用: `app/(app)/app/upload/_components/upload-form.tsx:245-249` —
  `{ maxSizeMB: 0.5, maxWidthOrHeight: 2048, useWebWorker: true }`(`_lib/constants.ts:12-13`)。
  `fileType` / `initialQuality` 未指定 = **出力形式は入力と同じ**(WebP 変換は現状していない)。
- エラー処理: try/catch + `err instanceof Error` guard(`upload-form.tsx:265-280`)— decode 不能入力は
  **`Error` でなく DOM `Event` が throw されうる**(`lib/utils.js:77,239`)ため、この guard の形は踏襲必須。
- 現状の受付: `<input accept="image/*,application/pdf">`(`upload-form.tsx:615`)+
  `file.type.startsWith('image/')` 分岐(`:361-381`、server 側も同判定 `process.ts:174`)= **`image/*` 全部**。
  UI 文言「JPG / PNG / HEIC 等」(`:607`)は **Chrome では HEIC decode 不能**(caniuse/heif)ゆえ Safari 17+ 限定の真。
- test では lib は no-op mock(`upload-form.test.tsx:26-32`)。

### 能力マトリクス(2.0.2 実ソース確認)
| # | 項目 | 実態 | 証跡 |
|---|---|---|---|
| 1 | 長辺 N px 縮小(アスペクト保持) | **可**。大きい辺を `maxWidthOrHeight` に合わせ他辺比例縮小 | `lib/utils.js:380-405` |
| 2 | WebP 強制出力 | **可**。`fileType: 'image/webp'`(default = `file.type`)。encode は `OffscreenCanvas.convertToBlob` / `canvas.toDataURL` | `.d.ts:18-19` / `lib/image-compression.js:73` / `lib/utils.js:256-284`。**Safari 注意 → §「ギャップ」** |
| 3 | 品質指定 | **可**。`initialQuality` 0..1(default 1.0)。`maxSizeMB` は **best-effort**(最大 10 iteration で quality×0.95・canvas×0.95/辺、超過のまま返ることあり)。単位は **MiB**(repo constants は十進 MB `constants.ts:25` — 混在注意) | `lib/image-compression.js:51,71-140` |
| 4 | alpha 保持 | **WebP 出力では保持**(白 fill は出力が `/jpe?g/` の時のみ) | `lib/utils.js:182-191,242` |
| 5 | EXIF orientation | **自動補正・二重回転ガードあり**(runtime feature-test でブラウザ自動補正を検知し自前変換を skip)。WebP 化で metadata は全 strip、回転は pixel に焼き込み = 方針に合致 | `lib/utils.js:302-323` / `lib/image-compression.js:68` |
| 6 | Web Worker | Chromium/Firefox は全 pipeline worker 内。**default `libURL` = jsDelivr CDN の importScripts**(CSP/offline で失敗すると silent に main-thread fallback)。**Safari/iOS は常に main-thread**(worker 内で `Image` 不在 → 常に fallback、issue #118 の createImageBitmap 回避と連動) | `lib/index.js:75-88` / `lib/web-worker.js:19` / `lib/utils.js:221-244` |
| 7 | 入力形式 | ブラウザが decode できるもの全て(gate は `/^image/` MIME のみ)。decode 不能 → 非 `Error` reject あり(上記) | `lib/index.js:57-61` / `lib/utils.js:221-244` |
| 8 | アニメ / SVG 入力 | 構造上 **常に静止 1 枚出力**(1 drawImage + 1 encode)。フレーム選択は HTML spec の「default image / 無ければ first frame」。SVG は `Image` 経路でラスタ化(サイズ = `img.width/height`)、**固有サイズ無し SVG の挙動 UNKNOWN**(0 寸法 canvas は失敗しうる) | `lib/utils.js:182-191` / HTML spec(§2 参照) |
| 9 | 入力サイズ上限 | canvas 面積 clamp 内蔵: iOS **4096²**(≈16.8MP。12MP iPhone 写真は通る・48MP は事前縮小)、Chrome 16384² 等。**面積のみで辺単位は未チェック**。メモリ上限の文書 guidance は無し = UNKNOWN | `lib/config/max-canvas-size.js:5-12` / `lib/utils.js:121-147` / README:136-139 |

### ギャップ(repo 側で吸収が要る 4 点)
1. **Safari は WebP エンコード不可** → 仕様上 silent に PNG が出る(§2 で独立確認・出典もそちら)。`blob.type` 検査 + MIME データ駆動が必須。
2. **decode 不能入力**(Chrome の HEIC / 破損 file)は非 `Error` reject → 既存 guard パターン踏襲 + reject メッセージ。
3. **SVG / アニメ**は `image/*` gate を素通りして silent 劣化 → `image/*` 丸受けでなく **明示 allowlist**(または SVG 特別扱い)が妥当。
4. **worker の CDN 依存** → CSP を将来締める / offline 動作が要るなら `options.libURL` で self-host。

---

## 2. Anki 対応の全画像形式の受付範囲

**結論: 「Anki が受け付ける形式」の公式マニュアル列挙は存在しない。実務上の正本 = デスクトップ版エディタ実ソースの
`pics` タプル = 現行安定版で 8 拡張子: jpg/jpeg, png, gif, svg, webp, ico, avif**(tiff は旧版のみ・削除済、bmp/heic は元々リスト外)。

- 出典: [Anki Manual Media](https://docs.ankiweb.net/media.html)(画像形式リスト無し)/
  [25.09.4 editor.py](https://raw.githubusercontent.com/ankitects/anki/25.09.4/qt/aqt/editor.py) /
  [26.05 editor.py](https://raw.githubusercontent.com/ankitects/anki/26.05/qt/aqt/editor.py) —
  `pics = ("jpg","jpeg","png","gif","svg","webp","ico","avif")`。2023-10 snapshot([80d807e](https://github.com/ankitects/anki/blob/80d807e08a6d3148f973829c48fe633a760546c5/qt/aqt/editor.py))には tif/tiff があったが現行で消滅(削除 version は UNKNOWN)。
- スコープ注意: `pics` はエディタ取り込みフィルタ。media フォルダ自体は任意 file を同期し表示は webview 依存(公式列挙 UNKNOWN)。

### 変換マトリクス(decode → canvas → WebP)
| 形式 | Anki | ブラウザ decode | WebP 変換 | 備考 |
|---|---|---|---|---|
| jpeg / png / gif(静止) | ✅ | 全ブラウザ([MDN Image types](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types)) | ✅ | — |
| webp(静止) | ✅ | 全(macOS Safari は 14+/Big Sur+) | ✅ 再圧縮 | — |
| gif / webp(アニメ) | ✅(同拡張子) | 可 | ⚠️ **silent 1 フレーム化** | [HTML spec ImageBitmap](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html)「default image / 無ければ first frame」。エラーにならない |
| svg | ✅ | 全(`<img>` ラスタ化) | ⚠️ 条件付き | 固有サイズ無しは createImageBitmap が `InvalidStateError`(resize 指定必須)。**WebP 化すれば script リスク消滅**。SVG のまま保存なら Content-Type 厳守 + untrusted 扱い(R2 公開別ドメイン配信なら cross-origin で緩和) |
| ico | ✅ | 全 | ✅ | マルチサイズ ICO の intrinsic 選択は UNKNOWN |
| avif | ✅ | Chrome 85+ / Edge 121+ / Firefox 93+ / Safari 16.1+([caniuse/avif](https://caniuse.com/avif)) | ✅(対応ブラウザ) | 旧 Edge/Safari で decode 不能 |
| tiff | ❌(旧版のみ) | **Safari のみ**(MDN) | ❌ 実質不可 | 現行 Anki リスト外 → reject で整合 |
| bmp | ❌ | 全 | ✅ | Anki リスト外。受けるかは policy |
| heic/heif | ❌ | **Safari 17+ のみ**([caniuse/heif](https://caniuse.com/heif)) | ❌(それ以外) | 下記 iPhone 特記 |

**HEIC × iOS 特記**: iOS Safari は Photos から選択時に HEIC を **JPEG 自動変換して渡す**と広く報告
(Files 経由は変換されない)。ただし **Apple 公式 doc 未発見** — 出典は
[Apple Developer Forums 743049](https://developer.apple.com/forums/thread/743049) + 実測ブログ止まり。
**信頼度: 非公式。実装前に実機 smoke 必須**。

### エンコード側(critical・§1 ギャップ 1 の出典)
| ブラウザ | canvas WebP encode | 出典 |
|---|---|---|
| Chrome 50+ / Edge 79+ / Firefox 96+ | ✅ | [caniuse toBlob webp](https://caniuse.com/mdn-api_htmlcanvaselement_toblob_type_parameter_webp) / MDN BCD |
| **Safari(macOS/iOS 全 version、27/26.5 まで)** | **❌** | 同上(BCD `version_added: false`) |

失敗モードは**エラーでなく silent fallback**: 「type 非対応なら `image/png` で出力」([MDN toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob))。
PNG エンコードのみ仕様上必須保証(Safari の JPEG encode 可否の個別 BCD 確認は未実施 = UNKNOWN)。

### 変換段の穴(合成)
| # | 穴 | 失敗表面 | 最小対応の当たり |
|---|---|---|---|
| a1 | tiff | decode 段でエラー | reject + メッセージ(現行 Anki リスト外で正当) |
| a2 | heic(Files 経由 / 非 Safari) | decode 段でエラー | reject + 「JPEG 書き出しで再アップ」案内(Photos 経由は自動 JPEG 化に期待 — 非公式・要実機) |
| a3 | avif on 旧ブラウザ | decode 段でエラー | reject + メッセージ(現行ブラウザでは実質解消済) |
| b1 | アニメ gif/webp | **エラー無し**・silent 1 枚化 | policy 明記(「平坦化を仕様とする」)or 構造パースで検出 reject |
| b2 | svg | サイズ未指定で `InvalidStateError` / ラスタ寸法が裁量 | ラスタ寸法明示 + WebP 化(script リスク消滅)。passthrough 採用時のみ XSS 対策必須 |
| c1 | **Safari WebP encode 不能** | **エラー無し**・PNG が silent 出力 | `blob.type` 検査 → Safari は PNG 保存許容を仕様化 / server transcode / WASM encoder(新 dep = OT 相談) |

### magic-number 検証の要否
- `File.type` は内容を読まず拡張子由来で spoof 可能([MDN File.type](https://developer.mozilla.org/en-US/docs/Web/API/File/type)「sole validation に使うな」)。
- **ただし decode→再エンコード経路は自己検証的**(中身が画像でなければ decode で落ち、成功すれば出力は自前生成の clean な WebP/PNG)。
- → magic-byte sniff が実質必要なのは **(1) passthrough 経路(SVG 等を無変換保存する場合)(2) presigned PUT の Content-Type ピン留め(server 側)(3) b1 のアニメ検出を採る場合** のみ。
- 現状 repo に magic-byte 検証は無し(grep 0)。既存検証は MIME 文字列のみ(`upload-form.tsx:361-381,615` / `process.ts:167,174` / Gemini へ `f.type` そのまま転送 `process.ts:285`)。

---

## 3. デッキ一括オフライン DL の土台

**結論: 現状 = manifest-only PWA(SW/Cache API/OPFS/persist いずれもコード 0)。blob 置き場の当たりは
tech-spec 整合の Cache API `card-images`(SW 不要で download+表示まで可能)。media チャネルは
entity_mutations に載せず新規並列チャネル(Dexie v8 新 store + 既存 guarded loop パターン踏襲)。
iOS 耐久は home-screen install が前提要件。**

### 現況
| 項目 | 実態 | 証跡 |
|---|---|---|
| manifest | 存在。`id:/app`, `start_url:/app`, `display:standalone`, icons 192/512/maskable | `public/manifest.json:2-14` / `app/layout.tsx:26-29`(**「SW / offline cache / push は Phase 2 検討」と明記**) |
| Service Worker | **無し**(`serviceWorker`/`workbox`/`serwist`/`next-pwa` grep 0、`public/` に sw.js 無し) | grep 確認 |
| Cache API / OPFS / `navigator.storage` | **無し**(grep 0) | grep 確認 |
| `components/pwa/InstallPrompt.tsx`(spec §9.1) | **無し** | ls 確認 |
| tech-spec §9.1 の設計 | 画像(R2 origin)= `CacheFirst` cache 名 `card-images`・1500 entries/~250MB/90 日(L1333)。「Cache Storage は画像と静的アセット専用、Dexie は差分同期」(L1338-1341, §14.2 L1545-1548)。iOS 対策 = InstallPrompt + home-screen で 7 日 eviction 回避(L1343-1349) | `docs/02-tech-spec.md` |
| **spec checkbox の齟齬(flag)** | L1355-1364 の `[x] Service Worker 登録` `[x] 画像 CacheFirst` 等は **scope 宣言であって実装済ではない**(コード不在 + layout.tsx が Phase 2 と明記)。doc は実装済に読めるが未実装 | 同上 |

### sync 構造への差し込み
- **Dexie 現況**(DB `'recallmint'`、最新 version(7)、`lib/client-db.ts`): 11 store
  (exams/cards/user_settings/study_sessions/answer_events/entity_mutations/sync_meta/study_days/tag_categories/tag_options/card_tags)。
  version 履歴は「純粋 store 追加(v2/v4/v5)/ 純粋 index 追加(v6/v7)」の additive パターン → **media/job store 追加 = version(8)** で前例通り。
- **media チャネルは entity_mutations に載せない**: entity_mutations は zod discriminated union の
  JSON 行変異 envelope(`lib/sync/shared/mutation-schemas.ts:183-189`、client→server・field 単位 coalesce・
  server apply registry・mutation_id 冪等)。デッキ画像 DL は全次元で逆(server(R2)→client・binary blob・
  content-addressed(`images[].key`)・per-deck batch 進捗)→ **専用 Dexie job store + 専用 guarded fetch loop**。
  guarded loop の既存パターンは 3 例あり踏襲可(`with-web-lock.ts` + in-flight: `entity-mutation-flush.ts:31,41-60` / review-flush / `runGuardedPull` `pull.ts:307-351`)。
- **デッキ→assetId 群は server 往復なしで導出可能**:
  `db.cards.where('exam_id').equals(examId).toArray()`(実例 `inline-card-list.tsx:95` / `exam-card-table.tsx:316`、
  compound `[user_id+exam_id]` index も v6 で存在 `client-db.ts:294-297`)→ `union(cards.images[].key)`。
  `images` は mirror に既載(`ClientCard.images` `client-db.ts:82` — 基盤調査で確認済)。
- **job 状態の置き場**: 既存に per-exam client 状態 store は無し(全 store 列挙で確認)→
  **新 store(例 `media_download_jobs`、key = exam_id or `[user_id+exam_id]`、status pending/downloading/done、
  all-or-nothing = 全 key cache 完了後にのみ done)** が前例整合。
- **blob 置き場 3 候補の判定**:
  - **Cache API(当たり)**: tech-spec §9.1/§14.2 と一致・URL アドレッシング・ブラウザ LRU。
    **SW 不要** — window context から `caches.open` 可([MDN Cache](https://developer.mozilla.org/en-US/docs/Web/API/Cache)「windowed scopes にも公開」)。
  - OPFS: URL 無し・手動 FileHandle→objectURL 配線・repo/spec 前例ゼロ → 不採用の当たり。
  - Dexie blob: 動くが spec が「Dexie は差分同期専用」と明示 → contra-spec。
  - **重要 nuance**: SW fetch handler が無い限り `<img src="https://r2...">` は Cache Storage を見ない。
    offline 表示は (a) SW fetch handler(Phase 2)か **(b) app コードで `caches.match()` → `URL.createObjectURL`**
    のどちらか。(b) で download+学習 view 表示まで SW-less で成立。**offline ナビゲーション(app shell)は
    いずれ SW 必須** — 別判断として明示 defer。

### 外部 fact(全て出典付き)
- `navigator.storage.persist()`: Chrome 55+ / Firefox 57+ / **Safari 15.2+**([caniuse](https://caniuse.com/mdn-api_storagemanager_persist))。
  `estimate()`: Safari は **17.0+**([caniuse](https://caniuse.com/mdn-api_storagemanager_estimate))— iOS 15.2〜16.x は persist のみの空白帯。
  付与: Chrome = プロンプト無し heuristic(engagement/installed/notification — [web.dev](https://web.dev/articles/persistent-storage))、
  Firefox = ユーザープロンプト、WebKit = silent heuristic(「home-screen web app かどうか等」— [webkit.org/blog/14403](https://webkit.org/blog/14403/updates-to-storage-policy/))。
  persist=true でも WebKit は「eviction から除外**されうる**(might)」で硬い保証ではない(同 URL)。
- **ITP 7 日 cap**([webkit.org/blog/10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/), 2020):
  「site への interaction 無しに **Safari 使用 7 日**」で IndexedDB / LocalStorage / **Cache API** / SW 登録等の
  script-writable storage を全削除(暦日でなく Safari 使用日)。
  **home-screen web app の first-party domain は免除**([webkit.org/tracking-prevention](https://webkit.org/tracking-prevention)
  「ITP always skips that domain in its website data removal algorithm」— 現行有効)。
- **iOS 17+ quota**([webkit.org/blog/14403](https://webkit.org/blog/14403/updates-to-storage-policy/)):
  Safari / home-screen web app = **origin あたり disk の最大 60%**(全体 80%)、WKWebView app = 15%。
  プロンプト無し。eviction は origin 丸ごと・LRU。iOS17 以前の数値は UNKNOWN(公式に旧数値の記載なし)。
- **iOS 含意 1 行**: home-screen 未 install だと DL 済デッキ(job 状態 + blob とも)は 7 日で origin ごと消えうる。
  install で免除 → **InstallPrompt(spec §9.1・未実装)+ `persist()` は一括 DL の耐久前提**。

---

## 4. spec 前に潰す決定点(設計判断)

1. **Safari WebP fallback 方針**: 出力 MIME データ駆動で「Safari は PNG 許容」とする(最小)か、
   WASM encoder で WebP 統一(新 dep = OT 事前相談・重い)か、server transcode か。
2. **受付形式リスト**: Anki 現行 8 拡張子(jpg/jpeg/png/gif/svg/webp/ico/avif)を正とするか、
   bmp(ブラウザ decode 可・Anki 外)/ HEIC(iOS 実機挙動の smoke 待ち)をどう扱うか。
3. **アニメ policy**: silent 1 枚化を仕様と明記 vs 構造パースで検出 reject(パーサ実装が要る)。
4. **SVG 扱い**: ラスタ寸法明示 + WebP 化(script リスク消滅・最小)vs passthrough 保存(XSS 対策 + magic-byte 検証が発生)。
5. **worker `libURL`**: 既定 jsDelivr CDN のままか self-host か(CSP 強化・offline 要件と連動)。
6. **一括 DL の scope 切り**: Cache API + Dexie v8 job store + guarded fetch loop は当たり確定。
   **SW(offline ナビゲーション)と InstallPrompt/`persist()` をフェーズ A に含めるか明示 defer するか**
   (iOS 耐久は install が前提 — defer するなら「オンライン表示のみ」等の到達点を明記)。
7. **実機検証の予約**: iOS Photos の HEIC→JPEG 自動変換(非公式情報)は spec 確定前でなく実装時 smoke で可
   (受付リストの文言にのみ影響)。

---

## 5. 判定

- **フェーズ A spec に進める。追加のコード調査は不要。** 3 論点とも「実装可否」は確定
  (①可・②マトリクス確定・③土台と差し込み点確定)。残るのは §4 の設計判断のみで、
  いずれも fact は出揃っている(唯一の非公式 fact = iOS HEIC 自動変換は実装時 smoke で潰せる)。
- **要注意形式(明示)**: SVG / animated gif・webp / tiff・heic — §2「変換段の穴」の表が spec の入力。
- **保存領域の当たり(明示)**: **Cache API `card-images`**(SW 不要・tech-spec 整合)、OPFS 不採用、
  job = Dexie version(8) 新 store、iOS 耐久 = home-screen install + persist() が前提要件。

---

## 参照
- 基盤調査(前段): `docs/superpowers/sessions/2026-07-11-image-attachment-r2-presigned-factfinding.md`
- 設計正本: `docs/02-tech-spec.md` §9.1(L1314-1371 PWA/cache)/ §14.2(L1545-1548 storage 分担)
- 実コード主要: `node_modules/browser-image-compression/`(2.0.2 実体)、
  `app/(app)/app/upload/_components/upload-form.tsx`(`:245-249,265-280,361-381,607,615`)、
  `app/(app)/app/upload/_lib/constants.ts`(`:12-13,25`)、`app/(app)/app/upload/_actions/process.ts`(`:167,174,285`)、
  `lib/client-db.ts`(store 定義 `:243-310`)、`lib/sync/`(`entity-mutation-flush.ts:31,41-60` /
  `entity-mutations.ts:47-109,201-287` / `pull.ts:116-351` / `shared/mutation-schemas.ts:183-189` / `with-web-lock.ts`)、
  `public/manifest.json` / `app/layout.tsx:26-29`
- 外部一次資料: Anki 実ソース(25.09.4 / 26.05 editor.py `pics`)、MDN(Image types / toBlob / File.type / Cache / StorageManager)、
  caniuse(avif / heif / toBlob-webp / persist / estimate)、HTML spec(ImageBitmap / canvas)、
  webkit.org(blog/10218 ITP 7-day / blog/14403 storage policy / tracking-prevention)、web.dev(persistent-storage)
