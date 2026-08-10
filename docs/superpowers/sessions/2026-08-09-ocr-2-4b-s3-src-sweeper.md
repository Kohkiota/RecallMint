# ②-4b §3: `src/` age-based sweeper — 実装セッション記録(2026-08-09)

- spec(凍結): `docs/superpowers/specs/2026-08-09-ocr-2-4b-s3-src-sweeper-design.md`
- plan: `docs/superpowers/plans/2026-08-09-ocr-2-4b-s3-src-sweeper.md`
- Codex plan cross-check(1 パス): `docs/codex/2026-08-09-plan-ocr-2-4b-s3-src-sweeper.md`
- 範囲: `60ea6b5`(spec/plan 確定)..`f973098`(docs)。**未 push**
- 本 doc が **[reviewed] の正記録**(SDD ledger `.superpowers/sdd/` は git-ignored scratch ゆえ正本にしない)

## 1. 成果物

| commit | 内容 | tag |
|---|---|---|
| `a3b14cd` | Task1 — R2 listing の LastModified 拡張(`listObjectsWithMetaBounded`) | [reviewed] |
| `edd34b4` | Task2 — 失敗台帳 catalog に `src_sweep` lane の 3 entry(14→17) | [reviewed] |
| `e1091ad` | Task3 — 選定 pure 関数 `selectSweepTargets` | [reviewed] |
| `b6c9149` | Task4 — lane 本体 `runSrcSweepLane` | [reviewed] |
| `2c94264` | Task5 — cron runner route + `vercel.json` crons 配線 | [reviewed] |
| `f973098` | Task6 — docs(architecture.md / harness.md) | [no-review] |
| `8f6cf2a` | Codex raw findings(Task1 の 3 周ぶん) | [no-review] |

## 2. Sprint 完了 gate

- whole-repo `pnpm lint --max-warnings=0` **exit 0 確認済**
- `pnpm typecheck` **exit 0**
- whole-repo `pnpm test` **276 files / 4638 tests green**
- `pnpm test:iso` **30 files / 326 tests green 確認済**
- `pnpm build` **exit 0**(postbuild の pdfium packaging 検証も PASS。build 成果物で `functions-config-manifest.json` に `/api/cron/sweep` を確認)
- `pnpm run audit` **exit 1 — 本 sprint 由来ではない**(下記 §5)

## 3. 設計上の非自明判断(実装で確定したもの)

- **live 判定に既存 `hasLiveUploadOperation` を再利用しない**: 既存関数は DB error を握って `false` を返す。sweeper の極性では `false` = 「live でない」= **削除する**なので、再利用すると fail-safe が silent に反転する。専用関数 `hasLiveUploadOperationForSweep` を置き、理由を関数 doc に書いた
- **live=true の skip では phase を立てない**: phase 語彙は incomplete 行(打ち切りの記録)用で、live user の skip は設計上の「最大 1 日の回収遅延」= 正常動作。ここで incomplete 行を書くと live user が居る限り毎日 Discord が鳴り、§3.1 の「正常 run で通知を鳴らさない」に反する。前提破れの検知は 72h overdue alert が担う
- **`deadlineAt` は固定オフセット**(`now + SWEEP_BUDGET_MS`): request の残余予算から導出すると lane の zero-budget 経路が到達可能になり、phase が `list` に silent に誤ラベルされる。制約を route のコメントに残した
- **`run-lanes.ts` の分割理由**: stub lane の test seam を endpoint module の公開面に出さないため。**Next が追加 export を禁じるからではない**(下記 §4 参照)
- **台帳行 quota は種別独立**: mismatch の洪水が実削除失敗と overdue を抑圧しないため。§2 の heldFailure は採らない(quota 分離で不要)

## 4. review で摘出された欠陥(記録に値するもの)

### 4.1 「他の変異は全部 red なのに、これだけがすり抜ける」— live check の直前性(Task4)

canonical reviewer が 14 種の単一 gate 変異を隔離 worktree で実行し、13 種は red。しかし **全 user の live check を先に一括評価してから delete ループを回す refactor だけが 38 test 全 green ですり抜けた**。コードは正しかったが、正しさを固定する test が無かった。一括前倒しは spec §3.3 が段落を割いて bound している TOCTOU 窓を「数秒」から「listing + delete pass 全体」へ広げる。

**対処**: live でない user 2 人で完全交互を assert する test を追加(`[live:A, delete:keyA, live:B, delete:keyB]`)。

**教訓**: 順序の不変条件は、順序を崩しても**結果が同じになる**変異で検証しないと pin されない。単一 user / skip される user を使った順序 assert は前倒し refactor と区別できない。

### 4.2 分割理由コメントが事実として偽だった(Task5)

実装者は `run-lanes.ts` を分けた理由を「Next の route file は route export 以外を公開できない(build 時の route 型検査)」と書いた。canonical reviewer が隔離 worktree で **merged 形を実際に build して反証**(`pnpm build` exit 0 / `pnpm typecheck` exit 0)。

真相: Next 16 の Turbopack validator は `type __IsExpected<Specific extends RouteHandlerConfig<...>> = Specific` という**構造的**制約で、`extends` は追加プロパティを許す。反証は実装者自身のコードの中にあった — `runtime` / `maxDuration` は `RouteHandlerConfig`(7 method のみ)のメンバーでないのに現に通っている。厳密な field チェックは webpack 経路の `next-types-plugin` にのみ残存し、その header 自身が「DO NOT ADD NEW FEATURES TO THIS PLUGIN — DOING SO PREVENTS THEM FROM WORKING FOR TURBOPACK USERS」と書いている。本 repo は Turbopack build。

**対処**: file は残し(分割自体は test seam の理由で正当・`--webpack` なら必須)、コメントを真の理由へ差し替え。

**教訓**: 「◯◯が禁止しているから」という制約由来の設計理由は、**実際にその制約を破ってみる**まで検証されていない。誤った "why" は次の lane 追加時にそのまま継承される。

### 4.3 Codex が 3 周で毎回「新しい」Important を出した(Task1)

`Date.parse` の許容度について、Codex が周ごとに別の穴を指摘した: r1 = 閉じタグ欠落 `<Contents>` の silent drop / r2 = TZ 無し文字列を local 解釈(非 UTC ランタイムで age が最大 ±14h ずれ、**まだ生きている object を削除しうる**)/ r3 = 不可能な暦日(`2026-02-30`)を `Date.parse` が正規化。

canonical は r3 の指摘を独立に **Minor** と判定(「R2 自身が生成する field・攻撃者入力でない」)。severity が reviewer 間で割れた。

**CC 裁定 = fix**。理由: ① 破壊操作の入力である ② round-trip 暦検証は「format-valid だが意味が違う値」というクラス**全体**を構造的に終端させる(以後この方向の指摘が原理的に出なくなる)③ 低コスト。結果、最終形は 3 gate(`<Contents>` parity / R2 形式 regex / 暦 round-trip)。

**Codex は上限 3 周に到達したため、r3 の fix のみ Codex 再検証を受けていない**(canonical scoped re-review でのみ検証)。

### 4.4 検出力ゼロの test を実装者が自己申告した(Task5・Task3)

Task5: 「空 secret + `Bearer ` → 401」の test が**検出力ゼロ**だった(HTTP header 値は OWS trim され `Bearer ` を実 Request で表現できない)。header を素通しする fake request に変更して red を確認。
Task3: 「cutoff を 15min に縮めても overdue 不変」の最初の test が検出力ゼロだった(age=2h の case を足して discriminating に)。

いずれも実装者が黙って直さず報告した。reviewer はこれを「報告全体の信頼性を作っている」と評価。

## 5. audit gate fail — 本 sprint 由来ではない

`pnpm run audit` exit 1。内訳:
- **prod high**: `GHSA-2v37-7h3g-55p8`(`nanoid@3.3.16`)— 由来は `postcss` → `next@16.2.11` / `@clerk/nextjs`(prod は allowlist 不適用ゆえ無条件 fail)
- dev: `GHSA-5p4m-2wfm-xmqj`(`js-yaml@4.3.0`)/ 同 nanoid(allowlist 該当エントリなし)

**本 sprint は依存を一切変更していない**(`package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` の `60ea6b5..f973098` diff が空)。nanoid は §1 クローズ時点で既知の新規 advisory として記録済み。`nanoid@3.3.17` はツリー内に既に存在する(vite 系 postcss 経由)ため override で解ける可能性があるが、**依存 bump / allowlist 追加は別 sprint の OT 判断**(過去の `sharp<0.35.0` と同型の扱い)。

## 5.5 stg smoke — **全項目 PASS**(2026-08-09T23:47Z〜2026-08-10T00:04Z・CC 実走)

前提(OT 提供): stg = 通常の Preview(別 project の production ではない)→ **override 使用可** / Vercel plan = **Pro** / `CRON_SECRET` を Vercel(Development / Preview)へ登録 + redeploy 済 + 同値を `.env.local` へ追記。§4 判定完了により sentinel 保護は解除済。

実行経路: 認証付き GET は **tsx script + Node `fetch`**(`process.env.CRON_SECRET` を読むだけで出力しない)。listing readback は `listObjectsWithMetaBounded('src/', 10)` を同一 script 内で前後に実行。認証失敗系のみ Playwright の same-origin `fetch` で実施。

| # | 項目 | 実測 | 判定 |
|---|---|---|---|
| 1 | fixture staging | `+clerk_test`(= user `85541b25…`)で PDF を PUT のみ・submit せず離脱 → `src/85541b25…/e38bbde6…/d45f836b….pdf`(2026-08-09T23:48:35.458Z) | PASS |
| 2 | 離脱で消えないこと | 3 分後も在(× を押さない離脱は §1 の DELETE 対象外 = sweeper が受け皿になるべき残骸) | PASS |
| 3 | 誤 Bearer | **401** `{"error":"unauthorized"}` | PASS |
| 4 | header 無し | **401** | PASS |
| 5 | **誤 Bearer + `cutoffMinutes=14`** | **401(400 ではない)** = auth 先行が実機で成立 | PASS |
| 6 | 正 Bearer + `?cutoffMinutes=15`(1 回目) | 200 / `cache-control: no-store` / 1.1s。`listed:2 candidates:1 deleted:1 failed:0 skippedLiveUsers:0 patternMismatch:0 overdueCount:0 truncated:false phase:null recordErrors:0 cutoffOverrideMinutes:15` | PASS |
| 7 | listing diff(1 回目) | **sentinel B(age 22.83h)のみ消滅・fixture(age 11min)は残存** | PASS |
| 8 | 正 Bearer + 同上(2 回目・fixture が 15min 超過後) | `listed:1 candidates:1 deleted:1`。listing diff = **fixture 消滅・`src/` 0 件** | PASS |
| 9 | 空 listing での run | `listed:0 candidates:0 deleted:0` / 200 / 0.2s(候補ゼロ経路で異常なし) | PASS |

**この smoke が実証したもの**:

- **sweeper の実削除**(sentinel B の回収 = OT 裁定どおり「回収されればそれ自体が実削除の実証」)
- **cutoff 境界の判別が本番環境で効く**: **同一 object** が age 11.6min では残り、15.5min で削除された。境界を跨いだ前後を 1 つの object で観測できたのは設計上の偶然だが、`age > cutoff` の実機実証としては単独 fixture より強い
- **override の透過**: summary に `cutoffOverrideMinutes: 15` が載り、既定 run と区別できる(A1 の条件 ①)
- **overdue が override の影響を受けない**: cutoff を 15min に縮めても `overdueCount: 0`(B は 22.83h < 72h)。A1 の条件 ② が実機で成立
- **auth 先行**(#5)/ **no-store**(#6)/ **候補ゼロ経路**(#9)

**未実証(記録)**: 失敗系(DELETE 失敗・打ち切り・overdue 発火・live-op skip)は stg で自然発生させられず未観測。これらは unit test で pin 済(順序 pin / quota / phase 優先順位)。**scheduler の実発火は prod 反映後**(close 条件外・kickoff 確定)。

**台帳照会(OT・`integration_failures` は RLS で CC が読めない)**: 期待値 **0 行**。

```sql
SELECT created_at, service, operation, workflow, failure_code,
       user_id, context, error_message
FROM integration_failures
WHERE workflow = 'src_sweep'
ORDER BY created_at DESC
LIMIT 20;
```

読み方: `failure_code='external_api_error'` = 実削除失敗(`context.objectKey` / `status`)/ `'incomplete'` = 打ち切り(`context.phase`。**quota 超過のみの run は phase を持たない**)/ `'state_mismatch'` = 72h 超残存 alert。

## 6. 残作業(OT)

1. ~~push~~ **完了**(`f6ab301` まで OT が push 済)。**未 push は `07db1cb`(§4 判定確定)/ `b9ed6e4`(.env.example 並べ替え)/ 本 doc の smoke 追記**
2. ~~Vercel env `CRON_SECRET` 設定~~ **完了**(Development / Preview に登録 + redeploy 済)。§4 判定完了により順序則は解除済
3. ~~readback 2 件~~ **完了**: stg = 通常の Preview(override 使用可)/ Vercel plan = **Pro**(保持上限の式は Pro 定数 = 正常時 ≈30h / 前提つき worst ≈54.2h で確定)
4. ~~stg smoke~~ **完了・全項目 PASS**(§5.5)
5. **prod 反映判断**(smoke 結果を見て OT)。prod 反映時は `CRON_SECRET` を **Production scope にも**登録すること — 未登録だと production は 401 でなく **gate throw → 500**(§5.5 の tier 差)。cron は production でのみ発火するため、未登録なら日次 run が毎日 500 で失敗し続ける
6. prod 反映後チェックリストに「Vercel dashboard の cron 実行履歴を随時確認」を追加(dead-man 監視の代替・spec §13)
7. audit の prod high(nanoid)= 依存 sprint の OT 判断
8. 台帳照会(§5.5 の SQL・期待値 0 行)

## 7. follow-up(claude.ai todo へ渡す)

- `pnpm run audit` の prod high(nanoid via postcss/next)— override で解けるか含め依存 sprint で扱う
- mismatch loop の per-row 残予算 guard(現状は記録のみ。5 行 × 3s = 15s < 余裕 40s ゆえ incomplete 行を単独で潰せない、が根拠)
- 恒久の dead-man 監視(外形監視 / dead-man switch)— asset reconciler lane 追加 sprint で再訪
- `HEAD /api/cron/sweep` が実削除を走らせる(Next 16 の auto-implement)— harness.md に記録済。405 を明示するかは別途判断
