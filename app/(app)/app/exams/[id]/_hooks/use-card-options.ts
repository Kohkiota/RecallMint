// useCardOptions — Edit-2 T1: InlineOptionList の working-set/commit/handlers を hook に抽出。
//
// 選択肢 working-set (ghost row 含む) + 500ms debounce commit + 4 handlers を保持する。
// `InlineOptionList` はこの hook を呼ぶ薄い consumer となる。
//
// 'use client' directive を付けない: hook は boundary を持たず、 consumer の client
// component (InlineOptionList) が境界を確立する (use-card-tag-toggle.ts と同方針)。
// Next.js TS plugin が export を component と誤認識し function arg を 「serializable
// でない Server Action prop」 として誤検出する (rule 71007) のを防ぐため。

import { useEffect, useRef, useState } from 'react'
import type { CardOption } from '@/lib/db/schema'
import { nextOptionId } from '@/lib/cards/next-option-id'
import { deriveCorrectAnswerIds } from '@/lib/cards/domain/card-rules'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { runOptimisticUpdate } from '@/lib/sync/optimistic-mutation'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'

// snake_case CardOption → camelCase (bulk endpoint の optionsSchema が期待する形)。
// server 側 lib/cards/card-field-handlers.ts の CARD_FIELD_HANDLERS.options
// handler が camelCase → snake_case に戻す (handler 内で is_correct / explanation
// jsonb 形に詰め直す)。
type ZodOption = {
  id: string
  text: string
  isCorrect: boolean
  explanation?: string
}

function toZodOption(o: CardOption): ZodOption {
  return {
    id: o.id,
    text: o.text,
    isCorrect: o.is_correct,
    ...(o.explanation ? { explanation: o.explanation } : {}),
  }
}

// id / text / is_correct / explanation 全 field 比較。 explanation は undefined と
// 未設定 を同一視 (CardOption の jsonb 表現に合わせる)。
function shallowEqualOption(a: CardOption, b: CardOption): boolean {
  return (
    a.id === b.id &&
    a.text === b.text &&
    a.is_correct === b.is_correct &&
    (a.explanation ?? undefined) === (b.explanation ?? undefined)
  )
}

function shallowEqualOptions(a: CardOption[], b: CardOption[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!shallowEqualOption(a[i]!, b[i]!)) return false
  }
  return true
}

const DEBOUNCE_MS = 500

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

export type UseCardOptionsReturn = {
  options: CardOption[]
  autoEditOptionId: string | null
  canDelete: boolean
  correctIds: string[]
  handleCellSave: (idx: number, next: CardOption) => void
  handleCheckboxToggle: (idx: number, checked: boolean) => void
  handleAddOption: () => void
  handleDeleteOption: (idx: number) => void
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * card 単位の選択肢 working-set + commit/drain を集約する hook。
 *
 * state (options / autoEditOptionId) / refs (serverCommittedRef / debounceTimerRef /
 * optionsRef) / merge useEffect / commit / scheduleDrain / 4 handlers を
 * InlineOptionList からそのまま移送 (意味等価)。
 * ghost row 保持 / 500ms debounce / dirty-guard merge / autoEdit / correct_answer_ids
 * derive は一切変えない。
 */
export function useCardOptions(
  cardId: string,
  serverOptions: CardOption[],
): UseCardOptionsReturn {
  // 表示 + payload 構築の真実 source (全 row 共有、 ghost row を含む working-set)。
  const [options, setOptions] = useState<CardOption[]>(serverOptions)
  // S2.0b-3: 「+ 選択肢を追加」 直後に new row の text cell を自動で編集モード化する
  // ための one-shot marker。
  const [autoEditOptionId, setAutoEditOptionId] = useState<string | null>(null)

  // server (mirror) 確定値。 no-op short-circuit 比較 + merge 基準として保持する。
  const serverCommittedRef = useRef<CardOption[]>(serverOptions)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // options state を closure ではなく ref 経由で参照するための同期 ref。
  const optionsRef = useRef<CardOption[]>(options)
  optionsRef.current = options

  // 親 (useLiveQuery / mirror) 由来で serverOptions が変わったら working-set を同期。
  // merge 戦略: server 確定値 + 「保持すべき local ghost」。
  //   保持する ghost = serverOptions に id が無い working-set 行のうち、
  //     (a) text あり = 入力済で commit が server へ未反映 (in-flight) → 失うと lost-write、 か
  //     (b) id === autoEditOptionId = 「+ 追加」 直後の編集対象 (空でもこれから入力)
  //   それ以外の **放置された空 ghost** (空 かつ 編集対象でない) は drop する。
  // 70d0714 は全 ghost を末尾保持して「連続追加で入力中の 2 つ目が消える」race を直したが、
  // 副作用で放置空 ghost が末尾に蓄積・後方移動していた (本 fix の対象)。(a)/(b) のみ保持で
  // typing 保護を維持しつつ放置空を落とす。空は従来どおり永続化されない (sanitize は不変)。
  useEffect(() => {
    const serverIds = new Set(serverOptions.map((o) => o.id))
    const keptGhosts = optionsRef.current.filter(
      (o) =>
        !serverIds.has(o.id) &&
        (o.text.trim().length > 0 || o.id === autoEditOptionId),
    )
    const merged: CardOption[] = [...serverOptions, ...keptGhosts]
    setOptions(merged)
    serverCommittedRef.current = serverOptions
    optionsRef.current = merged
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverOptions])

  // unmount で timer clear。
  // なぜ drain 取りこぼし OK: blur 後 500ms 以内に離脱すると本 hook の debounce
  // drain は発火しないが、 enqueue は Dexie に同期 persist 済みのため、 次の ambient
  // trigger (pagehide best-effort / visibilitychange / 次回 mount =
  // entity-mutation-flush-trigger) で drain される。 lost-write ではない (checkbox /
  // delete は immediateDrain のため本 path に依存しない)。
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [])

  // 500ms debounce 後に outbox drain を 1 回叩く (drain trigger の debounce)。
  const scheduleDrain = () => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void runGuardedEntityMutationFlush().catch(() => {})
    }, DEBOUNCE_MS)
  }

  // commit: working-set snapshot を sanitize (ghost 除外) し、 mirror 直書き +
  // outbox enqueue を 1 Dexie rw tx に閉じる (`runOptimisticUpdate` helper、 enqueue
  // throw で Dexie auto-rollback → mirror も before 値に戻る、 catch は helper 内蔵
  // silent + `logger.warn` 1 行)。 immediateDrain=true の場合 (checkbox / delete) は
  // drain も即時叩く (debounce 解除)。 それ以外は caller-side debounce drain
  // (scheduleDrain) を維持する (plan §全体ルール 3、 helper 内蔵 flush は skip)。
  const commit = (target: CardOption[], immediateDrain = false) => {
    // ghost (text 空) は server zod が reject するため payload から除外。
    const sanitized = target.filter((o) => o.text.trim().length > 0)
    // sanitized が空 (全 row ghost)、 または server 確定値と一致 → commit 不要。
    if (
      sanitized.length === 0 ||
      shallowEqualOptions(sanitized, serverCommittedRef.current)
    ) {
      return
    }

    // correct_answer_ids は is_correct から derive して同時 set (display 楽観反映用)。
    // server には送らず再生成される。 beforeValue は serverCommittedRef.current (= 直近の
    // server 確定値) から再構築する (revert 時に server 値に戻る経路、 Dexie auto-rollback
    // で十分なため helper 側 isNoop には参照されない)。
    // beforeValue は helper API 対称性のため渡しているが、 caller 側で
    // `shallowEqualOptions(sanitized, serverCommittedRef.current)` の no-op を上で短絡判定済 →
    // helper 側 `isNoop` は使わない (helper 内 isNoop 経由の早期 return は使わない)。
    // revert も Dexie auto-rollback に一任 = beforeValue は実質 dead、 caller-side で
    // 型を揃えるためだけに構築する。
    const correctAnswerIds = deriveCorrectAnswerIds(sanitized)
    const beforeOptions = serverCommittedRef.current
    const beforeCorrect = deriveCorrectAnswerIds(beforeOptions)
    const beforePatch: Partial<ClientCard> = {
      options: beforeOptions,
      correct_answer_ids: beforeCorrect,
    }
    const afterPatch: Partial<ClientCard> = {
      options: sanitized,
      correct_answer_ids: correctAnswerIds,
    }

    // outbox enqueue payload。 value は camelCase ZodOption[] (correct_answer_ids は含めない)。
    const payload: ZodOption[] = sanitized.map(toZodOption)

    void runOptimisticUpdate({
      store: getClientDb().cards,
      rowKey: cardId,
      beforeValue: beforePatch as Record<string, unknown>,
      afterPatch: afterPatch as Record<string, unknown>,
      mutation: {
        entity_type: 'card',
        entity_id: cardId,
        op: 'update_field',
        patch: { field: 'options', value: payload },
      },
      logEvent: 'card_inline.commit.tx_failed',
      logContext: { cardId, field: 'options' },
      // plan §全体ルール 3: debounce drain は caller 側に保持 (debounce or immediateDrain は
      // 下記 if/else で管理、 helper 内蔵 flush は skip)。
      skipInternalFlush: true,
    })

    if (immediateDrain) {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      void runGuardedEntityMutationFlush().catch(() => {})
    } else {
      scheduleDrain()
    }
  }

  // cell blur 経由の保存 (id / text / explanation)。 idx で row 特定、 nextOption は
  // cell が組み立てた CardOption (= 元 option を該当 field のみ書換えたもの)。
  const handleCellSave = (idx: number, nextOption: CardOption) => {
    const nextAll = optionsRef.current.slice()
    nextAll[idx] = nextOption
    // 値変更なしなら working-set / commit を触らない (no-op)。
    if (shallowEqualOptions(nextAll, optionsRef.current)) {
      return
    }
    setOptions(nextAll)
    optionsRef.current = nextAll
    commit(nextAll)
  }

  // checkbox toggle: working-set を即時更新 → commit (即時 drain)。
  const handleCheckboxToggle = (idx: number, nextChecked: boolean) => {
    const nextAll = optionsRef.current.slice()
    nextAll[idx] = { ...nextAll[idx]!, is_correct: nextChecked }
    setOptions(nextAll)
    optionsRef.current = nextAll
    commit(nextAll, true)
  }

  // 「+ 選択肢を追加」: 新規 option を optimistic に末尾追加 + auto-edit marker を
  // セット。 commit は呼ばない (text='' は ghost、 sanitize で除外される)。 user の
  // text 入力 → blur で handleCellSave 経由の通常 commit にのせる。
  const handleAddOption = () => {
    const newId = nextOptionId(optionsRef.current.map((o) => o.id))
    const newOption: CardOption = {
      id: newId,
      text: '',
      is_correct: false,
    }
    const nextAll = [...optionsRef.current, newOption]
    setOptions(nextAll)
    optionsRef.current = nextAll
    setAutoEditOptionId(newId)
  }

  // 削除: optimistic 即時除去 + commit (即時 drain)。 options.length === 1 は UI 上
  // button が disabled で到達しないが server zod min(1) を defensive に local でも判定。
  const handleDeleteOption = (idx: number) => {
    if (optionsRef.current.length <= 1) return
    const nextAll = optionsRef.current.filter((_, i) => i !== idx)
    setOptions(nextAll)
    optionsRef.current = nextAll
    commit(nextAll, true)
  }

  // S2.0b-3: 選択肢 count + 正解サマリは optimistic `options` state から計算して
  // checkbox toggle と同時即時更新する。 正解 0 件はサマリ要素自体を hide。
  const canDelete = options.length > 1
  const correctIds = deriveCorrectAnswerIds(options)

  return {
    options,
    autoEditOptionId,
    canDelete,
    correctIds,
    handleCellSave,
    handleCheckboxToggle,
    handleAddOption,
    handleDeleteOption,
  }
}
