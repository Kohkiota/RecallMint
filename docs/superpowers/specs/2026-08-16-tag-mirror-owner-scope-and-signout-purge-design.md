# tag mirror 表示側の先行小修正 — owner スコープ読み + sign-out purge(spec)

- 日付: 2026-08-16
- 状態: draft(OT review 待ち)
- 入力(正): `docs/superpowers/sessions/2026-08-16-dashboard-track-factfinding.md` §12
- 背景: 公開前 gate ★ 項目(`docs/architecture.md` §1 outbox owner 行 + §残余リスク「共有ブラウザで他 user のタグが表示される」)の先取り。ダッシュボード分析 doc §4.5 の裁定により ③ とは分離した単独 sprint。Dash-1 以降のタグ UI 増築前に露出面を閉じる。

## 1. 目的

共有ブラウザのアカウント切替で前 user のローカルデータが次 user に露出する経路を、2 層で閉じる:

1. **読み層**: tag mirror(`tag_categories` / `tag_options`)の owner 無スコープ読みを全て owner スコープ化 — 表示保証の本体(残存行があっても表示されない構造保証)。
2. **保存層**: sign-out 時の local purge + sign-in 時の異 owner 残骸 sweep — at-rest 残骸の除去と、読みでは閉じられない残余(`.get()` 直引き等・将来の読み手)への defense-in-depth。

### 1.1 調査で確定した追加事実(fact-finding §12 への増分)

- **§12 未記載の `where('category_id')` 読みがもう 1 箇所実在**: `category-list.tsx:144`(削除確認 dialog の影響集計)。扱いは §3.3 の除外裁定に従う(同型)。
- **pull cursor は user 無スコープの単一 key**(`lib/sync/sync-meta.ts` の `cards_cursor` 等 6 本 + `exam_view_prefs`)。user 切替検知や cursor reset は repo に存在しない。帰結: A が pull した browser に B が sign-in すると **B の delta pull は A の cursor 起点になり、B の古い行が永遠に mirror に入らない**(silent 表示欠落)。本 sprint の purge(sync_meta 消去)がこの既存 bug も同時に閉じる。
- **client 持続データの全量は IndexedDB(Dexie 11 store)+ Cache API `recallmint-media` の 2 つ**。localStorage / sessionStorage に user データは無い(全 grep 0 件)。Cache API の key は `/__media/{userId}/{assetId}` で userId 名前空間化済(`lib/media/cache.ts`)。
- **Dexie の `user_id` は内部 `users.id`(UUID)であり Clerk id ではない**(`lib/auth/ensure-user.ts`)。→ sweep は RSC 由来の userId prop で行い、sign-out 側は id 不要の全消しにする(§4)。
- 11 箇所すべてで `userId` が既にスコープ内にある(props / 引数 / `c.userId`)。schema 変更は不要(両 store とも `user_id` index が v4 から存在)。

## 2. スコープ / 非スコープ

**スコープ**: ① §3 の読み owner スコープ化(11 箇所 + `.get()` guard 4 箇所)② §4 の purge / sweep 一式 ③ 完了時の `docs/architecture.md` 該当 2 行の更新。

**非スコープ**(既存 follow-up / 別裁定):

- mirror reconcile(follow-up 台帳の既存項目)。
- タグ UI の増築(Dash-1 以降)。
- **pending / failed outbox 行の at-rest 残置解消**(sign-out 前 flush の設計が要る。§4.2 の裁定で本 sprint から切り出し → claude.ai todo へ)。
- ローカル `answer_events` の無限成長(fact-finding §2 既知・別件)。purge が synced 行を消すため副次的に緩和はされる。
- タグ以外の読み経路の全数再点検。fact-finding で見た範囲(dashboard 3 数値・スマート/カスタム演習の選定・試験表の cards 読み)は owner スコープ済だが、全数の完全性は主張しない — 未見の無スコープ読みが残っても purge / sweep が残骸自体を消すため露出しない、が本 sprint の保証形。

## 3. 設計 A: 読みの owner スコープ化

### 3.1 全店読み 11 箇所(fact-finding §12 の表と同一)

`toArray()` 直読を `.where('user_id').equals(userId).toArray()` に置換する。全 site で userId は既に手元にある。schema 変更なし。

| # | file:line | 対象 | userId 源 |
|---|---|---|---|
| 1-2 | `lib/cards/get-custom-session-cards.ts:60-61` | categories / options | `c.userId` |
| 3 | `lib/tags/tag-crud.ts:54`(rename 同名 check) | categories | 引数 `userId` |
| 4 | `app/(app)/app/tags/_components/category-list.tsx:133` | categories | prop |
| 5 | `app/(app)/app/tags/_components/option-list.tsx:133` | categories | prop |
| 6-7 | `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:202-203` | categories / options | prop |
| 8-9 | `app/(app)/app/exams/[id]/_components/exam-card-table.tsx:433-434` | categories / options | prop |
| 10-11 | `app/(app)/app/study/custom/_components/custom-filter-form.tsx:66,70` | categories / options | prop |

`useLiveQuery` の deps が `[]` の site(#4 / #5 / #10 / #11)は `[userId]` に改める(#6-9 は既に `[examId, userId]`)。

### 3.2 `.get(id)` 直引きの owner guard(4 箇所)

`lib/tags/tag-crud.ts:50 / :87 / :121 / :158`(rename / color の before 読み)に 1 行 guard を足す:

```ts
if (!before || before.user_id !== userId) return
```

理由: これらは mutation の入口で、server 側の owner-存在 check と同型の防御を client 入口にも置く(id が UUID でも、将来の呼び手が異 owner id を渡した場合に「異 owner 行を読んで組み立てた mutation」を作らせない)。全 handler が `userId` を既に受け取っており 1 行で済む。挙動変化: 異 owner 行は「不在」と同じ silent no-op(既存の `if (!before) return` と同型)。

### 3.3 除外裁定(owner 無スコープのまま残す読み)

以下は **owner-由来 UUID を key にした読み**であり、入口(3.1 の一覧 + 3.2 の guard)が閉じれば異 owner 行への到達経路が無い。UUID v4 の衝突は考慮しない。残骸そのものは §4 の purge が消す。`.and(user_id)` の全付けは noise(簡潔性規律)、index 化は schema bump を要するため見送る:

- `where('category_id')`: `tag-crud.ts:125 / :210 / :290`、`category-list.tsx:144`(§1.1 の追加発見)、`option-list.tsx:123`、`option-row.tsx:69`
- `where('option_id')` / `where('card_id').anyOf(ownerScopedIds)` の `card_tags` 読み: `tag-crud.ts:293 / :306`、`category-list.tsx:152`、`get-custom-session-cards.ts:69`、`inline-card-list.tsx:215`、`exam-card-table.tsx:443`
- `countCategoryImpact` / `countOptionImpact` の signature は変えない(userId 追加は上記により不要)。

## 4. 設計 B: sign-out purge + sign-in sweep

### 4.1 store 分類と purge 規則

| 分類 | store | sign-out 時(全消し) | sign-in sweep(異 owner のみ) |
|---|---|---|---|
| 表示 mirror | exams / cards / study_days / tag_categories / tag_options / card_tags / media_assets / media_download_jobs | `clear()` | `where('user_id').notEqual(userId).delete()` |
| 同期メタ | sync_meta | `clear()`(view prefs 含む全 key) | 異 owner 検出時のみ cursor 6 key を `bulkDelete`(prefs は残す) |
| outbox | answer_events / entity_mutations | **synced のみ削除**、pending / syncing / failed は不可侵 | 異 owner の synced のみ削除 |
| Cache API | `recallmint-media` | `caches.delete(CACHE_NAME)` | `/__media/{userId}/` 以外の key を削除 |

規則の根拠:

- **mirror 全体を対象**(タグ限定にしない): OT 第一候補どおり。将来の表追加で同じ穴が再発する構造を断つ。全 mirror store は `user_id` index を持ち sweep が index 経路で成立する(現物確認済)。
- **sync_meta は sign-out で全消し**: cursor を残すと §1.1 の cursor 汚染で次 user(または再 sign-in した本人)の delta pull が壊れる。key 列挙でなく `clear()` にするのは、将来 cursor key が増えたときに purge 漏れ = silent 表示欠落 bug を作らないため(fail-closed)。view prefs(`exam_view_prefs`)は user 無スコープの共有値で、次 user への引き継ぎ自体が微小な漏れなので、消してよい。sweep 側は「現 user が使用中」のため cursor 6 key のみに絞る。
- **outbox の pending / syncing / failed は消さない**: 未同期の回答・編集を失わないため。安全性は architecture.md §1 の確立済み不変条件に依拠する — outbox owner は常に認証主体で、flush は `[user_id+sync_status]` の owner スコープ選別のみ。他 user の browser に残った pending はその owner が戻るまで送信されず、送信されても server の owner check で他 account のデータは変わらない。残る問題は「前 user の未同期データが at-rest で残る」ことのみで、これは flush-before-signout の設計を要するため別裁定に切り出す(§2)。
- **synced 行は消す**: server 受理済みで喪失リスクゼロ。at-rest の個人データ(回答履歴・編集 patch)の大半はここに堆積するため、消す価値が最も高い。単独 `sync_status` index は無いので filter 走査で消す(sign-out 時のみの一回走査で許容)。

### 4.2 実装形

新 module `lib/sync/local-purge.ts`(client-only、`getClientDb` 依存):

- `purgeAllLocalData(): Promise<void>` — §4.1 の sign-out 列。`Dexie.exists('recallmint')` を先に確認し、DB 未作成の visitor(marketing page)に空 DB を作らない。Dexie 書込は 1 rw tx にまとめる。Cache API は `typeof caches !== 'undefined'` guard 付きで tx 外。
- `sweepForeignLocalData(userId: string): Promise<void>` — §4.1 の sweep 列。異 owner 行を検出した場合のみ cursor 消去 + `runGuardedPull({ reason: 'foreign-sweep' })` と `pullAllStudyDays()` を fire-and-forget で kick(cursor reset 後の full 再 pull を早める。guard の in-flight skip に潰された場合は次の ambient トリガーで自然回復 — `runGuardedPull` の skip は通常経路)。

trigger は 2 つの null-render client component:

- `<SignOutPurge />` — root `app/layout.tsx`(ClerkProvider 内)に mount。`useAuth()` の `isLoaded && !isSignedIn` で `purgeAllLocalData()` を発火。**遷移イベントでなく signed-out 状態で発火**するため、Clerk UserButton の sign-out 実装(hard reload か否か)に依存しない。session 失効・他タブ sign-out・**退会**(`delete-button.tsx` → Clerk user.delete → signed-out 遷移)も同じ経路で自然にカバーされる。
- `<MirrorSweep userId={user.id} />` — `app/(app)/app/layout.tsx` に mount(PullTrigger と同居・同パターン)。mount 時に `sweepForeignLocalData(userId)` を 1 回発火。userId は layout の `getCurrentUser()` 由来(内部 id。client の Clerk hook からは内部 id が確実に取れないため RSC props で渡す — §1.1)。

### 4.3 受容するリスク・コスト(記録)

1. **sign-out 直前に発火した in-flight pull が purge 後に着地**し mirror 行が復活しうる(秒オーダーの窓)。表示は読みスコープ化で防がれ、次回の purge / sweep が回収する。受容。
2. **sweep と表示の race**: sign-in 直後、sweep 完了前に useLiveQuery が読む可能性。表示保証は読みスコープ化が担い、sweep は at-rest 衛生に限定する層設計なので問題にしない。
3. **sign-out のたびに次回 sign-in が full pull になる**(cursor 全消しの帰結)。sign-out は稀な操作であり、正しさ(cursor 汚染の根絶)を優先。受容。
4. **view prefs が sign-out で消える**(§4.1 根拠)。受容。
5. 前 user の pending / failed outbox 行の at-rest 残置(§2 で別裁定へ)。

## 5. テスト戦略

Vitest + fake-indexeddb(`lib/cards/get-custom-session-cards.test.ts` 等の既存パターンに乗る)。Cache API は `lib/media/cache.test.ts` の mock パターンを再利用。

- **読みスコープ**: 2 user 分を seed し、lib 層(get-custom-session-cards / tag-crud の同名 check・owner guard)は直接 unit、component 層(#4-11)は render + fake-indexeddb で「異 owner 行が結果に出ない」ことを pin。
- **purge**: mirror 全消し / sync_meta 全消し / synced outbox 削除 / **pending・syncing・failed 生存** / DB 未作成時に DB を作らない、を各 1 pin。
- **sweep**: 異 owner のみ削除・自 owner 生存 / 異 owner 検出時のみ cursor 消去(非検出時は cursor 不変)/ 異 owner synced outbox 削除・pending 生存、を各 1 pin。
- 実装は TDD(subagent-driven development)。mock で誤魔化さず、Dexie 実 query を fake-indexeddb 上で走らせる。

## 6. stg smoke 方針(詳細は plan で)

Playwright MCP で共有ブラウザ切替を実走: user A で sign-in → mirror 実在確認(IDB 抜粋)→ sign-out → **IDB: mirror 空 + sync_meta 空**を確認(pending 残存は flush が速く実走再現が難しいため unit pin を正とする — plan に 1 行明記)→ user B で sign-in(OTP 424242)→ **A の行が IDB にも UI にも無い + B の full pull が成立(cursor reset の実証)**。退会 purge は破壊的のため smoke 対象外(sign-out と同一経路の構造保証で足りる)。

## 7. 完了条件

1. §3 の 15 箇所(11 置換 + 4 guard)適用、§5 のテスト green(red 実証込み)。
2. §4 の purge / sweep 実装 + テスト green。
3. canonical + Codex review 収束(Critical 0 / Important 0)、`[reviewed]`(データ保全に触れるため「重要 Fix の裏取り」規律に従い、stg smoke を要する場合は session doc を正記録とする既存裁定に従う)。
4. whole-repo lint exit 0 / `pnpm test:iso` green / `pnpm run audit` exit 0(sprint 完了 gate)。
5. `docs/architecture.md` §1 outbox owner 行の実測記述と §残余リスクの該当行を「解消済(本 sprint)」へ更新。cursor 汚染の解消も §1 に 1 行追記。
