// SSD1306 128x64 OLED (I2C) used by the balance lookup station.
// Implemented as a feedback sink: it shows an idle screen ("Karte auflegen",
// price) and the result of each scan for a few seconds.
#pragma once

#include <Adafruit_SSD1306.h>

#include "Feedback.h"

namespace fk {

class OledDisplay : public FeedbackSink {
 public:
  OledDisplay(uint8_t sda, uint8_t scl, uint8_t address = 0x3C);

  void begin() override;
  void event(FbEvent ev, const FbParams& p) override;
  void setIdle(IdleMode mode, bool online) override;
  void loop() override;

  // Price per lookup, shown on the idle screen.
  void setPrice(uint16_t price);

 private:
  void renderIdle();
  void renderEvent();
  // Prints UTF-8 text, mapping German umlauts to the display font (CP437).
  void printDe(const char* text);
  void centered(const char* text, int16_t y, uint8_t size);

  Adafruit_SSD1306 oled_;
  uint8_t sda_;
  uint8_t scl_;
  uint8_t address_;
  bool ok_ = false;
  bool dirty_ = true;

  IdleMode idle_ = IdleMode::NoConfig;
  bool online_ = false;
  uint16_t price_ = 0;

  bool eventActive_ = false;
  FbEvent event_ = FbEvent::Boot;
  FbParams params_;
  uint32_t eventUntilMs_ = 0;
};

}  // namespace fk
