# ②-1 @google/genai 2.x 版上げ — Phase 1 完了記録

- 日付: 2026-07-28
- Sprint: ②-1(OCR track)
- 状態: **Phase 1(offline bump)完了・未 push**。Phase 2(再 capture)は OT 実 API 合図待ち。
- spec: `docs/superpowers/specs/2026-07-28-genai-sdk-2x-bump-design.md`
- plan: `docs/superpowers/plans/2026-07-28-genai-sdk-2x-bump.md`

## commit(develop・未 push)

| SHA | 内容 | tag |
|---|---|---|
| `8837d2a` | spec 起草 | `[no-review]` |
| `9384d2d` | plan 起草 | `[no-review]` |
| `82c80bb` | **commit A**: @google/genai 1.50.1 → 2.13.0 | **`[reviewed]`** |
| `bff4427` | **commit B**: uuid override 撤去 | `[no-review]` |
| `1c27654` | Codex review 論点保存 | `[no-review]` |

## Phase 1 実測・結論

- **版**: 2.13.0(latest・exact pin)。1.50.1 比で deps 完全一致・engines(node>=20)不変・peer(@modelcontextprotocol/sdk optional)不変・新規 transitive ゼロ。
- **build script の正体(確認事項 #1 の結論)**: 2.13.0 の install-lifecycle は `preinstall: echo 'preinstall: no-op'`(リテラル no-op)のみ。`prepare: node scripts/prepare.js` は宣言されるが **registry tarball 依存では実行されない**(prepare は git/dir 依存 install 時のみ走る lifecycle)+ **`scripts/` は tarball 非同梱**(実測: `node_modules/@google/genai/scripts/` 不在・`dist/` 同梱)。→ pnpm "Ignored build scripts" に載るが **skip が正**・`onlyBuiltDependencies` 追加不要。
- **検出機構 pass 実証(確認事項 #2 の結論)**: typecheck 0(`gemini-sdk-contract.ts` の SDK 型契約が 2.x で維持)/ golden 3 green(parse 層無傷)/ mock 30 green。型契約が「壊れたら fail」は ②-0 で red 検証済ゆえ本 sprint は pass 確認のみ。
- **uuid override 撤去**: 撤去前後とも `pnpm why uuid` 空(依存ツリー未到達)。lockfile 変化は overrides ブロックから uuid 行が消えるのみ(resolution churn なし)。他 override(postcss/react/react-dom/vite/sharp)不変。
- **ocr-compare.ts**: provenance コメントの stale 記述(「本 sprint は 1.50.1 のまま」)を置換。`GENAI_SDK_VERSION` は package.json 動的読取のまま(logic 不変)。

## review 結果

- **canonical**(requesting-code-review・general-purpose subagent + template 改変なし): Ready to merge = Yes / Critical 0 / Important 0 / Minor 1。reviewer 実走で whole-repo lint exit 0 + test:iso 217 green も確認。
- **Codex**(codex-review.sh・独立): Critical 0 / Important 0 / Minor 0(1 周収束・git clean detector PASS)。
- **Minor 1**(記録のみ・修正なし): spec §3 の fact list で install-lifecycle を preinstall のみと表現した点への nit。spec §3 本文は prepare の非実行を明記済で正確。凍結尊重で spec 不変更。

## 完了 gate(全 exit 0)

- whole-repo `pnpm lint --max-warnings=0`: **0**
- `pnpm typecheck`: **0**
- `pnpm build`: **0**
- `pnpm test`: **0**(251 files / 4022 tests・既存 flaky も今回は fail せず)
- `pnpm test:iso`: **0**(23 files / 217 tests・実 PG 2 テナント隔離)
- `pnpm run audit`: **0**(prod high/critical 0 / dev high 1 = brace-expansion@1.1.16 を allowlist 受容・expiry 2026-08-22)
- `pnpm install --frozen-lockfile`: **0**

## Phase 2(OT 実 API 合図待ち)= plan Task 4

- baseline と同一入力 `tests/fixtures/ocr/mock-exam-page1.png` を 2.x SDK で再 capture(**scratchpad dir へ書く**・tracked fixtures dir は触らない)。
- tracked baseline と diff → **SDK 起因(構造差)/ Gemini 非決定性(内容差)** に切り分けて報告。fixture 上書きなし。構造差検出時は停止して OT に上げる。
- 実行手段: 既存 `runCapture({imagePath, name, fixturesDir})` を scratchpad の使い捨て harness から呼ぶ。実 API は OT 合図後のみ。
