# Sprint T(MD 表 read-only 描画 + テーブルビュー サムネ)完了記録

- **日付**: 2026-07-17
- **spec**: `docs/superpowers/specs/2026-07-17-sprint-t-md-table-readonly-render-design.md`(確定・凍結)
- **plan**: `docs/superpowers/plans/2026-07-17-sprint-t-md-table-readonly-render.md`(OT 承認・確定)
- **実装方式**: CC inline TDD + read-only canonical(general-purpose subagent)+ Codex 独立レビュー(per-task)+ 末尾 whole-branch review(opus)
- **sprint base**: `0b43435` / **本体最終 HEAD**: `5d75414` → 追加バッチ・follow-up fix 込みの **Sprint T 最終 = `562de1f`**(develop・**origin へ push 済**=stg smoke 実施可能だった状態)
- **クローズ**: 2026-07-17(下記「Sprint T クローズ確定」参照)

## 成果

OCR が吐く MD パイプ表(`| a | b |`)を 4 面(カードビュー / テーブルビュー / side peek / 学習面)で read-only `<table>` 描画。保存形式 plain text・raw MD 編集 textarea は 1 バイトも変えず display 枝のみ。第 2 スコープ = テーブルビューへの画像サムネ配線(Sprint I 列挙漏れの補完)。

## task 別結果(全 feat [reviewed] / chore・test・docs [no-review])

| task | commit | 内容 | review |
|---|---|---|---|
| T1 | `7e151d2` [no-review] | dep 4 種 exact pin + de-risk | dedupe 単一・frozen/tc/build exit0 |
| T2 | `53413a1` [reviewed] | `segmentMdTables` pure 関数 | canonical Ready Crit0/Imp0/Minor2(fix)+ Codex clean |
| T3 | `e861fe0` [reviewed] | `MdTableText`/`MdTableSegments` + contract snapshot | canonical Ready Crit0/Imp0/Minor3 + Codex clean |
| T4 | `99da01b` [reviewed] | 編集面配線 A/B(golden-first) | canonical Ready Crit0/Imp0/Minor2 + Codex clean |
| T5 | `cad53d5` [reviewed] | 学習面配線 C/D/E + `MdTableBlock`(golden-first) | canonical Ready Crit0/Imp0 + Codex Imp1(adjudicated) |
| T6 | `b5691f0` [reviewed] | テーブルビュー サムネ配線 | canonical Ready with fixes Imp1(fix)+ Codex clean |
| (Minor) | `5d75414` [no-review] | whole-branch Minor 2 件(test 強化) | — |

Codex raw = `docs/codex/2026-07-17-sprint-t-t{2,3,4,5,6}-*.md`。plan cross-check = `docs/codex/2026-07-17-plan-sprint-t-md-table.md`。

## 完了 gate(実測・2026-07-17)

- `pnpm install --frozen-lockfile` → exit 0
- `pnpm typecheck` → exit 0
- **whole-repo `pnpm lint`(--max-warnings=0)→ exit 0 確認済**
- **`pnpm test`(full)→ 3722 passed / 0 failed**
- `pnpm build` → exit 0
- **bundle size(spec §5・推測なし実測)**: `.next/static` = T1 baseline **2.3M**(2304KB 台)→ 完了時 **2.56M**(2564KB)= **約 +260KB**。react-markdown + remark(parse/gfm)+ unified chain が exams / study route の client bundle に landing した分。spec が選んだ client-side display 描画の受容トレードオフ(whole-branch review 確認)。

## whole-branch review(opus・read-only・2026-07-17)

**判定 = Ready to merge / Critical 0 / Important 0 / Minor 3。** 不変条件 ①〜⑥ が per-task でなく横断で成立と独立確認:
- ① 表 0 個 = DOM 同一(全 5 site golden pin)/ ② 連結復元 = 入力一致(10 fixture)/ ③ 外部リクエスト 0(img/a 無効・rehype-raw なし・dangerouslySetInnerHTML なし)/ ④ root 直下のみ・C/E は p→div・span/button>table は React 実装上 warning なし / ⑤ dep exact pin 単一 dedupe / ⑥ サムネ slot=thumbnails・既存経路流用・uid gate。

Minor 3 件の扱い:
- **Minor#1(サロゲート test が over-claim)= fix 済(`5d75414`)**: 連結復元は「任意連続分割で常に真」ゆえ offset の code-point/UTF-16 差を検出しない指摘。**セグメント境界 assert** に強化(code-point offset なら table 値が先頭/末尾でズレ RED)。node probe で UTF-16=7→`| a | b |` / code-point=6→`\n| a | b `(≠TABLE_BLOCK)を確認。
- **Minor#2(D 選択肢解説 表 0 個 golden 欠)= fix 済(`5d75414`)**: judged phase の explanation 補間点を golden pin。
- **Minor#3(テーブルビュー サムネが削除可能)= OT ack 要(下記)**。

## T5 Codex P2 の adjudication(closeout)

Codex T5 が D の `span>table` / `button>table` nesting を P2 指摘。→ **spec §3.3 が明示受容 + OT §9 #2 承認済の設計判断**。canonical が `react-dom` の `findInvalidAncestorForTag`(`<table>` は `<p>` 祖先のみ判定)で **warning-free を実ソース確認** + nesting-warning spy 実証。button 構造替え = spec が blast radius 過大で却下 / span 剥がし = 不変条件①違反。→ **adjudicated-resolved(未解決 Important 0)・コード変更なし**。詳細 = `docs/codex/2026-07-17-sprint-t-t5-study-wiring.md`。

## stg smoke 結果(2026-07-17・OT 手動実施・全項目 PASS)

- **4 面すべて PASS**: カードビュー / side peek = 実カード A(`06f4e35f`)/ B(`2e97b7b7`)とも表描画。テーブルビュー = 表描画 + 画像サムネ OK・**表がコンテナ幅に引き伸ばされない**(width:auto 有効)。学習面 = 問題文 / 選択肢 text / 選択肢 explanation / カード解説の 4 箇所に表を入れた card で描画・**console warning なし**。
- **4 面同一扱いの裏取り**: 表が周囲の font-weight / color を継承(独立スタイル島でない)。
- **`<button>` / `<span>` 内 table nesting = 実機確認済(spec §3.3 を論証受容→実機確認済に格上げ)**: 選択肢 text + explanation 両方に表を入れた card で button 内 table 正常描画・warning なし・表を含む/含まない選択肢いずれもクリック選択可能(table がクリックを食わない)。
- **受容した吸収挙動の実地確認**: card B で表直後本文が表の行に吸収されるのを再現 → クリックで raw MD 確認 → 表直後に空行 1 個入れて blur → 正常な表に解消(所要 5 秒)。spec §2 の受容理由(視認可能・編集で直せる)が実物で裏取りされた。
- **不変条件① 実機**: PERF-SEED 300 枚(全表 0 個)をカード/テーブルビューでスクロール・見た目/行高とも違和感なし。
- **未実施(条件不発)**: Network 外部リクエスト 0(実カードに MD 画像記法なし → T3 unit test で証明済ゆえ実機省略)/ 長い連続語の列崩れ(実データに該当なし → T3 の td/th overflow-wrap:anywhere 構造 assert で足りると判断)。

## OT 判断・smoke 事項(push 前 / push 後)

**判断必要**:
1. **テーブルビュー サムネの削除可否(Minor#3)**: table 列のサムネは `readOnly` を渡さないため「画像を削除」ボタンが出る(spec §6 準拠 = 既存 `removeImageFromCard` 経路・add affordance のみ非表示)。削除は破壊的操作ゆえ、table 上でも削除を許す意図で正か OT 確認。

**stg smoke(push 後・CC が DevTools 実走 / spec §7)**:
- 実カード 2 件(A=`06f4e35f-…` 表末尾 / B=`2e97b7b7-…` 表直後本文吸収)× 4 面(カードビュー/テーブルビュー/side peek/学習面)で同一表が `<table>` 描画。
- **B の吸収 reflow を目視**: 表直後の非空行が表の行に吸収され、後続本文+選択肢が壊れた表として表示される(spec 凍結の GFM 挙動・視認可能な破綻ゆえ許容)。編集で空行 1 個入れれば直る。
- 表 0 個カードの見た目不変 / 編集クリックで raw MD textarea(不変)。
- **Network で画像記法カードから外部リクエスト 0 件**(不変条件③)。
- テーブルビューにサムネ表示 + **長い連続語入り表で列レイアウトが崩れない**(overflow-wrap:anywhere)。
- **学習面 button 内 table の実機**: console に hydration/nesting warning なし・表領域クリックで回答トグル機能。
- **行高観察(blocker でない)**: 表描画で行高変化。カードビュー仮想化 `ESTIMATED_CARD_HEIGHT=738` は measureElement が動的処理ゆえ観察のみ・todo Phase 4「可変行高 1000 件超 jitter」に接続。

## follow-up 台帳

- **OCR prompt 側課題(単独 task にしない)**: 「MD 表の直後に空行を吐かせる」で B 型の吸収を源流で消せる。画像切り出しの OCR チューニング時に同時対処(同一 file・同一変更源・検証 1 回)。
- **shared_context(`> ` 引用)内の表は非描画**(root 直下限定の帰結・実データに `> ` 付き表なし = 現状不要)。ノード起点描画に切替えれば可能(将来拡張候補)。
- **GFM 列 alignment(`|:---|`)非対応**(T3 canonical Minor)= th/td が align/style を捨てる。spec §3.5 対象外・実カード不使用。OCR が alignment 吐くなら scoped follow-up。
- **side peek の幅可変化(テーブルビュー)= 独立 sprint**(2026-07-17 OT)。Step 0 の核 = side peek がテーブルを押すのか被せるのか(押すなら列 reflow → 仮想化の再測が要る)。他論点 = 永続化の要否 / min-max / モバイルの扱い。
- **学習中のメモ編集 = 別途**(下記「追加バッチ」item4 の非スコープ)。誤答直後がメモを書く自然な瞬間だが変更源が別。
- **whitespace-only メモ / 解説の空 island**(whole-branch Minor)= `current.memo &&` / `explanationText ||` が `'   '` を truthy 扱いし空 island を出す。**解説と共通の既存挙動**(trim 未実施)ゆえ両面同時に直すべき follow-up。
- **in-flight attach + 同時 blank-text race**(whole-branch cross-cut)= file 選択直後・mirror commit 前に option text を空にすると cascade の fresh read が未書込 image を取りこぼし `option:<uid>` が孤児化しうる。**card view と同一機構の既存 best-effort 挙動**(mis-attach でなく storage リークのみ)。閉じるなら両面同時 = 画像 GC track。
- **⚠ テーブルビュー画像添付の実 attach smoke = 未実施のままクローズ(2026-07-17)**: item2(`d680526` で配線・`5a913a9` で DOM 行内化)の add 経路は、テーブルビューから **実際に 1 度も画像を添付していない**。unit は mock-call 検証のみで、**`meta.userId` が実行時 undefined でも test は通る**(署名付き URL の 403 は実 upload 時にしか出ない)。既存 `attachImageToCard`・card view と同一・prop 源不変を根拠に閉じたが、**この失敗モードは未検証で残る = 次に誰かがテーブルビューから画像を添付した瞬間に初めて表面化する**状態。閉じるなら 30 秒で足りる(テーブルビューで選択肢 1 件に 1 枚添付 → reload で残存確認)。

## 追加バッチ(2026-07-17 smoke PASS 後・OT 指示・同 branch)

smoke PASS を受けて OT が 4 件を追加指示(item1=docs / items 2-4=feat/fix。MD 表描画は smoke 済ゆえ再検証不要・**items 2-4 のみ push 後 smoke**)。range `9e190b6..545d28c`・feat/fix 3 全 [reviewed]。

- **item1(docs `9e190b6` [no-review])**: smoke 全PASS 記録 + spec §3.3 の nesting を「論証受容」→「実機確認済」格上げ + §3.6 add 訂正。
- **item2(add affordance・`d680526` [reviewed])**: T6 の「add 非配線」を覆し table 3 列 + 選択肢に card view と同じ compact add(既存 `attachImageToCard` 経路・独自経路なし)。→ Minor#3「delete-yes/add-no 非対称」も add 追加で解消。**canonical + Codex 両者が空 ghost 選択肢への添付で孤児化(P2/Imp)を検出 → card view と同じ `opt.text.trim().length > 0` gate で fix**(mutation で gate 除去→RED 実証)・Codex 再走 clean。
- **item3(選択保持・`fcb475c` [reviewed])**: 回答後も「自分が選んだ選択肢」を識別可能に。**2 軸**(正誤=emerald 背景 + ○/× / 選択=**sky ring + 「あなたの回答」badge**・判定前後一貫)。多択で選び逃し正解 / 選んだ誤答を区別。灰色化不採用。非色キュー(badge)で色覚非依存。retry/next/prev で reset。
- **item4(メモ表示・`5625f40` [reviewed])**: 回答後・非空時のみ・`MdTableBlock` 経由(6 番目の挿入点)・**amber の別スタイル島**(解説=blue と出自区別)・read-only。spec §1「メモ×4 面」の学習面空振りを埋める。
- **whole-branch review(opus・items 2-4)= Ready to merge Crit0/Imp0**。part2/3 の shared file(session-runner)は disjoint 領域で `isJudged` reveal gate のみ共有・4 色同時状態(emerald/sky/blue/amber)は各々非色キュー付きで曖昧なし。add gate は card view と同一・新規 mutation/network なし。Minor 1(コメント `MdTableText`→`MdTableBlock` 訂正・`545d28c` で fix)。
- **バッチ完了 gate**: full test **3742 passed**・tc0・whole-repo lint0・build0(dep 変更なし)。

### items 2-4 の stg smoke checklist(push 後・OT or CC DevTools)
1. **item2**: テーブルビュー 3 列 + 選択肢に add アイコン表示 → 押下で画像添付 → reload で復活。空 ghost 選択肢(+選択肢を追加 直後・未入力)には add が**出ない**。
2. **item3**: 回答後、自分が選んだ選択肢に sky ring + 「あなたの回答」badge。多択で「選んだ正解 vs 選び逃した正解」「選んだ誤答 vs 選ばなかった誤答」が判別可能。retry で消える。
3. **item4**: 回答後、メモがある card で amber の「メモ(あなたの記録)」island 表示(解説 blue と区別)。回答前・空メモでは非表示。メモ内 MD 表が `<table>` 描画。
4. **4 色同時状態の可読性**: 正誤(緑)+ 選択(sky)+ 解説(blue)+ メモ(amber)が同画面で混同しないか目視。

### items 2-4 stg smoke 実施結果(2026-07-17・CC DevTools=Playwright MCP・全 PASS)

**データ前提の相違(要 OT 認識)**: OT が指定した test1(komail9server+clerk_test)には **実カード A/B が存在せず**、PERF-SEED 300 枚のみ(explanation/memo/multi-correct すべて 0・MD 表 0)。stg 再 seed で A/B が消えたと推定。→ item2 と item3 単択は PERF-SEED でそのまま検証。item3 多択 / item4 メモ / 4 色同時は **card No.1(041ae8c1)を Dexie mirror にのみ注入**(outbox 非経由=server 無変更・reload で自動 revert、実際に revert 確認済)して検証。session-runner の描画経路をそのまま exercise するため注入は有効な smoke セットアップ。

- **item2 PASS**: テーブルビューで 3 列(問題文/解説/メモ)+ 選択肢すべてに add アイコン表示(可視 49 個)。画像 1 枚の card で thumbnail(img)+ 削除ボタン描画。**ghost gate**: 「+選択肢を追加」で空選択肢を足すと add アイコンは増えず(row の add 数 7→7)= 空 ghost に add 出ない。空選択肢は sanitize され未 persist(pending option mutation 0)。attach→R2 は既存 attachImageToCard 経路(card view と同一・unit mock-call 検証済)ゆえ stg 再アップロードは省略。証拠=smoke-item2-table-add.png。
- **item3 PASS**: 単択(PERF-SEED card 0030)= 選んだ誤答 × + sky ring + badge / 選ばなかった誤答 × のみ / 選び逃した正解 ○+emerald のみ(ring/badge なし)→ 判別可。**多択(注入 card No.1)= 選んだ正解 ○+emerald+ring+badge / 選び逃した正解 ○+emerald(ring/badge なし)→ 判別可**。retry で ring/badge/選択すべて消滅。FSRS モードで Again/Hard/Good/Easy 提示中も自分の回答(ring+badge)が可視(OT 指摘の欠陥が解消)。証拠=smoke-item3-prejudge.png / smoke-item3-postjudge.png。
- **item3 遷移観察(OT 追加項目)= 違和感なし**: 回答前の選択表示は既に **sky ring(ring-sky-500)**、回答後も **同一の sky ring**(badge が追加されるのみ)。色も形も連続で「別物に変わった/押し直された」印象なし。回答前後で選択チャネルは一貫。
- **item4 PASS**: 回答後のみ amber の「メモ(あなたの記録)」island 表示・メモ内 MD 表が `<table>` 描画。解説(blue「解説」island・MD 表描画)とは別 island で出自区別。**回答前(retry 後)は memo/explanation island とも非表示**(isJudged gate)。証拠=smoke-item3-4-multiselect-memo-4color.png。
- **4 色同時状態 PASS**: 1 画面に emerald(正解)+ sky(選択)+ blue(解説)+ amber(メモ)が同時に出るが各々明確に区別。**console error 0 / warning は Clerk dev-keys のみ**(validateDOMNesting 等なし)= 選択肢 button 内 table + 解説/メモ table 同時でも nesting warning なし(spec §3.3 の実機確認をさらに強い状態で再確認)。
- **副次確認**: 学習面の解説/メモの MD 表描画(本体 smoke 済の C/E)も注入 card で再確認 PASS。
- **クリーンアップ**: card No.1 は reload で原状復帰(correctCount 1 / memo null / explanation null)・server 無変更・自分由来の pending mutation 0 を確認。

## follow-up fix: add アイコン行内 co-locate(`5a913a9` [reviewed] / 2026-07-17)

items 2-4 smoke 後に判明した item2 の density 問題(選択肢列で add アイコンが独立行を取り、選択肢数ぶん行高が倍加)を修正。詳細・論拠 = `docs/superpowers/sessions/2026-07-17-table-add-icon-inline-fix.md`。canonical Ready(Minor1・意図的で code 変更不要)+ Codex clean。DOM 配置のみ移動で attach 経路(props / userId 源)は byte 一致で不変。

- **smoke(2026-07-17・OT 手動)= item1 PASS**: add アイコンが × の直隣にインライン収容・行高が増えていないことを実機目視で確認(多択でも同様)。thumbnails 余白も同視で問題なし。
- **item2(実 attach → reload)= 未実施のままクローズ**(上記 follow-up 台帳の ⚠ 項参照)。

## Sprint T クローズ確定(2026-07-17)

- **範囲**: base `0b43435` → 最終 `562de1f`(本体 T1-T6 + whole-branch Minor + 追加バッチ items 2-4 + follow-up fix 5a913a9 + 各 session/codex docs)。**origin へ push 済**。
- **review**: 全 feat/fix [reviewed]・whole-branch Ready to merge Crit0/Imp0(本体・items 2-4 とも)・Codex 各 clean(T5 P2 は adjudicated-resolved)。
- **gate**: full test 3742 passed(本 doc 記載時点)・typecheck 0・whole-repo lint 0・build 0。
- **smoke**: 本体 4 面 + items 2-4 + follow-up item1(アイコン配置)すべて PASS(stg・OT/CC)。
- **唯一の未検証**: テーブルビュー画像の**実 attach smoke**(mock では捕まらない runtime userId undefined 失敗モード)。意図的に未実施でクローズ、follow-up 台帳に申し送り。次にテーブルビューから添付した時に表面化する状態であることを明記済み。
- **残 OT 判断(blocker でない)**: テーブルビュー サムネの削除可否(Minor#3・上記「OT 判断・smoke 事項」#1)。

→ **Sprint T をクローズ**。次 Sprint は OT 判断待ち。
