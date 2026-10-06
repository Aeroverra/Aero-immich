import { isEditedCopy, originalNameOfEdited } from 'src/takeout/edited';
import { describe, expect, it } from 'vitest';

// Ported from editedrotation_test.go TestOriginalNameOfEdited.
describe('originalNameOfEdited', () => {
  const tests: Array<{ name: string; original: string | null }> = [
    { name: 'PXL_20250618_190149089-edited.jpg', original: 'PXL_20250618_190149089.jpg' },
    { name: 'B13p 35455-edited.jpg', original: 'B13p 35455.jpg' },
    { name: 'EFFECTS-edited(3).jpg', original: 'EFFECTS(3).jpg' },
    { name: 'IMG_0330-edited.JPG', original: 'IMG_0330.JPG' },
    { name: 'PXL_20220405_090123740.PORTRAIT-modifié.jpg', original: 'PXL_20220405_090123740.PORTRAIT.jpg' },
    { name: 'IMG_0330.JPG', original: null },
    { name: 'edited.jpg', original: null },
  ];
  for (const t of tests) {
    it(t.name, () => expect(originalNameOfEdited(t.name)).toBe(t.original));
  }
});

describe('isEditedCopy', () => {
  it('matches localized and case-insensitive edited suffixes on the base name', () => {
    expect(isEditedCopy('a/b/IMG_1-EDITED.jpg')).toBe(true);
    expect(isEditedCopy('PORTRAIT-modifié.jpg')).toBe(true); // NFD
    expect(isEditedCopy('IMG_1.jpg')).toBe(false);
  });
});
