'use client'

// CardEditorFields: 1 card 分の「タグ + 問題文 + 選択肢 + 解説 + メモ」inline 編集ブロック。
// inline-card-list(詳細 page の縦リスト)と exam-card-side-peek(テーブル行の side peek)が
// 共有する near-verbatim な後段フィールド列を 1 箇所に集約する(P3 W4)。
//
// 縮小方針(spec §4.4-1 / task-5 brief): sort_key / title のヘッダ行は 2 caller で layout が
// 本質的に異なり(list = flex-wrap 1 行・field label なし・DeleteCardButton あり /
// side-peek = 縦積み各 field に <p> label・delete なし)、共有すると layout variant / label /
// showDelete の条件分岐だらけになるため**共有しない**。ヘッダと DeleteCardButton・
// autoEditOnMount の配線は各 caller が本ブロックの周囲に置く。ここは条件分岐ゼロの純表示。
//
// 不変条件(landmine): データは全て props で受け取り**独自 useLiveQuery を持たない**
// (単一 subscription 不変条件 #1)。V6 blur→close の commit 知識は side-peek container に
// 残し本 component には持ち込まない(#7)。categories / tagOptions / cardTags は caller が
// 渡した ref をそのまま CardTagsSection へ透過し新 ref を作らない(React.memo 凍結を維持 #6)。
// autoEditOnMount は問題文 field へ passthrough するだけ(one-shot 読み取り時点を変えない #4)。

import type { CardOption } from '@/lib/db/schema'
import type { ClientCardImage, ClientCardTag, ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { InlineTextField } from './inline-text-field'
import { InlineOptionList } from './inline-option-row'
import { CardTagsSection } from './card-tags-section'
import { CardImageGallery } from './card-image-gallery'

export type CardEditorFieldsProps = {
  cardId: string
  // CardTagsSection 用: owner-scope + タグマスタ(categories / tagOptions)+ 当該 card の付与済みタグ。
  // caller で ref 安定化済みのものを透過する(memo 凍結維持)。
  userId: string
  categories: ClientTagCategory[]
  tagOptions: ClientTagOption[]
  cardTags: ClientCardTag[]
  // 本文フィールド値
  questionText: string
  options: CardOption[]
  explanationText: string | null
  memo: string | null
  images: ClientCardImage[]
  // list のみ渡す(新規追加 card の問題文を mount 時に auto-edit)。side-peek は未指定 = false。
  autoEditOnMount?: boolean
}

export function CardEditorFields({
  cardId,
  userId,
  categories,
  tagOptions,
  cardTags,
  questionText,
  options,
  explanationText,
  memo,
  images,
  autoEditOnMount,
}: CardEditorFieldsProps) {
  return (
    <>
      <div>
        {/* タグ section。categories / tagOptions は caller で useMemo 安定化、cardTags は
            当該 card 分だけを渡すため、他 card のタグ変化では React.memo(CardTagsSection)で
            再描画 skip される。 */}
        <CardTagsSection
          cardId={cardId}
          userId={userId}
          categories={categories}
          options={tagOptions}
          cardTags={cardTags}
        />
      </div>

      <div>
        {/* Sprint I fix(§9 行高): add affordance をラベル行の 24px アイコンに寄せ、独立行を
            消す。thumbnail は field 下に slot='thumbnails' で据え置き(位置・サイズ不変)。 */}
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-slate-500">問題文</p>
          <CardImageGallery
            images={images}
            target="question_text"
            cardId={cardId}
            userId={userId}
            slot="add"
            compact
            attachAriaLabel="問題文に画像を追加"
          />
        </div>
        <InlineTextField
          cardId={cardId}
          userId={userId}
          field="question_text"
          initialValue={questionText}
          ariaLabel="問題文 編集"
          multiline
          displayClassName="text-sm text-slate-800"
          autoEditOnMount={autoEditOnMount}
        />
        <CardImageGallery images={images} target="question_text" cardId={cardId} userId={userId} slot="thumbnails" />
      </div>

      <div>
        {/* per-card 親 InlineOptionList で options 共有 state を管理(cross-row checkbox
            race を構造的に解消)。選択肢ヘッダ + 正解サマリも内部に co-locate。
            Sprint I W3: 各選択肢の compact gallery 用に images / userId を透過。 */}
        <InlineOptionList
          cardId={cardId}
          options={options}
          images={images}
          userId={userId}
        />
      </div>

      <div>
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-slate-500">解説</p>
          <CardImageGallery
            images={images}
            target="explanation_text"
            cardId={cardId}
            userId={userId}
            slot="add"
            compact
            attachAriaLabel="解説に画像を追加"
          />
        </div>
        <InlineTextField
          cardId={cardId}
          userId={userId}
          field="explanation_text"
          initialValue={explanationText}
          ariaLabel="解説 編集"
          multiline
          placeholder="解説 (クリックで追加)"
          displayClassName="text-sm text-slate-700"
        />
        <CardImageGallery images={images} target="explanation_text" cardId={cardId} userId={userId} slot="thumbnails" />
      </div>

      <div>
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-slate-500">メモ</p>
          <CardImageGallery
            images={images}
            target="memo"
            cardId={cardId}
            userId={userId}
            slot="add"
            compact
            attachAriaLabel="メモに画像を追加"
          />
        </div>
        <InlineTextField
          cardId={cardId}
          userId={userId}
          field="memo"
          initialValue={memo}
          ariaLabel="メモ 編集"
          multiline
          placeholder="メモ (クリックで追加)"
          displayClassName="text-sm text-slate-700"
        />
        <CardImageGallery images={images} target="memo" cardId={cardId} userId={userId} slot="thumbnails" />
      </div>
    </>
  )
}
