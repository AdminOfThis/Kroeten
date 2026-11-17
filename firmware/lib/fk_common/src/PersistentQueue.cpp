#include "PersistentQueue.h"

#include <LittleFS.h>
#include <esp_system.h>

#include <algorithm>

#include "Crc.h"
#include "Log.h"

namespace fk {

// ---------------------------------------------------------------------------
// PersistentQueue
// ---------------------------------------------------------------------------

bool PersistentQueue::begin(const char* name, size_t maxEntries) {
  maxEntries_ = maxEntries;
  logPath_ = String("/q_") + name + ".log";
  headPath_ = String("/q_") + name + ".hd";
  tmpPath_ = String("/q_") + name + ".tmp";

  prefs_.begin((String("q_") + name).c_str(), false);
  stream_ = prefs_.getUInt("stream", 0);
  if (stream_ == 0) {
    stream_ = esp_random() | 1;
    prefs_.putUInt("stream", stream_);
  }
  nextSeq_ = prefs_.getUInt("seq", 1);

  // Recover from a crash in the middle of compact().
  if (LittleFS.exists(tmpPath_)) {
    if (LittleFS.exists(logPath_)) {
      LittleFS.remove(tmpPath_);
    } else {
      LittleFS.rename(tmpPath_, logPath_);
    }
  }

  head_ = 0;
  File h = LittleFS.open(headPath_, "r");
  if (h && h.size() == 8) {
    uint32_t v = 0, c = 0;
    h.read(reinterpret_cast<uint8_t*>(&v), 4);
    h.read(reinterpret_cast<uint8_t*>(&c), 4);
    if (crc32(reinterpret_cast<uint8_t*>(&v), 4) == c) head_ = v;
  }
  if (h) h.close();

  bool misaligned = false;
  count_ = 0;
  File f = LittleFS.open(logPath_, "r");
  if (f) {
    count_ = f.size() / sizeof(Record);
    misaligned = (f.size() % sizeof(Record)) != 0;
    f.close();
  }
  if (head_ > count_) head_ = count_;

  // Validate records after head; a torn write leaves an invalid tail.
  uint32_t valid = head_;
  uint32_t lastSeq = 0;
  Record r;
  for (uint32_t i = head_; i < count_; i++) {
    if (!readRecord(i, r) || !recordValid(r)) break;
    lastSeq = r.seq;
    valid = i + 1;
  }
  if (valid != count_ || misaligned) {
    FK_LOG("queue %s: repairing log (valid %lu of %lu)", name, (unsigned long)(valid - head_),
           (unsigned long)(count_ - head_));
    compact(valid);
  }

  if (size() > 0) {
    readRecord(head_, r);
    headSeq_ = r.seq;
    if (lastSeq >= nextSeq_) nextSeq_ = lastSeq + 1;
  } else if (count_ > 0) {
    LittleFS.remove(logPath_);
    LittleFS.remove(headPath_);
    head_ = count_ = 0;
  }
  FK_LOG("queue %s: %u pending, stream=%08lx nextSeq=%lu", name, (unsigned)size(), (unsigned long)stream_,
         (unsigned long)nextSeq_);
  return true;
}

bool PersistentQueue::canPush() const {
  return count_ < maxEntries_ || head_ > 0;
}

bool PersistentQueue::push(const void* data, uint16_t len, uint32_t* seqOut) {
  if (len > MAX_DATA) return false;
  if (count_ >= maxEntries_) {
    if (head_ == 0) return false;
    compact(count_);
    if (count_ >= maxEntries_) return false;
  }

  Record r = {};
  r.magic = RECORD_MAGIC;
  r.len = len;
  r.seq = nextSeq_;
  memcpy(r.data, data, len);
  r.crc = crc32(reinterpret_cast<const uint8_t*>(&r), offsetof(Record, crc));

  File f = LittleFS.open(logPath_, "a");
  if (!f) return false;
  size_t written = f.write(reinterpret_cast<const uint8_t*>(&r), sizeof(r));
  f.close();
  if (written != sizeof(r)) {
    FK_LOG("queue: write failed (%u bytes)", (unsigned)written);
    compact(count_);  // drop the partial record so the file stays aligned
    return false;
  }

  if (size() == 0) headSeq_ = r.seq;
  count_++;
  nextSeq_++;
  prefs_.putUInt("seq", nextSeq_);
  if (seqOut) *seqOut = r.seq;
  return true;
}

bool PersistentQueue::peek(size_t offset, Entry& out) const {
  if (offset >= size()) return false;
  Record r;
  if (!readRecord(head_ + offset, r) || !recordValid(r)) return false;
  out.seq = r.seq;
  out.len = r.len;
  memcpy(out.data, r.data, r.len);
  return true;
}

bool PersistentQueue::isAcked(uint32_t seq) const {
  return std::find(ackedAhead_.begin(), ackedAhead_.end(), seq) != ackedAhead_.end();
}

bool PersistentQueue::ack(uint32_t seq) {
  if (size() == 0 || seq < headSeq_ || seq >= nextSeq_) return false;
  if (isAcked(seq)) return true;
  ackedAhead_.push_back(seq);
  advanceHead();
  return true;
}

void PersistentQueue::advanceHead() {
  bool moved = false;
  while (size() > 0) {
    auto it = std::find(ackedAhead_.begin(), ackedAhead_.end(), headSeq_);
    if (it == ackedAhead_.end()) break;
    ackedAhead_.erase(it);
    head_++;
    moved = true;
    if (size() > 0) {
      Record r;
      if (readRecord(head_, r)) {
        headSeq_ = r.seq;
      } else {
        headSeq_++;
      }
    }
  }
  if (!moved) return;
  if (size() == 0) {
    LittleFS.remove(logPath_);
    LittleFS.remove(headPath_);
    head_ = count_ = 0;
    ackedAhead_.clear();
  } else {
    persistHead();
  }
}

bool PersistentQueue::readRecord(uint32_t index, Record& rec) const {
  File f = LittleFS.open(logPath_, "r");
  if (!f) return false;
  bool ok = f.seek(index * sizeof(Record)) &&
            f.read(reinterpret_cast<uint8_t*>(&rec), sizeof(Record)) == sizeof(Record);
  f.close();
  return ok;
}

bool PersistentQueue::recordValid(const Record& rec) {
  return rec.magic == RECORD_MAGIC && rec.len <= MAX_DATA &&
         rec.crc == crc32(reinterpret_cast<const uint8_t*>(&rec), offsetof(Record, crc));
}

bool PersistentQueue::persistHead() {
  File f = LittleFS.open(tmpPath_ + "h", "w");
  if (!f) return false;
  uint32_t c = crc32(reinterpret_cast<const uint8_t*>(&head_), 4);
  f.write(reinterpret_cast<const uint8_t*>(&head_), 4);
  f.write(reinterpret_cast<const uint8_t*>(&c), 4);
  f.close();
  return LittleFS.rename(tmpPath_ + "h", headPath_);
}

// Rewrites records [head_, validCount) into a fresh file starting at index 0.
// Crash safety: head=0 is persisted only after the new file is complete, and a
// left-over temp file is recovered in begin().
bool PersistentQueue::compact(uint32_t validCount) {
  File out = LittleFS.open(tmpPath_, "w");
  if (!out) return false;
  Record r;
  uint32_t copied = 0;
  for (uint32_t i = head_; i < validCount; i++) {
    if (!readRecord(i, r) || !recordValid(r)) break;
    if (out.write(reinterpret_cast<const uint8_t*>(&r), sizeof(r)) != sizeof(r)) break;
    copied++;
  }
  out.close();

  // Order matters: until the rename the old log + old head stay consistent.
  LittleFS.remove(logPath_);
  LittleFS.rename(tmpPath_, logPath_);
  head_ = 0;
  count_ = copied;
  persistHead();

  // Acked-ahead seqs that were dropped are no longer relevant.
  if (count_ == 0) ackedAhead_.clear();
  return true;
}

// ---------------------------------------------------------------------------
// ReliableSender
// ---------------------------------------------------------------------------

void ReliableSender::begin(PersistentQueue* queue, uint8_t window, uint32_t retryMs, uint32_t maxRetryMs, SendFn fn,
                           void* ctx) {
  queue_ = queue;
  window_ = std::min<uint8_t>(window, MAX_WINDOW);
  retryMs_ = retryMs;
  maxRetryMs_ = maxRetryMs;
  fn_ = fn;
  ctx_ = ctx;
}

ReliableSender::InFlight* ReliableSender::find(uint32_t seq) {
  for (auto& f : inflight_) {
    if (f.valid && f.seq == seq) return &f;
  }
  return nullptr;
}

ReliableSender::InFlight* ReliableSender::alloc() {
  for (auto& f : inflight_) {
    if (!f.valid) return &f;
  }
  return nullptr;
}

void ReliableSender::onAck(uint32_t seq) {
  if (!queue_) return;
  queue_->ack(seq);
  InFlight* f = find(seq);
  if (f) f->valid = false;
}

void ReliableSender::kick() {
  for (auto& f : inflight_) {
    if (f.valid) {
      f.lastSentMs = 0;
      f.backoffMs = 0;
    }
  }
}

void ReliableSender::loop() {
  if (!queue_ || !fn_) return;
  const uint32_t now = millis();
  if (now - lastLoopMs_ < 100) return;
  lastLoopMs_ = now;

  // Forget entries that left the queue (acked, or dropped by a repair).
  for (auto& f : inflight_) {
    if (!f.valid) continue;
    if (queue_->size() == 0 || queue_->isAcked(f.seq)) f.valid = false;
  }

  uint8_t active = 0;
  PersistentQueue::Entry e;
  for (size_t offset = 0; offset < queue_->size() && active < window_; offset++) {
    if (!queue_->peek(offset, e)) break;
    if (queue_->isAcked(e.seq)) continue;
    active++;

    InFlight* f = find(e.seq);
    if (!f) {
      f = alloc();
      if (!f) break;
      *f = InFlight{};
      f->seq = e.seq;
      f->valid = true;
    }
    const bool due = f->lastSentMs == 0 || now - f->lastSentMs >= f->backoffMs;
    if (!due) continue;
    if (!fn_(e, ctx_)) break;  // transport busy, try again next loop
    f->lastSentMs = now | 1;
    uint32_t next = f->backoffMs == 0 ? retryMs_ : f->backoffMs * 2;
    if (next > maxRetryMs_) next = maxRetryMs_;
    f->backoffMs = next + (esp_random() % (retryMs_ / 2 + 1));
  }
}

}  // namespace fk
