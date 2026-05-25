'use client'

// 試験詳細 page (/app/exams/[id]) の選択肢 inline 編集。
//
// 構造 (S2.0b-2 follow-up 修正で per-card 親 `InlineOptionList` に options state を
// lift up、 cross-row checkbox race を構造的に解消):
//
// - `InlineOptionList` (export): card 単位の親。 options 配列 (state) + send / queue /
//   debounce / mountedRef / serverCommittedRef / per-checkbox inFlight を集約。
//   全 row の payload 構築は **共有 options state の snapshot** で行うため、 user が
//   row 0 → row 1 → row 2 と高速連打しても各送信 payload は累積した最新状態を反映する
//   (旧実装は row 毎に allOptionsRef を保持し他 row の楽観値を見落としていた、 結果
//   「最後の 1 つだけ ON」 になる cross-row race を起こしていた)。
// - `InlineOptionRow` (un-export、 同 file 内 internal): controlled view。 内部 state
//   は cell の edit (editing / editValue) のみ。 送信機構は持たず callback
//   (onCheckboxToggle / onCellSave) で親に委譲。 'use client' top-level export は
//   serializable props 制約があり function callback prop は警告を出すため、 親
//   `InlineOptionList` のみを export し本 row は file-private で扱う。
//
// 送信 contract (親で集中管理):
// - id / text / explanation cell の blur: **500ms debounce** 後に send (連続編集は
//   timer reset で最後の値のみ)。 送信中 (inFlightRef=true) に来た新値は queue に
//   入り 1 並列を維持、 1 完走後に最新 snapshot で連鎖 send。
// - checkbox change: **debounce なし即時 send**。 進行中 text 編集 timer は cancel し、
//   text 楽観値は既に options state に反映済のため checkbox 送信 payload に同梱される。
// - 失敗時: options を `serverCommittedRef.current` に **全 row rollback** + inline
//   error。 queue は破棄して連続失敗 storm を防ぐ。
//
// StrictMode (`reactStrictMode: true` 開発時の effect setup → cleanup → setup 二重
// 実行) 対応: mountedRef は setup で **true reset** する。 reset しないと初回 cleanup
// 後 false 固定で send 内 setState が全 skip され rollback / error が dev 環境で動かない
// (jsdom test は `<StrictMode>` wrap 時のみ再現)。
//
// 並行 server update / OCC 検出は MVP scope 外 (v1.x で etag 検討、 S2.0b-1 既知制約
// を継承)。
//
// 既知制約 (MVP UX として許容):
// - revalidate (server からの prop 更新) は serverCommittedRef を信頼源として
//   options を上書きする。 in-flight / queue 中は skip (= 楽観値を保護) するが、 既に
//   送信成功した row の値で server から新 prop が来た場合、 他 row の **未確定楽観値も
//   同時に rollback されない** ように `setOptions(serverOptions)` は skip 条件付き。
//
// Ghost row (S2.0b-3 + follow-up merge fix):
// - 「+ 選択肢を追加」 で local state に追加された text='' の optimistic row。 server
//   zod `optionSchema.text.refine(.trim().length > 0)` で reject されるため、 send
//   payload からは必ず filter する (`send` 入口の sanitized)。 local state には残し、
//   user の編集中値 (cell editValue) を保護する。
// - ghost 放置のまま user が無関係な操作 (別 row checkbox toggle / cell 編集 blur /
//   delete) をした場合: 操作元 handler は ghost を含む snapshot を send に渡すが、
//   filter で除外されて server に届かず、 別 row の変更だけが反映される (= bug 回避)。
// - ghost に text 入力 + blur が来ると ghost の text が valid 化、 sanitized に
//   含まれて server 反映 → 通常 option に昇格。
// - revalidate (serverOptions prop 変化) では `useEffect([serverOptions])` が **merge
//   戦略** で同期し、 server 確定値 + 「serverOptions に id がない local ghost」 を
//   保持する。 これにより別 row の send 成功で起きる revalidate でも local の ghost
//   が evict されない (旧実装は一括 setOptions(serverOptions) で ghost を含めて
//   replace していたため、 「user が ghost を編集中に他 send が走ると ghost が消える」
//   bug があった、 S2.0b-3 follow-up fix で解消)。
// - 明示削除 (× button) は通常 row と同じ経路、 ghost を含む全 row 削除可能。
// - 不要 ghost の cleanup: page reload / navigation で local state は破棄、 server
//   は ghost を知らないため再表示なし。

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { CardOption } from '@/lib/db/schema'
import { nextOptionId } from '@/lib/cards/next-option-id'
import { updateCardField } from '../_actions/update-card-field'

// snake_case CardOption → camelCase (zod optionSchema が期待する形)。
// server 側 buildSetClause が camelCase → snake_case に戻す。
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

// ============================================================================
// InlineOptionList (per-card parent)
// ============================================================================

type InlineOptionListProps = {
  cardId: string
  options: CardOption[]
}

export function InlineOptionList({
  cardId,
  options: serverOptions,
}: InlineOptionListProps) {
  // 表示 + payload 構築の真実 source (全 row 共有)。
  const [options, setOptions] = useState<CardOption[]>(serverOptions)
  const [error, setError] = useState<string | null>(null)
  // checkbox 個別 inFlight (UI 上、 該当 checkbox のみ disabled で text/explanation
  // cell は edit 可能 = spec §3.3 D)。
  const [checkboxInFlightByIdx, setCheckboxInFlightByIdx] = useState<
    Record<number, boolean>
  >({})
  // S2.0b-3: 「+ 選択肢を追加」 直後に new row の text cell を自動で編集モード化する
  // ための one-shot marker。 設定された option.id の text cell が初回 mount 時に
  // editing=true で起動 (`InlineOptionCell.autoEditOnMount`)。 cell の useState
  // initializer は mount 時のみ評価されるので、 一度 marker が消費された (= cell が
  // 既に mount 済) 後に同 id が残っていても再 enter しない。 削除→再追加で同 id が
  // 採番されて新 cell が再 mount された場合は再度 auto-edit する (= 期待挙動)。
  const [autoEditOptionId, setAutoEditOptionId] = useState<string | null>(null)

  // server 確定値 (rollback target)。
  const serverCommittedRef = useRef<CardOption[]>(serverOptions)
  // 並列制御 (送信は 1 並列 + queue 深さ 1 で上書き)。
  const inFlightRef = useRef<boolean>(false)
  const pendingPayloadRef = useRef<CardOption[] | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef<boolean>(true)
  // options state を closure ではなく ref 経由で参照するための同期 ref。
  // render 毎に assign することで send / handleCellSave / handleCheckboxToggle が
  // 常に最新 options を読める。
  const optionsRef = useRef<CardOption[]>(options)
  optionsRef.current = options

  // 親再 fetch (revalidate) で serverOptions が変わったら state / serverCommittedRef
  // を同期。 send / queue 中は skip し楽観値を保護する。
  //
  // S2.0b-3 follow-up fix (連続追加 2 つ目が消える bug):
  // 旧実装は `setOptions(serverOptions)` で local を一括上書きしていたが、 これは
  // 「+ 選択肢を追加」 で local に追加された ghost (= server に存在しない、 text=''
  // で未 commit な optimistic row) を 別 row の send 成功で起きる revalidate でも
  // 静かに evict してしまう (= 「user が編集中の ghost が突然消える」 bug)。
  // 修正: server に存在しない local ghost (id が serverOptions にない row) を保持
  // した merge 戦略に変更。
  // - serverOptions: 確定値、 そのまま全件取り込み
  // - local ghost: serverOptions に id がない row だけ抽出して末尾に append
  // serverCommittedRef は server 確定値のみ (ghost 含まず) を維持し、 send 失敗時の
  // rollback / send 入口の shallowEqual 比較ベースとして純粋に保つ。 optionsRef は
  // merged を反映し、 次の send が ghost を含む snapshot を build できるようにする
  // (send 入口の filter で ghost は payload から除外される、 既存の防御は不変)。
  useEffect(() => {
    if (inFlightRef.current || pendingPayloadRef.current !== null) return
    const serverIds = new Set(serverOptions.map((o) => o.id))
    const localGhosts = optionsRef.current.filter((o) => !serverIds.has(o.id))
    const merged: CardOption[] = [...serverOptions, ...localGhosts]
    setOptions(merged)
    serverCommittedRef.current = serverOptions
    optionsRef.current = merged
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverOptions])

  // StrictMode 対応: setup で mountedRef=true reset、 cleanup で false + timer clear。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [])

  const send = async (target: CardOption[]): Promise<void> => {
    // S2.0b-3: text 空 ghost option (「+ 選択肢を追加」 後 user が typing せず残った
    // optimistic row) は server zod `optionSchema.text.refine(.trim().length > 0)` で
    // 必ず reject される。 ghost を server payload に混ぜると、 別 row の checkbox
    // toggle / cell 編集 send 等で全 row rollback が誘発され、 user の意図した変更も
    // 失われ「無関係な error alert」 が出る。 そのため send 入口で ghost を payload
    // から filter する (local state には残す = user の編集中値保護、 ghost 自体は次の
    // revalidate (in-flight 解消後の useEffect 同期) で消える spec 想定通り)。
    const sanitized = target.filter((o) => o.text.trim().length > 0)
    // sanitized が空 (全 row ghost) なら server に送る意味なし
    if (sanitized.length === 0) return

    // in-flight 中: 「serverCommittedRef との一致」 で short-circuit すると、 in-flight
    // 完走後に serverCommittedRef が新値に更新される race で 「revert payload が同値判定
    // で消える」 lost-write を起こす (T2 で発覚した revert-during-inflight 必須 #2)。
    // よって in-flight 中は無条件で queue 入り、 queue 消化時の recursive send で改めて
    // shallowEqual 判定する設計を維持する。
    if (inFlightRef.current) {
      pendingPayloadRef.current = sanitized
      return
    }

    // NOT in-flight: sanitized が server-committed と一致なら no-op (network 節約、
    // ghost 単独 blur で空 send を抑止、 通常 cell の値変更なし blur も同じ経路)。
    if (shallowEqualOptions(sanitized, serverCommittedRef.current)) return

    inFlightRef.current = true
    const payload: ZodOption[] = sanitized.map(toZodOption)
    const result = await updateCardField(cardId, 'options', payload)
    inFlightRef.current = false

    if (!mountedRef.current) return

    if (!result.ok) {
      // 失敗 → 全 row rollback、 queue 破棄 (連続失敗 storm 防止)。
      // rollback target は serverCommittedRef (= ghost を含まない最新 server 確定値)。
      setError(result.error)
      setOptions(serverCommittedRef.current)
      optionsRef.current = serverCommittedRef.current
      pendingPayloadRef.current = null
      return
    }

    serverCommittedRef.current = sanitized

    if (pendingPayloadRef.current !== null) {
      const next = pendingPayloadRef.current
      pendingPayloadRef.current = null
      // queue 連鎖 send は await する: checkbox onChange handler が完走を待たないと
      // checkboxInFlight を解除できないため (旧 InlineOptionRow と同じ仕様)。
      // pendingPayloadRef は上書き運用で深さ 1 固定のため、 await chain は microtask
      // 経由で 1 promise link しか積まず stack / memory リスクなし。
      await send(next)
    }
  }

  const scheduleSend = (target: CardOption[]) => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void send(target)
    }, DEBOUNCE_MS)
  }

  // cell blur 経由の保存 (id / text / explanation)。 idx で row 特定、 nextOption は
  // cell が組み立てた CardOption (= 元 option を該当 field のみ書換えたもの)。
  const handleCellSave = (idx: number, nextOption: CardOption) => {
    const nextAll = optionsRef.current.slice()
    nextAll[idx] = nextOption
    const noPendingWork =
      !inFlightRef.current && pendingPayloadRef.current === null
    if (noPendingWork && shallowEqualOptions(nextAll, serverCommittedRef.current)) {
      // server に投げる必要なし。 state / error も触らない (display 一致のため)
      return
    }
    setOptions(nextAll)
    optionsRef.current = nextAll
    setError(null)
    scheduleSend(nextAll)
  }

  // checkbox 即時送信: 進行中 text 編集の debounce timer は cancel (text 楽観値は
  // 既に options state に反映済のため、 nextAll snapshot に自動同梱される)。
  // 同 row の checkbox 連打は disabled で 1 度に 1 度のみ受付、 別 row への click は
  // queue 経由で順次 1 並列 send。
  const handleCheckboxToggle = async (idx: number, nextChecked: boolean) => {
    if (checkboxInFlightByIdx[idx]) return // UI 上 disabled で到達しないはず
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    const nextAll = optionsRef.current.slice()
    nextAll[idx] = { ...nextAll[idx]!, is_correct: nextChecked }
    setOptions(nextAll)
    optionsRef.current = nextAll
    setError(null)
    setCheckboxInFlightByIdx((m) => ({ ...m, [idx]: true }))
    await send(nextAll)
    if (mountedRef.current) {
      setCheckboxInFlightByIdx((m) => ({ ...m, [idx]: false }))
    }
  }

  // S2.0b-3 「+ 選択肢を追加」: 新規 option を optimistic に末尾追加 + auto-edit
  // marker をセットして text cell を即編集 mode に。 server send は呼ばない
  // (text='' は optionSchema の `.refine(s.trim().length > 0)` で reject されるため、
  // 即時 send すると server error rollback で option が消える)。 user の text 入力
  // → blur で handleCellSave 経由の通常 debounce + send にのせる。 user が typing
  // 前に放置した optimistic ghost は次の revalidate (in-flight 無し時) で消える設計
  // (= 「commit してない」 状態なので消えるのが正しい)。
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
    setError(null)
    setAutoEditOptionId(newId)
  }

  // S2.0b-3 削除: optimistic 即時除去 + send。 失敗時は send が全 row rollback
  // (= 削除した option も復活)。 options.length === 1 の case は UI 上 button が
  // disabled で到達しないが、 server zod `min(1)` を defensive に local でも判定。
  const handleDeleteOption = async (idx: number) => {
    if (optionsRef.current.length <= 1) return
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    const nextAll = optionsRef.current.filter((_, i) => i !== idx)
    setOptions(nextAll)
    optionsRef.current = nextAll
    setError(null)
    await send(nextAll)
  }

  const canDelete = options.length > 1

  // S2.0b-3: 選択肢 count + 正解サマリは InlineOptionList 内で render。 親 InlineCardList
  // が server props 由来で表示すると revalidate (~200ms) まで lag が出るが、 ここで
  // optimistic `options` state から計算することで checkbox toggle と同時即時更新される。
  // 正解 0 件 (全 is_correct=false) はサマリ要素自体を hide。
  const correctIds = options.filter((o) => o.is_correct).map((o) => o.id)

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">
          選択肢 ({options.length} 件)
        </p>
        {correctIds.length > 0 && (
          <p className="text-base font-medium text-emerald-700">
            ○ 正解: {correctIds.join(', ')}
          </p>
        )}
      </div>
      <ul className="mt-1 space-y-1.5">
        {options.map((opt, idx) => (
          <li key={opt.id}>
            <InlineOptionRow
              option={opt}
              checkboxInFlight={!!checkboxInFlightByIdx[idx]}
              autoEditTextOnMount={opt.id === autoEditOptionId}
              canDelete={canDelete}
              onCheckboxToggle={(nextChecked) =>
                handleCheckboxToggle(idx, nextChecked)
              }
              onCellSave={(nextOption) => handleCellSave(idx, nextOption)}
              onDelete={() => handleDeleteOption(idx)}
            />
          </li>
        ))}
      </ul>
      {/* S2.0b-3 「+ 選択肢を追加」 ボタン。 list 末尾に常時 dashed border で表示。 */}
      <button
        type="button"
        onClick={handleAddOption}
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        + 選択肢を追加
      </button>
      {/* error は per-card 親レベルで 1 度だけ render (送信は 1 並列のため同時 2 件の
          失敗は発生しえない、 共有表示で UX 上も矛盾なし)。 旧実装は row 内に置いていた
          が、 lift-up 後は alert 多重 hit を避けるため list 直下に集約。 */}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}

// ============================================================================
// InlineOptionRow (controlled view, presentational)
// ============================================================================

type InlineOptionRowProps = {
  option: CardOption
  checkboxInFlight: boolean
  // S2.0b-3: 「+ 選択肢を追加」 直後に new row の text cell を auto-edit するための
  // marker。 InlineOptionCell の useState initializer に渡って mount 時のみ有効。
  autoEditTextOnMount: boolean
  // options.length === 1 の row では削除 button を disabled に。
  canDelete: boolean
  onCheckboxToggle: (nextChecked: boolean) => void
  onCellSave: (nextOption: CardOption) => void
  onDelete: () => void
}

// 内部実装: server boundary を跨いで使われないため、 function callback props を
// 安全に取れる (= 'use client' top-level export 制約を回避するため un-export 化)。
// テストでは `InlineOptionList` 経由で render する。 error は list level に集約済の
// ため row props には載せない。
//
// レイアウト (S2.0b-3): CSS Grid で 1 つの explanation cell instance を viewport で
// 配置場所だけ切替える。 二重 render を避けて editing / editValue 状態の divergence
// を防ぐ。
// - Mobile (md 未満): 4 列 grid `[auto / 5rem / 1fr / auto]`
//     row 1: [✓] [id] [本文] [削除]
//     row 2: [解説 col-span-full]
// - Desktop (md 以上): 5 列 grid `[auto / 5rem / 1fr / 1fr / auto]`
//     row 1: [✓] [id] [本文] [解説] [削除]
// explanation は mobile で row-start-2 col-span-full、 desktop で md:row-start-1
// md:col-start-4 md:col-span-1 と explicit 配置。 delete は mobile で auto-flow
// (row 1 col 4)、 desktop で md:col-start-5 と explicit。
function InlineOptionRow({
  option,
  checkboxInFlight,
  autoEditTextOnMount,
  canDelete,
  onCheckboxToggle,
  onCellSave,
  onDelete,
}: InlineOptionRowProps) {
  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onCheckboxToggle(e.target.checked)
  }

  return (
    <div
      className={
        option.is_correct
          ? 'rounded border border-emerald-300 bg-emerald-100 p-2 text-sm'
          : 'rounded border border-border/60 p-2 text-sm'
      }
    >
      <div className="grid items-start gap-2 grid-cols-[auto_5rem_minmax(0,1fr)_auto] md:grid-cols-[auto_5rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            aria-label="選択肢 正解フラグ 編集"
            checked={option.is_correct}
            disabled={checkboxInFlight}
            onChange={handleCheckboxChange}
            className="h-6 w-6 cursor-pointer accent-emerald-600"
          />
        </label>
        <div>
          <InlineOptionCell
            kind="id"
            ariaLabel="選択肢 id 編集"
            value={option.id}
            onSave={(value) => onCellSave({ ...option, id: value })}
            displayClassName="text-sm font-mono text-slate-700"
            placeholder="(id)"
          />
        </div>
        <div className="min-w-0">
          <InlineOptionCell
            kind="text"
            ariaLabel="選択肢 本文 編集"
            value={option.text}
            onSave={(value) => onCellSave({ ...option, text: value })}
            displayClassName={
              option.is_correct
                ? 'text-sm font-bold text-emerald-900'
                : 'text-sm text-slate-800'
            }
            autoEditOnMount={autoEditTextOnMount}
          />
        </div>
        {/* explanation: mobile = row 2 全幅 / desktop = row 1 col 4 単独 */}
        <div className="row-start-2 col-span-full min-w-0 md:row-start-1 md:col-start-4 md:col-span-1">
          <InlineOptionCell
            kind="explanation"
            ariaLabel="選択肢 解説 編集"
            value={option.explanation ?? ''}
            onSave={(value) => {
              // 空文字は jsonb から explanation key を drop する (payload bloat 防止、
              // server zod は optional)。
              if (value === '') {
                const { explanation: _drop, ...rest } = option
                onCellSave(rest)
              } else {
                onCellSave({ ...option, explanation: value })
              }
            }}
            displayClassName="text-xs text-slate-600"
            placeholder="解説 (クリックで追加)"
          />
        </div>
        {/* delete: mobile = row 1 col 4 (auto-flow) / desktop = row 1 col 5 (explicit) */}
        <button
          type="button"
          aria-label="選択肢を削除"
          onClick={onDelete}
          disabled={!canDelete}
          className="md:col-start-5 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
        >
          <span className="text-xl leading-none" aria-hidden="true">
            ×
          </span>
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// InlineOptionCell (cell-level editing primitive)
// ============================================================================

type InlineOptionCellProps = {
  kind: 'id' | 'text' | 'explanation'
  ariaLabel: string
  value: string // row の option から派生する display 値 (props 化)
  onSave: (value: string) => void
  displayClassName?: string
  placeholder?: string
  // S2.0b-3: 「+ 選択肢を追加」 直後に new row の text cell を mount 即 edit にする
  // ための one-shot marker。 useState initializer のみ参照し、 mount 後は無視 (= 親
  // が後から true → false に変えても影響しない、 また cell の通常 blur で editing
  // 状態が false に戻った後も同様)。
  autoEditOnMount?: boolean
}

// 表示値は props.value (row の option) を使い、 cell は edit 中の editValue / editing
// のみ持つ。 error は親 (InlineOptionList) に集約。
//
// レイアウト (`InlineTextField` と同方針): display / edit の box 寸法 (border-box +
// padding + 1px border + radius + min-height + width) を完全一致させて edit 切替時の
// layout shift を防ぐ。 multiline (text / explanation) は rows 固定値を使わず
// `useLayoutEffect` で scrollHeight に追従させて auto-resize。 縮む下限は min-h-11 が
// CSS lower bound として効く。
function InlineOptionCell({
  kind,
  ariaLabel,
  value,
  onSave,
  displayClassName,
  placeholder = '(クリックで追加)',
  autoEditOnMount = false,
}: InlineOptionCellProps) {
  const [editValue, setEditValue] = useState<string>(value)
  // initializer は mount 時のみ評価 (subsequent prop change は無視)。 これにより
  // 「+ 追加」 で marker が立った状態で mount された cell のみ最初から editing=true、
  // 既存 cell に後から marker が当たっても挙動変化なし、 cell の blur で editing=false
  // に戻った後も再 edit しない (one-shot 性)。
  const [editing, setEditing] = useState<boolean>(() => autoEditOnMount)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  // 編集中でなければ props.value (= 親 options[idx]) を editValue に同期する。
  // 編集中は user 入力を保護。
  useEffect(() => {
    if (editing) return
    setEditValue(value)
  }, [value, editing])

  // multiline textarea の auto-resize: 編集中 + editValue 変化に追従して scrollHeight に
  // 合わせる。 useLayoutEffect で paint 前に同期実行 (initial mount の 1 frame flicker
  // 回避)。 縮む方向は min-h-11 が CSS lower bound として効くため display モードと
  // 同じ最小高さ。 jsdom では scrollHeight が常に 0 だが、 inline style assign の事実は
  // test で lock する (`InlineTextField` と同パターン)。
  // single-line input (kind='id') では `el instanceof HTMLTextAreaElement` 判定で
  // no-op になり安全。
  useLayoutEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (!(el instanceof HTMLTextAreaElement)) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editing, editValue])

  const startEdit = () => {
    setEditing(true)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      startEdit()
    }
  }

  const handleBlur = () => {
    setEditing(false)
    // debounce / queue / short-circuit 判定は全て親 (handleCellSave) で実施。
    onSave(editValue)
  }

  const multiline = kind !== 'id'

  // display / edit で共通の box 寸法 (`InlineTextField` の sharedBoxChrome と同じ値)。
  // textarea / input の default `rounded-lg px-3 py-2 text-base` は cn() / twMerge で
  // `p-2 rounded-md + displayClassName 由来 font` に上書き。 display 側は
  // `border border-transparent` で textarea の見える 1px border 分を予約する (1px
  // shift 防止)。
  const sharedBoxChrome = 'block w-full min-h-11 rounded-md p-2'

  if (editing) {
    const commonProps = {
      'aria-label': ariaLabel,
      value: editValue,
      onChange: (
        e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => setEditValue(e.target.value),
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
            // rows 固定値は使わない (useLayoutEffect が scrollHeight 追従で auto-resize)。
            // resize-none + overflow-hidden で手動 resize handle と scrollbar を抑止。
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

  const isEmpty = value.length === 0
  return (
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
        <span className="whitespace-pre-wrap break-words">{value}</span>
      )}
    </div>
  )
}
