import * as nativeTranscriber from './transcriber-native.js';
import transcriberHttp from './transcriber-http.js';
import qwenTranscriber from './qwen-transcriber.js';

const defaultMode = process.env.TRANSCRIPTION_USE_NATIVE === 'false' ? 'http' : 'native';
const envMode = process.env.TRANSCRIPTION_MODE ? process.env.TRANSCRIPTION_MODE.toLowerCase() : defaultMode;

const availableTranscribers = {
  native: nativeTranscriber,
  http: transcriberHttp,
  qwen: qwenTranscriber
};

const activeMode = availableTranscribers[envMode] ? envMode : 'native';
const transcriber = availableTranscribers[activeMode];

console.log(`[Transcriber] Mode selected: ${activeMode}`);

export function initTranscriber(deps) {
  if (transcriber?.initTranscriber) {
    transcriber.initTranscriber(deps);
  }
}

export function startTranscription(...args) {
  return transcriber.startTranscription(...args);
}

export function stopTranscription(...args) {
  return transcriber.stopTranscription(...args);
}

export function getSessionStats(...args) {
  return transcriber.getSessionStats(...args);
}

export function stopAllTranscriptions(...args) {
  return transcriber.stopAllTranscriptions(...args);
}

export function getTranscriptionSession(...args) {
  return transcriber.getTranscriptionSession(...args);
}

export const TRANSCRIPTION_MODE = activeMode;

export default {
  initTranscriber,
  startTranscription,
  stopTranscription,
  getSessionStats,
  stopAllTranscriptions,
  getTranscriptionSession
};
