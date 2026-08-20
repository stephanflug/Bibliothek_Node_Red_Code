# EBST Node Red Remote Funktion

Zentrale Funktionsbibliothek für Node-RED.

**Einmal installieren – Funktionen zentral verwalten – Änderungen automatisch übernehmen.**

Der Node **EBST Node Red Remote Funktion** stellt zentral gepflegte Funktionen direkt in Node-RED bereit. Die gewünschte Funktion wird im Node ausgewählt. Einstellungen und verfügbare Datenpunkte werden passend zur Funktion automatisch angezeigt.

---

## Vorteile

- nur **einen Basis-Node** in Node-RED installieren
- neue Funktionen erscheinen automatisch in der Auswahlliste
- Funktionsänderungen werden automatisch aus GitHub übernommen
- Einstellungen werden je Funktion dynamisch eingeblendet
- Datenpunkte, Ausgänge, Einheiten und Global-Context-Werte werden direkt im Node beschrieben
- bei einem GitHub- oder Updatefehler wird die letzte gültige lokale Version weiterverwendet

Ab **Basis-Version V1.3.0** können neue Funktionen, Einstellungen und Datenpunktbeschreibungen ergänzt werden, ohne den Basis-Node jedes Mal neu installieren zu müssen.

---

## Installation

Aktuelles Installationspaket:

```text
node-red-contrib-ebst-remote-function-1.3.0.tgz
```

Installation im Node-RED-Benutzerverzeichnis:

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
5. Ausgänge mit den gewünschten Folge-Nodes verbinden.
6. **Deploy** ausführen.

Die Anzahl der Ausgänge wird automatisch passend zur gewählten Funktion gesetzt.

---

# Aktuell verfügbare Funktionen

## Wetter – ORF Wetter Innsbruck

**Version:** 1.2.0  
**Ausgänge:** 2

Lädt die ORF-Tirol-Wetterprognose für Innsbruck und ermittelt Wetterzustand sowie minimale und maximale Tagestemperatur.

### Ausgang 1 – Wetterdaten

```text
msg.payload.location
msg.payload.condition
msg.payload.tmin_c
msg.payload.tmax_c
msg.payload.published
msg.payload.parser_ok
msg.payload.stale
```

### Ausgang 2 – Wetterzustände

```text
msg.payload
```

Enthält die gesammelten unterschiedlichen Wetterzustände als JSON.

Zusätzlich werden unter anderem diese Global-Werte gesetzt:

```text
global.wettervorhersage
global.wetter_temp
global.wetter_temp_Max
```

---

## Wetter – Techweb Wetterdaten Tirol

**Version:** 1.1.0  
**Ausgänge:** 1

Lädt aktuelle Messwerte einer auswählbaren Tiroler Wetterstation.

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

Zusätzlich:

```text
global.Sonnenwinkel
global.Sonnenhoehe
global.Sonnenaufgang
global.Sonnenuntergang
global.Sonnenmittag
```

---

## Astronomie – Sonne trifft Haus

**Version:** 1.0.0  
**Ausgänge:** 4  
**Externe Bibliothek:** nicht erforderlich

Berechnet für den eingestellten Standort, wann die Sonne erstmals das Haus trifft. Ein Treffer liegt vor, wenn der Sonnen-Azimut im eingestellten Richtungsfenster liegt und gleichzeitig die Mindest-Sonnenhöhe erreicht ist.

Zusätzlich wird ein wetterabhängiges Vorwarnfenster vor der Erstbesonnung berechnet. Für die Wetterentscheidung ist ausschließlich `global.wettervorhersage` maßgeblich. `global.wetter_rain` und `global.wetter_sun` dienen nur zur Diagnose.

### Wichtige Einstellungen

```text
Breitengrad
Längengrad
Azimut Start
Azimut Ende
Mindest-Sonnenhöhe
Vorwarnzeit Standard
Vorwarnzeit wolkenlos im Sommer
Sommer Startmonat
Sommer Endmonat
Zeitzone
Wetter erlauben (RegEx)
Wetter blockieren (RegEx)
Bei fehlender Wettervorhersage erlauben
Scan-Auflösung
```

Azimut:

```text
0°   = Nord
90°  = Ost
180° = Süd
270° = West
```

### Ausgänge

```text
Ausgang 1 → Vorwarnung true/false
Ausgang 2 → Diagnoseobjekt
Ausgang 3 → aktueller Sonnen-Azimut
Ausgang 4 → Uhrzeit der Erstbesonnung
```

---

## Energie – Strompreis TIWAG / TINETZ + PV Einspeisung

**Version:** 1.1.0  
**Ausgänge:** 4  
**Externe Bibliothek:** nicht erforderlich

Diese Funktion ersetzt die separaten HTTP-Request- und Parser-Nodes für TIWAG und TINETZ.

Sie lädt selbstständig:

- den TIWAG-Arbeitspreis
- das TINETZ-Netzentgelt
- den TIWAG-PV-Einspeisepreis

und berechnet daraus:

- Gesamtpreis des Netzbezugs
- PV-Einspeisevergütung
- Mehrwert einer selbst verbrauchten PV-kWh gegenüber der Einspeisung

### Webseiten sind einstellbar

Die URLs werden direkt im Node gespeichert und können später angepasst werden:

```text
TIWAG Energie-Webseite
TINETZ Netz-Webseite
TIWAG Einspeise-Webseite
```

Wenn ein Anbieter seine Seite ändert, kann zusätzlich das jeweilige **RegEx-Suchmuster** angepasst werden, ohne den Remote-Code ändern zu müssen.

### Weitere Einstellungen

```text
PV-Einspeisung auswerten
Fallback Energiepreis
Fallback Netzentgelt
Fallback PV-Einspeisung
Zusatzkosten pro kWh
Umsatzsteuer Energie
TIWAG Brutto-RegEx
TIWAG Netto-RegEx
TINETZ RegEx
PV-Einspeisung RegEx
Fallbackwerte verwenden
HTTP Timeout
Topic Bezug €/kWh
Topic Bezug ct/kWh
Topic PV Einspeisung
```

### PV-Einspeisung

Die TIWAG-Seite enthält Quartalspreise. Die Funktion sucht alle vorhandenen Werte und verwendet bevorzugt den Preis des **aktuellen Quartals**.

Falls das aktuelle Quartal auf der Seite noch nicht vorhanden ist, wird der neueste verfügbare Quartalspreis verwendet. Erst wenn kein gültiger Wert gefunden wird, kommt – sofern aktiviert – der konfigurierte Fallback zum Einsatz.

### Ausgänge

```text
Ausgang 1
msg.payload
→ Bezugspreis in €/kWh

Ausgang 2
msg.payload
→ Bezugspreis in ct/kWh

Ausgang 3
msg.payload
→ PV-Einspeisepreis in ct/kWh

Ausgang 4
msg.payload
→ Detailobjekt
```

### Wichtige Datenpunkte aus Ausgang 4

```text
msg.payload.energyCt
msg.payload.gridCt
msg.payload.totalCt
msg.payload.eur

msg.payload.feedInCt
msg.payload.feedInEur
msg.payload.feedIn.quarter
msg.payload.feedIn.year

msg.payload.selfUseAdvantageCt
msg.payload.selfUseAdvantageEur

msg.payload.fallbackActive
```

`selfUseAdvantageCt` ist die Differenz zwischen Bezugspreis und Einspeisevergütung:

```text
Mehrwert Eigenverbrauch = Bezugspreis - Einspeisepreis
```

Beispiel:

```text
Bezug:       20,42 ct/kWh
Einspeisung:  8,29 ct/kWh
Mehrwert:    12,13 ct/kWh
```

### Global-Context-Werte

```text
global.strompreis_tiwag_energy_ct_kwh_gross
global.strompreis_tinetz_net_ct_kwh
global.strompreis_ct_kwh
global.strompreis_eur_kwh
global.strompreis_last_update

global.pv_einspeisung_ct_kwh
global.pv_einspeisung_eur_kwh

global.pv_eigenverbrauch_mehrwert_ct_kwh
global.pv_eigenverbrauch_mehrwert_eur_kwh
```

Die bisherigen `flow.*`-Werte werden ebenfalls weiter gesetzt, damit vorhandene Flows weiterverwendet werden können.

---

## Datenpunkte direkt im Node anzeigen

Bei jeder Funktion zeigt der Node unter **Verfügbare Datenpunkte** direkt an:

- Bezeichnung
- Zugriffspfad, z. B. `msg.payload.temperature`
- Ausgangsnummer
- Einheit
- kurze Beschreibung
- verfügbare Global-Context-Werte

Damit ist direkt ersichtlich, welchen Pfad ein nachfolgender Change-, Function-, Debug- oder Dashboard-Node verwenden muss.

---

## Automatische Updates

Die verwendeten Remote-Funktionen werden regelmäßig mit der zentralen GitHub-Bibliothek abgeglichen.

Bei einer Änderung wird die neue Funktionsversion automatisch geladen. Dafür ist normalerweise kein erneutes Installieren des Basis-Pakets und kein manuelles Austauschen von Function-Nodes erforderlich.

Wenn GitHub vorübergehend nicht erreichbar ist oder eine neue Funktionsversion nicht geladen werden kann, verwendet der Node die letzte gültige lokale Version weiter.

---

## Neue Funktionen

Neue Funktionen können zentral ergänzt werden und erscheinen anschließend automatisch in der Funktionsauswahl.

Auch zusätzliche Einstellungen wie

```text
IP-Adresse
URL
Stationsauswahl
Grenzwert
Temperatur
SOC-Wert
JA / NEIN
Text
Zahl
Auswahlliste
RegEx
```

können dynamisch bereitgestellt werden, ohne den Basis-Node neu zu installieren.

Eine neue Basisversion ist nur erforderlich, wenn der grundlegende Mechanismus des **EBST Node Red Remote Funktion** Nodes selbst geändert wird.

---

## Aktuelle Version

```text
EBST Node Red Remote Funktion
Basis-Version: V1.3.0
```

Die Remote-Funktionen besitzen unabhängig davon ihre eigene Versionsnummer.

### Unterstütze das Büro-Kaffeekonto!

Damit der Kaffee im Büro nie ausgeht, wäre eine kleine Spende super!  
Jeder Beitrag hilft, die Kaffeemaschine am Laufen zu halten.

[**Spende für Kaffee**](https://www.paypal.com/donate/?business=ACU26RPTCA44S&no_recurring=0&item_name=Dieses+Projekt+und+der+Service+kann+nur+durch+eure+Spenden+finanziert+werden.&currency_code=EUR)

Vielen Dank für deine Unterstützung!
