'use client'

import { useState, useTransition } from 'react'
import { submitContact } from '@/app/(marketing)/contact/actions'
import {
  CONTACT_CATEGORIES,
  type ContactCategory,
} from '@/lib/validation/contact'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

// 認証外 contact form 本体。
// Sprint A-3.2 で name 入力欄削除 (個人情報最小化)、 category dropdown 追加、
// body field rename (UI label「お問い合わせ内容」維持、内部名のみ message→body)、
// submit 後 DB INSERT 実装 (actions.ts 側) に拡張。
const CATEGORY_LABELS: Record<ContactCategory, string> = {
  general: 'お問い合わせ全般',
  bug: '不具合の報告',
  takedown: 'コンテンツ削除依頼',
  billing: 'お支払い・解約',
  other: 'その他',
}

export function ContactForm() {
  const [pending, start] = useTransition()
  const [email, setEmail] = useState('')
  const [category, setCategory] = useState<ContactCategory>('general')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [website, setWebsite] = useState('') // honeypot
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // Enter キーや連打で onSubmit が pending 中に再発火するのを抑止
    // (disabled ボタンだけでは input 内 Enter による submit を防げないため)。
    // DB に (email, subject) の unique 制約は無く、重複 row が作られうる。
    if (pending) return
    setError(null)
    start(async () => {
      const res = await submitContact({ email, category, subject, body, website })
      if (res.ok) {
        setSent(true)
      } else {
        setError(res.error)
      }
    })
  }

  const onReset = () => {
    setEmail('')
    setCategory('general')
    setSubject('')
    setBody('')
    setWebsite('')
    setError(null)
    setSent(false)
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-xl">お問い合わせ</CardTitle>
        <CardDescription>
          ご質問・ご要望はこちらからお送りください。
        </CardDescription>
      </CardHeader>
      <CardContent className="py-4">
        {sent ? (
          <div className="space-y-4">
            <p className="text-base">
              お問い合わせありがとうございます。順次対応いたします。
              <br />
              対応に時間を要する場合があります。
            </p>
            <Button type="button" variant="outline" onClick={onReset}>
              もう一度送る
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label className="block text-sm font-medium mb-1">
                メールアドレス <span className="text-red-500">*</span>
              </Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={254}
              />
            </div>
            <div>
              <Label htmlFor="contact-category" className="block text-sm font-medium mb-1">
                カテゴリ <span className="text-red-500">*</span>
              </Label>
              <select
                id="contact-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as ContactCategory)}
                required
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {CONTACT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="block text-sm font-medium mb-1">
                件名 <span className="text-red-500">*</span>
              </Label>
              <Input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
                maxLength={200}
              />
            </div>
            <div>
              <Label className="block text-sm font-medium mb-1">
                お問い合わせ内容 <span className="text-red-500">*</span>
              </Label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                required
                rows={6}
                maxLength={5000}
              />
            </div>

            {/* honeypot: 視覚非表示 + a11y 不可視。 bot が autofill すると
                silent reject される (server action 側判定)。 display:none を
                避けて off-screen 配置にする (一部 bot は display:none 要素を
                skip するため)。 */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden"
            />

            {error && <p className="text-red-600 text-sm">{error}</p>}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? '送信中…' : '送信'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
