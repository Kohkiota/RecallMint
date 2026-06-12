'use client'

// 試験詳細 page (/app/exams/[id]) の inline 編集 cell (1 field 用 reusable)。
//
// Stage 4 (Task 4.2) で **local-first 書込**に cutover:
// blur (commit) で即時に
//   1. mirror 直書き  : getClientDb().cards.update(cardId, { [field]: value })
//   2. outbox enqueue : enqueueEntityMutation({ entity_type: 'card', op: 'update_field', patch: { field, value } })
// を実行し (= 楽観反映は Dexie cards mirror が単一の真実 source)、 server への
// 実 drain は 500ms debounce 後に runGuardedEntityMutationFlush() を 1 回叩くだけにする
// (送信遅延ではなく drain trigger の debounce)。 display は親 (InlineCardList) の
// useLiveQuery が mirror から返す値が initialValue として降りてくるため、 component 側で
// committedValue を二重に持たない。
//
// rollback は pull-reconciliation に再構成: 拒否された編集は server に届かず、 server
// 値は権威のまま、 次の pull/pull-back が server 値を mirror に bulkPut → value prop
// 経由で降りてきて、 idle 時に dirty-guard (prev-render setState) が display を更新する。 component
// 内の同期 rollback / inFlight / queue 機構は撤去した (flush engine が Web Locks +
// in-flight Set + mutation_id UNIQUE で直列化・冪等化する)。
//
// 入力中フィールドのカーソル保護は既存の dirty-guard (編集中は外部 prop 値で value を
// 上書きしない) を流用。
//
// レイアウト (S2.0b-2 follow-up): display / edit の box 寸法 (border-box + padding +
// 1px border) を完全一致させて edit 切替時の layout shift を防ぐ。 display 側に
// `border border-transparent` を入れて textarea / input の見える 1px border 分を
// 予約。 multiline textarea は `useLayoutEffect` で auto-resize (paint 前同期実行で
// 初回 mount の 1 frame flicker を回避)。

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { runOptimisticUpdate } from '@/lib/sync/optimistic-mutation'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'

// sort_key / title / question_text / explanation_text / memo は ClientCard の
// snake_case 列名に 1:1 対応する (mirror patch のキーにそのまま使う)。
type InlineTextFieldName =
  | 'sort_key'
  | 'title'
  | 'question_text'
  | 'explanation_text'
  | 'memo'

type InlineTextFieldProps = {
  cardId: string
  field: InlineTextFieldName
  initialValue: string | null
  ariaLabel: string
  multiline?: boolean
  placeholder?: string
  // display mode の追加 className (font / color 等 cell 表現を上書きするため)
  displayClassName?: string
  // S2.0b 「+ カードを追加」 直後に new card の問題文 cell を mount 即 edit にする
  // ための one-shot marker。 useState initializer のみ参照し、 mount 後は無視する。
  autoEditOnMount?: boolean
}

const DEBOUNCE_MS = 500

// server (lib/cards/card-field-handlers.ts の CARD_FIELD_HANDLERS[field] handler、
// 具体的には sort_key / explanation_text / memo の各 handler 内で '' → null 正規化)
// が空文字を null に揃える nullable text 列。 mirror も同じ正規化をかけ、 楽観値を
// server 確定値に一致させる (pull-back での見た目反転防止)。
const NULLABLE_FIELDS: ReadonlySet<InlineTextFieldName> = new Set([
  'sort_key',
  'explanation_text',
  'memo',
])

export function InlineTextField({
  cardId,
  field,
  initialValue,
  ariaLabel,
  multiline = false,
  placeholder = '(クリックで追加)',
  displayClassName,
  autoEditOnMount = false,
}: InlineTextFieldProps) {
  const initialString = initialValue ?? ''
  // display + edit 共用の単一 optimistic state。 display は mirror (initialValue prop)
  // から降りてくるが、 楽観反映の即時性 (mirror write → useLiveQuery 再評価までの 1
  // tick lag) を埋めるため value を直接 display にも使う。 編集中でなければ dirty-guard
  // (prev-render setState) が value ← initialValue に同期する。
  const [value, setValue] = useState<string>(initialString)
  // initializer は mount 時のみ評価 (subsequent prop change は無視、 one-shot 性)。
  const [editing, setEditing] = useState<boolean>(() => autoEditOnMount)

  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  // 直近 mirror 確定値 = initialString (initialValue prop の string 化)。 値変更なし
  // blur の no-op short-circuit 比較に使う。 旧 mirrorValueRef は render 中に
  // initialString を書き戻すだけだったので撤去 (react-hooks/refs)、 consumer は
  // initialString を直接参照する。
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // edit mode 切替時に auto-focus
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  // multiline textarea の auto-resize: 編集中 + value 変化に追従して内容高さに合わせる。
  // useLayoutEffect で paint 前に同期実行 (initial mount の 1 frame flicker 回避)。
  useLayoutEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (!(el instanceof HTMLTextAreaElement)) return
    // '0px' で一旦潰してから scrollHeight を測る。 'auto' だと textarea 既定
    // rows=2 の 2 行枠が clientHeight として残り scrollHeight=2 行で固定され、
    // 1 行内容でも 2 行高さに膨らむ (display とズレる)。 '0px' なら真の内容高を返す。
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [editing, value])

  // dirty-guard: 親 (useLiveQuery / mirror) 由来で initialValue が外部変化した時、
  // 編集中でなければ value を新値に同期する (= pull-reconciliation の rollback path も
  // ここを通る)。 編集中は user 入力を保護するため触らない。
  //
  // React 19 "store info from previous renders" pattern (sentinel-only update + inner editing gate)。
  // 旧 useEffect は deps `[initialValue]` 単独 + 早期 return で「editing 変化単独では resync しない」
  // invariant を実装していた (flicker 回避、 旧 line 125 の eslint-disable で意図明示)。 prev-render
  // guard でこの invariant を厳密保持するため、 sentinel 更新は initialString 変化で常時走らせ、
  // setValue は editing=false の inner gate に置く。 editing: true → false 遷移時に sentinel
  // は既に新値で同期済 → 再 setValue されない = 旧 deps と同 semantics。
  const [lastSyncedInitialValue, setLastSyncedInitialValue] = useState(initialString)
  if (initialString !== lastSyncedInitialValue) {
    setLastSyncedInitialValue(initialString)
    if (!editing) {
      setValue(initialString)
    }
  }

  // unmount で timer clear (StrictMode 二重 effect でも単純な timer cleanup のみ)。
  // なぜ drain 取りこぼし OK: blur 後 500ms 以内に離脱すると本 component の drain は
  // 発火しないが、 enqueue は Dexie に同期 persist 済みのため、 次の ambient trigger
  // (pagehide best-effort / visibilitychange / 次回 mount = entity-mutation-flush-trigger)
  // で drain される。 ここでの取りこぼしは lost-write ではない。
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [])

  // commit: mirror 直書き + outbox enqueue を 1 Dexie rw tx に閉じる
  // (`runOptimisticUpdate` helper、 enqueue throw で Dexie auto-rollback → mirror も
  // beforeValue 相当に戻る、 catch は helper 内蔵 silent + `logger.warn` 1 行)。
  // server への drain は debounce 後 (scheduleDrain) を維持 (helper 内蔵 fire-and-forget
  // flush と二重に走るが run-guarded 側で同時実行は弾かれる、 既存挙動同等)。
  //
  // なぜ正規化: nullable 列は server (lib/cards/card-field-handlers.ts の
  // CARD_FIELD_HANDLERS[field] handler、 sort_key / explanation_text / memo は handler
  // 内で `r.data === '' ? null : r.data` 正規化) が '' を null に揃えるため、 mirror にも
  // 同じ規則を適用して楽観値を server 確定値に一致させる (一致させないと次の pull-back で
  // '' → null へ見た目が反転する)。 server zod は trim しないのでここも strict な === '' で
  // 揃える。 enqueue に渡す raw 値は変えない (server 側で正規化されるため、 raw を送って
  // server contract に委ねる)。
  //
  // beforeValue は render scope の initialString (= 直近 mirror 確定値) を正規化して渡す。
  // commit 直前に `value === initialString` の no-op short-circuit を `handleBlur` で済ませて
  // いるため、 helper 側 `isNoop` は省略 (no-op は到達しない)。
  const commit = (target: string) => {
    const mirrorValue =
      NULLABLE_FIELDS.has(field) && target === '' ? null : target
    const beforeMirrorValue =
      NULLABLE_FIELDS.has(field) && initialString === '' ? null : initialString
    // beforeValue は helper API 対称性のため渡しているが、 commit 直前に
    // `value === initialString` の no-op を `handleBlur` で短絡判定済なので、
    // helper 側 `isNoop` には渡さない (helper 内 isNoop 経由の早期 return は使わない)。
    // revert は Dexie auto-rollback (mirror update + enqueue の同一 tx 内 rollback) に
    // 一任 = beforeValue は実質 dead だが、 caller-side で型を揃えるために構築する。
    const beforePatch: Partial<ClientCard> = { [field]: beforeMirrorValue }
    const afterPatch: Partial<ClientCard> = { [field]: mirrorValue }
    void runOptimisticUpdate({
      store: getClientDb().cards,
      rowKey: cardId,
      beforeValue: beforePatch as Record<string, unknown>,
      afterPatch: afterPatch as Record<string, unknown>,
      mutation: {
        entity_type: 'card',
        entity_id: cardId,
        op: 'update_field',
        patch: { field, value: target },
      },
      logEvent: 'card_inline.commit.tx_failed',
      logContext: { cardId, field },
      // plan §全体ルール 3: debounce drain は caller 側に保持 (本 component の 500ms
      // scheduleDrain を維持、 helper 内蔵 fire-and-forget flush は skip)。
      skipInternalFlush: true,
    })
    scheduleDrain()
  }

  // 500ms debounce 後に outbox drain を 1 回叩く (連続編集は timer reset で最後の
  // commit から 500ms 後に 1 回)。 送信遅延ではなく drain trigger の debounce。
  const scheduleDrain = () => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void runGuardedEntityMutationFlush().catch(() => {})
    }, DEBOUNCE_MS)
  }

  const startEdit = () => {
    setEditing(true)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // a11y: keyboard 対応 (Enter / Space で edit 開始)
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      startEdit()
    }
  }

  const handleBlur = () => {
    // editing を即時 false に (display 復帰)。
    setEditing(false)
    // 値変更なしなら mirror write + enqueue を skip (無駄な outbox 行を避ける)。
    // 比較基準は render scope の initialString (旧 mirrorValueRef.current と等価)。
    if (value === initialString) {
      return
    }
    commit(value)
  }

  // display / edit で共通の box 寸法 (border-box + padding + 1px border + radius +
  // 最小高さ + 幅)。 textarea / input の default は twMerge で表示モードと同じ値に上書き。
  const sharedBoxChrome = 'block w-full min-h-11 rounded-md p-2 md:min-h-8 md:py-1'

  if (editing) {
    const commonProps = {
      'aria-label': ariaLabel,
      value,
      onChange: (
        e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => setValue(e.target.value),
      onBlur: handleBlur,
      ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
        inputRef.current = el
      },
    }
    return (
      <div className="space-y-1">
        {multiline ? (
          <Textarea
            {...(commonProps as React.ComponentProps<typeof Textarea> & {
              ref: React.Ref<HTMLTextAreaElement>
            })}
            // rows 固定値は使わない (auto-resize 担当の useLayoutEffect が scrollHeight に
            // 追従させる)。 `resize-none overflow-hidden` で manual resize handle と
            // scrollbar を抑止し、 親レイアウトと整合させる。
            className={`${sharedBoxChrome} resize-none overflow-hidden ${displayClassName ?? ''}`}
          />
        ) : (
          <Input
            {...(commonProps as React.ComponentProps<typeof Input> & {
              ref: React.Ref<HTMLInputElement>
            })}
            type="text"
            className={`${sharedBoxChrome} ${displayClassName ?? ''}`}
          />
        )}
      </div>
    )
  }

  // display mode
  const displayText = value
  const isEmpty = displayText.length === 0
  return (
    <div className="space-y-1">
      <div
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        onClick={startEdit}
        onKeyDown={onKeyDown}
        className={`${sharedBoxChrome} border border-transparent cursor-text transition-colors hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
          isEmpty ? 'text-slate-400 italic' : ''
        } ${displayClassName ?? ''}`}
      >
        {isEmpty ? (
          <span>{placeholder}</span>
        ) : (
          <span className="whitespace-pre-wrap break-words">
            {displayText}
            {/* white-space:pre-wrap は末尾の単一改行に line box を作らず、 末尾改行を
                持つ値が textarea(edit) より 1 行低く表示される。 末尾が改行のときだけ
                装飾 <br> を 1 つ補い、 edit と行数/高さを一致させる (落とされるのは
                常に最後の 1 行のみなので 1 個で N 個ぶん揃う)。 <br> は textContent に
                寄与しないためコピーは値そのまま。 */}
            {displayText.endsWith('\n') && <br aria-hidden="true" />}
          </span>
        )}
      </div>
    </div>
  )
}
