// exam list helpers — server-side query 群。 `getDb` を import するため server 限定。
//
// client component から本 module の値 (関数) を import すると bundler が
// drizzle / postgres-js / fs / net / tls まで client 側に巻き込んでビルド失敗する。
// `import 'server-only'` で build 時に loud に失敗させる。
// client から使いたい「経過時間 format」 や `ActiveExam` 型は `./format` を参照する。
//
// MVP では archived_at IS NULL の exam 一覧を updated_at DESC で取る。
// archived UX 詳細 (一覧で archived を表示するか / 復元 button 等) は S2 で確定。

import 'server-only'

import { and, desc, eq, isNull } from 'drizzle-orm'
import { cards, exams, sourceDocuments, type CardOption } from '@/lib/db/schema'
import type { TenantDb } from '@/lib/db/tenant-tx'
import type { ClientCardImage } from '@/lib/client-db'

// 既存 importer (server pages) が `@/lib/exams/list` から ActiveExam / formatRelativeJa
// を引いている経路を壊さないよう re-export する。 新規 client から使う場合は
// `@/lib/exams/format` を直接 import すること。
export { formatRelativeJa, type ActiveExam } from './format'
import type { ActiveExam } from './format'

export async function getActiveExamsForUser(
  userId: string,
  dbc: TenantDb,
): Promise<ActiveExam[]> {
  const db = dbc
  const rows = await db
    .select({
      id: exams.id,
      name: exams.name,
      updatedAt: exams.updatedAt,
    })
    .from(exams)
    .where(and(eq(exams.userId, userId), isNull(exams.archivedAt)))
    .orderBy(desc(exams.updatedAt))
  return rows
}

// S1.7 T7 用: 詳細 page で exam + その user の所有確認をしつつ archived 状態も取る。
// 不在 / 他 user の場合は null を返す (詳細 page 側で notFound() に変換)。
export type ExamDetail = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}
export async function getExamByIdForUser(
  userId: string,
  examId: string,
  dbc: TenantDb,
): Promise<ExamDetail | null> {
  const db = dbc
  const rows = await db
    .select({
      id: exams.id,
      name: exams.name,
      createdAt: exams.createdAt,
      updatedAt: exams.updatedAt,
      archivedAt: exams.archivedAt,
    })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

// CardListEntry: OCR result page (getCardsForSourceDocument) 用の snippet 表示型。
// Tag-1: customPropKeys は cards.custom_props DROP に伴い撤去。 タグ表示は Tag-4 で
// tag_options 由来の値で再配線。
export type CardListEntry = {
  id: string
  title: string
  sortKey: string | null
  questionTextSnippet: string
  optionCount: number
}

// ExamDetailCard: 試験詳細 page (/app/exams/[id]) で 1 card の全情報を read-only
// 展開表示するための型 (S2.0 T7)。 S2.0b-1 で memo (ユーザー自由メモ) を追加、
// inline 編集 UI から click で表示/編集する。 nullable text 列。
export type ExamDetailCard = {
  id: string
  title: string
  sortKey: string | null
  questionText: string
  options: CardOption[]
  explanationText: string | null
  memo: string | null
  images: ClientCardImage[]
}

// 試験詳細 page 用 cards 取得 (read-only、 owner-scoped)。
// sort: sort_key (text) ASC NULLS LAST → created_at ASC で OCR 文書順を尊重。
export async function getCardsForExam(
  userId: string,
  examId: string,
  dbc: TenantDb,
): Promise<ExamDetailCard[]> {
  const db = dbc
  const rows = await db
    .select({
      id: cards.id,
      title: cards.title,
      sortKey: cards.sortKey,
      questionText: cards.questionText,
      options: cards.options,
      explanationText: cards.explanationText,
      memo: cards.memo,
      images: cards.images,
    })
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.examId, examId)))
    .orderBy(cards.sortKey, cards.createdAt)
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    sortKey: r.sortKey,
    questionText: r.questionText,
    // options は schema 上 NOT NULL だが防御的に配列チェック。
    options: Array.isArray(r.options) ? r.options : [],
    explanationText: r.explanationText,
    memo: r.memo,
    // images も同様に防御的に配列チェック(既存 options パターン踏襲)。
    images: Array.isArray(r.images) ? (r.images as ClientCardImage[]) : [],
  }))
}

function snippet(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

// S1.9.2: OCR result page (/app/upload/result/[sourceDocumentId]) 用。
// source_document を owner-scoped で取得し、 投入先 exam 名を JOIN で同時に引く。
// 不在 / 他 user の場合は null (page 側で notFound())。
export type SourceDocumentResult = {
  id: string
  examName: string
}
export async function getSourceDocumentForUser(
  userId: string,
  sourceDocumentId: string,
  dbc: TenantDb,
): Promise<SourceDocumentResult | null> {
  const db = dbc
  const rows = await db
    .select({
      id: sourceDocuments.id,
      examName: exams.name,
    })
    .from(sourceDocuments)
    .innerJoin(exams, eq(exams.id, sourceDocuments.examId))
    .where(
      and(
        eq(sourceDocuments.id, sourceDocumentId),
        eq(sourceDocuments.userId, userId),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

// S1.9.2: OCR result page 用。 当該 source_document が抽出した cards 一覧。
// snippet 表示型 CardListEntry を返す (S2.0 T7 で getCardsForExam は rich 型
// ExamDetailCard に変更済、 本関数は upload result page 用に CardListEntry 据え置き)。
export async function getCardsForSourceDocument(
  userId: string,
  sourceDocumentId: string,
  dbc: TenantDb,
): Promise<CardListEntry[]> {
  const db = dbc
  const rows = await db
    .select({
      id: cards.id,
      title: cards.title,
      sortKey: cards.sortKey,
      questionText: cards.questionText,
      options: cards.options,
      createdAt: cards.createdAt,
    })
    .from(cards)
    .where(
      and(
        eq(cards.userId, userId),
        eq(cards.sourceDocumentId, sourceDocumentId),
      ),
    )
    .orderBy(cards.sortKey, cards.createdAt)
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    sortKey: r.sortKey,
    questionTextSnippet: snippet(r.questionText, 80),
    optionCount: Array.isArray(r.options) ? r.options.length : 0,
  }))
}

// formatRelativeJa は `./format` に移動済 (client-safe)。 本ファイル冒頭で
// re-export しているため、 既存 server importer は影響なし。
