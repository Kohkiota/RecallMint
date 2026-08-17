// sync_meta 直接 access の許可 file 限定 audit(S-local-2 Task 3 / spec §4.2, OT 裁定 2)。
//
// Dexie の `.sync_meta` table への直接 access(`.get` / `.put` / `.clear` 等)を
// lib/sync/sync-meta.ts(定義本体)/ lib/sync/pull.ts(cursor 6本の唯一の reader/writer)
// に限定する grep audit。 他 file は必ず sync-meta.ts の helper(getSyncMeta /
// getJsonSyncMeta / setJsonSyncMeta / scopedSyncMetaKey)経由にすることで、
// owner scoping(scopedSyncMetaKey による userId 名前空間化)を迂回する直接書込を
// 構造的に防ぐ。 現状 green で開始し、以後の退行(許可外 file での直接 access)を
// 検出する gate になる。
//
// test 自身(本 file)と test file(*.test.ts(x))は audit 対象外(production コードのみ)。

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')

// 許可 file(2026-08-16 実装時点で全 repo grep して確定 — 他に `.sync_meta` へ直接
// access する production file は無い)。 新規に直接 access が必要になった場合は
// 本 list を明示更新すること(暗黙の拡大を防ぐため追加理由をコミットに残す)。
// hygiene sprint Task 4: local-hygiene.ts を追加。 purge / sweep は sync_meta を
// 「mirror と同一 tx で消す」 ことが要件(部分実行を作らない — spec §0 条件 1)ゆえ、
// key 単位 helper では表現できず table を直接掴む正当な writer。
const ALLOWED_FILES = new Set([
  'lib/sync/sync-meta.ts',
  'lib/sync/pull.ts',
  'lib/sync/local-hygiene.ts',
])

// production コードのみ対象。 test file(*.test.ts(x))と tests/** 配下は audit 対象外
// (check-review.sh の test-only 判定と同じ境界に揃える)。
function isProductionFile(relPath: string): boolean {
  if (/\.test\.tsx?$/.test(relPath)) return false
  if (relPath.startsWith('tests/')) return false
  return true
}

describe('sync_meta 直接 access の許可 file 限定 audit(pin③)', () => {
  it('production コードで .sync_meta への直接 access は許可 file 限定', () => {
    const tracked = execSync('git ls-files -- "*.ts" "*.tsx"', {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)

    const violations: string[] = []
    for (const relPath of tracked) {
      if (!isProductionFile(relPath)) continue
      if (ALLOWED_FILES.has(relPath)) continue
      const source = readFileSync(path.join(ROOT, relPath), 'utf8')
      // property access のみを対象にする(`.sync_meta` の直前にドットが必要)。
      // コメント上の素の "sync_meta" 言及(型名・schema key 定義等)は誤検知させない。
      if (/\.sync_meta\b/.test(source)) {
        violations.push(relPath)
      }
    }

    expect(
      violations,
      `許可 file 外での .sync_meta 直接 access を検出: ${violations.join(', ')}。` +
        ' sync-meta.ts の helper(getSyncMeta/getJsonSyncMeta/setJsonSyncMeta)経由にすること。',
    ).toEqual([])
  })

  it('許可 file 自体は現に .sync_meta へ直接 access している(list が陳腐化していないことの確認)', () => {
    for (const relPath of ALLOWED_FILES) {
      const source = readFileSync(path.join(ROOT, relPath), 'utf8')
      expect(
        /\.sync_meta\b/.test(source),
        `${relPath} は許可 file だが .sync_meta 直接 access が見当たらない(ALLOWED_FILES が陳腐化していないか確認)`,
      ).toBe(true)
    }
  })
})
