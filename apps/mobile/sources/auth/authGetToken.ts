import { authChallenge } from "./authChallenge";
import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { getHappyClientId } from "@/sync/apiSocket";

export async function authGetToken(secret: Uint8Array, serverUrl: string = getServerUrl()) {
    const { challenge, signature, publicKey } = authChallenge(secret);
    const response = await axios.post(`${serverUrl}/v1/auth`, { challenge: encodeBase64(challenge), signature: encodeBase64(signature), publicKey: encodeBase64(publicKey) }, {
        headers: {
            'X-Happy-Client': getHappyClientId(),
        }, timeout: 15000,
    });
    const data = response.data;
    if (data?.success !== true || typeof data.token !== 'string' || !data.token.trim()) throw new Error('The selected server did not return a valid authentication token.');
    return data.token as string;
}
