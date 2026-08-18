// selected-exam — 選択中試験の解決 resolver(Dash-1 Home v1 Task 5・spec §6)。
//
// PURE 制約: import ゼロ・I/O なし。 URL / sync_meta から読み済みの値を受け取り決定を
// 返すだけで、 URL 書換・sync_meta 書込は一切行わない(それは唯一の呼出側
// `use-selected-exam.ts` の責務 — spec §6「解決ロジックは 1 関数に置き、 副作用は
// 呼出側」)。 lib/dashboard/domain/** の純粋性 eslint block は domain/ の外にある
// 本 module には及ばないが、 import ゼロを保つことで Dexie/React なしに独立して
// テストできる利点は変わらず追求する。
//
// 解決順(spec §6・4 段):
//   ① URL の exam id が現存 exam(owner scope)に実在 → 採用(source: 'url')
//   ② else 保存値(sync_meta)が実在 → 採用(source: 'stored')
//   ③ else 試験がちょうど 1 件 → 自動採用(source: 'single')
//   ④ else → 選択不能(selection-required。 home の試験選択 UI へ)
// 各段で無効 ID(uuid 形式でない / 現存 exam に無い — 削除済み・他 owner 等)は
// 破棄して次の段へ進む。 「有効な URL 値を保存値が上書きすることはない」(spec §6の
// 不変条件)は ① が ② より必ず先に判定されることで構造的に保証される。

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

export type SelectedExamSource = 'url' | 'stored' | 'single'

export type SelectedExamResolution =
  | {
      readonly outcome: 'resolved'
      readonly examId: string
      readonly source: SelectedExamSource
      /** true なら URL の `exam` param を examId へ書き換える必要がある。 */
      readonly urlNeedsUpdate: boolean
      /** true なら sync_meta の保存値を examId へ書き換える必要がある。 */
      readonly storeNeedsUpdate: boolean
    }
  | {
      readonly outcome: 'selection-required'
      /** true なら URL に残った無効値を除去する必要がある(絶対不在なら false)。 */
      readonly urlNeedsUpdate: boolean
    }

export interface ResolveSelectedExamInput {
  /**
   * 現在の URL の `exam` query param(未指定は undefined)。
   * caller 側の事前検証(zod 等)は前提にしない — resolver 自身が uuid 形式を検証する。
   */
  readonly urlExamId: string | undefined
  /** sync_meta に保存されている選択値(未保存 / 破損読取は undefined)。 */
  readonly storedExamId: string | undefined
  /** owner scope の現存 exam id 一覧(呼出側が Dexie mirror から渡す)。 */
  readonly examIds: readonly string[]
}

export function resolveSelectedExam(
  input: ResolveSelectedExamInput,
): SelectedExamResolution {
  const { urlExamId, storedExamId, examIds } = input
  const validIds = new Set(examIds)

  // ① URL
  if (urlExamId !== undefined && isUuid(urlExamId) && validIds.has(urlExamId)) {
    return {
      outcome: 'resolved',
      examId: urlExamId,
      source: 'url',
      urlNeedsUpdate: false,
      storeNeedsUpdate: storedExamId !== urlExamId,
    }
  }

  // ② 保存値
  if (
    storedExamId !== undefined &&
    isUuid(storedExamId) &&
    validIds.has(storedExamId)
  ) {
    return {
      outcome: 'resolved',
      examId: storedExamId,
      source: 'stored',
      urlNeedsUpdate: urlExamId !== storedExamId,
      storeNeedsUpdate: false,
    }
  }

  // ③ ちょうど 1 件
  if (examIds.length === 1) {
    const onlyId = examIds[0]
    return {
      outcome: 'resolved',
      examId: onlyId,
      source: 'single',
      urlNeedsUpdate: urlExamId !== onlyId,
      storeNeedsUpdate: storedExamId !== onlyId,
    }
  }

  // ④ 選択不能。 URL に(無効な)値が残っていれば正規化(除去)が要る。
  return {
    outcome: 'selection-required',
    urlNeedsUpdate: urlExamId !== undefined,
  }
}
