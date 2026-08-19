"use strict";

const path = require("path");
const https = require("https");
const { RemoteManager, DEFAULT_MANIFEST_URL, DEFAULT_INTERVAL_MS } = require("./lib/remote-manager");

const TECHWEB_TIROl_URL = "https://cdn3.techweb.at/api/weather/at/data?province=tirol&format=json";

function fetchJson(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error("Zu viele HTTP-Weiterleitungen"));
            return;
        }

        const req = https.get(url, {
            headers: {
                "User-Agent": "EBST-NodeRED-Remote-Function/1.1.0",
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
        node.stationIndex = config.stationIndex !== undefined && config.stationIndex !== null
            ? String(config.stationIndex)
            : "13";
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
                    config: {
                        stationIndex: node.stationIndex
                    }
                };

                const result = await manager.execute(node.functionId, ctx);
                if (result !== null && result !== undefined) {
                    send(result);
                }
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
            ebstRemoteFunctionManifestUrl: {
                value: DEFAULT_MANIFEST_URL,
                exportable: false
            },
            ebstRemoteFunctionUpdateIntervalMs: {
                value: DEFAULT_INTERVAL_MS,
                exportable: false
            }
        }
    });

    RED.httpAdmin.get(
        "/ebst-remote-function/functions",
        RED.auth.needsPermission("ebst-remote-function.read"),
        async function(req, res) {
            try {
                await manager.getManifest(true);
                res.json({
                    ok: true,
                    functions: manager.listFunctions()
                });
            } catch (err) {
                try {
                    await manager.getManifest(false);
                    res.json({
                        ok: true,
                        cached: true,
                        warning: err.message,
                        functions: manager.listFunctions()
                    });
                } catch (_) {
                    res.status(503).json({ ok: false, error: err.message, functions: [] });
                }
            }
        }
    );

    RED.httpAdmin.get(
        "/ebst-remote-function/techweb-stations",
        RED.auth.needsPermission("ebst-remote-function.read"),
        async function(req, res) {
            try {
                const data = await fetchJson(TECHWEB_TIROl_URL);
                if (!data || !Array.isArray(data.weather_data)) {
                    throw new Error("weather_data fehlt in der Techweb-Antwort");
                }

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
