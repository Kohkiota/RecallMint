// @vitest-environment jsdom
//
// Task 3: useImageZoom は PhotoSwipe を知る唯一の unit。ここでは実ライブラリを絶対に
// 読み込まず(`vi.mock('photoswipe')`)、hook が spec §3.4 の要件対応表どおりに
// `new PhotoSwipe(...)` を構成し、WCAG ズームボタン / focus / lifecycle / 競合ガードを
// 配線していることを個別に pin する。実 pinch/pan は mock 不能 = smoke(task 6)。

import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useImageZoom, ZOOM_STEP, type ZoomImage } from './use-image-zoom';

// --- PhotoSwipe mock ---------------------------------------------------------
// `new PhotoSwipe(opts)` が返す mock instance を捕捉し、options / uiRegister /
// currSlide.zoomTo / focus 対象 DOM を観測可能にする。vi.mock factory は hoist される
// ため、参照する mock 機構は vi.hoisted 内に閉じる。

interface MockInstance {
  options: Record<string, unknown>;
  element: HTMLDivElement;
  closeBtn: HTMLButtonElement;
  ui: { registerElement: Mock };
  currSlide: {
    currZoomLevel: number;
    zoomLevels: { initial: number; max: number; min: number };
    zoomTo: Mock;
  };
  on: Mock;
  off: Mock;
  init: Mock;
  destroy: Mock;
  close: Mock;
  emit: (name: string) => void;
}

const hoisted = vi.hoisted(() => {
  const instances: MockInstance[] = [];

  // 実 `new PhotoSwipe(opts)` を模すため通常 function(arrow は new 不可)。object を
  // 返すので new 式はその mock instance を評価する。
  const ctor = vi.fn(function (options: Record<string, unknown>): MockInstance {
    const handlers: Record<string, Array<() => void>> = {};
    const element = document.createElement('div');
    const closeBtn = document.createElement('button');
    // 実 PhotoSwipe が生成する閉じるボタンの class を模す(hook が focus 対象を query する)。
    closeBtn.className = 'pswp__button--close';
    element.appendChild(closeBtn);
    document.body.appendChild(element);

    const emit = (name: string) => {
      (handlers[name] ?? []).forEach((fn) => fn());
    };
    // 実 close/destroy は DOM を除去してから destroy event を飛ばす。
    const teardown = () => {
      element.remove();
      emit('destroy');
    };

    const inst: MockInstance = {
      options,
      element,
      closeBtn,
      ui: { registerElement: vi.fn() },
      currSlide: {
        currZoomLevel: 1,
        zoomLevels: { initial: 1, max: 4, min: 0.5 },
        zoomTo: vi.fn(),
      },
      on: vi.fn((name: string, fn: () => void) => {
        (handlers[name] ??= []).push(fn);
      }),
      off: vi.fn(),
      init: vi.fn(() => emit('uiRegister')),
      destroy: vi.fn(teardown),
      close: vi.fn(teardown),
      emit,
    };
    instances.push(inst);
    return inst;
  });

  return { ctor, instances };
});

vi.mock('photoswipe', () => ({ default: hoisted.ctor }));

// --- helpers -----------------------------------------------------------------

const IMAGES: ZoomImage[] = [
  { src: 'blob:one', width: 100, height: 300, alt: 'one' },
  { src: 'blob:two', width: 300, height: 100, alt: 'two' },
];

function firstInstance(): MockInstance {
  const inst = hoisted.instances[0];
  if (!inst) throw new Error('no PhotoSwipe instance was constructed');
  return inst;
}

function registeredButton(inst: MockInstance, name: string): Record<string, unknown> {
  const call = inst.ui.registerElement.mock.calls.find(
    (c) => (c[0] as { name?: string }).name === name,
  );
  if (!call) throw new Error(`button ${name} was not registered`);
  return call[0] as Record<string, unknown>;
}

async function openWith(
  open: (images: ZoomImage[], startIndex: number) => Promise<void>,
  startIndex = 0,
): Promise<void> {
  await act(async () => {
    await open(IMAGES, startIndex);
  });
}

// jsdom の window.scrollY は getter。scroll-lock は open 時に scrollY を退避するため
// nonzero に差し替えて top:-<scrollY>px を検証できるようにする。
function stubScrollY(value: number): void {
  Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true });
}

// jsdom の window.scrollTo は未実装(呼ぶと console.error)。unlock は必ず scrollTo を
// 呼ぶため、全 test で no-op stub にして出力を汚さず呼出を観測する。
let scrollToSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  hoisted.instances.length = 0;
  vi.clearAllMocks();
  scrollToSpy.mockRestore();
  stubScrollY(0);
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
});

describe('useImageZoom', () => {
  it('open() で core PhotoSwipe を生成し init する(Lightbox 不使用)', async () => {
    const { result } = renderHook(() => useImageZoom());
    await openWith(result.current.open);

    expect(hoisted.ctor).toHaveBeenCalledTimes(1);
    expect(firstInstance().init).toHaveBeenCalledTimes(1);
  });

  it('OPTS の各キーを個別に pin する(要件対応表 = §3.4)', async () => {
    const { result } = renderHook(() => useImageZoom());
    await openWith(result.current.open);

    const opts = hoisted.ctor.mock.calls[0][0] as Record<string, unknown>;
    // 1 object-equality でなく、要件 1 つ = assert 1 つ(監査可能な対応)。
    expect(opts.pinchToClose).toBe(false);
    expect(opts.closeOnVerticalDrag).toBe(true);
    expect(opts.doubleTapAction).toBe('zoom');
    expect(opts.imageClickAction).toBe('zoom');
    expect(opts.clickToCloseNonZoomable).toBe(false);
    expect(opts.escKey).toBe(true);
    expect(opts.arrowKeys).toBe(true);
    expect(opts.trapFocus).toBe(true);
    expect(opts.returnFocus).toBe(true);
  });

  it('dataSource === images / index === startIndex', async () => {
    const { result } = renderHook(() => useImageZoom());
    await openWith(result.current.open, 1);

    const opts = hoisted.ctor.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.dataSource).toBe(IMAGES);
    expect(opts.index).toBe(1);
  });

  it('initialZoomLevel は数値を返す関数: aspect>2.0 → z.fill / ≤2.0 → z.fit', async () => {
    const { result } = renderHook(() => useImageZoom());
    await openWith(result.current.open);

    const opts = hoisted.ctor.mock.calls[0][0] as Record<string, unknown>;
    const fn = opts.initialZoomLevel as (z: {
      elementSize: { x: number; y: number } | null;
      fill: number;
      fit: number;
    }) => number;
    expect(typeof fn).toBe('function');
    // 縦長(h/w = 3 > 2.0)→ fill の数値(文字列 'fill' ではない)。
    expect(fn({ elementSize: { x: 100, y: 300 }, fill: 42, fit: 7 })).toBe(42);
    // 横長(h/w = 1/3 ≤ 2.0)→ fit の数値。
    expect(fn({ elementSize: { x: 300, y: 100 }, fill: 42, fit: 7 })).toBe(7);
    // elementSize 未確定(null)→ fit フォールバック。
    expect(fn({ elementSize: null, fill: 42, fit: 7 })).toBe(7);
  });

  it('uiRegister で +/−/リセット 3 ボタンを name/ariaLabel/isButton で登録する', async () => {
    const { result } = renderHook(() => useImageZoom());
    await openWith(result.current.open);
    const inst = firstInstance();

    expect(inst.ui.registerElement).toHaveBeenCalledTimes(3);

    const plus = registeredButton(inst, 'zoom-in');
    expect(plus.ariaLabel).toBe('Zoom in');
    expect(plus.isButton).toBe(true);

    const minus = registeredButton(inst, 'zoom-out');
    expect(minus.ariaLabel).toBe('Zoom out');
    expect(minus.isButton).toBe(true);

    const reset = registeredButton(inst, 'zoom-reset');
    expect(reset.ariaLabel).toBe('Reset zoom');
    expect(reset.isButton).toBe(true);
  });

  describe('ズームボタンの onClick(WCAG 2.5.1・実挙動を pin)', () => {
    function clickOf(inst: MockInstance, name: string): () => void {
      return registeredButton(inst, name).onClick as () => void;
    }

    it('+ = 現倍率 × ZOOM_STEP / − = ÷ ZOOM_STEP', async () => {
      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      const inst = firstInstance();
      inst.currSlide.zoomLevels = { initial: 0.5, max: 4, min: 0.5 };

      inst.currSlide.currZoomLevel = 1;
      clickOf(inst, 'zoom-in')();
      expect(inst.currSlide.zoomTo).toHaveBeenLastCalledWith(1 * ZOOM_STEP);

      inst.currSlide.currZoomLevel = 2;
      clickOf(inst, 'zoom-out')();
      expect(inst.currSlide.zoomTo).toHaveBeenLastCalledWith(2 / ZOOM_STEP);
    });

    it('リセットは文字列でなく現 slide の実数 initial(zoomLevels.initial)へ', async () => {
      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      const inst = firstInstance();
      inst.currSlide.zoomLevels = { initial: 0.75, max: 4, min: 0.75 };
      inst.currSlide.currZoomLevel = 3;

      clickOf(inst, 'zoom-reset')();
      expect(inst.currSlide.zoomTo).toHaveBeenCalledWith(0.75);
    });

    it('zoomTo は [initial, max] に clamp され、bound では disabled(no-op)', async () => {
      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      const inst = firstInstance();
      inst.currSlide.zoomLevels = { initial: 0.5, max: 4, min: 0.5 };

      // 既に max → + は clamp して現倍率に一致 → no-op(呼ばれない)。
      inst.currSlide.currZoomLevel = 4;
      clickOf(inst, 'zoom-in')();
      expect(inst.currSlide.zoomTo).not.toHaveBeenCalled();

      // 既に initial → − も no-op。
      inst.currSlide.currZoomLevel = 0.5;
      clickOf(inst, 'zoom-out')();
      expect(inst.currSlide.zoomTo).not.toHaveBeenCalled();
    });
  });

  describe('focus 管理(returnFocus:true に依存しない明示制御)', () => {
    it('open 直後に閉じるボタンへ focus が移る', async () => {
      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      expect(document.activeElement).toBe(firstInstance().closeBtn);
    });

    it('close で起動要素へ focus 復帰する', async () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      const inst = firstInstance();
      expect(document.activeElement).toBe(inst.closeBtn);

      act(() => inst.close());
      expect(document.activeElement).toBe(trigger);
    });

    it('起動要素が DOM から消えていれば安全な既定(body)へ fallback', async () => {
      // jsdom の body は既定で focusable でなく document.body.focus() が no-op になる。
      // 実ブラウザは body へ focus が移るため、 tabindex=-1 を与えて実挙動を再現する
      // (この shim が無いと本 test は effect を観測できない)。
      document.body.setAttribute('tabindex', '-1');

      // shim の除去を finally に置き、 途中 assertion が throw しても <body> に tabindex=-1 を
      // 残さない (残ると後続 test の focus 挙動に波及する)。
      try {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();

        const { result } = renderHook(() => useImageZoom());
        await openWith(result.current.open);
        const inst = firstInstance();

        trigger.remove(); // 起動要素(focus 復帰 trigger)が DOM から消える

        // 弁別化: 消えた trigger による自然な body 落ちに頼ると、 hook が何もしなくても
        // assertion が通り非弁別になる。 sentinel を focus し、 hook が明示 body.focus() を
        // 呼んで初めて sentinel から外れることを assert する(no-op hook なら sentinel のまま fail)。
        const sentinel = document.createElement('button');
        document.body.appendChild(sentinel);
        sentinel.focus();
        expect(document.activeElement).toBe(sentinel);

        act(() => inst.close());
        // trigger 不在 → hook は body へ fallback。 focus は sentinel から body へ移る。
        expect(document.activeElement).not.toBe(sentinel);
        expect(document.activeElement).toBe(document.body);
      } finally {
        document.body.removeAttribute('tabindex');
      }
    });
  });

  describe('lifecycle / 競合ガード(単一インスタンス)', () => {
    it('open 中(dynamic import 解決前)の 2 度目 open は無視される', async () => {
      const { result } = renderHook(() => useImageZoom());
      await act(async () => {
        const p1 = result.current.open(IMAGES, 0);
        const p2 = result.current.open(IMAGES, 0); // in-flight → 無視
        await Promise.all([p1, p2]);
      });
      expect(hoisted.ctor).toHaveBeenCalledTimes(1);
    });

    it('既に開いている間の open は無視される', async () => {
      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      await openWith(result.current.open); // 既に open → 無視
      expect(hoisted.ctor).toHaveBeenCalledTimes(1);
    });

    it('dynamic import が unmount 後に解決しても leak modal を作らない', async () => {
      const { result, unmount } = renderHook(() => useImageZoom());
      // open() は await import で中断 → その間に同期 unmount。
      // dynamic import の継続は仕様上必ず同期 unmount の後に走る(race でない)。
      const p = result.current.open(IMAGES, 0);
      unmount();
      await act(async () => {
        await p;
      });
      expect(hoisted.ctor).not.toHaveBeenCalled();
    });

    it('unmount 時に開いていれば destroy() で強制 teardown する(soft close ではない)', async () => {
      // unmount cleanup は close() でなく destroy() を呼ぶ: close() は opening アニメ中
      // 内部 no-op になり得る(PhotoSwipe opener.close の isOpening early-return)ため、
      // どの状態でも同期 teardown する destroy() を使う(scroll-lock leak 防止)。
      const { result, unmount } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      const inst = firstInstance();

      unmount();
      expect(inst.destroy).toHaveBeenCalledTimes(1);
      expect(inst.close).not.toHaveBeenCalled();
    });

    it('close→destroy で参照解放し、次の open は新インスタンスを生成する(destroy 冪等)', async () => {
      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      const inst = firstInstance();

      act(() => inst.close());
      // destroy を再度飛ばしても throw しない(冪等)。
      expect(() => act(() => inst.emit('destroy'))).not.toThrow();

      await openWith(result.current.open);
      expect(hoisted.ctor).toHaveBeenCalledTimes(2);
    });
  });

  describe('scroll-lock(fixed-body・iOS WebKit・実スクロール漏れは smoke)', () => {
    it('open() で body を fixed 固定し top:-<scrollY>px + width を付与する', async () => {
      stubScrollY(250);
      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);

      expect(document.body.style.position).toBe('fixed');
      expect(document.body.style.top).toBe('-250px');
      expect(document.body.style.width).toBe('100%');
    });

    it('close/destroy で元 body style へ復帰し window.scrollTo(0, scrollY) を呼ぶ', async () => {
      // 退避対象の original を非既定値にして「復帰」を弁別する。
      document.body.style.overflow = 'scroll';
      stubScrollY(250);

      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      const inst = firstInstance();
      // lock 中は overflow が hidden に上書きされている。
      expect(document.body.style.overflow).toBe('hidden');

      act(() => inst.close());

      expect(document.body.style.position).toBe('');
      expect(document.body.style.top).toBe('');
      expect(document.body.style.width).toBe('');
      expect(document.body.style.overflow).toBe('scroll'); // original へ復帰
      expect(scrollToSpy).toHaveBeenCalledWith(0, 250);
    });

    it('冪等: lock 中の 2 度目 open は退避 scrollY を上書きしない', async () => {
      stubScrollY(100);
      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      expect(document.body.style.top).toBe('-100px');

      // 開いたまま scrollY が変化しても、2 度目 open は無視され退避値は不変。
      stubScrollY(999);
      await openWith(result.current.open);
      expect(document.body.style.top).toBe('-100px'); // 999 で clobber されない

      act(() => firstInstance().close());
      expect(scrollToSpy).toHaveBeenCalledWith(0, 100); // 退避値 100 で復帰
    });

    it('冪等: unlock 済みで再度 destroy が来ても no-op(scrollTo を再呼出しない)', async () => {
      stubScrollY(80);
      const { result } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      const inst = firstInstance();

      act(() => inst.close());
      expect(scrollToSpy).toHaveBeenCalledTimes(1);

      // 既に unlock 済み → 2 度目の destroy は release-while-unlocked の no-op。
      act(() => inst.emit('destroy'));
      expect(scrollToSpy).toHaveBeenCalledTimes(1);
    });

    it('unmount-while-open で lock が解除され body が復帰する', async () => {
      document.body.style.overflow = 'scroll';
      stubScrollY(120);
      const { result, unmount } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      expect(document.body.style.position).toBe('fixed');

      unmount(); // 開いたまま unmount → destroy() → teardown → destroy ハンドラ → unlock

      expect(document.body.style.position).toBe('');
      expect(document.body.style.overflow).toBe('scroll');
      expect(scrollToSpy).toHaveBeenCalledWith(0, 120);
    });

    it('unmount-while-opening で teardown が no-op でも fallback unlock で lock が解放される', async () => {
      // Critical leak(review 指摘)の再現: opening アニメ中に unmount すると、実 PhotoSwipe
      // では close() も destroy() も内部 opener.close() の isOpening early-return により
      // teardown せず destroy イベントを発火しない。これを mock で忠実に再現するため、
      // open 後に inst.close / inst.destroy を「destroy を発火しない no-op」に差し替える。
      // このとき body の position:fixed を解除する唯一の経路は cleanup の fallback
      // unlockBodyScroll。fix が無い(soft close のみ)と body は fixed のまま = ページ恒久
      // フリーズ。fallback があれば destroy ハンドラが走らなくても復帰する(多層防御)。
      document.body.style.overflow = 'scroll';
      stubScrollY(140);
      const { result, unmount } = renderHook(() => useImageZoom());
      await openWith(result.current.open);
      const inst = firstInstance();
      expect(document.body.style.position).toBe('fixed');

      // opening アニメ中の PhotoSwipe を模す: teardown も destroy 発火も起きない。
      inst.close.mockImplementation(() => {});
      inst.destroy.mockImplementation(() => {});

      unmount();

      // destroy ハンドラは走らないが、fallback unlockBodyScroll が lock を解放する。
      expect(document.body.style.position).toBe('');
      expect(document.body.style.overflow).toBe('scroll');
      expect(scrollToSpy).toHaveBeenCalledWith(0, 140);
    });
  });
});
