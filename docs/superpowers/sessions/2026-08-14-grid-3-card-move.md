# Grid-3 — カードの試験間移動(card_move op + UI 4 入口 + 試験名 inline 編集 + undo)実装 session(2026-08-14)

- spec: `docs/superpowers/specs/2026-08-14-grid-3-card-move-design.md`(確定・凍結)
- plan: `docs/superpowers/plans/2026-08-14-grid-3-card-move.md`(r2 = Codex cross-check 反映済)
- commit range: `117f728..cceabb7`(docs 3 / feat 8)/ 67 file・+11,519 −84
- 状態: **クローズ済み**(2026-08-15)。stg migration 0038 適用 → push → stg smoke **12/12 PASS**(§10)→ **prod 反映済み**(OT)→ `main` へ ff-merge。
- 実装方式: `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)

## 1. 完了 gate(全 exit 0)

| gate | 結果 |
|---|---|
| `pnpm lint`(whole-repo `--max-warnings=0`)| **exit 0 確認済** |
| `pnpm typecheck` | exit 0 |
| `pnpm build`(postbuild の pdfium wasm packaging 検証込み)| exit 0 / PASS |
| `pnpm test` | **4997 passed (289 files)** |
| `pnpm test:iso` | **green 確認済 — 440 passed (38 files)** |
| `pnpm run audit` | **exit 0 確認済**(prod high/critical 0)|

依存 / Next 設定 file は不触のため `--frozen-lockfile` 系の追加 gate は対象外。

## 2. task 別の結果

| task | commit | review |
|---|---|---|
| 1. 移動計画の pure 関数(+47 unit)| `0a1fda6` | canonical Crit0/Imp1/Minor4 + Codex Crit0/Imp1 → fix 1 round |
| 2. migration 0038 + card_move wire/apply/registry | `f074249` | canonical Crit0/Imp0/Minor5 + Codex Crit0/Imp0(Minor 実質 4 件のみ修正)|
| 3. getCardsForSourceDocument の順序再裁定 | `c920c17` | canonical Crit0/Imp0/Minor0 + Codex Crit0/Imp0(**一発収束**)|
| 4. 試験名 rename レーン(action + inline edit)| `b5f61bc` | canonical Crit0/Imp2/Minor7 + Codex Crit0/Imp1 → fix 2 round |
| 5. 移動 hook + undo + toast 基盤 | `cb4561c` | canonical Crit0/Imp2/Minor3 + Codex Crit0/Imp2 →(Codex 再走で **P1**)→ fix 2 round |
| 6. 一括バー「移動」+ 切り出し | `a9a46c4` | canonical Crit0/Imp1/Minor6 + Codex 4 round(P1 1 / P2 2)→ **fix 4 round** |
| 7. 行メニュー「ここに取り込む」 | `650d752` | canonical Crit0/Imp1/Minor6 + Codex Crit0/Imp2 → fix 1 round |
| 8. 試験一覧「結合」 | `cceabb7` | canonical Crit0/Imp0/Minor6 + Codex Crit0/Imp1 → fix 1 round |
| 9. 完了 gate + 本 doc | — | `[no-review]` |

review は全 task で canonical(superpowers:requesting-code-review 既定経路・general-purpose subagent)+ Codex(`scripts/ai/codex-review.sh`)の 2 系統。**全 task で未解決 Critical 0 / Important 0 に収束**。

## 3. 実装した契約(spec からの実装点)

- **wire**: `entity_type='card_move'` / `op='move'` / `entity_id` = op instance uuid / patch = `{ exam_id, cards: [{id, base_order}] }`(1..10,000・card id 重複拒否・base_order 重複許容)。migration 0038 は CHECK 2 本の拡張のみ。
- **apply**(`lib/cards/apply-card-move.ts`): 移動先 exam の owner 検証 → 対象 card の owner-scoped 突合(不在は skip)→ `UPDATE ... FROM (VALUES)` の 1 statement で `exam_id` / `base_order` / `updated_at` のみ SET → 件数 log(skip>0 は warn)。`cascadeLike: true`。
- **client**(`use-move-cards.ts`): 単一 source exam の runtime assert / mirror 不在 id の除外 / 移動先 exam の mirror 事前検査 / 重複 id 正規化 / 1 mutation 発行 / undo は originals の絶対値復元。
- **UI 4 入口**: 一括バー「移動」+ 切り出し / 行メニュー「ここに取り込む」/ 試験一覧「結合」。gating は「指定カードの直後」のみ無効化。
- **rename レーン**: exams は outbox に載せない既存不変条件を維持し server action で実装。

## 4. plan からの逸脱(2 件・いずれも known-good)

1. **`use-move-cards.ts` の配置**: spec §8 の列挙は `[id]/_hooks/` だが **`app/(app)/app/exams/_hooks/`** に置いた(Task 8 の試験一覧「結合」と共有するため)。plan r2 で明示訂正済み。設計不変。
2. **Task 4 の `nameSchema` 移設**: `'use server'` file は非 async export ができないため `lib/exams/exam-name.ts` を新設して共有した。`createExam` の挙動・文言は不変。

## 5. 裁定(Rulings)— 本 session で CC が決めたこと

### 5.1 OT 指示に基づく維持(不採用 3 件)

- **10,000 件超の client 側事前拒否をしない**(Codex が 3 回指摘)— spec §11 が OT 承認済みで受容 + 再訪トリガーを明記。
- **base_order の overflow 防御を書かない**(Codex 指摘)— Order-1 spec §2.2 が「loud fail 許容・防御コード禁止」で凍結。
- **undo を CAS 化しない**(Codex plan cross-check の最重要指摘)— kickoff 決定 6 + spec §2.5/§5.4。

### 5.2 設計上の裁定

- **Task 4 `revalidatePath('/app/upload')` は scope creep でない** — upload page が exam 名を server render しており sibling action も同一行を持つ(canonical も同判断)。
- **Task 5 の undo 検証を「undo patch に載る card」に限定するのは正しい** — canonical が具体例で実証(broad だと未移動の常駐が削除されただけで偽理由の拒否になる)。
- **Task 5 の移動先 exam 検査は追加する** — spec §11 の受容は「真の並走削除」の残余リスクであり、hook に検査が無いこと自体は別問題。窓を狭めるだけで凍結契約は変えない。
- **Task 6 の切り出しは pull outcome でなく mirror の実在を待つ** — `runGuardedPull` の skip は**通常経路**(楽観 mutation の flush → pullBack が inflight-skip 窓を作る)であり、即時 retry は同じ skip を返す。150ms × 最大 10 回の上限付き待機に変更。
- **Task 6 の作成済み exam id は ref 保持し、pull が `'ran'` でも不在なら破棄** — orphan「無題の試験」の累積を session 1 個に抑えつつ、削除済み exam への恒久 resume を防ぐ。
- **Task 8 の行またぎ同時結合はガードしない** — 各 merge は独立 tx + 独立 envelope で lost update なし。影響は base_order 交錯のみで id tiebreak が吸収(spec §11 受容範囲)。
- **Task 7 の `setMenuOpen(false)`(未検出変異)は残す** — canonical が機構を実測し「削除すると menu 開閉が Radix の focus-out ヒューリスティック全依存になる」と結論。死んだコードではない。

### 5.3 実行機構(SDD skill と CLAUDE.md の衝突)

- **implementer は commit しない**(working tree で返す)— CLAUDE.md の「review pass → commit の一方向」が SDD skill の手順に優先。controller が review pass 後に `[reviewed]` で commit した。
- **canonical と Codex を並列起動した** — 当時の CLAUDE.md の字面は「canonical pass 後に Codex」の逐次だった。規律の目的(anchor 防止・独立性)は並列で更に強く満たされ、コストは canonical が落ちる場合の Codex 実行が無駄になる点のみ。→ **2026-08-15 OT 裁定で「並列許容」が確定し、CLAUDE.md §Codex 協調レビューの文面を更新済み**(commit `5d045d4`)。

## 6. 教訓(次に同種の作業をする人へ)

1. **React state は同期ガードにならない。** Task 4 / 6 / 8 で同一 class の欠陥が 3 回出た — `setPending(true)` は**スケジュールされるだけ**なので、再 render 前に届いた 2 発目のイベントが素通りする。防ぐには**最初の `await` より前に ref を立てる**。さらに **`act()` に包んだ `fireEvent` の連打ではこの窓を再現できない**(act が再 render を flush してしまう)ため、pin には「同一 tick に 2 発 dispatch」または「promise 解決後に act を挟まず microtask drain → イベント」という probe が要る。
2. **「動く」と書く前に実測する。** Task 4 の report は race 窓を「jsdom では再現できない」と書いたが偽(2 reviewer が独立再現)。Task 7 の focus 復帰も「ConfirmDialog の既定に乗る」と書いていたが実際は `document.body` に落ちていた(mount 時に記録した要素が同 commit で unmount される)。**test が見ていない領域についての主張は、変異検証をすり抜ける**。
3. **前提が変わると隣の task の正しさが崩れる。** Task 5 で移動先 exam の mirror 検査を足した結果、Task 6 の切り出し(「pull outcome に依存しない」と設計していた)が**依存するようになった**。cross-task の相互作用は pre-flight scan では見えず、実装後の review で初めて出た。
4. **skip される pull を即座に引き直しても意味がない。** Web Lock を別 pull が握っているのが skip の理由なので、間を置かない retry は同じ skip を返す。**outcome ではなく前提(mirror に行が現れたか)を上限付きで待つ**のが正しい形。
5. **Codex は round ごとに別個の実在バグを出した**(Task 6: P1 移動先未検査 → P2 retry 無効 → P2 二重発火)。振動ではなく漸進的な深掘りであり、4 round 目まで回す価値があった。canonical と Codex は**検出する層が違う**(canonical = test の検出力・保証の正確さ / Codex = 実装の抜け・UI 退行)。

## 7. 行 DnD への handoff(次 sprint)

1. **DnD は `card_move` op をそのまま消費する**(exam_id = 現 exam の絶対値割当)。新チャネルは不要 — spec §2.4 で先取り確定済み。
2. **順序計算は `planMoveAssignments`(`lib/cards/domain/card-order.ts`)を再利用**する。`{kind:'after', anchorId}` が DnD の drop 位置にそのまま対応する。
3. **gating の条件と理由文言は既存を再利用**(`sorting.length > 0 || columnFilters.length > 0` のとき位置指定を無効化)。DnD も同じ条件で無効化すべき。
4. **同期 ref ガードを最初から入れる**(上記教訓 1)。drag 終了イベントの二重発火は click より起きやすい。
5. **残余リスク 2 件**(spec §11)は未解決のまま: ① 移動先 exam の並走削除時の mirror 乖離 ② patch 10,000 件超。claude.ai todo に起票済み。

## 8. 反映の記録(完了)

1. stg へ migration 0038 適用(migrate 先行 → deploy)→ push → stg deploy。
2. CC smoke 12 項目を実施 → **全 PASS**(§10)。⑪ の 1000 枚級は OT が `scripts/seed-perf-exam.ts --cards=1200 --with-answers` を stg で実行して素材を用意。⑫-3 の offline 切替は OT 実機(Playwright MCP に offline API が無いため)。
3. **prod 反映済み**(OT。migration → deploy の順)。
4. `main` へ ff-merge(merge commit なし)。

**次 sprint = 行 DnD**(§7 の handoff を参照)。

---

## 10. stg smoke 結果(2026-08-15・全 12 項目 PASS)

前提: migration 0038 適用済み(CHECK 2 本に `card_move` / `move`)+ deploy 反映済みを DB / UI で確認してから開始。test user = `66fb6d00-526f-4264-9691-e2e036c656f7`。

| 項目 | 結果 | 実測値 |
|---|---|---|
| ① 同一 exam 内移動 | PASS | 2 枚を「05」直後へ → **5461 / 5802**(A=5120, B=6144, k=2 → step=floor(1024/3)=341 と一致)。相対順保持 |
| ② 試験間移動 | PASS | 末尾: 空 exam へ 1024 / 2048。先頭: A=0 仮想下界 → **512** |
| ③ 切り出し | PASS | 「無題の試験」自動作成 + 移動(1024)。自動遷移なし |
| ④ 行メニュー取り込み | PASS | 別 exam から「05」直後へ → **5461**(A=5120, B=5802, k=1 → step=341) |
| ⑤ 結合 | PASS | 8874 / 9898(M=7850 + 1024/2048)。**元 exam は 0 件で残存**。0 件行は disabled |
| ⑥ undo | PASS | 基本 = 絶対値で復元。**再採番ケース** = 1202 枚の同一 exam 内移動で終端規則が発火(全 1203 枚が 1024 の倍数へ)→ undo で**全 1207 枚が完全復元(差分 0)**。再採番された常駐(anchor)も復元 = spec §5.4 の反例を実証 |
| ⑦ 不変条件 | PASS | 7 回の移動を通して FSRS 全列・本文・画像・content_version・source_document_id・answer_events が **bit 単位で不変**。card_tags も baseline 行の喪失ゼロ |
| ⑧ ソート gating | PASS | 「直後」のみ disabled + 理由表示。**判別テスト**: 降順ソートで表示順と基準順が逆転する 2 枚 → **基準順で着地**(6826 → 7850) |
| ⑨ 改名 → pull 反映 | PASS | inline 改名 → DB 反映 → reload 後も新名 |
| ⑩ 回帰 | PASS | pull 6 cursor 200 / bulk 200 / **console error 0** / outbox 23 件すべて synced |
| ⑪ 1000 枚級 | PASS | **1200 枚を 1 mutation・payload 79.6KB・往復 455ms**。採番 4096 → **1,231,872**、逆転/重複 0、タグ 6612 行不変 |
| ⑫ 失敗系 | PASS | ① 連続 move で toast は常に 1 個(最新に置換)② 削除済みカードの undo = 理由表示 + mutation 未発行 ③ **offline → online 再送**(下記)|

### ⑫-3 offline 再送の実測(OT 実機・DevTools)

観測順: **bulk ERR ×2 → bulk 401 → tokens 200 → bulk 200 → pull 200**(リロードなし・自動再送のみ)。

DB 側の決定的証拠:
- 当該 mutation の **`edited_at` = 00:18:23.987(offline 時の操作)/ `applied_at` = 00:21:33.819(復帰後の適用)= 約 3 分 10 秒の差**。offline 中は outbox に滞留し、復帰で再送・適用されたことを時刻差が示す。
- カード「問5」が `090550a7:5120` → `c676e09d:**1232896**`(= 移動先 max 1,231,872 + 1024 と一致)。exam 件数も 4→3 / 1203→1204。

**副次的な収穫**: 復帰直後の 1 回目 bulk が **401 → token 再取得 → 再送で 200** という経路を通っており、**offline 中の session token 失効からの回復が data loss なしで機能する**ことが実測できた(この経路は unit / iso では踏めない)。

### smoke で判明した非自明事項

- **1200 枚の移動が 1 リクエスト 1 tx で 455ms**。`UPDATE ... FROM (VALUES)` の一括適用は分割不要と確認(plan の per-card loop 排除の判断が実測で裏付けられた)。
- **トーストの 15 秒 auto-dismiss は DB readback と競合する**。undo を検証する smoke では「移動 → 即 undo → その後に readback」の順にしないと窓を逃す(今回 2 回逃した)。
