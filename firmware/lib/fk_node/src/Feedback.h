// User feedback abstraction. A node owns one Feedback hub that fans events out
// to any number of sinks (LED ring, buzzer, later a sound module).
#pragma once

#include <Arduino.h>

namespace fk {

enum class FbEvent : uint8_t {
  Boot,
  Success,       // params: color, delta
  Cooldown,      // params: progress = remaining fraction (0..1)
  Insufficient,  // not enough points
  Error,         // read/write failure, unsupported tag, queue full
  NotRunning,    // game not running / node disabled
  Identify,      // triggered from the dashboard
};

enum class IdleMode : uint8_t {
  NoConfig,     // never received a game config
  Setup,
  Running,
  Paused,
  Ended,
  Disabled,
  ReaderError,
};

struct FbParams {
  uint32_t color = 0x00FF00;  // 0xRRGGBB
  float progress = 0.0f;
  int32_t delta = 0;
  int32_t balance = 0;  // card balance after the transaction (for displays)
  int32_t price = 0;    // what the rejected action would have cost (Insufficient)
};

class FeedbackSink {
 public:
  virtual ~FeedbackSink() = default;
  virtual void begin() {}
  virtual void event(FbEvent ev, const FbParams& p) = 0;
  virtual void setIdle(IdleMode mode, bool online) { (void)mode; (void)online; }
  virtual void setBrightness(uint8_t b) { (void)b; }
  virtual void setVolume(uint8_t volume) { (void)volume; }  // 0-100
  virtual void setEnabled(bool enabled) { (void)enabled; }
  virtual void loop() = 0;
};

class Feedback {
 public:
  void add(FeedbackSink* sink) {
    if (count_ < MAX_SINKS) sinks_[count_++] = sink;
  }
  void begin() {
    for (uint8_t i = 0; i < count_; i++) sinks_[i]->begin();
  }
  void event(FbEvent ev, const FbParams& p = FbParams{}) {
    for (uint8_t i = 0; i < count_; i++) sinks_[i]->event(ev, p);
  }
  void setIdle(IdleMode mode, bool online) {
    for (uint8_t i = 0; i < count_; i++) sinks_[i]->setIdle(mode, online);
  }
  void setBrightness(uint8_t b) {
    for (uint8_t i = 0; i < count_; i++) sinks_[i]->setBrightness(b);
  }
  void setVolume(uint8_t volume) {
    for (uint8_t i = 0; i < count_; i++) sinks_[i]->setVolume(volume);
  }
  void loop() {
    for (uint8_t i = 0; i < count_; i++) sinks_[i]->loop();
  }

 private:
  static constexpr uint8_t MAX_SINKS = 4;
  FeedbackSink* sinks_[MAX_SINKS] = {};
  uint8_t count_ = 0;
};

}  // namespace fk
