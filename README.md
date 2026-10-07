# Zeiterfassung (Jira-Worklog-Helfer)

Eine kleine, selbst gehostete Web-App, die das tägliche Dokumentieren von
Aufgaben und Bearbeitungszeiten erleichtert: Aufgabe eintragen, Start- und
Endzeit angeben (Endzeit per Klick = "jetzt", Startzeit wird automatisch an
das Ende des letzten Eintrags angehängt), die Minuten werden automatisch
berechnet. Der fertige Eintrag lässt sich mit einem Klick als Text kopieren,
um ihn in ein Jira-Ticket/-Worklog einzufügen.

Bewusst **kein** direkter Jira-API-Zugriff: Das Tool verwaltet keine
Jira-Zugangsdaten oder -Berechtigungen, sondern erzeugt nur den fertigen
Text zum Einfügen. Das hält den Sicherheits- und Wartungsaufwand klein.

## Inhalt

- [Sicherheitskonzept](#sicherheitskonzept)
- [Voraussetzungen](#voraussetzungen)
- [Installation](#installation)
- [Nginx Proxy Manager einrichten](#nginx-proxy-manager-einrichten)
- [Mehrere Adressen für dieselbe Installation](#mehrere-adressen-für-dieselbe-installation)
- [Ersten Admin-Account anlegen](#ersten-admin-account-anlegen)
- [Nutzung](#nutzung)
- [Übersicht: Woche & Monat](#übersicht-woche--monat)
- [Wochenbericht für Azubis](#wochenbericht-für-azubis)
- [Verwaltung per Kommandozeile](#verwaltung-per-kommandozeile)
- [Logs](#logs)
- [Backup & Wiederherstellung](#backup--wiederherstellung)
- [Updates](#updates)
- [Fehlerbehebung](#fehlerbehebung)
- [Grenzen / bewusste Design-Entscheidungen](#grenzen--bewusste-design-entscheidungen)

## Sicherheitskonzept

| Bereich | Umsetzung |
|---|---|
| Transportverschlüsselung | Nicht Teil dieser App – wird von eurem nginx proxy manager (Let's Encrypt) davorgeschaltet. Die App selbst spricht nur HTTP im internen Netz. |
| Login | Benutzername/Passwort, Passwort-Hashing mit Argon2id, erzwungener Passwortwechsel bei neuen/zurückgesetzten Konten, Konto-Sperre nach mehreren Fehlversuchen |
| Zweiter Faktor | TOTP (Authenticator-App) optional pro Nutzer, inkl. Wiederherstellungs-Codes |
| Passkeys | WebAuthn/FIDO2 (Windows Hello, Touch ID, YubiKey, …) als Alternative zu Passwort+2FA |
| Sitzungen | Server-seitige Sessions (in der eigenen SQLite-DB), httpOnly + secure Cookies, Ablauf nach Inaktivität |
| CSRF-Schutz | Double-Submit-Cookie-Verfahren für alle ändernden Requests |
| Daten­verschlüsselung | Aufgaben-Beschreibungen werden mit AES-256-GCM verschlüsselt in der Datenbank abgelegt (nicht nur die Verbindung – auch die gespeicherten Daten) |
| Content-Security-Policy | Strikt, ohne `unsafe-inline`; keine externen Skript-/Font-CDNs (alles self-hosted) |
| Rate-Limiting | Login, 2FA- und Passkey-Endpunkte sind gegen Brute-Force gedrosselt |
| Protokollierung | Sicherheits-Audit-Log (Logins, Passwort-/2FA-Änderungen, Admin-Aktionen) – **enthält keine Aufgaben-Inhalte** |
| Zugriffs-Isolation | Jede Person sieht nur ihre eigenen Zeiteinträge – auch Admins können fremde Aufgaben-Texte nicht einsehen. Admin-Rechte betreffen ausschließlich Nutzerverwaltung (siehe [Grenzen](#grenzen--bewusste-design-entscheidungen)) |
| Erreichbarkeit | Nicht Teil dieser App – wird über eure IP-Beschränkung (z.B. im nginx proxy manager oder vorgelagerter Firewall) auf das Firmennetz begrenzt |

Was die App **nicht** selbst übernimmt und was ihr auf Infrastruktur-Ebene
sicherstellen solltet: Betriebssystem-/Docker-Host-Härtung, Firewall/IP-
Beschränkung, TLS-Zertifikate (macht euer nginx proxy manager), Backups des
Docker-Volumes, Zeitsynchronisation des Servers (wichtig für TOTP-Codes).

## Voraussetzungen

- Ein Server/VM mit Docker und Docker Compose (v2), erreichbar von eurem
  bereits laufenden nginx proxy manager
- Eine interne oder öffentliche Subdomain für die App, z.B.
  `zeit.ihre-firma.example`, mit einem DNS-Eintrag auf euren Server
- Node.js wird **nicht** auf dem Host benötigt – alles läuft im Container

## Installation

```bash
# 1. Projektordner auf den Server kopieren, dann hinein wechseln
cd zeiterfassung

# 2. .env aus der Vorlage erstellen
cp .env.example .env

# 3. Geheimnisse erzeugen und in .env eintragen
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # -> ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # -> SESSION_SECRET

# 4. In .env außerdem setzen:
#    RP_ID=zeit.ihre-firma.example        (eure echte Domain, ohne https://)
#    RP_ORIGIN=https://zeit.ihre-firma.example
#    COOKIE_SECURE=true
#    TRUST_PROXY=true

# 5. .env vor fremdem Zugriff schuetzen
chmod 600 .env

# 6. Bauen und starten
docker compose up -d --build

# 7. Logs pruefen
docker compose logs -f app
```

Falls kein Node.js auf dem Server verfügbar ist, um die Schlüssel in Schritt
3 zu erzeugen, geht das genauso gut auf jedem beliebigen Rechner mit Node
(oder mit `openssl rand -hex 32` bzw. `openssl rand -hex 48`).

Der Container läuft mit einem eigenen, isolierten Datenbank-Volume
(`zeiterfassung_data`). Es wird standardmäßig **kein** Port auf dem
Host geöffnet (siehe `docker-compose.yml`, Variante A/B) – Zugriff läuft
über euren nginx proxy manager.

## Nginx Proxy Manager einrichten

**Variante A (empfohlen): gemeinsames Docker-Netzwerk**

Wenn euer nginx proxy manager ebenfalls in Docker läuft, tragt sein
Docker-Netzwerk in der `docker-compose.yml` dieser App unter `networks:`
ein (Zeile ist vorbereitet, nur auskommentieren und den echten Namen
eures NPM-Netzwerks eintragen, z.B. `docker network ls` zeigt ihn an).
Danach in NPM als "Forward Hostname / IP" einfach `zeiterfassung` und als
Port `3000` eintragen (der Container-/Service-Name aus der
`docker-compose.yml`). So ist der Port gar nicht erst auf dem Host offen.

**Variante B: nginx proxy manager läuft separat**

In der `docker-compose.yml` den `ports`-Block einkommentieren
(`127.0.0.1:3000:3000`) und in NPM als Ziel die IP/Hostname des
Docker-Hosts mit Port `3000` eintragen.

**In beiden Fällen in nginx proxy manager:**
- **"Cache Assets" für diesen Proxy-Host AUSSCHALTEN.** Die App setzt
  selbst passende Cache-Header und schickt an statische Dateien keine
  Cookies mehr. Der NPM-Asset-Cache speichert aber Antworten inklusive
  `Set-Cookie`-Header und ist für Anwendungen mit Login grundsätzlich
  riskant.
- SSL-Zertifikat via Let's Encrypt wie gewohnt anfordern
- "Force SSL" aktivieren
- Für Passkeys wichtig: die Domain in NPM muss **exakt** der in `.env`
  gesetzten `RP_ID`/`RP_ORIGIN` entsprechen (inkl. Groß-/Kleinschreibung,
  ohne Portangabe bei Standard-443)
- Eure IP-Beschränkung auf das Firmennetz wie gewohnt in NPM (Access
  Lists) oder vorgelagerter Firewall konfigurieren

## Mehrere Adressen für dieselbe Installation

Die Anwendung kann unter mehreren Domains erreichbar sein, z.B.
`zeit.ihre-firma.example` und zusätzlich eine kurze Adresse.

1. **DNS**: für die zweite Adresse einen eigenen A-Record (und ggf.
   AAAA-Record) direkt auf dieselbe IP setzen. Bewusst kein CNAME auf die
   erste Adresse, damit beide Namen unabhängig voneinander auflösen.
2. **Nginx Proxy Manager**: einen zweiten Proxy Host anlegen, mit demselben
   Ziel (`zeiterfassung`, Port `3000`), eigenem Let's-Encrypt-Zertifikat,
   „Force SSL" an und „Cache Assets" aus. Die Access List für die
   IP-Beschränkung gilt pro Host und muss erneut zugewiesen werden.
3. **App**: die zusätzliche Adresse in der `.env` eintragen und Container
   neu starten:

   ```
   RP_ORIGIN=https://zeit.ihre-firma.example
   RP_ORIGINS=https://tt.kurz.example
   ```

   Mehrere zusätzliche Adressen werden mit Komma getrennt.

Was dabei zu beachten ist:

- **`RP_ID` ist die Hauptadresse** und muss zur Domain aus `RP_ORIGIN`
  passen; weicht sie ab, bricht der Start mit einer Meldung ab, weil
  Passkeys sonst unbemerkt nicht funktionieren würden. Für Zugriffe über die
  zusätzlichen Adressen aus `RP_ORIGINS` wird die jeweils aufgerufene
  Adresse verwendet.
- **Passkeys sind an genau eine Domain gebunden**, so schreibt es der
  WebAuthn-Standard vor. Ein Passkey von `zeit.ihre-firma.example`
  funktioniert auf der zweiten Adresse nicht. Wer beide nutzt, legt unter
  „Konto" je Adresse einen eigenen Passkey an. Die Liste zeigt bei jedem
  Passkey, für welche Adresse er gilt. Anmeldung per Passwort und 2FA
  funktioniert unter allen Adressen gleichermaßen.
- **Sitzungen gelten ebenfalls pro Adresse.** Ein Wechsel der Adresse
  bedeutet eine erneute Anmeldung. Das ist eine Eigenschaft von Cookies und
  lässt sich nicht umgehen.
- Alle Daten sind dieselben, unabhängig von der verwendeten Adresse.
- Nicht eingetragene Hostnamen werden wie die Hauptadresse behandelt. Wer
  das nicht möchte, setzt `STRICT_HOST=true` in der `.env`: Dann bedient die
  Anwendung ausschließlich die konfigurierten Adressen und weist alle
  anderen ab. Vorher prüfen, dass wirklich jede genutzte Adresse in
  `RP_ORIGIN` bzw. `RP_ORIGINS` steht, sonst sperrt man sich aus. Zugriffe
  über `127.0.0.1` bleiben immer erlaubt, darüber läuft der
  Docker-Healthcheck.

## Ersten Admin-Account anlegen

Es gibt bewusst keine offene Selbstregistrierung. Der erste Account wird
einmalig per Kommandozeile im Container angelegt:

```bash
docker compose exec app npm run create-admin
```

Das Skript fragt Benutzername, Anzeigename und Rolle ab und gibt ein
temporäres Passwort aus, das beim ersten Login geändert werden muss.
Bitte dieses Passwort **nicht** per unverschlüsselter E-Mail verschicken,
sondern persönlich oder über einen sicheren Kanal übermitteln.

Weitere Nutzer:innen können danach bequem über die Weboberfläche
(„Team“-Bereich, nur für Admins sichtbar) angelegt werden – die
Kommandozeile wird nur für den allerersten Account gebraucht.

## Nutzung

- **Timer**: „Timer starten“ drücken und einfach arbeiten. Der Timer läuft
  serverseitig, also auch weiter, wenn der Tab geschlossen oder das Gerät
  gewechselt wird. Beim Stoppen entsteht automatisch ein Eintrag, der sich
  danach ganz normal bearbeiten lässt, um Zeiten nachzujustieren. Über
  „Verwerfen“ endet der Timer ohne Eintrag.
- **Autovervollständigung**: Beim Tippen im Beschreibungsfeld erscheinen die
  eigenen zuletzt und am häufigsten genutzten Texte. Ein Klick übernimmt den
  Text samt zugehöriger Ticketnummer.
- **„in Jira eingetragen“**: Häkchen an jedem Eintrag, um festzuhalten, was
  schon übertragen wurde. Erledigte Einträge werden blasser dargestellt, und
  die Tagessumme zeigt zusätzlich, wie viel noch offen ist.
- **Löschen mit Rückgängig**: Gelöschte Einträge landen zuerst im Papierkorb
  und lassen sich 30 Sekunden lang über den Knopf in der Einblendung
  zurückholen. Danach werden sie endgültig entfernt.
- **Eintrag anlegen**: Startzeit ist vorausgefüllt (Ende des letzten
  Eintrags, oder die aktuelle Uhrzeit beim allerersten Eintrag des Tages).
  Endzeit per Klick auf "Jetzt" setzen oder manuell eintragen – die Dauer
  wird automatisch berechnet und live angezeigt.
- **Rückwirkend erfassen**: Mit den Pfeilen neben dem Datum auf einen
  anderen Tag wechseln und dort Einträge mit frei wählbarer Start-/Endzeit
  anlegen – passend für "alles gesammelt zum Feierabend eintragen".
- **In Jira einfügen**: Über das Kopier-Symbol an einem einzelnen Eintrag
  nur diesen kopieren, oder über "Tag kopieren" alle Einträge des
  angezeigten Tages inkl. Gesamtsumme auf einmal – beides landet
  formatiert in der Zwischenablage zum Einfügen ins Jira-Ticket.
  **Standardmäßig ohne Uhrzeiten**: `60 Min – Tagesabschluss gebucht [ITPKK-1182]`.
  Wer die Zeiten mitkopieren möchte, schaltet unter „Konto → Einstellungen"
  die Option „Uhrzeiten beim Kopieren mitnehmen" ein
  (`08:00–09:00 (60 Min) – Tagesabschluss gebucht [ITPKK-1182]`). Die Einstellung
  gilt pro Browser.
- **Sortierung**: Über der Tagesliste (und der Tabelle in der Übersicht)
  lässt sich die Reihenfolge wählen: älteste/neueste zuerst, längste zuerst
  oder nach Ticket. Die Wahl merkt sich der Browser. „Tag kopieren"
  übernimmt die angezeigte Reihenfolge.
- **Nochmal erfassen**: Der Pfeil (↻) an einem Eintrag füllt das Formular
  mit dessen Text und Ticket vor, die Zeiten werden wie bei jedem neuen
  Eintrag gesetzt.
- **Tastatur**: Strg+Enter (am Mac Cmd+Enter) im Beschreibungsfeld speichert
  den Eintrag, Enter im Timer-Feld startet den Timer. Die
  Autovervollständigung gibt es auch beim Timer.
- **Überschneidungen**: Überlappt ein Zeitraum mit einem anderen Eintrag des
  Tages, erscheint unter der Dauer eine Warnung (Speichern bleibt möglich).
- **Offene kopieren**: Der Knopf „Offene kopieren" neben „Tag kopieren"
  kopiert nur die Einträge des Tages, die noch nicht als „in Jira
  eingetragen" abgehakt sind (samt Summe), und zeigt in Klammern, wie viele
  das sind.
- **Nach dem Kopieren abhaken**: Nach „Tag kopieren" oder „Offene kopieren" bietet die Einblendung
  an, alle Einträge des Tages als „in Jira eingetragen" zu markieren.
- **Timer**: Die laufende Zeit steht im Browser-Tab. Läuft der Timer seit
  über 10 Stunden oder wurde er an einem früheren Tag gestartet, erscheint
  ein Hinweis.
- **Farbschema**: Der Knopf oben rechts (◐ / ☀ / ☾) wechselt zwischen Auto
  (folgt dem Betriebssystem), Hell und Dunkel. Die Wahl merkt sich der Browser.
- **Datensicherung**: Unter „Konto" lassen sich die eigenen Einträge als
  JSON-Datei exportieren und wieder importieren (vorhandene Einträge werden
  übersprungen). Die Datei enthält die Texte **unverschlüsselt**. In der
  Übersicht gibt es zusätzlich einen CSV-Export der angezeigten Tabelle und
  den Filter „nur noch nicht in Jira".
- **Jira-Links werden zu Ticketnummern**: Ein eingefügter Link wie
  `https://firma.atlassian.net/browse/ITPKK-1234` oder ein Service-Desk-Link
  (`…/jira/servicedesk/projects/ITPKB/queues/custom/33/ITPKB-1234`) wird im
  Ticketfeld sofort zu `ITPKK-1234`. Im Beschreibungstext werden eingefügte
  Links ebenfalls ersetzt, und ein noch leeres Ticketfeld wird dabei mit der
  Nummer gefüllt. Erkannt werden `*.atlassian.net`-Adressen sowie Adressen mit
  `/browse/`, `/jira/` oder `/servicedesk/` im Pfad; andere Links bleiben
  unverändert. Die Logik liegt in `public/js/tickets.js` (Browser und Server).
- **Oberfläche**: Die Erfassungsseite zeigt links Timer, Eingabeformular und
  Tagesliste, rechts eine Zusammenfassung (Gesamtzeit, Anteil in Jira/offen,
  Summen je Ticket) mit den Kopierknöpfen. Der Haken-Kreis an einem Eintrag
  markiert ihn als „in Jira eingetragen".
- **Konto**: Passwort ändern, 2FA (Authenticator-App) und Passkeys unter
  "Konto" einrichten.
- **Wochenbericht** (nur für als Azubi gekennzeichnete Konten): Export der
  Wochen-Aufgaben als reiner Text ohne Uhrzeiten, siehe
  [eigener Abschnitt](#wochenbericht-für-azubis).
- **Team** (nur Admins): Nutzer:innen anlegen/deaktivieren, Passwort oder
  2FA/Passkeys eines Kontos zurücksetzen (z.B. bei verlorenem Gerät),
  Sicherheits-Protokoll einsehen.

## Übersicht: Woche & Monat

Der Menüpunkt **Übersicht** zeigt für eine Kalenderwoche oder einen Monat:

- Kennzahlen: Gesamtzeit, noch nicht nach Jira übertragene Zeit, Anzahl
  erfasster Tage und Durchschnitt pro erfasstem Tag
- einen Balken pro Tag, auch Tage ohne Einträge, um Lücken zu erkennen
- Summen je Jira-Ticket, mit einem Knopf, der die Zusammenfassung
  kopierfertig in die Zwischenablage legt (`FIN-3: 4h 30m (270 Min)`)
- eine Tabelle aller Einträge des Zeitraums samt Übertragungsstatus

Auch hier gilt die Datentrennung: Jede Person sieht ausschließlich die
eigenen Einträge.

## Wochenbericht für Azubis

Zusätzlich zur Rolle (Mitarbeiter:in / Administrator:in) kann ein Konto als
**Azubi** gekennzeichnet werden. Das ist unabhängig von der Rolle, ein Azubi
kann also auch Admin sein.

Setzen lässt sich die Kennzeichnung im Team-Bereich über die Schaltfläche
„Als Azubi“ oder per Kommandozeile:

```bash
docker compose exec app npm run user -- azubi lena.musterfrau an
docker compose exec app npm run user -- azubi lena.musterfrau aus
```

Gekennzeichnete Konten sehen dann oben den zusätzlichen Menüpunkt
**Wochenbericht**. Dort lässt sich eine Kalenderwoche auswählen und als Text
für den Berichtsheft-Eintrag ausgeben – **ohne Uhrzeiten und ohne Dauer**,
nur die Aufgabentexte. Der Text kann kopiert oder als `.txt` gespeichert
werden.

Einstellbar sind:
- **Format**: nach Tagen gruppiert (mit Wochentag und Datum) oder
  fortlaufende Liste ganz ohne Tagesangaben
- **Aufzählungszeichen**: `-`, `•` oder keines
- **Gleiche Aufgaben zusammenfassen**: mehrfach am selben Tag erfasste
  identische Tätigkeiten erscheinen nur einmal
- **Jira-Ticketnummern**: standardmäßig aus, für die Schule meist nicht
  relevant

Beispielausgabe:

```
Montag, 21.09.2026
- Tagesabschluss gebucht
- Eingangsrechnungen geprüft

Mittwoch, 23.09.2026
- Berufsschule
```

Tage ohne Einträge werden weggelassen. Auch hier gilt die Datentrennung:
Azubis sehen ausschließlich ihre eigenen Einträge.

## Verwaltung per Kommandozeile

Alle wichtigen Admin-Aktionen gehen auch ohne Weboberfläche, z.B. wenn
kein Admin mehr Zugang hat:

```bash
docker compose exec app npm run user -- list
docker compose exec app npm run user -- reset-password philipp.moser
docker compose exec app npm run user -- deactivate philipp.moser
docker compose exec app npm run user -- activate philipp.moser
docker compose exec app npm run user -- unlock philipp.moser
docker compose exec app npm run user -- reset-2fa philipp.moser
docker compose exec app npm run user -- audit 100
docker compose exec app npm run create-admin
docker compose exec app npm run clear-sessions
```

- `reset-password` erzeugt ein temporäres Passwort, hebt eine
  Login-Sperre auf und meldet die Person überall ab.
- `deactivate` und `reset-2fa` beenden ebenfalls sofort alle Sitzungen
  der Person. Das gilt auch, wenn die Aktion über die Website ausgeführt
  wird.
- `audit` zeigt das Sicherheits-Protokoll, auch Einträge von vor diesem
  Update.
- Ohne Befehl oder mit `help` erscheint eine Übersicht.

Alle CLI-Aktionen landen im Sicherheits-Protokoll mit der Kennung `CLI`
anstelle einer IP-Adresse.

## Logs

Die Aufbewahrungsfrist beträgt standardmäßig 90 Tage, einstellbar über
`AUDIT_RETENTION_DAYS` in der `.env` (`0` deaktiviert das Löschen). Ältere
Einträge werden beim Start und danach täglich automatisch entfernt, ebenso
wie endgültig gelöschte Zeiteinträge aus dem Papierkorb.

Jeder Eintrag des Sicherheits-Protokolls (Logins, Fehlversuche,
Passwort-/2FA-Änderungen, Admin-Aktionen, auch per CLI) erscheint
zusätzlich in der Container-Ausgabe:

```bash
docker compose logs -f app
docker compose logs app | grep AUDIT
```

Beispiel:

```
[AUDIT] 22.09.2026, 12:49:10 | Anmeldung fehlgeschlagen | Benutzer: philipp.moser | IP: 10.10.0.12 | Details: attempt_1
[AUDIT] 22.09.2026, 12:51:03 | Nutzer deaktiviert | Benutzer: - | IP: CLI | Details: philipp.moser (per CLI)
```

`Benutzer` ist die Person, die die Aktion ausgeführt hat, bei CLI-Aktionen
steht dort `-` und die betroffene Person unter `Details`. Aufgaben-Inhalte
werden nie geloggt. Die Zeitzone ist standardmäßig `Europe/Berlin` und
lässt sich über `LOG_TIMEZONE` in der `.env` ändern.

## Lokaler Betrieb (ohne Server)

Die Anwendung kann auch komplett lokal auf dem eigenen Rechner laufen - ohne Docker, Proxy, Domain oder Zertifikate. Jede Person betreibt dann ihre eigene Instanz mit eigenen Daten.

**Voraussetzung:** Node.js 20 oder neuer (getestet mit 22; 24 wird unterstuetzt). Ohne Administratorrechte genuegt das ZIP-Archiv von https://nodejs.org, entpackt in einen Benutzerordner (z.B. `C:\Users\NAME\node-v24.21.0-win-x64`). `start-local.bat` findet Node dort automatisch; liegt es woanders, vorher `set NODE_HOME=<Ordner mit node.exe>` setzen.

**Start**
- Windows: Doppelklick auf `start-local.bat`
- macOS/Linux: `./start-local.sh`
- Alternativ: `LOCAL_MODE=true node src/server.js`

Beim ersten Start werden die Abhaengigkeiten installiert, die Schluessel automatisch erzeugt und der Browser geoeffnet (`http://localhost:4711`). Beenden: Fenster schliessen oder Strg+C.

**Node.js-Version gewechselt?** Das native Modul `better-sqlite3` gilt nur für die Node-Version, mit der es installiert wurde (Fehler `NODE_MODULE_VERSION … requires …`). Die Startskripte erkennen das und bauen es automatisch neu. Von Hand: `npm rebuild better-sqlite3`, notfalls den Ordner `node_modules` löschen und `npm install --omit=dev` ausführen. Die Daten sind davon nicht betroffen.

**Was im lokalen Modus anders ist**
- Die App lauscht ausschliesslich auf `127.0.0.1`; aus dem Netzwerk ist sie nicht erreichbar. Fremde Hostnamen werden abgewiesen (Schutz gegen DNS-Rebinding).
- Es gibt keine Anmeldung: Der lokale Nutzer ist automatisch angemeldet. Passwort, 2FA, Passkeys, Abmelden und Team-Verwaltung entfallen. Geschuetzt sind die Daten durch das Betriebssystem-Benutzerkonto (Bildschirmsperre!) und die Verschluesselung der Beschreibungen (AES-256-GCM).
- Den Azubi-Schalter (Wochenbericht) gibt es unter *Konto -> Einstellungen*.
- Anderen Port: Umgebungsvariable `PORT`, z.B. `PORT=4712`.

**Datenablage:** Windows `%APPDATA%\Zeiterfassung`, sonst `~/.zeiterfassung` (oder `DATA_DIR`). Enthalten sind `app.db` (Daten) und `keys.json` (Schluessel, nur fuer den eigenen Benutzer lesbar).

**Backup:** Immer den **ganzen Ordner** sichern (`app.db` *und* `keys.json`). Ohne `keys.json` sind die Eintraege unwiederbringlich unlesbar; die App erzeugt bewusst keinen neuen Schluessel, wenn nur die Datenbank vorhanden ist. Die Sicherung gehoert verschluesselt abgelegt, da `keys.json` im Klartext liegt.

**Update:** Neuen Programmordner entpacken, `node_modules` und die Daten bleiben unberuehrt (Daten liegen ausserhalb des Programmordners).

## Backup & Wiederherstellung

Gesichert werden müssen **zwei** Dinge zusammen – eines ohne das andere
ist wertlos:

1. Das Docker-Volume `zeiterfassung_data` (enthält die SQLite-Datenbank)
2. Der `ENCRYPTION_KEY` aus eurer `.env`-Datei (ohne ihn lassen sich die
   verschlüsselt gespeicherten Aufgaben-Texte nicht mehr lesen)

Beispiel für eine Volume-Sicherung:

```bash
docker run --rm \
  -v zeiterfassung_data:/data \
  -v "$(pwd)/backup":/backup \
  alpine tar czf /backup/zeiterfassung-$(date +%F).tar.gz -C /data .
```

`.env` (insbesondere `ENCRYPTION_KEY` und `SESSION_SECRET`) separat und
sicher aufbewahren, z.B. im Passwort-Tresor des Unternehmens – nicht im
selben Backup-Ziel wie die Datenbank, falls das eine getrennte
Schutzstufe haben soll.

## Updates

```bash
git pull   # oder: neue Version der Dateien auf den Server kopieren
docker compose up -d --build
```

Die Datenbank (Docker-Volume) bleibt dabei erhalten.

## Fehlerbehebung

- **"'rp.id' cannot be used with the current origin"** beim Anlegen eines
  Passkeys: Die aufgerufene Adresse ist der Anwendung nicht bekannt. Beim
  Start schreibt sie alle konfigurierten Adressen ins Log:
  ```bash
  docker compose logs app | grep "Konfigurierte Adressen"
  ```
  Fehlt die betroffene Adresse dort, gehört sie in `RP_ORIGINS` in der
  `.env` (vollständig mit `https://`, mehrere durch Komma getrennt).
  Anschließend **den Container neu erstellen**, nicht nur neu starten, sonst
  bleiben die alten Werte aktiv:
  ```bash
  docker compose up -d --force-recreate
  ```
  Beim nächsten Versuch steht bei einer unbekannten Adresse zusätzlich eine
  `[WARNUNG]`-Zeile im Log, die genau den fehlenden Eintrag nennt.
- **Passkeys funktionieren nicht / "Passkey-Registrierung fehlgeschlagen"**:
  `RP_ID` und `RP_ORIGIN` in `.env` müssen exakt zur Domain passen, unter
  der die Seite im Browser aufgerufen wird (Schema, Domain, ohne
  abschließenden Slash bei `RP_ORIGIN`). Nach Änderung: Container neu
  starten.
- **"Sicherheitstoken ungültig oder abgelaufen" bei JEDEM Login-Versuch
  (auch nach Cookie-Löschung)**: Das ist praktisch immer ein Zeichen dafür,
  dass der Browser das Session-Cookie gar nicht erst speichert. Häufigste
  Ursache: `COOKIE_SECURE=true` verlangt eine echte HTTPS-Verbindung bis
  zum Browser, aber entweder kommt die Anfrage nicht wirklich über HTTPS
  an, oder die App merkt es nicht (weil `TRUST_PROXY` fehlt oder der
  Reverse-Proxy keinen `X-Forwarded-Proto: https`-Header sendet). Die App
  erkennt genau diesen Fall jetzt selbst und schreibt beim ersten
  betroffenen Request eine klare Warnung ins Log:
  ```bash
  docker compose logs app | grep WARNUNG
  ```
  Erscheint diese Warnung, prüfen: (1) wird die Seite wirklich über
  `https://` aufgerufen, nicht direkt per `http://` oder IP/Port? (2) ist
  in nginx proxy manager "Force SSL" aktiv? (3) steht `TRUST_PROXY=true`
  in der `.env`? Danach Container neu starten
  (`docker compose up -d --force-recreate`). Zusätzlich in den
  Browser-Entwicklertools unter "Anwendung/Application" → "Cookies"
  prüfen, ob nach dem Seitenaufruf ein Cookie namens `zeit.sid` gesetzt
  wurde – falls nicht, ist das die Bestätigung dieses Problems.
  Hinweis: Anfragen von `127.0.0.1` (typischerweise der eingebaute
  Docker-`HEALTHCHECK` auf `/api/health`, der bewusst direkt und ohne
  Proxy läuft) lösen diese Warnung nicht aus – relevant ist nur, wenn sie
  bei echten Pfaden wie `/api/csrf-token` oder `/api/auth/login` mit einer
  öffentlichen IP auftaucht.
- **Beim Öffnen der Seite erscheint direkt die Startseite statt des
  Logins**: Betraf eine ältere Version dieser App (Weiterleitung griff
  bei `/` nicht zuverlässig) und ist seit dieser Version behoben – die
  Zugriffskontrolle für `/`, `/index.html`, `/account.html` und
  `/admin.html` läuft jetzt serverseitig, nicht mehr nur im Browser-
  JavaScript.
- **"npm notice ... New major version of npm available"**: Keine
  Fehlermeldung, nur ein Hinweis von npm selbst. Kann ignoriert werden;
  ein Upgrade auf npm 12 ist für diese App nicht nötig.
- **2FA-Codes werden als falsch abgelehnt**: Serverzeit prüfen (TOTP ist
  zeitbasiert) – `date` im Container bzw. auf dem Host sollte mit einer
  NTP-Quelle synchron sein.
- **Admin-Passwort vergessen**: `docker compose exec app npm run
  create-admin` legt einen weiteren Admin-Account an (überschreibt nichts
  Bestehendes).

## Bekannte Grenzen im Detail

- **Überschneidende Einträge werden nicht geprüft.** Wer versehentlich
  09:00–11:00 und 10:00–12:00 erfasst, bekommt eine Tagessumme von vier
  Stunden, obwohl nur drei vergangen sind. Die Übersicht macht solche
  Ausreißer über die Tagesbalken sichtbar.
- **Einträge über Mitternacht** müssen auf zwei Tage aufgeteilt werden; das
  gilt auch für einen durchlaufenden Timer.
- **Datum und Uhrzeit kommen vom Browser.** Das ist gewollt, damit die
  lokale Zeitzone stimmt, heißt aber auch: Eine falsch gestellte Uhr am
  Arbeitsplatz führt zu falschen Zeiten.

## Automatische Updates (lokaler Betrieb)

Im lokalen Betrieb prüft die Anwendung beim Start und danach alle 4 Stunden, ob
der Stand auf GitHub von der installierten Version abweicht. Gibt es Änderungen,
erscheint oben ein Hinweis **„Update verfügbar – Jetzt aktualisieren?"** mit den
Knöpfen *Jetzt aktualisieren* und *Später*. Unter *Konto → Updates* lässt sich
jederzeit manuell prüfen.

- **Vergleich:** Für jede Programmdatei wird der Git-Hash berechnet und mit dem
  Dateibaum des Branches verglichen, es braucht keine Versionsnummer.
- **Installieren:** Alle geänderten Dateien werden zuerst heruntergeladen und
  gegen ihren Hash geprüft. Erst wenn alles stimmt, werden sie ersetzt;
  bei einem Fehler bleibt die Installation unverändert. Die bisherigen Dateien
  liegen als Sicherung im Datenordner (`update-backup/`, die letzten 3 Stände).
  Danach startet sich die Anwendung über `start-local` selbst neu; ändern sich
  Abhängigkeiten (`package.json`), werden sie vor dem Neustart installiert.
- **Was nie angefasst wird:** `.env`, die Datenbank, `keys.json` und
  `node_modules`. Eigene Änderungen an Programmdateien werden beim Update
  überschrieben (die Sicherung enthält sie).
- **Branch wählen:** `UPDATE_BRANCH=main` (Standard) folgt dem freigegebenen
  Stand, `UPDATE_BRANCH=testing` der Vorabversion zum Ausprobieren. In der
  `.env` bzw. als Umgebungsvariable setzen.
- **Ausschalten:** `UPDATE_CHECK=false`.
- **Servermodus:** Dort gibt es keine Selbstaktualisierung; dort bleibt es bei
  `git pull` und `docker compose up -d --build`.
- **Voraussetzung:** Internetzugang zu `api.github.com` und
  `raw.githubusercontent.com`. Hinter einem Firmen-Proxy kann die Prüfung
  fehlschlagen (die Fehlermeldung steht unter *Konto → Updates*). Dann Node
  mitteilen, den Proxy zu nutzen: `NODE_USE_ENV_PROXY=1` und `HTTPS_PROXY=...`
  setzen (Node 22.21 oder neuer), bei eigener Firmen-CA zusätzlich
  `NODE_EXTRA_CA_CERTS=<Zertifikatsdatei>`.
- **Ratenlimit:** GitHub begrenzt anonyme Anfragen pro Adresse. Die Prüfung
  nutzt bedingte Anfragen, die nicht mitzählen, solange sich nichts ändert.
  Sitzen sehr viele Rechner hinter einer Adresse, hilft `UPDATE_TOKEN` (ein
  GitHub-Token mit Leserecht).
- **Erstmalig einführen:** Installationen, die noch aus einer Version ohne
  diese Funktion stammen, müssen einmal von Hand aktualisiert werden (neue
  Dateien darüberkopieren). Danach läuft es automatisch.

## Aufbau für die Weiterentwicklung

Server- und Lokalbetrieb sind **dieselbe Codebasis**; umgeschaltet wird nur
über `LOCAL_MODE`. Neue Funktionen (Routen, Seiten, Skripte) gelten damit
automatisch für beide Varianten, es gibt nichts doppelt zu pflegen.

- `src/localMode.js` bündelt alles, was nur lokal anders ist (automatische
  Anmeldung, gesperrte Anmelde-Funktionen, Startmeldung, Browser öffnen,
  Helmet-Anpassungen). Ohne `LOCAL_MODE` bleiben diese Teile wirkungslos.
- `src/lib/localKeys.js` legt Datenordner und `keys.json` für den lokalen
  Betrieb an.
- `src/config.js` ist die einzige Stelle, die Umgebungsvariablen liest.
- Im Frontend erkennt `public/js/api.js` den lokalen Modus über
  `/api/auth/me` und setzt `body.local-mode`; Elemente lassen sich mit den
  CSS-Klassen `local-only` bzw. `local-hide` je Variante ein- oder ausblenden.
- Neue Routen, die Daten ändern, gehören **hinter** den CSRF-Schutz in
  `server.js`, auch im lokalen Modus.

## Grenzen / bewusste Design-Entscheidungen

- **Kein Auslastungs-Reporting in diesem Tool.** Absichtlich: Jede Person
  sieht ausschließlich ihre eigenen Einträge, auch Administrator:innen
  nicht. Die eigentliche Auswertung (Auslastung, Kapazitäten, Engpässe)
  findet wie vorgesehen in Jira statt, sobald die Einträge dort eingefügt
  wurden – dieses Tool ist nur die Eingabehilfe davor. Das hält die hier
  gespeicherten Daten auf das Minimum beschränkt.
- **Keine automatische Jira-Übertragung.** Bewusst Copy-&-Paste statt
  Jira-API-Anbindung, damit keine Jira-Zugangsdaten/-Berechtigungen in
  diesem System verwaltet werden müssen.
- **Keine Selbstregistrierung.** Konten werden ausschließlich von
  Administrator:innen angelegt.
- **Azure AD / Entra ID Anbindung**: aktuell nicht implementiert (bewusst
  zurückgestellt). Die Datenbank ist dafür bereits vorbereitet (`users`-
  Tabelle hat Felder für einen externen Identitätsanbieter), sodass sich
  das später ergänzen lässt, ohne bestehende Konten/Daten zu verlieren.
