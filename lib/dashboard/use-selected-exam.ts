// use-selected-exam — resolveSelectedExam の唯一の呼出側(Dash-1 Home v1 Task 5・
// spec §6: 「副作用は呼出側 1 箇所」)。 home(/app) / smart(/app/study/smart) /
// quick(/app/study/quick)の 3 入口が本 hook を共有し、 独自の URL 書換 /
// sync_meta 書込を持たない(乖離防止 — spec §6「共通 resolver」)。
//
// 'use client' directive は付けない(lib/dnd/use-sortable-sensors.ts と同 convention
// — 本 module は React hook を含むが component 境界そのものではないため、 これを
// import する 'use client' component 側が境界を持てば足りる)。
//
// 責務:
// - sync_meta の保存値を owner scope で読む(mount / userId 変化で読み直す)。
// - resolveSelectedExam(pure)で決定を得る。 examIds は呼出側が Dexie useLiveQuery で
//   供給する(本 hook は Dexie を直接読まない — cards 系ウィジェットの共有集計 root と
//   同じ 1 回走査に相乗りさせるため。 spec §3.1 の性能方針)。
// - urlNeedsUpdate / storeNeedsUpdate に従い router.replace / setJsonSyncMeta を適用する。
//   URL 書換は現在の window.location(他 query param 込み)から `exam` のみ差し替える
//   (billing-banner.tsx と同じ URL API の使い方 — 生成源を 1 箇所化)。
// - stale-resolution guard: epoch counter で「この適用がまだ最新の決定か」を
//   実行直前に再確認し、 遅着した古い決定が新しい決定を上書きしない。
// - sync_meta への書込は直列化する(fix round 1/5・Codex Important 是正): epoch
//   check を await の**前**に置くだけでは、 一度 issue した setJsonSyncMeta 呼出は
//   途中で取り消せないため、 決定 A の書込 issue 後に決定 B が生まれて先に完了し、
//   その後 A が完了して B の結果を上書きする(= 保存値が古い exam のまま残る)経路が
//   残る。 IndexedDB の transaction 完了順が request 順と一致するという暗黙の
//   保証には依存せず、 単純な Promise chain(writeQueueRef)で「次の決定の書込は
//   前の決定の書込(の完了)を待ってから issue する」ことを構造的に強制する
//   (= 後発の書込が先発を追い越して完了することが原理的に起きない)。
//
// 再解決の契機(spec §6): 明示的な「消えた」検知は持たない。 examIds は呼出側の
// useLiveQuery が Dexie 変化のたびに新しい配列を渡すため、 useMemo の依存として
// 拾うだけで自動的に再解決される — 選択中 exam が mirror から消えれば ①/② の
// 実在チェックが通らなくなり、 自然に ③/④ へ落ちる(専用の「消滅検知」機構は
// 別途持たない — YAGNI)。
//
// 戻り値は保存値の初回読込が終わるまで undefined。 premature な resolution
// (「保存値はまだ読んでいないが取り敢えず無いものとして解決した」結果)を一瞬でも
// 返すと、 呼出側に selection-required → resolved のような flicker を強いる。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  SYNC_META_KEYS,
  selectedExamSchema,
  getJsonSyncMeta,
  setJsonSyncMeta,
} from '@/lib/sync/sync-meta'
import { resolveSelectedExam, type SelectedExamResolution } from './selected-exam'

export interface UseSelectedExamOptions {
  readonly userId: string
  /**
   * RSC が searchParams から抽出した現在の `exam` query param(billing と同型の
   * 受け渡し — Next 15 Promise searchParams を client hook 側で直接読まないため)。
   */
  readonly urlExamId: string | undefined
  /** owner scope の現存 exam id 一覧。呼出側の共有 useLiveQuery から渡す。 */
  readonly examIds: readonly string[]
}

/** 現在のブラウザ URL の `exam` param(未指定/SSR は undefined)。 */
function currentExamParam(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return new URL(window.location.href).searchParams.get('exam') ?? undefined
}

/**
 * URL の `exam` param のみを書き換え、他の query param(billing 等)を保持する。
 *
 * export する理由(Home task): W1 dropdown の明示切替も **同じ URL 生成**を通す。
 * 「他 param を保つ」規約(spec §6)を呼出側が書き直すと、切替のときだけ billing 等が
 * 落ちる非対称が生まれる。副作用(router.replace)は呼出側が持つ。
 */
export function buildExamUrl(examId: string | undefined): string | undefined {
  if (typeof window === 'undefined') return undefined
  const url = new URL(window.location.href)
  if (examId) {
    url.searchParams.set('exam', examId)
  } else {
    url.searchParams.delete('exam')
  }
  return url.pathname + url.search + url.hash
}

export function useSelectedExam({
  userId,
  urlExamId,
  examIds,
}: UseSelectedExamOptions): SelectedExamResolution | undefined {
  const router = useRouter()
  const [storedExamId, setStoredExamId] = useState<string | undefined>(undefined)
  const [storedLoaded, setStoredLoaded] = useState(false)

  // userId 変化時に古い owner の storedExamId/storedLoaded を即座に捨てる。
  // React 公式の「prop 変化に合わせて state を調整する」パターン(render 中の
  // setState — effect の中で同期的に setState すると react-hooks/set-state-in-effect
  // が cascading render を警告するため、 effect でなく render body で行う)。
  const [loadedForUserId, setLoadedForUserId] = useState(userId)
  if (userId !== loadedForUserId) {
    setLoadedForUserId(userId)
    setStoredExamId(undefined)
    setStoredLoaded(false)
  }

  // 保存値の読込。 userId が変わったら(上の reset を経て)読み直す。
  useEffect(() => {
    let cancelled = false
    void getJsonSyncMeta(SYNC_META_KEYS.selectedExam, userId, selectedExamSchema).then(
      (saved) => {
        if (cancelled) return
        setStoredExamId(saved?.exam_id)
        setStoredLoaded(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [userId])

  const resolution = useMemo<SelectedExamResolution | undefined>(() => {
    if (!storedLoaded) return undefined
    return resolveSelectedExam({ urlExamId, storedExamId, examIds })
  }, [storedLoaded, urlExamId, storedExamId, examIds])

  // stale-resolution guard: 適用対象になった decision の世代を数える。
  // 効果本体が async(setJsonSyncMeta の await)を挟むため、 その間に resolution が
  // 更新されて epoch が進んだら、 古い世代の適用(router.replace / stale store 追随)を
  // 実行直前に止める(「決定 A の適用中に決定 B が生まれたら、 A の適用は B を
  // 上書きしない」— 単一 effect の cleanup 済み判定ではなく epoch で行うのは、
  // store 書込と URL 書込の 2 段の非同期処理をまたいで一貫して判定するため)。
  const epochRef = useRef(0)
  // sync_meta 書込の直列化キュー。 各書込みはこの Promise に .then() で連結され、
  // 「前の書込みの完了(await の内側まで含む)」を待ってから初めて次の
  // setJsonSyncMeta を issue する(上のコメント参照)。
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (!resolution) return
    let cancelled = false
    epochRef.current += 1
    const myEpoch = epochRef.current

    const run = async () => {
      if (resolution.outcome === 'resolved' && resolution.storeNeedsUpdate) {
        const myWrite: Promise<void> = writeQueueRef.current.then(async () => {
          // 直列化キューで自分の番が来た時点で、まだ最新の決定かを再確認する
          // (待ち行列中にさらに新しい決定が来ていたら、この書込は行わない)。
          if (epochRef.current !== myEpoch) return
          await setJsonSyncMeta(
            SYNC_META_KEYS.selectedExam,
            userId,
            { exam_id: resolution.examId },
            selectedExamSchema,
          )
            .then(() => {
              // 書込成功を local state に反映し、 無関係な再計算での無駄な再書込を防ぐ。
              if (epochRef.current === myEpoch) setStoredExamId(resolution.examId)
            })
            .catch(() => {})
        })
        writeQueueRef.current = myWrite
        await myWrite
      }

      if (cancelled) return // fix round 2/5 M3: unmount 後は他 page への router.replace を呼ばない
      if (epochRef.current !== myEpoch) return
      if (resolution.urlNeedsUpdate) {
        const nextExamId = resolution.outcome === 'resolved' ? resolution.examId : undefined
        // 実際の window.location と比較してから書く: urlNeedsUpdate は resolution
        // 算出時点の urlExamId prop(RSC 由来 — router.replace 後の再取得は非同期)を
        // 基準にしているため、 store 書込成功 → storedExamId 更新 → resolution 再算出
        // という 2 度目のサイクルでも prop がまだ古いままだと urlNeedsUpdate が
        // 再び true になりうる。 ブラウザの実 URL が既に目的値なら再書込しない
        // (無駄な router.replace の連打を防ぐ — 副作用の冪等性)。
        if (currentExamParam() !== nextExamId) {
          const nextUrl = buildExamUrl(nextExamId)
          if (nextUrl) router.replace(nextUrl)
        }
      }
    }
    void run()
    // fix round 2/5 M3: 直列化キューの await を挟んで router.replace が発火するため、
    // unmount 後に resume した run() が別 page へ ?exam=<id> を付与して RSC refetch を
    // 強制する経路が開いていた(書込直列化〈fix round 1/5〉が待ち時間を広げたぶん
    // 窓も広がった)。 cancelled を立てて run() 内の router.replace を止める。
    return () => {
      cancelled = true
    }
  }, [resolution, userId, router])

  return resolution
}

// 注記: W1 dropdown の「選択で確定」(spec §6 の明示切替)は本 hook に含めない。
// 明示切替は Home task の UI が resolution とは別に発火する操作であり、 本 task の
// 完了条件(4 段解決・URL 正規化・再解決・stale guard)には含まれない。 ただし
// URL 書換ロジックを再発明させないため、 Home task は buildExamUrl 相当の処理を
// 新設せず本 module の router.replace 経路に揃えること(exports は resolution の
// 自動適用のみ — 明示切替 API は意図的に持たない)。
