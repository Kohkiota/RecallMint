'use client'

// InstallPrompt: ホーム画面追加を促す控えめなヒント (画像フェーズ A Task 12 / spec §7)。
//
// 一括 DL の耐久性 (all-or-nothing でキャッシュした画像がオフラインでも消えにくい) は
// PWA install が前提になるため、 非 standalone 起動時にだけ「ホーム画面に追加」を案内する。
// standalone (既に install 済) なら何も出さない。
//
// - standalone 判定: display-mode: standalone または iOS の navigator.standalone。
// - Chromium: beforeinstallprompt を捕捉 (preventDefault で自動バナー抑止) し、 ボタンから
//   deferredPrompt.prompt() を呼ぶ。
// - iOS Safari (beforeinstallprompt 非対応): 「共有 → ホーム画面に追加」の手動手順を表示。
// - dismiss 可能 (local state のみ、 永続はしない — best-effort UX ゆえ over-engineer しない)。

import { useEffect, useState, useSyncExternalStore } from 'react'

// beforeinstallprompt の最小型 (lib.dom に型定義が無いブラウザ拡張イベント)。
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const displayModeStandalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  // iOS Safari は display-mode を持たず navigator.standalone で判定する。
  const iosStandalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true
  return displayModeStandalone || iosStandalone
}

// SSR では standalone / install 可否を判定できず、 client でのみ意味を持つ。
// useSyncExternalStore で server snapshot=false / client snapshot=true とし、
// hydration mismatch を出さずに「client 描画後のみ表示」を実現する
// (set-state-in-effect を使う mounted フラグ pattern を避ける、 repo 規律)。
const emptySubscribe = () => () => {}

export function InstallPrompt() {
  const isClient = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  )
  const [dismissed, setDismissed] = useState(false)
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      // Chromium の自動バナーを抑止し、 自前ボタンから prompt() を呼べるよう stash する。
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    return () =>
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  }, [])

  if (!isClient || dismissed || isStandalone()) return null

  const handleInstall = () => {
    if (!deferredPrompt) return
    // prompt() は best-effort — 失敗しても UX を壊さない (握って dismiss する)。
    void deferredPrompt.prompt().catch(() => {})
    setDeferredPrompt(null)
    setDismissed(true)
  }

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      <div className="flex items-start justify-between gap-2">
        <p className="leading-relaxed">
          ホーム画面に追加すると画像がオフラインでも消えにくくなります。
          {!deferredPrompt && (
            <span className="mt-1 block text-slate-500">
              共有ボタン → 「ホーム画面に追加」から登録できます。
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 text-slate-400 hover:text-slate-600"
          aria-label="閉じる"
        >
          ✕
        </button>
      </div>
      {deferredPrompt && (
        <button
          type="button"
          onClick={handleInstall}
          className="mt-2 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-slate-700 hover:bg-slate-100"
        >
          ホーム画面に追加
        </button>
      )}
    </div>
  )
}
