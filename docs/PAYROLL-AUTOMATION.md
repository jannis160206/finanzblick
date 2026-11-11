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

   Widersprüche halten die Abrechnung vom Budget fern und markieren sie in der Monatsübersicht zur Prüfung. Alle Prüfergebnisse stehen im Import-Protokoll.
3. Aus den eigenen Abrechnungen (2025 + 2026) wird ein **Profil** gelernt:
   - Rufbereitschafts-Pauschale je Jahr;
   - Monate mit Feiertagsdiensten;
   - Sonderzahlungs- und Prämienmonate;
   - Akonto-Muster.

   Das Profil fließt in Prüfung und Prognose ein.
4. Unklare Begriffe erklärt zuerst ein **lokales Glossar**. Nur auf ausdrücklichen Wunsch (Einstellung, standardmäßig aus) wird zusätzlich die vorhandene Wikipedia-Abfrage über den MCP-Server genutzt; dabei verlässt nur der Begriff das Gerät. Ergebnisse stehen im Import-Protokoll.
5. Die Monatsübersicht bleibt die Hauptansicht; technische Details bleiben im Import-Protokoll.

## Leitplanken

- **Manuell geänderte Werte**: Finanzblick merkt sich, welche Budgetwerte es selbst geschrieben hat. Weicht ein solcher Wert später ab, hat ihn jemand von Hand geändert. Er wird dann nicht überschrieben, sondern zur Prüfung angeboten.
- **Doppelte Sonderzahlungen** in „Sonstiges“ werden nie automatisch entfernt, sondern zur Prüfung angeboten.
- **Status in den Finanzdaten**: Der Merkstatus steht als optionales Feld `payrollBudget` in den Finanzdaten (JSON). Eine Datenbankmigration ist nicht nötig.
- **Parser**: Einzige Änderung in `src/lib/import/` ist die Bezeichnung unklarer Bestandteile in der Hinweismeldung, damit sie nachgeschlagen werden können.
