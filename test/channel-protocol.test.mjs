import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { channelList, channelOrigin, channelPath } from '../packages/wire/codelight.js';
import { DeviceProofVerifier } from '../src/network/device-proof.mjs';
import { PairingInvitations } from '../src/happy/pairing-gateway.mjs';

test('channel sets are bounded, unique and retain private/public transport boundaries', () => {
  assert.equal(channelOrigin('http://192.168.1.2:8800/', 'local'), 'http://192.168.1.2:8800');
  assert.equal(channelPath('https://relay.example/r/' + 'a'.repeat(24), 'https://relay.example/r/' + 'a'.repeat(24) + '/v1/updates?EIO=4'), '/v1/updates');
  for (const url of ['http://public.example', 'https://user:key@example.com', 'https://example.com?key=x', 'https://example.com/other']) assert.throws(() => channelOrigin(url, 'relay'));
  assert.throws(() => channelList([{ id: 'a', kind: 'local', url: 'http://192.168.1.2' }, { id: 'b', kind: 'local', url: 'http://192.168.1.2/' }]));
  assert.throws(() => channelPath('https://relay.example/r/' + 'a'.repeat(24), 'https://relay.example/r/' + 'b'.repeat(24) + '/v1/updates'));
});

test('device proofs hide bearer tokens, bind approved key/path/time, and cannot be replayed', () => {
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair(), publicKey = Buffer.from(phone.publicKey).toString('base64url');
  const origin = 'http://192.168.1.2:8800', token = 'synthetic-private-device-token', now = 1000000;
  let revoked = false;
  const verifier = new DeviceProofVerifier({ key: mac.secretKey, devices: { authorize: value => value === token && !revoked ? createHash('sha256').update(publicKey).digest('hex').slice(0, 24) : null }, origins: () => [origin], now: () => now });
  const proof = (changes = {}) => {
    const nonce = randomBytes(24), payload = { version: 2, token, origin, method: 'GET', path: '/v1/updates', at: now, ...changes };
    return 'CodeLight ' + Buffer.from(JSON.stringify({ publicKey, nonce: nonce.toString('base64url'), ciphertext: Buffer.from(nacl.box(Buffer.from(JSON.stringify(payload)), nonce, mac.publicKey, phone.secretKey)).toString('base64url') })).toString('base64url');
  };
  const header = proof(); assert.equal(header.includes(token), false);
  assert.equal(verifier.authorize(header, 'GET', '/v1/updates?EIO=4')?.token, token);
  assert.equal(verifier.authorize(header, 'GET', '/v1/updates?EIO=4'), null);
  assert.equal(verifier.authorize(proof(), 'POST', '/v1/updates'), null);
  assert.equal(verifier.authorize(proof({ at: 1 }), 'GET', '/v1/updates'), null);
  assert.equal(verifier.authorize(proof({ origin: 'http://192.168.1.3' }), 'GET', '/v1/updates'), null);
  revoked = true; assert.equal(verifier.authorize(proof(), 'GET', '/v1/updates'), null);
});
test('one v2 invitation carries all channels and same-device exchange keeps one encrypted identity', async () => {
 const mac=nacl.box.keyPair(),phone=nacl.box.keyPair(),secret=randomBytes(32).toString('base64url');
 const choices=[{id:'local',kind:'local',url:'http://192.168.1.2:8800'},{id:'relay',kind:'relay',url:'https://relay.example'}];
 const invites=new PairingInvitations({key:mac.secretKey,credentials:{token:'synthetic-token',secret}});
 try{const code=new URL(invites.issue(choices[1].url,choices).url);assert.equal(code.searchParams.get('v'),'2');
 /** @param {string} origin */
 const packet=origin=>{const nonce=randomBytes(24);return{publicKey:Buffer.from(phone.publicKey).toString('base64url'),nonce:nonce.toString('base64url'),ciphertext:Buffer.from(nacl.box(Buffer.from(JSON.stringify({version:2,invite:code.searchParams.get('invite'),origin})),nonce,mac.publicKey,phone.secretKey)).toString('base64url')};};
 const first=await invites.exchangeEncrypted(packet(choices[0].url)),second=await invites.exchangeEncrypted(packet(choices[1].url));assert.deepEqual(second,first);
 const plain=nacl.box.open(Buffer.from(first.ciphertext,'base64url'),Buffer.from(first.nonce,'base64url'),mac.publicKey,phone.secretKey);assert.ok(plain);
 const data=JSON.parse(Buffer.from(plain).toString());assert.deepEqual(data.peer.channels,choices);
 await assert.rejects(async()=>invites.exchangeEncrypted(packet('https://foreign.example')));
 }finally{invites.close();}
});
