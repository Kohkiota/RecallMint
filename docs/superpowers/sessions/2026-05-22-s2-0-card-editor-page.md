# S2.0 sprint log — 個別 card 編集 page

- 日付: 2026-05-22
- branch: `develop` (commit のみ、 push は OT)
- plan: `docs/plans/2026-05-22-s2-0-card-editor-page.md`
- 事前調査: `docs/superpowers/sessions/2026-05-22-s2-0-card-editor-investigation.md`

## 結論

OCR 抽出 card を `/app/cards/[id]` 専用 page で手動編集 (title / 問題文 / 選択肢 /
正解 / 解説) + card 単体削除できるようにした。 試験詳細 page (`/app/exams/[id]`) は
read-only flat list から全情報展開表示へ刷新。 schema 変更・migration・新規 npm 依存
ゼロ。 当初 6 task で着手、 staging smoke 中の OT 指摘で T7〜T10 を追加し全 10 task。
最終 `pnpm test` 420 / `pnpm build` pass。

## task 一覧と review 結果

| task | 内容 | review (C/I/Minor) | 対応 |
|---|---|---|---|
| T1 | card 編集 validation schema (`lib/validation/card.ts`) | 0 / 0 / 3 | Minor#1 (空白のみ入力) fix、 他記録のみ |
| T2 | `updateCard` + `getCardForEdit` | 0 / 0 / 4 | 全 cosmetic、 記録のみ |
| T3 | `/app/cards/[id]` page + card-editor + 詳細の編集 link | 0 / 4 / 5 | **Important 4 件すべて fix** (explanationText 契約 / baseline コメント / beforeunload 統一 / `nextOptionId` test 追加) |
| T4 | `deleteCard` + 削除 button | 0 / 0 / 4 | Minor#1 (コメント) fix、 他記録のみ |
| T5 | tech-spec 更新 (closure) | docs (review 不要) | — |
| T6 | 本 session log | docs (review 不要) | — |
| T7 | 試験詳細 page の全情報展開表示 | 0 / 0 / 3 | Minor#3 (stale comment) fix、 他記録のみ |
| T8 | OCR debug log (`OCR_DEBUG_LOG` env gate) | 0 / 0 / 3 | 全 cosmetic/future-proofing、 記録のみ |
| T9 | 選択肢 ID 表示 + 正解 summary | 0 / 0 / 4 | 全 stylistic/coverage、 記録のみ |
| T10 | 表示改善 (○×) + dirty guard 撤廃 + 保存後リダイレクト | 0 / 0 / 2 | Minor#1 (stale comment) fix、 他記録のみ |

- review は全 feat task で `superpowers:requesting-code-review` skill canonical 経路
  (`code-reviewer.md` template、 placeholder 埋めのみ・改変なし、 general-purpose subagent)。
- **Critical は全 task 0 件**。 Important は T3 の 4 件のみで全数 fix。 握り潰しなし。

## 重要 fix の裏取り (T4)

T4 (`deleteCard`) は「削除を伴う変更」 → review pass → tag 無し commit → OT staging
smoke 観察 → `[reviewed]`。 **OT smoke 結果: 「card 削除 OK、 リダイレクト OK」** (報告
受領済)。 これを受け history 再構成時に `[reviewed]` を付与。

## 経緯メモ

### review の API 529 遅延

T7 / T8 / T9 の formal review は Anthropic API の 529 Overloaded (server-side 一時障害)
で複数回失敗し一時保留。 自由形式 review への代替は CLAUDE.md 禁止のため行わず untagged
で待機。 API 回復後に 3 件とも canonical 経路で review 実施 → 全 Critical 0 / Important 0
で pass。

### OCR「解説が入らない」 問題のクローズ

staging smoke 中、 登録販売の card で解説文が入らない事象を OT が観察。 調査の結果
**PDF 自体に解説が記載されていない**ことが原因で、 OCR は正常動作と判明。 OCR pipeline /
prompt の不具合ではないためクローズ (実装変更なし)。 OCR debug 用途で T8 の
`OCR_DEBUG_LOG` を今後の調査用に温存。

### OCR 503 retry 調査で発見したルール抵触 (S2.0.5 で対応予定)

並行調査 `docs/superpowers/sessions/2026-05-22-ocr-503-retry-trace.md` (commit 済) で
CLAUDE.md AI 絶対ルール抵触 2 件を検出:

1. **429 と 503 の同一視** — `isTransientError` が同一正規表現で transient 扱い。
   429 でも最大 6 call retry され、 ルール 5「429 即時停止・リトライ禁止」 に抵触。
2. **timeout 未設定** — Gemini call に 30 秒 timeout なし。 ルール 6 に抵触。

本 sprint では touch せず、 **S2.0.5 sprint** で対応する。 本 sprint の OCR 関連変更は
T8 (debug log) のみで、 上記抵触とは独立。

## 設計上の確定事項

- 正答 UI = pattern A (各選択肢に独立 checkbox、 check 数で単一/複数/0 を自動判定)。
- 正答数 0 を保存許可 (OCR が正答未記載で取り込んだ card の後付け編集のため、 warning
  表示に留める)。 tech-spec §2.5.2 に注記済。
- dirty guard は T3 で導入 (beforeunload + 自前 confirm) したが T10 で撤廃。 S2.0b の
  inline 編集で dirty 概念が cell 単位に変わること + 保存後リダイレクト導入で page 全体
  guard の意義が薄れたための OT 判断。
- memo 機能 / 画像挿入 / tag (custom_props) 編集 / 一覧の一括操作 は S2.0 scope 外
  (memo・画像は別 sprint、 tag 系は S2.0b)。

## history 再構成

T4 / T7 / T8 / T9 は review pass 後も untagged で積み上がっていたため (T7-T9 は 529
遅延、 T4 は smoke 待ち)、 closure 時に cherry-pick で各 commit の diff を保持したまま
message に `[reviewed]` を追記。 安全のため `backup-s2-0-prereconstruct` branch を切って
実施、 再構成後 tree が backup と完全一致することを検証済。

## 起動

```
pnpm dev
```

`/app/exams/[id]` で card 全情報を確認 → 「編集」 → `/app/cards/[id]` で編集 → 保存で
試験詳細へ戻る。 OCR debug log を見る場合は staging で `OCR_DEBUG_LOG=1` を設定。
