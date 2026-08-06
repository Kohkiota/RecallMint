# ②-4a セッション引き継ぎ(T14a close 時点・cutover 実装中)

**日付**: 2026-08-02
**理由**: context 逼迫ゆえ T14a close の切りで停止・記録。
**正本 ledger**: `.superpowers/sdd/2026-07-30-ocr-2-4a-image-figure-crop/progress.md`(最新まで詳細)
**plan**: `docs/superpowers/plans/2026-07-30-ocr-2-4a-image-figure-crop.md`(実行順序改訂 2 回・Phase Cut あり)

---

## 1. 実行順序(現行・2 回改訂済)

`T13 → T10 → T11 → T12(a+b・checkpoint)→ T14a → **②-4a-cutover** → OT 手動 smoke → 実測 → T14b → T15 → T16`

- **2026-08-01 改訂**: T13 を T12 の前へ(applyOcrTags determinism 前方参照)。
- **2026-08-02 改訂**: cutover 前倒し(検証の土台化)。未検証実装を積んで初 smoke だと切り分け不能ゆえ、UI 配線を T14b 前に入れて実機で測る。

## 2. 完了タスクと tag(develop・一部未 push)

| task | commit | tag | 検証 |
|---|---|---|---|
| T13 applyOcrTags determinism | `72a2eb2` | **[reviewed]** | iso |
| T10 crop+R2+provenance | `dc45711` | **tagless** | iso(#4/#5/#6 は mock=cutover smoke で実環境検証) |
| T11 projectCardAssetRefs 抽出 | `a6cce9f` | **[reviewed]** | iso drift test |
| T12a publish+fencing | `cc2b196` | **tagless** | iso・[reviewed]=session doc(2026-08-01-t12-checkpoint.md §8) |
| T12b prepared takeover | `3bae12d` | **tagless** | iso・[reviewed]=同上 |
| T14a lifecycle(deadline/7日cap/reconciler/display/手動sweep) | `709fc06` | **tagless** | iso339・[reviewed]=cutover smoke 後 |

**tagless の [reviewed] 正記録** = cutover smoke 後に session doc へ(OT 決定: T14/T15/T16 の stg-smoke gate = cutover smoke に統合)。**push 済 commit の tag 後付けはしない**。
**push 状態**: OT が T12 checkpoint 時に `469d0ff` まで push。以降(smoke-finding `da4a6e7` / plan reorder `57833ce` / spec §11 `05d42e8` / T14a `709fc06` / codex `01322d2`)は**未 push の可能性**。resume 時 `git log origin/develop..HEAD` で確認。

## 3. cutover(実装 DONE・**staged 未 commit 未 review**)

**agent = `acfea9397a86564e1`(sonnet・stage-only)= 完了**。report = `task-cutover-report.md`。
- **staged files**: `app/(app)/app/upload/_components/upload-form.tsx` + `upload-form.test.tsx`(2 file のみ・`process.ts` 無変更・server action 無変更を git diff で確認済)。
- **wired sequence**: 圧縮(既存)→ getImageDimensions → prepareUpload → per-source{reserveSource(※実名 `reserveSource`・brief の `reserveSourceAsset` は誤記)→ client fetch PUT(R2 presigned temp)→ finalizeSource}\* → claimOperation → stagePrepared(**prepared_taken_over 時は skip**)→ publishPreparedUpload → 既存 result page へ router.push。leaseVersion 貫通。
- **gate**: typecheck0 / whole lint0 / build0(SWC 71011 なし)/ `vitest app/(app)/app/upload` 141/141(upload-form.test 18/18)。
- **concerns(report より)**: (1) **PDF は pre-flight で明示 block**(新 flow は images-only=②-4b で PDF)→ OT smoke で PDF submission は「拒否 message」表示(OCR されない)= 正しい挙動。(2) 実名 `reserveSource`。(3) 既存 result page は無変更で動く(owner-scope join・status filter なし)。
- **既知 diagnostic**: `upload-form.tsx:200 'returnValue' is deprecated [6385]`(Minor deprecation・cutover review で確認)。
- **★ RESUME 手順(次セッション最優先)**: staged 2 file を **canonical(requesting-code-review デフォルト経路)+ Codex(`scripts/ai/codex-review.sh ocr-2-4a-cutover`)で review** → fix loop Crit0/Imp0 → **commit tagless**(Phase Cut・feat・stg-smoke=cutover smoke ゆえ [reviewed] は smoke 後)+ codex md docs[no-review]。→ その後 §4 の smoke 手順書を OT へ提示して停止。**cutover は feat ゆえ commit 前に必ず review(implementer STAGE のみ)**。

## 4. cutover 後 = OT 手動 smoke(実測が主目的)

CC は cutover close 時に **smoke 手順書**を提示して停止:
- 何を上げれば何が起きるか(期待画面遷移・完了表示)/ **DB 確認 SQL**(upload_operations status=completed / cards / source_documents completed / upload_records pages_processed / assets ready / asset_derivations)/ **R2 key 形式**(source 最終 key / crop `users/{userId}/{figureAssetId}.webp`)/ **失敗時ログ箇所**。
- **T10 6 基準**: #4 冪等(**同ファイル 2 回上げ** → reused・行数不変)/ #5 決定性(同 hash)/ #6 §7.3 guard。
- **実測箇所(ログ出力)**: Gemini 応答時間(1枚/複数/PDF)/ crop 1 枚所要(実 R2+sharp)/ upload 全体。→ この実測で **時間予算(CROP_PHASE_BUDGET 暫定 / CROP_MIN_REMAINING 5s 暫定 / sharp timeout 30s 暫定 / OCR 720s)・retry 回数・ページ数上限を決める**。現値は全て暫定。

OT が push → 手動 smoke → 結果を見て T14b 以降再開。cutover [reviewed] + T10/T12/T14a [reviewed] を smoke 後に session doc 記録。

## 5. 残タスク(smoke 後)

- **T14b**: source_assets GC lane(`gc-image-assets.ts` に共通化 + stale temp `src/tmp/` delete・**破壊**・tagless→cutover/実機 smoke)。
- **T15**: GDPR Group I(退会経路に upload_operations/source_assets 追加・**破壊**)。
- **T16**: 提示(除外理由別件数)+ 回転除外(EXIF≠1)。
- **①-4a-cutover-followup(T14a fix#1 由来)**: cutover の end-to-end smoke で display op-aware(live-op バッジ)を確認。

## 6. carryover / 申し送り

- **時間予算は全て暫定**(§4 の実測で確定)。実測前に配分理屈を積まない(OT 方針)。
- **deadline P2 = per-invocation で確定**(operation-wide persist しない・spec §11 明文化済 `05d42e8`)。operation 全体上限 = 7 日 retention cap。
- **T12 checkpoint 持ち越し(OT bless 済)**: (a) bumpExamCardCount を exam FOR UPDATE 代替 (b) counter を refs より前に書く (c) dup-card-id→retryable(7日 cap backstop)(d) domain-purity 先例(`lib/cards/domain/card-asset-refs.ts` の isAssetKey=transitively zod・2 例目で eslint 原則化 = trigger 付き follow-up・台帳は claude.ai 管理の todo)(e) T12b old-worker test の fence-leg wording。詳細=`2026-08-01-ocr-2-4a-t12-checkpoint.md` §5。
- **abandoned op PII**: T14a `#3` 手動 sweep `scripts/gc-abandoned-operations.ts`(operator 手動・dry-run/--user)で対処済(aged-out 非終端 op → terminal_failed + payload NULL)。cron 化は post-cutover ops。
- **completeUploadTx 相当の scope 訂正**(T12a fix3・OT 承認): publish が source_documents.status='completed' + upload_records 記帳(pages_processed=画像数=月次 quota SUM 源)。記帳=②-4a・quota 強制=②-5。spec §8.2 明文化済。
- **null-lease SQL 3-valued-logic 教訓**(T14a fix3): `not(and(..., lease>now()))` は lease NULL で NULL→row 除外。DI-mock は SQL NULL を捕まえない → real-PG iso test 必須。共有述語 `isLiveUploadOperationCondition` は `isNotNull` guard で NULL-safe 化済。
- **audit dev allowlist**: `brace-expansion@1.1.16`(GHSA-mh99-v99m-4gvg・expiry 2026-08-22)受容中。prod high 0。

## 7. gate 現状(T14a close 時点)

whole-repo lint 0 / typecheck 0 / **test:iso 339** / build 0 / audit prod-high 0。tree clean(cutover agent 完了で upload-form.tsx が staged 化する見込み)。

## 8. review flow(この sprint で確立・維持)

feat = implementer STAGES only(commit しない)→ controller が canonical(`requesting-code-review` デフォルト経路・general-purpose + code-reviewer.md 改変なし)+ Codex(`scripts/ai/codex-review.sh <topic>`)→ fix loop(Crit0/Imp0)→ controller commit。canonical と Codex の食い違いは **repo 現物で裁定**(本 session で Codex が canonical の見逃し[source_document null / null-lease SQL 3VL]を複数回補足=dual-review の価値)。implementer は毎回 files を unstage のまま返す癖あり → controller が `git add`。
