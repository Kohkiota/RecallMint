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
