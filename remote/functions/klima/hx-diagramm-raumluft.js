"use strict";

module.exports = async function run(ctx) {
    const { msg, node, flow, global, config = {} } = ctx;

    const VERSION = "1.0.0";

    const pressureHpaDefault = Number(config.pressureHpa || 1013.25);
    const comfortTempMinC = Number(config.comfortTempMinC ?? 20);
    const comfortTempMaxC = Number(config.comfortTempMaxC ?? 26);
    const comfortRhMin = Number(config.comfortRhMin ?? 30);
    const comfortRhMax = Number(config.comfortRhMax ?? 60);
    const moldRoomRh = Number(config.moldRoomRh ?? 70);
    const moldSurfaceRh = Number(config.moldSurfaceRh ?? 80);

    function round(value, decimals = 2) {
        if (!Number.isFinite(value)) return null;
        const factor = Math.pow(10, decimals);
        return Math.round((value + Number.EPSILON) * factor) / factor;
    }

    function getByPath(obj, path) {
        const parts = String(path).split(".");
        let cur = obj;
        for (const part of parts) {
            if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
            cur = cur[part];
        }
        return cur;
    }

    function firstValue(obj, paths) {
        for (const path of paths) {
            const value = getByPath(obj, path);
            if (value !== undefined && value !== null && value !== "") return value;
        }
        return undefined;
    }

    function asNumber(value) {
        if (typeof value === "string") value = value.replace(",", ".").trim();
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function firstNumber(obj, paths) {
        return asNumber(firstValue(obj, paths));
    }

    function saturationVaporPressureHpa(tC) {
        // Magnus-Formel, ausreichend genau für typische HLK-/Raumluftanwendungen.
        const a = tC >= 0 ? 17.62 : 22.46;
        const b = tC >= 0 ? 243.12 : 272.62;
        return 6.112 * Math.exp((a * tC) / (b + tC));
    }

    function temperatureFromSaturationPressureHpa(pHpa) {
        if (!(pHpa > 0)) return null;
        const ln = Math.log(pHpa / 6.112);
        // Für normale Innenraum-/HLK-Bereiche genügt die Wasser-Parametrisierung.
        return (243.12 * ln) / (17.62 - ln);
    }

    function dewPointC(tC, rh) {
        if (!(rh > 0 && rh <= 100)) return null;
        const a = 17.62;
        const b = 243.12;
        const gamma = Math.log(rh / 100) + (a * tC) / (b + tC);
        return (b * gamma) / (a - gamma);
    }

    function wetBulbApproxC(tC, rh) {
        // Stull-Näherung für meteorologische/HLK-Auswertung.
        if (!(rh >= 5 && rh <= 99) || !(tC >= -20 && tC <= 50)) return null;
        return tC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659))
            + Math.atan(tC + rh)
            - Math.atan(rh - 1.676331)
            + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh)
            - 4.686035;
    }

    function parseInput(payload) {
        if (Array.isArray(payload)) {
            if (payload.length < 2) throw new Error("Array-Eingang benötigt [Temperatur, relative Feuchte].");
            return {
                temperatureC: asNumber(payload[0]),
                relativeHumidity: asNumber(payload[1]),
                pressureHpa: payload.length > 2 ? asNumber(payload[2]) : null,
                surfaceTemperatureC: payload.length > 3 ? asNumber(payload[3]) : null
            };
        }

        if (!payload || typeof payload !== "object") {
            throw new Error("msg.payload muss Temperatur und relative Feuchte als Objekt oder Array enthalten.");
        }

        return {
            temperatureC: firstNumber(payload, [
                "temperatureC", "temperature", "temp", "temperaturC", "temperatur", "t", "Temp", "Temperature"
            ]),
            relativeHumidity: firstNumber(payload, [
                "relativeHumidity", "relativeHumidityPercent", "humidity", "rh", "feuchte", "relativeFeuchte", "relFeuchte", "Humidity"
            ]),
            pressureHpa: firstNumber(payload, [
                "pressureHpa", "airPressureHpa", "pressure", "luftdruckHpa", "luftdruck"
            ]),
            surfaceTemperatureC: firstNumber(payload, [
                "surfaceTemperatureC", "surfaceTempC", "oberflaechenTemperaturC", "oberflaechentemperaturC", "surfaceTemperature"
            ])
        };
    }

    try {
        const input = parseInput(msg.payload);
        const tC = input.temperatureC;
        const rh = input.relativeHumidity;
        const pressureHpa = input.pressureHpa && input.pressureHpa > 100 ? input.pressureHpa : pressureHpaDefault;
        const surfaceTempC = input.surfaceTemperatureC;

        if (!Number.isFinite(tC) || tC < -80 || tC > 100) {
            throw new Error("Keine gültige Temperatur gefunden. Erwartet wird ein Wert in °C.");
        }
        if (!Number.isFinite(rh) || rh < 0 || rh > 100) {
            throw new Error("Keine gültige relative Feuchte gefunden. Erwartet werden 0 bis 100 %.");
        }
        if (!Number.isFinite(pressureHpa) || pressureHpa <= 0) {
            throw new Error("Ungültiger Luftdruck.");
        }

        const saturationHpa = saturationVaporPressureHpa(tC);
        const vaporHpa = saturationHpa * rh / 100;
        const pressurePa = pressureHpa * 100;
        const vaporPa = vaporHpa * 100;
        const dryAirPa = pressurePa - vaporPa;

        if (dryAirPa <= 0) throw new Error("Luftdruck ist für den berechneten Wasserdampfdruck zu niedrig.");

        const humidityRatioKgKg = 0.62198 * vaporHpa / (pressureHpa - vaporHpa);
        const humidityRatioGKg = humidityRatioKgKg * 1000;
        const enthalpyKJkg = 1.006 * tC + humidityRatioKgKg * (2501 + 1.86 * tC);
        const absoluteHumidityGM3 = 216.7 * vaporHpa / (tC + 273.15);
        const dewC = dewPointC(tC, Math.max(rh, 0.0001));
        const dewPointSpreadK = dewC === null ? null : tC - dewC;
        const wetBulbC = wetBulbApproxC(tC, rh);

        const tK = tC + 273.15;
        const rhoDry = dryAirPa / (287.058 * tK);
        const rhoVapor = vaporPa / (461.495 * tK);
        const densityKgM3 = rhoDry + rhoVapor;
        const specificVolumeM3KgDryAir = 287.058 * tK / dryAirPa;

        const comfort = tC >= comfortTempMinC
            && tC <= comfortTempMaxC
            && rh >= comfortRhMin
            && rh <= comfortRhMax;

        let comfortReason = "Temperatur und relative Feuchte liegen im eingestellten Behaglichkeitsbereich.";
        if (!comfort) {
            const reasons = [];
            if (tC < comfortTempMinC) reasons.push("Temperatur zu niedrig");
            if (tC > comfortTempMaxC) reasons.push("Temperatur zu hoch");
            if (rh < comfortRhMin) reasons.push("Luft zu trocken");
            if (rh > comfortRhMax) reasons.push("Luft zu feucht");
            comfortReason = reasons.join(", ") || "außerhalb des Behaglichkeitsbereichs";
        }

        // Temperatur, bei der die vorhandene absolute Feuchte an einer Oberfläche
        // die eingestellte kritische Oberflächen-RF erreichen würde.
        const criticalSatPressureMold = vaporHpa / Math.max(0.01, moldSurfaceRh / 100);
        const criticalSurfaceTempMoldC = temperatureFromSaturationPressureHpa(criticalSatPressureMold);

        let surfaceRh = null;
        let condensationRisk = null;
        let moldRiskSurface = null;
        if (Number.isFinite(surfaceTempC)) {
            const satSurface = saturationVaporPressureHpa(surfaceTempC);
            surfaceRh = satSurface > 0 ? (vaporHpa / satSurface) * 100 : null;
            if (surfaceRh !== null) surfaceRh = Math.min(999, surfaceRh);
            condensationRisk = dewC !== null ? surfaceTempC <= dewC : null;
            moldRiskSurface = surfaceRh !== null ? surfaceRh >= moldSurfaceRh : null;
        }

        // Ohne Oberflächentemperatur ist dies eine Raumluft-Screeningbewertung.
        // Mit Oberflächentemperatur wird zusätzlich die Oberflächen-RF berücksichtigt.
        const moldRiskRoom = rh >= moldRoomRh;
        const moldRisk = moldRiskRoom || moldRiskSurface === true;

        let moldReason;
        if (moldRiskSurface === true) {
            moldReason = `Oberflächenfeuchte >= ${moldSurfaceRh} % rF`;
        } else if (moldRiskRoom) {
            moldReason = `Raumluftfeuchte >= ${moldRoomRh} % rF`;
        } else if (Number.isFinite(surfaceTempC)) {
            moldReason = "Keine Schimmelwarnung nach den eingestellten Grenzwerten.";
        } else {
            moldReason = "Keine Schimmelwarnung aus der Raumluftfeuchte; ohne Oberflächentemperatur ist die Bauteilbewertung nur eingeschränkt möglich.";
        }

        const result = {
            temperatureC: round(tC, 2),
            relativeHumidityPercent: round(rh, 2),
            pressureHpa: round(pressureHpa, 2),

            saturationVaporPressureHpa: round(saturationHpa, 3),
            vaporPressureHpa: round(vaporHpa, 3),
            humidityRatioGKg: round(humidityRatioGKg, 3),
            humidityRatioKgKg: round(humidityRatioKgKg, 6),
            absoluteHumidityGM3: round(absoluteHumidityGM3, 3),
            enthalpyKJkg: round(enthalpyKJkg, 3),
            dewPointC: round(dewC, 2),
            dewPointSpreadK: round(dewPointSpreadK, 2),
            wetBulbC: round(wetBulbC, 2),
            densityKgM3: round(densityKgM3, 4),
            specificVolumeM3KgDryAir: round(specificVolumeM3KgDryAir, 4),

            comfort,
            behaglichkeitsbereich: comfort,
            comfortReason,
            comfortLimits: {
                temperatureMinC: comfortTempMinC,
                temperatureMaxC: comfortTempMaxC,
                relativeHumidityMinPercent: comfortRhMin,
                relativeHumidityMaxPercent: comfortRhMax
            },

            moldRisk,
            schimmelGefahr: moldRisk,
            moldRiskRoom,
            moldRiskSurface,
            moldReason,
            moldLimits: {
                roomRelativeHumidityPercent: moldRoomRh,
                surfaceRelativeHumidityPercent: moldSurfaceRh
            },

            criticalSurfaceTempMoldC: round(criticalSurfaceTempMoldC, 2),
            criticalSurfaceTempCondensationC: round(dewC, 2),
            surfaceTemperatureC: Number.isFinite(surfaceTempC) ? round(surfaceTempC, 2) : null,
            surfaceRelativeHumidityPercent: round(surfaceRh, 2),
            condensationRisk,

            remote_function_version: VERSION
        };

        const values = {
            hx_Temperatur_C: result.temperatureC,
            hx_RelFeuchte_pct: result.relativeHumidityPercent,
            hx_Luftdruck_hPa: result.pressureHpa,
            hx_x_gkg: result.humidityRatioGKg,
            hx_AbsoluteFeuchte_gm3: result.absoluteHumidityGM3,
            hx_Enthalpie_kJkg: result.enthalpyKJkg,
            hx_Taupunkt_C: result.dewPointC,
            hx_Taupunktabstand_K: result.dewPointSpreadK,
            hx_Feuchtkugel_C: result.wetBulbC,
            hx_Luftdichte_kgm3: result.densityKgM3,
            hx_Behaglich: result.comfort,
            hx_Schimmelgefahr: result.moldRisk,
            hx_KritischeOberflaeche_Schimmel_C: result.criticalSurfaceTempMoldC,
            hx_KritischeOberflaeche_Kondensation_C: result.criticalSurfaceTempCondensationC,
            hx_Oberflaechenfeuchte_pct: result.surfaceRelativeHumidityPercent,
            hx_Kondensationsgefahr: result.condensationRisk
        };

        for (const [key, value] of Object.entries(values)) {
            flow.set(key, value);
            if (global && typeof global.set === "function") global.set(key, value);
        }

        msg.payload = result;

        node.status({
            fill: moldRisk ? "red" : (comfort ? "green" : "yellow"),
            shape: "dot",
            text: `${round(tC, 1)} °C | ${round(rh, 0)} % | Tau ${round(dewC, 1)} °C`
        });

        return msg;
    } catch (err) {
        msg.payload = {
            error: true,
            message: err.message || String(err),
            remote_function_version: VERSION
        };
        node.status({ fill: "red", shape: "ring", text: "h-x Eingang ungültig" });
        return msg;
    }
};
