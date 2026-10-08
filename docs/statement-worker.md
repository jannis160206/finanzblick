# Lokale Hintergrundverarbeitung

Im Kontomodus werden CSV/XLSX, Amex-Text-PDFs und Amex-Screenshots unverändert
auf den eigenen Server hochgeladen. Der HTTP-Handler streamt höchstens 20 MiB
in eine private Datei, persistiert den Job und antwortet mit **202 Accepted**.
Er führt weder Parsing noch OCR aus. Im reinen Browsermodus bleibt der bisherige
lokale Import erhalten. Lohnabrechnungsimporte sind unverändert.

## Betrieb

Node.js 22.13+ und `npm ci` genügen. `tsx` und `sharp` sind Produktionsabhängigkeiten.
HTTP-Server und Worker laufen als **getrennte Prozesse**, unabhängig voneinander:

```sh
npm run dev
# In einem zweiten Terminal, mit derselben privaten .env.local:
npm run worker
```

Für den vServer die bestehende Kontokonfiguration aus `/etc/finanzblick.env`
verwenden. Datenbank und Uploadordner müssen außerhalb des Repositorys liegen.
Die mitgelieferte Unit gegebenenfalls an Node-/Projekt-/Datenbankpfade anpassen:

```sh
sudo install -m 644 deploy/finanzblick-worker.service /etc/systemd/system/finanzblick-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now finanzblick-worker
sudo systemctl status finanzblick-worker --no-pager
```

Nach einem Code-/Händlerupdate beide Dienste neu starten. Die Unit begrenzt den
Worker auf einen CPU-Kern, 384 MiB JS-Heap und 768 MiB Gesamt-RAM, mit niedrigerer
Priorität. OCR nutzt einen lokalen Tesseract-Worker und Sharp mit einem Thread,
ohne Bildcache. Sprachdaten werden kurzzeitig in einem privaten Temp-Verzeichnis
zusammengeführt und danach gelöscht. PDFs werden seitenweise gelesen (maximal
100 Seiten / 2 Millionen Textzeichen); Bilder sind auf 12 Megapixel begrenzt.
Keine CDN-, Cloud-KI- oder Händler-API-Aufrufe erfolgen im Worker.

## Dauerhafte Queue und Fortschritt

Das bestehende Backend verwendet **Node-SQLite**, kein ORM. Die Lösung bleibt
bei diesem typsicheren Repository-Muster, statt Redis oder eine zweite Datenbank
einzuführen. TypeScript-Migrationen in `src/lib/automation/migration.ts` legen
Händler, Jobs, Backfill-IDs und die Worker-Lease idempotent an. SQLite läuft im
WAL-Modus mit Foreign Keys und atomaren `BEGIN IMMEDIATE`-Transaktionen.

Ein globaler, erneuerbarer Datenbank-Lease verhindert einen zweiten aktiven
Worker; die Verarbeitung ist strikt **Concurrency 1**. Bei einem Absturz wird
der abgelaufene Job wieder aufgenommen. Maximal fünf fehlgeschlagene Versuche,
mit exponentiellem Backoff (1, 2, 4, 8 Sekunden bis zum letzten Versuch), verhindern
Endlosschleifen. Jobabschluss und Finanzdaten werden gemeinsam committed:
vorherige vollständige Daten bleiben bei einem Abbruch erhalten. Uploads bleiben
bis zum Abschluss/letzten Fehler erhalten und werden danach entfernt.
Es gelten höchstens fünf aktive Jobs pro Konto und 128 MiB reservierte
Uploadkapazität insgesamt. Abgebrochene Uploads laufen nach 15 Minuten aus;
Statusdaten von Auszugsjobs werden sieben Tage aufbewahrt.

Das Frontend hält eine authentifizierte **SSE-Verbindung** zu
`/api/statements/events?account=<eigene-Konto-ID>` offen. Status, Prozentwert,
Retries und Abschluss bleiben nach Neuladen sichtbar. Es gibt kein zyklisches
HTTP-Polling. Der HTTP-Prozess beobachtet intern einmal pro Sekunde ausschließlich
kleine Job-/Revisionsdatensätze in SQLite; Heartbeats halten die Verbindung offen.
Ein Finanzstand wird erst bei einer neuen Revision geladen. Offene lokale
Änderungen werden dabei nicht verworfen; bestehende Revisionskonflikte bleiben
sichtbar. SSE-Verbindungen sind pro Konto begrenzt und nach Abmeldung widerrufen.
Ein eventuell vorgeschalteter Proxy darf SSE nicht puffern.

## Händlerindex und manuelle Entscheidungen

`merchants.ts` definiert validierte Händler mit ID, kanonischem Namen, Aliasliste,
Regexliste, Standardkategorie, Region, Quelle und Aktualisierungszeit. Kategorien
stammen direkt aus der bestehenden Kategorienliste. Lokale Seeds werden anhand
ihrer ID und Version per Upsert importiert. `AutomationStore.upsertMerchants`
kann weitere validierte lokale Datensätze importieren; anschließend Worker neu
starten. Finanzdaten fließen niemals in die globale Händlerliste ein.

**Einmal beim Workerstart** werden alle Händler in den Index geladen:
normalisierte Alias-Map mit O(1)-Lookup, begrenzte Wortfenster für Filial-/Ortstexte,
vorkompilierte sichere Regexmuster und ein Längen-/Bigrammindex für den Fallback.
IBANs, Referenzen, Datum/Uhrzeit und Filialnummern werden vor dem Matching entfernt.
PayPal/Klarna/SumUp usw. gelten nicht selbst als Händler; der übrige Händlertext
muss eindeutig sein. Kollisionen und Überläufe bleiben offen. Fuzzy-Vergleiche
sind auf 128 Kandidaten, eine Editierung und mindestens 85 % Ähnlichkeit begrenzt;
**der Worker verlangt für Fuzzy-Treffer dennoch manuelle Prüfung**.
Normalisierung ist proportional zur Textlänge, Regex/Fuzzy sind begrenzt:
die gesamte Pipeline ist nicht pauschal O(1), aber sie benötigt **keine
Datenbankabfrage pro Umsatz**.

`is_locked` schützt manuelle Händler-/Kategorieentscheidungen. Bestehende
`manualCategory`-/bestätigte Kategorieflags und alte manuelle Aliase werden beim
Speichern ebenfalls gesperrt und vom Worker respektiert. Automatische Aliase
besitzen eine `merchantId`; sie werden nicht mit manuellen Änderungen verwechselt.
`requires_manual_review` führt unsichere Zuordnungen in die vorhandene Prüfliste.
Die neuen Flags/IDs bleiben auch in Excel-Sicherungen erhalten.
Kontospezifische gelernte Regeln, Dublettenabgleich, Amex-Abgleich, Salden und
Fixkosten-Rückfragen verwenden weiterhin die bestehende Importlogik.

## Einmaliger Backfill

Für lokale Konten:

```sh
npm run backfill
```

Auf dem vServer als root, ohne private Passwörter in Befehlen oder Git:

```sh
systemd-run --wait --pipe --uid=finanzblick \
  --property=EnvironmentFile=/etc/finanzblick.env \
  --setenv=NODE_ENV=production \
  --working-directory=/home/finanzblick/finanzblick \
  /usr/bin/node --import tsx scripts/statement-backfill.ts
```

Das Skript legt **einen Job je bestehendem Finanzkonto** an; erneutes Ausführen
verwendet dieselben Jobs und erzeugt keine doppelten Umsätze. Der Worker besucht
höchstens 200 historische Umsatz-IDs pro Durchgang, einschließlich Buchungen,
die ausschließlich als Fixkostenbelege gespeichert sind. IDs werden bei Jobanlage
dauerhaft eingefroren; gelöschte oder neu sortierte Zeilen verschieben nicht den
Cursor. Jeder Batch committed Daten und Cursor zusammen; nach Neustart läuft
der nächste Batch weiter. Neue Umsätze werden über ihre normalen Auszugsjobs
verarbeitet. Gesperrte Entscheidungen bleiben unverändert.

Für eine ausdrücklich gewünschte erneute Prüfung **aller aktuell vorhandenen**
Buchungen, einschließlich später hinzugekommener Umsätze:

```sh
npm run backfill -- --rerun
```

`--rerun` setzt nur abgeschlossene oder endgültig fehlgeschlagene Backfill-Jobs
atomar zurück und erstellt deren ID-Liste neu. Laufende oder wartende Jobs behalten
ihren bisherigen Cursor und werden nicht unterbrochen. Ohne diesen Schalter bleibt
der einmalige Backfill idempotent. Manuelle Händler-/Kategorieentscheidungen sind
auch bei einer Wiederholung geschützt; es entstehen keine zusätzlichen Buchungen.
Beim vServer-Aufruf den Schalter ebenfalls hinter `scripts/statement-backfill.ts`
anhängen.

Die bestehende App speichert Finanzstände als JSON-Snapshot, nicht als einzelne
Umsatzzeilen. Deshalb wird für jeden Batch **nur ein Konto**, aber dessen
vollständiger, auf 20 MiB begrenzter Snapshot gelesen/geschrieben. Der
200er-Batch begrenzt die Händlerarbeit, nicht die Snapshot-Grundgröße. Es werden
nie alle Konten gleichzeitig in den Arbeitsspeicher geladen.

Bei endgültig fehlgeschlagenen Auszugsjobs den Fehler im Status beachten und die
Datei nach Korrektur erneut hochladen. Betriebsfehler im Dienstjournal enthalten
Job-ID und Fehlerklasse, keine Buchungstexte. Zur Dateisicherung **beide Dienste**
anhalten und den ganzen privaten Datenbankordner einschließlich WAL und
`statement-uploads` kopieren. Jobs und Backfill-Fortschritt gehören zur Sicherung.
