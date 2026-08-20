"use strict";

module.exports = async function run(ctx) {
    const { msg, node, flow, global, config, httpRequest } = ctx;

    const CACHE_URL = "https://raw.githubusercontent.com/stephanflug/Bibliothek_Node_Red_Code/main/remote/data/strompreise.json";

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

    function validPrice(value) {
        const x = Number(value);
        return Number.isFinite(x) && x > 0 && x <= 100;
    }

    const CFG = {
        feedInEnabled: b(config.feedInEnabled, true),
        energyFallbackCt: n(config.energyFallbackCt, 11.76),
        gridFallbackCt: n(config.gridFallbackCt, 8.66),
        feedInFallbackCt: n(config.feedInFallbackCt, 8.29),
        extraCtPerKwh: n(config.extraCtPerKwh, 0),
        allowFallback: b(config.allowFallback, true),
        timeoutSec: Math.max(3, Math.min(120, n(config.timeoutSec, 15))),
        topicEur: String(config.topicEur || "0_userdata.0.PV.Ersparnis.Strompreis_EUR_kWh"),
        topicCt: String(config.topicCt || "0_userdata.0.PV.Ersparnis.Strompreis_ct_kWh"),
        topicFeedInCt: String(config.topicFeedInCt || "0_userdata.0.PV.Einspeisung.Strompreis_ct_kWh")
    };

    async function loadCache() {
        if (typeof httpRequest !== "function") {
            throw new Error("EBST Basis V1.4.0 oder neuer erforderlich");
        }

        const response = await httpRequest({
            method: "GET",
            url: CACHE_URL,
            responseType: "text",
            timeoutMs: CFG.timeoutSec * 1000,
            maxRedirects: 5,
            followRedirects: true,
            decompress: true,
            maxBodyBytes: 256 * 1024,
            headers: {
                "Accept": "application/json,text/plain,*/*",
                "Cache-Control": "no-cache"
            }
        });

        if (!response || response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`Preis-Cache HTTP ${response && response.statusCode ? response.statusCode : 0}`);
        }

        let data;
        try {
            data = JSON.parse(String(response.body || ""));
        } catch (err) {
            throw new Error("Preis-Cache enthält ungültiges JSON: " + err.message);
        }

        if (!data || data.schema !== 1) throw new Error("Preis-Cache hat ein ungültiges Schema");
        return data;
    }

    node.status({ fill: "blue", shape: "ring", text: "Strompreise werden geladen" });

    let cache = null;
    let cacheError = null;
    try {
        cache = await loadCache();
    } catch (err) {
        cacheError = err.message;
        if (!CFG.allowFallback) throw err;
    }

    const cachedEnergy = cache && validPrice(cache.energy && cache.energy.valueCt) ? Number(cache.energy.valueCt) : null;
    const cachedGrid = cache && validPrice(cache.grid && cache.grid.valueCt) ? Number(cache.grid.valueCt) : null;
    const cachedFeed = cache && validPrice(cache.feedIn && cache.feedIn.valueCt) ? Number(cache.feedIn.valueCt) : null;

    const energyFallback = cachedEnergy === null;
    const gridFallback = cachedGrid === null;
    const feedFallback = CFG.feedInEnabled && cachedFeed === null;

    if (!CFG.allowFallback && (energyFallback || gridFallback || feedFallback)) {
        throw new Error("Strompreis: zentrale Preisdaten unvollständig");
    }

    const energyCt = round(cachedEnergy !== null ? cachedEnergy : CFG.energyFallbackCt, 3);
    const gridCt = round(cachedGrid !== null ? cachedGrid : CFG.gridFallbackCt, 3);
    const extraCt = round(CFG.extraCtPerKwh, 3);
    const totalCt = round(energyCt + gridCt + extraCt, 3);
    const eur = round(totalCt / 100, 5);

    const feedInCt = CFG.feedInEnabled
        ? round(cachedFeed !== null ? cachedFeed : CFG.feedInFallbackCt, 3)
        : null;
    const feedInEur = feedInCt !== null ? round(feedInCt / 100, 5) : null;
    const selfUseAdvantageCt = feedInCt !== null ? round(totalCt - feedInCt, 3) : null;
    const selfUseAdvantageEur = selfUseAdvantageCt !== null ? round(selfUseAdvantageCt / 100, 5) : null;

    const updated = new Date().toISOString();
    const fallbackActive = Boolean(energyFallback || gridFallback || feedFallback);

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

    const energySourceUrl = cache && cache.energy ? cache.energy.sourceUrl || null : null;
    const gridSourceUrl = cache && cache.grid ? cache.grid.sourceUrl || null : null;
    const feedSourceUrl = cache && cache.feedIn ? cache.feedIn.sourceUrl || null : null;

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
        inputMode: "ebst-central-price-cache",
        cache: {
            url: CACHE_URL,
            updatedAt: cache ? cache.updatedAt || null : null,
            error: cacheError
        },
        energy: {
            url: energySourceUrl,
            valueCt: energyCt,
            source: energyFallback ? "Fallback" : "Zentraler EBST-Preis-Cache / TIWAG",
            fallback: energyFallback,
            netCt: cache && cache.energy && Number.isFinite(Number(cache.energy.netCt)) ? Number(cache.energy.netCt) : null,
            matched: null,
            error: energyFallback ? (cacheError || "Energiepreis fehlt im Cache") : null,
            page: {
                fetchMethod: "github-central-cache",
                sourceUrl: energySourceUrl,
                cacheUpdatedAt: cache ? cache.updatedAt || null : null
            }
        },
        grid: {
            url: gridSourceUrl,
            valueCt: gridCt,
            source: gridFallback ? "Fallback" : "Zentraler EBST-Preis-Cache / TINETZ",
            fallback: gridFallback,
            matched: null,
            error: gridFallback ? (cacheError || "Netzentgelt fehlt im Cache") : null,
            page: {
                fetchMethod: "github-central-cache",
                sourceUrl: gridSourceUrl,
                cacheUpdatedAt: cache ? cache.updatedAt || null : null
            }
        },
        feedIn: {
            enabled: CFG.feedInEnabled,
            url: feedSourceUrl,
            valueCt: feedInCt,
            valueEur: feedInEur,
            quarter: CFG.feedInEnabled && cache && cache.feedIn ? Number(cache.feedIn.quarter) || null : null,
            year: CFG.feedInEnabled && cache && cache.feedIn ? Number(cache.feedIn.year) || null : null,
            source: !CFG.feedInEnabled ? "deaktiviert" : (feedFallback ? "Fallback" : "Zentraler EBST-Preis-Cache / TIWAG PV"),
            fallback: feedFallback,
            matched: null,
            foundPrices: CFG.feedInEnabled && cachedFeed !== null ? 1 : 0,
            error: feedFallback ? (cacheError || "Einspeisepreis fehlt im Cache") : null,
            page: CFG.feedInEnabled ? {
                fetchMethod: "github-central-cache",
                sourceUrl: feedSourceUrl,
                cacheUpdatedAt: cache ? cache.updatedAt || null : null
            } : null
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
        CFG.feedInEnabled ? { ...msg, payload: feedInCt, topic: CFG.topicFeedInCt } : null,
        { topic: "strompreis-details", payload: details }
    ];
};
