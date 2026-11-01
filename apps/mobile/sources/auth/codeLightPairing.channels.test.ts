import { expect, it, vi } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { CodeLightPairingController, parseCodeLightPairingCode } from './codeLightPairing';
const channels=[{id:'local',kind:'local',url:'http://192.168.1.2:8800'},{id:'relay',kind:'relay',url:'https://relay.example'}];
const key='a'.repeat(43),secret='b'.repeat(43);
function qr(){const url=new URL('codelight://pair');for(const[k,v]of Object.entries({v:'2',origin:channels[1].url,key,invite:'c'.repeat(43),expires:String(Date.now()+60000),channels:encodeBase64(new TextEncoder().encode(JSON.stringify(channels)),'base64url')}))url.searchParams.set(k,v);return url.toString();}
it('one scan authenticates the fastest available channel and saves one peer with all routes',async()=>{
 const save=vi.fn(),select=vi.fn(),reload=vi.fn();
 const controller=new CodeLightPairingController({load:async()=>null,save:async()=>{},clear:async()=>{},generateKey:()=>({publicKey:'d'.repeat(43),secretKey:'e'.repeat(43)}),encrypt:()=>({publicKey:'packet',nonce:'nonce',ciphertext:'sealed'}),
 exchange:async origin=>{if(origin.startsWith('https:'))await new Promise(r=>setTimeout(r,25));return{};},
 decrypt:()=>({version:2,origin:channels[1].url,macKey:key,credentials:{token:'fixture',secret,serverUrl:channels[1].url},peer:{id:'f'.repeat(64),key,channels}}),
 currentOrigin:()=>channels[1].url,selectOrigin:select,credentials:()=>null,saveCredentials:save,login:async()=>{},reload,validatePeer:async()=>true});
 expect(parseCodeLightPairingCode(qr()).channels).toHaveLength(2);await controller.connect(qr());
 expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][0]).toMatchObject({serverUrl:channels[0].url,peer:{selectedChannel:'local',automatic:true,channels}});expect(select).toHaveBeenCalledWith(channels[0].url);expect(reload).toHaveBeenCalledTimes(1);
});
it('a response for another Mac cannot save credentials or switch the active origin',async()=>{
 const save=vi.fn(),select=vi.fn();const controller=new CodeLightPairingController({load:async()=>null,save:async()=>{},clear:async()=>{},generateKey:()=>({publicKey:'d'.repeat(43),secretKey:'e'.repeat(43)}),encrypt:()=>({publicKey:'packet',nonce:'nonce',ciphertext:'sealed'}),exchange:async()=>({}),
 decrypt:()=>({version:2,origin:channels[1].url,macKey:'x'.repeat(43),credentials:{token:'fixture',secret,serverUrl:channels[1].url},peer:{id:'f'.repeat(64),key:'x'.repeat(43),channels}}),currentOrigin:()=>channels[1].url,selectOrigin:select,credentials:()=>null,saveCredentials:save,login:async()=>{},reload:async()=>{},validatePeer:async()=>true});
 await expect(controller.connect(qr())).rejects.toThrow();expect(save).not.toHaveBeenCalled();expect(select).not.toHaveBeenCalled();
});
