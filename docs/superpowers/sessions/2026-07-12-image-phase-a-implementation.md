# 画像フェーズ A(画像基盤)実装セッション記録

- **日付**: 2026-07-12
- **範囲**: 12 task(subagent-driven-development)、range `37d2893..HEAD`(develop)
- **spec**: `docs/superpowers/specs/2026-07-12-image-phase-a-design.md`(凍結)
- **plan**: `docs/superpowers/plans/2026-07-12-image-phase-a.md`
- **SDD ledger**: `.superpowers/sdd/progress.md`(gitignore・recovery map)
- **状態**: **全 12 task 完了・[reviewed] commit 済 / 未 push**。push + ops + stg smoke = OT。

---

## 1. 実装サマリ(task → feat commit)

| Task | 内容 | commit |
|---|---|---|
| 1 | aws4fetch 1.0.20 導入(de-risk) | 9ad7d4e `[no-review]` |
| 2 | assets pgTable + migration 0023 | 6b4c0b4 |
| 3 | `lib/storage/r2.ts`(presigned PUT/GET + HEAD) | 33412ce |
| 4 | asset server action 3 種(reserve/finalize/resolve)+ Content-Length 署名固定 | 3927405 |
| 5 | `imagesSchema` + `handleImages`(server 最終防衛) | c5555e4 |
| clerk-fix | assets を user.deleted Group I DELETE に登録(T2 の GDPR 網羅漏れ) | 77b2091 |
| 6 | Dexie v8(media_assets + media_download_jobs)+ Cache API blob helper | d17e864 |
| 7 | images mutation flush gate(uploading 中は送信保留) | c5de8e3 |
| 8 | 画像 upload saga(圧縮→reserve→楽観層→直 PUT→finalize + abandon) | 26b5650 |
| 9 | `getAssetObjectURL` + 起動時 self-heal sweep + trigger | ead9c76 |
| 10 | 編集面 gallery(添付・表示・削除・直列化・非配列防御) | 051e72c |
| 11 | 学習ビュー read-only gallery | 4c4d507 |
| 12 | デッキ一括 DL(all-or-nothing)+ InstallPrompt + persist | 779116a |

各 task の Codex 独立レビュー生ログ: `docs/codex/2026-07-12-image-phase-a-*.md`(task 別 `[no-review]` docs commit)。

---

## 2. レビュー収束(canonical + Codex 二経路)

全 feat/fix task で canonical(general-purpose・`requesting-code-review` template 改変なし・read-only)+ Codex 独立(`codex-review.sh`)を実施し、**全 task 未解決 Critical 0 / Important 0** で収束。多周収束した task と要旨:

- **T3**(4 周): R2_PUBLIC_URL false-positive 解消 + retries/timeout 実バグ(`retries:0`)。
- **T4**(5 周): unauth 契約 / 非UUID / 非array / 寸法 int cap の Imp 群 → **presigned PUT が body 無制限 = 5MiB cap が storage 層で無効化されていた Critical** を Content-Length 署名固定で修正。
- **T7**(3 周): null entry / null patch の flush-stall 防御(canonical は見落とし・Codex が捕捉 = dual-review の価値)。
- **T8**(4 周): 注入 action の finalize-throw で card が flush gate 裏に stuck する **Critical** + concurrency lost-update → per-card 直列化 + mirror fresh read。
- **T9**(4 周): user-scope / cache-read guard / pull-reset stuck-mutation の outbox-fallback。
- **T10**(4 周): delete-race(canonical=Minor / Codex=Important の乖離 → `removeImageFromCard` 直列化採用)+ 非配列防御 2 層。
- **T12**(4 周 + canonical-fixes 1 周): `started_at` 時間 gate → per-exam download-lock liveness coordination → Web-Locks-unavailable skip → final 'done' update を try 内へ。canonical final 全 diff の Imp2(never-throw pre-flight / busy≠failure)を修正。

> **Codex 多周(nominal 3 周 cap 超過)の判断**: T3/T4/T8/T9/T10 は各 round が **新規の実 finding**(false-positive の再掲でなく)ゆえ productive convergence と判断し継続。全 fix 済み。

---

## 3. spec との差分(採用済み・記録)

**sweep の 'downloading'/'uploading' 後始末は spec §3.4 の「'failed' 化」でなく delete**。
- 理由: `abandonUpload`/直接削除の既存 primitive を再利用(新経路を作らない・YAGNI)。'failed' 状態を読む consumer が存在せず、gate('uploading' 存在のみで block)/ mirror invariant は delete と同値。
- 影響なし。spec 側の 'failed' 表現は将来 consumer が要る時に別途検討。

---

## 4. 教訓(CARRY・恒久)

**per-task gate が full test を後回しにしたため T2–T5 の 4 commit で clerk regression が潜伏した**(assets schema 追加が Clerk `user.deleted` の Group I DELETE 集合網羅性 invariant test を破っていたのを T6 で初検知 → clerk-fix)。
→ **schema 変更 task の per-task gate には「該当 invariant test か full test」を必ず含める**(本フェーズ以降適用)。

---

## 5. 積み残し(記録のみ・非 blocking)/ フォローアップ chore

1. **16 component test の R2 env mock は冗長**: `vitest.setup.ts` の global R2 env で transitive fail-fast を吸収済みのため、個別 test の R2 mock は削除可(canonical T10 推奨)。→ 別 chore。
2. **T12 Minor3**: (a) `downloadDeckImages` の返却 `total`(デッキ全体)は UI 未読(将来の「N枚中M枚」用に保持)/ (b) 空デッキ(deckTotal=0)の「すべての画像は既に保存済みです」文言 / (c) `InstallPrompt.isStandalone()` の毎 render 再評価(best-effort・memo 不要 YAGNI)。
3. **lock-busy 案内文言**「別のタブでこのデッキの画像を保存中です。完了までお待ちください。」は OT の UX 判断で調整可(canonical Imp2b・低コスト fix 済だが wording は OT 裁量)。

---

## 6. stg smoke checklist(OT push 後・DevTools MCP・**ops CORS 完了が前提**)

- [ ] **正常経路**: 編集面で画像添付 → 即時プレビュー表示(楽観層)→ reload 後も表示(Cache/resolve)→ server 反映(cards.images に UUIDv4 key)。
- [ ] **negative over-size PUT(重要・T4 canonical Minor#1)**: 小 `byteSize` で reserve → それより大きい body を presigned PUT → **R2 が 403 を返す**こと(Content-Length 署名の実 enforce = storage 層 cap 有効性の確認)。CC で検証可能なら DevTools/fetch で実走、困難なら OT。
- [ ] **honest-upload mime mismatch**: signed Content-Type と異なる mime で PUT → 403(署名境界の確認)。
- [ ] **一括 DL 正常**: DeckDownloadButton → 進捗表示 → 全件 Cache → reload 後オフライン表示。all-or-nothing(1 件失敗で巻き戻り)。
- [ ] **placeholder 経路**: 未 ready / resolve 失敗の画像がプレースホルダ表示に落ちる(crash しない)。
- [ ] **失敗経路(PUT 失敗・圧縮失敗・Safari fallback 等)は unit を正とする**(spec §10・plan 1 行明記済)。
- [ ] OT 実機のみ: iPhone HEIC(Photos 経由 JPEG 自動変換の真偽)/ Safari 実機 PNG fallback。

---

## 7. ops 前提(OT 手動・push 前後)

1. **push**: `develop` → origin。
2. **migration 0023 適用**: `pnpm db:migrate`(assets テーブル + FK + 2 index。0023_windy_ultimates)。
3. **R2 env を Vercel に設定**: `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME`(`.env.example` 記載済・`R2_PUBLIC_URL` は非公開 bucket ゆえ意図的に不使用 = spec §8)。SECRET は `rk_` Restricted 相当の R2 API token 推奨。
4. **R2 CORS(最重要)**: 非公開 bucket に対しブラウザからの presigned **PUT + GET** を許可。`AllowedMethods=[PUT, GET]`、`AllowedOrigins=[stg/prod origin]`、**`AllowedHeaders` は `Content-Type` を明示**(`*` から最小権限に絞る。署名対象ヘッダ)、**`ExposeHeaders` に `ETag`**、preflight(OPTIONS)許可。これが無いと直 PUT が CORS で全滅する。

---

## 8. 手動掃除の素材(自動 GC 未実装 = 本フェーズ scope 外)

`assets.reference_count` / `unreferenced_at` は**列のみ確保の休眠枠**(将来の orphan GC 用)。現状は手動掃除。`objectKey` 形式 = **`users/{user_id}/{assetId}.{ext}`**。

**(a) orphan reserved(finalize されず放置された予約)**
```sql
-- 24h 以上 reserved のまま(直 PUT が中断/失敗し finalize されなかった)。
SELECT id, object_key FROM assets
WHERE status = 'reserved' AND created_at < now() - interval '24 hours';
-- → 行削除 + 対応する R2 object(object_key)を手動削除。
```

**(b) ready 孤児(どの card からも参照されない ready asset)** ※要検証で実行
```sql
-- cards.images(jsonb 配列 [{key,target,...}])が当該 asset id を key に持たない ready asset。
SELECT a.id, a.object_key FROM assets a
WHERE a.status = 'ready'
  AND NOT EXISTS (
    SELECT 1 FROM cards c
    WHERE c.user_id = a.user_id
      AND c.images @> jsonb_build_array(jsonb_build_object('key', a.id::text))
  );
-- → 破壊的ゆえ本番実行前に必ず件数確認 + backup。行削除 + R2 object 削除。
```

**(c) 削除ユーザーの R2 残置**: Clerk `user.deleted` は **DB 行のみ** cascade 削除(assets 含む・clerk-fix 77b2091)。**R2 object は自動削除されない**ため、`users/{user_id}/` prefix の object を手動削除する(server 側 R2 delete は本フェーズ未配線 = spec §2.1 明記)。

**(d) 共有ブラウザの前 user Dexie 残置(informational・whole-branch review 指摘)**: sweep は現 user scope ゆえ、共有端末で別 user が残した stale `uploading`(media_assets)行は掃除されない(abandoned upload 1 件につき 1 行累積)。**実害なし**(UUID 一意ゆえ flush を block しない・非表示)。logout 時 DB wipe は本フェーズ scope 外。将来 logout hook で `media_assets`/Cache を user 単位 purge するなら別 task。

---

## 9. whole-branch 最終レビュー結果

**canonical(general-purpose / opus・range 37d2893..HEAD・code のみ・read-only)**: **Ready to merge = Yes / Critical 0 / Important 0**。
- 全 12 task が seam(型・invariant・順序)で整合。ready-only 参照 invariant は client flush gate + server handler の二重防衛。userId scope は server/Cache/Dexie の三層で airtight。Web Lock は全て `ifAvailable:true`(非ブロッキング)ゆえ nested でも **構造的に deadlock 不能**。Content-Length 署名で 5MiB cap を storage 層 enforce。crash-consistency `added ⊇ cached` 順序正。Block A は DI で統一遵守。GDPR 削除網羅は invariant test で機械担保。
- carried Minor 6 件は**全て correctly deferred**(merge blocker なし)。sweep `delete` vs 'failed' 差分は end-state 同値・'failed' の consumer 不在ゆえ安全(型 union の 'failed' は休眠)。
- 追加 non-blocking 観察 2 件: (i) 共有ブラウザの前 user Dexie `uploading` 残置(§8(d) に記録)/ (ii) `objectUrlCache`/`cardImageOpChains` は per-tab bounded で意図的・MVP 規模で可。
- 注記: R2 書込副作用の runtime 検証は設計どおり post-push stg smoke に委ねる(コードは merge-ready・smoke-pending)。

**Codex 独立(`codex exec review --base 37d2893`・whole-branch・read-only)**: **Critical 0 / Important 0 / Minor 0**(「no discrete, actionable correctness issues」)。生ログ `docs/codex/2026-07-12-image-phase-a-whole-branch.md`。
- 注(process 教訓): 本 whole-branch Codex は `codex-review.sh` の `--uncommitted` でなく native `--base` を直接使用(committed range ゆえ)。安全 profile(危険フラグ不使用 / worktree-snapshot detector / count-findings)は inline で複製。
- **git clean detector が FAIL と出たが false-positive**: 原因 = 本 session doc を Codex background 実行**中**に書いたため、before/after の内容 snapshot 間で untracked file が増えた(Codex の source 書換ではない)。検証 = 実行後 `git status` は untracked 2 件(session doc + Codex OUT_FILE)のみ・`git diff HEAD` 空・HEAD 不変。Codex の `pnpm build` は gitignore 済 `.next/` のみ書込(snapshot 対象外)。
- **教訓**: content-based detector を使う background codex-review の実行中は working tree に file を書かない(誤検出源)。次回は review 完走後に doc を書く。

---

## 10. 追補: CSP 不足補完(spec §4 訂正の反映・後日 fix)

初回 stg smoke で CSP が R2 直アクセス(connect-src)と blob: 画像表示(img-src)をブロックしていたのを補完。**scope 内不足補完(新機能でない)**。

- **CSP SoT = `proxy.ts` の Clerk auto CSP**(`next.config.ts` は `frame-ancestors 'none'` のみで directive が disjoint = 衝突なし)。`contentSecurityPolicy: {}` → `{ directives: imageCspDirectives(process.env.R2_ACCOUNT_ID) }`。
- Clerk 7.5.1 の `directives` は既定に **merge(append+dedup)** する(node_modules 実装 `handleExistingDirective` で裏取り済 / canonical も installed source で独立検証)→ Clerk/Stripe/maps 既存 source を保持し R2/blob: を加算(置換でない)。
  - `connect-src`: R2 path-style exact origin `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`(r2.ts の objectUrl と一致。account 未設定なら加算しない guard)。
  - `img-src`: `blob:` / `worker-src`: `self` `blob:`(圧縮 worker の明示 pin。Clerk 既定にも在り実質 no-op だが intent 固定)。
- **圧縮 lib self-host**: `browser-image-compression@2.0.2` dist を `public/vendor/` へ byte 一致 vendored、`libURL` を同 origin へ(jsDelivr を CSP allowlist に足さない最小権限)。drift guard test で package 同版を pin。`worker` は blob: origin ゆえ絶対 URL 化(SSR/test は window guard で相対 path)。
- **R2 fetch hardening**: PUT/GET に `mode:'cors'` / `credentials:'omit'`(署名クエリ認証で cookie 不要)/ `redirect:'error'`。
- **Cache key**: 既に合成 key `/__media/{userId}/{assetId}`(presigned URL 不使用)を確認 = 変更なし(spec §2.4 遵守)。
- **COEP/COOP は不追加**(Clerk 認証への影響回避)。
- review: canonical(general-purpose/opus・template 改変なし)= **Ready to merge Crit0/Imp0/Minor3** + Codex 独立 = **Crit0/Imp0/Minor0**。commit 779... 系と同様 [reviewed] を canonical+Codex pass で付与(認証/外部副作用系ゆえ smoke は本 doc を正記録)。

**フォローアップ(canonical Minor#1・記録)**: **OCR upload(`upload-form.tsx`)の圧縮 worker は依然 jsDelivr CDN を使う**(`libURL` 未指定)。新 CSP では壊れない(blob: worker は `worker-src blob:`、importScripts(jsDelivr) は Clerk 既定 `script-src 'https:'` が許容)ため今回は scope 外として未変更。「no-CDN 最小権限」を app 全体で完遂するなら OCR も vendored libURL に寄せる別 task を起票(その際は Clerk 既定 `script-src 'https:'` を絞る smoke も要る)。

**CSP fix 後の再 smoke(OT・§6 に加え)**: PUT が Network に現れ 200 / 貼った画像が blob 表示される / 圧縮 worker が同 origin lib を通る(jsDelivr へ egress しない)/ negative over-size PUT 403 / 一括 DL。前提 = R2 CORS(§7-4)完了。
