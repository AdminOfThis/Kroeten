// Status light of the bridge node: a small WS2812 strip/ring (default 8 LEDs).
// Connected to the PC server: steady colour of the game state (same colours as
// the dashboard's state switch)
//   blue                Vorbereitung (setup)
//   green               Läuft (running) - also before the first game config
//   amber               Pausiert (paused)
//   red (steady)        Beendet (ended)
// Not connected:
//   red (blinking)      no server connection (1 Hz on/off)
// Always:
//   white flash         a new transaction arrived from a station
#pragma once

#include <Adafruit_NeoPixel.h>

namespace fk {

class StatusLight {
 public:
  StatusLight(uint8_t pin, uint16_t count, uint8_t brightness);

  void begin();
  void setConnected(bool connected) { connected_ = connected; }
  // GameState from the game config the server broadcasts (0xFF = unknown).
  void setGameState(uint8_t state) { gameState_ = state; }
  void flash();  // one new transaction
  void loop();

 private:
  void fill(uint8_t r, uint8_t g, uint8_t b);

  Adafruit_NeoPixel strip_;
  uint16_t count_;
  bool connected_ = false;
  uint8_t gameState_ = 0xFF;
  uint32_t flashStartMs_ = 0;
  bool flashing_ = false;
  uint32_t lastFrameMs_ = 0;
  uint32_t bootMs_ = 0;
};

}  // namespace fk
