# Dash-1: Home v1 design spec

- 日付: 2026-08-18 / 状態: **ドラフト**(Codex spec review → OT レビュー待ち)
- 入力(正): `docs/superpowers/specs/2026-08-17-dashboard-metric-definitions.md`(**Dash-0 r3 凍結**。以下「定義 doc」。指標の意味は全てそちらが正 — 本 spec は再定義しない)/ 分析 doc v2 §4.3(供給経路)・§4.4(design tokens)・§5(ホーム v1)/ 定義 doc §6 の引き継ぎのうち Dash-1 対象(①実装・②実装・③表示詳細・④・⑥・⑧残・⑨・⑪)
- 消費先: writing-plans(実装 plan)

## 1. 目的と非スコープ

Home(`/app`)を定義 doc の 7 ウィジェット構成に刷新し、そのために必要な最小の機構(選択中試験・daily-new-limit・summary endpoint・origin 列・design tokens)を実装する。

**非スコープ**: Dash-2(`exam_date`・試験日逆算・catch-up バナー・Reflect 完了画面)/ Dash-3(分析ページ・復習正答率の厳密版・`review_logs` index)/ 定義 doc §6-⑩⑬(Dash-3)・⑫(較正データ待ち)・⑭(v1 非消費)/ タグ別推移 delta / W1 の「あと◯日」(exam_date 不在のため描画しない — 定義 doc W1)。

## 2. premise 再検証(2026-08-18・HEAD d80bba4)

Dash-0 の premise(2026-08-17)以降、**コード変更なし**(a7a1a64..HEAD は docs のみ — `git diff --stat` で確認)。spec が依存する事実の追確認:

| # | 事実 | 帰結 |
|---|---|---|
| P-1 | カスタム演習 page は `searchParams` 不使用のまま(`app/(app)/app/study/custom/page.tsx`) | クイック演習の deep link 化は不可 → §7 で受け渡し方式を新設 |
| P-2 | `GET /api/dashboard/stats` は caller ゼロのまま(参照は dashboard-stats.tsx のコメントのみ) | §9 で削除を裁定 |
| P-3 | GET API の既存慣例 = `withReadOnlyAuth`(emptyBody + authFailEvent)+ `withTenantTx` + **owner echo(`owner_user_id`)** + `Cache-Control: no-store` + 失敗 500 `{error:'internal'}`(`app/api/study-days/pull/route.ts` が最小前例) | summary endpoint はこの形をそのまま踏襲(§10) |
| P-4 | collision 比較の対象 field = eventId / cardId / sessionId / selectedAnswerIds / isCorrect / rating / rawAnsweredAt / elapsedMs(`session-repository.ts:CollisionCandidate`) | origin を比較に**含めない**判断の根拠(§11.4) |
| P-5 | 新規カードの教材順 = `base_order` + `compareByBaseOrderAcrossExams`(custom sequential の既存比較器・`lib/cards/domain/card-order.ts`) | 新規選出順に再利用(§8.4) |
| P-6 | `/app` page は billing で `searchParams` を既に読む(Next 15 Promise 形) | `?exam=` の追加は既存パターンに乗る(§6) |
| P-7 | design token 現況 = shadcn 変数系(`:root` の oklch 変数 + `@theme inline` alias、`--chart-1..5` あり)。`app/globals.css` 117 行 | §12 は既存系への追加のみ(新体系を作らない) |
| P-8 | fold の書込は `ReplayCardState` → `applyCardFinalStates` の VALUES 列挙(14 列)。pull は `cards-mapper.ts:toClientCard` の explicit mapper | `first_reviewed_at` 列追加の触点が確定(§8.3) |

## 3. 全体構成

### 3.1 ページ構造

`/app`(RSC)は現行どおり `getCurrentUser()` + `searchParams` のみ(DB SELECT なし — S-perf-3 維持)。ウィジェットは全て client component が Dexie mirror + `useLiveQuery` で算出する。追加の server 読みは W4 の summary fetch(client からの CSR fetch)のみ。

- **評価時刻**(定義 doc §3.9): home の client root(後述 `HomeDashboard`)が mount 時に `now` を 1 回取り、全ウィジェットに prop で渡す。`useLiveQuery` の再評価は Dexie 変化通知で起きるが `now` は据え置き(現行 dashboard-actions と同方針。日跨ぎは再訪で更新 — 既存受容)。
- **性能(共有集計)**: cards を読むウィジェット(W2/W3/W5/W6)は**個別に Dexie を走査しない** — client root の 1 つの `useLiveQuery` が選択試験の cards を 1 回読み、単一 pass の集計関数(§3.2 の分類・述語を消費)で n/m/k・3 区分・各母集合件数・7 日バーを一括導出して props で配る。推定所要時間(N)の標本走査(最大 1,000 行)も root で 1 回だけ(dep = `[userId]`。回答のたびに再走査しない — mount 時値で足りる)。
- **構成順**(分析 doc v2 §5.1): W1 ヘッダ → W2 今日の学習 → W3 状態サマリ → W4 苦手タグ → W5 クイック演習 → W6 今後 7 日 → W7 今週。activity(W7)は最下段(原則 4)。
- 他試験 1 行: ヘッダ直下に「他の試験: 復習 n 件」(選択中以外の全試験の n 合計。0 件なら非表示)。タップで試験切替を開く。
- 既存の `BillingBanner` / 「プラン変更」リンクは現行のまま残す。`DashboardStats` / `DashboardActions` は新ウィジェットに置換して撤去する。

### 3.2 新規モジュール(shared 化 — 定義 doc §7.1 の実装)

```
lib/dashboard/domain/metric-constants.ts   — 全閾値定数(S_MATURE=21, WEAK_LAPSES_MIN=2,
                                             WEAK_TAG_MIN_CARDS=8, WEAK_TAG_MIN_REVIEWS=15,
                                             ESTIMATE_DEFAULT_MS=20_000, ESTIMATE_CAP_MS=120_000,
                                             ESTIMATE_SAMPLE_N=100, ESTIMATE_SCAN_LIMIT=1_000,
                                             WEAK_TAG_TOP_N=3, FORECAST_DAYS=7, QUICK_PRESET_N=10,
                                             DAILY_NEW_DEFAULT=20, STREAK_WINDOW_DAYS=61〈既存を移設せず参照〉)
lib/dashboard/domain/card-classification.ts — 3 区分分類・持ち越し/間違い/未出題/苦手の述語
                                             (pure・client/server 両 import。ts-fsrs 非依存)
lib/dashboard/domain/event-order.ts         — answered_at ASC + event_id ASC の順序規則・
                                             初見/復習分割(pure)
lib/dashboard/domain/estimate.ts            — 推定所要時間の中央値計算(pure。標本は caller 供給)
lib/dashboard/domain/weekly.ts              — 週境界(月曜 00:00 JST)・先週同期間比 delta(pure)
```

R 計算(定義 doc §4-M)は v1 非消費のため**作らない**(§7.1 の module 隔離方針だけ定義 doc に凍結済 — Dash-3 で新設)。日界・streak は既存(`lib/jst.ts` / `lib/streak-core.ts`)を使い新設しない。

## 4. ウィジェット仕様(定義 doc §5 の実装形)

各ウィジェットの指標定義は定義 doc §4 / §5 が正。ここでは実装割当(読み元・component・表示形)のみ定める。

| W | component(新設) | 読み元 | 表示 |
|---|---|---|---|
| W1 | `home-header.tsx` | Dexie `exams`(owner scope) | 試験名 + 切替 dropdown。「あと◯日」は描画しない(Dash-2) |
| W2 | `today-study.tsx` | Dexie `cards`(`[user_id+exam_id]`)+ ローカル `answer_events`(N 標本) | 「残り y 問・約◯分」+ primary CTA「学習を始める」+ 内訳「復習 n(持ち越し m 含む)・新規 k」。**k は残り枠であり 1 セッションで全件出るとは限らない**(§8.5)。y===0 → 「いま解く対象はありません」(副導線 = クイック演習へ。「明日は約◯問」は**出さない** — 定義 doc W2-e を「出さない」で確定。見込み値の定義がなく、誤った約束を避ける) |
| W3 | `state-summary.tsx` | Dexie `cards` | 3 状態を横並びカウンタ、持ち越しは**下段に別行**(「持ち越し ◯件」+ 演習導線)— 「3 + 別段」の実装形 |
| W4 | `weak-tags.tsx` | `GET /api/stats/summary`(§10) | 診断文 1 行 + 3 行(タグ名〈カテゴリ名添え〉・復習正答率・対象問数〈「◯問」〉)+ 「この分野を 10 問」ボタン。候補 0 → widget 非表示 / fetch 失敗 → **非表示ではなく**「読み込めませんでした」1 行(§3.8 の失敗区別。陳腐表示は実装しない — 定義 doc の保守側裁定を採用)。**fetch race**: 応答に載せた exam_id と現在の選択試験を突き合わせ、不一致の遅着応答は捨てる(試験切替時の誤表示防止) |
| W5 | `quick-practice.tsx` | Dexie `cards`(+ N) | 5 ボタン(間違い / 未出題 / 苦手 / 10分 / カスタム)。母集合 0 → disable |
| W6 | `week-forecast.tsx` | Dexie `cards` | ミニバー 7 本。今日バーは持ち越し合算(バー内の色分けで持ち越し分を区別 — token `--color-carryover`) |
| W7 | `week-activity.tsx` | Dexie `study_days` | 「今週(全試験)」見出し + 回答数(先週同期間比 delta)・学習日数・連続日数(61 日で「61 日以上」)。**今日の学習量(定義 doc §4-R)はここに併置する**(「今日 ◯問(全試験)」— §6-⑪ の消費先裁定。旧 DashboardStats の値の受け皿。※ retrievability の R〈定義 doc §4-M〉とは無関係 — v1 非実装) |

- delta 表示は §3.10(符号付き整数)。「先週同期間比」のラベルは「先週同時点比 +18」形式で表示し、説明しきれなければ **v1 で delta を落としてよい**(定義 doc §4-Q の判断余地 — 実装時に UI 上の一言で説明できなければ落とす。落とした場合は session doc に記録)。
- W4 の「この分野を 10 問」= クイック演習の受け渡し機構(§7)に `tag_option_id` を積む(origin = `home_weak_tags`)。

## 5. 空状態(分析 doc v2 §5.2 / 定義 doc §3.7)

**前段の制御状態(空状態とは別)**: ① **初回 pull 未完** — 判定不能の間は skeleton(§6 の完了シグナルを待つ。`useLiveQuery` undefined は「クエリ未完了」しか意味しないため判定に使わない)。② **試験未選択**(複数試験で解決不能)— ウィジェットは描画せず試験選択 UI のみ。この 2 つを通過してから下表を判定する。

| 状態 | 判定(client・Dexie) | 表示 |
|---|---|---|
| 試験 0 | 初回 pull 完了後に `exams` count 0 | hero「画像 / PDF から問題集を作る」CTA のみ(→ `/app/upload`)。ウィジェット描画なし |
| 試験あり・カード 0 | 選択試験の cards 0 件 | W2 を「この試験にはまだ問題がありません」+ upload 導線に差し替え。他ウィジェットは非表示(母集合 0 の空) |
| カードあり・学習 0 | 選択試験の cards > 0 かつ全て state=0 | W2 を「最初の◯問を解く」+ 未学習総数の形に差し替え。件数 = `min(QUICK_PRESET_N, k)`(**K=0 なら k=0 → この CTA は出さず「現在の対象なし」に落ちる** — daily-new-limit と衝突させない) |
| 現在の対象なし | W2 の y === 0 | W2 内の空状態(§4 の表)。他ウィジェットは通常描画 |
| 履歴僅少 | W4 候補 0 / W7 先週データなし 等 | 各ウィジェット個別 degrade(定義 doc 各節)。ページレベルの分岐はしない。**fetch 失敗との混同禁止**(W4 は §3.8 の区別) |

先取り復習の導線はどの状態でも出さない(裁定済)。

## 6. 選択中の試験(定義 doc §6-② の実装)

- **URL が正**: `/app?exam=<uuid>`。RSC は billing と同様に抽出して client root へ prop。
- **保存**: `sync_meta` に新 key `selected_exam`(`SYNC_META_KEYS` へ追加)。`setJsonSyncMeta` / `getJsonSyncMeta` + zod `{ exam_id: z.uuid() }`(Grid-1 `exam_view_prefs` 前例)。**`scopedSyncMetaKey` 経由なので既存 local-hygiene(sign-out purge / sign-in sweep)の掃除射程に自動で入る** — 掃除経路の追加実装なし。
- **共通 resolver**: 解決ロジックは 1 関数 `resolveSelectedExam`(client helper)に置き、**home / smart / quick の 3 入口が同じものを使う**(独自実装の乖離防止)。解決不能(未選択)時の戻り先は home(試験選択 UI)。
- **解決順**: ① URL の exam が Dexie `exams`(owner scope)に実在 → 採用 + 保存 ② 保存値が実在 → 採用 + URL へ反映 ③ 試験がちょうど 1 件 → 自動選択 + 保存 ④ 複数 → 試験選択 UI を表示し、選択で確定 + 保存。無効 ID(削除済み・他 owner・非 uuid)はどの段でも破棄して次の段へ進み、**URL に残っていれば除去(正規化)する**。
- **URL 更新の規約**: `router.replace` は **既存の他 query param(billing 等)を保持**して `exam` のみ書き換える。**URL 正の不変条件 = 有効な URL 値を保存値が上書きすることはない**(別タブで保存値が動いても、このタブの URL が有効な限り表示は変わらない)。
- **再解決の契機**: 選択中 exam の行が mirror から消えた(削除・pull 置換)ことを `useLiveQuery` で検知したら resolver を再実行する。
- 切替: W1 dropdown で選択 → URL 書き換え + 保存。**server 設定化しない / 端末間・タブ間の揺れは受容**(裁定済)。
- **初回 pull 完了の判定**: `useLiveQuery` undefined では判定できない(クエリ未完了しか意味しない)。**`PullTrigger` が「初回 pull の settle(成功 / 失敗を問わない終了)」を公開する軽量シグナルを追加**し(実装形 — context か module event か — は plan)、「試験 0」等の確定判定はそれを待つ。settle 前は skeleton。pull 失敗で settle した場合は mirror 現状で判定(オフラインでも既存 mirror があれば通常描画)。

## 7. クイック演習の受け渡し(定義 doc §6-④ の裁定)

**新規 route `/app/study/quick` を新設**し、preset は `searchParams` で渡す(P-1 により既存 custom への deep link は不可。custom form への搭載は「即開始」にならないため不採用)。

- URL: `/app/study/quick?exam=<uuid>&preset=mistakes|unanswered|weak|ten_min[&tag=<option_id>]`
- RSC(`quick/page.tsx`)は smart/page.tsx と同型: `user_settings`(session_limit / fsrs_mode)を読み client host へ。
- client host が Dexie から母集合選定(定義 doc W5 の母集合・選出規則)→ 既存 `SessionLauncher` / `SessionRunner` にそのまま接続(**演習 UI は一切新設しない**)。
- `tag` param は W4「この分野を 10 問」用: 母集合 = 当該タグが付く選択試験内カード、順序 = due ASC、件数 = 10。
- 件数は `QUICK_PRESET_N`(10)/ ten_min は N ベース計算(定義 doc W5)。`user_settings` cap が小さければ cap 優先(裁定済)。
- preset 名と origin 値(§11)は 1:1 対応。

## 8. daily-new-limit 機構(定義 doc §6-⑥ の全責務)

### 8.1 K(上限)の置き場と設定面

- **`exams.daily_new_target` 列を追加**(integer nullable、**null = 既定** `DAILY_NEW_DEFAULT` = 20。CHECK `exams_daily_new_target_nonneg`: `>= 0`。0 = 新規を出さない)。試験ごと(分析 doc v2 §4.2 の方針)・Dash-2 の試験日連動(自動計算値への置換)に接続する土台。
- 設定 UI: 試験ごとの設定として **rename と同じ場所**(試験一覧の行メニュー / 試験詳細)に「新規/日」数値入力。server action `update-exam-daily-new-target`(rename-exam.ts と同型: 認証 → 検証 → UPDATE → `content_version`/`updated_at` bump)。**exams は outbox に載せない現行原則を維持**(server action 直・pull で mirror 反映)。
- 触点: `lib/db/schema.ts` + migration **0040** / `exams-pull.ts:toClientExam`(explicit mapper — 追記必須)/ `ClientExam` 型(index 不要 → Dexie version bump 不要)。

### 8.2 u(当日導入数)の意味

定義 doc W2(r3)のとおり: u = 当該 JST 日に選択試験で「New 状態のカードに最初の applied 回答が行われた」カード数。

### 8.3 u の永続化 = **`cards.first_reviewed_at` 列(server 契約の新設を提案)**

- **提案**: `cards.first_reviewed_at`(timestamptz nullable)を追加し、**fold が state 0 → 非 0 の遷移時に、その遷移を起こした applied event の `answered_at` を一度だけ書く**(以後不変)。
- u の導出(client・オフライン可): `count(Dexie cards where exam_id = selected && first_reviewed_at != null && todayInJst(first_reviewed_at) === today)`。
- **選定理由**(代替との比較):
  - (a) 本案 — 端末間整合は**既存 pull がそのまま運ぶ**(fold は cards.updated_at を bump するので増分に自動で乗る)。専用カウンタ表・専用同期なし。カード移動 = exam_id 現在値で数える(タグ集計 §3.5 と同じ現在状態意味論 — 移動先の枠を消費)。削除 = 行ごと消えて枠が戻る。account-wide の一貫性は server の cards 行が単一の真実であることから従属的に得られる(**新しい server 契約は「fold がこの列を 1 回書く」の 1 点のみ**)
  - (b) `sync_meta` ローカルカウンタ — 端末間不整合(2 端末で各 K 件導入できる)・リセット規則の自作が必要 → 不採用
  - (c) `review_logs`(`state_before = 0`)からの server 集計 — オフライン不可・読み取り index 追加が必要・W2 が L3 依存になる → 不採用
- **書込契約(一意化)**: fold は増分適用(現 DB 行からの fold・全履歴 replay ではない)。`first_reviewed_at` は **tx 内で `initial.state === 0 && final.state !== 0` の遷移が起きたときだけ**、その遷移を起こした最初の applied event の `answered_at`(clamp 済)で 1 回設定し、**以後どのイベントでも書き換えない(処理順の先着固定)**。遅延到着した過去イベントは (a) card が既に非 New なら遷移が起きないので触らない (b) `>=` 順序ガードで skip された event は fold に入らないので影響しない。「歴史上最古のイベントの時刻」への遡及修正は**しない**(不変性 > 履歴再構成 — R0 の verbatim 主義と同型)。
- **日界の時刻源** = `answered_at`(clamp 済)を `todayInJst` に通す — **`study_days` と同一の時刻源・同一の日界**(二重定義しない)。client 時計の過去方向ずれは study_days 同様に受容(未来方向は clamp 済)。
- **保証レベル = soft limit(明示)**: server は超過回答を**拒否しない**(Sprint A の全受理設計と衝突するため hard limit は不採用 — 回答を分析上の枠制御で落とさない)。強制点は**選定時のみ**(§8.5)。したがって flush 前の連続セッション・複数端末・複数タブでは一時的に K を超えて導入できるが、mirror 収束後は remainingBudget = 0 に戻り以後選ばれない。account-wide の hard 保証が必要になったら server 側の予約契約が要る — v1 では作らない(YAGNI)。
- **導出型 u の帰結(承認ポイント)**: カード削除 → 行ごと消えて**当日枠が戻る**。試験間移動 → **移動先の試験の当日枠を消費**(現在状態意味論 — タグ集計 §3.5 と同型)。「その日に実際に導入した累計」ではなく「現存カードで数える」設計であり、通常期待とずれうるため OT 承認事項として明示する。
- 既存行の backfill = **null のまま**(「導入日不明」→ 今日ではない扱い = 枠を消費しない。稼働初日だけ上限が甘くなりうるが、ユーザー実質 0 のため受容)。Dexie の保存済み旧行も field 欠落 = null 扱い(optional・mapper で自然互換)。
- 触点(P-8): `schema.ts` + migration 0040(8.1 と同一 migration)/ `ReplayCardState` に `firstReviewedAt: Date | null` を追加し `replayCard` が遷移時に設定(pure のまま)/ `applyCardFinalStates` の VALUES 列 +1 / `cards-mapper.ts:toClientCard` / `ClientCard` 型(index 不要 → Dexie bump 不要)/ `initialFsrsState` に `firstReviewedAt: null` / client 楽観更新(`runOptimistic*` 系で回答時に設定するか)は**しない** — u の即時性は pull-back(flush 後の cards 引き直し)で足り、二重実装を避ける(遅延は flush 間隔ぶん。W2 の k が数問ぶん遅れて減る UX は受容し、session 内の強制(§8.5)は session 開始時の選定で担保する)。

### 8.4 新規カードの選出集合と順序

- 選出集合 = 選択試験の state=0 カードから **`base_order` 昇順(同値は `id` 昇順)で先頭 k 件**(P-5 の既存比較器を再利用。教材の順どおりに導入する)。
- **定義 doc W5 の未出題プリセット順序をこれに合わせて変更する**: 定義 doc は「due ASC(新規では実質生成順)— §6-⑥ と同時確認」と留保していた。裁定: **未出題(= 全カード state=0)は base_order 昇順**、間違い・苦手(state≠0 主体)は due ASC のまま。凍結 doc からの差分はこの 1 点で、留保されていた確認の解であり定義の変更ではない。

### 8.5 CTA への強制と later-due 出題意味論

**スマート復習(W2 CTA の遷移先 `/app/study/smart`)の選定を W2 契約に変更する**:

- 出題プール = **復習部** + **新規部**(§8.4 の k 件・base_order ASC)の連結。復習部が先。復習部の切り方は state で分ける:
  - **Review(state 2)**: `due < jstDayRange(today).endAt` — **当日 later-due の前倒し出題を許す**(Review の due は day 粒度運用が標準で、数時間の前倒しは無害。翌日以降の undue 先取りは引き続きしない)
  - **Learning / Relearning(state 1/3)**: `due <= now` のまま — **分〜時間単位の短期 step を前倒ししない**(step 間隔は FSRS の短期記憶スケジュールそのものであり、朝に夜の step を出すと壊れる)。step 時刻が来れば CTA 再押下 / 次セッションで自然に入る
  - 並びは due ASC(部内)
- **n(表示)とプールの既知の微小差**: 定義 doc W2 の n は state 1/2/3 一律「今日の終わりまで」で凍結済み。プールは上記のとおり Learning/Relearning の未到来 step を含まないため、**その分だけ一時的に プール件数 < n になる**(対象は通常数分〜数時間後に解消する短期 step のみ)。y は「今日やる量」の表示として正しく、プールは「いま出せるもの」— この差は仕様として受容し、UI で「◯問はまもなく出題可能」等の補足はしない(v1)。
- これにより (1) 新規は k 件で打ち切られ(daily-new-limit の選定時強制)、(2) Review の later-due が処方と一致し、(3) 新規部の順序が教材順に確定する。
- **新規の位置づけ = 上限であって目標ではない**: 復習部が `session_limit` 以上ある日は、cap により**当該セッションに新規が 1 件も出ない**。これは「復習が溜まっている日は新規を始めない」という FSRS 運用として意図どおり(復習を消化してセッションを重ねれば同日中に新規に到達する)。W2 の内訳 k は「プール上の残り枠」であり 1 セッションで全件出るとは限らない — W2 に 1 行注記する(§4)。
- 現行との差分: `due <= now` 1 本 → 上記 2 部 3 条件、New 無制限混入 → k 件制限 + 順序分離、**exam 横断 → 選択試験スコープ**(W2 が試験主体である以上 CTA も選択試験に絞る。全試験をまとめて回す動線は他試験 1 行から各試験へ)。
- **入口の棚卸し**(挙動変更の影響面): `/app/study/smart` への導線は現 repo では home の `DashboardActions`(本 sprint で W2 に置換)のみ — nav / 他画面からのリンクは grep 0 件(plan で再確認)。bookmark 直行は §6 の resolver で試験解決。通知・外部導線は存在しない。
- `session_limit` cap(既定 20)は従来どおりプールの先頭 N で適用。y > cap のときは 1 セッションで消化しきれず、CTA 再押下で続き(回答済み分は flush + pull-back 反映後に除外 — **反映前の即再押下では同じカードが再度出うる**。既存挙動と同じ受容)。
- **client / server fallback の同値性**: 選定は client(Dexie)が主・server が fallback の 2 実装。プール述語・順序・k 計算は shared 関数(§3.2)に寄せ、**同一 fixture で両経路のプール一致を pin する**(§13.2)。
- **URL / exam 解決**: W2 CTA は `/app/study/smart?exam=<uuid>&origin=home_today` で遷移。exam param 不在の直接遷移(bookmark)は §6 と同じ解決順(保存値 → 1 件自動 → 選択要求は home へ誘導)で選択試験を決める(origin は `smart`)。
- 触点: `get-dexie-session-cards.ts` / `get-session-cards.ts`(server fallback)に exam scope + 上記 2 部構成を実装(署名変更)。`smart/page.tsx` が searchParams(exam / origin)を読む。`study-session-host.tsx` に examId / origin prop。旧挙動の test は新契約へ書き換え(**保証減ではなく契約変更** — red 検証は新 pin 側で実施)。

### 8.6 日界・リセット

u は導出値なので「リセット」は存在しない — `todayInJst` が変われば自然に 0 から数え直る(日界の二重定義なし)。K 変更は即時反映(remainingBudget が負なら 0 clamp — 定義 doc の式どおり)。

## 9. L2 供給経路と dead route(定義 doc §6-⑨⑪)

- **供給経路 = 既存のまま・新設なし**: mount 照合 = `/app/*` layout の `PullTrigger`(`pullAllStudyDays` 90 日 snapshot)、セッション終了照合 = flush 成功時の `pull-back`(cards + study_days 引き直し)。分析 doc §4.3 の「mount 時とセッション終了時に照合」は**両方とも既存実装で成立済み**であることを確認した — W7 / R は Dexie mirror を読むだけ。
- マージ規則(§6-⑪): `study_days` mirror は **owner 限定 delete + bulkPut の全置換**(既存・`db.transaction('rw')` 内で原子的 — delete と put の間の空表示は構造的に出ない)であり、ローカル即時値と server 値の「マージ」は発生しない — W7 と今日の学習量は常に mirror(= 最後に成功した server snapshot)を表示する。未 flush のローカル回答は**反映されない**(数問の遅延。flush 間隔・セッション終了 flush で追いつく)。これを v1 の仕様として明記し受容する(ローカル answer_events を混ぜる二重集計はしない — 端末間不一致の再導入になるため)。
- **鮮度の既存受容(明記)**: mount pull 失敗・pull-back 失敗時は前回 snapshot のまま表示され、次のトリガー(再訪 / 次 flush)で自然回復する — 既存の失敗時不変設計そのもので、W7 に鮮度表示は付けない(L2 は §3.8 の UI 区別対象外 — 定義 doc の規約どおり)。
- **dead route `GET /api/dashboard/stats` は削除する**(§6-⑨ の裁定提案): route.ts + route.test.ts を撤去、`dashboard-stats.tsx` は W7 置換で消えるため参照も同時に消滅。`lib/db/streak.ts`(server 版 stats)は他 caller が無ければ同時撤去(plan で caller 確認)。削除理由 = caller ゼロ 2 ヶ月・照合値の供給は `/api/study-days/pull` が担っており役割が無い。**外部消費者の不在**: 本 app に公開 API 契約は無く(API docs / 外部 client / cron からの参照とも repo・vercel.json に 0 件)、社内(claude.ai / OT 運用)での手動利用も記録なし(記録の不在 = 事実の不在ではないため、push 前レビューで OT に 1 行確認)。復活は git 履歴から可能。

## 10. summary endpoint(W4 用・v1 の唯一の L3)

- **`GET /api/stats/summary?exam_id=<uuid>`**(P-3 の慣例踏襲: `withReadOnlyAuth` + `withTenantTx` + owner echo + no-store + 失敗 500)。
- 応答: `{ owner_user_id, exam_id, weak_tags: [{ option_id, name, category_name, review_accuracy, card_count }] }`(Top 3 まで server で確定 — 定義 doc §4-P の候補条件・順位・同率規則・30 暦日境界をそのまま実装。`exam_id` echo は client の race 破棄用 — §4 W4)。`exam_id` 不正 / 欠落は 400。候補 0 件は `weak_tags: []`(200)。**他 owner / 実在しない exam_id も `weak_tags: []` の 200**(tenant tx の WHERE user_id で自然に空になる — 存在有無を漏らさない)。
- **SQL 契約(一意化)**:
  - 復習イベント判定 = user の `applied = true` の answer_events を **card ごとに全期間で** `answered_at ASC, event_id ASC` の番号付け → **rank ≥ 2** が復習イベント(30 日窓内だけで番号付けしない — 初見の誤分類を防ぐ)
  - 30 暦日境界 = `answered_at >= jstDayRange(addDays(todayInJst(receivedAt), -29)).startAt`。**`receivedAt` を handler 冒頭で 1 回だけ取り**、境界と応答全体で単一の評価時刻を使う
  - `review_accuracy` = `round(100 * 正答復習イベント数 / 復習イベント数)` の整数(§3.10)。分母は候補条件(≥ 15)で 0 除算が構造的に起きない
  - 同率順位の `option_id` 昇順 = **uuid の text 表現の昇順**(`ORDER BY option_id::text`)— client 側 JS 比較と同じ順序系に固定
  - タグ母集合は現存 cards ⋈ card_tags(削除カードは自然に落ちる — §3.3a)。option / category の name は応答時点の現在値
  - 閾値・順位・同率は shared 定数 / 規則(§3.2 の domain module)を import(SQL に数値を直書きしない)
- 分析ページ用の拡張はしない(肥大化禁止 — Dash-3 は別 endpoint)。
- client: `weak-tags.tsx` が mount 時 + 試験切替時に fetch。owner echo 検証(study-days.ts と同型の reject)+ exam_id echo で遅着応答破棄。再取得ボタンは付けない(再訪で再 fetch)。

## 11. origin 列(answer_events)

### 11.1 値体系

`origin` = **「そのセッションがどの入口から開始されたか」のセッション定数**。event ごとに変わらない(client は session launcher の prop から全 event に同値を刻む)。

| 値 | 入口 |
|---|---|
| `home_today` | W2 CTA(→ /app/study/smart) |
| `home_quick_mistakes` / `home_quick_unanswered` / `home_quick_weak` / `home_quick_10min` | W5 の 4 preset(→ /app/study/quick) |
| `home_weak_tags` | W4「この分野を 10 問」(→ /app/study/quick?tag=) |
| `smart` | /app/study/smart への直接遷移(URL 直・bookmark。query に origin 指定が無い場合の既定) |
| `custom` | カスタム演習 |

従来値との関係: 従来 origin は存在しない(全行 null)。`smart` / `custom` は「ダッシュボード外の従来経路」を表す新値であり、null は「origin 導入前の履歴」を意味する — 3 者を混同しない。

### 11.2 集計単位と成功指標

成功指標②(推奨演習の実行率)の分子 = **「1 問以上回答したセッション」= 当該 origin の applied event が 1 件以上ある distinct `session_id`**。クリック(遷移)は数えない — 回答 0 のセッションは event が server に届かず構造的に数えられず、これが意図と一致する。session_id null の event(理論上 wire optional)は集計から除外。origin 混在 session(規約違反)は `distinct (session_id, origin)` で数え、混在自体は検証しない(分析ラベルであり整合保証の対象でない)。v1 では**集計 UI は作らない**(SQL 手動集計で足りる — 蓄積の開始が目的。「今日記録しないものは永久欠損」)。

### 11.3 schema / wire

- DB: `answer_events.origin` **text nullable・CHECK なし**。CHECK を張らない理由: origin は分析ラベルで整合保証の対象でなく、語彙拡張のたびに DB CHECK + iso 追随 + deploy 順序制約(entity_type の前例)を払うコストに見合わない。
- wire(`answer-event-schema.ts`): `origin: z.string().max(64).optional()`。**enum reject にしない** — 未知値で 400 にすると、分析ラベル 1 つが回答 batch 全体の同期を止める(rollback・server/client の version 共存・長期滞留 outbox で現実に起きる)。**server ingest が既知集合(shared 定数 `ORIGIN_VALUES` — client/server 同一 import)で判定し、未知値は null に正規化して保存**(+ `logger.warn` 1 行で観測可能に)。語彙の正は `ORIGIN_VALUES` の 1 箇所。
- 互換: 旧 client → origin 無し(optional)。新 client → 旧 server(rolling 共存の瞬間)は zod object の unknown key strip で無害に落ちる。どの順でも回答同期は止まらない。
- Dexie `ClientAnswerEvent`: `origin?:`(index 追加なし → **version bump 不要**。保存済み旧行は field 欠落 = 送信時 undefined で自然互換)。

### 11.4 触点の全列挙(Sprint A パターン準拠・fact-finding §10 の表を確定)

| 層 | file:symbol | 変更 |
|---|---|---|
| DB | `lib/db/schema.ts:answerEvents` + migration 0040 | 列追加(nullable・CHECK なし・index なし) |
| wire | `lib/sync/shared/answer-event-schema.ts` | `origin` optional enum 追加 |
| client 型 | `lib/client-db.ts:ClientAnswerEvent` | `origin?` 追加 |
| client write | `lib/sync/review-events.ts`(`RecordAnswerEventInput` / `recordAnswerEvent` / `toWireInput`) | 3 箇所に透過 |
| UI 経路 | `session-runner.tsx`(recordAnswerEvent 呼出)← `SessionRunnerProps` ← `session-launcher.tsx` ← `study-session-host.tsx` / `custom-session-flow.tsx` / 新 quick host | sessionId と同じ props chain。各 host が自分の origin 値を確定 |
| ingest | `lib/reviews/ingest-review-events.ts`(row 組み立て) | `origin: ev.origin ?? null` |
| repo | `session-repository.ts:AnswerEventInsertRow` / `insertAnswerEvents` | 列 +1 |
| **collision** | `CollisionCandidate` / `verifyEventCollisions` | **比較に含めない**(P-4 の現行 8 field を維持)。理由: origin は回答内容でなく metadata であり、client 更新前後の再送(旧 client の再送に origin が無い)で内容一致比較が偽陽性の collision を出すのを避ける。**先着固定 — 既存行の origin は再送で更新も補完もしない**(null 行への後付け補完もしない。冪等の単純さ > 導入期の計測欠損。欠損は origin 導入後の新規セッションで自然に解消する) |
| review_logs | — | 変更なし(origin は持たない — event_id JOIN で取れる値を二重化しない・R0 方針) |
| 契約テスト | `tests/integration/pg/answer-events-serialization.test.ts` | schema contract describe は PK/FK/CHECK を定義文まで pin — **CHECK を増やさないので既存 pin は green のまま**が期待値。列追加で red になる pin があれば「保証不変の追随」として更新(§13) |
| test 資材 | answer_events 系の fixture / factory(iso 3 本 + unit) | optional 列ゆえ既存 fixture は無変更で green。origin を検証する新 test のみ値を供給 |

## 12. design tokens(分析 doc v2 §4.4)

既存の shadcn 変数系(P-7)への**追加のみ**。新体系・新ファイルを作らない(`app/globals.css` の `:root` + `@theme inline` に追記)。

- **semantic 追加**: `--success` / `--success-foreground` / `--warn` / `--warn-foreground`(danger は既存 `--destructive` を使う — 別名を作らない)/ `--carryover`(持ち越しの横断指標色 — W3 別段・W6 バー内区別で共用)/ 定着度スケール `--maturity-1..3`(未学習 → 学習中 → 定着の **MECE 3 区分のみ**。持ち越しは直交する横断指標なので同一スケールに載せない — 定義 doc §4-D の「3 + 別段」を token 構造にも反映)。
- **chart 色**: 既存 `--chart-1..5` に `--chart-6` を追加(6 色系 — 分析 doc 指定)。
- spacing / radius / type scale は**既存の Tailwind 既定 + `--radius` 系をそのまま使う**(v1 で独自 scale を導入しない — 簡潔性規律。分析 doc の「spacing・radius・type scale」は既存系で充足していると整理し、不足が出たら Dash-3 で拡張)。
- **ウィジェットカード部品 1 つ**: `app/(app)/app/_components/widget-card.tsx` — slot 構成 `{ header, metric, delta?, action?, children? }`。W2〜W7 全カードがこれを使う(Delta スロットは W7 が消費。原則 3 の要件)。shadcn `Card` の上に薄く被せる(新 primitives を作らない)。**部品は骨格のみ**: heading は h2 固定(ページ h1 の下の一貫階層)、loading / empty / error の状態表現は各ウィジェットの責務(部品に状態 API を持たせない — YAGNI)。
- **a11y 受け入れ基準**: semantic 追加色は light/dark 両方で WCAG AA コントラストを満たす値を選ぶ(既存 shadcn 変数の水準に合わせる)。**W6 の持ち越し区別を色だけに依存させない**(バー分割位置 or パターンを併用)。delta の正負も符号(§3.10)が主・色は補助。
- 具体色値は実装時に `frontend-design` skill で決定(紫グラデ・白カード羅列の禁止は CLAUDE.md 既定)。ダーク対応は現行 `.dark` ブロックの慣例に従い両方に定義。

## 13. テスト戦略と pin(定義 doc §7.2 の実装割当)

### 13.1 新規 pin の実装先

| 定義 doc pin | 実装先 |
|---|---|
| 分類 client/server 一致(pin 1) | iso: 実 PG に fixture cards → server 経路(summary の分類)と domain 関数直呼びの一致。Dexie 側は unit(ISO 文字列入力) |
| タグ別・境界(pin 2, 17) | iso: summary endpoint に fixture(7/8 カード・14/15 復習イベント・30 日境界の前後) |
| 初見/復習・同時刻決定性(pin 3 相当) | unit(event-order.ts)+ iso(summary の 2 件目以降判定) |
| 日界跨ぎ(pin 3) | iso(summary)+ unit(weekly.ts) |
| 未学習が持ち越し/今日バーに入らない(pin 4, 5) | unit(card-classification.ts / W6 集計関数) |
| lapses 系(pin 10, 16) | unit(苦手述語 — Review・S<21・lapses 2 のカードが入る / Learning Again で増えない再現は replay-card の既存実測 fixture を流用) |
| N 境界・走査上限(pin 11, 18) | unit(estimate.ts)+ Dexie 走査は fake-indexeddb unit |
| 週 delta 同期間比・月曜/行なし非表示(pin 14) | unit(weekly.ts — 木曜 fixture で月〜水 vs 先週月〜水) |
| W2 n の日単位切り(pin 15) | unit(23:59 due IN / 翌 0:00 due OUT)+ 出題プール側にも同 pin(§8.5 の `due <= now` 退行検出) |
| streak 61 頭打ち(pin 12) | unit(表記関数) |
| FSRS 乖離(pin 9) | 既存 replay-card 系 unit に fixture 追加 |
| 削除の非対称(pin 13) | iso(card 削除 → summary から消える / study_days 不変) |

(pin 6, 7, 8 = R 計算系は v1 非実装のため **Dash-3 へ持ち越し** — 定義 doc の pin 一覧に対する差分として明記。)

### 13.2 新機構の pin

- **daily-new-limit**: fold が `first_reviewed_at` を初回のみ書き 2 回目以降不変(iso)/ **遅延到着した過去 event で書き換わらない**(iso — 先着固定の pin)/ u 導出の日界(unit)/ 出題プールが「復習部 → 新規 k 件」で k 超の New を含まない(unit・red 検証は k+1 件目の混入変異)/ **Learning/Relearning の未到来 step がプールに入らず、Review の当日 later-due は入る**(unit — §8.5 の state 別条件)/ K=0 で新規 0(unit)。
- **client/server 選定同値性**: 同一 fixture(JST 境界・later-due・New 混在・cap)で Dexie 経路と server fallback のプールが一致(unit ×2 経路 + iso)。
- **origin**: wire 透過(unit)/ ingest で**未知値が null に正規化され batch は 200**(iso — 可用性 pin)/ 既知値は保存(iso)/ collision 比較に**入らない**(unit — origin 違いの再送が collision にならない pin)/ 再送で既存行の origin が更新・補完されない(iso)/ props chain の各 host が正しい値を渡す(component test)。
- **選択中試験**: 解決順 4 段 + 削除 ID 破棄 + URL 正規化(unit)/ sign-out purge で消える(既存 hygiene test の対象 key 一覧へ追加)。
- **summary**: owner echo / exam_id echo / 認証 401 / 400 系 / 他 owner exam → 空 200(route unit + iso)。

### 13.3 無退行(完了条件)

- **無退行の定義**: 既存の凍結 pin(tag mirror correctness / hygiene / card_tags delta I-1 / Sprint A ingest 系 — いずれも実在する test)を**変更せず green** に保つこと。Dash-0 の pin 1〜18 は「これから作る test の仕様」であり無退行の対象ではない — §13.1 の割当どおり**本 sprint で新設**し(6/7/8 のみ対象機能が v1 非実装のため Dash-3 で新設)、以後の凍結 pin に加わる。
- §8.5 のスマート選定変更で書き換える test は「契約変更」として commit message に明記し、新契約の red 検証を添える。
- sprint 完了 gate(CLAUDE.md): whole-repo lint 0 / `pnpm test` / `pnpm test:iso` green / `pnpm run audit` exit 0 / migration を含むため `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build`。
- stg smoke(push 後・OT 指示で): 7 ウィジェット表示・試験切替・CTA の k 強制(New が k 件で止まる)・quick 4 preset・W4 の実応答・origin が DB に落ちる(stg 読み)・空状態 4 種。

## 14. migration / deploy 順

- **migration 0040 一本**: `exams.daily_new_target` + `cards.first_reviewed_at` + `answer_events.origin`(いずれも nullable / additive。CHECK は `exams_daily_new_target_nonneg` の 1 本のみ)。RLS: 既存表への列追加のみで policy 変更なし(期待カタログ不変)。**一本にする理由**: 3 列とも additive nullable で個別 rollback の実益がなく(削れば戻る)、repo 慣例も sprint 1 migration。段階リリースが必要になる規模ではない。
- deploy 順: **migrate 先行 → code deploy**(旧 code は新列に触れない additive)。rolling 共存(旧 server × 新 client / 新 server × 旧 client)は §11.3 のとおりどの組合せでも回答同期が止まらない(unknown key strip / optional / 未知値 null 正規化)。
- `daily_new_target` の null 意味論 = **「未設定 = その時点の既定に追従」**(意図的 — `user_settings.session_limit` の既存前例と同じ。既定 `DAILY_NEW_DEFAULT` を将来変えると null の全試験に波及するのは仕様)。
- stg には未適用スタック 0036〜0039 が積まれている — 0040 は後続として通常順。

## 15. OT 承認ポイント(spec レビューで明示裁定を求める設計判断)

1. **daily-new-limit = soft limit で確定**(§8.3): server は超過回答を拒否しない。flush 前の並行セッション・複数端末で一時的に K を超えうる(収束後は残枠 0)。hard limit(server 予約契約)は v1 で作らない。
2. **導出型 u の帰結**(§8.3): カード削除で当日枠が戻る / 試験間移動は移動先の枠を消費。「現存カードで数える」意味論の受容。
3. **later-due 前倒しは Review のみ**(§8.5): Learning/Relearning の未到来 step は前倒ししない → プール件数が一時的に n を下回る微小差を受容。
4. **origin 未知値は 400 でなく null 正規化**(§11.3): 分析ラベルが回答同期を止めないことを優先。
5. **スマート復習の試験スコープ化**(§8.5): 全試験横断 → 選択試験。既存ユーザー挙動の変更。
6. **dead route 削除**(§9): `GET /api/dashboard/stats` + `lib/db/streak.ts`(caller 無なら)。push 前に外部利用の有無を OT に 1 行確認。
7. **「明日は約◯問」を出さない**(§4 W2)/ **復習優先による新規の後回し受容**(§8.5)。

## 16. 未確定・引き継ぎ(本 spec で確定しない事項)

1. **token の具体色値・widget-card の視覚詳細** — 実装時(frontend-design skill・§12 の a11y 基準内)。
2. **W7 delta を出すか落とすか** — 実装時の UI 判断(§4)。落としたら session doc 記録。
3. **Dash-2 への接続点**: `exams.daily_new_target` は Dash-2 の試験日自動計算が上書きする想定の土台。`exam_date` は本 spec 非スコープ。
4. **定義 doc pin 6/7/8(R 計算)** — Dash-3(v1 非実装)。
5. **origin の集計 UI / 成功指標ダッシュボード** — 将来(蓄積のみ開始)。
6. **PullTrigger の settle シグナルの実装形**(context / module event)— plan で確定(§6)。

## 17. Codex cross-check の反映(2026-08-18)

raw findings = `docs/codex/2026-08-18-plan-dash1-home-v1.md`(1 パス)。主要な取捨:

**採用(spec を修正した)**: Learning step の前倒し禁止(§8.5 — 当初案は state 一律 endOfToday だった)/ soft limit の保証レベル明示(§8.3)/ first_reviewed_at の書込契約(先着固定・遅延イベント・時刻源)の一意化(§8.3)/ origin 未知値の null 正規化(§11.3 — 当初案は enum 400)/ origin 先着固定・補完なしの明文化(§11.4)/ 復習優先による新規飢餓の明示受容 + W2 注記(§8.5・§4)/ pull 完了判定の settle シグナル(§6 — 当初の useLiveQuery undefined 案は誤り)/ query param 保持・URL 正規化・共通 resolver・再解決契機(§6)/ 「試験あり・カード 0」状態と選択未確定の別建て(§5)/ K=0 と「最初の 10 問」の衝突解消(§5)/ summary の SQL 契約詳細(全期間番号付け・単一評価時刻・丸め・uuid text 順・他 owner 空 200)と fetch race(§10・§4)/ maturity token の軸分離(§12)/ a11y 基準・色非依存(§12)/ 共有集計による性能設計(§3.1)/ 無退行の定義明確化(§13.3)/ 同値性・可用性 pin の追加(§13.2)/ null 既定値の意味論明示・migration 一本の理由(§14)/ W7 の「R」表記の曖昧さ解消(§4)。

**不採用(理由)**: hard limit(server 予約)— Sprint A 全受理と衝突・YAGNI(§15-1 で承認を求める)/ origin の null 補完 merge 契約 — 冪等の単純さを優先(§11.4)/ W4 の stale cache 表示 — v1 は失敗時可視化のみ(定義 doc の保守側裁定)/ local answer_events の W7 合成 — 端末間不一致の再導入(§9)/ 週 delta の観測完全性検証 — 定義 doc r2 で受容済みの限界 / セッション中の別端末変更対応 — 既存挙動(プールは開始時固定)の踏襲。
