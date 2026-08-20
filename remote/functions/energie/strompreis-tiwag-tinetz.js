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
            .replace(/&#(\d+);/g, (_, code) => {
                const number = Number(code);
                return Number.isFinite(number) ? String.fromCodePoint(number) : _;
            })
            .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
                const number = parseInt(code, 16);
                return Number.isFinite(number) ? String.fromCodePoint(number) : _;
            });
    }

    function htmlToText(html) {
        return decodeHtmlEntities(html)
            .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
            .replace(/<!--[\s\S]*?-->/g, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function compileRegex(pattern, name) {
        try {
            return new RegExp(String(pattern || ""), "i");
        } catch (err) {
            throw new Error(`${name}: ungültiger regulärer Ausdruck: ${err.message}`);
        }
    }

    function fetchText(url, timeoutMs, redirects = 0) {
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
                    "User-Agent": "EBST-NodeRED-Remote-Function/1.3.0 Strompreis",
                    "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
                    "Cache-Control": "no-cache"
                },
                timeout: timeoutMs
            }, res => {
                const status = res.statusCode || 0;

                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    const next = new URL(res.headers.location, parsed).toString();
                    fetchText(next, timeoutMs, redirects + 1).then(resolve, reject);
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
                res.on("end", () => resolve(body));
            });

            req.on("timeout", () => req.destroy(new Error("HTTP Timeout")));
            req.on("error", reject);
        });
    }

    const CFG = {
        energyUrl: String(config.energyUrl || "https://www.tiwag.at/tutwas/").trim(),
        gridUrl: String(config.gridUrl || "https://www.tinetz.at/infobereich/allgemeines/netztarifaenderungen-ab-2026/").trim(),
        energyFallbackCt: n(config.energyFallbackCt, 11.76),
        gridFallbackCt: n(config.gridFallbackCt, 8.66),
        extraCtPerKwh: n(config.extraCtPerKwh, 0),
        vatPercent: n(config.vatPercent, 20),
        energyGrossRegex: String(config.energyGrossRegex || "(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh\\s*inkl\\.?\\s*USt"),
        energyNetRegex: String(config.energyNetRegex || "(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh\\s*exkl\\.?\\s*USt"),
        gridRegex: String(config.gridRegex || "in\\s+Tirol[^.]{0,250}?lediglich\\s*(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),
        allowFallback: b(config.allowFallback, true),
        timeoutSec: Math.max(3, Math.min(60, n(config.timeoutSec, 15))),
        topicEur: String(config.topicEur || "0_userdata.0.PV.Ersparnis.Strompreis_EUR_kWh"),
        topicCt: String(config.topicCt || "0_userdata.0.PV.Ersparnis.Strompreis_ct_kWh")
    };

    if (!CFG.energyUrl || !CFG.gridUrl) {
        throw new Error("Strompreis: Energie-URL und Netz-URL müssen gesetzt sein");
    }
    if (!(CFG.energyFallbackCt > 0) || !(CFG.gridFallbackCt > 0)) {
        throw new Error("Strompreis: Fallbackpreise müssen größer 0 sein");
    }

    const energyGrossRe = compileRegex(CFG.energyGrossRegex, "Energie brutto RegEx");
    const energyNetRe = compileRegex(CFG.energyNetRegex, "Energie netto RegEx");
    const gridRe = compileRegex(CFG.gridRegex, "Netz RegEx");
    const timeoutMs = CFG.timeoutSec * 1000;

    async function getEnergyPrice() {
        let html = "";
        let text = "";
        let fetchError = null;

        try {
            html = await fetchText(CFG.energyUrl, timeoutMs);
            text = htmlToText(html);
        } catch (err) {
            fetchError = err;
        }

        if (!fetchError) {
            let match = energyGrossRe.exec(text);
            if (match) {
                const ct = toNum(match[1]);
                if (Number.isFinite(ct) && ct > 0 && ct <= 100) {
                    return {
                        ct: round(ct, 3),
                        source: "Webseite brutto",
                        fallback: false,
                        matched: match[0]
                    };
                }
            }

            match = energyNetRe.exec(text);
            if (match) {
                const netCt = toNum(match[1]);
                if (Number.isFinite(netCt) && netCt > 0 && netCt <= 100) {
                    const grossCt = netCt * (1 + CFG.vatPercent / 100);
                    return {
                        ct: round(grossCt, 3),
                        netCt: round(netCt, 3),
                        source: `Webseite netto + ${CFG.vatPercent}% USt`,
                        fallback: false,
                        matched: match[0]
                    };
                }
            }
        }

        if (!CFG.allowFallback) {
            throw new Error(fetchError
                ? `TIWAG konnte nicht geladen werden: ${fetchError.message}`
                : "TIWAG-Preis konnte auf der Webseite nicht gefunden werden");
        }

        return {
            ct: round(CFG.energyFallbackCt, 3),
            source: "Fallback",
            fallback: true,
            error: fetchError ? fetchError.message : "Preis nicht gefunden"
        };
    }

    async function getGridPrice() {
        let html = "";
        let text = "";
        let fetchError = null;

        try {
            html = await fetchText(CFG.gridUrl, timeoutMs);
            text = htmlToText(html);
        } catch (err) {
            fetchError = err;
        }

        if (!fetchError) {
            const match = gridRe.exec(text);
            if (match) {
                const ct = toNum(match[1]);
                if (Number.isFinite(ct) && ct > 0 && ct <= 100) {
                    return {
                        ct: round(ct, 3),
                        source: "Webseite",
                        fallback: false,
                        matched: match[0]
                    };
                }
            }
        }

        if (!CFG.allowFallback) {
            throw new Error(fetchError
                ? `TINETZ konnte nicht geladen werden: ${fetchError.message}`
                : "TINETZ-Preis konnte auf der Webseite nicht gefunden werden");
        }

        return {
            ct: round(CFG.gridFallbackCt, 3),
            source: "Fallback",
            fallback: true,
            error: fetchError ? fetchError.message : "Preis nicht gefunden"
        };
    }

    node.status({ fill: "blue", shape: "ring", text: "Preise werden geladen" });

    const [energy, grid] = await Promise.all([getEnergyPrice(), getGridPrice()]);

    const energyCt = round(energy.ct, 3);
    const gridCt = round(grid.ct, 3);
    const extraCt = round(CFG.extraCtPerKwh, 3);
    const totalCt = round(energyCt + gridCt + extraCt, 3);
    const eur = round(totalCt / 100, 5);
    const updated = new Date().toISOString();
    const anyFallback = energy.fallback || grid.fallback;

    flow.set("tiwag_energy_ct_kwh_gross", energyCt);
    flow.set("tinetz_net_ct_kwh", gridCt);
    flow.set("strompreis_ct_kwh", totalCt);
    flow.set("strompreis_eur_kwh", eur);
    flow.set("strompreis_last_update", updated);

    global.set("strompreis_tiwag_energy_ct_kwh_gross", energyCt);
    global.set("strompreis_tinetz_net_ct_kwh", gridCt);
    global.set("strompreis_ct_kwh", totalCt);
    global.set("strompreis_eur_kwh", eur);
    global.set("strompreis_last_update", updated);

    const details = {
        energyCt,
        gridCt,
        extraCt,
        totalCt,
        eur,
        updated,
        fallbackActive: anyFallback,
        energy: {
            url: CFG.energyUrl,
            valueCt: energyCt,
            source: energy.source,
            fallback: energy.fallback,
            netCt: energy.netCt !== undefined ? energy.netCt : null,
            matched: energy.matched || null,
            error: energy.error || null
        },
        grid: {
            url: CFG.gridUrl,
            valueCt: gridCt,
            source: grid.source,
            fallback: grid.fallback,
            matched: grid.matched || null,
            error: grid.error || null
        }
    };

    node.status({
        fill: anyFallback ? "yellow" : "green",
        shape: anyFallback ? "ring" : "dot",
        text: `${totalCt} ct/kWh = ${eur} €/kWh${anyFallback ? " · Fallback" : ""}`
    });

    const msg1 = { ...msg, topic: CFG.topicEur, payload: eur };
    const msg2 = { ...msg, topic: CFG.topicCt, payload: totalCt };
    const msg3 = { topic: "strompreis-details", payload: details };

    return [msg1, msg2, msg3];
};
