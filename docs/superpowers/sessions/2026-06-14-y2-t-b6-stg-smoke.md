# Y-2 T-B6 stg smoke (push 後)

- **日付**: 2026-06-14
- **branch / source SHA**: develop = `fab0f46` (origin/develop と同期、 OT push 後)
- **stg deploy**: `dpl_Cp6EqjaHYpr5b1zHKt9adP65H9Gt` (T-B6 chain 反映済)
- **status**: 全 pass、 OT 手動確認待ち (CC 側 smoke 完了)
- **test user**: komail9server+clerk_test (uid `23359047-aab7-4582-a1c0-d5ffd52f5214`)
- **本番 stg DB `recallmint` 無改変** (read-only)、 isolated DB は今回未使用

---

## §1 deploy 同期確認

### chunk-level signature

Source change が deploy 反映されているか script chunk を grep:

| chunk | `[user_id+due]` | `between(...,!0,!0)` (minified `true,true`) | 旧 `where('user_id').equals(...).toArray()` |
|---|---|---|---|
| `0y_4antu0epis.js` | ✓ (v7 store schema literal) | — | — |
| `41dkyt719ujch.js` | ✓ | **✓** | ✓ (= get-dexie-session-cards、 T-B7 未着手で残存、 想定内) |

`41dkyt719ujch.js` の dashboard-actions 経路 (確証 snippet):
```
.useLiveQuery)(async()=>{let t=(n??new Date).toISOString();return(0,i.getClientDb)().cards.where("[user_id+due]").between([e,"0"],[e,t],!0,!0).count()},[e])
```
- `e` = userId
- `t` = nowIso
- `!0, !0` = minified `true, true` (= `includeLower=true, includeUpper=true` 明示)
- 第 4 引数 `includeUpper=true` の反映を確証

### Dexie schema upgrade 確認

```
dbVersion: 70  (= source v7 × 10、 Dexie internal versioning)
cards index names: ['[user_id+due]', '[user_id+exam_id]', 'content_version', 'due', 'exam_id', 'sync_status', 'updated_at', 'user_id']
```

`[user_id+due]` 存在 → v7 migration 反映済 (DB open 時に自動 upgrade、 user 介入なし)。

---

## §2 smoke 1: dueCount 三者一致 (correctness 最重要)

`nowIso = '2026-06-14T02:51:52.454Z'` 時点:

| source | 件数 | 経路 |
|---|---|---|
| **DOM (新 query レンダリング結果)** | **5** | `main` CTA `<a href="/app/study/smart">スマート復習（5件）</a>` |
| **新 path (compound `.count()`)** | **5** | `index('[user_id+due]').count(IDBKeyRange.bound([uid, '0'], [uid, nowIso], false, false))` |
| **旧 path (JS filter)** | **5** | `cards.where('user_id').equals(uid).getAll() → filter(c.due <= nowIso).length` |

**三者一致 ✓**。

### regression 検知

| 過去 bug | 検知 | 結果 |
|---|---|---|
| `'￿'` sentinel → 全 user cards 化 (= 10件) | `domDueCount !== totalCards (10)` ⇒ `5 !== 10 = true` | ✓ 再発なし |
| `includeUpper=false` default → boundary 落ち | `due == nowIso` ぴったり行が今回 fixture に 0 件で実測露見しないが、 新 path は `bound(..., false, false)` で実装通り | ✓ 構造で守られている |
| 0 件化 (semantics 完全壊滅) | `domDueCount > 0 && newPath > 0 && oldPath > 0` | ✓ |

### fixture (現在の test user 状態)

- total cards: 10 (T-B5 named fixture から無改変、 2 exams `565e71dc...` 4 cards / `73008426...` 6 cards)
- user owned: 10 (= test user 単独、 other-user data なし)
- due bucket: `due_now=5 / future=5 / boundary_exact=0`
- exam 件数: 2

---

## §3 smoke 2: wall-clock 計測 (完了条件 b-ii 正本)

stg 実機、 warm-up 3 run + 12 run interleaved、 stats 単位 ms:

| path | min | median | max | mean | stdev | longtask (>50ms) | count |
|---|---|---|---|---|---|---|---|
| **A (旧 baseline、 step0 §4b 形)** | 19.1 | 21.3 | 23.8 | **21.36** | ± 1.34 | 0 | 5 |
| **B (新 T-B6 [user_id+due].count())** | 0.3 | 0.4 | 1.1 | **0.47** | ± 0.22 | 0 | 5 |

### step0 §4b baseline 突合

| metric | step0 §4b (T-B6 着手前、 同 fixture 10 cards) | 今回 (post-deploy) | 評価 |
|---|---|---|---|
| path A mean | 21.86 ± 1.90 | 21.36 ± 1.34 | 誤差範囲内同等 → baseline 維持 |
| path A median | 20.9 | 21.3 | 同等 |

### 完了条件 b-ii 達成

- low-scale wall-clock 非劣化: ✓ (path A baseline と同等以下、 path B (新) は **45x 高速**)
- longtask 0: ✓ (両 path とも 0)
- 体感劣化なし: ✓
- 構造改善: path B 0.47ms = native B-tree range count、 row 本体 fetch なし

### scale 別予測 (step0 §4c の bench を参照)

| 規模 | path A (旧) | path B (新) | 比 |
|---|---|---|---|
| 10 (現実 test user) | 21.36ms | 0.47ms | 45x |
| 500 (step0 bench) | 6.4ms | 2.0ms | 3.2x |
| 2,000 | 26.4ms | 6.1ms | 4.3x |
| 10,000 | 132.4ms | 22.0ms | 6.0x |
| 50,000 | 712ms | 134.3ms | 5.3x |

10 cards 規模は IDB transaction startup overhead が dominant のため path A も比較的軽量、 改善比は 45x と大きく見えるが絶対値はもともと < 30ms。 audit P1 の本来の defense 対象 (= power user 5k cards 以上) は step0 §4c bench で 6x 改善が確証済。

---

## §4 smoke 3: console / network / DOM

- **console error (page 由来)**: 0 件 (Total 3 messages: Errors 0, Warnings 1 = page 不問の warning)
- **network failed**: 0 件 (Clerk の 307 redirect は normal、 後続 200 で resolve)
- **DOM 件数表示崩れ**: なし (main CTA "スマート復習（5件）" 正常 render、 dashboard-stats / billing banner / その他 layout 全て正常)

---

## §5 制約遵守

- [x] 本番 stg `recallmint` DB 無改変 (全 query readonly transaction、 isolated DB は今回未使用)
- [x] fixture 書き込みなし (OT 事前確認不要、 read-only smoke で完結)
- [x] 実機 mobile / 決済 / 破壊操作なし (= 全て指示通り回避)
- [x] 計測値は avg のみでなく min/max/median/mean/stdev 5 種揃え (step0 §4b と同型)

---

## §6 結論

- T-B6 stg smoke **全 pass**: deploy 反映 ✓ / 三者一致 ✓ / 完了条件 b-ii ✓ / console+network+DOM ✓
- 二度ハマった boundary バグの再発なし (`'￿'` 経由の全 user 化、 `includeUpper=false` 経由の boundary 落ち、 両方とも構造的に防御済)
- T-B7 (get-dexie-session-cards) は同 v7 index を流用予定で chunk 内に旧 pattern 残存 (想定内、 next task で解消)
- OT 手動確認 (= 課金 API / mobile / push / Stripe 本番等の CC 範囲外) は今回不要 (dashboard read-only path、 決済・認証 boundary に触らない)

## §7 関連 log / commit

- T-B6 chain commit: `0c9a1cf` (docs L147/L148 改訂) + `fab0f46` (feat impl)
- stg deploy: `dpl_Cp6EqjaHYpr5b1zHKt9adP65H9Gt`
- Step 0 fact-finding: `docs/superpowers/sessions/2026-06-14-y2-t-b6-step0.md`
- Step 0 二段補正 (boundary): `2026-06-14-y2-t-b6-step0.md` §補-E
