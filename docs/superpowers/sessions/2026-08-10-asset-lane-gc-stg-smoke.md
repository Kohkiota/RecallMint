# asset レーン整合 sprint — stg smoke 実施記録(2026-08-10)

- 実装記録 = `docs/superpowers/sessions/2026-08-10-asset-lane-gc.md` / spec = `docs/superpowers/specs/2026-08-10-asset-lane-gc-design.md`
- 実施 = CC(node fetch + app role SQL + R2 read-only listing)。stg = `stg.recallmint.nekotest.net`
- 結果: **全項目 PASS**

## 0. 前提確認

- **migration 照合**: repo の migration SQL = 34 file / `_journal.json` entry = 34 / 末尾 `0033_asset_gc_user_ids`。OT 確認の `__drizzle_migrations` 34 本と**一致**。`app_list_asset_gc_user_ids` 存在・`prosecdef=true` は OT が SQL Editor で確認済
- **push 状態**: `develop` は `origin/develop` と同一(未 push commit なし)
- **新コードの配備確認**: `?lane=nonexistent_lane` → **400 `invalid_lane`**。`lane` param は本 sprint で追加したものなので、旧コードなら無視されて 200 になる。旧コードに対する smoke でないことの確認

## 1. 事前 listing(read-only)

| user | R2 object | assets 行 | status | zero-ref | refs |
|---|---|---|---|---|---|
| `85541b25…4dae3`(**対象**) | 234 | 234 | 全 `ready` | **202** | **32** |
| `b775b3f1…6cddf` | 6 | 6 | 全 `deleting` | 6 | 0 |
| `2ac594a5…bb54c26` | 2 | 2 | 全 `deleting` | 2 | 0 |
| 合計 | **242** | | | | |

**事前 gate(smoke4 手順書 §8)= `referenced > 0` を満たす**: 対象 user に守るべき生存画像が 32 件ある。これが 0 だと「誤収しない」の証明が vacuous になる。

他 2 user の `deleting` 計 8 件は scope 外 — **これらが不変であることが `user=` scope の検証**になる。

## 2. `asset_gc` lane(`?lane=asset_gc&graceDays=0&user=85541b25…`)

`status=200 / elapsed=1,772ms`

```json
{"lane":"asset_gc","usersListed":1,"usersProcessed":1,"usersSkipped":0,
 "scanned":234,"referenced":32,"marked":202,"cleared":0,"promoted":202,
 "r2DeleteOk":20,"r2Delete404":0,"r2DeleteFailed":0,
 "rowDeleteOk":20,"rowDeleteFailed":0,"deletedLaneProcessed":0,
 "selfHealed":0,"unknownStatus":0,"phase":null,"recordErrors":0,
 "graceDaysOverride":0,"userScope":"85541b25-51e9-44a3-8952-e383f98d4ae3"}
```

- `scanned` / `referenced` が事前計測と完全一致
- **`marked: 202` = zero-ref 件数と一致・`cleared: 0`** → 参照が残る 32 件は mark されていない(**refs↔GC 整合の実機確認**)
- `promoted: 202` → **collect は 20 で止まった** = `COLLECT_LIMIT_PER_USER` の bound が本番経路で効いている
- 失敗系すべて 0 / `phase: null`(打ち切りなし)
- **override の実効値が summary に載る**(`graceDaysOverride` / `userScope`)

### 事後照合

| 指標 | PRE → POST | summary との一致 |
|---|---|---|
| R2 総数 | 242 → **222**(−20) | `r2DeleteOk: 20` |
| 対象 user の R2 | 234 → **214**(−20) | 同上 |
| 対象 user の assets 行 | 234 → **214**(−20) | `rowDeleteOk: 20` |
| **参照あり 32 件** | `ready` / zeroRef=0 / **marked=0** | **完全に不変** |
| 残 `deleting` | 182(= 202 − 20)全件 marked | — |
| 他 2 user | 6 / 2 とも**不変** | `user=` scope |

R2 214 / DB 214 で一致。**消えたのは zero-ref 由来の 20 件のみ。**

## 3. `asset_orphan_scan` lane(`?lane=asset_orphan_scan`)

`status=200 / elapsed=605ms`

```json
{"lane":"asset_orphan_scan","listed":222,"candidates":7,"rowSkipped":7,
 "rowless":0,"deleted":0,"failed":0,"skippedLiveUsers":0,
 "patternMismatch":0,"truncated":false,"phase":null,"recordErrors":0}
```

- `listed: 222` が R2 実数と一致
- **`candidates: 7` → `rowSkipped: 7` → `rowless: 0` / `deleted: 0`**

**この smoke が空振りでないことの根拠**: `candidates` が 0 でなく **7**。age(7 日)+ key 規約の gate は実際に 7 件を選定しており、**削除を止めたのは行不在確認**である。`candidates: 0` なら「何も選ばれなかったから消えなかった」だけで、行不在確認が効いた証明にならない(事前 gate `referenced > 0` と同型の vacuous 問題)。

事後 listing は §2 の POST と**完全に同一** = orphan scan は何も変更していない。

## 4. mark 初回規模の実測(spec §7 の見積の裏取り)

`unreferenced_at` 全件 NULL の状態からの初回 run で、**mark 202 + promote 202 + collect 20 が 1,772ms**。`asset_gc` の枠は 120s(runner の per-lane 固定絶対 deadline)なので**大幅に余裕**があり、spec §7 の「予算内・平滑化不要」は実測で裏付けられた。

**注意(見積の限界)**: 今回計測したのは mark/promote の bulk UPDATE と collect 20 件。collect は `COLLECT_LIMIT_PER_USER` で 20 に bound されるため、**件数が増えても 1 run の collect コストは増えない**。増えるのは mark/promote の bulk UPDATE の行数だけで、これは単文 UPDATE。

## 5. auth 系

- **誤 Bearer → 401**(`Bearer wrong-secret`)
- **production 限定 param が stg では通る**: `graceDays=0` / `user=` がともに受理され、実効値が summary に反映(§2)
- **未知 lane 名 → 400 `invalid_lane`**(§0)

## 6. 副作用(記録)

対象 user に **`deleting` 182 件**が残った(zero-ref なので状態としては正しい)。日次 cron が 20/run で回収するため、**stg のこの test データは ~10 日かけて drain する**。意図した挙動であり異常ではない。

## 7. OT 照会(CC は権限で読めない)

`integration_failures` は app role が SELECT 不可(実測: `ERROR: permission denied for table integration_failures`)。**期待 = 0 行**(本 smoke で失敗系 counter はすべて 0・`recordErrors` も 0 のため、記帳が発生する経路を通っていない)。

```sql
SELECT id, key, service, operation, workflow, failure_code, user_id, created_at, context
FROM integration_failures
WHERE workflow IN ('asset_gc', 'asset_orphan_scan')
ORDER BY created_at DESC
LIMIT 50;
```

## 8. 判定

| 判定基準 | 結果 |
|---|---|
| 消えるべきもの(zero-ref + grace 経過)だけが消える | **PASS**(20 件すべて zero-ref 由来) |
| 参照ありは不変 | **PASS**(32 件が `ready` / marked=0 のまま) |
| summary の readback が実体と一致 | **PASS**(R2 −20 / 行 −20 が counter と一致) |
| 想定外の削除が無い | **PASS**(他 2 user 不変・orphan scan は 0 件) |
| 三重条件 + 行不在確認が効く | **PASS**(candidates 7 → rowSkipped 7 で停止) |
