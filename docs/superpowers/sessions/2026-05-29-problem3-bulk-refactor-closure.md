# 問題 3 (bulk refactor) クローズ記録

- 日時: 2026-05-29
- 種別: session log / クローズ記録 (docs 整備のみ、 コード変更なし)
- 対象: `POST /api/review-events/bulk` の event 処理 = per-event tx × N → 単一 tx + in-memory FSRS replay + bulk SQL
- 結論: **correctness 完全解決 (rollback 解消・全件成功・実 DB 反映確認)。 性能 16.7-17.4s → 4.8s (~3.5x、 cold 単発)。 spec target ~3.2s から ~1.6s 上振れは cold 単発のため別 task で内訳調査。**

---

## 1. 結果サマリ

| 軸 | 結果 |
| --- | --- |
| correctness | ✅ **完全解決**。 rollback 解消 / 全 5 event `synced` / cards・reviews・study_days が実 DB 反映 (dashboard 今日の学習問題数 0→5 / due 50→45 / streak 1→2) |
| 性能 | 16.7〜17.4s → **4,769ms = ~3.5x 改善** (cold 単発)。 16s 級 (per-event serial) は解消 |
| spec target | ~3.2s に対し ~1.6s 上振れ。 cold 単発で統計的有意性なし → per-phase 内訳 + warm 計測は別 task |
| 副次安全網 | RETURNING 件数照合が正常パス (5 適用 = 5 returning、 throw なし) |

---

## 2. 実装サマリ

- **per-event tx × N → 単一 `db.transaction`**: Phase 0 session upsert (tx 外) → Phase 1 owner-scope SELECT IN + orphan→failed[] → Phase 2 (answer_events bulk INSERT ON CONFLICT DO NOTHING RETURNING → event_id 単位 gating → card ごと `replayCard` fold → reviews bulk INSERT → cards VALUES 単一 UPDATE → study_days JST day group upsert)。
- **`replayCard` 純コア抽出**: DB 非依存の FSRS fold (`lib/cards/replay-card.ts`)。 旧 `submitReviewTx` の compute を移植。
- **dead code 撤去**: 旧単発 `submitReview` server action + `submitReviewTx` + 関連 test を削除 → `replayCard` が FSRS compute の単一 source (DRY)。
- **cards VALUES 単一 UPDATE**: `UPDATE cards ... FROM (VALUES ...) AS v(...)` で N→1 round trip (parameterized / cast 明示 / owner-scope)。
- **Drizzle #5789 fix**: VALUES の timestamptz bind (due / last_review / updated_at) を `toPgTimestamptz` で ISO string 化 (JS Date を sql template に embed すると postgres-js serializer bypass → `Buffer.byteLength(Date)` TypeError)。
- **RETURNING 件数照合**: `.returning({ id })` で更新件数 != finalStates.size なら throw (0 rows update の silent 見逃し安全網)。
- **観測強化**: `serializeDbError` (`lib/db/serialize-db-error.ts`) で catch した DB error を plain object 化し native (code/severity/detail/cause) を log 可視化。 `BULK_FULL_PARAMS_LOG` env flag で full params は Preview 限定。

---

## 3. before / after 比較

| session | before (per-event、 `d3617a8`) | after (単一 tx + fix、 `0e78ef0`) |
| --- | --- | --- |
| 1 (cold) | 17,426ms | **4,769ms** |
| 2 (warm) | 16,773ms | (別 task) |
| 3 (warm) | 16,746ms | (別 task) |

- **~3.5x 改善 / 16s 級解消**。 after は fix 確証の cold 単発のみ (warm × 3 session のばらつき計測は別 task)。
- before baseline: `docs/superpowers/sessions/2026-05-28-problem3-before-measurement.md` §2。

---

## 4. stg smoke 結果 (3 段階の経緯)

| 段階 | commit | 結果 |
| --- | --- | --- |
| 1. 初回 | `d06062c` (refactor 完了版) | 🔴 rollback 発生、 `failed[全 5]`。 全 test green + build OK でも実 DB で全滅。 root cause 未確定 (Vercel log の err が Drizzle wrap で native 喪失) |
| 2. 観測強化後 | `a332b78` (serializeDbError) | rollback 再現。 native error が log で可視化 → root cause 特定: postgres-js が JS Date を encode できず `Buffer.byteLength(Date)` TypeError (Drizzle #5789)。 SQL 構文 / schema / pooler は無関係と確定 |
| 3. fix 後 | `0e78ef0` (timestamptz ISO bind + RETURNING) | ✅ **rollback 解消**。 POST 200 + `{ok:true, failed:[]}`、 全 event synced、 DB 反映確認。 ← **ここでクローズ** |

詳細 smoke log: `docs/superpowers/sessions/2026-05-28-problem3-after-measurement.md` §0 (CRITICAL) / §0-bis (再 smoke 識別子) / §0-final (fix 確証)。

---

## 5. 成果物

### commit 群 (develop、 base `5080623` 以降。 push は OT。 closure commit が develop HEAD)

設計 / plan:
- `8aca482` docs: sync layer pre-investigation (不変条件 11 件)
- `75be540` docs: 確定 spec
- `10169ab` docs: implementation plan (Task 1-6)

実装 (refactor 本体):
- `d97f29a` refactor: 旧単発 submitReview action 撤去
- `09213c4` feat: replayCard 純コア抽出
- `cde3826` feat: 単一 tx + in-memory replay 化 + submitReviewTx 撤去
- `debcecb` feat: cards VALUES 単一 UPDATE
- `49d6ab7` test: payload 順序不変条件 guard
- `d06062c` fix: rating-derive 重複を deriveRating helper に集約

観測 + fix:
- `a332b78` chore: serializeDbError で native DB error 可視化
- `16f2e96` chore: .env.example に BULK_FULL_PARAMS_LOG
- `0e78ef0` fix: timestamptz ISO string bind 化 (#5789) + RETURNING 件数検知

smoke / 記録:
- `bbf2e5d` `bc8672e` docs: after 計測 (auth → CRITICAL 検出)
- `bc201cf` docs: 観測強化後 再 smoke 識別子
- `09e4356` docs: fix 確証 smoke (§0-final)

### doc パス
- spec: `docs/superpowers/sessions/2026-05-28-problem3-bulk-refactor-spec.md`
- pre-investigation: `docs/superpowers/sessions/2026-05-28-problem3-sync-layer-pre-investigation.md`
- plan: `docs/superpowers/plans/2026-05-28-problem3-bulk-refactor.md`
- before 計測: `docs/superpowers/sessions/2026-05-28-problem3-before-measurement.md`
- after 計測 (smoke 経緯 §0 / §0-bis / §0-final): `docs/superpowers/sessions/2026-05-28-problem3-after-measurement.md`
- lessons: `docs/superpowers/lessons/2026-05-29-bulk-refactor-driver-layer-lessons.md`

---

## 6. 残課題 (本 sprint scope 外、 follow-up)

- **性能 per-phase 内訳調査**: Vercel log の `review_events.bulk.timing` で ~1.6s 上振れの内訳 (study_days の per-day COUNT(DISTINCT)+upsert 往復 / Supabase pooler RTT / cold start) を確認。
- **warm 計測 + smart × 3 session**: 性能ばらつきと warm の安定値 (before と同条件 3 session)。
- **custom モード smoke**: dashboard の「カスタム演習」 は現状「準備中」 (disabled) で UI 経路なし → feature live 後に実施。
- **再レート (やり直し) correctness 網羅 smoke**: 同 card 再回答が別 event_id で順次累積されるかの実 DB 確認。
- **TEMP-MEASURE 計測コード撤去**: spec §6 通り、 性能確定後に per-phase timing instrumentation + `BULK_FULL_PARAMS_LOG` 経路を撤去。
- `problem3-before-measurement.md` の §1-§5 (記入待ち template) は記入待ちのまま放置でよい (§2 の数値で本質完結)。
- merge / push は OT 専権。
