// RC522 access + CardRecord storage on supported tag types.
//
//  * MIFARE Classic (Mini/1K/4K): slot A = blocks 4-6 (sector 1),
//                                 slot B = blocks 8-10 (sector 2), default key A.
//  * MIFARE Ultralight / NTAG21x: slot A = pages 4-15, slot B = pages 16-27
//                                 (only if the tag has enough pages).
#pragma once

#include <Arduino.h>
#include <MFRC522.h>

#include "CardRecord.h"

namespace fk {

enum class CardTech : uint8_t { Unsupported, Classic, Ultralight };

struct CardReadResult {
  bool ok = false;         // tag could be read
  bool hasRecord = false;  // a valid record was found
  CardRecord record;
  uint8_t slot = 0;   // slot holding `record`
  uint8_t slots = 1;  // slots available on this tag (1 or 2)
};

class CardStore {
 public:
  bool begin(uint8_t ssPin, uint8_t rstPin);

  // Health check of the reader chip; re-initialises it if it stopped answering.
  bool checkReader();
  bool readerOk() const { return readerOk_; }

  // True if a new tag entered the field and was selected.
  bool detect(CardUid& uid);
  CardTech tech() const { return tech_; }

  bool read(CardReadResult& out);
  bool write(const CardRecord& rec, uint8_t slot);
  bool verify(const CardRecord& rec, uint8_t slot);

  // Tag to halt; it will not be detected again until it leaves the field.
  void release();

  static uint8_t targetSlot(const CardReadResult& r) {
    if (r.slots < 2 || !r.hasRecord) return 0;
    return r.slot == 0 ? 1 : 0;
  }

 private:
  bool readSlot(uint8_t slot, CardRecord& rec);
  bool writeSlot(uint8_t slot, const CardRecord& rec);
  bool classicAuth(uint8_t trailerBlock);
  bool reselect();

  MFRC522 mfrc_;
  uint8_t ssPin_ = 0;
  uint8_t rstPin_ = 0;
  bool readerOk_ = false;
  CardTech tech_ = CardTech::Unsupported;
};

}  // namespace fk
