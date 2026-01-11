#include <napi.h>
#include "whisper.h"
#include <vector>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>

// Worker thread implementation for streaming transcription
// This will be expanded in Phase 3 to support real-time streaming

class AudioChunk {
public:
  std::vector<float> data;
  size_t timestamp;

  AudioChunk(const float* audioData, size_t length, size_t ts)
    : data(audioData, audioData + length), timestamp(ts) {}
};

class WhisperWorker {
private:
  std::queue<AudioChunk> audioQueue;
  std::mutex queueMutex;
  std::condition_variable queueCV;
  bool stopRequested;
  std::thread workerThread;

  void ProcessQueue() {
    while (!stopRequested) {
      std::unique_lock<std::mutex> lock(queueMutex);
      queueCV.wait(lock, [this] { return !audioQueue.empty() || stopRequested; });

      if (stopRequested) break;

      if (!audioQueue.empty()) {
        AudioChunk chunk = audioQueue.front();
        audioQueue.pop();
        lock.unlock();

        // Process chunk here (Phase 3 implementation)
        // For now, just a placeholder
      }
    }
  }

public:
  WhisperWorker() : stopRequested(false) {
    workerThread = std::thread(&WhisperWorker::ProcessQueue, this);
  }

  ~WhisperWorker() {
    Stop();
  }

  void EnqueueAudio(const float* data, size_t length, size_t timestamp) {
    std::lock_guard<std::mutex> lock(queueMutex);
    audioQueue.emplace(data, length, timestamp);
    queueCV.notify_one();
  }

  void Stop() {
    {
      std::lock_guard<std::mutex> lock(queueMutex);
      stopRequested = true;
    }
    queueCV.notify_all();
    if (workerThread.joinable()) {
      workerThread.join();
    }
  }

  size_t GetQueueSize() {
    std::lock_guard<std::mutex> lock(queueMutex);
    return audioQueue.size();
  }
};

// Placeholder for Phase 3 expansion
// Will be integrated with WhisperSession for streaming transcription
