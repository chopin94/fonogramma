// Focolai di auscultazione cardiaca e punti di auscultazione toracica, con guida clinica.
// Coordinate nel viewBox 300×380 della mappa del torace (vista anteriore: la destra del
// paziente è a sinistra dello schermo; vista posteriore: la sinistra del paziente è a sinistra).

export const HEART_SITES = [
  {
    id: 'aortico', n: 1, name: 'Aortico', full: 'Focolaio aortico',
    where: '2° spazio intercostale, margine sternale destro',
    piece: 'Membrana', preset: 'membrana', view: 'front', x: 136, y: 113,
    position: 'Paziente seduto; per i soffi diastolici inclinato in avanti, in espirazione forzata.',
    listen: [
      'Intensità della componente A2 di S2 (ridotta nella stenosi aortica severa)',
      'Soffio mesosistolico crescendo-decrescendo, aspro, irradiato alle carotidi (stenosi aortica)',
      'Click eiettivo protosistolico (valvola bicuspide)',
    ],
  },
  {
    id: 'polmonare', n: 2, name: 'Polmonare', full: 'Focolaio polmonare',
    where: '2° spazio intercostale, margine sternale sinistro',
    piece: 'Membrana', preset: 'membrana', view: 'front', x: 164, y: 113,
    position: 'Supino o seduto: confronta inspirazione ed espirazione.',
    listen: [
      'Sdoppiamento di S2: fisiologico (si allarga in inspirazione), fisso (difetto interatriale), paradosso (blocco di branca sinistro)',
      'P2 accentuato (ipertensione polmonare)',
      'Soffio eiettivo polmonare; soffio di Graham Steell',
    ],
  },
  {
    id: 'erb', n: 3, name: 'Erb', full: 'Punto di Erb', optional: true,
    where: '3° spazio intercostale, margine sternale sinistro',
    piece: 'Membrana', preset: 'membrana', view: 'front', x: 164, y: 137,
    position: 'Seduto, inclinato in avanti, in espirazione trattenuta.',
    listen: [
      'Soffio diastolico decrescente ad alta frequenza (insufficienza aortica)',
      'Sintesi dei reperti dei focolai della base',
    ],
  },
  {
    id: 'tricuspidale', n: 4, name: 'Tricuspidale', full: 'Focolaio tricuspidale',
    where: '4°–5° spazio intercostale, margine sternale inferiore sinistro',
    piece: 'Membrana e campana', preset: 'esteso', view: 'front', x: 161, y: 168,
    position: 'Supino; confronta inspirazione profonda ed espirazione.',
    listen: [
      'Soffio olosistolico da insufficienza tricuspidale che aumenta in inspirazione (segno di Rivero-Carvallo)',
      'S3 / S4 del ventricolo destro',
      'Rullio diastolico da stenosi tricuspidale (raro)',
    ],
  },
  {
    id: 'mitralico', n: 5, name: 'Mitralico', full: 'Focolaio mitralico (punta)',
    where: '5° spazio intercostale, linea emiclaveare sinistra (itto)',
    piece: 'Campana', preset: 'campana', view: 'front', x: 199, y: 183,
    position: 'Supino, poi decubito laterale sinistro; campana appoggiata con pressione leggera.',
    listen: [
      'Intensità di S1',
      'Soffio olosistolico irradiato all\'ascella (insufficienza mitralica) — meglio con la membrana',
      'S3 (sovraccarico di volume, scompenso) e S4 (ipertrofia, ridotta distensibilità) — campana',
      'Schiocco d\'apertura e rullio diastolico con rinforzo presistolico (stenosi mitralica) — campana in decubito laterale sinistro',
    ],
  },
];

export const HEART_TIPS = [
  'Campana: appoggiala con pressione leggera, senza tendere la cute → basse frequenze (20–200 Hz): S3, S4, rullii.',
  'Membrana: premi in modo deciso → frequenze medio-alte (100–1000 Hz): S1, S2, sdoppiamenti, soffi da rigurgito.',
  'Tieni ferma la mano e chiedi al paziente di non parlare durante la registrazione (15 s).',
  'Percorso consigliato: dalla base alla punta (aortico → polmonare → Erb → tricuspidale → mitralico).',
];

export const LUNG_SITES = [
  { id: 'ant-sup-dx', name: 'Anteriore sup. dx', where: '2° spazio intercostale, emiclaveare destra', lobe: 'Lobo superiore destro', view: 'front', x: 104, y: 112, side: 'dx' },
  { id: 'ant-sup-sx', name: 'Anteriore sup. sx', where: '2° spazio intercostale, emiclaveare sinistra', lobe: 'Lobo superiore sinistro', view: 'front', x: 196, y: 108, side: 'sx' },
  { id: 'ant-med-dx', name: 'Anteriore medio dx', where: '4° spazio intercostale, emiclaveare destra', lobe: 'Lobo medio', view: 'front', x: 100, y: 160, side: 'dx' },
  { id: 'ant-med-sx', name: 'Lingula', where: '4°–5° spazio intercostale, ascellare anteriore sinistra', lobe: 'Lingula', view: 'front', x: 224, y: 168, side: 'sx' },
  { id: 'lat-dx', name: 'Laterale dx', where: '6° spazio intercostale, ascellare media destra', lobe: 'Lobo inferiore destro', view: 'front', x: 52, y: 212, side: 'dx' },
  { id: 'lat-sx', name: 'Laterale sx', where: '6° spazio intercostale, ascellare media sinistra', lobe: 'Lobo inferiore sinistro', view: 'front', x: 248, y: 212, side: 'sx' },
  { id: 'post-sup-dx', name: 'Posteriore sup. dx', where: 'Interscapolare destra (T3)', lobe: 'Lobo superiore destro', view: 'back', x: 182, y: 110, side: 'dx' },
  { id: 'post-sup-sx', name: 'Posteriore sup. sx', where: 'Interscapolare sinistra (T3)', lobe: 'Lobo superiore sinistro', view: 'back', x: 118, y: 110, side: 'sx' },
  { id: 'post-med-dx', name: 'Posteriore medio dx', where: 'Sottoscapolare destra (T6–T7)', lobe: 'Lobo inferiore destro', view: 'back', x: 196, y: 180, side: 'dx' },
  { id: 'post-med-sx', name: 'Posteriore medio sx', where: 'Sottoscapolare sinistra (T6–T7)', lobe: 'Lobo inferiore sinistro', view: 'back', x: 104, y: 180, side: 'sx' },
  { id: 'post-inf-dx', name: 'Base dx', where: 'Base posteriore destra (T9–T10)', lobe: 'Lobo inferiore destro', view: 'back', x: 190, y: 246, side: 'dx' },
  { id: 'post-inf-sx', name: 'Base sx', where: 'Base posteriore sinistra (T9–T10)', lobe: 'Lobo inferiore sinistro', view: 'back', x: 110, y: 246, side: 'sx' },
];
LUNG_SITES.forEach((s, i) => { s.n = i + 1; s.full = s.name; s.piece = 'Membrana'; s.preset = 'polmone'; });

export const LUNG_TIPS = [
  'Membrana, ben aderente alla cute nuda (vestiti e peli generano falsi crepitii).',
  'Il paziente respira profondamente a bocca aperta: almeno 1–2 cicli completi per punto (20 s).',
  'Confronta sempre destra e sinistra allo stesso livello, procedendo dall\'alto verso il basso.',
  'Crepitii fini teleinspiratori: fibrosi, scompenso iniziale. Grossolani: secrezioni, bronchiectasie. Sibili: broncostruzione.',
];

export const LUNG_PAIRS = [
  ['ant-sup-dx', 'ant-sup-sx'], ['ant-med-dx', 'ant-med-sx'], ['lat-dx', 'lat-sx'],
  ['post-sup-dx', 'post-sup-sx'], ['post-med-dx', 'post-med-sx'], ['post-inf-dx', 'post-inf-sx'],
];

export function siteById(id) {
  return HEART_SITES.find((s) => s.id === id) || LUNG_SITES.find((s) => s.id === id) || null;
}

export function siteName(id) {
  const s = siteById(id);
  return s ? s.full : 'Punto libero';
}
