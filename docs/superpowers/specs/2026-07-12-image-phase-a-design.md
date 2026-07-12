# 画像フェーズ A(画像基盤)design spec (2026-07-12)

> 編集面に画像を添付できる基盤。画像バイトは Vercel を通さず非公開 R2 へ presigned 直 PUT
> (4.5MB 天井を構造回避)。リッチテキスト UI(B1)・表(B2)は後続フェーズで本 spec 外。
>
> - fact-finding(確定・再調査不要):
>   `docs/superpowers/sessions/2026-07-11-image-attachment-r2-presigned-factfinding.md` /
>   `docs/superpowers/sessions/2026-07-11-image-phase-a-additional-factfinding.md`
> - OT 確定判断 13 点(kickoff 2026-07-12)を前提固定。本 spec はその上で残 6 論点を確定する。
> - spec 凍結: 実装フェーズで本 file を書き換えない(仕様変更が要るなら停止して OT 相談)。

---

## 0. 前提固定(OT 確定・再議論しない)

1. 非公開 R2 + presigned PUT。card は **assetId(名札)のみ参照、URL は保存しない**(署名 URL の DB 保存禁止)。表示 URL は read 時解決。
2. 受け皿 = 既存 `cards.images` jsonb 再利用(read 配線済・write/描画未実装)。
3. upload = **reservation → 直 PUT → finalize の saga**。partial success は Sprint 1/2 decouple 原則(DB 先行・外部 best-effort・後で end-state 保証)の再適用。ローカル card write 即完了(optimistic)、**server 反映のみ asset ready を待つ**。
4. card sync と media transfer 分離(Anki 方式)。blob は entity_mutations に載せず専用 guarded loop。
5. blob = Cache API 保存、**cache key は userId で名前空間分離**。Dexie asset 状態も userId scope。
6. ローカルは消えうるキャッシュ・R2 が真実源(消えたら再取得)。
7. dedup は**同一ユーザー内のみ**(横断 dedup は永久にやらない)。MVP scope は論点 2 で確定。
8. 自動圧縮 = 既存 browser-image-compression 2.0.2(長辺 N px + WebP + 品質 + alpha + EXIF + worker)。
9. **Safari は WebP encode 不可 → silent PNG(仕様)** → 出力 MIME はデータ駆動(asset メタに実 MIME 記録、参照は assetId のみ)。WASM encoder / server transcode は入れない。
10. 受付 = **jpg / jpeg / png / webp のみ**。decode 不能は明示エラー。HEIC は iPhone 実機 smoke(plan 確認事項)。
11. デッキ一括 DL = all-or-nothing・差分 DL(キャッシュ済 skip)・失敗時は当該ジョブ追加分のみ破棄・再開なし。ジョブ状態 = Dexie 新 store。
12. InstallPrompt + `navigator.storage.persist()` を含める。SW(オフライン起動)は本フェーズ外。
13. 新 dep = **aws4fetch**(de-risk gate: install/tsc/build → revert → 専用 chore commit)。aws-sdk 不採用。

---

## 1. 全体像

```
[添付(編集面)]                                [表示]
 file picker → 圧縮(worker) → ①reserve ─┐      getAssetObjectURL(userId, assetId)
                                  ↓ assetId ├─ server: assets 台帳(reserved→ready)
 Cache put + mirror write + outbox enqueue │      ↓ Cache hit → objectURL
                                  ↓         │      ↓ miss → ②resolve(presigned GET)
 ③browser → R2 直 PUT(presigned)  ────────┘         → fetch → Cache put → objectURL
                                  ↓
 ④finalize(HEAD 検証 → ready) → flush trigger
                                  ↓
 outbox flush(gate: 参照 asset 全 ready の images mutation のみ送信)
                                  ↓
 server images handler(zod + ready-asset 存在検証)→ cards.images 確定
```

チャネル分離: **card sync(既存 entity_mutations、assetId 文字列のみ運ぶ)** と
**media チャネル(新規: upload saga / resolve+fetch / 一括 DL / 起動時 sweep。専用 guarded loop)**。

---

## 2. データモデル

### 2.1 server: `assets` テーブル(新規、migration 0023)

独立テーブル(論点 5 確定)。cards.images 内包にしない理由: reservation 時点で card 未確定・
(user_id, hash) dedup lookup・reserved→ready 状態遷移が card row と独立のため。

```
assets:
  id           uuid PK defaultRandom     -- = assetId
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE  -- 既存 FK パターン踏襲
  object_key   text NOT NULL UNIQUE      -- 'users/{user_id}/{assetId}.{webp|png}'
  mime         text NOT NULL             -- 'image/webp' | 'image/png'(実 MIME・データ駆動)
  byte_size    integer NOT NULL
  width        integer NOT NULL
  height       integer NOT NULL          -- 表示時 layout shift 回避用(client 計測値)
  hash         text NOT NULL             -- SHA-256 hex(圧縮後 bytes。dedup 用・論点 2)
  status       text NOT NULL DEFAULT 'reserved'   -- 'reserved' | 'ready'
  created_at   timestamptz NOT NULL DEFAULT now()
  ready_at     timestamptz
  -- 将来 orphan 掃除用の枠(MVP ではアプリは一切更新しない・手動 SQL 用):
  reference_count   integer NOT NULL DEFAULT 0
  unreferenced_at   timestamptz
index: (user_id, hash) / (user_id, status)
```

- **pull 同期非対象**(学習データでない)。client 側状態は Dexie `media_assets`(2.3)が別途持つ。
- user 削除: cascade で台帳は消える。R2 object は `users/{user_id}/` prefix で手動削除可能
  (object_key の user prefix がこのための担保)。自動掃除はしない(scope 外)。

### 2.2 `cards.images` への格納形式(論点 1 確定)

既存 `CardImage {key, target, alt, source_ref?, url?}`(`lib/db/schema.ts:53-59`)を**型変更ゼロ**で使う:

| field | 手動添付での値 |
|---|---|
| `key` | **assetId(UUIDv4・server 発行)** |
| `target` | 添付先: `'question_text'` \| `'option:{optionId}'` |
| `alt` | `''` 固定(alt 編集は B1) |
| `source_ref` | 未使用(書かない) |
| `url` | **書かない(禁止)**。server handler は url 非空 entry を reject(URL 保存禁止の恒久防衛) |

**判別 invariant**: `key` が UUIDv4 形式 = asset 参照(server 検証対象・描画対象)。
非 UUID key = 既存 OCR 由来の参照メモ(`ExtractedImage`、`ocr-response.ts:21-26`)= passthrough
許容・非描画。これにより OCR 取込済 card の images 編集が legacy entry で reject されない。

### 2.3 client: Dexie version(8)(純粋 store 追加・既存 v2/v4/v5 前例踏襲)

```
media_assets:        'id, user_id, [user_id+hash], status'
  値: { id(=assetId), user_id, status: 'uploading'|'ready'|'failed',
        mime, byte_size, width, height, hash, created_at }
media_download_jobs: '[user_id+exam_id], user_id, status'
  値: { exam_id, user_id, status: 'downloading'|'done',
        total, done_count, added_asset_ids: string[], started_at }
```

### 2.4 Cache API

- cache 名: `recallmint-media`(単一)。
- key: 合成 URL `{origin}/__media/{userId}/{assetId}`(userId 名前空間 = 前提 5。実 fetch には使わない)。
- window context で `caches.open`(SW 不要 — fact-finding 確認済)。消失時は 6. の miss 経路で再取得。

---

## 3. 書き込み経路(saga と invariant — 本 spec の核)

### 3.1 正常系シーケンス

1. **client 検証**: `file.type` ∈ {image/jpeg, image/png, image/webp}(+ 拡張子 jpg/jpeg/png/webp)。
   それ以外は即・明示エラー(silent 破壊禁止 = 前提 10)。
2. **圧縮**(worker): `imageCompression(file, { maxWidthOrHeight: 1600, fileType: 'image/webp',
   initialQuality: 0.8, maxSizeMB: 1, useWebWorker: true })`(値は論点 3 確定)。
   decode 失敗 → 明示エラー(reject 値は非 Error の Event でありうる — 既存 guard パターン踏襲)。
   出力 `blob.type` を**実 MIME として採用**(Safari = image/png。前提 9)。SHA-256 hash と
   width/height を client で算出。
3. **① reserve**(Server Action): 入力 `{mime, byte_size, width, height, hash}`。
   検証: `auth()` / mime ∈ 2 値 / byte_size ≤ 5MB(hard cap)。`assets` INSERT(reserved)→
   `{assetId, uploadUrl}` 返却。uploadUrl = presigned PUT(TTL 10 分・**Content-Type を署名に固定**)。
   offline / 失敗 → 明示エラーで終了(何も書かれない。**添付はオンライン限定**)。
4. **client 楽観層**(reserve 成功後): Cache put + `media_assets` put(status 'uploading')+
   mirror `cards.images` 更新 + outbox enqueue — mirror+enqueue は既存 `runOptimisticUpdate`
   (field='images'・配列全置換)をそのまま使う。**UI はこの時点で表示される**(前提 3)。
5. **③ PUT**(browser → R2 直)。
6. **④ finalize**(Server Action): owner 確認 → **R2 HEAD で実在 + byte_size 一致検証**
   (aws4fetch)→ status 'ready' + ready_at。client: `media_assets` を 'ready' 化 + flush trigger。

### 3.2 flush gate(client・順序保証の要)

`flushAllPendingEntityMutations` の targets filter 段(`lib/sync/entity-mutations.ts:234` の
in-flight 除外と同じ場所)に 1 条件追加:

> **card / update_field / field='images' の mutation は、patch value 内に「local `media_assets` で
> status='uploading' の UUID key」を 1 つでも含む間は送信対象から除外(pending 残置)。**

- **local に行が無い UUID key は block しない**: pull 由来(別 device で添付済)の key は
  local `media_assets` に存在しないが、server 側で ready 済みが保証されている(server invariant が
  ready でない参照の混入を防いでいるため)。local 行の有無でなく **'uploading' の有無**が gate 条件。
- 'failed' 行の key は sweep / 放棄処理が mirror から entry を除去し coalesce で消える(3.4)。
  除去前に送信された場合も server handler が reject し pending 残置 → 最終的に自己修復(end-state 保証)。
- 非 images mutation への影響ゼロ。coalesce(同 card 同 field 1 mutation 統合)は既存挙動のまま
  — gate は常に最新 value を見る。
- finalize 成功('uploading' → 'ready')→ flush trigger で自然に流れる。

### 3.3 server images handler(最終防衛)

`CARD_FIELD_HANDLERS` に `images` を 1 entry 追加(既存パターン: handler map + zod 1 本)+
`lib/validation/card.ts` に `imagesSchema` 追加:

- zod: 配列 ≤ 10 entry / 各 entry `{key: string, target: string, alt: string}` 形状 /
  **url 非空 entry は reject** / target は `'question_text' | 'option:...'` 形式(legacy entry は
  この限りでない — UUID key entry のみ形式強制)。
- **invariant: UUID 形式の key は全て「自 user の assets で status='ready'」に実在すること**。
  違反 = 当該 mutation fail(既存 failed 分類 → pending 残置・再試行)。
- 非 UUID key(legacy OCR entry)は passthrough(2.2 の判別 invariant)。

**順序 invariant 総括: server 上の cards.images が参照する assetId は常に ready
(gate が送信前提を作り、handler が最終防衛)。local は先行表示して良い。**

### 3.4 失敗 path と end-state 保証(decouple 原則の適用 — 新 invariant を発明しない)

| 失敗点 | end-state |
|---|---|
| client 検証 / 圧縮 / decode 失敗 | 明示エラー。何も書かれない |
| reserve 失敗(offline 含む) | 明示エラー。何も書かれない |
| PUT / finalize 失敗 | UI エラー + retry 可(PUT からやり直し。presign 期限切れは re-reserve)。**放棄時**: mirror から entry 除去(→ coalesce で最終値が server へ)+ Cache / media_assets 掃除。server の 'reserved' 残骸 = 無害な orphan 予約(手動掃除対象) |
| tab close(uploading 中断) | **起動時 sweep**(media loop): stale 'uploading'(1 時間超)を 'failed' 化 + mirror images から該当 entry 除去 + 修正 mutation enqueue = 自己修復 |
| finalize 済 × card write 恒久失敗 | mutation は既存 failed 分類に従い pending 残置・再試行。asset は ready 孤児(手動掃除・無害) |
| 画像削除(card から) | images 配列から entry 除去のみ(通常の update_field)。**asset / R2 object は残置**(掃除は scope 外・手動 SQL) |

### 3.5 dedup(論点 2 確定)

**MVP = hash 記録のみ**(reserve で hash を assets に保存 + (user_id, hash) index)。
**R2 object 再利用 branch は後続 sprint**(reservation 時の 1 分岐として additive に追加可能)。
理由: 新規 saga の検証面を 1 経路に保つ / storage 実害なし(無料枠・個人利用規模)/
schema・index 準備済みゆえ後続コストは最小。横断 dedup は前提 7 により永久に不可。

---

## 4. 圧縮・受付(論点 3・4 確定)

- **長辺 1600px / initialQuality 0.8 / maxSizeMB 1(MiB・best-effort)**。
  根拠: mobile 3x 実効幅(~1300px)を上回り側 peek/編集面表示に十分・スクショ文字可読・
  WebP q0.8 で数百 KB 目標に整合・Safari PNG fallback の膨張も maxSizeMB の PNG quantize 経路で
  bound される。※ maxSizeMB は MiB 単位(repo の十進 MB 定数と混同しない — fact-finding 済)。
- server 側 hard cap: reserve の byte_size ≤ 5MB(圧縮バイパスした不正 client への上限)+
  finalize HEAD の size 一致検証。
- **MIME 実バイト検証は不要**(論点 4 確定)。根拠: 受付 4 形式は全て canvas decode→再エンコードを
  通る(passthrough 経路ゼロ)= decode が門番・出力は自己生成 blob。server は宣言 MIME を
  2 値に制限し presign Content-Type に固定。実バイト sniff は将来 passthrough 形式(SVG 等)を
  導入する時点で再判断。
- worker の `libURL` は既定(jsDelivr CDN)のまま(現 CSP は script-src 未制限)。CSP 強化時に
  self-host 化(既知事項として記録のみ)。

---

## 5. 表示(論点 6 確定 — B1 前の暫定表示の線引き)

- **形式: target 単位の gallery**(question 下 / 該当 option 下に添付順で並べる)。
  inline 位置指定(`![](key)` marker)・リッチ編集・alt 編集は B1。
- **面**: `card-editor-fields.tsx`(共有 block — テーブル inline 編集・side peek・縦カードリストを
  1 箇所でカバー)に gallery + 添付 affordance(target ごとの file picker)+ 削除。
  **学習ビューは read-only gallery のみ**差し込み(一括 DL の実効性の前提。component 特定は plan)。
- 描画: 生 `<img>` + `getAssetObjectURL()` の objectURL(width/height 属性は media_assets 値)。
  next/image 不使用(objectURL ゆえ optimization 対象外。remotePatterns 変更なし)。
- 署名 URL を `<img src>` / DB / Dexie に置かない(objectURL のみ)— 前提 1 の恒久防衛。
- 添付 UI は file picker のみ。**paste / D&D は scope 外**(B1 以降。スクショは保存→picker で可)。

## 6. media チャネル(取得側)

- **resolve**(Server Action): `assetIds[](≤50/回)` → `[{assetId, url(presigned GET・TTL 10 分), mime}]`。
  owner scope(自 user の ready asset のみ)。
- **getAssetObjectURL(userId, assetId)**: Cache hit → objectURL / miss → resolve → fetch → Cache put
  → objectURL。fetch 失敗 = placeholder 表示(壊れアイコン + retry)。
- **一括 DL**(デッキ単位・前提 11): mirror の exam 配下 cards から UUID key 集合 →
  Cache miss 分のみ列挙 → guarded loop(Web Lock + in-flight。既存 3 例の踏襲)で
  resolve(batch)→ fetch → Cache put。job row(`media_download_jobs`)で進捗(done_count/total)。
  **全件成功 → 'done' / 1 件でも失敗 → 当該 job の added_asset_ids のみ Cache から削除 + job row 削除
  (既存キャッシュ不巻込・再開なし)**。UI に「完了までタブを閉じないでください」明記。
- **起動時 sweep**: 3.4 の stale 'uploading' 自己修復 + 中断 job('downloading' 残骸)の added 分
  掃除を同じ loop の起動時に実行。

## 7. InstallPrompt + persist()(前提 12)

- 一括 DL 開始時に `navigator.storage.persist()` を要求(未許可でも DL は続行)。
- iOS Safari 未 install(非 standalone)での一括 DL 開始時に InstallPrompt(ホーム画面追加の案内 —
  ITP 7 日消去の免除条件)を表示。**警告付きで続行は許可**(all-or-nothing の耐久は install が前提と明記)。
- `components/pwa/` 新設(tech-spec §9.1 想定位置)。beforeinstallprompt(Chromium)+ iOS 手順案内。
- **注意(tech-spec 齟齬の明記)**: tech-spec §9.1 の `[x] Service Worker 登録` 等の checkbox は
  scope 宣言であり**実装済ではない**(SW コードは現状ゼロ)。本フェーズも SW を実装しない。

## 8. 新 dep・env・ops 前提

- **aws4fetch**(server 専用・client bundle に入れない)。導入は de-risk gate:
  install → tsc → build 確認 → revert → 専用 chore commit(前提 13)。
- `lib/storage/r2.ts` 新設: `R2_*` 5 変数 fail-fast(`lib/stripe/client.ts` の形を踏襲、
  prod/test prefix 分岐は R2 に無いため不在チェックのみ)+ presign helper(PUT/GET/HEAD)。
  S3 endpoint = `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`。
- env: 既存宣言済み `R2_*` を実配線(参照コードと同 commit で `.env.example` 整合確認)。
  **`R2_PUBLIC_URL` は本 spec では未使用**(非公開 bucket + presigned GET のため)。
- **ops 前提(コード外・OT 手順、実装 gate と分離・stg smoke の前提条件)**:
  1. R2 bucket CORS: app origin から **PUT と GET の両方**(+ preflight)許可(PUT=upload、GET=表示 fetch)。
  2. R2 単一オブジェクト上限 / 無料枠の確認(圧縮上限の裏取り材料)。
  3. custom domain 接続 — **要 OT 確認の flag**: presigned URL は S3 endpoint でのみ有効なため、
     非公開 bucket + presigned GET 構成では**表示にも custom domain は不要の可能性**。
     公開配信経路を将来残す場合のみ必要。MVP の表示経路は presigned GET(S3 endpoint)を正とする。

## 9. スコープ外(将来 additive 性の担保)

B1 リッチテキスト / B2 表 / paste・D&D / SW・オフライン起動(将来独立スプリント)/
ゴミ画像自動掃除(列だけ確保・手動 SQL)/ 凝った圧縮・サムネ・配信時変換 /
横断 dedup(**永久に不可**)/ dedup 再利用 branch(後続 sprint・3.5)/ OCR bbox(v1.x)。
いずれも本 spec の schema(assets 台帳・CardImage 判別 invariant・media チャネル)に additive に足せる。

## 10. 検証方針

- **unit を正とする**(失敗経路): 圧縮失敗(非 Error reject 含む)/ reserve・PUT・finalize 失敗と
  end-state / Safari PNG fallback(blob.type='image/png' 経路)/ flush gate('uploading' 含み残置・
  ready 後送信・**local 未知 key 素通し(pull 由来)**・非 images 素通し)/
  server handler invariant(非 ready 参照 reject・url 非空 reject・legacy passthrough)/
  起動 sweep / 一括 DL の all-or-nothing(added のみ破棄)。R2・aws4fetch・Cache API は mock(実 API 禁止)。
- **stg smoke(DevTools MCP)**: 正常経路(添付 → 即時表示 → reload 後表示 → server 反映確認)+
  一括 DL 正常 + placeholder 経路。
- **OT 実機のみ**: iPhone HEIC 実挙動(Photos 経由 JPEG 自動変換の真偽 — 非公式情報のため)+
  Safari 実機の PNG fallback 確認。
- 完了 gate: whole-repo lint 0 / 依存追加 sprint ゆえ `pnpm install --frozen-lockfile` +
  `pnpm typecheck` + `pnpm build` 全 exit 0(CLAUDE.md 恒久規律)。

---

## 11. 論点の確定一覧(kickoff 6 論点への回答)

| # | 論点 | 確定 | 根拠 1 行 |
|---|---|---|---|
| 1 | cards.images 格納形式 | 既存 CardImage 型変更ゼロ・key=assetId(UUID)・UUID/非 UUID で asset 参照と legacy OCR 参照を判別 | 型・mirror・mapper 全部無償再利用 + OCR 既存 entry と非破壊共存(§2.2) |
| 2 | dedup MVP 範囲 | hash 記録 + index のみ。再利用 branch は後続 | saga 検証面を 1 経路に保つ・後続は additive 1 分岐(§3.5) |
| 3 | 圧縮上限 | 長辺 1600px / q0.8 / maxSizeMB 1(MiB) | mobile 3x 十分 + 数百 KB 整合 + PNG fallback も bound(§4) |
| 4 | MIME 実バイト検証 | 不要 | passthrough 経路ゼロ = decode が門番・出力は自己生成(§4) |
| 5 | asset server schema | 独立 `assets` テーブル(migration 0023)・orphan 用列は確保のみ | card 非依存の状態遷移 + dedup lookup + user prefix key(§2.1) |
| 6 | 暫定表示の線引き | target 単位 gallery を card-editor-fields + 学習ビュー(read-only)に。picker のみ・inline 記法なし | 基盤検証に必要な最小 + 一括 DL の実効性(§5) |

## 12. OT 確認事項(spec 承認時に併せて)

1. **custom domain の要否**(§8 flag): presigned GET 構成では表示にも不要の可能性。ops 前提から
   外すか、将来公開配信用に保持するか。
2. **学習ビューの read-only gallery を Phase A に含める判断**(§5): 一括 DL の実効性から含める前提で
   起草した。外す場合は §5 から 1 項削除(DL は「先行キャッシュ」機能に格下げ)。
3. dedup 再利用 branch を後続に送る判断(§3.5)の追認。
