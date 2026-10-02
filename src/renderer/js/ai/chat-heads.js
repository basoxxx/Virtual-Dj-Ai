// Generato da ml/segueochat/heads.py e train.py: etichette del modello Segueo Chat (nell'ordine delle sue
// uscite) e soglie di confidenza per le parti del messaggio e per il messaggio intero.
export const CHAT_HEADS = {
  "strategy": [
    "none",
    "steady",
    "rise",
    "wave",
    "chill",
    "peak"
  ],
  "style": [
    "none",
    "auto",
    "bassswap",
    "filter",
    "echo",
    "fade",
    "cut",
    "rapid",
    "model",
    "model-techno"
  ],
  "bars": [
    "none",
    "short",
    "long",
    "verylong"
  ],
  "remix": [
    "none",
    "on",
    "off"
  ],
  "mashupOpt": [
    "none",
    "on",
    "off"
  ],
  "returnTempo": [
    "none",
    "on",
    "off"
  ],
  "mode": [
    "none",
    "ai",
    "queue"
  ],
  "control": [
    "none",
    "start",
    "stop",
    "mixNow",
    "skip",
    "endAfterCurrent",
    "resume"
  ],
  "queue": [
    "none",
    "add",
    "playNext",
    "remove",
    "clear",
    "shuffle"
  ],
  "genre": [
    "none",
    "include",
    "exclude",
    "add",
    "clear"
  ],
  "set": [
    "none",
    "build"
  ],
  "mashup": [
    "none",
    "auto",
    "explicit"
  ],
  "info": [
    "none",
    "now",
    "next",
    "why",
    "queue",
    "settings",
    "help"
  ],
  "temporary": [
    "none",
    "yes"
  ],
  "view": [
    "none",
    "ai",
    "console"
  ],
  "talk": [
    "none",
    "hello",
    "thanks",
    "offtopic"
  ]
};

export const CHAT_BUCKETS = 32768;
export const CHAT_MAX_FEATURES = 512;
export const CHAT_THRESHOLDS = {"clause": {"strategy": 1.01, "style": 1.01, "bars": 1.01, "remix": 0.95, "mashupOpt": 0.8, "returnTempo": 0.98, "mode": 1.01, "control": 1.01, "queue": 1.01, "genre": 1.01, "set": 1.01, "mashup": 0.9, "info": 1.01, "temporary": 1.01, "view": 0.9, "talk": 0.8}, "full": {"strategy": 0.99, "style": 0.95, "bars": 0.98, "remix": 0.7, "mashupOpt": 0.98, "returnTempo": 0.9, "mode": 0.9, "control": 0.95, "queue": 0.95, "genre": 0.99, "set": 0.8, "mashup": 0.9, "info": 0.9, "temporary": 0.9, "view": 0.98, "talk": 0.98}};
