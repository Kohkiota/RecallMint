# ②-2 OCR モデル移行 — Phase 1 完了記録

- 日付: 2026-07-29
- Sprint: ②-2(OCR track)
- 状態: **Phase 1(offline・2 commit)完了・未 push**。Phase 2(arm A/B 比較)は OT 実 API 合図待ち。
- spec: `docs/superpowers/specs/2026-07-29-ocr-2-2-model-migration-design.md`
- plan: `docs/superpowers/plans/2026-07-29-ocr-2-2-model-migration.md`
- fact-finding: `docs/audit/2026-07-28-ocr-2-2-model-migration-factfinding.md`

## commit(develop・未 push)

| SHA | 内容 | tag |
|---|---|---|
| fb95cdc / ffc4d53 / 3048aa0 | fact-finding(§1'/§6/§7 含む) | `[no-review]` |
| b45510c | spec 起草 | `[no-review]` |
| 26dfae1 | plan 起草 | `[no-review]` |
| `00470c4` | **commit A**: gemini-2.5-flash → gemini-3.1-flash-lite 移行 | **`[reviewed]`** |
| e2bd9ca | Codex A 論点保存 | `[no-review]` |
| `0bb8352` | **commit B**: thoughtsTokenCount 本体計上 fix | **`[reviewed]`** |
| ea7da2c | Codex B 論点保存 | `[no-review]` |

(この上に ②-1 Phase2 `ceb228d` も未 push)

## Phase 1 結論

- **移行(commit A)**: `cost.ts modelId('flash')` を lite へ repoint(実体 ID は modelId() 返り値 1 箇所のみ=二重書きなし・grep 検証=1)+ flash 単価を lite `{0.25,1.5}` へ結合更新。cost pin を lite 値へ更新して red 実証(旧 cost.ts で fail)→ 実装 → green。
  - **canonical review が Important 1(コメント二重書き)検出 → 即 fix**(コメント 3 箇所から実体 ID 除去・single-source 達成)。Codex は見逃し。OT 最重視の「二重書き禁止」を canonical が拾った実例。
- **thoughtsTokenCount fix(commit B・別 commit)**: callGemini が `thoughtsTokens: usageMetadata.thoughtsTokenCount ?? 0` を露出 → ocr.ts が tokenUsage に透過 → `estimateCostYen` 第4引数(デフォルト0・後方互換)で **output 単価課金に加算**(公式・②-0 helper pricing.ts と同式)。lite は thinking 非返却ゆえ移行では非発火の latent gap 解消。
  - **Minor(記録のみ・follow-up)**: ocr.test.ts の pre-existing success-path mock 約 20 個が thoughtsTokens 未設定 → costYen が test 内部で NaN(どの test も cost 非 assert ゆえ無害・全 green・production は callGemini `?? 0` で安全)。将来 `mockCallGemini` を `GeminiCallResult` 型化で 20 sites 追記を強制すれば contract-enforcing に解消可(scope discipline で本 commit では非対処)。

## review 結果

- **commit A**: canonical Ready to merge=With fixes → Important 1 修正後 clean / Codex Crit0/Imp0/Minor0。cost 算術・凍結・single-source・red 妥当性を独立検証。
- **commit B**: canonical Ready to merge=Yes Crit0/Imp0/Minor1(上記 record-only)/ Codex Crit0/Imp0/Minor0。cost 式(thinking=output 単価)・後方互換・過剰防御なし・NaN production 不在・凍結不変を独立検証。

## 完了 gate(全 exit 0)

- whole-repo `pnpm lint --max-warnings=0`: **0**
- `pnpm typecheck`: **0**
- `pnpm build`: **0**
- `pnpm test`: **0**(251 files / 4026 tests・既存 flaky も今回 fail せず・②-2 で +4)
- `pnpm test:iso`: **0**(23 files / 217 tests)
- `pnpm run audit`: **0**(prod high/critical 0 / dev high 1 = brace-expansion allowlist・expiry 2026-08-22)

## Phase 2(OT 実 API 合図待ち)= plan Task 4

- `scripts/ai/ocr-compare.ts` を arm mode で実行(`--arm both --arm-model gemini-3.1-flash-lite`)。判定 ②-1 から反転 = **内容差(品質差)が評価対象**。
- **目視でなく alignment + field-level 原文 diff**。**option id 表記揺れ(ア/イ/ウ vs a/b/c)は "(missing)" を大量に出すが同一選択肢ゆえ評価対象外**(fact-finding で無害確定)。判定対象 = 致命シグナル(数値/単位/否定)の field diff。
- 観測: box2d go/NG・503 有無・コスト(~40-45% 見込み)・表直下空行の有無・`![…](…)` 本文混入頻度。
- 停止条件: 致命シグナル劣化 or box2d NG → 停止して OT(対処方針は CC で決めない)。
