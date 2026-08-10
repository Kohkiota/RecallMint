# asset レーン整合: plan 段階 Codex cross-check 突き合わせ(2026-08-10)

- Codex raw = `docs/codex/2026-08-10-plan-asset-lane-gc.md`(独立論点 13 / plan 指摘 20 / リスク 9)
- CC plan = `docs/superpowers/plans/2026-08-10-asset-lane-gc.md`(commit `a5832a6`)
- 本 doc = CC による統合(どちらが出したか / 採否 / 対立を明示)。**OT 裁定で plan 確定**(1 パス・fix ループなし)

## A. Codex が正しく、spec/plan の改訂を要する 2 点(Codex 総括の 2 点・いずれも実在)

### A-1. 「core 無改造」×「collect chunk 境界 deadline」×「chunk 20 並列」は三立しない(Codex 独立 2・指摘 1/9/20)

現物確認: `runReconciler` の collect ループ(旧 `scripts/gc-image-assets.ts:302-408`)は候補一括取得 → 逐次 R2 DELETE で、deadline 判定・LIMIT・並列いずれも core 内に無い。CC plan の Global Constraints「chunk 20」と spec §3.3「SWEEP_DELETE_CHUNK 同様の chunk 並列」は core 改造なしには実装不能 — **CC plan / spec の内部矛盾で、Codex の指摘どおり**。

**CC 提案(R1)**: core 無改造を維持し、boundedness を **deps 注入で実現**する(deps は本 sprint の新規コードで spec §3.1 に抵触しない):
- `fetchCollectCandidates` deps に **ORDER BY(oldest 優先)+ per-user per-run LIMIT = 20** を持たせる(core は渡された候補だけ処理する)
- `deleteObject` deps に **`min(DELETE_TIMEOUT_MS, slice())` の timeout 注入**(1 call の超過が budget を壊さない)
- `recordFailure` deps に **slice 枯渇時は書かず suppressed 加算**(src §2/§3 の既存 guard idiom)
- **並列はしない**(chunk 20 並列を spec から削除。逐次 + LIMIT で予算が構造的に閉じる。実測 204 件に並列は不要 = YAGNI)

帰結(正直に書く): 回収 throughput は **≥20 object/user/day**。30 日後の 204 件 spike は大 user(202 件)で **~11 日かけて drain**。退会 user は ⌈N/20⌉ 日(≤20 なら当日)。v58 原理(行が durable = 遅延安全)がこの multi-day drain を正当化する。**spec §3.3 と §7 の当該文言の改訂が必要 → OT 承認事項**。

対立案(Codex リスク欄): core を bounded batch 型へ拡張する。回帰面積が増えるため CC は不採用推奨。

### A-2. 共有 270s deadline では後続 lane の日次実行が保証されない(Codex 独立 1・指摘 2)

現物: CC plan Task 7 は `LaneContext` 縮小のみで予算配分 task が無い — 指摘どおり。src_sweep が異常日で予算を使い切ると asset_gc / orphan が 0 実行になる(連続すれば退会 asset の回収も止まる)。

**CC 提案(R2)**: route が **per-lane の固定絶対 deadline** を配る: src_sweep = start+90s / asset_gc = start+210s / orphan_scan = start+260s(tail 10s・maxDuration 300 不変)。逐次実行のまま、先行 lane が早く終われば後続は早く始まる(deadline は絶対時刻なので配分は保証)。**lane 開始時点で残 slice が MIN_SLICE 未満なら走らせず `not_started` を summary に立てる**(runner 追加。src route の「開始時点 slice ゼロ以下で誤 phase」既知問題の再発を構造で防ぐ + Codex 独立 9 の「lane 未開始の区別」も満たす)。spec §2 / CC plan Task 7 の改訂が必要 → OT 承認事項。

対立案: 共有 deadline のまま受容(starvation は src の incomplete alert で観測可能)。配分 15 行程度で外せる失敗結合なので CC は採用推奨。

## B. CC が採用する指摘(plan に反映・設計変更なし・報告のみ)

| # | Codex | 反映 |
|---|---|---|
| B-1 | 指摘 11 / 独立 4: definer の hardening pin 不足 | Task 1 完了条件に追加: 非 app role(PUBLIC)が EXECUTE 不可 / owner = postgres / `search_path` 固定と schema 修飾は DDL で既対応(pin で固定) |
| B-2 | 指摘 12 / 独立 5: 列挙 predicate と core predicate の drift | Task 1 に **oracle 同値性 iso test** 追加: owner 全走査で「core が作業対象にする行を持つ user 集合」を導出し、列挙結果と集合一致を assert(fixture は 3 arm + deleted-only + marked-only の 5 状態)。silent skip の恒久 pin |
| B-3 | 指摘 7: rowDeleteFailures 後処理で objectKey 再検索が失敗すると失敗事実ごと喪失 | 再検索失敗時は `objectKey: null` で記帳(事実を落とさない)。Task 5 に明記 |
| B-4 | 指摘 8: core 内 recordFailure 失敗が lane の `recordErrors` に届かない | `recordFailure` deps 自身が内部 try/catch で closure counter を加算(core 無改造のまま集約) |
| B-5 | 指摘 6: 行不在確認 `inArray` の SQL parameter 上限 | 500 key/batch に分割(`COLLECT_BATCH_SIZE` idiom)。Task 6 に明記 |
| B-6 | 指摘 14: `candidates` の段階曖昧・rowless 不在 | `OrphanScanSummary` に `rowless`(行確認後の実 orphan 数)追加。candidates = age+pattern 通過(行確認前)と単位注記 |
| B-7 | 指摘 16: build gate | sprint 完了 gate に `pnpm build` 追加(server-only / 静的 R2 import / route 変更は unit で検出不能な class) |
| B-8 | 指摘 17: release checklist | 「実装後」を受入条件形式に具体化(migration 適用の実測 = definer が stg で EXECUTE 可 / CRON_SECRET / cron 発火 readback / 初回 mark 件数 ≈ 204 の確認)|
| B-9 | 指摘 9: Task 5 test 文言(「user 途中」)と実装制約(user 境界)の不一致 | 文言を「user 境界での打ち切り」に修正 |
| B-10 | 独立 11 / 指摘 10: 手動 GET の blast radius(smoke で他 lane も実削除) | **`?lane=<name>` selector(非 prod 限定・複数可)を追加**。cron(無 param)は常に全 lane |

## C. 不採用(理由付き・対立の明示)

| # | Codex | 理由 |
|---|---|---|
| C-1 | 独立 9 / リスク: 成功 heartbeat・cron 未起動検知 | ②-4b の既存方針「成功 run は台帳に書かない」(route.ts:10・INSERT-only grant)との一貫。cron 死の検知は横断課題(src overdue にも同じ盲点)で本 sprint の scope 外 — **claude.ai todo へ**: 「cron heartbeat / last-success 観測の要否(全 lane 横断)」 |
| C-2 | 指摘 13: mismatch 重複記帳の dedup | 現物 0 件(inventory 実測)で日次 noise はゼロ。出現したら毎日鳴るのは意図(異常 key は解消されるべき)。quota ≤5 で bounded。dedup 状態を持つ方が複雑 |
| C-3 | 独立 6 の tombstone / claim 機構 | orphan 0 件に排他機構は YAGNI。live→行→DELETE の順序で「後から行が生える」経路は構成上閉じている(row-first の reserve / live-op 必須の crop。突き合わせは fact-finding §3)。順序自体は Task 6 の変異 red で pin |
| C-4 | 指摘 20: 負荷試験 task | R1 の LIMIT で見積り(数十秒)が load-bearing でなくなった(worst case が構造的に bounded)。実測は stg smoke + 初回 run readback で足りる |
| C-5 | 指摘 18: dry-run divergence 記述の訂正漏れ | **実施済み**(commit `1aec2f3`・Codex の入力 snapshot 後) |
| C-6 | 指摘 3 / 独立 3 の user 処理順(work-age 順) | R1 の per-user LIMIT + R2 の lane 予算で starvation 窓が縮小。列挙に順序情報を足すのは definer の露出拡大。現規模で受容し、恒常的 incomplete 観測を再訪トリガーに |
| C-7 | 独立 7 / 指摘 4: listing 10-page 固定の恒久盲点(>10k key で辞書順後半が永久未観測) | **受容 + 再訪トリガー明文化**を提案: 盲点は到達時に `truncated=true` → incomplete 行 → Discord で**毎日鳴る**(無音の盲点ではない)。StartAfter shard は r2.ts 拡張を要し現規模(242)で YAGNI。**spec §13 に「truncated 観測 = shard/checkpoint 導入の再訪トリガー」を 1 行追記**(OT 承認に含める) |
| C-8 | 独立 12: 退会削除期限の hard 契約化 | spec §13 どおり soft のまま(R1 で ⌈N/20⌉ 日と正直に書き直す)。hard SLA 化は法務要件の具体化待ち(§11 非要件の再判定 gate と同じ扱い) |
| C-9 | 指摘 15: self-heal race の新規 test | 既存 core unit(self-heal 2 test)+ Task 8 ⑤ で被覆済。app 側 deleting-gate への依存は spec §4.2 に記載済 |
| C-10 | 指摘 19: prod lifecycle 実設定未確認 | spec §13 掲載済。B-8 の release checklist に「OT dashboard 目視(asset prefix に rule が無いこと)」を 1 行追加して閉じる |

## D. OT へ(裁定が要るのは A の 2 点 + C-7/C-8 の受容確認)

A-1(deps boundedness・並列削除・multi-day drain の受容)/ A-2(per-lane 固定 deadline + not_started)は **spec 改訂を伴う**。B 群は設計不変の plan 精密化(CC 判断で反映可の認識・異議あれば指摘乞う)。C-7 の「受容 + トリガー明文化」と C-8 の「soft のまま」は spec §13 追記を伴うため承認対象に含める。

裁定後: spec 該当節 amend → plan 改訂 → plan 確定 → 実装(Opus)。
