# S1.9 削除フロー fix + 空 exam fix — sprint session log (2026-05-19)

> S1.8 push 後の staging smoke で発覚した 2 課題の fix mini-sprint。
> 調査 doc `2026-05-19-deletion-and-empty-exam-investigation.md` (commit
> `3c81445`) を前提とする。 2 task / 2 commit。

---

## 完了内容

| task | commit | type | 概要 |
|---|---|---|---|
| 1 | (commit 1) | fix(settings) | 削除フロー: useReverification 導入 + diagnostic 強化 + lesson |
| 2 | (commit 2) | fix(upload) | 空 exam: discard 時に auto-created exam も削除 (案 B) |

両 commit `[no-review]` provisional。 重要 Fix 該当 (task 1 = 認証 critical path、
task 2 = DB DELETE 追加 = 削除を伴う変更) のため、 OT staging smoke 後に
`[reviewed]` へ amend する (CLAUDE.md §重要 Fix の裏取り手順)。

---

## Task 1: 削除フロー真因 fix

### 真因 (調査 doc + OT DevTools 観測で確定)

`user.delete()` が Clerk から 403 `session_reverification_required` で reject。
self-delete は Clerk 仕様上 sensitive action で直近の再認証を要求する。 自前 UI
が prebuilt `<UserProfile />` を使わず生で `user.delete()` を呼ぶため SDK の
自動 handle が効かなかった。

### 実装 (`app/(app)/app/settings/delete-button.tsx`)

- `useReverification(() => user?.delete())` で wrap (component top-level)。
  Clerk が必要時に reverification modal を出し、 再認証後に元 request を自動 retry
- `isClerkRuntimeError(err) && isReverificationCancelledError(err)` で modal
  キャンセルを判定。 cancel は「失敗」 ではなく「中断」 = `setPhase('confirm')` で
  再試行可能に戻し、 error message を出さない
- diagnostic 強化: 旧 `catch {}` (err 破棄) を `catch (err)` 化、 `console.error`
  無条件追加、 staging (`NEXT_PUBLIC_VERCEL_ENV !== 'production'`) では UI に
  `err.message` を露出 (production は汎用文言維持)

### Clerk API の確認

kickoff 指示通り Context7 MCP で最新 docs を確認 (推測実装禁止):
- `useReverification` は `@clerk/nextjs` から export
- `isClerkRuntimeError` / `isReverificationCancelledError` は `@clerk/nextjs/errors`
- Clerk v7.2.4 で全 export の存在を `node -e require(...)` で実証
- 公式 pattern: fetcher を hook で wrap → enhanced fn を呼ぶ → cancel は
  2 段 narrowing で判定

### lesson 追加

`docs/superpowers/lessons/2026-05-19-clerk-self-delete-requires-reverification.md`
を commit 1 に同梱。 Clerk self-delete + reverification の知見、 DevTools で
root cause を特定する methodology、 他 sensitive actions への一般化を記録。

### test 判断

`delete-button.tsx` の unit test は追加せず。 理由: 既存 test が無く、
`useUser` / `useReverification` の hook mock + polling useEffect (setInterval +
fetch) の mock surface が重い。 kickoff が「hook mock が重い場合は smoke 任せで
可、 session log に判断明記」 を許容。 主要検証は OT staging smoke 1-3。

---

## Task 2: 空 exam fix (案 B)

### 原因 (調査 doc Issue 2 で確定)

`processUpload` は `destination.mode === 'new'` で exam を auto INSERT するが、
`discardUpload` は cards + source_documents のみ削除し exam を残す。 やり直し /
ファイル変更で空 exam が `/app/exams` に積み上がる。

### 実装

- `process.ts`: `ProcessResultData` に `examWasAutoCreated: boolean` 追加
  (`destination.mode === 'new'` で true)
- `discard.ts`: `discardUpload(sourceDocumentId, autoCreatedExamId?)` に 2 引数化。
  cards / source_documents / (条件付き) exam の削除を **1 transaction** に集約
  (従来は transaction なしの 2 連 delete)。 autoCreatedExamId が渡されたら
  exam を `WHERE id=? AND user_id=? AND NOT EXISTS(cards WHERE exam_id=?)
  AND NOT EXISTS(source_documents WHERE exam_id=?)` で削除
- `upload-form.tsx`: handleRetry / handleChangeFiles で `examWasAutoCreated` が
  true のとき examId を第 2 引数で渡す
- `discard.test.ts`: 5 test に拡張、 `process.test.ts`: mode='existing' happy
  path test 追加 (examWasAutoCreated=false 経路)

### 安全性設計

- exam DELETE は `user_id` 一致で他 user の exam を構造的に保護、 NOT EXISTS
  2 条件で「中身が残る exam」 「複数 upload された exam」 を保護。 client 由来の
  examId を渡されても server 側 WHERE で防御
- cards / source_documents 削除が exam DELETE より先に同 transaction 内で走る
  ため、 NOT EXISTS は最新状態を見る
- 通常 path では auto-created exam は中身ゼロで必ず削除される。 NOT EXISTS は
  防御的多重化 (review I-1 で comment 明確化)

---

## review

- 経路: `superpowers:requesting-code-review` skill + general-purpose subagent、
  template 改変なし
- base / head: `3c81445` → staged working tree (7 file)
- 結果: **Critical 0 / Important 3 / Minor 3**
- 対応:
  - **I-1** (NOT EXISTS が防御的か意図確認) → discard.ts に「通常 path は必ず
    削除、 NOT EXISTS は防御的多重化」 の comment 追記
  - **I-2** (cancel branch で errorMsg 未 clear の latent staleness) → **不対応**。
    `onConfirmDelete` 冒頭で既に `setErrorMsg(null)` 済のため、 cancel 到達時点で
    errorMsg は必ず null。 cancel branch への追加は起こり得ない scenario への
    防御となり CLAUDE.md「起こり得ない error handling を足さない」 に抵触。
    reviewer も「no visible bug today」「note as accepted も可」 と明記
  - **I-3** (mode='existing' happy path test 不在 = examWasAutoCreated=false
    未検証) → `process.test.ts` に mode='existing' happy path test を追加して
    解消 (follow-up ticket ではなく即 fix、 新 field の false 経路を直接検証)
  - Minor: hook の null 経路に comment 追記、 他 2 件は記録のみ
- assessment: 「With fixes (+ mandatory staging smoke before [reviewed])」

---

## test 推移

- S1.8 末: 332 passed
- S1.9 末: 335 passed (+3)
  - `discard.test.ts`: 3 → 5 (+2: mode=existing で exam 残す / mode=new で
    exam 削除 / exam DELETE は WHERE guard 必須)
  - `process.test.ts`: +1 (mode='existing' happy path、 examWasAutoCreated=false)
- build: pass、 tsc: clean

### discard.test.ts の検証限界 (明示)

mock DB は WHERE 条件を評価しないため、 unit test で検証できるのは:
- exam DELETE が autoCreatedExamId 有無で「呼ばれる / 呼ばれない」
- exam DELETE が必ず WHERE guard 付き (無条件 DELETE FROM exams ではない)

「他 user の exam は残る」 「中身が残る exam は残る」 の実 outcome は NOT EXISTS
+ user_id を DB が enforce するため、 staging smoke 6 で検証する。 mock theater
を避け、 test 内 comment に限界を明記済。

---

## OT staging smoke (両 task、 [reviewed] amend 前提)

### 削除フロー (task 1)

1. **happy path**: settings → 「アカウントを削除」 → confirm → 「削除する」 →
   reverification modal 表示 → password (or MFA) → 削除実行 → polling →
   `/sign-out-deleted` 遷移
2. **cancel path**: 同上で modal を ✕ → button 押下可能状態 (confirm) に戻る、
   「失敗しました」 message は出ない
3. **diagnostic**: 削除不可状態を意図的に作れたら UI に err.message 露出を確認
   (任意)

### 空 exam fix (task 2)

4. mode='new' submit → preview → 「同じファイルでやり直す」 → `/app/exams` に
   0 cards exam が増えていない
5. mode='new' submit → preview → 「ファイル変更」 → 同上
6. mode='existing' で既存 exam に submit → preview → 「やり直す」 → 既存 exam が
   削除されていない (cards 0 化はする)
7. mode='new' submit → preview → 「試験一覧へ」 → exam がそのまま保存 (回帰防止)

### push / amend

OT が host WSL から push → staging smoke (1-7) → 通れば各 commit を
`[no-review]` → `[reviewed]` に amend → main merge → production smoke。

---

## 起動コマンド

```bash
pnpm dev           # /app/settings で削除、 /app/upload でやり直し
pnpm test --run    # 335 passed
pnpm build         # production build
```

---

## out of scope (kickoff 通り、 本 sprint 不対応)

- webhook 順序逆転対策 (H3、 別 sprint で予防検討)
- dashboard 月次 OCR metric (S1b 残件)
- 「ファイル変更」 時の残量チラつき (S1.8 残件、 UX polish 別枠)
- 他 sensitive actions の reverification 対応 (現状 MVP に該当 path なし)
