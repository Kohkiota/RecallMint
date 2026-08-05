# ②-4a S-5: 旧経路撤去 + source_assets drop + `src/` 一掃 script(2026-08-05)

sprint ②-4a の最終 task。plan = `docs/superpowers/plans/2026-08-04-ocr-2-4a-single-invocation.md` Task S-5。
ledger = `.superpowers/sdd/2026-08-04-ocr-2-4a-single-invocation/progress.md`。

**状態 = 全 commit 済・未 push。** range `a47d01b..312cb3a`(74 file / +4,845 / −10,615)。

## commit

| commit | 種別 | 内容 |
|---|---|---|
| `7bb5e79` | feat [reviewed] | `listObjects(prefix)` + `scripts/gc-src-prefix.ts`(追加項目 C) |
| `9ee2692` | docs [no-review] | S-5a Codex findings |
| `80ef3b4` | feat [reviewed] | 旧経路撤去 + migration 0032 + 追加項目 A / B |
| `0b08660` | docs [no-review] | S-5b Codex findings |
| `3abe983` | fix [reviewed] | 0032 に `lock_timeout` + 撤去後に古くなった記述の訂正 |
| `312cb3a` | docs [no-review] | RLS 台帳更新 + 申し送り + Codex findings |

## 着手 gate

S-4 + I-3(b) の push(`origin/develop` = `a47d01b`・未 push 0)+ stg smoke 必須 5 項目 全 PASS
(`.superpowers/sdd/2026-08-04-ocr-2-4a-single-invocation/s4-stg-smoke.md`)。

---

## 1. 撤去したもの

### 削除 file(17)

production 9: `prepare-upload.ts` / `claim-operation.ts` / `stage-prepared.ts` /
`publish-prepared-orchestrate.ts` / `source-asset-actions.ts` / `abandon-operation.ts` /
`lib/media/source-purge.ts` / `lib/media/domain/source-asset-state.ts` +
`gc-image-assets.ts` の source lane と `crop-and-store.ts` の旧 entry `cropFigureAndStore`(部分削除)。

test 8: `source-asset-actions.test.ts` / `source-asset-state.test.ts` /
iso の `abandon-operation` / `claim-operation` / `gc-source-assets` / `prepare-upload` /
`source-asset-finalize` / `source-purge` / `stage-prepared`。

**削除理由の別**:

- **対象消滅**(保証減ではない)= 上記のうち `prepare-upload.test.ts` 以外の全て。テスト対象の関数・module が消えたため。
- **移植してから削除** = `prepare-upload.test.ts`。supersede 系 3 保証(completed op 不干渉 / mixed-state / multi-op supersede)が `submit-upload.test.ts` へ**未移植だった**ため、移植して red を取ってから削除した。canonical reviewer が旧 test を `git show` で読み、assert が弱まっていないことを 1 対 1 で確認済(completed の seed は lease 付きで**強化**されている)。

### migration 0032(**不可逆**)

```
SET LOCAL lock_timeout = '5s'
→ 旧 status(awaiting_sources / claimed)の非終端 op を terminal 化
→ asset_derivations.source_asset_id 列 drop(FK 本体)
→ DROP TABLE source_assets
→ upload_operations_next_retry_idx + next_retry_at 列 drop
→ upload_operations.status の DB default を 'processing' へ
```

- 先頭の UPDATE は canonical review の **Important** 指摘への対処。旧 status の行は本 task で述語が
  `['prepared','processing']` に縮んだ結果 `gc-abandoned-operations` では **1 件も候補にできず**、
  runbook の手順に頼ると operator が「0 件 = clean」と誤認して、0032 適用後は全 gate / sweep /
  reconciler から到達不能な dead row を残す。**手順書でなく migration で構造的に閉じた**。
  対になる `source_documents` は reconciler が 15 分超の processing を回収するため触らない。
- `lock_timeout` は最終 review の指摘。live な `upload_operations` に ACCESS EXCLUSIVE を取るため
  無期限に待つと後続 query が lock queue で詰む。値 5s は `db/policies/*.sql`(8 file)と同一。
  `SET LOCAL` にしたのは drizzle-kit が file 全体を BEGIN/COMMIT で包んで接続を使い回すため
  (素の `SET` は commit 後も残る)。timeout で abort しても単一 tx ゆえ部分適用にならない。

---

## 2. 追加項目 A: フォームを隠す判定を gate と同じ判定に揃えた

**drift の実体**(値が同じため結果は一致していたが、片方だけ変えると「フォームは出るのに submit
すると拒否される」窓が無言で生まれる):

| | 見ていた対象 | 条件 |
|---|---|---|
| gate(`submitUploadTx`) | `upload_operations` | 非終端 + valid lease |
| 隠す判定(`hasActiveProcessingUpload`) | `source_documents` | `status='processing'` かつ作成 15 分以内(**lease を読まない**) |

**対処 = 数字を揃えるのでなく判定そのものを共有**:

- `hasActiveProcessingUpload` → **`hasLiveUploadOperation`**。`isLiveUploadOperationCondition()`
  (5→7 call site 共有の SQL 断片)を直読する形にした。
- gate 側の **JS 再実装を撤去**。`c.status !== 'awaiting_sources' && lease !== null && lease >= dbNow`
  を同じ SQL 断片へ委ね、`dbNow` の JS 比較を消した。
- 非終端 status の直値 4 箇所を `NON_TERMINAL_UPLOAD_OPERATION_STATUSES` 1 定義へ集約。
- `STALE_PROCESSING_MS` の**隠す判定における独立定義が消えた**(定数自体は表示 fallback と
  reconciler が引き続き使う)。

**受け入れた挙動変更**: `upload_operations` 行を持たない legacy な processing doc(旧 `process.ts`
経路)では form が出るようになる。gate も元々 legacy doc を弾かないため**一致方向**の変更で、
`process.ts` に live caller が無いので新規の legacy doc は生まれない。

**副次**: gate 境界が `lease >= now`(JS)→ `lease > now()`(SQL)へ動いた。述語共有の正しい副作用で
観測不能(最終 review が記録のみと判定)。

---

## 3. 追加項目 B: `terminalizeAbandonedOperation` とは統合しない

**裁定 = 統合しない**。根拠 3 点:

1. 前提が異なる — `terminalizeAbandonedOperation` は「呼出元が対象 op を FOR UPDATE 済み」、
   `reconcileStaleProcessing` 文 2 は「ロックせず WHERE で守る」。寄せると前提が混ざる。
2. eslint Block A(`lib/` は `app/` を import 禁止)により、共有するには contract を `lib/` へ
   移す必要があり本 task の範囲を超える。
3. site は 2 つで rule of three に達しない。

代わりに**両 site に相互名指しコメント**を置き、前提差を明記した。

### この過程で S-4 由来の検出力ギャップを発見・是正した

Codex P1 で入れた生存ガード(`isNull(lease) OR lease <= now()`)について、**既存 iso 23 本は
ガードを丸ごと外しても全 green だった** — 文 1 の `NOT EXISTS(live op)` が先に守るため live op が
文 2 に到達しない。同一 tx 内で lease を張り直す trigger を注入する iso を 1 本追加して red を作り、
主張と実体が食い違っていた既存 test 1 本を改名した。canonical reviewer が独立に再現し、
「既存 iso に検出力が無かった」という主張は**正確**と認定。

---

## 4. 追加項目 C: `listObjects` + `gc-src-prefix.ts`

- **`listObjects(prefix)`**(`lib/storage/r2.ts`)= ListObjectsV2 の全 pagination 列挙。
  prefix を引数に取る汎用形にしたのは、follow-up「crop lane の row-less orphan 検出」で
  asset lane に転用するため(**本 task では転用しない**)。
- **既存 5 関数の never-throw 契約を意図的に破って throw する**。失敗を空配列に正規化すると、
  削除後の readback 検証(「listing 0 件 = 削除完了」)が network 失敗でも成功に見え、
  **検証そのものが無意味になる**。
- Codex P1 対応で `parseListObjectsPage()` を追加 — **HTTP 200 でも空 / truncated / 壊れた XML
  なら throw** する。上の規律が 2xx 経路から迂回されるのを塞いだ(構造検証のみで内容改竄は
  検出しない旨をコメントに明記)。
- **script**: 既定 dry-run(削除は明示 `--execute`)/ 厳密 regex `^users/[0-9a-f-]{36}/src/` の
  per-key 再照合(listing の prefix 引数だけに頼らない二重の関門)/ `--user` scope /
  削除後 readback で残 0 件を確認し残っていれば非 0 exit。
- **実行はまだしていない**(stg に触っていない)。OT 指示下で「確認 → 削除」の 2 段で行う。

---

## 5. 検証の生出力

### grep 0 件検査(committed tree・許容残 = `docs/` / `drizzle/migrations/`)

```
sourceAssets             0 件
source_assets            0 件
reserveSource            0 件
finalizeSource           0 件
purgeOperationSources    0 件
prepared_taken_over      0 件
stagePrepared            0 件
claimOperation           0 件
abandonUploadOperation   0 件
SourceManifestRow        0 件
isSourceManifestValid    0 件
PREPARED_RETENTION_MS    0 件
--- nextRetryAt
lib/db/schema.ts:241:  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
awaiting_sources         0 件
src/tmp                  0 件
```

**唯一の残 1 行 = `integration_failures.next_retry_at`**(撤去対象の `upload_operations.next_retry_at`
とは別表の live 列・単なる語の衝突)。controller 裁定 = 受容。最終 review も現物を読んで追認。

### DB catalog 検査(scratch DB へ 0000→0032 を fresh 適用後)

```
$ psql -d rm_s5_ctrl_catalog -c "SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name='source_assets';"
 table_name
------------
(0 rows)

$ ... columns WHERE table_name='asset_derivations' AND column_name='source_asset_id';
 column_name
-------------
(0 rows)

$ ... columns WHERE table_name='upload_operations' AND column_name='next_retry_at';
 column_name
-------------
(0 rows)

$ ... SELECT column_name, column_default ... table_name='upload_operations' AND column_name='status';
 column_name |   column_default
-------------+--------------------
 status      | 'processing'::text
(1 row)
```

`drizzle-kit migrate` = `migrations applied successfully`。scratch DB は DROP 済(`recallmint_test` 不可触)。

### gate(controller 実走)

| gate | 結果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm lint --max-warnings=0` | **0**(whole-repo lint exit 0 確認済) |
| `pnpm build` | **0** |
| `pnpm test` | **0** — 270 files / 4,378 tests |
| `pnpm test:iso` | **0** — 29 files / 306 tests(test:iso green 確認済) |
| `pnpm run audit` | **1** — prod high 3 件(`fast-uri` / `ip-address` / `brace-expansion`)。**依存無変更**(package.json / lockfile 不変)ゆえ本 task 起因ではない = OT の dep 判断・別 sprint で基線更新 |

### red 実証(全て実走 → revert)

| # | 変異 | fail する test |
|---|---|---|
| 1 | prefix 照合を緩める | 非一致 key を削除しない test |
| 2 | `listObjects` の失敗を `return []` に | 「失敗は throw」test |
| 3 | 構造検証(`parseListObjectsPage`)を外す | 空 body / IsTruncated 不在 / root 未閉鎖 の 3 test |
| 4 | 隠す判定を旧実装(source_documents + 15 分)へ戻す | gate との parity test(**両方向**で fail) |
| 5 | 生存ガードを丸ごと除去 | 新設の同一 tx trigger iso **のみ**(= 既存 iso に検出力が無かったことの実証) |
| 6 | 生存ガードの `isNull` 枝のみ除去 | NULL-lease iso(= status 付け替えで空振りしていない実証) |

canonical reviewer / re-reviewer が 1・2・4・5・6 を独立再現。migration は reviewer が自前 scratch DB で
旧 status 2 種 + 対照群 4 種を seed して `UPDATE 2` / 対照群無傷 / `source_documents` 未変更を確認。

---

## 6. review の経過

| 段階 | 結果 |
|---|---|
| S-5a canonical | Critical 0 / Important 0 / Minor 3(記録のみ) |
| S-5a Codex | r1 **P1 1**(2xx 経路からの「分からない = 空」再侵入)→ fix → r2 **P1 1 = false positive 裁定** → r3 **clean** |
| S-5b canonical | Critical 0 / **Important 1** / Minor 9 → fix 1 周で全件 ADDRESSED |
| S-5b Codex | **clean**(1 周) |
| 最終 whole-range | **Ready to merge** / Critical 0 / Important 0 / Minor 8 → fix wave 1 回で 6 件 ADDRESSED |
| 最終 fix wave Codex | **clean**(1 周) |

### Codex round 2 の false positive 裁定(記録)

主張 = 「object key の `user.id` は Clerk ID(`user_...`)ゆえ uuid regex が一致せず 0 件削除、
しかも readback が成功に見える」。現物確認で否定:

1. key を組む `user` は `getCurrentUser()` が返す **`users` 表の行**(`User = typeof users.$inferSelect`・
   `id` は `uuid().primaryKey()`)。Clerk ID は**別列 `clerk_id`**。
2. 同じ `user.id` が `withTenantTx()` の tenant context と `sourceAssets.userId`(uuid FK)にも
   渡っていた — Clerk 形式なら uuid cast error で旧経路が一度も動かなかったはず。
3. S-4 の stg smoke で実 R2 key が `users/<uuid>/…` であることを実測済。

裁定根拠は `SRC_KEY_PATTERN` のコメントに記録(証拠は撤去後も実在するものへ差し替え済)。

---

## 7. 残る不明 / OT 判断事項

1. **migration 0032 の stg 適用 = 不可逆点。** OT の push 判断がゲート。手順 =
   `docs/ops/ocr-2-4a-stg-migration-runbook.md` §5。
2. **`src/` 一掃の実行はまだ**。順序 = 一掃 → 0032 適用(表を消すと `object_key` の台帳が失われ、
   残った object を辿る手段が無くなる)。実行は OT 指示下で「dry-run で一覧確認 → `--execute`」の 2 段。
   **stg の実 object 件数は未計測** — `--user` を付けない run は `users/` 全体を listing するため、
   件数が多い場合の所要は未知。
3. **`pnpm run audit` exit 1** = 上流 advisory 3 件。本 task 起因ではない(依存無変更)。基線更新は別 sprint。
4. **prod の RLS flip** は Phase 3 の別作業。0032 適用前の環境では `verify-rls-state` が
   `source_assets` を「カタログ外の表が RLS on」として出すのが正常(runbook §5.3 に注記済)。
5. **legacy `process.ts` / `upload-guard.ts`** は revert 保険として射程外。`upload-guard.ts:25,55` の
   stale なコメント 2 箇所は撤去 task の carry-forward に申し送り済(`docs/todo-v48-integrated-status.md`)。
6. **stg smoke は未実施**(push 後)。0032 適用 + `src/` prefix 空の確認 + GDPR 退会が必要。
