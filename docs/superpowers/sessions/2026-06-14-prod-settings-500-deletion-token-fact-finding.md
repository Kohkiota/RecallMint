# prod /app/settings 500 incident (DELETION_TOKEN_SECRET 未設定) fact-finding

- **日付**: 2026-06-14
- **branch / head**: develop = main = `4c19314` (T-B6 close 後、 origin より 3 commits 先)
- **incident**: prod 環境で `/app/settings` 開くと 500、 root cause = `DELETION_TOKEN_SECRET` env 未設定で page render 時に `signDeletionToken` が throw
- **status**: fact-finding 完了、 OT 判断待ち (案 α/β/γ + 止血)
- **制約遵守**: コード/deploy/env 無改変、 secret 値非出力、 全部読取のみ

---

## §1 incident の真因

### §1a. 500 boundary は polling 中ではなく page 描画時

`app/(app)/app/settings/page.tsx:48-50`:
```ts
const deletionStatusToken = user.clerkId
  ? signDeletionToken(user.clerkId)
  : ''
```

`signDeletionToken` は **毎 page 描画時に呼ばれる** (削除中限定ではない)。

`lib/security/deletion-token.ts:44-66`:
```ts
function getSecret(): string {
  const secret = process.env.DELETION_TOKEN_SECRET
  if (secret) return secret
  if (process.env.VERCEL_ENV === 'production') {
    throw new Error(
      'DELETION_TOKEN_SECRET must be set in production (see audit §10.4 #11)',
    )
  }
  // preview / local: deterministic dummy secret for dev UX
  return 'dev-only-deletion-token-secret-placeholder'
}
```

prod (`VERCEL_ENV=production`) で env 未設定 → `getSecret()` throw → page render 失敗 → 500。 dev / preview は placeholder fallback で動作継続するため smoke で気づかなかった。

**影響範囲**: prod の **全 user の `/app/settings` 全 path が 500** (削除実行中の polling のみではない)。

`.env.example:79`: `DELETION_TOKEN_SECRET=` (空文字、 = 値 fill が必要な明示マーカー)。

---

## §2 deletion-status / deletion-token が守る対象

### §2a. API は「polling のみ」 (削除実行はしない)

`app/api/me/deletion-status/route.ts:1-83`: GET-only。 4 状態 (`not_found / pending / clerk_synced / completed`) を返すだけ。 削除実行は client SDK `user.delete()` (Clerk) + Clerk webhook (`/api/webhooks/clerk` で受信 → server-side DB cascade)。

### §2b. 元症状 (audit + codex 原文)

**codex #6 原文** (`docs/codex/2026-06-08-codex-review.md:83-87`):
```
### 6. `/api/me/deletion-status` は public endpoint として設計されているが、userId の列挙・状態観測ができる

`app/api/me/deletion-status/route.ts` は Clerk auth なしで `userId` query を受け、
`not_found/pending/clerk_synced/completed` を返す。削除後 polling 目的は理解できる
が、`user_...` 形式の ID を知っている相手には状態観測が可能になる。
```
codex 採点: **P3** (低)、 工数 M、 推奨 = 「raw user id ではなく、 短命 nonce / signed token に bind した polling」。

**audit §10.4 #11** (`docs/audit/2026-06-12-repo-wide-audit.md:441`):
```
11. [P2] deletion-status nonce / signed token 化 (codex #6、 既知)
```

**audit §10.4 #58** (`docs/audit/2026-06-12-repo-wide-audit.md:58`):
```
- [P2] [both] `app/api/me/deletion-status/route.ts:33-39` — userId 列挙 oracle
  (codex #6 を裏付け、 Codex 行 29 + 行 55 で既知扱い)。 CC 視点で P2、 Codex 視点
  P3。 厳しい方 **P2 採用**。 工数 S
```

**classification**: **既存の脆弱性の修正** (新規予防ではない)。 旧仕様 (`/api/me/deletion-status?userId=user_xxx`) は raw userId を query param で受け取り、 攻撃者が他 user の `clerkId` を知っている場合に削除状況 (4 状態 / 削除タイミング) を観測可能だった。

**漏洩する情報の機密性**: 中 → 低
- PII ではない
- 「削除中である / 完了している」 が observable
- 削除フローのタイミングが分かる
- 「user_xxx の clerkId を別経路で取得した上で削除タイミングを oracle 化」 という攻撃 chain で意味を持つ

### §2c. git blame で導入経緯

```
b6d742d fix(security): T-A9 #11c — deletion-status signed token (HMAC + 24h ttl、 重要 fix、 無 tag)
be67276 fix(security): T-A9 #11c — deletion-status signed token (HMAC + 24h ttl、 重要 fix、 無 tag)
```

T-A9 #11c で audit §10.4 #11 (P2) を解消。 commit message に **「重要 fix」 タグ** (= 決済・認証・**削除**・外部副作用 のうち「削除」 該当)。 OT 実機確認後の [reviewed] tag 運用に乗ったはず。

---

## §3 アカウント削除の全体フロー (deletion-status の位置づけ)

### §3a. 削除実行は Clerk + webhook、 polling は UX 用

| step | 主体 | 内容 |
|---|---|---|
| 1 | client (delete-button.tsx) | `user.delete()` (Clerk SDK) で Clerk 側 user 削除実行 |
| 2 | Clerk | 削除完了通知 (= `user.deleted` webhook) を `/api/webhooks/clerk` に POST |
| 3 | server (`webhooks/clerk/route.ts`) | (a) Stripe sub cancel-with-retry → (b) `users.deletedAt` set (soft delete) → (c) 子データ物理削除 (exams / cards / study_sessions etc.) |
| 4 | client (delete-button.tsx, polling) | `/api/me/deletion-status?token=<signed>` を 1 秒間隔 × 最大 30 秒 polling、 `completed`/`not_found` 到達で `/sign-out-deleted` へ navigate |
| 5 | 30 秒経過 fail-safe | step 4 が 30 秒以内に完了しない場合、 client が `window.location.replace('/sign-out-deleted')` で強制 navigate (= **zombie net**) |
| 6 | layout zombie net (`app/(app)/app/layout.tsx:41-43`) | back / re-entry した user が `deletedAt set` なら `/sign-out-deleted` redirect |
| 7 | BFCacheGuard | back/forward cache 復元時に server reload 強制 (zombie state 防止) |

### §3b. deletion-status (= polling endpoint) の役割

- **UX 用の進捗確認**: 削除実行から step 3 完了までの数十秒間、 user に「待たせている」 状態を可視化
- **削除完了 detection**: step 3 完了を即時検知して `/sign-out-deleted` へ navigate
- **削除実行とは独立**: polling endpoint が無くても、 zombie net (step 5/6/7) で UX は破綻しない (ただし「30 秒の wait + 強制 navigate」 になる)

### §3c. 「session を消した後に走る」 構造的制約

`user.delete()` 後は Clerk session が無効 → `auth()` が null → Clerk session 認可は構造的に不可能。 これが「自前 secret + HMAC token」 を要する設計上の理由 (session-less authz problem)。

---

## §4 Clerk への委譲可能性

### §4a. 現状 Clerk が担う範囲

- `@clerk/nextjs` (`useUser` / `auth()` / `useReverification`)
- `user.delete()` (client SDK)、 `user.deleted` webhook (server 通知)
- session reverification (sensitive action protection)

Clerk が提供して**いない**機能 (= self-host 必須):
- **自前 DB の deletedAt / subscription_status の参照** (Clerk は Clerk 側削除のみ追跡、 我々の DB cleanup や Stripe cancel 完了は知らない)
- **削除済 user の状況参照 endpoint** (削除済 user は Clerk 側で消滅、 query 不能)

### §4b. 「Clerk セッション認可」 で代替できるか

**できない**。 理由:
- `/api/me/deletion-status` を呼ぶ瞬間には Clerk session が無効 (user.delete() で破壊済)
- session 認可を成立させるには「削除前に何らかの credential を sign / cookie set」 する必要 → 結局 HMAC + secret と同等の機構が必要 (cookie 形式に翻訳しただけ)

### §4c. 「deletion-status endpoint を消す」 と何が壊れるか

| 失う機能 | 影響度 |
|---|---|
| 削除完了の即時 detection | 低 (30 秒 fail-safe で吸収済) |
| 削除中の進捗 UX | 中 (skeleton 出せない、 即 navigate になる) |
| ストレージ cleanup 完了の保証 | なし (= もともと polling は cleanup 完了を待たない、 webhook 経路で完結している) |
| Stripe cancel 完了の保証 | なし (= 同上、 webhook 経路で完結) |

→ polling endpoint を消しても **削除実行や Stripe cancel は影響なし** (これらは Clerk webhook で完結している)。 失うのは「30 秒以内に navigate するための UX 補助」 のみ。

### §4d. 「廃止すると何の穴が開くか」

audit §10.4 #11 が塞いだ穴 = **userId 列挙 oracle** (他 user の削除状況を observe)。 polling endpoint 自体を廃止すれば、 攻撃面そのものが消滅 → **新たな穴は開かない**。

(secret 漏洩リスク・rotation 運用コストもなくなる)

---

## §5 案 α / β / γ (OT 判断材料)

### 案 α: 廃止 (polling endpoint + delete-button polling effect を消す) **← CC 推奨**

- **設計**:
  - `app/api/me/deletion-status/route.ts` 削除
  - `app/(app)/app/settings/delete-button.tsx` の polling useEffect 削除 (`window.location.replace('/sign-out-deleted')` を `user.delete()` resolve 直後に即実行)
  - `app/(app)/app/settings/page.tsx` から `signDeletionToken` import + token 生成削除
  - `lib/security/deletion-token.ts` + `lib/security/deletion-token.test.ts` 削除
  - `.env.example` から `DELETION_TOKEN_SECRET=` 削除
  - audit §10.4 #11 を「P2 close (廃止で解消)」 として記録
- **UX 影響**: 削除中 skeleton が消え、 button push → 即 `/sign-out-deleted` 表示。 backend 処理 (webhook 経由 Stripe cancel + 子データ削除) は背景で継続、 user 視点では「削除済」 page 表示後に Clerk session destroy が完了
- **残る穴**: なし。 攻撃面ゼロ (endpoint なし → 列挙不能)
- **工数**: S (100-150 行削除 + sign-out-deleted page 文言確認 + test 削除)
- **secret 管理**: 不要
- **prod 即時止血**: env 投入を一旦行えば即解消可、 廃止 deploy 後に env 撤去

### 案 β: Clerk session 委譲 (secret 廃止)

- **設計**: 削除前 (session 生存中) に short-lived cookie set → polling endpoint は cookie 提示で認可
- **問題**: cookie content (userId) を server で署名する必要 → HMAC + secret が cookie の形式に翻訳されただけ。 secret 管理は不要にならない
- **評価**: **案として成立しない** (HMAC を別形式に書き換えただけ、 secret 廃止という条件を満たさない)
- **削除候補**

### 案 γ: 現仕様維持 (prod env に `DELETION_TOKEN_SECRET` 投入)

- **設計**: prod env (Vercel) に `DELETION_TOKEN_SECRET = <32-byte random hex>` 投入 + redeploy
- **生成例 (OT 側で実行)**: `openssl rand -hex 32` で 64-char hex (= 32-byte random)、 secret 値は env のみで保持、 git / chat に出さない
- **影響**: 既存 T-A9 修正効果維持 (userId 列挙 oracle 塞いだまま)
- **工数**: XS (env 1 行 + redeploy)
- **残るコスト**: secret rotation 運用、 漏洩時対応、 preview tier に同 placeholder fallback がある仕様の保守
- **prod 即時止血**: 同 commit で即解消

### CC 推奨

**案 α (廃止) を構造改善として推奨**。 ただし**即時止血としては案 γ (env 投入) を先行実施**。 順序:

1. **止血 (今日)**: prod env に `DELETION_TOKEN_SECRET` 投入 + redeploy → `/app/settings` 500 即解消
2. **構造改善 (後続 sprint)**: 案 α 実装 (Sub-plan A の Y-3 繰越 or 新 task として起票)、 deploy 後に prod env から secret 撤去

理由:
- 案 α は **secret 管理を撤去 + 攻撃面ゼロ** で長期的に優位
- 案 γ は 工数 XS で即解消できるが、 secret 運用コストが永続
- 案 β は HMAC 廃止条件を満たせず evaluatable でない
- T-A9 を「重要 fix」 として実装した経緯から、 単純廃止は OT 同意必要 (audit §10.4 #11 の close 判断)

---

## §6 制約遵守確認

- [x] コード変更・commit・deploy・env 操作なし (読取のみ)
- [x] secret 値の出力なし (本 doc に値の片鱗も載せていない)
- [x] 実コード全文 + audit 原文 + git blame 出典明記
- [x] 「自前は危険だから廃止」 が穴を開け直さないか検証済 (§4c / §4d で「廃止 = 攻撃面ゼロ、 削除 UX 補助のみ失う」 を確定)

## §7 出典まとめ

- `lib/security/deletion-token.ts:1-126` (実装全文)
- `app/api/me/deletion-status/route.ts:1-83` (実装全文)
- `app/(app)/app/settings/page.tsx:14, 48-50` (token 生成)
- `app/(app)/app/settings/delete-button.tsx:24-123` (polling effect)
- `app/api/webhooks/clerk/route.ts:1-50` (削除実行経路、 server-side)
- `app/(app)/app/layout.tsx:41-43` (zombie net redirect)
- `app/(auth)/sign-out-deleted/page.tsx:1-20` (terminal page)
- `docs/audit/2026-06-12-repo-wide-audit.md:58, 441` (§10.4 #11)
- `docs/codex/2026-06-08-codex-review.md:83-87` (codex #6)
- `.env.example:79` (env key 既存)
- commit `b6d742d` / `be67276` (T-A9 #11c 重要 fix)
