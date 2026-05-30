# 増分 pull Step 2「統合 /api/pull (サーバー単体)」 endpoint 直叩き stg smoke — 全 8 観点 PASS

- **日付**: 2026-05-30
- **対象**: develop @ `46ce0cb`（Step2 5 feat commit: `f8863c8`/`9810825`/`73e0e0c`/`de5d4bf`/`46ce0cb`、全 `[no-review]`）
- **plan**: `docs/superpowers/plans/2026-05-30-incremental-pull-step2-unified-pull-endpoint.md` の endpoint 直叩き 8 観点
- **手法**: client 未載せ替えのため UI 経路なし。認証済 staging ブラウザ (OT hand-off セッション、step 1 と同じ) の devtools から
  `fetch('/api/pull?...')` を直叩き + `.env.local`＝staging DB の read-only SELECT で交差確認。
- **deploy 注記**: 初回 `fetch('/api/pull')` は 404 (deploy 伝播中)、数秒後 200。確認時は反映済。`x-vercel-id` 取得で server 到達確認。

## 結果サマリ (全 8 観点 PASS)

user = `1231f42d-9c9f-4edb-addd-104890193571`。全件: cards 52 / exams 2 / tombstones 9。

| 観点 | 結果 | 証跡 (response ↔ DB) |
|---|---|---|
| 1 全件 (since なし) | **PASS** | shape `[cards,exams,tombstones,cursors]`、`Cache-Control: no-store`。count 52/2/9 = DB count。`cursors`={cards:`01:51:48.586Z`, exams:`2026-05-29T04:49:46.605Z`, tombstone:`01:54:25.445Z`} = DB の各 max(updated_at)/max(deleted_at) と完全一致。tombstone 行は `{entity_type('exam'|'card'),entity_id,deleted_at}` の 3 key のみ |
| 2 差分 (since あり) | **PASS** | `?since_cards=2026-05-30T00:00:00.000Z` → cards **5** (< 52)。DB `count where updated_at >= mid` = 5 と一致。cursors.cards = 返却 5 行の max |
| 3 inclusive 境界 (最重要) | **PASS** | `?since_cards=2026-05-30T01:51:48.586Z`(=max) → cards **5**（境界行が**含まれる** = `>=`）。`?since_cards=...587Z`(+1ms) → cards **0**（境界行が除外）。inclusive を直接実証 |
| 4 0 件 cursor 据え置き | **PASS** | `?since_cards=2027-01-01T00:00:00.000Z` → `cards:[]` かつ `cursors.cards = null`（exams/tombstone cursor は非 null のまま = ストリーム別据え置き）|
| 5 tombstone ストリーム | **PASS** | `?since_tombstone=2026-05-30T00:00:00.000Z` → tombstones **4** (< 9)、全行 shape OK。返却 4 件 (card `3bba2ef0` `01:53:31.535Z` / exam `4868b4ab`+card `f686e7f2`+card `6c3ffdb6` 各 `01:54:25.445Z`) = DB `deleted_at >= mid` の 4 行と entity_id・deleted_at まで一致。cursors.tombstone = max |
| 6 3 ストリーム独立 | **PASS** | `?since_cards=...586Z` のみ → cards 5 (絞られる) / exams 2・tombstones 9 (全件) / cursors.exams・cursors.tombstone 非 null。since_cards は cards だけに作用 |
| 7 owner-scope | **PASS (実クロステナント確認)** | 返却 cards/exams の user_id 全て test user。**DB 全体 vs 当該 user: cards 54→52 / exams 3→2 / tombstones 13→9** — 他 user (distinct user=2) のデータが DB に存在するが `/api/pull` は当該 user 分のみ返却 (他 user 計 6 行を除外)。単一 account 前提 (U2) を超え実除外を経験的に確認 |
| 8 旧 endpoint 非破壊 | **PASS** | `/api/cards/pull` `{cards,now}` count 52 / `/api/exams/pull` `{exams,now}` count 2 / `/api/study-days/pull` `{studyDays,now}` count 2 — いずれも 200・旧 shape (`now` 含む)。client がまだ使う旧経路は無傷 |

## 特記
- **観点3 (inclusive) と観点7 (実クロステナント) が本 endpoint の核心**を実証: cursor 再送 (=max を since に戻す) で境界行が
  確実に再取得され (取りこぼし防止)、かつ他 user データは構造的・実データ両面で混ざらない。
- next-cursor が wall-clock ではなく**返却行の max** であることを全観点で確認 (cursors が常に返却 max と一致、0 件で null)。
- 旧 3 endpoint 併存も確認済 — step 3 client 切替まで client は旧経路を使い続けられる。

## 結論
全 8 観点 PASS。5 feat commit (`f8863c8`/`9810825`/`73e0e0c`/`de5d4bf`/`46ce0cb`) を `[no-review]` → `[reviewed]` に書換
(非 HEAD のため `git filter-branch --msg-filter` で当該 5 SHA のみ、diff 不変・Co-Authored-By 保持)。**履歴書換のため OT の再 push は
`--force-with-lease` 必須**。staging データは読み取りのみ・新規作成/削除なし (test データ残置なし)。
