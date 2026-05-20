# result page 分離 + OCR cost 小数化 — S1.9.2 事前調査 (2026-05-20)

> S1.9.2 sprint 設計のための事前調査。 **実装変更なし、 現状 trace と設計選択肢
> 列挙のみ**。 修正方針 / 案選定は提示しない (後段で claude.ai + OT が検討)。

---

## 1. 現状の upload page / form data flow trace

### route 構成

- `/app/upload/page.tsx` — **Server Component**
  - `getCurrentUser()` → user
  - `Promise.all([getActiveExamsForUser(user.id), getCurrentMonthOcrPages(user.id)])`
  - `monthlyLimit = limitsFor(user.plan).ocrPagesPerMonth`
  - `remaining = monthlyLimit === null ? null : max(monthlyLimit - currentMonthPages, 0)`
  - `<UploadForm existingExams currentMonthPages monthlyLimit remaining plan />`
- `/app/upload/_components/upload-form.tsx` — **Client Component** (`'use client'`)
- `/app/upload/_actions/process.ts` — `processUpload` Server Action
- `/app/upload/_actions/discard.ts` — `discardUpload` Server Action
- preview を表示する独立 route は**存在しない** (preview は client component 内の
  phase 分岐)

### upload-form.tsx の phase 状態

`Phase` discriminated union (4 種):

| phase | 描画内容 | 残量 banner |
|---|---|---|
| `{kind:'idle'}` | ファイル選択フォーム全体 (残量 banner / file picker / 投入先選択 / submit) | **表示** |
| `{kind:'submitting'}` | 同上 + spinner banner「AI が問題を抽出しています…」 | 表示 |
| `{kind:'success', result}` | `<ResultPreview>` のみ (排他描画、 form は出さない) | **非表示** |
| `{kind:'error', message, code, details?}` | form + error section | 表示 |

`if (phase.kind === 'success') return <ResultPreview .../>` で **success のときだけ
form ごと差し替え**。 ResultPreview は残量 banner を一切描画しない。

### prop / state の確定タイミング

- `remaining` / `monthlyLimit` / `currentMonthPages` / `plan` / `existingExams`
  は **Server Component が初回 render 時に確定し prop として client に渡す**。
  client component インスタンス内では固定。 更新経路は `router.refresh()` で
  Server Component を再 render → 新 prop 伝播、 のみ
- `phase` / `entries` (File[]) / `destination` は client の `useState`
- `processUpload` の戻り値 `ProcessResultData` (sourceDocumentId / examId /
  examName / examWasAutoCreated / cardsExtracted / ocrCostYen / modelChain /
  cards[]) は `phase.result` に格納され、 ResultPreview が読む

### 各 button の click handler 経路

| button | 場所 | 経路 |
|---|---|---|
| 「AI で問題を抽出する」 (submit) | idle form | `handleSubmit` → setPhase('submitting') → `runProcess` → `processUpload` → setPhase('success'\|'error') |
| 「同じファイルでやり直す」 | ResultPreview | `handleRetry` → setPhase('submitting') → `discardUpload(prevId, autoCreatedExamId?)` → `runProcess` (= `processUpload` 再実行、 entries の File を再利用) → `router.refresh()` |
| 「ファイルを変えて再試行」 | ResultPreview | `handleChangeFiles` → setPhase('submitting') → `discardUpload(...)` → `clearEntries()` → setPhase('idle') → `router.refresh()` |
| 「試験一覧へ」 | ResultPreview | `<Link href="/app/exams">` (単純 soft navigation、 server action なし) |

### Bug B (残量 stale 表示) の race condition 詳細

`handleChangeFiles` の success 分岐:
```
await discardUpload(...)   // ~2 秒 (revalidate 含む)
clearEntries()
setPhase('idle')           // ← 同期。 form 再描画、 残量 banner は古い remaining prop で出る
router.refresh()           // ← 非同期。 完了して初めて新 prop 伝播
```
`setPhase('idle')` で banner が**即座に古い prop 値で描画**され、 `router.refresh()`
完了までその値が滞留する。 OT 観察「preview から遷移後しばらく残量が古い、
後から /app/upload に戻ると正しい」 はこの window。 `handleRetry` も
submitting → success の間に同じ prop 固定が起きるが、 success 中は banner 非表示
のため顕在化しにくい。

---

## 2. result page 分離の設計選択肢

### 2-1. result page が表示データを取得する経路

| 案 | 内容 | trade-off |
|---|---|---|
| **R1: DB 再 fetch** | `/app/upload/result/[sourceDocumentId]` Server Component が、 sourceDocumentId から source_documents + cards (`WHERE source_document_id=?`) を DB から再取得 | 〇 fresh server render を構造保証、 exams/[id] と同じ owner-scoped pattern。 ✕ **新規 query 2 本が必要** (現状 source_documents / cards-by-source-document を読む query は lib/ に皆無)。 ✕ `examWasAutoCreated` を DB から導出不可 (下記 2-4) |
| R2: URL params | examName 等を searchParam で渡す | ✕ cards[] は URL に載らない (容量)。 部分的にしか使えない |
| R3: sessionStorage / cookie | client が result data を持ち回る | ✕ OT 既却下 (容量)、 File 非シリアライズ、 fresh render の利点を失う |

現実的なのは **R1 (DB 再 fetch)**。 ただし前提として:
- 新規 query: `getSourceDocumentForUser(userId, sourceDocumentId)` 相当 +
  `getCardsForSourceDocument(userId, sourceDocumentId)` 相当 (cards に
  `source_document_id` 列があるので `WHERE user_id=? AND source_document_id=?`
  で取れる)
- access control: source_document が他 user のもの / 不在なら `notFound()`
  (exams/[id] の `getExamByIdForUser` → `notFound()` pattern を踏襲)

### 2-2.「同じファイルでやり直す」 を result page でどう実装するか — **最大の論点**

現状「同じファイルでやり直す」 は `entries` (File[] = ブラウザメモリ上の File
オブジェクト) を再利用して `processUpload` を再実行する。 **File オブジェクトは
upload-form client component の useState にしか存在しない**。 result page に
navigate して upload page が unmount すると File は消える。 File は URL /
sessionStorage / DB のいずれにも実用的にシリアライズできない。

→ **page を完全分離すると「同じファイルでやり直す」 はそのままでは成立しない。**
設計判断が要る:

| 案 | 内容 | trade-off |
|---|---|---|
| A1 | result page では「同じファイルでやり直す」 を**廃止**し、 「ファイルを変えて再試行」 (= /app/upload に戻って選び直し) のみ残す | 〇 最も単純、 page 分離と完全整合。 ✕ 同一 file 再 OCR (Flash/Pro variance での品質再挑戦) の導線が消える |
| A2 | discard → /app/upload に File 持ち越し → 即 OCR 再実行 | ✕ File をナビゲーション越しに運ぶ手段が実質ない (R3 と同じ壁) |
| A3 | result page を独立 route にせず**同一 route 内の overlay / 別 phase** のままにし、 「やり直す」 は従来通り client 内で完結 | ✕ fresh server render の利点を失う = Bug B が構造的に解決しない (現状と同じ) |
| A4 | 「やり直す」 を「OCR 完了画面に留まったまま再実行」 にせず、 そもそも preview 段階で「やり直す」 を提供しない。 不満なら「ファイル変更」 で選び直す前提に倒す | A1 の言い換え (UX 文言の問題) |

※ そもそも「OCR が成功した preview」 から「同じ file でやり直す」 ユースケースの
頻度・必要性自体も論点 (成功済 OCR の同一 file 再実行は結果がほぼ同じになりうる。
retry の主目的は transient failure 回復 = error phase 側)。 機能の要否含めて
claude.ai + OT 判断。

### 2-3.「ファイルを変えて再試行」「試験一覧へ」 の挙動

- 「ファイルを変えて再試行」: result page → `discardUpload` → `/app/upload` に
  navigation。 /app/upload は fresh server render = 残量 banner 正値で出る。
  Bug B はこの経路で構造的に解消
- 「試験一覧へ」: 現状 `<Link>` のまま維持で問題ない (OCR cards は OCR 完了時点で
  既に commit 済 = §4 参照、 「確定」 server action は不要)。 result page →
  /app/exams への navigation

### 2-4. destination / examWasAutoCreated の持ち回り

result page は「やり直す / ファイル変更」 で `discardUpload(sourceDocumentId,
autoCreatedExamId?)` を呼ぶ必要があり、 第 2 引数判定に **`examWasAutoCreated`
(mode='new' か) が要る**。 これは DB の source_documents / exams から導出できない
(exam が auto 作成かは記録されていない)。 候補:

| 案 | 内容 | trade-off |
|---|---|---|
| D1 | result page URL の searchParam で渡す (`?new=1`) | 〇 boolean なので URL-safe、 schema 不変。 ✕ URL 改竄余地 (ただし discardUpload 側で user_id ガード済のため越境はしない、 誤って exam を消す/残すが起きる程度) |
| D2 | source_documents に `created_exam boolean` 列を追加 | 〇 信頼できる。 ✕ schema 変更 + migration |
| D3 | 名前 pattern 推定 (auto-name regex) | ✕ fragile (S1.9 調査で既に却下済の手法) |

mode='existing' の場合 `existingExamId` 自体は source_document.exam_id から取れる
ので持ち回り不要。 必要なのは「auto 作成だったか」 の 1 bit のみ。

### 2-5. access control / browser back / refresh

- result page URL 直叩き (他 user): owner-scoped query が null → `notFound()`
- result page を開いた後 source_document が discard 済 (browser back →
  別操作 → 戻る、 or URL 直開き): 再 fetch が空 → `notFound()` か専用の
  「このアップロードは破棄されました」 表示か、 設計判断
- browser refresh: R1 (DB 再 fetch) なら refresh で再取得され同じ画面。
  discard 済なら上記と同じ

---

## 3. revalidate scope 縮小の余地

現状 `processUpload` / `discardUpload` とも try/finally で
`revalidatePath('/', 'layout')` を撃ち、 **root layout 配下全 path を invalidate**
している (S1.8 で「残量 banner を確実に更新」 目的で導入)。

result page 分離後:
- discard → `/app/upload` への navigation で残量 banner は fresh server render
  される。 ただし Next.js Router Cache が `/app/upload` を stale 配信する可能性が
  あるため、 **何らかの revalidate は依然必要** (navigation だけでは Router
  Cache を bust しないケースがある)
- 縮小候補: `revalidatePath('/', 'layout')` → `revalidatePath('/app/upload')`
  + `revalidatePath('/app/exams')` (discard / OCR で exam 一覧・card 数も変わる
  ため)
- 依存確認: 現状 `revalidatePath('/', 'layout')` に乗っている再 fetch 期待は
  実質「/app/upload の残量」 と「/app/exams の一覧」 のみ (grep 上、 dashboard
  `/app` は OCR 派生値を表示していない)。 `app/(app)/app/_actions/revalidate.ts`
  の `revalidateAppPath` は header link 用の**別経路**で、 process/discard の
  revalidate とは独立。 → scope 縮小の副作用は小さいと見込まれるが、 縮小後
  smoke で /app/exams の card 数即時反映を要確認

---

## 4. cards / source_documents lifecycle (現状 + 分離後)

### 現状

- **OCR 完了 = 即 commit**。 `processUpload` 内で exam (mode='new' なら) +
  source_documents + cards を全て INSERT し、 完了 transaction で
  source_documents を completed に。 この時点で cards は exam に属し
  `/app/exams` から見える
- 「確定 (confirm)」 という独立ステップは**存在しない**。 「試験一覧へ」 は
  単なる Link。 OCR 完了時点で既に確定済
- 「やり直す」「ファイル変更」 = `discardUpload` で undo (cards +
  source_documents、 mode='new' なら exam ごと cascade 削除)
- 「放置」 (preview のまま browser back / tab close、 やり直しも試験一覧へも
  押さない): cards はそのまま commit 状態で残る = 正常な保存完了扱い。
  空 exam にはならない (cards が入っているため)
- 並列 tab: /app/upload を 2 tab で開いて並列 OCR → 独立した
  source_documents + (mode='new' なら) exam が 2 組できる。 同時実行ロックは
  未実装 (Tech Spec §3 の「1 ユーザー 1 ジョブ」 は未実装、 r2-scrub 調査済)
- 「試験一覧へ」 を押さず `/app/exams` に直接 navigate: cards は既に commit
  済なので一覧に出る (現状の挙動)

### 分離後の差分

- lifecycle 自体は不変 (OCR 完了 = 即 commit を維持、 OT 判断確定)。 result
  page は **commit 済データの VIEW** に過ぎない
- 「放置」 ケース: result page を開いた user が browser back で /app/upload に
  戻り別 file を再 submit → 前回 OCR の cards/source_documents/exam は確定も
  discard もされず**残る** (= 前回の成功 OCR がそのまま保存される)。 現状の
  「preview のまま放置」 と等価、 新たな残骸問題は生じない
- result page URL が discard 済 source_document を指す edge case が新たに発生
  (§2-5)

---

## 5. ocr_cost_yen の `Math.round` 確認

`lib/ai/cost.ts` の `estimateCostYen` (23-33 行):
```ts
return Math.round(usd * JPY_PER_USD)
```
**integer 丸めが残っている。** schema は S1.9.1 で `numeric(10,4)` 化済のため、
DB には小数 4 桁で格納できるが、 値自体が `Math.round` で integer 化されている
ため `2.0000` のように小数部が常に 0 になる。

- 除去方針: `Math.round(...)` を外して `usd * JPY_PER_USD` をそのまま返す、
  もしくは 4 桁丸め (`Math.round(x * 10000) / 10000`) にする。 型は `number`
  のまま、 numeric(10,4) mode:'number' 列が小数を受ける
- 連動 test: `lib/ai/cost.test.ts` の期待値は全て integer
  (`45` / `375` / `1688` / `1` / `0`)。 除去後は `45` / `375` / `1687.5` /
  `0.825` / `0.045` 等に更新が必要
- 読み出し側の integer 期待: r2-scrub 調査 §4 の通り `ocr_cost_yen` **DB 列は
  write-only** (読み出しコード 0 件)。 `costYen` (pipelineResult / ProcessResultData /
  ProcessUploadErrorDetails) は `upload-form.tsx` の `ErrorDetails` が
  `String(costYen)` で staging 表示するのみ。 integer 前提の算術・比較は無い
  → `Math.round` 除去の影響は cost.ts + cost.test.ts に局所化
- `ocr.ts` の `costYen` は `tokenUsage.reduce` で per-model `estimateCostYen`
  を合算 (型 `number`)。 小数化しても合算ロジックは不変

---

## 6.「抽出中」 banner 流用問題の整理

### 現状の問題

`handleChangeFiles` は OCR を走らせない (discard のみの) 経路でも
`setPhase('submitting')` を流用するため、 submitting phase の OCR 用 banner
「AI が問題を抽出しています… (30 秒〜数分)」 が約 2 秒表示される (Bug B 調査
H-B1)。 2 秒の長さは discard の `revalidatePath('/','layout')` が誘発する
layout 全再 render 込みの所要時間 (H-B2)。

### 分離後

- 「ファイルを変えて再試行」 は result page → `discardUpload` → `/app/upload`
  への navigation になる。 upload-form の `phase='submitting'` 流用は **構造的に
  消える** (result page と upload page は別 component、 phase enum を共有しない)。
  OCR 用「抽出中」 文言が discard 中に出ることはなくなる
- ただし `discardUpload` server action 自体の所要時間 (~2 秒、 revalidate 含む)
  は残る。 この間 user が何を見るかは result page 側の設計判断:
  - result page に留まり loading 表示 (「破棄しています…」 等、 OCR 文言ではない)
  - optimistic navigation (discard 完了を待たず /app/upload へ即遷移、 discard は
    background) — Next.js の `useTransition` / Server Action の挙動次第で可否が
    変わる、 実装時に要検証
- revalidate scope 縮小 (§3) で discard が速くなれば、 この待ち時間自体も短縮
- OCR 本体の submitting phase (submit → OCR 実行中) は upload page に残り、
  「抽出中」 文言は実態と一致 (正しい流用)

---

## 7. 両 task の coupling

**page 分離と ocr_cost 小数化は完全に独立。**

- cost 小数化は `lib/ai/cost.ts` + `lib/ai/cost.test.ts` に touch が局所化、
  page 構造・data flow と無関係
- 別 commit で並行可能、 依存順序なし
- S1.9.2 として 1 sprint に束ねるのは「S1.9.1 の scope 漏れ follow-up を
  まとめて拾う」 という運用上の都合であり、 技術的 coupling は無い

---

## 想定外 / 論点まとめ (OT + claude.ai 判断事項)

1. **「同じファイルでやり直す」 と page 分離は根本的に両立しない** (§2-2)。
   File オブジェクトは upload page client の memory にしかなく、 navigation で
   消える。 機能 drop / overlay 化 / 別設計 のいずれかの判断が必須。 これが
   S1.9.2 設計の最大の分岐点
2. **result page には新規 DB query 2 本が必要** (source_documents 単体 +
   cards-by-source-document)。 現状 source_documents を読む query は皆無
3. **`examWasAutoCreated` の持ち回り**に searchParam か schema 列追加の判断が
   要る (§2-4)。 DB から導出不可
4. **lifecycle は不変** — OCR 完了 = 即 commit、 「確定」 ステップ無しは現状
   通り。 page 分離は VIEW の分離に過ぎず、 データ確定タイミングは変わらない
5. cost 小数化は完全独立、 影響は cost.ts + test に局所化
6. revalidate scope 縮小は可能だが Router Cache bust のため revalidate 自体は
   残す必要あり。 縮小後は /app/exams の card 数即時反映を smoke で要確認

---

## 参照

- `docs/superpowers/sessions/2026-05-20-ocr-counter-and-progress-display-investigation.md`
  (Bug A / B trace、 Bug B race condition の詳細)
- `docs/superpowers/sessions/2026-05-20-r2-scrub-and-counter-schema-investigation.md`
  (ocr_cost_yen 小数化の touch 箇所、 source_documents 列の読み書き状況)
- `docs/superpowers/sessions/2026-05-20-s1-9-1-counter-separation.md`
  (S1.9.1 で確立した upload_records / cascade 設計)
- 関連 file:
  - `app/(app)/app/upload/page.tsx` (Server Component、 prop 確定箇所)
  - `app/(app)/app/upload/_components/upload-form.tsx` (phase 状態 / 3 button handler)
  - `app/(app)/app/upload/_actions/process.ts` (`processUpload` / `ProcessResultData`)
  - `app/(app)/app/upload/_actions/discard.ts` (`discardUpload` / revalidate)
  - `app/(app)/app/exams/[id]/page.tsx` (owner-scoped + notFound() pattern、 result page の参考)
  - `lib/exams/list.ts` (`getExamByIdForUser` / `getCardsForExam`、 新規 query の参考形)
  - `lib/ai/cost.ts` + `lib/ai/cost.test.ts` (`estimateCostYen` の Math.round)
  - `app/(app)/app/_actions/revalidate.ts` (`revalidateAppPath`、 header link 用の別 revalidate 経路)
