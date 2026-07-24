# 削除済み exam のモバイル端末残留 fact-finding — tombstone 未作成が原因

- **日付**: 2026-07-24 / branch `develop` / 調査 HEAD `887a968`
- **性質**: read-only 調査のみ。実装 / migration / seed script / test 変更なし。
- **事象(OT 観察 2026-07-24)**: モバイル(Chrome/PWA)の試験一覧に、2026-06-17 作成の `[PERF-SEED]` exam が残留。同アカウントの PC には表示されない(PC はアプリデータ消去 + ハードリロードでも不変 = server 状態に無い)。モバイルでサイトデータ(IndexedDB 含む)を消去すると PC と一致した。
- **裏取り**: CC Explore/general-purpose subagent 4 体並列(現 HEAD の実ファイル/関数/行を直接 Read)+ OT の stg SQL(owner ロール)実行結果。

---

## 結論 — 仮説B 確定(実害なし)

**6/17 の PERF-SEED exam(id `a9039b08-20b7-485e-ab4a-991096386d71`)は `scripts/seed-perf-exam.ts --cleanup` の DB 直 DELETE で削除され、tombstone が立っていない。** tombstone は他端末 mirror を消す唯一の削除信号のため、その exam を mirror 済みだったモバイル IDB に削除が伝播せず残留した。正規 UI 削除経路は必ず tombstone を立てるため、**通常操作では再現しない = 実害なし**。

切り分けた 3 仮説:
- **A(実バグ: 正規削除が pull で伝わらない)= 否定**。正規経路・pull・GC・RLS のどこにも欠陥は見つからない(§1–§4)。
- **B(seed cleanup の DB 直 DELETE で tombstone 未作成)= 確定**。コード(§5)+ session log + 下記 SQL 証跡。
- **C(GC/保持期間/cursor/RLS の構造的取りこぼし)= 否定**。時間ベース tombstone GC は不在、pull cursor は inclusive、tombstones policy は `user_id` 述語のみ(§4・§7)。

### SQL 証跡(OT / stg / owner ロール・2026-07-24)

- **Q1**(`SELECT … FROM exams WHERE name LIKE '[PERF-SEED]%'`): 現存は 1 行のみ = 7/16 作成の別 exam(`75104e5f-…`)。**6/17 の `a9039b08` は不在** = server 側は削除済(PC が正常な事実と整合)。
- **Q2**(`SELECT … FROM tombstones WHERE entity_type='exam' AND entity_id='a9039b08-…'`): **0 行**。正規 UI 削除なら必ず exam tombstone が立つはずのところ、**tombstone が存在しない** = 正規経路を通らず削除された動かぬ証拠。

session log 相互参照: `docs/superpowers/sessions/2026-06-17-grid-1-t7-smoke/observation-log.md:5`(6/17 exam id = `a9039b08`)/ `.../2026-06-20-grid-2-t7-smoke/observation-log.md:10,173`(再 seed 時に旧 `a9039b08` が 404 = cleanup 済を確認)。

---

## 1. exam 削除の正規経路(`app/(app)/app/exams/_actions/delete-exam.ts`)

`deleteExam(examId)`(:26)→ `_deleteExam`(:39)。`withTenantTx(user.id, …)` 内で 4 ステップ:

1. owner 確認 SELECT(:51、0 行なら silent idempotent success・tombstone も立てない)
2. 配下 card id 列挙(:62、CASCADE で消える前に取得)
3. **`tombstones` へ exam 1 件 + 配下 card 全件を INSERT**(:74-84、`deleted_at = sql\`now()\``、`onConflictDoNothing`)
4. **`DELETE FROM exams`(物理削除)**(:87、FK CASCADE で cards/source_documents/reviews/card_tags/card_asset_refs/answer_events 連動)

- `exams` は hard delete(`deleted_at` 列なし・`lib/db/schema.ts:250`)。
- client は `delete-exam-button.tsx` が server action を直接 await(local Dexie は触らない)→ 成功後 `router.refresh()` + `runGuardedPull({reason:'exam-delete'})`。**exam は entity_mutations(outbox)を通らない**(outbox の entity_type は `card`/`tag_category`/`tag_option` のみ)。

## 2. tombstone による他端末伝播の設計【将来 exam 削除経路を触る人が最初に読む箇所】

- 削除伝播は**専用 `tombstones` テーブル**が担う。`GET /api/pull`(`app/api/pull/route.ts`)が返す 6 stream の 1 つ。cursor = `tombstones.deleted_at`、`since` は inclusive(`gte`、`lib/db/pull-delta.ts:42-46`)。
- client 適用: `lib/sync/pull.ts:227-261` が entity_type 別に `db.exams/cards.bulkDelete()`。
- **不変条件(load-bearing)**: exam 削除では **exam 1 件 + 配下 card 全件それぞれに個別 tombstone を立てる**。理由 = **client は exam tombstone から子 card を導出しない**(`pull.ts:244` は exams のみ bulkDelete)。子 card の mirror 掃除は server が撒いた個別 card tombstone に全面依存する。`card_tags` のみ card tombstone から client 側で導出 purge(`pull.ts:259-261`)。`card_asset_refs`/`source_documents`/`reviews` は client mirror が無く伝播不要。
- → **exam 削除を新経路で実装/変更する際は、この「exam + 子 card 全件の tombstone INSERT」を必ず維持すること。** これを欠くと子 card が他端末に残る(本件と同型の残留)。`delete-exam.ts:69` のコメントが同趣旨を明記。

## 3. tombstone に時間ベース GC は無い(現状は正しい設計)

- 時間ベースの tombstone GC / TTL / prune は repo 全体に**存在しない**(`vercel.json` に `crons` キーなし・GHA 不採用・prune script なし)。tombstones を DELETE する唯一の箇所は user アカウント削除時の per-user 全消し(`lib/clerk/handle-clerk-event.ts:224`)。
- これは**現状の正しい設計**: tombstone が無期限蓄積し cursor が inclusive なため、**長期オフライン端末が復帰しても正規の削除を取りこぼさない**理由そのもの。
- **将来テーブル肥大で GC/TTL を検討する場合の注意**: **GC 単独導入は禁物**。保持期間より古い `tombstoneCursor` を持つ端末は、消された tombstone を差分 pull で永久に取りこぼす(= 削除が二度と届かない)。導入するなら「**client cursor が保持期間より古い場合は差分でなくフル再 pull(全 mirror 再構築)**」の検出とセットにすること。

## 4. seed script が残留を再発させる【follow-up・今は修正しない】

- `scripts/seed-perf-exam.ts --cleanup`(:318-363)の実 DELETE は `getAdminDb()` 経由の `db.delete(exams).where(userId + name LIKE '[PERF-SEED]%')`(:343-351)。FK CASCADE で子も消えるが、**tombstone を一切 INSERT しない**ため、その exam を mirror 済みの端末に削除が届かず本件と同じ残留を再発させる。
- **実ユーザー経路ではない**(perf 計測用の seed/cleanup 専用 script)ため**今は修正しない**。次に seed script を触る時(perf 計測再開時)に「cleanup も正規経路同様 tombstone を立てる or cleanup 後は対象端末の IDB を消す運用にする」を同梱する follow-up として記載。

## 5. 未実証事項

- **「正規 UI 削除が実際に別端末へ伝わる」ことの実機確認は本 fact-finding では取っていない**(コード上は §1–§2 で成立するが、end-to-end の実走証跡は未取得)。
- OT の iPad smoke に **2 端末 smoke(PC で試験作成 → 削除 → モバイルで試験一覧から消失を確認)を同梱予定**。これが取れれば仮説A の実証的排除が完了する。

---

## 参照ファイル(絶対パス)

- `/workspaces/RecallMint/app/(app)/app/exams/_actions/delete-exam.ts` — exam 削除 server action(tombstone INSERT + 物理 DELETE)
- `/workspaces/RecallMint/app/(app)/app/exams/_components/delete-exam-button.tsx` — client ボタン(server action 直呼び + runGuardedPull)
- `/workspaces/RecallMint/app/api/pull/route.ts` — pull endpoint(6 stream・cursor 返却)
- `/workspaces/RecallMint/lib/db/tombstones-pull.ts` — server tombstone delta(cursor = deleted_at)
- `/workspaces/RecallMint/lib/sync/pull.ts` — client 側 tombstone 適用(bulkDelete)+ card_tags 導出 purge
- `/workspaces/RecallMint/lib/db/schema.ts` — exams(hard delete `:250`)/ tombstones(`:785-805`)/ FK CASCADE
- `/workspaces/RecallMint/scripts/seed-perf-exam.ts` — cleanup(:318-363、tombstone を立てない DB 直 DELETE)
- `/workspaces/RecallMint/db/policies/rls-p2-enable.sql` — `tombstones_tenant`(user_id 述語のみ・deleted_at 条件なし)
- `/workspaces/RecallMint/lib/clerk/handle-clerk-event.ts:224` — tombstone を消す唯一の箇所(user 削除時のみ)
