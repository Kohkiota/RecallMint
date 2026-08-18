// estimate — 定義 doc §4-N の推定所要時間・中央値計算の境界 pin(pin 11、走査上限を
// 含む — 定義 doc の番号では pin 18 に相当する境界だが本 task の Tests 節では
// 「pin 11 (estimate 境界)」クラスタに含めて指定されている)。

import { describe, expect, it } from 'vitest'
import {
  ESTIMATE_CAP_MS,
  ESTIMATE_DEFAULT_MS,
  ESTIMATE_SCAN_LIMIT,
} from './metric-constants'
import { estimateMedianMs } from './estimate'

describe('estimateMedianMs — 有効化条件の境界', () => {
  it('elapsed_ms = 0 は除外される(計測不能の縮退値)', () => {
    // 0 だけの標本 → 有効標本 0 件 → 既定値
    expect(estimateMedianMs([0, 0, 0])).toBe(ESTIMATE_DEFAULT_MS)
  })

  it('elapsed_ms = ESTIMATE_CAP_MS ちょうどは有効(上限は inclusive)', () => {
    expect(estimateMedianMs([ESTIMATE_CAP_MS])).toBe(ESTIMATE_CAP_MS)
  })

  it('elapsed_ms = ESTIMATE_CAP_MS + 1 は除外される(clamp でなく除外)', () => {
    // 上限超過の 1 件だけ → 有効標本 0 件 → 既定値(clamp して 120000 を返してはいけない)
    expect(estimateMedianMs([ESTIMATE_CAP_MS + 1])).toBe(ESTIMATE_DEFAULT_MS)
  })
})

describe('estimateMedianMs — 中央値', () => {
  it('奇数件は中央 1 件', () => {
    expect(estimateMedianMs([1000, 3000, 2000])).toBe(2000)
  })

  it('偶数件は中央 2 件の算術平均', () => {
    expect(estimateMedianMs([1000, 2000, 3000, 4000])).toBe(2500)
  })

  it('有効標本 0 件は ESTIMATE_DEFAULT_MS', () => {
    expect(estimateMedianMs([])).toBe(ESTIMATE_DEFAULT_MS)
    expect(estimateMedianMs([null, undefined, 0])).toBe(ESTIMATE_DEFAULT_MS)
  })
})

describe('estimateMedianMs — 走査上限とサンプル上限', () => {
  it('有効標本が ESTIMATE_SAMPLE_N を超えても先頭 100 件だけを使う', () => {
    // fix round 1/5 I-1: 旧 fixture(head=1000 x100, tail=999_999 x50)は tail が
    // cap(120,000ms)超過で無効値だったため、サンプル上限を実装から消しても
    // (= break 削除)tail はそもそも有効化条件で弾かれ、中央値は変わらず green の
    // ままだった(pin として機能していなかった — canonical 指摘)。
    //
    // 修正: 全 150 件を cap 内の有効値にし、かつ単調増加(100ms, 200ms, …, 15,000ms)
    // にすることで、「先頭 100 件だけ」と「150 件全部」で中央値が実際に異なる値になる
    // よう構成する。
    // - 先頭 100 件(100ms〜10,000ms)だけを使う場合: 中央値 = 中央 2 件(50・51 番目 =
    //   5000ms・5100ms)の平均 = 5050ms
    // - 150 件全部を使ってしまう場合(sample cap バグ): 中央値 = 中央 2 件(75・76 番目 =
    //   7500ms・7600ms)の平均 = 7550ms
    const candidates = Array.from({ length: 150 }, (_, i) => (i + 1) * 100)
    expect(estimateMedianMs(candidates)).toBe(5050)
  })

  it('走査上限(1,000 行)を超えた無効値の連続で全件走査に退化せず既定値に落ちる', () => {
    // 先頭 ESTIMATE_SCAN_LIMIT 行を無効値(0ms)で埋め、1,000 行目より後に有効値を置く。
    // 実装が全件走査してしまうと有効値を拾って既定値以外を返す — それを red で検出する。
    const invalidHead = Array.from({ length: ESTIMATE_SCAN_LIMIT }, () => 0)
    const validTail = [5000]
    expect(estimateMedianMs([...invalidHead, ...validTail])).toBe(
      ESTIMATE_DEFAULT_MS,
    )
  })

  it('走査上限ちょうどの位置にある有効値は含まれる(境界 off-by-one)', () => {
    // 先頭 ESTIMATE_SCAN_LIMIT - 1 行を無効値、ESTIMATE_SCAN_LIMIT 行目(= scanLimit 内
    // 最後の index)に有効値を 1 件置く → 走査対象に含まれ既定値以外を返す。
    const invalidHead = Array.from({ length: ESTIMATE_SCAN_LIMIT - 1 }, () => 0)
    expect(estimateMedianMs([...invalidHead, 5000])).toBe(5000)
  })
})
