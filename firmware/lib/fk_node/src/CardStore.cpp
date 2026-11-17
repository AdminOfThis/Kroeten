#include "CardStore.h"

#include <SPI.h>

#include "Log.h"

namespace fk {

namespace {

constexpr uint8_t CLASSIC_SLOT_BLOCK[2] = {4, 8};
constexpr uint8_t CLASSIC_SLOT_TRAILER[2] = {7, 11};
constexpr uint8_t UL_SLOT_PAGE[2] = {4, 16};
constexpr uint8_t UL_PROBE_PAGE = 24;  // last read block of slot B

}  // namespace

bool CardStore::begin(uint8_t ssPin, uint8_t rstPin) {
  ssPin_ = ssPin;
  rstPin_ = rstPin;
  SPI.begin();
  mfrc_.PCD_Init(ssPin_, rstPin_);
  mfrc_.PCD_SetAntennaGain(MFRC522::RxGain_max);
  return checkReader();
}

bool CardStore::checkReader() {
  uint8_t v = mfrc_.PCD_ReadRegister(MFRC522::VersionReg);
  bool ok = v != 0x00 && v != 0xFF;
  if (!ok) {
    // Try to recover (loose wire, brown-out of the reader).
    mfrc_.PCD_Init(ssPin_, rstPin_);
    mfrc_.PCD_SetAntennaGain(MFRC522::RxGain_max);
    v = mfrc_.PCD_ReadRegister(MFRC522::VersionReg);
    ok = v != 0x00 && v != 0xFF;
  }
  if (ok != readerOk_) FK_LOG("RC522 %s (version 0x%02x)", ok ? "ok" : "NOT responding", v);
  readerOk_ = ok;
  return ok;
}

bool CardStore::detect(CardUid& uid) {
  if (!mfrc_.PICC_IsNewCardPresent()) return false;
  if (!mfrc_.PICC_ReadCardSerial()) return false;

  uid.len = mfrc_.uid.size > sizeof(uid.bytes) ? sizeof(uid.bytes) : mfrc_.uid.size;
  memcpy(uid.bytes, mfrc_.uid.uidByte, uid.len);

  switch (mfrc_.PICC_GetType(mfrc_.uid.sak)) {
    case MFRC522::PICC_TYPE_MIFARE_MINI:
    case MFRC522::PICC_TYPE_MIFARE_1K:
    case MFRC522::PICC_TYPE_MIFARE_4K:
      tech_ = CardTech::Classic;
      break;
    case MFRC522::PICC_TYPE_MIFARE_UL:
      tech_ = CardTech::Ultralight;
      break;
    default:
      tech_ = CardTech::Unsupported;
      break;
  }
  return true;
}

void CardStore::release() {
  mfrc_.PICC_HaltA();
  mfrc_.PCD_StopCrypto1();
}

bool CardStore::reselect() {
  mfrc_.PCD_StopCrypto1();
  byte atqa[2];
  byte size = sizeof(atqa);
  mfrc_.PICC_WakeupA(atqa, &size);
  return mfrc_.PICC_Select(&mfrc_.uid) == MFRC522::STATUS_OK;
}

bool CardStore::classicAuth(uint8_t trailerBlock) {
  MFRC522::MIFARE_Key key;
  for (auto& b : key.keyByte) b = 0xFF;
  return mfrc_.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A, trailerBlock, &key, &mfrc_.uid) ==
         MFRC522::STATUS_OK;
}

bool CardStore::readSlot(uint8_t slot, CardRecord& rec) {
  uint8_t* dst = reinterpret_cast<uint8_t*>(&rec);
  byte buf[18];

  if (tech_ == CardTech::Classic) {
    if (!classicAuth(CLASSIC_SLOT_TRAILER[slot])) return false;
    for (uint8_t i = 0; i < 3; i++) {
      byte size = sizeof(buf);
      if (mfrc_.MIFARE_Read(CLASSIC_SLOT_BLOCK[slot] + i, buf, &size) != MFRC522::STATUS_OK) return false;
      memcpy(dst + i * 16, buf, 16);
    }
    return true;
  }

  if (tech_ == CardTech::Ultralight) {
    // MIFARE_Read returns 4 pages (16 bytes) per call.
    for (uint8_t i = 0; i < 3; i++) {
      byte size = sizeof(buf);
      if (mfrc_.MIFARE_Read(UL_SLOT_PAGE[slot] + i * 4, buf, &size) != MFRC522::STATUS_OK) return false;
      memcpy(dst + i * 16, buf, 16);
    }
    return true;
  }
  return false;
}

bool CardStore::writeSlot(uint8_t slot, const CardRecord& rec) {
  const uint8_t* src = reinterpret_cast<const uint8_t*>(&rec);

  if (tech_ == CardTech::Classic) {
    if (!classicAuth(CLASSIC_SLOT_TRAILER[slot])) return false;
    for (uint8_t i = 0; i < 3; i++) {
      byte buf[16];
      memcpy(buf, src + i * 16, 16);
      if (mfrc_.MIFARE_Write(CLASSIC_SLOT_BLOCK[slot] + i, buf, 16) != MFRC522::STATUS_OK) return false;
    }
    return true;
  }

  if (tech_ == CardTech::Ultralight) {
    for (uint8_t i = 0; i < 12; i++) {
      byte buf[4];
      memcpy(buf, src + i * 4, 4);
      if (mfrc_.MIFARE_Ultralight_Write(UL_SLOT_PAGE[slot] + i, buf, 4) != MFRC522::STATUS_OK) return false;
    }
    return true;
  }
  return false;
}

bool CardStore::read(CardReadResult& out) {
  out = CardReadResult{};
  if (tech_ == CardTech::Unsupported) return false;

  CardRecord a, b;
  const bool okA = readSlot(0, a);
  if (!okA) return false;

  bool okB = false;
  if (tech_ == CardTech::Classic) {
    okB = readSlot(1, b);
    if (!okB) return false;  // Classic tags always have sector 2
    out.slots = 2;
  } else {
    // Small Ultralight tags NAK the probe read; re-select them afterwards.
    byte probe[18];
    byte size = sizeof(probe);
    if (mfrc_.MIFARE_Read(UL_PROBE_PAGE, probe, &size) == MFRC522::STATUS_OK) {
      okB = readSlot(1, b);
      if (!okB) return false;
      out.slots = 2;
    } else {
      out.slots = 1;
      if (!reselect()) return false;
    }
  }

  const bool validA = a.valid();
  const bool validB = okB && b.valid();
  out.ok = true;
  if (validA && (!validB || static_cast<int32_t>(a.counter - b.counter) >= 0)) {
    out.hasRecord = true;
    out.record = a;
    out.slot = 0;
  } else if (validB) {
    out.hasRecord = true;
    out.record = b;
    out.slot = 1;
  }
  return true;
}

bool CardStore::write(const CardRecord& rec, uint8_t slot) {
  return writeSlot(slot, rec);
}

bool CardStore::verify(const CardRecord& rec, uint8_t slot) {
  CardRecord check;
  if (!readSlot(slot, check)) return false;
  return memcmp(&check, &rec, sizeof(rec)) == 0;
}

}  // namespace fk
