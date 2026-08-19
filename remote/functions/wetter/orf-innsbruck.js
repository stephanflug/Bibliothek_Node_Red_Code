"use strict";

/**
 * Remote-Funktion: ORF Wetter Innsbruck
 * Quelle: zentrale EBST Node-RED Bibliothek
 *
 * Vertragsformat:
 *   module.exports = async function(ctx) { ... }
 *
 * ctx enthält u.a.: msg, node, context, flow, global
 */
module.exports = async function run(ctx) {
    const { msg, node, context, flow, global } = ctx;

    // ============================================================
    // ORF Tirol Wetter - robuster Parser für Innsbruck
    //
    // Ziele:
    // - unabhängig von "Innsbruck Flughafen", "Innsbruck Stadt", ...
    // - tolerant gegenüber kleinen ORF-HTML-Änderungen
    // - mehrere Suchstrategien
    // - Plausibilitätsprüfung
    // - letzte gültige Werte bleiben bei Parserfehler erhalten
    // ============================================================


    // ------------------------------------------------------------
    // HTML Entities dekodieren
    // ------------------------------------------------------------
    function decodeEntities(s) {

        const map = {
            "&nbsp;": " ",
            "&thinsp;": " ",
            "&minus;": "-",
            "&deg;": "°",
            "&amp;": "&",
            "&quot;": "\"",
            "&#39;": "'",
            "&ouml;": "ö",
            "&Ouml;": "Ö",
            "&auml;": "ä",
            "&Auml;": "Ä",
            "&uuml;": "ü",
            "&Uuml;": "Ü",
            "&szlig;": "ß"
        };

        for (const k of Object.keys(map)) {
            s = s.split(k).join(map[k]);
        }

        // Dezimale Entities
        s = s.replace(/&#(\d+);/g, (_, dec) => {
            const cp = parseInt(dec, 10);

            return Number.isFinite(cp)
                ? String.fromCodePoint(cp)
                : "";
        });

        // Hex Entities
        s = s.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            const cp = parseInt(hex, 16);

            return Number.isFinite(cp)
                ? String.fromCodePoint(cp)
                : "";
        });

        return s;
    }


    // ------------------------------------------------------------
    // HTML -> Text
    // ------------------------------------------------------------
    function stripHtmlToText(input) {

        let s = input;

        if (Buffer.isBuffer(s)) {
            s = s.toString("utf8");
        }

        if (typeof s !== "string") {
            s = String(s || "");
        }

        // Scripts und CSS entfernen
        s = s
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ");

        // Relevante HTML Elemente als Zeilentrenner behandeln
        s = s
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(
                /<\/(p|div|tr|td|th|li|h1|h2|h3|h4|h5|h6|section|article)\s*>/gi,
                "\n"
            );

        // Alle übrigen Tags entfernen
        s = s.replace(/<[^>]+>/g, " ");

        // Entities dekodieren
        s = decodeEntities(s);

        // Bekannte Encoding-Probleme beheben
        s = s
            .replace(/âˆ’/g, "-")
            .replace(/−/g, "-")
            .replace(/Â°/g, "°")
            .replace(/Â/g, "");

        // ORF / UTF8 Mojibake
        s = s
            .replace(/\u00EF\u00BF\u0153/g, "ö")
            .replace(/bewï¿œlkt/gi, "bewölkt");

        // Whitespace aufräumen
        s = s
            .replace(/\r/g, "")
            .replace(/[ \t\f\v]+/g, " ")
            .replace(/\n[ \t]+/g, "\n")
            .replace(/\n{2,}/g, "\n")
            .trim();

        return s;
    }


    // ------------------------------------------------------------
    // Zeile normalisieren - nur für Vergleiche
    // Originaltext bleibt unangetastet.
    // ------------------------------------------------------------
    function normalizeForSearch(s) {

        return String(s || "")
            .toLowerCase()
            .replace(/ä/g, "a")
            .replace(/ö/g, "o")
            .replace(/ü/g, "u")
            .replace(/ß/g, "ss")
            .replace(/\s+/g, " ")
            .trim();
    }


    // ------------------------------------------------------------
    // Temperaturpaar aus einer Zeichenkette suchen
    // ------------------------------------------------------------
    function findTemperaturePair(s) {

        const m = String(s || "").match(
            /(-?\d{1,2}(?:[.,]\d+)?)\s*(?:°\s*C?)?\s*(?:\/|∕|-)\s*(-?\d{1,2}(?:[.,]\d+)?)\s*(?:°\s*C?)?/i
        );

        if (!m) {
            return null;
        }

        const min = parseFloat(
            m[1].replace(",", ".")
        );

        const max = parseFloat(
            m[2].replace(",", ".")
        );

        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            return null;
        }

        // Plausibilität für Tirol
        if (
            min < -50 ||
            min > 60 ||
            max < -50 ||
            max > 60
        ) {
            return null;
        }

        return {
            min: min,
            max: max
        };
    }


    // ============================================================
    // HTML verarbeiten
    // ============================================================

    const text = stripHtmlToText(msg.payload);

    const lines = text
        .split("\n")
        .map(x => x.trim())
        .filter(Boolean);

    const normalizedLines = lines.map(normalizeForSearch);


    // ============================================================
    // 1. Prognose-Überschrift Innsbruck suchen
    // ============================================================

    let prognosisIndex = -1;

    for (let i = 0; i < normalizedLines.length; i++) {

        const l = normalizedLines[i];

        if (
            l.includes("prognose") &&
            l.includes("innsbruck")
        ) {
            prognosisIndex = i;
            break;
        }
    }


    // ============================================================
    // 2. Temperatur-Überschrift Innsbruck suchen
    // ============================================================

    let temperatureIndex = -1;

    for (let i = 0; i < normalizedLines.length; i++) {

        const l = normalizedLines[i];

        if (
            l.includes("temperatur") &&
            l.includes("innsbruck")
        ) {
            temperatureIndex = i;
            break;
        }
    }


    // ============================================================
    // 3. Wetterzustand ermitteln
    // ============================================================

    let conditionToday = null;


    // ------------------------------------------------------------
    // Strategie A:
    // Erste sinnvolle Zeile nach "Prognose ... Innsbruck"
    // ------------------------------------------------------------

    if (prognosisIndex >= 0) {

        let end = temperatureIndex;

        if (
            end < 0 ||
            end <= prognosisIndex
        ) {
            end = Math.min(
                prognosisIndex + 15,
                lines.length
            );
        }

        for (
            let i = prognosisIndex + 1;
            i < end;
            i++
        ) {

            const candidate = lines[i].trim();
            const norm = normalizedLines[i];

            // Keine Überschrift verwenden
            if (
                norm.includes("prognose") ||
                norm.includes("temperatur")
            ) {
                continue;
            }

            // Keine reine Temperaturzeile verwenden
            if (findTemperaturePair(candidate)) {
                continue;
            }

            // Muss wenigstens Buchstaben enthalten
            if (!/[a-zäöüß]/i.test(candidate)) {
                continue;
            }

            // Zu kurze Fragmente ignorieren
            if (candidate.length < 3) {
                continue;
            }

            conditionToday = candidate
                .replace(/\s+/g, " ")
                .trim();

            break;
        }
    }


    // ============================================================
    // 4. Temperatur ermitteln
    // ============================================================

    let tempPair = null;


    // ------------------------------------------------------------
    // Strategie A:
    // Nach Temperatur-Überschrift suchen
    // ------------------------------------------------------------

    if (temperatureIndex >= 0) {

        const maxSearch = Math.min(
            temperatureIndex + 15,
            lines.length
        );

        for (
            let i = temperatureIndex + 1;
            i < maxSearch;
            i++
        ) {

            tempPair = findTemperaturePair(lines[i]);

            if (tempPair) {
                break;
            }
        }
    }


    // ------------------------------------------------------------
    // Strategie B:
    // Falls ORF "Temperatur für Innsbruck" umbenennt,
    // in der Nähe des Innsbruck-Prognoseblocks suchen.
    // ------------------------------------------------------------

    if (!tempPair && prognosisIndex >= 0) {

        const maxSearch = Math.min(
            prognosisIndex + 30,
            lines.length
        );

        for (
            let i = prognosisIndex + 1;
            i < maxSearch;
            i++
        ) {

            tempPair = findTemperaturePair(lines[i]);

            if (tempPair) {
                break;
            }
        }
    }


    // ============================================================
    // 5. Letzter Fallback:
    // Im gesamten Dokument nach einem Temperaturpaar suchen,
    // aber nur wenn ein Innsbruck-Prognoseblock gefunden wurde.
    // ============================================================

    if (!tempPair && prognosisIndex >= 0) {

        for (let i = prognosisIndex + 1; i < lines.length; i++) {

            // Stop sobald nächste Prognose einer anderen Region beginnt
            if (
                i > prognosisIndex + 1 &&
                normalizedLines[i].includes("prognose") &&
                !normalizedLines[i].includes("innsbruck")
            ) {
                break;
            }

            tempPair = findTemperaturePair(lines[i]);

            if (tempPair) {
                break;
            }
        }
    }


    // ============================================================
    // 6. Ergebnis validieren
    // ============================================================

    const errors = [];

    if (prognosisIndex < 0) {
        errors.push("Innsbruck-Prognoseüberschrift nicht gefunden");
    }

    if (!conditionToday) {
        errors.push("Wetterzustand nicht gefunden");
    }

    if (!tempPair) {
        errors.push("Temperatur nicht gefunden");
    }


    // ============================================================
    // 7. FALLBACK AUF LETZTE GÜLTIGE WERTE
    // ============================================================

    if (errors.length > 0) {

        const lastGood = global.get("innsbruck_today");

        const errorInfo = {
            ok: false,
            errors: errors,
            timestamp: new Date().toISOString(),
            sample: text.slice(0, 1000)
        };

        global.set(
            "wetter_parser_status",
            errorInfo
        );

        node.warn(
            "ORF Wetter Parser: " +
            errors.join(", ")
        );


        // --------------------------------------------------------
        // Wichtig:
        // Alte gültige Wetterwerte NICHT überschreiben
        // --------------------------------------------------------

        if (
            lastGood &&
            lastGood.condition !== undefined &&
            lastGood.tmin_c !== undefined &&
            lastGood.tmax_c !== undefined
        ) {

            msg.payload = {
                location: "Innsbruck",
                condition: lastGood.condition,
                tmin_c: lastGood.tmin_c,
                tmax_c: lastGood.tmax_c,
                published: lastGood.published || null,

                stale: true,
                parser_ok: false,

                warning:
                    "ORF-Seite konnte nicht vollständig ausgewertet werden. Letzte gültige Werte werden verwendet.",

                parser_errors:
                    errors,

                last_update:
                    lastGood.updated_at || null
            };

            return msg;
        }


        // Noch nie gültige Werte vorhanden
        msg.payload = {
            error:
                "ORF Wetter konnte nicht ausgewertet werden",

            parser_errors:
                errors,

            sample:
                text.slice(0, 1000)
        };

        return msg;
    }


    // ============================================================
    // 8. Zusätzliche Plausibilitätskontrolle
    // ============================================================

    const tMin = tempPair.min;
    const tMax = tempPair.max;


    // Normalerweise sollte Minimum <= Maximum sein
    if (tMin > tMax) {

        const errorInfo = {
            ok: false,
            errors: [
                "Temperatur Minimum größer als Maximum"
            ],
            tmin: tMin,
            tmax: tMax,
            timestamp: new Date().toISOString()
        };

        global.set(
            "wetter_parser_status",
            errorInfo
        );

        node.warn(
            "ORF Wetter: Temperaturwerte unplausibel: " +
            tMin +
            " / " +
            tMax
        );
    }


    // ============================================================
    // 9. Veröffentlichungsdatum optional suchen
    // ============================================================

    let published = null;

    const pub =
        text.match(
            /Publiziert\s+am\s+(\d{1,2}\.\d{1,2}\.\d{4})/i
        );

    if (pub) {
        published = pub[1];
    }


    // ============================================================
    // 10. Gültiges Ergebnis
    // ============================================================

    const now =
        new Date().toISOString();

    msg.payload = {

        location:
            "Innsbruck",

        condition:
            conditionToday,

        tmin_c:
            tMin,

        tmax_c:
            tMax,

        published:
            published,

        source:
            "https://wetter.orf.at/tirol/prognose",

        parser_ok:
            true,

        stale:
            false,

        updated_at:
            now
    };


    // ============================================================
    // 11. Globale Werte speichern
    // ============================================================

    global.set(
        "innsbruck_today",
        {
            condition:
                conditionToday,

            tmin_c:
                tMin,

            tmax_c:
                tMax,

            published:
                published,

            updated_at:
                now
        }
    );


    // Deine bisherigen Variablen
    global.set(
        "wettervorhersage",
        conditionToday
    );

    global.set(
        "wetter_temp",
        tMin
    );

    global.set(
        "wetter_temp_Max",
        tMax
    );


    // Parserstatus
    global.set(
        "wetter_parser_status",
        {
            ok: true,
            timestamp: now,
            prognosis_heading:
                prognosisIndex >= 0
                    ? lines[prognosisIndex]
                    : null,

            temperature_heading:
                temperatureIndex >= 0
                    ? lines[temperatureIndex]
                    : null
        }
    );


    return msg;
};
