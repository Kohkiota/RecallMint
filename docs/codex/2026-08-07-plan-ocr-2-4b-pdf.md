# Codex plan cross-check — ocr-2-4b-pdf (2026-08-07)

- **作成日**: 2026-08-07
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

### 1. count phase と render phase 間の TOCTOU

最重要論点です。正本 count が正しくても、その後の render が同一 object を読む保証がありません。

- presigned PUT の有効期間中は同じ key に再 PUT できる。
- count phase と render phase は別 GET。
- count 後に「40 ページ以下の PDF」から「41 ページ以上または別内容」へ差し替えられると、層3の上限保証が崩れる。
- `expected_source_count` は count 時の値、実際の Gemini parts は render 時の値となり、課金記帳・publish 整合性も崩れうる。
- finalize の pageCount と submit pre-tx の間にも同じ差し替え窓がある。

count 時に ETag/version/hashを確定し、render GET を条件付きにする、または count で取得した同一 bytes を再利用できる構造が必要です。「count を再実行する」だけでは、count と render の同一性は保証されません。

### 2. サイズ上限が処理量を十分に拘束しない

「合計ページ40 + per-file 50MB」では、入力総量は最大約2GBです。count/render の2巡なら最大約4GBをR2から読む可能性があります。

- 1ページ50MBのPDFを40冊投入できる。
- 冊数上限を設けないため、HEAD/GET、PDF parse、WASM初期化・解放回数も増える。
- 40ページサンプルの3～4MBという実測は、任意のスキャンPDFや高エントロピー画像には一般化できない。
- rasterize後WebPの合計サイズにも上限がなく、Gemini inline request、base64、メモリの既存4MB前提を外れる。

商品上の「冊数上限なし」と、システム保護上の「1 batch の原本総bytes・presign件数・HEAD/GET回数上限」は分けて検討すべきです。

### 3. PDF parser / rasterizer に対する資源枯渇防御

50MBという圧縮後サイズだけでは、PDF内部の複雑度を拘束できません。

- 巨大ページ寸法、極端な座標、巨大画像、圧縮爆弾、深いobject graph、破損xref等。
- GET timeout 60秒はネットワークにしか効かず、`loadDocument`、page count、render、sharp encodeのCPU停止を中断できない可能性がある。
- PDFiumは非信頼PDFを解析するネイティブ由来コードであり、exact pinだけでなく脆弱性更新方針が必要。
- 長辺2048への縮小前に、PDFium側が巨大な中間領域を確保しない保証が必要。
- 暗号化PDF、パスワード付きPDF、部分的破損PDFの分類とterminal codeが未定義。

ページ単位だけでなく、文書単位のCPU期限、最大ページ寸法、失敗時の確実なhandle破棄、異常PDF fixtureが必要です。

### 4. 「逐次処理」とピークメモリは同義ではない

renderを逐次化しても、生成した全ページのWebPやbase64をGemini invocationまで配列に保持するなら、ピークは1ページ分ではありません。

確認すべき保持期間は以下です。

- PDF原本Buffer
- PDFium document/WASM heap
- raw BGRA
- WebP Buffer
- `verifyImageBytes`後のBuffer
- base64文字列
- Gemini parts配列
- crop用のページ原本

特にcropがGemini応答後であるため、全ページ画像をcrop完了まで保持する設計か、再生成する設計かを明示する必要があります。

### 5. object内容の検証契約

HEADの「存在・上限以下」だけでは不足します。

- `Content-Length` がpresign時の `declaredBytes` と一致するか。
- `Content-Type` が署名値およびHEAD値で `application/pdf` か。
- `%PDF-` magicやPDFium parseのどちらを受理条件とするか。
- 空object、途中切断、HEADとGETのサイズ不一致。
- PDF polyglotを許容するか。
- R2側ETagをどこで取得・照合するか。

特にdeclaredBytesをmanifestにも持つ以上、「≤50MB」だけでなく一致検証をしないと値の意味が曖昧です。

### 6. manifestの完全性・一意性

順序付きmanifestには、以下の機械保証が必要です。

- `fileId` の重複禁止。
- image `fileIndex` の重複・欠番・範囲外禁止。
- FormData画像とmanifest画像が1対1であること。
- 同じPDF keyを褣数回並べてページ数・課金を二重計上しないこと。
- manifestにないFormData fileや、FormDataにないimage entryを拒否すること。
- filename、declaredBytes、pageCountに余剰フィールドや型 coercionを許さないこと。
- PDFゼロ・画像ゼロの空uploadを拒否すること。

順序維持だけでなく「入力集合との全単射」が必要です。

### 7. 台帳なし方式に伴う濫用面

台帳なしでも所有境界はuserId prefixで表せますが、無制限のreserve/finalize呼び出しによるコスト発生は別問題です。

- reserveを大量発行してR2に最大50MB objectを蓄積できる。
- submitしないobjectは最大約48時間残る。
- finalizeを重複呼出すと同一50MBを何度でもGET・parseできる。
- echoを偽造してsubmitし、層3まで意図的に高コスト処理を到達させられる。
- account quota強制が非スコープでも、endpoint rate limit・同時実行数・request件数制限は必要になりうる。

これはページ課金quotaとは別の、ストレージ・帯域・CPU abuse対策です。

### 8. 削除の保証境界とプライバシー表現

「処理中のみ」と「最大約48時間残りうる」は利用者視点では差があります。

- 選択削除、画面離脱、通知後未submitは明示DELETEされない。
- platform killではlifecycleのみ。
- lifecycle設定漏れ・誤prefix・prod bucket未設定時に無期限化する。
- DELETE失敗の記帳自体が失敗した場合の検知経路がない。
- finalize rejectでDELETEが失敗しても、返すerrorと監視イベントをどう扱うか未定義。

「処理中のみ」は論理目的であり、実保持上限は約48時間という説明・プライバシー台帳・運用監視を揃える必要があります。entry削除時にbest-effort DELETE actionを設ける余地もあります。

### 9. 全終了経路を `finally` 相当で覆えるか

成功・代表的terminal・CAS競合を列挙するだけでは、将来追加されたreturn/throw経路が削除を回避し得ます。

- GET timeout
- HEAD/GET不整合
- PDF parse error
- render途中失敗
- sharp失敗
- Gemini前の予算不足
- normalize失敗
- unexpected exception
- CAS更新0件
- integration failure記帳失敗

source cleanupは列挙分岐より、所有権を明確にした外側の `try/finally` と、削除対象manifestの固定化で構造保証する方が安全です。

### 10. raced/lost時に削除してよいという前提の検証

`start_cas_lost` / `commit_raced` 時点で「他に読む者はいない」という主張は、既存replay・lease takeover・reconcilerとの状態遷移で証明が必要です。

別pipeline invocationやlease successorが同じmanifestを利用し得るなら、敗者によるDELETEは勝者を壊します。少なくとも競合時系列テストが必要です。

### 11. sentinel `expected_source_count = 0` の整合性

0 sentinelはmigration不要でも、意味変更の影響があります。

- 既存CHECK、監査、メトリクス、運用SQL、reconcilerが正数を仮定していないか。
- count CAS前にterminal化したoperationを集計すると0ページに見えないか。
- `pages_total=NULL` と0 sentinelの組合せを状態と結びつけて検証できるか。
- CAS成功を確認する前にrenderへ進まないこと。
- 2列を同一UPDATEで原子的に確定すること。

schemaコメントだけでなく、状態別不変条件としてpinすべきです。

### 12. UI非同期競合

batchキーとentry状態にはブラウザ側の競合があります。

- PDF削除後に遅れてfinalizeが完了し、削除済entryをreadyへ戻さないか。
- 同じファイルのretryで旧PUT/finalize応答を採用しないか。
- batch reset後に旧idempotencyKeyの非同期処理が新batchへ混入しないか。
- 複数追加操作の完了順で選択順が崩れないか。
- submit中の削除・追加・二重submitをどう止めるか。
- object URLやAbortControllerを解放するか。

entry generation/tokenによるstale response排除が必要です。

### 13. 外部設定はリリース前提条件

R2 CORSとlifecycleは「実装と並行可」でも、機能公開時には必須です。

- CORSで必要なのは単純なMIME許可ではなく、origin、method、allowed headers、署名済みContent-Type/Content-Length等の組合せ。
- dev/prod両bucketへの設定readbackが必要。
- lifecycle APIが秒指定を受理する実証が未完。
- lifecycle設定なしでコードだけdeployされる順序を防ぐrelease gateが必要。
- rollback後にも既存`src/` objectを回収する手順が必要。

### 14. 観測可能性と障害分類

phase log追加だけでなく、少なくとも以下を区別できる必要があります。

- upload PUT失敗
- finalize HEAD/GET/parse失敗
- count/renderでのobject差し替え
- page limit
- render/encode失敗
- source DELETE失敗
- lifecycle残骸件数・最古age
- PDF pages、source bytes、rendered bytes、各phase時間
- WASM init失敗とbundle欠落

filename、presigned URL、object keyなどのログへの露出範囲も決める必要があります。

---

## plan ドラフトへの抜け・未考慮指摘

### Critical

1. **Task 8にcount GETとrender GETの同一性保証がない**

   このままでは層3を通過後にobjectを差し替えられ、40ページ保証と課金値が崩れます。ETag/version/hashの固定と条件付き取得、その失敗時のterminal化・DELETE・テストが必要です。

2. **合計source bytesとrender後bytesの上限がない**

   40冊×50MB×2巡を許容しています。Geminiへ渡すWebP合計も無制限です。既存画像経路の4MB前提を維持できるか、PDF経路用の明示的な総量guardを設けるかを決める必要があります。

3. **逐次render testが実際のピーク保持量を保証しない**

   Task 4の「同時render 1」はAPI呼出並行度しか見ません。Task 8で全WebP/base64を保持するならメモリは累積します。ページ画像の所有期間を設計し、40ページ高エントロピーfixtureでピークまたは保持数を検証すべきです。

4. **削除が構造的に全throw経路を覆う記述になっていない**

   「全経路でDELETE」という列挙だけでなく、pipeline外周のcleanup構造、削除対象確定時期、unexpected exception testが必要です。

### Important

5. **Task 5/7のHEAD検証がdeclaredBytesとの一致を要求していない**

   `≤ MAX_PDF_BYTES`だけでは署名済み長さとmanifest値の関係がpinされません。Content-Type、Content-Length、ETagも含めた契約が必要です。

6. **Task 7にmanifest完全性テストがない**

   duplicate fileId/fileIndex、欠番、範囲外、余剰FormData、同じPDFの二重参照、空manifestを追加すべきです。

7. **Task 5の「越権fileId」テストは所有権テストとして弱い**

   自userId prefixのHEAD不在を確認するだけで、他userのkeyをclientが指定できないことを直接pinしていません。actionがkey文字列を一切受理せず、認証userIdからのみ構築することをテストすべきです。

8. **PDFiumのCPU timeout・異常複雑度試験がない**

   壊れbytesだけでなく、暗号化PDF、巨大MediaBox、巨大埋込み画像、parse/render timeout、途中ページ失敗、必ずdestroyされることが必要です。

9. **Task 8のCAS fencing testが不十分**

   lease不一致だけでなく、CAS更新件数0ならrender/Geminiへ進まないこと、2列が原子的に更新されること、sentinelのままpublishされないことをpinすべきです。

10. **競合敗者によるDELETEの安全性テストがない**

    `start_cas_lost` / `commit_raced` と、replay・並行submit・lease更新の時系列を組み合わせたiso testが必要です。

11. **UIのstale callback対策がない**

    entry削除、retry、batch reset後に旧PUT/finalize応答が状態を上書きしないテストをTask 6へ追加すべきです。

12. **reserve/finalizeの濫用制御がない**

    冊数上限を商品仕様として設けない場合でも、1 actionあたりのID数、同時PUT、finalize同時数、endpoint rate limitを検討すべきです。

13. **R2外部設定がTask 10の確認項目に留まっている**

    lifecycle/CORSはsmoke項目ではなく公開前gateです。設定readbackがgreenになるまでfeatureを有効化しない順序が必要です。

14. **probe routeが一時的に公開・無認証**

    入力なしでもWASM初期化を繰り返せる公開endpointになります。推測困難な一時URL、環境制限、認証、staging限定のいずれかが必要です。

15. **実機能のVercel実証が遅い**

    Task 1は単純な1ページprobeのみです。Task 8後の実経路について、R2 GET×2、PDFium、sharp、Gemini前までのstaging実証が必要です。probe成功だけでは実pipelineのbundle・時間・メモリを保証しません。

16. **cleanup残骸の運用検査が単発**

    sprint smokeで残骸ゼロを見るだけでなく、定期的に`src/`最古object ageを監視する仕組み、lifecycle誤設定の検知、DELETE failureのアラート条件が抜けています。

17. **entry削除時の早期DELETEが未検討**

    spec上はlifecycle受容ですが、「処理中のみ保持」という目的からは、ready/error entry削除時にbest-effort deleteを行う選択肢を明示的に比較すべきです。

18. **terminal codeとUI/status契約の確認がない**

    `page_limit_exceeded`、PDF parse/render failure、source fetch failureが既存`/api/exams/status`とresult UIで意味のある状態として表示されるかを確認する必要があります。「poll変更なし」で済むとは限りません。

19. **library保守方針がexact pinで止まっている**

    PDF parserは攻撃面が大きいため、依存監査、脆弱性更新、pin更新時のfixture/build/staging再検証を運用に含めるべきです。

20. **rollback/runbookがない**

    feature rollback後に残る`src/` object、失敗中operation、lifecycle rule、CORS、dependency、probe deploymentをどう扱うかが未定義です。

---

## リスク / 対立しうる設計判断

| 設計判断 | 利点 | 主なリスク・対立点 |
|---|---|---|
| count/renderを2巡GET | render前に合計上限を確定、同時保持を1冊に限定 | object差し替えTOCTOU、帯域2倍。ETag固定がなければ正本保証にならない |
| 台帳なし | migration・RLS・GC laneを回避 | 未submit objectの即時回収不能、濫用追跡困難、ETag/pageCountをserver保持できない |
| 冊数上限なし | UX仕様が単純、ページ上限一本化 | 最大40×50MB、HEAD/GET/parse回数、presign abuse。総bytes制限との両立が必要 |
| per-file 50MBのみ | 大きなスキャンPDFを受理 | batch最大2GB、2巡4GB、CPU複雑度を拘束しない |
| lifecycleを放棄回収の唯一手段とする | DB台帳不要 | 最大約48時間保持、設定ミス時無期限、削除SLOを保証できない |
| `expected_source_count=0` sentinel | migration不要、既存列を再利用 | 既存意味の変更、監査・集計誤読、CAS前死亡時の曖昧さ |
| PDF含有なら`fileType='pdf'` | 永続記録が虚偽にならない | 混在uploadを単一enumで表せず、「すべてPDF」と誤読される可能性 |
| ページ番号を永続化しない | schema V2/migrationを回避 | 障害調査、再現、ユーザー問い合わせ時に原ページを特定できない |
| render画像列を既存pipelineへ合流 | prompt/normalize/crop/publishを維持 | 全画像保持によりメモリ累積、Gemini request bytesが既存境界を超える |
| source削除を競合敗者にも許す | 残骸を減らす | 別invocationが同じsourceを読む可能性があるなら勝者を破壊 |
| finalizeを無状態・再実行可能にする | 冪等面が単純 | 大容量GET/parseを無制限に反復できる |
| exact pinの小規模wrapper |依存面を限定 | PDFium脆弱性修正を自動追随しない。更新運用が別途必要 |
| 外部設定をOT手動にする | repo変更を小さく保つ | dev/prod drift、設定漏れ、機能公開と削除保険の順序不整合 |

現状のまま実装へ進む際の最大の設計阻害点は、**2巡GET間のobject同一性保証**と、**ページ数だけでは拘束できない総bytes・render後bytes・CPU複雑度**です。この2点は「実装詳細」ではなく、層3を正本と呼べるか、および運用可能な負荷上限を持つかに直結します。