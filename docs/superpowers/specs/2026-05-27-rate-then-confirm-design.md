# rate-then-confirm fix (cache-fix Step 3a Phase 1a) — design

- **作成日**: 2026-05-27
- **OT 状態**: brainstorming 完了 / 確定仕様 + 確定設計 + scope 承認済
- **後続 skill**: writing-plans → executing-plans
- **関連 roadmap**: `docs/cache-fix-roadmap.md` §4.5 Step 3b
- **投資調査 doc**: `docs/superpowers/sessions/2026-05-27-bulk-flush-latency-investigation.md`
  (claude.ai 起票、 別途 commit 予定)

---

## 1. 背景 / 問題

cache-fix Step 2 の stg 計測で発覚した bulk flush 異常 3 問題のうち、 **client side
問題 1** を単独で fix する。

### 観測

- `session-runner.tsx` の `handleRateFsrs(rating)` は内部で `runSubmit(rating,
  () => {})` を呼び、 rate click 毎に `recordAnswerEvent` を fire-and-forget で
  発火する。
- FSRS モードで user が rate を連打 / 変更すると、 click 回数分の `answer_events`
  が Dexie に蓄積し、 5 件しきい値で bulk flush が走り、 server 側 reviews /
  study_days / cards.current_streak に **連打回数分の累積行** が発生する。
- bulk POST に乗る events 件数も連打分膨らみ、 per-event serial transaction で
  TTFB が肥大 (stg 計測 10.7s)。

### 影響

- **UX 不整合**: client tally は `submittedCardIds` Set で 1 card 1 加算固定だが、
  server 側 reviews は連打回数分 insert される。 「1 card = 1 操作」 の user 期待
  と乖離。
- **bulk endpoint latency 計測ノイズ**: events 件数が user 操作の真値より多くなる
  ため、 Step 3a の TTFB root cause 切り分けが行いにくい。

### 目的

rate click は React state 更新のみに留め、 **「次へ」 / 「前へ」 を押した時点で
最後の rate 値で 1 件だけ submit** する。 1 card 1 操作 UX を回復し、 bulk 内容
を正常 size に戻す。

---

## 2. 確定仕様 (OT 承認済)

### 通常モード (handleNextNormal 経路、 fsrsMode=false)

**現状維持**。 回答ボタン押下 → judged 遷移 → 「次へ」 押下で `runSubmit` 発火 =
即 Dexie write。 logic 変更なし。

### FSRS モード (fsrsMode=true)

| step | 操作 | 挙動 |
|------|------|------|
| 1 | 回答ボタン押下 | phase='judged' へ遷移、 選択肢確定、 rate button 有効化 (現状通り) |
| 2 | rate button (Again/Hard/Good/Easy) click | **React state 更新のみ**: `setLastRating(rating)` / tally / submittedCardIds 更新。 **Dexie write しない** |
| 3 | rate 連打 / 変更 | `setLastRating(rating)` の state 上書きのみ。 Dexie write しない |
| 4 | 「次へ」 押下 (lastRating !== null) | `runSubmit(lastRating, () => goNext())` で **Dexie write 1 件 + 次 card 遷移** |
| 5 | 「前へ」 押下 (lastRating !== null, judged) | `runSubmit(lastRating, () => goPrev())` で **Dexie write 1 件 + 前 card 遷移** |
| 6 | 「リトライ」 押下 | `resetCardState()` のみ。 Dexie write なし、 lastRating=null reset (現状維持) |
| 7 | 「前へ」 で戻った card で再回答 → 新 rate → 「次へ」 / 「前へ」 | **追加 1 件 Dexie write** (= 上書きせず、 server 側 submit-review-tx で順次 apply、 案 B 採用) |

### server / schema / migration

- `event_id` は `newId()` で UUID 新規発行 (deterministic 化しない)
- server 側 `ON CONFLICT (event_id) DO NOTHING` 維持 (重複防止 idempotency 用)
- `reviews` / `cards` / `study_days` schema 無変更
- migration 不要 (既存累積データは silent drop で OK、 OT 承認済)

---

## 3. 確定設計

### 3.1 refactor 粒度: A 案 (OT 承認)

| 案 | 内容 | 採否 |
|----|------|------|
| **A 案** | `handleRateFsrs` を inline で state-only 化、 `runSubmit` 本体は無変更。 `handleNextFsrsAfterRate` / `handlePrev` (FSRS judged + rated) で既存 `runSubmit` を呼ぶ | **採用** |
| B 案 | `runSubmit` を `markRated(rating)` + `runDexieFlush(rating, onAfter)` に分割、 handleRateFsrs から markRated だけ呼ぶ | 不採用 (通常モード path も touch するため blast radius 増) |

**採用理由**: FSRS 限定変更 / 通常モード無改修 / 既存 test 流用範囲広い / brief
の指示 (「handleRateFsrs から runSubmit 呼出を撤去」) と整合。

### 3.2 handler 変更詳細 (A 案)

```text
handleRateFsrs(rating):  # 旧: runSubmit(rating, () => {}) を呼出
  if (!current) return
  if (currentCorrect === null) return
  const cardId = current.id
  const correctSnapshot = currentCorrect
  const isFirstSubmit = !submittedCardIds.has(cardId)
  setError(null)
  if (isFirstSubmit):
    setTally(t => ({
      answered: t.answered + 1,
      correct: t.correct + (correctSnapshot ? 1 : 0),
    }))
    setSubmittedCardIds(s => new Set(s).add(cardId))
  setLastRating(rating)
  # Dexie write は呼ばない (← ここが本 fix の核心)

handleNextFsrsAfterRate():  # 旧: goNext() のみ
  if (lastRating === null) return
  runSubmit(lastRating, () => goNext())

handlePrev():               # 旧: idx > 0 で goPrev() のみ (3 phase 共有)
  if (idx === 0) return
  if (fsrsMode && phase === 'judged' && lastRating !== null):
    runSubmit(lastRating, () => goPrev())  # FSRS judged + rated でのみ submit
  else:
    goPrev()  # 既存挙動 (selecting / 通常 judged / FSRS rate 前)

handleRetry():              # 変更なし
  resetCardState()

handleNextNormal():         # 変更なし
  runSubmit(rating, () => goNext())

runSubmit(rating, onAfter): # 本体無変更 (isFirstSubmit gate が新仕様でも自然に機能)
  # 旧実装通り
```

### 3.3 「前へ」 「次へ」 の分岐条件 (B 論点 OT 承認)

```ts
if (fsrsMode && phase === 'judged' && lastRating !== null) {
  runSubmit(lastRating, () => goPrev())
} else {
  goPrev()  // 既存挙動 (selecting / 通常 judged / FSRS rate 前)
}
```

「次へ」 (handleNextFsrsAfterRate) も lastRating !== null guard で同等条件。 UI 側
button `disabled={lastRating === null}` で実質 unreachable な path だが、 handler
内 guard は defensive で keep。

### 3.4 button enable gating (既存式、 変更なし)

- 「次へ」 (FSRS judged): `disabled={lastRating === null}`
- 「前へ」 (FSRS judged): `disabled={isFirstCard || lastRating === null}`
- 4 rate (FSRS judged): pending gate なし (常時 enable、 連打可)

button disable 制御は変えず、 handler 内で `runSubmit` 呼出 / `goPrev`-`goNext`
のみ呼出を切替える。

### 3.5 state machine (変更なし)

`selecting → judged → finished`、 3 phase 維持。 state 変数構成変更なし
(`phase` / `idx` / `tally` / `selectedIds` / `currentCorrect` / `lastRating` /
`submittedCardIds` / `error` / `navState`)。

### 3.6 data flow timeline (FSRS judged path、 新仕様)

```text
T0  rate click (Hard)
    → setLastRating(2) / tally +1 (isFirstSubmit=true) / submittedCardIds.add(c1)
    → Dexie write なし   ← ★ 旧実装からの変更点

T1  rate 再 click (Hard → Good)
    → setLastRating(3) のみ (isFirstSubmit=false で tally/submittedCardIds 無変化)
    → Dexie write なし

T2  「次へ」 click → runSubmit(3, goNext)
    → onAfter (= goNext = idx+1 + resetCardState) 同期実行
    → async recordAnswerEvent (rating=3) + countPending + flush (>= 5)

T3  問2 で rate (Good) → 「前へ」 click
    → runSubmit(3, goPrev) → goPrev (= idx-1 + resetCardState) + async write

T4  問1 (戻り先) で 再 rate → 「次へ」 / 「前へ」 で **追加 1 件 record**
    (= submit-review-tx で順次 apply、 上書きせず累積 = 案 B、 FSRS 公式仕様準拠)
```

`runSubmit` 内 `tally / submittedCardIds` 加算は `isFirstSubmit =
!submittedCardIds.has(cardId)` gate により、 T0 で add 済の card は T2 で **+1
しない** → 二重加算ゼロ invariant が新仕様でも自動的に維持される。

### 3.7 error handling

- **rate click**: Dexie write しない → 失敗経路なし。 inline `setError(null)` のみ維持
- **次へ / 前へ submit**: 既存 `runSubmit` 内 silent retry path (`try { } catch {}`)
  をそのまま流用、 UI に error 出さず次 flush trigger で再試行 (silent retry 設計
  維持)
- **「ダッシュボードへ」 await flush race gate** (`navState`、 S-cache-3.1): 変更なし

---

## 4. testing 戦略

### 4.1 既存 test の反転 (約 10 件)

旧仕様前提 (rate click → `mockRecordAnswerEvent` 即発火) の test を新仕様に反転。
test 名 / コメント / 期待 assertion を新仕様 (rate 0 件 / 次へ・前へ で 1 件) に
合わせて書換える。 個別 test の update 判断は実装 phase で Claude Code が行う。

主な対象 (line 番号は 2026-05-27 時点):

- L305 「FSRS モード: judged Hard 押下で submitReview(rating=2)...」
  → 「rate 押下では fire しない、 次へ で fire」
- L326 「FSRS モード: rate 後 「次へ」 押下で submit せず純遷移」
  → 「rate 押下で fire しない、 次へ で fire」
- L351 「Again/Good/Easy それぞれで submitReview 呼出」
  → 「rate 押下 0 件 / 次へ で 1 件」
- L846 「rate 連打で毎回 submitReview 呼ばれる (上書き submit)」
  → 「**rate 連打 0 件 / 次へ で lastRating 1 件**」 (本 spec の核心 assertion)
- L896 「judged FSRS モード: 「前へ」 (rate 後) → submit 追加なし」
  → 「**1 件 submit + goPrev**」 に反転
- L918 「FSRS モード最後の card: rate → 「次へ」 で finished phase (submit 追加なし)」
  → 「rate 0 件 / 次へ 1 件 + finished」
- L938 「リトライ後の再 submit で tally 二重加算されない」
  → flow に 「次へ」 を挟む
- L1055 / L1094 Optimistic 系
  → highlight 即時反映は維持、 `recordAnswerEvent` は 次へ click まで fire しない
- L1223 rating forwarding FSRS
  → rate 後の 「次へ」 click を追加して assert

### 4.2 新規 test (4 件)

1. **FSRS rate 連打 → 次へ で lastRating で 1 件のみ submit**
   - Hard → Good → Easy → 次へ
   - `mockRecordAnswerEvent` 1 回 with rating=4
   - 「次へ」 で finished phase / tally 1 枚 / 1 正解

2. **FSRS rate → 前へ → 1 件 submit + 前 card 遷移**
   - idx=1 まで進めて rate Good → 前へ
   - `mockRecordAnswerEvent` 1 回 with rating=3
   - 問1 遷移 + selecting reset

3. **FSRS 前へで戻った card で再回答 → 再 rate → 次へ で追加 1 件**
   - 問1 で rate → 次へ (submit 1) → 問2 で rate → 前へ (submit 1) → 問1 戻り
     再 rate → 次へ (submit 1)
   - 累積 3 件 (上書きせず順次 apply の確認)

4. **FSRS リトライ → submit 呼ばれない (regression guard)**
   - rate Good → リトライ
   - `mockRecordAnswerEvent` 0 回

### 4.3 通常モード test (変更なし)

L193- 群 (handleNextNormal 経路、 約 10 件) は logic 不変のため touch しない。

### 4.4 S-cache-3.1 完了画面 flush gating test (変更なし)

L1260- 群は phase='finished' 後の navigation race gate test、 本 fix と無関係。

---

## 5. scope

### In

`app/(app)/app/study/smart/_components/session-runner.tsx`:

- `handleRateFsrs(rating)`: runSubmit 呼出撤去 + inline state-only 化
- `handleNextFsrsAfterRate()`: runSubmit(lastRating, goNext) に置換
- `handlePrev()`: FSRS judged + rated 分岐で runSubmit(lastRating, goPrev) 追加
- `handleRetry()` / `handleNextNormal()` / `runSubmit` 本体: 変更なし

関連 test (`app/(app)/app/study/smart/_components/session-runner.test.tsx`):

- 既存 FSRS 系 test の新仕様反転 (約 10 件)
- 新規 test 追加 (4 件)
- 通常モード / S-cache-3.1 test: 変更なし

### Out (別 sprint)

- in-flight guard (problem 2): 別 spec
- bulk route refactor (problem 3): 別 spec
- Vercel hnd1 固定 (Phase 0): OT 手動で並行実施
- LocalSync MVP: cache-fix roadmap §5
- event_id deterministic 化 / server ON CONFLICT 変更 / reviews 1 card 1 件保証
  (= 案 α 不採用、 案 β 順次 apply 維持)
- 既存累積データ migration
- 通常モード logic 変更

---

## 6. 完了条件

- vitest 全 pass (FSRS + 通常 + S-cache-3.1)
- typecheck clean
- review (`superpowers:requesting-code-review` skill canonical 経路、
  general-purpose subagent + template 改変なし) Critical 0 / Important 0
- commit type `fix(study)`、 [reviewed] tag 必須
- session log 記録 (sprint 完了時、 `docs/superpowers/sessions/`)
- stg smoke 「FSRS rate 連打 → 次へ 1 回 → POST 1 件」 実機確認
  (claude.ai / OT 担当、 sprint 完了後)

---

## 7. skill 起動順 / 次の step

brainstorming (本 doc commit + self-review + user gate) → **writing-plans** →
executing-plans
