# tag mirror 表示側の先行小修正 — owner スコープ読み + sign-out purge(spec)

- 日付: 2026-08-16(r3)
- 状態: r3 draft(OT review 待ち)
- 入力(正): `docs/superpowers/sessions/2026-08-16-dashboard-track-factfinding.md` §12
- 背景: 公開前 gate ★ 項目(`docs/architecture.md` §1 outbox owner 行 + §残余リスク「共有ブラウザで他 user のタグが表示される」)の先取り。ダッシュボード分析 doc §4.5 の裁定により ③ とは分離した単独 sprint。Dash-1 以降のタグ UI 増築前に露出面を閉じる。
- r2 改訂(確認済): ① sync_meta owner marker ② SyncBootstrap 直列化(force-full pull + conditional PullTrigger)③ sweep の sync_meta 不干渉化。
- r3 改訂(Codex r2 review Important 2 件 + Minor 1 件): ① marker 判定を **2 分岐に単純化**(marker 一致のみ fast path — 「不在 + sync_meta 空 = 初回 device の即 ready」は in-flight pull の cursor 書き戻しと逆順化して恒久汚染 fast path を作るため撤回、§4.2)② **purge / bootstrap を pull と同一 Web Lock(queued)で直列化**(遅延 purge が次 session の書込を消す race の封鎖、§4.3/§4.4)③ Web Locks 非対応 fallback(lock なし直実行)を前提要件として明記・受容(§4.5)。

## 1. 目的

共有ブラウザのアカウント切替で前 user のローカルデータが次 user に露出する経路を、2 層で閉じる:

1. **読み層**: tag mirror(`tag_categories` / `tag_options`)の owner 無スコープ読みを全て owner スコープ化 — 表示保証の本体(残存行があっても表示されない構造保証)。
2. **保存層**: sign-out 時の local purge + sign-in 時の owner 検証付き bootstrap(cursor 健全化)+ 異 owner 残骸 sweep — at-rest 残骸の除去と、読みでは閉じられない残余(`.get()` 直引き等・将来の読み手)への defense-in-depth。

### 1.1 調査で確定した事実(fact-finding §12 への増分)

- **§12 未記載の `where('category_id')` 読みがもう 1 箇所実在**: `category-list.tsx:144`(削除確認 dialog の影響集計)。扱いは §3.3 の除外裁定に従う(同型)。
- **pull cursor は user 無スコープの単一 key**(`lib/sync/sync-meta.ts:16` の `cards_cursor` 等 6 本 + `exam_view_prefs`)で、**sync_meta は key/value のみ・所有者情報を持たない**(`lib/client-db.ts` `ClientSyncMeta`)。user 切替検知や cursor reset は repo に存在しない。帰結: A が pull した browser に B が sign-in すると **B の delta pull は A の cursor 起点になり、B の古い行が永遠に mirror に入らない**(silent 表示欠落)。本 sprint は §4.2 の owner marker でこれを閉じる。
- **`PullTrigger` は mount 時に即 pull を kick する**(`app/(app)/app/_components/pull-trigger.tsx` の `kick('mount')`)。sweep を sibling に置くだけでは「旧 cursor pull 開始 → sweep clear → 再 pull は inflight-skip → 旧 cursor 起点の新 cursor が書き戻される」で汚染が固定化する(r2 Important・現物確認済: cursor read は `lib/sync/pull.ts:119`、書き戻しは pull 成功 tx 内 `:263`)。
- **`runGuardedPull` の outcome `'ran'` は成功を含意しない**: `run` 内で `await pull()` の**戻り値を捨てて** `'ran'` を返すため、pullDelta が FAIL でも `'ran'` になる。bootstrap の「実完了」判定は guard outcome でなく **pullDelta 結果の `ok: true`** に置く(§4.3)。
- **`pullDelta` は cursor read → fetch → tx 書込の全体が単一 Web Lock 区間内で走る**(`runGuardedPull` が `pullDelta` 全体を `withWebLock` で包む・lock 名 `recallmint:pull` は origin 内全タブ共有)。→ **Web Locks 対応ブラウザでは** pull 同士は tab 内外とも厳密に直列化され、§4.3 の収束論法が成立する。
- **Web Locks 非対応時の fallback は lock なし直実行**(`lib/sync/with-web-lock.ts:51` — r3 現物確認)。対象環境(iOS 16.4+ 等)は全対応と同 file コメントに記録済で、fallback は defensive。→ §4 の cross-tab 直列化保証は **Web Locks 対応を前提要件**として明記し受容(§4.5)。
- **`withWebLock` は `ifAvailable: true` 固定で queued 待機 mode を持たない**(r3 現物確認)。→ §4.3 の purge / bootstrap critical section の queued 取得は helper 拡張(or `navigator.locks` 直)が要る(実装形は plan)。
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

## 4. 設計 B: sign-out purge + sync bootstrap + sweep

### 4.1 store 分類と purge 規則

| 分類 | store | sign-out 時(全消し) | bootstrap reset 時(§4.2 判定) | sweep(異 owner のみ・§4.4) |
|---|---|---|---|---|
| 表示 mirror | exams / cards / study_days / tag_categories / tag_options / card_tags / media_assets / media_download_jobs | `clear()` | 触らない(reset は sync_meta のみ。mirror 残骸は sweep 担当) | `where('user_id').notEqual(userId).delete()` |
| 同期メタ | sync_meta | `clear()`(**owner marker 含む** — 全消しに含意されるが明記) | `clear()` + marker 書込(同 tx・§4.2) | **触らない**(sync_meta の reset 判断は marker protocol の専管) |
| outbox | answer_events / entity_mutations | **synced のみ削除**、pending / syncing / failed は不可侵 | 触らない | 異 owner の synced のみ削除 |
| Cache API | `recallmint-media` | `caches.delete(CACHE_NAME)` | 触らない | `/__media/{userId}/` 以外の key を削除 |

規則の根拠(承認済・r3 変更なし):

- **mirror 全体を対象**(タグ限定にしない): 将来の表追加で同じ穴が再発する構造を断つ。全 mirror store は `user_id` index を持ち sweep が index 経路で成立する(現物確認済)。
- **outbox の pending / syncing / failed は消さない**: 未同期の回答・編集を失わないため。安全性は architecture.md §1 の「outbox owner = 認証主体 + flush は owner スコープ選別 + server owner check」不変条件に依拠。前 user の未同期データの at-rest 残置のみ残り、これは flush-before-signout の設計を要するため別裁定に切り出す(§2)。
- **synced 行は消す**: server 受理済みで喪失リスクゼロ。単独 `sync_status` index は無いので filter 走査で消す(sign-out 時のみの一回走査で許容)。
- sync_meta の reset は「sign-out の `clear()`」と「bootstrap reset の `clear()` + marker 書込」の 2 点に一本化(r2 承認済 — key 列挙は将来 key 追加時の purge 漏れ = silent 欠落 bug の温床)。view prefs(`exam_view_prefs`)は reset / sign-out で消える(user 無スコープの共有値であり、fail-closed を優先)。

### 4.2 sync_meta owner marker(r3 で 2 分岐に単純化)

**問題**: sync_meta に所有者情報が無いため、「旧 user の mirror 行はゼロだが cursor だけ残る」状態(purge の部分完了・行ゼロ account・pull 競合の cursor 書き戻し等)を行ベースの検出では素通しし、新 user が旧 cursor から delta pull して silent 表示欠落する。

**設計**: `SYNC_META_KEYS` に `syncOwnerUserId: 'sync_owner_user_id'`(value = 内部 `users.id`)を追加し、bootstrap(§4.3)が mount 時に判定する。判定は **2 分岐**:

| 状態 | 判定 | 動作 |
|---|---|---|
| marker = 現 user | 健全 | **fast path** — reset せず即 PullTrigger 有効化 |
| それ以外(marker 不一致 / 不在 — **sync_meta の空・非空を問わない**) | 所有者未確立 | **reset 経路**: `sync_meta.clear()`(空 store には no-op)→ marker 書込(同 tx)→ force-full pull 実完了まで ready にしない(§4.3) |

**r2 の「marker 不在 + sync_meta 空 = 初回 device → marker 書込のみで即 ready」を撤回した理由**(Codex r2 Important 1・採用): この分岐の marker 書込は pull lock の外で起きるため、① A の pull が旧 cursor を読んで通信中(lock 保持)→ ② sign-out purge が sync_meta を clear → ③ B bootstrap が「不在 + 空」を観測し marker=B のみ書いて即 ready → ④ B の pull は inflight-skip / lock-busy → ⑤ A の pull が完了 tx で A 起点 cursor を書き戻す、で **marker=B + cursor=A 由来**が成立し、以後は marker 一致 fast path に入って fail-closed 検出が永遠に効かない(恒久汚染)。r2 §4.2 の「定常では marker が cursor に先行」はこの分岐では偽だった。2 分岐化により marker 書込は必ず「reset 経路の lock 区間内 + force-full 実完了が ready 条件」に置かれ、in-flight pull との全順序は §4.3 の lock 直列化が与える。**初回 device のコストは実質不変**(cursor 不在の通常 pull は元々 full。変わるのは「force-full 実完了まで ambient を開けない」ことだけで、これは reset 経路の既定挙動)。

**marker の書込点は 1 つだけ**: bootstrap reset 経路の `clear()` + marker put(同一 Dexie tx で原子・§4.3 critical section 内)。pull の cursor 永続化側(`lib/sync/pull.ts`)には書かない(client pull は内部 userId を知らないため。§1.1)。

**担保は 2 段**(絶対不変条件としては主張しない — 単一点主張の decay 教訓):

1. **定常(Web Locks 対応環境)**: marker / cursor / purge の書込は全て単一 lock 名の直列区間内で起こる(pull tx・bootstrap critical section・purge — §4.3)。ゆえに全順序が付き、reset 後に観測される cursor は必ず「critical section より後に完了した full pull」由来。
2. **異常残骸の backstop**: それでも残った不整合(Web Locks 非対応環境・書込途中の tab kill 等)は、marker 不一致 / 不在の全ケースが reset 経路に落ちる 2 分岐判定そのものが次回 mount で fail-closed に回収する。

**rollout 時の一回コスト**: 既存 device は全て「marker 不在」に該当し、初回 mount で一度だけ reset + full pull が走る(view prefs も一度消える)。受容。

### 4.3 SyncBootstrap と直列化規約(r3 で purge を統合)

**直列化規約(r3 核心)**: 以下の 4 参加者を**単一 lock 名 `recallmint:pull`(既存 `PULL_LOCK_NAME`・origin 内全タブ共有)** で直列化する。Web Locks の既定 mode は FIFO queued であり、tab 内外を問わず要求順に全順序が付く:

| 参加者 | lock 取得 mode | 変更 |
|---|---|---|
| 既存 pull(ambient / pullBack / 入口 kick = `runGuardedPull`) | `ifAvailable`(busy なら skip)| **無変更** |
| sign-out purge(`purgeAllLocalData`) | **queued**(必ず順番が来る)| r3 新規 |
| bootstrap critical section(marker 判定 → 必要なら clear + marker) | **queued** | r3 新規 |
| bootstrap force-full pull | `runGuardedPull` 経由(= `ifAvailable`)・skip / busy / fail は retry | r2 どおり |

- **purge の実行時再検証**: queued で順番が来た時点で「まだ signed-out か」を最新の auth 状態で再検証し、signed-in に戻っていれば**中止(完全 no-op)**。不変条件 = **「purge は自分より後に開始した session の書込を消さない」**。これで「purge 発火 → B が高速 sign-in → B の bootstrap + force-full 完了 → 遅延 purge が B の marker / mirror / cursor を clear」(Codex r2 Important 2)が封鎖される: purge が B の bootstrap より先に番を得れば B の判定は purge 完了後(cleared 状態を見て reset 経路)、後に番を得れば再検証で中止。effect cleanup に依存しない(開始済み Promise は cleanup で止まらない)。
- **bootstrap critical section を lock 内に置く理由**: marker 判定の開始時点で、先行する purge が「完了済み」か「中止確定済み」のどちらかであることを FIFO が保証する。r2 はここが無く、判定と purge が interleave し得た。
- **critical section と force-full を別 lock 区間に分ける理由**: Web Locks は非再入で、lock 保持中に `runGuardedPull`(内部で同 lock を取る)を呼ぶと deadlock する。分割の安全性: critical section 完了後は cursor が存在しないため、**間に挟まる任意の pull は必ず since 無しの full**になり無害(挟まった pull が fresh cursor を書いても、後続 force-full は cursor を読まないので全上書き — 収束論法はそのまま)。
- **同 tab の併用直列化**: purge / bootstrap critical section は module-level の serial chain でも直列化する(Web Locks 非対応 fallback の主担保。対応環境では lock が同じ順序を与えるだけで無害)。
- `withWebLock` に queued mode が無い(§1.1)ため、helper 拡張 or `navigator.locks` 直呼びが要る — 実装形は plan。

**bootstrap の手順**(`app/(app)/app/layout.tsx` の `<PullTrigger />` 直置きを `<SyncBootstrap userId={user.id}>` に置換。PullTrigger 自体は無変更で、ready まで mount しない — ambient pull の存在自体を消す):

1. **critical section(lock 内)**: §4.2 の 2 分岐判定 → fast path なら即 ready / reset 経路なら `clear()` + marker 書込(同 tx)。
2. reset 経路: lock を出て **force-full pull** を実完了まで反復 → `pullAllStudyDays()` → ready。
3. ready 後: PullTrigger を render し、`sweepForeignLocalData(userId)` を fire-and-forget で起動(§4.4)。

**force-full pull** = cursor を**読まずに** since 無しで `/api/pull` を叩き、成功 tx で server cursor を全上書きする新 option(`pullDelta` に force-full flag を追加。cursor read を skip するだけで tx / upsert 経路は既存のまま)。

**実完了の判定**(凍結・r2 どおり): force-full の完了条件は **自呼出の guard outcome `'ran'` かつ pullDelta 結果 `ok: true`** の両方。`'ran'` 単独は不可(§1.1 — pull 失敗でも `'ran'` が返る)。`'inflight-skip'` / `'lock-busy'` / `ok: false` は**未完了**として扱い、retry する(間隔 + online / visibilitychange 再試行、詳細は plan)。実完了まで PullTrigger は mount しない — その間 mirror は空で UI は空表示 + server fallback 経路(既存)が生きる。offline では ready にならない(意図的・§4.5)。

**fast path の遅延**: 追加待ちは queued lock 取得(通常 uncontended)+ marker read 1 回(ms オーダー)。pull / sweep / purge のいずれも待たない。通常 user(marker 一致)の体感変化なし。

### 4.4 実装形

新 module `lib/sync/local-purge.ts`(client-only、`getClientDb` 依存):

- `purgeAllLocalData(): Promise<void>` — §4.1 sign-out 列を §4.3 の直列化規約(queued lock + 実行時再検証)の下で実行。`Dexie.exists('recallmint')` を先に確認し、DB 未作成の visitor(marketing page)に空 DB を作らない。Dexie 書込は 1 rw tx にまとめる。Cache API は `typeof caches !== 'undefined'` guard 付きで tx 外(lock 区間内)。
- `sweepForeignLocalData(userId: string): Promise<void>` — §4.1 sweep 列(mirror + 異 owner synced outbox + Cache API のみ。**sync_meta には触らない**)。

**sweep を bootstrap の直列鎖から独立させる裁定**(r2 承認済・変更なし): cursor 健全性は §4.2/§4.3 の marker protocol が単独で完結して担保し、sweep の検出結果に依存しない。sweep の役割は at-rest 衛生に純化され、表示保証は読み層(§3)が担うため、ready を遅らせてまで直列化する理由がない。fire-and-forget・失敗 silent(次回 mount で再走)。

trigger component:

- `<SignOutPurge />` — root `app/layout.tsx`(ClerkProvider 内)に mount。`useAuth()` の `isLoaded && !isSignedIn` で `purgeAllLocalData()` を発火(**遷移イベントでなく signed-out 状態で発火** — Clerk UserButton の sign-out 実装に依存しない。session 失効・他タブ sign-out・退会も同経路)。r3: 発火は「queued lock 待ち行列への投入」であり、実行番での再検証用に**最新 auth 状態の参照**(ref 経由)を purge に渡す — 実行時点で signed-in なら中止。
- `<SyncBootstrap userId={user.id}>` — `app/(app)/app/layout.tsx` に mount(§4.3)。userId は layout の `getCurrentUser()` 由来(内部 id。client の Clerk hook からは内部 id が確実に取れないため RSC props で渡す — §1.1)。

### 4.5 前提要件と受容するリスク・コスト(記録)

**前提要件(r3 明記)**: §4 の cross-tab 直列化保証(§4.2 担保 1・§4.3 規約)は **Web Locks 対応ブラウザを要件とする**。非対応時は `withWebLock` が lock なし直実行に fallback し(`lib/sync/with-web-lock.ts:51`)、同 tab の module-level 直列化のみ残る(cross-tab 保証なし)。対象環境(iOS 16.4+ 等)は全対応(同 file コメント)であり受容 — 非対応環境で生じ得る不整合は §4.2 担保 2(次回 mount の fail-closed)が回収する。この要件は §7-5 で architecture.md に 1 行記録する。

1. **sweep と表示の race**: sign-in 直後、sweep 完了前に useLiveQuery が読む可能性。表示保証は読みスコープ化が担い、sweep は at-rest 衛生に限定する層設計なので問題にしない。
2. **sign-out のたびに次回 sign-in が full pull になる**(sync_meta 全消しの帰結)+ **rollout 時に既存全 device が一度 reset + full pull を踏む**(§4.2)。sign-out は稀な操作であり、cursor 汚染の根絶を優先。受容。
3. **view prefs が sign-out / reset で消える**(§4.1 根拠)。受容。
4. 前 user の pending / failed outbox 行の at-rest 残置(§2 で別裁定へ)。
5. **reset 経路(初回 device 含む — r3)の offline は ready にならない**(§4.3 — 「欠落 mirror を正と誤認させない」ための意図的挙動)。初回 device の通信量は実質不変(§4.2)。受容。
6. **purge が queued lock 待ちのまま tab close で未実行に終わり得る**(r3 追加): SignOutPurge は状態駆動で次の signed-out 表示時に再発火し、それも逃した残骸は次回 bootstrap の fail-closed + sweep が回収する。受容。

## 5. テスト戦略

Vitest + fake-indexeddb(`lib/cards/get-custom-session-cards.test.ts` 等の既存パターンに乗る)。Cache API は `lib/media/cache.test.ts` の mock パターンを再利用。lock は `MinimalLockManager` 互換の **fake FIFO lock manager** を注入して決定的に再現(`withWebLock` の `locks` 注入 hook と同設計)。実装は TDD(subagent-driven development)。mock で誤魔化さず、Dexie 実 query を fake-indexeddb 上で走らせる。

- **読みスコープ**(変更なし): 2 user 分を seed し、lib 層(get-custom-session-cards / tag-crud の同名 check・owner guard)は直接 unit、component 層(#4-11)は render + fake-indexeddb で「異 owner 行が結果に出ない」ことを pin。
- **purge**: mirror 全消し / sync_meta 全消し(**marker 含む**)/ synced outbox 削除 / **pending・syncing・failed 生存** / DB 未作成時に DB を作らない、を各 1 pin。
- **sweep**: 異 owner のみ削除・自 owner 生存 / 異 owner synced outbox 削除・pending 生存 / **sync_meta 不干渉**(cursor・marker・prefs が sweep で変化しない)、を各 1 pin。
- **marker / bootstrap(凍結条件)**:
  - **cursor-only 残存**: marker 不在 + cursor 存在 → reset(clear + marker 更新)+ force-full pull が走る pin。marker 不一致 + cursor 存在 → 同上 pin。
  - marker 一致 → sync_meta 不変・reset も force-full も走らない(fast path)pin。
  - **r3 反転**: marker 不在 + **sync_meta 空**でも reset 経路に入り、**force-full 成功まで ready にならない** pin(r2 の「marker 書込のみ・reset なし」pin は削除)。
  - **pull/bootstrap 競合**: bootstrap ready 前に PullTrigger の pull が開始されない pin(conditional render の検証)。
  - **`'inflight-skip'` / `'lock-busy'` / `ok: false` を完了扱いしない** pin(retry され ready にならない)。`'ran'` + `ok: true` でのみ ready になる pin。
  - force-full が cursor を読まず since 無しで叩く pin(既存 pullDelta test の client mock パターンで URL を検証)。
- **purge/bootstrap 直列化(r3 追加・凍結条件)**: fake FIFO lock で遅延 purge と B bootstrap を意図的に重ね、**最終状態が B の marker / cursor / mirror になる**ことを両経路で pin:
  - **purge 完了待ち経路**: purge が先に番を得る → B の判定は purge 完了後に走り reset 経路 → 最終状態 = B。
  - **purge 中止経路**: B の bootstrap 完了後に purge の番が来る → 実行時再検証(signed-in)で中止 → B の書込が一切消えない。

## 6. stg smoke 方針(詳細は plan で)

Playwright MCP で共有ブラウザ切替を実走: user A で sign-in → mirror 実在 + **sync_meta readback(`sync_owner_user_id` = A の内部 id + cursor 存在)** → sign-out → **IDB: mirror 空 + sync_meta 空**を確認(pending 残存は flush が速く実走再現が難しいため unit pin を正とする — plan に 1 行明記)→ user B で sign-in(OTP 424242)→ **A の行が IDB にも UI にも無い + marker = B の内部 id + B の full pull 成立(cursor reset の実証)**。加えて **cursor-only 残存の実走**: B の状態で DevTools から sync_meta に異値 marker を注入 → reload → reset + full pull が走ることを Network(since 無し `/api/pull`)で確認。**purge × bootstrap の重畳 race は実走での決定的再現が困難なため §5 の直列化 pin を正とする(plan に 1 行明記)**。退会 purge は破壊的のため smoke 対象外(sign-out と同一経路の構造保証で足りる)。

## 7. 完了条件

1. §3 の 15 箇所(11 置換 + 4 guard)適用、§5 のテスト green(red 実証込み。**§5 の凍結 pin(cursor-only 残存 / marker 不在=空でも reset / pull・bootstrap 競合 / purge・bootstrap 直列化の両経路)は凍結条件**)。
2. §4 の purge / marker / bootstrap / sweep 実装 + テスト green。
3. canonical + Codex review 収束(Critical 0 / Important 0)、`[reviewed]`(データ保全に触れるため「重要 Fix の裏取り」規律に従い、stg smoke を要する場合は session doc を正記録とする既存裁定に従う)。
4. whole-repo lint exit 0 / `pnpm test:iso` green / `pnpm run audit` exit 0(sprint 完了 gate)。
5. `docs/architecture.md` §1 outbox owner 行の実測記述と §残余リスクの該当行を「解消済(本 sprint)」へ更新。cursor 汚染の解消機構(owner marker + 単一 lock 直列化 + force-full)と **Web Locks 対応をブラウザ要件とする 1 行**を §1 に追記。
