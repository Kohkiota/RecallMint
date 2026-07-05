// card-filter-predicates — ExamCardTable のフィルタ評価ロジック (純関数)。
// Grid-2 T3。 副作用なし・component 非依存 = unit test しやすいよう component と分離。
//
// 3 種のフィルタ:
//   - tag フィルタ (matchesTagFilter): カテゴリ内 OR / カテゴリ間 AND。
//   - 回答状態フィルタ (matchesAnswerState): all / unanswered / correct / incorrect の相互排他 4 値。
//   - 数値比較フィルタ (matchesStreakFilter): current_streak の lte / gte / eq 比較。
//
// これらは TanStack Table の filterFn から呼ばれる (exam-card-table-columns.tsx)。

// ---------------------------------------------------------------------------
// tag フィルタ
// ---------------------------------------------------------------------------

/** { [categoryId]: optionId[] }。 空配列カテゴリ・空 map は「絞り込みなし」。 */
export type TagFilterValue = Record<string, string[]>

/**
 * tag フィルタ評価。
 * filter の各 categoryId について、 optionId 配列が非空なら
 * tags が「その category 内のいずれかの option を持つ」(カテゴリ内 OR) こと。
 * 全 categoryId で true なら pass (カテゴリ間 AND)。
 * 空配列カテゴリ・空 filter は pass (絞り込みなし)。
 */
export function matchesTagFilter(
  tags: Array<{ category: { id: string }; option: { id: string } }>,
  filter: TagFilterValue,
): boolean {
  for (const [categoryId, optionIds] of Object.entries(filter)) {
    if (optionIds.length === 0) continue // 空カテゴリ = 絞り込みなし
    const hit = tags.some(
      (t) => t.category.id === categoryId && optionIds.includes(t.option.id),
    )
    if (!hit) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 回答状態フィルタ (AS-1)
// ---------------------------------------------------------------------------

/** 相互排他 4 値。 'all' = 絞り込みなし。 */
export type AnswerStateFilter = 'all' | 'unanswered' | 'correct' | 'incorrect'

/**
 * 回答状態フィルタ評価。
 *   all       → 常に true
 *   unanswered→ card.answered === false
 *   correct   → card.last_correct === true
 *   incorrect → card.last_correct === false
 */
export function matchesAnswerState(
  card: { answered: boolean; last_correct?: boolean | null },
  state: AnswerStateFilter,
): boolean {
  switch (state) {
    case 'all':
      return true
    case 'unanswered':
      return card.answered === false
    case 'correct':
      return card.last_correct === true
    case 'incorrect':
      return card.last_correct === false
  }
}

// ---------------------------------------------------------------------------
// 数値比較フィルタ (N-1)
// ---------------------------------------------------------------------------

/** 当面 UI は 'lte' のみ提供でも、 純関数は 3 種対応。 */
export type StreakFilterOp = 'lte' | 'gte' | 'eq'

export type StreakFilterValue = { op: StreakFilterOp; value: number }

/**
 * 連続正解数の数値比較フィルタ評価。
 * filter が null/undefined → true (絞り込みなし)。
 * value が NaN → true (未入力扱い)。
 *   lte → streak <= value / gte → streak >= value / eq → streak === value
 */
export function matchesStreakFilter(
  streak: number,
  filter: StreakFilterValue | null | undefined,
): boolean {
  if (!filter) return true
  if (Number.isNaN(filter.value)) return true
  switch (filter.op) {
    case 'lte':
      return streak <= filter.value
    case 'gte':
      return streak >= filter.value
    case 'eq':
      return streak === filter.value
  }
}

// ---------------------------------------------------------------------------
// 試験フィルタ (S2.3 custom-session T2)
// ---------------------------------------------------------------------------

/**
 * 試験フィルタ評価 (IN 絞り込み、複数試験 = OR)。
 * examIds が空配列 → true (絞り込みなし)。
 * 非空 → card.exam_id が examIds のいずれかと一致すれば true。
 */
export function matchesExamFilter(
  card: { exam_id: string },
  examIds: string[],
): boolean {
  if (examIds.length === 0) return true // 空 = 絞り込みなし
  return examIds.includes(card.exam_id)
}

// ---------------------------------------------------------------------------
// テキスト比較フィルタ (S4-1)
// ---------------------------------------------------------------------------

/** Notion 式テキスト演算子 8 種。 */
export type TextFilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'empty'
  | 'notEmpty'

/** テキストフィルタ値。 op と検索文字列のペア。 */
export type TextFilterValue = { op: TextFilterOp; value: string }

/**
 * empty / notEmpty のみ true (値不使用演算子)。
 * 値必須演算子 (eq / neq / contains / notContains / startsWith / endsWith) は false。
 */
export function isValuelessTextOp(op: TextFilterOp): boolean {
  return op === 'empty' || op === 'notEmpty'
}

/**
 * テキストフィルタ評価 (spec D-1)。
 * - filter が null/undefined → true (絞り込みなし)。
 * - セル正規化: raw ?? '' が trim()=='' なら ''、それ以外は原文維持(前後空白を削らない)。
 * - empty / notEmpty は値不使用 (filter.value は無視)。
 * - 値必須 op で filter.value.trim()=='' → true (全行通過)。
 * - 比較は両辺 toLowerCase のみ (全角/半角・かな/カナは対象外)。
 * - 否定演算子 (neq / notContains) が空セルを通すのは正規化→演算子適用の順序で自然に成立。
 */
export function matchesTextFilter(
  raw: string | null | undefined,
  filter: TextFilterValue | null | undefined,
): boolean {
  if (!filter) return true

  // セル正規化: null/undefined → ''、空白のみ → ''、それ以外は原文維持
  const base = raw ?? ''
  const normalized = base.trim() === '' ? '' : base

  // 値不使用演算子
  if (filter.op === 'empty') return normalized === ''
  if (filter.op === 'notEmpty') return normalized !== ''

  // 値必須演算子: 検索値が空(空白のみ含む)なら全行通過
  if (filter.value.trim() === '') return true

  // 比較: 両辺 toLowerCase (大文字小文字のみ正規化)
  const cell = normalized.toLowerCase()
  const val = filter.value.toLowerCase()

  switch (filter.op) {
    case 'eq':
      return cell === val
    case 'neq':
      return cell !== val
    case 'contains':
      return cell.includes(val)
    case 'notContains':
      return !cell.includes(val)
    case 'startsWith':
      return cell.startsWith(val)
    case 'endsWith':
      return cell.endsWith(val)
  }
}
