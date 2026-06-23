// seed-from-criteria — custom session criteria から決定論的 PRNG を生成する純関数。
// 同一 criteria → 同一乱数系列 を保証することで、プレビューと実セッションが
// 同じ random 順になる (preview == session)。

import type { CustomSessionCriteria } from '@/lib/cards/get-custom-session-cards'

// ---------------------------------------------------------------------------
// mulberry32 PRNG
// ---------------------------------------------------------------------------

// 32-bit PRNG。 seed が同じなら毎回同一系列を返す。
// 参考: https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
function mulberry32(seed: number): () => number {
  let s = seed >>> 0 // 符号なし 32-bit に正規化
  return function () {
    s = (s + 0x6d2b79f5) | 0
    let z = s
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000
  }
}

// ---------------------------------------------------------------------------
// 文字列 → 32-bit hash (FNV-1a 変形)
// ---------------------------------------------------------------------------

// FNV-1a 32-bit (XOR-then-multiply、offset basis 2166136261 / prime 16777619)。
// 暗号用途ではないが、異なる criteria から異なる seed を得るには十分。
function hashString(s: string): number {
  let h = 2166136261 | 0 // FNV offset basis (32-bit)
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) // FNV prime
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// canonical string 構築
// ---------------------------------------------------------------------------

// streakFilter が null の場合に衝突しない固定トークンを使う。
// null と { op: 'lte', value: 0 } を区別するために文字列を使う。
const NULL_STREAK_TOKEN = '__null__'

function buildCanonicalString(
  c: Omit<CustomSessionCriteria, 'userId' | 'limit'>,
): string {
  // examIds: 順序非依存 (ソートして正規化)
  const sortedExamIds = [...c.examIds].sort()

  // tagFilter: キーをソート、各値配列もソート
  const tagFilterStr = Object.keys(c.tagFilter)
    .sort()
    .map((key) => `${key}:[${[...(c.tagFilter[key] ?? [])].sort().join(',')}]`)
    .join(';')

  // streakFilter: null を固定トークン、それ以外は op+value 文字列
  const streakStr =
    c.streakFilter === null
      ? NULL_STREAK_TOKEN
      : `${c.streakFilter.op}:${c.streakFilter.value}`

  // 各フィールドをセパレータ '|' で結合。examIds / tagFilter の key・value は UUID の
  // ため ',' ';' '|' を含まず、'a,b' vs ['a','b'] 等の canonical 衝突は構造的に発生しない。
  return [
    sortedExamIds.join(','),
    tagFilterStr,
    c.answerState,
    streakStr,
    c.order,
  ].join('|')
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * criteria から決定論的 PRNG を生成する。
 *
 * - 同一 criteria → 同一乱数系列 (preview と実セッションで同じ random 順になる)
 * - 異なる criteria → (実質的に) 異なる系列
 * - userId / limit は seed に含めない (同じ出題条件なら同一順序を期待するため)
 *
 * @returns mulberry32 PRNG クロージャ。呼び出すたびに次の乱数を返す。
 */
export function seedFromCriteria(
  c: Omit<CustomSessionCriteria, 'userId' | 'limit'>,
): () => number {
  const canonical = buildCanonicalString(c)
  const seed = hashString(canonical)
  return mulberry32(seed)
}
