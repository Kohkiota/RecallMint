# tag mirror sprint 追加 fact-finding — client 持続状態への全書込点の棚卸し / Path B 実現性 / purge 再検証の判定値

- 日付: 2026-08-16
- 目的: spec r4 の入力。r3(`docs/superpowers/specs/2026-08-16-tag-mirror-owner-scope-and-signout-purge-design.md`、commit `addb3f5`)は Codex r3 で NO-GO。**反例駆動で lock 参加者が増え続けた**ため方法を転換し、書込点の全数棚卸しから protocol を導出する。
- 調査のみ(実装なし)。**Path A / B と sprint 分割の裁定は OT 側**。本 doc は事実 + 一部に「推奨」を明示ラベル付きで記す。
- 調査 HEAD: `addb3f5`(develop)。

---

## 0. 方法と完全性の主張

### 0.1 探索の起点(この全数で表が閉じる)

書込点の universe は次の 2 本の全数走査で閉じる:

```
grep -rnE "\.(put|bulkPut|add|bulkAdd|update|modify|modifyByKeys|delete|bulkDelete|clear)\(" app lib --include="*.ts" --include="*.tsx" | grep -v "\.test\."   # 176 行(Dexie 以外を含む候補)
grep -rn "caches\." app lib --include="*.ts" --include="*.tsx" | grep -v "\.test\."                                                                              # Cache API
```

**探索範囲を `app/` + `lib/` に限ってよい根拠**(= 上位ディレクトリの取りこぼしが無いこと):

- repo のトップレベル source ディレクトリは `app/ components/ lib/ db/ drizzle/ scripts/ tests/ types/ vitest-stubs/`。
- **`components/` 配下に `getClientDb` は 0 件**、`getClientDb` を含む非テスト file は全て `app/` か `lib/` の下(grep 実測)。`db/` `drizzle/` `scripts/` は server / build 側で Dexie に触れない。
- → client 持続状態への書込は `app/` + `lib/` に閉じる。

### 0.2 間接経路(直接 `db.<store>.put()` と書かれていない書込)

以下は helper 経由のため素の grep では書込点に見えない。呼び出し元を辿って書込点として数える:

- `lib/sync/optimistic-mutation.ts` の `runOptimisticCreate` / `runOptimisticUpdate` / `runOptimisticMutation`(mirror + outbox を 1 tx で書く)
- `lib/sync/outbox-ops.ts` の `modifyByKeys` / `dropStaleByKey`(outbox の status 遷移)
- `lib/sync/sync-meta.ts` の `setSyncMeta` / `setJsonSyncMeta`
- `lib/media/` 配下(`media_assets` / `media_download_jobs` / Cache API)

### 0.3 非 React・background 経路が無いことの確認

- **Service Worker の登録は repo に存在しない**(`serviceWorker|workbox|sw\.js` の grep 0 件、`public/` に SW ファイル無し。`public/manifest.json` は PWA manifest のみ)。→ background sync / SW 由来の書込は無く、**全書込は page JS 由来**。
- `BroadcastChannel` / `storage` event の使用も 0 件 → **cross-tab 調停の既存機構は Web Locks のみ**。

---

## 1. 全書込点の棚卸し

総数: **Dexie 直接 59 statement + 間接(`runOptimistic*` 呼出元)23 件 + Cache API 書込 2 件**。候補 181 行を 1 行ずつ分類して残余 0(内訳は §1.5)。

### 1.1 pull 経路(唯一 `recallmint:pull` lock 内で書く群)

| file:line / 関数 | store | 書込の型 | 起動契機 | 直列化 | owner 由来 |
|---|---|---|---|---|---|
| `pull.ts:205,206,210,211` `pullDelta` | cards / exams / tag_categories / tag_options | bulkPut | mount / visibility / online / pullBack / 各入口 kick | **`recallmint:pull` lock 内**(+ module `pullInFlight`) | server payload(auth 解決の user_id 同梱)|
| `pull.ts:219-222,225,254-257,260` | card_tags | delete(where)/ bulkPut | 同上 | 同上 | **owner 述語なし**(card_id / option_id 由来)|
| `pull.ts:243-246` | cards / exams / tag_categories / tag_options | bulkDelete(tombstone)| 同上 | 同上 | **owner 述語なし**(PK 指定)|
| `pull.ts:265,267,269,274,279,284` | **sync_meta**(cursor 6 本)| put ×6 | 同上 | 同上 | **owner 列を持たない** |

### 1.2 lock 外で走る「回収不能 / 破壊的」writer(§4 の要注意群)

| file:line / 関数 | store | 書込の型 | 起動契機 | 直列化 | owner 由来 |
|---|---|---|---|---|---|
| `study-days.ts:70` `pullAllStudyDays` | study_days | **`clear()` = snapshot 全置換の前半** | mount / visibility / online(`pull-trigger.tsx:52`)、flush 後 `pullBack`(`pull-back.ts:21`)| **なし**(Dexie rw tx のみ・lock も in-flight guard も無い)| **owner filter なし = 全 owner の行を消す** |
| `study-days.ts:72` | study_days | **bulkPut = 同 全置換の後半** | 同上 | **なし** | server payload(90 日 full snapshot)|
| `sync-meta.ts:82` `setJsonSyncMeta` | **sync_meta**(`exam_view_prefs`)| put | user 操作後の effect(view / 列表示 / 列固定 / peek 幅)| **なし** | **owner 列なし** |
| `sync-meta.ts:43` `setSyncMeta` | sync_meta | put | **production caller ゼロ**(定義のみ・実質 dead)| なし | owner 列なし |

→ **同一 `sync_meta` store に「lock 内 writer(cursor)」と「lock 外 writer(prefs)」が同居している**。

### 1.3 その他の直接書込(全て直列化なし)

| file:line / 関数 | store | 書込の型 | 起動契機 | owner 由来 |
|---|---|---|---|---|
| `review-events.ts:72` `recordAnswerEvent` | answer_events | add | user 操作(回答確定)| closure userId |
| `outbox-ops.ts:91` `dropStaleByKey` | entity_mutations | modify(→`failed`)| **mount**(`entity-mutation-flush-trigger.tsx:64-80` の IIFE)| pending 選別が owner-scope。**flush lock の外・kick 前**(CC 裏取り済)|
| `entity-mutations.ts:130,150` `enqueueEntityMutation` | entity_mutations | update / add | user 操作(全 outbox 経路)| closure userId |
| `optimistic-mutation.ts:213,307` | cards / tag_categories / tag_options | add / update | user 操作(§1.4 の 23 経路)| 行 user_id = caller の closure userId |
| `tag-crud.ts:213,215,216,258,259,506,509,511`(8 件)| card_tags / tag_options / tag_categories | delete / put | user 操作(タグ CRUD)| 一部 owner 述語なし(§3.3 の除外裁定と同型)|
| `reorder-handlers.ts:70,124` | tag_categories / tag_options | update(sort_key)| user 操作(D&D drop)| patch は user_id 非対象 |
| `reclaim-local-asset-blobs.ts:21` | media_assets | delete | **非同期 fire-and-forget**(card 削除 / bulk 削除 / option cascade / gallery 削除の後)| **tx すら張らない**(CC 裏取り済)。PK 指定・owner 述語なし |
| `delete-card-button.tsx:58` / `use-bulk-card-delete.ts:88` | cards | delete / bulkDelete | user 操作 | PK 指定 |
| `use-bulk-card-tags.ts:145,148` / `use-card-tag-toggle.ts:104,106` | card_tags | delete / put | user 操作 | put は行 user_id = closure userId |
| `use-move-cards.ts:168,220` | cards | update | user 操作(移動 / undo)| patch は user_id 非対象 |

### 1.4 間接経路 — `runOptimistic*` 呼出元 23 件(実質的な書込点)

いずれも **mirror store + entity_mutations を 1 Dexie rw tx に閉じる**。**全件 Web Lock なし**。owner は全件 closure の `userId`(RSC `layout.tsx` の `user.id` を props で thread)。

- カード系(7): `use-add-card.ts:71` / `delete-card-button.tsx:55` / `use-bulk-card-delete.ts:84` / `use-bulk-card-tags.ts:139` / `use-card-tag-toggle.ts:100` / `use-move-cards.ts:163` / 同 `:215`
- インライン編集(2): `inline-text-field.tsx:197` `commit` / `use-card-options.ts:267` `commit` — **両者とも user 操作に加えて「commit-on-unmount」経路を持つ**(`cards.get` の非同期完了コールバック: `inline-text-field.tsx:161` / `use-card-options.ts:327`)= **離脱の瞬間に撃たれる遅着 writer**
- タグ系(12): `category-create-form.tsx:66` / `option-create-form.tsx:78` / `category-row.tsx:104` / `option-row.tsx:142` / `tag-crud.ts:58,92,129,163,206,254,344,431,501`
- 画像(1): `upload.ts:494` `commitImages`(user 操作 / abandon 経路 / **mount sweep** 経由)

### 1.5 Cache API(`caches.*` 全呼出 3、うち書込 2)

| file:line | 書込の型 | 起動契機 | 直列化 | owner 由来 |
|---|---|---|---|---|
| `lib/media/cache.ts:19-20` `putAssetBlob` | put | user 操作(添付 `upload.ts:710` / デッキ DL `deck-download.ts:198`)、非同期完了(表示解決 `get-asset.ts:73`)| attach = per-card chain / DL = per-exam lock / 表示解決 = module `inFlight` Map | key に userId(`/__media/{userId}/{assetId}`)|
| `lib/media/cache.ts:36-37` `deleteAssetBlob` | delete | abandon / sweep / reclaim / DL rollback | 経路依存(sweep lock / DL lock / **reclaim は直列化なし**)| 同上 |

### 1.6 media 系(lock 内で書く群)

`upload.ts:711,768,771,810`(media_assets)は module-level の **per-card chain**(`cardImageOpChains`)+ WebKit は `imageWorkChain` で直列化。`deck-download.ts:111,154,184,201,212`(media_download_jobs)は `recallmint:media:download:${examId}` lock 内。`sweep.ts:102,135` は `recallmint:media:sweep` lock 内(選別が `user_id === userId`)。

### 1.7 完全性の根拠(分類の残余ゼロ)

- 起点 grep の全数 **181 行**を 1 行ずつ分類し残余 0。内訳: **Dexie 書込 59** / **Cache API 書込 2** / 除外 120(Drizzle の server DB 操作 50、JS `Set`/`Map`/`URLSearchParams` 48、コメント行 15、`createHash().update()` 4、外部 SDK(Stripe / Clerk)3)。判定は変数定義まで遡って行った(`db` が Dexie か Drizzle か、`store`/`mirrorStore`/`table` が Dexie `Table` 型か)。
- **パターン外を塞ぐ追加走査**(いずれも production 0 件): `\.bulkUpdate\(` / `\.toCollection\(\)\.(modify|delete)\(` / `deleteDatabase` / `Dexie.delete(`。
- `getClientDb` を import する非テスト file **41 本を全数走査**し、表に無い 17 本が **read-only** であることを確認。
- **`getClientDb()` 経由以外の Dexie 書込経路は存在しない**: `ClientDb` の instantiate は `lib/client-db.ts:397` の 1 箇所のみで、`new ClientDb()` の他の呼出も `new Dexie(...)` も production に無い。
- 注意点: Dexie table object は helper 引数として渡されるため(`optimistic-mutation.ts` の `mirrorStore`/`store`/`stores`、`outbox-ops.ts` の `table`)、**書込文の file:line と対象 store が 1:1 対応しない行が 4 つある**(§1.1 の `outbox-ops` / `optimistic-mutation` 群)。実 store は §1.4 の caller 表で解決済。
- **localStorage / sessionStorage への書込は 0 件**(CC 本体および別調査の grep で二重確認 — 網羅表の対象外だが、client 持続状態の全量としてここで閉じる)。

### 1.8 直列化機構は 3 種が併存する(protocol 設計への含意)

| 機構 | 対象 | cross-tab 保証 |
|---|---|---|
| Web Locks(5 lock 名・§2)| pull / 2 flush / media DL / media sweep | **あり**(Web Locks 対応時のみ)|
| module-level in-flight guard(`pullInFlight`)| pull | **なし**(tab local)|
| module-level promise chain(`upload.ts:432 cardImageOpChains` / `:455 imageWorkChain`、`get-asset.ts` の `inFlight` Map)| 画像 attach / 表示解決 | **なし**(tab local)|

→ **「単一 lock で全 writer を直列化する」には、Web Locks を持たない後 2 者の経路も同じ lock に載せ替える必要がある**(現状は別機構)。

---

## 2. lock 名の全数と「単一 lock」前提の成否

`grep -rn "lockName\|LOCK_NAME\|navigator\.locks\|withWebLock"` の全数。repo に併存する Web Lock 名は **5 種**:

| lock 名 | 定義 | 用途 | userId 名前空間 |
|---|---|---|---|
| `recallmint:pull` | `lib/sync/pull.ts:307` | pull(`runGuardedPull`)| なし |
| `recallmint:entity-mutations:flush` | `lib/sync/entity-mutation-flush.ts:31` | entity mutation flush | なし |
| `recallmint:review-events:flush` | `lib/sync/review-flush.ts:36` | review event flush | なし |
| `recallmint:media:download:${examId}` | `lib/media/deck-download.ts:68` / `lib/media/sweep.ts:128` | デッキ DL | exam 単位のみ |
| `recallmint:media:sweep` | `lib/media/sweep.ts:152` | media sweep | なし |

r3 の「単一 lock protocol」に直接効く事実:

1. **lock 名を分けたのは意図的な既存設計判断**。`lib/sync/entity-mutation-flush.ts:28` に「review-flush の `FLUSH_LOCK_NAME` とは別名にし、演習 flush との lock 競合を避ける」と明記。→ r3 の「単一 lock に統合」はこの判断と衝突する(統合すると flush と pull が相互に待つ)。
2. **`pullAllStudyDays` はどの lock も取らない**(§3.1)。
3. `withWebLock` は **`ifAvailable: true` 固定**(`lib/sync/with-web-lock.ts:59-66`)で **queued mode を持たない**。
4. Web Locks 非対応時は **lock なしで直実行**(`同 :54-57`)。
5. **前例**: `lib/media/sweep.ts:112-114` は Web Locks 非対応環境では **sweep 自体を実行しない**(`if (typeof navigator === 'undefined' || !navigator.locks) return`)。= 「lock が無いなら危険操作をやらない」という既存の選択が repo にある。

---

## 3. Codex r3 指摘 2 件の裏取り(生出力で確認・**2 件とも真**)

### 3.1 pullAllStudyDays = lock 外の snapshot 全置換(真)

- `lib/sync/pull-back.ts:19-22`: `pullBack()` は `runGuardedPull({reason})` と `pullAllStudyDays()` を**それぞれ独立の fire-and-forget** で撃つ。
- `lib/sync/study-days.ts:51-76`: fetch 後 `db.transaction('rw', db.study_days, ...)` 内で `db.study_days.clear()` → `bulkPut(studyDays)`。**`with-web-lock` の import が無く、どの lock も通らない**。
- `db.study_days.clear()` は **store 全体**を消す(PK は `[user_id+day]` だが `clear()` は store 単位)。書き戻すのは「その fetch を撃った session の user」の 90 日分。→ **遅着 1 発で store 全体が旧 owner のものに置換される**。
- **`pull-back.ts:13-14` の header コメントは実体とズレている**: 「in-flight guard / Web Locks は runGuardedPull 側が担うため、pullBack を複数箇所から呼んでも二重 pull にならない」は `runGuardedPull` にのみ真で、同 file が撃つ `pullAllStudyDays` には偽。
- 呼び出し元は 2 つ: `pull-back.ts:21` と `app/(app)/app/_components/pull-trigger.tsx:52`。**PullTrigger は main pull(`:48`)と study-days pull(`:52`)を同一 kick 内で同時発火する** = Codex 指摘どおり。
- 非対称の実在: `app/(app)/app/exams/[id]/_components/exam-detail-pull-gate.tsx:47` の入口 kick は `runGuardedPull` のみで study_days を**意図的に含めない**(同 file に理由コメントあり)。

### 3.2 exam_view_prefs は pull lock を通らない sync_meta 直書き(真)

- `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx:163-178`: `useEffect` 内で `void setJsonSyncMeta(...).catch(() => {})` の **fire-and-forget**。
- gate は 2 つ(`if (!prefsLoaded) return` / `if (!userInteractedRef.current) return`)= **user 操作後にのみ発火**(mount echo write は抑止済)。
- `lib/sync/sync-meta.ts:76-83` → `getClientDb().sync_meta.put(...)` 直書き。**lock なし**。
- `setJsonSyncMeta` / `setSyncMeta` の非テスト呼び出し元は **`exam-detail-view.tsx:166` の 1 箇所のみ**。
- `sync_meta` に owner 列は無い(`lib/client-db.ts` `ClientSyncMeta` = `{key, value}`)→ **marker=B + prefs=A** は fast path でも sweep でも回収されない(sweep は `user_id` index 経路のため sync_meta に触れない)。

---

## 4. 遅着 writer の有害性分類(次 user への影響)

判定軸 = **書込先に owner 列があるか**(= 既存 sweep で回収可能か)。

| 分類 | writer | 次 user への影響 |
|---|---|---|
| **構造的に回収不能** | `sync_meta` 全般(pull cursor 6 本 `pull.ts:265-286` / `exam_view_prefs` / r3 が新設提案する marker)| owner 列が無く sweep が原理的に触れない |
| **破壊的(全 owner 巻き添え)** | `pullAllStudyDays` の `clear()` + bulkPut(`study-days.ts:70-73`)| store 全体を消して旧 owner の snapshot に置換 |
| 回収可能(owner 列あり) | pull tx の mirror bulkPut(cards / exams / tag_* / card_tags)、media_assets / media_download_jobs | 行に `user_id` があり既存 sweep(`where('user_id').notEqual(userId).delete()`)で回収可能 |
| 次 user に無害 | outbox status 遷移(`outbox-ops.ts:44-52 modifyByKeys` が `mutation_id` / `event_id` の **owner 由来 UUID** で選択)| 旧 owner 自身の行だけを触り、B の行に到達しない |
| 名前空間済 | Cache API `recallmint-media`(`lib/media/cache.ts:10-12` の `/__media/{userId}/{assetId}`)| key に userId が入る |

**この分類が r4 に与える帰結**: protocol が本当に守る必要があるのは上 2 分類、すなわち **① owner 列を持たない `sync_meta` と ② store 全体を消す `study_days` 全置換**だけ。残りは既存 sweep か owner-keyed 選択で既に閉じている。

**そして棚卸しはこの集合を増やさなかった** — これが方法転換の主収穫。§1 で新たに判明した「直列化なしの writer」(§1.3 / §1.4 の計 40 件超、うち `outbox-ops.ts:91` の mount 時 stale 隔離・`reclaim-local-asset-blobs.ts:21` の tx 無し削除・`inline-text-field.tsx:161` / `use-card-options.ts:327` の commit-on-unmount は本調査で初めて洗い出した)は、**1 件残らず下 3 分類(回収可能 / 無害 / 名前空間済)に入る**:

- mirror 行の書込は全て `user_id` を持つ(closure userId 由来)→ 既存 sweep で回収可能
- outbox の状態遷移は owner 由来 UUID 選択 → 次 user に到達しない
- media は Cache API が userId 名前空間、Dexie 側は `user_id` 列あり

→ **r1〜r3 で反例が出るたびに lock 参加者が増え続けたのは、この分類を先に立てず個別反例に逐次対応したため**。全数を見た結果、**要保護集合は 2 つで閉じている**(sync_meta / study_days 全置換)。r4 はこの 2 つだけを対象に protocol を設計すれば足り、それ以外の writer を lock に載せる必要はない。

補助事実: **Dexie store 全体の `.clear()` は repo 全体で `study-days.ts:70` の 1 箇所のみ**(もう 1 件の `lib/rate-limit/contact-action.ts:85` は server 側 in-memory `Map`(`:27 new Map<string, number[]>()`)で Dexie ではない)。

---

## 5. app layout の client trigger 一覧(Path A の gate 対象)

`app/(app)/app/layout.tsx:56-77` が mount する client component(全数):

| component | userId prop | 主な書込 |
|---|---|---|
| `<BFCacheGuard />` | なし | Dexie 書込なし(pageshow で server reload)|
| `<PullTrigger />` | **なし** | mirror 全 store + sync_meta cursor + study_days |
| `<ReviewFlushTrigger userId>` | あり | answer_events の status 遷移 |
| `<EntityMutationFlushTrigger userId>` | あり | entity_mutations の status 遷移 |
| `<MediaSweepTrigger userId>` | あり | media_assets / media_download_jobs / Cache API |

- **5 つとも同一 layout の兄弟**。→ Path A で「bootstrap ready まで全 writer を止める」場合、**conditional render の差し込み点は 1 箇所で足りる**(構造的に有利)。
- `<PullTrigger />` だけ **userId prop を持たない** = 書込値の owner は「その時の認証 session」由来で、client 側に owner 検証材料が無い(marker protocol が要る根本理由)。
- `app/(app)/app/_components/entity-mutation-flush-trigger.tsx:92-107`: **`pagehide` で best-effort flush を fire-and-forget** = 離脱 / sign-out の瞬間に撃たれる遅着 writer が構造的に存在する。

---

## 6. Path B(DB per-user 名前空間化)の実現性事実

### 6.1 `getClientDb` 依存点の数と分布(refactor 幅)

| 区分 | file 数 | occurrence |
|---|---|---|
| **非テストの実呼び出し** | **40** | **91** |
| テスト側 | 61(実呼び出しあり) | 622 |

CC 本体の cross-check でも 40 file / 91 occurrence / `useLiveQuery` 17 call site を再現(agent 報告と一致)。

非テスト 40 file のディレクトリ内訳: `app/(app)/app/exams/[id]/_components` 8、`lib/sync` 6、`app/(app)/app/tags/_components` 6、`app/(app)/app/exams/[id]/_hooks` 5、`lib/media` 4、`lib/cards` 2、`lib/tags` 2、他 1〜2。呼び出し密度上位は `lib/tags/tag-crud.ts` 13、`lib/media/upload.ts` 7、`lib/sync/entity-mutations.ts` 6。

**差し替えの局所性(Path B に有利な事実)**:

- **`ClientDb` 型を非テストコードで名指しする箇所は 0 件**(定義 file 外)。
- **`db: ClientDb` を引数 / props で引き回す非テスト関数は 0 件**。
- **module scope で instance を保持する file も 0 件** — `const db = getClientDb()` 35 occurrence はすべて**関数本体内**。
- → 依存は「関数実行のたびに無引数 `getClientDb()` を呼ぶ」形に完全に統一されており、**instance の解決点は 1 箇所(`getClientDb`)に集約されている**。

**Path B に不利な事実**:

- `ClientDb` の constructor は**引数を取らず**(`lib/client-db.ts:257-258` `constructor() { super('recallmint') }`)、`getClientDb()` も**引数を取らない**(`:390`)。**DB 名 / userId を注入する口が構造上ない** → 91 call site すべてに userId を渡す形にするか、別の解決手段(module scope の current-user 変数等)が要る。
- singleton は `let _db: ClientDb | null`(`:388`)の module private で、**reset / set / inject 用の export が無い**(`resetClientDb` / `setClientDb` 相当は 0 件)。

**userId の可用性**: 非テスト 42 file 中 39 file が `userId` / `user_id` token を持つ。持たない 3 file = `lib/cards/join-card-tags.ts`(Dexie 非依存)、**`lib/sync/sync-meta.ts`**(owner scope を持たない store)、**`lib/sync/study-days.ts`**(全消し置換に userId 引数なし)。→ **userId を持たない 2 file が、奇しくも §4 の「回収不能 / 破壊的」2 分類と一致する**。

### 6.2 DB 名 `'recallmint'` への直接依存(全 4 箇所)

| file:line | 内容 |
|---|---|
| `lib/client-db.ts:258` | `super('recallmint')` — **本番・唯一の生成点** |
| `lib/client-db.upgrade.test.ts:25` | `const DB_NAME = 'recallmint'`(`:84` `new Dexie(DB_NAME).delete()` / `:101` `new Dexie(DB_NAME)`)|
| 同 `:7` / `:14` | コメント |

- 本番コードで DB 名を外から渡す経路 / env / 定数 export は**無い**(リテラル直書きのみ)。
- 混同注意(**別物**): Cache 名 `'recallmint-media'`(`lib/media/cache.ts:6`)、Web Lock 名 5 種(§2)、PG role `recallmint_app`、PG DB `recallmint_test`、Stripe metadata `recallmint_downgrade`。

### 6.3 version 定義と migration 影響

- version 宣言は **12 個**(`lib/client-db.ts:259〜381`)、**`.upgrade(fn)` callback は repo 全体で 0 件**(CC 本体でも確認)。全 version が `stores({...})` の宣言的 schema delta のみ。
- → **新しい DB 名を開いた場合、data migration logic は一切走らない**(既存 DB を移送する処理も無い)。Path B で migration 起因のリスクは構造的に無い。
- store drop を含む version: v3 / v9 / v11。drop→再 create を 2 version に分けるペア: v9→v10、v11→v12。
- **未確認(外部検証要)**: Dexie 4.4.4 が「新規 DB を version 0 から開いたとき」に v1〜v12 をどう適用するかの実挙動。`lib/client-db.upgrade.test.ts:98-180` は**既存 DB を v10 で構築してから開く経路しか検証しておらず、新規 DB を 0 から開く経路の test は無い**。

### 6.4 liveQuery 購読構造(Path B の最大の未確認点)

- 非テストで `useLiveQuery(` を実際に呼ぶのは **10 file / 17 call site**。
- **17 call site すべてで `getClientDb()` は querier callback の内部で呼ばれる**。component body(render ごと)や module scope で instance を保持する箇所は 1 つも無い。
- **deps に `userId` を含まない call site が 4 つ**: `custom-filter-form.tsx:65,:69` / `category-list.tsx:132` / `option-list.tsx:132`(いずれも §3 で owner スコープ化対象の tag master 全件読み)。
- Dexie 実装(installed `dexie@4.4.4` / `dexie-react-hooks@4.4.0`):
  - `dexie-react-hooks.js:122-124` — `useLiveQuery` は `Dexie.liveQuery(querier)` という **static** に対して購読する(instance に張らない)。instance との結び付きは querier 実行時に読んだ store が observability key として登録されることでのみ生じる。
  - observability key は **DB 名を含む**: `dexie.js:4653` ほかで `"idb://" + db.name + "/" + table.name + "/" + idx.name`。通知は `globalEvents.storagemutated` 経由。
- **未確認(外部検証要)**: instance 差し替え後に既存 subscription が再評価されるトリガー。DB 名が変われば `idb://<旧DB名>/...` の key は一致しなくなるため、再評価は deps 変化に依存する可能性がある。deps に userId を含まない 4 call site は特に挙動が分かれうる。**実ブラウザ / fake-indexeddb での実験が要る**。

### 6.5 接続の open / close

- **非テストコードに `db.close()` / `db.open()` / `db.isOpen()` は 1 件も無い**。Dexie の autoOpen 任せで、**一度開いた接続は tab 生存中ずっと開きっぱなし**。→ Path B で instance を差し替える場合、旧接続を明示的に閉じる既存経路は無い。

### 6.6 既存 DB の列挙・削除手段

`grep -rn "indexedDB.databases\|Dexie.exists\|getDatabaseNames\|deleteDatabase"` → **ヒット 0 件**。

- `indexedDB.databases()` / `Dexie.getDatabaseNames` / `Dexie.exists` / `indexedDB.deleteDatabase` の**いずれも repo で未使用**。
- DB 削除らしき唯一の記述は test の `lib/client-db.upgrade.test.ts:84 await new Dexie(DB_NAME).delete()`。
- → sign-out purge を「他 user DB の削除」に置換する場合、**入口となる API を新規に導入することになる**(既存前例なし)。
- **未確認(外部検証要)**: `indexedDB.databases()` のブラウザ対応(特に Safari / Firefox)。repo に polyfill / feature detection / 判定コードは無い。
- 注: r3 spec §4.4 が前提にしている `Dexie.exists('recallmint')` も**現時点では repo 未使用の API**。

### 6.7 Cache API 側との整合

- cache 名は `'recallmint-media'` の **単一・user 非分離**、名前空間分離は **key の path 第 2 セグメントに userId を埋める方式**(`lib/media/cache.ts:6,10-12`)。
- `caches.*` を呼ぶ非テスト箇所は **`lib/media/cache.ts` 内の 3 つのみ**(`:19` `:27` `:36`、いずれも `caches.open(CACHE_NAME)`)。
- **`caches.delete(name)` / `caches.keys()` は repo で未使用** → r3 spec §4.1 の「sign-out で `caches.delete(CACHE_NAME)`」も新規導入 API。
- Dexie(DB 名固定 + store 内 `user_id` 列)と Cache API(cache 名固定 + key に userId)は**分離レイヤが異なる**。Path B は Dexie 側を Cache API 側の思想に寄せる形になる。

### 6.8 派生: 「key 名前空間化」という第 3 の形(事実のみ)

§4 で protocol が守る必要があると判明した対象は `sync_meta` と `study_days` の 2 つ。このうち `sync_meta` の面は非常に小さい:

- 既存 key は **7 本のみ**(`lib/sync/sync-meta.ts:16-27`): cursor 6 本 + `exam_view_prefs` 1 本。
- **書き手は 2 経路**(`sync-meta.ts:43` / `:82`)+ `pull.ts:265-286` の tx 内直書き 6 本。
- **読み手は 2 file のみ**(`pull.ts:128-133` の cursor 6 本 / `exam-detail-view.tsx:90` の prefs)。
- → sync_meta の key に userId を混ぜる形(Cache API と同思想)にする場合、触る面は **helper 2 関数 + cursor 6 本 + prefs 1 本**に収まり、**schema 変更は不要**(key は string のまま)。DB 名分離(91 call site)とは桁が違う。事実として記録し、裁定は OT に委ねる。

---

## 7. purge 実行時再検証の判定値

### 7.1 client で参照可能な auth 状態

**Clerk client hook の非テスト使用は 1 file・2 hook のみ**:

| file:line | hook | 読んでいる field |
|---|---|---|
| `app/(app)/app/settings/delete-button.tsx:19` | `useUser()` | **`user` のみ**(`isLoaded` / `isSignedIn` は分割代入していない)|
| 同 `:31` | `useReverification(() => user?.delete())` | `user.delete()` のみ |

- **`useAuth` の使用箇所は repo 全体で 0 件**(コード側ヒットは CLAUDE.md / docs の記述のみ)。`useClerk` / `useSession` / `useSignIn` / `getToken` / `<SignedIn>` / `<SignedOut>` / `<SignOutButton>` も **0 件**。
- **sign-out UI は Clerk `<UserButton />` 1 箇所のみ**(`app/(app)/app/_components/app-header.tsx:79`)。自前 sign-out ハンドラが無いため、purge の発火点に使えるのは**状態観測であって遷移イベントではない**。
- `proxy.ts` に auth 状態を header / cookie / body へ載せる自前処理は**無い**。client が観測できるのは「保護ルートで redirect されるか否か」の副作用のみ。Clerk cookie 名(`__session` / `__client_uat` / `__clerk_db_jwt`)への repo 内参照も 0 件。
- Clerk バージョン: **`@clerk/nextjs` 7.5.1**(`package.json:29` exact pin)。実体は `@clerk/react@6.9.0` / `@clerk/shared@4.17.0` / `@clerk/backend@3.6.1`。

**RSC props 経由で client に渡る user 識別子は、全 11 経路すべてが内部 `users.id`(UUID)**。`clerkId` / `clerk_id` を client component に渡す箇所は **0 件**。主要経路: `layout.tsx:65/:72/:76`(3 trigger)、`page.tsx:43/:45`、`exams/page.tsx:39`、`exams/[id]/page.tsx:55`、`tags/page.tsx:31`、`study/smart/page.tsx:57`、`study/custom/page.tsx:35`、`upload/page.tsx:49`。

### 7.2 session / generation 相当の概念 — **存在しない**

- **`sessionClaims` に載るのは 2 field だけ**: `dbUserId?: string` と `plan?: Plan`(`types/clerk.d.ts:26-30`)。session id・世代・sign-in 回数に相当する claim は宣言されていない。読み手は `lib/auth/ensure-user.ts:56,109,110` の 3 箇所のみ。
- **Clerk の session id を持ち回っている箇所は 0 件**(server の `auth()` は `userId` と `sessionClaims` しか分割代入していない)。
- `answer_events.session_id` は **auth と無関係**(`session-launcher.tsx:39` で演習開始ごとに client 採番する UUID。同 file `:11` に「Dexie にも server にも session 行はない」と明記)。
- **独自の generation / auth epoch / sign-in counter は repo に存在しない**。
- Dexie 11 store / `sync_meta` に auth・session 由来の値を保存している箇所も**無い**。`sync_meta` の既存 key 7 本はすべて cursor か view pref。
- **`sync_owner_user_id`(r3 §4.2 の marker)は未実装**(`sync_owner_user_id|syncOwnerUserId|SignOutPurge|SyncBootstrap|purgeAllLocalData|sweepForeignLocalData|local-purge` の grep が 0 件)= spec 側は draft、コード側は一切着手なし。
- `localStorage` / `sessionStorage` の使用も **0 件**。

→ **lock 内で読める「session 世代」的な値は、現時点で repo に何一つ無い**。導入するなら新規に作ることになる(marker 自体がその第一号)。

### 7.3 Clerk の cross-tab 反映挙動 — **外部検証要(repo 内に根拠なし)**

- 「別 tab で sign-in した結果が旧 tab の `useAuth()` に反映されるか」を判定できる **repo 内のコード・コメント・docs は存在しない**。
- repo の多タブ関連の実測記録は**すべて Web Locks(pull / flush 排他)に関するもの**で、Clerk auth の cross-tab 反映の実測は 1 件も無い。
- `BroadcastChannel` / `storage` event の言及は best-practice 比較 doc の一般論 1 行のみ(`docs/recallmint-idb-sync-bestpractice-comparison.md:25`)でコードには無い。
- Clerk 挙動の repo 内実測記録は **`signOut()` の hang リスク**のみ(`docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md:157-161`。dev instance × cross-origin × 3P cookie policy。cross-tab の話ではない)。
- **`useAuth()` は repo で一度も使われていないため、挙動の観測記録が存在しようがない**。
- 唯一の関連記述は r3 spec `:158` の「他タブ sign-out も同経路で拾える」という**設計主張**であり、実測の裏付けは spec 内にも repo 内にも無い。しかもこれは「他タブ **sign-out**」の話で、疑義の対象である「他タブ **sign-in** の反映」には言及していない。
- → **推測での断定はしない**。検証するには `@clerk/nextjs` 7.5.1 系の実装読解か実ブラウザ実測が要る。

---

## 8. テスト基盤(r4 の直列化 pin に効く)

- 既存の lock fake は **`fakeLocks(grant: boolean)` という stateless な boolean stub**(`grant=true` なら即 cb 実行 / `false` なら `cb(null)`)。**FIFO 待ち行列を模擬しない**。
- 同型の定義が **4 file に重複**: `lib/sync/pull.test.ts:613` / `lib/sync/with-web-lock.test.ts:9` / `lib/sync/review-flush.test.ts:93` / `lib/sync/entity-mutation-flush.test.ts:93`。
- → 「purge と bootstrap の順序」を pin するには **queued / FIFO を模擬する新しい fake が要る**(既存 4 つは順序を表現できない)。
- 注入 hook 自体は既存(`withWebLock` の `'locks' in options` discriminator / `runGuardedPull({pull, locks})`)なので、差し込む口はある。
- Dexie test は `fake-indexeddb` 実 DB 方式が主流(参照 file 55)。`vi.mock('@/lib/client-db', ...)` は **5 箇所のみ**。

---

## 9. 既存 doc との関係(r4 が更新・新設する対象)

- **`docs/architecture.md` に client 側 Web Lock / 直列化の不変条件行は無い**(:20 / :21 は flush の多重送信防止、:106 は **server 側**の行ロック取得順規約)。→ r4 は client 直列化の不変条件を**新設**する形になる。
- `architecture.md:106` は「規約はあるが、これを検出する汎用の gate は無い」と限界を正直に書く既存前例 = r4 で同型の限界を書く際の書式先例。
- r3 spec が前提にしている 2 つの API(`Dexie.exists` / `caches.delete`)は、いずれも**現時点で repo 未使用**(§6.6 / §6.7)。

---

## 10. 推奨(参考・裁定は OT)

事実から導かれる観測を 3 点だけ記す。結論ではない。

1. **要保護集合は 2 つで閉じた**(§4)。全数棚卸しは新しい保護対象を 1 件も追加せず、新たに見つかった 40 件超の「直列化なし writer」はすべて回収可能 / 無害 / 名前空間済に落ちた。→ **r4 は「全 writer を直列化する」設計をやめ、`sync_meta` と `study_days` 全置換の 2 点だけを扱う設計に縮められる**。これが反例駆動の増殖を止める構造的な根拠になる。
2. **`study_days` の全置換を owner スコープ削除に変えれば「破壊的」分類自体が消える**可能性がある(`clear()` → `where('user_id').equals(uid).delete()` 相当)。そうすれば残る protocol 対象は `sync_meta` 1 つに縮む。**ただし可否は本調査の範囲外** — `/api/study-days/pull` の payload owner が常に認証主体単一かの server 側確認が要る(§1 の未確認事項)。
3. **`sync_meta` を残る唯一の対象とするなら、その面は極小**(§6.8: 書き手 2 経路 + cursor 6 本 + prefs 1 本、読み手 2 file、schema 変更不要)。lock で守る / key を userId 名前空間化する / DB を分ける、のいずれでも触る量は Path B の 91 call site より 1〜2 桁小さい。
4. **Path B の refactor 幅は 91 call site だが、依存の形が完全に均一**(無引数 `getClientDb()` を関数内で呼ぶ・instance を引き回さない・module scope に保持しない)なので機械的変換自体は素直。真のリスクは §6.4 の liveQuery 再購読挙動と §6.6 の DB 列挙 API で、**いずれも repo 内に根拠が無く外部検証が要る**。Path A/B の裁定前にこの 2 点を実験で潰すかが分岐点。
5. **直列化機構が 3 種併存している**(§1.8)点は Path A の隠れコスト。Web Locks を持たない module-level chain / in-flight guard の経路を同じ lock に載せ替える作業が付随する(ただし §4 の結論により、要保護 2 点に関係する経路だけで済む可能性が高い)。

---

## Appendix A(2026-08-16 追記)— Codex review による訂正 4 点(採用済・CC 現物確認済)

本文は原文のまま保持し、以下の 4 点は**本 appendix が正**。いずれも Codex の fact-finding review 指摘を CC が生出力で裏取りした上で採用した。

### A-1. §6.8 の変更面は過小(訂正)

§6.8 の「触る面は helper 2 関数 + cursor 6 本 + prefs 1 本」は **key の面だけ**を数えており過小。cursor key を userId namespace 化するには、**pull 実行時に「どの user の cursor か」を知る必要があり、pullDelta への userId 伝播が必須**:

- `pullDelta` は userId 引数を持たない(`lib/sync/pull.ts:116`)。
- `PullTrigger` は userId prop を持たない(§5 の表のとおり)。
- `runGuardedPull` の直呼びは 9 call site / 8 file(`pull-trigger.tsx:47` / `pull-back.ts:20` / `exam-status-live.tsx:113,119` / `exam-title-inline-edit.tsx:159` / `create-exam-form.tsx:46` / `delete-exam-button.tsx:42` / `exam-detail-pull-gate.tsx:45` / `exam-card-table.tsx:810`)で、**userId を既に持つのは exam-card-table のみ**(残り 5 component は userId token 自体が file に無い — CC grep 実測)。
- → Path C(namespace 化)の実変更面 = helper + key 7 本 **+ pull 入口の userId 伝播一式**(pullDelta / runGuardedPull / pullBack / PullTrigger + 入口 component 群)。親 RSC は全て内部 userId を保有済(§7.1 の 11 経路)のため、伝播は prop drilling のみで新しい auth 解決は不要。

### A-2. §4 の「回収可能」の保証水準(訂正)

§4 の「owner 列あり = 既存 sweep で回収可能」は**即時回収と誤読しうる**。正しくは **eventual(次回 sweep 実行時に回収可能)**: sweep は mount 時の fire-and-forget 一回であり、**sweep 完了後に着地した遅着 writer の残骸は次回 mount まで残る**。表示保証は読みスコープ(spec §3)が担い、sweep はあくまで at-rest 衛生という層設計の帰結そのもの。

### A-3. §10-2 の「外部検証要」は解消(追加事実)

`/api/study-days/pull` の payload owner 単一性は **repo 現物で確定**:

- `app/api/study-days/pull/route.ts:24`(`withReadOnlyAuth` の handler)が **認証由来の `user.id`** を `withTenantTx(user.id, ...)` と `getAllStudyDaysForUser(user.id, tx)` の両方に渡す。
- `lib/db/study-days-pull.ts:50` `getAllStudyDaysForUser` が `WHERE eq(studyDays.userId, userId)`(`:57-60`)を強制。
- → payload 全行の owner は常に認証主体単一。§10-2 の「server payload 契約の確認が要る」は解消され、**study_days の owner 限定置換(clear → owner スコープ delete)は成立する**。

### A-4. §1.4「タグ系(12)」は 13 件(minor)

§1.4 のタグ系は列挙どおり **13 件**(component 4 + `tag-crud.ts` 9)。ラベルの「(12)」が誤記。23 件の総数は正しい(7 + 2 + 13 + 1 = 23)。
