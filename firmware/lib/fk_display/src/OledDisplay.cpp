#include "OledDisplay.h"

#include <Wire.h>

#include "Log.h"

namespace fk {

namespace {

constexpr int16_t W = 128;
constexpr int16_t H = 64;

// UTF-8 -> CP437 for the German umlauts (the display font is CP437).
void toCp437(const char* in, char* out, size_t outSize) {
  size_t o = 0;
  for (size_t i = 0; in[i] && o + 1 < outSize; i++) {
    const uint8_t c = static_cast<uint8_t>(in[i]);
    if (c == 0xC3 && in[i + 1]) {
      const uint8_t n = static_cast<uint8_t>(in[++i]);
      char m = '?';
      switch (n) {
        case 0xA4: m = static_cast<char>(0x84); break;  // ä
        case 0xB6: m = static_cast<char>(0x94); break;  // ö
        case 0xBC: m = static_cast<char>(0x81); break;  // ü
        case 0x84: m = static_cast<char>(0x8E); break;  // Ä
        case 0x96: m = static_cast<char>(0x99); break;  // Ö
        case 0x9C: m = static_cast<char>(0x9A); break;  // Ü
        case 0x9F: m = static_cast<char>(0xE1); break;  // ß
        default: break;
      }
      out[o++] = m;
    } else {
      out[o++] = static_cast<char>(c);
    }
  }
  out[o] = '\0';
}

uint32_t durationFor(FbEvent ev) {
  switch (ev) {
    case FbEvent::Success: return 6000;
    case FbEvent::Insufficient: return 4000;
    case FbEvent::Identify: return 6000;
    default: return 3000;
  }
}

}  // namespace

OledDisplay::OledDisplay(uint8_t sda, uint8_t scl, uint8_t address)
    : oled_(W, H, &Wire, -1), sda_(sda), scl_(scl), address_(address) {}

void OledDisplay::begin() {
  Wire.begin(sda_, scl_);
  ok_ = oled_.begin(SSD1306_SWITCHCAPVCC, address_);
  if (!ok_) {
    FK_LOG("SSD1306 not found at 0x%02x (SDA %u, SCL %u)", address_, sda_, scl_);
    return;
  }
  oled_.cp437(true);
  oled_.setTextColor(SSD1306_WHITE);
  oled_.clearDisplay();
  oled_.display();
  dirty_ = true;
}

void OledDisplay::setPrice(uint16_t price) {
  if (price != price_) {
    price_ = price;
    dirty_ = true;
  }
}

void OledDisplay::setIdle(IdleMode mode, bool online) {
  if (mode != idle_ || online != online_) {
    idle_ = mode;
    online_ = online;
    dirty_ = true;
  }
}

void OledDisplay::event(FbEvent ev, const FbParams& p) {
  if (ev == FbEvent::Boot) return;
  event_ = ev;
  params_ = p;
  eventActive_ = true;
  eventUntilMs_ = millis() + durationFor(ev);
  dirty_ = true;
}

void OledDisplay::loop() {
  if (!ok_) return;
  if (eventActive_ && static_cast<int32_t>(millis() - eventUntilMs_) >= 0) {
    eventActive_ = false;
    dirty_ = true;
  }
  if (!dirty_) return;
  dirty_ = false;
  oled_.clearDisplay();
  if (eventActive_) {
    renderEvent();
  } else {
    renderIdle();
  }
  oled_.display();
}

void OledDisplay::printDe(const char* text) {
  char buf[64];
  toCp437(text, buf, sizeof(buf));
  oled_.print(buf);
}

void OledDisplay::centered(const char* text, int16_t y, uint8_t size) {
  char buf[64];
  toCp437(text, buf, sizeof(buf));
  oled_.setTextSize(size);
  int16_t x1, y1;
  uint16_t w, h;
  oled_.getTextBounds(buf, 0, y, &x1, &y1, &w, &h);
  oled_.setCursor((W - static_cast<int16_t>(w)) / 2, y);
  oled_.print(buf);
}

void OledDisplay::renderIdle() {
  oled_.setTextSize(1);
  oled_.setCursor(0, 0);
  printDe("KONTOSTAND");
  if (!online_) {
    oled_.setCursor(W - 42, 0);
    printDe("offline");
  }
  oled_.drawFastHLine(0, 11, W, SSD1306_WHITE);

  switch (idle_) {
    case IdleMode::Running:
      centered("Karte", 18, 2);
      centered("auflegen", 36, 2);
      break;
    case IdleMode::Paused:
      centered("Pause", 22, 2);
      break;
    case IdleMode::Setup:
      centered("Spiel startet", 20, 1);
      centered("bald", 32, 1);
      break;
    case IdleMode::Ended:
      centered("Spiel beendet", 26, 1);
      break;
    case IdleMode::Disabled:
      centered("Station", 18, 2);
      centered("deaktiviert", 40, 1);
      break;
    case IdleMode::ReaderError:
      centered("Leser-Fehler", 26, 1);
      break;
    case IdleMode::NoConfig:
    default:
      centered("Warte auf", 20, 1);
      centered("Konfiguration", 32, 1);
      break;
  }

  if (idle_ == IdleMode::Running || idle_ == IdleMode::Paused) {
    char line[32];
    if (price_ == 0) {
      snprintf(line, sizeof(line), "Abfrage kostenlos");
    } else {
      snprintf(line, sizeof(line), "Kosten: %u Punkte", price_);
    }
    centered(line, 56, 1);
  }
}

void OledDisplay::renderEvent() {
  char line[32];
  switch (event_) {
    case FbEvent::Success: {
      centered("Dein Kontostand", 0, 1);
      snprintf(line, sizeof(line), "%ld", static_cast<long>(params_.balance));
      centered(line, 16, strlen(line) <= 6 ? 3 : 2);
      centered("Punkte", 44, 1);
      if (params_.delta < 0) {
        snprintf(line, sizeof(line), "(-%ld für Abfrage)", static_cast<long>(-params_.delta));
        centered(line, 56, 1);
      }
      break;
    }
    case FbEvent::Insufficient:
      centered("Zu wenig", 10, 2);
      centered("Punkte", 28, 2);
      snprintf(line, sizeof(line), "Abfrage kostet %ld", static_cast<long>(params_.price));
      centered(line, 54, 1);
      break;
    case FbEvent::NotRunning:
      centered("Gesperrt", 16, 2);
      centered("Spiel läuft nicht", 44, 1);
      break;
    case FbEvent::Cooldown:
      centered("Bitte", 16, 2);
      centered("warten", 34, 2);
      break;
    case FbEvent::Identify:
      centered("Hier bin", 14, 2);
      centered("ich!", 34, 2);
      break;
    case FbEvent::Error:
    default:
      centered("Fehler", 12, 2);
      centered("Karte erneut", 38, 1);
      centered("auflegen", 50, 1);
      break;
  }
}

}  // namespace fk
