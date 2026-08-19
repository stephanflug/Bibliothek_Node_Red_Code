# Bibliothek_Node_Red_Code

Diese Bibliothek stellt zentrale Funktionen für Node-RED bereit.

Der Node **EBST Node Red Remote Funktion** wird einmal installiert. Danach werden die verwendeten Funktionen automatisch von GitHub geladen und aktualisiert.

## Installation

Im Node-RED-Verzeichnis ausführen:

```bash
cd ~/.node-red
npm install https://github.com/stephanflug/Bibliothek_Node_Red_Code/releases/download/V1.0.0/node-red-contrib-ebst-remote-function-1.0.0.tgz
```

Danach Node-RED einmal neu starten:

```bash
sudo systemctl restart nodered
```

## Verwendung

Nach der Installation steht in Node-RED der Node

**EBST Node Red Remote Funktion**

zur Verfügung.

Den Node in den Flow ziehen und die gewünschte Funktion auswählen.

Aktuell verfügbar:

- **ORF Wetter Innsbruck**
- **Techweb Wetterdaten Tirol**

Bei **Techweb Wetterdaten Tirol** wird standardmäßig Station **Index 13** verwendet. Eine andere Station kann über `msg.station`, `msg.stationIndex` oder `msg.StationsnummerObject` angegeben werden. Auch Stationsname oder `station_id` können verwendet werden.

## Automatische Updates

Änderungen an den zentralen Funktionen werden automatisch übernommen.

Für normale Funktionsupdates ist daher kein erneutes Installieren des Pakets und kein manuelles Ändern der Function Nodes notwendig.

Sollte GitHub vorübergehend nicht erreichbar sein, wird die zuletzt funktionierende lokale Version weiterverwendet.

## Version

Basis-Node: **V1.0.0**
