# S-local-4 smart session: server `getSessionCards()` failure fallback (offline 演習 MVP の前段)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** smart session の server side `getSessionCards()` が throw した場合 (DB 不調 / Drizzle 例外 / transient 5xx / timeout 等) でも page render を継続し、 client (Dexie cards mirror) で session を起動できる状態にする。 これにより **server reach OK だが DB 起源の障害** に対する resilience を獲得する。 同時に旧 page.tsx 内の 「ありません」 早期 return を StudySessionHost に集約し、 Dexie + server 両方 0 件のときの empty UI を一元判断にする。

**「真の offline 演習成立」 ではない (scope 注記)**: 本 sprint は **server reach が前提**。 真の offline (browser → Vercel reach 不能) では `/app/study/smart` への新規 navigation 自体が成立しない (Server Component の document / RSC fetch が必須、 Service Worker / app shell cache なし、 `prefetch={false}` 設定で route precache なし)。 真の offline navigation 達成には別 sprint で Service Worker / app shell / route precache / mounted-page 内 client-only session 等が必要 (§「真の offline 達成に必要な追加 work」 で列挙)。

**Architecture:** `page.tsx` で `getSessionCards()` を try/catch、 throw 時 `serverCards = []` で StudySessionHost に渡す。 既存「cards.length === 0 → 「ありません」 page」 早期 return を削除し、 empty 判定は StudySessionHost に集約。 StudySessionHost mount 時 Dexie 優先 + 0 件で server fallback (既存 S-local-3) + 両方 0 件で empty UI 表示。 session-runner / Dexie schema / bulk endpoint は無変更。

**Tech Stack:** Next.js 15 App Router / Drizzle / Dexie 4.4.2 / Vitest + fake-indexeddb + @testing-library/react / TS strict

---

## Plan-wide rules

- TypeScript strict / kebab-case file / PascalCase comp / camelCase fn
- server authoritative: FSRS state は server submit-review-tx 維持、 mirror は read-only
- silent fallback: server fetch fail / Dexie fail いずれも console / UI 警告なし
- 既存 S-cache-3.1 (flush await + warning UI)、 S-local-2 (PullTrigger)、 S-local-3 (Dexie cards read + server fallback) は無変更で連動
- commit 規律: 1 commit (plan + 実装 + test) → review Critical 0 / Important 0 → `[reviewed]` tag

## 達成範囲と未達範囲 (重要)

**達成する**:
1. `getSessionCards()` throw 時に page render 継続 (旧: cards.length === 0 早期 return → 「ありません」 / throw → error boundary)
2. cards=[] で StudySessionHost に進める → Dexie cards mirror >= 1 件あれば session 起動 (DB 起源障害時の救済経路)
3. Dexie + server 両方 0 件のとき empty UI を host で一元表示 (旧 page.tsx 文言移植)

**達成しない (誤称回避)**:
- **真の offline 状態での `/app/study/smart` 新規 navigation** — RSC / document fetch が browser → Vercel reach を必須とするため。 既に mount 済みの /app からの SPA navigation でも `?_rsc=...` fetch が走り、 offline では fail
- offline 中に既に mount 済の session で **continue** することは別問題 (回答 → answer_events Dexie 即記録 → 完了画面 → 「ダッシュボードへ」 warning UI 経路は S-cache-3.1 で既達。 ただし dashboard 遷移自体は RSC fetch 必要)
- offline で session を **新規開始** することは本 sprint で達成しない

## 設計判断 (OT 必須 9 項目への回答)

### 1. server fetch fail 時に Dexie cards で session 起動

`page.tsx` の `await getSessionCards()` を try/catch で囲み、 throw 時 `serverCards = []`。 cards 配列が空でも 「ありません」 page で早期 return しない (StudySessionHost に常に進む)。 StudySessionHost mount 時 Dexie cards が >=1 件あれば session 起動 (既存 S-local-3 path)。 ただし **本経路が機能するのは server reach OK で page render が完了したケースのみ** (真の offline では page 自体が届かない)。

### 2. local cards あり + server fail → 続行

(1) と同じ。 server cards = [] のとき StudySessionHost が Dexie cards で進む。

### 3. study_sessions Dexie 保存

既存 `createStudySession` (S-cache-1) を変更なしで使用。 cards 確定後に session を作成 → empty なら作成しない (空 session で意味なし)。

### 4. answer_events Dexie pending 保存

既存 `recordAnswerEvent` (S-cache-1) を変更なしで使用。 session-runner.tsx / review-events.ts いずれも touch しない。

### 5. flush 失敗 warning UI で dead-end 回避

既存 S-cache-3.1 (`session-runner.tsx:347-367`) を変更なしで使用。 session 中に offline になった場合: 完了画面 「ダッシュボードへ」 click → flush 失敗 → warning UI → 再 click で直接 push (既存挙動)。 ただし「直接 push」 = `router.push('/app')` も RSC fetch を要するため、 真の offline では navigation 自体が完了しない可能性あり (= S-cache-3.1 もまた server reach 前提)。

### 6. online 復帰で pending events 送信

既存 review-events.ts の「次トリガで再 flush」 設計を維持。 起動 / 復帰 / online event トリガ追加は別 sprint。

### 7. local cards 空時の表示・fallback・エラー文言

Dexie 0 件 + server 0 件 = StudySessionHost 内で empty UI render (元 page.tsx の文言移植)。 server fail と「全件解いた」 を文言上区別しない。

### 8. staleness の扱い

stale 警告 UI なし。 Dexie mirror が古い → user 回答 → flush → server で reconcile → 次 pull で更新 → 次 session は最新。 削除済 card が Dexie に残るケースも server flush 時 event_id 冪等で副作用なし、 次 PullTrigger で mirror 復元。

### 9. smoke 手順 (marker injection 維持)

S-local-3 で確立した「Dexie cards の question_text に marker prepend → session で marker 表示 → local read engage 証明」 を本 sprint でも引き継ぐ。 server fetch fail 経路の実機 smoke は環境制約で simulate 困難 (= 後述)、 vitest unit test で代替。

## ファイル構成

修正:
- `app/(app)/app/study/smart/page.tsx`: server fetch try/catch + no-cards page 削除
- `app/(app)/app/study/smart/page.test.tsx`: 既存 test update + server fetch throw test 追加
- `app/(app)/app/study/smart/_components/study-session-host.tsx`: empty UI 追加 (Dexie + server 両方 0 件)
- `app/(app)/app/study/smart/_components/study-session-host.test.tsx`: empty UI test 追加

新規 / 削除: なし、 schema / migration 変更なし

無変更: `lib/cards/get-session-cards.ts` / `lib/cards/get-dexie-session-cards.ts` / `lib/sync/*` / `app/api/cards/pull` 等 / `pull-trigger.tsx` / `session-runner.tsx`

---

## Task 1: page.tsx server fetch try/catch + no-cards page 削除

**Files:** Modify `app/(app)/app/study/smart/page.tsx` + `page.test.tsx`

**目的:** server `getSessionCards()` throw でも page render 継続、 cards=[] で StudySessionHost に進む。 旧「ありません」 page を削除し empty 判定を host に集約。

**制約:**
- `await getSessionCards(user.id, sessionLimit)` を try/catch、 throw 時 `serverCards = []` (silent)
- catch 内 console.log / logger.warn なし
- `cards.length === 0` 早期 return 削除 → 常に StudySessionHost に進む
- `<StudySessionHost cards={serverCards} ... />` の prop 名は維持 (S-local-3 既存 hybrid 経路がそのまま動く)

**完了条件:** vitest 拡張:
- 既存「cards 0 件 → 『ありません』 表示」 test を update (cards 0 件でも StudySessionHost render、 empty UI 表示は host 側 test)
- 新規 test: `getSessionCards` throw → StudySessionHost に cards=[] で進む (page render fail しない)
- 既存「cards >= 1 件」 「userSettings fallback」 系 test は無変更で通過

---

## Task 2: StudySessionHost に empty UI 追加

**Files:** Modify `app/(app)/app/study/smart/_components/study-session-host.tsx` + Modify `study-session-host.test.tsx`

**目的:** Dexie 0 件 + server 0 件 のとき empty UI を render。 既存 S-local-3 hybrid 切替 logic を維持しつつ chosen 0 件分岐を追加。

**制約:**
- useEffect 内 cards 確定 logic は既存維持 (Dexie 優先、 0 件 / throw → server fallback)
- 新規分岐: `chosen.length === 0` のとき `createStudySession` 呼ばず `setResolvedCards([])` で終了
- render 4 分岐: `resolvedCards === null` → Loading / `resolvedCards.length === 0` → empty UI / `sessionId === null` → Loading / else → SessionRunner
- empty UI 文言: 「現在復習する card はありません」 + 「ダッシュボードへ」 link (`/app`、 旧 page.tsx 文言移植)

**完了条件:** vitest RTL 既存 4 case + 拡張 3 case:
- Dexie 0 + server 0 → empty UI 表示 + `createStudySession` not called + SessionRunner not rendered
- Dexie 0 + server 1+ → server fallback で SessionRunner render (empty UI 出ない)
- Dexie throw + server 0 → silent fallback で empty UI

---

## Task 3: 統合 verification (commit 前)

`pnpm exec tsc --noEmit` clean + `pnpm test` 全通過 (既存 regression なし)。

---

## Task 4: stg smoke 手順 (commit 後 OT 実施)

**目的:** Dexie engage 確認 + online regression 確認。 真の offline / server fetch fail の実機検証は対象外 (= 困難 + unit test カバー済)。

**実機検証 (Claude Code が DevTools MCP で実行)**:

1. **Test #A (Dexie engage、 online)**: S-local-3 と同方式 — Dexie 内 card の question_text に marker prepend → `/app/study/smart` → session で marker 表示 (= server cards でなく Dexie cards 由来である direct evidence)
2. **Test #B (empty UI fallback)**: Dexie cards table clear + (server 側 due card がない user account or 全 card 解き切った状態) → `/app/study/smart` → empty UI「現在復習する card はありません」 + 「ダッシュボードへ」 link 表示確認。 server に due card がまだある場合は server cards で session 起動するため empty UI は出ない (= 仕様通り、 server fallback 経路 engage)
3. **Test #C (online regression)**: 既存 online flow が壊れていないこと (回答 → finish → ダッシュボードへ → S-cache-3.1 await → /app)

**実機検証から除外 (unit test カバー済)**:

- server `getSessionCards()` throw 時の Dexie fallback: 実機で DB throw を仕込むのは困難 (Network panel offline は document/RSC fetch を block するため page 自体が届かず、 server 内 throw シミュレーションにならない)。 vitest `page.test.tsx` の `mockGetSessionCards.mockRejectedValueOnce` で再現済
- 真の offline navigation: Service Worker 等が必要、 本 sprint scope 外
- offline 中に session 開始 + 回答 → online 復帰 flush: 同様に真の offline simulate 必要、 vitest で recordAnswerEvent / flushPendingEvents 動作は既往テスト済

**完了条件:** OT 実機 smoke で Test #A + #C 必須 PASS、 #B は環境次第 (server side due card 状態に依存) で PASS / SKIP 報告可

---

## 真の offline 達成に必要な追加 work (本 sprint で実装しない、 別 sprint 候補)

**目的**: browser が完全 offline (Vercel reach 不能) でも `/app/study/smart` を起動できる状態を作る。 段階的に:

- **候補 ε-1: Service Worker / app shell precache**: `/app` `/app/study/smart` の HTML を browser に precache、 offline 時も page document を返せる。 Next.js では next-pwa / Workbox 等が一般的。 RSC payload は別途処理 (precache or fallback HTML)
- **候補 ε-2: mounted-page 内 client-only smart session 開始導線**: `/app` 上に「offline でも開始」 ボタンを追加し、 RSC navigation を経ずに client only で SessionRunner を mount する subpath / dialog。 cards は Dexie 由来固定
- **候補 ε-3: route precaching / static prerender**: smart session の shell を静的化 (cards 取得は client) してビルド時 prerender
- **候補 ε-4: online detection + 事前 prefetch**: `navigator.onLine` + `online` event で smart page を pre-fetch しておき、 offline 化前に router cache に乗せる

これらは S-local-5 以降の別 sprint で取捨選択。 本 S-local-4 が「offline 演習 MVP **の前段**」 と呼べるのは、 これらの追加 work をしない限り真の offline 演習が成立しないため。

## やらないこと (本 sprint 範囲外)

Service Worker / app shell precache / 画像 cache / OCR offline (= 不可能) / FSRS update client 計算 / dueCount local projection / card_mutations bulk push / user_settings Dexie 化 / Δ pull / conflict resolution 本実装 / マルチデバイス sync UX / online 復活時 visibilitychange / online event トリガ / stale 警告 UI / per-exam / due-soon mirror / random shuffle / page level logger.warn / Sentry 通知 / 真の offline navigation 成立 (上記 ε 候補)。

## Plan 完了基準

Task 1-2 を 1 commit (plan + 実装 + test) に集約、 typecheck clean、 全 test 通過 (800 → 804、 +4 net)、 review Critical 0 / Important 0、 `[reviewed]` tag 付与。 Task 4 stg smoke は OT (Claude Code 経由) で commit 後実施。

## 分量

S-local-4 plan: ~215 行 / 上限 250 (前版 182 → +33 行、 達成 / 未達範囲明示 + ε 候補追加)

## 関連 doc

- design: `docs/superpowers/specs/2026-05-26-s-local-1-design.md` (Phase γ 該当)
- inventory: `docs/superpowers/sessions/2026-05-26-localdb-inventory.md`
- 前 sprint plan: `docs/superpowers/plans/2026-05-26-s-local-3-smart-session-local-read.md`
- 既存 hybrid: `app/(app)/app/study/smart/_components/study-session-host.tsx` (S-local-3 で構築)
- 既存 await navigation: `app/(app)/app/study/smart/_components/session-runner.tsx:347-367` (S-cache-3.1)
- 既存 PullTrigger: `app/(app)/app/_components/pull-trigger.tsx` (S-local-2)
