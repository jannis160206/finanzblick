# Gehalt & Steuern – Auszahlungsmonate und österreichische Lohnsteuer

Stand: 11.11.2026

## Ist-Zustand (vor der Umsetzung)

- **Monatslogik**: Eine Abrechnung wird im Folgemonat ausgezahlt (Oktober → November, Dezember → Jänner). Budget, Monatsübersicht und Bankbuchungen folgen dieser Regel. Ein Gehalt, das am 26.–30. eingeht, zählt zum Folgemonat. Vor Sonderzahlungsmonaten (März, Juli, Dezember) zählt auch der 25.
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
