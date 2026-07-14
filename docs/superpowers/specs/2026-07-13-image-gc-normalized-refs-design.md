# 画像 GC design spec v2 — card_asset_refs 正規化 + 状態ベース遅延 GC

- **日付**: 2026-07-13(起草 2026-07-14)/ HEAD = `develop` `e741f1f`
- **Supersedes**: `docs/superpowers/specs/2026-07-13-image-gc-design.md`(配列 scan 前提)。前 spec の Step 0 確定事実・R2 seam・catalog entry・ローカル Cache 即時掃除・**§4.9 D-1 domain 化(OT 承認済)は本 spec に引き継ぐ**。
- **性質**: spec のみ(plan・実装・migration 実行・挙動変更なし)。完成後停止・OT + claude.ai レビュー待ち。
- **入力**: fact-finding = `docs/audit/2026-07-13-card-asset-refs-normalization-factfinding.md`(A-F)+ `docs/audit/2026-07-13-image-gc-factfinding.md` + `docs/audit/2026-07-13-image-delete-sync-factfinding.md`。あるべき姿 = GPT cross-check + claude.ai 一致(状態ベース遅延 GC / 参照正規化 / cascade 消滅 / 即時性は参照・取得権限・ローカル Cache に限定 / R2 物理は grace 後非同期)。

---

## §1 目的 / スコープ

**目的**: 参照を server 側で正規化(`card_asset_refs`)し、card/exam/user 削除・画像外し編集のどの経路でも参照行が cascade / 全置換で消える構造にした上で、状態ベースの遅延 GC で R2 実体と assets 行を回収する。即時に効くのは「カード参照の消滅・取得権限の失効・ローカル Cache blob の掃除」。R2 物理削除は grace(30 日)後の非同期回収。

**スコープ**: ① `card_asset_refs` table 新設(migration 1 本)+ handleImages の同 tx 全置換 seam ② 既存データ backfill script ③ assets state 拡張(`deleting`/`deleted`・DDL 不要)④ GC reconciler(mark/sweep・手動・dry-run)⑤ R2 DELETE seam + integration_failures catalog(前 spec 流用)⑥ user 削除の assets 行 soft 化(明示 DELETE → `deleting` 遷移)⑦ ローカル Cache 即時掃除 hook 2 箇所(前 spec 流用)⑧ **asset ライフサイクルの domain 化(D-1 是正・前 spec §4.9 引き継ぎ)**。

**スコープ外**(明示): cron/scheduled(手動第一版。将来 = Vercel Cron + CRON_SECRET)/ dedup 分岐・blobs 物理層(many-to-many 布石のみ)/ per-option gallery の option 削除時 entry 掃除(現状データ無し)/ 配列廃止・cards.images 列 drop(二重持ち維持)/ Cloudflare Images Transformations / サムネ R2 保存 / server-side 画像検証。

## §2 確定前提(OT + claude.ai 確定・再オープンしない)

**あるべき姿**: 1. 状態ベース遅延 GC(即時 = 参照 + 取得権限 + ローカル Cache のみ・R2 物理は grace 後非同期)2. 参照は `card_asset_refs` へ正規化(GC 権威)・cards.images は wire/表示として残す = **二重持ち**(legacy OCR entry が refs 格納不可のため配列廃止は不完全)3. client 同期プロトコル不変(whole-array 全置換・server 受信時に同 tx で refs 全置換・書き手 = handleImages 実質単一点)4. cascade 方針 = refs→cards **CASCADE** / refs→assets **RESTRICT** / users→assets は既存のまま(単純 cascade に依存しない)5. grace = **30 日**・手動 mark/sweep(dry-run 付き)第一版・R2 DELETE 先 → 2xx/404 = success-equivalent → DB 掃除(decouple)・失敗 = integration_failures(`r2_gc_delete`)6. dedup 据え置き・refs は many-to-many で持つ(blobs は今作らない)7. assets `status` に `deleting`/`deleted` 追加(text・CHECK なし = DDL 不要)・orphaned_at = 既存 `unreferenced_at` 流用(rename しない)。

**論点裁定**: ① resolve 追加条件 = state のみ(refs EXISTS は課さない)② user 削除由来 = grace 一律でなく優先 sweep ③ 'reserved'→'pending' rename しない ④ refs 列 = 初版から `(card_id, asset_id, field_key, ordinal)` ⑤ backfill = 別 script(migration 内 SQL にしない・dry-run 付き)。

**前 spec からの流用事実**(再導出しない): create-with-images 経路不存在 / OCR キー非 UUIDv4 = GC 非対象 / R2 DeleteObject: Cloudflare 実装済 ✅ + AWS S3「object 不在でも 204」明文(前 spec §3-2 引用)/ swept 後 flush = poison mutation と UI 回復経路 / backfill-clerk-metadata.ts の script 前例。

## §3 Step 0 最終確認結果(現 HEAD 実コード)

1. **tx 同居 = 可**: `processMutation`(`app/api/entity-mutations/bulk/route.ts:97-145`)は `db.transaction(async (tx) => …)` で registry 検索 → zod → 冪等 check → `entry.apply(tx, …)` を包む。`handleImages` はこの tx を受けるため、cards.images SET と refs DELETE→INSERT は**同一 per-mutation tx に同居**でき、片方成功・片方失敗は tx rollback で構造的に発生しない。
2. **cascade チェーン = 発火する**: `cards.examId → exams.id ON DELETE cascade`(`schema.ts:300-302`)。refs→cards CASCADE を張れば、exam 削除(`delete-exam.ts:87-89` の exams DELETE)・user 削除(`handle-clerk-event.ts:190` の exams DELETE)の双方で **exams→cards→card_asset_refs** が FK レベルで連鎖消滅する(apply 非経由の cascade 穴が構造解消)。
3. **assets に cards/exams FK なし = 再確認**: migration 0023 + `schema.ts:820-822`(FK は user_id→users のみ)。参照は refs 経由のみで繋がる。
4. **(導出)取得権限失効と新規参照禁止は既存 WHERE が充足**: `resolveAssetUrls` は `eq(assets.status,'ready')`(`asset-actions.ts:210`)、`handleImages` の asset 実在検証も `eq(assets.status,'ready')`(`card-field-handlers.ts:183`)。**`deleting`/`deleted` に遷移した瞬間、両者から自動的に除外される** — 論点裁定①(resolve = state 条件)は**コード変更なしで成立**(spec はこの既存 WHERE を invariant として明文 pin するのみ)。

## §4 設計

### §4.1 card_asset_refs schema(migration 新規 1 本)

```
card_asset_refs (
  card_id   uuid NOT NULL REFERENCES cards(id)  ON DELETE CASCADE,
  asset_id  uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  user_id   uuid NOT NULL,           -- CLAUDE.md Clerk-3(全 table user_id)・card_tags 前例
  field_key text NOT NULL,           -- images entry の target verbatim('question_text' / 'option:<optionId>')
  ordinal   integer NOT NULL,        -- 同 field_key 内の配列順(添付順)
  PRIMARY KEY (card_id, field_key, ordinal)
)
+ INDEX (asset_id)                   -- 参照判定 NOT EXISTS / RESTRICT 検査の probe
```

- many-to-many: 同一 asset_id が複数行に現れてよい(dedup 布石)。同一 card 内の同一 asset 重複も PK 上は可(ordinal が異なれば)— images 配列の実態をそのまま射影する。
- GC は `card_id`/`asset_id` のみ参照。`field_key`/`ordinal` は将来(配列廃止・per-option gallery・表示再構築)の布石で、**復元可能な今のうちに埋めておく**(裁定④・backfill コスト同一)。
- 判別: refs 行を生成するのは `isAssetKey(key)`(UUIDv4 厳密・`lib/validation/card.ts:88`)が true の entry のみ。legacy OCR entry(非 UUID)は refs に**入らない**(配列にのみ存在し続ける = 二重持ちの非対称は意図的)。

### §4.2 assets state 拡張(DDL 不要)

- `status` の値域: `reserved → ready`(既存)に **`deleting` / `deleted`** を追加。text 列・CHECK なし(migration 0023 確認済)ゆえ**DDL 変更なし**(語彙はコード側 SSoT = §4.9 domain module)。
- **`deleting`** = 回収確定(取得権限失効・新規参照不可 — §3-4 のとおり既存 `eq('ready')` が自動排除)。入口 2 つ: (a) sweep の promote(orphaned_at が grace 超 + 参照ゼロ再確認)(b) user 削除(§4.8)。
- **`deleted`** = R2 物理削除完了の crash マーカー。sweep は per-asset に「R2 DELETE(success-equivalent)→ `UPDATE status='deleted'` → `DELETE` 行」の順で進み、途中 crash しても次 run が状態から再開できる: `deleting` で発見 → R2 再 DELETE(404 = 成功)から / `deleted` で発見 → R2 は済ゆえ行 DELETE のみ。**反復実行で end-state 収束**(前 spec I-3 の具現)。
- **deletion 由来の専用 flag 列 = 持たない(確定形)**: 通常 lane も user 削除 lane も「`deleting` になったら即 sweep 適格」で合流するため、由来の区別は回収動作に影響しない(区別が要るのは観測のみ → summary 出力と logger context で足りる)。列を増やさない(YAGNI)。

### §4.3 handleImages の refs 全置換 seam(atomicity invariant)

`handleImages`(`card-field-handlers.ts:168-190`)の `updateCardField` と同一 tx 内に追加:
1. 受信配列の zod + ready 検証(既存・不変)
2. `DELETE FROM card_asset_refs WHERE card_id = ? AND user_id = ?`
3. 受信配列から `isAssetKey` true の entry を (field_key = target, ordinal = 同 target 内連番) で射影して bulk INSERT
4. `updateCardField`(既存の images SET)

- **invariant**: 2-4 は同一 per-mutation tx(§3-1)。配列と refs の drift は「tx を破る書き手」が現れない限り構造的に発生しない(書き手単一点 = fact-finding A-1)。
- refs→assets の FK が INSERT 時の asset 実在を DB レベルでも保証(ready 検証の二重防衛・追加コストなし)。
- OCR bulk insert(`saveExtractedCards`)は非 UUID キーのみゆえ refs 生成不要(現データフロー)。将来 UUID を運ぶ経路が生まれたらそこにも同射影を足す(spec 注記のみ)。

### §4.4 GC reconciler(mark / promote / sweep)

**参照判定は SQL**(full-scan 解消 = 正規化の回収): 未参照 = `NOT EXISTS (SELECT 1 FROM card_asset_refs r WHERE r.asset_id = a.id)`。

**mark run**(set/clear・書込は orphaned_at のみ):
```sql
-- set: 参照ゼロ + 未マーク(reserved/ready とも同一規則・前 spec I-4 踏襲)
UPDATE assets a SET unreferenced_at = now()
 WHERE a.status IN ('reserved','ready') AND a.unreferenced_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM card_asset_refs r WHERE r.asset_id = a.id);
-- clear: 再参照(self-heal)
UPDATE assets a SET unreferenced_at = NULL
 WHERE a.unreferenced_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM card_asset_refs r WHERE r.asset_id = a.id);
```

**sweep run**(mark 実行後に続けて):
1. **promote**(単文 = TOCTOU 最小化): `UPDATE assets SET status='deleting' WHERE status IN ('reserved','ready') AND unreferenced_at < now() - interval '30 days' AND NOT EXISTS (refs…)`。
2. **collect**: `status IN ('deleting','deleted')` の全行を per-asset 処理:
   - `deleting` → 参照ゼロを**再確認**(refs が現れていれば `ready` に戻し unreferenced_at クリア = self-heal。※`deleting` 中は handleImages が弾くため通常起きない — promote と handleImages の並走 race の防衛線)→ `deleteObject(object_key)` → success-equivalent なら `status='deleted'` → 行 DELETE。R2 失敗 = 行存置(`deleting` のまま)+ `recordIntegrationFailure('r2_gc_delete')` + 次 asset へ続行。
   - `deleted` → 行 DELETE のみ(R2 済)。
3. 行 DELETE は refs→assets **RESTRICT** が最後の防衛線(万一 refs が残存していれば DB が拒否 → 台帳でなく logger + 次 run)。

**冪等性**: mark は同入力同結果・promote は grace 条件で単調・sweep は state から再開可能。全 run が反復安全。

### §4.5 reconciler invocation 契約

```
pnpm tsx scripts/gc-image-assets.ts [--sweep] [--user <userId>] [--dry-run] [--grace-days <N>]
```
- flag なし = mark のみ / `--sweep` = mark + promote + collect / `--dry-run` = **一切 write しない**(set/clear/promote/R2 含む・予告のみ)/ `--user` = 対象限定(stg 検証)/ `--grace-days` = 上書き(既定 30・コード内定数)。
- 実装形 = backfill-clerk-metadata.ts 前例(DI-testable core + CLI wrapper・prod は OT が env 切替で手動)。
- **summary 出力**: per-user + total で `scanned / referenced / marked(set) / cleared / promoted / swept(R2 成功 / R2 404 / R2 失敗=台帳 / 行 DELETE 成功・失敗) / deleted-lane 処理数`。
- admin endpoint 化は将来 cron 導入時に検討(第一版は script のみ = 攻撃面を増やさない)。

### §4.6 R2 DELETE seam + integration_failures(前 spec §4.4/§4.5 流用・変更なし)

- `lib/storage/r2.ts` に `deleteObject(objectKey): Promise<{ ok: boolean; status: number | null }>`。2xx/404 = success-equivalent・never-throw・timeout 10s・`retries: 0` 継承。presigned DELETE 不採用。
- catalog: `r2_gc_delete: { service: 'r2', operation: 'object.delete', workflow: 'asset_gc', failureCode: 'external_api_error' }`。context = `{ assetId, objectKey, status }`。DB 側失敗は台帳に積まない(手動 run の出力で可視 + 次 run 収束)。

### §4.7 ローカル Cache blob 即時掃除(前 spec §4.7 流用・変更なし)

画像外し編集(`card-image-gallery.tsx` handleDelete)/ card 削除(単票 `delete-card-button.tsx` / bulk `use-bulk-card-delete.ts`)の client 2 経路で `deleteAssetBlob(userId, assetId)` + `media_assets.delete(assetId)` を best-effort。R2/DB の grace と独立・dedup 実在化後も安全(最悪 1 回 re-fetch)。

### §4.8 user 削除の変更(優先 sweep lane・裁定②)

- `handle-clerk-event.ts:200` の `tx.delete(assets)` を **`tx.update(assets).set({ status: 'deleting' })`** に置換(行残置・object_key 保全)。同 tx の `exams DELETE` cascade で refs は自動消滅するため、これらの asset は「参照ゼロ + `deleting`」= **grace を経ず次回 sweep で即回収**(§4.4 collect は `deleting` を無条件処理)。
- webhook critical path に外部 mutation(R2)を持ち込まない = decouple 規律に整合。取得権限は `deleting` 遷移の瞬間に失効(§3-4)。
- **Group I invariant test**(`route.test.ts:286, :833` — 11 テーブル明示 DELETE 網羅検証)の期待を更新: assets は「明示 DELETE」から「明示 `deleting` UPDATE」へ(なぜ assets だけ soft かのコメント必須 — R2 実体への手掛かり保全 + GC 合流)。
- GDPR 注記: PII scrub(email/clerkId)は即時のまま。画像実体の物理消滅は次回 sweep 依存(§5 残論点 1 の運用で担保)。

### §4.9 asset ライフサイクルの domain 化(D-1 是正・前 spec §4.9 引き継ぎ・OT 承認 2026-07-14)

- **新設**: `lib/media/domain/asset-state.ts`(pure・I/O なし・test 厚く)= 状態遷移表(`reserved → ready → deleting → deleted`)/ 遷移ガード(finalize 可否 = `reserved` のみ・冪等 = `ready` no-op)/ **promote 適格判定** `isSweepEligible(unreferencedAt, graceDays, now)` / orphaned set・clear 判定 / `deleting`・`deleted` の意味論(新規参照不可・R2 済マーカー)。**status 語彙の SSoT はこの module**(DB CHECK を張らない分、コード側で一元定義)。
- **利用側(単一定義 import)**: `asset-actions.ts`(finalize 遷移・冪等判定を置換)/ reconciler(mark/promote/collect の判定)/ `handle-clerk-event.ts`(deleting 遷移)。
- **範囲抑制**: byteSize cap・objectKey 形式・zod は入力検証ゆえ動かさない。repository 新設もしない(前 spec どおり)。

### §4.10 backfill script 契約(裁定⑤)

```
pnpm tsx scripts/backfill-card-asset-refs.ts [--dry-run] [--user <userId>]
```
- 全 cards の images 配列を読み、`isAssetKey` true の entry を (card_id, asset_id, field_key = target, ordinal = 同 target 内連番) に射影して INSERT(既存 refs は全置換 or 冪等 upsert — 実装は plan で確定、要件は「再実行安全」)。
- `--dry-run` = write ゼロ + **summary で実 DB の target 分布を実証**(fact-finding B の「事実上 question_text のみ」推定の確認を兼ねる)。
- migration 内 SQL にしない理由(記録): UUIDv4 判別 + 同 target 内 ordinal 採番は純 SQL で書きにくい / dry-run で分布実証してから本実行したい。
- 実行順序: migration(refs table)→ backfill → reconciler 運用開始。zero-user ゆえ実質空でも経路は正しく作る。

### §4.11 failure modes(明示記録)

1. **poison mutation**(前 spec §4.8-1 継承): grace 30 日超 offline 端末の images mutation は sweep 後に恒久 'failed' + pending 残置 + coalesce 巻込。主対策 = grace 30 日・回復 = 既存 UI(壊れ表示の画像を削除)。正規化で発生条件は不変(handleImages の ready 検証が弾く点は同じ)。
2. **promote と handleImages の並走 race**: `deleting` 遷移後は handleImages が弾くため新規参照は構造的に不可。窓は promote 単文と「ready 検証通過済・commit 前」の並走 tx のみ — sweep の per-asset 再確認(§4.4)+ refs→assets RESTRICT(DB 最終防衛)の 2 段で回収誤りを防ぐ。
3. **R2 失敗 / DB 失敗 / crash**: state machine(`deleting`/`deleted`)から反復再開・収束(§4.2)。R2 失敗のみ台帳。
4. **user 削除後の残置期間**: 行 + R2 実体は次回 sweep まで残る(取得権限は即失効)。運用は §5-1。
5. **backfill 前の既存 orphan**: refs が無い世界では全 asset が未参照に見える — **backfill 完了を reconciler 運用開始の前提**とする(順序は §4.10。reconciler は backfill 済み環境でのみ走らせる運用 note を script header に明記)。

### §4.12 テスト方針

- **domain(§4.9)**: asset-state pure 関数を厚く(遷移表・ガード・isSweepEligible 境界・set/clear 判定)。
- **handleImages seam**: 全置換の射影(isAssetKey 判別・field_key/ordinal 採番・legacy 非 UUID は refs に入らない)/ tx rollback で配列と refs が揃って巻き戻る / ready 検証 fail 時に refs 不変。
- **reconciler(DI core)**: mark set/clear / promote(grace 境界・参照ゼロ条件)/ collect の deleting→deleted→行 DELETE 遷移 / R2 失敗で行存置 + 台帳 / deleted lane 再開 / self-heal(refs 出現で ready 戻し)/ dry-run write ゼロ / `--user`。R2 は mock(実 API 禁止)。
- **user 削除**: assets が `deleting` UPDATE に変わる + Group I invariant test 更新 + refs cascade 消滅。
- **backfill(DI core)**: 射影正しさ・再実行安全・dry-run 分布 summary。
- **stg smoke(push 後・OT 指示)**: 非存在 key への実 R2 DELETE 応答実証(前 spec 継承)/ migration + backfill dry-run→本実行 / mark→(短縮 grace)promote→sweep の full cycle / 添付済み画像の誤収なし / user 削除→deleting→sweep 回収。

### §4.13 scale 記録

参照判定は `INDEX(asset_id)` 上の EXISTS probe = 前 spec の full-scan ceiling を**構造解消**。mark/promote は assets 全行 × index probe(現規模で瞬時)。再観測条件は assets 数十万規模のみ(実質当面なし)。

## §5 残論点(OT + claude.ai 判断・CC は推奨のみ)

1. **user 削除由来の sweep 実行タイミング**: (a) webhook 内で `deleting` 遷移後に即時 sweep を別途呼ぶ / (b) 次回 sweep run で拾う。**CC 推奨 = (b)** — webhook critical path に R2 外部呼出を持ち込まない(decouple 規律)+ 取得権限は遷移瞬間に失効済で「アクセス可能な残存」は無い。ただし第一版は手動 run ゆえ「user 削除を検知したら OT が sweep を打つ」運用 note を付す(cron 導入で自動化)。(a) を選ぶ場合も webhook 同期でなく fire-and-forget の別 invocation とすること。
2. **backfill 直後の一斉 grace 開始**: 既存 orphan(あれば)は初回 mark で一斉に orphaned_at が立ち、30 日後に一斉 sweep 適格になる。**CC 推奨 = そのまま許容** — zero-user 規模で一斉といっても件数は僅少、dry-run summary で事前観測可能、必要なら `--user` で分割。グラデーション導入(段階 grace)は YAGNI。

## §6 CC 暫定所見

**agree**: 正規化により前 spec の 3 つの構造問題(full-scan / cascade 穴 / diff 不能)が全て FK と EXISTS に置き換わる。書き手単一点(handleImages)× 同 tx 全置換 × RESTRICT 最終防衛の 3 層で drift と誤収の両方が構造的に塞がる。resolve/handleImages の既存 `eq('ready')` が state gate として無変更で機能する(§3-4)のは正規化案の低摩擦性の証左。migration 1 本 + script 2 本 + seam 1 箇所 + 置換 2 行(user 削除・finalize)に収まり、blast radius は fact-finding の見立て(小)どおり。

**disagree / caution**: poison mutation は正規化でも消えない(client の pre-image 問題は wire 不変の帰結)。grace 30 日 + UI 回復経路のセット受容は前 spec から変わらず必要。また「`deleted` 状態の行 DELETE 失敗が反復する」極端系では行が残り続けるが、summary で可視・実害なし(R2 済・参照なし・resolve 不可視)。

**不明**: R2 の非存在 key DELETE 実応答(契約は 2xx/404 両対応済・stg smoke で実証)/ 実 DB の target 分布(backfill dry-run で実証)。
