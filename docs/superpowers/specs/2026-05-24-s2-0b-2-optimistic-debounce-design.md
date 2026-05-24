# S2.0b-2 試験詳細画面 Optimistic UI + debounce / ダッシュボード反映漏れ修正

- 起票日: 2026-05-24
- 種別: design spec
- 前 sprint: S2.0b-1 (T1〜T5、 試験詳細画面の inline 編集 + memo + cards 行楽観 / cell 楽観)
- 関連 commit: 95997e8 / ec595a4 / ccc34e9 / 148ba91

## 1. 目的

S2.0b-1 で導入した試験詳細画面の inline 編集は、 「blur → server 解決まで edit
mode 維持 + spinner + cell disable」 の同期的 UX で、 連続編集や数 ms の通信遅延
でも入力体感が遅い。 これを Optimistic UI + debounce 化し、 体感ゼロ遅延に変える
(実装1)。

合わせて、 スマート復習 (`/app/study/smart`) 完了後にダッシュボード (`/app`) に
戻ったとき、 「今日の枚数 / 連続日数」 が古い値のまま表示される反映漏れを
`revalidatePath` 1 行で修正する (実装2)。

## 2. 非ゴール (本 sprint で実装しない)

- 試験詳細画面での選択肢の追加・削除・並び替え (T2 server action では payload
  に空配列を許容しない zod スキーマ前提が変わらないため、 別 sprint 扱い)
- ページ離脱時の一斉送信 (= debounce 中の未送信を beforeunload で flush)
- 同時編集 (concurrent edit) の OCC / etag 検出 (S2.0b-1 review I2 既知制約)
- セッション中の dashboard 値の局所更新 UI (今回 H-2 のみで H-1/H-3/H-4 不採用)
- 完了画面 tally 計算順の変更 (現状 client setTally を維持 = I-2)
- 投票 fire-and-forget 化 (J-1 = useTransition pending + judged 維持を維持)

## 3. 実装1: InlineTextField / InlineOptionRow Optimistic UI + debounce

### 3.1 仕様 (OT 確認済)

| 項目 | 仕様 |
|------|------|
| Optimistic UI | blur 直後に display mode 復帰 + 表示値を新値に即時反映、 spinner なし (C-1) |
| debounce | テキスト系 500ms、 checkbox は debounce なし (即時) |
| 連続 blur (debounce 内) | timer reset で最後の値のみ送信 (A) |
| 進行中 send 中の新 blur | queue: 完走後に最新値で再送信 (B-2) |
| 送信失敗 | display を server 反映済値に rollback + inline error 表示、 edit mode 復帰しない (E-1) |
| checkbox 失敗 | is_correct を rollback + inline error 表示 |
| checkbox disable 範囲 | 該当 checkbox のみ disable、 同 row の text/explanation は edit 可能 (D) |
| 異なる InlineTextField 間の並列 | 並列許容 (F) |
| 同 InlineOptionRow 内の cell 間 | row 共有 inFlight + queue で 1 並列に絞る (race 予防) |

### 3.2 InlineTextField 設計

local state / ref:

```
state:
  value: string           // input 編集値
  committedValue: string  // display 表示値 (= optimistic 反映先)
  editing: boolean
  error: string | null

ref:
  serverCommittedRef: string  // 最後に server で成功した値 (= rollback target)
  inFlightRef: boolean        // 進行中 send 有無
  pendingValueRef: string | null  // queue 中の最新値
  debounceTimerRef: timeout ID | null
  mountedRef: boolean         // unmount 後の setState 抑止
```

blur ハンドラ:

```
1. editing=false に
2. 値が serverCommittedRef と同じなら return (server 不呼出)
3. setCommittedValue(value) で display 即時反映
4. setError(null) で前回 error クリア
5. scheduleSend(value)
```

scheduleSend:

```
1. clearTimeout(debounceTimerRef)
2. setTimeout 500ms で send(value)
```

send(target):

```
1. if (inFlightRef) { pendingValueRef = target; return }
2. inFlightRef = true
3. result = await updateCardField(cardId, field, target)
4. inFlightRef = false
5. if (!result.ok) {
     setError(result.error)
     setCommittedValue(serverCommittedRef)  // rollback
     pendingValueRef = null  // queue 捨て、 連続失敗防止
     return
   }
6. serverCommittedRef = target
7. if (pendingValueRef !== null) {
     const next = pendingValueRef
     pendingValueRef = null
     send(next)
   }
```

cleanup:

```
unmount 時:
- mountedRef = false
- clearTimeout(debounceTimerRef)
- send 内の setState は mountedRef ガード
```

### 3.3 InlineOptionRow 設計

構造変更: cell の local `committed` state を廃止し、 row 共有 `committed:
CardOption` を真実 source にする。 cell は props.value 受領 + local edit value
のみ持つ。

```
state (InlineOptionRow):
  committed: CardOption       // row の真実値 (display 反映先)
  error: string | null
  checkboxInFlight: boolean   // checkbox 単体 disable UI

ref:
  serverCommittedRef: CardOption
  inFlightRef: boolean
  pendingPayloadRef: CardOption | null
  debounceTimerRef: timeout ID | null
  mountedRef: boolean
```

text/id/explanation cell 共通 onSave (= cell blur 経由):

```
1. setCommitted({ ...committed, [field]: value })
2. scheduleSend(nextCommitted)
```

scheduleSend (text 系):
- InlineTextField と同じ (clearTimeout + setTimeout 500ms)

send(nextCommitted):
- InlineTextField と同じだが、 payload は allOptions を **常に最新 committed
  snapshot で再構築** + toZodOption 変換
- 成功: serverCommittedRef = nextCommitted
- 失敗: setCommitted(serverCommittedRef) で rollback (是正対象 field 含めて
  is_correct も含む全 field rollback)

checkbox onChange:

```
1. if (checkboxInFlight) return (UI も disabled で本来到達しない)
2. clearTimeout(debounceTimerRef) (進行中 text 編集の保留 timer をキャンセル、
   保留分は committed に既に反映済なので checkbox 送信に同梱される)
3. setCommitted({ ...committed, is_correct: e.target.checked })
4. setCheckboxInFlight(true)
5. send(nextCommitted)
6. send 完走で setCheckboxInFlight(false) (mountedRef ガード)
```

InlineOptionCell (cell 内 sub-component) state 簡素化:

```
props: value, ariaLabel, onSave(value), displayClassName, placeholder, kind

state:
  editValue: string
  editing: boolean
  cellError: string | null  // 廃止 (error は row 集約で表示)

display value: props.value (row の committed から派生)
blur 時: editing=false + onSave(editValue)
```

### 3.4 server action 側の前提

`updateCardField` 自体は変更なし。 並列 / queue で複数回呼ばれることは想定済
(server 側は 1 行 UPDATE で last write wins)。 zod / auth は既存実装で fail-fast。

### 3.5 race 予防の理由 (row 内 1 並列)

row 内 cell を完全並列にすると以下が起きる:

```
時刻 t0: text cell 編集 (committed{id:a, text:旧, is_correct:false} → {text:新A})
時刻 t1: text 送信開始 (payload: text:新A, is_correct:false)
時刻 t2: checkbox click (committed → {text:新A, is_correct:true})
時刻 t3: checkbox 送信開始 (payload: text:新A, is_correct:true)
時刻 t4: text 送信完了 (server: text:新A, is_correct:false)
時刻 t5: checkbox 送信完了 (server: text:新A, is_correct:true)
```

t4 < t5 ならば last write wins で OK。 だが network 遅延で逆転すると text の新値
が is_correct=false で上書きされて checkbox が rollback されたように見える。
これを防ぐため、 row 共有 1 並列 + queue (= B-2) で確実に「最後の意図」 が最終
状態になることを保証する。

## 4. 実装2: submitReview revalidatePath

### 4.1 修正点

`app/(app)/app/study/smart/_actions/submit-review.ts` の成功 return 直前で
`revalidatePath('/app')` を呼ぶ。 dashboard (`/app/page.tsx`) の Server Component
が `getReviewStatsForUser` を再 fetch して 「今日の枚数 / 連続日数」 が更新される。

```ts
import { revalidatePath } from 'next/cache'
// ...
const result = await db.transaction(async (tx) => submitReviewTx(tx, ...))
revalidatePath('/app')
return { ok: true, data: result }
```

### 4.2 副作用 / コスト

- 1 card submit ごとに revalidatePath 1 回呼ばれる (連打しても server 側は
  単に cache tag を invalidate するだけで、 dashboard fetch は次回 navigation
  まで起きない)
- failure 時は呼ばない (try 外、 catch 後の return では呼ばない)

### 4.3 test

`submit-review.test.ts` を更新:
- `vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))` を追加
- 成功 case で `expect(revalidatePath).toHaveBeenCalledWith('/app')` を assert
- failure case で `expect(revalidatePath).not.toHaveBeenCalled()` を assert

## 5. test 戦略

### 5.1 新規 test (fake timer)

- `inline-text-field.debounce.test.tsx` (新規):
  - blur → 500ms 経過前は updateCardField 呼ばれない
  - blur → 500ms 経過で updateCardField 呼ばれる
  - blur → 300ms → 再 blur → 合計 800ms (= 2 回目から 500ms) で呼ばれる、 引数は最後の値
  - send inFlight 中に blur → 元の send 完了後に 2 回目 send が呼ばれる
  - blur 直後 (server 解決前) に display = 新値、 input は消える (Optimistic UI)
  - 失敗時 display = 旧値 (rollback)、 edit mode に入らない
  - 失敗後の次 blur で error が消えて新 send が走る

- `inline-option-row.debounce.test.tsx` (新規):
  - text cell blur → 500ms debounce
  - text 編集中に checkbox click → debounce timer cancel + checkbox 送信に text 新値同梱
  - checkbox 送信中 (inFlight=true): 該当 checkbox disabled、 text/explanation cell は edit 可能
  - text 送信中に他 cell blur → queue で 1 並列、 完走後に最新 snapshot で再送信
  - 失敗時 row 全体 rollback (is_correct も含む) + error 表示

### 5.2 既存 test update

S2.0b-1 で書かれた挙動前提が Optimistic UI 化で変わる test を update:

- `inline-text-field.test.tsx`:
  - 「pending 中 input disabled」 → 削除 (即時 display 復帰で input 自体が消える)
  - 「保存中… spinner 表示」 → 削除
  - 「blur 成功 → display mode 復帰、 新値 render」 → blur 即時 display + 新値 render
    (await 不要)
  - 「失敗時 edit mode 維持 + error」 → 失敗時 display mode で旧値 + error
  - 「pending 中再 click できない」 → 削除 (該当しない)
  - blur 時の送信は debounce 500ms 後なので、 fake timer の advance か waitFor で
    pending 経過まで待つ必要あり。 ここはあえて real timer + waitFor で送信検証
    する既存 test とは別の責務として、 既存 test は「blur 直後の display 即時変化」
    の検証のみに絞る形 (debounce / queue / abort は新 test で網羅)

- `inline-option-row.test.tsx`:
  - 「pending 中 checkbox / 4 cell が disabled」 → 「pending 中 checkbox のみ
    disabled (text/explanation cell は edit 可能)」 に書換え
  - 「is_correct 失敗時 rollback」 → 維持 (仕様変わらず)
  - 「id 失敗時 edit mode 維持 + error」 → 「id 失敗時 display で旧値 + error」
  - 「explanation 既存値空 → key drop」 → 維持 (payload 構築 logic は変わらない)

### 5.3 既存 test を fake timer に移行しない理由 (G-1)

- 既存 test は scope が広い (display / click / change / blur の基本動作)。 fake
  timer 移行すると vi.useFakeTimers / advanceTimersByTime / runOnlyPendingTimers
  の boilerplate が増え、 既存仕様の検証から外れる
- 新 test は debounce / queue 専用 scope に絞ることで boilerplate を局所化

## 6. Sprint 構成

- **T1** [reviewed]: 実装2 (submitReview revalidatePath 1 行 + test 更新)
- **T2** [reviewed]: 実装1 of InlineTextField (Optimistic UI + debounce + queue)
- **T3** [reviewed]: 実装1 of InlineOptionRow (row 共有 send + cell props 化 +
  checkbox 個別 inFlight)
- **T4** [no-review]: tech-spec / session log 更新 + sprint closure

順序: T1 が小さく独立しているため先 (1 サイクルで完結)、 T2 で text 系の機構
を確立してから T3 で row 構造変更 (cell props 化) を行うのが review しやすい。

## 7. 重要 Fix 裏取り判定

CLAUDE.md §重要 Fix の裏取り に照らすと:

- 実装1 (UI): 決済 / 認証 / 削除 / 外部副作用 いずれも非該当 → review pass で
  即 [reviewed] 可
- 実装2 (server action 側 revalidatePath 追加): cache invalidation のみで決済 /
  認証 / 削除 / 外部副作用 (email / Stripe) 非該当 → review pass で即 [reviewed] 可

## 8. ロールバック計画

万一 production で問題が出た場合の戻し:

- 実装1: InlineTextField / InlineOptionRow の git revert 1 commit (T2 / T3)
- 実装2: submit-review.ts から revalidatePath 1 行削除 (= T1 revert)

データ移行 / migration 一切なし、 即時 revert 可能。
