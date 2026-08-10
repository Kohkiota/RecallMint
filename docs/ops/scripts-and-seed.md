# scripts / seed / GC 実行手順(運用)

> 本書は運用手順。**設計の理由は `docs/architecture.md`(H-1b で新設)を参照**。接続の使い分けは `docs/ops/connections-and-env.md`。**secret の実値は書かない**。

## 1. 実行形(共通)

```bash
node --env-file=.env.local --conditions=react-server --import tsx scripts/<name>.ts <args>
```

- **`--conditions=react-server` 必須**: `scripts/` は `@/lib/db` を import → `lib/db/index.ts` の `import 'server-only'` が素の実行で throw する。react-server 条件で no-op 解決される。dry-run でも必須(top-level import ゆえ)。
- **`--env-file=<file>`**(Node native): 接続文字列(パスワード平文)を CLI に書かずに済む。owner を要する script は先頭に inline: `DATABASE_URL_ADMIN='<owner 値>' node --env-file=... scripts/<name>.ts`。
- 環境別 env file を使い分ける(例 stg seed 用 `.env.stg-seed`)。詳細手順の前例 = `docs/audit/2026-07-16-{seed-perf-exam-reseed,gc-reconciler-smoke4}-procedure.md`(本書はポインタ)。

## 2. script 用途一覧

| script | 用途 | 接続 |
|---|---|---|
| `seed-perf-exam.ts` | perf 計測用 `[PERF-SEED]` exam の seed / `--cleanup` | owner(`getAdminDb`)|
| `gc-image-assets.ts` | 画像 GC reconciler の **thin CLI wrapper**(core = `lib/storage/asset-gc.ts`)。**本線は日次 cron `asset_gc` lane**(`/api/cron/sweep`)— 本 script は dry-run 観測 / 調査 / 緊急実行専用(mark / promote / collect・`--dry-run`・`--user` 付)| owner |
| `backfill-card-asset-refs.ts` | `card_asset_refs` 正規化 backfill | owner |
| `backfill-clerk-metadata.ts` | Clerk publicMetadata backfill | owner |
| `stripe-test-clock-verify.ts` | Stripe Test Clock 回帰検証(setup/observe/advance/cleanup)| app-role(`DATABASE_URL_APP`)|
| `audit-gate.mjs` / `check-audit-config.mjs` | sprint 完了 gate の `pnpm run audit`(接続なし)| — |
| `ai/*.sh` | Codex 独立レビュー(review / plan-review / detector / count-findings)| — |

## 3. 破壊 script の実効境界(L2 guard を信用しない)

- script 内の env guard(L1 prod 拒否 / L2 token 検査 等)は **stg/prod を確実には判別しない**(seed の L2 は password 誤 match / GC は URL チェック無し等の既往)。
- **実効境界 = ① env 目視(接続先 project ref を確認)② `--user` / `--user-id` scope ③ dry-run 先行**。GC の実削除 smoke は referenced>0 gate 必須。
- 詳細の失敗様態は MEMORY `feedback_destructive_script_guards`。

## 4. 既知の欠陥(現状非修正・次に触る時に同梱)

- **`seed-perf-exam.ts --cleanup` は tombstone を立てない**: owner の DB 直 DELETE(FK cascade で子も消えるが)ゆえ、その exam を mirror 済みの他端末に削除が伝播せず残留する。**実ユーザー経路でない**(perf 計測 seed/cleanup 専用)ため現状非修正。
- 次に `seed-perf-exam.ts` を触る際(perf 計測再開時)に「cleanup も正規経路同様 tombstone を立てる or cleanup 後に対象端末の IDB を消す運用」を同梱する。
- 正本 = `docs/audit/2026-07-24-deleted-exam-mobile-residue-factfinding.md`。
- **`gc-image-assets.ts` の prod ガードはローカル env unset で効かない**(2026-07-16 smoke4 手順書 §4 の既知の穴。asset レーン整合 sprint で cron 化した後もこの CLI 経路自体は残るため未修理のまま)。修理せず、実効境界は §3 どおり運用で担保する(env 目視 + `--user` + dry-run 先行)。**cron 経路(`asset_gc` lane)はこの穴を持たない**(override は非 prod 限定・production では 400)。
