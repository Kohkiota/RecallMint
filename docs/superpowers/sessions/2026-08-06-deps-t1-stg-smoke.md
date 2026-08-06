# deps 基線更新 T1 — stg smoke(2026-08-06)

対象 = `98e2182..3920cb0`(lockfile-only の high 7 件解消 + allowlist 受容撤去 + 台帳)。
実装・review の記録は `docs/audit/dependency-audit-ledger.md`「解消済(2026-08-06 deps 基線更新 T1)」。

## §0 pre-flight

| 項目 | 結果 |
|---|---|
| push | **一致**。`origin/develop` = local HEAD = `3920cb0`(ahead/behind 0/0) |
| stg deployment | `dpl_CPs7gETBY9AgUpYmV1KBV7JQkGwh`(静的 asset の `?dpl=` から取得) |
| deploy SHA 照合 | **CC からは不可**(下記) |
| `/app/upload` maxDuration | repo HEAD で `app/(app)/app/upload/page.tsx:23` = `export const maxDuration = 720`。drift pin test あり(`_actions/submit-upload.test.ts`) |
| DB 同一性 | `DATABASE_URL_APP`(`recallmint_app` role)で対象 doc が引けた = smoke 先と同一 DB を実証 |

### deploy SHA を CC が照合できない理由(恒久的な制約)

Vercel は commit SHA を header / HTML に出さない(過去 session `2026-07-14-image-gc-v2-normalized-refs-completion.md` にも同結論)。通常は
**新コードの構造的 fingerprint**(新 route・新 telemetry key 等)で代替するが、**T1 は source を 1 行も変えない lockfile-only 変更ゆえ fingerprint が原理的に存在しない**。
静的 asset の `last-modified` は CDN のキャッシュ充填時刻(実測: 初回 navigate と同秒)でビルド時刻ではない。Vercel CLI / token も本環境に無い。

→ **`dpl_CPs7gETBY9AgUpYmV1KBV7JQkGwh` ↔ `3920cb0` の対応確認は OT の Vercel dashboard が必要**。本 smoke の結果はこの対応が成立する前提でのみ T1 に帰属する。
なお `3920cb0` の直前 5 commit は docs / コメントのみゆえ、仮に 1 世代古い deployment であっても差は lockfile と docs に限られる。

## 実行

入力 = `scripts/ai/ocr-samples/mock-exam-set-p-{1..5}.png`(5 枚)。本日の ②-4a クローズ smoke と**同一入力**で、client 圧縮後 **523.5 KB** も基線と完全一致。
user = `komail9server+clerk_test@gmail.com` / `user_3FAFyaA6GRwk2FOaebubYxzdUmK`(内部 `85541b25-51e9-44a3-8952-e383f98d4ae3`)。

- 投入 `03:57:12.070` → `completed_at 03:57:31.251`(**19.2 秒**)
- source_document `ad24f667-3d50-4471-893e-dbe3a8dfc098` = **completed** / `pages_processed 5`
- upload_operation `4c5fdedc-a864-4b79-9eb0-ad38c75a2882` = **completed** / `attempt_count 0` / `last_error_code NULL` / `prepared_payload NULL`(publish 後の正状態)
- exam `3af13193-4ec9-4441-8c4d-91bd73eb7c65`(「アップロード 2026-08-06 12:57」)

### result_summary(生値・抜粋)

```
cardsTotal       11
cardsExtracted   10
cardsExcluded     1
figuresAttached   8
figuresExcluded  {"malformed":0,"crop_failed":0,"coordinate_null":0,"asset_id_invalid":0,
                  "deadline_excluded":0,"source_id_invalid":0,"image_limit_exceeded":0,
                  "orientation_unsupported":0}
```

DB 実数と一致: `cards 10` / `card_asset_refs 8`。

### 図版の実描画(exam 詳細)

```
img[0] blob: 772x579 complete
img[1] blob: 704x499 complete
img[2] blob: 412x581 complete

presigned GET(R2・3 本とも 200):
  users/85541b25-.../a5957802-2c36-47d6-b8b1-5dd3f4298359.webp
  users/85541b25-.../529b278c-5ac1-44cd-a123-34cfe5958672.webp
  users/85541b25-.../ca9c1187-1a71-4532-90ca-fbdabcc7aab2.webp
→ `src/` を含む key = 0(基線の不変条件と一致)
```

network 全 200(server action `POST /app/upload` 含む・5xx ゼロ)。console **0 errors**(警告は Permissions-Policy 未知 feature と Clerk dev key の既存 benign のみ)。

## 判定

**PASS**(判定基準 = completed 到達 + 図版添付)。

### 基線との差分(いずれも T1 起因ではない)

同一入力の本日基線は `11 問 / cardsExcluded 0 / 図版 10`。今回は `10 問 / cardsExcluded 1 / 図版 8`。

- **図版 8**: `figuresExcluded` が**全キー 0** = crop / 座標 / deadline いずれの失敗も無く、**モデルの検出数そのものの差**。基線 doc も同一入力で 図版 10(run 1/4/6)と 図版 5(run 7)を記録しており、**既知の非決定性の範囲内**。
- **cardsExcluded 1**(問9 が脱落): `last_error_code` は NULL、`figuresExcluded` も全 0。除外理由は `result_summary` に記録されない(client にも露出しない)ため**本 smoke では未特定**。同一入力で cardsExcluded が 0 以外になったのは初観測。追跡には `OCR_DEBUG_LOG` 付きの再走が要る。

## 前提の訂正(現物確認)

smoke 指示の「prod scope の 3 件(fast-uri / ip-address / brace-expansion@5)はいずれも `@google/genai` 配下の runtime 依存木にいるため、この 1 本が唯一の実経路」は**事実として成立しない**。

- `pnpm why --prod` 実測: `fast-uri ← ajv ← @modelcontextprotocol/sdk` / `ip-address ← express-rate-limit ← @modelcontextprotocol/sdk` / **`brace-expansion@5.0.9 ← minimatch@10 ← @ts-morph/common ← ts-morph ← shadcn`**(= brace-expansion@5 は `@google/genai` 配下ですらない)。
- `@google/genai@2.13.0` の `dependencies` は `google-auth-library` / `p-retry` / `protobufjs` / `ws` のみで、**`@modelcontextprotocol/sdk` は optional な peerDependency**(`peerDependenciesMeta.optional = true`)。tree に居るのは pnpm の peer 自動導入によるもので、MCP tool を使わない OCR 経路では読み込まれない。
- したがって **T1 で版が上がった 7 件はいずれも本 smoke の実行経路上で動作しない**(dev 側 undici / brace-expansion@1 は元より非実行)。`pnpm audit --prod` の "prod scope" は **`dependencies` を辿るグラフ上の分類**であって実行の主張ではない。

**この smoke が実証したもの** = 新 lockfile で Vercel build が通り、app が起動し、OCR pipeline 一式(upload → 単一 invocation → crop → publish → R2 presigned GET → 描画)が完走すること。
これは無価値ではない — 本 repo には **依存ツリーの変更が local gate を全て通過しながら Vercel 実行時だけ壊れた前例**(sharp libvips `.so` の NFT トレース漏れ)があり、その型の regression を潰す検査になっている。
**実証していないもの** = patched された 3 パッケージのコードが実際に動くこと(そもそも実行経路に無い)。

## 残件

1. `dpl_CPs7gETBY9AgUpYmV1KBV7JQkGwh` ↔ `3920cb0` の対応確認(OT / Vercel dashboard)。
2. `cardsExcluded 1`(問9)の理由特定 — 必要なら `OCR_DEBUG_LOG` 付きで再走。
3. 本 smoke の exam `3af13193-...` は証跡として残置。不要なら削除は OT 判断。
