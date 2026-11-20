/**
 * Smoke test for z-ai-web-dev-sdk.
 * This script ONLY runs if the SDK is installed. It's optional.
 * Run: cd chismoso && npx tsx scripts/smoke.ts
 */

async function smoke() {
  let ZAI: any;
  try {
    const mod = await import('z-ai-web-dev-sdk');
    ZAI = mod.default;
  } catch {
    console.error('[SKIP] z-ai-web-dev-sdk not installed. This smoke test requires it.');
    console.error('       The motor works without it via external providers (Serper/Groq/etc).');
    process.exit(0);
  }

  console.log('[1/3] Creating ZAI instance...');
  const zai = await ZAI.create();

  console.log('[2/3] web_search...');
  const t0 = Date.now();
  const results = await zai.functions.invoke('web_search', {
    query: 'restaurant WhatsApp reservations automation Colombia 2024',
    num: 5,
  });
  console.log(`  -> got ${Array.isArray(results) ? results.length : 'non-array'} results in ${Date.now() - t0}ms`);
  if (Array.isArray(results) && results.length > 0) {
    console.log('  sample:', { name: results[0].name, host: results[0].host_name });
  }

  console.log('[3/3] chat.completions...');
  const t1 = Date.now();
  const completion = await zai.chat.completions.create({
    messages: [
      { role: 'system', content: 'Respond in one short sentence.' },
      { role: 'user', content: 'Say "CHISMOSO ready".' },
    ],
    thinking: { type: 'disabled' },
  });
  console.log(`  -> completion in ${Date.now() - t1}ms`);
  console.log('  response:', completion.choices?.[0]?.message?.content);
}

smoke().catch((e) => {
  console.error('SMOKE TEST FAILED:', e);
  process.exit(1);
});
