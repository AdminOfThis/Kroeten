// Data stored on the RFID tag. The tag is the source of truth for points.
//
// Two copies (slot A / slot B) are kept when the tag has room. A write always
// goes to the older slot, so a tag pulled away mid-write still has the previous
// valid record in the other slot. The valid record with the higher counter wins.
#pragma once

#include <stdint.h>
#include <string.h>

#include "Crc.h"
#include "Protocol.h"

namespace fk {

constexpr uint8_t CARD_MAGIC = 0xFC;
constexpr uint8_t CARD_VERSION = 1;
constexpr size_t CARD_VISITS = 3;

struct __attribute__((packed)) CardVisit {
  uint32_t nodeId;
  uint32_t epoch;  // wall clock of the last successful tap at that node
};

struct __attribute__((packed)) CardRecord {
  uint8_t magic;
  uint8_t version;
  uint16_t gameId;
  uint32_t counter;  // incremented on every write
  int32_t points;    // never negative
  uint16_t adjSeq;   // highest applied correction
  uint8_t team;      // TEAM_NONE if unassigned
  uint8_t reserved0;
  CardVisit visits[CARD_VISITS];  // most recent first
  uint8_t reserved1[4];
  uint32_t crc;

  void seal() { crc = crc32(reinterpret_cast<const uint8_t*>(this), offsetof(CardRecord, crc)); }

  bool valid() const {
    return magic == CARD_MAGIC && version == CARD_VERSION && points >= 0 &&
           crc == crc32(reinterpret_cast<const uint8_t*>(this), offsetof(CardRecord, crc));
  }

  static CardRecord fresh(uint16_t gameId) {
    CardRecord r;
    memset(&r, 0, sizeof(r));
    r.magic = CARD_MAGIC;
    r.version = CARD_VERSION;
    r.gameId = gameId;
    r.team = TEAM_NONE;
    return r;
  }

  // Wall clock of the last tap at `nodeId`, 0 if not recorded.
  uint32_t lastVisit(uint32_t nodeId) const {
    for (const auto& v : visits) {
      if (v.nodeId == nodeId) return v.epoch;
    }
    return 0;
  }

  void recordVisit(uint32_t nodeId, uint32_t epoch) {
    // Move-to-front list of distinct nodes.
    size_t pos = CARD_VISITS - 1;
    for (size_t i = 0; i < CARD_VISITS; i++) {
      if (visits[i].nodeId == nodeId) {
        pos = i;
        break;
      }
    }
    for (size_t i = pos; i > 0; i--) visits[i] = visits[i - 1];
    visits[0] = {nodeId, epoch};
  }
};
static_assert(sizeof(CardRecord) == 48, "CardRecord must fit 3 MIFARE blocks / 12 NTAG pages");

struct CardUid {
  uint8_t len = 0;
  uint8_t bytes[10] = {};

  bool operator==(const CardUid& o) const { return len == o.len && memcmp(bytes, o.bytes, len) == 0; }
  bool operator!=(const CardUid& o) const { return !(*this == o); }
};

}  // namespace fk
