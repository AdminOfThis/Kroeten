#include "NodeState.h"

#include <LittleFS.h>

#include "Crc.h"
#include "Log.h"

namespace fk {

namespace {
const char* ADJ_PATH = "/adj.bin";
const char* ADJ_TMP = "/adj.tmp";

struct __attribute__((packed)) AdjFileHeader {
  uint32_t version;
  uint16_t gameId;
  uint16_t count;
};
}  // namespace

void NodeState::begin() {
  prefs_.begin("fk", false);
  if (prefs_.getBytesLength("game") == sizeof(GameConfigPkt)) {
    prefs_.getBytes("game", &game_, sizeof(game_));
    hasGame_ = true;
  }
  if (prefs_.getBytesLength("node") == sizeof(NodeConfigPkt)) {
    prefs_.getBytes("node", &node_, sizeof(node_));
    hasNode_ = true;
  }
  loadAdj();
  FK_LOG("state: game=%d (v%u, id %u, state %u) node=%d (v%u) adj v%lu (%u entries)", hasGame_, game_.version,
         game_.gameId, game_.state, hasNode_, node_.version, (unsigned long)adjVersion_, (unsigned)adj_.size());
}

bool NodeState::applyGameConfig(const GameConfigPkt& cfg) {
  if (hasGame_ && memcmp(&cfg, &game_, sizeof(cfg)) == 0) return false;
  if (hasGame_ && cfg.version == game_.version) return false;
  game_ = cfg;
  if (game_.teamCount > MAX_TEAMS) game_.teamCount = MAX_TEAMS;
  hasGame_ = true;
  prefs_.putBytes("game", &game_, sizeof(game_));
  FK_LOG("game config v%u: game %u state %u cooldown %us", game_.version, game_.gameId, game_.state,
         game_.defaultCooldownSec);
  return true;
}

bool NodeState::applyNodeConfig(const NodeConfigPkt& cfg) {
  if (hasNode_ && cfg.version == node_.version) return false;
  node_ = cfg;
  node_.name[NODE_NAME_LEN - 1] = '\0';
  if (node_.typeDataLen > NODE_TYPE_DATA_LEN) node_.typeDataLen = NODE_TYPE_DATA_LEN;
  hasNode_ = true;
  prefs_.putBytes("node", &node_, sizeof(node_));
  FK_LOG("node config v%u: '%s' enabled=%d cooldown=%u", node_.version, node_.name, enabled(), node_.cooldownSec);
  return true;
}

uint16_t NodeState::cooldownSec() const {
  if (hasNode_ && node_.cooldownSec != COOLDOWN_USE_DEFAULT) return node_.cooldownSec;
  return hasGame_ ? game_.defaultCooldownSec : 0;
}

uint32_t NodeState::teamColor(uint8_t team) const {
  if (!hasGame_ || team == TEAM_NONE || team >= game_.teamCount) return 0x00FF00;
  const uint8_t* c = game_.teamColors[team];
  uint32_t color = (static_cast<uint32_t>(c[0]) << 16) | (static_cast<uint32_t>(c[1]) << 8) | c[2];
  return color == 0 ? 0xFFFFFF : color;
}

const AdjEntry* NodeState::findAdj(const CardUid& uid, uint16_t seq) const {
  for (const auto& e : adj_) {
    if (e.seq == seq && e.uidLen == uid.len && memcmp(e.uid, uid.bytes, uid.len) == 0) return &e;
  }
  return nullptr;
}

bool NodeState::onAdjChunk(const AdjChunkHdr& hdr, const AdjEntry* entries) {
  if (hdr.version == adjVersion_ && hdr.gameId == adjGameId_) return false;  // already have it
  if (hdr.count == 0 || hdr.index >= hdr.count) return false;

  if (hdr.version != asmVersion_ || hdr.gameId != asmGameId_ || hdr.count != asmCount_) {
    asmVersion_ = hdr.version;
    asmGameId_ = hdr.gameId;
    asmCount_ = hdr.count;
    asmHave_.assign(hdr.count, false);
    asmChunks_.assign(hdr.count, {});
  }
  if (asmHave_[hdr.index]) return false;
  asmHave_[hdr.index] = true;
  asmChunks_[hdr.index].assign(entries, entries + hdr.n);

  for (bool have : asmHave_) {
    if (!have) return false;
  }

  adj_.clear();
  for (const auto& chunk : asmChunks_) adj_.insert(adj_.end(), chunk.begin(), chunk.end());
  adjVersion_ = asmVersion_;
  adjGameId_ = asmGameId_;
  asmChunks_.clear();
  asmHave_.clear();
  asmVersion_ = 0;
  asmCount_ = 0;
  saveAdj();
  FK_LOG("corrections v%lu: %u entries", (unsigned long)adjVersion_, (unsigned)adj_.size());
  return true;
}

void NodeState::loadAdj() {
  File f = LittleFS.open(ADJ_PATH, "r");
  if (!f) return;
  AdjFileHeader h;
  bool ok = f.read(reinterpret_cast<uint8_t*>(&h), sizeof(h)) == sizeof(h);
  std::vector<AdjEntry> entries;
  if (ok) {
    entries.resize(h.count);
    size_t bytes = h.count * sizeof(AdjEntry);
    ok = bytes == 0 || f.read(reinterpret_cast<uint8_t*>(entries.data()), bytes) == bytes;
  }
  uint32_t crc = 0;
  if (ok) ok = f.read(reinterpret_cast<uint8_t*>(&crc), 4) == 4;
  f.close();
  if (ok) {
    uint32_t c = crc32(reinterpret_cast<const uint8_t*>(&h), sizeof(h)) ^
                 crc32(reinterpret_cast<const uint8_t*>(entries.data()), entries.size() * sizeof(AdjEntry));
    ok = c == crc;
  }
  if (!ok) {
    FK_LOG("corrections file corrupt - waiting for resync");
    return;
  }
  adjVersion_ = h.version;
  adjGameId_ = h.gameId;
  adj_ = std::move(entries);
}

void NodeState::saveAdj() {
  AdjFileHeader h{adjVersion_, adjGameId_, static_cast<uint16_t>(adj_.size())};
  uint32_t crc = crc32(reinterpret_cast<const uint8_t*>(&h), sizeof(h)) ^
                 crc32(reinterpret_cast<const uint8_t*>(adj_.data()), adj_.size() * sizeof(AdjEntry));
  File f = LittleFS.open(ADJ_TMP, "w");
  if (!f) return;
  f.write(reinterpret_cast<const uint8_t*>(&h), sizeof(h));
  if (!adj_.empty()) f.write(reinterpret_cast<const uint8_t*>(adj_.data()), adj_.size() * sizeof(AdjEntry));
  f.write(reinterpret_cast<const uint8_t*>(&crc), 4);
  f.close();
  LittleFS.rename(ADJ_TMP, ADJ_PATH);
}

void NodeState::setEpoch(uint32_t epoch) {
  if (epoch == 0) return;
  epochBase_ = epoch;
  epochBaseMs_ = millis();
}

uint32_t NodeState::epoch() const {
  if (!epochBase_) return 0;
  return epochBase_ + (millis() - epochBaseMs_) / 1000;
}

}  // namespace fk
