# S-cache-2b 検証記録 (staleTimes.dynamic=30 試行 → 失敗実験として close)

> **状態**: **失敗実験として close 済 (commit 1beb915 → amend で全 staleTimes 関連変更を撤回)**。
> 関連 commit: `1beb915` (amend 後の最終形は本 doc のみ残置、 source / test は S-cache-2a `a941b7c` 状態に巻き戻し)
> 関連 plan: `docs/superpowers/plans/2026-05-25-s-perf-2.md` §「やらないこと: staleTimes → S-cache-2」

## 0. TL;DR (失敗結論)

- `next.config.ts` に `experimental.staleTimes.dynamic = 30` を入れ、 stale 表示防止のため server action 4 件で `revalidatePath` を追加 (S-cache-2a の部分撤回 3 件 + bulk route 新規 1 件) する設計を試行
- stg deploy 後の Playwright MCP smoke で **N1/N2/N3 全 FAIL**: 通常 Link navigation 再訪問で `?_rsc=` fetch が発生し続けた (期待 0 本 / 実測 1 本)
- 公式 docs では「staleTimes.dynamic で normal navigation も cache hit する」 と読めるが、 RecallMint 現構成 (全 Link `prefetch={false}`、 全 page `auth()` 経由 implicit dynamic、 Clerk middleware) では effective でない
- prefetch={true} に部分復活して staleTimes を effective 化する案は **S-perf-1 で解消した RSC prefetch 並列爆発を再導入するリスクが高い**ため不採用
- 全 staleTimes 関連変更を撤回、 commit を amend して「失敗実験の記録」 として close。 次は **ローカル DB (Dexie pre-sync) 優先化**へ進む方針

## 1. 試行した変更 (撤回済)

### config 変更
- `next.config.ts`: `experimental.staleTimes.dynamic = 30` 追加 → **撤回**
- `static` は未設定 (全 Link が `prefetch={false}` で該当経路無し)

### server action / route handler 4 件で revalidatePath 追加 → **全件撤回**
- `app/(app)/app/cards/[id]/_actions/update-card.ts`: `/app/cards/${cardId}` 再追加 (S-cache-2a 部分撤回相当) → 撤回
- `app/(app)/app/exams/[id]/_actions/update-card-field.ts`: `/app/exams/${row.examId}` 再追加 → 撤回
- `app/(app)/app/settings/_actions/save-session-limit.ts`: `/app/settings` 再追加 → 撤回
- `app/api/review-events/bulk/route.ts`: `/app` 新規追加 (1 件以上書込成功時のみ) → 撤回。 撤回理由は M4 race condition (§ 5) に詳述

### 維持 (S-cache-2a state を保持)
- 既存 cross-page revalidate: delete-exam → /app/upload、 delete-card → /app/exams/[id]、 update-card → /app/exams/[examId]、 update-card-field → /app/cards/[cardId]、 process → /app/upload + /app
- client component の `router.refresh()` (delete-exam-button / fsrs-mode-form / session-runner / exam-status-live)

## 2. 性能検証結果 (主指標、 全 FAIL)

主指標は **通常 navigation 再訪問** (back/forward は default で cache hit 動作のため対象外)。 Playwright MCP `performance.getEntriesByType('resource')` で `?_rsc=` request を計測。

| # | 経路 | 期待 2 回目挙動 | 実測 | 判定 |
|---|---|---|---|---|
| N1 | `/app` → `/app/settings` → `/app/exams` → `/app/settings` (2 回目) | `?_rsc=/app/settings` fetch 0 本 | **1 本 (1772 ms)** | **FAIL** |
| N2 | `/app` → `/app/exams` → `/app/settings` → `/app/exams` (2 回目) | fetch 0 本 | **1 本 (2505 ms)** | **FAIL** |
| N3 | `/app/exams` → `/app/exams/[id]` → `/app/settings` → `/app/exams/[id]` (2 回目) | fetch 0 本 | **1 本 (2201 ms)** | **FAIL** |

### 補助計測 (default 挙動の sanity check)
- back navigation (`window.history.back`): /app/settings cache hit、 0 fetch ✓
- forward navigation (`window.history.forward`): 同上、 0 fetch ✓
- 通常 Link click 再訪問: **1 fetch (FAIL)**

→ Next.js 15 default の back/forward cache は動作。 staleTimes.dynamic=30 による「normal navigation cache hit」 は effective ではない。

### Response header 補助情報 (`?_rsc=` 直叩き)
- `cache-control: private, no-cache, no-store, max-age=0, must-revalidate` (Vercel 強制、 server-side dynamic 由来)
- `x-vercel-cache: MISS` (CDN cache 不使用)
- `x-nextjs-*` header: 無し (production build で suppress)

## 3. Mutation 後 stale 防止 smoke (補助、 PASS だが意義無し)

N1-N3 で「cache hit 自体起きない」 ことが判明したため、 mutation 後の stale 表示は理論上発生しない (毎回 fresh fetch されるため)。 = 「PASS」 として観察されるが、 PASS の理由が「staleTimes 効いていない」 ためで、 revalidatePath の効果検証としては意義なし。

| # | scenario | 結果 | 備考 |
|---|---|---|---|
| M1 | update-card 後の /app/cards/[id] 再訪問 | SKIP (card editor 自動経路困難) | OT 手動推奨 |
| M2 | update-card-field 後の /app/exams/[id] 再訪問 | SKIP (React 制御 input 自動 commit 困難) | inline editor は局所 state で UI 完結 |
| M3 | save-session-limit 後の /app/settings 再訪問 | PASS (initial value=5) | ただし毎回 fresh fetch のため当然 PASS |
| M4 | smart 復習 → /app 再訪問 dueCount 確認 | PARTIAL (§5 race condition 参照) | bulk route の revalidatePath が間に合わず初回 stale |

## 4. 既存導線 regression check (PASS)

| # | scenario | 結果 |
|---|---|---|
| R1 | delete-exam → /app/exams で消える | SKIP (共有 stg データ破壊回避) |
| R2 | delete-card → /app/exams/[id] で消える | SKIP (同上) |
| R3 | fsrs mode toggle off → on サイクル | PASS (server action POST 確認、 値 persist) |

## 5. M4 race condition の整理 (staleTimes と独立した既存 issue)

### 観測タイミング (Resource Timing 詳細)
- t=883342 ms: 「ダッシュボードへ」 click → /app RSC fetch 開始
- t=883345 ms: `/api/review-events/bulk` POST 開始 (session-runner の `completeStudySession` → `flushPendingEvents`)
- t=883770 ms: /app RSC fetch 完了 (dur 428 ms) ← **dueCount=6 pre-submit で render**
- t=890921 ms: bulk POST 完了 (dur 7576 ms) ← revalidatePath('/app') 発火するが /app は既に render 済

### 結論
- 「session 完了 → 即 navigation」 では bulk POST が間に合わない (/app SSR ~400 ms vs bulk POST ~7.5 s)
- staleTimes 設定有無に関わらず同じ race (毎回 fresh fetch 経路でも、 server-side query が pre-submit データを返す)
- `revalidatePath('/app')` in bulk route は 7.5s 後に発火するが、 既に render 済の表示は変わらない
- = **staleTimes では解決しない independent issue**。 staleTimes 関連変更 (revalidatePath('/app') in bulk route 含む) は撤回し、 M4 はローカル DB 移行または flush 完了待ち設計で別途扱う

### 対応案の比較 (本 sprint では実装せず、 次以降の判断材料)

| 案 | 内容 | コスト | 副作用 | UX |
|---|---|---|---|---|
| A | 「ダッシュボードへ」 押下時に `flushPendingEvents()` await | 低 | 1-8s lag、 loading 状態 UI 要 | もたつき、 ただし確実 |
| B | /app dueCount を client component 化 | 中 | client fetch lag、 stats endpoint 拡張 | flash あり、 体感マシ |
| C | ローカル DB (Dexie) 派生で dueCount を local-first 化 | 高 (Dexie pre-sync 必要) | スコープ大、 ただし perf 抜本改善 | 最良 |
| D | revalidatePath('/app') in bulk のみ (S-cache-2b 当初案) | 低 | 上記計測通り race 残置 | NG (既知) |

**推奨**: M4 race は **C (ローカル DB pre-sync)** に内包する方向。 短期的に A も検討可だが、 次 sprint の方針 (ローカル DB 優先) と整合させる。

## 6. 撤回の根拠

### なぜ撤回が妥当か
1. **主目的未達**: N1-N3 で `?_rsc=` 削減が全 FAIL、 staleTimes 化の効果なし
2. **追加 revalidatePath が冗長化**: staleTimes が effective でない以上、 S-cache-2a で削除した「同 path 上 mutation 後の redundant revalidate」 を復活させる意味がない
3. **prefetch={true} 部分復活は採用しない**: S-perf-1 で /app dashboard 5 並列 / /app/exams 7 並列 / /app/settings 9 並列の RSC prefetch 爆発を抑制した。 staleTimes を effective 化するためだけに prefetch を戻すと並列負荷が再増、 ROI 負
4. **M4 race は別 issue**: revalidatePath('/app') in bulk route は race を防げない (上記 §5)。 ローカル DB 移行または flush 完了待ち設計で扱う方が筋
5. **コスト**: 履歴に「効かない設定 + 効かない設定を補完する revalidatePath」 を残す技術負債を回避

### staleTimes が効かなかった原因 (調査結果サマリ)
公式 docs では「staleTimes.dynamic で normal navigation も cache hit する」 と読める引用が複数あるが、 実装上は RecallMint 構成で effective でない。 詳細推定:
- Next.js 15.5.x 系で `<Link prefetch={false}>` 経由 navigation で取得した RSC を Client Router Cache に格納しない (or 格納しても staleTimes 対象外) 挙動の可能性
- `auth()` (cookies()) を layout / page で使う全 dynamic page では client cache 対象外の可能性 (未確証)
- Clerk middleware が頻繁な session token refresh で何らかの cache invalidation を起こしている可能性 (未確証)
- 確定には minimal Next.js 15 reproducer での再現確認が必要。 本 sprint では実施せず

## 7. 次方針

### 採用する方向
- **ローカル DB 優先化 (Dexie pre-sync)**: server fetch 自体を減らす根本解決。 stale 防止と perf 改善を両立
- S-perf-1 の prefetch={false} 抑制は維持 (並列 RSC 爆発を再発させない)
- S-cache-2a の revalidatePath 整理 (削除 5 + 縮小 1 + 追加 1 = 残置 4 cross-page) は維持

### 採用しない方向
- staleTimes 再導入 (本実験で effective でないと観測済)
- prefetch={true} 部分復活 (S-perf-1 と矛盾)
- hover prefetch 検討 (S-perf-2 T6 で skip 判定済)
- M4 race の表面的 fix (ローカル DB 移行に内包する方が筋)

## 8. 関連参考

- 試行 commit: `1beb915` (amend 前) → amend 後は本 doc のみ残置
- 前 sprint: `a941b7c` (S-cache-2a revalidatePath 整理)
- 関連 plan: `docs/superpowers/plans/2026-05-25-s-perf-2.md` §「やらないこと」
- 関連 lesson: `docs/superpowers/lessons/2026-05-25-link-prefetch-amplifies-server-load.md`
- Next.js docs 引用:
  - [staleTimes ref](https://nextjs.org/docs/app/api-reference/config/next-config-js/staleTimes)
  - [Next.js 15 Client Cache changes](https://nextjs.org/blog/next-15)
  - [Prefetching guide](https://nextjs.org/docs/app/guides/prefetching)
