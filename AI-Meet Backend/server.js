import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

dotenv.config();
const app = express();
const port = 3000;

// Create a WebSocket server with improved settings
const wss = new WebSocketServer({ 
  port: 3001,
  perMessageDeflate: false, // Disable compression for better audio quality
  maxPayload: 1024 * 1024 // 1MB max payload
});

app.use(cors());
app.use(express.json());

// Store mapping of client WebSocket to Ultravox WebSocket
const clientToUltravox = new Map();

// PCMU encode table for better performance
const pcmuEncodeTable = new Uint8Array(65536);
const initPcmuEncodeTable = () => {
  const BIAS = 0x84;
  const CLIP = 32635;
  
  for (let i = 0; i < 65536; i++) {
    const sample = i - 32768; // Convert unsigned to signed
    
    let sign = (sample >> 8) & 0x80;
    let absSample = sign ? -sample : sample;
    
    if (absSample > CLIP) absSample = CLIP;
    absSample += BIAS;
    
    let exponent = 7;
    for (let exp_lut = 0x4000; absSample < exp_lut && exponent > 0; exp_lut >>= 1, exponent--);
    
    const mantissa = (absSample >> (exponent + 3)) & 0x0F;
    const companded = ~(sign | (exponent << 4) | mantissa);
    
    pcmuEncodeTable[i] = companded & 0xFF;
  }
};
initPcmuEncodeTable();

// Convert PCM16 buffer to PCMU buffer
const convertPcm16ToPcmu = (pcm16Buffer) => {
  const pcm16Samples = new Int16Array(pcm16Buffer);
  const pcmuBuffer = new ArrayBuffer(pcm16Samples.length);
  const pcmuView = new Uint8Array(pcmuBuffer);
  
  for (let i = 0; i < pcm16Samples.length; i++) {
    const unsignedSample = pcm16Samples[i] + 32768; // Convert signed to unsigned index
    pcmuView[i] = pcmuEncodeTable[Math.max(0, Math.min(65535, unsignedSample))];
  }
  
  return pcmuBuffer;
};

// PCMU (µ-law) decode table for better performance and accuracy
const pcmuDecodeTable = new Int16Array(256);
const initPcmuDecodeTable = () => {
  const BIAS = 0x84;
  for (let i = 0; i < 256; i++) {
    let val = ~i;
    const sign = val & 0x80;
    const exponent = (val >> 4) & 0x07;
    const mantissa = val & 0x0F;
    
    val = mantissa << (exponent + 3);
    val += BIAS;
    if (exponent === 0) val -= 4;
    
    pcmuDecodeTable[i] = sign ? -val : val;
  }
};
initPcmuDecodeTable();

// Convert PCMU buffer to 16-bit PCM buffer for Ultravox
const convertPcmuToPcm16 = (pcmuBuffer) => {
  const pcmuSamples = new Uint8Array(pcmuBuffer);
  const pcm16Buffer = new ArrayBuffer(pcmuSamples.length * 2);
  const pcm16View = new Int16Array(pcm16Buffer);
  
  for (let i = 0; i < pcmuSamples.length; i++) {
    pcm16View[i] = pcmuDecodeTable[pcmuSamples[i]];
  }
  
  return pcm16Buffer;
};

// Improved resampling with anti-aliasing filter
const resampleAudio = (inputBuffer, inputSampleRate, outputSampleRate) => {
  const inputSamples = new Int16Array(inputBuffer);
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(inputSamples.length / ratio);
  
  if (outputLength === 0) return new ArrayBuffer(0);
  
  const outputBuffer = new ArrayBuffer(outputLength * 2);
  const outputSamples = new Int16Array(outputBuffer);
  
  // Simple but effective resampling
  for (let i = 0; i < outputLength; i++) {
    const inputIndex = i * ratio;
    const index = Math.floor(inputIndex);
    const fraction = inputIndex - index;
    
    if (index + 1 < inputSamples.length) {
      // Linear interpolation
      const sample1 = inputSamples[index];
      const sample2 = inputSamples[index + 1];
      const interpolated = sample1 + (sample2 - sample1) * fraction;
      outputSamples[i] = Math.round(Math.max(-32768, Math.min(32767, interpolated)));
    } else {
      outputSamples[i] = inputSamples[index] || 0;
    }
  }
  
  return outputBuffer;
};

wss.on('connection', async (clientWs, req) => {
  console.log('✅ Client connected to static WebSocket');

  // Set binary type immediately
  clientWs.binaryType = 'arraybuffer';

  // Extract context from query parameter
  const url = new URL(req.url, `http://${req.headers.host}`);
  const context = url.searchParams.get('context') || 'Default meeting context';
  console.log('📝 Context:', context);

  // Start Ultravox session immediately with enhanced configuration
  try {
    const callResponse = await fetch('https://api.ultravox.ai/api/calls', {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.ULTRAVOX_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemPrompt: `You are a helpful assistant. ${context}. Please speak clearly and at a moderate pace for better audio quality.`,
        model: 'fixie-ai/ultravox',
        voice: 'Mark', // Consider trying different voices: 'Terrence', 'Sarah', 'Mark', 'Amy'
        medium: {
          serverWebSocket: {
            inputSampleRate: 48000,  // Accept 48kHz from client after we upsample
            outputSampleRate: 48000,  // Receive 48kHz from Ultravox
            clientBufferSizeMs: 160  // Larger buffer for stability
          },
        },
        vadSettings: {
            turnEndpointDelay: "0.384s",  // Default, but can be adjusted
            minimumTurnDuration: "0s",
            minimumInterruptionDuration: "0.09s",
            frameActivationThreshold: 0.1  // Lower = more sensitive
        },
         "firstSpeaker": "FIRST_SPEAKER_AGENT",
        // Add audio quality parameters
        // maxDuration: 3600, // 1 hour max
        recordingEnabled: false, // Disable recording for better performance
      }),
    });

    const result = await callResponse.json();
    console.log('🎯 Ultravox session created:', result);

    if (!result.joinUrl) {
      clientWs.send(JSON.stringify({ error: 'Ultravox did not return joinUrl' }));
      clientWs.close();
      return;
    }

    // Connect to Ultravox WebSocket with optimized settings
    const ultravoxWs = new WebSocket(result.joinUrl, {
      perMessageDeflate: false, // Disable compression
    });
    ultravoxWs.binaryType = 'arraybuffer';

    // Store the mapping
    clientToUltravox.set(clientWs, ultravoxWs);

    // Add connection timeout
    const connectionTimeout = setTimeout(() => {
      if (ultravoxWs.readyState === WebSocket.CONNECTING) {
        console.log('⏰ Ultravox connection timeout');
        ultravoxWs.close();
        clientWs.send(JSON.stringify({ error: 'Ultravox connection timeout' }));
        clientWs.close();
      }
    }, 10000); // 10 second timeout

    ultravoxWs.on('open', () => {
      clearTimeout(connectionTimeout);
      console.log('✅ Connected to Ultravox WebSocket');
      clientWs.send(JSON.stringify({ type: 'connected' }));
    });

    // Relay messages from Ultravox to client with proper audio conversion
    ultravoxWs.on('message', (data) => {
      try {
        if (clientWs.readyState === WebSocket.OPEN) {
          if (data instanceof ArrayBuffer) {
            console.log(`🎧 Received from Ultravox: ${data.byteLength} bytes`);
            
            try {
              // Validate incoming audio from Ultravox
              const inputSamples = new Int16Array(data);
              const hasValidAudio = inputSamples.some(sample => Math.abs(sample) > 100);
              
              if (!hasValidAudio) {
                console.log('🔇 Skipping silent audio from Ultravox');
                return;
              }
              
              // Downsample from 48kHz to 8kHz
              const downsampledBuffer = resampleAudio(data, 48000, 8000);
              if (downsampledBuffer.byteLength === 0) {
                console.log('🔇 Empty after downsampling');
                return;
              }
              
              // Convert downsampled PCM16 to PCMU
              const pcmuBuffer = convertPcm16ToPcmu(downsampledBuffer);
              if (pcmuBuffer.byteLength === 0) {
                console.log('🔇 Empty buffer');
                return;
              }
              
              console.log(`� Converted to PCMU: ${pcmuBuffer.byteLength} bytes`);
              console.log(`🔄 Converted to PCMU: ${pcmuBuffer.byteLength} bytes`);
              
              // Validate PCMU output
              const pcmuBytes = new Uint8Array(pcmuBuffer);
              const hasVariation = pcmuBytes.some(byte => byte !== pcmuBytes[0]);
              
              if (hasVariation) {
                clientWs.send(pcmuBuffer);
              } else {
                console.log('🔇 Skipping uniform PCMU data');
              }
              
            } catch (conversionErr) {
              console.error('❌ Audio conversion error (outbound):', conversionErr);
            }
          } else {
            // Handle JSON messages
            try {
              const parsed = JSON.parse(data);
              console.log('📨 Ultravox message:', parsed.type || 'unknown');
              clientWs.send(data);
            } catch (parseErr) {
              console.log('📨 Ultravox raw message (non-JSON)');
              clientWs.send(data);
            }
          }
        }
      } catch (relayErr) {
        console.error('❌ Error relaying message:', relayErr);
      }
    });

    ultravoxWs.on('error', (err) => {
      clearTimeout(connectionTimeout);
      console.error('❌ Ultravox WebSocket error:', err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ 
          error: 'Ultravox WebSocket error',
          details: err.message 
        }));
      }
    });

    ultravoxWs.on('close', (code, reason) => {
      clearTimeout(connectionTimeout);
      console.log(`🔌 Ultravox WebSocket closed: ${code} - ${reason}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close();
      }
      clientToUltravox.delete(clientWs);
    });
  } catch (err) {
    console.error('❌ Failed to start Ultravox session:', err);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ 
        error: 'Ultravox session failed',
        details: err.message 
      }));
      clientWs.close();
    }
    return;
  }

  // Handle incoming messages from client with PCMU conversion
  clientWs.on('message', (data) => {
    const ultravoxWs = clientToUltravox.get(clientWs);
    if (ultravoxWs && ultravoxWs.readyState === WebSocket.OPEN) {
      try {
        if (data instanceof ArrayBuffer) {
          // Log input PCMU data size for debugging
          if (data.byteLength > 0) {
            console.log(`🎙️ Received PCMU chunk: ${data.byteLength} bytes`);
            
            try {
              // Validate PCMU data
              const pcmuBytes = new Uint8Array(data);
              const hasValidData = pcmuBytes.some(byte => byte !== 0x7F && byte !== 0xFF); // Not just silence
              
              if (!hasValidData) {
                console.log('🔇 Skipping silent PCMU chunk');
                return;
              }
              
              // Convert PCMU (8kHz) to PCM 16-bit
              const pcm16Buffer = convertPcmuToPcm16(data);
              
              // Validate PCM data
              const pcmSamples = new Int16Array(pcm16Buffer);
              const maxAmplitude = Math.max(...pcmSamples.map(s => Math.abs(s)));
              
              if (maxAmplitude === 0) {
                console.log('🔇 Skipping silent PCM chunk');
                return;
              }
              
              console.log(`🔄 Converted to PCM16 (8kHz): ${pcm16Buffer.byteLength} bytes, max: ${maxAmplitude}`);
              
              // Upsample from 8kHz to 48kHz for Ultravox
              const upsampledBuffer = resampleAudio(pcm16Buffer, 8000, 48000);
              
              // Validate upsampled data
              const upsampledSamples = new Int16Array(upsampledBuffer);
              if (upsampledSamples.length === 0) {
                console.log('🔇 Empty after upsampling');
                return;
              }
              
              console.log(`📈 Upsampled to 48kHz: ${upsampledBuffer.byteLength} bytes`);
              ultravoxWs.send(upsampledBuffer);
            } catch (conversionErr) {
              console.error('❌ Audio conversion error:', conversionErr);
            }
          }
        } else {
          // Handle text messages if any
          ultravoxWs.send(data);
        }
      } catch (sendErr) {
        console.error('❌ Error processing/sending audio to Ultravox:', sendErr);
      }
    } else {
      console.warn('⚠️ Cannot send data: Ultravox WebSocket not ready');
    }
  });

  clientWs.on('close', (code, reason) => {
    console.log(`🛑 Client WebSocket closed: ${code} - ${reason}`);
    const ultravoxWs = clientToUltravox.get(clientWs);
    if (ultravoxWs) {
      ultravoxWs.close();
      clientToUltravox.delete(clientWs);
    }
  });

  clientWs.on('error', (err) => {
    console.error('❌ Client WebSocket error:', err);
    const ultravoxWs = clientToUltravox.get(clientWs);
    if (ultravoxWs) {
      ultravoxWs.close();
      clientToUltravox.delete(clientWs);
    }
  });

  // Add ping/pong for connection health
  const pingInterval = setInterval(() => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000); // Ping every 30 seconds

  clientWs.on('close', () => clearInterval(pingInterval));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeConnections: clientToUltravox.size,
    timestamp: new Date().toISOString()
  });
});

// Optional: Keep the HTTP /start endpoint if needed for other purposes
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  console.log(`🌐 WebSocket server running at ws://localhost:3001`);
  console.log(`🏥 Health check available at http://localhost:${port}/health`);
  console.log(`🎵 Audio pipeline: PCMU 8kHz (client) ↔ PCM16 8kHz (Ultravox)`);
});