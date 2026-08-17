# card_tags delta 完全性(authoritative replace)実装記録 — 2026-08-17

- **spec**: `docs/superpowers/specs/2026-08-17-card-tags-delta-completeness-design.md`(r3 凍結 + 同日 erratum)
- **plan**: `docs/superpowers/plans/2026-08-17-card-tags-delta-completeness.md`
- **fact-finding(正)**: `docs/superpowers/sessions/2026-08-17-card-tags-delta-loss-factfinding.md`
- **状態**: **Task 1〜4 完了・未 push**。Task 5(deploy 確認 + stg smoke + rollout gate)は OT push 後。
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

## 8. 受容・記録のみ(修正しない)

- `route.test.ts` の `toHaveBeenCalledWith(..., ['c1','c2'])` は配列 order を契約化するが、`getCardsDelta` が mock された literal 配列を返すため決定的で flake しえない。spec §4-2(c) 由来。
- module `beforeEach` の `mockResolvedValue([])` 既定は「`[]` が正当な production 値」ゆえ将来の設定漏れを黙らせうるが、代替(未設定)は `TypeError` → 不透明な 500 で**より悪い**。whole-branch reviewer も「これが正しい選択」と判定。
- `const db = dbc` の no-op alias は `pull-delta.ts:41` に倣ったもの(既存パターン踏襲)。
- `inArray` の bind 数上限は spec §2.1 の台帳どおり受容(test で exercise しない)。

## 9. 本 sprint で修正しなかった既知の偽記述(**OT 判断待ち**)

- **`lib/sync/pull.ts:31-35`**: 「(3) で card_tags **増分** の bulkPut で新集合を upsert する」— I-1 導入後は偽(payload の当該 card 分は増分でなく全集合)。**凍結 spec の I-5「client コードは一切変更しない」に抵触するため触っていない**。comment-only の修正だが spec の文言に反するため OT 承認が要る。Task 3 で `pull.test.ts` 側には契約を明記済なので、production comment だけが取り残されている状態。

## 10. follow-up(claude.ai todo へ・全文は checkpoint 報告に記載)

1. **whole-set replace op の差分 op 化**(fact-finding §3.5 / spec §6-①)— local mirror 欠落が server 実削除へ増幅される構造の封じ込め。**prod 未リリースが確認できない場合は prod blocker に昇格**(spec §7-5)。
2. **境界 card の楽観編集巻き戻し race**(fact-finding §6-1 / spec §6-②)— whole-branch reviewer の判定では本 fix で挙動は改善(修正前は pull が local タグを空にしていた)。
3. **tx timestamp 由来の取りこぼし hazard + µs 切り捨て**(fact-finding §6-2 / spec §6-③・案④ 含む)。
4. **`check-review.sh` は `Stop` にのみ登録され `SubagentStop` では発火しない** — subagent が打つ tagless な feat/fix commit を hook が止められない(本 sprint で実地確認)。CLAUDE.md「重要 Fix の裏取り」と tag が 2 状態を区別できない件と併せて整合化。
5. **`docs/architecture.md` に I-1 の不変条件行が無い** — CLAUDE.md は設計不変条件の恒久置き場を architecture.md と定めている。1 行追加の要否。
6. **`lib/sync/pull.ts` の偽コメント**(§9)— I-5 の凍結解除 or 次 sprint での修正。
