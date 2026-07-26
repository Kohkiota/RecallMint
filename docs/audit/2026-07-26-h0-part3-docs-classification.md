# H-0 ③ docs 分類 + 統合/削除提案(fact-finding・読み取り専用)

- **作成日**: 2026-07-26
- **位置づけ**: H トラック H-0 の 3 本目(最終)。最終目的 = **H-1(台帳 2 枚 `docs/harness.md` / `docs/architecture.md` 新設 + docs 整理の実行)の入力**。**本タスクは提案まで・実行は H-1。**
- **① ② との関係**: ①=機構(`2026-07-26-h0-part1-harness-inventory.md`)/ ②=設計不変条件(`...part2-architecture-invariants.md`)。② のサマリ表が §4 対応表の行、① の機械強制済み一覧が §5 D の照合軸。
- **scope**: 構造の分類・統合・削除の提案に限る。**内容の改善提案はしない**。台帳(harness.md/architecture.md)の中身は書かない(H-1)。
- **調査手法**: 現物を読んでから分類(ファイル名推測不可)。既存 docs を信用して転記しない。**HEAD**: `27c386c`。
- **全体規模**: `docs/` 配下 **744 file**(内訳 = codex 310 / superpowers/sessions 181 / superpowers/plans 94 / superpowers/specs 68 / audit 33 / superpowers/lessons 23 / plans 13 / docs 直下 9 / ops 3 / research 2 / e2e-notes 2)。**整理の主戦場 = docs 直下 9 file**(下記個別分類)。大 dir は規約単位で分類 + 例外のみ個別。

---

## 1. 分類表

### ディレクトリ規約(実物サンプル読で確定)

| dir | 件数 | 規約分類 | 根拠 |
|---|---|---|---|
| `docs/codex/` | 310 | **record** | `codex-review.sh` の自動生成物(日付付き・追記のみ・過去のレビュー結果)。living なし |
| `docs/superpowers/sessions/` | 181 | **record** | sprint クローズ session log(日付付き・不変)。**例外 = matrix v2(living正本)/ matrix v1(superseded record)**(下記) |
| `docs/superpowers/plans/` | 94 | **record** | 実装 plan(実行後 frozen) |
| `docs/superpowers/specs/` | 68 | **record** | spec(CLAUDE.md「Spec の凍結」= 実装後書き換えない) |
| `docs/superpowers/lessons/` | 23 | **record** | 日付付き知見(古くても嘘にならない) |
| `docs/audit/` | 33 | **record** | factfinding / audit(日付付き調査結果)。**例外 = `dependency-audit-ledger.md`(living)**(下記) |
| `docs/plans/` | 13 | **record** | 旧 plan(2026-05〜07) |
| `docs/ops/` | 3 | **living** | runbook(実態が変われば更新)。rls-p2-stg-runbook / stripe-test-clock-verify-runbook / webhook-runbook |
| `docs/research/` | 2 | **record** | 研究ノート(ocr-schema / cloze-anki) |
| `docs/e2e-notes/` | 2 | **record** | smoke スクショ(png) |

### 規約からの例外(サブ dir 内の living / 正本扱い)

| パス | 規約 | 実分類 | 理由 |
|---|---|---|---|
| `docs/superpowers/sessions/2026-07-25-deps-target-versions-matrix-v2.md` | record | **living正本** | 依存 pin 方針の SSoT(② G4・① G1 が参照)。実態が変われば更新義務 |
| `docs/superpowers/sessions/2026-06-10-deps-target-versions-matrix.md`(v1.3) | record | **record(superseded 明示)** | matrix v2 が supersede と明示。履歴保持 |
| `docs/audit/dependency-audit-ledger.md` | record | **living** | 受容 allowlist の台帳(追加/変更で更新義務・① G3 が参照) |
| `docs/ops/rls-p2-stg-runbook.md` | living | **living(prod flip 後 record 化予定)** | Phase3 全表 RLS 後に固定化しうるが現状 living |

### docs 直下 9 file(個別分類・整理の主戦場)

| パス | 分類 | 最終更新 | 被参照 | 判定理由 |
|---|---|---|---|---|
| `docs/02-tech-spec.md` | **living** | 2026-07-18 | 43 | 全体 tech spec(14 章・Data Model/API/Auth/Billing/AI/Security/PWA sync)。最多被参照。staleness-prone だが正本級 |
| `docs/architecture-guide.md` | **廃止候補(陳腐化)** | 2026-07-18(内容 2026-05-07) | 8 | **pivot 前 vocab template 抽出ガイド**。`words/`/`review/`/`quiz/`/`lib/gemini.ts`/`lib/fsrs.ts`/`lib/db/streak.ts`/Neon/`lib/clerk.ts`/`deletion_failures` = 現存しない or rename 済。**参照先 3 doc(TODO.md / cache-fix-roadmap.md / notes/)が MISSING**。env §5.1 のみ部分更新(RLS-P1) |
| `docs/legal-placeholders.md` | **living** | 2026-05-17 | 9 | 法務 3 page(terms/privacy/legal)の `{{...}}` sed 置換 system。運用で使う・現行実装に対応 |
| `docs/next-sprints-priority.md` | **廃止候補(陳腐化)** | 2026-07-16 | 6 | roadmap(自称「claude.ai の view・OT 決定優先」)。`cache-fix-roadmap.md`(MISSING)/ matrix v1.3(superseded)/ `lib/sync/card-mutations.ts`(entity-mutations に rename・実装済)を参照。todo-v47 と二重の stale mirror |
| `docs/recallmint-billing-reference.md` | **要判断(廃止 or 統合)** | 2026-06-03 | **0** | 課金リファレンス(users 列 / price mapping / 予約 3 列)。内容は概ね正確だが **被参照 0** + 02-tech-spec §6 と重複。downgrade fix(2026-07-10)前の版 |
| `docs/recallmint-idb-sync-bestpractice-comparison.md` | **living(自称「恒久」設計 ref)** | 2026-05-31 | 3 | sync 定石↔実装 対応表。「同期周りを触る前に必読」。設計根拠 ref として維持。「実装状況マトリクス」は staleness-prone(§6 B) |
| `docs/recallmint-incremental-pull-steps.md` | **record(完了記録・自称「恒久」)** | 2026-05-31 | 4 | 増分 pull step 1-7 の完了記録(2026-05-30 全完了)。todo-v47 が delete residue で参照。日付付き完了記録 = record |
| `docs/setup-notes.md` | **要判断(廃止 or 移動)** | 2026-05-15 | 2 | template 新規立ち上げの一回性 setup(bufferutil/watchOptions/gitignore)。**`watchOptions` は現 `next.config.ts` に不在(stale)**。onlyBuiltDependencies は現行有効。`.devcontainer/README` と領域重複 |
| `docs/todo-v47-integrated-status.md` | **record(日付 snapshot)/ 要判断** | 2026-07-24 | 3 | v47 統合ステータス(自称「claude.ai の view」)。2026-07-18〜21 session 統合の dated snapshot。§4 公開前 PII バケット + §5 backlog は living 的内容(移管先要検討) |

---

## 2. 目標 docs 構成(提案・実行しない)

H-1 で新設する台帳 2 枚 + 整理後の想定ツリー(**提案**):

```
docs/
├── harness.md                    ← NEW(H-1・① を索引化。機構: lint/gate/権限/review)
├── architecture.md               ← NEW(H-1・② を索引化。設計不変条件)★ architecture-guide.md とは別物(命名衝突注意)
├── 02-tech-spec.md               ← living(維持)
├── legal-placeholders.md         ← living(維持)
├── ops/                          ← living runbook 群(維持)+ NEW 受け皿(§8)
│   ├── rls-p2-stg-runbook.md
│   ├── stripe-test-clock-verify-runbook.md
│   ├── webhook-runbook.md
│   ├── connections-and-env.md        ← NEW 候補(APP/ADMIN/ポート/適用順序)
│   ├── scripts-runbook.md            ← NEW 候補(seed/GC/backfill 実行手順)
│   ├── test-accounts.md              ← NEW 候補(テストユーザー台帳・stg/prod)
│   └── environments.md               ← NEW 候補(stg/prod 識別・rollback 索引)
├── reference/                    ← 提案: 設計 ref を集約(任意)
│   ├── idb-sync-comparison.md         ← 移動候補(現 docs 直下)
│   └── billing-reference.md           ← 統合 or 移動 or 廃止(§3)
├── audit/                        ← record(factfinding)+ dependency-audit-ledger.md(living)
├── superpowers/{sessions,plans,specs,lessons}/  ← record
│   └── sessions/…deps-target-versions-matrix-v2.md  ← living正本(場所は現状維持 or reference/ 昇格を H-1 判断)
├── codex/                        ← record(自動生成)
├── research/ e2e-notes/          ← record
└── archive/ (or 削除)            ← architecture-guide.md / next-sprints-priority.md 等の廃止候補
```

- **命名衝突の明示**: 新 `architecture.md`(② の索引)と既存 `architecture-guide.md`(pivot 前 template 抽出ガイド)は**別物**。H-1 で `architecture-guide.md` を廃止/archive しないと 2 つの「architecture」doc が並ぶ。
- 大 dir(codex/sessions/plans/specs/lessons/audit)の構造は現状維持(record は触らない)。整理対象は **直下 + ops 受け皿新設**。

---

## 3. 統合 / 削除 / 移動の提案リスト(最重要・1 件ずつ OT 承認可能粒度)

| ID | 対象 | 操作 | 内容の行き先 | 理由 | リスク | 推奨度 |
|---|---|---|---|---|---|---|
| P1 | `docs/architecture-guide.md` | **廃止(archive)** | 有効部(RG 3 層 / chrome / redirect map / env)は新 `architecture.md`(H-1)or 02-tech-spec に取捨選択で吸収 | pivot 前 vocab template(words/review/quiz/gemini/fsrs 全消滅)+ 参照先 3 doc MISSING + Neon/deletion_failures 等 stale。索引としての正確性が崩壊 | git 履歴に残るゆえ復元可。有効な RG/redirect/env 情報が拾われず消える恐れ → **吸収 task を H-1 に明記**。template 抽出が現 OT 目標かは §9(要 OT) | 強く推奨(要 OT: template 抽出目標の有無) |
| P2 | `docs/next-sprints-priority.md` | **廃止** | backlog は claude.ai 側 todo(OT 管理)+ todo-v47(§5)へ | stale roadmap(cache-fix-roadmap MISSING / matrix v1.3 superseded / card-mutations rename 済・LocalSync 実装済)。roadmap は claude.ai 側が正本 | 復元可。§5 廃案(ローカル FSRS)の理由記録が失われる → 廃案理由は問題3 spec に既存ゆえ実害小 | 強く推奨 |
| P3 | `docs/recallmint-billing-reference.md` | **統合 or 廃止** | 02-tech-spec §6(課金)+ 新 architecture.md の billing 行 + `lib/stripe/` code | 被参照 0 + 02-tech-spec §6 と重複 + downgrade fix 前(2026-06-03) | 復元可。users 列の詳細一覧が tech-spec §6 に無ければ移送要 | 推奨(要 OT: tech-spec §6 と内容突合してどちらを正本にするか) |
| P4 | `docs/setup-notes.md` | **移動 or 廃止** | `.devcontainer/README`(setup)+ K1(onlyBuiltDependencies は既記載)へ | template 一回性 setup + watchOptions stale(現 next.config 不在) | 復元可。bufferutil/gitignore の setup 知が devcontainer README に無ければ移送 | 推奨 |
| P5 | `docs/recallmint-idb-sync-bestpractice-comparison.md` + `...incremental-pull-steps.md` | **移動(reference/)** | `docs/reference/` へ(内容不変) | 直下の設計 ref を集約。sync 索引を 1 箇所に | ほぼなし(パス変更のみ・被参照 link 更新要) | 要判断(移動の要否は H-1) |
| P6 | `docs/todo-v47-integrated-status.md` | **現状維持 + 内容移管** | §4 公開前 PII バケット → ops/ or architecture.md の risk 行 / §5 backlog → claude.ai todo | dated snapshot は record として残してよいが、living 的 PII バケット/backlog を snapshot に閉じ込めると腐る | なし(移管は追記) | 要判断 |
| P7 | matrix v1.3(`sessions/2026-06-10-...`) | **現状維持** | — | superseded 明示済 record。履歴保持が正 | なし | 現状維持 |
| P8 | 大 dir(codex/sessions/plans/specs/lessons/audit の record 群) | **現状維持** | — | record は日付付き・追記のみ・古くても嘘にならない。整理対象外 | なし | 現状維持 |

> **廃止候補の総括**: 強く推奨廃止 = P1 architecture-guide.md / P2 next-sprints-priority.md。要判断廃止/統合 = P3 billing-reference / P4 setup-notes。living 内容が消える提案はしていない(全て行き先明記)。

---

## 4. 対応表(② 不変条件 ↔ docs ↔ test・重複/欠落の可視化)

② サマリ表の代表行に対する記述箇所。**重複 = 2 箇所以上 → 正本推奨を併記**。

| 不変条件(②) | 記述 docs | 証明 test | 判定 / 正本推奨 |
|---|---|---|---|
| A1-A5 sync(outbox/pull/tombstone/reconcile) | 02-tech-spec §14 + idb-sync-comparison + incremental-pull-steps + architecture-guide(stale) + ②doc + 2026-07-24 FF | pull/bulk unit + contract | **重複** → 正本 = idb-sync-comparison(設計根拠)+ code。architecture-guide の sync 記述は廃止で消す |
| B1-B4 tombstone | 2026-07-24 FF + ②doc + incremental-pull-steps | pull.test | **適正**(FF が主)→ 正本 = 2026-07-24 FF |
| C1-C6 auth/tenant/RLS | 02-tech-spec §5 + COVERAGE.md + rls FF 群 + rls-p2-runbook + architecture-guide §1.5(stale) + todo-v47 §2 + ②doc | rls-* iso + ensure-user | **重複** → 正本 = COVERAGE.md(behavioral)+ rls-p2-runbook(運用)。tech-spec §5 は概説 |
| C7 非 RLS 5 表 grant | COVERAGE.md + hardening plan + ②doc | grant-narrowing.test | **適正** → 正本 = COVERAGE.md |
| D1-D4 GDPR delete | 02-tech-spec §6 + architecture-guide §4.3(stale) + handle-clerk-event コメント + ②doc | webhook-clerk.contract + iso | **重複** → 正本 = code(handle-clerk-event)+ ②→architecture.md |
| E1 rendering(dynamic/ISR 不使用) | どこにも決定記録なし(§7) | なし | **欠落**(② 暗黙)→ architecture.md で決定化 |
| E2 prefetch=false | lessons 2026-05-25 + 各 page コメント | なし | **適正** → 正本 = lessons |
| F1-F4 images(assetId/GC) | image-gc spec + ②doc + memory | asset-state / gc test | **適正** → 正本 = image-gc spec + code |
| G1-G4 billing/downgrade/apiVersion | 02-tech-spec §6 + billing-reference + architecture-guide §4.2(stale) + 2026-07-10 FF + matrix v2 §6 + ②doc | subscription-changes.test | **重複** → 正本 = 02-tech-spec §6 + 2026-07-10 FF(downgrade)+ matrix v2 §6(apiVersion) |
| H1-H2 DDD | intent doc(2026-07-08)+ CLAUDE.md + ②doc | domain unit + lint | **適正** → 正本 = intent doc + CLAUDE.md「設計方針」 |
| I1 env APP/ADMIN | .env.example + architecture-guide §5.1(stale) + tech-spec §10 + todo-v47 + ②doc | db-url.test | **重複** → 正本 = .env.example(値)+ 新 ops/connections-and-env(使い分け・§8) |
| J1 OCR 契約 | 02-tech-spec §7 + CLAUDE.md AI + ②doc | ocr.test | **適正** → 正本 = CLAUDE.md AI + code |

**重複と判定した不変条件**: sync(A) / auth・RLS(C) / GDPR delete(D) / billing・downgrade(G) / env APP・ADMIN(I1)。→ H-1 で「1 箇所に寄せて他はポインタ化」。

---

## 5. CLAUDE.md セクション分類(H-2 入力)

CLAUDE.md 全セクション(行数は概算)を 4 分類:

| セクション | 概算行 | 分類 | 所見 |
|---|---|---|---|
| 概要 / スタック | ~12 | 1 常時規律 | 残す |
| Stripe(絶対) | ~10 | **2 領域別 → skill 候補** | `stripe-billing`(キー分岐/webhook 署名/idempotency) |
| Clerk(絶対) | ~8 | **2 領域別 → skill 候補** | `clerk-auth`(キー分岐/proxy/user_id 必須/紐付け) |
| AI API(絶対) | ~8 | **2 領域別 → skill 候補** | `ai-gemini-ocr`(無料枠/429 即停止/mock 必須) |
| 品質基準 | ~6 | 1 常時規律 | 残す(UI 世界観含む) |
| Sprint フロー(skill skip 禁止) | ~10 | 1 常時規律 | 残す(着手前宣言/実装方式/subagent foreground) |
| Review と Commit — 順序則/必須経路/宣言/結果分類 | ~60 | 1 常時規律 | 残す(核) |
| Review と Commit — Codex 協調 | ~15 | **2 領域別 → skill 候補** | `codex-review-flow`(重大度マッピング/3 周上限/read-only) |
| Review と Commit — Tag と hook | ~8 | **3 機械強制の重複** | check-review.sh が強制(① A8/A9)。規律の要点だけ残し詳細は hook |
| Sprint 完了 gate | ~20 | **3 機械強制の重複(一部)** | lint/test:iso/audit の判定は script(① B1-B3)。ただし**起動は人手**ゆえ「実行+報告」義務は残す |
| OT 向け出力規律 | ~15 | 1 常時規律 | 残す(Smoke/kickoff 含む) |
| Plan の書き方 | ~30 | **2 領域別 → skill 候補** | `writing-plans-recallmint`(spec 凍結/Codex plan cross-check/Sprint 境界/自走継続)。superpowers:writing-plans と併存 |
| 環境変数 | ~4 | 1 常時規律 | 残す(.env.example 同 commit 規律) |
| 簡潔性規律 | ~10 | 1 常時規律 | 残す(YAGNI/rule of three) |
| 設計方針(DDD) | ~15 | **2 領域別 → skill 候補(一部 3)** | `ddd-layering`。境界は lint 強制(① A2)= 3 の側面もあるが「なぜ層分けか」は skill |
| コーディング規約 | ~4 | **3 機械強制の重複(一部)** | flat ESLint files glob escape / import 順 = lint 領域(① A)。命名規約は残す |
| テスト方針 | ~4 | **2 領域別 → skill 候補** | `testing-recallmint`(Vitest/Playwright/iso/Stripe test header) |
| デプロイ前チェック | ~8 | 1 常時規律 | 残す(checklist) |

- **skill 切り出し候補(分類 2)**: `stripe-billing` / `clerk-auth` / `ai-gemini-ocr` / `codex-review-flow` / `writing-plans-recallmint` / `ddd-layering` / `testing-recallmint`。
- **機械強制の重複(分類 3)**: Tag と hook(check-review.sh)/ Sprint 完了 gate の判定ロジック(gate script)/ コーディング規約の ESLint glob・import 境界(eslint.config)。→ skill/CLAUDE に**ルール本体を書かず**、起動義務(gate は人手 trigger)だけ残す。
- **陳腐化(分類 4)**: 明確な陳腐化は**検出せず**(audit gate 段落は commit 3620884 で wrapper 化更新済 = ① 確認済)。

---

## 6. 腐りやすい記述の一覧(living doc のアンチドリフト観点)

| doc | 記述 | 種別 | 所見 |
|---|---|---|---|
| 02-tech-spec.md | データモデル §2 の列/表の網羅記述(1737L) | 実装転写 | schema.ts が正本 → **ポインタ置換 or 定期同期**。全消しは索引価値を失うため要判断 |
| idb-sync-comparison.md | §8「実装状況マトリクス」(充足/未充足の状態列) | 状態値 | 実装完了済 → **状態列はポインタ化**(設計根拠の対応表は残す) |
| dependency-audit-ledger.md | 「解消済」スナップショット表の件数(high 16 等) | 件数 | 履歴 record として受容(日付付き)→ **残す**(living 部と record 部が混在・分離は H-1 判断) |
| next-sprints-priority.md | 各 sprint status + 版番号(matrix v1.3) | 状態/版 | **doc ごと廃止(P2)** |
| architecture-guide.md | path 一覧 + 行数目安 + lib layout | 実装転写(全 stale) | **doc ごと廃止(P1)** |
| todo-v47 | §1 gate 数値(test 3781 / iso 143) | 件数 | dated snapshot ゆえ record として受容 → **残す**(移管は P6) |
| recallmint-billing-reference.md | 価格(¥680 等)・列一覧 | 数値/実装転写 | **統合先(tech-spec §6)で正本一元化(P3)** |

- 原則(② で確立): 数値・件数・実装手順・版番号は living doc に書かない。**record(日付 snapshot)は件数を持ってよい**(その時点の記録ゆえ)。区別が H-1 の分離基準。

---

## 7. ② 未確認 3 点の結果(E・closure)

1. **E1 レンダリング方針(ISR/SSG 不使用)の理由** → **記録なし で確定**。`docs/02-tech-spec.md`(§9 非機能・§14 PWA を含む全 14 章)は ISR/dynamic/revalidate を**論じていない**(grep ヒットせず)。ヒットは architecture-guide(廃止候補)+ 各 audit の incidental 言及のみで、「全 dynamic を選ぶ / ISR を使わない + 理由」の decision 行はどこにも無い。→ ② の「暗黙」確定。H-1 で architecture.md に決定化する対象。
2. **テストユーザー台帳の canonical doc** → **不在 で確定**。「テストユーザー台帳」ヒットは ②doc(自己)のみ。実際の test user(`test1` 等)は smoke session doc(grid/notion smoke 群)+ memory `reference_stg` に散在。→ ops 受け皿新設が必要(§8)。
3. **画像 cross-user dedup 永久除外(one-way door)** → **記録なし で確定(そもそも未実装)**。image-gc spec(`2026-07-13-image-gc-normalized-refs-design.md`)は **「dedup 据え置き・refs は many-to-many で dedup 布石のみ」** と明示 = **dedup は現状未実装**。「永久除外の one-way door」という不変条件は存在せず、② の recollection は「dedup 布石(many-to-many)」を指していた可能性が高い。→ ②「未確認」を「該当機能未実装ゆえ記録なし」で closure。

---

## 8. 運用情報の受け皿(todo 移管の下準備・内容は書かない)

### docs/ops が現在カバーする運用カテゴリ

- **RLS stg 反映**(適用順序 / 適用後確認 SQL / rollback / CC smoke / after 性能 / pooler 検証)= `rls-p2-stg-runbook.md`
- **Stripe Test Clock 検証**(責務分担 / provisioning / 実行 subcommand)= `stripe-test-clock-verify-runbook.md`
- **Webhook 運用**(endpoint 一覧 / 監視 URL / stuck 検知 / 手動 retry / incident checklist)= `webhook-runbook.md`

### 移管予定カテゴリ × 受け皿の有無

| カテゴリ | 受け皿 | 判定 |
|---|---|---|
| 接続 / env 使い分け(APP/ADMIN/ポート/適用順序) | 散在(architecture-guide §5.1[stale] / .env.example / rls-runbook §1 / tech-spec §10) | **新規 file 必要**(`ops/connections-and-env.md`) |
| seed / GC / script 実行手順 | 部分(audit/2026-07-16-gc-reconciler-smoke4-procedure[record] / audit/2026-07-16-seed-perf-exam-reseed-procedure[record])= living ops なし | **新規 file 必要**(`ops/scripts-runbook.md`・audit の record から手順を昇格) |
| テストユーザー台帳 | なし(§7-2 確定) | **新規 file 必要**(`ops/test-accounts.md`) |
| stg / prod 環境識別 | 部分(reference_stg memory / rls-runbook / webhook-runbook §1) | **新規 or 集約**(`ops/environments.md`) |
| rollback 手順 | 部分(rls-runbook §3 は RLS 限定)・汎用なし | **領域別は runbook 内・汎用索引は新規要**(environments.md に集約可) |

→ **5 カテゴリ中 3 が受け皿ゼロ**(接続/env・script 手順・test-user)、2 が部分。H-1 で ops/ に新規 file 群を用意する下地。

---

## 9. 矛盾・要 OT 判断

### ① ② から継承(再掲 + ③ での追記)

- **uuid override 形骸化の疑い**(①§5): ③ で追加確認なし。要 OT 継続。
- **matrix v2 doc の「CLAUDE.md stale」注記が取り残し**(①§5): CLAUDE.md は wrapper 更新済(3620884)。③ でも CLAUDE.md audit gate 段落に陳腐化なしを再確認(§5 分類 4)。matrix v2 doc の当該注記クローズ相当。要 OT。

### ③ で新たに見つかった矛盾

- **architecture-guide.md が MISSING doc 3 件を参照**(P1 の裏付け): `docs/TODO.md` / `docs/cache-fix-roadmap.md` / `docs/superpowers/notes` は**いずれも不在**。§8 References が broken link。陳腐化の動かぬ証拠。
- **architecture-guide.md の pivot 前 path**: `words/`/`review/`/`quiz/`/`lib/gemini.ts`/`lib/fsrs.ts`/`lib/db/streak.ts`/`deletion_failures` 表 / Neon serverless = いずれも現存せず(MCQ pivot + Supabase 移行 + integration_failures 吸収で消滅)。
- **setup-notes.md の watchOptions が現 next.config.ts に不在**: `watchOptions.ignored: ['**/.playwright-mcp/**']` は現 `next.config.ts` に無い(`.gitignore` で除外する現運用に移行)。stale advice。
- **next-sprints-priority.md / todo-v47 が MISSING doc(cache-fix-roadmap.md)を参照**: roadmap 母艦が不在。両 roadmap doc の stale 補強。
- **E3 の ② recollection 訂正**: ② の「cross-user dedup 永久除外(one-way door)」は実在せず、image-gc spec の「dedup 据え置き(未実装)・many-to-many 布石」が実態。② の未確認を機能未実装で closure。

### 要 OT 判断

1. **architecture-guide.md の「Phase 2 nextjs-saas-template 抽出」は現 OT 目標か**(P1 の廃止 vs archive を決める・別 repo `Kohkiota/devcontainer-template` へ移す選択肢もあり)。
2. **recallmint-billing-reference.md を 02-tech-spec §6 に統合 vs 廃止**(P3・内容突合が要る)。
3. **todo-v47 / next-sprints の backlog を claude.ai 側 todo に一本化するか**(repo に roadmap mirror を残すか)。

### 未確認のまま残すもの

- 大 dir(codex 310 / sessions 181 / plans 94 / specs 68 等)の**個別 file の被参照・陳腐化は全数確認していない**(規約単位で record 分類・整理対象外ゆえ許容)。個別廃止候補が埋もれている可能性は残る(H-1 で必要なら深掘り)。
- 02-tech-spec.md §2-14 の**各記述が現行実装と全数一致するか**は未検証(living 維持・staleness-prone とだけ記録)。

---

## 完了範囲

**A(分類)→ §3(提案リスト)→ §4(対応表)を最優先で完了**、D(CLAUDE.md 分類)/ E(未確認 closure)/ F(受け皿)/ B(腐りやすい記述)も完了。大 dir は規約単位分類 + 例外個別(全数個別分類はしていない = 規約で足りるため意図的)。未確認は §9 の 2 点(大 dir 個別 / tech-spec 全数一致)を明示。H-1 の直接入力 = §3 提案 8 件 + §4 重複 5 件 + §8 受け皿 3 新規。
