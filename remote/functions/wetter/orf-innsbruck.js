"use strict";

const https = require("https");

const SOURCE_URL = "https://wetter.orf.at/tirol/prognose";
const VERSION = "1.4.0";
const TIME_ZONE = "Europe/Vienna";

function fetchText(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error("Zu viele HTTP-Weiterleitungen"));
        const req = https.get(url, {
            headers: {
                "User-Agent": "EBST-NodeRED-ORF-Wetter/" + VERSION,
                "Accept": "text/html,application/xhtml+xml,*/*",
                "Cache-Control": "no-cache"
            },
            timeout: 15000
        }, res => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                return fetchText(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
            }
            if (status !== 200) {
                res.resume();
                return reject(new Error("HTTP " + status));
            }
            res.setEncoding("utf8");
            let body = "";
            res.on("data", chunk => {
                body += chunk;
                if (body.length > 2 * 1024 * 1024) req.destroy(new Error("ORF-Antwort größer als 2 MB"));
            });
            res.on("end", () => resolve(body));
        });
        req.on("timeout", () => req.destroy(new Error("ORF HTTP Timeout")));
        req.on("error", reject);
    });
}

function decodeEntities(s) {
    const map = {
        "&nbsp;": " ", "&thinsp;": " ", "&minus;": "-", "&deg;": "°", "&amp;": "&",
        "&quot;": "\"", "&#39;": "'", "&ouml;": "ö", "&Ouml;": "Ö", "&auml;": "ä",
        "&Auml;": "Ä", "&uuml;": "ü", "&Uuml;": "Ü", "&szlig;": "ß"
    };
    for (const [key, value] of Object.entries(map)) s = s.split(key).join(value);
    s = s.replace(/&#(\d+);/g, (_, dec) => {
        const cp = parseInt(dec, 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    });
    s = s.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
        const cp = parseInt(hex, 16);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    });
    return s;
}

function stripHtmlToText(input) {
    let s = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
    s = s
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|td|th|li|h1|h2|h3|h4|h5|h6|section|article)\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " ");
    return decodeEntities(s)
        .replace(/âˆ’|−/g, "-")
        .replace(/Â°/g, "°")
        .replace(/Â/g, "")
        .replace(/bewï¿œlkt/gi, "bewölkt")
        .replace(/\r/g, "")
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
}

function normalizeForSearch(s) {
    return String(s || "").toLowerCase()
        .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
        .replace(/\s+/g, " ").trim();
}

function cleanTemperatureText(s) {
    return String(s || "")
        .replace(/\(\s*Grad\s+Celsius\s*\)/gi, " ")
        .replace(/[\u2009\u202f\u00a0]/g, " ");
}

function findTemperaturePairs(s) {
    const re = /(-?\d{1,2}(?:[.,]\d+)?)\s*(?:°\s*C?)?\s*(?:\/|∕|-)\s*(-?\d{1,2}(?:[.,]\d+)?)\s*(?:°\s*C?)?/gi;
    const out = [];
    let m;
    while ((m = re.exec(cleanTemperatureText(s))) !== null) {
        const min = parseFloat(m[1].replace(",", "."));
        const max = parseFloat(m[2].replace(",", "."));
        if (Number.isFinite(min) && Number.isFinite(max) && min >= -50 && min <= 60 && max >= -50 && max <= 60) {
            out.push({ min, max });
        }
        if (m[0] === "") re.lastIndex++;
    }
    return out;
}

function findTemperaturePair(s) {
    return findTemperaturePairs(s)[0] || null;
}

function payloadLooksLikeWeatherPage(payload) {
    const s = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload || "");
    if (s.length < 100) return false;
    const n = normalizeForSearch(s);
    return n.includes("innsbruck") && (n.includes("prognose") || n.includes("temperatur"));
}

function extractFiveDayTemperatures(lines, normalizedLines, temperatureIndex) {
    if (temperatureIndex < 0) return [];
    const pairs = [];
    const stopAt = Math.min(lines.length, temperatureIndex + 30);
    for (let i = temperatureIndex; i < stopAt && pairs.length < 5; i++) {
        const n = normalizedLines[i] || "";
        if (i > temperatureIndex && ((n.includes("prognose") || n.includes("temperatur")) && n.includes("lienz"))) break;
        const found = findTemperaturePairs(lines[i]);
        for (const pair of found) {
            pairs.push(pair);
            if (pairs.length >= 5) break;
        }
    }
    return pairs.slice(0, 5);
}

function extractFiveConditions(lines, normalizedLines, prognosisIndex, temperatureIndex) {
    if (prognosisIndex < 0) return [];
    const out = [];
    const end = temperatureIndex > prognosisIndex ? temperatureIndex : Math.min(lines.length, prognosisIndex + 30);

    const inline = lines[prognosisIndex]
        .replace(/^.*?prognose\s+(?:für|fuer)\s+innsbruck(?:\s+flughafen|\s+stadt)?/i, "")
        .trim();
    if (inline && inline.length >= 3 && /[a-zäöüß]/i.test(inline) && !findTemperaturePair(inline)) out.push(inline);

    for (let i = prognosisIndex + 1; i < end && out.length < 5; i++) {
        const candidate = String(lines[i] || "").replace(/\s+/g, " ").trim();
        const norm = normalizedLines[i] || "";
        if (!candidate || candidate.length < 3) continue;
        if (norm.includes("prognose") || norm.includes("temperatur")) continue;
        if (findTemperaturePair(candidate)) continue;
        if (!/[a-zäöüß]/i.test(candidate)) continue;
        if (/^(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)$/i.test(candidate)) continue;
        out.push(candidate);
    }
    return out.slice(0, 5);
}

function getViennaTodayParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return { year: Number(obj.year), month: Number(obj.month), day: Number(obj.day) };
}

function buildForecastDates(count) {
    const p = getViennaTodayParts();
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
    const weekdays = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
    const out = [];
    for (let i = 0; i < count; i++) {
        const d = new Date(base.getTime() + i * 86400000);
        const y = d.getUTCFullYear();
        const m = d.getUTCMonth() + 1;
        const day = d.getUTCDate();
        out.push({
            iso: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
            label: `${day}.${m}.`,
            day: weekdays[d.getUTCDay()]
        });
    }
    return out;
}

function fallbackResult(msg, node, global, errors, sample, warning) {
    const now = new Date().toISOString();
    const lastGood = global.get("innsbruck_today");
    global.set("wetter_parser_status", { ok: false, errors, timestamp: now, sample: String(sample || "").slice(0, 1000), remote_function_version: VERSION });
    node.warn("ORF Wetter Parser: " + errors.join(", "));

    if (lastGood && lastGood.condition !== undefined && lastGood.tmin_c !== undefined && lastGood.tmax_c !== undefined) {
        msg.payload = {
            location: "Innsbruck", condition: lastGood.condition, tmin_c: lastGood.tmin_c, tmax_c: lastGood.tmax_c,
            published: lastGood.published || null, stale: true, parser_ok: false,
            warning: warning || "ORF-Seite konnte nicht vollständig ausgewertet werden. Letzte gültige Werte werden verwendet.",
            parser_errors: errors, last_update: lastGood.updated_at || null
        };
        node.status({ fill: "yellow", shape: "ring", text: "Fallback: letzte Wetterwerte" });
        return [msg, null];
    }

    msg.payload = { error: "ORF Wetter konnte nicht ausgewertet werden", parser_errors: errors, sample: String(sample || "").slice(0, 1000) };
    node.status({ fill: "red", shape: "ring", text: "ORF Wetter Fehler" });
    return [msg, null];
}

module.exports = async function run(ctx) {
    const { msg, node, flow, global } = ctx;
    let sourceData = msg.payload;

    if (!payloadLooksLikeWeatherPage(sourceData)) {
        try {
            sourceData = await fetchText(SOURCE_URL);
        } catch (err) {
            return fallbackResult(msg, node, global, ["ORF-Seite konnte nicht geladen werden: " + err.message], sourceData,
                "ORF-Seite konnte nicht geladen werden. Letzte gültige Werte werden verwendet.");
        }
    }

    const text = stripHtmlToText(sourceData);
    const lines = text.split("\n").map(x => x.trim()).filter(Boolean);
    const normalizedLines = lines.map(normalizeForSearch);

    let prognosisIndex = -1;
    let temperatureIndex = -1;
    for (let i = 0; i < normalizedLines.length; i++) {
        const l = normalizedLines[i];
        if (prognosisIndex < 0 && l.includes("prognose") && l.includes("innsbruck")) prognosisIndex = i;
        if (temperatureIndex < 0 && l.includes("temperatur") && l.includes("innsbruck")) temperatureIndex = i;
        if (prognosisIndex >= 0 && temperatureIndex >= 0) break;
    }

    const dailyConditions = extractFiveConditions(lines, normalizedLines, prognosisIndex, temperatureIndex);
    const dailyTemperatures = extractFiveDayTemperatures(lines, normalizedLines, temperatureIndex);
    const conditionToday = dailyConditions[0] || null;
    const tempPair = dailyTemperatures[0] || null;

    const errors = [];
    if (prognosisIndex < 0) errors.push("Innsbruck-Prognoseüberschrift nicht gefunden");
    if (!conditionToday) errors.push("Wetterzustand nicht gefunden");
    if (!tempPair) errors.push("Temperatur nicht gefunden");
    if (dailyConditions.length < 5) errors.push(`5-Tage-Conditions unvollständig (${dailyConditions.length}/5)`);
    if (dailyTemperatures.length < 5) errors.push(`5-Tage-Temperaturen unvollständig (${dailyTemperatures.length}/5)`);

    if (!conditionToday || !tempPair) return fallbackResult(msg, node, global, errors, text);

    let published = null;
    const pub = text.match(/Publiziert\s+am\s+(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (pub) published = pub[1];

    const now = new Date().toISOString();
    const dates = buildForecastDates(5);
    const forecast = [];

    for (let i = 0; i < 5; i++) {
        const day = i + 1;
        const pair = dailyTemperatures[i] || null;
        const condition = dailyConditions[i] || null;
        const date = dates[i];

        if (condition !== null) flow.set(`TAG_${day}_Condition`, condition);
        flow.set(`TAG_${day}_Date_iso`, date.iso);
        flow.set(`TAG_${day}_Date_label`, date.label);
        flow.set(`TAG_${day}_Day`, date.day);
        if (pair) {
            flow.set(`TAG_${day}_Temp_min`, pair.min);
            flow.set(`TAG_${day}_Temp_max`, pair.max);
            flow.set(`Tag_${day}_Temp_min`, pair.min);
            flow.set(`Tag_${day}_Temp_max`, pair.max);
        }

        forecast.push({
            day,
            condition,
            date_iso: date.iso,
            date_label: date.label,
            weekday: date.day,
            min: pair ? pair.min : null,
            max: pair ? pair.max : null
        });
    }

    const tMin = tempPair.min;
    const tMax = tempPair.max;
    msg.payload = {
        location: "Innsbruck",
        condition: conditionToday,
        tmin_c: tMin,
        tmax_c: tMax,
        published,
        source: SOURCE_URL,
        parser_ok: true,
        stale: false,
        updated_at: now,
        daily_forecast: forecast,
        daily_temperatures: forecast.map(x => ({ day: x.day, min: x.min, max: x.max }))
    };

    global.set("innsbruck_today", { condition: conditionToday, tmin_c: tMin, tmax_c: tMax, published, updated_at: now });
    global.set("wettervorhersage", conditionToday);
    global.set("wetter_temp", tMin);
    global.set("wetter_temp_Max", tMax);
    global.set("wetter_parser_status", {
        ok: true,
        timestamp: now,
        prognosis_heading: prognosisIndex >= 0 ? lines[prognosisIndex] : null,
        temperature_heading: temperatureIndex >= 0 ? lines[temperatureIndex] : null,
        daily_condition_count: dailyConditions.length,
        daily_temperature_count: dailyTemperatures.length,
        remote_function_version: VERSION
    });

    let conditions = global.get("wetter_condition_varianten");
    if (!Array.isArray(conditions)) conditions = [];
    for (const c of dailyConditions) {
        const clean = String(c || "").replace(/\s+/g, " ").trim();
        if (clean && !conditions.some(existing => String(existing).toLocaleLowerCase("de-DE").trim() === clean.toLocaleLowerCase("de-DE").trim())) {
            conditions.push(clean);
        }
    }
    conditions.sort((a, b) => a.localeCompare(b, "de-DE", { sensitivity: "base" }));
    global.set("wetter_condition_varianten", conditions);

    const msgConditions = {
        topic: "wetter_conditions",
        filename: "wetter_conditions.json",
        payload: JSON.stringify({ conditions }, null, 2)
    };

    node.status({
        fill: dailyConditions.length < 5 || dailyTemperatures.length < 5 ? "yellow" : "green",
        shape: dailyConditions.length < 5 || dailyTemperatures.length < 5 ? "ring" : "dot",
        text: dailyConditions.length < 5 || dailyTemperatures.length < 5
            ? `ORF: C${dailyConditions.length}/5 T${dailyTemperatures.length}/5`
            : conditionToday
    });

    return [msg, msgConditions];
};