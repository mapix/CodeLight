import { SettingsView } from "@/components/SettingsView";
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Platform } from 'react-native';
import { config } from '@/config';
import { CodeLightSettings } from '@/components/CodeLightSettings';

export default function SettingsScreen() {
    if (config.noninvasiveLocal) return <CodeLightSettings />;
    return (
        <SettingsView
            topContentInset={Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0}
        />
    );
}
