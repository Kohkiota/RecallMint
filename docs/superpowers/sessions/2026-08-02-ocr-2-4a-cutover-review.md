# ②-4a-cutover レビュー結果(canonical + Codex 統合・裁定)

**日付**: 2026-08-02
**対象**: staged 未 commit の cutover 2 file(`upload-form.tsx` / `upload-form.test.tsx`・HEAD=709fc06 に対する `git diff --cached`)
**経路**: canonical(`requesting-code-review` デフォルト経路・general-purpose + `code-reviewer.md` 改変なし)+ Codex(`scripts/ai/codex-review.sh ocr-2-4a-cutover`)
**Codex raw**: `docs/codex/2026-08-02-ocr-2-4a-cutover.md`

---

## 1. 結果サマリ

| review | Critical | Important | Minor |
|---|---|---|---|
| canonical | 0 | 3 | 3 |
| Codex | 2 (P1) | 0 | 0 |

両者の retry 指摘は**同一 issue**。severity が割れた(canonical=Important / Codex=Critical)。**現物裁定 = Codex が正確**(下記 §2)。

## 2. 裁定: retry 回復不能(canonical Imp#2 = Codex P1×2)— 現物 CONFIRMED

**症状**: `runProcess` は毎 submit で `crypto.randomUUID()` の fresh idempotencyKey を生成(`upload-form.tsx:509-513`)。サーバ側の冪等 resume(同一 key → 既存 op を返す・spec §2/§3)を**一切使わない**。ゆえに prepareUpload 後の任意の失敗のあと「もう一度」を押すと:

- prepareUpload が既に作った旧 op が **live-operation gate** に引っかかり `in_progress`(`prepare-upload.ts:236-260`)。
- gate の live 定義 = `claimed`|`prepared`(**createdAt 無関係 = 無期限**)、または `awaiting_sources` かつ `PREPARE_AWAITING_TTL_MS`(15 分)以内。
- **stage/publish 失敗は op を `status='claimed'` のまま残す**(lease は null 解放・next_retry_at 設定・`stage-prepared.ts:55,340-360`)→ gate は無期限 block。
- automatic cleanup 無し(handoff §6: 手動 sweep `gc-abandoned-operations.ts` のみ・cron 化は post-cutover)→ **手動掃除まで retry 不能**。

**canonical が Important に留めた理由 = awaiting_sources の 15 分 TTL しか見ていない**(post-claim の無期限ケースを見落とし)。Codex はこれを捕捉。**現物で Codex が正しい**。

**Codex P1#2(finalized source skip)も CONFIRMED**: 仮に key を再利用しても、reserve ループは `reserved` 全件に `reserveSource` を呼ぶが、同 action は `status='reserved'` のみ受理(`source-asset-actions.ts:97`)。既に `ready` の source で「アセットが見つかりません」→ resume 破綻。→ **key 再利用単独では不十分。client 側で「今 session で finalize した source_id」を skip する必要**(これは client-only で可能=下記 §4 案 A)。

**regression 性**: legacy `processUpload` は `source_documents(status='processing')` を STALE_PROCESSING_MS(15 分)TTL で放棄扱い → 15 分後は fresh retry 可能だった。新 flow の post-claim 失敗は**無期限**なので retry 回復性は後退。

**影響の実際**: happy path は無傷。stg は実ユーザー 0・abandoned op 蓄積は plan line41 で受容済。実害は「**OT の smoke 中に失敗 → 即 retry で 15分〜無期限の in_progress 表示**」。prod では実ユーザーが再アップロード不能になる真の Critical。

## 3. canonical Important #1(mime regression)— CONFIRMED・在庫内 fix

`upload-form.tsx:271-274` の `imageCompression` は `fileType` 未指定 → 出力 mime = 入力 `file.type`。新 flow の mime enum は `image/webp|png|jpeg` 厳格(`prepare-upload.ts:70` / `source-asset-actions.ts:58`)。**HEIC(UI が明示的に「HEIC」と案内)/ GIF 等は `ready` entry になるが server が `invalid_input`(生 zod 英語 message)で弾く**。legacy は任意 image mime を Gemini に素通ししていた(`process.ts:288`)ので**後退**。
**fix = `fileType: 'image/webp'` を pin**(1 行・`lib/media/upload.ts:208` COMPRESSION_OPTIONS の既存 precedent と同一・出力を常に enum 内へ collapse)。低リスク・在庫内。

## 4. retry の解消 2 案(§2 の設計判断)

- **案 A(在庫内 fix・client-only)**: `useRef` に `{idempotencyKey, finalizedSourceIds}` を entries 署名で紐付け保持。未変更 entries の retry は同一 key を再利用 → prepareUpload が既存 op を返す → reserve ループは finalizedSourceIds を skip → claim が release 済 'claimed' を re-claim(`claim-operation.ts:271-278`)→ stage/publish。**Codex P1#1+#2 を 2 file 内で解消**。~30-40 行。
  - 難点: **未検証の resume 状態機械を「初 smoke の前」に積む** = 2026-08-02 の reorder 決定(cutover=最小配線で smoke の切り分け土台・未検証実装を積まない)と正面衝突。resume は smoke でしか実証できない → 初 smoke が happy path と resume を同時検証 = 切り分け不能化。entries 変更時の旧 op 無期限 block は残る(受容 abandoned op)。
- **案 B(defer + 誠実 copy)**: 真の resume は**smoke 後の follow-up task**へ。cutover では mid-loop/generic 失敗 copy を「即 retry を約束しない」文言へ修正(現状は OTHER ゆえ「ファイルを変更して再度」を表示=誤誘導)+ 既知制限として文書化。**reorder 決定 + 受容 risk に整合**。smoke は失敗時に手動 op 掃除で回避。prod 前に**必須 follow-up**。

## 5. その他

- **canonical Imp#3**: reserve→PUT→finalize ループの自動 test ゼロ(全 test が `reserved:[]`)。→ non-empty `reserved` + stub fetch の loop test 1 本追加 or「smoke を検証 gate とする」明記。fileType fix の path も同時に踏める。
- **Minor**(記録のみ): 内部 reason code が JA message に露出(`(${staged.reason})` 等・T16 scope)/ catch-all が pre-server の throw も包む(低確率)/ `returnValue` deprecation `[6385]`(既存・handoff 既知)。

## 6. CC 推奨

案 B。理由 = reorder 決定(最小配線→smoke 土台)の尊重・resume は smoke でしか実証不能・stg 0 ユーザー・受容 abandoned op。**cutover では §3 fileType pin + §4B 誠実 copy + §5 loop test を当て、真の resume は post-smoke follow-up(prod 前必須)として起票**。ただし §2 は prod では真の Critical ゆえ OT の明示裁定を仰ぐ(commit tagless は OT 判断後)。

---

## 7. 案 D 実装後の再レビュー(round 2/3・2026-08-02)

**round 2**(案 D + fileType + loop test の full staged diff):
- canonical: Critical 0 / **Important 1** / Minor 4。Imp#1 = **claim/stage/publish の server-side terminalize(persistTerminalFailure/persistManifestIncompleteTerminal/persistTerminalFailedCas)が op のみ terminal 化し source_document を processing に残す** → UI が abandon を呼んでも op 既 terminal ゆえ早期 return し doc を failed 化しない → legacy gate で最大 15 分 block。canonical/Codex round-2 とも当初見逃し、canonical round-2 が捕捉。
- Codex round 2: Crit0/Imp0/Minor0(clean)。

**Imp#1 fix**(CC 吸収・canonical 推奨どおり):`_lib/terminalize-abandoned-operation.ts` に `failSourceDocumentForTerminalOp`(status='processing' guard・冪等)を抽出し、terminalizeAbandonedOperation と abandon の terminal_failed 分岐の両方が使用(op の lastErrorCode/resultSummary は上書きせず元の失敗理由を保持)。abandon iso に RED→GREEN pin 追加 + prepare に multi-op supersede test 2 本追加(canonical Minor 1)。

**round 3**:
- canonical(scoped・fix 検証): **"Resolves the Important"・新規 Crit/Imp 無し**。3 経路とも doc-fail 到達 / guard は abandon・supersede で no-op / 冪等・owner・atomic 健全 / preserved-reason 正当 / 手動 sweep 残骸は targets が 7 日超=STALE_PROCESSING_MS(15分)超ゆえ legacy gate 不発火 + display derivation が failed 描画で無害。
- Codex round 3: **新規 P2(Important)1 件** = **claim 応答喪失 residual**。claim commit 直後に応答喪失/parse throw → catch(abandonLeaseVersion 未設定)→ abandon が token 無しで stale → claimed op が valid lease のまま最大 15 分 block。**self-heal**(期限切れ後 supersede)。

**Codex P2 の CC 裁定 = bounded residual として明示受容(OT 確認要)**: fencing が正しく機能した帰結(token 無しで valid-lease op を clobber するのは実行中 worker 破壊ゆえ不可)。完全解消 = op 状態再取得の往復追加(実ユーザー 0 で YAGNI)or fencing 弱化(unsafe)。cutover 前は無期限 block ゆえ**厳密に改善**。§6.5 と同型 bounded residual として spec §3.1 + ledger に記録。**OT 判断**: 受容(公開前 retry worker/往復回復で再評価)/ 今 fix / follow-up 起票 のいずれか。

**gate**: typecheck0 / whole lint0 / full test:iso 353 / build0 / audit prod-high0。
**commit 方針**: cutover は TAGLESS(stg-smoke gate=cutover smoke ゆえ [reviewed] は smoke 後 session doc)。canonical 最終 Crit0/Imp0(Imp#1 解消)+ Codex P2 は bounded residual 受容(OT 確認要)。
