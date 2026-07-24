# 画像表示 UX 改修 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 単一表示入口 `CardImageGallery` と新規モーダルユニットに、演習 in-flow 拡大 / 縦長畳み / 全画面 PhotoSwipe モーダル(ピンチ + WCAG ボタン)/ iOS 対応を載せる(表示専用・sync/DB 不変)。

**Architecture:** spec `docs/superpowers/specs/2026-07-22-image-display-ux-design.md`(承認済・凍結 `06d4d62`)。3 ユニット = `computeFold`(pure)/ `useImageZoom`(PhotoSwipe core wrapper)/ `CardImageGallery` 拡張。URL 解決は既存 `getAssetObjectURL` を再利用し blob objectURL のみを扱う。

**Tech Stack:** PhotoSwipe 5.4.4(MIT・依存ゼロ・ESM・dynamic import + `photoswipe/style.css`)/ 生 `<img>` + blob objectURL / Vitest + fake-indexeddb(PhotoSwipe は mock)。

## Global Constraints(全体ルール・各 task に適用)

1. task 2〜5 は feat = **TDD(test first)** → canonical(`superpowers:requesting-code-review` デフォルト経路)+ Codex(`scripts/ai/codex-review.sh`)→ **未解決 Critical 0 / Important 0** 収束 → `[reviewed]` commit。**per-task で full test green**(RED を commit しない)。task 1 は `chore(deps)`=`[no-review]`(製品コード無)、task 6 は code=`[reviewed]` + iOS 実機 smoke は OT acceptance(下記)。
2. **表示専用の不変条件(spec §7・各 task の non-goal = review で逸脱を弾く)**: ① カード画像 `<img>` src は blob objectURL のみ(署名 URL を `<img src>`/DB/Dexie に置かない・モーダルも同経路 objectURL 再利用)② **target 部分集合の独自 commit を作らない**(attach/remove 経路に触れない)③ `display='thumb'`(既定)面(編集/テーブル/サイドピーク)は **64px 表示不変**(モーダル tap のみ追加)④ **next/image 導入しない**。
3. **検証開始値(spec §3.3/§3.4・式/構造は固定・数値は smoke で詰める)**: 畳み `capPx=min(70svh,44rem)` / 二項閾値 `absMarginPx=48` **OR** `ratio=1.15` / 複数タイル `128px` / モーダル長尺 `'fill'` 判定 `aspect(h/w) > 2.0`。定数は**呼出側が渡す**(pure 関数/hook は定数を内蔵しない = testable)。
4. test = 実 Dexie(fake-indexeddb)、**PhotoSwipe / server action は mock**(実 I/O・実 PhotoSwipe ロード禁止)。gesture・実スクロール漏れは unit 不能 = smoke(task 6)。
5. **完了 gate(CLAUDE.md 恒久・task 6 で whole-repo)**: `pnpm lint`(--max-warnings=0)/ `pnpm test` / `pnpm typecheck` / **`pnpm build`(新 dep + dynamic import + CSS import ゆえ必須)** / `pnpm test:iso` / `pnpm run audit` 全 exit0。
6. 自走継続・停止条件・spec 凍結は CLAUDE.md 準拠。

---

### Task 1: PhotoSwipe de-risk + dep 本採用(`chore(deps)`)

**目的**: PhotoSwipe 5.4.4 を dynamic import + CSS import で SSR/hydration を壊さず導入できることを実証し、**dep のみ**を分離 commit する(製品コードは task 3 で本実装)。

**Files**: Modify `package.json` / `pnpm-lock.yaml`(一時 spike は revert ゆえ製品コード差分ゼロ)。

**手順(de-risk gate・合否明記)**:
- `pnpm add photoswipe@5.4.4`。
- 一時 spike: 任意の client component に `const { default: PhotoSwipe } = await import('photoswipe')` + `import 'photoswipe/style.css'` を仮配線 → `pnpm dev` で対象ページを開く。
- **合否 4 点**: ① `pnpm typecheck` exit0(型解決)② `pnpm build` exit0(ESM dynamic import + CSS が Next 16 build を通る)③ hydration: dev で hydration error / CSP 違反(bucket 非公開 + 既存 CSP header)が console に出ない ④ `pnpm run audit` exit0(依存ゼロゆえ high/critical clean を**実測**)。
- OK → **spike を revert**(`git diff` = package.json/lockfile のみ)→ `chore(deps): add photoswipe 5.4.4 (image zoom modal) [no-review]` で commit。message に合否 4 点結果 + audit exit0 を記録。
- NG(build/hydration/audit / 実 API 仮定いずれか fail)→ **STOP・OT 再設計相談**(自前 pan/zoom は単純対抗でなく別設計ゆえ、切替は OT の再設計判断・Codex 独立22)。

**non-goal**: 製品コードを commit しない。CSP/remotePatterns を変更しない(blob objectURL ゆえ不要・spec §4/§7)。

**Codex 反映(de-risk 拡張)**: 一時 spike は **本番と同じ import 境界**(`components/media/` の hook module 相当から `photoswipe/style.css` を import)で行い CSS import 可否を実証。build/hydration/audit に加え、**実ブラウザで重要 API 仮定を目視**(ピンチで閉じない / 画像タップで閉じない / 長尺 `'fill'`=幅fit+縦パン / 下ドラッグ閉じは fit 時のみ / +/−/リセットの `zoomTo`)し de-risk 記録に残す(実挙動を最終 smoke まで未知にしない・Codex 独立20/plan-gap18)。CSP は console 違反ゼロだけでなく **ズーム UI/CSS が実際に適用される**ことも確認(plan-gap21)。spike は全て revert。

**完了条件**: 合否 4 点 exit0 + 実ブラウザ API 仮定の de-risk 記録 + spike revert 済(diff = dep のみ)+ `chore(deps) [no-review]` commit + working tree clean。

---

### Task 2: `computeFold` pure 関数 + unit(red 検証)

**目的**: 縦長畳み判定を二項閾値の pure 関数へ切り出す(spec §3.1/§3.3)。UI から独立に test。

**Files**: Create `lib/media/compute-fold.ts` / Test `lib/media/compute-fold.test.ts`。

**Produces**: `computeFold(args: { naturalWidth: number; naturalHeight: number; renderedWidthPx: number; capPx: number; absMarginPx: number; ratio: number }): { fold: boolean; cappedHeightPx: number }`。

**制約**:
- `renderedHeightPx = renderedWidthPx * naturalHeight / naturalWidth`。
- **二項 OR(spec §修正1)**: `fold = renderedHeightPx > capPx + absMarginPx || renderedHeightPx > capPx * ratio`。
- `cappedHeightPx = Math.min(renderedHeightPx, capPx)`。
- 純粋・I/O なし・過剰防御を足さない(`naturalWidth > 0` は呼出側保証 = dims 未確定は渡さない・spec §3.6)。定数は引数で受ける。

**test(保証増 → red 検証必須・両枝を個別 pin)**:
- ① **px 下駄枝の分離**: `capPx=400, absMarginPx=48, ratio=1.15`(px 閾値 448 < 比率閾値 460)。`renderedHeightPx=455` → A 真(>448)/ B 偽(<460)→ `fold=true`(px 枝のみで成立)。
- ② **比率枝の分離**: `capPx=200`(比率閾値 230 < px 閾値 248 = 小 viewport で比率が先に効く = §修正1 の狙い)。`renderedHeightPx=240` → B 真(>230)/ A 偽(<248)→ `fold=true`(比率枝のみで成立)。
- ③ 両枝未満で畳まない(数 px 超過を畳まない): `capPx=400, renderedHeightPx=410` → `fold=false`。
- ④ clip 値: `renderedHeightPx>capPx` で `cappedHeightPx===capPx` / 未満で `===renderedHeightPx`。
- **red 検証**: 実装前に FAIL(未定義)。加えて **二項の各枝を個別に neuter して ①/② が RED になる**ことを commit 前 review で確認・報告(message に「**red 検証**」行)。

**完了条件**: ①〜④ green + 両枝 neuter で対応 test RED 実証(記録)+ Crit0/Imp0 + `[reviewed]`。

---

### Task 3: `useImageZoom`(PhotoSwipe core wrapper + WCAG ズームボタン)

**目的**: PhotoSwipe を知る唯一のユニット。`open(images, startIndex)` で全画面モーダルを起動(spec §3.1/§3.4)。

**Files**: Create `components/media/use-image-zoom.ts` / Test `components/media/use-image-zoom.test.ts`。

**Consumes**: PhotoSwipe core(task 1 dep・`await import('photoswipe')`)。
**Produces**: `useImageZoom(): { open(images: ZoomImage[], startIndex: number): Promise<void> }`；`export type ZoomImage = { src: string; width: number; height: number; alt: string }`。

**制約(config = spec §3.4 表を verbatim)**:
- **core 直生成**: `const { default: PhotoSwipe } = await import('photoswipe'); const pswp = new PhotoSwipe({ dataSource: images, index: startIndex, ...OPTS }); pswp.on('uiRegister', () => registerZoomButtons(pswp)); pswp.init();`。Lightbox module 不使用。`import 'photoswipe/style.css'` はこの module で。
- `OPTS` = `{ pinchToClose:false, closeOnVerticalDrag:true, doubleTapAction:'zoom', imageClickAction:'zoom', clickToCloseNonZoomable:false, escKey:true, arrowKeys:true, trapFocus:true, returnFocus:true, initialZoomLevel:(z)=> aspect>2.0 ? 'fill' : 'fit' }`。`secondaryZoomLevel` / `maxZoomLevel` は PhotoSwipe 既定(未指定 = 2.5x / 4x fit)を使う(数値は smoke で詰める)。aspect = slide の h/w(spec §3.4)。
- `registerZoomButtons`: `ui.registerElement` で **+/−/リセット**(`isButton`・`ariaLabel`・`touch-action:manipulation`)→ onClick で `pswp.currSlide.zoomTo(...)`(**+ = 現倍率×step / − = ÷step / リセット = initialZoomLevel へ**・WCAG 2.5.1)。閉じるボタンは PhotoSwipe 既定(hit ≥44px を CSS で担保 = task 6)。
- lifecycle: open ごとに生成、`pswp.on('destroy')` で参照解放。hook unmount 時に開いていれば close。
- **non-goal(§7)**: `src` は呼出側が渡す blob objectURL のみ。この hook は URL 解決/presigned を行わない(責務分離)。

**test(PhotoSwipe を `vi.mock('photoswipe')` で差替・実ロード禁止)**:
- `open()` で ① `new PhotoSwipe` が **OPTS 全キーで**呼ばれる(`pinchToClose:false` 他を**個別 assert** = 要件対応表の pin)② `dataSource===images` / `index===startIndex` ③ `initialZoomLevel` 関数へ aspect>2.0 の zoomLevelObject を渡すと `'fill'`、≤2.0 で `'fit'` ④ `uiRegister` で +/−/リセット 3 ボタンが `registerElement`(name/ariaLabel)⑤ close で `destroy` 呼出。
- 実 pinch/pan は mock 不能 = smoke(task 6)。

**Codex 反映(lifecycle / focus / concurrency)**:
- **競合ガード**: 同時 1 インスタンス。open 中フラグ + dynamic import 解決前の unmount / 再 open を無視、`destroy` は冪等(Codex 独立4/plan-gap6)。
- **focus**: open 直後に閉じるボタンへ focus(`returnFocus:true` に依存しない明示制御)、close で **起動要素(タップ画像 button の ref)へ復帰**、DOM 消失時は既定 focus へ fallback(spec §3.4・Codex 独立14/plan-gap7)。
- **lifecycle**: `close()` = 閉じアニメ → `destroy` event。参照解放 / scroll-lock 解除は `destroy` で。unmount 時に開いていれば `close()`(Codex plan-gap5)。
- **ズームボタン**: リセット先は文字列でなく **現 slide の実数 initial**(`pswp.currSlide.zoomLevels.initial`)、`zoomTo` は `[initial, max]` に clamp、min/max で disabled(Codex 独立13/plan-gap8)。
- **test 追加**: focus / クランプ / リセット先 / 二重 open 無視 / import 中 unmount を個別 pin(registered だけで終えない)。

**完了条件**: mock unit green + **config 全キー pin**(§3.4 表網羅)+ focus/ズームボタン/競合 test pin + Crit0/Imp0 + `[reviewed]`。

---

### Task 4: `CardImageGallery` — 画像 tap → モーダル(全面・64px サムネ不変)

**目的**: 全表示面(編集/テーブル/サイドピーク/演習)の画像本体 tap で全画面モーダルを開く。64px 表示は不変(spec §3.1)。

**Files**: Modify `app/(app)/app/exams/[id]/_components/card-image-gallery.tsx` / Test `app/(app)/app/exams/[id]/_components/card-image-gallery.test.tsx`。

**Consumes**: `useImageZoom.open`(task 3)・`getAssetObjectURL`(既存)。
**Produces**: gallery-level `openModal(startIndex)`(全 gallery の画像 tap を配線)。

**制約**:
- `CardImageThumbnail` の `<img>` を tap 可能に(独立 `<button>` でラップ or `onClick`+role)。**tap 有効化は `url` が string(解決済)時のみ**(loading/失敗 placeholder は tap 無効 = 空モーダル防止・spec §3.6)。
- `openModal(startIndex)`: `targetImages` を map し各 key を `getAssetObjectURL`(Map memo で安価)で objectURL 解決 + dims(`media_assets` → `<img>.naturalWidth`)を集め `ZoomImage[]` を構築 → `useImageZoom.open(resolved, startIndex)`。**未解決/失敗画像は集合から除外**(spec §3.6)。`startIndex` は tap 画像の解決済み集合内 index。
- 編集面の × 削除ボタン(`:146-155`)は別 hit target のまま不変(画像 body=モーダル / ×=削除)。`readOnly` でも tap→モーダルは有効(閲覧)。
- **non-goal**: 64px 寸(`h-16 w-16`)不変。attach/remove 経路に触れない。**`display` prop は導入しない**(large/inflow は task 5 で prop 込み導入 = Codex plan-gap3: 意味と表示が食い違う中間状態を作らない)。本 task は全 gallery で 64px サムネ tap→モーダルのみ。

**test(実 Dexie + `useImageZoom` mock)**: 画像 tap → `open` が target の解決済み `ZoomImage[]` + 正しい `startIndex` で呼ばれる / 別 target の画像は集合外(target 単位)/ loading・失敗 thumbnail は tap 無効(`open` 未呼)/ 編集面 × は従来どおり削除(`open` 未呼)/ `h-16 w-16` 不変 / `readOnly` でも tap→`open`。

**Codex 反映(解決の堅牢化 / a11y / 回帰)**:
- **兄弟 dims**: 未表示兄弟は DOM `<img>` ref が無いため **`Image().decode()` で naturalWidth/Height を取得**(spec §3.6・Codex 独立2/plan-gap1)。decode 用 objectURL は取得後 `revokeObjectURL`(**resolver の cache URL は revoke しない** = 所有権分離・Codex 独立5/plan-gap20)。
- **順序と index**: 結果配列は **元 ordinal 順を維持**(完了順で並べ替えない)、`startIndex` は **タップ asset の key で再計算**(未解決除外で index がずれる・Codex 独立3/plan-gap2)。タップ画像は tap-gate で常に解決済ゆえ集合は非空。
- **loading / 失敗**: タップ画像は cache 解決済で即 open。兄弟の decode/fetch 失敗は集合から除外(`errorMsg` は PhotoSwipe 内 load 用ゆえ解決前失敗は gallery 側で除外・Codex 独立7/plan-gap19)。**worst-case 10 枚を eager 一括 decode しない**(PhotoSwipe lazy slide load に委ね dims は必要時 decode・iOS メモリ配慮/smoke・Codex 独立6)。
- **アクセシブルネーム**: 画像 button 名は `alt` 空でも fallback「画像を拡大」/「画像 N を拡大」(alt 改善は Out でも操作要素の名前は必須・Codex 独立19)。
- **レイアウト不変**: button ラップで 64px flex / table cell / 削除ボタン配置を変えない(`display:contents` 等で寸法非改変)+ **表示面別 test**(編集/テーブル/side-peek/study)で回帰(Codex 独立22/plan-gap22)。

**完了条件**: test green + 兄弟 decode/index/a11y-name/面別回帰 test pin + 既存 gallery test 回帰なし + Crit0/Imp0 + `[reviewed]`。

---

### Task 5: `CardImageGallery` `display='inflow'`(大きめ + 畳み + 単一/複数分岐)+ 演習配線

**目的**: 演習 in-flow 画像を大きめ表示にし、単一縦長は畳み処理、複数は wrap タイル。`session-runner` の 3 slot に配線(spec §3.2/§3.3)。

**Files**: Modify `card-image-gallery.tsx`(inflow 描画 + 畳みラッパー)/ `app/(app)/app/study/smart/_components/session-runner.tsx`(3 slot に `display='inflow'`)/ Test `card-image-gallery.test.tsx` + `session-runner.test.tsx`。

**Consumes**: `computeFold`(task 2)・`openModal`(task 4)。
**Produces**: `CardImageGallery` に `display?: 'thumb' | 'inflow'`(既定 `'thumb'`・本 task で新規導入)。

**制約**:
- `display='inflow'` 分岐は **`targetImages.length` の二分のみ**(枚数別の細分岐を作らない・spec §3.2):
  - **単一(===1)**: 幅100%画像(`width:100%; height:auto`)。**`capPx` は wrapper の `getComputedStyle().maxHeight`(CSS `min(70svh,44rem)`)を px 解決して得る**(svh を JS で再計算しない・spec §3.3)→ `computeFold({ naturalWidth, naturalHeight, renderedWidthPx, capPx, absMarginPx: 48, ratio: 1.15 })`。**clip は `fold=true` の時だけ有効化**(`max-height:capPx; overflow:hidden` + 下端フェード[gradient・`pointer-events:none`]+ **clip wrapper の外**に `<button>`「拡大して全体を見る」[aria-label・hit ≥44px・onClick=`openModal`])。`fold=false` は clip/フェード/ボタンなし = 全高表示(`computeFold` の『数 px 超過で畳まない』と DOM を一致させる = Codex 独立9/plan-gap10 の silent-clip bug 修正)。dims 未取得時は load 前は畳まず全高 → `<img>.onLoad` の `naturalWidth/Height` で再評価 + **`ResizeObserver`(wrapper)で回転/split view/幅変化時に再計算**(cleanup 付き・Codex 独立8/plan-gap9)。
  - **複数(>=2)**: 中サイズタイル(開始値 `128px`・`object-cover`)の `flex-wrap`・**畳みなし**・各タイル tap→`openModal`(spec §3.2)。
- 画像 tap / 畳みボタンは task 4 の `openModal` を共用(単一・複数・畳みボタンすべて同一モーダル経路)。
- **session-runner 配線**: `question_text`(`:445`)/ `option:<uid>`(`:509`)/ `explanation_text`(`:551`)の 3 `CardImageGallery` に `display='inflow'` を追加(`readOnly` は維持)。**メモ島(`:566`)は触らない**。
- **non-goal**: メモ slot は演習非表示のまま(spec §7・Sprint I 意図)。`display='thumb'` 面は不変。閾値定数は呼出側で渡す(spec §3.3 開始値)。

**test(実 Dexie + `useImageZoom` mock + `computeFold` は実関数)**:
- 単一 inflow: dims 縦長 → 畳みラッパー(max-height class + フェード + 「拡大して全体を見る」button)描画・button tap→`open` / dims 横長 → 畳まない(button 不在)/ dims 未取得 → 初期畳まず、`onLoad` 後 `naturalWidth` で畳み(jsdom で `naturalWidth` を stub)。
- 複数 inflow: 2 枚 → タイル `flex-wrap`・畳みラッパー不在・各タイル tap→`open`。
- session-runner: 3 slot が `display='inflow'` で描画(64px でない)・**メモ画像は非描画不変**。

**Codex 反映(test 妥当性 / 多画像)**:
- **test 抽象化**: jsdom は `min(70svh,44rem)` の computed px や実 layout 幅を解決できない。畳み分岐 test は **`capPx`/`renderedWidthPx` を注入(getComputedStyle/clientWidth を stub)** して `computeFold` 実関数を通す。実 CSS↔JS 一致は smoke(task 6・Codex 独立12/plan-gap12)。
- **多画像の高さ**: 128px タイル wrap は厳密上限でない(10 枚で複数行)。**有限(≤10 枚)**の意味に留め、行数制限/横スクロールは**足さない**(YAGNI・per-target 複数は tail・spec §3.2)。「青天井を構造で防ぐ」は『幅100%単列積み上げに比べ有界』の意へ表現精緻化(Codex 独立11)。

**完了条件**: test green + clip=fold条件一致/多画像/resize test pin + 既存 gallery/session-runner test 回帰なし + Crit0/Imp0 + `[reviewed]`。

---

### Task 6: iOS 対応 + scroll-lock + smoke パッケージ + 完了 gate/handoff

**目的**: モーダル/畳みの iOS WebKit 対応(touch-action/safe-area/scroll-lock)を仕上げ、必須 smoke(iOS scroll-lock)を OT 実機依頼としてパッケージ化し、sprint 完了 gate を通す。

**Files**: Modify `components/media/use-image-zoom.ts` および/または `app/globals.css`(touch-action / safe-area / scroll-lock CSS)/ 必要時 `card-image-gallery.tsx` / Test 該当 unit / session doc(`docs/superpowers/sessions/`)。

**制約**:
- **touch-action 領域分離(spec §3.5)**: 自前 +/−/リセット/閉じるボタンに `touch-action:manipulation`。画像操作面は PhotoSwipe 既定(自面に touch-action 設定される前提)を smoke で確認。
- **safe-area**: `.pswp__top-bar` / 自前ツールバーに `env(safe-area-inset-top)`(+ 横 inset)。自前で全画面高を組む箇所があれば **svh/dvh**(`100vh` 禁止・既存 `exam-detail-view.tsx:247` 規律)。
- **scroll-lock は初手から堅牢方式(Codex 独立16,17/plan-gap14,16 反映・§修正2 の「overflow-hidden 不足前提」を実装既定に格上げ)**: overflow-hidden 先行→smoke で決める往復(循環)を避け、**`position:fixed` + `scrollY` 退避/復帰**を既定実装にする(open で body 固定 + `top:-scrollY`、close で解除 + `window.scrollTo(0, scrollY)`)。body の既存 `overflow/position/top`/幅/scrollY を保存・復帰し、例外/unmount/route change でも必ず解除、冪等。**参照カウントは作らない**(画像モーダル同時 1 = YAGNI)。→ smoke は『決める』でなく『検証する』位置づけになり status 循環が解消。unit で pin 可能なのは「open で lock 付与・close で解除・close 後に `scrollTo(scrollY)` 呼出」まで(実スクロール漏れは jsdom 不能 = smoke)。
- **non-goal**: viewport meta(`user-scalable`)を変えない(spec §3.5・§7)。
- **OT 実機 smoke 依頼パッケージ(spec §5 必須合否・plan 内で整理)**:
  - **URL**: stg `stg.recallmint.nekotest.net` の演習画面(実カード画像ある deck。seed 状況により mirror 直注入・`reference_stg` 参照)。
  - **手順**: ① 編集画面でテキスト入力にフォーカス(ソフトキーボード表示)したまま画像 tap→モーダル起動 ② pinch / ダブルタップ / pan / 長尺の横幅fit+縦スクロール / +−リセット ③ 閉じる。
  - **期待挙動(合否)**: (a) モーダル表示中に背景がスクロールしない (b) 閉じた後に元 scroll 位置とフォーカスへ復帰 (c) タップ位置がずれない (d) pinch-to-close しない / 下ドラッグ閉じは初期倍率のみ / 画像タップで閉じない (e) **[畳み発火 must-pass・S3] 実 tall 画像で演習 in-flow の畳みが効く**(clip + 下端フェード + 「拡大して全体を見る」ボタンが **iOS Safari / Chrome で出る**・短い画像は畳まない)= `capPx` の `clientHeight` 測定が実機で px を返す検証(spec §5⑥・§3.3 S3。scroll-lock だけ見て畳み機能の生死を見逃さない)。
  - **環境**: iOS Safari(縦/横)/ iPad / ホーム画面追加版(PWA standalone)/ **ページズーム中も同基準**。
  - **mobile 要否**: 要(物理 iOS・CC 到達不能ゆえ OT 実機)。
- **完了 gate(全体ルール 5)**: whole-repo 6 gate exit0。session doc に commit range・per-task 要点・OT smoke checklist・**検証開始値の smoke 詰め欄**(capPx/absMargin/ratio/tile/aspect の実測調整の受け皿)を記載し `docs(session) [no-review]` commit。

**Codex 反映(status 分離 / 再現性 / 追加 smoke / 仕様確認)**:
- **status 分離(plan-gap14,15)**: task 6 の完了 = 『コード実装 + [reviewed] + 6 gate exit0』。**iOS 実機 smoke は別ステータス(OT acceptance・結果を session doc に記録)**。依頼パッケージ提示だけで『実装完了』にしない。scroll-lock を堅牢方式(fixed-body)既定にしたため smoke は検証位置づけ(循環解消)。
- **keyboard 経路の再現(Codex 独立15)**: 画像タップは通常 input を blur しキーボードを閉じるため『キーボード表示中に開く』は不安定。**主再現 = 『ページズーム中(pinch でページ拡大)にモーダルを開く』**(visual<layout viewport の mismatch を確実に作る)。キーボード経路は best-effort 併記。
- **smoke 追加経路(plan-gap16,17,21・独立18,21)**: Cache miss/低速/decode 失敗の縮退 / side-peek 上から開いた時の z-index・Escape が**画像モーダルのみ**閉じる・focus 復帰 / iOS/Android back でモーダルが閉じるか遷移するか(観測)/ CSP 下でズーム UI/CSS が実適用。
- **[S1 revert 2026-07-24] safe-area**: 当初 `viewport-fit=cover` 追加を承認したが、cover は root layout = **app 全体**に効き safe-area 未対応の app が unsafe 領域へ広がる(`exam-card-table-action-bar.tsx:78` の `fixed inset-x-0 bottom-0` 操作バーが home-indicator に被る等)。app-shell 全面 safe-area はスコープ外ゆえ **cover を revert**(モーダルは cover なしで完動)。touch-action / scroll-lock は残す。edge-to-edge は app-shell safe-area sprint の follow-up。
- **[S2・OT 承認 2026-07-22] 縦スクロール**: 長尺 `'fill'` の PhotoSwipe 1 本指パンを『縦スクロール』充足と認める。smoke 合否に **『1 本指で自然に上下閲覧できる』** を明記(spec §5 ④)。

**完了条件**: iOS CSS/scroll-lock(fixed-body)実装 + unit(付与/解除/`scrollTo` 復帰呼出)green + `[reviewed]`(code は表示系ゆえ canonical+Codex pass で付与)+ 6 gate exit0 + session doc commit。**iOS 実機 smoke は別ステータス = OT acceptance**(依頼パッケージ提示 + 結果を session doc に記録)。stop checkpoint 報告。

---

## 実行順序と依存

1(dep)→ 2(computeFold・独立)→ 3(useImageZoom・1 依存)→ 4(gallery tap→modal・3 依存)→ 5(inflow+fold+配線・2/4 依存)→ 6(iOS+smoke+gate)。

**§6 の 6 粒度からの再描画(判断・OT 提示)**: spec §6 の「4=CardImageGallery 拡張 / 5=演習配線」を、**4=tap→modal(全面・display='thumb')/ 5=inflow+fold+session-runner 配線**へ引き直した。理由 = ① tap→modal は単独で全面に価値を出し独立レビュー/出荷可能(reviewer が inflow を保留しても tap-modal を承認できる)② inflow 描画と session-runner の 3 行配線は相互に単独価値がない(配線だけ・描画だけでは可視にならない)ため 1 task に畳むのが right-sizing。task 数は 6 のまま。

## Codex cross-check 観点(plan ドラフト後・確定前に 1 回)

`scripts/ai/codex-plan-review.sh` に調査結果 + 要件を主・本 plan を参考添付(anchor 防止)で投げ、以下を独立に照合させる:
1. **phase 境界の妥当性**: task 4/5 の分割(tap→modal と inflow+fold の分離)が独立レビュー可能か。session-runner 配線を task 5 へ畳む判断の妥当性。computeFold(task 2)を唯一の consumer(task 5)より前出しする順序。
2. **test の red 検証十分性**: computeFold 両枝の neuter-RED が vacuous でないか(①②が別 capPx で各枝を実際に分離できているか)。useImageZoom の config pin が mock 越しに要件を実証しているか。task 5 の畳み test が `computeFold` 実関数を通るか。
3. **PhotoSwipe config の要件網羅**: spec §3.4 表の全要件が `OPTS` に写っているか・漏れ/誤設定(特に長尺 `initialZoomLevel` 関数・pinch-to-close 無効・ドラッグ閉じ条件・画像タップ非 close)。
4. **iOS smoke 合否の実効性**: §修正2 の「overflow-hidden 不足前提」を smoke 手順が実際に暴けるか(キーボード表示中・ページズーム中の経路が合否に入っているか)。
5. **不変条件(§7)の enforce**: 各 task の non-goal が逸脱(署名 URL 混入 / 部分 commit 新設 / thumb 面 64px 変化 / next/image 混入)を review で弾ける粒度か。

## Codex cross-check 反映(2026-07-22・取りまとめ)

raw findings = `docs/codex/2026-07-22-plan-image-display-ux.md`(独立論点 22 + plan 抜け 22 + リスク 8)。CC 本体が突き合わせ、以下に triage(採用=plan へ fold / 既対応 / 見送り=YAGNI / OT 判断)。

**採用して plan へ fold(correctness/spec 要求・上記各 task の「Codex 反映」ブロック)**:
- silent-clip bug: clip を `fold=true` の時だけ有効化(独立9/plan-gap10)→ task 5。
- `startIndex` 再計算 + 兄弟順序維持 + タップ key 照合(独立3/plan-gap2)→ task 4。
- 兄弟 dims の `Image().decode()`(spec §3.6 既定・独立2/plan-gap1)+ objectURL 所有権(cache URL 非 revoke / decode URL 解放)(独立5/plan-gap20)→ task 4。
- 明示 focus(open→閉じるボタン / close→トリガー / fallback)(spec §3.4・独立14/plan-gap7)+ 競合ガード + lifecycle + ズームボタン clamp/reset 実 initial(独立4,13/plan-gap5,6,8)→ task 3。
- fold 再計算(ResizeObserver・独立8/plan-gap9)+ test 抽象化(jsdom 非依存・独立12/plan-gap12)→ task 5。
- scroll-lock を fixed-body 既定へ格上げ + status 分離(循環解消・独立16,17/plan-gap14,15,16)→ task 6。
- 画像 button のアクセシブルネーム fallback(独立19)+ 面別レイアウト回帰(独立22/plan-gap22)→ task 4。
- Task 1 に実ブラウザ API 仮定 de-risk + CSS import 境界一致(独立20/plan-gap4,18)。
- keyboard 経路の再現困難 → ページズーム主再現へ(独立15)+ 追加 smoke 経路(独立18,21/plan-gap16,17,21)→ task 6。

**既対応(Codex が plan/spec を見落とし)**: タップ画像は tap-gate で常に解決済ゆえモーダルは非空(独立3 の「タップ画像 decode 失敗」も除外規則でカバー)/ 単一 object 前提は spec §5・§7 で明記済。

**見送り(YAGNI・記録のみ)**: scroll-lock の参照カウント(画像モーダル同時 1・独立16)/ back 操作の history 統合(smoke 観測に留める・独立21)/ 多画像の行数制限・横スクロール(per-target 複数は tail・独立11/リスク)/ 兄弟 decode の同時実行数リミッタ(lazy load 委譲で足りる・独立6)。

**OT 判断(2026-07-22 = 全承認・plan 確定)**:
- **S1 safe-area = 承認 → 2026-07-24 revert**: cover が app 全体 safe-area 未対応で app-wide regression(`exam-card-table-action-bar.tsx:78` bottom-0 操作バー被り等)ゆえ revert。モーダルは cover なしで完動。edge-to-edge は app-shell safe-area sprint の follow-up。
- **S2 縦スクロール = 承認**: パンを充足と認める。smoke 合否④に明記(task 6)。
- 依存 NG 時 = 停止して OT 再設計(task 1 NG 分岐修正済)。

→ **plan 確定(2026-07-22)。実装は task 1 から着手。**
