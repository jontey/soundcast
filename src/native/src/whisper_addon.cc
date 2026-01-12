#include <napi.h>
#include "whisper.h"
#include <string>
#include <memory>

class WhisperSession : public Napi::ObjectWrap<WhisperSession> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  WhisperSession(const Napi::CallbackInfo& info);
  ~WhisperSession();

private:
  static Napi::FunctionReference constructor;

  // Instance methods
  Napi::Value LoadModel(const Napi::CallbackInfo& info);
  Napi::Value Transcribe(const Napi::CallbackInfo& info);
  void Destroy(const Napi::CallbackInfo& info);

  // Whisper context
  struct whisper_context* ctx;
  std::string modelPath;
};

Napi::FunctionReference WhisperSession::constructor;

Napi::Object WhisperSession::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);

  Napi::Function func = DefineClass(env, "WhisperSession", {
    InstanceMethod("loadModel", &WhisperSession::LoadModel),
    InstanceMethod("transcribe", &WhisperSession::Transcribe),
    InstanceMethod("destroy", &WhisperSession::Destroy)
  });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("WhisperSession", func);
  return exports;
}

WhisperSession::WhisperSession(const Napi::CallbackInfo& info)
  : Napi::ObjectWrap<WhisperSession>(info), ctx(nullptr) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Model path required").ThrowAsJavaScriptException();
    return;
  }

  modelPath = info[0].As<Napi::String>().Utf8Value();
}

WhisperSession::~WhisperSession() {
  if (ctx) {
    whisper_free(ctx);
    ctx = nullptr;
  }
}

Napi::Value WhisperSession::LoadModel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (ctx) {
    whisper_free(ctx);
  }

  struct whisper_context_params cparams = whisper_context_default_params();
  ctx = whisper_init_from_file_with_params(modelPath.c_str(), cparams);

  if (!ctx) {
    Napi::Error::New(env, "Failed to load model: " + modelPath).ThrowAsJavaScriptException();
    return env.Null();
  }

  return Napi::Boolean::New(env, true);
}

Napi::Value WhisperSession::Transcribe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!ctx) {
    Napi::Error::New(env, "Model not loaded").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Audio buffer required").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Buffer<float> buffer = info[0].As<Napi::Buffer<float>>();
  float* audioData = buffer.Data();
  size_t audioLength = buffer.Length();

  // Default whisper parameters
  struct whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  wparams.print_progress = false;
  wparams.print_special = false;
  wparams.print_realtime = false;
  wparams.print_timestamps = true;
  wparams.translate = false;
  wparams.n_threads = 4;

  // Parse options if provided
  std::string language = "en"; // default
  if (info.Length() >= 2 && info[1].IsObject()) {
    Napi::Object options = info[1].As<Napi::Object>();
    if (options.Has("language") && options.Get("language").IsString()) {
      language = options.Get("language").As<Napi::String>().Utf8Value();
    }
    if (options.Has("threads") && options.Get("threads").IsNumber()) {
      wparams.n_threads = options.Get("threads").As<Napi::Number>().Int32Value();
    }
  }

  wparams.language = language.c_str();

  // Run transcription
  if (whisper_full(ctx, wparams, audioData, audioLength) != 0) {
    Napi::Error::New(env, "Transcription failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Extract segments
  const int n_segments = whisper_full_n_segments(ctx);
  Napi::Array segments = Napi::Array::New(env, n_segments);

  for (int i = 0; i < n_segments; ++i) {
    const char* text = whisper_full_get_segment_text(ctx, i);
    const int64_t t0 = whisper_full_get_segment_t0(ctx, i);
    const int64_t t1 = whisper_full_get_segment_t1(ctx, i);

    Napi::Object segment = Napi::Object::New(env);
    segment.Set("text", Napi::String::New(env, text));
    segment.Set("timestampStart", Napi::Number::New(env, t0 * 10)); // Convert to ms
    segment.Set("timestampEnd", Napi::Number::New(env, t1 * 10));

    segments[i] = segment;
  }

  return segments;
}

void WhisperSession::Destroy(const Napi::CallbackInfo& info) {
  if (ctx) {
    whisper_free(ctx);
    ctx = nullptr;
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return WhisperSession::Init(env, exports);
}

NODE_API_MODULE(whisper_addon, Init)
