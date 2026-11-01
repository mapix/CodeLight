import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { channelList, type PeerChannel } from '@slopus/happy-wire/codelight';
import { apiSocket } from './apiSocket';
import { commitPeerServerUrl } from './serverConfig';
import { peerAuthorization, decodePeerResponse } from './peerNetwork';
import { abortBudget } from './abortBudget';

export type ConnectionSnapshot = { peerId:string|null; channels:Array<PeerChannel & {state:'connected'|'available'|'probing'|'failed';latencyMs?:number}>; selectedId:string|null;automatic:boolean;connecting:boolean };
let snapshot: ConnectionSnapshot = { peerId:null, channels:[], selectedId:null, automatic:true, connecting:false };
let credentials: AuthCredentials | null = null, generation = 0;
let probing: AbortController | null = null, releaseStatus: (()=>void)|null = null;
let committing = false;
const listeners = new Set<()=>void>();
export function getConnectionSnapshot() { return snapshot; }
export function subscribeConnection(listener:()=>void) { listeners.add(listener); return ()=>{listeners.delete(listener);}; }
function publish(value:ConnectionSnapshot) { snapshot=value; for(const listener of listeners)listener(); }

export function initializeCodeLightConnection(value:AuthCredentials) {
    if (!value.peer) { credentials=null;releaseStatus?.();releaseStatus=null; publish({peerId:null,channels:[],selectedId:null,automatic:true,connecting:false});return; }
    credentials=value;
    const selected=value.peer.channels.find(channel=>channel.url===value.serverUrl)?.id??value.peer.selectedChannel??null;
    publish({peerId:value.peer.id,channels:value.peer.channels.map(channel=>({...channel,state:channel.id===selected&&apiSocket.peerConnected()?'connected':'available'})),selectedId:selected,automatic:value.peer.automatic!==false,connecting:false});
    releaseStatus?.();
    releaseStatus=apiSocket.onStatusChange(status=>{
        if (!credentials?.peer || snapshot.connecting) return;
        if(status==='connected')publish({...snapshot,channels:snapshot.channels.map(channel=>({...channel,state:channel.id===snapshot.selectedId?'connected':channel.state}))});
        else publish({...snapshot,channels:snapshot.channels.map(channel=>channel.id===snapshot.selectedId?{...channel,state:status==='connecting'?'probing':apiSocket.peerCanReconnect()?'failed':'available'}:channel)});
        // 冷启动用过期地址只会 connect_error，不会先 disconnect；恢复也必须覆盖这个入口。
        if((status==='disconnected'||status==='error')&&snapshot.automatic&&apiSocket.peerCanReconnect())void selectConnection('auto').catch(()=>{});
    });
}

async function prove(channel:PeerChannel,value:AuthCredentials,signal:AbortSignal) {
    const peer=value.peer!;const url=channel.url+'/api/peer/channels',start=Date.now();
    const deadline=abortBudget(signal,channel.kind==='local'?2500:7000);
    try {
    const response=await fetch(url,{headers:{Authorization:peerAuthorization(value.token,peer,channel.url,'GET',url)},signal:deadline.signal});
    if(!response.ok)throw Error('The channel could not reach this Mac');
    const data=decodePeerResponse(peer,await response.json()) as {channels:unknown};
    const channels=channelList(data.channels);
    if(!channels.some(current=>current.url===channel.url))throw Error('The Mac has disabled this channel');
    return {channel,channels,latencyMs:Date.now()-start};
    } finally { deadline.dispose(); }
}

export async function selectConnection(id:string) {
    if(committing)throw Error('The connection choice is being saved');
    const value=credentials;if(!value?.peer)throw Error('Scan your Mac to get connection channels');
    const sequence=++generation;probing?.abort();const abort=new AbortController();probing=abort;
    const automatic=id==='auto',candidates=automatic?value.peer.channels:value.peer.channels.filter(channel=>channel.id===id);
    if(!candidates.length)throw Error('This channel is unavailable');
    publish({...snapshot,connecting:true,channels:snapshot.channels.map(channel=>candidates.some(candidate=>candidate.id===channel.id)?{...channel,state:'probing'}:channel)});
    try {
        const first=automatic?await Promise.any(candidates.map(channel=>prove(channel,value,abort.signal))):await prove(candidates[0],value,abort.signal);
        // HTTP 能认证 Mac，却不能证明实时链路可用。保留其最新列表，失败后验证重启后的 LAN 等候选。
        const refreshed={...value,peer:{...value.peer,channels:first.channels}};
        const remaining=automatic?first.channels.filter(channel=>channel.url!==first.channel.url).sort((a,b)=>Number(b.kind==='local')-Number(a.kind==='local')):[];
        for(let attempt=0;attempt<=remaining.length;attempt++){
            if(sequence!==generation||credentials!==value)throw Error('A newer channel selection replaced this one');
            try{
                const result=attempt===0?first:await prove(remaining[attempt-1],refreshed,abort.signal);
                committing=true;
                const peer={...value.peer,channels:result.channels,selectedChannel:result.channel.id,automatic};
                const updated={...value,serverUrl:result.channel.url,peer};
                if(!await TokenStorage.setCredentials(updated))throw Error('The connection choice could not be saved');
                commitPeerServerUrl(result.channel.url);
                await apiSocket.switchPeerChannel(result.channel.url,peer);
                if(sequence!==generation)throw Error('A newer channel selection replaced this one');
                credentials=updated;
                publish({peerId:peer.id,selectedId:result.channel.id,automatic,connecting:false,channels:peer.channels.map(channel=>({...channel,state:channel.id===result.channel.id?'connected':'available',...(channel.id===result.channel.id?{latencyMs:result.latencyMs}:{})}))});
                return;
            }catch(error){
                if(sequence!==generation||abort.signal.aborted||attempt===remaining.length)throw error;
            }
        }
    } catch(error) {
        if(committing&&credentials===value&&value.serverUrl&&value.peer){
            await TokenStorage.setCredentials(value);commitPeerServerUrl(value.serverUrl);
            await apiSocket.switchPeerChannel(value.serverUrl,value.peer).catch(()=>{});
        }
        if(sequence===generation)publish({...snapshot,connecting:false,channels:snapshot.channels.map(channel=>channel.state==='probing'?{...channel,state:channel.id===snapshot.selectedId&&apiSocket.peerConnected()?'connected':'failed'}:channel)});
        throw error;
    } finally { abort.abort();committing=false;if(probing===abort)probing=null; }
}
