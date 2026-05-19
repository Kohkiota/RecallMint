# Session continuation pointer (2026-05-19 EOD)

> 次セッション継続用の最小 pointer。 本 file 1 つ読めば「今どこにいるか」 と
> 「次に何をするか」 が分かる構造。

---

## 現在地

**develop は origin と同期済**、 working tree clean。 今日 1 日で 15 commit 進めた。

直近で完了した sprint (新しい順):
1. **Vercel Deployment Protection lesson 蒸溜** (commit `3a6c0b5`) — 真の hotfix 原因を lesson 化
2. **account-prep-stuck investigation** (commit `c859032`) — 調査時は Clerk H1/H2 を推定したが、 真因は Vercel Hobby Protection
3. **S1.7 OCR enforcement + UX + exam viewer** (commit `0f7aa19` 〜 `b048f90`、 7 commit、 formal review pass) — plan-limits enforce + quota UI + 90s timeout + /app/exams viewer + 試験 nav
4. **S1.5 hotfix (startTransition bug)** (commit `01057f1` + `6307ada`) — 必須 1-3 失敗の root cause を urgent priority 統一で修正
5. **S1.5 UX polish** (commit `8eed296` 〜 `4085526`、 4 commit) — spinner / disable / nav guard / 同名 reject
6. **S1a OCR core** (前日完了済) — file picker → Gemini → cards INSERT の本実装

---

## OT pending (次セッション開始時に確認すべき状態)

### A. Vercel Deployment Protection (最重要、 lesson `3a6c0b5` で蒸溜済)

- staging の Require Log In = OFF 維持で sign-up + webhook flow が動くこと
- production scope も同様に OFF 推奨 (Clerk middleware で /app/* 保護済、 機能セキュリティに穴開かない)

### B. production DB migration

- S1a 中に staging には apply 済の `cards.tags text[]` migration (`drizzle/migrations/
  0003_free_killmonger.sql`) が production には未 apply
- OT が host WSL から `DATABASE_URL='postgresql://...prod...' pnpm db:migrate` で
  apply 必要、 production active user 0 件のため backfill 不要

### C. staging smoke (S1.7 完了後の確認、 7 シナリオ)

`docs/superpowers/sessions/2026-05-19-s1-7-enforce-ux-exams-handoff.md` §「OT 側
staging smoke」 を参照:
1. 残量 banner (Free 30/30 表示)
2. 10 page 投入 → 残量 20/30
3. 25 page 投入 → amber warning + submit disable
4. 30 page ジャスト → 残量 0/30
5. 残量 0 で 1 page → submit disable + 警告
6. 詳細エラー (Gemini 意図的失敗 → staging で詳細 banner)
7. /app/exams 一覧 + 詳細 + nav 動作確認

### D. [reviewed] tag 戦略の判断

S1.7 で 5 commit が provisional [no-review]、 1 follow-up が [reviewed]。 staging
smoke pass 後の処理選択:
- 案 A: interactive rebase で各 feat commit に [reviewed] amend (履歴綺麗)
- 案 B: follow-up commit で smoke 結果記録 + 既存 tag 据え置き (audit trail)

→ S1a 時点の handoff doc で OT 判断保留中

---

## 次にやる候補 sprint (優先度順)

### S1b (極小、 1-2 commit、 1 session で終わる)

- dashboard 空状態 onboarding 文言 (「最初の試験を作成」 等)
- dashboard 月次 OCR ページ消費 metric (`/app/upload` 上部 banner と重複するなら scrap 判断あり)
- size / page 超過時の文言 polish

### S2 問題管理 (中-大、 8-12 commit)

- exam rename / archive UX 確定 (S1.7 review I1 archived URL access の defer 含む)
- cards 編集 UI (question / options / explanation / custom_props value)
- 単一 cards 削除
- source_document 単位の cascade delete
- (副次) S1.7 review I2 page count consistency mitigation

### S3 メタデータ UI (中、 5-7 commit)

- 一括 tag 編集 (bulk select)
- custom_props key / value 編集
- フィルタ / ソート UI

### S4 学習画面 (中、 6-9 commit)

- `/app/study/smart` + `/app/study/practice` 新規
- `/app/quiz` placeholder 削除 + AppPath 更新
- FSRS scheduler + reviews INSERT + cards 統計更新

### S8 / S9 (launch 直前、 各 2-4 commit)

- legal placeholder 12 件 sed 一括置換
- 利用規約同意 flow (Clerk appearance + Vercel Deployment Protection 確認)
- smoke Playwright E2E (任意)
- launch (production 切替確認 + sitemap 更新)

---

## 次セッション kickoff prompt の作り方

`docs/superpowers/sessions/2026-05-19-s1-7-enforce-ux-exams-handoff.md` の S2 / S3
defer 事項 + 本 file の「次にやる候補」 から sprint を選び、 通常の sprint kickoff
template (S1a / S1.7 同様) で起動する。 過去 commit hash を背景情報に含めること
(Claude Code は前セッションの会話を持たないため、 commit + handoff doc が継続性の
担保)。

最小 kickoff 例:
```
# S1b dashboard onboarding sprint kickoff

S1.7 (commit 0f7aa19..b048f90、 formal review pass、 staging smoke pending) 完了後の
dashboard polish。 詳細仕様は kickoff で記述、 前提は handoff doc 群に集約済:

- 2026-05-19-s1-7-enforce-ux-exams-handoff.md (直前 sprint)
- 2026-05-19-session-handoff-pointer.md (本 file、 全体 map)

[scope を箇条書き]
```

---

## 重要 file 一覧 (継続性 anchor)

### handoff docs (sprint 単位)
- `docs/superpowers/sessions/2026-05-19-s1a-ocr-core-handoff.md` (OCR core)
- `docs/superpowers/sessions/2026-05-19-s1-5-upload-ux-polish-handoff.md` (UX polish + hotfix Addendum)
- `docs/superpowers/sessions/2026-05-19-s1-7-enforce-ux-exams-handoff.md` (enforcement + exam viewer)
- `docs/superpowers/sessions/2026-05-19-account-prep-stuck-investigation.md` (Clerk H1/H2 推定、 訂正済)
- `docs/superpowers/sessions/2026-05-19-session-handoff-pointer.md` (本 file)

### lessons (永続知見)
- `docs/superpowers/lessons/2026-05-19-vercel-hobby-deployment-protection-and-webhooks.md` (本日の真因 lesson)
- `docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md` (SyncingPage + webhook race)

### state reconciliation (常時前提)
- `docs/superpowers/sessions/2026-05-19-state-reconciliation.md` (12 table baseline + Tech Spec 整合)
- `docs/superpowers/sessions/2026-05-19-sprint-roadmap-review.md` (S1-S9 全体 map)

### 設計 reference (常時前提)
- `docs/02-tech-spec.md` (S0-1 で schema.ts 整合済)
- `docs/research/ocr-schema-vs-discover.md` (discover mode 採用根拠)
- `lib/db/schema.ts` (source of truth、 13 table 含む cards.tags)
- `CLAUDE.md` (絶対ルール)

---

## 今日 1 日の commit 履歴 (15 commit、 全 origin push 済)

```
3a6c0b5 docs(lesson): Vercel Hobby plan の Deployment Protection が webhook を 401 で蹴る
c859032 docs(session): investigate sign-up account preparation stuck
b048f90 docs(session): S1.7 OCR enforcement + UX + exam viewer sprint handoff
471e23a fix(upload+exams): address S1.7 review Important findings   [reviewed]
88a3817 feat(nav): add 試験 link to app header + AppPath
d1cace8 feat(exams): minimal read-only exam list + cards view
24e5937 feat(upload): quota header + total pages + warning + detail error + 90s timeout
ce10bca fix(upload): server action - structured error code + enforce before any DB write
0f7aa19 fix(usage): exclude stale processing source_documents from monthly page count
6307ada docs(session): s1.5 handoff hotfix addendum (startTransition bug)
01057f1 fix(upload): drop startTransition to ensure submitting state renders
4085526 docs(session): S1.5 OCR upload UX polish mini-sprint handoff
5d82c57 feat(upload): reject duplicate filename on file selection
64d3dc8 feat(upload): guard tab close / browser back during OCR submitting
8eed296 feat(upload): show spinner + disable all controls during OCR submitting
```

test 推移: 254 (S0-3 末) → 285 (S1a) → 307 (S1.5) → 317 (S1.7)、 build 通過維持。
