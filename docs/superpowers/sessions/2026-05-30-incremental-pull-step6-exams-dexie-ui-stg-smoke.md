# 増分 pull Step 6「exams Dexie 化 UI(試験一覧)」 UI 経由 stg smoke — 全 7 観点 PASS

- **日付**: 2026-05-30
- **対象**: origin/develop @ `8803b3b`（Step6 feat: `adb5a67` ExamListLive 切替 / `b6e68c9` 5 操作 runGuardedPull 相乗り、doc: plan/spec、全 `[no-review]`）
- **plan**: `docs/superpowers/plans/2026-05-30-incremental-pull-step6-exams-dexie-ui.md` の UI 経由 7 観点
- **環境**: staging `https://stg.recallmint.nekotest.net/app/exams`、chrome-devtools MCP。
- **deploy 反映確認**: `reload(ignoreCache)` 後、デプロイ済み JS 15 chunk を grep → `ExamListLive` + ride reason リテラル(`exam-delete`/`ocr-complete`)が `page-71d38ee...js`(`dpl_J5BTap5uZzb36JbdvzHy7281ZFgj`)に存在 = step6 新 bundle live。
- **結論**: **全 7 観点 PASS**。試験一覧が Dexie mirror(useLiveQuery)参照になり、一覧に効く 5 操作の即時反映が成立。

## テストデータ局所化

破壊的操作は test 試験 `step6-smoke`(手動作成)に局所化。real 2 試験(`アップロード 2026-05-29 13:44`=39件 / `13:49`=13件)は不触。検証後に test 試験 + その card を削除済(mirror/一覧から消失確認)。

## 結果サマリ (全 7 観点 PASS)

| 観点 | 結果 | 証跡 |
|---|---|---|
| 1 Dexie 参照表示 (基本) | **PASS** | 一覧 2 試験が IndexedDB `exams` mirror 由来。表示件数(13/39)= cards mirror の `exam_id` 集計値と一致(`exams.card_count` 列でなく cards 集計)。一覧用の Postgres 直読み client fetch なし(list は useLiveQuery)。見た目(名前/件数/相対時刻/詳細リンク/削除ボタン)従来どおり |
| 2 試験削除 即時消去 | **PASS** | 一覧で `step6-smoke` 削除 → Network: deleteExam(POST /app/exams)→ `router.refresh()`(残存)→ **`runGuardedPull('exam-delete')` = `GET /api/pull?...since_tombstone=09:14:37.805Z`**。tombstone bulkDelete で mirror から exam 消失(examsInMirror 3→2)、**一覧から live 消去**(reload なし、`listStillShowsStep6=false`)|
| 3 試験作成 即時表示 | **PASS** | `step6-smoke` 作成 → Network: createExam(POST /app/exams)→ router.push(詳細遷移)→ **`runGuardedPull('exam-create')` = `GET /api/pull?since_exams=2026-05-29..`**(reqid 744)。新 exam が mirror に入り(examsInMirror 2→3、card_count 0)、一覧に戻ると **top に live 表示**(updated_at 最新) |
| 4 カード件数 live 更新 | **PASS** | 詳細でカード追加 → createCard → router.refresh → **`runGuardedPull('card-add')`**(reqid 752)→ mirror card +1 → 一覧「カード 1 件」live。カード削除 → deleteCard → **`runGuardedPull('card-delete')` = `/api/pull?since_cards=09:13:19`** → tombstone bulkDelete で mirror card 0 → 一覧「カード 0 件」live |
| 5 OCR 完了反映 | **PASS (代替検証)** | 課金 API/ファイル不要の代替: (a) 既存 completed 試験の件数表示が正しい(13/39 = cards 集計一致)、(b) ポーリング遷移点の相乗りがデプロイ済み = bundle に `'ocr-complete'` リテラル存在(`exam-status-live.tsx:80` の `hasCompletion` 分岐)。OCR バッジは processing 試験不在のため非表示(従来どおり)。live polling 遷移は processing 試験が無いため未発火だが、相乗りコードは deploy 済 + unit(exam-status-live.test.tsx の fetch mock 駆動)で検証済 |
| 6 archived 除外 / DESC / skeleton | **PASS (一部 unit 担保)** | **DESC**: `step6-smoke`(最新)が一覧 top、real 2 件が後 = updated_at DESC 確認。**archived 除外**: deploy 済みコードが `archived_at == null` filter(unit `exam-list-live.test.tsx` 観点2 で検証)。stg には archived 試験が無く archive UI も MVP 未提供のため live 実演不可、コード+unit で担保。**skeleton**: mirror 充足済のため reload では一瞬で list 描画(skeleton は transient)。unit 観点5 で undefined→skeleton→list を検証済 |
| 7 回帰 | **PASS** | reload で mount pull `GET /api/pull?since...`(incremental、cursor 前進)1 本 + `GET /api/study-days/pull` 並走 = step4/5 トリガー・pull-back・in-flight 不変。一覧の見た目・詳細遷移・削除・作成・空状態 CTA が回帰なし。real 2 試験のみ正常表示 |

## 特記

- **5 操作すべてで `runGuardedPull` 相乗りを Network で実証**: exam-create(744)/ card-add(752)/ card-delete(09:13:19 pull)/ exam-delete(since_tombstone=09:14:37 pull)。各々既存 `router.refresh()`/`router.push()` も保持(削除は「削除中…」→ live 消失、作成は詳細遷移)。OCR-complete はコード/bundle/unit で担保(processing 試験不在のため live 未発火)。
- **mirror は pull 駆動のまま**: 削除も optimistic local delete でなく pull kick(tombstone bulkDelete)で反映 = read-only 不変条件維持(U4)。cursor は smoke 全操作で前進(cards 09:13:19 / exams 09:12:40 / tombstone 09:15:16)。
- **stg 制約による代替検証**(観点5 OCR live / 観点6 archived・skeleton): いずれも deploy 済みコード + 既存 unit test で担保。OCR は課金、archived は UI 不在、skeleton は transient のため live 実演不可だが、相乗り/filter/skeleton ロジックは bundle に存在し unit green。

## 結論
全 7 観点 PASS。feat 2 commit(`adb5a67`/`b6e68c9`)を `[no-review]` → `[reviewed]` に書換(非 HEAD のため `git filter-branch --msg-filter` で当該 2 SHA のみ、diff 不変・Co-Authored-By 保持)。plan/spec/session の doc commit は `[no-review]` 据え置き。履歴書換のため OT の再 push は `--force-with-lease` 必須。test データ(step6-smoke + card)は検証後削除済、real データ不触。
