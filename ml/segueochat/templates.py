"""Modelli di frase in italiano per Segueo Chat: per ogni testa e valore, tanti modi di dirlo.
Segnaposto: {track} e {track2} (titoli), {genre}, {n} (numero). Un quinto dei modelli di ogni gruppo resta fuori
dall'addestramento (scelto con un hash del testo) e serve a misurare le frasi mai viste."""

T = {
    ('strategy', 'rise'): [
        'più energia', 'alza l\'energia', 'dammi più energia', 'voglio più carica', 'spingi di più', 'fai salire la pista',
        'carica la pista', 'scalda la pista', 'sempre più forte', 'in crescendo', 'energia crescente', 'aumenta l\'energia',
        'più ritmo', 'più grinta', 'falla salire', 'aumenta il tiro', 'vai più su con l\'energia', 'voglio che la serata cresca',
        'portiamo su l\'energia', 'più pompa', 'facciamo salire la festa', 'un po\' più di spinta', 'tira su il ritmo',
        'più adrenalina', 'fai crescere l\'atmosfera', 'partiamo piano e poi saliamo', 'energia in salita', 'sali di energia',
        'più movimento in pista', 'scaldiamo la gente', 'la gente vuole ballare di più', 'dai una svegliata alla pista',
        'alza il livello', 'fai crescere piano piano', 'serve più energia', 'la pista si sta spegnendo, tirala su',
        'aumenta l\'intensità', 'più carico', 'mettiti a spingere', 'fammi ballare di più',
    ],
    ('strategy', 'peak'): [
        'massima energia', 'a tutta', 'a palla', 'tutto al massimo', 'spacca tutto', 'peak time', 'solo pezzi forti',
        'voglio il picco', 'fai esplodere la pista', 'energia al massimo', 'solo bombe', 'dammi il massimo', 'picco di energia',
        'facciamo il botto', 'solo brani carichi', 'vai giù duro', 'senza pietà', 'la pista deve esplodere', 'botta continua',
        'momento clou', 'è il momento di spaccare', 'solo hit potenti', 'tutti i pezzi più forti', 'massimo tiro',
        'adesso si esplode', 'dacci dentro al massimo',
    ],
    ('strategy', 'chill'): [
        'più tranquillo', 'rilassati', 'calma', 'abbassa l\'energia', 'meno energia', 'qualcosa di soft', 'musica rilassata',
        'tranquillizza la pista', 'più morbido', 'fai scendere l\'energia', 'rallenta un po\'', 'atmosfera chill', 'sottofondo',
        'roba da aperitivo', 'più leggero', 'musica di sottofondo', 'calmiamo le acque', 'facciamo respirare la pista',
        'voglio rilassarmi', 'più soft per favore', 'atmosfera lounge', 'scendiamo di intensità', 'meno casino',
        'abbassa i toni', 'qualcosa di delicato', 'musica tranquilla per cena', 'rilassante', 'energia bassa',
        'fai calare la tensione', 'mood rilassato', 'una cosa più chill', 'andiamo più piano',
    ],
    ('strategy', 'wave'): [
        'a onde', 'sali e scendi', 'alterna energia alta e bassa', 'un po\' su e un po\' giù', 'fai onde di energia',
        'un momento carico e uno calmo', 'alterna brani energici e rilassati', 'energia altalenante',
        'alterna momenti carichi e calmi', 'movimento a onde', 'energia che va su e giù', 'alterna pezzi forti e tranquilli',
        'varia l\'energia', 'fai salire e poi scendere', 'onde di energia', 'alti e bassi', 'alterna carica e relax',
    ],
    ('strategy', 'steady'): [
        'mantieni l\'energia', 'resta così', 'energia costante', 'stessa energia', 'non cambiare ritmo',
        'mantieni questo livello', 'tieni questo tiro', 'continua su questa energia', 'energia stabile',
        'non alzare e non abbassare', 'così va bene l\'energia', 'lascia l\'energia com\'è', 'tieni costante',
        'resta su questo livello', 'mantieni il ritmo attuale',
    ],
    ('style', 'bassswap'): [
        'bass swap', 'scambia i bassi', 'mixa con gli eq', 'transizioni con lo scambio dei bassi', 'usa gli equalizzatori',
        'cambi con gli eq', 'scambio di bassi nei mix', 'taglia i bassi quando mixi', 'fai il bass swap',
        'mixa scambiando i bassi', 'passaggi con gli equalizzatori',
    ],
    ('style', 'filter'): [
        'transizioni con il filtro', 'usa il filtro nei mix', 'mixa col filtro', 'cambi filtrati', 'metti il filtro',
        'fai i passaggi col filtro', 'filtra quando cambi', 'usa il passa alto nei mix', 'mix filtrati',
        'transizioni filtrate', 'cambia usando il filtro',
    ],
    ('style', 'echo'): [
        'echo out', 'esci con l\'eco', 'transizioni con l\'eco', 'usa l\'echo', 'chiudi i brani con l\'eco',
        'cambi con effetto eco', 'eco alla fine dei brani', 'fai uscire i pezzi con l\'echo', 'mix con l\'eco',
    ],
    ('style', 'fade'): [
        'dissolvenze', 'sfuma i brani', 'transizioni sfumate', 'cambi morbidi', 'fai le dissolvenze', 'passaggi morbidi',
        'sfumate', 'mix dolci', 'fade tra i brani', 'transizioni delicate', 'cambi graduali', 'fai sfumare un brano nell\'altro',
        'passaggi sfumati', 'dissolvi un pezzo nell\'altro', 'mix morbidi',
    ],
    ('style', 'cut'): [
        'tagli netti', 'stacchi secchi', 'cambi secchi', 'taglio sul beat', 'passa di colpo', 'cambi netti',
        'cut secchi tra i brani', 'entra di botto', 'taglia di netto', 'cambi a taglio', 'stacca secco',
        'passaggi netti senza sfumare',
    ],
    ('style', 'rapid'): [
        'tagli a raffica', 'stile lumix', 'cambi velocissimi', 'cambia brano ogni poche battute', 'mixa veloce come lumix',
        'tanti cambi rapidi', 'brani brevi uno dopo l\'altro', 'raffica di brani', 'fai girare i pezzi velocemente',
        'tagli a raffica stile lum!x', 'un pezzo dopo l\'altro a raffica', 'cambia pezzo spesso e veloce',
    ],
    ('style', 'model'): [
        'stile dance', 'mixa come gabry ponte', 'transizioni dance', 'usa il modello dance', 'cambi in stile dance',
        'fai come un dj dance', 'mix da discoteca commerciale', 'transizioni alla gabry ponte', 'stile da dj dance',
        'usa il modello ai dance',
    ],
    ('style', 'model-techno'): [
        'stile techno', 'transizioni techno', 'mixa come un dj techno', 'usa il modello techno', 'mix lunghi alla techno',
        'cambi da set techno', 'blend lunghi stile techno', 'transizioni da club techno', 'usa il modello ai techno',
        'mixa in stile techno',
    ],
    ('style', 'auto'): [
        'decidi tu le transizioni', 'scegli tu lo stile', 'transizioni automatiche', 'fai tu i cambi', 'come vuoi tu i mix',
        'lascia decidere a te le transizioni', 'stile delle transizioni automatico', 'scegli tu come mixare',
    ],
    ('bars', 'long'): [
        'transizioni lunghe', 'mix più lunghi', 'cambi più lenti', 'allunga i mix', 'fai durare di più i passaggi',
        'blend lunghi', 'prenditi più tempo nei cambi', 'mixa più a lungo', 'transizioni più lunghe', 'passaggi lunghi',
    ],
    ('bars', 'verylong'): [
        'transizioni lunghissime', 'mix molto lunghi', 'cambi lentissimi', 'allunga tantissimo i mix', 'passaggi infiniti',
        'mix lunghissimi', 'transizioni molto molto lunghe',
    ],
    ('bars', 'short'): [
        'transizioni corte', 'mix più brevi', 'cambi veloci', 'accorcia i mix', 'passaggi rapidi', 'mixa più in fretta',
        'cambi più corti', 'transizioni brevi', 'mix corti', 'fai i passaggi più veloci',
    ],
    ('remix', 'on'): [
        'attiva il remix dal vivo', 'accendi il remix', 'fai i remix live', 'metti loop ed effetti sulle frasi',
        'remixa i brani mentre suonano', 'usa il remix', 'voglio il remix dal vivo', 'aggiungi loop e effetti', 'remix live sì',
    ],
    ('remix', 'off'): [
        'spegni il remix', 'niente remix', 'basta remix', 'togli il remix dal vivo', 'non remixare',
        'lascia i brani come sono senza effetti', 'disattiva il remix', 'senza remix', 'niente loop ed effetti',
    ],
    ('mashupOpt', 'on'): [
        'attiva i mashup', 'accendi i mashup automatici', 'fai mashup quando puoi', 'mashup automatici sì',
        'abilita i mashup', 'fai mashup ogni tanto', 'mashup automatici',
    ],
    ('mashupOpt', 'off'): [
        'niente mashup', 'spegni i mashup', 'basta mashup', 'non fare mashup', 'disattiva i mashup', 'senza mashup',
    ],
    ('returnTempo', 'on'): [
        'torna al bpm originale', 'riporta i brani al loro tempo', 'dopo il mix rimetti il tempo originale',
        'ritorna al tempo originale', 'rimetti i bpm originali',
    ],
    ('returnTempo', 'off'): [
        'resta al nuovo bpm', 'non tornare al tempo originale', 'tieni il bpm del mix', 'rimani al tempo nuovo',
        'non riportare i bpm',
    ],
    ('mode', 'queue'): [
        'suona solo la coda', 'segui la coda', 'solo i brani che ho messo in coda', 'rispetta la mia coda',
        'suona solo quello che ho scelto io', 'segui solo la mia lista',
    ],
    ('mode', 'ai'): [
        'scegli tu i brani', 'decidi tu cosa suonare', 'fai tu la scaletta', 'pensaci tu ai brani', 'scegli tu la musica',
        'decidi tu i pezzi', 'mi fido di te per i brani',
    ],
    ('control', 'start'): [
        'parti', 'inizia', 'comincia', 'avvia l\'ai dj', 'vai', 'partiamo', 'fai partire la musica', 'accendi il dj',
        'iniziamo il set', 'dai che si parte', 'attacca', 'metti musica', 'fai partire il set', 'start', 'accendi l\'ai',
        'si comincia', 'fai partire l\'ai dj', 'avvia il set', 'suona tu', 'mixa tu',
    ],
    ('control', 'stop'): [
        'fermati', 'stop', 'ferma tutto', 'spegni l\'ai dj', 'basta così', 'smetti di suonare', 'ferma la musica',
        'stoppa tutto', 'spegni', 'ferma l\'ai', 'blocca tutto', 'fermo',
    ],
    ('control', 'mixNow'): [
        'mixa ora', 'cambia adesso', 'passa al prossimo', 'vai col prossimo brano', 'questo pezzo non mi piace',
        'cambia brano subito', 'anticipa il mix', 'basta con questo pezzo', 'via questo brano', 'next',
        'prossimo brano adesso', 'cambia pezzo', 'questo brano ha stancato', 'togli questo pezzo', 'avanti il prossimo',
    ],
    ('control', 'skip'): [
        'cambia il prossimo', 'non mettere quello dopo', 'scegli un altro prossimo brano', 'il prossimo non mi piace',
        'scarta il prossimo', 'un altro brano dopo questo', 'salta il prossimo', 'il prossimo cambialo',
        'non quello che hai preparato',
    ],
    ('control', 'endAfterCurrent'): [
        'chiudi il set dopo questo', 'ultimo brano', 'finisci dopo questo pezzo', 'dopo questo basta', 'questo è l\'ultimo',
        'chiudiamo con questo brano', 'termina la serata dopo questo', 'fermati dopo questo brano',
        'questo è l\'ultimo pezzo della serata', 'chiudi qui dopo questa canzone', 'con questo pezzo finiamo',
        'finita questa si chiude', 'dopo il brano in onda stop', 'non mettere altro dopo questo',
    ],
    ('control', 'resume'): [
        'continua il set', 'non chiudere', 'vai avanti', 'continua a suonare', 'riprendi il set', 'non fermarti',
        'andiamo avanti', 'non finire ancora',
    ],
    ('queue', 'add'): [
        'metti {track}', 'aggiungi {track}', 'metti in coda {track}', 'voglio sentire {track}', 'accoda {track}',
        'mettimi {track} più tardi', 'aggiungi {track} alla coda', 'poi metti {track}', 'più avanti suona {track}',
        'fammi sentire {track}', 'ci sta {track} in coda', 'metti anche {track}',
    ],
    ('queue', 'playNext'): [
        'metti {track} come prossimo', 'dopo questo metti {track}', 'il prossimo deve essere {track}', 'subito dopo {track}',
        'prossimo brano {track}', 'fai partire {track} dopo questo', 'dopo questo pezzo voglio {track}',
        'come prossimo {track}', 'il prossimo pezzo è {track}',
    ],
    ('queue', 'remove'): [
        'togli {track} dalla coda', 'rimuovi {track} dalla coda', 'non mettere più {track}', 'leva {track} dalla coda',
        'cancella {track} dalla coda',
    ],
    ('queue', 'clear'): [
        'svuota la coda', 'cancella la coda', 'pulisci la coda', 'togli tutto dalla coda', 'azzera la coda',
        'coda vuota', 'elimina tutti i brani in coda',
    ],
    ('queue', 'shuffle'): [
        'mescola la coda', 'metti la coda in ordine casuale', 'rimescola i brani in coda', 'shuffle della coda',
        'coda in ordine sparso',
    ],
    ('genre', 'include'): [
        'solo {genre}', 'suona {genre}', 'voglio {genre}', 'metti {genre}', 'passiamo alla {genre}', 'facciamo {genre}',
        'musica {genre}', 'solo brani {genre}', 'stasera {genre}', 'vai di {genre}', 'dammi {genre}', 'solo pezzi {genre}',
        'soltanto {genre}', 'andiamo di {genre}', 'serata {genre}', 'voglio sentire {genre}',
    ],
    ('genre', 'exclude'): [
        'niente {genre}', 'senza {genre}', 'basta {genre}', 'evita la {genre}', 'no {genre}', 'non voglio {genre}',
        'togli la {genre}', 'odio la {genre}', 'niente più {genre}', 'basta con la {genre}', 'evita i pezzi {genre}',
        'non suonare {genre}', '{genre} no grazie', 'niente di {genre}', 'zero {genre}', 'stop alla {genre}',
        'per stasera niente {genre}', 'non mi va la {genre}', 'lascia perdere la {genre}', 'non mettermi {genre}',
    ],
    ('genre', 'add'): [
        'anche un po\' di {genre}', 'aggiungi anche {genre}', 'mischia con un po\' di {genre}', 'ogni tanto {genre}',
        'anche {genre}', 'più {genre}', 'inserisci qualche pezzo {genre}', 'un po\' di {genre} ci sta',
    ],
    ('genre', 'clear'): [
        'togli i filtri', 'qualsiasi genere', 'tutti i generi', 'va bene ogni genere', 'di tutto un po\'', 'nessun filtro',
        'libera scelta di genere', 'rimuovi i filtri', 'azzera i filtri', 'qualunque genere va bene',
    ],
    ('set', 'build'): [
        'crea una scaletta', 'fammi una scaletta di {n} brani', 'prepara un set', 'costruisci una playlist per stasera',
        'fammi un set di un\'ora', 'genera una scaletta', 'proponimi una lista di brani', 'mi fai un set per un aperitivo',
        'scaletta per una festa', 'organizza la serata con una scaletta', 'prepara la scaletta', 'crea un set di {n} pezzi',
        'fammi una playlist', 'mi prepari una lista di {n} canzoni',
    ],
    ('mashup', 'auto'): [
        'fai un mashup', 'voglio un mashup', 'proponi un mashup', 'unisci voce e base di due pezzi',
        'fammi sentire un mashup', 'crea un mashup', 'prova un mashup', 'mescola due brani in un mashup',
    ],
    ('mashup', 'explicit'): [
        'voce di {track} sulla base di {track2}', 'mashup tra {track} e {track2}', 'metti la voce di {track} su {track2}',
        'base di {track2} con la voce di {track}', 'fai un mashup con la voce di {track} e la base di {track2}',
    ],
    ('info', 'now'): [
        'cosa suoni', 'che brano è', 'cosa sta suonando', 'che pezzo è questo', 'come si chiama questa canzone',
        'chi canta', 'cos\'è questo brano', 'che canzone è', 'cosa stiamo ascoltando', 'chi è l\'artista',
        'titolo del brano', 'che roba è questa',
    ],
    ('info', 'next'): [
        'qual è il prossimo', 'cosa metti dopo', 'che brano viene dopo', 'quando cambi', 'quanto manca al mix',
        'cosa c\'è dopo', 'il prossimo pezzo qual è', 'tra quanto mixi', 'cosa viene dopo', 'che pezzo hai preparato dopo',
        'dopo cosa suoni', 'quale sarà il prossimo brano',
    ],
    ('info', 'why'): [
        'perché', 'perché hai scelto questo brano', 'come mai questo pezzo', 'spiegami la scelta', 'motivo della scelta',
        'perché proprio questo', 'come l\'hai scelto',
    ],
    ('info', 'queue'): [
        'cosa c\'è in coda', 'fammi vedere la coda', 'quali brani hai in coda', 'leggimi la coda', 'com\'è la coda',
        'che pezzi ci sono in coda',
    ],
    ('info', 'settings'): [
        'come stai suonando', 'come sei impostato', 'riepilogo', 'stato del set', 'che impostazioni hai', 'come va il set',
        'dimmi le impostazioni', 'situazione attuale',
    ],
    ('info', 'help'): [
        'aiuto', 'cosa sai fare', 'che comandi ci sono', 'come funzioni', 'istruzioni', 'come ti uso',
        'cosa puoi fare per me', 'elenco dei comandi', 'che cosa capisci', 'dammi qualche esempio',
    ],
    ('view', 'ai'): ['mostrami la vista ai', 'passa alla vista ai', 'schermata ai', 'apri la vista dell\'ai'],
    ('view', 'console'): ['torna alla console', 'mostra la console', 'vista console', 'passa alla console'],
    ('talk', 'hello'): ['ciao', 'buonasera', 'ehi', 'salve', 'buongiorno', 'ciao segueo', 'ehi dj'],
    ('talk', 'thanks'): ['grazie', 'perfetto', 'ottimo lavoro', 'bravo', 'ok grazie', 'grazie mille', 'top', 'fantastico'],
    ('talk', 'offtopic'): [
        'che tempo fa domani', 'quanto fa due più due', 'raccontami una barzelletta', 'chi ha vinto la partita',
        'come stai', 'che ore sono', 'dove si trova roma', 'scrivi una poesia', 'ricordami di comprare il latte',
        'qual è la capitale della francia', 'mi traduci questa frase', 'come si cucina la carbonara',
        'chi è il presidente', 'quanto costa un biglietto', 'parlami di storia', 'hai fame', 'ti piace il calcio',
        'dove abiti', 'quanti anni hai', 'apri il browser', 'manda una mail', 'accendi la luce',
        'meteo di domani', 'dammi le ultime notizie', 'come si fa la pizza', 'risultato della partita di ieri',
        'prenota un tavolo', 'quanto è alto l\'everest', 'spiegami la fisica', 'chi ha scritto la divina commedia',
        'aiutami con i compiti', 'che film danno al cinema', 'come va il traffico', 'imposta una sveglia',
        'dammi la ricetta del tiramisù', 'come si prepara il risotto', 'fammi la lista della spesa', 'scrivimi un elenco di cose da fare',
        'preparami una tabella', 'organizza le mie vacanze', 'crea un promemoria', 'fammi un riassunto del libro',
        'mi prepari un curriculum', 'scrivimi una lettera', 'crea un documento', 'fammi un piano di allenamento',
        'preparami la dieta', 'costruisci un sito', 'genera una password', 'proponimi un film',
    ],
}

# frasi neutre: parlano della serata ma non chiedono niente (non devono far scattare azioni)
NEUTRAL = [
    'la gente sta ballando', 'è mezzanotte', 'c\'è tanta gente', 'bella serata', 'siamo in spiaggia', 'c\'è un compleanno',
    'sono le dieci', 'fa caldo', 'tutti in pista', 'il locale è pieno', 'stasera è sabato', 'ho una festa', 'siamo pochi',
    'c\'è la sposa', 'il capo è contento', 'suona benissimo', 'il volume va bene', 'mi piace', 'questo va bene', 'ci siamo',
    'tra poco arrivano gli ospiti', 'stiamo cenando', 'è un matrimonio', 'è una festa aziendale', 'la pista è piena',
    'sta andando alla grande', 'siamo all\'aperto', 'è appena iniziata la festa', 'sono arrivati tutti', 'è tardi',
    'la gente è stanca', 'siamo in un bar', 'c\'è un dj set dopo', 'stasera c\'è il pienone', 'la musica è bella',
]

# "per i prossimi N brani": solo con opzioni e generi
TEMP_SUFFIX = [
    'per i prossimi {n} brani', 'per un paio di brani', 'solo per il prossimo pezzo', 'per qualche canzone',
    'per le prossime {n} canzoni', 'solo per un po\'', 'per i prossimi {n} pezzi', 'solo per il prossimo brano',
    'per il resto di questo blocco', 'per le prossime tracce',
]
TEMP_HEADS = {'strategy', 'style', 'bars', 'genre', 'remix', 'mashupOpt'}

PREFIX = ['', '', '', 'dai ', 'senti ', 'ok ', 'allora ', 'adesso ', 'ora ', 'per favore ', 'ehi ', 'mi raccomando ', 'ecco ',
          'segueo ', 'dj ']
SUFFIX = ['', '', '', ' per favore', ' grazie', ' dai', ' adesso', ' subito', ' ok?', '!', ' per piacere', ' please']
JOIN = [', ', ' e ', ' e poi ', '. ', ' poi ', ' ma ', ', e ', ' e anche ']

GENRES = ['house', 'techno', 'deep house', 'tech house', 'progressive house', 'melodic techno', 'trance', 'dance', 'pop',
          'hip hop', 'rap', 'drum and bass', 'dubstep', 'disco', 'nu disco', 'funk', 'edm', 'reggaeton', 'latin', 'afro house',
          'minimal', 'electro', 'italo disco', 'commerciale', 'lounge', 'ambient', 'rock', 'r&b', 'soul', 'jazz', 'garage',
          'hardstyle', 'trap', 'eurodance', 'musica anni 90', 'anni 80', 'revival']

# titoli di fantasia per i segnaposto dei brani (il modello impara il contesto, non i nomi)
TITLE_WORDS = ['golden', 'hour', 'night', 'drive', 'glass', 'city', 'northern', 'lights', 'parallel', 'afterglow', 'low',
               'tide', 'open', 'water', 'sunday', 'motion', 'weightless', 'dreams', 'fire', 'love', 'summer', 'sky', 'blue',
               'moon', 'heart', 'forever', 'shadow', 'river', 'electric', 'paradise', 'storm', 'gravity', 'echoes',
               'neon', 'rain', 'sole', 'mare', 'notte', 'estate', 'amore', 'cuore', 'luna', 'vento', 'strada', 'fuoco']


# --- parafrasi generate combinando verbi, oggetti e sinonimi -----------------------------------------------------
def _combos(verbs, objects, fmt='{v} {o}'):
    return [fmt.format(v=v, o=o) for v in verbs for o in objects]


_ENERGY = ['l\'energia', 'il ritmo', 'il tiro', 'la carica', 'l\'intensità', 'il livello', 'la festa', 'la pista', 'il mood',
           'l\'atmosfera', 'la serata']
_BRANO = ['brano', 'pezzo', 'canzone', 'traccia', 'disco']
GRAMMAR = {
    ('strategy', 'rise'): _combos(['alza', 'aumenta', 'tira su', 'porta su', 'fai salire', 'spingi', 'accendi', 'carica', 'scalda',
                                   'ravviva', 'sveglia'], _ENERGY)
    + _combos(['più'], ['energia', 'ritmo', 'carica', 'grinta', 'tiro', 'spinta', 'adrenalina', 'potenza', 'movimento', 'festa', 'cassa'])
    + _combos(['qualcosa di più', 'metti roba più', 'pezzi più', 'musica più'], ['energico', 'carico', 'ballabile', 'movimentato', 'spinto', 'tosto']),
    ('strategy', 'chill'): _combos(['abbassa', 'cala', 'riduci', 'diminuisci', 'smorza', 'rallenta', 'ammorbidisci', 'calma'], _ENERGY)
    + _combos(['più', 'qualcosa di', 'musica', 'roba', 'pezzi', 'metti qualcosa di'], ['tranquillo', 'calmo', 'soft', 'rilassato', 'morbido',
                                                                                        'leggero', 'delicato', 'lento', 'rilassante', 'chill']),
    ('strategy', 'peak'): _combos(['porta al massimo', 'spara al massimo', 'metti a palla', 'massimo con'], _ENERGY)
    + _combos(['solo', 'dammi solo', 'metti solo'], ['pezzi potentissimi', 'brani fortissimi', 'bombe', 'pezzoni', 'hit da pista', 'banger']),
    ('strategy', 'steady'): _combos(['mantieni', 'tieni', 'lascia così', 'non toccare', 'conserva', 'tieni fermo'], _ENERGY),
    ('strategy', 'wave'): _combos(['alterna', 'fai salire e scendere', 'varia', 'fai ondeggiare'], _ENERGY),
    ('style', 'fade'): _combos(['fai', 'usa', 'voglio', 'metti', 'preferisco'], ['dissolvenze', 'sfumate', 'transizioni sfumate', 'cambi morbidi',
                                                                            'passaggi dolci', 'mix graduali', 'dissolvenze lente']),
    ('style', 'cut'): _combos(['fai', 'usa', 'voglio', 'metti', 'preferisco'], ['tagli netti', 'stacchi secchi', 'cambi secchi', 'passaggi netti',
                                                                            'tagli sul battere']),
    ('style', 'filter'): _combos(['fai', 'usa', 'voglio', 'preferisco'], ['transizioni col filtro', 'passaggi filtrati', 'cambi con il filtro',
                                                                     'mix con il filtro passa alto']),
    ('style', 'echo'): _combos(['fai', 'usa', 'voglio', 'preferisco'], ['uscite con l\'eco', 'transizioni con l\'echo', 'cambi con l\'eco']),
    ('bars', 'long'): _combos(['allunga', 'fai più lunghi', 'rendi più lenti', 'prolunga'], ['i mix', 'i cambi', 'i passaggi', 'le transizioni', 'i blend']),
    ('bars', 'short'): _combos(['accorcia', 'fai più corti', 'velocizza', 'riduci'], ['i mix', 'i cambi', 'i passaggi', 'le transizioni']),
    ('control', 'mixNow'): _combos(['cambia', 'togli', 'salta', 'via', 'basta con'], [f'questo {b}' for b in _BRANO])
    + _combos(['passa al', 'vai al', 'metti il'], [f'{b} dopo' for b in _BRANO]),
    ('control', 'skip'): _combos(['cambia', 'scarta', 'non mettere', 'sostituisci'], [f'il prossimo {b}' for b in _BRANO] + [f'il {b} che hai preparato' for b in _BRANO]),
    ('control', 'endAfterCurrent'): _combos(['chiudi con', 'finiamo con', 'ultimo', 'dopo questo', 'basta dopo questo'], _BRANO),
    ('control', 'start'): _combos(['fai partire', 'avvia', 'accendi', 'comincia', 'inizia'], ['la musica', 'il set', 'la serata', 'l\'ai', 'il dj', 'la festa']),
    ('control', 'stop'): _combos(['ferma', 'spegni', 'blocca', 'stoppa', 'interrompi'], ['la musica', 'il set', 'tutto', 'l\'ai', 'il dj']),
    ('info', 'now'): _combos(['che', 'quale', 'come si chiama il', 'chi ha fatto il', 'di chi è il'], [f'{b} è questo' for b in _BRANO[:4]] + ['questo']),
    ('info', 'next'): _combos(['qual è il prossimo', 'che', 'quale'], [f'{b}' for b in _BRANO[:4]]) + _combos(['che', 'quale'], [f'{b} viene dopo' for b in _BRANO[:4]]),
    ('info', 'why'): _combos(['perché hai messo', 'come mai hai scelto', 'perché suoni', 'per quale motivo hai messo'], [f'questo {b}' for b in _BRANO]),
    ('genre', 'exclude'): _combos(['niente', 'basta', 'evita', 'non voglio', 'no alla', 'togli la', 'non suonare'], ['{genre}']),
    ('genre', 'include'): _combos(['solo', 'soltanto', 'voglio solo', 'stasera', 'passa alla', 'cambia genere, metti'], ['{genre}']),
    ('queue', 'add'): _combos(['metti', 'aggiungi', 'suona', 'mettimi', 'voglio', 'più avanti metti'], ['{track}', '{track} in coda', 'anche {track}']),
    ('queue', 'playNext'): _combos(['metti', 'suona', 'fai partire', 'voglio'], ['{track} subito dopo', '{track} come prossimo', '{track} dopo questo']),
}
for _k, _v in GRAMMAR.items():
    T.setdefault(_k, [])
    T[_k] += [x for x in _v if x not in T[_k]]

# frasi neutre generate: pubblico, orari, locale, commenti (non chiedono niente)
_SUBJ = ['la gente', 'il pubblico', 'la sala', 'il locale', 'la pista', 'gli ospiti', 'i ragazzi', 'la sposa', 'il capo', 'tutti',
         'il festeggiato', 'le ragazze', 'i miei amici', 'il proprietario']
_PRED = ['sta ballando', 'è contenta', 'si diverte', 'sta arrivando', 'è stanca', 'sta mangiando', 'è piena', 'è mezza vuota', 'applaude',
         'canta', 'è al bar', 'sta fumando fuori', 'è felice', 'si è seduta', 'sta brindando']
NEUTRAL += [f'{s} {p}' for s in _SUBJ for p in _PRED]
NEUTRAL += ['è presto', 'manca un\'ora alla fine', 'sono le undici', 'è l\'una', 'siamo a metà serata', 'fra poco c\'è la torta',
            'bella questa', 'che bello', 'wow', 'interessante', 'vediamo', 'aspetta', 'un attimo', 'fammi pensare', 'non so',
            'boh', 'mah', 'dunque', 'insomma', 'ci penso', 'forse', 'sto pensando', 'hmm', 'ecco qua', 'c\'è un po\' di vento',
            'piove fuori', 'fa freddo', 'il bar chiude alle due', 'domani lavoro', 'sono un po\' stanco', 'è il mio compleanno']
