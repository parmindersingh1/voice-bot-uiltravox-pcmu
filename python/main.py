import asyncio
import websockets
import numpy as np
import requests
import os
import json
from dotenv import load_dotenv

load_dotenv()

# Configuration
PCMU_SAMPLE_RATE = 8000
API_KEY = os.getenv("API_KEY")

# Simple µ-law conversion
def ulaw_to_linear(ulaw_byte):
    """Convert single µ-law byte to linear PCM"""
    ulaw_byte = ~ulaw_byte & 0xFF
    sign = ulaw_byte & 0x80
    exponent = (ulaw_byte >> 4) & 0x07
    mantissa = ulaw_byte & 0x0F
    
    sample = (mantissa << 3) + 0x84
    sample <<= exponent
    sample -= 0x84
    
    return -sample if sign else sample

def linear_to_ulaw(sample):
    """Convert linear PCM sample to µ-law byte"""
    BIAS = 0x84
    CLIP = 32635
    
    sample = max(-32768, min(32767, int(sample)))
    sign = (sample >> 8) & 0x80
    if sign:
        sample = -sample
    
    if sample > CLIP:
        sample = CLIP
    sample += BIAS
    
    exponent = 7
    for exp_lut in [0x4000, 0x2000, 0x1000, 0x800, 0x400, 0x200, 0x100]:
        if sample >= exp_lut:
            break
        exponent -= 1
    
    mantissa = (sample >> (exponent + 3)) & 0x0F
    return ~(sign | (exponent << 4) | mantissa) & 0xFF

class BridgeState:
    def __init__(self):
        self.client_connected = False
        self.ultravox_connected = False

bridge_state = BridgeState()

def get_ultravox_join_url(api_key: str) -> str:
    """Get the WebSocket URL for connecting to Ultravox"""
    url = "https://api.ultravox.ai/api/calls"
    headers = {
        "X-API-Key": api_key,
        "Content-Type": "application/json"
    }
    payload = {
        "systemPrompt": "You are a helpful assistant. Please respond naturally and engage in conversation.",
        "model": "fixie-ai/ultravox",
        "voice": "Riya-Rao-English-Indian",
        "medium": {
            "serverWebSocket": {
                "inputSampleRate": PCMU_SAMPLE_RATE,
                "outputSampleRate": PCMU_SAMPLE_RATE
            }
        },
        "vadSettings": {
            "turnEndpointDelay": "0.5s",
            "minimumTurnDuration": "0.1s",
            "minimumInterruptionDuration": "0.2s",
            "frameActivationThreshold": 0.15
        },
        "firstSpeaker": "FIRST_SPEAKER_AGENT",
    }

    try:
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()
        return response.json().get("joinUrl")
    except requests.RequestException as e:
        print(f"Request to Ultravox API failed: {e}")
        return None

async def handle_client_messages(client_ws, ultravox_ws):
    """Forward messages from client to Ultravox"""
    try:
        async for message in client_ws:
            if isinstance(message, bytes):
                # Convert PCMU to PCM16
                pcmu_data = list(message)
                pcm_data = []
                
                for ulaw_byte in pcmu_data:
                    linear_sample = ulaw_to_linear(ulaw_byte)
                    # Convert to bytes (little-endian 16-bit)
                    pcm_data.extend([linear_sample & 0xFF, (linear_sample >> 8) & 0xFF])
                
                pcm_bytes = bytes(pcm_data)
                
                # Forward to Ultravox
                if ultravox_ws and ultravox_ws.close_code is None:
                    await ultravox_ws.send(pcm_bytes)
                    
            elif isinstance(message, str):
                print(f"Client message: {message}")
                if ultravox_ws and ultravox_ws.close_code is None:
                    await ultravox_ws.send(message)
                    
    except websockets.exceptions.ConnectionClosed:
        print("Client connection closed")
    except Exception as e:
        print(f"Error in client message handler: {e}")

async def handle_ultravox_messages(client_ws, ultravox_ws):
    """Forward messages from Ultravox to client"""
    try:
        async for message in ultravox_ws:
            if isinstance(message, bytes):
                # Convert PCM16 to PCMU
                pcm_bytes = list(message)
                pcmu_data = []
                
                # Process pairs of bytes (16-bit samples)
                for i in range(0, len(pcm_bytes) - 1, 2):
                    # Reconstruct 16-bit sample from little-endian bytes
                    low_byte = pcm_bytes[i]
                    high_byte = pcm_bytes[i + 1]
                    sample = low_byte | (high_byte << 8)
                    
                    # Handle signed 16-bit
                    if sample > 32767:
                        sample -= 65536
                    
                    # Convert to µ-law
                    ulaw_byte = linear_to_ulaw(sample)
                    pcmu_data.append(ulaw_byte)
                
                pcmu_bytes = bytes(pcmu_data)
                
                if client_ws and client_ws.close_code is None:
                    await client_ws.send(pcmu_bytes)
                    
            elif isinstance(message, str):
                if client_ws and client_ws.close_code is None:
                    await client_ws.send(message)
                    
    except websockets.exceptions.ConnectionClosed:
        print("Ultravox connection closed")
    except Exception as e:
        print(f"Error in handle_ultravox_messages: {e}")

async def bridge_connection(client_ws, ultravox_ws):
    """Main bridge function"""
    try:
        # Send connection confirmation
        await client_ws.send(json.dumps({
            "type": "connected",
            "message": "Connected to minimal bridge server"
        }))

        # Start bidirectional communication
        await asyncio.gather(
            handle_client_messages(client_ws, ultravox_ws),
            handle_ultravox_messages(client_ws, ultravox_ws)
        )
    except Exception as e:
        print(f"Bridge error: {e}")
    finally:
        if client_ws and client_ws.close_code is None:
            await client_ws.close()
        if ultravox_ws and ultravox_ws.close_code is None:
            await ultravox_ws.close()

async def handle_connection(client_ws):
    """Handle new client connections"""
    print(f"New client connected from {client_ws.remote_address}")
    bridge_state.client_connected = True

    try:
        # Get Ultravox connection URL
        join_url = get_ultravox_join_url(API_KEY)
        if not join_url:
            await client_ws.close(code=1011, reason="Failed to get Ultravox URL")
            return

        # Connect to Ultravox
        print(f"Connecting to Ultravox at {join_url}")
        async with websockets.connect(join_url) as ultravox_ws:
            bridge_state.ultravox_connected = True
            print("Successfully connected to Ultravox")
            await bridge_connection(client_ws, ultravox_ws)

    except Exception as e:
        print(f"Connection error: {e}")
        await client_ws.close(code=1011, reason=str(e))
    finally:
        bridge_state.client_connected = False
        bridge_state.ultravox_connected = False
        print("Client disconnected")

async def main():
    """Main server function"""
    print("Starting minimal WebSocket bridge server...")
    
    server = await websockets.serve(
        handle_connection,
        "0.0.0.0",
        8765,
        ping_interval=20,
        ping_timeout=60,
        close_timeout=1
    )

    print(f"Minimal WebSocket bridge server running on ws://0.0.0.0:8765")
    print("This version uses basic µ-law conversion without numpy dependencies")
    await server.wait_closed()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Server shutting down...")
