import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const SOURCES_FILE = path.join(ROOT, "remote/data/strompreis-sources.json");
const CACHE_FILE = path.join(ROOT, "remote/data/strompreise.json");
const sources = JSON.parse(await fs.readFile(SOURCES_FILE, "utf8"));

const toNum = v => Number(String(v).replace(",", "."));
const valid = v => Number.isFinite(v) && v > 0 && v <= 100;
const normalize = s => String(s || "").normalize("NFKC").replace(/[\u00A0\u202F\u2007]/g, " ").replace(/[\u200B\u00AD]/g, "").replace(/\s+/g, " ").trim();

function parseEnergy(text) {
  let m = text.match(/(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh\s*inkl\.?\s*USt/i);
  if (m && valid(toNum(m[1]))) return { valueCt: toNum(m[1]), netCt: null };
  m = text.match(/(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh\s*exkl\.?\s*USt/i);
  if (m && valid(toNum(m[1]))) {
    const netCt = toNum(m[1]);
    return { valueCt: Math.round(netCt * 1.2 * 1000) / 1000, netCt };
  }
  throw new Error("TIWAG Energiepreis nicht gefunden");
}

function parseGrid(text) {
  for (const re of [
    /in\s+Tirol[^.]{0,250}?lediglich\s*(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i,
    /Tirol[^.]{0,200}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i,
    /Netzentgelt\w*[^.]{0,250}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i
  ]) {
    const m = text.match(re); const n = m ? toNum(m[1]) : NaN;
    if (valid(n)) return n;
  }
  throw new Error("TINETZ Netzentgelt nicht gefunden");
}

function parseFeedIn(text) {
  const rows = [];
  const re = /Q\s*([1-4])\s*(\d{4})[^\d]{0,100}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const row = { quarter: Number(m[1]), year: Number(m[2]), valueCt: toNum(m[3]) };
    if (row.quarter >= 1 && row.quarter <= 4 && row.year >= 2000 && valid(row.valueCt)) rows.push(row);
  }
  if (!rows.length) throw new Error("TIWAG PV-Einspeisepreis nicht gefunden");
  const now = new Date(); const cy = now.getUTCFullYear(); const cq = Math.floor(now.getUTCMonth() / 3) + 1;
  const key = r => r.year * 4 + r.quarter; const ck = cy * 4 + cq;
  return rows.find(r => r.year === cy && r.quarter === cq) || rows.filter(r => key(r) <= ck).sort((a,b) => key(b)-key(a))[0] || rows.sort((a,b) => key(b)-key(a))[0];
}

async function loadText(browser, url) {
  const page = await browser.newPage({ locale: "de-AT", userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return normalize(await page.locator("body").innerText());
  } finally { await page.close(); }
}

const browser = await chromium.launch({ headless: true });
let energyText, gridText, feedText;
try {
  [energyText, gridText, feedText] = await Promise.all([loadText(browser, sources.energy), loadText(browser, sources.grid), loadText(browser, sources.feedIn)]);
} finally { await browser.close(); }

const e = parseEnergy(energyText); const g = parseGrid(gridText); const f = parseFeedIn(feedText);
const values = {
  energy: { valueCt: e.valueCt, netCt: e.netCt, sourceUrl: sources.energy },
  grid: { valueCt: g, sourceUrl: sources.grid },
  feedIn: { valueCt: f.valueCt, quarter: f.quarter, year: f.year, sourceUrl: sources.feedIn }
};
let old = null; try { old = JSON.parse(await fs.readFile(CACHE_FILE, "utf8")); } catch {}
const same = old && Number(old.energy?.valueCt)===Number(values.energy.valueCt) && Number(old.grid?.valueCt)===Number(values.grid.valueCt) && Number(old.feedIn?.valueCt)===Number(values.feedIn.valueCt) && Number(old.feedIn?.quarter)===Number(values.feedIn.quarter) && Number(old.feedIn?.year)===Number(values.feedIn.year) && old.energy?.sourceUrl===values.energy.sourceUrl && old.grid?.sourceUrl===values.grid.sourceUrl && old.feedIn?.sourceUrl===values.feedIn.sourceUrl;
if (same) { console.log("Strompreise unverändert – Cache bleibt bestehen."); process.exit(0); }
const out = { schema: 1, updatedAt: new Date().toISOString(), ...values };
await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
await fs.writeFile(CACHE_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("Strompreise aktualisiert:", out);
