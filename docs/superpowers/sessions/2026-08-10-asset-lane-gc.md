# asset レーン整合 sprint — 実施記録(2026-08-10)

- **spec(凍結)**: `docs/superpowers/specs/2026-08-10-asset-lane-gc-design.md`
- **plan**: `docs/superpowers/plans/2026-08-10-asset-lane-gc.md`
- **fact-finding**: `docs/audit/2026-08-10-asset-lane-gc-factfinding.md`
- **plan 段階 cross-check**: `docs/superpowers/sessions/2026-08-10-asset-lane-gc-plan-crosscheck.md`
- **Codex raw**: `docs/codex/2026-08-10-asset-gc-task*.md`
- 状態: **実装完了・未 push**(OT の push 判断待ち)。stg 実機 smoke は未実施

## 1. 何を作ったか

画像 asset の GC(参照ゼロ → mark → grace → promote → collect)を**手動 script から日次 cron へ移し**、**row-less orphan**(R2 に object があるが `assets` 行が無いもの)を回収する lane を新設した。cron `/api/cron/sweep` は 3 lane を順に走らせる。

| commit | 内容 |
|---|---|
| `9ccaf00` | migration 0033: SECURITY DEFINER `app_list_asset_gc_user_ids()` + iso pin(両方向 / hardening / oracle 同値性) |
| `1d1ec2b` | core を `lib/storage/asset-gc.ts` へ移設 + deps の executor/bounded 注入化。script は thin CLI wrapper 化 |
| `88b7d76` | failure catalog +4 entry。workflow に `asset_orphan_scan` |
| `98191e8` | live check を `lib/storage/live-upload-check.ts` へ抽出(2 lane が 1 定義を import) |
| `86d8998` | `asset_gc` lane |
| `a5a08e1` | `asset_orphan_scan` lane |
| `5a116dc` | cron runner 3 lane 化 + per-lane 固定絶対 deadline + 手動 GET override 3 つ |
| `817fb7b` | iso: A/B 共有 asset の refs↔GC 整合を実 SQL で pin(**証明の空白のクローズ**) |
| `8269130` | docs 反映 |
| `78f8237` | 最終 whole-branch review の指摘 7 件 |

## 2. 設計上の裁定(経緯が実装から読めないもの)

### 2.1 owner 依存の正体は「権限」ではなく「RLS の行スコープ」

reconciler が `getAdminDb()` を要求していた理由を調べた結果、**app role は必要な 3 表に全 CRUD grant を持っており、DDL も grant 外の表も無い**。阻んでいたのは `assets_tenant` policy だけで、tenant context 無しでは 1 行も読めない(実測: `ERROR: tenant context (app.user_id) is not set`)。

ゆえに解は「owner を runtime に持ち込む」ではなく「**user_id の列挙だけを RLS 迂回で取り、以降は tenant tx で回す**」になった。SECURITY DEFINER 4 本目の追加は architecture §3 の「3 関数は特殊経路のみ」に触るため OT 承認事項として扱った。

**採らなかった案**: ① R2 `users/` listing から userId を導出(走査量が O(全 object) で長命レーンに不向き・R2 に実体が無い user の残行を拾えない)② runtime に owner 接続(RLS-P1 の封じ込めを正面から壊し、`getAdminDb` は lint ban 対象外なので機械的に止まらない)。

### 2.2 boundedness は core でなく deps に持たせた(A-1)

plan 段階の Codex cross-check が「**core 無改造 × collect chunk 境界 deadline × chunk 並列**の三者は両立しない」と指摘し、現物で真と確認した(core の collect ループは候補一括取得 + 逐次で、deadline も LIMIT も並列も持たない)。

**裁定**: 後者を捨て、boundedness を deps 側(本 sprint の新規コード)で作る。**chunk 並列は撤回**。帰結として回収レートは **user あたり 20 object/run** が上限になり、実測起点 204 件は ~11 日 drain、退会 user は ⌈N/20⌉ 日。これを許すのは §11 v58 原理そのもの(`deleting` 行が durable な削除意図として残るため遅延しても意図は失われない)。

**対立案**(core を bounded batch 型へ拡張)は不採用 — 971 行 / 44 test の実証済み core の改造は回帰面積が大きく、deps 注入なら test 資産が生きる。

### 2.3 予算は per-lane の固定絶対 deadline(A-2)

共有 deadline 1 本だと先行 lane が使い切ったとき後続が毎日 0 実行になり、**先行 lane 側の incomplete しか鳴らないため「asset レーンが止まっている」事実が観測に出ない**。run 開始時刻を原点とする固定オフセットで配ることにした(src 90s / asset_gc 210s / orphan 260s)。早く終われば後続の着手は早まるが、**各 lane の絶対上限は前倒しでは動かない**。

### 2.4 受容した停滞シナリオ(修理しない)

`ORDER BY unreferenced_at NULLS FIRST` + LIMIT 20 のため、**最古 20 件が DELETE 失敗し続けると当該 user の queue を恒久占有する**。skip/backoff は over-engineering として作らない。代わりに **同一 `objectKey` の失敗行が連日出ることを手動介入のトリガー**とする(そのため `r2_gc_delete` / `r2_gc_row_delete` の context に必ず `objectKey` を載せる)。

### 2.5 Task 6 round 5 の裁定 — 撤回した主張

私は fix 指示で「3 行で deadline check の class を完全に閉じる」と述べたが、**OT に撤回された**。今回の fix が閉じるのは「期限切れ後に次の row-check batch を開始する経路」だけで、**`withTenantTx` に query timeout が無いため単一 query の hard bound は無い**。spec §13 に限界として 1 行だけ残っているが、**この撤回の経緯自体は spec に残らない**ため、ここに記録する。

class は 2 種に分けて理解する: ① loop-head guard = 新しい I/O を始めない ② post-loop check = 最終 iteration 後に自然終了しても超過を報告する。

### 2.6 orphan lane の上限は「DB の限界」でなく「意味」から決めた

`graceDays` の上限を Codex は PostgreSQL の interval 範囲から導けと指摘したが、**PG17 実測では timestamp 範囲の方が先に破綻する**(`N=1e8` で既に `timestamp out of range`。Codex が挙げた interval 範囲より厳しい)。DB の許容値を追う設計は版・関数・式の変更ごとに追随が要り脆いので、**パラメータの意味**から `GRACE_DAYS_MAX = 36500`(100 年)を置いた。

## 3. review の実績(dual-review の価値が出た事例)

| task | canonical | Codex | 備考 |
|---|---|---|---|
| Task 5 | 初回 C0/I2/M2 → 全 addressed | 3 周 P2→P2→0 | **canonical が初回 + re-review 2 回で見逃した spec §3.3a「記帳の上限」未実装を Codex が捕捉**。しかも round 1 で直したのと同じ失敗様式が別の記帳経路に残っていた |
| Task 6 | C0/I2/M2 | 3 周 P2→P2×2→P2(**上限到達 → OT 裁定**) | 同じ失敗様式が 3 回別 path から出たため、個別 patch を撤回し責務分離へ構造変更 |
| Task 7 | C0/I0/M3 | 3 周 P2→P2→0 | canonical が「上限なしは意図的・実害なし」と Minor 評価した param について、Codex が「桁数次第で `Infinity` になり整数ですらなくなる」という質的に別の問題を特定 |
| 最終 whole-branch | C0/**I4**/M6 | — | task 単位では全部 pass していたのに、**横断で見て初めて観測系の穴 2 件が出た** |

**Codex の指摘を鵜呑みにしなかった例**も記録する: Task 5 の 1 周目 P1 は「機構の主張は真(Node 実測で確認)/ 影響の主張は偽(`r2.ts` の catch-all が握るため runReconciler は abort しない)」で、severity を下げたうえで**別の理由**(遠隔の不変条件への依存解消)で修正した。

## 4. 私(CC)の process 失敗 2 件

いずれも実装側ではなく**制御ループの欠陥**で、技術的被害はゼロだが記録する。

1. **implementer に commit させた**(Task 1)— SDD skill の template が「実装 → commit → review」順で書かれており、CLAUDE.md の順序則と本 repo の確立慣行(implementer は unstage で返す)を上書きしてしまった。`reset --soft` で巻き戻し、以降の dispatch では「commit するな」を明示。
2. **不完全な完了通知を完走と誤認**(Task 1)— canonical reviewer の通知が途中で届き、それを完走と読んで Codex 実行 → commit まで進めた。実 review はその後に完走し、独立に同じ結論(Critical 0 / Important 0)を出した。commit message を amend して件数を実測値に訂正し、経緯を注記。
3. 上記を受けた**第 3 の穴の点検**で、**Codex の pass 判定を script の stdout 要約行で行っていた**ことが判明(CLAUDE.md は保存 md の内容で判定と明記)。以後 `docs/codex/*.md` を実読してから判定。

対策は 2 件が独立に塞がれている: ① は subagent の行動を制約し、② は私の判定を制約する。

## 5. 残っていること

- **stg 実機 smoke 未実施**(OT 指示待ち)。手順は plan の「実装後」節 + `docs/audit/2026-07-16-gc-reconciler-smoke4-procedure.md`
- **`pnpm run audit` が exit 1**。ただし **sprint 起因ではない** — sprint 起点 commit の worktree で同一の 3 件(prod: nanoid GHSA-2v37-7h3g-55p8 / dev: js-yaml・nanoid)を実測。本 sprint は `package.json` / lockfile / allowlist を触っていない
- prod 反映時の追加確認 2 件(`CRON_SECRET` の Production scope 登録 / asset prefix に R2 lifecycle rule が無いことの dashboard 目視)
