'use client'

// 一時デバッグ UI(iOS/WebKit 圧縮修正の iPad 実機診断・**原因特定後に撤去**する)。
// Mac/コンソール不要で、 画像添付 1 回ごとの telemetry を iPad の画面に人間可読で表示し、
// OT がスクショで原因を確定できるようにする:
//   A) 圧縮側がまだ壊れた output(≈856B/空)を出しているのか
//   B) 圧縮は健全だが検証が正常 output を誤 reject しているのか
// URL に `?imgdebug=1` を付けた時のみ表示する(prod では既定 off = 常に非表示)。

import { useState } from 'react'
import type { ImageAttachTelemetry } from '@/lib/media/upload'

// prod に出さないための gate。 ?imgdebug=1(iPad で URL に付与)or localStorage flag。
export function isImageDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('imgdebug') === '1') return true
    return window.localStorage.getItem('recallmint:imgdebug') === '1'
  } catch {
    return false
  }
}

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}

function num(v: number | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—'
}

// 当たりを 1 行で示す(OT がスクショだけで判断できるように)。 assertive な A/B 断定は
// 避け、 record が実際に取りうる状態だけで判定する(検証の reject 条件は「出力が空
// (lumaVar<4 / opaqueRatio<0.01)」ゆえ、 validation reject は常に出力が空=A になる。
// もし出力に内容があるのに validation reject されていたら検証ロジック側の異常=B の疑い)。
function outputIsBlank(record: ImageAttachTelemetry): boolean {
  const { output, validationMetrics: vm } = record
  // 圧縮出力が極小(≈856B の破損)or 出力の輝度分散が入力より大きく落ちて≈0(空描画)。
  if (output && output.bytes < 2048) return true
  if (vm && vm.input.lumaVar > 4 && vm.output.lumaVar < 4) return true
  return false
}

// 圧縮出力が壊れている(A の核心)= 出力が decode 不能(decode_failed)、 or 空/極小
// (outputIsBlank)。 fallback_used / error のどちらの経路でも同一基準で判定する
// (Codex 指摘: 経路ごとに漏れると診断がぶれる)。
function compressOutputBroken(record: ImageAttachTelemetry): boolean {
  return record.reason === 'decode_failed' || outputIsBlank(record)
}

function verdict(record: ImageAttachTelemetry): string {
  const { compressionPath, output, outcome, reason } = record
  if (outcome === 'success') return '✅ 成功'

  const size = output ? fmtBytes(output.bytes) : '—'
  if (compressionPath !== 'webkit-safe' && compressionPath !== 'fallback') {
    return `⚠️ path=${compressionPath}(自前 pipeline 未通過=判定/分岐の疑い)`
  }

  const broken = compressOutputBroken(record)

  if (outcome === 'fallback_used') {
    // 圧縮/検証は失敗したが元画像で成功。 圧縮出力が破損だったか(A)を明示する。
    return broken
      ? `🅰 圧縮出力が破損/空(${size}・reason=${reason ?? '—'})→元画像 fallback で成功。 圧縮側が壊れている疑い`
      : `元画像 fallback で成功(reason=${reason ?? '—'}・圧縮出力=${size})`
  }

  // outcome === 'error'
  if (reason === 'decode_failed' || reason === 'validation_failed') {
    // validation reject は「出力が空/塗り潰し」でのみ発火し、 decode_failed は出力が decode
    // 不能。 いずれも broken=A(検証は正しく reject)。 broken でないのに検証 reject された
    // 場合のみ検証ロジック側の異常(B の疑い・現行検証では通常起きない)。
    return broken
      ? `🅰 圧縮出力が破損/空(${size})= 圧縮側が破損 → 検証は正しく reject`
      : `🅱 出力は健全に見える(${size})のに検証 reject = 検証ロジックの誤 reject 疑い(要調査)`
  }
  // reserve/upload/finalize/compress_failed 等の後段・その他失敗。
  return `失敗: reason=${reason ?? '—'}(圧縮出力=${size})`
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-200 py-0.5">
      <span className="text-slate-500">{label}</span>
      <span className="text-right font-mono text-slate-800 break-all">{value}</span>
    </div>
  )
}

export function ImageTelemetryDebug({
  record,
}: {
  record: ImageAttachTelemetry | null
}) {
  const [open, setOpen] = useState(true)
  if (!isImageDebugEnabled() || !record) return null

  const { outcome, reason, compressionPath, source, output, validationMetrics: vm } = record

  return (
    <div className="mt-2 w-full max-w-md rounded border border-amber-300 bg-amber-50 p-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between font-semibold text-amber-900"
      >
        <span>🐞 画像 telemetry(診断・撤去予定)</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>

      <p className="mt-1 font-semibold text-amber-900">{verdict(record)}</p>

      {open && (
        <div className="mt-2 space-y-2">
          <div>
            <Row label="outcome" value={`${outcome}${reason ? ` / ${reason}` : ''}`} />
            <Row label="compressionPath" value={compressionPath} />
          </div>

          {source && (
            <div>
              <p className="text-slate-500">source(元画像)</p>
              <Row label="type" value={source.type || '(空)'} />
              <Row label="bytes" value={fmtBytes(source.bytes)} />
              {source.width != null && (
                <Row label="w×h" value={`${source.width}×${source.height}`} />
              )}
            </div>
          )}

          {output && (
            <div>
              <p className="text-slate-500">output(圧縮/fallback 出力)</p>
              <Row label="type" value={output.actualType} />
              {output.requestedType && (
                <Row label="requested" value={output.requestedType} />
              )}
              <Row label="bytes" value={fmtBytes(output.bytes)} />
              <Row label="w×h" value={`${output.width}×${output.height}`} />
            </div>
          )}

          {vm && (
            <div>
              <p className="text-slate-500">検証メトリクス(入力 → 出力)</p>
              <Row
                label="alpha率"
                value={`${num(vm.input.opaqueRatio)} → ${num(vm.output.opaqueRatio)}`}
              />
              <Row
                label="輝度分散"
                value={`${num(vm.input.lumaVar)} → ${num(vm.output.lumaVar)}`}
              />
              <Row
                label="edge"
                value={`${num(vm.input.edgeEnergy)} → ${num(vm.output.edgeEnergy)}`}
              />
              <Row label="MAE" value={num(vm.mae)} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
