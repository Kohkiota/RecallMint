# 削除フロー bug + 空 exam 残骸 — 2 件調査レポート (2026-05-19)

> S1.8 push (commit `08d0620`) 後の staging smoke で発覚した 2 課題の調査。
> **実装変更なし、 調査と修正案提示のみ**。 S1.9 mini-sprint kickoff prompt の
> 設計材料として claude.ai が読む前提。

---

## Issue 1: アカウント削除フローが「削除に失敗しました」 で固まる

### 症状

- staging cleanup + S1.8 push 後、 新規 sign-up → アカウント削除 button →
  「削除に失敗しました。 時間を置いて再度お試しください」
- 過去 S1.7 後 smoke で notifyOps Discord に
  `user.deleted received but users row not synced` 多数 (related signal)

### 削除フロー (現状実装) 全体

```
[client]                              [Clerk]              [our server]
─────────                             ──────              ─────────────
DeleteAccountButton.onConfirmDelete()
  ├─ memoize userId
  ├─ phase='deleting'
  └─ await user.delete()  ─────►  Clerk Frontend API
                                   ├─ delete user account
                                   └─ enqueue user.deleted webhook
                                                          ▼
                                                  POST /api/webhooks/clerk
                                                  (route.ts:114-117)
                                                    handleUserDeleted(clerkId)
                                                      ├─ UPDATE users
                                                      │    SET deletedAt=now()
                                                      │    WHERE clerk_id=?
                                                      ├─ if returning rows = 0:
                                                      │    notifyOps "row not synced"
                                                      │    return  ★ silent
                                                      └─ Stripe cancel ループ
                                       resolves
  ◄────  resolve / reject  ────
phase = 'polling' (resolve) | 'error' (reject)
  ├─ phase='polling': setInterval(1s) GET /api/me/deletion-status?userId=...
  │     └─ status === 'completed' or 'not_found' → window.location.replace('/sign-out-deleted')
  └─ phase='error': "削除に失敗しました…" 表示 ★ catch block は err を console にも出さない
```

**「削除に失敗しました」 は `user.delete()` の reject path 専用** —
すなわち Clerk frontend SDK call が throw した場合のみ表示される。 webhook 配送
失敗 / DB 不整合では出ない (それらは polling silent retry → 30 秒で強制 navigate)。

### S1.8 baseline 以降の認証関連変更 (git log で全網羅)

baseline 起点 = `236a189` (Initial commit、 2026-05-15 = dev-template
mvp-complete tag からの移植直後)。 以降、 削除フロー関連ファイルに touch した
全 commit:

| file | touched in | 変更内容 |
|---|---|---|
| `app/(app)/app/settings/delete-button.tsx` | `dbdf9c9` | `plan==='pro'` 分岐前に TODO コメント追加 (UI コピーだけ) |
| `app/(app)/app/settings/delete-button.tsx` | `ca7837d` | `plan==='pro'` → `plan!=='free'`、 「Pro プラン」 → 「課金プラン」 文言変更 (UI コピーだけ) |
| `app/(app)/app/settings/actions.ts` | (none since `236a189`) | 不変 (`createBillingPortalSession` のみ、 削除と無関係) |
| `app/api/me/deletion-status/route.ts` | (none) | 不変 |
| `app/api/webhooks/clerk/route.ts` | (none) | 不変 |
| `app/(auth)/sign-out-deleted/page.tsx` | (none) | 不変 |
| `app/(auth)/sign-up/` | (none) | 不変 |
| `lib/auth/ensure-user.ts` | (none) | 不変 (`getCurrentUser` 純 DB lookup、 lazy upsert なし) |
| `lib/clerk.ts` | `4f8002d` | コメント 1 行のみ更新 (env validation logic 不変) |
| `middleware.ts` | (none) | 不変 (`clerkMiddleware` + protected `/app(.*)`) |
| `lib/db/schema.ts` (users) | `dbdf9c9` (plan widening) / `d799cdc` (billing_interval 追加) | 列追加のみ、 deletedAt は不変 |

**結論**: 削除フロー code path に **行レベルの logic 変更は一切入っていない**。
OT 仮説 (「dev-template 完成後の認証関連変更が原因」) は code 経路には該当
しない。 原因は code 外 (env / Clerk Dashboard / Vercel Protection / Clerk
instance state) のいずれか、 もしくは元から存在した非決定的 bug の顕在化。

### 重要観察: catch block が error を捨てる

`delete-button.tsx:34-38`:

```ts
try {
  await user.delete()
  setPhase('polling')
} catch {
  setErrorMsg('削除に失敗しました。時間を置いて再度お試しください。')
  setPhase('error')
}
```

`catch (err) { console.error(err) }` 等の診断 log がない。 staging で **何が
throw されているか browser devtools で見えない**。 これが調査の最大障害。

### 原因仮説 (確度順 + 切り分け)

#### H1 (確度: 高) — Clerk frontend `user.delete()` が ClerkAPIResponseError を throw、 catch で握り潰されて診断不能

- `user.delete()` は Clerk Frontend API への HTTP リクエスト。 リジェクト要因:
  - 401 / 403: Clerk instance 設定で「self-delete 不可」 になっている
  - 422: Clerk dashboard で email 等が verification 不足
  - 5xx: Clerk 側 transient
  - network: CORS / 切断
- 切り分け:
  - delete-button.tsx の catch に `console.error(err)` を入れて再現 → devtools で error 詳細確認
  - Clerk Dashboard → Recent API requests で `DELETE /v1/me` (or similar) を見て status
  - Clerk Dashboard → Settings → User & Authentication → Account Self-Service で「Allow users to delete their account」 トグル確認
- 修正方針 sketch:
  - **diagnostic-first**: catch に `console.error('user.delete() failed:', err)` 追加 + `setErrorMsg(\`削除に失敗しました: ${err.message ?? '不明'}\`)` で error message を user にも見せる (staging のみ詳細表示)
  - 根本原因が Clerk Dashboard 設定なら code 変更不要、 OT が toggle を ON に
  - 根本原因が transient error なら retry button 既存実装で十分

#### H2 (確度: 中) — Vercel Deployment Protection が webhook を弾き続けている (lesson 2026-05-19 の再発)

- 過去 lesson `docs/superpowers/lessons/2026-05-19-vercel-hobby-deployment-protection-and-webhooks.md`
  の通り、 cleanup 操作で Require Log In が再 ON されている可能性
- 但しこの hypothesis は「`user.delete()` が成功 → webhook 失敗 → 残骸」 経路で、
  「削除に失敗しました」 (= client side reject) は説明できない
- ただし notifyOps 「row not synced」 (S1.7 smoke の signal) は説明可能:
  - sign-up → `user.created` webhook 401 で蹴られる → users 行 INSERT 失敗
  - その後 user が delete を成功させる → `user.deleted` webhook 着信 → DB に
    行が無い → notifyOps fires
- 切り分け: `curl -i -X POST https://stg.recallmint.nekotest.net/api/webhooks/clerk`
  → response status 確認 (401 + HTML なら Protection ON、 400 「missing svix
  headers」 なら endpoint 生きている)
- 修正方針: Vercel Dashboard で Require Log In OFF 維持を確認 (lesson §6
  「再発防止チェックリスト」 通り)

#### H3 (確度: 中) — Clerk webhook event 配送順序逆転 (`user.deleted` が `user.created` より先に到達)

- `docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md`
  §2.5 で警告済の antipattern
- 新規 sign-up 直後に user が高速で delete を実行すると、 Svix の配送順序
  保証なしの仕様により `user.deleted` 先着 → DB 行なし → notifyOps、 後着
  `user.created` で INSERT が走り「削除済 user が生き返る」 zombie 状態に
- 「削除に失敗しました」 client 表示には繋がらないが、 S1.7 で observe された
  notifyOps signal は説明可能
- 切り分け: Clerk Dashboard → Webhooks → Recent Deliveries で event の
  timestamps を確認、 `user.deleted` < `user.created` の case があるか
- 修正方針:
  - 案 1: webhook handler で `user.deleted` 着信時、 users 行不在ならごく短い
    delay (例: 200ms) で 1 回 retry してから notifyOps 諦め
  - 案 2: `clerk_events` に「deleted-pending」 として一時記録、 `user.created`
    着信時に該当 record があれば即 deletedAt set
  - 案 3 (recommended): 受信時に Clerk Frontend API で getUser(clerkId) で
    存在確認、 削除済なら deletedAt 状態を作るための shim row を INSERT
    → でも lesson §2.2 の cached JWT 404 リスク再来。 避けた方が良い

#### H4 (確度: 低) — Clerk SDK の post-delete session refresh が throw

- `user.delete()` 完了直後に Clerk SDK 内部が session refresh を試み、 user 不
  在で 401 → SDK が catch 漏れで promise reject 経路、 「成功扱いだが reject」 の
  glitch
- Clerk SDK version で 振る舞いが変わる、 staging / production の SDK 版本確認
- 切り分け: H1 と同じ devtools log で error stack trace 確認、 Clerk
  internals の line を含むか
- 修正方針: Clerk SDK update / カスタム delete flow (server-side `clerkClient.users.deleteUser()` 経由) への切替検討

#### H5 (確度: 低) — staging で Clerk instance を新規切替 / 設定変更した残骸

- cleanup 時に Clerk instance の dev → prod 切替や signing secret 変更を行うと、
  middleware の env validation (`lib/clerk.ts`) は通っても、 frontend SDK が
  古い publishable key を保持する経路
- 切り分け: Clerk Dashboard で current instance + publishable key を Vercel env
  と照合、 一致しているか確認
- 修正方針: env 一致を確認、 不一致なら Vercel env 更新 + redeploy

### Issue 1 推奨アクション

1. **最優先: diagnostic 経路の追加** (H1 切り分け用、 5 分作業)
   - `delete-button.tsx` の catch を `catch (err) { console.error('user.delete failed', err); ... }` に
   - 可能なら staging のみ error.message を UI にも露出 (`NEXT_PUBLIC_VERCEL_ENV !== 'production'` 判定で)
2. OT が staging で再現 → devtools console + Clerk Dashboard Recent API
   requests を取得
3. 上記 evidence をもって H1-H5 のどれが該当か絞り込み、 真因に応じた fix
4. webhook 順序逆転対策 (H3) は別軸で予防的に検討 (root cause が H1 でも
   将来 latent な bug)

S1.9 mini-sprint kickoff 設計時の前提:
- code path は健全、 diagnostic 強化 + Clerk Dashboard 設定確認が先 step
- H3 / H5 は code 変更を伴うが、 H1 が真因なら code 変更不要の可能性も
- 「削除に失敗しました」 文言 + catch 強化は確実に必要 (DX 向上、 root cause
  に関係なく)

---

## Issue 2: 「やり直し」 / 「ファイル変更」 で空 exam が DB に残る

### 症状

- staging `/app/exams` に「カード 0 件」 の exam が複数並ぶ
- 操作: submit → OCR 成功 → preview → 「同じファイルでやり直す」
  / 「ファイルを変えて再試行」 押下 → cards / source_documents は削除されるが
  exam は残る

### 現状実装の確認 (INSERT / DELETE / 確定の trace)

**submit (processUpload) で INSERT される行 (`process.ts:219-336`):**

1. `exams` (destination.mode === 'new' のとき): `INSERT INTO exams (user_id, name)`
   で auto-name `アップロード YYYY-MM-DD HH:mm` を発行 (`process.ts:232-236`)
2. `source_documents`: `status='processing'` で INSERT (`process.ts:248-265`)
3. OCR pipeline 実行 (cards 抽出)
4. `cards` bulk INSERT (`process.ts:325-339`)
5. `source_documents.status='completed'` UPDATE (`process.ts:353-364`)

**destination.mode === 'existing'** の場合は (1) を skip、 既存 examId を使う。

**「やり直し」 / 「ファイル変更」 (discardUpload) で DELETE される行 (`discard.ts:30-58`):**

1. 所有者 validate
2. `DELETE FROM cards WHERE source_document_id = ?` (`discard.ts:55`)
3. `DELETE FROM source_documents WHERE id = ?` (`discard.ts:56`)

**exam は DELETE されない**。 これが直接の原因。

**「試験一覧へ」 button で起こること (`upload-form.tsx:823-826`):**

- 単純な `<Link href="/app/exams">` による soft navigation
- 「確定」 logic なし、 server action call なし、 DB 変更なし
- discardUpload を呼ばないため、 preview の cards / source_documents は
  そのまま「成功」 として保存される (これが正常な「保存完了」 経路)

### 発生 pattern

1. user が destination='new' で submit → exam A 作成 + source_doc + cards 揃う
2. 「同じファイルでやり直す」 → discardUpload(prevSourceDocId) で
   source_doc + cards 削除 → exam A 空に
3. retry の runProcess() が再度 destination='new' で走り → exam B 作成
4. 結果: 空の exam A + 充実した exam B が `/app/exams` に並ぶ
5. user が「やり直し」 を N 回繰り返すと exam 残骸が N 個

「ファイルを変えて再試行」 も同様 (handleChangeFiles で discardUpload 後に
idle に戻す → user が新規 file 選択 → 再度 submit → 新規 exam C 作成)。

destination='existing' の場合は (1) で exam INSERT を skip するため、 既存
exam に対する retry / 変更では空 exam は発生しない。

### 修正方針の比較

#### 案 A: exam を最後に作る (確定時に初めて INSERT)

- preview で「試験一覧へ」 押下時に server action `confirmUpload()` で初めて
  `INSERT INTO exams` を実行、 cards / source_documents の `exam_id` を update
- 実装変更:
  - `cards.exam_id`, `source_documents.exam_id` を nullable 化
  - cards bulk INSERT は exam_id NULL で実行、 confirm 時に update
  - 新規 `confirmUpload(sourceDocumentId)` server action 追加
  - 「試験一覧へ」 button を `<Link>` から `<form action={confirmUpload}>` に
  - discard / タブ閉じ / 30 分放置 etc. の orphan cards 掃除 cron 追加 (確定
    されないまま放置された cards/source_docs を定期削除)
- trade-off:
  - schema 変更 + migration 必要 (kickoff §やらないこと に抵触)
  - 既存 plan-limits の SUM 計算で「未確定 cards」 を含めるか除外するか問題
    再燃 (S1.7 で stale processing 除外 logic を入れたばかり、 ここを再修正)
  - タブ閉じで orphan が増える → cron 不在ならゴミだらけ
  - 利点: 「破棄したら exam も消える」 は感覚的に自然
  - 欠点: 実装 cost + 副作用が大きい

#### 案 B: discard 時に auto-created exam も削除

- preview の success state に「この exam は auto-created か」 フラグを持つ
  (server action の戻り値 `ProcessResultData` に `examWasAutoCreated:
  boolean` を追加、 mode='new' なら true)
- `discardUpload(sourceDocumentId, autoCreatedExamId?)` の signature 拡張
- discard 内部:
  1. 既存通り cards + source_documents 削除
  2. autoCreatedExamId が渡されていれば:
     - 所有者確認 + cards count = 0 + 他 source_documents count = 0 を validate
     - 上記満たせば `DELETE FROM exams WHERE id = ? AND user_id = ?`
- 実装変更:
  - `discard.ts` に exam 削除 logic 追加 (約 10 行)
  - `process.ts` の success return に `examWasAutoCreated` 追加 (1 行)
  - `upload-form.tsx` の handleRetry / handleChangeFiles で 2 引数化 (各 1 行)
  - test 拡張 (3-4 new cases)
- trade-off:
  - schema 変更なし (kickoff §やらないこと 遵守)
  - 既存 plan-limits 計算は不変、 S1.7 stale logic を巻き込まない
  - 「user が既存 exam に upload した場合は exam 削除しない」 が自然に成立
  - 「destination='new' でも user 視点で残したい exam があった場合」 は誤削除
    の risk → ただし auto-created かつ cards=0 かつ source_documents=0
    なら user 視点で「empty exam」 であり「残したい」 ケースは考えにくい
  - タブ閉じ等で discard が走らなかった場合は exam 残るが、 その場合 cards も
    残っているので「empty exam」 にはならない (正常な保存完了として処理される)
- 利点: 実装 cost 最小、 schema 不変、 副作用 contained
- 欠点: client が「auto-created」 を server に伝える必要 (信頼境界の問題、
  ただし所有者 validation + 0-count validation で安全)

#### 案 C: server action 内部のみで exam empty 判定 → 削除 (client 通知不要)

- discardUpload 内部で source_documents 削除前に「この exam の最後の
  source_document か」 + 「cards 数 0 になるか」 + 「exam の auto-name pattern
  に合致するか」 (`^アップロード \d{4}-\d{2}-\d{2} \d{2}:\d{2}$`) を判定
- 条件全成立なら exam も削除
- 実装変更:
  - `discard.ts` 単体修正、 process.ts / upload-form.tsx 不変
- trade-off:
  - client 経路変更なし → API surface 安定
  - name pattern matching が fragile (user が偶然同形式で rename したら誤削除)
  - 案 B より少し脆い、 ただし schema 不変 + 影響範囲最小

#### 案 D: 定期 cron で空 exam 掃除 (eventual consistency)

- Vercel Cron で日次「cards 0 件 + source_documents 0 件 + auto-name pattern」
  exam を削除
- discard 直後は反映遅れあり (user 視点で /app/exams に N 時間〜数日残る)
- 実装変更: Vercel Cron + dedicated route
- trade-off: 修正の即時性で劣る、 user 視点では「やり直し」 直後に空 exam が
  見える期間あり、 MVP 体験として悪い
- 利点: 案 B/C で取り逃した path (タブ閉じ + プロセス失敗等) もカバー
- 欠点: 単独 fix としては不十分

### Issue 2 推奨

**案 B 推奨**。 OT の感触 (「最後に確定する時 exam を消す処理で済む」) と整合
する上で:
- schema 変更不要 (kickoff §やらないこと 遵守)
- 実装 surface 最小 (3 file の小修正、 test 3-4 case 追加)
- 信頼境界は所有者 validation + 0-count validation で担保 (case-by-case
  ではなく構造的に安全)
- 副作用が contained (discard 経路のみ、 success / cards 保持 path は不変)

案 A は schema migration + plan-limits 再設計が伴うため、 MVP 段階での投資
としてオーバー。 launch 後の「未確定状態を持つ UX 強化」 として将来 v1.x で
再検討する余地はあるが、 S1.9 では避ける。

案 C は名前 pattern 依存で fragile、 案 B より明示性で劣る。

案 D は単独では不十分、 案 B との併用候補 (タブ閉じ等の取り逃しを補完する
保険として将来追加可、 S1.9 では out of scope)。

S1.9 mini-sprint 想定 scope (claude.ai が prompt 設計時に使う):

1. `process.ts` の `ProcessResultData` に `examWasAutoCreated: boolean` 追加
2. `discard.ts` の `discardUpload(sourceDocumentId, autoCreatedExamId?: string)`
   2 引数化、 削除条件付き exam DELETE 追加
3. `upload-form.tsx` の `handleRetry` / `handleChangeFiles` で 2 引数化
4. test 拡張: discard で auto-created exam が削除される / cards 残っていれば
   exam 残る / 他 user の exam は触らない / mode=existing は不変
5. process / discard の handoff (例外時の整合性) を staging smoke で確認

---

## まとめ

| issue | code 経路の問題か | 修正案 (推奨) | schema 変更 | 緊急度 |
|---|---|---|---|---|
| 1. 削除フロー bug | 不明 (catch が err 捨てる、 真因不明) | diagnostic 強化 → 真因特定 → fix | 不要 (現時点) | 高 (新規 user が削除できない) |
| 2. 空 exam 残骸 | はい (discard で exam 削除なし) | 案 B (discard 時 auto-created exam 削除) | 不要 | 中 (UX 劣化、 機能停止ではない) |

S1.9 mini-sprint scope 推奨:
- task 1: `delete-button.tsx` の catch diagnostic 強化 (err.message UI 露出 + console.error)
- task 2: `discard.ts` の auto-created exam 削除 logic 追加 (3 file、 test 3-4 case)
- 順番: task 1 を先に push → OT が staging で削除 button 押下、 真因特定 →
  必要なら別 fix → task 2 を独立 commit (両者の coupling は無し)

OT の次アクション:
1. 本 doc を読んで方針合意
2. 案合意後、 claude.ai に S1.9 kickoff prompt を依頼 (本 doc 全体を context に)
3. claude.ai 設計 → Claude Code 実装 → staging smoke → [reviewed] amend

---

## 関連 file 一覧 (S1.9 設計 + 実装で参照)

### 削除フロー
- `app/(app)/app/settings/delete-button.tsx` (client、 catch 強化 task)
- `app/(app)/app/settings/page.tsx` (button 配置、 変更なし想定)
- `app/(app)/app/settings/actions.ts` (billing portal、 削除無関係)
- `app/api/me/deletion-status/route.ts` (polling endpoint、 不変想定)
- `app/api/webhooks/clerk/route.ts` (webhook handler、 H3 採用時のみ touch)
- `app/(auth)/sign-out-deleted/page.tsx` (terminal、 不変)
- `lib/auth/ensure-user.ts` (`getCurrentUser`、 不変)
- `lib/clerk.ts` (env validation、 不変)
- `middleware.ts` (Clerk protect、 不変)

### 空 exam
- `app/(app)/app/upload/_actions/process.ts` (ProcessResultData 拡張、 1 行)
- `app/(app)/app/upload/_actions/discard.ts` (exam 削除 logic、 メイン task)
- `app/(app)/app/upload/_actions/discard.test.ts` (test 拡張)
- `app/(app)/app/upload/_components/upload-form.tsx` (handleRetry / handleChangeFiles 引数追加)
- `app/(app)/app/exams/page.tsx` (一覧表示、 不変想定)

### 過去 lesson (前提知識)
- `docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md`
- `docs/superpowers/lessons/2026-05-19-vercel-hobby-deployment-protection-and-webhooks.md`
- `docs/superpowers/sessions/2026-05-19-account-prep-stuck-investigation.md`

### S1.8 直前 handoff
- `docs/superpowers/sessions/2026-05-19-s1-8-revalidate-ai-usage-warnings-handoff.md`
