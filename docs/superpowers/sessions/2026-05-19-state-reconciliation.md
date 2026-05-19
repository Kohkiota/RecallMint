# State reconciliation (2026-05-19)

> Sprint 設計 review prompt 投入前の整合性チェック。 repo 実体 / 記録間の
> 矛盾を洗い出すだけで、 修正は別 sprint。

## Summary

Critical 3 件 (Tech Spec が schema.ts と乖離 — property_schema / cards.deleted_at /
exams.deleted_at)、 Important 6 件 (docs の orphan ref / billing_interval 反映漏れ /
architecture-guide が plan00 文脈のまま / README の vocab drop 反映漏れ等)、
Minor 5 件 (dead code 残骸 / handoff supersedes marker 等)。 schema.ts と
drizzle migrations / lib / app の **コード側は一貫**しており、 矛盾は
**ほぼ全て docs / spec 側の追随漏れ**。

---

## Critical (本実装着手前に必ず潰すべき)

### C1. Tech Spec §2.5.1 exams が `property_schema` 列を持つ前提のまま

`docs/02-tech-spec.md` の以下が schema.ts と乖離。 commit `b4e62e2`
(exams.property_schema drop) + `0a5ec0d` (PoC 撤去) で MVP は discover mode
一本化済だが Tech Spec 側に未反映。

- `docs/02-tech-spec.md:54` 設計原則 #3: 「cards.custom_props と
  exams.property_schema」
- `docs/02-tech-spec.md:246` §2.5.1 リード文「property_schema が本テーブルの肝」
- `docs/02-tech-spec.md:255-258` column 定義 `property_schema: jsonb(...).$type<PropertySchema>()`
- `docs/02-tech-spec.md:268-329` `PropertyType` / `PropertyDef` / `PropertySchema`
  型定義 + JSON 例 + バリデーション (50KB 上限等)
- `docs/02-tech-spec.md:417, 428, 447` cards.custom_props の「exams.property_schema
  に従って格納」「property_schema の `name` と一致」
- `docs/02-tech-spec.md:691` UI tab「property_schema の編集」
- `docs/02-tech-spec.md:705` `updateExamPropertySchema(examId, schema)` server action
- `docs/02-tech-spec.md:736` `importCSV` 「未知の列を property_schema に自動追加」
- `docs/02-tech-spec.md:823, 828, 845, 847` `lib/ai/` / `lib/exams/property_schema.ts`
  / `PropertyFilters.tsx` / `PropertySchemaEditor.tsx` (本実装側に該当 file 0 件)
- `docs/02-tech-spec.md:931, 966` AI Structured Output 「property_schema を responseSchema
  に動的注入」
- `docs/02-tech-spec.md:1023-1024` Logic 5 (CSV import) の property_schema 自動追加
- `docs/02-tech-spec.md:1155` testing 章「property_schema 検証」
- `docs/02-tech-spec.md:1223` security 章「exams.property_schema 全体で 50KB 上限」

schema.ts:207-228 (exams) には property_schema 列 / 型定義 0 件。 `lib/` / `app/` /
`components/` の本実装側にも `PropertyType` / `PropertyDef` / `PropertySchema` 参照
0 件 (grep 確認)。 schema は drop 完了済、 Tech Spec のみ追随していない。

### C2. Tech Spec §2.5.2 cards が `deleted_at` (soft delete) を持つ前提のまま

schema.ts:230-299 では cards は **hard delete** 確定 (line 231-232 コメント明示)、
Sprint A-2 (commit `fa4dcd9`) で確定済だが Tech Spec が同節 + 周辺節で soft
delete 前提を引きずる。

- `docs/02-tech-spec.md:60` 設計原則 #9「plan00 既存で users / words に deleted_at
  採用、cards にも踏襲」
- `docs/02-tech-spec.md:64` 設計原則 #13「同期対象テーブル (exams / cards /
  source_documents) は ... deleted_at (soft delete) ...」
- `docs/02-tech-spec.md:386` column 定義 `deleted_at: timestamp(...)  // soft delete`
- `docs/02-tech-spec.md:389` `dueIdx: index('cards_due_idx').on(t.user_id, t.deleted_at, t.due)`
  — 実 schema は `(user_id, due)` のみ (schema.ts:294)
- `docs/02-tech-spec.md:460-465` 「soft delete の運用」節 (deleted_at IS NULL で
  抽出 / UPDATE で論理削除 等)
- `docs/02-tech-spec.md:577` §2.8 index 表 cards_due_idx の column が
  `(user_id, deleted_at, due)`
- `docs/02-tech-spec.md:592, 610, 620, 631` §2.9 クエリ例で `WHERE ... deleted_at IS NULL`
- `docs/02-tech-spec.md:718` `getNextSmartReviewBatch` 説明「deleted_at IS NULL」
- `docs/02-tech-spec.md:1006, 1018` Logic 3 / Logic 4 で「deleted_at IS NULL」
- `docs/02-tech-spec.md:1269` §13.14 v1.x sync 設計の「deleted_at (Anki graves 相当)」
  は cards / exams / source_documents の deleted_at 前提

soft delete を本実装で必要とする callsite 0 件、 schema が source of truth。
Tech Spec を hard delete + (user_id, due) index 前提に書き直し必要。

### C3. Tech Spec §2.5.1 exams が `deleted_at` (soft delete) を持つ前提、 schema は `archived_at` で代替

`docs/02-tech-spec.md:262` で `deleted_at: timestamp(...)  // plan00 流儀` と
記述。 schema.ts:204-228 では hard delete + `archivedAt`
(「ダウングレード時の自動アーカイブ」用) で代替済。 Tech Spec §2.5.1 に archived_at
の記述 0 件、 §3 / §2.9 でも archived_at による絞り込みクエリ例 無し。 機能仕様自体
の決定は Sprint A-2 で完了 (schema コメント明示) だが doc 側で議論されていない
ため後続 sprint で「exam アーカイブ UX」を巡って解釈揺れの risk あり。

---

## Important (着手は出来るが早めに潰すべき)

### I1. Tech Spec §2.6 orphan reference

- `docs/02-tech-spec.md:85` `custom_property_definitions` 行末「§2.6 参照」
  — Tech Spec 内に §2.6 セクションは存在しない (§2.5 → §2.7 で skip)
- `docs/research/ocr-schema-vs-discover.md:296` で既に「OCR sprint の spec
  改訂時に、 この参照先を本 research doc に書き換える整理が必要」 と指摘済
  だが Tech Spec 側未対応

研究 doc (§7.1) も「Tech Spec §2.2 / §2.5.1 / §2.5.2 / §2.6 (←) / §7 / §8 Logic 1」
を参照と書いており、 §2.6 orphan が複数箇所から張られている状態。

### I2. Tech Spec §2.3.1 users SQL 定義に `billing_interval` 列が欠落

- `docs/02-tech-spec.md:93-109` users CREATE TABLE 定義に billing_interval 行が無い
- 実 schema (`lib/db/schema.ts:98`) には `billingInterval: text('billing_interval').$type<'month' | 'year'>()`
- migration `0001_third_fat_cobra.sql` (commit `d799cdc`) で `ALTER TABLE users
  ADD COLUMN billing_interval text` 適用済 (staging + production 両 branch)
- 同節リード文 (line 111-116) には「plan = free/standard/pro」だけ書かれ
  billing_interval の説明なし、 §6 課金章にも cycle 軸の記述 0 件

Standard wiring sprint (commit `d799cdc` ... `855de9c`) は完了済、 Tech Spec
trim (commit `6b2947e`) で users SQL 定義は触れられず追加漏れ。

### I3. architecture-guide.md 全体が plan00 / template 抽出 guide 文脈のまま

`docs/architecture-guide.md` は §0 (line 11-22) で「用途 1: plan00 自身の
architecture self-reference / 用途 2: Phase 2 (`nextjs-saas-template`) 抽出
利用者向け guide」 と宣言。 RecallMint は具体的 project (commit `597dfc4`
SERVICE_NAME placeholder 撤回で確定) で template ではないため、 本 doc の
位置付け自体が古い。 個別事実の追随漏れも多い:

- §1.7 (line 104-106): server actions に `app/(app)/app/{review, upgrade, words,
  settings}/actions.ts` 列挙 — `review/` `words/` は Sprint A-2 で削除済
- §1.8 (line 126-127): redirect 表に `app/(app)/app/words/new/page.tsx` /
  `app/(app)/app/words/[id]/edit-form.tsx` (削除済)
- §2.1 (line 159-169): 「vocabulary 特化 folder / file (新 SaaS の domain で
  全削除推奨)」 + `words/`, `review/`, `quiz/`, `lib/fsrs.ts`, `lib/db/streak.ts`,
  `lib/validation/word.ts` を「削除候補」扱い — RecallMint では `fsrs.ts` /
  `streak.ts` は mcq 用に再利用、 `words` / `review` は削除済、 `word.ts` のみ
  生き残り (dead)
- §2.2 (line 173-178): `lib/gemini.ts` / `lib/ai-usage.ts` / `app/(app)/app/words/[id]/ai-panel.tsx`
  — `ai-usage.ts` は Sprint A-3.2 で削除済、 `ai-panel.tsx` も削除済
- §4.4 (line 273-282): 「template 必須 4 table (users / stripe_events / clerk_events /
  deletion_failures)」 — RecallMint baseline は 12 table、 「4 table」 表現が古い
- §7.2 (line 381-383): `app/(app)/app/{words, review, quiz}/` + `lib/{fsrs, gemini,
  ai-usage}.ts` + `lib/db/streak.ts` + `lib/validation/word.ts` を「plan00 特化部分」
  — 既に削除済 / 再利用済 / dead が混在
- §7.4 (line 389-391): `review-session.tsx (382 行)` の split 議論 — Sprint A-2
  で全削除済 (該当 file 不在)
- §8.2 (line 412-417): specs/ 19 file / plans/ 18 file / sessions/ 6 file /
  notes/ 11 file / research/ 3 file と記述 — 実 repo の `docs/superpowers/`
  配下は `sessions/` 3 file + `lessons/` 多数 のみ、 specs/ / plans/ / notes/ /
  research/ ディレクトリ自体が存在しない (架空参照、 Phase 1 plan00 当時の状態)

### I4. README §3 が template 文脈 + vocab drop 反映漏れ

README §3 (Architecture) は §2 冒頭 (line 71-73) で「§2 以降は plan00 由来の
template 利用者向け書換指針」と注記しているが、 §3 内の以下は事実として古い:

- README:155-166 (§3.6 mermaid ER 図): `users ||--o{ words` / `reviews` /
  `ai_examples` を描く — `words` / `ai_examples` table は Sprint A-2 で drop 済、
  実 schema は 12 table
- README:191-211 (§3.8 「vocab 機能 = 次案件 base 拡張対象」): `app/(app)/app/{words,
  review,quiz}/` を「vocab UI / server action 全 (約 290 + 700 + 1 行)」 と記述、
  「`app/(app)/app/page.tsx` dashboard 文言 (`今日の学習単語数`)」 と記述 —
  `words/` `review/` は削除済、 dashboard 文言「今日の学習単語数」は実コードに
  grep 0 件 (mcq 用に書き換え済)
- README:202 `lib/{fsrs,gemini,ai-usage,jst}.ts` — `ai-usage.ts` は Sprint A-3.2 で
  削除済
- README:204 「`lib/auth/plan-limits.ts` = vocab/AI 前提の plan 構造 (`words` /
  `aiGenPerDay`)」 — Sprint A-3.2 で mcq (ocrPagesPerMonth) に書換済

### I5. handoff 2026-05-15 が「次に着手する Sprint: A-3.2」 のまま

`docs/superpowers/sessions/2026-05-15-sprint-a2-a3.1-handoff.md:50` が
「次に着手する Sprint: A-3.2 (コード系)」 と書かれている。 A-3.2 は
2026-05-17 env-separation handoff §1 (`dbdf9c9`) で完成済、 同日 standard-wiring
handoff line 1 で「前 session の続き」 として連鎖が読み取れる。

但し:
- 2026-05-17 env-separation handoff line 167 で 2026-05-15 handoff を参照する
  注釈 (「v0.7 / v0.4 言及は実 repo と乖離あり「後でまとめて訂正」per OT」) が
  あり、 2026-05-15 handoff 末尾に「supersedes by 2026-05-17 ...」 marker が
  無いと historical reader は誤読する余地あり
- 「03-plan.md v0.4」 言及 (2026-05-15 handoff line 47) — 03-plan.md は
  2026-05-17 env-separation 時点で Obsidian 移行 + 削除済 (env-separation
  handoff line 163)

実コードへの影響: Sprint A-3.2 が「部分着手済」 では無い、 完了済 (`lib/auth/plan-limits.ts`
mcq 化 + `lib/ai-usage.ts` 削除 + contact_messages INSERT 配線 + `lib/db/schema.ts`
users.plan 型 widening 全て確認済)。 OT user prompt の「部分着手済の箇所がないか」
には **NO** (完了済) で回答。

### I6. legal-placeholders.md の「{{SERVICE_NAME}} 撤回」 と repo 整合

- `docs/legal-placeholders.md:15-19` SERVICE_NAME 撤回宣言 (12 placeholder 体制)
  + `architecture-guide.md §3.1` (line 201) の 12 placeholder 列挙 + README §2
  table 5 箇所 hardcode — 三者整合
- `app/(marketing)/{terms,privacy,legal}/page.tsx` を直接 grep する手間は省いたが、
  `{{SERVICE_NAME}}` を残置する file は repo 内で見つからなかった (commit `597dfc4`
  全箇所 hardcode 化を信頼)

実害は無いが、 review prompt 直前に 3 file の `{{` grep で dry run 確認推奨。

---

## Minor (気が向いたら潰す)

### M1. dead code: `lib/validation/word.ts` + `lib/validation/word.test.ts`

`wordSchema` / `updateWordPatchSchema` は vocab CRUD 専用、 grep で import 0 件
(本体 `lib/validation/word.ts:1` の自己定義のみ)。 Sprint A-2 で `app/(app)/app/words/`
削除した際の取り残し。 architecture-guide.md §2.1 も「lib/validation/word.ts (9 行)」
を削除候補と認識済。 実害なし、 OCR / mcq schema validation を整備する sprint で
ついでに削除可。

### M2. dead code: `lib/gemini.ts` (vocab example generator)

`lib/gemini.ts:26-31` の `SYSTEM_INSTRUCTION` は「vocabulary example generator」
固定、 `sentence` / `translation` response schema。 grep で import 0 件 (本体
+ test のみ)。 OCR sprint で必ず全面書き換え (Gemini OCR 経路) が想定されるが
現状は dead code として残置。 README §3.8 / architecture-guide.md §2.2 共に
「vocabulary 前提 systemInstruction、 全面書換」 と認識済。

### M3. `app/(app)/app/quiz/page.tsx` の placeholder

`quiz/page.tsx:9` 「Phase 2 で実装予定」 — Sprint A-2 で `review/` 削除後の
仮 placeholder、 dashboard 「スマート復習」 link 先 (`_components/dashboard-actions.tsx:15`)。
OCR / 学習 sprint 着手時に `/study/smart` / `/study/practice` に置換予定だが
spec 上の URL (Tech Spec §3 line 692-695) と差異あり、 「`/app/quiz` vs `/study/smart`」
の URL 設計が未確定。

### M4. drizzle baseline 0000 に `property_schema` 列が含まれる

`drizzle/migrations/0000_keen_the_hunter.sql:75` で `property_schema jsonb DEFAULT
'[]'::jsonb NOT NULL`、 `meta/0000_snapshot.json` / `meta/0001_snapshot.json`
にも property_schema 含む。 0002 で DROP COLUMN 適用済、 `meta/0002_snapshot.json`
には含まれない (確認済)。 history としては論理整合 (greenfield approach A の結果)、
新規 env で migrate 適用すると 0000 (作成) → 0002 (drop) で最終形は同じ。 実害なし。

### M5. schema.ts コメントが migration 履歴に依存

`lib/db/schema.ts:111` 「word_id → card_id (Sprint A-2)、 FK 先は cards.id」 等
の transition コメントは migration 履歴 (drizzle/migrations/) + sessions handoff
に残っており重複。 schema.ts は source of truth として将来 transition コメントを
落とす整理が考えられるが、 Sprint A 完了直後は履歴併記が安全。 実害なし。

---

## OK / Confirmed

### 12 テーブル baseline + Sprint A 完了の反映

- `lib/db/schema.ts` の 12 table (users / ai_usage / ai_usage_users / clerk_events /
  stripe_events / deletion_failures / reviews / exams / cards / source_documents /
  study_days / contact_messages) は handoff 記述 + migration 0000 baseline と一致
- vocab table (`words` / `ai_examples`) は schema.ts に 0 件、 migration 0000 baseline
  にも 0 件 (greenfield approach A による rewrite)
- `app/(app)/app/{words,review}/` ディレクトリは存在しない (`words/new/page.tsx` 等
  architecture-guide / README が参照する path は実 fs に無い)
- vocab 経路コード残骸: `app/(app)/app/_actions/revalidate.ts:9` 等の `Sprint A-2:
  vocab frontend drop` コメントが正しい transition record として残る

### Sprint A-3.2 完了の反映

- `lib/auth/plan-limits.ts` は mcq (free/standard/pro × ocrPagesPerMonth) に
  書換済、 `words` / `aiGenPerDay` 0 件、 test 8 case 通過想定
- `lib/ai-usage.ts` / `lib/ai-usage.test.ts` / `tests/integration/ai-usage-concurrent.test.ts`
  は削除済 (確認済)
- `app/(marketing)/contact/actions.ts` は DB INSERT 実装完了 (validation +
  honeypot + 認証 try/catch 分離 + notifyOps escalation)
- `lib/validation/contact.ts` に `category` field 追加済 (推定)、 contact_messages
  schema (`lib/db/schema.ts:365-385`) の category default 'general' と整合
- `users.plan` 型は `'free' | 'standard' | 'pro'` widening 済 (`lib/db/schema.ts:65-68`)

### Standard wiring + /pricing sprint 完了の反映

- `users.billing_interval` 列追加 (migration 0001 + schema.ts:98) 済
- `lib/stripe/price-mapping.ts` (price_id ↔ (plan, interval)) 存在
- `lib/plan-catalog.ts` 存在、 frontend 5 site (upgrade / settings / delete-button /
  dashboard / webhook) 更新済
- `app/(marketing)/pricing/page.tsx` + `components/pricing/pricing-table.tsx` 存在
- `.env.example:29-32` で STANDARD_MONTHLY / STANDARD_YEARLY / PRO_MONTHLY / PRO_YEARLY
  4 個揃え、 STRIPE 系 env-aware comment 反映済

### OCR PoC 撤去状態

- `scripts/` ディレクトリ全体が存在しない (`scripts/ocr-poc/` 含めて 0 件、 commit
  `0a5ec0d` が完全反映)
- `lib/` / `app/` / `components/` / `tests/` に `property_schema` / `PropertyType` /
  `PropertyDef` / `PropertySchema` / `single_select` / `multi_select` の grep 0 件
- discover mode 一本化前に schema mode 経路を先行参照していた本実装側コード 0 件

### docs / migration 配置

- `drizzle/migrations/` には 3 file (0000_keen_the_hunter.sql / 0001_third_fat_cobra.sql /
  0002_daily_venom.sql) + meta 3 snapshot + _journal.json、 _journal.json entries 3 件と
  ファイル数一致
- `docs/research/ocr-schema-vs-discover.md` の commit hash 列挙 (line 282、 line 301-304)
  は実 git history (`b12f86e` / `26a1c4e` / `0a5ec0d` / `b4e62e2` / `236a189` / `469b23a`)
  と一致 (commit `c91a2c2` で埋め込み済)
- `.env.example` は Standard wiring 完了後の STRIPE_PRICE_* 4 個 + env-aware Stripe
  注釈 + Discord 2 channel 分離 + Gemini DAILY_LIMIT が揃う

### CLAUDE.md / その他

- CLAUDE.md §プロジェクト概要 line 7-10 「Notion 互換のカスタムプロパティ方式
  (cards.custom_props、freeform jsonb)」 は discover mode 一本化と整合 (commit
  `f03635f` で書換済、 「property_schema」 言及 0 件)
- CLAUDE.md §Stripe 絶対ルール (line 39-57) は env-aware 検証ルールに更新済
- CLAUDE.md §Clerk (line 61-73) も env-aware、 `lib/clerk.ts` 検証と整合

---

## Next-step suggestion

OT が claude.ai に sprint roadmap review prompt を投げる前に、
以下を順に処理しておくと次 sprint 設計が schema 整合の上に立てられる。
全て docs / spec 整理で済む範囲、 schema / migration / 実装は触らない。

1. **Tech Spec を schema.ts 整合に書き直す** (Critical C1 / C2 / C3 + Important
   I1 / I2 をまとめて 1 commit、 `[no-review]`)
   - exams.property_schema 関連全箇所削除 (C1)、 §2.6 orphan ref を削除 or
     research doc に redirect (I1)
   - exams / cards から deleted_at 記述削除 (C2 / C3) + cards_due_idx の column を
     `(user_id, due)` に修正 + §2.9 クエリ例の `deleted_at IS NULL` 除去
   - §2.3.1 users SQL に billing_interval 行追加、 §6 課金章に cycle 軸の説明
     1 段落追加 (I2)
   - exams の archivedAt を Tech Spec §2.5.1 に追記 (機能仕様の文書化、 C3)

2. **README §3 を「RecallMint architecture」 文脈に書き直す or trim** (Important I4)
   - §3.6 ER 図を 12 table 構成 (cards / exams / source_documents 等) に更新
   - §3.8 「vocab 機能 = 次案件 base 拡張対象」 節を削除 (RecallMint は具体的 project、
     template 化責務は dev-template repo に移譲済)
   - §2 「見た目変更箇所」 table も RecallMint hardcode 後の状態 (5 箇所が事実上
     hardcode 化済) に整理

3. **architecture-guide.md を historical doc 化 or 全面書き直し** (Important I3)
   - 推奨: `docs/archive/architecture-guide-plan00.md` 等にリネーム + 「historical,
     for plan00 ancestry」 注記、 RecallMint architecture 参照は README §3 +
     Tech Spec §1-§4 + lessons に一本化
   - 代替: §1 / §2 / §4 / §7 / §8 を全面書き直し (RecallMint 12 table + Sprint A
     完了反映)。 但し書き直し工数 > archive コストと推測

4. **dead code 整理** (Minor M1 / M2、 OCR sprint 直前にやると一石二鳥)
   - `lib/validation/word.ts` + `word.test.ts` 削除 (vocab 残骸、 import 0 件)
   - `lib/gemini.ts` + `gemini.test.ts` は OCR sprint 着手時に Gemini OCR 用へ
     刷新するため、 「現状の vocab 用 generator」 のまま残すか、 ファイル削除して
     OCR sprint で新規作成するか OT 判断要

5. **handoff 2026-05-15 末尾に supersedes marker 追記** (Important I5、 1 行)
   - 末尾に「Sprint A-3.2 完了 + Standard wiring + 本番初回 deploy は
     2026-05-17-env-separation-and-prod-deploy-handoff.md + 2026-05-17-standard-wiring-pricing-sprint-handoff.md
     を参照」 と追記、 historical reader 向け

優先度: 1 (Tech Spec 整合) を最優先。 これが完了すれば schema.ts と Tech Spec が
single source of truth として一致するため、 次 sprint で「OCR pipeline 実装」 や
「学習 UX 実装」 の設計議論が docs 矛盾に振り回されない状態になる。 2 / 3 は
読み手向けの整理で sprint 設計には影響しない (但し OCR sprint 完了後に整理する
方が手戻り少ない可能性あり)。 4 / 5 は気が向いたら。
