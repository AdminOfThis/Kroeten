# Flötende Kröten – RFID mesh game

Players tap RFID cards on game stations (ESP32 + RC522) to collect – or spend –
points. The **card is the source of truth** for each player's balance; every
transaction is also sent through a wireless mesh to a **bridge node**, which
forwards it over USB to a PC. The PC stores everything in SQLite and serves a
live dashboard (German UI).

```
 Game node ──┐  ESP-NOW flooding mesh       ┌─────────────┐  USB serial   ┌───────────────────────┐
 Game node ──┼──── (multi-hop, LR mode) ───►│ Bridge node │◄─────────────►│ PC server (Node.js)   │
 Game node ──┘                              │  (gateway)  │  framed+ACKed │ SQLite · REST · WS    │
                                            └─────────────┘               │ Dashboard :8080       │
                                                                          └───────────────────────┘
```

**Quick start without hardware:**

```sh
cd server
npm install
npm run sim        # simulated bridge node, 16 stations, 50 cards
```

Then open <http://localhost:8080> and set the game state in the header to *Läuft*.

---

## Repository layout

| Path | Content |
|---|---|
| `firmware/` | PlatformIO project (Arduino framework, ESP32 DevKit 38 pin) |
| `firmware/lib/fk_common/` | Shared by all devices: wire protocol, ESP-NOW mesh, persistent queue |
| `firmware/lib/fk_node/` | Game node base: card storage, LED ring, buzzer, config, `NodeBase` |
| `firmware/src/gateway/` | Bridge node firmware (PlatformIO env `gateway`) |
| `firmware/src/nodes/` | Node types (currently `PointsNode`) |
| `server/src/` | PC server: serial bridge, game logic, saved games, REST API, simulator, flasher |
| `server/public/` | Dashboard (plain HTML/CSS/JS, no build step) |
| `server/test/` | Unit and integration tests (`npm test`) |
| `server/data/` | Databases (created at runtime, not in git) |

## Reliability design

* **Card first.** A tap is only counted once the new record is written to the
  card. The record exists twice on the card (slot A/B, CRC protected); a write
  always targets the older slot, so pulling the card away mid-write never
  destroys the previous balance. Every write is read back and verified.
* **Queue first.** Every transaction is appended to a power-loss safe queue in
  flash (LittleFS) *before* it is sent. It is only deleted after an end-to-end
  ACK:
  1. game node → bridge node: ACK after the bridge node has persisted it in *its* queue,
  2. bridge node → PC: ACK after the SQLite commit.
* **Idempotent.** Each message carries `(node, stream, seq)`; retransmissions are
  de-duplicated by the bridge node and the DB (`UNIQUE` constraint).
* **Late data is safe.** The DB keeps the balance with the highest card write
  counter, so transactions from a station that was offline for an hour don't
  overwrite newer balances. They are even filed into the right game if another
  game has been loaded in the meantime.
* **Self-healing config.** Stations report the versions of their game config,
  station config and correction list in a heartbeat (every 20 s; a station counts
  as offline after 60 s without one). The server
  re-sends whatever is out of date – quickly at first (after 2.5 s, 2.5 s,
  then 4 s, 6 s and every 8 s from then on, per config version), so a lost
  frame costs only a few seconds while a station that is really gone does not
  flood the radio.
* **Game state acknowledgement.** The heartbeat also carries the game state the
  station currently applies. After a new game config a station answers with an
  early (jittered) heartbeat, so a pause/resume is confirmed within ~2 s.
  If the config or that heartbeat is lost, the server re-sends the config (see
  above, first after 2.5 s); a station that receives a config version it
  already has answers again with an early heartbeat (at most 3 times per
  version, 5 s apart), so a lost confirmation is repaired within seconds instead
  of waiting for the regular heartbeat (20 s). Same for the station config. Each
  station's confirmation is logged, plus one summary entry once all stations
  that were online at the change have confirmed.
* **Balances never go negative.** A station that costs points rejects the scan
  if the card has too few points ("Zu wenig Punkte").

### Why ESP-NOW instead of painlessMesh

With 30–40 nodes outdoors, painlessMesh (WiFi AP/STA tree) tends to rebuild its
tree frequently, with multi-second gaps. ESP-NOW is connectionless: every frame
is broadcast and forwarded by neighbours (de-duplicated, TTL limited). Air time
is kept low by **gradient routing by route cost** and **duplicate suppression**:

* The bridge node sends a beacon every 5 s (one "round"); every station relays
  each beacon exactly once and announces its own route cost.
* From these copies each station knows, per neighbour, in how many of the last
  16 rounds it heard it: the **link quality** q.
* Every round each station re-evaluates its neighbours (periodic scan) and
  picks the one with the lowest *neighbour cost + 1/q²* (ETX, expected
  transmissions) as its route – links below 30 % only as fallback, with 10 %
  hysteresis against flapping. A strong 2-hop path therefore beats a weak
  direct link, and routes adapt when links change.
* Upstream frames are only forwarded by devices with a lower cost than the
  transmitter, downstream frames only by devices with a higher cost.
* Costs travel in the link header in units of 0.2 ETX (one link at most 20),
  protocol version 2: **all devices (bridge node included) must run the same
  firmware version.**
 *Long Range*
mode (`FK_LONG_RANGE=1`) increases range at a lower data rate. **All devices
must use the same `FK_LONG_RANGE` and `FK_CHANNEL` setting.**

### Point corrections ("pending")

Corrections made in the dashboard are not written to the DB balance directly.
They are numbered per player (1, 2, 3…), broadcast to all stations, and applied
by the **next station the card is tapped on**. The card stores the highest
applied number, so a correction can never be applied twice, even if two
stations hold the list. Balances are clamped at 0. Team assignments and the
restore after loading a saved game use the same mechanism.

---

## Hardware

### Wiring (game node)

| Part | Pin | ESP32 |
|---|---|---|
| RC522 | SDA / SS | GPIO 5 |
| | SCK | GPIO 18 |
| | MOSI | GPIO 23 |
| | MISO | GPIO 19 |
| | RST | GPIO 22 |
| | 3.3V / GND | 3V3 / GND (**not 5 V!**) |
| | IRQ | not connected |
| WS2812B ring (24) | DIN | GPIO 4 (via ~330 Ω resistor) |
| | 5V / GND | 5 V supply, common GND with ESP32 |
| Passive buzzer (debug) | + / − | GPIO 25 / GND |

Notes:
* Put a 470–1000 µF capacitor across the ring's 5 V/GND. 3.3 V data usually
  works; if the ring flickers, add a level shifter (e.g. 74AHCT125).
* Brightness is capped in firmware (`FK_LED_MAX_BRIGHTNESS=120`); a 5 V / 2 A
  power bank is plenty.
* ESP32-WROOM-32**U**: always connect the external antenna before powering up.
* Pins are build flags in `firmware/platformio.ini`.
* **WS2812 data pins must be output-capable.** GPIO 34–39 (e.g. GPIO 36 /
  SENSOR_VP) are input-only on the ESP32 and cannot drive LEDs.

### Wiring (bridge node)

The bridge node is an ESP32 connected to the PC via USB, with an optional
status light:

| Part | Pin | ESP32 |
|---|---|---|
| WS2812B strip/ring (8) | DIN | GPIO 4 (via ~330 Ω resistor) |
| | 5V / GND | USB 5 V (VIN) / GND |

| Light | Meaning |
|---|---|
| steady, colour = game state | connected to the PC server (it pings every 5 s): blue *Vorbereitung*, green *Läuft* (also before the first game config), amber *Pausiert*, red *Beendet* – taken from the game config the server sends |
| red blinking (1 Hz) | no server connection for 12 s |
| white flash | a new transaction arrived from a station |

Pin, LED count and brightness are build flags of the `gateway` environment
(`FK_PIN_BRIDGE_LED`, `FK_BRIDGE_LED_COUNT`, `FK_BRIDGE_LED_BRIGHTNESS`).

### Additional wiring (Kontostand-Station / balance lookup)

| Part | Pin | ESP32 |
|---|---|---|
| SSD1306 OLED 128×64 (I2C, address 0x3C) | SDA | GPIO 21 |
| | SCL | GPIO 17 (GPIO 22 is the RC522 reset) |
| | VCC / GND | 3V3 / GND |

Everything else (RC522, ring, buzzer) is wired like a normal game node.

### Supported cards

MIFARE Classic Mini/1K/4K (default transport key `FFFFFFFFFFFF`, sectors 1 and 2
are used) and MIFARE Ultralight / NTAG21x (pages 4–27). Tags with only 48 bytes
of user memory get a single slot; the transaction is marked "①" in the log
(not tear-safe). Existing data in those areas is overwritten.

---

## Firmware

Requires [PlatformIO](https://platformio.org/) (VS Code extension or
`pip install platformio`). Firmware can also be flashed from the dashboard
(see [Flashing from the dashboard](#flashing-from-the-dashboard)).

```sh
cd firmware
pio run -e gateway -t upload        # bridge node
pio run -e node_points -t upload    # game node (points / shop)
pio run -e node_lookup -t upload    # Kontostand-Station (balance lookup with OLED)
pio device monitor                  # debug output (115200 baud)
```

Each device gets a unique ID derived from its MAC address; stations register
automatically and appear in the dashboard. The first build downloads the ESP32
toolchain (a few hundred MB).

### LED ring states

| Ring | Meaning |
|---|---|
| purple dot circling | no game config received yet |
| blue breathing | game in preparation |
| green breathing | game running |
| blue + 4 white dots | paused |
| dim red | game ended |
| amber dot circling (overlay) | bridge node not reachable – taps still work and are queued |
| fast red blinking | RC522 not responding |
| wipe in team colour | points booked (also for purchases) |
| orange arc | cooldown, arc = remaining time |
| red blinking | not enough points |
| red/white flashing | error (read/write, unsupported card) |
| blue blinking (2×) on scan | game not running, station disabled, or correction list of the current game not received yet |
| rainbow | "Finden" (identify) from the dashboard |

### Node types

| Type | Firmware env | Behaviour |
|---|---|---|
| **Punkte-Station** (1) | `node_points` | Each scan books a configurable amount of points per station; negative amounts make it a shop (rejected if the card has too few points). Cooldown per card and station; the duration is one game-wide setting (Spieleinstellungen → Node-Einstellungen), not settable per station. |
| **Kontostand-Station** (2) | `node_lookup` | Shows the card's balance on an SSD1306 OLED. Each lookup costs the game-wide *Kosten pro Kontoabfrage* (Spieleinstellungen → Node-Einstellungen, 0 = free). With too few points the lookup is rejected without revealing the balance. No cooldown. Logged as "Kontoabfrage". |

### Adding a node type

1. Create `firmware/src/nodes/MyNode.h` deriving from `NodeBase`, implement `decide()`.
2. Add a `case` in `NodeFactory.cpp` and a value in `NodeType` (`Protocol.h`).
3. Add an environment in `platformio.ini` with `-DFK_NODE_TYPE=<n>`.
4. Describe its config fields, `typeData` encoding and `firmwareEnv` in
   `server/src/nodeTypes.js`; the dashboard renders the settings form and offers
   the firmware for flashing automatically.

---

## PC server

Requires Node.js ≥ 22.13 (uses the built-in `node:sqlite`).

```sh
cd server
npm install
npm start                 # real hardware: auto-detects the bridge node on USB
npm start -- --port COM5  # or a fixed serial port
npm run dev               # like npm start, restarts automatically on code changes
npm run sim               # simulation (no hardware), restarts automatically on code changes
npm test
```

| Option | Default | Meaning |
|---|---|---|
| `--http <port>` | `8080` (or `PORT`) | Dashboard port |
| `--port <COMx>` | auto (or `FK_SERIAL_PORT`) | Serial port of the bridge node |
| `--data <dir>` | `server/data` (simulation: `server/data/sim`) | Data directory |
| `--sim` | – | Use the simulator instead of a serial port |
| `--sim-nodes <n>` | `16` | Simulated stations |
| `--sim-players <n>` | `50` | Simulated cards |
| `--sim-seed <n>` | `1` | Different seed = different stations, cards and site |

Environment: `FK_DEBUG=1` prints the bridge node's debug output,
`FK_PIO` / `FK_FIRMWARE_DIR` configure flashing (see below).

**Bridge node auto-detection:** USB serial ports of known chips (CP210x, CH340,
FTDI, Espressif) are opened one after another; a port only counts as the bridge
node once it answers with a valid frame. A station plugged in for flashing is
therefore never mistaken for it.

A database of the former single-game version (`data/game.db` /
`data/simulation.db`) is imported once as "Importiertes Spiel"; the original
file is left untouched.

---

## Dashboard

The header shows the active game, its state (switchable from every page), the
connection to the bridge node (yellow *Simulation verbunden* in simulation
mode), stations online and the number of players. Clicking *Flötende Kröten*
returns to the monitoring page.

| URL | Page | Content |
|---|---|---|
| `/` (also `/monitoring`) | **Monitoring** | Home page: key figures, radio map with traffic pulses (scans as dots in team colour – grey without a team – station → bridge; everything else in grey: every frame the bridge station transmits – game config incl. state changes, station config, corrections, commands (large dots), ACKs for scans (small dots), the beacon every 5 s (tiny dots) – and, towards the bridge, every heartbeat (incl. state confirmations) and every repeated scan whose ACK was lost (small dots); links keep their quality colour), team chart, top 10 players, live transactions |
| `/score` | **Rangliste** | Animated team bar chart, team and player leaderboards |
| `/players` | **Spieler** | Search, edit name/team/notes, point corrections |
| `/transactions` | **Transaktionen** | Full log with filters, CSV export |
| `/stations` | **Stationen** | Radio map, station list incl. bridge node, per-station settings, find/reboot, remove stale stations |
| `/settings` | **Spieleinstellungen** | Collapsible sections: station settings, teams, bridge node, node types & firmware flashing |
| `/games` | **Spiele** | New game, load, rename, save copy, delete, view leaderboard of saved games |

### Game states

| State | Scans | Notes |
|---|---|---|
| **Vorbereitung** | rejected | New games start here. The only state in which teams can be edited. Cannot be re-entered once left. |
| **Läuft** | **points are booked** | |
| **Pausiert** | rejected | Temporary break. A running game is paused automatically when another game is loaded; a loaded game always starts paused, and a game that was running when the server stopped is paused on the next server start (logged as "Server gestartet"). |
| **Beendet** | rejected | Final state for the scoreboard; can be switched back to *Läuft*. |

In all states buffered transactions keep arriving and corrections can be made.

### Monitoring

* **Key figures:** game state, bridge node, stations online, players, total
  points, transactions (total / last 5 min), messages still buffered.
* **Radio map:** see [Topology map](#topology-map). Every transaction travels as
  a dot in the player's team colour from the station hop by hop along the radio
  route to the bridge node (rejected scans ripple red).
* On wide screens (> 1400 px) the page fills the window: map, scores and the
  live transaction column have the same height and reach the bottom of the
  screen.

### Topology map

Every device keeps a table of the devices it hears directly (derived from the
transmitter MAC of each received frame, counted per minute). Stations send it
with their heartbeat, the bridge node with its status report. The map shows the
bridge node in the centre, stations on rings by hop count and a line for every
radio link, coloured by link quality: green ≥ 80 %, amber, red < 50 %, dashed =
heard in one direction only. **Thick lines are the routes the stations chose**
(station → its parent); transaction pulses follow them. The thin lines are
fallback routes (links currently not used); the checkbox *Ausweichrouten* hides
them (remembered in the browser). The tooltip of a
station shows hops, route cost and the next station; the station list shows the
route cost below the hop count. When another game is loaded (or a new one
created) the map starts again with the automatic layout; the button
*Mesh zurücksetzen* (Monitoring and Stationen) does the same at any time. Links between two stations are slightly curved so they never
lie on top of each other; links to the bridge node are straight. The letter in
a station is its type (B bridge, P Punkte-Station, K Kontostand-Station; the
hop count is in the tooltip), a dashed ring means buffered transactions. Stations
can be dragged (positions are stored in the browser), a click opens the
station settings.
Stations are coloured by the game state they report (same colours as the
header's state switch: blue Vorbereitung, green Läuft, amber Pausiert, red
Beendet); offline stations are hollow and dashed, showing their last reported
state. The bridge station is always blue with an extra ring.

### Transaction log & filters

Besides card transactions the log contains:

* **Spielereignisse** (blue): state changes, game created, game loaded,
  stations confirming a game state (and "confirmed by all stations"),
  stations that seem offline (no heartbeat for 60 s) or are reachable again,
  bridge node connected / disconnected, and ESPs flashed from the dashboard
  (incl. failed or cancelled uploads).
  Shown in the normal list and the live feed. Offline events are only logged
  while the bridge node is connected.
* **Manuelle Änderungen** (yellow, audit log): every change made in the
  dashboard – player name/team/notes, point corrections, station settings,
  find/reboot, removed stations, node settings, teams, game renamed, copy
  saved. Stored on the server only (never sent to the stations) and shown
  **only** with this filter.

Neither counts as a transaction in the key figures.

### Teams

Every player always belongs to a team. A new card is put into the team with the
fewest players (random on a tie); players of a removed team are redistributed
the same way. The team colour is written to the card with the next scan and
shown on the LED ring.

### Stations

Stations register automatically. *Veraltete entfernen* removes all stations
that have not sent a heartbeat for 5 minutes (their transactions stay in the
log; a station that comes back later re-registers with default settings).

### Saved games

Every game is its own SQLite file in `data/games/` (listed in
`data/library.db`) and is saved continuously – there is no save button.
Typical flow: set the game to *Pausiert* → *Spiele* → load another game or
create a new one → later load the first game again and set it to *Läuft*.
*Kopie speichern* creates a snapshot of the current game; *Rangliste* shows the
scoreboard of a saved game without loading it.

Because the same cards are used in every game, loading a game allocates a new
**card epoch** (the game id on the card). Cards from another epoch are treated
as blank, and each player's saved balance and team are written back on the
first scan through a "restore" correction (applied exactly once). Stations
reject scans until they have received the correction list of the current epoch.

Station settings describe the hardware and follow the active game.

### Flashing from the dashboard

*Spieleinstellungen → Node-Typen & Firmware* lists all node types and builds and
uploads any firmware to an ESP32 on a USB port of the PC. The timestamped output
appears in a centred window (on every page) with *Abbrechen* while flashing and
*Schließen* once finished.

* PlatformIO is located automatically: `FK_PIO`, `pio` on the PATH, the VS Code
  PlatformIO install, the Scripts folders of the installed Python (where
  `pip install platformio` puts it, e.g. Microsoft Store Python), or
  `python -m platformio`.
* The firmware project is expected at `../firmware` (override with `FK_FIRMWARE_DIR`).
* While a port is being flashed the bridge link does not touch it; flashing the
  bridge node itself pauses the connection.
* Settings and buffered transactions on the device are kept.

---

## Simulator

`npm run sim` replaces the serial port with a simulated bridge node and
stations. It speaks exactly the same protocol, so the whole server is
exercised:

* **16 stations** on a virtual site, placed as a branched chain: 1 to ~6 hops to
  the bridge node. Eleven give 10–25 points, **four are shops** (Kiosk −20,
  Laden −40, Schatzkammer −80, Tauschbörse −30) and one is a
  **Kontostand-Station** (Info-Säule). Names and prices are applied
  to newly registered stations (and to stations from earlier runs that were
  never edited). Heartbeat every 20 s like the firmware.
* **50 cards**; about a quarter of all scans happen at shops and the balance
  station, about one in eight of those by a player who cannot afford it ("Zu wenig Punkte",
  roughly 3 % of all scans).
* **Outages:** every 3 min there is a 35 % chance that a station drops out –
  mostly 20–45 s (below the offline limit, only visible as buffered
  transactions), rarely 1.5–3 min (shown as offline, about once per hour);
  one at a time.
  Stations behind a failed relay lose their connection too unless another route
  exists. Their scans are buffered and arrive late.
* **Two flaky stations** far out have weak links, lose many frames and deliver
  with delay.
* About 5 % of frames to stations are lost (exercises the re-sync) and about 0.3 %
  of card writes fail.
* **Radio mesh per game:** the site layout (and therefore the mesh) is derived
  from the game's card epoch – every new or loaded game gets a different mesh,
  the same game keeps its mesh across restarts. Most links are good (~95 %),
  about one in seven is an outlier (55–85 %), the flaky stations are poor;
  link qualities drift slightly every 30 s (people, weather) and the stations re-pick their routes like the
  firmware (every 10 s in the simulator), so routes change during a game.
* The simulated bridge station reports its transmissions (beacons, ACKs,
  server frames) like the firmware; about 2 % of ACKs are lost (30 % at the
  flaky stations), so the station retransmits and the duplicate is reported.
* Station IDs and cards are generated from a seed (`--sim-seed`), so a
  restart reuses them; the virtual card contents are kept in
  `data/sim/sim-cards.json`. Delete `data/sim` (server stopped) for a fresh
  simulation.

---

## Protocol

`firmware/lib/fk_common/src/Protocol.h` and `server/src/protocol.js` define the
same binary structures (little-endian, packed) and must be changed together.
The serial link uses lines of the form `@<json>*<crc16>`; lines starting with
`#` are debug output.

## Development

* `npm test` runs the server tests (protocol codec, game logic, saved games).
* `npm run sim` / `npm run dev` restart the server automatically when files in
  `server/src` change; dashboard changes only need a browser reload.
* Firmware: `pio run` builds both environments (`gateway`, `node_points`).
