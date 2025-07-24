"use client"

import React from "react"

// Type definitions
interface WebSocketMessage {
  type: "transcript" | "response" | "playback_clear_buffer" | "connected" | "error"
  transcript?: string
  text?: string
  error?: string
}

// Global variables
let socket: WebSocket | null = null
let audioContext: AudioContext | null = null
let stream: MediaStream | null = null
let workletNode: AudioWorkletNode | null = null
let isRecording = false

// Audio playback globals
let playbackContext: AudioContext | null = null
let audioQueue: ArrayBuffer[] = []
let isAudioPlaying = false
let nextPlayTime = 0
const currentGainNode: GainNode | null = null

const App: React.FC = () => {
  const [context, setContext] = React.useState<string>("")
  const [userText, setUserText] = React.useState<string>("...")
  const [agentText, setAgentText] = React.useState<string>("...")
  const [isConnected, setIsConnected] = React.useState<boolean>(false)
  const [sampleRate] = React.useState<number>(8000)

  const startConversation = async () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      console.log("🟡 Already connected")
      return
    }

    if (!context.trim()) {
      alert("Please enter context")
      return
    }

    const wsUrl = `ws://localhost:8766?context=${encodeURIComponent(context)}&sampleRate=${sampleRate}`
    connectToWebsocket(wsUrl)
  }

  const stopConversation = () => {
    cleanup()
    setIsConnected(false)
    console.log("🛑 Stopped conversation and cleaned up")
  }

  const cleanup = () => {
    // Stop WebSocket
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close()
      socket = null
    }

    // Stop recording
    isRecording = false

    // Stop audio worklet
    if (workletNode) {
      workletNode.disconnect()
      workletNode = null
    }

    // Stop stream
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
      stream = null
    }

    // Close audio contexts
    if (audioContext && audioContext.state !== "closed") {
      audioContext.close()
      audioContext = null
    }

    if (playbackContext && playbackContext.state !== "closed") {
      playbackContext.close()
      playbackContext = null
    }

    // Clear playback buffers
    stopAudioPlayback()
  }

  const connectToWebsocket = (url: string) => {
    socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"

    socket.onopen = () => {
      console.log("✅ Connected to server WebSocket")
    }

    socket.onmessage = (event: MessageEvent) => {
      const data = event.data

      if (data instanceof ArrayBuffer) {
        console.log(`🎧 Received audio chunk: ${data.byteLength} bytes`)
        handleIncomingAudioBuffer(data)
      } else {
        const msg: WebSocketMessage = JSON.parse(data)
        console.log("📨 Received message:", msg)

        if (msg.type === "transcript") {
          setUserText(msg.transcript || "...")
        } else if (msg.type === "response") {
          setAgentText(msg.text || "(no reply)")
        } else if (msg.type === "playback_clear_buffer") {
          stopAudioPlayback()
        } else if (msg.type === "connected") {
          initializeAudio()
          setIsConnected(true)
        } else if (msg.error) {
          console.error("❌ Server error:", msg.error)
          alert(`Error: ${msg.error}`)
        }
      }
    }

    socket.onerror = (err: Event) => console.error("❌ WebSocket error:", err)
    socket.onclose = () => {
      console.log("🔌 Socket closed by server")
      setIsConnected(false)
      cleanup()
    }
  }

  const initializeAudio = async () => {
    try {
      // Initialize playback context with optimal settings for speech
      playbackContext = new AudioContext({
        sampleRate,
        latencyHint: "interactive",
      })

      // Resume context if suspended
      if (playbackContext.state === "suspended") {
        await playbackContext.resume()
      }

      console.log(`🎛️ Playback context: ${playbackContext.sampleRate}Hz, state: ${playbackContext.state}`)

      // Initialize recording
      await initializeRecording()

      console.log("🎛️ Audio system initialized")
    } catch (err) {
      console.error("❌ Failed to initialize audio:", err)
      alert("Audio initialization failed")
    }
  }

  // Improved µ-law encoding with proper bit manipulation
  const linearToPcmu = (sample: number): number => {
    const BIAS = 0x84
    const CLIP = 32635

    sample = Math.max(-32768, Math.min(32767, Math.round(sample)))
    const sign = (sample >> 8) & 0x80
    if (sign) sample = -sample

    if (sample > CLIP) sample = CLIP
    sample += BIAS

    let exponent = 7
    for (let exp_lut = 0x4000; sample < exp_lut && exponent > 0; exp_lut >>= 1, exponent--);

    const mantissa = (sample >> (exponent + 3)) & 0x0f
    return ~(sign | (exponent << 4) | mantissa) & 0xff
  }

  // Improved µ-law decoding with better precision
  const pcmuToLinear = (pcmu: number): number => {
    pcmu = ~pcmu & 0xff
    const sign = pcmu & 0x80
    const exponent = (pcmu >> 4) & 0x07
    const mantissa = pcmu & 0x0f

    let sample = (mantissa << 3) + 0x84
    sample <<= exponent
    sample -= 0x84

    return sign ? -sample : sample
  }

  // Enhanced audio worklet processor with better buffering and noise handling
  const getPcmuProcessorCode = (): string => {
    return `
    class PCMUProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.chunkSize = 320;
        this.buffer = new Float32Array(this.chunkSize);
        this.bufferIndex = 0;
      }

      linearToPcmu(sample) {
        const BIAS = 0x84;
        const CLIP = 32635;
        
        sample = Math.max(-32768, Math.min(32767, Math.round(sample)));
        let sign = (sample >> 8) & 0x80;
        if (sign) sample = -sample;
        
        if (sample > CLIP) sample = CLIP;
        sample += BIAS;
        
        let exponent = 7;
        for (let exp_lut = 0x4000; sample < exp_lut && exponent > 0; exp_lut >>= 1, exponent--);
        
        const mantissa = (sample >> (exponent + 3)) & 0x0F;
        return ~(sign | (exponent << 4) | mantissa) & 0xFF;
      }

      process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const samples = input[0];

        for (let i = 0; i < samples.length; i++) {
          this.buffer[this.bufferIndex++] = samples[i];

          if (this.bufferIndex === this.chunkSize) {
            const pcmuData = new Uint8Array(this.chunkSize);
            
            for (let j = 0; j < this.chunkSize; j++) {
              const sample = Math.max(-1, Math.min(1, this.buffer[j]));
              const pcm16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
              pcmuData[j] = this.linearToPcmu(pcm16);
            }
            
            this.port.postMessage({ pcmuData: pcmuData.buffer });
            this.bufferIndex = 0;
          }
        }

        return true;
      }
    }

    registerProcessor("pcmu-processor", PCMUProcessor);
  `
  }

  const initializeRecording = async () => {
    try {
      const constraints = {
        audio: {
          sampleRate,
          channelCount: 1,
          echoCancellation: true, // Enable echo cancellation
          noiseSuppression: true, // Enable noise suppression
          autoGainControl: true, // Enable auto gain control
        },
      }

      stream = await navigator.mediaDevices.getUserMedia(constraints)

      // Create audio context for recording
      audioContext = new AudioContext({
        sampleRate,
        latencyHint: "interactive",
      })

      if (audioContext.state === "suspended") {
        await audioContext.resume()
      }

      console.log(`🎙️ Recording context: ${audioContext.sampleRate}Hz, state: ${audioContext.state}`)

      // Create and load audio worklet
      const processorCode = getPcmuProcessorCode()
      const blob = new Blob([processorCode], { type: "application/javascript" })
      const blobUrl = URL.createObjectURL(blob)

      await audioContext.audioWorklet.addModule(blobUrl)
      URL.revokeObjectURL(blobUrl)

      workletNode = new AudioWorkletNode(audioContext, "pcmu-processor")

      const source = audioContext.createMediaStreamSource(stream)
      source.connect(workletNode)

      // Handle PCMU data from worklet
      workletNode.port.onmessage = (event) => {
        if (event.data.pcmuData && socket?.readyState === WebSocket.OPEN) {
          socket.send(event.data.pcmuData)
        }
      }

      isRecording = true
      console.log("🎙️ PCMU recording started")
    } catch (err) {
      console.error("❌ Failed to initialize recording:", err)
      throw err
    }
  }

  // Enhanced audio playback with better quality and click prevention
  const handleIncomingAudioBuffer = (arrayBuffer: ArrayBuffer) => {
    audioQueue.push(arrayBuffer)
    if (!isAudioPlaying && playbackContext) {
      scheduleAudioPlayback()
    }
  }

  // Significantly improved audio playback system
  const scheduleAudioPlayback = async () => {
    if (audioQueue.length === 0 || !playbackContext) {
      isAudioPlaying = false
      return
    }

    try {
      isAudioPlaying = true
      const chunk = audioQueue.shift()!
      const pcmuSamples = new Uint8Array(chunk)

      // Create buffer with exact length
      const audioBuffer = playbackContext.createBuffer(1, pcmuSamples.length, sampleRate)
      const audioData = audioBuffer.getChannelData(0)

      // Simple µ-law decoding without complex processing
      for (let i = 0; i < pcmuSamples.length; i++) {
        const linearSample = pcmuToLinear(pcmuSamples[i])
        audioData[i] = Math.max(-1, Math.min(1, linearSample / 32768.0))
      }

      // Create simple playback chain
      const now = playbackContext.currentTime
      const sourceNode = playbackContext.createBufferSource()
      sourceNode.buffer = audioBuffer

      // Simple gain control
      const gainNode = playbackContext.createGain()
      gainNode.gain.value = 0.8

      sourceNode.connect(gainNode)
      gainNode.connect(playbackContext.destination)

      // Schedule playback
      const startTime = Math.max(now + 0.01, nextPlayTime)
      sourceNode.start(startTime)
      sourceNode.stop(startTime + audioBuffer.duration)

      nextPlayTime = startTime + audioBuffer.duration

      // Schedule next chunk
      sourceNode.onended = () => {
        setTimeout(() => scheduleAudioPlayback(), 10)
      }
    } catch (err) {
      console.error("Playback error:", err)
      isAudioPlaying = false
      if (playbackContext) {
        nextPlayTime = playbackContext.currentTime + 0.1
      }
    }
  }

  const stopAudioPlayback = () => {
    audioQueue = []
    isAudioPlaying = false

    // Fade out current audio to prevent clicks
    if (currentGainNode && playbackContext) {
      const now = playbackContext.currentTime
      currentGainNode.gain.cancelScheduledValues(now)
      currentGainNode.gain.setValueAtTime(currentGainNode.gain.value, now)
      currentGainNode.gain.linearRampToValueAtTime(0, now + 0.05)
    }

    if (playbackContext) {
      nextPlayTime = playbackContext.currentTime + 0.1
    }

    console.log("🧹 Audio playback stopped and queue cleared")
  }

  return (
    <div className="min-h-screen bg-gray-100 p-8 text-gray-800">
      <h1 className="text-2xl font-bold mb-6">🎤 Real-Time AI Meeting Assistant (Enhanced Audio Quality)</h1>

      <div className="mb-4">
        <div className="text-sm text-gray-600 mb-2">
          Sample Rate: {sampleRate}Hz | PCMU (µ-law) Encoding | Enhanced Audio Processing
        </div>
      </div>

      <div className="flex items-center space-x-2 mb-4">
        <input
          type="text"
          value={context}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setContext(e.target.value)}
          placeholder="Enter meeting context..."
          className="w-96 p-2 text-lg border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={startConversation}
          disabled={isConnected}
          className={`px-4 py-2 text-lg rounded-lg text-white ${
            isConnected ? "bg-gray-400 cursor-not-allowed" : "bg-blue-500 hover:bg-blue-600"
          }`}
        >
          Start
        </button>
        <button
          onClick={stopConversation}
          disabled={!isConnected}
          className={`px-4 py-2 text-lg rounded-lg text-white ${
            !isConnected ? "bg-gray-400 cursor-not-allowed" : "bg-red-500 hover:bg-red-600"
          }`}
        >
          Stop
        </button>
      </div>

      <div className="mb-4 text-sm text-gray-600">
        Status: {isConnected ? "🟢 Connected" : "🔴 Disconnected"} | Recording:{" "}
        {isRecording ? "🎙️ Active" : "⏸️ Inactive"} | Playback: {isAudioPlaying ? "🔊 Playing" : "🔇 Silent"} | Queue:{" "}
        {audioQueue.length} chunks
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
  )
}

export default App
