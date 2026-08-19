'use client'

// DailyNewTargetField — 試験ごとの新規/日上限 (K) の設定入力 (Dash-1 Home v1 spec §8.1)。
// ExamTitleInlineEdit (rename) の隣に置く設定面。
//
// - 初期値は Dexie mirror (`db.exams.get(examId)`) から読む。 exams mirror は pull
//   上書きのみの read-only レーンで、 Task 9 の前提 (ClientExam.daily_new_target が
//   pull mapper 経由で mirror に届く) を直接消費する形。
// - 空欄 = null = 既定 DAILY_NEW_DEFAULT に追従。 0 は「新規を出さない」明示値であり
//   既定へは絶対に丸めない — 変換はすべて `=== ''` / `=== null` の明示比較のみで行い、
//   `||` や truthy チェックを使わない (0 は falsy だが有効値)。
// - 保存は明示ボタン (SessionLimitForm と同じ「auto-save しない」方針 — 入力途中の
//   値を server に送らない)。 失敗は inline error で必ず表面化させる (silent success 禁止)。
// - 書込は server action `updateDailyNewTarget` (exam は outbox に載せない既存の不変条件)。
//   成功後は `runGuardedPull` で mirror 反映を最短化する (完全収束は次 pull — soft limit
//   の受容範囲、 spec §8.3)。 kick は skip されうる (runGuardedPull の skip は通常経路)
//   ため、 表示は pull の成否に依存させない (下記 lastMirror)。
//
// 受容した限界 (2 つとも「次回 mount で解消する」性質):
// - 保存後 mirror が保存値を経由せず別値へ跳んだ場合 (= 他端末が同じ試験の K を続けて
//   変えた場合) だけ、 その端末の表示は自分の保存値に留まる。 この時 mirror 追従は
//   一瞬でなく **その component の残り lifetime の間** 止まる (value と lastMirror が
//   二度と一致しないため)。 単一端末では pull が保存値を運んだ時点で追従が回復する。
// - 保存済 K が読めていない間 (Dexie query 未解決 / 行が mirror に無い) は入力・保存とも
//   無効にする。 空欄は「既定へ戻す」を意味するため、 現在値を知らないままの保存は
//   server の K を潰すのと同じだから。
//   受容: pull が届かない端末ではこの field が無効のまま残る (K を読めない以上、
//   触らせない方が安全)。 詳細ページは mount 時に pull を kick するので通常は即解ける。

import { useId, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getClientDb } from '@/lib/client-db'
import { updateDailyNewTarget } from '@/app/(app)/app/exams/_actions/update-daily-new-target'
import { runGuardedPull } from '@/lib/sync/pull'
import { DAILY_NEW_DEFAULT } from '@/lib/dashboard/domain/metric-constants'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const SAVE_REJECTED_MESSAGE =
  '新規/日の上限の変更に失敗しました。しばらくしてから再度お試しください。'

// number | null → 表示文字列。 null (既定追従) だけが空欄になる。0 は "0" のまま。
function toDisplay(v: number | null): string {
  return v === null ? '' : String(v)
}

type DailyNewTargetFieldProps = {
  examId: string
  userId: string
  // compact = table view の 1 行 chrome (密度優先ゆえ既定値の説明文を出さない。
  // 空欄の意味は placeholder が担う)。 ExamTitleInlineEdit と同じ variant の切り方。
  variant?: 'card' | 'compact'
}

export function DailyNewTargetField({
  examId,
  userId,
  variant = 'card',
}: DailyNewTargetFieldProps) {
  const inputId = useId()
  const errorId = useId()

  // exams mirror read-only レーン。
  // **useLiveQuery の undefined は「読込中」と「行が無い」の両方を意味する**ので、
  // 結果を 1 段包んで両者を分ける (包みが undefined = 読込中 / 包みの exam が
  // undefined = 行不在)。 読込中に既定表示 (空欄) のまま保存されると、 server の
  // 既存 K が null で上書きされる。
  const snapshot = useLiveQuery(
    async () => ({ exam: await getClientDb().exams.get(examId) }),
    [examId],
  )
  // **現在の K が読めていない間は保存させない**。 空欄は「既定へ戻す」を意味するので、
  // 現在値を知らないまま保存すると server の既存 K を null で潰す。
  // 読めていない = ① Dexie query が未解決、または ② 行が mirror に無い
  // (未 pull の deep link / IndexedDB クリア / 他端末で削除済)。
  // **初回 pull の settle シグナルは使えない**: あれは「成功/失敗を問わない終了」なので、
  // pull が失敗した端末では行が無いまま settle が立ち、②の窓が再び開く
  // (Codex r2 P1)。 行の実在そのものを条件にすれば両方の窓が閉じる。
  const notLoaded = snapshot === undefined || snapshot.exam === undefined
  // 行不在 (未 pull) と null (明示的な既定追従) は表示上は同義 — `??` で畳む
  // (`||` は 0 を潰すため不可)。
  const savedTarget = snapshot?.exam?.daily_new_target ?? null

  const [value, setValue] = useState<string>(() => toDisplay(savedTarget))
  // **最後に観測した mirror 値**。 表示中の確定値ではない (兼用にしてはいけない —
  // 保存成功時にここへ保存値を入れると「mirror が動いた」判定が偽になり、 mirror が
  // まだ旧値の間に保存値が旧値へ巻き戻る)。 ExamTitleInlineEdit の lastSyncedName と
  // 同型で、 追従するのは外部 (mirror) 側が動いた時だけ。
  const [lastMirror, setLastMirror] = useState<string>(() => toDisplay(savedTarget))
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // React 19 の "store info from previous renders" pattern: useEffect でなく render 中の
  // guarded setState (ExamTitleInlineEdit / option-row.tsx と同 pattern)。
  const nextMirror = toDisplay(savedTarget)
  if (nextMirror !== lastMirror) {
    // 観測値は追従の可否と無関係に必ず記録する (記録を怠ると、 保存後に mirror が
    // 追いついても「動いた」判定の基準が古いままになり以後の外部更新を取りこぼす)。
    setLastMirror(nextMirror)
    // 表示を差し替えるのは「入力が最後に観測した mirror と一致 = 未編集」かつ保存中で
    // ない時だけ。 保存直後は value(保存値) ≠ lastMirror(旧 mirror) なのでここに入らず、
    // pull が遅れても "保存しました" と表示が食い違わない。
    if (!pending && value === lastMirror) setValue(nextMirror)
  }

  const handleSave = async () => {
    setMessage(null)
    const trimmed = value.trim()
    // 空欄 = 既定へ戻す (null)。 空でなければ Number() で解析し、 妥当性の最終判定
    // (整数 / 0..999) は server action の zod に委ねる (二重実装しない)。
    const arg: number | null = trimmed === '' ? null : Number(trimmed)
    setPending(true)
    try {
      const result = await updateDailyNewTarget(examId, arg)
      if (!result.ok) {
        setMessage({ kind: 'err', text: result.error })
        return
      }
      // lastMirror は触らない (mirror はまだ旧値 — 上のコメント参照)。
      const display = toDisplay(arg)
      setValue(display)
      setMessage({ kind: 'ok', text: '保存しました' })
      // C: mirror 反映を最短化する明示 kick。 完全同期は次の自然 pull で収束する
      // (soft limit の受容範囲、 spec §8.3) — fire-and-forget で reject は握る。
      void runGuardedPull({ userId, reason: 'exam-daily-new-target' }).catch(() => {})
    } catch {
      // action の reject (offline / network 断 / server 例外) を inline error へ流す。
      setMessage({ kind: 'err', text: SAVE_REJECTED_MESSAGE })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={inputId} className="text-xs text-slate-600">
        新規/日
      </label>
      <Input
        id={inputId}
        type="number"
        inputMode="numeric"
        min={0}
        max={999}
        placeholder={String(DAILY_NEW_DEFAULT)}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          if (message) setMessage(null)
        }}
        disabled={pending || notLoaded}
        className="w-20 py-1"
        aria-label="新規/日の上限"
        aria-invalid={message?.kind === 'err' ? true : undefined}
        aria-describedby={message?.kind === 'err' ? errorId : undefined}
      />
      {variant === 'card' ? (
        <span className="text-xs text-slate-500">
          {notLoaded ? '読み込み中' : `空欄で既定 ${DAILY_NEW_DEFAULT} 問`}
        </span>
      ) : null}
      <Button
        type="button"
        size="sm"
        onClick={() => void handleSave()}
        disabled={pending || notLoaded}
      >
        保存
      </Button>
      {message && (
        <p
          id={message.kind === 'err' ? errorId : undefined}
          role={message.kind === 'err' ? 'alert' : 'status'}
          className={cn(
            'w-full text-xs',
            message.kind === 'err' ? 'text-red-600' : 'text-emerald-600',
          )}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
