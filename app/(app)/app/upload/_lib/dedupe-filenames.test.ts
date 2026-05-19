import { describe, it, expect } from 'vitest'
import { partitionByDuplicateFilename } from './dedupe-filenames'

function f(name: string): File {
  return new File(['x'], name, { type: 'image/jpeg' })
}

describe('partitionByDuplicateFilename', () => {
  it('empty inputs → empty result', () => {
    expect(partitionByDuplicateFilename([], [])).toEqual({
      unique: [],
      duplicates: [],
    })
  })

  it('no duplicates → all unique', () => {
    const r = partitionByDuplicateFilename(
      [f('a.jpg'), f('b.jpg')],
      [{ file: f('c.jpg') }],
    )
    expect(r.unique.map((u) => u.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(r.duplicates).toEqual([])
  })

  it('same name as existing → duplicates', () => {
    const r = partitionByDuplicateFilename(
      [f('photo.jpg'), f('other.pdf')],
      [{ file: f('photo.jpg') }],
    )
    expect(r.unique.map((u) => u.name)).toEqual(['other.pdf'])
    expect(r.duplicates).toEqual(['photo.jpg'])
  })

  it('duplicates within same batch → first kept, rest reported', () => {
    const r = partitionByDuplicateFilename(
      [f('photo.jpg'), f('photo.jpg'), f('photo.jpg')],
      [],
    )
    expect(r.unique.map((u) => u.name)).toEqual(['photo.jpg'])
    expect(r.duplicates).toEqual(['photo.jpg', 'photo.jpg'])
  })

  it('case sensitive: photo.jpg vs Photo.JPG → both kept (no case folding)', () => {
    const r = partitionByDuplicateFilename(
      [f('Photo.JPG')],
      [{ file: f('photo.jpg') }],
    )
    expect(r.unique.map((u) => u.name)).toEqual(['Photo.JPG'])
    expect(r.duplicates).toEqual([])
  })

  it('mixed: 1 existing dup + 1 batch dup + 1 unique', () => {
    const r = partitionByDuplicateFilename(
      [f('a.jpg'), f('b.jpg'), f('b.jpg'), f('c.jpg')],
      [{ file: f('a.jpg') }],
    )
    expect(r.unique.map((u) => u.name)).toEqual(['b.jpg', 'c.jpg'])
    expect(r.duplicates).toEqual(['a.jpg', 'b.jpg'])
  })
})
