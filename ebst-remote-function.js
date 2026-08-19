"use strict";

const path = require("path");
const https = require("https");
const { RemoteManager, DEFAULT_MANIFEST_URL, DEFAULT_INTERVAL_MS } = require("./lib/remote-manager");

function fetchJson(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (!/^https:\/\//i.test(url || "")) {
            reject(new Error("Optionsquelle muss eine HTTPS-URL sein"));
            return;
        }
        if (redirects > 5) {
            reject(new Error("Zu viele HTTP-Weiterleitungen"));
            return;
        }

        const req = https.get(url, {
            headers: {
                "User-Agent": "EBST-NodeRED-Remote-Function/1.3.0",
                "Accept": "application/json"
            },
            timeout: 15000
        }, res => {
            const status = res.statusCode || 0;

            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                fetchJson(next, redirects + 1).then(resolve, reject);
                return;
            }

            if (status !== 200) {
                res.resume();
                reject(new Error(`HTTP ${status} bei ${url}`));
                return;
            }

            res.setEncoding("utf8");
            let body = "";
            res.on("data", chunk => {
                body += chunk;
                if (body.length > 2 * 1024 * 1024) {
                    req.destroy(new Error("Antwort ist größer als 2 MB"));
                }
            });
            res.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(new Error("Ungültiges JSON: " + err.message));
                }
            });
        });

        req.on("timeout", () => req.destroy(new Error("HTTP Timeout")));
        req.on("error", reject);
    });
}

function getByPath(obj, pathText) {
    if (!pathText) return obj;
    return String(pathText).split(".").filter(Boolean).reduce((value, key) => {
        if (value === undefined || value === null) return undefined;
        return value[key];
    }, obj);
}

function formatTemplate(template, item, index) {
    let text = String(template || "{index}");
    text = text.replace(/\{index\}/g, String(index));
    text = text.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_, key) => {
        const value = getByPath(item, key);
        return value === undefined || value === null ? "" : String(value);
    });
    return text
        .replace(/\[\s*\]/g, "")
        .replace(/\(\s*\)/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function listManifestFunctions(manifest) {
    const functions = (manifest && manifest.functions) || {};
    return Object.entries(functions).map(([id, spec]) => ({
        id,
        name: spec.name || id,
        category: spec.category || "Allgemein",
        version: spec.version || "",
        description: spec.description || "",
        outputs: Number.isInteger(spec.outputs) && spec.outputs > 0 ? spec.outputs : 1,
        outputLabels: Array.isArray(spec.outputLabels) ? spec.outputLabels : [],
        settings: Array.isArray(spec.settings) ? spec.settings : [],
        dataPoints: Array.isArray(spec.dataPoints) ? spec.dataPoints : []
    })).sort((a, b) => {
        const c = a.category.localeCompare(b.category, "de");
        return c || a.name.localeCompare(b.name, "de");
    });
}

function parseFunctionConfig(raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return { ...raw };
    }
    if (typeof raw === "string" && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch (_) {}
    }
    return {};
}

module.exports = function(RED) {
    const userDir = RED.settings.userDir || process.cwd();
    const cacheDir = path.join(userDir, ".ebst-remote-functions");

    const manager = new RemoteManager({
        cacheDir,
        seedDir: __dirname,
        manifestUrl: RED.settings.ebstRemoteFunctionManifestUrl || DEFAULT_MANIFEST_URL,
        intervalMs: Number(RED.settings.ebstRemoteFunctionUpdateIntervalMs) || DEFAULT_INTERVAL_MS
    });

    manager.getManifest(true).catch(() => {});

    function EbstRemoteFunctionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.functionId = config.functionId;
        node.name = config.name;
        node.functionConfig = parseFunctionConfig(config.functionConfig);

        if (node.functionConfig.stationIndex === undefined && config.stationIndex !== undefined && config.stationIndex !== null && String(config.stationIndex) !== "") {
            node.functionConfig.stationIndex = String(config.stationIndex);
        }
        if (node.functionConfig.latitude === undefined && config.latitude !== undefined && config.latitude !== null && String(config.latitude) !== "") {
            node.functionConfig.latitude = config.latitude;
        }
        if (node.functionConfig.longitude === undefined && config.longitude !== undefined && config.longitude !== null && String(config.longitude) !== "") {
            node.functionConfig.longitude = config.longitude;
        }

        node.status({ fill: "grey", shape: "ring", text: "wird geladen" });

        const onUpdated = (id, info) => {
            if (id !== node.functionId) return;
            const v = info && info.version ? ` v${info.version}` : "";
            node.status({ fill: "green", shape: "dot", text: `bereit${v}` });
        };
        const onCurrent = (id, info) => {
            if (id !== node.functionId) return;
            const v = info && info.version ? ` v${info.version}` : "";
            node.status({ fill: "green", shape: "dot", text: `aktuell${v}` });
        };
        const onWarning = (id, err) => {
            if (id !== node.functionId) return;
            node.status({ fill: "yellow", shape: "ring", text: "GitHub/Update Fehler – Cache aktiv" });
            node.warn(`EBST Node Red Remote Funktion '${id}': ${err.message}`);
        };
        const onError = (id, err) => {
            if (id !== node.functionId) return;
            node.status({ fill: "red", shape: "ring", text: "Funktion nicht verfügbar" });
            node.error(`EBST Node Red Remote Funktion '${id}': ${err.message}`);
        };

        manager.on("function-updated", onUpdated);
        manager.on("function-current", onCurrent);
        manager.on("function-warning", onWarning);
        manager.on("function-error", onError);

        manager.register(node.functionId)
            .then(() => {
                const st = manager.getState(node.functionId);
                const v = st && st.version ? ` v${st.version}` : "";
                node.status({ fill: "green", shape: "dot", text: `bereit${v}` });
            })
            .catch(err => {
                node.status({ fill: "red", shape: "ring", text: "nicht verfügbar" });
                node.error(err.message);
            });

        node.on("input", async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };

            try {
                const ctx = {
                    msg,
                    node,
                    context: node.context(),
                    flow: node.context().flow,
                    global: node.context().global,
                    RED,
                    config: { ...node.functionConfig }
                };

                const result = await manager.execute(node.functionId, ctx);
                if (result !== null && result !== undefined) send(result);
                if (done) done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "Ausführungsfehler" });
                node.error(err, msg);
                if (done) done(err);
            }
        });

        node.on("close", function(done) {
            manager.removeListener("function-updated", onUpdated);
            manager.removeListener("function-current", onCurrent);
            manager.removeListener("function-warning", onWarning);
            manager.removeListener("function-error", onError);
            manager.unregister(node.functionId);
            if (done) done();
        });
    }

    RED.nodes.registerType("ebst-remote-function", EbstRemoteFunctionNode, {
        settings: {
            ebstRemoteFunctionManifestUrl: { value: DEFAULT_MANIFEST_URL, exportable: false },
            ebstRemoteFunctionUpdateIntervalMs: { value: DEFAULT_INTERVAL_MS, exportable: false }
        }
    });

    RED.httpAdmin.get(
        "/ebst-remote-function/functions",
        RED.auth.needsPermission("ebst-remote-function.read"),
        async function(req, res) {
            try {
                const manifest = await manager.getManifest(true);
                res.json({ ok: true, functions: listManifestFunctions(manifest) });
            } catch (err) {
                try {
                    const manifest = await manager.getManifest(false);
                    res.json({ ok: true, cached: true, warning: err.message, functions: listManifestFunctions(manifest) });
                } catch (_) {
                    res.status(503).json({ ok: false, error: err.message, functions: [] });
                }
            }
        }
    );

    RED.httpAdmin.get(
        "/ebst-remote-function/options/:functionId/:settingId",
        RED.auth.needsPermission("ebst-remote-function.read"),
        async function(req, res) {
            try {
                const manifest = await manager.getManifest(true);
                const spec = manifest && manifest.functions && manifest.functions[req.params.functionId];
                if (!spec) throw new Error("Funktion nicht gefunden");

                const setting = (Array.isArray(spec.settings) ? spec.settings : [])
                    .find(item => item && item.id === req.params.settingId);
                if (!setting) throw new Error("Einstellung nicht gefunden");

                if (Array.isArray(setting.options)) {
                    const options = setting.options.map((item, index) => {
                        if (item && typeof item === "object") {
                            return {
                                value: item.value !== undefined ? item.value : index,
                                label: item.label !== undefined ? item.label : String(item.value !== undefined ? item.value : index)
                            };
                        }
                        return { value: item, label: String(item) };
                    });
                    res.json({ ok: true, options });
                    return;
                }

                const source = setting.optionsSource;
                if (!source || !source.url) throw new Error("Keine Optionsquelle definiert");

                const data = await fetchJson(source.url);
                const list = getByPath(data, source.arrayPath);
                if (!Array.isArray(list)) throw new Error("Optionsquelle enthält keine gültige Liste");

                const options = list.map((item, index) => {
                    let value;
                    if (source.valueField === "$index" || !source.valueField) value = index;
                    else value = getByPath(item, source.valueField);

                    const label = formatTemplate(source.labelTemplate || "{index}", item, index);
                    return { value, label };
                }).filter(item => item.value !== undefined && item.value !== null);

                res.json({ ok: true, options });
            } catch (err) {
                res.status(503).json({ ok: false, error: err.message, options: [] });
            }
        }
    );

    RED.httpAdmin.get(
        "/ebst-remote-function/techweb-stations",
        RED.auth.needsPermission("ebst-remote-function.read"),
        async function(req, res) {
            try {
                const data = await fetchJson("https://cdn3.techweb.at/api/weather/at/data?province=tirol&format=json");
                if (!data || !Array.isArray(data.weather_data)) throw new Error("weather_data fehlt in der Techweb-Antwort");
                const stations = data.weather_data.map((station, index) => ({
                    index,
                    location: station.location || `Station ${index}`,
                    station_id: station.station_id || null
                }));
                res.json({ ok: true, stations });
            } catch (err) {
                res.status(503).json({ ok: false, error: err.message, stations: [] });
            }
        }
    );
};
