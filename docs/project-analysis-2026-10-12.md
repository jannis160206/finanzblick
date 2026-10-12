# Finanzblick: Projektanalyse und Umsetzungsfahrplan

- **Stand:** 12. Oktober 2026
- **Perspektiven:** Full-Stack Engineering, UI/UX und technische Projektleitung
- **Analysebasis:** Commit `c86ccaf` sowie die zum Analysezeitpunkt vorhandenen, uncommitteten Änderungen

> **Kurzurteil:** Finanzblick ist eine weit entwickelte persönliche Finanzanwendung mit guten technischen Schutzmechanismen. In kombinierten Sonderfällen bestehen jedoch nachgewiesene Finanzfehler. Zuerst fachliche Korrektheit und Wiederherstellbarkeit stärken, danach Importe und Betrieb absichern. Ein vollständiger Neubau oder pauschale Framework-Upgrades sind nicht sinnvoll.

Die Analyse war ausschließlich lesend. Die Empfehlungen sind **keine bereits umgesetzten Änderungen**. Insbesondere Befunde zur Lohnabrechnungsoberfläche beziehen sich teilweise auf den unveröffentlichten Arbeitsstand und dürfen nicht ungeprüft dem veröffentlichten Release zugeschrieben werden.

## Inhaltsverzeichnis

1. [Gesamtbild](#1-gesamtbild)
2. [Priorisierte Befunde](#2-priorisierte-befunde)
3. [Sinnvolle Erweiterungen](#3-sinnvolle-erweiterungen)
4. [Zielbild](#4-zielbild)
5. [Umsetzungsfahrplan](#5-umsetzungsfahrplan)
6. [Erste konkrete Empfehlung](#6-erste-konkrete-empfehlung)
7. [Analyseabdeckung und Validierung](#7-analyseabdeckung-und-validierung)

## 1. Gesamtbild

### Reifegrad und wichtigste Risiken

Finanzblick verfügt über deutlich mehr als eine einfache Dashboard-Oberfläche: Importverarbeitung, manuelle Entscheidungsautorität, Kontentrennung, lokale Speicherung, geräteübergreifende Synchronisierung und Hintergrundverarbeitung sind tatsächlich implementiert.

**Die größte Schwäche liegt derzeit nicht im Technologiestand, sondern in der Konsistenz kombinierter Finanzabläufe.** Geplante Ausgaben, Amex-Verbindlichkeiten, geteilte Rückerstattungen und Sparziele sind einzeln weit ausgearbeitet, führen zusammen aber teilweise zu Doppelzählungen oder widersprüchlichen Ergebnissen.

Daneben fehlen geschlossene Wiederherstellungsabläufe, eindeutige Ergebnisse je Import und nachgewiesene Betriebsabläufe für Restore und Release-Rollback.

| Verifizierte Abhängigkeit | Installierte Version |
| --- | --- |
| Next.js | 16.3.8 |
| React / React DOM | 19.2.8 |
| TypeScript | 5.9.3 |
| Tailwind CSS | 4.3.3 |
| Vitest | 4.1.11 |

Die genannten Grundlagen stimmen mit dem tatsächlichen Projektstand überein. Eine installierte Bibliothek ist dennoch kein Nachweis für eine vollständig implementierte Funktion.

### Was erhalten bleiben sollte

- **Finanzielle Grundlagen:** zentrale, weitgehend reine Berechnungslogik; Auszugssalden mit nachfolgenden Bewegungen; Transferabgleich; centbasierte Aufteilung und deterministische Zuordnung an wichtigen Stellen.
- **Datenschutz und Synchronisierung:** serverseitige Kontentrennung, transaktionale Revisionsprüfung, Schutz vor veralteten Geräte-/Tabständen und Erhaltung unlesbarer Originaldaten. Ein allgemeines Überschreiben durch die Synchronisierung wurde **nicht** nachgewiesen.
- **Manuelle Autorität:** bewusste Nutzerentscheidungen haben Vorrang; Händlererkennung bleibt bei widersprüchlichen Daten konservativ; Namens- und Kategorieregeln sind getrennt.
- **Importarchitektur:** separater Worker, persistente Warteschlange, Lease und atomarer Finanzdaten-/Checkpoint-Commit.
- **Oberfläche:** mobile Umsatzdarstellung, gemeinsame Dialogstruktur, Design-Tokens, reduzierte Bewegung und selektiver Sichtschutz. Die kompakte Uploadanzeige mit zwei letzten Ergebnissen bleibt sinnvoll.
- **Performance-Grundlage:** verzögerte Dashboardberechnung und Wiederverwendung von Buchungsklassifikationen sind bereits vorhanden.

### Was derzeit nicht sinnvoll ist

Ein Frameworkwechsel, pauschale Dependency-Upgrades, eine neue Queueplattform oder die vollständige Verlagerung der Anwendung in Server Components würden die nachgewiesenen Probleme nicht lösen. Der lokale Browsermodus ist ein legitimer Architekturgrund.

Persönliche Regeln wie die sieben Budgets, der festgelegte Sparsockel, die Urlaubssparpause und benannte Transferregeln sind nicht automatisch Fehler. Sie sollten nicht unter dem Vorwand einer technischen Modernisierung verändert werden.

## 2. Priorisierte Befunde

### Leseschlüssel

| Kennzeichnung | Bedeutung |
| --- | --- |
| **P1** | Vor neuen Funktionen bearbeiten |
| **P2** | Anschließend gezielt verbessern |
| **N** | Nachgewiesenes Verhalten oder Problem |
| **V** | Begründete Verbesserung |
| **H** | Auswirkung noch hypothetisch oder ungemessen |
| **S / M / L** | Relativer kleiner / mittlerer / großer Umfang; keine feste Terminzusage |

Dateipfade und Zeilen beziehen sich auf den untersuchten Arbeitsstand. Die Reproduktionen verwendeten synthetische Daten, nicht private Finanzdateien.

| Priorität | Bereich | Konkreter Befund | Beleg / Dateipfad | Auswirkung | Empfehlung | Aufwand | Sicherheit der Aussage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Finanzlogik | **N:** Eine gebuchte geplante Amex-Ausgabe kann doppelt reserviert werden: als geplante Ausgabe und als offene Kartenverbindlichkeit. | `src\lib\calc\index.ts:791–807`; `src\lib\amex-balance.ts:175–180`; `src\lib\planned-one-offs.test.ts:92` | Bei einer geteilten 400-€-Ausgabe wird der eigene Anteil von 200 € zweimal abgezogen. Verfügbarer Betrag und Sparvorschläge sind zu niedrig. | Ausgabenreservierung und spätere Zahlungsliquidität getrennt abgleichen; denselben Eigenanteil nur einmal belasten. | M | Hoch; bestehender Test schlägt fehl, synthetisch reproduziert. |
| P1 | Geteilte Ausgaben | **N:** Händlererstattungen werden vollständig persönlich gutgeschrieben, während die Forderung aus dem geteilten Kauf bestehen bleibt. | `src\lib\shared-holiday.ts:43–49,77–79`; `src\lib\calc\index.ts:945–947` | Geteilter Kauf −100 € und volle Rückerstattung +100 € ergeben −50 € Ausgaben und weiterhin 50 € offene Partnerforderung. | Rückerstattung mit Ursprungskauf verknüpfen und Eigenanteil/Forderung proportional zurücknehmen. Partnerzahlungen getrennt behandeln. | M | Hoch; synthetisch reproduziert. |
| P1 | Pockets / Ziele | **N:** Ziele und physische Guthaben sind nicht konsistent getrennt. Manche Kernpocket-Startstände fehlen beim Ziel; andere Guthaben werden zusätzlich als Zielvermögen gezählt. | `src\lib\goals.ts:70–78`; `src\lib\calc\index.ts:917,960–961` | Ein finanziertes Ziel kann unfinanziert erscheinen; ein 1.000-€-Pocket kann als 2.000 € Vermögen erscheinen. Mehrere Ziele auf demselben Pocket verstärken das Problem. | Guthaben einmal je physischem Pocket zählen; Ziele als Zweckbindung modellieren. Überschneidungen ausdrücklich begrenzen oder aufteilen. | M | Hoch; mehrere zulässige Konfigurationen reproduziert. |
| P1 | XLSX / Datenmodell | **N:** Doppelte Finanzzeilen-IDs sind schema-gültig, werden beim XLSX-Roundtrip aber zusammengeführt. Unvollständige Workbooks übernehmen zudem nicht belegte Seed-Startguthaben. | `src\lib\types.ts:376,402`; `src\lib\excel.ts:144–162,203–209,335–341,386–402` | Zwei Einkommenszeilen über 1.000 € und 2.000 € können nach Wiederherstellung nur noch 2.000 € ergeben. Fehlende Salden werden scheinbar bekannte Werte. | Gemeinsame ID-Eindeutigkeit erzwingen; bestehende Dubletten nicht still reparieren. Buchungsimport von vollständiger Wiederherstellung unterscheiden; keine impliziten Startguthaben. | M | Hoch; beide Fälle mit In-Memory-Workbooks reproduziert. |
| P1 | Wiederherstellung | **N:** Konfliktsicherung ist kein geschlossener Nutzerablauf: Download als JSON, Wiederherstellung nur als XLSX. Die zusätzliche lokale Konfliktkopie hat keine Wiederherstellungsoberfläche und wird beim Logout entfernt. | `src\components\account-tools.tsx:35–36,80–87`; `src\components\excel-actions.tsx:59–64`; `src\lib\account-finance-storage.ts:228` | Daten sind technisch teilweise bewahrt, für Nutzer aber nicht zuverlässig zurückholbar. Das ist nicht gleichbedeutend mit allgemeinem Sync-Datenverlust. | Validierten JSON-Import, Vorschau und kontobezogene Konfliktwiederherstellung anbieten; vor Entfernung exportierbar machen. Logout-Datenschutz erhalten. | M | Hoch; Format- und Ablaufbruch nachgewiesen. |
| P1 | Lohn / Steuern | **N:** Nicht modellierte Kontexte wie BUAG, Lehrling oder bereits beendetes Dienstverhältnis können trotzdem eine spätere Nettoprognose freischalten. | `src\lib\import\payslip.ts:130–140,363–375`; `src\lib\payroll-analysis.ts:152–166` | Präzise wirkende Prognosen außerhalb des unterstützten Modells. 30 Lohnsteuertage belegen nicht automatisch die steuerliche Anwendbarkeit oder fortgesetzte Beschäftigung. | Nicht unterstützte Kontexte ausdrücklich sperren und verständlich erklären; Erweiterungen erst mit unabhängig geprüften Rechtsfällen. | M | Hoch für Verhalten; keine vollständige steuerrechtliche Bewertung. |
| P1 | Parallele Änderungen | **N:** Lohnabrechnungs-Löschen/Ersetzen prüft bei Bestätigung nicht erneut den zuvor angezeigten Datensatz. | `src\components\payslip-import.tsx:94–109,515,562–567` | Eine zwischenzeitlich aktualisierte Abrechnung kann gelöscht oder überschrieben werden. Server-CAS verhindert diesen UI-semantischen Fehler nicht. | Erwartete Datensatzversion im Update-Callback vergleichen; bei Änderung neue Vorschau verlangen. | S | Hoch; betrifft den aktuellen uncommittierten Arbeitsstand. |
| P1 | Importqualität | **N:** „Abgeschlossen“ kann null übernommene Buchungen bedeuten. Reparierbare CSV/XLSX/PDF-Entwürfe werden überwiegend verworfen; Ergebnisse/Warnungen sind nicht sauber je Upload zugeordnet. | `src\lib\automation\parse.ts:208–225`; `src\lib\automation\worker.ts:97–123`; `src\lib\import\review.ts:519–524,891–905` | Erfolgsanzeige ohne klaren fachlichen Erfolg; nach Entfernung des Originals bleibt teilweise nur ein Hinweis. Gleiche Dateinamen können ältere Hinweise verdrängen. | Ergebniszahlen und strukturierte Probleme je Upload-ID speichern; „mit Hinweisen“ / „nicht unterstützt“ unterscheiden und Korrektur oder erneuten Upload anbieten. | M | Hoch; durchgängiger Codepfad geprüft. |
| P1 | Worker | **N:** Kein durchgängiges Zeit-/Abbruchbudget für PDF/OCR; Shutdown wird hauptsächlich zwischen Jobs geprüft. Permanente Dateifehler durchlaufen dieselben bis zu fünf Versuche. | `src\lib\automation\worker.ts:127–161`; `src\lib\automation\parse.ts:112–119,161–171`; `src\lib\automation\store.ts:567–587` | **H:** Ein hängender Parser könnte den einzigen Worker blockieren. Nachgewiesen sind fehlende Begrenzung und unnötige Wiederholung deterministischer Fehler, nicht ein aktueller Produktionshänger. | Jobweite Deadline, Abbruchweitergabe und Ressourcenfreigabe; sichere Fehlercodes mit transient/permanent und passenden Nutzermaßnahmen. | M | Hoch für Struktur; Hängerwirkung nicht praktisch gemessen. |
| P2 | Speicherung | **N:** Auch das erstmalige Lesen gültiger Serverdaten verlangt einen erfolgreichen vollständigen localStorage-Cachewrite. | `src\lib\account-finance-storage.ts:107–149`; `src\components\finance-provider.tsx:288–296` | Bei Browserquota kann das Konto trotz verfügbarer Serverdaten nicht normal geöffnet werden. 20 MiB Serverlimit garantiert keine Browserkapazität. | Nach Cachefehler klar gekennzeichneten schreibgeschützten Serverzugriff erlauben; ungesicherte Änderungen niemals als gespeichert bestätigen. | M | Hoch; mit synthetischem Quotafehler reproduziert. |
| P2 | Verständlichkeit | **N:** „Einnahmen · Plan“ zeigt Gehalt, nicht Gesamteinnahmen. Die „90 Tage“-Restrechnung lässt Einmalausgaben weg und versteckt Amex-Verbindlichkeit im Alltagsbudget. | `src\components\overview.tsx:85–88,322–330`; `src\lib\calc\index.ts:769–807,932–937` | Unterschiedliche Zahlen wirken widersprüchlich; der Rest lässt sich aus sichtbaren Positionen nicht nachrechnen. | Gehalt korrekt benennen; Einmalausgaben und Amex separat aufschlüsseln; „nächste drei Monate“ statt exakt „90 Tage“. | S | Hoch; Darstellung und Berechnung verglichen. |
| P2 | Zugänglichkeit | **N:** Inline-Betragsfehler haben keine sichtbare verknüpfte Erklärung; CSS kann den Fehlerrand überstimmen. Dialogbeschreibungen werden generell abgeschnitten. Trendcharts haben keine gleichwertige Wertetabelle. | `src\components\finance-ui.tsx:131–159`; `src\app\globals.css:328–340`; `src\components\ui\dialog.tsx:195`; `src\components\overview.tsx:342–385,475–510` | Schlechtere mobile Fehlerkorrektur und weniger verständliche Konsequenzen bzw. Diagrammdaten. | Sichtbare Fehler mit `aria-describedby`, umbrechende Handlungshinweise und zugängliche Chartdaten ergänzen. | M | Hoch für Code; keine vollständige WCAG- oder Geometrieprüfung. |
| P2 | Datenschutz | **N:** Sieben-Tage-Löschung alter Importmetadaten hängt von einer späteren Dateibereinigung ab. | `src\lib\automation\store.ts:604–624`; `src\lib\automation\worker.ts:116–123` | Bei anschließend leerer Warteschlange können Dateinamen/Fehlerhinweise länger verbleiben als vorgesehen. | Metadatenablauf unabhängig periodisch ausführen; leere Queue nach Ablauf testen. | S | Hoch; konkreter Aufrufpfad. |
| P2 | Betrieb | **V:** Dokumentiert sind manuelle Backups auf demselben Host und Deployment im laufenden Release; Wiederherstellungsproben und belastbarer Release-Rollback sind nicht belegt. | `README.md:84–91,109–119`; `deploy\finanzblick-worker.service` | Hostverlust und fehlgeschlagenes Deployment sind nicht ausreichend durch nachgewiesene Abläufe abgesichert. Kein tatsächlicher Backupausfall wurde festgestellt. | Verschlüsselte Off-Host-Sicherung mit Fehleralarm/Restoreprobe; getrennte Releaseartefakte, Readiness und kompatiblen Rollback etablieren. | M | Hoch für Repository-Dokumentation; externer Betrieb unbekannt. |

### Modellgrenzen statt pauschaler Fehler

Planung und Lohnmodell sind ausdrücklich auf **2026/27** begrenzt. Das ist heute eine Modellgrenze, nicht automatisch ein Fehler. Vor späteren Jahren braucht es einen kontrollierten Übergang.

Dasselbe gilt für persönliche Budgets, benannte Transferregeln und die fest vorgegebenen Amex-Karteninhaber. Eine Verallgemeinerung benötigt kontobezogene Einstellungen, ist für den persönlichen Einsatz aber nicht automatisch vorrangig.

Der Lohnbereich identifiziert Arbeitgeber, nicht wirklich getrennte Dienstverhältnisse. Zwei Beschäftigungen beim gleichen Arbeitgeber/Monat kollidieren. Bis zur fachlich geprüften Erweiterung wäre eine explizite Einschränkung besser als scheinbare Unterstützung.

### Steuerliche Einordnung und offizielle Quellen

Die Analyse prüfte offizielle Stichproben zu:

- [§ 67 EStG: sonstige Bezüge und Jahressechstel, Fassung 12.10.2026](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=67&FassungVom=2026-10-12)
- [§ 66 EStG: Lohnsteuerberechnung und Cent-Rundung, Fassung 12.10.2026](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=66&FassungVom=2026-10-12)
- [BGBl. II 260/2026: Inflationsanpassungsverordnung 2027](https://www.ris.bka.gv.at/Dokumente/BgblAuth/BGBLA_2026_II_260/BGBLA_2026_II_260.html)

Veröffentlichte Tarif-/Grenzbeträge passen in den untersuchten Fällen. Das bestätigt weder sämtliche Dienstverhältnisse noch vollständige SV-Anwendbarkeit. **2027-SV bleibt bewusst nicht als verifiziert auszugeben.**

Eine reproduzierte Centabweichung im Tarifdifferenzverfahren benötigt vor Änderung eine fachliche Referenzprüfung. Passing Tests sind keine steuerrechtliche Zertifizierung.

## 3. Sinnvolle Erweiterungen

Die folgenden Ideen verwenden vorhandene Grundlagen und sollen konkrete Entscheidungen verbessern. Sie sind keine allgemeine Feature-Wunschliste.

| Idee | Problem und Nutzerwert | Kleinster sinnvoller Umfang | Aufwand / Risiken / Gründe dagegen |
| --- | --- | --- | --- |
| **Datenbasis-Übersicht** | Erkennbar machen, welchen Zahlen man vertrauen kann. Prüffälle und Saldeninformationen existieren bereits, sind aber verteilt. | Je Konto letzter belegter Stand, unbestätigte Startbasis, offene Prüffälle und Importwarnungen; direkte passende Aktion. | M; lokal ohne externe Kosten möglich. Vorher „unbekannt“ und echte Null konsistent behandeln. Kein weiteres dekoratives Dashboard. |
| **Importdetails mit Herkunft** | Nachvollziehen, was eine Datei tatsächlich verändert hat. | Je Upload übernommene/Duplikat-/Prüfzahlen und verknüpfte Probleme; getrennte Detailhistorie, nicht mehr Karten auf der Umsatzseite. | M; Metadaten datensparsam aufbewahren. Rückgängigmachen erst später: Korrekturen, Salden und nachfolgende manuelle Änderungen machen pauschales Löschen gefährlich. |
| **Kontextbezogene Budgetnavigation** | Von „über Budget“ unmittelbar zu den verursachenden Buchungen gelangen. | „Buchungen ansehen“ mit Monat und Budgetgruppe; dieselbe Zuordnungslogik wie die Budgetberechnung. | M; kaum Betriebskosten. Keine privaten Suchtexte in URLs; Gruppen nicht mit Einzelkategorien verwechseln. |
| **Überspringbare Ersteinrichtung** | Neue Konten benötigen eine belegte Ausgangsbasis statt scheinbar fertiger Zahlen. | Drei klar geordnete Schritte: Stand bestätigen/importieren, Plan prüfen, Ziel auswählen. Bestehende Funktionen verwenden. | S–M; kein Pflichtwizard und keine zusätzlichen personenbezogenen Abfragen. Für bestehende Nutzer ausblenden. |
| **Begrenzte Szenariovorschau** | Entscheidungen zu größerer Ausgabe oder Einkommensänderung ohne Änderung echter Daten prüfen. Einmalausgaben-Wirkungsvorschau existiert bereits. | Ein klar markierter Entwurf mit Vorher/Nachher und derselben Berechnungslogik. | L; erst nach Finanzkorrekturen. Hohe Gefahr doppelter Logik und unklarer Annahmen; aktuell nachrangig. |

### Was nicht zuerst gebaut werden sollte

**Automatische Aboerkennung, Pushwarnungen und KI-Empfehlungen haben derzeit keine Priorität.**

Budgetüberschreitungen werden bereits angezeigt. Wichtiger sind korrekte Berechnungen und gute Anschlussaktionen. Aboerkennung sollte später höchstens Vorschläge aus wiederkehrenden Buchungen liefern, niemals ungeprüft Verträge erzeugen.

Externe Bank-/KI-Dienste würden zusätzliche Datenschutz-, Kosten- und Wartungspflichten schaffen, ohne die aktuellen Kernprobleme zu lösen.

## 4. Zielbild

### Architektur und Finanzmodell

Den zentralen Rechenkern behalten, aber gemeinsame Invarianten für Identitäten, Geldrundung und Konten-/Pocketzuordnung stärken.

**Bankfakten, persönliche Anteile, Verbindlichkeiten, Zielbindungen und Prognosen müssen getrennte Begriffe bleiben.** Ein Budget ist weder ein Kontostand noch automatisch verfügbare Zahlungsliquidität. Ein Ziel erzeugt kein zusätzliches Vermögen.

Geldwerte schrittweise an Grenzen konsistent in Cent normalisieren. Eine neue Dezimalbibliothek ist nicht reflexartig erforderlich.

Den `FinanceProvider` nicht ersetzen, sondern seine Verantwortlichkeiten gezielt aufteilen:

- Persistenzcontroller für lokale und servergestützte Speicherung.
- Kontosynchronisierung und SSE-Lifecycle.
- Importzustände und nachvollziehbare Zustandsübergänge.

Die vorhandene verzögerte Dashboardberechnung und Konfliktschutzmechanismen erhalten. Selektoren oder inkrementelle Änderungen erst anhand gemessener großer Datenbestände einführen. Ein monolithischer Zustand allein rechtfertigt keinen Rewrite.

### Oberfläche und Informationsarchitektur

Eine ruhige Übersicht mit eindeutigem Gehalt/Gesamteinkommen, belegtem versus berechnetem Kontostand und vollständig erklärtem Prognoserest.

Alle Ziele bleiben auffindbar, auch wenn das Motorradziel prominent ist. Importdetails bleiben hinter dem Uhrbutton; **die entfernten Umsatzstatus-Tabs werden nicht wieder eingeführt**.

Konkrete Eingabefehler, vollständig lesbare Dialogfolgen und zugängliche Chartdaten ergänzen. Bestehende mobile Listen, Fokusführung, Farbtoken und Sichtschutz bleiben die Grundlage.

Blur ist Sichtschutz, keine Verschlüsselung oder Authentifizierung.

### Vereinfachen statt zusätzliche Oberflächen erzeugen

| Bestehender Bereich | Sinnvolle Weiterentwicklung |
| --- | --- |
| Verteilte Sicherungs-/Konfliktaktionen | Zu einem verständlichen Sicherungs- und Wiederherstellungsablauf zusammenführen |
| „Einnahmen“, „Gehalt“, „Budgetdetails“ und „Alltagsbudget“ | Begriffe konsistent und fachlich präzise verwenden |
| Importstatus und globale Zusammenfassung | Ergebnis je Upload eindeutig zuordnen, kompakte Hauptseite erhalten |
| Zu umfangreicher `FinanceProvider` | Nach getesteten Zustandsübergängen aufteilen, nicht durch neue State-Library ersetzen |
| Technische Warnungen im Lohnbereich | Kompakte relevante Einschränkungen direkt beim Ergebnis erklären, nicht einen großen technischen Block zurückbringen |

### Betrieb und Wartbarkeit

Versionierte Releases, nachweisbar wiederherstellbare Sicherungen und datensparsame Diagnostik.

Überwacht werden sollten Worker-Verfügbarkeit/Queuealter, freier Speicher einschließlich WAL, Backupalter und kategorisierte Fehler. Buchungsinhalte, Passwörter und Tokens gehören nicht in Betriebslogs.

## 5. Umsetzungsfahrplan

| Phase | Maßnahmen und Abhängigkeiten | Risiken | Überprüfbare Akzeptanzkriterien |
| --- | --- | --- | --- |
| **Kurzfristig: fachliche Stabilisierung** | Amex-Doppelabzug, geteilte Rückerstattungen und Pocket-/Zielzählung korrigieren. Anschließend ID-Invarianten und sichere XLSX-Basis. Bestehende Fehltests einzeln fachlich bewerten. | Bestehende persönliche Regeln versehentlich verändern; Testerwartungen nur passend machen. | Geplanter Kauf, Kartenbuchung und spätere Zahlung belasten einmal; vollständige Rückerstattung neutralisiert Eigenanteil/Forderung; Vermögen bleibt bei zusätzlichem Ziel unverändert; Backup verliert keine Zeile. |
| **Kurzfristig: sichere Nutzeraktionen** | Abrechnungen versionssicher löschen/ersetzen; unsupported Steuerkontexte sperren; JSON-/Konfliktwiederherstellung schließen. | Unabsichtliche Datenersetzung oder zurückbleibende lokale Kontodaten. | Zwischenzeitliche Änderung verhindert alte Bestätigung; unbekannte Steuerkontexte liefern keine konkrete Nettoprognose; JSON-Roundtrip mit Vorschau und ungültige Datei ohne Zustandsänderung. |
| **Danach: Importzuverlässigkeit und Klarheit** | Ergebniszahlen/Probleme je Upload-ID, Reparaturabläufe, Parserbudgets, Fehlerklassen und unabhängige Aufbewahrungsbereinigung. Darauf aufbauend Datenbasis-Anzeige. | Herkunftsmetadaten unnötig dauerhaft speichern; Abbruch während Commit. | Null übernommene Zeilen sind kein unqualifizierter Erfolg; gleicher Dateiname vermischt keine Probleme; Timeout gibt Ressourcen frei und lässt den nächsten Job laufen; leere Queue hält Löschfrist ein. |
| **Mittelfristig: Betrieb und gemessene Skalierung** | Isolierte CI, Restoreprobe, Release-Rollback, Capacity-/Workerdiagnose; danach Provider-Extraktion und Benchmarks für größere synthetische Bestände. | Tests greifen auf Privatdaten zu; Refactoring beschädigt Offline-/Konfliktverhalten. | Standardprüfungen benötigen keine privaten Dateien; Wiederherstellung auf leerem Ziel gelingt; vorheriges Release ist rückschaltbar; definierte Größen-/Latenzbudgets werden gemessen. |
| **Später: Produktentwicklung** | Budgetdrilldowns, überspringbare Einrichtung, kontrollierter Planungshorizont; anschließend gegebenenfalls Szenarien und Abo-Vorschläge. | Ungeprüfte Finanz-/Steuerannahmen und wachsende Wartung. | Gleiche Fachlogik in Übersicht/Detail/Szenario; Entwürfe ändern keine echten Daten; neues Jahr ist ausdrücklich unterstützt oder verständlich gesperrt. |

UI-Sofortkorrekturen wie Beschriftungen, Rechenaufschlüsselung, Fehlermeldungen und Dialogumbrüche können parallel erfolgen. Neue Funktionen sollten nicht vor den Finanzkorrekturen liegen.

## 6. Erste konkrete Empfehlung

> **Erstes Arbeitspaket: „Geplante Amex-Ausgaben und offene Kartenverbindlichkeiten genau einmal berücksichtigen“.**

### Warum dieses Paket zuerst?

Ein bestehender Test belegt einen konkreten Fehler. Dieser beeinflusst direkt verfügbare Beträge und Sparentscheidungen. Die Korrektur ist klar abgrenzbar und liefert einen messbaren Nutzen, ohne einen Architekturumbau zu benötigen.

### Umfang

Zuordnung zwischen geplanter Ausgabe, gebuchtem Eigenanteil und offener Amex-Zahlung korrigieren. Zugehörige Monats-/Prognosewerte konsistent ableiten.

**Nicht im Umfang:** allgemeine Importneuschreibung, Zielmodellumbau oder neue Steuerlogik. Diese Punkte gehören in getrennte anschließende Arbeitspakete.

### Abnahme

- Ungesplitteter und geteilter Kauf werden jeweils genau einmal berücksichtigt.
- Noch ungeplanter Kauf, Teil-/Vollzahlung, Monatswechsel und wiederholter Import werden geprüft.
- Der bestehende Fehlerfall zieht nicht mehr 200 € zusätzlich ab.
- Die reale offene Kartenverbindlichkeit verschwindet nicht durch die Korrektur.
- Persönliche Budget- und Sparregeln bleiben unverändert.
- Übersicht und relevante Detail-/Prognosewerte verwenden dieselbe korrigierte Berechnung.

## 7. Analyseabdeckung und Validierung

### Untersuchte Bereiche

Rootkonfiguration und lokale Next.js-Guides; App-Grenzen; Hauptoberflächen/Designsystem; Finanzmodelle; XLSX-Roundtrips; lokale und servergestützte Speicherung; Synchronisierung/Konflikte; Importparser; Worker/SSE; Händler-/Logopfade; Auth-/Serverdatenzugriff; Lohn-/Steuerlogik; Scripts und dokumentierter Betrieb.

Die Analyse verfolgte wichtige Abläufe über mehrere Schichten. Sie ist dennoch **keine vollständige Produktions-, Sicherheits-, Barrierefreiheits- oder Steuerzertifizierung**.

### Tatsächlich ausgeführte Prüfungen

| Bereich | Ergebnis |
| --- | --- |
| TypeScript | Bestanden, ohne inkrementelles Cache-Update |
| Gezieltes Lint für Root/App/Provider/Storage | Bestanden |
| Persistenz, Kontosynchronisierung und Provider | **84 bestanden** |
| UI-Grundkomponenten / Sichtschutz / Dialoge | **22 bestanden** |
| Lohn- / PDF-Lifecycle | **232 bestanden** |
| Finanzlogik | **345 bestanden, 2 fehlgeschlagen, 8 übersprungen** |
| Import- / Status- / Händlerauswahl | **244 bestanden, 9 fehlgeschlagen, 16 übersprungen** |
| Server / Auth / Betriebsskripte, einschließlich Upload/SSE | **159 bestanden, 1 übersprungen** |

Die Zahlen sind Bereichsergebnisse, keine behauptete überschneidungsfreie Gesamtabdeckung. Ergänzend wurden gezielte synthetische Gegenbeispiele und In-Memory-XLSX-Roundtrips ausgeführt.

**Der Qualitätsstand ist nicht vollständig grün.** Fehlgeschlagene Prüfungen wurden während der Analyse weder geändert noch als bestanden dargestellt.

### Einordnung fehlgeschlagener Tests

| Fall | Aktuelle Einordnung |
| --- | --- |
| `src\lib\planned-one-offs.test.ts:92` | Bestätigter Amex-Doppelabzug; konkreter Finanzfehler |
| `src\lib\shared-ranges.test.ts:139` | Abweichung in älterer gewichteter Planlogik bei unbekanntem POS-Händler mit gelerntem Override; beabsichtigten Vertrag klären |
| `src\lib\import\automation.test.ts:218` | September-Prognoseabweichung ungeklärt; nicht pauschal als veraltet einstufen |
| `src\lib\import\automation.test.ts:239` | **Bestätigt veraltete Erwartung:** Oktober-Verteilung widerspricht der bewusst festgelegten Urlaubssparpause |
| BIPA-/Hotspot-/Mensa-Erwartungen in Import-/Kategorieprüfungen | Widerspruch zu neueren Wochentagsregeln; erwartete Semantik einzeln prüfen, nicht pauschal Finanzkorruption behaupten |
| Amazon-Auswahl in `src\components\manual-category-authority.test.tsx` | **Bestätigt veralteter Selektor:** erwartet „Amazon“, während der Alias „Amazon Marketplace“ die zugängliche Bezeichnung bestimmt |

Der Amazon-Test stoppt bereits bei der Auswahl des Bedienelements. Nachfolgende Speicher-/Persistenzassertionen dieses Tests sind dadurch nicht geprüft. Ein veralteter Selektor beweist weder einen kaputten Bearbeitungsablauf noch dessen vollständige Korrektheit.

### Verbleibende Lücken

- Keine aktuelle isolierte Desktop-/Mobil-Browserprüfung, Kontrastmessung oder WCAG-Zertifizierung. Visuelle Einschätzungen sind codebasiert.
- Kein Produktionsbuild, Last-/Power-Loss-Test oder echte Wiederherstellungsprobe in dieser Analyse.
- Hetzner, Caddy und externe CI/Backups wurden nicht live geprüft.
- Im Repository fehlt eine versionierte CI-Pipeline. Das beweist nicht, dass außerhalb keine existiert.
- Aktivierungsscript und HTTPS-Testproxy sind zum Analysezeitpunkt untracked und deshalb nicht als veröffentlichte Betriebsabsicherung anzusehen.
- Bibliotheks-/Frameworkdokumentation wurde gezielt gelesen; nicht jede externe API und jedes Betriebsdetail wurde umfassend verifiziert.
- Steuerliche Stichproben ersetzen keine vollständige Prüfung der Rechtslage und individuellen Anwendbarkeit.

### Datenschutz und Arbeitsgrenzen

Private Dateien, Secrets, Originaldatenbanken und Browserdaten wurden nicht gelesen. Das vollständige Testkommando wurde wegen möglicher privater Fixtures bewusst nicht verwendet. Stattdessen wurden gezielt vorhandene synthetische Prüfungen ausgewählt.

README-Aussagen zu Umsatzstatus-Tabs und Sicherheitsmodus sind teilweise veraltet. Für diese Bereiche existieren bereits spezifischere Dokumente wie `docs\security-mode.md` und `docs\upload-status.md`.

**Während der Analyse wurden keine Codeänderungen, Migrationen, Commits, Pushes oder Änderungen an laufenden Diensten vorgenommen.** Die spätere Ablage dieses Berichts als Markdown ist ein separater Dokumentationsauftrag.
