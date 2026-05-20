# OCR カウンタ未減算 + 「抽出中」 残留 — 2 bug 調査レポート (2026-05-20)

> S1.9 push (commit `b76e7e3`) 後の staging smoke で発覚した 2 bug の調査。
> **実装変更なし、 trace と仮説列挙のみ**。 修正方針は claude.ai + OT が後段で
> 検討するため本 doc では提示しない。

---

## Bug A: OCR カウンタが「やり直す」 後に減らない

### OT 観察事実

- 1 回目 OCR: 10 page submit → 残量 30 → 20 (正常)
- preview → 「同じファイルでやり直す」 → 2 回目 OCR (同 10 page)
- 2 回目後: 残量表示 **20 のまま**、 実カウンタも増えず、 OCR を continue 可能
- → 1 user が月次枠を超えて事実上 unlimited に OCR (= Gemini API call) 可能

### 現状実装 trace

#### 月次 OCR 残量の計算根拠

`/app/upload` の「残量 N / M ページ」 は、 plan 別月次上限 (`limitsFor(plan)
.ocrPagesPerMonth`、 Free 30 / Standard 300 / Pro null) から
`getCurrentMonthOcrPages(userId)` を引いた値。

`getCurrentMonthOcrPages` (`lib/ai-usage-mcq.ts:63-89`):

```
SELECT COALESCE(SUM(source_documents.pages_processed), 0)
WHERE user_id = ?
  AND (status='completed' OR (status='processing' AND created_at >= 10分前))
  AND created_at は当月 (JST 月境界) 内
```

**残量 = 月次上限 − source_documents.pages_processed の SUM**。 つまり
「残量カウンタ」 は独立した数値ではなく、 **source_documents table を
都度集計した派生値**。

補足: `pages_processed` は INSERT 時 default 0、 OCR 完了時の UPDATE
(`process.ts` 完了更新) で初めて `totalPages` がセットされる。 status=
'processing' の row は `pages_processed=0` のため SUM に 0 しか寄与しない
(実質 completed row だけが SUM を構成する)。

#### 「OCR を 1 回実行」 で起こること (`processUpload`)

時系列 (`app/(app)/app/upload/_actions/process.ts`):

1. auth
2. formData parse / 推定 totalPages 算出
3. `canRunOcr(user.id, plan, totalPages)` — `getCurrentMonthOcrPages` を引いて
   `current + requested > limit` なら QUOTA_EXCEEDED で早期 return。
   **これが server side enforce の本体**
4. GEMINI_DAILY_LIMIT guard (global、 ai_usage)
5. exam INSERT (mode='new' のとき)
6. **source_documents INSERT** (status='processing'、 `pages_total=totalPages`、
   `pages_processed=0`)
7. OCR pipeline (Gemini call、 ai_usage / ai_usage_users を per-call 加算)
8. cards bulk INSERT
9. **source_documents UPDATE** (status='completed'、
   `pages_processed=totalPages`、 `ocr_cost_yen` 等)

完了後: source_documents に completed row 1 件、 `pages_processed=10` →
SUM=10 → 残量 30−10=20。 OT 観察「30→20」 と一致。

#### 「やり直す」 (handleRetry) で起こること

`upload-form.tsx:456-476`:

```
setPhase('submitting')
await discardUpload(prevSourceDocumentId, autoCreatedExamId)
await runProcess()   // = processUpload を再実行
router.refresh()
```

`discardUpload` (`discard.ts`、 S1.9 で transaction 化):

1. 所有者確認 SELECT
2. transaction 内:
   - `DELETE FROM cards WHERE source_document_id = prev`
   - **`DELETE FROM source_documents WHERE id = prev`** ← prev row を物理削除
   - (auto-created exam なら) 条件付き `DELETE FROM exams`
3. finally: `revalidatePath('/', 'layout')`

→ discard 完了時点で **1 回目の source_documents row が DB から消える**。
SUM = 0 に戻る。

その後 `runProcess()` → `processUpload` 再実行:

- step 3 の `canRunOcr`: `getCurrentMonthOcrPages` = 0 (1 回目 row は削除済) →
  `0 + 10 ≤ 30` で通過
- 2 回目の source_documents row が INSERT → 完了 UPDATE で `pages_processed=10`
- SUM = 10 → 残量 30−10 = 20

→ `router.refresh()` 後の表示は 20。 **OT 観察「20 のまま」 は、 この実装が
設計通りに動いた結果**。

### Bug A 仮説 (確度順)

#### H-A1 (確度: 高) — 月次 quota は source_documents の SUM で、 discard が物理削除して quota を「返金」 する。 「やり直す」 は構造的に無限返金ループ

trace の通り、 月次 OCR 上限の enforce (`canRunOcr`) は
`SUM(source_documents.pages_processed)` を唯一の根拠とする。 一方
`discardUpload` は source_documents row を **物理 DELETE** する。

→ 「やり直す」 のたびに前回 row が消え quota が満額返金される。 1 回 retry
するごとに「実 Gemini API call (実コスト) は 1 回発生」 するが、
「月次 quota の消費は常に最新 1 upload 分」 にしかならない。

retry を N 回繰り返すと: 実 OCR を N 回実行 (N 回分の Gemini cost / ai_usage
増加) しても、 `SUM(pages_processed)` は最新 1 件 (10) のまま。 残量表示も
enforce 値も 20 で頭打ちにならない。 = **per-user 月次 OCR 上限が
事実上バイパス可能**。 plan 階層 (Free 30 / Standard 300 / Pro 無制限) の
課金差別化が崩れる = production launch blocker。

注意: 「無限 OCR」 = 「quota table に無限に積み上がる」 ではなく、
「実 API call / 実コストを無限に発生させられるが quota 表示は最新 1 件分の
まま」。 retry は前回を置換するため quota 数値は累積しない。

切り分け方法:
- retry を数回行った後に Neon で
  `SELECT id, status, pages_processed, created_at FROM source_documents
  WHERE user_id = ?` → row が 1 件だけなら discard が前回を削除している =
  返金確定
- 同じ期間に `SELECT date, count FROM ai_usage_users WHERE user_id = ?` /
  `ai_usage` を見て、 ai_usage は retry 回数ぶん増えているのに
  source_documents SUM は増えていない、 の乖離を確認 → 返金確定
- `lib/ai-usage-mcq.ts` の `getCurrentMonthOcrPages` / `canRunOcr` を読み、
  enforce が source_documents SUM のみに依存し ai_usage を参照しないことを確認

#### H-A2 (確度: 中) — これは S1.9 regression ではなく、 S1.7〜S1.8 で作り込まれた latent 設計欠陥が S1.9 smoke で初めて顕在化した

- 月次 quota を `SUM(source_documents.pages_processed)` にしたのは S1.7
  (`lib/ai-usage-mcq.ts` 導入)
- `discardUpload` が source_documents を物理削除する挙動は S1a / S1.5 から存在
- → 「discard が quota を返金する」 構造は S1.7 時点で既に成立していた
- S1.8 の smoke matrix (`2026-05-19-s1-8-...-handoff.md`) はシナリオ 2 を
  「『同じファイルでやり直す』 → 残量 20→20 維持 (新規 +10、 discard で −10)」
  と記述し、 **「20 維持」 を正常な期待値として明記していた**。 1 回 retry の
  net-zero を「正しい」 と判断し、 「返金可能 = 無限ループ可能」 への含意を
  接続していなかった
- S1.8 の preview 警告文「AI 抽出の利用枠は元に戻りません」 は ai_usage
  (Gemini call 数) には当てはまるが、 画面表示される月次 page quota
  (source_documents SUM) には当てはまらない。 警告文と実挙動が不一致

切り分け方法:
- `git log -p lib/ai-usage-mcq.ts app/(app)/app/upload/_actions/discard.ts`
  で「source_documents SUM = quota」 と「discard = 物理削除」 の導入時期を確認
- S1.8 handoff doc のシナリオ 2 期待値「20→20 維持」 を読み、 設計時点で
  net-zero を許容していた事実を確認
- S1.9 の 2 commit (`1a02207` / `b76e7e3`) は delete-button / 空 exam fix で、
  quota 計算・discard の source_documents 削除挙動には触れていないことを
  diff で確認 (= S1.9 が原因ではない)

#### H-A3 (確度: 低) — processing row が SUM に 0 しか寄与しない件は本 bug の主因ではないが、 隣接する弱点

`pages_processed` は完了 UPDATE まで 0 のため、 status='processing' の row は
SUM に寄与しない。 S1.7 の「stale processing 除外」 ロジックは
`pages_processed=0` の row を対象にしており、 SUM への影響は元々ほぼない。
これは Bug A の「20 のまま」 を直接説明しないが、 「処理中は quota に
計上されない」 という別の弱点 (並行 OCR で同時に canRunOcr を通過しうる) を
示唆する。 Bug A の主因は H-A1。

切り分け方法:
- `process.ts` の INSERT 時 `pages_processed` 値 (default 0) と完了 UPDATE の
  値 (`totalPages`) を確認
- 本 bug の再現は逐次操作 (await discard → await runProcess) のため並行性は
  絡まない、 を OT 操作手順から確認

---

## Bug B: 「ファイル変更」 後の「抽出中」 残留 (約 2 秒)

### OT 観察事実

- preview → 「ファイルを変えて再試行」 押下
- 「抽出中... (30 秒〜数分かかります)」 が約 2 秒表示 (server では OCR は
  走っていない可能性が高い)
- 約 2 秒後に idle (ファイル選択待ち) へ
- 押下した瞬間に idle へ切り替わるのが期待挙動

### OT 仮説 (参考、 裏取りは Claude Code 判断)

> revalidate layout で全体リロードを使っているなら、 これが時間かかって
> 2 秒くらい前の state が見えてしまっているのでは

### 現状実装 trace

#### handleChangeFiles (`upload-form.tsx:478-514`)

preview (phase==='success') からの押下時:

```
setPhase('submitting')                       // ← 同期。 即「抽出中」 画面に
await discardUpload(prevId, autoCreatedExamId) // ← server action 往復
clearEntries()
setPhase('idle')                             // ← idle 画面に
router.refresh()
```

#### 「submitting」 phase が何を描画するか

`upload-form.tsx` の submitting banner (S1.8 で amber 化):

> 「AI が問題を抽出しています… (30 秒〜数分かかります)」
> 「⚠ この画面を閉じたり戻ったりしないでください。 中断しても AI 抽出の
>  利用枠は消費されます。」

= OT の言う「抽出中... (30 秒〜数分)」 はこの banner。

#### handleRetry との対比

`handleRetry` も `setPhase('submitting')` を撃つが、 その後 `runProcess()`
で **実際に OCR を実行する**。 submitting → discard → OCR → success の流れで、
banner「抽出中」 は実態と一致する。

`handleChangeFiles` は submitting → discard → **idle** で、 **OCR は走らない**。
それでも同じ submitting phase を経由するため「抽出中」 banner が出る。

#### discardUpload の所要時間内訳

`discardUpload` 内部 (`discard.ts`):

1. `getCurrentUser` (Clerk `auth()` + users SELECT)
2. 所有者確認 SELECT
3. transaction: cards / source_documents / (条件付き) exam の 3 DELETE
   (S1.9 で transaction 化、 S1.9 以前は 2 DELETE / transaction なし)
4. finally: **`revalidatePath('/', 'layout')`** (S1.8 で追加)

Next.js App Router の server action は、 内部で `revalidatePath` を呼ぶと
**revalidate 対象 segment の RSC 再 render を action response に同梱する**。
`revalidatePath('/', 'layout')` は root layout 配下を全 invalidate するため、
server action 応答は `/app/upload` page tree (= `getActiveExamsForUser` +
`getCurrentMonthOcrPages` の DB query を含む) の再 render 完了を待ってから
client に返る。

→ `await discardUpload(...)` の解決時間 = transaction (3 DELETE) +
revalidate による layout subtree 全再 render。 これが約 2 秒の実体。

### Bug B 仮説 (確度順)

#### H-B1 (確度: 高) — handleChangeFiles が phase を 'submitting' にするため、 discard だけの間も OCR 用「抽出中」 banner が描画される

`handleChangeFiles` は「discard 中も spinner を出すため一時的に submitting に」
(コード内コメント) という意図で `setPhase('submitting')` を撃つ。 だが
submitting phase の banner は OCR 専用文言「AI が問題を抽出しています…
(30 秒〜数分)」 で、 discard (= 削除) しか走らない handleChangeFiles では
文言が実態と乖離する。 OT が「server には何も走っていないのに『抽出中』」
と感じるのはこのため。

切り分け方法:
- `upload-form.tsx` の `handleChangeFiles` success 分岐が `setPhase
  ('submitting')` を撃つこと、 submitting banner の文言を確認
- `handleRetry` (OCR が後続するので submitting が妥当) と比較し、
  changeFiles だけ「OCR なしで submitting」 になっていることを確認

#### H-B2 (確度: 高) — 「抽出中」 が約 2 秒続く長さは discardUpload の所要時間で、 その大半は revalidatePath('/', 'layout') が誘発する layout 全再 render

H-B1 は「なぜ抽出中が出るか」、 H-B2 は「なぜ 2 秒続くか」 を説明する
(2 つは別レイヤで両立)。

`discardUpload` の finally の `revalidatePath('/', 'layout')` により、
server action 応答が root layout subtree の再 render (exam 一覧 query +
月次 OCR query の再実行) 完了を待つ。 transaction の 3 DELETE と合わせ、
`await discardUpload` が約 2 秒かかる。 その間 phase は submitting のまま
= 「抽出中」 が約 2 秒滞留する。

OT 仮説「revalidate layout で全体リロードが時間かかって」 は、 **所要時間の
主因という点では概ね当たり**。 ただし「2 秒くらい前の state が見えている」
= stale state の表示、 という部分は不正確: 「抽出中」 は stale ではなく
handleChangeFiles が当該操作で能動的に set した fresh な submitting 表示。

切り分け方法:
- DevTools Network tab で「ファイル変更」 押下時の server action POST
  (discardUpload) の所要時間を計測。 約 2 秒なら H-B2 を裏付け
- 同 POST の response payload に layout subtree の RSC が同梱されているか
  (size が大きいか) を確認
- `discard.ts` の finally の `revalidatePath('/', 'layout')` と、 S1.8 以前
  (revalidatePath なし) の discard 所要時間を git history で比較

#### H-B3 (確度: 中) — Bug B は S1.8 で discard に revalidatePath を足したことで顕在化した。 phase='submitting' 自体は S1.8 以前から存在

- `handleChangeFiles` の `setPhase('submitting')` は S1.8 以前から存在
  (S1.8 着手時点の upload-form.tsx に既出)
- `discardUpload` の `revalidatePath('/', 'layout')` は S1.8 commit
  「fix(upload): revalidatePath on discard completion」 で追加
- S1.9 は discard を transaction 化 + exam DELETE 1 個追加 (所要時間に
  数百 ms 寄与の可能性)
- → S1.8 以前は discard が高速 (revalidate なし) で「抽出中」 が一瞬で
  流れ視認されなかった。 S1.8 の revalidatePath 追加で discard が約 2 秒に
  延び、 滞留が可視化された。 S1.9 の transaction 化が体感を僅かに増幅

切り分け方法:
- `git log -p app/(app)/app/upload/_actions/discard.ts` で revalidatePath
  追加 commit を特定
- `git show` で S1.8 以前の discard.ts に revalidatePath がないことを確認
- handleChangeFiles の `setPhase('submitting')` が S1.8 以前から存在する
  ことを git blame で確認

---

## 両 bug の coupling

**別 root cause。 共有点は discardUpload という同一 entry point のみ。**

| | Bug A | Bug B |
|---|---|---|
| 層 | server side data semantics | client UI state + server action 応答時間 |
| root cause | discard が source_documents を物理削除 → 月次 quota (SUM) を返金 | handleChangeFiles が phase='submitting' を撃つ + discard の revalidatePath が応答を約 2 秒に延ばす |
| 影響 | 課金枠バイパス (launch blocker) | UX 誤認 (低優先) |
| 顕在化時期 | S1.7 で構造成立、 S1.9 smoke で発覚 | S1.8 の revalidatePath 追加で顕在化 |

共有テーマ: 「discard が重い処理 (物理削除 + revalidate) を行う」 こと。
Bug A は「物理削除が何を引き起こすか」、 Bug B は「物理削除 + revalidate に
かかる時間をどう見せるか」。 同じ discardUpload を経由するが、 一方の修正が
他方を自動的に解決する関係ではない (例: discard の UI 表示を直しても quota
返金は残る、 quota 返金を直しても「抽出中」 文言の不一致は残る)。

部分的共有: Bug B の所要時間 (H-B2) は `revalidatePath('/', 'layout')` の
コスト。 仮に discard の処理内容 (削除範囲・revalidate scope) を見直す方向の
修正を後段で検討する場合、 Bug A / Bug B 双方に波及しうる接点ではある
(修正方針の検討は本 doc の範囲外)。

---

## 参照

- `docs/superpowers/sessions/2026-05-19-deletion-and-empty-exam-investigation.md`
  (S1.9 前段調査、 Bug A/B 未言及)
- `docs/superpowers/sessions/2026-05-19-s1-9-deletion-and-empty-exam-fix.md`
  (S1.9 sprint log、 discard transaction 化の経緯)
- `docs/superpowers/sessions/2026-05-19-s1-8-revalidate-ai-usage-warnings-handoff.md`
  (S1.8、 discard への revalidatePath 追加 / 「利用枠は元に戻りません」 警告 /
  smoke シナリオ 2「20→20 維持」 の期待値)
- 関連 file:
  - `lib/ai-usage-mcq.ts` (`getCurrentMonthOcrPages` / `canRunOcr`、 quota 計算)
  - `app/(app)/app/upload/_actions/process.ts` (`processUpload`、 source_documents
    INSERT / 完了 UPDATE)
  - `app/(app)/app/upload/_actions/discard.ts` (`discardUpload`、 物理削除 +
    revalidatePath)
  - `app/(app)/app/upload/_components/upload-form.tsx` (`handleRetry` /
    `handleChangeFiles`、 phase 遷移)
  - `lib/ai-usage-counter.ts` (`ai_usage` / `ai_usage_users`、 Gemini call 数、
    discard で返金されない別系統 counter)
