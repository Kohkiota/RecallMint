# 調査時の影響評価は version 前提を明記する

> **Source**: 波1 (Next 16 核) sprint 中の発見。 Step 0 調査 (`docs/superpowers/sessions/2026-06-11-wave1-next16-step0-investigation.md` §1.6 G-5) と
> 実装中の plan 順序改訂 (`docs/plans/2026-06-11-wave1-next16-plan.md`、 改訂 commit `5611130`)。

## 1. 背景

波1 sprint の Step 0 調査で、 `next.config.ts` の `webpack: (config, { dev }) => { ... watchOptions.ignored = [...] ... }` block について「**影響軽微**」 と評価した (Step 0 §1.6 G-5)。 評価根拠は「dev 限定の watch ignored だけで、 5 path の small array、 削除して Turbopack default に倒すのが最短」 で、 task 難度を「低」 と判定した。

実装中、 C2 (核 bump) の per-task build gate で `pnpm build` (Turbopack default) が以下で fail:

```
⨯ ERROR: This build is using Turbopack, with a `webpack` config and no `turbopack` config.
   As of Next.js 16 Turbopack is enabled by default and
   custom webpack configurations may need to be migrated to Turbopack.
> Build error occurred
Error: Call retries were exceeded
```

Next 16 の Turbopack default 化に伴い、 「webpack config 検出 + turbopack config 不在 → **build fail**」 のハード ガードが追加されていた。 Next 15 では同じ `webpack` block が**何も起きずに parse される**だけだったため、 Step 0 時点 (= 当時の current = Next 15.5.15 で評価していた) の「影響軽微」 判定は正しかったが、 **移行先 Next 16 では破壊的に振る舞う** breaking change が見落とされていた。

C4 (`next.config.ts` webpack block 削除) を C2 後の独立 cleanup と位置付けた plan 順序 (C1 → C2 → C3 → **C4** → C5 → C6) は、 build gate の前提 (= C4 が C2 build pass の prerequisite) と矛盾。 OT 確認の上、 plan 順序を **C1 → C4 (pre-step) → C2 → C3 → C5 → C6** に改訂して吸収。

## 2. Lessons Learned

### 2.1 影響評価は「どの version で見ているか」 を明記する

Step 0 G-5 の評価「影響軽微」 は **Next 15 環境での grep 結果に基づく判定**だった。 移行 sprint の Step 0 では、 対象が「移行 source 側 (= 現行 prod) で何が動いているか」 と「移行 target 側 (= 移行先 version) で何が壊れるか」 の **2 視点**で評価される必要がある。 後者の視点を漏らすと、 移行先で追加された breaking ガードを見落とす。

**Rule of thumb**: 移行系 Step 0 調査で項目を分類するときに、 「現行 X 版で影響軽微 / 移行先 Y 版で影響 ?」 の形で **両 version 視点を明示**する。 片方しか書けない項目は「移行先側未調査」 と明示 fragility tag を付ける。

### 2.2 per-task build gate が「Step 0 漏れ」 を回収した

C2 の完了条件に `pnpm build` 通過を含めていたため、 Step 0 で評価ミスがあっても build gate で fail が顕在化した。 もし build を sprint 完了 gate のみに置いて per-task gate に含めていなかったら、 C5 / C6 まで進めて最後に sprint gate で fail = 巻き戻し範囲が広い。 per-task build gate は Step 0 評価の精度を補う **安全網**として機能する。

### 2.3 plan は順序矛盾を発見したら即改訂する (sunk cost を残さない)

C2 build gate で「C4 が C2 の前提」 が露見したとき、 (a) C4 を C2 に統合 (commit 分割粒度緩和) / (b) C4 を pre-step 化 (順序改訂) / (c) C2 完了条件を緩和 (build を sprint level に倒す) の 3 案を OT に提示し、 (b) を採用した。 plan 文言の整合性より、 「変更源ごとに分ける」 commit 分割の SSoT を保つ方が運用上のメリットが大きいと判断 (rollback 単位が明確、 review 経路が独立、 future audit log として読みやすい)。 **plan は教科書ではなく作業道具で、 走りながら直す**。 改訂時は経緯を 1 行記録 (`5611130` commit body) して trace を残す。

## 3. Related

- 同 sprint で表面化した「dep declaration bug は build でしか出ない」 (Clerk 7.4.3 → 7.5.1): `2026-06-11-dep-declaration-bug-build-only-detection.md`
- 波1 spec / plan / Step 0: `docs/superpowers/specs/2026-06-11-wave1-next16-design.md` / `docs/plans/2026-06-11-wave1-next16-plan.md` / `docs/superpowers/sessions/2026-06-11-wave1-next16-step0-investigation.md`
