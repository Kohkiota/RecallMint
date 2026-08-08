'use server'

import { and, eq, inArray, sql } from 'drizzle-orm'
import { type TenantTx } from '@/lib/db/tenant-tx'
import {
  assets,
  cardAssetRefs,
  exams,
  sourceDocuments,
  uploadOperations,
  uploadRecords,
  type CardImage,
} from '@/lib/db/schema'
import { isAssetKey } from '@/lib/validation/card'
import { saveExtractedCards } from './upload-persistence'
import { projectCardAssetRefs } from '@/lib/cards/domain/card-asset-refs'
import { type PreparedCard } from '@/lib/ocr/prepared-schema'
import { buildCardRows } from '../_lib/publish-prepared-plan'

// ②-4a-cutover smoke fix(2026-08-02): **'use server' file から型を re-export しない**。
// Next 16 + Turbopack の 'use server' 変換が named type re-export を value export と
// 誤認し `registerServerReference(型名, …)` を生成 → built chunk で裸参照(runtime
// undefined)→ module load 時 ReferenceError → 500。
// 再導入防止 = eslint no-restricted-syntax(_actions の 'use server' 型 export を ban)。

// ②-4a Phase E Task 12: publishPreparedUploadTx。 spec:
// docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md §8(publish・
// ロック順・保護 UPDATE)/ §2(fencing = 最終防衛)/ §5.4(publisher は保存済み
// payload を parse するだけで再正規化しない)。
//
// ★ 本 file の最重要不変条件 = **最終防衛 fencing**。 crop は idempotent かつ tx の
// 外(R2 I/O を DB tx に持ち込まない・spec §7.3)。 この publish tx 冒頭の
// `SELECT … FOR UPDATE` + `status='prepared' AND lease_version=:mine` 不一致拒否が、
// カード二重作成を防ぐ唯一の権威 gate。
//
// flow(呼出元 = `_lib/upload-pipeline.ts`):
//   [pipeline] payload commit → 全 figure crop(tx 外・R2 I/O)→ publish 条件判定
//     (planPublish・純粋)→ publishPreparedUploadTx(短い DB tx)
//   [tx] fence → exam → source_document → 保護 asset UPDATE → cards/tags(saveExtractedCards)
//     → refs → counter(bump)→ finalize(payload NULL + result_summary + completed)

// ---------------------------------------------------------------------------
// publishPreparedUploadTx — cards/tags/refs/counter/status を確定する短い DB tx。
// spec §8.1 のロック順を厳守: operation → exam → source_document → assets(ID順)
// → cards → tags → refs → counters/status/operation。
//
// 返り値は 'published' / 'stale'(fencing 不一致)のみ。 保護 UPDATE 期待未満 /
// 重複 card id(ON CONFLICT なし)/ その他 DB error は **throw** して tx 全体を
// rollback する(部分 commit させない・重複は silent に握らず loud fail・spec
// Global Constraint「cards に ON CONFLICT 不使用」)。 呼出元(upload-pipeline.ts)が
// throw を catch して operation を terminal 化する。
//
// iso test が Clerk 無しで直接 exercise できるよう Tx-suffix で export する。
// ---------------------------------------------------------------------------
export async function publishPreparedUploadTx(
  tx: TenantTx,
  args: {
    userId: string
    operationId: string
    leaseVersion: number
    cards: readonly PreparedCard[]
    cardImagesByCardId: Record<string, CardImage[]>
    resultSummary: Record<string, unknown>
    // upload_records.file_size_bytes に記帳する受領バイト総量(step 7)。
    // ②-4a Task S-3 で引数化した: 呼出元(upload-pipeline.ts)が受領 Buffer の合計を
    // 渡す。「どこから来た値か」は呼出経路の知識であり、この tx の責務ではない。
    fileSizeBytes: number
  },
): Promise<{ outcome: 'published' } | { outcome: 'stale' }> {
  const {
    userId,
    operationId,
    leaseVersion,
    cards,
    cardImagesByCardId,
    resultSummary,
    fileSizeBytes,
  } = args

  // 1. FINAL-DEFENSE FENCING(本 task の top invariant・spec §2/§8.1)。 operation を
  //    SELECT … FOR UPDATE(ロック順の起点)し、 status='prepared' AND
  //    lease_version=:mine を要求する。 不一致(takeover された stale worker 含む)は
  //    何も書かず 'stale' を返す — これがカード二重作成を防ぐ唯一の権威 gate。
  const opRows = await tx
    .select({
      status: uploadOperations.status,
      leaseVersion: uploadOperations.leaseVersion,
      examId: uploadOperations.examId,
      sourceDocumentId: uploadOperations.sourceDocumentId,
      // fix round 3: source_documents/upload_records の pages_processed(= 受領
      // 枚数)は expected_source_count を独立 oracle として使う(spec §8.2/§2.1)。
      // 画像のみの upload は sync tx(作成時 INSERT)が確定させた immutable 値。
      // PDF を含む upload は count phase の fenced CAS(spec D6)が確定させた値 —
      // publish 時点(この SELECT)では既に確定済みで以降書き換わらない。
      expectedSourceCount: uploadOperations.expectedSourceCount,
    })
    .from(uploadOperations)
    .where(and(eq(uploadOperations.id, operationId), eq(uploadOperations.userId, userId)))
    .for('update')

  const op = opRows[0]
  if (!op || op.status !== 'prepared' || op.leaseVersion !== leaseVersion) {
    return { outcome: 'stale' }
  }
  const { examId, sourceDocumentId, expectedSourceCount } = op

  // 2. exam を FOR UPDATE(ロック順 #2)。 存在・所有権をここで検証する — これが
  //    後段 bumpExamCardCount の「affected row 検証」相当を、 書込前・ロック取得と
  //    同時に、 より強く担保する(exam 不在/非所有なら以降を一切書かず throw)。
  const examRows = await tx
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
    .for('update')
  if (examRows.length === 0) {
    throw new Error('publishPreparedUploadTx: exam not found or not owned')
  }

  // 3. source_document を finalize(ロック順 #3)。 prepared operation は
  //    source_document_id を確定済み(T4)。 Fix #1 defense-in-depth(Codex P1):
  //    null は呼出元が terminal_failed で弾く(source_document 削除 =
  //    FK onDelete:set null)。 それでも null が tx へ到達したら **skip-and-publish
  //    せず throw(rollback)** — detached content を絶対に作らない。
  //
  //    fix round 3(spec §8.2「completeUploadTx 相当」②): この UPDATE が source_document
  //    の行ロックを取得(ロック順 #3 を満たす)しつつ status='completed' へ確定する
  //    (spec §9 の open item「後から publisher が completed へ戻す」の実体・exam status
  //    API / source-doc-status.ts が読む)。 legacy completeUploadTx は再利用しない
  //    (id+userId のみ・開始 status 非検証)。 filename は upload_records 記帳(step 8)で
  //    使うため同 UPDATE の RETURNING で取得する。
  if (sourceDocumentId === null) {
    throw new Error('publishPreparedUploadTx: source_document_id is null (deleted?)')
  }
  const sdRows = await tx
    .update(sourceDocuments)
    .set({
      status: 'completed',
      pagesProcessed: expectedSourceCount,
      cardsExtracted: cards.length,
      completedAt: sql`now()`,
    })
    .where(and(eq(sourceDocuments.id, sourceDocumentId), eq(sourceDocuments.userId, userId)))
    .returning({ id: sourceDocuments.id, filename: sourceDocuments.filename })
  if (sdRows.length === 0) {
    throw new Error('publishPreparedUploadTx: source_document not found or not owned')
  }
  const sourceFilename = sdRows[0].filename

  // 4. 保護 asset UPDATE(spec §8.1・ロック順 #4「assets(ID 順)」)。 refs を張る
  //    対象 asset が今も 'ready' か確認してから refs を張る — FK は行存在のみ検証し
  //    status を制約しない(schema.ts card_asset_refs)ため、 prepared〜publish の
  //    間に GC/GDPR で deleting 化した asset を参照してしまう race を閉じる。
  //    まず ready 行を **ID 順に FOR UPDATE ロック**(単一 UPDATE は行ロック順を
  //    保証できず GC 等と逆順ロックでデッドロックしうるため)し、 期待件数を検証
  //    してから unreferenced_at をクリアする。
  const expectedReadyAssetIds = Array.from(
    new Set(
      Object.values(cardImagesByCardId)
        .flat()
        .map((img) => img.key)
        .filter((key) => isAssetKey(key)),
    ),
  ).sort()

  if (expectedReadyAssetIds.length > 0) {
    const readyRows = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.userId, userId),
          inArray(assets.id, expectedReadyAssetIds),
          eq(assets.status, 'ready'),
        ),
      )
      .orderBy(assets.id)
      .for('update')

    if (readyRows.length < expectedReadyAssetIds.length) {
      // 期待未満 = crop 済み asset の一部が prepared〜publish 間に GC/GDPR で
      // ready を外れた。 非 ready asset への ref を作らない(spec §8.1)— tx 全体を
      // rollback する(新経路に retry は無く、呼出元が operation ごと terminal 化する)。
      throw new PublishProtectiveMismatchError(readyRows.length, expectedReadyAssetIds.length)
    }
    await tx
      .update(assets)
      .set({ unreferencedAt: null })
      .where(
        and(
          eq(assets.userId, userId),
          inArray(
            assets.id,
            readyRows.map((r) => r.id),
          ),
        ),
      )
  }

  // 5. cards(ロック順 #5)+ tags(#6)を saveExtractedCards で確定する。 cards は
  //    ON CONFLICT を使わない(重複 card id は設計破綻 = loud fail・spec Global
  //    Constraint)。 custom_props は card ID で対応付ける(§改修)。 applyOcrTags は
  //    §T13 の determinism 版。 exam は手順2で FOR UPDATE 済ゆえ、 saveExtractedCards
  //    内の bumpExamCardCount(exam UPDATE)は既取得ロックへの書込で、 ロック取得
  //    順(exam #2 を assets #4 より前に取得済)を崩さない。
  const cardRows = buildCardRows(cards, cardImagesByCardId, {
    userId,
    examId,
    sourceDocumentId,
  })
  const customPropsById: Record<string, PreparedCard['customProps']> = {}
  for (const card of cards) customPropsById[card.cardId] = card.customProps

  await saveExtractedCards(tx, { userId, examId, cardRows, customPropsById })

  // 6. refs(ロック順 #7)。 各 card の採用 image を card_asset_refs へ射影する
  //    (T11 の pure projection を共有)。 保護 UPDATE を通過した ready asset のみ
  //    (= 採用 image の key)を対象にする。
  const refRows = cards.flatMap((card) =>
    projectCardAssetRefs(card.cardId, userId, cardImagesByCardId[card.cardId] ?? []),
  )
  if (refRows.length > 0) {
    await tx.insert(cardAssetRefs).values(refRows)
  }

  // 7. upload_records 記帳(spec §8.2「completeUploadTx 相当」③・legacy と同じ
  //    「一蓮托生」= 同一 publish tx。 protective mismatch / 重複 card 等で publish が
  //    rollback すれば source_documents/cards/operation と共にこの行も消える)。
  //    append-only 台帳・月次 quota SUM の対象(getCurrentMonthOcrPages が
  //    status='completed' の pages_processed を SUM)ゆえ pages_processed は 0 でなく
  //    実 source 画像数(= expectedSourceCount)を書く。 file_size_bytes は呼出側が
  //    渡す(Task S-3 で引数化・上記 args のコメント参照)。 ocr_cost_yen は新 flow が publish 時に cost を持たないため NULL(quota SUM は
  //    pages_processed で成立し cost に非依存・spec §8.2)。 enforcement は ②-5(記帳 ≠ 強制)。
  await tx.insert(uploadRecords).values({
    userId,
    filename: sourceFilename,
    fileSizeBytes,
    pagesProcessed: expectedSourceCount,
    ocrCostYen: null,
    status: 'completed',
  })

  // 8. finalize(ロック順 #8「counters/status/operation」)。 payload を NULL 化 +
  //    result_summary 保存 + status='completed'。 WHERE に開始 status(prepared)+
  //    lease_version guard を付け「開始 status 検証込みの新規 finalize」とする
  //    (legacy completeUploadTx を流用しない・plan)。 手順1で FOR UPDATE 済ゆえ
  //    0 行は起きない想定 — 起きたら内部不整合として throw(rollback)。
  const finalized = await tx
    .update(uploadOperations)
    .set({
      preparedPayload: null,
      resultSummary,
      status: 'completed',
      completedAt: sql`now()`,
    })
    .where(
      and(
        eq(uploadOperations.id, operationId),
        eq(uploadOperations.userId, userId),
        eq(uploadOperations.status, 'prepared'),
        eq(uploadOperations.leaseVersion, leaseVersion),
      ),
    )
    .returning({ id: uploadOperations.id })
  if (finalized.length === 0) {
    throw new Error('publishPreparedUploadTx: finalize guard failed (operation state changed)')
  }

  return { outcome: 'published' }
}

// 保護 UPDATE の期待件数未満(GC/GDPR race で ready asset が消えた)を表す sentinel。
// 呼出元(upload-pipeline.ts)は throw を error 種別で区別せず一律 terminal 化する
// ため export しない('use server' file は非 async の value export を許さない・SWC 71011)。
class PublishProtectiveMismatchError extends Error {
  constructor(
    readonly ready: number,
    readonly expected: number,
  ) {
    super(`publish protective UPDATE returned ${ready} < expected ${expected} ready assets`)
    this.name = 'PublishProtectiveMismatchError'
  }
}
