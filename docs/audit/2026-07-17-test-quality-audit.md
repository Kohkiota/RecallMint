# テスト品質監査 — 「初期 AI テストのパターン伝播」懸念の検証(2026-07-17)

## 背景 / 問い

OT の懸念: 「AI 駆動開発では TDD の最初の数個のテストがその後の品質を規定する。本プロジェクトは開始時に深く考えず AI にテストを書かせ始めた — 今から見て大丈夫か」。

本監査はこの問いを ① 初期テストの実態確認 ② 全 238 test file の領域別品質監査(subagent 3 体・read-only)③ **変異チェック 5 点の実測**(隔離 worktree でソースを 1 行壊し suite が落ちるかを実走)で検証した。

## 結論

**懸念のパターン伝播は起きていない。品質はむしろ急速に改善し、現在のスイートは強い。**ただし実測で確認した本物の穴が 2 つある(下記 G1/G2 — いずれも変異を注入して full suite 3658 test が**全通過してしまう**ことを実証済)。

- 初回 commit(2026-05-15)には確かに浅いテストが実在(mock-echo 型 `revalidate.test.ts` / 定数書き写し型 `plan-limits.test.ts` / 4 case の `fsrs.test.ts`)。
- しかし伝播せず、**遡及修復された**: mock-echo file は機能ごと削除(ad9566b)、`dashboard-actions.test.tsx` は実 fake-indexeddb + 200 card ground-truth 比較に書き直し。
- 品質向上の転換点: 05-25 以降 sync 層が実 Dexie(fake-indexeddb)基準に / 05-31 `apply-card-mutation` で **eq-spy owner-scope パターン発明** → 以後の repo 標準に伝播 / 07 月 DDD F3 期の domain テストがリポ内最良(全遷移対 9 組の機械列挙・境界 pin・回帰形 pin)。
- 定量: 3658 tests / skip 0 / expect(true) 型 0 / expect なし it-block 2/1,891(いずれも RTL の throwing query = 正当)/ snapshot 83 は全て tests/contract のインライン契約 pin(正当用途)/ クリティカル路のトートロジー率 ~3%。

## 変異チェック実測(隔離 worktree・baseline 3658 green 確認済)

| # | 変異 | 実行範囲 | 結果 |
|---|------|---------|------|
| E1 | `lib/fsrs.ts` RATING_MAP の Hard(2)↔Good(3) 入れ替え | **full suite** | **すり抜け(3658 全通過)** |
| E2 | `lib/exams/list.ts:63` exam 詳細の `eq(exams.userId, userId)` 除去 | **full suite** | **すり抜け(3658 全通過)** |
| M2 | `lib/ai-usage-mcq.ts:86` 月次上限 `>` → `>=` | 対象 file | 捕捉(1 fail) |
| M3 | `upload-guard.ts:113` 日次上限 `>=` → `>` | process.test.ts | 捕捉(2 fail) |
| M4 | `session-aggregate.ts:203` correct 判定 `>= 2` → `> 2` | 対象 file | 捕捉(1 fail) |

## 確認された穴(要対処)

### G1: FSRS RATING_MAP が無防備(E1 実証)【Important】

`lib/fsrs.test.ts` は Again<Easy の相対順のみ検証、数値 golden pin がリポ全体に皆無。中間 rating(Hard/Good)の取り違えは学習ループ全体を静かに壊すがスイートは検出不能。
**Fix 案**(安価): RatingInt 1..4 → ts-fsrs enum の対応 4 assertion + 固定日時での `rate()` 出力値 golden pin を `lib/fsrs.test.ts` に追加。

### G2: `lib/exams/list.owner-isolation.test.ts` が空検査(E2 実証)【Important・セキュリティ表示の齟齬】

file header は「WHERE 句が user_id で正しく絞っているかの回帰防止」と主張するが、chain-proxy mock が `where()` 引数を全て握り潰すため owner 絞りを消しても通過。read path(exam 一覧 / 詳細 / cards)5 query(list.ts:35,63,112,155,182)の tenant 分離が実質未検証。2026-05-19 製で、05-31 に repo が発明した eq-spy パターンへ未改修の唯一の残骸。
**Fix 案**: `cards-delta.test.ts:266` の eq-spy パターン or `subscription-repository.test.ts:97` の verbatim-WHERE パターンで改修(または file 名から owner-isolation 主張を外す)。

### G3: `app/(app)/app/settings/actions.test.ts` — Stripe billing portal 成功経路が未検証【Important】

guard 経路 2 test のみ。`billingPortal.sessions.create` に `stripeCustomerId` / `return_url` が渡ること・`redirect(session.url)` 発火が未 pin。決済隣接で唯一の実質穴(actions.ts は 24 行なので絶対リスクは小)。

### Minor(記録のみ可)

- 日次上限に「limit-1 → 通過」の明示 case なし(危険方向 = at-limit ブロックは pin 済)。
- pull stream の eq(userId) 構造 pin が cards/exams/tombstones のみ(tag-categories / tag-options / card-tags / study-days は未 pin)。
- `exam-card-table.test.tsx` の Tailwind class pin 群(py-1 等)は cosmetic 変更で割れる脆さ(意図的 regression pin とコメントあり)。
- トートロジー小群: `plan-limits.test.ts:5-32`(7/13 が定数書き写し)、`plan-catalog.test.ts:14-28`(価格再掲 3 test — 金額変更検知としては擁護可)、`ocr.test.ts:626`(定数 1 件)。
- `use-tag-sortable-sensors.test.ts:36-55` / `color-palette.test.ts:15` / `sync-meta.test.ts:24-33` — 設定・定数 pin(回帰価値薄)。

## 強い点(現行パターンとして維持すべきもの)

- **eq-spy owner-scope pin**(apply-card-mutation → card-field-handlers → session-repository → apply-ocr-tags に伝播)。
- **実装を mock しない方針の徹底**: review-events bulk route は実 `replayCard` を意図的に非 mock(DB 書込 assert が実スケジューリング数学を検証)/ Stripe webhook 統合 test は実 `constructEvent` + `generateTestHeaderString`(CLAUDE.md 方針どおり)。
- **schema 駆動不変条件**: clerk webhook の deletion-coverage invariant(Drizzle schema の user_id FK 群と handler の tx.delete 集合を突合 — 新 table 追加漏れで自動 fail)。
- **境界 pin の規律**: 30=limit 許容 / 31 超過、5MiB 丁度、50 ids 丁度、STALE_PROCESSING_MS 丁度、24h 丁度、Dexie includeUpper 罠の due==now pin。
- CLAUDE.md「厚く」対象のうち課金ガード・prefix 検証・webhook 署名/冪等・429 は 3 層(unit / 実 crypto 統合 / wire contract)で pin 済み。**FSRS のみ名目と実態が乖離**(G1)。

## 対処記録(2026-07-17 追記)

G1〜G3 は同日対処済(test-only・実装ロジック不変・[no-review] 経路):

- **G1** → `59eda8f` test(fsrs): RATING_MAP 4 対応を scheduler.next 実引数で pin + 実測 golden(固定日時の due/state/stability/difficulty)。red 検証 = Hard↔Good 変異再注入で 4 fail。
- **G2** → `a5c536e` test(exams): drizzle eq を spy 化し全 5 query の owner 絞りを実引数で pin(chain mock は挙動検証層として存置、header に 2 層構成を明記)。red 検証 = eq(userId) 除去で 1 fail。
- **G3** → `8558ef2` test(settings): 成功経路(customer / return_url / redirect(session.url))を pin。red 検証 = return_url 改変で 1 fail。

gate: full suite 3756 green(+14 test)/ whole-repo lint exit 0 / typecheck exit 0。
Codex 追走(OT 指示・一時 worktree で diff を uncommitted 再現): **clean**(Critical 0 / Important 0 / Minor 0・detector PASS)— raw = `docs/codex/2026-07-17-test-quality-g1-g3.md`。
Minor 群は本監査の記録のまま未対処(OT 判断事項)。

## 追加対処(2026-07-17・OT 判断による 3 件)

### #1 ts-fsrs を exact pin(`80b4412` chore(deps))

`"^5.3.2"` → `"5.3.2"`(caret 除去・resolve 実体 5.3.2 不変・lockfile 差分 specifier 1 行)。理由:

- SemVer は公開 API 互換のみ保証し数値出力の一致は保証しない。patch でも「後方互換なバグ修正」として計算結果が変わりうる。実例: caret 範囲内の 5.4.1 にパラメータ clipping 計算修正 = API を壊さず出力を変える変更。
- スケジューラは数値出力そのものが製品挙動(ユーザーの復習計画を決める)。ライブラリ更新は「内部実装の更新」でなく「スケジュール仕様の更新」として扱う。
- react-markdown / remark-gfm の exact pin 論拠(更新 = 表示仕様の更新)と同形。ts-fsrs は規律制定前から caret のまま残っていた。
- G1 golden が default_w 由来を pin するため、caret のままだと意図しない pnpm update で golden が割れる。

de-risk gate 不要(version 変更なし)。frozen install / typecheck / full test exit 0 確認済。

### #2 G1 記述の訂正(`efff9fa` test(fsrs)・本 doc)

**訂正**: 「ts-fsrs 5.x default params」→「**ts-fsrs 5.3.2(FSRS-6.0)の default params**」。ts-fsrs はライブラリ版とアルゴリズム版が別物(5.3.2 / 5.4.1 とも FSRS-6.0。`FSRSVersion` 実文字列 = `v5.3.2 using FSRS-6.0`)。「5.x」は FSRS-5 と誤読される。golden が何を pin しているかは将来 FSRS-7 系へ移行する時の判断材料になるため、アルゴリズム版が読み取れる形で残す。

**pin 対象の正確な定義**: G1 golden は「**ライブラリ同梱の FSRS-6.0 default weights(`default_w` 21 要素)+ short-term スケジューリング挙動**(enable_short_term: true / learning_steps ["1m","10m"])」を pin しており、**fuzz 無効(enable_fuzz: false = default)に依存**する(fuzz 有効化で due が非決定になり golden 不成立)。stability pin 値 [0.212, 1.2931, 2.3065, 8.2956] = default_w[0..3]、Again difficulty 6.4133 = default_w[4]。app は `lib/fsrs.ts:5` の `fsrs()`(引数なし・全 default・自前 w なし)。

commit 59eda8f の message(「5.x」表記)は書き換えず、test コメント + 本 doc 側で訂正(OT 指示)。

### #3 pull stream 4 本の eq(userId) pin(`e7aff7d` test(db))— Minor 判断の格上げ

監査が Minor に落とした「pull stream 4 本の eq 未 pin」を対処に格上げ。**判断を覆す理由**(記録):

- G2 で `lib/exams/list.ts` に行ったのと同じクラスの pin であり、rating が割れていた。監査 doc は Minor に落とした理由を記録していなかった。
- pull はユーザーのデータ一式をクライアントに返す経路であり、leak 時の blast radius が list.ts より大きい。
- RLS が全 23 テーブルで無効のため、アプリコードの eq(userId) が**唯一のテナント隔離防壁**。
- spy のコストは低い(既存パターン流用・`getDeltaRows` 共有ゆえ 1 file で tag 系 3 経路を被覆)。Minor 化は「フィルタが実在し live leak がない」ことに基づくが、**それは回帰ガードが不要な理由にならない**。

実装: `lib/db/pull-delta.test.ts` 新設(getDeltaRows 直接 pin + tag-categories / tag-options / card-tags の 3 caller が正しい userIdCol を渡すことを pin)+ `study-days-pull.test.ts` に独立 inline query の pin 追加。red 検証 = factory eq 除去で 4 fail / study-days eq 除去で 1 fail / caller 誤 userIdCol(tagCategories.id)で 1 fail、いずれも worktree で実証。

**この pin の限界(test file 冒頭にも明記)**: eq-spy は「eq が userId 列と userId 値で呼ばれた」という**構造の pin であり、テナント隔離の証明ではない**。最終 SQL の WHERE に条件が届いているか / (参照同一性以上の意味で)正しいテーブルの列と比較しているか / 別の条件で無効化されていないか / ストリームの後続チャンクで条件が消えていないか は検証していない。**回帰ガードとしては有効だがセキュリティ保証として数えない**。実効の検証は下記 follow-up(実 PostgreSQL 2 テナント統合テスト)の責務。

## follow-up 台帳(2026-07-17 追加対処時・OT 起票)

1. **実 PostgreSQL による 2 テナント統合テスト(launch blocker)**: user A / user B の fixture を実 DB に入れ、(a) A で引いて B が出ないこと (b) B の ID を指定した更新/削除の影響行数が 0 であること (c) ストリームの全チャンクとページネーションの全ページで混入しないこと (d) user ID をリクエスト由来ではなく Clerk 認証コンテキストからのみ取ること、を検証する。**基盤が存在しない**(pglite / pg-mem / testcontainers いずれも不在・tests/integration は mock DB)ため独立 sprint。現在の eq-spy は SQL の実効を検証していないため、**これが入るまで「テナント隔離は未検証」の状態が続く。外部公開前に必須**。
2. **RLS の導入判断(独立 sprint)**: 現在 RLS は全 23 テーブルで無効。単に有効化するだけでは足りない — テーブル所有者・superuser・BYPASSRLS ロールは RLS を迂回するため、**DATABASE_URL が owner role なら無効**。かつ Clerk + Drizzle 直結では `auth.jwt()` に伝播しないため、**transaction ごとに SET LOCAL で認証済み user ID を渡す設計が要る**(Transaction Pooler ゆえ session 設定は不可)。「導入する」か「導入しない理由を設計記録に残す」かの判断を外部公開前に行う。
3. **レビューログの保持(S2.1 の Step 0 で確認)**: FSRS の ReviewLog(rating / 実 review timestamp / 直前の review timestamp / 適用したスケジューラ設定の version)を正本として保持しているか。保持していない場合、将来のパラメータ再最適化・FSRS-6 → 7 の移行(レビューログの replay による状態再構築)・スケジューリングのバグ修復ができない。**card の状態(due / stability / difficulty)だけでは replay できない**。

## 方法メモ

- subagent 3 体(domain 層 19+9+14+5 file / app 層 89+8 file から 20 サンプル + 1,891 it-block 走査 / クリティカル路 ~390 test 精読)。read-only。
- 変異は scratchpad 下の隔離 git worktree(detached @ 0b43435、node_modules symlink)で実施 — 本 working tree は並走セッション(Sprint T)が使用中のため一切触れていない。全変異は revert 済・worktree 削除済。
