import React, { useState, useEffect, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import "./App.css";
import { PCMUEncoder } from "./PCMUEncoder";

interface CallSession {
  sessionId: string;
  ws: WebSocket | null;
  audioContext: AudioContext | null;
  isConnected: boolean;
  processor: AudioWorkletNode | null;
  input: MediaStreamAudioSourceNode | null;
}

interface WebSocketMessage {
  version?: string;
  type: string;
  seq?: number;
  id?: string;
  parameters?: {
    startPaused?: boolean;
  };
  text?: string;
  isFinal?: boolean;
  reason?: string;
}

interface Transcription {
  text: string;
  timestamp: number;
}

// Simple linear interpolation resampling
const resampleAudio = (input: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array => {
  if (inputSampleRate === outputSampleRate) {
    return input;
  }

  const ratio = outputSampleRate / inputSampleRate;
  const outputLength = Math.round(input.length * ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const inputIndex = i / ratio;
    const index = Math.floor(inputIndex);
    const frac = inputIndex - index;

    if (index + 1 < input.length) {
      output[i] = input[index] + (input[index + 1] - input[index]) * frac;
    } else {
      output[i] = input[index];
    }
  }

  console.log(
    "Resampled audio: input length=" + input.length + ", output length=" + outputLength + ", " +
    "input rate=" + inputSampleRate + ", output rate=" + outputSampleRate
  );
  return output;
};

const App: React.FC = () => {
  const [sessions, setSessions] = useState<CallSession[]>([]);
  const [transcriptions, setTranscriptions] = useState<{
    [sessionId: string]: Transcription[];
  }>({});
  const [isRecording, setIsRecording] = useState<{
    [sessionId: string]: boolean;
  }>({});
  const [connectionStatus, setConnectionStatus] = useState<{
    [sessionId: string]: string;
  }>({});
  const [audioLevels, setAudioLevels] = useState<{
    [sessionId: string]: number;
  }>({});
  const [isStarting, setIsStarting] = useState(false);
  const audioRefs = useRef<{ [sessionId: string]: { audio: HTMLAudioElement; url: string } }>({});
  const recordedAudio = useRef<{
    [sessionId: string]: { chunks: Float32Array[]; audioQueue: Float32Array[]; isPlaying: boolean };
  }>({});

  const WS_URL = "ws://localhost:4000";
  const MAX_SESSIONS = 1;
  const INPUT_SAMPLE_RATE = 8000; // Server sends 8000 Hz μ-law audio

  const startCall = async () => {
    if (sessions.length >= MAX_SESSIONS) return;
    setIsStarting(true);
    const sessionId = uuidv4();

    try {
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (permissionStatus.state !== 'granted') {
        console.warn("Microphone permission: " + permissionStatus.state);
        alert('Please grant microphone access to record audio.');
        setIsStarting(false);
        return;
      }

      const ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";

      setConnectionStatus((prev) => ({
        ...prev,
        [sessionId]: "Connecting...",
      }));
      recordedAudio.current[sessionId] = { chunks: [], audioQueue: [], isPlaying: false };

      ws.onopen = () => {
        console.log("WebSocket opened for session " + sessionId);
        setConnectionStatus((prev) => ({ ...prev, [sessionId]: "Connected" }));

        const openMessage: WebSocketMessage = {
          version: "2",
          type: "open",
          seq: 1,
          id: sessionId,
          parameters: { startPaused: false },
        };
        ws.send(JSON.stringify(openMessage));
      };

      ws.onmessage = (event) => {
        try {
          if (typeof event.data === "string") {
            const message: WebSocketMessage = JSON.parse(event.data);
            handleWebSocketMessage(sessionId, message);
          } else {
            handleAudioData(sessionId, event.data);
          }
        } catch (error) {
          console.error("Error parsing WebSocket message for session " + sessionId + ":", error);
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket error for session " + sessionId + ":", error);
        setConnectionStatus((prev) => ({ ...prev, [sessionId]: "Error" }));
        reconnect(sessionId);
      };

      ws.onclose = (event) => {
        console.log("WebSocket closed for session " + sessionId, event.code, event.reason);
        setConnectionStatus((prev) => ({
          ...prev,
          [sessionId]: "Disconnected: " + (event.reason || "Code " + event.code),
        }));
        reconnect(sessionId);
      };

      const { audioContext, processor, input } = await setupAudioRecording(sessionId, ws);

      const newSession: CallSession = {
        sessionId,
        ws,
        audioContext,
        isConnected: true,
        processor,
        input,
      };

      setSessions((prev) => [...prev, newSession]);
      setIsRecording((prev) => ({ ...prev, [sessionId]: true }));
    } catch (error) {
      console.error("Error starting call for session " + sessionId + ":", error);
      setConnectionStatus((prev) => ({
        ...prev,
        [sessionId]: "Failed to start",
      }));
    } finally {
      setIsStarting(false);
    }
  };

  const reconnect = (sessionId: string) => {
    let attempts = 0;
    const maxAttempts = 3;
    const tryReconnect = () => {
      if (attempts >= maxAttempts) {
        setConnectionStatus((prev) => ({
          ...prev,
          [sessionId]: "Failed to reconnect after max attempts",
        }));
        stopCall(sessionId);
        return;
      }
      console.log("Reconnecting attempt " + (attempts + 1) + " for session " + sessionId);
      const ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        console.log("WebSocket reconnected for session " + sessionId);
        setConnectionStatus((prev) => ({ ...prev, [sessionId]: "Reconnected" }));
        const openMessage: WebSocketMessage = {
          version: "2",
          type: "open",
          seq: 1,
          id: sessionId,
          parameters: { startPaused: false },
        };
        ws.send(JSON.stringify(openMessage));
        setSessions((prev) =>
          prev.map((s) => (s.sessionId === sessionId ? { ...s, ws } : s))
        );
      };
      ws.onmessage = (event) => {
        try {
          if (typeof event.data === "string") {
            const message: WebSocketMessage = JSON.parse(event.data);
            handleWebSocketMessage(sessionId, message);
          } else {
            handleAudioData(sessionId, event.data);
          }
        } catch (error) {
          console.error("Error parsing WebSocket message for session " + sessionId + ":", error);
        }
      };
      ws.onerror = (error) => {
        console.error("Reconnect error for session " + sessionId + ":", error);
        attempts++;
        setTimeout(tryReconnect, 1000 * Math.pow(2, attempts));
      };
      ws.onclose = (event) => {
        console.log("WebSocket closed during reconnect for session " + sessionId, event.code, event.reason);
        setConnectionStatus((prev) => ({
          ...prev,
          [sessionId]: "Disconnected: " + (event.reason || "Code " + event.code),
        }));
        reconnect(sessionId);
      };
    };
    tryReconnect();
  };

  const handleWebSocketMessage = (sessionId: string, message: WebSocketMessage) => {
    console.log("Received message for session " + sessionId + ":", message);

    switch (message.type) {
      case "opened":
        setConnectionStatus((prev) => ({
          ...prev,
          [sessionId]: "Session Opened",
        }));
        break;
      case "transcription":
        if (message.text && typeof message.text === "string") {
          setTranscriptions((prev) => ({
            ...prev,
            [sessionId]: [
              ...(prev[sessionId] || []),
              { text: message.text, timestamp: Date.now() },
            ],
          }));
        } else {
          console.warn("Invalid transcription message for session " + sessionId + ":", message);
        }
        break;
      case "disconnect":
        setConnectionStatus((prev) => ({
          ...prev,
          [sessionId]: "Disconnected: " + (message.reason || "Unknown"),
        }));
        stopCall(sessionId);
        break;
      default:
        console.log("Unknown message type: " + message.type);
    }
  };

  const handleAudioData = async (sessionId: string, audioData: any) => {
    try {
      let arrayBuffer = audioData;
      if (audioData instanceof Blob) {
        console.log("Received Blob for session " + sessionId + ", size: " + audioData.size);
        arrayBuffer = await audioData.arrayBuffer();
      }

      if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength === 0) {
        console.error("Invalid audio data received for session " + sessionId);
        return;
      }

      // Decode μ-law to PCM
      const pcmuData = new Uint8Array(arrayBuffer);
      const pcmData = PCMUEncoder.decode(pcmuData);
      console.log(
        "PCM data for session " + sessionId + ": length=" + pcmData.length + ", " +
        "first 10 samples=" + Array.from(pcmData.slice(0, 10)).join(',') + ", " +
        "max amplitude=" + Math.max(...pcmData.map(Math.abs)).toFixed(4)
      );

      // Store for saving
      if (!recordedAudio.current[sessionId]) {
        recordedAudio.current[sessionId] = { chunks: [], audioQueue: [], isPlaying: false };
      }
      recordedAudio.current[sessionId].chunks.push(pcmData);

      // Add to audio queue
      recordedAudio.current[sessionId].audioQueue.push(pcmData);

      // Initialize AudioContext
      if (!recordedAudio.current[sessionId].audioContext) {
        // Use default sample rate (browser default, usually 44100 or 48000)
        recordedAudio.current[sessionId].audioContext = new AudioContext();
        console.log(
          "AudioContext for session " + sessionId + ": actual sample rate=" + recordedAudio.current[sessionId].audioContext!.sampleRate
        );
      }

      // Process audio queue
      if (!recordedAudio.current[sessionId].isPlaying) {
        processAudioQueue(sessionId, recordedAudio.current[sessionId].audioContext!);
        // Normalize audio before queuing
      const maxAmplitude = Math.max(...pcmData.map(Math.abs));
      const scale = maxAmplitude > 0 ? Math.min(1, 0.95 / maxAmplitude) : 1;
      const normalizedPcm = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        normalizedPcm[i] = pcmData[i] * scale;
      }
      recordedAudio.current[sessionId].audioQueue.push(normalizedPcm);
      }
    } catch (error) {
      console.error("Error handling audio data for session " + sessionId + ":", error);
    }
  };

  const processAudioQueue = async (sessionId: string, audioContext: AudioContext) => {
    if (recordedAudio.current[sessionId].audioQueue.length === 0) {
      recordedAudio.current[sessionId].isPlaying = false;
      console.log("Audio queue empty for session " + sessionId + ", stopping playback");
      return;
    }

    recordedAudio.current[sessionId].isPlaying = true;
    const pcmData = recordedAudio.current[sessionId].audioQueue.shift()!;

    if (audioContext.state === "suspended") {
      await audioContext.resume();
      console.log("AudioContext resumed for session " + sessionId + ", state: " + audioContext.state);
    }

    const maxAmplitude = Math.max(...pcmData.map(Math.abs));
    if (maxAmplitude < 0.02) {
      console.warn("Low amplitude audio for session " + sessionId + ": max=" + maxAmplitude);
    }

    // Resample to match AudioContext sample rate
    const outputSampleRate = audioContext.sampleRate;
    const resampledPcm = resampleAudio(pcmData, INPUT_SAMPLE_RATE, outputSampleRate);

    const audioBuffer = audioContext.createBuffer(1, resampledPcm.length, outputSampleRate);
    audioBuffer.getChannelData(0).set(resampledPcm);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start();
    console.log(
      "Playing audio for session " + sessionId + ", duration: " + (resampledPcm.length / outputSampleRate).toFixed(3) + "s, " +
      "sample rate: " + outputSampleRate + ", context time: " + audioContext.currentTime.toFixed(3)
    );

    source.onended = () => {
      source.disconnect();
      processAudioQueue(sessionId, audioContext);
    };
  };

  const createWavBlob = (pcmData: Float32Array, sampleRate: number): Blob => {
    const buffer = new ArrayBuffer(44 + pcmData.length * 2);
    const view = new DataView(buffer);

    const writeString = (str: string, offset: number) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString("RIFF", 0);
    view.setUint32(4, 36 + pcmData.length * 2, true);
    writeString("WAVE", 8);
    writeString("fmt ", 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // Mono
    view.setUint16(22, 1, true); // 1 channel
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString("data", 36);
    view.setUint32(40, pcmData.length * 2, true);

    let clippedSamples = 0;
    for (let i = 0; i < pcmData.length; i++) {
      const sample = Math.max(-1, Math.min(1, pcmData[i]));
      if (Math.abs(pcmData[i]) > 1) clippedSamples++;
      view.setInt16(44 + i * 2, sample * 32767, true);
    }
    if (clippedSamples > 0) console.warn("Clipped " + clippedSamples + " samples in WAV creation");

    return new Blob([buffer], { type: "audio/wav" });
  };

  const setupAudioRecording = async (
    sessionId: string,
    ws: WebSocket
  ): Promise<{
    audioContext: AudioContext;
    processor: AudioWorkletNode;
    input: MediaStreamAudioSourceNode;
  }> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 8000,
        },
      });

      const audioContext = new AudioContext({ sampleRate: 8000 });
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      console.log("AudioContext sample rate: " + audioContext.sampleRate + ", state: " + audioContext.state);

      const processorCode = `
        class PCMUEncoder {
          static encode(input) {
            const output = new Uint8Array(input.length);
            for (let i = 0; i < input.length; i++) {
              output[i] = this.linearToMuLaw(input[i] * 32767);
            }
            return output;
          }

          static linearToMuLaw(sample) {
            const MU = 255;
            // No clipping here; assume input is normalized to [-1, 1]
            const sign = sample < 0 ? 0x80 : 0;
            sample = Math.abs(sample);

            const biased = sample + 132;
            if (biased < 132) {
              return sign | 0x7F;
            }

            const exponent = Math.floor(Math.log2(biased / (1 + MU)));
            const mantissa = Math.floor(biased / (2 ** (exponent + 5))) - 16;

            const finalExponent = Math.max(0, Math.min(exponent, 7));
            const finalMantissa = Math.max(0, Math.min(mantissa, 15));

            const muLaw = ~(sign | (finalExponent << 4) | finalMantissa);
            return muLaw & 0xFF;
          }
        }

        class PCMUProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.sampleIndex = 0;
            this.useTestSignal = false;
          }

          process(inputs, outputs, parameters) {
            let inputData;
            if (this.useTestSignal) {
              inputData = new Float32Array(128);
              for (let i = 0; i < inputData.length; i++) {
                inputData[i] = Math.sin(2 * Math.PI * 440 * (this.sampleIndex / 8000)) * 0.5;
                this.sampleIndex++;
              }
            } else {
              const input = inputs[0];
              inputData = input.length > 0 ? input[0] : new Float32Array(128);
            }

            // Normalize input to prevent clipping
            const maxAmplitude = Math.max(...inputData.map(Math.abs));
            const scale = maxAmplitude > 0 ? Math.min(1, 0.95 / maxAmplitude) : 1;
            const normalizedData = new Float32Array(inputData.length);
            let clippedSamples = 0;
            for (let i = 0; i < inputData.length; i++) {
              const normalized = inputData[i] * scale;
              normalizedData[i] = Math.max(-1, Math.min(1, normalized));
              if (Math.abs(normalized) > 1) clippedSamples++;
            }

            console.log("Input PCM: length=" + normalizedData.length + ", first 10 samples=" + Array.from(normalizedData.slice(0, 10)).join(',') + ", max amplitude=" + maxAmplitude);
            if (clippedSamples > 0) console.warn("Clipped " + clippedSamples + " samples in chunk (should be rare)");
            if (maxAmplitude < 0.02) {
              console.warn("Chunk has low amplitude (max=" + maxAmplitude + "), skipping transmission");
              return true;
            }

            const pcmuData = PCMUEncoder.encode(normalizedData);
            console.log("Encoded PCMU: length=" + pcmuData.length + ", first 10 bytes=" + Array.from(pcmuData.slice(0, 10)).join(','));
            this.port.postMessage({ type: 'level', value: maxAmplitude }, []);
            this.port.postMessage({ type: 'audio', data: pcmuData }, [pcmuData.buffer]);
            return true;
          }
        }
        registerProcessor("pcmu-processor", PCMUProcessor);
      `;
      const blob = new Blob([processorCode], { type: "application/javascript" });
      const blobURL = URL.createObjectURL(blob);

      try {
        await audioContext.audioWorklet.addModule(blobURL);
      } catch (error) {
        console.error("Error loading AudioWorklet module for session " + sessionId + ":", error);
        throw error;
      } finally {
        URL.revokeObjectURL(blobURL);
      }

      const input = audioContext.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(audioContext, "pcmu-processor");

      processor.port.onmessage = (event) => {
        if (event.data.type === 'level') {
          setAudioLevels((prev) => ({ ...prev, [sessionId]: event.data.value }));
        } else if (event.data.type === 'audio' && ws.readyState === WebSocket.OPEN) {
          ws.send(event.data.data);
        }
      };

      input.connect(processor);
      processor.connect(audioContext.destination);

      return { audioContext, processor, input };
    } catch (error) {
      console.error("Error setting up audio recording for session " + sessionId + ":", error);
      throw error;
    }
  };

  const stopCall = (sessionId: string) => {
    console.log("Stopping call for session " + sessionId);
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) return;

    if (session.processor) {
      session.processor.disconnect();
      (session.processor as AudioWorkletNode).port.close();
    }

    if (session.input) {
      session.input.disconnect();
      session.input.mediaStream.getTracks().forEach((track) => track.stop());
    }

    if (session.audioContext && session.audioContext.state !== "closed") {
      session.audioContext.close();
    }

    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      const closeMessage: WebSocketMessage = {
        type: "close",
        id: sessionId,
      };
      session.ws.send(JSON.stringify(closeMessage));
      session.ws.close();
    }

    if (audioRefs.current[sessionId]) {
      URL.revokeObjectURL(audioRefs.current[sessionId].url);
      delete audioRefs.current[sessionId];
    }

    if (recordedAudio.current[sessionId] && recordedAudio.current[sessionId].chunks.length > 0) {
      const totalLength = recordedAudio.current[sessionId].chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const combinedPcm = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of recordedAudio.current[sessionId].chunks) {
        combinedPcm.set(chunk, offset);
        offset += chunk.length;
      }
      const maxAmplitude = Math.max(...combinedPcm.map(Math.abs));
      console.log("Saving recorded audio for session " + sessionId + ", samples: " + totalLength + ", first 10 samples: " + Array.from(combinedPcm.slice(0, 10)).join(',') + ", max amplitude: " + maxAmplitude);

      const pcmInt16 = new Int16Array(combinedPcm.length);
      let clippedSamples = 0;
      for (let i = 0; i < combinedPcm.length; i++) {
        const sample = Math.max(-32768, Math.min(32767, Math.round(combinedPcm[i] * 32767)));
        if (Math.abs(combinedPcm[i] * 32767) > 32767) clippedSamples++;
        pcmInt16[i] = sample;
      }
      if (clippedSamples > 0) console.warn("Clipped " + clippedSamples + " samples in saved PCM for session " + sessionId);
      const rawBlob = new Blob([pcmInt16.buffer], { type: 'application/octet-stream' });
      const rawUrl = URL.createObjectURL(rawBlob);
      const rawLink = document.createElement("a");
      rawLink.href = rawUrl;
      rawLink.download = "recorded_audio_" + sessionId + "_raw_pcm.bin";
      rawLink.click();
      URL.revokeObjectURL(rawUrl);

      const blob = createWavBlob(combinedPcm, INPUT_SAMPLE_RATE);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "recorded_audio_" + sessionId + ".wav";
      link.click();
      URL.revokeObjectURL(url);
    } else {
      console.warn("No recorded audio for session " + sessionId);
    }

    delete recordedAudio.current[sessionId];
    setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
    setIsRecording((prev) => {
      const updated = { ...prev };
      delete updated[sessionId];
      return updated;
    });
    setConnectionStatus((prev) => {
      const updated = { ...prev };
      delete updated[sessionId];
      return updated;
    });
    setAudioLevels((prev) => {
      const updated = { ...prev };
      delete updated[sessionId];
      return updated;
    });
  };

  const pauseCall = (sessionId: string) => {
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (session && session.audioContext) {
      session.audioContext.suspend();
      setIsRecording((prev) => ({ ...prev, [sessionId]: false }));
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: "pause", id: sessionId }));
      }
    }
  };

  const resumeCall = (sessionId: string) => {
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (session && session.audioContext) {
      session.audioContext.resume();
      setIsRecording((prev) => ({ ...prev, [sessionId]: true }));
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: "resume", id: sessionId }));
      }
    }
  };

  const clearTranscriptions = (sessionId: string) => {
    setTranscriptions((prev) => ({
      ...prev,
      [sessionId]: [],
    }));
  };

  useEffect(() => {
    return () => {
      sessions.forEach((session) => stopCall(session.sessionId));
    };
  }, []);

  return (
    <div className="App">
      <header className="app-header">
        <h1>Genesys Cloud AudioHook Mock</h1>
        <p className="subtitle">Web Call Simulation & Audio Processing</p>
      </header>

      <div className="controls">
        <button
          className="start-call-btn"
          onClick={startCall}
          disabled={sessions.length >= MAX_SESSIONS || isStarting}
          aria-label="Start a new call session"
          aria-disabled={sessions.length >= MAX_SESSIONS || isStarting}
        >
          {isStarting ? "Starting..." : "Start New Call Session"}
        </button>
        {sessions.length >= MAX_SESSIONS && (
          <p className="warning">Maximum {MAX_SESSIONS} concurrent sessions allowed</p>
        )}
      </div>

      <div className="sessions-container">
        <h2>Active Call Sessions ({sessions.length})</h2>

        {sessions.length === 0 ? (
          <div className="no-sessions">
            <p>No active call sessions. Click "Start New Call Session" to begin.</p>
          </div>
        ) : (
          <div className="sessions-grid">
            {sessions.map((session) => (
              <div key={session.sessionId} className="session-card">
                <div className="session-header">
                  <h3>Session</h3>
                  <span className="session-id">
                    {session.sessionId.slice(0, 8)}...
                  </span>
                </div>
                <p>Status: {connectionStatus[session.sessionId] || "Unknown"}</p>
                <p>Recording: {isRecording[session.sessionId] ? "Active" : "Paused"}</p>
                <p>Audio Level: {(audioLevels[session.sessionId] || 0).toFixed(4)}</p>
                
                <div className="session-controls">
                  <button
                    onClick={() => pauseCall(session.sessionId)}
                    disabled={!isRecording[session.sessionId]}
                  >
                    Pause
                  </button>
                  <button
                    onClick={() => resumeCall(session.sessionId)}
                    disabled={isRecording[session.sessionId]}
                  >
                    Resume
                  </button>
                  <button onClick={() => stopCall(session.sessionId)}>
                    Stop
                  </button>
                  <button onClick={() => clearTranscriptions(session.sessionId)}>
                    Clear Transcriptions
                  </button>
                </div>
                <div className="transcriptions">
                  <h4>Transcriptions</h4>
                  {transcriptions[session.sessionId]?.length ? (
                    <ul>
                      {transcriptions[session.sessionId].map((t, index) => (
                        <li key={index}>
                          [{new Date(t.timestamp).toLocaleTimeString()}]: {t.text}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No transcriptions yet.</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default App;