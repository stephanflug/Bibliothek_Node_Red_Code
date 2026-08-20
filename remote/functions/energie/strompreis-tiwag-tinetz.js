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

    function decodeHtmlEntities(text) {
        return String(text || "")
            .replace(/&nbsp;|&#160;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&#(\d+);/g, (m, code) => {
                const c = Number(code);
                return Number.isFinite(c) ? String.fromCodePoint(c) : m;
            })
            .replace(/&#x([0-9a-f]+);/gi, (m, code) => {
                const c = parseInt(code, 16);
                return Number.isFinite(c) ? String.fromCodePoint(c) : m;
            });
    }

    function htmlToText(html) {
        return decodeHtmlEntities(html)
            .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
            .replace(/<!--[\s\S]*?-->/g, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/[\u00A0\u202F\u2007]/g, " ")
            .replace(/[\u200B\u00AD]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function compileRegex(pattern, name, flags = "i") {
        try {
            return new RegExp(String(pattern || ""), flags);
        } catch (err) {
            throw new Error(`${name}: ungültiger regulärer Ausdruck: ${err.message}`);
        }
    }

    function isHtmlPayload(value) {
        if (Buffer.isBuffer(value)) value = value.toString("utf8");
        if (typeof value !== "string") return false;
        const s = value.trim();
        if (s.length < 100) return false;
        return /<html\b|<!doctype\s+html|<body\b|<main\b|<div\b/i.test(s) || /Cent\s*\/?\s*kWh|ct\s*\/?\s*kWh/i.test(s);
    }

    function requestText(url, timeoutMs, redirects = 0) {
        return new Promise((resolve, reject) => {
            if (redirects > 5) return reject(new Error("Zu viele HTTP-Weiterleitungen"));
            let parsed;
            try { parsed = new URL(url); } catch (_) { return reject(new Error(`Ungültige URL: ${url}`)); }
            if (!/^https?:$/.test(parsed.protocol)) return reject(new Error(`Nur HTTP/HTTPS wird unterstützt: ${url}`));
            const client = parsed.protocol === "https:" ? https : http;
            const req = client.get(parsed, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Node-RED EBST Strompreis)",
                    "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
                    "Accept-Language": "de-AT,de;q=0.9,en;q=0.5",
                    "Cache-Control": "no-cache"
                },
                timeout: timeoutMs
            }, res => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    const next = new URL(res.headers.location, parsed).toString();
                    requestText(next, timeoutMs, redirects + 1).then(resolve, reject);
                    return;
                }
                if (status < 200 || status >= 300) {
                    res.resume();
                    return reject(new Error(`HTTP ${status} bei ${url}`));
                }
                res.setEncoding("utf8");
                let body = "";
                res.on("data", chunk => {
                    body += chunk;
                    if (body.length > 6 * 1024 * 1024) req.destroy(new Error("Antwort ist größer als 6 MB"));
                });
                res.on("end", () => resolve({ body, status, finalUrl: parsed.toString(), contentType: String(res.headers["content-type"] || "") }));
            });
            req.on("timeout", () => req.destroy(new Error("HTTP Timeout")));
            req.on("error", reject);
        });
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
        gridRegex: String(config.gridRegex || "Tirol[^.]{0,220}?(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),
        feedInRegex: String(config.feedInRegex || "Q([1-4])\\s*(\\d{4})[^\\d]{0,180}?(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),
        allowFallback: b(config.allowFallback, true),
        timeoutSec: Math.max(3, Math.min(60, n(config.timeoutSec, 15))),
        topicEur: String(config.topicEur || "0_userdata.0.PV.Ersparnis.Strompreis_EUR_kWh"),
        topicCt: String(config.topicCt || "0_userdata.0.PV.Ersparnis.Strompreis_ct_kWh"),
        topicFeedInCt: String(config.topicFeedInCt || "0_userdata.0.PV.Einspeisung.Strompreis_ct_kWh")
    };

    const energyGrossRe = compileRegex(CFG.energyGrossRegex, "TIWAG Brutto-RegEx");
    const energyNetRe = compileRegex(CFG.energyNetRegex, "TIWAG Netto-RegEx");
    const gridConfiguredRe = compileRegex(CFG.gridRegex, "TINETZ RegEx");

    function parseEnergy(text) {
        let m = energyGrossRe.exec(text);
        if (!m) m = /(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh\s*inkl\.?\s*USt/i.exec(text);
        if (m) {
            const ct = toNum(m[1]);
            if (ct > 0 && ct <= 100) return { ct: round(ct, 3), source: "Node-RED HTTP · Webseite brutto", fallback: false, matched: m[0] };
        }
        m = energyNetRe.exec(text);
        if (!m) m = /(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh\s*exkl\.?\s*USt/i.exec(text);
        if (m) {
            const netCt = toNum(m[1]);
            if (netCt > 0 && netCt <= 100) return { ct: round(netCt * (1 + CFG.vatPercent / 100), 3), netCt: round(netCt, 3), source: `Node-RED HTTP · Webseite netto + ${CFG.vatPercent}% USt`, fallback: false, matched: m[0] };
        }
        return null;
    }

    function parseGrid(text) {
        const patterns = [
            gridConfiguredRe,
            /Tirol[^.]{0,160}?(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh/i,
            /Netzentgelt\w*[^.]{0,220}?(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh/i,
            /in\s+Tirol[^.]{0,260}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i
        ];
        for (const re of patterns) {
            const m = re.exec(text);
            if (!m) continue;
            const ct = toNum(m[1]);
            if (ct > 0 && ct <= 100) return { ct: round(ct, 3), source: "Node-RED HTTP · Webseite", fallback: false, matched: m[0] };
        }
        return null;
    }

    function parseFeedIn(text) {
        const rows = [];
        const patterns = [
            compileRegex(CFG.feedInRegex, "PV-Einspeisung RegEx", "gi"),
            /Q\s*([1-4])\s*(?:\/|[-–—:]|\s)*\s*(\d{4})[^\d]{0,220}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/gi,
            /([1-4])\.\s*Quartal\s*(\d{4})[^\d]{0,220}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/gi
        ];
        for (const re of patterns) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text)) !== null) {
                const quarter = Number(m[1]);
                const year = Number(m[2]);
                const ct = toNum(m[3]);
                if (quarter >= 1 && quarter <= 4 && year >= 2000 && year <= 2200 && ct > 0 && ct <= 100) {
                    rows.push({ quarter, year, ct: round(ct, 3), matched: m[0] });
                }
                if (m[0] === "") re.lastIndex++;
            }
            if (rows.length) break;
        }
        if (!rows.length) return null;
        const now = new Date();
        const cq = Math.floor(now.getMonth() / 3) + 1;
        const cy = now.getFullYear();
        const ckey = cy * 4 + cq;
        let selected = rows.find(r => r.year === cy && r.quarter === cq);
        if (!selected) {
            selected = rows.filter(r => r.year * 4 + r.quarter <= ckey)
                .sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter))[0];
        }
        if (!selected) selected = rows.sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter))[0];
        return {
            enabled: true,
            ct: selected.ct,
            eur: round(selected.ct / 100, 5),
            quarter: selected.quarter,
            year: selected.year,
            source: selected.year === cy && selected.quarter === cq ? "Node-RED HTTP · aktuelles Quartal" : "Node-RED HTTP · neuester verfügbarer Quartalspreis",
            fallback: false,
            matched: selected.matched,
            foundPrices: rows.length
        };
    }

    function explicitSource(topic) {
        const t = String(topic || "").toLowerCase();
        if (/feed|einspeis|pv/.test(t)) return "feedIn";
        if (/grid|netz|tinetz/.test(t)) return "grid";
        if (/energy|energie|tiwag/.test(t)) return "energy";
        return null;
    }

    function detectAndParse(text, topic) {
        const forced = explicitSource(topic);
        if (forced === "feedIn") return { source: "feedIn", value: parseFeedIn(text) };
        if (forced === "grid") return { source: "grid", value: parseGrid(text) };
        if (forced === "energy") return { source: "energy", value: parseEnergy(text) };

        if (/Q\s*[1-4]|Quartal/i.test(text) && /PV|Einspeis|Abnahme|Photovoltaik/i.test(text)) {
            const v = parseFeedIn(text); if (v) return { source: "feedIn", value: v };
        }
        if (/TINETZ|Netzentgelt|Netztarif|Netznutzung/i.test(text)) {
            const v = parseGrid(text); if (v) return { source: "grid", value: v };
        }
        if (/TIWAG|Arbeitspreis|inkl\.?\s*USt|exkl\.?\s*USt/i.test(text)) {
            const v = parseEnergy(text); if (v) return { source: "energy", value: v };
        }

        const feed = parseFeedIn(text); if (feed) return { source: "feedIn", value: feed };
        const grid = parseGrid(text); if (grid) return { source: "grid", value: grid };
        const energy = parseEnergy(text); if (energy) return { source: "energy", value: energy };
        return { source: null, value: null };
    }

    const CACHE_KEY = "ebst_strompreis_html_cache";
    const cache = flow.get(CACHE_KEY) || {};
    const incomingHtml = isHtmlPayload(msg.payload);

    if (incomingHtml) {
        const raw = Buffer.isBuffer(msg.payload) ? msg.payload.toString("utf8") : String(msg.payload);
        const text = htmlToText(raw);
        const parsed = detectAndParse(text, msg.topic);
        if (!parsed.source || !parsed.value) {
            node.status({ fill: "yellow", shape: "ring", text: "HTML empfangen · Preis nicht erkannt" });
            const diagnostic = {
                mode: "incoming-html",
                parserOk: false,
                topic: msg.topic || null,
                bytes: Buffer.byteLength(raw, "utf8"),
                preview: text.slice(0, 400),
                cache: Object.keys(cache)
            };
            return [null, null, null, { topic: "strompreis-details", payload: diagnostic }];
        }
        parsed.value.receivedAt = new Date().toISOString();
        parsed.value.inputMode = "node-red-http";
        cache[parsed.source] = parsed.value;
        flow.set(CACHE_KEY, cache);
    }

    if (!incomingHtml && !cache.energy && !cache.grid) {
        const timeoutMs = CFG.timeoutSec * 1000;
        async function fetchAndParse(url, source) {
            try {
                const page = await requestText(url, timeoutMs);
                const text = htmlToText(page.body);
                const value = source === "energy" ? parseEnergy(text) : source === "grid" ? parseGrid(text) : parseFeedIn(text);
                if (value) {
                    value.inputMode = "internal-http";
                    value.receivedAt = new Date().toISOString();
                    value.page = { httpStatus: page.status, finalUrl: page.finalUrl, contentType: page.contentType, bytes: Buffer.byteLength(page.body, "utf8") };
                    return value;
                }
                return null;
            } catch (_) { return null; }
        }
        const [energy, grid, feed] = await Promise.all([
            fetchAndParse(CFG.energyUrl, "energy"),
            fetchAndParse(CFG.gridUrl, "grid"),
            CFG.feedInEnabled ? fetchAndParse(CFG.feedInUrl, "feedIn") : Promise.resolve(null)
        ]);
        if (energy) cache.energy = energy;
        if (grid) cache.grid = grid;
        if (feed) cache.feedIn = feed;
        flow.set(CACHE_KEY, cache);
    }

    const missing = [];
    if (!cache.energy) missing.push("TIWAG Energie");
    if (!cache.grid) missing.push("TINETZ Netz");
    if (CFG.feedInEnabled && !cache.feedIn) missing.push("PV Einspeisung");

    if (incomingHtml && missing.length) {
        node.status({ fill: "blue", shape: "ring", text: `warte auf: ${missing.join(", ")}` });
        return [null, null, null, {
            topic: "strompreis-details",
            payload: {
                mode: "incoming-html",
                waitingFor: missing,
                received: Object.keys(cache),
                lastSource: explicitSource(msg.topic) || null
            }
        }];
    }

    function fallback(source) {
        if (source === "energy") return { ct: round(CFG.energyFallbackCt, 3), source: "Fallback", fallback: true, error: "Kein gültiger TIWAG-Wert im Cache" };
        if (source === "grid") return { ct: round(CFG.gridFallbackCt, 3), source: "Fallback", fallback: true, error: "Kein gültiger TINETZ-Wert im Cache" };
        return { enabled: true, ct: round(CFG.feedInFallbackCt, 3), eur: round(CFG.feedInFallbackCt / 100, 5), quarter: null, year: null, source: "Fallback", fallback: true, error: "Kein gültiger PV-Wert im Cache", foundPrices: 0 };
    }

    if (!CFG.allowFallback && missing.length) {
        throw new Error(`Strompreis: Daten fehlen: ${missing.join(", ")}`);
    }

    const energy = cache.energy || fallback("energy");
    const grid = cache.grid || fallback("grid");
    const feedIn = CFG.feedInEnabled ? (cache.feedIn || fallback("feedIn")) : { enabled: false, ct: null, eur: null, quarter: null, year: null, source: "deaktiviert", fallback: false };

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
        inputMode: incomingHtml ? "node-red-http" : "cache/internal-http",
        energy: { ...energy, url: CFG.energyUrl, valueCt: energyCt },
        grid: { ...grid, url: CFG.gridUrl, valueCt: gridCt },
        feedIn: { ...feedIn, url: CFG.feedInUrl, valueCt: feedInCt, valueEur: feedInEur },
        cache: {
            energyReceivedAt: cache.energy && cache.energy.receivedAt || null,
            gridReceivedAt: cache.grid && cache.grid.receivedAt || null,
            feedInReceivedAt: cache.feedIn && cache.feedIn.receivedAt || null
        }
    };

    node.status({
        fill: anyFallback ? "yellow" : "green",
        shape: anyFallback ? "ring" : "dot",
        text: `${totalCt} ct/kWh · PV ${feedInCt !== null ? feedInCt + " ct" : "aus"}${anyFallback ? " · Fallback" : ""}`
    });

    return [
        { ...msg, topic: CFG.topicEur, payload: eur },
        { ...msg, topic: CFG.topicCt, payload: totalCt },
        { ...msg, topic: CFG.topicFeedInCt, payload: feedInCt },
        { topic: "strompreis-details", payload: details }
    ];
};
