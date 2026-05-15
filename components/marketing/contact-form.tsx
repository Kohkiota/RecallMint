'use client'

import { useState, useTransition } from 'react'
import { submitContact } from '@/app/(marketing)/contact/actions'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

// 認証外 contact form 本体 (Phase 1 I-D で page から抽出、 γ refactor、
// logic 不変)。 (marketing) layout が MarketingHeader / MarketingFooter
// chrome を提供、 page 側で max-w-2xl wrapper、 本 component は Card +
// form / 完了 UI 切替の責務のみ。
//
// 送信完了で form 領域を hidden + inline 完了 UI に置換 (I-J spec §6
// 論点 3 = 案 A)。
export function ContactForm() {
  const [pending, start] = useTransition()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [website, setWebsite] = useState('') // honeypot
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    start(async () => {
      const res = await submitContact({ name, email, subject, message, website })
      if (res.ok) {
        setSent(true)
      } else {
        setError(res.error)
      }
    })
  }

  const onReset = () => {
    setName('')
    setEmail('')
    setSubject('')
    setMessage('')
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
              お問い合わせありがとうございました。
              <br />
              内容を確認次第、 必要に応じて返信いたします。
            </p>
            <Button type="button" variant="outline" onClick={onReset}>
              もう一度送る
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label className="block text-sm font-medium mb-1">
                お名前 <span className="text-red-500">*</span>
              </Label>
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
              />
            </div>
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
                本文 <span className="text-red-500">*</span>
              </Label>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
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
