// 同一ファイル名 (大小区別あり、 完全一致) の重複防止 helper。
// MVP は simplicity 優先で hash 比較なし、 filename のみで判定する。
//
// 用途: file picker で新規に選ばれた File[] と既存 list の File[] を比較し、
// 既存と同名 file は追加せず警告対象として返す。

export type PartitionResult = {
  unique: File[]
  duplicates: string[]
}

export function partitionByDuplicateFilename(
  incoming: File[],
  existing: { file: File }[],
): PartitionResult {
  const existingNames = new Set(existing.map((e) => e.file.name))
  // 同一 picker invocation 内での重複も弾く (例: ユーザーが multi-select で
  // 同名 file を 2 つ選んだ場合、 1 つ目だけ採用、 2 つ目以降は duplicates)。
  const seenInBatch = new Set<string>()
  const unique: File[] = []
  const duplicates: string[] = []
  for (const f of incoming) {
    if (existingNames.has(f.name) || seenInBatch.has(f.name)) {
      duplicates.push(f.name)
    } else {
      unique.push(f)
      seenInBatch.add(f.name)
    }
  }
  return { unique, duplicates }
}
