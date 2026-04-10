#!/usr/bin/env npx tsx
/**
 * Headless voice test — creates a room, waits for agent,
 * sends text via inject, polls for responses.
 *
 * Usage:
 *   npx tsx scripts/voice-test.ts "jaké mám projekty?"
 *   npx tsx scripts/voice-test.ts   # interactive mode
 */
import { AccessToken, RoomServiceClient, DataPacket_Kind, type VideoGrant } from 'livekit-server-sdk';
import { createInterface } from 'node:readline';
import 'dotenv/config';

const BASE = process.env.TOKEN_SERVER_URL || 'http://localhost:3001';
const LK_URL = process.env.LIVEKIT_URL || 'http://localhost:7880';
const LK_KEY = process.env.LIVEKIT_API_KEY!;
const LK_SECRET = process.env.LIVEKIT_API_SECRET!;

const roomService = new RoomServiceClient(LK_URL, LK_KEY, LK_SECRET);

async function createRoom(): Promise<string> {
  const roomName = `voice-test-${Date.now()}`;
  await roomService.createRoom({ name: roomName, emptyTimeout: 300 });
  return roomName;
}

async function joinAsUser(roomName: string): Promise<void> {
  // Create a participant token so the agent dispatches
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity: `user-test-${Date.now()}`, ttl: '1h' });
  const grant: VideoGrant = { room: roomName, roomJoin: true, canPublish: true, canSubscribe: true };
  at.addGrant(grant);
  // We don't actually connect WebSocket — just having the room triggers agent dispatch
  // Agent connects when it sees the room via LiveKit's agent dispatch
}

async function waitForAgent(roomName: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const participants = await roomService.listParticipants(roomName);
    if (participants.some(p => p.identity.startsWith('agent'))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function inject(roomName: string, text: string): Promise<void> {
  const data = new TextEncoder().encode(JSON.stringify({ type: 'inject_text', text }));
  await roomService.sendData(roomName, data, DataPacket_Kind.RELIABLE);
}

async function sendSessionInit(roomName: string, projectName = '_global'): Promise<void> {
  const data = new TextEncoder().encode(JSON.stringify({
    type: 'session_init',
    projectName,
  }));
  await roomService.sendData(roomName, data, DataPacket_Kind.RELIABLE);
}

async function main() {
  console.log('[init] Creating room...');
  const roomName = await createRoom();
  console.log(`[init] Room: ${roomName}`);

  // Trigger agent dispatch by joining as user via the token server
  const tokenRes = await fetch(`${BASE}/api/token?room=${roomName}&identity=user-test-${Date.now()}`);
  const { token } = await tokenRes.json() as { token: string };
  console.log('[init] Token obtained, waiting for agent...');

  // The agent won't dispatch until a real participant joins.
  // Use the API to send a session_init once agent arrives.
  // For now, we need a real WebSocket participant. Let's use the inject endpoint instead.

  // Actually — just use /api/inject which finds active rooms.
  // But we need a connected participant for the agent to dispatch.
  // The simplest: open the room from the web UI or use the existing inject endpoint.

  // Check if there's already an active voice room
  const rooms = await roomService.listRooms();
  const active = rooms.find(r => r.name.startsWith('voice-') && r.numParticipants > 0);

  let targetRoom: string;
  if (active) {
    targetRoom = active.name;
    console.log(`[init] Using existing room: ${targetRoom} (${active.numParticipants} participants)`);
  } else {
    console.log('[init] No active voice room. Connect via web UI first, then run this script.');
    console.log(`[init] Open ${BASE} and click Connect.`);
    process.exit(1);
  }

  console.log('[ready] Connected to voice pipeline.\n');

  async function send(text: string) {
    console.log(`[you] ${text}`);
    await inject(targetRoom, text);
  }

  // One-shot or interactive
  const oneShot = process.argv[2];
  if (oneShot) {
    await send(oneShot);
    console.log('[wait] Waiting 20s for response (check web UI for output)...');
    await new Promise(r => setTimeout(r, 20000));
    process.exit(0);
  }

  // Interactive REPL
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY ?? false });
  rl.on('close', () => process.exit(0));
  const prompt = () => rl.question('> ', async (line) => {
    const text = line.trim();
    if (!text || text === 'quit' || text === 'exit') {
      rl.close();
      return;
    }
    await send(text);
    prompt();
  });
  console.log('Type a message (or "quit" to exit). Responses visible in web UI.\n');
  prompt();
}

main().catch((err) => { console.error(err); process.exit(1); });
