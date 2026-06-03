#!/usr/bin/env node
/**
 * zoom-panelist-test.mjs — local verification harness for the Zoom
 * webinar-panelist API, ahead of wiring it into the app.
 *
 * It exercises src/services/ZoomApiClient.js against a REAL (scratch)
 * webinar so we can confirm, before building any UI/DB:
 *   1. The S2S creds mint a token            (account_id + client_id + secret)
 *   2. The app has webinar:read:admin scope  (list panelists)
 *   3. The account has the Webinar add-on    (else 403)
 *   4. add-then-list returns a usable join_url (the documented quirk)
 *
 * SETUP (one-time, on the account that will host the test webinar):
 *   - Zoom Marketplace → Build App → Server-to-Server OAuth
 *   - Add scopes: webinar:read:admin  AND  webinar:write:admin
 *   - Ensure that account has the Zoom Webinar add-on
 *   - Create a throwaway Webinar; copy its numeric ID (the /w/<ID> part)
 *   - Put the app's creds in your environment (or .env at repo root):
 *       ZOOM_ACCOUNT_ID=...
 *       ZOOM_CLIENT_ID=...
 *       ZOOM_CLIENT_SECRET=...
 *     (If your existing .env ZOOM_CLIENT_ID/SECRET are a DIFFERENT app,
 *      override them just for this test — these must be the S2S app.)
 *
 * USAGE:
 *   node scripts/zoom-panelist-test.mjs --token-only
 *   node scripts/zoom-panelist-test.mjs <webinarId>
 *   node scripts/zoom-panelist-test.mjs <webinarId> --add "Support Bot" rytepro1+zoomtest@gmail.com
 *   node scripts/zoom-panelist-test.mjs <webinarId> --remove <panelistId>
 *
 * Read-only by default (token mint + list). Nothing mutates unless you
 * pass --add or --remove. This script makes NO changes to the app and is
 * never imported by the server.
 */

import dotenv from 'dotenv';
import { ZoomApiClient, ZoomApiError } from '../src/services/ZoomApiClient.js';

dotenv.config();

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valAfter = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const positional = argv.filter((a) => !a.startsWith('--'));
// positionals after consuming flag-values: drop values that follow flags
const flagValues = new Set();
for (const f of ['--add', '--remove']) {
  const i = argv.indexOf(f);
  if (i >= 0) {
    // --add takes two values (name, email); --remove takes one (id)
    if (f === '--add') { flagValues.add(argv[i + 1]); flagValues.add(argv[i + 2]); }
    else flagValues.add(argv[i + 1]);
  }
}
const webinarId = positional.find((p) => !flagValues.has(p)) || null;

const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-3)} (len ${s.length})` : '(unset)');

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;

console.log('\n=== Zoom panelist API test ===');
console.log(`account_id:    ${mask(ZOOM_ACCOUNT_ID)}`);
console.log(`client_id:     ${mask(ZOOM_CLIENT_ID)}`);
console.log(`client_secret: ${ZOOM_CLIENT_SECRET ? '(set)' : '(unset)'}`);

if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
  die('Missing ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET. See SETUP at the top of this file.');
}

const client = new ZoomApiClient({
  accountId: ZOOM_ACCOUNT_ID,
  clientId: ZOOM_CLIENT_ID,
  clientSecret: ZOOM_CLIENT_SECRET,
});

async function main() {
  // 1. Token mint — proves account/client creds.
  process.stdout.write('\n[1] Minting S2S token … ');
  await client.getAccessToken();
  console.log('✓ token minted');

  if (has('--token-only')) {
    console.log('\n--token-only: stopping after token mint. Creds are valid.\n');
    return;
  }

  if (!webinarId) {
    die('No <webinarId> given. Pass a scratch webinar ID, or use --token-only.');
  }

  // 2. List panelists — proves webinar:read:admin scope + Webinar add-on.
  process.stdout.write(`[2] GET panelists for webinar ${webinarId} … `);
  let panelists = await client.listPanelists(webinarId);
  console.log(`✓ ${panelists.length} panelist(s)`);
  printPanelists(panelists);

  // 3. Optional mutations.
  const removeId = valAfter('--remove');
  if (removeId) {
    process.stdout.write(`[3] DELETE panelist ${removeId} … `);
    await client.removePanelist(webinarId, removeId);
    console.log('✓ removed');
    panelists = await client.listPanelists(webinarId);
    printPanelists(panelists);
  }

  if (has('--add')) {
    const i = argv.indexOf('--add');
    const name = argv[i + 1];
    const email = argv[i + 2];
    if (!name || !email || name.startsWith('--') || email.startsWith('--')) {
      die('--add requires: --add "Display Name" email@domain');
    }
    process.stdout.write(`[3] Ensuring panelist ${email} … `);
    const { join_url, panelistId, added } = await client.ensurePanelistJoinUrl(webinarId, { name, email });
    console.log(added ? `✓ added (id ${panelistId})` : `✓ already present (id ${panelistId})`);
    console.log('\n────────────────────────────────────────');
    console.log('JOIN URL (this is what we feed the Recall bot):');
    console.log(join_url);
    console.log('────────────────────────────────────────');
  }

  console.log('\n✓ Done.\n');
}

function printPanelists(panelists) {
  if (panelists.length === 0) {
    console.log('    (none)');
    return;
  }
  for (const p of panelists) {
    console.log(`    • ${p.name || '(no name)'}  <${p.email || '?'}>  id=${p.id}`);
    console.log(`      join_url: ${p.join_url ? p.join_url.slice(0, 72) + '…' : '(none)'}`);
  }
}

main().catch((err) => {
  if (err instanceof ZoomApiError) {
    console.error(`\n✖ ZoomApiError: ${err.message}`);
    if (err.retryAfter) console.error(`  Retry-After: ${err.retryAfter}s`);
  } else {
    console.error(`\n✖ ${err.stack || err.message}`);
  }
  process.exit(1);
});
