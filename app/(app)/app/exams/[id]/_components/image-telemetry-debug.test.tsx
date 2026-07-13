// @vitest-environment jsdom
// 一時デバッグ UI の gate と A/B verdict の unit(原因特定後に本 file ごと撤去する)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { ImageAttachTelemetry } from '@/lib/media/upload'
import {
  ImageTelemetryDebug,
  isImageDebugEnabled,
} from './image-telemetry-debug'

const SAMPLE = { opaqueRatio: 1, meanLuma: 128, lumaVar: 0, edgeEnergy: 0 }

function record(over: Partial<ImageAttachTelemetry>): ImageAttachTelemetry {
  return { outcome: 'error', compressionPath: 'webkit-safe', ...over }
}

beforeEach(() => {
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('isImageDebugEnabled', () => {
  it('既定(param/flag なし)は false = prod で非表示', () => {
    expect(isImageDebugEnabled()).toBe(false)
  })

  it('localStorage flag で有効', () => {
    window.localStorage.setItem('recallmint:imgdebug', '1')
    expect(isImageDebugEnabled()).toBe(true)
  })
})

describe('ImageTelemetryDebug', () => {
  it('gate off なら record があっても何も描画しない', () => {
    const { container } = render(
      <ImageTelemetryDebug record={record({ outcome: 'success' })} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('gate on + record なしなら描画しない', () => {
    window.localStorage.setItem('recallmint:imgdebug', '1')
    const { container } = render(<ImageTelemetryDebug record={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('A(圧縮出力が極小)= 圧縮側の疑いを表示', () => {
    window.localStorage.setItem('recallmint:imgdebug', '1')
    render(
      <ImageTelemetryDebug
        record={record({
          reason: 'validation_failed',
          output: { actualType: 'image/webp', bytes: 856, width: 48, height: 48 },
        })}
      />,
    )
    expect(screen.getByText(/🅰/)).toBeInTheDocument()
    // 856 B は verdict と output 行の両方に出る(複数一致)。
    expect(screen.getAllByText(/856 B/).length).toBeGreaterThan(0)
  })

  it('B(出力に内容あり・なのに reject)= 検証誤 reject の疑いを表示', () => {
    window.localStorage.setItem('recallmint:imgdebug', '1')
    render(
      <ImageTelemetryDebug
        record={record({
          reason: 'validation_failed',
          output: { actualType: 'image/webp', bytes: 44000, width: 1200, height: 900 },
          validationMetrics: {
            input: { ...SAMPLE, lumaVar: 120 },
            output: { ...SAMPLE, lumaVar: 80 },
            mae: 5,
          },
        })}
      />,
    )
    expect(screen.getByText(/🅱/)).toBeInTheDocument()
  })

  it('decode_failed(出力 decode 不能)は size に依らず 🅰(破損)= false-reject でない', () => {
    window.localStorage.setItem('recallmint:imgdebug', '1')
    render(
      <ImageTelemetryDebug
        record={record({
          reason: 'decode_failed',
          // 2KB 超でも decode 不能なら破損(A)。
          output: { actualType: 'image/webp', bytes: 40000, width: 1200, height: 900 },
        })}
      />,
    )
    // decode_failed は size に依らず broken=A(neutral/🅱 でない)。
    expect(screen.getByText(/🅰/)).toBeInTheDocument()
    expect(screen.queryByText(/🅱/)).toBeNull()
  })

  it('fallback_used + 圧縮出力が破損(decode_failed・大サイズ)= 🅰(圧縮側が壊れている疑い)を表示', () => {
    window.localStorage.setItem('recallmint:imgdebug', '1')
    render(
      <ImageTelemetryDebug
        record={record({
          outcome: 'fallback_used',
          compressionPath: 'fallback',
          reason: 'decode_failed',
          output: { actualType: 'image/webp', bytes: 40000, width: 1200, height: 900 },
        })}
      />,
    )
    expect(screen.getByText(/🅰/)).toBeInTheDocument()
  })

  it('fallback_used + 圧縮出力が健全 = 中立(元画像 fallback で成功)を表示', () => {
    window.localStorage.setItem('recallmint:imgdebug', '1')
    render(
      <ImageTelemetryDebug
        record={record({
          outcome: 'fallback_used',
          compressionPath: 'fallback',
          reason: 'validation_failed',
          output: { actualType: 'image/webp', bytes: 40000, width: 1200, height: 900 },
          validationMetrics: {
            input: { ...SAMPLE, lumaVar: 120 },
            output: { ...SAMPLE, lumaVar: 90 },
            mae: 5,
          },
        })}
      />,
    )
    expect(screen.getByText(/元画像 fallback で成功/)).toBeInTheDocument()
    expect(screen.queryByText(/🅰/)).toBeNull()
  })

  it('compressionPath が webkit-safe でない = 判定/分岐の疑いを表示', () => {
    window.localStorage.setItem('recallmint:imgdebug', '1')
    render(
      <ImageTelemetryDebug
        record={record({ compressionPath: 'lib', reason: 'validation_failed' })}
      />,
    )
    expect(screen.getByText(/自前 pipeline 未通過/)).toBeInTheDocument()
  })
})
