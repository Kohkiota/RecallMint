# 画像添付(編集面) + R2 presigned 直アップロード — 事前 fact-finding (2026-07-11)

> ① 画像添付・presigned 直アップロードの **spec 前段**。実装変更なし、実コードでの棚卸しと実装可否判定のみ。
> 修正方針の確定は後段 (brainstorming/spec + OT)。**推測で埋めず、file:line で裏取り**。
>
> - 対象 HEAD: `develop` `c33bedc`(調査時)
> - 方法: 4 並列 read-only subagent(R2 基盤 / card schema+編集面 / body 天井 / Gemini bbox)+ CC 本体の直接検証(package.json / next.config.ts / .env.example / tech-spec / markdown 有無)
> - 先行調査: `docs/superpowers/sessions/2026-05-20-r2-scrub-and-counter-schema-investigation.md`(約 7 週前・S1.9.1 用)。**その中核主張「R2 はコード未実装」は HEAD でも成立**。本 doc は再検証 + 深掘り + 編集面/body 天井の追加調査。
> - 設計正本: `docs/02-tech-spec.md`(この機能は spec 上「将来機能・未着手」として既に詳細設計済)

---

## 0. 結論(TL;DR)

**① は spec 化に進める状態(追加のコード調査は不要)。** storage 層は greenfield だが全経路が判明済、data model の受け皿 (`cards.images`) は既存で read 側配線は完了、UI 差し込み点も特定済、body 天井 bypass も構造的に成立。spec(brainstorming)で潰すべきは実装調査ではなく **設計判断**(§7 の決定点)。

**②③④ はいずれも ① から分離可能。** ①(手動添付 + presigned 直アップ + gallery 描画)は ②③④ 無しで MVP 成立する:
- **② OCR bbox 自動切り抜き** = tech-spec §13.4 で既に v1.x・PoC ゲート扱い。実 API は「maybe(可能だが未実証)」。① を一切ブロックしない別論点。
- **③ D&D** = 添付 UX の増分。差し込み点は ① と同一 (`card-editor-fields.tsx`)。MVP は file picker / paste 先行 → D&D 後追いで可。
- **④ クライアント圧縮** = `browser-image-compression` が既に repo に存在(OCR 用)。流用可、採否は policy 判断。

**主要な spec 決定点(§7 詳細)**: 新 dep 承認(aws4fetch vs @aws-sdk)/ 配信方式(public URL `<img>` vs next/image+remotePatterns)/ `CardImage` 型の整合(`target`/`alt` が現状 required・`width`/`height` 無し)/ 記法(inline `![](key)` marker vs gallery 描画)/ presigned 発行を Server Action か Route Handler か / object key 設計 + 削除時の orphan 掃除 / **bucket CORS(外部 ops 前提)** / R2 単一オブジェクト上限の docs 確認。

---

## 1. R2 基盤の現況

**結論: R2 はコードに一切実装なし(dep も client も module も grep 0)。env 変数は宣言のみで dead。既存の画像永続経路ゼロ。**

| 項目 | 実態 | 証跡 | 判定 |
|---|---|---|---|
| S3/R2 client dep | 無し | `package.json` 全 dep + grep `aws\|s3\|cloudflare\|r2\|presign\|@aws-sdk\|aws4fetch` → 0 hit | 確定 ABSENT |
| presign 系 symbol | 無し(唯一の hit は schema コメント) | 全 repo grep `S3Client/PutObjectCommand/GetObjectCommand/getSignedUrl/presign/aws4fetch` → `lib/db/schema.ts:394` のコメントのみ(`'uploading'` 廃止 = 旧 R2 presigned 段階) | 確定 ABSENT(実行コード) |
| storage module | 無し | `lib/storage/` 不在、`find -type d '*storage*'` → 0 | 確定 ABSENT |
| `R2_*` env のコード参照 | 無し | grep `R2_ACCOUNT_ID/…/R2_PUBLIC_URL` in `*.ts/tsx/mjs/js` → 0 hit | 確定 ABSENT(宣言のみ・dead) |
| R2 への upload/read 経路 | 無し | OCR は inline base64 を Gemini へ直送(`app/(app)/app/upload/_actions/process.ts:284` `Buffer.from(buf).toString('base64')`)。永続化ゼロ | 確定 ABSENT |

**`.env.example`(R2 section, verbatim `73-79`):**
```
# Cloudflare R2 (試験問題画像の保存)
# bucket: mcq-platform、Object Read & Write 権限の API token
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=mcq-platform
R2_PUBLIC_URL=https://pub-xxxxxxxxxxxx.r2.dev
```
→ 認証方式 = `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` の **S3 互換 SigV4 アクセスキー対**(「Object Read & Write 権限の API token」)。presigner がそのまま消費できる形。

**既存の再利用可能資産(先行 doc に無かった点)**: `cards.images` 列は既に end-to-end で配線済だが **data のみ**(§4 参照)。→ この機能の着地点はこの列。

---

## 2. presigned URL 発行の実装可否

**結論: 現行では発行不可(dep が無い)。dep 1 本追加すれば発行可能。CORS は repo 外の ops 前提。発行 action の置き場所と env-check pattern は既存に倣える。**

| 項目 | 実態 / 当たり | 証跡 |
|---|---|---|
| 現行で presigned PUT 発行 | **不可**(presigner dep ゼロ) | §1 |
| 必要 dep(標準 2 択) | (a) `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`、または (b) `aws4fetch`(軽量・無 AWS-SDK の repo 姿勢に合致)。R2 の S3 endpoint = `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` | 新規(CLAUDE.md「新ライブラリ導入は事前相談」→ OT 承認要) |
| 有効期限 | tech-spec 設計 = 10 分短寿命(`docs/02-tech-spec.md:886,1446`) | 設計のみ(未実装) |
| **CORS 設定** | **repo に無し + 本質的に外部**。ブラウザ直 PUT には R2 bucket 側に `PUT`(+ preflight)を app origin から許可する CORS ルールが**必須**。R2 の bucket CORS は Cloudflare dashboard/API で設定 = **コード成果物でなく ops 手順** | 確定 ABSENT(repo)。実装前提の ops |

**env-check / client の踏襲パターン**(fail-fast, `VERCEL_ENV` ベース):
- `lib/clerk/env-check.ts:16-60`(module load で throw、副作用のみ `export {}`)
- `lib/stripe/client.ts:1-79`(同 fail-fast + 構築済 client を export)
- → **自然な置き場所 = 新規 `lib/storage/r2.ts`**(`lib/stripe/client.ts` を写経):5 個の `R2_*` を fail-fast、presigner/client を export。ただし R2 は credential が 1 組のみ(Clerk/Stripe の prod/test prefix 分岐は不要)→ 「不在で fail-fast」の形だけ踏襲。

**presigned 発行 Server Action の置き場所**: route-group `_actions/` 慣習に従う。既存 = `app/(app)/app/upload/_actions/`、`app/(app)/app/exams/_actions/`、`app/(app)/app/settings/_actions/`。機能は「card 編集中の画像添付」ゆえ card 編集面に属す = **`app/(app)/app/exams/[id]/_actions/`**(現状 `[id]/_actions/` は未存在、`_actions` は `exams/` 直下)。`auth()` gate + user-namespaced object key(全 table `user_id` 必須 = CLAUDE.md Clerk-3)。

---

## 3. next/image remotePatterns の現況

**結論: `next.config.ts` に `images`/`remotePatterns` block 自体が無い。next/image 使用はゼロ。現状アプリは永続/リモート画像を一切描画していない。配信想定は public URL の GET。**

| 項目 | 実態 | 証跡 |
|---|---|---|
| `images`/`remotePatterns` block | 無し(`serverActions.bodySizeLimit` と `headers()` のみ) | `next.config.ts` 全読 + grep 0(HSTS `max-age` の誤検出のみ) |
| R2 ドメイン許可 | 無し(そもそも block が無い) | 上記 |
| `next/image` 使用 | 0 import(`next-env.d.ts:2` の型参照は自動生成) | grep 0 |
| 生 `<img>` 使用 | **1 箇所のみ**: `app/(app)/app/upload/_components/upload-form.tsx:666` — client 側 `URL.createObjectURL` の**ローカル blob サムネ**。`eslint-disable @next/next/no-img-element` + `TODO(波1): next/image 化(loader / remotePatterns + Next 16 default 変更と同時)` @ `:664` | 確定 |
| quality/sizes/deviceSizes | 無し | `images` block 不在 |

**配信の当たり**: `R2_PUBLIC_URL` = `https://pub-xxxx.r2.dev` = **public bucket GET**(署名なし公開 dev URL)が card 画像の配信想定。→ **署名付き GET ではなく public URL 配信**。`remotePatterns` 追加が要るのは **next/image で配信する場合のみ**。既存パターン通り生 `<img src={publicUrl}>` なら `next.config.ts` 変更不要(ただし Next 画像最適化も無し)。`upload-form.tsx:664` の TODO が next/image 採用 = loader + remotePatterns 追加、と明記しており、最適化を選ぶなら一括変更。

---

## 4. card schema の画像記法

**結論: 受け皿 `cards.images`(jsonb `CardImage[]`)は既存・read 配線完了・しかし write 配線と描画は皆無。最小侵襲 = この列を再利用(新列/text-marker を作らない)。ただし tech-spec の inline `![](key)` marker 記法は Markdown renderer 不在で完全未実装 → 記法選択が spec 判断。**

### schema(`lib/db/schema.ts`)
- `cards` 定義 `293-364`。question/choices の保存:
  - `question_text: text('question_text').notNull()` — **plain text**(`:310`)
  - `options: jsonb('options').$type<CardOption[]>()`(`:311`)、`correct_answer_ids: jsonb string[]`(`:312`, `options[].is_correct` から server 再生成の denorm)
  - `explanation_text: text`(`:313`)、`memo: text`(`:315`)
- `CardOption`(`:46-51`)= `{ id, text(Markdown可の想定), is_correct, explanation? }`
- **`images` 列**(`:316-319`)= `jsonb('images').notNull().default('[]'::jsonb).$type<CardImage[]>()`
- **`CardImage` 型**(`:53-59`)— **tech-spec と乖離**(下記):
  ```ts
  export type CardImage = {
    key: string          // R2 object key 相当 / 本文の ![](key) と一致(想定)
    target: string       // ← OCR discover 由来。required
    alt: string          // ← required(spec では alt? optional だった)
    source_ref?: string  // OCR 由来
    url?: string         // ← optional(spec では url required)。R2 配信 URL の枠
  }
  ```
  - tech-spec `docs/02-tech-spec.md:351-355` の設計 = `{ key, url(required), alt? }`。現行型は OCR discover 用に `target`/`source_ref` が増え、`url` は optional・`alt` は required・**`width`/`height` 無し**。→ 手動添付で `target`/`alt` に何を入れるか、描画で intrinsic 寸法(layout shift 回避)が要るなら `width`/`height` を足すか、は spec 判断(jsonb ゆえ optional 追加は migration 不要)。

### write / read の実態
- **write は実質常に `[]`**:
  - `process.ts:376` `images: (c.images ?? []) as CardImage[]`(OCR bulk INSERT。prompt `lib/ai/prompts/ocr-extract.ts:108-154` が「AI は画像本体を切り出せない」と明示 → `[]` か ref-only)
  - `lib/cards/build-new-client-card.ts:43` `images: []`(手動 +card の楽観 insert、hardcode)
  - 列 default `'[]'::jsonb`
  - **`card-field-handlers.ts` に images handler 無し**:`CARD_FIELD_HANDLERS`(`:258-266`)は `title/sort_key/question_text/explanation_text/memo/options/tag_option_ids` のみ。→ **images は現行 outbox `update_field` 経路で編集不可**
- **read/描画は皆無**:`images` を読む UI コンポーネントゼロ(grep で描画無し)。passthrough のみ = `lib/db/cards-mapper.ts:29,67`、`lib/client-db.ts:62-68,82`
- **Markdown renderer 不在(CC 本体検証)**: `react-markdown`/`remark`/`rehype`/`mdx` の dep 無し、使用 0、`dangerouslySetInnerHTML` 0、tech-spec 想定の `CardView.tsx`/`CardEditor.tsx` は不在 → **`![](key)` 記法 → url 解決の実装はゼロから**。

### 編集面(テーブル inline / side peek)コンポーネント地図(`app/(app)/app/exams/[id]/_components/`)
| 関心 | file |
|---|---|
| 縦 list(詳細 page、各 card row) | `inline-card-list.tsx`(`InlineCardList`) |
| **side peek**(radix Dialog、右スライド) | `exam-card-side-peek.tsx:43`(`ExamCardSidePeek`) |
| **共有フィールド block**(tags+question+options+explanation+memo) | `card-editor-fields.tsx:42`(`CardEditorFields`) — list と side-peek 両方が使う |
| 単一テキストセル(enter/commit) | `inline-text-field.tsx:68`(`InlineTextField`) |
| options 編集 | `inline-option-row.tsx`(`InlineOptionList`) |
| TanStack table(列/pinning/collapse) | `exam-card-table.tsx` / `exam-card-table-columns.tsx` |

**編集 commit 経路**(`inline-text-field.tsx:183-211`): blur → `runOptimisticUpdate` が 1 Dexie rw-tx で (1) mirror `cards.update(cardId,{[field]:value})` + (2) outbox enqueue `{entity_type:'card', op:'update_field', patch:{field,value}}` → 500ms debounce `runGuardedEntityMutationFlush()` → server `CARD_FIELD_HANDLERS[field]`(owner-scoped `UPDATE … WHERE id=? AND user_id=?`)。field 追加 = handler map 1 entry + zod 1 本(`card-field-handlers.ts:16` コメントが明言)。

**最も自然な差し込み点 = `card-editor-fields.tsx:42-114`**(list と side-peek が共有する唯一の block)。ここに「添付」affordance + 画像描画を足せば両面に自動反映。ただし両 caller(side-peek `:133-143` / list `:301-312`)は現状 `questionText/options/explanationText/memo` を渡すが **`images` は渡していない** → `CardEditorFieldsProps` に `images` を追加し両 call site を通す必要。

### local-first 配線
- **Dexie mirror は images を完全に保持**:`ClientCard.images: ClientCardImage[]`(`client-db.ts:82`)、`ClientCardImage`(`:62-68`)は server `CardImage` と同形。`cards` store は index 対象外の値列で正しい。
- **read 配線は完了**:server→client は `toClientCard`(`cards-pull.ts` → `cards-mapper.ts:29` `images: row.images`)→ `db.cards.bulkPut`。client→server 読み戻しは `toCard`(`cards-mapper.ts:67`)。
- **write 配線が欠落**:`lib/sync/shared/mutation-schemas.ts` の `cardUpdateFieldPatchSchema`(`:49-52`)は generic `{field, value:unknown}` ゆえ envelope は通るが server 側 handler 不在で reject。`cardCreatePatchSchema`(`:56-64`)は images を含まない(create 時は `[]`)。

### 最小侵襲な当たり
**既存 `cards.images` jsonb を再利用**(新列も text-marker も作らない)。列・`CardImage` 型・`ClientCardImage` mirror・pull/読み戻し mapper が既に images を無償で運ぶ。`CardImage.url` が R2 参照枠、`key` に R2 object key。最小変更:
1. `lib/validation/card.ts` に `imagesSchema`(`z.array(CardImage)`)追加(現状 images は無検証)
2. `card-field-handlers.ts` に `handleImages` 1 entry(配列全置換、`handleOptions` に倣う)
3. `card-editor-fields.tsx` に描画 + 添付 affordance + 両 caller に `images` prop 追加(既存 `update_field` outbox で commit — envelope は generic ゆえ既に通る)
4. (任意)create 時添付が要れば `cardCreatePatchSchema` に images 追加。不要なら `[]` 開始 → 後続 `update_field` で足す
**記法の判断(spec)**: (A) tech-spec の inline `![](key)` marker + Markdown 描画 = renderer + key→url 解決を新規実装(dep or 自前 parser、Anki 流 Check Media 整合チェック `docs/02-tech-spec.md:394-398` 込)で**重い**。(B) marker を使わず images 配列を card 下に gallery 描画 = **軽い**(位置指定なし)。MVP は (B) が最小。

---

## 5. Gemini bbox 可否(② 後続・優先度低)

**結論: maybe(API 的に可能だが本用途で未実証)。① を一切ブロックしない別論点。tech-spec §13.4 で既に v1.x・PoC ゲート済。**

- 現行 OCR(実コード): model `gemini-2.5-flash` のみ(`lib/ai/cost.ts:38-40` / `lib/ai/ocr.ts:178` が `['flash']` 固定)。入力は inline base64(`lib/ai/clients/gemini.ts:96-101`)。structured output を強制 = `responseMimeType:'application/json'` + `responseJsonSchema`(`gemini.ts:111-116`、`lib/ai/schemas/ocr-response.ts:45-114` が構築)+ runtime zod 再検証(`ocr.ts:32-58,149-164`)。
- 出力 schema(card 毎): `title / sort_key? / question_text / options[] / correct_answer_ids[] / explanation_text? / images[](key,target,alt,source_ref?) / custom_props?`。**bbox/座標フィールドは皆無**。prompt が「画像本体は解釈/切り出し不可」と明示(`lib/ai/prompts/ocr-extract.ts:104-155`)。
- bbox 判定: Gemini 2.5 Flash は bbox 返却可能(prompt 駆動で `box_2d` = `[ymin,xmin,ymax,xmax]` を **0–1000 正規化**)。既存 `responseJsonSchema` 経路にフィールド追加で載る(@google/genai `^1.50.1` 対応済、SDK 変更不要)。ただし **一般物体でなく任意の図表領域**での信頼度は要実測。
- fallback(1 行): 不安定なら自動切り抜きを捨て、full-image 添付 or 手動切り抜き(現行「AI は切り出さない」姿勢と一致)。
- **分離**: upload/storage 経路と独立の OCR schema/prompt 拡張ゆえ、① と完全に切り離せる。

---

## 6. Vercel 4.5MB body 天井の各層現況

**結論: 天井の正本 = Vercel platform の request-body hard limit 4.5MB(config で緩和不可)。ブラウザ→R2 直 PUT は画像バイトを Vercel Function に一切通さないため (c)(d) と OCR action の inbound-body を bypass。残るのは tiny JSON(presign 発行 + confirm)のみ。**

> 注: 現行の 4.5MB 経路は **OCR 一括 upload**(`upload-form` → `process.ts`、別機能)。card 画像添付(① の対象)は現状**経路自体が未存在**ゆえ、最初から presigned 直アップで組めば構造的に天井を回避する(既存経路の改修ではない)。

**client 側**(`app/(app)/app/upload/_lib/constants.ts`):`MAX_IMAGE_FILE_MB=0.5`(圧縮目標 `:12`)、`MAX_IMAGE_WIDTH_OR_HEIGHT=2048`(`:13`)、`TOTAL_UPLOAD_LIMIT_MB=4`(client cap `:18`、Vercel 4.5MB に margin で整合)、`MB=1_000_000`(十進 `:25`)、`MAX_PDF_PAGES=40`(`:22`)。`browser-image-compression ^2.0.2`(`package.json:32`)使用(`upload-form.tsx:245-249` `{maxSizeMB:0.5, maxWidthOrHeight:2048, useWebWorker:true}`)。submit は `totalBytes>TOTAL_UPLOAD_LIMIT_BYTES` で block(`upload-form.tsx:208`)。`upload-guard.ts` は server DB tx(advisory lock/quota/INSERT)で **byte 検証はしない**(totalSize は metadata)。

**server 側**: `next.config.ts:51` `serverActions.bodySizeLimit:'4.5mb'`(コメント `:40-50`:Next16 default 1MB → framework 層 413 誤誘導回避のため Vercel platform 上限と同値へ開放、正本は app-level)。server 強制の正本 = `process.ts:203-209` `totalSize>TOTAL_UPLOAD_LIMIT_BYTES(4,000,000)` → `SIZE_LIMIT_EXCEEDED`。**API Route Handler は 8 本あるが file upload 用は 0**(全て JSON sync/webhook、`bodySizeLimit` 未設定)。**重要: `serverActions.bodySizeLimit` は Server Action 専用で Route Handler に効かない** — Route Handler は Next framework の body cap 無し(body を stream)、上限は Vercel platform のみ。

### 各層テーブル
| 層 | 現上限 | 出所 | presigned 直PUT で bypass? | 備考 |
|---|---|---|---|---|
| (a) client 圧縮+guard | 0.5MB/枚, 2048px, 合計>4MB で submit block | `constants.ts:12-13` / `upload-form.tsx:208,245-249` | **No**(client 側で走る) | transport 非依存。ただし bytes が R2 行きなら cap 緩和可 |
| (b) client cap 定数 | 4MB(`TOTAL_UPLOAD_LIMIT_MB`) | `constants.ts:18,26` | **No**(client 値) | Vercel 4.5 合わせの任意値。bytes が Vercel を通らなくなれば据置理由が消える |
| (c) Next server-action `bodySizeLimit` | 4.5MB | `next.config.ts:51` | **Yes**(file bytes について) | action multipart に bytes が載る時のみ効く |
| (d) Vercel platform request-body hard limit | 4.5MB(config 緩和不可) | platform(`constants.ts:5-6` コメント、超過で `FUNCTION_PAYLOAD_TOO_LARGE`) | **Yes**(file bytes) | 物理天井。ブラウザ→R2 PUT は Function に届かず bytes が丸ごと回避 |
| (e) OCR Server Action(`processUpload`)の inbound-body | 4MB app 強制 + (c)(d) | `process.ts:203-209,281-287` | **部分** | presigned 化なら action は R2 key(tiny JSON)受領 → server 側で R2 から fetch(egress であり body-limit ではない) |
| (f) 新規 presign 発行 request | (c)/(d) のみ・数 KB | 未存在(新規) | N/A(新規・自明に上限下) | `{filename,contentType,size}` JSON のみ |
| (g) 新規 confirm-write request | (c)/(d) のみ・数 KB | 未存在(新規) | N/A(新規・自明に上限下) | `CardImage` metadata JSON のみ |

**bypass 判定**: ブラウザ→R2 直 PUT で **(d) 4.5MB platform・(c) server-action bodySizeLimit・(e) OCR action の bytes 経路**を回避(画像バイトが Vercel Function を通らない)。**残る**のは (f) presign 発行 + (g) confirm(いずれも Vercel 経由だが tiny JSON、4.5MB から大きく下)、(a) client 圧縮・(b) client cap(client 側・transport 非依存)。**R2 単一オブジェクト/PUT 上限は repo から UNKNOWN** — 実装前に Cloudflare docs で要確認。

---

## 7. spec 前に潰す決定点(open questions・実装調査でなく設計判断)

1. **新 dep 承認**: `aws4fetch`(軽量・repo の no-AWS-SDK 姿勢に合致)vs `@aws-sdk/client-s3`+`s3-request-presigner`。CLAUDE.md「新ライブラリ事前相談」→ OT 判断。
2. **配信方式**: public URL 生 `<img>`(config 変更不要・最適化なし・既存パターン)vs `next/image`+`remotePatterns` 追加(最適化あり・`upload-form.tsx:664` TODO を同時消化)。
3. **`CardImage` 型整合**: 現行 `target`/`alt` が required(OCR 由来)・`url` optional・`width`/`height` 無し。手動添付での `target`/`alt` の埋め方、layout shift 回避の寸法保持要否。jsonb ゆえ optional 追加は migration 不要。
4. **記法**: inline `![](key)` marker + Markdown 描画(renderer/parser 新規・重い・Check Media 整合込)vs images 配列の gallery 描画(位置指定なし・軽い)。MVP は後者が最小。
5. **presigned 発行の実装形**: Server Action(`exams/[id]/_actions/`)vs Route Handler。Route Handler は body-limit 上有利だが、発行 request は tiny ゆえ差は小。既存 `_actions/` 慣習に倣うなら Server Action。
6. **object key 設計 + 削除整合**: `users/{user_id}/cards/{card_id}/{uuid}.{ext}`(tech-spec `:1215`)。card/account 削除時の R2 orphan 掃除は現状ゼロ(tech-spec `:1097-1099,1215` に設計のみ)→ MVP scope に含めるか。
7. **bucket CORS(外部 ops 前提)**: ブラウザ直 PUT の hard prerequisite。Cloudflare dashboard/API で `PUT`+preflight を app origin 許可。コード外・OT/ops 手順。
8. **R2 単一オブジェクト上限**: repo から UNKNOWN。client cap 緩和の設計前に Cloudflare docs で確認。
9. **client 圧縮 policy(④)**: 添付画像に `browser-image-compression` を流用するか(既存 dep)。

---

## 8. 判定

- **① 画像添付 + presigned 直アップロード = spec(brainstorming)へ進める。** 追加のコード fact-finding は不要。未知は全て「設計判断」(§7)であり「実装調査」ではない。storage=greenfield だが経路確定、data model 受け皿は既存で read 配線完了、UI 差し込み点 (`card-editor-fields.tsx:42`) 特定、body 天井 bypass は構造的に成立。spec は tech-spec の既存設計(`docs/02-tech-spec.md` Logic 2 / §8 API / §2.5.3 schema)を土台に、§7 の判断を確定させる作業になる。
- **②③④ = ① から分離可能(§0 参照)。** MVP = ①(手動添付 + presigned + gallery 描画)。② bbox は v1.x/PoC ゲート済で無関係。③ D&D は同一差し込み点への UX 増分。④ 圧縮は既存 dep 流用の policy。

---

## 参照
- 先行: `docs/superpowers/sessions/2026-05-20-r2-scrub-and-counter-schema-investigation.md`
- 設計正本: `docs/02-tech-spec.md`(§1 アーキ `:14,26,40,56-57` / schema+型 `:293-356,380-398` / Logic 2 画像添付 `:884-888,1209-1218` / next/image TODO の対 `:1007-1008` / 削除時 R2 掃除 `:1097-1099,1215` / bbox v1.x §13.4 `:1465` / env `:1402-1406` / CORS+presigned ops `:1446`)
- 実コード主要: `lib/db/schema.ts`(cards `:293-364` / `CardImage` `:53-59` / images 列 `:316-319`)、`lib/validation/card.ts`(images 無検証)、`lib/cards/card-field-handlers.ts`(`:258-266` handler map)、`lib/sync/shared/mutation-schemas.ts`(`:49-64`)、`lib/client-db.ts`(`:62-68,82`)、`lib/db/cards-mapper.ts`(`:29,67`)、`app/(app)/app/exams/[id]/_components/`(`card-editor-fields.tsx:42` / `exam-card-side-peek.tsx:43` / `inline-text-field.tsx:183-211` / `inline-card-list.tsx`)、`app/(app)/app/upload/_actions/process.ts`(`:203-209,281-287,376`)、`app/(app)/app/upload/_lib/constants.ts`、`app/(app)/app/upload/_components/upload-form.tsx`(`:208,245-249,664-666`)、`next.config.ts`(`:40-51`)、`lib/ai/clients/gemini.ts`(`:96-116`) / `lib/ai/schemas/ocr-response.ts` / `lib/ai/prompts/ocr-extract.ts`、`lib/clerk/env-check.ts` / `lib/stripe/client.ts`(env-check pattern)、`.env.example:73-79`
