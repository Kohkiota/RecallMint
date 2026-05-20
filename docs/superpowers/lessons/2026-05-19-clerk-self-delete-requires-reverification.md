# Clerk の self-delete は Session Reverification を要求する

> **Source**: 2026-05-19 staging smoke (S1.8 push 後) で発覚した「アカウント
> 削除が『削除に失敗しました』 で固まる」 bug の root cause 調査 + S1.9 fix で
> 得た知見。 Clerk の自前 UI で sensitive action を扱う全 project に再利用。

## 1. 背景

S1.8 push 後の staging smoke で、 新規 sign-up → アカウント削除 button →
「削除に失敗しました。 時間を置いて再度お試しください」 で固まる症状が発生。

調査初期は code 経路 (delete-button / webhook / polling / Clerk SDK wrapper /
middleware) を git log で全 audit したが、 baseline (initial commit
`236a189`) 以降 **削除フローに logic 変更は皆無**だった。 Clerk Dashboard の
self-delete toggle も ON、 publishable key も Vercel env と一致、 CORS / cookie /
認可も正常。 それでも 403 で reject されていた。

真因は DevTools Network tab で確定:

```json
{
  "errors": [
    {
      "message": "Reverification required",
      "long_message": "You need to provide additional verification to perform this operation",
      "code": "session_reverification_required"
    }
  ],
  "clerk_trace_id": "ab0db09233b2b997f052c1c3762252e4"
}
```

`POST https://<frontend-api>.clerk.accounts.dev/v1/me?_method=DELETE` が 403。
Clerk の **Session Reverification** 機能による意図的拒否だった。

## 2. Lessons Learned

### 2.1 self-delete は Clerk 仕様上の sensitive action、 step-up auth が必須

Clerk は account 削除 / password 変更 / email 変更 / MFA 設定変更 等を
**sensitive action** に分類し、 「直近で再認証 (password / MFA 再入力) を
済ませた session」 でしか実行を許さない。 古い session のまま `user.delete()`
を叩くと API が 403 `session_reverification_required` を返す。

これは bug ではなく Clerk の security design。 Dashboard の「Allow users to
delete their account」 toggle が ON でも、 reverification は別軸で常に効く。

### 2.2 prebuilt component は自動 handle、 自前 UI は明示 handle が必須

Clerk の prebuilt `<UserProfile />` 経由で削除すると、 component 内部が
reverification modal を自動で出して再認証 → retry まで面倒を見る。

一方、 **自前 UI で生の `user.delete()` を呼ぶと SDK は何も挟まない**。
403 がそのまま JS の reject として返り、 catch しなければ「失敗」 になる。
自前の sensitive action UI では reverification を **明示的に組み込む責務が
開発者側にある**。

RecallMint は CLAUDE.md の品質基準で「Clerk UI コンポーネントを基本使用」
としつつ、 削除フローは plan00 由来の自前 UI (server redirect 等の独自要件)
で組んでいたため、 この落とし穴に正面から当たった。

### 2.3 対処は `useReverification()` hook で fetcher を wrap する

Clerk 公式 path は `useReverification()` hook。 sensitive action を行う関数を
wrap すると、 enhanced 版が返る。 これを呼ぶと:

1. backend が reverification を要求したら Clerk が **自動で modal を出す**
2. user が再認証を完了したら、 **元の request を自動 retry**
3. user が modal をキャンセルしたら reject (専用 error)

```tsx
'use client'
import { useReverification, useUser } from '@clerk/nextjs'
import {
  isClerkRuntimeError,
  isReverificationCancelledError,
} from '@clerk/nextjs/errors'

function DeleteButton() {
  const { user } = useUser()
  // hook は component top-level で呼ぶ (React hooks ルール)
  const deleteAccount = useReverification(() => user?.delete())

  const onConfirm = async () => {
    try {
      await deleteAccount()
      // 成功: 後続処理 (polling / redirect 等)
    } catch (err) {
      // キャンセルは「失敗」 ではなく「中断」 として別経路で扱う
      if (isClerkRuntimeError(err) && isReverificationCancelledError(err)) {
        // 再試行可能な状態に戻す。 error message は出さない
        return
      }
      // それ以外は本物の失敗
      console.error(err)
    }
  }
}
```

### 2.4 cancel を「失敗」 と区別する — UX 上の必須分岐

reverification modal は user が ✕ で閉じられる。 これを「削除失敗」 扱いに
すると、 「ちょっと迷ってキャンセルしただけ」 のユーザーに赤いエラーを
見せることになる。 `isReverificationCancelledError` で判定し:

- **cancel**: error message を出さず、 再試行可能な状態 (confirm phase 等) に戻す
- **本物の失敗**: error message を表示 + console.error で診断 log

`isClerkRuntimeError(err) && isReverificationCancelledError(err)` の 2 段
判定が公式 pattern (runtime error であることを先に narrow)。

### 2.5 catch で error を握り潰すと root cause 特定が不能になる

本 bug の調査が長引いた最大原因は、 delete-button.tsx の catch が
`catch { setErrorMsg('削除に失敗しました') }` で **error object を一切
受け取っていなかった**こと。 何が throw されているか staging でも devtools
でも見えず、 推測仮説を 5 件並べる羽目になった。

sensitive / 外部 API 経路の catch は最低限 `catch (err) { console.error(err) }`
を必ず入れる。 staging では `err.message` を UI にも露出すると切り分けが
さらに速い (production は内部情報秘匿で汎用文言)。

## 3. DevTools で root cause を 5 分特定する methodology

catch で握り潰されている場合でも、 **Network tab は嘘をつかない**。

1. DevTools → Network tab を開いた状態で再現操作
2. 失敗した request (本件は `POST .../v1/me?_method=DELETE`) を特定
3. Status code を見る (403 / 401 / 422 / 404 で原因クラスが分かれる)
4. Response の JSON body を読む — Clerk は `errors[].code` に機械可読な
   理由を必ず入れる (`session_reverification_required` 等)
5. `clerk_trace_id` を控える (Clerk サポート問い合わせ時の参照 key)

catch の握り潰しは「JS 例外」 を消すが「HTTP request の事実」 は消せない。
コード変更で diagnostic を入れる前でも、 Network tab で先に当たれる。

## 4. 一般化 — 他の sensitive actions

同じ reverification 要求は self-delete 以外にも効く。 自前 UI で扱うなら
すべて `useReverification()` での wrap が必要:

- `user.delete()` — account 削除 (本件)
- `user.update({ primaryEmailAddressId })` — primary email 変更
- password 変更系
- MFA (TOTP / backup codes) の追加・削除
- email / phone の追加・削除

RecallMint MVP は現状 self-delete 以外に該当 path がない (billing は Stripe
Customer Portal に委譲、 profile 編集 UI なし)。 将来そうした自前 UI を
追加する際は本 lesson を参照し、 最初から `useReverification()` で組むこと。

## 5. 再発防止チェックリスト

自前 UI で Clerk の sensitive action を呼ぶとき:

- [ ] `useReverification()` で wrap したか (生の `user.delete()` 等を直呼びしてないか)
- [ ] hook は component top-level で呼んでいるか (React hooks ルール)
- [ ] `isReverificationCancelledError` で cancel を「失敗」 と区別したか
- [ ] catch は `catch (err)` で error を受け、 最低 `console.error` したか
- [ ] staging で err 詳細を UI 露出する diagnostic を入れたか

## 6. 参考

- 調査本体: `docs/superpowers/sessions/2026-05-19-deletion-and-empty-exam-investigation.md` (commit `3c81445`、 Issue 1)
- S1.9 fix session log: `docs/superpowers/sessions/2026-05-19-s1-9-deletion-and-empty-exam-fix.md`
- Clerk webhook architecture (削除フロー全体像): `docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md`
- Clerk 公式:
  - Reverification 概要: https://clerk.com/docs/guides/secure/reverification
  - `useReverification` hook: https://clerk.com/docs/reference/hooks/use-reverification
  - error handling: https://clerk.com/docs/guides/development/custom-flows/error-handling
- error helpers: `@clerk/nextjs/errors` の `isClerkRuntimeError` / `isReverificationCancelledError`
