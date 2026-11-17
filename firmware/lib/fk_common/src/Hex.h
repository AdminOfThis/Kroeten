#pragma once

#include <Arduino.h>

namespace fk {

inline String toHex(const uint8_t* data, size_t len) {
  static const char* digits = "0123456789abcdef";
  String s;
  s.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    s += digits[data[i] >> 4];
    s += digits[data[i] & 0x0F];
  }
  return s;
}

inline int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Returns number of bytes decoded, or -1 on malformed input / overflow.
inline int fromHex(const char* hex, uint8_t* out, size_t maxLen) {
  size_t n = strlen(hex);
  if (n % 2 != 0 || n / 2 > maxLen) return -1;
  for (size_t i = 0; i < n / 2; i++) {
    int hi = hexNibble(hex[2 * i]);
    int lo = hexNibble(hex[2 * i + 1]);
    if (hi < 0 || lo < 0) return -1;
    out[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  return static_cast<int>(n / 2);
}

}  // namespace fk
