# ②-4b 実現性確認 — PDF→画像ライブラリの Vercel 適合性と変換コスト実測

**日付**: 2026-08-07 / **範囲**: 実測のみ(実装なし・選定なし・spec なし)
**基準 commit**: `32f98c5`(実測後に repo は clean へ復帰・§0.2 で検証)
**測定環境**: devcontainer / Node v24.13.0 / linux x64 / pnpm 10.33.0 / Next 16.2.11(Turbopack)

---

## 0. 結論と、その根拠の種別

### 0.1 結論

| 候補 | devcontainer 実行 | **`next build`** | **NFT トレース** | 総合 |
|---|---|---|---|---|
| `mupdf` 1.28.0(WASM) | **OK** | **OK** | **拾われた**(自動・追加設定なし) | **通過** |
| `@hyzyla/pdfium` 2.1.13(WASM) | **OK** | **OK** | **拾われた**(自動・追加設定なし) | **通過** |
| `pdfjs-dist` 6.2.108 + `@napi-rs/canvas` 1.0.3(native) | **OK** | **落ちた** | 到達せず | **落ちた** |

- **`@napi-rs/canvas` は build 段階で落ちる**(NFT 以前の問題)。**代替設定は試していない**(指示どおり止めた・§1.3)。
- **WASM 2 本は sharp libvips と同型のリスクを持たない**。理由は「運が良かった」ではなく**構造が違う**ため(§1.5)。

### 0.2 「local で動いた」を根拠にしていない箇所の明示

| 主張 | 根拠 | 種別 |
|---|---|---|
| ライブラリが PDF を画像化できる | devcontainer 実行 | **local 実測**(これは「動くか」の必要条件でしかなく、Vercel 適合の根拠にしていない) |
| **Vercel の function に `.wasm` が同梱される** | **`next build` が生成した `route.js.nft.json` に当該 `.wasm` が列挙されている** | **build 生成物**。NFT manifest は **Vercel が function を組み立てる際に読む当のファイル**であり、「local で動いた」とは別種の根拠 |
| 実行時に node_modules でなく同梱物を見る | build 済 chunk が `/server/assets/<hash>.wasm` を参照(node_modules パスではない) | build 生成物 |
| 変換の所要時間・メモリ | devcontainer 実測 | **local 実測**。**Vercel の 1 vCPU 環境での値ではない**(§2.4) |

**未実施 = 未証明**: Vercel への実 deploy はしていない。上記は「build 生成物が正しい形になっている」ことの証明であって、**実 deploy での動作確認ではない**。

### 0.3 repo への影響(復帰確認済)

実測のため一時的に repo へ dep 4 本と probe route 3 本を追加し、**すべて撤去した**:

```
$ git status --short          # (出力なし = clean)
$ HEAD                        # 32f98c5
pdf deps present?  NO (clean)
sharp still loads: true       # pnpm install --frozen-lockfile で node_modules 復元済
```

---

## 1. PDF→画像ライブラリが Vercel で動くか

### 1.1 機能確認(devcontainer・隔離 project)

repo を汚さないため scratchpad の独立 project(`pdflab`)で install・実行。sample = `scripts/ai/ocr-samples/mock-exam-set.pdf`(5 ページ・A4 = 595×842pt)。

| lib | pageCount 取得 | 1 ページ画像化 | 出力 |
|---|---|---|---|
| `mupdf` | 5 | OK | 1448×2048 PNG / 190,613 B |
| `@hyzyla/pdfium` | 5 | OK(raw BGRA → sharp で encode) | 1447×2047 PNG / 189,449 B |
| `pdfjs-dist` + `@napi-rs/canvas` | 5 | OK | 1447×2048 PNG / 253,841 B |

- `@hyzyla/pdfium` は**自前で画像 encode をしない** — `render({ render })` に encoder を渡す設計。今回は既存 dep の `sharp` を使った(= **新規の encoder dep は不要**)。
- API の細部でつまずいた点(記録): pdfium は `doc.pages()` が Generator ゆえ `.length` を持たず `getPageCount()` / `getPage(i)` を使う。ページ寸法は `getSize()` が private で `getOriginalSize()` が公開 API。

### 1.2 `next build`(Turbopack)の結果 — ここで 1 本落ちる

repo に dep を一時追加し、各ライブラリを import する API route を作って `pnpm build` を実走。

**副次的な発見(手順上の罠)**: `app/api/__pdfprobe_*/` に置いた最初の probe は **route として登録されなかった**。Next は `_` 始まりのディレクトリを private folder として routing から除外するため。`pdfprobe-*` に改名して再実行。**probe route を作るときは `_` 始まりにしない。**

**`@napi-rs/canvas` を含む build = 失敗**:

```
> Build error occurred
Error: Turbopack build failed with 1 errors:
./node_modules/.pnpm/@napi-rs+canvas@1.0.3/node_modules/@napi-rs/canvas/js-binding.js
non-ecmascript placeable asset
asset is not placeable in ESM chunks, so it doesn't have a module id

Import trace:
  App Route:
    ./node_modules/.pnpm/@napi-rs+canvas@1.0.3/node_modules/@napi-rs/canvas/js-binding.js
    ./node_modules/.pnpm/@napi-rs+canvas@1.0.3/node_modules/@napi-rs/canvas/index.js
    ./app/api/pdfprobe-pdfjs/route.ts
```

= **native `.node` を Turbopack が ESM chunk に配置できず build 自体が止まる**。NFT トレース以前の失敗。

**該当 route を外すと build は成功**し、残り 2 route が登録される:

```
├ ƒ /api/pdfprobe-mupdf
├ ƒ /api/pdfprobe-pdfium
```

### 1.3 `@napi-rs/canvas` について代替設定は試していない

`serverExternalPackages` 等の設定で通る可能性は**ある**が、**指示(「落ちた場合は落ちたと報告して止まる」)に従って試していない**。→ **「現行 repo 構成のまま素で入れると build が落ちる」までが実測結果**。それ以上は未評価。

### 1.4 NFT トレース(本題)— WASM 2 本とも自動で拾われた

build 後の `route.js.nft.json` を検査:

```
=== .next/server/app/api/pdfprobe-mupdf/route.js.nft.json ===
  total traced files: 115
  binary-ish traced:
    ".../@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3"     ← 既存 next.config の強制包含
    ".../@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.3.node"        ← 同上
    "../../../assets/mupdf-wasm.17jfh84vipj2x.wasm"                   ← ★ 自動で拾われた

=== .next/server/app/api/pdfprobe-pdfium/route.js.nft.json ===
  total traced files: 114
  binary-ish traced:
    (sharp 2 件・同上)
    "../../../assets/pdfium.3qyx77o4srpxd.wasm"                       ← ★ 自動で拾われた
```

実体も出力されている:

```
$ ls -la .next/server/assets/
-rw-rw-r--  10408550  mupdf-wasm.17jfh84vipj2x.wasm     (10.4 MB)
-rwxr-xr-x   3988829  pdfium.3qyx77o4srpxd.wasm          (4.0 MB)
```

実行時の参照先も node_modules ではなく同梱 asset:

```
$ grep -o "...mupdf-wasm.17jfh84vipj2x.wasm..." .next/server/chunks/*.js
.next/server/chunks/_0sxnxg_._.js:/server/assets/mupdf-wasm.17jfh84vipj2x.wasm
.next/server/chunks/node_modules__pnpm_05_ucat._.js:/server/assets/pdfium.3qyx77o4srpxd.wasm
```

→ **Turbopack が `.wasm` をビルド資産として出力し、参照を書き換え、NFT がそれを追跡している。3 者が揃っている。**

### 1.5 sharp libvips と同型か → **同型ではない(構造が違う)**

同じ nft.json に **sharp の `.so` も出ているが、それは `next.config.ts:50-55` の `outputFileTracingIncludes` が手で押し込んでいる**からで、自動では拾われない。両者の違い:

```
【sharp(脱落した形)】
  @img/sharp-linux-x64/lib/sharp-linux-x64-0.35.3.node       ← NFT は辿れる
      └─ C++ 層で dlopen ─→
  @img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3     ← 別 package。JS の import グラフに現れず脱落
                                                               → outputFileTracingIncludes で手動包含が必要

【mupdf / pdfium(脱落しない形)】
  route.ts → import 'mupdf' → (Turbopack が .wasm をビルド資産として emit)
      └─ 参照は /server/assets/<hash>.wasm に書き換わる
      └─ NFT はその emit 済み asset を追跡する                 ← 追加設定 不要
```

**要点**: sharp の問題は「**JS から辿れない dlopen**」であり、`.so` がどこにあるかではない。WASM 2 本は dlopen を使わず、バイナリが **bundler の管理下の asset** になるため、その失敗経路が原理的に存在しない。

**残余リスク(未検証・隠さず記載)**:
- 実 Vercel build 環境での再現は**未確認**(local build 生成物の検査まで)。
- **実行時に WASM が Vercel の Node runtime で init できるかは未検証**(probe route を deploy して叩いていない)。
- `.wasm` 10.4 MB(mupdf)/ 4.0 MB(pdfium)は function bundle size に加算される。**Vercel の bundle size 上限に対する余裕は未確認**。

---

## 2. 変換コストの実測

### 2.1 解像度の定義(値のない計測をしないため明記)

**「長辺 = N px」を目標に、ページごとに scale を導出**(`scale = N / max(pt幅, pt高)`)。A4(595×842pt)の場合:

| 目標長辺 | 実出力(A4) | 実効 DPI |
|---|---|---|
| 1024 px | 724×1024 | ≈ 88 dpi |
| 1536 px | 1086×1536 | ≈ 131 dpi |
| **2048 px** | **1448×2048** | **≈ 175 dpi** |
| 2560 px | 1810×2560 | ≈ 219 dpi |

**2048 を主計測値に採った理由** = 現行 client 圧縮の上限 `MAX_IMAGE_WIDTH_OR_HEIGHT = 2048`(`_lib/constants.ts:13`)と揃えるため。

計測は **rasterize + webp encode(quality 80)まで**を 1 ページのコストとする(Gemini に送れる形にするまでが実コストのため)。**逐次処理**(現行 pipeline の「decode 同時実行 = 1」制約と同じ形)。

### 2.2 40 ページ相当

**サンプルの制約(先に明記)**: repo に **40 ページの PDF は存在しない**。現存は `mock-exam-set.pdf`(5p)と `8p_textonly.pdf`(8p)の 2 本のみ。ゆえに **同一文書を反復して「40 ページ分の render」を実行**した(5p×8 / 8p×5)。逐次処理なのでピークメモリは 1 ページ分で決まり、この形で代替できる。**ただし「単一の 40 ページ文書を開いたときの文書オブジェクト自体のメモリ」は測れていない。**

**目標長辺 2048 px / 40 page-renders:**

| lib | PDF | 合計時間 | ms/page | うち render | うち webp encode | ピーク RSS | webp KB/page | webp 合計 |
|---|---|---|---|---|---|---|---|---|
| mupdf | mock(5p×8) | **7,371 ms** | 184.3 | 14.8 | 167.8 | **275.8 MB** | 74.4 | **3.05 MB** |
| mupdf | 8p(8p×5) | **7,169 ms** | 179.2 | 7.9 | 169.9 | **263.6 MB** | 95.0 | **3.89 MB** |
| pdfium | mock(5p×8) | **7,799 ms** | 195.0 | 22.4 | 169.5 | **307.2 MB** | 73.2 | **3.00 MB** |
| pdfium | 8p(8p×5) | **7,694 ms** | 192.4 | 13.1 | 175.8 | **302.1 MB** | 94.5 | **3.87 MB** |

**支配項は rasterize ではなく webp encode(全体の約 90%)**。rasterize 自体は 8〜22 ms/page。encode は `sharp` = 既存 dep。

### 2.3 解像度感度(mupdf / mock / 40 renders)

| 目標長辺 | 合計時間 | ms/page | ピーク RSS | webp KB/page | **webp 合計** |
|---|---|---|---|---|---|
| 1024 | 2,281 ms | 57.0 | 202.5 MB | 25.9 | **1.06 MB** |
| 1536 | 4,395 ms | 109.9 | 235.5 MB | 49.0 | **2.01 MB** |
| **2048** | **7,190 ms** | **179.8** | **266.1 MB** | **74.4** | **3.05 MB** |
| 2560 | 11,329 ms | 283.2 | 376.2 MB | 100.6 | **4.12 MB** |

時間はおおむね画素数に比例(長辺 2 倍で ≈4 倍)。

### 2.4 現行予算に対する余裕

| 制約 | 現行値 | 40 ページ rasterize の実測 | 余裕 |
|---|---|---|---|
| `UPLOAD_PIPELINE_BUDGET_MS` | 660,000 ms | **≈ 7,400 ms**(@2048) | **約 1.1%**。@2560 でも 11.3s = 1.7% |
| `maxDuration` | 720 s | 同上 | 同上 |
| メモリ | 2 GB(spec §4.7・Vercel Pro 既定) | ピーク **264〜307 MB**(@2048) | 大きい。既存 pipeline 見積り(数十〜200 MB)と足しても余裕 |
| **合計 upload サイズ** | **4 MB**(`TOTAL_UPLOAD_LIMIT_BYTES`) | **3.0〜3.9 MB**(@2048・40 ページ) | **ほぼ無い ← 実効的な律速はここ** |

**最も重要な観測**: **時間もメモリも問題にならない。効いてくるのは合計 4MB の入稿上限のほうで、40 ページ @2048px は既に上限ぎりぎり**(@2560 では 4.12 MB で超過)。この 4MB は現在 client 側の cap だが、Gemini に inline base64 で送るサイズにも直結する(base64 で ≈1.33 倍)。

**この数値を Vercel の値として使ってはいけない理由**: 測定機は devcontainer(WSL2)であり、**Vercel の 1 vCPU 環境ではない**。支配項が sharp の webp encode である以上、**CPU 性能差がほぼそのまま倍率として効く**。上の「1.1%」は余裕の桁を示すものであって、Vercel での実測値ではない。

### 2.5 副次的な発見 — 既存 `pdfPageCount` は PDF 1.5 で 0 を返す

計測中に判明した現物の不具合(②-4b の実装判断に直結するので記録):

```
--- 8p_textonly.pdf ---   (実際は 8 ページ。mupdf / pdfium とも 8 と報告)
  /Type /Page count: 0          ← _lib/pdf-page-count.ts の正規表現の結果
  first MediaBox: (none - オブジェクトストリームで圧縮されている)
  PDF version: %PDF-1.5

--- mock-exam-set.pdf ---
  /Type /Page count: 5          ← 正しい
  PDF version: %PDF-1.4
```

`_lib/pdf-page-count.ts` 自身のコメントが「暗号化 PDF / object stream で圧縮された PDF では正確に出ない可能性あり、off-by-few は許容範囲内」と述べているが、**実測は off-by-few ではなく 0**(= 全ページ見落とし)。現行 UI ではページ数上限チェックにのみ使われており、**0 は「上限超過なし」として素通りする**方向の誤り。

---

## 3. R2 object lifecycle の最短粒度(公式ドキュメント)

**答え: API の schema 上は 1 日より短く指定できる。ただし削除時刻の保証にはならない。**

| 項目 | 内容 | 出典 |
|---|---|---|
| **Cloudflare native API** | `condition: { type: "Age", maxAge: number }`。docs の文言は **"after an object reaches an age in seconds"** = **秒指定** | R2 API: Put Object Lifecycle Rules |
| **S3 互換 API / wrangler** | `Expiration: { Days: 90 }` / `--expire-days` = **日指定**(整数) | Object lifecycles |
| **実際の削除タイミング** | **"Objects will typically be removed from a bucket within 24 hours of the `x-amz-expiration` value."** / **"Most objects will be transitioned within 24 hours but may take longer depending on the number of objects in the bucket."** | Object lifecycles |
| **rule 数上限** | **"object lifecycles currently has a 1000 rule maximum."** | Object lifecycles |
| prefix filter | "you can specify which prefix you would like it to apply to"(前方一致) | Object lifecycles |
| 課金 | "An object is no longer billable once it has been deleted." | Object lifecycles |

**帰結**:

- **秒単位で「期限」を宣言することは可能だが、削除の実行は期限到来から最大 24 時間程度遅れる**。→ **「N 分/N 時間で消える」という保証を lifecycle だけで得ることはできない**。短い保持上限を保証したいなら**明示 DELETE が必要**で、lifecycle は取りこぼしの受け皿(バックストップ)にしかならない。
- **rule 数上限 1000 が判明した**(前回調査で「未調査 = 不明」としていた項目)。前回 §2.4 の「現行 key 形(`users/{uid}/src/`)は user ごとに rule が要る」という制約に対し、**1000 user までは理屈上は表現できる**が、user 追加のたびに rule を足す運用になる。単一 rule にするなら source を top-level 専用 prefix に置く key 設計、という前回の整理は変わらない。

**出典 URL**:
- [Object lifecycles · Cloudflare R2 docs](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [R2 › Buckets › Lifecycle › Put Object Lifecycle Rules](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/)

---

## 4. 未検証 / 不明(推測しない)

| 項目 | 状態 |
|---|---|
| Vercel への実 deploy 動作 | **未実施**。根拠は build 生成物(nft.json + emit された asset + chunk の参照先)まで |
| WASM の Vercel Node runtime での init | **未検証** |
| function bundle size 上限に対する `.wasm`(10.4 MB / 4.0 MB)の余裕 | **未確認** |
| Vercel 1 vCPU での所要時間 | **未測定**(devcontainer 値のみ。支配項が CPU バウンドの webp encode ゆえ差は大きく出うる) |
| 単一 40 ページ文書のメモリプロファイル | **未測定**(40 ページの sample が repo に無く、反復で代替) |
| `@napi-rs/canvas` が設定次第で build を通るか | **未評価**(指示により停止) |
| lifecycle の秒指定が実際に受理されるか(実 API 実行) | **未実測**(docs の schema 記述のみ) |
| PDF 入力時の box_2d 座標系 | **未検証**(前回調査から不変・probe script は現存) |
