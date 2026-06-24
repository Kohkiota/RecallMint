'use client'

// CustomSessionPreview — プレビュー一覧 (read-only)。cap 適用後の出題予定カードを
// 問題文・タグ・主要指標の 3 列で表示する (S2.3 T15 §11.2)。
//
// exam-card-table は exam_id 固定 + 編集重量で流用不可 (spec §11.2 確定)。
// タグ表示は色付き pill のみ (編集・削除導線なし)。
//
// perf 方針:
//   - customLimit が設定されている場合 → 全 rows を描画
//   - customLimit=null (無制限) AND rows.length > 50 → 先頭 50 件 + 「他 X 件」 注記
//     (400+ 件の DOM 描画は体感 lag を生むため段落とし)

// React import 不要 (jsx: react-jsx 自動ランタイム、 React.* 未使用)。
import type { CardWithTags } from '@/lib/cards/join-card-tags'
import { colorToClass } from '@/lib/tags/color-palette'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  rows: CardWithTags[]
  /** null = 上限なし。50 件超で degrade する境界判定に使う。 */
  customLimit: number | null
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

// 無制限モード時の描画上限 (これを超えると打ち切り + 注記)
const RENDER_CAP_WHEN_UNLIMITED = 50

// ---------------------------------------------------------------------------
// 純粋表示ヘルパー
// ---------------------------------------------------------------------------

function lastCorrectLabel(lastCorrect: boolean | null | undefined): string {
  if (lastCorrect === true) return '○'
  if (lastCorrect === false) return '×'
  return '—'
}

function lastCorrectClass(lastCorrect: boolean | null | undefined): string {
  if (lastCorrect === true) return 'text-green-600 font-medium'
  if (lastCorrect === false) return 'text-red-500 font-medium'
  return 'text-muted-foreground'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CustomSessionPreview({ rows, customLimit }: Props) {
  if (rows.length === 0) return null

  // 無制限モードで多数の行がある場合は先頭のみ描画して注記を付ける
  const isUnlimited = customLimit === null
  const exceedsRenderCap = isUnlimited && rows.length > RENDER_CAP_WHEN_UNLIMITED
  const visibleRows = exceedsRenderCap ? rows.slice(0, RENDER_CAP_WHEN_UNLIMITED) : rows
  const hiddenCount = rows.length - visibleRows.length

  return (
    <section aria-label="出題予定カード一覧" className="mt-4">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        出題予定カード ({rows.length} 件)
      </p>
      <div
        className="overflow-hidden rounded-lg border border-border"
        // 375px モバイルで水平 overflow が出ないよう親側で制御
      >
        <table className="w-full table-fixed text-xs">
          <colgroup>
            {/* 問題文: 残り幅を使う */}
            <col className="w-auto" />
            {/* タグ: 固定幅 */}
            <col className="w-28 sm:w-36" />
            {/* 連続正解数 */}
            <col className="w-10 sm:w-12" />
            {/* 直近正誤 */}
            <col className="w-10 sm:w-12" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-2 py-1.5 text-muted-foreground font-normal">問題文</th>
              <th className="px-2 py-1.5 text-muted-foreground font-normal">タグ</th>
              <th className="px-2 py-1.5 text-center text-muted-foreground font-normal" aria-label="連続正解数">
                連続
              </th>
              <th className="px-2 py-1.5 text-center text-muted-foreground font-normal" aria-label="直近正誤">
                直近
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ card, tags }, idx) => (
              <tr
                key={card.id}
                className={[
                  'border-b border-border last:border-0',
                  idx % 2 === 0 ? 'bg-background' : 'bg-muted/20',
                ].join(' ')}
              >
                {/* 問題文 */}
                <td className="px-2 py-1.5 align-top">
                  <p className="line-clamp-2 leading-snug">{card.question_text}</p>
                </td>

                {/* タグ (read-only pill 群) */}
                <td className="px-2 py-1.5 align-top">
                  <div className="flex flex-wrap gap-1">
                    {tags.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      tags.map(({ category, option }) => (
                        <span
                          key={`${category.id}-${option.id}`}
                          aria-label={`タグ: ${category.name}: ${option.name}`}
                          className={[
                            'inline-block rounded-full border px-1.5 py-0.5 text-xs leading-none',
                            colorToClass(option.color),
                          ].join(' ')}
                        >
                          {option.name}
                        </span>
                      ))
                    )}
                  </div>
                </td>

                {/* 連続正解数 */}
                <td className="px-2 py-1.5 text-center align-top tabular-nums">
                  {card.current_streak}
                </td>

                {/* 直近正誤 */}
                <td
                  className={[
                    'px-2 py-1.5 text-center align-top',
                    lastCorrectClass(card.last_correct),
                  ].join(' ')}
                >
                  {lastCorrectLabel(card.last_correct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 無制限モードで 50 件超の場合の degrade 注記 */}
        {exceedsRenderCap && (
          <p
            data-testid="preview-hidden-note"
            className="border-t border-border bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground"
          >
            他 {hiddenCount} 件（プレビュー省略）
          </p>
        )}
      </div>
    </section>
  )
}
