# in-place プラン変更 sprint — 実装セッション (T11 / T12 / T6 / T7 / T8)

日付: 2026-06-03 / 実装方式: `superpowers:subagent-driven-development` (task 単位 fresh subagent + 2 段 review)
spec: `docs/superpowers/specs/2026-06-02-in-place-plan-change-design.md` / plan: `docs/superpowers/plans/2026-06-02-in-place-plan-change.md`

## 結論

方針C のバックエンド残 (T11 action / T12 webhook) + UI 全 3 タスク (T6 page・card / T7 modal・banner / T8 entry・success banner)
を実装完了。全 commit **tag 無し** (combined OT smoke まで保留)。全 review (spec compliance + code quality canonical) 通過、
最終クロスレイヤー統合 review も Critical/Important 0。`pnpm test` 1336 pass / 109 files、`pnpm build` clean、`tsc` clean。

## commit (develop)

| task | commit | 内容 | review |
|---|---|---|---|
| T11 | `0416924` | changePlan/cancelDowngrade で予約 3 列 set/clear + ブロックを DB 列ベース化 | spec ✅ / quality C0 I0 Minor3 (#1 user-scope assertion fix) |
| T12 | `7607134` | webhook 発効後 release gate + `subscription_schedule.released` handler | spec ✅ / quality C0 I0 Minor3 (全 stylistic) |
| T6 | `fea94c5` | upgrade page: pro+year redirect 撤廃 + paid sub 状態取得 + 下位選択可/予約ブロック | spec ✅ / quality C0 I0 Minor4 (#1 .toBeDisabled / #2 role=status fix) |
| T7 | `6d0af95` | 確認 modal (`components/ui/confirm-dialog.tsx`) + ダウングレード予約取消 banner | spec ✅ / quality C0 I0 Minor6 (全 spec-accepted/cosmetic) |
| T8 | `6d63a36` | entry 統一 (settings/dashboard「プラン変更」) + `/app` billing banner + success_url 統合 | spec ✅ / quality C0 I0 Important2→fix / Minor3 |

(前提既存 tag 無し: T3 `ab1a7d4` / T4 `f1b99ec` / T5 `e452db4` / T10 `0ca575e`。schema T9 `e6bd342` は migrate 済 [no-review]。)

## T8 Important fix (適用済み)

- #1 `cancel` banner copy に producer 無し → spec §7.5 が「Portal 経路・banner 統合は任意」と明記 = forward-provisioning。
  `billing-banner.tsx` にその旨コメント追記 (wiring 変更なし)。
- #2 dismiss button tap target 24px (`icon-xs`) < mobile bar → `size="icon"` (32px) に引上げ。

## 記録のみ (未 fix の Minor / 設計上の trade-off)

- T7: confirm-dialog は initial focus + Esc + backdrop のみ (full Tab focus-trap なし) = spec 許容範囲。backdrop は div+onClick (Esc で dismiss 可)。
- ~~T7: 予約取消 banner の plan ラベルが冗長~~ → **解決済 (commit `234175a`)**: OT 判断で「{tier} {interval}へ変更予約中（{date}）— 取消」形式に短縮 (例「Standard 月額へ変更予約中（2026/07/01）— 取消」)。「ダウングレード」語も廃し「変更予約」に統一。cosmetic copy、wiring 不変、tag 無し。
- T8: legacy `?checkout=success` (deploy 跨ぎ in-flight Checkout) は banner 無視で no-op。webhook が plan 付与するため実害は success banner 欠落のみ・窓も極小 → 受容。
- T8: `role="status"` は SSR 初期描画のため SR の auto-announce はされない (読み上げ順には載る)。
- webhook の 3 列 clear predicate が 3 種 (`stripeCustomerId` / `scheduledDowngradeScheduleId` / `users.id`) — 1user:1sub 不変条件 (`stripeCustomerId` unique) 下で全て安全。

## クロスレイヤー整合 (最終統合 review で確認)

1. ダウングレードライフサイクル: action 書込 3 列 ↔ webhook gate 読取 (#1 schedule.id / #5 targetPriceId) ↔ released handler clear ↔ UI block/banner — フィールド意味一致。
2. §5.5 ブロック: action と UI が同一 source (DB 列 `scheduledDowngradeScheduleId` + getPendingState の pending/cancel) を使用、乖離なし。
3. operationId: changePlan/cancelDowngrade を post する全 UI form が hidden input 保持 (modal=confirm 時生成、cancel banner=per-render)。
4. billing kind: new (success_url) / upgrade・downgrade (changePlan redirect) は producer 有、cancel は §7.5 forward-provision。orphan `?checkout=success` reader なし。

## 次の一手 (OT)

1. **OT smoke 実行**: `docs/superpowers/sessions/2026-06-02-in-place-plan-change-behavior-smoke.md` の Smoke 1-5 (backend) + 本 doc 追記の UI smoke。
   課金 API 実走 + test clock 前進 + Stripe 本番/test 環境 = CLAUDE.md 上 OT 担当。
2. **NG なし確認後**: 10 commit (T3 `ab1a7d4` / T4 `f1b99ec` / T5 `e452db4` / T10 `0ca575e` / T11 `0416924` / T12 `7607134` / T6 `fea94c5` / T7 `6d0af95` / T8 `6d63a36` / T8-copy `234175a`) に `[reviewed]` を `git rebase` で一括付与 (OT GO 後に Claude Code が提案・実行)。
3. ~~copy 論点~~ → 解決済 (`234175a`)。Stop hook が tag 無しで turn 終了を妨げる場合は bypass 可 (smoke 待ちの正当状態、`[reviewed]` 先付け禁止)。
