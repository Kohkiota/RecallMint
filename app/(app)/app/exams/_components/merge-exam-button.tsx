// MergeExamButton — 試験一覧の行 action 「結合」 (Grid-3 spec §7.3 / UI 入口 d)。
//
// 「結合」= この行の試験の **全カード** を別の試験へ 1 回の MoveCards で合流させる操作。
// 元の試験は空のまま残す (tombstone 化も自動削除もしない — 削除は DeleteExamButton の役目)。
//
// 展開は DeleteExamButton の 4-phase inline パターンに倣う
// (idle → confirm → merging → error)。
//
// 役割分担:
//   - 本 component が持つのは **入力の組み立てと実行の起動** (合流先 / 配置 / 確認 /
//     結合元の card id 読み出し / 失敗の inline 表示)。
//   - 順序計算・mutation 組立は一切持たない (Task 5 の useMoveCards に委ねる)。
//   - 成功 toast + undo は **親** (ExamListLive) の責務: toast は一覧全体で単一 slot
//     なので行ごとに持たせない。本 component は成功時に undo 素材を onMerged で渡すだけ。
//
// 'use client' は付けない: 親 ExamListLive ('use client') からのみ import される子。
// file 自体に付けると Next.js TS plugin が function 型 prop (moveCards / onMerged) を
// Server Action prop として誤検出する (exam-card-move-popover と同じ理由)。

import { useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { MovePlacement } from '@/lib/cards/domain/card-order'
import { getClientDb } from '@/lib/client-db'

import type { MoveCardsFn, MoveResult } from '../_hooks/use-move-cards'

// tx 失敗 (reject)。 all-or-nothing なので「移動していない」と言い切れる。
const MERGE_FAILED_MESSAGE = '結合に失敗しました。しばらくしてから再度お試しください。'
// mutation 未発行 (合流先が mirror に無い / 他 user のもの)。選び直させる。
const MERGE_TARGET_MISSING_MESSAGE = '合流先の試験が見つかりません。選び直してください。'

type Phase = 'idle' | 'confirm' | 'merging' | 'error'
type PlacementKind = 'end' | 'start'

export type MergeExamButtonProps = {
  userId: string
  /** 結合元 (この行の試験)。合流先候補からは除外する。 */
  examId: string
  /** この行のカード枚数 (一覧の mirror 集計)。0 枚は移動対象が無いので disabled。 */
  cardCount: number
  /** 一覧が持つ exam 全件 (自身を含む)。除外は本 component が行う。 */
  exams: readonly { id: string; name: string }[]
  moveCards: MoveCardsFn
  /** 成功時に undo 素材を親へ渡す (toast は親が出す)。 */
  onMerged: (result: MoveResult & { ok: true }) => void
}

export function MergeExamButton({
  userId,
  examId,
  cardCount,
  exams,
  moveCards,
  onMerged,
}: MergeExamButtonProps) {
  const baseId = useId()
  const targetSelectId = `${baseId}-target`

  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [targetExamId, setTargetExamId] = useState('')
  const [placementKind, setPlacementKind] = useState<PlacementKind>('end')

  // 二重 submit の **同期** ガード。phase state は次の render まで反映されないため、
  // 同一 tick に click が 2 発届くと両方が moveCards に入り、2 回目は既に空になった
  // 結合元を再び読む (= no-op になるとは限らず、mirror 反映前なら同じ card を
  // 二重に移動する mutation を発行しうる)。ref は代入した瞬間に見えるので、
  // 最初の await より前に立てて再入を弾く (Task 4 / Task 6 と同 class)。
  const inFlightRef = useRef(false)

  // 合流先候補 = 一覧の exam から自身を除いたもの (自身への結合は無意味)。
  const targets = exams.filter((exam) => exam.id !== examId)
  // 選択済みの合流先が (削除等で) 候補から消えたら先頭に落とす。
  const effectiveTargetId = targets.some((exam) => exam.id === targetExamId)
    ? targetExamId
    : (targets[0]?.id ?? '')
  const targetName = targets.find((exam) => exam.id === effectiveTargetId)?.name ?? ''

  // 0 枚 = 移動対象が無い / 候補ゼロ = 合流先を選べない。どちらも展開する意味がない。
  const mergeDisabled = cardCount === 0 || targets.length === 0

  const onConfirmMerge = async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setPhase('merging')
    setErrorMsg(null)
    try {
      // 結合元の全 card id を mirror から読む。id しか要らないので primaryKeys で
      // row 本体を materialize しない (本体は hook 側が bulkGet で読む)。
      // owner scope は compound index `[user_id+exam_id]` の第 1 要素で構造保証する
      // (use-move-cards / exam-list-live と同じ経路)。
      // 並び順は問わない: 移動対象の相対順は hook 内の domain が base_order で決める。
      const cardIds = await getClientDb()
        .cards.where('[user_id+exam_id]')
        .equals([userId, examId])
        .primaryKeys()

      const placement: MovePlacement = { kind: placementKind }
      const result = await moveCards({
        cardIds,
        targetExamId: effectiveTargetId,
        placement,
      })
      if (result.ok) {
        onMerged(result)
        setPhase('idle')
        return
      }
      switch (result.reason) {
        // no-cards = mirror に対象が 1 枚も無い no-op (mutation 未発行)。
        // error でも toast でもないので黙って畳む (useMoveCards の契約)。
        case 'no-cards':
          setPhase('idle')
          return
        case 'target-exam-missing':
          setErrorMsg(MERGE_TARGET_MISSING_MESSAGE)
          setPhase('error')
          return
        // 未知の理由が増えたときに silent な no-op へ倒れないよう error 側で受ける。
        default:
          setErrorMsg(MERGE_FAILED_MESSAGE)
          setPhase('error')
      }
    } catch {
      // tx 失敗は reject で来る (throwOnError: true)。部分適用はない。
      setErrorMsg(MERGE_FAILED_MESSAGE)
      setPhase('error')
    } finally {
      inFlightRef.current = false
    }
  }

  if (phase === 'idle') {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={mergeDisabled}
        onClick={() => setPhase('confirm')}
      >
        結合
      </Button>
    )
  }

  if (phase === 'confirm') {
    return (
      <div className="space-y-2 text-left sm:w-64">
        <div className="flex flex-col gap-1">
          <label htmlFor={targetSelectId} className="text-xs font-medium">
            合流先の試験
          </label>
          <select
            id={targetSelectId}
            value={effectiveTargetId}
            onChange={(e) => setTargetExamId(e.target.value)}
            className="w-full rounded-md border border-border bg-background p-1.5 text-sm"
          >
            {targets.map((exam) => (
              <option key={exam.id} value={exam.id}>
                {exam.name}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-medium">配置</legend>
          <PlacementRadio
            name={`${baseId}-placement`}
            value="end"
            label="末尾"
            checked={placementKind === 'end'}
            onSelect={setPlacementKind}
          />
          <PlacementRadio
            name={`${baseId}-placement`}
            value="start"
            label="先頭"
            checked={placementKind === 'start'}
            onSelect={setPlacementKind}
          />
        </fieldset>

        <p className="text-xs text-slate-700">
          {cardCount}枚を「{targetName}」へ移動します。元の試験は空のまま残ります。
        </p>

        <div className="flex gap-2">
          <Button size="sm" onClick={() => void onConfirmMerge()}>
            結合する
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPhase('idle')}>
            キャンセル
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'merging') {
    return (
      <Button disabled size="sm">
        結合中…
      </Button>
    )
  }

  // phase === 'error'
  return (
    <div className="space-y-2 text-left sm:w-64">
      {errorMsg && (
        <p data-testid="merge-exam-error" className="text-xs text-red-600">
          {errorMsg}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setPhase('confirm')
            setErrorMsg(null)
          }}
        >
          再試行
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setPhase('idle')
            setErrorMsg(null)
          }}
        >
          キャンセル
        </Button>
      </div>
    </div>
  )
}

function PlacementRadio({
  name,
  value,
  label,
  checked,
  onSelect,
}: {
  name: string
  value: PlacementKind
  label: string
  checked: boolean
  onSelect: (kind: PlacementKind) => void
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
      />
      {label}
    </label>
  )
}
