# Veröffentlichung auf npm und in der Node-RED Flow Library

Dieses Repository ist für die Veröffentlichung des Basis-Nodes als öffentliches npm-Paket vorbereitet.

## Paketname

```text
@stephanflug/node-red-ebst-remote-function
```

Der eigentliche Node-RED-Typ bleibt unverändert:

```text
ebst-remote-function
```

Dadurch bleiben bestehende Flows kompatibel.

> Voraussetzung: Der npm-Benutzer bzw. die npm-Organisation muss den Scope `@stephanflug` besitzen. Falls dein npm-Benutzername anders lautet, muss nur der Scope im Feld `name` in `package.json` angepasst werden.

## 1. npm-Zugang prüfen

Auf dem Rechner, von dem veröffentlicht werden soll:

```bash
npm login
npm whoami
```

## 2. Paket lokal prüfen

Im Repository-Verzeichnis:

```bash
npm install
npm run check
npm pack --dry-run
```

`npm pack --dry-run` zeigt exakt, welche Dateien in das veröffentlichte Paket aufgenommen werden.

## 3. Paket öffentlich veröffentlichen

Für das scoped Paket:

```bash
npm publish --access public
```

Das `package.json` enthält zusätzlich:

```json
"publishConfig": {
  "access": "public",
  "registry": "https://registry.npmjs.org/"
}
```

## 4. Installation über Node-RED testen

Nach erfolgreicher Veröffentlichung kann das Paket testweise auf einer Node-RED-Installation installiert werden:

```bash
cd ~/.node-red
npm install @stephanflug/node-red-ebst-remote-function
```

Danach Node-RED neu starten, zum Beispiel:

```bash
sudo systemctl restart nodered
```

Der Node muss anschließend unter **Function** als **EBST Node Red Remote Funktion** erscheinen.

## Wechsel von der bisherigen TGZ-/lokalen Installation

Die bisherige Installation verwendet den Paketnamen:

```text
node-red-contrib-ebst-remote-function
```

Das neue öffentliche Paket verwendet:

```text
@stephanflug/node-red-ebst-remote-function
```

Beide Pakete sollten nicht gleichzeitig installiert sein, da beide denselben Node-Typ `ebst-remote-function` registrieren.

Vor dem Wechsel daher im Node-RED-Benutzerverzeichnis:

```bash
npm remove node-red-contrib-ebst-remote-function
npm install @stephanflug/node-red-ebst-remote-function
```

Danach Node-RED neu starten.

Die bereits im Flow verwendeten Nodes bleiben erhalten, da der Node-Typ nicht geändert wird.

## 5. Node in flows.nodered.org eintragen

Nach der Veröffentlichung auf npm:

1. Auf `https://flows.nodered.org` anmelden.
2. Oben auf **+** klicken.
3. **Node** auswählen.
4. Den npm-Paketnamen eintragen:

```text
@stephanflug/node-red-ebst-remote-function
```

5. Einreichung abschließen.

Danach kann der Node über Node-RED gefunden werden:

```text
Menü
→ Manage palette / Palette verwalten
→ Install
→ @stephanflug/node-red-ebst-remote-function
```

## Versionsupdates

Eine bereits auf npm veröffentlichte Versionsnummer kann nicht erneut veröffentlicht werden.

Bei einer Änderung am Basis-Node muss daher zuerst die Paketversion erhöht werden, zum Beispiel:

```bash
npm version patch
```

Beispiel:

```text
1.4.0 → 1.4.1
```

Danach:

```bash
npm publish --access public
```

Normale Änderungen an den Remote-Funktionen benötigen weiterhin **keine neue npm-Version**, weil diese zentral über das EBST-Manifest aus GitHub geladen werden.
