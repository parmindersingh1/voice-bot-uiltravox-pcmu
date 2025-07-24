const WebSocket = require("ws")
const fetch = require("node-fetch")
const EventEmitter = require("events")
require("dotenv").config()

// Configuration
const PCMU_SAMPLE_RATE = 8000
const API_KEY = process.env.API_KEY
const PORT = process.env.PORT || 8766
const HOST = process.env.HOST || "0.0.0.0"

class AudioBridge extends EventEmitter {
  constructor() {
    super()
    this.connections = new Map()
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      bytesProcessed: 0,
      conversionsPerformed: 0,
    }
  }

  // Optimized µ-law conversion with lookup tables
  initializeLookupTables() {
    console.log("🔧 Initializing µ-law lookup tables...")

    // Create µ-law to linear lookup table
    this.ulawToLinearTable = new Int16Array(256)
    for (let i = 0; i < 256; i++) {
      this.ulawToLinearTable[i] = this.ulawToLinearSlow(i)
    }

    // Create linear to µ-law lookup table (for common values)
    this.linearToUlawTable = new Uint8Array(65536)
    for (let i = 0; i < 65536; i++) {
      const sample = i - 32768 // Convert to signed
      this.linearToUlawTable[i] = this.linearToUlawSlow(sample)
    }

    console.log("✅ Lookup tables initialized")
  }

  ulawToLinearSlow(ulawByte) {
    const BIAS = 0x84
    ulawByte = ~ulawByte & 0xff
    const sign = ulawByte & 0x80
    const exponent = (ulawByte >> 4) & 0x07
    const mantissa = ulawByte & 0x0f

    let sample = (mantissa << 3) + BIAS
    sample <<= exponent
    sample -= BIAS

    return sign ? -sample : sample
  }

  linearToUlawSlow(sample) {
    const BIAS = 0x84
    const CLIP = 32635

    sample = Math.max(-32768, Math.min(32767, Math.round(sample)))
    const sign = (sample >> 8) & 0x80
    if (sign) sample = -sample

    if (sample > CLIP) sample = CLIP
    sample += BIAS

    let exponent = 7
    const expLuts = [0x4000, 0x2000, 0x1000, 0x800, 0x400, 0x200, 0x100]
    for (const expLut of expLuts) {
      if (sample >= expLut) break
      exponent--
    }

    const mantissa = (sample >> (exponent + 3)) & 0x0f
    return ~(sign | (exponent << 4) | mantissa) & 0xff
  }

  // Fast lookup-based conversions
  ulawToLinear(ulawByte) {
    return this.ulawToLinearTable[ulawByte]
  }

  linearToUlaw(sample) {
    const index = Math.max(0, Math.min(65535, sample + 32768))
    return this.linearToUlawTable[index]
  }

  // Apply smoothing to prevent clicks and pops
  applySmoothingFilter(samples, previousSample = 0) {
    if (samples.length === 0) return { smoothedSamples: samples, lastSample: previousSample }

    const smoothedSamples = new Array(samples.length)
    const alpha = 0.95 // Smoothing factor (0.9-0.99 works well)

    // Apply exponential smoothing to reduce sudden changes
    smoothedSamples[0] = alpha * samples[0] + (1 - alpha) * previousSample

    for (let i = 1; i < samples.length; i++) {
      smoothedSamples[i] = alpha * samples[i] + (1 - alpha) * smoothedSamples[i - 1]
    }

    return {
      smoothedSamples,
      lastSample: smoothedSamples[smoothedSamples.length - 1],
    }
  }

  // Apply noise gate to reduce background noise
  applyNoiseGate(samples, threshold = 100) {
    return samples.map((sample) => {
      return Math.abs(sample) < threshold ? 0 : sample
    })
  }

  // Apply soft limiting to prevent clipping
  applySoftLimiting(samples, limit = 30000) {
    return samples.map((sample) => {
      if (Math.abs(sample) > limit) {
        // Soft compression using tanh
        const sign = sample >= 0 ? 1 : -1
        const compressed = Math.tanh(Math.abs(sample) / limit) * limit
        return sign * compressed
      }
      return sample
    })
  }

  async getUltravoxJoinUrl() {
    const url = "https://api.ultravox.ai/api/calls"
    const headers = {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    }

    const payload = {
      systemPrompt: "You are a helpful assistant. Please respond naturally and engage in conversation.",
      model: "fixie-ai/ultravox",
      voice: "Riya-Rao-English-Indian",
      medium: {
        serverWebSocket: {
          inputSampleRate: PCMU_SAMPLE_RATE,
          outputSampleRate: PCMU_SAMPLE_RATE,
        },
      },
      vadSettings: {
        turnEndpointDelay: "0.8s", // Increased to reduce interruptions
        minimumTurnDuration: "0.2s", // Increased for more natural speech
        minimumInterruptionDuration: "0.3s", // Increased to prevent false interruptions
        frameActivationThreshold: 0.2, // Slightly higher to reduce noise triggering
      },
      firstSpeaker: "FIRST_SPEAKER_AGENT",
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
        timeout: 10000,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      return data.joinUrl
    } catch (error) {
      console.error("❌ Ultravox API request failed:", error.message)
      throw error
    }
  }

  convertPcmuToPcm16(pcmuBuffer, connectionState) {
    const pcmuData = Array.from(pcmuBuffer)
    const linearSamples = pcmuData.map((byte) => this.ulawToLinear(byte))

    // Apply audio processing to reduce clicks
    const processedSamples = this.applyNoiseGate(linearSamples, 50)
    const limitedSamples = this.applySoftLimiting(processedSamples, 28000)

    // Apply smoothing using previous sample for continuity
    const { smoothedSamples, lastSample } = this.applySmoothingFilter(
      limitedSamples,
      connectionState.lastInputSample || 0,
    )

    // Store last sample for next chunk
    connectionState.lastInputSample = lastSample

    // Convert to PCM16 bytes
    const pcmData = new Array(smoothedSamples.length * 2)
    for (let i = 0; i < smoothedSamples.length; i++) {
      const sample = Math.round(smoothedSamples[i])
      pcmData[i * 2] = sample & 0xff
      pcmData[i * 2 + 1] = (sample >> 8) & 0xff
    }

    this.stats.conversionsPerformed++
    return Buffer.from(pcmData)
  }

  convertPcm16ToPcmu(pcm16Buffer, connectionState) {
    const pcmBytes = Array.from(pcm16Buffer)
    const linearSamples = []

    // Convert PCM16 bytes to linear samples
    for (let i = 0; i < pcmBytes.length - 1; i += 2) {
      const lowByte = pcmBytes[i]
      const highByte = pcmBytes[i + 1]
      let sample = lowByte | (highByte << 8)

      // Handle signed 16-bit
      if (sample > 32767) {
        sample -= 65536
      }
      linearSamples.push(sample)
    }

    // Apply audio processing to reduce clicks
    const processedSamples = this.applyNoiseGate(linearSamples, 50)
    const limitedSamples = this.applySoftLimiting(processedSamples, 28000)

    // Apply smoothing using previous sample for continuity
    const { smoothedSamples, lastSample } = this.applySmoothingFilter(
      limitedSamples,
      connectionState.lastOutputSample || 0,
    )

    // Store last sample for next chunk
    connectionState.lastOutputSample = lastSample

    // Convert to µ-law
    const pcmuData = smoothedSamples.map((sample) => this.linearToUlaw(Math.round(sample)))

    this.stats.conversionsPerformed++
    return Buffer.from(pcmuData)
  }

  async handleConnection(clientWs, request) {
    const connectionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const clientAddress = request.socket.remoteAddress

    console.log(`🔗 New client connected: ${connectionId} from ${clientAddress}`)

    this.stats.totalConnections++
    this.stats.activeConnections++

    const connectionState = {
      id: connectionId,
      clientWs,
      ultravoxWs: null,
      startTime: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
      lastInputSample: 0, // For audio continuity
      lastOutputSample: 0, // For audio continuity
      audioBuffer: [], // For buffering if needed
    }

    this.connections.set(connectionId, connectionState)

    try {
      // Get Ultravox connection URL
      const joinUrl = await this.getUltravoxJoinUrl()
      console.log(`🌐 Connecting to Ultravox for ${connectionId}`)

      // Connect to Ultravox
      const ultravoxWs = new WebSocket(joinUrl)
      connectionState.ultravoxWs = ultravoxWs

      // Wait for Ultravox connection
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Ultravox connection timeout"))
        }, 15000)

        ultravoxWs.on("open", () => {
          clearTimeout(timeout)
          resolve()
        })

        ultravoxWs.on("error", (error) => {
          clearTimeout(timeout)
          reject(error)
        })
      })

      console.log(`✅ Ultravox connected for ${connectionId}`)

      // Send connection confirmation
      clientWs.send(
        JSON.stringify({
          type: "connected",
          message: "Connected to enhanced Node.js bridge server with audio smoothing",
          connectionId: connectionId,
        }),
      )

      // Set up message handlers
      this.setupClientHandlers(connectionState)
      this.setupUltravoxHandlers(connectionState)

      // Wait for connection to close
      await new Promise((resolve) => {
        clientWs.on("close", resolve)
        ultravoxWs.on("close", resolve)
      })
    } catch (error) {
      console.error(`❌ Connection error for ${connectionId}:`, error.message)
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, `Connection failed: ${error.message}`)
      }
    } finally {
      this.cleanupConnection(connectionId)
    }
  }

  setupClientHandlers(connectionState) {
    const { clientWs, ultravoxWs, id } = connectionState

    clientWs.on("message", (message) => {
      try {
        connectionState.bytesReceived += message.length
        this.stats.bytesProcessed += message.length

        if (Buffer.isBuffer(message)) {
          // Audio data - convert with smoothing
          const pcm16Buffer = this.convertPcmuToPcm16(message, connectionState)

          if (ultravoxWs && ultravoxWs.readyState === WebSocket.OPEN) {
            ultravoxWs.send(pcm16Buffer)
          }
        } else {
          // Text message
          const messageStr = message.toString()
          if (ultravoxWs && ultravoxWs.readyState === WebSocket.OPEN) {
            ultravoxWs.send(messageStr)
          }
        }
      } catch (error) {
        console.error(`Error processing client message for ${id}:`, error)
      }
    })

    clientWs.on("error", (error) => {
      console.error(`Client WebSocket error for ${id}:`, error)
    })
  }

  setupUltravoxHandlers(connectionState) {
    const { clientWs, ultravoxWs, id } = connectionState

    ultravoxWs.on("message", (message) => {
      try {
        connectionState.bytesSent += message.length
        this.stats.bytesProcessed += message.length

        if (Buffer.isBuffer(message)) {
          // Audio data - convert with smoothing
          const pcmuBuffer = this.convertPcm16ToPcmu(message, connectionState)

          if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(pcmuBuffer)
          }
        } else {
          // Text message
          if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(message)
          }
        }
      } catch (error) {
        console.error(`Error processing Ultravox message for ${id}:`, error)
      }
    })

    ultravoxWs.on("error", (error) => {
      console.error(`Ultravox WebSocket error for ${id}:`, error)
    })
  }

  cleanupConnection(connectionId) {
    const connectionState = this.connections.get(connectionId)
    if (connectionState) {
      const duration = Date.now() - connectionState.startTime
      console.log(`🔌 Connection ${connectionId} closed after ${Math.round(duration / 1000)}s`)
      console.log(`   📊 Bytes: ${connectionState.bytesReceived} received, ${connectionState.bytesSent} sent`)

      if (connectionState.ultravoxWs) {
        connectionState.ultravoxWs.close()
      }

      this.connections.delete(connectionId)
      this.stats.activeConnections--
    }
  }

  printStats() {
    console.log("\n📊 Server Statistics:")
    console.log(`   Active connections: ${this.stats.activeConnections}`)
    console.log(`   Total connections: ${this.stats.totalConnections}`)
    console.log(`   Bytes processed: ${(this.stats.bytesProcessed / 1024 / 1024).toFixed(2)} MB`)
    console.log(`   Conversions performed: ${this.stats.conversionsPerformed}`)
    console.log("")
  }

  start() {
    console.log("🚀 Starting Enhanced Node.js WebSocket Bridge Server with Audio Smoothing...")

    if (!API_KEY) {
      console.error("❌ API_KEY environment variable is required")
      process.exit(1)
    }

    // Initialize lookup tables for fast conversion
    this.initializeLookupTables()

    // Create WebSocket server
    const wss = new WebSocket.Server({
      port: PORT,
      host: HOST,
      perMessageDeflate: false, // Disable compression for audio
    })

    wss.on("connection", (ws, request) => {
      this.handleConnection(ws, request)
    })

    wss.on("listening", () => {
      console.log(`🎧 Enhanced Node.js bridge server running on ws://${HOST}:${PORT}`)
      console.log("📈 Features: Audio smoothing, noise gate, soft limiting, click prevention")
    })

    wss.on("error", (error) => {
      console.error("❌ WebSocket server error:", error)
    })

    // Print stats every 30 seconds
    setInterval(() => {
      if (this.stats.activeConnections > 0) {
        this.printStats()
      }
    }, 30000)

    // Graceful shutdown
    const shutdown = () => {
      console.log("🛑 Server shutting down...")
      this.printStats()
      wss.close(() => {
        process.exit(0)
      })
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)

    return wss
  }
}

// Export the AudioBridge class
module.exports = AudioBridge

// Start the server only if this file is run directly
if (require.main === module) {
  const bridge = new AudioBridge()
  bridge.start()
}
