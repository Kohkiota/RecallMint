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

---

## 画像フェーズ A Blink(Chromium)回帰 smoke(2026-07-14・stg・Playwright MCP)

**目的**: iOS/WebKit 分岐追加で通常の Blink 経路が壊れていないか(iPad/WebKit 固有破損は OT 実機済ゆえ対象外)。
**環境**: stg.recallmint.nekotest.net / Clerk test user(komail9server+clerk_test)/ deploy = git push 済(origin/develop==local `0daab87`・dpl_EebkDBLbxY457x2MDKGXk8bNP6Vt)。Vercel が commit SHA header 非公開のため SHA 直接照合は不可、下記 telemetry schema の存在で圧縮修正コードの deploy を functional に確認。

### 結論: **Blink 圧縮経路は健全(回帰なし)**。server 側 sync は test account の広域 stuck(pre-existing・非 W1)で永続化のみ未検証。

| # | 項目 | 結果 | 根拠 |
|---|---|---|---|
| 1 | 添付基本(client 経路)| **PASS** | PNG 198KB 添付 → `image_attach` telemetry `compressionPath:"lib"`(= browser-image-compression / **WebKit 自前 pipeline 未通過**)・`output.actualType:"image/webp"` 6.8KB・presigned PUT R2 `.webp` → **200 OK**・media_assets `status:ready`・cards.images に **assetId(url 空)** |
| 2 | 表示解決 | **PASS** | 既存 5 画像すべて `blob:` objectURL・complete・naturalWidth>0・**broken なし**(presigned GET 200 → objectURL) |
| 3 | Cache API | **PASS** | cache `recallmint-media` に `/__media/{DB userId}/{assetId}` 形式・userId namespace 一貫・新 asset も収容確認 |
| 4 | over-size 拒否(署名固定)| **mechanism PASS** | PUT の `X-Amz-SignedHeaders=content-length;content-type;host` = Content-Length 署名固定を確認。実 5MiB 超 403 は real-device 担保 |
| 5 | カード同期分離 | **PASS** | entity_mutations の images update_field が **assetId のみ運搬**(hasBlob:false)・blob は Cache/R2 別チャネル(media_assets に bytes なし)|
| 6 | デッキ一括 DL | **未実施** | 下記 server-sync stuck + MCP 手数の都合で保留。real-device / 別途担保 |
| 7 | CSP | **PASS** | 全 smoke で **CSP 違反 0・console error 0**。圧縮成功 = worker + 自前 vendor lib(public/vendor)が読めた = **jsDelivr 非依存**を裏付け |

### 発見(pre-existing・非 W1・要 OT 認識)

- **この test account の outbox が広域 stuck**: add(6-key)/ remove(4-key)の images mutation が bulk で `{applied:0, failed:[...]}` = server 決定的 reject。加えて **memo/title/options/tag_option_ids/card.create/delete 等 card_asset_refs に無関係な op も含め計 38 件が全て synced 0**。
- **W1/migration 原因を棄却**: refs を触らない非 image op も stuck ゆえ handleImages/card_asset_refs 起因でない。かつ **07-12(W1 deploy 前)にも同 card の images mutation が stuck** = W1 前から蓄積した pre-existing 状態。
- **帰結**: Blink 圧縮の **client 経路は完全健全**。ただし server 永続化(images jsonb への反映・assetId が server 到達)は **outbox stuck により本 account では未検証**。W1 の server 側(refs 全置換)を clean に smoke するには **outbox 健全な別 test account(or 当 account の outbox reset)が必要**。
- residue(throwaway-stg): 添付 `ff17ac94-...webp` は R2 PUT 済だが mutation 失敗で未参照 = orphan(migration 適用後 reconciler が回収可)。local mirror は remove の楽観反映で一時 4(次 pull で 5 復帰)。

### OT へのお願い(GC v2 push 判断とは別レイヤー)

Blink 回帰は健全。GC v2 server 側 smoke(W1 refs / reconciler)を進める前に、① stg の当 test account の outbox 広域 stuck の原因(bulk が全 op を reject する状態)を確認 ② migration 0024 が stg DB に適用済か確認 — の 2 点を切り分けると、GC v2 の stg 実証が clean に回せる。

---

## GC v2 server 永続化 再 smoke(2026-07-14・migration 0024 適用後・stg)

**前提**: OT が stg DB に migration 0024(card_asset_refs)を適用(適用前は不在 = 画像 mutation 失敗の原因)。新規使い捨て account は sign-up が **Cloudflare Turnstile** で自動化ブロックされたため、**旧 account の local Dexie/Cache を wipe → 再ログイン**でクリーン outbox(pending 0 / total 0)を確保して実施(stuck 38 件は local-only ゆえ wipe で消滅・server 無傷・confound 解消)。

### 結論: **報告バグ(画像外しが server に残らず復活)は解消 = PASS**

| # | 項目 | 結果 | 根拠 |
|---|---|---|---|
| 1 | 外しの永続化 | **PASS** | 添付(9239823e)→ bulk **applied:1** → reload で server 5 反映(add 永続)→ 外し → bulk **applied:1** → reload(server 再 pull)で **4 images・9239823e 復活せず** |
| 2 | mutation 成功 | **PASS** | add / remove の entity-mutations bulk がいずれも `{applied:1, failed:[]}`(前回の card mutation rollback/mutation_failed が消失)|
| 3 | refs の効き(outcome 代替) | **PASS** | 外した後 images(assetId)が 5→4 に減り reload 後も復活しない = refs 全置換(handleImages W1)が server で効いている |
| 4 | outbox が synced 到達 | **一部** | migration 後 mutation は **applied 到達**(前回の全 failed から改善)。ただし下記の帳簿癖あり |
| - | W3 ローカル Cache 掃除 | **PASS** | 外し後、9239823e が **Cache(recallmint-media)+ Dexie media_assets の両方から消滅** |

### 補足観測(データ破損でない・要 dev 確認)

- **applied 済 image mutation が local outbox で pending のまま**: attach(56c26483)/ remove(9a501868)は bulk で applied:1(server 反映確認済)なのに、local の synced_at が未設定で pending 残存。server は正・再送は mutation_id UNIQUE で idempotent-skip ゆえ**無害**だが、これが「outbox 蓄積(旧 account の 38 件)」の機序の可能性。images 固有か全 op かは未切り分け(別途 dev 調査推奨)。migration/W1 由来かは不明(W1 は bulk 応答形を変えないため client 帳簿ロジックには非依存)。
- Turnstile により新規 account 自動作成は不可 → 旧 account wipe で代替(clean 化は達成)。真の新規 user 初回導線が必要なら人手で account 作成要。

### 判定
- **報告バグ = 解消**(migration 0024 適用が前提)。GC v2 server 永続化(W1 refs / images add・remove の server 反映)は healthy。
- 残: reconciler / R2 実体回収(grace 後)の CLI smoke は引き続き OT 実走。outbox 帳簿癖は別件 dev 調査。
