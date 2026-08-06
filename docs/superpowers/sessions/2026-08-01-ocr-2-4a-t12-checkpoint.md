# ②-4a T12 stop checkpoint — publish fencing + prepared takeover

**日付**: 2026-08-01
**対象**: T12(publish)= T12a(publishPreparedUploadTx orchestrator + 最終防衛 fencing)+ T12b(prepared takeover)
**commit**: T12a `cc2b196`(feat・**tagless**)/ T12b `3bae12d`(feat・**tagless**)+ codex docs `667127d`/`6e7439b`/`b6ca0d0`(spec/plan 明示)
**status**: review 収束(canonical + Codex 両者 Crit0/Imp0)。checkpoint **OT 承認済(2026-08-01・§8)**。**T12 = [reviewed] 確定**(本 doc が正記録・publish tx/fencing/takeover 本体は実 PG iso で検証・UI end-to-end は cutover smoke)。**T10 = tagless 維持**(#4/#5/#6 は cutover smoke 通過後に [reviewed])。詳細 = §8。push 済 commit の tag 後付けはしない。

このドキュメントは T12 完了時の stop checkpoint(2026-07-31 OT 指示)の正記録。OT + claude.ai が fencing + prepared takeover を確認するための材料。

---

## 1. 最終防衛 fencing(T12a・本 sprint 最重要不変条件)

**主張**: takeover された / lease を失った旧 worker は、crop まで到達しても publish で必ず弾かれ、カードを二重作成できない。

**機構**(`publish-prepared.ts`):
- `publishPreparedUploadTx` の tx 冒頭で operation を `SELECT … FOR UPDATE`(ロック順の起点)し、`status='prepared' AND lease_version === :mine` 不一致は `{stale}`・**0 書込**(L128-146)。
- finalize UPDATE も同 guard(`status='prepared' AND lease_version=:mine`・L257-276)= 多層防御。
- crop は tx の外(R2 I/O)。crop 自身は `status='prepared'` だけ見るため stale worker も crop 到達しうるが、idempotent(`onConflictDoNothing`)ゆえ同 asset へ収束し、cards は fenced tx 内でのみ作られる。

**canonical(opus)検証** = 3 interleaving を全 trace し二重作成不能を確認:
1. Step-A(非 lock 読取)→ tx fence 間で takeover: tx が FOR UPDATE 再読 + lease 再検査 → 旧 lease は reject。
2. crop → tx 間で takeover: crop は無害収束、cards は fenced tx のみ → reject。
3. 同 lease の並行 publisher: FOR UPDATE で直列化、敗者は committed 済 `status='completed'` を見て非 prepared → stale。
- **T6 の claim CAS 通過は T12 fencing の代替でない**(権利取得 ≠ 最終防衛)を実装 + doc で明示。

## 2. prepared takeover(T12b)

**主張**: prepared 保存後に worker が死んで lease が期限切れになった operation を、新 worker が新 lease_version で引き継げる。旧 worker は §1 の fencing で publish 拒否。Gemini 再実行しないため daily cap 非適用。

**機構**(`claim-operation.ts` prepared 分岐):
- CAS: `status='prepared' AND (lease_expires_at IS NULL OR < now()) AND (next_retry_at IS NULL OR <= now())` → `lease_version+1`・`lease_expires_at=now()+TTL`・`last_error_code/next_retry_at` クリア → `{prepared_taken_over, leaseVersion}`。0 行(live lease / backoff 中)→ `{already_prepared}`。
- daily cap block の**前**に return(Gemini 再実行なし)。payload/Gemini 不触。`attempt_count` 非加算。時刻は PG `now()`。
- `next_retry_at` guard: T12a の publish-retryable(`persistPublishRetryCas` が lease 解放 + next_retry 記録)を backoff 中に再奪取しない。

**canonical(opus)検証** = 4 Critical 失敗モードを全て到達不能と確認:
- double-takeover: FOR UPDATE 直列化 + 敗者が bumped lease 再読 → CAS 0 行。lease_version 単調ゆえ ABA なし。exactly-one-winner。
- old-worker-commit: takeover と publish が同 op 行を lock → 直列化。bumped lease は stale worker に致命。
- cap-bypass: cap block 前に return・payload/Gemini 不触(構造的到達不能)。
- lost-fencing: takeover は fence を「有効化」するのみ。
- 排他は READ COMMITTED(`withTenantTx` 既定・確認済)前提で成立。

**old-worker-rejection 統合 test**(checkpoint の要): prepared+期限切れ+実 payload → takeover(lease=2)→ **T12a の実 `publishPreparedUpload`**(mock でない)を旧 lease=1 で呼ぶ → `stale`/0 cards → 新 lease=2 → `published`/1 card。

## 3. completeUploadTx 相当 の scope 訂正(round 3・OT 承認)

初回実装は「completeUploadTx 相当」を operation status のみと誤読(Codex P1 で発覚)。実際の `completeUploadTx` = `source_documents.status='completed'` + `upload_records` 記帳。現物で裏取り(spec §9 L298「publisher が completed へ戻す」/ upload_records = 月次 quota SUM 源 `ai-usage-mcq.ts`)。OT 承認で publish tx に両方追加:
- `source_documents.status='completed'`(+ pages_processed/cards_extracted/completed_at)= exam-status API / source-doc-status.ts が読む consumer path。
- `upload_records` 記帳(`pages_processed`=source 画像数=月次 quota SUM 対象列・`ocr_cost_yen`=null)。**記帳は ②-4a・月次 quota 強制のみ ②-5**(記帳 ≠ 強制)。
- 全て同一 fenced tx = atomic(publish 失敗で source_documents/upload_records も一括 rollback。2 failure iso で実証)。
- spec §8.2 / plan T12 の文言を展開済(`b6ca0d0`)= T12b/T14 実装者の同一誤読防止。

## 4. review 経緯(T12a 3 fix round・全て genuine gap)

- 初回 canonical(opus)Crit0/Imp0/Minor3(fencing 正・verified)。Codex P1(source_document null publish detached)+ P2(corrupt/empty payload 無限 reclaim)。
- fix1: null source_document / corrupt / empty → fenced terminal_failed。
- fix1 re-review: 新 P2(null-payload 同型)→ fix2。fix2 で永続失敗クラスを 13 早期 return audit で構造閉鎖。
- fix2 re-review: 新 P1(source_documents + upload_records 欠落)→ OT escalation → 承認 → fix3。
- fix3: 両者 clean 収束。
- T12b: 初回 canonical(opus)+ Codex 両 clean(Minor1=wording のみ)。

## 5. checkpoint 持ち越し項目(OT 判断 / 記録)

いずれも fencing/正当性に影響なし。canonical が健全と判定済。OT の bless を求める:
- **(a) bumpExamCardCount 非改修**: plan は「affected row 検証」だが exam を step2 で FOR UPDATE(書込前・より強い所有権検証)で代替。canonical=acceptable/arguably stronger。plan 文言逸脱ゆえ OT-visible。
- **(b) counter を refs より前に書く**: spec §8.1 は counters を refs 後に列挙。exam は step2 で lock 済ゆえロック取得順は不変・書込文の順のみ差(deadlock 無関係)。canonical=健全。
- **(c) dup-card-id → retryable**(terminal でなく): UUIDv4 衝突は never-happens、再 publish は fencing で防止。retryable は T14 の 7 日 cap が終端 backstop。canonical Minor(round0)= acceptable。
- **(d) T11 domain-purity 先例**: `lib/cards/domain/card-asset-refs.ts` が domain dir 初の runtime import(`isAssetKey`=transitively zod)。reviewer 判定=SSoT 再利用が重複 drift より妥当・code comment 明文化済。将来 domain file の先例。formalize(eslint-block コメント/方針)ご希望なら別途。
- **(e) T12b old-worker test の fence-leg wording**(canonical Minor1): sequential test は orchestrator fast-fail leg を exercise・inner tx fence の mid-flight case は T12a invariant(別 suite・opus verified)。wording 精度のみ・code 影響なし。comment tighten は trivial follow-up。

## 6. combined stg-smoke 計画(T10 + T12・OT push 後 CC 実走)

crop→publish が実経路で繋がるのは T12。ゆえに T10 と T12 を **combined end-to-end smoke** で検証(2026-08-01 OT 決定・論点A)。**T10 の 6 基準を落とさない**(mock 非証明ゆえ実機必須):

**publish 経路**(T12):
1. 画像+図版を upload → OCR → prepared → **publish** → cards が DB に出現・描画(UI で処理中→完了)。
2. `source_documents.status='completed'` + `upload_records` 1 行(`pages_processed`=画像数)= 月次 quota に反映。
3. **fencing / takeover の実機再現はしない(2026-08-01 OT)**: 正しさは DB 状態遷移 + SQL 述語で決まり、opus の全 interleaving trace + 実 PG iso test で検証済。人工的 lease 操作で race を stg DB に作ると他 smoke 項目(#4 冪等 / #5 決定性)を汚染するリスクが上回る。**smoke での fencing 確認 = 「通常経路で published が 1 回だけ起きる」で足りる**(中途半端な状態を作らない)。

**crop 経路**(T10・mock 非証明):
- #4 冪等: 同 figureAssetId 再実行 → reused・行数不変・R2 実体不変(412→hash 一致)。
- #5 決定性: 再 crop で同 hash(auto-rotate 無し・webp 固定を実 sharp+実 R2)。
- #6 guard: `status≠prepared` で crop 発火 → R2 物体なし・行なし(spec §7.3)。
- #1-3: crop webp が R2 に出現・assets 行(ready/hash/dims)・asset_derivations(bbox/padding/crop_w/h)。

## 7. 残タスク(T12 後)

T14(deadline/retry/source_assets GC/stale 統合・stg-smoke gate)→ T15(GDPR Group I・stg-smoke gate)→ T16(提示/回転除外)。T12b の takeover を実際に発火させる retry sweep は T14。

## 8. smoke 判定(2026-08-01 OT)— 新 flow 未配線ゆえ combined smoke は cutover へ defer

**現物**: ②-4a の新 flow(prepare→claim→stage→crop→publish)は **UI 未配線**。`upload-form.tsx:434` は今もレガシー `processUpload`(`runUploadGuardTx`)を呼び、新 flow 関数群に production/UI caller ゼロ。→ stg UI で画像 upload してもレガシー経路を通り T10/T12 新コードに到達しない = combined end-to-end UI smoke 不可(ブラウザは開かず現物確認で停止・OT が適切と評価)。

**OT 決定**:
- **②-4a は server-side-only で正しい**(plan T4-T16 に client orchestration 無しは設計どおり・spec §1 は server 状態機械の定義)。**UI cutover は ②-4a 完了後・②-4b 前の必須独立タスク**(`②-4a-cutover`・当時の todo で定義。todo は claude.ai 管理)。
- **T12 = [reviewed] 確定**: publish tx / fencing / takeover 本体は実 PG iso で検証済(T12 の検証対象の中心)。UI 経由 end-to-end は cutover smoke で検証。本 doc が [reviewed] 正記録(push 済ゆえ commit tag は追わない)。
- **T10 = tagless 維持**: #4(実 R2 412 冪等)/ #5(実 sharp 決定性)/ #6(§7.3 guard)は T10 本体機能そのもので mock のまま。cutover smoke 通過で [reviewed] 確定。
- **T14 → T15 → T16 続行**(全て server-side・iso 検証範囲)。各 task の stg-smoke gate は **「cutover smoke に統合」と読み替え**、本 doc / 各 session doc に記録。
- claude.ai 見落とし記録: combined smoke 承認時に「T12 で繋がる」= server 内部配線であって UI cutover でないことを未確認(T4「not UI-wired」記録を引き当てられず)。
