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
            .replace(/&#(\d+);/g, (all, code) => {
                const number = Number(code);
                return Number.isFinite(number) ? String.fromCodePoint(number) : all;
            })
            .replace(/&#x([0-9a-f]+);/gi, (all, code) => {
                const number = parseInt(code, 16);
                return Number.isFinite(number) ? String.fromCodePoint(number) : all;
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

    function compileRegex(pattern, name, flags = "i") {
        try {
            return new RegExp(String(pattern || ""), flags);
        } catch (err) {
            throw new Error(`${name}: ungültiger regulärer Ausdruck: ${err.message}`);
        }
    }

    function browserHeaders() {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
            "Accept-Language": "de-AT,de;q=0.9,en;q=0.5",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Accept-Encoding": "identity"
        };
    }

    async function fetchTextWithGlobalFetch(url, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                method: "GET",
                headers: browserHeaders(),
                redirect: "follow",
                signal: controller.signal,
                cache: "no-store"
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} bei ${url}`);
            }
            const body = await response.text();
            if (body.length > 4 * 1024 * 1024) {
                throw new Error("Webseite ist größer als 4 MB");
            }
            return {
                body,
                status: response.status,
                finalUrl: response.url || url,
                contentType: response.headers.get("content-type") || "",
                method: "fetch"
            };
        } finally {
            clearTimeout(timer);
        }
    }

    function fetchTextNative(url, timeoutMs, redirects = 0) {
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
                headers: browserHeaders(),
                timeout: timeoutMs
            }, res => {
                const status = res.statusCode || 0;

                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    const next = new URL(res.headers.location, parsed).toString();
                    fetchTextNative(next, timeoutMs, redirects + 1).then(resolve, reject);
                    return;
                }

                if (status !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${status} bei ${url}`));
                    return;
                }

                res.setEncoding("utf8");
                let body = "";
                res.on("data", chunk => {
                    body += chunk;
                    if (body.length > 4 * 1024 * 1024) {
                        req.destroy(new Error("Webseite ist größer als 4 MB"));
                    }
                });
                res.on("end", () => resolve({
                    body,
                    status,
                    finalUrl: parsed.toString(),
                    contentType: String(res.headers["content-type"] || ""),
                    method: "https"
                }));
            });

            req.on("timeout", () => req.destroy(new Error("HTTP Timeout")));
            req.on("error", reject);
        });
    }

    async function fetchPage(url, timeoutMs) {
        if (typeof fetch === "function" && typeof AbortController === "function") {
            try {
                return await fetchTextWithGlobalFetch(url, timeoutMs);
            } catch (err) {
                try {
                    const native = await fetchTextNative(url, timeoutMs);
                    native.firstFetchError = err.message;
                    return native;
                } catch (_) {
                    throw err;
                }
            }
        }
        return await fetchTextNative(url, timeoutMs);
    }

    function pageDiagnostics(page, text) {
        const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page && page.body ? page.body : "");
        return {
            httpStatus: page ? page.status : null,
            finalUrl: page ? page.finalUrl : null,
            contentType: page ? page.contentType : null,
            fetchMethod: page ? page.method : null,
            bytes: page && page.body ? Buffer.byteLength(page.body, "utf8") : 0,
            title: titleMatch ? normalizeText(htmlToText(titleMatch[1])) : null,
            preview: normalizeText(text).slice(0, 350) || null,
            firstFetchError: page && page.firstFetchError ? page.firstFetchError : null
        };
    }

    function execConfigured(pattern, text, groupIndex = 1, flags = "i") {
        if (!pattern) return null;
        const re = compileRegex(pattern, "Konfiguriertes RegEx", flags);
        const m = re.exec(text);
        if (!m || m[groupIndex] === undefined) return null;
        const value = toNum(m[groupIndex]);
        if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
        return { value, matched: m[0] };
    }

    function findUnitPrices(text) {
        const out = [];
        const re = /(\d{1,3}(?:[,.]\d{1,4})?)\s*(?:cent|ct)\s*(?:(?:\/\s*)?kwh|pro\s+kilowattstunde)/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
            const value = toNum(m[1]);
            if (Number.isFinite(value) && value > 0 && value <= 100) {
                out.push({ value, index: m.index, matched: m[0] });
            }
            if (m[0] === "") re.lastIndex++;
        }
        return out;
    }

    function nearestPriceQualifier(text, candidate) {
        const tail = text.slice(candidate.index + candidate.matched.length, candidate.index + candidate.matched.length + 100).toLowerCase();
        const head = text.slice(Math.max(0, candidate.index - 80), candidate.index).toLowerCase();

        const labels = [
            { type: "gross", pos: tail.indexOf("inkl") },
            { type: "gross", pos: tail.indexOf("brutto") },
            { type: "net", pos: tail.indexOf("exkl") },
            { type: "net", pos: tail.indexOf("netto") }
        ].filter(x => x.pos >= 0).sort((a, b) => a.pos - b.pos);

        if (labels.length && labels[0].pos <= 55) return labels[0].type;
        if (/\bbrutto\b|\binkl\b/.test(head.slice(-45))) return "gross";
        if (/\bnetto\b|\bexkl\b/.test(head.slice(-45))) return "net";
        return "unknown";
    }

    function parseEnergyPrice(text, cfg) {
        let match = execConfigured(cfg.energyGrossRegex, text);
        if (match) return { ct: round(match.value, 3), source: "Webseite brutto · konfiguriertes RegEx", matched: match.matched };

        match = execConfigured(cfg.energyNetRegex, text);
        if (match) {
            return {
                ct: round(match.value * (1 + cfg.vatPercent / 100), 3),
                netCt: round(match.value, 3),
                source: `Webseite netto · konfiguriertes RegEx + ${cfg.vatPercent}% USt`,
                matched: match.matched
            };
        }

        const candidates = findUnitPrices(text);
        const classified = candidates.map(c => ({ ...c, qualifier: nearestPriceQualifier(text, c) }));

        let selected = classified.find(c => c.qualifier === "gross");
        if (selected) return { ct: round(selected.value, 3), source: "Webseite brutto · flexible Erkennung", matched: selected.matched };

        selected = classified.find(c => c.qualifier === "net");
        if (selected) {
            return {
                ct: round(selected.value * (1 + cfg.vatPercent / 100), 3),
                netCt: round(selected.value, 3),
                source: `Webseite netto · flexible Erkennung + ${cfg.vatPercent}% USt`,
                matched: selected.matched
            };
        }

        const workIndex = text.toLowerCase().indexOf("arbeitspreis");
        if (workIndex >= 0) {
            const block = text.slice(workIndex, workIndex + 900);
            const local = findUnitPrices(block);
            if (local.length) {
                const maxCandidate = local.slice().sort((a, b) => b.value - a.value)[0];
                return { ct: round(maxCandidate.value, 3), source: "Webseite · Arbeitspreis-Block", matched: maxCandidate.matched };
            }
        }
        return null;
    }

    function parseGridPrice(text, cfg) {
        let match = execConfigured(cfg.gridRegex, text);
        if (match) return { ct: round(match.value, 3), source: "Webseite · konfiguriertes RegEx", matched: match.matched };

        const tirolRe = /(?:zahlen\s+(?:sie\s+)?in\s+tirol|in\s+tirol)[^0-9]{0,120}?(\d{1,3}(?:[,.]\d{1,4})?)\s*(?:cent|ct)\s*(?:(?:\/\s*)?kwh|pro\s+kilowattstunde)/i;
        const m = tirolRe.exec(text);
        if (m) {
            const value = toNum(m[1]);
            if (Number.isFinite(value) && value > 0 && value <= 100) {
                return { ct: round(value, 3), source: "Webseite · Tirol-Text flexible Erkennung", matched: m[0] };
            }
        }

        const candidates = findUnitPrices(text);
        let best = null;
        for (const c of candidates) {
            const before = text.slice(Math.max(0, c.index - 180), c.index).toLowerCase();
            const after = text.slice(c.index, c.index + 100).toLowerCase();
            let score = 0;
            if (/in\s+tirol|tirol/.test(before)) score += 8;
            if (/zahlen\s+(?:sie\s+)?in\s+tirol|lediglich/.test(before)) score += 20;
            if (/netzentgelt|netztarif|netzkosten/.test(before + " " + after)) score += 8;
            if (/österreichische[rn]?\s+durchschnitt|bundesschnitt/.test(before)) score -= 6;
            if (!best || score > best.score) best = { ...c, score };
        }

        if (best && best.score >= 8) return { ct: round(best.value, 3), source: "Webseite · Kontext-Erkennung", matched: best.matched };
        return null;
    }

    function parseFeedInPrices(text, cfg) {
        const rows = [];

        if (cfg.feedInRegex) {
            try {
                const re = compileRegex(cfg.feedInRegex, "PV-Einspeisung RegEx", "gi");
                let m;
                while ((m = re.exec(text)) !== null) {
                    const quarter = Number(m[1]);
                    const year = Number(m[2]);
                    const ct = toNum(m[3]);
                    if (Number.isInteger(quarter) && quarter >= 1 && quarter <= 4 && Number.isInteger(year) && year >= 2000 && year <= 2200 && Number.isFinite(ct) && ct > 0 && ct <= 100) {
                        rows.push({ quarter, year, ct: round(ct, 3), matched: m[0], method: "konfiguriertes RegEx" });
                    }
                    if (m[0] === "") re.lastIndex++;
                }
            } catch (_) {}
        }

        const qRe = /Q\s*([1-4])\s*(20\d{2})/gi;
        let qm;
        while ((qm = qRe.exec(text)) !== null) {
            const quarter = Number(qm[1]);
            const year = Number(qm[2]);
            const block = text.slice(qm.index, qm.index + 180);
            const prices = findUnitPrices(block);
            if (prices.length) {
                rows.push({ quarter, year, ct: round(prices[0].value, 3), matched: `${qm[0]} ... ${prices[0].matched}`, method: "flexible Quartalserkennung" });
            }
            if (qm[0] === "") qRe.lastIndex++;
        }

        const unique = new Map();
        for (const row of rows) {
            const key = `${row.year}-Q${row.quarter}`;
            if (!unique.has(key) || row.method === "konfiguriertes RegEx") unique.set(key, row);
        }
        return Array.from(unique.values());
    }

    function selectFeedInRow(rows) {
        if (!rows.length) return null;
        const now = new Date();
        const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
        const currentYear = now.getFullYear();
        const currentKey = currentYear * 4 + currentQuarter;

        let selected = rows.find(r => r.year === currentYear && r.quarter === currentQuarter);
        if (selected) return { selected, current: true };

        const notFuture = rows.filter(r => (r.year * 4 + r.quarter) <= currentKey).sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter));
        selected = notFuture[0] || rows.slice().sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter))[0];
        return { selected, current: false };
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
        energyGrossRegex: String(config.energyGrossRegex || "(\\d{1,3}[,.]\\d{1,4})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh\\s*inkl\\.?\\s*USt"),
        energyNetRegex: String(config.energyNetRegex || "(\\d{1,3}[,.]\\d{1,4})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh\\s*exkl\\.?\\s*USt"),
        gridRegex: String(config.gridRegex || "in\\s+Tirol[^.]{0,250}?lediglich\\s*(\\d{1,3}[,.]\\d{1,4})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),
        feedInRegex: String(config.feedInRegex || "Q([1-4])\\s*(\\d{4})[^\\d]{0,100}?(\\d{1,3}[,.]\\d{1,4})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),
        allowFallback: b(config.allowFallback, true),
        timeoutSec: Math.max(3, Math.min(60, n(config.timeoutSec, 15))),
        topicEur: String(config.topicEur || "0_userdata.0.PV.Ersparnis.Strompreis_EUR_kWh"),
        topicCt: String(config.topicCt || "0_userdata.0.PV.Ersparnis.Strompreis_ct_kWh"),
        topicFeedInCt: String(config.topicFeedInCt || "0_userdata.0.PV.Einspeisung.Strompreis_ct_kWh")
    };

    if (!CFG.energyUrl || !CFG.gridUrl) throw new Error("Strompreis: Energie-URL und Netz-URL müssen gesetzt sein");
    if (CFG.feedInEnabled && !CFG.feedInUrl) throw new Error("Strompreis: Einspeise-URL muss gesetzt sein");

    const timeoutMs = CFG.timeoutSec * 1000;

    async function loadAndParse(label, url, parser, fallbackCt) {
        let page = null;
        let text = "";
        let fetchError = null;
        let parsed = null;

        try {
            page = await fetchPage(url, timeoutMs);
            text = htmlToText(page.body);
            parsed = parser(text);
        } catch (err) {
            fetchError = err;
        }

        if (parsed && Number.isFinite(parsed.ct) && parsed.ct > 0 && parsed.ct <= 100) {
            return {
                ct: round(parsed.ct, 3),
                netCt: parsed.netCt !== undefined ? parsed.netCt : null,
                source: parsed.source,
                fallback: false,
                matched: parsed.matched || null,
                error: null,
                page: pageDiagnostics(page, text)
            };
        }

        if (!CFG.allowFallback) {
            throw new Error(fetchError ? `${label} konnte nicht geladen werden: ${fetchError.message}` : `${label}: Preis konnte auf der Webseite nicht gefunden werden`);
        }

        return {
            ct: round(fallbackCt, 3),
            netCt: null,
            source: "Fallback",
            fallback: true,
            matched: null,
            error: fetchError ? fetchError.message : "Preis nicht gefunden",
            page: pageDiagnostics(page, text)
        };
    }

    async function getFeedInPrice() {
        if (!CFG.feedInEnabled) {
            return { enabled: false, ct: null, eur: null, source: "deaktiviert", fallback: false, quarter: null, year: null, matched: null, foundPrices: 0, error: null, page: null };
        }

        let page = null;
        let text = "";
        let fetchError = null;
        let rows = [];

        try {
            page = await fetchPage(CFG.feedInUrl, timeoutMs);
            text = htmlToText(page.body);
            rows = parseFeedInPrices(text, CFG);
        } catch (err) {
            fetchError = err;
        }

        const selection = selectFeedInRow(rows);
        if (selection) {
            const selected = selection.selected;
            return {
                enabled: true,
                ct: selected.ct,
                eur: round(selected.ct / 100, 5),
                source: selection.current ? `Webseite aktuelles Quartal · ${selected.method}` : `Webseite neuester verfügbarer Quartalspreis · ${selected.method}`,
                fallback: false,
                quarter: selected.quarter,
                year: selected.year,
                matched: selected.matched || null,
                foundPrices: rows.length,
                error: null,
                page: pageDiagnostics(page, text)
            };
        }

        if (!CFG.allowFallback) {
            throw new Error(fetchError ? `TIWAG Einspeisung konnte nicht geladen werden: ${fetchError.message}` : "TIWAG-Einspeisepreis konnte auf der Webseite nicht gefunden werden");
        }

        return {
            enabled: true,
            ct: round(CFG.feedInFallbackCt, 3),
            eur: round(CFG.feedInFallbackCt / 100, 5),
            source: "Fallback",
            fallback: true,
            quarter: null,
            year: null,
            matched: null,
            foundPrices: rows.length,
            error: fetchError ? fetchError.message : "Preis nicht gefunden",
            page: pageDiagnostics(page, text)
        };
    }

    node.status({ fill: "blue", shape: "ring", text: "Preise werden geladen" });

    const [energy, grid, feedIn] = await Promise.all([
        loadAndParse("TIWAG", CFG.energyUrl, text => parseEnergyPrice(text, CFG), CFG.energyFallbackCt),
        loadAndParse("TINETZ", CFG.gridUrl, text => parseGridPrice(text, CFG), CFG.gridFallbackCt),
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
        energy: { url: CFG.energyUrl, valueCt: energyCt, source: energy.source, fallback: energy.fallback, netCt: energy.netCt, matched: energy.matched, error: energy.error, page: energy.page },
        grid: { url: CFG.gridUrl, valueCt: gridCt, source: grid.source, fallback: grid.fallback, matched: grid.matched, error: grid.error, page: grid.page },
        feedIn: { enabled: feedIn.enabled, url: CFG.feedInUrl, valueCt: feedInCt, valueEur: feedInEur, quarter: feedIn.quarter, year: feedIn.year, source: feedIn.source, fallback: feedIn.fallback, matched: feedIn.matched, foundPrices: feedIn.foundPrices, error: feedIn.error, page: feedIn.page }
    };

    node.status({
        fill: anyFallback ? "yellow" : "green",
        shape: anyFallback ? "ring" : "dot",
        text: `${totalCt} ct/kWh · PV ${feedInCt !== null ? feedInCt + " ct" : "aus"}${anyFallback ? " · Fallback" : ""}`
    });

    const msg1 = { ...msg, topic: CFG.topicEur, payload: eur };
    const msg2 = { ...msg, topic: CFG.topicCt, payload: totalCt };
    const msg3 = { ...msg, topic: CFG.topicFeedInCt, payload: feedInCt };
    const msg4 = { topic: "strompreis-details", payload: details };

    return [msg1, msg2, msg3, msg4];
};
