# Uploadstatus unter Umsätze

Der Uhr-Button links neben **Dateien auswählen** öffnet Fortschritt, Ergebnisse
und Importhinweise. Seine Zahl zählt aktive Dateiimporte einschließlich
Übertragung, Warteschlange, Verarbeitung und erneuter Versuche. Abgeschlossene
oder fehlgeschlagene Importe sowie reine Hintergrund-Nachläufe zählen nicht mit.
Ohne aktive Importe weist ein `!` auf Fehler oder Importhinweise hin.

- Im Kontomodus aktualisiert die bestehende Echtzeitverbindung den Status.
  Eine validierte Upload-UUID verbindet Übertragung und Serverauftrag auch bei
  gleichen Dateinamen; Berechtigungen und Kontozuordnung bleiben serverseitig.
- Übertragung und lokale Dateiprüfung zeigen keinen erfundenen Prozentwert.
  Lokale Importe gelten erst nach erfolgreichem Speichern als abgeschlossen.
- Eine fehlerhafte Datei stoppt die übrigen Dateien einer Kontoauswahl nicht.
  Höchstens fünf Kontoauszüge je Auswahl und die bestehenden Größenlimits gelten.
- Das Fenster zeigt alle laufenden Vorgänge sowie zusammen höchstens die zwei
  zuletzt beendeten Dateiimporte. Fehlgeschlagene Importe zählen ebenfalls zu
  diesen zwei Ergebnissen und behalten ihre Fehlerdetails. Der letzte
  gespeicherte Importbericht bleibt verfügbar. Die bestehende Echtzeitquelle
  liefert bis zu 20 Serveraufträge, mit Vorrang für laufende Vorgänge.
  Es ist kein unbegrenztes Uploadarchiv.
- Kontowechsel entfernen lokale Dateistatus und brechen offene Übertragungen ab.
  Der Sicherheitsmodus schützt auch das Statusfenster.

Die frühere Zuordnungs-Filterleiste entfällt. **Prüfen**, einzelne
Zuordnungsdetails und die übrigen Umsatzfilter bleiben erhalten.

## Fachliche Ergebnisse

Ergebnisse sind einer Upload-UUID zugeordnet, nicht dem Dateinamen. Neue,
aktualisierte, doppelte, zu prüfende und verworfene Buchungen werden getrennt
gezählt. Reine Duplikatimporte sind kein Fehler; ältere Ergebnisse erhalten
keine erfundenen Zählwerte. Technischer Abschluss ist von **mit Hinweisen** und
**nicht unterstützt** zu unterscheiden.

Reparierbare Quellen bleiben als kompakte Entwürfe in **Prüfen** erhalten und
benötigen eine bewusste Freigabe. Nicht unterstützte Währungen und unbrauchbare
Entwürfe benötigen einen erneuten Upload; sie werden nicht als Euro oder mit
gekürzten Finanzinformationen übernommen.
Fremdwährungsprobleme haben ausdrücklich die Maßnahme **erneut auswählen** und
keinen editierbaren EUR-Prüfentwurf. Begrenzte Quellbelege bleiben im Ergebnis
sichtbar. Nicht speicherbare Entwürfe (etwa mehr als 1.000 Zeichen Buchungstext)
werden einzeln übersprungen; gültige Buchungen derselben Datei bleiben erhalten.
Browser und Worker prüfen Entwürfe gegen dasselbe Schema, der Worker bereits
vor der Child-IPC-Antwort.

Zusammengefasste Fixkostenprüfungen behalten die Upload-UUID jeder Buchung, auch
bei späteren Uploads oder Teilentscheidungen. Eine entfernte Prüfung ohne
tatsächlich gespeicherte passende Buchung zählt als **übersprungen**, nicht als
Duplikat.

Die Anzeige und spätere Schreibvorgänge begrenzen Ergebnisse auf sieben Tage
und 20 Einträge. Ruhende gespeicherte Finanzstände können ältere Metadaten bis
zum nächsten Schreibvorgang enthalten. Der Worker bereinigt beendete
Jobmetadaten unabhängig, sobald die Originaldatei entfernt ist. Noch benötigte
Prüfentwürfe bleiben bis zur ausdrücklichen Bearbeitung erhalten.
