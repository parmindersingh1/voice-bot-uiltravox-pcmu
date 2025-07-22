import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url'; // For parsing query parameters

dotenv.config();
const app = express();
const port = 3000;

// Create a WebSocket server
const wss = new WebSocketServer({ port: 3001 });

app.use(cors());
app.use(express.json());

// Store mapping of client WebSocket to Ultravox WebSocket
const clientToUltravox = new Map();

wss.on('connection', async (clientWs, req) => {
  console.log('✅ Client connected to static WebSocket');

  // Extract context from query parameter
  const url = new URL(req.url, `http://${req.headers.host}`);
  const context = url.searchParams.get('context') || 'Default meeting context';
  console.log('📝 Context:', context);

  // Start Ultravox session immediately
  try {
    const callResponse = await fetch('https://api.ultravox.ai/api/calls', {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.ULTRAVOX_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemPrompt: `You are a helpful assistant. ${context}`,
        model: 'fixie-ai/ultravox',
        voice: 'Mark',
        medium: {
          serverWebSocket: {
            inputSampleRate: 48000,
            outputSampleRate: 48000,
          },
        },
      }),
    });

    const result = await callResponse.json();
    console.log('🎯 Ultravox session created:', result);

    if (!result.joinUrl) {
      clientWs.send(JSON.stringify({ error: 'Ultravox did not return joinUrl' }));
      clientWs.close();
      return;
    }

    // Connect to Ultravox WebSocket
    const ultravoxWs = new WebSocket(result.joinUrl);
    ultravoxWs.binaryType = 'arraybuffer';

    // Store the mapping
    clientToUltravox.set(clientWs, ultravoxWs);

    ultravoxWs.on('open', () => {
      console.log('✅ Connected to Ultravox WebSocket');
      clientWs.send(JSON.stringify({ type: 'connected' }));
    });

    // Relay messages from Ultravox to client
    ultravoxWs.on('message', (data) => {
      if (data instanceof ArrayBuffer) {
        clientWs.send(data); // Relay binary audio data
      } else {
        clientWs.send(data); // Relay JSON messages (transcript, response, etc.)
      }
    });

    ultravoxWs.on('error', (err) => {
      console.error('❌ Ultravox WebSocket error:', err);
      clientWs.send(JSON.stringify({ error: 'Ultravox WebSocket error' }));
    });

    ultravoxWs.on('close', () => {
      console.log('🔌 Ultravox WebSocket closed');
      clientWs.close();
      clientToUltravox.delete(clientWs);
    });
  } catch (err) {
    console.error('❌ Failed to start Ultravox session:', err);
    clientWs.send(JSON.stringify({ error: 'Ultravox session failed' }));
    clientWs.close();
    return;
  }

  // Handle incoming messages from client (e.g., audio data)
  clientWs.on('message', (data) => {
    const ultravoxWs = clientToUltravox.get(clientWs);
    if (ultravoxWs && ultravoxWs.readyState === WebSocket.OPEN) {
      ultravoxWs.send(data); // Relay audio or other data to Ultravox
    }
  });

  clientWs.on('close', () => {
    console.log('🛑 Client WebSocket closed');
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
});

// Optional: Keep the HTTP /start endpoint if needed for other purposes
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  console.log(`🌐 WebSocket server running at ws://localhost:3001`);
});