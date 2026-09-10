"use strict";

module.exports = async function run(ctx) {
    const { msg, node, flow, global, RED, config = {} } = ctx;

    const VERSION = "1.0.0";
    const TIMEZONE = "Europe/Vienna";

    const targetDefaultC = numberOr(config.targetTemperatureC, 22);
    const powerMode = String(config.powerMode || "auto").toLowerCase();
    const genericPowerUnit = String(config.payloadPowerUnit || "kW").toLowerCase();
    const fixedPowerKw = Math.max(0, numberOr(config.fixedPowerKw, 5));
    const configuredCapacity = Math.max(0, numberOr(config.thermalCapacityKwhPerK, 0));
    const minLearningMinutes = Math.max(1, numberOr(config.minLearningMinutes, 10));
    const minTempRiseK = Math.max(0.05, numberOr(config.minTempRiseK, 0.2));
    const measurementWindowMinutes = Math.max(minLearningMinutes, numberOr(config.measurementWindowMinutes, 60));
    const maxGapMinutes = Math.max(1, numberOr(config.maxGapMinutes, 30));
    const smoothingAlpha = clamp(numberOr(config.smoothingAlpha, 0.25), 0.01, 1);
    const targetToleranceK = Math.max(0, numberOr(config.targetToleranceK, 0.1));
    const persistMinSeconds = Math.max(0, numberOr(config.persistMinSeconds, 10));

    function numberOr(value, fallback) {
        if (typeof value === "string") value = value.replace(",", ".").trim();
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

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

    function firstNumber(obj, paths) {
        const value = firstValue(obj, paths);
        if (value === undefined) return null;
        return numberOr(value, null);
    }

    function parseBoolean(value) {
        if (typeof value === "boolean") return value;
        if (typeof value === "number") return value !== 0;
        if (typeof value === "string") {
            const s = value.trim().toLowerCase();
            if (["true", "1", "on", "ein", "ja", "yes", "active", "aktiv", "heating", "aufheizen"].includes(s)) return true;
            if (["false", "0", "off", "aus", "nein", "no", "inactive", "inaktiv", "standby"].includes(s)) return false;
        }
        return null;
    }

    function normalizeTimestamp(value) {
        if (value === undefined || value === null || value === "") return Date.now();
        if (typeof value === "number") {
            if (!Number.isFinite(value)) return Date.now();
            return value < 100000000000 ? value * 1000 : value;
        }
        const ms = Date.parse(String(value));
        return Number.isFinite(ms) ? ms : Date.now();
    }

    function localDateTime(date) {
        return new Intl.DateTimeFormat("de-AT", {
            timeZone: TIMEZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        }).format(date);
    }

    function parseInput(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("msg.payload muss ein Objekt mit Temperatur und Aufheizstatus enthalten.");
        }

        const temperatureC = firstNumber(payload, [
            "temperatureC", "temperature", "temp", "temperaturC", "temperatur",
            "currentTemperatureC", "currentTemperature", "aktuelleTemperaturC", "aktuelleTemperatur"
        ]);

        const heatingRaw = firstValue(payload, [
            "heating", "heatingActive", "isHeating", "aufheizung", "aufheizungAktiv",
            "aufheizen", "heizen", "heating.active"
        ]);
        const heatingActive = parseBoolean(heatingRaw);

        const targetTemperatureC = firstNumber(payload, [
            "targetTemperatureC", "targetTempC", "targetTemperature", "zielTemperaturC", "zieltemperaturC", "zieltemperatur"
        ]);

        let payloadPowerKw = firstNumber(payload, [
            "powerKw", "currentPowerKw", "heatingPowerKw", "leistungKw", "aktuelleLeistungKw",
            "power.kW", "leistung.kW"
        ]);

        if (!Number.isFinite(payloadPowerKw)) {
            const powerW = firstNumber(payload, [
                "powerW", "currentPowerW", "heatingPowerW", "leistungW", "aktuelleLeistungW",
                "power.W", "leistung.W"
            ]);
            if (Number.isFinite(powerW)) payloadPowerKw = powerW / 1000;
        }

        if (!Number.isFinite(payloadPowerKw)) {
            const genericPower = firstNumber(payload, ["power", "leistung", "aktuelleLeistung"]);
            if (Number.isFinite(genericPower)) {
                payloadPowerKw = genericPowerUnit === "w" ? genericPower / 1000 : genericPower;
            }
        }

        return {
            temperatureC,
            heatingActive,
            targetTemperatureC,
            payloadPowerKw,
            timestampMs: normalizeTimestamp(firstValue(payload, ["timestamp", "time", "ts", "updatedAt", "updated_at"]))
        };
    }

    const fs = require("fs");
    const path = require("path");
    const userDir = RED && RED.settings && RED.settings.userDir ? RED.settings.userDir : process.cwd();
    const stateDir = path.join(userDir, ".ebst-remote-functions", "state");
    const stateFile = path.join(stateDir, "aufheizdauer-berechnung.json");

    function newState() {
        return {
            schema: 1,
            learnedThermalCapacityKwhPerK: null,
            learnedSamples: 0,
            lastTemperatureC: null,
            lastPowerKw: null,
            lastHeatingActive: false,
            lastTimestampMs: null,
            cycle: null,
            history: [],
            lastPersistMs: 0
        };
    }

    function loadState() {
        try {
            if (!fs.existsSync(stateFile)) return newState();
            const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            if (!parsed || typeof parsed !== "object") return newState();
            return Object.assign(newState(), parsed, {
                history: Array.isArray(parsed.history) ? parsed.history : []
            });
        } catch (err) {
            node.warn("Aufheizdauer: Persistenzdatei konnte nicht gelesen werden: " + err.message);
            return newState();
        }
    }

    function saveState(state, force = false) {
        const nowMs = Date.now();
        if (!force && persistMinSeconds > 0 && nowMs - Number(state.lastPersistMs || 0) < persistMinSeconds * 1000) return false;
        try {
            fs.mkdirSync(stateDir, { recursive: true });
            state.updatedAt = new Date(nowMs).toISOString();
            state.lastPersistMs = nowMs;
            const tmp = stateFile + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
            fs.renameSync(tmp, stateFile);
            return true;
        } catch (err) {
            node.warn("Aufheizdauer: Persistenzdatei konnte nicht gespeichert werden: " + err.message);
            return false;
        }
    }

    function resolvePower(payloadPowerKw) {
        if (powerMode === "fixed") {
            return { powerKw: fixedPowerKw > 0 ? fixedPowerKw : null, source: "fix" };
        }
        if (powerMode === "payload") {
            return { powerKw: Number.isFinite(payloadPowerKw) && payloadPowerKw >= 0 ? payloadPowerKw : null, source: "payload" };
        }
        if (Number.isFinite(payloadPowerKw) && payloadPowerKw >= 0) {
            return { powerKw: payloadPowerKw, source: "payload" };
        }
        return { powerKw: fixedPowerKw > 0 ? fixedPowerKw : null, source: "fix-fallback" };
    }

    function regressionRateKPerHour(history) {
        if (!Array.isArray(history) || history.length < 2) return null;
        const t0 = history[0].ts;
        const xs = history.map(s => (s.ts - t0) / 3600000);
        const ys = history.map(s => s.temp);
        const n = xs.length;
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        const my = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i += 1) {
            num += (xs[i] - mx) * (ys[i] - my);
            den += Math.pow(xs[i] - mx, 2);
        }
        if (den <= 0) return null;
        return num / den;
    }

    try {
        const input = parseInput(msg.payload);
        const temperatureC = input.temperatureC;
        const heatingActive = input.heatingActive;
        const targetTemperatureC = Number.isFinite(input.targetTemperatureC) ? input.targetTemperatureC : targetDefaultC;
        const timestampMs = input.timestampMs;
        const resolvedPower = resolvePower(input.payloadPowerKw);
        const powerKw = resolvedPower.powerKw;

        if (!Number.isFinite(temperatureC) || temperatureC < -80 || temperatureC > 150) {
            throw new Error("Keine gültige aktuelle Temperatur in msg.payload gefunden.");
        }
        if (heatingActive === null) {
            throw new Error("Aufheizstatus fehlt. Erwartet z. B. heating:true/false oder aufheizung:true/false.");
        }
        if (!Number.isFinite(targetTemperatureC) || targetTemperatureC < -80 || targetTemperatureC > 150) {
            throw new Error("Ungültige Zieltemperatur.");
        }

        const state = loadState();
        const previousHeating = Boolean(state.lastHeatingActive);
        const dtHours = Number.isFinite(state.lastTimestampMs)
            ? Math.max(0, (timestampMs - state.lastTimestampMs) / 3600000)
            : 0;
        const validGap = dtHours > 0 && dtHours <= maxGapMinutes / 60;

        if (heatingActive && (!previousHeating || !state.cycle || !validGap)) {
            state.cycle = {
                startedAtMs: timestampMs,
                startTemperatureC: temperatureC,
                energyKwh: 0,
                learnAnchorTemperatureC: temperatureC,
                learnAnchorEnergyKwh: 0,
                learnAnchorTimestampMs: timestampMs
            };
            state.history = [];
        }

        if (heatingActive) {
            if (!state.cycle) {
                state.cycle = {
                    startedAtMs: timestampMs,
                    startTemperatureC: temperatureC,
                    energyKwh: 0,
                    learnAnchorTemperatureC: temperatureC,
                    learnAnchorEnergyKwh: 0,
                    learnAnchorTimestampMs: timestampMs
                };
            }

            if (previousHeating && validGap && Number.isFinite(powerKw)) {
                const previousPowerKw = Number.isFinite(state.lastPowerKw) ? state.lastPowerKw : powerKw;
                state.cycle.energyKwh += Math.max(0, (previousPowerKw + powerKw) / 2) * dtHours;
            }

            state.history.push({ ts: timestampMs, temp: temperatureC, powerKw: Number.isFinite(powerKw) ? powerKw : null });
            const cutoff = timestampMs - measurementWindowMinutes * 60000;
            state.history = state.history
                .filter(s => Number.isFinite(s.ts) && Number.isFinite(s.temp) && s.ts >= cutoff)
                .slice(-500);

            const anchorMinutes = (timestampMs - Number(state.cycle.learnAnchorTimestampMs || timestampMs)) / 60000;
            const anchorRiseK = temperatureC - Number(state.cycle.learnAnchorTemperatureC);
            const anchorEnergyKwh = Number(state.cycle.energyKwh || 0) - Number(state.cycle.learnAnchorEnergyKwh || 0);

            if (anchorMinutes >= minLearningMinutes && anchorRiseK >= minTempRiseK && anchorEnergyKwh > 0) {
                const candidateCapacity = anchorEnergyKwh / anchorRiseK;
                if (Number.isFinite(candidateCapacity) && candidateCapacity >= 0.02 && candidateCapacity <= 10000) {
                    if (Number.isFinite(state.learnedThermalCapacityKwhPerK) && state.learnedThermalCapacityKwhPerK > 0) {
                        state.learnedThermalCapacityKwhPerK =
                            smoothingAlpha * candidateCapacity + (1 - smoothingAlpha) * state.learnedThermalCapacityKwhPerK;
                    } else {
                        state.learnedThermalCapacityKwhPerK = candidateCapacity;
                    }
                    state.learnedSamples = Number(state.learnedSamples || 0) + 1;
                    state.cycle.learnAnchorTemperatureC = temperatureC;
                    state.cycle.learnAnchorEnergyKwh = state.cycle.energyKwh;
                    state.cycle.learnAnchorTimestampMs = timestampMs;
                }
            }
        } else {
            state.cycle = null;
            state.history = [];
        }

        const historyDurationMinutes = state.history.length >= 2
            ? (state.history[state.history.length - 1].ts - state.history[0].ts) / 60000
            : 0;
        const historyTempRiseK = state.history.length >= 2
            ? state.history[state.history.length - 1].temp - state.history[0].temp
            : 0;
        let measuredRate = regressionRateKPerHour(state.history);
        const measuredRateValid = heatingActive
            && historyDurationMinutes >= minLearningMinutes
            && historyTempRiseK >= minTempRiseK
            && Number.isFinite(measuredRate)
            && measuredRate > 0;
        if (!measuredRateValid) measuredRate = null;

        const learnedCapacity = Number.isFinite(state.learnedThermalCapacityKwhPerK) && state.learnedThermalCapacityKwhPerK > 0
            ? state.learnedThermalCapacityKwhPerK
            : null;
        const effectiveCapacity = learnedCapacity || (configuredCapacity > 0 ? configuredCapacity : null);
        const powerBasedRate = Number.isFinite(powerKw) && powerKw > 0 && effectiveCapacity
            ? powerKw / effectiveCapacity
            : null;

        let calculationMethod = "nicht-verfuegbar";
        let effectiveRate = null;
        if (measuredRateValid) {
            calculationMethod = "gemessene-aufheizrate";
            effectiveRate = measuredRate;
        } else if (powerBasedRate && learnedCapacity) {
            calculationMethod = "gelernte-thermische-kapazitaet";
            effectiveRate = powerBasedRate;
        } else if (powerBasedRate && configuredCapacity > 0) {
            calculationMethod = "hinterlegte-thermische-kapazitaet";
            effectiveRate = powerBasedRate;
        }

        const deltaToTargetK = Math.max(0, targetTemperatureC - temperatureC);
        const targetReached = temperatureC >= targetTemperatureC - targetToleranceK;
        const heatingRequired = !targetReached;
        const estimateHours = !targetReached && Number.isFinite(effectiveRate) && effectiveRate > 0
            ? deltaToTargetK / effectiveRate
            : (targetReached ? 0 : null);
        const estimatedMinutesIfHeating = Number.isFinite(estimateHours) ? estimateHours * 60 : null;
        const remainingMinutes = heatingActive ? estimatedMinutesIfHeating : null;
        const etaMs = heatingActive && Number.isFinite(estimateHours) ? timestampMs + estimateHours * 3600000 : null;

        const cycleDurationMinutes = heatingActive && state.cycle
            ? Math.max(0, (timestampMs - state.cycle.startedAtMs) / 60000)
            : 0;
        const cycleTemperatureRiseK = heatingActive && state.cycle
            ? temperatureC - state.cycle.startTemperatureC
            : 0;

        let status;
        if (targetReached) status = "Zieltemperatur erreicht";
        else if (!heatingActive) status = "Aufheizung aus";
        else if (Number.isFinite(remainingMinutes)) status = "Aufheizung aktiv";
        else status = "Aufheizung aktiv – Lernphase";

        const result = {
            temperatureC: round(temperatureC, 2),
            targetTemperatureC: round(targetTemperatureC, 2),
            deltaToTargetK: round(deltaToTargetK, 2),
            heatingActive,
            heatingRequired,
            targetReached,
            powerKw: round(powerKw, 3),
            powerSource: resolvedPower.source,
            payloadPowerKw: round(input.payloadPowerKw, 3),
            fixedPowerKw: round(fixedPowerKw, 3),

            temperatureRiseRateKPerHour: round(effectiveRate, 3),
            measuredTemperatureRiseRateKPerHour: round(measuredRate, 3),
            powerBasedTemperatureRiseRateKPerHour: round(powerBasedRate, 3),
            calculationMethod,

            estimatedMinutesIfHeating: round(estimatedMinutesIfHeating, 1),
            estimatedHoursIfHeating: round(Number.isFinite(estimateHours) ? estimateHours : null, 2),
            remainingMinutes: round(remainingMinutes, 1),
            remainingHours: round(Number.isFinite(remainingMinutes) ? remainingMinutes / 60 : null, 2),
            estimatedTargetTimeIso: etaMs ? new Date(etaMs).toISOString() : null,
            estimatedTargetTimeLocal: etaMs ? localDateTime(new Date(etaMs)) : null,

            cycle: {
                active: heatingActive,
                durationMinutes: round(cycleDurationMinutes, 1),
                startTemperatureC: state.cycle ? round(state.cycle.startTemperatureC, 2) : null,
                temperatureRiseK: round(cycleTemperatureRiseK, 2),
                energyKwh: state.cycle ? round(state.cycle.energyKwh, 3) : null,
                samplesInWindow: state.history.length,
                measurementWindowMinutes: round(historyDurationMinutes, 1)
            },

            model: {
                learnedThermalCapacityKwhPerK: round(learnedCapacity, 4),
                configuredThermalCapacityKwhPerK: configuredCapacity > 0 ? round(configuredCapacity, 4) : null,
                effectiveThermalCapacityKwhPerK: round(effectiveCapacity, 4),
                learnedSamples: Number(state.learnedSamples || 0),
                learningReady: Boolean(measuredRateValid || learnedCapacity)
            },

            status,
            timestamp: new Date(timestampMs).toISOString(),
            persistence: {
                active: true,
                stateFile
            },
            remote_function_version: VERSION
        };

        const values = {
            Aufheizdauer_Temperatur_C: result.temperatureC,
            Aufheizdauer_Zieltemperatur_C: result.targetTemperatureC,
            Aufheizdauer_Differenz_K: result.deltaToTargetK,
            Aufheizdauer_Aktiv: result.heatingActive,
            Aufheizdauer_Ziel_erreicht: result.targetReached,
            Aufheizdauer_Leistung_kW: result.powerKw,
            Aufheizdauer_Rate_K_h: result.temperatureRiseRateKPerHour,
            Aufheizdauer_Rest_min: result.remainingMinutes,
            Aufheizdauer_Rest_h: result.remainingHours,
            Aufheizdauer_Zielzeit_ISO: result.estimatedTargetTimeIso,
            Aufheizdauer_Zielzeit_Lokal: result.estimatedTargetTimeLocal,
            Aufheizdauer_Berechnungsmethode: result.calculationMethod,
            Aufheizdauer_ThermischeKapazitaet_kWh_K: result.model.effectiveThermalCapacityKwhPerK,
            Aufheizdauer_Lernwerte: result.model.learnedSamples,
            Aufheizdauer_Status: result.status,
            Aufheizdauer_Letzte_Aktualisierung: result.timestamp
        };

        for (const [key, value] of Object.entries(values)) {
            flow.set(key, value);
            global.set(key, value);
        }

        state.lastTemperatureC = temperatureC;
        state.lastPowerKw = Number.isFinite(powerKw) ? powerKw : null;
        state.lastHeatingActive = heatingActive;
        state.lastTimestampMs = timestampMs;
        const persisted = saveState(state, !previousHeating && heatingActive);
        result.persistence.savedThisRun = persisted;

        msg.payload = result;
        node.status({
            fill: targetReached ? "green" : (heatingActive ? "yellow" : "grey"),
            shape: "dot",
            text: targetReached
                ? `Ziel erreicht ${round(temperatureC, 1)} °C`
                : (heatingActive && Number.isFinite(remainingMinutes)
                    ? `Aufheizen ~${round(remainingMinutes, 0)} min`
                    : status)
        });
        return msg;
    } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "Aufheizdauer: Fehler" });
        msg.payload = {
            error: true,
            message: err.message,
            remote_function_version: VERSION
        };
        return msg;
    }
};
