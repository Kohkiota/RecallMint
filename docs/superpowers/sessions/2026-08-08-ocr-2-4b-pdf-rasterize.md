# ②-4b PDF 対応(R2 一時保存 + server WASM rasterize)— 実装クローズ記録(T9 docs)

spec(凍結・r5 確定 2026-08-08)= `docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md`。
plan = `docs/superpowers/plans/2026-08-07-ocr-2-4b-pdf-rasterize.md`。
ledger = `.superpowers/sdd/2026-08-07-ocr-2-4b-pdf-rasterize/progress.md`(scratch・正本はここ)。
範囲: `609b234`(plan 確定時 HEAD)`..a25cea3`(T8 完了時点)。**T9(本 doc)以降、T10(sprint close = whole-branch review + 全 gate + smoke handoff)は未着手** — 本 doc は T1〜T8 の記録であり、sprint 完了の宣言ではない。

---

## 1. 経緯と確定事項(T1〜T8)

| Task | commit(s) | tag / review | 要点 |
|---|---|---|---|
| T1 | `a31c5f7` | `[no-review]` | `@hyzyla/pdfium@2.1.13` exact pin + probe route(`app/api/pdfprobe-pdfium`・`withReadOnlyAuth` で認証必須〈Codex I14〉)。local NFT grep で `pdfium*.wasm` の trace + 実在を確認。**stg 実証 green**(下記 §5)→ **D1(pdfium 採用)確定**。T2/T3 は実証待ちの間に先行実施 |
| T2 | `0896abf` | `[no-review]` | legacy `process.ts` 一式(到達不能コード)削除。型 2 つ(`ProcessUploadErrorCode`/`ProcessUploadErrorDetails`)は `_lib/upload-error-types.ts` へ移設。`upload-persistence.ts` の `completeUploadTx`/`markFailed` は `tests/integration/pg/ocr-owner-scope.test.ts` が直接 import してテナント隔離を pin するため残置(production 呼出はゼロ化・OT 判断事項として申し送り済) |
| T3 | `3c40eda` | `[reviewed]`(canonical 0/0/2 + Codex clean) | `lib/media/source-object-key.ts`(key builder・3 引数とも uuid v4 検証)/ 上限定数 3 つ / `getObject` timeoutMs 引数化 / `integration_failures` catalog に `r2_source_delete` 新設 |
| T4 | `595afeb` | `[reviewed]`(canonical Crit1→修正 / Codex r1 P1→r2 clean) | `lib/media/pdf-rasterize.ts`。pdfium API 6 つ(brief の 5 つ + `getOriginalSize`・理由は report に明記)。BGRA→RGBA swap 不要を実測(既知色の合成 PDF で往復検証)。queue 直列化 + destroy 安全性(Codex 指摘の use-after-free を修正)。fixture は tracked へ切替(§6 参照) |
| T5 | `351d556` | `[reviewed]`(canonical Ready 0/0/2 / Codex r1 P2→r2 clean) | `_actions/reserve-pdf-upload.ts` / `_actions/finalize-pdf-source.ts`。DB 書込なし(無状態)。reject(単体超過・解析不能)で `deleteObject`。所有権は「key 文字列を client から一切受理しない」ことで担保(Codex I7) |
| **spec r5** | `794717a`(spec)/ `c5be977`(plan r4)/ `0b22686`(rename `[reviewed]`)/ `6f3448d`(plan 追随) | — | `idempotencyKey` → `uploadSessionId` 分離。経緯は §2 |
| T6 | `f74ce78` | `[reviewed]`(canonical Crit1+Imp1→修正 / Codex r1 P2→r2 P2×2→r3 clean) | upload-form の PDF batch flow。`uploading`/`counting` 状態新設。client 判定廃止(`pdf-page-count.ts` 削除)。`uploadSessionId` の発行/維持/無効化/terminal 再試行(spec D5 の client 状態機械)。canonical Critical = `pdfBatchKeyRef` が submit をまたいで持続し同一 idempotencyKey で別内容を送ると replay で握り潰す/ Important = reserve を 1 file ずつ呼ぶため Σ≤200MB 検証が構造的に発火しない(spec D7 逸脱)— 両方修正済み |
| T7 | `a27cb94` | `[reviewed]`(canonical Crit1+Minor1→修正 / Codex r1 P2→修正・r2 Important0) | `submitUpload` の manifest 分岐(層 2)。manifest 完全性検証(重複/欠番/範囲外拒否)。`pagesTotal`/`expectedSourceCount` を PDF 含み時 NULL/0 sentinel 化 |
| T8 | `919d24e` | `[reviewed]`(canonical Crit0/Imp2→修正 / Codex r1 P1+P2→r2 P1→r3 P1×2→r4 clean) | count/render 2 phase(層 3・正本)。fenced CAS。`OwnershipState` による出口 DELETE の所有権判定。probe route 撤去 |

各 task の fix ラウンド詳細・red 実証コマンドは `task-{4,6,7,8}-report.md` に全量あり(本 doc は要点のみ)。

### r5(uploadSessionId 分離)発見の経緯

T6 の実装検討中に判明した spec の穴(ledger 原文、progress.md T6 節):

> R2 key `src/{userId}/{idempotencyKey}/{fileId}.pdf` が「R2 namespace の同一性」と「submit 冪等性の同一性」を同じ値で表しているため、両立しない要求が衝突する。① server 契約 = ユーザー再試行は必ず新 `idempotencyKey`(同一 key は状態不問 replay)② R2 = PUT 済み bytes は presign 時点の key 配下にある。→ 再試行のたびに key が変わると既 upload の PDF が旧 key 配下に取り残される。

この矛盾を解いたのが spec r5: `idempotencyKey`(論理 submit 試行の同一性・ユーザー再試行では必ず新規)と `uploadSessionId`(R2 namespace の同一性・再試行でも維持したい)を**別値**に分離した(spec §3.1)。生存範囲は「新規 operation が作成されたか」という server outcome で定義(§3.2)。**強制力の限界を明示**: `uploadSessionId` は uuid v4 形状検証のみで DB に保存しない(台帳なし)ため、「1 session = 高々 1 accepted operation」は client 状態機械の**規約**であり server の**機械保証ではない**(§3.3・受容済)。

r5 の影響で既 commit の T3(`sourcePdfObjectKey` 第 2 引数)/ T5(2 action の入力 field 名)を rename commit(`0b22686`)で追随させた。**元の `[reviewed]` tag は書き換えていない**(順序則どおり・別 commit)。

---

## 2. 「緑は守られている」9 例目 — 既存 8 例と型が違う

既存の型: **S-3** = test が「穴の不在」を pin していた(何かが起きないことの確認漏れ)。**S-5** = test 数はあるが検出力がゼロ(壊しても落ちない)。

**今回(9 例目)は違う型**: **test が「バグの存在」を pin していた**。

### 指摘

`tests/integration/pg/upload-pipeline.test.ts` の「同一 operation の 2 回目実行(敗者)」test は、T8 の Codex fix round 2(独立レビュー r1・Critical〈P1〉是正)より前の版では、**負けた invocation も共有 source object を DELETE することを assert していた**。fix round 1 完了時点の実装は無条件 DELETE(所有権判定なし)で、この test は「敗者も DELETE する(呼出回数 ≥2 回)」を green のまま固定していた。

### なぜこれが問題か

T8 以前は R2 に source が存在しなかった(②-4a は「source を R2 に置かない」設計)ため、②-4a spec が認める「同一 operationId を複数 invocation が実行しうる極小窓」(transport 重複)は無害だった。T8 が source を R2 に一時保存する設計を持ち込んだことで、**この test が pin している「敗者も削除する」挙動そのものが新しい hazard になった**: fence に負けた側の finally が、count と render の間にいる勝者の source を消し、勝者の再 GET が `pdf_source_unavailable` を返して誤って terminal 化される。

つまり **green であることが「正しさの証明」ではなく「旧バグ挙動の固定」を意味していた**。修正すると当然この test は赤くなる(旧仕様の逆を assert し直す必要がある)ため、**この test 自体が「敗者は削除しない」への変更に対するブレーキとして働いていた**構造 — 直そうとする実装変更を、この test が(誤って)押し戻す形になっていた。

### 対処

Codex の独立レビューが実在を確認 → controller が現物確認 → `OwnershipState({lost: boolean})` を導入し、所有権喪失が明示判明した箇所でのみ DELETE を skip する実装に変更。**同時に test を書き換えた**: 「敗者は DELETE を skip する(呼出回数が 1 回目から増えない)」を assert する形へ反転(`tests/integration/pg/upload-pipeline.test.ts:940`)。red 実証(`ownership.lost` チェックを外す変異)で 4 test が fail することを確認済み(T8 report「Red 実証(fix round 2)」節)。

### 同じ family — canonical Imp2(検出力ゼロ・S-5 と同型)

同じ commit の canonical review(fix round 1)で並行して見つかった別問題: 「成功経路で全 source key を DELETE する」の unit/iso assertion が**単一 key への `toHaveBeenCalledWith` すら持たず**、`deleteSourceKeys` を `keys.slice(0, 1)`(先頭 1 件だけ削除)に変異させても **27 iso + 36 unit = 63 test 全通過**していた。brief の完了条件にこの pin がどこにも明記されていなかったことが原因。

修正: `toHaveLength` + `arrayContaining` で件数・内容の両方を assert する行を追加(検出力を獲得 = report の red 実証で確認)。

### まとめて言えること

**数(63 test)と緑の両方があって、それでも検出していなかった**(canonical Imp2)。**さらに、緑であること自体が誤った仕様を固定していた**(9 例目)。前者は「保証が薄い」、後者は「保証が逆を向いている」— 前者より重い型。

---

## 3. 「説明と実体の乖離」— canonical Imp1

**指摘**: render phase の `handle.renderPageWebp(i)` が投げる `PdfParseError`(pdf-rasterize.ts が `getPage`/`render`/sharp encode のあらゆる失敗を包む型)を、T8 fix round 1 以前は render phase 側で一切 catch していなかった。壊れた PDF(ユーザー入力起因の予期される失敗)が素通しで外周 catch-all に落ち、`pipeline_unexpected_error` として `integration_failures` + Discord に記帳されていた。

**同じ file が自ら定めた規律に反していた**: `upload-pipeline.ts:1249-1250` に

> 予期される失敗は operation 行 + この log に留める(integration_failures には積まない — **台帳はユーザー起因の失敗で埋めない**)。PII-free。

というコメントが(terminalize 系ヘルパーの直前に)既に存在する。render phase の catch 漏れは、この規律を**同一 file 内で**破っていた — 規律を書いた場所と破った場所が同じ file という型の欠陥。加えて implementer 自身の report(concern 2)は「render 側 `PdfParseError` の受け皿」と書いていたが、実装にはその受け皿(catch)が実在しなかった(report の説明と実装が食い違っていた)。

**対処**: `renderPageWebp` 呼出を専用 try/catch で包み、`PdfParseError` だけを捕捉して新設 error code `pdf_render_failed` で terminal 化(**loud にしない** — `recordUnexpectedFailure` を呼ばない・count phase の `pdf_source_unavailable` 経路と同型)。`PdfHandleDestroyedError`(バグ由来の use-after-free 相当)は `instanceof PdfParseError` に一致しないため意図的に対象外のまま外周 catch-all へ伝播させ、そちらは loud のまま維持(T8 report「Fix round 1 / Important 1」節)。red 実証: catch を無効化する変異で `errorCode` が `pdf_render_failed` から `pipeline_unexpected_error` に変わることを確認済み。

---

## 4. fix ループの整理(OT 裁定)

T8 は Codex 4 周(r1〜r4)を要した。CLAUDE.md の 3 周上限(「同じ問題が解けない」場合の安全弁)に照らし、OT が 4 周目を承認した際の裁定(progress.md より原文引用):

> 3 周上限は「同じ問題が解けない」場合の安全弁であり今回は非該当。ただし「毎周まったく別問題」でもない: round1(fence 敗者の DELETE)と round2(terminalize race 敗者の DELETE)は**別経路だが根は同じ「所有権を失った実行が cleanup してはいけない」**、round3 の deadline は**別クラス**。実体 = **ownership / terminalization / cleanup / deadline の横断的不変条件を、経路ごとに網羅できていなかった**。

対応関係(Codex round 番号 = commit message の `r1`〜`r4`。report の「fix round」番号とは 1 つずれる — report の fix round 1 は canonical、2〜4 が Codex r1〜r3、r4 は clean):

| Codex round | 検出した hazard | 対処 |
|---|---|---|
| r1(P1 Critical)| fence 敗北 4 経路(`start_cas_lost`/`count_cas_lost`/`commit_raced`/`publish_raced`)で敗者が共有 source を DELETE | `OwnershipState` 導入・4 箇所で `ownership.lost = true` |
| r2(P1 Critical)| `terminalize()` の `raced` 判定が戻り値として外に出ておらず、5 つ目の所有権喪失シグナルが伝播していなかった | `terminalize` の戻り値を `'terminalized' \| 'raced'` にし、8+1 箇所の呼出点を `terminalizeOwned` closure に集約して伝播 |
| r3(P1×2 Critical)| count phase が上限超過確定後も後続 GET を続ける / deadline チェックが phase 冒頭 1 回のみで per-PDF・per-page の予算枯渇を見ない | in-loop 上限判定 + loop 内 3 箇所(count GET 前 / render GET 前 / renderPageWebp 前)に deadline チェック追加 |
| r4 | clean | — |

r1/r2 は「所有権喪失シグナルの網羅漏れ」という同根、r3 は「時間予算という別軸の網羅漏れ」— OT 裁定どおり、根本原因は 1 つの設計欠陥ではなく**横断的不変条件のチェックリスト化不足**だった。T8 report は 5 つの所有権喪失シグナルを表にして「6 つ目を足す判断基準」まで明文化しており(「別の書き手がこの op の状態を既に確定させたことが machine-verifiable に判明する箇所」)、次回の同種実装への再発防止になっている。

---

## 5. review 判定が割れた争点の裁定

Codex r3 の 1 件(count phase が上限超過後も後続 PDF の GET/parse を続ける挙動)について、canonical(opus)は **Minor 9**(「資源消費・bounded・spec §3.3 が受容する残余リスクの範囲内」)と判定したのに対し、Codex は **Critical**(「deadline 枯渇 → operation が未終端のまま残る」)と判定した。

**OT 裁定: Codex が正しい。**

根拠: hard kill(Vercel function timeout)されると、`upload_operations` の lease(`LEASE_TTL_MS` = 15 分・`constants.ts:55,104`)が残ったまま operation が `processing` に留まり、UI は poll 経由で最大 15 分「処理中」を表示し続ける。これは reconciler が lease 失効を検知して terminal 化するまでの間、ユーザーから見て「終わらない処理」になる。

**「資源が bounded か」(修正 1 単体の効果 = GET/parse 回数の上限)と「operation が terminal へ収束するか」(修正 2 が要る理由 = deadline チェック)は別の問い**であり、前者が満たされていても後者は満たされない(bounded な資源消費を続けた末に deadline で hard kill されれば、消費量に関わらず未終端は起こる)。canonical はこの 2 つの問いを同一視して Minor に落としていた。

---

## 6. plan からの逸脱 — T4 fixture

plan(brief)が名指しした test fixture `scripts/ai/ocr-samples/mock-exam-set.pdf` は `.gitignore` で `scripts/ai/ocr-samples/*` ごと除外されている(`README.md` のみ例外)ディレクトリに置かれており、fresh clone / CI 相当環境では存在しない。このまま test が依存すると `pnpm test` が repo 外の状態に依存して壊れる。

T4 fix round 1(canonical Critical 是正)で、repo README の既存規約(tracked・架空の fixture は `tests/fixtures/ocr/` に置く)へ寄せた。多ページ検出力(pageCount のオフバイワン等)を維持する必要があったため、既存 tracked の架空 1p PDF(`tests/fixtures/ocr/mock-exam-page1.pdf`)を `qpdf --empty --pages` で 3 回連結し、新規 tracked fixture `tests/fixtures/ocr/mock-exam-3p.pdf`(3 ページ・A4)を生成した。

spec / plan は fixture の具体的な中身に非言及(page count や寸法を指定していない)ため、**これは仕様変更ではない**(T4 report・progress.md T4 節に明記済み)。

---

## 7. spec §6 の文言不整合の修正

`docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md` §6(削除設計・本線 2)の「raced/lost でも削除してよい根拠」の記述を、本 task で実装に合わせて**置換**した(stale 注記の追記ではなく置換・spec の書換え規律の例外として brief で明示的に許可されている)。

**何がずれていたか(1 行)**: 旧文言「1 つの session の object を 2 つの operation が共有しない、ゆえに op が死んでいれば読む者はいない」は**別 operation 間**しかカバーしておらず、T8 が実際に対処した**同一 operationId の複数 invocation(transport 重複の極小窓)**を含んでいなかった — shipped code(`OwnershipState` による 5 シグナルの invocation 単位判定)は spec の記述より厳しいモデルになっており、記述が実装に追いついていなかった。

**なぜずれたか**: r5(uploadSessionId 分離)で「session は operation 間で共有されない」という session 単位の議論に根拠を寄せた際、T8 実装(fix round 2〜3)で見つかった「同一 op 内の invocation 競合」という**別の軸**の議論を spec に書き戻していなかった。設計の更新(実装)が先に進み、spec の記述更新が追いつかなかった([[lesson_single_point_claims_decay]] と同型 — ②-3 の「単一点」主張と同じ「適用範囲を書き洩らす」パターン)。

修正後の文言は spec ファイル本体を参照(§6 該当段落)。

---

## 8. 実測材料

### T1 stg 実証(probe route・2026-08-07)

- 認証付き GET `/api/pdfprobe-pdfium` → `200 {"pages":1}` ×4(初回 nav + fetch 3 回)
- 未認証(`credentials:omit`)→ `401 {"error":"unauthenticated"}`(auth gate 実効)
- **timing**: 初回 navigation **2162ms** / warm fetch **407ms・402ms・182ms**。cold start(Vercel function 起動)と wasm init(`PDFiumLibrary.init()`)は分離不能な計測(単一 probe には両方が同居する)。「初回 ≈2.2s vs warm ≈0.2-0.4s」は spec §9 の未確定項目(PUT 完了→pageCount 確定所要時間)への**初期材料**にすぎず、実 PDF 経路(count/render phase の実 GET + rasterize を含む)の実測ではない。
- deploy 対応確認: probe route は `a31c5f7` で初登場のため、200/401 の応答自体が同 commit 以降を含む deploy が反映済みであることの証拠になった。

### T8 の phase log 設計

`logPhase` に `fetch_source`(render phase の GET 累積)/ `count`(count phase 全体・GET+parse+destroy)/ `rasterize`(render phase の `renderPageWebp` 累積)を追加。fetch と rasterize を分けた理由 = 運用ログから「ネットワーク律速か CPU 律速か」を区別できるようにするため。`peakWebpBytes`(旧 `peakRenderedBytes`・canonical Minor 7 で改名)は「render phase が全ページを生成後まで手放さない設計」ゆえ累積の最終値と等価 — 真の同時保持量ではない(spec D8 の「全冊同時保持しない」は count phase 限定の要求で、render 後の画像列保持は既存 pipeline 全体の構造が前提)。

### 暫定値一覧(すべて「実測後見直し」対象・spec D7/D11)

| 値 | 用途 | 実測状況 |
|---|---|---|
| per-file `MAX_PDF_BYTES` = 50MB | reserve 入力検証(Σ含む declaredBytes 上限) | 未実測(理論上限のみ) |
| batch 合計 `MAX_PDF_TOTAL_BYTES` = 200MB | reserve + submit pre-tx 両方で検証(spec D7) | 未実測 |
| render 後累計 `MAX_RENDERED_WEBP_TOTAL_BYTES` = 30MB | webp_limit_exceeded gate(loud terminal) | 未実測 |
| source GET timeout = 60s(`PDF_SOURCE_GET_TIMEOUT_MS`)| count/render 両 phase の GET + T8 fix round 4 で deadline 判定 3 箇所にも流用(render は per-page timeout が無いための**保守的代理閾値**・GET の実 timeout ではない) | 未実測(60s は既定 `GET_TIMEOUT_MS`=10s では 50MB に不足しうるという理論根拠のみ) |
| lifecycle maxAge = 86400s(実効 ≈48h) | R2 保険 GC(OT 手動設定) | **未設定**(§9 参照。OT 作業は spec §12) |

**位置づけ**: これらはいずれも「商品仕様としての上限」ではなくシステム保護値(spec D7 明記)。Vercel 実 function での実測(T10 sprint close の smoke 項目)後に見直す前提であり、本 task ではその実測を行っていない。

---

## 9. deploy 順序の制約

**T6 + T7 + T8 が揃って初めて PDF が実際に処理される。個別 deploy を禁止する。**

理由(独立レビュアーが 3 回指摘した事実として記録):

- T7 review で Codex P1「pipeline が manifest を消費しない」は当時 **T8 未実装**を指しているだけと判定(spec/plan が render を T8 に割当済み・T7 brief も「受け取るだけで未使用でよい」と明示)。
- T6 review でも同型の指摘が Codex から出て、同じ理由で見送り。
- **この「指摘が正しいが対象は次 task」という判定が 3 回連続した事実自体**が、T6/T7 単独では PDF 対応を **UI に露出しているのに server 側が manifest を消費しない中間状態**であることを意味する。T6 は `accept="image/*,application/pdf"` を復帰させ PDF 選択・PUT・完了通知までを露出する。T7 は manifest を受理し検証まで行うが T8 が無いと render に到達しない。

したがって **T6/T7 のみを stg/prod へ deploy してはならない**。T10(sprint close)の close 報告と smoke 手順にもこの制約を明記する必要がある(まだ T10 は未着手 — 本 doc は申し送りとして記録)。

---

## 10. 未確定 / follow-up

### spec §9(未確定・埋めない)の現況

| 項目 | 状況 |
|---|---|
| PUT 完了 → pageCount 確定までの所要時間 | **未確定のまま**。T1 probe の timing(§8)は同居する複数コストの合算であり、実 PDF 経路の分離測定ではない |
| WASM が Vercel の実 function に同梱されるか | **確定(green)**。T1 stg 実証(§8)で解消 → D1 確定 |
| function bundle size の余裕(wasm 単体 4.0MB は測定済) | **未測定のまま**(trace 全体) |
| R2 CORS の実設定(`application/pdf` PUT) | **未確認**(repo 管理外・OT 作業 spec §12)。T6/T7/T8 は実装されたが実 PDF での end-to-end smoke は未実施 |
| Gemini inline byte 上限 | **未確認**(理論上は既存 40 枚経路と同規模と推定するのみ) |
| 単一 40 ページ文書のメモリ | **未測定のまま**(spec 記載どおり 5p/8p の反復調査止まり) |
| lifecycle maxAge 秒指定が実 API で受理されるか | **未確認**。lifecycle rule 自体が **未設定**(OT 作業・spec §12・harness.md にも明記した外部設定) |

### review で park された Minor(各 task report / ledger より)

- T1: probe route が識別を gating 以外に使わない(意図どおり)/ 埋込み PDF の xref offset に自動検査なし(T8 で probe 自体を削除済 = 解消)
- T2: `completeUploadTx`/`markFailed` の production 呼出ゼロ化(iso test のみが生かす)— OT 判断待ち(§1 表に記載)
- T3: `r2_source_delete.workflow='upload_single_invocation'` は controller 採用確定
- T4: `MAX_LONG_EDGE_PX`(pdf-rasterize.ts)と app 層 `MAX_IMAGE_WIDTH_OR_HEIGHT` の drift 検出なし(既存 `compress-image-safe.ts` の `MAX_EDGE` と同型パターンのため本 task では見送り)/ `destroy()` が head-of-queue の実行中 native render と競合しうる経路は `Promise.all` パターン上構造的に到達不能
- T5: `currentUserOrNull` idiom が 4 file 目で rule-of-three 超過(共通化は範囲外 file を触るため別 task 起票を推奨)/ `handle.destroy()` 自体が throw した場合 object 未削除のまま例外終了(現行実装で発生想定なし)
- T6: generation token(stale response 対策)は配列メンバーシップが既に保証しており検出力ゼロだが、plan が Codex I11 として明示採用した要件のため現状維持(OT 判断事項)/ `declaredBytes=originalSize` 不変の test 未 pin(T7 の contentLength 一致検証が依存する前提)
- T7: filename tie-break / `fileSizeBytes` への PDF `declaredBytes` 含有(表示・集計専用で不変条件に不使用)/ 画像検証の 2 箇所重複(rule of three 未達ゆえ抽象化しない判断)は canonical が修正不要と判定済み
- T8: CAS の「同一 UPDATE 文」文言(spec/brief は 2 表に跨るため文字通りには不成立 — controller 指示の不正確と裁定、実装〈同一 tx 内 fenced UPDATE 2 本〉が正しい)/ Buffer 実体化失敗と `after()` 登録失敗の 2 経路は `runUploadPipeline` を一度も呼ばないため出口 DELETE の対象外(spec §6 lifecycle rule が受け皿・「出口 DELETE が全経路を覆う」と書く時はこの 2 経路を除くと併記する必要がある)/ `pdf_source_unavailable` エラーコードは brief に明記のない独自追加(専用 red 実証なし・他 test で間接的に経験済み)

### Codex plan cross-check(`docs/codex/2026-08-07-plan-ocr-2-4b-pdf.md`)で明示的に見送った項目

- **Important #12**(reserve/finalize の rate limit・endpoint 濫用制御)= spec §3.3 で「本 task では導入しない」と明記済み・**launch 前に OT 判断**(plan Task 10 の公開前 gate に明記あり・未実施)
- **Important #17**(entry 削除時の early best-effort delete)= lifecycle 受容のまま不採用(spec の設計判断どおり)
- **Important #19**(PDF parser の依存脆弱性監査・pin 更新運用)= 既存の exact pin 運用に吸収するのみで専用の追加運用は未整備

---

## 11. rollback 節(Codex I20 対応)

feature rollback(spec/実装を巻き戻す判断が下った場合)に残るものと、その処理方針:

1. **R2 の `src/` 残骸(新経路)**: `sourcePdfObjectKey` が生成する key は `src/{userId}/{uploadSessionId}/{fileId}.pdf`(top-level `src/` prefix)。既存の `scripts/gc-src-prefix.ts`(②-4a S-5a・**旧経路**の残骸一掃 one-shot script)は `SRC_KEY_PATTERN = /^users\/[0-9a-f-]{36}\/src\//`(`users/{uid}/src/...` — nested の**旧**形式)を対象にしており、②-4b の**新**形式(top-level `src/{uid}/{sessionId}/{fileId}.pdf`)には一致しない。rollback 時に新形式の残骸を一掃するには、`gc-src-prefix.ts` の `SRC_KEY_PATTERN` と `listingPrefix()` を新形式(`^src\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$` 相当・listing prefix `src/`)へ改修する必要がある(script の骨格 — dry-run 既定 / `--execute` 明示 / `--user` scope / readback 確認 — はそのまま流用可能。**この改修は本 task では行っていない**、rollback 判断が実際に下った時点で行う)。
2. **lifecycle rule(`src/` maxAge 86400s)**: rollback してもコード側が新規 PUT をしなくなるだけなので、**残置しても無害**(既存 object が対象外になるだけで、他 prefix には影響しない)。撤去必須ではない。
3. **依存(`@hyzyla/pdfium`)**: rollback 対象コード(`lib/media/pdf-rasterize.ts` とその呼出元)を削除すれば依存自体も撤去可能(dead dependency として残さない)。
4. **失敗中 operation**: rollback 時点で `processing` のまま残る PDF 系 operation は、既存 reconciler(lease 失効検知)が terminal 化する既存経路に乗る(専用の追加処理は不要)。
5. **probe route / CORS 設定**: probe route は T8 で既に撤去済み(§1)。CORS(`application/pdf` PUT 許可)は R2 側設定であり、rollback しても他用途に影響しないため撤去不要(残置無害)。

## `src/` 残骸の手動点検手順(Codex I16 は部分採用)

Codex plan cross-check の Important #16 は「`src/` 最古 object age の定期監視・lifecycle 誤設定の検知・DELETE failure のアラート条件」を求めていたが、**定期 cron 監視の新設は本 sprint では導入しない**(既存運用方針 = 破壊的 GC 系 script は OT 手動実行が確立パターンであり、新規の常駐監視を増やさない)。

採用したのは**手動点検の 1 手順**のみ: `lib/storage/r2.ts` の `listObjects('src/')` を(既存の `gc-src-prefix.ts` と同様の one-shot 実行で)呼べば、その時点で `src/` prefix 配下に残っている全 object を列挙できる。sprint close(T10)の smoke 手順に「完了後 R2 `src/` 残骸ゼロ」が既に含まれており(plan Task 10 記載)、それ以外の**定常運用としての監視は導入しない**という判断を明示的に記録する。
