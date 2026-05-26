# S-cache-3.1 セッション完了 → ダッシュボード navigation の flush 同期化

- 起票日: 2026-05-26
- 種別: design spec
- 前 sprint: S-cache-2b (4350b43, staleTimes 撤去で no-op 確認)
- 次 sprint: S-cache-3.2 (dashboard stats hydrate / local projection、 別途設計)
- OT 確定方針: A-2 / B 拡張なし / C-2 / D-1 (前会話参照)

## 1. 目的

スマート復習セッション完了画面の「ダッシュボードへ」 操作で、 Dexie pending
events の bulk flush が完了する前に `/app` SSR が走る race を **navigation
ゲートで** 防ぐ。 dashboard 表示時には server DB が必ず最新 review 状態を
反映しているため、 `dueCount` (server SSR) が古い値で描画されない。

## 2. 非ゴール (今 sprint で実装しない)

- bulk endpoint response に dashboard stats を含める (B-1) — 関心分離維持
- Dexie `sync_meta` の追加 / dashboard hydrate (B-2) — S-cache-3.2 で検討
- `dueCount` の完全 client projection / Dexie 由来化 (D) — 別 sprint
- `streak` / `todayCardCount` の race-free 化 (D-2) — 主因外
- `staleTimes` / `prefetch` 復活 — S-cache-2b で no-op 確認済
- cards 全件 local pull、 Service Worker / offline、 bulk endpoint
  retry/backoff hardening、 FSRS due 判定の client 化

## 3. 背景: M4 race の現状

`app/(app)/app/study/smart/_components/session-runner.tsx`
- L295-305: `phase='finished'` で `completeStudySession()` →
  `flushPendingEvents()` を **fire-and-forget** で呼出
- L363-365: 「ダッシュボードへ」 は `<Button asChild><Link href="/app">` で
  即時 navigation、 flush の完了を待たない

`/app` SSR (`app/(app)/app/page.tsx:19-23`) の `getDueCount` は server DB を
SELECT するため、 flush 未完なら **直前セッションで解いた card が due のまま**
表示される。 dashboard-stats.tsx の client fetch も同じく未更新値を取得し得る。

詳細トレース: `docs/superpowers/sessions/2026-05-25-s-cache-2b-staletimes-verification.md`

## 4. 設計

### 4.1 変更対象

`session-runner.tsx` 完了画面 (L333-369) の「ダッシュボードへ」 button のみ。
他箇所 (selecting / judged phase、 5 件しきい値 flush、 useEffect 内 final
flush、 「もう一度」 button) は無変更。

### 4.2 状態

完了画面に local state を 1 つ追加:

```
const [navState, setNavState] = useState<'idle' | 'flushing' | 'warning'>('idle')
```

- `idle`: button enable、 label = "ダッシュボードへ"
- `flushing`: button disable、 label = "保存中..." (spinner 無し、 文字のみで MVP)
- `warning`: button enable、 sub-text で「一部の回答を後で再送します」、 click で
  navigation 許可 (失敗時の dead-end 防止)

### 4.3 click ハンドラ

```
onClick: async () => {
  if (navState === 'warning') {
    // 再 click: flush 再試行はせず直接 navigate (dead-end 防止)
    router.push('/app')
    return
  }
  setNavState('flushing')
  try {
    const result = await flushPendingEvents(sessionId)
    if (result.reachable && result.failedEventIds.length === 0) {
      router.push('/app')
      return
    }
    // 部分失敗 / network 不通: warning UI に切替、 user 判断で進む
    setNavState('warning')
  } catch {
    // flushPendingEvents は内部 try/catch で reject しない設計だが念のため
    setNavState('warning')
  }
}
```

warning 状態は明示的に flush をスキップして navigate するため、 失敗時の
無限ループを構造的に防ぐ。 残った pending events は session 終了時 useEffect
の background flush + 次セッション開始時 / online 復帰時に再試行される。

### 4.4 既存 useEffect (L295-305) との関係

`phase='finished'` 時の background `completeStudySession` + `flushPendingEvents`
は **削除しない**。 理由:
- ユーザーが完了画面で何も操作せず離脱した場合の保険
- 「もう一度」 を選んだ場合の session 同期保証
- 二重 flush の副作用は server 冪等 (event_id ON CONFLICT) と Dexie
  `markAnswerEventsSynced` (`anyOf` で idempotent) でゼロ

「ダッシュボードへ」 click 時に useEffect の flush が in-flight でも、 click
側 flush は同じ events リストを取得 → server 二重 POST → server 側冪等で副作用
なし。 ネットワーク負荷 2x のみだが MVP として許容。

### 4.5 「もう一度」 button

無変更。 `router.refresh()` のみで、 flush 同期化は不要 (同じ smart route 内
再 mount のため /app SSR を踏まない)。

## 5. 制約 (CLAUDE.md ルール)

- TypeScript strict 維持
- AI / Stripe / Clerk ルール無関係 (本 sprint 触らず)
- mobile 実機確認は smoke で OT が実施
- review: feat commit のため `superpowers:requesting-code-review` skill 経由
  formal review → `[reviewed]` tag

## 6. test 戦略

`app/(app)/app/study/smart/_components/session-runner.test.tsx` (新規) で
React Testing Library + 注入可能な `flushPendingEvents` mock を使用。
`'next/navigation'` の `useRouter().push` も spy。

最低限の case:

1. **成功経路**: flush mock が `{ reachable: true, failedEventIds: [] }` で resolve
   - click 直後は `router.push` が呼ばれず、 button label が "保存中..."
   - mock resolve 後に `router.push('/app')` が呼ばれる
2. **部分失敗**: flush mock が `{ failedEventIds: ['evt-1'] }` で resolve
   - `router.push` は呼ばれない、 warning UI 表示
   - warning 中の再 click で `router.push('/app')` 1 回呼ばれる
3. **順序保証**: flush resolve **前** に `router.push` が呼ばれないこと
   (await 化 regression を防ぐ guard)

`flushPendingEvents` の DI 経路 (component に prop で受け取るか、 module mock
か) は実装者判断。 既存 `BulkApiClient` 注入パターンと整合する方を選ぶ。

E2E (Playwright) は今 sprint 対象外。 OT 実機 smoke で代替。

## 7. 完了条件

- [ ] 上記 test 3 case が通過
- [ ] `pnpm build` / `pnpm test` 全通過
- [ ] code-reviewer Critical 0 件
- [ ] OT 実機 smoke (mobile view): セッション完了 → 「ダッシュボードへ」 →
      dashboard dueCount が解いた card 数だけ減って表示
- [ ] commit に `[reviewed]` tag

## 8. 想定リスクと判断

| 項目 | 内容 | 対応 |
|------|------|------|
| 体感遅延 | 完了画面で 1〜7.5s 待ち | "保存中..." 文字のみで知覚負荷を最小化、 spec 通り A-2 採用 |
| 二重 flush 負荷 | useEffect 側と click 側で 2 回 POST 可能性 | server 冪等で副作用なし、 負荷も session 終了時のみ最大 2 回 |
| Dexie 書込み race | sync_status update が並行 | Dexie の `.where().modify()` は table 単位 transaction、 同 event ID への二重 update も結果同一 |
| 完了画面離脱 → 復帰 | session 終了せず /app へ navbar 等で抜けた場合 | useEffect は phase='finished' でしか発火しない既存挙動。 既知制約、 別 sprint |
| flush 失敗継続 | 部分失敗 warning で navigate 後も pending 残置 | 既存設計通り次セッション開始時 / online 復帰時に再試行。 dashboard 表示は一時的に古いまま (許容) |

## 9. 関連ファイル

- `app/(app)/app/study/smart/_components/session-runner.tsx` (主修正)
- `lib/sync/review-events.ts` (既存 `flushPendingEvents`、 修正なし)
- `lib/sync/review-events.test.ts` (既存、 修正なし)
- `app/(app)/app/page.tsx` (server SSR、 修正なし)
- `app/api/review-events/bulk/route.ts` (修正なし)

## 10. S-cache-3.2 への接続 (予告、 本 sprint では実装しない)

- 完了画面で flush response から `failedEventIds` を見て warning 文言を
  branch している箇所が、 将来「`/api/dashboard/stats` を prefetch して
  Dexie `sync_meta` に書込み、 dashboard 初回 render は sync_meta hydrate」
  に拡張される場合の hook ポイントになる
- 本 sprint では sync_meta を追加しないが、 click ハンドラの構造
  (`flushing` → 成否 branch → navigate) はそのまま拡張可能
