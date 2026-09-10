Die Remote-Funktionen besitzen unabhängig davon ihre eigene Versionsnummer.

### ☕ Unterstütze das Büro-Kaffeekonto!

Damit der Kaffee im Büro nie ausgeht und die Entwicklung weiter auf Hochtouren läuft, freuen wir uns über eine kleine Unterstützung. ☕💻

Jeder Beitrag hilft dabei, die Kaffeemaschine am Laufen zu halten und sorgt für genügend Energie für neue Ideen, Funktionen und Updates.

[![PayPal](https://img.shields.io/badge/PayPal-Kaffee%20spendieren-0070BA?logo=paypal\&logoColor=white)](https://paypal.me/stephanflug)

**☕ [Kaffee via PayPal spendieren](https://paypal.me/stephanflug)**

Vielen Dank für deine Unterstützung! ❤️



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

Ab **Basis-Version V1.4.0** steht Remote-Funktionen zusätzlich ein integrierter HTTP-Client zur Verfügung. Dadurch können Funktionen Webseiten und APIs selbst laden, ohne dass separate Node-RED-`http request`-Nodes im Flow benötigt werden.

---

## Installation

Aktuelles Installationspaket:

```text
node-red-contrib-ebst-remote-function-1.4.0.tgz
```

Installation im Node-RED-Benutzerverzeichnis:

```bash
cd ~/.node-red
npm install /pfad/node-red-contrib-ebst-remote-function-1.4.0.tgz
```

Danach Node-RED einmal neu starten:

```bash
sudo systemctl restart nodered
```

Anschließend steht in der Node-RED-Palette unter **Function** der Node

**EBST Node Red Remote Funktion**

zur Verfügung.

> Nach der Installation von V1.4.0 ist für normale neue Funktionen oder Funktionsänderungen keine erneute Installation erforderlich.

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

**Version:** 1.2.0  
**Ausgänge:** 4  
**Zusätzliche HTTP-Request-Nodes:** nicht erforderlich

Diese Funktion ersetzt die separaten HTTP-Request- und Parser-Nodes für TIWAG und TINETZ. Ab **Basis V1.4.0** verwendet sie den fest eingebauten EBST-HTTP-Client mit Cookie- und Redirect-Unterstützung. Ein Inject direkt auf den EBST-Node reicht aus.

Sie lädt selbstständig:

- den TIWAG-Arbeitspreis
- das TINETZ-Netzentgelt
- den TIWAG-PV-Einspeisepreis

Einfacher Flow:

```text
Inject → EBST Node Red Remote Funktion
         Strompreis TIWAG / TINETZ + PV Einspeisung
```

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
Basis-Version: V1.4.0
```

## Kalender – Feiertag Tirol + Wochenende

**Version:** 1.0.0  
**Ausgänge:** 1  
**Zusätzliche HTTP-Request-Nodes:** nicht erforderlich

Prüft automatisch, ob heute Wochenende oder ein für Tirol relevanter Feiertag ist. Die Feiertage werden für Österreich geladen; Tirol-spezifische Feiertage werden über `AT-7` berücksichtigt.

Die Funktion lädt das aktuelle und das nächste Jahr automatisch und verwendet die Zeitzone:

```text
Europe/Vienna
```

### Wichtige Werte

```text
msg.payload.datum
msg.payload.wochentagName
msg.payload.istWochenende
msg.payload.istFeiertagTirol
msg.payload.heutigerFeiertagTirol
msg.payload.naechsterFeiertagTirol
msg.payload.datumNaechsterFeiertagTirol
msg.payload.tageBisNaechsterFeiertagTirol
```

Zusätzlich werden die bisherigen Flow-Werte gesetzt:

```text
flow.istWochenende
flow.wochenendeText
flow.wochentagNummer
flow.wochentagName
flow.wochenendeLetztePruefung

flow.istFeiertagTirol
flow.heutigerFeiertagTirol
flow.tageBisNaechsterFeiertagTirol
flow.naechsterFeiertagTirol
flow.naechsterFeiertagTirolName
flow.naechsterFeiertagTirolDatum
```

Einfacher Flow:

```text
Inject → EBST Node Red Remote Funktion
         Feiertag Tirol + Wochenende
```

---

## Heizung – Heizgradtage Tirol / Österreich

**Version:** 1.0.0  
**Ausgänge:** 1

Berechnet aus laufenden Außentemperatur-Messungen das Tagesmittel und daraus die Heizgradtage nach dem Standard **HGT 20/12**.

```text
Wenn Tagesmittel Außentemperatur <= 12 °C:
HGT = 20 - Tagesmittel Außentemperatur
Heiztag = true

Wenn Tagesmittel Außentemperatur > 12 °C:
HGT = 0
Heiztag = false
```

### Eingang

Die aktuelle Außentemperatur wird direkt in `msg.payload` übergeben:

```text
msg.payload = 8.7
```

### Ausgabe

```text
msg.payload.datum
msg.payload.standard
msg.payload.aussentemperaturAktuellC
msg.payload.tagesmittelAussenC
msg.payload.heizgradtageHeuteK
msg.payload.istHeiztagHGT
msg.payload.heuteHeizenNoetig
msg.payload.messungenHeute
msg.payload.minAussenC
msg.payload.maxAussenC
```

Zusätzlich werden folgende Flow-Werte gesetzt:

```text
flow.hgtHeuteDaten
flow.aussentemperaturC
flow.tagesmittelAussenC
flow.heizgradtageHeuteK
flow.istHeiztagHGT
flow.heuteHeizenNoetig
```

Die Tagesgrenze richtet sich nach:

```text
Europe/Vienna
```

---

## Heizung – COP / Jahresarbeitszahl Wärmepumpen

**Version:** 1.0.0  
**Ausgänge:** 1  
**Mehrere Wärmepumpen:** unterstützt  
**Persistenz über Node-RED-Neustart:** ja

Berechnet den aktuellen COP sowie die Jahresarbeitszahl (JAZ) für eine oder mehrere Wärmepumpen.

```text
COP = thermische Leistung / elektrische Leistung
JAZ = abgegebene Wärmemenge im Jahr / elektrische Energie im Jahr
```

Bei mehreren Wärmepumpen werden die Gesamtwerte korrekt über die Summen berechnet:

```text
COP Gesamt = Summe Wärmeleistung / Summe elektrische Leistung
JAZ Gesamt = Summe Jahreswärme / Summe Jahresstrom
```

### Eingang

Unterstützt werden:

```text
msg.payload = { ... }
msg.payload = [ { ... }, { ... } ]
msg.payload.waermepumpen = [ { ... }, { ... } ]
msg.payload.heatPumps = [ { ... }, { ... } ]
```

Beispiel für eine Wärmepumpe:

```json
{
  "id": "WP1",
  "thermalPowerKw": 8.4,
  "electricalPowerKw": 2.1,
  "heatEnergyKwh": 15420.5,
  "electricEnergyKwh": 4120.8
}
```

### Wärmepumpen-Auswahl

```text
Alle Wärmepumpen aus msg.payload
Nur ausgewählte Wärmepumpen
```

Bei gezielter Auswahl werden die IDs kommagetrennt angegeben:

```text
WP1,WP2,WP3
```

### Energieauswertung

Die Funktion kann Jahresenergie auf drei Arten ermitteln:

```text
1. direkte Jahreszähler
2. fortlaufende Gesamtzähler mit Differenzbildung
3. Integration aus aktueller Leistung über die Zeit
```

### Persistenz

Die internen Jahreswerte und Zählerstände werden zusätzlich als JSON-Datei im Node-RED-Userverzeichnis gespeichert:

```text
<Node-RED-userDir>/.ebst-remote-functions/state/cop-jaz-waermepumpen.json
```

Dadurch gehen die bisher berechneten Jahreswerte bei einem Node-RED-Neustart nicht verloren. Beim ersten Ausführen der Funktion nach dem Neustart wird der gespeicherte Zustand automatisch wieder geladen.

### Global- und Flow-Werte je Wärmepumpe

Bei einer Wärmepumpe mit der ID `WP1` werden unter anderem geschrieben:

```text
global.WP1_COP
global.WP1_JAZ
global.WP1_Waerme_Jahr_kWh
global.WP1_Strom_Jahr_kWh
global.WP1_Waermeleistung_kW
global.WP1_Stromleistung_kW
```

Die gleichen Werte werden zusätzlich im Flow Context gespeichert.

### Gesamtwerte

```text
global.COP_Gesamt
global.JAZ_Gesamt
global.WP_Waermeleistung_Gesamt_kW
global.WP_Stromleistung_Gesamt_kW
global.WP_Waerme_Jahr_Gesamt_kWh
global.WP_Strom_Jahr_Gesamt_kWh
```

Der Ausgang enthält zusätzlich alle Einzel- und Gesamtwerte unter:

```text
msg.payload.pumps
msg.payload.total
msg.payload.persistence
```






---

## Klima – h-x Diagramm / Raumluftzustand

**Version:** 1.0.0  
**Ausgänge:** 1

Berechnet aus Lufttemperatur und relativer Feuchte die wichtigsten psychrometrischen Größen für HLK- und Raumluftauswertungen.

### Eingang

Beispiel:

```json
{
  "temperature": 22.5,
  "humidity": 50
}
```

Alternativ werden unter anderem `temperatureC`, `temp`, `temperatur`, `relativeHumidity`, `rh` und `feuchte` erkannt. Auch ein Array `[Temperatur, relativeFeuchte]` ist möglich.

Optional können zusätzlich `pressureHpa` und `surfaceTemperatureC` geliefert werden.

### Berechnete Werte

```text
msg.payload.humidityRatioGKg              → Feuchtegehalt x [g/kg]
msg.payload.enthalpyKJkg                  → Enthalpie h [kJ/kg]
msg.payload.dewPointC                     → Taupunkt [°C]
msg.payload.dewPointSpreadK               → Taupunktabstand [K]
msg.payload.absoluteHumidityGM3           → absolute Feuchte [g/m³]
msg.payload.vaporPressureHpa              → Wasserdampfdruck [hPa]
msg.payload.saturationVaporPressureHpa    → Sättigungsdampfdruck [hPa]
msg.payload.wetBulbC                      → Feuchtkugeltemperatur [°C]
msg.payload.densityKgM3                   → Luftdichte [kg/m³]
msg.payload.specificVolumeM3KgDryAir      → spezifisches Volumen [m³/kg]
```

### Behaglichkeit

Die Funktion gibt direkt aus:

```text
msg.payload.behaglichkeitsbereich = true / false
msg.payload.comfortReason
```

Die Temperatur- und Feuchtegrenzen sind im EBST-Node einstellbar. Standardmäßig werden 20 bis 26 °C und 30 bis 60 % rF verwendet. Die Prüfung ist eine einfache Raumluftbewertung und ersetzt keine vollständige PMV/PPD-Berechnung.

### Schimmel- und Kondensationsbewertung

```text
msg.payload.schimmelGefahr
msg.payload.moldReason
msg.payload.criticalSurfaceTempMoldC
msg.payload.criticalSurfaceTempCondensationC
```

Ohne Oberflächentemperatur erfolgt eine Screeningbewertung anhand der Raumluftfeuchte. Zusätzlich wird berechnet, wie kalt eine Oberfläche werden darf, bevor die eingestellte Schimmelgrenze beziehungsweise der Taupunkt erreicht wird.

Wenn `surfaceTemperatureC` mitgeliefert wird, werden zusätzlich berechnet:

```text
msg.payload.surfaceRelativeHumidityPercent
msg.payload.condensationRisk
msg.payload.moldRiskSurface
```

### Flow- und Global-Werte

Die wichtigsten Werte werden parallel im Flow- und Global Context gespeichert:

```text
hx_Temperatur_C
hx_RelFeuchte_pct
hx_x_gkg
hx_AbsoluteFeuchte_gm3
hx_Enthalpie_kJkg
hx_Taupunkt_C
hx_Taupunktabstand_K
hx_Feuchtkugel_C
hx_Luftdichte_kgm3
hx_Behaglich
hx_Schimmelgefahr
hx_KritischeOberflaeche_Schimmel_C
hx_KritischeOberflaeche_Kondensation_C
hx_Oberflaechenfeuchte_pct
hx_Kondensationsgefahr
```
