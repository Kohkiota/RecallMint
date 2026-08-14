'use client'

// 試験詳細の h1 (試験名) の inline 編集 (Grid-3 spec §6.2)。
//
// - click → input、 Enter / blur で commit、 Escape で cancel、 commit 中は disabled。
// - 書込は server action `renameExam` (exam は outbox に載せない既存の不変条件)。
//   成功で表示を commit 値 (trim 済) に更新 → `router.refresh()` (server render の
//   examName / updatedLabel を更新) + `runGuardedPull({ reason: 'exam-rename' })`。
// - **exams の Dexie mirror へ楽観書込しない**: exams mirror は pull 上書きのみの
//   read-only レーン (`lib/client-db.ts` の ClientExam コメント)。 pull で取り込む。
// - card の `InlineTextField` は card mutation 経路 (mirror 直書き + outbox) に結線
//   されているため流用しない。
// - 二重送信 guard は 3 段: ① commit 進行中 (`committingRef`) ② trim 後が未変更
//   ③ 直前に失敗した値と同一 (`lastFailedRef`)。詳細は commit() のコメント。
// - 編集中も h1 を保つ (input を h1 の中に入れる) — card view ではページ唯一の
//   見出しであり、 編集中に heading が消えると document outline が欠ける。

import { useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { renameExam } from '@/app/(app)/app/exams/_actions/rename-exam'
import { runGuardedPull } from '@/lib/sync/pull'
import { cn } from '@/lib/utils'

// 見出しの見た目。 置換前の h1 2 箇所 (exam-detail-view.tsx の card view / table view)
// の class 差分をそのまま variant として保持する。
// - card    : document flow の見出し。 **truncate しない** (従来どおり折り返す)。
// - compact : table view の 1 行 chrome。 従来どおり truncate で clip する。
const VARIANT_CLASS = {
  card: { heading: 'text-2xl font-bold', control: '' },
  compact: {
    heading: 'truncate text-base font-bold',
    control: 'block max-w-full truncate',
  },
} as const

// action reject (offline / network 断等) 時の inline 文言。 server action の
// failure 文体に揃える。
const COMMIT_REJECTED_MESSAGE =
  '試験名の変更に失敗しました。しばらくしてから再度お試しください。'

type ExamTitleInlineEditProps = {
  examId: string
  // server render 値 (page.tsx → ExamDetailView 経由)。 非編集中はこれで表示を同期する。
  examName: string
  variant: keyof typeof VARIANT_CLASS
}

export function ExamTitleInlineEdit({
  examId,
  examName,
  variant,
}: ExamTitleInlineEditProps) {
  const router = useRouter()
  const styles = VARIANT_CLASS[variant]
  const errorId = useId()
  const hintId = useId()

  const [editing, setEditing] = useState(false)
  // commit 済みの表示値。 成功時は server prop の更新 (router.refresh()) を待たず
  // trim 済 commit 値で先に更新する。
  const [displayName, setDisplayName] = useState(examName)
  const [value, setValue] = useState(examName)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const inputRef = useRef<HTMLInputElement | null>(null)
  // guard ①: commit 進行中フラグ。 Enter で commit 開始 → 同 tick の blur で
  // 2 回目が来ても action を叩かない (二重 UPDATE / 二重 refresh の防止)。
  const committingRef = useRef(false)
  // guard ③: 直前に失敗した (値, message)。 恒久失敗の値を blur のたびに
  // 再送しないための記憶。
  const lastFailedRef = useRef<{ value: string; error: string } | null>(null)

  // 非編集中は外部 prop (server render 値) で表示を同期する。 React 19 の
  // "store info from previous renders" pattern: useEffect でなく render 中の
  // guarded setState (option-row.tsx と同 pattern・cascading render 回避)。
  const [lastSyncedName, setLastSyncedName] = useState(examName)
  if (!editing && examName !== lastSyncedName) {
    setLastSyncedName(examName)
    setDisplayName(examName)
    setValue(examName)
  }

  // edit mode 突入時: focus + 全選択。
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  // commit 中は input が disabled になり、 ブラウザは disabled 化した要素から focus を
  // 外す。 失敗して編集モードに留まった場合 editing は変化しないため上の effect は
  // 再発火せず、 user が click し直す羽目になる。 pending が false に戻った時点で
  // focus を戻す (全選択はしない — 失敗値を直す文脈なので caret を潰さない)。
  useEffect(() => {
    if (editing && !pending) inputRef.current?.focus()
  }, [editing, pending])

  const startEdit = () => {
    // guard ① は成功 path で戻さない (下記参照) ため、 新しい編集セッションの開始点で
    // 解除する。 ここに来られる = 非編集 render が既に commit 済 = 危険な窓は閉じた後。
    committingRef.current = false
    lastFailedRef.current = null
    setValue(displayName)
    setError(null)
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setValue(displayName)
    setError(null)
  }

  // 失敗の共通後始末: 編集モードを継続したまま inline error を出し、 同値の再送を抑止する
  // (option-row の rename と同方針)。
  const failCommit = (attempted: string, message: string) => {
    lastFailedRef.current = { value: attempted, error: message }
    setError(message)
    setPending(false)
    committingRef.current = false
  }

  const commit = async () => {
    // guard ①: 進行中の commit があれば何もしない (Enter → blur の二重発火)。
    if (committingRef.current) return
    const trimmed = value.trim()
    // guard ②: trim 後が未変更なら action を呼ばず閉じるだけ (no-op)。
    // Escape 後に blur が届く経路もここで吸収される (cancelEdit が value を戻すため)。
    if (trimmed === displayName) {
      cancelEdit()
      return
    }
    // guard ③: 直前に失敗した値と同一なら再送しない (恒久失敗で blur のたびに往復するのを防ぐ)。
    // error 表示は継続させる (user が入力を変えるまで状態を変えない)。
    const lastFailed = lastFailedRef.current
    if (lastFailed && lastFailed.value === trimmed) {
      setError(lastFailed.error)
      return
    }

    committingRef.current = true
    setPending(true)
    try {
      const result = await renameExam(examId, trimmed)
      if (!result.ok) {
        failCommit(trimmed, result.error)
        return
      }
      lastFailedRef.current = null
      setDisplayName(trimmed)
      setValue(trimmed)
      setError(null)
      setEditing(false)
      setPending(false)
      router.refresh()
      void runGuardedPull({ reason: 'exam-rename' }).catch(() => {})
      // 成功 path では committingRef を戻さない: setEditing(false) は次の render まで
      // 反映されず、 その窓に届いた blur は古い closure (旧 displayName) を見て guard ②
      // も抜けてしまうため。 解除は startEdit (= 非編集 render 後) が行う。
    } catch {
      // action の reject (offline / network 断 / server 例外) を inline error 経路へ流す。
      // 握らないと unhandled rejection になり user には何も表示されない。
      failCommit(trimmed, COMMIT_REJECTED_MESSAGE)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  if (!editing) {
    return (
      <>
        <h1 className={styles.heading}>
          <button
            type="button"
            onClick={startEdit}
            // hover で全文が読めるよう試験名そのものを載せる (compact は truncate するため)。
            // 操作説明は aria-describedby の hint へ (button に aria-label を置くと
            // h1 の accessible name が操作説明で上書きされてしまう)。
            title={displayName}
            aria-describedby={hintId}
            className={cn(
              '-mx-1 rounded px-1 text-left hover:bg-slate-100',
              styles.control,
            )}
          >
            {displayName}
          </button>
        </h1>
        {/* h1 の外に置く: 中に入れると heading の accessible name に混入する。 */}
        <span id={hintId} className="sr-only">
          クリックして試験名を編集
        </span>
      </>
    )
  }

  return (
    <>
      <h1 className={styles.heading}>
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          onBlur={() => {
            void commit()
          }}
          onKeyDown={handleKeyDown}
          disabled={pending}
          aria-label="試験名 編集"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            'py-1',
            styles.heading,
            error && 'border-red-400 focus-visible:ring-red-400',
          )}
        />
      </h1>
      {error ? (
        <p id={errorId} className="mt-0.5 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
