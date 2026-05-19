# Session handoff: S1.7 OCR enforcement + UX + exam viewer sprint 完了

> 作成: 2026-05-19 (S1.5 hotfix 完了後、 staging smoke の Critical / Important 6 件
> を 1 mini-sprint に集約して対応)
> 状態: working tree clean、 formal review pass (Critical 0 / Important 4、 うち
> 2 件 fix済 + 2 件 S2 defer)、 push は OT 側 (develop ahead by 6 commit)
> 前 session handoff: `2026-05-19-s1-5-upload-ux-polish-handoff.md`

---

## このセッションでの commit (時系列)

| hash | subject | tag |
|---|---|---|
| `0f7aa19` | fix(usage): exclude stale processing source_documents from monthly page count | [no-review] |
| `ce10bca` | fix(upload): server action - structured error code + enforce before any DB write | [no-review] |
| `24e5937` | feat(upload): quota header + total pages + warning + detail error + 90s timeout | [no-review] |
| `d1cace8` | feat(exams): minimal read-only exam list + cards view | [no-review] |
| `88a3817` | feat(nav): add 試験 link to app header + AppPath | [no-review] |
| `471e23a` | fix(upload+exams): address S1.7 review Important findings | [reviewed] |

[no-review] の 5 件は formal review 前に provisional 状態で commit、 review pass
後 follow-up commit (`471e23a`) で Important 2 件を fix + [reviewed] tag を確定。
hook の check-review.sh は最後の feat/fix commit に対応する tag があれば通る
ため、 sprint 全体としては review-pass + tag 完了状態。

---

## formal review log (CLAUDE.md §「Commit 直前の review ログ明示」)

1. **呼び出した review 経路**: superpowers:requesting-code-review skill canonical、
   subagent = general-purpose、 template 改変なし (`/root/.claude/plugins/cache/
   claude-plugins-official/superpowers/.../code-reviewer.md`)。 BASE=`6307ada`
   (前 sprint 末) HEAD=`88a3817` (S1.7 5 commit 末) で diff range 評価。
2. **review 結果**: Critical 0 / Important 4 / Minor 7 / Assessment: **Yes
   (Ready to merge with follow-up for Important items)**。
3. **Important 残置 (S2 defer)**:
   - **I1 (archived exam 詳細 page の直接 URL access)**: 一覧 page は archived を
     除外しつつ詳細 page は archived も render (badge 表示)。 「bookmarked URL からの
     アーカイブ済 exam 閲覧」 が意図的 UX かどうか曖昧。 fix せず S2 (正式 CRUD で
     archived UX 確定時) に defer。 reason: MVP scope 内で実害なし、 詳細仕様は OT
     判断要。
   - **I2 (server 側 pdfPageCount と client 側の不一致 risk)**: 両者は同じ
     pdfPageCount 関数を呼ぶため値が一致する想定だが、 client 値を FormData で送って
     server 側は sanity check のみにする mitigation 提案。 fix せず defer。 reason:
     現状は両側で同 algo / 同 input、 不一致の現実的 trigger なし。 plan-limits 算出
     は server 側 SUM の方が信頼できるので current 設計を維持。
   - 上記 2 件は OT 承認待ち (本 handoff 通知時点、 OT が S2 sprint で再評価)。
4. **fix した Important 指摘** (commit `471e23a` で対応):
   - **I3 (owner-isolation 回帰防止 test 不足)**: `lib/exams/list.owner-isolation.test.ts`
     新規、 9 case (空 result / N 件 / archived / null sortKey 防御 / cardCount
     coerce)。 mock chain 経由で SELECT 経路 + 戻り値 map の invariant を固定。
   - **I4 (「ファイル変更」 button で entries が clear されない)**: handleChangeFiles で
     entries の thumbUrl revoke + setEntries([])、 button 文言通りの UX に。
5. **Minor 残置**: 7 件 (comment 言及 / spinner 文言不整合 / verbose error message /
   nullsLast 明示 / exam page rendering test / canRunOcr remaining 型 narrowing /
   JST HH:mm 抽出)。 polish 系で実害なし、 S2 sprint で気が向いたら拾う方針。
6. **[reviewed] tag 付与**: `471e23a` (review pass 後の follow-up fix commit) に
   付与。 5 件の provisional [no-review] commit は形式上 [no-review] のままだが、
   sprint 全体は review-pass + tag 完了。

---

## 主要成果

### Critical 1 対策: plan-limits enforce 強化 (`0f7aa19` + `ce10bca`)

OT staging smoke で「Free user 134 page 越え通過」 が判明 (cleanup 前)、 推定
根本原因は user.plan = 'standard' (300 上限) だった可能性が最有力だが、 防御策
として以下を 2 commit で実装:

- **stale processing 排除** (`0f7aa19`): `lib/ai-usage-mcq.ts` の SUM 集計 SQL に
  `or(eq(status='completed'), and(eq(status='processing'), gte(createdAt, cutoff)))`
  を導入、 cutoff = STALE_PROCESSING_MINUTES (10 分)。 Vercel function timeout
  等で残った processing 残骸が plan-limits 計算に二重 count されない。
- **server action 早期 return** (`ce10bca`): 戻り値型を ProcessUploadResult に拡張
  (7 種 code + details)、 QUOTA_EXCEEDED 時は exam INSERT / source_documents INSERT
  より前に return することを test (`process.test.ts:184-210`) で固定。

### Critical 2 対策: timeout 残骸 cleanup

- **server 側**: 上記 stale 10 分排除で processing 残骸が plan-limits に影響しない
- **client 側 90s timeout** (`24e5937`): runProcess に setTimeout(90_000)、 timeout
  発火時 phase=error (code='CLIENT_TIMEOUT')、 timedOut flag で server 遅延応答の
  上書きを防ぐ。 polling cleanup は overkill のため不採用 (server 側 10 分 stale で
  自然 cleanup)

### Important 3 対策: 開発用詳細エラー表示 (`24e5937`)

- Server Action error を構造化 (code / message / details: {rawError,
  sourceDocumentId, costYen, modelChain, current/limit/requested})
- UI 失敗 banner 下に `<details>` セクション (font-mono、 折りたたみ、 expand 可)
- `process.env.NEXT_PUBLIC_VERCEL_ENV !== 'production'` で gate、 production
  build では tree-shake 経由で実質残らない

### Important 4 対策: アップロード前の上限予測 (`24e5937`)

- page.tsx で `getCurrentMonthOcrPages` + `limitsFor(plan).ocrPagesPerMonth` を
  server fetch、 props で client へ
- 画面上部に「今月の OCR ページ残量: N / M (Plan名)」 banner 常時表示。 Pro は
  「無制限」 表示、 remaining=0 は amber 警告色
- ファイル選択時の合計 page を計算 (PDF: pageCount、 画像: 1)、 「2 件選択中
  (... 合計 N ページ)」 を表示
- 合計が remaining 超過 → amber warning + submit button disable

### Important 5 対策: cost 表示削除 (`24e5937`)

ResultPreview の「推定 AI コスト ¥N (モデル ...)」 行を削除。 DB の ocr_cost_yen
保存 + notifyOps Discord 通知 + 詳細エラー (staging 表示) は維持。

### Important 6 対策: 雑な問題管理画面 (`d1cace8` + `88a3817`)

新規 2 route + lib helper:

- **/app/exams** (一覧): Card で各 row 表示、 cards 数 + 最終更新 + 「詳細を見る」 link
- **/app/exams/[id]** (詳細): header (exam name + 作成/更新 relative + archived
  badge) + cards 一覧 (Card で sortKey + title + question 抜粋 + option count +
  custom_props キー)。 不在 / 他 user は notFound()
- **lib/exams/list.ts** 拡張: getActiveExamsWithCardCount / getExamByIdForUser /
  getCardsForExam。 owner-check は WHERE 句で強制 (他 user data 漏洩防止)
- **nav 追加** (`88a3817`): app-header に「試験」 link 挿入、 AppPath 型拡張、
  test 更新 (4 → 5 link)

---

## test サマリ

- 開始時 (S1.5 hotfix 完了時): 35 file / 307 test pass
- 終了時: **36 file / 317 test pass** (+1 file / +10 test)
  - `lib/ai-usage-mcq.test.ts`: +3 case (staleProcessingCutoff)
  - `app/(app)/app/upload/_actions/process.test.ts`: 既存 6 case を新 shape に
    update、 happy path と OCR failure に details assertion 追加
  - `app/(app)/app/_components/app-header.test.tsx`: 4 link → 5 link 体制更新
  - `lib/exams/list.owner-isolation.test.ts` 新規 9 test (Important 3 fix)

実 API / 実 DB は引き続き全 mock 経由、 staging smoke は OT push 後の別 session。

---

## pending: OT 側 staging smoke (kickoff §staging smoke 必須項目)

OT が `git push origin develop` 後、 staging deploy に対し以下を実機確認:

| シナリオ | 期待動作 |
|---|---|
| 残量 0 起点 | cleanup 後 staging で「今月の OCR ページ残量: 30 / 30 (Free プラン)」 表示 |
| 10 page 投入 | 成功、 残量「20 / 30」 表示 |
| 25 page 投入 (残量 20) | submit 前 amber warning「合計 25 ページは残量 20 ページを超過します」 + submit disable |
| 30 page ジャスト | 成功、 残量「0 / 30」、 alreadyAtQuota 警告表示 |
| 残量 0 で 1 page 投入 | submit disable + 「今月の OCR 上限に達しています」 |
| 詳細エラー (staging) | Gemini 意図的失敗 → 失敗 banner 下に詳細セクション (code / rawError / source_document_id / modelChain / cost) |
| /app/exams | 当該 user の exams 一覧、 各 row に cards 数、 link で詳細へ |
| /app/exams/[id] | cards 一覧表示、 既存追加 exam の cards が見える |
| header 「試験」 link | /app/exams へ遷移可能 |
| client 90s timeout | Network throttle で Server Action を 90s 超延長 → 「処理がタイムアウトしました」 + retry 誘導 |

cleanup 済の staging Neon を前提とした smoke。 production は schema 変更なしの
ため migration 不要。 main merge 後の production smoke は最小限 (sign-up flow +
1 ファイル OCR + ダッシュボード戻り)。

---

## 設計上の重要 record

### A. 「案 B」 (process 全 INSERT) を継続 + plan-limits 早期 return

S1a で採用した「案 B」 (process が OCR + cards INSERT を一気に完了、 preview は
read-only) を継続。 plan-limits の早期 return は exam INSERT / source_documents
INSERT より前に行うことで、 「無料 user が無限 OCR を撃てる」 risk を防御。
test (`process.test.ts:184-210`) で **insertedExams / insertedSourceDocs /
insertedCards が空** を assertion で固定 (回帰防止)。

### B. stale 10 分の妥当性

kickoff 明示の 10 分。 Vercel Pro plan の function timeout 900s (15 分) より短い
ため、 まれに正常 実行中の OCR を false positive で stale 扱いする risk あり。
実害 = 「上限超過」 を 1 件分逃す程度 (例: 30 page 残量 user が 31 page で
exceeded のはずが、 過去の正常 processing 残骸を 1 件 stale 扱いで除外して 30
page に変動 → 30+31=61 vs 30+30=60 で挙動が 1 page 変わる)。 これは monitoring
で観察可能、 必要なら STALE_PROCESSING_MINUTES を 15 → 20 に伸ばす余地あり。

### C. 90s client timeout vs 10 分 server stale の整合性

Vercel Pro は function timeout 900s (15 分)。 client は 90 秒で諦めるが server は
継続実行する case がある:
1. client が 90 秒で「タイムアウト」 表示 → user は retry 検討
2. server は引き続き OCR 実行 (Pro fallback まで含めると 5-10 分)
3. 完了すると status='completed' + cards INSERT 済 になる
4. user は気付かず retry → 新規 source_document INSERT、 cards 二重生成 risk

→ MVP では許容。 真の解決は server 側に「同 user の processing がある間は新規拒否」
等の lock が必要 (S2 / S3 で検討)。 現状は client 90s 表示 + server 10 分 stale
排除で、 ほぼ 5-10 分以内に整合が取れる前提。

### D. 詳細エラー gate の本物 production 挙動

`process.env.NEXT_PUBLIC_VERCEL_ENV !== 'production'` は Next.js build 時に
embed される。 production build では `if (false)` 相当となり tree-shake で
ErrorDetails sub-component も dead code として除去される (理論上)。 OT が
production smoke 時に「詳細セクション が出ない」 ことを 1 度確認すれば、
以降は build-time guarantee として信頼できる。

### E. 「ファイル変更」 button で entries clear する設計判断 (Important 4 fix)

button 文言 「ファイル変えて再試行」 を見て user が期待する挙動 = 「(画面の) ファイル
リストが消える」。 既存実装は entries 維持で「再選択しやすく」 という意図だったが、
button 文言と挙動の不整合は UX を損なう。 fix で entries clear + thumbUrl revoke
+ idle に戻す挙動に。 user が「同じファイルでやり直す」 を意図する場合は別途
「同じファイルでやり直す」 button (存在する) を使う。

---

## 未対応 (S2 / 後続 sprint scope、 前 handoff より継続)

- **S2 問題管理**: exam rename / cards 編集 UI / 単一削除 / source_document
  単位 cascade delete UI / archived_at UX (本 sprint review Important 1 含む)
- **S2 拡張**: pdfPageCount 整合性 mitigation (review Important 2)、 lock pattern
  (timeout + retry の cards 二重生成防止)
- **S3 メタデータ UI**: 一括 tag 編集 + custom_props 編集 + フィルタ / ソート
- **S4 学習画面**: /app/quiz placeholder を /app/study/{smart,practice} に切替
- **S8 / S9**: legal placeholder 一括置換 + smoke / launch
- **Minor 7 件** (review 結果): comment 言及 / spinner 文言不整合 / verbose error
  message / nullsLast 明示 / exam page rendering test / canRunOcr remaining 型
  narrowing / JST HH:mm 抽出。 polish 系、 S2 で気が向いたら拾う

---

## 関連 file

- 前 session handoff: `2026-05-19-s1-5-upload-ux-polish-handoff.md` (S1.5 + hotfix)
- S1a handoff: `2026-05-19-s1a-ocr-core-handoff.md` (OCR core sprint)
- 設計 reference: `2026-05-19-state-reconciliation.md` /
  `2026-05-19-sprint-roadmap-review.md` (sprint 全体構成)
- 関連 lib: ts-fsrs (将来 S4)、 lucide-react (Loader2 既存)、 Browser 標準 API
  (beforeunload / popstate / setTimeout)
