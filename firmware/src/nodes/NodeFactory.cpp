// Selects the node implementation at compile time (FK_NODE_TYPE build flag).
// To add a node type: create a NodeBase subclass in this folder, add a case
// here, add an environment to platformio.ini and describe the type in
// server/src/nodeTypes.js.
#include "NodeFactory.h"

#ifndef FK_NODE_TYPE
#error "FK_NODE_TYPE must be defined"
#endif

// Only the selected type is compiled, so its libraries (e.g. the display
// driver) are only needed in its own environment.
#if FK_NODE_TYPE == 1
#include "PointsNode.h"
#elif FK_NODE_TYPE == 2
#include "LookupNode.h"
#endif

namespace fk {

NodeBase* createNode() {
#if FK_NODE_TYPE == 1
  return new PointsNode();
#elif FK_NODE_TYPE == 2
  return new LookupNode();
#else
  return nullptr;
#endif
}

}  // namespace fk
