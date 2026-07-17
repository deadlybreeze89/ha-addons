# Haushalts-Dashboard

Gemeinsame Web-App für tägliche & wöchentliche Haushaltsaufgaben mit
Abhak-Funktion und internem Zähler, wer was erledigt hat.

## Installation als Home Assistant Add-on

1. In Home Assistant: Einstellungen -> Add-ons -> Add-on Store -> ⋮ -> Repositories
2. Dieses Repository hinzufügen: `https://github.com/deadlybreeze89/ha-addons`
3. "Haushalts-Dashboard" installieren und starten.
4. App aufrufen unter:
   ```
   http://<pi-ip>:3210
   ```
   (Port 3210 kollidiert nicht mit Home Assistant, das i.d.R. auf 8123 läuft.)

## Nutzung

- **Heute**: alle täglichen Aufgaben, jeden Tag neu abzuhaken
- **Diese Woche**: wöchentliche Aufgaben, heutiger Wochentag wird oben angezeigt
- Antippen des Kreises hakt eine Aufgabe ab → fragt, wer es war → zählt hoch
- Nochmal antippen macht das Abhaken rückgängig (Zähler geht wieder runter)
- Zähler oben zeigt den Stand pro Person, "Zähler zurücksetzen" unten setzt auf 0
- Über "Aufgabe hinzufügen" könnt ihr jederzeit neue Aufgaben ergänzen

## Daten & Neustart

Die Datenbank liegt im persistenten `/data`-Ordner des Add-ons (SQLite) und
bleibt bei Neustarts/Updates erhalten.

## Als Startseite / Favicon aufs Handy

Beide könnt ihr euch `http://<pi-ip>:3210` als Lesezeichen bzw. "Zum
Homebildschirm hinzufügen" auf dem Smartphone speichern, dann wirkt es
wie eine App.
