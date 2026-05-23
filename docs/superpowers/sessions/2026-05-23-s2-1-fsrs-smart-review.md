# S2.1 FSRS スマート復習 sprint 完了

- 日付: 2026-05-23
- branch: `develop` (commit のみ、push は OT)
- plan: `docs/plans/2026-05-23-s2-1-fsrs-smart-review.md`

## 結論

S2.1 (FSRS スマート復習) 全 7 task 完了。 schema 変更 2 点 + submitReview tx +
streak 移行 + session UI + 設定 UI + nav 差替 + closure (tech-spec 更新 + 本 log)。
全 524/524 test pass (T6 時点) / pnpm build / tsc clean。
develop branch、 staging 投入は OT 判断。

## Sprint 達成事項

- T1 `b1a5ad6`: `user_settings` 新設 + `study_days.distinct_card_count` 追加 + migration 0009
- T2 `6f24194`: `rate()` 拡張 (now?) / `submitReviewTx` 純関数 1 tx / `submitReview` server action
- T3 `7ecf8ab`: `streak.ts` を `study_days` 経由に書換、 `AT TIME ZONE` 完全削除、 `getReviewStatsForUser(userId, now?)`
- T4 `1a2f139`: スマート復習 session UI (`getSessionCards` / session page / `SessionRunner` 状態機械 + 完了画面)
- T5 `0417e67`: 設定画面 session_limit (`saveSessionLimit` UPSERT + `SessionLimitForm`)
- T6 `5f969fc`: `/app/quiz` 撤去 + `/app/study/smart` 入口 page + nav / dashboard リンク差替
- T7 (本 commit): tech-spec 更新 + session log

## review 結果集計

| Task | Critical | Important (fix 済) | Minor (記録のみ) |
|---|---|---|---|
| T1 | 0 | 0 | 2 |
| T2 | 0 | 0 (元 I-1 type any / I-2 catch 無 log は fix 済) | 5 |
| T3 | 0 | 0 (元 I-1 test title / I-2 window comment は fix 済) | 3 |
| T4 | 0 | 0 (元 I-1 client tally 二重評価 / I-2 Hard=2 boundary test は fix 済) | 5 |
| T5 | 0 | 0 (元 I-1 updatedAt drift / I-2 DB error 無 catch は fix 済) | 4 |
| T6 | 0 | 0 (元 I-1 session_limit UI 露出 / I-2 Router Cache 残留 は fix 済) | 3 |

- review は全 feat task で `superpowers:requesting-code-review` skill canonical 経路
  (general-purpose subagent / template 改変なし)。
- **Critical は全 task 0 件**。 Important は各 task で fix 済、 握り潰しなし。

## 確定した設計判断

- 「正解」 = `rating >= 2` (Again=不正解、Hard/Good/Easy=正解。 Anki 互換、全コード一貫)
- `session_limit` デフォルト 20 / lazy init (初回保存時 UPSERT、行不在は fallback 20)
- transaction 内 `now` 一本取り (`submitReview` 入口で `new Date()`、tx 全 step に同 instance)
- `distinct_card_count` は `COUNT(DISTINCT card_id)` 毎 review 再集計 (incremental 不採用)
- `AT TIME ZONE 'Asia/Tokyo'` は `streak.ts` から完全削除。`submit-review-tx.ts` の reviews 集計では維持 (reviews.reviewed_at が timestamptz のため必要)
- 完了画面は `SessionRunner` 内部 `state.phase === 'finished'`、別 page 不要
- dashboard 右 button は「カスタム演習（準備中）」disabled で残置 (S2.3 で href 復活前提)

## 既知の Minor (将来 work)

- `ts-fsrs` の `elapsed_days` deprecation 警告 — v6.0.0 アップグレード時に解消
- `study_days.distinct_card_count` の JST 境界: submit-review-tx 側は AT TIME ZONE 維持で正確。streak.ts 側は todayInJst で JST を TS 計算
- session-runner の `pending` 状態 disabled テストは Vitest/Testing Library の制約で困難 (現状テスト省略)

## scope 外 (本 sprint 不実施)

- カスタム演習 `/app/study/custom` (S2.3)
- FSRS desiredRetention / per-user 最適化 (将来 sprint)
- tag / exam 絞り込み filter (将来 sprint)
- 60 日超 streak 履歴 (将来 sprint)

## 判断必要: no

sprint 完了報告のみ。 OT が next sprint kickoff (S2.0b tag schema 移行 か S2.2 か) を判断。

## 詳細 file path

- Plan: `docs/plans/2026-05-23-s2-1-fsrs-smart-review.md`
- 各 task commit: T1=b1a5ad6 / T2=6f24194 / T3=7ecf8ab / T4=1a2f139 / T5=0417e67 / T6=5f969fc / T7=(本 commit)
- tech-spec: `docs/02-tech-spec.md` (§2.2 / §2.5.4 / §2.5.5 / §2.10 ER / §3 routes / §3 actions / §8 Logic 3 / §8 Logic 6)
