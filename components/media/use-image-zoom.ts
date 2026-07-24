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

// --- scroll-lock(fixed-body・iOS WebKit)------------------------------------
// iOS Safari は body の overflow:hidden だけでは背景スクロールを止められないため、
// position:fixed + top:-scrollY で固定し、解除時に scrollY を復帰させる(§3.5)。
// 画像モーダルは同時 1 = 参照カウント不要(YAGNI)。退避値を保持する ref で冪等性を担保。
type ScrollLockState = {
  scrollY: number;
  position: string;
  top: string;
  overflow: string;
  width: string;
} | null;

type ScrollLockRef = { current: ScrollLockState };

function lockBodyScroll(ref: ScrollLockRef): void {
  if (ref.current) return; // 既に lock 済み → no-op(冪等)
  // fixed 化はスクロール位置を 0 に飛ばすため、scrollY を先に読む(順序が本質)。
  const scrollY = window.scrollY;
  const body = document.body;
  ref.current = {
    scrollY,
    position: body.style.position,
    top: body.style.top,
    overflow: body.style.overflow,
    width: body.style.width,
  };
  body.style.position = 'fixed';
  body.style.top = `-${scrollY}px`;
  body.style.width = '100%';
  body.style.overflow = 'hidden';
}

function unlockBodyScroll(ref: ScrollLockRef): void {
  const saved = ref.current;
  if (!saved) return; // 未 lock → no-op(冪等)
  ref.current = null;
  const body = document.body;
  body.style.position = saved.position;
  body.style.top = saved.top;
  body.style.overflow = saved.overflow;
  body.style.width = saved.width;
  window.scrollTo(0, saved.scrollY);
}

export function useImageZoom(): {
  open: (images: ZoomImage[], startIndex: number) => Promise<void>;
} {
  const pswpRef = useRef<PhotoSwipe | null>(null);
  const openingRef = useRef(false);
  const mountedRef = useRef(true);
  const triggerRef = useRef<HTMLElement | null>(null);
  const scrollLockRef = useRef<ScrollLockState>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // unmount 時に開いていれば強制 teardown する(leak 防止・Codex plan-gap5)。
      // close() は soft: PhotoSwipe は opening アニメ中の close を内部で no-op にする
      // (opener.close() が isOpening 時 early-return)ため、その窓で unmount すると
      // destroy イベントが発火せず scroll-lock(position:fixed)が恒久 leak しページが
      // 全面フリーズする。destroy() は showHideAnimationType='none' で同期 teardown し
      // どの状態でも安全に呼べる(isDestroying でガード)ので orphan overlay も除去できる。
      // ただし destroy() 自体も opening アニメ中は内部 close 経由で no-op になり得るため、
      // 多層防御として fallback で直接 unlock も行う(unlockBodyScroll は保存 ref で
      // ガードされ冪等ゆえ、destroy ハンドラが走った path での二重解放も安全な no-op)。
      const pswp = pswpRef.current;
      if (pswp) {
        pswp.destroy();
        unlockBodyScroll(scrollLockRef);
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
        // 参照解放 / scroll-lock 解除 / focus 復帰は destroy(close アニメ後)で行う。
        pswpRef.current = null;
        unlockBodyScroll(scrollLockRef);
        returnFocusTo(triggerRef.current);
        triggerRef.current = null;
      });
      pswp.init();
      // fixed 固定は focus 前に行う(focus によるページスクロールを抑止)。
      lockBodyScroll(scrollLockRef);
      focusCloseButton(pswp);
    } finally {
      openingRef.current = false;
    }
  }, []);

  return { open };
}
