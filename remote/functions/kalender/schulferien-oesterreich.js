"use strict";

module.exports = async function run(ctx) {
    const { msg, node, flow, global, httpRequest, config = {} } = ctx;

    const VERSION = "1.0.0";
    const TIMEZONE = "Europe/Vienna";
    const API_BASE = "https://openholidaysapi.org/SchoolHolidays";

    const STATES = {
        "AT-BL": "Burgenland",
        "AT-KÄ": "Kärnten",
        "AT-NÖ": "Niederösterreich",
        "AT-OÖ": "Oberösterreich",
        "AT-SB": "Salzburg",
        "AT-SM": "Steiermark",
        "AT-TI": "Tirol",
        "AT-VA": "Vorarlberg",
        "AT-WI": "Wien"
    };

    const subdivisionCode = STATES[String(config.bundesland || "AT-TI")]
        ? String(config.bundesland || "AT-TI")
        : "AT-TI";
    const bundesland = STATES[subdivisionCode];
    const refreshMinutes = Math.max(15, Number(config.refreshMinutes || 720));
    const useCacheOnError = config.useCacheOnError !== false && String(config.useCacheOnError).toLowerCase() !== "false";

    function localIsoDate(date = new Date()) {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: TIMEZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).formatToParts(date);
        const y = parts.find(p => p.type === "year").value;
        const m = parts.find(p => p.type === "month").value;
        const d = parts.find(p => p.type === "day").value;
        return `${y}-${m}-${d}`;
    }

    function daysBetween(a, b) {
        const [y1, m1, d1] = String(a).split("-").map(Number);
        const [y2, m2, d2] = String(b).split("-").map(Number);
        return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
    }

    function nameDe(holiday) {
        const names = Array.isArray(holiday && holiday.name) ? holiday.name : [];
        const de = names.find(x => String(x && x.language || "").toUpperCase() === "DE");
        return String((de && de.text) || (names[0] && names[0].text) || "Schulferien");
    }

    function normalizeHoliday(h) {
        return {
            id: h && h.id ? String(h.id) : null,
            name: nameDe(h),
            startDate: h && h.startDate ? String(h.startDate) : null,
            endDate: h && h.endDate ? String(h.endDate) : null,
            nationwide: Boolean(h && h.nationwide),
            regionalScope: h && h.regionalScope != null ? h.regionalScope : null,
            temporalScope: h && h.temporalScope != null ? h.temporalScope : null,
            subdivisions: Array.isArray(h && h.subdivisions) ? h.subdivisions : [],
            tags: Array.isArray(h && h.tags) ? h.tags : [],
            comment: Array.isArray(h && h.comment) ? h.comment : []
        };
    }

    function isSummerHoliday(h) {
        const s = String(h && h.name || "").toLocaleLowerCase("de-AT");
        return s.includes("sommerferien") || s.includes("sommer ferien") || s.includes("summer holiday") || s.includes("summer break");
    }

    function activeOn(h, date) {
        return Boolean(h && h.startDate && h.endDate && h.startDate <= date && h.endDate >= date);
    }

    function cacheKey(suffix) {
        const id = node && node.id ? node.id : "node";
        return `ebstSchoolHoliday_${id}_${subdivisionCode}_${suffix}`;
    }

    async function fetchHolidays(validFrom, validTo) {
        const url = `${API_BASE}?countryIsoCode=AT&subdivisionCode=${encodeURIComponent(subdivisionCode)}&languageIsoCode=DE&validFrom=${validFrom}&validTo=${validTo}`;

        if (typeof httpRequest === "function") {
            const response = await httpRequest({
                method: "GET",
                url,
                responseType: "text",
                timeoutMs: 15000,
                maxRedirects: 5,
                followRedirects: true,
                decompress: true,
                maxBodyBytes: 2 * 1024 * 1024,
                headers: {
                    "Accept": "application/json",
                    "Cache-Control": "no-cache",
                    "User-Agent": `EBST-NodeRED-Schulferien/${VERSION}`
                }
            });
            if (!response || response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`OpenHolidays HTTP ${response && response.statusCode ? response.statusCode : 0}`);
            }
            const parsed = JSON.parse(String(response.body || "[]"));
            if (!Array.isArray(parsed)) throw new Error("OpenHolidays Antwort ist kein Array");
            return parsed;
        }

        const https = require("https");
        return new Promise((resolve, reject) => {
            const req = https.get(url, {
                headers: {
                    "Accept": "application/json",
                    "User-Agent": `EBST-NodeRED-Schulferien/${VERSION}`
                },
                timeout: 15000
            }, res => {
                if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
                    res.resume();
                    return reject(new Error(`OpenHolidays HTTP ${res.statusCode || 0}`));
                }
                res.setEncoding("utf8");
                let body = "";
                res.on("data", chunk => {
                    body += chunk;
                    if (body.length > 2 * 1024 * 1024) req.destroy(new Error("OpenHolidays Antwort zu groß"));
                });
                res.on("end", () => {
                    try {
                        const parsed = JSON.parse(body || "[]");
                        if (!Array.isArray(parsed)) throw new Error("Antwort ist kein Array");
                        resolve(parsed);
                    } catch (err) {
                        reject(new Error(`OpenHolidays JSON: ${err.message}`));
                    }
                });
            });
            req.on("timeout", () => req.destroy(new Error("OpenHolidays Timeout")));
            req.on("error", reject);
        });
    }

    const heute = localIsoDate();
    const year = Number(heute.slice(0, 4));
    const validFrom = `${year - 1}-12-01`;
    const validTo = `${year + 1}-12-31`;
    const nowMs = Date.now();

    let holidays = flow.get(cacheKey("data"));
    const cacheUpdatedMs = Number(flow.get(cacheKey("updatedMs")) || 0);
    const cacheAgeMinutes = cacheUpdatedMs > 0 ? (nowMs - cacheUpdatedMs) / 60000 : Infinity;
    let cacheUsed = Array.isArray(holidays);
    let stale = false;
    let fetchError = null;

    const forceRefresh = msg && (msg.force === true || msg.topic === "refresh" || msg.topic === "recalc");

    if (!Array.isArray(holidays) || forceRefresh || cacheAgeMinutes >= refreshMinutes) {
        node.status({ fill: "blue", shape: "ring", text: `${bundesland}: Schulferien werden geladen` });
        try {
            const raw = await fetchHolidays(validFrom, validTo);
            holidays = raw
                .map(normalizeHoliday)
                .filter(h => h.startDate && h.endDate)
                .sort((a, b) => a.startDate.localeCompare(b.startDate));
            if (!holidays.length) throw new Error("Keine Schulferien für den Zeitraum erhalten");
            flow.set(cacheKey("data"), holidays);
            flow.set(cacheKey("updatedMs"), nowMs);
            flow.set(cacheKey("updatedIso"), new Date(nowMs).toISOString());
            cacheUsed = false;
        } catch (err) {
            fetchError = err;
            const cached = flow.get(cacheKey("data"));
            if (useCacheOnError && Array.isArray(cached) && cached.length) {
                holidays = cached;
                cacheUsed = true;
                stale = true;
                node.warn(`Schulferien Österreich: API-Fehler, Cache wird verwendet: ${err.message}`);
            } else {
                node.status({ fill: "red", shape: "ring", text: err.message });
                throw err;
            }
        }
    }

    const currentHoliday = holidays.find(h => activeOn(h, heute)) || null;
    const currentSummer = holidays.find(h => isSummerHoliday(h) && activeOn(h, heute)) || null;
    const nextHoliday = holidays.find(h => h.startDate > heute) || null;
    const nextSummer = holidays.find(h => isSummerHoliday(h) && h.startDate > heute) || currentSummer || null;

    const ferienAktiv = Boolean(currentHoliday);
    const sommerferienAktiv = Boolean(currentSummer);
    const tageBisNaechsteFerien = nextHoliday ? daysBetween(heute, nextHoliday.startDate) : null;
    const tageFerienRest = currentHoliday ? daysBetween(heute, currentHoliday.endDate) : null;
    const tageBisSommerferien = currentSummer ? 0 : (nextSummer ? daysBetween(heute, nextSummer.startDate) : null);
    const tageSommerferienRest = currentSummer ? daysBetween(heute, currentSummer.endDate) : null;

    const info = {
        bundesland,
        subdivisionCode,
        heute,
        timezone: TIMEZONE,
        ferienAktiv,
        sommerferienAktiv,
        aktuelleFerien: currentHoliday,
        aktuelleFerienName: currentHoliday ? currentHoliday.name : "",
        aktuelleFerienBeginn: currentHoliday ? currentHoliday.startDate : null,
        aktuelleFerienEnde: currentHoliday ? currentHoliday.endDate : null,
        tageFerienRest,
        naechsteFerien: nextHoliday,
        naechsteFerienName: nextHoliday ? nextHoliday.name : "",
        naechsteFerienBeginn: nextHoliday ? nextHoliday.startDate : null,
        naechsteFerienEnde: nextHoliday ? nextHoliday.endDate : null,
        tageBisNaechsteFerien,
        naechsteSommerferien: nextSummer,
        sommerferienBeginn: currentSummer ? currentSummer.startDate : (nextSummer ? nextSummer.startDate : null),
        sommerferienEnde: currentSummer ? currentSummer.endDate : (nextSummer ? nextSummer.endDate : null),
        tageBisSommerferien,
        tageSommerferienRest,
        ferienListe: holidays,
        anzahlFerienZeitraeume: holidays.length,
        datenVon: validFrom,
        datenBis: validTo,
        cacheUsed,
        stale,
        cacheUpdatedAt: flow.get(cacheKey("updatedIso")) || null,
        fetchError: fetchError ? fetchError.message : null,
        source: "OpenHolidays API",
        sourceUrl: API_BASE,
        remote_function_version: VERSION
    };

    const contextValues = {
        Schulferien_Bundesland: bundesland,
        Schulferien_Bundesland_Code: subdivisionCode,
        Schulferien_Aktiv: ferienAktiv,
        Schulferien_Name: info.aktuelleFerienName,
        Schulferien_Beginn: info.aktuelleFerienBeginn,
        Schulferien_Ende: info.aktuelleFerienEnde,
        Schulferien_Resttage: tageFerienRest,
        Schulferien_Naechste_Name: info.naechsteFerienName,
        Schulferien_Naechste_Beginn: info.naechsteFerienBeginn,
        Schulferien_Naechste_Ende: info.naechsteFerienEnde,
        Schulferien_Tage_bis_naechste: tageBisNaechsteFerien,
        Schulferien_Sommer_Aktiv: sommerferienAktiv,
        Schulferien_Sommer_Beginn: info.sommerferienBeginn,
        Schulferien_Sommer_Ende: info.sommerferienEnde,
        Schulferien_Tage_bis_Sommer: tageBisSommerferien,
        Schulferien_Sommer_Resttage: tageSommerferienRest,
        Schulferien_Info: info,
        Schulferien_Letzte_Aktualisierung: new Date().toISOString()
    };

    for (const [key, value] of Object.entries(contextValues)) {
        flow.set(key, value);
        global.set(key, value);
    }

    let statusText;
    if (sommerferienAktiv) {
        statusText = `Sommerferien · ${bundesland} · noch ${tageSommerferienRest} Tage`;
    } else if (ferienAktiv) {
        statusText = `${currentHoliday.name} · ${bundesland}`;
    } else if (nextHoliday) {
        statusText = `${bundesland} · nächste Ferien in ${tageBisNaechsteFerien} Tagen`;
    } else {
        statusText = `${bundesland} · keine nächsten Ferien im Datenfenster`;
    }

    node.status({
        fill: sommerferienAktiv ? "yellow" : (ferienAktiv ? "green" : "blue"),
        shape: ferienAktiv ? "dot" : "ring",
        text: statusText
    });

    const msgFerien = {
        ...msg,
        topic: "schulferien/aktiv",
        payload: ferienAktiv,
        info
    };

    const msgSommer = {
        ...msg,
        topic: "schulferien/sommerferien",
        payload: sommerferienAktiv,
        info
    };

    const msgDetails = {
        ...msg,
        topic: "schulferien/details",
        payload: info
    };

    return [msgFerien, msgSommer, msgDetails];
};
