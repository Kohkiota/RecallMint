'use client'

// 空状態の CTA 2 択目。 CreateExamForm の展開トリガーボタンをクリックして
// インラインフォームを展開する。 フォームの input は autoFocus で自動フォーカス。
// Server Component (page.tsx) から props なしで配置できる軽量 client component。

import { Button } from '@/components/ui/button'

export function OpenCreateExamButton() {
  const onOpen = () => {
    // CreateExamForm の展開トリガーボタンを click し、フォームを inline 展開する。
    // フォームの input の autoFocus が view port 内への移行を処理する。
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-create-exam-trigger]',
    )
    if (trigger) {
      trigger.click()
    }
  }

  return (
    <Button variant="outline" onClick={onOpen}>
      手動で試験を作成
    </Button>
  )
}
