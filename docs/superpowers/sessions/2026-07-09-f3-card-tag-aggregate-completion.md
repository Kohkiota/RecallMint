# F3 Card + Tag aggregate(薄い DDD)— 完了記録

- 日付: 2026-07-09 / branch `develop` / sprint base `530a544`(plan commit)→ HEAD `d134dd5`
- 方式: `superpowers:subagent-driven-development`(fresh Opus implementer per task・実装 subagent は commit せず controller が review 後 commit)
- spec `docs/superpowers/specs/2026-07-09-f3-card-tag-aggregate-design.md`(c2b3bd1)/ plan `docs/superpowers/plans/2026-07-09-f3-card-tag-aggregate.md`(530a544)
- **結果: W(挙動変更)無し = G→R で完結。全 code/config commit [reviewed]。whole-branch review = Ready to merge(Crit0/Imp0)。push + stg smoke は OT。**

---

## commit 一覧(base 530a544..HEAD・13 commit)

| commit | 内容 | review |
|---|---|---|
| `4867ee2` | test(cards): G golden 先張り(G1-G5・14 本) | canonical Opus 0/0/1(Minor record) |
| `5992273` | refactor(cards): R1 card-rules domain 抽出(additive) | canonical Sonnet 0/0/0 |
| `d5b6f18` | refactor(cards): R2 card-rules 配線 + card-write 縮退 | canonical Opus 0/0/0 + Codex 0/0/0 |
| `4993ed0` | docs(codex): R2 artifact | — |
| `5f3a3b8` | refactor(cards): R3 field bounds を validation/card 集約 | canonical Opus 0/0/0 + Codex 0/0/0 |
| `5ccd6b3` | docs(codex): R3 artifact | — |
| `c6ae471` | test(cards): **prep** — G2 create を §3.5 準拠の値 pin に整合 | canonical Opus(adversarial)0/0/2(Minor record) |
| `69f9e7c` | refactor(cards): R4 card_count ±N helper 集約 | canonical Opus 0/0/0 + Codex 0/0/0 |
| `7bf1a92` | docs(codex): R4 artifact | — |
| `a9aa805` | refactor(tags): R5 tag-values + card-tag-constraint 新設(additive) | canonical Sonnet 0/0/0 |
| `37da2d2` | refactor(cards): R6 A-1 single 制約判定を domain 配線 | canonical Opus 0/0/0 + Codex 0/0/0 |
| `dc96c28` | docs(codex): R6 artifact | — |
| `d134dd5` | chore(lint): R7 domain import 境界 enforce(cards+tags) | canonical Sonnet 0/0/1(Minor info) |

risk task(R2/R3/R4/R6 = 配線置換)= canonical + Codex 二重。additive/lint(R1/R5/R7)+ G/prep = canonical。全 [reviewed]。

## 成果物

- **新設 domain**: `lib/cards/domain/card-rules.ts`(deriveCorrectAnswerIds / NULLABLE_TEXT_FIELDS / normalizeNullableTextField)/ `lib/cards/domain/card-tag-constraint.ts`(hasSingleCategoryOverflow)/ `lib/tags/domain/tag-values.ts`(SelectType VO)。
- **新設 infra**: `lib/cards/card-count.ts`(bumpExamCardCount ±N helper・3 site 集約)。
- **拡張**: `lib/validation/card.ts`(6 field bounds schema 集約 = mutation-schemas ⇄ card-field-handlers の single source)。
- **縮退**: `lib/cards/card-write.ts`(3 symbol 削除・buildNewCardMutationPatch のみ残置・re-export shim なし)。
- **lint**: eslint.config.mjs に cards/domain + tags/domain 純度 block(type-only cross-domain 強制)。

## 「薄い」の実体(F1/F2 との差分)

新 repository を作らず既存 apply-\*(DbExecutor seam)を維持。ルール定義だけ domain へ吸い上げ(dedup)+ VO(SelectType のみ)+ helper。Card/Tag は CRUD 系不変条件で state machine 無し = フル aggregate 儀式を回避(v37 保留への回答)。

## prep commit(`c6ae471`)の位置づけ(OT 承認・2 条件充足)

R4 の generic `bumpExamCardCount({delta})` は全 site を param 形(`card_count + $1`)に正規化する。これは spec §3.5 が先取り承認した param-binding。ところが G2 create 側 assertion が literal `'+ 1'` を pin していたため param 化で 1 assertion が赤になる状況を **R4 着手前に検出 → OT に上げて裁定**(仕様解釈揺れ + golden 赤の停止条件)。

- **OT 裁定 = 選択肢1(独立 prep commit で §3.5 準拠の値 pin に整合)+ 2 条件**: ① 独立 prep commit で分離(R4 と混ぜない)② 挙動不変の node 実測を本 doc に添付。
- **位置づけ = 「golden 修正して通す(挙動変更隠蔽)」ではない**。挙動は不変で、§3.5 が事前承認した param 化に対し G2:478 の観測粒度が literal 文字列で狭すぎた = plan 方針への golden 整合。canonical review(adversarial)が「非隠蔽・regression detector 健在(wrong col / GREATEST / 符号 / 増分値 全 catch)・非 vacuous」を独自再現で確認。whole-branch review も「create delta = hardcoded literal 1 ゆえ multi-digit 到達不能・挙動変更を許していない」と確認。

### node 実測(OT 条件2・literal ⇄ param 同値の客観証拠)

`PgDialect().sqlToQuery()` 実測(`.superpowers/sdd/g2-behavior-invariance.txt`):

```
create literal (現)   SQL= "exams"."card_count" + 1    params= []
create param  (R4)   SQL= "exams"."card_count" + $1   params= [1]   → $1 に 1 bind = card_count+1(同値)
OCR param (現/R4)     SQL= "exams"."card_count" + $1   params= [3]   (現 OCR と R4 で不変)
delete literal (現)   SQL= GREATEST("exams"."card_count" - 1, 0)   params= []
delete param  (R4)   SQL= GREATEST("exams"."card_count" + $1, 0)  params= [-1]  → card_count-1(同値)
```

literal 形と param 形は SQL render のみ異なり bind 後の計算は同一。divergence checklist(zod path/message/WHERE/updatedAt/wire/tombstone/skipLog)非該当。挙動変更ゼロ。

## client diff 実証(spec §8-4)

**client-UI runtime の変更 = 参照事実 E の範囲(全て挙動不変)**:
- `session-runner.tsx`(:206 call-site 置換 = deriveCorrectAnswerIds・byte-equivalent)/ `use-card-options.ts`(:14 import rewire)/ `inline-text-field.tsx`(:34 import rewire)/ `card-write.ts`(縮退・lib/cards)。
- 旧シンボル(deriveCorrectAnswerIds / normalizeNullableTextField / NULLABLE_TEXT_FIELDS)の `@/lib/cards/card-write` import 残存 = **ゼロ**(rg 確認)。`@/lib/cards/card-write` の残 importer = `inline-card-list.tsx:22`(buildNewCardMutationPatch)のみ = 意図どおり。

**精度注記**: `git diff 530a544..HEAD -- app/ lib/sync/ lib/client-db.ts` は 6 file を示すが、client-UI runtime は上記 3 file のみ。残り 3 は **client-UI でない**: `upload-persistence.ts`(OCR **server action**・R4 card_count helper 配線)/ `mutation-schemas.ts`(**shared wire**・lib/sync/shared・R3 bounds import rewire・byte-equivalent)/ `upload-persistence.test.ts`(G1 golden・test)。全て各 task review 済の server/shared/test 変更で client 挙動に影響なし。

## whole-repo gate(完了条件)

- `pnpm lint --max-warnings=0` exit 0 ✓ / `pnpm typecheck` exit 0 ✓ / `pnpm test` **209 files / 3172 tests pass** ✓ / `pnpm build` exit 0 ✓。
- **whole-repo lint exit 0 確認済**。
- domain 純度 lint(R7)= 独自 prove-red(runtime import → no-restricted-imports 発火)+ type-only import 許可を canonical review が再現確認。

## whole-branch review(最終・code-reviewer.md canonical・Opus)

**Ready to merge? Yes**(Critical 0 / Important 0 / Minor 2 非 blocking)。behavior preservation = verbatim 抽出 + 符号忠実な SQL 集約 + OCR trust boundary 保持 + 全 R commit golden/snapshot drift ゼロで substantiate。prep golden 整合 = genuinely behavior-invariant(挙動変更を許していない)。

### 記録のみ Minor(全て非 blocking・triage 済)

1. G: tag apply test の coarse SELECT fake は store-shape 依存(characterization tradeoff・G3/G4/G5 が exact 行 seed で branch 到達担保)。
2. prep: G2 値 pin の literal branch `staticText.includes('1')` は multi-digit `+ 11` 理論余地 → **create delta = hardcoded literal 1 ゆえ到達不能・param path は digit-exact**。
3. R7: cards/domain の `@/lib/tags/domain` deny が barrel `paths` + `patterns` group の重複 superset(patterns が実働・paths は future-proof dead superset)。

将来 lint cleanup で R7 の redundant `paths` を畳んでよい(merge gate にしない)。

## stg smoke 申し送り(push 後 OT 指示で CC が DevTools MCP 実走・非退行のみ)

**W 無しゆえ OT 実機必須項目なし。全て CC DevTools で撃てる非退行確認**:
1. card CRUD(create / options 正解変更 / 空文字クリア→null / delete)と一覧 card_count 表示整合。
2. OCR upload → card_count 加算(+N helper 実 DB 経路)。
3. tag CRUD + single カテゴリ toggle 入れ替え + category 削除の mirror 反映(tombstone 経路)+ **category delete 後に card 側 tag 割当が残らない**(実 FK CASCADE = card_tags 連動消滅の実 DB 確認・G5 の unit 不能面)。

## stg smoke 結果(2026-07-09・push 後・CC DevTools 実走 = Playwright MCP・実 DB/driver)

対象 = stg.recallmint.nekotest.net(test account・baseline 6 exams / 426 cards / 7 cat / 28 opt / 793 card_tags)。反映確認: /app 正常・認証済。**F3 = 挙動不変 refactor ゆえ DOM marker なし** → deploy-identity は OT push + 実 driver 挙動の整合で担保(下記 real-driver 全通過 = F3 反映と整合)。**console: 全経路 0 errors**(1 warning = Clerk dev-keys の環境 warning・F3 前の初回 load から常在・無害)。検証 = client Dexie mirror(pull 済 server 状態を反映)+ **強制 full re-pull(cursor reset)で server 側物理削除を実証**。

| # | 項目 | 結果 | 実測(real DB/driver) |
|---|---|---|---|
| 1 | card CRUD + card_count 整合 | **PASS** | 新規 exam「F3-smoke」に card ×2 追加 → flush(2× POST entity-mutations/bulk 200)→ pull → **card_count=2**(R4 helper server +1/+1)。option 正解 flag 変更 → mirror **correct_answer_ids=['1']**(server handleOptions 再導出・R2)。memo set→空文字クリア → mirror **memo=null**(空→null 正規化・R2)。card 1 件削除 → pull → **card_count=1**(R4 helper -1 GREATEST)・削除 card 消滅。card_count === 実 card 数 常時一致・一覧「カード N 件」表示整合。 |
| 2 | OCR upload → card_count +N | **OT へ委譲**(未実行) | card_count +N は item 1 で実証済の同一 `bumpExamCardCount` helper(+1/-1)を delta=N で呼ぶだけ・OCR 固有配線(upload-persistence delta=cardRows.length)は G1 golden で pin。実 OCR は 実 quiz document + Gemini quota 消費 + browser filesystem への file 配置(CC 環境制約)を要するため未実行。**推奨: OT が新規 exam に 1 回 OCR upload → card_count == 抽出枚数を確認**(end-to-end 望む場合)。helper-equivalence を採る場合は省略可。 |
| 3 | tag CRUD + single toggle + FK CASCADE | **PASS(server 確定)** | single-select category「F3cat」+ opt optA/optB 作成・card #1 付与。**single toggle 入れ替え**: optB 付与で optA 自動除去(badge「F3cat: optB」・radio・mirror card1 card_tags=[optB])= whole-set {optB} が server R6 `hasSingleCategoryOverflow` を通過。**category 削除 FK CASCADE**: F3cat 削除(impact dialog「option 2 件・card 1 件」正確)→ flush POST 200 → mirror で F3cat/optA/optB/card1-card_tags 全消滅。**確定検証 = cursor を epoch に reset して強制 full re-pull → server は baseline 793 card_tags を返し F3cat/optA/optB/card1-card_tag をどこにも再導入せず** → **server FK-CASCADE が tag_category + tag_options + card_tags を物理削除**(client optimistic でなく server 側・spec §5 の unit fake 不能面)。 |

**総括**: CC 実行可能な item 1 / 3 = **PASS**(item 3 は server 物理削除まで確定)。item 2(OCR +N)= 同一 helper 実証済ゆえ OT 委譲(実行望む場合)。挙動不変 = 維持確認。**残置**: throwaway exam「F3-smoke」(card 1 件・memo=null・tag なし)を test account に残置(OT が削除可)。cursor reset は current に再 pull 済(mirror 整合・データ欠損なし)。**prod 反映判断 = OT**。

## 参照

- fact-finding: `docs/audit/2026-07-09-f3-factfinding.md`(42b1ef4)
- spec: `docs/superpowers/specs/2026-07-09-f3-card-tag-aggregate-design.md`(c2b3bd1)
- plan: `docs/superpowers/plans/2026-07-09-f3-card-tag-aggregate.md`(530a544)
- Codex artifacts: `docs/codex/2026-07-09-f3-r{2,3,4,6}-*.md`
- node 実測 raw: `.superpowers/sdd/g2-behavior-invariance.txt`(git-ignored scratch)
