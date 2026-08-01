# RecallMint 統合ステータス todo v47(2026-07-18〜21 セッション統合)

- 版: **v47**(v46 = OT 管理正本を本体とし、本 doc は 2026-07-18〜21 セッションの全成果を統合した完全版)
- 更新: 2026-07-21 / 種別: 全 sprint 横断ステータス + roadmap
- 位置づけ: claude.ai の view。**最終優先順位は OT 決定が優先**。各ステータスは実コード verify / closure doc / stg 実証に基づく。
- **v46 突合の注記**: 「todo v46」は OT 管理で本 repo に無い。本 v47 は (a) 今セッション成果(完全把握)+ (b) repo-visible backlog(`docs/next-sprints-priority.md` v18 相当 + `docs/cache-fix-roadmap.md` + MEMORY)を統合したもの。**v46 固有の OT 項目(未 repo 化の backlog / 優先順位)は OT が v46→v47 に反映**する前提。参照正本: 各 closure doc / spec / plan(下記 path)。

---

## 0. 本セッション(2026-07-18〜21)= devcontainer 健全化 → テナント隔離基盤 → RLS 本体実証

一本の流れ: **C1/C2(devcontainer 掃除・版 pin)→ Iso-0/1(実 PG 2 テナント統合テスト基盤)→ Perf-0/0b(RLS before 計測)→ RLS-P1(app role 分離)→ RLS-P2(closure 5 表で RLS 本体を実証・stg Phase A-C 合格)**。テナント隔離を「構造 pin(eq-spy)」から「実 PG behavioral + DB 強制(RLS)」へ引き上げた。

---

## 1. ✅ 本セッションでクローズ

### C1 — devcontainer 掃除
- chrome-devtools MCP **全削除**(0/24 セッションで実使用ゼロの実測根拠)/ noVNC 削除 / A-1〜A-7 整理 / post-create postcondition 化(`fail()` 検証)/ deny 2 行。
- 帰結: **Playwright MCP が唯一のブラウザ MCP**。正記録: `docs/superpowers/sessions/2026-07-18-c1-workflow-cleanup-execution.md` / MEMORY `reference_stg` `project_c1_devcontainer_workflow_cleanup`。

### C2 — version pin 統一(f3e6aa5 / 7140945)
- playwright MCP **0.0.78** / context7 **3.2.4** / Codex **0.144.5**(worktree-snapshot contract gate 通過)/ `.devcontainer/README.md` 新設(pin 一覧・更新手順・責務表)/ headless 回帰 fix(`--headless` 明示。`@latest` の壊れ方 = headless 既定の版依存変化 → MCP bump 時の確認項目化)。
- **OT rebuild 待ち**(checklist=C2 doc §7、rebuild 後 `codex login` 再実行必須)。正記録: `docs/superpowers/sessions/2026-07-18-c2-version-pin-unification.md`。

### Iso-0 / Iso-1 — 実 PG 2 テナント統合テスト基盤(launch blocker 解消)
- devcontainer 常駐 **PostgreSQL 17** + `test:iso`(`vitest.integration-pg.config.ts`・単一 fork 直列)+ 2 テナント fixture + 完全性 assertion(三者一致)+ `withTenant`/`asTenant` seam。
- **OCR owner 述語 fix**(completeUploadTx / markFailed に user_id 述語追加)。
- **全 sprint 完了 gate に `test:iso` 恒久組込み**(CLAUDE.md 反映済・無条件)。
- eq-spy の限界を明文化(構造 pin でありテナント隔離の証明でない)。正記録: `docs/audit/2026-07-18-tenant-isolation-integration-test-factfinding.md` / `docs/superpowers/specs/2026-07-18-tenant-isolation-integration-test-design.md`。

### Perf-0 / Perf-0b — RLS before 計測
- RLS(SET LOCAL + tx 包み)が直撃する並列/tx 構造の全列挙: **並列衝突 3 箇所**(/api/pull 6-way・upload RSC N=2・entity-mutations bulk group 並列)/ **§6.6 発見**(runUploadGuardTx が tx 保持中に別接続 read)。before warm p50/p95 = stg 実測(数字表は doc §3.2)。正記録: `docs/audit/2026-07-18-rls-performance-before-factfinding.md`。

### RLS-P1 — 実行 role 分離(ee341f2 [reviewed] 他)
- 非所有者 role **`recallmint_app`**(LOGIN NOSUPERUSER NOBYPASSRLS・CRUD grant のみ)/ `getDb()`=**`DATABASE_URL_APP`** / **無印 `DATABASE_URL` 全廃** / `getAdminDb()`=`DATABASE_URL_ADMIN`(migration/operator)/ owner URL は常設環境に置かず実行時供給。爆発半径制限(DDL/TRUNCATE を app 経路から構造排除)。正記録: `docs/superpowers/specs/2026-07-18-rls-p1-app-role-separation-design.md` / session 同名。

### RLS-P2 — closure 5 表で RLS 本体を実証(range a546be6..2a2debb・全 [reviewed])★本セッションの主成果
- **5 表** {users, exams, cards, tombstones, study_days} に RLS policy 有効化。SDD Task 0-12、canonical + Codex fix loop で **Critical/Important 実バグ 6+ 件捕捉・全収束**、最終 whole-branch review Crit0/Imp0・完全性 sweep clean。
- gate: lint0 / tsc0 / build0 / **test 3781** / **test:iso 143(RLS on)**。
- **stg 実証 Phase A-C 全合格**:
  - Phase A(RLS off・deploy 健全性): read 一巡 全 200・P0RLS 0。
  - Phase B(RLS on・write 含む): entity-mutations/review-events 両 write tx が RLS 下で正常適用・study_days server 反映・**P0RLS 0**。性能 = RLS 自体 ~+6ms(安価)、pull 直列化 ~+47〜69ms(baseline drift と混在・§残件)。
  - Phase C(pooler 純度): A/B 4 boundary × 並行 burst = **~180 req 純度突合・双方向漏れ 0**(300 vs 4 の非対称一度も破れず)。Supavisor 接続再利用で app.user_id 漏れなし。
- **prod は 0025 functions + 新コードまで反映・policy は stg 限定**(Phase 2)。**main への local ff-merge 済(3050f5b)・origin/main は未 push**(push = prod deploy 誘発、0025 prod 適用が前提)。
- 正記録: spec/plan/session `docs/superpowers/{specs,plans,sessions}/2026-07-20-rls-p2-representative-closure*` / runbook `docs/ops/rls-p2-stg-runbook.md` / Codex raw `docs/codex/2026-07-20-rls-p2-task*`。

### テスト品質監査 follow-up(前セッション 3 件のうち 2 件を本セッションで解消)
- ① 実 PG 2 テナント統合テスト = **Iso-1 で解消**。② RLS 導入判断 = **RLS-P1/P2 で実行**。③ ReviewLog 保持 = S2.1 Step 0(未着手・下記 horizon)。

---

## 2. 設計資産(RLS 実証で確立・Phase 3 / 他プロジェクト再利用可)

- **tx-local context**: GUC `app.user_id` を各 tx 冒頭 `set_config('app.user_id', <uuid>::uuid::text, true)`(COMMIT/ROLLBACK で消滅 = pooler 越しで漏れない)。`withTenantTx` / `setTenantContext`(`lib/db/tenant-tx.ts`)。
- **loud 関数** `app_current_user_id()`: 未設定/空文字で **SQLSTATE `P0RLS`** RAISE(silent 0 行を許さない)。cast を set_config に含め不正 uuid を設定時 loud 化。
- **policy 形**: 共通 4 表 = FOR ALL USING=WITH CHECK `user_id=(SELECT app_current_user_id())`(initPlan 化)/ **users = コマンド別**(select・update に `deleted_at IS NULL`・**DELETE policy なし=deny**)。FORCE RLS しない(owner bypass で seed/migrate/operator 素通し)。
- **users bootstrap 循環の解**: **SECURITY DEFINER 3 本**(clerk_id resolve / stripe 4-anchor resolve / scrub・定義者関数ゆえ RLS 素通し・関数自身が条件を書く)。scrub は definer 自衛(p_user_id≠context で RAISE)。
- **claim-first 認証**: getCurrentUser は claim あり=id で read(0 行→null・bootstrap fallback せず)/ claim なし=definer bootstrap。isNull(deletedAt) を app 層でも二重防御(ghost 回帰 fix)。
- **users lifecycle write**: RETURNING/upsert 禁止（**users lifecycle 限定**）+ **事前採番 INSERT** / 退会後 Stripe = **log + skip** / tx 内 外部 I/O 禁止（projectStripeSubscription を分解）。
- **policy 適用機構**: migration にせず versioned SQL(`db/policies/rls-p2-{enable,disable}.sql`・冪等 DROP IF EXISTS 付)+ global-setup 適用。「0025 functions → deploy → policies」の順序を守るため(逆順は P0RLS)。

---

## 3. 学習・原則への追加(本セッション・CC 整理)

1. **RLS 起因の 0 行は既存の意図された冪等吸収(outbox 再送/webhook 再配信/double-click)と識別不能 → loud 設計(context 未設定=例外)の必然**。silent RLS だと全 unchecked-silent 箇所が漏れの隠蔽点化する。
2. **SECURITY DEFINER は RLS を素通しする → 関数自身が条件(自衛検査・最小返却列・p_by allowlist)を書く**。
3. **owner でのテストは policy 未適用の誤認を生む**(SQL Editor / owner 接続は RLS を bypass ゆえ「動いた」が検証にならない)。stimulus は app-role+context、観測のみ owner。
4. **baseline drift 対策 = flip 直前の同日 before 再取得**(runbook §5 に反映済 `3050f5b`)。数日跨ぎ before は network floor/instance 状態 drift でコード変更・RLS 増分を汚染する(実測: pull delta が DB 仕事皆無なのに +77ms)。
5. **`@latest` の壊れ方 = headless 既定の版依存変化**(C2・MCP bump 時は headless 挙動を確認)。
6. **統合レビューの型が機能**: 私案(CC drafting)→ 外部レビュー ×N(GPT/Codex 独立論点・anchor 防止)→ 独自裏取り(現物再確認)→ 現場確認(実装依存の事実確定)→ 統合(誰の指摘か明示・OT 判断)。RLS-P2 で実バグ 6+ 件を捕捉した dual-review + 再 review の実効性の記録。

---

## 4. 次セッション horizon

### 🔜 Phase 3(最優先)= RLS 全表展開 + 標準化
- 残り **14 表(user_id 保持 19 − closure 5)への RLS 展開**(共通形 policy + set_config 配線 = 本 sprint の型の反復)。
- **tx 境界の DDD 整理 = Step 0 正式項目**: use-case 入口で withTenantTx / repository・apply 層は TenantTx のみ受領 / raw getDb 封じ込め(lint / export 制限)。Phase 2 の「5 表 helper の dbc 必須引数」が第一歩。
- **tag 3 表(tag_categories/tag_options/card_tags)+ review-ingest 系(reviews/answer_events/study_sessions)の完全 closure**(Phase 2 で partial 残置)。
- **prod 有効化**(全表 RLS on 後・**§5 の直前 before 計測付き**)。**drizzle pgPolicy** を schema 定義に昇格するか評価(Task 0 = 表現可・非意味差 2 点・schema↔SQL drift-detection test 要)。
- **loud alert 設計**(P0RLS を専用 log event 化・本番展開時 alert 条件)。

### 残件記録(受容済み残余 / trigger 付き)
- **完全同時並行 pooler 検証**(2 device/profile)= 受容済み残余(接続再利用漏れは 180 req で確認済・完全同時は OT)。
- **pull 直列化 +47〜69ms** = 許容確定(背景 sync 経路)。**trigger = Phase 3 計測で継続超過**なら高度化(チャンク分割)起票。
- **列単位 GRANT**(Phase 3+ 検討)。
- **公開前 PII 監査(バケット・公開前にまとめて判断)**: ① stg `DATABASE_URL_APP` パスワード rotation(Wave2 で露出・未実施)② integration_failures が user 削除で scrub されない(clerkId/stripeCustomerId/context jsonb/errorMessage 残置)③ contact_messages を app-role が全行 SELECT 可能に留まる(GDPR `DELETE WHERE user_id` が PG の「WHERE 参照列に SELECT」要求ゆえ RLS-P3 hardening で table SELECT を保持・**列単位 `SELECT(user_id)` 化で app-role の contact 全行 PII 読み取りを解消可**・上記 列単位 GRANT と同トラック)④ **予約残退会の Stripe 掃除確認**(サブスク変更予約を残したまま退会した場合の Stripe subscription/schedule の実掃除。hardening stg 実証の GDPR 退会で `stripe.event.skipped_deleted_user` 後追い無視は確認済だが Stripe dashboard 側の実掃除は未目視)⑤ **scrub 対象列 vs 保持列の PII 棚卸し**(退会 scrub で null 化する列 vs 業務保持する Stripe ID 等の妥当性)。①〜⑤ とも RLS スコープ外・公開前にまとめて判断。
- current_user = recallmint_app(DB `SELECT current_user`)/ server-log P0RLS 確定不在 = OT 残件(browser 不可)。
- **②-2 commit B Minor — ocr.test.ts の success-path mock が thoughtsTokens 未設定**(2026-07-29 記録)。`mockCallGemini` が `vi.fn()`(未型付)ゆえ約20個の success mock が `thoughtsTokens` を欠き、pipeline が costYen を **test 内部で NaN 化**する(どの test も costYen/tokenUsage を assert しないため無害・全 green・production は callGemini の `?? 0` で常に number ゆえ安全)。**trigger = OCR 周辺の mock を次に触る時**。`mockCallGemini` を `GeminiCallResult` 型化すれば全 mock に thoughtsTokens が強制され contract-enforcing に解消(型が付いていれば当初検出できた類)。今は非修正(scope discipline)。詳細 = `docs/superpowers/sessions/2026-07-29-ocr-2-2-migration-phase1.md`。
- **OCR cross-field 検証(正答の整合性)**(2026-07-29 記録・②-3.5 kickoff)。**trigger = 正答が壊れたカードが実際に観測されたら**。現在 zod は型のみ検証で以下がすり抜ける: correct_answer_ids に存在しない option id / is_correct=true の option 集合と correct_answer_ids の不一致 / option id 重複。正答は学習に直接影響するため、型が通っても意味が壊れた状態を検出できていない。
- **OCR 100 問一括投入の分割**(2026-07-29 記録・②-3.5 kickoff)。**trigger = finishReason が MAX_TOKENS になる or 末尾問題の欠落が実際に観測されたら**。現在 1 upload = 1 レスポンスで、出力 token 上限 / 途中打切り / 問題境界混線のリスク。ページ単位 or 10〜20 問単位分割が対処だが、問題がページ跨ぎ / 共通解答群の再結合が必要ゆえ独立した設計判断。
- **解答群重複の再発監視**(2026-07-29 記録・②-3.5 Phase2)。**trigger = 実運用の OCR 出力で選択肢が question_text に重複する事象が再度観測されたら**。②-3.5 の prompt 差し替えで原因(問題タイプ名条件付け + 残余定義の巻き込み)は構造的に潰したが、**3.1-flash-lite で実際に重複する入力での実証は未達**(観測サンプルの重複 dupCount 5/4 は撤回した 3.5-flash-lite の挙動で、維持モデル 3.1 はこのサンプルで元々 0)。実ユーザー 0 の現状で再現追跡はコスト>便益ゆえ再発時に対応。
- **gemini-3.5-flash-lite は OCR モデル移行先候補から除外**(2026-07-29 実測・②-3.5)。組合せ問題で解答群の**完全重複**(全選択肢を question_text に列挙 + options[] にも重複・現行 3.1-flash-lite は重複ゼロ)、`![…](…)` 混入増、軽微な文字落ち(物価指数→物価数)。単価も 3.1-flash-lite より高い(3.5-lite {0.3,2.5} vs 3.1-lite {0.25,1.5})。移行理由なし。**再検討の発動条件 = 3.1-flash-lite に引退予定が announce された時**(将来また候補に挙がった際、同じ検証を繰り返さずに済む)。実測 = `docs/superpowers/specs/2026-07-29-ocr-2-3-5-model-and-answer-group-design.md` §2。
- **②-4a drift seam 群(T8a 収束時に記録・2026-07-31・OT)**。executable-contract 原則(architecture.md §8)の隣接 seam・今は非対処:
  - **T7 `ImageCropExtractedCard` の手書き複製**(`ocr-image-crop-response.ts:37`)。既存 `ExtractedCard` を複製せず `ExtractedCard & { figure_regions?: … }` から導出する方が安全。**発動条件 = T7 schema を次に触る時**。
  - **`FigureRegion` の 3 表現**(TS 型 / Gemini JSON Schema / T8 Zod)。境界が異なり完全統一は困難だが **parity test** が最低限必要。**発動条件 = ②-4b で figure_regions を拡張する時**。
  - **画像 10 枚上限の重複**(`imagesSchema.max(10)` card.ts:142 + client local const upload.ts:63)。**T12 で 3 つ目の `10` を作らないこと**(SSoT 再利用)。
  - **除外理由型の分岐**(T8 の除外理由 vs T16 の表示理由)。**T16 実装時に別の string union を作らない**(共有 contract 再利用)。
  - **source manifest 検証の重複**(T6 claim + T8b stage の read/save)。同一不変条件(count==expected_source_count/全 ready/byte_size NOT NULL)を claim-operation.ts と stage-prepared.ts が各々実装(現状 structurally identical・`isSourceManifestValid` は T8b 内 local)。executable-contract 原則(architecture.md §8)より共有 pure helper へ抽出すべき。**発動条件 = T6 or T8b の manifest 検証を次に触る時**(今は T6 committed 再 touch を避け非対処)。T12 publish も同検証を要すれば同 helper 再利用。
- **`lib/ocr/domain/` への zod ban 追加**(②-4a T8a・2026-07-31・OT 判断)。**発動条件 = `lib/ocr/domain/` に実際に pure 関数が置かれた時**。現状 `lib/ocr` は eslint zod ban 対象外だが、domain zod-free 原則(F3 spec §3.4)は適用される(lint 未強制と原則不適用は別)。path が使われ始めた時点で他 5 domain と同型の ban block を eslint.config.mjs に追加し機械強制へ昇格する。判断記録=`docs/superpowers/sessions/2026-07-31-ocr-2-4a-t8a-normalize-placement.md`。
- **domain dir 内 runtime import の原則化**(②-4a T11・2026-08-01・OT 判断)。**発動条件 = 同種の「domain dir 内 runtime import(zod を transitively 使う SSoT predicate 等)」が 2 例目に出た時**。T11 で `lib/cards/domain/card-asset-refs.ts` が domain dir 初の runtime import(`isAssetKey`=`z.uuid` v4 の SSoT predicate)を導入。reviewer 判定=重複判定 drift 回避のため SSoT 再利用が妥当・code comment で明文化済(現状これで足りる)。OT 判断: **1 例目は formalize 不要・2 例目が出たら eslint-block コメント / 方針化で原則化**する。判断記録=`docs/superpowers/sessions/2026-08-01-ocr-2-4a-t12-checkpoint.md` §5(d)。
- **②-5: R2 staging の aggregate budget**(②-4a T6・2026-07-31・OT 明示受容)。claim の 4MB は **OCR admission limit** であって R2 staging 上限ではない。claim 前に最大 40×5MiB=200MB が R2 に staging されうる(明示受容 bounded residual risk・spec §6.5)。**②-5 で対処**: ① 短期 GC(rejected/abandoned source の早期回収)② operation 作成の反復 rate limit ③ ユーザー quota。**受容成立条件**(現状成立): 40 件・各 5MiB のサーバー強制 / 同一ユーザー active upload 1 件制限 / rejected・abandoned の短 GC 期限 / operation 作成の rate limit or 将来 quota。
- **旧 flow 共存チェックの撤去**(②-4a T4 `prepareUpload`・2026-07-31・OT 指示)。**発動条件 = T16 で UI が新 upload flow に切り替わり、旧 upload flow(`runUploadGuardTx` 経路)が削除された時**。T4 の live-op gate は single-upload 不変条件を新旧両 flow で担保するため `source_documents(status='processing' かつ `STALE_PROCESSING_MS` 以内)` を確認しているが、これは**旧 flow の in-flight 検出専用**(旧 flow は operation 行を作らないため)。旧 flow 消滅後は `upload_operations` の live 判定のみで足り、この source_documents チェックは撤去してよい。コード側にも why コメントを残置済(`prepare-upload.ts` の gate)。Codex fix3 P1 起点。

### Phase 3 の後
- **launch 残件の再棚卸し**(v46 の backlog と突合)。下記 §5 の未着手 backlog を Phase 3 完了時点で再優先度付け。

---

## 5. carry-forward backlog(repo-visible・OT が v46 と突合)

### 短期(launch blocker 寄り)
- **[②-4a-cutover — ②-4a 完了後・②-4b 前の必須独立タスク・2026-08-01 OT 定義]** upload UI を新 flow へ切替。②-4a は server-side-only で新 flow は **UI 未配線**(`upload-form.tsx:434` は今もレガシー `processUpload`)。②-4b(PDF)は「画像入稿と同一経路に合流」前提ゆえ cutover は ②-4b より**前**に必須。
  - upload-form の呼び出し列を新 flow へ: 圧縮 → `prepareUpload` → presigned PUT(temp)→ `finalizeSource` → `claimOperation` →(server: OCR → stage → crop → publish)→ 結果表示。
  - `processUpload`(レガシー)呼び出しの削除。
  - **旧 flow 共存チェック(T4 暫定措置)の撤去** — 既存 follow-up(commit `004edf4` docs(todo): ②-4a 旧 flow 共存チェック撤去 trigger)が**ここで発火**。
  - **end-to-end 一括 smoke**: T10 #4(実 R2 412 冪等)/ #5(実 sharp 決定性)/ #6(§7.3 guard)+ publish 経路(cards / `source_documents completed` / `upload_records` 記帳 / UI)+ T14/T15 の実環境分 → 通過で **T10/T14/T15 の [reviewed] 確定**(T12 は既に session doc で [reviewed])。
  - レガシー `process.ts` の削除タイミング判断。
  - 判断記録=`docs/superpowers/sessions/2026-08-01-ocr-2-4a-t12-checkpoint.md` §8。
- **[triage 未着手・2026-07-24 記録]** 削除済み exam がモバイルに残留する観測: 約1ヶ月前(6月 seed)に削除した **PERF-SEED exam** が モバイル(Chrome / PWA)に残っていた(PC には無し)。**サイトデータ消去で PC と一致**(= server 側は削除済・モバイルの IDB mirror にだけ古い row が残留)。**切り分けが必要**: (a) **削除が pull で伝わらなかった**(tombstone は立っていたが incremental pull が mirror に反映しなかった)= **実バグ** / (b) **6月の seed 削除が SQL 直接操作で tombstone を立てなかっただけ**(通常の削除 UI 経路では tombstone が立つため実害なし)= **非バグ**。後者濃厚だが未確認。関連: `docs/audit/2026-07-13-image-delete-sync-factfinding.md`(削除 sync 機構)/ `docs/recallmint-incremental-pull-steps.md`。**「ログアウト時 IDB クリア」検討とは別問題**(クリアを入れてもこの残留現象自体は直らない=pull 伝播 or tombstone の問題)。画像 sprint の切り分けを濁らせないため**今は調査しない**・記録のみ。
- **LocalSync MVP**(card 編集/削除の local-first 化)— spec 確定・schema scaffold 済・sync helper/bulk route/orchestrator/inline Dexie 化 未着手。inline 編集 ~2.5s→~50ms。母艦: `docs/cache-fix-roadmap.md` §5。
- **試験セットの手動新規作成経路**(OCR 代替・OT 提案)— spec 未着手。schema source 列 / manual dummy 行 / card 手動追加 UI 等の論点。

### 中期(spec/idea)
- **波3**(TS6 + Stripe 22.2.0 + minor 群・dep matrix v1.3 §3.3 正本)。
- **S2.1** FSRS smart 復習(launch-viable minimum)+ **ReviewLog 保持確認**(S2.1 Step 0・card 状態だけでは replay 不能)。
- **S2.0b** tag schema 移行 + inline 編集 + bulk 編集(大スコープ)。
- **S2.2 / S2.3** dashboard / custom 練習。

### 後回し / launch 後
- 選択肢 attach error の表示位置(狭い delete cell・Minor)/ 画像上限 10 枚の単位表示観察 / safe-area(`viewport-fit=cover` 導入時のみ再燃)/ テーブルビュー画像の実 attach smoke(Sprint T 未検証残)/ 複数端末対応を捨てる判断は不可逆。

---

## 6. ワークフロー不変事項(次セッションでも維持)

- sprint フロー: brainstorm→spec→writing-plans→codex-plan-review / 実装 = subagent-driven-development(CLAUDE.md 準拠へ適応 = implementer は commit せず controller が canonical + Codex → [reviewed])。
- review→commit の一方向則 / feat・fix は canonical(requesting-code-review デフォルト経路)+ Codex 必須 / 重要 fix(決済・認証・削除)は runtime 検証 = stg smoke。
- 完了 gate: whole-repo lint(--max-warnings=0)+ test:iso green を全 sprint 無条件。依存/Next/lockfile 触る時は install --frozen-lockfile + typecheck + build 追加。
- OT 出力規律: chat は結論のみ・番号 bullet・判断必要 yes/no・詳細は doc path。
