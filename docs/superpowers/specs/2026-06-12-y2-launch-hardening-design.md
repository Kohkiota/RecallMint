# Sprint Y-2: launch 前 hardening — Design Doc

- **起票日**: 2026-06-12
- **位置づけ**: launch 前 hardening 小 sprint (Sync-fix-1 拡大版 = Y-1 と独立)、 audit §10.3 (b) + 軽微 2 件 + OT 追加 Permissions-Policy を打ち切り。 prod cutover risk を P1 ゼロまで圧縮する。
- **前段**: Y-1 完了 (prod 反映済、 0866728)。 Y-2 着手は OT 承認受領 (2026-06-12)、 brainstorming step 1-5 完了 + OT 5 修正反映。
- **出典**: `docs/audit/2026-06-12-repo-wide-audit.md` §10.3 (b) (L402-425) + §10.4 #10-#11 (Y-2 格上げ) + 軽微 2 件 (OT 報告) + Permissions-Policy (audit 外、 OT 追加)。
- **次段**: 本 spec の OT review gate pass 後、 `superpowers:writing-plans` で 1 sub-plan = 1 plan の **3 sub-plan** に分割起草。

---

## 1. 目的とスコープ

### 1.1 目的

1. audit §10.3 (b) の P1 中心 hardening 項目を本 sprint で一括解消、 launch 前必須を全消化する。
2. 重要 fix (削除 / 認証 = #11c / H5) は OT 実機確認後 [reviewed] amend で安全に通す (CLAUDE.md「重要 Fix 裏取り」 規律準拠)。
3. Y-2 最大リスク (#1b per-mutation tx 並列化) を順序保証契約付きで設計、 outbox 再送収束性を壊さない。

### 1.2 スコープ (23 item、 Grid-1 合流の #3 + Phase 4 既定の #9 を除く)

3 sub-plan に分割。 各 sub-plan 250 行 cap。

- **Sub-plan A — route hardening** (9 item) = H1 / H4 / H5 / #5 / #6 / #10 / #13 / #15 / #11c
- **Sub-plan B — performance** (8 item effective) = #1a / #1b / #1c / #1d / #1e / #2 / #7 / H7
- **Sub-plan C — config / header / cleanup / docs** (6 item) = H2 / H3 / H6 / #8 / Perm / #10d

**注 (immediate follow-up §10.1 結果反映、 2026-06-12)**: audit §10.3 (b) #9 「pull.ts レスポンス zod parse 化」 は Y-1 spec (`2026-06-12-sync-fix-1-expanded-design.md` L34, L343) で **Phase 4 既定 scope と明示済**のため、 本 Y-2 sprint から除外。 todo v19 (OT 側) の修正要請を §10.1 に記載。 → Y-2 編入は **24 → 23 item**。

### 1.3 スコープ外 (明示)

| 項目 | 受け入れ先 |
|---|---|
| dependent multi-mutation atomic group (audit §10.3 (b) #18) | Grid-2 で設計 |
| card_tags `.anyOf` 集約 2 件 (audit §10.3 (b) #3) | Grid-1 (テーブル化と同時に計測 + 修正) |
| NEXT_PUBLIC_APP_URL production fail-fast (#16) | Y-3 |
| card_tags `(user_id, created_at)` compound index (#19) | Y-3 |
| stripe_events に processed_at/status 列追加 (#20) | Y-3 |

---

## 2. Sub-plan A — route hardening (10 item)

### 2.1 一覧

| ID | 内容 | 設計骨子 |
|---|---|---|
| H1 (§10.3 (b) #11) | bulk 2 route transient → 503 + Retry-After | review-events/entity-mutations bulk の transient error (DB conflict / lock timeout) を 5xx 系 → 503 + `Retry-After: <sec>` header 付与、 client retry controller の transient/permanent 分岐と整合 |
| H4 (§10.3 (b) #14) | OPS webhook fail-fast + 代替 error sink | `OPS_DISCORD_WEBHOOK_URL` 未設定で production fail-fast (起動時 `lib/ops.ts` level)、 fallback = `logger.error({event: 'ops.notify.unreachable', ...})` で stderr に必ず残す |
| **H5** (§10.3 (b) #17) | webhook secret env-aware | `STRIPE_WEBHOOK_SECRET` / `CLERK_WEBHOOK_SECRET` を production = required (起動時 fail-fast)、 preview = warn のみ、 local = skip。 **重要 fix 該当 (認証)** |
| #5 (§10.3 (b) #5) | OCR_DEBUG_LOG / BULK_FULL_PARAMS_LOG production gate 二重化 | env 直 + `lib/ocr/log-gate.ts` (or 既存 file) の 2 段判定、 production で uncontrolled true 化を防止 |
| #6 (§10.3 (b) #6) | GEMINI_DAILY_LIMIT production fail-fast | production で env 欠落時 startup throw、 quota 機構の no-op を防ぐ |
| ~~#9 (§10.3 (b) #9)~~ | ~~pull.ts レスポンス zod parse 化~~ | **本 sprint 除外** (§10.1 follow-up 結果: Y-1 spec L34, L343 で Phase 4 scope と既明示)。 todo v19 修正要請を §10.1 に記載 |
| #10 (§10.3 (b) #10) | webhook clerk payload zod 化 | Clerk webhook (`user.created` / `user.deleted`) の payload を zod schema で safeParse、 unknown field を ignore (Clerk schema drift 耐性) |
| #13 (§10.3 (b) #13) | proxy.ts webhook bypass | `proxy.ts` matcher から `/api/webhooks/(.*)` を除外、 webhook が Clerk auth context を要求しないことを構造保証 |
| #15 (§10.3 (b) #15) | contact rate limit | `/api/contact` (問い合わせ form) の IP / userId 単位 rate limit (e.g. 5 req/h)、 abuse 防止 |
| **#11c** (§10.4 #11 格上げ) | deletion-status nonce/signed token 化 | 削除 status 確認 URL の予測可能性排除、 server signed token (HMAC + ttl) で query parameter 化。 **重要 fix 該当 (削除 + 認証)** |

### 2.2 重要 fix 規律 (CLAUDE.md「重要 Fix 裏取り」 準拠)

**H5 (webhook secret env-aware)** と **#11c (deletion-status nonce/signed token)** は CLAUDE.md「重要 fix」 (決済・認証・削除・外部副作用) に該当。 commit 経路は次のとおり:

1. **実装 / review は他 item と並走で前出し可** (env 系で論理的に早い H5 を後ろまで止める必要はない)、 ただし **commit は本 sub-plan A 末尾に集約** (= 他 8 item 完了後)。 これにより無 tag commit が tree 中段に滞留せず、 Stop hook (`check-review.sh`) の feat/fix tag 検査で **block 発火を回避**できる (= §2.3 修正の主目的)。
2. 末尾で H5 / #11c を順次 commit (`[reviewed]` も `[no-review]` も付与しない暫定 commit)。
3. OT 実機確認: H5 は stg で Stripe / Clerk webhook 配信を実際に通す。 #11c は stg で deletion-status URL が token 付きで生成され、 token 不正で 401/404 を返すことを実走確認。
4. OT 承認後、 **未 push の状態で `git commit --amend`** により commit message に `[reviewed]` を追記して確定。 H5 / #11c がそれぞれ 1 commit のため amend は順次。
5. 上記 3-4 が完了するまで本 sub-plan A の **stop checkpoint** = OT 承認待ち。

push 経路は Y-1 と同じく OT 専権 (CC は push 経路を持たない)。

**実装 / review 前出しの運用**: H5 を env 系 (前半) で実装着手する場合、 review pass まで進めて branch / 作業領域に保留 (stage / patch / 別 branch のいずれか CC が選択)、 commit のみ末尾に寄せる。 H5 と並行で他 item を commit する際、 H5 が同 file (例: `app/api/webhooks/{stripe,clerk}/route.ts`、 #10 と overlap) に触れる場合は、 H5 を後ろにずらして file 衝突を回避するか、 stage 領域を別管理 (patch file 経由) する。 spec sub-plan A 起こし時に CC が運用判断 (前出し vs 末尾実装) を提案 → OT 確認。

### 2.3 ordering 推奨 (Sub-plan A 内)

**commit 順序 = 実装順序** (Stop hook block 回避のため commit は末尾集約):

H1 / #5 / #6 / #13 / H4 → #10 → #15 → **H5 (無 tag commit)** → **#11c (無 tag commit)** → OT stg 実機確認 → amend で `[reviewed]` 追記 (H5 → #11c 順)

**7 通常 item (H1 / H4 / #5 / #6 / #10 / #13 / #15)**: review pass で `[reviewed]` 即付与の通常経路。 env 系 (#5 / #6 / #13) を先頭、 H1 / H4 (API behavior) → #10 (clerk webhook payload zod) → #15 (rate limit) の順。 #9 (pull response zod) は §10.1 follow-up で Phase 4 既定と確認、 Y-2 から除外。

**2 重要 fix (H5 / #11c)**: 末尾集約 commit、 §2.2 経路で OT 実機確認後 amend。 **H5 を環境系の論理位置 (前半) で実装 / review することは可だが、 commit は必ず末尾に寄せる** (Stop hook block 回避、 §2.2 「実装 / review 前出し」 運用参照)。

---

## 3. Sub-plan B — performance (8 item effective)

### 3.1 一覧

| ID | 内容 | 設計骨子 |
|---|---|---|
| #1a (§10.3 (b) #1 of 5) | review-events/bulk study_days SQL N+1 解消 | 1 SQL に集約 (UPSERT or COALESCE 集合)、 session 終了時の `update study_days` を per-card → per-session 1 文に圧縮 |
| **#1b** (§10.3 (b) #1 of 5) | entity-mutations/bulk per-mutation tx 逐次 → **順序保証付き選択並列化** | **Y-2 最大リスク項目。 §3.2 順序保証契約参照。** 単純並列化禁止。 |
| #1c (§10.3 (b) #1 of 5) | exam-list-live 全 cards → necessary subset | Dexie query を試験ごとに絞り込み (例: count + 最近 N 件のみ load) |
| #1d (§10.3 (b) #1 of 5) | inline-card-list 全 card_tags → join shape 改善 | `card_id IN (current page)` に絞る + memoize、 全 card_tags scan を回避 |
| #1e (§10.3 (b) #1 of 5) | dashboard-actions 全 cards → `[user_id+due]` index 使用 | 既存 `[user_id+due]` compound index を query で利用、 dashboard count 高速化 |
| #2 (§10.3 (b) #2) | get-dexie-session-cards 全 cards | session 開始時の全 fetch を `[user_id+due]` index 利用に集約 (#1e と同 hit) |
| #7 (§10.3 (b) #7) | OCR backoff worst-case ~660s への service-wide concurrency limit | semaphore (max N concurrent OCR) を `lib/ocr/*` に導入、 quota 突破時 queue。 N の暫定値は spec 起こし時に Gemini RPM + ペイロードサイズから算出 (現状候補 N=2 or 3) |
| **H7** (軽微 2、 調査先行) | /app/tags 初期遅延の切り分け | Lighthouse + DevTools MCP で計測 (FCP/LCP/TBT)、 (a) `tags/page.tsx` async RSC server roundtrip / (b) Dexie 初回 fetch / (c) SSR rendering の 3 要因を分離 → 結果次第 (perf 同根なら #1 群に併合 / 軽ければ Y-2 内 fix / 重ければ Y-3 提案) |

### 3.2 #1b 順序保証契約 (Y-2 最大リスク項目)

per-mutation tx の **逐次** await は意図設計の可能性が高い。 audit §3 「retry controller 整合」 と outbox 再送収束性を壊さないため、 並列化は **同一 entity key 内は順序維持、 独立 key 間のみ並列**の選択並列化に限定する。

**entity key の定義**: `(entity_type, entity_id)` の組。 同一 key の mutation は順序維持 (例: `update_field name='A'` → `update_field name='B'` の順を保証)、 異なる key の mutation のみ並列化可能。

**実装方針 (概略)**:
1. bulk endpoint 受領時に mutations を `(entity_type, entity_id)` で grouping。
2. 各 group 内は順序維持 (現状の逐次 await を維持)。
3. group 間は `Promise.allSettled` で並列実行。
4. 結果集約は mutation_id 順に正規化 (response shape 不変)。

**順序保証の検証**:
- 単体 test: 同一 entity key への 3 連続 update_field が逐次適用される (DB の最終値 = 3 番目の patch)。
- 並列 test: 独立 entity key の create × N (e.g. N=10) が `Promise.allSettled` で並列適用される (実行時間が逐次 vs 並列で差を計測)。
- 順序破壊 regression test: 同一 key を意図的に並列実行する path を assert で `throw new Error('ordering violated')` させ、 設計違反が test で必ず捕捉される構造を作る。

**stop checkpoint**: #1b の実装着手前に「entity key grouping の境界」 (cascade delete + dependent multi-mutation の扱い、 Grid-2 で対応する範疇の特定) を spec sub-plan B で 1 段落明記、 OT 判断で着手可否を仰ぐ。

### 3.3 ordering 推奨 (Sub-plan B 内)

**H7 (切り分け調査)** を先発 → 結果次第で残り 7 item の ordering を再決定。 H7 で 「perf 同根 (Dexie 初回 fetch がボトルネック)」 と判定されれば #1c / #1d / #1e / #2 と併合。 SQL/Dexie 系 (#1a / #1b / #1c / #1d / #1e / #2) は計測 → fix → 計測比較で session log に before/after の query plan + row count を貼付。 #7 (OCR concurrency) は独立、 並走可。

---

## 4. Sub-plan C — config / header / cleanup / docs (6 item)

### 4.1 一覧

| ID | 内容 | 設計骨子 |
|---|---|---|
| H2 (§10.3 (b) #4) | outbox cap 24h → 30d **延長** | entity-mutation-flush-trigger の自動 failed 隔離 timeout を 24h → 30d に **延長**。 **隔離機構は維持** (30d 超は将来 ops 通知の打鍵点として温存)。 client mirror に長期 pending が滞留する UX 影響は 30d 設計で実質無視可。 commit message に「隔離撤去ではない」 を 1 行明記 |
| H3 (§10.3 (b) #12) | session.card_ids max 2000 + selected_answer_ids max 50 (**2段確定**) | **段 1** (本 sprint で確定): zod schema に max 制約のみ追加。 **段 2** (本 sprint 内発火): CC が SELECT 文を spec 承認直後に先出し (§10.1 参照)、 OT が Supabase dashboard で実行 → 結果受領 → CC が item format (UUID / 順序 / 重複可否) を schema 化。 OT 実行待ちをクリティカルパスから外すため SELECT 先出し |
| **H6** (軽微 1) | prod console info level → warn 以上に絞る | `lib/logger.ts` に `LOG_LEVEL` env (default = info、 production = warn) を追加、 `emit()` 内で level filter。 flush.kick info log の prod 抑止 = sprint 完了条件 |
| **#8** (§10.3 (b) #8) | content_version 用途決定 (採用 / 廃止) | 現状 schema / drizzle / Dexie 内の `content_version` 利用箇所を grep 整理 → (a) 廃止 / (b) versioning gate として実装、 を **OT 判断 stop**。 採用なら本 sprint 内 fix、 廃止なら本 sprint 内 remove |
| **Perm** (audit 外、 OT 追加) | Permissions-Policy header | **directive list 確定前に Stripe Checkout (redirect vs embedded) と Clerk の実要件を公式 docs で裏取り** (§10.2 参照)。 記憶ベースで deny list を固定しない。 `next.config.js` headers() で directive 設定 |
| #10d (§10.4 #10 格上げ) | webhook runbook 整備 | Stripe / Clerk webhook の「stuck 検知 → 手動 retry 経路」 docs を `docs/ops/webhook-runbook.md` (新設) に集約。 dashboard URL + 定期 job 案 (cron 候補) も含む |

### 4.2 ordering 推奨 (Sub-plan C 内)

H6 / Perm 単独完結 → H2 軽量変更 (30d 延長 + comment 1 行) → H3 段 1 (zod max のみ) → #10d docs → **#8 OT 判断 stop** → H3 段 2 (OT SELECT 結果待ち → format 確定) の順。 #8 OT stop で C 全体を止めないよう、 #8 を後ろから 2 番目に配置 (#8 stop 中も H3 段 2 が並走可)。

---

## 5. test / verification 戦略

### 5.1 unit (vitest)
- H1: transient classifier (5xx / lock timeout の判定)
- H3: zod schema max 制約 (段 1) + item format schema (段 2)
- H5: production-fail-fast guard
- H6: `LOG_LEVEL` level filter
- #1b: 順序保証 + 選択並列化 (§3.2 参照)
- #9 / #10: zod safeParse (Phase 4 重複検証は §10.1)
- #11c: HMAC token 検証 + ttl
- #15: rate limit token bucket

### 5.2 integration
- H1: bulk 2 route の transient simulate (DB lock timeout mock) → 503 + Retry-After 検証
- H4: OPS webhook unreachable simulate → `logger.error` fallback 発火検証
- Sub-plan B: before/after の **実 query plan + 実 row count** を session log に貼付

### 5.3 stg smoke (Y-1 同様 DevTools MCP / Playwright fallback)
- H6 prod log filter / Perm header response 確認 / #15 contact rate limit / H7 `/app/tags` Lighthouse 比較
- **重要 fix (H5 / #11c)**: stg で実 webhook 配信 + token 不正 401/404 を OT 実機確認 (CC 環境で webhook 届かない)

### 5.4 whole-repo gate
- 各 sub-plan PR 末尾で `pnpm lint --max-warnings=0` + `pnpm typecheck` + `pnpm build` exit 0
- sprint 最終で `pnpm test` whole-repo + spec §9 audit 突合 (Y-2 編入 24 item 取り残し 0)

---

## 6. 完了条件 (sprint 全体)

1. audit §10.3 (b) P1 中心 + 軽微 2 件 + Permissions-Policy + §10.4 #10 / #11 = 24 item すべて本 spec sub-plan 経由 (§9 audit 突合対照表で 1:1 マッピング確認、 取り残し 0)
2. 重要 fix (H5 / #11c) は OT 実機確認後 [reviewed] amend 完了
3. #1b 順序保証 contract が test で gate 化済 (§3.2 検証 3 種すべて pass)
4. CLAUDE.md sprint 完了 gate: whole-repo `pnpm lint --max-warnings=0` exit 0、 `pnpm typecheck` exit 0、 `pnpm build` exit 0 (Sub-plan A / B / C 全 sub-plan PR でそれぞれ確認)
5. 各 PR で `superpowers:requesting-code-review` Critical 0、 [reviewed] tag (H5 / #11c は amend 経由)

---

## 7. リスクと緩和

1. **#1b 順序保証 (Y-2 最大リスク)**: §3.2 の選択並列化 + 順序破壊 regression test で 3 重防御。 stop checkpoint で OT 判断後着手。 仮に test で順序破壊が検出された場合は即時逐次運用に戻す (revert は 1 commit で可能、 patch 範囲限定設計)。
2. **#9 Phase 4 重複**: spec 起こし直後に grep 検証 (§10.1)、 重複なら本 sprint 除外 + OT に指摘。
3. **H3 段 2 SELECT timing**: CC が SELECT 文を spec 承認直後に先出し (§10.1)、 OT 実行 latency を sprint クリティカルパスから外す。
4. **#8 content_version 用途決定**: CC が利用箇所 grep 整理 (1 page) → OT 判断 stop。 廃止判定なら本 sprint 内 remove、 採用判定なら本 sprint 内 fix。 判断遅延時は本項目のみ Y-3 へ繰越 (本 sprint 続行可能)。
5. **Permissions-Policy directive list**: §10.2 で Stripe Checkout (redirect vs embedded) + Clerk 実要件の **公式 docs 裏取り** task を spec に含める。 記憶ベース固定禁止。
6. **OCR concurrency 上限 N**: Gemini 2.5 Flash の RPM (free tier) + ペイロード平均サイズから算出。 暫定候補 N=2 or 3、 実装中に微調整。 N 調整は test に含めない (運用 tuning 範疇)。
7. **H7 切り分け先行結果**: 結果次第で sub-plan B / Y-2 内 / Y-3 のいずれにも振れる。 sub-plan B 内に「H7 結果次第で内訳変動」 を明記。

---

## 8. 重要 fix 規律 (CLAUDE.md 「重要 Fix 裏取り」)

**対象 (本 sprint 内 2 件)**:
- **H5** (webhook secret env-aware): 認証系 (Stripe / Clerk webhook signature 検証 secret)
- **#11c** (deletion-status nonce/signed token): 削除 + 認証系 (user deletion status URL の signed token)

**経路** (§2.2 と同):
1. review pass → commit (tag 無し)
2. stg で OT 実機確認 (実 webhook 配信 / token URL 不正 401/404)
3. OT 承認後、 未 push の状態で `git commit --amend` で `[reviewed]` 追記
4. push は OT 専権

**他 22 item は通常 fix 経路**: review pass で `[reviewed]` 即付与。

---

## 9. audit 突合対照表 (= 取り残し 0 証明)

| audit ref | 出典 | Y-2 task | 解消手段 |
|---|---|---|---|
| #1 review-events/bulk study_days SQL N+1 | §10.3 (b) #1 (5件) | Sub-plan B #1a | SQL 1 文集約 |
| #2 entity-mutations/bulk per-mutation tx 逐次 | §10.3 (b) #1 (5件) | Sub-plan B #1b | 順序保証付き選択並列化 |
| #3 exam-list-live 全 cards | §10.3 (b) #1 (5件) | Sub-plan B #1c | 試験ごと subset |
| #4 inline-card-list 全 card_tags | §10.3 (b) #1 (5件) | Sub-plan B #1d | card_id IN page |
| #5 dashboard-actions 全 cards + index | §10.3 (b) #1 (5件) | Sub-plan B #1e | `[user_id+due]` 利用 |
| #6 get-dexie-session-cards 全 cards | §10.3 (b) #2 | Sub-plan B #2 | `[user_id+due]` 利用 |
| #7 OCR backoff worst-case ~660s | §10.3 (b) #7 | Sub-plan B #7 | semaphore concurrency limit |
| #8 entity-mutation-flush-trigger 24h 自動 failed 隔離 | §10.3 (b) #4 | Sub-plan C H2 | 30d 延長 (隔離維持) |
| #9 OCR_DEBUG_LOG / BULK_FULL_PARAMS_LOG production gate | §10.3 (b) #5 | Sub-plan A #5 | env + lib gate 二重化 |
| #10 GEMINI_DAILY_LIMIT production fail-fast | §10.3 (b) #6 | Sub-plan A #6 | startup throw |
| #11 OCR concurrency limit | §10.3 (b) #7 | (#7 と同) | (上記参照) |
| #12 content_version 用途決定 | §10.3 (b) #8 | Sub-plan C #8 | OT 判断 stop |
| ~~#13 pull.ts レスポンス zod~~ | ~~§10.3 (b) #9~~ | **本 sprint 除外** | §10.1 follow-up = Y-1 spec で Phase 4 既定確認 |
| #14 webhook clerk payload zod | §10.3 (b) #10 | Sub-plan A #10 | safeParse + drift 耐性 |
| #15 review-events/entity-mutations bulk transient/permanent 区別 | §10.3 (b) #11 | Sub-plan A H1 | 503 + Retry-After |
| #16 session.card_ids / selected_answer_ids bound | §10.3 (b) #12 | Sub-plan C H3 | zod max + 2段 format |
| #17 proxy.ts webhook bypass | §10.3 (b) #13 | Sub-plan A #13 | matcher 除外 |
| #18 OPS_DISCORD_WEBHOOK_URL production fail-fast | §10.3 (b) #14 | Sub-plan A H4 | startup + error sink |
| #19 contact rate limit | §10.3 (b) #15 | Sub-plan A #15 | IP / userId token bucket |
| #20 webhook secret env-aware | §10.3 (b) #17 | Sub-plan A H5 (**重要 fix**) | env-tier 判定 + startup |
| #21 prod info level log noise | 軽微 1 (OT 報告) | Sub-plan C H6 | `LOG_LEVEL` env |
| #22 /app/tags 初期遅延 | 軽微 2 (OT 報告) | Sub-plan B H7 | 調査先行 |
| #23 Permissions-Policy header | (audit 外、 OT 追加) | Sub-plan C Perm | 公式 docs 裏取り後 directive 設定 |
| #24 webhook runbook | §10.4 #10 (格上げ) | Sub-plan C #10d | docs 新設 |
| #25 deletion-status nonce/signed token | §10.4 #11 (格上げ) | Sub-plan A #11c (**重要 fix**) | HMAC + ttl |

**取り残し 0 確認**:
- audit §10.3 (b) #1-#15, #17 のうち **#3 (anyOf 2件、 Grid-1 合流) + #9 (Y-1 で Phase 4 既定確認、 §10.1) を除く 14 件** すべて本 spec の sub-plan に 1:1 マッピング (#16 / #19 / #20 = Y-3 繰越、 #18 = Grid-2 で対象外、 §1.3 参照)
- audit §10.4 #10 / #11 = 2 件 (Y-2 格上げ) すべて本 spec の sub-plan に 1:1 マッピング
- 軽微 2 件 + Permissions-Policy = 3 件 (audit 外含む) すべて本 spec の sub-plan に 1:1 マッピング
- 計 19 audit-mapped (= 14 + 2 + #1 内訳 5 件で重複なし) + 3 OT-added + H6 / H7 (軽微 2 件) = 23 item、 Grid-1 合流分 (#3 anyOf 2件) + Phase 4 既定 (#9) を除いた数と一致
- → **Y-2 sprint 範囲で取り残し 0** (#9 は Phase 4 で消化される前提)

---

## 10. immediate follow-up (spec 承認直後に CC が先出し)

OT 実行 / 判断待ちをクリティカルパスから外すための前出し task:

### 10.1 #9 Phase 4 重複検証 — **完了 (重複あり、 Y-2 除外確定)**

実施日: 2026-06-12 (spec OT review 直後)。

**grep 結果**:
- `docs/superpowers/specs/2026-06-12-sync-fix-1-expanded-design.md:34` (Y-1 spec §1.3 スコープ外表): `pull response zod 化 (lib/sync/pull.ts:100) | Phase 4 | Step 0 §3.5 C-3`
- 同 file L343: 「`pull response zod 化 (Phase 4) は本 spec のスコープ外として §1.3 で明示済`」

→ **Y-1 spec で #9 を明確に Phase 4 scope に仕分け済**。 audit §10.3 (b) #9 が Y-2 (launch hardening) に列挙されているのは todo v19 → audit drift。

**spec 反映**:
- §1.2 Sub-plan A の item 数: 10 → 9 (#9 削除)
- §2.1 / §2.3 / §9 の #9 関連行を取り消し線 + 「Phase 4 既定」 注記
- 全体 item 数: 24 → 23

**OT 文面案** (todo v19 修正用):
> #9 「pull.ts レスポンス zod parse 化」 は Y-1 spec (`docs/superpowers/specs/2026-06-12-sync-fix-1-expanded-design.md`) §1.3 で **Phase 4 scope と明示済** (L34, L343)。 audit §10.3 (b) #9 の Y-2 列挙は drift と判断、 Y-2 spec から除外。 todo v19 「Y-2 H series」 列から削除推奨。 Phase 4 sprint で `pullResponseSchema.safeParse` + Y-1 mutation-schemas.ts と同 server-only 不付 pattern で消化予定 (Y-1 T5 precedent 利用可)。

### 10.2 Permissions-Policy 公式 docs 裏取り — **完了 (現状 stack 必要 directive なし、 stg gate 運用)**

実施日: 2026-06-12 (spec OT review 直後)。

**Stripe 確認**:
- 公式 docs (`docs.stripe.com/security/guide`、 WebFetch + WebSearch): Permissions-Policy 直接記載なし (CSP の `connect-src` / `frame-src` / `script-src` のみ言及)。
- **RecallMint 実 integration mode 確認 (`app/(app)/app/upgrade/actions.ts:50-69`)**: `stripe.checkout.sessions.create({...})` で session 作成 → `redirect(session.url)` で Stripe domain (checkout.stripe.com) に遷移 = **hosted (redirect) mode**。 `ui_mode: 'embedded'` 指定なし。
- → merchant domain 上で Payment Request API が走らない、 `payment=()` deny で安全候補。

**Clerk 確認**:
- 公式 docs (`clerk.com/docs/security/headers`、 WebFetch 404 / WebSearch): Permissions-Policy 直接記載なし。 passkey/WebAuthn 経路を採用する場合は `publickey-credentials-get=self` + `publickey-credentials-create=self` が必要 (MDN 経由確定)。
- **RecallMint 実 usage 確認 (`grep -rn passkey|webauthn|publickey-credentials app/ lib/`)**: **0 件** = passkey 経路未採用。
- → `publickey-credentials-get=()` / `publickey-credentials-create=()` deny で安全候補。 将来 passkey 導入時に `self` 緩和、 spec sub-plan C 完了条件に「将来 passkey 導入時の更新手順」 を 1 行明記する。

**現状の安全 default candidate** (記憶ベース固定禁止の OT 規律遵守、 stg gate で確定):

```
Permissions-Policy:
  accelerometer=(),
  ambient-light-sensor=(),
  autoplay=(),
  battery=(),
  camera=(),
  display-capture=(),
  document-domain=(),
  encrypted-media=(),
  fullscreen=(self),
  geolocation=(),
  gyroscope=(),
  magnetometer=(),
  microphone=(),
  midi=(),
  payment=(),
  picture-in-picture=(),
  publickey-credentials-create=(),
  publickey-credentials-get=(),
  screen-wake-lock=(),
  sync-xhr=(),
  usb=(),
  web-share=(),
  xr-spatial-tracking=()
```

**stg gate 確定運用 (Sub-plan C 実装時)**:
1. spec sub-plan C Perm 項に上記 default を実装案として明記。
2. `next.config.js` headers() で directive 設定 → stg deploy。
3. CC が DevTools MCP / Playwright で stg を実走: (a) `/app/upgrade` → Stripe Checkout redirect → 戻り、 (b) Clerk sign-in / sign-up flow、 (c) `/app` 全主要 page を巡回。
4. console / Network response header / browser security warnings に Permissions-Policy violation 出力 0 件を確認。 1 件でも検出されたら spec sub-plan C にて該当 directive を `self` 緩和、 再 stg gate。
5. 確定後 prod 反映。

**spec 反映**: Sub-plan C Perm 項 (§4.1 ) は「stg gate で directive 確定」 と既に明示済、 本 follow-up 結果の **default candidate + Stripe redirect mode 確認 + Clerk passkey 未使用** をここに 永続記録、 sub-plan C 実装時に参照可。

### 10.3 H3 段 2 SELECT 文先出し

**schema 型確認済 (2026-06-12)**: `lib/db/schema.ts` で `card_ids` / `selected_answer_ids` を grep、 両列とも **`jsonb` 型** (TS 側 `$type<string[]>()` で narrow、 DB 上は jsonb array of UUID strings)。 → PostgreSQL `jsonb_array_length()` が正、 `cardinality()` (native array 用) 差替不要。

- CC が以下 SQL 文を提示 (OT が Supabase dashboard で実行):

```sql
-- session.card_ids 実値分布
SELECT
  COUNT(*) AS session_count,
  MAX(jsonb_array_length(card_ids)) AS max_len,
  AVG(jsonb_array_length(card_ids))::numeric(10,2) AS avg_len,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY jsonb_array_length(card_ids)) AS p99_len
FROM review_sessions;

-- selected_answer_ids 実値分布 (review_events 内)
SELECT
  COUNT(*) AS event_count,
  MAX(jsonb_array_length(selected_answer_ids)) AS max_len,
  AVG(jsonb_array_length(selected_answer_ids))::numeric(10,2) AS avg_len,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY jsonb_array_length(selected_answer_ids)) AS p99_len
FROM review_events
WHERE selected_answer_ids IS NOT NULL;

-- item format 確認用 (上位 5 サンプル)
SELECT id, jsonb_array_length(card_ids) AS len, card_ids
FROM review_sessions
ORDER BY jsonb_array_length(card_ids) DESC
LIMIT 5;

SELECT id, selected_answer_ids
FROM review_events
WHERE selected_answer_ids IS NOT NULL
ORDER BY jsonb_array_length(selected_answer_ids) DESC
LIMIT 5;
```

- SELECT 文の正本は **本 spec の §10.3 (= 本セクション)** に固定。 実行結果を OT が CC に貼付 → CC が item format (UUID 形式 / 順序保持 / 重複可否) を schema 化 → Sub-plan C H3 段 2 として実装。
- Sub-plan A と並走可能、 段 2 実装は OT 結果受領後に発火。

---

## 11. 監査メタ情報

- 起源: `docs/audit/2026-06-12-repo-wide-audit.md` §10.3 (b) + §10.4 #10-#11 (格上げ) + 軽微 2 件 (OT 報告 2026-06-12) + Permissions-Policy (OT 追加、 audit 外)
- 前段: Y-1 完了 (`docs/superpowers/specs/2026-06-12-sync-fix-1-expanded-design.md` 経由で sync-fix 系打ち切り済、 prod 反映完了 0866728)
- 採用判断: 3 sub-plan 分割 = OT 承認 (brainstorming step 5 論点 6)、 #1b 順序保証 contract = OT 修正 2 反映、 H2 隔離維持 = OT 修正 3 反映、 Permissions-Policy 裏取り = OT 修正 4 反映、 H3 SELECT 先出し = OT 修正 5 反映、 重要 fix 規律 (H5 / #11c) = OT 修正 1 反映
- 修正適用: brainstorming step 5 で OT 5 修正 (重要 fix 明記 / #1b 順序保証 / H2 隔離維持 / Perm 裏取り / H3 SELECT 先出し) を本 spec に反映済
