# Y-2 T-B3 #1b commit 2 — code review raw findings

- **作成日**: 2026-06-13
- **対象 (review 時点 = working tree、 base = `4a0704d`)**: bulk route 並列化本体 (`Promise.allSettled` + serialFallback 分岐 + 結果集約 Map → 入力順 正規化 + `assertSequentialPath` 配置 + envelope zod mutation_id 重複検出 + route test 拡張 5 case 8 subtests)
- **review 経路**: `superpowers:requesting-code-review` skill canonical (template 改変なし、 general-purpose subagent)

---

## Strengths (raw)

- **Plan / spec / step 0 doc alignment is exact (案 X 採用 / 4 件 cascade)**. `route.ts:235-308` の二分岐は step 0 §3 (serialFallback → 全体 serial fallback、 非 cascade → group 並列) と 1:1 で対応。 case (b) の subtest 4 件 で `card.create` / `card.delete` / `tag_category.delete` / `tag_option.delete` を網羅し、 step 0 §0 「drift 防止 (4 件前提)」 が route 層でも物理的に gate されている。
- **R7 (mutation_id 重複の race) を入口で殺す位置にある**: `route.ts:77-90` の `superRefine` は payload zod の中で実行され、 `parsed.success` failure path で route 並列化に到達する前に 400 reject される。 step 0 §4.4 の趣旨どおり「並列化で初めて race 化する経路を入口で塞ぐ」 を構造的に達成。
- **R8 不変性が test (e) で並列化前後 invariant として pin されている**: `route.test.ts:1227-1262` は (1) `state.getDbError` で envelope-level throw、 (2) `loggerWarnCalls.length === 0` で内側 group catch に吸われていないこと、 (3) `loggerErrorCalls[0].event === 'entity_mutations.bulk.envelope_failed'` で外側 catch が拾うこと、 (4) `Promise.allSettled` 不発火で group 段以降に到達していないこと、 を 1 test で 4 観点まとめて pin。 503 + Retry-After:30 も合わせて check されている。
- **`assertSequentialPath(group, 'serial')` の配置が dev-time invariant として正しい**: `route.ts:279` で group 内 for-of の直前に `'serial'` 固定で呼ぶ。 helper 実装 (`group-mutations-by-entity-key.ts:80`) が `executionMode === 'parallel' && length > 1` でのみ throw するため、 通常 path で no-op、 将来「`'serial'` → `'parallel'` 誤改造」 のみ throw で gate される設計が成立。
- **mutation_id 重複検出の error code 分離が caller 識別可能**: `route.ts:200-208` で `parsed.error.issues.some(...message === DUPLICATE_MUTATION_ID_CODE)` を先に check → 400 `{ error: 'duplicate_mutation_id' }`、 それ以外は既存 `{ error: 'invalid_payload', issues }` 経路を維持。 既存 `issues` 配列を壊さず、 client 側で原因切り分け可能。 test (c) で body 固定値 + `Retry-After: null` + handler 未発火 + log INSERT 未発火を pin。
- **wire format が完全不変**: 並列 path の `route.ts:300-307` で `mutations` を入力順 iterate して `failed[]` を再構築するため、 並列化前後で同 input → 同 output (mutation_id 順 = 入力順)、 `{ ok, applied, failed }` / 200 / 503 / 400 / Retry-After 全て既存挙動。 既存 37 件 + 新規 8 件 = 45 件全 pass (本 raw 保存時点では Minor 1 fix で +1 case 追加し計 46 件 pass)。
- **コメント密度が「なぜ」 に絞られている**: 設計判断のみ。 CLAUDE.md コーディング規約に沿う。
- **検証: typecheck exit 0 / lint --max-warnings=0 exit 0 / 45 route tests 全 pass**。

## Issues (raw)

### Critical (Must Fix)
なし。

### Important (Should Fix)
なし。

### Minor (Nice to Have)

1. **`route.ts:274-297` `Promise.allSettled` の rejection 経路は実装上「fail-silent」 になりうる**:
   - 内側 try/catch は `processMutation` を囲っているが、 `assertSequentialPath` / `logger.warn` / `serializeDbError` が万一 throw した場合、 `Promise.allSettled` が rejection を吸収 → `resultByMutationId` に値が入らない → 入力順 iterate 時に「skipped」 と同視 = silent lost write になる。
   - 実用上の発火条件は薄い (`assertSequentialPath` は 'serial' 固定で no-op、 `logger.warn` / `serializeDbError` は throw しない)。 production で発火する経路はない。
   - ただし「commit 2 が並列化と同時に R8 不変性を pin する」 という意図に対し、 self-guard が 1 段 deep に組まれていない (= group 並列 path の async function 本体全体を try/catch で囲んでいない) のは設計の隙間。 修正案: async body 全体を try/catch で囲み、 catch 内で `group_failed` log + 当該 group 内 mutation を全件 `failed` に積む。 R8 test に group async body throw 時の挙動を 1 case 追加すると pin できる。
   - 必須ではない (現状コードで実際に経路が成立しない) ため Minor 分類だが、 step 0 §5 表で R8 を「mock 検出可」 と判定した整合性を保つには、 fail-silent 経路を構造的に閉じる方が安全。

2. **`route.test.ts:1066` `vi.spyOn(Promise, 'allSettled')` は global spy、 mock cleanup が test 内 `mockRestore` のみ**:
   - 各 test 末尾で `allSettledSpy.mockRestore()` を呼ぶ慣習は良いが、 仮に test 中で throw すると `mockRestore` がスキップされる。 副作用が次の test に漏れる。
   - 修正案: `afterEach(() => vi.restoreAllMocks())` を describe 内で配置するか、 spy 取得を `try { ... } finally { allSettledSpy.mockRestore() }` で囲む。
   - 既存 `beforeEach` の `vi.clearAllMocks()` は spy implementation を restore しないため fail-safe ではない。

3. **`route.ts:201` `parsed.error.issues.some(issue => issue.message === DUPLICATE_MUTATION_ID_CODE)` の string-match dependency**:
   - `code: 'custom'` も同時に check すれば、 将来 zod が同 `message` フィールドの自動翻訳/書換を導入した時の regression 余地を 1 段下げられる。
   - 必須ではない (zod v4 で `superRefine` の issue は呼出側指定をそのまま渡す挙動)。

4. **test (a) の wire 順序 (`response.failed` が空) の assertion は applied 数のみで pin、 入力順正規化を直接 check していない**:
   - failed が 0 件なので順序は意味を持たないが、 test 名「入力順保持」 は applied 数の確認では弱い。 1 件失敗パターンで failed[] の順序を assert すると意図と一致する。

5. **`route.ts:269` `Map<string, 'applied' | 'skipped' | 'failed'>` の値型**:
   - 集計では `'skipped'` の場合 push しないため、 Map に `'skipped'` を保持する必然性はない。 Map に格納するのは `'applied' | 'failed'` のみ、 入力順 iterate 時に `get(mutation_id)` が undefined なら skipped 扱い、 という簡略化が可能。
   - ただし「`'skipped'` 経路の存在を Map 値型で明示する」 という ドキュメンタブル価値 もある (現状は意図的)。 軽微。

## Recommendations (raw)

1. **(Minor 1 の補強)**: 並列 path の async function 本体を `try/catch` で囲む構造を commit 3 (smoke) 前に追加すると、 step 0 §5 R8 risk を構造的にも mock 検出可に格上げできる。 R8 test に「group async body が throw した時に該当 group の mutations が全件 `failed[]` に積まれる」 を 1 case 追加すると pin できる。
2. **commit 3 (smoke) で確認すべき項目の再確認**: step 0 §5.2 指標 1 (10 独立 key 並列 wall-clock) / 2 (5 連発 pool 上限) / 3 (cascade serial 倒れ wall-clock) / 4 (card.create 多数 serial wall-clock) は本 commit でカバー外。 driver / pooler 層は T-B2 教訓どおり mock 検出不能のため、 smoke で必須確認。
3. **mutation_id 重複 + 他 invalid 同時混在 case の test 案 (Minor 3 の補完)**: 例えば「同 mutation_id 2 件 + 1 件 invalid_payload」 入力 → 現状 `isDuplicate=true` で `{ error: 'duplicate_mutation_id' }` を優先返却。 これが意図動作かどうかを test で固定すると、 将来「priority 並べ替え」 regression を gate できる。

## Assessment (raw)

**Ready to merge (= commit して T-B3 commit 3 (smoke) へ進める準備が整ったか)?** **Yes**

**Reasoning**: plan / spec / step 0 doc の要件 (案 X / 4 件 cascade / mutation_id 重複検出 400 / R8 不変性 / wire format 不変) を全て満たし、 case (a)-(e) の 8 subtests + 既存 37 件 = 45 件全 pass、 typecheck + lint --max-warnings=0 共に exit 0。 Minor 1 件 (並列 path async 本体の自己 catch 欠如による fail-silent 余地) は現状コードで発火経路が成立しないため commit 2 として進めて問題なし、 commit 3 smoke の wall-clock + pool 上限確認で driver / pooler 層の最終 gate を踏める段階に到達している。

---

## CC 判断 (= raw findings に対する dispatcher 側の方針、 commit 直前)

- **Minor 1 (R8 fail-silent 防御) = 実装で吸収**: Y-2 最大リスク task の中核 invariant 強化、 review が修正案を具体提示済、 scope 内追加コスト小。 並列 path async body に外側 try/catch + `group_failed` log + 当該 group 全 mutation を `failed[]` に積む補完 logic を `route.ts:274-308` に追加。 test (f) (= `T-B3 (f): group async body 内 logger.warn が throw → group-level fatal で全 mutation を failed[] に積む`) を `route.test.ts` 末尾に追加し、 (i) handler を 1 回 throw / (ii) logger.warn を 1 回 throw / (iii) 1 mutation 1 group の並列 path で group-level catch が発火 / (iv) `group_failed` log + `failed[]` に mutation_id が必ず積まれる / (v) `Promise.allSettled` 1 回呼出を pin。 route test 計 46 件 pass。
- **Minor 2 (afterEach restoreAllMocks) = 実装で吸収**: `route.test.ts` に `afterEach(() => vi.restoreAllMocks())` を追加 (既存 `mockRestore` per-test 慣習との二重防御)。 既存 spy 解放を fail-safe 化。
- **Minor 3 (issue.code === 'custom' AND condition) = 記録のみ**: 現状 zod v4 挙動で経路成立せず、 fix 不要。 raw 保存のみ。
- **Minor 4 (test (a) の failed 順序 assertion) = 記録のみ**: 入力順正規化 logic は実装上自明、 fix 不要。
- **Minor 5 (Map 値型 simpler 案) = 記録のみ**: 現状の `'skipped'` 明示は意図的ドキュメンタブル価値あり、 fix 不要。
- **Recommendation 1 = Minor 1 と同義、 実装で吸収済**。
- **Recommendation 2 = commit 3 smoke 計画として step 0 §5.2 で既に反映済**。
- **Recommendation 3 = 記録のみ**: priority 順序の意味確認は将来 case として可、 本 commit では scope 外。

verification (Minor 1+2 fix 後): `pnpm test` 2072 件 pass、 `pnpm typecheck` exit 0、 `pnpm lint --max-warnings=0` exit 0。 route test は 45 → 46 件、 whole-repo は 2071 → 2072 件 (Minor 1 で test (f) 追加分)。

[reviewed] tag を commit 2 に付与して commit する。
