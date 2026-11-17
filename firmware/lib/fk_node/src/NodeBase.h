// Common behaviour of all game nodes. A node type derives from NodeBase and
// implements decide(): given the card state, what should happen?
//
// NodeBase takes care of everything else:
//   mesh + persistent queue + retransmission, config handling, card read/write
//   (A/B slots, verification), pending corrections, cooldown, "never negative",
//   transaction logging and feedback.
#pragma once

#include <Arduino.h>

#include "Buzzer.h"
#include "CardStore.h"
#include "Feedback.h"
#include "LedRing.h"
#include "MeshTransport.h"
#include "NodeState.h"
#include "PersistentQueue.h"

namespace fk {

struct TapContext {
  CardUid uid;
  const CardRecord* card;  // after corrections were applied
  bool freshCard;
  bool hasTime;
  uint32_t epoch;
};

struct Decision {
  TxResult result = TXR_OK;
  int32_t delta = 0;
};

class NodeBase {
 public:
  explicit NodeBase(uint8_t nodeType);
  virtual ~NodeBase() = default;

  void setup();
  void loop();

 protected:
  virtual const char* typeName() const = 0;
  virtual Decision decide(const TapContext& ctx) = 0;
  virtual bool usesCooldown() const { return true; }
  virtual uint8_t txKind() const { return TXK_TAP; }
  // Extra feedback outputs of a node type (e.g. a display); called once in setup().
  virtual void addFeedbackSinks(Feedback& feedback) { (void)feedback; }
  // Called on every loop iteration (after the common work).
  virtual void onLoop() {}

  const NodeState& state() const { return state_; }
  uint32_t selfId() const { return selfId_; }

  // Helpers for node type specific config bytes (NodeConfigPkt::typeData).
  int16_t typeDataI16(size_t offset, int16_t fallback) const;

 private:
  void onPacket(const RxPacket& p);
  void processCard(const CardUid& uid);
  bool enqueueTx(const TxBody& tx);
  void sendHeartbeat();
  void heartbeatSoon(uint32_t jitterMs);
  void reacknowledge(uint8_t pktType, uint16_t version);
  void updateIdle();
  void applyFeedbackSettings();

  uint32_t cooldownRemainingMs(const CardUid& uid, const CardRecord& card, bool freshCard, uint16_t cooldownSec);
  void rememberTap(const CardUid& uid);
  void clearCooldowns();

  static bool sendQueued(const PersistentQueue::Entry& e, void* ctx);

  const uint8_t nodeType_;
  uint32_t selfId_ = 0;

  MeshTransport mesh_;
  PersistentQueue queue_;
  ReliableSender sender_;
  NodeState state_;
  CardStore card_;
  Feedback feedback_;
  LedRing ring_;
  Buzzer buzzer_;

  CardUid lastUid_;
  uint32_t lastUidMs_ = 0;
  uint32_t lastCardPollMs_ = 0;
  uint32_t lastReaderCheckMs_ = 0;
  uint32_t nextHeartbeatMs_ = 0;
  // Re-acknowledgement of repeated configs (see reacknowledge()).
  uint8_t reackType_ = 0;
  uint16_t reackVersion_ = 0;
  uint8_t reackCount_ = 0;
  uint32_t lastReackMs_ = 0;
  bool wasOnline_ = false;
  uint32_t txCount_ = 0;

  struct CooldownEntry {
    CardUid uid;
    uint32_t ms;
    bool used;
  };
  static constexpr size_t COOLDOWN_SLOTS = 400;
  CooldownEntry* cooldowns_ = nullptr;  // heap, COOLDOWN_SLOTS entries
};

}  // namespace fk
