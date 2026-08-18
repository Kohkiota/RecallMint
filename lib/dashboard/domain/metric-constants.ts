// metric-constants — Dash-1 Home v1 の shared 閾値定数 (定義 doc §7.1)。
// 全て §3.12 の扱いに従う「暫定値」(prod 分布未確認)。凍結しているのは定義であって
// 数値ではない — 較正で値が変わっても本 module の役割 (1 箇所化) は変わらない。
//
// PURE 制約 (lib/*/domain 前例に倣う): I/O なし・DB / Dexie / next / zod を import しない。
// 値のみを持つ module なので import 自体がゼロ。

/** 定着(C)の stability 閾値(日)。Anki mature 慣例の借用 — 定義 doc §4-C。 */
export const S_MATURE = 21

/** 苦手カード(H)の lapses 閾値 — 定義 doc §4-H。 */
export const WEAK_LAPSES_MIN = 2

/** 苦手タグ(P)候補条件 1: 対象カード数の下限 — 定義 doc §4-P。 */
export const WEAK_TAG_MIN_CARDS = 8

/** 苦手タグ(P)候補条件 2: 直近 30 日の復習イベント数の下限 — 定義 doc §4-P。 */
export const WEAK_TAG_MIN_REVIEWS = 15

/** 推定所要時間(N)の既定値(ms)。有効標本 0 件のときのみ使う — 定義 doc §4-N。 */
export const ESTIMATE_DEFAULT_MS = 20_000

/** 推定所要時間(N)の標本有効化上限(ms)。超過行は除外(clamp しない) — 定義 doc §4-N。 */
export const ESTIMATE_CAP_MS = 120_000

/** 推定所要時間(N)の最大標本件数 — 定義 doc §4-N。 */
export const ESTIMATE_SAMPLE_N = 100

/** 推定所要時間(N)の走査行数上限。無効値の連続で全件走査に退化するのを防ぐ — 定義 doc §4-N。 */
export const ESTIMATE_SCAN_LIMIT = 1_000

/** 苦手タグ(P)の表示件数 — 定義 doc §4-P。 */
export const WEAK_TAG_TOP_N = 3

/** 今後 N 日ウィジェット(W6)の日数 — 定義 doc §5 W6。 */
export const FORECAST_DAYS = 7

/** クイック演習(W5)の既定件数 — 定義 doc §5 W5。 */
export const QUICK_PRESET_N = 10

/**
 * 新規/日の既定上限(K)の既定値(fix round 1/5 M-1: §6-⑥ 未確定という旧コメントを訂正)。
 * design doc §8.1 が確定済み: `exams.daily_new_target`(integer nullable)の値であり、
 * **列が null のときの既定値がこの 20**(CHECK `exams_daily_new_target_nonneg` で
 * `>= 0`。0 は「新規を出さない」の明示値であって null とは別)。未確定なのは
 * K の消費経路(u の永続化・出題プールへの強制)であって、値と保存先はもう確定している。
 */
export const DAILY_NEW_DEFAULT = 20

// streak window(61 日)はここに置かない: `lib/streak-core.ts` の
// `STREAK_WINDOW_DAYS` が唯一の定義(fix round 1/5 I-3・controller 裁定で
// `lib/client/streak.ts` から移設済み。server 側 `lib/db/streak.ts` が同じ 61 を
// `addDays(today, -60)` として独立に持つ既存の重複はあるが、それは本 task の範囲外
// — 収斂させない)。ここへ再定義すると数値が 2 箇所化するため意図的に置かない —
// 61 頭打ちの表記が必要な場合は `lib/streak-core.ts` の `STREAK_WINDOW_DAYS` /
// `formatStreakDisplay` を直接 import する(`lib/streak-core.ts` は import ゼロの
// pure module であり、dashboard/domain から import しても Dexie 依存は伝播しない)。
