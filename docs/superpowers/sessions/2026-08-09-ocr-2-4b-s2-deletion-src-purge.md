# ②-4b §2 退会時 `src/{userId}/` prefix purge — 実装クローズ記録

- spec(r3・凍結): `docs/superpowers/specs/2026-08-09-ocr-2-4b-s2-deletion-src-purge-design.md`
- plan(r2): `docs/superpowers/plans/2026-08-09-ocr-2-4b-s2-deletion-src-purge.md`
- Codex raw: `docs/codex/2026-08-09-plan-ocr-2-4b-s2-deletion-purge.md`(plan cross-check)/
  `docs/codex/2026-08-09-ocr-2-4b-s2-task1.md` / `-task2.md`

## 1. commit 一覧(範囲 `82d9ec1..`・develop 未 push)

| commit | 内容 | tag |
|---|---|---|
| `6e27f2a` | 設計 spec(現物確認 4 点込み・OT 承認前) | no-review |
| `82d9ec1` | spec r2 = OT 裁定 3 点(上限必須化 / 1 件 1 行 / sentinel gate 手順化) | no-review |
| `3383b6e` | plan ドラフト + Codex cross-check raw findings | no-review |
| `b3dd726` | spec r3 / plan r2 = Codex 追補 4 点の OT 裁定 | no-review |
| `896ac35` | **Task 1**: `listObjectsBounded` 切り出し + `timeoutMs` 上書き | **reviewed** |
| `9390c4e` | spec §6 表の stale 修正(12→14・2 entry) | no-review |
| `e54e792` | **Task 2**: 退会 purge 本体 + 台帳 2 entry + `handlerStart` 伝播 | **reviewed** |
| `0b940b6` | architecture.md source 行に退会 purge を追記 | no-review |
| (本 doc と同 commit) | 最終 review Minor 2 = catalog コメントに `reason` を追記 | no-review |

## 2. 設計の要点(なぜこの形か)

- **到達保証 = 外周 `finally`**。`internalUserId` 確定後の本体(Stripe ループ + DB tx)を try で包む。
- **予算の原点 = `POST()` 冒頭**。`handlerStart` を**必須引数**で `handleEvent` → `handleUserDeleted` へ
  伝播し、`purgeDeadline = min(purgeStart + 20s, handlerStart + 50s)`。
- **台帳 2 entry**: `r2_deletion_src_delete`(結果 = object DELETE 失敗・1 行 = 1 失敗)/
  `r2_deletion_src_incomplete`(結果 = purge 未完遂・原因は `context.phase`)。
  **4 軸は原因でなく結果を識別する**という原則を OT 裁定で確立。
- **破壊境界の二重関門**: DELETE 直前に prefix 再検証。不一致は削除せず
  `reason: 'prefix_mismatch'` で記録(先例 = `scripts/gc-src-prefix.ts:38-47`)。

## 3. 現物確認が 1 段浅かった例(教訓)

r2 まで spec §2.1 に「`runTransactionWithRetry` は永続失敗でも throw せず return するので、
**後ろに置いたコードは必ず走る**」と書いていた。これは **誤り**:

- 確かに正常系では return する(`handle-clerk-event.ts:365-367`)。
- しかしその直前の `await onFailure(...)` は `recordFailure` → `recordIntegrationFailure` を呼び、
  同 helper は **`notifyOps` の throw(production で `OPS_DISCORD_WEBHOOK_URL` 未設定時の
  fail-fast)を意図的に伝播させる契約**(`lib/integration-failures.ts:139-141`)。
- → **C は throw しうる**。後置は到達保証にならない。

「return する」まで読んで止まり、**その関数が呼ぶ先の契約まで辿らなかった**のが原因。
OT 指摘で r3 にて撤回し、根拠を外周 `finally`(構造保証)に差し替えた。
**個別 site の隔離を採らなかった理由**も同じ族: それは「現在と将来の全 record site を監査し続ける」
性質の保証で、単一点主張が無言で偽になる型。

## 4. review 実績

- **Task 1**: canonical(sonnet)Ready・Crit0/Imp0/Minor2。文言 byte 一致 / 既存 test 0 削除 /
  全 caller 無改変を reviewer が独立検証。Codex clean。
- **Task 2**: canonical(opus)With fixes → **Imp3**(① 記帳の残予算 gate が検出力ゼロ
  ② `phase` 優先順位の比較が一度も実行されていない — しかも `list_truncated`+`deadline` は
  構造上最も起きやすい組合せ ③ prefix 外 key が delete lane を汚染 + `status:null` に
  `errorMessage`)→ fix r1 → re-review all addressed。
- **Codex が canonical も CC も見落とした P1 を検出**(§5)→ fix r2 → re-review が上界を
  **算術で独立証明** → Codex 2 周目 clean。
- **最終 whole-branch(fable)**: **Ready to merge・Crit0/Imp0/Minor4(全て残置可)**。
  20 行 cap を 6 シナリオ hand-trace、§1/§2 の相互作用(両 lane とも 404 冪等・trigger が
  disjoint・台帳 workflow で分離)も確認。

## 5. Codex P1(dual-review が効いた 3 例目)

**`listObjectsBounded` の `timeoutMs` は page ごとに適用される**(helper 内の loop で
`AbortSignal.timeout(timeoutMs)`)。caller が一度だけ計算して渡すと最悪
`maxPages × timeoutMs` かかり、**不変条件 5(purge は有限時間で終わる)が破れる**。
残予算 12s → `min(10s,12s)`=10s → 2 page で最悪 20s。tail reserve で確保したはずの
incomplete 行すら書けなくなる経路だった。

修正 = caller 側で `min(LIST_TIMEOUT_MS, floor(残予算 / maxPages))`(`maxPages × 取り分 ≤ 残予算` が
1 行で閉じる)+ **`r2.ts` の doc に「per page 適用」を明記**(次の budgeted caller への予防線)。
helper に絶対 deadline を持たせる案は、「deadline 由来の打ち切り」と「page 上限由来の truncated」が
同じフラグに潰れて phase 判別が濁るため不採用。

## 6. gate 結果(2026-08-09)

- whole-repo lint(--max-warnings=0)exit 0 / typecheck 0 / build 0
- full `pnpm test` **4551 green**(274 file)/ `pnpm test:iso` **326 green**
- **`pnpm run audit` = fail(本 branch 無関係)**: prod high `nanoid@3.3.16`
  GHSA-2v37-7h3g-55p8 + dev js-yaml/nanoid。**lockfile / package.json は `b3dd726..HEAD` で
  diff ゼロ**(実測)= 上流の新規公表。§1 と同一事案で deps 基線 sprint の対象。

## 7. 残余(全て bounded・残置可 triage 済)

- M-3 purge 大域 catch に台帳行なし(到達には二重の契約違反が要る)/ M-5 `no_budget` 行の記帳が
  無予算(裁定 5 が timeout 配管を明示的に見送り)/ M-6 21+ 失敗のみで `phase` が undefined
  (語彙追加は OT 判断の spec 変更)/ M-8 worst ~20s 延伸(予算設計の意図どおり)
- 最終 review Minor: 1 = held 20 行目の書込に slice gate が効かない(最大 1 件・M-5 と同族)/
  3 = task-2 report §2.1-3 が fix 前の記述で stale(scratch ゆえ本 doc は**コードと test から**書いた)/
  4 = architecture.md が §3 sweeper を受け皿として挙げるが **§3 は未実装**(下記)
- **`LIST_TIMEOUT_MS === DELETE_TIMEOUT_MS`(10s)ゆえ「LIST/DELETE 取り違え」変異は検出不能**。
  min-binding の 2 pin が方向を独立に押さえているので、**この 2 pin を 1 本に統合しないこと**。

## 8. stg smoke(OT push 後・spec §8.1 の手順)

**退会は破壊操作かつ不可逆。専用の使い捨て test account を新規作成して行う。**
既存 smoke アカウント(`85541b25…`)は **lifecycle 観測 sentinel 2 本を prefix 配下に持つ**ため、
これで退会すると sentinel を巻き込む(8/11 まで不可触の制約違反)。

1. CC: `src/` を listing し sentinel の userId を控える
2. CC: 新 test account を作成し内部 userId(uuid)を取得
3. **CC: gate — 手順 2 の userId が手順 1 と一致しないことを verify。一致したら中止**
4. CC: PDF を数冊 staging(submit しない)→ 件数 n を記録
5. **OT: Clerk dashboard から退会**
6. CC: `src/{testUserId}/` が 0 件 / 7. CC: sentinel 2 本が lastModified 込みで不変

0 件でない場合は **spec §8.3 の切り分け**(後着地 PUT → 台帳 → 実装不良 の順)に従い、
即「実装不良」と断じない。台帳確認(`service='r2'` かつ `workflow='user_deletion'` の行が
無いこと)は OT 照会(app role は SELECT 42501)。
