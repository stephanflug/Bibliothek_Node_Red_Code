"use strict";

module.exports = async function run(ctx) {
    const { msg, node, flow, httpRequest } = ctx;

    const COUNTRY = "AT";
    const TIROL = "AT-7";
    const TIMEZONE = "Europe/Vienna";
    const API_BASE = "https://date.nager.at/api/v3/PublicHolidays";
    const VERSION = "1.0.0";

    function getLocalDateParts(date = new Date()) {
        const parts = new Intl.DateTimeFormat("de-AT", {
            timeZone: TIMEZONE,
            weekday: "long",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).formatToParts(date);

        const out = {};
        for (const part of parts) {
            if (part.type !== "literal") out[part.type] = part.value;
        }
        return out;
    }

    function getLocalIsoDate(date = new Date()) {
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

    function getWeekdayNumber(isoDate) {
        const [y, m, d] = isoDate.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    }

    function daysBetween(dateA, dateB) {
        const [y1, m1, d1] = dateA.split("-").map(Number);
        const [y2, m2, d2] = dateB.split("-").map(Number);
        return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
    }

    function isRelevantForTirol(holiday) {
        if (!holiday || !holiday.date) return false;
        if (holiday.global === true) return true;
        return Array.isArray(holiday.counties) && holiday.counties.includes(TIROL);
    }

    async function fetchYear(year) {
        const url = `${API_BASE}/${year}/${COUNTRY}`;

        if (typeof httpRequest === "function") {
            const response = await httpRequest({
                method: "GET",
                url,
                responseType: "text",
                timeoutMs: 15000,
                maxRedirects: 5,
                followRedirects: true,
                decompress: true,
                maxBodyBytes: 1024 * 1024,
                headers: {
                    "Accept": "application/json",
                    "Cache-Control": "no-cache"
                }
            });

            if (!response || response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Nager.Date HTTP ${response && response.statusCode ? response.statusCode : 0} für ${year}`);
            }

            try {
                const data = JSON.parse(String(response.body || ""));
                if (!Array.isArray(data)) throw new Error("Antwort ist kein Array");
                return data;
            } catch (err) {
                throw new Error(`Nager.Date JSON ${year}: ${err.message}`);
            }
        }

        const https = require("https");
        return new Promise((resolve, reject) => {
            const req = https.get(url, {
                headers: {
                    "User-Agent": `EBST-NodeRED-Kalender/${VERSION}`,
                    "Accept": "application/json"
                },
                timeout: 15000
            }, res => {
                if ((res.statusCode || 0) !== 200) {
                    res.resume();
                    return reject(new Error(`Nager.Date HTTP ${res.statusCode || 0} für ${year}`));
                }
                res.setEncoding("utf8");
                let body = "";
                res.on("data", chunk => {
                    body += chunk;
                    if (body.length > 1024 * 1024) req.destroy(new Error("Nager.Date Antwort zu groß"));
                });
                res.on("end", () => {
                    try {
                        const data = JSON.parse(body);
                        if (!Array.isArray(data)) throw new Error("Antwort ist kein Array");
                        resolve(data);
                    } catch (err) {
                        reject(new Error(`Nager.Date JSON ${year}: ${err.message}`));
                    }
                });
            });
            req.on("timeout", () => req.destroy(new Error("Nager.Date Timeout")));
            req.on("error", reject);
        });
    }

    const heute = getLocalIsoDate();
    const dateParts = getLocalDateParts();
    const jahr = Number(heute.slice(0, 4));
    const wochentagNummer = getWeekdayNumber(heute);
    const istWochenende = wochentagNummer === 0 || wochentagNummer === 6;
    const wochenendeText = istWochenende ? "ja" : "nein";
    const datum = `${dateParts.day}.${dateParts.month}.${dateParts.year}`;

    flow.set("istWochenende", istWochenende);
    flow.set("wochenendeText", wochenendeText);
    flow.set("wochentagNummer", wochentagNummer);
    flow.set("wochentagName", dateParts.weekday);
    flow.set("wochenendeLetztePruefung", new Date().toISOString());

    node.status({ fill: "blue", shape: "ring", text: "Feiertage Tirol werden geladen" });

    try {
        const [currentYear, nextYear] = await Promise.all([
            fetchYear(jahr),
            fetchYear(jahr + 1)
        ]);

        const holidays = [...currentYear, ...nextYear]
            .filter(isRelevantForTirol)
            .sort((a, b) => String(a.date).localeCompare(String(b.date)));

        if (!holidays.length) throw new Error("Keine Feiertage aus API erhalten");

        const heutigerFeiertag = holidays.find(h => h.date === heute) || null;
        const istFeiertag = Boolean(heutigerFeiertag);
        const naechsterFeiertag = holidays.find(h => h.date >= heute) || null;

        if (!naechsterFeiertag) throw new Error("Kein nächster Feiertag gefunden");

        const tageBis = daysBetween(heute, naechsterFeiertag.date);
        const naechsterFeiertagObjekt = {
            name: naechsterFeiertag.localName,
            nameEnglisch: naechsterFeiertag.name,
            datum: naechsterFeiertag.date,
            tageBis,
            global: naechsterFeiertag.global,
            counties: naechsterFeiertag.counties,
            types: naechsterFeiertag.types
        };

        flow.set("istFeiertagTirol", istFeiertag);
        flow.set("heutigerFeiertagTirol", istFeiertag ? heutigerFeiertag.localName : "");
        flow.set("tageBisNaechsterFeiertagTirol", tageBis);
        flow.set("naechsterFeiertagTirol", naechsterFeiertagObjekt);
        flow.set("naechsterFeiertagTirolName", naechsterFeiertag.localName);
        flow.set("naechsterFeiertagTirolDatum", naechsterFeiertag.date);

        msg.topic = "kalender-tirol";
        msg.payload = {
            datum,
            heute,
            timezone: TIMEZONE,
            wochentagName: dateParts.weekday,
            wochentagNummer,
            istWochenende,
            wochenende: wochenendeText,
            istFeiertagTirol: istFeiertag,
            heutigerFeiertagTirol: istFeiertag ? heutigerFeiertag.localName : "",
            naechsterFeiertagTirol: naechsterFeiertag.localName,
            datumNaechsterFeiertagTirol: naechsterFeiertag.date,
            tageBisNaechsterFeiertagTirol: tageBis,
            remote_function_version: VERSION,
            source: "Nager.Date"
        };

        let statusText;
        if (istFeiertag) statusText = `Feiertag: ${heutigerFeiertag.localName}`;
        else if (istWochenende) statusText = `Wochenende · nächster Feiertag in ${tageBis} Tagen`;
        else statusText = `Nächster: ${naechsterFeiertag.localName} in ${tageBis} Tagen`;

        node.status({ fill: istFeiertag || istWochenende ? "green" : "blue", shape: "dot", text: statusText });
        return msg;
    } catch (err) {
        flow.set("istFeiertagTirol", false);
        flow.set("heutigerFeiertagTirol", "");
        flow.set("tageBisNaechsterFeiertagTirol", null);
        flow.set("naechsterFeiertagTirol", null);
        flow.set("naechsterFeiertagTirolName", "");
        flow.set("naechsterFeiertagTirolDatum", "");

        node.status({ fill: "red", shape: "ring", text: err.message });
        node.error(err.message, msg);

        msg.topic = "kalender-tirol-fehler";
        msg.payload = {
            error: true,
            message: err.message,
            datum,
            heute,
            wochentagName: dateParts.weekday,
            wochentagNummer,
            istWochenende,
            wochenende: wochenendeText,
            remote_function_version: VERSION
        };
        return msg;
    }
};
