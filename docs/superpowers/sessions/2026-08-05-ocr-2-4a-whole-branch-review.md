# ②-4a whole-branch review(sprint 完了 gate・2026-08-05)

対象範囲 = `49c20db..HEAD`(②-3.5 完了直後〜 T16-b。T1〜T14a / cutover / T14b′ / S-0 / S-1〜S-5 + I-3(b) / T16-a / T16-b)。
reviewer = canonical 経路(`superpowers:requesting-code-review` template 改変なし・general-purpose subagent・最強 model)。
per-task review 済みを前提に **task をまたいだ不整合**と「緑は守られているを意味しない」7 失敗形の同型を重点探索。
reviewer 側でも whole-repo lint を実走(exit 0)= 2 経路確認。

## 0. 着手前修正

spec §4.5(2026-07-30 spec)の「図版検出をスキップ」を「検出はされるが attach しない」の実体へ置換(`9accb67`)。
§9 / §5.4 と同じ理由(spec を読んだ人は spec を信じる)で注記でなく本文置換。

## 1. review 結果と採否

**Critical 0 / Important 3 / Minor 8 / Ready to merge: With fixes** → 3 Important 全対処・Minor は 3 件対処 / 5 件記録。

### Important(全て対処済)

| # | 指摘 | 対処 |
|---|---|---|
| I-1 | upload UI が PDF 対応を約束(「PDF はそのまま投入されます」は端的に虚偽)する一方、新 flow は submit で PDF を hard-reject。cutover diff が触らない面に残った cross-task seam | **fix `551f514` [reviewed]**: copy 3 箇所 + `accept="image/*"` の最小修正。PDF 機構(解析 / per-file 上限 / reject backstop)は ②-4b 向けに不変(accept は advisory ゆえ reject が実効防衛線)。scoped canonical = Ready / 0 / 0 / Minor 2(記録)+ Codex 1 周 clean(`docs/codex/2026-08-05-wb-i1-pdf-copy.md`) |
| I-2 | architecture 台帳 §6 が撤去済み機構(最小時間保持 + purge + GC 網・source_assets)を現行として教える | **docs `82f9984`**: 「R2 に置かない」へ置換(§5 台帳更新に統合・下記 §4) |
| I-3 | 2026-07-30 spec に置換 banner が無く、単独で読むと撤去済み機構(5 action 列 / manifest / retry)を現行と誤読する | **docs `33eb2f4`**: header の状態行を置換 banner 化。現行性の判定は新 spec §6「引き継ぐ不変条件」の列挙を正とする形 |

### Minor(3 対処 / 5 記録)

**対処(`8a1f2e3` chore・全てコメントのみ・ロジック不変)**:

- M-1 `source-image-verify.ts` 「GET で取得した元バイト」→ request body 受領(R2 GET は消滅)
- M-2 `derive-exam-statuses.ts` STALE_PROCESSING_MS 根拠(600s×1.5)→ 720s 時代の実関係へ。LEASE_TTL_MS と同値だが定義独立の旨明記
- M-4 takeover / re-claim / blocking 前提の stale comment 4 箇所(`crop-and-store.ts` / `gc-abandoned-operations.ts` ×2 / `upload-form.tsx`)を現行の脅威モデルへ

**記録のみ(follow-up 候補・優先順)**:

1. **M-3** `gc-abandoned-operations.ts` の terminate が共有不変条件(`terminalize-abandoned-operation.ts:11-15`: 同一 tx で doc failed 化 + lease NULL 化)から逸脱 — doc を failed 化せず lease も NULL 化しない。表示は reconciler が回収するため実害は「戻らないユーザーの doc が DB 上 processing のまま」。**整合させるか意図的逸脱として両 site 相互コメントに載せるかは次に本 script を触る時**(手動 sweep・主経路ではない)
2. **M-5** `attempt_count` が死に列化(writer = INSERT の定数 0 のみ)。migration 0032 コメントの「新経路も書くため残す」premise が現状虚偽 — increment を 1 行配線するか列を dormant と記録するか。**OT 判断**
3. **M-7** `UPLOAD_INTERRUPTED_NOTICE` が全 terminal class 共通で、`empty_cards` / decode 失敗にも「中断された可能性 / 再度お試し」を出す(同一入力の再試行は決定的に無駄 + Gemini 再課金)。spec 決定「②-4a は既存文言粒度」の範囲内 — **`last_error_code` 拡張時の最初の対象**
4. **M-8** publish finalize が completed で lease を NULL 化しない(terminal 各経路は NULL 化)。live 述語が非終端 status を要求するため挙動穴なし・spec §4.3 モデルとの非対称のみ
5. **M-6** `stage-prepared-payload.ts` / `stage-prepared-retry.ts` の file 名に撤去済み「stage」語彙(中身は再スコープ済)。legacy 撤去 follow-up task で rename

### 検出力残余(kickoff §2 の「個別変異させる価値がある箇所」・reviewer 提示 4 件を CC 再裁定)

| # | 箇所 | 裁定 |
|---|---|---|
| R-1 | `FenceStatus` の**広げる方向**の変異(`PRE_COMMIT_FENCE` → 全 status)は現 iso で red にならない見込み(狭める方向のみ pin 済)。S-2 M-6 の誤分類 regression が無音で再入可能 | **follow-up で pin 追加を推奨**(test-only 増 = red 実証 + 簡易 review 必要のため本 session では未実施) |
| R-2 | `publish-prepared-plan.ts` の `?? 'retryable'` default(map 不在 figure)に直接 unit なし — 現 pipeline は全 figure を事前充填するため到達しない防御分岐だが、fail-safe 方向が `exclude` へ反転しても検出されない | **follow-up で unit 1 本を推奨**(CC が test file を確認・retryable case は明示 map 経由のみと確認済) |
| R-3 | `validateFormData` の per-file → 合計の判定順が pin されていない疑い | **反証・不要**。boundary test は message まで assert(`'1 ファイルのサイズ上限'` / `'合計サイズは'`)しており、5MiB+1 の単一 file は合計上限も超えるため順序入替で確実に fail する(CC が現物確認) |
| R-4 | `route.ts` の `hasStale` が `rows`(DISTINCT ON)由来で `docRows` でない — 現状到達不能だが 3 段論法が unpinned | **コメント 1 行の保険のみ・follow-up 任意**(最低優先) |

## 2. 持ち越し 4 件の判断

1. **発火側の実機確認不能(T16-b)** → **証明の空白に記載した**(`82f9984`)。予期しない throw の台帳書込と EXIF≠1 検知を「UI から誘発できない 2 機構・iso の注入 test が唯一の証明」として 1 行に。解消条件(client 非経由の投入経路の出現)も記載。
2. **凍結 file の「保存済み payload」表現** → **修正した**(`8a1f2e3`)。凍結の目的は挙動と契約の安定でありコメント訂正は侵さない(T16-b canonical Minor-2 の follow-up を sprint close で実行)。`normalize-prepared.ts:49` の第 3 の同語(retry factory)も同時に発見・訂正。test 側はコメントのみ = 保証不変。
3. **`.default(0)` の sunset** → **トリガー付き follow-up で十分**。旧行の実値は機構不在ゆえ証明可能に 0 で `.default(0)` は恒久に真・runtime 寛容の残余リスクは drift pin が CI 面で塞ぐ。sunset は「必須に戻せる」であって「戻さねばならない」ではない。
4. **予算枯渇と orientation 以外の判定順** → **sweep 完了・追加の誤計上なし**。reviewer が crop loop / pipeline の順序・分類対を重点走査し、コード上の同型は 0。唯一の同型は文言レベルの M-7(全 terminal class 共通文言)で上記のとおり記録。

## 3. sprint 完了 gate(全て本 session 最終 commit 状態で実走)

| gate | 結果 |
|---|---|
| `pnpm lint --max-warnings=0` | **0**(whole-repo lint exit 0 確認済・reviewer 側でも独立に exit 0) |
| `pnpm typecheck` | **0** |
| `pnpm build` | **0** |
| `pnpm test` | **0** — 272 files / 4,428 tests |
| `pnpm test:iso` | **0** — 30 files / 316 tests(test:iso green 確認済) |
| `pnpm run audit` | **1** — 既知の prod high 3 件(fast-uri / ip-address / brace-expansion・kickoff で blocker 外)に加え、**dev 側に新規 3 件**: `undici@7.28.0`(GHSA-4cwx-7wf7-3272)/ `brace-expansion@5.0.8` / `@1.1.16`(GHSA-rgw5-rvv9-x895)いずれも allowlist 未登録。**依存は本 session 1 行も無変更** = 上流の新規公表。基線更新 sprint(別途)の対象に dev 3 件を追加 |

「pnpm run audit exit 0 確認済」は**宣言できない**(上記のとおり)。prod 3 件 + dev 3 件とも本 sprint 起因でないことは lockfile 無変更で確認。

## 4. 台帳更新(kickoff §5)

- **architecture.md §6**(`82f9984`): 「R2 に保持しない(最小時間 + purge)」→「**R2 に置かない**」へ置換。source_assets 表消滅・purge / GC source lane の保護対象ごと消滅・証明 = R2 非 import pin + PUT key pin・正本 = 2026-08-04 spec。
- **証明の空白**: 「source 消え残り」行は**元々存在せず**(sprint 中の追加は §6 / §8 / RLS の 3 行のみ)、§6 置換で purge/GC 網の記述ごと消滅。**追加** = 発火しない系 2 機構(予期しない throw 台帳書込 / EXIF≠1)の実機発火。
- **実環境 RLS 検証の起動が人手**: S-0(`c1b83d9`)追加の既存行(architecture 証明の空白 + harness §1)が kickoff の要求をそのまま満たすことを確認 — **変更なし**。harness.md の「drift test は local iso PG 固定 / verify-rls-state.ts が代替」も同行に既記載。
- **付随**: §10(検証失敗の隔離範囲)を「②-4 で実装予定」→「②-4a で実装済」へ(隔離 test 群 / result page 束提示 / drift pin を証明として記載)。

## 5. 規律記録

- 着手前宣言: phase = whole-branch review 指摘対応 / 方針 C(kickoff §6 が scope・完了条件・手段を事前指定)/ OT 承認 = kickoff で事前指定済み。
- I-1 fix の commit 直前宣言: 経路 = canonical(template 改変なし)+ Codex 独立 / 結果 = canonical 0/0/2(記録)・Codex 0/0/0 / Important 残しなし / [reviewed] 付与。
- SDD ledger: 本 session は subagent-driven-development 非使用(review dispatch のみ)のため ledger 不存在・削除対象なし。
- Codex read-only 担保: git clean detector PASS(pass 判定前に評価)。

## 6. 本 session の commit(全て未 push)

| commit | 種別 | 内容 |
|---|---|---|
| `9accb67` | docs [no-review] | 旧 spec §4.5 置換(着手前修正) |
| `33eb2f4` | docs [no-review] | 旧 spec 置換 banner(I-3) |
| `8a1f2e3` | chore [no-review] | stale comment 7 箇所整合(M-1/2/4 + 持ち越し②・保証不変) |
| `82f9984` | docs [no-review] | architecture 台帳更新(I-2 + 証明の空白 + §10) |
| `551f514` | fix [reviewed] | PDF copy 矛盾の解消(I-1) |
| `5859d26` | docs [no-review] | I-1 fix の Codex findings |
| (本 doc) | docs [no-review] | whole-branch review の恒久記録 |

## 7. prod 反映前に OT が知っておくべきこと

1. **機能・整合性・security の Critical / Important は 0**(修正後)。state machine・fencing・収束経路は端から端まで pin されていると reviewer が明示評価。
2. **audit の dev 新規 3 件**(§3)— 基線更新 sprint の scope に dev を含める判断が必要。
3. **I-1 fix(copy + accept)は stg smoke 未実施**(push 後の通常 smoke で「PDF 文言が消えている」ことを 1 目視すれば足りる)。
4. **follow-up 判断待ち**: M-5(attempt_count 死に列)/ M-3(sweep script の不変条件逸脱)/ R-1・R-2(検出力 pin 追加)/ M-6(rename)/ M-7(last_error_code 拡張時)。
5. migration 0032 の stg 適用が不可逆点である点は S-5 記録から不変(runbook §5)。
