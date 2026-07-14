# 画像 GC v2(card_asset_refs 正規化 + 状態ベース遅延 GC)— 実装完了記録

- **日付**: 2026-07-14
- **branch**: develop / **range**: `8d6d913..5126e85`(実装 9 task)+ 前段 docs
- **spec(凍結)**: `docs/superpowers/specs/2026-07-13-image-gc-normalized-refs-design.md`(前 spec `2026-07-13-image-gc-design.md` を supersede)
- **plan**: `docs/superpowers/plans/2026-07-13-image-gc-normalized-refs-plan.md`
- **実装方式**: subagent-driven-development(fresh implementer per task・実装 subagent は commit せず controller が canonical〔general-purpose〕+ Codex review 通過後 commit)
- **fact-finding**: `docs/audit/2026-07-13-{card-asset-refs-normalization,image-gc,image-delete-sync}-factfinding.md`

## task 別 commit(HEAD SHA 一覧)

| task | commit | tag | 内容 |
|---|---|---|---|
| G1 | `8d6d913` | [reviewed] | card_asset_refs table(migration 0024)・card_id CASCADE/asset_id RESTRICT/user_id CASCADE |
| G2 | `58631b3` | [reviewed] | asset-state 純粋 domain(DDD 監査 D-1 是正)+ eslint media domain block |
| G3 | `1d410e4` | [reviewed] | R2 deleteObject seam(2xx/404=success-equiv)+ r2_gc_delete catalog |
| G4 | `ac192fa`(+ header `0277479`) | [reviewed] | backfill script(dry-run・owner-scope・batch IN・--user fail-fast) |
| G5 | `2fb8f48` | [reviewed] | reconciler(mark/promote/collect・R2-first decouple・pre-sweep guard) |
| R1 | `5875552` | [reviewed] | finalize を domain 配線 + atomic status guard(TOCTOU/冪等 両立) |
| W1 | `eb7215d` | [reviewed] | handleImages で refs 同 tx 全置換(GC 権威化・wire 完全不変・golden 0 更新) |
| **W2** | **`2bec1e6`** | **tag 無し(下記)** | user 削除で assets を deleting soft-delete(+ codex `a5dd268` [no-review]) |
| W3 | `5126e85` | [reviewed] | 画像外し/card 削除でローカル Cache blob 即時掃除 |

## sprint 完了 gate(全 exit 0)

- whole-repo `pnpm lint --max-warnings=0` = **exit 0**
- `pnpm typecheck` = **exit 0**
- `pnpm install --frozen-lockfile`(migration sprint)= **exit 0**
- `pnpm test`(full)= **3616 passed / 231 files**
- `pnpm build` = **exit 0**

## whole-branch review(sprint 完了時・最終担保)

- **canonical(general-purpose/opus・range 7cf031c..5126e85)= Ready to merge / Critical 0 / Important 0 / Minor 3**(全て doc レベル・コード変更不要: 休眠 users FK / 全 user pre-sweep guard の挙動 / reserved-abandoned の grace 掃除)。
- **Codex whole-branch(`--base 7cf031c`・committed range・W1 込み)= Crit0/Imp0/Minor0**(`docs/codex/2026-07-14-whole-branch-image-gc-v2.md`)。
- **G5 の sequencing Critical(reconciler は W1 未 deploy だと live 追加画像を誤収)は W1 込みの whole-branch で構造的に解消を確認**(handleImages が同 tx で refs 権威化 → reconciler が live 参照を orphan 扱いしない)。OT 承認済の「clean にならなければ設計に戻る」条件 = **clean**。設計 holds。

## 運用不変条件(恒久・重要)

**reconciler(`scripts/gc-image-assets.ts`)は W1(handleImages の refs 書込)deploy 後にのみ実行可。**
- 未 deploy だと live 追加画像が refs 未登録 → 未参照誤判定 → sweep 誤削除。
- 担保: ① pre-sweep guard(refs 空 + cards に UUID key → sweep abort)② header ⚠ PREREQUISITE ③ deploy 順序(W1 deploy → backfill → reconciler)④ OT 手動実行 + dry-run 先行。
- **server-only guard**: script は `pnpm tsx --conditions=react-server scripts/...` で実行(付与しないと throw)。

## W2 の tag 扱い(削除系・重要 Fix 裏取り)

**W2(`2bec1e6`)は削除系ゆえ tag 無し commit。[reviewed] は OT の stg smoke 後に確定する(OT 指示・勝手に付けない)。**
- canonical(opus)+ Codex review は **pass 済**(Crit0/Imp0・control experiment で invariant/snapshot/cascade/self-heal 検証)。
- push 後 smoke ゆえ [reviewed] amend 窓が構造的に閉じる → **本 session doc を [reviewed] の正記録とする**(CLAUDE.md 重要Fix裏取り規律)。
- smoke pass 後、OT が本記録に「W2 [reviewed] 確定(smoke pass)」を追記 = 正式完了。

## deploy / stg smoke 手順(OT 実行・push 後)

1. push → stg deploy(**migration 0024 + W1 込み全コード**。backfill は W1 deploy 後に実行 = mixed-version 取りこぼし防止)
2. `pnpm tsx --conditions=react-server scripts/backfill-card-asset-refs.ts --dry-run`(target 分布 + invalid/cross-user key 隔離の実証)→ 本実行
3. `... scripts/gc-image-assets.ts --dry-run`(backfill 乖離検査込み)→ mark →(**stg のみ**短縮 grace で prod ガード実証)→ `--sweep` full cycle
4. smoke 項目:
   - **非存在 key への実 R2 DELETE 応答**(spec §3-2 の 2xx/404 実証)
   - 添付済み画像の誤収なし / mark→promote→sweep full cycle
   - **user 削除 → assets deleting → 優先 sweep 回収**(W2)
   - W1 後の画像添付・外し編集が引き続き通る(wire 不変)
   - 画像外し/card 削除でローカル Cache blob + media_assets 行が消える(W3・DevTools Cache/IDB 抜粋)
5. prod 反映判断 = smoke 結果を見て OT。

## 残論点(spec §5・OT 判断・実装は既定値/推奨で pin 済)

1. user 削除由来 sweep タイミング = **次回 sweep run**(推奨)/ 第一版は OT 手動。
2. backfill 直後の一斉 grace = そのまま許容(推奨・dry-run summary で観測可)。
3. 運用 runbook(頻度月次目安 / user 削除後 sweep / 失敗再実行 / 台帳確認 SQL)= G5 header + 本記録。

## DDD 監査 D-1 是正の完了

`docs/audit/2026-07-14-ddd-conformance-audit.md` の D-1(asset ライフサイクル直書き)= G2 domain 新設 + R1/G5/W2 配線で是正完了。
