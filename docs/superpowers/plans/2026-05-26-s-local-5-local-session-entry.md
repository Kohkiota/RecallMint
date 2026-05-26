# S-local-5 mounted-page client-only local session entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `/app` (dashboard、 既に mount 済み = Server reach 不要) 上に **「保存済みカードで復習」** button を追加し、 click で Server Component route navigation を経由せず Client Component (`SessionRunner`) を overlay で mount する。 Dexie cards mirror 由来で session 開始 → 回答 → 完了 → overlay close で `/app` に戻る。 通信断状態でも session の開始 / 進行 / 完了 / Dexie pending 記録が成立する (= server reach 不要)。

**Architecture:** `SessionRunner` / `StudySessionHost` に optional prop `onNavigate?: () => void` (= 完了画面「ダッシュボードへ」 click の navigation を override) + `hideRetry?: boolean` (= 「もう一度」 button 非表示) を追加。 既存挙動は default で完全維持 (= 既存 62 test 含む regression なし)。 新規 `<LocalSessionEntry userId fsrsMode sessionLimit>` (client component、 button + state + overlay) を dashboard に配置、 click で `<StudySessionHost cards={[]} ... onNavigate={close} hideRetry={true}>` を overlay 内で mount。 cards は既存 `getDueCardsFromDexie` 経路で Dexie から取得 (S-local-3 で配線済)。

**Tech Stack:** Next.js 15 App Router / Drizzle / Dexie 4.4.2 / Vitest + fake-indexeddb + @testing-library/react / TS strict

---

## Plan-wide rules

- TypeScript strict / kebab-case file / PascalCase comp / camelCase fn
- 既存 SessionRunner / StudySessionHost / DashboardActions の挙動は無変更 (新 prop は optional、 default で既存 path)
- 既存 S-cache-3.1 (flush await)、 S-local-2 (PullTrigger)、 S-local-3 (Dexie cards read)、 S-local-4 (server fetch fallback) は無変更で連動
- Service Worker / app shell precache / `/app/study/smart` route 完全 offline 化は本 sprint 範囲外
- silent fallback: Dexie 失敗 / cards 0 件 / network 失敗 いずれも UI 警告は overlay 内 empty UI (=既存 host 文言) のみ
- 「オフライン」 という文言は **使わない** (= 完全 offline 新規起動を保証していると誤解されるため、 OT 明示)
- commit 規律: 1 commit (plan + 実装 + test) → review Critical 0 / Important 0 → `[reviewed]` tag

## 設計判断

### 1. UI 配置: 既存 button 残置 + 隣に追加 (OT C-1 採用)

`DashboardActions` (`grid-cols-2`) は無変更。 別 component `<LocalSessionEntry>` を dashboard 上 `<DashboardActions>` の直後に独立配置。 button 文言: **「保存済みカードで復習」** (= 「オフライン」 表記しない、 online でも触れる)。

### 2. URL は変えない (overlay/inline panel mode)

button click で `window.location` / `router.push` を呼ばない。 `useState<boolean>` でローカル `isActive` を切替、 active 時に full-screen overlay (z-50、 fixed) で `<StudySessionHost>` を mount。 navigation を一切発生させないため Server reach 不要。

### 3. 既存 SessionRunner / StudySessionHost の改修 (minimal, 後方互換)

- `SessionRunner` に prop 追加:
  - `onNavigate?: () => void` (= 完了画面「ダッシュボードへ」 click 時 `router.push('/app')` を override、 default で既存)
  - `hideRetry?: boolean` (= 「もう一度」 button を非表示、 default false)
- `StudySessionHost` に同 2 prop 追加 (受け取って SessionRunner に pass-through)
- 既存呼出 (smart page 経由) は新 prop を渡さない → default で既存挙動 100% 維持 → 既存 62 test + S-local-3/4 test に影響ゼロ

### 4. cards 取得経路

`<StudySessionHost cards={[]} userId={...} sessionLimit={...} fsrsMode={...} mode="smart">` で props.cards = [] を渡す。 host が S-local-3 の hybrid 切替で Dexie 優先 (= 1+ 件で session 起動)、 Dexie 0 件で empty UI (S-local-4 で host 集約)。 server fetch は一切経由しない (props.cards = [] で server fallback 試行はあるが内容が空のため empty UI に倒れる)。

### 5. 完了画面の挙動 (onNavigate / hideRetry の効き方)

完了画面 (`session-runner.tsx:333-369`):
- 「もう一度」 button: `hideRetry === true` のとき非表示 (= 同 overlay 内で次 session 開始は MVP では未対応、 overlay 閉じて再 button click で次 session)
- 「ダッシュボードへ」 button: 文言は **「閉じる」 に変更しない、 既存「ダッシュボードへ」 のまま** (= SessionRunner 内部は実際の navigation を区別せず、 親の callback に委譲する設計)。 click → 既存 flush 経路 (S-cache-3.1) → 成功時 / warning 再 click 時いずれも `onNavigate` 呼出 (provided なら、 default は `router.push('/app')`)

→ overlay モードでは `onNavigate = () => setIsActive(false)` で overlay 閉じる。 通常 smart route モードでは prop なしで既存 `router.push('/app')` (RSC fetch)。

### 6. overlay UX 細部

- backdrop 全画面 (`fixed inset-0 z-50 bg-white`)。 backdrop click では閉じない (誤閉じ防止、 答えた answer_events は Dexie に既保存だが UX 配慮)
- 右上に「× 閉じる」 button (= 中断、 confirm なし、 abandoned session 化は MVP 範囲外で省略)
- overlay 内コンテンツ: `<StudySessionHost cards={[]} ... onNavigate hideRetry>` を直接 render (existing Loading / empty UI / SessionRunner branch を流用)
- `navigator.onLine` 検知は **不使用** (online でも触れる、 smoke しやすい、 false positive 回避)

### 7. test 方針

- `SessionRunner` (拡張 test、 既存 62 case を壊さない):
  - `onNavigate` 提供時、 完了画面「ダッシュボードへ」 click → `onNavigate` 呼出 + `router.push` 不発火 (mockPush で assert)
  - `hideRetry={true}` 時、 「もう一度」 button が DOM に出ない
- `StudySessionHost` (拡張 test):
  - `onNavigate` / `hideRetry` が SessionRunner に pass-through される (mockSessionRunner が受け取る props で assert)
- `LocalSessionEntry` (新規 test):
  - 初期表示: button 「保存済みカードで復習」 visible、 overlay は出ない
  - button click → overlay (StudySessionHost mock 経由) が render、 `cards=[]` + `onNavigate` / `hideRetry={true}` で host に渡される
  - overlay 内の「× 閉じる」 click → overlay 消える、 button 再表示
  - host が `onNavigate` を呼ぶ (= 完了想定) → overlay 自動 close、 button 再表示

## ファイル構成

修正:
- `app/(app)/app/study/smart/_components/session-runner.tsx`: prop 追加 + 2 branch + 1 conditional
- `app/(app)/app/study/smart/_components/session-runner.test.tsx`: 拡張 test 2-3 case
- `app/(app)/app/study/smart/_components/study-session-host.tsx`: prop pass-through (+2 行)
- `app/(app)/app/study/smart/_components/study-session-host.test.tsx`: 拡張 test 1-2 case
- `app/(app)/app/page.tsx`: `<LocalSessionEntry>` 配置 (+5 行)

新規:
- `app/(app)/app/_components/local-session-entry.tsx`
- `app/(app)/app/_components/local-session-entry.test.tsx`

無変更:
- `lib/sync/*` (createStudySession / recordAnswerEvent / flushPendingEvents)
- `lib/cards/get-dexie-session-cards.ts` (S-local-3 で配線済)
- `lib/db/*` (server endpoint / mapper)
- `app/api/*`
- `DashboardActions` / `DashboardStats` / `PullTrigger`
- `app/(app)/app/study/smart/page.tsx` (route 経路は無変更)

---

## Task 1: SessionRunner + StudySessionHost に prop 追加

**Files:** Modify `session-runner.tsx` (+test) + Modify `study-session-host.tsx` (+test)

**目的:** 完了画面の「ダッシュボードへ」 navigation を親が override 可能にする (overlay モード対応)。 「もう一度」 button を非表示にする option も追加。

**制約:**
- 新 prop は **両方 optional**、 default で既存挙動 100% 維持
- SessionRunner の `handleDashboardNav` (= S-cache-3.1 click handler) の success path と warning re-click path **両方** で `onNavigate ?? (() => router.push('/app'))` を使う
- 「もう一度」 button は `if (!hideRetry)` で wrap、 hideRetry default false で既存と同じ
- StudySessionHost も 2 prop を受け取って SessionRunner に pass-through
- 既存 session-runner.test 62 case + study-session-host.test 7 case を **無変更で通過** (prop 未指定 = 既存挙動)

**完了条件:** vitest 拡張:
- SessionRunner: `onNavigate` 提供時 click → callback 呼出 + `mockPush` not called、 `hideRetry={true}` で 「もう一度」 button が `queryByRole({name:'もう一度'}) === null`
- StudySessionHost: `mockSessionRunner` の受け取る props に `onNavigate` / `hideRetry` が含まれる
- typecheck clean / 既存 regression なし

---

## Task 2: LocalSessionEntry 新規

**Files:** Create `app/(app)/app/_components/local-session-entry.tsx` + test

**目的:** dashboard 上に「保存済みカードで復習」 button + click で `<StudySessionHost>` を overlay mount。 navigation 経由なし。

**制約:**
- `'use client'` 宣言
- props: `userId: string` / `sessionLimit: number` / `fsrsMode: boolean`
- state: `isActive: boolean` (`useState`)
- initial render: `<Button>保存済みカードで復習</Button>`
- isActive=true 時 overlay (= `fixed inset-0 z-50 bg-white overflow-y-auto`) を render:
  - 右上 close button (X icon or 「× 閉じる」 文言)
  - 中央コンテンツ: `<StudySessionHost cards={[]} userId fsrsMode sessionLimit mode="smart" onNavigate={() => setIsActive(false)} hideRetry={true} />`
- close button click: `setIsActive(false)`
- host が `onNavigate` を呼ぶ (= SessionRunner 完了画面「ダッシュボードへ」) → 結果として close
- `navigator.onLine` は **使わない** (online でも触れる)
- 「オフライン」 文言は **使わない** (button label + overlay 内文言いずれも)

**完了条件:** vitest RTL 4-5 case (StudySessionHost mock):
- 初期: button visible、 overlay 不在
- button click → overlay 表示、 close button visible、 StudySessionHost が cards=[] / onNavigate / hideRetry=true で mount
- close button click → overlay 消える、 button 再表示
- StudySessionHost mock が `onNavigate()` を発火した想定 → overlay 自動 close
- 「オフライン」 文言が DOM のどこにも存在しないこと (regression guard)

---

## Task 3: page.tsx に LocalSessionEntry 配置

**Files:** Modify `app/(app)/app/page.tsx`

**目的:** dashboard に `<LocalSessionEntry>` を `<DashboardActions>` の下に並べる。

**制約:**
- import 追加 + JSX 配置 1 箇所のみ (合計 +5-7 行)
- props: `userId={user.id} fsrsMode={fsrsMode} sessionLimit={sessionLimit}` — fsrsMode / sessionLimit は **新規 SELECT** で取得 (現在の page.tsx は dueCount しか取らないため、 smart/page.tsx 同様の userSettings SELECT を追加)
- 既存 DashboardActions / DashboardStats / PullTrigger は無変更
- 既存 dashboard test は影響なし (= mock LocalSessionEntry や別 test で扱う、 page-level integration test 不在)

**完了条件:** typecheck clean、 既存 dashboard 描画 regression なし (=既存 test 通過)

---

## Task 4: 統合 verification

`pnpm exec tsc --noEmit` clean + `pnpm test` 全通過 (= 804 → ~810 想定、 +6-8 新 test、 既存 regression なし)。

---

## Task 5: stg smoke (Claude Code 実行、 CLAUDE.md 規律準拠)

OT push 後の Claude Code 実行 smoke:

1. **A. online entry**: `/app` → 「保存済みカードで復習」 button click → overlay 表示 → Dexie cards (S-local-2 で mirror 済) で session 開始 → 回答 → finished → 「ダッシュボードへ」 click → overlay 自動 close + dashboard に戻る (URL は `/app` のまま)。 IDB answer_events に sync_status='synced' で記録、 Network bulk POST 200 確認
2. **B. local-only marker proof**: Dexie 内 card に marker injection + due 過去化 → button click → overlay 内 session で marker 表示 → 「保存済みカードで復習」 経路が Dexie 由来である direct evidence (= S-local-3/4 と同方式)
3. **C. close mid-session**: button click → overlay → 1 問解いた状態で「× 閉じる」 → overlay close → dashboard 表示。 Dexie answer_events に当該 event が sync_status='synced' (or 直後 flush で synced) で残る確認
4. **D. online regression**: 既存「スマート復習（N 件）」 link click → 通常 smart route → 既存挙動

`navigator.onLine === false` simulate は環境制約 (Vercel Live iframe で chrome-error 飛び) のため SKIP 推奨、 unit test で 「button click → overlay → cards Dexie 由来」 経路は確認済 (= server reach 不要は構造的に保証)

---

## やらないこと (本 sprint 範囲外)

Service Worker / next-pwa / workbox / app shell precache / `/app/study/smart` route の完全 offline 化 / URL 直打ち offline 対応 / 新規タブ起動 / PWA install prompt / Clerk offline auth / dueCount local projection / dashboard stats local 化 / FSRS update client 計算 / card_mutations bulk push / conflict resolution / 画像 cache / `navigator.onLine` 検知 / abandoned session 自動記録 (mid-session close 時の Dexie status='abandoned') / overlay 内 next session 連続起動 (= 「もう一度」 は hide で MVP 簡素化、 user は overlay 閉じて再 button click で次 session 開始) / 「オフライン」 文言の追加 / online/offline state indicator。

## Plan 完了基準

Task 1-3 を 1 commit (plan + 実装 + test) に集約、 typecheck clean、 全 test 通過、 review Critical 0 / Important 0、 `[reviewed]` tag。 Task 5 stg smoke は OT push 後 Claude Code 実行。

## 分量

S-local-5 plan: ~210 行 / 上限 250

## 関連 doc

- design: `docs/superpowers/specs/2026-05-26-s-local-1-design.md` (Phase β + 部分 γ′)
- 棚卸: `docs/superpowers/sessions/2026-05-26-localdb-inventory.md`
- 前 sprint plan: `docs/superpowers/plans/2026-05-26-s-local-4-offline-smart-session.md`
- 既存 hybrid: `app/(app)/app/study/smart/_components/study-session-host.tsx`
- 既存 await navigation: `app/(app)/app/study/smart/_components/session-runner.tsx:333-369` (S-cache-3.1)
- 既存 PullTrigger / cards mirror: `app/(app)/app/_components/pull-trigger.tsx` (S-local-2)
