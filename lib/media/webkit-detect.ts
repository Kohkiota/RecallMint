// WebKit 画像 pipeline 判定 (画像圧縮 iOS/WebKit 修正 spec Task 1)。
//
// iOS 全 browser (Safari/CriOS/FxiOS) は engine が WebKit 固定であり、
// desktop-class iPad (iPadOS 13+ の UA は desktop Safari を偽装するため
// /iP(ad|hone|od)/ に掛からない) も同じ WebKit 制約を持つ。 圧縮 pipeline の
// 分岐 gate として判定のみを提供する (WebP probe は別責務 → T3)。

export function isWebKitImagePipeline(): boolean {
  if (typeof navigator === 'undefined') return false

  const ua = navigator.userAgent ?? ''

  const isIosUa = /iP(ad|hone|od)/.test(ua)
  const isDesktopClassIpad =
    navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1
  const isDesktopWebKit =
    /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(ua)

  return isIosUa || isDesktopClassIpad || isDesktopWebKit
}
