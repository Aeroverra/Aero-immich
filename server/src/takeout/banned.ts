// Port of immich-go internal/namematcher: glob patterns turned into unanchored, case-insensitive regular expressions.

export const DEFAULT_BANNED_PATTERNS: string[] = [
  '@eaDir/',
  '@__thumb/',
  'SYNOFILE_THUMB_*.*',
  'Lightroom Catalog/',
  'thumbnails/',
  '.DS_Store',
  '/._*',
  '.Spotlight-V100/',
  '.photostructure/',
  'Recently Deleted/',
];

interface PatternEntry {
  re: RegExp;
  raw: string;
  dirOnly: boolean;
}

export function patternToRe(pattern: string): RegExp {
  let r = '';
  let inBrackets = false;
  const runes = [...pattern];
  let isFirstRune = true;
  let i = 0;
  while (i < runes.length) {
    const b = runes[i++];
    switch (b) {
      case '/': {
        r += isFirstRune ? '(^|/)' : '/';
        break;
      }
      case '*': {
        r += '[^/]*';
        break;
      }
      case '?': {
        r += '[^/]';
        break;
      }
      case '.':
      case '^':
      case '$':
      case '(':
      case ')':
      case '|': {
        r += '\\' + b;
        break;
      }
      case '\\': {
        r += b;
        if (i < runes.length) {
          r += runes[i++];
        }
        break;
      }
      case '[': {
        inBrackets = true;
        r += b;
        while (i < runes.length) {
          const c = runes[i++];
          if (c === ']') {
            inBrackets = false;
            r += c;
            break;
          }
          const lower = c.toLowerCase();
          const upper = c.toUpperCase();
          r += lower;
          if (lower !== upper) {
            r += upper;
          }
        }
        break;
      }
      default: {
        r += b;
      }
    }
    isFirstRune = false;
  }
  if (inBrackets) {
    throw new Error(`invalid file name pattern: ${pattern}`);
  }
  try {
    return new RegExp(r, 'i');
  } catch {
    throw new Error(`invalid file name pattern: ${pattern}`);
  }
}

export class NameList {
  private entries: PatternEntry[] = [];

  constructor(patterns: string[] = []) {
    for (const pattern of patterns) {
      this.add(pattern);
    }
  }

  add(pattern: string) {
    if (pattern === '') {
      return;
    }
    this.entries.push({ re: patternToRe(pattern), raw: pattern, dirOnly: pattern.endsWith('/') });
  }

  match(name: string): boolean {
    return this.entries.some((entry) => entry.re.test(name));
  }

  matchFile(name: string): boolean {
    return this.entries.some((entry) => !entry.dirOnly && entry.re.test(name));
  }

  matchDir(name: string): boolean {
    const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
    const withSlash = trimmed + '/';
    return this.entries.some((entry) => entry.dirOnly && (entry.re.test(trimmed) || entry.re.test(withSlash)));
  }

  toString(): string {
    return this.entries.map((entry) => `'${entry.raw}'`).join(', ');
  }
}
