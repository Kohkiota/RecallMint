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

---

## smoke 結果 + T14b′ CLOSE(2026-08-04・OT 実機)

### §A 主経路(正常系)= **PASS**
5 枚 upload 完走。Vercel logs `source_purge.done`(trigger=`publish_completed`)= **marked=5 / r2DeleteOk=5 / r2Delete404=0 / r2DeleteFailed=0 / rowDeleteOk=5 / rowDeleteFailed=0**。R2 trace で src/ 配下 DELETE 5 本すべて 204。**処理中 src/ に 5 件存在 → 完走後消滅**(存在→消滅の両方観測)。crop 表示用 asset は PUT 200 残存(消してはいけない側も無事)。→ 主経路の同期 purge + 観測性ログが end-to-end で実証。

### §C 網(dry-run)= **PASS**
`--sweep --dry-run` = `source: would promote 10 source_asset(s)`。事前突合 SQL の「反転前 completed-retain 残骸 10 行」と**完全一致**(Class B が実データで正しく効く)。asset lane は grace=30d のまま marked=0 で **source lane(16 分固定)と分離**を確認。

### §B(失敗系)= UI 手段なしで実行不能 → **impl + test で確認済**
size_exceeded / 枚数超過はフロントで弾かれ source が R2 に上がる前に失敗するため、source 存在下の terminal_failed を UI で作れない。代替確認 = **5 terminal action すべてから purge 到達を実 PG iso で pin**:
| terminal action | purge 呼出(file:line) | 実 PG iso pin |
|---|---|---|
| publish completed | `publish-prepared-orchestrate.ts:409` | `publish-prepared.test.ts:706-`(regression+completeness) |
| publish terminal(4 reason) | `publish-prepared-orchestrate.ts:213` | 同上 |
| claim terminal(6 reason) | `claim-operation.ts:461` | `claim-operation.test.ts:1055-` |
| stage terminal(2 site) | `stage-prepared.ts:447,538` | `stage-prepared.test.ts:405-` |
| abandon | `abandon-operation.ts:136,138` | `abandon-operation.test.ts:327,341-` |
| prepare supersede | `prepare-upload.ts:508` | `prepare-upload.test.ts:622-` |
- 加えて **`SourcePurgeTrigger` union が全 8 call site を compile-time 強制**(未配線は typecheck fail)+ canonical(opus)が terminal-write 6 site を独立列挙(5 in-app 全 purge 到達 / operator script のみ網依存)。→ §B は test + 型 + 独立 review の三重で担保。

### §D(既存 asset lane)= UI 手段なしで実行不能 → skip(本 task 無変更領域)

### 副次 1: orphan 1 件(T15 入力)
R2 src/ 11 件 / DB 10 行。差分 = `654e3523-86bc-431f-9910-7ab819656ca3.webp`(R2 あり・DB 行なし・dry-run 予告に出ない=**row 駆動 GC から発見不能**)。fact-finding の**経路 C(cascade で行だけ消滅)/ E(finalize temp 削除失敗)の実物**。一掃時はこの 1 件を最後に扱う(T15 で経路 C を閉じる際に prefix listing 等で対処)。

### 副次 2 / 3
hash dedup = 仕様どおり(対応不要・`docs/audit/2026-08-04-image-hash-dedup-factfinding.md`)。退会経路の実地確認は source を R2 に残す状態を手動で作れず断念 → 経路 C は fact-finding の file:line 根拠を前提に **T15 で設計**。

### ★ [reviewed] 正記録
- **T14b′ feat `3c962a2`(tagless)= §A/§C smoke PASS + §B impl/test 確認 → [reviewed]**(push 済ゆえ本 session doc が [reviewed] の正記録・commit tag は追わない・CLAUDE.md stg-smoke discipline)。
- observability `bb542c0` は既に **[reviewed]**(非破壊=review-gated・commit 済)。

### 残骸 10 件 sweep 本実行(OT 実機・破壊)
```sh
DATABASE_URL_ADMIN='<stg owner 接続文字列>' pnpm tsx --conditions=react-server scripts/gc-image-assets.ts --sweep --user <対象userId>
```
(`--user` で対象 user 限定・値必須。`--grace-days` 省略で Class A=16分/asset lane=30d 既定。dry-run で 10 件予告を再確認してから本実行。orphan 1 件は行なしゆえこの sweep では消えない=T15 で扱う。)

### この後
T15(GDPR=退会/exam の source soft-delete + R2 削除・経路 C 閉じ)→ T16 → follow-up 束 → whole-branch review。
