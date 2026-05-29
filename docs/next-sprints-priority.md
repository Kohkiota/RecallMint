# RecallMint 全 sprint 横断 優先順位 (next sprints)

- 起票日: 2026-05-29
- 種別: roadmap (全 sprint 横断の優先順位整理。 cache 領域専用は `docs/cache-fix-roadmap.md`)
- 位置づけ: claude.ai の view。 **最終優先順位は OT 決定が優先**。
- 各ステータスは 2026-05-29 時点の実コード verify / closure doc に基づく。

---

## 1. ステータス一覧 (全 sprint)

### ✅ クローズ済
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
