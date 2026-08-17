# tag mirror hygiene sprint — at-rest 衛生 + correctness follow-up(spec)

- 日付: 2026-08-17(r1 draft・OT spec review 待ち)
- 状態: 設計裁定は確定済 — OT 裁定 5 件(purge 発火点 / sync_meta 非対称 / media 不可侵 / M-c 例外化 / 受容コスト維持)+ Codex 事前指摘 4 件(cursor CAS / downloading jobs 不可侵 / purge の Dexie・Cache 分離 / allowlist リテラル固定)を全採用して織込済。
- 入力(正): correctness sprint session doc(`docs/superpowers/sessions/2026-08-16-tag-mirror-correctness-sprint.md` §7b・§8)/ correctness spec r5(`2026-08-16-tag-mirror-owner-scope-and-signout-purge-design.md` §2 非スコープ列挙・§7 三層)/ 棚卸し doc(`2026-08-16-tag-mirror-writer-inventory-factfinding.md`・Appendix A 含む)。store 分類の出発点は r3(`addb3f5`)§4.1 の purge / sweep 列(**r5 に同表は無い** — r4 改稿で削除済。bootstrap reset 列は廃止)。
- 背景: correctness sprint(Path C・prod 反映済)で「異 owner データが表示されない」は構造保証済。本 sprint は公開前 gate ★ の残り(at-rest 衛生)+ correctness follow-up 1 件(§7b)を閉じる。

## 0. 保証水準(凍結)

本 sprint の保証は **eventual hygiene**(r5 §7 三層の第 3 層)。表示保証(第 1 層)は correctness sprint で完結しており、本 sprint はそれを**毀損しないこと**が最上位の制約。

**correctness 非毀損の 3 条件(凍結)**:

1. **単一 rw tx**: purge / sweep の Dexie 削除は、触る全 store(mirror + sync_meta + outbox + media)を跨ぐ**単一 rw tx** で行う。「mirror だけ消えて cursor が残る」部分実行状態(同一 owner の再 sign-in で delta pull が silent 欠落を起こす)を構造的に禁じる。
2. **cursor CAS**(§3): pull の cursor 読取と apply tx の間の network 窓に purge / sweep が挟まった場合、apply tx が自壊検知して abort する。tx 直列化だけではこの時間窓を閉じられない(Codex 事前指摘)。
3. **不可侵集合**(§4.2): pending / syncing / failed outbox 全行(owner 不問)・非 `'ready'` の `media_assets` 行 + 対応 Cache blob・`'downloading'` の `media_download_jobs` 行 + `added_asset_ids` blob は、purge / sweep とも**触らない**。

purge / sweep 自体は **best-effort**: 発火保証・順序保証・完了待ちなし。失敗 silent・次回実行で回収。遅着 writer との race は「次回実行で回収」の eventual 保証で足りる。**lock / marker / bootstrap / 直列化機構は使わない**(r1〜r3 で撤回済・再導入禁止)。直列化・完了待ち・順序保証を要求する設計が必要になったら Path C の趣旨に反する — 設計を疑い OT に上げる。

**Cache API は「完全消去」を主張しない**: 遅着 `putAssetBlob`(表示解決の非同期完了 — `lib/media/get-asset.ts:73`)が purge / sweep 完了後に着地する経路が構造的に残る。userId namespace(`/__media/{userId}/{assetId}`)により correctness は非毀損で、残骸は次回 sweep が回収する。

## 1. スコープ / 非スコープ

**スコープ(実装順もこの順 — §2 は先頭固定、§3 は §4/§5 の前提)**:

1. §2 `/api/study-days/pull` の owner echo(correctness follow-up・session doc §7b)
2. §3 pull cursor CAS(purge / sweep が安全に存在できるための前提)
3. §4 sign-out purge(`<SignOutPurge />` + `purgeAllLocalData`)
4. §5 sign-in 異 owner sweep(`sweepForeignLocalData` + trigger)。**旧 key 物理削除(bare cursor 6 本 + 旧 `exam_view_prefs`)はここに統合**(独立 task を立てない — OT 裁定 2)
5. §6 M-c の解消(`option-list.tsx:123` の scope 非対称)

**非スコープ**:

- pending / failed の at-rest 残置解消と flush-before-signout — 公開前トラックで再裁定(OT 裁定済)
- mirror reconcile / タグ UI 増築 / ローカル answer_events の無限成長(従来どおり)

## 2. 設計 A: study-days の owner echo(先頭固定)

**問題**(session doc §7b が正記録): `lib/sync/study-days.ts` の行検証 `studyDays.some(row => row.user_id !== userId)` は空 payload `[]` に対して vacuous。異 session の空応答(B の study_days が 0 件 / sign-up race の `emptyBody`)が A の `pullAllStudyDays(A)` に着地すると、検証素通り → `where('user_id').equals(A).delete()` で A のローカル行が消える。**r5 §5.1a の「study_days は owner echo 不要」は誤り** — `/api/pull` に echo を導入した理由(行検証だけでは空 payload を検証できない)と同 class の穴をもう一方の endpoint に持ち越していた。r5 spec は凍結のまま改稿せず、訂正の正記録は session doc §7b + 本 spec。

**設計**(`/api/pull` の「echo + 行検証」2 段と同型に揃える):

- **server**: `/api/study-days/pull` の正常応答 top-level に **`owner_user_id: user.id`** を追加(`app/api/study-days/pull/route.ts`)。additive — 旧 client は未知 field を無視。`withReadOnlyAuth` の `emptyBody: { studyDays: [] }` は user 不在 path の静的リテラルゆえ構造上 echo を持てない(`/api/pull` と同じ既知副作用 — client が reject するが payload 空で実害ゼロ。特例分岐は設けず uniform reject を保つ)。
- **client**: `pullAllStudyDays` は tx を開く前に `body.owner_user_id === userId` を必須検証。**不一致・field 欠落は reject**(`{ok: false}`・Dexie 不変)。**空 payload でも echo 検証が単独で効く**(vacuous 穴の閉鎖)。既存の行検証(全行 `user_id === userId`)は 2 段目として維持。log は event 名 + 件数のみ。

## 3. 設計 B: pull cursor CAS(Codex 事前指摘 6)

**問題**: §0 条件 1 の単一 tx は purge / sweep 自身の原子性しか与えない。`pullDelta` は §1 で cursor を読み(tx 外)→ network fetch → §4 tx で apply + cursor write する。**cursor 読取と apply tx の間の窓**に purge / sweep が sync_meta を消すと、遅着した「旧 cursor 由来の delta」が空になった mirror へ apply され、新 cursor が書かれる — 次回 pull は delta 継続となり、purge で消えた行が**永続的に silent 欠落**する(correctness sprint が解消した under-fetch の再発)。

**設計**: `pullDelta` は §1 で読んだ cursor 6 本の値(**undefined = 不在も含む snapshot**)を capture し、**apply tx の先頭で同じ scoped key 6 本を tx 内再読して snapshot と全一致を検証**する。1 本でも不一致(値変化・消失・出現のいずれも)なら tx を abort し `{ok: false}` を返す — mirror / cursor とも不変。log は event 名のみ(`pull.cursor_cas_mismatch` 等、名称は plan)。回復は既存経路: 次 trigger の pull が cursor 不在を見て自然に full pull になる。

- **不一致 = §1〜tx の窓で他者(purge / sweep)が sync_meta を触った証拠**。同一 tab の並走 pull は `pullInFlight` + pull lock が既に排除しており、Web Locks 非対応 fallback で別 tab の pull が挟まった場合も abort は安全側(次 trigger で回復)。
- **tx scope は不変**: pull tx は既に `db.sync_meta` を含む(`lib/sync/pull.ts:244` の store list)。CAS 再読は tx 内の先頭 read が増えるだけ。
- **full pull(snapshot 全 undefined)で CAS pass 後に apply するのは正しい**: 間に purge が挟まっていても、full 応答は完全 snapshot なので空 mirror への apply は整合状態に落ちる。

**correctness sprint との境界(何を変え何を変えないか)**:

- **変えない**: capture 原則(開始時 userId を cursor read / write 両方に使う — 凍結 pin)/ owner echo + 5 stream 行検証と validate-before-tx の順序(凍結 pin)/ cursor の scoped key 構成 / FAIL の silent 契約。
- **変える**: apply tx の先頭に CAS 再読 + abort 分岐を追加するのみ。
- **CAS は owner 検証ではない**: owner 検証(誰のデータか)は tx 前で完結し、CAS(tx までに store が動いたか)は **tx 内でしか意味を持たない**並行性検証。correctness sprint の「検証は tx の前」凍結 pin と役割が異なり矛盾しない — この区別を実装コメントにも書く。
- **study_days に CAS は不要**: cursor を持たない full snapshot replace であり、purge が挟まった後の遅着 snapshot 再書込は「自 owner 行の at-rest 残骸」にしかならない(表示保証に非干渉・次回 sweep / purge で回収)。

## 4. 設計 C: sign-out purge

### 4.1 store 分類(r3 §4.1 の purge / sweep 列を出発点に、不可侵集合で改訂)

| store 群 | purge(sign-out・全 owner 対象) | sweep(sign-in・異 owner のみ) |
|---|---|---|
| mirror 6(exams / cards / study_days / tag_categories / tag_options / card_tags) | `clear()` | `where('user_id').notEqual(userId).delete()` |
| media_assets | **`status === 'ready'` の行のみ削除**(非 `'ready'` は不可侵) | 異 owner **かつ** `'ready'` のみ削除 |
| media_download_jobs | **`status !== 'downloading'` の行のみ削除** | 異 owner **かつ**非 `'downloading'` のみ削除 |
| sync_meta | **全消し(未知 key 含む)** | §5.1 の非対称規則(bare + `base:<other>` 削除 / `base:<self>` + 未知 key 温存) |
| outbox 2(answer_events / entity_mutations) | **synced のみ削除**(pending / syncing / failed 不可侵 — r1 承認済・不変) | 異 owner の synced のみ削除 |
| Cache API(`recallmint-media`) | 保護 blob(§4.2)以外の全 key 削除 | 異 owner namespace(`/__media/<other>/…`)の key のみ、保護 blob 除く |

Dexie 部は上記全 store を跨ぐ**単一 rw tx**(§0 条件 1)。Cache 部は tx 外・Dexie tx の後に best-effort(Cache は tx に載らない。blob だけ先に消えても表示解決の再 fetch(`get-asset.ts:73`)が回復経路になるため順序は正確性に効かないが、Dexie 先行を既定とする)。outbox の synced 選別は単独 `sync_status` index が無いため filter 走査(sign-out / sign-in 時の一回走査で許容 — r3 承認済と同じ判断)。

### 4.2 不可侵集合と media hazard(OT 裁定 3 + Codex 事前指摘 7)

**棚卸し doc に無かった新規 hazard**: 不可侵で残る pending images mutation は、`media_assets` の `'uploading'` 行を flush gate(`lib/sync/entity-mutations.ts:316` — `collectBlockedImageMutationIds`)の根拠にしている。purge / sweep が非 `'ready'` 行を消すと **gate が開き、実体の無い image key を server に確定させる**。同原則のレーン横断適用として、`'downloading'` job の行 + `added_asset_ids` blob を消すと進行中デッキ DL の all-or-nothing が壊れる。

**不可侵集合(purge / sweep 共通・owner 不問)**:

1. pending / syncing / failed の outbox 全行(answer_events / entity_mutations)
2. 非 `'ready'`(= `'uploading'` / `'failed'`)の `media_assets` 行 + 対応 Cache blob
3. `'downloading'` の `media_download_jobs` 行 + その `added_asset_ids` の Cache blob

Cache の保護集合は Dexie tx の後に、生存した非 `'ready'` 行と `'downloading'` job から算出する。非 `'ready'` 残骸の後始末は既存の `sweepStaleMedia`(stale `'uploading'` 1h 超を `abandonUpload` で outbox ごと矯正)が正規経路であり、hygiene sweep はこれを複製しない(YAGNI)。

**完了条件に含める**: この hazard を棚卸し doc の Appendix に追記する(§10-5)。

### 4.3 発火点: `<SignOutPurge />`(OT 裁定 1)

- root `app/layout.tsx`(ClerkProvider 内)に client component として mount。`useAuth()` の `isLoaded && !isSignedIn` の**状態駆動**で `purgeAllLocalData()` を 1 回発火(遷移イベントに依存しない — Clerk `<UserButton />` の sign-out 実装・session 失効・退会も同経路)。
- **`useAuth` は repo 初使用で、cross-tab 反映は未検証**(棚卸し §7.3)。best-effort ゆえこれを**保証にしない**: 発火しなかった残骸は次 sign-in の sweep が回収する(発火点の多重化はしない)。
- **実行時再検証・lock・queued 化はしない**(r3 の SignOutPurge から大幅単純化)。遅走 purge が新 session に挟まっても: mirror / cursor は単一 tx で同時に消え(CAS が in-flight pull を abort)、次 pull の full で回復。prefs 消失は受容コスト(§8)と同等。pending は不可侵。
- **Dexie 部の guard**: `Dexie.exists('recallmint') === false` なら Dexie 部を skip(未訪問 visitor に空 DB を作らない。dexie 4.4.4 の実装確認済 — 不在時は auto-create された空 DB を `deleteDatabase` してから false を返す)。**Cache 部は exists と独立に実行**(Codex 事前指摘 8 — guard の目的は「空 DB を作らない」に限定し、orphan Cache は DB 不在でも掃除する)。Cache 側は cache を新規作成しない形で掃除する(`caches.has` / `caches.delete` の使い分けは plan)。
- purge は冪等 — signed-out の marketing page 表示ごとに発火しても不変条件は同じ。

### 4.4 実装形

新 module `lib/sync/local-hygiene.ts`(client-only・`getClientDb` 依存)に `purgeAllLocalData(): Promise<void>` と `sweepForeignLocalData(userId: string): Promise<void>` を同居させる。削除対象の分類(§4.1 の表)は pure な判定関数に切り出して直接 unit test 可能にする。domain 層の新設はしない(ビジネス規則でなく同期基盤の衛生 — 既存 `lib/sync/` パターンに乗る)。

## 5. 設計 D: sign-in 異 owner sweep

### 5.1 sync_meta の非対称規則(OT 裁定 2 + Codex 事前指摘 9)

sweep と purge で sync_meta の扱いを**意図的に非対称**にする:

- **purge(sign-out)= 全消し(未知 key 含む)**: 去る側にローカル残骸を持つ権利はなく、全消しが fail-closed。
- **sweep(sign-in)= 既知 base の bare + `base:<other>` を削除、`base:<self>` と未知 key は温存**: sign-in した本人の状態と、**将来追加される非 scoped key** を silent に誤削除しないため。「自分の key 以外を全部消す」形にすると、将来 key が追加されるたびに sweep が黙って消し続ける regression を作る。

**allowlist はリテラル固定**(Codex 事前指摘 9): sweep が bare / scoped 判定に使う base 名 7 本(cursor 6 + `exam_view_prefs`)は、`SYNC_META_KEYS` から自動導出せず**明示リテラルの allowlist** として持つ。`SYNC_META_KEYS` に key を追加しても sweep 対象には自動追従しない — **key 追加時に「sweep 対象か否か」の判断を明示的に踏む**ことを規約化し、§9 の分類強制 pin で機械強制する(allowlist にも明示除外 list にも無い key が `SYNC_META_KEYS` に現れたら test が落ちる)。

**旧 key 物理削除の統合**: bare cursor 6 本 + 旧 `exam_view_prefs`(correctness sprint では残置が正 — smoke §10 手順 2 の「absent でも残存でもよい」)は、この規則の「bare 削除」がそのまま掃除する。独立 task は立てない。purge 側も全消しで同じ結果に達する(どちらが先でも回収される)。

### 5.2 trigger と並走安全性

- `app/(app)/app/layout.tsx` の既存 trigger 兄弟に sweep trigger を追加(`MediaSweepTrigger` precedent — `userId` prop・mount 1 回 fire-and-forget・UI なし・失敗 silent。component 名は plan)。
- **自分の pull との並走は非干渉**: sweep は異 owner 行 + bare / `base:<other>` のみ触り、pull は `base:<self>` namespace のみ読み書きする — 触る集合が交わらない。
- **遅着した異 owner pull との並走**: sweep が A の scoped cursor + mirror を消した後に A 起点の遅着 apply が来ても、CAS(§3)が abort する。sweep より前に apply が完了していた場合は A の残骸が残るだけ(表示保証に非干渉・次回 sweep で回収)。
- sync_meta の削除と mirror の削除は同一 tx(§0 条件 1)— 「A の mirror だけ消えて A の cursor が残る」中間状態を作らない。

## 6. 設計 E: M-c の解消(OT 裁定 4)

`option-list.tsx:123` の options 一覧 read(`where('category_id').equals(activeCategoryId)`)を owner-scope 化し(実装形 — `.and()` か filter か — は plan)、`useLiveQuery` deps に `userId` を追加する。**一覧 surface の pin を追加**する(異 owner 行を fixture で self の category 配下に混入させ、一覧に描画されないことを assert — 他 3 component の pin と同じ surface 検証)。

これは **r5 §3.3 の除外裁定(owner 由来 UUID key 直引きは無スコープで可)からの 1 件だけの例外**。挙動は §3.3 裁定下で現状も正しい(activeCategoryId は owner-scope な category list 由来)が、**同 file の dropdown read だけ owner-scope pin があり一覧 read に無い検証面の非対称**が、whole-branch review で「pin が assert する surface と実装の不一致」として指摘された(session doc §7a M-c)。例外化の理由は挙動 fix でなく**検証面の一貫性**。§3.3 の他の除外(tag-crud / category-list 等)は裁定どおり無スコープのまま。

## 7. correctness 非毀損の論証(失敗モード列挙)

| 失敗モード | 帰結 | 表示保証への影響 |
|---|---|---|
| purge / sweep が**不発**(tab close・useAuth 不発火) | 残骸が残る | なし — 表示保証は読み層(r5 §3-6)が担う。次回実行で回収 |
| Dexie tx が**途中失敗** | 全 store 巻き戻し(単一 tx) | なし — 「mirror 消・cursor 残」の部分状態が存在しない |
| Cache 部だけ失敗 / blob だけ先に消えた | blob 欠落 | なし — 表示解決が server から再 fetch(既存経路) |
| purge / sweep が pull の network 窓に**挟まる** | 遅着 apply が CAS abort | なし — 次 trigger の full pull で回復 |
| purge が新 session 開始後に**遅走** | 新 session の mirror / cursor が消える | 一時的に mirror 空(correctness sprint で受容済の liveness gap と同型)— 次 pull full で回復。pending 不可侵ゆえデータ喪失なし |
| **二重実行** | 冪等 | なし |
| 遅着 `putAssetBlob` が purge 後に着地 | Cache に残骸 | なし — userId namespace で読み経路が到達しない。次回 sweep で回収 |

## 8. 運用注意・受容事項

1. **server 単独 rollback 不可の非対称が `/api/study-days/pull` にも増える**(§2 の帰結): echo を戻すと新 client が study_days の全 pull を silent reject し、mirror が更新されなくなる(UI にエラーは出ない)。`/api/pull` と同型 — roll-forward 原則(r5 §7a)の適用範囲に本 endpoint を加える。
2. **受容コスト維持**(OT 裁定 5): sign-out のたびに ① 次回 sign-in が full pull(sync_meta 全消しの帰結)② `exam_view_prefs` が消える。r3 承認済の判断を引き継ぐ。
3. **`useAuth` の cross-tab 反映は未検証のまま**: purge の発火性を保証にしない設計(§4.3)によって blocking でなくなった。実測は smoke の観測項目に留める(不発でも FAIL にしない)。
4. **保証開始点**: correctness sprint と同じく、本 sprint の bundle を実行している tab に限る。旧 bundle tab は保証外。
5. **残置の明示**: pending / failed の at-rest 残置は本 sprint 後も残る(公開前トラックで flush-before-signout と併せ再裁定)。

## 9. テスト戦略(凍結 pin の柱)

Vitest + fake-indexeddb(既存パターン)。red 実証は gate を 1 つずつ個別変異(repo 教訓)。**correctness sprint の凍結 pin(capture 原則 / validate-before-tx 順序 / owner echo 4 pin / I-1 caller pin 含む)が全 green のままであること自体を完了条件に含める**。

1. **study-days echo pin 群**(§2): ① echo 不一致 +**空 payload** で reject・Dexie 不変(vacuous 穴の閉鎖を直接 pin)② field 欠落で reject ③ echo 一致 + 行 mismatch で reject(2 段の独立性)④ echo 一致 + 空 payload の正常系(自 owner 行の正当な全削除)。
2. **CAS pin**(§3): fetch 解決を遅延させ、その間に purge(または cursor 直接削除)を挟む → apply が abort し mirror / cursor 不変・`{ok: false}`。続く再 pull が since 無し full になるまでを pin。値変化・消失の両変異で red 実証。
3. **不可侵集合の生存 pin**(§4.2): purge / sweep それぞれで、pending / syncing / failed outbox 行(自 + 異 owner)・非 `'ready'` assets 行 + blob・`'downloading'` job 行 + added blob が生存し、synced / `'ready'` / 非 downloading が消えることを対で pin。
4. **allowlist pin**(§5.1): sweep が bare 7 本 + `base:<other>` を消し、`base:<self>` + **未知 key**(`future_key` / `future_key:<self>` の fixture)を温存する pin。**分類強制 pin**: `SYNC_META_KEYS` の全値が「sweep allowlist ∪ 明示除外 list」に現れることを assert(新 key 追加で test が落ち、分類判断を明示的に踏ませる)。
5. **tx 原子性 pin**(§0 条件 1): tx 途中の失敗を注入し、mirror / sync_meta / outbox が全て変更前のままである(部分実行が観測できない)ことを pin。
6. **M-c 一覧 surface pin**(§6)。
7. **SignOutPurge trigger pin**: `isLoaded && !isSignedIn` で発火 / signed-in で不発火 / `Dexie.exists` false で Dexie 部 skip + Cache 部は実行(Codex 事前指摘 8 の pin)。
8. **purge / sweep の分類 pin**: §4.1 の表を pure 判定関数の unit として直接 pin(store × 条件の table-driven)。

## 10. stg smoke 方針(詳細は plan)+ 完了条件

**smoke**(correctness sprint の A/B アカウントで CC 自走・purge 後の IDB readback 中心): ① A で操作 → sign-out → IDB readback: mirror 空・sync_meta 空(**bare legacy key も消える — correctness smoke §10 では残置が正だった点の反転**)・synced outbox 消・pending 残存(作れれば)・Cache の保護外 key 消 ② B sign-in → sweep 後の readback: A の残骸(sweep 経路で作った fixture)消滅・B の namespace 無傷 ③ `/api/study-days/pull` 応答に `owner_user_id` が載る(correctness smoke §10.1 #10 の反転)④ useAuth 発火の実挙動観測(不発でも FAIL にしない — §8-3)。

**完了条件**:

1. §2〜§6 の実装 + §9 のテスト green(red 実証込み。§9 の 1〜5 は凍結条件)+ correctness sprint の既存凍結 pin 全 green。
2. canonical + Codex review 収束(Critical 0 / Important 0)、`[reviewed]`。削除(データ保全)に触れるため「重要 Fix の裏取り」規律に従う — stg smoke を要するため session doc を [reviewed] の正記録とする既存裁定に従う。
3. sprint 完了 gate: whole-repo lint exit 0 / `pnpm test:iso` green / `pnpm run audit` exit 0。
4. `docs/architecture.md` 更新: ① hygiene 層の不変条件(purge / sweep は単一 tx + 不可侵集合 + best-effort、pull apply は cursor CAS で自壊検知、sync_meta sweep はリテラル allowlist)② 残余リスク行を「at-rest 残骸は eventual 回収(hygiene sprint)・pending / failed 残置のみ公開前トラックへ」と正確に更新。
5. **棚卸し doc へ Appendix 追記**(OT 裁定 3): media flush-gate hazard(§4.2)を新規発見として記録。
6. r5 spec は凍結のまま改稿しない(§5.1a の訂正の正記録は session doc §7b + 本 spec §2)。
