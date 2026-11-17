#pragma once

#include <Arduino.h>

// Debug log lines start with "# " so the PC server can tell them apart from
// framed protocol lines (which start with '@').
#define FK_LOG(fmt, ...) Serial.printf("# " fmt "\n", ##__VA_ARGS__)
