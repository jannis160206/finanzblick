# Abrechnungen, Google Drive & Planung – Zusammenfassung

Stand: 11.11.2026 · Grundlage: `docs/ABRECHNUNGEN-DRIVE-PLAN.md`

Der Plan wurde **ohne ausdrückliche Rückmeldung** umgesetzt: Die Freigabe-Rückfrage kam mit „Nutzer nicht verfügbar – autonom weiterarbeiten“ zurück. Gearbeitet wurde deshalb mit den 14 Annahmen aus Abschnitt 7 des Plans. Jede davon lässt sich nachträglich ändern; die Annahmen stehen in der Tabelle unten.

## Meilensteine und Commits

Jeder Meilenstein ist ein eigener Commit auf einem eigenen, gestapelten Branch (Basis: `salary/m3-goal-tr`). Nach jedem Meilenstein waren `npm run typecheck`, `npm test` und `npm run build` grün.

| Meilenstein | Branch | Commit | Inhalt |
|---|---|---|---|
| Plan | `drive/m1-upload` | `e6c4b67` | `docs/ABRECHNUNGEN-DRIVE-PLAN.md` |
| M1 Upload + Passwort-Pop-up | `drive/m1-upload` | `6e9687a` | Upload-Fläche entfernt, Kopf-Button öffnet die Dateiauswahl, PremiumDialog für Passwörter |
| M2 Gespeichertes Passwort | `drive/m2-password` | `debf36c` | AES-256-GCM-Speicher (Server bzw. Browser), Einstellungsbereich „Abrechnungen“ |
| M3 Google Drive OAuth | `drive/m3-oauth` | `c72950a` | Verbinden/Trennen, PKCE + `state`, Tokens verschlüsselt |
| M4 Ordner-Abfrage | `drive/m4-polling` | `f1d300f` | Hintergrund-Abruf, Dedupe, AMEX → Auszugs-Warteschlange, Lohnzettel → Drive-Inbox |
| M5 Sonderzahlung & Jahressechstel | `drive/m5-sixth` | `384d86b` | Karten, 12er-Monatsraster, Progressive Disclosure |
| M6 Regeln & Planung | `drive/m6-rules` | `60dade9` | Verträge, Sparziel-Logik, Gehaltsprognose, Trade Republic nur per API, Mittagessen |
| M7 Feinschliff | `drive/m7-polish` | `8fd9598` | Hinweis bei abgelaufener Freigabe, Logging, Rate-Limits, diese Zusammenfassung |
| M8 Einrichtung & Hintergrund-Lohnzettel | `drive/m8-setup` | `794f66b` | Statusanzeige, Weiterleitung localhost ↔ 127.0.0.1, Lohnzettel aus Drive ohne offenen Browser |
| M9 Gehalt & Steuern aufgeräumt | `payroll/cleanup` | `e30bd0f` | Monatslogik nach Auszahlung, 2025 als Referenz, Prognose am aktuellen Gehalt, Rufbereitschaft ≠ Feiertagsarbeit/Überstunden, Import-Protokoll |
| M10 Automatische Budget-Übernahme | `payroll/auto-budget` | `f897992`–`bf4944e` + Tests/Doku | Prüfung jeder Abrechnung, automatische Übernahme, gelerntes Profil, Glossar mit optionalem Nachschlagen (`docs/PAYROLL-AUTOMATION.md`) |

Alle Branches sind per Fast-Forward in `main` gemergt und gepusht; die Feature-Branches sind gelöscht.

## Was sich geändert hat

### M1 – Upload über den Kopf-Button
- Drag-and-drop-Fläche, „PDF auswählen“ und das sichtbare Passwortfeld sind entfernt. Der grüne Button **„Abrechnungen hochladen“** öffnet direkt die Dateiauswahl (mehrere PDFs).
- Die Verarbeitung (Limits 24 Dateien / 20 MB, Bericht, Dubletten, Ersetzen-Dialog, Budget-Netto) ist unverändert, liegt aber jetzt in einem app-weiten `PayslipUploadProvider` (`src/components/payslip-upload.tsx`). Button, zentraler Import und Drive nutzen ihn gemeinsam.
- **Passwort-Pop-up** (PremiumDialog, am Handy Bottom Sheet), nur wenn eine Datei es braucht:
  - Dateiliste mit Status, Show/Hide-Toggle, Fehler „Passwort falsch“.
  - Bei mehreren geschützten Dateien der Schalter **„Passwort für alle Dateien verwenden?“** (Standard an); aus = ein Feld je Datei.
- Test-Fixture: echte RC4-verschlüsselte PDFs (`tests/fixtures/payroll-state.ts`).

### M2 – Gespeichertes PDF-Passwort
- Einstellungen → **Abrechnungen → PDF-Passwort**: speichern, ersetzen, entfernen. Ein gespeichertes Passwort wird nie wieder angezeigt.
- **Kontomodus**:
  - Speicherung AES-256-GCM in `secrets/<id>.json` (0600).
  - Schlüssel aus `FINANZBLICK_SECRET_KEY` oder einmalig erzeugtem `secret.key` neben der Datenbank (`src/lib/server/secrets.ts`, `user-secrets.ts`).
  - Abruf über die authentifizierte `no-store`-Route `/api/payslip-password`.
- **Browsermodus**: Web Crypto mit nicht exportierbarem Schlüssel in IndexedDB.
- Jede Lohnzettel-Verarbeitung versucht zuerst ohne, dann mit dem gespeicherten Passwort. Das Pop-up meldet ein unpassendes gespeichertes Passwort und bietet „Passwort sicher speichern“ an.

### M3 – Google Drive verbinden
- Einstellungen → **Banken & Verbindungen → Google Drive** (nur Kontomodus): Status, „Mit Google verbinden“, „Erneut verbinden“ bei Ablauf, „Trennen“ mit Token-Widerruf.
- OAuth mit Scope `https://www.googleapis.com/auth/drive.readonly`, `access_type=offline`, `state` + PKCE (S256) in einem kurzlebigen, versiegelten HttpOnly-Cookie. Rückkehr über `/api/auth/callback/google`.
- Konfiguration ausschließlich über `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` und optional `GOOGLE_REDIRECT_URI`.
- Tokens liegen verschlüsselt in `secrets/<id>.json`, der Status in `drive-links/<id>.json`.

### M4 – Automatische Ordner-Abfrage
- **Takt**: Der Statement-Worker läuft alle 5 Minuten (seit M8; vorher 15), die Ordner je Konto stündlich (bei Rückstau früher). **„Jetzt prüfen“** startet sofort.
- **„AMEX Abrechnungen“** (PDF/CSV/XLSX) → dieselbe Warteschlange wie ein manueller Kontoauszug. Funktioniert auch ohne offenen Browser.
- **„Abrechnungen“** (PDF) → private Drive-Inbox. Seit M8 liest der Worker diese Lohnzettel im Hintergrund (siehe M8); die geöffnete App übernimmt nur noch, was den Nutzer braucht (Passwort-Pop-up „Neu aus Google Drive“, Ersetzen-Bestätigung). Ein manueller Upload hat immer Vorrang.
- **Deduplizierung**:
  - Register aus Drive-ID + Prüfsumme bzw. Änderungszeit (max. 5000 Einträge).
  - Geänderte Dateien laufen erneut durch; die bestehende Inhalts-Dublettenprüfung verhindert doppelte Buchungen.
  - Download-Fehler werden bis zu dreimal wiederholt; übersprungene Dateien holt **„Erneut versuchen“** zurück.
- **Mehrere gleichnamige Ordner**: Bis zur Auswahl im Einstellungsbereich wird der zuletzt geänderte gelesen.
- **Abgelehnter Access-Token**: wird einmal erneuert, bevor die Verbindung als abgelaufen gilt.
- **Einstellungen** zeigen je Ordner die Dateianzahl, Hinweise, wartende Lohnzettel, Rückstau und unter „Zuletzt verarbeitet“ die letzten Dateien mit Status.

### M5 – Sonderzahlung & Jahressechstel
- **Karten**:
  - **Nächste Sonderzahlung**: großes Netto, Status-Chip, Balken Netto · Lohnsteuer · SV, Mehr-/Mindersteuer.
  - **Jahressechstel**: verbraucht · Rest · Überhang, Quelle „laut Abrechnung“ bzw. „berechnet“, Schätzung „vorläufig“ bzw. „Spanne“.
  - **Prämien-Spielraum** mit aufklappbarem 1.000-€-Steuerbeispiel.
- **Monatsübersicht Jänner–Dezember** als Kachelraster (3/4/6 Spalten) mit belegt / geschätzt / fehlt und Sonderzahlungsmarker. Ein Klick öffnet die Monatsdetails.
- Die Berechnungen sind unverändert; nur die Darstellung ist neu.

### M6 – Regeln und Planung
- **Verträge**:
  - Jede Serie hat eine stabile Kennung (Händler, Rhythmus, Betragsband); jede Entscheidung speichert eine Momentaufnahme.
  - Einmal als „Ist ein Vertrag“ oder „Kein Vertrag“ markierte Vorschläge erscheinen nicht erneut unter „Neu erkannt“, auch nach Preisänderungen bis 20 %.
- **Sparziel**:
  - **Sparanteil** (Standard 10 % des Überschusses, mindestens 180 €) geht immer zuerst aufs Sparkonto.
  - **„So schnell wie möglich“** lässt eine **Reserve** (Standard 15 %) auf dem Konto.
  - „Kontoregel: nur für Notfälle“ ist entfernt. Je Konto außer Girokonto gibt es einen **Behalten**-Betrag; nur der Rest darf einmalig ins Ziel (Sparkonto, Trade Republic).
  - Die Planung rechnet mit der Gehaltsprognose inklusive Sonderzahlungen (Dezember/Jänner).
- **Gehaltsprognose + „Budget aktualisieren“** (Budget-Seite):
  - Grundlage sind die letzten zwölf Monate (Abrechnungen oder Gehaltseingänge), hochgerechnet auf das aktuelle Niveau.
  - Sonderzahlungen kommen aus dem Vorjahresmonat bzw. dem Gehaltsmodell; Rufbereitschaft und Überstunden sind Durchschnitte.
  - Der Dialog schlägt neue Werte für Einnahmenzeilen vor und erkennt doppelte Sonderzahlungen in „Sonstiges“. Übernommen wird nur, was ausgewählt ist.
- **Trade Republic**:
  - Die manuellen Felder (Kontostand, Zinssatz, Datum) sind entfernt. Die Sparen-Seite zeigt eine Karte nur mit Daten aus der Bankanbindung.
  - Der Zinssatz kommt aus den Zinsgutschriften (`src/lib/tr-interest.ts`) und wird von Dashboard, Planer und Assistent gemeinsam genutzt.
- **Mittagessen**:
  - Revolut-Zahlungen Mo–Fr 11:00–14:00 bei Mensa, Wiener Reuther, BIPA, BILLA und SPAR werden automatisch „Mittagessen“.
  - In gespeicherten Urlaubszeiträumen gibt es keine automatische Zuordnung; manuelle Kategorien haben Vorrang.

### M7 – Feinschliff
- Läuft die Google-Freigabe ab (Testmodus: nach 7 Tagen), erscheint **einmal pro Sitzung** ein Hinweis mit „Verbinden“. Neue Abrechnungen bleiben sonst unbemerkt aus.
- Worker-Logs sind leiser: Sie erscheinen nur bei neuen oder fehlgeschlagenen Dateien und Rückstau, mit eigenem Hinweis bei abgelaufener Freigabe. Dateinamen und Tokens werden nie geloggt.
- Die Inbox-Dateirouten haben ein Rate-Limit (600 Anfragen pro Minute und Konto).
- Die Assistenten-Texte (Sparanteil, Reserve, Zinssatz aus Gutschriften) und das README sind aktualisiert.

### M8 – Einrichtung, Weiterleitung und Lohnzettel im Hintergrund
- **Zugangsdaten**: `GOOGLE_CLIENT_ID` und `GOOGLE_CLIENT_SECRET` stehen in der lokalen, git-ignorierten `.env.local`, nie im Code und in keinem Commit. Next.js lädt die Datei beim Start; der Statement-Worker erbt die Umgebung (`npm run dev`) bzw. lädt sie selbst (`npm run worker`, in Produktion `EnvironmentFile=/etc/finanzblick.env`). Google bestätigt Client-ID, Secret und die `localhost`-Weiterleitungs-URI (Probe gegen Autorisierungs- und Token-Endpunkt).
- **„Nicht eingerichtet“** erscheint nur noch, wenn eine Variable wirklich fehlt, und nennt dann genau diese. Sonst zeigt der Bereich ein Status-Badge: **Verbunden**, **Nicht verbunden** oder **Freigabe abgelaufen**.
- **Weiterleitungs-URI**:
  - Lokal verwendet Finanzblick immer `http://localhost:<Port>/api/auth/callback/google`, auch unter `127.0.0.1` oder `[::1]`. Das ist die in der Console eingetragene URI; `127.0.0.1` lehnt Google für diesen Client ab.
  - Der Ursprung, auf dem die Verbindung gestartet wurde, steht zusätzlich im OAuth-`state`; geprüft wird der gesamte `state` weiterhin gegen das versiegelte State-Cookie. Kommt Googles Antwort auf `localhost` an, wo weder Sitzungs- noch State-Cookie liegen, reicht der Callback sie an diesen Ursprung weiter: nur zwischen Loopback-Namen mit gleichem Port und Schema, nie an einen anderen Server. Dort laufen State-, Sitzungs- und PKCE-Prüfung unverändert.
  - Damit funktioniert die Verbindung mit `FINANZBLICK_ORIGIN=http://127.0.0.1:3000` (aktuelle Einstellung) ebenso wie mit `localhost`. Finanzblick selbst bleibt unter der Adresse aus `FINANZBLICK_ORIGIN` zu öffnen, weil Änderungen nur von dort angenommen werden (unverändert).
- **Lohnzettel ohne offenen Browser** – ohne Änderung an `src/lib/import/`:
  - Der Worker liest Lohnzettel aus der Drive-Inbox mit demselben Parser wie der Browser (`parsePayslipPdf`; im Browser nutzt PDF.js den Worker unter `/api/pdf-worker`, in Node wird nur der PDF.js-Worker-Pfad von außen gesetzt).
  - Gelesen wird in einem kurzlebigen, isolierten Prozess ohne Umgebungs-Secrets (384 MB, 60 s). Das gespeicherte PDF-Passwort geht nur per IPC an diesen Prozess.
  - Die Übernahme entspricht dem Upload: speichern, Netto in den Folgemonat, Standard-Gehaltsmodelle zur Bestätigung zurücksetzen, Planung abgleichen. Das passiert in einer Revision der Finanzdaten; ein offener Tab erfährt es per Echtzeit-Update.
  - Bleibt für die App: Lohnzettel, zu denen kein gespeichertes Passwort passt (ein später gespeichertes Passwort wird automatisch erneut versucht), und Lohnzettel, die gespeicherte abweichende Werte ersetzen würden (nie ohne Bestätigung).
  - Ohne laufenden Worker liest die geöffnete App die Inbox nach 20 Minuten selbst, nach „Jetzt prüfen“ sofort.

### M9 – Gehalt & Steuern aufgeräumt und Gehaltslogik korrigiert
- **Seite**:
  - Die Steuer-Mappe ist von der Seite entfernt. Die Auswertung bleibt über den Assistenten erreichbar (`src/lib/tax-folder.ts` unverändert).
  - Importhinweise, „Automatisch gelesene Werte“ und die Tabelle „Gespeicherte Abrechnungen“ sind weg. Am Ende steht eine kurze Zusammenfassung („10 Abrechnungen übernommen · zuletzt Oktober 2026“) mit **Budget aktualisieren** und **Erneut prüfen**.
  - Die Monatsübersicht mit Kacheln ist die Hauptansicht ganz oben; „Sonderzahlung & Jahressechstel“ bleibt unverändert modern.
  - Eine Abrechnung entfernt man jetzt in den Details ihres Monats.
- **Import-Protokoll**:
  - Jeder Import (Upload, zentraler Import, Drive im Browser oder im Hintergrund, „Erneut prüfen“) schreibt einen strukturierten JSON-Eintrag. Er enthält Quelle, Dateien mit Ergebnis, Hinweise, gelesene Entwürfe mit Feldern, Anzahl gespeicherter Abrechnungen und Referenzmonate.
  - Im Kontomodus liegt das Protokoll in `payslip-logs/<id>.json` neben der Datenbank (0600, max. 200 Einträge), Route `/api/payslip-log`. Im Browsermodus liegt es in `localStorage` (max. 50 Einträge).
  - Einstellungen → Abrechnungen → **Import-Protokoll** zeigt die letzten Einträge mit „JSON herunterladen“ und „Leeren“.
- **Monatslogik**:
  - Die Kacheln zeigen den **Auszahlungsmonat**: Die Oktober-Abrechnung erscheint im November, die Dezember-Abrechnung im Jänner. Die Budget-Einträge folgen schon dieser Regel; vorher zeigten die Kacheln den Abrechnungsmonat und wirkten dadurch einen Monat zu früh.
  - Geschätzte Kacheln nutzen dieselbe Gehaltsprognose wie „Budget aktualisieren“, damit Kachel und Budget übereinstimmen.
- **2025 als Referenz**:
  - Schema und Parser akzeptieren 2025. Das ist die einzige, minimale Änderung in `src/lib/import/payslip.ts`: Jahresprüfung plus Hinweistext. Weiterhin gilt: kein Jahr vor 2025, und Steuerjahre bleiben 2026/2027.
  - 2025-Abrechnungen werden gespeichert, als „Referenz“ angezeigt und nie ins Budget eingetragen, auch nicht im Hintergrund. Fehlermeldungen lösen sie keine aus.
- **Prognose am aktuellen Gehalt**:
  - Das Jahresmodell schreibt die letzte *übliche* Abrechnung zum aktuellen Grundgehalt fort, nicht einfach die letzte. Ein Monat mit mehr als 25 % über dem Median, z. B. Oktober mit vielen Überstunden, ist kein Maßstab mehr. Das gilt auch für die Sechstel-Schätzungen.
  - Die Gehaltsprognose rechnet Rufbereitschaft und Überstunden als **Median** statt Durchschnitt. Die pauschale Rufbereitschaft wird nicht mit der Gehaltserhöhung skaliert.
  - Feiertagsarbeit kommt nur aus dem gleichen Monat des Vorjahres. 2025-Daten dienen dabei nur als skaliertes Muster.
  - Eine mit dem Gehalt überwiesene Prämie (Gehaltseingang über 140 % des Niveaus) zählt als Sonderzahlung.
- **Rufbereitschaft ≠ Feiertagsarbeit ≠ Überstunden** (`src/lib/payroll-pattern.ts`):
  - Die normale Rufbereitschaft wird je Arbeitgeber gelernt: häufigster Betrag der letzten zwölf Abrechnungen.
  - Mehr Rufbereitschaft auf einer Abrechnung bedeutet Feiertagsdienste und zählt als Feiertagsarbeit.
  - Brutto über Grundgehalt, Rufbereitschaft und Feiertagsarbeit zählt als Überstunden.
  - Bei Akonto + Auszahlung wird die Auszahlung nach diesen Bruttoanteilen aufgeteilt, statt komplett in „Rufbereitschaft“ zu landen.
  - Bankbuchungen ohne Abrechnung: Rufbereitschaft über 125 % des Üblichen gilt als Feiertagsarbeit.
- **Budget-Korrektur**: Die Regel, die Überstunden in bereits abgerechneten Monaten auf 0 setzte, ist entfallen, weil die Abrechnung sie jetzt selbst getrennt einträgt.
- **Erneut prüfen**:
  - trägt alle gespeicherten Abrechnungen neu ins Budget ein (mit der neuen Aufteilung);
  - lässt bei verbundenem Drive alle Lohnzettel aus „Abrechnungen“ erneut lesen (neue Aktion `recheck` in `/api/drive`);
  - protokolliert den Lauf.
- **Mit echten Daten geprüft** (nur lokal, nichts davon ist im Repository):
  - Die normale Rufbereitschaft wird korrekt erkannt.
  - Der Oktober-Ausreißer wird als Feiertagsarbeit und Überstunden erkannt statt als Rufbereitschaft.
  - Die Prognose für November und Dezember setzt das übliche laufende Brutto statt des Oktober-Werts an.
  - Monatssummen im Budget bleiben gleich, nur die Aufteilung ändert sich.

### M10 – Abrechnungen automatisch ins Budget
- **Kein „Budget aktualisieren“ mehr**: Konsistente Abrechnungen und die Gehaltsprognose gehen ohne Bestätigung ins Budget. Rückmeldung per kurzem Toast („Budget aus Abrechnungen aktualisiert · n Werte“) und als Statuszeile in der Zusammenfassung.
- **Schutz vor Überschreiben**: Finanzblick merkt sich die selbst gesetzten Werte im optionalen Feld `payrollBudget` der Finanzdaten (JSON, keine Migration). Von Hand geänderte Werte und doppelte Sonderzahlungen in „Sonstiges“ werden nie automatisch geändert, sondern unter **„n Budgetwerte prüfen“** angeboten (Budget-Seite und Zusammenfassung). Was man beibehält, wird nicht erneut angeboten.
- **Prüfung jeder Abrechnung** (`src/lib/payslip-validation.ts`): Netto-Abgleich, Überweisungen gegen Netto, Brutto-Bestandteile und Lohnsteuerquote halten eine widersprüchliche Abrechnung vom Budget fern. SV-Quote, Sechstel-Besteuerung der Sonderzahlung, Jahreswerte, Rufbereitschaft, Sonderzahlungsmonat und Ausreißer sind Warnungen bzw. Infos. Zurückgehaltene Abrechnungen tragen in der Monatsübersicht den Status **prüfen** und lassen sich nach Kontrolle mit **Ins Budget übernehmen** bestätigen.
- **Gelerntes Profil** (`src/lib/payroll-pattern.ts`): Rufbereitschafts-Pauschale je Jahr, Monate mit Feiertagsdiensten, Sonderzahlungs- und Prämienmonate, Höhe der Sonderzahlung (fließt in die Prognose) und Akonto-Muster. Anzeige unter Einstellungen → Abrechnungen → Import-Protokoll.
- **Unklare Begriffe** (`src/lib/payslip-terms.ts`): lokales Glossar; optional (standardmäßig aus) Nachschlagen in der deutschsprachigen Wikipedia über den eingebauten MCP-Server. Nur der Begriff verlässt das Gerät. Ergebnisse im Import-Protokoll.
- **Import-Protokoll**: Neue Felder `validation`, `lookups` und `budget` (übernommen, zur Prüfung, zurückgehalten) sowie die Quelle `budget` für automatische Abgleiche.
- **Keine Änderung in `src/lib/import/`.** Eine Erweiterung der Parser-Hinweise um die Bezeichnung unbekannter Bestandteile wurde verworfen, weil der Parser diese Texte aus Datenschutzgründen bewusst nicht weitergibt.
- **Mit echten Daten geprüft** (nur lokal): alle 21 lesbaren Abrechnungen konsistent; der automatische Abgleich übernahm 36 Werte inklusive der neuen Zeile „Überstunden“.

## Einrichtung Google Drive

1. **Google Cloud Console**:
   - Projekt anlegen.
   - Unter „APIs & Dienste“ die **Google Drive API** aktivieren.
   - OAuth-Zustimmungsbildschirm vom Typ **Extern** im Status **Testen** anlegen und das eigene Google-Konto als **Testnutzer** eintragen.
2. **Anmeldedaten → OAuth-Client-ID** vom Typ **Webanwendung** anlegen:
   - Autorisierte Weiterleitungs-URI: `http://localhost:3000/api/auth/callback/google` (lokal) bzw. `https://<deine-domain>/api/auth/callback/google`.
   - JavaScript-Ursprung: `http://localhost:3000`.
3. **Zugangsdaten** in der privaten Umgebungsdatei setzen (lokal `.env.local`, Server `/etc/finanzblick.env`), **nie** ins Repository:
   ```dotenv
   GOOGLE_CLIENT_ID="…apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="…"
   # optional: FINANZBLICK_SECRET_KEY=<32 Byte Base64, z. B. openssl rand -base64 32>
   ```
   Auf diesem Rechner ist das in `.env.local` erledigt.
4. **Weiterleitungs-URI**: In der Console genügt lokal `http://localhost:3000/api/auth/callback/google`. Finanzblick wird unter der Adresse aus `FINANZBLICK_ORIGIN` geöffnet (hier `http://127.0.0.1:3000`); die Rückkehr von Google über `localhost` wird automatisch dorthin weitergereicht. Für einen Server mit Domain: `https://<domain>/api/auth/callback/google` eintragen (oder per `GOOGLE_REDIRECT_URI` festlegen).
5. **Neu starten**:
   - `npm run dev` startet Web-App und Worker gemeinsam.
   - In Produktion braucht es den Web-Dienst **und** `finanzblick-worker.service`. Der Worker führt die stündliche Abfrage aus und liest dieselbe `/etc/finanzblick.env`; nach dem Eintragen beide Dienste neu starten.
6. **Verbinden**: Einstellungen → Banken & Verbindungen → Google Drive → **Mit Google verbinden**.
7. **Ordner** in „Meine Ablage“ anlegen bzw. nutzen: **„AMEX Abrechnungen“** und **„Abrechnungen“** (exakte Namen).

**Sicherheit:**
- `secret.key` (bzw. `FINANZBLICK_SECRET_KEY`) gehört zur Sicherung dazu. Ohne ihn lassen sich gespeichertes PDF-Passwort und Drive-Tokens nicht entschlüsseln; dann einfach neu hinterlegen bzw. neu verbinden.
- **Client-Secret rotieren**: Client-ID und Client-Secret standen im Klartext im Chat (als Nachricht, als JSON-Datei und auf einem Screenshot). Sie liegen jetzt nur in der git-ignorierten `.env.local` und in keinem Commit. Trotzdem gilt das Secret als offengelegt:
  1. Google Cloud Console → Google Auth Platform → Clients → diesen Client öffnen → **Secret hinzufügen**.
  2. Das neue Secret in `.env.local` (bzw. `/etc/finanzblick.env`) bei `GOOGLE_CLIENT_SECRET` eintragen.
  3. Finanzblick und Worker neu starten.
  4. Das alte Secret in der Console **deaktivieren und löschen**. Bestehende Verbindungen laufen weiter (Refresh-Tokens gelten pro Client, nicht pro Secret).
  5. Die heruntergeladene JSON-Datei löschen.

## Annahmen (autonom getroffen)

| Nr. | Annahme | Umsetzung |
|---|---|---|
| 1 | Pop-up nur bei Bedarf | ✓ |
| 2 | Passwort unter „Abrechnungen“, Drive unter „Banken & Verbindungen“ | ✓ |
| 3 | Serverseitige Verschlüsselung, im Browser Web Crypto | ✓ |
| 4 | Drive nur im Kontomodus; Lohnzettel beim nächsten Öffnen der App | ✓, seit M8 im Hintergrund (Passwort und Ersetzen weiterhin in der App) |
| 5 | Abfrage stündlich + „Jetzt prüfen“, exakte Ordnernamen | ✓ |
| 6 | Weiterleitungs-URI aus der Finanzblick-Adresse | ✓ (`GOOGLE_REDIRECT_URI` optional); seit M8 lokal immer `localhost` mit Weiterleitung |
| 7 | Kachelraster ersetzt Monatsliste und „Monatliche Prognose“ | ✓ |
| 8 | Alte Vertragsentscheidungen über die Marke übernehmen, wenn eindeutig | ✓ |
| 9 | Reserve 15 %, Sparanteil 10 % (mind. 180 €), Behalten TR = Notgroschen-Ziel | ✓ |
| 10 | Gehaltsprognose datenbasiert, Budget nur nach Bestätigung | ✓ |
| 11 | Trade Republic ohne manuelle Eingaben | ✓ |
| 12 | Revolut-Mittagessen ohne Betragsgrenze; 10-€-Grenze bei anderen Banken bleibt | ✓ |
| 13 | Zugangsdaten nur über Umgebungsvariablen | ✓ |
| 14 | Ältere rote E2E-Specs nur anfassen, wenn betroffen | ✓ |

## Qualität

- **Gesamtlauf**:
  - `npm run typecheck`: Exit 0.
  - `npm test`: 5057 bestanden, 5 erwartet fehlschlagend, 3 übersprungen (vorher 4968).
  - `npm run build`: Exit 0. Die Build-Warnungen in `src/lib/ai/logo-finder.ts` bestanden schon vorher.
- **Nach M8**: `npm run typecheck` und `npm run build` Exit 0, `npm test` 5069 bestanden, 5 erwartet fehlschlagend, 3 übersprungen. Neu:
  - Weiterleitung localhost ↔ 127.0.0.1, inklusive Ablehnung fremder Hosts und Ports;
  - fehlende Variablen und Status-Badges;
  - Lohnzettel-Prozess mit echter verschlüsselter PDF;
  - Hintergrund-Import mit echter Kontodatenbank: Übernahme, Dubletten, Passwort später gespeichert, keine Ersetzung ohne Bestätigung;
  - Browser übernimmt nur Wartendes.
- **Neue Tests**: Verschlüsselung, Secret-Speicher, Passwort-Route, OAuth, Drive-Client, Inbox, Sync (Dedupe, Paginierung, Rückstau, Wiederholung, Ordnerwahl, Token-Erneuerung), Drive-Routen, Upload-Provider (Batch-Ergebnisse, Vorrang manueller Uploads), Inbox-Verarbeitung, Einstellungsbereiche, Monatsraster und Karten, Verträge, Trade-Republic-Zins, Mittagessen, Gehaltsprognose, Budget-Korrekturen und Sparziel-Planer.
- **E2E (Playwright)**, bestanden:
  - `salary-settings.spec.ts` in beiden Modi: Gehaltsseite, Einstellungen, Passwort-Dialog, gespeichertes Passwort, Sparziel mit Trade Republic, Bank-Logos, Google Drive (375/768/1440 px, hell/dunkel, axe).
  - `payroll-workspace.spec.ts`: Import echter PDFs, Dubletten, Monatskacheln bei 320/390/1440 px.
- **Bereits vorher rote E2E-Specs** schlagen identisch fehl. Das wurde gegen den Stand vor M6 nachgeprüft; die Ursache sind veraltete Selektoren aus der Zeit vor dem UI-Umbau.
  - `seasonal-theme.spec.ts`, `ux-cut.spec.ts` (Browsermodus);
  - `pockets-workspace.spec.ts`, `budget-workspace.spec.ts`, `savings-transfer-status.spec.ts`, `settings-design.spec.ts`, mobiler Teil von `profile.spec.ts` (Kontomodus).
- **Nach M9**: `npm run typecheck`, `npm run lint` und `npm run build` Exit 0, `npm test` 5089 bestanden, 5 erwartet fehlschlagend, 3 übersprungen. Neu: Lernmuster Rufbereitschaft, Aufteilung Feiertagsarbeit/Überstunden (auch bei Akonto), 2025-Referenz (Parser, Budget, Hintergrund-Import), übliche Referenzabrechnung im Jahresmodell, Median-/Saisonprognose, Prämie als Sonderzahlung, Kacheln nach Auszahlungsmonat, Import-Protokoll (Bibliothek, Dateispeicher, Route), Drive-`recheck`. E2E bestanden: `payslip-safety.spec.ts`, `payroll-workspace.spec.ts` (320/390/1440 px) und `salary-settings.spec.ts` für Gehalt & Steuern (375/768/1440 px, hell/dunkel, axe). Ein Kachel-Test im Kontomodus schlug einmal wegen automatisch nachgefüllter Monatsbudgets fehl und lief bei der Wiederholung durch (bekannter Reload-Effekt, nicht payroll-bezogen).
- **Nach M10**: `npm run typecheck`, `npm run lint` und `npm run build` Exit 0, `npm test` 5114 bestanden, 5 erwartet fehlschlagend, 3 übersprungen. Neu: Prüfregeln (kalibriert an echten Werten, als synthetische Fälle), automatischer Abgleich mit Merkstatus, Prüf-Dialog, zurückgehaltene und bestätigte Abrechnungen (Upload, Hintergrund-Import, Kachel), Pauschale je Jahr und Profil, Glossar und Nachschlagen (Browser und Server). E2E bestanden: `payslip-safety.spec.ts`, `salary-settings.spec.ts` (375/768/1440 px, hell/dunkel, axe) und `payroll-workspace.spec.ts` im Kontomodus. `payroll-workspace` und `budget-workspace` gleichen ihre Testdaten jetzt vorab mit `syncPayrollBudget` ab, weil die App das Budget sonst beim ersten Laden selbst korrigiert. Der bekannte Reload-Effekt trat einmal auf und lief bei der Wiederholung durch.
- **Hinweis zu Kontomodus-E2E**: Viele Specs in einem Lauf lösen das Login-Rate-Limit aus („Zu viele Versuche“). Deshalb in kleineren Gruppen mit jeweils frischer Test-Datenbank ausführen.

## Offene Punkte und Grenzen

- **Produktion**: Google erlaubt als Weiterleitungs-URI keine öffentliche IP-Adresse. Auf dem Server braucht es eine Domain (z. B. über einen Reverse Proxy).
- **Testmodus**: Freigaben laufen nach 7 Tagen ab, und nur Testnutzer können sich verbinden. Dauerhaft geht das nur mit veröffentlichter App. `drive.readonly` ist ein eingeschränkter Scope; die Veröffentlichung verlangt eine Google-Prüfung.
- **Lohnzettel aus Drive** laufen seit M8 im Hintergrund. Nur geschützte Dateien ohne passendes gespeichertes Passwort und Abrechnungen, die gespeicherte Werte ersetzen würden, warten auf die geöffnete App. Ohne laufenden Statement-Worker (`FINANZBLICK_AUTO_WORKER=0` bzw. Dienst gestoppt) liest die App die Inbox wie bisher selbst.
- **Passwortgeschützte AMEX-PDFs** werden vom Server-Parser nicht entschlüsselt (die Import-Logik in `src/lib/import/` bleibt bewusst unverändert). Der Auszugs-Import meldet sie im Uploadstatus als nicht lesbar. Eine entsperrte Kopie im Ordner wird als neue Datei übernommen.
- **Gleichzeitiger Abruf** von Worker und „Jetzt prüfen“ ist nur innerhalb eines Prozesses gesperrt. Doppelte Übernahmen verhindert die Inhalts-Dublettenprüfung.
- **Bestehende Klartext-Secrets** der Mail- und Bankanbindung wurden nicht angefasst (außerhalb des Umfangs). Sie ließen sich mit `src/lib/server/secrets.ts` nachziehen.
- **Bereits vorher rote E2E-Specs** (siehe oben) sollten in einem eigenen Schritt an das neue UI angepasst werden.
- **2025-Abrechnungen aus Drive**: Die zwölf PDFs aus 2025 sind passwortgeschützt, und auf dem Server ist noch kein PDF-Passwort gespeichert. Bisher wurden sie stillschweigend verworfen. Nach dem Speichern des Passworts (Einstellungen → Abrechnungen) und **Erneut prüfen** werden sie als Referenz übernommen und verfeinern die Prognose (Feiertagsarbeit pro Monat, Sonderzahlungen). Bis dahin stützt sich die Prognose auf die 2026-Abrechnungen und Gehaltseingänge.
- **Prognose-Korrekturen im Budget** werden seit M10 automatisch geschrieben. Von Hand geänderte Werte und doppelte Sonderzahlungen bleiben zur Prüfung stehen.
- **Ohne Budgetzeile „Überstunden“** landen Überstunden aus der Auszahlung (Akonto-Fall) in „Feiertagsarbeit“. Der automatische Abgleich legt die Zeile an, sobald die Prognose Überstunden enthält. Danach trennt **Erneut prüfen** auch die abgerechneten Monate in diese Zeile.
- **Nach einem Update** Dev-Server bzw. Dienst und Statement-Worker neu starten: Ein Prozess mit altem Code kennt `payrollBudget` nicht und verwirft den Merkstatus beim Speichern.
- **Online-Nachschlagen** unklarer Begriffe braucht Internet und ist standardmäßig aus. Begriffe, die der Parser nur als Lohnartnummer meldet, werden nicht nachgeschlagen.
- **Monate vor der letzten Abrechnung ohne Abrechnung** zählen als „fehlt“, auch über den Jahreswechsel hinweg, z. B. wenn schon eine Jänner-Abrechnung des Folgejahres vorliegt.
- `src/lib/import/statements.test.ts`: Nur eine Testerwartung wurde an die neue Mittagessen-Regel angepasst (Revolut SPAR 12:00 → Mittagessen). Die Import-Logik ist unverändert.
