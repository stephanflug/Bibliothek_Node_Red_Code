"use strict";

module.exports = async function run(ctx) {
    const { msg, node, global, config } = ctx;

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const DEFAULT_TIMEZONE = "Europe/Vienna";

    function firstDefined(values) {
        for (const value of values) {
            if (value !== undefined && value !== null && String(value).trim() !== "") return value;
        }
        return undefined;
    }

    function toFinite(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function round(value, digits = 2) {
        if (!Number.isFinite(value)) return null;
        const f = 10 ** digits;
        return Math.round((value + Number.EPSILON) * f) / f;
    }

    function normalize360(value) {
        let v = value % 360;
        if (v < 0) v += 360;
        return v;
    }

    function zonedParts(date, timeZone) {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23"
        }).formatToParts(date);
        const out = {};
        for (const p of parts) {
            if (p.type !== "literal") out[p.type] = p.value;
        }
        return {
            year: Number(out.year),
            month: Number(out.month),
            day: Number(out.day),
            hour: Number(out.hour),
            minute: Number(out.minute),
            second: Number(out.second)
        };
    }

    function timezoneOffsetMinutes(date, timeZone) {
        try {
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone,
                timeZoneName: "shortOffset",
                hour: "2-digit"
            }).formatToParts(date);
            const name = (parts.find(p => p.type === "timeZoneName") || {}).value || "GMT";
            const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
            if (!m) return 0;
            const sign = m[1] === "+" ? 1 : -1;
            return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
        } catch (_) {
            return 0;
        }
    }

    function dayOfYear(y, m, d) {
        const start = Date.UTC(y, 0, 0);
        const current = Date.UTC(y, m - 1, d);
        return Math.floor((current - start) / 86400000);
    }

    function solarTerms(dayNumber, localMinutes) {
        const gamma = (2 * Math.PI / 365) * (dayNumber - 1 + (localMinutes / 60 - 12) / 24);
        const eqTime = 229.18 * (
            0.000075 +
            0.001868 * Math.cos(gamma) -
            0.032077 * Math.sin(gamma) -
            0.014615 * Math.cos(2 * gamma) -
            0.040849 * Math.sin(2 * gamma)
        );
        const decl =
            0.006918 -
            0.399912 * Math.cos(gamma) +
            0.070257 * Math.sin(gamma) -
            0.006758 * Math.cos(2 * gamma) +
            0.000907 * Math.sin(2 * gamma) -
            0.002697 * Math.cos(3 * gamma) +
            0.00148 * Math.sin(3 * gamma);
        return { eqTime, decl };
    }

    function solarPosition(date, latitude, longitude, timeZone) {
        const p = zonedParts(date, timeZone);
        const localMinutes = p.hour * 60 + p.minute + p.second / 60;
        const offset = timezoneOffsetMinutes(date, timeZone);
        const n = dayOfYear(p.year, p.month, p.day);
        const { eqTime, decl } = solarTerms(n, localMinutes);

        let trueSolarMinutes = localMinutes + eqTime + 4 * longitude - offset;
        trueSolarMinutes %= 1440;
        if (trueSolarMinutes < 0) trueSolarMinutes += 1440;

        let hourAngleDeg = trueSolarMinutes / 4 - 180;
        if (hourAngleDeg < -180) hourAngleDeg += 360;
        const hourAngle = hourAngleDeg * DEG;
        const lat = latitude * DEG;

        const cosZenith = Math.max(-1, Math.min(1,
            Math.sin(lat) * Math.sin(decl) +
            Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)
        ));
        const zenith = Math.acos(cosZenith);
        const elevation = 90 - zenith * RAD;

        const az = Math.atan2(
            Math.sin(hourAngle),
            Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)
        ) * RAD + 180;

        return {
            azimuthDegrees: normalize360(az),
            altitudeDegrees: elevation,
            declinationDegrees: decl * RAD,
            equationOfTimeMinutes: eqTime
        };
    }

    function localMinutesToDate(parts, minutes, offsetMinutes) {
        const baseUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
        return new Date(baseUtc - offsetMinutes * 60000 + minutes * 60000);
    }

    function eventTimes(date, latitude, longitude, timeZone) {
        const p = zonedParts(date, timeZone);
        const noonReference = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
        const offset = timezoneOffsetMinutes(noonReference, timeZone);
        const n = dayOfYear(p.year, p.month, p.day);
        const { eqTime, decl } = solarTerms(n, 12 * 60);
        const lat = latitude * DEG;
        const zenith = 90.833 * DEG;

        const cosH = (Math.cos(zenith) / (Math.cos(lat) * Math.cos(decl))) - Math.tan(lat) * Math.tan(decl);
        const solarNoonMinutes = 720 - 4 * longitude - eqTime + offset;

        if (cosH > 1 || cosH < -1) {
            return {
                sunrise: null,
                sunset: null,
                solarNoon: localMinutesToDate(p, solarNoonMinutes, offset)
            };
        }

        const hourAngle = Math.acos(cosH) * RAD;
        return {
            sunrise: localMinutesToDate(p, solarNoonMinutes - hourAngle * 4, offset),
            sunset: localMinutesToDate(p, solarNoonMinutes + hourAngle * 4, offset),
            solarNoon: localMinutesToDate(p, solarNoonMinutes, offset)
        };
    }

    function timeValue(date, timeZone) {
        if (!date) return null;
        return new Intl.DateTimeFormat("de-AT", {
            timeZone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }).format(date);
    }

    const latitude = toFinite(firstDefined([
        config && config.latitude,
        msg.latitude,
        msg.lat,
        global.get("sun_latitude"),
        global.get("latitude")
    ]));
    const longitude = toFinite(firstDefined([
        config && config.longitude,
        msg.longitude,
        msg.lon,
        global.get("sun_longitude"),
        global.get("longitude")
    ]));
    const timeZone = String(firstDefined([
        config && config.timeZone,
        msg.timeZone,
        global.get("sun_timezone"),
        DEFAULT_TIMEZONE
    ]));

    if (latitude === null || latitude < -90 || latitude > 90) {
        throw new Error("Sonnenstand: gültige latitude (-90 bis 90) fehlt");
    }
    if (longitude === null || longitude < -180 || longitude > 180) {
        throw new Error("Sonnenstand: gültige longitude (-180 bis 180) fehlt");
    }

    const now = msg.timestamp ? new Date(msg.timestamp) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error("Sonnenstand: ungültiger Zeitstempel");

    const pos = solarPosition(now, latitude, longitude, timeZone);
    const times = eventTimes(now, latitude, longitude, timeZone);

    const azimuth = round(pos.azimuthDegrees, 2);
    const altitude = round(pos.altitudeDegrees, 2);
    const sunrise = timeValue(times.sunrise, timeZone);
    const sunset = timeValue(times.sunset, timeZone);
    const solarNoon = timeValue(times.solarNoon, timeZone);

    global.set("Sonnenwinkel", azimuth);
    global.set("Sonnenhoehe", altitude);
    global.set("Sonnenaufgang", sunrise);
    global.set("Sonnenuntergang", sunset);
    global.set("Sonnenmittag", solarNoon);

    msg.topic = "sonnenstand";
    msg.payload = {
        azimuthDegrees: azimuth,
        altitudeDegrees: altitude,
        latitude,
        longitude,
        timeZone,
        isDay: altitude > -0.833,
        times: {
            sunrise: {
                value: sunrise,
                iso: times.sunrise ? times.sunrise.toISOString() : null
            },
            night: {
                value: sunset,
                iso: times.sunset ? times.sunset.toISOString() : null
            },
            sunset: {
                value: sunset,
                iso: times.sunset ? times.sunset.toISOString() : null
            },
            solarNoon: {
                value: solarNoon,
                iso: times.solarNoon ? times.solarNoon.toISOString() : null
            }
        },
        calculated_at: now.toISOString()
    };

    node.status({
        fill: altitude > -0.833 ? "yellow" : "blue",
        shape: "dot",
        text: `Azimut ${azimuth}° · Höhe ${altitude}°`
    });

    return msg;
};
