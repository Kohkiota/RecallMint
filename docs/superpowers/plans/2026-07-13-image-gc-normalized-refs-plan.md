# 画像 GC v2(card_asset_refs 正規化 + 状態ベース遅延 GC)実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: spec v2(`docs/superpowers/specs/2026-07-13-image-gc-normalized-refs-design.md`・承認済 = 正本)を実装する。参照の正規化(card_asset_refs)+ 状態ベース遅延 GC(mark/promote/sweep)+ user 削除の soft 化 + D-1 domain 化。

**Architecture**: G(additive・挙動不変)→ R(配線 refactor・挙動不変)→ W(挙動変更・risk task 隔離)。migration は refs table 1 本のみ(state 拡張は text 列ゆえ DDL 不要)。wire(images payload / error code / HTTP status)は全 phase を通じ不変。

## 全体ルール(全 task に適用・task 内で再掲しない)

- **正本 = spec v2**。設計判断(anchor 12 点・§4 の契約)を蒸し返さない。実装前提(tx 境界 / cascade 経路 / 既存 `eq('ready')` の state gate)は spec §3 の裏取り済事実を引用する。
- **TDD + test 非真空**: 失敗系は実際に失敗を起こす(`mockRejectedValueOnce` / 実 rollback / 実 INSERT)。「mock が呼ばれたことだけ」の test を書かない。
- **review**: 各 feat task = canonical(requesting-code-review 経路)→ Codex(codex-review.sh)→ Critical 0 / Important 0 で [reviewed] commit。W2 のみ「重要 Fix 裏取り」(削除系)適用 = tag 無し commit → OT 確認後 amend(未 push 時)or session doc 正記録。
- **per-task gate**: 全 task = 関連 test + lint。G1(schema)= **full test + Group I invariant test + build**(Sprint 2 教訓: schema 変更は無関係機能を壊しうる)。W1/W2 = full test。server 境界を触る task(G3/R1/W1/W2)= build。
- **完了記録**: 各 task 完了時に HEAD SHA + 次 task の再スキャン箇所を記す(F3 の型)。
- **DB 接続規律**: script(G4/G5)は単一接続 + finally で確実 teardown(Supabase 共有 pool 15 を食わない)。
- **判別・語彙**: assetId 判別は `isAssetKey`(`lib/validation/card.ts:88`)を import(再実装禁止)。status 語彙の SSoT = G2 の domain module(全 task がそこから import)。
- **sprint 完了 gate**: whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / full test 全 exit 0 + `pnpm install --frozen-lockfile`(migration を触る sprint)。

---

## Phase G(additive・挙動不変)

### G1: card_asset_refs migration + schema 定義

- **目的**: 参照正規化の受け皿。spec §4.1 の schema を drizzle に定義し migration(0024)を生成する。
- **制約**: 列 = `card_id uuid NOT NULL FK→cards ON DELETE CASCADE` / `asset_id uuid NOT NULL FK→assets ON DELETE RESTRICT` / `user_id uuid NOT NULL`(CLAUDE.md Clerk-3・card_tags 前例)/ `field_key text NOT NULL` / `ordinal integer NOT NULL`。PK `(card_id, field_key, ordinal)` + `INDEX(asset_id)`。schema.ts コメントに ①「GC 権威・cards.images は wire/表示(二重持ち・legacy 非 UUID entry は配列のみ)」②「**images を書く経路を増やす時は refs 同期必須**(現状 handleImages 単一点)」(Codex 論点 1)③「ordinal は同 field_key 内順序のみ・target 横断の元配列順は保存しない」(Codex 抜け 11)を明記。DDL 実行はしない(migration file 生成まで)。
- **完了条件**: migration SQL が spec §4.1 と一致 / schema.ts 型 export / **full test green + Group I invariant test green + build 通過**(per-task gate)/ [reviewed]。

### G2: asset-state domain module(§4.9・D-1 是正)

- **目的**: 状態機械の SSoT。`lib/media/domain/asset-state.ts`(pure・I/O なし)に遷移表(`reserved→ready→deleting→deleted`)・遷移ガード(finalize 可否 = reserved のみ / ready は冪等 no-op)・`isSweepEligible(unreferencedAt, graceDays, now)`・orphaned set/clear 判定・`deleting`/`deleted` の意味論を定義。
- **制約**: CLAUDE.md 設計方針(DDD)準拠(pure・test 厚く)。既存 import 境界 lint(eslint.config.mjs の no-restricted-imports + allowlist)に domain module を登録(DDD 純度規律・route/component からの直 import 制御は既存 domain 前例に倣う)。この時点で runtime import はゼロ(配線は G5/R1/W2)。
- **完了条件**: 遷移表・ガード・isSweepEligible 境界値(grace 前後・NULL)・set/clear 判定の unit が厚い / 境界 lint green / [reviewed]。

### G3: R2 deleteObject seam + integration_failures catalog entry

- **目的**: R2 物理削除の唯一の口(spec §4.6・前 spec 流用)。
- **制約**: `lib/storage/r2.ts` に `deleteObject(objectKey): Promise<{ ok: boolean; status: number | null }>`。2xx/404 = success-equivalent・never-throw(headObject と同じ正規化)・`AbortSignal.timeout(10_000)`・module 共有 client の `retries: 0` 継承。`INTEGRATION_FAILURE_CATALOG` に `r2_gc_delete`(`service:'r2' / operation:'object.delete' / workflow:'asset_gc' / failureCode:'external_api_error'`)を追記(既存 tuple の rename なし)。
- **完了条件**: 4 様 test(2xx / 404 / 5xx / fetch throw を実際に発生させる)/ catalog entry の 4 軸値 test / [reviewed]。

### G4: backfill script(`scripts/backfill-card-asset-refs.ts`)

- **目的**: 既存 cards.images → refs の一括射影(spec §4.10)。reconciler 運用開始の前提。
- **制約**: backfill-clerk-metadata.ts 前例(DI-testable core + CLI wrapper・prod は OT 手動)。射影 = `isAssetKey` true entry のみ・`field_key = target` verbatim・`ordinal` = 同 target 内配列順。**再実行安全 = card 単位の DELETE→INSERT 全置換(W1 と同型)— 「消えた refs も消える」を保証**(Codex 抜け 3)。**UUIDv4 形式だが assets に不在 / 非 ready の key は skip + summary 隔離(`missingAssetIds` / `nonReadyAssetIds`)— FK で本実行が落ちる前に検出**(Codex 抜け 1)。`--dry-run` = write ゼロ + target 分布 summary(fact-finding B の「question_text のみ」推定の実証)。`--user` filter。単一接続 + teardown。
- **完了条件**: 射影正しさ(legacy 非 UUID 除外 / field_key / ordinal)・card 単位全置換の再実行安全・invalid key の skip + 隔離 summary・dry-run write ゼロの unit(DI core)/ [reviewed]。

### G5: reconciler script(`scripts/gc-image-assets.ts`)— G2/G3 依存

- **目的**: mark / promote / collect の GC 本体(spec §4.4/§4.5)。
- **制約**: 判定は G2 domain 関数を import。mark = orphaned set/clear の 2 UPDATE(EXISTS/NOT EXISTS)。promote = 単文 UPDATE(grace 超 + 参照ゼロ + `IN('reserved','ready')`)。collect = **ループ直前に refs を fresh 再読して参照集合を作り直す**(claude.ai 精緻化 2 = mark/promote 時点の判定を信用しない・TOCTOU 窓を collect ループ長へ縮小)→ per-asset に「refs 出現 → ready 戻し + orphaned clear(self-heal)/ `deleting` → `deleteObject` → success-equivalent → `deleted` → 行 DELETE / `deleted` → 行 DELETE のみ」。R2 失敗 = 行存置 + `recordIntegrationFailure('r2_gc_delete')` + 続行(**台帳は run ごと append を許容 = Sprint 2 既存規約・dedupe しない**、Codex 抜け 10)。CLI = `[--sweep] [--user] [--dry-run] [--grace-days N]`。**`--grace-days` の prod 誤爆ガード = `VERCEL_ENV`/`NODE_ENV` production では既定 30 未満を拒否**(nit・in-flight/offline-pending の全収防止)。summary = spec §4.5 の項目 + **reclaimed `(assetId, objectKey)` 一覧**(forensic・nit)+ **DB 行 DELETE 失敗の assetId 付き明示 + logger.error**(Codex 抜け 5)+ **未知 status 行の警告**(CHECK なしの防衛・Codex リスク 6)+ **dry-run 時のみ backfill 乖離検査**(cards.images 内 UUID key 総数 vs refs 行数 — 乖離大 = backfill 漏れ疑いの観測材料。毎 run の jsonb 全読は本末転倒ゆえ dry-run 限定、Codex 抜け 4 の縮小採用)。単一接続 + teardown。
- **完了条件**: mark set/clear / promote grace 境界 / collect 3 遷移の **crash 再開を state から実検証**(`deleting` 発見 → R2 再叩き・`deleted` 発見 → 行 DELETE のみ)/ R2 失敗は `mockRejectedValueOnce` で実発生 → 行存置 + 台帳呼出 / self-heal は **refs を実 INSERT** して ready 戻しを検証 / DB DELETE 失敗(RESTRICT 含む)が summary に assetId 付きで出る / dry-run write ゼロ / prod ガード / [reviewed]。

## Phase R(挙動不変 refactor)

### R1: asset-actions の遷移判定を domain へ置換

- **目的**: §4.9 の配線(D-1 是正の本体)。finalize の「reserved からのみ遷移 / ready は冪等 no-op」判定を G2 の domain 関数呼出に置換。
- **制約**: 挙動不変(wire・error message・冪等挙動を変えない)。**既存 asset-actions test green(無修正)= 回帰の正**。resolve は変更しない(spec §3-4: 既存 `eq('ready')` が state gate — この invariant を asset-actions のコメントに 1 行明文化)。
- **完了条件**: 既存 test 無修正 green / **resolve・handleImages が `deleting`/`deleted` を返さない・弾く明示 test を追加**(既存 `eq('ready')` 依存の pin・Codex 抜け 8)/ domain 関数の runtime import が発生(G2 の「import ゼロ」解除)/ build 通過 / [reviewed]。

## Phase W(挙動変更・risk task・独立 review)

### W1: handleImages の refs 全置換 seam

- **目的**: 参照正規化の書込点(spec §4.3)。cards.images SET と同一 per-mutation tx(spec §3-1 裏取り済)で refs を DELETE → bulk INSERT。
- **制約**: 順序 = zod + ready 検証(既存・不変)→ refs DELETE(card_id + user_id)→ `isAssetKey` true entry の射影 INSERT → images SET。**設計判断の一筆を task 完了記録に残す(claude.ai 精緻化 1)**: 全置換 vs 受信↔現行の diff 差分 — 全置換を採る。根拠 = card あたり画像 ≤10(imagesSchema.max(10))で書換コスト極小 / INDEX(asset_id) 更新も同規模 / 同 tx 内で refs を読む他経路なし(読者は GC のみ)/ diff は取得 SELECT + 集合比較の複雑性だけ増やし原子性を弱める。
- **完了条件**: tx rollback で配列と refs が**揃って**巻き戻る(実 rollback を起こす)/ ready 検証 fail 時に refs 不変 / legacy 非 UUID が refs に入らない / **cross-tenant 整合 test = 他 user の ready asset key を含む payload が reject され refs が作られない**(ready 検証の userId scope が refs の tenant 整合を保証する invariant の明示 pin・Codex 抜け 2)/ **wire 契約不変 = golden snapshot 更新ゼロ + 既存 contract test 無修正 green**(挙動不変の証明)/ full test / build / [reviewed]。

### W2: user 削除の deleting 置換(重要 Fix 裏取り対象)

- **目的**: spec §4.8。`handle-clerk-event.ts:200` の `tx.delete(assets)` → `tx.update(assets).set({ status: 'deleting' })`(G2 の語彙を import)。優先 sweep lane の入口。
- **制約**: **tx 順序 note(claude.ai 精緻化 3)**: 同一 tx 内の `exams DELETE` の FK cascade(→cards→refs)は **statement 実行時に同期発火**し、commit 原子性により「assets deleting だが refs 残存」は tx 外から観測されない(万一の残存も sweep の fresh 再読 + RESTRICT が防衛・実害は次 run 収束)— この確認を実装 note に記載。**self-heal 非発生 note(Codex 抜け 6)**: user 削除由来の `deleting` asset は refs 発生源(その user の cards)が同 tx で全滅 + 認証も失効済ゆえ、collect の self-heal(refs 出現 → ready 戻し)は構造上起き得ない — この理由を handler コメントに 1 行(起き得ない分岐の test は書かない = 簡潔性規律)。Group I invariant test(`route.test.ts:286, :833`)の期待集合を更新(assets = 明示 DELETE → 明示 UPDATE)+ **なぜ assets だけ soft か**のコメント(object_key 保全 + GC 合流)を handler と test 両方に。GDPR note(**即時不可視(PII scrub + 取得権限失効)と物理削除完了(次 sweep)を分けて明記**・Codex リスク 5)。
- **完了条件**: deleting UPDATE 化 / refs cascade 消滅 test(exams DELETE 後に refs 0 行を実検証)/ invariant test 更新 green / full test / build / **削除系ゆえ commit は tag 無し → OT 確認(stg smoke)後に [reviewed] 確定**(CLAUDE.md 重要 Fix 裏取り・smoke 後 amend 窓が閉じる場合は session doc 正記録)。

### W3: ローカル Cache blob 即時掃除 hook(spec §4.7)

- **目的**: 「消えうるキャッシュ」の即時掃除。画像外し編集(`card-image-gallery.tsx` handleDelete)と card 削除(単票 `delete-card-button.tsx` / bulk `use-bulk-card-delete.ts`)の client 2 経路で `deleteAssetBlob(userId, assetId)` + `media_assets.delete(assetId)` を best-effort 実行(abandonUpload の既存 cleanup ペアと同型)。
- **制約**: 失敗は握る(表示は resolve → R2 再取得で成立)。card 削除経路は削除前に mirror の `card.images` から `isAssetKey` true の key を収集してから物理削除(順序注意 — 削除後は読めない)。R2/DB の grace とは独立(spec I 相当・dedup 実在化後も安全 = 最悪 1 回 re-fetch)。exam 削除等の他経路は対象外(spec §4.7 の 2 経路指定)。
- **完了条件**: 2 経路で cleanup が呼ばれる test(失敗握りも実 reject で検証)/ mirror 収集の順序(削除前読取)test / 既存 delete UI test 無修正 green / [reviewed]。

---

## Deploy / stg smoke 順序(nit・OT 実行)

1. push → stg deploy(migration = refs table + **W1 込みの全コード**。**backfill は W1 deploy 後に実行** — W1 前の images 更新は refs に反映されず backfill 済みでも取りこぼすため・Codex 抜け 9)
2. stg で `pnpm tsx --conditions=react-server scripts/backfill-card-asset-refs.ts --dry-run`(target 分布 + invalid key 隔離の実証)→ 本実行(**`--conditions=react-server` は server-only guard 回避の必須フラグ**・seed-perf-exam.ts 前例)
3. reconciler `--dry-run`(backfill 乖離検査込み)→ mark → **短縮 grace は stg のみ**(prod ガードの実証を兼ねる)→ `--sweep` full cycle(同じく `--conditions=react-server` 必須)
4. smoke 項目: 添付済み画像の誤収なし / 非存在 key への実 R2 DELETE 応答(2xx or 404 の実証・spec 不明の解消)/ user 削除 → deleting → sweep 回収 / W1 後の画像添付・外し編集が引き続き通る / 画像外し・card 削除でローカル Cache blob + media_assets 行が消える(W3・DevTools で Cache/IDB 抜粋)
5. prod 反映判断 = OT
6. **運用 runbook(軽量・Codex 抜け 7)**: G5 script header + sprint 完了記録に「頻度目安 = 月次 / user 削除後は OT が sweep を打つ / 失敗時は再実行(反復収束)/ integration_failures の確認 SQL」を記載。独立 doc にはしない(cron 導入時に正式化・YAGNI)。

## Sprint 完了 gate

- whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / full `pnpm test` 全 exit 0(報告に「whole-repo lint exit 0 確認済」明記)
- `pnpm install --frozen-lockfile` exit 0(migration sprint)
- 全 feat commit に [reviewed](W2 のみ裏取り規律に従う)
- 完了報告に本 plan の task 別 HEAD SHA 一覧
