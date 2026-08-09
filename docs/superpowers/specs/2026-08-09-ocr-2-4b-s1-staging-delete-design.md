# ②-4b §1: entry 削除時の R2 staging cleanup 設計 spec

- 前提 fact-finding: `docs/audit/2026-08-09-ocr-2-4b-s1-factfinding.md`
- 親 spec(r5・実装済・凍結): `docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md`
  — 本 spec は r5 への追補ではなく独立 spec(r5 は実装済 spec ゆえ改変しない)。
  key 規約(`src/{userId}/{uploadSessionId}/{fileId}.pdf`)/ `uploadSessionId` の生存範囲(r5 §3.1/§3.2)は
  そのまま前提として使う。
- OT 裁定(2026-08-09): 案 A 承認 / error entry を即 DELETE に含める / 台帳 key `r2_staging_delete` /
  独立 spec。不変条件 2 点(§5)は OT 指定。

## 1. 問題と目的

アップロードページで entry ×(削除)を押しても client state が外れるだけで、R2 の source object
(`src/` prefix)は残留する(OT 実機確認 2026-08-09)。r5 はこれを「削除 = manifest から外すのみ、
残骸は lifecycle」と設計したが(`upload-form.tsx:606` コメント)、lifecycle は実効 ≈48h の
バックストップであり、ユーザーが明示的に取り下げた著作物を最大 2 日弱保持することになる。

目的: **entry 削除に同期した best-effort DELETE** で、削除時点から R2 に orphan を残さない。

### scope 外(やらないこと)

- 退会 purge(§2)/ age-based sweeper(§3)/ 台帳スキーマ・DB 行の新設 / migration
- submit 後の経路(本線 finally の出口 DELETE が担う・§0 で stg 実証済)
- unmount(ページ離脱)時の回収 — 従来どおり lifecycle / §3 が受け皿(§7 限界)
- 同期経路(IDB / outbox / tombstone)への接続 — staging は純 client state(v58 裁定・fact-finding §2 で反例なし)

## 2. 設計の中心 — 削除主体の一意化(案 A)

race の核心は「entry 削除の時点で PUT / finalize が飛行中でありうる」こと。DELETE を先に撃つと
PUT が後から着地して object が復活する。これを**削除主体を常に一意にする**ことで構造的に解く:

| entry の状態 | 削除主体 | 動作 |
|---|---|---|
| continuation 飛行中(uploading / counting) | **continuation 本人** | 各 checkpoint で無効化を検知したら以後の工程を打ち切り、自分の object を DELETE |
| continuation 非飛行(ready / error) | **removeEntry** | 即 `deletePdfSource` を fire-and-forget |
| image entry | (なし) | R2 object が存在しない。従来どおり |

- 「DELETE 先行 → PUT 後着地」の順序は**構造的に発生しない**: 飛行中は removeEntry が撃たず、
  continuation は PUT 完了後の checkpoint で自分が消す。
- 無効化の検知は**既存の generation token(`generationRef`・Codex I11)に相乗り**する。
  `removeEntry` が key を delete した瞬間、以後の `get(id) !== generation` 比較が全て不一致になる —
  新しい無効化機構は作らない(簡潔性規律)。
- error entry を即 DELETE に含める理由: finalize throw(network 断)で error 化した entry は
  object が残る唯一の非飛行残留経路。PUT 失敗 / finalize reject 由来の error は object 不在
  または server 削除済で、DELETE は 404 = 成功系の no-op(fact-finding §1.3 / R2 実測)。

### 2.1 continuation の checkpoint(`continuePdfUpload` 内・3 点)

1. **PUT 開始前**: 無効なら PUT 自体を skip(object を作らないので DELETE 不要)。
2. **PUT 完了後**: 無効なら(putOk のときのみ)自分の object を DELETE して return(finalize へ進まない)。
3. **finalize 完了後**(成功 / reject / throw の全て): 無効なら自分の object を DELETE して return
   (state は書かない — `writeEntry` の既存 guard と二重だが、DELETE はここでしか撃てない)。

reject 経路では finalize server 側が既に削除済(本線 1)→ 404 no-op。checkpoint は
「無効 → 撃つ」の一様規則でよい(reject かどうかで分岐しない)。

### 2.2 PDF source registry(`pdfSourceRef`・新設 ref)

removeEntry が「その entry の object がどの session namespace に居るか」と「continuation が
飛行中か」を知るための client 内 ref:

```
pdfSourceRef: Map<entryId, { uploadSessionId: string; inFlight: boolean }>
```

- **登録**: reserve 成功後、continuation を dispatch する時点で `{ uploadSessionId, inFlight: true }`
  (`reservePdfBatch` の成功 loop 内 — dispatch と同一同期区間)。
- **inFlight 解除**: continuation の**全終了経路**で `finally` により必ず false にする(§5 不変条件)。
- **entry の削除**: removeEntry が DELETE を撃った後、および continuation が無効化を検知して
  終了した後(checkpoint 1〜3。object を作らなかった checkpoint 1 も含む — 以後この id を
  指す者は居ない)に `map.delete(id)`。
- **session 無効化との同期(purge)**: `uploadSessionIdRef` を null 化する 2 点(accepted 受信 /
  submitUpload throw)で、**当該 session に属する全登録を purge** する。以後 removeEntry は
  その session へ DELETE を撃てない。

purge が要る理由: consumed session の object は server pipeline が所有しており(読取中でありうる)、
client DELETE が競合すると `pdf_source_unavailable` の誤 terminal 化を誘発する(r5 の fenced CAS が
守っているのと同じ class)。既存の `disabled={isSubmitting}` gate(§5)に加えて registry 側でも
閉じることで、**「consumed session へ client DELETE を撃たない」が UI gate 単独依存でなくなる**
(defense in depth・単一点主張の崩壊対策)。

purge の帰結として受容する残留: submitUpload throw 後に `retryPdfSession` の再 reserve まで失敗した
場合、旧 session の object は client から指せなくなる(operation 未作成なら orphan)。受け皿は
lifecycle / §3(§7)。

なお status(uploading/counting)でなく ref で飛行判定する理由: continuation 完了 → re-render の
1 commit 窓で × click されると status 判定は「飛行中」と誤読し、削除主体が消える(誰も撃たない
orphan)。ref は checkpoint→解除が JS 単一 thread 上で原子的に連続し、この窓がない。

### 2.3 removeEntry の動作(変更後)

1. `generationRef.current.delete(id)`(既存・無効化)
2. `pdfSourceRef` を引く: 登録あり かつ `inFlight === false` → `void deletePdfSource({ uploadSessionId, fileId: id })` + `map.delete(id)`。
   `inFlight === true` → 何もしない(continuation が削除主体)。登録なし(image / reserve 失敗)→ 何もしない。
3. 以降は既存どおり(thumbUrl revoke / entries filter / 空なら session null)

## 3. server action `deletePdfSource`(新設)

`app/(app)/app/upload/_actions/delete-pdf-source.ts`。`finalize-pdf-source.ts` と同じ骨格:

- 入力 `{ uploadSessionId, fileId }` — zod で両方 `z.uuid({ version: 'v4' })`。
  **key 文字列 field は受けない**(所有権 pin・Codex I7 と同水準)。
- 認証: `currentUserOrNull()` 既存 idiom。未認証は `{ ok: false }`(UI に出さない)。
- key = `sourcePdfObjectKey(user.id, uploadSessionId, fileId)` — server 導出のみ。
- `deleteObject(key)`(never-throw・404 = 成功系 = 冪等。R2 実測済)。
- 失敗(`!result.ok`)時のみ `recordIntegrationFailure`。その throw(notifyOps の production
  fail-fast)は `deleteSourceKeys` と同じ idiom で飲む(action は throw しない契約)。
- 戻り値は既存 `ActionResult` idiom(ok:false の error 文言は client が一切表示しない —
  fire-and-forget。専用の戻り値型は発明しない)。

認可は key の userId namespace が担う: 任意の (session, file) uuid を送っても自分の
`src/{自分のuserId}/…` しか消せない。悪用は「自分の staging を早めに消す」= lifecycle の前倒しと
等価で無害(reserve / finalize と同じ posture)。

## 4. 台帳(OT 承認済・catalog 追加のみ)

`INTEGRATION_FAILURE_CATALOG` に新 entry:

```
r2_staging_delete: {
  service: 'r2',
  operation: 'object.delete',
  workflow: 'upload_staging',
  failureCode: 'external_api_error',
}
```

- context = `{ objectKey, status }`(`r2_source_delete` と同形)。
- pipeline 出口(`upload_single_invocation`)とも将来の §3 sweeper 用とも **workflow 軸で区別**
  (4 軸 tuple は stable identifier・相乗り禁止)。§3 側もこの区別を踏襲する。
- app role は INSERT 権限あり = runtime から書ける(fact-finding §4.4 実測)。

## 5. 不変条件(OT 指定 2 点 + 本 spec 固有)

1. **checkpoint 判定と ref 解除は同一同期区間で行う**(間に await を挟まない)。挟むと
   「削除主体が常に一意」の論拠が崩れる。continuation 終了時の inFlight 解除は throw 経路を
   含め **finally で必ず実行**する — 漏れると error entry が「永遠に飛行中」に見えて誰も
   DELETE しない orphan になる。
2. **`disabled={isSubmitting}`(`upload-form.tsx` 削除ボタン)が race 排除の前提**。
   「consumed session の object を client DELETE が pipeline と取り合わない」はこの UI gate +
   §2.2 の purge の 2 層に依存する。将来 disabled が外れても purge が第 2 層として残るが、
   gate 自体も test で pin する(§6)。既知の地雷として明記: **この 2 層のどちらかを外す変更は
   本 spec の保証を無言で崩す**。
3. 削除主体の一意性(§2 表)。removeEntry と continuation が同じ object に対して両方 DELETE を
   撃つ経路を作らない(冪等だから壊れはしないが、一意性が崩れた実装は §2 の論証を失う)。
4. client から key 文字列を送らない(server 導出のみ・r5 から継承)。

## 6. テスト(実装 task が TDD で書く。pin する主張)

**action unit(`delete-pdf-source.test.ts`・finalize の mock 構成を踏襲)**:
- 未認証 → `{ ok: false }`・`deleteObject` 不呼出
- 非 uuid 入力 → `{ ok: false }`・不呼出(key 系 field の紛れ込みが無視されることも finalize 同様 pin)
- 正常 → `sourcePdfObjectKey(user.id, session, file)` の key で `deleteObject` 呼出・台帳不呼出
- `deleteObject` 失敗 → `recordIntegrationFailure` が `r2_staging_delete` + `{ objectKey, status }` で呼ばれる
- `recordIntegrationFailure` throw → 飲んで戻る(action は throw しない)

**upload-form(既存 test file に追加)**:
- ready entry 削除 → `deletePdfSource` が (session, fileId) で呼ばれる
- error entry(finalize throw 由来)削除 → 呼ばれる
- image entry 削除 → 呼ばれない
- uploading 中削除 → 即時には呼ばれず、PUT 解決後に呼ばれる(checkpoint 2)
- counting 中削除 → finalize 解決後に呼ばれる(checkpoint 3)
- PUT 開始前(reserve 未解決)に削除 → PUT fetch 自体が発火しない(checkpoint 1)
- accepted 受信後、旧 session への `deletePdfSource` が発火しない(purge の pin)
- **submit 中は削除ボタンが disabled**(OT 指定・不変条件 2 の pin)
- 既存 pin の回帰なし(stale finalize 応答 / entries 空で session null / retryPdfSession)

## 7. best-effort の限界(受容・記録)

回収されず lifecycle / §3 に落ちるケース(いずれも設計どおり):
- DELETE の network 失敗(台帳に記録あり・client retry loop は持たない — object 残存自体が
  §3 sweeper の retry 条件)
- unmount(ページ離脱)時の飛行中 continuation — generation は有効なままなので自己削除しない
- finalize が応答しないまま hang した continuation(checkpoint に到達しない)
- submitUpload throw 後の purge 済 session(§2.2)

## 8. 変更一覧

| file | 変更 |
|---|---|
| `app/(app)/app/upload/_actions/delete-pdf-source.ts` | 新設(§3) |
| `app/(app)/app/upload/_components/upload-form.tsx` | `pdfSourceRef` 新設 / removeEntry 分岐 / checkpoint 3 点 / purge 2 点 |
| `lib/integration-failures.ts` | catalog に `r2_staging_delete` 追加(§4) |
| `docs/architecture.md` | source 行の DELETE 経路列挙に staging 削除経路を追記(単一点主張を偽にしない) |
| 対応 test file | §6 |

migration なし / env 追加なし / schema 変更なし。

## 9. stg smoke(OT push 後・CC 実走)

- ready 削除 / uploading 中削除 の 2 面を実 UI で実施し、**session prefix scope の listing**
  (§0 と同じ手法)で 0 件収束を判定。
- **既存の `src/` 2 object(lifecycle 観測 sentinel)には触らない**。消してよいのは自分の試験で
  PUT した key のみ。
- 台帳(`integration_failures`)の確認は OT 照会(app role SELECT 不可・42501)。
