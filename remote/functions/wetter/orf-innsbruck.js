"use strict";

const https = require("https");

const SOURCE_URL = "https://wetter.orf.at/tirol/prognose";
const VERSION = "1.3.0";

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
                const next = new URL(res.headers.location, url).toString();
                return fetchText(next, redirects + 1).then(resolve, reject);
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
    let s = input;
    if (Buffer.isBuffer(s)) s = s.toString("utf8");
    if (typeof s !== "string") s = String(s || "");

    s = s
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|td|th|li|h1|h2|h3|h4|h5|h6|section|article)\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " ");

    s = decodeEntities(s);
    return s
        .replace(/âˆ’/g, "-")
        .replace(/−/g, "-")
        .replace(/Â°/g, "°")
        .replace(/Â/g, "")
        .replace(/\u00EF\u00BF\u0153/g, "ö")
        .replace(/bewï¿œlkt/gi, "bewölkt")
        .replace(/\r/g, "")
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
}

function normalizeForSearch(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
        .replace(/\s+/g, " ").trim();
}

function cleanTemperatureText(s) {
    return String(s || "")
        .replace(/\(\s*Grad\s+Celsius\s*\)/gi, " ")
        .replace(/[\u2009\u202f\u00a0]/g, " ");
}

function findTemperaturePair(s) {
    const m = cleanTemperatureText(s).match(
        /(-?\d{1,2}(?:[.,]\d+)?)\s*(?:°\s*C?)?\s*(?:\/|∕|-)\s*(-?\d{1,2}(?:[.,]\d+)?)\s*(?:°\s*C?)?/i
    );
    if (!m) return null;

    const min = parseFloat(m[1].replace(",", "."));
    const max = parseFloat(m[2].replace(",", "."));
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min < -50 || min > 60 || max < -50 || max > 60) return null;
    return { min, max };
}

function findTemperaturePairs(s) {
    const cleaned = cleanTemperatureText(s);
    const re = /(-?\d{1,2}(?:[.,]\d+)?)\s*(?:°\s*C?)?\s*(?:\/|∕|-)\s*(-?\d{1,2}(?:[.,]\d+)?)\s*(?:°\s*C?)?/gi;
    const out = [];
    let m;
    while ((m = re.exec(cleaned)) !== null) {
        const min = parseFloat(m[1].replace(",", "."));
        const max = parseFloat(m[2].replace(",", "."));
        if (Number.isFinite(min) && Number.isFinite(max) && min >= -50 && min <= 60 && max >= -50 && max <= 60) {
            out.push({ min, max });
        }
        if (m[0] === "") re.lastIndex++;
    }
    return out;
}

function extractFiveDayTemperatures(lines, normalizedLines, temperatureIndex) {
    if (temperatureIndex < 0) return [];

    const pairs = [];
    const stopAt = Math.min(lines.length, temperatureIndex + 25);

    for (let i = temperatureIndex; i < stopAt && pairs.length < 5; i++) {
        if (i > temperatureIndex) {
            const n = normalizedLines[i] || "";
            if ((n.includes("prognose") || n.includes("temperatur")) && n.includes("lienz")) break;
            if (n.includes("heute abend") || n.includes("morgen,")) break;
        }

        const found = findTemperaturePairs(lines[i]);
        for (const pair of found) {
            pairs.push(pair);
            if (pairs.length >= 5) break;
        }
    }

    return pairs.slice(0, 5);
}

function payloadLooksLikeWeatherPage(payload) {
    let s = payload;
    if (Buffer.isBuffer(s)) s = s.toString("utf8");
    if (typeof s !== "string" || s.length < 100) return false;
    const n = normalizeForSearch(s);
    return n.includes("innsbruck") && (n.includes("prognose") || n.includes("temperatur"));
}

function fallbackResult(msg, node, global, errors, sample, warning) {
    const now = new Date().toISOString();
    const lastGood = global.get("innsbruck_today");

    global.set("wetter_parser_status", {
        ok: false,
        errors,
        timestamp: now,
        sample: String(sample || "").slice(0, 1000),
        remote_function_version: VERSION
    });

    node.warn("ORF Wetter Parser: " + errors.join(", "));

    if (lastGood && lastGood.condition !== undefined && lastGood.tmin_c !== undefined && lastGood.tmax_c !== undefined) {
        msg.payload = {
            location: "Innsbruck",
            condition: lastGood.condition,
            tmin_c: lastGood.tmin_c,
            tmax_c: lastGood.tmax_c,
            published: lastGood.published || null,
            stale: true,
            parser_ok: false,
            warning: warning || "ORF-Seite konnte nicht vollständig ausgewertet werden. Letzte gültige Werte werden verwendet.",
            parser_errors: errors,
            last_update: lastGood.updated_at || null
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

    let conditionToday = null;
    if (prognosisIndex >= 0) {
        const end = temperatureIndex > prognosisIndex ? temperatureIndex : Math.min(prognosisIndex + 15, lines.length);
        const inline = lines[prognosisIndex]
            .replace(/^.*?prognose\s+(?:für|fuer)\s+innsbruck(?:\s+flughafen|\s+stadt)?/i, "")
            .trim();

        if (inline && inline.length >= 3 && /[a-zäöüß]/i.test(inline) && !findTemperaturePair(inline)) {
            conditionToday = inline.split(/\s{2,}|\|/)[0].trim();
        }

        if (!conditionToday) {
            for (let i = prognosisIndex + 1; i < end; i++) {
                const candidate = lines[i].trim();
                const norm = normalizedLines[i];
                if (norm.includes("prognose") || norm.includes("temperatur") || findTemperaturePair(candidate) || !/[a-zäöüß]/i.test(candidate) || candidate.length < 3) continue;
                conditionToday = candidate.replace(/\s+/g, " ").trim();
                break;
            }
        }
    }

    const dailyTemperatures = extractFiveDayTemperatures(lines, normalizedLines, temperatureIndex);
    let tempPair = dailyTemperatures[0] || null;

    if (!tempPair && temperatureIndex >= 0) {
        const maxSearch = Math.min(temperatureIndex + 15, lines.length);
        for (let i = temperatureIndex; i < maxSearch; i++) {
            tempPair = findTemperaturePair(lines[i]);
            if (tempPair) break;
        }
    }

    if (!tempPair && prognosisIndex >= 0) {
        const maxSearch = Math.min(prognosisIndex + 30, lines.length);
        for (let i = prognosisIndex + 1; i < maxSearch; i++) {
            tempPair = findTemperaturePair(lines[i]);
            if (tempPair) break;
        }
    }

    const errors = [];
    if (prognosisIndex < 0) errors.push("Innsbruck-Prognoseüberschrift nicht gefunden");
    if (!conditionToday) errors.push("Wetterzustand nicht gefunden");
    if (!tempPair) errors.push("Temperatur nicht gefunden");
    if (dailyTemperatures.length < 5) errors.push(`5-Tage-Temperaturen unvollständig (${dailyTemperatures.length}/5)`);

    if (errors.some(e => !e.startsWith("5-Tage-Temperaturen"))) {
        return fallbackResult(msg, node, global, errors, text);
    }

    const tMin = tempPair.min;
    const tMax = tempPair.max;
    if (tMin > tMax) node.warn("ORF Wetter: Temperaturwerte unplausibel: " + tMin + " / " + tMax);

    let published = null;
    const pub = text.match(/Publiziert\s+am\s+(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (pub) published = pub[1];
    const now = new Date().toISOString();

    dailyTemperatures.forEach((pair, index) => {
        const day = index + 1;
        flow.set(`TAG_${day}_Temp_min`, pair.min);
        flow.set(`TAG_${day}_Temp_max`, pair.max);
        flow.set(`Tag_${day}_Temp_min`, pair.min);
        flow.set(`Tag_${day}_Temp_max`, pair.max);
    });

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
        daily_temperatures: dailyTemperatures.map((pair, index) => ({ day: index + 1, min: pair.min, max: pair.max }))
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
        daily_temperature_count: dailyTemperatures.length,
        remote_function_version: VERSION
    });

    let conditions = global.get("wetter_condition_varianten");
    if (!Array.isArray(conditions)) conditions = [];
    const conditionClean = String(conditionToday || "").replace(/\s+/g, " ").trim();
    const conditionExists = conditions.some(existing => String(existing).toLocaleLowerCase("de-DE").trim() === conditionClean.toLocaleLowerCase("de-DE").trim());

    let newCondition = false;
    if (conditionClean && !conditionExists) {
        conditions.push(conditionClean);
        newCondition = true;
        node.warn("Neue Wetter-Condition gefunden: " + conditionClean);
    }

    conditions.sort((a, b) => a.localeCompare(b, "de-DE", { sensitivity: "base" }));
    global.set("wetter_condition_varianten", conditions);

    const msgConditions = {
        topic: "wetter_conditions",
        filename: "wetter_conditions.json",
        payload: JSON.stringify({ conditions }, null, 2)
    };

    node.status({
        fill: dailyTemperatures.length < 5 ? "yellow" : (newCondition ? "blue" : "green"),
        shape: dailyTemperatures.length < 5 ? "ring" : "dot",
        text: dailyTemperatures.length < 5 ? `ORF: ${dailyTemperatures.length}/5 Tage` : (newCondition ? "Neue Condition: " + conditionClean : conditionClean)
    });

    return [msg, msgConditions];
};
