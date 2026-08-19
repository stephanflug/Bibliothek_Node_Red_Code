"use strict";

module.exports = async function run(ctx) {
    const { msg, node, global, config = {} } = ctx;
    const SOURCE_URL = "https://cdn3.techweb.at/api/weather/at/data?province=tirol&format=json";

    function fetchJson(url, redirects = 0) {
        const https = require("https");
        return new Promise((resolve, reject) => {
            if (redirects > 5) return reject(new Error("Zu viele HTTP-Weiterleitungen"));
            const req = https.get(url, {
                headers: {
                    "User-Agent": "EBST-NodeRED-Remote-Function/1.1",
                    "Accept": "application/json"
                },
                timeout: 15000
            }, res => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    return fetchJson(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
                }
                if (status !== 200) {
                    res.resume();
                    return reject(new Error(`Techweb Wetter API: HTTP ${status}`));
                }
                res.setEncoding("utf8");
                let body = "";
                res.on("data", chunk => {
                    body += chunk;
                    if (body.length > 2 * 1024 * 1024) {
                        req.destroy(new Error("Techweb Wetter API Antwort ist größer als 2 MB"));
                    }
                });
                res.on("end", () => {
                    try { resolve(JSON.parse(body)); }
                    catch (err) { reject(new Error("Techweb Wetter API liefert kein gültiges JSON: " + err.message)); }
                });
            });
            req.on("timeout", () => req.destroy(new Error("Techweb Wetter API Timeout")));
            req.on("error", reject);
        });
    }

    function number(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function round2(value) {
        return Number.isFinite(value)
            ? Math.round((value + Number.EPSILON) * 100) / 100
            : null;
    }

    function getSelector() {
        const values = [
            msg.station,
            msg.stationIndex,
            config.stationIndex,
            msg.StationsnummerObject,
            global.get("wetter_station"),
            global.get("StationsnummerObject")
        ];
        for (const value of values) {
            if (value !== undefined && value !== null && String(value).trim() !== "") return value;
        }
        return 13;
    }

    function selectStation(list, selector) {
        const raw = String(selector).trim();

        if (/^\d+$/.test(raw)) {
            const index = Number(raw);
            return index >= 0 && index < list.length ? { station: list[index], index } : null;
        }

        const needle = raw.toLocaleLowerCase("de-DE");
        let index = list.findIndex(item =>
            String(item.station_id || "").toLocaleLowerCase("de-DE") === needle ||
            String(item.location || "").toLocaleLowerCase("de-DE") === needle
        );

        if (index < 0) {
            const hits = [];
            list.forEach((item, i) => {
                if (String(item.location || "").toLocaleLowerCase("de-DE").includes(needle)) hits.push(i);
            });
            if (hits.length === 1) index = hits[0];
        }

        return index >= 0 ? { station: list[index], index } : null;
    }

    let apiData = msg.payload;

    if (!apiData || typeof apiData !== "object" || !Array.isArray(apiData.weather_data)) {
        apiData = await fetchJson(SOURCE_URL);
    }

    if (!apiData || !Array.isArray(apiData.weather_data)) {
        throw new Error("Techweb Wetter API: weather_data fehlt");
    }

    const list = apiData.weather_data;
    const stationsliste = list.map((station, index) => `${index} – ${station.location || "Unbekannt"}`);
    global.set("stationsliste", stationsliste);

    const selector = getSelector();
    const selected = selectStation(list, selector);

    if (!selected) {
        throw new Error(`Wetterstation '${selector}' nicht gefunden. Verfügbar sind ${list.length} Stationen.`);
    }

    const data = selected.station;
    const temperature = round2(number(data.temperature, NaN));
    const humidity = round2(number(data.humidity, NaN));
    const sun = round2(number(data.sun_w !== undefined ? data.sun_w : data.sun, 0));
    const windSpeed = round2(number(data.wind_speed, NaN));
    const windDirection = data.wind_direction !== undefined && data.wind_direction !== null
        ? data.wind_direction
        : null;
    const rain = round2(number(data.raindown, 0));
    const snow = round2(number(data.snow, 0));
    const airpressure = round2(number(
        data.airpressure_trend !== undefined ? data.airpressure_trend : data.airpressure,
        NaN
    ));

    if (!Number.isFinite(temperature)) {
        throw new Error(`Wetterstation '${data.location || selector}': Temperatur fehlt`);
    }

    let condition;
    if (rain > 0.1 && temperature > 1) condition = "Regen";
    else if (rain > 0.1 && temperature <= 1) condition = "Schneeregen";
    else if (snow > 0 && temperature <= 1) condition = "Schnee";
    else if (sun > 400) condition = "sonnig";
    else if (sun > 150) condition = "überwiegend sonnig";
    else if (sun > 50) condition = "aufgelockert bewölkt";
    else if (sun > 10) condition = "wolkig";
    else if (humidity > 90) condition = "bedeckt / nebelig";
    else condition = "bedeckt";

    global.set("wetterzustand", condition);
    global.set("wetter_temp", temperature);
    global.set("wetter_rain", rain);
    global.set("wetter_sun", sun);
    global.set("wetter_humidity", humidity);
    global.set("wetter_snow", snow);
    global.set("wetter_wind_Speed", windSpeed);
    global.set("wetter_wind_direction", windDirection);
    global.set("wetter_Luftdruck", airpressure);
    global.set("wetter_station", selected.index);

    const now = new Date().toISOString();
    global.set("wetter_station_aktuell", {
        index: selected.index,
        station_id: data.station_id || null,
        location: data.location || null,
        updated_at: now
    });

    msg.topic = "wetterdaten";
    msg.payload = {
        source: SOURCE_URL,
        station: {
            index: selected.index,
            station_id: data.station_id || null,
            location: data.location || null,
            state: data.state || data.province || null,
            altitude: data.altitude !== undefined ? data.altitude : null
        },
        temperature,
        humidity,
        sun_w: sun,
        wind_speed: windSpeed,
        wind_direction: windDirection,
        rain_mm: rain,
        snow,
        airpressure,
        condition,
        weather_time: data.weather_time || null,
        weather_timestamp: data.weather_timestamp || null,
        updated_at: now
    };

    node.status({
        fill: "green",
        shape: "dot",
        text: `${selected.index} · ${data.location || "Station"}: ${temperature} °C · ${condition}`
    });

    return msg;
};
