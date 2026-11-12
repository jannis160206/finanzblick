// Phrasings that change contracts or start a new one; pure text checks, so the router can use them without data.

const contractNoun = /\b(?:vertr[aä]g\w*|\w+vertrag|abos?|\w+abos?|abonnement\w*|\w*versicherung\w*|mitgliedschaft\w*|tarif\w*)\b/;
const bookingNoun = /(?:buchung|abbuchung|umsatz|umsätze|umsaetze|zahlung|lastschrift)\w*/;
const intervalWord = "(?:monatlich|jährlich|jaehrlich|vierteljährlich|vierteljaehrlich|quartalsweise|halbjährlich|halbjaehrlich|wöchentlich|woechentlich|alle zwei wochen)";
const intervalIs = new RegExp(`\\b(?:ist|sind|läuft|laeuft|geht)\\s+(?:jetzt\\s+|ab jetzt\\s+|neu\\s+|nun\\s+|nur noch\\s+|künftig\\s+|kuenftig\\s+)?${intervalWord}\\s*[.!]?$`);
const intervalPaid = new RegExp(`\\b(?:zahl|bezahl)\\w*\\s+(?:ich\\s+)?(?:jetzt\\s+|ab jetzt\\s+|nur noch\\s+|künftig\\s+|kuenftig\\s+|neu\\s+)?${intervalWord}\\b`);

/** "Leg einen neuen Vertrag an", "Neues Abo: Disney+ 9,99 im Monat", "Trag meinen Handyvertrag ein". */
export const contractNewRequest = (lower: string) =>
  /\b(?:leg\w*|trag\w*|füg\w*|fueg\w*|erfass\w*|erstell\w*|nimm|richt\w*)\b.{0,40}\b(?:vertr[aä]g\w*|\w+vertrag|abos?|abonnement|versicherung|mitgliedschaft)\b.{0,60}\b(?:an|ein|hinzu|auf|anlegen|eintragen|hinzufügen|hinzufuegen|erfassen)\b/.test(lower) ||
  /^(?:bitte\s+)?(?:neue[rns]?|eigene[rns]?)\s+(?:vertrag|abo|abonnement|versicherung|mitgliedschaft|handyvertrag)\b/.test(lower) ||
  /\b(?:vertrag|abo|versicherung)\s+(?:manuell\s+)?(?:hinzufügen|hinzufuegen|anlegen|eintragen|erfassen)\b/.test(lower) ||
  /\bich (?:habe|hab) (?:jetzt |seit kurzem |gerade )?(?:ein(?:en)? )?neue[sn]? (?:abo|vertrag|handyvertrag|versicherung|abonnement|mitgliedschaft)\b/.test(lower);

const question = /\?\s*$|^(?:wann|wie|was|welche\w*|warum|wieso|ist|sind|hab(?:e)? ich|gibt es|läuft|laeuft)\b/;

/** "Markiere die Disney Plus Buchung als Vertrag", "Mach aus der Amazon Buchung einen Vertrag": a new contract from bookings. */
export const contractFromBookingRequest = (lower: string) => bookingNoun.test(lower) && !question.test(lower) && !/\bkein(?:e|en)?\s+(?:vertrag|abo)\b/.test(lower) && (
  /\bals\s+(?:neue[nmrs]?\s+|eigene[nmrs]?\s+)?(?:vertrag|abo|abonnement)\b/.test(lower) && /\b(?:markier|kennzeichn|speicher|leg|trag|nimm|übernimm|uebernimm|mach|setz|erfass|anleg|merk)\w*/.test(lower) ||
  /\b(?:mach|erstell|leg|erzeug)\w*\b.{0,60}\b(?:einen|ein|zu einem)\s+(?:neuen?\s+)?(?:vertrag|abo)\b/.test(lower) && /\baus\b|\bmit\b|\bzu einem\b/.test(lower) ||
  /\b(?:ist|sind)\s+(?:eigentlich\s+|auch\s+)?(?:ein(?:e)?\s+)?(?:neue[rs]?\s+)?(?:vertrag|abo|abonnement)\s*[.!]?$/.test(lower));

/** "Ordne die Buchung vom 2.10. dem Vertrag Disney Plus zu", "Nimm die Buchung vom 3.10. aus dem Netflix-Vertrag". */
export const contractBookingsRequest = (lower: string) => bookingNoun.test(lower) && (contractNoun.test(lower) || /\bverkn[üu]e?pf\w*\b.{2,60}\bmit\b/.test(lower)) &&
  !question.test(lower) && !contractFromBookingRequest(lower) &&
  /\b(?:ordne|ordn\w*|zuordn\w*|zugeordnet|gehört|gehoert|gehören|gehoeren|verknüpf\w*|verknuepf\w*|verbind\w*|hinzufüg\w*|füg\w*|fueg\w*|zähl\w*|zaehl\w*|nimm|nehm\w*|entfern\w*|lös\w*|loes\w*|raus|heraus\w*)\b/.test(lower);

/** Changes to an existing contract: status (confirm, hide, cancelled, active again), fields, reset or removal. */
export function contractEditRequest(lower: string, known = false): boolean {
  const asked = question.test(lower) && !/^(?:kannst|könntest|koenntest|würdest|wuerdest) du\b/.test(lower);
  if (asked) return false;
  const noun = contractNoun.test(lower);
  return /\b(?:ist|is|sind|wurde|wurden|habe|hab|hatte)\b.{0,40}\bgekündigt\b|\bals gekündigt\b|\bgekündigt (?:zum|per|ab|am|seit)\b/.test(lower) && !/\bnicht gekündigt\b/.test(lower) ||
    /\b(?:ist|sind)\s+(?:doch\s+)?(?:kein|keine)\s+(?:vertr[aä]g\w*|abos?|abonnement|versicherung)\b|\bkein vertrag\b/.test(lower) ||
    /\b(?:bestätig|bestaetig)\w*\b/.test(lower) && (noun || /\bvorschl[aä]g\w*\b/.test(lower)) ||
    // "Bestätige Netflix": a confirmation always means a contract suggestion.
    /^(?:bitte\s+)?(?:bestätig|bestaetig)\w*\s+(?!die änderung|das|alles\b)\S/.test(lower) ||
    /\b(?:blend\w*\b.{0,40}\baus|ausblend\w*)\b/.test(lower) && !known ||
    /\b(?:wieder (?:aktiv|einblend\w*|anzeig\w*|herstell\w*)|wiederherstell\w*|doch (?:nicht gekündigt|ein vertrag|ein abo)|(?:läuft|laeuft) (?:doch |jetzt |ja )?wieder|reaktivier\w*)\b/.test(lower) && (noun || !known) ||
    /\b(?:verwirf|verwerf\w*|zurücksetz\w*|zuruecksetz\w*)\b/.test(lower) && (noun || /(?:^|\s)änderungen an\b/.test(lower)) ||
    /\bkündigungsfrist\b.{0,60}\b(?:\d+\s*(?:tage?n?|wochen?|monate?n?)|keine|ist|beträgt|betraegt|auf)\b/.test(lower) ||
    /\b(?:keine|ohne) kündigungsfrist\b|\bjederzeit kündbar\b/.test(lower) ||
    /\b(?:\d+|ein(?:en)?|zwei|drei|sechs)\s+(?:tage?n?|wochen?|monate?n?)\s+kündigungsfrist\b/.test(lower) ||
    /\bmindestlaufzeit\b.{0,60}\b(?:bis|endet|läuft|laeuft|keine)\b|\b(?:keine|ohne) mindestlaufzeit\b/.test(lower) ||
    /\b(?:verlängert|verlaengert) sich\b/.test(lower) ||
    /\bkostet\s+(?:jetzt|jetz|ab jetzt|neu|nun|mittlerweile|inzwischen|seit)\b/.test(lower) && !known ||
    // "Mach den Magenta-Vertrag weg", "Mach aus Spotify einen jährlichen Vertrag".
    /\b(?:mach|tu|schaff)\w*\b.{0,40}\bweg\s*[.!]?$/.test(lower) && noun ||
    /\bmach\w*\s+aus\b.{2,40}\b(?:einen|ein)\s+\S+\s+(?:vertrag|abo)\b/.test(lower) ||
    /\b(?:wird|werden)\s+(?:(?:jetzt|ab jetzt|nur|künftig|kuenftig|ab\s+\S+(?:\s+20\d\d)?)\s+)*(?:monatlich|jährlich|jaehrlich|vierteljährlich|vierteljaehrlich|quartalsweise|halbjährlich|halbjaehrlich|wöchentlich|woechentlich|alle zwei wochen)\s+(?:abgebucht|bezahlt|verrechnet|abgerechnet|fällig|faellig|belastet)\b/.test(lower) ||
    /\bnächste abbuchung\b.{0,40}\b(?:am|ist|wäre|waere)\b/.test(lower) ||
    /\b(?:lösch|loesch|entfern)\w*\b.{0,30}\b(?:vertr[aä]g\w*|\w+vertrag|abos?|abonnement|\w*versicherung\w*|mitgliedschaft)\b/.test(lower) && !/\bbuchung/.test(lower) ||
    /\b(?:benenn\w*|umbenenn\w*)\b.{0,40}\b(?:vertrag|abo|versicherung)\b/.test(lower) ||
    // "Ändere den Namen von FITINN auf Fitnessstudio", "Nenn FITINN ab jetzt Fitnessstudio": a contract, else the bookings' display name.
    /\b(?:name|namen|bezeichnung)\b.{0,50}\b(?:auf|in|zu)\s+\S/.test(lower) && /\b(?:änder|aender|setz|stell|mach)\w*/.test(lower) && (noun || !known) ||
    /^(?:bitte\s+)?nenn\w*\s+(?!mir\b|uns\b).{2,60}?\s+(?:ab jetzt|ab sofort|künftig|kuenftig|in zukunft|nur noch|einfach)\s+\S/.test(lower) && (noun || !known) ||
    // "Stell das Intervall von Netflix auf jährlich", "Hausratversicherung ist vierteljährlich", "Netflix zahle ich jetzt jährlich".
    /\b(?:intervall|rhythmus|turnus|zahlungsrhythmus|zahlungsintervall|abrechnungsintervall)\b/.test(lower) && /\b(?:auf|ist|änder\w*|aender\w*|stell\w*|setz\w*|mach\w*|umstell\w*|wechsel\w*)\b/.test(lower) ||
    intervalIs.test(lower) && (noun || !known) ||
    intervalPaid.test(lower) && (noun || !known) && !/spar|sparziel|rate\b/.test(lower) ||
    /^(?:der\s+|das\s+|mein\s+)?(?:vertrag|abo)\s+.{2,40}\bkategorie\s+\S/.test(lower) ||
    /\bnotiz\b.{0,40}\b(?:vertrag|abo|versicherung|zu|für|fuer)\b/.test(lower) && noun ||
    /\bkategorie\b.{0,40}\b(?:vertrag|abo|versicherung)\b|\b(?:vertrag|abo|versicherung)\b.{0,40}\bkategorie\b/.test(lower) && /\b(?:ist|auf|zu|in|ändern|aendern|setz\w*)\b/.test(lower);
}
