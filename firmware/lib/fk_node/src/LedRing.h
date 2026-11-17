// WS2812B ring around the RFID antenna.
#pragma once

#include <Adafruit_NeoPixel.h>

#include "Feedback.h"

namespace fk {

class LedRing : public FeedbackSink {
 public:
  LedRing(uint8_t pin, uint16_t count, uint8_t maxBrightness);

  void begin() override;
  void event(FbEvent ev, const FbParams& p) override;
  void setIdle(IdleMode mode, bool online) override;
  void setBrightness(uint8_t b) override;
  void loop() override;

 private:
  void renderEvent(uint32_t t);
  void renderIdle(uint32_t now);
  void fill(uint32_t color, float level = 1.0f);
  void arc(float fraction, uint32_t color, float level = 1.0f);
  static uint32_t scale(uint32_t color, float level);

  Adafruit_NeoPixel strip_;
  uint16_t count_;
  uint8_t maxBrightness_;

  bool eventActive_ = false;
  FbEvent event_ = FbEvent::Boot;
  FbParams params_;
  uint32_t eventStartMs_ = 0;
  uint32_t eventDurationMs_ = 0;

  IdleMode idle_ = IdleMode::NoConfig;
  bool online_ = false;
  uint32_t lastFrameMs_ = 0;
};

}  // namespace fk
