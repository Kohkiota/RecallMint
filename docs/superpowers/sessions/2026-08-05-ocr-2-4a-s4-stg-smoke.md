<!-- 移送元: .superpowers/sdd/2026-08-04-ocr-2-4a-single-invocation/s4-stg-smoke.md(SDD workspace = git-ignored scratch)。
     scratch 削除に先立ち全文を恒久記録へ移送(2026-08-05・要約なし・観測値は原文のまま)。 -->

# S-4 + I-3(b) stg smoke 結果(2026-08-05)

対象: `origin/develop` = local HEAD = `a47d01b` / deploy = `dpl_CWkV2ZcYkuV31ZMuRwA1D19AfJ6v`

## §0 pre-flight

- push 同期: `git rev-list --count origin/develop..HEAD` = **0**
- **deploy 内容の実証**(dpl id より強い証拠 — bundle 内の文字列で確認):
  | marker | 結果 |
  |---|---|
  | `完了すると試験一覧に反映されます`(I-3(b) 中立文言) | **存在** |
  | `処理が中断された可能性があります`(確定失敗文言) | **存在** |
  | `/api/exams/status?doc=`(Codex P2 fix) | **存在** |
  | `beforeunload` | **消滅** |
  | `この画面を閉じたり戻ったりしないでください`(旧離脱警告) | **消滅** |
  | 旧経路 action 名 7 種 | **hit 0**(22 chunk 全走査) |
- **未実施**: Vercel Functions タブの `/app/upload` maxDuration = 720s の目視(Dashboard = OT)

## 必須 5 項目

| # | 項目 | 判定 | 観測 |
|---|---|---|---|
| 1 | 再訪カードの中立文言 | **PASS** | 「直前のアップロードがまだ完了していません。処理中です。 完了すると試験一覧に反映されます。」/ 「再度お試しください」「中断」「お待ちください」「削除」「待ち時間の数値」すべて**不在** |
| 2 | result page の processing パネル | **PASS** | 「⏳ まだ処理中です」+「処理中です。 完了すると試験一覧に反映されます。(取り込み先: 試験「アップロード 2026-08-05 16:17」)」/ 緑表示なし・導線「試験一覧へ」 |
| 3 | failed 面が従来文言 | **PASS** | 「⚠ 問題を抽出できませんでした」+「処理が中断された可能性があります。 しばらく待ってから再度お試しください。 処理状況は試験一覧で確認できます。」/ **中立文言は混入せず**(分離が効いている) |
| 4 | **タブを閉じても completed に到達** | **PASS** | doc `8cdc4541` を `processing` 確認後(07:15:39)にタブを close → 閉じたまま **op `completed` / doc `completed` / cards 11**(created 07:15:30 → 42 秒後に完了確認)。close 時に dialog も出ない |
| 5 | 中断 op が lease 失効後に reconciler で terminal 化 | **PASS** | 下記「項目 5 の方法」参照。結果 = op `terminal_failed` / `last_error_code=stale_reconciled` / `lease_expires_at` NULL / `prepared_payload` NULL / `result_summary={"reason":"stale_reconciled"}` / doc `failed` |

### 項目 5 の方法(重要 — 合成状態である旨の明示)

**本物の中断(hard-death)は外から作れない**。`after()` 化後はタブを閉じても処理が続き(項目 4)、実際の upload は 8〜22 秒で完了するため、非終端 op が自然に残る状況が発生しない。

そこで**状態のみを合成**した: exam / source_document(`processing`・created_at 20 分前)/ upload_operations(`processing`・`lease_expires_at` 5 分前・created_at 20 分前)を INSERT → `/api/exams/status` を叩いて reconciler を駆動 → 上表の結果を確認 → **合成 3 行を削除**(exam の cascade で doc・op とも 0 件になることも確認)。

したがって **lease 失効待ちの実時間は計測していない**(失効済みの状態を直接作ったため)。検証したのは「lease 失効かつ doc が 15 分超 processing のとき、reconciler が doc failed 化と**同時に op も terminal 化する**」という S-4 の追加分そのもの。

## 追加確認

- **beforeunload ガードの撤去 = PASS**: ① bundle から `beforeunload` と旧警告文言が消滅(§0)② submit 直後にタブを close しても dialog なし ③ **submit 直後に同一タブで `/app/upload` へ遷移しても待たされず即完了**(S-3 smoke では 60 秒待たされた挙動が消えた)
- **`src/` = 空(継続)**: `source_assets` **0 件** / `assets` 83 件中 `src/` を含む key **0 件**
- **S4-6 = PASS(機構の直接証明)**: 同一 exam に doc 2 件(`7a3c7453` 旧 / `a44c7dd0` 新)がある状態で status API を比較 —

  | 問い合わせ | 旧 doc | 新 doc |
  |---|---|---|
  | `?doc=` **無し** | **absent**(`DISTINCT ON (exam_id)` から漏れた = Codex P2 の失敗条件そのもの) | `completed` |
  | `?doc=<旧>` **有り** | **`completed`** | `completed` |

  → param が無ければ poll は key 不在を「処理中」と解釈して 20 分固まる状態だったことが実機で再現し、fix がそれを解消していることを確認。
- **poll → auto-nav = PASS**(副次観測): submit 後に放置すると `/app/upload` から `/app/upload/result/<id>` へ自動遷移。poll の実 URL に `?doc=<uuid>` が付いていることも `performance.getEntriesByType('resource')` で確認。
- **`in_progress` 面**: 任意項目のため未実施(race 限定 — `/app/upload` は gate が true の間 form 自体を出さないため、到達には別タブからの同時 submit が要る)。
- **`integration_failures` = 0 件**(admin read-only)。本 smoke で予期しない throw は発生していない。
- **非終端 op = 0 件**(残骸なし)。

## 所要時間の実測(660s 予算の材料)

| 入力 | op created → completed |
|---|---|
| 5 枚 ×3 回 | **21s / 21s / 22s** |
| 1 枚(無地) | 10s |
| 2 枚 | 8s |

**5 枚で 21±1 秒**。統合予算 `UPLOAD_PIPELINE_BUDGET_MS = 660_000`(660s)に対し **30 倍以上の余裕**。S-2 の phase log 実測(decode 7.2ms/枚・40 枚で 289ms / normalize 17ms / commit 13ms)と S-3(crop ≈300-400ms/figure)を踏まえると、**この 21 秒はほぼ全量が Gemini 往復**。40 枚に線形外挿しても Gemini 往復は数分規模で、660s の内側に収まる見込み。

## S-5 に持ち越す不明

1. **Vercel Functions タブでの maxDuration 720s 目視**(Dashboard 権限 = OT)。route segment config が効いていること自体は S-4 着手前提で OT が確認済み。
2. **`in_progress` 面の実機確認**(任意・race 限定)。文言は unit で pin 済み。
3. **予期しない throw の台帳書込**は UI から誘発できず iso のみの担保(S-3 から継続)。
4. **40 枚 upper-scale の実測**は未実施(本 smoke は最大 5 枚)。

## 消費

OCR quota: smoke で 5+5+5+1+2 = **18 ページ**消費。作成した exam / op は証跡として削除していない(項目 5 の**合成 3 行のみ削除済み**)。
