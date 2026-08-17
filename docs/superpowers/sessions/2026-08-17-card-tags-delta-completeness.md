# card_tags delta 完全性(authoritative replace)実装記録 — 2026-08-17

- **spec**: `docs/superpowers/specs/2026-08-17-card-tags-delta-completeness-design.md`(r3 凍結 + 同日 erratum)
- **plan**: `docs/superpowers/plans/2026-08-17-card-tags-delta-completeness.md`
- **fact-finding(正)**: `docs/superpowers/sessions/2026-08-17-card-tags-delta-loss-factfinding.md`
- **状態**: **Task 1〜5 完了**。stg smoke **総合 PASS**(§7a)。残 = prod 反映判断(spec §7-5 の prod 未リリース確認)。
- 実装方式 = `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)

---

## 1. commit 一覧(`0efa004..a4cdce7`)

| commit | 内容 | tag |
|---|---|---|
| `df8ca9e` | Task 1: `getCardTagsByCardIds` + iso pin 4 本(owner 2 層 / RLS backstop / full-stream contract) | `[reviewed]` |
| `befd671` | Task 2: route の authoritative replace + unit pin 11 本 + COVERAGE / contract mock 更新 | `[reviewed]` |
| `c55c27c` | Task 3: `pull.test.ts` の 2 pin に server 契約 I-1 を明記(**保証不変**・assert 不変) | `[no-review]` |
| `a4cdce7` | whole-branch review の Important 2 + Minor 4 を close(非挙動・comment/doc) | `[reviewed]` |

`[reviewed]` は **code review 完了のみ**を意味し rollout-ready ではない(OT 承認の今回限り例外・各 commit message に `smoke pending` を明記)。**rollout の正記録は本 doc の §7**。

## 2. sprint 完了 gate(fix wave 適用後に再測定・全 exit 0)

| gate | 実測 |
|---|---|
| whole-repo `pnpm lint`(`--max-warnings=0`) | **exit 0** |
| `pnpm typecheck` | **exit 0** |
| `pnpm test` | **301 files / 5356 tests passed** |
| `pnpm test:iso` | **39 files / 457 tests passed** |
| `pnpm run audit` | **exit 0**(prod high/critical 0) |

`pnpm build` は spec §7-3 どおりローカル gate に含めない(Next 設定 file 非接触)。push 後の Vercel build + stg smoke が後段 gate。

## 3. 実装の核(なぜこの形か)

server は 2 file のみ。client は無変更(I-5)。

- `lib/db/card-tags-pull.ts`: `getCardTagsByCardIds(userId, dbc, cardIds)` を追加。`and(eq(cardTags.userId, userId), inArray(cardTags.cardId, cardIds))`、cursor 条件なし、**戻り値に cursor 材料を持たせない**(I-2 の構造的表現)。既存 `getCardTagsDelta` / `getDeltaRows` / `toClientCardTag` は無変更。
- `app/api/pull/route.ts`: `withTenantTx` 内 7 本目として by-card read を発行し、**authoritative replace** で合成 — 変更 card は by-card 結果のみ採用、増分側の当該 card 行は捨てる、非変更 card の増分行は残す。`cursors.card_tags = ct.maxCreatedAt` は不変(I-2)。

**union を採らなかった理由(r3 の凍結 blocker)**: READ COMMITTED では「増分 SELECT が `c1:o_old` を取得 → 別 tx が削除 commit → by-card は `o_old` 不含」の競合列が成立する。pair union は stale 行を応答に残し、client が削除済み行を再投入し、次のタグ操作が whole-set replace op 経由でそれを server に再追加しうる。

**応答内の pair 一意性は構造で成立**: 残す増分行(非変更 card)と by-card 行(変更 card)は `card_id` で互いに素、各 source 内は PK unique。dedupe コードは不要。

## 4. 本 sprint で新たに判明した事実

- **`sct !== undefined && sc === undefined`(cards cursor だけ不在)は到達不能**: cards cursor が無いのは fresh / purge 後の mirror だけで、その時は card_tags cursor も無く分岐ごと skip される。spec §2.1 の bind 数受容は想定より安全だった(whole-branch reviewer の指摘)。
- **I-3 の「同一 `withTenantTx` 内」は eslint が構造的に強制していた**: `eslint.config.mjs` の Block B-getdb が `app/**` からの `getDb` import を禁じるため、route から届く `TenantDb` は `tx` だけ。test pin より強い。
- **`vi.clearAllMocks()` は implementation を消さない**(呼出履歴のみ)。`vitest.config.ts` も `mockReset`/`clearMocks` 未設定のため、describe を跨いで前の `mockResolvedValue` が漏れる。
- **mock factory に export を足すだけでは不足**: 未設定の `vi.fn()` は `undefined` を返し `...byCard` が `TypeError` → route の try/catch が飲んで不透明な 500 になる。自己記述的な error(`No "x" export is defined on the mock`)が**不透明な error に置き換わるだけ**。resolved value の既定まで置いて初めて意味がある。
- **`.superpowers/` の SDD workspace は git-ignored** で、hook / gate の対象外。ledger は `git log` と併せて一次記録になる。

## 5. review の実績

| 対象 | Codex | canonical | 収束 |
|---|---|---|---|
| Task 1 | C0 / I0 / M0 | C0 / **I1** / M3 | fix round 1 で全件 ADDRESSED |
| Task 2 | C0 / I0 / M0 | C0 / **I2** / M6 | fix round 1 で Important 2 + Minor 3 を close、3 件は記録・受容 |
| whole-branch | — | C0 / **I2** / M8 | 1 回の fix wave で Important 2 + Minor 4 を close |

**canonical が拾い、Codex が拾わなかった実質的な指摘(3 件)**:

1. **Task 1**: full-stream pin が「LIMIT / filter が無いこと」を機械化したと主張していたが、seed 2 行が同一 card かつ `created_at ≈ now` のため**行数制限でない filter は素通り**(90 日 window 変異でも 19/19 green)。fixture の `createdAt` を `2020-01-01` に明示して検出力を回復。
2. **Task 2**: **空 authoritative 集合の pin が無かった**。reviewer 自作の 2 変異(`if (byCard.length > 0)` guard / `changed` を `byCard` 由来にする)が **32/32 素通り**。後者は「card の全タグを外した」= 本 fix の主対象シナリオで stale 行が応答に残り、I-1 の Critical 伝播経路が再現する。
3. **whole-branch**: contract test の mock 修正が主張どおり効いていない(上記 §4)+ `card-tags-pull.ts` の module header が**文字どおり偽**になった。後者は fact-finding が「server 側半分の不在を見えなくした artifact」として名指しした当の行で、教訓 `lesson_single_point_claims_decay` が**原因現場で再発**していた。

**Codex は 2 度とも所見ゼロ + 2 文の肯定要約のみ**を返した(canonical が Important を検出した同じ diff で)。本 sprint に関する限り Codex レーンは無シグナル — 欠陥ではなく process 観測として記録する。

## 6. red 検証の記録(gate は 1 つずつ個別変異)

**Task 1**(iso・`delta-isolation.test.ts`)

| 変異 | 結果 |
|---|---|
| `eq(cardTags.userId, userId)` 除去 | 第 1 層 pin のみ fail(asTenant 側は RLS で green = **層の非対称を実証**) |
| `getDeltaRows` に `.limit(1)` | full-stream pin のみ fail |
| backstop の tx を owner DB へ差し替え | backstop のみ fail(policy 無効化なし) |
| `getDeltaRows` に 90 日 window filter | full-stream pin のみ fail(**fixture 修正後に初めて**。修正前は同変異が 19/19 green) |
| `inArray` 除去(reviewer 追加) | asTenant negative pin が fail |

**Task 2**(unit・`app/api/pull`)

| 変異 | 結果 |
|---|---|
| by-card 呼出除去 | 復元 assert が fail(下流 pin も巻き込む) |
| 応答 rows から cursor 再計算 | cursor assert が両 variant で fail |
| pair union へ差し替え | replace 系 assert が fail |
| filter を `if` の外へ hoist | (b)/(b') のみ fail |
| length gate 除去 / `sct` gate 除去 | 各々 (a) / (b)(b') が fail |
| `if (byCard.length > 0)` guard / `changed` を byCard 由来に | いずれも空集合 pin のみ fail |

**訂正(commit `befd671` の記録の方が古い)**: 「pair union 変異は『c1:o_old が残らない』assert *のみ* fail」と書いたが、fix round 1 で空集合 pin が増えた後の実測は **3 failures**(pin ③ の両 variant + 空集合 pin)。red は実走しており記録が stale なだけ。`[reviewed]` 済 commit の履歴書き換えを避け、**本 doc を正**とする。

**pin ① は ③ に論理的に包含される**(`toContain` ⊂ `toEqual`)ため単独では落ちない。spec §4-1 の意図記録として残す — 「双方向の分離が実証された」という主張はしない。

## 7. stg smoke(**push 後・OT 指示で実施** — 本節が rollout の正記録)

判定は件数でなく **`(card_id, option_id)` の集合一致**(spec §4-8 / §5)。

1. cursor 削除 → reload(full pull)→ reload(delta pull)で、境界 card ごとの pair 集合が stg DB の SQL readback と一致
2. card 1 枚復習 → pull 後も当該 card の pair 集合が server と一致
3. **②と同じ card** で事前集合 `S` を保存 → 未割当タグ `x` を add → server(SQL readback)と IDB の双方で `S ∪ {x}` → `x` を remove → 双方で `S` に復帰
4. 実測記録: `cards.length` / **変更 card への projection 行数**(by-card 由来の行数)/ card_tags 総行数 / 応答 byte / latency
5. 証拠: Network reqid + IDB readback + stg DB SQL readback

**smoke 実施者が知っておくべき 2 点(whole-branch reviewer の指摘・重要)**

- **手順 1 は差分試験ではない**。cursor を消した直後の pull は *full* pull で、I-4(b) により新分岐を skip する(= IDB は既に正しい)。続く delta pull が fix を実際に踏むのは、**cards に載った card が `created_at < since_card_tags` のタグを 1 つ以上持つ**場合だけ。Fault-A の境界集合がたまたま空なら、**手順 1 は未修正コードでも同じく PASS する**。
  → **fix の証拠は手順 2 に乗っている**。加えて delta 応答を開いて「返った `card_tags` に `created_at < since_card_tags` の行が 1 つ以上ある」= by-card が実際に寄与したことを確認する。手順 4 の projection 行数は**非ゼロであること + cursor との比較**まで報告して初めてこの役を果たす。
- **楽観的タグ編集と outbox flush の間に pull が挟まった時の挙動が変わった**。修正前はその pull が当該 card の local タグを*空にしていた*が、修正後は server 集合に復元する。手順 3 の `remove x` → `S` 確認で、flush 前に pull が着地すると IDB は `S ∪ {x}` を示し **FAIL に見える**。**手順 3 は flush 完了を確認してから IDB を読む**こと。regression ではなく収束が改善した結果だが、中間観測の意味が変わる。

---

## 7a. stg smoke 実施結果(2026-08-17・**総合 PASS**)

- 環境: `https://stg.recallmint.nekotest.net` / Playwright MCP / user A = `66fb6d00-526f-4264-9691-e2e036c656f7`
- **deploy 対象 = `04a20ee`**(origin/develop)。**注記: 最終 commit `3b7632d` は smoke 実施時点で未 push**。差分は comment/docs のみで非コメント行の差分ゼロ(機械確認済)= 挙動同一のため、本 smoke は `3b7632d` に対しても有効。
- **deploy SHA の直接照合は不能**(repo が `VERCEL_GIT_COMMIT_SHA` をどこにも露出していないため。既知の制約)。代わりに**機能面で新コードの稼働を実証**した(下記 §7a-0)。

### 7a-0. deploy 反映の機能的実証(SHA 照合の代替)

初回 delta 応答(reqid `hnd1::hnd1::8dmbx-1787010524295-823d6adb661d`):

| 指標 | 実測 | 旧コードなら |
|---|---|---|
| `cards.length` | 5 | 5(同じ) |
| `card_tags.length` | 30 | 10 |
| **変更 card への projection 行数** | **20** | 0 |
| **`created_at < since_card_tags` の行数** | **20** | **0** |
| `cursors.card_tags` | `2026-08-15T00:00:01.169Z`(= 送った cursor と同値・**逆行なし**) | 同左 |

`since_card_tags` = `2026-08-15T00:00:01.169Z` に対し、応答に `2026-08-14T23:49:43.358Z` 等の**より古い行が 20 件**含まれる = **by-card read が実際に寄与している**直接証拠。旧コードではこの数は原理的に 0。加えて、応答に古い行が混ざっているのに **cursor は増分由来のまま前進も後退もしていない** = I-2 が本番で成立。

### 7a-1. 手順 1(cursor 削除 → full pull → delta pull)= **PASS**

**本データでは手順 1 も差分試験として機能した**(§7 の注意は「境界集合が空なら差分にならない」であり、実測の境界集合は非空 = 5 card / 20 タグ・全て増分に載らない)。

| 段階 | IDB `card_tags` | 境界 5 card の pair 数 |
|---|---|---|
| 初期 | 6612 | 20 |
| cursor 削除 → reload(**full pull**) | 6612 | — |
| reload(**delta pull**・reqid の since 6 本を確認) | **6612** | **20** |

**旧挙動は 6612 → 6592(−20)**。DB SQL readback との `(card_id, option_id)` 集合比較 = **完全一致(`diff` 差分ゼロ・20/20)**。

### 7a-2. 手順 2(復習 → delta pull)= **PASS**(fix の主証拠)

スマート復習で 5 枚回答 → threshold flush(pending 5 件)→ server 反映を確認。

- 復習された 5 card の `updated_at` = `2026-08-17 23:53:33.527992+00`(同一 tx ゆえ同値)
- **5 card のタグ計 28 件が全て `card_tags` cursor より古い** = 旧バグの発火条件を完全に満たす
- delta pull 後の IDB: **28/28 保持**(per-card: 5 / 6 / 6 / 7 / 4 — DB と一致)、総数 **6612 不変**
- DB SQL readback との集合比較 = **完全一致(`diff` 差分ゼロ・28/28)**

旧コードなら、この 5 card のタグ 28 件は local から全消しされ 0 件に戻らなかった。

### 7a-3. 手順 3(server 非破壊・`S → S∪{x} → S`)= **PASS**

対象 = **手順 2 で復習した同じ card** `0127c978-1045-4214-b6ac-19b9b74b4983`(exam `c676e09d…` / タイトル `PERF-SEED カード 0070`)。`S` = 7 件。`x` = 分野「化学」(`9ec801af…`・未割当・multi カテゴリ)。UI(テーブルビューのタグバッジ → popover)から実操作。

| 段階 | outbox | server 集合 | IDB 集合 | user 総数 |
|---|---|---|---|---|
| 事前 | — | 7(S) | 7 | 6612 |
| add x(**flush 完了を待って読取**) | `update_field` `synced` / `value_len=8` | **8 = S∪{x}** | 8 | **6613** |
| remove x(同上) | `update_field` `synced` / `value_len=7` | **7 = S** | 7 | **6612** |

server / IDB とも `diff` 差分ゼロで一致。**意図した差分以外の server 行削除はゼロ**(総数が 6612 → 6613 → 6612 と対称に戻る)= Critical 伝播経路が閉じていることの実地確認。

`§7` の注意どおり、各段階で **outbox の `pending`/`syncing` が消えるまで待ってから** IDB / server を読んだ。

### 7a-4. 実測記録(rollout 判断の入力)

手順 3 完了後の delta 応答(reqid `hnd1::hnd1::z7mfk-1787011057381-751fc3ff0c29`):

| 指標 | 実測 |
|---|---|
| `cards.length` | 5 |
| `card_tags.length` | 38 |
| **変更 card への projection 行数** | **28**(非ゼロ) |
| `created_at < since_card_tags` の行数 | 21 |
| 応答 byte | 15,541 |
| latency | 196 ms(初回計測は 263 ms) |

規模感: 変更 card 5 件 / by-card 28 行で応答 15 KB・200 ms 前後。**full pull(6612 行)より 2 桁小さい**ため、spec §5 の量的互換の主張は実測でも成立。

### 7a-5. smoke で新たに判明した事実

**タグ操作は whole-set replace ゆえ、その card の全 card_tags 行を再 INSERT する** — `handleTagOptionIds` は DELETE→INSERT なので、`x` を remove した後の 7 行は `created_at` が**全て操作時刻(`2026-08-17 23:56:59.307565+00`)に更新**される。帰結:

- タグ操作した card の全タグは、その直後の増分 stream に**必ず載る**(= by-card の寄与なしでも復元される)
- ゆえに **`card_tags` cursor はタグ操作のたびに前進する**(実測: `2026-08-15T00:00:01.169Z` → `2026-08-17T23:56:59.307Z`)
- 逆に言えば、**by-card read が本質的に効くのは「タグを触っていないが `updated_at` が動いた card」**(= 復習・本文編集・card 移動)。手順 2 がまさにその形で、fix の主証拠がそこに乗る理由を裏付ける

### 7a-6. smoke で生じた副作用(記録)

- A の 5 card を実際に復習した(`reps` 0→1・`due` 前進)。テストアカウントの学習状態であり実害なし
- A の cursor を検証のため一度削除 → full pull 1 回(cursor は再生成済)
- 対象 card `0127c978…` の card_tags 7 行は `created_at` が smoke 実施時刻に更新された(whole-set replace の仕様どおり・集合は不変)
- 前回 hygiene smoke 由来の合成 fixture(`answer_events` の `failed` 1 行 / `entity_mutations` の `syncing`・`failed` 3 行)は**不可侵集合ゆえ残置**。今回の flush 判定では pending に数えられず無害だった

### 7a-7. 総合判定

**PASS**(手順 1 / 2 / 3 の全項目 + 実測記録)。spec §7-4「stg smoke PASS」を充足。**本節が rollout の正記録**。

残る rollout gate = spec §7-5(prod 未リリースの OT 確認)。

---

## 8. 受容・記録のみ(修正しない)

- `route.test.ts` の `toHaveBeenCalledWith(..., ['c1','c2'])` は配列 order を契約化するが、`getCardsDelta` が mock された literal 配列を返すため決定的で flake しえない。spec §4-2(c) 由来。
- module `beforeEach` の `mockResolvedValue([])` 既定は「`[]` が正当な production 値」ゆえ将来の設定漏れを黙らせうるが、代替(未設定)は `TypeError` → 不透明な 500 で**より悪い**。whole-branch reviewer も「これが正しい選択」と判定。
- `const db = dbc` の no-op alias は `pull-delta.ts:41` に倣ったもの(既存パターン踏襲)。
- `inArray` の bind 数上限は spec §2.1 の台帳どおり受容(test で exercise しない)。

## 9. client header の偽記述 — **解消済み**(OT 裁定)

`lib/sync/pull.ts:31-35` の「(3) で card_tags **増分** の bulkPut で新集合を upsert する」は I-1 導入後は偽だった(応答の当該 card 分は増分でなく全集合)。CC は凍結 spec の I-5「client コードは一切変更しない」に抵触すると判断して保留したが、**OT 裁定: コメント訂正は I-5 に非抵触**(I-5 が禁じるのは client の挙動変更であり、真でなくなった記述の訂正はこれに当たらない)。

→ 本 sprint 内で修正済(comment-only)。(3) が正しい理由が server 契約 I-1 にあること、契約が無かった間に恒久欠落が起きていたことを header に明記し、fact-finding へのポインタを置いた。Task 3 で `pull.test.ts` 側に入れた契約記述と対になる。

## 10. follow-up(claude.ai todo へ・全文は checkpoint 報告に記載)

1. **whole-set replace op の差分 op 化**(fact-finding §3.5 / spec §6-①)— local mirror 欠落が server 実削除へ増幅される構造の封じ込め。**prod 未リリースが確認できない場合は prod blocker に昇格**(spec §7-5)。
2. **境界 card の楽観編集巻き戻し race**(fact-finding §6-1 / spec §6-②)— whole-branch reviewer の判定では本 fix で挙動は改善(修正前は pull が local タグを空にしていた)。
3. **tx timestamp 由来の取りこぼし hazard + µs 切り捨て**(fact-finding §6-2 / spec §6-③・案④ 含む)。
4. **`check-review.sh` は `Stop` にのみ登録され `SubagentStop` では発火しない** — subagent が打つ tagless な feat/fix commit を hook が止められない(本 sprint で実地確認)。CLAUDE.md「重要 Fix の裏取り」と tag が 2 状態を区別できない件と併せて整合化。
5. **`docs/architecture.md` に I-1 の不変条件行が無い** — CLAUDE.md は設計不変条件の恒久置き場を architecture.md と定めている。1 行追加の要否。

(旧項目 6「`lib/sync/pull.ts` の偽コメント」は OT 裁定により本 sprint で解消 — §9。follow-up は 5 件。)
