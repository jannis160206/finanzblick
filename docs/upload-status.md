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
