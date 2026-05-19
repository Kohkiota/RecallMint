# Sprint roadmap review (2026-05-19)

> claude.ai 仮置き roadmap (S1〜S9 + β γ) を repo 実体と照合した結果。
> 状態整合は `docs/superpowers/sessions/2026-05-19-state-reconciliation.md`
> + Addendum (commit `e97f4b2`) を前提として読む。
> 実装はしない、 review と報告のみ。

---

## Executive summary

- **roadmap の方向性は妥当**。 β (手動 tag) / γ (学習画面 UI 2 + 内部 1) の決定は実装観点でも違和感なし
- **最大の懸念**: S1 着手前に **「exam 作成 UI」 と「OCR 起動の入口 URL」 が roadmap に明示されていない**。 schema 上 `cards.exam_id` は NOT NULL FK、 OCR の入口は exam を選んで起動する想定 (Tech Spec §3) のため、 「S1 で OCR を作るが exam が無い」 状態が発生する
- **S9 内に隠れ Critical 1 件**: `public/sitemap.xml` + `public/robots.txt` が **旧 plan00 ドメイン `vocab.nekotest.net` を hardcode** している (recallmint.nekotest.net ではない)。 launch 直前に必ず差し替え必要
- **MVP scope 抜け候補 (筋として議論すべき) 7 件**: onboarding flow / 利用規約同意 / Sentry 等 error tracking / OG metadata / Stripe invoice.payment_failed / browser-image-compression 依存追加承認 / Vercel Analytics or similar
- **S5 Stripe 配線は S1 OCR より前に倒すのが安全**。 S1 が月次 OCR ページ上限を実装する以上、 「上限値の出力経路 + 課金プラン取得」 が S1 内に巻き込まれて scope ふくらみ

---

## 1. 現状 repo との整合性チェック

### S1 OCR sprint

**touch 予定 path の現状**:

| path | 状態 | 備考 |
|---|---|---|
| `lib/ai/` | **不在** | discover mode PoC は commit `0a5ec0d` で全削除済。 git history から prompt / schema を復元する想定だが、 該当 dir は新規作成 |
| `lib/gemini.ts` | **存在 (dead code、 M2)** | vocab example generator のまま。 S1 で全面書換 or 削除 + 新規 `lib/ai/gemini.ts` 作成の判断要 |
| `app/(app)/app/upload/` 系 | **不在** | OCR 起動 page (`/app/upload` or `/app/exams/[id]/upload`) は未確定 |
| `components/upload/` | **不在** | `UploadDropzone.tsx` / `OCRProgress.tsx` (Tech Spec §4 で言及) は未作成 |
| `cards` INSERT 経路 | **不在** | grep で `cards` への INSERT を行う code path 0 件 (dashboard が SELECT するだけ) |
| `source_documents` 操作 | **不在** | schema 定義のみ、 INSERT/UPDATE 経路 0 件 |
| `browser-image-compression` | **package.json に不在** | CLAUDE.md「上記以外のライブラリ導入時は事前相談」 に該当、 S1 着手前に OT 承認必要 |

**衝突 / 重複 / dead code との関係**:

- `@google/genai` v1.50.1 は既に dependency にあり (新 SDK、 `responseJsonSchema` 対応)、 discover mode と整合
- `lib/gemini.ts` は完全に dead code (import 0 件)。 S1 着手時に削除 → 新規作成 or 全文置換のどちらでも OK だが、 「上書き」 だと git blame で混在するため削除 + 新規が望ましい
- `lib/validation/word.ts` (M1) は S1 と無関係 (vocab CRUD 専用)、 OCR sprint 直前に消すべき (dead code 残置は OCR の入力 validation 設計時に混乱を招く)
- schema 整合: schema.ts:236-299 cards に必要列は揃う (state / due / stability / difficulty 等)、 source_documents も完備、 **S1 で schema 変更不要は妥当**

**部分実装の有無**: なし。 S1 は green field。

---

### S2 問題管理 sprint

**touch 予定 path の現状**:

| path | 状態 |
|---|---|
| `/app/exams` / `/app/exams/[id]` / `/app/cards/[id]` route | **不在** (`app/(app)/app/` 配下に dashboard / quiz placeholder / settings / upgrade のみ) |
| exam CRUD server action | **不在** (`createExam` / `updateExam` / `archiveExam` 全て未実装) |
| card CRUD server action | **不在** |
| `archived_at` 利用経路 | **不在** (column のみ schema に存在、 使用 code 0 件) |

**懸念**: roadmap で **「exam を作る」 機能の sprint が明示されていない**。 S1 OCR は `examId` を受け取って cards を作るが、 exam 作成 UI が S2 まで存在しないと S1 単独で動作不能。 「S1 内に最低限の exam 作成 UI を含める」 か、 **S1 前に「exam 作成 mini-sprint」 を挟む** 判断が必要。

---

### S3 メタデータ管理 sprint

**現状**:

- `cards.tags text[]` 列は schema.ts に **不在**。 migration が必要 (drizzle/migrations/0003_*.sql 新規)
- `cards.custom_props` は jsonb で freeform、 GIN index (`cards_props_gin_idx`) も schema.ts:295 に既に存在 — フィルタクエリは index 活用可能
- bulk edit / フィルタ UI 系の component は皆無

**衝突可能性**:

- S1 が cards に INSERT する時点で tags は未存在のため、 S1 の INSERT 文に tags 列が無くても問題ない (default NULL or [] になる)
- ただし **S3 で `tags text[] NOT NULL DEFAULT '{}'::text[]` の migration を打つ場合、 既存 cards 行は default で埋まる**ため backfill 不要、 S1 後に S3 を入れても data 整合は崩れない
- 一方 S3 を S1 より先に入れる選択もあり (詳細は §3 順序問題)

---

### S4 学習画面 sprint

**現状**:

- `/study/smart` / `/study/practice` route: **不在**
- `/app/quiz/page.tsx` が placeholder (Phase 2 で実装予定、 dashboard 「スマート復習」 / 「問題演習」 link 先)
- `app/(app)/app/_actions/revalidate.ts:11-14` の `AppPath` 型は `/app | /app/settings | /app/quiz` の 3 値のみ。 S4 で `/app/study/smart` / `/app/study/practice` を追加する場合、 この型と app-header / dashboard-actions の link 先も更新必要
- `lib/fsrs.ts` (31 行): `ts-fsrs` 5.3.2 wrapper、 `RatingInt` (1=Again / 2=Hard / 3=Good / 4=Easy) → `Rating` enum mapping 完備。 **そのまま流用可**
- `lib/db/streak.ts`: dashboard が既に呼んでいる `getReviewStatsForUser()` が cards 用に書換済 (commit `fa4dcd9`)、 `COUNT(DISTINCT card_id)` で todayCardCount を返す — S4 で reviews INSERT した直後に dashboard に正しく反映される

**衝突可能性**:

- `/app/quiz` placeholder の URL を `/app/study/practice` 等に振り直すか、 quiz placeholder を残して別 URL にするか OT 判断要 (Tech Spec §3 は `/study/smart` / `/study/practice` で、 `/app` prefix を取る形に書いてあるが、 実 repo は `/app` 配下に閉じ込めている。 整合性のため `/app/study/{smart,practice}` を推奨)

---

### S5 Stripe プラン分岐配線

**現状**:

- Stripe webhook (`app/api/webhooks/stripe/route.ts` 267 行): **完成済**。 `checkout.session.completed` / `customer.subscription.{created,updated,deleted}` の 4 event を完全配線、 `resolvePlanFromSub` + `extractSubFields` で `(plan, billingInterval)` 解決 + 不明 price_id fallback まで含む
- `lib/auth/plan-limits.ts` (20 行): mcq 用書換済 (`free=30 / standard=300 / pro=null` の `ocrPagesPerMonth`)
- **「上限の発動 (enforce)」 を行う callsite が現在 0 件**。 `limitsFor(plan).ocrPagesPerMonth` を読む code は schema test 以外存在しない
- `app/(app)/app/upgrade/actions.ts`: Stripe Checkout 起動済 (Standard月年 + Pro月年 4 cell)、 動作確認は staging で完了 (per 2026-05-17 handoff)

**衝突**: S5 が「上限発動」 だけなら S1 OCR の Server Action 内に `if (currentMonthlyPages + newPages > limit) throw` を挟むだけ。 ただし **S1 が「Server Action 経由 Gemini OCR」 をやる以上、 S1 内で上限チェックを実装しないと不正な OCR が走る** 可能性あり。 順序入替の議論は §3 で。

---

### S6 ダッシュボード mcq 化

**現状**:

- `app/(app)/app/page.tsx` (57 行) は既に mcq 用:
  - `cards` table から `due <= now` を count → dueCount 表示
  - `getReviewStatsForUser(user.id)` で todayCardCount + streak 取得
  - 表示文言「今日の学習問題数」 / 「連続日数」 (vocab 文言「単語」 は無し、 既に書換済)
- **S6 の追加 scope は実質「試験数 / 月次 OCR ページ消費」 の 2 メトリクスを足すだけ**。 「ダッシュボード mcq 化」 という表現は誤解を招く (既に大半 mcq)
- 月次 OCR ページ消費は `source_documents.pages_processed` の `SUM` + JST 月境界、 もしくは `ai_usage_users` の SUM 経由が候補。 どちらを source of truth にするか S5 / S1 で固める必要あり

---

### S7 設定 / アカウント管理

**現状 (ほぼ完成済)**:

- `app/(app)/app/settings/page.tsx`: プラン表示 + 「お支払い・解約を管理」 / 「アップグレード」 + アカウント削除 button + 法的情報リンク、 全部実装済
- `app/(app)/app/settings/delete-button.tsx` (174 行): Clerk client SDK self-delete + polling pattern 完成、 plan00 で確立した webhook-driven 削除フロー流用済
- `app/api/me/deletion-status/route.ts`: polling endpoint 存在
- `app/api/webhooks/clerk/route.ts` (237 行): `user.deleted` で Stripe subscriptions auto-pagination cancel + `deletion_failures` audit table + notifyOps escalation 全部入り
- 削除確認文言は `app/(app)/app/settings/page.tsx:75` で「登録したカードと学習履歴」 (vocab 残骸無し)

**S7 残作業**: 実質ほぼ無い。 「mcq 化したことの最終確認」 + R2 削除経路追加 (S1 完了後)、 程度。 1-2 commit で済む。

---

### S8 法務 / マーケ仕上げ

**現状**:

- `app/(marketing)/{terms,privacy,legal}/page.tsx` 3 file、 計 464 行。 `{{COMPANY_NAME}}` / `{{EMAIL}}` 等 12 placeholder 意図的残置 (`docs/legal-placeholders.md` 整合)
- `{{SERVICE_NAME}}` 完全撤回済 (commit `597dfc4`、 grep 残置 0 件、 state reconciliation I6 で確認済)
- `app/(marketing)/page.tsx` (LP) は既に RecallMint hardcode、 vocab 残骸 0 件
- `app/(marketing)/pricing/page.tsx` + `components/pricing/pricing-table.tsx`: Standard wiring sprint で完成済
- **FAQ page**: 不在 (Tech Spec § Public Pages にも記載なし、 S8 で新規作成判断要)
- `components/marketing/marketing-header.tsx:20` で `/pricing` link 存在、 footer も Contact / Terms / Privacy / 特商法 完備

**S8 残作業**: 12 placeholder の sed 一括置換 (15 分)、 FAQ page 新規 (やるなら 1-2 file)、 LP h1 / 説明文の微調整、 程度。

---

### S9 出荷準備 — **Critical 発見**

**現状**:

| item | 状態 |
|---|---|
| `public/robots.txt` | **`vocab.nekotest.net` hardcode** (line 6: `Sitemap: https://vocab.nekotest.net/sitemap.xml`)。 旧 plan00 ドメイン、 RecallMint 本番ドメインに差し替え必要 |
| `public/sitemap.xml` | **同じく `vocab.nekotest.net` hardcode** (4 url 全部)、 さらに **`/pricing` が sitemap に欠落** (`/` / `/legal` / `/privacy` / `/terms` の 4 件のみ、 `/pricing` 追加要) |
| Vercel Deployment Protection | 2026-05-17 staging で OFF 確認済 (per env-separation handoff §6)、 production scope は要確認 |
| OG image / `openGraph` metadata | `app/layout.tsx` に `metadata.openGraph` 欠落 (title + description + manifest + icons のみ)。 `public/screenshots/` dir は存在するが OG image としての配置は未確認 |
| Smoke test | E2E は `tests/integration/` に webhook / legal page test 4 件のみ、 ユーザーフロー E2E (Playwright 等) 0 件 |

S9 は表面上「smoke test 完走 / robots.txt allow」 と書かれているが、 **robots/sitemap の domain 修正 + /pricing 追加 + OG metadata は明示すべき**。

---

## 2. 抜けている要素の指摘

MVP 出荷観点で roadmap に明示されていない要素。 各項に「MVP 必須 / post-MVP」 の判断付き。

### MVP 必須 (launch 前に必須 or 強推奨)

1. **exam 作成 UI** (Pre-S1 mini-sprint or S1 内蔵)
   - schema 整備済だが、 `createExam` server action / `/app/exams/new` UI / 試験名サジェスト (`lib/exams/presets.ts`、 Tech Spec §4) 全て不在
   - S1 で OCR 走らせる前に必ず exam を選ぶ必要がある
   - **推奨**: S1 に「最低限の exam 作成 (試験名のみ、 archived/edit は S2)」 を含める、 1 commit 程度

2. **onboarding flow** (S1 周辺 or S6)
   - 初回サインアップ後、 dashboard には「カード 0 件 / streak 0」 だけが出る現状。 「カードを作るには」 への導線が無い
   - 最低限: dashboard 空状態に「最初の試験を作成」 CTA 表示、 もしくは sign-up 直後に exam 作成 wizard を出す
   - **推奨**: S1 / S2 の余白で対応 (新規 sprint は過剰)

3. **利用規約 / プライバシーポリシー同意 flow** (S8 内)
   - 現状の sign-up flow (Clerk `<SignUp />`) には同意 checkbox 無し
   - 日本の SaaS は特商法 + 個人情報保護法的に明示同意が望ましい。 Clerk Standalone でも `appearance.layout.termsPageUrl` / `privacyPageUrl` で URL を表示する layer がある (要 Context7 確認)
   - **推奨**: S8 内で対応 (Clerk 設定だけで済むなら 30 分、 自前 checkbox なら 2-3 commit)

4. **robots.txt / sitemap.xml の RecallMint domain 化** (S9 内、 但し明示)
   - 上記 S9 Critical 発見、 1 commit で完了

5. **OG image / `openGraph` metadata** (S8 / S9)
   - SNS シェア時の見栄え、 marketing 効果に直結。 `public/screenshots/` あり → そのまま OG image に使うか、 別 OG 画像作成
   - **推奨**: S8 末尾で対応、 1 commit

6. **smoke test (E2E)** (S9 内)
   - 現状 Playwright 等 E2E 0 件。 launch 前に最低限「sign-up → exam 作成 → OCR → 学習 → 解約 → 削除」 の 1 通り通る確認をすべき
   - **推奨**: S9 で smoke flow を 1-2 シナリオだけ書く (Playwright MCP は CLAUDE.md で承認済)
   - 別案: 手動 smoke + 結果を session handoff に記録 (E2E 工数省略)

7. **`browser-image-compression` 等の新 dep 追加承認** (S1 着手前)
   - CLAUDE.md「上記以外のライブラリ導入時は事前相談」
   - S1 kickoff prompt で OT が明示承認するなら問題なし、 但し sprint plan に明示要

### post-MVP で可 (β 後でも問題なし)

8. **error tracking (Sentry / 等)**
   - 現状 `lib/ops.ts` notifyOps Discord 通知のみ (webhook handler / 削除 failure に限定)
   - 学習 session 中のクライアント側 error / OCR 失敗の詳細 trace が取れない
   - **MVP では Vercel Logs + Discord で代替可能**、 β で複数 user 増えたら Sentry 検討

9. **Vercel Analytics / GA4**
   - CV (sign-up / Pro 加入) 計測なし。 marketing 効果測定にあれば便利
   - **post-MVP** で問題なし

10. **i18n / 多言語対応**
    - 日本市場特化なら不要。 Tech Spec / CLAUDE.md にも英語化要件無し
    - **post-MVP** で問題なし

11. **email 通知系 (Stripe receipt 以外)**
    - Stripe は領収書を自動送信、 アカウント関連 mail は Clerk が送信
    - 自前 transactional mail (welcome / OCR 完了通知等) は MVP 不要
    - **post-MVP** で問題なし

12. **accessibility 監査**
    - shadcn primitive 使用、 base レベルは確保。 厳密 a11y は β 後
    - **post-MVP** で問題なし

13. **画像最適化 / CDN**
    - 現状画像は OCR 入力時のみ (R2 保存なし、 S1 で `File[]` をそのまま Gemini に投げる前提)。 学習 UI に画像が出るのは v1.x 以降
    - **post-MVP** で問題なし

14. **backup 戦略**
    - Neon が自動 7 日 backup、 R2 unused (S1 は保存しない)、 Stripe は side-of-truth
    - MVP は Neon 標準 backup で十分
    - **post-MVP** で問題なし

15. **Stripe `invoice.payment_failed` / `invoice.payment_succeeded` webhook**
    - 現在の webhook は `customer.subscription.updated` 経由で `past_due` status を受ければ「初回支払失敗 retry 期間」 を表現可能 (resolvePlanFromSub の past_due 分岐)
    - 明示の invoice event は MVP では不要、 障害復旧の観測性向上に β で検討

### grey zone (OT 判断要)

16. **`source_documents.ocr_cost_yen` の算出**
    - schema に列はあるが S1 description で「コスト計算」 言及なし
    - 月次コスト監視 (Tech Spec §7「全体コスト監視は `ai_usage` で / 月コストが想定の 2 倍超で Discord 通知」) を MVP で動かすなら、 S1 で `ocr_cost_yen` を埋める実装要
    - **OT 判断**: MVP で「コスト超過 alert」 を動かすか、 β 観測のみで先送りか

---

## 3. 依存関係 / 順序問題の指摘

### D1 (Critical). S1 の上限 enforce は **S5 を先に倒す** か **S1 内蔵** が必要

- S1 description: 「複数ファイル選択 → Server Action → Gemini OCR → cards INSERT」
- この Server Action **内部で `limitsFor(user.plan).ocrPagesPerMonth` を読まないと無料 user が無制限に OCR を叩ける**
- S5 で「上限発動」 を後から配線するのは **後付けで Critical bug を埋め込みやすい** (course correction 必要)
- **推奨順序**: S5 (上限 enforce 配線) を S1 と統合、 もしくは S5 を S1 の前に倒す (Stripe Checkout 動作確認は完了済なので S5 を 30 分 mini-sprint 化可能)

### D2 (Important). exam 作成 sprint が roadmap に無い

- §1 / §2 で複数指摘。 S1 で `examId` を受け取って cards を作るなら、 exam 作成経路が S1 前に必要
- **推奨**: S1 内に「試験名だけ入れて exam を作る form (1 page + 1 server action)」 を含める。 archived/edit は S2 で良い

### D3 (Important). S3 tags 列を S1 / S2 より先に migration する選択肢

- S3 で `cards.tags text[]` migration が入ると、 S1 / S2 の INSERT/UPDATE が tags 列を意識する必要がある (default `'{}'` で問題ないが、 type 整合のため `cards.$inferInsert` 型に tags が含まれる)
- S1 / S2 を先に書くと、 S3 でカラム追加時に既存 INSERT/UPDATE を「tags は触らない」 暗黙ルールで動かす形になる (default で OK だが意識ズレ)
- **推奨**: S3 の migration を **S1 着手と同 commit で先打ち**、 S1 / S2 の cards INSERT を最初から tags 込みで書く。 UI 側 (bulk edit) は S3 範囲のまま分ける

### D4 (Minor). S4 学習画面の URL と `/app/quiz` placeholder

- `_actions/revalidate.ts` の `AppPath` 型 + dashboard-actions / app-header の link 先が `/app/quiz` で固定
- S4 で `/app/study/smart` / `/app/study/practice` を追加するなら、 `AppPath` 型 + 3 callsite を同時更新必要
- `/app/quiz/page.tsx` placeholder は S4 完成と同時に削除 (もしくは redirect)
- **推奨**: S4 内で URL 移行を 1 commit (revalidate.ts + dashboard-actions + app-header + quiz delete) でまとめる、 plan には「URL 移行 task」 と明記

### D5 (Minor). S7 削除フローと S1 R2 連携

- S1 description「R2 連携なし、 ファイル本体は一切保存しない」 → S7 削除フロー (clerk webhook) で R2 削除する必要が無い
- 但し Tech Spec §6.4 「R2 上の画像 / 元 PDF を全削除」 は v1.x の前提
- **整合**: 現状 S7 は R2 削除 task を持たない (現状 webhook も R2 削除呼ばない)、 矛盾はない

### D6 (Minor). S6 dashboard mcq 化と各 sprint の dashboard 修正

- 仮置き決定として「S6 dashboard mcq 化を S1 と並行 (各 sprint 完了ごとに dashboard 更新)」 案あり
- 実際の S6 scope は「試験数 / 月次 OCR ページ消費」 の追加 2 メトリクスのみ (今日の学習問題数 / streak は既に動く)
- **推奨**: S6 を独立 sprint として残すよりも、 S1 完了時に「dashboard に月次 OCR ページ消費を 1 metric 追加」、 S2 完了時に「試験数 metric を 1 行追加」 と分散して、 S6 は廃止 or「dashboard 最終仕上げ + 文言調整」 1 commit に圧縮可能

---

## 4. 各 sprint の規模感

精度 ±50%。 「touch」 = 既存ファイル編集、 「new」 = 新規ファイル。

| sprint | touch | new | commit 数 | schema 変更 | 規模 |
|---|---|---|---|---|---|
| S1 OCR (+ 最小 exam 作成) | 5-8 | 20-25 | 10-15 | なし | **大型** |
| S2 問題管理 | 3-5 | 15-20 | 8-12 | なし | **中-大** |
| S3 メタデータ | 4-6 | 8-10 | 5-7 | あり (`cards.tags` 追加) | **中** |
| S4 学習画面 | 4-6 | 12-15 | 6-9 | なし | **中** |
| S5 プラン分岐 enforce | 3-5 | 1-2 | 2-4 | なし | **小** (S1 統合推奨) |
| S6 dashboard | 1-3 | 0-1 | 1-3 | なし | **極小** (分散統合推奨) |
| S7 設定 / 削除 | 1-3 | 0 | 1-2 | なし | **極小** (実質完成済) |
| S8 法務 / マーケ | 3-6 | 1-2 (FAQ) | 2-4 | なし | **小-中** |
| S9 出荷準備 | 3-5 | 1-2 (E2E) | 2-4 | なし | **小** |

合計概算: touch 27-47、 new 58-77、 commit 37-60 (mini-sprint S5/S6/S7 を S1〜S4 に統合する場合 30-45 程度に縮む)。

---

## 5. MVP として推奨する解釈 + 順序提案

### 5.1 sprint 並び順の評価

**β (手動 tag MVP 必須) / γ (UI 入口 2 + 内部 1 本化) 決定**: 実装観点で妥当

- β: schema に `cards.tags text[]` を追加するだけで GIN index + フィルタクエリが綺麗に動く。 後付けより最初から想定した方が良い (D3 で先打ち推奨)
- γ: `lib/fsrs.ts` + 共通絞り込みクエリ + 出題エンジンを 1 set で作り、 UI 入口 2 で toggle 切替は実装も保守も合理的。 dashboard `dashboard-actions.tsx` も 2 link を持つ pattern と整合

### 5.2 入れ替え / 統合 / 分割の推奨

| 変更案 | 推奨 | 理由 |
|---|---|---|
| **S5 を S1 と統合** | **強推奨** | OCR Server Action 内で plan-limits 発動は同時に書くのが Critical 防止 (D1) |
| **S6 を S1〜S2〜S4 に分散統合 → S6 廃止 or 仕上げ 1 commit** | 推奨 | dashboard はもう mcq 用、 残作業は 1-2 metric 追加のみ (§1 / D6) |
| **S7 を S8 直前に圧縮 1 commit** | 推奨 | 実質完成済 (§1 S7) |
| **「最小 exam 作成」 を S1 に含める** | **強推奨** | exam 作成不在で OCR 動作不能 (D2) |
| **S3 migration を S1 と同 commit で先打ち** | 推奨 | tags 列を最初から含めた cards INSERT に統一 (D3) |
| **S2 / S3 を 1 sprint 化** | やや非推奨 | scope ふくらみで品質劣化、 別 sprint 保持が安全 |
| **S5 を S1 直後の独立 sprint に** | 非推奨 | S1 内蔵が Critical 防止上 安全 (D1) |
| **S2 + S3 + S4 を 1 sprint で「学習機能全部入り」** | 非推奨 | 規模感 中-大 × 3 = 大型、 Sprint 境界 (CLAUDE.md) で停止判断する利点を失う |

### 5.3 推奨する最終順序 (Claude Code 提案)

```
S0-3 (新規 mini-sprint, 30 分): robots.txt + sitemap.xml の domain 修正
                                 + /pricing 追加 + OG metadata 追加
                                 → 早く倒すほど SEO / SNS 効果に効く

S1' OCR + exam 作成 + plan-limits 発動 + tags 列 migration (大型)
    - exam 作成 mini-UI (試験名のみ)
    - S3 の tags 列 migration を先打ち
    - cards INSERT で plan-limits enforce
    - OCR pipeline (discover mode、 PoC 復元)
    → 旧 S1 + S2 partial + S3 schema + S5

S2 問題管理 (中-大)
    - /app/exams / /app/exams/[id] / /app/cards/[id] CRUD
    - exam archived_at UX
    - cards 編集 (custom_props value 編集含む)

S3' メタデータ UI (中)
    - 一括 tag 編集 UI
    - フィルタ / ソート UI
    → 旧 S3 から schema migration 抜き

S4 学習画面 (中)
    - /app/study/smart + /app/study/practice
    - dashboard 「スマート復習」 link を /app/study/smart に切替
    - quiz placeholder 削除

S6+S7 仕上げ (極小、 1-2 commit)
    - dashboard に試験数 + 月次 OCR ページ消費 metric 追加
    - settings 最終確認 (アカウント削除文言、 法的情報 link)

S8 法務 / マーケ (小-中)
    - 12 placeholder の sed 一括置換 (本気運用切替時の値で)
    - 利用規約同意 flow (Clerk appearance prop or 自前 checkbox)
    - FAQ page (任意)
    - LP 文言最終化

S9 出荷準備 (小)
    - smoke test (Playwright で sign-up → OCR → 学習 → 削除の 1 シナリオ)
    - Vercel Deployment Protection production scope 確認
    - 本番 smoke 実機
```

### 5.4 過剰 / 不足 sprint

**過剰** (圧縮推奨):
- S5 (S1 に統合)
- S6 (分散統合 or 1 commit)
- S7 (実質完成済、 1-2 commit)

**不足** (追加推奨):
- S0-3 mini-sprint (robots/sitemap/OG)
- S8 内に「利用規約同意 flow」 を明示
- S9 内に「robots.txt + sitemap.xml domain 修正」 を明示 (S0-3 で先取りすれば不要)
- exam 作成 UI (S1 に統合)

### 5.5 Claude Code が気づいた懸念 (1〜4 に収まらない)

1. **`vocab.nekotest.net` hardcode の SEO 影響**:
   現在 production deploy 済 (`recallmint.nekotest.net`)。 robots.txt の `Sitemap:` ディレクティブが旧 domain を指しているため、 Google Search Console に sitemap 登録時に拒否される。 **launch 前に必ず S0-3 か S9 で修正**

2. **Clerk sign-up に同意 flow が無い**:
   Clerk 自体は `<SignUp />` に terms link 表示の prop (`termsPageUrl`) は持つが、 layout.tsx の `<ClerkProvider>` で `appearance.layout.{termsPageUrl,privacyPageUrl}` 設定が無い。 launch 前に追加推奨

3. **dashboard 空状態の onboarding 不足**:
   初回サインアップ後の user が「次に何をすればいいか」 わからない。 dashboard が dueCount=0 / todayCardCount=0 で「復習完了！」 と表示するため、 そもそも card が無いのか復習が終わったのか区別できない。 S1 完了時に dashboard 空状態の文言を「最初の試験を作成しましょう」 等に振り分け推奨

4. **`@google/genai` SDK の prompt cache 機構**:
   discover mode の system prompt + responseJsonSchema は試験ごとに同じ。 Anthropic 経験から流用すると Gemini API にも prompt cache 機構があれば API コスト削減可能。 S1 設計時に Context7 で `@google/genai` 公式 doc を引いて確認推奨

5. **schema.ts の `cards.images` field と R2 連携の未来**:
   schema 上 `images: jsonb` で `key` / `url` / `alt` を持つが、 S1 で R2 連携無しなら **MVP では images 配列は常に空**。 S2 / S4 で画像表示 UI を作る意味がない (空配列を render するだけ)。 「v1.x で R2 連携 + 手動添付 UI」 と明示し、 MVP UI は text のみで進めるのが筋

6. **dead code 整理 (M1 / M2) の OCR sprint 直前タイミング**:
   `lib/gemini.ts` (vocab generator) は S1 で全面置換、 `lib/validation/word.ts` も学習 sprint 着手前に削除推奨。 S1 の冒頭 1 commit で「dead code 削除」 をやってから新規実装に入るのが clean

7. **test infra (vitest) は 30 test file で安定**:
   現状の test 規律は強固 (S0-1 / S0-2 / Standard wiring sprint 全部 test 通過済)。 S1 以降も TDD 維持で問題なし

---

## まとめ (要 OT 判断項目)

1. **S0-3 mini-sprint (robots/sitemap/OG)** を S1 着手前に挟むか、 S9 でまとめてやるか
2. **S1 内蔵 vs S5 単独**: plan-limits enforce を S1 と統合する判断
3. **exam 作成 UI を S1 に統合するか前 sprint 化するか**
4. **S3 migration の先打ち**: S1 と同 commit で `cards.tags` migration を打つか
5. **S6 を sprint として残すか分散するか**
6. **S9 で smoke test を Playwright で書くか、 OT 手動 smoke にするか**
7. **dead code (M1 / M2) を S1 冒頭で削除するか別 commit にするか**
8. **`browser-image-compression` 等の新 dep 追加承認** (S1 kickoff prompt で OT 明示)

判断必要: yes

詳細 file path: `docs/superpowers/sessions/2026-05-19-sprint-roadmap-review.md` (本 file)
