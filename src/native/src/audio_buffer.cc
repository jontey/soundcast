#include <napi.h>
#include <atomic>
#include <vector>
#include <cstring>

// Lock-free ring buffer for audio streaming
// Capacity: 30 seconds @ 16kHz = 480,000 samples = ~960KB

class AudioRingBuffer {
private:
  static const size_t BUFFER_SIZE = 480000; // 30s @ 16kHz
  std::vector<float> buffer;
  std::atomic<size_t> writePos;
  std::atomic<size_t> readPos;

public:
  AudioRingBuffer() : buffer(BUFFER_SIZE), writePos(0), readPos(0) {}

  // Write audio samples (producer)
  size_t Write(const float* data, size_t length) {
    size_t currentWrite = writePos.load(std::memory_order_relaxed);
    size_t currentRead = readPos.load(std::memory_order_acquire);

    // Calculate available space
    size_t available = (currentRead > currentWrite)
      ? (currentRead - currentWrite - 1)
      : (BUFFER_SIZE - currentWrite + currentRead - 1);

    if (available < length) {
      length = available; // Truncate if not enough space
    }

    if (length == 0) return 0;

    // Write in two parts if wrapping around
    size_t firstPart = std::min(length, BUFFER_SIZE - currentWrite);
    std::memcpy(&buffer[currentWrite], data, firstPart * sizeof(float));

    if (length > firstPart) {
      size_t secondPart = length - firstPart;
      std::memcpy(&buffer[0], data + firstPart, secondPart * sizeof(float));
    }

    // Update write position
    writePos.store((currentWrite + length) % BUFFER_SIZE, std::memory_order_release);

    return length;
  }

  // Read audio samples (consumer)
  size_t Read(float* dest, size_t length) {
    size_t currentRead = readPos.load(std::memory_order_relaxed);
    size_t currentWrite = writePos.load(std::memory_order_acquire);

    // Calculate available data
    size_t available = (currentWrite >= currentRead)
      ? (currentWrite - currentRead)
      : (BUFFER_SIZE - currentRead + currentWrite);

    if (available < length) {
      length = available; // Read only what's available
    }

    if (length == 0) return 0;

    // Read in two parts if wrapping around
    size_t firstPart = std::min(length, BUFFER_SIZE - currentRead);
    std::memcpy(dest, &buffer[currentRead], firstPart * sizeof(float));

    if (length > firstPart) {
      size_t secondPart = length - firstPart;
      std::memcpy(dest + firstPart, &buffer[0], secondPart * sizeof(float));
    }

    // Update read position
    readPos.store((currentRead + length) % BUFFER_SIZE, std::memory_order_release);

    return length;
  }

  // Get available data size
  size_t Available() const {
    size_t currentRead = readPos.load(std::memory_order_acquire);
    size_t currentWrite = writePos.load(std::memory_order_acquire);

    return (currentWrite >= currentRead)
      ? (currentWrite - currentRead)
      : (BUFFER_SIZE - currentRead + currentWrite);
  }

  // Clear buffer
  void Clear() {
    writePos.store(0, std::memory_order_release);
    readPos.store(0, std::memory_order_release);
  }
};

// Placeholder for Phase 3 integration
// Will be used for FFmpeg → Native addon audio streaming
