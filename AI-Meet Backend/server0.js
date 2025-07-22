import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import cors from 'cors';

dotenv.config();
const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// 🔹 Start a new Ultravox session
app.post('/start', async (req, res) => {
  const { context } = req.body;
  if (!context) return res.status(400).send({ error: "Context is required" });

  try {
    const callResponse = await fetch('https://api.ultravox.ai/api/calls', {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.ULTRAVOX_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        systemPrompt: `You are a helpful assistant. ${context}`,
        model: "fixie-ai/ultravox",
        voice: "Mark",
        medium: {
          serverWebSocket: {
            inputSampleRate: 48000,
            outputSampleRate: 48000
          }
        }
      })
    });

    const result = await callResponse.json();
    console.log("🎯 Ultravox session created:", result);

    if (!result.joinUrl) {
      return res.status(500).send({ error: "Ultravox did not return joinUrl" });
    }

    res.send({ joinUrl: result.joinUrl });

  } catch (err) {
    console.error("❌ Failed to start Ultravox session:", err);
    res.status(500).send({ error: "Ultravox session failed" });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
