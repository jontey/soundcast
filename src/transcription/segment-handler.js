import { createTranscript } from '../db/models/transcript.js';
import { getRoomBySlug } from '../db/models/room.js';
import { embeddingService } from './embedder.js';

export async function recordTranscriptSegment(session, { text, timestampStart, timestampEnd, confidence = 1.0 }) {
  const cleanText = (text || '').trim();
  if (!cleanText || cleanText.length < 2) {
    return null;
  }

  try {
    const transcript = createTranscript({
      room_id: session.roomId,
      channel_name: session.channelName,
      producer_id: session.producerId,
      producer_name: session.producerName,
      text_content: cleanText,
      timestamp_start: timestampStart,
      timestamp_end: timestampEnd,
      confidence_score: confidence,
      language: session.language
    });

    if (session.onTranscriptUpdate && session.roomSlug) {
      const room = getRoomBySlug(session.roomSlug);
      if (room) {
        session.onTranscriptUpdate(room.tenant_id, session.roomSlug, {
          id: transcript.id,
          channel_name: session.channelName,
          producer_name: session.producerName,
          text_content: cleanText,
          timestamp_start: timestampStart,
          timestamp_end: timestampEnd,
          language: session.language,
          confidence_score: confidence
        });
      }
    }

    if (session.fileWriter && !session.fileWriter.isClosed) {
      try {
        await session.fileWriter.appendSegment({
          id: transcript.id,
          text: cleanText,
          timestampStart,
          timestampEnd,
          confidence
        });
      } catch (err) {
        console.error(`[SegmentHandler] Failed to append segment to file writer: ${err.message}`);
      }
    }

    if (process.env.EMBEDDING_ENABLED === 'true') {
      embeddingService.enqueue({
        transcriptId: transcript.id,
        text: cleanText,
        roomId: session.roomId
      });
    }

    session.emit('transcript', {
      roomId: session.roomId,
      roomSlug: session.roomSlug,
      channelName: session.channelName,
      producerId: session.producerId,
      producerName: session.producerName,
      text: cleanText,
      timestampStart,
      timestampEnd,
      transcriptId: transcript.id,
      confidence,
      language: session.language
    });

    return transcript;
  } catch (err) {
    console.error(`[SegmentHandler] Failed to record transcript segment: ${err.message}`);
    return null;
  }
}

export default {
  recordTranscriptSegment
};
