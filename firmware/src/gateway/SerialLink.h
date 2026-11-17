// Framed JSON lines over USB serial between gateway and PC server.
//
//   @<json>*<crc16 hex>\n
//
// CRC-16/CCITT-FALSE over the JSON text. Lines not starting with '@' are debug
// output (gateway -> PC) and are ignored by the receiver.
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

namespace fk {

class SerialLink {
 public:
  using Handler = void (*)(JsonDocument& doc, void* ctx);

  void begin(unsigned long baud, Handler handler, void* ctx);
  void loop();
  void send(const JsonDocument& doc);

  uint32_t lastRxMs() const { return lastRxMs_; }
  uint32_t badFrames() const { return badFrames_; }

 private:
  void handleLine();

  static constexpr size_t MAX_LINE = 1600;
  char line_[MAX_LINE + 1];
  size_t lineLen_ = 0;
  bool overflow_ = false;
  Handler handler_ = nullptr;
  void* ctx_ = nullptr;
  uint32_t lastRxMs_ = 0;
  uint32_t badFrames_ = 0;
};

}  // namespace fk
