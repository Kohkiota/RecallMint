# cache-fix roadmap Step 2 stg smoke

- 実施日: 2026-05-27
- 種別: session log / stg smoke
- 対象 stg: `https://stg.recallmint.nekotest.net`
- 対象 commit (origin/develop 反映済): `5352e5c` (spec follow-up) を含む 4 commit
  - `326d7a9 feat(perf): PullTrigger を /app layout に移動 [reviewed]` (④-1)
  - `30b3293 fix(auth): clerk-metadata の 404 を silent skip [reviewed]` (④-4)
  - `b73512b refactor(perf): /app/cards/[id] 個別 card 編集 page を廃止 [reviewed]` (④-3)
  - `5352e5c docs(perf): spec を実態整合に更新 [no-review]` (④-3 follow-up)
- 実行手段: Playwright MCP (`@playwright/mcp` 経由)
- 認証: komail9server+001@gmail.com / factor-two (verification code OT 連携)
- 関連 brief: cache-fix roadmap §④-1 / ④-3 / ④-4
- 結論: **全 7 項目 PASS、 production deploy 可**

---

## 結論

A-1 / A-2 / B-1 / B-2 / B-3 / C-1 / C-2 全 PASS。 console error は Vercel
Live iframe CSP block (known harmless) と A-1 で意図的に踏んだ削除済 page
の 404 response (expected) のみ、 clerk-metadata / notifyOps 関連 error /
warn / hydration error / 削除済 file 由来の import 残骸 error はゼロ。

---

## 1. A. ④-3 `/app/cards/[id]` 削除 verify (主目的)

### A-1. 削除済 page 404 化

- URL: `https://stg.recallmint.nekotest.net/app/cards/00000000-0000-0000-0000-000000000000`
- 結果: **PASS**
  - Next.js default not-found UI が render (`404` heading + `This page could not be found.`)
  - 削除前のレイアウト (banner / nav / main 等) は render されず、 Next.js が
    route 自体を見つけられない状態 (= page.tsx 削除完全反映)
  - Console に 404 response error 出力 (expected、 削除済 path への access)

### A-2. `/app/exams/[id]` inline 編集 + RSC 自動再実行

- URL: `https://stg.recallmint.nekotest.net/app/exams/3497aff6-74f2-49e6-80e5-72ae3281fdb2`
- 操作: option text (id=2、 「正 正 誤 正」 → 「正 正 誤 正X」) を inline edit
- Network 観察 (差分 reqid):

  ```
  reqid 118: GET /app/exams/3497aff6-...?_rsc=1x5zj  [200]  ← 初回 navigate RSC fetch
  reqid 122: GET /app/exams/3497aff6-...?_rsc=1x5zj  [200]  ← prefetch 系 (harmless)
  reqid 124: POST /app/exams/3497aff6-...            [200]  ← server action 呼出
  ```

  POST 後に追加の `?_rsc=` GET が発生していない = **Next.js 15 の server action
  response が RSC payload を inline 返却する仕様**で、 spec §6 の「自動再実行」
  機構が動作している証拠。
- 結果: **PASS**
  - 画面表示が「正 正 誤 正X」 に更新 = revalidatePath なしで RSC re-render 完結
  - 編集前後で他 card / 他 option は変化なし
  - = 削除した `revalidatePath('/app/cards/${cardId}')` 行が機能しなくても、
    inline 編集の RSC re-render は Next.js 15 組み込み機構で完全に維持されている

---

## 2. B. ④-1 PullTrigger 移動 念のため verify

### B-1. dashboard 訪問で 3 pull endpoint fire

- URL: `/app` (sign-in 後着地)
- Network 観察:

  ```
  reqid 58: GET /api/cards/pull       [200]
  reqid 59: GET /api/exams/pull       [200]
  reqid 60: GET /api/study-days/pull  [200]
  ```
- 結果: **PASS**

### B-2. internal navigation で re-fire **しない**

- 操作: `/app` → 試験 nav link click → `/app/exams`
- Network 観察:

  ```
  reqid 71: GET /app/exams?_rsc=18rsy [200]  ← Next.js RSC fetch (normal)
  reqid 75: GET /app/exams?_rsc=18rsy [200]  ← (同上、 prefetch 系)
  ```
  → **3 pull endpoint は re-fire しない** (reqid 58/59/60 のまま、 新規 pull request なし)
- 結果: **PASS** (layout persistence effective)

### B-3. reload で 3 pull が fresh layout mount として再 fire

- 操作: `/app/exams` で `window.location.reload()` 実行
- Network 観察:

  ```
  reqid 99:  GET /api/cards/pull       [200]
  reqid 100: GET /api/exams/pull       [200]
  reqid 101: GET /api/study-days/pull  [200]
  ```
- 結果: **PASS** (= deep link 経路と同等の挙動、 ④-1 の主目的「deep link / reload
  救済」 が機能)

---

## 3. C. ④-4 notifyOps 404 silent skip 念のため verify

### C-1. plan 由来 UI 正常 render (success path 回帰)

- 観察: `/app` 着地時の snapshot で「アップグレード」 link visible
  (uid e141、 plan != pro/year の場合に表示)
- + 「今日の学習問題数 4 / 連続日数 1 日」 (study_days mirror 経由集計) も正常
- 結果: **PASS** (= publicMetadata sync が壊れていない、 notifyOps 非 404 path 無影響)

### C-2. console error / warn の異常チェック

- 全 session の console error 4 件:

  | # | message | 判定 |
  |---|---|---|
  | 1-3 | Vercel Live iframe CSP block × 3 | **known harmless** (brief 除外明示、 stg dev 環境特有) |
  | 4 | `Failed to load resource: 404` on `/app/cards/00000000-...` | A-1 で意図的に踏んだ削除済 page response、 **expected** |

- clerk-metadata 関連 / notifyOps 関連 / hydration / 削除済 file 由来 (e.g.
  card-editor.tsx の import 残骸) の error / warn: **0 件**
- Clerk dev key warning (`Clerk has been loaded with development keys`) も
  通常 stg 挙動 (known harmless)
- 結果: **PASS**

### 404 path 実機再現 (B-2 の本来検証) について

brief 明示通り、 削除済 user に対する Stripe webhook 後着 race の意図再現は
stg では仕込みコスト過大のため本 smoke では実施せず。 production 投入後の
Discord 通知量低下を OT が数日観察 (reviewer 推奨方針) で間接 verify する。

---

## 4. 全 smoke 結果サマリ

| 項目 | 結果 | 根拠 |
|---|---|---|
| A-1 削除済 page 404 化 | PASS | Next.js default 404 UI 表示、 削除前 layout 不在 |
| A-2 inline 編集 RSC 自動再実行 | PASS | POST 200 + 追加 GET RSC なし + 画面反映 |
| B-1 dashboard 3 pull fire | PASS | reqid 58/59/60 各 200 |
| B-2 internal nav で re-fire しない | PASS | layout persistence effective |
| B-3 reload で 3 pull 再 fire | PASS | reqid 99/100/101 各 200 |
| C-1 plan 由来 UI 正常 | PASS | upgrade CTA visible |
| C-2 console clean | PASS | known harmless 以外 0 件 |

---

## 5. 完了条件チェック (brief §「完了条件」 準拠)

- [x] A-1 / A-2 / B-1 / B-2 / B-3 / C-1 / C-2 全 PASS
- [x] Playwright 実行ログを session log に保存 (本 file = `docs/superpowers/sessions/2026-05-27-cache-fix-step2-stg-smoke.md`)
- [x] console error / warn の異常なし (CSP block on Vercel Live iframe / Clerk
  dev key warning は known harmless で除外、 A-1 由来の 404 は expected)

---

## 6. やらないこと (brief §「やらないこと」 遵守)

- 課金 smoke (Stripe Checkout / webhook / plan 反映系): **本 smoke で実施せず**、
  OT 側で別途
- production environment smoke: **本 smoke で実施せず**、 production deploy は
  smoke PASS 後に OT が実行
- 4 commit 以外の挙動への調査拡大: **未実施** (cache-fix Step 2 範囲のみ)
- 削除済 user race の 404 path 実機再現: **未実施** (本 doc §3 注記参照)

---

## 7. production deploy 推奨 (OT 判断材料)

- 4 commit (`326d7a9` / `30b3293` / `b73512b` / `5352e5c`) は stg で全 PASS
- schema migration なし (`git log origin/main..HEAD -- drizzle/migrations/` 空)
- 裏取り category 該当なし (3 feat/fix commit すべて reviewer 確認済)
- → main へ merge / production deploy 可能 (OT 手動)
