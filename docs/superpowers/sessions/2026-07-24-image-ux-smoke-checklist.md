# 画像表示 UX 改修 — 実機 smoke チェックリスト(OT acceptance)

- **対象 commit range**: `1076dd9..HEAD`(未 push・13 commit)。push→stg deploy 後に実施。
- **status**: task 6 のコードは `[reviewed]` 完了。本 smoke は**別ステータス = OT acceptance**。結果を本 doc の「結果」欄に記入し、`docs/superpowers/sessions/2026-07-24-image-display-ux-completion.md` に close 追記する。
- **stg URL**: `stg.recallmint.nekotest.net` の演習画面(スマート復習 / カスタム演習)。実カード画像のある deck を使う。seed に実画像が無い場合は mirror 直注入(`reference_stg` 参照)。
- **前提**: 旧コードを叩かないため **push→deploy 反映後**に実施(push 前 smoke は無意味)。

## 検証開始値(smoke で実測して詰める受け皿)

| 値 | 開始値 | 実測メモ(埋める)|
|---|---|---|
| capPx(畳み高さ上限)| `min(70svh, 44rem)` | |
| absMarginPx(px 下駄枝)| 48 | |
| ratio(比率枝)| 1.15 | |
| tile(複数画像タイル)| 128px | |
| aspect(モーダル長尺 fill 判定)| h/w > 2.0 | |

## 環境マトリクス(各項目の「環境」欄で参照)

- **P** = iOS Safari 縦(portrait)
- **L** = iOS Safari 横(landscape)
- **iPad** = iPadOS Safari
- **PWA** = ホーム画面追加版(standalone)
- **Chrome** = Android Chrome または desktop Chrome(cross-browser 確認用)
- **Zoom** = ページを pinch でズームインした状態(visual viewport < layout viewport)

---

## A. モーダル gesture(task 1 の 4 gesture + 補助)

実カード画像を演習 in-flow で tap してモーダルを起動してから操作する。

### G1 — pinch-to-close 無効
- **手順**: モーダルで画像をピンチ(拡大/縮小どちらも)。
- **期待(合否)**: ピンチは倍率変更のみ。**縮小しきってもモーダルは閉じない**(`pinchToClose:false`)。
- **環境**: P / L / iPad / PWA

### G2 — 下ドラッグ閉じ=初期倍率のみ / ズーム中は1本指パン
- **手順**: ① 初期倍率(fit)のまま画像を下方向へドラッグ → ② 一度拡大してから1本指でドラッグ。
- **期待(合否)**: ①=**閉じる**(`closeOnVerticalDrag:true`)。②=**閉じずに画像がパン(移動)する**。
- **環境**: P / L / iPad / PWA

### G3 — 長尺 'fill' の1本指縦パン(S2)
- **手順**: aspect h/w > 2.0 の**縦長**画像(縦スクショ等)を開く。1本指で上下ドラッグ。
- **期待(合否)**: 初期表示が**横幅fit**(画面幅いっぱい・上下は画面外)= fill。**1本指で自然に上下閲覧でき下端まで見られる**(pan を「縦スクロール」充足と認める・OT 承認済)。※通常 aspect ≤2.0 の画像は fit(全体が画面内)で開く。
- **環境**: P / L / iPad / PWA

### G4 — double-tap zoom
- **手順**: 画像を素早く2回タップ。もう一度 double-tap。
- **期待(合否)**: 1回目=タップ位置中心に拡大。2回目=初期倍率へ戻る(`doubleTapAction:'zoom'`)。
- **環境**: P / L / iPad / PWA

### G5(補助)— 画像シングルタップで閉じない
- **手順**: 画像を1本指でシングルタップ。
- **期待(合否)**: **閉じない**(`imageClickAction:'zoom'` = タップは拡大方向)。
- **環境**: P / iPad / PWA

### G6 — WCAG ズームボタン + 閉じるボタン(**機能=CC / 物理=OT に分割**)
- **手順**: 右上ツールバーの `+` / `−` / `↺` を押す。`×`(閉じる)を押す。
- **期待(合否・機能=CC・desktop)**: `+`=1.5倍ずつ拡大 / `−`=縮小 / `↺`=**現 slide の実数 initial** へリセット / min・max 到達で無反応(clamp)。aria: Zoom in / Zoom out / Reset zoom。
- **期待(合否・物理=OT・実機)**: 指で**押せる**(hit 領域 ≥44px = PhotoSwipe 既定ツールバー)/ chrome や画像に被らず届く。
- **環境**: Chrome(機能・CC)/ P(物理・OT)

---

## B. 畳み発火(S3・**must-pass**)

`capPx` の `clientHeight` 測定が実機で px を返すことの検証(旧 iOS Safari の `getComputedStyle().maxHeight` 式文字列バグ回避)。演習 in-flow の**単一画像** target で確認。

### F1 — 実 tall 画像で畳みが効く(**must-pass**)
- **手順**: 縦長の実画像を持つ問題文 / 選択肢 / 解説を演習で開く。
- **期待(合否)**: 画像が**clip**(上限 `min(70svh,44rem)`)+ **下端に白フェード** + 直下に **「拡大して全体を見る」ボタン**。**iOS Safari と Chrome の両方で出る**こと。ボタン or 画像 tap → モーダルで全体表示。
- **順序(確定)**: **CC が push 直後に Chrome(desktop)で先行確認 → 通過してから OT に iOS Safari 側を回す**。Chrome で落ちたら iOS を試す意味が無い(即報告・修正)。iOS 実機の往復を無駄にしない。
- **環境**: **Chrome(CC 先行)→ P(OT・must-pass 本丸=clientHeight px)** / L / iPad

### F2 — 短い画像は畳まない
- **手順**: 横長 or 短い画像(縦長でないもの)を演習で開く。
- **期待(合否)**: **clip されず全高表示**。フェード無し・「拡大して全体を見る」ボタン無し(fold=false の silent-clip 回避検証)。
- **環境**: P + Chrome / iPad

### F3(補助)— 複数画像 target はタイル
- **手順**: 同一 target(例: 解説)に2枚以上画像がある状態で演習を開く。
- **期待(合否)**: 128px タイルの折返し(flex-wrap)・**畳みなし**・各タイル tap→モーダル(target 内 swipe)。
- **環境**: P / iPad

---

## C. scroll-lock(fixed-body)

### L1 — ページズーム中に開いて背景非スクロール(**主再現**)
- **手順**: ページを pinch でズームイン(visual<layout viewport 状態)→ 画像 tap でモーダル起動 → モーダル背後を触ってスクロールを試みる。
- **期待(合否)**: **背景ページがスクロールしない**(`position:fixed` scroll-lock)。
- **環境**: P(Zoom)/ iPad(Zoom)/ PWA(Zoom)

### L2 — 閉じた後に scroll 位置 + focus 復帰
- **手順**: ページを下までスクロール → 画像 tap で開く → 閉じる。
- **期待(合否)**: **元の scroll 位置に戻る** + **focus が起動した画像ボタンへ復帰**(枠線が起動要素に戻る)。
- **環境**: P / L / iPad / PWA

### L3 — タップ位置がずれない
- **手順**: モーダルを開く/閉じるを繰り返し、閉じた後に別要素をタップ。
- **期待(合否)**: fixed-body 化の前後で**タップ座標がずれない**(押した所が反応する)。
- **環境**: P / iPad / PWA

### L4 — キーボード表示中に開く(**検証対象外・OT に積まない**)
- **判定**: **検証対象外**。画像 tap は通常 input を blur しソフトキーボードを閉じるため再現が構造的に不安定(Codex 指摘)。scroll-lock 要件は**主再現の L1(ページズーム中)が通れば満たせる**(visual<layout viewport の mismatch を L1 が確実に作る)ため、L4 は OT 実機項目から外す。参考として経路のみ記載。

> **注**: opening アニメ中の unmount による lock leak(ページ全面フリーズ)は `destroy()` + fallback unlock で解消済(コード保証・実機再現困難)。physical では観測のみ / skip 可。

---

## D. side-peek 上から開いた時(z-index / Escape / focus)

### Z1 — z-index
- **手順**: テーブルビュー等から side-peek(カード詳細)を開き、その中の画像を tap。
- **期待(合否)**: 画像モーダルが **side-peek より前面**に出る(重なり順が正しい)。
- **環境**: P / iPad / PWA

### Z2 — Escape が画像モーダルのみ閉じる
- **手順**: side-peek → 画像モーダルを開いた状態で Escape(iPad は外付けキーボード / desktop)。
- **期待(合否)**: **画像モーダルのみ閉じ、side-peek は開いたまま**(escKey は PhotoSwipe に限定・radix side-peek に伝播しない)。
- **環境**: iPad(外付けキー)/ Chrome

### Z3 — focus 復帰
- **手順**: side-peek 内で画像 tap→開く→閉じる。
- **期待(合否)**: focus が起動した画像ボタンへ復帰。side-peek の focus trap が壊れない。
- **環境**: iPad / Chrome

---

## E. back 挙動(**観測のみ・合否でなく記録**)

### B1 — iOS/Android back
- **手順**: モーダル表示中にブラウザ/システム back。
- **記録**: モーダルが**閉じる**か**ページ遷移**するか観測。PhotoSwipe は history 統合していない(spec で見送り)ため back でページ遷移し得る=**挙動を記録**(将来の history 統合判断材料)。
- **環境**: P / Chrome / PWA

---

## F. 縮退 / CSP

### R1 — cache miss / 低速 / 失敗の縮退
- **手順**: 低速回線 throttle または cache 未充填状態で演習を開く。画像取得を失敗させる。
- **期待(合否)**: 解決前=skeleton(pulse)。解決後=表示。**失敗=「画像を取得できません」+「再読み込み」ボタン**、その画像 tap でモーダルは**開かない**(空モーダル防止)。
- **環境**: P / Chrome

### R2 — 兄弟 decode 失敗の除外
- **手順**: 複数画像 target で一部画像を壊す/失敗させる。
- **期待(合否)**: 失敗画像だけモーダル集合から**除外**され、残りは表示・swipe できる。
- **環境**: Chrome(再現しやすい方で可)

### R3 — CSP 下でズーム UI/CSS 適用
- **手順**: モーダルを開き、ツールバー/ボタン/背景の描画と console を確認。
- **期待(合否)**: PhotoSwipe の CSS が**実際に適用**(ツールバー・ボタンが正しく描画)。**style-src / script-src violation が console に出ない**。
- **環境**: P / Chrome

---

## 確定 分担(CC / OT)— 2026-07-24 OT 確定

**CC 実施**(push→deploy 後・Playwright MCP・desktop Chromium。コード経路 + 非 iOS 固有挙動):
- **F1/F2 の Chrome 側**(**F1 は OT 実機の前に先行実施** — Chrome で落ちたら iOS を試さず即報告・修正)
- **Z1/Z2/Z3**(side-peek z-index / Escape 隔離 / focus 復帰)
- **R1/R2/R3**(縮退 + decode 除外 + CSP UI 適用)
- **G6 の機能面**(+/−/↺ が効く・clamp・reset 先が実 initial)
- **L1/B1 の desktop 部分**(desktop は visual<layout mismatch を作れないため**部分**・iOS 主再現は OT)

**OT 実機**(物理 iOS/iPad):
- **G1〜G5**(マルチタッチ gesture)
- **F1 の iOS Safari 側**(must-pass 本丸 = clientHeight が実機で px を返すか。CC の Chrome 通過後)
- **L1 主再現**(ページズーム中に開く)+ **L2**(閉じた後の scroll/focus 復帰)+ **L3**(タップ位置ずれ)
- **G6 の物理的な押しやすさ**(hit 44px・指で届く・chrome 非干渉)
- **B1**(実機 back)
- ※ **L4 は検証対象外**(上記理由・OT に積まない)

### 環境カバレッジ(OT 負担軽減・2026-07-24 OT 確定)

全項目を全環境で回さない。以下で足りる:

| 環境 | OT 実施項目 |
|---|---|
| iPhone Safari **縦** | 全 OT 項目を一通り |
| iPhone Safari **横** | F1 と L1 のみ |
| **iPad** | F1 と L1 のみ |
| **PWA standalone** | L1 のみ(scroll-lock は表示モードの影響を受けやすい)|

**CC 判定 = このカバレッジで不足なし**(理由):
- 反例になり得た唯一の候補は **G3(長尺 fill 1本指縦パン)の横向き**(landscape は viewport が横広・短で pan 域が最大化)。ただし ① fill 採否は **aspect(画像 h/w > 2.0)= 画像固有**で viewport 非依存 = landscape でも fill/fit の判定は変わらず pan 域が広がるだけ ② 「1本指で長尺を上下閲覧」の要件本体は**縦の G3 で検証済**になる ③ pan は PhotoSwipe library-internal の実績挙動 — ゆえ landscape 追加の増分リスクは低く、**追加しない**。
- safe-area は **S1 revert 済**(cover 撤去 = モーダルは safe viewport 内に留まりツールバー/閉じるボタンが notch 下に潜らない)ため、landscape の右 notch / PWA の chrome 変化による**モーダル chrome 被り regression は構造的に発生しない** = 横 / PWA を F1・L1 に絞れる根拠。
- F1 の must-pass 本質は **WebKit の clientHeight-px** = engine 特性で browser-chrome 非依存ゆえ、iPhone 縦 + 横 + iPad で十分(PWA は同一 WebKit ゆえ F1 冗長 = L1 のみで妥当)。

---

## 結果(smoke 実施後に記入)

環境カバレッジ確定を反映(● = 実施対象 / — = 対象外)。iPhone 縦(P)= 全 OT 項目、横(L)/ iPad = F1・L1 のみ、PWA = L1 のみ、Chrome = CC 分。

| 項目 | P(縦)| L(横)| iPad | PWA | Chrome | 担当 | 備考 |
|---|---|---|---|---|---|---|---|
| G1 pinch-close 無効 | ● | — | — | — | — | OT | |
| G2 下ドラッグ/パン | ● | — | — | — | — | OT | |
| G3 fill 縦パン(S2)| ● | — | — | — | — | OT | landscape は増分低リスクで非追加(理由=分担節)|
| G4 double-tap | ● | — | — | — | — | OT | |
| G5 single-tap 非 close | ● | — | — | — | — | OT | |
| G6 機能 | — | — | — | — | ● | CC | +/−/↺ clamp・reset=実 initial |
| G6 物理(押しやすさ)| ● | — | — | — | — | OT | hit 44px・chrome 非干渉 |
| **F1 畳み発火(must)** | ● | ● | ● | — | ● | **CC 先行→OT** | Chrome 通過後に iOS |
| F2 短い画像 非畳み | ○ | — | — | — | ● | CC | OT が F1 時に同画面で目視可(任意)|
| F3 複数タイル | ○ | — | — | — | ● | CC | |
| **L1 背景非スクロール(main)** | ● | ● | ● | ● | △ | **OT 主 + CC 部分** | CC desktop は部分(mismatch 不可)|
| L2 scroll/focus 復帰 | ● | — | — | — | — | OT | |
| L3 タップ位置 | ● | — | — | — | — | OT | |
| ~~L4 キーボード~~ | — | — | — | — | — | — | **検証対象外**(再現困難・L1 で充足)|
| Z1 z-index | — | — | — | — | ● | CC | |
| Z2 Escape 隔離 | — | — | — | — | ● | CC | |
| Z3 focus 復帰 | — | — | — | — | ● | CC | |
| B1 back(観測)| ● | — | — | — | △ | OT + CC 部分 | CC desktop は観測のみ |
| R1 縮退 | — | — | — | — | ● | CC | |
| R2 decode 除外 | — | — | — | — | ● | CC | |
| R3 CSP UI 適用 | — | — | — | — | ● | CC | |

(記入: PASS / FAIL / N/A / 再現せず。○=任意・△=部分)

---

## CC smoke 実施結果(2026-07-24・Chrome / desktop・Playwright MCP)

stg `f664675..9685967` 反映後に実走。実カード画像(`a0fc6177` 1280×1178)+ mirror 直注入
(tall 400×1600 / short 900×180 / fail=cache blob 無)で検証。注入は全て cleanup 済(mirror を
server-backed 状態へ復元・server は outbox 非経由ゆえ不変)。console 0 errors(唯一の warning =
Clerk dev-keys=stg 既知)。

| 項目 | 結果 | 根拠 |
|---|---|---|
| deploy 反映 | **PASS** | 演習 in-flow が 64px サムネ→大きめ表示+畳みに変化(新コード live) |
| **F1 畳み発火** | **PASS** | 実画像(1178px)+ tall注入 とも clip+下端フェード+「拡大して全体を見る」= clientHeight が px を返す(§S3 の Chrome 側) |
| F2 短い画像 非畳み | **PASS** | short 900×180 = 全高表示・フェード/ボタン無(silent-clip なし) |
| モーダル open(tap→zoom)| **PASS** | 畳みボタン / 画像 tap / thumb tap の 3 経路とも起動 |
| モーダル fill(aspect>2.0)| **PASS** | tall(4.0)= 横幅fit+縦スクロール(initialZoomLevel='fill') |
| G5 画像 click 非 close | **PASS** | 画像クリック後も pswpOpen=true(imageClickAction:'zoom') |
| G6 機能 | **PASS** | +/−/↺=Zoom in/out/Reset zoom・+で拡大・↺で transform none(initial 復帰) |
| scroll-lock 機構 | **PASS** | body position:fixed / top:-400px(scrollY 退避)|
| close→scroll/focus 復帰 | **PASS** | 閉→position:static・scrollY 400 復帰・focus=起動 button |
| Z1 z-index | **PASS** | pswp z=100000 > side-peek dialog z=45・中心の topmost=pswp__img |
| **Z2 Escape 隔離** | **FINDING(Minor)** | ×ボタン=画像モーダルのみ閉じ side-peek 継続(正)。**Escape=画像モーダル+side-peek の両方が閉じる**(radix side-peek の document Escape も発火)。下記参照 |
| Z3 focus 復帰 | **PASS** | ×閉→focus=side-peek 内の画像 button(activeInsideDialog=true) |
| R1 縮退 | **PASS** | 解決不可→「画像を取得できません」+「再読み込み」・tap 不可(空モーダル防止)|
| R3 CSP | **PASS** | ズーム UI/CSS 適用・style/script violation 0 |
| B1 back(観測)| **記録** | back=ページ遷移(history 非統合=仕様どおり)。**route-change-during-open で scroll-lock leak せず**(position:static・task6 Critical fix の実地確認)|
| thumb 面不変 | **PASS** | テーブル 64px サムネ + 画像を拡大(tap→modal)+ × 削除 |
| a11y 名 | **PASS** | alt 基「smoke tallを拡大」/「拡大して全体を見る」|

**CC 未実施(OT iOS or unit 担保)**: G1〜G4 touch gesture / F1 の iOS Safari 側 / L1 主再現
(ページズーム中=visual<layout・desktop で作れず=機構は position:fixed で確認済)/ R2 兄弟 decode
除外・P2 fix #1/#2(timing 依存=unit red 検証済)。

### FINDING(Minor)— side-peek 上で Escape が両方閉じる

- **現象**: side-peek(radix Dialog `modal={false}`)から画像モーダルを開き **Escape** を押すと、画像モーダルだけでなく **side-peek も閉じる**。× 閉じるボタンは正しく画像モーダルのみ閉じ side-peek は残る(focus も side-peek 内へ復帰)。
- **原因**: PhotoSwipe は radix の DismissableLayer stack 外の独立 overlay ゆえ、Escape が PhotoSwipe の escKey と radix side-peek の document 級 Escape の**両方**に届く。
- **影響 = Minor**: ① 一次閉じ affordance(×)は正常 ② touch/iOS は Escape 無し(本 sprint の主対象=モバイルは無関係)③ データ影響なし。checklist Z2 の期待(Escape は画像モーダルのみ)からの逸脱だが desktop キーボード限定の edge。
- **follow-up 案**: useImageZoom で open 中に capture-phase keydown で Escape の伝播を下層 radix に届く前に止める(PhotoSwipe には処理させる)/ または escKey を切り自前 Escape で stopPropagation+close。**push 済ゆえ別 commit の follow-up 判断は OT**(Minor=記録可)。
