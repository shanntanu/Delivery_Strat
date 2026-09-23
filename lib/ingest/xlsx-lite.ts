// Minimal, dependency-free XLSX reader for one narrow case: NSE has been
// observed serving sec_bhavdata_full as an actual Excel file (confirmed for
// 2022-08-08) despite the .csv URL and declared content-type. Pulling in the
// `xlsx` (SheetJS) package for this was rejected — it carries an unpatched
// HIGH severity prototype-pollution advisory with no fix available
// (GHSA-4r6h-8v6p-xvw6). This file reads just enough of the OOXML structure
// (shared strings + the first worksheet's cells) to reconstruct rows; NSE's
// bhavcopy data is flat numbers/short strings, so this simple approach holds.
import AdmZip from "adm-zip";

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function columnLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  // Each <si> may contain a single <t> or multiple <r><t> runs; concatenate.
  const siBlocks = xml.match(/<si>[\s\S]*?<\/si>/g) ?? [];
  for (const si of siBlocks) {
    const texts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
    strings.push(texts.join(""));
  }
  return strings;
}

function parseSheet(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowBlocks = xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g);

  for (const rowMatch of rowBlocks) {
    const rowXml = rowMatch[1];
    const cells: string[] = [];

    for (const cellMatch of rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, colLetters, attrs, inner] = cellMatch;
      const colIndex = columnLetterToIndex(colLetters);
      const isSharedString = /t="s"/.test(attrs);

      let value = "";
      if (inner) {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (vMatch) {
          value = isSharedString ? sharedStrings[Number(vMatch[1])] ?? "" : unescapeXml(vMatch[1]);
        } else {
          // Inline string: <is><t>...</t></is>
          const tMatch = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          if (tMatch) value = unescapeXml(tMatch[1]);
        }
      }

      cells[colIndex] = value;
    }

    // Fill any gaps (columns with no <c> element, i.e. truly empty cells) with "".
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
    rows.push(cells);
  }

  return rows;
}

/** Parse an XLSX buffer's first worksheet into the same
 * Record<string,string>[] shape csv-parse's `columns:true` mode produces,
 * so callers don't need to know which format they got. */
export function parseXlsxAsRecords(buf: Buffer): Record<string, string>[] {
  const zip = new AdmZip(buf);
  const sheetEntry = zip.getEntry("xl/worksheets/sheet1.xml");
  if (!sheetEntry) {
    throw new Error("XLSX file has no xl/worksheets/sheet1.xml");
  }
  const sharedStringsEntry = zip.getEntry("xl/sharedStrings.xml");
  const sharedStrings = parseSharedStrings(sharedStringsEntry?.getData().toString("utf-8") ?? null);

  const rows = parseSheet(sheetEntry.getData().toString("utf-8"), sharedStrings);
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((h, i) => (record[h] = (row[i] ?? "").trim()));
    return record;
  });
}

export function isXlsxZip(buf: Buffer): boolean {
  if (buf.slice(0, 2).toString("hex") !== "504b") return false;
  const zip = new AdmZip(buf);
  return zip.getEntry("xl/workbook.xml") !== null;
}
