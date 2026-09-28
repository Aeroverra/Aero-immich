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
  const combined = /<div class="extracted-folder-name">([^<]*)<\/div>|class="file-leaf"><div class="extracted-file-name">([^<]*)<\/div>/g;

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
          files.push(currentFolder === null ? `Takeout/${folderName}/${name}` : `Takeout/${folderName}/${currentFolder}/${name}`);
        } else {
          currentFolder = decodeEntities(m[1]).trim();
        }
      }
    }
  }

  return { googleJobId, accountEmail, createdText, totalSizeText, services, files };
}
