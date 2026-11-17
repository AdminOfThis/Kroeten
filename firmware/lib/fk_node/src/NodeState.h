// Persistent node state: game config, node config, pending corrections, clock.
#pragma once

#include <Arduino.h>
#include <Preferences.h>

#include <vector>

#include "CardRecord.h"
#include "Protocol.h"

namespace fk {

class NodeState {
 public:
  void begin();

  // --- game config (broadcast) ---
  bool hasGameConfig() const { return hasGame_; }
  const GameConfigPkt& game() const { return game_; }
  // Returns true if the config changed (any version different from ours is accepted).
  bool applyGameConfig(const GameConfigPkt& cfg);

  // --- node config (unicast) ---
  bool hasNodeConfig() const { return hasNode_; }
  const NodeConfigPkt& node() const { return node_; }
  bool applyNodeConfig(const NodeConfigPkt& cfg);

  uint16_t cooldownSec() const;
  bool enabled() const { return !hasNode_ || (node_.flags & NCF_ENABLED); }
  uint32_t teamColor(uint8_t team) const;

  // --- pending corrections ---
  uint32_t adjVersion() const { return adjVersion_; }
  uint16_t adjGameId() const { return adjGameId_; }
  size_t adjCount() const { return adj_.size(); }
  const AdjEntry* findAdj(const CardUid& uid, uint16_t seq) const;
  // Returns true if a complete new list was committed.
  bool onAdjChunk(const AdjChunkHdr& hdr, const AdjEntry* entries);

  // --- clock ---
  void setEpoch(uint32_t epoch);
  bool hasTime() const { return epochBase_ != 0; }
  uint32_t epoch() const;

 private:
  void loadAdj();
  void saveAdj();

  Preferences prefs_;
  bool hasGame_ = false;
  GameConfigPkt game_ = {};
  bool hasNode_ = false;
  NodeConfigPkt node_ = {};

  uint32_t adjVersion_ = 0;
  uint16_t adjGameId_ = 0;
  std::vector<AdjEntry> adj_;

  // Assembly of an incoming list version.
  uint32_t asmVersion_ = 0;
  uint16_t asmGameId_ = 0;
  uint8_t asmCount_ = 0;
  std::vector<bool> asmHave_;
  std::vector<std::vector<AdjEntry>> asmChunks_;

  uint32_t epochBase_ = 0;
  uint32_t epochBaseMs_ = 0;
};

}  // namespace fk
