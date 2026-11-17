#include "SerialLink.h"

#include "Crc.h"

namespace fk {

void SerialLink::begin(unsigned long baud, Handler handler, void* ctx) {
  handler_ = handler;
  ctx_ = ctx;
  Serial.setRxBufferSize(4096);
  Serial.begin(baud);
}

void SerialLink::loop() {
  while (Serial.available() > 0) {
    char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      if (!overflow_) handleLine();
      lineLen_ = 0;
      overflow_ = false;
      continue;
    }
    if (lineLen_ >= MAX_LINE) {
      overflow_ = true;
      continue;
    }
    line_[lineLen_++] = c;
  }
}

void SerialLink::handleLine() {
  line_[lineLen_] = '\0';
  if (lineLen_ < 7 || line_[0] != '@') return;
  char* star = strrchr(line_, '*');
  if (!star || strlen(star) != 5) {
    badFrames_++;
    return;
  }
  *star = '\0';
  const char* json = line_ + 1;
  uint16_t expected = static_cast<uint16_t>(strtoul(star + 1, nullptr, 16));
  uint16_t actual = crc16(reinterpret_cast<const uint8_t*>(json), strlen(json));
  if (expected != actual) {
    badFrames_++;
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, json) != DeserializationError::Ok) {
    badFrames_++;
    return;
  }
  lastRxMs_ = millis();
  if (handler_) handler_(doc, ctx_);
}

void SerialLink::send(const JsonDocument& doc) {
  String json;
  serializeJson(doc, json);
  uint16_t crc = crc16(reinterpret_cast<const uint8_t*>(json.c_str()), json.length());
  char tail[8];
  snprintf(tail, sizeof(tail), "*%04x\n", crc);
  Serial.print('@');
  Serial.print(json);
  Serial.print(tail);
}

}  // namespace fk
