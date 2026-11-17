// Registry of node types. Each entry describes the type specific config fields
// (rendered generically in the dashboard) and how they are encoded into
// NodeConfigPkt::typeData. Must match the firmware node classes.

export const NODE_TYPES = {
  1: {
    key: 'points',
    label: 'Punkte-Station',
    letter: 'P', // shown in the station circle on the radio map
    description: 'Jeder Scan gibt (oder kostet) eine feste Anzahl Punkte.',
    firmwareEnv: 'node_points', // PlatformIO environment in firmware/platformio.ini
    fields: [
      {
        key: 'points',
        label: 'Punkte pro Scan',
        hint: 'Negativ = Punkte abziehen (wird abgelehnt, wenn nicht genug Punkte vorhanden)',
        type: 'int',
        min: -30000,
        max: 30000,
        default: 10,
      },
    ],
    // typeData layout: int16 points @0
    encode(cfg) {
      const b = Buffer.alloc(2);
      b.writeInt16LE(clampInt(cfg.points, -30000, 30000, 10), 0);
      return b;
    },
    decode(buf) {
      return { points: buf.length >= 2 ? buf.readInt16LE(0) : 10 };
    },
  },
  2: {
    key: 'lookup',
    label: 'Kontostand-Station',
    letter: 'K',
    description:
      'Zeigt den Punktestand der Karte auf einem Display (SSD1306). Jede Abfrage kostet die in den Spieleinstellungen festgelegten Punkte.',
    firmwareEnv: 'node_lookup',
    usesCooldown: false,
    fields: [], // the price is a game setting (lookupCost), no per-station fields
    encode() {
      return Buffer.alloc(0);
    },
    decode() {
      return {};
    },
  },
};

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function nodeTypeInfo(type) {
  return NODE_TYPES[type] || null;
}

export function defaultTypeConfig(type) {
  const info = nodeTypeInfo(type);
  if (!info) return {};
  return Object.fromEntries(info.fields.map((f) => [f.key, f.default]));
}

export function sanitizeTypeConfig(type, cfg) {
  const info = nodeTypeInfo(type);
  if (!info) return {};
  const out = {};
  for (const f of info.fields) {
    const v = cfg?.[f.key];
    if (f.type === 'int') out[f.key] = clampInt(v, f.min, f.max, f.default);
    else if (f.type === 'bool') out[f.key] = Boolean(v ?? f.default);
    else out[f.key] = v ?? f.default;
  }
  return out;
}

// JSON-friendly description for the dashboard.
export function nodeTypesForClient() {
  return Object.entries(NODE_TYPES).map(([id, t]) => ({
    id: Number(id),
    key: t.key,
    label: t.label,
    letter: t.letter,
    description: t.description,
    fields: t.fields,
    firmwareEnv: t.firmwareEnv,
    usesCooldown: t.usesCooldown !== false,
  }));
}

// Everything that can be flashed from the dashboard.
export function firmwareList() {
  return [
    {
      env: 'gateway',
      label: 'Bridge-Station',
      description: 'Verbindung zwischen Funknetz und PC (per USB am PC angeschlossen).',
      nodeType: null,
    },
    ...Object.entries(NODE_TYPES).map(([id, t]) => ({
      env: t.firmwareEnv,
      label: t.label,
      description: t.description,
      nodeType: Number(id),
    })),
  ];
}
