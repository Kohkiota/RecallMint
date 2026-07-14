# 画像 GC(orphan cleanup)design spec

- **日付**: 2026-07-13
- **HEAD**: `develop` = `0bfbd61`
- **性質**: spec のみ(plan・実装・migration・挙動変更なし)。完成後停止・OT + claude.ai レビュー待ち。
- **入力**: fact-finding `docs/audit/2026-07-13-image-gc-factfinding.md`(以下 FF)+ OT + claude.ai 確定前提 9 点(§2)。
- **migration 不要**: `reference_count` / `unreferenced_at` は migration 0023 で既存(dormant)。列追加・FK 変更なし(§4.1)。

---

## §1 目的 / スコープ

**目的**: 参照されなくなった画像 asset(R2 実体 + assets 行 + ローカル Cache blob)を安全に回収する。card 削除 / 画像外し編集 / exam 削除 cascade のどの経路で参照が消えても、経路非依存に一律回収する。

**スコープ**: ① reconciler script(mark / sweep の 2-pass・手動 invoke)② R2 DELETE seam 新設 ③ integration_failures catalog 追記 ④ ローカル Cache blob の即時回収 hook 2 箇所 ⑤ **asset ライフサイクル規則の domain 化(DDD 監査 D-1 是正・2026-07-14 OT 承認で追加。§4.9)**。

**スコープ外**(将来タスク側): cron/scheduled トリガー / dedup 再利用分岐 / Cloudflare Images Transformations / サムネ R2 保存 / server-side 画像検証・re-encode / user 削除時の R2 自動掃除の自動化(§7-3)。

## §2 確定前提(OT + claude.ai 確定済・本 spec の固定入力)

1. **scan-based を軸**(incremental refcount 不採用)— handleImages は diff なし wholesale overwrite・applyCardDelete は images 不在・exam/user 削除は cascade で hook 素通り(FF §B)。scan は cards.images を読み直すので経路非依存。
2. **unreferenced_at を scan の唯一の writer に**(dormant 列活性化)。set / clear / sweep 適格の 3 遷移。write 経路(handleImages 等)は一切触らない。
3. **回収順序 = R2 DELETE(冪等)先 → 成功後に DB asset 掃除**。逆順禁止(行を先に消すと object_key を失い恒久 orphan)。R2 失敗 = 行存置 + 台帳 + 次 sweep 再試行。Sprint 1/2 decouple 規律の写像。
4. **失敗記録 = integration_failures 台帳再利用**。catalog に R2 GC 失敗の新 entry(4 軸 tuple)。DDL 不要。
5. **発火は grace 経過後のみ**(in-flight 誤収防止 + stale GET 窓縮小)。
6. **ローカル Cache blob は別ライフサイクル**。deleteAssetBlob を card 削除 / 画像外し編集から即呼び。R2/DB の grace と分離。
7. **回収トリガー第一版 = 手動 invoke の reconciler(tsx script)**。2-pass(mark / sweep)モデル。cron 化は別スプリント。
8. **full-scan 許容**(jsonb index 無し・app 側全走査)。scale ceiling として §6 に記録。
9. **dedup 再利用は据え置き・ただし dedup-ready**(scan は参照数を数え直すので N:1 実在化に無改修で耐える。eager な単一 card delete 起点の R2 delete を作らない)。

## §3 Step 0 解決結果(4 unknowns)

### 3-1. create-with-images 経路の順序と in-flight 窓

- **create が images を運ぶ経路は存在しない(確定)**: registry の `applyCardCreateWithId`(`lib/cards/apply-card-mutation.ts:88-104`)は INSERT values に `images` を含まない(DB default `'[]'`)。images は attach の後続 `update_field` でのみ入る。OCR bulk insert(`process.ts:376`)の images は `"q{sort_key}-img-{連番}"` 形式(`lib/ai/prompts/ocr-extract.ts:132-133`)= 非 UUIDv4 → `isAssetKey` false → **scan の参照抽出にも GC 対象にも入らない**(FF の「不明」を確定に昇格)。
- **in-flight 窓(server 視点)**: reserve(assets 行 'reserved')→ 直 PUT(timeout 60s)→ finalize('ready'・HEAD timeout 10s)→ client flush(finalize 直後に trigger)→ handleImages が cards.images に反映。online happy path は**数分以内**。異常系:
  - **PUT/finalize 失敗 → abandonUpload** → server 'reserved' 行は恒久 orphan(既存 spec §3.4 の既知事項)。**再参照される経路が構造的に無い**(handleImages は ready のみ通す・retry は fresh reserve)→ grace 経過後に安全に回収可。
  - **finalize 後 offline** → images mutation の flush が無期限遅延 = 'ready' かつ未参照が unbounded に継続。**grace では完全に防げない**(残余リスク、§4.8-1)。
- **swept 後に lagging 端末が flush した場合**: handleImages の ready 検証で 'failed' → client は「失敗分は pending 残置(次回 flush で再試行)」(`lib/sync/entity-mutations.ts:343`)= **恒久 failed の poison mutation 化**。さらに同 card の以後の images 編集は coalesce(同 field key)で同じ stale key を含み続け、その端末からの images 更新が全て失敗する。**回復経路は既存 UI に存在**: 壊れた entry はサムネ「画像を取得できません」表示になり、ユーザーが削除すると stale key が外れて次 flush が成功する。§4.8-1 に形式化。

### 3-2. R2 DeleteObject 冪等性(公式 doc 引用)

- Cloudflare R2 S3 互換 API: **DeleteObject は実装済(✅)**(developers.cloudflare.com/r2/api/s3/api/ の object-level operations 一覧。未実装は x-amz-mfa / Object Lock 系等の付帯 header のみ)。非存在 key の挙動は R2 doc に明記なし。
- AWS S3 API Reference(API_DeleteObject): 「If the action is successful, the service sends back an HTTP 204 response.」。加えて conditional delete の記述に「**If the Timestamp matches or if the object doesn't exist, the operation returns a `204 Success (No Content)` response**」— S3 の DELETE 成功モデルが「object 不在 = 204 成功」を含む明文。
- **設計上の確定**: seam 契約(§4.4)を「**2xx および 404 を success-equivalent(end-state = 不在)として扱う**」で pin する。これにより冪等性が「非存在 key に R2 が 204 を返すか 404 を返すか」の doc 未明記部分に依存しない。実挙動(非存在 key への DELETE の実応答)は **stg smoke で確認**(§5)。

### 3-3. reconciler scope + reference_count 要否

- **scope = global(全 user)を 1 実行で・内部は per-user grouping**。根拠: `assets.userId` NOT NULL(schema.ts:820)/ R2 key namespace `users/{user_id}/{assetId}.{ext}` / 参照抽出も cards を user 単位で読むため、per-user が自然単位。`--user <id>` filter を stg 検証用に持つ。invocation 前例 = `scripts/backfill-clerk-metadata.ts`(`pnpm tsx` + `--dry-run` + DI-testable core + summary 出力 + prod 実行は OT 手動)。
- **reference_count は scan-based では判定に不要**。unreferenced_at 単独で 3 遷移(set/clear/sweep 適格)が完結する。populate は observability(SQL で参照数分布)にのみ価値があるが毎 mark 実行の追加 write を要する。**CC 推奨 = dormant 維持(YAGNI)**。dedup 導入で refcount 必須化した時に activate(§7-2 で OT 判断)。

### 3-4. FK cascade × asset 行の生存

- **exam 削除**: assets は user_id FK のみ(cards/exams への FK なし・migration 0023 + schema.ts:820-822)→ **assets 行は生存**。scan が次回実行で未参照を検出し通常ライフサイクルで回収。**ギャップなし**。
- **user 削除**: `handle-clerk-event.ts` Group I の明示 `tx.delete(assets)`(+ FK cascade)で**行が消え、R2 実体は残る**。ただしこれは**既文書化の設計判断**: 同 file コメント「行は本 DELETE で消えるが、R2 上の画像オブジェクト自体の掃除は scope 外 = 手動運用(spec §2.1: users/{user_id}/ prefix で手動削除可)。row 削除と object 削除は別レイヤー」。→ 「未知の穴」ではなく incumbent(prefix 手動掃除)が既に指定済。対処案の比較と CC 推奨は §7-3(**本 sprint では incumbent 維持を推奨**)。

## §4 設計

### §4.1 データモデル(migration 不要)

migration 0023 の既存列のみ使用。**活性化** = `unreferenced_at`(reconciler が唯一の writer)。**dormant 維持** = `reference_count`(§3-3・§7-2)。列追加・FK 変更なし。`assets_user_status_idx (user_id, status)` が sweep 候補の絞込みに既に使える。

### §4.2 invariant(形式化)

- **I-1 unreferenced_at ライフサイクル**: writer は reconciler のみ。3 遷移 = ① set(scan が参照ゼロを観測・NULL の時のみ now())② clear(scan が再参照を観測 → NULL)③ sweep 適格(`now() - unreferenced_at > grace` かつ sweep 時の再検証でも参照ゼロ)。attach/finalize/handleImages/cascade はこの列に触れない。
- **I-2 判別一致**: 参照抽出は `isAssetKey`(`lib/validation/card.ts:88`、UUIDv4 厳密)を import して使う(再実装禁止)。attach/finalize/handleImages と同一判別 → legacy OCR key(`q013-img-1` 等)は参照にも回収対象にも入らない。
- **I-3 decouple 順序**: asset 1 件の回収 = R2 DELETE → success-equivalent(2xx/404)確認 → DB 行 DELETE。逆順禁止。R2 失敗 = 行存置(unreferenced_at 保持)+ 台帳記録 + 次 sweep 再試行(R2 DELETE は success-equivalent 契約ゆえ再実行安全)。R2 成功後の DB DELETE 失敗 = 行残置 → 次 sweep で R2 DELETE(404 = 成功)→ DB DELETE 再試行 = **反復実行で end-state に収束**。
- **I-4 grace gate**: sweep は `unreferenced_at` が grace より古い asset のみ対象。'reserved' / 'ready' とも同一ライフサイクル(reserved は構造的に再参照され得ないが、規則を分けない = 簡潔性)。
- **I-5 LWW 収束・冪等**: 参照判定は毎 scan で server cards.images を読み直す(field 単位 LWW 全置換 / cascade / edit-remove を一律吸収)。scan は冪等: 同入力に同判定・set は NULL の時のみ・DELETE 済は次回スキャン対象外。**sweep は削除直前に per-asset で参照を再検証**する(mark 時点の判定を信用しない)→ mark〜sweep 間の再参照は clear に倒れ、TOCTOU 窓は秒未満に縮む(残余は §4.8-2)。
- **I-6 ローカル Cache blob 分離**: `deleteAssetBlob` + `media_assets.delete` を「card 削除」「画像外し編集」の client 2 経路から即呼び(best-effort・abandonUpload の既存 cleanup ペアと同型)。R2/DB grace と独立。dedup 実在化後も安全(ローカルは R2 から再取得可・最悪 1 回 re-fetch)。
- **I-7 dedup-ready**: 回収判定は常に scan の数え直し。単一 card delete を起点に eager R2 delete する経路を作らない。dedup で N:1 が実在化しても本 spec のロジックは無改修。

### §4.3 reconciler 2-pass アルゴリズム

mark / sweep は同一 scan core を共有する 1 script の 2 モード。

**scan core(user 単位)**:
1. `cards.images` を user の全 card から読み、`isAssetKey` で UUIDv4 key を抽出 → `referenced: Set<assetId>`(app 側 JS 抽出。jsonb SQL は使わない = FF §A3 の現構造どおり)。
2. user の `assets` 全行を読み、各行を照合:
   - 参照あり かつ `unreferenced_at IS NOT NULL` → **clear**(NULL に戻す)
   - 参照なし かつ `unreferenced_at IS NULL` → **set**(now())
   - それ以外 → 無変更

**mark run(デフォルト)**: scan core のみ(set/clear)。

**sweep run(`--sweep`)**: scan core 実行後、`unreferenced_at < now() - grace` の行を適格とし、**各 asset の削除直前に参照を再検証**(I-5)した上で:
1. `deleteObject(object_key)`(§4.4)→ success-equivalent でなければ台帳記録(§4.5)+ 行存置 + 次 asset へ続行(1 件の失敗が run を止めない)
2. 成功 → `DELETE FROM assets WHERE id = ? AND user_id = ?`

**2-pass 運用**(§7-4 で手順確定): sweep 単独の反復でも安全(初回 sweep は set のみで適格ゼロ → grace 後の次回 sweep で回収)。mark を先行させると「何が回収予定か」を sweep 前に観測できる。

### §4.4 R2 DELETE seam(`lib/storage/r2.ts` に新設)

```ts
/**
 * R2 オブジェクト削除 (GC sweep 用)。 end-state ベース契約:
 * 2xx / 404 = success-equivalent (object 不在が望む終端状態)。
 * throw しない (headObject と同じ never-throw 正規化)。
 */
export async function deleteObject(
  objectKey: string,
): Promise<{ ok: boolean; status: number | null }>
```

- 実装形: `client.fetch(objectUrl(objectKey), { method: 'DELETE', signal: AbortSignal.timeout(DELETE_TIMEOUT_MS) })`。`DELETE_TIMEOUT_MS = 10_000`(headObject と同値・CLAUDE.md AI-2)。module 共有 `AwsClient` は `retries: 0` 済(backoff が AbortSignal を観測しない問題の既存対策をそのまま継承)。
- 判定: `res.ok || res.status === 404` → `{ ok: true }`。その他 status → `{ ok: false, status }`。throw/timeout → `{ ok: false, status: null }`。
- presigned DELETE は不採用(reconciler は server 環境で回る・browser 関与なし)。

### §4.5 integration_failures catalog entry(確定形)

`lib/integration-failures.ts` の `INTEGRATION_FAILURE_CATALOG` に 1 entry 追記(DDL 不要):

```ts
r2_gc_delete: {
  service: 'r2',            // 新 service 語彙 (catalog 追記のみ・rename なし)
  operation: 'object.delete',
  workflow: 'asset_gc',
  failureCode: 'external_api_error',
},
```

- 呼出: sweep の R2 失敗時に `recordIntegrationFailure({ key: 'r2_gc_delete', userId, errorMessage, subject: 'R2 GC: object delete failed', context: { assetId, objectKey, status } })`。
- DB 側 DELETE 失敗は台帳に**積まない**(手動 run で出力に即見える + 次 sweep 収束・I-3。台帳は「外部 op の失敗を後から SQL で引く」用途に限定 = Sprint 2 の使い分け踏襲)。

### §4.6 reconciler invocation 契約

```
pnpm tsx scripts/gc-image-assets.ts [--sweep] [--user <userId>] [--dry-run] [--grace-hours <N>]
```

- **モード**: flag なし = mark run(set/clear のみ)。`--sweep` = mark + grace 適格の回収。
- `--user <userId>`: 対象 user を 1 人に絞る(stg 検証用)。省略時 = 全 user。
- `--dry-run`: **一切 write しない**(unreferenced_at の set/clear も含む)。「何が set/clear/sweep されるか」の予告のみ出力。
- `--grace-hours <N>`: grace 上書き(stg で短縮検証用)。省略時 = コード内定数(値は §7-1 で OT 確定)。
- **出力(summary)**: per-user + total で「scanned assets / referenced / set / clear / sweep 適格 / R2 delete 成功 / R2 404 / R2 失敗(台帳記録数)/ DB delete 成功・失敗」。
- 実装形: backfill-clerk-metadata.ts 前例踏襲(DI-testable core + CLI wrapper・prod 実行は OT が env 切替の上で手動)。

### §4.7 ローカル Cache blob 回収(client hook 2 箇所)

1. **画像外し編集**: `card-image-gallery.tsx` の `handleDelete` — `removeImageFromCard` 後に `deleteAssetBlob(userId, assetId)` + `media_assets.delete(assetId)` を best-effort 実行。
2. **card 削除**: 単票(`delete-card-button.tsx`)/ bulk(`use-bulk-card-delete.ts`)の削除処理で、対象 card の `images` から `isAssetKey` な key を集めて同 cleanup を best-effort 実行。

いずれも失敗は握る(表示は resolve → R2 再取得で成立・「消えうるキャッシュ」)。exam 削除等の他経路の local blob は放置可(browser eviction / 将来 sweep 拡張の範囲、確定前提 6 の 2 経路指定どおり)。

### §4.8 failure modes(明示記録)

1. **grace 超 offline 端末の poison mutation**(§3-1): sweep 後に flush された images mutation は恒久 'failed' → pending 残置で無限再試行 + 同 card の images 編集が coalesce で巻き込まれ続ける。**主対策 = grace を十分大きく取る**(§7-1)。回復 = 該当端末で壊れ表示の画像を UI から削除。受容判断は OT。flush 失敗の分類/TTL 導入は本 sprint 外。
2. **sweep の TOCTOU 残余**: per-asset 削除直前再検証(I-5)後〜DB DELETE の秒未満窓で mutation が適用されると「R2 実体なしの参照」が成立しうる。発生条件 = grace 超 lagging 端末がその瞬間に flush(1 と同一母集団)。表示は「画像を取得できません」に落ち、回復も 1 と同じ。手動 script 規模で locking は追加しない(簡潔性)。
3. **'reserved' 恒久 orphan**(abandon 済): 同一ライフサイクルで回収(I-4)。R2 実体の有無不定(PUT 前 crash 等)は 404 = success-equivalent が吸収。
4. **R2 失敗 / DB 失敗**: I-3 のとおり反復実行で収束。R2 失敗のみ台帳。
5. **user 削除後の R2 残骸**: incumbent = prefix 手動掃除(§3-4)。本 GC の scan は行が無いため関知しない(§7-3)。

### §4.9 asset ライフサイクルの domain 化(D-1 是正・2026-07-14 追加)

DDD 準拠監査(`docs/audit/2026-07-14-ddd-conformance-audit.md` D-1)の是正を本 sprint に同梱する(OT 承認 2026-07-14)。GC で asset の状態機械が実在化する(状態・遷移・ガードが増える)ため、CLAUDE.md「設計方針(DDD)」に従い遷移規則を domain 層へ置く:

- **新設**: `lib/media/domain/asset-state.ts`(pure・I/O なし・test 厚く)。内容 =
  - 状態遷移表(現行 `reserved → ready` + GC の unreferenced ライフサイクル。将来 `deleting|deleted` を足す場合もここが唯一の定義点)
  - 遷移ガードの pure 関数(例: finalize 可否 = `reserved` からのみ / 冪等判定 = `ready` は no-op)
  - **sweep 適格判定** `isSweepEligible(unreferencedAt, grace, now)`(I-4 の grace gate を pure 化)
  - unreferenced_at の set/clear 判定(I-1 の 3 遷移を pure 関数で表現。scan core はこれを呼ぶだけにする)
- **利用側(単一定義を両側 import)**: `asset-actions.ts`(finalize の遷移・冪等判定を直書きから置換)/ reconciler(mark の set/clear 判定・sweep の適格判定)。
- **範囲の抑制**(簡潔性規律): byteSize cap・objectKey 形式・zod schema は入力検証であり状態遷移ではない — 今回は動かさない(過剰移設をしない)。repository 層の新設もしない(書込点は reserve/finalize の 2 箇所に限局しており、apply seam 化は不変条件がさらに増えた時)。
- **注記**: 本 spec が card_asset_refs 版(状態ベース遅延 GC)の新 spec に superseded された場合も、本節の要件(遷移規則 = `lib/media/domain/` の pure 関数・単一定義・両側 import)はそのまま新 spec に引き継ぐ。状態が `pending|ready|deleting|deleted` に拡張されるならなおさら domain 化が本命化する。

## §5 テスト方針

- **Unit(Vitest・DI core)**: scan core の set/clear/無変更 3 分岐 / grace 適格判定 / sweep の削除直前再検証(参照復活 → clear に倒れ削除しない)/ R2 seam の 2xx・404・5xx・throw 4 様 / R2 失敗時の台帳呼出と行存置 / DB 失敗時の行残置 / dry-run で write ゼロ / `--user` filter / legacy key(非 UUIDv4)が参照にも対象にも入らない(I-2)。R2 は mock(実 API 禁止)。
- **domain(§4.9)**: `asset-state.ts` の pure 関数を厚く(遷移表・finalize ガード/冪等・`isSweepEligible` 境界値・set/clear 判定)。asset-actions の finalize が domain 関数経由でも既存挙動不変(既存 asset-actions test green を回帰の正とする)。
- **client hook**: 画像外し / card 削除で `deleteAssetBlob` + `media_assets.delete` が呼ばれる・失敗握り。
- **stg smoke(push 後・OT 指示で)**: ① 非存在 key への実 R2 DELETE の応答確認(§3-2 の未明記部分の実証)② `--dry-run` → mark → `--grace-hours` 短縮 sweep の full cycle ③ 添付済み画像が誤収されない(referenced 温存)。

## §6 scale ceiling(記録)

full-scan = 全 user の cards.images 読出し + assets 全行照合。現規模(数百 card × ≤10 images・zero users)で無問題。**再観測条件**: cards 数万規模 / assets 数千規模、または reconciler 実行が分単位化した時点で jsonb path index / 増分化を再検討(FF §A3 の join コスト繰越と同扱い)。

## §7 未確定論点(OT + claude.ai 判断・CC は推奨のみ)

1. **grace duration**: CC 推奨 = **168h(7 日)** をコード内定数の初期値に。根拠: in-flight happy path(数分)と presigned TTL(600s)は余裕で吸収し、週次利用端末の offline 窓をカバー。24h は週末 offline 端末で poison mutation(§4.8-1)を踏みやすい。過大側の害 = orphan 滞留日数のみ(storage コスト微小)。
2. **reference_count**: CC 推奨 = **dormant 維持**(scan-based では判定不要・observability 価値 < 毎 run の追加 write と未使用列活性化の複雑さ。dedup 導入時に activate)。
3. **user 削除 × R2 残骸**: CC 推奨 = **本 sprint は incumbent(prefix 手動掃除)維持**。対案の trade-off: (a) 削除 flow で object_key 事前列挙 → best-effort R2 DELETE + 台帳 = 自動化されるが削除 flow(認証系重要経路)に手を入れる / (b) FK restrict/detach = 削除セマンティクス変更で過大 / (c) incumbent = 追加コードゼロ・zero-user で実害なし・既文書化済。(a) は必要になった時の別スプリント。
4. **2-pass 運用手順**: CC 推奨 = stg: `--dry-run` → mark → 翌日以降 `--sweep`(初回は `--grace-hours` 短縮で cycle 検証)/ prod: 当面「mark → grace 経過後 sweep」を OT が手動 2 回。sweep 単独反復でも収束する(§4.3)ため厳密な間隔管理は不要。頻度目安は月次程度から。

## §8 CC 暫定所見

**agree(確定前提と整合・事実が支持)**: scan-based + unreferenced_at 単独 + R2-first decouple + 台帳再利用 + 手動 2-pass は、現 sync 構造(LWW 全置換・cascade 素通り)と既存規律(Sprint 1/2 decouple・backfill 前例・YAGNI)に全て乗る。migration ゼロ・新設は seam 1 関数 + script 1 本 + catalog 1 entry + client hook 2 箇所に収まる。

**disagree / caution**: grace は poison mutation(§4.8-1)を完全には防げない(unbounded offline)。「grace で十分」ではなく「grace + 既存 UI の回復経路 + 受容」のセットで判断されたい。

**不明(実装/smoke で解消)**: R2 の非存在 key DELETE の実応答(404 か 204 か — 契約は両対応済・stg smoke で実証)/ Postgres 上の実データでの scan 実行時間(現規模では問題にならない見込み)。
