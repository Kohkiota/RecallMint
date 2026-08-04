# 画像 hash dedup の実効性 fact-finding(read-only・現物確認)

**日付**: 2026-08-04 / **read-only**(実装変更なし・file:line 根拠)。
**観測(OT)**: 同一ファイルを 1 card の 3 欄へ手動添付 → R2 に別 assetId で 3 オブジェクト PUT(同一 50.66KB)。

## 結論
**hash は記録されるが照合(再利用)経路は存在しない。これは「実装が死んでいる」のではなく、spec で明示的に据え置かれた未実装機能(YAGNI)**。観測は仕様どおり。整合性・GC の実害なし・実害は R2 容量の重複のみ(受容済の deferred コスト)。

## 1. hash の記録と照合

- **記録: あり**。手動添付は `reserveAsset`(`app/(app)/app/exams/[id]/_actions/asset-actions.ts:83-115`)。client 計算の `hash` を `assets.hash` へ INSERT(`:110-113` values に `hash`)。列 = `assets.hash text NOT NULL`(`lib/db/schema.ts:834`)+ index `assets_user_hash_idx (user_id, hash)`(`schema.ts:845`)。
- **照合(再利用): なし**。`reserveAsset` は常に `crypto.randomUUID()`(`:95`)で新 assetId を採番し無条件 INSERT — **INSERT 前に hash で既存 asset を探す SELECT が無い**。
- **`assets.hash` を読む箇所は 1 つだけ** = `lib/media/crop-and-store.ts:274`(`.select({status, hash})`)/ `:286`(`if (existing.hash !== hash)`)。ただしこれは **`figureAssetId`(= crop の決定的 id)で引いた行の hash 検証**(`:276` `eq(assets.id, figureAssetId)`)であって、**content-hash で全 asset を横断検索する dedup ではない**。crop は「同じ figureAssetId → 既存 ready なら再利用・hash 不一致は loud fail」という **id ベース再利用 + hash 検証**。
- **`(user_id, hash)` で assets を絞る query はゼロ**(grep `eq(assets.hash` = 0 件)。→ `assets_user_hash_idx` は **定義済だが未使用**。
- → **手動添付経路 = 記録のみ・照合経路なし**。OCR 経由の crop 図版は「同一内容 → 同一 figureAssetId → 再利用」が効くが、これは crop の決定的 id 由来であって手動添付の content-dedup ではない。

## 2. 今回の観測は仕様どおりか → **仕様どおり(意図的 deferred)**

- image-gc spec(`docs/superpowers/specs/2026-07-13-image-gc-normalized-refs-design.md`):
  - `:16` **スコープ外(明示)**: 「dedup 分岐・blobs 物理層(many-to-many 布石のみ)」。
  - `:20` point 6: 「**dedup 据え置き**・refs は many-to-many で持つ(blobs は今作らない)」。
  - `:49`: 「many-to-many: 同一 asset_id が複数行に現れてよい(dedup 布石)。**同一 card 内の同一 asset 重複も PK 上は可**」。
- architecture §6(`docs/architecture.md:77`): 「dedup は据え置き(未実装)。refs は many-to-many で dedup 布石のみ | YAGNI(現状 dedup 分岐なし)| 決定(spec 明示)」。
- → 各添付が別 asset になるのは **意図された現行(deferred)挙動**。未完バグではなく、spec が明示的に「今は作らない」と決めた機能の不在。refs を many-to-many にしてある(= 将来 dedup で同一 asset_id を複数 ref から指せる)土台だけ置き、**再利用ロジック(hash 照合)は未実装**。

## 3. 死んだ実装 vs 布石 → **すべて布石(documented dormant)・残骸ではない**

| 対象 | 状態 | 素性 | 根拠 |
|---|---|---|---|
| `assets.hash` | 書込あり / 読取は crop の id ベース検証のみ(dedup 照合では読まれない) | **布石**(将来 content-dedup 用)| schema.ts:834 / 未使用の横断検索 |
| `assets_user_hash_idx (user_id, hash)` | 定義済・**どの query も使わない** | **布石**(将来 dedup lookup 用の index) | schema.ts:845 / grep 0 件 |
| `assets.reference_count` | default 0 で書かれず読まれず | **布石(dormant)**「将来の orphan 掃除用の枠(列のみ確保)」 | schema.ts:816/841 / asset-actions.ts:100 |
- いずれも schema/spec コメントで**将来用と明記された dormant**。単なる残骸(誰も意図しない死コード)ではない。

## 4. 影響範囲 → **整合性・GC 実害なし / 実害は R2 容量の重複のみ**

- **R2 容量**: 同一内容が N 欄で N オブジェクト。実在するが image dedup は**意図的 deferred**ゆえ受容済 YAGNI コスト。card 画像は表示用で保持(source と違い purge 対象外)。
- **card_asset_refs 整合**: 各 asset は独立行 + 独立 ref。spec `:49` が「同一 card 内の同一 asset 重複も PK 上可」と many-to-many を明示。**整合性問題なし**(各欄 attach → 各 asset → 各 ref が正しく 1:1 対応)。
- **GC 判定**: 各 asset 独立に `card_asset_refs` 参照カウントされる。1 欄削除 → その ref 消滅 → その asset が refs=0 で**独立に GC**。重複 asset は別々に回収され、**GC 整合性の問題なし**。
- → **実害 = R2 の内容重複のみ**(容量)。整合性・GC・表示の実害は無い。

## 付記(混同回避)
- **source(OCR 元画像)の content-hash dedup**(`source_assets.content_hash`)は別物 = ②-5 予定だったが、**新軸(source 非保持=著作物・2026-08-03 OT)で保持しない以上、source dedup は前提が崩れ moot**(todo v48 §0.5 新軸 follow-up に記録済)。本 fact-finding は **card 画像(assets)dedup** の話で、こちらは image-gc spec の deferred。
