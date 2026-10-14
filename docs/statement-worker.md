# Lokale Hintergrundverarbeitung

Im Kontomodus werden CSV/XLSX, Amex-Text-PDFs und Amex-Screenshots unverändert
auf den eigenen Server hochgeladen. Der HTTP-Handler streamt höchstens 20 MiB
in eine private Datei, persistiert den Job und antwortet mit **202 Accepted**.
Er führt weder Parsing noch OCR aus. Im reinen Browsermodus bleibt der bisherige
lokale Import erhalten. Lohnabrechnungsimporte sind unverändert.

Buchungsnamen und Verwendungszwecke werden ohne IBAN-/BIC-Felder,
Mandatsreferenzen und andere technische Bankfelder angezeigt. Das gilt auch
für ältere und manuell zugeordnete Buchungen. Unveränderte Originaltexte bleiben
in den privaten Quelldaten erhalten, damit Dublettenerkennung und
empfängerspezifische Zuordnungen weiterhin dieselbe Bankidentität verwenden.

## Betrieb

Node.js 22.13+ und `npm ci` genügen. `tsx` und `sharp` sind Produktionsabhängigkeiten.
HTTP-Server und Worker laufen als **getrennte Prozesse**, unabhängig voneinander.
Der Worker startet pro Auszug genau einen kurzlebigen, isolierten Node-Parser:

```sh
npm run dev
# In einem zweiten Terminal, mit derselben privaten .env.local:
npm run worker
```

Läuft kein Worker, zeigt der Uploadstatus bei wartenden Auszügen den Hinweis
„Der Hintergrund-Worker läuft nicht“. Ohne Worker bleiben Uploads bei 0 % in der
Warteschlange.

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

Das gesamte Auszugsjob-Budget beträgt 120 Sekunden, einschließlich Parserstart,
Dateilesen, PDF/OCR und Vorbereitung des Commits. Timeout, SIGTERM/SIGINT und
Lease-Verlust beenden einen aktiven Parserprozess samt dessen Worker-Threads
hart; erst nach seinem tatsächlichen Ende wird der nächste Job zugelassen.
Ein unabhängiger Watchdog begrenzt auch Parser, deren Elternprozess abstürzt.
Temporäre Sprachdaten liegen im privaten Uploadordner und werden nach Parserende
entfernt. Ein regulärer Shutdown lässt den Job mit sichtbarem Abbruchcode,
unveränderten Finanzdaten und unverbrauchtem Retry-Budget für den Neustart stehen.
Der atomare Datenbankcommit wird nicht mittendrin unterbrochen.
Revisionskonflikte durch zwischenzeitliche Finanzänderungen sind vorübergehend:
Der Worker versucht denselben Upload mit dem neueren Stand erneut, ohne die
Änderung zu überschreiben. Eine im Leerlauf abgelaufene eigene Lease darf neu
erworben werden; aktive Parser werden bei Lease-Verlust weiterhin beendet.

Der Parser verwendet das installierte Node/`tsx` und höchstens 384 MiB JS-Heap;
Concurrency 1 sowie die bestehende gemeinsame 768-MiB-Servicegrenze bleiben
unverändert. Das Worker-Deployment benötigt den Projektcheckout inklusive
`scripts`, `src`, `tsconfig.json` und Produktionsabhängigkeiten. `next build`
kompiliert/traced Web-Routen, **nicht** diesen separaten Worker-Einstiegspunkt:
Ein allein kopiertes `.next`/Standalone-Verzeichnis genügt nicht. Beim Start wird
die Verfügbarkeit des Child-Einstiegspunkts und von `tsx` geprüft.

### Isolierte Webpack-Build- und Paketprüfung

Für eine lokale Buildprüfung nur eine separate Projektkopie mit `src`, `public`,
`scripts`, Manifesten und Build-/TypeScript-Konfiguration verwenden. Keine
`.env*`, privaten Originale, Datenbanken, Browserprofile, `.local-data` oder
bestehenden `.next`-Dateien übernehmen. Den Buildprozess ohne `FINANZBLICK_*`-
Konfiguration und ohne geerbte `NODE_OPTIONS` starten; Telemetrie und den
`tsx`-Cache deaktivieren. Vorhandene Abhängigkeiten dürfen für diese Prüfung
verlinkt werden; ein solches Link-Paket ist kein übertragbares Deployment.

Aus dieser bereinigten Kopie, nicht dem laufenden Projekt:

```powershell
$env:NEXT_TELEMETRY_DISABLED = "1"
$env:TSX_DISABLE_CACHE = "1"
node .\node_modules\next\dist\bin\next build --webpack
node --import tsx --input-type=module -e "import { join } from 'node:path'; import { pathToFileURL } from 'node:url'; const runtime = await import(pathToFileURL(join(process.cwd(), 'src', 'lib', 'automation', 'parser-runtime.ts')).href); await runtime.assertParserRuntimeAvailable();"
```

Der zweite Befehl prüft nur Einstiegspunkt und Loader: Er startet weder Worker
noch Child-Parser und öffnet keine Kontodatenbank. Ein erfolgreicher Web-Build
beweist allein noch keine Worker-Paketierung. Die `.nft.json`-Traces gehören den
Web-Routen; die Worker-Sourcen nicht als Webpack-Entry oder Route hinzufügen.
Für das tatsächliche Worker-Paket die Quelldateien samt `tsconfig.json` und
Produktionsabhängigkeiten behalten: insbesondere `tsx`, `sharp` mit passenden
nativen Zielplattform-Binaries, `pdfjs-dist` einschließlich Worker/CMaps/Fonts/WASM,
Tesseract-Core/-Node-Worker und die lokalen `deu`-/`eng`-Sprachdaten. Ein
Standalone-Webpaket allein ist kein Worker-Paket. Isolierte synthetische
Prozesstests prüfen darüber hinaus echtes Parsing, harte Beendigung und
Concurrency 1; sie sind nicht durch den bloßen Build/Preflight ersetzt.

## Dauerhafte Queue und Fortschritt

Das bestehende Backend verwendet **Node-SQLite**, kein ORM. Die Lösung bleibt
bei diesem typsicheren Repository-Muster, statt Redis oder eine zweite Datenbank
einzuführen. TypeScript-Migrationen in `src/lib/automation/migration.ts` legen
Händler, Jobs, Backfill-IDs und die Worker-Lease idempotent an. SQLite läuft im
WAL-Modus mit Foreign Keys und atomaren `BEGIN IMMEDIATE`-Transaktionen.

Ein globaler, erneuerbarer Datenbank-Lease verhindert einen zweiten aktiven
Worker; die Verarbeitung ist strikt **Concurrency 1**. Bei einem Absturz wird
der abgelaufene Job wieder aufgenommen. Vorübergehende Infrastrukturfehler erhalten
maximal fünf fehlgeschlagene Versuche,
mit exponentiellem Backoff (1, 2, 4, 8 Sekunden bis zum letzten Versuch), verhindern
Endlosschleifen. Beschädigte/verschlüsselte Dateien, nicht unterstützte Formate,
Ressourcenlimits und Timeouts scheitern dagegen nach einem Versuch mit einem
sicheren Fehlercode und einer konkreten Korrekturmaßnahme. Jobabschluss,
upload-ID-bezogenes Importergebnis und Finanzdaten werden gemeinsam committed:
vorherige vollständige Daten bleiben bei einem Abbruch erhalten. Uploads bleiben
bis zum Abschluss/letzten Fehler erhalten und werden danach entfernt.
Es gelten höchstens fünf aktive Jobs pro Konto und 128 MiB reservierte
Uploadkapazität insgesamt. Abgebrochene Uploads laufen nach 15 Minuten aus;
Statusdaten und upload-ID-bezogene Ergebnisse abgeschlossener/fehlgeschlagener
Auszugsjobs werden sieben Tage aufbewahrt. Die Bereinigung läuft höchstens
einmal pro Minute auch bei leerer Queue und ohne neue Dateilöschungen.
Aktive Jobs und dauerhafte Backfill-IDs/Prüfpässe bleiben erhalten; Jobmetadaten
werden erst nach erfolgreicher Löschung der zugehörigen Originaldatei entfernt.

Das Frontend hält eine authentifizierte **SSE-Verbindung** zu
`/api/statements/events?account=<eigene-Konto-ID>` offen. Status, Prozentwert,
Retries und Abschluss bleiben nach Neuladen sichtbar. Es gibt kein zyklisches
HTTP-Polling. Der HTTP-Prozess beobachtet intern einmal pro Sekunde ausschließlich
kleine Job-/Revisionsdatensätze in SQLite; Heartbeats halten die Verbindung offen.
Ein Finanzstand wird erst bei einer neuen Revision geladen. Offene lokale
Änderungen werden dabei nicht verworfen; bestehende Revisionskonflikte bleiben
sichtbar. SSE-Verbindungen sind pro Konto begrenzt und nach Abmeldung widerrufen.
Ein eventuell vorgeschalteter Proxy darf SSE nicht puffern.

SQLite-BUSY/LOCKED nach Ablauf des Schreibwartefensters ergibt HTTP **503** mit
`Retry-After: 5`, ohne interne Fehlermeldungen. Bei fehlgeschlagenen Übertragungen
wird die Reservierung vor dem Entfernen der Datei als fehlgeschlagen markiert.
Blockiert auch die Bereinigung, bleiben Datei und Reservierung für die bestehende
15-Minuten-Ablaufbereinigung erhalten. Bereits angenommene Queue-Dateien werden
nicht gelöscht. Sekundäre Bereinigungsfehler ersetzen nicht die ursprüngliche
Uploaddiagnose; ihre festen Logkategorien enthalten keine Ausnahmeinhalte oder
Dateipfade.

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

### Bankvorgänge und PayPal-Kurzformen

Eindeutige Kontoführung, Karten-/Buchungsentgelte und Überweisungsgebühren werden
lokal als `Bankgebühren` erkannt, Rücklastschriftgebühren separat. Dafür ist kein
geratener Händler nötig. Das gilt auch für explizite Amex-Mitgliedsgebühren,
PayPal/PP-Transaktionsgebühren und Geldautomatengebühren, nicht für eine bloße
Bargeldbehebung. Gemischte Hauptbeträge inklusive Gebühren, widersprüchliche
Händler und negierte Gebühren bleiben in der Prüfung. Die Erstattung einer Gebühr
ist `Rückerstattungen`, kein Einkommen. Neue Vertragsbeträge brauchen weiterhin die
bestehende Fixkostenprüfung; aus einer einzigen Gebühr wird keine Laufzeit geraten.

Nur ausdrücklich eigene Konten bzw. PayPal-Guthabenaufladungen sind interne
Umbuchungen. SEPA-/Echtzeitüberweisungen und Daueraufträge ohne bestätigten Zweck
bleiben offen, statt als Spartransfer aus den Ausgaben zu verschwinden. Explizite
Zweckangaben wie Vollkasko, Leasingrate oder Mietzahlung dürfen ihre bestehenden
Kategorien setzen; mehrere Zwecke bleiben offen. Ein bestätigter kontospezifischer
Zweck darf beim gleichen Text wiederverwendet werden.
Transfertexte erhalten weiterhin kein Händlerlogo; gesperrte Entscheidungen
bleiben unangetastet. Beschriftete Buchungsart-/Verwendungszweckfelder werden
berücksichtigt, nicht beliebige Kontoinhaber- oder Jahresübersichtszeilen.

`PP*HÄNDLER` und `PP / HÄNDLER` werden wie PayPal behandelt. Ein bloßes `PP`, eine
Referenz-ID oder zwei unterschiedliche Händler genügt weiterhin nicht für eine
automatische Zuordnung. Originaltexte und Beträge bleiben erhalten; es gibt keine
Netzwerkaufrufe oder Datenbankabfragen pro Buchung. Diese Regeln starten keinen
neuen historischen Nachlauf.

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

Für dieses Händlerindex-Upgrade gibt es einen **einmaligen Nachlauf je Konto**:

```sh
npm run backfill -- --merchant-upgrade
```

Die Version `merchant-reliability-v2` wird mit Job und ID-Snapshot atomar in
`automation_backfill_passes` gespeichert. Erneutes Ausführen übernimmt denselben
Cursor, auch nach Neustart oder nach Abschluss; es setzt den Job nicht zurück.
Ein noch laufender älterer Backfill muss zuerst fertig werden. Ein endgültiger
Fehler bleibt sichtbar statt beim erneuten Start ein neues Retry-Budget zu erhalten.
`--rerun` und `--merchant-upgrade` dürfen nicht kombiniert werden.
Ein bereits versionierter Job ist auch vor einem späteren Aufruf nur mit
`--rerun` geschützt; der Befehl meldet dann einen Konflikt statt neu anzufangen.

Für eine ausdrücklich gewünschte weitere einmalige Prüfung nach einem bereits
versionierten, abgeschlossenen Nachlauf:

```sh
npm run backfill -- --once-version merchant-recheck-20261009
```

Eine neue Kennung legt einen eigenen Backfill mit aktuellem ID-Snapshot an.
Alte Jobs, Fortschritte und eingefrorene IDs bleiben erhalten. Dieselbe Kennung
verwendet immer ihren ursprünglichen Job, auch nach Abschluss oder einem Fehler.
Pro Konto ist höchstens ein Backfill gleichzeitig aktiv; ein neuer Prüfpass
lässt sich erst nach Abschluss des alten anlegen. `--once-version` kann nicht mit `--rerun`
oder `--merchant-upgrade` kombiniert werden. Auch bereits zugeordnete Umsätze
und reine Fixkostenbelege werden besucht; manuelle/gesperrte Entscheidungen
bleiben geschützt.

Der Worker verwendet weiterhin eine einzige Verarbeitungsspur und einen Händlerindex
pro Start; isolierte Parser laufen nie gleichzeitig. Vor dem Vergleich entfernt er
POS-/Terminal-IDs, Uhrzeit, IBAN und Referenzen.
Eindeutige führende Kontaktlos-/EC-Kartenmodusangaben und ausdrücklich beschriftete
`MCC: 5411`-Metadaten stören den Händler-Lookup nicht mehr. Sie sind selbst keine
Kaufkategorie; ursprüngliche Buchungstexte und widersprüchliche Quellen bleiben
unverändert erhalten. Fuzzy- und Mehrfachtreffer werden weiterhin nicht geraten.
Exakte Aliase oder vertrauenswürdige lokale Regexregeln dürfen Namen und Kategorie
setzen. Bei eindeutigem Namen, aber fehlender Kategorie/Zwecknachweis kann nur der
Name gesetzt werden; die Kategorie bleibt in der Prüfung. Fuzzy, mehrere globale
Treffer oder widersprüchliche Kontoregeln verändern bestehende Zuordnungen nicht.
Eine schon sichere, andere Händler-ID wird nicht automatisch ausgetauscht.
Manuelle/ausdrücklich bestätigte Zuordnungen bleiben gesperrt. Sichere bestehende
Kontextkategorien (z. B. Mittagessen) werden nicht durch einen allgemeinen
Händlerstandard ersetzt. Erstattungen behalten den Händler, aber den positiven
Betrag und die Kategorie Rückerstattungen; Kontoüberweisungen/Interne Transfers
erhalten keine Händlerzuordnung und kein Händlerzeichen.

Bestätigte Namen/Kategorien werden bereits im kontospezifischen `merchantRules`
des Finanzsnapshots gelernt. Der Worker baut daraus einmal pro Verarbeitung einen
Aliasindex; ein Konto kann damit niemals die globale Händlertabelle oder ein anderes
Konto verändern. Die 32-px-Zeichen verwenden ausschließlich diese kanonischen Namen
oder privat gespeicherte, lizenzierte Logos. Unbekannte Namen erhalten ein neutrales
Fragezeichen, keine vermuteten Markeninitialen. Siehe [Händlerdaten](merchant-data.md)
für offenen Datenimport, Herkunft und Logo-Lizenzen.

Die Umsatzliste fragt aktuelle, privat gespeicherte Logos gesammelt für sichtbare
Händler-IDs ab. Damit erhalten auch alte Umsätze ein inzwischen verfügbares Logo,
ohne ihre Kategorie, manuelle Sperre oder den einmaligen Nachlauf zu verändern.
Nach dem normalen Home-Deployment lassen sich Logos unabhängig von einem
Geografieimport mit `npm run merchants:import -- --logos-only --limit 20` laden.
Der Worker selbst lädt weiterhin keine Bilder oder externen Finanzdaten;
Details und gezielte Aktualisierung stehen in [Händlerdaten](merchant-data.md).

Automatische Index-Treffer sind keine Nutzerbestätigung und lernen deshalb keine
neuen Kontoregeln. Alte Regeln, die ausschließlich durch passende automatische
Worker-Zuordnungen belegt sind, bleiben gespeichert, werden aber nicht als manuelle
Bestätigung verwendet. Widersprüchliche Händlerfelder im Originalauszug bleiben
ebenfalls offen; ein einzelner Treffer im verkürzten Buchungstext reicht nicht.

### Erkennungsqualität

Die lokale Referenz umfasst weitere eindeutig benannte Händler, nicht generische
Wörter wie „Shop“ oder „Restaurant“. Apple-Buchungen ohne eindeutigen Zweck
bleiben offen. Amazon/Marktplätze und Tankstellenshops sind mehrdeutig: Ein sicherer
Name allein rechtfertigt keine Produktkategorie. `requiresCategoryEvidence` in
der Händlertabelle verlangt eine bestätigte Kontoregel oder konkreten Zwecknachweis.
Bei Tankstellen akzeptiert der Worker ein ausdrücklich beschriftetes,
widerspruchsfreies `MCC: 5542`-Feld (Zahlung direkt an der Zapfsäule), nicht 5541
oder eine Referenznummer. Erstattungen bleiben Rückerstattungen.
Händlerfelder des Auszugs werden zusätzlich zum Buchungstext
ausgewertet; widersprüchliche Namen und Kategorien werden nicht geraten.
Bestätigte kontospezifische Namen können wechselnde POS-/Referenzmetadaten
überstehen. Dabei bleiben normalisierte Regelkollisionen und abweichende
Sonderzwecke wie Urlaub, Geschenke oder Mittagessen in der Prüfung.

Namensbestätigungen werden separat als `merchantNameConfirmed` festgehalten.
Eine reine Namensregel (`identityOnly`) lernt nur den kontospezifischen Alias:
Eine mitgebrachte automatische Kategorie wird dadurch **nicht** bestätigt.
Der nächste Import erhält den Namen; seine Kategorie braucht weiterhin eine
sichere Referenz oder eine eigene Nutzerbestätigung. Die Prüfliste zeigt dafür
„Händlername bestätigt – Kategorie bitte noch bestätigen“. Automatisch
zugeordnete Zwillinge erhalten keine menschliche Bestätigungsmarkierung.
Diese Angaben bleiben beim JSON-/Excel-Export erhalten.

Der Händlerindex fasst belegte öffentliche Identitäten beim Start zusammen.
Mehrdeutige Alias-Postings werden kompakt als Konflikt gespeichert statt für
jede Zeile erneut durchlaufen zu werden. Bestehende, belegbar gleichwertige
Händler-IDs einschließlich ihrer privaten Logo-Zuordnung bleiben erhalten.
Zusätzliche konkrete Referenzen ergänzen die lokale Liste; Adobe/Microsoft
ohne eindeutigen Zweck bleiben ebenso offen wie Mehrzweck-Tankstellenshops.

```sh
npm run benchmark:recognition -- --readonly --verify-unchanged
```

Der Benchmark (Protokoll v2) zeigt sichere Namen getrennt von vollständigen
automatischen Name-/Kategorie-Zuordnungen und trennt Abdeckung von bestätigter
Genauigkeit. Unbestätigte automatische Ergebnisse sind keine Trainingslabels.
Ein 99%-Anspruch benötigt repräsentative, unabhängig bestätigte Händler- und
Kategoriedaten; kleine Stichproben oder synthetische Varianten belegen ihn nicht.
`--require-target` meldet ein nicht belegtes Ziel mit Exit-Code 2.
Siehe [Messprotokoll](statement-recognition.md).

### Deployment zu Hause

Nur im vorhandenen WebStorm-SSH-Terminal auf dem Server:

```sh
git pull --ff-only
npm install
npm run build
sudo systemctl restart finanzblick finanzblick-worker
```

Nach einem optionalen, begrenzten Händlerdatenimport den Worker erneut starten,
damit er den neuen Index lädt. Den einmaligen Nachlauf unter derselben Server-
Umgebung starten wie oben gezeigt, mit `--merchant-upgrade` hinter
`scripts/statement-backfill.ts`. Status und Abschluss im SSE-Frontend bzw.
`journalctl -u finanzblick-worker` kontrollieren. Wenn SSH am Arbeitsort blockiert
ist oder das WebStorm-Terminal nicht verfügbar ist, bleibt Deployment ausstehend;
lokale Prüfung oder ein Git-Push sind kein Server-Deploy.

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
