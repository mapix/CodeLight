import nacl from'tweetnacl';
import{expect,it,vi}from'vitest';
vi.mock('expo-crypto', () => {
 let nonce = 0;
 return { getRandomBytes: vi.fn((count: number) => new Uint8Array(count).fill(++nonce)) };
});
import{peerAuthorization,decodePeerResponse}from'./peerNetwork';
import{decodeBase64,encodeBase64}from'@/encryption/base64';
it('cold peer authentication does not depend on a pairing provider installing TweetNaCl PRNG', () => {
 const mac=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)),phone=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
 const peer={id:'cold-peer',key:encodeBase64(mac.publicKey,'base64url'),channels:[{id:'local',kind:'local' as const,url:'http://192.168.1.2:8800'}],device:{publicKey:encodeBase64(phone.publicKey,'base64url'),secretKey:encodeBase64(phone.secretKey,'base64url')}};
 const unavailable=vi.spyOn(nacl,'randomBytes').mockImplementation(()=>{throw Error('no PRNG');});
 try {
  const header=peerAuthorization('fixture-token',peer,peer.channels[0].url,'GET',peer.channels[0].url+'/v1/updates');
  const packet=JSON.parse(new TextDecoder().decode(decodeBase64(header.slice(10),'base64url')));
  expect(nacl.box.open(decodeBase64(packet.ciphertext,'base64url'),decodeBase64(packet.nonce,'base64url'),phone.publicKey,mac.secretKey)).not.toBeNull();
  expect(unavailable).not.toHaveBeenCalled();
 } finally { unavailable.mockRestore(); }
});
it('authorization seals reusable tokens to the pinned Mac and changes nonce for reconnects',()=>{
 const mac=nacl.box.keyPair(),phone=nacl.box.keyPair();const peer={id:'fixture-peer',key:encodeBase64(mac.publicKey,'base64url'),channels:[{id:'local',kind:'local' as const,url:'http://192.168.1.2:8800'}],device:{publicKey:encodeBase64(phone.publicKey,'base64url'),secretKey:encodeBase64(phone.secretKey,'base64url')}};
 const header=peerAuthorization('synthetic-secret-token',peer,peer.channels[0].url,'GET',peer.channels[0].url+'/v1/updates');
 expect(header).not.toContain('synthetic-secret-token');expect(peerAuthorization('synthetic-secret-token',peer,peer.channels[0].url,'GET',peer.channels[0].url+'/v1/updates')).not.toBe(header);
 const packet=JSON.parse(new TextDecoder().decode(decodeBase64(header.slice(10),'base64url')));
 const plain=nacl.box.open(decodeBase64(packet.ciphertext,'base64url'),decodeBase64(packet.nonce,'base64url'),phone.publicKey,mac.secretKey)!;
 expect(JSON.parse(new TextDecoder().decode(plain))).toMatchObject({token:'synthetic-secret-token',path:'/v1/updates',method:'GET'});
 const nonce=nacl.randomBytes(24),cipher=nacl.box(new TextEncoder().encode(JSON.stringify({peerId:peer.id,payload:{ok:true}})),nonce,phone.publicKey,mac.secretKey);
 expect(decodePeerResponse(peer,{version:2,nonce:encodeBase64(nonce,'base64url'),ciphertext:encodeBase64(cipher,'base64url')})).toEqual({ok:true});
 expect(()=>peerAuthorization('token',peer,'https://foreign.example','GET','https://foreign.example')).toThrow();
});
