/**
 * OCR 開始 signal pub-sub
 *
 * upload-form (publisher) と layout 常駐の status poller (subscriber) を
 * 疎結合にするための module-scope pub-sub。
 * React / DOM に一切依存しない純 JS なので SSR 安全。
 */

// listener を Set で保持することで O(1) 登録・削除と重複登録防止を両立
const listeners = new Set<() => void>()

/**
 * OCR 開始通知を購読する。
 * @returns 購読解除関数 (冪等 — 複数回呼んでも安全)
 */
export function subscribeOcrPoll(listener: () => void): () => void {
  listeners.add(listener)

  // 解除関数を変数に保持し、1 度 delete したら no-op になるよう冪等化する
  let active = true
  return () => {
    if (!active) return
    active = false
    listeners.delete(listener)
  }
}

/**
 * 登録済み全 listener に OCR 開始を通知する。
 * 各 listener を try/catch で隔離するため、1 つが throw しても残りを呼ぶ。
 */
export function requestOcrPoll(): void {
  // JS Set の live iterator: dispatch 中の自己 unsubscribe は安全。
  // 他 listener を dispatch 中に unsubscribe すると未訪問エントリはスキップされる
  // (本モジュールの想定ユースケース = upload→poller では発生しない)。
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // listener の例外は他 listener に波及させない
    }
  }
}
