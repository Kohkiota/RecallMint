# ②-4b 方式調査 — source を R2 に一時保存する前提

**日付**: 2026-08-07 / **範囲**: 調査のみ(実装・方式決定・ライブラリ選定なし)
**基準 commit**: `828b853`(develop / clean)
**前提変更**: source(PDF / 画像)の R2 一時保存を**許す**前提で調べる。`architecture.md:76` の「source を R2 に置かない」は**改訂対象**。過去 doc との整合性は論じない。
**先行調査**: `docs/audit/2026-08-07-ocr-2-4b-pdf-factfinding.md`(拒否位置・page 概念の現状)

---

## 0. 先に: 現行「R2 に置かない」を機械強制している 4 点

前提が変わるので、**何を外すことになるか**を先に列挙する(改訂の作業量そのもの)。

| # | 強制点 | 位置 | 種別 |
|---|---|---|---|
| 1 | `submit-upload.ts` が `@/lib/storage/r2` を import しないことを **source 文字列 regex で pin** | `_actions/submit-upload.test.ts:448-455` | unit(fs+regex) |
| 2 | `upload-pipeline.ts` が同上 | `_lib/upload-pipeline.test.ts:893-900` | unit(fs+regex) |
| 3 | **R2 PUT の key が `users/{uid}/{uuid}.webp` のみで `/src/` を含まない**ことを iso で pin | `tests/integration/pg/upload-pipeline.test.ts:387-401` | iso(実 PG + R2 mock) |
| 4 | architecture.md の不変条件行 | `docs/architecture.md:76` | doc 台帳 |

- **1/2 は「import しない」という形の pin** ゆえ、source を R2 に置く設計では**必ず落ちる**(= 保証減の review 対象)。
- **3 は key 形の pin**。source 用 key を別 prefix に置くなら「crop key はこの形」という主張自体は維持でき、`not.toContain('/src/')` の 1 行だけが対象。
- **`architecture.md:76` に書かれている理由は「著作物の疑い(残さない方針)」**(原文)。「最小時間のみ保持 + purge」から「そもそも置かない」へ強化された経緯も同行に記録されている。→ **改訂は技術判断ではなく方針判断の巻き戻し**として記録が要る。
- eslint に upload→r2 を禁じる Block は**無い**(`eslint.config.mjs` に該当なし・実測)。`harness.md` にもこの不変条件の記載は**無い**(grep 0 件)。

---

## 1. server rasterize の実現性

### 1.1 ライブラリ候補 — 存在確認 + native 形状の実測(選定しない)

**前提となる否定的事実(再掲・実測)**: `sharp` は PDF を読めない。

```
$ node -e "console.log(require('sharp').format.pdf.input)"
{ file: false, buffer: false, stream: false }      ← libvips 8.18.3
```

npm registry 直叩き + tarball 実体検査(2026-08-07 時点):

| package | latest | license | 依存形 | 実体に含まれるバイナリ |
|---|---|---|---|---|
| `pdfjs-dist` | 6.2.108 | Apache-2.0 | `optionalDependencies: { "@napi-rs/canvas": "^1.0.0" }` | JS のみ(描画には canvas が要る) |
| `unpdf` | 1.8.0 | MIT | `peerDependencies: { "@napi-rs/canvas": "^0.1.69 \|\| ^1.0.0" }` | JS のみ |
| `pdf-to-img` | 6.2.0 | MIT | `dependencies: { "pdfjs-dist": "~5.6.205" }` | JS のみ |
| `@napi-rs/canvas` | 1.0.3 | MIT | `optionalDependencies` に **platform 別 11 パッケージ** | **native `.node`**(下記) |
| `@hyzyla/pdfium` | 2.1.13 | MIT | 依存なし | **`dist/pdfium.wasm`**(WASM) |
| `mupdf` | 1.28.0 | **AGPL-3.0-or-later** | 依存なし | **`dist/mupdf-wasm.wasm`**(WASM) |
| `pdf-lib` | 1.17.1 | MIT | — | **rasterize しない**(生成・編集用・用途違い) |

いずれも `hasInstallScript: false`(= pnpm の lifecycle script 既定 block(`onlyBuiltDependencies`)に抵触しない)。

### 1.2 NFT トレースで脱落しうるか — **sharp と同型ではない**(tarball 実測)

sharp の障害(`next.config.ts:38-62` / [[reference_sharp_nft_tracing_vercel]])の正確な形は:

```
@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.3.node      ← NFT は これ を辿れる
    └─ (C++ 層で dlopen) ─→
@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3    ← 別パッケージ。JS require で辿れず脱落
```

**2 パッケージに分かれ、`.node` が別パッケージの `.so` を dlopen する**のが本質(`node_modules/.pnpm/` で実測確認済)。

対して `@napi-rs/canvas-linux-x64-gnu@1.0.3` の tarball 実体は:

```
package/skia.linux-x64-gnu.node    ← 全 3 ファイル中の唯一のバイナリ
(sibling の .so パッケージは存在しない)
```

→ **skia が `.node` に静的リンクされた単一ファイル構成。sharp の「別パッケージの `.so` が脱落する」形は取らない。**

**ただし残るリスクは 2 つ(いずれも未検証)**:

- `.node` 本体は platform 別 optionalDependency 経由で解決されるため、**NFT が `.node` 自体を辿れるか**は sharp と同じ問題領域(sharp では `.node` は辿れていた)。pnpm の `.pnpm/` 実体配置も同じ。
- **`.node` が system lib(fontconfig / freetype 等)を dlopen するか**は**確認できていない** — `ldd` の実行が環境で拒否されたため未測定。**推測しない**。
- WASM 系(`mupdf` / `@hyzyla/pdfium`)は native binary を持たないので上記は無関係だが、**`.wasm` ファイルを実行時 `fs.readFile` で読む形なら NFT が拾わない**という別クラスの脱落がありうる(未検証)。

**共通の教訓(記録済)**: この種の脱落は **local で再現せず stg smoke で初めて出る**。診断法 = build 後の `.nft.json` にバイナリが含まれるかの grep。

### 1.3 rasterize が入る位置(1 invocation 経路の現物)

```
[client] handleAdd → processImage(browser-image-compression / webp 固定)
   ↓ FormData('files', File × N)
[action] submitUpload                                 _actions/submit-upload.ts
   1. validateSubmitInput                             :100-168
        件数 ≤40 :135 / per-file ≤5MiB :144 / 合計 ≤4MB :147
        ★ sniffMagicBytes(PNG/JPEG/WebP のみ)        :158-163
   2. submitUploadTx(sync tx)                        :173-360
        advisory lock → 冪等 replay → live-op gate → 日次 cap
        source_documents INSERT(pagesTotal = files.length)  :323
        upload_operations INSERT(expectedSourceCount = files.length、lease 発行) :341-342
   3. 応答 'accepted'(ここで client は解放される)
   4. after(() => runUploadPipeline(...))             :465-482
[after()] runUploadPipeline                           _lib/upload-pipeline.ts:133
        runOcrPhase                                   :183
          a. 開始 CAS                                 :203
          b. ★ decode 検証 + source_id 採番(逐次)    :215-258
          c. 残余予算チェック(< GEMINI_TIMEOUT_MS で terminal) :270
          d. Gemini 1 call                            :276-295
          e. normalize → prepared_payload commit(CAS) :307-331
          f. runCropPhase(逐次 sharp crop → R2 PUT)   :334
          g. runPublishPhase(1 tx)                    :345
```

**rasterize を置ける位置は 3 つ**(R2 一時保存を許すと 3 つ目が新たに成立する):

| 位置 | 何が起きるか |
|---|---|
| **P1: `validateSubmitInput` 内(sync tx の前)** | ページ数が sync tx の前に確定 → manifest 問題が発生しない。代償 = rasterize 時間が **action の応答待ち**に丸ごと乗る(現行は「sync tx 直後に応答」設計・spec §5) |
| **P2: `runOcrPhase` の decode ループ内(after() 側)** | 応答は即返る。代償 = ページ数が sync tx **後**に判明 → §1.4 の manifest 衝突が起きる |
| **P3(R2 前提で新たに可能): 受領 → R2 PUT → 応答 → after() で R2 GET して rasterize** | source が R2 にある = **invocation をまたげる**。rasterize を別 invocation / 別 phase に切り出せる。代償 = R2 の往復 I/O + 削除責務(§2) |

**時間予算の現物**(前回調査から不変):

| 値 | 位置 |
|---|---|
| `maxDuration = 720`(秒) | `app/(app)/app/upload/page.tsx:23`(pin test あり) |
| `UPLOAD_PIPELINE_BUDGET_MS = 660_000`(起点 = **action 入口**) | `_lib/constants.ts:57` |
| `LEASE_TTL_MS = 900_000`(15 分) | `_lib/constants.ts:37` |
| `GEMINI_TIMEOUT_MS` 220s / retry 3 attempts で最悪 685〜780s | `_lib/constants.ts:44-53` の算術 |
| `CROP_MIN_REMAINING_MS` 5s | `_lib/constants.ts:140` |

- **`constants.ts:56` と `:70` が「暫定値 — cutover 後の実測で見直す」と自己申告**。唯一の実測は**画像 5 枚 ~1-2 分**(`sessions/2026-08-02-ocr-2-4a-cutover-smoke.md:161`)。**40 枚スケールの実測は無い** → rasterize に割ける残余を現物から出すことは今もできない。
- **メモリ 2GB は spec に根拠付きで記録済**(`specs/2026-08-04-...:132`・Vercel 公式 doc 引用 / Pro 既定)。`vercel.json` に `memory` 指定は**無い**(upload 経路の `functions` 指定自体が無く、webhook 2 本 60s のみ)。**vCPU 数の記録は repo に無い**。
- 現行 peak 見積り: 原本 ≤4MB + base64 ≈5.5MB + 応答数 MB + **decode 1 枚ずつ逐次**(2048px で ≈16.8MB / guard 上限 40MP で ≈160MB)= **数十〜200MB**。
- **「decode 逐次」は unit test が「peak 同時 decode = 1」として機械強制**(`upload-pipeline.ts:221-223`)。→ rasterize にも同じ逐次制約を課すかが同型の判断点。

### 1.4 immutable manifest との衝突 — 実際の結合は 1 本だけ

**書き手**

| 列 | 書く場所 | 値 |
|---|---|---|
| `upload_operations.expected_source_count`(NOT NULL) | `submit-upload.ts:341` | `files.length`(sync tx・1 回だけ) |
| `source_documents.pages_total`(nullable) | `submit-upload.ts:323` | `files.length`(sync tx) |

**読み手(全 grep・production 経路)**

| 列 | 読む場所 | 用途 |
|---|---|---|
| `expected_source_count` | `publish-prepared.ts:92,102` → `:135` / `:234` | `source_documents.pages_processed` と `upload_records.pages_processed` に**そのまま書く**(= 月次 quota の集計元) |
| `pages_total` | **production 読者ゼロ** | 書きっぱなし。読むのは iso test 2 本(`submit-upload.test.ts:220` / `upload-pipeline.test.ts:236`)のみ |

→ **manifest の実効的な結合は「`expected_source_count` → `pages_processed`(課金ページ数)」1 本だけ。** `pages_total` は write-only。

**「immutable」の強制状況**

- schema コメント(`schema.ts:931-933`)が「operation 作成時に確定する immutable な受領枚数 manifest」「publish 時の記帳はこの列を**独立 oracle** として使う」と述べる。
- **しかし UPDATE を禁じる機構は存在しない**: DB CHECK なし / trigger なし / lint なし。iso test は**値の assert**(`submit-upload.test.ts:243` `toBe(2)`)であって**不変性の pin ではない**(全 grep 済)。
- さらに **spec 自身が「oracle としての役割は消え、`files.length` の bookkeeping に降格」と明記**(`specs/2026-08-04-...:182` / §4.1 表の `expected_source_count` 行)。理由 =「1 invocation では検査対象が同じメモリ上の配列になる」。
- 同 spec §4.2 は **manifest 検証を「概念ごと廃止」**と宣言済(3 サイトすべて撤去済)。

→ **現物としては「immutable」は doc の主張であって機械強制ではない。** 確定タイミングの分離は、技術的には次の 3 形のいずれも取りうる(**どれを採るかは決めない**):

| 形 | 内容 | 触る範囲 |
|---|---|---|
| **(a) 事前確定** | rasterize を sync tx の前(P1)に置き、`files.length` を rasterize 後の枚数にする | 既存不変条件に触れない。応答待ちが伸びる |
| **(b) 二段確定** | sync tx では PDF ファイル数で INSERT し、rasterize 後に `expected_source_count` を UPDATE | 「immutable」の doc 主張の改訂 + fenced CAS 内で更新する設計が要る |
| **(c) 役割分離** | `expected_source_count` は受領ファイル数のまま据え置き、課金ページ数を**別の値**として publish に渡す | `publish-prepared.ts:135,234` の 2 箇所が引数化される(§4.1 で `fileSizeBytes` が既に同じ形で引数化済 = 前例あり) |

**R2 一時保存が確定タイミング分離を助けるか** → **助ける。** source が R2 にあれば rasterize を「応答後・別 phase」に置けるため P1 の応答遅延を避けつつ、(b)/(c) のどちらでも実装可能になる。**逆に言うと R2 保存が無いと (a) 以外は「バイトが request 限り」ゆえ選択肢が狭い**。

---

## 2. R2 一時保存の設計材料

### 2.1 現行 R2 書込点と、source 用の自然な追加位置

- **書込は 1 箇所のみ**: `lib/media/crop-and-store.ts:307` `putObject(objectKey, cropBytes, 'image/webp', { ifNoneMatch: true })`、key = `users/${userId}/${figureAssetId}.webp`(`:305`)。
- `putObject` は **never-throw**(`'success' | 'precondition_failed' | 'error'` を返す)・`Content-Length` 明示必須([[reference_r2_putobject_content_length_411]])・`ifNoneMatch` で first-writer-wins(`lib/storage/r2.ts:199-235`)。
- **source 書込の自然な位置は 2 つ**:
  - **W1: `submit-upload.ts` の sync tx 前後**(受領直後)。→ pin 1(`submit-upload.test.ts:448`)が落ちる。client のバイトを server 経由で PUT する形。
  - **W2: 別 module を新設して `upload-pipeline.ts` から呼ぶ**。→ pin 2(`upload-pipeline.test.ts:893`)が落ちる。
  - 参考: **旧経路は client presigned PUT だった**(`presignPutUrl` は今も `lib/storage/r2.ts:90` に現存・未使用)。temp key へ client 直 PUT → server が GET して検証 → 最終 key へ server PUT、という 2 段 promote 構成(`docs/audit/2026-08-04-why-source-goes-through-r2.md` §1)。**その実装 file は `80ef3b4` で削除済**(`source-asset-actions.ts` / `prepare-upload.ts` / `source-purge.ts` 他 9 本)= **git から参照可能**。

### 2.2 `source_assets` 相当の行を復活させる必要があるか

**必要になる値と、既存表で持てるか**:

| 値 | 既存表で持てるか |
|---|---|
| `object_key`(source ごと) | **持てない**。`upload_operations` は operation 1 行、`asset_derivations` は PK=`asset_id`(crop 結果)で 1:1、`assets` は「表示用 R2 バイトの台帳」(`schema.ts:809-820`)で `object_key` UNIQUE を持つが status/reference_count の意味が表示 asset 前提 |
| source ごとの `mime`/`byte_size`/`width`/`height` | 同上。**1 operation に N source ある**構造を持てる表が現存しない |
| `source_id`(figure→source 解決キー) | 現在は **DB に永続化されていない**(`upload-pipeline.ts:235` で `randomUUID()`、`prepared_payload` jsonb 内にのみ存在し publish で NULL 化) |

→ **「1 operation : N source」の行を持つ表は現存しない。** 選択肢は事実として 3 つ(**決めない**):

1. **`source_assets` 相当を復活**(0032 で drop した形 = `git show 80ef3b4^:lib/db/schema.ts` に全 17 列が残っている)。RLS policy + grant + drift test + iso fixture + completeness カタログ(`verify-rls-state.test.ts`)の再整備が伴う(0032 の逆操作として何が要るかは `specs/2026-08-04-...:168` の撤去リスト 8 項が裏返しの作業一覧になる)。
2. **`upload_operations.prepared_payload` と同型の jsonb 列**に source manifest を持つ(表を増やさない。ただし **publish 時 NULL 化の規律**(`specs/2026-08-04-...:120`)と削除の必要期間が衝突しうる)。
3. **key を DB に持たず、R2 の listing と key 規約だけで辿る**(`gc-src-prefix.ts` が既にこの形 — 「台帳が消えたあとは R2 側の listing だけが残骸の唯一の所在」`:6-8`)。

### 2.3 削除経路 — 既存 GC / reconciler は source prefix を対象にできるか

**現状(0032 後)**

- **source lane は撤去済**: `scripts/gc-image-assets.ts` に `source` / `src/` の出現は **0 件**(grep 実測)。`lib/media/source-purge.ts` は `80ef3b4` で **削除**。
- `integration_failures` の catalog も縮小済: 現存は **`r2_gc_delete` のみ**(`lib/integration-failures.ts:72`)。**`r2_gc_delete_source` は消えている**(旧 catalog にはあった・`2026-08-04-r2-contract-measurement-and-key-inventory.md:134-135`)。
- 残っているのは **`scripts/gc-src-prefix.ts`**(one-shot・R2 listing 駆動・DB を一切見ない)。既定 dry-run、`--execute` で削除、`--user <uuid>` で scope 限定。**旧 key 形 `users/{uid}/src/` に固定した regex `SRC_KEY_PATTERN`(`:47`)を持つ** → 新 key 形を採るならここが直接効く。

**`listObjects(prefix)` の拡張可能性**(`lib/storage/r2.ts:308-358`)

- 全ページ走査(`IsTruncated` / `NextContinuationToken` 追随)・`MAX_LIST_PAGES` 超過で throw・token 非進行で throw。
- **既存 5 関数の never-throw 契約を意図的に継承しない**(`:300-307`): 失敗を空配列に正規化すると「0 件 = 削除完了」に見えて事後検証が無意味になるため。
- 応答構造検証あり(`parseListObjectsPage:273-290`): root 要素の開閉 + `IsTruncated` の true/false を必須にし、壊れた 2xx を空ページ扱いしない。
- → **prefix を変えるだけで再利用可能。汎用形として既に成立している**(引数は `prefix: string` のみ)。時刻フィルタ(`LastModified` による経過時間判定)は現在**実装されていない** — `<Key>` しか抽出していない(`:338-339`)。**保存期間ベースの sweep を script 側で書くなら `LastModified` の抽出追加が要る**(応答には含まれている・実測記録 `2026-08-04-r2-...:97` に `2026-08-04T08:12:28.130Z` のミリ秒付き ISO8601)。

**削除 API の実測済み挙動**(`docs/audit/2026-08-04-r2-contract-measurement-and-key-inventory.md`)

- `deleteObject` は単体 DELETE・never-throw・**404 を `ok:true`** として扱う(`r2.ts:374-389`)。
- **`DeleteObjects`(bulk)は実測済**: 不在 key も 200 + `<Deleted>` に入る(冪等)/ **1001 件で request 全体が 400**(1000 件 chunk 必須)/ 空リストも 400 / **per-key `<Error>` は 1 度も観測できず構造不明**。
- `@aws-sdk/client-s3` は**未導入**(`aws4fetch@1.0.20` のみ)ゆえ SDK 型ベースの実装は新規 dep 判断になる。

### 2.4 lifecycle rule と key 設計 — **現行 key 形では単一 rule にならない**

- 実測記録(`2026-08-04-r2-...:167`): 「lifecycle rule の前方一致仕様(**`users/{uid}/src/` は表現可能だが user ごとに rule が要り、rule 数上限は未調査 = 不明**。今回の実測対象外)」。
- 同 doc `:117` が構造を明示: **`users/` + user_id が第 2 セグメント**、`src/` は第 3。**`users/*/src/` のような wildcard は ListObjectsV2 も lifecycle も持たない**(`gc-src-prefix.ts:63-65` が同じ理由で `users/` 全体を listing して per-key regex で絞っている)。
- → **単一 lifecycle rule で source だけを期限削除したいなら、source を top-level 専用 prefix に置く key 設計が要る**(例: `src/users/{uid}/…` の順で user_id を後段に回す形)。これは**現行の全 key 形(4 種すべて `users/` 始まり・同 doc `:109-114`)と異なる新設計**になる。
- **未確認**: R2 の lifecycle rule 数上限 / rule あたり prefix 数 / 最小保持期間の粒度(日単位か否か)。**実測されていない = 不明**。推測しない。
- 補足: **exam 単位で絞ることは key からは不可**(key に exam_id が現れない・同 doc `:118`)。**user 単位は可**(退会後も `users.id` 行は残る = soft-delete ゆえ DB から駆動できる・同 doc `:146,158`)。

---

## 3. page 概念の再構築

### 3.1 消えたもの(再掲・確定)

`migration 0032`(不可逆・stg 適用済)で `source_assets` 表ごと DROP。その中に **②-4b 予約列 `source_kind` / `page_count` / `rotation` / `rasterizer`** が実在した(`git show 80ef3b4^:lib/db/schema.ts` で全列確認済)。`asset_derivations.source_asset_id` も同 migration で DROP → **crop 結果から「どの source 由来か」を辿る DB 経路は現在ゼロ**。

### 3.2 Gemini 応答 schema の `page?: number` は「受け取って捨てている」(現物)

**3 段のうち 2 段目で落ちている**ことを実測で確認:

| 段 | 現物 | 状態 |
|---|---|---|
| ① 本番 OCR 応答 schema | `lib/ai/schemas/ocr-image-crop-response.ts:33-34`(TS 型 `page?: number` + コメント「②-4b (PDF ページ) 予約」)/ `:82`(**JSON schema にも `page: { type: 'number' }` が実在** = モデルに返させる口は開いている) | **生きている** |
| ② normalize の raw 検証 | `lib/ocr/normalize-prepared.ts:102` `page: z.number().optional()` — **parse は通る** | **通る** |
| ②' normalize の転記 | `normalize-prepared.ts:207` `const { source_id, box_2d, target, label } = parsed.data` — **`page` を分解していない**。`:240-247` の `figures.push({...})` にも無い | **ここで無言に捨てられる** |
| ③ prepared_payload | `lib/ocr/prepared-schema.ts:60-72` `preparedFigureSchema` に **`page` フィールド無し** | **存在しない** |
| ④ 永続化 | `asset_derivations`(`schema.ts:964-979`)に page 列なし。`prepared_payload` は publish で NULL 化 | **存在しない** |

→ **モデルが `page` を返しても ②' で silent に消える。** 通すには `preparedFigureSchema` への追加が要り、そこは `preparedPayloadV1Schema` の「V1 を書き換えず V2 を追加する」運用ルール(`prepared-schema.ts:182-189`)の対象。

### 3.3 PDF 由来 + ページ番号を持たせる場所の候補(**事実の列挙のみ**)

| 候補 | 現状 | 備考 |
|---|---|---|
| `source_assets` 復活(`source_kind` / `page_count` / `rasterizer` 込み) | 表ごと不在 | 0032 で drop した形がそのまま git にある |
| `asset_derivations` に page 列追加 | 表は現存(PK = `asset_id`) | **spec §4.1 が「page 概念は prepared_payload / `asset_derivations` 側(figure の page 属性)で表現できる」と述べている**が、**列は存在しない = 未実装の設計方針** |
| `prepared_payload.figures[].page` | schema に無い(§3.2) | publish で NULL 化されるため**永続記録にはならない** |
| `source_documents.file_type` | 列は `'pdf' \| 'image' \| 'csv' \| 'markdown'` を持つ | §3.4 参照 |
| 新規表(source 1 行 = 1 ページ) | 無し | §2.2 の「1 operation : N source」問題と同一 |

**方式依存の注意(事実)**: client rasterize なら **モデルは「PDF の 5 ページ目」でなく「5 枚目の画像」しか見ない** → ①の `page` は使われず、page 番号は client が持つ情報として別途運ぶことになる。server rasterize + PDF 直渡しなら ① が生きる。**どちらを採るかで ① の予約が生きるか死ぬかが変わる。**

### 3.4 `fileType` が常に `'image'` ハードコードされている箇所

- **書き手は 1 箇所**: `_actions/submit-upload.ts:319` `fileType: 'image'`(リテラル)。
- 列の型は `'pdf' | 'image' | 'csv' | 'markdown'`(`schema.ts:395-397`・NOT NULL)。
- legacy `_actions/process.ts:197-198` は `firstFile.type === 'application/pdf' ? 'pdf' : 'image'` で**実際に判定していた**(この file は `'use server'` のまま現存・呼ぶ client なし)。
- **読み手**: 全 grep で production の分岐利用は見つからず(表示・集計で `file_type` を読む経路なし)。→ **現状は write-only に近い。** PDF 対応で `'pdf'` を書くようにしても、**それを読む消費者は新設が要る**。
- 併せて `source_documents.filename`(`submit-upload.ts:309-312`)は「先頭 file 名 + ほか N 件」を合成し、`publish-prepared.ts:144,232` で `upload_records` に転記される。**client rasterize だと元 PDF 名が消える**(前回調査 §2-B2)。

---

## 4. client rasterize の可否(比較材料)

### 4.1 repo 側の受け入れ可否 — 技術的な障壁は現物に無い

- **client 側で既に canvas 画像処理を常時行っている**: `upload-form.tsx:209` `imageCompression(file, { maxSizeMB:0.5, maxWidthOrHeight:2048, useWebWorker:true, fileType:'image/webp' })`。Web Worker も既に使用。
- **挿入点は 1 箇所**: `handleAdd` の PDF 分岐(`upload-form.tsx:330-338`)。現在は `processPdf`(ページ数を数えるだけ)を呼んでいる。展開後は既存 `processImage` に流せば webp に揃う。
- bundle size gate / budget は **repo に存在しない**(next.config / eslint / CI いずれにも無し)。→ pdf.js のサイズを機械的に弾く仕組みは無い。
- 新規 dep 追加は CLAUDE.md「新ライブラリ導入は事前相談」の対象(client でも同じ)。

### 4.2 **端末制約を理由に client 方式を却下した記録は repo に無い**

`docs/` 全体を `client.*rasteriz` / `rasteriz.*client` / `pdf.js` / `pdfjs` / 「端末」で grep した結果、**PDF の client rasterize を検討・却下した記録は 1 件も存在しない**。②-4a 系の doc は一貫して「PDF rasterize は ②-4b」とだけ書き、方式の比較検討自体を行っていない。

**あるはずだと仮定して探すのはここまで。無い。**

### 4.3 ただし「client 側 canvas 画像処理が実機で壊れた」記録は**別件として実在する**(却下記録ではない)

却下記録ではないが、**同じ技術基盤(canvas)の実機制約として repo に記録がある**ので事実として挙げる:

- `docs/superpowers/specs/2026-07-13-ios-webkit-compression-fix-design.md` — **iPad(iOS/WebKit)で画像添付が破損**(R2 に ≈856B の壊れた webp が着地)。確定原因:
  - `browser-image-compression` が canvas 上限を**面積近似**(`w*h ≤ 4096²`)し **per-dimension を見ない** → 長い/大きい画像が iOS canvas 上限に抵触
  - lib が `maxWidthOrHeight` 適用**前**に元画像サイズの巨大 canvas を作る → 縮小前に空/部分描画
  - iPad が desktop Safari 扱いになる UA 判定の穴
  - 出力の pixel/decode/format 検証が皆無
- 対処 = **WebKit 判定時のみ自前 pipeline**(`lib/media/compress-image-safe.ts` / `lib/media/webkit-detect.ts`)+ 出力妥当性検証 + fallback。
- **重要な現状の非対称(実測)**: この WebKit-safe pipeline を使うのは **`compressForAttach`(`lib/media/upload.ts:302-313`)= card への画像添付経路のみ**。**OCR upload 経路(`upload-form.tsx:209`)は `browser-image-compression` を直接呼んでおり、WebKit 分岐を通っていない。**
- → PDF の client rasterize は pdf.js が canvas に描画する形になるため、**この iOS canvas 制約と同じ領域に入る**。ただし **PDF について実測した記録は無い = 不明**。

---

## 5. 未確認 / 不明(推測しない)

| 項目 | 状態 |
|---|---|
| PDF→画像変換の実コスト(時間 / メモリ / 出力サイズ) | repo に実測・見積り**一切なし** |
| 40 枚スケールの pipeline 実測 | **無し**(5 枚 1 点のみ)。時間予算の値は自己申告で「暫定」 |
| Vercel の vCPU 数 | repo に記録**なし**(2GB は spec に根拠付きで記録あり) |
| `@napi-rs/canvas` の `.node` が system lib を dlopen するか | **未測定**(`ldd` 実行が拒否された) |
| WASM 系(`mupdf` / `@hyzyla/pdfium`)の `.wasm` が NFT に拾われるか | **未検証** |
| R2 lifecycle rule の数上限 / prefix 数上限 / 最小保持粒度 | **未実測**(前回 R2 実測の対象外) |
| `DeleteObjects` の per-key `<Error>` 構造 | **観測できず不明**(stg で失敗要因を作れない) |
| PDF 入力時の box_2d 座標系がページ画像入力と一致するか | **未検証**(probe script 2 本 + サンプル PDF は現存・実 API は OT 合図) |
| PDF を client rasterize した場合の iOS 実機挙動 | **未検証** |
