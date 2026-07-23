'use client';

// PhotoSwipe を知る唯一の unit(spec §3.1/§3.4)。呼出側は ready な blob objectURL を
// ZoomImage.src で渡す — この hook は URL 解決/presigned を行わない(責務分離・§7)。
// document/window と browser-only な PhotoSwipe を dynamic import するため、server component
// への誤 import を防ぐ意図で明示的に client module にする。

import { useCallback, useEffect, useRef } from 'react';

import 'photoswipe/style.css';

import type PhotoSwipe from 'photoswipe';
import type { PhotoSwipeOptions } from 'photoswipe';

export type ZoomImage = { src: string; width: number; height: number; alt: string };

// +/− ボタンの倍率ステップ。test が実挙動を pin できるよう単一定義を export
// (WCAG 2.5.1 の pointer-gesture 代替が「一定比率で拡大縮小」することの唯一の真実源)。
export const ZOOM_STEP = 1.5;

// PhotoSwipe の ZoomLevel 実型を option 型から導出し、aspect 計算が
// ライブラリの elementSize/fit/fill 形状を追従するようにする(内部 path 依存を避ける)。
type ZoomLevelOption = NonNullable<PhotoSwipeOptions['initialZoomLevel']>;
type ZoomLevelObject = Parameters<Extract<ZoomLevelOption, (...args: never[]) => number>>[0];

// spec §3.4 の config 表を verbatim。initialZoomLevel は数値を返す関数として別途付与。
const OPTS = {
  pinchToClose: false,
  closeOnVerticalDrag: true,
  doubleTapAction: 'zoom',
  imageClickAction: 'zoom',
  clickToCloseNonZoomable: false,
  escKey: true,
  arrowKeys: true,
  trapFocus: true,
  returnFocus: true,
} as const satisfies Partial<PhotoSwipeOptions>;

const CLOSE_BUTTON_SELECTOR = '.pswp__button--close';

// initialZoomLevel の function 形は「数値」を返す必要がある(PhotoSwipe 仕様)。
// 縦長(aspect = h/w > 2.0)は幅フィット+縦パンの fill、それ以外は fit。
// elementSize は初回レイアウト前 null になり得るため、その場合は fit にフォールバック。
function computeInitialZoom(z: ZoomLevelObject): number {
  const size = z.elementSize;
  const aspect = size && size.x > 0 ? size.y / size.x : 0;
  return aspect > 2.0 ? z.fill : z.fit;
}

// +/−/リセット ボタンの onClick。現 slide の実数を読み、[initial, max] に clamp。
// clamp 後が現倍率に一致(= bound 到達)なら no-op = disabled 相当。リセット先は
// 文字列でなく現 slide の実数 initial(zoomLevels.initial)。
function makeZoomHandler(pswp: PhotoSwipe, kind: 'in' | 'out' | 'reset'): () => void {
  return () => {
    const slide = pswp.currSlide;
    if (!slide) return;
    const { initial, max } = slide.zoomLevels;
    const current = slide.currZoomLevel;
    const target =
      kind === 'in' ? current * ZOOM_STEP : kind === 'out' ? current / ZOOM_STEP : initial;
    const clamped = Math.min(max, Math.max(initial, target));
    if (clamped === current) return; // bound / 既に一致 → no-op(disabled 相当)
    slide.zoomTo(clamped);
  };
}

function registerZoomButtons(pswp: PhotoSwipe): void {
  const ui = pswp.ui;
  if (!ui) return;
  const buttons = [
    { name: 'zoom-in', ariaLabel: 'Zoom in', glyph: '+', kind: 'in' },
    { name: 'zoom-out', ariaLabel: 'Zoom out', glyph: '−', kind: 'out' },
    { name: 'zoom-reset', ariaLabel: 'Reset zoom', glyph: '↺', kind: 'reset' },
  ] as const;
  for (const b of buttons) {
    ui.registerElement({
      name: b.name,
      ariaLabel: b.ariaLabel,
      isButton: true,
      html: b.glyph,
      // touch-action:manipulation = 二重タップ遅延を抑止(WCAG target・§3.4)。
      onInit: (el) => {
        el.style.touchAction = 'manipulation';
      },
      onClick: makeZoomHandler(pswp, b.kind),
    });
  }
}

function focusCloseButton(pswp: PhotoSwipe): void {
  // returnFocus:true に依存せず、open 直後に閉じるボタンへ明示 focus(§3.4)。
  const btn = pswp.element?.querySelector<HTMLElement>(CLOSE_BUTTON_SELECTOR);
  btn?.focus();
}

function returnFocusTo(trigger: HTMLElement | null): void {
  // 起動要素が DOM に残っていれば復帰、消えていれば安全な既定(body)へ。
  if (trigger && trigger.isConnected) {
    trigger.focus();
  } else {
    document.body.focus();
  }
}

export function useImageZoom(): {
  open: (images: ZoomImage[], startIndex: number) => Promise<void>;
} {
  const pswpRef = useRef<PhotoSwipe | null>(null);
  const openingRef = useRef(false);
  const mountedRef = useRef(true);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // unmount 時に開いていれば閉じる(leak 防止・Codex plan-gap5)。
      if (pswpRef.current) {
        pswpRef.current.close();
      }
    };
  }, []);

  const open = useCallback(async (images: ZoomImage[], startIndex: number): Promise<void> => {
    // 同時 1 インスタンス。open 中 or 既に open なら無視(Codex 独立4/plan-gap6)。
    if (pswpRef.current || openingRef.current) return;
    openingRef.current = true;
    // close 後に focus を戻す起動要素を捕捉。
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;

    try {
      const { default: PhotoSwipeCtor } = await import('photoswipe');
      // dynamic import の解決が unmount 後なら leak modal を作らない(plan-gap)。
      if (!mountedRef.current) return;

      const pswp = new PhotoSwipeCtor({
        dataSource: images,
        index: startIndex,
        ...OPTS,
        initialZoomLevel: computeInitialZoom,
      });
      pswpRef.current = pswp;
      pswp.on('uiRegister', () => registerZoomButtons(pswp));
      pswp.on('destroy', () => {
        // 参照解放 / focus 復帰は destroy(close アニメ後)で行う。
        pswpRef.current = null;
        returnFocusTo(triggerRef.current);
        triggerRef.current = null;
      });
      pswp.init();
      focusCloseButton(pswp);
    } finally {
      openingRef.current = false;
    }
  }, []);

  return { open };
}
