# ②-4a 実装 T5 stop checkpoint(schema + 状態機械 + source lifecycle)

- 日付: 2026-07-31
- 位置付け: OT 指定の「T5 前後 stop checkpoint」。実装が進みきる前に schema(source_assets / upload_operations / asset_derivations)と状態機械が spec の意図どおりか OT + claude.ai で確認する。
- **前倒しの理由**: T4(prepareUpload)実装中に **frozen schema の 1 点(`source_assets.content_hash NOT NULL`)が reserve 時に実値を持てない**問題を検出。T5(finalize/hash)がこの列に直接乗るため、T5 着手前(= T5 前)に確認するのが手戻り最小。
- 実装方式: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。
- ledger: `.superpowers/sdd/2026-07-30-ocr-2-4a-image-figure-crop/progress.md`

---

## 1. 進捗(commit / gate)

| task | 内容 | 状態 | commit | gate |
|---|---|---|---|---|
| T0 | sharp direct 依存化 | 完了 | `b5d86f1` [no-review] | install/frozen/typecheck/build/audit exit0 + sharp crop smoke |
| T1 | source_assets 表 | 完了 | `16474a6` [no-review] | (下記 Phase A gate) |
| T2 | upload_operations 表 | 完了 | `2e45972` [no-review] | 〃 |
| T3 | asset_derivations 表 | 完了 | `359bf46` [no-review] | 〃 |
| T4 | prepareUpload | **staged(未 commit)** | — | typecheck0 / test:iso 227 green(+7)/ lint clean |

- **Phase A gate**: `pnpm test:iso` 220 green / whole-repo `pnpm lint` --max-warnings=0 exit0 / `pnpm typecheck` exit0。`db/roles/*-grants.sql` 不変(blanket grant が新表を自動 cover)。
- **Phase A task-review(sonnet・focused diff)= Approved / Critical 0 / Important 0**。3 表とも columns/types/constraints/index/FK on-delete が spec §6.1/§2/§10 と一致。RLS common-form 対称・冪等・global-setup wiring 正・drift/completeness oracle と fixture 整合(非 vacuous)・migration DDL only・grants 不変・scope creep なし。
- **RED 実証**: `asset_derivations_tenant` の USING を `(true)` に弱めると drift test が fail(revert 済)。新 oracle pin が load-bearing であることを実証。

### Phase A deferred Minors(最終 whole-branch review で triage)
1. `rls-drift.test.ts:39` コメント "共通形 17 表" が stale(現 20)。配列本体は正。
2. `rls-drift.test.ts:172,174` コメント + it title "18 対象/5 非対象" が stale(現 21)。body は array を loop ゆえ機能無害。
3. `db/policies/ocr-2-4a-enable.sql:23` `①-4a` typo(→ `②-4a`)。
4. **設計申し送り(Phase B)**: `asset_derivations.source_asset_id` = CASCADE。T14 で source_assets を GDPR 全消し以外の理由(retention/GC・status に 'deleting' あり)で独立に消すと、asset(crop 画像)+card が生きたまま provenance が消える。Phase A では NOT NULL + cascade chain 保護のため唯一の正解。**T14 の source lifecycle 設計で扱う**。

---

## 2. 検出した frozen-schema 問題(要 OT 判断)

### 2.1 `source_assets.content_hash NOT NULL` が reserve 時に実値を持てない

- 現状(T1): `content_hash: text('content_hash').notNull()`。
- spec §6.2: content_hash は **finalize で server が実バイトから SHA-256 算出**。reserve 時点では bytes 未着 → 実値なし。
- 帰結(T4): NOT NULL を満たすため `contentHash: \`pending-${assetId}\`` の placeholder を挿入(finalize=T5 が上書きする旨コメント)。
- 機能的には無害(status で reserved/ready 区別・finalize が status='reserved' WHERE で上書き・placeholder は read されない)が、**semantics が誤り**で canonical/Codex が smell 指摘する見込み。
- **推奨 = `content_hash` を NULLABLE 化**(reserve=null / finalize=実値 set)。migration 0026 は ephemeral test DB のみ適用・stg/prod 未反映ゆえ修正は安価。
- 関連: `byte_size` / `width` / `height` も「reserve=client hint / finalize=server verified」(spec §4.3・§6.2「client 申告は予約ヒントのみ」)。現状 3 列とも client hint で NOT NULL。**nullable-until-finalize に揃えるか / hint 保持で NOT NULL 維持か**を確認したい(content_hash と違い client が知り得る値なので NOT NULL 維持も可・整合性の問題)。

---

## 3. 実装中に spec から解釈した点(確認したい)

### 3.1 T4/T5 reservation 境界
- plan T4「source_asset reservation を 1 tx で作成」と plan T5「reserve=source_assets 'reserved' + temp key presigned PUT」が双方 "reserve" と記述(plan 内 wording 重複)。
- **tiebreaker = frozen spec §1 flow 図**:「prepareUpload(operation / exam / source_document / **source reservation** を先に作成)」→ **reservation 行作成は T4**。T5 は presigned URL 発行 + finalize(server GET/verify/promote/ready)。
- この解釈で実装済(T4 が reserved 行作成)。**OK か確認**。

### 3.2 quota / daily-limit guard
- spec §0「account quota は ②-5」ゆえ T4 に月次ページ quota guard を入れず(旧 runUploadGuardTx の quota/advisory-lock は移植せず)。
- 別論点: **service 全体の日次 Gemini call cap(`GEMINI_DAILY_LIMIT`・CLAUDE.md AI 絶対ルール 2 の安全弁)**は新 prepare→publish flow の Gemini call(T7 OCR)にも要るはず。T6/T7 で入れる想定。**方針確認**(旧 flow は runUploadGuardTx 内で判定)。

### 3.3 状態機械 fencing の checkpoint 深さ
- 現時点で landed なのは schema(upload_operations の status/lease_version/attempt_count 列)+ T4 の `awaiting_sources` 初期化まで。
- 遷移本体(awaiting_sources→claimed の CAS lease_version / publish の `FOR UPDATE + status='prepared' AND lease_version=:mine` 拒否)は **T6(claim)/ T12(publish)** で実装。
- **選択**: (a) この設計確認で継続(T6 以降は per-task canonical+Codex + 最終 whole-branch review で担保)/ (b) fencing の CODE も今見たいので T6 を先に実装して再 checkpoint。

---

## 4. 次アクション(OT 判断後)
- content_hash(+ byte/width/height)の nullability 確定 → 必要なら T1 schema 修正(migration 0026 再生成)+ T4 placeholder 除去。
- T4 を canonical(requesting-code-review)+ Codex → Crit0/Imp0 → `[reviewed]` commit。
- T5(reserve/finalize)着手。

---

## 5. OT 裁定(2026-07-31・確定・Codex 再チェック反映)

Codex 再チェック結果を受けた OT 確定内容。spec / plan に反映済(本 session の docs commit)。

**A. `input_fingerprint` 廃止 — 採用**。二重処理防止は UNIQUE(user_id,idempotency_key)+ T4 並行再送収束 + T6 lease CAS + T12 fencing + finalize 後 immutability + stage 済 UUID 再利用で成立。冪等契約を明記(同一 key は常に最初の operation・引数差でも既存を返す)。`prepared_hash` は残す(payload 破損/drift 検知)。`ordinal` 列も不要(source 集合 unordered・source_id 決定処理)。

**B. `client_declared_*` 列は作らない・reservation 行は維持**(claude.ai の「finalize 後作成」案は撤回)。理由=reservation 行が GC 手がかり + GDPR object_key 保持を兼ねる。検証済 5 列(content_hash/byte_size/width/height/mime)を nullable 化し finalize の条件付き UPDATE で値 + status='ready' を同時確定。client 申告 size/MIME は T5 で検証し presigned URL 署名にのみ使用(非永続)。**追加**: 全体サイズ上限は T4 の client 申告合計早期検査 + **T6 前に server 実測 byte_size 合計で再検査**(改変クライアント対策)。

**C. 日次 cap — 原子化不要・配線必須**(claude.ai の「同時 1 upload で並行は起きない」は新 flow で不成立=guard 未移植が証拠: prepare-upload.test.ts:349 が同一 user・別 key で 2 operation 成功)。修正: (1) T4 冒頭 user advisory lock(並行再送収束 + 同時 1 upload 制限を 1 機構で。live 判定は operation status/lease/TTL 基準・旧 15 分窓流用禁止)(2) T6 claim 直前に日次 cap 判定(上限で awaiting のまま返す)(3) T7 各 attempt incrementAiUsage(4) GEMINI_DAILY_LIMIT_EXCEEDED を UI へ(5) parseDailyLimit を helper 化。**原子的枠確保(INSERT…ON CONFLICT WHERE count<limit)は非実装**(実ユーザー 0・超過 1〜2 回許容・増加後再判断)。

**D/E. T4 修正 — 採用**: 並行再送収束(C-1 advisory lock で同時解決)+ 入力検証を reserveAsset の Zod 境界(asset-actions.ts:57)に揃える。

**その他**: T5 文言=「T4 作成済 reserved 行を認可・検証し temp PUT URL 発行。source_assets 行を新規作成しない」/ §7.3 を crop-derived に限定 / **T12(publish fencing)で別 checkpoint**。

**進め方**: spec/plan/migration 改訂 → T4 修正 → canonical+Codex → commit → T5 → T6(CAS)→ 再 checkpoint。改訂後の Codex 再レビューは不要(判断確定済)。**T6 完了時の checkpoint で改めて見る**。

### migration 反映方針(CC 判断・OT へ報告事項)
migration 0026-0028 は未適用(test DB のみ・stg/prod 未反映)。`git rebase -i` 不可 + drizzle snapshot 再同期リスクのため、**in-place 編集(0026/0027 書換 + T1/T2 amend)ではなく drizzle-native の前進 migration 0029**(source_assets 5 列 DROP NOT NULL + upload_operations DROP COLUMN input_fingerprint)で適用する。0 行・順次適用ゆえ create→alter は無害。clean history 希望なら soft-reset 再生成に切替可(要 OT 一言)。
