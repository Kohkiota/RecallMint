# 軽微 fix / 未決事項メモ

本 sprint の主スコープ外として残った軽微 fix・未決事項を記録する。 各項目に「経緯」「現状」「実装するかどうかの判断軸」を 1-2 段落で。 実装する場合は別 sprint or follow-up commit。

---

## ChangePlan ガードと Portal 解約の race (両 set 状態の瞬間成立)

**経緯**: プラン変更 UI の予約表示実装 (2026-06-03) に伴う解約まわり調査で判明。 詳細調査結果は本 commit と同 turn のコード調査出力に。

**現状**:
- 自前 UI 経由の `changePlan` には §5.5 ガード (`app/(app)/app/upgrade/actions.ts:106-112`) があり、 `pending.cancelScheduled` も block 条件に含まれる → 解約予約後にダウングレード予約は弾かれる (片方向は塞がれている)。
- 逆方向 (ダウングレード予約成立後の Customer Portal 解約) は **アプリ側で止められない** (Portal は外部 UI で自前ガードが効かない)。 webhook 経由で DB に `cancel_at` が set されるが、 `.updated` handler の SET 句は scheduled 3 列を touched しない (`app/api/webhooks/stripe/route.ts:252-261` の comment 明示) → DB に **「両方 set」 状態が path 上成立する**。
- 「両方 set」 状態は後続の `.deleted` handler (`route.ts:298-334`) の scheduled 3 列冪等 clear、 および release gate (`route.ts:374-426`) の mismatch path (notifyOps + no-op、 `:386-404`) で integrity が保たれる (調査済)。
- UI 側は cancelAt 優先表示 (`app/(app)/app/settings/page.tsx`、 本 commit) で「両方 set」 への defensive 対応済。

**race の具体経路**: ダウングレード予約成立 (DB 3 列 set 完了) と同時並行で別 device から Customer Portal 解約が走った場合、 webhook 順序によって瞬間的に DB 両方 set が起きうる。 アプリ handler は冪等で integrity を保つ (調査済) が、 ロックは無い。

**実装するかどうかの判断軸**:
- 影響: 瞬間的な DB 状態のみ。 ユーザ可視の破綻はなし (cancelAt 優先で表示は一意、 後続 webhook で正しく解消)。
- 必要性: 低 (handler の冪等性で吸収済、 OT 観測通知も不要レベル)。
- 実装するなら: `createBillingPortalSession` (`app/(app)/app/settings/actions.ts:7-24`) で `user.scheduledDowngradeScheduleId != null` の場合に Portal を開かず案内文を返す、 等。 ただし「ダウングレード予約中は解約させない」 は UX 制約として強すぎる可能性あり (= ユーザは予約取消 → 解約の 2 step を強いられる)。 OT 判断要。

**結論**: 要否は別途判断、 本 sprint では実装しない。
