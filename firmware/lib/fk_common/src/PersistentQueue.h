// Power-loss safe FIFO on LittleFS.
//
// Messages are appended as fixed-size, CRC protected records to a log file.
// A message is only removed once it has been acknowledged (ack(seq)). The
// index of the first unacknowledged record ("head") is persisted atomically
// (write temp file + rename). After a reboot all unacknowledged messages are
// sent again; receivers de-duplicate by (stream, seq).
#pragma once

#include <Arduino.h>
#include <Preferences.h>

#include <vector>

namespace fk {

class PersistentQueue {
 public:
  static constexpr size_t MAX_DATA = 128;

  struct Entry {
    uint32_t seq;
    uint16_t len;
    uint8_t data[MAX_DATA];
  };

  // name: short identifier (max 8 chars), used for file names and NVS namespace.
  bool begin(const char* name, size_t maxEntries);

  bool canPush() const;
  bool push(const void* data, uint16_t len, uint32_t* seqOut = nullptr);

  // Number of messages not yet removed (including ones acked out of order).
  size_t size() const { return count_ - head_; }
  size_t pendingCount() const { return size() - ackedAhead_.size(); }

  // Read the message at position `offset` counted from the head.
  bool peek(size_t offset, Entry& out) const;
  bool isAcked(uint32_t seq) const;

  // Mark a message as delivered. Returns false for unknown sequence numbers.
  bool ack(uint32_t seq);

  uint32_t stream() const { return stream_; }

 private:
  struct __attribute__((packed)) Record {
    uint16_t magic;
    uint16_t len;
    uint32_t seq;
    uint8_t data[MAX_DATA];
    uint32_t crc;
  };
  static constexpr uint16_t RECORD_MAGIC = 0xA51C;

  bool readRecord(uint32_t index, Record& rec) const;
  static bool recordValid(const Record& rec);
  bool persistHead();
  bool compact(uint32_t validCount);
  void advanceHead();

  String logPath_;
  String headPath_;
  String tmpPath_;
  size_t maxEntries_ = 0;
  uint32_t head_ = 0;
  uint32_t count_ = 0;
  uint32_t headSeq_ = 0;  // seq of the record at head (valid if size() > 0)
  uint32_t nextSeq_ = 1;
  uint32_t stream_ = 0;
  std::vector<uint32_t> ackedAhead_;
  mutable Preferences prefs_;
};

// Sends queued messages with a sliding window and exponential backoff until
// they are acknowledged.
class ReliableSender {
 public:
  // Returns true if the message was handed to the transport.
  using SendFn = bool (*)(const PersistentQueue::Entry& e, void* ctx);

  void begin(PersistentQueue* queue, uint8_t window, uint32_t retryMs, uint32_t maxRetryMs, SendFn fn, void* ctx);
  void loop();
  void onAck(uint32_t seq);
  // Send everything that is due right away (e.g. after the link came back).
  void kick();

 private:
  struct InFlight {
    uint32_t seq = 0;
    uint32_t lastSentMs = 0;
    uint32_t backoffMs = 0;
    bool valid = false;
  };
  static constexpr uint8_t MAX_WINDOW = 8;

  InFlight* find(uint32_t seq);
  InFlight* alloc();

  PersistentQueue* queue_ = nullptr;
  uint8_t window_ = 4;
  uint32_t retryMs_ = 2000;
  uint32_t maxRetryMs_ = 30000;
  SendFn fn_ = nullptr;
  void* ctx_ = nullptr;
  InFlight inflight_[MAX_WINDOW];
  uint32_t lastLoopMs_ = 0;
};

}  // namespace fk
