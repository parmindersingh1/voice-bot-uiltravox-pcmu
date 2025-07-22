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
let processor: ScriptProcessorNode | null = null;
let audioContext: AudioContext | null = null;
let stream: MediaStream | null = null;
let currentAudio: HTMLAudioElement | null = null;

const App: React.FC = () => {
  const [context, setContext] = React.useState<string>("");
  const [userText, setUserText] = React.useState<string>("...");
  const [agentText, setAgentText] = React.useState<string>("...");
  const [isConnected, setIsConnected] = React.useState<boolean>(false);

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
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
      socket = null;
      console.log("🛑 WebSocket closed");
    }

    if (processor) {
      processor.disconnect();
      processor.onaudioprocess = null;
    }

    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }

    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }

    setIsConnected(false);
    console.log("🛑 Stopped mic stream and cleaned up");
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
        console.log("🎧 Playing audio response...");
        playAudio(data);
      } else {
        const msg: WebSocketMessage = JSON.parse(data);
        console.log("📨 Received message:", msg);

        if (msg.type === "transcript") {
          setUserText(msg.transcript || "...");
        } else if (msg.type === "response") {
          setAgentText(msg.text || "(no reply)");
        } else if (msg.type === "playback_clear_buffer") {
          if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = "";
            currentAudio = null;
            console.log("🧹 Audio buffer cleared");
          }
        } else if (msg.type === "connected") {
          startMicStream();
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
    };
  };

  const startMicStream = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new AudioContext({ sampleRate: 48000 });
      console.log("🎛️ Actual mic sample rate:", audioContext.sampleRate);

      const source: MediaStreamAudioSourceNode =
        audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(8192, 1, 1);

      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        const input: Float32Array = e.inputBuffer.getChannelData(0);
        const buffer: ArrayBuffer = convertFloat32ToInt16(input);
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(buffer);
        }
      };

      console.log("🎙️ Mic stream started");
    } catch (err) {
      console.error("❌ Failed to access microphone:", err);
      alert("Microphone permission denied or not available");
    }
  };

  const convertFloat32ToInt16 = (buffer: Float32Array): ArrayBuffer => {
    const l: number = buffer.length;
    const buf: Int16Array = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      buf[i] = Math.max(-1, Math.min(1, buffer[i])) * 32767;
    }
    return buf.buffer;
  };

  const playAudio = (arrayBuffer: ArrayBuffer) => {
    try {
      const wavBuffer: ArrayBuffer = encodeWav(arrayBuffer, {
        channels: 1,
        sampleRate: 48000,
        bitDepth: 16,
      });

      const blob: Blob = new Blob([wavBuffer], { type: "audio/wav" });
      const url: string = URL.createObjectURL(blob);
      const audio: HTMLAudioElement = new Audio(url);
      currentAudio = audio;

      audio.play().catch((err: Error) => {
        console.error("🔈 Playback error:", err);
      });
    } catch (err) {
      console.error("🎧 Failed to play audio:", err);
    }
  };

  interface EncodeWavOptions {
    channels?: number;
    sampleRate?: number;
    bitDepth?: number;
  }

  const encodeWav = (
    samples: ArrayBuffer,
    options: EncodeWavOptions
  ): ArrayBuffer => {
    const { channels = 1, sampleRate = 48000, bitDepth = 16 } = options;
    const bytesPerSample: number = bitDepth / 8;
    const blockAlign: number = channels * bytesPerSample;
    const byteRate: number = sampleRate * blockAlign;
    const dataSize: number = samples.byteLength;

    const buffer: ArrayBuffer = new ArrayBuffer(44 + dataSize);
    const view: DataView = new DataView(buffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);

    new Uint8Array(buffer, 44).set(new Uint8Array(samples));
    return buffer;
  };

  const writeString = (view: DataView, offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-8 text-gray-800">
      <h1 className="text-2xl font-bold mb-6">
        🎤 Real-Time AI Meeting Assistant
      </h1>
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
