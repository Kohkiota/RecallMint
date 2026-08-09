# harness — AI が間違えない仕組みの索引

**本書は索引。正 = 各行のポインタ先**(コード / 設定 / hook / test)。how は書かない。why + where のみ。件数・版番号は書かない(正本を見る)。

強制レベル 3 値 = **機械**(lint / policy / gate / hook で自動的に止まる)/ **構成**(コンテナ・権限で構造的に不可能)/ **プロセス**(人の約束)。**下にいくほど「ずれうる場所」**(疑う順)。

素材 = `docs/audit/2026-07-26-h0-part1-harness-inventory.md`(① 全機構棚卸し)。

---

## 1. 機械(人手を介さず自動的に止まる)

| 防御 | 何を防ぐ | 強制 | 正本 |
|---|---|---|---|
| getDb repo-wide ban | RLS を迂回する raw tenant 接続(`withTenantTx`/`getNonTenantDb` 強制)| 機械(lint)| `eslint.config.mjs` |
| Domain purity guard | pure domain が infra/framework/orchestration を runtime import | 機械(lint)| `eslint.config.mjs` |
| lib/components → app import 禁止(Block A)| 共有ロジックの app 層逆流 | 機械(lint)| `eslint.config.mjs` |
| app import 境界(Block B: 深い相対 / cross-feature private)| 機能境界越え import | 機械(lint)| `eslint.config.mjs` |
| `_lib` → `_components` 逆依存(Block C)| feature 内レイヤー逆流 | 機械(lint)| `eslint.config.mjs` |
| no-unused-vars(`^_` 例外)| 未使用 import/var | 機械(lint)| `eslint.config.mjs` |
| pre-commit lint(staged)| commit 時点の lint 崩れ | 機械(commit 契機)| `lefthook.yml` |
| `[reviewed]`/`[no-review]` tag 強制 | feat/fix の未 review commit | 機械(Stop hook・形式)| `.claude/hooks/check-review.sh` |
| test-only 増減宣言の形式検査 | test 変更の分類申告漏れ | 機械(Stop hook・形式)| `.claude/hooks/check-review.sh` |
| ツール呼び出しテキスト漏れ検出 | 既知 harness バグの未実行放置 | 機械(Stop hook)| `.claude/hooks/detect-leaked-toolcall.sh` |
| RLS 隔離 / policy drift / grant narrowing の判定 | user 間データ暴露・SQL↔DB ズレ・権限逸脱 | 機械(test:iso 内・**起動はプロセス**→§3)| `tests/integration/pg/COVERAGE.md` / `db/policies/` / `db/roles/` |
| 実環境(stg/prod)の RLS 状態検証 | **drift test は `assertLocalTestDb` で local iso PG 固定ゆえ stg/prod の未適用・手動改変を検出できない**。実環境の照合と app role 実効検証はこの script が担う(起動はプロセス・app role 以外は実行拒否)| 機械(判定)/ プロセス(起動)| `scripts/verify-rls-state.ts` / 手順 = `docs/ops/rls-p2-stg-runbook.md` §13 |
| Codex read-only 担保(内容ベース git clean detector)| danger-full-access 下の working tree 書換 | 機械 | `scripts/ai/worktree-snapshot.sh` |
| audit gate 判定(prod 無条件 / dev version-aware / fail-closed / tripwire / expiry 強制)| 脆弱性・allowlist 迂回・期限切れ受容 | 機械(**起動はプロセス**→§3)| `scripts/audit-gate.mjs` |
| exact pin による install 非 bump | 意図しない依存 bump | 機械(caret 不在)| `package.json` |
| post-create step postcondition / LSP 実診断 postcondition | pin 不一致・未 install で build を落とす | 機械 | `.devcontainer/post-create.sh` / `.devcontainer/verify-lsp-diagnostics.mjs` |
| 認証必須ページの静的化 / ISR 化 ban(`revalidate`/`dynamic`/`generateStaticParams` export)| レンダリング層のユーザー間キャッシュ漏れ(RLS より前段)| 機械(lint)| `eslint.config.mjs`(Block E1-render)/ 決定 = `docs/architecture.md` §5 |

## 2. 構成(コンテナ・権限で構造的に不可能)

| 防御 | 何を防ぐ | 強制 | 正本 |
|---|---|---|---|
| 権限 deny list(push / curl / wget / ssh / scp / publish / `--no-verify`・`-n`)| 外部送信・publish・push・hook 迂回 | 構成(権限)| `.claude/settings.json` |
| コンテナ隔離(root+`IS_SANDBOX=1`・5432 非 forward)| 権限境界の代替 | 構成 | `.devcontainer/devcontainer.json` / `.devcontainer/README.md` |
| overrides による transitive 固定 | 脆弱 transitive の再解決 | 構成(lockfile)| `pnpm-workspace.yaml` |
| MCP / Codex / TSLS の pin(postcondition で構造保証)| ツール挙動の暗黙 drift・LSP 不動作 | 構成(postcondition)| `.mcp.json` / `.devcontainer/post-create.sh` |
| pnpm 依存 lifecycle script 既定 block + `onlyBuiltDependencies` 明示許可 | supply-chain 面の任意 postinstall 実行 | 構成(pnpm 既定 + 設定)| `pnpm-workspace.yaml` |
| R2 lifecycle rule(prefix `src/`・maxAge 86400s)| PDF source(②-4b)の DELETE 漏れ残骸(明示 DELETE 本線の保険)。**設定は R2 側・OT 手動**(repo に定義なし)。削除実行は「典型 24h 以内」で保証なし = 実効上限 ≈48h と明記(保証しない値を保証扱いしない)。**実削除を 1 例だけ実測済**(2026-08-09・sentinel A が age (23.7h, 36.0h] の区間で消失。rule 本体の readback は現行 credential では 403 のままで、測ったのは rule の存在でなく効果)。**ただし「典型 24h 以内」は依然無保証**で、得たのは 1 例の上下界のみ。恒常的な効果監視は下行 sweeper の overdue alert(72h)が担うが、その観測は **listing 上限 10 page(≈10,000 key)内の partial observation** であって `src/` 全域ではない | 構成(外部設定・OT 管理)| `docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md` §6/§12 |
| `src/` age-based sweeper(日次 Vercel Cron・**repo 初の cron**)| `src/` に残った期限超過 PDF(§1 staging DELETE の取り漏らし / 所有権喪失 skip / §2 退会 purge の打ち切り残 / finalize reject の削除失敗)。cutoff 6h・age で判定し、`src/{uuid}/{uuid}/{uuid}.pdf`(case-insensitive)一致かつ live-op を持たない user の object だけを消す。**`CRON_SECRET` 未設定 = 何も掃かれない**(fail-closed。secret 不在が「壊れる」でなく「守る」側に倒れる反転は非自明ゆえ明記)。**応答は tier で違う** — preview / local は空 secret gate が弾いて 401、production は `requireWebhookSecret` 自身が throw して 500(外周 catch)。「掃かれない」は両 tier で真だが切り分け時に 401 だけを期待しない。`?cutoffMinutes=` の override は production では 400。**HEAD も Next 16 の auto-implement で同一 handler = valid secret 付き HEAD は実削除を走らせる**(冪等だが health-check に使わない)| 構成(cron・`vercel.json` crons)+ 機械(route の auth / 台帳)| `docs/superpowers/specs/2026-08-09-ocr-2-4b-s3-src-sweeper-design.md` / `app/api/cron/sweep/route.ts` |

## 3. プロセス(人の約束・ずれうる)

| 防御 | 何を防ぐ | 強制 | 正本 |
|---|---|---|---|
| whole-repo lint 実行 + 報告 | staged 外の lint 崩れ | プロセス(CI なし)| `CLAUDE.md`「Sprint 完了 gate」 |
| test:iso green 実行 + 報告(無条件)| テナント境界 regression | プロセス(起動)| `CLAUDE.md`「Iso-1」 |
| audit gate `pnpm run audit` 起動 + 報告 | 脆弱性の見落とし | プロセス(起動)| `CLAUDE.md`「audit gate」 |
| 依存/Next 触る時の frozen install + typecheck + build | lockfile drift・matcher 制約の build 時表面化 | プロセス | `CLAUDE.md`「デプロイ前」「Next 設定」 |
| canonical review(skill + general-purpose subagent + template 改変禁止)| feat/fix の未検証 merge | プロセス | `CLAUDE.md`「必須経路」 |
| Codex 独立レビュー(canonical 後・commit 前)| 単一レビュアーの観点漏れ | プロセス | `scripts/ai/codex-review.sh` / `CLAUDE.md`「Codex 協調」 |
| 重要 fix(決済/認証/削除/外部副作用)の裏取り(stg smoke)| 実機でしか出ない regression | プロセス | `CLAUDE.md`「重要 Fix の裏取り」 |
| exact pin 更新の明示 sprint 化 + registry 裏取り | 「上げるべき時に上げる」判断 | プロセス | `docs/superpowers/sessions/2026-07-25-deps-target-versions-matrix-v2.md` |
| ESLint 9 維持(10 不採用)| upstream 未対応 plugin の実行時クラッシュ | プロセス(watch)| matrix v2 / `docs/audit/dependency-audit-ledger.md` |
| MCP / Codex pin 更新手順(contract gate)| フラグ仕様の版変動 | プロセス | `.devcontainer/README.md` §7 |
| subagent dispatch を foreground で行う(background 禁止)| 完了通知取りこぼしで停止 | プロセス | `CLAUDE.md`「Sprint フロー」 |
| 着手前宣言 / commit 直前宣言 / 完了報告 1 行明記 | 手順 skip・宣言なし commit | プロセス(自己申告)| `CLAUDE.md` |

---

## プロセス依存一覧(ずれうる場所の再掲・機械化可否の所見)

| 項目 | 機械化できるか |
|---|---|
| whole-repo lint / test:iso / audit の起動 | 可(GHA 復活 or pre-push hook 化)。現状は意図的に人手。判定ロジックは既に機械 |
| canonical review の経路遵守 | 起動は困難(subagent dispatch は controller 判断)。tag 不在だけ check-review.sh が事後捕捉 |
| Codex 独立レビューの実施タイミング + fix 収束判定 | 困難(保存 md を CC が読む人手判断)。read-only 担保のみ機械 |
| test-only 分類の正直さ + red の実走 | 原理的に不可(宣言者責務・虚偽は cover up) |
| 重要 fix の stg smoke 裏取り | 不可(実機/OT 依存) |
| pin 更新の明示 sprint 化 | exact pin が「意図しない bump」は機械封鎖・「上げる判断」は人手 |
| subagent foreground 規律 | 未整備(規律のみ・機械 block なし) |
| 着手前/commit 直前宣言 | 困難(自己申告) |

---

**維持方法**: 防御を足した / 消した sprint は、ハンドオフに本台帳 1 行の更新を含める。
