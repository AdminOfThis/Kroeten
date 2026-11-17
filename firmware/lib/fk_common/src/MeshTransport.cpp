#include "MeshTransport.h"

#include <WiFi.h>
#include <esp_arduino_version.h>
#include <esp_idf_version.h>
#include <esp_now.h>
#include <esp_system.h>
#include <esp_wifi.h>

#include "Log.h"

#ifndef FK_CHANNEL
#define FK_CHANNEL 1
#endif
#ifndef FK_LONG_RANGE
#define FK_LONG_RANGE 1
#endif
#ifndef FK_TX_POWER
#define FK_TX_POWER 84
#endif
#ifndef FK_MAX_TTL
#define FK_MAX_TTL 10
#endif

namespace fk {

namespace {

struct RxRaw {
  uint8_t mac[6];  // transmitter of this copy (may be a relaying node)
  uint8_t len;
  uint8_t data[ESPNOW_MAX_FRAME];
};

QueueHandle_t g_rxQueue = nullptr;
volatile bool* g_sendBusy = nullptr;
const uint8_t kBroadcastMac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// Runs in the WiFi task: copy the frame and hand it over to loop().
#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onEspNowRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  const uint8_t* mac = info->src_addr;
#else
void onEspNowRecv(const uint8_t* mac, const uint8_t* data, int len) {
#endif
  if (!g_rxQueue || len <= 0 || len > static_cast<int>(ESPNOW_MAX_FRAME)) return;
  RxRaw raw;
  memcpy(raw.mac, mac, 6);
  raw.len = static_cast<uint8_t>(len);
  memcpy(raw.data, data, len);
  xQueueSend(g_rxQueue, &raw, 0);
}

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
void onEspNowSent(const wifi_tx_info_t*, esp_now_send_status_t) {
#else
void onEspNowSent(const uint8_t*, esp_now_send_status_t) {
#endif
  if (g_sendBusy) *g_sendBusy = false;
}

}  // namespace

uint32_t MeshTransport::idFromMac(const uint8_t* mac) {
  uint32_t id = static_cast<uint32_t>(mac[2]) | (static_cast<uint32_t>(mac[3]) << 8) |
                (static_cast<uint32_t>(mac[4]) << 16) | (static_cast<uint32_t>(mac[5]) << 24);
  if (id == ADDR_GATEWAY || id == ADDR_BROADCAST) id ^= 0x5A5A5A5A;
  return id;
}

// The WiFi station MAC is the factory (eFuse) MAC, so a receiver can derive the
// same id from the transmitter address of a frame.
uint32_t MeshTransport::deviceId() {
  uint64_t efuse = ESP.getEfuseMac();
  uint8_t mac[6];
  memcpy(mac, &efuse, 6);  // little-endian: byte 0 = first MAC byte
  return idFromMac(mac);
}

MeshTransport::Neighbor* MeshTransport::noteNeighbor(uint32_t id, uint8_t cost) {
  Neighbor* slot = nullptr;
  Neighbor* freeSlot = nullptr;
  Neighbor* oldest = nullptr;
  for (auto& n : nb_) {
    if (n.used && n.id == id) {
      slot = &n;
      break;
    }
    if (!n.used) {
      if (!freeSlot) freeSlot = &n;
    } else if (!oldest || static_cast<int32_t>(n.lastMs - oldest->lastMs) < 0) {
      oldest = &n;
    }
  }
  if (!slot) {
    // New neighbour; if the table is full, replace the one heard least recently.
    slot = freeSlot ? freeSlot : oldest;
    *slot = Neighbor{};
    slot->used = true;
    slot->id = id;
    slot->rounds = 1;  // the current round counts from now on
  }
  slot->lastMs = millis();
  if (slot->cur < 0xFFFF) slot->cur++;
  slot->cost = cost;
  return slot;
}

// Share of the completed beacon rounds (up to 15) in which the neighbour's
// beacon copy was received. The current round is left out: its copy may still
// arrive.
int MeshTransport::linkQuality(const Neighbor& n) {
  const int completed = n.rounds > 15 ? 15 : static_cast<int>(n.rounds) - 1;
  if (completed <= 0) return -1;
  const uint16_t bits = static_cast<uint16_t>(n.beaconMask >> 1) & static_cast<uint16_t>((1u << completed) - 1);
  return __builtin_popcount(bits) * 100 / completed;
}

// Expected transmissions over a link (x5): 1 / q^2 (both directions assumed
// equal), capped at LINK_COST_MAX. Unknown quality (new neighbour) counts as a
// mediocre link.
uint16_t MeshTransport::linkCost(int quality) {
  if (quality < 0) return 2 * COST_PER_LINK;
  if (quality < 7) return LINK_COST_MAX;
  const uint32_t c = COST_PER_LINK * 10000UL / (static_cast<uint32_t>(quality) * quality);
  return static_cast<uint16_t>(c > LINK_COST_MAX ? LINK_COST_MAX : c);
}

// A beacon copy: starts a new round on the first copy of a beacon sequence
// number, records which neighbour was heard in this round and schedules this
// node's single relay of the beacon (with the route decision).
void MeshTransport::handleBeacon(Neighbor* from, const uint8_t* data, const LinkHeader& hdr, const uint8_t* payload) {
  if (hdr.len < sizeof(BeaconPkt)) return;
  BeaconPkt b;
  memcpy(&b, payload, sizeof(b));
  const bool newRound = !beaconSeqValid_ || b.seq != beaconSeq_;
  if (newRound) {
    const uint16_t gap = beaconSeqValid_ ? static_cast<uint16_t>(b.seq - beaconSeq_) : 1;
    const bool restart = gap > 16;  // gateway restarted (sequence reset) or long silence
    for (auto& n : nb_) {
      if (!n.used) continue;
      if (restart) {
        n.beaconMask = 0;
        n.rounds = 1;
      } else {
        n.beaconMask = static_cast<uint16_t>(n.beaconMask << gap);
        n.rounds = static_cast<uint8_t>(n.rounds + gap > 16 ? 16 : n.rounds + gap);
      }
    }
    beaconSeq_ = b.seq;
    beaconSeqValid_ = true;
    if (!isGateway_) {
      memcpy(beaconFrame_, data, sizeof(beaconFrame_));
      roundPending_ = true;
      roundDueMs_ = millis() + BEACON_RELAY_DELAY_MS + esp_random() % BEACON_RELAY_JITTER_MS;
      if (handler_) {
        RxPacket p{hdr, payload, hdr.len};
        handler_(p);  // wall clock etc., once per round
      }
    }
  }
  if (from) {
    from->beaconMask |= 1;
    from->beaconCost = hdr.senderCost;
    from->beaconHops = hdr.hops;
  }
  if (!isGateway_) lastBeaconMs_ = millis();
}

// Periodic scan (once per beacon round): choose the neighbour with the lowest
// total cost as parent. First only links of at least MIN_GOOD_QUALITY, then any.
// Then relay the beacon with the own cost.
void MeshTransport::decideRoute() {
  Neighbor* best = nullptr;
  uint16_t bestCost = 0xFFFF;
  uint16_t parentCost = 0xFFFF;
  for (int pass = 0; pass < 2 && !best; pass++) {
    for (auto& n : nb_) {
      // Saturated neighbours (COST_MAX) are no usable route: avoids loops.
      if (!n.used || !(n.beaconMask & RECENT_ROUNDS_MASK) || n.beaconCost >= COST_MAX) continue;
      const int q = linkQuality(n);
      if (pass == 0 && q < MIN_GOOD_QUALITY) continue;
      const uint16_t c = static_cast<uint16_t>(n.beaconCost + linkCost(q));
      if (n.id == parent_) parentCost = c;
      if (c < bestCost) {
        bestCost = c;
        best = &n;
      }
    }
  }
  if (!best) return;  // keep the previous route until the beacon timeout
  // Hysteresis: stay with the current parent unless the new one is >10 % better.
  if (best->id != parent_ && parentCost != 0xFFFF && parentCost * 10 <= bestCost * 11) {
    for (auto& n : nb_) {
      if (n.used && n.id == parent_) {
        best = &n;
        bestCost = parentCost;
        break;
      }
    }
  }
  if (best->id != parent_) {
    FK_LOG("route: via %08lx, cost %u.%u, %u hop(s)", (unsigned long)best->id, bestCost / COST_PER_LINK,
           (bestCost % COST_PER_LINK) * 2, best->beaconHops + 1);
  }
  parent_ = best->id;
  cost_ = static_cast<uint8_t>(bestCost > COST_MAX ? COST_MAX : bestCost);
  hops_ = static_cast<uint8_t>(best->beaconHops + 1);

  // Relay the beacon once (not subject to suppression: every node's copy is
  // needed by its neighbours to measure the link).
  if (hops_ >= FK_MAX_TTL) return;
  OutFrame* slot = allocSlot();
  if (!slot) return;
  memcpy(slot->data, beaconFrame_, sizeof(beaconFrame_));
  LinkHeader* h = reinterpret_cast<LinkHeader*>(slot->data);
  h->ttl = static_cast<uint8_t>(FK_MAX_TTL - hops_);
  h->hops = hops_;
  h->senderCost = cost_;
  slot->len = static_cast<uint8_t>(sizeof(LinkHeader) + h->len);
  if (slot->len > sizeof(beaconFrame_)) slot->len = sizeof(beaconFrame_);
  h->len = static_cast<uint8_t>(slot->len - sizeof(LinkHeader));
  slot->isRelay = false;
  slot->dupCount = 0;
  slot->dueMs = millis();
  slot->used = true;
}

void MeshTransport::rotateNeighborWindow() {
  const uint32_t now = millis();
  if (now - nbWindowStartMs_ < NEIGHBOR_WINDOW_MS) return;
  nbWindowStartMs_ = now;
  for (auto& n : nb_) {
    if (!n.used) continue;
    n.prev = n.cur;
    n.cur = 0;
    if (now - n.lastMs > NEIGHBOR_EXPIRE_MS) n.used = false;
  }
}

size_t MeshTransport::neighbors(HbNeighbor* out, size_t max) const {
  size_t count = 0;
  for (const auto& n : nb_) {
    if (!n.used || count >= max) continue;
    uint16_t rate = n.prev > n.cur ? n.prev : n.cur;
    const int q = linkQuality(n);
    out[count++] = HbNeighbor{n.id, static_cast<uint8_t>(rate > 255 ? 255 : rate),
                              static_cast<uint8_t>(q < 0 ? QUALITY_UNKNOWN : q)};
  }
  return count;
}

bool MeshTransport::begin(uint32_t selfId, bool isGateway) {
  selfId_ = selfId;
  isGateway_ = isGateway;
  cost_ = isGateway ? 0 : COST_UNKNOWN;
  hops_ = isGateway ? 0 : DIST_UNKNOWN;

  g_rxQueue = xQueueCreate(24, sizeof(RxRaw));
  g_sendBusy = &sendBusy_;

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_ps(WIFI_PS_NONE);
#if FK_LONG_RANGE
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_LR);
#endif
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(FK_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);
  esp_wifi_set_max_tx_power(FK_TX_POWER);

  if (esp_now_init() != ESP_OK) {
    FK_LOG("esp_now_init failed");
    return false;
  }
  esp_now_register_recv_cb(onEspNowRecv);
  esp_now_register_send_cb(onEspNowSent);

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, kBroadcastMac, 6);
  peer.channel = FK_CHANNEL;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  if (esp_now_add_peer(&peer) != ESP_OK) {
    FK_LOG("esp_now_add_peer failed");
    return false;
  }
  FK_LOG("mesh up: id=%08lx gateway=%d channel=%d lr=%d", (unsigned long)selfId_, isGateway_, FK_CHANNEL,
         FK_LONG_RANGE);
  return true;
}

bool MeshTransport::gatewayReachable() const {
  return isGateway_ || cost_ != COST_UNKNOWN;
}

bool MeshTransport::send(uint32_t dst, uint8_t type, const void* payload, uint8_t len) {
  if (len > MAX_PAYLOAD) return false;
  OutFrame* slot = allocSlot();
  if (!slot) return false;

  LinkHeader h = {};
  h.magic = PROTO_MAGIC;
  h.version = PROTO_VERSION;
  h.type = type;
  h.ttl = FK_MAX_TTL;
  h.hops = 0;
  h.senderCost = cost();
  h.len = len;
  h.src = selfId_;
  h.dst = dst;
  h.pktId = esp_random();

  memcpy(slot->data, &h, sizeof(h));
  if (len) memcpy(slot->data + sizeof(h), payload, len);
  slot->len = sizeof(h) + len;
  slot->isRelay = false;
  slot->dupCount = 0;
  slot->dueMs = millis();
  slot->used = true;
  return true;
}

void MeshTransport::loop() {
  RxRaw raw;
  int budget = 8;
  while (budget-- > 0 && g_rxQueue && xQueueReceive(g_rxQueue, &raw, 0) == pdTRUE) {
    handleFrame(raw.mac, raw.data, raw.len);
  }
  rotateNeighborWindow();
  if (roundPending_ && static_cast<int32_t>(millis() - roundDueMs_) >= 0) {
    roundPending_ = false;
    decideRoute();
  }
  if (!isGateway_ && cost_ != COST_UNKNOWN && millis() - lastBeaconMs_ > BEACON_TIMEOUT_MS) {
    FK_LOG("gateway lost (no beacon)");
    cost_ = COST_UNKNOWN;
    hops_ = DIST_UNKNOWN;
    parent_ = 0;
  }
  transmitDue();
}

void MeshTransport::handleFrame(const uint8_t* mac, const uint8_t* data, int len) {
  if (len < static_cast<int>(sizeof(LinkHeader))) return;
  LinkHeader hdr;
  memcpy(&hdr, data, sizeof(hdr));
  if (hdr.magic != PROTO_MAGIC || hdr.version != PROTO_VERSION) return;
  if (sizeof(LinkHeader) + hdr.len > static_cast<size_t>(len)) return;

  // Every copy counts for the neighbour table, including duplicates: it shows
  // the radio link to the device that transmitted this copy.
  const uint32_t transmitter = idFromMac(mac);
  Neighbor* from = transmitter != selfId_ ? noteNeighbor(transmitter, hdr.senderCost) : nullptr;
  const uint8_t* payload = data + sizeof(LinkHeader);

  // Beacons are handled separately (route measurement, one relay per node).
  // The gateway also counts the relays of its own beacons (link quality).
  if (hdr.type == PKT_BEACON) {
    handleBeacon(from, data, hdr, payload);
    return;
  }
  if (hdr.src == selfId_) return;  // our own frame relayed back

  if (seenBefore(hdr.src, hdr.pktId)) {
    OutFrame* pending = findPendingRelay(hdr.src, hdr.pktId);
    if (pending) {
      if (hdr.dst == ADDR_GATEWAY && hdr.senderCost < cost_) {
        pending->used = false;  // someone closer to the gateway carries it already
      } else {
        pending->dupCount++;
      }
    }
    return;
  }
  framesReceived_++;

  const bool forMe = hdr.dst == ADDR_BROADCAST || hdr.dst == selfId_ || (isGateway_ && hdr.dst == ADDR_GATEWAY);

  bool relay = false;
  if (!isGateway_ && hdr.ttl > 1 && hdr.dst != selfId_) {
    if (hdr.dst == ADDR_GATEWAY) {
      relay = cost_ != COST_UNKNOWN && (hdr.senderCost == COST_UNKNOWN || cost_ < hdr.senderCost);
    } else {
      relay = cost_ == COST_UNKNOWN || hdr.senderCost == COST_UNKNOWN || cost_ > hdr.senderCost;
    }
  }

  if (relay) {
    OutFrame* slot = allocSlot();
    if (slot) {
      size_t total = sizeof(LinkHeader) + hdr.len;
      memcpy(slot->data, data, total);
      LinkHeader* h = reinterpret_cast<LinkHeader*>(slot->data);
      h->ttl = hdr.ttl - 1;
      h->hops = hdr.hops + 1;
      h->senderCost = cost_;
      slot->len = total;
      slot->isRelay = true;
      slot->dupCount = 0;
      slot->dueMs = millis() + 4 + (esp_random() % 37);
      slot->used = true;
    }
  }

  if (forMe && handler_) {
    RxPacket p{hdr, payload, hdr.len};
    handler_(p);
  }
}

bool MeshTransport::seenBefore(uint32_t src, uint32_t pktId) {
  for (size_t i = 0; i < SEEN_SLOTS; i++) {
    if (seen_[i].pktId == pktId && seen_[i].src == src) return true;
  }
  seen_[seenPos_] = {src, pktId};
  seenPos_ = (seenPos_ + 1) % SEEN_SLOTS;
  return false;
}

MeshTransport::OutFrame* MeshTransport::findPendingRelay(uint32_t src, uint32_t pktId) {
  for (auto& s : out_) {
    if (!s.used || !s.isRelay) continue;
    const LinkHeader* h = reinterpret_cast<const LinkHeader*>(s.data);
    if (h->src == src && h->pktId == pktId) return &s;
  }
  return nullptr;
}

MeshTransport::OutFrame* MeshTransport::allocSlot() {
  for (auto& s : out_) {
    if (!s.used) return &s;
  }
  return nullptr;
}

void MeshTransport::transmitDue() {
  const uint32_t now = millis();
  if (sendBusy_) {
    if (now - sendStartedMs_ < 30) return;
    sendBusy_ = false;  // send callback lost, carry on
  }

  OutFrame* best = nullptr;
  for (auto& s : out_) {
    if (!s.used || static_cast<int32_t>(now - s.dueMs) < 0) continue;
    if (!best || static_cast<int32_t>(s.dueMs - best->dueMs) < 0) best = &s;
  }
  if (!best) return;

  if (best->isRelay && best->dupCount >= SUPPRESS_THRESHOLD) {
    best->used = false;  // neighbourhood already covered
    return;
  }

  sendBusy_ = true;
  sendStartedMs_ = now;
  esp_err_t err = esp_now_send(kBroadcastMac, best->data, best->len);
  if (err != ESP_OK) {
    sendBusy_ = false;
    best->dueMs = now + 5;  // e.g. ESP_ERR_ESPNOW_NO_MEM: retry shortly
    return;
  }
  if (best->isRelay) {
    framesRelayed_++;
  } else {
    framesSent_++;
  }
  best->used = false;
}

}  // namespace fk
