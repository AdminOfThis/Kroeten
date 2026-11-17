// Node type 2 "lookup": players check their balance. Each lookup costs
// GameConfigPkt::lookupCost points (set in the dashboard, game-wide); the
// remaining balance is shown on an SSD1306 OLED. A lookup with too few points
// is rejected without revealing the balance. No cooldown.
//
// typeData: none (the price is a game setting).
#pragma once

#include "NodeBase.h"
#include "OledDisplay.h"

#ifndef FK_PIN_OLED_SDA
#define FK_PIN_OLED_SDA 21
#endif
#ifndef FK_PIN_OLED_SCL
#define FK_PIN_OLED_SCL 17
#endif
#ifndef FK_OLED_ADDRESS
#define FK_OLED_ADDRESS 0x3C
#endif

namespace fk {

class LookupNode : public NodeBase {
 public:
  LookupNode() : NodeBase(NODE_LOOKUP), display_(FK_PIN_OLED_SDA, FK_PIN_OLED_SCL, FK_OLED_ADDRESS) {}

 protected:
  const char* typeName() const override { return "lookup"; }
  bool usesCooldown() const override { return false; }
  uint8_t txKind() const override { return TXK_LOOKUP; }

  void addFeedbackSinks(Feedback& feedback) override { feedback.add(&display_); }

  void onLoop() override { display_.setPrice(price()); }

  Decision decide(const TapContext&) override {
    Decision d;
    d.result = TXR_OK;
    d.delta = -static_cast<int32_t>(price());  // NodeBase rejects if the card has too few points
    return d;
  }

 private:
  uint16_t price() const { return state().hasGameConfig() ? state().game().lookupCost : 0; }

  OledDisplay display_;
};

}  // namespace fk
