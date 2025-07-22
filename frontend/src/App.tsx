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
let mediaRecorder: MediaRecorder | null = null;
let audioWorkletNode: AudioWorkletNode | null = null;
let isRecording = false;

// Audio playback globals
let playbackContext: AudioContext | null = null;
let audioBuffer: Float32Array[] = [];
let isPlayingAudio = false;
let nextPlayTime = 0;

const App: React.FC = () => {
  const [context, setContext] = React.useState<string>("");
  const [userText, setUserText] = React.useState<string>("...");
  const [agentText, setAgentText] = React.useState<string>("...");
  const [isConnected, setIsConnected] = React.useState<boolean>(false);
  const [bufferSize, setBufferSize] = React.useState<number>(4096);

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
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    mediaRecorder = null;

    // Stop audio worklet
    if (audioWorkletNode) {
      audioWorkletNode.disconnect();
      audioWorkletNode = null;
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

    // Clear playback buffers
    audioBuffer = [];
    isPlayingAudio = false;
    nextPlayTime = 0;
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
        handleIncomingAudio(data);
      } else {
        const msg: WebSocketMessage = JSON.parse(data);
        console.log("📨 Received message:", msg);

        if (msg.type === "transcript") {
          setUserText(msg.transcript || "...");
        } else if (msg.type === "response") {
          setAgentText(msg.text || "(no reply)");
        } else if (msg.type === "playback_clear_buffer") {
          clearAudioBuffers();
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
        sampleRate: 48000,
        latencyHint: 'interactive'
      });
      await playbackContext.resume();

      // Initialize recording
      await initializeRecording();
      
      console.log("🎛️ Audio system initialized");
    } catch (err) {
      console.error("❌ Failed to initialize audio:", err);
      alert("Audio initialization failed");
    }
  };

  const initializeRecording = async () => {
    try {
      const constraints = {
        audio: {
          sampleRate: 48000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false, // Disable AGC to prevent artifacts
          googEchoCancellation: true,
          googNoiseSuppression: true,
          googAutoGainControl: false
        }
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Use MediaRecorder for cleaner audio capture
      const options = {
        mimeType: 'audio/webm;codecs=pcm',
        audioBitsPerSecond: 768000 // High bitrate for quality
      };

      // Fallback MIME types if PCM not supported
      const supportedTypes = [
        'audio/webm;codecs=pcm',
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4'
      ];

      let mimeType = '';
      for (const type of supportedTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          mimeType = type;
          break;
        }
      }

      if (!mimeType) {
        throw new Error('No supported audio format found');
      }

      console.log(`🎙️ Using MIME type: ${mimeType}`);
      
      mediaRecorder = new MediaRecorder(stream, { 
        mimeType,
        audioBitsPerSecond: 768000 
      });

      let audioChunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (audioChunks.length > 0) {
          const audioBlob = new Blob(audioChunks, { type: mimeType });
          await processAudioBlob(audioBlob);
          audioChunks = [];
        }
      };

      // Start recording with small intervals for low latency
      mediaRecorder.start(100); // 100ms chunks
      isRecording = true;

      // Set up interval to process chunks
      const recordingInterval = setInterval(() => {
        if (!isRecording || !mediaRecorder || mediaRecorder.state === 'inactive') {
          clearInterval(recordingInterval);
          return;
        }
        
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
          mediaRecorder.start(100);
        }
      }, 100);

      console.log("🎙️ MediaRecorder started");
    } catch (err) {
      console.error("❌ Failed to initialize recording:", err);
      // Fallback to Web Audio API
      await initializeWebAudioRecording();
    }
  };

  const initializeWebAudioRecording = async () => {
    try {
      audioContext = new AudioContext({ 
        sampleRate: 48000,
        latencyHint: 'interactive'
      });
      await audioContext.resume();

      const source = audioContext.createMediaStreamSource(stream!);
      
      // Create a ScriptProcessor as fallback
      const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
      
      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!isRecording) return;
        
        const input = e.inputBuffer.getChannelData(0);
        const smoothedInput = applySmoothing(input);
        const buffer = convertFloat32ToInt16Smooth(smoothedInput);
        
        if (socket && socket.readyState === WebSocket.OPEN && buffer.byteLength > 0) {
          socket.send(buffer);
        }
      };

      console.log("🎙️ Web Audio recording started as fallback");
    } catch (err) {
      console.error("❌ Web Audio recording failed:", err);
      throw err;
    }
  };

  const processAudioBlob = async (blob: Blob) => {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      
      if (!playbackContext) return;

      // Decode the audio to get raw PCM data
      const audioBuffer = await playbackContext.decodeAudioData(arrayBuffer);
      const channelData = audioBuffer.getChannelData(0);
      
      // Convert to 16-bit PCM and send
      const pcmBuffer = convertFloat32ToInt16Smooth(channelData);
      
      if (socket && socket.readyState === WebSocket.OPEN && pcmBuffer.byteLength > 0) {
        socket.send(pcmBuffer);
      }
    } catch (err) {
      console.error("❌ Failed to process audio blob:", err);
    }
  };

  const applySmoothing = (input: Float32Array): Float32Array => {
    const smoothed = new Float32Array(input.length);
    const alpha = 0.1; // Smoothing factor
    let prev = 0;
    
    for (let i = 0; i < input.length; i++) {
      smoothed[i] = alpha * input[i] + (1 - alpha) * prev;
      prev = smoothed[i];
    }
    
    return smoothed;
  };

  const convertFloat32ToInt16Smooth = (buffer: Float32Array): ArrayBuffer => {
    const length = buffer.length;
    const result = new Int16Array(length);
    
    for (let i = 0; i < length; i++) {
      // Apply soft limiting to prevent harsh clipping
      let sample = buffer[i];
      sample = Math.tanh(sample * 0.9); // Soft saturation
      sample = Math.max(-1, Math.min(1, sample));
      result[i] = Math.round(sample * 32767);
    }
    
    return result.buffer;
  };

  const handleIncomingAudio = async (arrayBuffer: ArrayBuffer) => {
    try {
      if (!playbackContext) {
        playbackContext = new AudioContext({ 
          sampleRate: 48000,
          latencyHint: 'interactive'
        });
        await playbackContext.resume();
      }

      // Convert raw PCM to audio buffer
      const audioData = await createAudioBufferFromPCM(arrayBuffer);
      if (audioData) {
        scheduleAudioPlayback(audioData);
      }
    } catch (err) {
      console.error("🎧 Audio playback error:", err);
    }
  };

  const createAudioBufferFromPCM = async (arrayBuffer: ArrayBuffer): Promise<AudioBuffer | null> => {
    try {
      if (!playbackContext) return null;

      const int16Array = new Int16Array(arrayBuffer);
      const float32Array = new Float32Array(int16Array.length);
      
      // Convert Int16 to Float32 with proper scaling
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768; // Proper scaling
      }

      // Create AudioBuffer
      const audioBuffer = playbackContext.createBuffer(1, float32Array.length, 48000);
      audioBuffer.copyToChannel(float32Array, 0);

      return audioBuffer;
    } catch (err) {
      console.error("❌ Failed to create audio buffer:", err);
      return null;
    }
  };

  const scheduleAudioPlayback = (audioBuffer: AudioBuffer) => {
    if (!playbackContext) return;

    const source = playbackContext.createBufferSource();
    source.buffer = audioBuffer;

    // Apply gentle filtering to reduce artifacts
    const filter = playbackContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(8000, playbackContext.currentTime);
    filter.Q.setValueAtTime(0.5, playbackContext.currentTime);

    // Add slight reverb for smoothness
    const convolver = playbackContext.createConvolver();
    const impulse = createImpulseResponse(playbackContext, 0.02, 0.3, false);
    convolver.buffer = impulse;

    source.connect(filter);
    filter.connect(convolver);
    convolver.connect(playbackContext.destination);

    // Schedule playback
    const now = playbackContext.currentTime;
    if (nextPlayTime <= now) {
      nextPlayTime = now;
    }

    source.start(nextPlayTime);
    nextPlayTime += audioBuffer.duration;

    // Clean up
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      convolver.disconnect();
    };
  };

  const createImpulseResponse = (
    context: AudioContext, 
    duration: number, 
    decay: number, 
    reverse: boolean
  ): AudioBuffer => {
    const length = context.sampleRate * duration;
    const impulse = context.createBuffer(2, length, context.sampleRate);
    
    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const n = reverse ? length - i : i;
        channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
      }
    }
    
    return impulse;
  };

  const clearAudioBuffers = () => {
    audioBuffer = [];
    nextPlayTime = 0;
    console.log("🧹 Audio buffers cleared");
  };

  return (
    <div className="min-h-screen bg-gray-100 p-8 text-gray-800">
      <h1 className="text-2xl font-bold mb-6">
        🎤 Real-Time AI Meeting Assistant (Enhanced Audio)
      </h1>
      
      <div className="mb-4">
        <label className="block text-sm font-medium mb-2">Audio Buffer Size:</label>
        <select 
          value={bufferSize} 
          onChange={(e) => setBufferSize(parseInt(e.target.value))}
          className="p-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isConnected}
        >
          <option value={2048}>2048 (Lowest Latency)</option>
          <option value={4096}>4096 (Balanced)</option>
          <option value={8192}>8192 (Highest Quality)</option>
        </select>
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
        Playback: {isPlayingAudio ? "🔊 Playing" : "🔇 Silent"}
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