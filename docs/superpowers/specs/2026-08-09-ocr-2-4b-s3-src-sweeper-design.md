# ②-4b §3: `src/` 定期 age-based sweeper 設計 spec

- 関連: §1 spec `2026-08-09-ocr-2-4b-s1-staging-delete-design.md`(catalog 規律・best-effort の考え方)/ §2 spec `2026-08-09-ocr-2-4b-s2-deletion-src-purge-design.md`(予算付き purge の idiom・「listing は snapshot でない」)/ fact-finding `docs/audit/2026-08-09-ocr-2-4b-s1-factfinding.md`(§3.5 sentinel 台帳・§4.3 台帳 4 軸・§5.3(e) 旧 script 非流用)
- 親 spec(key 規約・凍結): `2026-08-07-ocr-2-4b-pdf-rasterize-design.md`
- kickoff 確定事項(蒸し返さない): Vercel Cron 日次 1 回 / age cutoff 初期値 6h / 検証 = CRON_SECRET 付き手動 GET(scheduler 実発火検証は prod 反映後・close 条件外)/ 台帳なし(次回 listing 再該当が retry)/ 失敗記録の catalog 分割規律は §2 と同じ / 入口・失敗記録・alert・実行 readback は汎用(asset reconciler を close 後 sprint で 2 本目の lane として挿せる形)
- 用語: 本 spec の **sweeper** = `src/` prefix 全体(user 横断)の age-based 定期回収。§1 の registry purge / §2 の退会 prefix purge とは別機構。

## 1. 目的

`src/{userId}/{uploadSessionId}/{fileId}.pdf` に残った期限超過 object(§1 checkpoint の取り漏らし・DELETE 失敗・所有権喪失 skip・§2 purge の打ち切り残・finalize reject の削除失敗)を日次で回収し、あわせて「cutoff を大幅に超過した object の残存」を検知して alert する。後者は lifecycle rule(効果の実測が現時点で無い — fact-finding §3.4)を含む回収機構全体の効果監視の正本になる(§4 論点)。

## 2. 現物確認の結果(read-only・2026-08-09)

- **listing は key のみ**: `parseListObjectsPage` は `<Key>` だけを抽出し `LastModified` を捨てている(`lib/storage/r2.ts:361-363`)。`listObjectsBounded(prefix, maxPages, opts)` が pagination(`list-type=2` + continuation-token・1 page ≈ 最大 1000 key・`LIST_TIMEOUT_MS = 10_000` は **1 page ごと**)と truncated 通知を持つ(`r2.ts:326-378`)。§2 spec はこの拡張判断を §3 に明示的に申し送っている(s2 spec :60-61)。
- **src/ の正当な読者は 2 つだけ**: ① finalize(`headObject`/`getObject`・PUT 直後の client flow 内, `finalize-pdf-source.ts:83-88`)② pipeline の count/render phase(`upload-pipeline.ts:256,388`)。takeover は撤去済で publish-prepared 経路は src/ を再読しない(`crop-and-store.ts:158`「takeover 撤去後」・`upload-pipeline.ts:1042`「新経路に retry / takeover は無い」)。
- **時間定数**: presign 有効期限 600s(`r2.ts:35`)/ client PUT timeout 60s(`PDF_PUT_TIMEOUT_MS`, `constants.ts:35`)/ lease TTL 900s(`LEASE_TTL_MS`, `constants.ts:55`)/ upload page `maxDuration = 720`(`page.tsx:23`)/ pipeline 予算 660s(`UPLOAD_PIPELINE_BUDGET_MS`, `constants.ts:75`)。pipeline の src/ GET は必ず live lease(発行 = submit sync tx, `submit-upload.ts:609`)の内側で起きる。live 判定述語は既存 `isLiveUploadOperationCondition()`(`lib/exams/source-doc-status.ts:107-113`)。
- **key → operation の対応は DB に無い**: `upload_operations` は `uploadSessionId` も objectKey も持たない(`schema.ts:903-953`)。sourceKeys は client manifest から毎回導出(`upload-pipeline.ts:513-517`)。つまり **object 単位の「処理中か」問い合わせは構造的に不可能**で、live 判定は user 単位が最細粒度。
- **staging は純 client state**(v58 裁定・fact-finding §2 反例なし): submit 前の staged object には DB 痕跡が無い。
- **lifecycle rule**(prefix `src/`・maxAge 86400s)は OT 手動設定・repo 定義なし・**実削除の実測ゼロ**(`docs/harness.md:42`・fact-finding §3.1/§3.4)。現行 credential で rule 本体の readback は 403(fact-finding §3.2)— 代替 readback = 「src/ 最古 object age」で、本 sweeper の alert がそれを常設化する。
- **cron 前例ゼロ**: `vercel.json` に `crons` なし(regions hnd1 + webhook maxDuration 60 のみ)。`CRON_SECRET` は env・コードとも 0 hit。env gate の既存 idiom = `requireWebhookSecret(envKey, label)`(`lib/env/webhook-secret-gate.ts`: production 欠落 throw → 500 / preview warn + '' / local '')。
- **台帳 catalog**: 14 entry(`lib/integration-failures.ts:18-162`)。workflow 既存値 = scheduled_downgrade / null / user_deletion / asset_gc / upload_single_invocation / upload_staging。fact-finding §4.3 が §3 へ「新 workflow 値を足すのが正(相乗り禁止)」と申し送り。`recordIntegrationFailure` は INSERT 失敗を握るが **notifyOps の production fail-fast throw は伝播する**ため、呼び出し側の個別 try/catch が必須(§2 の `recordSrcPurgeRow` idiom, `handle-clerk-event.ts:481-503`)。
- **§2 の予算 idiom**(踏襲元): deadline slicing・`MIN_SLICE` 打ち切り・chunk 並行 DELETE・phase 語彙(配列順 = 優先順位)・incomplete 行は最後に 1 本・`MAX_FAILURE_ROWS` と heldFailure(`handle-clerk-event.ts:53-64, 327-476`)。
- **旧 script は流用しない**: `scripts/gc-src-prefix.ts` は旧経路 `users/{uid}/src/` 用で新 key に一致しない(fact-finding §5.3(e))。
- **sentinel**(§4 判定・不可触): user `85541b25-…` 配下に 2 本。A 境界 = 2026-08-10T11:44Z / B 境界 = 2026-08-11T01:09Z(fact-finding §3.5)。cutoff 6h は両方を対象化する。

## 3. 設計

### 3.1 入口 — 汎用 cron runner + lane

- `app/api/cron/sweep/route.ts`(GET・`runtime = 'nodejs'`・`export const maxDuration = 300`)。vercel.json に `{ "crons": [{ "path": "/api/cron/sweep", "schedule": "0 18 * * *" }] }`(= 03:00 JST。発火 = production のみ・自動 retry なし・duplicate/並走あり)。
- 認証: `requireWebhookSecret('CRON_SECRET', 'Vercel cron')` を再利用。**secret が空文字なら無条件 401**(preview/local の '' fallback が「誰でも叩ける」に転じないための明示ガード)、`Authorization !== 'Bearer ' + secret` も 401。production で env 欠落は既存 gate の throw → 500(fail-fast)。**CRON_SECRET 未設定 = 掃かれない**という fail-closed が、stg での §4 sentinel 保護の防波堤を兼ねる(§8)。
- runner は lane 配列を順次実行する薄い枠のみ: `lanes: Array<{ name: string; run(ctx: { deadlineAt: Date }): Promise<LaneSummary> }>`。各 lane は throw しない契約(内部 catch → summary に error 反映)。runner の外周 catch は logger.error + 500。今回の lane は `src_sweep` の 1 本(asset reconciler は close 後 sprint で 2 本目)。**判定ロジックはレーン別のまま**(kickoff)— runner が共通化するのは入口・auth・deadline 配布・実行 readback だけ。
- 実行 readback(汎用): ① response body = lane ごとの summary JSON(`{ lane, listed, candidates, deleted, failed, skippedLiveUsers, patternMismatch, overdueCount, truncated, phase }` 程度・手動 GET 検証用)② `logger.info({ event: 'cron.lane.run', lane, ...summary })` を毎 run(Vercel logs が定常記録)。**成功 run は台帳に書かない**(integration_failures は失敗記録専用・INSERT-only grant)。Discord へは失敗・alert 経由(recordIntegrationFailure → notifyOps)のみ流す — 日次の正常 run で通知を鳴らさない。

### 3.2 選定 — listing 拡張と age 判定

- `lib/storage/r2.ts` の parse を `<Contents>` block 単位で `Key` + `LastModified` の組に拡張し、`listObjectsWithMetaBounded(prefix, maxPages, opts): Promise<{ entries: { key: string; lastModifiedMs: number }[]; truncated: boolean }>` を追加する(§2 spec からの申し送りの決着 = 「別 helper 追加」でなく **parse 共通・公開関数追加**。既存 `listObjects` / `listObjectsBounded` の signature と挙動は不変で、既存 test が regression pin になる)。
- **strict parse は fail-closed**: `<Contents>` block に parse 可能な `LastModified` が無い page は listing 失敗として扱う(既存の壊れた 200 応答を「空」に正規化しない方針の延長)。**age が読めない object は削除しない**。
- 候補 = `now - lastModifiedMs > SWEEP_CUTOFF_MS(6h)`。時計は sweeper の `Date.now()` と R2 の lastModified の比較になるが、skew は cutoff 6h に対し無視できる。
- **smoke 用 cutoff override(OT 裁定・採用)**: 手動 GET 限定の `?cutoffMinutes=`(**下限 15min** = presign 600s + PUT 60s + 余裕。cron 発火はクエリ無しのため既定 6h のまま)。非整数・下限未満は **400 で拒否**(clamp しない — silent な意味変更を作らない)。**override 使用時は summary / log に実効 cutoff を `cutoffOverrideMinutes` として必ず含める**(既定 run か override run かを readback で区別できない記録を残さない)。
- **key 形の関門**: 候補は `^src/{uuidv4}/{uuidv4}/{uuidv4}\.pdf$` に一致するものだけ DELETE 対象にする(§2 の破壊境界二重関門と同旨)。不一致 object は**削除せず** `reason: 'pattern_mismatch'` で記録して lifecycle に委ねる(§10 論点 3)。
- listing page 上限 `SWEEP_MAX_LIST_PAGES = 10`(≈ 10,000 key)。truncated は phase `list_truncated` として incomplete 行に記録し、残りは翌日 run が拾う(age 条件は翌日も真のまま = 台帳なし retry の原理)。

### 3.3 active window 保護(不変条件 1 の解)

「lastModified が cutoff より古いのに正当に生きている」object は 2 クラス存在する。**純 age 判定だけでは安全と言えない**ため、クラス (ii) には DB 除外を足し、クラス (i) は仕様として受容する:

- **クラス (0)(存在しない側の論証)**: PUT 途中の object は存在しない(S3 互換 PUT は atomic・完了時に lastModified が付く)。presign 発行済み未 PUT は「object 未存在」であり、着地しうるのは reserve + 600s(presign 失効)まで。client timeout(60s)後に R2 側で着地する uncertain outcome(§1 checkpoint 2 の対象)も、着地時刻 = lastModified になるため sweeper から見れば age 0。**「古いのにまだ読めるようになっていない」object は構造的に存在しない**。finalize の read は PUT 直後の client flow 内で、age は分オーダー。
- **クラス (i): staged 未 submit**(DB 痕跡なし・純 client state)。ユーザーが staging したまま 6h 以上放置して後から生成を押す場合、正当だが sweeper と識別不能。**cutoff 6h はこの放置を abandoned とみなす policy line(OT 確定)**。掃かれた後に submit すると count phase の `getObject` が null → `pdf_source_unavailable` で terminal 化 = **loud fail・再 upload で回復可能**(silent 破壊ではない。card データは無関係)。この失敗クラスは lifecycle(24〜48h)で今日も既に起きうるものの時間繰り上げであって新種ではない。
- **クラス (ii): 処理中 invocation の source**。submit 後の src/ GET は必ず live lease(TTL 900s)の内側で起きる(§2 現物確認)。よって **DELETE 前に user 単位の live-op 除外**を行う: 候補 key から userId を抽出し、その user の DELETE batch **直前**に `withTenantTx(userId, tx => EXISTS(isLiveUploadOperationCondition()))` を評価、live なら当該 user の全候補を今回 skip(翌日再考)。key→op の対応が DB に無い(§2 現物確認)ため user 単位が最細粒度であり、false positive(無関係な live op で skip)の代償は最大 1 日の回収遅延 = 無害。live 判定クエリの失敗も skip に倒す(fail-safe・phase `live_check`)。
  - **数値の余裕**: live lease は submit + 900s まで、invocation の src/ 最終 GET は submit + 660s(予算)以内 → 除外判定が保護すべき窓は lease が完全に覆い、240s のマージンがある。cutoff 6h は lease TTL の 24 倍で、「live でない = もう読まれない」の判定を時間側からも支える。
  - **残余 TOCTOU**: live check と DELETE の間(秒オーダー)に同一 user が ≥6h 前の staged object を submit する窓が残る。発生には「日次 run の数秒幅」と「6h 放置後のちょうどその瞬間の submit」の一致が要り、起きても帰結はクラス (i) と同じ loud fail。lock は作らない(kickoff)ため受容し §10 に記録。

### 3.4 削除と予算

- §2 の idiom を踏襲(ただし定数・phase 語彙は sweeper 側で独立定義。§2 の値を import で共有しない — 2 箇所目であり rule of three 未満、意味も別): `SWEEP_BUDGET_MS = 270_000` / `SWEEP_TAIL_RESERVE_MS = 10_000` / `SWEEP_MIN_SLICE_MS = 2_000` / `SWEEP_DELETE_CHUNK = 20` / `SWEEP_MAX_FAILURE_ROWS = 20`。route `maxDuration = 300` は「LIST 10 page × 10s + DELETE chunk 郡 + 台帳 tail」の必要値で、platform 上限(900)は与えない。
- user ごとに candidates をまとめ、live 除外 → chunk 並行 DELETE(`deleteObject` は never-throw・404 = 成功系)。chunk 境界ごとに残予算 < MIN_SLICE で打ち切り(phase `deadline`)。
- 定常状態は候補 0 件(本線 DELETE が機能していれば src/ は数分で空になる)で、listing 1 page で終わる。予算が効くのは大量 leak 時のみ。

### 3.5 失敗記録 — catalog 新 entry 3(workflow = `src_sweep`)

§2 と同じ分割規律(実削除失敗 1 件 1 行 / 制御系は別 entry・4 軸は「結果」を識別し原因は context.phase):

| key | service | operation | workflow | failureCode | 行の意味 |
|---|---|---|---|---|---|
| `r2_sweep_delete` | r2 | object.delete | **src_sweep** | external_api_error | 実削除失敗 1 object 1 行。context = `{ objectKey, status }` + pattern 不一致のみ `reason: 'pattern_mismatch'`(DELETE 未試行の構造化 discriminator・§2 と同形) |
| `r2_sweep_incomplete` | r2 | src_sweep.incomplete | src_sweep | incomplete | 制御系打ち切り・1 run 最大 1 行・最後に書く。context = `{ phase, listed, deleteRequested, remaining, suppressedFailures? }`。phase 語彙 = `['list', 'live_check', 'list_truncated', 'deadline']`(配列順 = 優先順位・§2 idiom) |
| `r2_sweep_overdue` | r2 | src_sweep.overdue | src_sweep | state_mismatch | §3.6 の期限超過 alert・1 run 最大 1 行。context = `{ count, oldestKey, oldestAgeHours }` |

- workflow 新値 `src_sweep` により upload_staging(§1)/ user_deletion(§2)/ upload_single_invocation(pipeline 出口)と 4 軸で区別(fact-finding §4.3 の申し送りどおり)。
- 各記帳は §2 の `recordSrcPurgeRow` と同じ個別 try/catch で包む(notifyOps throw の伝播で以降の削除を巻き込まない)。行数上限 20・最後の 1 枠を incomplete に譲る heldFailure も踏襲。
- context に入る PII は objectKey / userId(内部 uuid)のみ(§2 precedent)。Clerk ID は扱わない。
- 記帳の重複(§5 並走)は許容し、集計側は「行 = イベント」で読む(objectKey で dedupe 可能)。

### 3.6 期限超過の検知(不変条件 4 の解)

- **DELETE 実行前の listing snapshot** に対して `age > ALERT_AGE_MS(72h)` の object を数え、1 件以上なら `r2_sweep_overdue` を 1 行記録(→ Discord)。**先に評価する理由**: 今回の DELETE が成功しても「72h 生き延びた = 過去の sweeper run(≥2 回)と lifecycle(実効 ≈48h)の両方が回収に失敗していた」という事実は消えないため。
- 72h の根拠: sweeper の保持上限(§4 の式・worst ≈ 55h)と lifecycle 実効上限(≈48h)の両方を超える最小の丸い値。ここに到達した object は「どの機構も回収しなかった」ことの証拠で、これが lifecycle の効果監視の常設 readback(fact-finding §3.3 の「最古 object age を測る」の運用形・§4 台帳の後継)。
- 条件が続く限り毎日 1 行 = 毎日 1 通知。rate-limit しない(P0RLS と同じ「実障害の loud signal」受容・1 run 1 行で bounded)。
- **overdue alert は cutoff override(§3.2)の影響を受けない**(OT 裁定): `ALERT_AGE_MS` は `SWEEP_CUTOFF_MS` から独立した定数で、`?cutoffMinutes=` で cutoff を縮めても alert 閾値は 72h のまま。test で pin する(§9)。

### 3.7 やらないこと

- lock / 分散排他(kickoff 確定。§5 で並走安全を設計側で保証)
- 削除の readback(listing 再確認)— §2 と同じく「削除要求の完了」まで
- sweep 状態の永続化(台帳なし確定。次回 listing 再該当が retry)
- 旧経路 `users/{uid}/src/` の回収(`gc-src-prefix.ts` の領分・OT 手動)
- asset reconciler lane の実装(close 後 sprint。本 spec は挿せる形だけ作る)
- upload_operations / source_documents への schema 変更(key→op 対応の導入は不採用 — user 単位除外で足りる)

## 4. 保持上限の式(不変条件 3 の解)

観測されうる最大保持時間 T_max = cutoff + 実行間隔 × 2(1 回 skip 許容)+ schedule 揺らぎ + 走査最大時間:

- Pro plan: 6h + 48h + ~1min + 300s ≈ **54.2h**
- Hobby plan: 6h + 48h + 59min + 300s ≈ **55.2h**
- 正常系(skip なし): 6h + 24h + 揺らぎ ≈ **30h**

ALERT_AGE 72h > T_max(両 plan)であり、alert は「式の範囲内の正常な遅延」では発火しない。**前提 readback(plan 段階・OT)**: ① Vercel plan の確定(maxDuration 720 が既に prod で動いている事実は Pro を示唆するが、記録の不在を事実にしない — 要確認)② stg deployment の形態(stg が別 project の production なら cron は stg でも発火する — §8 の env gating に影響)。

## 5. 並走・duplicate 安全性(不変条件 2 の解)

Vercel Cron は duplicate delivery・並走を公式に許容し、手動 GET も任意時刻に並走しうる。lock は作らない。安全性は各操作の性質で保証する:

- **R2 状態**: DELETE は冪等(404 = 成功系・`r2.ts:439-441`)。並走 2 実行が同じ listing を見て同じ key を撃っても、結果は「消えている」に収束する。順序の入れ替わりで壊れる状態遷移が存在しない(操作は DELETE のみ・PUT しない)。
- **live-op 除外**: 読み取りのみ。並走しても判定が破壊的に食い違うことはない(片方 skip・片方 delete は、check 時刻の差による正当な判定差で、delete した側も check を通過している)。
- **台帳**: INSERT-only の event 記録。並走で同一 object の失敗行が 2 本入りうるが state を持たないため壊れない。**集計側への含意**: 行数 ≠ object 数。objectKey + createdAt で dedupe して読む(§3.5 に記載済)。overdue 行も run ごとに独立で、重複は「その時刻に条件が真だった」記録として正しい。

## 6. listing 非 snapshot(不変条件 5 の解)

§2 で確立した「listing は snapshot でない」は sweeper では**無害化される**: pagination 中・LIST 後 DELETE 前に着地した新規 PUT は lastModified が今 = age 0 で、listing に載っても cutoff に達しないため削除されない。取り漏らし側(listing に載らない)は翌日 run が拾う。即時性が要る §2(退会)と違い、age 条件が時間差を吸収する — これが「記録がある側は遅延してよい」原理(v58)の sweeper 側の現れ。

## 7. 不変条件(実装が守るべきもの)

1. **age が確定しない object は削除しない**(LastModified parse 失敗 = listing 失敗・fail-closed)
2. **DELETE 対象は `^src/{uuidv4}/{uuidv4}/{uuidv4}\.pdf$` 一致かつ age > cutoff のみ**(二重関門・不一致は記録のみ)
3. **user の DELETE batch 直前に live-op 除外を評価**し、live または判定不能なら skip(fail-safe)
4. **overdue 評価は DELETE 実行前の snapshot に対して行う**
5. **lane は throw しない**(内部 catch → summary / 台帳。runner 外周 catch は 500)
6. **記帳 1 本ごとに個別 try/catch**(notifyOps throw の伝播で残作業を巻き込まない)
7. **CRON_SECRET が空なら必ず 401**(preview/local の '' fallback を認証成立にしない)
8. **既存 `listObjects` / `listObjectsBounded` の signature・挙動不変**(§1/§2 の regression pin 維持)

## 8. stg smoke(OT push 後・CC 実走)と sentinel 保護

**前提条件(順序の絶対則)**: §4 sentinel 判定の記録(fact-finding §3.5 台帳への判定行)が完了するまで、① sweeper の実削除 smoke を実行しない ② stg 環境に `CRON_SECRET` を設定しない(未設定 = 401 fail-closed で cron が発火しても掃かれない)。cutoff 6h は両 sentinel(A 境界 2026-08-10T11:44Z / B 境界 2026-08-11T01:09Z)を対象化するため、時刻でなく**判定完了を条件**にする。判定完了後の sentinel は保護対象外(sweeper が回収すればそれ自体が実削除の実証になる)。

手順(§4 判定完了後):

1. fixture: test1 user(`2ac594a5-…`・sentinel 所有者と別 user であることを listing で実測してから)で通常 upload flow により PDF を staging(PUT のみ・submit しない)し、key と lastModified を記録
2. cutoff 経過を待つ(override `?cutoffMinutes=15` で 15min に短縮可・§3.2)
3. `CRON_SECRET` 付き手動 GET → response summary で `deleted ≥ 1` を確認
4. listing readback: fixture 消滅・想定外 key の消滅が無いこと(実行前後の listing diff)
5. 失敗系: 誤 Bearer で 401 / 台帳に想定外の行が無いこと(`workflow='src_sweep'` で DB 照会)

切り分け(fixture が消えない場合): ① age 未達(lastModified 再確認)② live-op 除外(test1 の live op 有無を DB 照会)③ pattern 不一致(key 形式確認)④ 予算打ち切り(incomplete 行の phase)— 「実装不良」と即断しない(§2 smoke の規律踏襲)。

## 9. テスト(実装 task が TDD で書く。pin する主張)

- parse: `<Contents>` block 単位の Key+LastModified 対応付け / LastModified 欠落 page は失敗(不変条件 1)/ 既存 listObjects 系の挙動不変(既存 test green が pin)
- 選定(pure 関数に切り出す): cutoff 境界(6h ± ε)/ pattern 不一致の除外と記録 / overdue の閾値と「DELETE 前 snapshot」評価順
- live-op 除外: live user の全候補 skip / 判定クエリ失敗 → skip + phase `live_check` / **除外評価が DELETE より前であることの呼び出し順 pin**
- 予算: 時刻注入(§2 の `now: () => number` idiom)で deadline 打ち切り / phase 優先順位統合 / MAX_FAILURE_ROWS + heldFailure
- 台帳: catalog tuple 追加(14→17・ユニーク性 test の件数更新)/ 記帳個別 try/catch(notifyOps throw で後続削除が止まらない)
- auth: 空 secret → 401 / Bearer 不一致 → 401 / production env 欠落 → throw(既存 gate の挙動確認)
- override: 下限未満・非整数 → 400 / override 使用時 summary に `cutoffOverrideMinutes` が載る / **override で cutoff を縮めても overdue 閾値(72h)は不変**(OT 裁定条件の pin)
- runner: lane throw が外に漏れない(stub lane)

red 検証は gate を個別に変異させる(まとめ壊し禁止・既存 lesson)。

## 10. 論点の裁定(OT・2026-08-09・確定)

1. **smoke 用 cutoff override = 採用**(条件 2 つ付き): ① override 使用時は summary / log に実効 cutoff(`cutoffOverrideMinutes`)を必ず含める ② overdue alert(72h)は override の影響を受けないことを明記 + test で pin。下限 15min の根拠(presign 600s + PUT 60s + 余裕)は妥当、リスクは CRON_SECRET 保護下で stg のクラス (i) 相当に閉じる — 受容。→ §3.2 / §3.6 / §9 に反映済
2. **schedule = `0 18 * * *`(03:00 JST)承認**。Hobby だった場合の ±59min は §4 の式に織込み済み
3. **pattern 不一致 = 削除しない(記録のみ・lifecycle 委ね)承認**。不一致 key は「未知の将来 lane か配置ミス」でありうるため無条件削除は二重関門の意義を自壊させる。lifecycle 不全時に残り続ける帰結は overdue alert が毎日検知する = operator に判断が上がる loud な形で正しい。前者は lifecycle 不全時に不一致 object だけ残り続ける(overdue alert が検知する)

## 11. §4 判定の分岐(spec 構造はどちらでも不変)

- **lifecycle が効いている**(sentinel が境界前に消える)→ sweeper = 二次回収 + 期限超過検知。architecture.md には「lifecycle = backstop・sweeper が主たる期限保証(≈30h・worst 55h)」と書く
- **効いていない**(境界越え残存)→ sweeper = **唯一の期限保証**。architecture.md に「lifecycle rule は設定済みだが実削除の実証なし・当てにしない」と明記し、harness.md の lifecycle 行にも注記
- 判定確定後に本 spec のこの節をどちらかへ確定させる(§1/§2 の受け皿記述の参照先も同時に更新)

## 12. 変更一覧

- `lib/storage/r2.ts`: parse 拡張 + `listObjectsWithMetaBounded`(既存関数 signature 不変)
- `lib/storage/src-sweep.ts`(新設): lane 本体。選定は pure 関数で分離(domain 規則ではなく infra GC のため lib/storage 配置)
- `app/api/cron/sweep/route.ts`(新設): 汎用 runner + auth。`maxDuration = 300`(literal・drift pin は既存 upload page の手法に倣うかは plan 判断)
- `vercel.json`: crons 追加
- `lib/integration-failures.ts`: catalog +3(test 件数 14→17 更新)
- `.env.example`: `CRON_SECRET=`(参照コードと同 commit・実値は OT が Vercel に設定)
- tests: §9
- docs: `docs/architecture.md` source 行(§3 の受け皿記述を「実装済」へ・§11 分岐確定文言)/ `docs/harness.md`(cron 機構行 + lifecycle 行の注記)

## 13. 限界(受容・記録)

- **クラス (i) の識別不能**: 6h 超放置の staged upload は abandoned と区別できず掃かれる(loud fail・再 upload 可能・§3.3)。cutoff はデータ保全の閾値ではなく放置 policy
- **TOCTOU 秒窓**(§3.3): lock を作らない設計の代償。帰結はクラス (i) と同一
- **user 単位除外の粗さ**: 無関係な live op で回収が最大 1 日遅れる(無害・翌日回収)
- **listing 上限 10 page**: 10,000 key 超の大量 leak 時は複数日かかる(1 日 10,000 key ずつ・overdue alert が停滞を検知)
- **成功 run の永続記録なし**: 実行履歴は Vercel logs の保持期間に依存。scheduler の実発火検証は prod 反映後の Vercel dashboard(OT)で、close 条件外(kickoff)
- **統合への予防線**(§2 spec §7.1 と同旨): 本 sweeper と §2 退会 purge を「一貫性のため」統合してはならない。退会は即時性が要り(記録がない側)、sweeper は遅延してよい(age が受け皿)— 非対称はレーンの性質に由来する
