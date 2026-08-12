// 起動時 self-heal sweep (画像フェーズ A Task 9 / spec §3.4・§6)。
//
// ① stale 'uploading' (1h 超): tab close 等で中断した upload の後始末。
//    card から参照されていれば `abandonUpload` (mirror 除去 + cache/media_assets
//    削除 + flush) で片付ける。 参照が無ければ直接 cache/media_assets を削除する。
// ② 'downloading' 残骸 job: 中断したデッキ一括 DL。 added_asset_ids の cache blob を
//    削除して job row を削除する (既存キャッシュ不巻込・再開なし、 spec §6)。 liveness は
//    per-exam download lock で判定する — try-acquire できれば LIVE でない (中断/crash)、
//    busy なら別タブで進行中ゆえ触らない (時間 gate だと 1h 超の正当な DL を巻き込む・Codex 指摘)。
//    Web Locks 非対応環境では lock が liveness を arbitrate できない (withWebLock は fallback で
//    run を即実行 = 全 job を中断扱いにしてしまう) ため cleanup 自体を skip する (誤削除より
//    残骸放置を選ぶ・fail-safe。 対象環境 iOS 16.4+ は Web Locks 対応ゆえ実害なし・Codex 指摘)。
//
// Web Lock `'recallmint:media:sweep'` で多重タブ排他 (他 tab が sweep 中なら skip)。
// 各 item の失敗は best-effort — 1 件の失敗が残りを止めない (try/catch で握って続行)。

import { getClientDb } from '@/lib/client-db'
import { withWebLock } from '@/lib/sync/with-web-lock'
import { getPendingEntityMutations } from '@/lib/sync/entity-mutations'
import { deleteAssetBlob } from '@/lib/media/cache'
import { abandonUpload } from '@/lib/media/upload'

// stale 'uploading' の閾値。 spec §3.4「起動時 sweep: stale 'uploading'(1 時間超)」。
const STALE_UPLOADING_MS = 60 * 60 * 1000

// stale asset を参照している pending images mutation の cardId を outbox から探す。
// mirror が pull で server 版に reset されても、 outbox には該当 asset を含む images
// mutation が残りうる (pull は entity_mutations を触らない)。 この cardId で abandonUpload
// を呼べば、 mirror 除去に加えて pending mutation を coalesce で server 版へ矯正でき、
// media_assets 削除で gate を外しても非 ready asset を含む mutation が flush されない
// (Codex 指摘: mirror 参照なし判定だけで削除すると stuck mutation が残る)。
async function findCardIdReferencingAsset(
  userId: string,
  assetId: string,
): Promise<string | undefined> {
  const pending = await getPendingEntityMutations(userId)
  for (const m of pending) {
    if (m.entity_type !== 'card' || m.op !== 'update_field') continue
    if (typeof m.patch !== 'object' || m.patch === null) continue
    const patch = m.patch as { field?: unknown; value?: unknown }
    if (patch.field !== 'images' || !Array.isArray(patch.value)) continue
    const hasKey = patch.value.some(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { key?: unknown }).key === assetId,
    )
    if (hasKey) {
      // cardId を得たら、 owner (user) が一致する card か確認 (cross-user 防御)。
      const card = await getClientDb().cards.get(m.entity_id)
      if (!card || card.user_id === userId) return m.entity_id
    }
  }
  return undefined
}

async function sweepStaleUploading(userId: string, now: number): Promise<void> {
  const db = getClientDb()
  const staleAssets = (
    await db.media_assets.where('status').equals('uploading').toArray()
  ).filter(
    // 現 user の row のみ処理する (共有ブラウザで前 user の row が残っていても
    // 触らない。 触ると別 user の card に対する images mutation を現 session の
    // outbox へ積んでしまう — Codex 指摘)。
    (a) => a.user_id === userId && now - Date.parse(a.created_at) > STALE_UPLOADING_MS,
  )

  if (staleAssets.length === 0) return

  // card 参照解決は全 cards を読んで images 内 key を線形探索する (spec 記載どおり。
  // sweep は起動時 1 回・低頻度のため per-item クエリ最適化は不要)。
  const cards = await db.cards.toArray()

  for (const asset of staleAssets) {
    try {
      const cardFromMirror = cards.find((c) =>
        (c.images ?? []).some((i) => i.key === asset.id),
      )
      // mirror が pull で reset されていても、 outbox の pending images mutation が
      // asset を参照していれば cardId を得る (fallback)。
      const cardId =
        cardFromMirror?.id ?? (await findCardIdReferencingAsset(userId, asset.id))
      if (cardId) {
        // mirror or outbox が参照: abandonUpload が mirror 除去 + pending mutation の
        // coalesce 矯正 + cache/media_assets 削除 + flush を行う。
        const currentImages =
          cardFromMirror?.images ??
          (await db.cards.get(cardId))?.images ??
          []
        await abandonUpload({
          // owner は認証主体を使う (mirror 行の user_id 由来にしない — abandonUpload は
          // 内部で flush を叩くため、 行由来だと別 user の backlog を現 session で
          // drain しうる)。 直上の filter で asset.user_id === userId は確定している。
          userId,
          cardId,
          assetId: asset.id,
          currentImages,
        })
      } else {
        // mirror にも outbox にも参照なし = 真の orphan: 直接削除。
        await deleteAssetBlob(userId, asset.id)
        await db.media_assets.delete(asset.id)
      }
    } catch {
      // best-effort: 1 件の失敗は残りの sweep を止めない。
    }
  }
}

async function sweepStaleDownloadJobs(userId: string): Promise<void> {
  // Web Locks 非対応環境では per-exam download lock で liveness を判定できない
  // (withWebLock が fallback で run を即実行 → 進行中 DL の added blob を誤削除しかねない)。
  // arbitrate 不能なら cleanup を丸ごと skip する (fail-safe: 誤削除より残骸放置)。
  if (typeof navigator === 'undefined' || !navigator.locks) return

  const db = getClientDb()
  const jobs = (
    await db.media_download_jobs.where('status').equals('downloading').toArray()
  ).filter((j) => j.user_id === userId) // 現 user の job のみ (前 user の row を触らない)

  for (const job of jobs) {
    // liveness 判定は per-exam download lock で行う (時間 gate だと大デッキ/低速回線で 1h
    // 超の正当な DL を巻き込む — Codex 指摘)。 try-acquire できる = その exam の DL は
    // LIVE でない (中断/crash でタブが lock を解放済み) → 残骸として掃除。 acquire 不可
    // (busy) = 別タブで進行中の LIVE DL ゆえ触らない (掃除すると added blob を消して
    // all-or-nothing を壊す)。 sweep の外側 lock とは別名ゆえ nested 保持で deadlock しない。
    await withWebLock({
      lockName: `recallmint:media:download:${job.exam_id}`,
      onLockBusy: () => {}, // live DL → skip
      run: async () => {
        try {
          for (const assetId of job.added_asset_ids) {
            await deleteAssetBlob(job.user_id, assetId)
          }
          await db.media_download_jobs.delete([job.user_id, job.exam_id])
        } catch {
          // best-effort: 1 件の失敗は残りの sweep を止めない。
        }
      },
    })
  }
}

/**
 * 起動時 self-heal sweep。 Web Lock で多重タブ排他 (busy なら skip)。
 * `userId` (= 現 session の users.id) で scope する — 共有ブラウザで前 user の
 * Dexie row が残っていても、 現 user の row のみを処理して cross-user 汚染を防ぐ
 * (logout での DB wipe は無いため owner filter で守る)。
 */
export async function sweepStaleMedia(userId: string): Promise<void> {
  await withWebLock({
    lockName: 'recallmint:media:sweep',
    onLockBusy: () => {},
    run: async () => {
      const now = Date.now()
      await sweepStaleUploading(userId, now)
      await sweepStaleDownloadJobs(userId)
    },
  })
}
