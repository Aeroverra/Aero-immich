import { NameList } from 'src/takeout/banned';
import { describe, expect, it } from 'vitest';

// Ported from internal/namematcher list_test.go TestList_Match.
const tables: Array<{ pattern: string; checks: Array<[string, boolean]> }> = [
  { pattern: '*.*', checks: [['hello.world', true], ['/path/to/file.exe', true], ['/path/to/file!exe', false], ['/path/to/file', false]] },
  { pattern: 'f?le.*', checks: [['hello.world', false], ['/path/to/file.raw', true], ['/path/to/fale.jpg', true], ['/path/to/file', false]] },
  { pattern: 'f[aeiou]le.*', checks: [['hello.world', false], ['/path/to/file.raw', true], ['/path/to/fIle.exe', true], ['/path/to/fule.jpg', true], ['/path/to/file', false]] },
  { pattern: 'file[s$].*', checks: [['hello.world', false], ['/path/to/files.raw', true], ['/path/to/fIleS.exe', true], ['/path/to/fIle$.exe', true], ['/path/to/fIleX.exe', false], ['/path/to/fule.jpg', false], ['/path/to/file', false]] },
  { pattern: 'file$.jpg', checks: [['hello.world', false], ['/path/to/file.jpg', false], ['/path/to/file.jpg$', false], ['/path/to/file.$jpg', false], ['/path/to/file$.jpg', true], ['/path/to/file', false]] },
  { pattern: 'fi(le).jpg', checks: [['hello.world', false], ['/path/to/file.jpg', false], ['/path/to/fi(le).jpg', true]] },
  { pattern: String.raw`fi\*e.jpg`, checks: [['hello.world', false], ['/path/to/fi*e.jpg', true], ['/path/to/file.jpg', false]] },
  { pattern: 'SYNOFILE_THUMB_*.*', checks: [['hello.world', false], ['/path/to/file.exe', false], ['/path/to/SYNOFILE_THUMB_M_000213.jpg', true], ['/path/to/synofile_thumb_m_000213.jpg', true], ['/path/to/SYNOFILE_THUMB_M/file.jpg', false], ['/path/to/.@__thumb/000213.jpg', false]] },
  { pattern: '@__thumb/', checks: [['hello.world', false], ['/path/to/file.exe', false], ['/path/to/.@__thumb/000213.jpg', true], ['/path/to/SYNOFILE_THUMB_M_000213.jpg', false]] },
  { pattern: '@eaDir/', checks: [['hello.world', false], ['/path/to/file.exe', false], ['/path/to/.@__thumb/000213.jpg', false], ['/path/to/@eaDir/000213.jpg', true], ['/path/to/@eaDir/sub/000213.jpg', true], ['@eaDir/SYNOFILE_THUMB_M_000213.jpg', true]] },
  { pattern: '/._*', checks: [['hello.world', false], ['._hello.world', true], ['/path/to/file.exe', false], ['/path/to/._file.exe', true], ['/path/to/file', false], ['/path/to/PXL_20210825_041449609._exported_699_1629864935.jpg', false], ['PXL_20210825_041449609._exported_699_1629864935.jpg', false]] },
];

describe('NameList.match (TestList_Match)', () => {
  for (const table of tables) {
    describe(table.pattern, () => {
      const list = new NameList([table.pattern]);
      for (const [name, want] of table.checks) {
        it(`${name} -> ${want}`, () => expect(list.match(name)).toBe(want));
      }
    });
  }
});

describe('TestListMatchDirVsFile', () => {
  const list = new NameList(['Thumbs.db', 'tmp/']);
  it('matches files and dirs by pattern kind', () => {
    expect(list.matchFile('Thumbs.db')).toBe(true);
    expect(list.matchDir('Thumbs.db')).toBe(false);
    expect(list.matchFile('tmp')).toBe(false);
    expect(list.matchDir('tmp')).toBe(true);
    expect(list.matchDir('some/path/tmp')).toBe(true);
    expect(list.matchFile('some/path/tmp/file.jpg')).toBe(false);
  });
});
