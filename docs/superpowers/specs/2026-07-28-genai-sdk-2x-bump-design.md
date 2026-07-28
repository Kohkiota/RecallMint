# ②-1: @google/genai 1.50.1 → 2.x 版上げ 設計 (spec)

- 日付: 2026-07-28
- Sprint: ②-1(OCR track / ②-0 回帰検出基盤の直後)
- 種別: 依存 direct dependency の major 版上げ(proven pattern・単一源)
- モデル: Opus

## 1. 目的

本番 OCR が使う `@google/genai` SDK を `1.50.1` → 2.x 系最新(着手時実測で `2.13.0`)へ上げる。**それだけ**。②-0 で敷いた回帰検出機構(golden test / SDK 型契約 / capture-diff)が「版上げに対して実際に機能する」ことを本 sprint で実証するのが第二の目的。

## 2. 非目標(凍結・本 sprint で変えない)

変更源を 1 つに保つため、以下は一切変えない(SDK とモデルを同時に動かすと出力変化の原因切り分けが不能になる):

- モデル ID(`lib/ai/cost.ts` の `modelId()` は `gemini-2.5-flash` のまま)
- 本番 prompt(`lib/ai/prompts/ocr-extract.ts`)
- 本番 response schema(`lib/ai/schemas/ocr-response.ts`)
- OCR pipeline の挙動(`lib/ai/ocr.ts` の retry / fallback / 切替)

モデル移行は ②-2 で独立に行う。

## 3. 既知の事実(2026-07-28 実測・再調査不要)

②-0 kickoff の fact-finding を着手時の最新版で再確認した結果:

- **最新 2.x = `2.13.0`**(dist-tag `latest`)。
- **deps 完全一致**: 1.50.1 と 2.13.0 の dependencies は同一(`google-auth-library ^10.3.0` / `p-retry ^4.6.2` / `protobufjs ^7.5.4` / `ws ^8.18.0`)。**新規 transitive ゼロ**。
- **engines 不変**: 両版とも `node >=20.0.0`。
- **peer 不変**: 両版とも `@modelcontextprotocol/sdk ^1.25.2`(`peerDependenciesMeta.optional = true`)。MCP / interactions API は不使用ゆえ無関係。
- **build script の正体**: 2.13.0 の install-lifecycle script は `preinstall: echo 'preinstall: no-op'`(リテラル no-op)のみ。これが pnpm "Ignored build scripts" に載る唯一の候補。`prepare: node scripts/prepare.js` は **レジストリ tarball 依存では実行されない**(prepare は git / directory 依存 install 時のみ走る npm lifecycle)。1.50.1 は `scripts/` 非同梱 + `dist/**` を publish 済(実測: `node_modules/@google/genai/scripts/` 不在・`dist/` あり)。→ skip が正・`onlyBuiltDependencies` 追加不要。
- **使用 API surface**: `GoogleGenAI({apiKey})` / `models.generateContent` / `config.{responseMimeType, responseJsonSchema, abortSignal}` / `res.text` / `res.usageMetadata.{promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount}` / `res.candidates[0].finishReason`。全て `lib/ai/clients/gemini-sdk-contract.ts` に compile-time pin 済。
- **`pnpm why uuid` = 空(exit 0・依存ツリー未到達)**。`pnpm-workspace.yaml` の `uuid: ^14.0.0` override は現時点で何も上書きしていない。

## 4. 設計

### 4.1 Phase 1(offline・実 API 不要・commit まで自走)

コード変更は原則ゼロ(使用 field は型契約で守られ、golden は SDK 非依存)。触るのは以下:

1. `package.json`: `@google/genai` `"1.50.1"` → `"2.13.0"`(**exact pin・caret 不使用**)。
2. `pnpm install` で lockfile 更新。install 出力の "Ignored build scripts" を目視し `preinstall` no-op であることを確認。install 後の `node_modules/@google/genai/` を実測し **scripts/ 非同梱・dist/ 同梱**(= prepare skip が無害)を確定。
3. `pnpm-workspace.yaml`: `uuid: ^14.0.0` override 行(とその理由コメント)を撤去。
4. `scripts/ai/ocr-compare.ts`: stale コメント「本 sprint は 1.50.1 のまま」を 2.x bump 済の記述へ**置換**(足さず消して直す)。`GENAI_SDK_VERSION` はコード上 package.json 動的読取ゆえ挙動変更なし。
5. **検出機構の pass 確認**(本 sprint 主目的の一):
   - `lib/ai/ocr-golden.test.ts` green(parse/validate 層が SDK 版上げの影響を受けない証明)。
   - `lib/ai/clients/gemini-sdk-contract.ts` が `pnpm typecheck` 通過(SDK response/param 型契約が 2.x で維持されている証明)。
   - 型契約が「壊れたら fail する」ことは ②-0 で red 検証済。本 sprint は **pass を確認するだけ**で足りる。

### 4.2 Phase 2(OT の実 API 合図待ち・再 capture と diff)

②-0 の runbook が定める「②-1/②-2 でのモデル出力変化検出 = 再 capture して baseline と diff」の実体を実行する:

6. baseline と同一入力 `tests/fixtures/ocr/mock-exam-page1.png` を 2.x SDK 経由で**再 capture**する。
   - 書込先は **scratchpad dir**(tracked `tests/fixtures/ocr/` を一切触らない)。既存 `runCapture()` の `fixturesDir` override を使い捨て harness(scratchpad の tsx script)から呼ぶ。
   - **tracked fixture を無言上書きしない**(capture は既存 fail 設計。scratchpad 隔離で構造的に上書き不能)。
7. scratchpad の `mock-exam-page1.response.json` を tracked baseline と diff。差分を **SDK 起因 / Gemini 側の非決定性** に切り分けて報告。
   - raw response text は Gemini 非決定性で run 毎に差が出る前提(card 本文・順序)。着眼点は **構造差**(envelope / field の増減・rename・型変化 = SDK 起因の疑い)vs **内容差**(生成テキストの揺れ = 非決定性)。
   - parse が成功し ExtractedCard[] を得られること自体が SDK 互換の実証。
8. Phase 2 は原則コード変更なし(fixture 上書きなし)。分析結果は完了報告 / session doc に記録。構造差(SDK 起因の非互換)が出た場合は **停止して OT に上げる**。

## 5. commit 構成と tag

変更源が異なるため **2 commit に分離**(OT 判断 1):

- **commit A**(SDK bump 本体・Phase 1 の 1/2/4/5): `chore(deps): @google/genai 1.50.1 → 2.13.0` + **`[reviewed]`**。canonical review(general-purpose subagent + template 改変なし)+ Codex 独立レビューを通す。
- **commit B**(uuid override 撤去・Phase 1 の 3): `chore(deps): uuid override 撤去` + **`[no-review]`**。message に **`pnpm why uuid` が空(依存ツリー未到達)であった事実を明記**(将来「なぜ撤去したか」の追跡用)。override が現時点で何も上書きしていない = 挙動変化の余地ゼロゆえ review 不要(OT 判断 2)。
- **commit C**(spec / session docs): `docs(...)` + `[no-review]`。

**lockfile 分割**: A と B は共に `pnpm-lock.yaml` を触るため、**順次 install** で各 commit を coherent な lock 状態にする — (1) bump → `pnpm install` → commit A(package.json + lock + ocr-compare.ts)、(2) uuid override 撤去 → `pnpm install` → commit B(pnpm-workspace.yaml + lock delta)。1 回の install で両変更をまとめて lock 再生成し hunk を手で割る、はしない(revert 単位が壊れる)。

## 6. 完了 gate(依存を触る sprint)

全て exit 0:

- whole-repo `pnpm lint`(`--max-warnings=0`)
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm test:iso`(実 PostgreSQL 2 テナント隔離)
- `pnpm run audit`(high 閾値)
- **`pnpm install --frozen-lockfile`**(依存を触るため lockfile 整合確認)

**既存 flaky の扱い**: `pnpm test` は ②-0 完了時点で `inline-text-field.test.tsx` / `card-image-gallery.test.tsx`(ResizeObserver・async blur の timing race)により間欠 fail する既知事象。②-1 と無関係。**retry 設定での糊塗をしない**。fail した場合は当該 file 単体で PASS することを示す形で報告する。

## 7. リスクと停止条件

- **停止条件(即 OT)**: Phase 1 で typecheck / golden / build のいずれかが fail(= SDK 非互換が型契約 or parse 層に到達したシグナル)。Phase 2 で再 capture の diff に **構造差(SDK 起因の非互換)** を検出。
- **想定リスクは低**: deps / engines / peer 不変、型契約は ②-0 で pin 済、使用 API surface は generateContent 系のみ。②-0 の使い捨て worktree 実測で 2.13.0 は typecheck clean(tsbuildinfo 削除再検証済)。
- **Codex plan cross-check は省略**(OT が要否を CC 裁量に委任)。根拠: 単一源の proven 版上げ・dense-invariant の新規設計なし・offline 検証で完結・diff 極小。

## 8. spec 凍結

本 spec は実装フェーズで書き換えない。仕様変更が必要になれば停止して OT 相談(§2 の凍結対象に触れる必要が出た等)。
