{
  "targets": [
    {
      "target_name": "whisper_addon",
      "sources": [
        "src/whisper_addon.cc",
        "src/whisper_worker.cc",
        "src/audio_buffer.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "deps/whisper.cpp/include",
        "deps/whisper.cpp/ggml/include"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "GGML_USE_CPU"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "conditions": [
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "10.15"
            },
            "libraries": [
              "../deps/whisper.cpp/build/src/libwhisper.a",
              "../deps/whisper.cpp/build/ggml/src/libggml.a",
              "../deps/whisper.cpp/build/ggml/src/libggml-base.a",
              "../deps/whisper.cpp/build/ggml/src/libggml-cpu.a",
              "../deps/whisper.cpp/build/ggml/src/ggml-metal/libggml-metal.a",
              "../deps/whisper.cpp/build/ggml/src/ggml-blas/libggml-blas.a",
              "-framework Accelerate",
              "-framework Foundation",
              "-framework Metal",
              "-framework MetalKit"
            ]
          }
        ],
        [
          "OS=='linux'",
          {
            "cflags_cc": [
              "-std=c++17",
              "-fexceptions"
            ],
            "libraries": [
              "../deps/whisper.cpp/build/src/libwhisper.a",
              "../deps/whisper.cpp/build/ggml/src/libggml.a",
              "../deps/whisper.cpp/build/ggml/src/libggml-base.a",
              "../deps/whisper.cpp/build/ggml/src/libggml-cpu.a"
            ]
          }
        ]
      ]
    }
  ]
}
