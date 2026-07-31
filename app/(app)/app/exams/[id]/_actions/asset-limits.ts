// asset-actions.ts(reserveAsset の検証境界)由来の共有上限値。
//
// なぜ独立 file か: asset-actions.ts はファイル先頭 'use server' ディレクティブを
// 持つ Server Actions file であり、Next.js の SWC "use server" transform は
// 「非 async 関数の export」を compile error にする(`Only async functions are
// allowed to be exported in a "use server" file.` — crates/next-custom-transforms/
// src/transforms/server_actions.rs、Context7 裏取り済)。よって定数(値)は
// asset-actions.ts から直接 export できない — 本 file(directive 無し)に切り出し、
// asset-actions.ts と ②-4a T4(prepare-upload.ts)の両方がここから import する。
//
// 値の由来はどちらも asset-actions.ts の元コメントに準拠(rule of three: 同値の
// ローカル private const が asset-actions.ts / lib/media/upload.ts / 旧
// prepare-upload.ts の 3 箇所に分散していたため、この 2 値を単一定義へ集約した。
// lib/media/upload.ts は別 import 境界の制約があり対象外のまま)。

// 5 MiB hard cap (圧縮バイパスした不正 client への上限。spec §3.1/§4)。
export const MAX_ASSET_BYTES = 5 * 1024 * 1024

// width/height の上限。 assets.width/height は Postgres integer (max 2^31-1) ゆえ、
// untrusted な直接呼び出しが巨大値を送ると INSERT が integer-out-of-range で throw し
// 500 に化ける。 実画像は圧縮後で高々数千 px ゆえ 100,000 で domain 上限 + DB range
// 防衛を兼ねる。
export const MAX_IMAGE_DIMENSION = 100_000
