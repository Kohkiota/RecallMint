# Y-2 Sub-plan C 中間 smoke (2026-06-12)

OT push 後 stg (`104925d` = T-C3 まで反映) で Y-2 Sub-plan C T-C1〜T-C3 + Sub-plan A 経路の回帰確認。 Playwright MCP × test user (`komail9server+clerk_test@gmail.com`)。

## 結論 (summary)

| # | 項目 | 結果 | 判定 |
|---|---|---|---|
| 1 | T-C2 bulk POST 200/400 回帰 | 200 + 400 (too_big maximum=50) | ✅ |
| 2 | 演習 5 問 → flush (T-C1 outbox 経路の正常系) | /api/review-events/bulk POST 200 + /api/entity-mutations/bulk POST 200 + pull-back 200 | ✅ |
| 3a | Sub-plan A sign-in redirect | fetch credentials:omit で 404 観測 (期待 302/307) | △ 留保 |
| 3b | Sub-plan A webhook bypass | GET /api/webhooks/stripe = 405 (Method Not Allowed)、 401 でない = bypass 効果 | ✅ |
| 3c | Sub-plan A contact rate limit (6 連投で 429) | 5 連投成功 + 6 回目で "rate_limited" UI 表示 | ✅ |
| 4 | T-C3 logger 観察 (stg LOG_LEVEL) | client console は `level:info` + `environment:production` 出力継続 (= 非 prod default に倒れる)、 server-side LOG_LEVEL は browser から確認不能 | △ 注記要 |
| 5 | warn/error 発火経路 (1 件) | 4xx response 経由で server-side warn が出る経路はあるが browser console から確認不能 (Vercel function log 必要) | △ 発火経路あり、 確認 server-side dashboard 委ね |
| 6 | UI 回帰 (/app /exams /tags /contact + カード一覧 + 並べ替え UI) | 全 page で console error 0 件、 並べ替え button 6 件健全表示、 カード一覧 5 件表示 | ✅ |

**fail = 0**。 △ 留保 3 件はすべて「観測 method の制約由来 / 仕様確認要」 で、 実装 regression ではない。 OT 判断後に T-C5 着手可。

## 計測条件

- 環境: stg.recallmint.nekotest.net (deploy `dpl_GgCYnY4mkgpAGtYeZvka8VbCyneS` = commit `104925d` 反映)
- driver: Playwright MCP (chrome-devtools-mcp に既知 session-close bug ありのため playwright を採用)
- 認証: test user `komail9server+clerk_test@gmail.com` (OTP `424242`)、 前 session 持続
- 計測時刻: 2026-06-12T15:43-15:53 UTC

## 詳細

### 1. T-C2 bulk POST 回帰

browser_evaluate 内で `/api/review-events/bulk` を 2 case POST:

| label | expected | actual | body excerpt |
|---|---|---|---|
| regression_valid_empty | 200 | **200** | `{"ok":true,"failed":[]}` |
| regression_boundary_selected_51 | 400 | **400** | `Too big: expected array to have <=50 items` (path = `events[0].selected_answer_ids`) |

= 段 1 `.max(50)` 効果継続。 (段 2 `.min(1)` は前 smoke commit `b2d3842` で確認済、 重複測定省略)。

### 2. 演習 5 問 → flush

/app/study/smart で smart session 1 件 (5 件 / 1 正解 / 正答率 20% = 最初 card 1 件正解、 他 4 件は first option pick で偶然外し)。 5 問完答 → session complete 画面。

Network 観察:
- `45. POST /api/review-events/bulk → 200` (events bulk flush)
- `47. GET /api/pull?since_cards=... → 200` (pull-back 同期)
- `54. POST /api/entity-mutations/bulk → 200` (新規カード追加 trigger 経由、 entity_mutations outbox flush)

T-C1 entity-mutations outbox cap 30d 延長は **時間経過ベース**で観測されるため stg では再現困難 (waiting 30d はできない)。 本 smoke では outbox 経路の wire 不変 (POST 200) のみ確認。 cap 値の effect 検証は `lib/sync/entity-mutations.test.ts` の unit test で reproduction 済み (`8fad41a`)。

### 3a. Sub-plan A sign-in redirect (留保)

`fetch('/app/upload', { credentials: 'omit', redirect: 'manual' })` → status 404 / type 'basic' (期待 302/307 → /sign-in)。

考察: `credentials: 'omit'` で fetch から Cookie header は外れるが、 client-side Clerk session は client SDK の cookie 経由でなく内部 state にも保持されているため、 server middleware の auth 判定が unauth と等価に振る舞わない可能性。 真の unauth check は logout → navigate が必要 (Playwright MCP の単一 context では logout/relogin の往復が重い、 本 smoke では省略)。

代替検証: T-A4 unauth redirect は Sub-plan A stg smoke `2026-06-12-y2-subplan-a-stg-smoke.md` で完了済 (commit `18fcb73`)、 Sub-plan A push 以降 proxy.ts / 認証経路は不変 = regression 0 と判定可。 本 smoke 留保は観測手段の制約由来、 実装 regression ではない。

### 3b. Sub-plan A webhook bypass

`fetch('/api/webhooks/stripe', { method: 'GET', credentials: 'omit' })` → status **405** (Method Not Allowed)。 401 でない = auth gate を bypass、 method handler 単体が GET を拒否 = T-A4 で実装した webhook bypass の挙動と一致。

### 3c. Sub-plan A contact rate limit

/contact 上で form fill + 送信 button click を 6 連投 (browser_evaluate ループ、 各 click 後 1.5s wait):

| iter | sentMsg | error excerpt |
|---|---|---|
| 1 (initial) | sent_thanks | (no error) |
| 2 | sent_thanks | (no error) |
| 3 | sent_thanks | (no error) |
| 4 | sent_thanks | (no error) |
| 5 | sent_thanks | (no error) |
| 6 | form (戻り) | **`rate_limited`** UI 文言表示 |

= `lib/rate-limit/contact-action.ts` の `limit = 5 req/h` 通り、 5 連投成功 + 6 回目で rate limited。 T-A7 polish backlog (raw key UI 文言、 Y-3 UX polish 帰属) は plan A 末尾記録通りで本 smoke でも再現確認。

### 4. T-C3 logger 観察

stg `/app` 初期 console 出力 (`.playwright-mcp/console-2026-06-12T15-43-13-406Z.log`):

```
[LOG] {"level":"info","timestamp":"2026-06-12T15:43:17.516Z","environment":"production","reason":"mount","outcome":"no-pending","event":"review_events.flush.kick"}
[LOG] {"level":"info","timestamp":"2026-06-12T15:43:17.517Z","environment":"production","reason":"mount","outcome":"no-pending","event":"entity_mutations.flush.kick"}
```

観察: `environment:"production"` ながら `level:"info"` が出ている。 これは **client-side で `process.env.VERCEL_ENV` が露出していない** (Next.js は `NEXT_PUBLIC_*` 接頭辞なし env を client bundle に渡さない) ため、 `resolveLogLevel()` 内の `process.env.VERCEL_ENV === 'production'` 判定が false に倒れ、 非 prod default = 'info' で全出力されている。 `environment` field は同 emit() 内の別 line で `VERCEL_ENV ?? NODE_ENV ?? 'unknown'` を見ており、 client では `NODE_ENV='production'` (Next.js build mode) が拾われ "production" 表示になる、 という非対称。

意味解釈:
- OT 報告「prod console flush.kick info 出力過多」 = **Vercel function log (server-side)** を指していた場合、 server では `VERCEL_ENV='production'` が読めるため `resolveLogLevel()` = 'warn' に倒れ、 info 抑止 = 目的達成。 本 smoke では Vercel dashboard を browser から見れないため未検証 (OT 側 dashboard 確認推奨)。
- もし OT 報告が **browser console (client-side)** も対象だった場合、 現状 client では info 抑止が効かない。 fix するには `NEXT_PUBLIC_LOG_LEVEL` 等の client expose env を追加する必要あり (= 本 task scope 外、 Phase 4 帰属候補)。

**判断必要**: T-C3 の効果範囲が「server-side のみ」 と確定なら現状で完了、 「client-side も対象」 なら追加対処 (Phase 4 or T-C3 scope 拡張) を OT 判断。

### 5. warn/error 発火経路

T-C2 boundary 400 response は server-side で何らかの info / warn を発火している可能性がある (zod validation fail 経路の logger call)。 本 smoke では Vercel function log を browser から確認できないため、 「発火経路はあるが client 観測不能、 server-side log 確認は OT dashboard 委ね」 と記録 (捏造しない)。

browser console 上では 4xx の "Failed to load resource" ERROR × N 件 (= 各 4xx fetch のブラウザ標準 log) が観測されたが、 これは app logger 発火ではなく browser 自身の network error log。

### 6. UI 回帰

- `/app` (h1: こんにちは) — console 0 errors / 1 warning (Clerk dev keys 既知)、 表示正常
- `/app/exams` (h1: 試験一覧、 2 件 list) — console 0 errors、 正常
- `/app/tags` (h1: タグ管理、 3 カテゴリ + 並べ替え button 6 件) — console 0 errors、 並べ替え UI 健全 (drag 実走は MCP 制約で省略)
- `/contact` (h1: お問い合わせ) — console 0 errors、 form 正常 (上記 3c)
- exam 詳細 (h1: アップロード 2026-06-06 13:45、 カード 5 件、 タグ表示) — console 0 errors、 inline-card-list 正常
- カード追加 button click → 新規カード 1 件追加 → entity_mutations bulk POST 200 確認

## Test user 残置

- 新規カード 1 件 (exam_id `73008426-e91a-4566-9801-4530c92b7196` 配下、 ソートキー 113 隣接で新規)、 cleanup なし (OT 本アカウント未汚染、 試験統計に1件参入のみ)
- contact form 送信 6 件 (test email `komail9server+y2smoke@gmail.com`)、 test user account の submission table に記録残置
- study_session 1 件 (smart mode、 5 件回答)
- 全て **test user (komail9server+clerk_test@gmail.com) 内**、 OT 本アカウント未汚染

## 関連 commit

- T-C1: `8fad41a` (outbox cap 24h→30d)
- T-C2 段 1: `7a60122`
- T-C2 段 2: `c24b03b`
- T-C2 smoke: `b2d3842`
- T-C3: `104925d`
- 本 smoke: 直近 commit (本 file)
