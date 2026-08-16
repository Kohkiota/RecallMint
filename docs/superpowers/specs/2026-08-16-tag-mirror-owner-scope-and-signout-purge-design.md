# tag mirror 表示側の先行小修正 — owner スコープ読み + owner namespace 分離(spec)

- 日付: 2026-08-16(r5)
- 状態: **r4 凍結(OT 承認 / Codex spec review GO)+ r5 追記**。r5 = Codex plan review の Important 2 件 + OT 裁定 3 件を受けた最小改訂: **§5.1a owner echo による応答検証**(裁定 1)/ **§4.2 の限定 audit**(裁定 2)/ **§7 保証開始点**(裁定 3)/ **§7a rollback 方針**(Important 2)。§1〜§3・§5.1 capture 原則・§6・§8 は r4 のまま不変。
- 入力(正): `docs/superpowers/sessions/2026-08-16-dashboard-track-factfinding.md` §12 + **書込点の全数棚卸し** `docs/superpowers/sessions/2026-08-16-tag-mirror-writer-inventory-factfinding.md`(da99e11、**Appendix A の訂正 4 点を含む**。以下「棚卸し doc」)
- 背景: 公開前 gate ★ 項目(`docs/architecture.md` §1 outbox owner 行 + §残余リスク「共有ブラウザで他 user のタグが表示される」)の先取り。ダッシュボード分析 doc §4.5 の裁定により ③ とは分離した単独 sprint。
- **r4 の転換**: r1〜r3 の Path A(lock による時間的排他)は Codex review で 3 周連続 NO-GO(反例駆動で lock 参加者が増え続けた)。棚卸しの結果、**要保護対象は 2 つ(sync_meta / study_days 全置換)で閉じている**と判明したため、**Path C(owner による空間的分離)へ転換**し、sprint を 2 分割する:
  - **correctness sprint(本 spec)**: 読みの owner スコープ化 + sync_meta の userId namespace 化 + study_days の owner 限定置換。「異 owner データが表示されない」を構造保証する。
  - **hygiene sprint(別 spec・後続)**: sign-out purge / 異 owner sweep / Cache API cleanup / 旧残骸の物理削除。at-rest 衛生を eventual に担う。

## 1. 設計原則(凍結)

**要保護 2 点を、時間的排他でなく空間的分離で解く。** 遅着した writer は「自分が capture した owner の領域」に書くだけで、次 user の領域に触れない — race の参加者を列挙する義務そのものが消える。media cache の既存思想(key に userId を埋める `/__media/{userId}/{assetId}`、`lib/media/cache.ts:10-12`)と同型。

この転換により r2/r3 の機構は**全て撤回**する(§8 に記録): owner marker / SyncBootstrap / force-full pull / queued lock / purge 実行時再検証 / SignOutPurge / PullTrigger の conditional mount(sibling のままでよい)。

### 1.1 前提事実(棚卸し doc の要点のみ再掲)

- **要保護集合は 2 つで閉じた**(棚卸し §4): ① owner 列を持たない `sync_meta`(cursor 6 本 + `exam_view_prefs`)② `study_days` の `clear()`+`bulkPut` snapshot 全置換(repo 唯一の Dexie store 全消し・lock 外)。他の 40 件超の lock 外 writer は全て「回収可能(owner 列あり・eventual)/ 無害(owner 由来 UUID 選択)/ 名前空間済(Cache API)」。
- **study_days payload の owner 単一性は server 現物で確定**(Appendix A-3): `app/api/study-days/pull/route.ts:24` が認証由来 `user.id` を渡し、`lib/db/study-days-pull.ts:50` が `WHERE user_id` を強制。→ owner 限定置換は成立する。
- **pull 入口は userId を持っていない**(Appendix A-1): `pullDelta` は userId 引数なし、`PullTrigger` は userId prop なし、`runGuardedPull` 直呼び 9 site 中 userId 既保有は `exam-card-table.tsx:810` のみ。親 RSC は全経路で内部 userId(`users.id`)を保有済のため、伝播は prop drilling のみで新しい auth 解決は不要。
- 11 箇所の読みスコープ化対象は全 site で userId が手元にある(fact-finding §12)。schema 変更は全編通して不要。

## 2. スコープ / 非スコープ

**スコープ(correctness sprint)**: ① §3 読みの owner スコープ化 ② §4 sync_meta の userId namespace 化 ③ §5 pull 入口の userId capture 伝播 ④ §6 study_days の owner 限定置換 ⑤ 完了時の `docs/architecture.md` 更新(§10 完了条件 4)。

**非スコープ(hygiene sprint へ送る・別 spec で扱う)**:

- sign-out purge(IDB / Cache API の消去)
- 異 owner 残骸の sweep(mirror / outbox synced 削除)
- Cache API cleanup
- **旧 key(`cards_cursor` 等 userId なし)と旧 `exam_view_prefs` の物理削除**(§7-2: correctness に影響しないため本 sprint では放置)
- outbox の synced 削除
- pending / failed の at-rest 残置と flush-before-signout の別裁定(r1 からの引き継ぎ・claude.ai todo)

**非スコープ(従来どおり)**: mirror reconcile / タグ UI 増築(Dash-1 以降)/ ローカル answer_events の無限成長。

## 3. 設計 A: 読みの owner スコープ化(r1〜r3 で承認済・無変更で引き継ぎ)

### 3.1 全店読み 11 箇所

`toArray()` 直読を `.where('user_id').equals(userId).toArray()` に置換する。全 site で userId は既に手元にある。

| #     | file:line                                                             | 対象                 | userId 源     |
| ----- | --------------------------------------------------------------------- | -------------------- | ------------- |
| 1-2   | `lib/cards/get-custom-session-cards.ts:60-61`                         | categories / options | `c.userId`    |
| 3     | `lib/tags/tag-crud.ts:54`(rename 同名 check)                          | categories           | 引数 `userId` |
| 4     | `app/(app)/app/tags/_components/category-list.tsx:133`                | categories           | prop          |
| 5     | `app/(app)/app/tags/_components/option-list.tsx:133`                  | categories           | prop          |
| 6-7   | `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:202-203`   | categories / options | prop          |
| 8-9   | `app/(app)/app/exams/[id]/_components/exam-card-table.tsx:433-434`    | categories / options | prop          |
| 10-11 | `app/(app)/app/study/custom/_components/custom-filter-form.tsx:66,70` | categories / options | prop          |

`useLiveQuery` の deps が `[]` の site(#4 / #5 / #10 / #11)は `[userId]` に改める(#6-9 は既に `[examId, userId]`)。

### 3.2 `.get(id)` 直引きの owner guard(4 箇所)

`lib/tags/tag-crud.ts:50 / :87 / :121 / :158` に 1 行 guard: `if (!before || before.user_id !== userId) return`。mutation 入口に server 側 owner-存在 check と同型の防御を置く。挙動変化は「異 owner 行 = 不在と同じ silent no-op」。

### 3.3 除外裁定(owner 無スコープのまま残す読み)

owner-由来 UUID を key にした読みは、入口(3.1 + 3.2)が閉じれば異 owner 行への到達経路が無い(UUID v4 衝突は考慮しない)。`.and(user_id)` 全付けは noise、index 化は schema bump のため見送り:

- `where('category_id')`: `tag-crud.ts:125 / :210 / :290`、`category-list.tsx:144`、`option-list.tsx:123`、`option-row.tsx:69`
- `where('option_id')` / `where('card_id').anyOf(ownerScopedIds)`: `tag-crud.ts:293 / :306`、`category-list.tsx:152`、`get-custom-session-cards.ts:69`、`inline-card-list.tsx:215`、`exam-card-table.tsx:443`
- `countCategoryImpact` / `countOptionImpact` の signature は変えない。

## 4. 設計 B: sync_meta の userId namespace 化

### 4.1 key 形式(確定)

**`${base}:${userId}`**(suffix 型)。例: `cards_cursor:018f3c…`(userId = 内部 `users.id` UUID)。

- 旧 key(suffix なし)と新 key は文字列として衝突しない(userId は非空 UUID)。
- base 名の grep 可能性を保つ(`cards_cursor` で新旧とも引ける)。
- `SYNC_META_KEYS` 定数と `SyncMetaKey` 型は **base 名のまま不変**。store schema も不変(PK は string key のまま)。

### 4.2 実装形

`lib/sync/sync-meta.ts` に key builder を新設し、構成をここに一元化する:

```ts
export function scopedSyncMetaKey(base: SyncMetaKey, userId: string): string;
```

- 空 userId は throw(caller のバグ。`setJsonSyncMeta` の `schema.parse` throw と同じ fail-fast 契約)。
- helper の signature を userId 必須に変更: `getSyncMeta(key, userId)` / `getJsonSyncMeta(key, userId, schema)` / `setJsonSyncMeta(key, userId, value, schema)`。内部で `scopedSyncMetaKey` を通す。
- `setSyncMeta` は **production caller ゼロ**(棚卸し §1.2)のため namespace 化せず**削除**(dead code の空改修を避ける。test のみ更新)。
- `lib/sync/pull.ts` の tx 内 cursor put 6 本(`:265-286`)も `scopedSyncMetaKey(base, capturedUserId)` で構成する(§5 の capture 値)。
- `exam_view_prefs` も per-user 化: 読み書きは `exam-detail-view.tsx:90 / :166` の 1 file のみで、**userId prop を既に持つ**ため伝播は不要。副次効果として view prefs の user 間共有(微小な漏れ)も解消。

**規約(汎用 lint なし・限定 audit あり — r5 改訂 / OT 裁定 2)**: sync_meta の key は必ず `scopedSyncMetaKey` を経由して構成する。素の base 文字列での put / get を新規に書かない。

- **汎用 lint rule は作らない**(過剰)。
- **限定 audit test は作る**: production コードの `.sync_meta` 直接 access を**許可 file に限定**する grep test(想定 = `lib/sync/sync-meta.ts` / `lib/sync/pull.ts`。実際の許可 list は実装時に確定)。許可外 file での `.sync_meta` 出現を fail させる。将来の 1 件の直書きが保証全体を壊すのを、人的 review だけに依存させないため。
- 限界: audit は「どの file が触るか」しか見ず、許可 file 内での key 構成の正しさは検証しない。この限界ごと architecture.md に書く(§10 完了条件 4)。`docs/architecture.md:106`(server 行ロック順規約)と同型の「規約 + 部分的な機械検出」。

### 4.3 帰結: cursor 汚染の構造的解消

- B が sign-in すると、B の pull は `cards_cursor:<B>` を読む — **存在しないので since 無し = 自然に full pull**。A の cursor 残骸は `cards_cursor:<A>` に居るだけで B の読みに一切影響しない。**marker も bootstrap も検出 protocol も不要**。
- A の遅着 pull が完了しても、書く先は `cards_cursor:<A>`(§5 の capture 原則)— B の namespace は汚れない。
- **旧 key(userId なし)の残骸は correctness に影響しない**: 改修後は誰も読まない。物理削除は hygiene sprint。
- rollout の一回コスト: 全 device で新 key が不在のため、**改修後の初回 pull は一度だけ full**になる(+ 保存済み view prefs が一度リセット)。受容(r3 の「全 device 一回 reset」と同等でより穏当 — 消すのではなく読み先が変わるだけ)。

## 5. 設計 C: pull 入口の userId capture

### 5.1 capture 原則(凍結)

**`pullDelta` は開始時に受け取った userId を capture し、その invocation の cursor read と cursor write の両方に同じ値を使う。**「現在の user」を表す mutable な module 状態・store・auth hook を pull 完了時(cursor write 時)に参照する実装を**禁止**する — 遅着レスポンスが次 user の namespace に書かれる race を再生産するため。この原則は §9 の pin で凍結する。

### 5.1a owner echo による応答検証(r5 追記・OT 裁定 1)

**問題**: capture 原則は「書き先」を固定するが「書く値の由来」は固定しない。行検証だけでは **空 payload / tombstone-only 応答**を検証できない(`ClientTombstone` は `entity_type` / `entity_id` / `deleted_at` のみで **user_id を持たない** — `lib/db/tombstones-pull.ts:13-18` で確認)。ゆえに「`pullDelta(A)` 開始 → 認証 session が B に切替 → B の tombstone-only 応答 → `tombstone_cursor:<A>` に **B 由来の cursor** が書かれる」で A の namespace が汚染される。

**設計**:

- **server**: `/api/pull` の正常応答 top-level に **`owner_user_id: user.id`** を追加(`app/api/pull/route.ts` の `Response.json`)。**additive** — 旧 bundle client は未知 field を無視するだけで無害。
- **client**: `pullDelta` は **tx を開く前に** `body.owner_user_id === capturedUserId` を必須検証。加えて owner 列を持つ **5 stream**(`cards` / `exams` / `tag_categories` / `tag_options` / `card_tags`)の全行 `user_id` 一致も検証。**不一致・field 欠落はいずれも全体 reject**(mirror / cursor とも不変・既存 silent FAIL 契約に整合)。log は event 名 + 件数のみ(userId / payload 内容は出さない)。
- **tombstone は行検証が原理的に不能**(id のみ)。その検証責務は **owner echo が単独で担う**。
- **study_days は owner echo 不要**: cursor を持たない full snapshot であり、§6 の全行 `user_id` 検証で完結する(空 payload でも書く cursor が無いため汚染経路が存在しない)。
- **deploy 順序**: 「新 client + 旧 server(field 欠落)」は同一 deployment 内では発生しない(Vercel は client bundle と route を atomic に切り替える)。ただし **rollback で旧 server に戻す場合は新 client が全 pull を reject する**ため、roll-forward 原則(§7a)と併せて扱う。
- **既知の副作用(sign-up race)**: `withReadOnlyAuth` の `emptyBody` は **user 不在 path の静的リテラル**(`lib/auth/with-read-only-auth.ts:25,74`)ゆえ構造上 `owner_user_id` を持てない。→ sign-up race の空応答は client が reject する。**実害はゼロ**(payload 空 + cursors 全 null で元々書くものが無い)。特例分岐は設けず uniform な reject 規則を保つ(簡潔性規律)。数秒で解消する transient のため log noise も許容。

### 5.2 伝播経路(全数)

| 層                                      | 変更                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/sync/pull.ts`                      | `pullDelta(userId, client?)` に userId 引数追加。冒頭で capture、cursor read(`:128-133`)と write(`:265-286`)の key 構成に使用。**空 userId は即 FAIL を返し network / Dexie に触れない**(fail-closed・既存の silent 契約に整合)                   |
| `runGuardedPull`                        | `deps.userId` を追加し `pullDelta` へ渡す(guard 構造は無変更)                                                                                                                                                                                     |
| `lib/sync/pull-back.ts`                 | `pullBack(userId, reason)` に変更。**header コメント(`:13-14`)の「Web Locks は runGuardedPull 側が担うため二重 pull にならない」を実体に合わせ修正**(この主張は `pullAllStudyDays` に偽 — 棚卸し §3.1)。§6 の `pullAllStudyDays(userId)` へも伝播 |
| `PullTrigger`                           | userId prop 追加(`layout.tsx` の `user.id` — 既に 3 兄弟 trigger へ渡している実績と同型)                                                                                                                                                          |
| 入口 kick component(userId 未保有 5 件) | `exam-detail-pull-gate.tsx` / `create-exam-form.tsx` / `delete-exam-button.tsx` / `exam-title-inline-edit.tsx` / `exam-status-live.tsx` に userId prop 追加。親は全て内部 userId 保有済(Appendix A-1)                                             |
| userId 既保有の呼び出し元               | `exam-card-table.tsx:810`(prop あり)/ `pullBack` 経由 3 件(`session-runner.tsx:328,346` / `entity-mutation-flush-trigger.tsx:54` / `review-flush-trigger.tsx:29` — いずれも userId 保有済)は引数追加のみ                                          |

## 6. 設計 D: study_days の owner 限定置換

`lib/sync/study-days.ts` の `pullAllStudyDays(userId, client?)` 化。処理順(単一 rw tx 内は 3〜4):

1. fetch(既存どおり。cursor 無しの full snapshot なので §4 の影響なし)
2. **payload 検証**: 全行について `row.user_id === userId` を検証。**1 行でも違反があれば batch 全体を reject** — `{ok: false}` を返し Dexie に一切書かない(部分書込なし)。既存の FAIL 契約(early return・silent・次トリガーで再試行)に整合。log 1 行(`study_days.pull.owner_mismatch` 等、event 名は plan)
3. `db.study_days.clear()` を **`db.study_days.where('user_id').equals(userId).delete()`** に置換(異 owner 行に触れない)
4. `bulkPut(studyDays)`(既存どおり)

- server は owner 単一を強制済(Appendix A-3)だが、client 側検証は **defense-in-depth**(将来の server 変更・契約 drift への fail-closed)。
- 呼び出し元の伝播: `pull-trigger.tsx:52`(§5 の userId prop)/ `pull-back.ts:21`(§5 の `pullBack(userId, reason)`)。
- 帰結: **遅着した A の study_days snapshot は A の行だけを置換する** — B の行は消えない。「破壊的」分類(棚卸し §4)が消滅する。

## 7. 保証水準の三層(凍結・Appendix A-2 と整合)

| 層                                   | 保証                         | 担い手                                                                             |
| ------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------- |
| **異 owner データが表示されない**    | **構造保証**(本 sprint)      | 読みスコープ(§3)+ namespace(§4-6)。残骸が IDB に居ても読み経路が構造的に到達しない |
| 異 owner データの IDB からの即時消去 | **保証しない**               | —(時間的排他を放棄した帰結。表示保証があるため correctness 上不要)                 |
| 残骸の除去                           | **eventual**(hygiene sprint) | sign-out purge / sweep(mount 時 fire-and-forget = 次回実行時に回収)                |

**保証の開始点(r5 追記・OT 裁定 3 = 受容 + 記録)**: 本保証は **r4/r5 bundle を実行している tab に限る**。deploy 前から開いたままの旧 bundle tab は、unscoped cursor への書込・`study_days.clear()`(全 owner 巻き添え)・owner 無スコープ読みでの表示を続けるため**保証外**。旧 tab の `clear()` による一時的な study_days 消失は、新 tab 側の次 pull で自然回復する。**stg smoke に旧 bundle 混在の検証は含めない**(保証外事項のため確認対象にしない)。

### 7a. rollback 方針(r5 追記)

**原則 roll-forward。** 本改修を rollback すると、旧版は unscoped cursor 6 本を再び読むが、**その値は別 user 由来でありうる**(改修前に残った残骸 = まさに本 sprint が解消した cursor 汚染)。ゆえに rollback は既知 bug(cursor 汚染・**under-fetch による silent 表示欠落**)を再開させる。「over-fetch 方向で冪等だから安全」ではない。

rollback がどうしても必要な場合は、**旧版が読む前に legacy unscoped cursor 6 本を削除して full pull を強制する互換 patch が必須**。patch 自体は事前に作らない(必要時に作る — YAGNI)。§5.1a の「旧 server へ戻すと新 client が全 pull を reject する」も同じ roll-forward 原則の下で扱う。

## 8. 撤回した設計と理由(r1〜r3 の記録・圧縮)

| 撤回した機構                                                    | 導入した review 周 | 撤回理由                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sweep 検出時の cursor 消去 / MirrorSweep sibling 配置           | r1〜r2             | 競合 pull の cursor 書き戻しで汚染固定化(r2 で判明)                                                                                                                                                            |
| sync_meta owner marker(`sync_owner_user_id`)                    | r2                 | namespace 化なら「所有者の判定」自体が不要(key が所有者を含む)                                                                                                                                                 |
| SyncBootstrap / force-full pull / PullTrigger conditional mount | r2〜r3             | 時間的排他の要 = 「全 writer の直列化」だが、棚卸しで lock 外 writer が増え続けることが判明(pullAllStudyDays / exam_view_prefs / commit-on-unmount / mount 時 stale 隔離…)。空間的分離は列挙義務そのものを消す |
| purge / bootstrap の queued lock 直列化 + purge 実行時再検証    | r3                 | 同上 + 再検証の判定値(`useAuth`)は repo 使用実績ゼロで cross-tab 反映が外部検証要(棚卸し §7)。purge 自体を hygiene sprint に分離                                                                               |
| SignOutPurge(状態駆動 purge)                                    | r1〜r3             | correctness には不要になった(表示保証は §3-6 で完結)。at-rest 衛生として hygiene sprint で再設計                                                                                                               |
| Web Locks 対応のブラウザ要件                                    | r3                 | 空間的分離は lock に依存しない(既存 pull lock は従来どおり残るが、本 spec の保証の前提ではなくなる)                                                                                                            |

根本の教訓: **時間的排他は「参加者の完全列挙」という完全性主張を要求し、それは反例駆動で崩れ続けた**(lesson: 単一点主張は無言で偽になる、の変奏)。空間的分離は遅着 writer が何本居ても成立する。

## 9. テスト戦略

Vitest + fake-indexeddb(既存パターン)。**r2/r3 の pin(marker / bootstrap / force-full / 直列化 / fake FIFO lock)は全て削除**。

- **読みスコープ**(維持): 2 user seed で lib 層 direct unit + component 層 render pin(§3 の全経路で異 owner 行が結果に出ない)。red 実証込み。
- **cursor namespace(新規)**: A の cursor(`cards_cursor:<A>`)存在下で B の `pullDelta` が **since 無し URL で叩く**(= cursor 不在扱い)pin / B の cursor write が `cards_cursor:<B>` に行き A の key が不変である pin。
- **userId capture(新規・凍結)**: `pullDelta(A)` の fetch 解決を遅延させ、解決前に B の pull を interleave しても **A の invocation は A の key に書く** pin(capture 値以外を参照しない実証)。
- **study_days(新規)**: 異 owner 行が置換後も生存する pin / payload に異 owner 行が 1 行混入で **全体 reject・Dexie 不変** pin / owner 限定 delete + bulkPut の正常系 pin。
- **prefs namespace(新規)**: `exam_view_prefs:<A>` と `:<B>` が独立に読み書きされる pin。
- **fail-fast(新規)**: 空 userId で `pullDelta` が FAIL を返し fetch されない pin / `scopedSyncMetaKey(base, '')` throw pin。
- **owner echo(r5 新規)**: ① `owner_user_id` 不一致(payload は空)で reject・**cursor 不変** ② **tombstone-only** 応答の `owner_user_id` 不一致で reject(行検証では捕まらない経路の実証)③ `owner_user_id` **field 欠落**で reject ④ 5 stream いずれかの行 `user_id` 不一致で reject・**mirror 不変**。
- **sync_meta 限定 audit(r5 新規)**: 許可 file 外の production コードに `.sync_meta` 直接 access が無いことを検出する grep test。

## 10. stg smoke 方針(詳細は plan で)+ 完了条件

**smoke**: user A で sign-in → 操作(cursor / prefs 生成)→ user B へ切替(OTP 424242)→ ① B の初回 pull が **since 無し full pull**(Network 検証)② B のデータが表示され **A のデータが UI のどこにも出ない**(tags / custom filter / exam table / dashboard)③ IDB readback: `cards_cursor:<A>` と `<B>` が併存、study_days に A/B 両方の行が共存(**A の残骸の IDB 残存は仕様 — 表示されないことが確認対象**)。

**完了条件**:

1. §3 の 15 箇所 + §4-6 の実装(**§5.1a の owner echo = server `/api/pull` の `owner_user_id` 追加 + client 検証を含む**)、§9 のテスト green(red 実証込み。**capture 原則 / owner echo の 4 pin / study_days 検証 reject / cursor namespace の pin は凍結条件**)。
2. canonical + Codex review 収束(Critical 0 / Important 0)、`[reviewed]`(データ保全に触れるため「重要 Fix の裏取り」規律に従い、stg smoke を要する場合は session doc を正記録とする既存裁定に従う)。
3. whole-repo lint exit 0 / `pnpm test:iso` green / `pnpm run audit` exit 0(sprint 完了 gate)。
4. `docs/architecture.md` 更新: ① §1 に新不変条件「**client 持続状態の owner 分離は空間的(owner 列 / userId 名前空間 key)に行う。sync_meta への読み書きは `scopedSyncMetaKey` 経由(許可 file 限定の audit test で部分的に機械検出・key 構成の正しさまでは見ない)、pull の cursor read/write は開始時 capture した userId を使い(mutable な現在 user の完了時参照は禁止)、応答は `owner_user_id` echo と 5 stream の行 owner で検証してから書く**」② §1 outbox owner 行の実測記述と §残余リスク行を「**表示漏れは解消(correctness sprint)・at-rest 残骸の除去は hygiene sprint へ**」と正確に更新(全解消と書かない)③ **保証開始点 1 行**(§7: r4/r5 bundle 実行 tab に限る・旧 bundle tab は保証外)。Web Locks 要件の行は**不要**。
5. hygiene sprint の spec 起草は本 sprint 完了後に別途(§2 の非スコープ列挙をその入力とする)。
