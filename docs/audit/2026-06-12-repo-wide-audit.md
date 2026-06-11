# RecallMint repo-wide 監査 — 2026-06-12

- **起票日**: 2026-06-12
- **位置づけ**: production レベルで許容できない実装 / セキュリティホール / 構造的負債の全件棚卸し。 **対応時期は OT が別途決める** (本 doc は調査結果の保管庫であり、 着手 sprint の roadmap ではない)。
- **scope**: `app/` `lib/` `components/` `types/` `proxy.ts` `instrumentation.ts` `next.config.ts` `.env.example` / 関連 schema (`drizzle/`)。 `node_modules/` `.next/` `.playwright-mcp/` は対象外。
- **手法**: 領域ごと fresh general-purpose subagent で並列監査 (7 領域) → controller (本 file) が集約。 各 finding は `file:line / 問題 / 深刻度 (P0〜P3) / 推奨対応 / 工数 (S/M/L)`。
- **重複登録方針**: 「既知の合流」 セクション (各領域末尾と巻末) に file:line 列挙のみで再掲、 新規欄には入れない。 既知の出典は `docs/codex/2026-06-08-codex-review.md` / `docs/next-sprints-priority.md` / `docs/superpowers/specs/2026-06-08-tag-4c-2a-*-design.md` (Sync-fix-1 関連) / `docs/superpowers/sessions/2026-05-21-s1-9-5-*` (GDPR cascade) / `docs/recallmint-incremental-pull-steps.md` (Phase 4 系)。
- **重要前提**: 修正着手は本 sprint では一切行わない。 各 finding に `工数` 推定は付けるが、 優先順位は §1 P0 + §9 棚卸しに対し OT が決定する。

---

## 1. P0 — 即対応すべき (production 上の穴 / lost write / スケール阻害確実)

ここに列挙したものは「launch 後の本番運用で確実に問題化する」 と subagent が判定したもの。 OT は他の作業順序より優先するか別途判断。

### 1.1 lost write 経路 (silent data integrity hole)

- [P0] `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:161-205` (`handleAddCard`) — `cards.add` の await 直後に `enqueueEntityMutation` を await + `.catch(...)` で握り潰し。 enqueue 失敗時に **mirror に card 行が残り outbox に行がない** → server に新 card が永遠に到達せず、 他端末・次回 pull で「追加したのに消える」 silent lost write。 既知 Sync-fix-1 リスト (`card-tags-section.tsx handleToggle` / `tags/_components/*` manager / `inline-option-row.tsx` refs) には**含まれていない**新規経路。 推奨: `db.transaction('rw', db.cards, db.entity_mutations, ...)` で囲み、 enqueue throw → Dexie auto-rollback の atomic 化 (`card-tags-section.tsx handleToggle` 行 611-661 が reference 実装)。 工数: S

- [P0] `app/(app)/app/exams/[id]/_components/delete-card-button.tsx:36-52` (`onConfirmDelete`) — `cards.delete` の await 直後に `enqueueEntityMutation({op:'delete', ...}).catch(()=>{})`。 mirror remove 後 enqueue 失敗で **server 側 card 残置 + tombstone なし** → 他端末で card が消えない Phantom card。 user は UI 上で「削除済」 と認識。 推奨: 同上 atomic 化。 工数: S

### 1.2 perf スケール阻害 (本番でほぼ確実に劣化)

- [P0] `app/api/review-events/bulk/route.ts:376-405` — study_days UPSERT の per-JST-day ループ内で `COUNT(DISTINCT card_id) FROM reviews WHERE day=...` を **per-row 発行する SQL N+1**。 1 flush で複数日跨ぐと round-trip × 日数で線形劣化。 「問題3 で per-event tx → 単 tx + bulk SQL 済」 という前提に対し、 study_days phase だけ未圧縮 SQL ループが残置。 推奨: 1 query で `SELECT day, COUNT(DISTINCT card_id) ... GROUP BY day` の bulk 取得、 もしくは bulk INSERT で確定した今回分 card_id をカウンタとして使う。 工数: M

- [P0] `app/api/entity-mutations/bulk/route.ts:184-205` — per-mutation `db.transaction(...)` を `for await` 逐次。 50 mutation で DB tx ×50 round-trip。 review-events で問題3 が解消したのと**同じ N+1 pattern が entity-mutations に残置**。 推奨: registry の同 (entity_type, op) 単位で grouping して 1 tx で bulk dispatch、 最低でも outer 1 tx + per-mutation savepoint。 工数: L

- [P0] `app/(app)/app/exams/_components/exam-list-live.tsx:30-31` — `db.cards.where('user_id').equals(userId).toArray()` を「exam ごとの card 件数」表示のためだけに全件 toArray。 useLiveQuery は cards mirror への任意 mutation で再評価されるため、 smart 復習1回答 / 編集1 commit ごとに全 N cards を IDB 読み。 1k cards user で毎クリック 50-200ms ヒッチ。 推奨: server 既存の `exams.card_count` 列を使う、 もしくは Dexie `.count()` を exam ごとに run。 工数: S

- [P0] `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:91-96` — useLiveQuery が `db.tag_categories.toArray()` / `db.tag_options.toArray()` / `db.card_tags.toArray()` を**無条件全件**ロード。 card_tags は exam 横断のため他 exam の付与全部を毎 tick 読む。 1 user 100 cards × 5 tag = 500 card_tags を毎 cell 編集ごとに走査。 推奨: `db.card_tags.where('card_id').anyOf(currentExamCardIds).toArray()` で絞る。 工数: S

- [P0] `app/(app)/app/_components/dashboard-actions.tsx:36-41` — 全 cards を toArray した後 JS filter で `due <= now` 判定。 Dexie schema の `[user_id+due]` compound index が存在せず (現状 `due` 単独 index のみ)、 1k cards で dashboard 表示毎に全件 IDB 読み + 全件 due 比較。 推奨: `[user_id+due]` compound index を追加し `where('[user_id+due]').between([userId, ''], [userId, nowIso]).count()` で件数のみ取得。 工数: M

---

## 2. 領域1 — セキュリティ

監査対象: 認可漏れ (IDOR) / 入力検証漏れ / secret log 出力 / rate limit 不在 / webhook 署名検証 / CSP・security headers。

**全体評価**: P0 ホール無し。 全 API route / server action で `getCurrentUser()` 由来の認証済 userId のみが DB filter として使われ、 URL/body の user-supplied id を信用する場所は発見されず。 webhook 署名検証 (svix / Stripe constructEvent) と raw body 取得 (`req.text()`) も正しく適用済。 Stripe/Clerk env prefix fail-fast 済、 secret env のログ出力なし (名前のみ)、 `key.slice(0, 8)` で prefix までしか露出しない。

### 新規発見

- [P2] `lib/ai/clients/gemini.ts:138-145` — `OCR_DEBUG_LOG=1` で Gemini response の **生 OCR テキスト先頭 50000 文字** を Vercel logs に書き出す。 中身はユーザーがアップロードした学習資料 (試験問題・個人ノート等 PII / 著作物)。 staging 限定とコメントされているが production で誤って `1` を設定する事故面が残る。 推奨: prefix を `staging only` ハードコード化、 または `VERCEL_ENV !== 'production'` の二重 guard を追加。 工数 S。 (運用領域の P1 と統合検討、 §8 参照)
- [P2] `app/(marketing)/contact/actions.ts:19-85` — public server action でレート制限ゼロ。 honeypot は単純 (ボットに既知)、 zod 検証のみで Discord webhook (`notifyOps`) + DB INSERT を任意 IP から無制限に呼べる。 推奨: 同一 IP / email を per-minute / per-day で絞る (KV / Upstash) または Vercel WAF / Cloudflare Turnstile。 工数 M
- [P2] `proxy.ts:24-29` — matcher が `/api/(.*)` を全包含し webhook (`/api/webhooks/clerk` / `/api/webhooks/stripe`) も clerkMiddleware 経由。 動作はする (handler 側で署名検証) が clerkMiddleware コストが無駄、 副次的に `CLERK_SECRET_KEY` 未設定状態で webhook が触れて `lib/clerk.ts` fail-fast が webhook で先に発火 → 500 を retry-loop する初期構成事故面。 推奨: matcher から `/api/webhooks/(.*)` を除外。 工数 S
- [P2] `app/api/me/deletion-status/route.ts:33-39` — userId 列挙 oracle (codex #6 を裏付け、 P2 想定として再整理)。 工数 S
- [P3] `app/api/entity-mutations/bulk/route.ts:48-60` / `app/api/review-events/bulk/route.ts:83-87` — `max(1000)` per-payload 件数上限はあるが per-user 単位時間あたり頻度に制限なし。 Web Locks は同 origin 内のみ、 別 device / curl は素通し。 server tx は idempotent なので攻撃面は限定的だが Vercel 関数費用 DoS 余地。 工数 M
- [P3] `next.config.ts:9-18` — `Permissions-Policy` header 不設定 (camera / microphone / geolocation / payment default permissive)。 推奨: `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` を追加。 工数 S
- [P3] `next.config.ts:9-18` + `proxy.ts:19` — CSP は `frame-ancestors 'none'` のみ。 `script-src` / `default-src` / `connect-src` は clerkMiddleware の auto モード依存。 将来 inline script / 3rd-party 増えたとき無防備。 工数 M
- [P3] `lib/auth/clerk-metadata.ts:55-57` — `console.debug` が `clerkId` を平文 logger.* 経由でなく出力。 PII。 `logger.info` 化推奨。 工数 S
- [P3] `app/(app)/app/upload/_actions/process.ts:303-309` — `logger.warn({event:'gemini.daily_limit.disabled', raw: process.env.GEMINI_DAILY_LIMIT ?? null})` で env 値そのまま log 出力。 数値設定で secret ではないが「`process.env.*` を log に直接埋め込む pattern が許容」 という習慣面で P3。 工数 S
- [P3] `app/api/review-events/bulk/route.ts:419` — `serializeDbError(err, { cardIds: events.map((e) => e.card_id) })` で全 event の card_id を error log に展開。 user 自身の card_id なので外部漏洩なしだが log noise + SIEM コスト。 工数 S

### 既知の合流

- `app/api/me/deletion-status/route.ts:19-39` (codex #6)
- `app/api/pull/route.ts:73-89` (codex #2、 Phase 4)
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx:135 / 166 / 200 / 230 / 354-356 / 412-414` (Sync-fix-1: void enqueue + 空文字 `user_id`)
- `app/(app)/app/tags/_components/category-row.tsx:104` + `option-row.tsx` 同形 (Sync-fix-1)
- `app/api/webhooks/clerk/route.ts:260-287` (GDPR physical cascade、 s1-9-5)
- `app/api/webhooks/clerk/route.ts:103-114` / `app/api/webhooks/stripe/route.ts:55-67` (webhook 200 swallow + runbook、 codex #7)
- `lib/stripe/price-mapping.ts` import 境界 (codex #5)

---

## 3. 領域2 — データ整合性

監査対象: Dexie tx の external await / outbox 重複・喪失 / last-write-wins 競合 / tombstone・cascade 漏れ / migration と schema 乖離 / idempotency。

P0 は §1.1 (inline-card-list / delete-card-button) を参照。 ここでは P1〜P3 を列挙。

### 新規発見

- [P1] `app/(app)/app/exams/[id]/_components/inline-text-field.tsx:168-189` — commit で `void cards.update(...)` と `void enqueueEntityMutation(...)` を並行 fire-and-forget。 reference 実装 (handleToggle) と異なり atomic 化されていない。 既知欄では `inline-option-row.tsx refs structural` のみ列挙されているが、 本 file は data-integrity 観点で別経路。 推奨: handleToggle 同 pattern の atomic 化。 工数 S
- [P1] `app/(app)/app/exams/[id]/_components/inline-option-row.tsx:185-213` — commit で options 系も `void cards.update` + `void enqueueEntityMutation` 並行発行。 inline-text-field.tsx と同 pattern (refs structural の既知とは別の data-integrity 問題)。 工数 S
- [P1] `lib/sync/server/entity-mutation-registry.ts:333-336` + `lib/tags/apply-tag-mutation.ts:188-192` (tag_option create) — 事前 dup check が**自分自身の id を除外していない**。 mutation_id 早期 skip が log INSERT 並走 race で機能しないケースで再送時に「既存 row (前回の自分の INSERT) が見つかる → 'failed'」 となる。 結果: client outbox が failed マークされ user は同名 option を作れなくなる (実際は作成成功)。 推奨: dup チェックに `AND id != optionId` を追加。 工数 S
- [P1] `lib/db/schema.ts:255,324` — `content_version` 列を exams/cards 双方で宣言し client-db でも index 持ち (行 239-241) だが、 **apply / pull / bulk receiver いずれでも参照・増分されていない**。 schema コメント (行 252-255) は「楽観ロック相当」 と謳うが実装が無く LWW は updated_at のみに依存。 同一 ms 内競合での lost update を構造的に防ぐ手段なし。 推奨: 用途決定 → 廃止 (列 + index drop) or 実装 (apply 時 increment + comparator)。 工数 M
- [P2] `lib/cards/card-field-handlers.ts:192-241` (`handleTagOptionIds`) — card の tag_option_ids whole-set replace。 2 タブ並行で別 option を追加すると後勝ち = 片方が消える LWW 競合。 docs 上「案 a 取り直し」 で許容しているなら設計通り。 推奨: 仕様確認 (許容なら lesson 追記)、 厳格化なら option_id 単位 add/remove op に分解。 工数 L
- [P2] `lib/sync/entity-mutations.ts:81-87` — `enqueueEntityMutation` の coalesce 探索が全 pending 行 `.toArray()` + in-memory filter。 outbox 1000 件規模で IDB read 線形劣化。 schema 既存の `[entity_type+entity_id]` compound index (client-db.ts:261) が活用されていない。 推奨: `db.entity_mutations.where('[entity_type+entity_id]').equals([type, id])` で index 経由取得。 工数 S
- [P2] `app/api/entity-mutations/bulk/route.ts:184-205` — per-mutation tx 逐次。 §1.2 P0 と同件 (perf 軸では P0、 data-integrity 軸では partial-apply guarantee 要件と相関)。
- [P2] `app/api/review-events/bulk/route.ts:506-524` (study_sessions upsert) — events INSERT 前に session の user_id と認証 user.id の SELECT 比較なし。 attacker が victim の session_id を入手しても、 attacker の cards は owner-scoped SELECT で 0 件 = INSERT されず実害なし。 防御を厚くする余地のみ。 工数 S
- [P2] `lib/sync/pull.ts:192-288` — pull 1 tx で `cards / exams / tag_categories / tag_options / card_tags / sync_meta` を bulkPut + bulkDelete。 各 stream 無制限 (既知 #2)。 1000+ 件で IDB tx 持続 → 別 tx lock 衝突。 工数 M (既知 Phase 4 で塞ぐ計画あり)
- [P2] `app/(app)/app/exams/[id]/_components/card-tags-section.tsx:111-138` (`handleRenameCategory` 系 4 関数) — mirror update → enqueue await → throw 時 mirror revert を `.catch(...)` 握り潰し。 throw 自体は rethrown されるため UI で error 通知できるが mirror 不整合は残置。 設計コメント (行 102) で single-store atomic 不要と明示。 統一の余地あり。 工数 M

### 既知の合流

- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx:611-661` (handleToggle 内 atomic OK = reference 実装、 rename/color 系は tx 外設計)
- Sync-fix-1: `tags/_components/category-create-form.tsx:64-96` / `category-list.tsx:170-207` / `option-create-form.tsx:99-104` / `option-list.tsx:149-175` / `option-row.tsx:141-145` / `category-row.tsx:104-116`
- `inline-option-row.tsx` refs structural (Sync-fix-1)
- `app/api/pull/route.ts:82-89` / `lib/db/cards-pull.ts:25-29` / `exams-pull.ts:30-35` / `tombstones-pull.ts:33-38` / tag-*-pull / card-tags-pull (全 stream 無制限、 codex #2)
- `app/api/webhooks/clerk/route.ts:226-287` (s1-9-5 user deletion physical cascade)
- `lib/db/schema.ts` 各 table コメント保守性 (codex #8)

---

## 4. 領域3 — エラー処理

監査対象: 握り潰し catch / 200-swallow / silent fail / `String(err)` の情報落ち / unknown cast / error response への内部情報混入。

**全体評価**: P0 無し。 webhook 200 swallow / OCR pipeline / Stripe webhook 等の主要経路は `notifyOps + logger.error + 200 return` が一貫しており、 重大な silent fail / 情報漏洩は新規発見されない。

### 新規発見

#### 4.1 `String(err)` の情報落ち (Sync-fix-1 周辺の client log 大量)

- [P2] `app/(app)/app/tags/_components/option-list.tsx:158, 172` — `logger.warn({ ..., err: String(err) })`。 logger の `expandError` が Error→{name,message,stack} 展開する設計だが、 `String(err)` 化した時点で stack/cause/code が落ちる。 推奨: `err` を生で渡すか `serializeDbError(err)` を使う。 工数 S
- [P2] 同 pattern (logger 経由で `String(err)` inline) を以下で確認:
  - `tags/_components/category-row.tsx:101, 114`
  - `tags/_components/category-list.tsx:154, 190, 204`
  - `tags/_components/option-create-form.tsx:95, 113`
  - `tags/_components/category-create-form.tsx:79, 92`
  - `tags/_components/option-row.tsx:138, 151`
  - `exams/[id]/_components/inline-card-list.tsx:168, 199`
  - `exams/[id]/_components/inline-option-row.tsx:195, 211`
  - `exams/[id]/_components/inline-text-field.tsx:175, 188`
  - `exams/[id]/_components/card-tags-section.tsx:135, 166, 200, 230`
- [P3] `app/api/webhooks/clerk/route.ts:206, 214-215, 390-391` — webhook recordFailure で `String(err)` 化して `errorMessage` column に保存。 admin grep 用に意図的 (DB text 列)。 既知 (s1-9-5 trace)。

#### 4.2 silent fail (user 通知 / `*_failures` 記録なし)

- [P1] `app/(app)/app/exams/[id]/_components/delete-card-button.tsx:49` — §1.1 P0 と同件 (mirror remove + enqueue `.catch(() => {})`)。
- [P2] `app/(app)/app/study/smart/_components/session-runner.tsx:301-303, 318, 324` — answer event の Dexie write / flush / `completeStudySession` 失敗を完全 silent。 `completeStudySession` (318) 失敗で session が Dexie 上で 'active' 残置 → `dropStalePendingAnswerEvents` の 24h 後拾いのみ。 logger.warn 1 行で観測性改善。 工数 S
- [P2] `app/(app)/app/upload/_components/upload-form.tsx:435` — `processUpload` server action throw (504 / network) を `catch {` で握り潰し。 server 側 `source_documents` は処理中残骸として残り reconcile で 15 分後拾うが client 側 console すら出ない。 工数 S
- [P3] `app/(app)/app/study/smart/page.tsx:36` — server fetch 失敗 silent (Dexie fallback あり)。 設計通りだが logger.warn は server 側で出してよい。 工数 S
- [P3] `app/(app)/app/upgrade/page.tsx:43` — `resolveActiveSubscription` failure silent (graceful degrade)。 OT 介入 trigger を page render 側でも logger.warn したい。 工数 S

#### 4.3 client fetch の `.catch(() => null)` 経由 silent

- [P2] `lib/sync/pull.ts:101, 105, 153` — `defaultClient.get` の json parse 失敗 / fetch throw を silent に `{ok:false, status:0, body:null}` 化。 連続 失敗の検知が欠落 (`silent + 次 trigger 回復` 方針は理解、 ただし永続失敗を観測する経路がない)。 sync_meta に `lastPullError` を入れて 1 度でも観測する経路があると Discord 通知導線が作れる。 工数 M
- [P2] 同形: `lib/sync/study-days.ts:41, 45, 57` / `review-events.ts:252, 256` / `entity-mutations.ts:221, 225`。
- [P3] `app/(app)/app/_components/exam-status-live.tsx:113, 119, 137` — OCR status poll の fetch error silent。 polling 設計上適切。

#### 4.4 握り潰し catch (純粋 silent)

- [P2] `app/api/webhooks/clerk/route.ts:79` — svix.verify failure を `catch {` で 400 return、 ログなし。 invalid signature は攻撃 trial の signal なので logger.warn (Stripe webhook 行 35 と pattern を揃える)。 工数 S
- [P2] `app/api/entity-mutations/bulk/route.ts:166` — `catch {` で `invalid_json` 返却、 ログなし。 client が壊れた payload を送ったときの観測性ゼロ。 工数 S
- [P2] `app/api/review-events/bulk/route.ts:473` — 同上 (invalid_json)。 工数 S
- [P3] `app/(app)/app/upload/_actions/process.ts:184` — `pdfPageCount` 失敗を `catch {` で 1 ページ fallback。 logger.info で「PDF parse fail → fallback 1」 を残すと quota 関連調査時の証跡になる。 工数 S
- [P3] `lib/exams/ocr-poll-signal.ts:39` / `lib/logger.ts:64` / `app/global-error.tsx` 全体 — pub/sub by-design / 二重 throw silent by-design / uncaught error fallback (error props 未使用、 server 側は instrumentation で別経路カバー済)。

#### 4.5 error response への内部情報混入

- [P1] `app/(app)/app/upload/_actions/process.ts:447, 499, 573, 637` — `details.rawError` に `err.message` 生入り。 client 表示は `NEXT_PUBLIC_VERCEL_ENV !== 'production'` で gate されているが、 **server action 戻り値そのものは network 上 production でも client に送られる**ため、 production DevTools で raw error が見える。 Gemini SDK / DB error に SQL や stack 断片が混ざる可能性。 推奨: production では `rawError` を含めず server 側 gate を追加。 工数 M
- [P2] `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx:567, 575, 625, 633` — `setLastError(e instanceof Error ? e.message : String(e))` を popover UI に出力。 意図的 user message (同名衝突 throw) と Dexie 内部 error が同じ UI 経路。 用途別 error class で narrow し、 内部 error は汎用文言に倒して logger に流す。 工数 M
- [P2] `card-tag-edit-popover.tsx:212, 220` — 同上。 工数 S
- [P2] `app/(app)/app/settings/delete-button.tsx:60-66` — staging のみ表示 (`NEXT_PUBLIC_VERCEL_ENV !== 'production'` gate) なので production safe。 staging で表示される error が PII / token 断片を含む可能性をレビュー観点で念のため。 工数 S

### 既知の合流

- `lib/ai/ocr.ts:125-127` (callWithRetry onAttempt catch、 counter best-effort 設計、 codex #3 関連)
- `app/api/me/deletion-status/route.ts:1-59` (status 漏洩、 codex #6)
- `app/api/webhooks/clerk/route.ts:206, 214-215, 390-391` (`String(err)` で stack 等が落ちる、 s1-9-5)
- `app/api/webhooks/clerk/route.ts:103-113` / `app/api/webhooks/stripe/route.ts:55-67` (200 swallow + notifyOps + runbook 不足、 codex #7)

---

## 5. 領域4 — 重複・無駄

監査対象: コピペ実装 / dead code / 未使用 export / 同一ロジック多重実装。

**全体評価**: 構造的負債は厚いが production 上の穴ではない (subagent は最大 P0 ラベルを付けたが本 doc では P1 に格下げ、 「lost write」 等の運用穴ではないため)。 ただし Sync-fix-1 sprint の収束ターゲットとしては妥当な list。

### 新規発見

#### 5.1 コピペ実装

- [P1] `app/(app)/app/tags/_components/option-row.tsx:118-161` (`enqueueUpdate`) — optimistic IDB update + `enqueueEntityMutation` + debounce drain の 40+ 行 pattern が `tags/_components/category-row.tsx:86-124` と論理同形 (同 file comment が「OptionRow と同形」 と明記)。 `inline-text-field.tsx:153-204` の commit + scheduleDrain も同構造。 推奨: `lib/sync/use-optimistic-mutation.ts` 共通 hook に集約。 工数 M
- [P1] `app/(app)/app/exams/[id]/_components/card-tags-section.tsx:111-234` — `handleRenameCategory` / `handleSetCategoryColor` / `handleRenameOption` / `handleSetOptionColor` の 4 関数が「before snapshot → 値変更検査 → mirror update → enqueue → catch で revert」 25 行 pattern を 1:1 コピペ展開。 既知の「色 path A vs B」 は本 4 関数 (path B)。 推奨: `lib/tags/apply-tag-field-mutation.ts` で 1 関数に統合 (Sync-fix-1 と同タイミング)。 工数 M
- [P1] `app/(app)/app/exams/[id]/_components/inline-text-field.tsx:73-301` と `inline-option-row.tsx:459-585` (`InlineOptionCell`) — `sharedBoxChrome`, useLayoutEffect auto-resize, `lastSyncedInitialValue` dirty-guard, `whitespace-pre-wrap` + 末尾 `<br>` 補正、 `multiline ? Textarea : Input` 分岐まで完全同形 (cell 側 100+ 行コピペ)。 推奨: 共通 `inline-editable-cell.tsx` primitive 抽出。 工数 L
- [P1] `lib/tags/reorder-handlers.ts:42-81` (`handleReorderCategories`) と `:88-129` (`handleReorderOptions`) — same-tx atomic + defensive filter + reindex + flush の 40 行 pattern を 2 関数で 1:1。 工数 S
- [P1] `app/(app)/app/_components/review-flush-trigger.tsx:25-67` / `entity-mutation-flush-trigger.tsx:39-107` / `pull-trigger.tsx:38-73` — mount kick + `visibilitychange` + `online` listener の 40+ 行 trigger ボイラープレートが 3 file で同形。 推奨: `useSyncTriggers(kick, opts)` 共通 hook。 工数 S
- [P1] `lib/sync/entity-mutation-flush.ts:31-88` と `lib/sync/review-flush.ts:33-120` — Web Locks wrapping (60 行) が LOCK_NAME と flushAll のみ差で展開。 既存コメントで「review-flush を mirror」 と明示。 推奨: `lib/sync/with-web-lock.ts` で 1 関数化。 工数 S
- [P1] `tags/_components/option-create-form.tsx:65-121` と `category-create-form.tsx:49-103` — submit の「newId() → mirror put with `user_id:''` placeholder → enqueue create → `runGuardedEntityMutationFlush()` → form reset」 50+ 行が同形。 工数 S
- [P1] `exams/[id]/_components/delete-card-button.tsx:55-136` と `exams/_components/delete-exam-button.tsx:50-131` — Phase = 'idle'|'confirm'|'deleting'|'error' の 4 phase ボタン UI render (80 行) が文言以外完全同形。 推奨: `<TwoPhaseDeleteButton>` primitive。 工数 S
- [P1] `tags/_components/category-list.tsx:242-286` と `option-list.tsx:200-256` — `handleManagerDragEnd` (arrayMove + reorder dispatch) + `DndContext`/`SortableContext` JSX が同形 (`card-tag-add-popover.tsx` の stage1/stage2 D&D も同 pattern を再展開)。 推奨: `useDndReorder(list, dispatch)` + `<SortableListShell>`。 工数 M
- [P2] `settings/_actions/save-session-limit.ts:9-39` と `save-fsrs-mode.ts:15-42` — user_settings UPSERT pattern (auth check → INSERT + onConflictDoUpdate → try/catch logger.error) がほぼ同形。 工数 S
- [P2] `lib/ai-usage-mcq.ts:32` と `app/(app)/app/upload/_actions/process.ts:329` — `new Date(... + 9 * 3600 * 1000)` で UTC→JST 月境界 / HH:mm shift をインライン再実装 (`lib/jst.ts` は date 専用)。 推奨: `lib/jst.ts` に `toJstDate(now)` を追加して寄せる。 工数 S
- [P2] 23+ 箇所 — `.catch((err) => logger.warn({ event: '...failed', id, err: String(err) }))` boilerplate (`card-tags-section.tsx` / `option-row.tsx` / `category-row.tsx` / `option-create-form.tsx` / `category-create-form.tsx` / `option-list.tsx` / `category-list.tsx` / `inline-text-field.tsx` / `inline-option-row.tsx` / `inline-card-list.tsx`)。 領域3 §4.1 の `String(err)` 問題と統合 fix 可能。 推奨: `logger.warnFromError(event, ctx)` ヘルパ。 工数 S

#### 5.2 dead code / 未使用 export (repo grep 0 件)

- [P1] `lib/sync/review-events.ts:79 abandonStudySession` — 完全 dead (declaration + test 以外参照 0)。 工数 S
- [P1] `lib/ai/clients/gemini.ts:29 _resetClientForTests` — repo 内参照 0 件 (test setup でも未使用)。 工数 S
- [P2] `lib/ai/schemas/ocr-response.ts:14 ExtractedOption` / `:21 ExtractedImage` / `:39 DiscoverResponse` — `ExtractedCard` のみ消費、 残り 3 型は参照 0。 工数 S
- [P2] `lib/db/schema.ts` の `New*` Drizzle insert 型 18 個 (NewUser / NewReview / NewClerkEvent / NewDeletionFailure / NewExam / NewCard / NewSourceDocument / NewUploadRecord / NewStudyDay / NewUserSettings / NewContactMessage / NewStudySession / NewAnswerEvent / NewEntityMutation / NewTagCategory / NewTagOption / NewCardTag / NewTombstone) — 全て repo 内参照 0 件。 必要時 `.$inferInsert` で再生成可。 工数 S
- [P2] `lib/db/schema.ts` の select 型 11 個 (AiUsage / AiUsageUser / StripeEvent / ClerkEvent / DeletionFailure / StudyDay / UserSettings / ContactMessage / StudySession / AnswerEvent / EntityMutation) — repo 内参照 0 件。 工数 S
- [P2] `lib/sync/server/entity-mutation-registry.ts:290 ENTITY_MUTATION_REGISTRY` — `getEntityHandler` (同 file) のみ参照 → module-private で十分。 工数 S
- [P2] `lib/tags/apply-tag-mutation.ts:30,60,62,165,211,213` の 6 型 — 同 file 内消費のみ。 工数 S
- [P2] `lib/cards/apply-card-mutation.ts:36 ApplyCardCreateWithIdInput / :48 ApplyCardCreateWithIdResult` — 同 file 内消費のみ。 工数 S
- [P2] `lib/cards/card-field-handlers.ts:43 CardFieldHandler / :264 CardFieldName` — 外部参照 0。 工数 S
- [P3] 同様の内部完結 export 多数 (`review-flush.ts:81/126/136`, `entity-mutation-flush.ts:41`, `review-events.ts:40/107/88`, `entity-mutations.ts:33`, `sync-meta.ts:23`, `build-new-client-card.ts:13`, `replay-card.ts:36`, `streak.ts:51`, `serialize-db-error.ts:92`, `exams/list.ts:41/131`, `ai-usage-mcq.ts:67`, `ocr.ts:76`, `gemini.ts:39/46`, `clerk-metadata.ts:27/33`, `stripe/subscription.ts:31`, `price-mapping.ts:21`, `plan-catalog.ts:15`, `app/(app)/app/_components/exam-status-poll.ts:7`, `process.ts:40/47/98`, `dedupe-filenames.ts:7`, `study-days.ts:27`, `entity-mutation-registry.ts:58/71`, `scripts/backfill-clerk-metadata.ts:28/45/51`) — type-only 利用、 「return 型ドキュメント」 として残す価値はあるが strict 整理なら `export` 落とし可。 工数 S 一括

#### 5.3 同一ロジック多重実装 (新規)

- [P2] JST 算術 — `lib/jst.ts:4` / `lib/ai-usage-mcq.ts:32` / `process.ts:329` が独立に `9 * 3600 * 1000` を inline 化。 `lib/jst.ts` に `toJstDate(d)` 追加で 3 箇所統合。 工数 S

(備考: `lib/cards/next-card-sort-key.ts` と `lib/tags/next-sort-key.ts` は意味論差 (起点 '1' vs '0' / 非数値 fallback) が banner で明示済、 多重実装ではない)

### 既知の合流

- Sync-fix-1 一斉差し替え対象 (optimistic 経路 8 file): 詳細は領域2 既知欄参照
- 色 path A (manager) vs path B (popover) 既知合流: `tags/_components/category-row.tsx:86-124,130-132` / `option-row.tsx:118-161,202-204` / `exams/[id]/_components/card-tags-section.tsx:145-234` / `card-tag-edit-fields.tsx:43,176-186` / `card-tag-edit-popover.tsx:215-222`
- `inline-option-row.tsx` refs structural (Sync-fix-1): 行 104-115 / 140-153 / 228-238

---

## 6. 領域5 — 型安全

監査対象: any / as 濫用 / @ts-ignore / zod schema と TS 型の二重定義乖離 / unknown narrow / non-null assertion 連発。

**全体評価**: TS strict 有効 (`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` 未有効)。 `: any` / `as any` / `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` は **0 件** (test / stub 除外後)。 zod parse 経路は概ね健全。 ただし内部 API 戻り値と untrusted external (Clerk webhook) の as 断定、 schema 双子型 (drizzle vs ClientX vs zod) の drift 余地が新規発見。

### 新規発見

- [P1] `lib/sync/pull.ts:100` — `(await res.json()) as PullResponse` で server `/api/pull` レスポンスを zod validate せず断定。 行 162-182 の shape check は array / object 表層のみで field 形未検査。 server schema 変更で client が静かに stale 構造を bulkPut する経路。 推奨: `PullResponse` の zod schema を別 module で定義し safeParse、 fail 時は FAIL を返す。 工数 M
- [P1] `app/api/webhooks/clerk/route.ts:78` — `wh.verify(...) as ClerkEvent` で svix `verify` 戻り `unknown` を直接 union 型 assert。 行 98 (`evt.data as { id?: string }`) / 行 120 / 147 で untrusted external payload を zod 無しで断定。 Clerk が `email_addresses[0].email_address` 形を変えると runtime `undefined.email_address` TypeError。 推奨: `clerkUserCreatedSchema` / `clerkUserDeletedSchema` を zod 定義 + safeParse。 工数 M
- [P1] `lib/sync/server/entity-mutation-registry.ts:137,211,258` — `patch as { field: string; value: unknown }` 等の inline cast を、 他箇所 `z.infer<typeof xSchema>` 形式から外れて行っている。 事前 zod parse 通過済のため runtime 安全だが envelope schema 書換時に cast 側が追従しない drift 余地。 推奨: 全 apply 関数で `z.infer<typeof cardUpdateFieldPatchSchema>` 等の統一形に揃え、 cast literal 削除。 工数 S
- [P2] `lib/ai/ocr.ts:32-58` vs `lib/ai/schemas/ocr-response.ts:14-41` — `ExtractedCard` / `ExtractedOption` / `ExtractedImage` を手書き type で定義する一方、 同名 `cardSchema` 等を zod で再定義し、 `parseAndValidate` 戻り `result.data.cards` を `ExtractedCard[]` として返している。 構造的互換が偶然成り立っているだけで、 一方が `correct_answer_ids` を optional 化すると compile error が出ず runtime で undefined。 推奨: zod schema を SSoT にして `type ExtractedCard = z.infer<typeof cardSchema>`。 工数 M
- [P2] `lib/client-db.ts:40-192` vs `lib/db/schema.ts:46-825` — `ClientCard` / `ClientExam` / `ClientUserSettings` / `ClientStudySession` / `ClientAnswerEvent` / `ClientTagCategory` / `ClientTagOption` / `ClientCardTag` / `ClientCardOption` / `ClientCardImage` を snake_case + 一部 timestamp string 化した手書き mirror で再定義し、 `cards-mapper.ts` の `toClientCard` / `toCard` は両者を「structural にたまたま一致する」 だけで繋いでいる。 schema 列追加 / null 化 / 型変更で mapper は compile が通り続け mirror が静かに壊れる。 推奨: 各 Client* 型を drizzle `$inferSelect` から Snakeify 系 mapped type で機械生成し、 mapper を `satisfies` で固定。 工数 L
- [P2] `lib/db/streak.ts:76,87` — `db.execute<{ c: number }>` / `db.execute<{ d: string }>` で raw SQL 戻りを未検証で typed generic にバインド。 `dateRows.map((r) => r.d)` でそのまま流れている。 同様 pattern は `app/api/review-events/bulk/route.ts:385` で `Array<{ c: unknown }>` + `Number()` に直されている。 推奨: streak.ts も `Array<{ d: unknown }>` + 個別 typeof check に揃える。 工数 S
- [P2] `app/(app)/app/upload/_actions/process.ts:518,521` — `c.options as CardOption[]` / `(c.images ?? []) as CardImage[]` で zod-validated `ExtractedOption[]` を drizzle `CardOption[]` へ断定。 双子重複型 drift がここで具現化。 推奨: 明示的 mapper `extractedOptionToCard(o)` で field copy。 工数 S
- [P2] `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:53` — `Array.isArray(c.options) ? (c.options as CardOption[]) : []` で `ClientCardOption[]` → `CardOption[]` 断定。 同 drift 経路。 工数 S
- [P2] `lib/tags/apply-tag-mutation.ts:73,224` — `const set: Record<string, unknown> = {}` を drizzle `.set(set)` に渡し、 column 名と型の整合検証が消失 (`set.nme = ...` の typo を TS が捕まえない)。 推奨: `Partial<typeof tagCategories.$inferInsert>` 形に。 工数 S
- [P3] `lib/cards/apply-card-mutation.ts:152` (`rows[0]!.examId`) / `lib/tags/apply-tag-mutation.ts:243,288` — 直前で 0 件 return 済で意味的に安全だが、 `noUncheckedIndexedAccess` 未有効ゆえ `!` 自体は不要。 残置妥当だが、 将来 noUncheckedIndexedAccess 有効化時に一掃。 工数 S
- [P3] `inline-option-row.tsx:84,243` / `card-tag-edit-popover.tsx:209,217,225,233` — index 内ループの境界条件確定 / gating 済の non-null assertion。 残置妥当または narrow 構造で消せる。 工数 S
- [P3] `upgrade/actions.ts:46,126` — `plan as PaidPlan` / `interval as BillingInterval`。 narrow が代入経由で継承されれば不要。 工数 S
- [P3] `lib/client/streak.ts:73` — `for (const r of rows as ClientStudyDay[])` cast が冗長 (Dexie `Table<T>` で型既知)。 工数 S
- [P3] `app/api/review-events/bulk/route.ts:483` — `parsed.data as BulkPayload` cast 不要。 工数 S
- [P3] `lib/sync/study-days.ts:40` / `entity-mutations.ts:220` / `review-events.ts:251` — fetch 戻り `(await res.json()) as typeof body`。 内部 API ながら P1 (pull.ts) ほど重くないが server 側 field 名変更で client が壊れない振りをする。 中期 zod schema 化。 工数 M

### 残置妥当 (修正対象外)

- `lib/sync/pull.ts:332` / `entity-mutation-flush.ts:53` / `review-flush.ts:93` — `navigator.locks as unknown as MinimalLockManager` (lib.dom 待ち)
- `lib/sync/entity-mutations.ts:111` — `localId as number` (Dexie SDK 戻り `IndexableType`)
- `lib/db/serialize-db-error.ts:32,63,77,159` — typeof 経由の defensive narrow
- `lib/ai/clients/gemini.ts:63-65` — 段階的 narrow + 意図コメント
- `app/api/webhooks/stripe/route.ts:182,239,299,352` — Stripe SDK 公式 downcast pattern
- `inline-option-row.tsx:539,547` / `inline-text-field.tsx:249,259` — Textarea/Input 分岐の常套手段
- `tag-manager-shell.tsx:61` / `contact-form.tsx:105` — 値域が children Trigger / option list で確定

### 補足

- `noUncheckedIndexedAccess` を有効化する単独 sprint で上記 P3 が一掃される (compile error 大量 → ほぼ `?.` / 早期 return で吸収可)。
- TS 6.0.3 移行 (既知 波3) と合わせて `exactOptionalPropertyTypes` も検討 → `ClientCard` の `source_document_id?: string | null` のような `undefined`/`null` 二重 absent 表現を浮き彫り化。

### 既知の合流

- TS 6.0.3 移行 (波3)
- `vitest-stubs/` の any 多用 (stub のため許容)
- `lib/db/schema.ts` コメント保守性 (codex #8)

---

## 7. 領域6 — perf

監査対象: N+1 (SQL/IDB) / useLiveQuery 過剰 re-render / bundle に不要に乗る依存 / rendering / 大 payload。

P0 は §1.2 (5 件) を参照。 ここでは P1〜P3。

### 新規発見

- [P1] `lib/cards/get-dexie-session-cards.ts:29-37` — smart session 開始時に user の全 cards を toArray した後 JS で due フィルタ + sort + slice。 N=1k で 5-15 MB JSON 復元。 dashboard-actions と同じ `[user_id+due]` compound index 改善で同時解消可 (`belowOrEqual([userId, nowIso])` + `.limit(limit)`)。 工数 M
- [P1] `app/(app)/app/tags/_components/category-list.tsx:144-149` — `for (const opt of options) { await db.card_tags.where('option_id').equals(opt.id).count() }` の IDB N+1。 option N 個で N round-trip。 推奨: `db.card_tags.where('option_id').anyOf(optionIds).count()` 1 発で合算。 工数 S
- [P1] `card-tags-section.tsx:308-314` (`countCategoryImpact`) — 同 IDB N+1 (option ごとに `card_tags.where('option_id').equals(opt.id).toArray()`)。 distinct card_id 集計のため Set 作成しているので `anyOf(optionIds).toArray()` 1 発 + JS Set 構築に置換可。 popover 開く毎に発火するため大規模 user で popover lag。 工数 S
- [P1] `card-tags-section.tsx:541-553` + `:667-680` — レンダー O(cards × tags × options) の `find()` ループ。 100 cards × 5 tags × 50 options = 50k 走査/tick、 useLiveQuery 再評価毎に発火。 推奨: 親で `Map<optionId, ClientTagOption>` / `Map<categoryId, ClientTagCategory>` を一度作って渡す。 工数 S
- [P1] `lib/sync/entity-mutations.ts:80-96` — `enqueueEntityMutation` が毎呼出で全 pending 行 toArray + in-memory find で coalesce。 打鍵単位で毎回走るため、 outbox に大量 pending が貯まった状態 (オフライン復帰直前) で打鍵が線形劣化。 schema 上 `[entity_type+entity_id]` index は宣言済 + sync_status filter で絞れる。 工数 S (領域2 §3 と同件)
- [P2] `lib/db/schema.ts:752-754` — `card_tags` table に (user_id, created_at) compound index がなく、 `/api/pull` `getCardTagsDelta` (WHERE user_id AND created_at >= since) が `card_tags_user_idx` (user_id 単独) を走査 + 残り scan。 card_tags 数万件 user で線形。 推奨: `index('card_tags_user_created_idx').on(t.userId, t.createdAt)` 追加。 工数 S
- [P2] `components/ui/{popover,tabs,label,button,dropdown-menu}.tsx` — `radix-ui` umbrella から `Popover as PopoverPrimitive` 等 import。 `next.config.ts` に `experimental.optimizePackageImports` なし。 modern Next で大体 tree-shake されるが、 `radix-ui` v1 umbrella は副作用ある場合あり。 推奨: 直接 `@radix-ui/react-popover` 等にスイッチ + `optimizePackageImports: ['lucide-react', 'radix-ui']`。 工数 S
- [P2] `next.config.ts:1-27` — `experimental.optimizePackageImports` 未設定。 lucide-react / dnd-kit 系の barrel が明示最適化されていない。 推奨: `optimizePackageImports: ['lucide-react', '@dnd-kit/core', '@dnd-kit/sortable']`。 体感 5-15% initial JS 縮。 工数 S
- [P2] `dashboard-stats.tsx:28-34` + `lib/client/streak.ts:66-69` — `db.study_days.where('user_id').equals(userId).toArray()` で 90日分 full snapshot を毎 useLiveQuery 評価で読む。 90 行は軽量だが mirror `clear() + bulkPut()` (`lib/sync/study-days.ts:69-73`) も毎回 90 行 clear+put で subscription 通知が拡散。 推奨: study_days pull の冪等 upsert (PK `[user_id+day]`) で diff-only put に変えると subscription notify が削減。 工数 M
- [P2] `lib/sync/pull.ts:217-260` — pull 1 tx で `changedCardIds.length === N` の `card_tags.where('card_id').anyOf(N).delete()` + `card_tags.bulkPut(M)` + tombstone cascade `card_tags.where('option_id').anyOf(...)` の 3 anyOf を直列。 初回 pull で tx blocking 長引く + 4 store rw lock 抑止。 推奨: 初回 full sync 専用 path で `clear()` ベースの bootstrap、 もしくは pull leg を「メタ系 (exams/tags)」と「重系 (cards/card_tags)」に 2 tx 割って tx hold 半減。 工数 L
- [P3] `lib/db/streak.ts:76-93` — `study_days` から 2 SELECT 直列。 1 query で `SELECT day, distinct_card_count FROM study_days WHERE user_id=... AND day >= lower ORDER BY day DESC` に統合可。 工数 S
- [P3] `card-tags-section.tsx:613-660` (`handleToggle`) — `options.filter(o => o.category_id === categoryId)` を毎クリック発火。 useMemo 化された Map を作るか handler を useCallback + deps 制御で抑止。 工数 S
- [P3] `lib/tags/reorder-handlers.ts:56-66 / 108-118` — 1 tx 内で per-row `await db.tag_categories.update(...)` + `await enqueueEntityMutation(...)` 直列。 N=10-20 で問題ないが enqueueEntityMutation 自身が全 pending toArray を毎回走らせるため drag 1 回で N×(全 pending 数)。 enqueue の find 最適化と組合せで線形複雑度が下がる。 工数 S

### 既知の合流

- `app/api/pull/route.ts:82-89` (codex #2 無制限ページング)
- `lib/db/cards-pull.ts:27` (codex #2、 SELECT * 全件 fetch)
- `components/pricing/pricing-table.tsx:15` / `app/(app)/app/upgrade/upgrade-plans.tsx:14` (codex #5、 client component から price-mapping 型参照)

---

## 8. 領域7 — 運用

監査対象: env validation 漏れ / 構造化ログ不足 / Gemini・R2 コスト暴走経路 / observability の穴 / deploy 前 checklist 自動 enforce。

### 新規発見

#### 8.1 env validation の漏れ

- [P1] `lib/ai/clients/gemini.ts:138` (`OCR_DEBUG_LOG`) / `lib/db/serialize-db-error.ts:140` (`BULK_FULL_PARAMS_LOG`) — flag は `=== '1'` のみチェックし `VERCEL_ENV === 'production'` の組合せ条件未確認。 人為的に production env に `=1` を入れると raw response / full bind params (PII 含む) が Vercel Function Logs に流出。 推奨: `process.env.VERCEL_ENV === 'production'` で gate を二重化、 もしくは module load 時 `production && flag=1` を fail-fast throw。 工数 S (領域1 P2 と統合 fix 可)
- [P1] `app/(app)/app/upload/_actions/process.ts:303` — `parseDailyLimit(process.env.GEMINI_DAILY_LIMIT)` が未設定/不正値で null → guard 完全 off、 `logger.warn({event:'gemini.daily_limit.disabled'})` で可視化するだけで**本番でも止まらず Gemini 呼出が続く**。 CLAUDE.md §AI ルール 3 違反の事故面。 推奨: `VERCEL_ENV==='production'` のとき null は fail-fast、 もしくは hard default fallback。 工数 S
- [P2] `lib/db/index.ts:16-19` — `DATABASE_URL` は first `getDb()` 呼出まで遅延検証 (Clerk/Stripe は module load 時 fail-fast)。 推奨: `lib/env.ts` で zod 一元 schema 化。 工数 M
- [P2] `app/(app)/app/settings/actions.ts:18` / `upgrade/actions.ts:48` — `NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'` の localhost fallback が Stripe `success_url` / `return_url` に乗りうる。 production で env 漏れたら Stripe Checkout が localhost URL を返す。 推奨: production で未設定なら throw。 工数 S
- [P2] `lib/ai/clients/gemini.ts:22-23` — `GEMINI_API_KEY` 不在は初回 callGemini まで遅延 throw (test 容易化のため意図的)。 `instrumentation.ts` register hook で warmup 起動 check を 1 行入れたい。 工数 S
- [P3] `.env.example` の `R2_*` 5 件 + `CLAUDE_CODE_DISCORD_WEBHOOK_URL` — **コード側で実際に参照されていない** (R2 未配線)。 production env に live R2 認証情報を入れた状態で配線忘れに気付けない。 推奨: 配線まで `.env.example` 側にも `# unused, scheduled for ...` コメントで「未使用」 を明示、 中期的に ESLint rule か lefthook で双方向差分 check。 工数 S (短期) / M (長期 lint 化)
- [P3] `upload-form.tsx:775` / `delete-button.tsx:60` — `NEXT_PUBLIC_VERCEL_ENV` を読むが `.env.example` 未記載 (Vercel 自動 inject のため通常 OK)。 ローカル dev では undefined = staging 扱いの挙動を README/.env.example に 1 行コメント。 工数 S

#### 8.2 構造化ログ不足

- [P2] `settings/delete-button.tsx:59` — `console.error('[delete-button] user.delete() failed:', err)` (client browser console のみ)。 削除失敗の Discord / Sentry 送信なし。 推奨: `/api/ops-notify` 経由 server 転送、 もしくは Sentry browser SDK。 工数 M
- [P2] `card-tags-section.tsx:355,413` — `console.error('[Tag-4c-2a] empty user_id, aborting ...')` (client console のみ)。 invariant violation を logger 経路で server に流したい。 工数 M
- [P3] `lib/auth/clerk-metadata.ts:55` — `console.debug` は Vercel デフォルトログレベルに乗らず実質黙殺、 race 頻度の運用観察に使えない。 `logger.info({event:'clerk_metadata.user_not_found'})` に格上げ。 工数 S
- [P3] `lib/logger.ts:46-67` — `event` / `level` / `timestamp` / `environment` は付くが **`userId` / `requestId` / `traceId` を payload 任意 field 扱い** → callsite で書き忘れ散見。 `withContext({userId})` builder で必須化したい。 工数 M
- [P3] `lib/ops.ts:79` / 13 箇所 — `environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown'` を 13 callsite でコピペ。 `notifyOps` 内部 auto-attach、 もしくは `lib/env.ts` helper 化。 工数 S

#### 8.3 Gemini / R2 コスト暴走経路

- [P1] `lib/ai/ocr.ts:97-104` — `BACKOFF_BASE_MS = [5000, 20000]` + `RETRY_AFTER_CAP_MS = 60000` + `MAX_HTTP_RETRIES = 2` で最悪 1 attempt あたり ~220s + 待機 ~60s × 2。 1 OCR job 最大 ~660s (Vercel Pro 900s に近い)。 deadline 720s で打ち切るが、 720s × N file in-flight (advisory lock は 1 user 1 job、 N user 並列) で Gemini API quota 圧迫余地。 service-wide concurrency limit (in-flight processing 行数の global guard) なし。 工数 M
- [P1] `lib/ai/ocr.ts:138-143` — Retry-After ヘッダ尊重で `Math.min(retryAfterMs, 60000)`、 ただし `parseRetryAfterMs` は `@google/genai` SDK 現状実装で実質 null (Headers 露出なし、 行 53-58 コメント)。 SDK 更新で Headers 露出した瞬間 86400s clamp が機能するが、 そこまでサーバー指示を見落とす。 推奨: SDK ChangeLog 監視。 工数 S
- [P1] `app/(app)/app/upload/_actions/process.ts:303-319` — Gemini daily limit guard ↔ retry 中 onAttempt の 2 経路 race (codex #3 既知扱いだが、 上記 P1 と合わせ guard tx の todayCount snapshot と at-attempt インクリメントの間でレース → N 並列 user で限度 +N 件超過構造)。
- [P2] `lib/ai/ocr.ts:106-147` — `callWithRetry` の `onAttempt` (= `incrementAiUsage`) が try/catch なしで counter DB エラー silent swallow (行 122-128 コメント明示)。 計上抜け = 上限突破直結。 推奨: counter 失敗時に `logger.error({event:'ai_usage.increment_failed'})` 1 行 + notifyOps 検討。 工数 S
- [P2] `process.ts:180-191` — `pdfPageCount` 失敗時 `totalPages += 1` (1 ページ扱い) で OCR に流す。 暗号化 PDF / 高ページ数 PDF を 1 ページ計上で OCR_MAX_PAGES (40) を実質バイパス、 月次 quota / Gemini token を実消費後 1 ページ計上で漏れ。 推奨: pdfPageCount 失敗時は file ごと reject か OCR_FAILED 早期 return。 工数 S
- [P2] `lib/ai/clients/gemini.ts:16` — `GEMINI_TIMEOUT_MS = 220_000`。 `AbortController` は client 側 fetch 中断のみで Gemini server 側は処理継続 = 課金される。 @google/genai 挙動上避けようがないが監視 / ドキュメント化推奨。 工数 S
- (備考) R2 (Cloudflare) — コード経路ゼロ (lib/r2/, scripts/ に R2 SDK 参照なし)、 `.env.local` に live API key 配置のみ。 配線時に同 review 再実施。

#### 8.4 observability の穴

- [P1] `app/api/webhooks/stripe/route.ts:208` — `await stripe.subscriptions.retrieve(subId)` (checkout.session.completed Step 2 race defense) の Stripe 5xx / timeout が outer catch (notifyWebhookError + 200) に流れる。 設計上は customer link (Step 1) は成功済で webhook 後着が recover する想定だが、 recover 検証経路がない。 stuck (Stripe sub あるが DB users.plan='free') を検知する dashboard / 定期 job 未配備 (codex #7 webhook runbook 既知)。
- [P1] `app/api/webhooks/clerk/route.ts:173-180` — user.deleted webhook 受信時に users 行ない状態 = (1) sign-up 直後 race (2) backfill 抜け の 2 系統。 後者は手動 recovery script 必要だが runbook 不在 (codex #7)。
- [P2] `lib/ops.ts:55-57` — Discord fetch 失敗時 `logger.warn({event:'ops.notify.fetch_failed', err})` のみ。 Discord 自体落ち / webhook revoked / rate-limit 中は notifyOps が黙る → onRequestError fallback も同 webhook → 二重黙殺。 推奨: notifyOps fail 時の Vercel `console.error` 太字 alert + 二段経路 (Sentry breadcrumb 等)。 工数 M
- [P2] `lib/ai-usage-counter.ts:28-44` — increment tx 失敗時 caller (`lib/ai/ocr.ts:122-128` onAttempt) は silent swallow + notifyOps なし。 counter 抜け = quota guard 抜け直結。 工数 S (§8.3 と統合)
- [P2] `lib/db/index.ts:14-22` — `getDb()` で `DATABASE_URL` 不在 throw あるが、 postgres 接続自体の throw を catch する notifyOps 経路がない。 DB down 時に Server Action / route が generic 500 を返すだけで Discord 通知に乗らない (instrumentation.onRequestError は uncaught のみ、 server action throw は cause 包装で発火しない場合あり)。 工数 M
- [P2] `app/api/webhooks/stripe/route.ts:52-67` — outer try に `inserted = []` (duplicate) は入らないため「重複 event だが初回処理が失敗していた」 ケースは構造的に検知不能。 stripe_events に row はあるが users.plan 未同期 = 永久 stuck。 推奨: stripe_events に `processed_at` / `status` 列追加、 outer catch で processed_at NULL 残置。 工数 M
- [P3] `lib/logger.ts` — Sentry-swap-ready comment (file header) あるが swap 未実施で Vercel Function Logs のみ。 retention / cross-function correlation / alert ルールが Vercel 内で限定的。 Phase 1 F (Sentry) の plan が docs にある模様だが進捗未確認。 工数 L

#### 8.5 deploy 前 checklist 自動 enforce

- [P2] `app/api/webhooks/stripe/route.ts:19` (`STRIPE_WEBHOOK_SECRET`) / `app/api/webhooks/clerk/route.ts:55` (`CLERK_WEBHOOK_SECRET`) — `NODE_ENV === 'production'` で弾く設計だが、 Vercel Preview (= NODE_ENV='production') では 500 が出る。 staging preview で誤って未設定だと webhook 全失敗。 推奨: `VERCEL_ENV` 分岐 (production 必須 / preview 警告 / local 許容)。 工数 S
- (確認) `lib/stripe.ts:28-58` / `lib/clerk.ts:28-58` の env-aware fail-fast は自動 enforce 済 OK。

### 既知の合流

- `app/(app)/app/upload/_actions/process.ts:303-319` (Gemini 日次上限 approximate / 非 atomic、 codex #3)
- `app/api/webhooks/stripe/route.ts:208` / `app/api/webhooks/clerk/route.ts:173-180` (webhook 失敗後 runbook 不足、 codex #7)
- `lib/stripe/price-mapping.ts:34-37` (codex #5、 module load 時 4 env fail-fast)

---

## 9. 既知の合流 (横断サマリ、 重複登録なし)

新規 finding と独立に、 既知 todo を各領域で再発見した file:line を横断統合。 **新規欄重複登録なし**、 出典のみ示す。

| 既知項目 | 出典 | 主要 file:line |
|---|---|---|
| `/api/pull` 無制限ページング | codex #2 / Phase 4 | `app/api/pull/route.ts:73-89, 82-89` / `lib/db/cards-pull.ts:25-29, 27` / `exams-pull.ts:30-35` / `tombstones-pull.ts:33-38` / tag-*-pull / card-tags-pull |
| Sync-fix-1: void enqueue + 空文字 user_id | tag-4c-2a-* 系 spec | `tags/_components/{category-row.tsx:104-116, option-row.tsx:141-145, category-create-form.tsx:64-96, option-create-form.tsx:99-104, category-list.tsx:170-207, option-list.tsx:149-175}` + `exams/[id]/_components/card-tags-section.tsx:{135,166,200,230,354-356,412-414}` |
| Sync-fix-1: 色 path A (manager) vs path B (popover) | tag-color-step0 | `category-row.tsx:86-124,130-132` / `option-row.tsx:118-161,202-204` / `card-tags-section.tsx:145-234` / `card-tag-edit-fields.tsx:43,176-186` / `card-tag-edit-popover.tsx:215-222` |
| Sync-fix-1: inline-option-row refs structural | eslint-ci-gate spec | `inline-option-row.tsx:104-115, 140-153, 228-238` |
| user deletion physical cascade (GDPR) | s1-9-5 | `app/api/webhooks/clerk/route.ts:226-287` |
| webhook 200 swallow + runbook 不足 | codex #7 | `app/api/webhooks/clerk/route.ts:103-114, 173-180, 206, 214-215, 390-391` / `stripe/route.ts:55-67, 208` |
| deletion-status userId 列挙 | codex #6 | `app/api/me/deletion-status/route.ts:19-39, 33-39` |
| String(err) 統一 (deletion polling 周辺) | s1-9-5 trace | `webhooks/clerk/route.ts:206, 214-215, 390-391` |
| Gemini 日次上限 approximate | codex #3 | `process.ts:303-319` / `lib/ai/ocr.ts:122-128` / `lib/ai-usage-counter.ts` |
| price-mapping import 境界 | codex #5 | `lib/stripe/price-mapping.ts:34-37` / `components/pricing/pricing-table.tsx:15` / `upgrade-plans.tsx:14` |
| schema コメント保守性 | codex #8 | `lib/db/schema.ts` 各 table |
| TS 6.0.3 移行 + ESLint 厳格化 | 波3 / `noUncheckedIndexedAccess` | tsconfig.json / `lib/cards/apply-card-mutation.ts:152` 他 |

---

## 10. 取扱い注意

- 本 doc は **着手 sprint roadmap ではない**。 §1 P0 を最初に対応するかは OT 判断。 P0 ラベルは「launch 後本番運用で確実に問題化」 の subagent 評価であり、 業務上の優先順位 (機能欠落 vs 体感改善 vs 安全) は OT が `docs/next-sprints-priority.md` 上で別途決定。
- 各 finding は subagent の判定をそのまま転載 (大規模 dedup + 整形済)。 P0/P1 のラベルは subagent 観点での絶対値ではなく**領域内相対**で判定されたものを controller がさらに再評価して `1.x P0` として 7 件に絞り込んだ。 領域単独で「P0」 と書いてあるもののうち、 docs での P0 セクション (§1) に上がっていないものは P1 相当として扱う。
- 数件、 同じ file:line が複数領域で別観点から指摘されているもの (例: `entity-mutations/bulk/route.ts:184-205` は perf P0 + data-integrity P2、 `enqueueEntityMutation` の coalesce は data-integrity P2 + perf P1) があるが、 fix は 1 PR で多軸を同時に解消するため重複ではなく多軸の確認として残置。
- 次の sprint で本 doc を再読する OT 用に、 各 finding は file:line ベースで grep 可能な形を維持。 「修正済」 になったら本 doc の該当 bullet 先頭に `~~` 取消線を追加 (削除しない、 audit log として保持) を推奨。

---

## 11. 監査メタ情報

- subagent 配備: 7 領域 × general-purpose subagent (各 fresh context)
- 領域: (1) セキュリティ、 (2) データ整合性、 (3) エラー処理、 (4) 重複・無駄、 (5) 型安全、 (6) perf、 (7) 運用
- controller: 既知 todo 集約 (`next-sprints-priority.md` v18 / `codex/2026-06-08-codex-review.md` 8 項 / tag-4c-2a-* spec の Sync-fix-1 言及 / s1-9-5 系 / cache-fix roadmap)
- 監査時の repo HEAD: develop 先端 (`efa4ed1 docs: 波1 後始末`)、 波1 + 波2 prod deploy 直後の状態
- 修正コミット: 一切なし (本 doc 起票のみ、 `docs(audit): ... [no-review]`)
