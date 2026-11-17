// Wire protocol shared by gateway and all node types.
//
// IMPORTANT: server/src/protocol.js mirrors every struct in this file.
// Any change here must be reflected there (all values little-endian, packed).
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace fk {

constexpr uint8_t PROTO_MAGIC = 0xF7;
constexpr uint8_t PROTO_VERSION = 2;  // 2: ETX route cost instead of hop distance

constexpr uint32_t ADDR_GATEWAY = 0x00000000;
constexpr uint32_t ADDR_BROADCAST = 0xFFFFFFFF;

constexpr uint8_t DIST_UNKNOWN = 0xFF;

// Route cost (ETX, expected transmissions to the gateway) in units of 0.2: a
// perfect link costs COST_PER_LINK, a link that delivers only half of the
// frames costs 4x as much (1 / q^2), one link at most LINK_COST_MAX. Gateway = 0.
constexpr uint8_t COST_UNKNOWN = 0xFF;
constexpr uint8_t COST_MAX = 0xFE;
constexpr uint8_t COST_PER_LINK = 5;
constexpr uint8_t LINK_COST_MAX = 100;
constexpr uint8_t QUALITY_UNKNOWN = 0xFF;

constexpr size_t ESPNOW_MAX_FRAME = 250;

// Node types. Each type has its own firmware environment (FK_NODE_TYPE) and its
// own layout of NodeConfigPkt::typeData (documented in the node class and in
// server/src/nodeTypes.js).
enum NodeType : uint8_t {
  NODE_POINTS = 1,  // tap -> add/subtract a configurable amount of points
  NODE_LOOKUP = 2,  // tap -> pay GameConfigPkt::lookupCost, show balance on an SSD1306
};

// ---------------------------------------------------------------------------
// Link layer header (flooding mesh)
// ---------------------------------------------------------------------------
struct __attribute__((packed)) LinkHeader {
  uint8_t magic;       // PROTO_MAGIC
  uint8_t version;     // PROTO_VERSION
  uint8_t type;        // PktType
  uint8_t ttl;         // decremented on every relay
  uint8_t hops;        // number of relays so far
  uint8_t senderCost;  // route cost (ETX x5) of the device that transmitted this copy
  uint8_t len;         // payload length
  uint8_t reserved;
  uint32_t src;        // originating device id
  uint32_t dst;        // ADDR_GATEWAY, ADDR_BROADCAST or a node id
  uint32_t pktId;      // random per transmission attempt, used for flood de-duplication
};
static_assert(sizeof(LinkHeader) == 20, "LinkHeader size");

constexpr size_t MAX_PAYLOAD = ESPNOW_MAX_FRAME - sizeof(LinkHeader);  // 230

enum PktType : uint8_t {
  PKT_BEACON = 1,       // gateway -> all     : BeaconPkt
  PKT_RELIABLE = 2,     // node -> gateway    : RelHeader + body (queued, ACKed)
  PKT_ACK = 3,          // gateway -> all     : AckPkt (batched)
  PKT_HEARTBEAT = 4,    // node -> gateway    : HeartbeatPkt
  PKT_GAME_CONFIG = 5,  // gateway -> all     : GameConfigPkt
  PKT_NODE_CONFIG = 6,  // gateway -> node    : NodeConfigPkt
  PKT_ADJ_CHUNK = 7,    // gateway -> all     : AdjChunkHdr + AdjEntry[n]
  PKT_CMD = 8,          // gateway -> node    : CmdPkt
};

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------
struct __attribute__((packed)) BeaconPkt {
  uint32_t epoch;  // unix time in seconds, 0 = unknown (PC not connected yet)
  uint16_t seq;
};
static_assert(sizeof(BeaconPkt) == 6, "BeaconPkt size");

// Reliable messages carry a per-node stream id + sequence number. The stream id
// is random and created once per flash (NVS), so (node, stream, seq) is unique
// forever and the server can de-duplicate retransmissions.
struct __attribute__((packed)) RelHeader {
  uint32_t stream;
  uint32_t seq;
  uint8_t msgType;  // MsgType
};
static_assert(sizeof(RelHeader) == 9, "RelHeader size");

enum MsgType : uint8_t {
  MSG_TX = 1,  // TxBody
};

struct __attribute__((packed)) AckEntry {
  uint32_t node;
  uint32_t seq;
};
struct __attribute__((packed)) AckPkt {
  uint8_t count;
  AckEntry entries[28];
};
constexpr size_t ACK_MAX_ENTRIES = 28;
static_assert(sizeof(AckPkt) <= MAX_PAYLOAD, "AckPkt size");

enum TxKind : uint8_t {
  TXK_TAP = 1,
  TXK_LOOKUP = 2,  // balance lookup at a NODE_LOOKUP station
};

enum TxResult : uint8_t {
  TXR_OK = 0,
  TXR_COOLDOWN = 1,
  TXR_INSUFFICIENT = 2,
  TXR_WRITE_FAILED = 3,
  TXR_NODE_OUTDATED = 4,  // card belongs to a newer game than the node knows
  TXR_DISABLED = 5,
};

enum TxFlags : uint8_t {
  TXF_VERIFIED = 0x01,    // card write was read back and matched
  TXF_HAS_TIME = 0x02,    // epoch field is valid
  TXF_FRESH_CARD = 0x04,  // card was blank / from an older game
  TXF_SINGLE_SLOT = 0x08, // card has no room for A/B copies (not tear-safe)
};

struct __attribute__((packed)) TxBody {
  uint8_t kind;  // TxKind
  uint8_t result;  // TxResult
  uint8_t flags;   // TxFlags
  uint8_t nodeType;
  uint8_t uidLen;
  uint8_t uid[10];
  uint8_t team;  // team stored on card (0xFF = none)
  uint16_t gameId;
  uint32_t cardCounter;  // card write counter after this transaction
  int32_t delta;         // points from the node rule itself
  int32_t adjDelta;      // points from pending corrections applied in this tap
  uint16_t adjSeq;       // highest correction seq on the card after this tap
  int32_t balanceBefore;
  int32_t balanceAfter;
  uint32_t epoch;     // node wall clock (valid if TXF_HAS_TIME)
  uint32_t uptimeMs;
  uint16_t nodeCfgVer;
};
static_assert(sizeof(TxBody) == 50, "TxBody size");

enum HbFlags : uint8_t {
  HBF_HAS_TIME = 0x01,
  HBF_RFID_OK = 0x02,
  HBF_HAS_GAME_CFG = 0x04,
};

struct __attribute__((packed)) HeartbeatPkt {
  uint8_t nodeType;
  uint16_t fwVersion;
  uint16_t gameCfgVer;
  uint16_t gameId;
  uint16_t nodeCfgVer;
  uint32_t adjVer;
  uint16_t queueLen;
  uint32_t uptimeSec;
  uint8_t dist;
  uint8_t flags;  // HbFlags
  uint16_t adjCount;
  uint32_t txCount;  // transactions recorded since boot
  uint8_t gameState;  // GameState the node currently applies, GAME_STATE_NONE without config
  uint8_t cost;       // route cost to the gateway (ETX x5), COST_UNKNOWN = no route
  uint32_t parent;    // neighbour the route goes through (gateway id for 1 hop), 0 = none
};
static_assert(sizeof(HeartbeatPkt) == 33, "HeartbeatPkt size");

// The heartbeat is followed by: uint8_t count; HbNeighbor[count]
// (radio neighbours heard directly, used for the topology map).
struct __attribute__((packed)) HbNeighbor {
  uint32_t id;     // device id of the neighbour (bridge node included)
  uint8_t perMin;   // frames heard from it per minute (saturates at 255)
  uint8_t quality;  // share of beacon rounds its beacon copy was received, 0-100 (QUALITY_UNKNOWN)
};
static_assert(sizeof(HbNeighbor) == 6, "HbNeighbor size");
constexpr uint8_t HB_MAX_NEIGHBORS = 16;

enum GameState : uint8_t {
  GAME_SETUP = 0,
  GAME_RUNNING = 1,
  GAME_PAUSED = 2,
  GAME_ENDED = 3,
};
constexpr uint8_t GAME_STATE_NONE = 0xFF;  // heartbeat: no game config received yet

constexpr uint8_t MAX_TEAMS = 16;
constexpr uint8_t TEAM_NONE = 0xFF;

enum GameFlags : uint8_t {
  GF_BUZZER = 0x01,
};

struct __attribute__((packed)) GameConfigPkt {
  uint16_t version;
  uint16_t gameId;
  uint8_t state;  // GameState
  uint8_t brightness;
  uint16_t defaultCooldownSec;
  uint8_t flags;  // GameFlags
  uint8_t teamCount;
  uint8_t teamColors[MAX_TEAMS][3];
  uint8_t volume;  // 0-100, used by all sound sinks (buzzer, later sound module)
  uint16_t lookupCost;  // points charged per balance lookup (NODE_LOOKUP)
};
static_assert(sizeof(GameConfigPkt) == 61, "GameConfigPkt size");

constexpr uint16_t COOLDOWN_USE_DEFAULT = 0xFFFF;
constexpr size_t NODE_NAME_LEN = 20;
constexpr size_t NODE_TYPE_DATA_LEN = 32;

enum NodeCfgFlags : uint8_t {
  NCF_ENABLED = 0x01,
};

struct __attribute__((packed)) NodeConfigPkt {
  uint16_t version;
  uint8_t nodeType;  // type the config was written for
  uint8_t flags;     // NodeCfgFlags
  uint16_t cooldownSec;  // COOLDOWN_USE_DEFAULT = use game default
  char name[NODE_NAME_LEN];
  uint8_t typeDataLen;
  uint8_t typeData[NODE_TYPE_DATA_LEN];  // node type specific (see nodes/*)
};
static_assert(sizeof(NodeConfigPkt) == 59, "NodeConfigPkt size");

// Pending point corrections / team assignments, broadcast as a versioned list.
struct __attribute__((packed)) AdjChunkHdr {
  uint32_t version;
  uint16_t gameId;
  uint8_t index;
  uint8_t count;  // total number of chunks of this version
  uint8_t n;      // entries in this chunk
};
static_assert(sizeof(AdjChunkHdr) == 9, "AdjChunkHdr size");

struct __attribute__((packed)) AdjEntry {
  uint8_t uidLen;
  uint8_t uid[10];
  uint16_t seq;   // per player, starts at 1, contiguous
  int32_t delta;  // points to add (clamped at 0)
  uint8_t team;   // TEAM_NONE = unchanged
};
static_assert(sizeof(AdjEntry) == 18, "AdjEntry size");
constexpr size_t ADJ_PER_CHUNK = (MAX_PAYLOAD - sizeof(AdjChunkHdr)) / sizeof(AdjEntry);  // 12

enum CmdType : uint8_t {
  CMD_IDENTIFY = 1,  // flash LED ring
  CMD_REBOOT = 2,
};

struct __attribute__((packed)) CmdPkt {
  uint8_t cmd;
};

}  // namespace fk
