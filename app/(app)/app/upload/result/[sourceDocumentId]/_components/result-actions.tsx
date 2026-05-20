import Link from 'next/link'
import { Button } from '@/components/ui/button'

// S1.9.3: result page の操作 button。
// 「破棄して再アップロード」 は廃止 (スキャン = 必ず exam 作成、編集 / 削除は
// 試験一覧側で行う新運用方針に合わせた)。 cards は OCR 完了時点で DB 確定済の
// ため、 保存操作は不要。 ここでは試験一覧への navigation のみを提供する。
export function ResultActions() {
  return (
    <Button asChild className="w-full py-3 text-base font-bold">
      <Link href="/app/exams">保存して試験一覧へ</Link>
    </Button>
  )
}
