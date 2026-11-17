#include "LedRing.h"

#include <math.h>

namespace fk {

namespace {

constexpr uint32_t COLOR_RED = 0xFF0000;
constexpr uint32_t COLOR_ORANGE = 0xFF6000;
constexpr uint32_t COLOR_AMBER = 0xFF9000;
constexpr uint32_t COLOR_BLUE = 0x0040FF;
constexpr uint32_t COLOR_PURPLE = 0x8000FF;
constexpr uint32_t COLOR_GREEN = 0x00FF00;  // pure green (any blue looks cyan on WS2812)
constexpr uint32_t COLOR_WHITE = 0xFFFFFF;

uint32_t durationFor(FbEvent ev) {
  switch (ev) {
    case FbEvent::Boot: return 1200;
    case FbEvent::Success: return 1600;
    case FbEvent::Cooldown: return 2000;
    case FbEvent::Insufficient: return 1500;
    case FbEvent::Error: return 1500;
    case FbEvent::NotRunning: return 1200;
    case FbEvent::Identify: return 6000;
  }
  return 1000;
}

float breathe(uint32_t now, uint32_t periodMs, float minLevel, float maxLevel) {
  float phase = static_cast<float>(now % periodMs) / periodMs;
  float s = 0.5f - 0.5f * cosf(phase * 2.0f * static_cast<float>(M_PI));
  return minLevel + (maxLevel - minLevel) * s;
}

}  // namespace

LedRing::LedRing(uint8_t pin, uint16_t count, uint8_t maxBrightness)
    : strip_(count, pin, NEO_GRB + NEO_KHZ800), count_(count), maxBrightness_(maxBrightness) {}

void LedRing::begin() {
  strip_.begin();
  strip_.setBrightness(maxBrightness_ / 2);
  strip_.clear();
  strip_.show();
}

void LedRing::setBrightness(uint8_t b) {
  strip_.setBrightness(b > maxBrightness_ ? maxBrightness_ : b);
}

void LedRing::event(FbEvent ev, const FbParams& p) {
  event_ = ev;
  params_ = p;
  eventActive_ = true;
  eventStartMs_ = millis();
  eventDurationMs_ = durationFor(ev);
  lastFrameMs_ = 0;  // render immediately
}

void LedRing::setIdle(IdleMode mode, bool online) {
  idle_ = mode;
  online_ = online;
}

// Colours are given as normal (web/sRGB) colours. WS2812 LEDs are linear, so
// without gamma correction small components (e.g. the red and blue in a
// "#43a047" team green) are far too bright and colours look pale or cyan.
uint32_t LedRing::scale(uint32_t color, float level) {
  if (level <= 0) return 0;
  if (level > 1) level = 1;
  color = Adafruit_NeoPixel::gamma32(color);
  uint8_t r = ((color >> 16) & 0xFF) * level;
  uint8_t g = ((color >> 8) & 0xFF) * level;
  uint8_t b = (color & 0xFF) * level;
  return Adafruit_NeoPixel::Color(r, g, b);
}

void LedRing::fill(uint32_t color, float level) {
  uint32_t c = scale(color, level);
  for (uint16_t i = 0; i < count_; i++) strip_.setPixelColor(i, c);
}

void LedRing::arc(float fraction, uint32_t color, float level) {
  uint16_t lit = static_cast<uint16_t>(roundf(fraction * count_));
  uint32_t c = scale(color, level);
  for (uint16_t i = 0; i < count_; i++) strip_.setPixelColor(i, i < lit ? c : 0);
}

void LedRing::loop() {
  uint32_t now = millis();
  if (lastFrameMs_ != 0 && now - lastFrameMs_ < 20) return;
  lastFrameMs_ = now | 1;

  if (eventActive_ && now - eventStartMs_ >= eventDurationMs_) eventActive_ = false;
  if (eventActive_) {
    renderEvent(now - eventStartMs_);
  } else {
    renderIdle(now);
  }
  strip_.show();
}

void LedRing::renderEvent(uint32_t t) {
  switch (event_) {
    case FbEvent::Boot: {
      arc(static_cast<float>(t) / eventDurationMs_, COLOR_WHITE, 0.5f);
      break;
    }
    case FbEvent::Success: {
      // Fast wipe in the team colour, hold, fade out.
      if (t < 300) {
        arc(t / 300.0f, params_.color);
      } else if (t < 1100) {
        fill(params_.color);
      } else {
        fill(params_.color, 1.0f - (t - 1100) / 500.0f);
      }
      break;
    }
    case FbEvent::Cooldown: {
      // Remaining cooldown as an arc, pulsing.
      float level = (t / 250) % 2 == 0 ? 1.0f : 0.4f;
      float frac = params_.progress < 0.05f ? 0.05f : params_.progress;
      arc(frac, COLOR_ORANGE, level);
      break;
    }
    case FbEvent::Insufficient: {
      fill(COLOR_RED, (t / 250) % 2 == 0 ? 1.0f : 0.0f);
      break;
    }
    case FbEvent::Error: {
      fill((t / 100) % 2 == 0 ? COLOR_RED : COLOR_WHITE, (t / 100) % 2 == 0 ? 1.0f : 0.3f);
      break;
    }
    case FbEvent::NotRunning: {
      fill(COLOR_BLUE, (t / 300) % 2 == 0 ? 1.0f : 0.0f);
      break;
    }
    case FbEvent::Identify: {
      for (uint16_t i = 0; i < count_; i++) {
        uint16_t hue = static_cast<uint16_t>((i * 65536UL / count_) + t * 40);
        strip_.setPixelColor(i, strip_.gamma32(strip_.ColorHSV(hue)));
      }
      break;
    }
  }
}

void LedRing::renderIdle(uint32_t now) {
  strip_.clear();
  switch (idle_) {
    case IdleMode::NoConfig: {
      uint16_t pos = (now / 80) % count_;
      strip_.setPixelColor(pos, scale(COLOR_PURPLE, 0.8f));
      break;
    }
    case IdleMode::Setup:
      fill(COLOR_BLUE, breathe(now, 3000, 0.03f, 0.25f));
      break;
    case IdleMode::Running:
      fill(COLOR_GREEN, breathe(now, 3000, 0.05f, 0.3f));
      break;
    case IdleMode::Paused:
      fill(COLOR_BLUE, 0.1f);
      for (uint16_t i = 0; i < count_; i += (count_ >= 4 ? count_ / 4 : 1)) {
        strip_.setPixelColor(i, scale(COLOR_WHITE, 0.4f));
      }
      break;
    case IdleMode::Ended:
      fill(COLOR_RED, 0.06f);
      break;
    case IdleMode::Disabled:
      strip_.setPixelColor(0, scale(COLOR_RED, 0.3f));
      break;
    case IdleMode::ReaderError:
      fill(COLOR_RED, (now / 150) % 2 == 0 ? 0.8f : 0.0f);
      return;  // no online indicator, the error dominates
  }
  // Offline marker: a single amber pixel circling. Taps still work offline.
  if (!online_) {
    uint16_t pos = (now / 120) % count_;
    strip_.setPixelColor(pos, scale(COLOR_AMBER, 0.9f));
  }
}

}  // namespace fk
