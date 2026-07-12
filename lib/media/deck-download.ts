// デッキ一括 DL: downloadDeckImages (画像フェーズ A Task 12 / spec §6)。
//
// mirror の exam 配下 cards から UUID key 集合を集め、 Cache miss 分のみを resolve →
// fetch → Cache put で先行キャッシュする。 job row (media_download_jobs) で進捗を持ち、
// **全件成功 → 'done' / 1 件でも失敗 → 当該 job の added_asset_ids のみ Cache 削除 +
// job row 削除 (既存キャッシュ不巻込・再開なし、 all-or-nothing)**。
//
// crash-consistency の要:
//   各 asset を fetch+put する前に assetId を job の added_asset_ids へ記録する。
//   これにより added_asset_ids は常に「実 Cache に入った asset の superset」となり、
//   タブ crash で job が 'downloading' のまま残っても起動時 sweep が added 分を確実に
//   全掃除できる (put 済だが未記録 = sweep が漏らす、 という状態を作らない)。
//
// server action (resolveAssetUrls) は ESLint Block A が lib→app import を禁ずるため
// get-asset.ts / upload.ts と同じ DI 前例で構造型注入する (呼出側 client component が
// 実 action をそのまま渡す)。

import type { ActionResult } from '@/lib/actions/result'
import { getClientDb } from '@/lib/client-db'
import { isAssetKey } from '@/lib/validation/card'
import { withWebLock } from '@/lib/sync/with-web-lock'
import { putAssetBlob, matchAssetBlob, deleteAssetBlob } from '@/lib/media/cache'

export type ResolveAssetUrlsFn = (
  assetIds: string[],
) => Promise<
  ActionResult<
    Array<{ assetId: string; url: string; mime: string; width: number; height: number }>
  >
>

export type DownloadDeckResult = {
  ok: boolean
  total: number
  downloaded: number
  // 別タブが同 exam を DL 中 (lock busy) を「失敗」と区別する discriminator。 UI が
  // 「失敗・再試行を」という誤メッセージを出さないため (busy は失敗ではない・canonical 指摘)。
  reason?: 'busy'
}

// resolve の 1 回あたり件数上限 (server action / spec §6 の MAX_RESOLVE_IDS と揃える)。
const RESOLVE_BATCH_SIZE = 50

// 画像 GET の timeout。 表示用 GET と同じく 60s で hang を防ぐ (upload の PUT より小さい
// image bytes ゆえ余裕を持たせつつ無限待ちを避ける)。
const FETCH_TIMEOUT_MS = 60_000

/**
 * exam 配下 cards の添付画像を一括で先行キャッシュする (all-or-nothing)。
 *
 * per-exam Web Lock で多重起動を排他し (busy = 別タブが同 exam を DL 中 → no-op で
 * `{ok:false, total:0, downloaded:0}`)、 miss 分のみを batch resolve → fetch → Cache
 * put する。 1 件でも失敗したら当該 job で追加した blob を全て消し job row を削除する
 * (既存キャッシュは巻き込まない)。
 *
 * 返り値の意味:
 *   - total      = デッキ全体の UUID 画像枚数 (既にキャッシュ済みも含む)。
 *   - downloaded = 本呼び出しで新規にキャッシュした枚数 (miss 分)。
 * (job row / onProgress の total は「実 DL 対象 = miss 分」= 進捗バーの分母で、 別軸)。
 */
export async function downloadDeckImages(
  userId: string,
  examId: string,
  deps: { resolveAssetUrls: ResolveAssetUrlsFn },
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<DownloadDeckResult> {
  return withWebLock<DownloadDeckResult>({
    lockName: `recallmint:media:download:${examId}`,
    // 別タブが同 exam を DL 中: 二重 DL を避け no-op で返す (再入は既存 job が担う)。
    // reason:'busy' で「失敗」と区別する (UI が retry を促す誤メッセージを出さない)。
    onLockBusy: () => ({ ok: false, total: 0, downloaded: 0, reason: 'busy' as const }),
    run: () => runDownload(userId, examId, deps, opts),
  })
}

async function runDownload(
  userId: string,
  examId: string,
  deps: { resolveAssetUrls: ResolveAssetUrlsFn },
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<DownloadDeckResult> {
  const db = getClientDb()

  // ① persist() を best-effort で要求 (拒否/例外でも DL は続行、 結果は無視)。
  //    永続ストレージ化で eviction 耐性を上げるだけの補助操作 (ブロックしない)。
  try {
    await navigator.storage?.persist?.()
  } catch {
    // best-effort: 未許可/非対応でも DL を止めない。
  }

  // rollback 対象 state は try の外で宣言し、 pre-flight 読取 (cards/cache) 〜 job 作成 〜
  // DL 本体 〜 最終 'done' 化までを 1 つの try で包む。 Dexie / Cache API が pre-flight で
  // throw しても catch→rollback で {ok:false} に正規化し never-throw 契約を守る (job 未作成
  // なら added 空・deckTotal 0 で rollback は無害、 呼出側に throw を漏らさない・canonical 指摘)。
  const added: string[] = [] // 当該 job で Cache に追加した assetId (rollback 対象)。
  let doneCount = 0
  let deckTotal = 0 // デッキ全体の UUID 画像枚数 (pre-flight 前に throw したら 0)。

  // 失敗時: added 分の blob を全削除 + job row 削除 (既存 pre-cached は added に無い
  // ため巻き込まない)。 rollback 自体の失敗は best-effort で握る (呼出側へは {ok:false})。
  async function rollback(): Promise<DownloadDeckResult> {
    for (const id of added) {
      try {
        await deleteAssetBlob(userId, id)
      } catch {
        // best-effort: 1 件の削除失敗が他の rollback を止めない。
      }
    }
    try {
      await db.media_download_jobs.delete([userId, examId])
    } catch {
      // best-effort。
    }
    return { ok: false, total: deckTotal, downloaded: doneCount }
  }

  try {
    // ② exam 配下 cards から UUID key 集合を dedupe して集める (非配列 images は skip)。
    const cards = await db.cards
      .where('[user_id+exam_id]')
      .equals([userId, examId])
      .toArray()

    const allKeys = new Set<string>()
    for (const card of cards) {
      if (!Array.isArray(card.images)) continue
      for (const image of card.images) {
        if (isAssetKey(image.key)) allKeys.add(image.key)
      }
    }
    const allKeyList = [...allKeys]

    // ③ Cache miss のみに絞る (差分 DL)。 既に Cache 済みの key は resolve/fetch しない。
    const misses: string[] = []
    for (const key of allKeyList) {
      const cached = await matchAssetBlob(userId, key)
      if (!cached) misses.push(key)
    }

    // return の total は「デッキ全体の画像枚数」(既存キャッシュ含む) を表す — UI が
    // 「N 枚中 M 枚を新規 DL」と読めるようにする。 一方 job row / onProgress の total は
    // 実 DL 対象 (misses) のみ = 進捗バーの分母 (既にある分は進捗に数えない)。
    deckTotal = allKeyList.length

    // miss ゼロ = 全て既にキャッシュ済み。 job row を作らず即返す。
    if (misses.length === 0) {
      return { ok: true, total: deckTotal, downloaded: 0 }
    }

    const missTotal = misses.length

    // ④ job row を 'downloading' で作成 (進捗の source of truth)。 total は miss 分のみ。
    await db.media_download_jobs.put({
      exam_id: examId,
      user_id: userId,
      status: 'downloading',
      total: missTotal,
      done_count: 0,
      added_asset_ids: [],
      started_at: new Date().toISOString(),
    })

    // ⑤ 50 件 batch で resolve → 各 asset を「記録 → fetch → put」。
    for (let i = 0; i < misses.length; i += RESOLVE_BATCH_SIZE) {
      const batch = misses.slice(i, i + RESOLVE_BATCH_SIZE)
      const resolved = await deps.resolveAssetUrls(batch)
      if (!resolved.ok || !resolved.data) {
        return await rollback()
      }

      // resolve が返した id → url の map。 batch 内の欠損 (省略された id) を検出する。
      const urlById = new Map(resolved.data.map((e) => [e.assetId, e.url]))

      for (const assetId of batch) {
        const url = urlById.get(assetId)
        // 欠損 = server が ready でない/権限外等で省いた → all-or-nothing で失敗扱い。
        if (url === undefined) {
          return await rollback()
        }

        // ★ 記録を put より前に行う (crash 時 added ⊇ cached を保証)。
        added.push(assetId)
        await db.media_download_jobs.update([userId, examId], {
          added_asset_ids: [...added],
        })

        const res = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (!res.ok) {
          return await rollback()
        }
        await putAssetBlob(userId, assetId, await res.blob())

        doneCount += 1
        await db.media_download_jobs.update([userId, examId], {
          done_count: doneCount,
        })
        opts?.onProgress?.(doneCount, missTotal)
      }
    }

    // ⑥ 全件成功: job を 'done' に確定 (done_count = miss 分)。 この最終 update が失敗して
    //    も all-or-nothing を保つため try 内に置き catch→rollback へ流す (job を 'downloading'
    //    のまま残すと後続 sweep が cache 済みデッキを消しかねない + 呼出側が throw を受ける
    //    ため。 rollback で job row を消し {ok:false} に正規化する・Codex 指摘)。
    await db.media_download_jobs.update([userId, examId], {
      status: 'done',
      done_count: missTotal,
    })

    return { ok: true, total: deckTotal, downloaded: missTotal }
  } catch {
    // pre-flight 読取 / resolve / fetch / timeout / put / update いずれの throw も
    // all-or-nothing rollback に集約 (never-throw 契約)。
    return await rollback()
  }
}
