# DDD 準拠監査 — F3 完了(7890fa0)以降の全 feat/fix

- **日付**: 2026-07-14
- **範囲**: `7890fa0`(F3 Card+Tag aggregate 完了記録・2026-07-09)〜 HEAD(`f15cd15`)の 88 commits 中、コード変更を含む feat/fix 全件。docs / chore / test / ロジック不変 refactor は対象外。
- **基準(正本)**: `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` §5 の薄い DDD 原則:
  1. ドメイン規則(不変条件・状態遷移)は `lib/<context>/domain/` の pure 関数
  2. server 書込は repository / apply 層経由
  3. client は repository なし — 「pure 関数で不変条件計算 → `runOptimistic*` で書く」形を維持
  4. 共有 invariant は 1 定義を両側 import(二重実装禁止)
  5. 導入基準は「不変条件が実在するから」(YAGNI 有効 = 教科書側への過剰導入も違反)
- **契機**: CLAUDE.md への DDD 設計方針の明文化(同日追記)に伴う既存逸脱の棚卸し。

---

## 監査対象と判定

### グループ 1: Stripe downgrade decouple fix(`cb7ce29`)— **準拠**

- 変更は F1 で確立した層に正しく乗っている: clear の新しい口 `clearReservationMatching` は **`subscription-repository` に追加**(条件付き冪等 clear・0-row no-op)、price 抽出は **`domain/subscription-values`**(`extractPriceId`)、orchestration(順序反転・best-effort 化)は handler 層(`handle-stripe-event.ts`)に閉じる。
- ドメイン規則の直書き・repository 迂回なし。

### グループ 2: Sprint2 integration_failures 台帳(`f8a5db0` / `2e25f2f` / `aeab72f`)— **準拠**

- `lib/integration-failures.ts` = 横断的 audit/ops インフラ。**ドメイン不変条件を含まない**(catalog は 4 軸語彙の SSoT = const map・helper は INSERT→notifyOps dual-write)。domain 層を作らないのは基準 5(不変条件が実在しない所に層を足さない)に合致。
- 配線先(handle-stripe-event / handle-clerk-event / clerk-metadata)はいずれも handler/usecase 層 = 適切な差込点。

### グループ 3: clerk assets Group I fix(`77b2091`)— **準拠**

- user 削除 handler の明示 DELETE 集合への追加(identity context の usecase 層)。ドメイン規則なし。invariant test(route.test.ts の Group I 網羅検証)も同時更新。

### グループ 4: 画像フェーズ A + iOS/WebKit 圧縮修正 + imgdebug(media 一式・commit 多数)— **概ね準拠・逸脱 1 件 + Minor 3 件**

新 bounded context(media/asset)の建て増し。層別に:

**準拠している点**:
- **infra 分離**: `lib/storage/r2.ts`(R2 I/O・server-only)/ `lib/media/cache.ts`(Cache API)/ `webkit-detect.ts`(runtime probe)は外部 I/O を wrapper に隔離。
- **client の形**: `upload.ts` saga / `sweep.ts` / `deck-download.ts` は「計算 → `runOptimisticUpdate` / `runOptimisticMutation` で書く」= 意図 doc の client 方針(repository なし・application transaction)どおり。
- **server 書込単一点**: cards.images の書込は F3 が確立した dispatch table(`CARD_FIELD_HANDLERS.images` = `handleImages`)経由。迂回なし。
- **共有 invariant 単一定義**: `isAssetKey` / `imageEntrySchema` / `imagesSchema`(`lib/validation/card.ts:88-119`)を server apply(`card-field-handlers.ts:174`)と client(gallery / deck-download)の両側が import。二重実装なし。基準 4 の好例。
- **domain pure 関数の再利用**: `handleOptions` 等は `domain/card-rules`(`deriveCorrectAnswerIds` / `normalizeNullableTextField`)・`domain/card-tag-constraint` を import — F3 パターンが新コードでも生きている。

**逸脱(要判断・1 件)**:

- **D-1: Asset ライフサイクル規則が server action 層に直書き(domain 層なし)** — `asset-actions.ts` に reserved→ready の状態遷移(finalize の冪等判定 `:147` / `ready` 化 `:157-160`)・byteSize cap(`MAX_ASSET_BYTES :23`)・objectKey 形式(`:96-98`)・resolve の ready gate(`:210`)が同居。F1(Subscription = aggregate + state machine)の相似形なのに `lib/media/domain/`(または `lib/assets/domain/`)が無い。
  - **緩和事情**: 現状は 2 状態・遷移 1 本・ガード 1 個 = 「不変条件が実在するから導入」基準(基準 5)では薄く、今 aggregate 化すると逆に over-engineering 側に倒れる境界例。DB write 自体は server action 内の drizzle 直叩きだが、書込点は reserve/finalize の 2 箇所に限局。
  - **推奨**: **GC sprint で合流修正**。GC で status が `pending|ready|deleting|deleted` の 4 状態 + 遷移ガード(grace / 参照確認)に拡張された時点で状態機械が実在化する — その実装時に遷移規則を `lib/media/domain/asset-state.ts`(pure)へ置き、asset-actions / reconciler が両方 import する形が自然。**今すぐ独立リファクタ sprint を起こすことは推奨しない**(scope creep 禁止・簡潔性規律と整合)。
  - **→ OT 承認(2026-07-14)**: GC sprint 同梱で確定。GC spec §4.9 に要件として追記済(`docs/superpowers/specs/2026-07-13-image-gc-design.md`。card_asset_refs 版新 spec に superseded された場合も要件は引き継ぐ)。

**Minor(記録のみ・3 件)**:

- **M-1**: `MAX_ASSET_BYTES` が `asset-actions.ts:23` と `upload.ts:72` に複製(ESLint Block A の lib→app import 禁止による意図的複製・両側コメントで連動明記)。基準 4「定義は 1 つ」との軽微な緊張。共有 pure module(`lib/media/` 側の定数 file)化で単一化可能だが、2 箇所・コメント連動済ゆえ rule of three 未達。GC/dedup で 3 箇所目が出たら単一化。
- **M-2**: reserve の mime enum(`asset-actions.ts:60`)と client fallback 適格 type(`upload.ts` tryFallback の jpeg/png 判定)が「片方だけ変えると壊れる」連動二重定義(コメント明記あり)。M-1 と同種。
- **M-3**: `isAssetKey` / `imageEntrySchema` の置き場が `lib/validation/card.ts`(F3 の domain 置き場 `lib/cards/domain/` ではない)。単一定義原則は保たれており実害なしだが、「共有 invariant はどこterritory か」の流儀が validation/ と domain/ で割れている。GC sprint の asset domain 新設時に置き場方針を 1 行決めておくと良い。

### 対象外の確認

- iOS/WebKit 修正 T1-T6(`98bbab4`〜`dbf250c`)の実体は圧縮 pipeline(`compress-image-safe.ts`)・出力検証(`image-validation.ts`)・telemetry — いずれも browser API 依存の技術的品質ゲート/計測であり、**ドメイン不変条件ではない**(検証閾値 lumaVar 等は画質 heuristic)。domain 層に置くべきものは無いと判定。
- imgdebug UI(`5b30c00` 追加 → `df98cf6` 撤去)は UI 層のみ・撤去済。
- CSP 補完(`32b93f9`)は Next 設定 + infra。

---

## 総括

| 判定 | 件数 | 内容 |
|---|---|---|
| 準拠 | 大半 | Stripe fix(repository/domain 経由)・Sprint2 台帳(非 domain infra)・clerk fix・media の infra 分離 / client 形 / 書込単一点 / 共有 invariant |
| 逸脱(要判断) | 1 | D-1: Asset ライフサイクルの domain 層不在(asset-actions 直書き)— **GC sprint で状態機械実在化と同時に domain 化を推奨**(独立 sprint は不要) |
| Minor(記録) | 3 | M-1 定数複製 / M-2 mime 連動二重定義 / M-3 共有 invariant の置き場流儀 |

**結論**: F3 以降の建て増しは「DDD を無視した直書き」には**なっていない** — 確立済 context(stripe/cards/tags)への変更は全て既存層に乗っており、共有 invariant 単一定義・client の runOptimistic* 形・server 書込単一点は新 media コードでも維持されている。唯一の構造的逸脱は新 context(asset)の domain 層不在(D-1)で、これは現状の不変条件の薄さゆえ境界例 — **GC sprint(asset 状態機械の実在化)が自然な是正合流点**。CLAUDE.md への DDD 設計方針明文化(2026-07-14)により、以後の新規 context は最初から domain 置き場を判断する規律が効く。
