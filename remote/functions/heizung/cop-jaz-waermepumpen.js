"use strict";

module.exports = async function run(ctx) {
    const { msg, node, flow, global, RED, config = {} } = ctx;

    const VERSION = "1.0.0";
    const TIMEZONE = "Europe/Vienna";
    const selectionMode = String(config.selectionMode || "all").trim().toLowerCase();
    const selectedIds = String(config.selectedIds || "")
        .split(/[,;\n]+/)
        .map(x => x.trim())
        .filter(Boolean);
    const maxIntegrationMinutes = Math.max(1, Number(config.maxIntegrationMinutes || 60));
    const persistMinSeconds = Math.max(0, Number(config.persistMinSeconds || 5));

    function round(value, decimals = 3) {
        if (!Number.isFinite(value)) return null;
        const factor = Math.pow(10, decimals);
        return Math.round((value + Number.EPSILON) * factor) / factor;
    }

    function getByPath(obj, path) {
        const parts = path.split(".");
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
        const normalized = typeof value === "string" ? value.replace(",", ".") : value;
        const n = Number(normalized);
        return Number.isFinite(n) ? n : null;
    }

    function safeId(value, fallback) {
        const s = String(value === undefined || value === null || value === "" ? fallback : value).trim();
        return s.replace(/[^a-zA-Z0-9_-]/g, "_") || fallback;
    }

    function getViennaYear(date = new Date()) {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: TIMEZONE,
            year: "numeric"
        }).formatToParts(date);
        return Number(parts.find(p => p.type === "year").value);
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

    function normalizeInput(payload) {
        if (Array.isArray(payload)) return payload;
        if (payload && typeof payload === "object") {
            if (Array.isArray(payload.waermepumpen)) return payload.waermepumpen;
            if (Array.isArray(payload.waermepumpe)) return payload.waermepumpe;
            if (Array.isArray(payload.heatPumps)) return payload.heatPumps;
            if (Array.isArray(payload.heatpumps)) return payload.heatpumps;
            return [payload];
        }
        throw new Error("msg.payload muss eine Wärmepumpe, ein Array oder { waermepumpen:[...] } enthalten.");
    }

    const fs = require("fs");
    const path = require("path");
    const userDir = RED && RED.settings && RED.settings.userDir ? RED.settings.userDir : process.cwd();
    const stateDir = path.join(userDir, ".ebst-remote-functions", "state");
    const stateFile = path.join(stateDir, "cop-jaz-waermepumpen.json");

    function loadState() {
        try {
            if (!fs.existsSync(stateFile)) return { schema: 1, pumps: {}, lastPersistMs: 0 };
            const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            if (!parsed || typeof parsed !== "object") throw new Error("ungültiger Zustand");
            if (!parsed.pumps || typeof parsed.pumps !== "object") parsed.pumps = {};
            if (!Number.isFinite(parsed.lastPersistMs)) parsed.lastPersistMs = 0;
            return parsed;
        } catch (err) {
            node.warn("COP/JAZ: Persistenzdatei konnte nicht gelesen werden: " + err.message);
            return { schema: 1, pumps: {}, lastPersistMs: 0 };
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
            node.warn("COP/JAZ: Persistenzdatei konnte nicht gespeichert werden: " + err.message);
            return false;
        }
    }

    function positiveDelta(current, previous) {
        if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
        if (current >= previous) return current - previous;
        return current >= 0 ? current : 0;
    }

    function setContextValues(prefix, result) {
        const values = {
            [`${prefix}_COP`]: result.cop,
            [`${prefix}_JAZ`]: result.jaz,
            [`${prefix}_Waerme_Jahr_kWh`]: result.yearHeatKwh,
            [`${prefix}_Strom_Jahr_kWh`]: result.yearElectricKwh,
            [`${prefix}_Waermeleistung_kW`]: result.thermalPowerKw,
            [`${prefix}_Stromleistung_kW`]: result.electricalPowerKw,
            [`${prefix}_Letzte_Aktualisierung`]: result.updatedAt
        };
        for (const [key, value] of Object.entries(values)) {
            flow.set(key, value);
            global.set(key, value);
        }
    }

    const allItems = normalizeInput(msg.payload)
        .filter(x => x && typeof x === "object")
        .map((item, index) => {
            const rawId = firstValue(item, ["id", "wpId", "wp_id", "name", "bezeichnung", "deviceId", "device_id"]);
            return { item, id: safeId(rawId, `WP${index + 1}`) };
        });

    let selectedItems = allItems;
    if (selectionMode === "selected" && selectedIds.length) {
        const wanted = new Set(selectedIds.map(x => safeId(x, x).toLowerCase()));
        selectedItems = allItems.filter(x => wanted.has(x.id.toLowerCase()));
    }

    if (!selectedItems.length) {
        throw new Error(selectionMode === "selected"
            ? `Keine ausgewählte Wärmepumpe gefunden. Auswahl: ${selectedIds.join(", ")}`
            : "Keine Wärmepumpendaten in msg.payload gefunden.");
    }

    const state = loadState();
    const results = [];
    const currentYear = getViennaYear();
    const nowIso = new Date().toISOString();

    for (const entry of selectedItems) {
        const item = entry.item;
        const id = entry.id;
        const timestampMs = normalizeTimestamp(firstValue(item, ["timestamp", "time", "ts", "updated_at", "updatedAt"]));
        const timestampDate = new Date(timestampMs);
        const year = getViennaYear(timestampDate);

        let s = state.pumps[id];
        if (!s || typeof s !== "object") {
            s = {
                id,
                year,
                yearHeatKwh: 0,
                yearElectricKwh: 0,
                lastHeatTotalKwh: null,
                lastElectricTotalKwh: null,
                lastTimestampMs: null,
                lastThermalPowerKw: null,
                lastElectricalPowerKw: null
            };
        }

        if (s.year !== year) {
            s.year = year;
            s.yearHeatKwh = 0;
            s.yearElectricKwh = 0;
            s.lastHeatTotalKwh = null;
            s.lastElectricTotalKwh = null;
            s.lastTimestampMs = null;
            s.lastThermalPowerKw = null;
            s.lastElectricalPowerKw = null;
        }

        const thermalPowerKw = firstNumber(item, [
            "thermalPowerKw", "heatPowerKw", "heatingPowerKw", "waermeleistungKw", "waermeLeistungKw",
            "power.thermalKw", "power.heatKw", "leistung.waermeKw"
        ]);
        const electricalPowerKw = firstNumber(item, [
            "electricalPowerKw", "electricPowerKw", "inputPowerKw", "stromleistungKw", "aufnahmeleistungKw",
            "power.electricKw", "power.electricalKw", "leistung.stromKw"
        ]);

        const annualHeatDirect = firstNumber(item, [
            "yearHeatKwh", "annualHeatKwh", "waermeJahrKwh", "waermemengeJahrKwh", "energy.yearHeatKwh", "energy.annualHeatKwh"
        ]);
        const annualElectricDirect = firstNumber(item, [
            "yearElectricKwh", "annualElectricKwh", "stromJahrKwh", "stromverbrauchJahrKwh", "energy.yearElectricKwh", "energy.annualElectricKwh"
        ]);

        const heatTotalKwh = firstNumber(item, [
            "heatEnergyKwh", "thermalEnergyKwh", "waermemengeKwh", "waermeenergieKwh", "heatMeterKwh", "energy.heatKwh", "energy.thermalKwh"
        ]);
        const electricTotalKwh = firstNumber(item, [
            "electricEnergyKwh", "electricalEnergyKwh", "stromverbrauchKwh", "stromenergieKwh", "electricMeterKwh", "energy.electricKwh", "energy.electricalKwh"
        ]);

        const dtHours = Number.isFinite(s.lastTimestampMs)
            ? Math.max(0, (timestampMs - s.lastTimestampMs) / 3600000)
            : 0;
        const canIntegrate = dtHours > 0 && dtHours <= maxIntegrationMinutes / 60;

        let heatMethod = "keine";
        let electricMethod = "keine";

        if (Number.isFinite(annualHeatDirect) && annualHeatDirect >= 0) {
            s.yearHeatKwh = annualHeatDirect;
            heatMethod = "jahreszaehler-direkt";
        } else if (Number.isFinite(heatTotalKwh) && heatTotalKwh >= 0) {
            if (Number.isFinite(s.lastHeatTotalKwh)) {
                s.yearHeatKwh = Number(s.yearHeatKwh || 0) + positiveDelta(heatTotalKwh, s.lastHeatTotalKwh);
            }
            s.lastHeatTotalKwh = heatTotalKwh;
            heatMethod = "gesamtzaehler-differenz";
        } else if (canIntegrate && Number.isFinite(thermalPowerKw)) {
            const previous = Number.isFinite(s.lastThermalPowerKw) ? s.lastThermalPowerKw : thermalPowerKw;
            s.yearHeatKwh = Number(s.yearHeatKwh || 0) + ((previous + thermalPowerKw) / 2) * dtHours;
            heatMethod = "leistungsintegration";
        }

        if (Number.isFinite(annualElectricDirect) && annualElectricDirect >= 0) {
            s.yearElectricKwh = annualElectricDirect;
            electricMethod = "jahreszaehler-direkt";
        } else if (Number.isFinite(electricTotalKwh) && electricTotalKwh >= 0) {
            if (Number.isFinite(s.lastElectricTotalKwh)) {
                s.yearElectricKwh = Number(s.yearElectricKwh || 0) + positiveDelta(electricTotalKwh, s.lastElectricTotalKwh);
            }
            s.lastElectricTotalKwh = electricTotalKwh;
            electricMethod = "gesamtzaehler-differenz";
        } else if (canIntegrate && Number.isFinite(electricalPowerKw)) {
            const previous = Number.isFinite(s.lastElectricalPowerKw) ? s.lastElectricalPowerKw : electricalPowerKw;
            s.yearElectricKwh = Number(s.yearElectricKwh || 0) + ((previous + electricalPowerKw) / 2) * dtHours;
            electricMethod = "leistungsintegration";
        }

        if (Number.isFinite(thermalPowerKw)) s.lastThermalPowerKw = thermalPowerKw;
        if (Number.isFinite(electricalPowerKw)) s.lastElectricalPowerKw = electricalPowerKw;
        s.lastTimestampMs = timestampMs;

        const cop = Number.isFinite(thermalPowerKw) && Number.isFinite(electricalPowerKw) && electricalPowerKw > 0
            ? thermalPowerKw / electricalPowerKw
            : null;
        const jaz = Number(s.yearElectricKwh) > 0
            ? Number(s.yearHeatKwh || 0) / Number(s.yearElectricKwh)
            : null;

        s.cop = round(cop, 3);
        s.jaz = round(jaz, 3);
        s.updatedAt = new Date(timestampMs).toISOString();
        s.heatMethod = heatMethod;
        s.electricMethod = electricMethod;
        state.pumps[id] = s;

        const result = {
            id,
            year,
            thermalPowerKw: round(thermalPowerKw, 3),
            electricalPowerKw: round(electricalPowerKw, 3),
            cop: round(cop, 3),
            yearHeatKwh: round(Number(s.yearHeatKwh || 0), 3),
            yearElectricKwh: round(Number(s.yearElectricKwh || 0), 3),
            jaz: round(jaz, 3),
            heatMethod,
            electricMethod,
            updatedAt: s.updatedAt
        };
        results.push(result);
        setContextValues(id, result);
    }

    const validPower = results.filter(r => Number.isFinite(r.thermalPowerKw) && Number.isFinite(r.electricalPowerKw));
    const totalThermalPowerKw = validPower.reduce((sum, r) => sum + r.thermalPowerKw, 0);
    const totalElectricalPowerKw = validPower.reduce((sum, r) => sum + r.electricalPowerKw, 0);
    const totalYearHeatKwh = results.reduce((sum, r) => sum + Number(r.yearHeatKwh || 0), 0);
    const totalYearElectricKwh = results.reduce((sum, r) => sum + Number(r.yearElectricKwh || 0), 0);

    const copTotal = totalElectricalPowerKw > 0 ? totalThermalPowerKw / totalElectricalPowerKw : null;
    const jazTotal = totalYearElectricKwh > 0 ? totalYearHeatKwh / totalYearElectricKwh : null;

    const aggregateContext = {
        COP_Gesamt: round(copTotal, 3),
        JAZ_Gesamt: round(jazTotal, 3),
        WP_Waermeleistung_Gesamt_kW: round(totalThermalPowerKw, 3),
        WP_Stromleistung_Gesamt_kW: round(totalElectricalPowerKw, 3),
        WP_Waerme_Jahr_Gesamt_kWh: round(totalYearHeatKwh, 3),
        WP_Strom_Jahr_Gesamt_kWh: round(totalYearElectricKwh, 3),
        WP_COP_JAZ_Letzte_Aktualisierung: nowIso
    };

    for (const [key, value] of Object.entries(aggregateContext)) {
        flow.set(key, value);
        global.set(key, value);
    }

    const persisted = saveState(state);

    msg.topic = "waermepumpe_cop_jaz";
    msg.payload = {
        remote_function_version: VERSION,
        timezone: TIMEZONE,
        year: currentYear,
        selectionMode,
        selectedIds,
        persistence: {
            active: true,
            file: stateFile,
            savedThisRun: persisted,
            restore: "automatisch beim nächsten Ausführen nach Node-RED-Neustart"
        },
        pumps: results,
        total: {
            thermalPowerKw: round(totalThermalPowerKw, 3),
            electricalPowerKw: round(totalElectricalPowerKw, 3),
            cop: round(copTotal, 3),
            yearHeatKwh: round(totalYearHeatKwh, 3),
            yearElectricKwh: round(totalYearElectricKwh, 3),
            jaz: round(jazTotal, 3)
        }
    };

    node.status({
        fill: "green",
        shape: "dot",
        text: `${results.length} WP · COP ${round(copTotal, 2) ?? "-"} · JAZ ${round(jazTotal, 2) ?? "-"}`
    });

    return msg;
};
