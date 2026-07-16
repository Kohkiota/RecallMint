import { z } from 'zod'

// inline 編集 (`/app/exams/[id]` 内 option 編集) の選択肢入力 validation。
// 元は `/app/cards/[id]` page の 5 列同時保存にも使われていたが、 同 page 廃止
// (cache-fix roadmap ④-3) で `optionSchema` 1 個に narrow された。
//
// 正答数の下限を設けていないのは意図的: OCR が正答未記載で取り込んだ card は
// 全選択肢 is_correct=false で保存されており、 user が後から正答を付けるまで
// 「正答 0」状態を許す必要がある (tech-spec §2.5.2 の「最低 1 個」より編集 UI を
// 優先、 0 件は UI 側で warning 表示しつつ保存を通す)。
// correct_answer_ids は本 schema に含めない — server action 側で is_correct から
// 再生成する (options[].is_correct のデノーマ、 tech-spec §2.5.2)。

export const optionSchema = z.object({
  id: z.string().min(1, '選択肢の id は必須です'),
  // Sprint I W5: 画像紐付けの内部不変 identity。全生成経路が mint するため書込境界では必須。
  // crypto.randomUUID() = v4 ゆえ v4 厳密(isAssetKey と同じ判定域)。
  uid: z.uuid({ version: 'v4' }),
  text: z
    .string()
    .max(1000, '選択肢の本文は 1000 文字以内で入力してください')
    .refine((s) => s.trim().length > 0, {
      message: '選択肢の本文は必須です',
    }),
  isCorrect: z.boolean(),
  explanation: z
    .string()
    .max(2000, '選択肢の解説は 2000 文字以内で入力してください')
    .optional(),
})

// ---------------------------------------------------------------------------
// card field-bound schema (F3-R3 集約)
// ---------------------------------------------------------------------------
//
// card の各 field の境界検証 zod。 元は card-field-handlers.ts (各 handler の
// 値検証) と mutation-schemas.ts (cardCreatePatchSchema の inline) に二重定義
// されていたものを、 単一 source として本 module に集約した (drift 防止)。
// 両 consumer は同一 schema object を .safeParse / z.object field に差すため、
// issue path・message は文字通り不変。

export const titleSchema = z
  .string()
  .trim()
  .min(1, 'タイトルは必須です')
  .max(200, 'タイトルは 200 文字以内で入力してください')

export const sortKeySchema = z
  .string()
  .max(100, 'ソートキーは 100 文字以内で入力してください')
  .nullable()

export const questionTextSchema = z
  .string()
  .max(10000, '問題文は 10000 文字以内で入力してください')
  .refine((s) => s.trim().length > 0, { message: '問題文は必須です' })

export const explanationTextSchema = z
  .string()
  .max(10000, '解説は 10000 文字以内で入力してください')
  .nullable()

export const memoSchema = z
  .string()
  .max(10000, 'メモは 10000 文字以内で入力してください')
  .nullable()

export const optionsSchema = z
  .array(optionSchema)
  .min(1, '選択肢は最低 1 個必要です')
  .max(50, '選択肢は最大 50 個までです')
  .refine((opts) => new Set(opts.map((o) => o.id)).size === opts.length, {
    message: '選択肢の id が重複しています',
  })
  // Sprint I W5: uid(画像 identity)も一意。id(表示ラベル)一意とは独立の制約
  // (label は selected_answer_ids 用に一意・uid は画像紐付け用に一意)。
  .refine((opts) => new Set(opts.map((o) => o.uid)).size === opts.length, {
    message: '選択肢の uid が重複しています',
  })

// ---------------------------------------------------------------------------
// images (画像フェーズ A Task 5 — server 最終防衛の zod 形状検証)
// ---------------------------------------------------------------------------
//
// spec: docs/superpowers/specs/2026-07-12-image-phase-a-design.md §2.2 / §3.3
//
// `key` が UUIDv4 形式 = asset 参照 (server handler が「自 user の ready asset に
// 実在」を検証する対象)。非 UUID key は既存 OCR 由来の参照メモ (legacy entry) で
// あり、本 schema では target 形式の強制を外す (passthrough) — OCR 取込済 card の
// images 編集が legacy entry で reject されないようにするため (spec §2.2)。
//
// spec §2.2 の判別: key が UUIDv4 = asset 参照 (server で ready 検証 / target 形式強制)、
// 非 v4 (legacy OCR の "img-1" 等) = passthrough。 z.uuid() は任意 version を通すため
// v4 厳密に絞る (spec は「UUIDv4 形式」と明記)。 imageEntrySchema の target 形式強制と
// card-field-handlers の handleImages が同じ判別を共有するので helper に一本化し drift を防ぐ。
export function isAssetKey(key: string): boolean {
  return z.uuid({ version: 'v4' }).safeParse(key).success
}

// `url` は非空を reject する: 署名 URL の DB 保存禁止 (spec 前提 1) の恒久防衛。
// 空文字 '' と未指定は許容する (書かない、が正しい状態)。
const imageEntrySchema = z
  .object({
    key: z.string().min(1),
    target: z.string(),
    alt: z.string(),
    source_ref: z.string().optional(),
    url: z.string().optional(),
  })
  .refine((entry) => !entry.url || entry.url.length === 0, {
    message: 'url は保存できません (署名 URL の DB 保存禁止)',
    path: ['url'],
  })
  .refine(
    (entry) => {
      // legacy (非 UUIDv4) key は target 形式強制の対象外
      if (!isAssetKey(entry.key)) return true
      // Sprint I: 画像添付を 4 面へ拡張。field 名一致の target を許容
      // (question_text / explanation_text / memo)+ 選択肢は option:<id>。
      return (
        entry.target === 'question_text' ||
        entry.target === 'explanation_text' ||
        entry.target === 'memo' ||
        /^option:.+/.test(entry.target)
      )
    },
    {
      message:
        "target は 'question_text' / 'explanation_text' / 'memo' または 'option:...' 形式である必要があります",
      path: ['target'],
    },
  )

export const imagesSchema = z.array(imageEntrySchema).max(10)
