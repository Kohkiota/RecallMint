import Link from 'next/link'
import { Button } from '@/components/ui/button'

// S1.9.3: result page の操作 button。
// 「破棄して再アップロード」 は廃止 (スキャン = 必ず exam 作成、編集 / 削除は
// 試験一覧側で行う新運用方針に合わせた)。 cards は OCR 完了時点で DB 確定済の
// ため、 保存操作は不要。 ここでは試験一覧への navigation のみを提供する。
// ②-4a Task S-3(canonical review round 2): 未完了 / 失敗の面でも同じ導線を出すが、
// 「保存して」は成功を含意するため文言だけ差し替えられるようにする(既定 = 成功時の
// 従来文言で、成功面の見え方は不変)。
export function ResultActions({ label = '保存して試験一覧へ' }: { label?: string } = {}) {
  return (
    <Button asChild className="w-full py-3 text-base font-bold">
      <Link href="/app/exams" prefetch={false}>{label}</Link>
    </Button>
  )
}
