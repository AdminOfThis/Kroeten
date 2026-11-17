// Passive piezo buzzer for debugging. Non-blocking note sequencer.
// Volume is approximated through the PWM duty cycle (50 % = loudest).
#pragma once

#include <initializer_list>

#include "Feedback.h"

namespace fk {

class Buzzer : public FeedbackSink {
 public:
  explicit Buzzer(uint8_t pin) : pin_(pin) {}

  void begin() override;
  void event(FbEvent ev, const FbParams& p) override;
  void setEnabled(bool enabled) override;
  void setVolume(uint8_t volume) override;
  void loop() override;

 private:
  struct Note {
    uint16_t freq;  // 0 = rest
    uint16_t ms;
  };
  static constexpr uint8_t MAX_NOTES = 6;

  void play(std::initializer_list<Note> notes);
  void startTone(uint16_t freq);
  void silence();
  uint32_t duty() const;

  uint8_t pin_;
  bool enabled_ = true;
  uint8_t volume_ = 70;
  Note notes_[MAX_NOTES] = {};
  uint8_t noteCount_ = 0;
  uint8_t noteIndex_ = 0;
  uint32_t noteStartMs_ = 0;
  bool playing_ = false;
};

}  // namespace fk
