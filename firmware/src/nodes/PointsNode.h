// Node type 1 "points": every tap adds a configurable amount of points.
// A negative amount subtracts points; the tap is rejected if the card does not
// have enough points (balance never becomes negative - enforced by NodeBase).
//
// typeData layout (NodeConfigPkt::typeData), mirrored in server/src/nodeTypes.js:
//   offset 0: int16 points per tap
#pragma once

#include "NodeBase.h"

namespace fk {

class PointsNode : public NodeBase {
 public:
  static constexpr int16_t DEFAULT_POINTS = 10;

  PointsNode() : NodeBase(NODE_POINTS) {}

 protected:
  const char* typeName() const override { return "points"; }

  Decision decide(const TapContext&) override {
    Decision d;
    d.result = TXR_OK;
    d.delta = typeDataI16(0, DEFAULT_POINTS);
    return d;
  }
};

}  // namespace fk
