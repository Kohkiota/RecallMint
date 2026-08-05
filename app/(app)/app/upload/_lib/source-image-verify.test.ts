// ②-4a T16-b: `verifyImageBytes` が EXIF orientation を外へ出すこと と、「異常」の
// 判定境界(`isUnsupportedOrientation`)の pin。
//
// **sharp を mock しない**: ここで保証したいのは「実 sharp の `metadata().orientation`
// が実際に何を返すか(EXIF 非搭載 = `undefined` / 有り = 1..8)に実装が従っているか」で、
// mock で返り値を決めると自分の mock を検証するだけになる。 pipeline 側の unit
// (`upload-pipeline.test.ts`)は sharp を mock するため、**その mock が現実と一致して
// いることの担保は本 file が持つ**。 CLAUDE.md の「test は mock 必須」は外部 API
// (Gemini / Stripe 等)の話で、in-process の画像処理は対象外。
//
// 何を保証しないか: 判定が発火したときの pipeline の振る舞い(warn / 除外計上)—
// それは `upload-pipeline.test.ts` と `publish-prepared-plan.test.ts`。

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { isUnsupportedOrientation, verifyImageBytes } from './source-image-verify'

// 8×6 の単色画像。 orientation を渡した場合だけ EXIF を焼く(`withMetadata` は
// EXIF chunk を書き出す。 pixel は回さない = 現行 client の canvas 再エンコードとは
// 逆の、EXIF が残ったままのバイト)。
async function imageBytes(
  format: 'png' | 'jpeg',
  orientation?: number,
): Promise<Buffer> {
  const base = sharp({
    create: { width: 8, height: 6, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
  const withExif = orientation === undefined ? base : base.withMetadata({ orientation })
  return format === 'png' ? withExif.png().toBuffer() : withExif.jpeg().toBuffer()
}

describe('verifyImageBytes — EXIF orientation の受け渡し', () => {
  it('EXIF を持たない PNG は orientation undefined(mime/寸法は従来どおり)', async () => {
    const verified = await verifyImageBytes(await imageBytes('png'))

    // `toStrictEqual`: `toEqual` は undefined 値のキーを無視するため、キー自体が
    // 存在しない旧実装でも通ってしまう(= 空振り)。
    expect(verified).toStrictEqual({
      mime: 'image/png',
      width: 8,
      height: 6,
      orientation: undefined,
    })
  })

  it('EXIF を持たない JPEG も orientation undefined(現行 client 経路と同じ形)', async () => {
    const verified = await verifyImageBytes(await imageBytes('jpeg'))

    expect(verified?.orientation).toBeUndefined()
  })

  it('EXIF orientation=1 の JPEG は 1 を返す(正立の明示)', async () => {
    const verified = await verifyImageBytes(await imageBytes('jpeg', 1))

    expect(verified?.orientation).toBe(1)
  })

  it('EXIF orientation=6 の JPEG は 6 をそのまま返す(値を潰して bool にしない)', async () => {
    const verified = await verifyImageBytes(await imageBytes('jpeg', 6))

    // 値そのものを外へ出すのは、pipeline の warn に載せて「何が起きたか」を
    // 運用が判別できるようにするため(前提破綻の通知が本命)。
    expect(verified?.orientation).toBe(6)
    // 回転入力でも decode 検証自体は成功する(text 抽出は継続する・spec §4.5)。
    expect(verified?.mime).toBe('image/jpeg')
    // sharp は `.rotate()` を呼ばない限り EXIF を適用しないため、寸法は格納値のまま
    // (crop 側と同じ規律 = 座標基準が decode 寸法で一致する)。
    expect(verified?.width).toBe(8)
    expect(verified?.height).toBe(6)
  })
})

describe('isUnsupportedOrientation — 「1 でも undefined でもない」だけが異常', () => {
  it('undefined(EXIF 非搭載)は異常にしない', () => {
    // ここを異常にすると全 PNG / 全 client 圧縮済 WebP が誤検知になる。
    expect(isUnsupportedOrientation(undefined)).toBe(false)
  })

  it('1(正立)は異常にしない', () => {
    expect(isUnsupportedOrientation(1)).toBe(false)
  })

  it.each([2, 3, 4, 5, 6, 7, 8])('%i は異常(前提破綻の signal)', (value) => {
    expect(isUnsupportedOrientation(value)).toBe(true)
  })
})
