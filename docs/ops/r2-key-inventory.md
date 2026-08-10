# R2 key 棚卸し(運用)— prefix → 中身 → 作る / 読む / 消す

> **用途**: OT が Cloudflare dashboard で R2 を見ながら「この prefix は何で、消してよいか」を判断するための表。
> **設計の理由は書かない** — レーン間の契約は `docs/architecture.md` §11、機構の索引は `docs/harness.md`。
> 調査日 2026-08-10(read-only)。**listing のみ実行・DELETE / PUT は一切していない**。**prod bucket には接続していない**。

## 1. 一覧表

| prefix / key 形 | 中身 | 誰が作る | 誰が読む | 誰が消す | 残ってよいか |
|---|---|---|---|---|---|
| **`src/{userId}/{uploadSessionId}/{fileId}.pdf`** | OCR 入稿 PDF の一時保存。**DB 台帳なし**(`source_assets` 表は存在しない) | `lib/media/source-object-key.ts`(builder)← `reserve-pdf-upload.ts` が presign → **client が直 PUT**(server は PUT しない) | HEAD `finalize-pdf-source.ts` / `submit-upload.ts`。GET `upload-pipeline.ts`(count / render 相)/ `finalize-pdf-source.ts`。listing `src-sweep.ts`(prefix=`src/`)/ `handle-clerk-event.ts`(prefix=`src/{uid}/`)。**presigned GET は発行されない** | ① pipeline 出口 `finally` ② finalize reject 3 分岐 ③ `delete-pdf-source`(②-4b §1)④ 退会 purge(§2)⑤ **日次 sweeper**(§3・cron)⑥ **lifecycle**(`src/`・maxAge 86400s・OT 手動設定) | **処理中のみ**。滞留は異常 — 6h 超は sweeper が回収、72h 超残存は alert(`r2_sweep_overdue`)が毎日鳴る |
| **`users/{userId}/{assetId}.{webp,png,jpg}`** | カードへの**手動添付画像**。`assets` 表に行あり(`object_key` UNIQUE) | `asset-actions.ts` が presign → **client が直 PUT**(reserve→finalize saga) | presigned GET `asset-actions.ts`(`status='ready'` + owner scope の行のみ)。HEAD `asset-actions.ts`(finalize 検証) | **`scripts/gc-image-assets.ts` のみ**(DB `assets` 行駆動・**手動実行**・cron 配線なし) | **参照されている限り恒久**。削除は refs ゼロ → mark → grace(既定 30 日)→ promote → collect |
| **`users/{userId}/{figureAssetId}.webp`** | OCR pipeline が source から crop した**図版画像**。`assets` 表に行あり | `crop-and-store.ts` が **server 直 PUT**(条件付き PUT・first-writer-wins) | 同上(同じ `assets` 表経由の presigned GET)。GET は 412 時の再取得のみ | 同上 | 同上 |
| **`users/{userId}/src/…`**(**旧規約**) | ②-4a 期の source 一時保存(temp / 最終 immutable) | **生成コード無し**(commit `80ef3b4`・2026-08-05 で生成 3 file ごと削除) | listing `scripts/gc-src-prefix.ts` | `scripts/gc-src-prefix.ts`(手動 one-shot・既定 dry-run・`--execute` 必須) | **残ってよくない**が、**新規には増えない**。現在 0 件(§2) |

### 表を読むときの注意

- **key の形だけでは手動添付画像と crop 図版を区別できない**(どちらも `users/{uid}/{uuid}.webp` になりうる)。区別は `assets` 表の行を見る必要がある。dashboard 目視では「画像 asset レーン」として一括で扱う
- **旧 `users/{uid}/src/…` は画像 asset の prefix `users/{uid}/…` の内側に入れ子**だった。これが top-level `src/` へ移した直接の理由 — ListObjectsV2 も lifecycle も `users/*/src/` のような wildcard を持たないため、user ごとに rule が要り source だけを期限削除できなかった(`docs/audit/2026-08-07-ocr-2-4b-r2-source-retention-factfinding.md`)
- `scripts/gc-src-prefix.ts` は `--user` 無指定だと **listing prefix が `users/` 全体**になる(画像 asset も列挙する)。削除を止めているのは listing 範囲ではなく `SRC_KEY_PATTERN`(`users/{uid}/src/`)の照合。**実行時は必ず dry-run を先に**

## 2. 実 bucket の実測(`recallmint-dev`・**dev / stg 共有**・2026-08-10T02:11Z)

`listObjectsWithMetaBounded('', 30 pages)` による全 listing。

| 実在した key 形 | 件数 | 最古 | 最新 | 上表のどれか |
|---|---|---|---|---|
| `users/{uuid}/{uuid}.webp` | **242** | 2026-07-16T14:32Z | 2026-08-09T11:16Z | 画像 asset レーン(手動添付 / crop の区別は key からは不能) |
| その他 | **0** | — | — | — |

- **`src/` = 0 件**(観測時点)。`users/{uid}/src/` = **0 件**。3 セグメント以外の形 = 0 件。truncated = false(取り漏らしなし)
- user 別: `85541b25…` = 234 / `b775b3f1…` = 6 / `2ac594a5…` = 2
- **分類できない prefix は 1 件も無かった**(全 242 が画像 asset レーンに対応)

> `src/` が 0 なのは異常ではない。同日に §3 sweeper の stg smoke を実走し、cutoff 超過分を回収した直後の状態(`docs/superpowers/sessions/2026-08-09-ocr-2-4b-s3-src-sweeper.md` §5.5)。

## 3. 2 レーン契約(`docs/architecture.md` §11)との突き合わせ

| 契約の記述 | 実態 | 判定 |
|---|---|---|
| 全 object は `src/` か 画像 asset のどちらかに属する | 実 bucket は 242 件すべて画像 asset・`src/` は 0 件 | **整合** |
| `src/` = 一次削除 / 二次回収(sweeper)/ backstop(lifecycle)/ 検知(overdue alert)の 4 点を持つ | 削除主体 6 系統をコードで確認 | **整合** |
| 画像 asset = backstop 無し・滞留検知は未整備 | 削除機構は `gc-image-assets.ts` のみ、かつ **DB 行駆動**。**`assets` 行が無い R2 object を消すコードは存在しない**(全 grep で該当なし) | **整合**(契約が「未整備」と書いているとおり) |
| asset prefix に lifecycle を張らない | repo に `users/` への lifecycle 記述なし。lifecycle の記述はすべて prefix `src/` | **整合** |

### 契約に書かれていない prefix(指摘)

**旧 `users/{userId}/src/…` が §11 のレーン表に無い**。現状は生成コードが無く実在も 0 件なので実害はないが、**「全 object はどちらかのレーンに属する」という契約の網羅性は、この 3 つ目の(絶滅した)prefix を明示しない限り厳密には成り立っていない**。§11 に 1 行足すか、本 doc を参照先にするかは OT 判断。

## 4. この調査で確認できなかったこと(推測しない)

- **R2 側 lifecycle rule の実設定内容**: repo に定義も読取コードも無く(`GetBucketLifecycle` 等 0 hit)、現行 credential では rule 本体の readback が 403。上表の lifecycle 行はすべて **repo 内の記述の引用**であって設定の実物確認ではない。効果としては 2026-08-09 に sentinel 1 例で実削除を実測済(`docs/audit/2026-08-09-ocr-2-4b-s1-factfinding.md` §3.5)
- **R2 と `assets` 行の照合手段は repo に存在しない**: reconciler(`scripts/gc-image-assets.ts`)の `--dry-run` が出す backfill-divergence は `cards.images` 内 UUID key 数 vs `card_asset_refs` 行数の **DB 内比較**で、R2 を一切見ない(reconciler は listing を import しない)。row-less orphan の照合には listing 駆動の `assets.object_key` 差分取りが別途要る。なお 2026-08-10 の fact-finding が read-only probe で実施し **242 件中 row-less 0 / object-less 0** を実測(`docs/audit/2026-08-10-asset-lane-gc-factfinding.md` §0/§3)
- **prod bucket の中身**: 接続していない。OT が dashboard で目視する

## 5. 更新のきっかけ

key を生成する経路は現状 **3 本のみ**(`source-object-key.ts` / `asset-actions.ts` / `crop-and-store.ts`)。**4 本目を足す変更、または既存 3 本の key 構造を変える変更をしたら本 doc を更新する**。過去に構造が変わったのは 2026-08-05〜08-07 の 1 回だけで、その時は「lifecycle を 1 本で張れる形にする」が理由だった。
