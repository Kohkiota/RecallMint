# 画像表示 UX 改修 — 実装 session log(2026-07-22〜24)

subagent-driven-development で spec `docs/superpowers/specs/2026-07-22-image-display-ux-design.md`(+ amendment)/ plan `docs/superpowers/plans/2026-07-22-image-display-ux.md` を実装した記録。**task 1〜6 のコードは全 [reviewed] commit 済・未 push。task 6 の実機 smoke + whole-repo gate + whole-branch 最終 review が残作業**。

## commit range(未 push・local ahead 13)

`origin/develop` = **`f664675`**(= 別途実施した deps-fix・OT push 済)。image sprint = **`1076dd9`..`0159f22`(HEAD)**、13 commit。

| commit | 内容 |
|---|---|
| `1076dd9` | chore(deps) photoswipe 5.4.4(task 1 de-risk PASS)[no-review] |
| `bc6c7ae` | feat task 2 `computeFold` pure + unit [reviewed] |
| `a41a7ae` | docs(codex) task 2 |
| `f07ce16` | feat task 3 `useImageZoom`(PhotoSwipe wrapper + mock unit)[reviewed] |
| `4c4a8d4` | docs(codex) task 3 |
| `ac3845c` | feat task 4 gallery 画像 tap→zoom modal + resolver in-flight dedup [reviewed] |
| `43398a2` | docs(codex) task 4 |
| `5cce268` | feat task 5 `display='inflow'` 大きめ表示 + 縦長畳み + session-runner 配線 [reviewed] |
| `3920a8c` | docs(spec) §3.3 amendment(capPx→clientHeight・S3)+ task6 折り畳み smoke |
| `5474359` | docs(codex) task 5 |
| `aec9b1a` | feat task 6 iOS = fixed-body scroll-lock + close-button touch-action [reviewed] |
| `bb9ef3d` | docs(spec) S1 viewport-fit=cover **revert** |
| `0159f22` | docs(codex) task 6 |

## 別件(前提・push 済): deps-fix `f664675`
image sprint の task 1 de-risk 中に audit high 5 検出(next 16.2.9 SSRF×2/proxy-bypass/DoS + sharp<0.35.0)→ **next 16.2.11 + sharp override ^0.35.0** で解消・OT push 済。台帳 = `docs/audit/dependency-audit-ledger.md`「解消済(2026-07-23)」。軽量 stg smoke(認証 redirect + Server Action 作成/削除 net-zero)PASS 済。matrix = `docs/superpowers/sessions/2026-06-10-deps-target-versions-matrix.md` §7。

## task 完了状態

- **Task 1 (de-risk + dep)**: DONE。photoswipe 5.4.4 zero-dep。typecheck/build/hydration/CSP(実ブラウザ spike)PASS。実機 gesture 目視は task 6 smoke。
- **Task 2 (`computeFold`)**: DONE。`lib/media/compute-fold.ts`。二項閾値 `fold = rH>capPx+absMarginPx || rH>capPx*ratio`。pure・定数は引数。両枝 neuter-RED 実証。
- **Task 3 (`useImageZoom`)**: DONE。`components/media/use-image-zoom.ts`。PhotoSwipe core 直生成・config(§3.4 全キー個別 pin)・initialZoomLevel 数値関数(縦長 z.fill/他 z.fit)・+/−/リセット(clamp [initial,max]・reset=実数 initial)・focus・concurrency・16 mock unit。
- **Task 4 (gallery tap→modal)**: DONE。`card-image-gallery.tsx`。全面で画像 tap→モーダル(tap-gate=解決済のみ)・target 集合 ZoomImage[](ordinal 順・decode 補完・除外・startIndex=key 再計算)・a11y 名・64px 不変・iOS pre-focus。resolver in-flight dedup(`lib/media/get-asset.ts`)。
- **Task 5 (inflow + fold + 配線)**: DONE。`display='inflow'`(単一=幅100%+畳み / 複数=128px タイル)。session-runner 3 slot 配線(memo 不触)。
- **Task 6 (iOS)**: **コード部分 DONE + [reviewed] commit 済(`aec9b1a`)**。fixed-body scroll-lock + close-button touch-action。**残 = 下記「残作業」**。

## 残作業(task 6 の続き・新セッションで実施)

1. **OT 実機 smoke パッケージの提示**(1 枚チェックリスト)。CC が組み、OT が人力/CC 切り分けを返す。含める項目:
   - task 1 の 4 gesture(pinch-to-close 無効 / 下ドラッグ閉じ fit時のみ / 長尺 fill 縦パン / double-tap zoom)
   - **[S3 must-pass] 畳み発火**: 実 tall 画像で clip+フェード+「拡大して全体を見る」が iOS Safari / Chrome で出る(短い画像は畳まない)= `capPx` の clientHeight が実機で px を返す検証
   - scroll-lock: モーダル中背景非スクロール / 閉じた後 scroll 位置+focus 復帰 / タップ位置ずれない。**主再現=ページズーム中に開く**(キーボード表示中は best-effort)。unmount-during-opening でも lock leak しない(fallback unlock)
   - side-peek 上から開いた時の z-index / Escape が画像モーダルのみ閉じる / focus 復帰
   - iOS/Android back でモーダルが閉じるか遷移するか(観測)
   - Cache miss/低速/decode 失敗の縮退・CSP 下でズーム UI/CSS 適用
   - stg URL = `stg.recallmint.nekotest.net` 演習画面(seed 状況次第で mirror 直注入・`reference_stg` 参照)。物理 iOS = OT 実機
2. **whole-repo 6 gate**: `pnpm lint`(--max-warnings=0)/ `pnpm test` / `pnpm typecheck` / `pnpm build` / `pnpm test:iso` / `pnpm run audit` 全 exit0。報告に各 1 行明記。(注: audit は現在 next 16.2.11/sharp override 済で high0 のはず。)
3. **whole-branch 最終 review**(SDD 終端): `1076dd9..HEAD` の全 diff を canonical(最強モデル)+ Codex で 1 回。per-task の Minor roll-up(下記)を triage 対象に渡す。
4. **未 push commit の扱い**: 13 commit(`1076dd9..HEAD`)は未 push。whole-branch review + gate PASS 後、OT push → stg deploy → OT/CC 実機 smoke。**iOS 実機 smoke は別ステータス = OT acceptance**(結果を本 doc or 後続 session doc に追記)。

### per-task Minor roll-up(whole-branch review へ・記録のみ)
- task 3: focus-fallback test 非discriminating(task 4 で sentinel 化済)/ CSS eager import(spec §3.1 準拠)
- task 4: (dedup で解消済)
- task 5: skeleton `h-48` CLS / thumb-inline vs `useAssetObjectUrl` の dims 重複(rule-of-three 未達=統合しない)/ latent readOnly 分岐(到達不能)
- task 6: mid-opening unmount で orphan overlay DOM が残り得る(PhotoSwipe library-inherent・Critical の lock leak は fallback で解消済)/ landscape 右 notch の safe-area 未対応(cover revert ゆえ実質無関係)

## 判断根拠(後から分かりにくいもの)

- **capPx を `getComputedStyle().maxHeight` → `clientHeight` に変更(S3・spec §3.3 amendment `3920a8c`)**: CSSOM 上 max-height は *computed value* を返す規定で、一部エンジン(旧 iOS Safari)が `"min(70svh,44rem)"` の**文字列**を返し `parseFloat`→`NaN`→ guard で **畳みが silently 恒久無効**(iOS で本 sprint の問題が再発)。対策 = 測定要素(`max-h-[min(70svh,44rem)]` + `h-[100000px]` spacer + overflow-hidden)の `clientHeight`(used max-height の px)を読む。svh→px はブラウザが layout で解決(JS 再計算せず=§3.3 趣旨保持)。canonical が Chromium 実測(560=min@400×800・layout 副作用0)。**実機 px 保証は task6 smoke [S3]**。
- **`CardImageInflowSingle` の key remount(task 5 P1)**: 演習で次カードへ進むと同 position の single が React に再利用され、前カードの url/dims/naturalRef が居座り畳み判定が誤る(mirror row 無し新 asset で顕著)。→ `key={targetImages[0].key}` で remount(keyed sibling と統一)。
- **resolver in-flight dedup(task 4・`lib/media/get-asset.ts`)**: `objectUrlCache` は completed のみ保持ゆえ、モーダルの兄弟一括解決が thumbnail 解決中の兄弟と並行し **presigned+download 重複**。→ in-flight promise Map で合流。契約不変(null-on-failure/success-cache/failure-retry)。
- **gallery pre-focus(iOS focus-return)**: hook 署名を変えず、gallery が tap した button を open 前に明示 focus → hook の focus 復帰が iOS でも確実にその button を対象にする(iOS は tap だけで button に focus が乗らないことがある)。
- **viewport-fit=cover(S1)revert(`bb9ef3d`)**: cover は root layout=**app 全体**に効き、safe-area 未対応の app が unsafe 領域へ広がる(`exam-card-table-action-bar.tsx:78` の bottom-0 操作バーが home-indicator に被る実害)。app-shell 全面 safe-area はスコープ外。モーダルは cover なしで完動。**edge-to-edge は将来 app-shell safe-area sprint とセットで follow-up**。
- **scroll-lock unmount = force destroy + fallback unlock(task 6 P1)**: PhotoSwipe 5.4.4 `Opener.close()` は opening animation 中 no-op(source 確認)ゆえ、unmount-during-opening で soft close だと destroy 不発 → lock leak → page freeze。→ unmount cleanup を `destroy()` + 直接 `unlockBodyScroll`(冪等 fallback)にして保証。

## 検証開始値(smoke で実測調整する受け皿)

| 値 | 開始値 | 定義箇所 | 実測調整メモ(smoke 後に埋める)|
|---|---|---|---|
| capPx(畳み高さ上限)| `min(70svh, 44rem)` | `card-image-gallery.tsx` `INFLOW_CAP_MAX_H_CLASS` | |
| absMarginPx(px 下駄枝)| 48 | 〃 `INFLOW_ABS_MARGIN_PX` | |
| ratio(比率枝)| 1.15 | 〃 `INFLOW_RATIO` | |
| tile(複数画像タイル)| 128px | 〃 inflow tile | |
| aspect(モーダル長尺 fill 判定)| h/w > 2.0 | `use-image-zoom.ts` `computeInitialZoom` | |

## 新セッションで読むべき file path

- 本 doc(handoff)
- spec: `docs/superpowers/specs/2026-07-22-image-display-ux-design.md`(+ §3.3 amendment/§3.5 S1 revert 反映済)
- plan: `docs/superpowers/plans/2026-07-22-image-display-ux.md`(task 6 節 + S1 revert)
- SDD ledger: `.superpowers/sdd/progress.md`(全 task の完了記録・commit・fix loop)
- fact-finding(Step0): `docs/superpowers/sessions/2026-07-22-image-ux-factfinding.md`
- codex 記録: `docs/codex/2026-07-2[234]-image-ux-*.md`(plan cross-check + 各 task review trail)
- 実装コード: `lib/media/compute-fold.ts` / `lib/media/get-asset.ts` / `components/media/use-image-zoom.ts` / `app/(app)/app/exams/[id]/_components/card-image-gallery.tsx` / `app/(app)/app/study/smart/_components/session-runner.tsx`

---

## task 6 締め session(2026-07-24 続き)— smoke パッケージ + gate + whole-branch review + P2 fix

前セッションからの残作業(smoke パッケージ提示 / whole-repo gate / whole-branch review / push 判断)を実施。

### 追加 commit(未 push・`5175fe6` の後)

| commit | 内容 |
|---|---|
| `8cefdcc` | docs(session) 実機 smoke チェックリスト(分担確定)+ whole-branch Codex 記録 [no-review] |
| `c2867a0` | **fix(media) openModal 兄弟 peek 化(spec §3.6)+ stale open guard** [reviewed] |
| (本 commit) | docs(session) 本締め記録 [no-review] |

origin/develop = `f664675`。task 6 締め後の local ahead = **16 commit**。tree clean。

### 1. OT 実機 smoke パッケージ
`docs/superpowers/sessions/2026-07-24-image-ux-smoke-checklist.md`(19 項目・URL/手順/期待/環境)。OT が分担確定:
- **CC(stg push 後・Playwright・desktop Chromium)**: F1/F2 の Chrome 側(F1 は OT 実機の前に先行)/ Z1〜Z3(side-peek z-index/Escape/focus)/ R1〜R3(縮退/decode 除外/CSP UI)/ G6 機能面 / L1・B1 の desktop 部分。
- **OT 実機(物理 iOS/iPad)**: G1〜G5 gesture / F1 の iOS Safari 側(must-pass=clientHeight px)/ L1 主再現+L2+L3 / G6 物理 / B1。**L4(キーボード表示中)は検証対象外**(再現困難・L1 で充足)。
- **環境カバレッジ**: iPhone 縦=全 OT 項目 / 横・iPad=F1+L1 / PWA=L1 のみ(絞り込み理由=checklist「環境カバレッジ」節。CC 判定=不足なし)。

### 2. whole-repo 6 gate(fix 後・最終)
- `pnpm lint` exit 0(--max-warnings=0)
- `pnpm test` **3885 passed**(前 3880 + peek 3 + P2 2)
- `pnpm typecheck` exit 0
- `pnpm build` exit 0
- `pnpm test:iso` **217 passed**(DB 不変)
- `pnpm run audit` **exit 1** = **pre-existing・無関係 `postcss<=8.5.11` high(GHSA-6g55-p6wh-862q)**。`@tailwindcss/postcss@4.2.4` 経由の transitive で **origin/develop(f664675)の lockfile にも同一 entry**(本 sprint は zero-dep photoswipe のみ追加ゆえ由来せず)。patched あり(`>=8.5.12`・latest 8.5.22)。**OT dep 判断**(推奨=別 `chore(deps)` で `postcss` override `^8.5.12`・f664675 の deps-fix と同型。allow-list は patched 不在限定ゆえ不適)。

### 3. whole-branch 最終 review(SDD 終端)
base=`f664675` / head(review 時)=`5175fe6`。
- **canonical**(general-purpose subagent, opus, template `code-reviewer.md` 改変なし): **Ready to merge=Yes / Crit0 / Imp0**。6 不変条件保持・iOS scroll-lock leak resolved 確認・test discriminating。
- **Codex**(`--base origin/develop`・read-only・detector PASS): **P2×2**(openModal:①兄弟解決の開扉ブロック ②カード遷移中の stale open)。→ 記録 `docs/codex/2026-07-24-image-ux-whole-branch.md`。

### 4. P2 fix(`c2867a0`)+ 再 review(fix loop 収束)
両 P2 は実在(#2 は session-runner の gallery 再利用ゆえ reachable / #1 は spec §3.6「解決済みのみ」への実装逸脱)。CC 吸収:
- #1 = 兄弟を `peekAssetObjectURL`(objectUrlCache 済のみ同期返し)で集め非ブロック化・tap 画像のみ getAssetObjectURL(cache hit)。
- #2 = `latestCardRef`(useEffect で cardId 追従)を open 直前照合。
- red 検証済(両 fix neuter で新 2 test fail)。
- 再 review: **canonical(opus, focused)Crit0/Imp0/Minor3 + Codex(--uncommitted)Crit0/Imp0/Minor0** → 収束(未解決 Crit0/Imp0)。
- Minor(record・非 blocking): **M1** guard の sub-frame race(`useLayoutEffect` で更に閉じ得るが `'use client'` の SSR 警告回避に isomorphic wrapper 要=YAGNI・#1 fix で window は数 ms に収縮し表示のみの glitch ゆえ record)/ **M2** §3.6 準拠の未解決兄弟除外(仕様・非 bug)/ **M3** peek test の tautological assert(意図明示・据置)。

### 4b. CC stg smoke(Chrome/desktop)+ Z2 Escape fix(OT 指示で即 fix)

OT push(`origin/develop`=`9685967`)後、CC 分担の stg smoke を Playwright/desktop Chromium で完走。
実カード画像 + mirror 直注入(tall/short/fail)で検証、注入は全 cleanup(server 不変)。結果詳細 =
`docs/superpowers/sessions/2026-07-24-image-ux-smoke-checklist.md` §CC smoke 実施結果。

- **全 CC 項目 PASS**: deploy 反映 / F1 畳み発火(clip+フェード+ボタン・clientHeight px)/ F2 非畳み /
  モーダル open(3 経路)/ fill(aspect>2.0)/ G5 / G6 機能 / scroll-lock(position:fixed top:-scrollY)/
  Escape 閉+scroll/focus 復帰 / Z1 z-index(pswp 100000>dialog 45)/ Z3 focus 復帰 / R1 縮退 / R3 CSP /
  thumb 面不変 / a11y 名。**bonus**: back の route-change-during-open で scroll-lock leak せず(task6
  Critical fix の実地裏取り)。console 0 errors。
- **Z2 finding→fix**: side-peek 上で Escape が画像モーダル+side-peek 両方を閉じた。**OT 指示で Minor 受容せず
  即 fix**(desktop も table/side-peek の対象ゆえ)。fix `37dbfd8`[reviewed] + §3.4 amendment `d568a5b`:
  escKey:false + `window` capture で Escape 隔離(下層 radix へ伝播させずモーダルのみ close)、close/unmount で
  listener 除去、arrowKeys 素通し、init-throw 巻き戻し(Codex P2)。red 検証 3 点(stopPropagation /
  destroy-removal / init-throw catch を各 neuter で対応 test fail→復元 green)。review = canonical
  Ready/Crit0/Imp0 + Codex 2 周 Crit0/Imp0/Minor0(canonical Minor M1 test-hygiene cleanup / M2 radix spy
  capture 段 / M3 stale comment も反映)。gate lint0/tsc0/**full 3889**/build0。**push 後 CC 再 smoke 要**
  (side-peek Escape 隔離 / close 後 radix Escape 復活 / arrowKeys 不変)。

### commit range 更新(未 push)

origin/develop=`9685967`(OT push 済)。以降の未 push = `00f29d1`(CC smoke 結果 doc)/ `d568a5b`
(§3.4 amendment)/ `37dbfd8`(Z2 fix [reviewed])/ `4a8bdd2`(Codex 記録)/ 本締め doc。Z2 fix は OT が
まとめて push 予定(OT 指示)。

### 5. push 判断(OT へ)
- **コード完了**: task 1〜6 + P2 fix 全 [reviewed]。gate 5/6 exit 0(audit のみ無関係 postcss high)。whole-branch canonical Ready + Codex P2 全 resolved。→ **push 可**。
- **OT 判断 2 点**: ① audit postcss high の扱い(別 chore(deps) override 推奨 or 受容判断)② push タイミング。
- **push 後**: stg deploy → CC smoke(上記 CC 分担・F1 Chrome 先行)→ OT 実機 smoke(iOS acceptance)。**iOS 実機 smoke は別ステータス = OT acceptance**(結果を smoke checklist「結果」欄 + 本 doc に追記)。
