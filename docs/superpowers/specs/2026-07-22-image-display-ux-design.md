# 画像表示 UX 改修 設計 spec

- **日付**: 2026-07-22
- **調査/起草 HEAD**: `develop` `33ffd2f`
- **fact-finding**: `docs/superpowers/sessions/2026-07-22-image-ux-factfinding.md`(6 項目 + メモ判定。5 並列 subagent のソース直読 / grep 実測。本 spec の file:line は同 HEAD で参照)
- **前提**: 表示入口はカード画像唯一の `<img>` = `app/(app)/app/exams/[id]/_components/card-image-gallery.tsx` の `CardImageThumbnail`、URL 解決は `lib/media/get-asset.ts` の `getAssetObjectURL` に集約済(fact-finding §1/§5)。本改修はこの 2 本 + 新規モーダルユニットへ載せる。**表示系のみ・sync/DB スキーマ変更ゼロ**。
- **依存新規**: PhotoSwipe 5.4.4(MIT・依存ゼロ・ESM)。現 package.json に gesture/lightbox 系ライブラリはゼロ(依存は `radix-ui` のみ・fact-finding §2)。

## 1. スコープ

現状: カード画像は全画面で `h-16 w-16`(64×64px)固定サムネのみ・拡大手段ゼロ・タップ無反応・モーダル/ピンチ/scroll-lock/touch-action/next-image いずれも未実装(fact-finding §1/§2/§6)。

**In**:
1. **演習画面(スマート復習・カスタム演習)の in-flow 画像を「大きめ表示」へ**。演習の画像 slot 全て(問題文 / 各選択肢 / 解説)に効かせる(`session-runner.tsx` L445/L509/L551)。
2. **縦長画像の畳み処理**(幅100%維持 + 高さ clip + 下端フェード + 明示ボタン + タップでモーダル)。
3. **全画面拡大モーダル**(PhotoSwipe)。編集 / 演習 / サイドピーク / カードビューの全表示箇所で共通。通常画像=viewport fit + ピンチ + ダブルタップ、長尺=横幅 fit + 縦スクロール + ピンチ。ピンチ以外の +/−/リセット も用意(WCAG 2.5.1)。
4. **iOS WebKit 対応**(viewport 不変[user-scalable]・touch-action 領域分離・**fixed-body** scroll-lock。**S1 `viewport-fit=cover` は revert 2026-07-24** = app 全体 safe-area 未対応ゆえ cover が app-wide regression。edge-to-edge は将来 app-shell safe-area sprint)。
5. **単一 object 前提**(R2 は 1 asset=1 object・≤1600/2048px 縮小済。variant 追加はしない)。

**Out(非スコープ・§9 台帳)**: deck-download が実寸 dims を書かない既存の穴の根治 / alt テキスト a11y / インライン二段階展開 / 編集の長尺警告・画像分割 / 4 欄ギャラリー切替 UX 高度化 / メモ本文表示と Sprint I docs 前提記述の齟齬(OT 確認事項)/ next/image 導入(生 `<img>`+blob objectURL 経路を踏襲)。

## 2. HEAD 事実(改修の前提・`33ffd2f` 実コード裏取り)

| 論点 | HEAD 事実(file:line)| 改修への含意 |
|---|---|---|
| 表示入口 | カード画像の `<img>` は `CardImageThumbnail`(`card-image-gallery.tsx:139-145`)1 箇所。全画面が `CardImageGallery` を props 差で共用(fact-finding §1)| タップ→モーダル・大きめ表示・畳みの追加点は**単一** |
| サイズ | `h-16 w-16 object-cover`(`:144`)ハードコード。`slot`/`compact`/`readOnly` はサイズを変えない(`:38-46`)| 「大きめ」は新 prop で分岐。既存 64px 面は不変 |
| 演習 slot | 問題文 `target="question_text"`(`session-runner.tsx:445`)/ 各選択肢 `option:<uid>`(`:509`・`options.map` 内)/ 解説 `explanation_text`(`:551`)。全て `readOnly`。メモ画像は非描画(Sprint I 意図・fact-finding §7)| in-flow 大きめは 3 slot に効かせる。メモは対象外(据え置き)|
| 画像上限 | `MAX_IMAGES_PER_CARD = 10`(`upload.ts:66`)= **カード合計 cap**。`currentImages.length >= 10` で検査(`:569`)。**per-target 制限は存在しない**。gallery は `i.target === target` で filter し flex-wrap 描画(`card-image-gallery.tsx:184,227`)| 同一 target に最大 10 枚入りうるが強制分散なし。per-target 複数は §4 で扱う |
| URL 解決 | `getAssetObjectURL(userId, assetId, {resolveAssetUrls})`(`get-asset.ts`)= Map→Cache API→presigned GET fetch→Cache 充填→null。presigned は `aws4fetch`・期限 600s(`r2.ts:35`)。blob は Cache API `recallmint-media`(`cache.ts`)| モーダルの `src` も同経路の blob objectURL を再利用(署名 URL を `<img src>` に置かない恒久防衛 `card-image-gallery.tsx:9`)|
| dims | 実寸は `assets`(NOT NULL)/ client `media_assets`(`client-db.ts`)に保持。表示側は client mirror からのみ best-effort 取得(`card-image-gallery.tsx:90-103`)。**DL のみ端末は mirror 無 → dims 取得不可**(fact-finding §3)| dims は mirror→`<img>.naturalWidth` の 2 段(§6)|
| next/image | 未使用・`next.config.ts` に images ブロック無し(fact-finding §4)| 生 `<img>` 踏襲。PhotoSwipe も dataSource で生 `src` |
| 既存モーダル資産 | `components/ui/confirm-dialog.tsx`(portal+`fixed inset-0`)= 確認用のみ。scroll-lock 無し・side-peek は radix `modal={false}`(fact-finding §2/§6)| 画像モーダルは PhotoSwipe を新設(自前 gesture を作らない)|

## 3. 設計

### 3.1 ユニット分割(境界)

3 ユニット。各々「何をするか / どう使うか / 何に依存するか」が独立に言える形にする。

1. **`useImageZoom`(client hook・新規)** — PhotoSwipe を知る唯一のユニット。
   - 公開 API = `open(images, startIndex)`。`images` = 解決済み `{ src, width, height, alt }[]`(呼出側が objectURL / dims を用意)。
   - 責務 = PhotoSwipe **core** の dynamic import(`await import('photoswipe')` → `new PhotoSwipe(...)`。Lightbox module は DOM gallery 用ゆえ使わない)/ `dataSource`+`index` 適用 / config(§3.4)/ `uiRegister` event で `ui.registerElement`(+/−/リセット追加)/ lifecycle(open で生成・close で `destroy`)。CSS `photoswipe/style.css` はこの module で import。
   - gallery からは `open()` しか見えない(PhotoSwipe の型・config は内部にカプセル化)。
   - 配置は client component 群(`components/media/` 想定)。実配置は plan で確定(ESLint Block A に抵触しない = npm import のみ)。

2. **`computeFold(...)`(pure 関数・新規)** — 畳み判定の唯一の定義。I/O なし・test 厚く。
   - 署名 = `computeFold({ naturalWidth, naturalHeight, renderedWidthPx, capPx, absMarginPx, ratio }) → { fold: boolean, cappedHeightPx: number }`。
   - `renderedHeightPx = renderedWidthPx * naturalHeight / naturalWidth`(幅100%描画時の予測高)。
   - **閾値は二項(§修正1)**: `fold = renderedHeightPx > capPx + absMarginPx || renderedHeightPx > capPx * ratio`。絶対 px 下駄(小 viewport で過敏化を防ぐ)と比率(大 viewport で相対的過大を拾う)の OR。
   - `cappedHeightPx = min(renderedHeightPx, capPx)`(clip 用)。

3. **`CardImageGallery`/`CardImageThumbnail`(既存・拡張)** —
   - 新 prop `display?: 'thumb' | 'inflow'`(既定 `'thumb'` = 現行 64px 維持。演習のみ `'inflow'` を渡す)。
   - **画像本体 tap** → `useImageZoom.open(その target の解決済み画像集合, index)`。tap 有効化は objectURL 解決済み(`url` が string)時のみ。
   - `display='inflow'` かつ **単一画像** target の時のみ畳みラッパー(§3.3)を巻く。
   - 編集面の × 削除ボタン(`:146-155`)は別 hit target で不変(画像本体 tap=モーダル / ×=削除の 2 経路併存)。

### 3.2 演習 in-flow 表示モデル(§修正なし・4 反映)

target 内枚数での**単一の二分岐のみ**(枚数別の細分岐は作らない = YAGNI):

- **単一画像 target** = 幅100%1カラム(`width:100%; height:auto`・object-fit で縮めない)+ 縦長時に畳み処理(§3.3)。
- **複数画像 target** = 中サイズタイルの flex-wrap(開始値 128px・`object-cover`・64px より大きく but 有界)+ **畳みなし** + 各タイル tap → モーダル(§3.4 の target 内 swipe)。合計高の青天井を構造で防ぐ。

**per-target 頻度の扱い(§4 掘り下げ)**: コード事実 = per-card cap 10・**per-target 制限なし**(§2 表)。ただし実分布は下記の推定に留まり、確証には prod query が要る(SQL は OT 領域)。

- **設計意図からの推定(推測・prod 未計測)**: 画像は OCR 資料 + ユーザー添付由来。問題文=図 1 枚、選択肢=通常テキスト(画像は稀)、解説=図 1〜2 枚、が想定主。**per-target は 1 枚が主・2 枚以上は tail** と見積る。
- **最小ルールの根拠**: 上記推定ゆえ、複数側(wrap タイル)は**最も単純な実装に留める**(枚数別の凝った分岐・仮想化・専用レイアウトを作らない)。二分岐 = `targetImages.length === 1` か否かの 1 判定のみ。
- **将来**: prod 実測で per-target 複数が高頻度と判明した場合に限り、複数側のレイアウトを別 task で洗練する(YAGNI: 頻度確認前に作らない)。本 sprint はこの見送りを明記して block しない。
- **目的**: 演習の主目的(読んで解く)が target の枚数でブレないこと + 合計高の青天井防止、の両立。

### 3.3 畳み処理(縦長・単一画像 in-flow)

- **高さ上限 `capPx` = `min(70svh, 44rem)`**(検証開始値・**svh**。dvh でない)。**`capPx` は、`max-height:min(70svh,44rem)` + 高い spacer を持つ測定要素の `clientHeight`(= browser が layout で解決した used max-height の px)を読む**(svh を JS で再計算せず、CSS の clip と数値を一致させる)。測定要素は clip wrapper と **分離**(fold=false 画像を silently clip しないため)。
  - **[OT 承認 amendment 2026-07-24・S3]** 当初 `getComputedStyle(wrapper).maxHeight` を指定していたが、CSSOM 上 `max-height` は computed value を返す規定で、一部エンジン(旧 iOS Safari 等)が `"min(70svh,44rem)"` 文字列を返し `parseFloat`→`NaN`→ 畳みが **silently 恒久無効**になるため、used value を読む `clientHeight` 方式へ変更。手段の差し替えであり「svh を JS で再計算しない」設計趣旨は不変。
- **fold 適用**: **`computeFold.fold === true` の時のみ** clip wrapper に `max-height:capPx; overflow:hidden` + 下端フェード(gradient・`pointer-events:none`)+ clip 外の明示ボタン「拡大して全体を見る」を付ける。**`fold === false` は clip/フェード/ボタンなし = 全高表示**(computeFold の『数 px 超過で畳まない』と DOM を一致 = silent-clip 回避)。
  - ボタンは `<button type="button">`(画像内の擬似要素でなく独立要素)・aria-label 付き・hit 領域 ≥44px。onClick = `useImageZoom.open`。
  - **画像本体 tap でも**モーダル(§3.1 の tap 経路と同一)。
- **畳み判定の dims 供給**(§6): `media_assets` mirror にあれば予測式(load 前でも判定可)、無ければ `<img>` の `onLoad` で `naturalWidth/Height` を得て `computeFold` を再評価(DL のみ端末のフォールバック)。予測不能な間は畳まず全高表示 → load 後に確定(layout jump を最小化するため、mirror dims がある一般ケースは load 前に確定する)。
- **閾値(§修正1)**: `computeFold` の二項(`capPx + absMarginPx` OR `capPx * ratio`)。検証開始値 = **`absMarginPx = 48`、`ratio = 1.15`**(数値は smoke で詰めるが、**式の形＝二項は固定**)。

### 3.4 モーダル(PhotoSwipe)

- **開く範囲** = tap した画像が属する **target の画像集合**(問題文なら問題文の画像群、選択肢なら当該選択肢の画像群)。標準 swipe / counter で target 内を送る。**カード横断はしない**。
- **供給** = programmatic `dataSource`(`{ src: blob objectURL, width, height, alt }`)+ `index=startIndex` で **core 直生成**(`new PhotoSwipe({ dataSource, index, ...config })`)。DOM サムネ(`<a>` gallery)や Lightbox module に依存しない。dims 未知の兄弟画像は open 時に blob decode(`Image().decode()`)で補完(N は小・§6)。
- **config(実装裏取りの根拠として保持)**:

| brief 要件 | PhotoSwipe 設定(v5) |
|---|---|
| pinch-to-close 無効 | `pinchToClose: false` |
| ドラッグ閉じ=初期倍率の下ドラッグのみ / ズーム中1本指=パン | `closeOnVerticalDrag: true`(fit 時のみ close・ズーム中は自動でパン挙動) |
| ダブルタップズーム | `doubleTapAction: 'zoom'` |
| 画像タップで閉じない | `imageClickAction` を close 以外(`'zoom'`)・`clickToCloseNonZoomable: false` |
| 長尺=横幅fit+縦スクロール / 「全体fit」を既定にしない | `initialZoomLevel` を **per-slide 関数**で、縦長(aspect が縦に極端)は `'fill'`(=幅fit+縦パン)、通常は `'fit'` |
| ズーム階層 | `secondaryZoomLevel`(double-tap/ボタン)・`maxZoomLevel`(pinch 上限)|
| フォーカストラップ / ESC / 復帰 | `trapFocus: true` / `escKey: true` / `returnFocus: true`(組込)/ `arrowKeys: true` |

- **WCAG 2.5.1(複数点ジェスチャの単一ポインタ代替)** = `ui.registerElement` で **+/−/リセット** ボタンを追加(onClick で `pswp.currSlide.zoomTo(...)`)。閉じるボタン hit 領域 ≥44px。開いた直後に閉じるボタンへ focus・閉じた後にトリガーへ復帰(`returnFocus` + 明示フォーカス制御)。
- **長尺判定** = per-slide の aspect(`naturalHeight / naturalWidth`)が閾値(**開始値 h/w > 2.0**)超で `'fill'`、それ以外 `'fit'`(数値は smoke で詰める。§3.3 の畳み判定とは独立の viewer 内判定)。

### 3.5 iOS WebKit

- **viewport 不変**: `app/layout.tsx` の `export const viewport`(width=device-width / initialScale=1)は変更しない。`user-scalable` を封じない = ページズーム維持。
  - **[S1 revert 2026-07-24]** 当初 `viewport-fit=cover` 追加を承認(2026-07-22)したが、cover は root layout ゆえ **app 全体**に効き、safe-area 未対応の app が unsafe 領域(notch/home-indicator)へ広がる(特に `exam-card-table-action-bar.tsx:78` の `fixed inset-x-0 bottom-0` 操作バーが home-indicator に被る実害)。app-shell 全面 safe-area 対応はスコープ外ゆえ **cover を revert**。モーダルは cover なしでも safe viewport 内で完動(chrome 安全・画像が edge-to-edge でないだけ = nice-to-have)。edge-to-edge は将来 app-shell safe-area sprint とセットで follow-up。
- **touch-action 領域分離**: モーダル内のみ。画像操作面は PhotoSwipe が自面(`.pswp__img` 等)に touch-action を設定する前提。自前 UI ボタン(+/−/リセット/閉じる)は `touch-action: manipulation`(300ms 遅延回避・意図しないズーム抑止)。in-flow のページ画像は標準タップ(touch-action 指定不要)。
- **高さ/safe-area**: モーダルは PhotoSwipe の全画面 overlay(JS で `innerHeight` 追従)。ページ側で全画面高を組む箇所は **svh/dvh** を使い、`100vh` は使わない(既存規律 `exam-detail-view.tsx:247` に準拠)。safe-area-inset を閉じるボタン/ツールバーに適用(`.pswp__top-bar` へ `env(safe-area-inset-top)` 等)。
- **scroll-lock(§修正2 + OT 承認 2026-07-22・fixed-body 既定)**:
  - iOS では `overflow:hidden` だけでは背景スクロールが漏れる(visual viewport < layout viewport = ページズーム中 / キーボード表示中。WebKit 既知報告・fact-finding の穴)。ゆえに **`position:fixed` + `scrollY` 退避/復帰を既定実装**とする(overflow-hidden 先行→smoke で決める往復=循環を避ける)。
  - body 既存 `overflow/position/top`/幅/scrollY を保存・復帰、例外/unmount/route change で必ず解除、冪等、**参照カウントなし**(画像モーダル同時 1)。
  - smoke は『決める』でなく『検証する』位置づけ。合否基準は §5 smoke(必須・iOS 実機 = OT acceptance)。

### 3.6 dims / データフロー / エラー

- **dims 優先順** = `media_assets` mirror(`getClientDb().media_assets.get(key)`)→ `<img>` の `naturalWidth/Height`(load 後・DL のみ端末フォールバック)。**同じ dims を畳み予測(§3.3)と PhotoSwipe dataSource(§3.4)の両方で再利用**。新スキーマ・deck-download 変更なし(根治は §9 台帳)。
- **error handling**:
  - 画像 tap 有効化 = objectURL 解決済み(`url` が string)時のみ。未解決(loading)/ 失敗(null=既存 placeholder+再読込)は tap 無効(モーダルを空で開かない)。
  - モーダル dataSource = target 内の**解決済み画像のみ**(未解決/失敗は除外)。tap した画像が解決済みゆえ空にはならない。
  - PhotoSwipe 読込失敗は `errorMsg` で表示(組込)。

## 4. 新 dep / de-risk gate

PhotoSwipe 5.4.4(MIT・依存ゼロ・ESM・`type:module`)。dynamic import + `photoswipe/style.css` import。

- **de-risk 手順(既存方式踏襲・fact-finding の依存監査規律)**: 一時 install → `pnpm typecheck` / `pnpm build` / hydration(dev で dynamic import + CSS が SSR を壊さないか)確認 → revert → 本採用は `chore(deps)` commit(実装 task と分離)。
- **audit**: `pnpm run audit` exit0(依存ゼロゆえ high/critical clean 見込み・要実測)。high 検出時は台帳規律(`pnpm-workspace.yaml auditConfig.ignoreGhsas` 明示追加のみ)に従う。

## 5. テスト戦略

- **`computeFold`(pure)= unit 厚く / 保証増 → red 検証必須**: 二項閾値の**両枝を個別に pin**(① `capPx + absMarginPx` を超え比率は未超の入力で fold=true[px 下駄側]② `capPx * ratio` を超え絶対差は未超の入力で fold=true[比率側]③ 両方未超で fold=false[数 px 超過で畳まない]④ `cappedHeightPx` の clip 値)。commit message に「red 検証」記録行。
- **`useImageZoom` = unit**: PhotoSwipe の dynamic import を **mock** し、config(`pinchToClose:false` 他 §3.4 表)と dataSource shape(`{src,width,height,alt}`・startIndex)を pin(要件対応表の実装裏取り)。実 PhotoSwipe は読み込まない(mock 必須)。
- **`CardImageGallery` = component**: 画像 tap → `open` が target の解決済み集合 + 正しい開始 index で呼ばれる / `display='thumb'` は 64px 維持・`'inflow'` は大きめ / 単一 vs 複数の分岐(畳みラッパー有無)/ 編集面 × 削除が不変 / readOnly。
- **a11y = assertion**: 畳み「拡大して全体を見る」/ 閉じる / +/−/リセット が role=button・aria-label を持つ。
- **gesture 実挙動は unit 不能 → DevTools/実機 smoke**(§5 smoke): pinch / ダブルタップ / pan / 長尺 `'fill'`(幅fit+縦スクロール)/ pinch-to-close 無効 / ドラッグ閉じ条件 / +/−/リセット。
- **smoke(必須合否・§修正2 + OT 承認 2026-07-22)** — **iOS scroll-lock + 長尺パン + safe-area 非破壊**:
  - **主再現 = ページズーム中(pinch でページ拡大)にモーダルを開く**(visual<layout viewport の mismatch を確実に作る)。キーボード表示中経路(画像タップは通常 input を blur するため不安定)は best-effort 併記。
  - 合否 = ① モーダル表示中に背景がスクロールしない ② 閉じた後に元の scroll 位置とフォーカスへ戻る ③ タップ位置がずれない ④ **[S2] 長尺画像を 1 本指で自然に上下閲覧できる**(pan を「縦スクロール」充足と認める)⑤ **[S3・畳み発火 must-pass] 実 tall 画像で演習 in-flow の畳みが実際に効く**(clip + 下端フェード + 「拡大して全体を見る」ボタンが **iOS Safari / Chrome 両方で出る**)= `capPx` の `clientHeight` 測定が実機で px を返すことの検証。短い画像は畳まない(全高)ことも併せて確認(scroll-lock だけ見て畳み機能の生死を見逃さない)。
  - 環境 = **iOS Safari(縦 / 横)/ iPad / ホーム画面追加版(PWA standalone)**。
  - iOS 実機は CC 到達不能 = **OT acceptance**(URL / 手順 / 期待挙動 / mobile 要否を整理して依頼・結果を session doc に記録)。
- **完了 gate(CLAUDE.md 恒久)**: whole-repo `pnpm lint` exit0 / `pnpm test` green / `pnpm typecheck` 0 / **`pnpm build` 0(新 dep + dynamic import + CSS import ゆえ必須)** / `pnpm test:iso` green(DB 不変) / `pnpm run audit` exit0。report chat に各 1 行明記。

## 6. Phase 分割の方針(plan で確定)

全 phase 表示系(feat)。**各 phase の完了条件 = 対象 test green + Critical 0 + [reviewed]**(canonical + Codex)。想定粒度(順序・分割は writing-plans で確定):

1. **de-risk + dep 本採用**(`chore(deps)`・§4)。
2. **`computeFold` pure + unit**(red 検証)。
3. **`useImageZoom` + PhotoSwipe config + 自前ズームボタン**(mock unit)。
4. **`CardImageGallery` 拡張**(`display` prop / tap→モーダル / 単一・複数分岐 / 畳みラッパー)。
5. **演習 in-flow 配線**(`session-runner.tsx` の 3 slot に `display='inflow'`)。
6. **iOS 対応**(touch-action / safe-area / scroll-lock 補い)+ smoke(§5)。

## 7. 不変条件(実装で守る)

- カード画像の `<img>` src は blob objectURL のみ(署名 URL を `<img src>`/DB/Dexie に置かない・`card-image-gallery.tsx:9`)。モーダルも同経路の objectURL を再利用。
- 新規に **target 部分集合の独自 commit を作らない**(表示専用改修ゆえ attach/remove 経路に触れない)。
- `display='thumb'`(既定)の面(編集/テーブル/サイドピーク)は **64px 表示を不変**に保つ(モーダル tap のみ追加)。
- viewport は **`user-scalable` を封じない**(ズーム維持)。**`viewport-fit=cover` は導入しない**(S1 revert 2026-07-24 = app 全体 safe-area 未対応ゆえ cover が app-wide regression。§3.5 参照)。
- next/image を導入しない。

## 8. Out of scope(follow-up 台帳)

- deck-download が実寸 dims を書かない穴の根治(DL 端末の mirror 欠落)= sync 隣接ゆえ分離。本 sprint は §3.6 の `<img>.naturalWidth` 実測フォールバックで表示側を回避。
- alt テキスト a11y(asset に alt 列はあるが今回は表示 blocker に集中)。
- インライン二段階展開(モーダルとの中間 UI)。まずモーダルのみ。
- 編集画面の長尺画像警告 / 画像分割機能。
- 4 欄(Sprint I)ギャラリー切替 UX 高度化(per-target 複数が prod で高頻度と判明した場合の別 task)。
- メモ本文表示と Sprint I docs 前提記述「memo は学習非表示」の齟齬(OT 確認事項・fact-finding §7)。
