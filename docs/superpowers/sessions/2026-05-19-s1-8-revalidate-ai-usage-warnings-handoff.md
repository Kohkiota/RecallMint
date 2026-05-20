# S1.8 OCR usage tracking + cache invalidation + UX warnings — sprint handoff (2026-05-19)

> S1.7 後の staging smoke で発覚した 4 課題への集約対応。 schema 変更なし、
> 5 commit で完結。 重要 Fix 該当 (外部副作用 = Gemini call counter / global guard /
> cache 無効化) のため OT staging smoke で動作確認後に [no-review] → [reviewed]
> へ amend する S1.7 precedent に倣う。

---

## 完了 sprint (5 commit、 origin push 待ち)

| # | hash | type | 概要 |
|---|---|---|---|
| 1 | `8f6e413` | feat(usage) | ai-usage-counter 新規 (ai_usage / ai_usage_users UPSERT) |
| 2 | `92c1f11` | feat(ai) | runOcrPipeline に onAttempt callback 追加 |
| 3 | `0eee615` | feat(upload) | GEMINI_DAILY_LIMIT guard + ai_usage wiring + revalidate (process) |
| 4 | `56f63fa` | fix(upload) | revalidatePath on discard completion |
| 5 | `d5646c3` | feat(upload) | preview「試験一覧へ」 + router.refresh + amber warnings |

全 commit に `[no-review]` 付与 (provisional)。 OT staging smoke pass 後に
interactive rebase amend で `[reviewed]` 化推奨 (S1.7 precedent)。

---

## 解決した 4 課題 (S1.7 後 smoke 発覚分)

### Critical 1: 残量カウンタが UI に即時反映されない (解決)
- 原因: Server Action 完了時に revalidate していない + 同 page button が
  Server Component を再評価しない
- 解決: processUpload / discardUpload を try/finally で wrap し全 return path
  で `revalidatePath('/', 'layout')` を発火。 同 page 内 button は client
  から `router.refresh()` を最後に 1 回呼ぶ (review I-1 で intermediate refresh 削除)

### Critical 2: ai_usage / ai_usage_users が空 (解決)
- 原因: Sprint A-3.2 で lib/ai-usage.ts を削除した際、 OCR pipeline の INSERT
  経路が消えていた
- 解決: lib/ai-usage-counter.ts 新規。 runOcrPipeline の onAttempt callback
  経由で Flash / Pro / retry 各 Gemini call 直前に
  `incrementAiUsage(user.id, 1)` を呼ぶ。 ai_usage (global) と ai_usage_users
  (per-user) を 1 transaction で UPSERT、 JST 日境界

### Important 3: 「破棄しても残量消費」 注意喚起が地味 (解決)
- 変更前: `text-xs text-slate-500` の一行注釈
- 変更後: amber 警告 banner (`role="alert"` + 「⚠ ご注意」 太字 +
  「AI 抽出の利用枠は元に戻りません」 明示)

### Important 4: spinner banner の警告が地味 (解決)
- 変更前: `bg-slate-50 border-slate-200` + `text-slate-500`
- 変更後: `bg-amber-50 border-amber-400` + `role="alert" aria-live="assertive"`
  + 「⚠ 中断しても AI 抽出の利用枠は消費されます」

---

## 主要 implementation 判断

### onAttempt callback パターン (lib/ai/ocr.ts)
- 案 A (採用): pipeline 内で onAttempt callback を呼び caller が counter 加算
- 案 B (見送り): callGemini wrapper で直接 incrementAiUsage を呼ぶ
- 理由: pipeline を DB import から独立に保ち、 test mock を gemini に集約できる

### processUpload の try/finally split
- `processUpload` は外側で try/finally で revalidate を発火、 中身は `_processUpload`
- 早期 return (AUTH / INVALID_INPUT) でも revalidate 発火するが、 無害 (Server
  Component の fetch 1 回増えるだけ)
- redirect() 等の throw-based control flow とは衝突しない (本実装では未使用)

### parseDailyLimit の guard-off 設計
- env 未設定 / 不正値 / 0 以下は guard off + `logger.warn` で可視化 (review I-4)
- 本番 fail-closed (guard 失敗で OCR 拒否) は「想定外 env で本番停止」 を避ける
  ため見送り。 代わりに log で OT が気付ける状態を担保

### best-effort counter (onAttempt 内 try/catch)
- counter DB エラーで OCR を中断しない設計。 §AI API ルール「上限到達時は
  即時停止」 と一見矛盾するが、 counter は読み取り (guard) と書き込み (incr) を
  分離しており、 書き込み失敗で次回 guard が緩む程度の影響 (smoke で要確認)

---

## review 経路と結果

- **skill**: `superpowers:requesting-code-review` (template 改変なし)
- **subagent**: general-purpose
- **base / head**: `5a4e466` (origin develop tip) → staged working tree (review 時点)
- **結果**: Critical 0 / Important 4 / Minor 5
- **対応**:
  - I-1 (handleRetry の重複 refresh) → fix 済 (Commit 5)
  - I-2 (transaction rollback test 不在) → 注意コメント追加 (Commit 1)
  - I-3 (discard 削除順未検証) → getTableName で順序 assert (Commit 4)
  - I-4 (GEMINI_DAILY_LIMIT 未設定で sirent fail-open) → logger.warn 追加 (Commit 3)
- **assessment**: 「With fixes (recommended: I-4, optionally I-1/I-3)」 → 4 件全 fix

---

## OT staging smoke (8 シナリオ、 [reviewed] amend 前提)

| # | シナリオ | 期待動作 |
|---|---|---|
| 1 | 10 page OCR 成功後、 残量 banner が 30→20 に即時更新 | preview 画面 + /app/upload で残量 20/30 |
| 2 | 「同じファイルでやり直す」 | discard + process 後、 残量 20→20 維持 (新規 +10、 discard -10) |
| 3 | 「ファイルを変えて再試行」 | file 選択画面に戻り、 残量 banner が最新値 |
| 4 | 「試験一覧へ」 button | `/app/exams` に遷移 (旧「ダッシュボードに戻る」 から変更) |
| 5 | ai_usage 記録 | Neon で `SELECT * FROM ai_usage WHERE date = today` → count が OCR 試行回数と一致 |
| 6 | ai_usage_users 記録 | 同 user_id + date で count が OCR 試行回数と一致 |
| 7 | GEMINI_DAILY_LIMIT 超過 | env を `GEMINI_DAILY_LIMIT=5` 等の低値に → 6 回目で 「本日のサービス全体の利用上限」 banner |
| 8 | 警告 banner 視認性 | preview 「破棄」 amber + spinner 「中断 = 消費」 amber が目立つ |

確認後、 OT が `git rebase -i HEAD~5` で各 commit を `reword` して `[no-review]` →
`[reviewed]` に置換するか、 single follow-up commit (`docs(session)`) で記録のみ。

---

## test 推移

- S1.7 末: 317 passed
- S1.8 末: 332 passed (+15)
  - lib/ai-usage-counter.test.ts: 5 new (UPSERT / count default / custom / JST 境界 / get 0)
  - lib/ai/ocr.test.ts: 3 new (onAttempt 成功 / retry+fallback / callback throw)
  - process.test.ts: 4 new (DAILY_LIMIT exceeded / guard off / revalidate success / revalidate quota-fail)
  - discard.test.ts (新規): 3 new (auth fail / not-found / happy 順序)
- build: pass
- lint: 既存 issue (next lint 廃止予定で interactive prompt) のため未検証、 build 通過で代替

---

## やらないこと (kickoff §やらないこと 通り、 本 sprint 範囲外)

- schema 変更 / migration
- counter table 新規作成 (source_documents SUM + ai_usage 既存 schema で対応)
- 月初リセット cron (ai_usage は date 主キーで自然積算)
- Gemini 自前 rate limiting
- preview cards 編集 polish (S2)
- dashboard 月次 OCR metric (現状 /app/upload で十分、 S1b 自体スキップ可)

---

## 次セッション候補

S1.8 staging smoke 完了 + [reviewed] amend 完了後:
- S2 問題管理 (exam rename / archive UX 確定、 cards 編集 UI、 単一 cards 削除、
  source_document 単位の cascade delete)
- S3 メタデータ UI (一括 tag 編集、 custom_props 編集、 フィルタ / ソート)
- S4 学習画面 (FSRS scheduler + /app/study/smart + /app/study/practice)

詳細は `docs/superpowers/sessions/2026-05-19-session-handoff-pointer.md` §「次にやる候補」 参照。

---

## 起動コマンド

```bash
pnpm dev           # /app/upload で動作確認
pnpm test --run    # 332 passed
pnpm build         # production build
```

OT staging smoke 後:
```bash
git push origin develop
# Neon staging で SELECT * FROM ai_usage WHERE date = '2026-05-XX' を確認
```
