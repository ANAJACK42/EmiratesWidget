# EK050 Flight Widget · MUC → DXB

Ein rahmenloses Desktop-Widget, das den Emirates-Flug **EK050 (Funkrufzeichen UAE50)**
von München (MUC/EDDM) nach Dubai (DXB/OMDB) live verfolgt — mit Karte, Route,
Geschwindigkeit, Höhe, Kurs und Position. Aktualisierung alle **5 Minuten**.

Zwei Designs, per Knopfdruck umschaltbar:

| Design | Look |
| --- | --- |
| **ECAM** | Airbus-Bordcomputer / Terminal: Schwarz, Grün-Amber-Cyan, Monospace, Rasterlinien, Scanlines |
| **GLASS** | Liquid Glass à la Apple: durchscheinende Panels, Blur, weiche Verläufe, runde Ecken |

## Installation

Voraussetzung: [Node.js](https://nodejs.org) ab Version 18.

```bash
git clone <dieses-repo>
cd EmiratesWidget
npm install
npm start
```

Alternativ per Doppelklick: `start.sh` (macOS/Linux) bzw. `start.cmd` (Windows).
Beim ersten Start werden die Abhängigkeiten (Electron, Leaflet) automatisch geladen.

## Bedienung

| Aktion | Wie |
| --- | --- |
| Verschieben | Kopfzeile packen und ziehen |
| Größe ändern | An jeder Fensterkante ziehen (Layout passt sich automatisch an) |
| Design wechseln | Knopf `ECAM`/`GLASS` oder Taste **T** |
| Sofort aktualisieren | Knopf `↻` oder Taste **R** |
| Immer im Vordergrund | Knopf `📌` oder Taste **P** |
| Karte auf Route zentrieren | Taste **F** oder Doppelklick auf die Karte |
| Minimieren / Schließen | `—` / `✕` (oder **Esc**) |
| Ein-/Ausblenden ohne Beenden | **Strg/Cmd + Shift + E** (systemweit) |

Fensterposition, -größe, Design und Always-on-Top werden gespeichert und beim
nächsten Start wiederhergestellt.

## Was angezeigt wird

* **Ground Speed** in kt und km/h
* **Höhe** in ft, dazu Flight Level bzw. Meter
* **Kurs (Track)** in Grad plus Himmelsrichtung
* **Vertical Speed** mit Steig-/Sink-/Reiseflug-Erkennung
* **Position** als Breite/Länge in Grad und Bogenminuten
* **Mach / TAS**, Squawk, Registrierung, Muster, ICAO-24-Adresse
* **Karte** mit geplanter Großkreisroute, tatsächlich geflogener Spur (durchgezogen)
  und Reststrecke (gestrichelt), Flugzeugsymbol in Flugrichtung gedreht
* **Fortschrittsbalken** mit zurückgelegter und verbleibender Distanz in NM
* **ETA Dubai** in dortiger Ortszeit sowie Restflugzeit

## Datenquellen

Alle Quellen sind kostenlos und benötigen **keinen API-Schlüssel**. Sie werden der
Reihe nach abgefragt, die erste brauchbare Antwort gewinnt:

1. [adsb.lol](https://adsb.lol) — `api.adsb.lol/v2/callsign/UAE50`
2. [adsb.fi](https://adsb.fi) — `opendata.adsb.fi/api/v2/callsign/UAE50`
3. [airplanes.live](https://airplanes.live) — `api.airplanes.live/v2/callsign/UAE50`
4. [OpenSky Network](https://opensky-network.org) — Zustandsvektoren im Korridor MUC–DXB

Kartenkacheln: OpenStreetMap via CARTO (dunkel für ECAM, Voyager für Glass).

Die Abfrage läuft im Electron-Main-Prozess, damit weder CORS noch Browser-Regeln
stören. Der Renderer bekommt über eine schmale, kontextisolierte Bridge nur die
fertigen Daten (`contextIsolation: true`, kein `nodeIntegration`).

### Funklöcher

ADS-B ist auf bodengestützte Empfänger angewiesen. Über Teilen des Irak, Iran und
des Golfs kann die Abdeckung ausfallen. Dann schaltet das Widget auf
**Koppelnavigation** um: Es schreibt die letzte bekannte Position mit letzter
Geschwindigkeit und letztem Kurs fort, markiert das in der Statuszeile
(`KEIN ADS-B KONTAKT · KOPPELNAVIGATION`) und nennt das Alter des letzten Fixes.
Sobald wieder Empfang besteht, springt die Anzeige auf die echte Position zurück.

Die geflogene Spur wird lokal (`localStorage`) gespeichert und übersteht einen
Neustart des Widgets.

## Anderen Flug verfolgen

In `config.js` `flightIata`, `callsign`, `callsignVariants` sowie `origin`/`destination`
anpassen — mehr ist nicht nötig. Das Funkrufzeichen ist die ICAO-Airline-Kennung plus
Flugnummer ohne führende Null (Emirates = `UAE`, also EK050 → `UAE50`).

Das Aktualisierungsintervall steht ebenfalls dort (`refreshIntervalMs`, Standard 5 Minuten).

## Automatisch beim Anmelden starten

* **macOS**: Systemeinstellungen → Allgemein → Anmeldeobjekte → `start.sh` hinzufügen
* **Windows**: Verknüpfung zu `start.cmd` in `shell:startup` ablegen
* **Linux**: `.desktop`-Datei in `~/.config/autostart/` mit `Exec=/pfad/zu/start.sh`

## Projektstruktur

```
config.js         gemeinsame Konfiguration (Flug, Flughäfen, Intervall)
flight-source.js  Abfrage und Normalisierung der ADS-B-Feeds (Main-Prozess)
main.js           Electron-Fenster, Persistenz, Timer, IPC
preload.js        kontextisolierte Bridge zum Renderer
renderer/
  index.html      Aufbau des Widgets
  styles.css      beide Designs (ECAM / Glass)
  geo.js          Großkreis-Mathematik (Distanz, Peilung, Interpolation)
  app.js          Karte, Instrumente, Statuslogik, Koppelnavigation
```

## Fehlersuche

* **Karte bleibt leer** → keine Internetverbindung oder CARTO blockiert; die Route
  wird trotzdem gezeichnet.
* **`KEINE POSITION VERFUEGBAR`** → der Flug ist gerade bei keinem Feeder sichtbar
  (am Boden, vor dem Abflug oder Funkloch ohne vorherigen Fix).
* **Fenster unsichtbar/transparent unter Linux** → Compositor nötig (z. B. Picom);
  ohne Compositor kann `transparent: true` in `main.js` auf `false` gesetzt werden.
* **Logs sehen** → `npm run dev` startet das Widget mit geöffneten DevTools.
