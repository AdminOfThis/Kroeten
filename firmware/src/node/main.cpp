// Entry point for all game node types.
#include <Arduino.h>

#include "../nodes/NodeFactory.h"

namespace {
fk::NodeBase* node = nullptr;
}

void setup() {
  node = fk::createNode();
  if (!node) {
    Serial.begin(115200);
    Serial.println("# unknown FK_NODE_TYPE");
    return;
  }
  node->setup();
}

void loop() {
  if (node) node->loop();
}
