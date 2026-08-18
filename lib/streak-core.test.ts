// streak-core — STREAK_WINDOW_DAYS / formatStreakDisplay の pin(定義 doc §4-O・
// pin 12)。fix round 1/5 I-3(controller 裁定)で lib/client/streak.ts から移設した
// (Dexie を import する module に置くと、server 側の将来消費者が Dexie を server
// graph に引き込む罠になるため)。computeStreak / addDays の pin は既存どおり
// lib/client/streak.test.ts(client 側の消費経路を通した検証)/ lib/db/streak.test.ts
// (server 側)に残る — 本 file はこの 2 定数の pin のみを持つ。

import { describe, it, expect } from 'vitest'
import { formatStreakDisplay, STREAK_WINDOW_DAYS } from './streak-core'

describe('STREAK_WINDOW_DAYS', () => {
  it('61(today + 過去 60 日)', () => {
    expect(STREAK_WINDOW_DAYS).toBe(61)
  })
})

describe('formatStreakDisplay (定義 doc §4-O・pin 12: 61 頭打ちの表記)', () => {
  it('pin 12: window 上限(61)に達した streak(62 日連続の fixture)は「61 日以上」', () => {
    // computeStreak 自体が window 61 日で頭打ちになるため、実際に渡ってくる値は
    // 最大でも STREAK_WINDOW_DAYS(61) — ここでは「62 日連続していた」という前提の
    // fixture 値として STREAK_WINDOW_DAYS をそのまま渡す(= computeStreak の頭打ち後の値)。
    expect(formatStreakDisplay(STREAK_WINDOW_DAYS)).toBe('61 日以上')
  })

  it('window 未満の streak は「◯日」とそのまま表示する', () => {
    expect(formatStreakDisplay(STREAK_WINDOW_DAYS - 1)).toBe('60 日')
    expect(formatStreakDisplay(1)).toBe('1 日')
    expect(formatStreakDisplay(0)).toBe('0 日')
  })
})
