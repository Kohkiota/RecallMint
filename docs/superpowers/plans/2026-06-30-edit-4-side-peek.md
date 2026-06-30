# Edit-4 テーブル side peek(表示専用)Implementation Plan(ドラフト・改訂)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)で実装する。Steps は checkbox 追跡。
> **状態:** plan ドラフト(未確定・確定スコープへ改訂版)。codex-plan-review 再走(スコープ変更ゆえ前回 cross-check 無効)→ OT 承認で確定。実装は承認後・別プロンプト。

**Goal:** 試験詳細テーブルで、行の内容を回答画面 judged 風に確認する従ビューを足す。desktop = 右 side peek(2カラム・リサイズ可)、mobile = full-page 遷移。表示専用。

**Architecture:** 回答画面 judged 表示を `card` 1 件依存の presentational `CardView` に**複製**(SessionRunner 不変)。`ExamCardTable` 内に `activeCardId` state、:361 table ブロックを `md:flex` 左ペイン化し右に peek(自前リサイズ・幅非永続)。peek は live `data` から card を引く(snapshot しない)。開く trigger は title 列ボタン(desktop hover+focus / mobile 常時 = `<Link>`)。mobile は新規 route `cards/[cardId]/page.tsx`(**パスは §Q1 未確定 — 本 plan は `cards/[cardId]` 前提で記述、確定で差し替え**)で `db.cards.get`→CardView。CSS md: + DOM 両置きで JS viewport 判定を回避。型変換マッパ・同期コード・PullGate・新 dep は追加しない。

**Tech Stack:** Next.js App Router / TS strict / TanStack Table / Dexie(mirror, useLiveQuery, `db.cards.get`)/ Tailwind v4 / Vitest + RTL / DevTools MCP smoke。

**Spec(唯一の起点):** `docs/superpowers/specs/2026-06-30-edit-4-side-peek-design.md`

## Global Constraints

- 起点は spec のみ。spec 凍結。仕様変更が要るなら停止して OT 相談。
- 各 task 完了条件 = ① 該当 unit/component test green ② canonical + Codex 両 Critical/Important 0 ③ `[reviewed]`。
- **表示専用**。編集・保存・dirty を載せない。**container 化しない**(状態は ExamCardTable のみ)。
- **CardView は複製**。**SessionRunner 本体不変**(共有抽出しない)。
- **型変換マッパ新設しない**(peek/full-page に `ClientCard` をそのまま渡す)。**同期コードを足さない**(live data 追従)。
- **prune 以外の防御コードを足さない**(空データ fallback も足さない)。**PullGate を追加しない**(full-page は read-only)。
- **リサイズは自前最小・新 dep ゼロ**。window listener は mount 中のみ・`mouseup`/unmount で cleanup 厳守。**幅は非永続セッション state**(examViewPrefs を触らない)。
- **JS viewport 判定(useMediaQuery/matchMedia)を導入しない**。mobile/desktop は CSS `md:` + DOM 両置き。
- **sticky header / ページ縦スクロール変更は OUT(Edit-5)**。**編集化は OUT(Edit-4b)**。
- **カードビュー(`InlineCardList`)・`exam-detail-view` 分岐(L100-109)不変**。全 read は `user_id` scope 維持。
- Test: Vitest + RTL。`git commit --no-verify` / `-n` 全面禁止。

## Sprint 完了 gate

- whole-repo `pnpm lint --max-warnings=0` exit 0(報告に1行明記)。CC と reviewer 両経路で確認。
- 新 route + state 追加のため `pnpm typecheck` exit 0。
- **smoke gate の位置(Codex cross-check 抜け#15 反映)**: per-task 完了条件 = unit/RTL green + typecheck + review(worker が回せるもの)。**実機 smoke は per-task のブロッカーにしない**(worker は push しない運用 = CLAUDE.md 標準フロー「実装+review+commit→stop→OT push→stg smoke」)。視覚・レイアウト・hover/focus・横スクロール・resize drag・mobile CSS gate は **sprint 末 stg smoke**(push 後 OT 指示で CC が DevTools MCP 実走)に集約。可能な限り pure logic / DOM presence / handler 配線は unit/RTL に寄せる(Codex 抜け#14)。
- **sprint 末 stg smoke**:
  - desktop(md:以上): hover/focus→開く→peek judged 表示 / cell 編集→peek live 追従 / フィルタ・削除で active 消滅→peek 閉じる / Esc・外クリック・×で閉じる / 青枠 pin またぎ / リサイズ drag・clamp・幅セッション保持 / ActionBar×peek 非干渉 / カードビュー無改変。
  - mobile(375px): 開くボタン常時表示→full-page 遷移→カード表示 / side peek 非表示 / table 単独横スクロール / 戻る挙動。

---

### Task 1: CardView(judged 固定・表示専用 presentational・複製)

**目的:** 回答画面 judged 表示を `card` 1 件のみ依存の presentational に複製する(SessionRunner 不変・desktop peek と mobile full-page で共有)。

**Files:** Create `app/(app)/app/exams/[id]/_components/card-view.tsx`(+ `.test.tsx`)。移植元 = `session-runner.tsx` L424-494 + `stripPrefix`(:94)。

**Interfaces(Produces):** `export function CardView({ card }: { card: ClientCard }): React.JSX.Element`(`ClientCard` from `@/lib/client-db`)。読むのは `card.title` / `card.question_text` / `card.options[]`(`{id,text,is_correct,explanation?}`)/ `card.explanation_text` のみ。

**制約(spec §3.2/§4.1):**
- judged 固定描画。除去 = 全 footer handler / FSRS 採点 / outbox 書込 / 完了 flush effect / error・tally / 選択肢の `onClick`toggle・`disabled`・`aria-pressed` / **判定 banner(L473-484)** / 進捗 header(L416-422)。
- 選択肢は `<button>` → 非インタラクティブ `<div>`(cursor/focus/aria 不要化)。正解ハイライト class + ○× + 選択肢別解説 + カード解説のみ。`stripPrefix` は card-view 内に複製。
- タグ・画像出さない。**空データ fallback を足さない**(`options=[]`/解説空/問題文空は自然な空描画)。container 化しない(props は card のみ)。

**完了条件:**
- `card-view.test.tsx` green: ① 正解選択肢に正解ハイライト class ② 各選択肢に `○`/`×` ③ `explanation` 有り選択肢に「解説:」 ④ `explanation_text` 有りでカード解説ブロック ⑤ 判定 banner(正解/不正解 text)が**存在しない** ⑥ 選択肢が button でなく `aria-pressed` を持たない ⑦ `options=[]` で crash せず空描画。
- typecheck 0。canonical + Codex 両 Critical/Important 0 + `[reviewed]`。smoke 不要(純表示・後続 task で実走)。

---

### Task 2: activeCardId state + prune

**目的:** peek/full-page が開く対象の active 行 state を `ExamCardTable` 内に新設し、可視集合から外れたら閉じる prune を足す。

**Files:** Modify `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(state は :68 近傍、prune は selection prune :290-310 を拡張)+ `exam-card-table.test.tsx` 追記。

**Interfaces(Produces):** `const [activeCardId, setActiveCardId] = useState<string | null>(null)`。T3/T4 が消費。prune 純関数 `pruneActiveId(activeCardId, visibleIds): string | null`(可視集合に無ければ null)を抽出し単体 test 可能に。

**制約(spec §4.2/4.3):**
- キーは `card.id`(`getRowId`/`rowSelection` と同一語彙)。**rowSelection と同期しない**(用途直交)。
- prune は selection の**可視 ID 集合を流用**。**これ以外の防御コードを足さない**。
- この task 単独では UI 変化なし(consumer は T3)。

**完了条件:**
- `exam-card-table.test.tsx` 追記 green: ① `pruneActiveId` 純ロジック(可視に無い id を null 化 / 有る id は維持)② rowSelection 操作が activeCardId に影響しない(直交)。
- **task 境界注記**: `activeCardId` の最初の UI consumer は T3。state が立つ/prune が閉じるの**振る舞い検証は T3 統合 test**で担保 → **T2 と T3 は対で実装・review**。
- typecheck 0。canonical + Codex 両 Critical/Important 0 + `[reviewed]`。

---

### Task 3: 2カラム shell + リサイズ + peek(live data 追従)

**目的:** :361 table ブロックを `md:flex` 左ペイン化し、右に live data 追従の peek を置く。中央ドラッグハンドルで左右幅を自前リサイズ(幅は非永続セッション state)。

**Files:** Modify `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(:350 直下〜ActionBar 間に `md:flex` ラッパ、リサイズ state + window listener)+ `exam-card-table.test.tsx` 追記。

**Interfaces(Consumes):** `CardView`(T1)/ `activeCardId`(T2)/ 既存 `data: ExamCardRow[]`(:109-113、`ExamCardRow = {card: ClientCard, tags}`)。

**制約(spec §4.4/4.5):**
- peek の card = `activeCardId ? data.find((r) => r.card.id === activeCardId)?.card ?? null : null`(**`liveData` は配列でなくオブジェクト :87-103 なので使わない**。join 済み `data` の `r.card` を引く)。cell 編集→mirror→useLiveQuery→data 再計算→peek 自動追従。**追加 fetch/同期 state なし**。
- レイアウト: `<div className="md:flex">` の左 = `<div style={{ width: tableWidth }}>` + 既存 `overflow-x-auto` table(`min-w-0` 維持で横スクロール温存)、中央 = ドラッグハンドル(`hidden md:block`)、右 = `activeCard && <aside className="hidden md:block" style={{ width: peekWidth }}>`(`<CardView card={activeCard}/>` + × button)。`< md` は単一カラム(flex 解除)で従来挙動。filter bar / ActionBar はラッパ外。
- リサイズ: `const [peekWidth, setPeekWidth] = useState(384)` セッション state(**React state ＝ 同一ページ滞在中のみ保持。route 遷移/reload で既定に戻る。永続化しない**)。ハンドル `onMouseDown` で `window.addEventListener('mousemove'/'mouseup')` を**その時だけ**貼り、`clamp(min,max)` で更新、`mouseup` で listener 除去。`useEffect` cleanup でも unmount 時に必ず除去(mount 中のみ・leak 厳禁)。**新 dep なし**。
  - **割り切り(Codex 抜け#4/独立#6)**: **mouse events のみ**(Pointer/Touch 非対応=desktop md: 限定ゆえ許容)。drag 中は `user-select:none`(text 選択抑制)。window 外で mouseup が失われる対策に `mouseup` を window に貼る(handle でなく)。clamp 既定 = **table 最小 480px / peek 320–560px(既定 384px)**(§Q2 で OT 確定。未確定なら裁量混入するため本文に既定値を昇格)。
- ActionBar 干渉(Codex 抜け#6): ActionBar(`fixed inset-x-0 bottom-0`)に隠れる末尾行対策は既存の `pb-32`(:350、選択時)を踏襲。**peek aside は ActionBar より上に収め重ねない**(peek 内が長い場合は peek 側 `overflow-y-auto`、document scroll は変えない=sticky header 領域 OUT と整合)。
- 閉じる(× / 外クリック / Esc)は T4 と一体で実装(peek DOM は T3、閉じ操作配線は T4)。

**完了条件:**
- `exam-card-table.test.tsx` 追記 green: ① `activeCardId` 設定で peek に該当 card(問題文等)表示 ② null で peek 非描画・table 単独 ③ data の該当 card 更新が peek 表示に反映(live 追従)④ active 行が data から消えると peek 消滅(T2 prune 接続)。
- typecheck 0。canonical + Codex 両 Critical/Important 0 + `[reviewed]`。
- **smoke は sprint 末 gate**: リサイズ drag・clamp・幅セッション保持・peek live 追従・ActionBar×peek 非干渉・`md:` gate(mobile で flex 解除・peek 非表示)(per-task ブロッカーにしない)。

---

### Task 4: 開く trigger(title 列ボタン)+ active 行青枠 + 閉じ方

**目的:** title 列セルに開くボタン(desktop hover+focus-visible+aria-label / mobile 常時)を置き、active 行を青枠表示、閉じ方(外クリック/×/Esc)を配線する。

**Files:** Modify `app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx`(title 列 cell :81-97 にボタン、`setActiveCardId` は table meta 経由)+ `exam-card-table.tsx`(td の青枠 class・外クリック/Esc handler)+ 各 `.test.tsx` 追記。

**Interfaces(Consumes):** `setActiveCardId`(T2、`table.options.meta` 経由 = 既存 meta 配線パターン)/ `activeCardId`(青枠判定)。

**制約(spec §3.3/4.7):**
- **行クリック不使用**。trigger は title セル内の専用ボタン。**desktop** = `hidden md:inline-flex` + hover/`focus-visible` で表示(`opacity` or `group-hover`/`group-focus-within`)+ `aria-label="カードを開く"`、`onClick={() => meta.setActiveCardId(card.id)}`。**mobile** = `<Button asChild className="md:hidden"><Link href={`/app/exams/${examId}/cards/${card.id}`} prefetch={false}>`(常時表示)。両方常時 render・`display:none` 側不活性で click 競合なし。
- title の click-to-edit(`InlineTextField` の `role="button"` div)と trigger ボタンは別クリック領域(衝突しないことを test 担保。`stopPropagation` は不要なら足さない)。
- **focus/tab 順(Codex 抜け#13)**: desktop trigger は hover/`focus-visible` 表示だが **Tab で到達可能**(`opacity` 0→100 で出すが `display:none` にしない=focus 可能のまま)。title セル内の tab 順 = 編集 div → open button の自然順。`aria-label="カードを開く"`。
- 青枠 = active 行の各 td に `box-shadow inset`(上下横線 + `getVisibleCells` index 0 に左 inset・末尾に右 inset で連続枠)。box-shadow は stacking 非依存で pin セルまたぎで途切れない。selection 無塗りゆえ色は青系で自由。
- 閉じ方: × button(`setActiveCardId(null)`)+ Esc + peek 外クリック。**過剰防御を足さない**(focus trap 等は入れない)。
  - **Esc 競合(Codex 抜け#2/独立#9)**: Esc handler は `event.defaultPrevented` を見て、InlineTextField 編集中・dropdown/popover が既に Esc を消費した場合は peek を閉じない(input 中 Esc で peek まで閉じない)。
  - **外クリック範囲(Codex 抜け#3/独立#8 — §Q4 で確定要)**: plan 既定 = **peek aside と「開く trigger」の外側 click で閉じる。table cell 編集・filter bar・ActionBar・resize handle のクリックでは閉じない**(これらは peek の外だが「閉じる対象外領域」として除外し、cell 編集中の誤クローズと resize×外クリック競合を防ぐ)。実装は「閉じない領域」を ref で持ち、その外側のみ close。

**完了条件:**
- `exam-card-table-columns.test.tsx` / `exam-card-table.test.tsx` green: ① title セルに開く trigger 存在(desktop button + mobile Link、後者 `prefetch={false}` + href 正しい)② desktop trigger クリックで `setActiveCardId(card.id)` ③ title click-to-edit が trigger クリックで誤発火しない・編集 div クリックで peek 開かない ④ active 行 td に青枠 class ⑤ ×/Esc で activeCardId null ⑥ InlineTextField 編集中の Esc(defaultPrevented)で peek が閉じない。
- typecheck 0。canonical + Codex 両 Critical/Important 0 + `[reviewed]`。
- **smoke は sprint 末 gate**: hover/focus trigger 表示・青枠 pin またぎ連続・外クリック範囲・Esc・mobile 常時表示(per-task ブロッカーにしない)。

---

### Task 5: mobile full-page route + 単票取得

**目的:** mobile「開く」の遷移先 full-page route を新設し、`db.cards.get` で単票を引き CardView 表示。

**Files:** Create `app/(app)/app/exams/[id]/cards/[cardId]/page.tsx`(client component。必要なら `loading.tsx`)+ `.test.tsx`。`CardView`(T1)再利用。

**Interfaces(Consumes):** `CardView`(T1)/ `getClientDb().cards.get(cardId)`(Dexie)/ Clerk `useAuth`/`auth()` で user_id。

**制約(spec §3.5/4.6):**
- client component で `useLiveQuery(() => getClientDb().cards.get(cardId))` で取得(mirror 追従・read-only)。**新 server helper を足さない**。
- **認可検証(Codex cross-check 抜け#1/#13 反映 — 最も実害が出やすい抜け)**: `card.user_id === 現 user_id` **かつ `card.exam_id === params.id`** を満たす時のみ CardView 描画。route が `/exams/[id]/cards/[cardId]` ゆえ user_id だけだと別 exam 配下 URL で他 exam の card が表示されうる → **exam membership も検証**。不一致は not-found 表示。
- **loading ↔ not-found を区別(Codex 抜け#9 反映)**: `useLiveQuery` の戻りは初期 `undefined`(解決前=loading)/ `undefined`(`get` が見つからない=not-found も undefined)で衝突するため、**「クエリ未解決」と「解決済みかつ card なし/検証 NG」を明示的に分ける**(例: `{ card, ready }` を返す query にし、`!ready` は loading・`ready && !valid` は not-found)。取得中に一瞬 not-found を出さない。**空データ fallback 禁止(§Q6/spec §3.8)とは別レイヤー**(CardView 内の空フィールドは自然描画、route の取得失敗は page の not-found)。
- **PullGate を追加しない**(read-only 滞在)。`<CardView card={card}/>` を mobile 幅(`max-w-2xl mx-auto` 等)で表示。
- 戻り導線 = §Q3(最小)。route group `(app)`/dynamic segment は ESLint flat glob で `\(...\)`/`\[...\]` escape(CLAUDE.md 規約)— 新 route が lint 対象 override に乗るか確認。
- **route 自体に viewport gate 不要**(desktop は peek を開くので Link を踏まない。直 URL アクセス時も同 CardView 表示で差し支えなし)。
- **リスク注記(Codex 独立#10/リスク#6)**: PullGate なしのため ambient pull タイミング次第で mirror が stale な card を表示しうる(read-only ゆえ実害小)。local-first で許容と明記。

**完了条件:**
- `page.test.tsx` green: ① card を CardView 描画 ② `user_id` 不一致で not-found ③ `exam_id` 不一致で not-found ④ 不在 cardId で not-found ⑤ クエリ未解決中は loading でありnot-found を出さない。
- typecheck 0。canonical + Codex 両 Critical/Important 0 + `[reviewed]`。lint glob に新 route segment が含まれ exit 0。
- **smoke は sprint 末 gate**(下記参照。per-task 完了条件のブロッカーにしない=worker は push しない運用)。

---

## Self-Review

- **Spec coverage:** §3.1 表示専用→全 task / §3.2 CardView 複製→T1 / §3.3 trigger→T4 / §3.4 2カラム+リサイズ+非永続→T3 / §3.5 mobile full-page+CSS出し分け+db.cards.get+PullGate なし→T5+T4(Link)/ §3.6 青枠→T4 / §3.7 閉じ方→T4 / §3.8 空データ fallback なし→T1。§4.2 activeCardId→T2 / §4.3 prune→T2 / §4.4 live 追従→T3。§5.2 OUT(編集・sticky header・共有抽出・マッパ・同期・PullGate・JS viewport・幅永続・行クリック)→Global Constraints。✓
- **Placeholder scan:** なし。clamp 値(§Q2)/ route パス(§Q1)/ 戻り導線(§Q3)は Open Question として明示(TBD でなく OT 判断項目)。✓
- **Type consistency:** `CardView({card: ClientCard})` T1 ↔ T3/T5 一致。`activeCardId/setActiveCardId: string|null` T2 ↔ T3/T4。`pruneActiveId(activeCardId, visibleIds)` T2。`data.find(r=>r.card.id===id)?.card`(ClientCard)を CardView へ=マッパなし。`db.cards.get(cardId)` 戻り = ClientCard を CardView へ。✓

## Open Questions(OT 判断待ち)

### spec §8 由来(CC)
- **Q1**(CC, spec §8-1): mobile route パス `exams/[id]/cards/[cardId]`(plan 既定)で確定可か(代替 `exams/[id]/[cardId]`)。
- **Q2**(CC, spec §8-2): リサイズ clamp 値 = **table 最小 480px / peek 320–560px・既定 384px**(plan 本文に昇格済)で確定可か(Codex 抜け#5: 未確定だと裁量混入)。
- **Q3**(CC, spec §8-3): full-page 戻り導線 = ブラウザ戻るのみで足りるか、画面内「← 戻る」link(study/smart `router.push` 前例)を足すか。

### Codex cross-check 由来(OT 判断要)
- **Q4**(Codex 抜け#3/独立#8/リスク#3): **外クリックで閉じる範囲**。plan 既定 = peek+trigger の外で閉じるが **table cell 編集・filter・ActionBar・resize handle は除外**(誤クローズ/競合防止)。この割り切りで確定可か、それとも「× と Esc のみで閉じ、外クリックは採らない」に倒すか。
- **Q5**(Codex 抜け#1/独立#13/リスク#7): **exam_id 整合の扱い**。plan 既定 = `card.exam_id !== params.id` は **not-found 表示**(user_id 検証に加え exam membership も検証)。これで確定可か(直 URL で別 exam の card を踏んだ時の挙動)。

### plan に取り込み済み(Codex 由来・OT 判断不要)
- loading↔not-found 区別(抜け#9)→ T5 / Esc 競合 `defaultPrevented`(抜け#2)→ T4 / resize 割り切り mouse-only・user-select・window mouseup(抜け#4)→ T3 / smoke gate 位置を per-task から sprint 末へ(抜け#15)→ Sprint gate / route path consistency(抜け#14)→ Architecture 注記 / focus・tab 順(抜け#13)→ T4 / ActionBar 対策(抜け#6)→ T3 / mirror stale 許容明記(独立#10)→ T5 / 青枠 pinned 判定 smoke(抜け#12)→ Sprint gate。
