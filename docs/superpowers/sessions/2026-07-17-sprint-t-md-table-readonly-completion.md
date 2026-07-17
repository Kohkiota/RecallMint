# Sprint T(MD 表 read-only 描画 + テーブルビュー サムネ)完了記録

- **日付**: 2026-07-17
- **spec**: `docs/superpowers/specs/2026-07-17-sprint-t-md-table-readonly-render-design.md`(確定・凍結)
- **plan**: `docs/superpowers/plans/2026-07-17-sprint-t-md-table-readonly-render.md`(OT 承認・確定)
- **実装方式**: CC inline TDD + read-only canonical(general-purpose subagent)+ Codex 独立レビュー(per-task)+ 末尾 whole-branch review(opus)
- **sprint base**: `0b43435` / **最終 HEAD**: `5d75414`(develop・未 push)

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
- **学習中のメモ編集 = 別途**(下記「追加バッチ 4」の非スコープ)。誤答直後がメモを書く自然な瞬間だが変更源が別。

## 追加バッチ(2026-07-17 smoke PASS 後・OT 指示・同 branch)

smoke PASS を受けて OT が同 branch で 3 件を追加指示(MD 表描画は smoke 済ゆえ再検証不要・items 2-4 のみ push 後 smoke):
- **B(add affordance)**: T6 の「add 非配線」を覆し table 列に add 配線(spec §3.6 訂正済)。→ Minor#3 の「delete-yes/add-no 非対称」も **add 追加で解消**(card view と対称)。
- **C(選択保持)**: 学習面で回答後に「自分が選んだ選択肢」を識別可能に(正誤=背景 / 選択=別チャネルの 2 軸・多択対応)。回答前から出している選択状態を回答時に捨てているのが欠陥。
- **D(メモ学習面表示)**: 回答後のみ・非空時のみ・MdTableText 経由(6 番目の挿入点)・解説と視覚区別・read-only。spec §1 の「メモ×4 面」が学習面で空振りしていたのを埋める。
