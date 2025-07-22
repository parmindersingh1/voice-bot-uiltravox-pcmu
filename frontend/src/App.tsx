import React from "react";

// Type definitions
interface WebSocketMessage {
  type:
    | "transcript"
    | "response"
    | "playback_clear_buffer"
    | "connected"
    | "error";
  transcript?: string;
  text?: string;
  error?: string;
}

// Global variables
let socket: WebSocket | null = null;
let audioContext: AudioContext | null = null;
let stream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let isRecording = false;

// Audio playback globals (similar to audio-streamer pattern)
let playbackContext: AudioContext | null = null;
let audioQueue: ArrayBuffer[] = [];
let isAudioPlaying = false;
let currentSourceNode: AudioBufferSourceNode | null = null;

const App: React.FC = () => {
  const [context, setContext] = React.useState<string>("");
  const [userText, setUserText] = React.useState<string>("...");
  const [agentText, setAgentText] = React.useState<string>("...");
  const [isConnected, setIsConnected] = React.useState<boolean>(false);
  const [sampleRate] = React.useState<number>(48000); // Fixed sample rate

  const startConversation = async () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      console.log("🟡 Already connected");
      return;
    }

    if (!context.trim()) {
      alert("Please enter context");
      return;
    }

    const wsUrl = `ws://localhost:3001?context=${encodeURIComponent(context)}`;
    connectToWebsocket(wsUrl);
  };

  const stopConversation = () => {
    cleanup();
    setIsConnected(false);
    console.log("🛑 Stopped conversation and cleaned up");
  };

  const cleanup = () => {
    // Stop WebSocket
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
      socket = null;
    }

    // Stop recording
    isRecording = false;
    
    // Stop audio worklet
    if (workletNode) {
      workletNode.disconnect();
      workletNode = null;
    }

    // Stop stream
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }

    // Close audio contexts
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }

    if (playbackContext) {
      playbackContext.close();
      playbackContext = null;
    }

    // Clear playback buffers (audio-streamer pattern)
    stopAudioPlayback();
  };

  const connectToWebsocket = (url: string) => {
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      console.log("✅ Connected to server WebSocket");
    };

    socket.onmessage = (event: MessageEvent) => {
      const data = event.data;

      if (data instanceof ArrayBuffer) {
        console.log(`🎧 Received audio chunk: ${data.byteLength} bytes`);
        // Use audio-streamer pattern for handling incoming audio
        handleIncomingAudioBuffer(data);
      } else {
        const msg: WebSocketMessage = JSON.parse(data);
        console.log("📨 Received message:", msg);

        if (msg.type === "transcript") {
          setUserText(msg.transcript || "...");
        } else if (msg.type === "response") {
          setAgentText(msg.text || "(no reply)");
        } else if (msg.type === "playback_clear_buffer") {
          stopAudioPlayback();
        } else if (msg.type === "connected") {
          initializeAudio();
          setIsConnected(true);
        } else if (msg.error) {
          console.error("❌ Server error:", msg.error);
          alert(`Error: ${msg.error}`);
        }
      }
    };

    socket.onerror = (err: Event) => console.error("❌ WebSocket error:", err);
    socket.onclose = () => {
      console.log("🔌 Socket closed by server");
      setIsConnected(false);
      cleanup();
    };
  };

  const initializeAudio = async () => {
    try {
      // Initialize playback context first
      playbackContext = new AudioContext({ 
        sampleRate,
        latencyHint: 'interactive'
      });
      await playbackContext.resume();

      // Initialize recording using audio-streamer pattern
      await initializeRecording();
      
      console.log("🎛️ Audio system initialized");
    } catch (err) {
      console.error("❌ Failed to initialize audio:", err);
      alert("Audio initialization failed");
    }
  };

  // Audio worklet processor code (similar to audio-streamer PCMProcessor)
  const getPcmProcessorCode = (): string => {
    return `
      class PCMProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.chunkSize = 2048; // Smaller chunk size for lower latency
          this.buffer = new Float32Array(this.chunkSize);
          this.bufferIndex = 0;
        }

        process(inputs, outputs, parameters) {
          const input = inputs[0];
          if (!input || !input[0]) return true;

          const samples = input[0];

          for (let i = 0; i < samples.length; i++) {
            this.buffer[this.bufferIndex++] = samples[i];

            if (this.bufferIndex === this.chunkSize) {
              const pcmData = new Int16Array(this.chunkSize);
              for (let j = 0; j < this.chunkSize; j++) {
                const sample = Math.max(-1, Math.min(1, this.buffer[j]));
                pcmData[j] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
              }
              this.port.postMessage({ pcmData: pcmData.buffer });
              this.bufferIndex = 0;
            }
          }

          return true;
        }
      }

      registerProcessor("pcm-processor", PCMProcessor);
    `;
  };

  const initializeRecording = async () => {
    try {
      const constraints = {
        audio: {
          sampleRate,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        }
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Create audio context for recording
      audioContext = new AudioContext({ 
        sampleRate,
        latencyHint: 'interactive'
      });
      await audioContext.resume();

      // Create and load audio worklet (audio-streamer pattern)
      const processorCode = getPcmProcessorCode();
      const blob = new Blob([processorCode], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);

      await audioContext.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);

      workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
      
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(workletNode);
      workletNode.connect(audioContext.destination);

      // Handle PCM data from worklet (audio-streamer pattern)
      workletNode.port.onmessage = (event) => {
        if (event.data.pcmData && socket?.readyState === WebSocket.OPEN) {
          const pcmData = event.data.pcmData;
          socket.send(pcmData);
        }
      };

      isRecording = true;
      console.log("🎙️ Recording started with audio worklet");
    } catch (err) {
      console.error("❌ Failed to initialize recording:", err);
      throw err;
    }
  };

  // Audio playback using audio-streamer pattern
  const handleIncomingAudioBuffer = (arrayBuffer: ArrayBuffer) => {
    // Add to queue like audio-streamer
    audioQueue.push(arrayBuffer);
    if (!isAudioPlaying && playbackContext) {
      processAudioQueue();
    }
  };

  const processAudioQueue = async () => {
    if (audioQueue.length === 0) {
      isAudioPlaying = false;
      return;
    }

    if (!playbackContext) return;

    isAudioPlaying = true;

    const chunk = audioQueue.shift()!;
    
    try {
      // Convert PCM data to AudioBuffer (audio-streamer style)
      const samples = new Int16Array(chunk);
      const audioBuffer = playbackContext.createBuffer(1, samples.length, sampleRate);
      const audioData = audioBuffer.getChannelData(0);
      
      // Convert Int16 to Float32 (audio-streamer conversion)
      for (let i = 0; i < samples.length; i++) {
        audioData[i] = samples[i] / 32768.0;
      }

      // Create and play buffer source
      const sourceNode = playbackContext.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(playbackContext.destination);
      sourceNode.start();
      currentSourceNode = sourceNode;

      // Continue processing queue when this chunk ends
      sourceNode.onended = () => {
        processAudioQueue();
      };

    } catch (err) {
      console.error("❌ Error processing audio chunk:", err);
      // Continue with next chunk even if this one failed
      processAudioQueue();
    }
  };

  const stopAudioPlayback = () => {
    // Stop current playback (audio-streamer pattern)
    if (currentSourceNode) {
      try {
        currentSourceNode.stop();
        currentSourceNode.disconnect();
      } catch (err) {
        // Ignore errors if already stopped
      }
      currentSourceNode = null;
    }
    audioQueue = [];
    isAudioPlaying = false;
    console.log("🧹 Audio playback stopped and queue cleared");
  };

  return (
    <div className="min-h-screen bg-gray-100 p-8 text-gray-800">
      <h1 className="text-2xl font-bold mb-6">
        🎤 Real-Time AI Meeting Assistant (Audio-Streamer Pattern)
      </h1>
      
      <div className="mb-4">
        <div className="text-sm text-gray-600 mb-2">
          Sample Rate: {sampleRate}Hz | Worklet-based Processing
        </div>
      </div>

      <div className="flex items-center space-x-2 mb-4">
        <input
          type="text"
          value={context}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setContext(e.target.value)
          }
          placeholder="Enter meeting context..."
          className="w-96 p-2 text-lg border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={startConversation}
          disabled={isConnected}
          className={`px-4 py-2 text-lg rounded-lg text-white ${
            isConnected
              ? "bg-gray-400 cursor-not-allowed"
              : "bg-blue-500 hover:bg-blue-600"
          }`}
        >
          Start
        </button>
        <button
          onClick={stopConversation}
          disabled={!isConnected}
          className={`px-4 py-2 text-lg rounded-lg text-white ${
            !isConnected
              ? "bg-gray-400 cursor-not-allowed"
              : "bg-red-500 hover:bg-red-600"
          }`}
        >
          Stop
        </button>
      </div>

      <div className="mb-4 text-sm text-gray-600">
        Status: {isConnected ? "🟢 Connected" : "🔴 Disconnected"} | 
        Recording: {isRecording ? "🎙️ Active" : "⏸️ Inactive"} | 
        Playback: {isAudioPlaying ? "🔊 Playing" : "🔇 Silent"} | 
        Queue: {audioQueue.length} chunks
      </div>

      <div className="space-y-4">
        <div className="p-4 bg-white rounded-lg shadow-md border-l-4 border-blue-500 max-w-3xl">
          <span className="font-semibold">🗣️ You: </span>
          <span>{userText}</span>
        </div>
        <div className="p-4 bg-white rounded-lg shadow-md border-l-4 border-green-500 max-w-3xl">
          <span className="font-semibold">🤖 Agent: </span>
          <span>{agentText}</span>
        </div>
      </div>
    </div>
  );
};

export default App;