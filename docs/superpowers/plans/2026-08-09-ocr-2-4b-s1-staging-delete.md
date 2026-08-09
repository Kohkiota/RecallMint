# ②-4b §1: entry 削除時の R2 staging cleanup 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** entry ×(削除)に同期した source object の best-effort DELETE(削除主体の一意化・案 A)。

**Architecture:** spec = `docs/superpowers/specs/2026-08-09-ocr-2-4b-s1-staging-delete-design.md`
(承認済・凍結。task の判断が spec と食い違ったら実装せず停止)。
server action 1 本新設 + client `upload-form.tsx` の registry/checkpoint 配線 + 台帳 catalog 1 entry。

**Tech Stack:** Next.js Server Action / zod v4 / Vitest(実 API 不使用・全 mock)。

## Global Constraints(全 task 共通)

- TDD: 各 pin は red(fail 確認)→ green の順。まとめて壊さず gate ごとに変異(red 実証規律)。
- migration / schema / env 追加なし。R2 実呼出なし(unit は全 mock)。
- 不変条件(spec §5): ① checkpoint 判定・ref 解除・purge は同一同期区間(await を挟まない/
  inFlight 解除は finally)② `disabled={isSubmitting}` + purge の 2 層 ③ 削除主体の一意性
  ④ client から key 文字列を送らない。
- feat commit は canonical review(requesting-code-review 既定経路)+ Codex(`codex-review.sh`)
  pass 後に `[reviewed]`。commit 直前宣言 4 点を chat に出す。
- 簡潔性規律: 新 helper・抽象化は plan 記載分のみ。scope 外のコードに触らない。

---

### Task 1: server action `deletePdfSource` + 台帳 catalog

**Files:**
- Create: `app/(app)/app/upload/_actions/delete-pdf-source.ts`
- Create: `app/(app)/app/upload/_actions/delete-pdf-source.test.ts`
- Modify: `lib/integration-failures.ts`(catalog に 1 entry 追加のみ)

**Interfaces(Task 2 が依存):**
- `export interface DeletePdfSourceInput { uploadSessionId: string; fileId: string }`
- `export async function deletePdfSource(input: DeletePdfSourceInput): Promise<ActionResult<void>>`
  (`ActionResult` = `lib/actions/result.ts` の既存型。成功 = `{ ok: true }`)

**目的:** spec §3/§4。`finalize-pdf-source.ts` の骨格(`'use server'` / `currentUserOrNull` idiom /
zod `z.uuid({ version: 'v4' })` ×2 / `sourcePdfObjectKey(user.id, uploadSessionId, fileId)` server 導出)
を踏襲し、`deleteObject(key)` を呼ぶ。`!result.ok` 時のみ `recordIntegrationFailure({ key:
'r2_staging_delete', userId: user.id, subject: 'staging source PDF delete failed', context:
{ objectKey, status: result.status } })` — その throw は catch して `logger.error`(action は
throw しない契約・`deleteSourceKeys` と同 idiom)し `{ ok: false, error: '削除に失敗しました' }`。
catalog 追加値は spec §4 の 4 軸そのまま + コメント(既存 entry の様式・r2_source_delete との
workflow 軸区別を 1 行)。

**制約:** 未認証 / zod 不正は `{ ok: false, error: … }`(文言は finalize と同型)で `deleteObject`
不呼出。key 系 field の紛れ込みは zod strip で無視(reserve と同水準)。

**完了条件(test で pin・mock 構成 = `finalize-pdf-source.test.ts` の `vi.hoisted` 様式):**
未認証→不呼出 / 非 uuid→不呼出 / 正常→`sourcePdfObjectKey` の key で呼出+台帳不呼出+`{ok:true}` /
`deleteObject` 失敗(`{ok:false,status:500}`)→台帳が 4 軸 key と `{objectKey,status}` context で
呼ばれる / **404(`{ok:true,status:404}`)→ `{ok:true}` + 台帳不呼出**(重複 DELETE の中心契約・
Codex 採用 4)/ `recordIntegrationFailure` reject→飲んで `{ok:false}` を返す(throw しない)。
red→green 実証・canonical + Codex pass → `[reviewed]` commit。

---

### Task 2: client 配線 — `pdfSourceRef` / removeEntry 分岐 / checkpoint 3 点 / purge

**Files:**
- Modify: `app/(app)/app/upload/_components/upload-form.tsx`
- Modify: `app/(app)/app/upload/_components/upload-form.test.tsx`

**Interfaces(Task 1 を消費):** `deletePdfSource({ uploadSessionId, fileId })` を
`void deletePdfSource(...).catch(() => {})` で fire-and-forget(結果不使用・UI 変更なし。
`.catch` は action 呼出自体の network reject による unhandled rejection 防止 — Codex 採用 3)。
test 側は既存 idiom で `vi.mock('../_actions/delete-pdf-source', …)` を追加。

**目的:** spec §2 の削除主体一意化を既存機構(generationRef)相乗りで配線する。

**実装(spec §2.1〜2.3 の写像・この 5 点のみ):**
1. `const pdfSourceRef = useRef<Map<string, { uploadSessionId: string; inFlight: boolean }>>(new Map())`
2. `reservePdfBatch` 成功 loop: `void continuePdfUpload(...)` の直前(同一同期区間)に
   `const rec = { uploadSessionId, inFlight: true }` を作って `pdfSourceRef.current.set(f.id, rec)`
   し、**record object を continuation へ引数で渡す**(identity guard・Codex 採用 2)。
3. `continuePdfUpload(file, id, generation, uploadSessionId, uploadUrl, rec)`: 本体を try/finally で
   包み、registry への mutate/delete は**すべて `pdfSourceRef.current.get(id) === rec` の時のみ**
   (自分の登録した record だけを触る — retry 等で別 record に差し替わっていたら何もしない)。
   finally で `rec.inFlight = false`。checkpoint = 無効判定
   `generationRef.current.get(id) !== generation` を
   (a) PUT fetch 前 — 無効なら map.delete(guard 付)して return(PUT しない・object 未作成)
   (b) PUT await 直後 — 無効なら **putOk 不問で** `void deletePdfSource(...).catch(() => {})`
       → map.delete(guard 付)→ return(uncertain outcome 回収・spec §2.1-2 改訂)
   (c) finalize await 直後と catch 節先頭 — 無効なら同上 DELETE → map.delete(guard 付)→ return
   (checkpoint 判定〜map 操作の間に await を挟まない・spec §5-1。**この順序保証はコードの
   comment でも pin する** — Codex 採用 5)
4. `removeEntry`: `generationRef.current.delete(id)` の直後に
   `const rec = pdfSourceRef.current.get(id)` → `rec && !rec.inFlight` なら
   `void deletePdfSource({ uploadSessionId: rec.uploadSessionId, fileId: id })` + `map.delete(id)`。
   `inFlight` なら何もしない(continuation が主体)。
5. purge: `runProcess` で submit 前に `const submittedSessionId = uploadSessionIdRef.current` を
   捕捉し、無効化 2 点(`accepted` 受信 / submitUpload throw)で null 化と**同一同期区間**に
   `pdfSourceRef` から `uploadSessionId === submittedSessionId` の全登録を削除
   (inFlight 不問・spec §2.2。helper `purgePdfSourceRegistry(sessionId: string)` を module 内 or
   component 内関数で 1 つだけ追加。`submittedSessionId` が null = PDF なし submit は purge 不要)。

**完了条件(spec §6 の upload-form pin を red→green で。既存 harness の
`mockReservePdfUploadUrls` / `mockFinalizePdfSource` / `mockFetchPut` の解決タイミング制御を再利用):**
ready 削除→(session, fileId) で呼出 / error(finalize throw 由来)削除→呼出 / image 削除→不呼出 /
uploading 中削除→即時不呼出・PUT 解決後に呼出 / counting 中削除→finalize 解決後に呼出 /
reserve 未解決中削除→PUT fetch 不発火 / accepted 後の purge で旧 session へ不発火 /
**submit 中の削除ボタン disabled pin(OT 指定)** / 既存 pin(stale finalize・空で session null・
retryPdfSession)全 green。canonical + Codex pass → `[reviewed]` commit。

---

### Task 3: docs — architecture.md の DELETE 経路列挙に staging 経路を追記

**Files:**
- Modify: `docs/architecture.md`(source 行 1 箇所)

**目的:** 「明示 DELETE + lifecycle 保険」の経路列挙(現在: 完了通知 reject + pipeline 出口)に
「entry 削除時の client 発 staging DELETE(`delete-pdf-source` action・②-4b §1・削除主体一意化)」を
追加し、証明列に Task 1/2 の test file を足す。単一点主張を偽にしない(lesson 準拠)。

**完了条件:** 行の主張と実装が一致(適用範囲の限定 — submit 後は pipeline 出口・unmount は
lifecycle — を同じ文に保持)。`docs(architecture)` + `[no-review]` commit。

---

## Sprint 完了 gate(Task 3 の後・報告 chat に各 1 行明記)

- whole-repo `pnpm lint`(--max-warnings=0)exit 0 / `pnpm typecheck` 0 / `pnpm build` 0
  (Next 設定 file は不触だが upload 配下の Server Action 追加ゆえ build まで回す)
- `pnpm test` 全 green(既知 flaky 2 file は単体再走で判定)/ `pnpm test:iso` green / `pnpm run audit` exit 0
- whole-branch canonical review(範囲 = §1 の全 commit)

## 完了後(OT へ渡す)

- OT push → stg smoke(CC 実走・spec §9): ready 削除 / uploading 中削除の 2 面 +
  session prefix listing で 0 件収束。**既存 `src/` 2 object(sentinel)不可触**。
- 台帳確認(42501 ゆえ OT 照会): fact-finding §4.5 の SQL に `workflow = 'upload_staging'` 変形。
