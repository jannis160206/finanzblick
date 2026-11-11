# Gehalt & Steuern – Auszahlungsmonate und österreichische Lohnsteuer

Stand: 11.11.2026

## Ist-Zustand (vor der Umsetzung)

- **Monatslogik**: Eine Abrechnung wird im Folgemonat ausgezahlt (Oktober → November, Dezember → Jänner). Budget, Prognose und Bankbuchungen folgen dieser Regel. Ein Gehalt, das am 26.–30. eingeht, zählt zum Folgemonat. Vor Sonderzahlungsmonaten (März, Juli, Dezember) zählt auch der 25.
- **Prognose der Sonderzahlungen** (`src/lib/salary-forecast.ts`):
  - Das Modell kennt je ein Grundgehalt mit der Juni- und der November-Abrechnung (ausgezahlt im Juli bzw. Dezember).
  - Fehlt ein Modellwert, wiederholt die Prognose den gleichen Monat des Vorjahres.
  - Die Prämie der Februar-Abrechnung 2026 (am 25.2. eingegangen) erscheint deshalb als Sonderzahlung im **März 2027**, der **Jänner 2027** bleibt ohne Sonderzahlung.
- **Netto der Sonderzahlungen**: Pauschal **78 %** vom Brutto (17,07 % SV, rund 6 % Lohnsteuer), sobald die genaue Steuerprojektion fehlt. Mit den echten Abrechnungen fehlt sie immer: Die Prämie vom Februar 2026 wurde nach Tarif versteuert, ihr Sechstelverbrauch ist nicht belegt.
  - Für Juni und November passt das ungefähr.
  - Eine große Prämie im Dezember liegt aber großteils über dem Jahressechstel und wird wie laufendes Gehalt versteuert; 78 % wären deutlich zu hoch.
- **Lohnsteuertarif** (`src/lib/payroll-analysis.ts`):
  - Tarifstufen 2026 und 2027 sind hinterlegt, ebenso die Sechstel-Besteuerung (620 € frei, 6 %, 27 %, 35,75 %).
  - Angewendet wird beides nur in der strengen Steuerprojektion. Absetzbeträge sind dort „unverändert angenommen“, aber nicht beziffert.
- **Abgleich mit den echten Abrechnungen** (nur lokal):
  - Die laufende Lohnsteuer jeder Abrechnung ergibt sich auf den Cent aus Tarif(LSt-Basis × 12 − 132 €) / 12 − Verkehrsabsetzbetrag / 12.
  - Verkehrsabsetzbetrag 2026: **496 €**; 2025: **487 €**. Weitere Absetzbeträge (z. B. Familienbonus Plus) sind nicht erkennbar.
  - Sonderzahlungen im Juni und November werden mit 6 % nach SV versteuert, im Juni nach Abzug der 620 €.
- **Steuerklassen** gibt es in Österreich nicht; die App verwendet den Begriff nirgends.

## Soll

1. **Successbonus**:
   - wird mit der Dezember-Abrechnung gezahlt und im **Jänner** ausgezahlt;
   - Höhe: **138,5 % des Brutto-Grundgehalts**, einstellbar unter Einstellungen → Abrechnungen;
   - Vorjahresprämien in anderen Monaten (z. B. März) werden nicht mehr wiederholt.
2. Sonderzahlungen werden als **sonstige Bezüge** besteuert:
   - im Jahressechstel 620 € steuerfrei (einmal pro Jahr), danach 6 %;
   - der Teil über dem Sechstel wird mit dem laufenden Bezug des Monats nach Tarif versteuert;
   - SV nach Sonderzahlungs-Sätzen bis zur jährlichen Höchstbeitragsgrundlage.
3. **Lohnsteuertarif AT** für Prognose und automatische Budget-Übernahme:
   - progressive Tarifstufen 2026/2027;
   - Absetzbeträge zuerst aus den eigenen Abrechnungen gelernt, sonst der gesetzliche Verkehrsabsetzbetrag; Familienbonus Plus, sobald er in den Abrechnungen erkennbar ist.
4. Eine kleine Zeile auf der Seite nennt die Logik: „Lohnsteuertarif AT · progressiv + Absetzbeträge“.

## Leitplanken

- `src/lib/import/` und die Validierung bleiben unverändert.
- Die automatische Budget-Übernahme schreibt die neuen Prognosewerte wie bisher; von Hand geänderte Werte bleiben zur Prüfung stehen.
- Die strenge Steuerprojektion („Sonderzahlung & Jahressechstel“) rechnet unverändert nur mit belegten Werten. Die Prognose nutzt dieselben Formeln mit geschätzten Startwerten.

## Ergebnis

| Schritt | Commit | Inhalt |
|---|---|---|
| Analyse | `d0076a7` | dieses Dokument |
| Logik | `1dde606` | `src/lib/wage-tax-at.ts`, Successbonus, Prognose nach Tarif, frühes Dezember-Gehalt |
| Oberfläche | `e2f506d` | Steuerzeile, geschätzte Lohnsteuer/SV je Monat, Einstellungen → Gehaltsmodell |
| Korrektur | `114d014` | Absetzbeträge eines Jahres ohne Abrechnung aus früheren Abrechnungen |
| Tests & Doku | siehe `main` | README, Zusammenfassung |

- **Lohnsteuer** (`src/lib/wage-tax-at.ts`):
  - Tarifstufen 2025, 2026 und 2027 (2027 aus BGBl. II Nr. 260/2026);
  - Lohnsteuer eines Monats = Tarif(Basis × 12 − 132 €) / 12 − Absetzbeträge / 12, nie negativ;
  - Absetzbeträge aus den letzten drei Abrechnungen gelernt; der Verkehrsabsetzbetrag folgt dem Jahr (496 € 2026, 508 € 2027), weitere Absetzbeträge bleiben wie beobachtet; Familienbonus Plus (2.000,16 € bzw. 700,08 € je Kind) wird erkannt;
  - die bisherigen privaten Kopien in `payroll-analysis.ts` nutzen jetzt dieses Modul; die Ergebnisse der Steuerprojektion sind unverändert.
- **Sonderzahlungen**:
  - SV mit 14,12–17,07 % bis zur jährlichen Höchstbeitragsgrundlage von 13.860 €;
  - im Sechstel kumuliert 620 € frei, dann 6 %, 27 % und 35,75 %; unter der Freigrenze steuerfrei;
  - der Überhang wird zum laufenden Bezug des Monats addiert und nach Tarif versteuert;
  - für jeden Prognosemonat gibt es eine Schätzung (`taxEstimates`). Wo die strenge Projektion rechnen kann, stimmt die Schätzung mit ihr auf den Cent überein (Test).
- **Successbonus**:
  - Einstellung `successBonusPercent`, Standard 138,5 % des Grundgehalts, 0 schaltet ihn ab; JSON-Feld der Finanzdaten, keine Datenbankmigration; in der Excel-Sicherung enthalten;
  - im Gehaltsmodell mit der Dezember-Abrechnung, im Budget und in der Prognose im Jänner;
  - reserviert das restliche Jahressechstel, deshalb schrumpft der „Prämien-Spielraum“ entsprechend.
- **Mit echten Daten geprüft** (nur lokal):
  - Dezember 2026: die November-Sonderzahlung liegt im Sechstel und wird mit 6 % versteuert, wie im Juni.
  - Jänner 2027: Vom Successbonus liegt nur ein kleiner Teil im restlichen Sechstel. Der größere Teil wird nach Tarif versteuert, das Netto liegt deutlich unter der alten 78-%-Pauschale. Der Jänner ist damit „fast doppelt“.
  - März 2027: keine Sonderzahlung mehr.
  - Die automatische Budget-Übernahme schreibt diese Werte beim nächsten Abgleich; von Hand geänderte Werte bleiben zur Prüfung.
- **Aufteilung je Sonderzahlung** (M15, `src/lib/payroll-sixth.ts`):
  - Jede Sonderzahlung des Jahres wird exakt aufgeteilt: Brutto im Jahressechstel und darüber; nach SV (aliquot aufgeteilt) der steuerfreie Rest der 620 € (bzw. alles unter der Freigrenze), der Teil zu 6 % (selten 27 %/35,75 %) und der Überhang, der mit dem laufenden Bezug des Monats nach Tarif versteuert wird.
  - Belegte Sonderzahlungen werden aus der Abrechnung nachgerechnet: Sechstel = laufende Bezüge seit Jänner ÷ Monate × 2 (Lücken mit dem Durchschnitt, als geschätzt markiert), gedruckte Werte wie verbrauchtes Sechstel haben Vorrang. Ein Überhang steckt laut Lohnverrechnung schon in der gedruckten LSt-Basis und wird davon abgezogen. Tarifbesteuerte Prämien erscheinen als „voll versteuert“ und nutzen das Sechstel nicht.
  - Geplante Sonderzahlungen kommen aus derselben Prognose wie das Budget (`taxEstimates`).
  - Präzisionskorrektur: Fehlt ein belegter Sechstelverbrauch, zählte die Prognose bisher alle früheren Sonderzahlungen brutto als verbraucht. Jetzt zählt nur der Teil, der tatsächlich im Sechstel lag; ein früherer Überhang wurde ja nach Tarif versteuert. Ohne Überhang ändert sich nichts.
  - Mit den echten Abrechnungen geprüft (nur lokal): Die Nachrechnung trifft die gedruckte Sonderzahlungs-Lohnsteuer von Juni und November 2025 sowie Juni 2026 auf den Cent.
- **Grenzen**:
  - Kontrollsechstel (§ 77 Abs. 4a): Das Dezember-Sechstel entspricht den Jahresbezügen ÷ 6. Eine Aufrollung früherer Monate, falls das Sechstel im Jahr sinkt oder ein früherer Überhang nachträglich Platz findet, wird nicht nachgerechnet.
  - SV-Werte 2027 sind noch nicht verifiziert; die Schätzung nutzt die Sätze 2026.
  - Ob der Successbonus tatsächlich im Sechstel begünstigt wird, zeigt erst die Dezember-Abrechnung. Die Februar-Prämie 2026 wurde nach Tarif versteuert. Die Validierung warnt dann nur („ein Teil liegt vermutlich über dem Sechstel“), sie hält nicht zurück.
  - Pendlerpauschale, Alleinverdiener- und Unterhaltsabsetzbetrag fließen nur ein, wenn sie in den Abrechnungen erkennbar sind.
