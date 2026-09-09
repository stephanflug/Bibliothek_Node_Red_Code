"use strict";

module.exports = async function run(ctx) {
    const { msg, node, flow } = ctx;

    const TIMEZONE = "Europe/Vienna";
    const BASIS_INNEN_C = 20;
    const HEIZGRENZE_C = 12;
    const VERSION = "1.0.0";

    function getDateStringVienna(date = new Date()) {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: TIMEZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).formatToParts(date);

        const y = parts.find(p => p.type === "year").value;
        const m = parts.find(p => p.type === "month").value;
        const d = parts.find(p => p.type === "day").value;

        return `${y}-${m}-${d}`;
    }

    function round(value, decimals = 2) {
        if (!Number.isFinite(value)) return null;
        const factor = Math.pow(10, decimals);
        return Math.round((value + Number.EPSILON) * factor) / factor;
    }

    let aussentemperaturC = msg.payload;

    if (typeof aussentemperaturC === "string") {
        aussentemperaturC = aussentemperaturC.replace(",", ".");
    }

    aussentemperaturC = Number(aussentemperaturC);

    if (!Number.isFinite(aussentemperaturC)) {
        msg.payload = {
            error: true,
            message: "msg.payload ist keine gültige Außentemperatur",
            remote_function_version: VERSION
        };

        node.status({
            fill: "red",
            shape: "ring",
            text: "Keine gültige Temperatur"
        });

        return msg;
    }

    const heute = getDateStringVienna();

    let daten = flow.get("hgtHeuteDaten");

    if (!daten || daten.datum !== heute) {
        daten = {
            datum: heute,
            summeAussenC: 0,
            anzahlMessungen: 0,
            minAussenC: null,
            maxAussenC: null
        };
    }

    daten.summeAussenC += aussentemperaturC;
    daten.anzahlMessungen += 1;

    daten.minAussenC = daten.minAussenC === null
        ? aussentemperaturC
        : Math.min(daten.minAussenC, aussentemperaturC);

    daten.maxAussenC = daten.maxAussenC === null
        ? aussentemperaturC
        : Math.max(daten.maxAussenC, aussentemperaturC);

    const tagesmittelAussenC = daten.summeAussenC / daten.anzahlMessungen;

    let heizgradtageHeuteK = 0;
    if (tagesmittelAussenC <= HEIZGRENZE_C) {
        heizgradtageHeuteK = BASIS_INNEN_C - tagesmittelAussenC;
    }

    const heuteHeizenNoetig = tagesmittelAussenC <= HEIZGRENZE_C;

    flow.set("hgtHeuteDaten", daten);
    flow.set("aussentemperaturC", round(aussentemperaturC, 2));
    flow.set("tagesmittelAussenC", round(tagesmittelAussenC, 2));
    flow.set("heizgradtageHeuteK", round(heizgradtageHeuteK, 2));
    flow.set("istHeiztagHGT", heuteHeizenNoetig);
    flow.set("heuteHeizenNoetig", heuteHeizenNoetig);

    msg.payload = {
        datum: heute,
        standard: "HGT 20/12",
        basisInnenC: BASIS_INNEN_C,
        heizgrenzeC: HEIZGRENZE_C,
        aussentemperaturAktuellC: round(aussentemperaturC, 2),
        tagesmittelAussenC: round(tagesmittelAussenC, 2),
        heizgradtageHeuteK: round(heizgradtageHeuteK, 2),
        istHeiztagHGT: heuteHeizenNoetig,
        heuteHeizenNoetig,
        messungenHeute: daten.anzahlMessungen,
        minAussenC: round(daten.minAussenC, 2),
        maxAussenC: round(daten.maxAussenC, 2),
        remote_function_version: VERSION
    };

    node.status({
        fill: heuteHeizenNoetig ? "blue" : "grey",
        shape: "dot",
        text: heuteHeizenNoetig
            ? `Heizen nötig | HGT: ${round(heizgradtageHeuteK, 2)}`
            : `Heizen nicht nötig | Mittel: ${round(tagesmittelAussenC, 2)} °C`
    });

    return msg;
};
