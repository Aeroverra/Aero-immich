import { ArchiveBrowserIndex } from 'src/takeout/types';

function decodeEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ');
}

function firstMatch(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() : null;
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  BYTES: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
  PB: 1024 ** 5,
};

/**
 * The index prints binary units with decimal names: "730.64 GB" is 730.64 GiB (784.5e9 bytes), which matches what the
 * parts of that export take on disk. Returns null for anything that is not "<number> <unit>".
 */
export function parseSizeText(text: string | null | undefined): number | null {
  if (!text) {
    return null;
  }
  const m = /^\s*([\d.,]+)\s*([a-z]+)\s*$/i.exec(text);
  if (!m) {
    return null;
  }
  const value = Number(m[1].replaceAll(',', ''));
  const unit = SIZE_UNITS[m[2].toUpperCase()];
  if (!Number.isFinite(value) || unit === undefined) {
    return null;
  }
  return Math.round(value * unit);
}

// Parses Google Takeout's archive_browser.html (the index archive's file listing).
export function parseArchiveBrowser(html: string): ArchiveBrowserIndex {
  const googleJobId = firstMatch(html, /<div class="job-id[^"]*">([^<]*)<\/div>/);
  const accountEmail = firstMatch(html, /Archive for ([^<]+)<\/h1>/);

  let createdText: string | null = null;
  let totalSizeText: string | null = null;
  const subtext = /<div class="header_subtext">([\s\S]*?)<\/div>/.exec(html);
  if (subtext) {
    const parts = subtext[1].split('•').map((p) => decodeEntities(p.replaceAll(/<[^>]*>/g, '')).trim());
    createdText = parts[0] || null;
    totalSizeText = parts[1] || null;
  }

  const services: ArchiveBrowserIndex['services'] = [];
  const files: string[] = [];

  // Each service is its own detail block.
  const blockRe = /<div id="service-details-[^"]*" class="service-detail"[\s\S]*?(?=<div id="service-details-|$)/g;
  const combined =
    /<div class="extracted-folder-name">([^<]*)<\/div>|class="file-leaf"><div class="extracted-file-name">([^<]*)<\/div>/g;

  const blocks = html.match(blockRe);
  if (blocks) {
    for (const b of blocks) {
      const englishName = firstMatch(b, /<h1>([^<]*)<\/h1>/) ?? '';
      const folderName = englishName;
      const countM = /([\d,]+) files/.exec(b);
      const fileCount = countM ? Number(countM[1].replaceAll(',', '')) : 0;
      const sizeM = /files exported[^•]*•\s*([^<•]+)/.exec(b);
      const sizeText = sizeM ? decodeEntities(sizeM[1]).trim() : '';
      services.push({ englishName, folderName, fileCount, sizeText });

      combined.lastIndex = 0;
      let currentFolder: string | null = null;
      let m: RegExpExecArray | null;
      while ((m = combined.exec(b)) !== null) {
        if (m[1] === undefined) {
          const name = decodeEntities(m[2]).trim();
          files.push(
            currentFolder === null ? `Takeout/${folderName}/${name}` : `Takeout/${folderName}/${currentFolder}/${name}`,
          );
        } else {
          currentFolder = decodeEntities(m[1]).trim();
        }
      }
    }
  }

  return { googleJobId, accountEmail, createdText, totalSizeText, services, files };
}
