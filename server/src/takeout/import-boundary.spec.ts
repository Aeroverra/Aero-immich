import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { glob } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd(), 'src/takeout');

const ALLOWED_PROD = [/^node:/, /^luxon$/, /^sharp$/, /^src\/takeout(\/|$)/, /^src\/utils\/mime-types$/, /^\.{1,2}\//];
const ALLOWED_TEST = [...ALLOWED_PROD, /^vitest$/, /^archiver$/];

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specifiers.push(m[1] ?? m[2]);
  }
  return specifiers;
}

// Spec 6.1 #13: every file in src/takeout imports only allowed modules.
describe('import boundary', () => {
  it('only imports node:*, luxon, sharp, src/utils/mime-types and src/takeout', async () => {
    const files: string[] = await Array.fromAsync(glob('**/*.ts', { cwd: ROOT }));
    expect(files.length).toBeGreaterThan(10);

    const violations: string[] = [];
    for (const file of files) {
      const isTest = file.endsWith('.spec.ts') || file.endsWith('test-fixtures.ts');
      const allowed = isTest ? ALLOWED_TEST : ALLOWED_PROD;
      const source = readFileSync(`${ROOT}/${file}`, 'utf8');
      for (const specifier of importsOf(source)) {
        if (allowed.every((re) => !re.test(specifier))) {
          violations.push(`${relative(ROOT, `${ROOT}/${file}`)}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
