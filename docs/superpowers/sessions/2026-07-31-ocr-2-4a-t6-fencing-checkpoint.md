# ②-4a 実装 T6 fencing checkpoint(claim + lease CAS)

- 日付: 2026-07-31
- 位置付け: OT 指定の「T6 完了時 checkpoint」。fencing の CAS が単一 SQL / 競合 2 実行で成功が必ず 1 件かを重点確認。
- 実装方式: superpowers:subagent-driven-development。
- ledger: `.superpowers/sdd/2026-07-30-ocr-2-4a-image-figure-crop/progress.md`
- T4 完了=`ad91abd` / T5 完了=`55f0d83`(いずれも canonical+Codex Crit0/Imp0 で [reviewed])。T6 は **staged(未 commit・Crit2 未解決)**。

---

## 1. 進捗(commit / gate)

| task | 内容 | 状態 | ref |
|---|---|---|---|
| T0 | sharp direct | 完了 | b5d86f1 [no-review] |
| T1-3 | schema 3 表 | 完了 | 16474a6/2e45972/359bf46 [no-review] |
| R2 | schema 改訂(nullable + input_fingerprint 廃止・migration 0029) | 完了 | f2da717 [no-review] |
| T4 | prepareUpload | 完了 | ad91abd [reviewed] |
| T5 | source reserve/finalize | 完了 | 55f0d83 [reviewed] |
| T6 | claim + lease CAS + daily cap | **staged(Crit2 未解決)** | — |

T6 gate: `pnpm test:iso` 269 green(+16)/ `pnpm build` exit0 / `pnpm typecheck` exit0 / whole-repo `pnpm lint` --max-warnings=0 exit0 / full vitest 4087。

---

## 2. fencing CAS(OT 重点確認事項)= **良好**

claim の CAS(`claim-operation.ts`):

```sql
UPDATE upload_operations
SET status = 'claimed',
    lease_version = lease_version + 1,
    lease_expires_at = $leaseExpiresAt,   -- now + LEASE_TTL_MS(15分)
    attempt_count = attempt_count + 1
WHERE id = $operationId
  AND user_id = $userId
  AND (
    status = 'awaiting_sources'
    OR (
      status = 'claimed'
      AND (lease_expires_at IS NULL OR lease_expires_at < $now)   -- 期限切れ lease takeover
      AND (next_retry_at   IS NULL OR next_retry_at   <= $now)    -- retryable 再 claim
    )
  )
RETURNING lease_version
```

- **単一 SQL の条件付き UPDATE**。claimable 述語を WHERE に埋め、競合は Postgres の row-lock + READ COMMITTED EvalPlanQual 再評価で解決(app 層タイミング非依存)。
- **競合 2 実行で成功が必ず 1 件**: canonical + Codex 双方が確認。iso test で real Postgres 2 tx `Promise.all` race → outcomes = `['already_processing','claimed']`(sort)+ `lease_version===1` + `attempt_count===1` を実証(非 vacuous)。
- 0-row 分岐: `completed`→result_summary 再利用 / `claimed`+有効 lease→`already_processing` / `prepared`→`already_prepared` / else→`not_found`。**fingerprint 条件なし**(2026-07-31 revision 準拠)。
- WHERE の `lt(lease_expires_at, now)`(claimable)と 0-row 分岐の `>= now`(already_processing)は厳密な論理補集合(境界ギャップなし)= canonical 確認。

→ **OT が重点確認したい「単一 SQL / exactly-one-winner」は満たしている**。

---

## 3. review 結果 = With fixes(Critical 2・両 reviewer 独立一致)

### Critical #1(CC 修正予定・clear)
daily cap check が operation の status 分類より**前**にある(`claim-operation.ts:61-77`)。global count が上限到達時、既に `completed` の operation を再送すると `daily_limit_exceeded` を返し、本来の `result_summary` を返さない → **冪等 replay 契約(spec §2)違反**(completed は新規 Gemini call 不要)。`already_processing`/`already_prepared` も同様。
**修正**: 非 claimable status(completed/claimed-valid/prepared)を**先に分類**し、cap は「新規 claim を実際に試みる path(awaiting_sources / claimed+期限切れ+retry-ready)」にのみ適用。→ CC が即修正。

### Critical #2(**要 OT 判断: fix vs accept**)
server 実測サイズ再検査(`:79-106`)と claim CAS(`:120-148`)が**2 文で非 atomic**。size SELECT と operation UPDATE の間に別 tx の finalize が別の source_asset を `ready` 化すると、claim が**古い(小さい)合計**で成功 → `TOTAL_UPLOAD_LIMIT_BYTES`(4MB)の anti-tampering チェックを**すり抜ける**。operation-row CAS は source_assets の変更を serialize しない。

- **影響**: 改変クライアント + 精密な race で、最大 `MAX_SOURCES_PER_UPLOAD(40)×MAX_ASSET_BYTES(5MiB)=200MB` まで通しうる(意図 4MB の ~50x)。daily cap の非原子(overshoot 1-2)より overshoot が大きい。
- **latent**: `claimOperation` は現状 UI 未配線ゆえ現 runtime 経路なし(但し T6 は standalone reviewed unit として正しくあるべき)。
- **選択肢**:
  - **(a) FIX(CC 推奨)**: claim tx 内で source_assets を `SELECT … FOR UPDATE`(source_document 単位)し、**全 source が ready(reserved 0 件)を要求** + ready の byte_size 合計を検査 → claim CAS、を 1 tx に束ねる。concurrent finalize は lock で待たされ、全 ready 要求で claim 後の新規 ready 混入も防ぐ = set を凍結。新 outcome `sources_not_ready` が増える(state machine semantics の追加ゆえ checkpoint 事項)。
  - **(b) ACCEPT**: 残余リスクを明文化して受容(precedent = spec §3 の daily cap 非原子受容・実ユーザー0)。ただし overshoot が daily cap より大きい点に留意。
- **CC 推奨 = (a) FIX**。overshoot 50x は daily cap(1-2)より実害寄りで、fix は既存 CAS/lock パターンで bounded。

### Minor(記録のみ)
- `currentUserOrNull` 4x 重複(rule-of-three 超過は copy#3 時点・T6 の責でない・follow-up 抽出 task)。
- `claimed`+期限切れ lease+`next_retry_at` 未来(正当な backoff 待ち)→ `not_found` に collapse(MVP 簡略・plan の outcome set 準拠・T7 retry consumer 構築時に distinct outcome 検討)。
- concurrent takeover(期限切れ claimed 行)の専用 iso test なし(同 UPDATE/row-lock 機構ゆえ一般化・cheap 追加）。
- iso test の `ai_usage` today-date 暗黙 coupling(現状安全)。

---

## 4. 次アクション(OT 判断後)
- Crit#2 の (a)/(b) 決定 → Crit#1(reorder)と合わせて fix round → 再 Codex(1 周)Crit0/Imp0 → canonical 確認 → `[reviewed]` commit。
- その後 T7(統合 schema + prompt + source_id interleave)へ。
