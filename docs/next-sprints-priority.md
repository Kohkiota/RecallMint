# RecallMint 全 sprint 横断 優先順位 (next sprints)

- 起票日: 2026-05-29、 **最終更新: 2026-06-11 (v18 相当、 波1 完了反映)**
- 種別: roadmap (全 sprint 横断の優先順位整理。 cache 領域専用は `docs/cache-fix-roadmap.md`、 dep upgrade 波系列は `docs/superpowers/sessions/2026-06-10-deps-target-versions-matrix.md` が正本)
- 位置づけ: claude.ai の view。 **最終優先順位は OT 決定が優先**。
- 各ステータスは更新時点の実コード verify / closure doc に基づく。

---

## 1. ステータス一覧 (全 sprint)

### ✅ クローズ済
- **波1 (Next 16 核)** [2026-06-11 prod deploy 済 + P0/P1 secret rotate 済] — Next 15.5.15 で稼働中だった prod の 13 CVE (high 7 / mod 4 / low 2、 全て `<15.5.16` 範囲) を Next 16.2.9 LTS + React 19.2.7 + Clerk **7.5.1** (※当初 7.4.3 を選定したが `@clerk/react` との dep declaration 不整合で build fail、 7.5.1 で着地、 `docs/superpowers/lessons/2026-06-11-dep-declaration-bug-build-only-detection.md` 参照) + Node 24 LTS で解消、 `middleware.ts → proxy.ts` rename + matcher 拡張 + 周辺整合まで含めて 6 task。 主要 commit: C1=`f36f164`、 C4=`21a20a7 [reviewed]`、 C2=`49bff77 [reviewed]`、 C3=`390d194 [reviewed]`、 C5=`56b3f69`、 C6=`1ffe921`、 後始末 docs=`ed77418`。 deploy 後 OT P0 (Clerk `CLERK_SECRET_KEY` + 全 session sign-out) + P1 (Stripe Webhook signing secret) rotate 完了。 詳細: `docs/superpowers/specs/2026-06-11-wave1-next16-design.md` + `docs/plans/2026-06-11-wave1-next16-plan.md` + `docs/superpowers/sessions/2026-06-11-wave1-next16-step0-investigation.md`。
- **波2 (ESLint 9 flat config + lefthook gate)** [2026-06-11 prod deploy 済、 波1 と一括 push] — `next lint` 廃止対応で flat config + lefthook pre-commit + sprint 完了 gate の 2 層 lint gate を確立 (GHA は不採用)。 主要 commit: `edf3cab` 他。 波1 中に lefthook の `--no-warn-ignored` 補強 (`96797ee`) を追加。
- **問題 2** flush 並走重複の解消 (in-flight guard、 `5e86839`)。 `docs/superpowers/sessions/2026-05-28-problem2-stg-smoke.md`
- **問題 3** bulk refactor (per-event tx × N → 単一 tx + bulk SQL、 Drizzle #5789 fix 含む)。 flush 16.7-17.4s → 4.8s。 `docs/superpowers/sessions/2026-05-29-problem3-bulk-refactor-closure.md`
- **S2.0.5** OCR pipeline 改修 — **実コード verify で実装済を確認** (`a61ea5a` Flash only 化 + timeout 220s + deadline 720s + page/size 制限、 `lib/ai/clients/gemini.ts` に 220s AbortController + 429 Retry-After parse、 `lib/ai/ocr.ts` で 429 即 throw = CLAUDE.md AI ルール 5 準拠、 `7672e70` 連打防御調査=既存三段防御で十分)。
  - 註: OT memory の「429/503 分離 + Gemini call 30s timeout は deferred」 は**現コードと不一致** (429 handling + 220s timeout は存在)。 残りうる sub-item (503 の明示 backoff 等) があれば別 issue だが、 OCR 改修の主要部はクローズ済。 → §2 着手予定からは除外。
- **Sprint Small Fix ④-1〜④-4** (cache-fix roadmap §4、 PullTrigger layout 化 / prefetch 漏れ / cards/[id] 廃止 / notifyOps 404)。 2026-05-29 実コード verify 済。
- **S2.0** 個別 card 編集 page (inline 編集 cell、 `/app/exams/[id]`)。

### 🔄 進行中 / 直前
- なし。

### 🔜 着手予定 (短期、 launch ブロッカー寄り) → §2
### 📋 spec / idea 段階 (中期) → §3
### 🕗 後回し / launch 後判断 → §4
- **選択肢 attach error の表示位置(狭い delete cell)** [起票 2026-07-16・Sprint I fix] — 選択肢の画像 add アイコンを delete cell に co-locate した副作用で、attach 失敗時(10枚上限/非対応形式)の error `<p w-full>` が狭い auto セル内に出て一時的に列を広げる。error 経路のみ・transient・`role="alert"` は生存ゆえ Minor。頻発するなら error を行下へ portal / 短縮表示に。正記録: canonical review Minor #1。
- **画像上限 `MAX_IMAGES_PER_CARD=10` の単位表示** [起票 2026-07-15・Sprint I] — 4 面化(問題文/選択肢/解説/メモ)で 10 枚上限に当たる確率が上がる(従来は問題文のみ = 実質当たらなかった)。エラー文言「画像は10枚までです」が『カードあたり合計』と伝わるか実利用で観察。当たるようになったら文言 or 上限(合計 vs field 別)を再検討。**本 sprint では実装しない**(文言は brief 指定・変更禁止コメント付き)。
- **safe-area(fixed ボタン下端 × iOS home indicator)= 現 viewport-fit 下では非該当** [更新 2026-07-15] — 旧 S2b follow-up「scroll-top ボタン下端が home indicator と被るか未検証」を調査で解決。現 viewport(`app/layout.tsx` は `viewport-fit=cover` 不在)では `env(safe-area-inset-*)` が全デバイス 0(inert)かつ iOS Safari が CSS viewport を safe-area 手前に inset するため `bottom-4` の fixed ボタンは**構造的に被らない**。**再燃条件 = `viewport-fit=cover` を導入する時のみ**(その際は全 fixed 要素の inset 対応 + 実機再検証が必要な app-wide 変更)。判断根拠: `docs/superpowers/sessions/2026-07-15-cardview-scroll-top-button.md`。
- **~~Sprint F §9(多択カード行高肥大の scroll jitter)未検証~~ → 解決済(2026-07-16)** [起票 2026-07-15 / 解決 2026-07-16] — Sprint I W5 の seed 改修で 20 択カードを混入し、stg 再 seed + OT smoke 5b(多択前後 scroll)で **jitter 観測なし = §9 再燃せず**を実機確認。measureElement の実行高補正が多択でも有効。正記録: `docs/superpowers/sessions/2026-07-16-sprint-i-image-four-fields-completion.md`「§9 検証結果」。

### 🗂 廃案 (再開しない、 理由記録) → §5
- **ローカル FSRS 化** (問題 3 中の C 判断、 OT 確定で正式廃案)

---

## 2. 着手予定 (短期、 launch ブロッカー寄り)

### LocalSync MVP (card 編集 / 削除の local-first 化)
- 母艦: `docs/cache-fix-roadmap.md` §5
- 現状: **spec 確定済**。 schema (Dexie + server `card_mutations` migration `0012` + 適用済) は **scaffold 済**。 sync helper (`lib/sync/card-mutations.ts`) / bulk route (`/api/card-mutations/bulk`) / orchestrator / inline 編集の Dexie 化 は **未着手** (inline 編集は現状 Drizzle 直 UPDATE)。
- 前段: push/pull タイミング棚卸し = Clerk revokeSession 以外は問題 3 で確定済 (cache-fix roadmap §3)。
- 優先度: 高 (inline 編集体感 ~2.5s → ~50ms)。

### 試験セットの手動新規作成経路 (新規 idea、 OT 提案)
- 現状: **spec 未着手**。
- 概要: 試験名入力 → 空試験新規作成 → 後から card 手動追加。 OCR が使えない user の fallback。
- 検討論点 (未着手):
  - DB schema 変更要否 (exams に source 列 = 'ocr' / 'manual' 追加?)
  - source_documents との関係 (manual 作成時の dummy 行扱い)
  - 既存「個別 card 編集 page」 (S2.0 完了) との UX 統合
  - card 手動追加 UI (form / 選択肢動的追加 / 正解選択)
  - 既存試験への card 追加 UI も同 sprint で扱うか
  - Free plan 制限 (試験数 / card 数上限) との整合
- 優先度: 高 (MVP 完成度直結、 OCR 代替経路)。
- 次アクション: spec 議論 (kickoff 前に詳細詰め)。

> 註: S2.0.5 は §1 の通り実装済確認のため本セクションから除外 (5/27 draft では「未着手」 だったが verify で覆った)。

---

## 3. spec / idea 段階 (中期)

- **波3 (TS6 + Stripe 22.2.0 + minor 群)** — 残波。 matrix v1.3 §3.3 が正本 pin list。 `typescript 6.0.3 [exact]` の migration (`tsc --noEmit` 通過確認)、 `stripe ^22.0.2 → 22.2.0 [exact]` (同 major minor bump、 apiVersion 変更なし見込み、 webhook/subscription/downgrade smoke 再実行で足りる)、 minor 群 (svix / dexie / ts-fsrs / radix-ui / lucide-react / tailwindcss / @tailwindcss/postcss / tailwind-merge / tsx / pg 等) は chore 1 commit 可。 drizzle-kit は orm とペア exact 固定 (`0.31.10`)、 vitest + @vitest/coverage-v8 も exact pair (`4.1.8`)。 波1/波2 とは独立 PR。
- **S2.1** FSRS smart 復習実装 (launch-viable minimum)
- **S2.0b** tag schema 移行 + Notion 風 inline 編集 + bulk 編集 (大スコープ)
- **S2.2 / S2.3** dashboard / custom 練習

---

## 4. 後回し / launch 後判断

### Pro → Standard ダウングレード (OT 提案、 設計方針合意済)
- 状態: **設計合意済、 実装未着手**。
- パターン: 「期末切替」 (Zoom / Trello / GitHub 方式)。 差額計算不要 (Stripe `proration_behavior: 'none'`)。
- DB `plan` 列は webhook で `current_period_end` 到達時に Standard 更新。 UI は「Pro (Standard に切替予約済)」 表示。
- 未確定: Free/Standard/Pro 機能差と月額 / launch 時期との関係。
- 優先度: launch ブロッカーではない、 S2 系完走後に判断。

### Sprint ⑤ — 認証コスト撤去 (cache-fix roadmap §6)
- 前段: Clerk revokeSession 即時性調査 (Context7)。
- 効果: layout SELECT (Supabase 移行で大半解消済、 残コスト小)。 構造的に最大 60s zombie window の懸念あり、 慎重に。

### Sprint ⑥⑦ (cache-fix roadmap §7)
- source_documents / upload_records / user_settings mirror。

---

## 5. 廃案 (記録のみ、 再開しないが理由を残す)

### ローカル FSRS 化 (問題 3 中に検討 → 廃案)
- 検討経緯: 問題 3 で OT が「FSRS 計算を client に移して IDB で完結」 案を提示。
- 廃案理由:
  - 現設計はサーバー権威 (server = source of truth / client = mirror + outbox)、 sync 層 / PullTrigger が全部これ前提。
  - ローカル FSRS 化は truth 反転で**複数端末衝突問題を新規に抱える**。
  - 順序 / 重複問題は単一端末内では IDB outbox の local_id 昇順で既に解決済。
  - **複数端末対応を捨てる判断は不可逆**。
  - 問題 3 bulk refactor で性能が 16s → 4.8s に解消され、 ローカル FSRS の主動機 (体感速度) が薄れた。
- 確定: **採用しない**。 将来 architecture を反転する必然性が出た場合のみ再開。
- 出典: 問題 3 spec `docs/superpowers/sessions/2026-05-28-problem3-bulk-refactor-spec.md` §1 + §6-5。

---

## 6. 推奨実行順 (claude.ai の view、 **OT 決定が優先**)

> Claude Code 側では A / B の判定をしない。 以下は OT 提案の 2 候補をそのまま記録。

### 順序候補 A (launch 最優先) — OT の推奨
1. 試験セット手動作成 spec → 実装 (MVP 完成度直結)
2. S2.0.5 (※実装済確認のため実質スキップ / 残 sub-item あれば確認のみ)
3. LocalSync MVP (cache 体感)
4. S2.1 (FSRS smart 復習)
5. その後: S2.0b / S2.2 / S2.3 / Pro→Standard

OT 推奨理由: 試験セット手動作成は「機能の欠落」 を埋める、 LocalSync は「既存機能の体感改善」。 launch viability では機能欠落の priority が高い。

### 順序候補 B (cache 体感優先)
1. LocalSync MVP (体感 quality を先に上げる)
2. 試験セット手動作成
3. S2.1
4. 以降同上

> どちらを採るかは OT 判断。 cache 体感が UX に直結すると見れば B も妥当。
