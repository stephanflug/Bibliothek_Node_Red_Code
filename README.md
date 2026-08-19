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

Die stabile Basisversion wird **einmalig** über den GitHub-Release installiert.

### Version V1.0.0

Im Node-RED-User-Verzeichnis:

```bash
cd ~/.node-red
npm install https://github.com/stephanflug/Bibliothek_Node_Red_Code/releases/download/V1.0.0/node-red-contrib-ebst-remote-function-1.0.0.tgz
```

Danach Node-RED einmal neu starten, zum Beispiel:

```bash
sudo systemctl restart nodered
```

Anschließend steht in der Node-RED-Palette der Node **EBST Node Red Remote Funktion** zur Verfügung.

**Wichtig:** Das Installationspaket muss für normale Änderungen an Remote-Funktionen nicht erneut installiert werden. Änderungen an vorhandenen Funktionen unter `remote/functions/` werden automatisch übernommen.

## Release und Remote-Code sind getrennt

```text
GitHub Release V1.0.0
└── node-red-contrib-ebst-remote-function-1.0.0.tgz
    └── einmalige Basisinstallation

main
└── remote/
    ├── manifest.json
    └── functions/
        └── automatische Funktionsupdates
```

Ein neuer GitHub-Release ist nur erforderlich, wenn der universelle Basis-Node selbst technisch geändert werden muss, zum Beispiel die Update-Mechanik, Cache-Mechanik oder Editor-Oberfläche.

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

## Stabile Basisversion 1.0.0

**Diese Version wird pro Node-RED-Installation nur einmal installiert.**

Danach werden normale Funktionsänderungen ausschließlich über diese Bereiche verteilt:

```text
remote/manifest.json
remote/functions/...
```

Dafür ist **keine erneute Installation des Node-Pakets** erforderlich. Der Remote-Manager prüft die tatsächlich verwendeten Funktionen standardmäßig alle 15 Minuten, lädt Änderungen herunter und verwendet bei Fehlern die letzte gültige lokale Cache-Version.

### Wichtige Schnittstellenregel

Bei einer bereits eingesetzten Remote-Funktion sollten Anzahl und Bedeutung der Ausgänge stabil bleiben. Reine Codeänderungen werden automatisch übernommen. Eine spätere Änderung der Ausgangszahl verändert jedoch die Flow-Verdrahtung und erfordert deshalb eine bewusste Anpassung/Deploy des betroffenen Flows.
