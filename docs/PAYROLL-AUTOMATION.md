# Abrechnungen automatisch ins Budget – Ist, Soll, Umsetzung

Stand: 11.11.2026

## Ist-Zustand (vor der Umsetzung)

- **Abrechnung → Folgemonat**: Jede gespeicherte Abrechnung schreibt ihr Netto automatisch in den Folgemonat. Das gilt für Upload, Drive im Browser und Drive im Hintergrund. Aufgeteilt wird nach Gehalt, Rufbereitschaft, Feiertagsarbeit, Überstunden und Sonderzahlungen (`applyPayslipIncome`).
  - Eine inhaltliche Prüfung gibt es nicht. Der Parser verwirft nur unvollständige Entwürfe; jede vollständig gelesene Abrechnung landet im Budget, auch wenn ihre Zahlen nicht zusammenpassen.
- **Prognose → künftige Monate**: Die Gehaltsprognose (`salaryForecast`) erzeugt Vorschläge für die Einnahmenzeilen der kommenden Monate (`budgetCorrections`), ebenso Hinweise auf doppelte Sonderzahlungen in „Sonstiges“.
  - Übernommen wird erst nach Bestätigung im Dialog **„Budget aktualisieren“**. Der Button steht auf der Budget-Seite und in der Abrechnungs-Zusammenfassung; mit den echten Daten zeigte er 36 offene Vorschläge.
  - Der Sparziel-Planer rechnet offene Vorschläge bereits mit ein.
- **Rufbereitschaft**: Der Pauschalbetrag wird über die letzten zwölf Abrechnungen gelernt (häufigster Betrag). Für 2025 ergibt das keinen sinnvollen Wert.
  - In den echten Daten schwankt die Rufbereitschaft 2025 zwischen 23 € und 720 € ohne wiederkehrenden Betrag.
  - 2026 gibt es eine klare Pauschale (sechs gleiche Monate).
- **Unklare Bestandteile**: Der Parser meldet sie nur mit Lohnartnummer, ohne Bezeichnung. Ein Nachschlagen gibt es nicht.
  - Es gibt aber schon eine Wikipedia-Abfrage über den eingebauten MCP-Server (`search_knowledge`, `/api/knowledge`), die der Assistent nutzt.
- **Echte Abrechnungen** (22, davon 12 aus 2025, nur lokal ausgewertet):
  - **Netto-Abgleich**: Brutto − SV − Lohnsteuer − Netto liegt immer zwischen −16 € und +11 € (kleine steuerfreie Bezüge bzw. Abzüge).
  - **Überweisungen**: Netto − (Akonto + Auszahlung) beträgt immer 4,95–5,57 € (Abzug nach dem Netto).
  - **Sonderzahlungen**: Ihre Lohnsteuer entspricht exakt 6 % nach SV und 620-€-Freibetrag.

## Soll

1. Konsistente Abrechnungen und die daraus folgende Prognose gehen **ohne Bestätigung** ins Budget. Rückmeldung per kurzem Toast und als Statuszeile in der Zusammenfassung. Der Button „Budget aktualisieren“ entfällt.
2. Jede Abrechnung wird nach dem Lesen **lokal geprüft**:
   - Netto-Abgleich;
   - Überweisungen gegen das Netto;
   - Brutto-Bestandteile;
   - Abgabenquoten;
   - Sechstel-Besteuerung der Sonderzahlung;
   - kumulierte Werte;
   - Rufbereitschaft gegenüber Sonderzahlung.

   Widersprüche halten die Abrechnung vom Budget fern und markieren ihren Monat in der Monatsauswahl mit einem gelben Punkt zur Prüfung. Alle Prüfergebnisse stehen im Import-Protokoll.
3. Aus den eigenen Abrechnungen (2025 + 2026) wird ein **Profil** gelernt:
   - Rufbereitschafts-Pauschale je Jahr;
   - Monate mit Feiertagsdiensten;
   - Sonderzahlungs- und Prämienmonate;
   - Akonto-Muster.

   Das Profil fließt in Prüfung und Prognose ein.
4. Unklare Begriffe erklärt zuerst ein **lokales Glossar**. Nur auf ausdrücklichen Wunsch (Einstellung, standardmäßig aus) wird zusätzlich die vorhandene Wikipedia-Abfrage über den MCP-Server genutzt; dabei verlässt nur der Begriff das Gerät. Ergebnisse stehen im Import-Protokoll.
5. Gehalt & Steuern zeigt den Status nur als Punkt in der Monatsauswahl; technische Details bleiben im Import-Protokoll.

## Leitplanken

- **Manuell geänderte Werte**: Finanzblick merkt sich, welche Budgetwerte es selbst geschrieben hat. Weicht ein solcher Wert später ab, hat ihn jemand von Hand geändert. Er wird dann nicht überschrieben, sondern zur Prüfung angeboten.
- **Doppelte Sonderzahlungen** in „Sonstiges“ werden nie automatisch entfernt, sondern zur Prüfung angeboten.
- **Status in den Finanzdaten**: Der Merkstatus steht als optionales Feld `payrollBudget` in den Finanzdaten (JSON). Eine Datenbankmigration ist nicht nötig.
- **Parser**: `src/lib/import/` bleibt unverändert. Der Parser nennt unbekannte Bestandteile bewusst nur mit Lohnartnummer (Datenschutz-Test „does not leak their text“); nachgeschlagen werden deshalb nur Begriffe, die Parser und Prüfung selbst benennen.

## Ergebnis

| Schritt | Commit | Inhalt |
|---|---|---|
| Analyse | `f897992` | dieses Dokument |
| Prüfung | `d3542fb` | `src/lib/payslip-validation.ts`, Prüfergebnisse im Import-Protokoll |
| Automatik | `37b65cf` | `src/lib/payroll-budget.ts`, `PayrollBudgetSync`, Prüf-Dialog statt „Budget aktualisieren“, Kachelstatus „prüfen“ |
| Lernen | `5e313d5` | Pauschale je Jahr, `payrollProfile`, Sonderzahlungshöhe in der Prognose |
| Begriffe | `bf4944e` | Glossar, optionales Nachschlagen (`payslipTermLookup`) |
| Tests & Doku | siehe `main` | E2E-Anpassungen, README, Zusammenfassung |

- **Automatische Übernahme**:
  - Der Abgleich läuft im Browser 1,5 s nach jeder Änderung der Finanzdaten (`src/components/payroll-budget-sync.tsx`) und im Hintergrund-Import auf dem Server (`src/lib/drive/payslips.ts`).
  - Ein Wert geht automatisch ins Budget, wenn Finanzblick ihn noch nicht gesetzt hat oder er seit dem letzten Setzen unverändert ist. Weicht er davon ab, wurde er von Hand geändert und kommt in **„n Budgetwerte prüfen“**. Doppelte Sonderzahlungen kommen immer dorthin.
  - „Beibehalten“ ist dauerhaft (`payrollBudget.kept`); vergangene Monate werden aus dem Merkstatus entfernt.
- **Zurückgehaltene Abrechnungen**:
  - Sie werden gespeichert, aber nicht ins Budget und nicht in die Prognose übernommen.
  - Kachelstatus **prüfen**; die Details nennen die Abweichung, **Ins Budget übernehmen** bestätigt genau diese Werte (`payrollBudget.confirmed`).
  - Das gilt für Upload, Drive im Browser, Hintergrund-Import und „Erneut prüfen“.
- **Prüfung mit echten Daten** (nur lokal): Alle 21 lesbaren Abrechnungen sind konsistent. Der Oktober 2026 mit vielen Überstunden erscheint nur als Info „deutlich über dem üblichen Monat“.
- **Gelerntes Profil mit echten Daten**:
  - Pauschale 2026 erkannt; 2025 hat keinen wiederkehrenden Betrag (Abrechnung je Dienstwoche) und wird nicht aufgeteilt.
  - Sonderzahlungen im Juni und November in Höhe des Grundgehalts, Prämie im Februar, Akonto-Muster.
- **Begriffe**: Glossar für Jahressechstel, Akonto, Auszahlung, Rufbereitschaft, Feiertagsarbeit, Überstunden, Sonderzahlung, Prämie u. a.; „VEB-Prämie“ ist als unklar markiert. Online-Nachschlagen nur mit Einstellung, nur der Begriff verlässt das Gerät.
- **Bekannte Grenze**: Ein länger laufender Statement-Worker oder Dev-Server mit altem Code kennt das Feld `payrollBudget` nicht und entfernt es beim Speichern. Nach dem Update deshalb Server und Worker neu starten; der nächste Abgleich legt den Merkstatus neu an.
