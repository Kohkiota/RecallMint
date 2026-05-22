import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getCardForEdit } from '@/lib/cards/get-card-for-edit'
import { CardEditor } from './_components/card-editor'

// S2.0: 個別 card 編集 page。 owner-scoped で card を取得し、 編集 UI
// (CardEditor、 breadcrumb / 離脱 guard を内包する Client Component) に渡す。
// 不在 / 他 user の cardId は getCardForEdit が null を返し notFound() に変換。
export default async function CardEditPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return null

  const card = await getCardForEdit(user.id, id)
  if (!card) notFound()

  return (
    <CardEditor
      cardId={card.id}
      examId={card.examId}
      examName={card.examName}
      initialTitle={card.title}
      initialQuestionText={card.questionText}
      initialOptions={card.options}
      initialExplanationText={card.explanationText}
    />
  )
}
