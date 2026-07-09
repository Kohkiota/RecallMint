// Tag value objects (pure)。 tag_categories の定義規則を DB I/O から切り離した
// 純粋 domain module。 runtime import ゼロ (import type すら不要 = 依存なし純粋 type) —
// drizzle / @/lib/db / next / zod は import しない。
//
// 帰属決定 (spec §3.3):
// - Tag が所有するのは select_type の「定義」のみ (single か multi か)。
// - single-category set 制約 = 「1 card 上で single カテゴリごとに option は高々 1 個」は
//   Card aggregate が所有する (card_tags whole-set write 時に enforce)。
//   server 側の whole-set 違反判定は lib/cards/domain の hasSingleCategoryOverflow。
// - client の buildNextTagSet (toggle 時の次集合構築) と server の
//   hasSingleCategoryOverflow (whole-set 違反検査) は意図的に別関数
//   (construct vs validate) であり、 制約定義の二重化ではない。
//
// SelectType は schema `tag_categories.select_type` の $type<'single' | 'multi'>() と同値。
export type SelectType = 'single' | 'multi'
