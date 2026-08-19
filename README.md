# Bibliothek_Node_Red_Code

Zentrale Code-Bibliothek für mehrere Node-RED-Installationen.

## Ziel

- ein universeller Node: **EBST Node Red Remote Funktion**
- Funktionen zentral auf GitHub pflegen
- bestehende Funktionen automatisch auf den Anlagen aktualisieren
- nur tatsächlich verwendete Funktionen laden
- letzte gültige Version lokal zwischenspeichern
- kein Deploy und kein Node-RED-Neustart bei Änderungen an Remote-Funktionen

## Erste Remote-Funktion

`orf-innsbruck` – robuster Parser für die ORF-Tirol-Wetterprognose Innsbruck.

## Repository-Struktur

```text
Bibliothek_Node_Red_Code/
├── package.json
├── ebst-remote-function.js
├── ebst-remote-function.html
├── lib/
│   └── remote-manager.js
└── remote/
    ├── manifest.json
    └── functions/
        └── wetter/
            └── orf-innsbruck.js
```

## Installation des universellen Nodes

Einmalig im Node-RED-User-Verzeichnis:

```bash
npm install https://github.com/stephanflug/Bibliothek_Node_Red_Code.git
```

Danach Node-RED einmal neu starten.

Ab diesem Zeitpunkt werden Änderungen an vorhandenen Dateien unter `remote/functions/` automatisch übernommen.

## Neue Funktion hinzufügen

1. Neue JavaScript-Datei unter `remote/functions/<kategorie>/` anlegen.
2. Funktion in `remote/manifest.json` ergänzen.
3. Commit/Push nach `main`.
4. Beim nächsten Öffnen eines **EBST Node Red Remote Funktion** Nodes erscheint die neue Funktion in der Auswahl.

Eine Remote-Funktion hat dieses Grundformat:

```javascript
"use strict";

module.exports = async function run(ctx) {
    const { msg, node, context, flow, global, RED } = ctx;

    // eigener Code

    return msg;
};
```

## Automatische Aktualisierung

Standardmäßig wird alle 15 Minuten geprüft. Für jede verwendete Funktion wird der Inhalt heruntergeladen und per SHA-256 mit der lokal aktiven Version verglichen. Nur bei einer tatsächlichen Änderung wird die neue Datei geladen.

Eine neue Version wird erst aktiv, wenn sie als Node.js-Modul erfolgreich geladen werden konnte. Schlägt das fehl, bleibt die letzte gültige Cache-Version aktiv.

## Sicherheit

Remote-Code besitzt dieselben Rechte wie der Node-RED-Prozess. Deshalb dürfen nur Funktionen aus einem Repository verwendet werden, dessen Schreibzugänge vertrauenswürdig abgesichert sind.
