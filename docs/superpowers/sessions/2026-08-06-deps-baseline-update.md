# deps 基線更新 sprint(2026-08-06)

audit high 7 件の解消(T1)→ stg smoke → shadcn の scope 分類是正(T3)。**T2 は指示が発行されず未実施**(欠番。T1 brief に「T2 / T3 に自走しない」とあり、実際に受領したのは T1 と T3 のみ)。

範囲 = `af4815f..61dd0ac`(**全て push 済**)。

| commit | 内容 | tag |
|---|---|---|
| `af4815f` | T1: high 7 件を lockfile-only で解消 | `[reviewed]` |
| `6bdbd99` | T1: GHSA-mh99 の allowlist 受容を撤去 + 台帳 | `[reviewed]` |
| `3920cb0` | T1 の Codex findings | `[no-review]` |
| `05c5faf` | stg smoke 記録 | `[no-review]` |
| `8fea03c` | T3: shadcn を devDependencies へ | `[reviewed]` |
| `61dd0ac` | T3 の Codex findings | `[no-review]` |

数値・GHSA・受容判断の正本 = `docs/audit/dependency-audit-ledger.md`(「解消済(2026-08-06 deps 基線更新 T1)」/「分類是正(2026-08-06 deps 基線更新 T3)」)。smoke の生値 = `2026-08-06-deps-t1-stg-smoke.md`。本 doc は**経緯と教訓**を残す。

---

## 恒久的な知見

### 1. peer-suffix 付き transitive でも `pnpm update` が効く場合がある

matrix v2(2026-07-25)で得た「**pnpm 10 の `pnpm update` は peer-suffix 付き transitive(lockfile key が `vite@x.y.z(...)`)を更新しない**」という知見を、T1 は**無条件命題として扱わなかったのが正しかった**。

実測: `express-rate-limit` は lockfile key が `8.4.1(express@5.2.1)` = peer-suffix 付きだが、`pnpm update express-rate-limit` で 8.6.2 に更新された。

分かれ目は **peer-suffix が付いた理由**らしい:

- **vite 型(更新不発)** = 消費側(vitest / @vitejs/plugin-react)が **vite を peer として要求**しており、vite 自身が peer 解決の主体になっている構図。
- **express-rate-limit 型(更新可)** = 通常の `dependencies` が、たまたま自分の peer(`express`)解決の結果として suffix を得ているだけ。

**運用**: 「peer-suffix が付いている = update 不発」と決め打って先に override へ逃げない。**着手時に 1 回 `pnpm update <name>` を実走して実測で判定する**。T1 は override 追加ゼロで 7 件全て解消できた。

### 2. `pnpm audit --prod` の scope は「依存グラフ上の分類」であって「実行経路」ではない

stg smoke の指示(claude.ai 側)に次の前提が書かれていたが、**現物確認で不成立**だった:

> prod scope で動いたのは fast-uri / ip-address / brace-expansion@5 の 3 件。いずれも `@google/genai` 配下の runtime 依存木にいるため、この 1 本が唯一の実経路

実測(`pnpm why --prod` + `node_modules/@google/genai/package.json`):

- `brace-expansion@5` は `shadcn → ts-morph → @ts-morph/common → minimatch@10` 配下で、**`@google/genai` 配下ですらない**。
- `fast-uri` / `ip-address` は `@modelcontextprotocol/sdk` 配下だが、**その SDK は `@google/genai` の optional peerDependency**(`peerDependenciesMeta.optional = true`。genai 自身の `dependencies` は `google-auth-library` / `p-retry` / `protobufjs` / `ws` の 4 つだけ)。tree に存在するのは pnpm の peer 自動導入によるもので、MCP tool を使わない OCR 経路では読み込まれない。
- 結果、**T1 で版が上がった 7 件はいずれも smoke の実行経路上で動作していない**。

`pnpm audit --prod` は `dependencies` を辿るグラフを評価対象にするだけで、その package が実行されるとは主張していない。**「prod scope にある」と「runtime に読み込まれる」は別命題**として扱う。

なお **この smoke が無価値だったわけではない**: 実証されたのは「新 lockfile で Vercel build が通り、app が起動し、OCR pipeline 一式が完走する」こと。本 repo には**依存ツリーの変更が local gate を全通過しながら Vercel 実行時だけ壊れた前例**(sharp libvips `.so` の NFT トレース漏れ)があり、その型の regression を潰す検査にはなっている。**主張を「patched なコードが動いた」から「新しい依存ツリーで成果物が壊れていない」へ縮めれば正しい。**

### 3. lockfile-only 変更では deploy SHA の構造的 fingerprint が原理的に作れない

Vercel は commit SHA を header にも HTML にも出さない(既知 = `2026-07-14-image-gc-v2-normalized-refs-completion.md`)。過去の smoke はこれを「**新コードの構造的 fingerprint**」(新 route / 新 telemetry key / 旧 route の 404 化など)で代替してきた。

**lockfile-only 変更はその代替が使えない** — source を 1 行も変えないので、新旧を区別する観測可能な差が成果物に存在しない。今回試して否定された代替も記録する:

- 静的 asset の `last-modified` は **CDN のキャッシュ充填時刻**(初回 navigate と同秒だった)であってビルド時刻ではない。
- Vercel CLI / token は本環境に無い。
- 直前 commit 群が docs のみだったため「前世代との差」も作れない。

取れたのは deployment id(静的 asset の `?dpl=` query)だけ。**dpl ↔ SHA の対応確認は Vercel dashboard = OT 依存**。

**運用**: lockfile-only の変更を stg で検証する場合、§0 の deploy 確認は **OT の dashboard 確認を手順に組み込む**か、「この smoke は deploy が current である前提でのみ帰属する」と明示して進める。CC 側で閉じられると期待しない。

### 4. scope 移動の測定は推移閉包で統一する(`pnpm ls --dev` と混ぜない)

T3 で当初、prod 行を `pnpm ls --prod`、dev 行を `pnpm ls --dev` の件数で書いたところ、**prod 側は lockfile 推移閉包と一致したのに dev 側は一致しなかった**(`pnpm ls --dev` = 451 → 681 / 閉包 = 655 → 840)。同じ表に基準の違う 2 行が並び、`681 − 451 = 230 ≠ 201` という**存在しない矛盾**を読者に生ませる状態になっていた(canonical review が検出)。

**採用する基準** = `pnpm-lock.yaml` からの推移閉包。`importers['.']` の各群を根に `snapshots[].dependencies / optionalDependencies` を辿り `name@版`(peer suffix を除去)へ正規化して数える。`pnpm audit --json` の `metadata.totalDependencies` も別基準なので混ぜない。

**scope 移動を主張する時に出す 5 値**(全 package が両側で説明できる形):

1. prod 離脱 / 2. prod 流入 / 3. 離脱のうち既に dev 到達可だった数 / 4. 離脱のうち dev に新規出現した数 / 5. prod 残留のまま dev 経路も得た数

T3 の実測: prod 646 → 445(離脱 201 / 流入 0)、離脱 201 = 既 dev 86 + 新規 dev 115 + **孤児 0**、prod 残留のまま dev 経路取得 70、検算 `115 + 70 = 185` = dev 流入、`prod ∪ dev` は 1132 で不変(= 版が 1 つも動いていないことの裏取り)。

この基準は **advisory が動かなかった場合でも成立する**のが利点。T3 では prod advisory が 1 件も減らず(現 prod 6 件は shadcn 非依存の `@google/genai` / `next` からも到達するため)、当初期待された「moderate/low が prod → dev へ移り件数が一致する」形の証明は**成立しなかった**。

### 5. prod → dev の scope 移動は「分類の是正」であると同時に「gate 強制力の低下」でもある

audit gate は **prod = allowlist 不適用で high/critical は無条件 fail** / **dev = version-aware allowlist で受容可能(expiry 付き)**。したがって package を prod から dev へ移すと、その subtree は「**受容不可**」から「**受容可能**」の面へ移る。

T3 で prod を離脱した 201 package について、**今後 high が出た場合の強制力は落ちている**。実例として `brace-expansion` は本 repo で唯一 allowlist 受容が発生したモジュールで、その v5 系列がこの 201 に含まれる — 前日なら prod で無条件 fail、移動後は dev として受容の余地がある。

**規律**: scope 移動を記録する時は favorable 方向(「prod 面から外れた」)だけ書かない。**強制力がどこで落ちたかを同じ場所に併記する。**(prod に残ったまま dev 面にも現れた 70 package は prod 残留ゆえ強制力不変 — これも区別して書く。)

### 6. devDeps 移動の安全性検証に local 実測を使っても判別力がない

T3 で当初、「devDependencies は Vercel の build phase で install されるため `@import "shadcn/tailwind.css"` の解決は維持される」の**実証として build 出力の CSS バイト一致**を挙げた。これは誤り(canonical review が Important として検出)。

**local では移動前も移動後も devDependencies が install される**。したがって CSS バイト一致は「Vercel が devDeps を install する」仮説と「しない」仮説の**どちらの下でも同じ結果**になり、この主張を判別できない。唯一の load-bearing な安全性主張が、それを支えられない証拠に紐づいていた。

**正しい根拠(repo 内で閉じる・反証不能)**: `app/globals.css:1` の `@import "tailwindcss";` は devDependency `tailwindcss` を、`postcss.config.mjs` が読む `@tailwindcss/postcss` も devDependency を解決している。**Vercel の build phase が devDependencies を省くなら現行の prod build が既に失敗しているはず**であり、shadcn は既存の実証済みクラスに加わるだけで新しい失敗様態を作らない。

**一般化**: 「環境 E で条件 C が成立する」ことの証拠に、**C が常に真である環境での実測**を使わない。local build は「壊れていないこと」の証拠にはなるが「環境差に耐えること」の証拠にはならない。

---

## 副次的な記録

- **grep で「import されていない」を測る時は CSS を含める**。T3 の brief は「shadcn は source から import されておらず」としていたが、TS/JS/TSX の import は確かに 0 件でも `app/globals.css:3` に `@import "shadcn/tailwind.css";` が実在した。正しい言い方は「**runtime に読み込まれる経路が無い**」。
- **allowlist の受容根拠は上流の動きで無言に失効する**。GHSA-mh99 の受容根拠「v1 系に patched backport が存在しない」は、上流が **1.1.17 を backport** したことで偽になった。台帳は当時「backport 無しのまま v1 系の新 patch が出る可能性」を想定して系列単位(`<2.0.0`)で受容していたが、**patched が生えた場合に自動で受容が外れる仕組みは無い**(expiry だけが唯一の機械的な蓋)。→ 受容は expiry で必ず棚卸しされる、という設計が実際に効いた形。
- **allowlist が空になり、gate の受容側経路が無稼働になった**。`loadAllowlist` の必須 field 検証 / `satisfiesRange` / expiry 判定は現在 gate 実行で 1 度も通らない。安全側の性質は不変(entry 無しは fail-closed)だが、**expiry 判定だけは腐ると fail-open 方向**。台帳の watch に起票済み(解除条件 = helper を export して fixture 駆動 test で pin)。
- **同種の未処理**: `tw-animate-css@1.4.0` は shadcn と同じクラス(`app/globals.css:2` から CSS のみ import・TS/JS import 0・runtime 経路なし)だが `dependencies` に残置。ただし transitive 依存がゼロゆえ移しても prod 面は 1 package しか減らず、実利は薄い。

---

## 残件

1. **`dpl_CPs7gETBY9AgUpYmV1KBV7JQkGwh` ↔ SHA の対応確認**(OT / Vercel dashboard)。smoke の結果はこの対応が成立する前提でのみ T1 に帰属する(知見 3)。
2. **smoke の `cardsExcluded 1`(問9 脱落)の理由未特定**。`last_error_code` は NULL、`figuresExcluded` も全 0。除外理由は `result_summary` に記録されず client にも露出しない。同一入力で 0 以外は初観測。追跡には `OCR_DEBUG_LOG` 付き再走が必要。
3. **allowlist 照合機構の unit test**(上記 watch)。
4. **moderate 5 / low 2 は未対処**(gate 対象外)。うち **postcss@8.5.21 は `next` 配下**で override `^8.5.12` は floor ゆえ引き上げない。本 sprint では「moderate/low の対処を混ぜない」方針により意図的に見送り。
5. **T2 は欠番**。必要なら別途起票。
