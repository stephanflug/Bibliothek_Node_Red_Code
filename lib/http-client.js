"use strict";

const { CookieJar } = require("tough-cookie");

let gotLoader = null;

async function loadGot() {
    if (!gotLoader) {
        gotLoader = import("got").then(mod => mod.got || mod.default);
    }
    return gotLoader;
}

function toPositiveInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

function createHttpClient(defaults = {}) {
    const defaultTimeoutMs = toPositiveInt(defaults.timeoutMs, 120000, 1, 10 * 60 * 1000);
    const defaultMaxBodyBytes = toPositiveInt(defaults.maxBodyBytes, 6 * 1024 * 1024, 1024, 100 * 1024 * 1024);

    async function request(options = {}) {
        const url = String(options.url || "").trim();
        if (!/^https?:\/\//i.test(url)) {
            throw new Error("EBST HTTP: URL muss mit http:// oder https:// beginnen");
        }

        const got = await loadGot();
        const timeoutMs = toPositiveInt(options.timeoutMs, defaultTimeoutMs, 1, 10 * 60 * 1000);
        const maxBodyBytes = toPositiveInt(options.maxBodyBytes, defaultMaxBodyBytes, 1024, 100 * 1024 * 1024);
        const responseType = String(options.responseType || "text").toLowerCase();
        const redirectList = [];
        const cookieJar = options.cookieJar || new CookieJar();

        const gotOptions = {
            method: String(options.method || "GET").toUpperCase(),
            timeout: { request: timeoutMs },
            throwHttpErrors: false,
            decompress: options.decompress === true,
            retry: { limit: 0 },
            responseType: "buffer",
            maxRedirects: toPositiveInt(options.maxRedirects, 21, 0, 50),
            cookieJar,
            ignoreInvalidCookies: true,
            hooks: {
                beforeRedirect: [
                    (redirectOptions, response) => {
                        redirectList.push({
                            statusCode: response.statusCode,
                            location: response.headers && response.headers.location ? response.headers.location : null
                        });
                    }
                ]
            }
        };

        if (options.followRedirects === false) gotOptions.followRedirect = false;
        if (options.headers && typeof options.headers === "object") gotOptions.headers = { ...options.headers };
        if (options.searchParams !== undefined) gotOptions.searchParams = options.searchParams;
        if (options.body !== undefined) gotOptions.body = options.body;
        if (options.json !== undefined) gotOptions.json = options.json;
        if (options.username !== undefined || options.password !== undefined) {
            gotOptions.username = options.username !== undefined ? String(options.username) : "";
            gotOptions.password = options.password !== undefined ? String(options.password) : "";
        }
        if (options.rejectUnauthorized === false) {
            gotOptions.https = { rejectUnauthorized: false };
        }

        const response = await got(url, gotOptions);
        const buffer = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || "");

        if (buffer.length > maxBodyBytes) {
            throw new Error(`EBST HTTP: Antwort ist größer als ${maxBodyBytes} Bytes`);
        }

        let body;
        if (responseType === "buffer" || responseType === "bin" || responseType === "binary") {
            body = buffer;
        } else {
            const text = buffer.toString("utf8");
            if (responseType === "json" || responseType === "obj" || responseType === "object") {
                try {
                    body = text ? JSON.parse(text) : null;
                } catch (err) {
                    throw new Error("EBST HTTP: Ungültiges JSON: " + err.message);
                }
            } else {
                body = text;
            }
        }

        return {
            statusCode: response.statusCode,
            headers: response.headers || {},
            url: response.url || url,
            body,
            payload: body,
            ok: response.statusCode >= 200 && response.statusCode < 300,
            redirectList,
            cookieJar
        };
    }

    return { request };
}

module.exports = { createHttpClient };
