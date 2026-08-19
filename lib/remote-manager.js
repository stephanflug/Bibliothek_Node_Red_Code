"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const EventEmitter = require("events");

const DEFAULT_MANIFEST_URL = "https://raw.githubusercontent.com/stephanflug/Bibliothek_Node_Red_Code/main/remote/manifest.json";
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function sha256(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function safeId(id) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id || "")) {
        throw new Error("Ungültige Funktions-ID: " + id);
    }
    return id;
}

function fetchText(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error("Zu viele HTTP-Weiterleitungen"));
            return;
        }

        const req = https.get(url, {
            headers: {
                "User-Agent": "EBST-NodeRED-Remote-Function/0.1.2",
                "Accept": "application/json,text/plain,*/*",
                "Cache-Control": "no-cache"
            },
            timeout: 15000
        }, (res) => {
            const status = res.statusCode || 0;

            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                fetchText(next, redirects + 1).then(resolve, reject);
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
                    req.destroy(new Error("Remote-Datei ist größer als 2 MB"));
                }
            });
            res.on("end", () => resolve(body));
        });

        req.on("timeout", () => req.destroy(new Error("HTTP Timeout")));
        req.on("error", reject);
    });
}

class RemoteManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.manifestUrl = options.manifestUrl || DEFAULT_MANIFEST_URL;
        this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
        this.cacheDir = options.cacheDir;
        this.manifestFile = path.join(this.cacheDir, "manifest.json");
        this.stateFile = path.join(this.cacheDir, "state.json");
        this.functionsDir = path.join(this.cacheDir, "functions");
        this.used = new Set();
        this.modules = new Map();
        this.manifest = null;
        this.state = { functions: {} };
        this.timer = null;
        this.refreshPromise = null;
        this.refs = new Map();
        this.seedDir = options.seedDir || null;

        fs.mkdirSync(this.functionsDir, { recursive: true });
        this._loadState();
        this._loadCachedManifest();
        this._seedFromPackage();
    }

    _replaceFile(temp, target) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        fs.renameSync(temp, target);
    }

    _seedFromPackage() {
        if (!this.seedDir || this.manifest) return;

        try {
            const seedManifestFile = path.join(this.seedDir, "remote", "manifest.json");
            const text = fs.readFileSync(seedManifestFile, "utf8");
            const parsed = JSON.parse(text);
            if (!parsed || parsed.schema !== 1 || typeof parsed.functions !== "object") return;

            this.manifest = parsed;
            this._saveManifest(text);

            for (const [id, spec] of Object.entries(parsed.functions)) {
                if (!spec.localFile) continue;
                const src = path.resolve(this.seedDir, spec.localFile);
                if (!src.startsWith(path.resolve(this.seedDir) + path.sep)) continue;
                if (!fs.existsSync(src)) continue;

                const source = fs.readFileSync(src, "utf8");
                const target = this._cachePath(id);
                fs.writeFileSync(target, source, "utf8");
                this.state.functions[id] = {
                    version: spec.version || "",
                    sha256: sha256(source),
                    updatedAt: new Date().toISOString(),
                    seeded: true
                };
            }
            this._saveState();
        } catch (_) {
            // Seed ist nur ein Offline-Fallback. Fehler hier blockieren Node-RED nicht.
        }
    }

    _loadState() {
        try {
            this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
            if (!this.state.functions) this.state.functions = {};
        } catch (_) {
            this.state = { functions: {} };
        }
    }

    _saveState() {
        const tmp = this.stateFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
        this._replaceFile(tmp, this.stateFile);
    }

    _loadCachedManifest() {
        try {
            this.manifest = JSON.parse(fs.readFileSync(this.manifestFile, "utf8"));
        } catch (_) {
            this.manifest = null;
        }
    }

    _saveManifest(text) {
        const tmp = this.manifestFile + ".tmp";
        fs.writeFileSync(tmp, text, "utf8");
        this._replaceFile(tmp, this.manifestFile);
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.refreshUsed().catch(err => this.emit("manager-error", err));
        }, this.intervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    register(id) {
        safeId(id);
        this.refs.set(id, (this.refs.get(id) || 0) + 1);
        this.used.add(id);
        this.start();
        return this.ensureLoaded(id);
    }

    unregister(id) {
        const count = Math.max(0, (this.refs.get(id) || 0) - 1);
        if (count === 0) {
            this.refs.delete(id);
            this.used.delete(id);
        } else {
            this.refs.set(id, count);
        }
        if (this.used.size === 0) this.stop();
    }

    async getManifest(forceRemote = false) {
        if (this.manifest && !forceRemote) return this.manifest;

        try {
            const text = await fetchText(this.manifestUrl);
            const parsed = JSON.parse(text);
            if (!parsed || parsed.schema !== 1 || typeof parsed.functions !== "object") {
                throw new Error("Ungültiges manifest.json");
            }
            this.manifest = parsed;
            this._saveManifest(text);
            return parsed;
        } catch (err) {
            if (this.manifest) return this.manifest;
            throw err;
        }
    }

    listFunctions() {
        const functions = (this.manifest && this.manifest.functions) || {};
        return Object.entries(functions).map(([id, spec]) => ({
            id,
            name: spec.name || id,
            category: spec.category || "Allgemein",
            version: spec.version || "",
            description: spec.description || "",
            outputs: Number.isInteger(spec.outputs) && spec.outputs > 0 ? spec.outputs : 1,
            outputLabels: Array.isArray(spec.outputLabels) ? spec.outputLabels : []
        })).sort((a, b) => {
            const c = a.category.localeCompare(b.category, "de");
            return c || a.name.localeCompare(b.name, "de");
        });
    }

    _cachePath(id) {
        return path.join(this.functionsDir, safeId(id) + ".js");
    }

    _loadModuleFile(file) {
        const resolved = require.resolve(file);
        delete require.cache[resolved];
        const mod = require(resolved);
        const fn = typeof mod === "function" ? mod : mod && mod.run;
        if (typeof fn !== "function") {
            throw new Error("Remote-Modul exportiert keine ausführbare Funktion");
        }
        return fn;
    }

    async ensureLoaded(id) {
        safeId(id);
        if (this.modules.has(id)) return this.modules.get(id);

        const cached = this._cachePath(id);
        if (fs.existsSync(cached)) {
            try {
                const fn = this._loadModuleFile(cached);
                this.modules.set(id, fn);
            } catch (err) {
                this.emit("function-error", id, err);
            }
        }

        try {
            await this.refreshFunction(id, false);
        } catch (err) {
            if (!this.modules.has(id)) throw err;
            this.emit("function-warning", id, err);
        }

        if (!this.modules.has(id)) {
            throw new Error(`Funktion '${id}' ist weder remote noch im Cache verfügbar`);
        }
        return this.modules.get(id);
    }

    async refreshFunction(id, forceManifest = false) {
        const manifest = await this.getManifest(forceManifest);
        const spec = manifest.functions[id];
        if (!spec) throw new Error(`Funktion '${id}' fehlt im Manifest`);
        if (!spec.url || !/^https:\/\//i.test(spec.url)) {
            throw new Error(`Funktion '${id}' hat keine gültige HTTPS-URL`);
        }

        const source = await fetchText(spec.url);
        const hash = sha256(source);
        const old = this.state.functions[id] || {};

        if (old.sha256 === hash && this.modules.has(id)) {
            this.emit("function-current", id, {
                version: spec.version || old.version || "",
                sha256: hash
            });
            return false;
        }

        const target = this._cachePath(id);
        const temp = target + `.new-${process.pid}-${Date.now()}`;
        fs.writeFileSync(temp, source, "utf8");

        let fn;
        try {
            fn = this._loadModuleFile(temp);
        } catch (err) {
            try { fs.unlinkSync(temp); } catch (_) {}
            throw new Error(`Neue Version von '${id}' ist ungültig: ${err.message}`);
        }

        // Erst nach erfolgreichem Laden die bisherige Cache-Datei ersetzen.
        try {
            this._replaceFile(temp, target);
        } catch (err) {
            try { fs.unlinkSync(temp); } catch (_) {}
            throw err;
        }

        this.modules.set(id, fn);
        this.state.functions[id] = {
            version: spec.version || "",
            sha256: hash,
            updatedAt: new Date().toISOString()
        };
        this._saveState();
        this.emit("function-updated", id, this.state.functions[id]);
        return true;
    }

    async refreshUsed() {
        if (this.refreshPromise) return this.refreshPromise;

        this.refreshPromise = (async () => {
            try {
                await this.getManifest(true);
                for (const id of Array.from(this.used)) {
                    try {
                        await this.refreshFunction(id, false);
                    } catch (err) {
                        this.emit("function-warning", id, err);
                    }
                }
            } finally {
                this.refreshPromise = null;
            }
        })();

        return this.refreshPromise;
    }

    async execute(id, ctx) {
        const fn = await this.ensureLoaded(id);
        return await fn(ctx);
    }

    getState(id) {
        return this.state.functions[id] || null;
    }
}

module.exports = {
    RemoteManager,
    DEFAULT_MANIFEST_URL,
    DEFAULT_INTERVAL_MS
};
