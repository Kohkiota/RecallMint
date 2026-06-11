# dep declaration bug は lint / typecheck / test を全部すり抜けて build でしか出ない

> **Source**: 波1 (Next 16 核) sprint C2 で `@clerk/nextjs 7.4.3` (matrix v1.3 当初 pin) が `@clerk/react` との dep declaration 不整合で build fail した経緯。 解消版 7.5.1 への改訂は `8e4acfb`、 当初検出 dispatch は C4 retry セッション (commit 履歴で `1313e92` 前の BLOCKED 報告)。

## 1. 背景

波1 sprint で `@clerk/nextjs` を `^7.2.4` → **`7.4.3` exact** へ bump (matrix v1.3 §3.1 当初 pin、 「proxy.ts 公式 base」 という根拠)。 install 完走 → `pnpm install --frozen-lockfile`、 `pnpm lint`、 `pnpm typecheck`、 `pnpm test` (1921 件) **全 exit 0**。 ところが `pnpm build` (Turbopack default) で以下が fail:

```
./node_modules/.../@clerk/nextjs/dist/esm/client-boundary/uiComponents.js:11:1
Export ConfigureSSO doesn't exist in target module
  > 11 | import {
  > 12 |   APIKeys,
  > 13 |   ConfigureSSO,
  ...
  > 31 | } from "@clerk/react";

The export ConfigureSSO was not found in module
[project]/node_modules/.../@clerk/react@6.9.0/...
Did you mean to import HandleSSOCallback?
```

調査結果:
- `@clerk/nextjs@7.4.3` の `dependencies.@clerk/react` = `^6.7.3` (registry で確認)
- `@clerk/react@6.9.0` (= 6.x 最新 stable) に `ConfigureSSO` export は存在せず (`HandleSSOCallback` のみ)
- つまり `@clerk/nextjs@7.4.3` は **コードが `ConfigureSSO` を import しているのに、 自分の `dependencies` 宣言が `^6.7.3` (= `ConfigureSSO` 不在の version) という packaging bug** を抱えて release されていた
- `@clerk/nextjs@7.5.0` で `@clerk/react: ^6.8.0`、 `7.5.1` (latest stable) で `@clerk/react: ^6.9.0` と declaration が更新済 = 7.5.1 で build 通過

OT 確認の上、 matrix v1.3 §3.1 の Clerk pin を `7.4.3` → **`7.5.1`** に改訂 (`8e4acfb`)、 同 sprint 内で着地。

## 2. Lessons Learned

### 2.1 dep declaration の正しさは bundler 解決 (= build) でしか検出されない

`lint` (eslint) は own source のみを見る。 `typecheck` (tsc) は `.d.ts` を見るが、 ESM 経由の動的 import 解決までは追わない。 `test` (vitest) は 1921 件 pass したが、 該当 client-boundary file が test で import されない動線だった (or vitest の transform が違う resolver を使った)。 **bundler (Next.js / Turbopack) が初めて `node_modules` 内の `import` 文を解決する = bundler が初めて declaration 不整合に出会う**。

→ dep upgrade で「lint/typecheck/test pass = 安全」 は誤った安心。 **build まで通って初めて第一次の安全性が担保される**。

### 2.2 build を per-task gate に残す判断の回収事例

本 sprint で C2 の完了条件に `pnpm build` 通過を含めていなかったら、 C5 / C6 まで進めて sprint 完了 gate で初めて発覚 → 巻き戻し + 7.5.1 への改訂が C2 まで遡る大規模 rework。 per-task build gate のおかげで **C2 単独で問題を切り出して fix できた** (= matrix / spec / plan の同 sprint 内改訂 + 7.5.1 install 再走 + C2 retry で完結)。

「build は重いから sprint 完了 gate に押し込めて per-task では skip」 という近道は、 こうした「lint/typecheck/test を全部すり抜けて build でしか出ない」 bug の前で破綻する。 **dep upgrade を含む sprint では build を per-task gate に必ず残す**。

### 2.3 「公式例 base」 の根拠は packaging まで含めて確認する

matrix v1.3 §3.1 の Clerk pin 7.4.3 選定根拠は「proxy.ts 公式 example の base version」 だった (= Clerk docs の proxy.ts サンプルが 7.4.3 で書かれていた)。 しかし 7.4.3 自身が packaging bug を抱えていて install しても build しない release だった。 docs の example version は **packaging の正しさを保証しない**。 dep pin を決めるときは:

1. registry で `dependencies` / `peerDependencies` を確認
2. その declaration が **実コードの import と整合しているか**を 1 ステップ離して疑う (今回は `^6.7.3` peer に対して `ConfigureSSO` という新しめ export を import = 違和感あり、 でも気付かなかった)
3. **install + build で実証**してから pin を確定

を経るのが安全。 Step 0 dry-run で codemod が package.json を `@clerk/nextjs@7.2.9` のまま (= bump せず) 保持していたのは「7.2.9 でも Next 16 peer 通る」 という意味で正しく、 「7.4.3 が公式 example base」 は別の話。 docs の example version と registry の安全性は **別の dimension** で評価する。

### 2.4 同 sprint 内での pin 改訂は経緯記録を残す

7.4.3 → 7.5.1 改訂は matrix / spec / plan の 3 doc を 1 commit (`8e4acfb`) で同期、 commit body に「7.4.3 は dep declaration (`@clerk/react ^6.7.3`) と実 import (`ConfigureSSO`) の不整合で build fail。 7.5.1 (`@clerk/react ^6.9.0`) で解消。 発見経路 = C4 の per-task build gate」 と記録。 後の audit で「なぜ 7.4.3 を一旦選んだのか / なぜ 7.5.1 になったのか」 を git log で trace できる状態を保った。 **sprint 内 pin 改訂は経緯文 1 行を必ず残す** (claude.ai 側のナレッジ更新も含めて)。

## 3. Related

- 同 sprint で表面化した「移行先 version の breaking change を Step 0 で見落とす」: `2026-06-11-version-context-in-impact-evaluation.md`
- 波1 spec / plan / Step 0: `docs/superpowers/specs/2026-06-11-wave1-next16-design.md` / `docs/plans/2026-06-11-wave1-next16-plan.md` / `docs/superpowers/sessions/2026-06-11-wave1-next16-step0-investigation.md`
- 改訂同期 commit: `8e4acfb` (matrix / spec / plan を 7.5.1 に更新)
