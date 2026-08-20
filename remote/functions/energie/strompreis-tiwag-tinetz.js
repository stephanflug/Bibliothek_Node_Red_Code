"use strict";

module.exports = async function run(ctx) {
    const { msg, node, flow, global, config, httpRequest } = ctx;

    if (typeof httpRequest !== "function") {
        throw new Error("Strompreis: integrierter HTTP-Client fehlt. EBST Basis V1.4.0 oder neuer installieren.");
    }

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
            .replace(/&#(\d+);/g, (whole, code) => {
                const x = Number(code);
                return Number.isFinite(x) ? String.fromCodePoint(x) : whole;
            })
            .replace(/&#x([0-9a-f]+);/gi, (whole, code) => {
                const x = parseInt(code, 16);
                return Number.isFinite(x) ? String.fromCodePoint(x) : whole;
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
        return m ? htmlToText(m[1]) : null;
    }

    function preview(text) {
        const s = normalizeText(text);
        return s.length > 260 ? s.slice(0, 260) + "…" : s;
    }

    function compileRegex(pattern, name, flags = "i") {
        try {
            return new RegExp(String(pattern || ""), flags);
        } catch (err) {
            throw new Error(`${name}: ungültiger regulärer Ausdruck: ${err.message}`);
        }
    }

    function cookieWall(text, title) {
        const value = `${title || ""} ${text || ""}`.toLowerCase();
        return value.includes("cookie-information") ||
            value.includes("cookie-popup does not work properly without javascript") ||
            value.includes("please enable it to continue");
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
        gridRegex: String(config.gridRegex || "Tirol[^.]{0,160}?(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),
        feedInRegex: String(config.feedInRegex || "Q([1-4])\\s*(\\d{4})[^\\d]{0,120}?(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),

        allowFallback: b(config.allowFallback, true),
        timeoutSec: Math.max(3, Math.min(120, n(config.timeoutSec, 15))),

        topicEur: String(config.topicEur || "0_userdata.0.PV.Ersparnis.Strompreis_EUR_kWh"),
        topicCt: String(config.topicCt || "0_userdata.0.PV.Ersparnis.Strompreis_ct_kWh"),
        topicFeedInCt: String(config.topicFeedInCt || "0_userdata.0.PV.Einspeisung.Strompreis_ct_kWh")
    };

    if (!CFG.energyUrl || !CFG.gridUrl) throw new Error("Strompreis: Energie-URL und Netz-URL müssen gesetzt sein");
    if (CFG.feedInEnabled && !CFG.feedInUrl) throw new Error("Strompreis: Einspeise-URL muss gesetzt sein");

    async function loadPage(url) {
        const response = await httpRequest({
            method: "GET",
            url,
            responseType: "text",
            timeoutMs: CFG.timeoutSec * 1000,
            maxRedirects: 21,
            followRedirects: true,
            decompress: false,
            maxBodyBytes: 6 * 1024 * 1024
        });

        const html = String(response.body || "");
        const text = htmlToText(html);
        const title = titleFromHtml(html);
        const page = {
            httpStatus: response.statusCode,
            finalUrl: response.url || url,
            contentType: String((response.headers && response.headers["content-type"]) || ""),
            fetchMethod: "ebst-http-got",
            bytes: Buffer.byteLength(html, "utf8"),
            title,
            preview: preview(text),
            cookieWallDetected: cookieWall(text, title),
            redirects: Array.isArray(response.redirectList) ? response.redirectList.length : 0
        };

        if (response.statusCode < 200 || response.statusCode >= 300) {
            const err = new Error(`HTTP ${response.statusCode}`);
            err.page = page;
            throw err;
        }

        return { html, text, page };
    }

    function validPrice(ct) {
        return Number.isFinite(ct) && ct > 0 && ct <= 100;
    }

    function findEnergy(text) {
        const patternsGross = [
            { re: compileRegex(CFG.energyGrossRegex, "TIWAG Brutto-RegEx"), source: "Webseite brutto · konfiguriertes RegEx" },
            { re: /(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh\s*inkl\.?\s*USt/i, source: "Webseite brutto · Standarderkennung" },
            { re: /inkl\.?\s*USt[^\d]{0,100}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i, source: "Webseite brutto · flexible Erkennung" }
        ];

        for (const item of patternsGross) {
            const m = item.re.exec(text);
            const ct = m ? toNum(m[1]) : NaN;
            if (validPrice(ct)) return { ct: round(ct, 3), source: item.source, matched: m[0], fallback: false };
        }

        const patternsNet = [
            { re: compileRegex(CFG.energyNetRegex, "TIWAG Netto-RegEx"), source: "Webseite netto · konfiguriertes RegEx" },
            { re: /(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh\s*exkl\.?\s*USt/i, source: "Webseite netto · Standarderkennung" }
        ];

        for (const item of patternsNet) {
            const m = item.re.exec(text);
            const netCt = m ? toNum(m[1]) : NaN;
            if (validPrice(netCt)) {
                return {
                    ct: round(netCt * (1 + CFG.vatPercent / 100), 3),
                    netCt: round(netCt, 3),
                    source: `${item.source} + ${CFG.vatPercent}% USt`,
                    matched: m[0],
                    fallback: false
                };
            }
        }

        return null;
    }

    function findGrid(text) {
        const patterns = [
            { re: compileRegex(CFG.gridRegex, "TINETZ RegEx"), source: "Webseite · konfiguriertes RegEx" },
            { re: /Tirol[^.]{0,160}?(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh/i, source: "Webseite · Tirol-Erkennung" },
            { re: /Netzentgelt\w*[^.]{0,220}?(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh/i, source: "Webseite · Netzentgelt-Erkennung" },
            { re: /(?:Netz|Netzentgelt)[\s\S]{0,220}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/i, source: "Webseite · flexible Erkennung" }
        ];

        for (const item of patterns) {
            const m = item.re.exec(text);
            const ct = m ? toNum(m[1]) : NaN;
            if (validPrice(ct)) return { ct: round(ct, 3), source: item.source, matched: m[0], fallback: false };
        }
        return null;
    }

    function findFeedIn(text) {
        const rows = [];
        const patterns = [
            compileRegex(CFG.feedInRegex, "PV-Einspeisung RegEx", "gi"),
            /Q\s*([1-4])\s*[\/-]?\s*(\d{4})[^\d]{0,160}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/gi,
            /([1-4])\.\s*Quartal\s*(\d{4})[^\d]{0,160}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/gi
        ];

        for (const re of patterns) {
            let m;
            while ((m = re.exec(text)) !== null) {
                const quarter = Number(m[1]);
                const year = Number(m[2]);
                const ct = toNum(m[3]);
                if (quarter >= 1 && quarter <= 4 && year >= 2000 && year <= 2200 && validPrice(ct)) {
                    const key = `${year}-Q${quarter}`;
                    if (!rows.some(r => r.key === key && r.ct === round(ct, 3))) {
                        rows.push({ key, quarter, year, ct: round(ct, 3), matched: m[0] });
                    }
                }
                if (m[0] === "") re.lastIndex++;
            }
        }

        if (!rows.length) return null;

        const now = new Date();
        const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
        const currentYear = now.getFullYear();
        const currentKey = currentYear * 4 + currentQuarter;

        let selected = rows.find(r => r.year === currentYear && r.quarter === currentQuarter);
        let source = "Webseite aktuelles Quartal";

        if (!selected) {
            const notFuture = rows
                .filter(r => r.year * 4 + r.quarter <= currentKey)
                .sort((a, z) => (z.year * 4 + z.quarter) - (a.year * 4 + a.quarter));
            selected = notFuture[0] || rows.slice().sort((a, z) => (z.year * 4 + z.quarter) - (a.year * 4 + a.quarter))[0];
            source = "Webseite neuester verfügbarer Quartalspreis";
        }

        return {
            enabled: true,
            ct: selected.ct,
            eur: round(selected.ct / 100, 5),
            quarter: selected.quarter,
            year: selected.year,
            source,
            matched: selected.matched,
            foundPrices: rows.length,
            fallback: false
        };
    }

    async function energyPrice() {
        let page = null;
        let error = null;
        try {
            const loaded = await loadPage(CFG.energyUrl);
            page = loaded.page;
            const found = findEnergy(loaded.text);
            if (found) return { ...found, page };
            error = page.cookieWallDetected ? "Cookie-Seite statt Tarifseite erhalten" : "Preis nicht gefunden";
        } catch (err) {
            page = err.page || null;
            error = err.message;
        }

        if (!CFG.allowFallback) throw new Error(`TIWAG Energie: ${error}`);
        return { ct: round(CFG.energyFallbackCt, 3), netCt: null, source: "Fallback", fallback: true, matched: null, error, page };
    }

    async function gridPrice() {
        let page = null;
        let error = null;
        try {
            const loaded = await loadPage(CFG.gridUrl);
            page = loaded.page;
            const found = findGrid(loaded.text);
            if (found) return { ...found, page };
            error = page.cookieWallDetected ? "Cookie-Seite statt Tarifseite erhalten" : "Preis nicht gefunden";
        } catch (err) {
            page = err.page || null;
            error = err.message;
        }

        if (!CFG.allowFallback) throw new Error(`TINETZ Netz: ${error}`);
        return { ct: round(CFG.gridFallbackCt, 3), source: "Fallback", fallback: true, matched: null, error, page };
    }

    async function feedInPrice() {
        if (!CFG.feedInEnabled) {
            return { enabled: false, ct: null, eur: null, quarter: null, year: null, source: "deaktiviert", fallback: false, matched: null, foundPrices: 0, error: null, page: null };
        }

        let page = null;
        let error = null;
        try {
            const loaded = await loadPage(CFG.feedInUrl);
            page = loaded.page;
            const found = findFeedIn(loaded.text);
            if (found) return { ...found, page };
            error = page.cookieWallDetected ? "Cookie-Seite statt Einspeiseseite erhalten" : "Preis nicht gefunden";
        } catch (err) {
            page = err.page || null;
            error = err.message;
        }

        if (!CFG.allowFallback) throw new Error(`TIWAG PV-Einspeisung: ${error}`);
        return {
            enabled: true,
            ct: round(CFG.feedInFallbackCt, 3),
            eur: round(CFG.feedInFallbackCt / 100, 5),
            quarter: null,
            year: null,
            source: "Fallback",
            fallback: true,
            matched: null,
            foundPrices: 0,
            error,
            page
        };
    }

    node.status({ fill: "blue", shape: "ring", text: "Strompreise werden geladen" });

    const [energy, grid, feedIn] = await Promise.all([
        energyPrice(),
        gridPrice(),
        feedInPrice()
    ]);

    const energyCt = round(energy.ct, 3);
    const gridCt = round(grid.ct, 3);
    const extraCt = round(CFG.extraCtPerKwh, 3);
    const totalCt = round(energyCt + gridCt + extraCt, 3);
    const eur = round(totalCt / 100, 5);
    const feedInCt = feedIn.enabled && validPrice(feedIn.ct) ? round(feedIn.ct, 3) : null;
    const feedInEur = feedInCt !== null ? round(feedInCt / 100, 5) : null;
    const selfUseAdvantageCt = feedInCt !== null ? round(totalCt - feedInCt, 3) : null;
    const selfUseAdvantageEur = selfUseAdvantageCt !== null ? round(selfUseAdvantageCt / 100, 5) : null;
    const updated = new Date().toISOString();
    const fallbackActive = Boolean(energy.fallback || grid.fallback || (feedIn.enabled && feedIn.fallback));

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
        fallbackActive,
        inputMode: "ebst-http-v1.4",
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
            quarter: feedIn.quarter,
            year: feedIn.year,
            source: feedIn.source,
            fallback: feedIn.fallback,
            matched: feedIn.matched || null,
            foundPrices: feedIn.foundPrices || 0,
            error: feedIn.error || null,
            page: feedIn.page || null
        }
    };

    node.status({
        fill: fallbackActive ? "yellow" : "green",
        shape: fallbackActive ? "ring" : "dot",
        text: `${totalCt} ct/kWh · PV ${feedInCt !== null ? feedInCt + " ct" : "aus"}${fallbackActive ? " · Fallback" : ""}`
    });

    return [
        { ...msg, payload: eur, topic: CFG.topicEur },
        { ...msg, payload: totalCt, topic: CFG.topicCt },
        feedIn.enabled ? { ...msg, payload: feedInCt, topic: CFG.topicFeedInCt } : null,
        { topic: "strompreis-details", payload: details }
    ];
};
