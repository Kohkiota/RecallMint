# iPad(iOS/WebKit)画像添付が破損 — 原因特定(修正はまだ)

- **日付**: 2026-07-12
- **手法**: systematic-debugging(Phase 1 根本原因 + Phase 2 reference 解析)。**修正は未実施**(OT 指示どおり原因特定のみ)。
- **症状**: iPad(iOS/WebKit)で画像添付 → R2 に **破損した極小 `image/webp`(≈856B、プレビューが途中で切れた/ほぼ空)** が着地。PC/Blink では同操作で正常な ≈44KB webp。破損出力が「圧縮成功」扱いで reserve→PUT→R2 まで到達。

---

## 結論(2 系統の根本原因)

### 原因A(圧縮が壊れる) — WebKit で圧縮が**空 canvas を正直に webp 化**し ≈856B を「成功」で返す
`browser-image-compression@2.0.2` の実挙動(source: `node_modules/browser-image-compression/dist/browser-image-compression.mjs`・subagent が cite 付きで精査):

1. **worker→main フォールバック**: `useWebWorker:true` で worker を試すが、worker 内 `drawFileInCanvas` が iOS 分岐で `throw "Skip createImageBitmap on IOS and Safari"` → `loadImage`(`new Image`)へ。**worker には `Image` が無く ReferenceError** → worker が error post → `$Try_1_Catch` が **main thread の `compress()` にフォールバック**。⇒ iOS では実圧縮は main thread で走る(worker は空回りして落ちるだけ)。
2. **iOS は createImageBitmap を使わない**: main でも iOS 分岐で `createImageBitmap` を skip し、`Image` 要素 + dataURL で読み込む(lib 自身の Safari 対策)。
3. **空 render(no throw)**: `drawImageInCanvas` は画像を**まず自然サイズの canvas に drawImage** してから縮小する。iOS Safari の canvas ピクセル/メモリ上限(lib は iOS を 4096² に cap)に大きな元画像が当たると、`drawImage` が **例外を投げずに空/ほぼ空**に描く(WebKit の既知挙動)。→ 縮小コピーも空 → 空 canvas。
4. **型は正直(relabel 無し)**: webp 経路は `convertToBlob({type:'image/webp'})` / `toDataURL('image/webp')` で、**型を強制する `new Blob([...],{type})` は png/bmp/jpeg-exif 経路にのみ存在し webp には無い**(全 `new Blob` を列挙して確認)。⇒ `blob.type==='image/webp'` は **WebKit が本当に webp encode した**証拠(modern Safari は canvas webp encode 対応)。つまり **PNG 誤 relabel ではなく「空 canvas を正しく webp 化した」極小 blob**。
5. **size のみで success**: lib の解決条件は `size>maxSizeMB` の再試行のみ。≈856B は即 target 未満 → ループ skip → **`resolve(g)`**。**非空検証・pixel 検証・型一致検証は一切無い** → 壊れた blob が成功として返る。

> 旧仮説(「WebKit は webp 不可で PNG に落ち、lib が webp と誤ラベル」)は **code 上否定**。型は honest。破損の実体は **空 canvas**(型ミスマッチでも truncation でもない)。

### 原因B(壊れた出力を検知せず PUT まで通す) — RecallMint 側の**内容妥当性検証の欠落**(全 gate が metadata のみ)
- `lib/media/upload.ts compressForAttach`: 検証は `createImageBitmap(blob)`(:181)の **header decode(寸法取得)のみ**。空/欠損 webp も header は decode でき寸法が取れる → 通過。**最小サイズ・内容整合の check 無し**。`mime = blob.type`(:177)を無検証で信用。
- `byteSize: compressed.blob.size`(:348)を無検証で reserve へ(client 下限無し)。
- server `reserveAsset`(`_actions/asset-actions.ts`): `mime: z.enum(['image/webp','image/png'])`(:57 — webp は許容)/ `byteSize: z.number().int().positive().max(5MiB)`(:58 — **下限無し**、856 通過)/ 寸法 positive / hash。**内容 check 無し**。
- PUT: 856B body = 署名 Content-Length 856 一致 → 200(前 smoke の over-size 防御は size 一致ゆえ無力)。
- server `finalizeAsset`: `headObject` で `contentLength === asset.byteSize`(:149)= **size の一貫性のみ**検証。内容の妥当性は見ない(856===856 で pass)。

⇒ **どの層も「型・サイズ範囲・寸法・hash・R2 size 一致」= 構造/メタのみ検証し、画像が完全で正常かは一度も検証しない**。空 webp が全 gate を素通り。

---

## 対処の当たり(2 系統・**未実装**・次 task で OT 判断)

- **(a) WebKit で圧縮を正す**: 候補 — ① Safari/iOS で `useWebWorker:false`(worker→main の脆いフォールバック往復を除去し main 固定)/ ② 自前で `createImageBitmap`+`OffscreenCanvas` の検証済経路で resize/encode、または iOS では出力を png/jpeg に寄せる / ③ 出力後に **実際の `blob.type` を honor** し webp を仮定しない。※空 render の直接原因(大 canvas × iOS 上限)を断つのが本丸。
- **(b) 出力妥当性検証を足す(防御)**: **最小サイズ単独は弱い**(856B は多くの閾値を通るし、正当な単色小画像も小さい)。空 webp と誤 relabel の両方を捕るには **decode-and-inspect**: 出力を decode → 非自明な寸法 **かつ** pixel 非一様(ImageData sample・全面単色/全透明を reject)を確認。magic-byte(RIFF/`WEBP`)check は **誤 relabel** は捕るが **正しく webp 化された空画像は捕れない** → **full-decode の内容 check が必須**。(a)+(b) 両方を推奨(圧縮を直す + 壊れた出力を通さない二重防御)。

---

## 未確定 / 環境制約(OT 実機で確定要)

- **empirical WebKit 再現は本環境で不可**: DevTools MCP browser は **Chromium(Chrome/149)**、Playwright-webkit も未 install(Bash の外部 network egress が sandbox で denied ゆえ browser download 不可)。iOS/WebKit の実走再現は **OT の iPad が要る**。
- **code 上確定**: worker→main フォールバック / iOS の createImageBitmap skip / webp 型は honest(relabel 無し)/ size のみ success / RecallMint 側の内容検証欠落 — すべて source 引用で確定。
- **device 依存で未確定(要 iPad 確認)**: 「なぜその iPad で `drawImage` が空描画になるか」の**厳密なトリガ**(元画像の実寸法・中間の自然サイズ canvas が iOS の canvas ピクセル/メモリ上限に当たるか)。44KB(Blink・canvas 上限無し)vs 856B(WebKit・上限)という対比が「大 canvas × iOS 上限 → 空描画」を強く支持するが、実寸法は iPad で captureして確定するのが確実。
- 確認の当たり(OT iPad or webkit 実機がある環境): 添付時に圧縮**前**の `file.size`/自然寸法、圧縮**後**の `blob.size`/`blob.type`、及び `createImageBitmap(blob)` の naturalWidth/Height と ImageData の非一様性を console captureすれば、空 canvas 説と厳密トリガが確定する。
