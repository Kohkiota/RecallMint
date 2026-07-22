# RLS Phase 3 最終 hardening wave — session log

- **日付**: 2026-07-21〜
- **plan**: `docs/superpowers/plans/2026-07-21-rls-phase3-hardening.md`
- **実装方式**: subagent-driven-development(review-before-commit 適応: implementer は commit しない → controller が canonical + Codex → [reviewed] commit)
- **BASE**: `c7efb55`(plan 確定 docs commit)

## Task 状況

| Task | 内容 | commit | 状態 |
|---|---|---|---|
| T1 | getNonTenantDb 新設 + 7 構造的非 tenant site 配線 | `608fcfe` | [reviewed] |
| T2 | withTenantTx(userId,fn) 署名変更で getDb 封じ込め | `0822d7b` | [reviewed] |
| T3 | A-manualtx 7 site を getDb-free 化(封じ込め達成) | `4488403` | [reviewed] |
| T4 | getDb export 制限 + no-restricted-imports lint(恒久 enforce) | 未 commit | 完了・Codex 最終確認待ち |
| T5 | grant 縮小 + test:iso matrix + runbook | — | 未着手 |
| T6 | policy drift-detection(選択肢 B)+ COVERAGE.md | — | 未着手 |
| T7 | P0RLS loud alert | — | 未着手 |

---

## T2 裁定記録(OT 2026-07-21)— withTenantTx 署名変更 tripwire

tripwire「決済/認証/削除の既存 test が無修正 green・要修正なら即停止報告」の趣旨は **assertion 集合の不変**であって test ファイル無修正の字義ではない。ensure-user.test の getDb mock 追加は署名変更で DB 注入点が caller→withTenantTx 内部へ移ったことへの**機械配管追従**(全 webhook test と同型・assertion 変更 0・RED 実証済で getDb 未 mock 起因を確認)であり、挙動変更の隠蔽に当たらない。approach b(withTenantTx(db,…) 旧入口を残す wrapper)は「tenant 入口 1 本」の hardening 目的と矛盾するため不採用。OT 明示保護 test(Stripe unit / lifecycle・delete iso)は署名変更でも無修正 green。

## T3 裁定記録 — Codex P1 を false-positive と確定(override 監査記録)

Codex 主張「entity-mutations で getDb 失敗が envelope 503→per-mutation 200 に退行 / test が mask」。**反証 3 根拠**:
1. getDb は auth(getCurrentUser→ensure-user:49 getNonTenantDb)で memoize、init 失敗は 500 で surface = envelope の getDb path は旧新とも到達不能。
2. connection-drop-during-mutation は旧新とも per-mutation catch→200-failed で Task3 不変。
3. `failed[]` は client が pending 残置→次 flush で再送(`lib/sync/entity-mutations.ts:338-343` L343 コメント)= silent lost write なし。

canonical(独立 opus)も同結論(Minor 格)。過剰防御コード(unreachable path の envelope DB validation)は簡潔性規律により追加せず。route.ts:220 コメントの over-claim(getDb/connection 断が envelope 到達)は主張精度のため訂正済。

---

## T4 getDb-ban 完成確定 — 全列挙・全カバー・RED pin(OT 2026-07-21 指示)

Codex の逐次発覚方式(r1〜r4)でなく、**DB handle を import しうる場所を先に全列挙**し 1 周で閉じた。

### (1) executable scope 全列挙(.ts/.tsx を含む全 dir)+ getDb-ban block 対応

| scope | `files:` glob | block | getDb ban | 例外(ignores) |
|---|---|---|---|---|
| lib/** | `lib/**/*` | Block A-getdb | ✓ | `lib/db/**`, `*.test.ts(x)` |
| lib/{stripe,reviews,cards,tags,media}/domain/** | 各 domain glob | domain blocks(GETDB_BAN 合成) | ✓ | `*.test.ts` |
| components/** | `components/**/*` | Block A-getdb | ✓ | `*.test.ts(x)` |
| app/** | `app/**/*`(+`app/**/_lib/**`) | app getdb blocks | ✓ | `*.test.ts` |
| tests/** | `tests/**/*.ts(x)` | tests block | ✓ | `*.test.ts(x)`, `fixture.ts` |
| **scripts/**** | `scripts/**/*.ts` | **Block getDb-scripts(本 wave 追加)** | ✓ | `scripts/**/*.test.ts` |
| root `*.ts` | `*.ts`(非再帰) | Block getDb-root | ✓ | `*.test.ts`, `*.d.ts` |
| types/** | (`.d.ts` のみ) | — | n/a(declaration・runtime import 不可) | — |

→ **executable scope は 8 種全て cover**(scripts 追加で完了)。非 cover は types(=.d.ts で import 不可)のみ。DB handle import 実在集合: production 非 test の getDb import は **ゼロ**(内部 `lib/db/tenant-tx.ts` のみ)、scripts は getAdminDb(4 file・allowed)。

### (2) notation 全カバー(lib/db/index.ts に解決しうる import 文字列)× GETDB_BAN

`GETDB_BAN` = paths(`@/lib/db` importNames:['getDb'])+ regex(`^(?:@/lib/db|(?:\.\./)+lib/db|(?:\.\./)+db|\./db)(?:/index)?/?$`, importNames:['getDb'])。

| notation | 例 | カバー |
|---|---|---|
| alias | `@/lib/db` | paths ✓ |
| alias 末尾スラッシュ | `@/lib/db/` | regex ✓ |
| alias subpath | `@/lib/db/index`, `@/lib/db/index/` | regex ✓ |
| 相対 db | `../db`, `../../db`, `../db/`, `../db/index` | regex ✓ |
| 相対 lib/db | `../lib/db`, `../../lib/db` | regex ✓ |
| 同一 dir(lib root) | `./db`, `./db/` | regex ✓ |

**非 ban(negatives)**: `getNonTenantDb` / `getAdminDb` / `import type { DB }` / `closeDb` = importNames:['getDb'] のみ対象ゆえ通過。**exempt**: `*.test.ts(x)`(全 scope)/ `*.d.ts` / `lib/db/**` 内部 / tests `fixture.ts`。

### (3) 塞ぎ残しゼロ RED pin — throwaway file × 実 eslint(30/30 PASS)

`scratchpad/getdb-red-sweep.sh`: 各 (scope × notation) の throwaway file を作り実 `npx eslint` にかけ、getDb は FLAG / 非 getDb・exempt は CLEAN を実証 → 全削除(probe 残存ゼロ確認)。

- **21 FLAG**(10 scope × alias getDb + 11 notation)全て弾かれる = 各 scope・各書き方が実弾で reject。
- **9 CLEAN**(5 negatives: getNonTenantDb×3/type DB/getAdminDb-in-scripts + 4 exempt: test×3/lib/db 内部)= over-ban なし。
- 合計 **PASS=30 / FAIL=0**。

永続 regression: `tests/lint/import-boundary.test.ts` 39 tests(scope・notation・negative・exempt を lintText で pin、RED 検証済)。whole-repo `pnpm lint` --max-warnings=0 exit 0 / typecheck 0。

→ **executable scope 全列挙・全 notation カバー・各書き方 RED pin 済**を確定。以降 Codex は本照合を 1 回確認のみ(周回しない)。
