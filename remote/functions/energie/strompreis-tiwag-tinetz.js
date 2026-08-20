"use strict";

const http = require("http");
const https = require("https");

module.exports = async function run(ctx) {
    const { msg, node, flow, global, config } = ctx;

    function n(value, fallback) {
        const x = Number(value);
        return Number.isFinite(x) ? x : fallback;
    }

    function b(value, fallback) {
        if (typeof value === "boolean") return value;
        if (value === "true" || value === 1 || value === "1") return true;
        if (value === "false" || value === 0 || value === "0") return false;
        return fallback;
    }

    function round(value, digits) {
        const f = 10 ** digits;
        return Math.round((Number(value) + Number.EPSILON) * f) / f;
    }

    function toNum(value) {
        const x = Number(String(value).trim().replace(",", "."));
        return Number.isFinite(x) ? x : NaN;
    }

    function normalizeText(text) {
        return String(text || "")
            .normalize("NFKC")
            .replace(/[\u00A0\u202F\u2007]/g, " ")
            .replace(/[\u200B\u00AD]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function decodeHtmlEntities(text) {
        return String(text || "")
            .replace(/&nbsp;|&#160;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&#(\d+);/g, (m, code) => {
                const x = Number(code);
                return Number.isFinite(x) ? String.fromCodePoint(x) : m;
            })
            .replace(/&#x([0-9a-f]+);/gi, (m, code) => {
                const x = parseInt(code, 16);
                return Number.isFinite(x) ? String.fromCodePoint(x) : m;
            });
    }

    function htmlToText(html) {
        return normalizeText(
            decodeHtmlEntities(html)
                .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
                .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
                .replace(/<!--[\s\S]*?-->/g, " ")
                .replace(/<[^>]+>/g, " ")
        );
    }

    function titleFromHtml(html) {
        const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return m ? normalizeText(decodeHtmlEntities(m[1])) : null;
    }

    function compileRegex(pattern, name, flags = "i") {
        try {
            return new RegExp(String(pattern || ""), flags);
        } catch (err) {
            throw new Error(`${name}: ungültiger regulärer Ausdruck: ${err.message}`);
        }
    }

    function isCookieWall(text, title) {
        const s = normalizeText(`${title || ""} ${text || ""}`).toLowerCase();
        return (
            s.includes("cookie-information") ||
            s.includes("cookie-popup does not work properly without javascript enabled") ||
            (s.includes("please enable it to continue") && s.includes("cookie"))
        );
    }

    function previewText(text) {
        const s = normalizeText(text);
        return s.length > 700 ? s.slice(0, 700) + " …" : s;
    }

    function requestText(url, timeoutMs, redirects = 0, headers = {}) {
        return new Promise((resolve, reject) => {
            if (redirects > 5) {
                reject(new Error("Zu viele HTTP-Weiterleitungen"));
                return;
            }

            let parsed;
            try {
                parsed = new URL(url);
            } catch (_) {
                reject(new Error(`Ungültige URL: ${url}`));
                return;
            }

            if (!/^https?:$/.test(parsed.protocol)) {
                reject(new Error(`Nur HTTP/HTTPS wird unterstützt: ${url}`));
                return;
            }

            const client = parsed.protocol === "https:" ? https : http;
            const req = client.get(parsed, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
                    "Accept-Language": "de-AT,de;q=0.9,en;q=0.6",
                    "Cache-Control": "no-cache",
                    "Pragma": "no-cache",
                    ...headers
                },
                timeout: timeoutMs
            }, res => {
                const status = res.statusCode || 0;

                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    const next = new URL(res.headers.location, parsed).toString();
                    requestText(next, timeoutMs, redirects + 1, headers).then(resolve, reject);
                    return;
                }

                if (status < 200 || status >= 300) {
                    res.resume();
                    reject(new Error(`HTTP ${status} bei ${url}`));
                    return;
                }

                res.setEncoding("utf8");
                let body = "";
                res.on("data", chunk => {
                    body += chunk;
                    if (body.length > 6 * 1024 * 1024) {
                        req.destroy(new Error("Antwort ist größer als 6 MB"));
                    }
                });
                res.on("end", () => resolve({
                    body,
                    status,
                    finalUrl: parsed.toString(),
                    contentType: String(res.headers["content-type"] || "")
                }));
            });

            req.on("timeout", () => req.destroy(new Error("HTTP Timeout")));
            req.on("error", reject);
        });
    }

    async function fetchPage(url, timeoutMs) {
        let direct = null;
        let directError = null;

        try {
            direct = await requestText(url, timeoutMs);
        } catch (err) {
            directError = err;
        }

        if (direct) {
            const directText = htmlToText(direct.body);
            const directTitle = titleFromHtml(direct.body);
            if (!isCookieWall(directText, directTitle)) {
                return {
                    text: directText,
                    page: {
                        httpStatus: direct.status,
                        finalUrl: direct.finalUrl,
                        contentType: direct.contentType,
                        fetchMethod: "direct",
                        bytes: Buffer.byteLength(direct.body, "utf8"),
                        title: directTitle,
                        preview: previewText(directText),
                        cookieWallDetected: false,
                        readerUsed: false,
                        directError: null
                    }
                };
            }
        }

        // TIWAG/TINETZ liefern serverseitig teilweise nur eine JavaScript-Cookie-Seite.
        // In diesem Fall wird die Zielseite gerendert über Jina Reader abgefragt.
        const readerUrl = "https://r.jina.ai/" + url;
        try {
            const reader = await requestText(readerUrl, Math.max(timeoutMs, 30000), 0, {
                "Accept": "text/plain,*/*;q=0.8",
                "X-Return-Format": "text"
            });
            const readerText = normalizeText(reader.body);

            if (readerText && !isCookieWall(readerText, null)) {
                return {
                    text: readerText,
                    page: {
                        httpStatus: reader.status,
                        finalUrl: url,
                        contentType: reader.contentType,
                        fetchMethod: "jina-reader",
                        bytes: Buffer.byteLength(reader.body, "utf8"),
                        title: null,
                        preview: previewText(readerText),
                        cookieWallDetected: Boolean(direct),
                        readerUsed: true,
                        readerUrl,
                        directHttpStatus: direct ? direct.status : null,
                        directTitle: direct ? titleFromHtml(direct.body) : null,
                        directPreview: direct ? previewText(htmlToText(direct.body)) : null,
                        directError: directError ? directError.message : null
                    }
                };
            }

            throw new Error("Reader lieferte keinen auswertbaren Inhalt");
        } catch (readerErr) {
            const directText = direct ? htmlToText(direct.body) : "";
            return {
                text: directText,
                page: {
                    httpStatus: direct ? direct.status : null,
                    finalUrl: direct ? direct.finalUrl : url,
                    contentType: direct ? direct.contentType : null,
                    fetchMethod: direct ? "direct-cookie-wall" : "failed",
                    bytes: direct ? Buffer.byteLength(direct.body, "utf8") : 0,
                    title: direct ? titleFromHtml(direct.body) : null,
                    preview: previewText(directText),
                    cookieWallDetected: direct ? isCookieWall(directText, titleFromHtml(direct.body)) : false,
                    readerUsed: true,
                    readerUrl,
                    readerError: readerErr.message,
                    directError: directError ? directError.message : null
                }
            };
        }
    }

    const CFG = {
        energyUrl: String(config.energyUrl || "https://www.tiwag.at/tutwas/").trim(),
        gridUrl: String(config.gridUrl || "https://www.tinetz.at/infobereich/allgemeines/netztarifaenderungen-ab-2026/").trim(),
        feedInEnabled: b(config.feedInEnabled, true),
        feedInUrl: String(config.feedInUrl || "https://www.tiwag.at/privat/photovoltaik/tiwag-pv-einspeisung/").trim(),

        energyFallbackCt: n(config.energyFallbackCt, 11.76),
        gridFallbackCt: n(config.gridFallbackCt, 8.66),
        feedInFallbackCt: n(config.feedInFallbackCt, 8.29),
        extraCtPerKwh: n(config.extraCtPerKwh, 0),
        vatPercent: n(config.vatPercent, 20),

        energyGrossRegex: String(config.energyGrossRegex || "(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh\\s*inkl\\.?\\s*USt"),
        energyNetRegex: String(config.energyNetRegex || "(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh\\s*exkl\\.?\\s*USt"),
        gridRegex: String(config.gridRegex || "in\\s+Tirol[^.]{0,250}?lediglich\\s*(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),
        feedInRegex: String(config.feedInRegex || "Q([1-4])\\s*(\\d{4})[^\\d]{0,100}?(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),

        allowFallback: b(config.allowFallback, true),
        timeoutSec: Math.max(3, Math.min(60, n(config.timeoutSec, 15))),

        topicEur: String(config.topicEur || "0_userdata.0.PV.Ersparnis.Strompreis_EUR_kWh"),
        topicCt: String(config.topicCt || "0_userdata.0.PV.Ersparnis.Strompreis_ct_kWh"),
        topicFeedInCt: String(config.topicFeedInCt || "0_userdata.0.PV.Einspeisung.Strompreis_ct_kWh")
    };

    if (!CFG.energyUrl || !CFG.gridUrl) {
        throw new Error("Strompreis: Energie-URL und Netz-URL müssen gesetzt sein");
    }
    if (CFG.feedInEnabled && !CFG.feedInUrl) {
        throw new Error("Strompreis: Einspeise-URL muss gesetzt sein");
    }

    const timeoutMs = CFG.timeoutSec * 1000;
    const energyGrossRe = compileRegex(CFG.energyGrossRegex, "Energie brutto RegEx");
    const energyNetRe = compileRegex(CFG.energyNetRegex, "Energie netto RegEx");
    const gridRe = compileRegex(CFG.gridRegex, "Netz RegEx");

    function validPrice(x) {
        return Number.isFinite(x) && x > 0 && x <= 100;
    }

    function parseEnergy(text) {
        let match = energyGrossRe.exec(text);
        if (match) {
            const ct = toNum(match[1]);
            if (validPrice(ct)) {
                return { ct: round(ct, 3), source: "Webseite brutto · konfiguriertes RegEx", matched: match[0] };
            }
        }

        match = energyNetRe.exec(text);
        if (match) {
            const netCt = toNum(match[1]);
            if (validPrice(netCt)) {
                return {
                    ct: round(netCt * (1 + CFG.vatPercent / 100), 3),
                    netCt: round(netCt, 3),
                    source: `Webseite netto + ${CFG.vatPercent}% USt · konfiguriertes RegEx`,
                    matched: match[0]
                };
            }
        }

        const candidates = [
            /(?:comfort\s+privat|arbeitspreis)[\s\S]{0,350}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh[\s\S]{0,100}?(?:brutto|inkl\.?\s*20\s*%\s*USt|inkl\.?\s*USt)/i,
            /(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh[\s\S]{0,80}?(?:brutto|inkl\.?\s*20\s*%\s*USt|inkl\.?\s*USt)/i
        ];

        for (const re of candidates) {
            match = re.exec(text);
            if (match) {
                const ct = toNum(match[1]);
                if (validPrice(ct)) {
                    return { ct: round(ct, 3), source: "Webseite brutto · flexible Erkennung", matched: match[0] };
                }
            }
        }

        match = /(?:comfort\s+privat|arbeitspreis)[\s\S]{0,300}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh[\s\S]{0,80}?(?:netto|exkl\.?\s*USt)/i.exec(text);
        if (match) {
            const netCt = toNum(match[1]);
            if (validPrice(netCt)) {
                return {
                    ct: round(netCt * (1 + CFG.vatPercent / 100), 3),
                    netCt: round(netCt, 3),
                    source: `Webseite netto + ${CFG.vatPercent}% USt · flexible Erkennung`,
                    matched: match[0]
                };
            }
        }

        return null;
    }

    function parseGrid(text) {
        let match = gridRe.exec(text);
        if (match) {
            const ct = toNum(match[1]);
            if (validPrice(ct)) {
                return { ct: round(ct, 3), source: "Webseite · konfiguriertes RegEx", matched: match[0] };
            }
        }

        const patterns = [
            /zahlen\s+Sie\s+in\s+Tirol[\s\S]{0,120}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i,
            /Tirol[\s\S]{0,180}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i,
            /Netzentgelt\w*[\s\S]{0,220}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i
        ];

        for (const re of patterns) {
            match = re.exec(text);
            if (match) {
                const ct = toNum(match[1]);
                if (validPrice(ct)) {
                    return { ct: round(ct, 3), source: "Webseite · flexible Erkennung", matched: match[0] };
                }
            }
        }
        return null;
    }

    function parseFeedIn(text) {
        const rows = [];
        const configured = compileRegex(CFG.feedInRegex, "Einspeisung RegEx", "gi");
        let match;

        while ((match = configured.exec(text)) !== null) {
            const quarter = Number(match[1]);
            const year = Number(match[2]);
            const ct = toNum(match[3]);
            if (quarter >= 1 && quarter <= 4 && year >= 2000 && year <= 2200 && validPrice(ct)) {
                rows.push({ quarter, year, ct: round(ct, 3), matched: match[0] });
            }
            if (match[0] === "") configured.lastIndex++;
        }

        if (!rows.length) {
            const flexible = /Q\s*([1-4])\s*(\d{4})[\s\S]{0,60}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/gi;
            while ((match = flexible.exec(text)) !== null) {
                const quarter = Number(match[1]);
                const year = Number(match[2]);
                const ct = toNum(match[3]);
                if (validPrice(ct)) {
                    rows.push({ quarter, year, ct: round(ct, 3), matched: match[0] });
                }
            }
        }

        if (!rows.length) return null;

        const unique = [];
        const seen = new Set();
        for (const row of rows) {
            const key = `${row.year}-Q${row.quarter}-${row.ct}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(row);
            }
        }

        const now = new Date();
        const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
        const currentYear = now.getFullYear();
        const currentKey = currentYear * 4 + currentQuarter;

        let selected = unique.find(r => r.year === currentYear && r.quarter === currentQuarter);
        if (!selected) {
            selected = unique
                .filter(r => (r.year * 4 + r.quarter) <= currentKey)
                .sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter))[0];
        }
        if (!selected) {
            selected = unique.slice().sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter))[0];
        }

        return {
            ct: selected.ct,
            eur: round(selected.ct / 100, 5),
            quarter: selected.quarter,
            year: selected.year,
            source: selected.year === currentYear && selected.quarter === currentQuarter
                ? "Webseite aktuelles Quartal"
                : "Webseite neuester verfügbarer Quartalspreis",
            matched: selected.matched,
            foundPrices: unique.length
        };
    }

    async function getEnergyPrice() {
        const fetched = await fetchPage(CFG.energyUrl, timeoutMs);
        const parsed = parseEnergy(fetched.text);

        if (parsed) return { ...parsed, fallback: false, page: fetched.page };
        if (!CFG.allowFallback) throw new Error("TIWAG-Preis konnte auf der Webseite nicht gefunden werden");
        return { ct: round(CFG.energyFallbackCt, 3), source: "Fallback", fallback: true, error: "Preis nicht gefunden", page: fetched.page };
    }

    async function getGridPrice() {
        const fetched = await fetchPage(CFG.gridUrl, timeoutMs);
        const parsed = parseGrid(fetched.text);

        if (parsed) return { ...parsed, fallback: false, page: fetched.page };
        if (!CFG.allowFallback) throw new Error("TINETZ-Preis konnte auf der Webseite nicht gefunden werden");
        return { ct: round(CFG.gridFallbackCt, 3), source: "Fallback", fallback: true, error: "Preis nicht gefunden", page: fetched.page };
    }

    async function getFeedInPrice() {
        if (!CFG.feedInEnabled) {
            return { enabled: false, ct: null, eur: null, source: "deaktiviert", fallback: false, quarter: null, year: null, foundPrices: 0, page: null };
        }

        const fetched = await fetchPage(CFG.feedInUrl, timeoutMs);
        const parsed = parseFeedIn(fetched.text);

        if (parsed) return { enabled: true, ...parsed, fallback: false, page: fetched.page };
        if (!CFG.allowFallback) throw new Error("TIWAG-Einspeisepreis konnte auf der Webseite nicht gefunden werden");
        return {
            enabled: true,
            ct: round(CFG.feedInFallbackCt, 3),
            eur: round(CFG.feedInFallbackCt / 100, 5),
            source: "Fallback",
            fallback: true,
            quarter: null,
            year: null,
            matched: null,
            foundPrices: 0,
            error: "Preis nicht gefunden",
            page: fetched.page
        };
    }

    node.status({ fill: "blue", shape: "ring", text: "Preise werden geladen" });

    const [energy, grid, feedIn] = await Promise.all([
        getEnergyPrice(),
        getGridPrice(),
        getFeedInPrice()
    ]);

    const energyCt = round(energy.ct, 3);
    const gridCt = round(grid.ct, 3);
    const extraCt = round(CFG.extraCtPerKwh, 3);
    const totalCt = round(energyCt + gridCt + extraCt, 3);
    const eur = round(totalCt / 100, 5);

    const feedInCt = feedIn.enabled && Number.isFinite(feedIn.ct) ? round(feedIn.ct, 3) : null;
    const feedInEur = feedInCt !== null ? round(feedInCt / 100, 5) : null;
    const selfUseAdvantageCt = feedInCt !== null ? round(totalCt - feedInCt, 3) : null;
    const selfUseAdvantageEur = selfUseAdvantageCt !== null ? round(selfUseAdvantageCt / 100, 5) : null;

    const updated = new Date().toISOString();
    const anyFallback = Boolean(energy.fallback || grid.fallback || (feedIn.enabled && feedIn.fallback));

    flow.set("tiwag_energy_ct_kwh_gross", energyCt);
    flow.set("tinetz_net_ct_kwh", gridCt);
    flow.set("strompreis_ct_kwh", totalCt);
    flow.set("strompreis_eur_kwh", eur);
    flow.set("strompreis_last_update", updated);
    flow.set("pv_einspeisung_ct_kwh", feedInCt);
    flow.set("pv_einspeisung_eur_kwh", feedInEur);
    flow.set("pv_eigenverbrauch_mehrwert_ct_kwh", selfUseAdvantageCt);
    flow.set("pv_eigenverbrauch_mehrwert_eur_kwh", selfUseAdvantageEur);

    global.set("strompreis_tiwag_energy_ct_kwh_gross", energyCt);
    global.set("strompreis_tinetz_net_ct_kwh", gridCt);
    global.set("strompreis_ct_kwh", totalCt);
    global.set("strompreis_eur_kwh", eur);
    global.set("strompreis_last_update", updated);
    global.set("pv_einspeisung_ct_kwh", feedInCt);
    global.set("pv_einspeisung_eur_kwh", feedInEur);
    global.set("pv_eigenverbrauch_mehrwert_ct_kwh", selfUseAdvantageCt);
    global.set("pv_eigenverbrauch_mehrwert_eur_kwh", selfUseAdvantageEur);

    const details = {
        energyCt,
        gridCt,
        extraCt,
        totalCt,
        eur,
        feedInCt,
        feedInEur,
        selfUseAdvantageCt,
        selfUseAdvantageEur,
        updated,
        fallbackActive: anyFallback,
        energy: {
            url: CFG.energyUrl,
            valueCt: energyCt,
            source: energy.source,
            fallback: energy.fallback,
            netCt: energy.netCt !== undefined ? energy.netCt : null,
            matched: energy.matched || null,
            error: energy.error || null,
            page: energy.page || null
        },
        grid: {
            url: CFG.gridUrl,
            valueCt: gridCt,
            source: grid.source,
            fallback: grid.fallback,
            matched: grid.matched || null,
            error: grid.error || null,
            page: grid.page || null
        },
        feedIn: {
            enabled: feedIn.enabled,
            url: CFG.feedInUrl,
            valueCt: feedInCt,
            valueEur: feedInEur,
            quarter: feedIn.quarter ?? null,
            year: feedIn.year ?? null,
            source: feedIn.source,
            fallback: feedIn.fallback,
            matched: feedIn.matched || null,
            foundPrices: feedIn.foundPrices || 0,
            error: feedIn.error || null,
            page: feedIn.page || null
        }
    };

    const methods = [
        energy.page && energy.page.fetchMethod,
        grid.page && grid.page.fetchMethod,
        feedIn.page && feedIn.page.fetchMethod
    ].filter(Boolean);
    const readerUsed = methods.includes("jina-reader");

    node.status({
        fill: anyFallback ? "yellow" : "green",
        shape: anyFallback ? "ring" : "dot",
        text: `${totalCt} ct/kWh · PV ${feedInCt !== null ? feedInCt + " ct" : "aus"}${readerUsed ? " · Reader" : ""}${anyFallback ? " · Fallback" : ""}`
    });

    const msg1 = { ...msg, topic: CFG.topicEur, payload: eur };
    const msg2 = { ...msg, topic: CFG.topicCt, payload: totalCt };
    const msg3 = { ...msg, topic: CFG.topicFeedInCt, payload: feedInCt };
    const msg4 = { topic: "strompreis-details", payload: details };

    return [msg1, msg2, msg3, msg4];
};
