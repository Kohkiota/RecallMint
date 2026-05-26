# S-cache 系列 series close (S-cache-2 〜 S-cache-3.1)

- 記録日: 2026-05-26
- 種別: session log / sprint series 終了記録
- 関連 commit: a941b7c (S-cache-2a) / 4350b43 (S-cache-2b) / 44b0a24 (S-cache-3.1)

## 経緯

dashboard 表示の M4 race (= スマート復習セッション完了後の「ダッシュボードへ」
で /app SSR が flush 完了前に走り、 dueCount が pre-flush 値で描画される
race) を解消するための perf / cache 系 mini sprint シリーズ。

### sprint 別総括

| sprint | commit | スコープ | 結果 |
|--------|--------|---------|------|
| S-cache-2a | a941b7c | submit-review action の revalidatePath 整理 (削除 5 + 縮小 1 + 追加 1) | review 通過、 stg 反映 |
| S-cache-2b | 4350b43 | staleTimes 設定で client cache invalidation を狙う | staleTimes は prefetch={false} 環境で no-op と判明、 設定撤去 |
| S-cache-3.1 | 44b0a24 | 完了画面「ダッシュボードへ」 button で `flushPendingEvents()` を await してから navigation | M4 race 解消、 stg smoke PASS |

### S-cache-2b の no-op 経緯

S-cache-2b 試行時 spec: `staleTimes.dynamic=30` + bulk route 内
`revalidatePath('/app')` で race 解消を試行。

実装後の挙動観察 (`docs/superpowers/sessions/2026-05-25-s-cache-2b-staletimes-verification.md`):
- prefetch={false} 環境では staleTimes の client cache が機能せず、 dashboard
  へ navigate 時に毎回 server SSR が走る
- revalidatePath('/app') の発火タイミングが RSC render 後で、 race の窓に
  間に合わない
- 結果: staleTimes / revalidatePath いずれも race 解消に寄与しない no-op
- 撤去 (4350b43) で settings 整理に切替

### S-cache-3.1 が race を確実に潰したロジック

`session-runner.tsx` 完了画面 button の Link を Button + onClick(async) に
置換。 click handler 内で:

```
await flushPendingEvents(sessionId)
if (result.reachable && result.failedEventIds.length === 0) {
  router.push('/app')
} else {
  setNavState('warning')   // 再 click で flush せず直接 push (dead-end 防止)
}
```

navigation 自体を JS gate にしたことで、 server DB が更新済の状態でしか
SSR が走らない構造に。 stg smoke で dueCount 4 → 1 (−3) を確認、 race 消滅。

詳細 spec: `docs/superpowers/specs/2026-05-26-s-cache-3-design.md`

## S-cache-3 系列 close 判断 (OT 確定 2026-05-26)

S-cache-3.1 close 後の audit でも dashboard dueCount / todayCardCount /
streak いずれも race-free が達成済と判明。 S-cache-3.2 (dueCount local
projection) は **着手しない / sprint 見送り** を OT 決定。

OT 提示の理由:

- S-cache-3.1 で M4 race は解消済み
- dueCount SSR は 1 SQL + index hit (`cards_due_idx`) で軽量
- client fetch 化すると CTA が skeleton 化して first-paint UX が悪化
- Dexie 由来にするには cards 全件 local pull + FSRS due 判定 client 化が
  必要で、 現 scope を超える
- 将来 offline 演習対応の sprint で自然に再浮上する論点

## backlog note (OT 提示文言、 future re-examine 用)

> dashboard dueCount の完全 local projection は、 cards local pull /
> FSRS due 判定 client 化 / offline 演習対応 sprint の中で再検討する。
> 現時点では S-cache-3.1 により M4 race は解消済みで、 dueCount SSR は
> 軽量なため実装しない。

## todayCardCount audit (2026-05-26、 別 mini-audit)

S-cache-3.1 stg smoke で 3 cards 解答 → todayCount 8→9 (+1) と観測。
audit 結果: 仕様通り (同日中 unique card_id 数を distinct 集計) で **修正不要**。
test account の事前 state (= 既に今日 N 枚 rate 済 + 同 card 同日再 due) で
整合。 server authoritative (`study_days.distinct_card_count`) のまま維持。

dashboard label 「今日の学習問題数」 の文言曖昧性は polish 対象だが、 OT 判断
で polish mini-sprint は切らず、 将来 dashboard 文言まとめ見直し時に同時扱い。

## 次の方向: S-local-1 (cards local mirror 設計調査)

S-cache 系列 close 後の次 sprint は「local-first 本体に入る前の大きめ設計
調査」 として S-local-1 を着手。 投稿実装は伴わず、 cards local mirror 必要性 /
FSRS due 判定 client 化の影響 / reconcile / sync / offline MVP 範囲 を整理。

調査項目詳細: `docs/superpowers/specs/2026-05-26-s-local-1-investigation.md`
