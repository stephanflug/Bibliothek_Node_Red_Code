"use strict";

module.exports = async function run(ctx) {
    const { msg, node, flow, global, config = {} } = ctx;

    const VERSION = "1.0.0";

    function n(value, fallback) {
        if (typeof value === "string") value = value.replace(",", ".").trim();
        const x = Number(value);
        return Number.isFinite(x) ? x : fallback;
    }

    function b(value, fallback) {
        if (typeof value === "boolean") return value;
        if (value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
        if (value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
        return fallback;
    }

    const CFG = {
        heizGrenze: n(config.heizGrenze, 8.0),
        kuehlGrenze: n(config.kuehlGrenze, 13.0),
        einSchwelle: n(config.einSchwelle, 1.2),
        ausSchwelle: n(config.ausSchwelle, 0.4),
        minSchaltzeitMinuten: Math.max(0, n(config.minSchaltzeitMinuten, 120)),
        gebaeudeKonstante: Math.max(0.01, n(config.gebaeudeKonstante, 0.5)),
        wechselAbstand: Math.max(0, n(config.wechselAbstand, 0.5)),
        gewichte: [
            Math.max(0, n(config.gewichtTag1, 0.40)),
            Math.max(0, n(config.gewichtTag2, 0.25)),
            Math.max(0, n(config.gewichtTag3, 0.18)),
            Math.max(0, n(config.gewichtTag4, 0.10)),
            Math.max(0, n(config.gewichtTag5, 0.07))
        ],
        kuehlVorstartAktiv: b(config.kuehlVorstartAktiv, true),
        kuehlVorstartTemp: n(config.kuehlVorstartTemp, 17.0),
        kuehlVorstartTage: Math.min(5, Math.max(1, Math.round(n(config.kuehlVorstartTage, 3)))),
        kuehlVorstartScore: Math.max(0, n(config.kuehlVorstartScore, 1.4)),
        kaltNachtAbstandK: Math.max(0, n(config.kaltNachtAbstandK, 3.0)),
        kaltNachtBonus: Math.max(0, n(config.kaltNachtBonus, 0.5)),
        warmGrenze27: n(config.warmGrenze27, 27.0),
        warmGrenze28: n(config.warmGrenze28, 28.0),
        warmGrenze29: n(config.warmGrenze29, 29.0),
        warmGrenze30: n(config.warmGrenze30, 30.0),
        bonusNahe27Zwei: Math.max(0, n(config.bonusNahe27Zwei, 0.3)),
        bonusNahe28Eins: Math.max(0, n(config.bonusNahe28Eins, 0.4)),
        bonusNahe28Zwei: Math.max(0, n(config.bonusNahe28Zwei, 0.6)),
        bonusNahe29Eins: Math.max(0, n(config.bonusNahe29Eins, 0.5)),
        bonusNahe29Zwei: Math.max(0, n(config.bonusNahe29Zwei, 0.7)),
        bonusNahe30Eins: Math.max(0, n(config.bonusNahe30Eins, 1.0)),
        bonusGesamt28Drei: Math.max(0, n(config.bonusGesamt28Drei, 0.4)),
        bonusGesamt29Zwei: Math.max(0, n(config.bonusGesamt29Zwei, 0.4))
    };

    if (CFG.ausSchwelle > CFG.einSchwelle) {
        node.warn("Heizen/Kühlen Wetter: Ausschaltschwelle ist größer als Einschaltschwelle. Hysterese prüfen.");
    }

    if (CFG.gewichte.reduce((sum, x) => sum + x, 0) <= 0) {
        CFG.gewichte = [0.40, 0.25, 0.18, 0.10, 0.07];
        node.warn("Heizen/Kühlen Wetter: Alle Tagesgewichtungen waren 0. Standardgewichtung wird verwendet.");
    }

    const tage = [];

    for (let i = 1; i <= 5; i++) {
        const maxRaw = flow.get(`TAG_${i}_Temp_max`);
        const minRaw = flow.get(`TAG_${i}_Temp_min`);
        const maxFallback = flow.get(`Tag_${i}_Temp_max`);
        const minFallback = flow.get(`Tag_${i}_Temp_min`);

        const tMax = n(maxRaw !== undefined && maxRaw !== null ? maxRaw : maxFallback, NaN);
        const tMin = n(minRaw !== undefined && minRaw !== null ? minRaw : minFallback, NaN);

        if (Number.isFinite(tMax) && Number.isFinite(tMin)) {
            tage.push({
                tag: i,
                min: tMin,
                max: tMax,
                mittel: (tMin + tMax) / 2
            });
        }
    }

    if (tage.length === 0) {
        const alterModus = flow.get("HK_Modus") || "aus";
        const info = {
            modus: "aus",
            vorher: alterModus,
            geaendert: alterModus !== "aus",
            grund: "Keine gültigen Temperaturdaten im flow context gefunden",
            remote_function_version: VERSION
        };

        flow.set("HK_Modus", "aus");
        flow.set("HK_Heizen", false);
        flow.set("HK_Kuehlen", false);
        flow.set("HK_Aus", true);
        flow.set("HK_Info", info);

        node.status({
            fill: "yellow",
            shape: "ring",
            text: "AUS | keine gültigen Temperaturdaten"
        });

        return [
            { ...msg, payload: false, info },
            { ...msg, payload: false, info },
            { ...msg, payload: true, info }
        ];
    }

    let gewichtSumme = 0;
    let prognoseMittel = 0;

    for (let i = 0; i < tage.length; i++) {
        const gewicht = CFG.gewichte[tage[i].tag - 1] ?? 0.05;
        prognoseMittel += tage[i].mittel * gewicht;
        gewichtSumme += gewicht;
    }

    if (gewichtSumme <= 0) {
        prognoseMittel = tage.reduce((sum, t) => sum + t.mittel, 0) / tage.length;
    } else {
        prognoseMittel /= gewichtSumme;
    }

    const minGesamt = Math.min(...tage.map(t => t.min));
    const maxGesamt = Math.max(...tage.map(t => t.max));

    const warmeTage27 = tage.filter(t => t.max >= CFG.warmGrenze27).length;
    const warmeTage28 = tage.filter(t => t.max >= CFG.warmGrenze28).length;
    const warmeTage29 = tage.filter(t => t.max >= CFG.warmGrenze29).length;
    const warmeTage30 = tage.filter(t => t.max >= CFG.warmGrenze30).length;

    const naheTage = tage.filter(t => t.tag <= CFG.kuehlVorstartTage);
    const naheWarmeTage27 = naheTage.filter(t => t.max >= CFG.warmGrenze27).length;
    const naheWarmeTage28 = naheTage.filter(t => t.max >= CFG.warmGrenze28).length;
    const naheWarmeTage29 = naheTage.filter(t => t.max >= CFG.warmGrenze29).length;
    const naheWarmeTage30 = naheTage.filter(t => t.max >= CFG.warmGrenze30).length;

    let kuehlVorstart = false;
    let kuehlVorstartGrund = "";
    let ersterWarmerTag = null;

    if (CFG.kuehlVorstartAktiv) {
        ersterWarmerTag = naheTage.find(t => t.max >= CFG.kuehlVorstartTemp) || null;

        if (ersterWarmerTag) {
            kuehlVorstart = true;
            kuehlVorstartGrund =
                `Vorstart Kühlen: Tag ${ersterWarmerTag.tag} erreicht ${ersterWarmerTag.max}°C`;
        }
    }

    let heizScore = Math.max(
        0,
        (CFG.heizGrenze - prognoseMittel) * CFG.gebaeudeKonstante
    );

    if (minGesamt < CFG.heizGrenze - CFG.kaltNachtAbstandK) {
        heizScore += CFG.kaltNachtBonus * CFG.gebaeudeKonstante;
    }

    let kuehlScore = Math.max(
        0,
        (prognoseMittel - CFG.kuehlGrenze) * CFG.gebaeudeKonstante
    );

    const kuehlGruende = [];

    if (kuehlVorstart) {
        kuehlScore += CFG.kuehlVorstartScore * CFG.gebaeudeKonstante;
        kuehlGruende.push(kuehlVorstartGrund);
    }

    if (naheWarmeTage27 >= 2) {
        kuehlScore += CFG.bonusNahe27Zwei * CFG.gebaeudeKonstante;
        kuehlGruende.push("mehrere nahe Tage >= 27°C");
    }
    if (naheWarmeTage28 >= 1) {
        kuehlScore += CFG.bonusNahe28Eins * CFG.gebaeudeKonstante;
        kuehlGruende.push("naher Tag >= 28°C");
    }
    if (naheWarmeTage28 >= 2) {
        kuehlScore += CFG.bonusNahe28Zwei * CFG.gebaeudeKonstante;
        kuehlGruende.push("mehrere nahe Tage >= 28°C");
    }
    if (naheWarmeTage29 >= 1) {
        kuehlScore += CFG.bonusNahe29Eins * CFG.gebaeudeKonstante;
        kuehlGruende.push("naher Tag >= 29°C");
    }
    if (naheWarmeTage29 >= 2) {
        kuehlScore += CFG.bonusNahe29Zwei * CFG.gebaeudeKonstante;
        kuehlGruende.push("mehrere nahe Tage >= 29°C");
    }
    if (naheWarmeTage30 >= 1) {
        kuehlScore += CFG.bonusNahe30Eins * CFG.gebaeudeKonstante;
        kuehlGruende.push("naher Tag >= 30°C");
    }
    if (warmeTage28 >= 3) {
        kuehlScore += CFG.bonusGesamt28Drei * CFG.gebaeudeKonstante;
        kuehlGruende.push("mehrere warme Tage in der 5-Tage-Prognose");
    }
    if (warmeTage29 >= 2) {
        kuehlScore += CFG.bonusGesamt29Zwei * CFG.gebaeudeKonstante;
        kuehlGruende.push("mehrere sehr warme Tage in der 5-Tage-Prognose");
    }

    let alterModus = flow.get("HK_Modus") || "aus";

    if (!["heizen", "kuehlen", "aus"].includes(alterModus)) {
        alterModus = "aus";
    }

    const letzteSchaltung = Number(flow.get("HK_LetzteSchaltung") || 0);
    const jetzt = Date.now();
    const minSchaltzeitMs = CFG.minSchaltzeitMinuten * 60 * 1000;
    const darfSchalten = (jetzt - letzteSchaltung) >= minSchaltzeitMs;

    let neuerModus = alterModus;
    let grund = "";

    if (alterModus === "heizen") {
        if (
            kuehlScore >= CFG.einSchwelle &&
            kuehlScore > heizScore + CFG.wechselAbstand &&
            darfSchalten
        ) {
            neuerModus = "kuehlen";
            grund = "Kühlbedarf überwiegt deutlich, Wechsel von Heizen auf Kühlen";
        } else if (heizScore <= CFG.ausSchwelle && darfSchalten) {
            neuerModus = "aus";
            grund = "Heizbedarf unter Ausschaltschwelle";
        } else {
            neuerModus = "heizen";
            grund = "Heizen bleibt aktiv wegen Hysterese oder Sperrzeit";
        }
    } else if (alterModus === "kuehlen") {
        if (
            heizScore >= CFG.einSchwelle &&
            heizScore > kuehlScore + CFG.wechselAbstand &&
            darfSchalten
        ) {
            neuerModus = "heizen";
            grund = "Heizbedarf überwiegt deutlich, Wechsel von Kühlen auf Heizen";
        } else if (kuehlScore <= CFG.ausSchwelle && darfSchalten) {
            neuerModus = "aus";
            grund = "Kühlbedarf unter Ausschaltschwelle";
        } else {
            neuerModus = "kuehlen";
            grund = "Kühlen bleibt aktiv wegen Hysterese oder Sperrzeit";
        }
    } else {
        if (
            kuehlScore >= CFG.einSchwelle &&
            kuehlScore > heizScore + CFG.wechselAbstand &&
            darfSchalten
        ) {
            neuerModus = "kuehlen";
            grund = kuehlVorstart
                ? "Vorausschauendes Kühlen: Es wird in den nächsten Tagen warm"
                : "Kühlbedarf über Einschaltschwelle";
        } else if (
            heizScore >= CFG.einSchwelle &&
            heizScore > kuehlScore + CFG.wechselAbstand &&
            darfSchalten
        ) {
            neuerModus = "heizen";
            grund = "Heizbedarf über Einschaltschwelle";
        } else {
            neuerModus = "aus";
            grund = "Kein ausreichender Heiz- oder Kühlbedarf";
        }
    }

    const geaendert = neuerModus !== alterModus;

    if (geaendert) {
        flow.set("HK_LetzteSchaltung", jetzt);
    }

    const heizen = neuerModus === "heizen";
    const kuehlen = neuerModus === "kuehlen";
    const aus = neuerModus === "aus";

    flow.set("HK_Modus", neuerModus);
    flow.set("HK_Heizen", heizen);
    flow.set("HK_Kuehlen", kuehlen);
    flow.set("HK_Aus", aus);
    flow.set("HK_HeizScore", Number(heizScore.toFixed(2)));
    flow.set("HK_KuehlScore", Number(kuehlScore.toFixed(2)));
    flow.set("HK_PrognoseMittel", Number(prognoseMittel.toFixed(1)));
    flow.set("HK_KuehlVorstart", kuehlVorstart);

    const info = {
        modus: neuerModus,
        vorher: alterModus,
        geaendert,
        prognoseMittel: Number(prognoseMittel.toFixed(1)),
        minGesamt: Number(minGesamt.toFixed(1)),
        maxGesamt: Number(maxGesamt.toFixed(1)),
        warmeTage27,
        warmeTage28,
        warmeTage29,
        warmeTage30,
        naheWarmeTage27,
        naheWarmeTage28,
        naheWarmeTage29,
        naheWarmeTage30,
        kuehlVorstart,
        kuehlVorstartGrund,
        ersterWarmerTag,
        heizScore: Number(heizScore.toFixed(2)),
        kuehlScore: Number(kuehlScore.toFixed(2)),
        kuehlGruende,
        darfSchalten,
        minSchaltzeitMinuten: CFG.minSchaltzeitMinuten,
        gebaeudeKonstante: CFG.gebaeudeKonstante,
        grund,
        tage,
        config: {
            heizGrenze: CFG.heizGrenze,
            kuehlGrenze: CFG.kuehlGrenze,
            einSchwelle: CFG.einSchwelle,
            ausSchwelle: CFG.ausSchwelle,
            minSchaltzeitMinuten: CFG.minSchaltzeitMinuten,
            gebaeudeKonstante: CFG.gebaeudeKonstante,
            wechselAbstand: CFG.wechselAbstand,
            gewichte: CFG.gewichte,
            kuehlVorstartAktiv: CFG.kuehlVorstartAktiv,
            kuehlVorstartTemp: CFG.kuehlVorstartTemp,
            kuehlVorstartTage: CFG.kuehlVorstartTage,
            kuehlVorstartScore: CFG.kuehlVorstartScore,
            kaltNachtAbstandK: CFG.kaltNachtAbstandK,
            kaltNachtBonus: CFG.kaltNachtBonus,
            warmGrenzen: [CFG.warmGrenze27, CFG.warmGrenze28, CFG.warmGrenze29, CFG.warmGrenze30],
            bonusNahe27Zwei: CFG.bonusNahe27Zwei,
            bonusNahe28Eins: CFG.bonusNahe28Eins,
            bonusNahe28Zwei: CFG.bonusNahe28Zwei,
            bonusNahe29Eins: CFG.bonusNahe29Eins,
            bonusNahe29Zwei: CFG.bonusNahe29Zwei,
            bonusNahe30Eins: CFG.bonusNahe30Eins,
            bonusGesamt28Drei: CFG.bonusGesamt28Drei,
            bonusGesamt29Zwei: CFG.bonusGesamt29Zwei
        },
        remote_function_version: VERSION
    };

    flow.set("HK_Info", info);

    global.set("HK_Modus", neuerModus);
    global.set("HK_Heizen", heizen);
    global.set("HK_Kuehlen", kuehlen);
    global.set("HK_Aus", aus);
    global.set("HK_HeizScore", info.heizScore);
    global.set("HK_KuehlScore", info.kuehlScore);
    global.set("HK_PrognoseMittel", info.prognoseMittel);
    global.set("HK_KuehlVorstart", kuehlVorstart);

    const wechselText = geaendert ? "Wechsel" : "gleich";
    const vorstartText = kuehlVorstart ? " | Vorstart" : "";
    const statusText =
        `${neuerModus.toUpperCase()} | ${wechselText}${vorstartText} | ` +
        `Ø ${info.prognoseMittel}°C | ` +
        `Min ${info.minGesamt}°C / Max ${info.maxGesamt}°C | ` +
        `H:${info.heizScore} K:${info.kuehlScore}`;

    if (neuerModus === "heizen") {
        node.status({ fill: "red", shape: "dot", text: statusText });
    } else if (neuerModus === "kuehlen") {
        node.status({ fill: "blue", shape: "dot", text: statusText });
    } else {
        node.status({ fill: "grey", shape: "ring", text: statusText });
    }

    return [
        { ...msg, payload: heizen, info },
        { ...msg, payload: kuehlen, info },
        { ...msg, payload: aus, info }
    ];
};
