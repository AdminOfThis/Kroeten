// ESP-NOW based flooding mesh.
//
// Every frame is broadcast at MAC level. Devices forward frames they have not
// seen before (de-duplicated by src + pktId) with a TTL. To keep air time low
// with 30-40 nodes, forwarding is restricted:
//
//  * Gradient routing by route cost (ETX): the gateway sends a beacon every
//    5 s (one "round"). Every node relays each beacon exactly once, announcing
//    its own route cost. From the beacon copies it receives, a node knows per
//    neighbour in how many of the last 16 rounds it heard that neighbour
//    (link quality q). Each round it re-evaluates all neighbours ("periodic
//    scan") and picks the one with the lowest
//        neighbour cost + 1 / q^2   (expected transmissions over that link)
//    as its parent, with a small hysteresis against flapping. Weak links are
//    only used if nothing better exists. Upstream frames (to the gateway) are
//    only forwarded by devices with a lower cost than the copy's transmitter,
//    downstream frames only by devices with a higher cost.
//  * Counter-based suppression: forwarding is delayed by a random jitter. If
//    enough other devices forward the same frame in the meantime, the forward
//    is cancelled.
//
// Delivery is best-effort. Reliability is provided one layer up by the
// persistent queue + end-to-end ACKs.
#pragma once

#include <Arduino.h>
#include <functional>

#include "Protocol.h"

namespace fk {

struct RxPacket {
  LinkHeader hdr;
  const uint8_t* payload;
  uint8_t len;
};

class MeshTransport {
 public:
  using Handler = std::function<void(const RxPacket&)>;

  bool begin(uint32_t selfId, bool isGateway);
  void loop();

  // Queue a new frame for transmission. Returns false if the TX queue is full.
  bool send(uint32_t dst, uint8_t type, const void* payload, uint8_t len);

  void onReceive(Handler h) { handler_ = std::move(h); }

  uint32_t selfId() const { return selfId_; }
  // Hop count of the chosen route (for display), route cost and parent.
  uint8_t distance() const { return isGateway_ ? 0 : hops_; }
  uint8_t cost() const { return isGateway_ ? 0 : cost_; }
  uint32_t parent() const { return isGateway_ ? 0 : parent_; }
  bool gatewayReachable() const;
  uint32_t lastBeaconMs() const { return lastBeaconMs_; }

  // Statistics
  uint32_t framesSent() const { return framesSent_; }
  uint32_t framesRelayed() const { return framesRelayed_; }
  uint32_t framesReceived() const { return framesReceived_; }

  // Devices heard directly (any frame, also duplicates), for the topology map.
  size_t neighbors(HbNeighbor* out, size_t max) const;

  static uint32_t deviceId();
  // Device id of a transmitter, derived from its MAC like deviceId().
  static uint32_t idFromMac(const uint8_t* mac);

 private:
  struct Neighbor {
    bool used = false;
    uint32_t id = 0;
    uint32_t lastMs = 0;
    uint16_t cur = 0;   // frames in the current 60 s window
    uint16_t prev = 0;  // frames in the previous window
    uint8_t cost = COST_UNKNOWN;        // route cost it announced (last frame)
    uint16_t beaconMask = 0;            // bit i: its beacon copy heard i rounds ago (bit 0 = current)
    uint8_t rounds = 0;                 // beacon rounds observed since first heard (max 16)
    uint8_t beaconCost = COST_UNKNOWN;  // cost announced in its latest beacon copy
    uint8_t beaconHops = 0;             // relays of that copy (its own hop count)
  };
  static constexpr size_t MAX_NEIGHBORS = HB_MAX_NEIGHBORS;
  static constexpr uint32_t NEIGHBOR_WINDOW_MS = 60000;
  static constexpr uint32_t NEIGHBOR_EXPIRE_MS = 150000;

  Neighbor* noteNeighbor(uint32_t id, uint8_t cost);
  void rotateNeighborWindow();

  // Routing (see top of file).
  void handleBeacon(Neighbor* from, const uint8_t* data, const LinkHeader& hdr, const uint8_t* payload);
  void decideRoute();
  static int linkQuality(const Neighbor& n);  // 0-100, -1 = not enough data
  static uint16_t linkCost(int quality);

  Neighbor nb_[MAX_NEIGHBORS];
  uint32_t nbWindowStartMs_ = 0;

  struct OutFrame {
    bool used = false;
    bool isRelay = false;
    uint32_t dueMs = 0;
    uint8_t dupCount = 0;
    uint8_t len = 0;
    uint8_t data[ESPNOW_MAX_FRAME];
  };

  static constexpr size_t OUT_SLOTS = 16;
  static constexpr size_t SEEN_SLOTS = 96;
  static constexpr uint8_t SUPPRESS_THRESHOLD = 2;
  static constexpr uint32_t BEACON_TIMEOUT_MS = 30000;
  static constexpr uint32_t BEACON_RELAY_DELAY_MS = 20;   // + random jitter
  static constexpr uint32_t BEACON_RELAY_JITTER_MS = 80;
  static constexpr int MIN_GOOD_QUALITY = 30;  // % - weaker links only as fallback
  static constexpr uint8_t RECENT_ROUNDS_MASK = 0x7;  // candidate if heard in the last 3 rounds

  void handleFrame(const uint8_t* mac, const uint8_t* data, int len);
  bool seenBefore(uint32_t src, uint32_t pktId);
  OutFrame* findPendingRelay(uint32_t src, uint32_t pktId);
  OutFrame* allocSlot();
  void transmitDue();

  uint32_t selfId_ = 0;
  bool isGateway_ = false;
  uint8_t cost_ = COST_UNKNOWN;
  uint8_t hops_ = DIST_UNKNOWN;
  uint32_t parent_ = 0;
  bool roundPending_ = false;  // beacon relay + route decision due at roundDueMs_
  uint32_t roundDueMs_ = 0;
  uint8_t beaconFrame_[sizeof(LinkHeader) + sizeof(BeaconPkt)] = {};
  uint16_t beaconSeq_ = 0;
  bool beaconSeqValid_ = false;
  uint32_t lastBeaconMs_ = 0;

  struct Seen {
    uint32_t src;
    uint32_t pktId;
  };
  Seen seen_[SEEN_SLOTS] = {};
  size_t seenPos_ = 0;

  OutFrame out_[OUT_SLOTS];
  volatile bool sendBusy_ = false;
  uint32_t sendStartedMs_ = 0;

  uint32_t framesSent_ = 0;
  uint32_t framesRelayed_ = 0;
  uint32_t framesReceived_ = 0;

  Handler handler_;
};

}  // namespace fk
