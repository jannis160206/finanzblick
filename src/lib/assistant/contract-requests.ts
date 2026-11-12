// Phrasings that change contracts or start a new one; pure text checks, so the router can use them without data.

const contractNoun = /\b(?:vertr[aä]g\w*|\w+vertrag|abos?|abonnement\w*|versicherung\w*|mitgliedschaft\w*|tarif\w*)\b/;

/** "Leg einen neuen Vertrag an", "Neues Abo: Disney+ 9,99 im Monat", "Trag meinen Handyvertrag ein". */
export const contractNewRequest = (lower: string) =>
  /\b(?:leg\w*|trag\w*|füg\w*|fueg\w*|erfass\w*|erstell\w*|nimm|richt\w*)\b.{0,40}\b(?:vertr[aä]g\w*|\w+vertrag|abos?|abonnement|versicherung|mitgliedschaft)\b.{0,60}\b(?:an|ein|hinzu|auf|anlegen|eintragen|hinzufügen|hinzufuegen|erfassen)\b/.test(lower) ||
  /^(?:bitte\s+)?(?:neue[rns]?|eigene[rns]?)\s+(?:vertrag|abo|abonnement|versicherung|mitgliedschaft|handyvertrag)\b/.test(lower) ||
  /\b(?:vertrag|abo|versicherung)\s+(?:manuell\s+)?(?:hinzufügen|hinzufuegen|anlegen|eintragen|erfassen)\b/.test(lower) ||
  /\bich (?:habe|hab) (?:jetzt |seit kurzem |gerade )?(?:ein(?:en)? )?neue[sn]? (?:abo|vertrag|handyvertrag|versicherung|abonnement|mitgliedschaft)\b/.test(lower);

const question = /\?\s*$|^(?:wann|wie|was|welche\w*|warum|wieso|ist|sind|hab(?:e)? ich|gibt es|läuft|laeuft)\b/;

/** Changes to an existing contract: status (confirm, hide, cancelled, active again), fields, reset or removal. */
export function contractEditRequest(lower: string, known = false): boolean {
  const asked = question.test(lower) && !/^(?:kannst|könntest|koenntest|würdest|wuerdest) du\b/.test(lower);
  if (asked) return false;
  const noun = contractNoun.test(lower);
  return /\b(?:ist|sind|wurde|wurden|habe|hab|hatte)\b.{0,40}\bgekündigt\b|\bals gekündigt\b|\bgekündigt (?:zum|per|ab|am|seit)\b/.test(lower) && !/\bnicht gekündigt\b/.test(lower) ||
    /\b(?:ist|sind)\s+(?:doch\s+)?(?:kein|keine)\s+(?:vertr[aä]g\w*|abos?|abonnement|versicherung)\b|\bkein vertrag\b/.test(lower) ||
    /\b(?:bestätig|bestaetig)\w*\b/.test(lower) && (noun || /\bvorschl[aä]g\w*\b/.test(lower)) ||
    // "Bestätige Netflix": a confirmation always means a contract suggestion.
    /^(?:bitte\s+)?(?:bestätig|bestaetig)\w*\s+(?!die änderung|das|alles\b)\S/.test(lower) ||
    /\b(?:blend\w*\b.{0,40}\baus|ausblend\w*)\b/.test(lower) && !known ||
    /\b(?:wieder (?:aktiv|einblend\w*|anzeig\w*|herstell\w*)|wiederherstell\w*|doch (?:nicht gekündigt|ein vertrag|ein abo)|läuft wieder|laeuft wieder|reaktivier\w*)\b/.test(lower) && (noun || !known) ||
    /\b(?:verwirf|verwerf\w*|zurücksetz\w*|zuruecksetz\w*)\b/.test(lower) && (noun || /(?:^|\s)änderungen an\b/.test(lower)) ||
    /\bkündigungsfrist\b.{0,60}\b(?:\d+\s*(?:tage?n?|wochen?|monate?n?)|keine|ist|beträgt|betraegt|auf)\b/.test(lower) ||
    /\b(?:keine|ohne) kündigungsfrist\b|\bjederzeit kündbar\b/.test(lower) ||
    /\b(?:\d+|ein(?:en)?|zwei|drei|sechs)\s+(?:tage?n?|wochen?|monate?n?)\s+kündigungsfrist\b/.test(lower) ||
    /\bmindestlaufzeit\b.{0,60}\b(?:bis|endet|läuft|laeuft|keine)\b|\b(?:keine|ohne) mindestlaufzeit\b/.test(lower) ||
    /\b(?:verlängert|verlaengert) sich\b/.test(lower) ||
    /\bkostet\s+(?:jetzt|ab jetzt|neu|nun|mittlerweile|inzwischen|seit)\b/.test(lower) && !known ||
    /\b(?:wird|werden)\s+(?:(?:jetzt|ab jetzt|nur|künftig|kuenftig|ab\s+\S+(?:\s+20\d\d)?)\s+)*(?:monatlich|jährlich|jaehrlich|vierteljährlich|vierteljaehrlich|quartalsweise|halbjährlich|halbjaehrlich|wöchentlich|woechentlich|alle zwei wochen)\s+(?:abgebucht|bezahlt|verrechnet|abgerechnet|fällig|faellig|belastet)\b/.test(lower) ||
    /\bnächste abbuchung\b.{0,40}\b(?:am|ist|wäre|waere)\b/.test(lower) ||
    /\b(?:lösch|loesch|entfern)\w*\b.{0,30}\b(?:vertr[aä]g\w*|\w+vertrag|abos?|abonnement|versicherung|mitgliedschaft)\b/.test(lower) && !/\bbuchung/.test(lower) ||
    /\b(?:benenn\w*|umbenenn\w*)\b.{0,40}\b(?:vertrag|abo|versicherung)\b/.test(lower) ||
    /\bnotiz\b.{0,40}\b(?:vertrag|abo|versicherung|zu|für|fuer)\b/.test(lower) && noun ||
    /\bkategorie\b.{0,40}\b(?:vertrag|abo|versicherung)\b|\b(?:vertrag|abo|versicherung)\b.{0,40}\bkategorie\b/.test(lower) && /\b(?:ist|auf|zu|in|ändern|aendern|setz\w*)\b/.test(lower);
}
