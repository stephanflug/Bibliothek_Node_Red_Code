import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const SOURCES_FILE = path.join(ROOT, "remote/data/strompreis-sources.json");
const CACHE_FILE = path.join(ROOT, "remote/data/strompreise.json");
const sources = JSON.parse(await fs.readFile(SOURCES_FILE, "utf8"));

const toNum = value => Number(String(value).replace(",", "."));
const validCt = value => Number.isFinite(value) && value > 0 && value <= 100;
const round3 = value => Math.round(value * 1000) / 1000;
const normalize = value => String(value || "")
    .normalize("NFKC")
    .replace(/[\u00A0\u202F\u2007]/g, " ")
    .replace(/[\u200B\u00AD]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const sourceList = value => Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);

function findNumber(text, regex, group = 1) {
    const match = text.match(regex);
    if (!match) return null;
    const value = toNum(match[group]);
    return validCt(value) ? value : null;
}

function parseEnergy(text) {
    const t = normalize(text);

    // 1) Bevorzugt das reguläre Haushaltsprodukt "comfort privat".
    const comfortMatch = t.match(/comfort\s+privat([\s\S]{0,1600})/i);
    const comfort = comfortMatch ? comfortMatch[1] : "";

    if (comfort) {
        const comfortPatterns = [
            /Arbeitspreis[^0-9]{0,120}(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh[\s\S]{0,120}?(?:brutto|inkl\.?\s*(?:20\s*%\s*)?USt)/i,
            /Arbeitspreis[\s\S]{0,220}?(?:brutto|inkl\.?\s*(?:20\s*%\s*)?USt)[^0-9]{0,120}(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i,
            /Arbeitspreis[^0-9]{0,120}(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i
        ];

        for (const re of comfortPatterns) {
            const gross = findNumber(comfort, re);
            if (gross !== null) {
                const net = findNumber(
                    comfort,
                    /(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh[\s\S]{0,80}?exkl\.?\s*(?:20\s*%\s*)?USt/i
                );
                return { valueCt: gross, netCt: net, parser: "comfort-privat" };
            }
        }
    }

    // 2) Produkt-/Preisblatt-Tabelle: "Arbeitspreis Cent/kWh 9,80 11,76".
    //    Diese Darstellung ist auf dem offiziellen TIWAG-PDF besonders stabil.
    const tablePair = t.match(
        /Arbeitspreis[\s\S]{0,100}?(?:Cent|ct)\s*\/?\s*kWh[\s|:;,-]{0,60}(\d{1,2}[,.]\d{1,3})[\s|:;,-]+(\d{1,2}[,.]\d{1,3})/i
    );
    if (tablePair) {
        const net = toNum(tablePair[1]);
        const gross = toNum(tablePair[2]);
        if (validCt(net) && validCt(gross) && gross >= net) {
            return { valueCt: gross, netCt: net, parser: "price-sheet-table" };
        }
    }

    // 3) Explizites Netto-/Brutto-Paar.
    const pairPatterns = [
        /(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh\s*exkl\.?\s*(?:20\s*%\s*)?USt[\s\S]{0,100}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh\s*inkl\.?\s*(?:20\s*%\s*)?USt/i,
        /netto[\s\S]{0,100}?(\d{1,2}[,.]\d{1,3})[\s\S]{0,120}?brutto[\s\S]{0,100}?(\d{1,2}[,.]\d{1,3})/i
    ];

    for (const re of pairPatterns) {
        const m = t.match(re);
        if (!m) continue;
        const net = toNum(m[1]);
        const gross = toNum(m[2]);
        if (validCt(net) && validCt(gross) && gross >= net) {
            return { valueCt: gross, netCt: net, parser: "net-gross-pair" };
        }
    }

    // 4) Allgemeine Brutto-Schreibweisen.
    const grossPatterns = [
        /Arbeitspreis[\s\S]{0,180}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh[\s\S]{0,100}?(?:brutto|inkl\.?\s*(?:20\s*%\s*)?USt)/i,
        /(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh[\s\S]{0,80}?(?:brutto|inkl\.?\s*(?:20\s*%\s*)?USt)/i
    ];

    for (const re of grossPatterns) {
        const gross = findNumber(t, re);
        if (gross !== null) return { valueCt: gross, netCt: null, parser: "gross" };
    }

    // 5) Netto-Erkennung als letzter regulärer Weg; 20 % USt werden ergänzt.
    const netPatterns = [
        /Arbeitspreis[\s\S]{0,180}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh[\s\S]{0,100}?(?:netto|exkl\.?\s*(?:20\s*%\s*)?USt)/i,
        /(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh[\s\S]{0,80}?(?:netto|exkl\.?\s*(?:20\s*%\s*)?USt)/i
    ];

    for (const re of netPatterns) {
        const net = findNumber(t, re);
        if (net !== null) return { valueCt: round3(net * 1.2), netCt: net, parser: "net-plus-vat" };
    }

    throw new Error("TIWAG Energiepreis nicht gefunden");
}

function parseGrid(text) {
    const t = normalize(text);
    const patterns = [
        /in\s+Tirol[\s\S]{0,350}?lediglich\s*(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i,
        /Tirol[\s\S]{0,280}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i,
        /Netzentgelt\w*[\s\S]{0,300}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i
    ];

    for (const re of patterns) {
        const value = findNumber(t, re);
        if (value !== null) return { valueCt: value, parser: "tinetz-text" };
    }

    throw new Error("TINETZ Netzentgelt nicht gefunden");
}

function parseFeedIn(text) {
    const t = normalize(text);
    const rows = [];

    const patterns = [
        { re: /Q\s*([1-4])\s*(\d{4})[^\d]{0,120}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/gi, reversed: false },
        { re: /(\d{4})\s*Q\s*([1-4])[^\d]{0,120}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/gi, reversed: true }
    ];

    for (const item of patterns) {
        let m;
        while ((m = item.re.exec(t)) !== null) {
            const quarter = item.reversed ? Number(m[2]) : Number(m[1]);
            const year = item.reversed ? Number(m[1]) : Number(m[2]);
            const valueCt = toNum(m[3]);

            if (
                quarter >= 1 && quarter <= 4 &&
                year >= 2000 && year <= 2100 &&
                validCt(valueCt)
            ) {
                rows.push({ quarter, year, valueCt });
            }
        }
    }

    const unique = [...new Map(
        rows.map(row => [row.year + "-" + row.quarter + "-" + row.valueCt, row])
    ).values()];

    if (!unique.length) throw new Error("TIWAG PV-Einspeisepreis nicht gefunden");

    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentQuarter = Math.floor(now.getUTCMonth() / 3) + 1;
    const currentKey = currentYear * 4 + currentQuarter;
    const key = row => row.year * 4 + row.quarter;

    const selected =
        unique.find(row => row.year === currentYear && row.quarter === currentQuarter) ||
        unique.filter(row => key(row) <= currentKey).sort((a, b) => key(b) - key(a))[0] ||
        unique.sort((a, b) => key(b) - key(a))[0];

    return {
        valueCt: selected.valueCt,
        quarter: selected.quarter,
        year: selected.year,
        parser: "quarter-table"
    };
}

function decodeHtmlEntities(value) {
    return String(value || "")
        .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
    return normalize(
        decodeHtmlEntities(
            String(html || "")
                .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
                .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
                .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
                .replace(/<!--[\s\S]*?-->/g, " ")
                .replace(/<br\s*\/?>/gi, " ")
                .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|section|article)>/gi, " ")
                .replace(/<[^>]+>/g, " ")
        )
    );
}

async function loadTextDirect(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "de-AT,de;q=0.9,en;q=0.7",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache"
            }
        });

        if (!response.ok) throw new Error("HTTP " + response.status);

        const contentType = String(response.headers.get("content-type") || "");
        if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
            throw new Error("unerwarteter Content-Type: " + (contentType || "unbekannt"));
        }

        const html = await response.text();
        const text = htmlToText(html);

        if (text.length < 100) {
            throw new Error("Direktabruf Inhalt zu kurz (" + text.length + " Zeichen)");
        }

        return text;
    } finally {
        clearTimeout(timeout);
    }
}

async function loadTextReader(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const readerUrl = "https://r.jina.ai/" + url;

    try {
        const response = await fetch(readerUrl, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "User-Agent": "EBST-Strompreis-Updater/2.0",
                "Accept": "text/plain,text/markdown;q=0.9,*/*;q=0.5",
                "Cache-Control": "no-cache"
            }
        });

        if (!response.ok) throw new Error("Reader HTTP " + response.status);

        const text = normalize(await response.text());
        if (text.length < 100) {
            throw new Error("Reader-Inhalt zu kurz (" + text.length + " Zeichen)");
        }

        return text;
    } finally {
        clearTimeout(timeout);
    }
}

async function loadTextBrowser(browser, url, attempt = 1) {
    const page = await browser.newPage({
        locale: "de-AT",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    });

    try {
        const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        const status = response ? response.status() : 0;
        if (status >= 400) throw new Error("HTTP " + status);

        await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(attempt === 1 ? 1800 : 3500);

        let body = "";
        try {
            body = normalize(await page.locator("body").innerText({ timeout: 15000 }));
        } catch {}

        if (body.length < 100) {
            const html = await page.content().catch(() => "");
            body = htmlToText(html);
        }

        if (body.length < 100) {
            throw new Error("Browserinhalt zu kurz (" + body.length + " Zeichen)");
        }

        return body;
    } finally {
        await page.close();
    }
}

async function readAndParse(browser, urls, parser, label) {
    const attempts = [];

    for (const url of sourceList(urls)) {
        // Strategie A: direkter HTTP-Abruf. Funktioniert auch dann, wenn JavaScript/Browser
        // durch Bot-Schutz oder leere DOM-Seiten behindert wird.
        try {
            const text = await loadTextDirect(url);
            const parsed = parser(text);
            console.log("✓ " + label + ": " + url + " (Direktabruf / " + (parsed.parser || "Parser") + ")");
            return { parsed, sourceUrl: url, fallback: false, transport: "direct" };
        } catch (err) {
            attempts.push(url + " [Direktabruf]: " + err.message);
            console.warn("⚠ " + label + ": " + url + ", Direktabruf: " + err.message);
        }

        // Strategie B: Text-Reader-Proxy. Er liest die offizielle Zielseite,
        // wenn deren Bot-Schutz GitHub Actions direkt blockiert.
        try {
            const text = await loadTextReader(url);
            const parsed = parser(text);
            console.log("✓ " + label + ": " + url + " (Reader / " + (parsed.parser || "Parser") + ")");
            return { parsed, sourceUrl: url, fallback: false, transport: "reader" };
        } catch (err) {
            attempts.push(url + " [Reader]: " + err.message);
            console.warn("⚠ " + label + ": " + url + ", Reader: " + err.message);
        }

        // Strategie C: Browser-Fallback mit zwei Versuchen.
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const text = await loadTextBrowser(browser, url, attempt);
                const parsed = parser(text);
                console.log("✓ " + label + ": " + url + " (Browser / " + (parsed.parser || "Parser") + ")");
                return { parsed, sourceUrl: url, fallback: false, transport: "browser" };
            } catch (err) {
                attempts.push(url + " [Browser Versuch " + attempt + "]: " + err.message);
                console.warn("⚠ " + label + ": " + url + ", Browser Versuch " + attempt + ": " + err.message);
            }
        }
    }

    const error = new Error(label + ": keine Quelle erfolgreich. " + attempts.join(" | "));
    error.attempts = attempts;
    throw error;
}

function oldEnergy(old) {
    const valueCt = Number(old && old.energy && old.energy.valueCt);
    if (!validCt(valueCt)) return null;

    const netRaw = old && old.energy ? old.energy.netCt : null;
    const netCt = Number(netRaw);

    return {
        parsed: {
            valueCt,
            netCt: Number.isFinite(netCt) ? netCt : null,
            parser: "cache-fallback"
        },
        sourceUrl: old && old.energy && old.energy.sourceUrl
            ? old.energy.sourceUrl
            : (sourceList(sources.energy)[0] || null),
        fallback: true
    };
}

function oldGrid(old) {
    const valueCt = Number(old && old.grid && old.grid.valueCt);
    if (!validCt(valueCt)) return null;

    return {
        parsed: { valueCt, parser: "cache-fallback" },
        sourceUrl: old && old.grid && old.grid.sourceUrl
            ? old.grid.sourceUrl
            : (sourceList(sources.grid)[0] || null),
        fallback: true
    };
}

function oldFeedIn(old) {
    const valueCt = Number(old && old.feedIn && old.feedIn.valueCt);
    const quarter = Number(old && old.feedIn && old.feedIn.quarter);
    const year = Number(old && old.feedIn && old.feedIn.year);

    if (
        !validCt(valueCt) ||
        !(quarter >= 1 && quarter <= 4) ||
        !(year >= 2000)
    ) {
        return null;
    }

    return {
        parsed: {
            valueCt,
            quarter,
            year,
            parser: "cache-fallback"
        },
        sourceUrl: old && old.feedIn && old.feedIn.sourceUrl
            ? old.feedIn.sourceUrl
            : (sourceList(sources.feedIn)[0] || null),
        fallback: true
    };
}

let old = null;
try {
    old = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
} catch {
    old = null;
}

const browser = await chromium.launch({ headless: true });

let energyResult;
let gridResult;
let feedInResult;
const errors = [];

try {
    const results = await Promise.allSettled([
        readAndParse(browser, sources.energy, parseEnergy, "TIWAG Energiepreis"),
        readAndParse(browser, sources.grid, parseGrid, "TINETZ Netzentgelt"),
        readAndParse(browser, sources.feedIn, parseFeedIn, "TIWAG PV-Einspeisung")
    ]);

    energyResult = results[0].status === "fulfilled" ? results[0].value : null;
    gridResult = results[1].status === "fulfilled" ? results[1].value : null;
    feedInResult = results[2].status === "fulfilled" ? results[2].value : null;

    if (!energyResult) {
        errors.push(results[0].reason && results[0].reason.message ? results[0].reason.message : "TIWAG Energiepreis unbekannter Fehler");
        energyResult = oldEnergy(old);
    }

    if (!gridResult) {
        errors.push(results[1].reason && results[1].reason.message ? results[1].reason.message : "TINETZ Netzentgelt unbekannter Fehler");
        gridResult = oldGrid(old);
    }

    if (!feedInResult) {
        errors.push(results[2].reason && results[2].reason.message ? results[2].reason.message : "TIWAG PV-Einspeisung unbekannter Fehler");
        feedInResult = oldFeedIn(old);
    }
} finally {
    await browser.close();
}

if (!energyResult || !gridResult || !feedInResult) {
    throw new Error(
        "Strompreis-Aktualisierung fehlgeschlagen: Mindestens ein Wert konnte weder gelesen noch aus dem Cache übernommen werden. " +
        errors.join(" || ")
    );
}

if (errors.length) {
    console.warn("⚠ Mindestens eine Quelle konnte aktuell nicht gelesen werden; gültiger letzter Cachewert wird verwendet:");
    for (const error of errors) console.warn("  - " + error);
}

const values = {
    energy: {
        valueCt: energyResult.parsed.valueCt,
        netCt: energyResult.parsed.netCt,
        sourceUrl: energyResult.sourceUrl
    },
    grid: {
        valueCt: gridResult.parsed.valueCt,
        sourceUrl: gridResult.sourceUrl
    },
    feedIn: {
        valueCt: feedInResult.parsed.valueCt,
        quarter: feedInResult.parsed.quarter,
        year: feedInResult.parsed.year,
        sourceUrl: feedInResult.sourceUrl
    }
};

console.log("Ermittelte Werte:", JSON.stringify(values, null, 2));

const oldEnergyNet = old && old.energy && old.energy.netCt !== undefined && old.energy.netCt !== null
    ? Number(old.energy.netCt)
    : null;
const newEnergyNet = values.energy.netCt !== undefined && values.energy.netCt !== null
    ? Number(values.energy.netCt)
    : null;

const same = old &&
    Number(old.energy && old.energy.valueCt) === Number(values.energy.valueCt) &&
    oldEnergyNet === newEnergyNet &&
    Number(old.grid && old.grid.valueCt) === Number(values.grid.valueCt) &&
    Number(old.feedIn && old.feedIn.valueCt) === Number(values.feedIn.valueCt) &&
    Number(old.feedIn && old.feedIn.quarter) === Number(values.feedIn.quarter) &&
    Number(old.feedIn && old.feedIn.year) === Number(values.feedIn.year);

if (same) {
    console.log("Strompreise unverändert – Cache bleibt bestehen.");
    process.exit(0);
}

const out = {
    schema: 1,
    updatedAt: new Date().toISOString(),
    ...values
};

await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
await fs.writeFile(CACHE_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log("Strompreise aktualisiert:", JSON.stringify(out, null, 2));
