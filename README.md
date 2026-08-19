# Bibliothek_Node_Red_Code

Diese Bibliothek stellt zentrale Funktionen für Node-RED bereit.

Der Node **EBST Node Red Remote Funktion** wird einmal als Basis installiert. Danach werden Funktionen, Einstellungen und Datenpunktbeschreibungen automatisch aus GitHub geladen.

## Installation

Installationspaket **V1.3.0** im Node-RED-Verzeichnis installieren und Node-RED danach einmal neu starten.

## Verwendung

Den Node **EBST Node Red Remote Funktion** in den Flow ziehen und die gewünschte Funktion auswählen.

Die benötigten Einstellungen werden passend zur gewählten Funktion automatisch angezeigt, zum Beispiel:

- Wetterstation
- Breitengrad / Längengrad
- zukünftige Text-, Zahlen-, Auswahl- oder JA/NEIN-Einstellungen

## Datenpunkte

Im Node wird unter **Verfügbare Datenpunkte** direkt angezeigt, wie auf die Ergebnisse zugegriffen wird.

Beispiel Sonnenstand:

```text
msg.payload.azimuthDegrees
msg.payload.altitudeDegrees
msg.payload.times.sunrise.value
msg.payload.times.sunset.value
msg.payload.times.solarNoon.value
```

Auch vorhandene Global-Context-Werte werden dort beschrieben.

## Automatische Erweiterungen

Neue Funktionen, neue Einstellungen, neue Auswahllisten und neue Datenpunktbeschreibungen können künftig über `remote/manifest.json` ergänzt werden. Dafür ist keine erneute Installation des Basis-Pakets erforderlich.

Nur wenn der eigentliche Mechanismus des Basis-Nodes geändert wird, ist eine neue Basisversion notwendig.

## Version

Basis-Node: **V1.3.0**
