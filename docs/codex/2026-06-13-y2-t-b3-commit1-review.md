# Y-2 T-B3 #1b commit 1 — code review raw findings

- **作成日**: 2026-06-13
- **対象 commit (review 時点 = working tree、 base = `857940773bcec19772357de3f0f27c200369b3f6`)**: helper + registry cascade flag (4 件) + helper test 4 case + registry test 9 件 enumerate + bulk route schema import 置換
- **review 経路**: `superpowers:requesting-code-review` skill canonical (template 改変なし、 general-purpose subagent)
- **保存意図**: OT 規律 (Codex / code-review raw findings は `docs/codex/` 配下に永続化)

---

## Strengths (raw)

- **drift 防止が物理的に保証されている**: registry test の 9 件 enumerate (3 entity × 3 op、 expected map 駆動) は新 op 追加時の flag 立て忘れを test 失敗で即検知する構造で、 step 0 doc §0 / §6 が要求する「4 件前提」 を test レベルで pin している。 `expected` の 4 件 true / 5 件 false 内訳も §1.2 表と完全一致 (`card.create=true` / `card.delete=true` / `tag_category.delete=true` / `tag_option.delete=true`)。
- **案 X の単純さがコードで維持されている**: helper 本体 (40-65 行) は素朴な single-pass loop で、 「cascade-like 1 件でも → 全体 fallback」 を 1 つの bool 変数で表現。 過剰抽象 (setdefault helper / class) を作っていない。
- **helper 純関数化が成功している**: registry を引数で渡す signature (§4.5 と一致)、 `'server-only'` import は付与しているが、 `lib/sync/shared/parsed-mutation.ts` は server-only を付けず client/test 再利用可能の慣習を保持 (`mutation-schemas.ts` precedent と一貫)。
- **self-guard `assertSequentialPath` の export 設計が妥当**: `executionMode === 'parallel' && length > 1` でのみ throw、 serial / 単一 は no-op で false positive を避ける。 plan 完了条件 3 番目を直接満たす最小 surface。
- **route.ts の本 commit 差分が純粋 import 置換**: `mutationSchema` → `parsedMutationSchema` の import 置換のみで logic 不変 (route 並列化は commit 2)、 既存 37 件 bulk route test が無改変で pass。 「機能的 regression なし、 helper は dead code 状態」 のコミット境界宣言と整合。
- **コメントが「なぜ」 のみ**: 各 file 冒頭が設計判断 (案 X / §1.2 4 件 / §4.5 signature) と precedent 参照に絞られ、 機械的な「何をするか」 説明は不在。 CLAUDE.md コーディング規約に沿う。
- **module 分割の境界が明文化**: `parsed-mutation.ts` ヘッダコメントで「bulk-payload envelope (metadata 含) vs `entityMutationEnvelopeSchema` (patch narrowing 用 discriminated union)」 の用途差を明示、 drift 防止策を file 名で表現。 重複定義 / 紛らわしさなし。
- **検証 (lint / typecheck / 全 2063 tests / helper + registry 21 tests / bulk route 37 tests) 全 exit 0**。

## Issues (raw)

### Critical (Must Fix)
なし。

### Important (Should Fix)
なし。

### Minor (Nice to Have)

- **`lib/sync/server/group-mutations-by-entity-key.test.ts:217`** — case 4 cascade subtest の test 名 `${entity_type}.${op} を 1 件含む 11 件 mixed → serialFallback=true` は serialFallback だけ確認しており、 group 集約結果 (= `groups.size === 11`、 各 array length 1) を assert していない。 step 0 §6 の case 4 文言 (`serialFallback: true`、 caller の serial path 倒れ確認) は満たす — group 構造の正しさは case 1/2 で別途 pin 済みなので過剰 assert は不要だが、 cascade fallback 時に `groups` も「最後まで組み立てる」 という helper 実装契約 (§4.5 注、 ヘッダコメント line 14-15) の test 表現があると、 将来「cascade で early return に最適化」 する誤改造を gate できる。 1 行 `expect(result.groups.size).toBe(11)` 追加程度の小修正。 必須ではない。
- **`lib/sync/server/group-mutations-by-entity-key.ts:81`** — `throw new Error('ordering violated')` の error message は spec §3.2 と一致しているが、 error class が plain Error。 logger 経路で stack trace 識別性を上げたい場合は subclass 化候補。 ただし本 invariant は production path で発火しない (test only) ため、 現状で問題なし。
- **`lib/sync/server/entity-mutation-registry.test.ts:38-60`** — describe block タイトル `cascadeLike flag (Y-2 T-B3 #1b)` に sprint 参照が入っているが、 既存 `entityMutationEnvelopeSchema — envelope reject` describe には sprint 参照なし。 整合のため sprint タグは file ヘッダコメントに集約し describe からは外す案もある (= test 名が時間で陳腐化しない)。 軽微。

## Recommendations (raw)

- **commit 2 で `lib/sync/server/group-mutations-by-entity-key.ts:80` の `length > 1` 条件をテストで stress 化**: 現在 case 3 は 2 件 group のみで確認、 commit 2 で route 側に組み込む時に「単一 mutation の独立 key を parallel で渡す」 path (= false positive 想定外) を route test レイヤでも踏ませると、 self-guard の境界条件 (length=1 は parallel OK) が route 結合でも pin される。
- **commit 2 着手前に step 0 §4.3 (pool size dashboard 確認) と §4.4 (mutation_id 重複 envelope zod 追加 = 400 `duplicate_mutation_id`) の 2 点が未着手**であることに注意。 本 commit 1 は前段準備として整合的で、 これらは commit 2 / smoke 段に持ち越して問題なし。 commit 2 の plan / brief に 2 点を明示しておくと良い。
- **将来「3 件 cascade」 drift 監視**: step 0 doc §0 の絶対則 (4 件前提) は registry test + helper case 4 で物理的に gate 済。 doc 側 (`docs/superpowers/sessions/2026-06-13-y2-t-b3-step0-design.md`) の §0 注意も既に更新済とのことなので追加対応不要。 review 規律として OK。

## Assessment (raw)

**Ready to merge (= commit して T-B3 commit 2 へ進める準備が整ったか)?** **Yes**

**Reasoning**: plan 完了条件 4 つ (helper test 4 case + registry 9 件 enumerate + 順序破壊 self-guard + cascade-like 4 件確定) を全て満たし、 lint / typecheck / 2063 tests 全 pass、 step 0 doc §0 「drift 防止」 (4 件 cascade-like) が registry test の enumerate で物理的に固定された。 本 commit 1 は route logic 不変 (= schema import 置換のみ) で機能的 regression なし、 helper は意図的 dead code として commit 2 まで wait する設計通り。 Critical / Important 共に 0、 commit 1 単体で [reviewed] 付与可。

---

## CC 判断 (raw findings に対する dispatcher 側の方針)

- Minor 3 件 = 記録のみ可、 commit 1 では fix しない (CLAUDE.md 結果分類 = Minor は記録可)。 必要に応じ commit 2 内で同時改善する余地はあるが、 本 commit の scope を膨らませない。
- Recommendations は commit 2 brief に明示反映する:
  1. route test での `length=1 parallel OK` の境界 pin
  2. step 0 §4.3 (pool size 確認 = OT 依頼中) と §4.4 (mutation_id 重複検出 = envelope zod 追加) を commit 2 内で実装
- [reviewed] tag を commit 1 に付与して commit する。
