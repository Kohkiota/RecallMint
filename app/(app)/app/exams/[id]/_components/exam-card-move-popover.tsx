// ExamCardMovePopover — 一括バー「移動」 (a) と「新規試験へ切り出し」 (b) の popover。
// Grid-3 spec §7.1 / §6.1 / §7.4。
//
// 役割分担 (この component が持つのは **入力の組み立てだけ**):
//   - 移動先 exam / 配置 / anchor の選択 UI と、その正当性 (anchor は常駐列に居るか等)。
//   - 実際の移動発行 (useMoveCards)・切り出しの逐次 3 段・toast / inline error・
//     実行中 flag は **親** (ExamCardTable) の責務。 popover は `onMove` /
//     `onSplitOut` の返り outcome だけを見る。
//     理由 ①: 移動が成功すると対象 card が現 exam から消え → selection prune で
//     action bar ごと unmount するため、 toast (= undo 素材) を bar 配下に置けない。
//     理由 ② (fix round 1): popover を閉じると本 component は unmount されるので、
//     実行中 flag / 作成済み exam id を持たせると閉じ→開きで消え二重 submit できてしまう。
//
// mirror 読みは useLiveQuery (exam-list-live と同じ pattern)。 popover を閉じると
// PopoverContent が unmount される (Radix 既定・forceMount しない) ため、
// subscription と入力 (移動先 / 配置 / anchor) は開いている間だけ生きる = 明示 reset 不要。
//
// 'use client' は付けない: 親 ExamCardTableActionBar / ExamCardTable (= 'use client')
// からのみ import される子。 file 自体に付けると Next.js TS plugin が function 型 prop を
// Server Action prop として誤検出する (action-bar / TagCell / filter-bar と同 pattern)。

import * as React from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { compareByBaseOrder, type MovePlacement } from '@/lib/cards/domain/card-order'
import { getClientDb, type ClientCard } from '@/lib/client-db'

/**
 * 親が返す実行結果のうち popover が反応する分だけの要約。
 * - `moved` / `no-cards`: 完了 (popover を閉じる)。 no-cards は no-op で error でもない
 *   (mirror に対象が 1 枚も無い — useMoveCards の契約)。
 * - `target-exam-missing`: 移動先が mirror に無い。 stale な選択を破棄して開いたままにする。
 * - `failed`: tx 失敗 (親が inline error を出す)。 開いたまま = 再試行できる。
 */
export type MoveDispatchOutcome = 'moved' | 'no-cards' | 'target-exam-missing' | 'failed'

export type MoveDispatch = (
  targetExamId: string,
  placement: MovePlacement,
) => Promise<MoveDispatchOutcome>

/** spec §7.4 の gating 理由 (ソート/フィルタ適用中)。 */
export const POSITION_LOCKED_REASON =
  'ソート/フィルタ適用中は位置指定できません(解除するか、末尾/先頭を使ってください)'

// anchor select の表示は先頭部のみ (spec §7.1)。
const ANCHOR_LABEL_MAX = 30

type PlacementKind = 'end' | 'start' | 'after'

export type ExamCardMovePopoverProps = {
  userId: string
  /** 現在表示中の exam。 移動先の既定値 (= 同一 exam 内の位置移動)。 */
  currentExamId: string
  /** 移動対象 (= 選択行)。 anchor 候補から除外する (spec §2.3-2)。 */
  selectedIds: string[]
  /** ソート/フィルタ適用中 = 位置指定 gating (spec §7.4)。 末尾/先頭/切り出しは許可。 */
  positionLocked: boolean
  /** 親が持つ実行中 flag。 popover の開閉で消えない = 閉じ→開きでも二重 submit 不可。 */
  pending: boolean
  onMove: MoveDispatch
  /** 切り出し (b)。 exam 作成 → pull → 末尾移動は親が逐次実行する (spec §6.1)。 */
  onSplitOut: () => Promise<MoveDispatchOutcome>
  trigger: React.ReactNode
}

export function ExamCardMovePopover({ trigger, ...formProps }: ExamCardMovePopoverProps) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80">
        <MoveForm {...formProps} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

function MoveForm({
  userId,
  currentExamId,
  selectedIds,
  positionLocked,
  pending,
  onMove,
  onSplitOut,
  onDone,
}: Omit<ExamCardMovePopoverProps, 'trigger'> & { onDone: () => void }) {
  const baseId = React.useId()
  const targetId = `${baseId}-target`
  const anchorSelectId = `${baseId}-anchor`
  const reasonId = `${baseId}-reason`

  const [targetExamId, setTargetExamId] = React.useState(currentExamId)
  const [kind, setKind] = React.useState<PlacementKind>('end')
  const [anchorId, setAnchorId] = React.useState('')

  // 移動先候補 = mirror の自分の exam 全部 (現 exam も含む — 同一 exam 内移動のため)。
  // 並びは updated_at desc (upload-form の投入先 select と同じ)。
  const exams = useLiveQuery(async () => {
    const db = getClientDb()
    const rows = await db.exams.where('user_id').equals(userId).toArray()
    return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }, [userId])

  // 移動先 exam の card 群 (常駐列の算出元)。 owner scope は compound index の
  // 第 1 要素で構造保証する (use-move-cards / exam-list-live と同じ経路)。
  const targetCards = useLiveQuery(
    async () =>
      getClientDb()
        .cards.where('[user_id+exam_id]')
        .equals([userId, targetExamId])
        .toArray(),
    [userId, targetExamId],
  )

  // 常駐列 = 移動先の card ∖ 移動対象。 移動対象自身を anchor に取ると domain が
  // throw する (spec §2.3-2) ため、 選択肢の時点で除外する。
  const anchors = React.useMemo(() => {
    const moving = new Set(selectedIds)
    return (targetCards ?? [])
      .filter((card) => !moving.has(card.id))
      .sort(compareByBaseOrder)
  }, [targetCards, selectedIds])

  // 選択済み anchor が (移動先変更・削除で) 常駐列から消えたら先頭に落とす。
  const effectiveAnchorId = anchors.some((card) => card.id === anchorId)
    ? anchorId
    : (anchors[0]?.id ?? '')

  // 「直後」は gating 中と、 anchor 候補が 1 枚も無いときに選べない。
  const afterDisabled = positionLocked || anchors.length === 0
  const effectiveKind: PlacementKind = kind === 'after' && afterDisabled ? 'end' : kind

  const placement: MovePlacement =
    effectiveKind === 'after'
      ? { kind: 'after', anchorId: effectiveAnchorId }
      : { kind: effectiveKind }

  // 完了 (moved / no-cards) で閉じる。 失敗は開いたまま = 選び直して再試行できる。
  const handleOutcome = (outcome: MoveDispatchOutcome) => {
    // 移動先が mirror から消えていた: stale な選択を掴んだままの再実行を防ぐため
    // 既定 (現 exam) に戻す。 選択肢そのものは live query なので再取得は自動。
    if (outcome === 'target-exam-missing') setTargetExamId(currentExamId)
    if (outcome === 'moved' || outcome === 'no-cards') onDone()
  }

  const runMove = async () => {
    handleOutcome(await onMove(targetExamId, placement))
  }

  const runSplitOut = async () => {
    handleOutcome(await onSplitOut())
  }

  return (
    <div className="flex flex-col gap-3" data-testid="exam-card-move-popover">
      <div className="flex flex-col gap-1">
        <label htmlFor={targetId} className="font-medium">
          移動先の試験
        </label>
        <select
          id={targetId}
          value={targetExamId}
          disabled={pending}
          onChange={(e) => setTargetExamId(e.target.value)}
          className="w-full rounded-md border border-border bg-background p-1.5 text-sm disabled:opacity-50"
        >
          {(exams ?? []).map((exam) => (
            <option key={exam.id} value={exam.id}>
              {exam.name}
              {exam.id === currentExamId ? '(現在の試験)' : ''}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="font-medium">配置</legend>
        <PlacementRadio
          name={`${baseId}-kind`}
          value="end"
          label="末尾"
          checked={effectiveKind === 'end'}
          disabled={pending}
          onSelect={setKind}
        />
        <PlacementRadio
          name={`${baseId}-kind`}
          value="start"
          label="先頭"
          checked={effectiveKind === 'start'}
          disabled={pending}
          onSelect={setKind}
        />
        <PlacementRadio
          name={`${baseId}-kind`}
          value="after"
          label="指定カードの直後"
          checked={effectiveKind === 'after'}
          disabled={pending || afterDisabled}
          // disabled の理由 (gating / anchor 候補ゼロ) を必ず radio に紐付ける。
          describedBy={afterDisabled ? reasonId : undefined}
          onSelect={setKind}
        />
        {afterDisabled && (
          <p id={reasonId} className="text-xs text-muted-foreground">
            {positionLocked
              ? POSITION_LOCKED_REASON
              : '移動先に基準にできるカードがありません。'}
          </p>
        )}
      </fieldset>

      {effectiveKind === 'after' && (
        <div className="flex flex-col gap-1">
          <label htmlFor={anchorSelectId} className="font-medium">
            基準カード
          </label>
          <select
            id={anchorSelectId}
            value={effectiveAnchorId}
            disabled={pending}
            onChange={(e) => setAnchorId(e.target.value)}
            className="w-full rounded-md border border-border bg-background p-1.5 text-sm disabled:opacity-50"
          >
            {anchors.map((card) => (
              <option key={card.id} value={card.id}>
                {anchorLabel(card)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => void runMove()}>
          移動する
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void runSplitOut()}
        >
          新規試験へ切り出し
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
  disabled,
  describedBy,
  onSelect,
}: {
  name: string
  value: PlacementKind
  label: string
  checked: boolean
  disabled: boolean
  describedBy?: string
  onSelect: (kind: PlacementKind) => void
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={() => onSelect(value)}
      />
      {label}
    </label>
  )
}

// anchor の表示ラベル。 question_label が無いカードは title で代替する (spec §7.1)。
function anchorLabel(card: ClientCard): string {
  const raw = (card.question_label ?? card.title ?? '').trim()
  const text = raw.length > 0 ? raw : '(無題)'
  return text.length > ANCHOR_LABEL_MAX ? `${text.slice(0, ANCHOR_LABEL_MAX)}…` : text
}
