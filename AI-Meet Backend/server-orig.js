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
            inputSampleRate: 48000,
            outputSampleRate: 48000,
            // inputEncoding: 'pcm_s16le', // Ensure 16-bit PCM
            // outputEncoding: 'pcm_s16le'
          },
        },
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

    // Relay messages from Ultravox to client with error handling
    ultravoxWs.on('message', (data) => {
      try {
        if (clientWs.readyState === WebSocket.OPEN) {
          if (data instanceof ArrayBuffer) {
            // Log audio data size for debugging
            console.log(`🎧 Relaying audio chunk: ${data.byteLength} bytes`);
            clientWs.send(data); // Relay binary audio data
          } else {
            // Parse and log JSON messages
            try {
              const parsed = JSON.parse(data);
              console.log('📨 Ultravox message:', parsed.type || 'unknown');
              clientWs.send(data); // Relay JSON messages
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

  // Handle incoming messages from client with improved error handling
  clientWs.on('message', (data) => {
    const ultravoxWs = clientToUltravox.get(clientWs);
    if (ultravoxWs && ultravoxWs.readyState === WebSocket.OPEN) {
      try {
        if (data instanceof ArrayBuffer) {
          // Log input audio size for debugging
          if (data.byteLength > 0) {
            ultravoxWs.send(data); // Relay audio data to Ultravox
          }
        } else {
          // Handle text messages if any
          ultravoxWs.send(data);
        }
      } catch (sendErr) {
        console.error('❌ Error sending to Ultravox:', sendErr);
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
});