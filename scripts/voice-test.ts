#!/usr/bin/env npx tsx
/**
 * Voice pipeline integration test via /api/voice-session.
 * No LiveKit, no browser, no microphone — pure headless AgentCore.
 *
 * Usage:
 *   npx tsx scripts/voice-test.ts                    # run all tests
 *   npx tsx scripts/voice-test.ts "custom message"   # single message
 */
import 'dotenv/config';

const BASE = process.env.TOKEN_SERVER_URL || 'http://localhost:3001';

// --- API ---

interface VoiceResponse {
  text: string;
  connectionId: string;
  projectName: string;
  sessionId: string | null;
}

let connectionId: string | null = null;

async function say(text: string, project?: string): Promise<VoiceResponse> {
  const body: Record<string, string> = { text };
  if (connectionId) body.connectionId = connectionId;
  if (project) body.projectName = project;

  const res = await fetch(`${BASE}/api/voice-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`API ${res.status}: ${err.error || res.statusText}`);
  }

  const data = await res.json() as VoiceResponse;
  connectionId = data.connectionId;
  return data;
}

// --- Test framework ---

let passed = 0, failed = 0, skipped = 0;

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${name} `);
  try {
    await fn();
    passed++;
    console.log('✓');
  } catch (err: any) {
    failed++;
    console.log('✗');
    console.log(`    → ${err.message}`);
  }
}

function assert(ok: boolean, msg: string) { if (!ok) throw new Error(msg); }
function includes(text: string, sub: string) {
  assert(text.toLowerCase().includes(sub.toLowerCase()),
    `Expected "${sub}" in: "${text.slice(0, 150)}"`);
}
function notEmpty(r: VoiceResponse) {
  assert(r.text.length > 0, `Empty response (project=${r.projectName}, session=${r.sessionId})`);
}

// --- Tests ---

async function run() {
  console.log('1. Basic conversation (Agent SDK)');
  await test('responds to greeting', async () => {
    const r = await say('ahoj, řekni jedním slovem jaký jsi model');
    notEmpty(r);
    assert(r.projectName === '_global', `Expected _global, got ${r.projectName}`);
    console.log(`\n    "${r.text.slice(0, 100)}"`);
  });

  await test('remembers context (multi-turn)', async () => {
    const r = await say('co jsem se tě právě zeptal?');
    notEmpty(r);
    includes(r.text, 'model');
    console.log(`\n    "${r.text.slice(0, 100)}"`);
  });

  console.log('\n2. Navigation tools');
  await test('lists projects', async () => {
    const r = await say('jaké mám projekty? stručně');
    notEmpty(r);
    includes(r.text, 'projekt');
    console.log(`\n    "${r.text.slice(0, 120)}"`);
  });

  console.log('\n3. Project switch to test-gpt (GPT-4o)');
  await test('initiates switch', async () => {
    const r = await say('přepni mě do projektu test-gpt, otevři nový chat, nic se neptej prostě to udělej');
    console.log(`\n    "${r.text.slice(0, 120)}" [project=${r.projectName}]`);
    // May need confirmation
    if (r.projectName !== 'test-gpt') {
      const r2 = await say('ano, přepni');
      console.log(`    "${r2.text.slice(0, 120)}" [project=${r2.projectName}]`);
    }
  });

  await test('now in test-gpt', async () => {
    const r = await say('v jakém jsem projektu?');
    console.log(`\n    "${r.text.slice(0, 120)}" [project=${r.projectName}]`);
    assert(r.projectName === 'test-gpt', `Expected test-gpt, got ${r.projectName}`);
  });

  console.log('\n4. GPT-4o backend');
  await test('GPT-4o responds', async () => {
    const r = await say('jaký jsi model? jednou větou');
    notEmpty(r);
    console.log(`\n    "${r.text.slice(0, 120)}"`);
  });

  await test('GPT-4o declines internet', async () => {
    const r = await say('jaké je počasí v Praze?');
    notEmpty(r);
    const text = r.text.toLowerCase();
    assert(
      text.includes('nemám') || text.includes('nemoh') || text.includes('přístup') || text.includes('internet') || text.includes('nedokáž'),
      'Should decline internet, got: ' + r.text.slice(0, 100)
    );
    console.log(`\n    "${r.text.slice(0, 120)}"`);
  });

  console.log('\n5. Navigate back home');
  await test('switches to _global', async () => {
    const r = await say('vrať se domů, nic se neptej');
    console.log(`\n    "${r.text.slice(0, 120)}" [project=${r.projectName}]`);
    if (r.projectName !== '_global') {
      const r2 = await say('ano');
      console.log(`    "${r2.text.slice(0, 120)}" [project=${r2.projectName}]`);
    }
  });

  console.log('\n6. Agent SDK tools (back in _global)');
  await test('can run bash', async () => {
    const r = await say('spusť příkaz: echo pipeline-test-ok');
    notEmpty(r);
    const text = r.text.toLowerCase();
    assert(text.includes('pipeline') && text.includes('test') && text.includes('ok'),
      'Expected pipeline/test/ok in: ' + r.text.slice(0, 120));
    console.log(`\n    "${r.text.slice(0, 120)}"`);
  });

  // Summary
  console.log(`\n${'━'.repeat(40)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('━'.repeat(40));
}

async function main() {
  const arg = process.argv[2];
  if (arg) {
    const r = await say(arg);
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }

  console.log('🧪 Voice Pipeline Integration Test\n');
  console.log(`   Base: ${BASE}\n`);
  await run();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
