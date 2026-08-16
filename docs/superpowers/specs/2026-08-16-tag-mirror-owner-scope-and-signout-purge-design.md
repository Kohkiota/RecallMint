# tag mirror 表示側の先行小修正 — owner スコープ読み + sign-out purge(spec)

- 日付: 2026-08-16(r2)
- 状態: r2 draft(OT review 待ち)
- 入力(正): `docs/superpowers/sessions/2026-08-16-dashboard-track-factfinding.md` §12
- 背景: 公開前 gate ★ 項目(`docs/architecture.md` §1 outbox owner 行 + §残余リスク「共有ブラウザで他 user のタグが表示される」)の先取り。ダッシュボード分析 doc §4.5 の裁定により ③ とは分離した単独 sprint。Dash-1 以降のタグ UI 増築前に露出面を閉じる。
- r2 改訂(Codex spec review Important 2 件 + 承認済 Minor): ① sync_meta owner marker の導入(cursor-only 残存の fail-closed 検出、§4.2)② MirrorSweep + PullTrigger の sibling 配置を撤回し、単一 SyncBootstrap で marker 検証 → reset → force-full pull 実完了 → PullTrigger 有効化を直列化(§4.3。r1 の「guard skip は次の ambient で自然回復」は**誤りとして削除** — 競合 pull の cursor 書き戻しで汚染が固定化する)③ sweep 側の sync_meta 列挙処理を撤去(sync_meta の reset は bootstrap の `clear()` に一本化 — Minor の fail-closed 化を包含)。

## 1. 目的

共有ブラウザのアカウント切替で前 user のローカルデータが次 user に露出する経路を、2 層で閉じる:

1. **読み層**: tag mirror(`tag_categories` / `tag_options`)の owner 無スコープ読みを全て owner スコープ化 — 表示保証の本体(残存行があっても表示されない構造保証)。
2. **保存層**: sign-out 時の local purge + sign-in 時の owner 検証付き bootstrap(cursor 健全化)+ 異 owner 残骸 sweep — at-rest 残骸の除去と、読みでは閉じられない残余(`.get()` 直引き等・将来の読み手)への defense-in-depth。

### 1.1 調査で確定した事実(fact-finding §12 への増分)

- **§12 未記載の `where('category_id')` 読みがもう 1 箇所実在**: `category-list.tsx:144`(削除確認 dialog の影響集計)。扱いは §3.3 の除外裁定に従う(同型)。
- **pull cursor は user 無スコープの単一 key**(`lib/sync/sync-meta.ts:16` の `cards_cursor` 等 6 本 + `exam_view_prefs`)で、**sync_meta は key/value のみ・所有者情報を持たない**(`lib/client-db.ts` `ClientSyncMeta`)。user 切替検知や cursor reset は repo に存在しない。帰結: A が pull した browser に B が sign-in すると **B の delta pull は A の cursor 起点になり、B の古い行が永遠に mirror に入らない**(silent 表示欠落)。本 sprint は §4.2 の owner marker でこれを閉じる。
- **`PullTrigger` は mount 時に即 pull を kick する**(`app/(app)/app/_components/pull-trigger.tsx` の `kick('mount')`)。sweep を sibling に置くだけでは「旧 cursor pull 開始 → sweep clear → 再 pull は inflight-skip → 旧 cursor 起点の新 cursor が書き戻される」で汚染が固定化する(Codex Important 2・現物確認済: `lib/sync/pull.ts:runGuardedPull` の in-flight / lock-busy skip と、pull 成功 tx 内の cursor 書込)。
- **`runGuardedPull` の outcome `'ran'` は成功を含意しない**(r2 現物確認の追加事実): `run` 内で `await pull()` の**戻り値を捨てて** `'ran'` を返すため、pullDelta が FAIL でも `'ran'` になる。bootstrap の「実完了」判定は guard outcome でなく **pullDelta 結果の `ok: true`** に置く(§4.3)。
- **`pullDelta` は cursor read → fetch → tx 書込の全体が単一 Web Lock 区間内で走る**(`runGuardedPull` が `pullDelta` 全体を `withWebLock` で包む・lock 名は origin 内全タブ共有)。→ pull 同士は tab 内外とも厳密に直列化され、§4.3 の force-full 収束論法が成立する。
- **client 持続データの全量は IndexedDB(Dexie 11 store)+ Cache API `recallmint-media` の 2 つ**。localStorage / sessionStorage に user データは無い(全 grep 0 件)。Cache API の key は `/__media/{userId}/{assetId}` で userId 名前空間化済(`lib/media/cache.ts`)。
- **Dexie の `user_id` は内部 `users.id`(UUID)であり Clerk id ではない**(`lib/auth/ensure-user.ts`)。→ bootstrap / sweep は RSC 由来の userId prop で行い、sign-out 側は id 不要の全消しにする(§4)。
- 11 箇所すべてで `userId` が既にスコープ内にある(props / 引数 / `c.userId`)。schema 変更は不要(両 store とも `user_id` index が v4 から存在)。

## 2. スコープ / 非スコープ

**スコープ**: ① §3 の読み owner スコープ化(11 箇所 + `.get()` guard 4 箇所)② §4 の purge / bootstrap / sweep 一式 ③ 完了時の `docs/architecture.md` 該当 2 行の更新。

**非スコープ**(既存 follow-up / 別裁定):

- mirror reconcile(follow-up 台帳の既存項目)。
- タグ UI の増築(Dash-1 以降)。
- **pending / failed outbox 行の at-rest 残置解消**(sign-out 前 flush の設計が要る。§4.1 の裁定で本 sprint から切り出し → claude.ai todo へ)。
- ローカル `answer_events` の無限成長(fact-finding §2 既知・別件)。purge が synced 行を消すため副次的に緩和はされる。
- タグ以外の読み経路の全数再点検。fact-finding で見た範囲(dashboard 3 数値・スマート/カスタム演習の選定・試験表の cards 読み)は owner スコープ済だが、全数の完全性は主張しない — 未見の無スコープ読みが残っても purge / sweep が残骸自体を消すため露出しない、が本 sprint の保証形。

## 3. 設計 A: 読みの owner スコープ化(r1 から変更なし・承認済)

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

## 4. 設計 B: sign-out purge + sync bootstrap + sweep(r2 で再構成)

### 4.1 store 分類と purge 規則

| 分類 | store | sign-out 時(全消し) | bootstrap reset 時(§4.2 判定) | sweep(異 owner のみ・§4.4) |
|---|---|---|---|---|
| 表示 mirror | exams / cards / study_days / tag_categories / tag_options / card_tags / media_assets / media_download_jobs | `clear()` | 触らない(reset は sync_meta のみ。mirror 残骸は sweep 担当) | `where('user_id').notEqual(userId).delete()` |
| 同期メタ | sync_meta | `clear()`(**owner marker 含む** — 全消しに含意されるが明記) | `clear()` + marker 書込(同 tx・§4.2) | **触らない**(sync_meta の reset 判断は marker protocol の専管) |
| outbox | answer_events / entity_mutations | **synced のみ削除**、pending / syncing / failed は不可侵 | 触らない | 異 owner の synced のみ削除 |
| Cache API | `recallmint-media` | `caches.delete(CACHE_NAME)` | 触らない | `/__media/{userId}/` 以外の key を削除 |

規則の根拠(r1 承認済 + r2 変更点):

- **mirror 全体を対象**(タグ限定にしない): 将来の表追加で同じ穴が再発する構造を断つ。全 mirror store は `user_id` index を持ち sweep が index 経路で成立する(現物確認済)。
- **outbox の pending / syncing / failed は消さない**(承認済・変更なし): 未同期の回答・編集を失わないため。安全性は architecture.md §1 の「outbox owner = 認証主体 + flush は owner スコープ選別 + server owner check」不変条件に依拠。前 user の未同期データの at-rest 残置のみ残り、これは flush-before-signout の設計を要するため別裁定に切り出す(§2)。
- **synced 行は消す**(承認済・変更なし): server 受理済みで喪失リスクゼロ。単独 `sync_status` index は無いので filter 走査で消す(sign-out 時のみの一回走査で許容)。
- **r2 変更**: sync_meta の扱いを sweep から完全に外し、reset は「sign-out の `clear()`」と「bootstrap reset の `clear()` + marker 書込」の 2 点に一本化。r1 の「sweep が異 owner 検出時に cursor 6 key を列挙 bulkDelete」は撤去(承認済 Minor の fail-closed 化を包含: 列挙は将来 key 追加時の purge 漏れ = silent 欠落 bug の温床)。view prefs(`exam_view_prefs`)は reset / sign-out で消える(user 無スコープの共有値であり、fail-closed を優先)。

### 4.2 sync_meta owner marker(Important 1 対応)

**問題**: sync_meta に所有者情報が無いため、「旧 user の mirror 行はゼロだが cursor だけ残る」状態(purge の部分完了・行ゼロ account・pull 競合の cursor 書き戻し等)を行ベースの検出では素通しし、新 user が旧 cursor から delta pull して silent 表示欠落する。

**設計**: `SYNC_META_KEYS` に `syncOwnerUserId: 'sync_owner_user_id'`(value = 内部 `users.id`)を追加し、bootstrap(§4.3)が mount 時に fail-closed で判定する:

| 状態 | 判定 | 動作 |
|---|---|---|
| marker = 現 user | 健全 | reset 不要 — **fast path**(即 PullTrigger 有効化) |
| marker ≠ 現 user | 他 owner の cursor | **reset 経路**: `sync_meta.clear()` → marker 書込(同 tx)→ force-full pull(§4.3) |
| marker 不在 かつ sync_meta に他の行が存在 | 所有者不明(rollout 前の既存 device / 異常残骸) | 同上(fail-closed で reset 経路) |
| marker 不在 かつ sync_meta 空 | 初回 device | marker 書込のみ → 即 PullTrigger 有効化(cursor 不在ゆえ通常 pull が自然に full) |

**marker の書込点**は 2 つだけ: ① bootstrap の reset 経路(`clear()` と同一 Dexie tx で put — clear と marker が原子)② 初回 device の marker 単独書込。pull の cursor 永続化側(`lib/sync/pull.ts`)には書かない(client pull は内部 userId を知らないため。§1.1)。

**「cursor が marker 無しで存在しない」の担保は 2 段**(絶対不変条件としては主張しない — 単一点主張の decay 教訓):

1. **定常**: cursor の書込点は pull 完了 tx のみで、pull は (a) bootstrap 有効化後の ambient(marker 確定済)か (b) bootstrap 自身の force-full(marker 書込 tx の後)。ゆえに正常経路では常に marker が cursor に先行する。
2. **異常残骸**(flush 由来 `pullBack` / 入口 kick は bootstrap に gate されず、reset 前の窓で cursor を書き得る): 一過性であり、同 mount 内では §4.3 の force-full 収束が上書きし、それも逃した残骸は**次回 mount の bootstrap が fail-closed 検出**(marker 不在/不一致 + 行存在 → reset)する。

**rollout 時の一回コスト**: 既存 device は全て「marker 不在 + sync_meta 非空」に該当し、初回 mount で一度だけ reset + full pull が走る(view prefs も一度消える)。受容。

### 4.3 SyncBootstrap による直列化(Important 2 対応)

**問題**(r1 の誤りの訂正): sweep と `PullTrigger` の sibling 配置では、① PullTrigger が旧 cursor で pull 開始 → ② sweep が sync_meta を clear → ③ sweep の再 pull は inflight-skip / lock-busy → ④ 最初の pull が完了時に**旧 cursor 起点の新 cursor を書き戻す** → 以後の ambient pull は汚染 baseline からの delta となり欠落が固定化する。r1 §4.2 の「skip は次の ambient トリガーで自然回復」**は誤り**(回復しない)。

**設計**: `app/(app)/app/layout.tsx` の `<PullTrigger />` 直置きを、単一の client component `<SyncBootstrap userId={user.id}>` に置き換え、以下を直列化する。PullTrigger 自体は無変更で、SyncBootstrap が ready になるまで **mount しない**(conditional render — ambient pull の存在自体を消す):

1. §4.2 の marker 判定(sync_meta 1〜2 read)。
2. fast path(marker 一致 / 初回 device)→ 即 ready = PullTrigger を render。pull の完了を待たない。
3. reset 経路 → `clear()` + marker 書込(同 tx)→ **force-full pull** を実完了まで反復 → `pullAllStudyDays()` → ready。
4. 異 owner 行 sweep(§4.4)は ready 後に fire-and-forget で起動(**bootstrap の直列鎖に入れない** — 設計判断は §4.4)。

**force-full pull** = cursor を**読まずに** since 無しで `/api/pull` を叩き、成功 tx で server cursor を全上書きする新 option(`pullDelta` に force-full flag を追加。cursor read を skip するだけで tx / upsert 経路は既存のまま)。「clear したから次の delta は full になるはず」に依存しない理由 = 競合 pull が clear 後に旧 cursor 由来の値を書き戻す余地(上記④)を設計から消すため。

**収束論法**(競合があっても健全): `pullDelta` は cursor read → fetch → tx 書込の全体が単一 Web Lock 区間内で走る(§1.1・tab 内外とも直列)。ゆえに任意の競合 pull(flush 由来 `pullBack` / 入口 kick / 他 tab)と force-full は全順序を持ち — (a) 競合が先なら force-full が後で cursor を全上書き(since 無しゆえ baseline 完全)、(b) 競合が後なら競合は force-full が書いた健全 cursor からの delta。**どちらの順序でも force-full 実完了後の状態は健全**。これが pullBack / 入口 kick を gate しない理由でもある(gate は ambient = PullTrigger のみで足りる)。

**実完了の判定**(凍結): force-full の完了条件は **自呼出の guard outcome `'ran'` かつ pullDelta 結果 `ok: true`** の両方。`'ran'` 単独は不可(§1.1 — pull 失敗でも `'ran'` が返る)。`'inflight-skip'` / `'lock-busy'` / `ok: false` は**未完了**として扱い、retry する(間隔 + online / visibilitychange 再試行、詳細は plan)。実完了まで PullTrigger は mount しない — その間 mirror は空で UI は空表示 + server fallback 経路(既存)が生きる。offline ではいつまでも ready にならないが、これは「欠落 mirror を正と誤認させない」ための意図的挙動(受容)。

**fast path の遅延**: 追加待ちは marker read(IDB 1〜2 read・ms オーダー)のみ。pull / sweep / purge のいずれも待たない。通常 user(marker 一致)の体感変化なし。

### 4.4 実装形

新 module `lib/sync/local-purge.ts`(client-only、`getClientDb` 依存):

- `purgeAllLocalData(): Promise<void>` — §4.1 sign-out 列。`Dexie.exists('recallmint')` を先に確認し、DB 未作成の visitor(marketing page)に空 DB を作らない。Dexie 書込は 1 rw tx にまとめる。Cache API は `typeof caches !== 'undefined'` guard 付きで tx 外。
- `sweepForeignLocalData(userId: string): Promise<void>` — §4.1 sweep 列(mirror + 異 owner synced outbox + Cache API のみ。**sync_meta には触らない**)。

**sweep を bootstrap の直列鎖から独立させる裁定**(Codex 要求の明示): cursor 健全性は §4.2/§4.3 の marker protocol が単独で完結して担保し、sweep の検出結果に依存しない(r1 の「sweep が異 owner を検出したら cursor を消す」という結合を撤去)。sweep の役割は at-rest 衛生に純化され、表示保証は読み層(§3)が担うため、ready を遅らせてまで直列化する理由がない。fire-and-forget・失敗 silent(次回 mount で再走)。

trigger component:

- `<SignOutPurge />`(r1 から変更なし)— root `app/layout.tsx`(ClerkProvider 内)に mount。`useAuth()` の `isLoaded && !isSignedIn` で `purgeAllLocalData()` を発火。**遷移イベントでなく signed-out 状態で発火**するため Clerk UserButton の sign-out 実装に依存しない。session 失効・他タブ sign-out・**退会**(`delete-button.tsx` → Clerk user.delete → signed-out 遷移)も同経路でカバー。marker も sync_meta `clear()` に含まれて消える(§4.1)。
- `<SyncBootstrap userId={user.id}>` — `app/(app)/app/layout.tsx` に mount(§4.3)。userId は layout の `getCurrentUser()` 由来(内部 id。client の Clerk hook からは内部 id が確実に取れないため RSC props で渡す — §1.1)。ready 後に `<PullTrigger />` を render し、`sweepForeignLocalData(userId)` を fire-and-forget で起動。

### 4.5 受容するリスク・コスト(記録)

1. **reset 前の窓で flush 由来 pullBack / 入口 kick が旧 cursor pull を走らせ得る**(gate は ambient のみ)。同 mount 内の force-full 収束(§4.3)が上書きし、それも逃した残骸は次回 bootstrap の fail-closed 検出が回収する 2 段構え。受容。
2. **sweep と表示の race**: sign-in 直後、sweep 完了前に useLiveQuery が読む可能性。表示保証は読みスコープ化が担い、sweep は at-rest 衛生に限定する層設計なので問題にしない。
3. **sign-out のたびに次回 sign-in が full pull になる**(sync_meta 全消しの帰結)+ **rollout 時に既存全 device が一度 reset + full pull を踏む**(§4.2)。sign-out は稀な操作であり、cursor 汚染の根絶を優先。受容。
4. **view prefs が sign-out / reset で消える**(§4.1 根拠)。受容。
5. 前 user の pending / failed outbox 行の at-rest 残置(§2 で別裁定へ)。
6. **reset 経路の offline は ready にならない**(§4.3 — 意図的)。受容。

## 5. テスト戦略

Vitest + fake-indexeddb(`lib/cards/get-custom-session-cards.test.ts` 等の既存パターンに乗る)。Cache API は `lib/media/cache.test.ts` の mock パターンを再利用。実装は TDD(subagent-driven development)。mock で誤魔化さず、Dexie 実 query を fake-indexeddb 上で走らせる。

- **読みスコープ**(r1 から変更なし): 2 user 分を seed し、lib 層(get-custom-session-cards / tag-crud の同名 check・owner guard)は直接 unit、component 層(#4-11)は render + fake-indexeddb で「異 owner 行が結果に出ない」ことを pin。
- **purge**: mirror 全消し / sync_meta 全消し(**marker 含む**)/ synced outbox 削除 / **pending・syncing・failed 生存** / DB 未作成時に DB を作らない、を各 1 pin。
- **sweep**: 異 owner のみ削除・自 owner 生存 / 異 owner synced outbox 削除・pending 生存 / **sync_meta 不干渉**(cursor・marker・prefs が sweep で変化しない)、を各 1 pin。
- **marker / bootstrap(r2 追加・凍結条件)**:
  - **cursor-only 残存**: marker 不在 + cursor 存在 → reset(clear + marker 更新)+ force-full pull が走る pin。marker 不一致 + cursor 存在 → 同上 pin。
  - marker 一致 → sync_meta 不変・reset も force-full も走らない(fast path)pin。
  - marker 不在 + sync_meta 空 → marker 書込のみ・reset なし pin。
  - **pull/bootstrap 競合**: bootstrap ready 前に PullTrigger の pull が開始されない pin(conditional render の検証)。
  - **`'inflight-skip'` / `'lock-busy'` / `ok: false` を完了扱いしない** pin(retry され ready にならない)。`'ran'` + `ok: true` でのみ ready になる pin。
  - force-full が cursor を読まず since 無しで叩く pin(既存 pullDelta test の client mock パターンで URL を検証)。

## 6. stg smoke 方針(詳細は plan で)

Playwright MCP で共有ブラウザ切替を実走: user A で sign-in → mirror 実在 + **sync_meta readback(`sync_owner_user_id` = A の内部 id + cursor 存在)** → sign-out → **IDB: mirror 空 + sync_meta 空**を確認(pending 残存は flush が速く実走再現が難しいため unit pin を正とする — plan に 1 行明記)→ user B で sign-in(OTP 424242)→ **A の行が IDB にも UI にも無い + marker = B の内部 id + B の full pull 成立(cursor reset の実証)**。加えて **cursor-only 残存の実走**: B の状態で DevTools から sync_meta に異値 marker を注入 → reload → reset + full pull が走ることを Network(since 無し `/api/pull`)で確認。退会 purge は破壊的のため smoke 対象外(sign-out と同一経路の構造保証で足りる)。

## 7. 完了条件

1. §3 の 15 箇所(11 置換 + 4 guard)適用、§5 のテスト green(red 実証込み。**§5 の r2 追加 pin(cursor-only 残存 / pull・bootstrap 競合)は凍結条件**)。
2. §4 の purge / marker / bootstrap / sweep 実装 + テスト green。
3. canonical + Codex review 収束(Critical 0 / Important 0)、`[reviewed]`(データ保全に触れるため「重要 Fix の裏取り」規律に従い、stg smoke を要する場合は session doc を正記録とする既存裁定に従う)。
4. whole-repo lint exit 0 / `pnpm test:iso` green / `pnpm run audit` exit 0(sprint 完了 gate)。
5. `docs/architecture.md` §1 outbox owner 行の実測記述と §残余リスクの該当行を「解消済(本 sprint)」へ更新。cursor 汚染の解消機構(owner marker + bootstrap 直列化 + force-full)を §1 に 1 行追記。
