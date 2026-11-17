#include "StatusLight.h"

#include "Protocol.h"

namespace fk {

namespace {
constexpr uint32_t FLASH_MS = 260;
constexpr uint32_t BOOT_MS = 900;
constexpr uint32_t BLINK_PERIOD_MS = 1000;  // no server connection
constexpr uint32_t BLINK_ON_MS = 500;
}  // namespace

StatusLight::StatusLight(uint8_t pin, uint16_t count, uint8_t brightness)
    : strip_(count, pin, NEO_GRB + NEO_KHZ800), count_(count) {
  strip_.setBrightness(brightness);
}

void StatusLight::begin() {
  strip_.begin();
  strip_.clear();
  strip_.show();
  bootMs_ = millis();
}

void StatusLight::flash() {
  flashing_ = true;
  flashStartMs_ = millis();
  lastFrameMs_ = 0;  // render immediately
}

void StatusLight::fill(uint8_t r, uint8_t g, uint8_t b) {
  for (uint16_t i = 0; i < count_; i++) strip_.setPixelColor(i, r, g, b);
}

void StatusLight::loop() {
  const uint32_t now = millis();
  if (lastFrameMs_ != 0 && now - lastFrameMs_ < 20) return;
  lastFrameMs_ = now | 1;

  // Boot: white wipe.
  if (now - bootMs_ < BOOT_MS) {
    strip_.clear();
    uint16_t lit = (now - bootMs_) * count_ / BOOT_MS + 1;
    for (uint16_t i = 0; i < lit && i < count_; i++) strip_.setPixelColor(i, 120, 120, 120);
    strip_.show();
    return;
  }

  // Base colour.
  uint8_t r, g, b;
  if (connected_) {
    switch (gameState_) {
      case GAME_SETUP:
        r = 0, g = 0, b = 150;
        break;
      case GAME_PAUSED:
        r = 190, g = 70, b = 0;  // amber
        break;
      case GAME_ENDED:
        r = 150, g = 0, b = 0;
        break;
      default:  // running or not known yet
        r = 0, g = 110, b = 0;  // pure green - any blue makes it look cyan on WS2812
        break;
    }
  } else {
    // No server: red blinking (on/off), clearly different from steady red (Beendet).
    const bool on = (now % BLINK_PERIOD_MS) < BLINK_ON_MS;
    r = on ? 200 : 0;
    g = 0;
    b = 0;
  }

  // Transaction flash: white, fading back to the base colour.
  if (flashing_) {
    uint32_t t = now - flashStartMs_;
    if (t >= FLASH_MS) {
      flashing_ = false;
    } else {
      float k = 1.0f - static_cast<float>(t) / FLASH_MS;  // 1 -> 0
      r = static_cast<uint8_t>(r + (255 - r) * k);
      g = static_cast<uint8_t>(g + (255 - g) * k);
      b = static_cast<uint8_t>(b + (255 - b) * k);
    }
  }

  fill(r, g, b);
  strip_.show();
}

}  // namespace fk
