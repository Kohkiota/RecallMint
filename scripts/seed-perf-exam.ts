#!/usr/bin/env tsx
// scripts/seed-perf-exam.ts — Grid-1 T7 stg perf 観測用 seed
//
// ============================================================
// USAGE
// ============================================================
// 1. stg DATABASE_URL を .env.local または環境変数で設定
//    例: DATABASE_URL=postgres://... pnpm tsx --conditions=react-server scripts/seed-perf-exam.ts ...
//    または: dotenv -e .env.stg-seed pnpm tsx --conditions=react-server scripts/seed-perf-exam.ts ...
//
//    注: `--conditions=react-server` は必須フラグ。
//        本 script は `getDb()` (lib/db/index.ts) 経由で DB に接続するが、
//        同 module は `import 'server-only'` を持つため、 tsx をそのまま実行すると
//        runtime guard で throw する。 `--conditions=react-server` を付与することで
//        server-only package が empty.js (no-op) に解決され、 script が正常起動する。
//        (vitest.config.ts の `server-only` alias stub と同じ原理)
//
// 2. 対象 user の DB id (UUID) を取得
//    Supabase Studio: users テーブルで Clerk ID から内部 UUID を確認
//    Clerk Dashboard: External ID / clerk_id 列から逆引き可
//
// 3. 確認 (DB 書込なし):
//    pnpm tsx --conditions=react-server scripts/seed-perf-exam.ts \
//      --dry-run --user-id=<uuid>
//
// 4. 実行:
//    pnpm tsx --conditions=react-server scripts/seed-perf-exam.ts \
//      --user-id=<uuid>
//    (カード数デフォルト 300。変更する場合: --cards=N)
//
// 5. 観測完了後 cleanup:
//    pnpm tsx --conditions=react-server scripts/seed-perf-exam.ts \
//      --user-id=<uuid> --cleanup
//
// ============================================================
// 動作
// ============================================================
// 通常実行:
//   - 「難易度」「分野」「年度」「形式」の 4 タグカテゴリを find-or-create
//   - 各カテゴリの選択肢を find-or-create
//   - [PERF-SEED] prefix + タイムスタンプ付き試験を INSERT (cardCount=0 初期)
//   - 300 件カードを chunk(50) で INSERT
//   - 各カードに 4-7 個のタグを割り当て、 card_tags を chunk(100) で INSERT
//   - exams.card_count を最終更新
//
// --cleanup:
//   - 同 user の "[PERF-SEED]%" 試験を全削除 (FK CASCADE で cards/card_tags も削除)
//   - tagCategories / tagOptions は削除しない (他の PERF-SEED 試験での再利用を想定)
//
// --dry-run:
//   - DB 書込をせず、生成予定の rows を console 出力して終了
//
// ============================================================
// 安全性 (prod guard 多層防御)
// ============================================================
// L1: VERCEL_ENV=production または NODE_ENV=production の場合 即 exit(1)
// L2: DATABASE_URL に "stg"/"test"/"dev"/"localhost"/"127.0.0.1" のいずれかが
//     含まれない場合 exit(1)。 stg DB URL がこれらを含まない場合は SEED_FORCE=1 で bypass 可
// L3: --user-id CLI flag 必須 (未指定で exit(1))
//
// SEED_FORCE=1:
//   L2 の DATABASE_URL token check を bypass する環境変数。
//   L1 (VERCEL_ENV/NODE_ENV production) は SEED_FORCE=1 でも bypass 不可。
//
// ============================================================
// 冪等性
// ============================================================
// - 毎回タイムスタンプ付き試験名で新規作成 → 再実行で別試験が作られる (重複しない)
// - tagCategories / tagOptions は find-or-create → 同 user 内で同名カテゴリ重複なし
//   (tagCategories は UNIQUE 制約なしのため、 事前 SELECT で重複を防ぐ)
// - --cleanup で [PERF-SEED]% 試験をまとめて削除可能

import 'dotenv/config'
import { and, eq, like, sql } from 'drizzle-orm'
import { getDb, closeDb } from '@/lib/db'
import {
  exams,
  cards,
  tagCategories,
  tagOptions,
  cardTags,
} from '@/lib/db/schema'
import type { CardOption } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// CLI args parser (--key=value / --flag pattern)
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const withoutDash = arg.slice(2)
      const eqIdx = withoutDash.indexOf('=')
      if (eqIdx === -1) {
        result[withoutDash] = true
      } else {
        result[withoutDash.slice(0, eqIdx)] = withoutDash.slice(eqIdx + 1)
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------
function pickRandomN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, n)
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// ---------------------------------------------------------------------------
// JP lorem ipsum (line-clamp-2 が効く 200-300 字レベルの日本語ダミー文)
// ---------------------------------------------------------------------------
const JP_LOREM =
  'この問題は perf 観測専用のダミー問題です。実際の試験には使用しないでください。' +
  '学習データのパフォーマンス検証を目的として生成されており、問題文の内容に意味はありません。' +
  'ExamCardTable および TagCell コンポーネントの描画速度、タグポップオーバーのマウントコスト、' +
  'カードビューとテーブルビューのウォールクロック比較を観測するために設計されています。' +
  '本データは観測完了後に --cleanup フラグで一括削除できます。問題数や構成は CLI フラグで調整可能です。'

// ---------------------------------------------------------------------------
// Tag dictionary (カテゴリ定義、 seed の核心)
// ---------------------------------------------------------------------------
interface TagCategoryDef {
  name: string
  selectType: 'single' | 'multi'
  options: string[]
  /** 各カードに何個選ぶか (min, max) */
  pickCount: [number, number]
}

const TAG_CATEGORIES: TagCategoryDef[] = [
  {
    name: '難易度',
    selectType: 'single',
    options: ['易', '中', '難'],
    pickCount: [1, 1],
  },
  {
    name: '分野',
    selectType: 'multi',
    options: ['数学', '物理', '化学', '生物', '英語', '国語'],
    pickCount: [1, 2],
  },
  {
    name: '年度',
    selectType: 'multi',
    options: ['2020', '2021', '2022', '2023', '2024'],
    pickCount: [1, 1],
  },
  {
    name: '形式',
    selectType: 'multi',
    options: ['計算', '論述', '暗記', '穴埋め'],
    pickCount: [1, 3],
  },
]

// ---------------------------------------------------------------------------
// Chunk helper
// ---------------------------------------------------------------------------
function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // =========================================================================
  // L1 guard: VERCEL_ENV / NODE_ENV
  // =========================================================================
  if (
    process.env.VERCEL_ENV === 'production' ||
    process.env.NODE_ENV === 'production'
  ) {
    console.error(
      '❌ REFUSING TO SEED PRODUCTION (VERCEL_ENV/NODE_ENV=production)',
    )
    process.exit(1)
  }

  // =========================================================================
  // L2 guard: DATABASE_URL token check
  // =========================================================================
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('❌ DATABASE_URL is not set')
    process.exit(1)
  }
  const safeTokens = ['stg', 'test', 'dev', 'localhost', '127.0.0.1']
  const looksSafe = safeTokens.some((token) =>
    dbUrl.toLowerCase().includes(token),
  )
  if (!looksSafe && process.env.SEED_FORCE !== '1') {
    console.error(
      '⚠️  DATABASE_URL に "stg"/"test"/"dev"/"localhost"/"127.0.0.1" が含まれない → prod 疑い',
    )
    console.error(
      '   stg DB URL が legitimately これらを含まない場合は SEED_FORCE=1 で bypass',
    )
    process.exit(1)
  }

  // =========================================================================
  // L3 guard: --user-id 必須
  // =========================================================================
  const userId = args['user-id']
  if (!userId || typeof userId !== 'string') {
    console.error('❌ --user-id=<uuid> は必須です')
    console.error(
      'Usage: pnpm tsx --conditions=react-server scripts/seed-perf-exam.ts --user-id=<uuid> [--cards=300] [--cleanup] [--dry-run]',
    )
    process.exit(1)
  }

  // CLI flags
  const cardCount =
    args['cards'] !== undefined ? parseInt(String(args['cards']), 10) : 300
  const cleanup = args['cleanup'] === true
  const dryRun = args['dry-run'] === true

  if (isNaN(cardCount) || cardCount < 1) {
    console.error(`❌ --cards に無効な値: ${args['cards']}`)
    process.exit(1)
  }

  console.log('[seed-perf-exam] 設定:')
  console.log(`  user-id  : ${userId}`)
  console.log(`  cards    : ${cardCount}`)
  console.log(`  cleanup  : ${cleanup}`)
  console.log(`  dry-run  : ${dryRun}`)
  console.log(`  SEED_FORCE: ${process.env.SEED_FORCE === '1' ? 'ON (L2 bypass)' : 'OFF'}`)

  const db = getDb()

  // =========================================================================
  // --cleanup: [PERF-SEED]% 試験を全削除
  // =========================================================================
  if (cleanup) {
    console.log('\n[seed-perf-exam] --cleanup: [PERF-SEED]% 試験を削除中...')
    if (dryRun) {
      // dry-run: 削除対象を表示するだけ
      const targets = await db
        .select({ id: exams.id, name: exams.name })
        .from(exams)
        .where(
          and(
            eq(exams.userId, userId),
            like(exams.name, '[PERF-SEED]%'),
          ),
        )
      if (targets.length === 0) {
        console.log('  (削除対象なし)')
      } else {
        console.log(`  [DRY-RUN] 削除予定 ${targets.length} 件:`)
        for (const t of targets) {
          console.log(`    - ${t.id} "${t.name}"`)
        }
      }
      console.log('[seed-perf-exam] dry-run cleanup 完了 (DB 書込なし)')
      return
    }

    const deleted = await db
      .delete(exams)
      .where(
        and(
          eq(exams.userId, userId),
          like(exams.name, '[PERF-SEED]%'),
        ),
      )
      .returning({ id: exams.id, name: exams.name })

    if (deleted.length === 0) {
      console.log('  削除対象なし (既に cleanup 済みか、 seed が未実行)')
    } else {
      console.log(`  ✅ ${deleted.length} 件の試験を削除しました (FK CASCADE で cards/card_tags も削除)`)
      for (const d of deleted) {
        console.log(`    - ${d.id} "${d.name}"`)
      }
    }
    console.log('[seed-perf-exam] cleanup 完了')
    return
  }

  // =========================================================================
  // Seed flow
  // =========================================================================

  // -------------------------------------------------------------------------
  // Step 1: find-or-create tag categories + options
  // -------------------------------------------------------------------------
  console.log('\n[seed-perf-exam] Step 1: タグカテゴリ / 選択肢 の find-or-create...')

  // { categoryName -> { categoryId, options: { name -> optionId } } }
  const categoryMap: Record<
    string,
    { id: string; options: Record<string, string> }
  > = {}

  for (const catDef of TAG_CATEGORIES) {
    // SELECT — 同 user 内で同名カテゴリ検索 (UNIQUE 制約なし、 先頭1行を使用)
    const existingCats = await db
      .select({ id: tagCategories.id })
      .from(tagCategories)
      .where(
        and(
          eq(tagCategories.userId, userId),
          eq(tagCategories.name, catDef.name),
        ),
      )
      .limit(1)

    let catId: string
    if (existingCats.length > 0) {
      catId = existingCats[0].id
      console.log(`  カテゴリ "${catDef.name}" 既存 (id=${catId})`)
    } else {
      if (dryRun) {
        // dry-run では仮 UUID を使う
        catId = `dry-run-cat-${catDef.name}`
        console.log(`  [DRY-RUN] カテゴリ "${catDef.name}" を INSERT する予定`)
      } else {
        const [inserted] = await db
          .insert(tagCategories)
          .values({
            userId,
            name: catDef.name,
            selectType: catDef.selectType,
          })
          .returning({ id: tagCategories.id })
        catId = inserted.id
        console.log(`  カテゴリ "${catDef.name}" 作成 (id=${catId})`)
      }
    }

    const optionMap: Record<string, string> = {}
    // dry-run で新規カテゴリ (DB 未存在) の場合、 catId は仮文字列 (例: `dry-run-cat-分野`)。
    // tagOptions.category_id は uuid 型のため、 仮 catId で SELECT すると 22P02 invalid input
    // syntax for type uuid エラーで落ちる。 → dry-run + 新規カテゴリの組合せでは option の
    // 既存チェック SELECT を skip し、 配下 option を無条件に「INSERT する予定」 として扱う
    // (dry-run の目的 = 何を作るか を log 出力、 既存チェックは本実行で確実に動けば十分)。
    const isNewCategoryInDryRun = dryRun && catId.startsWith('dry-run-cat-')

    for (const optName of catDef.options) {
      if (isNewCategoryInDryRun) {
        const optId = `dry-run-opt-${catDef.name}-${optName}`
        console.log(`  [DRY-RUN] 選択肢 "${catDef.name}/${optName}" を INSERT する予定 (新規カテゴリ配下のため SELECT skip)`)
        optionMap[optName] = optId
        continue
      }

      // 既存カテゴリ (本物 UUID) or 非 dry-run: 通常の find-or-create。
      // SELECT — UNIQUE(category_id, name) なので 1 行以下
      const existingOpts = await db
        .select({ id: tagOptions.id })
        .from(tagOptions)
        .where(
          and(
            eq(tagOptions.categoryId, catId),
            eq(tagOptions.name, optName),
          ),
        )
        .limit(1)

      let optId: string
      if (existingOpts.length > 0) {
        optId = existingOpts[0].id
      } else {
        if (dryRun) {
          // 既存カテゴリ配下で、 option だけ新規の場合 (例: カテゴリ「難易度」 は前回 seed で存在、
          // 新規 option を今回足す)。 SELECT は通っているので catId は本物 UUID、 ここに到達して OK。
          optId = `dry-run-opt-${catDef.name}-${optName}`
          console.log(`  [DRY-RUN] 選択肢 "${catDef.name}/${optName}" を INSERT する予定 (既存カテゴリ配下)`)
        } else {
          const [insertedOpt] = await db
            .insert(tagOptions)
            .values({
              userId,
              categoryId: catId,
              name: optName,
            })
            .returning({ id: tagOptions.id })
          optId = insertedOpt.id
          console.log(`    選択肢 "${catDef.name}/${optName}" 作成 (id=${optId})`)
        }
      }
      optionMap[optName] = optId
    }

    categoryMap[catDef.name] = { id: catId, options: optionMap }
  }

  // -------------------------------------------------------------------------
  // Step 2: INSERT exam
  // -------------------------------------------------------------------------
  const examName = `[PERF-SEED] ${cardCount}-card exam @${new Date().toISOString()}`
  console.log(`\n[seed-perf-exam] Step 2: 試験 INSERT: "${examName}"`)

  let examId: string
  if (dryRun) {
    examId = 'dry-run-exam-id'
    console.log(`  [DRY-RUN] 試験 INSERT 予定: name="${examName}"`)
  } else {
    const [insertedExam] = await db
      .insert(exams)
      .values({
        userId,
        name: examName,
        cardCount: 0,
      })
      .returning({ id: exams.id })
    examId = insertedExam.id
    console.log(`  試験 INSERT 完了: id=${examId}`)
  }

  // -------------------------------------------------------------------------
  // Step 3: Build card rows
  // -------------------------------------------------------------------------
  console.log(`\n[seed-perf-exam] Step 3: ${cardCount} 件カード rows 生成...`)

  type CardRow = {
    userId: string
    examId: string
    title: string
    sortKey: string
    questionText: string
    options: CardOption[]
    correctAnswerIds: string[]
  }

  const cardRows: CardRow[] = []
  for (let i = 0; i < cardCount; i++) {
    const cardNum = String(i + 1).padStart(4, '0')
    const questionText = `[PERF-SEED No.${i + 1}] ${JP_LOREM.slice(0, 200 + (i % 5) * 20)}`

    // 4 択ダミー選択肢 (index=0 を正解固定)
    const opts: CardOption[] = [
      { id: `opt-${i}-0`, text: `選択肢 A (正解) No.${i + 1}`, is_correct: true },
      { id: `opt-${i}-1`, text: `選択肢 B No.${i + 1}`, is_correct: false },
      { id: `opt-${i}-2`, text: `選択肢 C No.${i + 1}`, is_correct: false },
      { id: `opt-${i}-3`, text: `選択肢 D No.${i + 1}`, is_correct: false },
    ]
    // shuffle opts for display variety
    const shuffledOpts = [...opts].sort(() => Math.random() - 0.5)
    const correctId = shuffledOpts.find((o) => o.is_correct)!.id

    cardRows.push({
      userId,
      examId,
      title: `PERF-SEED カード ${cardNum}`,
      sortKey: cardNum,
      questionText,
      options: shuffledOpts,
      correctAnswerIds: [correctId],
    })
  }

  // -------------------------------------------------------------------------
  // Step 4: Build cardTag assignments (per card, random pick)
  // -------------------------------------------------------------------------
  // We need inserted card IDs, so for dry-run we compute tag assignment stats only

  if (dryRun) {
    console.log(`  [DRY-RUN] ${cardCount} 件カード INSERT 予定`)
    // Compute tag count distribution for dry-run reporting
    let totalTags = 0
    for (let i = 0; i < cardCount; i++) {
      for (const catDef of TAG_CATEGORIES) {
        const [min, max] = catDef.pickCount
        totalTags += randomBetween(min, max)
      }
    }
    console.log(
      `  [DRY-RUN] card_tags 約 ${totalTags} 件 INSERT 予定 (実際は random で変動)`,
    )
    console.log(`  [DRY-RUN] exams.card_count = ${cardCount} UPDATE 予定`)
    console.log('\n[seed-perf-exam] dry-run 完了 (DB 書込なし)')
    console.log(`  試験名: "${examName}"`)
    console.log(`  タグカテゴリ: ${TAG_CATEGORIES.map((c) => c.name).join(' / ')}`)
    return
  }

  // -------------------------------------------------------------------------
  // Step 5: chunk INSERT cards
  // -------------------------------------------------------------------------
  console.log(`\n[seed-perf-exam] Step 5: cards chunk INSERT (chunk=50)...`)

  const insertedCardIds: string[] = []
  const cardChunks = chunk(cardRows, 50)
  for (let ci = 0; ci < cardChunks.length; ci++) {
    const ch = cardChunks[ci]
    const inserted = await db
      .insert(cards)
      .values(ch)
      .returning({ id: cards.id })
    insertedCardIds.push(...inserted.map((r) => r.id))
    process.stdout.write(
      `\r  cards: ${insertedCardIds.length}/${cardCount} (chunk ${ci + 1}/${cardChunks.length})`,
    )
  }
  console.log('\n  cards INSERT 完了')

  // -------------------------------------------------------------------------
  // Step 6: Build cardTag rows
  // -------------------------------------------------------------------------
  console.log(`\n[seed-perf-exam] Step 6: card_tags rows 生成...`)

  type CardTagRow = {
    cardId: string
    optionId: string
    userId: string
  }

  const cardTagRows: CardTagRow[] = []
  for (let i = 0; i < insertedCardIds.length; i++) {
    const cardId = insertedCardIds[i]
    for (const catDef of TAG_CATEGORIES) {
      const [min, max] = catDef.pickCount
      const pickN = randomBetween(min, max)
      const optionNames = pickRandomN(catDef.options, pickN)
      for (const optName of optionNames) {
        const optionId = categoryMap[catDef.name].options[optName]
        cardTagRows.push({ cardId, optionId, userId })
      }
    }
  }
  console.log(`  card_tags rows: ${cardTagRows.length} 件`)

  // -------------------------------------------------------------------------
  // Step 7: chunk INSERT card_tags (onConflictDoNothing で PK 重複防御)
  // -------------------------------------------------------------------------
  console.log(`\n[seed-perf-exam] Step 7: card_tags chunk INSERT (chunk=100)...`)

  const cardTagChunks = chunk(cardTagRows, 100)
  let insertedTagCount = 0
  for (let ci = 0; ci < cardTagChunks.length; ci++) {
    const ch = cardTagChunks[ci]
    await db.insert(cardTags).values(ch).onConflictDoNothing()
    insertedTagCount += ch.length
    process.stdout.write(
      `\r  card_tags: ${insertedTagCount}/${cardTagRows.length} (chunk ${ci + 1}/${cardTagChunks.length})`,
    )
  }
  console.log('\n  card_tags INSERT 完了')

  // -------------------------------------------------------------------------
  // Step 8: UPDATE exams.card_count
  // -------------------------------------------------------------------------
  console.log(`\n[seed-perf-exam] Step 8: exams.card_count = ${insertedCardIds.length} 更新...`)
  await db
    .update(exams)
    .set({
      cardCount: insertedCardIds.length,
      // updatedAt を意図的に固定して試験一覧の並び順を乱さない (process.ts B1 と同方針)
      updatedAt: sql`${exams.updatedAt}`,
    })
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))

  // =========================================================================
  // 完了報告
  // =========================================================================
  console.log('\n✅ seed 完了!')
  console.log(`  試験 id  : ${examId}`)
  console.log(`  試験名   : "${examName}"`)
  console.log(`  カード数 : ${insertedCardIds.length}`)
  console.log(`  card_tags: ${cardTagRows.length} 件`)
  console.log(`  タグカテゴリ: ${TAG_CATEGORIES.map((c) => c.name).join(' / ')}`)
  console.log(`\n  stg app URL: https://stg.recallmint.nekotest.net/app/exams/${examId}`)
  console.log('\n  観測完了後の cleanup:')
  console.log(
    `  pnpm tsx --conditions=react-server scripts/seed-perf-exam.ts --user-id=${userId} --cleanup`,
  )
}

// process.argv[1] が本 file のとき = CLI 起動。 import 経路では走らない。
//
// 全経路 (成功 / 失敗 / dry-run / cleanup) で closeDb() → process.exit を呼ぶ。
// postgres-js client が open のままだと Node が exit せず固まる (=旧バグ)。
// closeDb は { timeout: 5 } で 5 秒以内に in-flight query を待ってから force close、
// その後 process.exit で確実に terminate する。 close 自身の失敗は exit を妨げない
// (catch で握り潰し、 fatal log は残す)。
if (process.argv[1]?.endsWith('seed-perf-exam.ts')) {
  main().then(
    async () => {
      await closeDb().catch((e) => console.error('[seed-perf-exam] closeDb error (ignored):', e))
      process.exit(0)
    },
    async (e) => {
      console.error('[seed-perf-exam] fatal:', e)
      await closeDb().catch((closeErr) =>
        console.error('[seed-perf-exam] closeDb error after fatal (ignored):', closeErr),
      )
      process.exit(1)
    },
  )
}
