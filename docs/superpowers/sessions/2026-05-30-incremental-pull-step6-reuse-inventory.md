# 増分 pull Step 6 流用棚卸し調査 — OCR 完了 pull(U2)/ 削除反映(U4)の既存相乗り先

- **日付**: 2026-05-30
- **目的**: step 6(exams Dexie 化 UI)で必要な「OCR 完了 → card_count 最新化」「exam 削除 → 一覧反映」の pull を、**新規 polling/検知を作らず既存の仕組みに相乗り**させるための既存ロジック棚卸し。実装変更なし・実コード根拠付き。
- **plan**: `docs/superpowers/plans/2026-05-30-incremental-pull-step6-exams-dexie-ui.md`（U2 / U4）
- **結論先出し**: **新規 helper/検知/polling は不要**。U2 は既存 OCR polling の完了遷移点、U4 は既存削除成功ハンドラに、いずれも step4 の `runGuardedPull` を 1 行相乗りさせれば足りる。設計確定（相乗り先の選択・詳細 page card mutation を含めるか）は plan/OT に委ねる。

---

## 軸1: 試験一覧 OCR ステータス polling（U2 の主相乗り候補）

- **polling 本体**: `app/(app)/app/exams/_components/exam-status-live.tsx` `ExamStatusProvider`。`/api/exams/status`（`STATUS_ENDPOINT`、route 実在 `app/api/exams/status/route.ts`）を **5 秒間隔**（`POLL_INTERVAL_MS=5000`）で fetch、`setStatuses(next)` で context 更新。processing 行が尽きたら恒久停止、タブ hidden 中は停止・可視復帰で再開（`:101-118`）。
- **「処理中 → 完了/失敗」遷移検知（既存）**: 純関数 `app/(app)/app/exams/_components/exam-status-poll.ts` の `processingIds(map)` / `hasCompletion(prevProcessing, nextProcessing)`。`hasCompletion` は「prev で processing だった examId が next で processing でなくなった（= completed で map から消えた / failed に変化）」を検知（`:24-32`）。
- **既存の遷移ハンドラ点**: `exam-status-live.tsx:77-82`:
  ```ts
  const nextProcessing = processingIds(next)
  if (hasCompletion(prevProcessing, nextProcessing)) {
    router.refresh()   // ← processing→完了 を検知して 1 回発火する既存点
  }
  prevProcessing = nextProcessing
  ```
  コメント（`:78-79`）に「processing → completed/failed 遷移時のみ、**card 件数同期のため** refresh」と明記。= この点が「OCR 完了で card 件数を最新化したい」既存意図そのもの。
- **U2 相乗り判定**: **この `hasCompletion` true 分岐が最小の相乗り先**。`router.refresh()` の隣に `void runGuardedPull({ reason: 'ocr-complete' }).catch(()=>{})` を 1 行足せば、既存の 5 秒 polling が検知した完了で pull が走り、新 OCR cards が mirror に入り `useLiveQuery` の card_count が更新される。**新規の完了検知は不要**（既存 polling と `hasCompletion` をそのまま使う）。
- 注: Dexie 化後、`router.refresh()` 自体は RSC 再 render のみで mirror を更新しないため、card 件数同期の実効は pull 側へ移る（`router.refresh()` は statusMap seed 等の RSC 部分更新として残置可）。

## 軸2: OCR 成功検知が polling 以外にあるか（U2 の他候補）

- **OCR server 処理**: `app/(app)/app/upload/_actions/process.ts`。完了時 `revalidatePath('/app/upload')` + `revalidatePath('/app')`（`:128-129`）。= **server RSC revalidate のみ、Dexie 非更新**。
- **card 作成 server action**: `app/(app)/app/exams/[id]/_actions/create-card.ts:34` `revalidatePath('/app/exams')`（server）。
- **試験一覧 page 上の OCR 完了検知は polling（軸1）が唯一**。upload result/page（`app/(app)/app/upload/page.tsx`）は別フロー（自身の RSC、`useLiveQuery`/`setInterval` 等の client poll は試験一覧側には影響しない）。
- **U2 結論**: 試験一覧の card_count 最新化に使える既存検知は **軸1 の polling 完了遷移のみ**。server の `revalidatePath('/app/exams')`（create-card）は list が Dexie 参照になると件数更新に効かなくなる（RSC 再 render は mirror 非更新）。よって相乗り先は軸1 が最小・唯一。

## 軸3: exam/card 削除の既存更新導線（U4）

- **exam 削除（一覧 page、step6 主対象）**:
  - server: `app/(app)/app/exams/_actions/delete-exam.ts` — tombstone（exam 1 + 配下 card 全件）を `deletedAt: sql\`now()\`` で網羅 INSERT（`:69-84`、mirror 削除反映の唯一経路）。`revalidatePath('/app/upload')` のみ（`:34`、`/app/exams` の revalidate は撤去済 `:26-28`）。
  - client: `app/(app)/app/exams/_components/delete-exam-button.tsx:32-39` `onConfirmDelete` 成功分岐で `router.refresh()`（`:39`）。コメント（`:35-38`）に「`/app/exams` の更新責務は本 component の `router.refresh()` が単独で負う」。
  - **U4 相乗り判定**: **この成功分岐（`:39`）が相乗り先**。`router.refresh()` の隣に `void runGuardedPull({ reason: 'exam-delete' }).catch(()=>{})` を足せば、tombstone を mirror に取り込み（pullDelta の tombstone bulkDelete）`useLiveQuery` が行を除去。新規導線不要。
- **card 削除/追加（詳細 page、step6 スコープ外だが list card_count に波及）**:
  - card 削除: `app/(app)/app/exams/[id]/_components/delete-card-button.tsx:31-37` 成功で `router.refresh()`。server `delete-card.ts:33` `revalidatePath('/app/exams')`。
  - card 追加: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:45` `router.refresh()`。server `create-card.ts:34` `revalidatePath('/app/exams')`。
  - これら詳細 page handler も同型の相乗り先候補（list の card_count を即時化したいなら `runGuardedPull` を足せる）だが、**step6 は一覧のみスコープ**。詳細 page mutation 後の list 件数は、足さなければ ambient トリガ（visibility/online/reload）依存。→ 含めるかは plan/OT 判断（U2 の延長）。

## 軸4: 流用可能な pull / トリガー資産

- **`runGuardedPull`**（`lib/sync/pull.ts`、step4）: in-flight guard + 多タブ Web Locks 付きで cards/exams/tombstone delta を増分 pull。**U2（新 OCR cards = card delta）/ U4（exam 削除 = tombstone delta）の両方にそのまま適合**。= 唯一の相乗り helper。
- **`pullBack(reason)`**（`lib/sync/pull-back.ts`、step5）: `runGuardedPull` + `pullAllStudyDays`。OCR/削除に study_days は無関係 → **`pullBack` は overkill、`runGuardedPull` 単体が正しい・軽い**。
- **pull-trigger**（`pull-trigger.tsx`、mount/visibility/online、step4）: ambient な mirror 鮮度（reload/タブ切替/再接続）は既にカバー済。相乗りを足さなくても次トリガで反映される（即時性のみが論点）。
- **新規必要物**: なし。検知（polling/`hasCompletion`）も pull helper（`runGuardedPull`）も既存。新 endpoint/新 helper/新 polling は不要。

---

## 結論（U2 / U4 の相乗り先と新規 vs 流用の切り分け）

| 項目 | 既存相乗り先（最小） | 流用資産 | 新規必要物 |
|---|---|---|---|
| **U2 OCR 完了 → card_count** | `exam-status-live.tsx:80` の `hasCompletion` true 分岐（既存 5s polling の完了検知） | `runGuardedPull`（step4） | なし（検知も pull も既存） |
| **U4 exam 削除 → 一覧反映** | `delete-exam-button.tsx:39` の削除成功分岐（既存 `router.refresh()` 点） | `runGuardedPull`（step4） | なし |
| （波及）詳細 page card 追加/削除 → list 件数 | `delete-card-button.tsx:33` / `inline-card-list.tsx:45`（任意、スコープ外） | `runGuardedPull` | なし |

- **新規ロジックは一切不要**。U2 は既存 OCR polling の完了遷移点、U4 は既存削除成功ハンドラに、`runGuardedPull` を fire-and-forget で 1 行相乗りさせる形で完結する。
- `pullBack`（study_days 同梱）は不要、`runGuardedPull` 単体で足りる。
- 残る設計判断（plan/OT）: (a) U2 を polling 遷移のみに足すか詳細 page card mutation handler にも足すか、(b) `router.refresh()` を残置するか置換するか、(c) 即時性 vs ambient トリガ依存の線引き。本調査は相乗り先と資産の所在の確定まで（実装・設計確定はしない）。
