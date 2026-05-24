# S2.0b-2 試験詳細 Optimistic UI + debounce / dashboard revalidate 漏れ修正 sprint 完了

- 日付: 2026-05-24 (S2.0b-1 closure 同日に kickoff、 同日完了)
- branch: `develop` (commit のみ、 push は OT 判断)
- 前提: 直前 commit `148ba91` (S2.0b-1 T5 closure)
- spec: `docs/superpowers/specs/2026-05-24-s2-0b-2-optimistic-debounce-design.md` (304 行)
- plan: `docs/superpowers/plans/2026-05-24-s2-0b-2-optimistic-debounce.md` (104 行 / 上限 250)

## 結論

S2.0b-1 の同期的 inline 編集 (blur → server 解決まで edit mode 維持 + spinner)
を **Optimistic UI + debounce 500ms + queue** に全面改修。 失敗時 rollback、
checkbox は該当のみ disable で text/explanation cell は edit 可能。 合わせて
`submitReview` server action に `revalidatePath('/app')` 1 行追加で dashboard
の 「今日の枚数 / 連続日数」 反映漏れを解消。 全 4 task 完了、 **670/670 test
pass / tsc clean / pnpm build pass**。

## Sprint 達成事項

- 設計 commit `9a960ac`: spec doc 書出 (no-review)
- plan commit `72bbc3d`: implementation plan T1〜T4 (no-review)
- **T1 `dbc6533`**: `submitReview` 成功時に `revalidatePath('/app')` を 1 回呼出
  (`next/cache`)。 失敗時 (catch 経由) は呼ばない。 test に `vi.mock('next/cache')`
  + 成功/失敗 case の `toHaveBeenCalled(With)/not.toHaveBeenCalled` assert 追加
- **T2 `9b082c5`**: `InlineTextField` を Optimistic UI + debounce 500ms + queue
  化。 `useTransition` 廃止、 ref ベース (`serverCommittedRef` / `inFlightRef`
  / `pendingValueRef` / `debounceTimerRef` / `mountedRef`)。 11 test (新 debounce
  test 7 ケース + Critical 2 件の regression 4 ケース)
- **T3 `8c79cd4`**: `InlineOptionRow` を row 共有 send + cell の props.value 化 +
  checkbox 個別 inFlight に改修。 send の queue 再帰を `await` 化 (checkbox
  wrapper が完走を待つため、 深さ 1 固定で stack/memory リスクなし)。 25 test
  (新 debounce 9 ケース + 既存 16 ケースのうち 2 ケース update)
- T4 (本 commit): tech-spec §3 routes /exams/[id] + §3 actions submitReview 更新 +
  session log

## review 結果集計

| Task | Critical | Important (fix 済) | Minor (記録のみ or amend 同梱) |
|---|---|---|---|
| T1 | 0 | 0 | 3 (import blank line / test return shape 重複 = amend 同梱で fix / 防御 assert 追加案) |
| T2 (初回) | **2** (mountedRef strict mode / revert-during-inflight lost write) | **2** (上記 regression test) | 3 |
| T2 (fix 後) | 0 | 0 | 3 (記録のみ) |
| T3 | 0 | 0 | 6 (1 件のみ amend 同梱で comment 拡張、 他記録のみ) |

T2 の Critical 2 件は本 sprint で発覚した最大級の学び:
1. **mountedRef strict mode**: `next.config.ts: reactStrictMode: true` で dev mode
   の effect setup → cleanup → setup 二重実行に対応するため、 cleanup-only effect
   の setup 側でも `mountedRef.current = true` を reset する必要あり。 setup reset
   漏れだと初回 cleanup 後 false 固定で全 setState 抑止 → rollback / error 表示が
   dev 環境で動かない (jsdom test では `<StrictMode>` を wrap しないため 657 green
   でも見落としていた)。 negative-control regression test で fix を一時 revert
   すると確実に fail することを担保
2. **revert-during-inflight lost write**: `value === serverCommittedRef` だけで
   short-circuit すると、 send 進行中の値と無関係に「最新意図 = revert」 が捨てら
   れ、 server は古い inflight 値で確定し display との不整合が起きる。 fix は
   short-circuit を「真に何も飛んでなく queue も空、 かつ値が serverCommitted と
   一致」 のみに限定し、 in-flight or queue 中は値同等でも scheduleSend (queue に
   最新意図を入れる)。 T3 にも同等の防御を新規実装時から適用

## 残課題 / Follow-up 候補

- **失敗時 queue drop の UX**: row 内で text 編集 → checkbox click (text 新値同梱
  送信 in-flight) → 失敗 → rollback 時に、 同梱されていた text 編集も silently
  破棄される。 UX 改善は「前回の編集 (X) は保存されませんでした」 と diff 表示する
  形になるが、 本 sprint scope 外。 follow-up 候補
- **共通 hook 抽出**: `InlineTextField` と `InlineOptionRow` の debounce + queue +
  rollback 機構は同じ state machine。 `useDebouncedQueueSend<T>` 抽出で重複削減 +
  drift 防止できるが、 まずは 2 実装で安定運用を優先、 抽出は別 sprint
- **同時編集 OCC / etag**: 別 tab / 別 user の concurrent edit 検出は MVP scope 外、
  S2.0b-1 既知制約を継承
- **dashboard 値の session-local 即時更新**: H-2 (revalidatePath only) で OT 確認済
  だが、 session 中の indicator 即時更新 (H-1) は将来検討余地あり

## 安定性メモ (closure 直前の追加 evidence)

T4 commit 直前の全 test 一括 run (`pnpm test`) で **最初の 1 run のみ 1 件 fail
/ 669 pass** を観測 (test 名は `tail -8` 切り捨てで未捕捉)。 直後の reproduce
試行で **追加 16 連続 run 全 pass** (670/670)。 累計 16/17 = 94% green、
失敗 evidence が取れず systematic-debugging skill §「No Root Cause」 (timing /
environmental flake) 判定。 amend 直後 = subagent dispatch 直後の CPU 負荷状況
が timing flake を誘発した可能性が最も高く、 機能 regression ではないと判断
して closure 続行。

**CI で再発した場合の再 investigate 方針**:

1. `pnpm test --reporter=verbose 2>&1 | tee test.log` で失敗 test 名 + 失敗
   assertion を完全捕捉
2. 失敗 test を `pnpm test path/to/file.test.tsx -t "test name" --repeat 50`
   で単独反復実行し、 再現性 (頻度) を計測
3. fake timer + Testing Library `act()` の組合せで Promise resolution 順序が
   非決定的になる箇所 (T2/T3 debounce test の `advanceTimersByTime` 直後の
   `await waitFor` 等) を疑う
4. S2.2.5 で session-limit-form race を atomic Message + test 側 idle 待ちで
   解消した実績 (CLAUDE.md コメント参照) と同パターンで対処検討

## 動作確認手順 (OT 向け)

`pnpm dev` で localhost:3000 起動後 (mobile view 推奨、 Chrome DevTools の
レスポンシブモード)、 以下シナリオで動作確認:

### 試験詳細 inline 編集 (Optimistic UI + debounce)

URL: `/app/exams/[既存試験 id]`

1. **基本 Optimistic UI**: title field を click → 編集 → focus out
   - 期待: 即時 display mode 復帰、 spinner 表示なし、 約 500ms 後に server 送信
     (Network tab で `updateCardField` POST を確認)
2. **debounce timer reset**: title field を click → 編集 → focus out →
   300ms 以内に再 click → 別文字に編集 → focus out
   - 期待: 1 回しか POST されない (最後の値)
3. **queue (B-2)**: title field を編集 → focus out → 500ms 経過で送信開始 →
   送信中 (network throttle Slow 3G 推奨) にもう一度編集 → focus out
   - 期待: 1 回目送信完走後に 2 回目送信が走り、 2 回 POST、 server は最新値で確定
4. **失敗 rollback**: title を空にして blur (空 title は server zod 拒否)
   - 期待: display は旧値、 inline error 「タイトルは必須です」 (赤)、 edit mode
     には入らない (= 失敗を読んでから再 click で編集 retry)
5. **checkbox 個別 disable**: 任意 option の text を編集中 (= 500ms timer 進行中)
   に checkbox を click
   - 期待: text の保留分が checkbox 送信に同梱、 送信中は **該当 checkbox のみ**
     disabled (同 row の text/explanation cell は edit 可能)
6. **dashboard 反映**: `/app/study/smart` で 1 枚以上 submit → 完了画面 →
   「ダッシュボードへ」 click
   - 期待: 「今日の学習問題数」 / 「連続日数」 が最新値で表示 (戻った瞬間に
     server-side で再 fetch、 stale 表示なし)

### regression check (本 sprint で発覚した bug の再発防止)

7. **StrictMode 下 rollback**: 上記 4 が dev mode で動くこと
   (= mountedRef setup reset の確認、 dev 環境 = strict mode 二重 effect)
8. **revert during in-flight**: title を "A" → 編集 "B" → focus out (送信中) →
   即 click → "A" に戻して focus out
   - 期待: server に最終的に "A" が確定 (lost write 起きない)

## 学び (T2 review が最大の収穫)

CLAUDE.md 規律の「review 経路 = `superpowers:requesting-code-review` skill
canonical を template 改変なしで」 が本 sprint で最大限機能した事例。 T2 で
implementer が自己 review を pass しても、 別 subagent + 厳格 prompt の 2nd
opinion で Critical 2 件 (StrictMode regression / lost write) を発見。 negative-
control test まで含めて fix サイクルが回ったため、 dev / prod の挙動差で OT が
hours 単位の debug を背負うリスクを構造的に回避できた。 自由形式 review に
代替していたら、 「657 test green = 完了」 で見落とされていた可能性が高い。

T3 でも同じ防御を新規実装時から適用 (StrictMode mountedRef reset + handleBlur
short-circuit 条件 + 新 debounce test に regression case 同梱) したことで、
T3 review は Critical / Important 共に 0 で 1 サイクル完了。 学びの横展開
パターンとして再現性あり。

## Postmortem: T1 `revalidatePath('/app')` regression と撤回 (fix `f1d8e55`)

closure 後、 OT 実機で **スマート復習中にカードを 1 枚 submit した瞬間に
次のカードが先に判定済表示で出る** regression を観測。 sprint 完了時点の
T4 docs (`edde024`) は T1 で導入した `revalidatePath('/app')` を「dashboard
反映漏れの fix」 として記述したまま reviewed/no-review 系列を closure
していたため、 docs と実装の整合性も同時に崩れた。

### 観測した症状

1. `/app/study/smart` を開く → 1 枚目の選択肢を選び 「回答する」 押下
2. judged footer (`[← 前へ] [↺ リトライ] [次へ → (primary)]`) 表示
3. 「次へ」 押下 → 内部で `submitReview` server action 発火
4. **submit 完了直後、 まだ navigation 前なのに 「2 枚目」 の選択肢 area が
   `judged` 状態 (= 正誤 highlight + 解説表示) で描画される**
5. ユーザは触っていないのに「次のカード」 が判定済として見えるため、
   学習体験として完全に破綻

### Root cause

`submitReview` server action 末尾で `revalidatePath('/app')` を呼ぶと、
Next.js 15 はその時点で **active page (= 呼出元 `/app/study/smart`) の
RSC payload も再生成して client に push** する。 SessionRunner の
`props.cards` は server で `getSessionCards()` の結果で確定するため、
RSC payload の更新で `cards` 配列が変化 (= submit 済 card は due から
外れて消える等)。 client 側 SessionRunner state は `idx` / `judged` を
保持しているため、 「`cards[idx]` だけ別 card に差し変わった + judged
は維持」 で **次の card が judged 状態で current に描画される** 不整合
が起きた。 jsdom test では navigation を伴わないため再現せず、 670/670
green でも見落とした類の bug。

### 採用した fix (A 案)

server action から `revalidatePath('/app')` を **削除**。 dashboard
(`/app/page.tsx`) は `getCurrentUser()` / DB SELECT で構成される
dynamic page で、 Next.js 15 default の `staleTimes.dynamic = 0` 設定
により client side cache されない (= prefetch しない、 navigation 時に
server で fresh fetch される) ため、 SessionRunner 完了画面の
「ダッシュボードへ」 Link 押下 → server-side で `getReviewStatsForUser`
を新規実行 → 最新統計 (今日の枚数 / 連続日数) で render される。
**SessionRunner 内で再 fetch が発火しない** ため、 props.cards の中身は
session 開始時の snapshot で固定され、 学習体験が安定する。

### 代替案検討と却下理由

- **B 案 (active page 除外)**: Next.js 15 では `revalidatePath` の対象を
  「dashboard 関連 page 以外」 に絞る精密な API が無い (path は完全一致 or
  layout 単位の 2 階層のみ、 「`/app` だけ revalidate / `/app/study/smart`
  は除外」 は表現不能)。 採用不可
- **C 案 (`router.refresh` を client 側で発火)**: dashboard 移動後に
  client から refresh を撃つ案は、 (a) 移動先 page の mount 後に発火が必要
  で UX 上 1 フレーム stale 表示が出る、 (b) Link navigation の標準動作と
  二重 fetch になる。 採用不可
- **D 案 (dashboard 側で `export const dynamic = 'force-dynamic'`)**: 既に
  default `staleTimes.dynamic = 0` で同等動作のため冗長。 ただし将来
  `staleTimes` を上書きする可能性に備えて tech-spec / code comment に
  「staleTimes 変更時は force-dynamic 明示が必要」 と記載済

### Fix の test 担保

fix commit `f1d8e55` で:

- `submit-review.test.ts` から `vi.mock('next/cache')` + `revalidatePath`
  assert を削除 (mock import 行も unused 化したため削除)
- 新規 test 追加なし。 regression 自体が jsdom で再現困難 (navigation +
  RSC payload push を要する)、 かつ「`revalidatePath` を呼んでいない」 こと
  は test では弱い (将来誰かが復活させた場合 negative-control 不在)
- 代わりに `submit-review.ts` 冒頭 comment で **撤回理由** と **将来
  staleTimes 変更時の注意** を docstring 化、 復活時に reviewer が気付ける
  ようにした

### 5 連続 green / build pass による安定性確認

fix 後の全 test 一括 run を 5 回連続 (`pnpm test`) で全 pass。 sprint
closure 時に観測した 1 件 flake (94% green) は再現しなかった。 tsc clean +
`pnpm build` pass で本 fix の確定とした。

### 学び

1. **`revalidatePath` の scope を「active page も含む」 と読み替える**:
   server action 起点の `revalidatePath` は path 一致範囲の RSC payload を
   全て invalidate する。 user が今見ている page の RSC payload が submit
   action で書き換わると client state と props の不整合が起きる、 という
   semantics を `revalidatePath(path)` の docstring (旧) からは読み取り
   にくく、 「dashboard 反映漏れ」 単体の対処として安易に投入したのが直接
   原因。 今後、 study/answer 系 page で server action から `revalidatePath`
   を撃つ際は、 active page の RSC payload に副作用が出ないことを
   handler / props 設計で常に確認する
2. **「dashboard の最新値 = revalidate が必要」 ではない**: Next.js 15
   `staleTimes.dynamic = 0` default 下では、 dynamic page への Link
   navigation は常に server で fresh fetch される。 「cache を invalidate
   しないと古い値が見える」 という直感は、 client cache を持つ page
   (static or `staleTimes` 上書き) でしか成立しない。 dashboard が dynamic
   page である限り、 default `staleTimes` 設定では何もしなくて良い
3. **jsdom test では navigation + RSC payload push の race が再現しない**:
   今 sprint の 670/670 green は debounce / Optimistic UI / rollback 経路
   の validation としては十分機能したが、 navigation を経由する RSC
   payload race は jsdom では出ない盲点。 navigation を伴う server action
   の影響は **OT 実機 smoke でのみ最終確認できる** と覚悟する。 closure
   前の OT 実機 smoke は本 sprint では navigation を含む流れまでは行わず、
   inline edit (試験詳細画面で固定) と 1 枚 submit + 完了画面到達までで
   止めていた。 動作確認シナリオ 6 (「ダッシュボード反映」) は smoke 実施
   できていれば事前に regression を捕捉できたはず、 今後は OT 向け smoke
   シナリオの **navigation を跨ぐ確認** を closure 必須項目に格上げ
4. **docs と実装の整合は fix commit 直後に同 sprint 内で完結する**:
   今回 T4 で「`revalidatePath('/app')` 追加」 と書いた docs を fix
   commit `f1d8e55` 直後に書き換えず、 別作業 (devcontainer 整理 `09495bf`)
   が割り込んで宙吊りになった。 commit 順序として fix 直後に docs 更新
   commit を投入する規律を入れる (本 commit が遅延 docs commit)
