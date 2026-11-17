// Main node / gateway.
//
// Responsibilities:
//  * Mesh sink: receives reliable messages from game nodes, persists them in its
//    own queue (LittleFS) and only then ACKs them to the node.
//  * Forwards persisted messages to the PC; deletes them only after the PC has
//    committed them to its database (PC ACK).
//  * Forwards unreliable status frames (heartbeats) to the PC.
//  * Transmits frames the PC asks for (configs, corrections, commands). The
//    gateway does not interpret them - all protocol knowledge for those lives
//    in the PC server and in the nodes.
//  * Sends periodic beacons (wall clock + gradient routing anchor).
#include <Arduino.h>
#include <LittleFS.h>

#include "Hex.h"
#include "Log.h"
#include "MeshTransport.h"
#include "PersistentQueue.h"
#include "Protocol.h"
#include "SerialLink.h"
#include "StatusLight.h"

#ifndef FK_PIN_BRIDGE_LED
#define FK_PIN_BRIDGE_LED 4
#endif
#ifndef FK_BRIDGE_LED_COUNT
#define FK_BRIDGE_LED_COUNT 8
#endif
#ifndef FK_BRIDGE_LED_BRIGHTNESS
#define FK_BRIDGE_LED_BRIGHTNESS 60
#endif

using namespace fk;

namespace {

constexpr uint32_t BEACON_INTERVAL_MS = 5000;
// The server pings every 5 s; without any valid frame for this long the
// server counts as disconnected (status light turns red).
constexpr uint32_t SERVER_TIMEOUT_MS = 12000;
constexpr uint32_t STATUS_INTERVAL_MS = 5000;
constexpr uint32_t ACK_FLUSH_MS = 150;
constexpr size_t UPLINK_QUEUE_MAX = 6000;
constexpr size_t DEDUP_SLOTS = 256;

MeshTransport mesh;
PersistentQueue upQueue;
ReliableSender upSender;
SerialLink serialLink;
StatusLight light(FK_PIN_BRIDGE_LED, FK_BRIDGE_LED_COUNT, FK_BRIDGE_LED_BRIGHTNESS);

uint32_t selfId = 0;
uint16_t beaconSeq = 0;
uint32_t lastBeaconMs = 0;
uint32_t lastStatusMs = 0;

// Wall clock received from the PC.
uint32_t epochBase = 0;
uint32_t epochBaseMs = 0;

uint32_t currentEpoch() {
  if (epochBase == 0) return 0;
  return epochBase + (millis() - epochBaseMs) / 1000;
}

// Recently persisted reliable messages, to avoid queueing retransmissions twice.
struct DedupKey {
  uint32_t node;
  uint32_t stream;
  uint32_t seq;
};
DedupKey dedup[DEDUP_SLOTS] = {};
size_t dedupPos = 0;

bool isDuplicate(uint32_t node, uint32_t stream, uint32_t seq) {
  for (const auto& k : dedup) {
    if (k.node == node && k.stream == stream && k.seq == seq) return true;
  }
  return false;
}

void rememberMessage(uint32_t node, uint32_t stream, uint32_t seq) {
  dedup[dedupPos] = {node, stream, seq};
  dedupPos = (dedupPos + 1) % DEDUP_SLOTS;
}

// Radio traffic report for the dashboard map ("air"): every frame the bridge
// station queues for transmission, and every repeated (duplicate) transaction
// it receives. New transactions, heartbeats etc. reach the PC anyway.
//   {"t":"air","d":"tx","pt":<type>,"dst":<node id | "all">[,"n":[acked node ids]]}
//   {"t":"air","d":"rx","pt":<type>,"node":<id>,"dup":1}
void reportAirTx(uint8_t type, uint32_t dst, const AckPkt* acks = nullptr) {
  JsonDocument doc;
  doc["t"] = "air";
  doc["d"] = "tx";
  doc["pt"] = type;
  if (dst == ADDR_BROADCAST) {
    doc["dst"] = "all";
  } else {
    doc["dst"] = dst;
  }
  if (acks) {
    JsonArray n = doc["n"].to<JsonArray>();
    for (uint8_t i = 0; i < acks->count; i++) n.add(acks->entries[i].node);
  }
  serialLink.send(doc);
}

void reportAirDuplicate(uint8_t type, uint32_t node) {
  JsonDocument doc;
  doc["t"] = "air";
  doc["d"] = "rx";
  doc["pt"] = type;
  doc["node"] = node;
  doc["dup"] = 1;
  serialLink.send(doc);
}

// Batched ACKs to nodes.
AckPkt pendingAcks = {};
uint32_t firstAckMs = 0;

void flushAcks() {
  if (pendingAcks.count == 0) return;
  size_t len = 1 + pendingAcks.count * sizeof(AckEntry);
  if (mesh.send(ADDR_BROADCAST, PKT_ACK, &pendingAcks, len)) {
    reportAirTx(PKT_ACK, ADDR_BROADCAST, &pendingAcks);
    pendingAcks.count = 0;
  }
}

void queueAck(uint32_t node, uint32_t seq) {
  for (uint8_t i = 0; i < pendingAcks.count; i++) {
    if (pendingAcks.entries[i].node == node && pendingAcks.entries[i].seq == seq) return;
  }
  if (pendingAcks.count >= ACK_MAX_ENTRIES) flushAcks();
  if (pendingAcks.count >= ACK_MAX_ENTRIES) return;  // radio busy; node will retry
  if (pendingAcks.count == 0) firstAckMs = millis();
  pendingAcks.entries[pendingAcks.count++] = {node, seq};
}

void sendHello() {
  JsonDocument doc;
  doc["t"] = "hello";
  doc["id"] = selfId;
  doc["fw"] = FK_FW_VERSION;
  doc["ql"] = upQueue.pendingCount();
  serialLink.send(doc);
}

void sendStatus() {
  JsonDocument doc;
  doc["t"] = "gw";
  doc["id"] = selfId;
  doc["fw"] = FK_FW_VERSION;
  doc["ql"] = upQueue.pendingCount();
  doc["up"] = millis() / 1000;
  doc["epoch"] = currentEpoch();
  doc["tx"] = mesh.framesSent();
  doc["rx"] = mesh.framesReceived();
  doc["bad"] = serialLink.badFrames();
  // Devices the bridge node hears directly: [[id, frames per minute, link quality %], ...]
  HbNeighbor nb[HB_MAX_NEIGHBORS];
  size_t count = mesh.neighbors(nb, HB_MAX_NEIGHBORS);
  JsonArray arr = doc["nb"].to<JsonArray>();
  for (size_t i = 0; i < count; i++) {
    JsonArray e = arr.add<JsonArray>();
    e.add(nb[i].id);
    e.add(nb[i].perMin);
    e.add(nb[i].quality);
  }
  serialLink.send(doc);
}

void onMeshPacket(const RxPacket& p) {
  if (p.hdr.dst != ADDR_GATEWAY) return;

  if (p.hdr.type == PKT_RELIABLE) {
    if (p.len < sizeof(RelHeader) || p.len + 4 > PersistentQueue::MAX_DATA) return;
    RelHeader rh;
    memcpy(&rh, p.payload, sizeof(rh));
    if (!isDuplicate(p.hdr.src, rh.stream, rh.seq)) {
      uint8_t buf[PersistentQueue::MAX_DATA];
      memcpy(buf, &p.hdr.src, 4);
      memcpy(buf + 4, p.payload, p.len);
      if (!upQueue.push(buf, 4 + p.len)) {
        FK_LOG("uplink queue full - not acking %08lx/%lu", (unsigned long)p.hdr.src, (unsigned long)rh.seq);
        return;
      }
      rememberMessage(p.hdr.src, rh.stream, rh.seq);
      light.flash();  // one new transaction (retransmissions don't flash)
    } else {
      reportAirDuplicate(PKT_RELIABLE, p.hdr.src);  // retransmission (our ACK was lost)
    }
    queueAck(p.hdr.src, rh.seq);
    return;
  }

  // Everything else is forwarded as-is; the PC decodes it.
  JsonDocument doc;
  doc["t"] = "rx";
  doc["node"] = p.hdr.src;
  doc["pt"] = p.hdr.type;
  doc["hops"] = p.hdr.hops;
  doc["p"] = toHex(p.payload, p.len);
  serialLink.send(doc);
}

bool sendUplink(const PersistentQueue::Entry& e, void*) {
  if (e.len < 4) return true;
  uint32_t node;
  memcpy(&node, e.data, 4);
  JsonDocument doc;
  doc["t"] = "msg";
  doc["q"] = e.seq;
  doc["node"] = node;
  doc["p"] = toHex(e.data + 4, e.len - 4);
  serialLink.send(doc);
  return true;
}

void onSerialMessage(JsonDocument& doc, void*) {
  const char* t = doc["t"] | "";
  if (strcmp(t, "ack") == 0) {
    upSender.onAck(doc["q"].as<uint32_t>());
  } else if (strcmp(t, "time") == 0) {
    uint32_t epoch = doc["epoch"].as<uint32_t>();
    if (epoch > 0) {
      bool first = epochBase == 0;
      epochBase = epoch;
      epochBaseMs = millis();
      if (first) lastBeaconMs = 0;  // distribute the time right away
    }
  } else if (strcmp(t, "send") == 0) {
    uint32_t dst = doc["dst"].is<const char*>() ? ADDR_BROADCAST : doc["dst"].as<uint32_t>();
    uint8_t type = doc["pt"].as<uint8_t>();
    uint8_t payload[MAX_PAYLOAD];
    int len = fromHex(doc["p"] | "", payload, sizeof(payload));
    // The game config carries the game state: shown by the status light.
    if (type == PKT_GAME_CONFIG && len >= static_cast<int>(sizeof(GameConfigPkt))) {
      GameConfigPkt cfg;
      memcpy(&cfg, payload, sizeof(cfg));
      light.setGameState(cfg.state);
    }
    if (len < 0 || !mesh.send(dst, type, payload, static_cast<uint8_t>(len))) {
      FK_LOG("send failed (type %u, len %d)", type, len);
    } else {
      reportAirTx(type, dst);
    }
  } else if (strcmp(t, "hello") == 0) {
    sendHello();
    upSender.kick();
  }
}

}  // namespace

void setup() {
  serialLink.begin(115200, onSerialMessage, nullptr);
  light.begin();
  delay(200);
  FK_LOG("Floetende Kroeten gateway fw %d", FK_FW_VERSION);

  if (!LittleFS.begin(true)) {
    FK_LOG("LittleFS mount failed");
  }
  selfId = MeshTransport::deviceId();
  upQueue.begin("up", UPLINK_QUEUE_MAX);
  upSender.begin(&upQueue, 8, 1500, 10000, sendUplink, nullptr);

  mesh.onReceive(onMeshPacket);
  if (!mesh.begin(selfId, true)) {
    FK_LOG("mesh init failed - restarting");
    delay(2000);
    ESP.restart();
  }
  sendHello();
}

void loop() {
  serialLink.loop();
  mesh.loop();
  upSender.loop();
  light.setConnected(serialLink.lastRxMs() != 0 && millis() - serialLink.lastRxMs() < SERVER_TIMEOUT_MS);
  light.loop();

  const uint32_t now = millis();
  if (pendingAcks.count > 0 && now - firstAckMs >= ACK_FLUSH_MS) flushAcks();

  if (lastBeaconMs == 0 || now - lastBeaconMs >= BEACON_INTERVAL_MS) {
    BeaconPkt b{currentEpoch(), beaconSeq++};
    if (mesh.send(ADDR_BROADCAST, PKT_BEACON, &b, sizeof(b))) reportAirTx(PKT_BEACON, ADDR_BROADCAST);
    lastBeaconMs = now | 1;
  }
  if (now - lastStatusMs >= STATUS_INTERVAL_MS) {
    lastStatusMs = now;
    sendStatus();
  }
}
