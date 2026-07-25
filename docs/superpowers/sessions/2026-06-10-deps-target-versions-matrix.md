# RecallMint 依存ターゲット版 確定マトリクス (2026-06-10 v1.3)

> **⚠️ SUPERSEDED（2026-07-25）**: pin 方針・目標版・audit gate 構造の正本は **v2 = `docs/superpowers/sessions/2026-07-25-deps-target-versions-matrix-v2.md`** に移行。本 v1.3 は Next16/ESLint9/波1-2 のクローズ記録・§7 の 2026-07-23 snapshot として履歴保持する(§3 の目標版は v2 で確定版へ更新済ゆえ参照しない)。

> **本 file が正本**。 改訂時は repo 側を更新し、 OT が claude.ai プロジェクトナレッジへ同期する。

> **進捗(2026-07-23 更新)**: **next+sharp のみ先行 bump 実施**(画像表示 UX sprint 中の PhotoSwipe de-risk で audit high 5 検出 → 分離対応)。next `16.2.9→16.2.11`(security patch・GHSA proxy-bypass/DoS/SSRF×2)+ eslint-config-next 同版 lockstep + **sharp override `^0.35.0`(→0.35.3 解決)追加**(next の `optionalDependencies.sharp` が ^0.34.5 のままゆえ next bump では解消せず別途)。react/react-dom は要求不変ゆえ据え置き(実測)。audit high 5→0・6 gate green。**波3 は未実施**(実害なし・変更源分離のため据え置き。実施可否は別途)。実物差分は §7 スナップショット参照。台帳 = `docs/audit/dependency-audit-ledger.md`「解消済(2026-07-23)」。

> **進捗(2026-06-11 更新)**: **波1 (Next 16 核) ✅ クローズ済 / 波2 (ESLint 9 + lefthook) ✅ クローズ済、 両方 prod deploy + P0/P1 secret rotate 済**。 残波 = **波3 (TS6 + Stripe 22.2.0 + minor 群)**。 波1 の Clerk 着地版は **7.5.1** (当初 7.4.3 を選定したが `@clerk/react` との dep declaration 不整合で build fail、 7.5.1 で解消。 詳細は §3.1 メモ + `docs/superpowers/lessons/2026-06-11-dep-declaration-bug-build-only-detection.md`)。 波1 plan 順序は実装中改訂で C1 → **C4 (pre-step)** → C2 → C3 → C5 → C6 (`docs/superpowers/lessons/2026-06-11-version-context-in-impact-evaluation.md` 参照)。

> **進捗(2026-06-10)**: **波2(ESLint 9 flat config + lefthook gate)実装完了 → develop 10 commit・push/stg smoke 待ち**。`next lint` → `eslint .` 移行済。残り = 波1(Next 16 核)→ 波3(TS6/Stripe/minor)。
> **v1.3 の訂正**: **GitHub Actions(ci.yml)は不採用に変更**(当初の「CI gate」案を撤回)。lint gate は **lefthook(pre-commit コンテナ内)+ sprint 完了 gate(review checklist 強制)の2層**に確定。pre-push も不採用(チェックは push トリガーでなく完了トリガー)。理由 = PR なし運用で GHA は blocking gate にならない + Next 16 で build 時 lint 廃止。将来 PR 運用化/増員時は git 履歴から復活可。§2/§3.2 を反映。
> **v1.2 の訂正(doc drift)**: packageManager を「不在 → 波1 で追加」から **「既存(`pnpm@10.33.0`)、波2 で SSoT 確認済」** に訂正。
> 確定経緯: CC が package.json + pnpm registry で実値調査 → claude.ai 戦略レビュー → Fable + GPT で 2 巡 cross-check → 本書に確定。
> **正本** = 本書。各波の spec は CC がこれを起点に起こす。pin 番号は CC が registry 実値で確定したもの。**[exact] と書いた値で `^` を付けない**（"確定版"の意味に忠実 + lockfile 消失時の patch ドリフト防止）。一部の exact 値（pnpm 実版・@types/node の 24 系最新 patch 等）は CC が install 時に registry で確定して埋める。
> v1.1 の反映: **packageManager は exact 必須**(corepack 仕様、range 不可) / **eslint-config-next bump は波1 所属**(波2 は現行 config のまま) / **ローカル install と CI frozen install を分離** / **型・テスト・migration 系も exact** / **Vercel の Node 設定確認を追加** / Turbopack 切り分け用 `--webpack` fallback。

---

## 1. 確定方針（選定理由つき）

| 決定 | 理由 |
|---|---|
| Next 16.2 系へ移行 | 15 は **2026-10-21 EOS / Maintenance LTS**(critical + security のみ)。16.x が Active LTS。長期の住処にしない |
| React 19.2 系最新 patch | Next 16 要求 + RSC 重大 CVE 床(Next 16.2.6 / react-server-dom 19.2.6 以降)超え。19.2.5→19.2.7 で 2 patch 遅延 |
| ESLint **9 維持**（10 不採用） | eslint-config-next 同梱 plugin(react 7.37.5 / import / jsx-a11y)が peer `eslint ^9` 頭打ち。10 は unmet peer + 公式 issue(vercel/next.js #91702)open。flat config 化は **9 で達成可**(9 から flat が default)。10 化の実利ゼロ |
| dnd-kit legacy 維持 | 新 `@dnd-kit/react` は 0.x(1.0 前・API churn)。legacy 6.3.1 線が安定・React 19 動作確認済 |
| TanStack Table **v8**（将来・未 install） | v9 は alpha。安定優先で v8 |
| React Compiler **OFF 維持** | Compiler が `useReactTable` を incompatible 検出して bail out、TanStack 自身が v8 非互換を認め v9 再設計中。Babel 依存で build 時間増、得るもの薄い |
| TS 6 系 | 既に 6.0.3 install 済。Next 16 要求は ≥5.1 だが 6 で運用中ゆえ維持。typescript-eslint の対応 range(`>=4.8.4 <6.1.0`)内 |
| Node 24 LTS | 2025-10 から active LTS。devcontainer も 24.13.0。Vercel 新規 default も 24.x。開発/本番を 24 に統一 |
| コアは **exact pin** | lockfile 消失で patch ドリフトしない。react/react-dom は **同 patch pair を overrides 固定** |
| @google/genai 1.x 維持 | 2.x major は OCR 挙動差リスク本体。**OCR 自動タグ(Tag-3)sprint で 2.x と一緒に**評価 |

---

## 2. sprint 分割（変更源を分ける）

> 一括 bump は失敗時の切り分けが重い。独立に壊れうる塊を波で分離。成功条件は「install できる」でなく **auth/billing/OCR/同期/画像/RSC perf が smoke で通る**こと。

```
波2(lint gate) ── 先行推奨 ──> 波1(Next 16 核) ──> 波3(TS6 + Stripe + minor)
```

### 波2: ESLint 9 flat config + lefthook gate（✅ クローズ済、 波1 と一括 push/prod deploy 済 2026-06-11）
- **先行理由**: 波1 の大量 diff を gate 付きで通せる。旧方針「Grid-1 前に lint gate」とも整合。Next 16 で `next lint` 削除 + build 時 lint も消えるため、**lefthook(commit を止める)+ sprint 完了 gate が検出経路**になる。
- 内容: `eslint.config.mjs`(flat、`eslint-config-next/core-web-vitals` + `/typescript` extend)/ lefthook ^2.1.9(新 devDep、pre-commit、コンテナ内 staged のみ)/ package.json `"lint": "eslint . --max-warnings=0"`。
- **GitHub Actions(ci.yml)は不採用**(当初案を撤回): PR なし運用で required check は blocking gate にならない + Next 16 で build 時 lint 廃止。Vercel build にも lint を載せない。pre-push も不採用(push 場所がコンテナ/WSL で揺れるため、チェックは完了トリガーに置く)。将来 PR 運用化/増員/protected branch 移行時は git 履歴から復活可(SHA)。
- **lint gate = 2層(全てコンテナ内)**: ① lefthook pre-commit ② sprint 完了時 whole-repo `pnpm lint` exit 0 必須(review checklist で強制、staged-only の穴を塞ぐ)。CLAUDE.md に恒久規律化(`--no-verify` 禁止 / 依存触る sprint は `--frozen-lockfile` + typecheck + build も完了 gate)。
- **eslint-config-next は現行(16.2.4)のまま**で組む（bump は波1）。**一筆: 「config 16.2.4 / next 15.5 の組合せは一時状態。`@next/eslint-plugin-next` は next への hard peer を持たないので実害ほぼなし。波1 で next・config を同時に 16.2.9 へ上げて解消する」** — CC が迷わないよう spec に明記。
- **着手前**: 既存違反が大量に出たら(前 ESLint Step0 の red flag)、波1 の前に「既存違反処理(rules-of-hooks 系は error / 残りは warn から)」が挟まる。件数を見て段階導入。
### 波1: Next 16 核（✅ クローズ済、 prod deploy + P0/P1 rotate 済 2026-06-11）
- next / **eslint-config-next(ここで 16.2.9 へ)** / @clerk/nextjs (**7.5.1 で着地**) / react / react-dom / @types/react / @types/react-dom / Node 24 / engines / packageManager。
- middleware.ts → **proxy.ts**(Node runtime 固定)。codemod は使用せず手で正確 pin (Step 0 dry-run でソース変換 0 件と確認、 codemod が package.json に追加する `pnpm.overrides` block は workspace.yaml SSoT と衝突するため不採用)。
- plan 順序は実装中改訂で **C1 → C4 (pre-step) → C2 → C3 → C5 → C6** (C2 build gate で Next 16 Turbopack default の「webpack config 検出 + turbopack config 不在 → build fail」 ガードを検出、 C4 webpack block 削除を C2 の前提化)。
- 初回 stg deploy は Vercel build cache 無効で 1 回実施済。
- stg smoke (§5) 全 pass、 prod deploy 済。 deploy 後 OT P0 (Clerk session 系 rotate + 全 session sign-out) + P1 (Stripe Webhook signing secret) rotate 完了。
- 主要 commit: C1=`f36f164`、 C4=`21a20a7 [reviewed]`、 C2=`49bff77 [reviewed]`、 C3=`390d194 [reviewed]`、 C5=`56b3f69`、 C6=`1ffe921`、 後始末 docs=`ed77418`、 lefthook `--no-warn-ignored` 補強=`96797ee`、 Clerk 7.4.3 → 7.5.1 改訂 docs=`8e4acfb`。
### 波3: TS6 + Stripe22 + minor 群（独立 PR、 残波、 2026-06-11 時点で着手前）
- TS6 は「Next 16 の一部」でなく **TS6 migration として独立**。`tsc --noEmit` 通過確認。
- Stripe 22.2.0 は**同 major(22)の minor bump**。pinned apiVersion が変わるのは major 時ゆえ、**「apiVersion 別 commit」警戒は実質発動しない見込み — webhook/subscription/downgrade の smoke 再実行で足りる**。
- minor/patch 群(§3.3)はまとめて chore 1 commit 可。
### 別 sprint（本マトリクス外・既定）
- **OCR 自動タグ(Tag-3) + @google/genai 1.x→2.x** を束ねる(OCR 領域をまとめて調査・smoke)。
---

## 3. 確定マトリクス

凡例: pin 表記は package.json 記載値。**[exact]** = キャレットなし固定。**[exact*]** = exact だが値を CC が registry 実値で確定。D=dependencies / V=devDependencies / T=transitive。

### 3.1 波1: Next 16 核

| パッケージ | 現状 | ターゲット pin | 種別 | メモ |
|---|---|---|---|---|
| next | ^15.5.15 | **16.2.11 [exact]** | D | 15 EOS 回避。codemod 移行。**2026-07-23: 16.2.9→16.2.11 security patch**(GHSA proxy-bypass/DoS/SSRF×2) |
| eslint-config-next | ^16.2.4 | **16.2.11 [exact]** | V | **波1 で next と同時に bump**(波2 では現行 16.2.4 のまま)。**2026-07-23: next と lockstep で 16.2.11** |
| react | ^19.2.5 | **19.2.7 [exact]** | D | CVE 床超え。overrides で固定 |
| react-dom | ^19.2.5 | **19.2.7 [exact]** | D | react と同 patch pair 必須。overrides 固定 |
| @types/react | ^19.2.14 | **19.2.17 [exact]** | V | 型は patch でも型エラーを増やしうる → exact |
| @types/react-dom | ^19.2.3 | **19.2.3 [exact]** | V | **react とペア必須**(Next 16 guide 明記) → exact |
| @clerk/nextjs | ^7.2.4 (install 7.2.9) | **7.5.1 [exact]** | D | 7.2.9 でも Next 16 peer 満たすが、proxy.ts 公式例 base に追従。当初 7.4.3 を選定したが、7.4.3 は dep declaration (`@clerk/react ^6.7.3`) と実 import (`ConfigureSSO`) の不整合で build fail。7.5.1 (`@clerk/react ^6.9.0`) で解消。発見経路 = C4 の per-task build gate (2026-06-11) |
| @types/node | ^25.6.0 | **24.x.y [exact*]** | V | Node 24 と整合(25=odd/current から落とす)。CC が最新 24 系 patch を exact 確定 |
| (engines.node) | 不在 | **"24.x"** 明示 | — | `>=24` でなく 24 系固定 |
| (packageManager) | **既存 "pnpm@10.33.0"** | **維持(波2 で SSoT 確認済)** | — | corepack 仕様で range 不可・完全 semver。波2 Task 3 Step 0 で現物確認、CI は pnpm/action-setup version 省略で自動読み。**SSoT = package.json の 1 箇所のみ** |

### 3.2 波2: lint gate

| パッケージ | 現状 | ターゲット pin | 種別 | メモ |
|---|---|---|---|---|
| eslint | ^9.39.4 | **9.39.4 [exact]** | V | **9 維持**(10 は eslint-config-next 同梱 plugin が peer `^9` 頭打ち) |
| eslint-plugin-react-hooks | 7.1.1 (T) | **^7.1.1**(direct 化推奨) | V | T3 hook order 検出 + useEffectEvent lint。transitive→direct devDep で drift 事故回避 |
| lefthook | 未 install | **^2.1.9**(新規) | V | pre-commit hook(コンテナ内 staged のみ)。sprint 完了 gate と二段(GHA は不採用) |
| — | — | — | — | **eslint-config-next は波2 では bump しない**(波1 で 16.2.9)。typescript-eslint は eslint-config-next 経由(下記注) |

> typescript-eslint: eslint-config-next 経由で入る版の supported TS range は `>=4.8.4 <6.1.0` で **TS 6.0.3 は範囲内**。CC 確認は「parser warning が出ないことを gate で確認」に限定(対応自体は range 内で確定)。

### 3.3 波3 + minor/patch 群（独立 PR）

| パッケージ | 現状 | ターゲット pin | 種別 | メモ |
|---|---|---|---|---|
| typescript | ^6.0.3 | **6.0.3 [exact]** | V | TS6 migration として独立。`tsc --noEmit` 通過確認 |
| stripe | ^22.0.2 | **22.2.0 [exact]** | D | 同 major の minor bump。apiVersion 変更は実質なし、smoke 再実行で足りる |
| svix | ^1.91.1 | **^1.95.2** | D | minor。Clerk `verifyWebhook` 内蔵で削減検討余地(任意) |
| drizzle-orm | ^0.45.2 | **^0.45.2** | D | 最新 |
| drizzle-kit | ^0.31.10 | **0.31.10 [exact]** | V | **orm とペア固定**(migration 差分事故回避) → exact |
| vitest | ^4.1.5 | **4.1.8 [exact]** | V | coverage と exact pair |
| @vitest/coverage-v8 | ^4.1.5 | **4.1.8 [exact]** | V | vitest と exact pair |
| pg | ^8.20.0 | **^8.21.0** | D | 用途明文化(migration/Supabase 用)。app runtime は postgres-js |
| postgres | ^3.4.9 | **^3.4.9** | D | 最新。app runtime driver(prepare:false) |
| dexie | ^4.4.2 | **^4.4.3** | D | patch |
| dexie-react-hooks | ^4.4.0 | **^4.4.0** | D | 最新 |
| ts-fsrs | ^5.3.2 | **^5.4.1** | D | minor |
| radix-ui | ^1.4.3 | **CC 確認後**(umbrella ^1.5.0 か個別 @radix-ui/react-*) | D | 実 import が個別なら個別 package を明示 |
| lucide-react | ^1.14.0 | **^1.17.0** | D | minor |
| tailwindcss | ^4.2.4 | **^4.3.0** | V | @tailwindcss/postcss と版同期 |
| @tailwindcss/postcss | ^4.2.4 | **^4.3.0** | V | tailwindcss とペア |
| tailwind-merge | ^3.5.0 | **^3.6.0** | D | minor |
| tsx | ^4.21.0 | **^4.22.4** | V | minor |
| class-variance-authority / clsx / tw-animate-css / browser-image-compression / server-only / bufferutil / utf-8-validate | — | **現状維持(最新)** | D | bump 不要 |
| @vitejs/plugin-react / jsdom / fake-indexeddb / dotenv / @testing-library/* / @types/pg | — | **現状維持** | V | — |

### 3.4 維持（変更しない・確認のみ）

| パッケージ | pin | メモ |
|---|---|---|
| @dnd-kit/core | ^6.3.1 | legacy 線最新。触らない |
| @dnd-kit/sortable | ^10.0.0 | 同上 |
| @dnd-kit/utilities | ^3.2.2 | 同上 |
| @dnd-kit/accessibility | 3.1.1 (T) | core 経由。直接 install 不要 |
| React Compiler / babel-plugin-react-compiler | 未設定/未 install | **OFF 維持**。reactCompiler:true にしない |

### 3.5 package.json / overrides（v1.1 確定形）

**package.json に追加**(engines + packageManager):
```json
{
  "engines": { "node": "24.x" },
  "packageManager": "pnpm@10.33.0"
}
```
- `pnpm@10.33.0` は波2 で現物確認済の devcontainer 実版(SSoT)。**range 不可・完全 semver**。波1 で `.devcontainer/post-create.sh` の `npm install -g pnpm`(version 未指定 = latest = drift リスク)を corepack 化 or version 明示する TODO あり。
**overrides は既存の `pnpm-workspace.yaml` に追記**(repo の既存配置を踏襲):
```yaml
overrides:
  react: 19.2.7          # 追加: react/react-dom を同一版固定
  react-dom: 19.2.7      # 追加
  uuid: ^14.0.0          # 既存
  postcss: ^8.5.10       # 既存(tailwind4 + Next build)
  # 2026-07-21: vite 8.0.16(GHSA-fx2h・台帳「解消済」)
  # 2026-07-23: sharp ^0.35.0(GHSA-f88m・next の optionalDependencies 由来 transitive・台帳「解消済(2026-07-23)」)
```
- **lockstep 注記**: 以後 next の patch bump で react 要求が上がったら **overrides も同時更新**。忘れると install は通るのに古い react に固定され続ける(唯一の罠)。**2026-07-23 実測**: 16.2.9→16.2.11 では react/react-dom 要求不変(`^19.0.0`)ゆえ override 更新不要だった。
### 3.6 future（未 install・制約のみ記憶）

| パッケージ | 制約 | 補足 |
|---|---|---|
| @tanstack/react-table | v8 | Grid sprint で追加。v9 alpha 不採用。`columns`/`data`/`state` の参照安定化テスト要 |
| @tanstack/react-virtual | v8 と組む現行安定 | 同上 |
| babel-plugin-react-compiler | 入れない | Compiler OFF 維持ゆえ不要 |

---

## 4. CC 確認事項（波着手前・実コードで裏取り）

1. **prod の Next patch 履歴 + CVE 曝露の精緻化**: `next <=15.5.6` で公開稼働した期間 / 外部入力可能な RSC endpoint の有無 / server action 利用有無 をセットで確認。**曝露があった場合のみ**、対象 CVE に応じて Clerk / Stripe / DB URL / Gemini / R2 secret を**優先順位付きで** rotate（一律 rotation は過剰になりうる）— OT 対応。
2. **radix の実 import**: umbrella `radix-ui` か個別 `@radix-ui/react-*` か。確定リストを実 import に合わせる。
3. **pg / postgres 責務**: app runtime が postgres-js 単独か。pg は migration/Supabase 用途に限定でき devDep 降格可か。**client bundle に DB driver が漏れていないか** build 確認(Turbopack default で `fs` 解決不能の恐れ)。
4. **Turbopack 境界 grep 監査**: client component から lib/db / stripe / clerk server / pg / postgres を import していないか。
5. **Clerk #8302**: 7.4.3 で `auth.protect()` の未ログイン redirect バグ(現 URL に留まる=保護バイパス、pnpm workspace で報告)が直っているか。最悪は §5 smoke で担保。
6. **pnpm 実版**: ~~packageManager に入れる完全 semver を確定~~ → **波2 で確定済(`pnpm@10.33.0`)**。波1 で post-create.sh の latest install を corepack 化。
7. **@types/node の最新 24 系 patch**: exact 値を確定。
8. **ESLint 9 既存違反件数**: flat config 投入時の違反数(波2 の段階導入判断)。
9. **package drift 検出**: 本マトリクスと package.json の照合。最低 `pnpm list --depth 0` の出力を PR に貼る(md と manifest の乖離防止)。
**OT 確認（CC でなく OT 環境）:**
- **Vercel の Node.js version 設定 = 24.x**。engines は devcontainer/ローカルにしか効かない。Vercel Function runtime は project settings 別管理 → **波1 deploy 前に設定一致を確認**。
---

## 5. 波1 stg smoke checklist（auth/billing/OCR/同期/画像/perf）

> 合否は smoke 通過で判定。**未ログイン redirect を筆頭**に。

1. **[筆頭] 未ログインで保護ルート直アクセス** (`/app`, `/app/exams/{id}`, `/api/review-events/bulk` 等) → **sign-in に飛ぶ**(現 URL に留まらない = #8302 回帰確認)。
2. ログイン後 `/app` 表示 / カード編集 / **タグ並べ替え**(dnd-kit が Next 16 で動くか)。
3. 5問回答 → **bulk flush**(entity-mutations 同期)。
4. Stripe **plan 変更 / downgrade**(波3 で Stripe bump 時は再実行)。
5. **OCR upload**(画像 → Gemini → カード生成)。
6. **R2 画像表示**(next/image 経路: remotePatterns / quality / 署名付き URL / local preview)。Next 16 の next/image default 変更の影響確認。
7. **`?_rsc` prefetch 数の再計測**(Resource Timing)。Next 16 prefetch 改善後も dynamic Link 並列爆発(過去 5〜9 並列が navigation 遅延の主因)が再発しないか。`prefetch={false}` 方針維持候補。
8. **matcher 確認**: proxy.ts の matcher に `/(api|trpc)(.*)` と `/__clerk/(.*)` が残っているか。`skipMiddlewareUrlNormalize`→`skipProxyUrlNormalize` rename。
**失敗基準（出たら縮退）**: `pnpm install` の peer 警告が解消不能 / `auth.protect()` が未ログインを通す / `pnpm build`(Turbopack)で client/server import 境界エラー / Stripe webhook smoke 落ち。
→ **縮退方針**: 波1 を **Next 16 + React 19.2 + Clerk 7 + Node 24 + proxy.ts のみ**に絞る(TS6=波3 / ESLint=波2 は既に分離済)。Turbopack 起因か依存起因かの切り分けに **`next build --webpack` を一時許可**(恒久回避にはしない)。

---

## 6. 移行 gate コマンド順（波1）

**ローカル（依存変更 PR の作業）** — lockfile 更新を許す:
```bash
pnpm install         # --frozen-lockfile は付けない(初回は lockfile 更新が必要)
pnpm lint            # eslint . --max-warnings=0 (波2 で新設済)
pnpm typecheck       # tsc --noEmit
pnpm build           # Turbopack default。切り分け時のみ next build --webpack
pnpm test
```

**sprint 完了 gate（コンテナ内、依存変更 sprint）** — lockfile 固定を強制(GHA は不採用ゆえこれが frozen install の代替):
```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

→ 通過後に §5 stg smoke（初回は Vercel build cache 無効で 1 回）。

---

## 付記: claude.ai 固定制約の誤りと是正（記録）

CC 調査で判明した、claude.ai が記憶ベースで出した固定制約の誤り。**今後、版の前提は CC に registry/manifest で取らせてから固定制約化する**(記憶で版を断定しない)。

| 制約(誤) | 正 |
|---|---|
| TypeScript ≥5.1(5.x 系) | **TS 6 系**(6.0.3 install 済) |
| zod は v3 か | **既に v4**(4.4.x、migration 完了済) |
| Node 22 LTS | **Node 24 LTS**(2025-10〜、22 は maintenance) |
| ESLint 9.x(最新前提) | **現行 major は 10**。ただし eslint-config-next 互換で **9 維持が正**(別理由で結論一致) |
| Gemini SDK 旧 `@google/generative-ai` か | **既に新 `@google/genai`**(移行完了済) |

---

## 7. 2026-07-23 実物差分スナップショット(next+sharp bump 時点)

next+sharp 先行 bump に伴う「マトリクス(6/10)target と実物」の差分記録。**target は消さず据え置き**、ズレが読み取れる形で残す。

**(a) 波3(TS6+Stripe+minor)= 6/10 時点の目標のまま未実行・据え置き**(実施可否は別途判断)。実物が target 未満 = stripe(実 `^22.0.2` / target 22.2.0)・svix(`^1.91.1` / `^1.95.2`)・vitest / @vitest/coverage-v8(`^4.1.5` / 4.1.8)・dexie(`^4.4.2` / `^4.4.3`)・ts-fsrs(`5.3.2` exact / `^5.4.1`)・radix-ui(`^1.4.3` / `^1.5.0`)・lucide-react(`^1.14.0` / `^1.17.0`)・tailwindcss / @tailwindcss/postcss(`^4.2.4` / `^4.3.0`)・tailwind-merge(`^3.5.0` / `^3.6.0`)・tsx(`^4.21.0` / `^4.22.4`)。理由 = 変更源分離(今回目的は audit gate 通過のみ)。

**(b) pin 様式 drift(事実記録のみ・今回未修正)**: matrix `[exact]` 指定に対し実物が caret = typescript(`^6.0.3`)・eslint(`^9.39.4`)・@types/node(`^24.13.2`)・drizzle-kit(`^0.31.10`)。lockfile で解決版 pin ゆえ機能影響なし。exact 化判断は波3 or 別途。

**(c) matrix 以後に追加された dep(install 済・matrix 未記載)**: aws4fetch(R2/画像)・react-markdown / remark-gfm / remark-parse / unified(Sprint T MD 表)・shadcn・photoswipe(画像表示 UX sprint・§3.1 と別 commit)。§3.6 future の @tanstack/react-table(`8.21.3`)・@tanstack/react-virtual(`3.14.5`)は **install 済に昇格**。

**(d) pg = 実物に無い**: matrix §3.3 は `pg ^8.21.0` を記載するが、現 package.json に `pg` 依存なし(app runtime は `postgres` のみ)。§4.3「pg 降格/削除可」判断が削除方向で着地したものと解する(実測: 依存なし)。
