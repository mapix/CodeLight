import React, { useEffect, useMemo } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCodeLightPairing } from '@/auth/CodeLightPairingProvider';
import { CodeLightScanScreen } from '@/components/onboarding/CodeLightScanScreen';

export default function PairMac() {
    const params = useLocalSearchParams(), pairing = useCodeLightPairing(), router = useRouter();
    const raw = JSON.stringify(params);
    const url = useMemo(() => {
        const parsed = JSON.parse(raw), value = new URL('codelight://pair');
        for (const [key, input] of Object.entries(parsed)) {
            if (typeof input === 'string') value.searchParams.append(key, input);
            else if (Array.isArray(input)) for (const item of input) value.searchParams.append(key, String(item));
        }
        return value.toString();
    }, [raw]);
    useEffect(() => { void pairing.connect(url).then(() => router.replace('/')).catch(() => {}); }, [pairing.connect, router, url]);
    return <CodeLightScanScreen />;
}
