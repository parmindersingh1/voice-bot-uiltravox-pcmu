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

// Audio playback globals
let playbackContext: AudioContext | null = null;
let audioQueue: ArrayBuffer[] = [];
let isAudioPlaying = false;
let nextPlayTime = 0;

const App: React.FC = () => {
  const [context, setContext] = React.useState<string>("");
  const [userText, setUserText] = React.useState<string>("...");
  const [agentText, setAgentText] = React.useState<string>("...");
  const [isConnected, setIsConnected] = React.useState<boolean>(false);
  const [sampleRate] = React.useState<number>(8000);

  const startConversation = async () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      console.log("🟡 Already connected");
      return;
    }

    if (!context.trim()) {
      alert("Please enter context");
      return;
    }

    // const wsUrl = `ws://localhost:3001?context=${encodeURIComponent(context)}`;
    const wsUrl = `ws://localhost:8765?context=${encodeURIComponent(context)}&sampleRate=${sampleRate}`;
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
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close();
      audioContext = null;
    }

    if (playbackContext && playbackContext.state !== 'closed') {
      playbackContext.close();
      playbackContext = null;
    }

    // Clear playback buffers
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
      // Initialize playback context with proper settings
      playbackContext = new AudioContext({ 
        sampleRate,
        latencyHint: 'interactive'
      });
      
      // Resume context if suspended
      if (playbackContext.state === 'suspended') {
        await playbackContext.resume();
      }
      
      console.log(`🎛️ Playback context: ${playbackContext.sampleRate}Hz, state: ${playbackContext.state}`);

      // Initialize recording
      await initializeRecording();
      
      console.log("🎛️ Audio system initialized");
    } catch (err) {
      console.error("❌ Failed to initialize audio:", err);
      alert("Audio initialization failed");
    }
  };

  // Improved µ-law encoding with proper bit manipulation
  const linearToPcmu = (sample: number): number => {
    const BIAS = 0x84;
    const CLIP = 32635;
    
    // Clamp input
    sample = Math.max(-32768, Math.min(32767, sample));
    
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    
    let exponent = 7;
    for (let exp_lut = 0x4000; sample < exp_lut && exponent > 0; exp_lut >>= 1, exponent--);
    
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    const companded = ~(sign | (exponent << 4) | mantissa);
    
    return companded & 0xFF;
  };

  // Improved µ-law decoding
  const pcmuToLinear = (pcmu: number): number => {
    const BIAS = 0x84;
    
    pcmu = ~pcmu;
    const sign = pcmu & 0x80;
    const exponent = (pcmu >> 4) & 0x07;
    const mantissa = pcmu & 0x0F;
    
    let sample = mantissa << (exponent + 3);
    sample += BIAS;
    if (exponent === 0) sample -= 4;
    
    return sign ? -sample : sample;
  };

  // Updated audio worklet processor with better buffering
  const getPcmuProcessorCode = (): string => {
    return `
      class PCMUProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.chunkSize = 320; // 40ms at 8kHz
          this.buffer = new Float32Array(this.chunkSize);
          this.bufferIndex = 0;
        }

        linearToPcmu(sample) {
          const BIAS = 0x84;
          const CLIP = 32635;
          
          sample = Math.max(-32768, Math.min(32767, sample));
          
          let sign = (sample >> 8) & 0x80;
          if (sign) sample = -sample;
          
          if (sample > CLIP) sample = CLIP;
          sample += BIAS;
          
          let exponent = 7;
          for (let exp_lut = 0x4000; sample < exp_lut && exponent > 0; exp_lut >>= 1, exponent--);
          
          const mantissa = (sample >> (exponent + 3)) & 0x0F;
          const companded = ~(sign | (exponent << 4) | mantissa);
          
          return companded & 0xFF;
        }

        process(inputs, outputs, parameters) {
          const input = inputs[0];
          if (!input || !input[0]) return true;

          const samples = input[0];

          for (let i = 0; i < samples.length; i++) {
            this.buffer[this.bufferIndex++] = samples[i];

            if (this.bufferIndex === this.chunkSize) {
              const pcmuData = new Uint8Array(this.chunkSize);
              let hasAudio = false;
              
              for (let j = 0; j < this.chunkSize; j++) {
                const sample = Math.max(-1, Math.min(1, this.buffer[j]));
                const pcm16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                pcmuData[j] = this.linearToPcmu(Math.round(pcm16));
                if (Math.abs(sample) > 0.001) hasAudio = true; // Check for actual audio
              }
              
              // Only send if we have actual audio content
              if (hasAudio) {
                this.port.postMessage({ pcmuData: pcmuData.buffer });
              }
              
              this.bufferIndex = 0;
            }
          }

          return true;
        }
      }

      registerProcessor("pcmu-processor", PCMUProcessor);
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
          autoGainControl: false, // Re-enable AGC
        }
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Create audio context for recording
      audioContext = new AudioContext({ 
        sampleRate,
        latencyHint: 'interactive'
      });
      
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      
      console.log(`🎙️ Recording context: ${audioContext.sampleRate}Hz, state: ${audioContext.state}`);

      // Create and load audio worklet
      const processorCode = getPcmuProcessorCode();
      const blob = new Blob([processorCode], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);

      await audioContext.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);

      workletNode = new AudioWorkletNode(audioContext, "pcmu-processor");
      
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(workletNode);
      // Don't connect worklet to destination to avoid feedback

      // Handle PCMU data from worklet
      workletNode.port.onmessage = (event) => {
        if (event.data.pcmuData && socket?.readyState === WebSocket.OPEN) {
          socket.send(event.data.pcmuData);
        }
      };

      isRecording = true;
      console.log("🎙️ PCMU recording started");
    } catch (err) {
      console.error("❌ Failed to initialize recording:", err);
      throw err;
    }
  };

  // Improved audio playback with better scheduling
  const handleIncomingAudioBuffer = (arrayBuffer: ArrayBuffer) => {
    audioQueue.push(arrayBuffer);
    if (!isAudioPlaying && playbackContext) {
      scheduleAudioPlayback();
    }
  };

  const scheduleAudioPlayback = async () => {
    if (audioQueue.length === 0) {
      isAudioPlaying = false;
      return;
    }

    if (!playbackContext || playbackContext.state !== 'running') {
      console.warn("⚠️ Playback context not ready");
      return;
    }

    isAudioPlaying = true;

    while (audioQueue.length > 0) {
      const chunk = audioQueue.shift()!;
      
      try {
        // Convert PCMU data to AudioBuffer with better error handling
        const pcmuSamples = new Uint8Array(chunk);
        
        // Validate data
        if (pcmuSamples.length === 0) {
          continue;
        }
        
        const audioBuffer = playbackContext.createBuffer(1, pcmuSamples.length, sampleRate);
        const audioData = audioBuffer.getChannelData(0);
        
        // Decode µ-law to linear PCM with validation
        let hasValidAudio = false;
        for (let i = 0; i < pcmuSamples.length; i++) {
          const linearSample = pcmuToLinear(pcmuSamples[i]);
          const normalizedSample = linearSample / 32768.0;
          audioData[i] = Math.max(-1, Math.min(1, normalizedSample)); // Clamp to valid range
          if (Math.abs(normalizedSample) > 0.001) hasValidAudio = true;
        }
        
        // Only play if we have valid audio
        if (!hasValidAudio) {
          continue;
        }

        // Schedule playback with proper timing
        const sourceNode = playbackContext.createBufferSource();
        sourceNode.buffer = audioBuffer;
        
        // Add a small gain node to control volume if needed
        const gainNode = playbackContext.createGain();
        gainNode.gain.setValueAtTime(1.0, playbackContext.currentTime);
        
        sourceNode.connect(gainNode);
        gainNode.connect(playbackContext.destination);
        
        // Schedule with proper timing
        const playTime = Math.max(playbackContext.currentTime, nextPlayTime);
        sourceNode.start(playTime);
        
        // Update next play time (assume 20ms chunks)
        nextPlayTime = playTime + audioBuffer.duration;
        
        console.log(`🔊 Scheduled audio chunk: ${pcmuSamples.length} samples at ${playTime.toFixed(3)}s`);

      } catch (err) {
        console.error("❌ Error processing audio chunk:", err);
      }
      
      // Small delay to prevent overwhelming the audio system
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    isAudioPlaying = false;
  };

  const stopAudioPlayback = () => {
    audioQueue = [];
    isAudioPlaying = false;
    nextPlayTime = 0;
    
    if (playbackContext) {
      nextPlayTime = playbackContext.currentTime;
    }
    
    console.log("🧹 Audio playback stopped and queue cleared");
  };

  return (
    <div className="min-h-screen bg-gray-100 p-8 text-gray-800">
      <h1 className="text-2xl font-bold mb-6">
        🎤 Real-Time AI Meeting Assistant (PCMU µ-law 8kHz) - Fixed Version
      </h1>
      
      <div className="mb-4">
        <div className="text-sm text-gray-600 mb-2">
          Sample Rate: {sampleRate}Hz | PCMU (µ-law) Encoding | 320 samples/chunk (40ms)
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