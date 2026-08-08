# ②-4b close §0 — terminal(page-limit)経路の source DELETE 帰属確定(stg 実測)

対象: `docs/superpowers/sessions/2026-08-08-ocr-2-4b-pdf-rasterize.md` の未確定事項のうち、
**「失敗(terminal)経路の外周 `finally` が R2 source(`src/` prefix)を実削除しているか」**。

前回(2026-08-08 の feature smoke Case 3b)は **INCONCLUSIVE** で終わっていた。実 client が
失敗後に `retryPdfSession()` で自動的に再 PUT するため、「削除 → 再 PUT」と「削除失敗 → 再 PUT
不発」が **同じ +6 本**を作り、R2 の総本数だけでは判別できなかった(前回セッションの自己訂正)。

## 1. 結論

**本線 DELETE は効いている。** page-limit terminal(`page_limit_exceeded`)で終わった
operation の source object 6 本は、**submit accepted の約 23 秒後に 6 → 0** になり、以後
5 分間 0 のまま。全体 `src/` も試験前の baseline(無関係な既存 1 本)へ完全復帰した。

`runUploadPipeline` の外周 `finally` → `deleteSourceKeys` は、terminal 分岐でも
**最後まで走り切っている**(= 「Vercel function が finally 完了前に終了する」という §0 の
疑いは、この経路については否定された)。

## 2. 判定が二値になった理由(前回との差)

| | 前回(Case 3b) | 今回 |
|---|---|---|
| 観測単位 | `src/` 全体の**総本数** | **当該 uploadSessionId の prefix scope** |
| 再 PUT する主体 | 生存(失敗表示と同時に `retryPdfSession`) | **消滅**(accepted 検知直後に強制遷移で unmount) |
| 判定 | +6 が 2 仮説と両立 → INCONCLUSIVE | 6 → 0 の一方向 → **DELETE 成功** |

prefix scope が効くのは、`accepted` 時点で `uploadSessionIdRef` が null 化され
(`upload-form.tsx`)、`retryPdfSession()` が**新しい** session id を採番するため。
仮に再 PUT が起きても対象 prefix には現れない。今回は再 PUT 自体も起きていない
(全体 `src/` が baseline と同数)。

## 3. 実測(UTC)

| 時刻 | 事象 |
|---|---|
| 14:56:11 | 事前 listing `src/` = 1(無関係な既存 orphan のみ) |
| 14:59:34 | 上限超過 PDF 6 本を presigned PUT(8 ページ × 6 = 実 48 ページ) |
| 14:59:34-54 | finalize ×6 が実 `pageCount:8` を返却 → client 側で `1` に改竄(層 2 迂回) |
| 14:59:54 | 事前 listing(session prefix)= **6** |
| 15:00:01.053 | submit accepted(operation 作成) |
| 15:00:01.264 | 強制遷移(client 消滅) |
| 15:00:23.988 | session prefix = **0** |
| 15:00:23.988 〜 15:05:14.146 | 30 秒間隔で計 **11 回すべて 0**(submit からの 5 分窓を充足) |
| 15:01:26 | 全体 `src/` = 1(baseline と一致・新 session の増加ゼロ) |

UI 側の失敗表面も整合(試験一覧で当該 exam が「失敗」・カード 0 件)。exam / operation 行は
OT が Vercel Logs と突き合わせられるよう**削除せず残置**した。

DB(`upload_operations` / `source_documents`):

- `status = terminal_failed` / **`last_error_code = page_limit_exceeded`**
- `expected_source_count = 0`(sentinel のまま = count phase の fenced CAS へ到達せず return)
- `pages_total = NULL` / `source_documents.status = failed`

= brief が要求した「page-limit 系 terminal であること」を **DB 実値で確認済**(推測でない)。

## 4. 副次的に確定したこと

- **`.env.local` の `DATABASE_URL_APP` は stg が書いている DB と同一**。本 submit で作られた
  operation が当該 DB に実在し、かつ RLS 経由で `users.id ↔ 当該 Clerk id` が 1 行一致した。
  → 以後、stg smoke の DB 側事実(status / error code / 記帳)は **CC が自力で確認できる**。
  台帳 `integration_failures` だけは app-role の SELECT が RLS で拒否される(既知 42501)ため
  OT 照会が要る。
- `logPhase(refs.operationId, 'total', …)` は `deleteSourceKeys` の**直後**の文。DELETE が
  完走した以上、`upload.pipeline.total` の phase log も出ているはず(= 前回の未取得項目
  「`total` phase log の有無」は構造的に解決)。**実 log の目視は OT 照会**。

## 5. 手法(brief「script 直叩き」からの変更点)

reserve / finalize / submit は **Server Action** であって REST endpoint ではない。素の Node
script から叩くには build hash 由来の `Next-Action` id を deploy 済 chunk から抽出する必要が
あり脆いため、**実 UI を Playwright で駆動**し、前回 stg smoke で実証済の
「finalize echo 偽装で層 2 を迂回 → 層 3 で terminal 化」をそのまま再利用した。

brief が script 直叩きに求めていた性質は次のとおり保存している:

1. **stg 本体を叩く**(local 実行では §0 の疑い自体を検証できない)— 満たす
2. **再 PUT する主体が存在しない** — accepted 応答を検知した瞬間に強制遷移し、`retryPdfSession`
   が発火する前(poll が failed を返す前)に component を unmount して満たす
3. **二値判定** — prefix scope listing により、再 PUT の有無に依らず二値化(1 より強い)

## 6. 残(OT 照会)

Vercel Logs / 台帳の目視だけが未取得。上記の結論を覆すものではなく、**追認**の位置づけ。

- `upload.pipeline.failed` の `errorCode` / `outcome`(DB では `page_limit_exceeded` /
  terminal 化成功を確認済 — log 側の `outcome` が `terminalized` であることの確認)
- `upload.pipeline.total` phase log の実在(§4)
- `integration_failures` の `key='r2_source_delete'` が **無い**こと(6 本とも消えている以上
  `deleteObject` は全て ok を返しており、行は書かれないはず)
- 参考: `upload.pipeline.phase` の `count` / `fetch_source` 実測値(暫定予算 D11 の較正材料)

identifier(operationId / sourceDocumentId / examId / R2 key)は git 管理外の
`.playwright-mcp/smoke/smoke-log-2026-08-08.md` に記載。

## 7. 観測の副産物(本件の結論とは独立・要 OT 判断)

試験開始時点の `src/` に、**成功完了した operation とは別 session の object が 1 本**残って
いた(本試験の前後で不変・今回作った 6 本とは無関係)。form に PDF を投入したが submit せずに
離脱した場合の残骸と整合し、その受け皿は spec §6 の lifecycle rule(`src/` maxAge 86400s)。
**その lifecycle rule は未設定のまま**(②-4b 実装クローズ記録 §10 の外部設定項目)なので、
現状この 1 本を回収する主体は存在しない。回収するか lifecycle を設定するかは OT 判断。
