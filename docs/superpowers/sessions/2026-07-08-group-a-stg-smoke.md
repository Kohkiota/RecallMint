# Group A(A-1〜A-4)stg smoke — 2026-07-08

対象 HEAD: `e476ea9`(develop・origin 同期済 push 後)。stg: https://stg.recallmint.nekotest.net/app
test account: `komail9server+clerk_test@gmail.com`(userId `user_3FAFyaA6GRwk2FOaebubYxzdUmK`・Clerk test mode)。
実走: Playwright MCP(chrome-devtools MCP は session-close 既知バグ回避)。console error 全経路 0。

## 段階 0: stg 反映確認

Group A は **server-side-only(新 DOM マーカー無し・SHA は browser 非露出)**。取得できた反映証跡:
- `GET /app` → HTTP 200 / `x-vercel-id: hnd1::hnd1::…`(function 東京 hnd1・convention 一致)/ `x-vercel-cache: MISS`(fresh render)/ date 2026-07-08 06:37 GMT(当日)。
- push 確認(git: develop == origin/develop @ e476ea9)+ Vercel develop→stg 自動 deploy。
- 追加: A-1/A-2 の新コード path が実走し正常応答(下記)= 反映の behavioral 裏付け。
- 限界: `x-deployment-id`/SHA が browser 非露出のため **live=e476ea9 の cryptographic binding は不可**。反映は「live/healthy/fresh 東京 deployment + push + 新 path 実走」で実務的に確認。

## 段階 1: A-1 single カテゴリ タグ 正常付与(置換動作)

- tag category「いんき」= type **single**(options: いんきん / あいう)。card 問108(`4d2ac14f-…`・tag 無し)で検証。
- picker で option は **`menuitemradio`**(UI 単一選択保証)。
- **付与**: いんきん click → `POST /api/entity-mutations/bulk`(reqid 49)
  - req: `update_field tag_option_ids = ["40082d46-…"(いんきん)]`
  - res: **`{"ok":true,"applied":1,"failed":[]}`** / cell tagCount=1「いんき: いんきん」
- **置換**: chip 再 open → あいう click(いんきん checked→false / あいう checked)→ `POST …bulk`(reqid 53)
  - req: `tag_option_ids = ["dfd4fb72-…"(あいう)]` ← **いんきん id 消滅=置換(stack でない)**
  - res: **`{"ok":true,"applied":1,"failed":[]}`** / cell tagCount=1「いんき: あいう」
- **判定 PASS**: single カテゴリ 1-option-per-category の正当 set を A-1 は reject せず。正当な置換フローを壊していない。
- 後始末: あいう 削除 → tagCount=0(問108 原状復帰)。
- ※ 不正(single カテゴリ ≥2 option)は正常 client では送れない(UI radio)ため unit test が正(`lib/cards/card-field-handlers.test.ts`)。

## 段階 1: A-2 演習 正答 → bulk flush → 集計反映

- スマート復習 5 枚 演習(1 正解 / 正答率 20%)→ session 完了で flush。
- `POST /api/review-events/bulk`(reqid 47)
  - req: events 5 件・各 `selected_answer_ids` = 実 option id(`["1"]`,`["2"]`,`["1"]`,`["2"]`,`["3"]`)
  - res: **`{"ok":true,"failed":[]}`** ← 新 options 検証 path が実 option id を全て accept(false reject 0)
- 集計反映(dashboard): 今日の学習問題数 **0→5** / 連続日数 **1→2 日**(study_days 記録)/ スマート復習 due 426→424(FSRS state 前進)。
- **判定 PASS**: 正当解答が ingest→replayCard→pull-back→mirror まで正常。A-2 は正当解答を壊していない。
- ※ 存在しない option_id の reject は正常 client では送れないため unit test が正(`tests/contract/review-events-bulk.contract.test.ts`)。

## 段階 1: A-4 退会 偽アラート — CC 実行せず(OT 確認要)

- A-4 の直接確認 = test アカウント退会 → Discord に偽アラート('unlinked customer'等)が出ないこと。
- **CC 実行しない理由**:
  1. 退会は **破壊的**(アカウント + cascade 全削除)。OT に実行判断を確認。
  2. 偽アラートは server-side `notifyOps`→Discord。**CC は browser から Discord ops channel を観測不能**。
  3. `customer.subscription.deleted` webhook は **active Stripe subscription がある場合のみ発火**。test account の subscription 有無を OT が担保する必要。
- → A-4 は実質 **OT 実機領域**(破壊的 + Discord 観測 + active sub 前提)。

## 段階 2: OT 実機領域(CC 撃たず)

- **A-3 実 Stripe**: upgrade/downgrade が正常動作(非退行)。実決済絡み。
- **A-3 DB 失敗注入**: unit test が正(`app/(app)/app/upgrade/actions.test.ts`・mock で db.update reject → notifyOps 発火 assert)。実機不要。
- **A-4 実退会**: test account で実退会 → 偽アラート不発生 + DB 削除完了。破壊的 + Discord 観測ゆえ OT 実機。

## 総括

- CC 実走分: **A-1 PASS / A-2 PASS**(正常系非退行・console error 0)。
- A-4 = OT 実機(退会実行判断 + Discord 観測)。A-3 = OT 実機(実 Stripe)+ unit test(DB 失敗注入)。
- smoke pass + OT 実機 pass 後、A-3(`c5075e0`)/ A-4(`e476ea9`)に [reviewed] amend(未 push 前提)→ prod 判断は OT。
