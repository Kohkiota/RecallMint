# ②-4b §1 entry 削除時の R2 staging cleanup — 実装クローズ記録

- spec: `docs/superpowers/specs/2026-08-09-ocr-2-4b-s1-staging-delete-design.md`(案 A・OT 承認 + Codex cross-check 統合済)
- plan: `docs/superpowers/plans/2026-08-09-ocr-2-4b-s1-staging-delete.md`(134 行・3 task)
- fact-finding: `docs/audit/2026-08-09-ocr-2-4b-s1-factfinding.md`

## 1. commit 一覧(範囲 6c47cba..本 doc・全て develop 未 push)

| commit | 内容 | tag |
|---|---|---|
| `6c47cba` | §1 fact-finding(5 項目・read-only 実測込) | no-review |
| `35052f9` | 設計 spec(案 A) | no-review |
| `7350775` | plan ドラフト + spec 微修正 2 点(OT 指定) | no-review |
| `7239728` | Codex plan cross-check raw findings | no-review |
| `573fcf2` | plan r2 = cross-check 統合(採用 5 / 不採用 8・OT 裁定済) | no-review |
| `8eeded3` | **Task 1**: server action `deletePdfSource` + 台帳 `r2_staging_delete` | **reviewed** |
| `6cdaa35` | Task 1 Codex findings | no-review |
| `88f1062` | **Task 2**: client 配線(registry / removeEntry / checkpoint / purge) | **reviewed** |
| `b83a5cc` | architecture.md source 行 + spec §2.2 適用範囲追記(Task 3) | no-review |
| `653f049` | catalog 件数 pin 追随(11→12)+ 4 軸 pin(**red 検証** R-1/R-2) | **reviewed** |
| (本 doc と同 commit) | 最終 review Minor 2 = architecture.md 対象外列挙に finalize-hang 追加 | no-review |

## 2. review 実績

- **Task 1**: canonical(sonnet)Ready・Crit0/Imp0/Minor2。Codex P1×1「action 未配線」=
  **却下裁定**(plan 順序の意図的中間状態・cross-check 指摘 14 で OT 不採用済の同型)。
  最終 whole-branch review が配線済を現物確認し裁定の正しさを追認。
- **Task 2**: canonical(opus)With fixes → **Imp1 = throw 経路 purge の pin 検出力ゼロ**
  (plan 完了条件の列挙漏れ由来)→ fix round 1(+Minor 3 件同乗)→ scoped re-review
  all addressed(66/66 実走)。Codex clean(1 周)。implementer deviation 3 件
  (comment 差し替え / submittedSessionId 同値置換 / inFlight 解除の無 guard)は全て
  justified 裁定 — 特に inFlight 無 guard は「orphan record への mutate は inert」で
  guard 不要が正(brief の字面より実装が正しい)。
- **catalog 追随**(full gate で検出した Task 1 の既存 pin 追随漏れ): red 検証
  R-1(workflow 変異 → 4 軸 pin + uniqueness pin の 2 件 fail = 重複 tuple 化)/
  R-2(件数変異 → 当該 it fail)。簡易 review = Codex clean。
- **最終 whole-branch(fable)**: **Ready to merge・Crit0/Imp0/Minor4**(全て残置可 triage)。
  縫い目の adversarial trace 3 本(consumed session vs 遅延 continuation / retry 再登録 /
  key 再利用)全て構造的に閉じていることを確認。

## 3. 設計上の非自明判断(経緯)

- **削除主体の一意化**(飛行中 = continuation checkpoint 自己削除 / 非飛行 = removeEntry 即
  DELETE)+ 既存 generationRef 相乗り。飛行判定は status でなく ref(1 commit 窓の orphan 回避)。
- **checkpoint 2 は putOk 不問**(Codex cross-check 採用 1・OT 承認で spec 改訂): client
  timeout 後の R2 側着地(uncertain outcome)を回収。404=成功系ゆえコストゼロ。
- **purge は session 無効化 2 点と同一同期区間**: consumed session への client DELETE を
  `disabled={isSubmitting}` UI gate と registry の 2 層で遮断。**purge が効くのは registry
  のみ**(飛行中 continuation の closure は対象外・submit gate が保証)— spec §2.2 に非対称を明記。
- **releaseRegistry 閉包**(implementer 発案): identity guard(`get(id) === rec`)を 4 call
  site に繰り返さず構造化。canonical が「brief より良い」と裁定。
- **purge pin の構成**: 再 reserve が成功すると新 record が旧 record を上書きし pin の検出力が
  消えるため、**再 reserve を意図的に失敗させる**(accepted 側・throw 側とも同構成)。

## 4. gate 結果(2026-08-09)

- whole-repo lint(--max-warnings=0)exit 0 / typecheck exit 0 / build exit 0
  (pdfium packaging postbuild 検証 PASS 込)
- full `pnpm test` **4515 green**(274 file)/ `pnpm test:iso` **326 green**
- **`pnpm run audit` = fail(本 branch 無関係)**: 新規 advisory 3 件 —
  **prod high: nanoid@3.3.16 GHSA-2v37-7h3g-55p8**(postcss←next/@clerk 経由)+
  dev: 同 nanoid / js-yaml@4.3.0 GHSA-5p4m-2wfm-xmqj(allowlist 未登録)。
  本 branch は lockfile/package.json 不変(573fcf2..HEAD で diff ゼロ)= 上流の新規公表。
  対処は deps 基線 sprint 事案(OT 判断)。

## 5. 残余(全て bounded・OT/follow-up)

- 最終 review Minor 1: checkpoint 2「putOk 不問」/ checkpoint 3 catch 節 DELETE の
  mutation-proof pin 2 本が無い(regression で `if (putOk)` が復活しても 4515 green の
  まま)。影響は bounded(lifecycle ≤48h)— follow-up(claude.ai todo)。
- Task 1 Minor: swallow-catch log の相関 id 欠落(二重失敗時のみ)/ currentUserOrNull
  再 throw 分岐 pin 無し(finalize 側の同一 copy で pin 済)— 残置。
- currentUserOrNull が 5 箇所目 = rule-of-three 超 → 抽出 chore を別 task 起票(follow-up)。
- spec §7 の限界(unmount / DELETE 失敗 / purge 済 / finalize hang)は §3 sweeper +
  lifecycle が受け皿。**lifecycle rule の「効果」の実測は依然ゼロ**(§4 論点)。

## 6. stg smoke 実測(2026-08-09・CC 実走・**全 PASS**)

deploy = `a0c254d` push 済(`dpl_34hie4gvAdZ66AxkcWaQjn8LDFt9`)。判定は R2 `src/` の
session prefix scope listing(2.5 秒間隔 polling で transient も採取)。
**既存 sentinel 2 本(`55b4316c…` / `f4f91e6d…`)は全工程で lastModified 不変 = 不可触を維持。**

| # | 経路 | 操作 | 実測 | 判定 |
|---|---|---|---|---|
| 1 | **ready 削除**(removeEntry 即 DELETE) | case1-exam-5p.pdf を ready 化 → × | 07:13:56 に `8155c44c/fc7d049d` 出現 → 削除後 07:14:34 に消滅(3→2) | **PASS** |
| 1' | 同上(41.9MB) | s1-big-40mb.pdf を ready 化 → × | 07:15:19 出現 `52801406` → 07:15:36 消滅 | **PASS** |
| 2 | **checkpoint 1**(PUT 開始前に無効検知 → PUT 自体を発火せず) | 4 冊 setFiles の **37ms 後**に entry1 を ×(status = アップロード中…) | 新 session `18b0…` は **3 本しか出現せず**(削除分は一度も R2 に現れない) | **PASS** |
| 3 | **checkpoint 2**(PUT 着地後の自己削除 = putOk 不問) | 4 冊 setFiles の **1.2 秒後**に entry1 を ×(status = アップロード中…) | `0d2e…` が 07:19:11 に **4 本**(削除分 `2a31d2` も着地)→ 07:19:16 に `2a31d2` のみ消滅 → 3 本 | **PASS** |

- **#3 が Codex 採用 1 / OT 承認の spec 改訂(checkpoint 2 を putOk 不問にする)を実機で立証**した:
  削除後に PUT が着地する uncertain outcome を continuation が回収している。
- 最終状態 = sentinel 2 本のみ(自分が PUT した 12 object はすべて回収)。console error 0。
- 手法メモ: tool 往復(数秒)が PUT 窓を食うため、`setInputFiles` と `削除` click を
  **同一 Playwright 実行内**で行い待ち時間を制御した。窓を広げるため 41.9MB × 4 冊の
  同時 PUT(合計 167.7MB < `MAX_PDF_TOTAL_BYTES` 200MB)を使用。fixture は
  `.playwright-mcp/smoke/s1-big-40mb.pdf`(git 管理外・生成 script は scratchpad)。

### 未実施(OT 照会)

- `integration_failures` に `workflow='upload_staging'` の行が**無い**ことの確認
  (app role は SELECT 42501 ゆえ CC 不可)。全 DELETE が成功しているため行は無いはず。

```sql
select created_at, user_id, context ->> 'objectKey' as object_key,
       context ->> 'status' as http_status, error_message
from integration_failures
where service='r2' and operation='object.delete' and workflow='upload_staging'
order by created_at desc;
```

## 7. (旧)stg smoke 手順(spec §9)

1. **ready 削除**: PDF 1 冊を form に投入 → ready 化 → ×클릭 → session prefix listing
   (`src/{uid}/{sessionId}/`)で **0 件**を確認(手法 = §0 close doc と同じ prefix scope)。
2. **uploading 中削除**: 大きめ PDF を投入 → uploading 表示中に × → PUT 完走後の自己削除で
   最終的に **0 件**へ収束(数十秒待って listing)。
3. **不可触**: 既存 `src/` の残置 object(lifecycle 観測 sentinel)。消してよいのは自分の
   試験で PUT した key のみ。
4. 台帳(`integration_failures` の `workflow='upload_staging'` 行が**無い**こと)= OT 照会
   (app role SELECT 42501)。SQL は fact-finding §4.5 の workflow 変形。
