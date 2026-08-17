# card_tags delta 完全性設計(変更 card 分の全集合同梱)— 2026-08-17

- **状態**: **r3 凍結**(2026-08-17)。r2 への Codex spec review の凍結 blocker「READ COMMITTED 下で単純 union は I-1 を満たさない」を反映 = union → **authoritative replace** + OT 裁定 5 件全採用 → Codex 差分再確認 **GO**(`docs/codex/2026-08-17-plan-card-tags-delta-completeness-r3.md`・凍結を妨げる抜けなし・残余指摘 1 は writer 全数確認で閉鎖)
- **入力(正)**: `docs/superpowers/sessions/2026-08-17-card-tags-delta-loss-factfinding.md`(`94084eb`)
- **OT 裁定済(2026-08-17)**: 案② 採用 / **hotfix 級**(Dash-0 より優先・品質 gate は通常どおり)/ 案① 不採用(実測反証済)/ 案④ 非スコープ(**不採用ではない** — §6-③ へ)/ fact-finding §3.5・§6-1 は follow-up 起票のみ
- 凍結後は実装フェーズで書き換えない(既存規律)
- **改訂履歴**: 2026-08-17 **erratum**(OT 承認・狭い docs-only の凍結例外)— §1 I-1 の「時点の限定」で `updated_at` 前進を「次回 delta での再送・再構築を**保証する**」と書いていたのを「通常は候補になる / §6-③ hazard により絶対保証はしない」に訂正。経緯 = **plan 段階 cross-check の正確性指摘**(`docs/codex/2026-08-17-plan-card-tags-delta-completeness-plan.md` 独立論点 1)。設計・実装・テストへの影響なし(保証の記述精度のみ)。

## 0. 問題(要約のみ・詳細は fact-finding)

client の pull apply(Tag-2b 案 a)は「cards delta に載った card の card_tags を**全削除** → delta の card_tags で再構築」するが、server の card_tags delta は `created_at >= since` の単純増分のみで、**変更 card の古いタグを含まない**。削除集合(cards cursor 支配)と復元集合(card_tags cursor 支配)が別 cursor に支配されているため、変更 card の古いタグが local から恒久欠落する。FSRS 復習 flush も `cards.updated_at` を bump するため復習のたびに発火し、欠落した local 集合からの whole-set replace op で **server 行の実削除に伝播**する(データ保全の Critical)。

## 1. 不変条件(凍結)

- **I-1(完全性 = 一致・r3 で強化)**: pull 応答の cards に載った当該 user 所有の各 card について、**応答 card_tags の当該 card への projection が、by-card SELECT 実行時点のその card の authoritative 集合と一致する**(「含む」ではなく「一致」— 含む、では stale 行の混入を許す)。タグ 0 件は空集合として成立し、同一 `(card_id, option_id)` は応答内で高々 1 行。= 「client が削除の根拠にする payload と、復元の材料にする payload は同一応答で完結する」(fact-finding §2.1 の判定基準の回復)。
  - **union では I-1 を満たせない(r3 凍結 blocker)**: READ COMMITTED では ① 増分 SELECT が `c1:o_old` を取得 → ② 別 tx が `c1:o_old` を削除し commit → ③ by-card SELECT は `o_old` を含まない最新集合、という競合列がありえる。pair 単位の union は ④ 古い増分行 `o_old` を応答に残し ⑤ client が削除後に再投入する。次回 pull 前にタグ操作が起きると **stale 行が whole-set replace op で server に再追加されうる**。ゆえに合成は union でなく **authoritative replace**(§2.2)でなければならない。
  - **時点の限定(Codex 論点 3)**: 同一 `withTenantTx` は接続と RLS 文脈の共有であって、**応答全 stream の snapshot 一致の主張ではない**(READ COMMITTED では SELECT ごとに snapshot が進みうる)。by-card SELECT が cards SELECT より新しい状態を見ても損失にならない: 新しい集合はより新しい server 真値であり、当該 card の `updated_at` 前進により**通常は次回 delta の候補になる。ただし §6-③ の hazard(`now()` = tx 開始時刻ゆえ commit 順 ≠ timestamp 順)により delivery / 収束を絶対保証しない**〔erratum・下記改訂履歴参照〕。tx 内配置を snapshot consistency の根拠に転用しない。
  - 「次回収束」が依存する bump 契約は writer 全数で確認済(r3 Codex 残余指摘 1 の閉鎖): server 側 card_tags writer は ① `handleTagOptionIds`(同一 tx で bump — `card-field-handlers.ts:304-307`)② `apply-ocr-tags.ts:321`(OCR **新規作成 card** への INSERT のみ・既存 card 不可触 = 新規 card は cards delta に必ず載る)の 2 経路のみ。
- **I-2(cursor 非影響)**: `cursors.card_tags` は**増分 query の rows のみ**から算出する。by-card rows はもちろん、**replace 後の応答 rows からも算出しない**(古い `created_at` の混入で cursor が逆行し delta が肥大・振動するため。増分側の変更 card 行が replace で応答から落ちても、cursor 算出の入力は増分 rows 全体のまま)。
  - 単調性の残り半分は既存 client 契約が担う(Codex 論点 2 への応答): 増分空 → `maxCreatedAt = null` → client は cursor 据え置き(`pull.ts:384` の `if (cursors.card_tags)`・既存 pin `pull.test.ts:514`)。null での上書き退行は既に構造とテストで塞がっている。
- **I-3(owner-scope 第 1 層)**: by-card query は `eq(cardTags.userId, userId)` の**明示 predicate 必須**。RLS(RLS-P2)は第 2 層であり、第 1 層の省略を正当化しない。query は既存 6 stream と同一の `withTenantTx` 内で発行する。
- **I-4(発行条件)**: by-card SELECT を発行しない条件は次の 2 つのみ、いずれも陽形で判定する:
  - (a) 変更 card id が 0 件(OT 指定 ④)
  - (b) `since_card_tags` 欠落 = card_tags stream が全件 fallback(**OT 条件付き承認済**)。根拠(r3 で厳密化): 全件 SELECT は**単一 statement snapshot で owner の card_tags 全体を返す = それ自体が authoritative snapshot**であり、任意の card への projection がその時点の authoritative 集合になる(I-1 を単独で満たす)。r2 の「超集合ゆえ union 恒等」は READ COMMITTED 下で不正確だったため撤回 — 2 つの時点の集合の包含関係でなく、**単一 source であること**が根拠。skip 時は応答 = 増分 rows そのまま(replace の filter も適用しない — §2.2)。
  - (b) の前提(全件 SELECT に LIMIT / pagination / owner 以外の filter が無い — `pull-delta.ts:42-46` 現物)は**機械化する**: §4-5 の full-stream contract pin。skip 分岐へのコメント明記も維持(Codex 論点 6)。
- **I-5(client 無変更)**: 本 fix で `lib/sync/pull.ts` ほか client コードは一切変更しない。correctness / hygiene の凍結 pin(capture 原則 / owner echo 4 pin / validate-before-tx / cursor CAS / hygiene §9 全 pin)は全 green を維持(退行 = Critical)。

## 2. 設計: server 変更(2 file のみ)

### 2.1 `lib/db/card-tags-pull.ts` — by-card-ids 取得の追加

既存 `getCardTagsDelta` は**無変更で温存**(署名・return key・`getDeltaRows` 経由の増分、全て現行どおり)。追加:

```
export async function getCardTagsByCardIds(
  userId: string,
  dbc: TenantDb,
  cardIds: string[],
): Promise<ClientCardTag[]>
```

- WHERE = `and(eq(cardTags.userId, userId), inArray(cardTags.cardId, cardIds))`。cursor 条件なし。
- mapper は既存 `toClientCardTag` を再利用。
- **max を返さない**(return 型に cursor 材料を持たせない = I-2 の構造的表現)。
- `getDeltaRows` factory は使わない(cursor 列を持たない別形の query であり、factory を optional 化する改造は YAGNI)。
- **bind 数の扱い(受容リスクとして記録 — Codex 論点 5)**: bind 数 = 変更 card 数 ≤ user の card 総数。card 数に schema 上の上限はなく、実測 1209 は保証ではない。postgres.js の bind 上限 65534 に達するには単一 user が 6.5 万 card を持つ必要があり、現実的規模(プラン制限運用・実測水準)から**乖離が 50 倍超あるため chunking は作らず受容**する(YAGNI)。この受容は本 spec を台帳とする。なお `changedCardIds` は cards の PK 由来で重複しえない(dedupe 不要)。

### 2.2 `app/api/pull/route.ts` — authoritative replace(r3・union 廃止)

`withTenantTx` 内、6 delta の後に 7 本目として追加(単一接続ゆえ直列 await、既存コメントの根拠と同じ)。合成は **replace**: 変更 card の行は by-card 結果**のみ**を採用し、増分側の当該 card 行は捨てる。変更 card 以外の増分行はそのまま残す:

```
const changedCardIds = c.rows.map((r) => r.id)
let cardTagRows = ct.rows
if (sct !== undefined && changedCardIds.length > 0) {
  const byCard = await getCardTagsByCardIds(user.id, tx, changedCardIds)
  const changed = new Set(changedCardIds)
  // authoritative replace: 変更 card は by-card SELECT 時点の集合が正。
  // 増分側の変更 card 行(stale の可能性)は採用しない(spec I-1)。
  cardTagRows = [...ct.rows.filter((r) => !changed.has(r.card_id)), ...byCard]
}
```

- route 内 inline・helper 化しない(rule of three 不成立)。pair 単位の Map merge(r2 案)は**廃止**(I-1 の blocker)。
- skip 時(I-4 (a)/(b))は `cardTagRows = ct.rows` のまま — **filter も適用しない**((b) は全件 stream 自体が authoritative、(a) は置換対象なし)。
- 応答内の pair 一意性は構造で成立: 残す増分行(非変更 card)と by-card 行(変更 card)は card_id で互いに素、各 source 内は PK unique。
- response `card_tags` = `cardTagRows`。**`cursors.card_tags` = `ct.maxCreatedAt` のまま**(I-2 — replace の影響を受けない)。
- wire の key 追加なし(既存 `card_tags` 配列の中身が変わるだけ)。`emptyBody` 無変更。

### 2.3 帰結(設計の含意・実装対象ではない)

- client の (2) 全削除 → (3) bulkPut がそのまま正しくなる(削除した card のタグは by-card 時点の authoritative 集合で必ず再構築される)。変更 card のタグが 0 件なら by-card に行が無く、増分側の stale 行も replace で落ちるため空集合化が成立 = 案 a の元々の狙いが初めて実際に成立。
- by-card 行も client の owner 行検証(pull.ts §3a-(b))の対象に自動で入る(保証はむしろ強化)。
- Fault A(µs 切り捨てで境界 card が毎回返る)は残るが、本 fix 後は「同じ card が毎回正しく再構築される」だけの帯域コストに無害化する(§6-③ で扱う)。

## 3. 変えないもの(明示)

| 対象 | 理由 |
|---|---|
| `getCardTagsDelta` / `getDeltaRows` / `gte` | 案① 不採用(実測反証済・fact-finding §1.2/§3.1) |
| client `lib/sync/pull.ts` 全体 | I-5。削除+再構築の構造は server 側の契約充足で正しくなる |
| wire 形状(key 構成 / `emptyBody`) | additive のみ。案③ 不採用 |
| schema / migration | 変更なし |
| timestamp 精度・cursor 形式 | §6-③ の scope |

## 4. テスト戦略(凍結 pin の柱・red は gate 1 つずつ個別変異)

1. **regression pin(`app/api/pull/route.test.ts`・バグの直接証明 + replace 意味論)**: `getCardsDelta` → c1 あり / `getCardTagsDelta` → `c1:o_old`(stale 想定)+ 別 card `c2:o_x`(`since_card_tags` 指定)/ `getCardTagsByCardIds` → `c1:o_new`(`created_at < since_card_tags` の旧タグを含む)。assert: ① by-card 由来の旧タグが応答に載る(復元)② `cursors.card_tags` は増分由来のまま(null variant と maxCreatedAt='X' variant の両方 — replace 後の応答 rows に非影響)③ **replace**: 応答 = `{c1:o_new, c2:o_x}` で **`c1:o_old` を含まない**(変更 card は by-card が authoritative・増分側の当該 card 行は捨てる・非変更 card の増分行は残る)。**red**: by-card 取得を外す変異で ① fail / cursor 算出を応答 rows から再計算する変異で ② fail / **replace を pair union に戻す変異で ③ fail**。
2. **発行条件 pin(同 route.test)**: (a) cards delta 0 件 → `getCardTagsByCardIds` 不呼出 (b) `since_card_tags` 欠落 → 不呼出**かつ応答 = 増分 rows そのまま(filter 不適用)** (c) 両条件成立 → `(user.id, tx, changedCardIds)` で 1 回呼出。
3. **owner-scope 第 1 層 pin(iso・owner 接続 = RLS bypass)**: `getFixtureOwnerDb()`(RLS を bypass する fixture owner 接続・既存基盤)を dbc に渡し、**cardIds に B の card id を混ぜて** `getCardTagsByCardIds(A, ownerDb, [aCardId, bCardId])` を呼ぶ → B 行が返らないことを pin。RLS が効かない接続なので、**明示 `eq(cardTags.userId, userId)` predicate 単独**が隔離を成立させていることの behavioral 証明になる(`rls-single-defense.test.ts` の対称形 = 「RLS 単独」に対する「predicate 単独」)。**red**: userId predicate を外す変異で fail(RLS が覆い隠せない)。
   - r1 の drizzle spy 案(`pull-delta.test.ts:30-54` 形)は**採らない**: spy は predicate の生成しか証明せず、最終 WHERE への結合を証明しない(Codex 指摘 3 を現物と突き合わせて採用)。
4. **owner-scope 第 2 層 pin(`tests/integration/pg/delta-isolation.test.ts`)**: `asTenant`(app role + RLS + GUC)経由で `getCardTagsByCardIds` の positive(A 自行が返る)/ negative(B 行が A の結果に混入しない)— 既存 6 delta と同形の 2 本。通常経路(predicate + RLS の重畳)の実挙動を固定する。
5. **full-stream contract pin(iso・I-4(b) の前提の機械化・OT 裁定 1)**: 既存 iso harness(`delta-isolation.test.ts` の fixture)内で `getCardTagsDelta(A, tx, undefined)` が A の card_tags **全行**を返すことを、owner 接続の ground-truth read と**集合一致**で pin。skip 分岐の「全件 fallback = authoritative snapshot」前提を機械化する(将来 full query に LIMIT / filter が入れば fail)。**red**: full 経路に行数制限を入れる変異で fail。
6. **client test の改稿(温存・新規 pin と数えない)**: `lib/sync/pull.test.ts:388`(全削除+再構築)と `:417`(空集合化)は削除せず、「server payload の変更 card への projection は当該 card の authoritative 集合と**一致**する(本 spec I-1)」という契約を test 名 / コメントに明記する形に改稿。assert は不変(保証不変)。
7. **凍結 pin 全 green**: correctness(capture / owner echo 4 pin / validate-before-tx / I-1 caller pin)+ hygiene §9 全 pin + cursor CAS。退行 = Critical。
8. **assert の形(全 pin 共通・Codex 論点 11)**: 応答 `card_tags` の配列順序は契約にしない。test は `(card_id, option_id)` の**集合として** assert する(sort してから比較)。件数一致だけの assert は不可(別 card の欠落と重複追加が相殺する偽陰性 — Codex 論点 9)。
9. **採らない test 形(検討済みの記録・OT 裁定 3 で承認)**: ① route を実 PG で通す contract test(Codex 指摘 4)— 新規 harness(auth mock + route 実行 + 実 DB)の追加コストに対し、配線ミスは §4-2(c) の呼出引数 pin + §4-3/4/5 の実 DB pin + §5 smoke(実環境 E2E)の 3 層で覆うため見送り。② server + client を 1 本で通す障害シーケンス test(Codex 論点 10)— 実 PG(node)と fake-indexeddb(client)の cross-runtime harness は存在せず新設は hotfix scope 外。機序の両半分は §4-1(server 契約)と既存 client pin(`pull.test.ts:388` 改稿)が個別に固定し、結合は §5 smoke が実証する。

## 5. 互換性・運用

- **deploy 互換**: server-first の additive 変更。旧 bundle client は増えた rows を冪等 bulkPut するだけで、client コードは変更前後で同一のため**旧 bundle でもバグが直る**。coordinated deploy 不要・旧ブラウザ bundle と共存可能。
- **量的互換(Codex 論点 7 への応答)**: replace 後の card_tags 行数は同 user の **full pull 応答の行数以下**(全件 stream 時は skip = I-4(b)、増分時は「非変更 card の増分行 + 変更 card の全行」で全行数を超えない)。full pull は既に実運用で通る経路(実測 6612 行を client の同一 tx bulkPut が処理済)であり、client の shape 検証は `Array.isArray` のみで件数上限を持たない(`pull.ts:207-218` 現物)。よって本変更は**既存経路が処理できない量を新たに持ち込まない**。
- **既存 local 欠落の回復(全面ではない — Codex 論点 8 で正確化)**: 修正 deploy 後に自然回復するのは (a) 該当 card が再び cards delta に載った時点(復習・編集)(b) full pull 契機(sign-out purge → sign-in / cursor 不在)のいずれかを満たす card **のみ**。以後更新されない card の欠落は full pull 契機まで残り、**回復前にその card でタグ操作をすると server 損失が確定する残余リスクも残る**。強制 backfill 機構は作らない — この省略が妥当なのは prod 未リリースの場合に限るため、**§7 の rollout 前提条件に prod 未リリースの OT 確認を置く**。stg は smoke の full pull で回復を確認する。
- **server 側の既発生実損**(stg A): server 単独では「意図的な解除」と判別不能(fact-finding §5.3)。OT 確認事項として残置。
- **stg smoke(push 後・OT 指示で CC 実走)**: 判定は件数でなく**集合一致**(Codex 論点 9)。
  1. §11.5 の決定論的再現の反転: cursor 削除 → reload(full pull)→ reload(delta pull)で、**境界 card ごとの `(card_id, option_id)` 集合が stg DB の SQL readback(既存の read-only 経路)と一致**すること(旧挙動: 境界 5 card 分 20 行が IDB から欠落)。
  2. FSRS trigger 面: card 1 枚復習 → pull 後も**当該 card の pair 集合が server と一致**。
  3. server 非破壊確認(Codex 論点 10 + OT 裁定 5・**stg データを触る**: A アカウント・1 card 限定で実施を明示): 対象は **② で復習・delta pull した同じ card**。事前の pair 集合を S として保存 → **未割当タグ x** を add → server(SQL readback)と IDB の双方で `S ∪ {x}` を確認 → x を remove → 双方で `S` に復帰を確認(意図外の server 行削除が起きない = Critical 伝播経路の閉鎖を実地で確認)。
  4. 証拠 = Network reqid(delta 応答の card_tags 内訳)+ IDB readback + stg DB SQL readback。
- **[reviewed] の扱い**: データ保全に触れる fix + stg smoke を要するため、既存裁定どおり **session doc を [reviewed] の正記録**とする(push 済 commit の tag は追わない)。

## 6. 非スコープ / follow-up(claude.ai todo へ・いずれも公開前トラックで裁定)

- **① whole-set replace の差分 op 化**(fact-finding §3.5): local mirror 欠落が server 実削除に増幅される構造の封じ込め。本 fix は発生源を断つため必須ではない。
- **② 境界 card の楽観編集巻き戻し race**(fact-finding §6-1): 毎回返る境界 card の `bulkPut` が未 flush 編集を巻き戻す可能性(pre-existing・未検証)。
- **③ tx timestamp 由来の取りこぼし hazard**(fact-finding §6-2・**案④ 含め正面から扱う**): `now()` = tx 開始時刻ゆえ commit 順 ≠ timestamp 順の行を cursor が恒久スキップしうる。「ms 切り捨てが偶然のマージン」は**現状の記述であって安全性の主張ではない**。Fault A の毎回再送(cards 5 件 / card_tags 10 件)の解消もここに含む。

## 7. 完了条件

1. §2 実装 + §4 の pin 全 green(red 実証込み。§4-1〜5 と 7 は凍結条件)。
2. canonical + Codex review 収束(Critical 0 / Important 0)。
3. sprint 完了 gate: whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm test`(unit 全件)/ `pnpm test:iso` / `pnpm run audit` / `pnpm typecheck` 全 exit 0。`pnpm build` はローカル gate に必須化しない(Next 設定 file 非接触・route/lib のみの変更。PR なし運用で CI build は無いが、**push 後の Vercel deploy が build を実行し、その成果物に対する stg smoke が §7-4 の gate になる** — build 破損はここで loud に出る)。
4. stg smoke PASS(§5)→ session doc を [reviewed] 正記録とする。
5. **rollout 前提条件**: prod 未リリース(既存利用者なし)の OT 確認。確認できない場合は §5 の自然回復待ちがデータ保全上不十分になるため、強制 full pull / cursor migration の要否を OT 裁定に上げてから prod 反映する(Codex 論点 8)。
