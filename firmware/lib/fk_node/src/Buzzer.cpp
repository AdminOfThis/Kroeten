#include "Buzzer.h"

#include <Arduino.h>
#include <esp_arduino_version.h>

namespace fk {

namespace {
constexpr uint8_t LEDC_CHANNEL = 7;  // only used with Arduino core 2.x
constexpr uint8_t LEDC_RESOLUTION = 10;
constexpr uint32_t MAX_DUTY = 1 << (LEDC_RESOLUTION - 1);  // 50 % duty = loudest
}  // namespace

void Buzzer::begin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(pin_, 2000, LEDC_RESOLUTION);
#else
  ledcSetup(LEDC_CHANNEL, 2000, LEDC_RESOLUTION);
  ledcAttachPin(pin_, LEDC_CHANNEL);
#endif
  silence();
}

uint32_t Buzzer::duty() const {
  // Quadratic curve: perceived loudness rises more evenly across the slider.
  uint32_t v = volume_ > 100 ? 100 : volume_;
  uint32_t d = MAX_DUTY * v * v / 10000;
  return (v > 0 && d == 0) ? 1 : d;
}

void Buzzer::startTone(uint16_t freq) {
  if (freq == 0 || volume_ == 0) {
    silence();
    return;
  }
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWriteTone(pin_, freq);
  ledcWrite(pin_, duty());
#else
  ledcWriteTone(LEDC_CHANNEL, freq);
  ledcWrite(LEDC_CHANNEL, duty());
#endif
}

void Buzzer::silence() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(pin_, 0);
#else
  ledcWrite(LEDC_CHANNEL, 0);
#endif
}

void Buzzer::setEnabled(bool enabled) {
  enabled_ = enabled;
  if (!enabled && playing_) {
    silence();
    playing_ = false;
  }
}

void Buzzer::setVolume(uint8_t volume) {
  volume_ = volume > 100 ? 100 : volume;
}

void Buzzer::play(std::initializer_list<Note> notes) {
  noteCount_ = 0;
  for (const auto& n : notes) {
    if (noteCount_ < MAX_NOTES) notes_[noteCount_++] = n;
  }
  noteIndex_ = 0;
  noteStartMs_ = millis();
  playing_ = noteCount_ > 0;
  if (playing_) startTone(notes_[0].freq);
}

void Buzzer::event(FbEvent ev, const FbParams& p) {
  if (!enabled_ || volume_ == 0) return;
  switch (ev) {
    case FbEvent::Boot:
      play({{1047, 60}, {1568, 60}});
      break;
    case FbEvent::Success:
      if (p.delta < 0) {
        play({{1568, 80}, {1319, 80}, {1047, 120}});
      } else {
        play({{1047, 80}, {1319, 80}, {1568, 140}});
      }
      break;
    case FbEvent::Cooldown:
      play({{440, 220}});
      break;
    case FbEvent::Insufficient:
      play({{330, 150}, {0, 60}, {330, 150}});
      break;
    case FbEvent::Error:
      play({{220, 450}});
      break;
    case FbEvent::NotRunning:
      play({{523, 100}, {0, 60}, {523, 100}});
      break;
    case FbEvent::Identify:
      play({{880, 100}, {0, 80}, {880, 100}, {0, 80}, {880, 100}});
      break;
  }
}

void Buzzer::loop() {
  if (!playing_) return;
  uint32_t now = millis();
  if (now - noteStartMs_ < notes_[noteIndex_].ms) return;
  noteIndex_++;
  if (noteIndex_ >= noteCount_) {
    silence();
    playing_ = false;
    return;
  }
  noteStartMs_ = now;
  startTone(notes_[noteIndex_].freq);
}

}  // namespace fk
