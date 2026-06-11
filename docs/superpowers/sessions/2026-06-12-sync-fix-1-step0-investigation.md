# Sync-fix-1 (拡大版) Step 0 調査 — 2026-06-12

- **起票日**: 2026-06-12
- **位置づけ**: spec 起草前の棚卸し。 OT 提示 + sprint 分割案承認のための調査結果集約。 実装 / spec / plan 起草は本 doc 段階では未着手 (CLAUDE.md OT 出力規律準拠)。
- **scope 正本**: `docs/audit/2026-06-12-repo-wide-audit.md` §10.2 (a) Sync-fix-1 編入リスト 14 項目 + 従来スコープ (全 optimistic 経路の共有 helper 収束 / tag mutation zod 化 / Grid-2 bulk 土台 = N エンティティ一括口)
- **手法**: 3 fresh general-purpose subagent を並列 dispatch → controller (CC) が突き合わせ + sprint 分割案統合。
- **重要前提**: 修正着手なし。 各分割案の OT 承認後、 spec 起草 (brainstorming skill or design 単独) で本 doc を引用しながら確定する。

---

## 0. agent 配置と推奨サマリ

| agent | scope | 推奨 |
|---|---|---|
| **A** | 共有 helper 設計 + P0 hotfix 判断 (audit §1.1 lost write 2 件) | helper API = **案 B (pure function 形)**、 hotfix = **(c) helper 最小骨組先行 + P0 2 件で reference 4 件化** |
| **B** | retry 意味論 (200+failed[] 区別) + outbox 24h 自動 failed 隔離代替 | response 形 = **案 1 (HTTP 5xx 格上げ)**、 cap = **24h 撤廃 (案 1)**、 配置 = **Sync-fix-1 から分離して launch 前 hardening sprint** |
| **C** | zod 化対象切り分け (tag mutation drift / dup check race / bound なし入力 / ClientEntityMutation loose) | **案 2 (A-1+A-2+A-3+A-4 を本 sprint、 B-1/B-2 bound 追加は hardening 送り)** |

---

## 1. 項目 1 + 2: 共有 helper 設計 + P0 hotfix 判断 (agent A 集約)

### 1.1 14 項目の実コード再確認

agent A が全 14 項目を read し、 audit の file:line と現コードが**全件一致**を確認。 ただし 1 件 (audit #5 `card-tags-section.tsx` rename/color 系) は**既に reference 形 (mirror update → enqueue await → revert on throw)** に到達済みで、 残るは「4 関数の 25 行コピペ」 と「revert `.catch(...)` 握り潰し」 のみ (= 部分修正済)。

pattern バケット分類:
- **create flow (single store + IIFE)**: #1 (handleAddCard、 lost write P0)
- **delete (single store + IIFE)**: #2 (onConfirmDelete、 lost write P0)
- **rename/color (single store, void parallel)**: #3 (inline-text-field commit)、 #4 (inline-option-row commit)、 #6 (option-row / category-row enqueueUpdate)、 #5 (card-tags-section 4 関数 = 既に reference 形)
- **create flow (single store, void parallel + form reset)**: #7 (option-create-form / category-create-form)
- **infra (Web Locks wrapping、 非 optimistic)**: #8 (entity-mutation-flush / review-flush / pull)
- **server-side**: #9 (tag_option dup check)、 #10 (tag update validation drift)
- **cross-cutting**: #11 (String(err) boilerplate 23 件)、 #12 (revert 握り潰し = #5 内包)、 #13 (ClientEntityMutation loose 型)、 #14 (newId 重複)

### 1.2 reference 実装 2 種からの抽出 (helper 設計要件)

reference A = `card-tags-section.tsx handleToggle:611-661`、 reference B = `lib/tags/reorder-handlers.ts` を読み、 same-tx atomic に必要な要素を抽出:

1. `db.transaction('rw', store1, store2, ..., db.entity_mutations, async () => {...})` で mirror store + `entity_mutations` を必ず同 tx
2. mirror write → enqueue の順序 (reference 全 file 統一)
3. enqueue throw → tx callback rethrow → **Dexie auto-rollback** が発火条件 (catch で握り潰すと rollback しない)
4. try/catch は tx 外 (rollback 発火後に caller catch)
5. catch 後 silent return (案 a 取り直し、 server pull で reconcile)
6. flush は tx 外で fire-and-forget (`void runGuarded*Flush().catch(() => {})`)
7. **userId は props で必須**受領 (空文字 placeholder なし、 早期 throw + `console.error` で防御)
8. rename/color の atomic は tx を張らず mirror update → enqueue await → throw 時手動 revert (#5 の handleRename* 系)
9. delete cascade は multi-store rw tx で配下 store 順次 delete
10. create flow は client 採番 (`crypto.randomUUID()`) + multi-store rw tx (最大 3 store)

### 1.3 helper API 案 A/B/C 比較 → 案 B 推奨

| 比較軸 | 案 A (hook 形) | **案 B (pure function 形)** | 案 C (builder 形) |
|---|---|---|---|
| 14 項目のうち乗る件数 | 6/14 | **14/14** | 11/14 |
| 複数 store atomic 対応 | NG | ◎ | ◎ |
| create flow (newId 採番) | △ | ◎ | ◎ |
| delete cascade | NG | ◎ | ◎ |
| reference (reorder-handlers.ts) への近さ | 遠い | **近い (generalize 出発点)** | 中間 |
| テスト容易性 | △ | **◎** | △ |
| 実装コスト | 小 | **小 (~100 行)** | 中 (150-200 行) |

**推奨: 案 B (pure function 形) — `lib/sync/optimistic-mutation.ts` 新設**。 3 関数で全 pattern を吸収:

```ts
runOptimisticMutation({ stores, mutate, mutations, logEvent, logContext?, throwOnError? }): Promise<void>
runOptimisticCreate<T>({ buildRow, mirrorStore, buildMutation, extraMirrorWrites?, extraStores?, logEvent, logContext?, throwOnError?, userId }): Promise<{ id: string }>
runOptimisticUpdate<TKey, TPatch>({ store, rowKey, beforeValue, afterPatch, mutation, logEvent, logContext?, isNoop? }): Promise<void>
```

14 項目の乗り具合: **9 件 (#1 #2 #3 #4 #5 #6 #7 #11 #12) が helper で直接吸収**、 残り 5 件 (#8 #9 #10 #13 #14) はスコープ外 (Sync-fix-1 sprint 内の独立 task)。

### 1.4 helper スコープ追加候補 (audit 14 項目漏れ)

- 追加 1: `tags/_components/category-list.tsx:170-207 handleConfirmDelete` — cascade purge + 別 void enqueue (#2 と同 pattern lost write)。 `runOptimisticMutation` で吸収可
- 追加 2: `tags/_components/option-list.tsx:144-176 handleDeleteImmediate` — 同上
- 追加 3: card-tags-section.tsx 4 関数の revert 握り潰し → helper 内に閉じ込めれば 4 callsite から消える (#12 と重複認識だが scope 拡張)

### 1.5 P0 hotfix 判断 (項目 2)

#### 差分規模 (helper 作らず素朴 hotfix の場合)
- #1 handleAddCard: 44 行 → 約 35-40 行 (5-10 行短縮)、 1 file touch
- #2 onConfirmDelete: 22 行 → 約 18-20 行 (2-4 行短縮)、 1 file touch
- 合計: 新規 file 0、 変更 file 2、 純減 7-14 行

#### hotfix が helper 設計に与える制約
- **薄い**。 hotfix の構造は helper API の入力に**完全に変換可能**。 唯一の弱い制約: `logger.warn` event 名を hotfix → helper 統合で変えると grep 連続性が切れる (= hotfix 時に統合後と同じ event 名を採用すれば 0 コスト)。

#### lost write 発生確率 (helper 完成を待つ場合のリスク)
- enqueue throw の発火条件: storage quota / Dexie schema upgrade race / version conflict / disk full / system error
- 通常運用: ほぼゼロ。 **更新リリース直後 + 既存 user 端末**: schema upgrade race + 旧版タブ残置で数 % 経験可能
- 厳密確率: 1 cell 編集あたり 0.01-1%、 集計で **user 1 人月で 1 件遭遇可能性**。 1 件あたり「最後の編集 1 件喪失」 で limited だが silent
- **sprint 期間 1-2 週間で複数件発生し得る** → 早期 hotfix の価値が高い

#### 結論: (c) helper 最小骨組先行 + reference 4 件化 推奨

3 択 (a) 素朴 hotfix 先行 / (b) helper 完成と同時に 14 項目一斉移行 / **(c) helper 最小骨組 (runOptimisticMutation + runOptimisticCreate のみ ~100 行) を先に書いて P0 2 件で reference を 3 件 → 4 件化**:

- (a) を不採用: 2 段階 review、 logger event 名の grep 連続性懸念
- (b) を不採用: lost write を放置する期間が長く §1.5 リスク放置
- **(c) 推奨**: hotfix と helper 設計を同時固定、 reference が 4 件で設計安定、 hotfix と helper を同 PR で 1 度の review、 推定 1-2 日

### 1.6 実装順序 (推奨、 (c) 採用時)

```
Task A: lib/sync/optimistic-mutation.ts 新設 (案 B の runOptimisticMutation + runOptimisticCreate のみ ~100 行)
        + 単体テスト (mirror auto-rollback / silent catch / flush 発火 mock で 6-8 case)
Task B: inline-card-list.tsx handleAddCard を runOptimisticCreate 経由に書き換え (P0 #1)
Task C: delete-card-button.tsx onConfirmDelete を runOptimisticMutation 経由に書き換え (P0 #2)
Task D: PR 提出 — Task A/B/C を 1 PR、 [reviewed] tag で commit
(以降は §4 sprint 分割案を参照)
```

---

## 2. 項目 3: retry 意味論 + outbox 24h policy (agent B 集約)

### 2.1 現状の failure 分類 (server `failed[]` に詰まる種類)

`app/api/review-events/bulk/route.ts`:
- F1 **orphan event** (cardStateMap miss) — permanent — 200 + failed[]
- F2 **tx 内 DB 障害** (postgres-js error、 connection reset / deadlock / lock timeout) — **transient の代表** — 200 + failed[] **(問題)**
- F3 **drizzle/postgres-js library bug** (例: Drizzle #5789 timestamptz) — permanent (コードバグ) — 200 + failed[]
- F4 **RETURNING 件数 mismatch** (parallel mutation / user 削除 race) — transient っぽい permanent — 200 + failed[]
- F5 **study_days SQL N+1 失敗** (lock/timeout) — transient — 200 + failed[]
- (session_upsert の例外: 500 を返す)

`app/api/entity-mutations/bulk/route.ts` (per-mutation tx):
- E1 **registry lookup miss** — permanent — failed[]
- E2 **per-op patch zod 失敗** — permanent — failed[]
- E3 **`entry.apply` failed 戻り** (orphan / owner mismatch / FK 違反 / dup) — 大半 permanent、 例外 = tag_option dup check 自己除外漏れ (= transient race)
- E4 **予期しない throw** (DB 接続障害、 connection pool 涸れ) — **transient の代表** — 200 + failed[] **(問題)**

### 2.2 client retry chain の現状

- `lib/sync/review-flush.ts:122-124`: backoff = [10s, 30s, 60s, 5min, 15min] + jitter [2s, 5s, 10s, 30s, 60s] (5 回)、 累積 max wait ~17.5 分
- `lib/retry/transient-error.ts:32-42`: status 数字を string 化して regex match。 `500/502/503/504` / `timeout` / `unavailable` / `ECONNRESET` 等を **transient 判定**
- **問題**: `status=200 + failed[].length > 0` は regex match せず **permanent に倒れる** → backoff retry 不発 → 次の通常 trigger (mount / visibilitychange / online) まで待つ
- outbox status 遷移: `pending → synced` (server 200 で失敗欄に無いとき) / `pending → failed` (**mount 時 24h 自動 drop のみ**)、 `failed` 隔離後の UI 復旧導線**無し**

### 2.3 設計起源 (経緯尊重)

git history で確認:
- `20d4896` (S-cache-1 初版): 200 swallow 採用、 「persistent 500 時の retry storm 防止」 が OT 承認済 defer 項目
- `cde3826` (per-event tx → 単一 tx): 200 swallow が tx rollback に伝染 (commit comment: 「event_id 冪等性で次 flush は safe に再試行可」 — ただし 「次 flush が起動するか」 は別問題)
- `06c9ba2` (review-flush controller + 24h 隔離): retry chain と 24h cap が**追加された時点で 200 swallow が retry 機構と drift**

webhook の 200 swallow 文化 (CLAUDE.md §Stripe-5) は**意図的に retry を切る**ためで、 bulk route は**逆に retry させたい**経路。 同じパターンが「冪等だから safe」 を理由に bulk へ降りてきたが、 retry 機構との結合は未設計のまま drift した。

### 2.4 server response 形の変更案 → 案 1 推奨

| 観点 | **案 1 (HTTP 5xx 格上げ)** | 案 2 (DU envelope、 `kind: 'permanent'|'transient_infra'|'transient_dependent'`) | 案 3 (retryable bit + retry-after) |
|---|---|---|---|
| 表現力 | 中 | 高 (per-item kind) | 低 (bulk 全体 1 bit) |
| transient_dependent 区別 | × | ○ | × |
| **互換性 (古い client が新 server)** | **完全前進互換** | 後方非互換 (failed[].forEach 壊れる) | 完全前進互換 |
| **client 側変更量** | **0 file** | 5-6 file、 100+ 行 + 型 | 3 file、 各 5-10 行 |
| server 側変更量 | S (2 file、 各 5-10 行) | M (2 file + zod、 各 20-30 行) | S (2 file、 各 3-5 行) |
| 段階移行 | server 先行 1 phase で完了 | server (dual) → client → server (v1 削除) 3 phase 必須 | server 先行 or 同時 |

**推奨: 案 1**。 Phase 2 throw → 5xx return:

```ts
// review-events/bulk/route.ts:409
} catch (err) {
  logger.warn({...})
  return Response.json(
    { error: 'tx_failed', failed: events.map(e => e.event_id) },
    { status: 503, headers: { 'retry-after': '30' } }
  )
}
// 正常 + orphan のみ → 200
return Response.json({ ok: true, failed: orphanFailed }, { status: 200 })
```

`entity-mutations/bulk/route.ts:184-205` も同形 (infra failure があれば 503、 validation/orphan のみなら 200)。

**client 側は完全に既存コードのまま動く** (`isTransientError` regex が 503 を transient 判定済)。 唯一 optional: `Retry-After` header 尊重を `computeBackoffMs` に追加 (server hint > 既定 backoff なら hint 採用)。

### 2.5 outbox 24h 隔離の代替案 → 案 1 (cap 撤廃) 推奨

| 案 | 内容 | trade-off |
|---|---|---|
| **1 backoff 継続 (24h cap 撤廃 or 7d 化)** | `PENDING_MAX_AGE_MS` を 7d (= 168h) or 撤廃、 `dropStale*` 関数 noop 化 | ◎ 自動復旧 / ○ storage MB オーダー / × ops 検知不可 |
| 2 UI recover 導線 | failed 行を UI で再試行ボタン経由 retry / 諦め | △ user 操作要、 launch 前 sprint で UI コスト重い |
| 3 永続 retry + Discord 通知 | 7d 経過時 `/api/ops/notify-stale-pending` 投入 → Discord | ○ 自動復旧 + ops 早期検知 / 通知 endpoint 新設要 |

**推奨: launch 前最小 = 案 1 (24h → 30d or 撤廃)**。 数行の定数変更 + dropStale 関数 noop 化で完結。 案 3 は別 sprint で `lib/ops/notify.ts` の整備状況に応じ追加。

### 2.6 段階移行 ordering

- 案 1 採用なら **server 先行 1 phase**: 古い client が新 server 503 を受けても既存 regex で transient → backoff retry がそのまま動く (**退行なし**)
- Vercel deploy は server / client 同時だが、 service-worker / bfcache で user 側に旧 JS 数分〜数時間 skew → 「完全同時は不可能」 前提だが案 1 は退行リスク無し

### 2.7 Sync-fix-1 に含めるか分離か → **分離して launch 前 hardening sprint** 推奨

根拠 (agent B 4 つ):
1. **scope と質的に違う**: Sync-fix-1 は Dexie + outbox + component 重複の atomicity / 重複コード集約。 retry 意味論は server response 形 + retry controller 配線で、 軸が違う
2. **test 影響 + PR サイズ**: Sync-fix-1 は既に M-L 規模。 retry 混在で plan 300 行超過リスク (CLAUDE.md STOP ライン)
3. **失敗モード直交**: atomic 化失敗 = local 編集喪失、 retry 意味論失敗 = sync 遅延 / 過剰 retry。 同 PR で blame 困難
4. **案 1 は client 変更 0 file** = hardening sprint で server route + 24h 撤廃 = 1 PR 30-50 行 + test 100 行に収まる
5. ただし **audit §3 P1 [Codex-only] 24h 自動 failed 撤去は launch 前必須** (長期 offline 編集 silent loss = launch 直後の事故面大、 数行で fix 可能)

### 2.8 OT に確認すべき論点 (agent B 提示)

- A. retry response 形 = **案 1 確定** + Retry-After header 尊重を入れるか
- B. 24h cap = **撤廃 / 7d / 30d** どれか (撤廃が最 clean、 7d/30d は ops 安心感)
- C. dependent multi-mutation atomic group (audit §10.3 (b) #18) を本 hardening sprint に同梱するか別 sprint か

---

## 3. 項目 4: zod 化対象切り分け (agent C 集約)

### 3.1 tag mutation drift (audit §3 P1 / §10.2 #10) 実コード裏取り

`lib/sync/server/entity-mutation-registry.ts` の create patch zod (行 193-202 / 240-249) と `lib/tags/apply-tag-mutation.ts` の update if 文 (行 75-95 / 227-294) の **非対称**を実コード一致で確認:

| 観点 | create (registry zod) | update (apply if 文) | drift |
|---|---|---|---|
| name `.trim()` | あり | 無し | **あり** (`"  "` が update 通過、 空白だけ保存可) |
| name `.max(100)` | あり | 無し | **あり** (10 万文字も通過) |
| color `.max(50)` | あり | 無し | **あり** |
| sort_key `.max(100)` | あり | 無し | **あり** |
| category_id `z.uuid()` | あり (option create) | 無し (`string` && `length>0` のみ) | **あり** (任意文字列 → DB cast で初めて throw) |
| field allowlist | n/a | envelope `z.enum(...)` で gate | 一致 |

統合方法:
- **方針 A**: `lib/validation/tag.ts` 新設、 `tagNameSchema` / `tagColorSchema` / `tagSortKeySchema` / `tagCategoryIdSchema` を集約。 registry create patch を field schema で組み直し、 apply update の switch を field 名 → 個別 schema の dispatch table 化
- **方針 B**: registry envelope を `z.discriminatedUnion('field', ...)` 化、 apply 側の値検証コードを削除
- **A + B 併用**が `lib/cards/card-field-handlers.ts` の既存 pattern (envelope 緩く、 per-field handler に閉じる) と整合

### 3.2 tag_option dup check race (audit §3 P1) 実コード裏取り

`apply-tag-mutation.ts:172-206` (applyTagOptionCreate):
- 行 178-185: 親 category owner-scope check
- **行 187-192: UNIQUE(category_id, name) 事前 SELECT、 `id != optionId` の自己除外なし**
- 行 194-205: INSERT … `onConflictDoNothing()`

race scenario: **coalesce 経路 (`entity-mutations.ts:80-98`) で mutation_id が再採番**されると、 server の idempotency (`route.ts:92-107`) が効かず apply に到達 → 自己除外なしの dup check が「前回の自分の INSERT を既存」 と認識 → `'failed'` 返却 → client UI が「同名存在」 と誤報。

修正: **行 191 の WHERE 句に `ne(tagOptions.id, optionId)` を追加するだけ** (1 行 fix)。 同 file の rename path (行 238-248) + category_id move path (行 282-291) は既に自己除外済、 不一致は create path のみ。

`applyTagCategoryCreate` は UNIQUE constraint なし → 同種 race 発生せず、 修正不要。

zod 化との関連: 本件は zod ではない (SQL WHERE 句 fix) だが、 audit §10.2 #9 で「Sync-fix-1 編入」 分類 = 同 file の zod 統一と 1 PR 同梱が自然。

### 3.3 bound なし入力 (audit §2 / §10.3) 実コード裏取り

`app/api/review-events/bulk/route.ts`:
- 行 58-66 `sessionSchema`: `card_ids: z.array(z.uuid())` — **上限なし**
- 行 68-81 `eventSchema`: `selected_answer_ids: z.array(z.string())` — 上限なし、 item format なし
- 行 86 `events: z.array(eventSchema).max(1000)` — events 1000 件 cap (= 1 payload bound あり)
- DB column 型: `jsonb` (理論上 ~1GB、 TOAST 圧縮)、 check 制約なし

現実的上限見積もり:
- `session.card_ids.max(2000)` — smart session_limit ≤ 100、 custom session 数百が UX 上限。 攻撃 payload と区別可能 + Vercel 4.5MB request limit の余裕保持
- `selected_answer_ids: z.array(z.uuid()).max(50)` — option 上限 50 (`optionsSchema.max(50)`、 entity-mutation-registry 110) と整合、 1 event ~4KB に bound
- item format `z.uuid()` 厳格 vs `z.string().min(1).max(64)` 緩和 — OCR 経由 legacy id format の実 DB 確認が必要 (OT 判断要点)

### 3.4 ClientEntityMutation loose 型 (audit §6 P3 / §10.2 #13) 実コード裏取り

`lib/client-db.ts:147-157`:
```ts
export type ClientEntityMutation = {
  entity_type: string          // ← loose
  op: string                    // ← loose
  patch: Record<string, unknown>  // ← loose
  ...
}
```

`enqueueEntityMutation({entity_type:'tag_option', op:'create', patch:{ name: 123 }})` が TS 上 compile を通り、 server で初めて zod fail。

解消方法:
1. 新規 `lib/sync/shared/mutation-schemas.ts` (`server-only` なし、 client/server 共用) に patch zod 全件移動 (registry から)
2. `entityMutationEnvelopeSchema = z.discriminatedUnion('entity_type', [cardMutationEnvelope, tagCategoryMutationEnvelope, tagOptionMutationEnvelope])`、 各 envelope はさらに `z.discriminatedUnion('op', [...])`
3. `client-db.ts:147` を `ClientEntityMutation = EntityMutationEnvelope & { local_id?, sync_status, last_attempted_at? }` で派生
4. `entity-mutations.ts:33 EnqueueEntityMutationInput` も `Omit<z.input<typeof entityMutationEnvelopeSchema>, ...>` で派生
5. server registry の `RegistryEntry<EnvelopeT>` を generic 化 → apply 関数内の `patch as z.infer<...>` cast (entity-mutation-registry.ts:137,211,258) を削除可能

`server-only` 制約回避: `lib/validation/card.ts` precedent (server-only なし、 server+client+test 3 sink から共用) を踏襲。 registry を 2 ファイルに分割 (shared = schema、 server registry = apply dispatch + server-only)。

### 3.5 切り分け案 → 案 2 推奨

| 切り分け | 案 1 (全本 sprint) | **案 2 (zod 4 件 + 2 件 hardening)** | 案 3 (helper 収束のみ) |
|---|---|---|---|
| Sync-fix-1 helper 収束との独立性 | × 過大、 PR 混線 | ○ touch ファイル重複度が高く同梱が安全 (drift 防止) | ◎ 完全独立 |
| Grid-2 bulk 土台整合 | △ | ○ shared module で entity_type 追加が schema 1 entry + registry 1 entry で完結 | △ 後から discriminated union 化する負債 |
| launch 前 to-do 優先度 | × 工数 L+、 plan 300 行超リスク | ○ bound 追加は 100 行未満 launch 直前 hardening | ○ helper 収束だけで sprint 小型化 |
| Sync-fix-1 既知合流の解消順 | 一斉 | **本 sprint で 4 件一斉解消** | 1 件のみ、 残り 3 件次 sprint 持ち越し |

**案 2 内訳**:

- **A 本 sprint 編入** (audit §10.2 既知合流 4 件):
  - A-1 tag mutation create/update zod 統一 (apply-tag-mutation.ts + entity-mutation-registry.ts) — 工数 M
  - A-2 tag_option dup check 自己除外 (apply-tag-mutation.ts:191) — 工数 S
  - A-3 ClientEntityMutation discriminated union 投影 (mutation-schemas.ts 新設) — 工数 L
  - A-4 newId() helper 共有化 (review-events.ts:32 + entity-mutations.ts:25) — 工数 S
- **B launch 前 hardening 小 sprint 送り**:
  - B-1 `session.card_ids.max(2000)` — 工数 S
  - B-2 `selected_answer_ids: z.array(z.uuid()).max(50)` — 工数 S
- **C Phase 4 / 波 3 (型安全) 合流**:
  - C-1 Drizzle vs zod vs ClientX 三重定義の SSoT 化 (codex #8 関連)
  - C-2 pull response zod 化 (`lib/sync/pull.ts:100`)

### 3.6 案 2 採用時の sprint task 構成 (agent C 提示)

T1〜T7 で 200-250 行 plan 想定:
- **T1** atomic 化 (audit §10.2 #1 #2 #3 #4): handleAddCard / onConfirmDelete / inline-text-field / inline-option-row を 1 task
- **T2** 4 関数統合 + 共通 hook (#5 #6 #7): card-tags-section.tsx 4 関数 + enqueueUpdate / create-form 共通化
- **T3** Web Locks lock runner 共有化 + newId 共有化 (#8 + A-4): lib/sync 配下の helper 集約
- **T4** apply-tag-mutation.ts tag mutation zod 統一 + dup check 自己除外 (A-1 + A-2)
- **T5** shared mutation-schemas.ts 新設 + ClientEntityMutation discriminated union 投影 (A-3) — 独立 task、 「型レベル投影のみ、 runtime 挙動変更なし」 と plan で明示 (review pass 容易性)
- **T6** card-tags-section.tsx mirror revert 握り潰し fix (#12)
- **T7** String(err) helper 化 (#11) — 23 callsite 一括

工数合計: M×3 + S×3 + L×1 = sprint 1 本に収まる。

### 3.7 残論点 (OT 判断要、 agent C 提示)

1. A-3 (ClientEntityMutation 投影) を本 sprint 同梱か次 sprint 分割か (案 2 推奨同梱、 工数 L)
2. `selected_answer_ids` item を `z.uuid()` 厳格 / `z.string().min(1).max(64)` 緩和 のどちらにするか (OCR 経由 legacy id format の DB 実内容確認 or 2 段運用)
3. shared mutation-schemas.ts に `server-only` を付けない方針確認 (`lib/validation/card.ts` precedent 踏襲)

---

## 4. 項目 5: sprint 分割案 (controller 統合)

### 4.1 整合性チェック (3 agent の推奨が両立するか)

| 軸 | agent A | agent B | agent C | 統合 |
|---|---|---|---|---|
| Sync-fix-1 拡大版 sprint の本体 | helper 骨組 + 14 項目移行 | (scope 外) | T1-T7 (案 2) | T1 先頭に agent A の (c) hotfix を組み込む |
| retry 意味論 | (scope 外) | **Sync-fix-1 から分離** | (scope 外) | hardening 小 sprint へ分離 |
| bound 追加 | (scope 外) | (scope 外) | **hardening 送り (B-1/B-2)** | 同上 hardening へ |
| 24h cap 撤廃 | (scope 外) | hardening 必須 | (scope 外) | 同上 hardening へ |
| P0 hotfix の急ぎ度 | **(c) 推奨、 1-2 日で先行可能** | (scope 外) | T1 内で吸収 | T1 を「helper 骨組 + P0 2 件」 と「残り atomic 化」 に分ける選択肢あり |

**3 agents は両立する。 矛盾なし**。 zod 化 (agent C 案 2) と helper 収束 (agent A 案 B) は同 sprint で並走、 retry 意味論 (agent B 案 1) は独立 hardening sprint で並列実行可能。

### 4.2 sprint 分割案 X / Y / Z

#### 案 X: 1 sprint で全て閉じる (推奨度 × 低)

- Sync-fix-1 拡大版 sprint で 14 項目 + ClientEntityMutation 投影 + retry 意味論 + bound 追加 を全 1 sprint
- plan 行数 400+ 行、 PR scope 過大、 CLAUDE.md「plan 300 行超で STOP」 触発
- 3 agents 全員「分割すべき」 推奨 → 採用しない

#### 案 Y: 2 分割 (推奨)

```
┌─────────────────────────────────────────────────────────────────┐
│ Sprint Y-1: Sync-fix-1 拡大版                                    │
│   - agent C 案 2 (T1-T7)、 内 T1 先頭で agent A の (c) hotfix    │
│     (helper 最小骨組 + P0 2 件) を組み込む                       │
│   - scope: audit §10.2 (a) 14 項目 + ClientEntityMutation 投影  │
│   - touch: lib/sync/optimistic-mutation.ts (新)、 mutation-      │
│     schemas.ts (新)、 各 component file 8 件、 apply-tag-       │
│     mutation.ts、 client-db.ts、 entity-mutations.ts、 logger    │
│   - plan 行数: 200-250 行                                       │
│   - 期間: 1.5-2 週間                                            │
│                                                                 │
│ Sprint Y-2: launch 前 hardening 小 sprint (Y-1 と独立、 並走可)  │
│   - agent B 案 1 (5xx 格上げ) + 24h cap 撤廃 + bound 追加        │
│     (B-1/B-2) + OPS_DISCORD_WEBHOOK_URL fail-fast 等 audit       │
│     §10.3 (b) のうち server 側軽量項目                          │
│   - touch: review-events/bulk/route.ts、 entity-mutations/      │
│     bulk/route.ts、 entity-mutation-flush-trigger.tsx (24h)、   │
│     review-flush-trigger.tsx (24h)、 lib/ops.ts                 │
│   - plan 行数: 100-150 行                                       │
│   - 期間: 3-5 日                                                │
│   - 並走条件: touch ファイル独立、 Y-1 と Y-2 を同時開発可       │
└─────────────────────────────────────────────────────────────────┘
```

利点:
- 3 agents 推奨と最も整合
- PR scope が綺麗に分かれる (Sync-fix-1 = client + atomic + zod、 hardening = server + retry + bound)
- P0 lost write 2 件は Y-1 の T1 先頭 PR (= 着手 1-2 日目で先出し可能)、 silent data loss を最速で塞ぐ
- Y-2 は server 先行 deploy で完全前進互換、 退行リスク無し

懸念:
- Y-1 T1 が「helper 骨組 + P0 2 件 + 残り atomic 化 4 件」 を 1 task に詰めると工数膨張余地。 case-by-case で T1a/T1b に細分化する余地 (= 案 Z への部分採用)

#### 案 Z: 3 分割 + hardening (工数最小化 / P0 最速)

```
┌─────────────────────────────────────────────────────────────────┐
│ Sprint Z-1a: helper 基盤 + P0 hotfix                             │
│   - agent A の (c): runOptimisticMutation + runOptimisticCreate │
│     + 単体テスト + P0 2 件 (#1 #2) を 1 PR                       │
│   - plan 行数: 80-100 行                                        │
│   - 期間: 2-3 日                                                │
│                                                                 │
│ Sprint Z-1b: 経路移行 + 共通 hook                                │
│   - 残り 12 項目 (#3 #4 #5 #6 #7 #8 #11 #12 + scope 追加 3 件)  │
│   - runOptimisticUpdate 追加、 4 関数統合、 Web Locks 集約、    │
│     newId 共有、 String(err) helper                             │
│   - plan 行数: 150-180 行                                       │
│   - 期間: 1-1.5 週間                                            │
│                                                                 │
│ Sprint Z-1c: zod + 型整合                                       │
│   - tag mutation zod 統一 + dup check 自己除外 +                │
│     ClientEntityMutation discriminated union 投影 + shared      │
│     mutation-schemas.ts 新設                                    │
│   - plan 行数: 120-150 行                                       │
│   - 期間: 5-7 日                                                │
│                                                                 │
│ Sprint Z-2: launch 前 hardening (案 Y-2 と同内容)                │
│   - 案 Y-2 と同じ                                                │
│   - Z-1a/b/c と並走可                                            │
└─────────────────────────────────────────────────────────────────┘
```

利点:
- P0 を最速で先出し (1-2 日後の 1 PR で 2 件 hotfix)、 silent data loss リスクを最速縮小
- 各 sprint plan が 100-180 行で短い (CLAUDE.md plan 行数規律に余裕)
- review 通しやすい (1 PR の scope が小さい)
- 1 sprint 内 STOP リスク低

懸念:
- sprint 数増 (3 → 4) で kickoff オーバヘッド (brainstorming + writing-plans 4 回起動)
- Z-1b と Z-1c は touch ファイル一部重複 (client-db.ts、 entity-mutations.ts) → 順序依存、 並走不可
- Z-1a → Z-1b → Z-1c の順序で 2-3 週間、 案 Y より総期間が長く見えうる (ただし PR が小刻みで OT review が回しやすい)

### 4.3 controller 推奨: 案 Y (ただし Y-1 T1 を T1a/T1b に細分化、 = Y と Z の中間)

#### 根拠

1. **3 agents の推奨と整合**: agent A の (c) 最小骨組先行は Y-1 の T1 先頭に組み込み、 agent B 案 1 は Y-2 で別 sprint、 agent C 案 2 は Y-1 の T1-T7 plan を採用
2. **P0 リスク**: agent A 推定で「user 1 人月で 1 件遭遇」 級、 1-2 日先出しで塞ぐ価値は高い。 Y-1 を T1a (helper 骨組 + P0 2 件、 1 PR、 2-3 日) → T1b 以降 (残り) と細分化すれば Z-1a 相当を Y-1 内に確保
3. **sprint kickoff オーバヘッド**: 案 Z は brainstorming + writing-plans を 4 回起動、 case-by-case 1 回あたり 30 分-1 時間。 案 Y は 2 回 → オーバヘッド半減
4. **touch ファイル重複**: Z-1b と Z-1c は同 file (client-db.ts、 entity-mutations.ts) を順次触り、 review が 2 回走る。 Y-1 で同 sprint 内に閉じ込めれば review 集中 + drift 防止
5. **Grid-2 bulk 土台との整合**: agent C 指摘の通り、 N エンティティ一括口の型安全性は discriminated union (A-3) に依存。 Sync-fix-1 完了直後に Grid-2 着手するなら A-3 を Y-1 に同梱する案 Y が自然 (案 Z だと Grid-2 を Z-1c 完了後に置く必要あり)

#### 案 Y 修正版 (controller 推奨)

```
Sprint Y-1 (Sync-fix-1 拡大版):
  T1a: helper 最小骨組 (runOptimisticMutation + runOptimisticCreate ~100 行) + 単体テスト
        + P0 2 件 (#1 #2) を helper 経由で書き換え
        → 1 PR、 期間 2-3 日 [reviewed]
  T1b: 残り atomic 化 (#3 #4) を helper 経由で書き換え + runOptimisticUpdate 追加
  T2:  4 関数統合 + 共通 hook (#5 #6 #7)
  T3:  Web Locks lock runner 共有化 + newId 共有化 (#8 + A-4)
  T4:  apply-tag-mutation.ts tag mutation zod 統一 + dup check 自己除外 (A-1 + A-2)
  T5:  shared mutation-schemas.ts 新設 + ClientEntityMutation 投影 (A-3)
  T6:  card-tags-section.tsx mirror revert 握り潰し fix (#12)
  T7:  String(err) helper 化 (#11)
  期間: 1.5-2 週間、 plan 行数 200-250 行

Sprint Y-2 (launch 前 hardening、 Y-1 と並走可):
  H1: review-events/bulk + entity-mutations/bulk の 5xx 格上げ (案 1)
  H2: outbox 24h cap 撤廃 or 30d 化
  H3: session.card_ids / selected_answer_ids bound (B-1 + B-2)
  H4: (option) OPS_DISCORD_WEBHOOK_URL production fail-fast + 代替 error sink
  H5: (option) STRIPE/CLERK_WEBHOOK_SECRET env-aware (production 必須 / preview 警告)
  期間: 3-5 日、 plan 行数 100-150 行
```

### 4.4 順序候補

#### 順序候補 α (P0 最速)
1. Y-1 T1a (helper 骨組 + P0 2 件) 単独で先出し → [reviewed] commit (2-3 日)
2. Y-1 T1b-T7 を順次 (1-1.5 週間)
3. Y-2 H1-H3 を Y-1 完了直後 (3-5 日)

#### 順序候補 β (並走)
1. Y-1 全 T1-T7 + Y-2 H1-H3 を同時開始
2. OT review 容量に応じて Y-1 T1a を先頭で merge → 残りは Y-1/Y-2 並走
3. 総期間は α と同等だが OT review が並列化される

どちらを採るかは OT review 容量次第。

---

## 5. OT に挙げる論点 (まとめ)

CLAUDE.md OT 出力規律に従い、 spec 起草前に確定すべき論点を列挙:

### 5.1 sprint 分割案

- A. 案 Y (2 分割) / 案 Z (3 分割) / 案 Y 修正版 (T1 細分化) のどれか
- B. 順序候補 α (Y-1 → Y-2) / β (Y-1 + Y-2 並走) のどちらか

### 5.2 helper 設計

- C. helper API = 案 B (pure function 3 関数) 確定でよいか
- D. P0 hotfix = (c) 最小骨組先行 + reference 4 件化 確定でよいか
- E. helper スコープ追加候補 3 件 (`category-list.tsx handleConfirmDelete`、 `option-list.tsx handleDeleteImmediate`、 `card-tags-section.tsx 4 関数 revert 握り潰し) を Y-1 内に同梱するか

### 5.3 retry 意味論

- F. retry response 形 = 案 1 (HTTP 5xx 格上げ) 確定でよいか
- G. Retry-After header 尊重を入れるか (= `computeBackoffMs` に server hint 引数追加)
- H. outbox 24h cap = 撤廃 / 7d / 30d どれか
- I. dependent multi-mutation atomic group (audit §10.3 (b) #18) を Y-2 に同梱するか別 sprint か

### 5.4 zod 化

- J. ClientEntityMutation 投影 (A-3、 工数 L) を Y-1 同梱か次 sprint 分割か (案 2 推奨同梱)
- K. `selected_answer_ids` item を `z.uuid()` 厳格 / `z.string().min(1).max(64)` 緩和 どちらか
  - 確認手段: OCR 経由 legacy id format の実 DB 内容 SELECT
- L. shared mutation-schemas.ts に `server-only` を付けない方針確認 (lib/validation/card.ts precedent 踏襲)

### 5.5 順序関連

- M. Grid-2 着手は Y-1 完了後 (A-3 投影完了後) で確定でよいか
- N. Y-2 hardening の deploy は server 先行 1 phase で確定でよいか (案 1 は完全前進互換、 退行リスク無し)

---

## 6. 監査メタ情報

- subagent 配備: agent A (helper + P0) / agent B (retry + 24h) / agent C (zod 切り分け)、 各 general-purpose subagent、 並列 dispatch
- 監査対象 file 数: 約 30 file (audit §10.2 の 14 項目 + reference 実装 + bulk routes + retry chain + entity-mutation 系 schema + lib/validation)
- 実コード裏取り状況: audit と現コードの行番号一致を全件確認 (1 件 #5 は既に部分修正済 = lost write の解決済、 構造重複と revert 握り潰しのみ残る)
- git history で「200 swallow 採用」 / 「per-event tx → 単一 tx」 / 「review-flush controller 追加」 の経緯を `git log -p` で確認 → §2.3 設計起源
- 修正コミット: 一切なし (本 doc 起票のみ、 `docs: ... [no-review]`)
- 関連 doc:
  - `docs/audit/2026-06-12-repo-wide-audit.md` (Codex 統合版、 §10.2 (a) 14 項目 + §10.3 (b) launch 前 hardening list)
  - `docs/codex/2026-06-12-repo-wide-audit.md` (Codex audit、 §3 P1/P2 24h 隔離 + failed[]+200)
  - `docs/next-sprints-priority.md` (v19 で本 sprint 分割案を反映する場合は別途 OT 編集)
