# R2 スキャン用途廃止 + 月次 counter 設計 + source_documents schema 整理 — 事前調査 (2026-05-20)

> S1.9.1 sprint 設計のための事前調査。 **実装変更なし、 現状の trace と整理のみ**。
> 修正方針 / 案選定は提示しない (後段で claude.ai + OT が検討)。

---

## 0. 最重要の前提訂正 (現場で発見した想定外)

kickoff は「R2 スキャン用途を**廃止**する」 「R2 利用を編集用画像のみに**限定**
する」 を前提とするが、 現場確認の結果:

**R2 は現コードベースに一切実装されていない。** 廃止すべき「R2 スキャン経路」
も、 残すべき「R2 編集用画像経路」 も、 どちらもコードとして存在しない。

裏付け:
- `package.json` に `@aws-sdk/*` / `aws-sdk` / S3 互換 client 依存なし
- `lib/storage/` ディレクトリ自体が存在しない (`lib/` は flat 構成、 storage
  module なし)
- `getImageUploadUrl` / `confirmImageUpload` / `startUpload` / `getUploadStatus`
  関数はどこにも定義なし (grep 0 件)
- `R2_*` 環境変数 (`R2_ACCOUNT_ID` 他 5 個) はコードから一度も参照されない
  (`.env.example:41-45` と `docs/02-tech-spec.md` にのみ存在)
- presigned URL 発行 / S3Client / PutObjectCommand / getSignedUrl の使用なし

つまり S1.9.1 の「R2 スキャン廃止」 は **コード削除作業ではなく、 (a) 未使用
環境変数の除去、 (b) Tech Spec の R2/OCR フロー記述を実装実態に合わせる
書き換え、 (c) `source_documents.file_url` 列の drop**、 が実体になる。
「編集用画像の R2 経路」 は廃止対象でも保護対象でもなく、 **将来機能の未着手
項目** として整理し直す必要がある。

以下、 各 scope を実態ベースで報告する。

---

## 1. R2 / OCR フローの現状 (trace)

### 実際の OCR フロー (完全 inline、 R2 非経由)

`/app/upload` での OCR は以下の経路。 R2 もファイル永続化も一切ない:

1. **client** (`upload-form.tsx`): user が file 選択 → 画像は
   `browser-image-compression` で圧縮、 PDF は `pdfPageCount` で頁数解析。
   `buildFormData()` で `FormData` に file を直接 `append`
2. **Server Action** (`processUpload`、 `process.ts`): `formData.getAll('files')`
   で `File[]` を受領
3. file ごとに `await f.arrayBuffer()` → `Buffer.from(buf).toString('base64')`
   で **メモリ上で base64 化** (`process.ts` の geminiInputs 構築箇所)
4. `runOcrPipeline(geminiInputs, ...)` → `callGemini` (`lib/ai/clients/gemini.ts`)
   が `inlineData: { mimeType, data }` で **base64 を Gemini に直接 inline 送信**
5. 結果の cards を DB INSERT、 `source_documents` は `file_url: null` 固定で
   INSERT (`process.ts` の source_documents INSERT 箇所)

→ アップロードされた PDF / 画像は **Vercel Function のメモリ上にしか存在せず、
処理完了でメモリ解放、 永続ストレージには一切書かれない**。 第三者著作物の
事業者サーバー保存という法務リスクは、 現実装では既に発生していない。

### Tech Spec が描く OCR フローとの乖離

`docs/02-tech-spec.md` は実装と異なる OCR フローを記述している (実装が後で
簡素化された結果、 Spec が取り残されている):

| Tech Spec の記述 | 実装の実態 |
|---|---|
| `startUpload` で presigned URL 発行 → client が R2 直 PUT (§8 Logic, L674, L704) | presigned 発行なし。 client は FormData に file を直 append |
| `/api/ocr/process` API Route (Vercel Function) で OCR (L21, L695) | API Route なし。 `processUpload` Server Action が同期実行 |
| `getUploadStatus` を 3 秒間隔ポーリングで進捗取得 (L676, L705) | ポーリングなし。 Server Action が結果を直接 return |
| OCR 入力は「PDF or 画像 (R2 上の URL)」 (L908) | 入力は inline base64 |
| 50 ページ以上は client 分割 + 並列 Function (L702, L913) | 分割並列なし。 単発処理 (CLAUDE.md は「1 ファイル ≤ 150 ページ単発」 に更新済) |

この乖離は S1.9.1 以前から存在する既存の Spec 負債。 S1.9.1 の Tech Spec
書き換え scope に含めるか否かは OT 判断 (本調査は事実列挙のみ)。

### scripts/ocr-poc

`scripts/` ディレクトリは現在空 (`scripts/ocr-poc/run.ts` は既に削除済、
`lib/ai/cost.ts:3` のコメントが「commit 0a5ec0d で削除済」 と記録)。 PoC の
inline base64 方式は本実装 `lib/ai/clients/gemini.ts` に継承されている。

---

## 2. R2 利用箇所の網羅

### スキャン用 (kickoff 言う「削除対象」) — コードには存在しない

| kickoff 想定 | 現状 |
|---|---|
| pre-signed URL 発行 | コードなし |
| `startUpload` / `getUploadStatus` | コードなし (Tech Spec の API 設計のみ) |
| `source_documents.file_url` 書き込み | `process.ts` が **常に `null`** を INSERT。 読み出しコードは 0 件 |
| `lib/storage/r2.ts` の PDF/スキャン経路 | `lib/storage/` 自体が存在しない |

→ 「削除」 の実体: `source_documents.file_url` 列の drop + `.env.example` /
Tech Spec の R2 記述整理。 コード削除はゼロ。

### 編集用画像 (kickoff 言う「残す」) — コードには存在しない (将来機能)

| kickoff 想定 | 現状 |
|---|---|
| `getImageUploadUrl(cardId, mimeType)` | コードなし (Tech Spec §8 L669 の設計のみ) |
| `confirmImageUpload(cardId, key, url)` | コードなし (Tech Spec §8 L670 の設計のみ) |
| `cards.images` column | **schema には存在** (`schema.ts:257` `images: jsonb('images')`、 型 `CardImage[]`)。 ただし書き込むのは `process.ts` の cards INSERT で**常に空配列 `[]`**。 読み出して表示する UI コードは 0 件 |
| `lib/storage/r2.ts` の card 添付経路 | 存在しない |

→ 「残す」 の実体: `cards.images` 列という schema 上の受け皿だけが存在し、
画像添付機能 (Logic 2) は完全に未着手。 S1.9.1 で「残す」 のは将来実装余地で
あって、 現存コードではない。

### R2 が文字列として登場する全箇所 (コード + 設定 + doc)

- `.env.example:41-45`: `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
  `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_PUBLIC_URL` (全て未使用)
- `lib/db/schema.ts:312`: コメント「file_url NULL = OCR 完了後 R2 元ファイル
  破棄済」 (実態は最初から null、 破棄概念自体が空振り)
- `docs/02-tech-spec.md`: 多数 (§5 で網羅)
- `lib/auth/ensure-user.ts` 等の "R2" は「Bug 3 fix の R2 (Round 2)」 の意味で
  Cloudflare R2 とは無関係 (誤検出、 対象外)

---

## 3. 月次 OCR counter の schema source

### 現状の月次 quota 計算 (counter table 不在)

現状、 月次 OCR 使用量を保持する専用 counter は**存在しない**。
`getCurrentMonthOcrPages` (`lib/ai-usage-mcq.ts:63-89`) が
`source_documents.pages_processed` を JST 月境界で都度 SUM する派生計算方式。
これが Bug A (2026-05-20 調査 doc) の「discard 物理削除 = quota 返金」 構造欠陥
の根。

### 既存 `ai_usage` / `ai_usage_users` の構造

`lib/db/schema.ts:140-159`:

```
ai_usage:        { date (PK), count }
ai_usage_users:  { user_id, date, count }   PK = (user_id, date)
```

両 table の特性:
- **粒度は「日」**: `date` は JST 1 日 (`'YYYY-MM-DD'`)。 月次集計するには
  当月の全 date row を SUM する必要がある
- **`count` の意味**: S1.8 の `incrementAiUsage` (`lib/ai-usage-counter.ts`)
  実装では **Gemini API call 回数** をカウント (Flash/Pro/retry の各 call で +1)。
  ページ数ではない
- **Tech Spec との drift**: `docs/02-tech-spec.md:73` は ai_usage_users を
  「count を『OCR 抽出問題数』 として運用」 と記述。 同 L842 は「上限チェックは
  `lib/db/queries/ai_usage.ts` で ai_usage_users.count の月次集計」 と記述。
  どちらも実装と不一致 (実装は call 数カウント + 上限 enforce は
  `lib/ai-usage-mcq.ts` の source_documents SUM)
- **読み出し側**: `ai_usage` は `getTodayAiUsageGlobal` が GEMINI_DAILY_LIMIT
  guard で読む。 `ai_usage_users` は **書き込みのみで読み出しコード 0 件**
  (enforce にも表示にも未使用)

### 「ページ単位の月次 counter」 として既存 table を流用できるか

**そのままでは不可。** 理由:
1. `count` は call 数であってページ数ではない (意味が違う)
2. 粒度が「日」 で「月」 ではない (月次値は当月の日次 row を SUM する必要)
3. `ai_usage_users` の現 `count` 用途 (Gemini call 数記録) と、 新たに持たせ
   たい「月次 OCR ページ数」 は別の量。 同一 `count` 列に同居させられない

### 構造の選択肢 (両 path の差を整理。 推奨は提示しない)

**Path A — 既存 `ai_usage_users` を column 追加で拡張**
- 例: `pages` 列 (integer) を追加し、 OCR 完了時に当日 row へ `pages` を加算
- 月次使用量 = 当月の全 date row の `SUM(pages)`
- 構造差 / 論点:
  - 粒度は「日」 のまま → 月次は依然 SUM クエリ。 月境界 (JST) 計算は
    `ai-usage-mcq.ts` 既存ロジックを流用可
  - 1 table に「call 数 (`count`)」 と「ページ数 (`pages`)」 の 2 つの異なる
    量が同居 → 列の意味が増える
  - 月初リセットは「新月 = 新 date row、 過去月 row は集計対象外」 で自然成立
  - 既存 table のため migration は ADD COLUMN のみ
  - 同期非対象テーブル (Tech Spec §2.1-14) の位置づけは維持される

**Path B — 月次専用 table を新設**
- 例: `(user_id, month) PK + pages_used integer` のような構造
  (`month` は `'YYYY-MM'` JST、 または月初日)
- 月次使用量 = 当該 (user_id, month) row の `pages_used` を直接 read (SUM 不要)
- 構造差 / 論点:
  - 粒度が「月」 native → 月次値は 1 行 read。 SUM クエリ不要
  - 「OCR 月次ページ」 という単一目的の table、 意味が明快
  - 月初リセットは「新月 = row 不在 = used 0」 で自然成立 (kickoff の MVP 要件
    と一致)
  - 新規 table のため CREATE TABLE migration が必要
  - `users` への FK + onDelete cascade を張る設計判断が要る (削除整合性、
    Tech Spec §2.1-9 の hard delete 方針との整合)
  - discard で減算しない設計 (= Bug A 対策の本丸) は table を分離した上で
    「OCR 完了時に加算、 discard では触らない」 とすれば成立する。 ただし
    「加算するのは completed 時か / processing INSERT 時か」 「失敗 OCR を
    数えるか」 等の計上タイミングは別途要設計 (本調査範囲外)

両 path 共通の論点 (どちらを選んでも S1.9.1 本体で決める必要がある):
- 計上タイミング (processing 開始時 / completed 確定時 / Gemini call 単位)
- 失敗 OCR (GEMINI_FAILED) を月次に計上するか
- 既存ユーザーの当月分 backfill 要否 (production active user 0 件なら不要)
- `source_documents.pages_processed` SUM 方式 (現 `ai-usage-mcq.ts`) を
  廃止するか、 表示用に残すか

---

## 4. `source_documents` 各 column の利用状況

`process.ts` が全列を**書き込む**。 以下は **読み出し** 側の網羅
(grep ベース、 test 除く):

| column | 書き込み | 読み出し | S1.9.1 想定変更 | 備考 |
|---|---|---|---|---|
| `id` | INSERT 時自動 | `discard.ts` (owner 確認 / DELETE 対象) | — | |
| `user_id` | `process.ts` INSERT | `ai-usage-mcq.ts` (SUM の WHERE)、 `discard.ts` (owner 確認) | — | |
| `exam_id` | `process.ts` INSERT | `discard.ts` の exam DELETE NOT EXISTS subquery | — | アプリ表示経路の読み出しなし |
| `file_type` | `process.ts` INSERT (`'pdf'`/`'image'`) | アプリ読み出し 0 件 | — | `$type` は `'csv'`/`'markdown'` も含むが未使用 |
| **`file_url`** | `process.ts` INSERT で**常に `null`** | **読み出し 0 件** | **drop** | drop しても参照コードゼロ、 影響は schema/migration のみ |
| `filename` | `process.ts` INSERT | `notifyOps` の payload に含む (`process.ts` の OCR 失敗通知) | — | UI 表示経路なし |
| **`file_size_bytes`** | `process.ts` INSERT (`totalSize`) | **読み出し 0 件** | kickoff「残す」 | kickoff は「UI 等で利用されている前提」 とするが、 **実際には読み出しコードが存在しない**。 残す判断は OT へ (本調査は事実のみ) |
| **`status`** | `process.ts` INSERT (`'processing'`) → 完了/失敗で UPDATE | `ai-usage-mcq.ts` (`'completed'` / `'processing'` で WHERE) | enum 4→3 値 (`'uploading'` 削除) | schema default は `'uploading'` だが **`process.ts` は明示的に `'processing'` を INSERT** するため `'uploading'` は実際には一度も書かれない = 既に dead value。 削除しても書き込み側影響なし。 default 値の変更は要 (新 default を `'processing'` 等に) |
| `pages_processed` | INSERT 時 default `0` → 完了 UPDATE で `totalPages` | `ai-usage-mcq.ts` の `SUM` | (月次 counter 分離次第) | Bug A の核。 月次 counter を別 table 化したら本列の SUM 依存は解消方向 |
| `pages_total` | `process.ts` INSERT (`totalPages`) | 読み出し 0 件 | — | |
| `cards_extracted` | 完了 UPDATE | 読み出し 0 件 | — | |
| **`ocr_cost_yen`** | 完了 UPDATE (`pipelineResult.costYen`) | 読み出し 0 件 (DB 列としては) | **`integer` → `numeric(10,4)`** | 下記詳細 |
| `error_message` | `markFailed` の UPDATE | 読み出し 0 件 | — | |
| `created_at` | INSERT default `now()` | `ai-usage-mcq.ts` (JST 月境界 WHERE + stale 判定) | 維持 | 月次計算の基盤 |
| `completed_at` | 完了 UPDATE (`now()`) | 読み出し 0 件 | 維持 | |

### 補足: source_documents はほぼ write-only audit log

読み出しコードがある列は `id` / `user_id` / `exam_id` / `status` /
`pages_processed` / `created_at` のみ。 しかもその読み出しは全て
`ai-usage-mcq.ts` (月次 SUM) と `discard.ts` (削除処理) に限られ、
**UI 表示で source_documents を読む経路はゼロ** (`/app/exams` 系は
`getActiveExamsWithCardCount` で exams + cards のみを読み、 source_documents
を touch しない)。

→ 月次 counter を別 table へ分離すると、 source_documents は実質
「OCR ジョブの audit ログ」 だけの table になる。 この事実は S1.9.1 の
schema 整理の判断材料になりうる (本調査は指摘のみ)。

### `ocr_cost_yen` を `numeric(10,4)` 化する場合の touch 必要箇所

`integer` → `numeric(10, 4)` 変更で連動する箇所:
- `lib/db/schema.ts:337`: 列定義 (`integer('ocr_cost_yen')` →
  `numeric('ocr_cost_yen', { precision: 10, scale: 4 })`)。 drizzle の
  `numeric` は default で **string** を返す点に注意 (`{ mode: 'number' }`
  指定 or 読み出し側で変換が要る — 実装詳細は S1.9.1 本体)
- `lib/ai/cost.ts:23-33` `estimateCostYen`: 現状 `Math.round(usd * JPY_PER_USD)`
  で integer 円に丸めている。 小数保持にするなら `Math.round` 除去
- `lib/ai/ocr.ts:194-199`: `costYen` を `tokenUsage.reduce` で合算、 型 `number`
- `app/(app)/app/upload/_actions/process.ts`: 完了 UPDATE の `ocrCostYen:
  pipelineResult.costYen`、 `ProcessResultData.ocrCostYen: number`、
  `ProcessUploadErrorDetails.costYen?: number`
- `app/(app)/app/upload/_components/upload-form.tsx:897-898`: `ErrorDetails`
  が `details.costYen` を `String()` 化して staging 詳細表示
- migration: `ALTER COLUMN ... TYPE numeric(10,4)` (既存 integer 値は無損失で
  numeric にキャスト可)
- 関連 test: `lib/ai/cost.test.ts` (現状 integer 期待値、 小数化で要更新)

---

## 5. Tech Spec 書き換え箇所の list

`docs/02-tech-spec.md` で R2 スキャン / OCR フロー / source_documents schema /
月次 counter に言及し、 実態と乖離する箇所。 **本調査は list 化のみ、 書き換え
は S1.9.1 本体で実施**。

### (a) R2 スキャン経路 — 削除対象 (R2 未実装 + スキャン保存しない方針)

| 行 | 内容 |
|---|---|
| L24 | アーキ図「Pre-signed URL → クライアントから R2 直アップロード」 |
| L26 | アーキ図「[Cloudflare R2] 画像 / 元 PDF」 のうち「元 PDF」 |
| L674 | `startUpload` (presigned URL + sourceDocId 発行) |
| L675-676 | `processSourceDoc` / `getUploadStatus` (OCR ジョブ起動 + ポーリング) |
| L695 | API Route `POST /api/ocr/process` |
| L700-706 | 非同期処理戦略 (50 ページ分割並列 / Pre-signed Upload / 3 秒ポーリング) |
| L854 | アカウント削除フロー step 5「R2 上の画像 / 元 PDF を全削除」 のうち「元 PDF」 |
| L908 | Logic 1 入力「PDF or 画像 (R2 上の URL)」 |
| L1138 | バックアップ「R2: バージョニング有効、 ライフサイクル 90 日」 (元 PDF 保存前提) |

### (b) OCR フロー — 実装実態に合わせる書き換え

| 行 | 乖離内容 |
|---|---|
| L21 | `/api/ocr/process` Vercel Function 60s → 実態は `processUpload` Server Action |
| L908-917 | Logic 1 アルゴリズム (入力 R2 URL / API Route / 50 頁分割 / status 更新) → 実態は inline base64 + Server Action 同期 |
| L42 | OCR ジョブ「Vercel Function 60s 同期 / 50 頁以上 client 分割並列」 → 実態は単発 (CLAUDE.md は 150 頁単発に更新済) |

### (c) R2 編集用画像経路 — 「未実装の将来機能」 と明示する書き換え

(廃止ではない。 現状「実装済」 と読める記述を「未着手」 に整理)

| 行 | 内容 |
|---|---|
| L56 | 設計原則 5「画像は R2 に保存、 DB には URL/key のみ」 |
| L350 | `CardImage.url`「R2 公開 URL or 署名付き URL」 |
| L669-670 | `getImageUploadUrl` / `confirmImageUpload` |
| L919-928 | Logic 2 画像手動添付 (presigned + R2 直 PUT) |
| L756 | `lib/users/delete.ts` コメント「Clerk → DB cascade → R2」 |
| L760-761 | `lib/storage/r2.ts`「presigned URL 発行 / 削除」 |
| L1058, L1068 | PWA cache「画像 (R2 origin)」「R2 から再取得」 |

### (d) source_documents schema — §2.5.3 (L405-439)

| 箇所 | 変更 |
|---|---|
| L417 | `file_url` 列定義 + コメント「R2 URL、 破棄前提なら NULL」 → 列ごと drop |
| L420-421 | `status` default `'uploading'` + enum 4 値 → 3 値、 default 見直し |
| L425 | `ocr_cost_yen: integer` → `numeric(10,4)` |
| L438 | 設計メモ「`file_url` NULL = OCR 完了後 R2 元ファイル破棄」 → 削除 |
| L437 | 「同時実行制限 `WHERE status='processing'`」 → 現状アプリ未実装 (要確認、 本調査範囲外だが乖離候補) |

加えて `lib/db/schema.ts:312` のコメント「file_url NULL = OCR 完了後 R2
元ファイル破棄済」 も schema 整理で除去対象。

### (e) 月次 counter — ai_usage_users の drift

| 行 | 乖離内容 |
|---|---|
| L73 | テーブル一覧「ai_usage_users: count を『OCR 抽出問題数』 として運用」 → 実装は Gemini call 数 |
| L842 | 「上限チェックは `lib/db/queries/ai_usage.ts` で ai_usage_users.count の月次集計」 → 実装は `lib/ai-usage-mcq.ts` の source_documents SUM。 `lib/db/queries/` ディレクトリ自体が存在しない |
| (新設時) | 月次 counter を新 table / 列にする場合、 §2.5 に schema 記述の追加が必要 |

### (f) 環境変数 — §10 (L1121-1125)

| 行 | 内容 |
|---|---|
| L1121-1125 | `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_PUBLIC_URL` |

→ R2 編集用画像を将来実装する前提なら env は将来再追加扱い、 スキャン廃止
だけなら現時点で `.env.example` ともども除去。 判断は S1.9.1 本体。

### (g) その他 R2 言及

| 行 | 内容 |
|---|---|
| L40 | 技術スタック「ストレージ: Cloudflare R2 (画像、 egress 無料)」 |
| L1134 | 「DNS: Cloudflare (R2 と統合管理)」 |
| L1142-1152 | §11.1 ストレージコスト試算 (R2 vs Vercel Blob vs S3) |

→ 編集用画像を将来 R2 で実装する方針が維持されるなら (g) は概ね残置可。
スキャン専用記述ではないため、 (a) とは扱いを分けるべき。

---

## 6. 想定外まとめ (OT 判断が要る論点)

1. **R2 はそもそも未実装** — S1.9.1 の「R2 スキャン廃止」 はコード削除では
   なく env 変数除去 + Tech Spec 整合 + `file_url` 列 drop が実体
2. **編集用画像 (R2) も未実装** — 「残す」 対象は将来機能の受け皿
   (`cards.images` 列) のみ。 Logic 2 全体が未着手
3. **`file_size_bytes` は読み出しコードが無い** — kickoff は「UI 等で利用
   前提」 とするが実態は write-only。 残す/落とすは OT 判断
4. **`status='uploading'` は既に dead value** — `process.ts` は常に
   `'processing'` を INSERT。 enum から外す影響は schema default のみ
5. **source_documents は実質 write-only audit log** — 月次 counter を別 table
   化すると、 UI も enforce も source_documents を読まなくなる
6. **OCR フローの Tech Spec 乖離は S1.9.1 以前からの既存負債** — presigned /
   API Route / ポーリング / 50 頁分割は Spec にあるが未実装。 S1.9.1 の Tech
   Spec 書き換え scope にどこまで含めるかは OT 判断
7. **ai_usage_users は書き込み専用で死蔵中** — S1.8 で counter を作ったが
   読み出し側が無い。 月次 counter 設計で「ai_usage_users を活かす / 別 table」
   の判断材料になる

---

## 参照

- `docs/superpowers/sessions/2026-05-20-ocr-counter-and-progress-display-investigation.md`
  (Bug A = quota 返金欠陥の調査、 本 doc の月次 counter 分離の動機)
- `docs/superpowers/sessions/2026-05-19-s1-8-revalidate-ai-usage-warnings-handoff.md`
  (ai_usage / ai_usage_users counter を S1.8 で導入した経緯)
- 関連 file (実装):
  - `lib/ai-usage-mcq.ts` (`getCurrentMonthOcrPages` / `canRunOcr`、 現 quota 計算)
  - `lib/ai-usage-counter.ts` (`ai_usage` / `ai_usage_users` への書き込み)
  - `lib/ai/clients/gemini.ts` (inline base64 で Gemini 送信、 R2 非経由)
  - `lib/ai/cost.ts` (`estimateCostYen`、 integer 円丸め)
  - `app/(app)/app/upload/_actions/process.ts` (source_documents 全列書き込み)
  - `app/(app)/app/upload/_actions/discard.ts` (source_documents 読み出し + 削除)
  - `lib/db/schema.ts` (`source_documents` L314-348 / `ai_usage` L140 /
    `ai_usage_users` L149 / `cards.images` L257)
- 設計 doc: `docs/02-tech-spec.md` (§1 アーキ / §2.5.3 schema / §8 Logic /
  §10 env / §11 運用)
