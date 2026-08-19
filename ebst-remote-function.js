"use strict";

const path = require("path");
const { RemoteManager, DEFAULT_MANIFEST_URL, DEFAULT_INTERVAL_MS } = require("./lib/remote-manager");

module.exports = function(RED) {
    const userDir = RED.settings.userDir || process.cwd();
    const cacheDir = path.join(userDir, ".ebst-remote-functions");

    const manager = new RemoteManager({
        cacheDir,
        seedDir: __dirname,
        manifestUrl: RED.settings.ebstRemoteFunctionManifestUrl || DEFAULT_MANIFEST_URL,
        intervalMs: Number(RED.settings.ebstRemoteFunctionUpdateIntervalMs) || DEFAULT_INTERVAL_MS
    });

    // Manifest beim Start versuchen. Ein Fehler ist unkritisch, sofern später
    // ein lokaler Cache verfügbar ist.
    manager.getManifest(true).catch(() => {});

    function EbstRemoteFunctionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.functionId = config.functionId;
        node.name = config.name;
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
                    RED
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
                // Bei GitHub-Ausfall trotzdem das lokale Manifest anbieten.
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
};
