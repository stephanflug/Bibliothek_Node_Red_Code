# EBST Node Red Remote Funktion

Zentrale Funktionsbibliothek für Node-RED.

**Einmal installieren – Funktionen zentral verwalten – Änderungen automatisch übernehmen.**

Der Node **EBST Node Red Remote Funktion** stellt verschiedene zentral gepflegte Funktionen direkt in Node-RED zur Verfügung. Die gewünschte Funktion wird im Node ausgewählt. Einstellungen und verfügbare Datenpunkte werden passend zur Funktion automatisch angezeigt.

---

## Was bringt die EBST Node Red Remote Funktion?

- nur **einen Basis-Node** in Node-RED installieren
- Funktionen zentral aus der GitHub-Bibliothek verwenden
- neue Funktionen automatisch in der Auswahlliste erhalten
- Änderungen an bestehenden Funktionen automatisch übernehmen
- funktionsabhängige Einstellungen direkt im Node vornehmen
- verfügbare Datenpunkte und deren Verwendung direkt im Node anzeigen
- bei einem GitHub-Fehler mit der letzten gültigen lokalen Version weiterarbeiten

Ab **Basis-Version V1.3.0** können neue Funktionen, Einstellungen und Datenpunktbeschreibungen ergänzt werden, ohne den Basis-Node jedes Mal neu installieren zu müssen.

---

## Installation

Aktuelles Installationspaket:

```text
node-red-contrib-ebst-remote-function-1.3.0.tgz
```

Das Paket im Node-RED-Benutzerverzeichnis installieren:

```bash
cd ~/.node-red
npm install /pfad/node-red-contrib-ebst-remote-function-1.3.0.tgz
```

Danach Node-RED einmal neu starten:

```bash
sudo systemctl restart nodered
```

Anschließend steht in der Node-RED-Palette unter **Function** der Node

**EBST Node Red Remote Funktion**

zur Verfügung.

> Nach der Installation von V1.3.0 ist für normale neue Funktionen oder Funktionsänderungen keine erneute Installation erforderlich.

---

## Verwendung

1. **EBST Node Red Remote Funktion** aus der Palette in den Flow ziehen.
2. Node öffnen.
3. Gewünschte **Funktion** auswählen.
4. Falls erforderlich, die eingeblendeten Einstellungen ausfüllen.
5. Node mit dem gewünschten Eingang und Ausgang verbinden.
6. **Deploy** ausführen.

Die Anzahl der Ausgänge wird automatisch passend zur gewählten Funktion gesetzt.

---

# Aktuell verfügbare Funktionen

## Wetter – ORF Wetter Innsbruck

**Version:** 1.2.0  
**Ausgänge:** 2

Lädt die ORF-Tirol-Wetterprognose für Innsbruck und ermittelt den Wetterzustand sowie die minimale und maximale Tagestemperatur.

### Ausgang 1 – Wetterdaten

Wichtige Datenpunkte:

```text
msg.payload.location
msg.payload.condition
msg.payload.tmin_c
msg.payload.tmax_c
msg.payload.published
msg.payload.parser_ok
msg.payload.stale
```

Beispiele:

| Datenpunkt | Bedeutung |
|---|---|
| `msg.payload.condition` | Wetterzustand, z. B. wolkenlos oder bedeckt |
| `msg.payload.tmin_c` | minimale Tagestemperatur in °C |
| `msg.payload.tmax_c` | maximale Tagestemperatur in °C |
| `msg.payload.parser_ok` | `true`, wenn ORF erfolgreich ausgewertet wurde |
| `msg.payload.stale` | `true`, wenn letzte gültige Werte verwendet werden |

### Ausgang 2 – Wetterzustände

```text
msg.payload
```

Enthält die gesammelten unterschiedlichen Wetterzustände als JSON.

Zusätzlich stehen unter anderem folgende Global-Werte zur Verfügung:

```text
global.wettervorhersage
global.wetter_temp
global.wetter_temp_Max
```

---

## Wetter – Techweb Wetterdaten Tirol

**Version:** 1.1.0  
**Ausgänge:** 1

Lädt aktuelle Messwerte einer Tiroler Wetterstation.

### Einstellung

Die gewünschte **Wetterstation** wird direkt im Node aus einer automatisch geladenen Stationsliste ausgewählt.

### Wichtige Datenpunkte

```text
msg.payload.station.location
msg.payload.temperature
msg.payload.humidity
msg.payload.sun_w
msg.payload.wind_speed
msg.payload.wind_direction
msg.payload.rain_mm
msg.payload.snow
msg.payload.airpressure
msg.payload.condition
```

| Datenpunkt | Bedeutung |
|---|---|
| `msg.payload.temperature` | aktuelle Temperatur in °C |
| `msg.payload.humidity` | relative Luftfeuchte in % |
| `msg.payload.sun_w` | Sonnenstrahlung in W/m² |
| `msg.payload.wind_speed` | Windgeschwindigkeit |
| `msg.payload.wind_direction` | Windrichtung |
| `msg.payload.rain_mm` | Niederschlag in mm |
| `msg.payload.airpressure` | Luftdruck / Luftdrucktrend |
| `msg.payload.condition` | automatisch ermittelter Wetterzustand |

Zusätzlich werden die bisherigen Global-Werte weiter gesetzt:

```text
global.wetter_temp
global.wetter_humidity
global.wetter_sun
global.wetter_rain
global.wetter_wind_Speed
global.wetter_wind_direction
global.wetter_Luftdruck
global.wetterzustand
```

---

## Astronomie – Sonnenstand

**Version:** 1.0.0  
**Ausgänge:** 1  
**Externe Bibliothek:** nicht erforderlich

Berechnet Sonnenwinkel, Sonnenhöhe, Sonnenaufgang, Sonnenuntergang und Sonnenmittag direkt mit JavaScript.

### Einstellungen

Direkt im Node werden eingestellt:

```text
Breitengrad
Längengrad
```

### Wichtige Datenpunkte

```text
msg.payload.azimuthDegrees
msg.payload.altitudeDegrees
msg.payload.isDay
msg.payload.times.sunrise.value
msg.payload.times.sunset.value
msg.payload.times.night.value
msg.payload.times.solarNoon.value
```

| Datenpunkt | Bedeutung |
|---|---|
| `msg.payload.azimuthDegrees` | Sonnenrichtung in Grad: 0° Nord, 90° Ost, 180° Süd, 270° West |
| `msg.payload.altitudeDegrees` | Sonnenhöhe über dem Horizont in Grad |
| `msg.payload.isDay` | `true` = Tag, `false` = Nacht |
| `msg.payload.times.sunrise.value` | Sonnenaufgang als lokale Uhrzeit |
| `msg.payload.times.sunset.value` | Sonnenuntergang als lokale Uhrzeit |
| `msg.payload.times.solarNoon.value` | Zeitpunkt des höchsten Sonnenstands |

Zusätzlich werden folgende Global-Werte gesetzt:

```text
global.Sonnenwinkel
global.Sonnenhoehe
global.Sonnenaufgang
global.Sonnenuntergang
global.Sonnenmittag
```

---

## Datenpunkte direkt im Node anzeigen

Bei jeder Funktion zeigt der Node unter **Verfügbare Datenpunkte** an:

- Bezeichnung des Datenpunkts
- Zugriffspfad, z. B. `msg.payload.temperature`
- Ausgangsnummer
- Einheit, sofern vorhanden
- kurze Beschreibung
- vorhandene Global-Context-Werte

Damit ist direkt ersichtlich, welchen Pfad ein nachfolgender Change-, Function-, Debug- oder Dashboard-Node verwenden muss.

Beispiel:

```text
Sonnenaufgang
Ausgang 1
msg.payload.times.sunrise.value
Lokale Uhrzeit des Sonnenaufgangs
```

---

## Automatische Updates

Die verwendeten Remote-Funktionen werden regelmäßig mit der zentralen GitHub-Bibliothek abgeglichen.

Bei einer Änderung wird die neue Funktionsversion automatisch geladen. Dafür ist normalerweise kein erneutes Installieren des Basis-Pakets und kein manuelles Austauschen von Function-Nodes erforderlich.

Wenn GitHub vorübergehend nicht erreichbar ist oder eine neue Funktionsversion nicht geladen werden kann, verwendet der Node die letzte gültige lokale Version weiter.

---

## Neue Funktionen

Neue Funktionen können künftig zentral ergänzt werden und erscheinen anschließend automatisch in der Funktionsauswahl.

Auch zusätzliche Einstellungen wie beispielsweise

```text
IP-Adresse
Stationsauswahl
Grenzwert
Temperatur
SOC-Wert
JA / NEIN
Text
Zahl
Auswahlliste
```

können dynamisch bereitgestellt werden, ohne den Basis-Node neu zu installieren.

Eine neue Basisversion ist nur erforderlich, wenn der grundlegende Mechanismus des **EBST Node Red Remote Funktion** Nodes selbst geändert wird.

---

## Aktuelle Version

```text
EBST Node Red Remote Funktion
Basis-Version: V1.3.0
```

Die eigentlichen Remote-Funktionen besitzen unabhängig davon ihre eigene Versionsnummer.