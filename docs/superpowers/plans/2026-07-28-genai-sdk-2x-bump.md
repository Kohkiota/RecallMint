# ②-1 @google/genai 2.x 版上げ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans。Steps は checkbox(`- [ ]`)で追跡。

**Goal:** 本番 OCR の `@google/genai` を `1.50.1` → `2.13.0` へ上げ、②-0 の回帰検出機構(golden / SDK 型契約 / capture-diff)が版上げに対し機能することを実証する。

**Architecture:** コード変更は原則ゼロ(使用 field は型契約で pin 済・golden は SDK 非依存)。触るのは package.json / pnpm-workspace.yaml / ocr-compare.ts の provenance コメントのみ。Phase 1(offline bump)で自走 commit、Phase 2(OT 合図・実 API)で再 capture して baseline と diff。

**Tech Stack:** pnpm 10.33.0 / TypeScript strict / Vitest / @google/genai 2.13.0。

## Global Constraints(spec verbatim・全 task に暗黙適用)

- **pin 規則**: direct 依存は **exact**(caret 不使用)。`@google/genai` は `"2.13.0"`。
- **凍結(本 sprint で変えない)**: モデル ID(`gemini-2.5-flash`)/ 本番 prompt / 本番 response schema / OCR pipeline 挙動。これらに触る必要が出たら**停止して OT 相談**。
- **完了 gate(全 exit 0)**: whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit` / `pnpm install --frozen-lockfile`。
- **既存 flaky**: `inline-text-field.test.tsx` / `card-image-gallery.test.tsx` は timing race で間欠 fail(②-1 無関係)。retry 糊塗禁止。fail 時は当該 file 単体 PASS を示して報告。
- **commit 分離**: bump 本体 / uuid 撤去 / docs は別 commit(revert 単位を分ける)。lockfile は順次 install で各 commit を coherent 状態にする。

---

## Task 1: SDK bump 本体(commit A)

**目的:** `@google/genai` を 2.13.0 へ上げ、検出機構(golden green + 型契約 typecheck)で無害を実証し、canonical + Codex review を通して `[reviewed]` commit する。

**Files:**
- Modify: `package.json`(dependencies `@google/genai`: `1.50.1` → `2.13.0`)
- Modify: `scripts/ai/ocr-compare.ts:138-140`(stale provenance コメント置換)
- Modify: `pnpm-lock.yaml`(install で自動更新・genai 部分)

**制約:** exact pin。ocr-compare.ts はコメントのみ変更(`GENAI_SDK_VERSION` のロジックは動的読取ゆえ不変)。凍結対象に触れない。

- [ ] **Step 1: package.json の版を書換**

`package.json` の `"@google/genai": "1.50.1"` を `"@google/genai": "2.13.0"` に。

- [ ] **Step 2: install して lockfile 更新 + build script 実測**

Run: `pnpm install`
確認事項(報告に含める):
- "Ignored build scripts" 出力に `@google/genai` が載り、その中身が `preinstall: echo 'preinstall: no-op'`(リテラル no-op)であること。
- `ls node_modules/@google/genai/`: **`scripts/` が無い**・**`dist/` がある**(= prepare skip が無害・publish 済 dist を使用)の実測。
- install 後の実 version: `node -e "console.log(require('@google/genai/package.json').version)"` → `2.13.0`。

- [ ] **Step 3: ocr-compare.ts の stale コメントを置換**

`scripts/ai/ocr-compare.ts` の 138-140 行を置換(足さず消して直す):

```ts
// provenance 用。 @google/genai の pinned version を package.json から動的読取して
// 記録する(②-0 では 1.50.1 固定、 ②-1 で 2.x へ bump 済。 この行は値を hardcode せず
// 常に現在の pinned 値を追随する)。
const GENAI_SDK_VERSION = (rootPackageJson.dependencies as Record<string, string>)[
  '@google/genai'
]
```

- [ ] **Step 4: 検出機構の pass 確認(本 sprint 主目的)**

Run: `pnpm typecheck`
Expected: PASS(`lib/ai/clients/gemini-sdk-contract.ts` の SDK response/param 型契約が 2.x で維持 = 型 error ゼロ)。

Run: `pnpm vitest run lib/ai/ocr-golden.test.ts`
Expected: PASS(fixture ≥1 件・orphan 無し・parse 出力が pin と一致 = parse 層が SDK 版上げの影響を受けない証明)。

Run: `pnpm vitest run lib/ai/clients/gemini.test.ts scripts/ai/lib/gemini-raw.test.ts`
Expected: PASS(mock client テストが 2.x でも通る)。

- [ ] **Step 5: canonical code review**

REQUIRED SUB-SKILL: `superpowers:requesting-code-review`(general-purpose subagent + template `code-reviewer.md`・改変禁止)。観点に **whole-repo lint 実行確認 / test:iso green** を含める。対象 = HEAD に対する未 commit 変更(package.json / ocr-compare.ts / lockfile)。

- [ ] **Step 6: Codex 独立レビュー**

Run: `scripts/ai/codex-review.sh genai-2x-bump`
canonical の結論を見せない。保存 md(`docs/codex/`)を読む。fix ループ = 未解決 Critical 0 かつ Important 0 まで(上限 3 周)。P0/P1→Critical / P2→Important / P3,P4→Minor。

- [ ] **Step 7: commit A**

commit 直前宣言(chat 4 点): review 経路 / 結果(Crit N / Imp N / Minor N)/ Important 残し有無 / `[reviewed]` 付与。

```bash
git add package.json scripts/ai/ocr-compare.ts pnpm-lock.yaml
git commit -m "chore(deps): @google/genai 1.50.1 → 2.13.0 [reviewed]"
```

**完了条件:** typecheck 0 / golden green / mock test green / canonical Critical 0 Important 0 / Codex Critical 0 Important 0 / commit A に `[reviewed]`。

---

## Task 2: uuid override 撤去(commit B)

**目的:** 依存ツリー未到達で効果ゼロの `uuid` override を撤去する。挙動変化の余地が無いため review 不要(`[no-review]`)。

**Files:**
- Modify: `pnpm-workspace.yaml`(`uuid: ^14.0.0` override 行とその理由コメントを削除)
- Modify: `pnpm-lock.yaml`(install で自動更新・uuid override 部分)

**制約:** override 撤去のみ。他の override(postcss / react / vite / sharp)には触れない。

- [ ] **Step 1: 撤去前に tree 未到達を再確認**

Run: `pnpm why uuid`
Expected: 空(exit 0・出力なし)。空でなければ**停止して報告**(前提が崩れている)。

- [ ] **Step 2: pnpm-workspace.yaml から uuid override を削除**

`overrides:` 直下の以下 3 行を削除:

```yaml
  # 導入経緯不明・現在ツリー未到達(pnpm why uuid が空・2026-07-26 確認)。次に deps を触る際に撤去可否を判断
  uuid: ^14.0.0
```

(コメント行 + `uuid: ^14.0.0` 行)。他の override は残す。

- [ ] **Step 3: install して lockfile 更新**

Run: `pnpm install`
Expected: uuid override 起因の lock 変化のみ(他 package の resolution は不変)。install 後に再度 `pnpm why uuid` が空であることを確認。

- [ ] **Step 4: frozen-lockfile 整合確認**

Run: `pnpm install --frozen-lockfile`
Expected: exit 0(lockfile と workspace が整合)。

- [ ] **Step 5: commit B**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore(deps): uuid override 撤去(pnpm why uuid が空=依存ツリー未到達) [no-review]"
```

message body に「override が現時点で何も上書きしていない(pnpm why uuid 空)= 挙動変化の余地ゼロゆえ review 不要」を明記。

**完了条件:** pnpm-workspace.yaml から uuid override 消滅 / 他 override 残存 / `pnpm why uuid` 空維持 / frozen-lockfile exit 0 / commit B に `[no-review]` + `pnpm why uuid` 空の事実を message 記録。

---

## Task 3: Phase 1 完了 gate + stop checkpoint 報告

**目的:** whole-repo の完了 gate を全て走らせ、Phase 1 完了を報告して停止する(OT + claude.ai チェック → OT push の checkpoint)。

**Files:** なし(gate 実行のみ)。

- [ ] **Step 1: 完了 gate を順に実行**

```bash
pnpm lint --max-warnings=0
pnpm typecheck
pnpm build
pnpm test
pnpm test:iso
pnpm run audit
pnpm install --frozen-lockfile
```

各 exit 0 を確認。`pnpm test` が既存 flaky で fail した場合は当該 file(`inline-text-field.test.tsx` / `card-image-gallery.test.tsx`)を単体 run し PASS を示す(retry 糊塗しない)。

- [ ] **Step 2: audit gate 注意**

`pnpm run audit`(wrapper・high 閾値)を使う(builtin `pnpm audit` は level=low で走るため不可)。既知の無関係 high(`sharp<0.35.0`・override 済)以外の新規 high が出たら報告。

- [ ] **Step 3: stop checkpoint 報告**

chat に結論のみ: gate 各 exit 0(「whole-repo lint exit 0 確認済」「test:iso green 確認済」「pnpm run audit exit 0 確認済」を明記)/ commit A・B の SHA / 検出機構 pass 実証 / build script 実測結果 / Phase 2(再 capture)は OT 実 API 合図待ち、を報告して**停止**。

**完了条件:** 全 gate exit 0(flaky は単体 PASS で切り分け)/ 3 つの必須 1 行明記 / Phase 1 commit(A/B/spec)の SHA 提示 / OT 合図待ちで停止。

---

## Task 4: Phase 2 — 2.x SDK での再 capture + baseline diff(OT 実 API 合図後)

**目的:** baseline と同一画像を 2.x SDK で再 capture し、既存 fixture と diff。差分を SDK 起因 / Gemini 非決定性に切り分けて報告する。tracked fixture は上書きしない。

**Files:**
- Create(scratchpad・非追跡): `<scratchpad>/recapture-2x.ts`(使い捨て harness)
- 書込先: `<scratchpad>/ocr-recapture/`(tracked `tests/fixtures/ocr/` は触らない)

**制約:** **実 API は OT 合図後のみ**。tracked fixtures dir を一切触らない。上書き禁止。構造差検出時は停止。

- [ ] **Step 1: 使い捨て harness を scratchpad に作成**

`runCapture()`(`scripts/ai/ocr-capture-fixture.ts` export)を `fixturesDir` override で呼ぶ:

```ts
import { runCapture } from '@/scripts/ai/ocr-capture-fixture'
const OUT = process.env.RECAPTURE_DIR!
runCapture({
  imagePath: 'tests/fixtures/ocr/mock-exam-page1.png',
  name: 'mock-exam-page1',
  fixturesDir: OUT,
}).then((p) => console.log(JSON.stringify(p)))
```

(import path / tsx 起動は既存 script の慣習に合わせる。`RECAPTURE_DIR` = scratchpad の空 dir。)

- [ ] **Step 2: OT 合図を確認してから実 API で再 capture**

Run(OT 合図後): `RECAPTURE_DIR=<scratchpad>/ocr-recapture tsx --env-file=.env.local <scratchpad>/recapture-2x.ts`
Expected: `<scratchpad>/ocr-recapture/mock-exam-page1.{response.json,expected-cards.json}` が生成。tracked `tests/fixtures/ocr/` は無変化(`git status` で確認)。

- [ ] **Step 3: baseline と diff して切り分け**

Run: `diff tests/fixtures/ocr/mock-exam-page1.response.json <scratchpad>/ocr-recapture/mock-exam-page1.response.json`
判定基準:
- **内容差**(card 本文・順序の揺れ)= Gemini 非決定性(想定内)。
- **構造差**(envelope / JSON field の増減・rename・型変化)= SDK 起因の疑い → **停止して OT に上げる**。
- `expected-cards.json` の diff も同様に見る(parse 出力の構造が保たれるか)。

- [ ] **Step 4: 報告**

chat / session doc に: 再 capture の実行事実 / diff の分類(SDK 起因 or 非決定性)/ parse 成功で SDK 互換を実証 / tracked fixture 無変更、を記録。scratchpad の生成物は掃除。

**完了条件:** 再 capture 実行 / diff を SDK 起因 vs 非決定性で分類 / 構造差なし(あれば停止)/ tracked fixture 無変更 / 報告記録。

---

## Self-Review

- **Spec coverage:** §4.1 Phase 1 = Task 1-3 / §4.2 Phase 2 = Task 4 / §5 commit 構成 = 各 task の commit step / §6 gate = Task 3 / §7 停止条件 = Task 1 Step 4・Task 4 Step 3 に反映。build script 確認(§3)= Task 1 Step 2。uuid 撤去(§3/§5)= Task 2。stale コメント(§4.1-4)= Task 1 Step 3。全 spec 項に対応 task あり。
- **Placeholder scan:** TBD / TODO なし。全 step に具体 command / 具体差分あり。
- **Type consistency:** `GENAI_SDK_VERSION` / `runCapture({imagePath,name,fixturesDir})` は既存 export 署名と一致(Task 1 Step 3 / Task 4 Step 1 で実 signature を使用)。
