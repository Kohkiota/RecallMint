# RecallMint repo-wide 監査 — 2026-06-12 (Codex 統合版)

- **起票日**: 2026-06-12
- **位置づけ**: production レベルで許容できない実装 / セキュリティホール / 構造的負債の全件棚卸し。 **対応時期は OT が別途決める** (本 doc は調査結果の保管庫であり、 着手 sprint の roadmap ではない)。
- **scope**: `app/` `lib/` `components/` `types/` `proxy.ts` `instrumentation.ts` `next.config.ts` `.env.example` / 関連 schema (`drizzle/`)。 `node_modules/` `.next/` `.playwright-mcp/` は対象外。
- **手法**: 領域ごと fresh general-purpose subagent で並列監査 (Claude Code 7 領域) → controller (本 file) が集約。 並行に GPT-5 Codex も同 repo を独立に監査 (`docs/codex/2026-06-12-repo-wide-audit.md`)。 両者の finding を controller が突き合わせ、 各 finding に出典マークを付与:
  - **[both]** — Claude Code subagent と Codex の両方が独立に発見 (= confidence 高)
  - **[Codex-only]** — Codex 側のみが発見、 CC subagent が見逃した項目
  - 無印 — CC subagent のみ (CC-only の含意)
- **severity 統一基準** (2 監査の整合のため再裁定済):
  - **P0**: silent data loss / security hole に限定 (例: lost write、 認可全欠落、 secret 漏洩)
  - **P1**: launch 前必須 (例: perf スケール阻害、 retry controller と矛盾する error handling、 production fail-fast 不在)
  - **P2**: launch 後短期対応 (hardening、 観測性、 構造的負債で運用上問題化しうるもの)
  - **P3**: 中期・nice-to-have (cosmetic、 dead code、 重複)
  - perf スケール阻害は**最高 P1** (launch 前必須対応として §7 で扱う、 P0 ではない)。 初版で §1.2 に P0 で挙げた perf 5 件は本基準で **P1 に降格** し §7 perf に移管。
- **重複登録方針**: 「既知の合流」 (各領域末尾と §9 巻末) に file:line 列挙のみで再掲、 新規欄には入れない。 既知の出典は `docs/codex/2026-06-08-codex-review.md` / `docs/next-sprints-priority.md` / `docs/superpowers/specs/2026-06-08-tag-4c-2a-*-design.md` (Sync-fix-1) / `docs/superpowers/sessions/2026-05-21-s1-9-5-*` (GDPR cascade) / `docs/recallmint-incremental-pull-steps.md` (Phase 4)。
- **重要前提**: 修正着手は本 sprint では一切行わない。 各 finding に `工数` 推定は付けるが、 優先順位は §1 P0 + §10 仕分けに対し OT が決定する。

---

## 1. P0 — silent data loss / security hole (production 上の穴)

統一基準で再裁定: **P0 = silent data loss または security hole のみ**。 perf スケール阻害は最高 P1 (§7 perf 領域、 7.1 で扱う)。 §1.2 の perf 5 件は降格して §7.1 へ移管した。

### 1.1 lost write 経路 (silent data integrity hole)

- [P0] [both] `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:161-205` (`handleAddCard`) — `cards.add` の await 直後に `enqueueEntityMutation` を await + `.catch(...)` で握り潰し。 enqueue 失敗時に **mirror に card 行が残り outbox に行がない** → server に新 card が永遠に到達せず、 他端末・次回 pull で「追加したのに消える」 silent lost write。
  - **両者発見**だが分類が分かれた: CC subagent は「既知 Sync-fix-1 list に明示掲載なし」 として新規 P0 扱い、 Codex は Sync-fix-1 既知合流 P1 扱い (Codex 行 53)。 silent data loss なので厳しい方の **P0 を採用**。
  - 推奨: `db.transaction('rw', db.cards, db.entity_mutations, ...)` で囲み、 enqueue throw → Dexie auto-rollback の atomic 化 (`card-tags-section.tsx handleToggle` 行 611-661 が reference 実装)。 工数: S
- [P0] [both] `app/(app)/app/exams/[id]/_components/delete-card-button.tsx:36-52` (`onConfirmDelete`) — `cards.delete` の await 直後に `enqueueEntityMutation({op:'delete', ...}).catch(()=>{})`。 mirror remove 後 enqueue 失敗で **server 側 card 残置 + tombstone なし** → 他端末で card が消えない Phantom card。 user は UI 上で「削除済」 と認識。
  - 同上、 CC は新規 P0、 Codex は新規欄 P2 (行 18) + Sync-fix-1 既知合流 P1 (行 53) の両方で言及。 silent data loss なので **P0 を採用**。
  - 推奨: 同上 atomic 化。 工数: S

### 1.2 perf スケール阻害 — §7.1 P1 に移管 (再裁定)

§1 P0 から削除し、 §7.1「perf スケール阻害 (launch 前必須)」 に P1 として再配置。 対象 5 件:
- review-events/bulk study_days SQL N+1 (route.ts:376-405)
- entity-mutations/bulk per-mutation tx 逐次 (route.ts:184-205)
- exam-list-live 全 cards 全件ロード (exam-list-live.tsx:30-31)
- inline-card-list 全 card_tags 全件ロード (inline-card-list.tsx:91-96)
- dashboard-actions 全 cards + JS filter (dashboard-actions.tsx:36-41)

---

## 2. 領域1 — セキュリティ

監査対象: 認可漏れ (IDOR) / 入力検証漏れ / secret log 出力 / rate limit 不在 / webhook 署名検証 / CSP・security headers。

**全体評価**: P0 ホール無し。 全 API route / server action で `getCurrentUser()` 由来の認証済 userId のみが DB filter として使われ、 URL/body の user-supplied id を信用する場所は発見されず。 webhook 署名検証 (svix / Stripe constructEvent) と raw body 取得 (`req.text()`) も正しく適用済。 Stripe/Clerk env prefix fail-fast 済、 secret env のログ出力なし (名前のみ)、 `key.slice(0, 8)` で prefix までしか露出しない。

### 新規発見

- [P2] [both] `lib/ai/clients/gemini.ts:138-145` — `OCR_DEBUG_LOG=1` で Gemini response の **生 OCR テキスト先頭 50000 文字** を Vercel logs に書き出す。 試験本文 / 個人ノート等 PII。 staging 限定とコメントされているが production で誤って `1` を設定する事故面が残る (Codex 行 23 でも production 強制無効化推奨)。 工数 S。 (運用領域 §8.1 P1 と統合 fix 可)
- [P2] [both] `app/(marketing)/contact/actions.ts:19-85` — public server action でレート制限ゼロ (Codex 行 22 で同問題指摘、 per-IP/email/session の abuse counter 推奨)。 工数 M
- [P2] `proxy.ts:24-29` — matcher が `/api/(.*)` を全包含し webhook も clerkMiddleware 経由。 動作はするが clerkMiddleware コストの浪費 + `CLERK_SECRET_KEY` 未設定状態で webhook が触れて `lib/clerk.ts` fail-fast → 500 retry-loop する初期構成事故面。 推奨: matcher から `/api/webhooks/(.*)` を除外。 工数 S
- [P2] [Codex-only] `app/api/review-events/bulk/route.ts:62, 499` — `session.card_ids` に `.max()` 上限なし、 認証済み client が**巨大 UUID 配列を DB に保存可能** (storage / request 処理 DoS 余地)。 推奨: realistic max を zod に追加 + DB write 前 reject。 工数 S
- [P2] [Codex-only] `app/api/review-events/bulk/route.ts:71, 209` — `selected_answer_ids` が `z.array(z.string())` のみで item format / length / array size bound なし。 1000 events に unbounded JSON payload を積める。 推奨: option ID format + length 検証 + 配列長を card option 上限に cap。 工数 S
- [P2] [both] `app/api/me/deletion-status/route.ts:33-39` — userId 列挙 oracle (codex #6 を裏付け、 Codex 行 29 + 行 55 で既知扱い)。 CC 視点で P2、 Codex 視点 P3。 厳しい方 **P2 採用**。 工数 S
- [P3] `app/api/entity-mutations/bulk/route.ts:48-60` / `app/api/review-events/bulk/route.ts:83-87` — per-payload 1000 件上限あるが per-user 単位時間頻度に制限なし (DB CPU / Vercel 関数費用 DoS 余地)。 工数 M
- [P3] `next.config.ts:9-18` — `Permissions-Policy` header 不設定。 工数 S
- [P3] [both] `next.config.ts:9-18` + `proxy.ts:19` — CSP は `frame-ancestors 'none'` のみ。 `default-src` / `script-src` / `connect-src` / `img-src` / `base-uri` の app-level policy なし (Codex 行 28 で同問題、 report-only から rollout 推奨)。 工数 M
- [P3] `lib/auth/clerk-metadata.ts:55-57` — `console.debug` が `clerkId` を平文出力 (PII)。 `logger.info` 化。 工数 S
- [P3] `app/(app)/app/upload/_actions/process.ts:303-309` — `logger.warn({event:'gemini.daily_limit.disabled', raw: process.env.GEMINI_DAILY_LIMIT ?? null})` で env 値直埋め。 工数 S
- [P3] `app/api/review-events/bulk/route.ts:419` — `serializeDbError(err, { cardIds: events.map((e) => e.card_id) })` で全 event card_id を error log に展開 (log noise)。 工数 S

### 既知の合流

- `app/api/me/deletion-status/route.ts:19-39` (codex #6)
- `app/api/pull/route.ts:73-89` (codex #2、 Phase 4)
- Sync-fix-1: void enqueue + 空文字 user_id 多数 (§3 / §5 既知欄参照)
- GDPR physical cascade (s1-9-5)
- webhook runbook (codex #7)
- `lib/stripe/price-mapping.ts` import 境界 (codex #5)

---

## 3. 領域2 — データ整合性

監査対象: Dexie tx の external await / outbox 重複・喪失 / last-write-wins 競合 / tombstone・cascade 漏れ / migration と schema 乖離 / idempotency。

P0 は §1.1 (inline-card-list / delete-card-button) を参照。 ここでは P1〜P3。

### 新規発見

- [P1] [Codex-only] `app/(app)/app/_components/entity-mutation-flush-trigger.tsx:36, :62` + `lib/sync/entity-mutations.ts:177` — entity mutation outbox の **24h 超 pending を mount 時に `failed` へ自動隔離**する。 長時間 offline / sleep 後の編集が自動 retry 対象から外れ、 ユーザー復旧動線もない。 durable outbox は本来 backoff retry を継続すべき。 推奨: 自動 failed 化を撤去し backoff retry を継続、 失敗隔離が要るなら UI で recover / retry 可能な queue として扱う。 工数 S
- [P1] [both] `app/(app)/app/exams/[id]/_components/inline-text-field.tsx:168-189` — commit で `void cards.update(...)` と `void enqueueEntityMutation(...)` を並行 fire-and-forget。 reference 実装 (handleToggle) と異なり atomic 化されていない (Codex 行 53 で Sync-fix-1 既知合流 P1 扱い)。 推奨: atomic 化。 工数 S
- [P1] [both] `app/(app)/app/exams/[id]/_components/inline-option-row.tsx:185-213` — 同 pattern (Codex 行 53)。 工数 S
- [P1] `lib/sync/server/entity-mutation-registry.ts:333-336` + `lib/tags/apply-tag-mutation.ts:188-192` — tag_option create の事前 dup check が**自分自身の id を除外していない**。 mutation_id 早期 skip が log INSERT 並走 race で機能しないケースで再送時に「既存 row が見つかる → 'failed'」 となり user が同名 option を作れなくなる (実際は作成成功)。 推奨: dup check に `AND id != optionId`。 工数 S
- [P1] `lib/db/schema.ts:255,324` — `content_version` 列が exams/cards 双方で宣言済 + client-db 索引持ち、 だが apply / pull / bulk receiver で**参照・増分されていない**。 LWW は updated_at のみに依存、 同一 ms 内競合の lost update 防止手段なし。 推奨: 用途決定 (廃止 or 実装)。 工数 M
- [P2] [Codex-only] `app/api/review-events/bulk/route.ts:409, :548` + `lib/sync/review-flush.ts:66` — review events の tx rollback を `failed[]` + HTTP 200 に変換するため、 client は `httpStatus: 200` を permanent と分類し **transient DB 障害でも自動 retry が止まる**。 推奨: tx-level infra failure は 5xx で返すか retryable failure kind を response に含める (orphan / validation failure と DB failure を分離)。 工数 M
- [P2] [Codex-only] `app/api/entity-mutations/bulk/route.ts:193, :207` + `lib/sync/entity-mutations.ts:281` — 同問題が entity mutation 経路にも。 予期しない DB error も `failed[]` + HTTP 200 に混ぜるため transient write failure が permanent 扱い。 工数 M
- [P2] [Codex-only] `app/api/entity-mutations/bulk/route.ts:184, :186` + `app/(app)/app/exams/[id]/_components/card-tags-section.tsx:475` — dependent multi-mutation が server で mutation ごとの独立 tx として処理される。 tag option create が commit 済みで、 対応する card `tag_option_ids` update だけ失敗する **partial state** がありうる。 推奨: atomic mutation group か create-and-assign の compound operation。 工数 M
- [P2] `lib/cards/card-field-handlers.ts:192-241` (`handleTagOptionIds`) — whole-set replace で 2 タブ並行 LWW 競合 (後勝ち = 片方が消える)。 docs 上「案 a 取り直し」 で許容なら設計通り。 工数 L
- [P2] `lib/sync/entity-mutations.ts:81-87` — `enqueueEntityMutation` の coalesce が全 pending 行 `.toArray()` + in-memory filter。 schema 既存の `[entity_type+entity_id]` compound index 不使用。 工数 S (§7 perf P1 と統合 fix 可)
- [P2] `app/api/entity-mutations/bulk/route.ts:184-205` — per-mutation tx 逐次 (§7.1 P1 と同件、 partial-apply guarantee 軸の側面)。
- [P2] `app/api/review-events/bulk/route.ts:506-524` — events INSERT 前に session の user_id と認証 user.id の比較なし。 attacker session_id 流入は cards owner-scope で 0 件、 実害なし防御余地のみ。 工数 S
- [P2] `lib/sync/pull.ts:192-288` — pull 1 tx で 6 store の bulk 操作、 stream 無制限 (既知 #2)。 工数 M (Phase 4)
- [P2] [both] `app/(app)/app/exams/[id]/_components/card-tags-section.tsx:111-138` — `handleRenameCategory` 系 4 関数の mirror update → enqueue await → throw 時 mirror revert を `.catch(...)` 握り潰し。 throw 自体は rethrown だが mirror 不整合は残置 (Codex 行 63 Sync-fix-1 既知合流)。 工数 M
- [P3] [Codex-only] `lib/client-db.ts:253, :255, :256` — Dexie v3 migration が `card_mutations` table を migrate せず drop。 pending mutation が残る client では local write が失われる。 推奨: 旧 `card_mutations` を `entity_mutations` へ migrate するか、 outbox empty を確認する upgrade gate。 工数 M (launch 前か launch 後にユーザーがいる時点で実施は不可逆、 タイミング判断必要)

### 既知の合流

- `card-tags-section.tsx:611-661` handleToggle (reference 実装、 rename/color は tx 外設計)
- Sync-fix-1 一斉差し替え対象 (§9 巻末 table 参照)
- `inline-option-row.tsx` refs structural (Sync-fix-1)
- `app/api/pull/route.ts:82-89` ほか pull stream 無制限 (codex #2)
- `app/api/webhooks/clerk/route.ts:226-287` (GDPR s1-9-5)
- schema コメント保守性 (codex #8)

---

## 4. 領域3 — エラー処理

監査対象: 握り潰し catch / 200-swallow / silent fail / `String(err)` 情報落ち / unknown cast / error response への内部情報混入。

**全体評価**: P0 無し。 webhook 200 swallow / OCR / Stripe webhook 等の主要経路は `notifyOps + logger.error + 200 return` 一貫、 重大な情報漏洩は新規発見されず。

### 新規発見

#### 4.1 `String(err)` の情報落ち (Sync-fix-1 周辺の client log 大量)

- [P2] 同 pattern (logger 経由で `String(err)` inline) を 23+ callsite で確認 (詳細 file:line は §5 §5.1 23+ ボイラープレート参照、 fix は §5 dup 集約 + logger 拡張で同時解消)。 個別 P2、 集約 fix で 工数 S
- [P3] `app/api/webhooks/clerk/route.ts:206, 214-215, 390-391` — webhook recordFailure の `String(err)` (admin grep 用、 既知 s1-9-5 trace)。

#### 4.2 silent fail

- [P1] `app/(app)/app/exams/[id]/_components/delete-card-button.tsx:49` — §1.1 P0 と同件。
- [P2] `app/(app)/app/study/smart/_components/session-runner.tsx:301-303, 318, 324` — answer event Dexie write / flush / `completeStudySession` 失敗を完全 silent。 工数 S
- [P2] `app/(app)/app/upload/_components/upload-form.tsx:435` — `processUpload` throw を握り潰し、 client console すら出ない。 工数 S
- [P3] `app/(app)/app/study/smart/page.tsx:36` — server fetch 失敗 silent (Dexie fallback あり)、 server 側 logger.warn 推奨。 工数 S
- [P3] `app/(app)/app/upgrade/page.tsx:43` — `resolveActiveSubscription` failure silent、 page render 側 logger.warn 推奨。 工数 S

#### 4.3 client fetch silent (`.catch(() => null)`)

- [P2] `lib/sync/pull.ts:101, 105, 153` — `defaultClient.get` の json parse 失敗 / fetch throw を silent に `{ok:false, status:0, body:null}` 化。 連続失敗の検知が欠落。 推奨: sync_meta に `lastPullError` 追加。 工数 M
- [P2] 同形: `lib/sync/study-days.ts:41, 45, 57` / `review-events.ts:252, 256` / `entity-mutations.ts:221, 225`。
- [P3] `app/(app)/app/_components/exam-status-live.tsx:113, 119, 137` — OCR status poll fetch error silent (polling 設計上適切)。

#### 4.4 握り潰し catch

- [P2] `app/api/webhooks/clerk/route.ts:79` — svix.verify failure を `catch {` で 400、 ログなし。 Stripe webhook 行 35 と pattern を揃える。 工数 S
- [P2] `app/api/entity-mutations/bulk/route.ts:166` — `catch {` で invalid_json、 ログなし。 工数 S
- [P2] `app/api/review-events/bulk/route.ts:473` — 同上。 工数 S
- [P3] `app/(app)/app/upload/_actions/process.ts:184` — `pdfPageCount` 失敗 `catch {` で 1 ページ fallback (証跡 logger.info 推奨、 quota 関連調査用)。 工数 S
- [P3] `lib/exams/ocr-poll-signal.ts:39` / `lib/logger.ts:64` / `app/global-error.tsx` — pub/sub / 二重 throw / uncaught fallback (by-design + server 側 instrumentation でカバー)。

#### 4.5 error response への内部情報混入

- [P1] `app/(app)/app/upload/_actions/process.ts:447, 499, 573, 637` — `details.rawError` に `err.message` 生入り。 client 表示は `NEXT_PUBLIC_VERCEL_ENV !== 'production'` で gate されているが **server action 戻り値そのものは network 上 production でも client に送られる**ため production DevTools で raw error が見える。 推奨: server 側 gate を追加。 工数 M
- [P2] `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx:567, 575, 625, 633` — `setLastError(e instanceof Error ? e.message : String(e))` を popover UI に出力。 意図的 user message と内部 error の混在。 工数 M
- [P2] `card-tag-edit-popover.tsx:212, 220` — 同上。 工数 S
- [P2] `app/(app)/app/settings/delete-button.tsx:60-66` — staging のみ表示 (production gate 済)。 工数 S

### 既知の合流

- `lib/ai/ocr.ts:125-127` callWithRetry onAttempt catch (codex #3)
- `app/api/me/deletion-status/route.ts:1-59` (codex #6)
- `app/api/webhooks/clerk/route.ts:206, 214-215, 390-391` (`String(err)` s1-9-5)
- `webhooks/clerk/route.ts:103-113` / `stripe/route.ts:55-67` (200 swallow runbook codex #7)
- String(err) 統一 (codex 既知合流、 shared serializer 化)

---

## 5. 領域4 — 重複・無駄

監査対象: コピペ実装 / dead code / 未使用 export / 同一ロジック多重実装。

**全体評価**: 構造的負債は厚いが production 上の穴ではない。 Sync-fix-1 sprint の収束ターゲットとして妥当な list。

### 新規発見

#### 5.1 コピペ実装

- [P1] [both] `app/(app)/app/tags/_components/option-row.tsx:118-161` (`enqueueUpdate`) — optimistic IDB update + `enqueueEntityMutation` + debounce drain 40+ 行 が `category-row.tsx:86-124` と論理同形、 `inline-text-field.tsx:153-204` も同構造 (Codex 行 39 P3)。 推奨: `lib/sync/use-optimistic-mutation.ts` 共通 hook。 工数 M
- [P1] `app/(app)/app/exams/[id]/_components/card-tags-section.tsx:111-234` — 4 関数 (`handleRenameCategory` / `handleSetCategoryColor` / `handleRenameOption` / `handleSetOptionColor`) が 25 行 pattern を 1:1 コピペ展開。 推奨: 1 関数統合 (Sync-fix-1 と同タイミング)。 工数 M
- [P1] `inline-text-field.tsx:73-301` と `inline-option-row.tsx:459-585` (`InlineOptionCell`) — `sharedBoxChrome` 等 100+ 行コピペ。 推奨: 共通 `inline-editable-cell.tsx` primitive。 工数 L
- [P1] `lib/tags/reorder-handlers.ts:42-81` と `:88-129` — 40 行 pattern を 2 関数で 1:1。 工数 S
- [P1] `review-flush-trigger.tsx:25-67` / `entity-mutation-flush-trigger.tsx:39-107` / `pull-trigger.tsx:38-73` — mount kick + 3 種 listener の 40+ 行 trigger ボイラープレート 3 file 同形。 工数 S
- [P1] [both] `lib/sync/entity-mutation-flush.ts:31-88` と `lib/sync/review-flush.ts:33-120` — Web Locks wrapping 60 行 (LOCK_NAME と flushAll のみ差) — `pull.ts:310` も同 pattern (Codex 行 62 Sync-fix-1 既知合流 P2)。 推奨: `lib/sync/with-web-lock.ts` で 1 関数化。 工数 S
- [P1] [both] `option-create-form.tsx:65-121` と `category-create-form.tsx:49-103` — submit pattern 50+ 行同形 (Codex 行 40 P3)。 工数 S
- [P1] `delete-card-button.tsx:55-136` と `delete-exam-button.tsx:50-131` — 4 phase ボタン UI render 80 行同形。 推奨: `<TwoPhaseDeleteButton>` primitive。 工数 S
- [P1] [both] `category-list.tsx:242-286` と `option-list.tsx:200-256` — DnD handler + JSX 同形 (Codex 行 41 P3 で cascade delete 側を別途指摘)。 工数 M
- [P2] `save-session-limit.ts:9-39` と `save-fsrs-mode.ts:15-42` — user_settings UPSERT pattern。 工数 S
- [P2] `lib/ai-usage-mcq.ts:32` と `process.ts:329` — UTC→JST 月境界 / HH:mm shift をインライン再実装。 推奨: `lib/jst.ts` に `toJstDate(d)` 追加。 工数 S
- [P2] 23+ 箇所 — `.catch((err) => logger.warn({ event: '...failed', id, err: String(err) }))` boilerplate。 領域3 §4.1 の `String(err)` 問題と統合 fix 可能。 推奨: `logger.warnFromError(event, ctx)` ヘルパ。 工数 S
- [P3] [Codex-only] `lib/sync/review-events.ts:32` と `lib/sync/entity-mutations.ts:25` — `newId()` helper が outbox ごとに重複 (Codex 行 61 Sync-fix-1 既知合流)。 推奨: client-safe UUID helper 共有化。 工数 S
- [P3] [Codex-only] `lib/db/cards-pull.ts:20`, `exams-pull.ts:27`, `tag-categories-pull.ts:33`, `tag-options-pull.ts:32`, `tombstones-pull.ts:28`, `card-tags-pull.ts:35` — delta pull helpers が tenant filter / cursor filter / select-map-max を重複実装 (Codex 行 38)。 推奨: typed helper を抽出。 工数 M

#### 5.2 dead code / 未使用 export (repo grep 0 件)

- [P1] [both] `lib/sync/review-events.ts:79 abandonStudySession` — 完全 dead (Codex 行 43)。 工数 S
- [P1] `lib/ai/clients/gemini.ts:29 _resetClientForTests` — 参照 0。 工数 S
- [P2] `lib/ai/schemas/ocr-response.ts:14 ExtractedOption / :21 ExtractedImage / :39 DiscoverResponse` — 参照 0。 工数 S
- [P2] `lib/db/schema.ts` の `New*` Drizzle insert 型 18 個 — 全て参照 0。 工数 S
- [P2] `lib/db/schema.ts` の select 型 11 個 — 参照 0。 工数 S
- [P2] `lib/sync/server/entity-mutation-registry.ts:290 ENTITY_MUTATION_REGISTRY` — `getEntityHandler` のみ参照 → module-private で十分。 工数 S
- [P2] `lib/tags/apply-tag-mutation.ts:30,60,62,165,211,213` の 6 型 — 同 file 内消費のみ。 工数 S
- [P2] `lib/cards/apply-card-mutation.ts:36, :48` — 同 file 内消費。 工数 S
- [P2] `lib/cards/card-field-handlers.ts:43, :264` — 外部参照 0。 工数 S
- [P3] [Codex-only] `components/ui/dropdown-menu.tsx:254` + `tags/_components/option-row.tsx:33` — `dropdown-menu.tsx` が実 importer なしで残置、 option-row コメントで jsdom 問題で custom menu に戻した履歴あり (Codex 行 42)。 推奨: 削除 or 実配線。 工数 S
- [P3] 同様の内部完結 export 多数 (詳細は前版から維持、 ここでは略) — type-only 利用、 strict 整理なら `export` 落とし可。 工数 S 一括

#### 5.3 同一ロジック多重実装

- [P2] JST 算術 (上記 §5.1 P2 参照、 `lib/jst.ts` に `toJstDate` 追加で 3 箇所統合)。

(備考: `next-card-sort-key.ts` と `tags/next-sort-key.ts` は意味論差 banner で明示、 多重実装ではない)

### 既知の合流

- Sync-fix-1 一斉差し替え対象 8 file: `tags/_components/{category-row.tsx:86-124,130-132, option-row.tsx:118-161,202-204, category-create-form.tsx:64-96, option-create-form.tsx:99-104, category-list.tsx:170-207, option-list.tsx:149-175}` + `exams/[id]/_components/{card-tags-section.tsx:611-661, inline-text-field.tsx:153-204, inline-option-row.tsx:155-224, inline-card-list.tsx:142-206, delete-card-button.tsx:34-52}`
- 色 path A vs B: `category-row.tsx:86-124,130-132` / `option-row.tsx:118-161,202-204` / `card-tags-section.tsx:145-234` / `card-tag-edit-fields.tsx:43,176-186` / `card-tag-edit-popover.tsx:215-222`
- `inline-option-row.tsx` refs structural (Sync-fix-1)

---

## 6. 領域5 — 型安全

監査対象: any / as 濫用 / @ts-ignore / zod schema と TS 型の二重定義乖離 / unknown narrow / non-null assertion 連発。

**全体評価**: TS strict 有効 (`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` 未有効)。 `: any` / `as any` / `@ts-ignore` 系は 0 件 (test / stub 除外後)。 内部 API 戻り値と untrusted external (Clerk webhook) の as 断定、 schema 双子型 (drizzle vs ClientX vs zod) の drift 余地が新規発見。

### 新規発見

- [P1] `lib/sync/pull.ts:100` — `(await res.json()) as PullResponse` で zod validate せず断定。 行 162-182 の shape check は表層のみ。 server schema 変更で client が静かに stale 構造を bulkPut。 工数 M
- [P1] `app/api/webhooks/clerk/route.ts:78` — `wh.verify(...) as ClerkEvent` で svix `verify` 戻り `unknown` を直接 union 型 assert。 行 98 / 120 / 147 で untrusted external payload を zod 無し断定。 推奨: zod 化 + safeParse。 工数 M
- [P1] `lib/sync/server/entity-mutation-registry.ts:137,211,258` — inline cast 多数。 事前 zod parse 通過済のため runtime 安全だが envelope schema 書換時に cast 側が追従しない drift 余地。 工数 S
- [P2] [both] `lib/ai/ocr.ts:32-58` vs `lib/ai/schemas/ocr-response.ts:14-41` + `app/(app)/app/upload/_actions/process.ts:518,521` + `inline-card-list.tsx:53` — `ExtractedCard` / `ExtractedOption` / `ExtractedImage` を手書き type と zod schema で二重定義、 `c.options as CardOption[]` で assignability 喪失 (Codex 行 27 で同問題、 JSON Schema / zod / TS / DB JSON 型の手定義重複として指摘)。 推奨: zod / shared DB-compatible type を SSoT、 cast を型検査される変換に置換。 工数 M
- [P2] `lib/client-db.ts:40-192` vs `lib/db/schema.ts:46-825` — `Client*` 10+ 型を snake_case + timestamp string 化した手書き mirror で再定義、 `cards-mapper.ts` の `toClientCard` / `toCard` が「structural 一致」 だけで繋ぐ。 schema 列変更で mapper が compile 通り続け mirror が静かに壊れる。 推奨: drizzle `$inferSelect` + Snakeify 系 mapped type で機械生成、 `satisfies` で固定。 工数 L
- [P2] `lib/db/streak.ts:76,87` — `db.execute<{ c: number }>` 等で raw SQL 戻りを未検証 typed generic 信用。 推奨: `Array<{ d: unknown }>` + typeof check に揃える (review-events bulk.ts:385 と同 pattern)。 工数 S
- [P2] `lib/tags/apply-tag-mutation.ts:73,224` — `const set: Record<string, unknown> = {}` で drizzle `.set(set)` の column 型検証喪失。 推奨: `Partial<typeof tagCategories.$inferInsert>`。 工数 S
- [P2] [Codex-only] `lib/tags/apply-tag-mutation.ts:76, 228, 253` + `lib/sync/server/entity-mutation-registry.ts:194` — tag update validation が create schema と drift (create は trim/max、 update は type / non-empty 寄り) (Codex 行 59 Sync-fix-1 既知合流)。 推奨: create/update 共通 zod schema、 registry inferred patch type 使用。 工数 M
- [P3] [Codex-only] `app/(app)/app/settings/_actions/save-fsrs-mode.ts:15` — server action が runtime boolean validation せず TS 型を信用して DB 書込み。 malformed call が clean validation でなく DB error に。 推奨: `z.boolean().safeParse(value)`。 工数 S
- [P3] [Codex-only] `app/(app)/app/exams/_actions/delete-exam.ts:25` — `examId` の UUID runtime validation なし。 推奨: tx 開始前 `z.uuid().safeParse(examId)`。 工数 S
- [P3] [Codex-only] `lib/validation/contact.ts:5` + `lib/db/schema.ts:514` — contact category enum が zod const と DB typing union で二重定義 (Codex 行 44)。 推奨: shared module 化。 工数 S
- [P3] [Codex-only] `lib/client-db.ts:147,150,152,153` (`ClientEntityMutation`) — loose な `string` / `Record<string, unknown>` で server registry contract と型連動なし (Codex 行 60 Sync-fix-1 既知合流)。 推奨: discriminated union を registry schema と colocate。 工数 L
- [P3] 残り (`rows[0]!` 系 / `as PaidPlan` / `as ClientStudyDay[]` / sync 戻り `as typeof body` 等) — `noUncheckedIndexedAccess` 未有効ゆえの ad hoc 多数。 工数 S 一括

### 残置妥当 (修正対象外)

`navigator.locks as unknown as MinimalLockManager` (lib.dom 待ち) / `localId as number` (Dexie SDK) / `lib/db/serialize-db-error.ts` typeof narrow / `gemini.ts:63-65` 段階的 narrow / Stripe SDK 公式 downcast / `Textarea/Input` 分岐 / `tag-manager-shell.tsx:61` / `contact-form.tsx:105`。

### 既知の合流

- TS 6.0.3 移行 (波3)
- `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` 有効化 sprint
- `vitest-stubs/` の any (stub のため許容)
- schema コメント保守性 (codex #8)

---

## 7. 領域6 — perf

監査対象: N+1 (SQL/IDB) / useLiveQuery 過剰 re-render / bundle に不要に乗る依存 / rendering / 大 payload。

### 7.1 perf スケール阻害 (launch 前必須、 元 §1.2 P0 → 再裁定で P1)

5 件すべて [both]: CC subagent と Codex の双方が独立に発見。 Codex は P2-P3 だが CC は P0 評価、 再裁定基準 (perf は最高 P1) を踏まえ **P1 で統一**。

- [P1] [both] `app/api/review-events/bulk/route.ts:376-405` — study_days UPSERT の per-JST-day ループ内で `COUNT(DISTINCT card_id) FROM reviews WHERE day=...` SQL N+1 (Codex 行 37 P3)。 推奨: `GROUP BY day` の bulk 取得。 工数 M
- [P1] `app/api/entity-mutations/bulk/route.ts:184-205` — per-mutation `db.transaction(...)` を `for await` 逐次 (50 mutation で DB tx ×50 RTT)。 Codex は同 route の別側面 (failed[] + 200) を §3 P2 で指摘、 N+1 自体は CC-only 発見。 工数 L
- [P1] [both] `app/(app)/app/exams/_components/exam-list-live.tsx:30-31` — 全 cards toArray + JS 集計 (Codex 行 26 P2)。 推奨: server 既存の `exams.card_count` 利用。 工数 S
- [P1] [both] `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:91-96` — useLiveQuery が `tag_categories` / `tag_options` / `card_tags` 全件ロード (Codex 行 25 P2)。 推奨: `card_tags.where('card_id').anyOf(currentExamCardIds).toArray()`。 工数 S
- [P1] [both] `app/(app)/app/_components/dashboard-actions.tsx:36-41` — 全 cards toArray + JS due filter (Codex 行 33 P3)。 推奨: Dexie に `[user_id+due]` compound index 追加。 工数 M

### 7.2 その他 perf 新規発見

- [P1] [both] `lib/cards/get-dexie-session-cards.ts:29-37` — smart session 開始時に全 cards toArray + JS due / sort / slice (Codex 行 34 P3)。 dashboard-actions と同じ `[user_id+due]` index 改善で同時解消。 工数 M
- [P1] [both] `app/(app)/app/tags/_components/category-list.tsx:144-149` — `for (const opt of options) { await db.card_tags.where('option_id').equals(opt.id).count() }` IDB N+1 (Codex 行 36 P3)。 推奨: `anyOf(optionIds).count()` 1 発。 工数 S
- [P1] [both] `card-tags-section.tsx:308-314` (`countCategoryImpact`) — 同 IDB N+1 (Codex 行 35 P3)。 工数 S
- [P1] `card-tags-section.tsx:541-553, :667-680` — レンダー O(cards × tags × options)。 推奨: 親で Map pre-index 化。 工数 S
- [P1] `lib/sync/entity-mutations.ts:80-96` — `enqueueEntityMutation` per-call 全 pending toArray (§3 領域2 §2 と同件、 index 未活用)。 工数 S
- [P2] `lib/db/schema.ts:752-754` — `card_tags` に (user_id, created_at) compound index なし、 pull が partial index しか使えない。 工数 S
- [P2] `components/ui/{popover,tabs,label,button,dropdown-menu}.tsx` — `radix-ui` umbrella 経由 import + `optimizePackageImports` 未設定。 工数 S
- [P2] `next.config.ts:1-27` — `experimental.optimizePackageImports` 未設定 (lucide-react / dnd-kit 系)。 工数 S
- [P2] `dashboard-stats.tsx:28-34` + `lib/client/streak.ts:66-69` — study_days 90日分を毎 useLiveQuery 評価で読む + `clear() + bulkPut()` で subscription 通知が拡散。 推奨: diff-only put。 工数 M
- [P2] `lib/sync/pull.ts:217-260` — pull 1 tx で 3 anyOf 直列 + 4 store rw lock。 推奨: 初回 full sync 専用 path + pull leg を「メタ系」「重系」 で 2 tx 割。 工数 L
- [P3] `lib/db/streak.ts:76-93` — 2 SELECT 直列、 1 query で統合可。 工数 S
- [P3] `card-tags-section.tsx:613-660` (`handleToggle`) — 毎クリック `options.filter()`、 useMemo Map 化。 工数 S
- [P3] `lib/tags/reorder-handlers.ts:56-66, :108-118` — 1 tx 内 per-row 直列 + enqueue 全 pending toArray、 enqueue 最適化と組合せ。 工数 S

### 既知の合流

- `app/api/pull/route.ts:82-89` (codex #2)
- `lib/db/cards-pull.ts:27` (codex #2)
- `components/pricing/pricing-table.tsx:15` / `upgrade-plans.tsx:14` (codex #5)

---

## 8. 領域7 — 運用

監査対象: env validation 漏れ / 構造化ログ不足 / Gemini・R2 コスト暴走経路 / observability の穴 / deploy 前 checklist 自動 enforce。

### 新規発見

#### 8.1 env validation の漏れ

- [P1] [both] `lib/ai/clients/gemini.ts:138` (`OCR_DEBUG_LOG`) / `lib/db/serialize-db-error.ts:140` (`BULK_FULL_PARAMS_LOG`) — flag が `=== '1'` のみ check、 `VERCEL_ENV === 'production'` の組合せ条件未確認。 production 設定で raw response / full bind params (PII 含む) 流出余地 (Codex 行 23 で OCR_DEBUG_LOG 側を P2 で指摘)。 厳しい方 **P1 採用**。 推奨: `VERCEL_ENV === 'production'` で gate 二重化 or module load 時 fail-fast。 工数 S
- [P1] [both] `app/(app)/app/upload/_actions/process.ts:303` — `parseDailyLimit(process.env.GEMINI_DAILY_LIMIT)` 未設定/不正値で null → guard 完全 off (Codex 行 57 既知合流 P2)。 推奨: production で fail-fast。 工数 S
- [P2] `lib/db/index.ts:16-19` — `DATABASE_URL` first `getDb()` まで遅延検証 (Clerk/Stripe は module load 時 fail-fast)。 推奨: `lib/env.ts` で zod 一元化。 工数 M
- [P2] `app/(app)/app/settings/actions.ts:18` / `upgrade/actions.ts:48` — `NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'` の localhost fallback が Stripe URL に乗りうる。 production で env 漏れたら Stripe Checkout success_url が localhost。 工数 S
- [P2] `lib/ai/clients/gemini.ts:22-23` — `GEMINI_API_KEY` 不在は初回 callGemini まで遅延 throw。 推奨: `instrumentation.ts` で warmup 起動 check。 工数 S
- [P3] `.env.example` の `R2_*` 5 件 + `CLAUDE_CODE_DISCORD_WEBHOOK_URL` — コード未参照 (R2 未配線)。 配線時に同 review 再実施。 工数 S
- [P3] `upload-form.tsx:775` / `delete-button.tsx:60` — `NEXT_PUBLIC_VERCEL_ENV` 読むが `.env.example` 未記載 (Vercel 自動 inject)。 工数 S

#### 8.2 構造化ログ不足

- [P2] `settings/delete-button.tsx:59` — `console.error` (client browser console のみ、 削除失敗の server 転送なし)。 工数 M
- [P2] `card-tags-section.tsx:355,413` — `console.error('[Tag-4c-2a] empty user_id, ...')` (client console のみ、 invariant violation の server 経路欠如)。 工数 M
- [P3] `lib/auth/clerk-metadata.ts:55` — `console.debug` (Vercel デフォルトログレベルに乗らず実質黙殺)。 `logger.info` 格上げ。 工数 S
- [P3] `lib/logger.ts:46-67` — `userId` / `requestId` / `traceId` を payload 任意 field 扱い → callsite で書き忘れ散見。 `withContext({userId})` builder で必須化。 工数 M
- [P3] `lib/ops.ts:79` / 13 箇所 — `environment: process.env.VERCEL_ENV ?? ...` コピペ。 `notifyOps` auto-attach か helper 化。 工数 S

#### 8.3 Gemini / R2 コスト暴走経路

- [P1] `lib/ai/ocr.ts:97-104` — `BACKOFF_BASE_MS = [5000, 20000]` + `MAX_HTTP_RETRIES = 2` で最悪 1 attempt ~220s + 待機 ~60s × 2 = 660s。 deadline 720s で打ち切るが N user 並列で Gemini API quota 圧迫余地。 service-wide concurrency limit なし。 工数 M
- [P1] `lib/ai/ocr.ts:138-143` — Retry-After parseRetryAfterMs は `@google/genai` SDK 現状実装で実質 null。 SDK 更新で機能するが現状サーバー指示見落とし。 推奨: SDK ChangeLog 監視。 工数 S
- [P1] [both] `process.ts:303-319` — Gemini daily limit guard ↔ retry onAttempt の race (codex #3、 並列 user で限度 +N 件超過構造)。
- [P2] `lib/ai/ocr.ts:106-147` — `callWithRetry` `onAttempt` が counter DB エラー silent swallow (`incrementAiUsage`)。 推奨: `logger.error({event:'ai_usage.increment_failed'})` 1 行。 工数 S
- [P2] `process.ts:180-191` — `pdfPageCount` 失敗時 1 ページ計上で OCR_MAX_PAGES バイパス余地。 推奨: 失敗時 reject。 工数 S
- [P2] `lib/ai/clients/gemini.ts:16` — `GEMINI_TIMEOUT_MS = 220_000`、 AbortController は client 側のみで Gemini server は処理継続 = 課金される (SDK 挙動上不可避、 監視のみ)。 工数 S
- (備考) R2 (Cloudflare) — コード経路ゼロ、 配線時再 review。

#### 8.4 observability の穴

- [P1] `app/api/webhooks/stripe/route.ts:208` — `stripe.subscriptions.retrieve(subId)` の Stripe 5xx / timeout が outer catch + 200 swallow。 stuck (Stripe sub あるが DB users.plan='free') の検知 dashboard / 定期 job 未配備 (codex #7 既知)。
- [P1] `app/api/webhooks/clerk/route.ts:173-180` — user.deleted 受信時 users 行ない状態の手動 recovery script 不在 (codex #7)。
- [P2] [both] `lib/ops.ts:22, :23, :55-57` + `webhooks/stripe/route.ts:59` + `webhooks/clerk/route.ts:106` — `OPS_DISCORD_WEBHOOK_URL` 未設定で ops 通知が no-op、 webhook 失敗が 200 swallow されると production misconfig で復旧シグナルが消える (Codex 行 24 で同問題、 production fail-fast validation 推奨)。 Discord 自体落ち / revoked / rate-limit 中も同様の黙殺。 推奨: production で webhook URL fail-fast + 代替 error sink、 healthcheck で通知経路検証。 工数 M
- [P2] `lib/ai-usage-counter.ts:28-44` — increment tx 失敗を caller (ocr.ts:122-128) が silent swallow + notifyOps なし。 工数 S
- [P2] `lib/db/index.ts:14-22` — postgres 接続自体の throw を catch する notifyOps 経路がない (instrumentation.onRequestError は uncaught のみ)。 工数 M
- [P2] `webhooks/stripe/route.ts:52-67` — outer try に duplicate 経路は入らないため「重複 event だが初回処理失敗」 のケース検知不能。 推奨: stripe_events に `processed_at` / `status` 列。 工数 M
- [P3] `lib/logger.ts` Sentry-swap-ready comment あるが未実施。 retention / cross-function correlation / alert ルールが Vercel 内で限定的。 工数 L

#### 8.5 deploy 前 checklist 自動 enforce

- [P2] `webhooks/stripe/route.ts:19` (`STRIPE_WEBHOOK_SECRET`) / `webhooks/clerk/route.ts:55` (`CLERK_WEBHOOK_SECRET`) — `NODE_ENV === 'production'` で弾く設計だが Vercel Preview (= NODE_ENV='production') で 500、 staging preview で誤未設定だと webhook 全失敗。 推奨: `VERCEL_ENV` 分岐 (production 必須 / preview 警告 / local 許容)。 工数 S
- (確認) `lib/stripe.ts:28-58` / `lib/clerk.ts:28-58` の env-aware fail-fast は自動 enforce 済 OK。

### 既知の合流

- `process.ts:303-319` (Gemini 日次上限 approximate、 codex #3)
- `webhooks/stripe/route.ts:208` / `webhooks/clerk/route.ts:173-180` (webhook runbook 不足、 codex #7)
- `lib/stripe/price-mapping.ts:34-37` (codex #5)

---

## 9. 既知の合流 (横断サマリ、 重複登録なし)

新規 finding と独立に、 既知 todo を各領域で再発見した file:line を横断統合 + Codex 既知合流欄の項目を追加。 **新規欄重複登録なし**、 出典のみ示す。

| 既知項目 | 出典 | 主要 file:line |
|---|---|---|
| `/api/pull` 無制限ページング | codex #2 / Phase 4 | `app/api/pull/route.ts:73-89, 82-89` / `lib/db/cards-pull.ts:25-29, 27` / `exams-pull.ts:30-35` / `tombstones-pull.ts:33-38` / tag-*-pull / card-tags-pull |
| `/api/pull` invalid cursor 400 化 | /api/pull hardening | `app/api/pull/route.ts:28, 31` (Codex 行 54 P3) |
| Sync-fix-1: void enqueue + 空文字 user_id | tag-4c-2a-* 系 spec | `tags/_components/{category-row.tsx:104-116, option-row.tsx:141-145, category-create-form.tsx:64-96, option-create-form.tsx:99-104, category-list.tsx:170-207, option-list.tsx:149-175}` + `exams/[id]/_components/card-tags-section.tsx:{135,166,200,230,354-356,412-414}` |
| Sync-fix-1: 色 path A vs B | tag-color-step0 | `category-row.tsx:86-124,130-132` / `option-row.tsx:118-161,202-204` / `card-tags-section.tsx:145-234` / `card-tag-edit-fields.tsx:43,176-186` / `card-tag-edit-popover.tsx:215-222` |
| Sync-fix-1: inline-option-row refs structural | eslint-ci-gate spec | `inline-option-row.tsx:104-115, 140-153, 228-238` |
| Sync-fix-1: tag update validation drift | (Codex 行 59) | `lib/tags/apply-tag-mutation.ts:76,228,253` + `lib/sync/server/entity-mutation-registry.ts:194` |
| Sync-fix-1: ClientEntityMutation loose 型 | (Codex 行 60) | `lib/client-db.ts:147-153` |
| Sync-fix-1: newId() 重複 | (Codex 行 61) | `lib/sync/review-events.ts:32` + `entity-mutations.ts:25` |
| Sync-fix-1: Web Locks lock runner 重複 | (Codex 行 62) | `lib/sync/review-flush.ts:72` + `entity-mutation-flush.ts:31` + `pull.ts:310` |
| Sync-fix-1: card-tags-section atomic は既知 | (Codex 行 63) | `card-tags-section.tsx:636` |
| user deletion physical cascade (GDPR) | s1-9-5 | `app/api/webhooks/clerk/route.ts:226-287` |
| webhook 200 swallow + runbook 不足 | codex #7 | `webhooks/clerk/route.ts:103-114, 173-180, 206, 214-215, 390-391` / `stripe/route.ts:55-67, 208` |
| deletion-status userId 列挙 | codex #6 | `app/api/me/deletion-status/route.ts:19-39, 33-39` |
| String(err) 統一 (shared serializer 化) | s1-9-5 + Codex 行 58 | `webhooks/clerk/route.ts:206, 214-215, 390-391` + `process.ts:447, 470` + `lib/ops.ts:31` + `lib/logger.ts:62` |
| Gemini 日次上限 approximate | codex #3 | `process.ts:303-319` / `lib/ai/ocr.ts:122-128` / `lib/ai-usage-counter.ts` |
| price-mapping import 境界 | codex #5 | `lib/stripe/price-mapping.ts:34-37` / `pricing-table.tsx:15` / `upgrade-plans.tsx:14` |
| schema コメント保守性 | codex #8 | `lib/db/schema.ts` 各 table |
| TS 6.0.3 移行 + ESLint 厳格化 | 波3 / `noUncheckedIndexedAccess` | tsconfig.json / `apply-card-mutation.ts:152` 他 |

---

## 10. 取扱い注意 + 仕分けリスト

### 10.1 取扱い注意

- 本 doc は **着手 sprint roadmap ではない**。 §1 P0 を最初に対応するかは OT 判断。 P0 ラベルは「silent data loss / security hole」 に限定統一済。 業務上の優先順位 (機能欠落 vs 体感改善 vs 安全) は OT が `docs/next-sprints-priority.md` 上で別途決定。
- 出典マーク [both] / [Codex-only] は controller (CC) が `docs/codex/2026-06-12-repo-wide-audit.md` と突き合わせて付与。 同じ file:line でも観点が異なる場合 (例: `delete-card-button.tsx` を CC は P0 silent lost write、 Codex は P2 新規 + Sync-fix-1 既知合流 P1 で扱う) は厳しい方の P を採用し本文で経緯を併記。
- 数件、 同じ file:line が複数領域で別観点から指摘されている (例: `entity-mutations/bulk/route.ts:184-205` は §7.1 P1 perf + §3 P2 partial-apply / `enqueueEntityMutation` coalesce は §3 P2 + §7.2 P1) — fix は 1 PR で多軸を同時に解消するため重複ではなく多軸の確認として残置。
- 次の sprint で本 doc を再読する OT 用に、 各 finding は file:line ベースで grep 可能な形を維持。 「修正済」 になったら本 doc の該当 bullet 先頭に `~~` 取消線を追加 (削除しない、 audit log として保持) を推奨。

### 10.2 仕分けリスト (a) — Sync-fix-1 編入 (Sync-fix-1 sprint で一括解消する想定)

Sync-fix-1 は「optimistic 経路を atomic 化 + 共有 helper に集約」 する既存 sprint scope。 本 audit で発見した以下は Sync-fix-1 に編入推奨:

1. **[P0] [both] inline-card-list.tsx:161-205 handleAddCard** — lost write (atomic 化、 §1.1)
2. **[P0] [both] delete-card-button.tsx:36-52 onConfirmDelete** — lost write (atomic 化、 §1.1)
3. [P1] [both] inline-text-field.tsx:168-189 commit (atomic 化、 §3)
4. [P1] [both] inline-option-row.tsx:185-213 commit (atomic 化、 §3)
5. [P1] card-tags-section.tsx:111-234 4 関数の 25 行コピペ → 1 関数統合 (§3 + §5.1)
6. [P1] [both] option-row.tsx / category-row.tsx enqueueUpdate 重複 → 共通 hook (§5.1)
7. [P1] [both] option-create-form / category-create-form 重複 (§5.1)
8. [P1] [both] entity-mutation-flush / review-flush の Web Locks wrapping + `pull.ts:310` (§5.1)
9. [P1] entity-mutation-registry tag_option dup-check 自分除外 (§3)
10. [P2] [Codex-only] tag update validation create と drift (§6 / Codex 既知合流)
11. [P2] 23+ `String(err)` boilerplate → `logger.warnFromError` ヘルパ (§4.1 + §5.1)
12. [P2] card-tags-section.tsx:111-234 rename/color 4 関数の mirror revert 握り潰し (§3)
13. [P3] [Codex-only] ClientEntityMutation loose 型 (§6 / Codex 既知合流)
14. [P3] [Codex-only] newId() helper 重複 (§5.1 / Codex 既知合流)

### 10.3 仕分けリスト (b) — launch 前 hardening 小 sprint (Sync-fix-1 と独立、 launch 前必須)

P1 中心、 個別工数小、 launch 前に固める価値が高いもの:

1. [P1] [both] §7.1 perf 5 件 (review-events/bulk study_days SQL N+1 / entity-mutations/bulk per-mutation tx 逐次 / exam-list-live 全 cards / inline-card-list 全 card_tags / dashboard-actions 全 cards + [user_id+due] index)
2. [P1] [both] §7.2 get-dexie-session-cards 全 cards (`[user_id+due]` index 改善で同時解消)
3. [P1] [both] §7.2 category-list / card-tags-section の `card_tags.where('option_id').anyOf(...)` への集約 2 件
4. [P1] [Codex-only] entity-mutation-flush-trigger 24h 自動 failed 隔離撤去 (§3)
5. [P1] [both] OCR_DEBUG_LOG / BULK_FULL_PARAMS_LOG production gate 二重化 (§8.1)
6. [P1] [both] GEMINI_DAILY_LIMIT production fail-fast (§8.1)
7. [P1] OCR backoff worst-case ~660s への service-wide concurrency limit 検討 (§8.3)
8. [P1] content_version 用途決定 (廃止 or 実装、 §3)
9. [P1] pull.ts レスポンス zod parse 化 (§6)
10. [P1] webhook clerk payload zod 化 (§6)
11. [P2] [Codex-only] review-events/entity-mutations bulk の transient vs permanent failure 区別 (§3 既知の retry controller 整合)
12. [P2] [Codex-only] review-events session.card_ids max + selected_answer_ids format/length bound (§2 / §3)
13. [P2] proxy.ts webhook bypass (`/api/webhooks/(.*)` を matcher 除外、 §2)
14. [P2] [both] OPS_DISCORD_WEBHOOK_URL production fail-fast + 代替 error sink (§8.4)
15. [P2] [both] contact rate limit 導入 (§2)
16. [P2] NEXT_PUBLIC_APP_URL production fail-fast (§8.1)
17. [P2] webhook secret env-aware (production 必須 / preview 警告) — STRIPE_WEBHOOK_SECRET / CLERK_WEBHOOK_SECRET (§8.5)
18. [P2] [Codex-only] entity-mutations bulk の dependent multi-mutation atomic group (tag create + card update partial state 防止、 §3)
19. [P2] card_tags (user_id, created_at) compound index 追加 (§7.2)
20. [P2] stripe_events に processed_at/status 列追加 (§8.4)

### 10.4 仕分けリスト (c) — Phase 4 / Grid 合流 / 既知 sprint で吸収

中期 sprint または既知 roadmap (Phase 4 incremental pull / 波3 deps / Sentry phase) に合流:

1. [P2] /api/pull 無制限ページング (codex #2、 Phase 4) — limit + keyset cursor + has_more
2. [P2] pull tx 1 tx で 4 store rw lock (§7.2、 Phase 4 と同時)
3. [P3] [Codex-only] pull helpers 重複 (§5.1) — Phase 4 sprint で typed helper 抽出と同時
4. [P3] [Codex-only] /api/pull invalid cursor 400 (Codex 既知合流) — Phase 4 hardening
5. [P2] price-mapping import 境界 (codex #5) — type 分離小 sprint で
6. [P2] schema コメント保守性 (codex #8) — ADR 化 / contract file 化
7. [P3] TS 6.0.3 移行 (波3、 別 PR)
8. [P3] `noUncheckedIndexedAccess` 有効化 sprint (型安全 P3 一掃)
9. [P2] GDPR physical cascade (s1-9-5、 invariant test 維持で対応中)
10. [P2] webhook runbook 整備 (codex #7、 Stripe stuck 検知 dashboard / 定期 job 含む)
11. [P2] deletion-status nonce / signed token 化 (codex #6、 既知) — **2026-06-14 close (polling 廃止で攻撃面ゼロ化)**。 T-A9 で signed token 経由化 (commit `b6d742d`) 実装したが、 prod env 未設定で `/app/settings` 全 user 500 を契機に再評価。 polling は UX 補助 (30 秒以内 navigate 補助) で削除完了保証 (= Clerk webhook + Stripe cancel + 子データ cascade) は webhook 経路で独立完結のため、 polling endpoint / signed token helper / settings polling effect 一式廃止 (`/api/me/deletion-status` / `lib/security/deletion-token.ts` / `delete-button.tsx` polling 削除)、 `DELETION_TOKEN_SECRET` env 不要化。 廃止後の UX = user.delete() resolve 後即 `window.location.replace('/sign-out-deleted')`、 zombie net (`layout.tsx` deletedAt redirect) + BFCacheGuard が back/forward 経路を吸収。 詳細 = `docs/superpowers/sessions/2026-06-14-prod-settings-500-deletion-token-fact-finding.md`。
12. [P2] String(err) shared serializer (codex 既知合流、 user-facing/ops-facing/log-facing 分離)
13. [P3] [Codex-only] client-db.ts v3 migration `card_mutations` drop hardening (§3、 既存ユーザーいる時点で migrate path 要、 launch タイミング判断必要)
14. [P3] Sentry 移行 (`lib/logger.ts` Sentry-swap-ready が宣言済、 Phase 1 F)
15. [P3] [Codex-only] dropdown-menu.tsx 未使用整理 (§5.2、 必要なら category-move UI 実配線)
16. [P3] save-fsrs-mode / delete-exam runtime validation (§6、 まとめて 1 PR)
17. [P3] [Codex-only] contact category enum 二重定義 解消 (§6)

---

## 11. 監査メタ情報

- subagent 配備: Claude Code 7 領域 × general-purpose subagent (各 fresh context) を並列。 並行に GPT-5 Codex が同 repo を独立に監査 (`docs/codex/2026-06-12-repo-wide-audit.md`、 9691B → 16787B、 6 領域 fresh subagent + ops を controller 追加監査)。
- 領域 (CC): (1) セキュリティ、 (2) データ整合性、 (3) エラー処理、 (4) 重複・無駄、 (5) 型安全、 (6) perf、 (7) 運用
- controller (CC): 既知 todo 集約 (`next-sprints-priority.md` v18 / `codex/2026-06-08-codex-review.md` 8 項 / Sync-fix-1 spec / s1-9-5 系 / cache-fix roadmap) + Codex audit との突き合わせ + severity 再裁定 + 仕分けリスト作成
- 監査時の repo HEAD: develop 先端 (`efa4ed1 docs: 波1 後始末`)、 波1 + 波2 prod deploy 直後
- 修正コミット: 一切なし (本 doc 起票 + Codex 統合更新のみ、 `docs(audit): ... [no-review]`)
- 改訂履歴:
  - 初版 (`2003884` 2026-06-11 10:08): CC 7 領域監査結果のみ、 §1 P0 = 7 件 (lost write 2 + perf 5)
  - Codex 統合版 (本版): Codex audit 突き合わせ反映、 [both]/[Codex-only] マーク付与、 severity 再裁定 (P0 = silent data loss/security hole に統一、 perf 5 件は §7.1 P1 に降格)、 §10 に Sync-fix-1 編入 / launch 前 hardening / Phase 4 合流の仕分けリスト追加
