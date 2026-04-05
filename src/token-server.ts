import 'dotenv/config';
import express from 'express';
import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '..', 'web');

app.use(express.static(webDir));

app.get('/api/token', async (req, res) => {
  const room = (req.query.room as string) || 'voice-room';
  const identity = (req.query.identity as string) || `user-${Date.now()}`;

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
    { identity, ttl: '6h' },
  );

  const grant: VideoGrant = {
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  };

  at.addGrant(grant);
  const token = await at.toJwt();
  res.json({ token });
});

const PORT = parseInt(process.env.TOKEN_SERVER_PORT || '3001', 10);
app.listen(PORT, () => {
  console.log(`Token server running at http://localhost:${PORT}`);
  console.log(`Web client at http://localhost:${PORT}/index.html`);
});
