"use strict";

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

    const CFG = {
        lat: n(config.latitude, 47.2794663),
        lon: n(config.longitude, 10.7662632),
        azStart: n(config.azStart, 90),
        azEnd: n(config.azEnd, 152),
        minAltDeg: n(config.minAltDeg, 15),
        preMinutes: n(config.preMinutes, 180),
        preMinutesWolkenlosSommer: n(config.preMinutesWolkenlosSommer, 180),
        summerMonths: {
            start: n(config.summerMonthStart, 6),
            end: n(config.summerMonthEnd, 8)
        },
        weatherGate: {
            allowRegexText: String(config.weatherAllowRegex || "^(?:wolkenlos|sonnig|sonne|leicht[\\s-]+(?:bewölkt|bedeckt))$"),
            blockRegexText: String(config.weatherBlockRegex || "niederschlag|regen|schauer|gewitter|stark[\\s-]+bewölkt|stark[\\s-]+bewoelkt"),
            allowIfUnknown: b(config.allowIfUnknown, false)
        },
        scanStepMin: Math.max(1, n(config.scanStepMin, 1)),
        timeZone: String(config.timeZone || "Europe/Vienna"),
        ioBroker: {
            azimuthDegId: "0_userdata.0.Sonne.azimuthDeg",
            firstHitTimeId: "0_userdata.0.Sonne.firstHitTime"
        }
    };

    if (CFG.lat < -90 || CFG.lat > 90) throw new Error("Sonne trifft Haus: Breitengrad muss zwischen -90 und 90 liegen");
    if (CFG.lon < -180 || CFG.lon > 180) throw new Error("Sonne trifft Haus: Längengrad muss zwischen -180 und 180 liegen");

    let allowRegex;
    let blockRegex;
    try {
        allowRegex = new RegExp(CFG.weatherGate.allowRegexText, "i");
    } catch (err) {
        throw new Error("Sonne trifft Haus: ungültiger Wetter-Freigabe-RegEx: " + err.message);
    }
    try {
        blockRegex = CFG.weatherGate.blockRegexText ? new RegExp(CFG.weatherGate.blockRegexText, "i") : null;
    } catch (err) {
        throw new Error("Sonne trifft Haus: ungültiger Wetter-Block-RegEx: " + err.message);
    }

    function deg2rad(d) { return d * Math.PI / 180; }
    function rad2deg(r) { return r * 180 / Math.PI; }
    function normalize360(d) { d %= 360; return d < 0 ? d + 360 : d; }
    function isFiniteNumber(x) { return typeof x === "number" && Number.isFinite(x); }

    function azInRange(az, start, end) {
        az = normalize360(az);
        start = normalize360(start);
        end = normalize360(end);
        if (start <= end) return az >= start && az <= end;
        return az >= start || az <= end;
    }

    function monthInRange(month, start, end) {
        month = Number(month);
        start = Number(start);
        end = Number(end);
        if (!Number.isFinite(month) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
        if (start <= end) return month >= start && month <= end;
        return month >= start || month <= end;
    }

    function julianDay(date) {
        return (date.getTime() / 86400000) + 2440587.5;
    }

    function solarPosition(date, latDeg, lonDeg) {
        const jd = julianDay(date);
        const T = (jd - 2451545.0) / 36525.0;
        const L0 = normalize360(280.46646 + T * (36000.76983 + T * 0.0003032));
        const M = normalize360(357.52911 + T * (35999.05029 - 0.0001537 * T));
        const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
        const Mrad = deg2rad(M);
        const C = (
            Math.sin(Mrad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
            Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T) +
            Math.sin(3 * Mrad) * 0.000289
        );
        const trueLong = L0 + C;
        const omega = 125.04 - 1934.136 * T;
        const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(deg2rad(omega));
        const epsilon0 = 23 + (26 + ((21.448 - T * (46.815 + T * (0.00059 - T * 0.001813)))) / 60) / 60;
        const epsilon = epsilon0 + 0.00256 * Math.cos(deg2rad(omega));
        const sinDec = Math.sin(deg2rad(epsilon)) * Math.sin(deg2rad(lambda));
        const dec = Math.asin(sinDec);
        const y = Math.tan(deg2rad(epsilon) / 2);
        const y2 = y * y;
        const L0rad = deg2rad(L0);
        const eqTime = 4 * rad2deg(
            y2 * Math.sin(2 * L0rad) -
            2 * e * Math.sin(Mrad) +
            4 * e * y2 * Math.sin(Mrad) * Math.cos(2 * L0rad) -
            0.5 * y2 * y2 * Math.sin(4 * L0rad) -
            1.25 * e * e * Math.sin(2 * Mrad)
        );

        const minutesUTC = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
        let trueSolarTime = minutesUTC + eqTime + 4 * lonDeg;
        trueSolarTime = ((trueSolarTime % 1440) + 1440) % 1440;
        let hourAngle = trueSolarTime / 4 - 180;
        if (hourAngle < -180) hourAngle += 360;
        const ha = deg2rad(hourAngle);
        const lat = deg2rad(latDeg);
        const cosZen = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
        const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
        const elevation = 90 - rad2deg(zen);
        const azimuth = normalize360(
            rad2deg(Math.atan2(
                Math.sin(ha),
                Math.cos(ha) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)
            )) + 180
        );
        return { azimuth, elevation };
    }

    function fmtMs(ms) {
        if (ms === null || ms === undefined) return null;
        const sign = ms < 0 ? "-" : "";
        ms = Math.abs(ms);
        const totalMin = Math.floor(ms / 60000);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        return `${sign}${h}h ${String(m).padStart(2, "0")}m`;
    }

    function getTZParts(date, tz) {
        const dtf = new Intl.DateTimeFormat("sv-SE", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        });
        const s = dtf.format(date);
        const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(s);
        if (!m) {
            const nums = (s.match(/\d+/g) || []).map(Number);
            return { year: nums[0], month: nums[1], day: nums[2], hour: nums[3], minute: nums[4], second: nums[5] };
        }
        return {
            year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
            hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6])
        };
    }

    function tzOffsetMinutes(date, tz) {
        const p = getTZParts(date, tz);
        const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        return (asUTC - date.getTime()) / 60000;
    }

    function localDateTimeToEpochMs(y, m, d, hh, mm, ss, tz) {
        const utcGuess = Date.UTC(y, m - 1, d, hh, mm, ss);
        let t = utcGuess;
        for (let i = 0; i < 4; i++) {
            const off = tzOffsetMinutes(new Date(t), tz);
            const t2 = utcGuess - off * 60000;
            if (Math.abs(t2 - t) < 1000) { t = t2; break; }
            t = t2;
        }
        return t;
    }

    function startOfDayInTZ(nowMs, tz) {
        const p = getTZParts(new Date(nowMs), tz);
        return localDateTimeToEpochMs(p.year, p.month, p.day, 0, 0, 0, tz);
    }

    function startOfNextDayInTZ(dayStartMs, tz) {
        const p = getTZParts(new Date(dayStartMs + 36 * 3600000), tz);
        return localDateTimeToEpochMs(p.year, p.month, p.day, 0, 0, 0, tz);
    }

    function ymdInTZFromMs(ms, tz) {
        return new Date(ms).toLocaleDateString("sv-SE", { timeZone: tz });
    }

    const TZ = CFG.timeZone;
    const now = msg.timestamp ? new Date(msg.timestamp) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error("Sonne trifft Haus: ungültiger msg.timestamp");
    const nowTs = now.getTime();
    const todayKey = ymdInTZFromMs(nowTs, TZ);
    const nowTzParts = getTZParts(now, TZ);

    const wzRaw = global.get("wettervorhersage");
    const wzStr = String(wzRaw || "").trim();
    const rain = Number(global.get("wetter_rain"));
    const sunW = Number(global.get("wetter_sun"));
    const haveAnyWeather = wzStr !== "";

    let sunOk = false;
    let weatherReason = "";
    if (!haveAnyWeather) {
        sunOk = CFG.weatherGate.allowIfUnknown;
        weatherReason = `wettervorhersage fehlt/leer → allowIfUnknown=${CFG.weatherGate.allowIfUnknown}`;
    } else if (blockRegex && blockRegex.test(wzStr)) {
        sunOk = false;
        weatherReason = `wettervorhersage blockiert: ${wzStr}`;
    } else if (allowRegex.test(wzStr)) {
        sunOk = true;
        weatherReason = `wettervorhersage erlaubt: ${wzStr}`;
    } else {
        sunOk = false;
        weatherReason = `wettervorhersage nicht erlaubt: ${wzStr}`;
    }

    const isSummer = monthInRange(nowTzParts.month, CFG.summerMonths.start, CFG.summerMonths.end);
    const isWolkenlos = /^wolkenlos$/i.test(wzStr);
    const effectivePreMinutes = isSummer && isWolkenlos
        ? CFG.preMinutesWolkenlosSommer
        : CFG.preMinutes;
    const preMinutesReason = isSummer && isWolkenlos
        ? `Sommer und wolkenlos → ${CFG.preMinutesWolkenlosSommer} Minuten Vorwarnzeit`
        : `Standard → ${CFG.preMinutes} Minuten Vorwarnzeit`;

    const cfgSig = JSON.stringify({
        lat: CFG.lat,
        lon: CFG.lon,
        azStart: CFG.azStart,
        azEnd: CFG.azEnd,
        minAltDeg: CFG.minAltDeg,
        preMinutes: effectivePreMinutes,
        scanStepMin: CFG.scanStepMin,
        timeZone: CFG.timeZone
    });

    const key = name => `ebstSunHouse_${node.id}_${name}`;
    const storedDay = flow.get(key("firstHitDay"));
    const storedSig = flow.get(key("firstHitCfgSig"));
    const cfgChanged = storedSig !== cfgSig;
    const cachedFirstHitTs = flow.get(key("firstHitTs"));
    const cachedFirstHitPreTs = flow.get(key("firstHitPreTs"));
    const cachedDiag = flow.get(key("firstHitDiag"));
    const cacheIncomplete = cachedFirstHitTs == null || cachedFirstHitPreTs == null || cachedDiag == null;

    const forceRecalc =
        msg.topic === "recalc" ||
        msg.force === true ||
        storedDay !== todayKey ||
        cfgChanged ||
        cacheIncomplete;

    let recalcDone = false;

    if (forceRecalc) {
        let dayStartMs = startOfDayInTZ(nowTs, TZ);
        let nextDayStartMs = startOfNextDayInTZ(dayStartMs, TZ);

        if (!isFiniteNumber(dayStartMs) || !isFiniteNumber(nextDayStartMs) || nextDayStartMs <= dayStartMs) {
            const p = getTZParts(new Date(nowTs), TZ);
            dayStartMs = localDateTimeToEpochMs(p.year, p.month, p.day, 0, 0, 0, TZ);
            nextDayStartMs = localDateTimeToEpochMs(p.year, p.month, p.day + 1, 0, 0, 0, TZ);
        }

        let firstHitTsCalc = null;
        let firstAzInRangeTsCalc = null;
        let firstMinAltTsCalc = null;
        let maxAltInAzRange = -999;
        let maxAltInAzRangeTs = null;
        let maxAltAllDay = -999;
        let maxAltAllDayTs = null;

        const stepMs = CFG.scanStepMin * 60000;
        const plannedIterations = isFiniteNumber(dayStartMs) && isFiniteNumber(nextDayStartMs)
            ? Math.max(0, Math.floor((nextDayStartMs - dayStartMs) / stepMs))
            : 0;
        let iterationsDone = 0;

        for (let tMs = dayStartMs; isFiniteNumber(tMs) && isFiniteNumber(nextDayStartMs) && tMs < nextDayStartMs; tMs += stepMs) {
            iterationsDone++;
            const pos = solarPosition(new Date(tMs), CFG.lat, CFG.lon);

            if (pos.elevation > 0 && pos.elevation > maxAltAllDay) {
                maxAltAllDay = pos.elevation;
                maxAltAllDayTs = tMs;
            }

            if (pos.elevation > 0 && azInRange(pos.azimuth, CFG.azStart, CFG.azEnd)) {
                if (firstAzInRangeTsCalc === null) firstAzInRangeTsCalc = tMs;
                if (pos.elevation > maxAltInAzRange) {
                    maxAltInAzRange = pos.elevation;
                    maxAltInAzRangeTs = tMs;
                }
            }

            if (pos.elevation > 0 && pos.elevation >= CFG.minAltDeg && firstMinAltTsCalc === null) {
                firstMinAltTsCalc = tMs;
            }

            if (
                firstHitTsCalc === null &&
                pos.elevation > 0 &&
                pos.elevation >= CFG.minAltDeg &&
                azInRange(pos.azimuth, CFG.azStart, CFG.azEnd)
            ) {
                firstHitTsCalc = tMs;
            }
        }

        const preMs = effectivePreMinutes * 60000;
        const firstHitPreTsCalc = firstHitTsCalc ? firstHitTsCalc - preMs : null;

        flow.set(key("firstHitDay"), todayKey);
        flow.set(key("firstHitCfgSig"), cfgSig);
        flow.set(key("firstHitTs"), firstHitTsCalc);
        flow.set(key("firstHitPreTs"), firstHitPreTsCalc);
        flow.set(key("firstHitDiag"), {
            dayStartMs,
            nextDayStartMs,
            dayStartLocal: isFiniteNumber(dayStartMs) ? new Date(dayStartMs).toLocaleString("de-AT", { timeZone: TZ }) : null,
            nextDayStartLocal: isFiniteNumber(nextDayStartMs) ? new Date(nextDayStartMs).toLocaleString("de-AT", { timeZone: TZ }) : null,
            stepMs,
            plannedIterations,
            iterationsDone,
            firstAzInRangeTs: firstAzInRangeTsCalc,
            firstMinAltTs: firstMinAltTsCalc,
            maxAltInAzRange,
            maxAltInAzRangeTs,
            maxAltAllDay,
            maxAltAllDayTs
        });
        recalcDone = true;
    }

    const firstHitTs = flow.get(key("firstHitTs"));
    const firstHitPreTs = firstHitTs ? firstHitTs - effectivePreMinutes * 60000 : null;
    flow.set(key("firstHitPreTs"), firstHitPreTs);

    const nowPos = solarPosition(now, CFG.lat, CFG.lon);
    const sunAltNow = nowPos.elevation;
    const sunAzNow = nowPos.azimuth;
    const firstHitDay = flow.get(key("firstHitDay"));
    const firstHitDiag = flow.get(key("firstHitDiag")) || null;

    let active = false;
    let reason = "";
    if (firstHitDay !== todayKey) {
        reason = `Cache-Tag passt nicht: firstHitDay=${firstHitDay} todayKey=${todayKey}`;
    } else if (!sunOk) {
        reason = `Wetter-Gate: FALSE (${weatherReason})`;
    } else if (firstHitTs == null || firstHitPreTs == null) {
        if (firstHitDiag && isFiniteNumber(firstHitDiag.maxAltInAzRange) && firstHitDiag.maxAltInAzRange > -900) {
            reason = `keine Erstbesonnung: maxAlt im Az-Fenster=${Number(firstHitDiag.maxAltInAzRange).toFixed(2)}° (minAltDeg=${CFG.minAltDeg}°)`;
        } else {
            reason = "keine Erstbesonnung gefunden (Azimutfenster/Mindesthöhe prüfen)";
        }
    } else if (nowTs >= firstHitPreTs && nowTs < firstHitTs) {
        active = true;
        reason = "im Vorwarnfenster";
    } else {
        reason = "außerhalb Vorwarnfenster";
    }

    const msg1 = { ...msg, payload: active };
    const msg2 = {
        topic: "sun-house-debug",
        payload: {
            timestamp: nowTs,
            nowLocal: now.toLocaleString("de-AT", { timeZone: TZ }),
            tz: TZ,
            recalcDone,
            stored: { firstHitDay, todayKey, cfgChanged, cacheIncomplete },
            config: {
                lat: CFG.lat,
                lon: CFG.lon,
                azStart: CFG.azStart,
                azEnd: CFG.azEnd,
                minAltDeg: CFG.minAltDeg,
                preMinutes: effectivePreMinutes,
                preMinutesDefault: CFG.preMinutes,
                preMinutesWolkenlosSommer: CFG.preMinutesWolkenlosSommer,
                preMinutesReason,
                summerMonths: CFG.summerMonths,
                isSummer,
                isWolkenlos,
                scanStepMin: CFG.scanStepMin,
                timeZone: CFG.timeZone,
                weatherGate: {
                    allowRegex: CFG.weatherGate.allowRegexText,
                    blockRegex: CFG.weatherGate.blockRegexText,
                    allowIfUnknown: CFG.weatherGate.allowIfUnknown
                }
            },
            sunNow: {
                azimuthDeg: Number(sunAzNow.toFixed(2)),
                elevationDeg: Number(sunAltNow.toFixed(2)),
                inAzRangeNow: azInRange(sunAzNow, CFG.azStart, CFG.azEnd),
                aboveMinAltNow: sunAltNow >= CFG.minAltDeg
            },
            firstHit: {
                firstHitTs: firstHitTs ?? null,
                firstHitLocal: firstHitTs ? new Date(firstHitTs).toLocaleString("de-AT", { timeZone: TZ }) : null,
                firstHitPreTs: firstHitPreTs ?? null,
                firstHitPreLocal: firstHitPreTs ? new Date(firstHitPreTs).toLocaleString("de-AT", { timeZone: TZ }) : null,
                timeUntilFirstHit: firstHitTs ? fmtMs(firstHitTs - nowTs) : null,
                timeUntilPreWindow: firstHitPreTs ? fmtMs(firstHitPreTs - nowTs) : null,
                isInPreWindow: !!(firstHitPreTs && firstHitTs && nowTs >= firstHitPreTs && nowTs < firstHitTs)
            },
            firstHitDiag: firstHitDiag ? {
                ...firstHitDiag,
                firstAzInRangeLocal: firstHitDiag.firstAzInRangeTs ? new Date(firstHitDiag.firstAzInRangeTs).toLocaleString("de-AT", { timeZone: TZ }) : null,
                firstMinAltLocal: firstHitDiag.firstMinAltTs ? new Date(firstHitDiag.firstMinAltTs).toLocaleString("de-AT", { timeZone: TZ }) : null,
                maxAltInAzRangeLocal: firstHitDiag.maxAltInAzRangeTs ? new Date(firstHitDiag.maxAltInAzRangeTs).toLocaleString("de-AT", { timeZone: TZ }) : null,
                maxAltAllDayLocal: firstHitDiag.maxAltAllDayTs ? new Date(firstHitDiag.maxAltAllDayTs).toLocaleString("de-AT", { timeZone: TZ }) : null
            } : null,
            weather: {
                haveAnyWeather,
                wettervorhersage: wzStr || null,
                wetter_rain_mm: Number.isFinite(rain) ? rain : null,
                wetter_sun_Wm2: Number.isFinite(sunW) ? sunW : null,
                sunOk,
                weatherReason,
                isSummer,
                isWolkenlos,
                effectivePreMinutes,
                preMinutesReason
            },
            result: { active, reason }
        }
    };

    const msg3 = {
        topic: CFG.ioBroker.azimuthDegId,
        payload: Number(normalize360(sunAzNow).toFixed(2))
    };

    const msg4 = {
        topic: CFG.ioBroker.firstHitTimeId,
        payload: firstHitTs
            ? new Date(firstHitTs).toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: TZ })
            : null
    };

    node.status({
        fill: active ? "yellow" : (sunOk ? "green" : "grey"),
        shape: active ? "dot" : "ring",
        text: active ? "Vorwarnung aktiv" : `Az ${Number(sunAzNow.toFixed(1))}° · ${reason}`
    });

    return [msg1, msg2, msg3, msg4];
};
