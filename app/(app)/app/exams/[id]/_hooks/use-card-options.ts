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
import { isAssetKey } from '@/lib/validation/card'
import { removeImageFromCard } from '@/lib/media/upload'
import { reclaimLocalAssetBlobs } from '@/lib/media/reclaim-local-asset-blobs'
import { logger } from '@/lib/logger'

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

// Sprint I W1: 選択肢削除時の画像 cascade。削除された option の `option:<id>` 画像を
// cards.images から除去する。これをしないと zombie 画像が残り、nextOptionId が同 id を
// 再利用した際に新選択肢へ誤紐付く(静かなデータ破損・spec §3)。
//
// 設計: DB 状態変更(選択肢削除 commit)を fallible な画像除去の成功に gate しないため、
// 削除は caller 側で先に確定し、本 cascade は後段 best-effort(fire-and-forget)で呼ぶ。
// userId は hook 引数に足さず card row(user_id)から導出する(caller 追随を増やさない)。
// 除去は gallery `handleDelete` と同型の 2 段(removeImageFromCard で配列除去 → 成功分を
// reclaimLocalAssetBlobs でローカル掃除)。複数画像は直列 for-await し、部分失敗は assetId
// 単位で warn して残件を止めない。
async function cascadeDeleteOptionImages(
  cardId: string,
  optionId: string,
): Promise<void> {
  const row = await getClientDb().cards.get(cardId)
  if (!row) return
  const images = Array.isArray(row.images) ? row.images : []
  const target = `option:${optionId}`
  // UUID key(= asset 参照)かつ当該 option target の entry のみ除去対象。legacy 非 UUID
  // entry は passthrough(除去しない)、他 target/他選択肢の画像は温存(union 非破壊)。
  const keys = images
    .filter((i) => isAssetKey(i.key) && i.target === target)
    .map((i) => i.key)
  if (keys.length === 0) return
  const removed: string[] = []
  for (const assetId of keys) {
    try {
      await removeImageFromCard({ cardId, assetId })
      removed.push(assetId)
    } catch {
      // 選択肢削除は確定済ゆえ rollback せず記録のみ(client 側失敗記録は logger.warn。
      // integration_failures 台帳は server reconciliation 用で client 書込経路が無い)。
      logger.warn({
        event: 'card_option_delete.image_cascade_failed',
        cardId,
        optionId,
        assetId,
      })
    }
  }
  if (removed.length > 0) {
    void reclaimLocalAssetBlobs(row.user_id, removed)
  }
}

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

export type UseCardOptionsReturn = {
  options: CardOption[]
  autoEditOptionId: string | null
  canDelete: boolean
  correctIds: string[]
  handleCellSave: (idx: number, next: CardOption) => void
  handleCellUnmountSave: (idx: number, next: CardOption) => void
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

  // Sprint F W2: cell の commit-on-unmount 経由の保存。scroll-out(仮想化)で編集中の
  // cell が blur を伴わず unmount した際、編集値を失わないための保全経路。
  // setOptions は張らない(unmount 中の setState を避ける)が、optionsRef は他 handler と
  // 同様に必ず同期する: plain ref 書込は lifecycle 影響がなく、hook が cell より長生き
  // する場合(全 card を atomic に tear-down しない仮想化戦略等)に後続 handler
  // (toggle / 別 cell 編集)が stale ref から payload を組んで unmount-saved edit を
  // 上書きするのを防ぐ(canonical Critical / Codex P2)。
  // 存在 gate(F6): runOptimisticUpdate は missing row でも enqueue するため、削除済 card
  // への orphan mutation を避けるべく cards.get で実在確認してから commit する
  // (InlineTextField の commit-on-unmount と同型・cleanup は同期だが commit は元来
  // fire-and-forget ゆえ async gate で分岐してよい)。immediateDrain で timer を残さない。
  const handleCellUnmountSave = (idx: number, nextOption: CardOption) => {
    const nextAll = optionsRef.current.slice()
    nextAll[idx] = nextOption
    if (shallowEqualOptions(nextAll, optionsRef.current)) return
    optionsRef.current = nextAll
    void getClientDb()
      .cards.get(cardId)
      .then((row) => {
        // gate resolve 時点の最新 working-set(optionsRef.current)を commit する。
        // 捕捉した nextAll をそのまま commit すると、cards.get の解決待ちの窓で別 handler
        // (別 cell の toggle/編集)が新しい配列を commit した場合に古い snapshot で
        // 上書きしうる(Codex P2)。latest を commit すれば本 cell の edit(上で同期済)+
        // 窓中の並行変更の双方を保つ。row 不在(削除済)なら commit skip = orphan 回避(F6)。
        if (row) commit(optionsRef.current, true)
      })
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
    // 削除前に対象 option id を捕捉(cascade の target 決定に使う)。
    const deletedId = optionsRef.current[idx]!.id
    const nextAll = optionsRef.current.filter((_, i) => i !== idx)
    setOptions(nextAll)
    optionsRef.current = nextAll
    commit(nextAll, true)
    // Sprint I W1: 選択肢削除を確定させた後、後段で画像を cascade 除去(best-effort)。
    // 削除を画像除去の成功に gate しない(decouple・spec §3)。top-level の Dexie read
    // 失敗も握って unhandled rejection を出さない(既存 fire-and-forget と同 house style)。
    void cascadeDeleteOptionImages(cardId, deletedId).catch(() => {})
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
    handleCellUnmountSave,
    handleCheckboxToggle,
    handleAddOption,
    handleDeleteOption,
  }
}
