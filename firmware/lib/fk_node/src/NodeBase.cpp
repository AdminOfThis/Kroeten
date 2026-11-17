#include "NodeBase.h"

#include <LittleFS.h>
#include <esp_system.h>

#include "Log.h"

#ifndef FK_PIN_RFID_SS
#define FK_PIN_RFID_SS 5
#endif
#ifndef FK_PIN_RFID_RST
#define FK_PIN_RFID_RST 22
#endif
#ifndef FK_PIN_LED
#define FK_PIN_LED 4
#endif
#ifndef FK_PIN_BUZZER
#define FK_PIN_BUZZER 25
#endif
#ifndef FK_LED_COUNT
#define FK_LED_COUNT 24
#endif
#ifndef FK_LED_MAX_BRIGHTNESS
#define FK_LED_MAX_BRIGHTNESS 120
#endif

namespace fk {

namespace {
constexpr size_t TX_QUEUE_MAX = 3000;
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 20000;
constexpr uint32_t SAME_CARD_DEBOUNCE_MS = 2000;
constexpr uint32_t CARD_POLL_MS = 40;
constexpr uint32_t READER_CHECK_MS = 5000;
}  // namespace

NodeBase::NodeBase(uint8_t nodeType)
    : nodeType_(nodeType), ring_(FK_PIN_LED, FK_LED_COUNT, FK_LED_MAX_BRIGHTNESS), buzzer_(FK_PIN_BUZZER) {}

void NodeBase::setup() {
  Serial.begin(115200);
  delay(100);
  FK_LOG("Floetende Kroeten node fw %d, type %u (%s)", FK_FW_VERSION, nodeType_, typeName());

  feedback_.add(&ring_);
  feedback_.add(&buzzer_);
  addFeedbackSinks(feedback_);
  feedback_.begin();
  feedback_.event(FbEvent::Boot);

  if (!LittleFS.begin(true)) FK_LOG("LittleFS mount failed");

  cooldowns_ = new CooldownEntry[COOLDOWN_SLOTS]();
  selfId_ = MeshTransport::deviceId();
  state_.begin();
  applyFeedbackSettings();

  queue_.begin("tx", TX_QUEUE_MAX);
  sender_.begin(&queue_, 4, 2500, 30000, sendQueued, this);

  mesh_.onReceive([this](const RxPacket& p) { onPacket(p); });
  if (!mesh_.begin(selfId_, false)) {
    feedback_.event(FbEvent::Error);
    delay(2000);
    ESP.restart();
  }

  card_.begin(FK_PIN_RFID_SS, FK_PIN_RFID_RST);
  nextHeartbeatMs_ = millis() + 1500 + esp_random() % 2000;
  FK_LOG("node id %08lx ready", (unsigned long)selfId_);
}

void NodeBase::loop() {
  mesh_.loop();

  const bool online = mesh_.gatewayReachable();
  if (online && !wasOnline_) {
    FK_LOG("gateway reachable (distance %u)", mesh_.distance());
    sender_.kick();
    nextHeartbeatMs_ = millis() + 200 + esp_random() % 1500;
  }
  wasOnline_ = online;

  sender_.loop();

  const uint32_t now = millis();
  if (static_cast<int32_t>(now - nextHeartbeatMs_) >= 0) {
    sendHeartbeat();
    nextHeartbeatMs_ = now + HEARTBEAT_INTERVAL_MS + esp_random() % 5000;
  }

  if (now - lastReaderCheckMs_ >= READER_CHECK_MS) {
    lastReaderCheckMs_ = now;
    card_.checkReader();
  }

  if (now - lastCardPollMs_ >= CARD_POLL_MS && card_.readerOk()) {
    lastCardPollMs_ = now;
    CardUid uid;
    if (card_.detect(uid)) processCard(uid);
  }

  updateIdle();
  onLoop();
  feedback_.loop();
}

// ---------------------------------------------------------------------------
// Mesh messages
// ---------------------------------------------------------------------------

void NodeBase::onPacket(const RxPacket& p) {
  switch (p.hdr.type) {
    case PKT_BEACON: {
      if (p.len < sizeof(BeaconPkt)) return;
      BeaconPkt b;
      memcpy(&b, p.payload, sizeof(b));
      state_.setEpoch(b.epoch);
      break;
    }
    case PKT_ACK: {
      if (p.len < 1) return;
      uint8_t count = p.payload[0];
      if (1 + count * sizeof(AckEntry) > p.len) return;
      for (uint8_t i = 0; i < count; i++) {
        AckEntry e;
        memcpy(&e, p.payload + 1 + i * sizeof(AckEntry), sizeof(e));
        if (e.node == selfId_) sender_.onAck(e.seq);
      }
      break;
    }
    case PKT_GAME_CONFIG: {
      if (p.len < sizeof(GameConfigPkt)) return;
      GameConfigPkt cfg;
      memcpy(&cfg, p.payload, sizeof(cfg));
      const uint16_t oldGame = state_.game().gameId;
      const bool hadGame = state_.hasGameConfig();
      if (state_.applyGameConfig(cfg)) {
        if (!hadGame || oldGame != cfg.gameId) clearCooldowns();
        applyFeedbackSettings();
        // Early heartbeat = acknowledgement of the new config (incl. game
        // state) for the server; jittered so all stations don't answer at once.
        heartbeatSoon(1500);
      } else {
        reacknowledge(PKT_GAME_CONFIG, cfg.version);
      }
      break;
    }
    case PKT_NODE_CONFIG: {
      if (p.hdr.dst != selfId_ || p.len < sizeof(NodeConfigPkt)) return;
      NodeConfigPkt cfg;
      memcpy(&cfg, p.payload, sizeof(cfg));
      if (state_.applyNodeConfig(cfg)) {
        heartbeatSoon(500);
      } else {
        reacknowledge(PKT_NODE_CONFIG, cfg.version);
      }
      break;
    }
    case PKT_ADJ_CHUNK: {
      if (p.len < sizeof(AdjChunkHdr)) return;
      AdjChunkHdr hdr;
      memcpy(&hdr, p.payload, sizeof(hdr));
      if (hdr.n > ADJ_PER_CHUNK || sizeof(AdjChunkHdr) + hdr.n * sizeof(AdjEntry) > p.len) return;
      AdjEntry entries[ADJ_PER_CHUNK];
      memcpy(entries, p.payload + sizeof(AdjChunkHdr), hdr.n * sizeof(AdjEntry));
      if (state_.onAdjChunk(hdr, entries)) heartbeatSoon(3000);
      break;
    }
    case PKT_CMD: {
      if (p.hdr.dst != selfId_ || p.len < sizeof(CmdPkt)) return;
      CmdPkt cmd;
      memcpy(&cmd, p.payload, sizeof(cmd));
      if (cmd.cmd == CMD_IDENTIFY) {
        feedback_.event(FbEvent::Identify);
      } else if (cmd.cmd == CMD_REBOOT) {
        FK_LOG("reboot requested");
        delay(200);
        ESP.restart();
      }
      break;
    }
    default:
      break;
  }
}

// Schedules a heartbeat in 300 ms + random jitter (never postpones one that is
// already due earlier).
void NodeBase::heartbeatSoon(uint32_t jitterMs) {
  const uint32_t at = millis() + 300 + esp_random() % jitterMs;
  if (static_cast<int32_t>(nextHeartbeatMs_ - at) > 0) nextHeartbeatMs_ = at;
}

// The server re-sends a config only while our heartbeat still reports an older
// version - so receiving a config we already have means our acknowledgement
// (early heartbeat) was lost. Answer again, at most REACK_MAX times per config
// version and REACK_MIN_GAP_MS apart, which bounds the extra traffic when the
// re-send is meant for another (e.g. offline) station.
void NodeBase::reacknowledge(uint8_t pktType, uint16_t version) {
  constexpr uint8_t REACK_MAX = 3;
  constexpr uint32_t REACK_MIN_GAP_MS = 5000;
  if (pktType != reackType_ || version != reackVersion_) {
    reackType_ = pktType;
    reackVersion_ = version;
    reackCount_ = 0;
  }
  const uint32_t now = millis();
  if (reackCount_ >= REACK_MAX || (reackCount_ > 0 && now - lastReackMs_ < REACK_MIN_GAP_MS)) return;
  reackCount_++;
  lastReackMs_ = now;
  heartbeatSoon(1500);
}

void NodeBase::sendHeartbeat() {
  HeartbeatPkt hb = {};
  hb.nodeType = nodeType_;
  hb.fwVersion = FK_FW_VERSION;
  hb.gameCfgVer = state_.hasGameConfig() ? state_.game().version : 0;
  hb.gameId = state_.hasGameConfig() ? state_.game().gameId : 0;
  hb.nodeCfgVer = state_.hasNodeConfig() ? state_.node().version : 0;
  hb.adjVer = state_.adjVersion();
  hb.queueLen = static_cast<uint16_t>(queue_.pendingCount());
  hb.uptimeSec = millis() / 1000;
  hb.dist = mesh_.distance();
  hb.flags = (state_.hasTime() ? HBF_HAS_TIME : 0) | (card_.readerOk() ? HBF_RFID_OK : 0) |
             (state_.hasGameConfig() ? HBF_HAS_GAME_CFG : 0);
  hb.adjCount = static_cast<uint16_t>(state_.adjCount());
  hb.txCount = txCount_;
  hb.gameState = state_.hasGameConfig() ? state_.game().state : GAME_STATE_NONE;
  hb.cost = mesh_.cost();
  hb.parent = mesh_.parent();

  // Heartbeat + neighbour list for the topology map.
  uint8_t buf[sizeof(HeartbeatPkt) + 1 + HB_MAX_NEIGHBORS * sizeof(HbNeighbor)];
  HbNeighbor nb[HB_MAX_NEIGHBORS];
  const uint8_t count = static_cast<uint8_t>(mesh_.neighbors(nb, HB_MAX_NEIGHBORS));
  memcpy(buf, &hb, sizeof(hb));
  buf[sizeof(hb)] = count;
  memcpy(buf + sizeof(hb) + 1, nb, count * sizeof(HbNeighbor));
  mesh_.send(ADDR_GATEWAY, PKT_HEARTBEAT, buf, sizeof(hb) + 1 + count * sizeof(HbNeighbor));
}

bool NodeBase::sendQueued(const PersistentQueue::Entry& e, void* ctx) {
  auto* self = static_cast<NodeBase*>(ctx);
  if (e.len < 1) return true;
  uint8_t buf[sizeof(RelHeader) + PersistentQueue::MAX_DATA];
  RelHeader rh{self->queue_.stream(), e.seq, e.data[0]};
  memcpy(buf, &rh, sizeof(rh));
  memcpy(buf + sizeof(rh), e.data + 1, e.len - 1);
  return self->mesh_.send(ADDR_GATEWAY, PKT_RELIABLE, buf, sizeof(rh) + e.len - 1);
}

bool NodeBase::enqueueTx(const TxBody& tx) {
  uint8_t buf[1 + sizeof(TxBody)];
  buf[0] = MSG_TX;
  memcpy(buf + 1, &tx, sizeof(tx));
  uint32_t seq = 0;
  if (!queue_.push(buf, sizeof(buf), &seq)) {
    FK_LOG("ERROR: could not queue transaction");
    return false;
  }
  txCount_++;
  return true;
}

// ---------------------------------------------------------------------------
// Card handling
// ---------------------------------------------------------------------------

void NodeBase::processCard(const CardUid& uid) {
  const uint32_t nowMs = millis();
  if (uid == lastUid_ && nowMs - lastUidMs_ < SAME_CARD_DEBOUNCE_MS) {
    lastUidMs_ = nowMs;
    card_.release();
    return;
  }
  lastUid_ = uid;
  lastUidMs_ = nowMs;

  struct Releaser {
    CardStore& c;
    ~Releaser() { c.release(); }
  } releaser{card_};

  if (!state_.hasGameConfig() || state_.game().state != GAME_RUNNING) {
    feedback_.event(FbEvent::NotRunning);
    return;
  }
  if (card_.tech() == CardTech::Unsupported) {
    FK_LOG("unsupported tag type");
    feedback_.event(FbEvent::Error);
    return;
  }
  if (!queue_.canPush()) {
    FK_LOG("transaction queue full!");
    feedback_.event(FbEvent::Error);
    return;
  }
  // Without the correction list of the current card epoch a card could miss
  // its restored balance (after a saved game was loaded) - wait for the sync.
  if (state_.adjGameId() != state_.game().gameId) {
    FK_LOG("correction list for game %u not received yet - tap rejected", state_.game().gameId);
    feedback_.event(FbEvent::NotRunning);
    return;
  }

  CardReadResult rr;
  if (!card_.read(rr)) {
    FK_LOG("card read failed");
    feedback_.event(FbEvent::Error);
    return;
  }

  const uint16_t gameId = state_.game().gameId;
  const bool hasTime = state_.hasTime();
  const uint32_t epoch = state_.epoch();

  TxBody tx = {};
  tx.kind = txKind();
  tx.nodeType = nodeType_;
  tx.uidLen = uid.len;
  memcpy(tx.uid, uid.bytes, uid.len);
  tx.gameId = gameId;
  tx.epoch = epoch;
  tx.uptimeMs = nowMs;
  tx.nodeCfgVer = state_.hasNodeConfig() ? state_.node().version : 0;
  tx.flags = (hasTime ? TXF_HAS_TIME : 0) | (rr.slots < 2 ? TXF_SINGLE_SLOT : 0);

  // Determine the current card state.
  CardRecord before;
  bool fresh = false;
  if (rr.hasRecord && rr.record.gameId == gameId) {
    before = rr.record;
  } else if (rr.hasRecord && static_cast<int16_t>(rr.record.gameId - gameId) > 0) {
    // The card was already used in a newer game: this node has an old config.
    FK_LOG("card from newer game %u (node has %u)", rr.record.gameId, gameId);
    tx.result = TXR_NODE_OUTDATED;
    tx.team = rr.record.team;
    tx.cardCounter = rr.record.counter;
    tx.balanceBefore = tx.balanceAfter = rr.record.points;
    enqueueTx(tx);
    feedback_.event(FbEvent::Error);
    return;
  } else {
    // Blank card or card from an older game: start from zero. The counter
    // continues so the new record always wins over the old slot.
    before = CardRecord::fresh(gameId);
    before.counter = rr.hasRecord ? rr.record.counter : 0;
    fresh = true;
    tx.flags |= TXF_FRESH_CARD;
  }

  CardRecord after = before;

  // 1. Pending corrections (contiguous sequence numbers only).
  if (state_.adjGameId() == gameId) {
    for (;;) {
      const AdjEntry* e = state_.findAdj(uid, after.adjSeq + 1);
      if (!e) break;
      int64_t p = static_cast<int64_t>(after.points) + e->delta;
      after.points = p < 0 ? 0 : (p > INT32_MAX ? INT32_MAX : static_cast<int32_t>(p));
      if (e->team != TEAM_NONE) after.team = e->team;
      after.adjSeq = e->seq;
    }
  }
  const bool adjusted = after.adjSeq != before.adjSeq;
  tx.adjDelta = after.points - before.points;

  // 2. Cooldown.
  const uint16_t cooldownSec = state_.cooldownSec();
  uint32_t cooldownLeftMs = 0;
  if (!state_.enabled()) {
    tx.result = TXR_DISABLED;
  } else if (usesCooldown() && cooldownSec > 0) {
    cooldownLeftMs = cooldownRemainingMs(uid, before, fresh, cooldownSec);
    if (cooldownLeftMs > 0) tx.result = TXR_COOLDOWN;
  }

  // 3. Node type rule.
  int32_t attemptedDelta = 0;  // what the rule wanted to book (for feedback)
  if (tx.result == TXR_OK) {
    TapContext ctx{uid, &after, fresh, hasTime, epoch};
    Decision d = decide(ctx);
    tx.result = d.result;
    attemptedDelta = d.delta;
    if (d.result == TXR_OK) {
      int64_t p = static_cast<int64_t>(after.points) + d.delta;
      if (p < 0) {
        tx.result = TXR_INSUFFICIENT;  // balance can never become negative
      } else {
        after.points = p > INT32_MAX ? INT32_MAX : static_cast<int32_t>(p);
        tx.delta = d.delta;
        after.recordVisit(selfId_, hasTime ? epoch : 0);
      }
    }
  }

  // 4. Write the card if anything changed.
  const bool needWrite = tx.result == TXR_OK || adjusted;
  if (needWrite) {
    after.counter = before.counter + 1;
    after.seal();
    const uint8_t slot = CardStore::targetSlot(rr);
    if (!card_.write(after, slot)) {
      FK_LOG("card write failed");
      tx.result = TXR_WRITE_FAILED;
      tx.delta = 0;
      tx.adjDelta = 0;
      tx.team = before.team;
      tx.adjSeq = before.adjSeq;
      tx.cardCounter = before.counter;
      tx.balanceBefore = tx.balanceAfter = before.points;
      enqueueTx(tx);
      feedback_.event(FbEvent::Error);
      return;
    }
    if (card_.verify(after, slot)) {
      tx.flags |= TXF_VERIFIED;
    } else {
      FK_LOG("card write could not be verified (tag removed?)");
    }
  } else {
    after = before;
    tx.adjDelta = 0;
  }

  tx.team = after.team;
  tx.adjSeq = after.adjSeq;
  tx.cardCounter = after.counter;
  tx.balanceBefore = before.points;
  tx.balanceAfter = after.points;
  enqueueTx(tx);

  FK_LOG("tap %02x%02x%02x%02x.. result=%u delta=%ld adj=%ld balance %ld -> %ld", uid.bytes[0], uid.bytes[1],
         uid.bytes[2], uid.bytes[3], tx.result, (long)tx.delta, (long)tx.adjDelta, (long)tx.balanceBefore,
         (long)tx.balanceAfter);

  // 5. Feedback.
  FbParams fp;
  fp.color = state_.teamColor(after.team);
  fp.delta = tx.delta;
  fp.balance = tx.balanceAfter;
  fp.price = attemptedDelta < 0 ? -attemptedDelta : 0;
  switch (tx.result) {
    case TXR_OK:
      rememberTap(uid);
      feedback_.event(FbEvent::Success, fp);
      break;
    case TXR_COOLDOWN:
      fp.progress = static_cast<float>(cooldownLeftMs) / (cooldownSec * 1000.0f);
      feedback_.event(FbEvent::Cooldown, fp);
      break;
    case TXR_INSUFFICIENT:
      feedback_.event(FbEvent::Insufficient, fp);
      break;
    case TXR_DISABLED:
      feedback_.event(FbEvent::NotRunning, fp);
      break;
    default:
      feedback_.event(FbEvent::Error, fp);
      break;
  }
}

uint32_t NodeBase::cooldownRemainingMs(const CardUid& uid, const CardRecord& card, bool freshCard,
                                       uint16_t cooldownSec) {
  const uint32_t cooldownMs = cooldownSec * 1000UL;
  uint32_t remaining = 0;

  // Local memory (works without wall clock).
  for (size_t i = 0; i < COOLDOWN_SLOTS; i++) {
    const auto& c = cooldowns_[i];
    if (c.used && c.uid == uid) {
      uint32_t elapsed = millis() - c.ms;
      if (elapsed < cooldownMs) remaining = cooldownMs - elapsed;
      break;
    }
  }

  // Visit stored on the card (survives reboots of this node).
  if (!freshCard && state_.hasTime()) {
    uint32_t last = card.lastVisit(selfId_);
    uint32_t now = state_.epoch();
    if (last != 0 && now >= last && now - last < cooldownSec) {
      uint32_t r = (cooldownSec - (now - last)) * 1000UL;
      if (r > remaining) remaining = r;
    }
  }
  return remaining;
}

void NodeBase::rememberTap(const CardUid& uid) {
  constexpr size_t NONE = SIZE_MAX;
  const uint32_t now = millis();
  size_t existing = NONE, freeSlot = NONE, oldest = 0;
  uint32_t oldestAge = 0;
  for (size_t i = 0; i < COOLDOWN_SLOTS; i++) {
    const auto& c = cooldowns_[i];
    if (c.used && c.uid == uid) {
      existing = i;
      break;
    }
    if (!c.used) {
      if (freeSlot == NONE) freeSlot = i;
    } else if (now - c.ms >= oldestAge) {
      oldestAge = now - c.ms;
      oldest = i;
    }
  }
  const size_t target = existing != NONE ? existing : (freeSlot != NONE ? freeSlot : oldest);
  cooldowns_[target] = {uid, now, true};
}

void NodeBase::clearCooldowns() {
  for (size_t i = 0; i < COOLDOWN_SLOTS; i++) cooldowns_[i].used = false;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

void NodeBase::applyFeedbackSettings() {
  if (!state_.hasGameConfig()) return;
  feedback_.setBrightness(state_.game().brightness);
  feedback_.setVolume(state_.game().volume);
  buzzer_.setEnabled(state_.game().flags & GF_BUZZER);
}

void NodeBase::updateIdle() {
  IdleMode mode;
  if (!card_.readerOk()) {
    mode = IdleMode::ReaderError;
  } else if (!state_.hasGameConfig()) {
    mode = IdleMode::NoConfig;
  } else if (!state_.enabled()) {
    mode = IdleMode::Disabled;
  } else {
    switch (state_.game().state) {
      case GAME_RUNNING: mode = IdleMode::Running; break;
      case GAME_PAUSED: mode = IdleMode::Paused; break;
      case GAME_ENDED: mode = IdleMode::Ended; break;
      default: mode = IdleMode::Setup; break;
    }
  }
  feedback_.setIdle(mode, mesh_.gatewayReachable());
}

int16_t NodeBase::typeDataI16(size_t offset, int16_t fallback) const {
  if (!state_.hasNodeConfig()) return fallback;
  const NodeConfigPkt& n = state_.node();
  if (n.nodeType != nodeType_ || offset + 2 > n.typeDataLen) return fallback;
  int16_t v;
  memcpy(&v, n.typeData + offset, 2);
  return v;
}

}  // namespace fk
