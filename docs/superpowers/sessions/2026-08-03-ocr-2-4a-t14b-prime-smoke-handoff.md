# ②-4a T14b′ stg-smoke gate handoff(source ライフサイクル反転)

**日付**: 2026-08-03
**対象**: `feat 3c962a2`(TAGLESS)= source_assets の retention→同期 purge 反転。**破壊 lane ゆえ stg-smoke 後に [reviewed]**(本 doc = 正記録・push 済 commit tag は追わない)。
**前提**: OT push → stg deploy → smoke。**prod 出さない**。smoke 前に手順書 §0(deploy SHA が `3c962a2` 以降を含むか)を必ず確認。新 env なし(fact-finding runbook §0.3)。

---

## 新軸(この smoke が守るもの)
source(OCR 元画像)は **R2 に残さない**(著作物)。**source が R2 に消え残る = NG(最優先)**。provenance(asset_derivations)消失 = 許容。

## 何を確認するか

### A. 主経路(正常系・最重要)= 完走後 source が即消える
1. 通常 upload を完走(cutover 経路・正常 publish → result page)。
2. 該当 `source_document` の `source_assets` が **数秒以内に R2 + DB から消える**ことを確認:
   - DB: `SELECT id, status, object_key FROM source_assets WHERE source_document_id = :sdId;` → **0 行**(purge で行削除)。
   - R2: 該当 `users/{uid}/src/{assetId}.{ext}` が **404**(削除済)。
   - **crop 図版(`users/{uid}/{figureAssetId}.webp`)と cards は残る**(表示用・source ではない)。
3. `upload_operations` は `completed`、`source_documents` は `completed`(publish の主経路は不変)。

### B. 主経路(terminal_failed 系)= 失敗 upload の source も消える
- claim/stage/publish のいずれかの terminal_failed を意図的に踏ませる(例: claim 直前に source_asset を手動 DELETE して `source_count_mismatch`、または上限超過で `size_exceeded`)。
- 該当 op が `terminal_failed` になり、その source が **即 purge**(A と同じ確認)されること。

### C. 網(取りこぼし回収・二次防御)
主経路を経由しない残骸(異常系)を網が拾うことを確認:
- **Class B(ready + terminal op)= grace 無し・即時**: 例えば `gc-abandoned-operations.ts` で op を terminal 化(source は主経路未経由)→ `pnpm tsx --conditions=react-server scripts/gc-image-assets.ts --sweep --dry-run --user <uid>` で予告 → 本実行で source 消滅。**`created_at` を過去日付にする必要なし**(旧 30 日基準と違う)。
- **Class A(reserved + not-live)= 16 分 margin**: reserved のまま放置(finalize 未実行)の source は `created_at` が `SOURCE_RESERVED_NET_GRACE_MS`(16 分)超で網対象。stg 検証は `created_at` を 16 分超過去へ UPDATE。
- **net-safe 順序の確認**: R2 削除失敗を注入(困難ゆえ任意)した場合、行は `deleting` のまま残り `integration_failures`(`r2_gc_delete_source`)に記録 → 次 `--sweep` で回収(**行だけ消えて R2 orphan、は起きない**)。

### D. GC 整合(既存 asset lane・新 flow crop)= T14b から継続
- ① card A/B が同一 crop asset 参照 → A 削除 → asset は GC 非対象(card_asset_refs 1 本残存)② A/B 両削除 → refs 0 → grace 経過後 asset GC。**これは asset lane(本 task 無変更)**。source lane とは別。

## 確認 SQL(反転の要点)
```sql
-- 完走 upload の source が消えているか(主経路)
SELECT sa.id, sa.status, sa.object_key, op.status AS op_status
FROM source_assets sa
LEFT JOIN upload_operations op ON op.source_document_id = sa.source_document_id
WHERE sa.user_id = '<uid>'::uuid ORDER BY sa.created_at DESC;
-- 期待: 完走/失敗 op の source は 0 行(purge 済)。live op(awaiting/claimed/prepared)配下の source のみ残る。
```

## OT 判断が要る残余(隠さず)
1. **manual-net backstop(公開前 gate)**: 主経路 miss(process 中断 / `gc-abandoned-operations` 経由 / purge の R2 失敗)の source は **手動 net を走らせるまで残る**(scheduler なし)。**net-safe 順序ゆえ永久 orphan にはならない**(必ず回収可能)が、「source を残さない」軸では手動依存が運用露出。**GC 自動化(cron/scheduled)を公開前 gate として ticket 化済**(todo v48 §0.5 新軸 follow-up)。→ **OT の明示 acknowledge を要する**。
2. **crop-and-store FK 違反 race(別 task)**: Finding1/5 撤去で、fencing 敗北 worker の crop が削除済 source に `asset_derivations` INSERT → FK 違反 → 500(**データ破壊なし**・stale worker は元々 fencing で負ける運命)。reviewer 追記 = orphan **crop** object(assets 行なし・row 駆動 GC 発見不能)も生じうる。**crop-and-store error-handling の別 task 推奨**(source ではないゆえ本軸外)。
3. **grace CLI 非公開の設計判断**: source lane の 16 分 margin は固定定数(`--grace-days` は asset lane 専用に残置)。運用者が調整する値でないため。OT 確認推奨。
4. **T15 scope**: 退会 / exam 削除の source cascade orphan(fact-finding 経路 C)は **T15**(本 task 対象外)。

## この後
OT push → stg smoke(A-D)→ 結果を見て T14b′ [reviewed] を本 doc に正記録 → T15(GDPR・退会/exam の source soft-delete + R2 削除)。
