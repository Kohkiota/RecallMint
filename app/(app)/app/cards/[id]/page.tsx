import { notFound } from 'next/navigation'
import { getAuthContext, getCurrentUser } from '@/lib/auth/ensure-user'
import { getCardForEdit } from '@/lib/cards/get-card-for-edit'
import { CardEditor } from './_components/card-editor'
import { DeleteCardButton } from './_components/delete-card-button'

// S2.0: 個別 card 編集 page。 owner-scoped で card を取得し、 編集 UI
// (CardEditor、 breadcrumb / 離脱 guard を内包する Client Component) に渡す。
// 不在 / 他 user の cardId は getCardForEdit が null を返し notFound() に変換。
//
// C2: getAuthContext() で JWT 経由の dbUserId 読込に切替、 users SELECT を撤去。
// undefined 時は getCurrentUser() fallback。
export default async function CardEditPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const ctx = await getAuthContext()
  let userId: string | undefined = ctx.dbUserId
  if (userId === undefined) {
    const user = await getCurrentUser()
    if (!user) return null
    userId = user.id
  }

  const card = await getCardForEdit(userId, id)
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
      deleteSlot={<DeleteCardButton cardId={card.id} examId={card.examId} />}
    />
  )
}
