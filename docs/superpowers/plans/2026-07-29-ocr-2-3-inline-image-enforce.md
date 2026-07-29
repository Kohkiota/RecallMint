# ②-3 本文 markdown 画像記法の描画側 enforce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans。Steps は checkbox(`- [ ]`)で追跡。

**Goal:** card body 本文の markdown 画像記法 `![…](…)` を描画側単一点(`MdTableSegments`)で除去し、「本文に markdown 画像記法が現れない」を test で契約固定する。

**Architecture:** AST(mdast)で image/imageReference ノードの offset を取り、元文字列から後ろ向きに該当範囲のみ削除する pure helper `stripInlineImages` を作り(**AST を再文字列化しない** = 空白/改行/表整形を壊さない)、全描画経路が収束する `MdTableSegments` で各セグメント値に適用する。remark-parse は既存依存ゆえ**新規依存なし**。

**Tech Stack:** TypeScript strict / Vitest / remark-parse + remark-gfm(既存)/ react-markdown(既存)。

## Global Constraints(spec verbatim・全 task に暗黙適用)

- **AST ノードの offset で削除・再文字列化しない**(regex 字面除去は code span/block/escape/nested paren/reference を誤り正解選択肢を消す・AST 再文字列化は「改行 \n 保持」prompt ルール + segmentMdTables 不変条件に衝突)。
- **新規依存なし**(remark-parse/remark-gfm = 既存・segment-md-tables.ts と同 processor)。必要になれば**停止して OT 相談**。
- **凍結**: prompt / schema / OCR pipeline / storage 形式 / `segmentMdTables` の不変条件(`value 連結 === 入力`)。触る必要が出たら停止。
- **除去方針**: 任意の `![alt](url)` を除去(OCR key pattern 非依存)/ 表内も alt を出さず非表示に統一。
- **空白ルール**: 全体 trim/圧縮禁止。行唯一の画像 → 行削除(orphaned 空行なし)/ 段落途中 → 構文のみ / 表セル内 → セル空・区切り `|` 温存。
- **完了 gate(全 exit 0)**: whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit`。
- **既存 flaky**(`inline-text-field` / `card-image-gallery`)は当該 file 単体 PASS で切り分け報告(retry 糊塗禁止)。
- **commit**: helper + md-table-text + test を **1 commit**(`feat(markdown)` + `[reviewed]`・canonical + Codex)。実 API 不使用。

> **行数の記録(OT 判断 2026-07-29)**: 本 plan は 311 行で CLAUDE.md「300 行超で STOP・OT 相談」に該当するが、**超過分はほぼ全て writing-plans の no-placeholder 原則が要求する具体コード(test 約 55 行 + 実装約 55 行)であり、設計スコープは小(3 task / 1 commit / helper 1 本 + 配線 1 箇所)**。閾値は設計スコープ膨張の検知装置であり本件は趣旨に抵触しない。要約圧縮は実装時の CC 判断余地を増やし逆効果ゆえ **OT 判断で 311 行のまま続行**。次に同状況が来た際の前例として記録。

---

## Task 1: `stripInlineImages` helper(AST-offset 削除)

**目的:** mdast の image/imageReference ノードの offset を取り、元文字列から後ろ向きに削除する pure helper を作る。

**Files:**
- Create: `lib/markdown/strip-inline-images.ts`
- Test: `lib/markdown/strip-inline-images.test.ts`

**Interfaces:**
- Produces: `stripInlineImages(text: string): string`(pure・冪等)

- [ ] **Step 1: 失敗する test を書く**

`lib/markdown/strip-inline-images.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { stripInlineImages } from './strip-inline-images'

// 性質ベース: 除去後に image/imageReference ノード 0 件
function imageNodeCount(text: string): number {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text) as {
    type: string; children?: unknown[]
  }
  let n = 0
  const walk = (node: { type: string; children?: unknown[] }) => {
    if (node.type === 'image' || node.type === 'imageReference') n++
    for (const c of (node.children ?? []) as { type: string; children?: unknown[] }[]) walk(c)
  }
  walk(tree)
  return n
}

describe('stripInlineImages', () => {
  it('段落途中の画像は構文のみ除去(周囲 text 保持・日本語隣接は空白足さない)', () => {
    expect(stripInlineImages('図a![下図](q1-img-1)この図')).toBe('図aこの図')
  })
  it('行唯一の画像は行ごと除去(orphaned 空行を残さない)', () => {
    expect(stripInlineImages('選べ。\n\n![下図](q1-img-1)\n続き')).toBe('選べ。\n\n続き')
  })
  it('nested paren / angle URL / title を除去', () => {
    expect(stripInlineImages('![a](foo(bar))')).toBe('')
    expect(stripInlineImages('![a](<foo bar>)')).toBe('')
    expect(stripInlineImages('![a](url "t")')).toBe('')
  })
  it('reference 記法 ![a][id] を除去(definition 行は MVP 範囲外で残る)', () => {
    const out = stripInlineImages('前![a][id]後\n\n[id]: http://x')
    expect(out).toContain('前後')
    expect(out).not.toContain('![a]')
  })
  it('code span 内は残す(正解選択肢を消さない)', () => {
    expect(stripInlineImages('`![a](x)`')).toBe('`![a](x)`')
  })
  it('code block 内は残す', () => {
    const src = '```\n![a](x)\n```'
    expect(stripInlineImages(src)).toBe(src)
  })
  it('escape された \\![a](x) は残す(image でなく link 扱い)', () => {
    expect(stripInlineImages('\\![a](x)')).toBe('\\![a](x)')
  })
  it('非画像 link は残す', () => {
    expect(stripInlineImages('[link](url)')).toBe('[link](url)')
  })
  it('画像なしは no-op', () => {
    expect(stripInlineImages('ただの文\n本文が続く')).toBe('ただの文\n本文が続く')
  })
  it('表セル内画像 → セル空・区切り | 温存(行/列不変)', () => {
    expect(stripInlineImages('| A | ![x](p) |')).toBe('| A |  |')
  })
  it('冪等: strip(strip(x)) === strip(x)', () => {
    for (const i of ['図![a](x)図', '選べ。\n\n![a](x)\n続き', '`![a](x)`', '| A | ![x](p) |']) {
      const once = stripInlineImages(i)
      expect(stripInlineImages(once)).toBe(once)
    }
  })
  it('性質: 除去後に image/imageReference ノード 0', () => {
    for (const i of ['図![a](x)', '![a](<f b>)', '| A | ![x](p) |', '前![a][id]後\n\n[id]: http://x']) {
      expect(imageNodeCount(stripInlineImages(i))).toBe(0)
    }
  })
})
```

- [ ] **Step 2: red 確認**

Run: `pnpm vitest run lib/markdown/strip-inline-images.test.ts`
Expected: FAIL(`stripInlineImages` 未定義)。

- [ ] **Step 3: 実装**

`lib/markdown/strip-inline-images.ts`:

```ts
// 本文の markdown 画像記法(image / imageReference)を除去する pure 関数(②-3)。
// AST(mdast)でノードの position offset を取り、元文字列から後ろ向きに該当範囲だけ
// 削除する。AST を再文字列化しない(空白/改行/表整形を壊さない = 「改行 \n 保持」
// prompt ルール + segmentMdTables 不変条件と両立)。regex 字面除去は code span/block/
// escape/nested paren/reference を誤るため使わない。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false })

type MdNode = {
  type: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MdNode[]
}

function collectImageRanges(node: MdNode, out: Array<{ start: number; end: number }>): void {
  if (node.type === 'image' || node.type === 'imageReference') {
    const s = node.position?.start.offset
    const e = node.position?.end.offset
    if (typeof s === 'number' && typeof e === 'number' && e > s) out.push({ start: s, end: e })
  }
  for (const c of node.children ?? []) collectImageRanges(c, out)
}

// 画像ノード [start,end) を削除範囲へ拡張。行唯一(前後が空白のみ)なら行 + 末尾改行 1 個
// まで飲む(orphaned 空行を残さない)。それ以外(段落途中 / 表セル内)は構文のみ。
function expandRange(text: string, start: number, end: number): { from: number; to: number } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  let lineEnd = text.indexOf('\n', end)
  if (lineEnd === -1) lineEnd = text.length
  const lineSole = text.slice(lineStart, start).trim() === '' && text.slice(end, lineEnd).trim() === ''
  if (!lineSole) return { from: start, to: end }
  return { from: lineStart, to: lineEnd < text.length ? lineEnd + 1 : lineEnd }
}

export function stripInlineImages(text: string): string {
  if (!text.includes('![')) return text // fast path: 画像マーカー無しは parse しない
  const tree = processor.parse(text) as unknown as MdNode
  const raw: Array<{ start: number; end: number }> = []
  collectImageRanges(tree, raw)
  if (raw.length === 0) return text
  const expanded = raw.map((r) => expandRange(text, r.start, r.end)).sort((a, b) => b.from - a.from)
  let out = text
  let lastFrom = Infinity
  for (const { from, to } of expanded) {
    const clampedTo = Math.min(to, lastFrom) // 同一行複数画像等の重複を回避
    if (from >= clampedTo) continue
    out = out.slice(0, from) + out.slice(clampedTo)
    lastFrom = from
  }
  return out
}
```

- [ ] **Step 4: green 確認**

Run: `pnpm vitest run lib/markdown/strip-inline-images.test.ts`
Expected: PASS(全 case)。期待値が remark の実挙動と 1 文字でもズレたら、**決定した挙動を test に pin**(空白ルールは §Global の 3 分岐に従う)。

**完了条件:** helper が全 test green / 冪等 pin / 性質 pin(image ノード 0)/ code span・block・escape で正解選択肢を消さないことを実証。**この時点では commit しない**(§commit 構成: 1 commit)。

---

## Task 2: `MdTableSegments` に配線 + 契約 test 更新

**目的:** 全描画経路が収束する `MdTableSegments` で各セグメント値に `stripInlineImages` を適用し、img override を alt→null に変更。既存 alt-display test を契約(非表示)へ更新。

**Files:**
- Modify: `components/markdown/md-table-text.tsx`(`MdTableSegments` に strip / `COMPONENTS.img` を null)
- Test: `components/markdown/md-table-text.test.tsx`(:28-34 更新 + text セグメント test 追加)

**Interfaces:**
- Consumes: `stripInlineImages`(Task 1)

- [ ] **Step 1: 契約 test を更新/追加(先に test = red)**

`components/markdown/md-table-text.test.tsx`:
- :28-34 の `it('画像記法 → <img> 不在・alt テキスト表示', …)` を以下へ**置換**(alt も出さない契約):

```tsx
  it('表内画像記法 → <img> も alt も出さない(契約: 本文に画像記法が現れない)', () => {
    const { container } = render(
      <MdTableText value={'| 薬剤 | 画像 |\n|---|---|\n| A | ![薬剤画像](https://x.test/y.png) |'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('薬剤画像')
    expect(container.querySelector('table')).not.toBeNull() // 表構造は保持(区切り温存)
  })
```

- 末尾(`表入り` test の後)に text セグメント契約 test を**追加**:

```tsx
  it('text セグメントの画像記法 → literal も img も出さない(行ごと除去)', () => {
    const { container } = render(<MdTableText value={'問題文は次のとおり。\n\n![下図](q1-img-1)\n続きの本文'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('![')
    expect(container.textContent).not.toContain('q1-img-1')
    expect(container.textContent).toContain('問題文は次のとおり。')
    expect(container.textContent).toContain('続きの本文')
  })
```

- [ ] **Step 2: red 確認**

Run: `pnpm vitest run components/markdown/md-table-text.test.tsx`
Expected: FAIL(現状は table image が alt「薬剤画像」を表示・text セグメントは literal `![下図]` を表示)。

- [ ] **Step 3: 実装(配線 + img override)**

`components/markdown/md-table-text.tsx`:
- import 追加: `import { stripInlineImages } from '@/lib/markdown/strip-inline-images'`。
- `COMPONENTS.img` を変更: `img: ({ alt }) => <>{alt ?? ''}</>` → `img: () => null,`(コメント更新: 契約=本文に画像記法が現れない・alt も出さない)。
- `MdTableSegments` で各セグメント値に strip を適用(useMemo で memo 化):

```tsx
export function MdTableSegments({ segments }: { segments: MdSegment[] }) {
  // ②-3: 全描画経路が通る単一点。各セグメント値から inline 画像記法を除去する
  // (text=raw 描画ゆえ literal 露出を防ぐ / table=react-markdown 前に除去)。
  const stripped = React.useMemo(
    () => segments.map((s) => ({ type: s.type, value: stripInlineImages(s.value) })),
    [segments],
  )
  return (
    <>
      {stripped.map((seg, i) =>
        seg.type === 'text' ? (
          <React.Fragment key={i}>{seg.value}</React.Fragment>
        ) : (
          <Markdown key={i} remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
            {seg.value}
          </Markdown>
        ),
      )}
    </>
  )
}
```

- [ ] **Step 4: green 確認 + 回帰**

Run: `pnpm vitest run components/markdown/md-table-text.test.tsx lib/markdown/segment-md-tables.test.ts`
Expected: PASS(更新した 2 契約 test green・既存 table/link/tilde/末尾改行 test も green=画像なし入力は strip no-op)。
Run: `pnpm typecheck` → 0。

**完了条件:** MdTableSegments が strip 適用 / img override null / 契約 test(表内・表外とも非表示)green / 既存 md-table-text / segment 回帰なし / typecheck 0。

---

## Task 3: 完了 gate + review + 単一 commit + stop

**目的:** whole-repo gate → canonical + Codex → 1 commit `[reviewed]` → 停止。

- [ ] **Step 1: 完了 gate**

```bash
pnpm lint --max-warnings=0
pnpm typecheck
pnpm build
pnpm test
pnpm test:iso
pnpm run audit
```
各 exit 0。`pnpm test` 既存 flaky は当該 file 単体 PASS で切り分け。

- [ ] **Step 2: canonical + Codex review**

canonical(`superpowers:requesting-code-review`・general-purpose + template 改変なし・観点に whole-repo lint / test:iso / **AST-offset で再文字列化していないこと / code span・escape で正解選択肢を消さないこと / segmentMdTables 不変条件を触っていないこと**を含む)+ Codex(`scripts/ai/codex-review.sh ocr-2-3-inline-image`)。未解決 Critical 0 かつ Important 0 まで(上限 3 周)。

- [ ] **Step 3: 単一 commit**

commit 直前宣言(chat 4 点)+ 「**red 検証**」記録(Task 1 Step 2 / Task 2 Step 2 の red)。
```bash
git add lib/markdown/strip-inline-images.ts lib/markdown/strip-inline-images.test.ts components/markdown/md-table-text.tsx components/markdown/md-table-text.test.tsx
git commit -m "feat(markdown): 本文 markdown 画像記法を描画側で除去(AST-offset・契約 test 固定) [reviewed]"
```

- [ ] **Step 4: stop checkpoint 報告**

chat に結論のみ: gate 各 exit 0(「whole-repo lint exit 0 確認済」「test:iso green 確認済」「pnpm run audit exit 0 確認済」明記)/ commit SHA / red 検証 / 契約 pin(表内外とも画像記法非表示 + 冪等 + 再 parse 0 ノード)を報告して**停止**(smoke 要否 = OT 判断・描画変更ゆえ stg smoke 候補)。

**完了条件:** 全 gate exit 0 / canonical + Codex Critical 0 Important 0 / 1 commit `[reviewed]` + red 検証記録 / OT 停止。

---

## Self-Review

- **Spec coverage:** §4.2 単一点(MdTableSegments)= Task 2 / §4.3 AST-offset helper = Task 1 / §6 test(冪等・性質・edge case・契約更新)= Task 1 + Task 2 Step 1 / §5 gate = Task 3 / §3 凍結 = Global Constraints。§7 持ち越し(②-4)は spec 記録済ゆえ task 化しない。全 spec 項に対応。
- **Placeholder scan:** TBD/TODO なし。全 code step に具体コード。空白ルールの「日本語隣接」は Task 1 test で pin(決定を明記)。
- **Type consistency:** `stripInlineImages(text: string): string` は Task 1 定義 = Task 2 import と一致。`MdSegment` は既存 export。
