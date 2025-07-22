import asyncio
import websockets
import numpy as np
import soundfile as sf
import requests
import os
import json
from scipy.signal import resample
from dotenv import load_dotenv

load_dotenv()

# Configuration
PCMU_SAMPLE_RATE = 8000
TARGET_SAMPLE_RATE = 16000
OUTPUT_WAV_FILE = "output.wav"
CHUNK_SIZE = 320  # 40ms chunks at 8kHz
BUFFER_SIZE = 10  # Number of chunks to buffer before saving

API_KEY = os.getenv("API_KEY")
pcm_buffer = bytearray()

# µ-law to linear conversion lookup table
BIAS = 0x84
CLIP = 32635

def ulaw2linear(ulawbyte):
    """Convert a µ-law byte to 16-bit PCM"""
    ulawbyte = ~ulawbyte & 0xFF
    sign = (ulawbyte & 0x80)
    exponent = (ulawbyte >> 4) & 0x07
    mantissa = ulawbyte & 0x0F
    
    sample = ((mantissa << 3) + BIAS) << exponent
    sample = sample - BIAS
    
    if sign != 0:
        sample = -sample
    return max(-32768, min(32767, sample))  # Clip to 16-bit range

# Create lookup table
ULAW_TO_LINEAR = np.array([ulaw2linear(i) for i in range(256)], dtype=np.int16)

class BridgeState:
    def __init__(self):
        self.client_connected = False
        self.ultravox_connected = False
        self.audio_buffer = bytearray()

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
            "turnEndpointDelay": "0.384s",  # Default, but can be adjusted
            "minimumTurnDuration": "0s",
            "minimumInterruptionDuration": "0.09s",
            "frameActivationThreshold": 0.1  # Lower = more sensitive
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
                # Audio data - process and forward
                pcm_chunk = np.frombuffer(message, dtype=np.uint8).copy()
                # Convert PCMU to PCM16 using pre-computed table
                linear_chunk = ULAW_TO_LINEAR[pcm_chunk.astype(np.uint8)]
                bridge_state.audio_buffer.extend(linear_chunk.tobytes())
                
                # Send PCM16 to Ultravox (not PCMU)
                if ultravox_ws and ultravox_ws.close_code is None:
                    await ultravox_ws.send(linear_chunk.tobytes())
            elif isinstance(message, str):
                # Text message - log and forward
                print(f"Client message: {message}")
                if ultravox_ws and ultravox_ws.close_code is None:
                    await ultravox_ws.send(message)
    except websockets.exceptions.ConnectionClosed:
        print("Client connection closed during message handling")

async def handle_ultravox_messages(client_ws, ultravox_ws):
    """Forward messages from Ultravox to client"""
    try:
        async for message in ultravox_ws:
            if isinstance(message, bytes):
                # Convert PCM16 to PCMU for client
                pcm_samples = np.frombuffer(message, dtype=np.int16)
                
                # Save Ultravox's audio to our recording buffer
                bridge_state.audio_buffer.extend(pcm_samples.tobytes())
                
                # Create PCMU buffer for client
                pcmu_data = np.zeros(len(pcm_samples), dtype=np.uint8)
                
                for i in range(len(pcm_samples)):
                    sample = pcm_samples[i]
                    # Clip to bounds
                    sample = max(-32768, min(32767, sample))
                    
                    # µ-law encoding
                    sign = (sample >> 8) & 0x80
                    if sign:
                        sample = -sample
                    sample = min(sample, CLIP)
                    sample += BIAS
                    
                    # Find exponent
                    exponent = 7
                    for exp_lut in [0x4000, 0x2000, 0x1000, 0x800, 0x400, 0x200, 0x100]:
                        if sample >= exp_lut:
                            break
                        exponent -= 1
                    
                    mantissa = (sample >> (exponent + 3)) & 0x0F
                    pcmu_byte = ~(sign | (exponent << 4) | mantissa) & 0xFF
                    pcmu_data[i] = pcmu_byte
                
                if client_ws and client_ws.close_code is None:
                    await client_ws.send(pcmu_data.tobytes())
            elif isinstance(message, str):
                if client_ws and client_ws.close_code is None:
                    await client_ws.send(message)
    except websockets.exceptions.ConnectionClosed:
        print("Ultravox connection closed during message handling")
    except Exception as e:
        print(f"Error in handle_ultravox_messages: {e}")

async def save_audio_buffer():
    """Save the buffered audio to a WAV file"""
    if len(bridge_state.audio_buffer) == 0:
        return
        
    try:
        pcm_np = np.frombuffer(bridge_state.audio_buffer, dtype=np.int16)
        if len(pcm_np) > 0:
            resampled = resample(pcm_np, int(len(pcm_np) * TARGET_SAMPLE_RATE / PCMU_SAMPLE_RATE))
            sf.write(OUTPUT_WAV_FILE, resampled.astype(np.int16), TARGET_SAMPLE_RATE)
            print(f"Saved {len(resampled)} samples to {OUTPUT_WAV_FILE}")
    except Exception as e:
        print(f"Error saving audio: {e}")
    finally:
        bridge_state.audio_buffer = bytearray()

async def bridge_connection(client_ws, ultravox_ws):
    """Main bridge function to handle bidirectional communication"""
    try:
        # Send connection confirmation to client
        await client_ws.send(json.dumps({
            "type": "connected",
            "message": "Connected to bridge server"
        }))

        # Start bidirectional communication
        await asyncio.gather(
            handle_client_messages(client_ws, ultravox_ws),
            handle_ultravox_messages(client_ws, ultravox_ws)
        )
    except Exception as e:
        print(f"Bridge error: {e}")
    finally:
        # Clean up
        await save_audio_buffer()
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
    server = await websockets.serve(
        handle_connection,
        "0.0.0.0",
        8765,
        ping_interval=20,
        ping_timeout=60,
        close_timeout=1
    )

    print(f"WebSocket bridge server running on ws://0.0.0.0:8765")
    await server.wait_closed()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Server shutting down...")
        # Save any remaining audio before exiting
        asyncio.run(save_audio_buffer())