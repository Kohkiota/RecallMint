// useOwnerExams — 「owner scope の試験一覧を、判定に使える状態で読む」hook。
//
// なぜ hook にしたか(T7 deferred の解消): 同じ cold-mirror gate が
// `study-session-host.tsx`(smart)と `quick-session-host.tsx`(quick)に verbatim
// で 2 コピー存在し、Home が 3 番目の消費者になる。rule of three に達したのでここへ
// 抽出する(3 コピー目を作らない)。判定規則そのものは 2 経路の元コメントどおりで、
// 本抽出で挙動は変えていない。
//
// gate の中身: `useLiveQuery() === undefined` は「Dexie query がまだ完了していない」
// ことしか意味せず、「まだ同期していない」ことは示さない。空の mirror をそのまま
// resolver に渡すと、有効な `?exam=X` を「実在しない試験」として捨てて URL からも
// 剥がしてしまう(fresh browser の deep link が自壊する)。そこで
//   ① query 未完了(undefined)
//   ② 空配列だが「まだ同期していないから空」かもしれない
// の 2 条件を通過するまで **undefined = まだ判定できない** を返す。②の解消は
// 「初回 pull の settle」+「settle 後に実際に 0 件かを読み直す」の 2 段で行う
// (settle の state 更新と liveQuery の配信は別経路なので、settle だけでは
// pull 前に読まれた空 snapshot を握ったままになる)。
//
// 読み直しが失敗したとき(DatabaseClosedError 等)は確定扱いにする: このまま待っても
// 再試行の契機は無く、reload するまで画面が動かなくなる(抽出前には存在しなかった
// 状態を作らない)。spec §6「pull 失敗で settle した場合は mirror 現状で判定」と
// 同じ扱い。**受容している代償(消さないこと)**: 「exams に書込が入ったが liveQuery が
// まだ再配信しておらず、かつこの直読み `count()` だけが失敗した」複合条件では stale な
// `[]` を確定扱いにするため、有効な `?exam=X` を落としうる。ここに URL 保護条件を
// 足すと「無限 skeleton を作らない」性質と衝突するため、トレードとして受容する。

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getClientDb, type ClientExam } from '@/lib/client-db'
import { useFirstPullSettled } from './pull-settle-context'

export interface OwnerExamsState {
  /** 判定材料が揃うまで undefined。確定後は owner scope の試験行(Dexie 順)。 */
  readonly exams: ClientExam[] | undefined
  /** `exams` の id 配列。`exams` と同時に確定し、参照は render をまたいで安定。 */
  readonly examIds: string[] | undefined
}

export function useOwnerExams(userId: string): OwnerExamsState {
  const firstPullSettled = useFirstPullSettled()
  const rows = useLiveQuery(
    async () => getClientDb().exams.where('user_id').equals(userId).toArray(),
    [userId],
  )

  const [emptyMirrorConfirmed, setEmptyMirrorConfirmed] = useState(false)
  useEffect(() => {
    if (!firstPullSettled) return
    if (rows === undefined || rows.length > 0) return
    let cancelled = false
    void getClientDb()
      .exams.where('user_id')
      .equals(userId)
      .count()
      .then((count) => {
        if (!cancelled && count === 0) setEmptyMirrorConfirmed(true)
      })
      .catch(() => {
        if (!cancelled) setEmptyMirrorConfirmed(true)
      })
    return () => {
      cancelled = true
    }
  }, [firstPullSettled, rows, userId])

  const decided =
    rows !== undefined && (rows.length > 0 || emptyMirrorConfirmed) ? rows : undefined

  // 参照を固定する: 呼出側は examIds を `useSelectedExam` の入力に渡し、あちらは
  // useMemo の依存としてこの配列の同一性を見る。毎 render 新しい配列を作ると
  // resolution が毎 render 別物になり、その適用 effect が回り続ける。
  const examIds = useMemo(() => decided?.map((row) => row.id), [decided])

  return { exams: decided, examIds }
}
